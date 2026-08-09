import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  commitPreparedNodeState,
  prepareObservedNodeState,
  type CaptureSuccess,
} from "../application/capture.ts";
import {
  restoreWorkspace,
  type RestoreOutcome,
} from "../application/restore.ts";
import type { NodeKey } from "../domain/model.ts";
import {
  planWorkspaceRestore,
  restorePlanHasChanges,
  workspaceSnapshotAsManifest,
} from "../infrastructure/restore-plan.ts";
import { prepareWorkspaceRestorePlan } from "../infrastructure/restore-preparation.ts";
import type { WorkspaceSnapshot } from "../infrastructure/workspace-scan.ts";
import {
  checkpointInitializationConflict,
  postMutationControlFailure,
  protectCurrentArrivalInWorkspaceLock,
} from "./post-mutation.ts";
import { requestRestoreChoice } from "./restore-choice.ts";
import {
  notifyCheckpointInitializationConflict,
  notifyPostMutationConflict,
  notifyRestoreOutcome,
} from "./restore-outcome.ts";
import { CyclotomyRuntime, messageOf } from "./runtime.ts";
import { readSessionView, type SessionView } from "./session-view.ts";
import type {
  NavigationTargetPlan,
  PendingNavigation,
} from "./transition-state.ts";

function withDetail(message: string, detail: string): string {
  return `${message} ${detail}`;
}

function stillAt(
  context: ExtensionContext,
  sessionId: string,
  leafId: string | null,
  cwd: string,
): boolean {
  const current = readSessionView(context);
  return (
    current.sessionId === sessionId &&
    current.leafId === leafId &&
    current.cwd === cwd
  );
}

function arrivalMatches(
  plan: PendingNavigation,
  event: {
    readonly oldLeafId: string | null;
    readonly newLeafId: string | null;
    readonly summaryEntry?: {
      readonly id: string;
      readonly parentId: string | null;
    };
  },
  view: SessionView,
): boolean {
  if (
    view.sessionId !== plan.sessionId ||
    view.cwd !== plan.cwd ||
    event.oldLeafId !== plan.expectedOldLeafId ||
    event.newLeafId !== view.leafId
  ) {
    return false;
  }
  if (event.newLeafId === plan.expectedDestinationId) return true;
  if (event.newLeafId === null) return false;

  if (event.summaryEntry !== undefined) {
    if (event.summaryEntry.parentId !== plan.expectedDestinationId) {
      return false;
    }
    if (event.newLeafId === event.summaryEntry.id) return true;
    return (
      view.entryTypeOf(event.newLeafId) === "label" &&
      view.parentIdOf(event.newLeafId) === event.summaryEntry.id
    );
  }

  return (
    view.entryTypeOf(event.newLeafId) === "label" &&
    view.parentIdOf(event.newLeafId) === plan.expectedDestinationId
  );
}

/** Whether capturing source will become target's nearest exact slot. */
function targetWillInheritSource(
  runtime: CyclotomyRuntime,
  view: SessionView,
  source: NodeKey | undefined,
  target: NodeKey | undefined,
): boolean {
  if (
    source === undefined ||
    target === undefined ||
    source.sessionId !== target.sessionId
  ) {
    return false;
  }
  const ancestry = runtime.ancestryIds(view, target.entryId);
  const sourceIndex = ancestry.lastIndexOf(source.entryId);
  if (sourceIndex < 0) return false;
  return ancestry
    .slice(sourceIndex + 1)
    .every(
      (entryId) =>
        runtime.metadata.getState(target.sessionId, entryId) === undefined,
    );
}

function sameNode(
  left: NodeKey | undefined,
  right: NodeKey | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.sessionId === right.sessionId &&
    left.entryId === right.entryId
  );
}

function classifyTarget(
  runtime: CyclotomyRuntime,
  view: SessionView,
  source: NodeKey | undefined,
  target: NodeKey | undefined,
  sourceKind: "capture" | "protected" | "no-node",
  hasResolution: boolean,
): NavigationTargetPlan["kind"] {
  if (target === undefined) return "no-node";
  if (sameNode(source, target)) return "same-location";
  if (runtime.metadata.isNodeWriteProtected(target.sessionId, target.entryId)) {
    return hasResolution ? "restore" : "protected-missing";
  }
  if (
    sourceKind === "capture" &&
    targetWillInheritSource(runtime, view, source, target)
  ) {
    return "inherit-source";
  }
  if (hasResolution) return "restore";
  if (sourceKind === "protected") {
    return "protected-missing";
  }
  return "materialize-missing";
}

/** Register the two-phase Pi tree-navigation protocol. */
export function registerNavigationLifecycle(
  pi: ExtensionAPI,
  runtime: CyclotomyRuntime,
): void {
  pi.on("session_before_tree", async (event, context) => {
    runtime.setStatus(context, undefined);
    let view: SessionView;
    try {
      view = readSessionView(context);
      if (!runtime.sessionIsUsable(view)) return undefined;
      if (!context.isIdle() || !runtime.transitions.tryBegin("tree")) {
        runtime.notify(
          context,
          runtime.i18n.t("transitionInProgress"),
          "warning",
        );
        return { cancel: true };
      }
    } catch (error) {
      runtime.notify(
        context,
        runtime.i18n.t("navigationPrepareFailed", {
          message: messageOf(error),
        }),
        "warning",
      );
      return { cancel: true };
    }
    try {
      runtime.setStatus(context, runtime.i18n.t("checkingWorkspace"));
      if (!(await runtime.ensureStore(view.cwd))) {
        runtime.notifyInitFailure(context);
        return { cancel: true };
      }
      if (
        event.preparation.oldLeafId !== view.leafId ||
        event.preparation.targetId.length === 0
      ) {
        runtime.notify(
          context,
          runtime.i18n.t("navigationPlanMismatch"),
          "warning",
        );
        return { cancel: true };
      }
      const expectedDestinationId = view.navigationLandingId(
        event.preparation.targetId,
      );
      if (expectedDestinationId === undefined) {
        runtime.notify(
          context,
          runtime.i18n.t("navigationPlanMismatch"),
          "warning",
        );
        return { cancel: true };
      }
      const source = runtime.captureAnchor(view);
      const target =
        expectedDestinationId === null
          ? undefined
          : runtime.captureAnchor(view, expectedDestinationId);
      if (expectedDestinationId !== null && target === undefined) {
        runtime.notify(
          context,
          runtime.i18n.t("navigationPlanMismatch"),
          "warning",
        );
        return { cancel: true };
      }

      const prepared = await runtime
        .enqueueWorkspace("tree-prepare", async () => {
          const sourceAdmission = runtime.captureAdmission(view, source);
          if (sourceAdmission.kind === "blocked") {
            return {
              kind: "source-blocked" as const,
              message: "source location is not admitted for checkpointing",
            };
          }
          let sourceSnapshot: WorkspaceSnapshot | undefined;
          if (sourceAdmission.kind === "capture") {
            sourceSnapshot = await runtime.scanCurrentWorkspace(view.cwd);
            if (sourceSnapshot.problems.length > 0) {
              return {
                kind: "scan-incomplete" as const,
                message: runtime.i18n.formatScanProblems(
                  sourceSnapshot.problems,
                ),
              };
            }
          }

          const targetKind = classifyTarget(
            runtime,
            view,
            source,
            target,
            sourceAdmission.kind,
            false,
          );
          if (
            targetKind === "no-node" ||
            targetKind === "same-location" ||
            targetKind === "inherit-source"
          ) {
            return {
              kind: "ready" as const,
              sourceKind: sourceAdmission.kind,
              sourceSnapshot,
              restoreSnapshot: undefined,
              resolution: undefined,
              targetKind,
            };
          }
          if (target === undefined) {
            throw new Error("classified navigation target is missing");
          }
          const readable = await runtime.resolveReadableTreeIn(view, target);
          if (readable === undefined) {
            const missingKind = classifyTarget(
              runtime,
              view,
              source,
              target,
              sourceAdmission.kind,
              false,
            );
            return {
              kind: "ready" as const,
              sourceKind: sourceAdmission.kind,
              sourceSnapshot,
              restoreSnapshot: undefined,
              resolution: undefined,
              targetKind: missingKind,
            };
          }
          const { resolution, manifest } = readable;
          const restoreSnapshot = await runtime.scanCurrentWorkspaceForScope(
            view.cwd,
            manifest.scope,
          );
          if (restoreSnapshot.problems.length > 0) {
            return {
              kind: "scan-incomplete" as const,
              message: runtime.i18n.formatScanProblems(
                restoreSnapshot.problems,
              ),
            };
          }
          const drift = (
            await prepareWorkspaceRestorePlan(restoreSnapshot, manifest)
          ).plan;
          if (drift.problems.length > 0) {
            return {
              kind: "scan-incomplete" as const,
              message: runtime.i18n.formatScanProblems(drift.problems),
            };
          }
          return {
            kind: "ready" as const,
            sourceKind: sourceAdmission.kind,
            sourceSnapshot,
            restoreSnapshot,
            resolution,
            targetKind: "restore" as const,
            drift,
          };
        })
        .catch((error: unknown) => ({
          kind: "failed" as const,
          message: messageOf(error),
        }));

      if (prepared.kind === "scan-incomplete") {
        runtime.notify(
          context,
          runtime.i18n.t("navigationScanIncomplete", {
            message: prepared.message,
          }),
          "warning",
        );
        return { cancel: true };
      }
      if (prepared.kind === "source-blocked") {
        runtime.notify(
          context,
          withDetail(
            runtime.i18n.t("sourceCaptureFailed"),
            runtime.i18n.t("captureFailureDetail", {
              message: prepared.message,
            }),
          ),
          "error",
        );
        return { cancel: true };
      }
      if (prepared.kind === "failed") {
        runtime.notify(
          context,
          runtime.i18n.t("navigationPrepareFailed", {
            message: prepared.message,
          }),
          "warning",
        );
        return { cancel: true };
      }
      if (
        prepared.drift !== undefined &&
        restorePlanHasChanges(prepared.drift)
      ) {
        if (!context.hasUI) {
          runtime.notify(
            context,
            runtime.i18n.t("navigationNeedsUi", {
              preview: runtime.i18n.formatRestorePreview(prepared.drift),
            }),
            "warning",
          );
          return { cancel: true };
        }
        runtime.setStatus(context, undefined);
        let confirmed = false;
        try {
          confirmed = await requestRestoreChoice(
            runtime,
            context,
            "navigation",
            prepared.drift,
            event.signal,
          );
        } catch (error) {
          runtime.notify(
            context,
            runtime.i18n.t("navigationPrepareFailed", {
              message: messageOf(error),
            }),
            "warning",
          );
          return { cancel: true };
        }
        if (!confirmed) {
          return { cancel: true };
        }
        runtime.setStatus(context, runtime.i18n.t("checkingWorkspace"));
      }
      const committed = await runtime
        .enqueueWorkspace("tree-commit", async () => {
          if (
            !context.isIdle() ||
            !stillAt(context, view.sessionId, view.leafId, view.cwd)
          ) {
            return { kind: "location-changed" as const };
          }
          const sourceAdmission = runtime.captureAdmission(view, source);
          if (sourceAdmission.kind === "blocked") {
            return {
              kind: "capture-failed" as const,
              message: "source location is not admitted for checkpointing",
            };
          }
          if (sourceAdmission.kind !== prepared.sourceKind) {
            return { kind: "target-changed" as const };
          }
          let sourceCurrent: WorkspaceSnapshot | undefined;
          if (sourceAdmission.kind === "capture") {
            if (prepared.sourceSnapshot === undefined) {
              return { kind: "target-changed" as const };
            }
            sourceCurrent = await runtime.scanCurrentWorkspace(view.cwd);
            if (sourceCurrent.problems.length > 0) {
              return {
                kind: "scan-incomplete" as const,
                message: runtime.i18n.formatScanProblems(
                  sourceCurrent.problems,
                ),
              };
            }
            if (sourceCurrent.rootPath !== prepared.sourceSnapshot.rootPath) {
              return { kind: "location-changed" as const };
            }
            const sourceGap = planWorkspaceRestore(
              sourceCurrent,
              workspaceSnapshotAsManifest(prepared.sourceSnapshot),
            );
            if (
              sourceGap.problems.length > 0 ||
              restorePlanHasChanges(sourceGap)
            ) {
              return { kind: "preview-stale" as const };
            }
          }
          const targetKind = classifyTarget(
            runtime,
            view,
            source,
            target,
            sourceAdmission.kind,
            prepared.resolution !== undefined,
          );
          if (targetKind !== prepared.targetKind) {
            return { kind: "target-changed" as const };
          }
          if (
            target !== undefined &&
            targetKind !== "inherit-source" &&
            targetKind !== "same-location" &&
            !runtime.resolutionStillAuthoritative(
              view,
              target,
              prepared.resolution,
            )
          ) {
            return { kind: "target-changed" as const };
          }
          // The preview phase may have crossed an interactive confirmation.
          // Authenticate the unchanged target closure once more before Pi is
          // allowed to leave the source location.
          if (prepared.resolution !== undefined && targetKind === "restore") {
            await runtime.store.readTree(prepared.resolution.treeOid);
          }
          let restoreCurrent: WorkspaceSnapshot | undefined;
          if (targetKind === "restore") {
            if (prepared.restoreSnapshot === undefined) {
              return { kind: "target-changed" as const };
            }
            restoreCurrent = await runtime.scanCurrentWorkspaceForScope(
              view.cwd,
              prepared.restoreSnapshot.scope,
            );
            if (restoreCurrent.problems.length > 0) {
              return {
                kind: "scan-incomplete" as const,
                message: runtime.i18n.formatScanProblems(
                  restoreCurrent.problems,
                ),
              };
            }
            if (restoreCurrent.rootPath !== prepared.restoreSnapshot.rootPath) {
              return { kind: "location-changed" as const };
            }
            const restoreGap = planWorkspaceRestore(
              restoreCurrent,
              workspaceSnapshotAsManifest(prepared.restoreSnapshot),
            );
            if (
              restoreGap.problems.length > 0 ||
              restorePlanHasChanges(restoreGap)
            ) {
              return { kind: "preview-stale" as const };
            }
          } else if (targetKind === "inherit-source") {
            if (sourceCurrent === undefined) {
              return { kind: "target-changed" as const };
            }
            restoreCurrent = sourceCurrent;
          }
          let preparedSource: CaptureSuccess | undefined;
          if (sourceAdmission.kind === "capture" && source !== undefined) {
            if (sourceCurrent === undefined) {
              return { kind: "target-changed" as const };
            }
            const currentView = readSessionView(context);
            if (
              !runtime.captureLeaseIsCurrent(
                sourceAdmission.lease,
                currentView,
                source,
              )
            ) {
              return {
                kind: "capture-failed" as const,
                message:
                  "source location changed before checkpoint publication",
              };
            }
            const expectedSourceTreeOid = runtime.metadata.getState(
              source.sessionId,
              source.entryId,
            )?.treeOid;
            const published = await prepareObservedNodeState(
              runtime.checkpointDeps(),
              sourceCurrent,
            );
            if (!published.ok) {
              return {
                kind: "capture-failed" as const,
                message: published.error.message,
              };
            }
            preparedSource = published.value;
            const validatedView = readSessionView(context);
            if (
              !stillAt(context, view.sessionId, view.leafId, view.cwd) ||
              !(await runtime.workspaceStillBound(view.cwd)) ||
              !runtime.captureLeaseIsCurrent(
                sourceAdmission.lease,
                validatedView,
                source,
              )
            ) {
              return {
                kind: "capture-failed" as const,
                message:
                  "source location changed during checkpoint publication",
              };
            }
            const sourceCommitted = commitPreparedNodeState(
              runtime.checkpointDeps(),
              source,
              preparedSource,
              { treeOid: expectedSourceTreeOid },
            );
            if (!sourceCommitted.ok) {
              if (sourceCommitted.error.kind === "write-protected") {
                runtime.protectNode(view, source);
              }
              return {
                kind: "capture-failed" as const,
                message: sourceCommitted.error.message,
              };
            }
          }
          let targetPlan: NavigationTargetPlan;
          switch (prepared.targetKind) {
            case "no-node":
              targetPlan = { kind: "no-node" };
              break;
            case "materialize-missing":
              if (target === undefined) {
                return { kind: "target-changed" as const };
              }
              targetPlan = { kind: "materialize-missing", node: target };
              break;
            case "protected-missing":
              if (target === undefined) {
                return { kind: "target-changed" as const };
              }
              targetPlan = { kind: "protected-missing", node: target };
              break;
            case "same-location":
              if (target === undefined) {
                return { kind: "target-changed" as const };
              }
              targetPlan = { kind: "same-location", node: target };
              break;
            case "inherit-source":
              if (
                source === undefined ||
                target === undefined ||
                preparedSource === undefined
              ) {
                return { kind: "target-changed" as const };
              }
              targetPlan = {
                kind: "inherit-source",
                node: target,
                resolution: {
                  treeOid: preparedSource.treeOid,
                  foundAt: source,
                },
              };
              break;
            case "restore":
              if (target === undefined || prepared.resolution === undefined) {
                return { kind: "target-changed" as const };
              }
              targetPlan = {
                kind: "restore",
                node: target,
                resolution: prepared.resolution,
              };
              break;
          }
          return {
            kind: "ready" as const,
            snapshot: restoreCurrent,
            target: targetPlan,
          };
        })
        .catch((error: unknown) => ({
          kind: "failed" as const,
          message: messageOf(error),
        }));
      if (committed.kind !== "ready") {
        switch (committed.kind) {
          case "location-changed":
            runtime.notify(
              context,
              runtime.i18n.t("commandLocationChanged"),
              "warning",
            );
            break;
          case "scan-incomplete":
            runtime.notify(
              context,
              runtime.i18n.t("navigationScanIncomplete", {
                message: committed.message,
              }),
              "warning",
            );
            break;
          case "preview-stale":
            runtime.notify(
              context,
              runtime.i18n.t("navigationChangedBeforeDeparture"),
              "warning",
            );
            break;
          case "target-changed":
            runtime.notify(
              context,
              runtime.i18n.t("navigationChangedBeforeDeparture"),
              "warning",
            );
            break;
          case "capture-failed":
            runtime.notify(
              context,
              withDetail(
                runtime.i18n.t("sourceCaptureFailed"),
                runtime.i18n.t("captureFailureDetail", {
                  message: committed.message,
                }),
              ),
              "error",
            );
            break;
          case "failed":
            runtime.notify(
              context,
              runtime.i18n.t("navigationPrepareFailed", {
                message: committed.message,
              }),
              "warning",
            );
            break;
        }
        return { cancel: true };
      }
      runtime.transitions.setNavigation({
        sessionId: view.sessionId,
        cwd: view.cwd,
        expectedOldLeafId: view.leafId,
        expectedDestinationId,
        previewSnapshot: committed.snapshot,
        target: committed.target,
      });
      return undefined;
    } catch (error) {
      runtime.notify(
        context,
        runtime.i18n.t("navigationPrepareFailed", {
          message: messageOf(error),
        }),
        "warning",
      );
      return { cancel: true };
    } finally {
      runtime.setStatus(context, undefined);
      runtime.transitions.finish("tree");
    }
  });

  pi.on("session_tree", async (event, context) => {
    const plan = runtime.transitions.takeNavigation();
    const attentionStatus = () =>
      runtime.setStatus(context, runtime.i18n.t("navigationAttentionStatus"));
    let view: SessionView;
    try {
      view = readSessionView(context);
    } catch (error) {
      runtime.notify(
        context,
        runtime.i18n.t("navigationPrepareFailed", {
          message: messageOf(error),
        }),
        "warning",
      );
      attentionStatus();
      return;
    }
    if (!runtime.sessionIsUsable(view)) {
      if (plan !== undefined) attentionStatus();
      return;
    }
    const protectCurrentArrival = async (): Promise<void> => {
      try {
        const protection = await runtime.enqueueWorkspace(
          "tree-arrival-protect",
          () => protectCurrentArrivalInWorkspaceLock(runtime, context),
        );
        if (protection.kind === "unavailable") {
          runtime.notifyCaptureResult(context, false, protection.message);
        }
      } catch (error) {
        runtime.notifyCaptureResult(context, false, messageOf(error));
      }
    };
    if (plan === undefined || !arrivalMatches(plan, event, view)) {
      await protectCurrentArrival();
      runtime.notify(
        context,
        runtime.i18n.t("navigationPlanMismatch"),
        "warning",
      );
      attentionStatus();
      return;
    }
    // Selecting a child user/custom prompt may put text back in the editor
    // while leaving the leaf unchanged. Only the committed event can prove
    // that no summary/label wrapper was appended.
    if (event.newLeafId === event.oldLeafId) {
      runtime.setStatus(context, undefined);
      return;
    }

    let actualAnchor: NodeKey | undefined;
    try {
      actualAnchor = runtime.captureAnchor(view);
      if (
        plan.target.kind === "same-location" &&
        sameNode(actualAnchor, plan.target.node)
      ) {
        if (!runtime.carryAdmission(view, actualAnchor)) {
          await protectCurrentArrival();
          attentionStatus();
        } else {
          runtime.setStatus(context, undefined);
        }
        return;
      }
      runtime.beginAdmission(view);
    } catch (error) {
      await protectCurrentArrival();
      runtime.notifyCaptureResult(context, false, messageOf(error));
      attentionStatus();
      return;
    }

    runtime.setStatus(
      context,
      runtime.i18n.t(
        plan.target.kind === "restore"
          ? "restoringWorkspace"
          : "checkingWorkspace",
      ),
    );
    let initializedCheckpointCommitted = false;
    let mutationStarted = false;
    let mutationOutcome: RestoreOutcome | undefined;
    const execution = await runtime
      .enqueueWorkspace("tree-arrival", async () => {
        if (!stillAt(context, view.sessionId, view.leafId, view.cwd)) {
          return { kind: "location-changed" as const };
        }
        if (!(await runtime.workspaceStillBound(view.cwd))) {
          return { kind: "location-changed" as const };
        }

        if (plan.target.kind === "protected-missing") {
          runtime.protectLocation(view);
          return { kind: "protected" as const };
        }

        const authenticatedRootSummary =
          plan.target.kind === "no-node" &&
          plan.expectedDestinationId === null &&
          event.summaryEntry?.parentId === null &&
          view.entryTypeOf(event.summaryEntry.id) === "branch_summary" &&
          view.parentIdOf(event.summaryEntry.id) === null
            ? {
                sessionId: plan.sessionId,
                entryId: event.summaryEntry.id,
              }
            : undefined;
        const sameLocationSummary =
          plan.target.kind === "same-location" &&
          actualAnchor !== undefined &&
          runtime
            .ancestryIds(view, actualAnchor.entryId)
            .includes(plan.target.node.entryId)
            ? actualAnchor
            : undefined;
        const missingTarget =
          plan.target.kind === "materialize-missing"
            ? plan.target.node
            : (authenticatedRootSummary ?? sameLocationSummary);

        if (plan.target.kind === "no-node" && missingTarget === undefined) {
          if (!runtime.admitLocation(view)) {
            return { kind: "target-changed" as const };
          }
          return { kind: "no-node" as const };
        }

        if (missingTarget !== undefined) {
          // A normal missing destination was authenticated in before_tree.
          // The sole late-bound exception is Pi's explicit summary entry for
          // a null logical destination; a wrapping label never owns state.
          const targetNode = missingTarget;
          if (
            runtime.metadata.isNodeWriteProtected(
              targetNode.sessionId,
              targetNode.entryId,
            )
          ) {
            runtime.protectLocation(view);
            return { kind: "protected" as const };
          }
          if (
            sameLocationSummary === undefined &&
            !runtime.resolutionStillAuthoritative(view, targetNode, undefined)
          ) {
            return { kind: "target-changed" as const };
          }

          let targetCurrent: WorkspaceSnapshot;
          try {
            // This is deliberately a fresh current-policy observation. Host
            // work between before_tree and session_tree belongs to the newly
            // arrived, previously unknown location.
            targetCurrent = await runtime.scanCurrentWorkspace(view.cwd);
          } catch (error) {
            return {
              kind: "scan-incomplete" as const,
              message: messageOf(error),
            };
          }
          if (targetCurrent.problems.length > 0) {
            return {
              kind: "scan-incomplete" as const,
              message: runtime.i18n.formatScanProblems(targetCurrent.problems),
            };
          }
          const preparedTarget = await prepareObservedNodeState(
            runtime.checkpointDeps(),
            targetCurrent,
          );
          if (!preparedTarget.ok) {
            return {
              kind: "capture-failed" as const,
              message: preparedTarget.error.message,
            };
          }
          if (
            !(await runtime.workspaceStillBound(view.cwd)) ||
            !stillAt(context, view.sessionId, view.leafId, view.cwd)
          ) {
            return { kind: "location-changed" as const };
          }
          if (
            runtime.metadata.isNodeWriteProtected(
              targetNode.sessionId,
              targetNode.entryId,
            ) ||
            (sameLocationSummary === undefined &&
              !runtime.resolutionStillAuthoritative(
                view,
                targetNode,
                undefined,
              ))
          ) {
            return { kind: "target-changed" as const };
          }
          const committedTarget = commitPreparedNodeState(
            runtime.checkpointDeps(),
            targetNode,
            preparedTarget.value,
            { treeOid: undefined },
          );
          if (!committedTarget.ok) {
            if (committedTarget.error.kind === "write-protected") {
              runtime.protectLocation(view);
              return { kind: "protected" as const };
            }
            return {
              kind: "capture-failed" as const,
              message: committedTarget.error.message,
            };
          }
          initializedCheckpointCommitted = true;
          try {
            const current = readSessionView(context);
            const currentAnchor = runtime.captureAnchor(current);
            if (
              !runtime.sessionIsUsable(current) ||
              current.sessionId !== view.sessionId ||
              current.sessionFile !== view.sessionFile ||
              current.leafId !== view.leafId ||
              current.cwd !== view.cwd ||
              !sameNode(currentAnchor, actualAnchor)
            ) {
              return checkpointInitializationConflict(
                runtime,
                context,
                "active location changed after checkpoint initialization",
              );
            }
            if (!runtime.admitLocation(current, preparedTarget.value.treeOid)) {
              return checkpointInitializationConflict(
                runtime,
                context,
                "checkpoint admission changed after initialization",
              );
            }
          } catch (error) {
            return checkpointInitializationConflict(runtime, context, error);
          }
          return { kind: "materialized" as const };
        }

        if (
          plan.target.kind === "no-node" ||
          plan.target.kind === "materialize-missing" ||
          plan.target.kind === "same-location"
        ) {
          return { kind: "target-changed" as const };
        }
        const previewSnapshot = plan.previewSnapshot;
        if (previewSnapshot === undefined) {
          return { kind: "target-changed" as const };
        }

        let restoreCurrent: WorkspaceSnapshot;
        try {
          restoreCurrent = await runtime.scanCurrentWorkspaceForScope(
            view.cwd,
            previewSnapshot.scope,
          );
        } catch (error) {
          return {
            kind: "scan-incomplete" as const,
            message: messageOf(error),
          };
        }
        if (restoreCurrent.problems.length > 0) {
          return {
            kind: "scan-incomplete" as const,
            message: runtime.i18n.formatScanProblems(restoreCurrent.problems),
          };
        }
        if (restoreCurrent.rootPath !== previewSnapshot.rootPath) {
          return {
            kind: "location-changed" as const,
          };
        }
        const gap = planWorkspaceRestore(
          restoreCurrent,
          workspaceSnapshotAsManifest(previewSnapshot),
        );
        if (gap.problems.length > 0 || restorePlanHasChanges(gap)) {
          return { kind: "preview-stale" as const };
        }
        if (
          !runtime.resolutionStillAuthoritative(
            view,
            plan.target.node,
            plan.target.resolution,
          )
        ) {
          return { kind: "target-changed" as const };
        }
        if (plan.target.kind === "inherit-source") {
          if (!runtime.admitLocation(view, plan.target.resolution.treeOid)) {
            return { kind: "target-changed" as const };
          }
          return { kind: "inherited" as const };
        }
        const restoreResolution = plan.target.resolution;
        let preMutationConflict:
          "location-changed" | "target-changed" | undefined;
        const outcome = await restoreWorkspace(
          runtime.restoreDeps(),
          view.cwd,
          restoreResolution,
          {
            current: restoreCurrent,
            beforeMutation: () => {
              const currentView = readSessionView(context);
              const currentAnchor = runtime.captureAnchor(currentView);
              if (
                !stillAt(context, view.sessionId, view.leafId, view.cwd) ||
                !sameNode(currentAnchor, actualAnchor)
              ) {
                preMutationConflict = "location-changed";
                throw new Error(
                  "navigation target changed before restore mutation",
                );
              }
              if (!runtime.protectLocation(currentView, restoreResolution)) {
                preMutationConflict = "target-changed";
                throw new Error(
                  "navigation checkpoint changed while restore protection was installed",
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
          let currentAnchor: NodeKey | undefined;
          let locationMatches = false;
          try {
            currentView = readSessionView(context);
            currentAnchor = runtime.captureAnchor(currentView);
            locationMatches =
              runtime.sessionIsUsable(currentView) &&
              currentView.sessionId === view.sessionId &&
              currentView.sessionFile === view.sessionFile &&
              currentView.leafId === view.leafId &&
              currentView.cwd === view.cwd &&
              sameNode(currentAnchor, actualAnchor);
          } catch {
            // The shared protection helper reports the actionable failure.
          }
          if (!locationMatches) {
            return {
              kind: "post-mutation-conflict" as const,
              reason: "location-changed" as const,
              outcome,
              arrivalProtection: await protectCurrentArrivalInWorkspaceLock(
                runtime,
                context,
              ),
            };
          }
          if (
            currentView === undefined ||
            currentAnchor === undefined ||
            !runtime.resolutionStillAuthoritative(currentView, currentAnchor, {
              treeOid: restoreResolution.treeOid,
              foundAt: currentAnchor,
            })
          ) {
            return {
              kind: "post-mutation-conflict" as const,
              reason: "target-changed" as const,
              outcome,
              arrivalProtection: await protectCurrentArrivalInWorkspaceLock(
                runtime,
                context,
              ),
            };
          }
          if (outcome.kind !== "restored") {
            return { kind: "outcome" as const, outcome };
          }
          if (!runtime.admitLocation(currentView, restoreResolution.treeOid)) {
            return {
              kind: "post-mutation-conflict" as const,
              reason: "target-changed" as const,
              outcome,
              arrivalProtection: await protectCurrentArrivalInWorkspaceLock(
                runtime,
                context,
              ),
            };
          }
          return { kind: "outcome" as const, outcome };
        }

        if (outcome.kind !== "restored") {
          return { kind: "outcome" as const, outcome };
        }
        return {
          kind: "post-mutation-conflict" as const,
          reason: "target-changed" as const,
          outcome,
          arrivalProtection: await protectCurrentArrivalInWorkspaceLock(
            runtime,
            context,
          ),
        };
      })
      // `async` intentionally normalizes the two helper promises and the
      // immediate pre-mutation failure into one resolved execution union.
      .catch(async (error: unknown) => {
        if (mutationStarted) {
          return postMutationControlFailure(
            runtime,
            context,
            error,
            mutationOutcome,
            "tree-restore-post-failure-protect",
          );
        }
        if (initializedCheckpointCommitted) {
          return checkpointInitializationConflict(
            runtime,
            context,
            error,
            "tree-initialize-post-failure-protect",
          );
        }
        return {
          kind: "failed" as const,
          message: messageOf(error),
        };
      });

    switch (execution.kind) {
      case "initialization-conflict":
        notifyCheckpointInitializationConflict(runtime, context, execution);
        attentionStatus();
        break;
      case "post-mutation-conflict":
        notifyPostMutationConflict(runtime, context, execution);
        attentionStatus();
        break;
      case "location-changed":
        await protectCurrentArrival();
        runtime.notify(
          context,
          runtime.i18n.t("commandLocationChanged"),
          "warning",
        );
        attentionStatus();
        break;
      case "scan-incomplete":
        await protectCurrentArrival();
        runtime.notify(
          context,
          runtime.i18n.t("navigationScanIncomplete", {
            message: execution.message,
          }),
          "warning",
        );
        attentionStatus();
        break;
      case "preview-stale":
        await protectCurrentArrival();
        runtime.notify(
          context,
          runtime.i18n.t("navigationChangedAfterPreview"),
          "warning",
        );
        attentionStatus();
        break;
      case "no-node":
      case "inherited":
      case "materialized":
        runtime.setStatus(context, undefined);
        break;
      case "protected":
        runtime.notify(
          context,
          runtime.i18n.t("sessionMissingProtected"),
          "warning",
        );
        attentionStatus();
        break;
      case "capture-failed":
        await protectCurrentArrival();
        runtime.notifyCaptureResult(context, false, execution.message);
        attentionStatus();
        break;
      case "target-changed":
        await protectCurrentArrival();
        runtime.notify(
          context,
          runtime.i18n.t("commandTargetChanged"),
          "warning",
        );
        attentionStatus();
        break;
      case "failed":
        await protectCurrentArrival();
        runtime.notify(
          context,
          runtime.i18n.t("restoreFailed", { message: execution.message }),
          "error",
        );
        attentionStatus();
        break;
      case "outcome": {
        const restoreNeedsAttention = execution.outcome.kind !== "restored";
        if (restoreNeedsAttention) await protectCurrentArrival();
        notifyRestoreOutcome(runtime, context, execution.outcome, {
          announceSuccess: false,
        });
        if (restoreNeedsAttention) {
          attentionStatus();
        } else {
          runtime.setStatus(context, undefined);
        }
        break;
      }
    }
  });
}
