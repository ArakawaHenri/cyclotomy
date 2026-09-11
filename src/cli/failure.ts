import type { CleanupSettlement } from "../domain/cleanup-settlement.ts";
import {
  MaintenanceBlockedError,
  MaintenancePreviewChangedError,
} from "../application/maintenance-plan.ts";
import {
  MetadataFingerprintChangedError,
  MetadataUnavailableError,
  MetadataVersionUnsupportedError,
} from "../infrastructure/metadata-error.ts";
import {
  LockProtocolCorruptError,
  UnsupportedLockProtocolError,
} from "../infrastructure/lock-protocol.ts";
import { NativeFileLockUnavailableError } from "../infrastructure/native-file-lock.ts";
import { GarbageCollectionLimitError } from "../infrastructure/object-gc.ts";
import {
  WorkspaceLockProtocolInconsistentError,
  WorkspaceLockTimeoutError,
} from "../infrastructure/workspace-lock.ts";
import { isOperationCancelled } from "../infrastructure/workspace-operation.ts";
import { messageOfUnknown } from "../presentation/unknown-error.ts";
import {
  cliIssue,
  exitCodeOf,
  maintenanceIssue,
  type CliIssue,
  type CliOutcome,
} from "./envelope.ts";

function failureIssues(
  cause: unknown,
  signal: AbortSignal | undefined,
  seen = new Set<unknown>(),
): CliIssue[] {
  if (seen.has(cause)) return [];
  seen.add(cause);
  if (cause instanceof AggregateError) {
    return cause.errors.flatMap((error) => failureIssues(error, signal, seen));
  }
  if (isOperationCancelled(cause, signal))
    return [cliIssue("cancelled", messageOfUnknown(cause))];
  if (
    signal?.aborted === true &&
    cause === signal.reason &&
    cause instanceof Error
  ) {
    return [
      cliIssue("cancelled", cause.message),
      ...failureIssues(cause.cause, signal, seen),
    ];
  }
  if (cause instanceof MaintenanceBlockedError)
    return cause.issues.map(maintenanceIssue);
  let code: string | undefined;
  if (cause instanceof WorkspaceLockTimeoutError) code = "lock-busy";
  else if (cause instanceof MetadataVersionUnsupportedError)
    code =
      cause.observedVersion > cause.supportedVersion
        ? "store-format-newer"
        : "store-format-unsupported";
  else if (cause instanceof MetadataUnavailableError)
    code =
      cause.reason === "missing"
        ? "metadata-missing"
        : "metadata-uninitialized";
  else if (cause instanceof UnsupportedLockProtocolError)
    code = "lock-protocol-unsupported";
  else if (cause instanceof NativeFileLockUnavailableError)
    code = "platform-unsupported";
  else if (cause instanceof LockProtocolCorruptError)
    code = "lock-protocol-corrupt";
  else if (cause instanceof WorkspaceLockProtocolInconsistentError)
    code = "lock-protocol-inconsistent";
  else if (
    cause instanceof MaintenancePreviewChangedError ||
    cause instanceof MetadataFingerprintChangedError
  )
    code = "preview-changed";
  else if (cause instanceof GarbageCollectionLimitError) code = "graph-limit";
  else if (
    cause instanceof Error &&
    "errcode" in cause &&
    typeof cause.errcode === "number" &&
    [5, 6].includes(cause.errcode & 0xff)
  )
    code = "store-metadata-busy";
  if (code !== undefined) {
    return [
      cliIssue(code, messageOfUnknown(cause)),
      ...(cause instanceof Error && cause.cause instanceof AggregateError
        ? failureIssues(cause.cause, signal, seen)
        : []),
    ];
  }
  if (cause instanceof Error && cause.cause !== undefined) {
    const nested = failureIssues(cause.cause, signal, seen);
    return nested.map((issue) => ({
      ...issue,
      detail: `${cause.message}: ${issue.detail}`,
    }));
  }
  return [cliIssue("io-failure", messageOfUnknown(cause))];
}

/** Cancellation is an exit class only when no operational failure remains. */
export function cliFailure(cause: unknown, signal?: AbortSignal): CliOutcome {
  const issues = failureIssues(cause, signal);
  const cancelled =
    issues.length > 0 && issues.every((issue) => issue.code === "cancelled");
  const outcome: CliOutcome = {
    status: "error",
    result: null,
    issues,
    checksPerformed: [],
  };
  if (cancelled) return { ...outcome, status: "partial", exitCode: 130 };
  const exit = exitCodeOf(outcome);
  return {
    ...outcome,
    status:
      exit === 3
        ? cause instanceof MaintenanceBlockedError ||
          cause instanceof GarbageCollectionLimitError
          ? "blocked"
          : "busy"
        : exit === 4
          ? "unsupported"
          : "error",
  };
}

/** A completed effect survives cleanup failure; the failure still takes exit 5. */
export function withCleanupOutcome(
  outcome: CliOutcome,
  cleanup: CleanupSettlement,
): CliOutcome {
  if (cleanup.kind === "settled") return outcome;
  const details = failureIssues(cleanup.cause, undefined)
    .map((issue) => issue.detail)
    .join("; ");
  return {
    ...outcome,
    status: "error",
    exitCode: 5,
    issues: [...outcome.issues, cliIssue("cleanup-failed", details)],
  };
}
