import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  planWorkspaceRestore,
  restorePlanHasChanges,
  workspaceSnapshotAsManifest,
  type WorkspaceRestorePlan,
} from "../infrastructure/restore-plan.ts";
import { prepareWorkspaceRestorePlan } from "../infrastructure/restore-preparation.ts";
import {
  restoreWorkspace,
  type RestoreOutcome,
} from "../application/restore.ts";
import type { ResolvedNodeState } from "../application/resolve.ts";
import type { NodeKey } from "../domain/model.ts";
import type { WorkspaceSnapshot } from "../infrastructure/workspace-scan.ts";
import {
  checkpointInitializationConflict,
  postMutationControlFailure,
  protectCurrentArrivalInWorkspaceLock,
  type CheckpointInitializationConflict,
  type PostMutationConflict,
} from "./post-mutation.ts";
import { requestRestoreChoice } from "./restore-choice.ts";
import {
  messageOf,
  type CyclotomyRuntime,
  type ResolvedReadableTree,
} from "./runtime.ts";
import { readSessionView, type SessionView } from "./session-view.ts";

export type ConfirmedRestoreMode = "manual" | "loaded-session";

export type ConfirmedRestoreResult =
  | PostMutationConflict
  | CheckpointInitializationConflict
  | { readonly kind: "missing" }
  | { readonly kind: "protected-missing" }
  | { readonly kind: "initialized" }
  | { readonly kind: "matches" }
  | { readonly kind: "needs-ui" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "location-changed" }
  | { readonly kind: "target-changed" }
  | { readonly kind: "preview-stale" }
  | { readonly kind: "scan-incomplete"; readonly message: string }
  | {
      readonly kind: "failed";
      readonly phase: "prepare" | "apply";
      readonly message: string;
    }
  | { readonly kind: "outcome"; readonly outcome: RestoreOutcome };

interface PreparedRestore {
  readonly resolution: ResolvedNodeState;
  readonly snapshot: WorkspaceSnapshot;
  readonly drift: WorkspaceRestorePlan;
}

function stillAtTarget(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  expected: SessionView,
  node: NodeKey,
): boolean {
  return viewIsAtTarget(runtime, readSessionView(context), expected, node);
}

function viewIsAtTarget(
  runtime: CyclotomyRuntime,
  current: SessionView,
  expected: SessionView,
  node: NodeKey,
): boolean {
  if (
    !runtime.sessionIsUsable(current) ||
    current.sessionId !== expected.sessionId ||
    current.sessionFile !== expected.sessionFile ||
    current.leafId !== expected.leafId ||
    current.cwd !== expected.cwd
  ) {
    return false;
  }
  const anchor = runtime.captureAnchor(current);
  return (
    anchor?.sessionId === node.sessionId && anchor.entryId === node.entryId
  );
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
  let initializedCheckpointCommitted = false;
  runtime.setStatus(context, runtime.i18n.t("checkingWorkspace"));
  try {
    const result = await runtime.enqueueWorkspace(
      `${mode}-restore-prepare`,
      async () => {
        if (!stillAtTarget(runtime, context, view, node)) {
          return { kind: "location-changed" as const };
        }
        let readable: ResolvedReadableTree | undefined;
        try {
          readable = await runtime.resolveReadableTreeIn(view, node);
        } catch (error) {
          if (mode === "loaded-session") runtime.protectNode(view, node);
          throw error;
        }
        if (readable === undefined) {
          const protectedMissing = runtime.metadata.isNodeWriteProtected(
            node.sessionId,
            node.entryId,
          );
          if (mode === "loaded-session" && protectedMissing) {
            // A durable guard means this is not a fresh first observation: the
            // live files were deliberately left unassigned on an earlier
            // arrival. Preserve that fact across process replacement.
            runtime.protectNode(view, node);
            return { kind: "protected-missing" as const };
          }
          if (mode !== "manual" || !protectedMissing) {
            return { kind: "missing" as const };
          }
          const first = await runtime.prepareCaptureResult(view);
          if (!first.ok) {
            return {
              kind: "failed" as const,
              phase: "prepare" as const,
              message: first.error.message,
            };
          }
          if (
            !stillAtTarget(runtime, context, view, node) ||
            !runtime.resolutionStillAuthoritative(view, node, undefined)
          ) {
            return { kind: "target-changed" as const };
          }
          const committed = runtime.commitPreparedMissingCapture(
            node,
            first.value,
            "adopt-protected",
          );
          if (!committed.ok) {
            return {
              kind: "failed" as const,
              phase: "prepare" as const,
              message: committed.error.message,
            };
          }
          initializedCheckpointCommitted = true;
          try {
            const current = readSessionView(context);
            if (!viewIsAtTarget(runtime, current, view, node)) {
              return checkpointInitializationConflict(
                runtime,
                context,
                "active location changed after checkpoint initialization",
              );
            }
            if (!runtime.admitLocation(current, first.value.treeOid)) {
              return checkpointInitializationConflict(
                runtime,
                context,
                "checkpoint admission changed after initialization",
              );
            }
          } catch (error) {
            return checkpointInitializationConflict(runtime, context, error);
          }
          return { kind: "initialized" as const };
        }
        const { resolution, manifest } = readable;
        const effectiveResolution =
          mode === "loaded-session"
            ? { treeOid: resolution.treeOid, foundAt: node }
            : resolution;
        if (
          mode === "loaded-session" &&
          (!stillAtTarget(runtime, context, view, node) ||
            !runtime.resolutionStillAuthoritative(view, node, resolution) ||
            !runtime.protectNode(view, node, resolution))
        ) {
          return { kind: "target-changed" as const };
        }
        const snapshot = await runtime.scanCurrentWorkspaceForScope(
          view.cwd,
          manifest.scope,
        );
        if (snapshot.problems.length > 0) {
          return {
            kind: "scan-incomplete" as const,
            message: runtime.i18n.formatScanProblems(snapshot.problems),
          };
        }
        const drift = (await prepareWorkspaceRestorePlan(snapshot, manifest))
          .plan;
        if (drift.problems.length > 0) {
          return {
            kind: "scan-incomplete" as const,
            message: runtime.i18n.formatScanProblems(drift.problems),
          };
        }
        if (!restorePlanHasChanges(drift)) {
          if (
            !stillAtTarget(runtime, context, view, node) ||
            !runtime.resolutionStillAuthoritative(
              view,
              node,
              effectiveResolution,
            ) ||
            !runtime.admitLocation(
              readSessionView(context),
              effectiveResolution.treeOid,
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
    if (result.kind !== "prepared") return result;
    prepared = result;
  } catch (error) {
    if (initializedCheckpointCommitted) {
      return checkpointInitializationConflict(
        runtime,
        context,
        error,
        `${mode}-initialize-post-failure-protect`,
      );
    }
    return { kind: "failed", phase: "prepare", message: messageOf(error) };
  } finally {
    runtime.setStatus(context, undefined);
  }

  // Pi binds RPC stdin only after session_start finishes. Opening a selector
  // while loading the session would therefore wait for a response the client
  // cannot send yet. Manual RPC /restore runs after startup and remains fully
  // interactive.
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
      message: messageOf(error),
    };
  }
  if (!confirmed) return { kind: "cancelled" };

  runtime.setStatus(context, runtime.i18n.t("restoringWorkspace"));
  let mutationStarted = false;
  let mutationOutcome: RestoreOutcome | undefined;
  try {
    return await runtime.enqueueWorkspace(
      `${mode}-restore-apply`,
      async (): Promise<ConfirmedRestoreResult> => {
        if (
          !context.isIdle() ||
          (mode === "manual" && runtime.transitions.rejectConflict())
        ) {
          return { kind: "location-changed" };
        }
        if (!stillAtTarget(runtime, context, view, node)) {
          return { kind: "location-changed" };
        }
        if (
          !runtime.resolutionStillAuthoritative(view, node, prepared.resolution)
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
            message: runtime.i18n.formatScanProblems(current.problems),
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
        let preMutationConflict:
          "location-changed" | "target-changed" | undefined;
        const outcome = await restoreWorkspace(
          runtime.restoreDeps(),
          view.cwd,
          prepared.resolution,
          {
            current,
            beforeMutation: () => {
              if (!stillAtTarget(runtime, context, view, node)) {
                preMutationConflict = "location-changed";
                throw new Error(
                  "active location changed before restore mutation",
                );
              }
              if (!runtime.protectNode(view, node, prepared.resolution)) {
                preMutationConflict = "target-changed";
                throw new Error(
                  "checkpoint changed while restore protection was installed",
                );
              }
              mutationStarted = true;
            },
          },
        );
        if (mutationStarted) mutationOutcome = outcome;
        if (!mutationStarted && preMutationConflict !== undefined) {
          return { kind: preMutationConflict };
        }

        if (mutationStarted) {
          let currentView: SessionView | undefined;
          let locationMatches = false;
          try {
            currentView = readSessionView(context);
            locationMatches = viewIsAtTarget(runtime, currentView, view, node);
          } catch {
            // The shared protection helper reports the actionable failure.
          }
          if (!locationMatches) {
            return {
              kind: "post-mutation-conflict",
              reason: "location-changed",
              outcome,
              arrivalProtection: await protectCurrentArrivalInWorkspaceLock(
                runtime,
                context,
              ),
            };
          }

          const pinnedResolution = {
            treeOid: prepared.resolution.treeOid,
            foundAt: node,
          };
          if (
            currentView === undefined ||
            !runtime.resolutionStillAuthoritative(
              currentView,
              node,
              pinnedResolution,
            )
          ) {
            return {
              kind: "post-mutation-conflict",
              reason: "target-changed",
              outcome,
              arrivalProtection: await protectCurrentArrivalInWorkspaceLock(
                runtime,
                context,
              ),
            };
          }
          if (outcome.kind !== "restored") {
            return { kind: "outcome", outcome };
          }
          if (!runtime.admitLocation(currentView, pinnedResolution.treeOid)) {
            return {
              kind: "post-mutation-conflict",
              reason: "target-changed",
              outcome,
              arrivalProtection: await protectCurrentArrivalInWorkspaceLock(
                runtime,
                context,
              ),
            };
          }
          return { kind: "outcome", outcome };
        }

        if (outcome.kind !== "restored") {
          return { kind: "outcome", outcome };
        }
        // A restored result necessarily crossed beforeMutation. Keep this
        // defensive branch fail-closed if that application invariant changes.
        const arrivalProtection = await protectCurrentArrivalInWorkspaceLock(
          runtime,
          context,
        );
        return {
          kind: "post-mutation-conflict",
          reason: "target-changed",
          outcome,
          arrivalProtection,
        };
      },
    );
  } catch (error) {
    if (mutationStarted) {
      return postMutationControlFailure(
        runtime,
        context,
        error,
        mutationOutcome,
        `${mode}-restore-post-failure-protect`,
      );
    }
    return { kind: "failed", phase: "apply", message: messageOf(error) };
  } finally {
    runtime.setStatus(context, undefined);
  }
}
