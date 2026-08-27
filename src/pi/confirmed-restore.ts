import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  planWorkspaceRestore,
  restorePlanHasChanges,
  workspaceSnapshotAsManifest,
  type WorkspaceRestorePlan,
} from "../infrastructure/restore-plan.ts";
import { prepareWorkspaceRestorePlan } from "../infrastructure/restore-preparation.ts";
import {
  gitReplayRisk,
  sameGitOracleVersion,
  type GitReplayRisk,
} from "../infrastructure/git-replay-risk.ts";
import type { ResolvedNodeState } from "../application/resolve.ts";
import type { CaptureFailure } from "../application/capture.ts";
import type { ResolvedReadableTree } from "../application/checkpoint-service.ts";
import type { NodeKey } from "../domain/model.ts";
import type { CleanupSettlement } from "../domain/cleanup-settlement.ts";
import type {
  ScanProblem,
  WorkspaceSnapshot,
} from "../infrastructure/workspace-scan.ts";
import {
  checkpointInitializationDispositionConflict,
  finalizeArrivalAfterWorkspaceExecution,
  isLockedArrivalOutcome,
  protectCurrentArrivalAfterWorkspaceFailure,
  restorePreparationConflict,
  type CheckpointInitializationConflictExecution,
  type PostMutationConflictExecution,
  type RestorePreparationConflict,
  type RestorePreparationConflictExecution,
} from "./post-mutation.ts";
import {
  locationInitializationAdmission,
  settleCheckpointInitialization,
} from "./checkpoint-initialization-protocol.ts";
import { requestRestoreChoice } from "./restore-choice.ts";
import { assertNever } from "./assert-never.ts";
import type { CyclotomyRuntime } from "./runtime.ts";
import {
  isExactUsableSessionView,
  readSessionView,
  type SessionView,
} from "./session-view.ts";
import {
  WorkspaceMutationProtocol,
  type RestoreProtocolOutcome,
  type WorkspaceMutationProtocolActionResult,
} from "./workspace-mutation-protocol.ts";
import {
  type ArrivalReceipt,
  type LockedArrivalOutcome,
  type WorkspaceReceipt,
} from "./workspace-receipt.ts";

type ConfirmedRestoreMode = "manual" | "loaded-session";

export type ConfirmedRestoreExecution =
  | PostMutationConflictExecution
  | CheckpointInitializationConflictExecution
  | RestorePreparationConflictExecution
  | { readonly kind: "missing" }
  | { readonly kind: "protected-missing" }
  | { readonly kind: "initialized" }
  | { readonly kind: "matches" }
  | { readonly kind: "needs-ui"; readonly replayRisk: GitReplayRisk }
  | { readonly kind: "cancelled" }
  | { readonly kind: "location-changed" }
  | { readonly kind: "target-changed" }
  | { readonly kind: "preview-stale" }
  | {
      readonly kind: "scan-incomplete";
      readonly problems: readonly ScanProblem[];
    }
  | {
      readonly kind: "failed";
      readonly phase: "prepare" | "apply";
      readonly cause: unknown;
    }
  | { readonly kind: "capture-failed"; readonly failure: CaptureFailure }
  | RestoreProtocolOutcome;

type ConfirmedRestoreResult =
  | ArrivalReceipt<ConfirmedRestoreExecution>
  | WorkspaceReceipt<Extract<ConfirmedRestoreExecution, { kind: "missing" }>>;

interface PreparedRestore {
  readonly kind: "prepared";
  readonly resolution: ResolvedNodeState;
  readonly snapshot: WorkspaceSnapshot;
  readonly drift: WorkspaceRestorePlan;
  readonly replayRisk: GitReplayRisk;
}

function isLockedConfirmedRestoreOutcome(
  value:
    | ConfirmedRestoreExecution
    | PreparedRestore
    | LockedArrivalOutcome<ConfirmedRestoreExecution>,
): value is LockedArrivalOutcome<ConfirmedRestoreExecution> {
  return isLockedArrivalOutcome(value);
}

async function withdrawAfterRestorePreparationFailure(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  cause: unknown,
  cleanupCause: unknown,
): Promise<RestorePreparationConflict> {
  const recovery = await runtime.withdrawFromParticipation(context, cause);
  return finalizeArrivalAfterWorkspaceExecution(
    runtime.workspaceMutations,
    context,
    { kind: "preparation-conflict", cause },
    { kind: "failed", cause: cleanupCause },
    recovery,
  ) as Promise<RestorePreparationConflict>;
}

function readExactTarget(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  expected: SessionView,
  node: NodeKey,
): SessionView | undefined {
  const current = readSessionView(context);
  if (
    !isExactUsableSessionView(current, expected, (candidate) =>
      runtime.registrations.sessionIsUsable(candidate),
    )
  ) {
    return undefined;
  }
  const anchor = runtime.checkpoints.captureAnchor(current);
  return anchor?.sessionId === node.sessionId && anchor.entryId === node.entryId
    ? current
    : undefined;
}

/**
 * The one destructive confirmation protocol shared by explicit restore and
 * loading an existing session. It binds the user's preview to the session,
 * node, canonical workspace, authoritative target, and complete observation.
 */
export function runConfirmedRestore(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  view: SessionView,
  node: NodeKey,
  mode: "manual",
): Promise<ArrivalReceipt<ConfirmedRestoreExecution>>;
export function runConfirmedRestore(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  view: SessionView,
  node: NodeKey,
  mode: "loaded-session",
): Promise<ConfirmedRestoreResult>;
export async function runConfirmedRestore(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  view: SessionView,
  node: NodeKey,
  mode: ConfirmedRestoreMode,
): Promise<ConfirmedRestoreResult> {
  let prepared: PreparedRestore | undefined;
  const finalizePendingArrival = async (
    execution: ConfirmedRestoreExecution,
    workspaceLockCleanup: CleanupSettlement = { kind: "settled" },
  ): Promise<ConfirmedRestoreResult> => {
    if (mode === "manual") {
      return finalizeArrivalAfterWorkspaceExecution(
        runtime.workspaceMutations,
        context,
        { execution, arrival: { kind: "admitted" } },
        workspaceLockCleanup,
      );
    }
    const recovery = await protectCurrentArrivalAfterWorkspaceFailure(
      runtime.workspaceMutations,
      context,
    );
    return finalizeArrivalAfterWorkspaceExecution(
      runtime.workspaceMutations,
      context,
      execution,
      workspaceLockCleanup,
      recovery,
    );
  };
  runtime.setStatus(context, runtime.i18n.t("checkingWorkspace"));
  try {
    const execution = await runtime.enqueueWorkspaceExecution(
      `${mode}-restore-prepare`,
      async (writeAuthority) => {
        const initial = readExactTarget(runtime, context, view, node);
        if (initial === undefined) {
          return { kind: "location-changed" as const };
        }
        const barrier = runtime.workspaceMutations.reconcileSessionBarrier(
          writeAuthority,
          initial,
          node,
        );
        if (barrier === "unregistered") {
          return { kind: "location-changed" as const };
        }
        let readable: ResolvedReadableTree | undefined;
        try {
          readable = await runtime.resolveReadableTreeIn(initial, node);
        } catch (error) {
          if (mode === "loaded-session") {
            return restorePreparationConflict(
              runtime.workspaceMutations,
              context,
              error,
              { kind: "held", writeAuthority },
            );
          }
          throw error;
        }
        if (readable === undefined) {
          const protectedMissing = runtime.checkpoints.locationIsBlocked(node);
          if (mode === "loaded-session" && protectedMissing) {
            // A durable guard means this is not a fresh first observation: the
            // live files were deliberately left unassigned on an earlier
            // arrival. Preserve that fact across process replacement.
            const current = readExactTarget(runtime, context, view, node);
            if (current === undefined) {
              return { kind: "target-changed" as const };
            }
            const protection = runtime.workspaceMutations.protectCurrentNode(
              writeAuthority,
              current,
              node,
            );
            if (protection.kind === "unsettled") {
              return restorePreparationConflict(
                runtime.workspaceMutations,
                context,
                protection.cause,
                { kind: "held", writeAuthority },
              );
            }
            return {
              execution: { kind: "protected-missing" as const },
              arrival: protection,
            };
          }
          if (mode !== "manual" || !protectedMissing) {
            return { kind: "missing" as const };
          }
          const first = await runtime.checkpoints.prepareCurrent(view);
          if (!first.ok) {
            return {
              kind: "capture-failed" as const,
              failure: first.error,
            };
          }
          const current = readExactTarget(runtime, context, view, node);
          if (
            current === undefined ||
            !runtime.workspaceMutations.locationIsUnresolved(current, node)
          ) {
            return { kind: "target-changed" as const };
          }
          const committed = runtime.commitMissingCapture(
            writeAuthority,
            current,
            node,
            first.value,
            "adopt-protected",
          );
          if (!committed.ok) {
            return {
              kind: "capture-failed" as const,
              failure: committed.error,
            };
          }
          const resolution = {
            treeOid: first.value.treeOid,
            foundAt: node,
          };
          const arrival = await settleCheckpointInitialization(
            {
              readCurrentView: () => readSessionView(context),
              sessionIsUsable: (candidate) =>
                runtime.registrations.sessionIsUsable(candidate),
              captureAnchor: (candidate) =>
                runtime.checkpoints.captureAnchor(candidate),
              protectCommittedArrival: (_cause) =>
                runtime.workspaceMutations.recoverUncertainLocationInWorkspaceLock(
                  writeAuthority,
                  context,
                ),
            },
            {
              expected: current,
              node,
              resolution,
              admit: (candidate, target) =>
                locationInitializationAdmission(
                  runtime.workspaceMutations.admitLocationIfResolution(
                    writeAuthority,
                    candidate,
                    target,
                  ),
                ),
            },
          );
          return arrival.kind === "admitted"
            ? ({
                execution: { kind: "initialized" as const },
                arrival,
              } as const)
            : checkpointInitializationDispositionConflict(
                arrival.kind === "unsettled"
                  ? arrival.cause
                  : new Error(
                      "checkpoint initialization completed under durable protection",
                    ),
                arrival,
              );
        }
        const { resolution, manifest, scopeValidation } = readable;
        const effectiveResolution =
          mode === "loaded-session"
            ? { treeOid: resolution.treeOid, foundAt: node }
            : resolution;
        if (mode === "loaded-session") {
          const current = readExactTarget(runtime, context, view, node);
          if (
            current === undefined ||
            !runtime.workspaceMutations.resolutionStillAuthoritative(
              current,
              node,
              resolution,
            )
          ) {
            return { kind: "target-changed" as const };
          }
          const protection = runtime.workspaceMutations.protectNodeIfResolution(
            writeAuthority,
            current,
            node,
            resolution,
          );
          if (protection.kind === "unsettled") {
            return restorePreparationConflict(
              runtime.workspaceMutations,
              context,
              protection.cause,
              { kind: "held", writeAuthority },
            );
          }
        }
        const snapshot = await runtime.scanCurrentWorkspaceForScope(
          view.cwd,
          manifest.scope,
        );
        if (snapshot.problems.length > 0) {
          return {
            kind: "scan-incomplete" as const,
            problems: snapshot.problems,
          };
        }
        if (
          !sameGitOracleVersion(
            scopeValidation.gitVersion,
            snapshot.gitOracleVersion,
          )
        ) {
          throw new Error(
            "Git evaluator changed while preparing the restore preview",
          );
        }
        const drift = (await prepareWorkspaceRestorePlan(snapshot, manifest))
          .plan;
        if (drift.problems.length > 0) {
          return {
            kind: "scan-incomplete" as const,
            problems: drift.problems,
          };
        }
        if (!restorePlanHasChanges(drift)) {
          const current = readExactTarget(runtime, context, view, node);
          if (
            current === undefined ||
            !runtime.workspaceMutations.resolutionStillAuthoritative(
              current,
              node,
              effectiveResolution,
            ) ||
            !runtime.workspaceMutations.admitLocationIfResolution(
              writeAuthority,
              current,
              effectiveResolution,
            )
          ) {
            return { kind: "target-changed" as const };
          }
          return {
            execution: { kind: "matches" as const },
            arrival: { kind: "admitted" as const },
          };
        }
        return {
          kind: "prepared" as const,
          resolution: effectiveResolution,
          snapshot,
          drift,
          replayRisk: gitReplayRisk(manifest.scope, snapshot.gitOracleVersion),
        };
      },
    );
    if (execution.cleanup.kind === "failed") {
      const cleanup = execution.cleanup;
      if (execution.kind === "completed") {
        const result = execution.value;
        if (isLockedConfirmedRestoreOutcome(result)) {
          return finalizeArrivalAfterWorkspaceExecution<ConfirmedRestoreExecution>(
            runtime.workspaceMutations,
            context,
            result,
            cleanup,
          );
        }
        if (result.kind !== "prepared" && result.kind !== "missing") {
          const recovery = await runtime.withdrawFromParticipation(
            context,
            execution.cleanup.cause,
          );
          return finalizeArrivalAfterWorkspaceExecution(
            runtime.workspaceMutations,
            context,
            result,
            cleanup,
            recovery,
          );
        }
      }
      const cause =
        execution.kind === "action-failed"
          ? execution.cause
          : execution.cleanup.cause;
      const conflict = await withdrawAfterRestorePreparationFailure(
        runtime,
        context,
        cause,
        execution.cleanup.cause,
      );
      return conflict;
    }
    if (execution.kind === "action-failed") throw execution.cause;
    const result = execution.value;
    if (isLockedConfirmedRestoreOutcome(result)) {
      return finalizeArrivalAfterWorkspaceExecution<ConfirmedRestoreExecution>(
        runtime.workspaceMutations,
        context,
        result,
        execution.cleanup,
      );
    }
    if (result.kind !== "prepared") {
      switch (result.kind) {
        case "missing":
          return mode === "loaded-session"
            ? { execution: result, workspaceLockCleanup: execution.cleanup }
            : finalizePendingArrival(result, execution.cleanup);
        case "location-changed":
        case "target-changed":
        case "scan-incomplete":
        case "capture-failed":
          return finalizePendingArrival(result, execution.cleanup);
        default:
          return assertNever(result, "unhandled restore preparation result");
      }
    }
    prepared = result;
  } catch (error) {
    if (mode === "loaded-session") {
      const conflict = await restorePreparationConflict(
        runtime.workspaceMutations,
        context,
        error,
        { kind: "released" },
      );
      return conflict;
    }
    return finalizePendingArrival({
      kind: "failed",
      phase: "prepare",
      cause: error,
    });
  } finally {
    runtime.setStatus(context, undefined);
  }
  if (prepared === undefined) {
    return finalizePendingArrival({
      kind: "failed",
      phase: "prepare",
      cause: new Error("restore preparation completed without a preview"),
    });
  }
  const restore = prepared;

  // Product policy: automatic loaded-session reconciliation never opens an
  // interactive prompt in RPC mode. Manual /restore remains interactive.
  if (!context.hasUI || (mode === "loaded-session" && context.mode === "rpc")) {
    return finalizePendingArrival({
      kind: "needs-ui",
      replayRisk: restore.replayRisk,
    });
  }
  let confirmed: boolean;
  try {
    confirmed = await requestRestoreChoice(
      runtime,
      context,
      mode,
      restore.drift,
      restore.replayRisk,
    );
  } catch (error) {
    return finalizePendingArrival({
      kind: "failed",
      phase: "prepare",
      cause: error,
    });
  }
  if (!confirmed) return finalizePendingArrival({ kind: "cancelled" });

  runtime.setStatus(context, runtime.i18n.t("restoringWorkspace"));
  const mutationProtocol = new WorkspaceMutationProtocol(
    runtime.workspaceMutations,
    context,
  );
  try {
    const execution = await runtime.enqueueWorkspaceExecution(
      `${mode}-restore-apply`,
      async (
        writeAuthority,
      ): Promise<
        ConfirmedRestoreExecution | WorkspaceMutationProtocolActionResult
      > => {
        if (
          !context.isIdle() ||
          (mode === "manual" && runtime.admission.rejectTransitionConflict())
        ) {
          return { kind: "location-changed" };
        }
        const authenticated = readExactTarget(runtime, context, view, node);
        if (authenticated === undefined) {
          return { kind: "location-changed" };
        }
        if (
          !runtime.workspaceMutations.resolutionStillAuthoritative(
            authenticated,
            node,
            restore.resolution,
          )
        ) {
          return { kind: "target-changed" };
        }
        const current = await runtime.scanCurrentWorkspaceForScope(
          view.cwd,
          restore.snapshot.scope,
        );
        if (current.problems.length > 0) {
          return {
            kind: "scan-incomplete",
            problems: current.problems,
          };
        }
        if (current.rootPath !== restore.snapshot.rootPath) {
          return { kind: "location-changed" };
        }
        if (
          !sameGitOracleVersion(
            current.gitOracleVersion,
            restore.snapshot.gitOracleVersion,
          )
        ) {
          return { kind: "preview-stale" };
        }
        const gap = planWorkspaceRestore(
          current,
          workspaceSnapshotAsManifest(restore.snapshot),
        );
        if (gap.problems.length > 0 || restorePlanHasChanges(gap)) {
          return { kind: "preview-stale" };
        }
        return mutationProtocol.restoreLocation(
          {
            expected: authenticated,
            node,
            resolution: restore.resolution,
            current,
          },
          writeAuthority,
        );
      },
    );
    if (execution.kind === "action-failed") {
      return finalizePendingArrival(
        {
          kind: "failed",
          phase: "apply",
          cause: execution.cause,
        },
        execution.cleanup,
      );
    }
    const value = execution.value;
    if (isLockedConfirmedRestoreOutcome(value)) {
      const locked = value;
      const recoveredExecution =
        execution.cleanup.kind === "failed" &&
        (locked.execution.kind === "outcome" ||
          locked.execution.kind === "post-mutation-conflict")
          ? mutationProtocol.recoveryExecutionAfterCleanupFailure(
              locked.execution,
              execution.cleanup.cause,
            )
          : undefined;
      if (recoveredExecution === undefined) {
        return finalizeArrivalAfterWorkspaceExecution(
          runtime.workspaceMutations,
          context,
          locked,
          execution.cleanup,
        );
      }
      const recovery = await protectCurrentArrivalAfterWorkspaceFailure(
        runtime.workspaceMutations,
        context,
      );
      return finalizeArrivalAfterWorkspaceExecution(
        runtime.workspaceMutations,
        context,
        recoveredExecution,
        execution.cleanup,
        recovery,
      );
    }
    if (execution.cleanup.kind === "failed" && value.kind === "outcome") {
      const recoveredExecution =
        mutationProtocol.recoveryExecutionAfterCleanupFailure(
          value,
          execution.cleanup.cause,
        );
      if (recoveredExecution !== undefined) {
        const recovery = await protectCurrentArrivalAfterWorkspaceFailure(
          runtime.workspaceMutations,
          context,
        );
        return finalizeArrivalAfterWorkspaceExecution(
          runtime.workspaceMutations,
          context,
          recoveredExecution,
          execution.cleanup,
          recovery,
        );
      }
    }
    return finalizePendingArrival(value, execution.cleanup);
  } catch (error) {
    return finalizePendingArrival({
      kind: "failed",
      phase: "apply",
      cause: error,
    });
  } finally {
    runtime.setStatus(context, undefined);
  }
}
