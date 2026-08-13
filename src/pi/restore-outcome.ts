import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { RestoreOutcome } from "../application/restore.ts";
import type {
  CheckpointInitializationConflict,
  CleanupSettlement,
  PostMutationConflict,
  RestorePreparationConflict,
} from "./post-mutation.ts";
import type { ArrivalProtection } from "./arrival-protection.ts";
import type { ArrivalDisposition } from "./arrival-settlement.ts";
import { assertNever } from "./assert-never.ts";
import { formatUiDetail } from "./restore-presentation.ts";
import type { CyclotomyRuntime } from "./runtime.ts";
import { messageOfUnknown as messageOf } from "./unknown-error.ts";
import type { RestoreProtocolOutcome } from "./workspace-mutation-protocol.ts";

/** Critical presenter for a protocol that could not establish durable safety. */
export function notifyArrivalProtectionFailure(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  protection: ArrivalProtection,
): void {
  switch (protection.kind) {
    case "unavailable":
      runtime.notifyBestEffort(
        context,
        () =>
          runtime.i18n.t("arrivalProtectionUnavailable", {
            message: formatUiDetail(messageOf(protection.cause)),
          }),
        "error",
      );
      return;
    case "exact-slot": {
      switch (protection.admission.kind) {
        case "settled":
          return;
        case "failed": {
          const cause = protection.admission.cause;
          runtime.notifyBestEffort(
            context,
            () =>
              runtime.i18n.t("arrivalAdmissionUnavailable", {
                message: formatUiDetail(messageOf(cause)),
              }),
            "error",
          );
          return;
        }
        default:
          return assertNever(
            protection.admission,
            "unhandled arrival admission settlement",
          );
      }
    }
    case "session-barrier":
      return;
    default:
      return assertNever(protection, "unhandled arrival protection");
  }
}

/** Critical presenter for the safety fact carried beside a protocol result. */
export function notifyArrivalDispositionFailure(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  disposition: ArrivalDisposition,
): void {
  if (disposition.kind === "unsettled") {
    runtime.notifyBestEffort(
      context,
      () =>
        runtime.i18n.t("arrivalProtectionUnavailable", {
          message: formatUiDetail(messageOf(disposition.cause)),
        }),
      "error",
    );
    return;
  }
  if (disposition.kind === "protected") {
    const admission = disposition.evidence.admission;
    if (admission.kind !== "failed") return;
    runtime.notifyBestEffort(
      context,
      () =>
        runtime.i18n.t("arrivalAdmissionUnavailable", {
          message: formatUiDetail(messageOf(admission.cause)),
        }),
      "error",
    );
  }
}

/** Present lock cleanup as an independent operational fact. */
export function notifyWorkspaceLockCleanupFailure(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  cleanup: CleanupSettlement,
): void {
  if (cleanup.kind !== "failed") return;
  runtime.notifyBestEffort(
    context,
    () =>
      runtime.i18n.t("workspaceLockCleanupFailed", {
        message: formatUiDetail(messageOf(cleanup.cause)),
      }),
    "error",
  );
}

/** Present one localized restore result across every entry point. */
export function notifyRestoreOutcome(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  outcome: RestoreOutcome,
  options: { readonly announceSuccess?: boolean } = {},
): void {
  runtime.presentBestEffort(context, () => {
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
            message: messageOf(outcome.cause),
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
      case "scan-incomplete":
        runtime.notify(
          context,
          runtime.i18n.t("restoreNotStarted", {
            message: runtime.i18n.formatScanProblems(outcome.problems),
          }),
          "warning",
        );
        break;
      case "failed":
        if (outcome.stage === "current-scan" || outcome.stage === "staging") {
          runtime.notify(
            context,
            runtime.i18n.t("restoreNotStarted", {
              message: messageOf(outcome.cause),
            }),
            "warning",
          );
          break;
        }
        runtime.notify(
          context,
          runtime.i18n.t("restoreExecutionFailed", {
            message: messageOf(outcome.cause),
          }),
          "error",
        );
        break;
      default:
        assertNever(outcome, "unhandled restore outcome");
    }
  });
}

/** Present a restore without mistaking a refused cutover for file mutation. */
export function notifyRestoreProtocolOutcome(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  execution: RestoreProtocolOutcome,
  options: { readonly announceSuccess?: boolean } = {},
): void {
  if (execution.cutover.kind !== "rejected") {
    notifyRestoreOutcome(runtime, context, execution.outcome, options);
  } else {
    const cause = execution.cutover.cause;
    runtime.presentBestEffort(context, () => {
      runtime.notify(
        context,
        runtime.i18n.t("restoreNotStarted", {
          message: messageOf(cause),
        }),
        "warning",
      );
    });
  }
  notifyRestoreCleanupFailures(runtime, context, execution);
}

function notifyRestoreCleanupFailures(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  execution: Pick<
    RestoreProtocolOutcome,
    "stagingCleanup" | "workspaceLockCleanup"
  >,
): void {
  if (execution.stagingCleanup.kind === "failed") {
    const cause = execution.stagingCleanup.cause;
    runtime.notifyBestEffort(
      context,
      () =>
        runtime.i18n.t("restoreStagingCleanupFailed", {
          message: formatUiDetail(messageOf(cause)),
        }),
      "error",
    );
  }
  notifyWorkspaceLockCleanupFailure(
    runtime,
    context,
    execution.workspaceLockCleanup,
  );
}

/** Present file-application results without disguising a late location race. */
export function notifyPostMutationConflict(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  conflict: PostMutationConflict,
): void {
  if (conflict.arrivalProtection.kind === "exact-slot") {
    notifyArrivalProtectionFailure(
      runtime,
      context,
      conflict.arrivalProtection,
    );
  }
  if (conflict.outcome.kind !== "restored") {
    notifyRestoreOutcome(runtime, context, conflict.outcome);
  }
  runtime.presentBestEffort(context, () => {
    const restored =
      conflict.outcome.kind === "restored"
        ? `${runtime.i18n.formatRestoreSuccess(conflict.outcome.report)} `
        : "";

    const unavailable = conflict.arrivalProtection.kind === "unavailable";
    const barrier = conflict.arrivalProtection.kind === "session-barrier";
    let key:
      | "restorePostMutationLocationProtected"
      | "restorePostMutationLocationUnavailable"
      | "restorePostMutationLocationBarrier"
      | "restorePostMutationTargetProtected"
      | "restorePostMutationTargetUnavailable"
      | "restorePostMutationTargetBarrier"
      | "restorePostMutationControlProtected"
      | "restorePostMutationControlUnavailable"
      | "restorePostMutationControlBarrier";
    let variables: Readonly<Record<string, string>> = {};
    switch (conflict.reason) {
      case "location-changed":
        key = barrier
          ? "restorePostMutationLocationBarrier"
          : unavailable
            ? "restorePostMutationLocationUnavailable"
            : "restorePostMutationLocationProtected";
        break;
      case "target-changed":
        key = barrier
          ? "restorePostMutationTargetBarrier"
          : unavailable
            ? "restorePostMutationTargetUnavailable"
            : "restorePostMutationTargetProtected";
        break;
      case "control-failed":
        const controlMessage = messageOf(conflict.cause);
        key = barrier
          ? "restorePostMutationControlBarrier"
          : unavailable
            ? "restorePostMutationControlUnavailable"
            : "restorePostMutationControlProtected";
        variables = unavailable
          ? {
              message: controlMessage,
              protection: formatUiDetail(
                messageOf(conflict.arrivalProtection.cause),
              ),
            }
          : { message: controlMessage };
        break;
    }
    if (unavailable && conflict.reason !== "control-failed") {
      variables = { message: messageOf(conflict.arrivalProtection.cause) };
    }
    runtime.notify(
      context,
      `${restored}${runtime.i18n.t(key, variables)}`,
      unavailable ? "error" : "warning",
    );
  });
  const cleanupIsControlFailure =
    conflict.reason === "control-failed" &&
    conflict.workspaceLockCleanup.kind === "failed" &&
    conflict.workspaceLockCleanup.cause === conflict.cause;
  if (!cleanupIsControlFailure) {
    notifyWorkspaceLockCleanupFailure(
      runtime,
      context,
      conflict.workspaceLockCleanup,
    );
  }
}

/** Present a committed first checkpoint without implying admission succeeded. */
export function notifyCheckpointInitializationConflict(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  conflict: CheckpointInitializationConflict,
): void {
  if (conflict.arrivalProtection.kind === "exact-slot") {
    notifyArrivalProtectionFailure(
      runtime,
      context,
      conflict.arrivalProtection,
    );
  }
  runtime.presentBestEffort(context, () => {
    const unavailable = conflict.arrivalProtection.kind === "unavailable";
    const barrier = conflict.arrivalProtection.kind === "session-barrier";
    const detail = unavailable
      ? `${messageOf(conflict.cause)}; ${messageOf(
          conflict.arrivalProtection.cause,
        )}`
      : messageOf(conflict.cause);
    runtime.notify(
      context,
      runtime.i18n.t(
        unavailable
          ? "checkpointInitializedConflictUnavailable"
          : barrier
            ? "checkpointInitializedConflictBarrier"
            : "checkpointInitializedConflictProtected",
        { message: detail },
      ),
      unavailable ? "error" : "warning",
    );
  });
}

/** Present both the primary loaded-checkpoint failure and recovery result. */
export function notifyRestorePreparationConflict(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  conflict: RestorePreparationConflict,
): void {
  if (conflict.arrivalProtection.kind === "exact-slot") {
    notifyArrivalProtectionFailure(
      runtime,
      context,
      conflict.arrivalProtection,
    );
  }
  runtime.presentBestEffort(context, () => {
    const primary = messageOf(conflict.cause);
    switch (conflict.arrivalProtection.kind) {
      case "exact-slot":
        runtime.notify(
          context,
          runtime.i18n.t("restorePreparationProtected", { message: primary }),
          "warning",
        );
        return;
      case "session-barrier":
        runtime.notify(
          context,
          runtime.i18n.t("restorePreparationBarrier", { message: primary }),
          "warning",
        );
        return;
      case "unavailable":
        runtime.notify(
          context,
          runtime.i18n.t("restorePreparationUnavailable", {
            message: primary,
            protection: formatUiDetail(
              messageOf(conflict.arrivalProtection.cause),
            ),
          }),
          "error",
        );
        return;
      default:
        assertNever(
          conflict.arrivalProtection,
          "unhandled restore preparation protection",
        );
    }
  });
  notifyWorkspaceLockCleanupFailure(
    runtime,
    context,
    conflict.workspaceLockCleanup,
  );
}
