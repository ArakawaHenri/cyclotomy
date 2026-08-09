import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { restorePlanHasChanges } from "../infrastructure/restore-plan.ts";
import { prepareWorkspaceRestorePlan } from "../infrastructure/restore-preparation.ts";
import {
  runConfirmedRestore,
  type ConfirmedRestoreResult,
} from "./confirmed-restore.ts";
import {
  notifyCheckpointInitializationConflict,
  notifyPostMutationConflict,
  notifyRestoreOutcome,
} from "./restore-outcome.ts";
import { messageOf, type CyclotomyRuntime } from "./runtime.ts";
import { readSessionView, type SessionView } from "./session-view.ts";

function finishRestore(
  runtime: CyclotomyRuntime,
  context: ExtensionCommandContext,
  execution: ConfirmedRestoreResult,
): void {
  switch (execution.kind) {
    case "initialization-conflict":
      notifyCheckpointInitializationConflict(runtime, context, execution);
      break;
    case "post-mutation-conflict":
      notifyPostMutationConflict(runtime, context, execution);
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
    case "preview-stale":
      runtime.notify(context, runtime.i18n.t("commandPreviewStale"), "warning");
      break;
    case "scan-incomplete":
      runtime.notify(
        context,
        runtime.i18n.t("restoreScanIncomplete", {
          message: execution.message,
        }),
        "warning",
      );
      break;
    case "outcome":
      notifyRestoreOutcome(runtime, context, execution.outcome);
      break;
    case "missing":
      runtime.notify(context, runtime.i18n.t("restoreMissing"), "info");
      break;
    case "protected-missing":
      runtime.notify(
        context,
        runtime.i18n.t("sessionMissingProtected"),
        "warning",
      );
      break;
    case "initialized":
      runtime.notify(context, runtime.i18n.t("restoreInitialized"), "info");
      break;
    case "matches":
      runtime.notify(context, runtime.i18n.t("restoreAlreadyMatches"), "info");
      break;
    case "needs-ui":
      runtime.notify(context, runtime.i18n.t("restoreNeedsUi"), "warning");
      break;
    case "cancelled":
      break;
    case "failed":
      runtime.notify(
        context,
        runtime.i18n.t(
          execution.phase === "prepare"
            ? "restorePrepareFailed"
            : "restoreFailed",
          { message: execution.message },
        ),
        "error",
      );
      break;
  }
}

async function restoreCommand(
  runtime: CyclotomyRuntime,
  context: ExtensionCommandContext,
  view: SessionView,
): Promise<void> {
  if (!context.isIdle()) {
    runtime.notify(context, runtime.i18n.t("waitIdleRestore"), "warning");
    return;
  }
  if (runtime.transitions.rejectConflict()) {
    runtime.notify(context, runtime.i18n.t("transitionInProgress"), "warning");
    return;
  }
  const node = runtime.captureAnchor(view);
  if (node === undefined) {
    runtime.notify(context, runtime.i18n.t("locationUnknown"), "warning");
    return;
  }

  const execution = await runConfirmedRestore(
    runtime,
    context,
    view,
    node,
    "manual",
  );
  finishRestore(runtime, context, execution);
}

async function driftCommand(
  runtime: CyclotomyRuntime,
  context: ExtensionCommandContext,
  view: SessionView,
): Promise<void> {
  const node = runtime.captureAnchor(view);
  if (node === undefined) {
    runtime.notify(context, runtime.i18n.t("locationUnknown"), "warning");
    return;
  }
  const prepared = await (async () => {
    runtime.setStatus(context, runtime.i18n.t("checkingWorkspace"));
    try {
      return await runtime.enqueueWorkspace("drift", async () => {
        const readable = await runtime.resolveReadableTreeIn(view, node);
        if (readable === undefined) {
          return {
            kind: "missing" as const,
            writeProtected: runtime.metadata.isNodeWriteProtected(
              node.sessionId,
              node.entryId,
            ),
          };
        }
        const { resolution, manifest } = readable;
        const snapshot = await runtime.scanCurrentWorkspaceForScope(
          view.cwd,
          manifest.scope,
        );
        return {
          kind: "checkpoint" as const,
          resolution,
          drift: (await prepareWorkspaceRestorePlan(snapshot, manifest)).plan,
          writeProtected: runtime.metadata.isNodeWriteProtected(
            node.sessionId,
            node.entryId,
          ),
        };
      });
    } finally {
      runtime.setStatus(context, undefined);
    }
  })();
  if (prepared.kind === "missing") {
    runtime.notify(
      context,
      runtime.i18n.t(
        prepared.writeProtected ? "driftMissingProtected" : "driftMissing",
      ),
      "info",
    );
    return;
  }
  const inherited =
    prepared.resolution.foundAt.sessionId !== node.sessionId ||
    prepared.resolution.foundAt.entryId !== node.entryId;
  if (
    prepared.drift.problems.length === 0 &&
    !restorePlanHasChanges(prepared.drift)
  ) {
    runtime.notify(
      context,
      runtime.i18n.t(
        prepared.writeProtected
          ? "driftCleanProtected"
          : inherited
            ? "driftCleanInherited"
            : "driftClean",
      ),
      "info",
    );
    return;
  }
  runtime.notify(
    context,
    runtime.i18n.t(inherited ? "driftTitleInherited" : "driftTitle", {
      preview: runtime.i18n.formatRestorePreview(prepared.drift),
    }),
    prepared.drift.problems.length > 0 ? "warning" : "info",
  );
}

type CommandAction = (
  runtime: CyclotomyRuntime,
  context: ExtensionCommandContext,
  view: SessionView,
) => Promise<void>;

async function runCommand(
  runtime: CyclotomyRuntime,
  context: ExtensionCommandContext,
  action: CommandAction,
): Promise<void> {
  try {
    const view = readSessionView(context);
    if (view.sessionFile === null) {
      runtime.notify(
        context,
        runtime.i18n.t("memorySessionUnsupported"),
        "warning",
      );
      return;
    }
    // Bind before the session-identity check: an initialization failure also
    // blocks registration, and its actionable configuration/storage detail is
    // the closer root cause. Explicit user commands always re-report it, so an
    // already-notified failure cannot make /drift or /restore look silent.
    if (!(await runtime.ensureStore(view.cwd))) {
      runtime.notifyInitFailure(context, { force: true });
      return;
    }
    if (!runtime.sessionIsUsable(view)) {
      runtime.notify(
        context,
        runtime.i18n.t("sessionIdentityUnavailable"),
        "warning",
      );
      return;
    }
    await action(runtime, context, view);
  } catch (error) {
    runtime.notify(
      context,
      runtime.i18n.t("commandFailed", { message: messageOf(error) }),
      "error",
    );
  }
}

function createCommandHandler(
  runtime: CyclotomyRuntime,
  usageKey: "restoreUsage" | "driftUsage",
  action: CommandAction,
): (args: string, context: ExtensionCommandContext) => Promise<void> {
  return async (args, context) => {
    if (args.trim().length > 0) {
      runtime.notify(context, runtime.i18n.t(usageKey), "info");
      return;
    }
    runtime.setStatus(context, undefined);
    await runCommand(runtime, context, action);
  };
}

export function createRestoreCommandHandler(
  runtime: CyclotomyRuntime,
): (args: string, context: ExtensionCommandContext) => Promise<void> {
  return createCommandHandler(runtime, "restoreUsage", restoreCommand);
}

export function createDriftCommandHandler(
  runtime: CyclotomyRuntime,
): (args: string, context: ExtensionCommandContext) => Promise<void> {
  return createCommandHandler(runtime, "driftUsage", driftCommand);
}
