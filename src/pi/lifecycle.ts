import type {
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  MessageEndEvent,
  SessionBeforeCompactEvent,
  SessionBeforeForkEvent,
  SessionBeforeSwitchEvent,
  SessionCompactEvent,
  TurnEndEvent,
  UserBashEvent,
} from "@earendil-works/pi-coding-agent";

import type { NodeKey } from "../domain/model.ts";
import type { CaptureFailure } from "../application/capture.ts";
import type { ResolvedReadableTree } from "../application/checkpoint-service.ts";
import {
  checkpointSlotIsBlocked,
  checkpointSlotTreeOid,
} from "../domain/checkpoint-slot.ts";
import type { ResolvedNodeState } from "../application/resolve.ts";
import {
  restorePlanHasChanges,
  type WorkspaceRestorePlan,
} from "../infrastructure/restore-plan.ts";
import { prepareWorkspaceRestorePlan } from "../infrastructure/restore-preparation.ts";
import type { WorkspaceSnapshot } from "../infrastructure/workspace-scan.ts";
import {
  checkpointInitializationDispositionConflict,
  protectCurrentArrivalAfterWorkspaceFailure,
  protectCurrentArrivalInWorkspaceLock,
  restorePreparationConflict,
} from "./post-mutation.ts";
import {
  locationInitializationAdmission,
  settleCheckpointInitialization,
} from "./checkpoint-initialization-protocol.ts";
import {
  notifyArrivalProtectionFailure,
  notifyCheckpointInitializationConflict,
  notifyPostMutationConflict,
  notifyRestorePreparationConflict,
  notifyRestoreProtocolOutcome,
  notifyWorkspaceLockCleanupFailure,
} from "./restore-outcome.ts";
import { registerNavigationLifecycle } from "./navigation-lifecycle.ts";
import {
  messageEndNeedsSourceCapture,
  sessionStartPolicy,
  type SessionStartPolicy,
} from "./host-event-contract.ts";
import { CyclotomyRuntime } from "./runtime.ts";
import {
  runConfirmedRestore,
  type ConfirmedRestoreResult,
} from "./confirmed-restore.ts";
import {
  readSessionView,
  SessionViewTracker,
  type SessionView,
} from "./session-view.ts";
import { assertNever } from "./assert-never.ts";
import { formatCaptureFailure } from "./capture-failure.ts";
import {
  runCaptureProtocol,
  type CaptureProtocolResult,
} from "./capture-protocol.ts";
import { PiHostAdapter } from "./pi-host-adapter.ts";
import { messageOfUnknown as messageOf } from "./unknown-error.ts";

function withDetail(message: string, detail: string): string {
  return `${message} ${detail}`;
}

/** Re-authenticate the complete registered Pi snapshot after an async phase. */
function readExactRegisteredView(
  runtime: CyclotomyRuntime,
  views: SessionViewTracker,
  context: ExtensionContext,
  expected: SessionView,
): SessionView | undefined {
  const current = views.observe(context);
  return runtime.registrations.sessionIsUsable(current) &&
    current.isSameSnapshotAs(expected)
    ? current
    : undefined;
}

type SourceCaptureFailure =
  | {
      readonly kind: "location-changed";
      readonly phase: "before" | "during";
    }
  | { readonly kind: "not-admitted"; readonly subject: "source" | "turn" }
  | { readonly kind: "capture"; readonly value: CaptureFailure }
  | { readonly kind: "exception"; readonly cause: unknown };

function formatSourceCaptureFailure(
  runtime: CyclotomyRuntime,
  failure: SourceCaptureFailure,
): string {
  switch (failure.kind) {
    case "location-changed":
      return failure.phase === "before"
        ? "active location changed before source capture"
        : "active location changed during source capture";
    case "not-admitted":
      return `${failure.subject} location is not admitted for checkpointing`;
    case "capture":
      return formatCaptureFailure(runtime.i18n, failure.value);
    case "exception":
      return messageOf(failure.cause);
    default:
      return assertNever(failure, "unhandled source capture failure");
  }
}

async function captureSourceOrCancel(
  runtime: CyclotomyRuntime,
  views: SessionViewTracker,
  context: ExtensionContext,
  view: SessionView,
  entryId: string | null,
  options: {
    readonly subject?: "source" | "turn";
    readonly operation?: string;
    readonly announceFailure?: boolean;
  } = {},
): Promise<
  | { readonly kind: "captured" | "protected" | "no-node" }
  | { readonly kind: "failed"; readonly failure: SourceCaptureFailure }
> {
  const result = await runtime
    .enqueueWorkspaceExecution(
      options.operation ?? "capture-before-transition",
      async () => {
        const execution = await runCaptureProtocol(
          {
            readCurrentView: () => views.observe(context),
            sessionIsUsable: (current) =>
              runtime.registrations.sessionIsUsable(current),
            captureAnchor: (current, leafId) =>
              runtime.checkpoints.captureAnchor(current, leafId),
            captureAdmission: (current, node) =>
              runtime.workspaceMutations.captureAdmission(current, node),
            checkpointSlot: (node) => runtime.checkpoints.checkpointSlot(node),
            prepareCurrent: (current) =>
              runtime.checkpoints.prepareCurrent(current),
            workspaceStillBound: (cwd) =>
              runtime.registrations.workspaceStillBound(cwd),
            captureLeaseIsCurrent: (lease, current, node) =>
              runtime.workspaceMutations.captureLeaseIsCurrent(
                lease,
                current,
                node,
              ),
            commitPrepared: (current, node, prepared, expectedSlot) =>
              runtime.commitPreparedCapture(
                current,
                node,
                prepared,
                expectedSlot,
              ),
          },
          { expected: view, leafId: entryId },
        );
        return sourceCaptureResult(execution, options.subject ?? "source");
      },
    )
    .then((execution) => {
      notifyWorkspaceLockCleanupFailure(
        runtime,
        context,
        execution.cleanup.kind === "failed"
          ? { kind: "failed", cause: execution.cleanup.cause }
          : { kind: "settled" },
      );
      return execution.kind === "completed"
        ? execution.value
        : ({
            kind: "failed" as const,
            failure: {
              kind: "exception" as const,
              cause: execution.cause,
            },
          } as const);
    })
    .catch((error: unknown) => ({
      kind: "failed" as const,
      failure: { kind: "exception" as const, cause: error },
    }));
  if (result.kind === "failed" && options.announceFailure !== false) {
    runtime.notifyBestEffort(
      context,
      () =>
        withDetail(
          runtime.i18n.t("sourceCaptureFailed"),
          runtime.i18n.t("captureFailureDetail", {
            message: formatSourceCaptureFailure(runtime, result.failure),
          }),
        ),
      "error",
    );
  } else if (result.kind === "captured" || result.kind === "no-node") {
    runtime.setStatus(context, undefined);
  }
  return result;
}

function sourceCaptureResult(
  result: CaptureProtocolResult,
  subject: "source" | "turn",
):
  | { readonly kind: "captured" | "protected" | "no-node" }
  | { readonly kind: "failed"; readonly failure: SourceCaptureFailure } {
  switch (result.kind) {
    case "captured":
      return { kind: "captured" };
    case "no-coordinate":
      return { kind: "no-node" };
    case "write-protected":
      return { kind: "protected" };
    case "location-changed":
      return {
        kind: "failed",
        failure: {
          kind: "location-changed",
          phase: result.phase === "before-capture" ? "before" : "during",
        },
      };
    case "not-admitted":
      return {
        kind: "failed",
        failure: { kind: "not-admitted", subject },
      };
    case "capture-failed":
      return {
        kind: "failed",
        failure: { kind: "capture", value: result.failure },
      };
    case "failed":
      return {
        kind: "failed",
        failure: { kind: "exception", cause: result.cause },
      };
    default:
      return assertNever(result, "unhandled capture protocol result");
  }
}

const SESSION_CAPTURE_BARRIER = "session-capture-barrier" as const;
const SESSION_RECONCILED = "reconciled" as const;
const RELOAD_PROTECTED_MISSING = "protected-missing" as const;
const RELOAD_PROTECTED = "reload-protected" as const;
type SessionReconciliation =
  typeof SESSION_RECONCILED | typeof SESSION_CAPTURE_BARRIER;

function loadedRestoreNeedsRecovery(result: ConfirmedRestoreResult): boolean {
  switch (result.kind) {
    case "needs-ui":
    case "cancelled":
    case "location-changed":
    case "target-changed":
    case "preview-stale":
    case "scan-incomplete":
    case "failed":
    case "capture-failed":
      return true;
    case "outcome":
      if (result.cutover.kind === "rejected") return true;
      return (
        result.outcome.kind !== "restored" &&
        result.cutover.kind === "not-requested"
      );
    case "initialization-conflict":
    case "post-mutation-conflict":
    case "preparation-conflict":
    case "missing":
    case "protected-missing":
    case "initialized":
    case "matches":
      return false;
    default:
      return assertNever(result, "unhandled loaded-session settlement");
  }
}

async function recoverLoadedArrival(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
) {
  const recovery = await protectCurrentArrivalAfterWorkspaceFailure(
    runtime.workspaceMutations,
    context,
  );
  notifyArrivalProtectionFailure(runtime, context, recovery.protection);
  notifyWorkspaceLockCleanupFailure(
    runtime,
    context,
    recovery.workspaceLockCleanup,
  );
  return recovery.protection;
}

async function reconcileLoadedSession(
  runtime: CyclotomyRuntime,
  views: SessionViewTracker,
  context: ExtensionContext,
  view: SessionView,
): Promise<SessionReconciliation> {
  let node: NodeKey | undefined;
  try {
    node = runtime.checkpoints.captureAnchor(view);
    if (node === undefined) {
      if (runtime.workspaceMutations.sessionHasBarrier(view) !== false) {
        runtime.workspaceMutations.quarantineAdmission();
        return SESSION_CAPTURE_BARRIER;
      }
      if (!runtime.workspaceMutations.admitCurrentLocation(view)) {
        throw new Error("node-free loaded arrival could not be admitted");
      }
      return SESSION_RECONCILED;
    }
  } catch (cause) {
    const protection = await recoverLoadedArrival(runtime, context);
    runtime.notifyCaptureResult(context, false, messageOf(cause));
    return protection.kind === "session-barrier"
      ? SESSION_CAPTURE_BARRIER
      : SESSION_RECONCILED;
  }
  await reconcileLoadedConcreteSession(runtime, views, context, view, node);
  return SESSION_RECONCILED;
}

async function reconcileLoadedConcreteSession(
  runtime: CyclotomyRuntime,
  views: SessionViewTracker,
  context: ExtensionContext,
  view: SessionView,
  node: NodeKey,
): Promise<void> {
  let result: ConfirmedRestoreResult;
  try {
    result = await runConfirmedRestore(
      runtime,
      context,
      view,
      node,
      "loaded-session",
    );
  } catch (cause) {
    result = await restorePreparationConflict(
      runtime.workspaceMutations,
      context,
      cause,
      "released",
    );
  }

  if (loadedRestoreNeedsRecovery(result)) {
    await recoverLoadedArrival(runtime, context);
  }

  switch (result.kind) {
    case "initialization-conflict":
      notifyCheckpointInitializationConflict(runtime, context, result);
      return;
    case "post-mutation-conflict":
      notifyPostMutationConflict(runtime, context, result);
      return;
    case "preparation-conflict":
      notifyRestorePreparationConflict(runtime, context, result);
      return;
    case "missing": {
      const anchor = node;
      const locked = await runtime.enqueueWorkspaceExecution(
        "initialize-missing-session",
        async () => {
          if (!(await runtime.registrations.workspaceStillBound(view.cwd))) {
            return { kind: "location-changed" as const };
          }
          const observed = readExactRegisteredView(
            runtime,
            views,
            context,
            view,
          );
          if (observed === undefined) {
            return { kind: "location-changed" as const };
          }

          // `missing` may be stale by the time the restore-preparation lock is
          // reacquired. Re-resolve the complete ancestry before publishing a
          // first-observed state; structural errors and unreadable candidates
          // throw and therefore remain fail-closed.
          if (
            (await runtime.resolveReadableTreeIn(observed, anchor)) !==
            undefined
          ) {
            return { kind: "target-changed" as const };
          }
          const prepared = await runtime.checkpoints.prepareCurrent(observed);
          if (!prepared.ok) {
            return {
              kind: "capture-failed" as const,
              failure: prepared.error,
            };
          }
          if (
            !(await runtime.registrations.workspaceStillBound(observed.cwd))
          ) {
            return { kind: "location-changed" as const };
          }
          const current = readExactRegisteredView(
            runtime,
            views,
            context,
            view,
          );
          if (current === undefined) {
            return { kind: "location-changed" as const };
          }
          if (
            !runtime.workspaceMutations.locationIsUnresolved(current, anchor)
          ) {
            return { kind: "target-changed" as const };
          }
          const committed = runtime.commitMissingCapture(
            current,
            anchor,
            prepared.value,
            "initialize-fresh",
          );
          if (!committed.ok) {
            if (committed.error.kind === "state-changed") {
              const currentSlot = runtime.checkpoints.checkpointSlot(anchor);
              if (
                checkpointSlotTreeOid(currentSlot) === undefined &&
                checkpointSlotIsBlocked(currentSlot)
              ) {
                runtime.workspaceMutations.protectCurrentNode(current, anchor);
                return { kind: "protected" as const };
              }
            }
            return {
              kind: "capture-failed" as const,
              failure: committed.error,
            };
          }
          const resolution = {
            treeOid: prepared.value.treeOid,
            foundAt: anchor,
          };
          const arrival = await settleCheckpointInitialization(
            {
              readCurrentView: () => views.observe(context),
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
              node: anchor,
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
            ? ({ kind: "materialized" } as const)
            : checkpointInitializationDispositionConflict(
                arrival.kind === "unsettled"
                  ? arrival.cause
                  : new Error(
                      "checkpoint initialization completed under durable protection",
                    ),
                arrival,
              );
        },
      );
      const initialized =
        locked.kind === "action-failed"
          ? ({
              kind: "failed" as const,
              cause: locked.cause,
            } as const)
          : locked.value;
      notifyWorkspaceLockCleanupFailure(
        runtime,
        context,
        locked.cleanup.kind === "failed"
          ? { kind: "failed", cause: locked.cleanup.cause }
          : { kind: "settled" },
      );

      if (
        initialized.kind === "location-changed" ||
        initialized.kind === "target-changed" ||
        initialized.kind === "capture-failed" ||
        initialized.kind === "failed"
      ) {
        await recoverLoadedArrival(runtime, context);
      }

      switch (initialized.kind) {
        case "initialization-conflict":
          notifyCheckpointInitializationConflict(runtime, context, initialized);
          break;
        case "materialized":
          runtime.notifyCaptureResult(context, true);
          break;
        case "protected":
          runtime.notify(
            context,
            runtime.i18n.t("sessionMissingProtected"),
            "warning",
          );
          break;
        case "location-changed":
          runtime.notify(
            context,
            runtime.i18n.t("commandLocationChanged"),
            "warning",
          );
          break;
        case "target-changed":
          runtime.notify(
            context,
            runtime.i18n.t("commandTargetChanged"),
            "warning",
          );
          break;
        case "capture-failed":
          runtime.notifyCaptureResult(
            context,
            false,
            formatCaptureFailure(runtime.i18n, initialized.failure),
          );
          break;
        case "failed":
          runtime.notifyCaptureResult(
            context,
            false,
            messageOf(initialized.cause),
          );
          break;
        default:
          assertNever(
            initialized,
            "unhandled loaded checkpoint initialization",
          );
      }
      return;
    }
    case "protected-missing":
      runtime.notify(
        context,
        runtime.i18n.t("sessionMissingProtected"),
        "warning",
      );
      return;
    case "initialized":
    case "matches":
      return;
    case "needs-ui":
      runtime.notify(
        context,
        runtime.i18n.t(
          context.mode === "rpc"
            ? "sessionRestoreDeferredRpc"
            : "sessionRestoreNeedsUi",
        ),
        "warning",
      );
      break;
    case "cancelled":
      runtime.notify(
        context,
        runtime.i18n.t("sessionRestoreCancelled"),
        "info",
      );
      break;
    case "scan-incomplete":
      runtime.notify(
        context,
        runtime.i18n.t("restoreScanIncomplete", {
          message: runtime.i18n.formatScanProblems(result.problems),
        }),
        "warning",
      );
      break;
    case "failed":
      runtime.notify(
        context,
        runtime.i18n.t("restoreFailed", { message: messageOf(result.cause) }),
        "warning",
      );
      break;
    case "capture-failed":
      runtime.notify(
        context,
        runtime.i18n.t("restoreFailed", {
          message: formatCaptureFailure(runtime.i18n, result.failure),
        }),
        "warning",
      );
      break;
    case "target-changed":
      runtime.notify(
        context,
        runtime.i18n.t("commandTargetChanged"),
        "warning",
      );
      break;
    case "preview-stale":
      runtime.notify(context, runtime.i18n.t("commandPreviewStale"), "warning");
      break;
    case "location-changed":
      runtime.notify(
        context,
        runtime.i18n.t("commandLocationChanged"),
        "warning",
      );
      break;
    case "outcome":
      notifyRestoreProtocolOutcome(runtime, context, result);
      return;
    default:
      assertNever(result, "unhandled loaded-session restore result");
  }
}

/**
 * Reload only restarts the extension: it neither grants workspace ownership
 * nor clears a session capture barrier. For a concrete location, authenticate
 * the existing checkpoint without capturing, prompting, or restoring; any
 * uncertainty leaves that exact location blocked.
 */
async function reconcileReloadedSession(
  runtime: CyclotomyRuntime,
  views: SessionViewTracker,
  context: ExtensionContext,
  view: SessionView,
): Promise<SessionReconciliation> {
  let node: NodeKey | undefined;
  try {
    node = runtime.checkpoints.captureAnchor(view);
    if (node === undefined) {
      // A node-free public observation cannot materialize a durable session
      // barrier. Keep it intact until a complete concrete ancestry is observed.
      if (runtime.workspaceMutations.sessionHasBarrier(view) !== false) {
        runtime.workspaceMutations.quarantineAdmission();
        return SESSION_CAPTURE_BARRIER;
      }
      if (!runtime.workspaceMutations.admitCurrentLocation(view)) {
        throw new Error("node-free reload arrival could not be admitted");
      }
      return SESSION_RECONCILED;
    }
  } catch (cause) {
    const recovery = await protectCurrentArrivalAfterWorkspaceFailure(
      runtime.workspaceMutations,
      context,
    );
    notifyArrivalProtectionFailure(runtime, context, recovery.protection);
    notifyWorkspaceLockCleanupFailure(
      runtime,
      context,
      recovery.workspaceLockCleanup,
    );
    runtime.notifyCaptureResult(context, false, messageOf(cause));
    return recovery.protection.kind === "session-barrier"
      ? SESSION_CAPTURE_BARRIER
      : SESSION_RECONCILED;
  }
  const recoverReloadFailure = async (
    error: unknown,
  ): Promise<SessionReconciliation | typeof RELOAD_PROTECTED> => {
    runtime.workspaceMutations.quarantineAdmission();
    const recovery = await protectCurrentArrivalAfterWorkspaceFailure(
      runtime.workspaceMutations,
      context,
    );
    notifyArrivalProtectionFailure(runtime, context, recovery.protection);
    notifyWorkspaceLockCleanupFailure(
      runtime,
      context,
      recovery.workspaceLockCleanup,
    );
    runtime.notifyCaptureResult(context, false, messageOf(error));
    switch (recovery.protection.kind) {
      case "exact-slot":
        return RELOAD_PROTECTED;
      case "session-barrier":
        return SESSION_CAPTURE_BARRIER;
      case "unavailable":
        return SESSION_RECONCILED;
      default:
        return assertNever(
          recovery.protection,
          "unhandled reload failure protection",
        );
    }
  };
  const reconciliation = await runtime
    .enqueueWorkspaceExecution("reload-reconcile", async () => {
      const readCurrent = (): SessionView | undefined =>
        readExactRegisteredView(runtime, views, context, view);
      const protectCurrent = async (
        current: SessionView | undefined,
        expectation:
          | {
              readonly kind: "current";
              readonly state: "present" | "missing";
            }
          | {
              readonly kind: "exact-resolution";
              readonly resolution: ResolvedNodeState;
            },
      ): Promise<
        | SessionReconciliation
        | typeof RELOAD_PROTECTED
        | typeof RELOAD_PROTECTED_MISSING
      > => {
        const classifyProtection = (
          recovery: Awaited<
            ReturnType<typeof protectCurrentArrivalInWorkspaceLock>
          >,
        ) => {
          notifyArrivalProtectionFailure(runtime, context, recovery.protection);
          notifyWorkspaceLockCleanupFailure(
            runtime,
            context,
            recovery.workspaceLockCleanup,
          );
          switch (recovery.protection.kind) {
            case "exact-slot":
              return expectation.kind === "current" &&
                expectation.state === "missing"
                ? RELOAD_PROTECTED_MISSING
                : RELOAD_PROTECTED;
            case "session-barrier":
              return SESSION_CAPTURE_BARRIER;
            case "unavailable":
              return SESSION_RECONCILED;
            default:
              return assertNever(
                recovery.protection,
                "unhandled reload arrival protection",
              );
          }
        };
        if (current === undefined) {
          return classifyProtection(
            await protectCurrentArrivalInWorkspaceLock(
              runtime.workspaceMutations,
              context,
            ),
          );
        }
        // A stale inherited pin returns false while still blocking the exact
        // slot. Notification follows the durable fact, not the pin outcome.
        if (expectation.kind === "exact-resolution") {
          runtime.workspaceMutations.protectNodeIfResolution(
            current,
            node,
            expectation.resolution,
          );
        } else {
          runtime.workspaceMutations.protectCurrentNode(current, node);
        }
        if (!runtime.checkpoints.locationIsBlocked(node)) {
          return classifyProtection(
            await protectCurrentArrivalInWorkspaceLock(
              runtime.workspaceMutations,
              context,
            ),
          );
        }
        return expectation.kind === "current" && expectation.state === "missing"
          ? RELOAD_PROTECTED_MISSING
          : RELOAD_PROTECTED;
      };

      if (!(await runtime.registrations.workspaceStillBound(view.cwd))) {
        return protectCurrent(readCurrent(), {
          kind: "current",
          state: "present",
        });
      }
      let current = readCurrent();
      if (current === undefined) {
        return protectCurrent(undefined, {
          kind: "current",
          state: "present",
        });
      }

      let readable: ResolvedReadableTree | undefined;
      try {
        readable = await runtime.resolveReadableTreeIn(current, node);
      } catch {
        return protectCurrent(readCurrent(), {
          kind: "current",
          state: "present",
        });
      }
      current = readCurrent();
      if (current === undefined) {
        return protectCurrent(undefined, {
          kind: "current",
          state: "present",
        });
      }
      if (readable === undefined) {
        if (runtime.checkpoints.locationIsBlocked(node)) {
          return protectCurrent(current, {
            kind: "current",
            state: "missing",
          });
        }
        if (
          runtime.workspaceMutations.locationIsUnresolved(current, node) &&
          runtime.workspaceMutations.admitCurrentLocation(current)
        ) {
          return SESSION_RECONCILED;
        }
        return protectCurrent(current, {
          kind: "current",
          state: "missing",
        });
      }

      let snapshot: WorkspaceSnapshot;
      try {
        snapshot = await runtime.scanCurrentWorkspaceForScope(
          view.cwd,
          readable.manifest.scope,
        );
      } catch {
        return protectCurrent(readCurrent(), {
          kind: "exact-resolution",
          resolution: readable.resolution,
        });
      }
      if (snapshot.problems.length > 0) {
        return protectCurrent(readCurrent(), {
          kind: "exact-resolution",
          resolution: readable.resolution,
        });
      }
      let drift: WorkspaceRestorePlan;
      try {
        drift = (await prepareWorkspaceRestorePlan(snapshot, readable.manifest))
          .plan;
      } catch {
        return protectCurrent(readCurrent(), {
          kind: "exact-resolution",
          resolution: readable.resolution,
        });
      }
      current = readCurrent();
      if (current === undefined) {
        return protectCurrent(undefined, {
          kind: "exact-resolution",
          resolution: readable.resolution,
        });
      }
      const authoritative =
        runtime.workspaceMutations.resolutionStillAuthoritative(
          current,
          node,
          readable.resolution,
        );
      if (
        drift.problems.length === 0 &&
        !restorePlanHasChanges(drift) &&
        authoritative &&
        runtime.workspaceMutations.admitLocationIfResolution(
          current,
          readable.resolution,
        )
      ) {
        return SESSION_RECONCILED;
      }
      return protectCurrent(
        current,
        authoritative
          ? {
              kind: "exact-resolution",
              resolution: readable.resolution,
            }
          : { kind: "current", state: "present" },
      );
    })
    .then(async (execution) => {
      const result =
        execution.kind === "completed"
          ? execution.value
          : await recoverReloadFailure(execution.cause);
      notifyWorkspaceLockCleanupFailure(
        runtime,
        context,
        execution.cleanup.kind === "failed"
          ? { kind: "failed", cause: execution.cleanup.cause }
          : { kind: "settled" },
      );
      return result;
    })
    // Acquisition is the only failure without an execution receipt.
    .catch(recoverReloadFailure);
  if (reconciliation === RELOAD_PROTECTED_MISSING) {
    runtime.notify(
      context,
      runtime.i18n.t("sessionMissingProtected"),
      "warning",
    );
  } else if (reconciliation === RELOAD_PROTECTED) {
    runtime.notify(context, runtime.i18n.t("reloadProtected"), "warning");
  } else if (reconciliation === SESSION_CAPTURE_BARRIER) {
    return SESSION_CAPTURE_BARRIER;
  }
  return SESSION_RECONCILED;
}

function blockedBashResult(runtime: CyclotomyRuntime, render: () => string) {
  return {
    result: {
      output: runtime.renderBestEffort(
        render,
        "Cyclotomy blocked user bash because its safety diagnostic could not be rendered.",
      ),
      exitCode: 1,
      cancelled: false,
      truncated: false,
    },
  } as const;
}

/** Register the complete checkpoint lifecycle. */
export function registerCyclotomyLifecycle(
  pi: ExtensionAPI,
  runtime: CyclotomyRuntime,
): void {
  const views = new SessionViewTracker();
  let automaticGcFailureNotified = false;
  const runAutomaticGc = async (context: ExtensionContext): Promise<void> => {
    try {
      const execution = await runtime.maybeRunAutomaticGc();
      notifyWorkspaceLockCleanupFailure(
        runtime,
        context,
        execution.cleanup.kind === "failed"
          ? { kind: "failed", cause: execution.cleanup.cause }
          : { kind: "settled" },
      );
      if (execution.kind === "action-failed") throw execution.cause;
      automaticGcFailureNotified = false;
    } catch (error) {
      if (automaticGcFailureNotified) return;
      automaticGcFailureNotified = true;
      runtime.notifyBestEffort(
        context,
        () =>
          runtime.i18n.t("automaticGcFailed", { message: messageOf(error) }),
        "warning",
      );
    }
  };

  const recoverNonCancellableFailure = async (
    context: ExtensionContext,
  ): Promise<void> => {
    const recovery =
      await runtime.workspaceMutations.recoverUncertainLocation(context);
    notifyArrivalProtectionFailure(runtime, context, recovery.protection);
    notifyWorkspaceLockCleanupFailure(
      runtime,
      context,
      recovery.workspaceLockCleanup,
    );
  };

  const host = new PiHostAdapter({
    activation: () => runtime.activation,
    reportFailure: async (failure, context) => {
      const cancellable =
        failure.event.type === "input" ||
        failure.event.type === "user_bash" ||
        failure.event.type === "tool_call" ||
        failure.event.type.startsWith("session_before_");
      if (
        failure.stage === "handler" &&
        !cancellable &&
        runtime.activation.kind === "active"
      ) {
        await recoverNonCancellableFailure(context);
      }
      runtime.notifyCaptureResult(context, false, messageOf(failure.cause));
    },
  });

  pi.on("session_start", async (event, context) => {
    runtime.markSessionUnavailable(
      new Error("Pi session registration is in progress"),
    );
    try {
      let startPolicy: SessionStartPolicy;
      try {
        startPolicy = sessionStartPolicy(event.reason);
      } catch (error) {
        runtime.markSessionUnavailable(error);
        runtime.notifyBestEffort(
          context,
          () =>
            runtime.i18n.t("sessionRegistrationFailed", {
              message: messageOf(error),
            }),
          "warning",
        );
        return;
      }
      let view: SessionView;
      try {
        view = views.bootstrap(context);
      } catch (error) {
        runtime.markSessionUnavailable(error);
        runtime.notifyBestEffort(
          context,
          () =>
            runtime.i18n.t("sessionRegistrationFailed", {
              message: messageOf(error),
            }),
          "warning",
        );
        return;
      }
      if (view.sessionFile === null) {
        runtime.markSessionIntentionallyInactive();
        runtime.notifyBestEffort(
          context,
          () => runtime.i18n.t("memorySessionUnsupported"),
          "warning",
        );
        return;
      }
      if (!(await runtime.registrations.sessionOwnsCurrentWorkspace(view))) {
        runtime.markSessionIntentionallyInactive();
        runtime.notifyBestEffort(
          context,
          () => runtime.i18n.t("sessionWorkspaceMismatch"),
          "warning",
        );
        return;
      }
      const preparation = await runtime.registrations
        .prepare(
          view,
          startPolicy.registration === "fork"
            ? {
                kind: "fork",
                ...(event.previousSessionFile === undefined
                  ? {}
                  : { previousSessionFile: event.previousSessionFile }),
              }
            : { kind: "independent" },
        )
        .catch((error: unknown) => {
          runtime.markSessionUnavailable(error);
          runtime.notifyBestEffort(
            context,
            () =>
              runtime.i18n.t("sessionRegistrationFailed", {
                message: messageOf(error),
              }),
            "warning",
          );
          return undefined;
        });
      if (preparation === undefined) return;
      if (!(await runtime.ensureRegistrationStore(view.cwd, preparation))) {
        runtime.markSessionUnavailable(
          new Error("Cyclotomy workspace initialization failed"),
        );
        runtime.notifyInitFailure(context);
        return;
      }
      const registration = await runtime.registrations
        .register(view, () => readSessionView(context), preparation)
        .catch((error: unknown) => {
          runtime.markSessionUnavailable(error);
          runtime.notifyBestEffort(
            context,
            () =>
              runtime.i18n.t(
                view.parentSession.kind === "absent"
                  ? "sessionRegistrationFailed"
                  : "forkImportFailed",
                { message: messageOf(error) },
              ),
            "warning",
          );
          return undefined;
        });
      if (registration === undefined) return;
      if (registration.kind === "durable-but-inactive") {
        runtime.markSessionUnavailable(registration.cause);
        runtime.notifyBestEffort(
          context,
          () =>
            runtime.i18n.t("sessionRegistrationFailed", {
              message: messageOf(registration.cause),
            }),
          "error",
        );
        return;
      }
      runtime.markSessionActive();
      if (registration.advisory !== undefined) {
        notifyWorkspaceLockCleanupFailure(runtime, context, {
          kind: "failed",
          cause: registration.advisory.cause,
        });
      }

      const reconciliation =
        startPolicy.reconciliation === "reloaded"
          ? await reconcileReloadedSession(runtime, views, context, view)
          : await reconcileLoadedSession(runtime, views, context, view);
      const disposition = registration.disposition;
      if (disposition.kind === "quarantined") {
        runtime.notifyBestEffort(
          context,
          () =>
            runtime.i18n.t("forkInheritanceSkipped", {
              message: messageOf(disposition.rejection.cause),
            }),
          "warning",
        );
      }
      if (reconciliation === SESSION_CAPTURE_BARRIER) {
        runtime.notifyBestEffort(
          context,
          () => runtime.i18n.t("sessionCaptureBarrier"),
          "warning",
        );
      }
      await runAutomaticGc(context);
    } catch (error) {
      if (runtime.activation.kind === "active") {
        await recoverNonCancellableFailure(context);
      } else {
        runtime.markSessionUnavailable(error);
      }
      runtime.notifyBestEffort(
        context,
        () =>
          runtime.i18n.t("sessionRegistrationFailed", {
            message: messageOf(error),
          }),
        "error",
      );
    }
  });

  // Any public lifecycle observation with a complete concrete ancestry may
  // project a durable session barrier onto exact slots. No event ordering or
  // persistence timing is inferred here; the observed graph is the authority.
  pi.on(
    "context",
    host.observe<ContextEvent>(async (_event, context) => {
      let view: SessionView;
      try {
        view = views.observe(context);
        runtime.assertSessionUsable(view);
        const node = runtime.checkpoints.captureAnchor(view);
        if (
          node === undefined ||
          runtime.workspaceMutations.sessionHasBarrier(view) !== true
        )
          return;
        if (!(await runtime.ensureStore(view.cwd))) {
          runtime.notifyInitFailure(context);
          return;
        }
        const execution = await runtime.enqueueWorkspaceExecution(
          "project-session-capture-barrier",
          async () => {
            const current = readExactRegisteredView(
              runtime,
              views,
              context,
              view,
            );
            if (current === undefined) return;
            const currentNode = runtime.checkpoints.captureAnchor(current);
            if (
              runtime.workspaceMutations.sessionHasBarrier(current) !== true ||
              currentNode?.sessionId !== node.sessionId ||
              currentNode.entryId !== node.entryId
            ) {
              return;
            }
            runtime.workspaceMutations.captureAdmission(current, currentNode);
            if (!runtime.checkpoints.locationIsBlocked(currentNode)) {
              throw new Error(
                "session capture barrier was not projected onto the current location",
              );
            }
          },
        );
        notifyWorkspaceLockCleanupFailure(
          runtime,
          context,
          execution.cleanup.kind === "failed"
            ? { kind: "failed", cause: execution.cleanup.cause }
            : { kind: "settled" },
        );
        if (execution.kind === "action-failed") throw execution.cause;
      } catch (error) {
        await recoverNonCancellableFailure(context);
        runtime.notifyCaptureResult(context, false, messageOf(error));
      }
    }),
  );

  pi.on(
    "turn_end",
    host.observe<TurnEndEvent>(async (_event, context) => {
      let view: SessionView;
      try {
        view = views.observe(context);
        runtime.assertSessionUsable(view);
      } catch (error) {
        await recoverNonCancellableFailure(context);
        runtime.notifyCaptureResult(context, false, messageOf(error));
        return;
      }
      if (!(await runtime.ensureStore(view.cwd))) {
        await recoverNonCancellableFailure(context);
        runtime.notifyInitFailure(context);
        return;
      }
      const result = await captureSourceOrCancel(
        runtime,
        views,
        context,
        view,
        view.leafId,
        {
          subject: "turn",
          operation: "capture-turn",
          announceFailure: false,
        },
      );
      if (result.kind === "captured") {
        runtime.notifyCaptureResult(context, true);
      } else if (result.kind === "failed") {
        await recoverNonCancellableFailure(context);
        runtime.notifyCaptureResult(
          context,
          false,
          runtime.renderBestEffort(
            () => formatSourceCaptureFailure(runtime, result.failure),
            "checkpoint failure details could not be rendered",
          ),
        );
      }
      // GC runs only after the turn's authoritative checkpoint is durable. Its
      // interval gate makes this cheap; failure is hygiene-only and never turns
      // a successful agent turn into a failed one.
      await runAutomaticGc(context);
    }),
  );

  // Interactive input is a cancellable public boundary. Capture its currently
  // exposed source before allowing the host operation to continue.
  pi.on(
    "input",
    host.guard<InputEvent>({
      pass: { action: "continue" },
      block: { action: "handled" },
      active: async (event, context) => {
        try {
          const boundaryView = views.observe(context);
          runtime.assertSessionUsable(boundaryView);
          if (event.streamingBehavior !== undefined || !context.isIdle()) {
            return { action: "continue" as const };
          }
          const preparation = await runtime.admission.runPreparation(
            async () => {
              const view = views.observe(context);
              runtime.assertSessionUsable(view);
              if (!(await runtime.ensureStore(view.cwd))) {
                runtime.notifyInitFailure(context);
                return { action: "handled" as const };
              }
              const capture = await captureSourceOrCancel(
                runtime,
                views,
                context,
                view,
                view.leafId,
              );
              if (capture.kind !== "failed") {
                return { action: "continue" as const };
              }
              runtime.notify(
                context,
                runtime.i18n.t("inputCaptureFailed"),
                "error",
              );
              return { action: "handled" as const };
            },
          );
          if (preparation.kind !== "completed") {
            runtime.notify(
              context,
              runtime.i18n.t("transitionInProgress"),
              "warning",
            );
            return { action: "handled" as const };
          }
          return preparation.value;
        } catch (error) {
          runtime.notifyBestEffort(
            context,
            () =>
              withDetail(
                runtime.i18n.t("inputCaptureFailed"),
                runtime.i18n.t("captureFailureDetail", {
                  message: messageOf(error),
                }),
              ),
            "error",
          );
          return { action: "handled" as const };
        }
      },
    }),
  );

  // A custom message can bypass the cancellable input hook. Capture only the
  // location exposed by Pi at this public observation; whether the host has
  // already appended the message is deliberately irrelevant.
  pi.on(
    "message_end",
    host.observe<MessageEndEvent>(async (event, context) => {
      let view: SessionView;
      try {
        if (!messageEndNeedsSourceCapture(event.message.role)) return;
        view = views.observe(context);
        runtime.assertSessionUsable(view);
      } catch (error) {
        await recoverNonCancellableFailure(context);
        runtime.notifyCaptureResult(context, false, messageOf(error));
        return;
      }
      if (!(await runtime.ensureStore(view.cwd))) {
        await recoverNonCancellableFailure(context);
        runtime.notifyInitFailure(context);
        return;
      }
      const capture = await captureSourceOrCancel(
        runtime,
        views,
        context,
        view,
        view.leafId,
      );
      if (capture.kind === "failed") {
        await recoverNonCancellableFailure(context);
      }
    }),
  );

  pi.on(
    "user_bash",
    host.guard<UserBashEvent>({
      pass: undefined,
      block: blockedBashResult(runtime, () =>
        runtime.i18n.t("sessionIdentityUnavailable"),
      ),
      active: async (_event, context) => {
        try {
          const view = views.observe(context);
          runtime.assertSessionUsable(view);
          if (!context.isIdle()) {
            return blockedBashResult(runtime, () =>
              runtime.i18n.t("bashWhileBusy"),
            );
          }
          const hadConflict = runtime.admission.rejectTransitionConflict();
          if (!(await runtime.ensureStore(view.cwd))) {
            runtime.notifyInitFailure(context);
            return blockedBashResult(runtime, () =>
              runtime.i18n.t("initFailure"),
            );
          }
          const capture = await captureSourceOrCancel(
            runtime,
            views,
            context,
            view,
            view.leafId,
          );
          if (capture.kind === "failed") {
            await recoverNonCancellableFailure(context);
            return blockedBashResult(runtime, () =>
              runtime.i18n.t("sourceCaptureFailed"),
            );
          }
          if (!hadConflict) return undefined;
          return blockedBashResult(runtime, () =>
            runtime.i18n.t("bashWhileBusy"),
          );
        } catch (error) {
          await recoverNonCancellableFailure(context);
          runtime.notifyCaptureResult(context, false, messageOf(error));
          return blockedBashResult(runtime, () =>
            runtime.i18n.t("sourceCaptureFailed"),
          );
        }
      },
    }),
  );

  pi.on(
    "session_before_compact",
    host.guard<SessionBeforeCompactEvent>({
      pass: undefined,
      block: { cancel: true },
      active: async (_event, context) => {
        try {
          const view = views.observe(context);
          runtime.assertSessionUsable(view);
          const preparation = await runtime.admission.runPreparation(
            async () => {
              if (!(await runtime.ensureStore(view.cwd))) {
                runtime.notifyInitFailure(context);
                return { cancel: true } as const;
              }
              const capture = await captureSourceOrCancel(
                runtime,
                views,
                context,
                view,
                view.leafId,
              );
              if (capture.kind === "failed") return { cancel: true } as const;
              // Automatic threshold/overflow compaction is itself part of an active
              // agent run, so Pi's public `isIdle()` is expected to be false here.
              // The cancellable compaction event plus the exact public snapshot and
              // capture lease are the authority boundary; `isIdle` is not a host
              // transition mutex.
              if (
                readExactRegisteredView(runtime, views, context, view) ===
                undefined
              ) {
                return { cancel: true } as const;
              }
              return undefined;
            },
          );
          if (preparation.kind !== "completed") {
            runtime.notify(
              context,
              runtime.i18n.t("transitionInProgress"),
              "warning",
            );
            return { cancel: true };
          }
          return preparation.value;
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
      },
    }),
  );

  pi.on(
    "session_compact",
    host.observe<SessionCompactEvent>(async (_event, context) => {
      try {
        const view = views.observe(context);
        runtime.assertSessionUsable(view);
        if (!(await runtime.ensureStore(view.cwd))) {
          await recoverNonCancellableFailure(context);
          runtime.notifyInitFailure(context);
          return;
        }
        const capture = await captureSourceOrCancel(
          runtime,
          views,
          context,
          view,
          view.leafId,
        );
        if (capture.kind === "failed") {
          await recoverNonCancellableFailure(context);
        }
      } catch (error) {
        await recoverNonCancellableFailure(context);
        runtime.notifyCaptureResult(context, false, messageOf(error));
      }
    }),
  );

  registerNavigationLifecycle(pi, runtime, views, host);
  pi.on(
    "session_before_fork",
    host.guard<SessionBeforeForkEvent>({
      pass: undefined,
      block: { cancel: true },
      active: async (_event, context) => {
        try {
          const view = views.observe(context);
          runtime.assertSessionUsable(view);
          if (!context.isIdle()) {
            runtime.notify(
              context,
              runtime.i18n.t("transitionInProgress"),
              "warning",
            );
            return { cancel: true };
          }
          const preparation = await runtime.admission.runPreparation(
            async () => {
              if (!(await runtime.ensureStore(view.cwd))) {
                runtime.notifyInitFailure(context);
                return { cancel: true } as const;
              }
              const capture = await captureSourceOrCancel(
                runtime,
                views,
                context,
                view,
                view.leafId,
              );
              if (capture.kind === "failed") return { cancel: true } as const;
              return undefined;
            },
          );
          if (preparation.kind !== "completed") {
            runtime.notify(
              context,
              runtime.i18n.t("transitionInProgress"),
              "warning",
            );
            return { cancel: true };
          }
          return preparation.value;
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
      },
    }),
  );

  pi.on(
    "session_before_switch",
    host.guard<SessionBeforeSwitchEvent>({
      pass: undefined,
      block: { cancel: true },
      active: async (_event, context) => {
        try {
          const view = views.observe(context);
          runtime.assertSessionUsable(view);
          if (!context.isIdle()) {
            runtime.notify(
              context,
              runtime.i18n.t("transitionInProgress"),
              "warning",
            );
            return { cancel: true };
          }
          const preparation = await runtime.admission.runPreparation(
            async () => {
              if (!(await runtime.ensureStore(view.cwd))) {
                runtime.notifyInitFailure(context);
                return { cancel: true } as const;
              }
              const capture = await captureSourceOrCancel(
                runtime,
                views,
                context,
                view,
                view.leafId,
              );
              if (capture.kind === "failed") return { cancel: true } as const;
              if (
                readExactRegisteredView(runtime, views, context, view) ===
                undefined
              ) {
                return { cancel: true } as const;
              }
              return undefined;
            },
          );
          if (preparation.kind !== "completed") {
            runtime.notify(
              context,
              runtime.i18n.t("transitionInProgress"),
              "warning",
            );
            return { cancel: true };
          }
          return preparation.value;
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
      },
    }),
  );

  pi.on("session_shutdown", () => {
    runtime.close();
  });
}
