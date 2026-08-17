import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  restoreWorkspace,
  type RestoreDeps,
  type RestoreExecution,
  type RestoreOutcome,
} from "../application/restore.ts";
import {
  workspaceMutationLeaseState,
  type WorkspaceMutationLease,
} from "../application/mutation-lease.ts";
import type { ResolvedNodeState } from "../application/resolve.ts";
import type { NodeKey } from "../domain/model.ts";
import type { WorkspaceSnapshot } from "../infrastructure/workspace-scan.ts";
import type { WorkspaceWriteAuthority } from "../infrastructure/workspace-lock.ts";
import type { ArrivalAttempt } from "./checkpoint-admission.ts";
import {
  unsettledArrival,
  type ArrivalDisposition,
} from "./arrival-settlement.ts";
import {
  protectCurrentArrivalInWorkspaceLock,
  postMutationControlFailure,
  postMutationControlFailureExecution,
  postMutationStateConflict,
  type ArrivalRecovery,
  type PostMutationConflictExecution,
} from "./post-mutation.ts";
import {
  isExactUsableSessionView,
  readSessionView,
  type SessionView,
} from "./session-view.ts";
import type { LockedArrivalOutcome } from "./workspace-receipt.ts";

const SETTLED_PREPARATION_CLEANUP = { kind: "settled" } as const;

/** A restore outcome together with the exact first-write fact that produced it. */
export interface RestoreProtocolOutcome {
  readonly kind: "outcome";
  readonly outcome: RestoreOutcome;
  readonly cutover: RestoreExecution["cutover"];
  readonly preparationCleanup: RestoreExecution["preparationCleanup"];
}

export type WorkspaceMutationProtocolExecution =
  | { readonly kind: "target-changed" }
  | RestoreProtocolOutcome
  | PostMutationConflictExecution;

export type WorkspaceMutationProtocolActionResult =
  | Exclude<WorkspaceMutationProtocolExecution, PostMutationConflictExecution>
  | LockedArrivalOutcome<WorkspaceMutationProtocolExecution>;

export interface LocationRestoreRequest {
  readonly expected: SessionView;
  readonly node: NodeKey;
  readonly resolution: ResolvedNodeState;
  readonly current: WorkspaceSnapshot;
}

export interface TreeArrivalRestoreRequest {
  readonly arrival: ArrivalAttempt;
  readonly expected: SessionView;
  readonly node: NodeKey;
  readonly resolution: ResolvedNodeState;
  readonly current: WorkspaceSnapshot;
}

type Reauthentication =
  | { readonly kind: "matches"; readonly view: SessionView }
  | { readonly kind: "location-changed" | "target-changed" };

interface RestoreSettlement {
  readonly prepareLease: () =>
    WorkspaceMutationLease<ResolvedNodeState> | undefined;
  readonly reauthenticate: (resolution: ResolvedNodeState) => Reauthentication;
  readonly admitAuthorized: (
    view: SessionView,
    resolution: ResolvedNodeState,
  ) => boolean;
  readonly admitNoOp: (
    view: SessionView,
    resolution: ResolvedNodeState,
  ) => boolean | ArrivalDisposition;
}

/** The protocol deliberately cannot reach Runtime's UI, queue, or lifecycle. */
export interface WorkspaceMutationProtocolAuthority extends ArrivalRecovery {
  restoreDependencies(): RestoreDeps;
  prepareLocationMutation(
    writeAuthority: WorkspaceWriteAuthority,
    context: ExtensionContext,
    expected: SessionView,
    node: NodeKey,
    resolution: ResolvedNodeState,
  ): WorkspaceMutationLease<ResolvedNodeState> | undefined;
  prepareTreeArrivalMutation(
    writeAuthority: WorkspaceWriteAuthority,
    context: ExtensionContext,
    attempt: ArrivalAttempt,
    expected: SessionView,
    node: NodeKey,
    resolution: ResolvedNodeState,
  ): WorkspaceMutationLease<ResolvedNodeState> | undefined;
  captureAnchor(view: SessionView): NodeKey | undefined;
  resolutionStillAuthoritative(
    view: SessionView,
    node: NodeKey,
    expected: ResolvedNodeState,
  ): boolean;
  admitLocationIfResolution(
    writeAuthority: WorkspaceWriteAuthority,
    view: SessionView,
    resolution: ResolvedNodeState,
  ): boolean;
  admitTreeArrivalIfResolution(
    writeAuthority: WorkspaceWriteAuthority,
    attempt: ArrivalAttempt,
    view: SessionView,
    resolution: ResolvedNodeState,
  ): ArrivalDisposition;
  protectCurrentTreeArrival(
    writeAuthority: WorkspaceWriteAuthority,
    attempt: ArrivalAttempt,
    view: SessionView,
  ): ArrivalDisposition;
  sessionIsUsable(view: SessionView): boolean;
}

/**
 * The two destructive restore entry points share one deliberately narrow
 * protocol: mint first-write authority, apply, reprove the public snapshot,
 * admit success, and durably settle every uncertain cutover. Preparation and
 * navigation planning remain outside this class.
 */
export class WorkspaceMutationProtocol {
  readonly #authority: WorkspaceMutationProtocolAuthority;
  readonly #context: ExtensionContext;
  readonly #readView: () => SessionView;

  constructor(
    authority: WorkspaceMutationProtocolAuthority,
    context: ExtensionContext,
    readView: () => SessionView = () => readSessionView(context),
  ) {
    this.#authority = authority;
    this.#context = context;
    this.#readView = readView;
  }

  async restoreLocation(
    request: LocationRestoreRequest,
    writeAuthority: WorkspaceWriteAuthority,
  ): Promise<WorkspaceMutationProtocolActionResult> {
    const { expected, node, resolution } = request;
    const result = await this.#restore(
      request.current,
      expected.cwd,
      resolution,
      writeAuthority,
      {
        prepareLease: () =>
          this.#authority.prepareLocationMutation(
            writeAuthority,
            this.#context,
            expected,
            node,
            resolution,
          ),
        reauthenticate: (pinned) => {
          let current: SessionView | undefined;
          try {
            current = this.#readExactView(expected);
          } catch {
            return { kind: "location-changed" };
          }
          if (current === undefined) return { kind: "location-changed" };
          const anchor = this.#authority.captureAnchor(current);
          if (
            anchor?.sessionId !== node.sessionId ||
            anchor.entryId !== node.entryId
          ) {
            return { kind: "location-changed" };
          }
          return this.#authority.resolutionStillAuthoritative(
            current,
            node,
            pinned,
          )
            ? { kind: "matches", view: current }
            : { kind: "target-changed" };
        },
        admitAuthorized: (view, pinned) =>
          this.#authority.admitLocationIfResolution(
            writeAuthority,
            view,
            pinned,
          ),
        admitNoOp: (view, target) =>
          this.#authority.admitLocationIfResolution(
            writeAuthority,
            view,
            target,
          ),
      },
    );
    if ("execution" in result) return result;
    return result.kind === "outcome" && result.outcome.kind === "restored"
      ? { execution: result, arrival: { kind: "admitted" } }
      : result;
  }

  async restoreTreeArrival(
    request: TreeArrivalRestoreRequest,
    writeAuthority: WorkspaceWriteAuthority,
  ): Promise<LockedArrivalOutcome<WorkspaceMutationProtocolExecution>> {
    const { arrival, expected, node, resolution } = request;
    let settledArrival: ArrivalDisposition | undefined;
    const result = await this.#restore(
      request.current,
      expected.cwd,
      resolution,
      writeAuthority,
      {
        prepareLease: () =>
          this.#authority.prepareTreeArrivalMutation(
            writeAuthority,
            this.#context,
            arrival,
            expected,
            node,
            resolution,
          ),
        reauthenticate: (pinned) => {
          let current: SessionView | undefined;
          try {
            current = this.#readExactView(expected);
          } catch {
            return { kind: "location-changed" };
          }
          if (current === undefined) return { kind: "location-changed" };
          const anchor = this.#authority.captureAnchor(current);
          if (
            anchor?.sessionId !== node.sessionId ||
            anchor.entryId !== node.entryId
          ) {
            return { kind: "location-changed" };
          }
          return this.#authority.resolutionStillAuthoritative(
            current,
            anchor,
            pinned,
          )
            ? { kind: "matches", view: current }
            : { kind: "target-changed" };
        },
        // A successful first-write cutover consumed the arrival token. Reopen
        // ordinary capture authority only after the restored target is reproved.
        admitAuthorized: (view, pinned) => {
          const admitted = this.#authority.admitLocationIfResolution(
            writeAuthority,
            view,
            pinned,
          );
          if (admitted) settledArrival = { kind: "admitted" };
          return admitted;
        },
        // A no-op never consumed that token, so it must be settled as an arrival.
        admitNoOp: (view, target) => {
          const disposition = this.#authority.admitTreeArrivalIfResolution(
            writeAuthority,
            arrival,
            view,
            target,
          );
          settledArrival = disposition;
          return disposition;
        },
      },
    );
    if ("execution" in result) {
      return result;
    }
    if (settledArrival !== undefined) {
      return {
        execution: result,
        arrival: settledArrival,
      };
    }
    let current: SessionView | undefined;
    try {
      current = this.#readExactView(expected);
    } catch {
      // The general recovery below does not rely on the arrival token.
    }
    let tokenProtectionFailure: unknown;
    if (current !== undefined) {
      const protectedArrival = this.#authority.protectCurrentTreeArrival(
        writeAuthority,
        arrival,
        current,
      );
      if (protectedArrival.kind !== "unsettled") {
        return {
          execution: result,
          arrival: protectedArrival,
        };
      }
      tokenProtectionFailure = protectedArrival.cause;
    }
    const recovery = await protectCurrentArrivalInWorkspaceLock(
      this.#authority,
      writeAuthority,
      this.#context,
    );
    return {
      execution: result,
      arrival:
        tokenProtectionFailure !== undefined && recovery.kind === "unsettled"
          ? unsettledArrival("arrival protection attempts both failed", [
              tokenProtectionFailure,
              recovery.cause,
            ])
          : recovery,
    };
  }

  recoveryExecutionAfterCleanupFailure(
    execution: WorkspaceMutationProtocolExecution,
    cause: unknown,
  ): WorkspaceMutationProtocolExecution | undefined {
    return execution.kind === "outcome" &&
      execution.cutover.kind === "authorized"
      ? postMutationControlFailureExecution(
          cause,
          execution.outcome,
          execution.preparationCleanup,
        )
      : undefined;
  }

  async #restore(
    current: WorkspaceSnapshot,
    root: string,
    resolution: ResolvedNodeState,
    writeAuthority: WorkspaceWriteAuthority,
    settlement: RestoreSettlement,
  ): Promise<WorkspaceMutationProtocolActionResult> {
    const mutationLease = settlement.prepareLease();
    if (mutationLease === undefined) return { kind: "target-changed" };

    let execution: RestoreExecution | undefined;
    try {
      execution = await restoreWorkspace(
        this.#authority.restoreDependencies(),
        root,
        resolution,
        { current, mutationLease },
      );
      const result: RestoreProtocolOutcome = {
        kind: "outcome",
        outcome: execution.outcome,
        cutover: execution.cutover,
        preparationCleanup: execution.preparationCleanup,
      };
      // A rejected cutover is a settled proof that no workspace write crossed
      // the mutation gate. The authority callback may have durably pinned a
      // checkpoint before rejecting, but that fact is already authoritative;
      // it must not be widened into uncertain post-mutation protection.
      if (execution.cutover.kind === "rejected") return result;
      if (execution.outcome.kind !== "restored") {
        if (execution.cutover.kind === "not-requested") return result;
        const authenticated = settlement.reauthenticate(
          execution.cutover.pinnedResolution,
        );
        if (authenticated.kind === "matches") return result;
        return postMutationStateConflict(
          this.#authority,
          this.#context,
          authenticated.kind,
          execution.outcome,
          execution.preparationCleanup,
          { kind: "held", writeAuthority },
        );
      }

      const target =
        execution.cutover.kind === "authorized"
          ? execution.cutover.pinnedResolution
          : resolution;
      const authenticated = settlement.reauthenticate(target);
      if (authenticated.kind !== "matches") {
        return postMutationStateConflict(
          this.#authority,
          this.#context,
          execution.cutover.kind === "not-requested"
            ? "target-changed"
            : authenticated.kind,
          execution.outcome,
          execution.preparationCleanup,
          { kind: "held", writeAuthority },
        );
      }
      const admission =
        execution.cutover.kind === "authorized"
          ? settlement.admitAuthorized(authenticated.view, target)
          : settlement.admitNoOp(authenticated.view, target);
      const admitted =
        typeof admission === "boolean"
          ? admission
          : admission.kind === "admitted";
      if (!admitted) {
        if (execution.cutover.kind === "not-requested") {
          return { kind: "target-changed" };
        }
        return postMutationStateConflict(
          this.#authority,
          this.#context,
          "target-changed",
          execution.outcome,
          execution.preparationCleanup,
          { kind: "held", writeAuthority },
        );
      }
      return result;
    } catch (cause) {
      const cutover =
        execution?.cutover ?? workspaceMutationLeaseState(mutationLease);
      if (
        cutover.kind === "pending" ||
        cutover.kind === "not-requested" ||
        cutover.kind === "rejected"
      ) {
        throw cause;
      }
      return postMutationControlFailure(
        this.#authority,
        this.#context,
        cause,
        execution?.outcome,
        execution?.preparationCleanup ?? SETTLED_PREPARATION_CLEANUP,
        { kind: "held", writeAuthority },
      );
    }
  }

  #readExactView(expected: SessionView): SessionView | undefined {
    const current = this.#readView();
    return isExactUsableSessionView(current, expected, (candidate) =>
      this.#authority.sessionIsUsable(candidate),
    )
      ? current
      : undefined;
  }
}
