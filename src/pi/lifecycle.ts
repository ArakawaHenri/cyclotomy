import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { NodeKey } from "../domain/model.ts";
import { notifyRestoreOutcome } from "./restore-outcome.ts";
import { registerNavigationLifecycle } from "./navigation-lifecycle.ts";
import {
  CyclotomyRuntime,
  messageOf,
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
): Promise<boolean> {
  if (entryId === null) return true;
  let detail: string | undefined;
  let node: NodeKey;
  try {
    const anchor = runtime.captureAnchor(view, entryId);
    if (anchor === undefined) throw new Error("source capture node is missing");
    node = anchor;
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
    return false;
  }
  const captured = await runtime
    .enqueueWorkspace("capture-before-transition", async () => {
      if (!stillAt(context, view.sessionId, entryId, view.cwd)) return false;
      const expectedTreeOid = runtime.metadata.getState(
        node.sessionId,
        node.entryId,
      )?.treeOid;
      const prepared = await runtime.prepareCaptureResult(view);
      if (!prepared.ok) {
        detail = prepared.error.message;
        return false;
      }
      if (
        !stillAt(context, view.sessionId, entryId, view.cwd) ||
        !(await runtime.workspaceStillBound(view.cwd))
      ) {
        detail = "active location changed during source capture";
        return false;
      }
      const committed = await runtime.commitPreparedCapture(
        {
          source: node,
          prepared: prepared.value,
          expectedTreeOid,
        },
      );
      if (!committed.ok) detail = committed.error.message;
      return committed.ok;
    })
    .catch((error: unknown) => {
      detail = messageOf(error);
      return false;
    });
  if (!captured) {
    runtime.notify(
      context,
      withDetail(
        runtime.i18n.t("sourceCaptureFailed"),
        runtime.i18n.t("captureFailureDetail", {
          message: detail ?? "unknown capture failure",
        }),
      ),
      "error",
    );
  } else {
    runtime.setStatus(context, undefined);
  }
  return captured;
}


async function reconcileLoadedSession(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  view: SessionView,
): Promise<void> {
  const node = runtime.currentNode(view);
  if (node === undefined) return;
  const result = await runConfirmedRestore(
    runtime,
    context,
    view,
    node,
    "loaded-session",
  );

  switch (result.kind) {
    case "missing": {
      let anchor: NodeKey | undefined;
      try {
        anchor = runtime.captureAnchor(view);
      } catch (error) {
        runtime.notifyCaptureResult(context, false, messageOf(error));
        return;
      }
      if (anchor === undefined) return;
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
          if (await runtime.resolveReadableTreeIn(view, anchor) !== undefined) {
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
          if (!runtime.resolutionStillAuthoritative(
            view,
            anchor,
            undefined,
          )) {
            return { kind: "target-changed" as const };
          }
          const committed = await runtime.commitPreparedCapture({
            source: anchor,
            prepared: prepared.value,
            expectedTreeOid: undefined,
          });
          return committed.ok
            ? { kind: "materialized" as const }
            : {
                kind: "capture-failed" as const,
                message: committed.error.message,
              };
        })
        .catch((error: unknown) => ({
          kind: "capture-failed" as const,
          message: messageOf(error),
        }));

      switch (initialized.kind) {
        case "materialized":
          runtime.notifyCaptureResult(context, true);
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
            initialized.message,
          );
          break;
      }
      return;
    }
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
      notifyRestoreOutcome(
        runtime,
        context,
        result.outcome,
      );
      break;
  }
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

    // Loading an existing location never overwrites differing files silently.
    // Declining leaves both realities untouched; the normal next capture is
    // the model's only way to accept the current files into this node.
    if (
      event.reason === "startup" ||
      event.reason === "new" ||
      event.reason === "resume" ||
      event.reason === "fork"
    ) {
      await reconcileLoadedSession(runtime, context, view);
    }
    await runAutomaticGc(context);
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
    let detail: string | undefined;
    const captured = await runtime
      .enqueueWorkspace("capture-turn", async () => {
        if (!registeredSessionStillAt(runtime, context, view)) {
          detail = "active location changed before turn capture";
          return false;
        }
        const expectedTreeOid = runtime.metadata.getState(
          node.sessionId,
          node.entryId,
        )?.treeOid;
        const prepared = await runtime.prepareCaptureResult(view);
        if (!prepared.ok) {
          detail = prepared.error.message;
          return false;
        }
        if (
          !(await runtime.workspaceStillBound(view.cwd)) ||
          !registeredSessionStillAt(runtime, context, view)
        ) {
          detail = "active location changed during turn capture";
          return false;
        }
        const committed = await runtime.commitPreparedCapture({
          source: node,
          prepared: prepared.value,
          expectedTreeOid,
        });
        if (!committed.ok) {
          detail = committed.error.message;
          return false;
        }
        runtime.touchCapturedSession(view);
        return true;
      })
      .catch((error: unknown) => {
        detail = messageOf(error);
        return false;
      });
    runtime.notifyCaptureResult(context, captured, detail);
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
        const captured = await captureSourceOrCancel(
          runtime,
          context,
          view,
          view.leafId,
        );
        if (captured && context.isIdle()) {
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
      const captured = await captureSourceOrCancel(
        runtime,
        context,
        view,
        view.leafId,
      );
      if (!captured || !context.isIdle()) {
        return blockedBashResult(runtime.i18n.t("sourceCaptureFailed"));
      }
      if (!hadConflict) return undefined;
      return blockedBashResult(runtime.i18n.t("bashWhileBusy"));
    } catch (error) {
      runtime.notifyCaptureResult(context, false, messageOf(error));
      return blockedBashResult(
        "Cyclotomy could not checkpoint safely; command blocked.",
      );
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
      const captured = await captureSourceOrCancel(
        runtime,
        context,
        view,
        view.leafId,
      );
      if (!captured) return { cancel: true };
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
      const captured = await captureSourceOrCancel(
        runtime,
        context,
        view,
        view.leafId,
      );
      if (!captured) return { cancel: true };
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
      if (
        !context.isIdle() ||
        !runtime.transitions.tryBegin("switch")
      ) {
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
      const captured = await captureSourceOrCancel(
        runtime,
        context,
        view,
        view.leafId,
      );
      if (!captured) return { cancel: true };
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

  pi.on("session_shutdown", async () => {
    // switch/fork sources are already durable before Pi may replace cwd or the
    // session manager. Reload has no cancellable precursor and must not scan a
    // potentially replaced workspace during shutdown.
    runtime.close();
  });
}
