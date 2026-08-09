import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { RestoreOutcome } from "../application/restore.ts";
import type {
  CheckpointInitializationConflict,
  PostMutationConflict,
} from "./post-mutation.ts";
import { formatUiDetail } from "./restore-presentation.ts";
import type { CyclotomyRuntime } from "./runtime.ts";

/** Present one localized restore result across every entry point. */
export function notifyRestoreOutcome(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  outcome: RestoreOutcome,
  options: { readonly announceSuccess?: boolean } = {},
): void {
  switch (outcome.kind) {
    case "restored":
      if (options.announceSuccess !== false) {
        runtime.notify(
          context,
          runtime.i18n.formatRestoreSuccess(outcome.report),
          "info",
        );
      }
      break;
    case "checkpoint-unreadable":
      runtime.notify(
        context,
        runtime.i18n.t("checkpointUnreadable", {
          message: outcome.message,
        }),
        "error",
      );
      break;
    case "apply-incomplete":
      runtime.notify(
        context,
        runtime.i18n.t("restoreApplyIncomplete", {
          problems: runtime.i18n.formatApplyProblems(outcome.report.problems),
          applied: runtime.i18n.formatAppliedMutations(outcome.report),
        }),
        "error",
      );
      break;
    case "verify-failed":
      runtime.notify(
        context,
        runtime.i18n.t("restoreVerifyFailed", {
          applied: runtime.i18n.formatAppliedMutations(outcome.report),
        }),
        "error",
      );
      break;
    case "failed":
      if (outcome.stage === "current-scan" || outcome.stage === "staging") {
        runtime.notify(
          context,
          runtime.i18n.t("restoreNotStarted", {
            message: outcome.message,
          }),
          "warning",
        );
        break;
      }
      runtime.notify(
        context,
        runtime.i18n.t("restoreExecutionFailed", {
          message: outcome.message,
        }),
        "error",
      );
      break;
  }
}

/** Present file-application results without disguising a late location race. */
export function notifyPostMutationConflict(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  conflict: PostMutationConflict,
): void {
  let restored = "";
  if (conflict.outcome.kind === "restored") {
    restored = `${runtime.i18n.formatRestoreSuccess(conflict.outcome.report)} `;
  } else {
    notifyRestoreOutcome(runtime, context, conflict.outcome);
  }

  const unavailable = conflict.arrivalProtection.kind === "unavailable";
  const pending = conflict.arrivalProtection.kind === "pending-node-guard";
  let key:
    | "restorePostMutationLocationProtected"
    | "restorePostMutationLocationUnavailable"
    | "restorePostMutationLocationPending"
    | "restorePostMutationTargetProtected"
    | "restorePostMutationTargetUnavailable"
    | "restorePostMutationTargetPending"
    | "restorePostMutationControlProtected"
    | "restorePostMutationControlUnavailable"
    | "restorePostMutationControlPending";
  let variables: Readonly<Record<string, string>> = {};
  switch (conflict.reason) {
    case "location-changed":
      key = pending
        ? "restorePostMutationLocationPending"
        : unavailable
          ? "restorePostMutationLocationUnavailable"
          : "restorePostMutationLocationProtected";
      break;
    case "target-changed":
      key = pending
        ? "restorePostMutationTargetPending"
        : unavailable
          ? "restorePostMutationTargetUnavailable"
          : "restorePostMutationTargetProtected";
      break;
    case "control-failed":
      key = pending
        ? "restorePostMutationControlPending"
        : unavailable
          ? "restorePostMutationControlUnavailable"
          : "restorePostMutationControlProtected";
      variables = unavailable
        ? {
            message: conflict.message,
            protection: formatUiDetail(conflict.arrivalProtection.message),
          }
        : { message: conflict.message };
      break;
  }
  if (unavailable && conflict.reason !== "control-failed") {
    variables = { message: conflict.arrivalProtection.message };
  }
  runtime.notify(
    context,
    `${restored}${runtime.i18n.t(key, variables)}`,
    unavailable ? "error" : "warning",
  );
}

/** Present a committed first checkpoint without implying admission succeeded. */
export function notifyCheckpointInitializationConflict(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  conflict: CheckpointInitializationConflict,
): void {
  const unavailable = conflict.arrivalProtection.kind === "unavailable";
  const pending = conflict.arrivalProtection.kind === "pending-node-guard";
  const detail = unavailable
    ? `${conflict.message}; ${conflict.arrivalProtection.message}`
    : conflict.message;
  runtime.notify(
    context,
    runtime.i18n.t(
      unavailable
        ? "checkpointInitializedConflictUnavailable"
        : pending
          ? "checkpointInitializedConflictPending"
          : "checkpointInitializedConflictProtected",
      { message: detail },
    ),
    unavailable ? "error" : "warning",
  );
}
