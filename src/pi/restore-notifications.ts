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
import type { MessageKey } from "./i18n.ts";
import { formatUiDetail } from "./restore-presentation.ts";
import type { CyclotomyRuntime } from "./runtime.ts";
import { messageOfUnknown as messageOf } from "./unknown-error.ts";
import type { RestoreProtocolOutcome } from "./workspace-mutation-protocol.ts";
import type {
  ArrivalReceipt,
  ArrivalRecoverySettlement,
} from "./workspace-receipt.ts";

/** Choose a complete user message from the runtime's current participation. */
export function participationMessage(
  runtime: CyclotomyRuntime,
  active: MessageKey,
  inactive: MessageKey,
  variables: Readonly<Record<string, string | number>> = {},
): string {
  return runtime.i18n.t(runtime.isActive ? active : inactive, variables);
}

function continuationGuidance(runtime: CyclotomyRuntime): string {
  return runtime.i18n.t(
    runtime.isActive ? "continueWithDrift" : "continueAfterResume",
  );
}

function restoreContinuationGuidance(
  runtime: CyclotomyRuntime,
  retry: boolean,
): string {
  if (!runtime.isActive) return runtime.i18n.t("continueAfterResume");
  return runtime.i18n.t(retry ? "retryRestoreAfterDrift" : "continueWithDrift");
}

/** Critical notification presenter for the safety fact beside a protocol result. */
export function notifyArrivalDispositionFailure(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  disposition: ArrivalDisposition,
): void {
  if (disposition.kind === "unsettled") {
    const key = runtime.isActive
      ? "arrivalProtectionUnavailable"
      : "arrivalProtectionStopped";
    runtime.notify(
      context,
      runtime.i18n.t(key, {
        message: formatUiDetail(messageOf(disposition.cause)),
      }),
      "error",
    );
    return;
  }
  if (disposition.kind === "protected") {
    const admission = disposition.evidence.admission;
    if (admission.kind !== "failed") return;
    const key = runtime.isActive
      ? "arrivalAdmissionUnavailable"
      : "arrivalAdmissionStopped";
    runtime.notify(
      context,
      runtime.i18n.t(key, {
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
  runtime.notify(
    context,
    runtime.i18n.t(
      runtime.isActive
        ? "workspaceLockCleanupFailed"
        : "workspaceLockCleanupStopped",
      {
        message: formatUiDetail(messageOf(cleanup.cause)),
      },
    ),
    "error",
  );
}

function arrivalFailureCause(
  disposition: ArrivalDisposition,
): unknown | undefined {
  if (disposition.kind === "unsettled") return disposition.cause;
  if (
    disposition.kind === "protected" &&
    disposition.evidence.admission.kind === "failed"
  ) {
    return disposition.evidence.admission.cause;
  }
  return undefined;
}

function notifyArrivalFailureOnce(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  disposition: ArrivalDisposition,
  presentedCauses: Set<unknown>,
): void {
  const cause = arrivalFailureCause(disposition);
  if (cause === undefined || presentedCauses.has(cause)) return;
  notifyArrivalDispositionFailure(runtime, context, disposition);
  presentedCauses.add(cause);
}

function notifyWorkspaceLockCleanupFailureOnce(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  cleanup: CleanupSettlement,
  presentedCauses: Set<unknown>,
): void {
  if (cleanup.kind !== "failed" || presentedCauses.has(cleanup.cause)) return;
  notifyWorkspaceLockCleanupFailure(runtime, context, cleanup);
  presentedCauses.add(cleanup.cause);
}

/** Present the independent durable facts produced while retiring a location. */
export function notifyArrivalRecovery(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  recovery: ArrivalRecoverySettlement,
  presentedCauses: Set<unknown> = new Set(),
): void {
  notifyArrivalFailureOnce(runtime, context, recovery.arrival, presentedCauses);
  notifyWorkspaceLockCleanupFailureOnce(
    runtime,
    context,
    recovery.workspaceLockCleanup,
    presentedCauses,
  );
}

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
          continuation: restoreContinuationGuidance(runtime, true),
        }),
        "error",
      );
      break;
    case "verify-failed":
      runtime.notify(
        context,
        runtime.i18n.t("restoreVerifyFailed", {
          applied: runtime.i18n.formatAppliedMutations(outcome.report),
          continuation: restoreContinuationGuidance(runtime, false),
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
          continuation: restoreContinuationGuidance(runtime, false),
        }),
        "error",
      );
      break;
    default:
      assertNever(outcome, "unhandled restore outcome");
  }
}

function restoreOutcomeFailureCause(
  outcome: RestoreOutcome,
): unknown | undefined {
  return outcome.kind === "checkpoint-unreadable" || outcome.kind === "failed"
    ? outcome.cause
    : undefined;
}

/** Present every UI fact owned by one restore receipt exactly once. */
export function notifyRestoreProtocolOutcome(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  receipt: ArrivalReceipt<RestoreProtocolOutcome>,
  options: { readonly announceSuccess?: boolean } = {},
): void {
  const presentedCauses = new Set<unknown>();
  notifyArrivalFailureOnce(runtime, context, receipt.arrival, presentedCauses);
  const execution = receipt.execution;
  if (execution.cutover.kind !== "rejected") {
    const cause = restoreOutcomeFailureCause(execution.outcome);
    if (cause === undefined || !presentedCauses.has(cause)) {
      notifyRestoreOutcome(runtime, context, execution.outcome, options);
      if (cause !== undefined) presentedCauses.add(cause);
    }
  } else {
    const cause = execution.cutover.cause;
    if (!presentedCauses.has(cause)) {
      runtime.notify(
        context,
        runtime.i18n.t("restoreNotStarted", {
          message: messageOf(cause),
        }),
        "warning",
      );
      presentedCauses.add(cause);
    }
  }
  notifyRestorePreparationCleanupFailureOnce(
    runtime,
    context,
    execution.preparationCleanup,
    presentedCauses,
  );
  notifyWorkspaceLockCleanupFailureOnce(
    runtime,
    context,
    receipt.workspaceLockCleanup,
    presentedCauses,
  );
}

function notifyRestorePreparationCleanupFailureOnce(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  cleanup: CleanupSettlement,
  presentedCauses: Set<unknown>,
): void {
  if (cleanup.kind === "failed" && !presentedCauses.has(cleanup.cause)) {
    const cause = cleanup.cause;
    runtime.notify(
      context,
      runtime.i18n.t("restorePreparationCleanupFailed", {
        message: formatUiDetail(messageOf(cause)),
      }),
      "error",
    );
    presentedCauses.add(cause);
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
  const presentedCauses = new Set<unknown>();
  if (conflict.reason === "control-failed") {
    presentedCauses.add(conflict.cause);
  }
  if (arrival.kind === "unsettled") {
    presentedCauses.add(arrival.cause);
  }
  if (arrival.kind === "protected") {
    notifyArrivalFailureOnce(runtime, context, arrival, presentedCauses);
  }
  if (conflict.outcome.kind !== "restored") {
    const outcomeCause = restoreOutcomeFailureCause(conflict.outcome);
    if (outcomeCause === undefined || !presentedCauses.has(outcomeCause)) {
      notifyRestoreOutcome(runtime, context, conflict.outcome);
      if (outcomeCause !== undefined) presentedCauses.add(outcomeCause);
    }
  }
  const restored =
    conflict.outcome.kind === "restored"
      ? `${runtime.i18n.formatRestoreSuccess(conflict.outcome.report)} `
      : "";

  const unavailable = arrival.kind === "unsettled";
  const barrier =
    arrival.kind === "protected" && arrival.evidence.kind === "session-barrier";
  let key:
    | "restorePostMutationLocationProtected"
    | "restorePostMutationLocationUnavailable"
    | "restorePostMutationLocationBarrier"
    | "restorePostMutationTargetProtected"
    | "restorePostMutationTargetUnavailable"
    | "restorePostMutationTargetBarrier"
    | "restorePostMutationControlProtected"
    | "restorePostMutationControlUnavailable"
    | "restorePostMutationControlUnavailableShared"
    | "restorePostMutationControlBarrier";
  let variables: Readonly<Record<string, string>> = {
    continuation: continuationGuidance(runtime),
  };
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
          ? arrival.cause === conflict.cause
            ? "restorePostMutationControlUnavailableShared"
            : "restorePostMutationControlUnavailable"
          : "restorePostMutationControlProtected";
      variables = unavailable
        ? arrival.cause === conflict.cause
          ? { message: controlMessage }
          : {
              message: controlMessage,
              protection: formatUiDetail(messageOf(arrival.cause)),
            }
        : {
            message: controlMessage,
            continuation: continuationGuidance(runtime),
          };
      break;
  }
  if (unavailable && conflict.reason !== "control-failed") {
    variables = { message: messageOf(arrival.cause) };
  }
  runtime.notify(
    context,
    `${restored}${runtime.i18n.t(key, variables)}`,
    unavailable || !runtime.isActive ? "error" : "warning",
  );
  notifyRestorePreparationCleanupFailureOnce(
    runtime,
    context,
    conflict.preparationCleanup,
    presentedCauses,
  );
  notifyWorkspaceLockCleanupFailureOnce(
    runtime,
    context,
    receipt.workspaceLockCleanup,
    presentedCauses,
  );
}

/** Present a committed first checkpoint without implying admission succeeded. */
export function notifyCheckpointInitializationConflict(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  receipt: CheckpointInitializationConflict,
): void {
  const conflict = receipt.execution;
  const arrival = receipt.arrival;
  const presentedCauses = new Set<unknown>([conflict.cause]);
  if (arrival.kind === "unsettled") {
    presentedCauses.add(arrival.cause);
  }
  if (arrival.kind === "protected") {
    notifyArrivalFailureOnce(runtime, context, arrival, presentedCauses);
  }
  const unavailable = arrival.kind === "unsettled";
  const barrier =
    arrival.kind === "protected" && arrival.evidence.kind === "session-barrier";
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
      { message: detail, continuation: continuationGuidance(runtime) },
    ),
    unavailable || !runtime.isActive ? "error" : "warning",
  );
  notifyWorkspaceLockCleanupFailureOnce(
    runtime,
    context,
    receipt.workspaceLockCleanup,
    presentedCauses,
  );
}

/** Present both the primary loaded-checkpoint failure and recovery result. */
export function notifyRestorePreparationConflict(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  receipt: RestorePreparationConflict,
): void {
  const conflict = receipt.execution;
  const arrival = receipt.arrival;
  const presentedCauses = new Set<unknown>();
  if (arrival.kind === "protected") {
    notifyArrivalFailureOnce(runtime, context, arrival, presentedCauses);
  }
  const cleanupIsPreparationFailure =
    receipt.workspaceLockCleanup.kind === "failed" &&
    receipt.workspaceLockCleanup.cause === conflict.cause;
  if (cleanupIsPreparationFailure && arrival.kind === "unsettled") {
    notifyArrivalFailureOnce(runtime, context, arrival, presentedCauses);
  }
  if (!cleanupIsPreparationFailure) {
    const primary = messageOf(conflict.cause);
    if (arrival.kind === "protected") {
      if (arrival.evidence.kind === "exact-slot") {
        runtime.notify(
          context,
          runtime.i18n.t("restorePreparationProtected", {
            message: primary,
            continuation: continuationGuidance(runtime),
          }),
          runtime.isActive ? "warning" : "error",
        );
      } else {
        runtime.notify(
          context,
          runtime.i18n.t("restorePreparationBarrier", {
            message: primary,
            continuation: continuationGuidance(runtime),
          }),
          runtime.isActive ? "warning" : "error",
        );
      }
    } else {
      const sharedCause = arrival.cause === conflict.cause;
      runtime.notify(
        context,
        runtime.i18n.t(
          sharedCause
            ? "restorePreparationUnavailableShared"
            : "restorePreparationUnavailable",
          sharedCause
            ? { message: primary }
            : {
                message: primary,
                protection: formatUiDetail(messageOf(arrival.cause)),
              },
        ),
        "error",
      );
    }
    presentedCauses.add(conflict.cause);
    if (arrival.kind === "unsettled") {
      presentedCauses.add(arrival.cause);
    }
  }
  notifyWorkspaceLockCleanupFailureOnce(
    runtime,
    context,
    receipt.workspaceLockCleanup,
    presentedCauses,
  );
}
