import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { CaptureSuccess } from "../application/capture.ts";
import type { ResolvedNodeState } from "../application/resolve.ts";
import type { NodeKey } from "../domain/model.ts";
import {
  checkpointSlotsEqual,
  checkpointSlotTreeOid,
  type CheckpointSlot,
} from "../domain/checkpoint-slot.ts";
import {
  planWorkspaceRestore,
  restorePlanHasChanges,
  workspaceSnapshotAsManifest,
} from "../infrastructure/restore-plan.ts";
import { prepareWorkspaceRestorePlan } from "../infrastructure/restore-preparation.ts";
import type { WorkspaceSnapshot } from "../infrastructure/workspace-scan.ts";
import {
  checkpointInitializationDispositionConflict,
  protectCurrentArrivalAfterWorkspaceFailure,
  type CleanupSettlement,
} from "./post-mutation.ts";
import {
  dispositionFromArrivalProtection,
  type ArrivalDisposition,
} from "./arrival-settlement.ts";
import { settleCheckpointInitialization } from "./checkpoint-initialization-protocol.ts";
import {
  requestNavigationChoice,
  type NavigationChoice,
} from "./restore-choice.ts";
import {
  notifyCheckpointInitializationConflict,
  notifyArrivalDispositionFailure,
  notifyPostMutationConflict,
  notifyRestoreProtocolOutcome,
  notifyWorkspaceLockCleanupFailure,
} from "./restore-outcome.ts";
import { CyclotomyRuntime } from "./runtime.ts";
import {
  SessionViewTracker,
  type AuthenticatedTreeArrival,
  type SessionView,
} from "./session-view.ts";
import {
  treeArrivalResult,
  type TreeArrivalExecution,
  type TreeArrivalResult,
} from "./tree-arrival-outcome.ts";
import type { NavigationTargetPlan } from "./navigation-plan.ts";
import {
  WorkspaceMutationProtocol,
  type TreeRestoreProtocolResult,
  type WorkspaceMutationProtocolResult,
} from "./workspace-mutation-protocol.ts";
import { assertNever } from "./assert-never.ts";
import { formatCaptureFailure } from "./capture-failure.ts";
import { messageOfUnknown as messageOf } from "./unknown-error.ts";
import type { PiHostAdapter } from "./pi-host-adapter.ts";

type ClassifiedNavigationTargetKind = Exclude<
  NavigationTargetPlan["kind"],
  "detach"
>;

type NavigationSourceKind = "capture" | "write-protected" | "no-coordinate";

function withDetail(message: string, detail: string): string {
  return `${message} ${detail}`;
}

type SourceBlockReason = "not-admitted" | "changed-before-publication";

function sourceBlockDetail(reason: SourceBlockReason): string {
  switch (reason) {
    case "not-admitted":
      return "source location is not admitted for checkpointing";
    case "changed-before-publication":
      return "source location changed before checkpoint publication";
    default:
      return assertNever(reason, "unhandled source block reason");
  }
}

function readExactLocation(
  runtime: CyclotomyRuntime,
  views: SessionViewTracker,
  context: ExtensionContext,
  expected: SessionView,
): SessionView | undefined {
  const current = views.revalidate(context);
  return runtime.registrations.sessionIsUsable(current) &&
    current.isSameSnapshotAs(expected)
    ? current
    : undefined;
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
  const ancestry = runtime.checkpoints.ancestryEntryIds(view, target.entryId);
  const sourceIndex = ancestry.lastIndexOf(source.entryId);
  if (sourceIndex < 0) return false;
  return ancestry.slice(sourceIndex + 1).every(
    (entryId) =>
      runtime.checkpoints.checkpointSlot({
        sessionId: target.sessionId,
        entryId,
      }).kind === "open-missing",
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
  sourceKind: NavigationSourceKind,
  hasResolution: boolean,
): ClassifiedNavigationTargetKind {
  if (target === undefined) return "no-node";
  if (sameNode(source, target)) return "same-location";
  if (runtime.checkpoints.locationIsBlocked(target)) {
    return hasResolution ? "restore" : "protected-missing";
  }
  if (
    sourceKind === "capture" &&
    targetWillInheritSource(runtime, view, source, target)
  ) {
    return "inherit-source";
  }
  if (hasResolution) return "restore";
  if (sourceKind === "write-protected") {
    return "protected-missing";
  }
  return "materialize-missing";
}

function preparedTargetStillMatches(
  runtime: CyclotomyRuntime,
  view: SessionView,
  source: NodeKey | undefined,
  target: NodeKey | undefined,
  sourceKind: NavigationSourceKind,
  expectedKind: ClassifiedNavigationTargetKind,
  resolution: ResolvedNodeState | undefined,
): boolean {
  const currentKind = classifyTarget(
    runtime,
    view,
    source,
    target,
    sourceKind,
    resolution !== undefined,
  );
  if (currentKind !== expectedKind) return false;
  return (
    target === undefined ||
    currentKind === "inherit-source" ||
    currentKind === "same-location" ||
    (resolution === undefined
      ? runtime.workspaceMutations.locationIsUnresolved(view, target)
      : runtime.workspaceMutations.resolutionStillAuthoritative(
          view,
          target,
          resolution,
        ))
  );
}

/** Register the two-phase Pi tree-navigation protocol. */
export function registerNavigationLifecycle(
  pi: ExtensionAPI,
  runtime: CyclotomyRuntime,
  views: SessionViewTracker,
  host: PiHostAdapter,
): void {
  pi.on(
    "session_before_tree",
    host.guard({
      pass: undefined,
      block: { cancel: true },
      active: async (event, context) => {
        runtime.setStatus(context, undefined);
        let view: SessionView;
        try {
          view = views.revalidate(context);
          runtime.assertSessionUsable(view);
          if (!context.isIdle()) {
            runtime.notify(
              context,
              runtime.i18n.t("transitionInProgress"),
              "warning",
            );
            return { cancel: true };
          }
        } catch (error) {
          runtime.notifyBestEffort(
            context,
            () =>
              runtime.i18n.t("navigationPrepareFailed", {
                message: messageOf(error),
              }),
            "warning",
          );
          return { cancel: true };
        }
        const preparation = await runtime.admission.runTreePreparation(
          async () => {
            try {
              runtime.setStatus(context, runtime.i18n.t("checkingWorkspace"));
              if (!(await runtime.ensureStore(view.cwd))) {
                runtime.notifyInitFailure(context);
                return undefined;
              }
              const authenticated = readExactLocation(
                runtime,
                views,
                context,
                view,
              );
              if (authenticated === undefined) {
                runtime.notify(
                  context,
                  runtime.i18n.t("commandLocationChanged"),
                  "warning",
                );
                return undefined;
              }
              view = authenticated;
              if (
                event.preparation.oldLeafId !== view.leafId ||
                event.preparation.targetId.length === 0
              ) {
                runtime.notify(
                  context,
                  runtime.i18n.t("navigationPlanMismatch"),
                  "warning",
                );
                return undefined;
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
                return undefined;
              }
              const source = runtime.checkpoints.captureAnchor(view);
              const target =
                expectedDestinationId === null
                  ? undefined
                  : runtime.checkpoints.captureAnchor(
                      view,
                      expectedDestinationId,
                    );
              if (expectedDestinationId !== null && target === undefined) {
                runtime.notify(
                  context,
                  runtime.i18n.t("navigationPlanMismatch"),
                  "warning",
                );
                return undefined;
              }

              const preparationExecution = await runtime
                .enqueueWorkspaceExecution("tree-prepare", async () => {
                  const current = readExactLocation(
                    runtime,
                    views,
                    context,
                    view,
                  );
                  if (current === undefined) {
                    return { kind: "location-changed" as const };
                  }
                  const sourceAdmission =
                    runtime.workspaceMutations.captureAdmission(
                      current,
                      source,
                    );
                  if (sourceAdmission.kind === "not-admitted") {
                    return {
                      kind: "source-blocked" as const,
                      reason: "not-admitted" as const,
                    };
                  }
                  let sourceSnapshot: WorkspaceSnapshot | undefined;
                  let sourceExpectedSlot: CheckpointSlot | undefined;
                  let preparedView = current;
                  if (sourceAdmission.kind === "capture") {
                    if (source !== undefined) {
                      sourceExpectedSlot =
                        runtime.checkpoints.checkpointSlot(source);
                    }
                    sourceSnapshot = await runtime.scanCurrentWorkspace(
                      view.cwd,
                    );
                    if (sourceSnapshot.problems.length > 0) {
                      return {
                        kind: "scan-incomplete" as const,
                        problems: sourceSnapshot.problems,
                      };
                    }
                    const observed = readExactLocation(
                      runtime,
                      views,
                      context,
                      view,
                    );
                    if (observed === undefined) {
                      return { kind: "location-changed" as const };
                    }
                    preparedView = observed;
                  }

                  const targetKind = classifyTarget(
                    runtime,
                    preparedView,
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
                      sourceExpectedSlot,
                      restoreSnapshot: undefined,
                      resolution: undefined,
                      targetKind,
                    };
                  }
                  if (target === undefined) {
                    throw new Error("classified navigation target is missing");
                  }
                  const readable = await runtime.resolveReadableTreeIn(
                    preparedView,
                    target,
                  );
                  if (readable === undefined) {
                    const missingKind = classifyTarget(
                      runtime,
                      preparedView,
                      source,
                      target,
                      sourceAdmission.kind,
                      false,
                    );
                    return {
                      kind: "ready" as const,
                      sourceKind: sourceAdmission.kind,
                      sourceSnapshot,
                      sourceExpectedSlot,
                      restoreSnapshot: undefined,
                      resolution: undefined,
                      targetKind: missingKind,
                    };
                  }
                  const { resolution, manifest } = readable;
                  const restoreSnapshot =
                    await runtime.scanCurrentWorkspaceForScope(
                      view.cwd,
                      manifest.scope,
                    );
                  if (restoreSnapshot.problems.length > 0) {
                    return {
                      kind: "scan-incomplete" as const,
                      problems: restoreSnapshot.problems,
                    };
                  }
                  const drift = (
                    await prepareWorkspaceRestorePlan(restoreSnapshot, manifest)
                  ).plan;
                  if (drift.problems.length > 0) {
                    return {
                      kind: "scan-incomplete" as const,
                      problems: drift.problems,
                    };
                  }
                  return {
                    kind: "ready" as const,
                    sourceKind: sourceAdmission.kind,
                    sourceSnapshot,
                    sourceExpectedSlot,
                    restoreSnapshot,
                    resolution,
                    targetKind: "restore" as const,
                    drift,
                  };
                })
                .catch((cause: unknown) => ({
                  kind: "acquisition-failed" as const,
                  cause,
                }));
              if (preparationExecution.kind === "acquisition-failed") {
                runtime.notify(
                  context,
                  runtime.i18n.t("navigationPrepareFailed", {
                    message: messageOf(preparationExecution.cause),
                  }),
                  "warning",
                );
                return undefined;
              }
              notifyWorkspaceLockCleanupFailure(
                runtime,
                context,
                preparationExecution.cleanup.kind === "failed"
                  ? {
                      kind: "failed",
                      cause: preparationExecution.cleanup.cause,
                    }
                  : { kind: "settled" },
              );
              if (preparationExecution.kind === "action-failed") {
                runtime.notify(
                  context,
                  runtime.i18n.t("navigationPrepareFailed", {
                    message: messageOf(preparationExecution.cause),
                  }),
                  "warning",
                );
                return undefined;
              }
              if (preparationExecution.cleanup.kind === "failed") {
                return undefined;
              }
              const prepared = preparationExecution.value;

              if (prepared.kind === "scan-incomplete") {
                runtime.notify(
                  context,
                  runtime.i18n.t("navigationScanIncomplete", {
                    message: runtime.i18n.formatScanProblems(prepared.problems),
                  }),
                  "warning",
                );
                return undefined;
              }
              if (prepared.kind === "location-changed") {
                runtime.notify(
                  context,
                  runtime.i18n.t("commandLocationChanged"),
                  "warning",
                );
                return undefined;
              }
              if (prepared.kind === "source-blocked") {
                runtime.notify(
                  context,
                  withDetail(
                    runtime.i18n.t("sourceCaptureFailed"),
                    runtime.i18n.t("captureFailureDetail", {
                      message: sourceBlockDetail(prepared.reason),
                    }),
                  ),
                  "error",
                );
                return undefined;
              }
              let navigationChoice: NavigationChoice = "restore";
              if (
                prepared.drift !== undefined &&
                restorePlanHasChanges(prepared.drift)
              ) {
                if (!context.hasUI) {
                  runtime.notify(
                    context,
                    runtime.i18n.t("navigationNeedsUi", {
                      preview: runtime.i18n.formatRestorePreview(
                        prepared.drift,
                      ),
                    }),
                    "warning",
                  );
                  return undefined;
                }
                runtime.setStatus(context, undefined);
                try {
                  navigationChoice = await requestNavigationChoice(
                    runtime,
                    context,
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
                  return undefined;
                }
                if (navigationChoice === "stay") {
                  return undefined;
                }
                runtime.setStatus(context, runtime.i18n.t("checkingWorkspace"));
              }
              const commitExecution = await runtime
                .enqueueWorkspaceExecution("tree-commit", async () => {
                  // `isIdle` is used only for its public product meaning: never begin
                  // or publish transition work while Pi is streaming. It is not a
                  // transition mutex and says nothing about whether an older proposal
                  // completed.
                  if (!context.isIdle()) {
                    return { kind: "busy" as const };
                  }
                  const commitView = readExactLocation(
                    runtime,
                    views,
                    context,
                    view,
                  );
                  if (commitView === undefined) {
                    return { kind: "location-changed" as const };
                  }
                  const sourceAdmission =
                    runtime.workspaceMutations.captureAdmission(
                      commitView,
                      source,
                    );
                  if (sourceAdmission.kind === "not-admitted") {
                    return {
                      kind: "source-blocked" as const,
                      reason: "not-admitted" as const,
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
                    if (
                      source === undefined ||
                      prepared.sourceExpectedSlot === undefined
                    ) {
                      return { kind: "target-changed" as const };
                    }
                    if (
                      !checkpointSlotsEqual(
                        runtime.checkpoints.checkpointSlot(source),
                        prepared.sourceExpectedSlot,
                      )
                    ) {
                      return { kind: "target-changed" as const };
                    }
                    sourceCurrent = await runtime.scanCurrentWorkspace(
                      view.cwd,
                    );
                    if (sourceCurrent.problems.length > 0) {
                      return {
                        kind: "scan-incomplete" as const,
                        problems: sourceCurrent.problems,
                      };
                    }
                    if (
                      sourceCurrent.rootPath !==
                      prepared.sourceSnapshot.rootPath
                    ) {
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
                  if (
                    !preparedTargetStillMatches(
                      runtime,
                      commitView,
                      source,
                      target,
                      sourceAdmission.kind,
                      prepared.targetKind,
                      prepared.resolution,
                    )
                  ) {
                    return { kind: "target-changed" as const };
                  }
                  // The preview phase may have crossed an interactive confirmation.
                  // Authenticate the unchanged target closure once more before Pi is
                  // allowed to leave the source location.
                  if (
                    prepared.resolution !== undefined &&
                    prepared.targetKind === "restore"
                  ) {
                    await runtime.store.readTree(prepared.resolution.treeOid);
                  }
                  let restoreCurrent: WorkspaceSnapshot | undefined;
                  if (
                    prepared.targetKind === "restore" &&
                    navigationChoice === "restore"
                  ) {
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
                        problems: restoreCurrent.problems,
                      };
                    }
                    if (
                      restoreCurrent.rootPath !==
                      prepared.restoreSnapshot.rootPath
                    ) {
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
                  } else if (prepared.targetKind === "inherit-source") {
                    if (sourceCurrent === undefined) {
                      return { kind: "target-changed" as const };
                    }
                    restoreCurrent = sourceCurrent;
                  }
                  let preparedSource: CaptureSuccess | undefined;
                  if (
                    sourceAdmission.kind === "capture" &&
                    source !== undefined
                  ) {
                    if (sourceCurrent === undefined) {
                      return { kind: "target-changed" as const };
                    }
                    const currentView = readExactLocation(
                      runtime,
                      views,
                      context,
                      view,
                    );
                    if (
                      currentView === undefined ||
                      !runtime.workspaceMutations.captureLeaseIsCurrent(
                        sourceAdmission.lease,
                        currentView,
                        source,
                      )
                    ) {
                      return {
                        kind: "source-blocked" as const,
                        reason: "changed-before-publication" as const,
                      };
                    }
                    const published =
                      await runtime.checkpoints.prepareObserved(sourceCurrent);
                    if (!published.ok) {
                      return {
                        kind: "capture-failed" as const,
                        failure: published.error,
                      };
                    }
                    preparedSource = published.value;
                    if (
                      !(await runtime.registrations.workspaceStillBound(
                        view.cwd,
                      ))
                    ) {
                      return { kind: "location-changed" as const };
                    }
                    if (!context.isIdle()) return { kind: "busy" as const };
                    const validatedView = readExactLocation(
                      runtime,
                      views,
                      context,
                      view,
                    );
                    if (
                      validatedView === undefined ||
                      !runtime.workspaceMutations.captureLeaseIsCurrent(
                        sourceAdmission.lease,
                        validatedView,
                        source,
                      )
                    ) {
                      return { kind: "location-changed" as const };
                    }
                    if (!context.isIdle()) return { kind: "busy" as const };
                    const sourceExpectedSlot = prepared.sourceExpectedSlot;
                    if (sourceExpectedSlot === undefined) {
                      return { kind: "target-changed" as const };
                    }
                    const sourceCommitted = runtime.commitPreparedCapture(
                      validatedView,
                      source,
                      preparedSource,
                      sourceExpectedSlot,
                    );
                    if (!sourceCommitted.ok) {
                      if (sourceCommitted.error.kind === "write-protected") {
                        runtime.workspaceMutations.protectCurrentNode(
                          validatedView,
                          source,
                        );
                      }
                      return {
                        kind: "capture-failed" as const,
                        failure: sourceCommitted.error,
                      };
                    }
                  }
                  if (
                    !(await runtime.registrations.workspaceStillBound(view.cwd))
                  ) {
                    return { kind: "location-changed" as const };
                  }
                  if (!context.isIdle()) return { kind: "busy" as const };
                  const departureView = readExactLocation(
                    runtime,
                    views,
                    context,
                    view,
                  );
                  if (departureView === undefined) {
                    return { kind: "location-changed" as const };
                  }
                  if (
                    sourceAdmission.kind === "capture" &&
                    (source === undefined ||
                      !runtime.workspaceMutations.captureLeaseIsCurrent(
                        sourceAdmission.lease,
                        departureView,
                        source,
                      ))
                  ) {
                    return { kind: "location-changed" as const };
                  }
                  if (
                    !preparedTargetStillMatches(
                      runtime,
                      departureView,
                      source,
                      target,
                      sourceAdmission.kind,
                      prepared.targetKind,
                      prepared.resolution,
                    )
                  ) {
                    return { kind: "target-changed" as const };
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
                      targetPlan = {
                        kind: "materialize-missing",
                        node: target,
                      };
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
                      if (
                        target === undefined ||
                        prepared.resolution === undefined
                      ) {
                        return { kind: "target-changed" as const };
                      }
                      targetPlan =
                        navigationChoice === "detach"
                          ? {
                              kind: "detach",
                              node: target,
                              resolution: prepared.resolution,
                            }
                          : {
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
                .catch((cause: unknown) => ({
                  kind: "acquisition-failed" as const,
                  cause,
                }));
              const committed =
                commitExecution.kind === "acquisition-failed"
                  ? ({
                      kind: "failed" as const,
                      cause: commitExecution.cause,
                    } as const)
                  : commitExecution.kind === "action-failed"
                    ? ({
                        kind: "failed" as const,
                        cause: commitExecution.cause,
                      } as const)
                    : commitExecution.value;
              if (commitExecution.kind !== "acquisition-failed") {
                notifyWorkspaceLockCleanupFailure(
                  runtime,
                  context,
                  commitExecution.cleanup.kind === "failed"
                    ? {
                        kind: "failed",
                        cause: commitExecution.cleanup.cause,
                      }
                    : { kind: "settled" },
                );
                // Source publication is already authoritative, but a lock
                // that did not cleanly release is not a sound departure gate.
                if (
                  commitExecution.kind === "completed" &&
                  commitExecution.value.kind === "ready" &&
                  commitExecution.cleanup.kind === "failed"
                ) {
                  return undefined;
                }
              }
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
                        message: runtime.i18n.formatScanProblems(
                          committed.problems,
                        ),
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
                          message: formatCaptureFailure(
                            runtime.i18n,
                            committed.failure,
                          ),
                        }),
                      ),
                      "error",
                    );
                    break;
                  case "source-blocked":
                    runtime.notify(
                      context,
                      withDetail(
                        runtime.i18n.t("sourceCaptureFailed"),
                        runtime.i18n.t("captureFailureDetail", {
                          message: sourceBlockDetail(committed.reason),
                        }),
                      ),
                      "error",
                    );
                    break;
                  case "busy":
                    runtime.notify(
                      context,
                      runtime.i18n.t("transitionInProgress"),
                      "warning",
                    );
                    break;
                  case "failed":
                    runtime.notify(
                      context,
                      runtime.i18n.t("navigationPrepareFailed", {
                        message: messageOf(committed.cause),
                      }),
                      "warning",
                    );
                    break;
                }
                return undefined;
              }
              // Workspace execution resolves through a microtask. Recheck the public
              // streaming boundary after that yield and immediately before publishing
              // the host proposal.
              if (!context.isIdle()) {
                runtime.notify(
                  context,
                  runtime.i18n.t("transitionInProgress"),
                  "warning",
                );
                return undefined;
              }
              return {
                sessionId: view.sessionId,
                cwd: view.cwd,
                expectedOldLeafId: view.leafId,
                expectedDestinationId,
                previewSnapshot: committed.snapshot,
                target: committed.target,
              };
            } catch (error) {
              runtime.notifyBestEffort(
                context,
                () =>
                  runtime.i18n.t("navigationPrepareFailed", {
                    message: messageOf(error),
                  }),
                "warning",
              );
              return undefined;
            } finally {
              runtime.setStatus(context, undefined);
            }
          },
        );
        switch (preparation.kind) {
          case "accepted":
            return undefined;
          case "cancelled":
          case "stale":
            return { cancel: true };
          case "busy":
          case "retired-conflict":
          case "closed":
            runtime.notifyBestEffort(
              context,
              () => runtime.i18n.t("transitionInProgress"),
              "warning",
            );
            return { cancel: true };
          default:
            return assertNever(
              preparation,
              "unhandled tree preparation result",
            );
        }
      },
    }),
  );

  pi.on(
    "session_tree",
    host.observe(async (event, context) => {
      const arrival = runtime.admission.beginTreeArrival();
      const plan = arrival.plan;
      const attentionStatus = () =>
        runtime.setStatusBestEffort(context, () =>
          runtime.i18n.t("navigationAttentionStatus"),
        );

      const protectCurrentArrival = async (): Promise<ArrivalDisposition> => {
        const recovery = await protectCurrentArrivalAfterWorkspaceFailure(
          runtime.workspaceMutations,
          context,
        );
        notifyWorkspaceLockCleanupFailure(
          runtime,
          context,
          recovery.workspaceLockCleanup,
        );
        return dispositionFromArrivalProtection(recovery.protection);
      };

      const protectAndAttend = async (
        notify: () => void,
      ): Promise<ArrivalDisposition> => {
        const disposition = await protectCurrentArrival();
        notifyArrivalDispositionFailure(runtime, context, disposition);
        runtime.presentBestEffort(context, notify);
        attentionStatus();
        return disposition;
      };

      const settleCarriedArrival = async (
        view: SessionView,
        node: NodeKey | undefined,
      ): Promise<ArrivalDisposition> => {
        if (runtime.admission.carryArrival(arrival, view, node)) {
          runtime.setStatus(context, undefined);
          return { kind: "admitted" };
        }
        return protectAndAttend(() => undefined);
      };

      let view: SessionView;
      let authenticatedArrival: AuthenticatedTreeArrival;
      let actualAnchor: NodeKey | undefined;
      try {
        view = views.revalidate(context);
        runtime.assertSessionUsable(view);
        const authenticated =
          plan === undefined
            ? undefined
            : view.authenticateTreeArrival(event, plan);
        if (plan === undefined || authenticated === undefined) {
          await protectAndAttend(() =>
            runtime.notify(
              context,
              runtime.i18n.t("navigationPlanMismatch"),
              "warning",
            ),
          );
          return;
        }
        authenticatedArrival = authenticated;
        actualAnchor = runtime.checkpoints.captureAnchor(view);
        if (!context.isIdle()) {
          await protectAndAttend(() =>
            runtime.notify(
              context,
              runtime.i18n.t("transitionInProgress"),
              "warning",
            ),
          );
          return;
        }
        // A no-move event is still an arrival authority handoff: carry only
        // after the immutable graph proves the exact stable source survived.
        if (event.newLeafId === event.oldLeafId) {
          await settleCarriedArrival(view, actualAnchor);
          return;
        }
        if (
          plan.target.kind === "same-location" &&
          sameNode(actualAnchor, plan.target.node)
        ) {
          await settleCarriedArrival(view, actualAnchor);
          return;
        }
      } catch (error) {
        await protectAndAttend(() =>
          runtime.notify(
            context,
            runtime.i18n.t("navigationPrepareFailed", {
              message: messageOf(error),
            }),
            "warning",
          ),
        );
        return;
      }

      runtime.setStatusBestEffort(context, () =>
        runtime.i18n.t(
          plan.target.kind === "restore"
            ? "restoringWorkspace"
            : "checkingWorkspace",
        ),
      );
      const mutationProtocol = new WorkspaceMutationProtocol(
        runtime.workspaceMutations,
        context,
        () => views.revalidate(context),
      );
      let mutationResult: WorkspaceMutationProtocolResult | undefined;
      let mutationArrival: ArrivalDisposition | undefined;
      let workspaceLockCleanup: CleanupSettlement = { kind: "settled" };
      const recoveredTreeExecution = (
        recovered: WorkspaceMutationProtocolResult | undefined,
        cause: unknown,
      ):
        | (TreeArrivalExecution & { readonly arrival?: ArrivalDisposition })
        | TreeRestoreProtocolResult => {
        if (recovered?.kind === "post-mutation-conflict") {
          return {
            execution: recovered,
            arrival: dispositionFromArrivalProtection(
              recovered.arrivalProtection,
            ),
          };
        }
        if (recovered !== undefined && mutationArrival !== undefined) {
          return { execution: recovered, arrival: mutationArrival };
        }
        return recovered ?? { kind: "failed", cause };
      };
      const executionWithArrival:
        | (TreeArrivalExecution & { readonly arrival?: ArrivalDisposition })
        | TreeRestoreProtocolResult = await runtime
        .enqueueWorkspaceExecution("tree-arrival", async () => {
          if (!(await runtime.registrations.workspaceStillBound(view.cwd))) {
            return { kind: "location-changed" as const };
          }
          const arrivalView = readExactLocation(runtime, views, context, view);
          if (arrivalView === undefined) {
            return { kind: "location-changed" as const };
          }
          if (
            !runtime.admission.arrivalCanProceed(
              arrival,
              arrivalView,
              runtime.checkpoints.captureAnchor(arrivalView),
            )
          ) {
            return { kind: "target-changed" as const };
          }
          if (!context.isIdle()) return { kind: "busy" as const };

          if (plan.target.kind === "protected-missing") {
            const disposition =
              runtime.workspaceMutations.protectCurrentTreeArrival(
                arrival,
                arrivalView,
              );
            return disposition.kind === "protected" &&
              runtime.checkpoints.locationIsBlocked(plan.target.node)
              ? {
                  kind: "protected" as const,
                  arrival: disposition,
                }
              : {
                  kind: "target-changed" as const,
                  arrival: disposition,
                };
          }

          if (plan.target.kind === "detach") {
            const authenticatedAnchor =
              runtime.checkpoints.captureAnchor(arrivalView);
            if (
              actualAnchor === undefined ||
              authenticatedAnchor === undefined ||
              !sameNode(authenticatedAnchor, actualAnchor)
            ) {
              return { kind: "target-changed" as const };
            }
            const readable = await runtime.resolveReadableTreeIn(
              arrivalView,
              authenticatedAnchor,
            );
            if (
              readable === undefined ||
              readable.resolution.treeOid !== plan.target.resolution.treeOid ||
              !sameNode(
                readable.resolution.foundAt,
                plan.target.resolution.foundAt,
              )
            ) {
              return { kind: "target-changed" as const };
            }
            if (!(await runtime.registrations.workspaceStillBound(view.cwd))) {
              return { kind: "location-changed" as const };
            }
            const current = readExactLocation(runtime, views, context, view);
            if (current === undefined) {
              return { kind: "location-changed" as const };
            }
            if (!context.isIdle()) return { kind: "busy" as const };
            const currentAnchor = runtime.checkpoints.captureAnchor(current);
            if (!sameNode(currentAnchor, actualAnchor)) {
              return { kind: "location-changed" as const };
            }
            if (
              currentAnchor === undefined ||
              !runtime.workspaceMutations.resolutionStillAuthoritative(
                current,
                currentAnchor,
                readable.resolution,
              )
            ) {
              return { kind: "target-changed" as const };
            }
            const disposition =
              runtime.workspaceMutations.protectTreeArrivalIfResolution(
                arrival,
                current,
                readable.resolution,
              );
            if (disposition.kind !== "protected") {
              return {
                kind: "target-changed" as const,
                arrival: disposition,
              };
            }
            if (
              checkpointSlotTreeOid(
                runtime.checkpoints.checkpointSlot(currentAnchor),
              ) !== readable.resolution.treeOid ||
              !runtime.checkpoints.locationIsBlocked(currentAnchor)
            ) {
              return { kind: "target-changed" as const };
            }
            return {
              kind: "detached" as const,
              arrival: disposition,
            };
          }

          const authenticatedRootSummary =
            plan.target.kind === "no-node" &&
            plan.expectedDestinationId === null &&
            authenticatedArrival.kind === "summary" &&
            authenticatedArrival.summaryParentLandingId === null
              ? {
                  sessionId: plan.sessionId,
                  entryId: authenticatedArrival.summaryEntryId,
                }
              : undefined;
          const sameLocationSummary =
            plan.target.kind === "same-location" &&
            actualAnchor !== undefined &&
            runtime.checkpoints
              .ancestryEntryIds(arrivalView, actualAnchor.entryId)
              .includes(plan.target.node.entryId)
              ? actualAnchor
              : undefined;
          const missingTarget =
            plan.target.kind === "materialize-missing"
              ? plan.target.node
              : (authenticatedRootSummary ?? sameLocationSummary);

          if (plan.target.kind === "no-node" && missingTarget === undefined) {
            const disposition =
              runtime.workspaceMutations.admitCurrentTreeArrival(
                arrival,
                arrivalView,
              );
            return disposition.kind === "admitted"
              ? { kind: "no-node" as const, arrival: disposition }
              : { kind: "target-changed" as const, arrival: disposition };
          }

          if (missingTarget !== undefined) {
            // A normal missing destination was authenticated in before_tree.
            // The sole late-bound exception is Pi's explicit summary entry for
            // a null logical destination; a wrapping label never owns state.
            const targetNode = missingTarget;
            if (runtime.checkpoints.locationIsBlocked(targetNode)) {
              const disposition =
                runtime.workspaceMutations.protectCurrentTreeArrival(
                  arrival,
                  arrivalView,
                );
              return disposition.kind === "protected"
                ? { kind: "protected" as const, arrival: disposition }
                : { kind: "target-changed" as const, arrival: disposition };
            }
            if (
              sameLocationSummary === undefined &&
              !runtime.workspaceMutations.locationIsUnresolved(
                arrivalView,
                targetNode,
              )
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
                kind: "scan-failed" as const,
                cause: error,
              };
            }
            if (targetCurrent.problems.length > 0) {
              return {
                kind: "scan-incomplete" as const,
                problems: targetCurrent.problems,
              };
            }
            const preparedTarget =
              await runtime.checkpoints.prepareObserved(targetCurrent);
            if (!preparedTarget.ok) {
              return {
                kind: "capture-failed" as const,
                failure: preparedTarget.error,
              };
            }
            if (!(await runtime.registrations.workspaceStillBound(view.cwd))) {
              return { kind: "location-changed" as const };
            }
            const current = readExactLocation(runtime, views, context, view);
            if (current === undefined) {
              return { kind: "location-changed" as const };
            }
            if (
              runtime.checkpoints.locationIsBlocked(targetNode) ||
              (sameLocationSummary === undefined &&
                !runtime.workspaceMutations.locationIsUnresolved(
                  current,
                  targetNode,
                ))
            ) {
              return { kind: "target-changed" as const };
            }
            if (!context.isIdle()) return { kind: "busy" as const };
            const committedTarget = runtime.commitTreeArrivalCapture(
              arrival,
              current,
              targetNode,
              preparedTarget.value,
              runtime.checkpoints.checkpointSlot(targetNode),
            );
            if (!committedTarget.ok) {
              if (committedTarget.error.kind === "write-protected") {
                const disposition =
                  runtime.workspaceMutations.protectCurrentTreeArrival(
                    arrival,
                    current,
                  );
                return disposition.kind === "protected"
                  ? { kind: "protected" as const, arrival: disposition }
                  : { kind: "target-changed" as const, arrival: disposition };
              }
              return {
                kind: "capture-failed" as const,
                failure: committedTarget.error,
              };
            }
            const resolution = {
              treeOid: preparedTarget.value.treeOid,
              foundAt: targetNode,
            };
            const arrivalDisposition = await settleCheckpointInitialization(
              {
                readCurrentView: () => views.revalidate(context),
                sessionIsUsable: (candidate) =>
                  runtime.registrations.sessionIsUsable(candidate),
                captureAnchor: (candidate) =>
                  runtime.checkpoints.captureAnchor(candidate),
                protectCommittedArrival: () =>
                  runtime.workspaceMutations.recoverUncertainLocationInWorkspaceLock(
                    context,
                  ),
              },
              {
                expected: view,
                node: targetNode,
                resolution,
                locationMatches: (committedView, node) =>
                  runtime.workspaceMutations.treeArrivalCanProceed(
                    arrival,
                    committedView,
                    node,
                  ),
                admit: (committedView) =>
                  runtime.workspaceMutations.admitTreeArrivalIfResolution(
                    arrival,
                    committedView,
                    resolution,
                  ),
              },
            );
            return arrivalDisposition.kind === "admitted"
              ? {
                  kind: "materialized" as const,
                  arrival: arrivalDisposition,
                }
              : {
                  ...checkpointInitializationDispositionConflict(
                    arrivalDisposition.kind === "unsettled"
                      ? arrivalDisposition.cause
                      : new Error(
                          "checkpoint initialization protected a changed arrival",
                        ),
                    arrivalDisposition,
                  ),
                  arrival: arrivalDisposition,
                };
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
              kind: "scan-failed" as const,
              cause: error,
            };
          }
          if (restoreCurrent.problems.length > 0) {
            return {
              kind: "scan-incomplete" as const,
              problems: restoreCurrent.problems,
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
          const restoredView = readExactLocation(runtime, views, context, view);
          if (restoredView === undefined) {
            return { kind: "location-changed" as const };
          }
          if (
            !runtime.workspaceMutations.resolutionStillAuthoritative(
              restoredView,
              plan.target.node,
              plan.target.resolution,
            )
          ) {
            return { kind: "target-changed" as const };
          }
          if (plan.target.kind === "inherit-source") {
            if (!context.isIdle()) return { kind: "busy" as const };
            const disposition =
              runtime.workspaceMutations.admitTreeArrivalIfResolution(
                arrival,
                restoredView,
                plan.target.resolution,
              );
            return disposition.kind === "admitted"
              ? { kind: "inherited" as const, arrival: disposition }
              : { kind: "target-changed" as const, arrival: disposition };
          }
          const restoreResolution = plan.target.resolution;
          if (actualAnchor === undefined) {
            return { kind: "target-changed" as const };
          }
          const restored = await mutationProtocol.restoreTreeArrival({
            arrival,
            expected: restoredView,
            node: actualAnchor,
            resolution: restoreResolution,
            current: restoreCurrent,
          });
          mutationResult = restored.execution;
          mutationArrival = restored.arrival;
          return restored;
        })
        .then(async (locked) => {
          workspaceLockCleanup =
            locked.cleanup.kind === "failed"
              ? { kind: "failed", cause: locked.cleanup.cause }
              : { kind: "settled" };
          if (locked.kind === "completed") {
            if (
              locked.cleanup.kind !== "failed" ||
              mutationResult === undefined
            ) {
              return locked.value;
            }
            const recovered =
              await mutationProtocol.recoverAfterWorkspaceFailure(
                locked.cleanup.cause,
                mutationResult,
                workspaceLockCleanup,
              );
            return recovered === undefined
              ? locked.value
              : recoveredTreeExecution(recovered, locked.cleanup.cause);
          }

          const recovered = await mutationProtocol.recoverAfterWorkspaceFailure(
            locked.cause,
            mutationResult,
            workspaceLockCleanup,
          );
          return recoveredTreeExecution(recovered, locked.cause);
        })
        // Lock acquisition is the only queue failure without an execution
        // receipt; no action effect can have occurred in that case.
        .catch(async (error: unknown) => {
          const recovered = await mutationProtocol.recoverAfterWorkspaceFailure(
            error,
            mutationResult,
            { kind: "settled" },
          );
          return recoveredTreeExecution(recovered, error);
        });

      const execution: TreeArrivalExecution =
        "execution" in executionWithArrival
          ? executionWithArrival.execution
          : executionWithArrival;
      const settledArrival = executionWithArrival.arrival;
      const arrivalDisposition =
        settledArrival === undefined || settledArrival.kind === "unsettled"
          ? await protectCurrentArrival()
          : settledArrival;
      const result: TreeArrivalResult = treeArrivalResult(
        execution,
        arrivalDisposition,
        workspaceLockCleanup,
      );
      if (
        result.execution.kind !== "initialization-conflict" ||
        (result.arrival.kind === "protected" &&
          result.arrival.evidence.kind === "session-barrier" &&
          result.arrival.evidence.admission.kind === "failed")
      ) {
        notifyArrivalDispositionFailure(runtime, context, result.arrival);
      }
      runtime.presentBestEffort(context, () => {
        switch (result.execution.kind) {
          case "initialization-conflict":
            notifyCheckpointInitializationConflict(
              runtime,
              context,
              result.execution,
            );
            break;
          case "post-mutation-conflict":
            notifyPostMutationConflict(runtime, context, result.execution);
            break;
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
                message: runtime.i18n.formatScanProblems(
                  result.execution.problems,
                ),
              }),
              "warning",
            );
            break;
          case "scan-failed":
            runtime.notify(
              context,
              runtime.i18n.t("navigationScanIncomplete", {
                message: messageOf(result.execution.cause),
              }),
              "warning",
            );
            break;
          case "preview-stale":
            runtime.notify(
              context,
              runtime.i18n.t("navigationChangedAfterPreview"),
              "warning",
            );
            break;
          case "no-node":
          case "inherited":
          case "materialized":
            break;
          case "detached":
            runtime.notify(
              context,
              runtime.i18n.t("navigationDetached"),
              "info",
            );
            break;
          case "protected":
            runtime.notify(
              context,
              runtime.i18n.t("sessionMissingProtected"),
              "warning",
            );
            break;
          case "capture-failed":
            runtime.notifyCaptureResult(
              context,
              false,
              formatCaptureFailure(runtime.i18n, result.execution.failure),
            );
            break;
          case "target-changed":
            runtime.notify(
              context,
              runtime.i18n.t("commandTargetChanged"),
              "warning",
            );
            break;
          case "busy":
            runtime.notify(
              context,
              runtime.i18n.t("transitionInProgress"),
              "warning",
            );
            break;
          case "failed":
            runtime.notify(
              context,
              runtime.i18n.t(
                plan.target.kind === "detach"
                  ? "navigationDetachFailed"
                  : "restoreFailed",
                { message: messageOf(result.execution.cause) },
              ),
              "error",
            );
            break;
          case "outcome":
            notifyRestoreProtocolOutcome(runtime, context, result.execution, {
              announceSuccess: false,
            });
            break;
          default:
            assertNever(result.execution, "unhandled tree-arrival result");
        }
      });
      if (
        result.execution.kind !== "post-mutation-conflict" &&
        result.execution.kind !== "outcome"
      ) {
        notifyWorkspaceLockCleanupFailure(
          runtime,
          context,
          result.workspaceLockCleanup,
        );
      }
      if (
        result.execution.kind === "no-node" ||
        result.execution.kind === "inherited" ||
        result.execution.kind === "materialized" ||
        result.execution.kind === "detached" ||
        (result.execution.kind === "outcome" &&
          result.execution.outcome.kind === "restored")
      ) {
        runtime.setStatus(context, undefined);
      } else {
        attentionStatus();
      }
    }),
  );
}
