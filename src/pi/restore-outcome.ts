import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { RestoreOutcome } from "../application/restore.ts";
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
