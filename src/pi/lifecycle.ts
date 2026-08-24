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
import type { CleanupSettlement } from "../domain/cleanup-settlement.ts";
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
import { sameGitOracleVersion } from "../infrastructure/git-replay-risk.ts";
import type { WorkspaceSnapshot } from "../infrastructure/workspace-scan.ts";
import { applyActiveArrivalSettlement } from "./active-arrival-settlement.ts";
import {
  checkpointInitializationDispositionConflict,
  finalizeArrivalAfterWorkspaceExecution,
  protectCurrentArrivalAfterWorkspaceFailure,
  protectCurrentArrivalInWorkspaceLock,
  restorePreparationConflict,
  type CheckpointInitializationConflict,
  type CheckpointInitializationConflictExecution,
  type PostMutationConflict,
  type RestorePreparationConflict,
} from "./post-mutation.ts";
import {
  locationInitializationAdmission,
  settleCheckpointInitialization,
} from "./checkpoint-initialization-protocol.ts";
import {
  notifyArrivalDispositionFailure,
  notifyCheckpointInitializationConflict,
  notifyPostMutationConflict,
  notifyRestorePreparationConflict,
  notifyRestoreProtocolOutcome,
  notifyWorkspaceLockCleanupFailure,
} from "./restore-notifications.ts";
import { registerNavigationLifecycle } from "./navigation-lifecycle.ts";
import {
  messageEndNeedsSourceCapture,
  sessionStartPolicy,
  type SessionStartPolicy,
} from "./host-event-contract.ts";
import { CyclotomyRuntime } from "./runtime.ts";
import { runConfirmedRestore } from "./confirmed-restore.ts";
import {
  isExactUsableSessionView,
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
import {
  type ArrivalReceipt,
  type LockedArrivalOutcome,
} from "./workspace-receipt.ts";

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
  return isExactUsableSessionView(current, expected, (candidate) =>
    runtime.registrations.sessionIsUsable(candidate),
  )
    ? current
    : undefined;
}

type SourceCaptureFailure =
  | {
      readonly kind: "location-changed";
      readonly phase: "before" | "during";
    }
  | { readonly kind: "not-admitted"; readonly subject: "source" | "turn" }
  | { readonly kind: "workspace-unavailable" }
  | { readonly kind: "capture"; readonly value: CaptureFailure }
  | { readonly kind: "exception"; readonly cause: unknown };

type LoadedInitializationExecution =
  | CheckpointInitializationConflictExecution
  | { readonly kind: "materialized" }
  | { readonly kind: "protected" }
  | { readonly kind: "location-changed" }
  | { readonly kind: "target-changed" }
  | { readonly kind: "capture-failed"; readonly failure: CaptureFailure }
  | { readonly kind: "failed"; readonly cause: unknown };

type LoadedInitializationSettledExecution = Extract<
  LoadedInitializationExecution,
  { readonly kind: "initialization-conflict" | "materialized" | "protected" }
>;

type LoadedInitializationActionResult =
  | LockedArrivalOutcome<LoadedInitializationSettledExecution>
  | Exclude<
      LoadedInitializationExecution,
      LoadedInitializationSettledExecution
    >;

function isLoadedInitializationOutcome(
  value: LoadedInitializationActionResult,
): value is LockedArrivalOutcome<LoadedInitializationSettledExecution> {
  return "execution" in value;
}

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
    case "workspace-unavailable":
      return "workspace storage binding is no longer available";
    case "capture":
      return formatCaptureFailure(runtime.i18n, failure.value);
    case "exception":
      return messageOf(failure.cause);
    default:
      return assertNever(failure, "unhandled source capture failure");
  }
}

function sourceCaptureFailureIsOperational(
  failure: SourceCaptureFailure,
): boolean {
  switch (failure.kind) {
    case "exception":
    case "workspace-unavailable":
      return true;
    case "location-changed":
    case "not-admitted":
      return false;
    case "capture":
      switch (failure.value.kind) {
        case "scan-incomplete":
        case "scan-failed":
        case "publish-failed":
        case "metadata-failed":
          return true;
        case "workspace-changed":
          return failure.value.reason === "root";
        case "state-changed":
        case "write-protected":
          return false;
      }
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
      async (writeAuthority) => {
        const execution = await runCaptureProtocol(
          {
            readCurrentView: () => views.observe(context),
            sessionIsUsable: (current) =>
              runtime.registrations.sessionIsUsable(current),
            captureAnchor: (current, leafId) =>
              runtime.checkpoints.captureAnchor(current, leafId),
            settleCaptureBoundary: (current, node) =>
              runtime.workspaceMutations.settleCaptureBoundary(
                writeAuthority,
                current,
                node,
              ),
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
                writeAuthority,
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
      notifyWorkspaceLockCleanupFailure(runtime, context, execution.cleanup);
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
    case "workspace-unavailable":
      return {
        kind: "failed",
        failure: { kind: "workspace-unavailable" },
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
type ReloadReconciliation =
  | SessionReconciliation
  | typeof RELOAD_PROTECTED
  | typeof RELOAD_PROTECTED_MISSING;

async function recoverLoadedArrival(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
) {
  const recovery = runtime.isActive
    ? await protectCurrentArrivalAfterWorkspaceFailure(
        runtime.workspaceMutations,
        context,
      )
    : await runtime.workspaceMutations.protectCurrentLocationForRetirement(
        context,
      );
  return recovery;
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
    const recovery = await recoverLoadedArrival(runtime, context);
    applyActiveArrivalSettlement(runtime, recovery.arrival);
    notifyArrivalDispositionFailure(runtime, context, recovery.arrival);
    notifyWorkspaceLockCleanupFailure(
      runtime,
      context,
      recovery.workspaceLockCleanup,
    );
    runtime.notifyCaptureResult(context, false, messageOf(cause));
    return recovery.arrival.kind === "protected" &&
      recovery.arrival.evidence.kind === "session-barrier"
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
  let result: Awaited<ReturnType<typeof runConfirmedRestore>>;
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
      { kind: "released" },
    );
  }

  const execution = result.execution;
  const settledResult = "arrival" in result ? result : undefined;
  if (settledResult !== undefined) {
    applyActiveArrivalSettlement(runtime, settledResult.arrival);
  }
  switch (execution.kind) {
    case "initialization-conflict":
      notifyCheckpointInitializationConflict(
        runtime,
        context,
        settledResult as CheckpointInitializationConflict,
      );
      return;
    case "post-mutation-conflict":
      notifyPostMutationConflict(
        runtime,
        context,
        settledResult as PostMutationConflict,
      );
      return;
    case "preparation-conflict":
      notifyRestorePreparationConflict(
        runtime,
        context,
        settledResult as RestorePreparationConflict,
      );
      return;
    case "outcome":
      notifyRestoreProtocolOutcome(runtime, context, {
        execution,
        arrival: settledResult!.arrival,
        workspaceLockCleanup: settledResult!.workspaceLockCleanup,
      });
      return;
  }
  if (settledResult !== undefined) {
    notifyArrivalDispositionFailure(runtime, context, settledResult.arrival);
    notifyWorkspaceLockCleanupFailure(
      runtime,
      context,
      settledResult.workspaceLockCleanup,
    );
  }

  switch (execution.kind) {
    case "missing": {
      const anchor = node;
      const locked = await runtime.enqueueWorkspaceExecution(
        "initialize-missing-session",
        async (writeAuthority): Promise<LoadedInitializationActionResult> => {
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
            writeAuthority,
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
                const arrival = runtime.workspaceMutations.protectCurrentNode(
                  writeAuthority,
                  current,
                  anchor,
                );
                return {
                  execution: { kind: "protected" as const },
                  arrival,
                };
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
                  writeAuthority,
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
                    writeAuthority,
                    candidate,
                    target,
                  ),
                ),
            },
          );
          return arrival.kind === "admitted"
            ? ({
                execution: { kind: "materialized" as const },
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
        },
      );
      const lockCleanup = locked.cleanup;
      let initialized: ArrivalReceipt<LoadedInitializationExecution>;
      if (locked.kind === "completed") {
        if (isLoadedInitializationOutcome(locked.value)) {
          initialized = await finalizeArrivalAfterWorkspaceExecution(
            runtime.workspaceMutations,
            context,
            locked.value,
            lockCleanup,
          );
        } else {
          const recovery = await recoverLoadedArrival(runtime, context);
          initialized = await finalizeArrivalAfterWorkspaceExecution(
            runtime.workspaceMutations,
            context,
            locked.value,
            lockCleanup,
            recovery,
          );
        }
      } else {
        const recovery = await recoverLoadedArrival(runtime, context);
        initialized = await finalizeArrivalAfterWorkspaceExecution(
          runtime.workspaceMutations,
          context,
          { kind: "failed", cause: locked.cause },
          lockCleanup,
          recovery,
        );
      }
      applyActiveArrivalSettlement(runtime, initialized.arrival);
      const initializedExecution = initialized.execution;
      if (initializedExecution.kind !== "initialization-conflict") {
        notifyArrivalDispositionFailure(runtime, context, initialized.arrival);
        notifyWorkspaceLockCleanupFailure(
          runtime,
          context,
          initialized.workspaceLockCleanup,
        );
      }

      switch (initializedExecution.kind) {
        case "initialization-conflict":
          notifyCheckpointInitializationConflict(
            runtime,
            context,
            initialized as CheckpointInitializationConflict,
          );
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
            formatCaptureFailure(runtime.i18n, initializedExecution.failure),
          );
          break;
        case "failed":
          runtime.notifyCaptureResult(
            context,
            false,
            messageOf(initializedExecution.cause),
          );
          break;
        default:
          assertNever(
            initializedExecution,
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
        [
          runtime.i18n.t(
            context.mode === "rpc"
              ? "sessionRestoreDeferredRpc"
              : "sessionRestoreNeedsUi",
          ),
          runtime.i18n.formatGitReplayRisk(execution.replayRisk),
        ]
          .filter((part): part is string => part !== undefined)
          .join("\n\n"),
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
          message: runtime.i18n.formatScanProblems(execution.problems),
        }),
        "warning",
      );
      break;
    case "failed":
      runtime.notify(
        context,
        runtime.i18n.t("restoreFailed", {
          message: messageOf(execution.cause),
        }),
        "warning",
      );
      break;
    case "capture-failed":
      runtime.notify(
        context,
        runtime.i18n.t("restoreFailed", {
          message: formatCaptureFailure(runtime.i18n, execution.failure),
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
    default:
      assertNever(execution, "unhandled loaded-session restore result");
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
    applyActiveArrivalSettlement(runtime, recovery.arrival);
    notifyArrivalDispositionFailure(runtime, context, recovery.arrival);
    notifyWorkspaceLockCleanupFailure(
      runtime,
      context,
      recovery.workspaceLockCleanup,
    );
    runtime.notifyCaptureResult(context, false, messageOf(cause));
    return recovery.arrival.kind === "protected" &&
      recovery.arrival.evidence.kind === "session-barrier"
      ? SESSION_CAPTURE_BARRIER
      : SESSION_RECONCILED;
  }
  const recoverReloadFailure = async (
    error: unknown,
    workspaceLockCleanup: CleanupSettlement = { kind: "settled" },
  ): Promise<ArrivalReceipt<ReloadReconciliation>> => {
    runtime.workspaceMutations.quarantineAdmission();
    const recovery = await protectCurrentArrivalAfterWorkspaceFailure(
      runtime.workspaceMutations,
      context,
    );
    runtime.notifyCaptureResult(context, false, messageOf(error));
    let execution: ReloadReconciliation;
    if (recovery.arrival.kind === "unsettled") {
      execution = SESSION_RECONCILED;
    } else {
      switch (recovery.arrival.evidence.kind) {
        case "exact-slot":
          execution = RELOAD_PROTECTED;
          break;
        case "session-barrier":
          execution = SESSION_CAPTURE_BARRIER;
          break;
        default:
          return assertNever(
            recovery.arrival.evidence,
            "unhandled reload failure protection",
          );
      }
    }
    return finalizeArrivalAfterWorkspaceExecution(
      runtime.workspaceMutations,
      context,
      execution,
      workspaceLockCleanup,
      recovery,
    );
  };
  let receipt: ArrivalReceipt<ReloadReconciliation>;
  try {
    const locked = await runtime.enqueueWorkspaceExecution(
      "reload-reconcile",
      async (
        writeAuthority,
      ): Promise<LockedArrivalOutcome<ReloadReconciliation>> => {
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
        ): Promise<LockedArrivalOutcome<ReloadReconciliation>> => {
          const classifyProtection = (
            arrival: Awaited<
              ReturnType<typeof protectCurrentArrivalInWorkspaceLock>
            >,
          ): LockedArrivalOutcome<ReloadReconciliation> => {
            let execution: ReloadReconciliation;
            if (arrival.kind === "unsettled") {
              execution = SESSION_RECONCILED;
            } else {
              switch (arrival.evidence.kind) {
                case "exact-slot":
                  execution =
                    expectation.kind === "current" &&
                    expectation.state === "missing"
                      ? RELOAD_PROTECTED_MISSING
                      : RELOAD_PROTECTED;
                  break;
                case "session-barrier":
                  execution = SESSION_CAPTURE_BARRIER;
                  break;
                default:
                  return assertNever(
                    arrival.evidence,
                    "unhandled reload arrival protection",
                  );
              }
            }
            return { execution, arrival };
          };
          if (current === undefined) {
            return classifyProtection(
              await protectCurrentArrivalInWorkspaceLock(
                runtime.workspaceMutations,
                writeAuthority,
                context,
              ),
            );
          }
          // A stale inherited pin returns false while still blocking the exact
          // slot. Notification follows the durable fact, not the pin outcome.
          const protection =
            expectation.kind === "exact-resolution"
              ? runtime.workspaceMutations.protectNodeIfResolution(
                  writeAuthority,
                  current,
                  node,
                  expectation.resolution,
                )
              : runtime.workspaceMutations.protectCurrentNode(
                  writeAuthority,
                  current,
                  node,
                );
          if (protection.kind === "unsettled") {
            return classifyProtection(protection);
          }
          if (!runtime.checkpoints.locationIsBlocked(node)) {
            return classifyProtection(
              await protectCurrentArrivalInWorkspaceLock(
                runtime.workspaceMutations,
                writeAuthority,
                context,
              ),
            );
          }
          return classifyProtection(protection);
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
            return {
              execution: SESSION_RECONCILED,
              arrival: { kind: "admitted" },
            };
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
        if (
          !sameGitOracleVersion(
            readable.scopeValidation.gitVersion,
            snapshot.gitOracleVersion,
          )
        ) {
          return protectCurrent(readCurrent(), {
            kind: "exact-resolution",
            resolution: readable.resolution,
          });
        }
        let drift: WorkspaceRestorePlan;
        try {
          drift = (
            await prepareWorkspaceRestorePlan(snapshot, readable.manifest)
          ).plan;
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
            writeAuthority,
            current,
            readable.resolution,
          )
        ) {
          return {
            execution: SESSION_RECONCILED,
            arrival: { kind: "admitted" },
          };
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
      },
    );
    if (locked.kind === "completed") {
      receipt = await finalizeArrivalAfterWorkspaceExecution(
        runtime.workspaceMutations,
        context,
        locked.value,
        locked.cleanup,
      );
    } else {
      receipt = await recoverReloadFailure(locked.cause, locked.cleanup);
    }
  } catch (error) {
    // Acquisition is the only failure without an execution receipt.
    receipt = await recoverReloadFailure(error);
  }
  applyActiveArrivalSettlement(runtime, receipt.arrival);
  notifyArrivalDispositionFailure(runtime, context, receipt.arrival);
  notifyWorkspaceLockCleanupFailure(
    runtime,
    context,
    receipt.workspaceLockCleanup,
  );
  const reconciliation = receipt.execution;
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
        "Cyclotomy could not run this command or show the reason.",
      ),
      exitCode: 1,
      cancelled: false,
      truncated: false,
    },
  } as const;
}

/** Register the complete checkpoint lifecycle. */
export function registerCyclotomyLifecycle(
  pi: Pick<ExtensionAPI, "on">,
  runtime: CyclotomyRuntime,
): void {
  const views = new SessionViewTracker();
  let automaticGcFailureNotified = false;
  const runAutomaticGc = async (context: ExtensionContext): Promise<void> => {
    if (!runtime.isActive) return;
    try {
      const execution = await runtime.maybeRunAutomaticGc();
      notifyWorkspaceLockCleanupFailure(runtime, context, execution.cleanup);
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

  const recoverLifecycleFailure = async (
    context: ExtensionContext,
  ): Promise<void> => {
    const recovery =
      runtime.activation.kind === "active"
        ? await runtime.workspaceMutations.recoverUncertainLocation(context)
        : await runtime.workspaceMutations.protectCurrentLocationForRetirement(
            context,
          );
    applyActiveArrivalSettlement(runtime, recovery.arrival);
    notifyArrivalDispositionFailure(runtime, context, recovery.arrival);
    notifyWorkspaceLockCleanupFailure(
      runtime,
      context,
      recovery.workspaceLockCleanup,
    );
  };

  const withdrawAfterPreparationFailure = async (
    context: ExtensionContext,
    cause: unknown,
  ): Promise<void> => {
    const protection = await runtime.withdrawFromParticipation(context, cause);
    applyActiveArrivalSettlement(runtime, protection.arrival);
    notifyArrivalDispositionFailure(runtime, context, protection.arrival);
    notifyWorkspaceLockCleanupFailure(
      runtime,
      context,
      protection.workspaceLockCleanup,
    );
  };

  const withdrawAfterSourceCaptureFailure = async (
    context: ExtensionContext,
    failure: SourceCaptureFailure,
  ): Promise<boolean> => {
    if (!sourceCaptureFailureIsOperational(failure)) return false;
    const cause = new Error(formatSourceCaptureFailure(runtime, failure));
    await withdrawAfterPreparationFailure(context, cause);
    return true;
  };

  const prepareIdleSessionTransition = async (
    context: ExtensionContext,
  ): Promise<{ readonly cancel: true } | undefined> => {
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
      const preparation = await runtime.admission.runPreparation(async () => {
        if (!(await runtime.ensureStore(view.cwd))) {
          runtime.notifyInitFailure(context);
          return undefined;
        }
        const capture = await captureSourceOrCancel(
          runtime,
          views,
          context,
          view,
          view.leafId,
        );
        if (capture.kind === "failed") {
          return (await withdrawAfterSourceCaptureFailure(
            context,
            capture.failure,
          ))
            ? undefined
            : ({ cancel: true } as const);
        }
        if (
          readExactRegisteredView(runtime, views, context, view) === undefined
        ) {
          runtime.notifyBestEffort(
            context,
            () => runtime.i18n.t("commandLocationChanged"),
            "warning",
          );
          return { cancel: true } as const;
        }
        if (!context.isIdle()) {
          runtime.notify(
            context,
            runtime.i18n.t("transitionInProgress"),
            "warning",
          );
          return { cancel: true } as const;
        }
        return undefined;
      });
      if (preparation.kind !== "completed") {
        if (runtime.activation.kind !== "active") return undefined;
        runtime.notify(
          context,
          runtime.i18n.t("transitionInProgress"),
          "warning",
        );
        return { cancel: true };
      }
      return preparation.value;
    } catch (error) {
      await withdrawAfterPreparationFailure(context, error);
      runtime.notifyBestEffort(
        context,
        () =>
          runtime.i18n.t("navigationPrepareFailed", {
            message: messageOf(error),
          }),
        "warning",
      );
      return undefined;
    }
  };

  const host = new PiHostAdapter({
    activation: () => runtime.activation,
    reportFailure: async (failure, context) => {
      if (failure.stage === "handler" && runtime.activation.kind === "active") {
        if (
          failure.event.type === "input" ||
          failure.event.type === "user_bash" ||
          failure.event.type === "session_before_compact" ||
          failure.event.type === "session_before_tree" ||
          failure.event.type === "session_before_fork" ||
          failure.event.type === "session_before_switch"
        ) {
          await withdrawAfterPreparationFailure(context, failure.cause);
        } else {
          await recoverLifecycleFailure(context);
        }
      } else if (failure.stage === "activation") {
        runtime.markSessionUnavailable(failure.cause);
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
      await withdrawAfterPreparationFailure(context, error);
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
          async (writeAuthority) => {
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
            const settlement = runtime.workspaceMutations.settleCaptureBoundary(
              writeAuthority,
              current,
              currentNode,
            );
            if (settlement.kind === "settlement-failed") {
              throw settlement.cause;
            }
            if (!runtime.checkpoints.locationIsBlocked(currentNode)) {
              throw new Error(
                "session capture barrier was not projected onto the current location",
              );
            }
          },
        );
        notifyWorkspaceLockCleanupFailure(runtime, context, execution.cleanup);
        if (execution.kind === "action-failed") throw execution.cause;
      } catch (error) {
        await recoverLifecycleFailure(context);
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
        await recoverLifecycleFailure(context);
        runtime.notifyCaptureResult(context, false, messageOf(error));
        return;
      }
      if (!(await runtime.ensureStore(view.cwd))) {
        await recoverLifecycleFailure(context);
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
        await recoverLifecycleFailure(context);
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
                return { action: "continue" as const };
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
              if (
                await withdrawAfterSourceCaptureFailure(
                  context,
                  capture.failure,
                )
              ) {
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
            if (runtime.activation.kind !== "active") {
              return { action: "continue" as const };
            }
            runtime.notify(
              context,
              runtime.i18n.t("transitionInProgress"),
              "warning",
            );
            return { action: "handled" as const };
          }
          return preparation.value;
        } catch (error) {
          await withdrawAfterPreparationFailure(context, error);
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
          return { action: "continue" as const };
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
        await recoverLifecycleFailure(context);
        runtime.notifyCaptureResult(context, false, messageOf(error));
        return;
      }
      if (!(await runtime.ensureStore(view.cwd))) {
        await recoverLifecycleFailure(context);
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
        await recoverLifecycleFailure(context);
      }
    }),
  );

  pi.on(
    "user_bash",
    host.guard<UserBashEvent>({
      pass: undefined,
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
            return undefined;
          }
          const capture = await captureSourceOrCancel(
            runtime,
            views,
            context,
            view,
            view.leafId,
          );
          if (capture.kind === "failed") {
            if (
              !(await withdrawAfterSourceCaptureFailure(
                context,
                capture.failure,
              ))
            ) {
              return blockedBashResult(runtime, () =>
                runtime.i18n.t("sourceCaptureFailed"),
              );
            }
            return undefined;
          }
          if (!hadConflict) return undefined;
          return blockedBashResult(runtime, () =>
            runtime.i18n.t("bashWhileBusy"),
          );
        } catch (error) {
          await withdrawAfterPreparationFailure(context, error);
          runtime.notifyCaptureResult(context, false, messageOf(error));
          return undefined;
        }
      },
    }),
  );

  pi.on(
    "session_before_compact",
    host.guard<SessionBeforeCompactEvent>({
      pass: undefined,
      active: async (_event, context) => {
        try {
          const view = views.observe(context);
          runtime.assertSessionUsable(view);
          const preparation = await runtime.admission.runPreparation(
            async () => {
              if (!(await runtime.ensureStore(view.cwd))) {
                runtime.notifyInitFailure(context);
                return undefined;
              }
              const capture = await captureSourceOrCancel(
                runtime,
                views,
                context,
                view,
                view.leafId,
              );
              if (capture.kind === "failed") {
                return (await withdrawAfterSourceCaptureFailure(
                  context,
                  capture.failure,
                ))
                  ? undefined
                  : ({ cancel: true } as const);
              }
              // Automatic threshold/overflow compaction is itself part of an active
              // agent run, so Pi's public `isIdle()` is expected to be false here.
              // The cancellable compaction event plus the exact public snapshot and
              // capture lease are the authority boundary; `isIdle` is not a host
              // transition mutex.
              if (
                readExactRegisteredView(runtime, views, context, view) ===
                undefined
              ) {
                runtime.notifyBestEffort(
                  context,
                  () => runtime.i18n.t("commandLocationChanged"),
                  "warning",
                );
                return { cancel: true } as const;
              }
              return undefined;
            },
          );
          if (preparation.kind !== "completed") {
            if (runtime.activation.kind !== "active") return undefined;
            runtime.notify(
              context,
              runtime.i18n.t("transitionInProgress"),
              "warning",
            );
            return { cancel: true };
          }
          return preparation.value;
        } catch (error) {
          await withdrawAfterPreparationFailure(context, error);
          runtime.notifyBestEffort(
            context,
            () =>
              runtime.i18n.t("navigationPrepareFailed", {
                message: messageOf(error),
              }),
            "warning",
          );
          return undefined;
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
          await recoverLifecycleFailure(context);
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
          await recoverLifecycleFailure(context);
        }
      } catch (error) {
        await recoverLifecycleFailure(context);
        runtime.notifyCaptureResult(context, false, messageOf(error));
      }
    }),
  );

  registerNavigationLifecycle(pi, runtime, views, host);
  pi.on(
    "session_before_fork",
    host.guard<SessionBeforeForkEvent>({
      pass: undefined,
      active: (_event, context) => prepareIdleSessionTransition(context),
    }),
  );

  pi.on(
    "session_before_switch",
    host.guard<SessionBeforeSwitchEvent>({
      pass: undefined,
      active: (_event, context) => prepareIdleSessionTransition(context),
    }),
  );
}
