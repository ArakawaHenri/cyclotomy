import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  planWorkspaceRestore,
  restorePlanHasChanges,
  workspaceSnapshotAsManifest,
  type WorkspaceRestorePlan,
} from "../infrastructure/restore-plan.ts";
import { prepareWorkspaceRestorePlan } from "../infrastructure/restore-preparation.ts";
import type { ResolvedNodeState } from "../application/resolve.ts";
import type { CaptureFailure } from "../application/capture.ts";
import type { ResolvedReadableTree } from "../application/checkpoint-service.ts";
import type { NodeKey } from "../domain/model.ts";
import type {
  ScanProblem,
  WorkspaceSnapshot,
} from "../infrastructure/workspace-scan.ts";
import {
  checkpointInitializationDispositionConflict,
  mergeCleanupSettlements,
  restorePreparationConflict,
  type CheckpointInitializationConflict,
  type PostMutationConflict,
  type RestorePreparationConflict,
} from "./post-mutation.ts";
import {
  locationInitializationAdmission,
  settleCheckpointInitialization,
} from "./checkpoint-initialization-protocol.ts";
import { notifyWorkspaceLockCleanupFailure } from "./restore-outcome.ts";
import { requestRestoreChoice } from "./restore-choice.ts";
import type { CyclotomyRuntime } from "./runtime.ts";
import { readSessionView, type SessionView } from "./session-view.ts";
import {
  WorkspaceMutationProtocol,
  type RestoreProtocolOutcome,
  type WorkspaceMutationProtocolResult,
} from "./workspace-mutation-protocol.ts";

export type ConfirmedRestoreMode = "manual" | "loaded-session";

export type ConfirmedRestoreResult =
  | PostMutationConflict
  | CheckpointInitializationConflict
  | RestorePreparationConflict
  | { readonly kind: "missing" }
  | { readonly kind: "protected-missing" }
  | { readonly kind: "initialized" }
  | { readonly kind: "matches" }
  | { readonly kind: "needs-ui" }
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

interface PreparedRestore {
  readonly resolution: ResolvedNodeState;
  readonly snapshot: WorkspaceSnapshot;
  readonly drift: WorkspaceRestorePlan;
}

async function withdrawAfterRestorePreparationFailure(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  cause: unknown,
  cleanupCause: unknown,
): Promise<RestorePreparationConflict> {
  const recovery = await runtime.withdrawFromParticipation(context, cause);
  return {
    kind: "preparation-conflict",
    cause,
    arrivalProtection: recovery.protection,
    workspaceLockCleanup: mergeCleanupSettlements(
      { kind: "failed", cause: cleanupCause },
      recovery.workspaceLockCleanup,
    ),
  };
}

function readExactTarget(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  expected: SessionView,
  node: NodeKey,
): SessionView | undefined {
  const current = readSessionView(context);
  if (
    !runtime.registrations.sessionIsUsable(current) ||
    !current.isSameSnapshotAs(expected)
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
export async function runConfirmedRestore(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  view: SessionView,
  node: NodeKey,
  mode: ConfirmedRestoreMode,
): Promise<ConfirmedRestoreResult> {
  let prepared: PreparedRestore | undefined;
  runtime.setStatusBestEffort(context, () =>
    runtime.i18n.t("checkingWorkspace"),
  );
  try {
    const execution = await runtime.enqueueWorkspaceExecution(
      `${mode}-restore-prepare`,
      async () => {
        const initial = readExactTarget(runtime, context, view, node);
        if (initial === undefined) {
          return { kind: "location-changed" as const };
        }
        const barrier = runtime.workspaceMutations.reconcileSessionBarrier(
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
              "held",
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
              current,
              node,
            );
            if (protection.kind === "unsettled") {
              return restorePreparationConflict(
                runtime.workspaceMutations,
                context,
                protection.cause,
                "held",
              );
            }
            return { kind: "protected-missing" as const };
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
                    candidate,
                    target,
                  ),
                ),
            },
          );
          return arrival.kind === "admitted"
            ? ({ kind: "initialized" } as const)
            : checkpointInitializationDispositionConflict(
                arrival.kind === "unsettled"
                  ? arrival.cause
                  : new Error(
                      "checkpoint initialization completed under durable protection",
                    ),
                arrival,
              );
        }
        const { resolution, manifest } = readable;
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
            current,
            node,
            resolution,
          );
          if (protection.kind === "unsettled") {
            return restorePreparationConflict(
              runtime.workspaceMutations,
              context,
              protection.cause,
              "held",
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
              current,
              effectiveResolution,
            )
          ) {
            return { kind: "target-changed" as const };
          }
          return { kind: "matches" as const };
        }
        return {
          kind: "prepared" as const,
          resolution: effectiveResolution,
          snapshot,
          drift,
        };
      },
    );
    if (execution.cleanup.kind === "failed") {
      const cause =
        execution.kind === "action-failed"
          ? new AggregateError(
              [execution.cause, execution.cleanup.cause],
              "restore preparation and workspace-lock cleanup failed",
              { cause: execution.cause },
            )
          : execution.cleanup.cause;
      return withdrawAfterRestorePreparationFailure(
        runtime,
        context,
        cause,
        execution.cleanup.cause,
      );
    }
    if (execution.kind === "action-failed") throw execution.cause;
    const result = execution.value;
    if (result.kind !== "prepared") return result;
    prepared = result;
  } catch (error) {
    if (mode === "loaded-session") {
      return restorePreparationConflict(
        runtime.workspaceMutations,
        context,
        error,
        "released",
      );
    }
    return { kind: "failed", phase: "prepare", cause: error };
  } finally {
    runtime.setStatus(context, undefined);
  }

  // Product policy: automatic loaded-session reconciliation never opens an
  // interactive prompt in RPC mode. Manual /restore remains interactive.
  if (!context.hasUI || (mode === "loaded-session" && context.mode === "rpc")) {
    return { kind: "needs-ui" };
  }
  let confirmed: boolean;
  try {
    confirmed = await requestRestoreChoice(
      runtime,
      context,
      mode,
      prepared.drift,
    );
  } catch (error) {
    return {
      kind: "failed",
      phase: "prepare",
      cause: error,
    };
  }
  if (!confirmed) return { kind: "cancelled" };

  runtime.setStatusBestEffort(context, () =>
    runtime.i18n.t("restoringWorkspace"),
  );
  const mutationProtocol = new WorkspaceMutationProtocol(
    runtime.workspaceMutations,
    context,
  );
  let mutationResult: WorkspaceMutationProtocolResult | undefined;
  try {
    const execution = await runtime.enqueueWorkspaceExecution(
      `${mode}-restore-apply`,
      async (): Promise<ConfirmedRestoreResult> => {
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
            prepared.resolution,
          )
        ) {
          return { kind: "target-changed" };
        }
        const current = await runtime.scanCurrentWorkspaceForScope(
          view.cwd,
          prepared.snapshot.scope,
        );
        if (current.problems.length > 0) {
          return {
            kind: "scan-incomplete",
            problems: current.problems,
          };
        }
        if (current.rootPath !== prepared.snapshot.rootPath) {
          return { kind: "location-changed" };
        }
        const gap = planWorkspaceRestore(
          current,
          workspaceSnapshotAsManifest(prepared.snapshot),
        );
        if (gap.problems.length > 0 || restorePlanHasChanges(gap)) {
          return { kind: "preview-stale" };
        }
        mutationResult = await mutationProtocol.restoreLocation({
          expected: authenticated,
          node,
          resolution: prepared.resolution,
          current,
        });
        return mutationResult;
      },
    );
    if (execution.kind === "action-failed") {
      const recovered = await mutationProtocol.recoverAfterWorkspaceFailure(
        execution.cause,
        mutationResult,
        execution.cleanup.kind === "failed"
          ? { kind: "failed", cause: execution.cleanup.cause }
          : { kind: "settled" },
      );
      if (recovered === undefined && execution.cleanup.kind === "failed") {
        notifyWorkspaceLockCleanupFailure(runtime, context, {
          kind: "failed",
          cause: execution.cleanup.cause,
        });
      }
      return (
        recovered ?? {
          kind: "failed",
          phase: "apply",
          cause: execution.cause,
        }
      );
    }
    if (execution.cleanup.kind === "failed") {
      const cleanupCause = execution.cleanup.cause;
      const recovered = await mutationProtocol.recoverAfterWorkspaceFailure(
        cleanupCause,
        mutationResult,
        { kind: "failed", cause: cleanupCause },
      );
      if (recovered !== undefined) return recovered;
      notifyWorkspaceLockCleanupFailure(runtime, context, {
        kind: "failed",
        cause: cleanupCause,
      });
    }
    return execution.value;
  } catch (error) {
    const recovered = await mutationProtocol.recoverAfterWorkspaceFailure(
      error,
      mutationResult,
      { kind: "settled" },
    );
    return (
      recovered ?? { kind: "failed", phase: "apply", cause: error as unknown }
    );
  } finally {
    runtime.setStatus(context, undefined);
  }
}
