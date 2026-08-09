import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { NodeKey } from "../domain/model.ts";
import type { ResolvedNodeState } from "../application/resolve.ts";
import {
  restorePlanHasChanges,
  type WorkspaceRestorePlan,
} from "../infrastructure/restore-plan.ts";
import { prepareWorkspaceRestorePlan } from "../infrastructure/restore-preparation.ts";
import type { WorkspaceSnapshot } from "../infrastructure/workspace-scan.ts";
import {
  checkpointInitializationConflict,
  protectCurrentArrivalInWorkspaceLock,
} from "./post-mutation.ts";
import {
  notifyCheckpointInitializationConflict,
  notifyPostMutationConflict,
  notifyRestoreOutcome,
} from "./restore-outcome.ts";
import { registerNavigationLifecycle } from "./navigation-lifecycle.ts";
import {
  CyclotomyRuntime,
  messageOf,
  type ResolvedReadableTree,
} from "./runtime.ts";
import { runConfirmedRestore } from "./confirmed-restore.ts";
import { readSessionView, type SessionView } from "./session-view.ts";

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

/** Re-authenticate the complete registered Pi location after an async phase. */
function registeredSessionStillAt(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  expected: SessionView,
): boolean {
  const current = readSessionView(context);
  return (
    runtime.sessionIsUsable(current) &&
    current.sessionId === expected.sessionId &&
    current.sessionFile === expected.sessionFile &&
    current.leafId === expected.leafId &&
    current.cwd === expected.cwd
  );
}

async function captureSourceOrCancel(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  view: SessionView,
  entryId: string | null,
): Promise<
  | { readonly kind: "captured" | "protected" | "no-node" }
  | { readonly kind: "failed"; readonly message: string }
> {
  // Any independent source-capture boundary proves that an unconsumed tree
  // plan is no longer attributable to a future session_tree event. This is a
  // no-op while a before hook is actively preparing its own transition.
  runtime.transitions.retireOrphanedNavigation();
  let detail: string | undefined;
  let node: NodeKey | undefined;
  try {
    node = runtime.captureAnchor(view, entryId);
  } catch (error) {
    detail = messageOf(error);
    runtime.notify(
      context,
      withDetail(
        runtime.i18n.t("sourceCaptureFailed"),
        runtime.i18n.t("captureFailureDetail", { message: detail }),
      ),
      "error",
    );
    return { kind: "failed", message: detail };
  }
  const result = await runtime
    .enqueueWorkspace("capture-before-transition", async () => {
      if (!stillAt(context, view.sessionId, entryId, view.cwd)) {
        return {
          kind: "failed" as const,
          message: "active location changed before source capture",
        };
      }
      const admission = runtime.captureAdmission(view, node);
      if (admission.kind === "no-node") return admission;
      if (admission.kind === "protected") return admission;
      if (admission.kind === "blocked" || node === undefined) {
        return {
          kind: "failed" as const,
          message: "source location is not admitted for checkpointing",
        };
      }
      const expectedTreeOid = runtime.metadata.getState(
        node.sessionId,
        node.entryId,
      )?.treeOid;
      const prepared = await runtime.prepareCaptureResult(view);
      if (!prepared.ok) {
        return {
          kind: "failed" as const,
          message: prepared.error.message,
        };
      }
      const current = readSessionView(context);
      if (
        !stillAt(context, view.sessionId, entryId, view.cwd) ||
        !(await runtime.workspaceStillBound(view.cwd)) ||
        !runtime.captureLeaseIsCurrent(admission.lease, current, node)
      ) {
        return {
          kind: "failed" as const,
          message: "active location changed during source capture",
        };
      }
      const committed = runtime.commitPreparedCapture({
        source: node,
        prepared: prepared.value,
        expectedTreeOid,
      });
      if (!committed.ok) {
        if (committed.error.kind === "write-protected") {
          runtime.protectNode(view, node);
          return { kind: "protected" as const };
        }
        return {
          kind: "failed" as const,
          message: committed.error.message,
        };
      }
      return { kind: "captured" as const };
    })
    .catch((error: unknown) => ({
      kind: "failed" as const,
      message: messageOf(error),
    }));
  if (result.kind === "failed") {
    runtime.notify(
      context,
      withDetail(
        runtime.i18n.t("sourceCaptureFailed"),
        runtime.i18n.t("captureFailureDetail", {
          message: result.message,
        }),
      ),
      "error",
    );
  } else if (result.kind === "captured" || result.kind === "no-node") {
    runtime.setStatus(context, undefined);
  }
  return result;
}

const SESSION_PENDING_NODE_GUARD = "pending-node-guard" as const;
const SESSION_RECONCILED = "reconciled" as const;
const RELOAD_PROTECTED_MISSING = "protected-missing" as const;
const RELOAD_PROTECTED = "reload-protected" as const;
type SessionReconciliation =
  typeof SESSION_RECONCILED | typeof SESSION_PENDING_NODE_GUARD;

async function reconcileLoadedSession(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  view: SessionView,
): Promise<SessionReconciliation> {
  const node = runtime.captureAnchor(view);
  if (node === undefined) {
    if (runtime.pendingNodeGuard(view) !== false) {
      runtime.quarantineAdmission();
      return SESSION_PENDING_NODE_GUARD;
    }
    runtime.admitLocation(view);
    return SESSION_RECONCILED;
  }
  await reconcileLoadedConcreteSession(runtime, context, view, node);
  return SESSION_RECONCILED;
}

async function reconcileLoadedConcreteSession(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  view: SessionView,
  node: NodeKey,
): Promise<void> {
  const result = await runConfirmedRestore(
    runtime,
    context,
    view,
    node,
    "loaded-session",
  );

  switch (result.kind) {
    case "initialization-conflict":
      notifyCheckpointInitializationConflict(runtime, context, result);
      return;
    case "post-mutation-conflict":
      notifyPostMutationConflict(runtime, context, result);
      return;
    case "missing": {
      let anchor: NodeKey | undefined;
      try {
        anchor = runtime.captureAnchor(view);
      } catch (error) {
        runtime.notifyCaptureResult(context, false, messageOf(error));
        return;
      }
      if (anchor === undefined) return;
      let initializedCheckpointCommitted = false;
      const initialized = await runtime
        .enqueueWorkspace("initialize-missing-session", async () => {
          if (
            !stillAt(context, view.sessionId, view.leafId, view.cwd) ||
            !(await runtime.workspaceStillBound(view.cwd))
          ) {
            return { kind: "location-changed" as const };
          }

          // `missing` may be stale by the time the restore-preparation lock is
          // reacquired. Re-resolve the complete ancestry before publishing a
          // first-observed state; structural errors and unreadable candidates
          // throw and therefore remain fail-closed.
          if (
            (await runtime.resolveReadableTreeIn(view, anchor)) !== undefined
          ) {
            return { kind: "target-changed" as const };
          }
          const prepared = await runtime.prepareCaptureResult(view);
          if (!prepared.ok) {
            return {
              kind: "capture-failed" as const,
              message: prepared.error.message,
            };
          }
          if (
            !(await runtime.workspaceStillBound(view.cwd)) ||
            !stillAt(context, view.sessionId, view.leafId, view.cwd)
          ) {
            return { kind: "location-changed" as const };
          }
          if (!runtime.resolutionStillAuthoritative(view, anchor, undefined)) {
            return { kind: "target-changed" as const };
          }
          const committed = runtime.commitPreparedMissingCapture(
            anchor,
            prepared.value,
            "initialize-fresh",
          );
          if (!committed.ok) {
            if (
              committed.error.kind === "state-changed" &&
              runtime.metadata.getState(anchor.sessionId, anchor.entryId) ===
                undefined &&
              runtime.metadata.isNodeWriteProtected(
                anchor.sessionId,
                anchor.entryId,
              )
            ) {
              runtime.protectNode(view, anchor);
              return { kind: "protected" as const };
            }
            return {
              kind: "capture-failed" as const,
              message: committed.error.message,
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
              currentAnchor?.sessionId !== anchor.sessionId ||
              currentAnchor.entryId !== anchor.entryId
            ) {
              return checkpointInitializationConflict(
                runtime,
                context,
                "active location changed after checkpoint initialization",
              );
            }
            if (!runtime.admitLocation(current, prepared.value.treeOid)) {
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
        })
        // `async` normalizes the helper promise and immediate capture failure
        // into the one execution union consumed below.
        .catch(async (error: unknown) =>
          initializedCheckpointCommitted
            ? checkpointInitializationConflict(
                runtime,
                context,
                error,
                "initialize-missing-post-failure-protect",
              )
            : {
                kind: "capture-failed" as const,
                message: messageOf(error),
              },
        );

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
          runtime.notifyCaptureResult(context, false, initialized.message);
          break;
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
          message: result.message,
        }),
        "warning",
      );
      break;
    case "failed":
      runtime.notify(
        context,
        runtime.i18n.t("restoreFailed", { message: result.message }),
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
      notifyRestoreOutcome(runtime, context, result.outcome);
      return;
  }
}

/**
 * Reload preserves the live workspace but cannot trust an absent guard as a
 * cross-runtime handoff (the previous runtime may have been disabled). Match
 * the existing checkpoint without capturing, prompting, or restoring; any
 * uncertainty leaves the node protected.
 */
async function reconcileReloadedSession(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  view: SessionView,
): Promise<SessionReconciliation> {
  const node = runtime.captureAnchor(view);
  if (node === undefined) {
    const reconciled = await runtime.enqueueWorkspace(
      "reload-empty-session",
      async () => {
        if (!registeredSessionStillAt(runtime, context, view)) return false;
        const current = readSessionView(context);
        if (
          runtime.captureAnchor(current) !== undefined ||
          !runtime.clearPendingNodeGuard(current)
        ) {
          return false;
        }
        return runtime.admitLocation(current);
      },
    );
    if (!reconciled) {
      runtime.quarantineAdmission();
      return SESSION_PENDING_NODE_GUARD;
    }
    return SESSION_RECONCILED;
  }

  const reconciliation = await runtime
    .enqueueWorkspace("reload-reconcile", async () => {
      const stillCurrent = (): SessionView | undefined => {
        const current = readSessionView(context);
        if (
          !runtime.sessionIsUsable(current) ||
          current.sessionId !== view.sessionId ||
          current.sessionFile !== view.sessionFile ||
          current.leafId !== view.leafId ||
          current.cwd !== view.cwd
        ) {
          return undefined;
        }
        const anchor = runtime.captureAnchor(current);
        return anchor?.sessionId === node.sessionId &&
          anchor.entryId === node.entryId
          ? current
          : undefined;
      };
      const protectCurrent = async (
        resolution?: ResolvedNodeState,
        missing = false,
      ): Promise<
        | SessionReconciliation
        | typeof RELOAD_PROTECTED
        | typeof RELOAD_PROTECTED_MISSING
      > => {
        const current = stillCurrent();
        if (current === undefined) {
          const protection = await protectCurrentArrivalInWorkspaceLock(
            runtime,
            context,
          );
          if (protection.kind === "protected") return RELOAD_PROTECTED;
          if (protection.kind === "pending-node-guard") {
            return SESSION_PENDING_NODE_GUARD;
          }
          runtime.notifyCaptureResult(context, false, protection.message);
          return SESSION_RECONCILED;
        }
        // A stale inherited pin returns false while still installing the exact
        // guard. Notification follows the durable fact, not the pin outcome.
        runtime.protectNode(current, node, resolution);
        if (
          !runtime.metadata.isNodeWriteProtected(node.sessionId, node.entryId)
        ) {
          return SESSION_RECONCILED;
        }
        return missing ? RELOAD_PROTECTED_MISSING : RELOAD_PROTECTED;
      };

      if (stillCurrent() === undefined) return protectCurrent();
      if (!(await runtime.workspaceStillBound(view.cwd))) {
        return protectCurrent();
      }

      let readable: ResolvedReadableTree | undefined;
      try {
        readable = await runtime.resolveReadableTreeIn(view, node);
      } catch {
        return protectCurrent();
      }
      if (readable === undefined) {
        if (
          runtime.metadata.isNodeWriteProtected(node.sessionId, node.entryId)
        ) {
          return protectCurrent(undefined, true);
        }
        const current = stillCurrent();
        if (
          current !== undefined &&
          runtime.resolutionStillAuthoritative(current, node, undefined) &&
          runtime.admitLocation(current)
        ) {
          return SESSION_RECONCILED;
        }
        return protectCurrent(undefined, true);
      }

      let snapshot: WorkspaceSnapshot;
      try {
        snapshot = await runtime.scanCurrentWorkspaceForScope(
          view.cwd,
          readable.manifest.scope,
        );
      } catch {
        return protectCurrent(readable.resolution);
      }
      if (snapshot.problems.length > 0) {
        return protectCurrent(readable.resolution);
      }
      let drift: WorkspaceRestorePlan;
      try {
        drift = (await prepareWorkspaceRestorePlan(snapshot, readable.manifest))
          .plan;
      } catch {
        return protectCurrent(readable.resolution);
      }
      const current = stillCurrent();
      if (current === undefined) return protectCurrent(readable.resolution);
      const authoritative = runtime.resolutionStillAuthoritative(
        current,
        node,
        readable.resolution,
      );
      if (
        drift.problems.length === 0 &&
        !restorePlanHasChanges(drift) &&
        authoritative &&
        runtime.admitLocation(current, readable.resolution.treeOid)
      ) {
        return SESSION_RECONCILED;
      }
      return protectCurrent(authoritative ? readable.resolution : undefined);
    })
    .catch((error: unknown) => {
      runtime.quarantineAdmission();
      runtime.notifyCaptureResult(context, false, messageOf(error));
      return SESSION_RECONCILED;
    });
  if (reconciliation === RELOAD_PROTECTED_MISSING) {
    runtime.notify(
      context,
      runtime.i18n.t("sessionMissingProtected"),
      "warning",
    );
  } else if (reconciliation === RELOAD_PROTECTED) {
    runtime.notify(context, runtime.i18n.t("reloadProtected"), "warning");
  } else if (reconciliation === SESSION_PENDING_NODE_GUARD) {
    return SESSION_PENDING_NODE_GUARD;
  }
  return SESSION_RECONCILED;
}

function blockedBashResult(message: string) {
  return {
    result: {
      output: message,
      exitCode: 1,
      cancelled: false,
      truncated: false,
    },
  } as const;
}

/** Register the complete single-state lifecycle. */
export function registerCyclotomyLifecycle(
  pi: ExtensionAPI,
  runtime: CyclotomyRuntime,
): void {
  let automaticGcFailureNotified = false;
  const runAutomaticGc = async (context: ExtensionContext): Promise<void> => {
    try {
      await runtime.maybeRunAutomaticGc();
      automaticGcFailureNotified = false;
    } catch (error) {
      if (automaticGcFailureNotified) return;
      automaticGcFailureNotified = true;
      runtime.notify(
        context,
        runtime.i18n.t("automaticGcFailed", { message: messageOf(error) }),
        "warning",
      );
    }
  };

  pi.on("session_start", async (event, context) => {
    runtime.beginSessionRegistration();
    const view = readSessionView(context);
    if (view.sessionFile === null) {
      runtime.notify(
        context,
        runtime.i18n.t("memorySessionUnsupported"),
        "warning",
      );
      return;
    }
    if (!(await runtime.ensureStore(view.cwd))) {
      runtime.notifyInitFailure(context);
      return;
    }
    const registered = await runtime
      .enqueueWorkspace("session-register", async () => {
        runtime.metadata.touchSession(view.sessionId, view.sessionFile!);
        runtime.importForkAncestry(view);
        return true;
      })
      .catch((error: unknown) => {
        runtime.notify(
          context,
          runtime.i18n.t(
            view.parentSessionFile === null
              ? "sessionRegistrationFailed"
              : "forkImportFailed",
            { message: messageOf(error) },
          ),
          "warning",
        );
        return false;
      });
    if (!registered) return;
    runtime.completeSessionRegistration(view);
    try {
      runtime.beginAdmission(view);
    } catch (error) {
      runtime.notifyCaptureResult(context, false, messageOf(error));
      return;
    }

    const reconciliation =
      event.reason === "reload"
        ? await reconcileReloadedSession(runtime, context, view)
        : await reconcileLoadedSession(runtime, context, view);
    if (reconciliation === SESSION_PENDING_NODE_GUARD) {
      runtime.notify(
        context,
        runtime.i18n.t("sessionPendingNodeGuard"),
        "warning",
      );
    }
    await runAutomaticGc(context);
  });

  // A custom trigger can bypass the cancellable input hook and persist its
  // first concrete message before Pi builds provider context. Consume a
  // pending session-level guard at that earliest post-persistence hook. The
  // durable flag remains authoritative if the process stops before this event.
  pi.on("context", async (_event, context) => {
    let view: SessionView;
    try {
      view = readSessionView(context);
      if (!runtime.sessionIsUsable(view)) return;
      const node = runtime.captureAnchor(view);
      if (node === undefined || runtime.pendingNodeGuard(view) !== true) return;
      if (!(await runtime.ensureStore(view.cwd))) {
        runtime.notifyInitFailure(context);
        return;
      }
      await runtime.enqueueWorkspace("protect-pending-node", async () => {
        const current = readSessionView(context);
        const currentNode = runtime.captureAnchor(current);
        if (
          !runtime.sessionIsUsable(current) ||
          runtime.pendingNodeGuard(current) !== true ||
          current.sessionId !== view.sessionId ||
          current.sessionFile !== view.sessionFile ||
          current.cwd !== view.cwd ||
          current.leafId !== view.leafId ||
          currentNode?.sessionId !== node.sessionId ||
          currentNode.entryId !== node.entryId
        ) {
          return;
        }
        runtime.captureAdmission(current, currentNode);
        if (
          !runtime.metadata.isNodeWriteProtected(
            currentNode.sessionId,
            currentNode.entryId,
          )
        ) {
          throw new Error("pending checkpoint guard was not installed");
        }
      });
    } catch (error) {
      runtime.notifyCaptureResult(context, false, messageOf(error));
    }
  });

  pi.on("turn_end", async (_event, context) => {
    let view: SessionView;
    let node: NodeKey | undefined;
    try {
      view = readSessionView(context);
      if (!runtime.sessionIsUsable(view)) return;
      node = runtime.captureAnchor(view);
    } catch (error) {
      runtime.notifyCaptureResult(context, false, messageOf(error));
      return;
    }
    if (node === undefined) return;
    if (!(await runtime.ensureStore(view.cwd))) {
      runtime.notifyInitFailure(context);
      return;
    }
    const result = await runtime
      .enqueueWorkspace("capture-turn", async () => {
        if (!registeredSessionStillAt(runtime, context, view)) {
          return {
            kind: "failed" as const,
            message: "active location changed before turn capture",
          };
        }
        const admission = runtime.captureAdmission(view, node);
        if (admission.kind === "protected") return admission;
        if (admission.kind !== "capture") {
          return {
            kind: "failed" as const,
            message: "turn location is not admitted for checkpointing",
          };
        }
        const expectedTreeOid = runtime.metadata.getState(
          node.sessionId,
          node.entryId,
        )?.treeOid;
        const prepared = await runtime.prepareCaptureResult(view);
        if (!prepared.ok) {
          return {
            kind: "failed" as const,
            message: prepared.error.message,
          };
        }
        const current = readSessionView(context);
        if (
          !(await runtime.workspaceStillBound(view.cwd)) ||
          !registeredSessionStillAt(runtime, context, view) ||
          !runtime.captureLeaseIsCurrent(admission.lease, current, node)
        ) {
          return {
            kind: "failed" as const,
            message: "active location changed during turn capture",
          };
        }
        const committed = runtime.commitPreparedCapture({
          source: node,
          prepared: prepared.value,
          expectedTreeOid,
        });
        if (!committed.ok) {
          if (committed.error.kind === "write-protected") {
            runtime.protectNode(view, node);
            return { kind: "protected" as const };
          }
          return {
            kind: "failed" as const,
            message: committed.error.message,
          };
        }
        runtime.touchCapturedSession(view);
        return { kind: "captured" as const };
      })
      .catch((error: unknown) => ({
        kind: "failed" as const,
        message: messageOf(error),
      }));
    if (result.kind === "captured") {
      runtime.notifyCaptureResult(context, true);
    } else if (result.kind === "failed") {
      runtime.notifyCaptureResult(context, false, result.message);
    }
    // GC runs only after the turn's authoritative checkpoint is durable. Its
    // interval gate makes this cheap; failure is hygiene-only and never turns
    // a successful agent turn into a failed one.
    await runAutomaticGc(context);
  });

  // Idle input is the one cancellable point before Pi appends a new user node.
  // It assigns between-turn manual edits to the source instead of the new turn.
  pi.on("input", async (event, context) => {
    try {
      if (event.streamingBehavior !== undefined || !context.isIdle()) {
        return { action: "continue" as const };
      }
      if (!runtime.transitions.tryBegin("input")) {
        runtime.notify(
          context,
          runtime.i18n.t("transitionInProgress"),
          "warning",
        );
        return { action: "handled" as const };
      }
      try {
        const view = readSessionView(context);
        if (!runtime.sessionIsUsable(view)) {
          return { action: "continue" as const };
        }
        if (!(await runtime.ensureStore(view.cwd))) {
          runtime.notifyInitFailure(context);
          return { action: "handled" as const };
        }
        const capture = await captureSourceOrCancel(
          runtime,
          context,
          view,
          view.leafId,
        );
        if (capture.kind !== "failed" && context.isIdle()) {
          return { action: "continue" as const };
        }
        runtime.notify(context, runtime.i18n.t("inputCaptureFailed"), "error");
        return { action: "handled" as const };
      } finally {
        runtime.transitions.finish("input");
      }
    } catch (error) {
      runtime.notify(
        context,
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
  });

  // sendMessage({ triggerTurn: true }) bypasses input when Pi is idle. A
  // custom message_end is the last observable hook before Pi persists that
  // leaf. Capture the currently active node there. Earlier/later handlers may
  // change which exact bytes are observed, but no post-append state is ever
  // written backward to the parent.
  pi.on("message_end", async (event, context) => {
    if (event.message.role !== "custom") return;
    let view: SessionView;
    try {
      view = readSessionView(context);
      if (!runtime.sessionIsUsable(view)) return;
    } catch (error) {
      runtime.notifyCaptureResult(context, false, messageOf(error));
      return;
    }
    if (!(await runtime.ensureStore(view.cwd))) {
      runtime.notifyInitFailure(context);
      return;
    }
    await captureSourceOrCancel(runtime, context, view, view.leafId);
  });

  pi.on("user_bash", async (_event, context) => {
    try {
      const view = readSessionView(context);
      if (!runtime.sessionIsUsable(view)) return undefined;
      if (!context.isIdle()) {
        return blockedBashResult(runtime.i18n.t("bashWhileBusy"));
      }
      // Pi persists an extension-provided failure as a bash-result leaf. Even
      // when this call merely retires an orphaned transition, source must be
      // captured before returning that failure or the leaf movement would
      // strand the current workspace on the old node.
      const hadConflict = runtime.transitions.rejectConflict();
      if (!(await runtime.ensureStore(view.cwd))) {
        runtime.notifyInitFailure(context);
        return blockedBashResult(runtime.i18n.t("initFailure"));
      }
      const capture = await captureSourceOrCancel(
        runtime,
        context,
        view,
        view.leafId,
      );
      if (capture.kind === "failed" || !context.isIdle()) {
        return blockedBashResult(runtime.i18n.t("sourceCaptureFailed"));
      }
      if (!hadConflict) return undefined;
      return blockedBashResult(runtime.i18n.t("bashWhileBusy"));
    } catch (error) {
      runtime.notifyCaptureResult(context, false, messageOf(error));
      return blockedBashResult(runtime.i18n.t("sourceCaptureFailed"));
    }
  });

  pi.on("session_before_compact", async (_event, context) => {
    let view: SessionView;
    try {
      view = readSessionView(context);
      if (!runtime.sessionIsUsable(view)) return undefined;
      if (!runtime.transitions.tryBegin("compaction")) {
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
      if (!(await runtime.ensureStore(view.cwd))) {
        runtime.notifyInitFailure(context);
        return { cancel: true };
      }
      const capture = await captureSourceOrCancel(
        runtime,
        context,
        view,
        view.leafId,
      );
      if (capture.kind === "failed") return { cancel: true };
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
      runtime.transitions.finish("compaction");
    }
  });

  pi.on("session_compact", async (_event, context) => {
    try {
      const view = readSessionView(context);
      if (!runtime.sessionIsUsable(view)) return;
      if (!(await runtime.ensureStore(view.cwd))) {
        runtime.notifyInitFailure(context);
        return;
      }
      await captureSourceOrCancel(runtime, context, view, view.leafId);
    } catch (error) {
      runtime.notifyCaptureResult(context, false, messageOf(error));
    }
  });

  registerNavigationLifecycle(pi, runtime);
  pi.on("session_before_fork", async (_event, context) => {
    let view: SessionView;
    try {
      view = readSessionView(context);
      if (!runtime.sessionIsUsable(view)) return undefined;
      if (!context.isIdle() || !runtime.transitions.tryBegin("fork")) {
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
      if (!(await runtime.ensureStore(view.cwd))) {
        runtime.notifyInitFailure(context);
        return { cancel: true };
      }
      const capture = await captureSourceOrCancel(
        runtime,
        context,
        view,
        view.leafId,
      );
      if (capture.kind === "failed") return { cancel: true };
      if (
        !context.isIdle() ||
        !stillAt(context, view.sessionId, view.leafId, view.cwd)
      ) {
        return { cancel: true };
      }
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
      runtime.transitions.finish("fork");
    }
  });

  pi.on("session_before_switch", async (_event, context) => {
    let view: SessionView;
    try {
      view = readSessionView(context);
      if (!runtime.sessionIsUsable(view)) return undefined;
      if (!context.isIdle() || !runtime.transitions.tryBegin("switch")) {
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
      if (!(await runtime.ensureStore(view.cwd))) {
        runtime.notifyInitFailure(context);
        return { cancel: true };
      }
      const capture = await captureSourceOrCancel(
        runtime,
        context,
        view,
        view.leafId,
      );
      if (capture.kind === "failed") return { cancel: true };
      if (
        !context.isIdle() ||
        !stillAt(context, view.sessionId, view.leafId, view.cwd)
      ) {
        return { cancel: true };
      }
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
      runtime.transitions.finish("switch");
    }
  });

  pi.on("session_shutdown", () => {
    runtime.close();
  });
}
