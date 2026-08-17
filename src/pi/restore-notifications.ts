import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { RestoreOutcome } from "../application/restore.ts";
import type { CleanupSettlement } from "../domain/cleanup-settlement.ts";
import type {
  CheckpointInitializationConflict,
  PostMutationConflict,
  RestorePreparationConflict,
} from "./post-mutation.ts";
import type { ArrivalDisposition } from "./arrival-settlement.ts";
import { assertNever } from "./assert-never.ts";
import { formatUiDetail } from "./restore-presentation.ts";
import type { CyclotomyRuntime } from "./runtime.ts";
import { messageOfUnknown as messageOf } from "./unknown-error.ts";
import type { RestoreProtocolOutcome } from "./workspace-mutation-protocol.ts";
import type { ArrivalReceipt } from "./workspace-receipt.ts";

/** Critical notification presenter for the safety fact beside a protocol result. */
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

/** Present every UI fact owned by one restore receipt exactly once. */
export function notifyRestoreProtocolOutcome(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  receipt: ArrivalReceipt<RestoreProtocolOutcome>,
  options: { readonly announceSuccess?: boolean } = {},
): void {
  notifyArrivalDispositionFailure(runtime, context, receipt.arrival);
  const execution = receipt.execution;
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
  notifyRestorePreparationCleanupFailure(
    runtime,
    context,
    execution.preparationCleanup,
  );
  notifyWorkspaceLockCleanupFailure(
    runtime,
    context,
    receipt.workspaceLockCleanup,
  );
}

function notifyRestorePreparationCleanupFailure(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  cleanup: CleanupSettlement,
): void {
  if (cleanup.kind === "failed") {
    const cause = cleanup.cause;
    runtime.notifyBestEffort(
      context,
      () =>
        runtime.i18n.t("restorePreparationCleanupFailed", {
          message: formatUiDetail(messageOf(cause)),
        }),
      "error",
    );
  }
}

/** Present file-application results without disguising a late location race. */
export function notifyPostMutationConflict(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  receipt: PostMutationConflict,
): void {
  const conflict = receipt.execution;
  const arrival = receipt.arrival;
  if (arrival.kind === "protected") {
    notifyArrivalDispositionFailure(runtime, context, arrival);
  }
  if (conflict.outcome.kind !== "restored") {
    notifyRestoreOutcome(runtime, context, conflict.outcome);
  }
  runtime.presentBestEffort(context, () => {
    const restored =
      conflict.outcome.kind === "restored"
        ? `${runtime.i18n.formatRestoreSuccess(conflict.outcome.report)} `
        : "";

    const unavailable = arrival.kind === "unsettled";
    const barrier =
      arrival.kind === "protected" &&
      arrival.evidence.kind === "session-barrier";
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
              protection: formatUiDetail(messageOf(arrival.cause)),
            }
          : { message: controlMessage };
        break;
    }
    if (unavailable && conflict.reason !== "control-failed") {
      variables = { message: messageOf(arrival.cause) };
    }
    runtime.notify(
      context,
      `${restored}${runtime.i18n.t(key, variables)}`,
      unavailable ? "error" : "warning",
    );
  });
  notifyRestorePreparationCleanupFailure(
    runtime,
    context,
    conflict.preparationCleanup,
  );
  const cleanupIsControlFailure =
    conflict.reason === "control-failed" &&
    receipt.workspaceLockCleanup.kind === "failed" &&
    receipt.workspaceLockCleanup.cause === conflict.cause;
  if (!cleanupIsControlFailure) {
    notifyWorkspaceLockCleanupFailure(
      runtime,
      context,
      receipt.workspaceLockCleanup,
    );
  }
}

/** Present a committed first checkpoint without implying admission succeeded. */
export function notifyCheckpointInitializationConflict(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  receipt: CheckpointInitializationConflict,
): void {
  const conflict = receipt.execution;
  const arrival = receipt.arrival;
  if (arrival.kind === "protected") {
    notifyArrivalDispositionFailure(runtime, context, arrival);
  }
  runtime.presentBestEffort(context, () => {
    const unavailable = arrival.kind === "unsettled";
    const barrier =
      arrival.kind === "protected" &&
      arrival.evidence.kind === "session-barrier";
    const detail =
      unavailable && arrival.cause !== conflict.cause
        ? `${messageOf(conflict.cause)}; ${messageOf(arrival.cause)}`
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
  const cleanupIsInitializationFailure =
    receipt.workspaceLockCleanup.kind === "failed" &&
    receipt.workspaceLockCleanup.cause === conflict.cause;
  if (!cleanupIsInitializationFailure) {
    notifyWorkspaceLockCleanupFailure(
      runtime,
      context,
      receipt.workspaceLockCleanup,
    );
  }
}

/** Present both the primary loaded-checkpoint failure and recovery result. */
export function notifyRestorePreparationConflict(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  receipt: RestorePreparationConflict,
): void {
  const conflict = receipt.execution;
  const arrival = receipt.arrival;
  if (arrival.kind === "protected") {
    notifyArrivalDispositionFailure(runtime, context, arrival);
  }
  const cleanupIsPreparationFailure =
    receipt.workspaceLockCleanup.kind === "failed" &&
    receipt.workspaceLockCleanup.cause === conflict.cause;
  if (cleanupIsPreparationFailure && arrival.kind === "unsettled") {
    notifyArrivalDispositionFailure(runtime, context, arrival);
  }
  if (!cleanupIsPreparationFailure) {
    runtime.presentBestEffort(context, () => {
      const primary = messageOf(conflict.cause);
      if (arrival.kind === "protected") {
        if (arrival.evidence.kind === "exact-slot") {
          runtime.notify(
            context,
            runtime.i18n.t("restorePreparationProtected", { message: primary }),
            "warning",
          );
          return;
        }
        runtime.notify(
          context,
          runtime.i18n.t("restorePreparationBarrier", { message: primary }),
          "warning",
        );
        return;
      }
      runtime.notify(
        context,
        runtime.i18n.t("restorePreparationUnavailable", {
          message: primary,
          protection: formatUiDetail(messageOf(arrival.cause)),
        }),
        "error",
      );
    });
  }
  notifyWorkspaceLockCleanupFailure(
    runtime,
    context,
    receipt.workspaceLockCleanup,
  );
}
