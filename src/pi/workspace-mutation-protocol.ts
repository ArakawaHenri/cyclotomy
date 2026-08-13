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
import type { ArrivalAttempt } from "./checkpoint-admission.ts";
import type { ArrivalDisposition } from "./arrival-settlement.ts";
import { dispositionFromArrivalProtection } from "./arrival-settlement.ts";
import {
  mergeCleanupSettlements,
  protectCurrentArrivalAfterWorkspaceFailure,
  protectCurrentArrivalInWorkspaceLock,
  postMutationControlFailure,
  postMutationStateConflict,
  type ArrivalRecovery,
  type CleanupSettlement,
  type PostMutationConflict,
} from "./post-mutation.ts";
import { readSessionView, type SessionView } from "./session-view.ts";

/** A restore outcome together with the exact first-write fact that produced it. */
export interface RestoreProtocolOutcome {
  readonly kind: "outcome";
  readonly outcome: RestoreOutcome;
  readonly cutover: RestoreExecution["cutover"];
  readonly stagingCleanup: RestoreExecution["stagingCleanup"];
  readonly workspaceLockCleanup: CleanupSettlement;
}

export type WorkspaceMutationProtocolResult =
  | { readonly kind: "target-changed" }
  | RestoreProtocolOutcome
  | PostMutationConflict;

export interface TreeRestoreProtocolResult {
  readonly execution: WorkspaceMutationProtocolResult;
  readonly arrival: ArrivalDisposition;
}

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
  readonly noOpConflict: "target-changed";
}

/** The protocol deliberately cannot reach Runtime's UI, queue, or lifecycle. */
export interface WorkspaceMutationProtocolAuthority extends ArrivalRecovery {
  restoreDependencies(): RestoreDeps;
  prepareLocationMutation(
    context: ExtensionContext,
    expected: SessionView,
    node: NodeKey,
    resolution: ResolvedNodeState,
  ): WorkspaceMutationLease<ResolvedNodeState> | undefined;
  prepareTreeArrivalMutation(
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
    view: SessionView,
    resolution: ResolvedNodeState,
  ): boolean;
  admitTreeArrivalIfResolution(
    attempt: ArrivalAttempt,
    view: SessionView,
    resolution: ResolvedNodeState,
  ): ArrivalDisposition;
  protectCurrentTreeArrival(
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

  restoreLocation(
    request: LocationRestoreRequest,
  ): Promise<WorkspaceMutationProtocolResult> {
    const { expected, node, resolution } = request;
    return this.#restore(request.current, expected.cwd, resolution, {
      prepareLease: () =>
        this.#authority.prepareLocationMutation(
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
        this.#authority.admitLocationIfResolution(view, pinned),
      admitNoOp: (view, target) =>
        this.#authority.admitLocationIfResolution(view, target),
      noOpConflict: "target-changed",
    });
  }

  async restoreTreeArrival(
    request: TreeArrivalRestoreRequest,
  ): Promise<TreeRestoreProtocolResult> {
    const { arrival, expected, node, resolution } = request;
    let settledArrival: ArrivalDisposition | undefined;
    const execution = await this.#restore(
      request.current,
      expected.cwd,
      resolution,
      {
        prepareLease: () =>
          this.#authority.prepareTreeArrivalMutation(
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
            view,
            pinned,
          );
          if (admitted) settledArrival = { kind: "admitted" };
          return admitted;
        },
        // A no-op never consumed that token, so it must be settled as an arrival.
        admitNoOp: (view, target) => {
          const disposition = this.#authority.admitTreeArrivalIfResolution(
            arrival,
            view,
            target,
          );
          settledArrival = disposition;
          return disposition;
        },
        noOpConflict: "target-changed",
      },
    );
    if (settledArrival !== undefined) {
      return { execution, arrival: settledArrival };
    }
    if (execution.kind === "post-mutation-conflict") {
      return {
        execution,
        arrival: dispositionFromArrivalProtection(execution.arrivalProtection),
      };
    }
    let current: SessionView | undefined;
    try {
      current = this.#readExactView(expected);
    } catch {
      // The general recovery below does not rely on the arrival token.
    }
    if (current !== undefined) {
      const protectedArrival = this.#authority.protectCurrentTreeArrival(
        arrival,
        current,
      );
      if (protectedArrival.kind !== "unsettled") {
        return { execution, arrival: protectedArrival };
      }
    }
    const recovery = await protectCurrentArrivalInWorkspaceLock(
      this.#authority,
      this.#context,
    );
    return {
      execution,
      arrival: dispositionFromArrivalProtection(recovery.protection),
    };
  }

  /**
   * Reconcile an explicit execution receipt with the independent workspace-lock
   * cleanup result. Preserve settled facts and recover only when an authorized
   * cutover means workspace mutation may have occurred.
   */
  recoverAfterWorkspaceFailure(
    cause: unknown,
    result: WorkspaceMutationProtocolResult | undefined,
    workspaceLockCleanup: CleanupSettlement,
  ): Promise<WorkspaceMutationProtocolResult | undefined> {
    if (result?.kind === "post-mutation-conflict") {
      return this.#preserveSettledConflict(result, cause, workspaceLockCleanup);
    }
    if (result?.kind !== "outcome" || result.cutover.kind !== "authorized") {
      return Promise.resolve(
        result?.kind === "outcome"
          ? {
              ...result,
              workspaceLockCleanup: mergeCleanupSettlements(
                result.workspaceLockCleanup,
                workspaceLockCleanup,
              ),
            }
          : undefined,
      );
    }
    return postMutationControlFailure(
      this.#authority,
      this.#context,
      cause,
      result.outcome,
      "released",
    ).then((conflict) => ({
      ...conflict,
      workspaceLockCleanup: mergeCleanupSettlements(
        conflict.workspaceLockCleanup,
        workspaceLockCleanup,
      ),
    }));
  }

  async #preserveSettledConflict(
    conflict: PostMutationConflict,
    secondaryFailure: unknown,
    workspaceLockCleanup: CleanupSettlement,
  ): Promise<PostMutationConflict> {
    if (conflict.arrivalProtection.kind !== "unavailable") {
      return {
        ...conflict,
        workspaceLockCleanup: mergeCleanupSettlements(
          conflict.workspaceLockCleanup,
          workspaceLockCleanup,
        ),
      };
    }
    const recovery = await protectCurrentArrivalAfterWorkspaceFailure(
      this.#authority,
      this.#context,
    );
    return {
      ...conflict,
      workspaceLockCleanup: mergeCleanupSettlements(
        conflict.workspaceLockCleanup,
        workspaceLockCleanup,
        recovery.workspaceLockCleanup,
      ),
      arrivalProtection:
        recovery.protection.kind === "unavailable"
          ? {
              kind: "unavailable",
              cause: new AggregateError(
                [
                  conflict.arrivalProtection.cause,
                  secondaryFailure,
                  recovery.protection.cause,
                ],
                "arrival settlement and workspace cleanup both failed",
                { cause: conflict.arrivalProtection.cause },
              ),
            }
          : recovery.protection,
    };
  }

  async #restore(
    current: WorkspaceSnapshot,
    root: string,
    resolution: ResolvedNodeState,
    settlement: RestoreSettlement,
  ): Promise<WorkspaceMutationProtocolResult> {
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
        stagingCleanup: execution.stagingCleanup,
        workspaceLockCleanup: { kind: "settled" },
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
          "held",
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
            ? settlement.noOpConflict
            : authenticated.kind,
          execution.outcome,
          "held",
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
          return { kind: settlement.noOpConflict };
        }
        return postMutationStateConflict(
          this.#authority,
          this.#context,
          "target-changed",
          execution.outcome,
          "held",
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
        "held",
      );
    }
  }

  #readExactView(expected: SessionView): SessionView | undefined {
    const current = this.#readView();
    return this.#authority.sessionIsUsable(current) &&
      current.isSameSnapshotAs(expected)
      ? current
      : undefined;
  }
}
