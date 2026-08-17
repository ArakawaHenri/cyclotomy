import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { restorePlanHasChanges } from "../infrastructure/restore-plan.ts";
import { prepareWorkspaceRestorePlan } from "../infrastructure/restore-preparation.ts";
import {
  gitReplayRisk,
  sameGitOracleVersion,
} from "../infrastructure/git-replay-risk.ts";
import { applyActiveArrivalSettlement } from "./active-arrival-settlement.ts";
import { assertNever } from "./assert-never.ts";
import { formatCaptureFailure } from "./capture-failure.ts";
import {
  runConfirmedRestore,
  type ConfirmedRestoreExecution,
} from "./confirmed-restore.ts";
import type {
  CheckpointInitializationConflict,
  PostMutationConflict,
  RestorePreparationConflict,
} from "./post-mutation.ts";
import {
  notifyArrivalDispositionFailure,
  notifyCheckpointInitializationConflict,
  notifyPostMutationConflict,
  notifyRestorePreparationConflict,
  notifyRestoreProtocolOutcome,
  notifyWorkspaceLockCleanupFailure,
} from "./restore-notifications.ts";
import type { CyclotomyRuntime } from "./runtime.ts";
import { readSessionView, type SessionView } from "./session-view.ts";
import { messageOfUnknown as messageOf } from "./unknown-error.ts";
import type { ArrivalReceipt } from "./workspace-receipt.ts";

function finishRestore(
  runtime: CyclotomyRuntime,
  context: ExtensionCommandContext,
  receipt: ArrivalReceipt<ConfirmedRestoreExecution>,
): void {
  applyActiveArrivalSettlement(runtime, receipt.arrival);
  const execution = receipt.execution;
  switch (execution.kind) {
    case "initialization-conflict":
      notifyCheckpointInitializationConflict(
        runtime,
        context,
        receipt as CheckpointInitializationConflict,
      );
      return;
    case "post-mutation-conflict":
      notifyPostMutationConflict(
        runtime,
        context,
        receipt as PostMutationConflict,
      );
      return;
    case "preparation-conflict":
      notifyRestorePreparationConflict(
        runtime,
        context,
        receipt as RestorePreparationConflict,
      );
      return;
    case "outcome":
      notifyArrivalDispositionFailure(runtime, context, receipt.arrival);
      notifyRestoreProtocolOutcome(runtime, context, {
        execution,
        workspaceLockCleanup: receipt.workspaceLockCleanup,
      });
      return;
  }

  notifyArrivalDispositionFailure(runtime, context, receipt.arrival);
  switch (execution.kind) {
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
          message: runtime.i18n.formatScanProblems(execution.problems),
        }),
        "warning",
      );
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
      runtime.notify(
        context,
        [
          runtime.i18n.t("restoreNeedsUi"),
          runtime.i18n.formatGitReplayRisk(execution.replayRisk),
        ]
          .filter((part): part is string => part !== undefined)
          .join("\n\n"),
        "warning",
      );
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
          { message: messageOf(execution.cause) },
        ),
        "error",
      );
      break;
    case "capture-failed":
      runtime.notify(
        context,
        runtime.i18n.t("restorePrepareFailed", {
          message: formatCaptureFailure(runtime.i18n, execution.failure),
        }),
        "error",
      );
      break;
    default:
      assertNever(execution, "unhandled confirmed restore result");
  }
  notifyWorkspaceLockCleanupFailure(
    runtime,
    context,
    receipt.workspaceLockCleanup,
  );
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
  if (runtime.admission.rejectTransitionConflict()) {
    runtime.notify(context, runtime.i18n.t("transitionInProgress"), "warning");
    return;
  }
  const node = runtime.checkpoints.captureAnchor(view);
  if (node === undefined) {
    runtime.notify(context, runtime.i18n.t("locationUnknown"), "warning");
    return;
  }

  const receipt = await runConfirmedRestore(
    runtime,
    context,
    view,
    node,
    "manual",
  );
  finishRestore(runtime, context, receipt);
}

async function driftCommand(
  runtime: CyclotomyRuntime,
  context: ExtensionCommandContext,
  view: SessionView,
): Promise<void> {
  const node = runtime.checkpoints.captureAnchor(view);
  if (node === undefined) {
    runtime.notify(context, runtime.i18n.t("locationUnknown"), "warning");
    return;
  }
  const prepared = await (async () => {
    runtime.setStatus(context, runtime.i18n.t("checkingWorkspace"));
    try {
      const execution = await runtime.enqueueWorkspaceExecution(
        "drift",
        async (writeAuthority) => {
          if (
            runtime.workspaceMutations.reconcileSessionBarrier(
              writeAuthority,
              view,
              node,
            ) === "unregistered"
          ) {
            throw new Error(
              "current session registration changed before drift",
            );
          }
          const readable = await runtime.resolveReadableTreeIn(view, node);
          if (readable === undefined) {
            return {
              kind: "missing" as const,
              writeProtected: runtime.checkpoints.locationIsBlocked(node),
            };
          }
          const { resolution, manifest, scopeValidation } = readable;
          const snapshot = await runtime.scanCurrentWorkspaceForScope(
            view.cwd,
            manifest.scope,
          );
          if (
            !sameGitOracleVersion(
              scopeValidation.gitVersion,
              snapshot.gitOracleVersion,
            )
          ) {
            throw new Error(
              "Git evaluator changed while preparing the drift report",
            );
          }
          return {
            kind: "checkpoint" as const,
            resolution,
            drift: (await prepareWorkspaceRestorePlan(snapshot, manifest)).plan,
            replayRisk: gitReplayRisk(
              manifest.scope,
              snapshot.gitOracleVersion,
            ),
            writeProtected: runtime.checkpoints.locationIsBlocked(node),
          };
        },
      );
      notifyWorkspaceLockCleanupFailure(runtime, context, execution.cleanup);
      if (execution.kind === "action-failed") throw execution.cause;
      return execution.value;
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
  const riskNotice = runtime.i18n.formatGitReplayRisk(prepared.replayRisk);
  if (
    prepared.drift.problems.length === 0 &&
    !restorePlanHasChanges(prepared.drift)
  ) {
    runtime.notify(
      context,
      [
        runtime.i18n.t(
          prepared.writeProtected
            ? "driftCleanProtected"
            : inherited
              ? "driftCleanInherited"
              : "driftClean",
        ),
        riskNotice,
      ]
        .filter((part): part is string => part !== undefined)
        .join("\n\n"),
      riskNotice === undefined ? "info" : "warning",
    );
    return;
  }
  runtime.notify(
    context,
    runtime.i18n.t(
      prepared.writeProtected
        ? "driftTitleDetached"
        : inherited
          ? "driftTitleInherited"
          : "driftTitle",
      {
        preview: [riskNotice, runtime.i18n.formatRestorePreview(prepared.drift)]
          .filter((part): part is string => part !== undefined)
          .join("\n\n"),
      },
    ),
    prepared.drift.problems.length > 0 || riskNotice !== undefined
      ? "warning"
      : "info",
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
    if (!(await runtime.registrations.sessionOwnsCurrentWorkspace(view))) {
      runtime.notify(
        context,
        runtime.i18n.t("sessionWorkspaceMismatch"),
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
    if (!runtime.registrations.sessionIsUsable(view)) {
      runtime.notify(
        context,
        runtime.i18n.t("sessionIdentityUnavailable"),
        "warning",
      );
      return;
    }
    await action(runtime, context, view);
  } catch (error) {
    const recovery = await runtime.withdrawFromParticipation(context, error);
    applyActiveArrivalSettlement(runtime, recovery.arrival);
    notifyArrivalDispositionFailure(runtime, context, recovery.arrival);
    notifyWorkspaceLockCleanupFailure(
      runtime,
      context,
      recovery.workspaceLockCleanup,
    );
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
