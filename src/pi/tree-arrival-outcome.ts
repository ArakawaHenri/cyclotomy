import type { ScanProblem } from "../infrastructure/workspace-scan.ts";
import type { CaptureFailure } from "../application/capture.ts";
import type { ArrivalDisposition } from "./arrival-settlement.ts";
import type {
  CheckpointInitializationConflict,
  CleanupSettlement,
  PostMutationConflict,
} from "./post-mutation.ts";
import { arrivalProtectionFromDisposition } from "./arrival-settlement.ts";
import type { RestoreProtocolOutcome } from "./workspace-mutation-protocol.ts";

/** Complete result of one authenticated tree-arrival execution. */
export type TreeArrivalExecution =
  | CheckpointInitializationConflict
  | PostMutationConflict
  | {
      readonly kind:
        | "location-changed"
        | "target-changed"
        | "preview-stale"
        | "busy"
        | "no-node"
        | "inherited"
        | "materialized"
        | "detached"
        | "protected";
    }
  | {
      readonly kind: "scan-incomplete";
      readonly problems: readonly ScanProblem[];
    }
  | { readonly kind: "scan-failed"; readonly cause: unknown }
  | { readonly kind: "capture-failed"; readonly failure: CaptureFailure }
  | { readonly kind: "failed"; readonly cause: unknown }
  | RestoreProtocolOutcome;

/**
 * A tree boundary is not complete until its arrival authority is settled.
 * Presentation remains a separate interpretation of `execution`.
 */
export interface TreeArrivalResult {
  readonly execution: TreeArrivalExecution;
  readonly arrival: ArrivalDisposition;
  readonly workspaceLockCleanup: CleanupSettlement;
}

/**
 * Build the one public tree-arrival fact. A retried durable settlement replaces
 * stale recovery evidence embedded in a conflict, so presenters cannot report
 * two incompatible protection outcomes for the same arrival.
 */
export function treeArrivalResult(
  execution: TreeArrivalExecution,
  arrival: ArrivalDisposition,
  workspaceLockCleanup: CleanupSettlement,
): TreeArrivalResult {
  let settledExecution = execution;
  if (
    arrival.kind !== "admitted" &&
    (execution.kind === "initialization-conflict" ||
      execution.kind === "post-mutation-conflict")
  ) {
    settledExecution = {
      ...execution,
      arrivalProtection: arrivalProtectionFromDisposition(arrival),
    };
  }
  let settledWorkspaceLockCleanup = workspaceLockCleanup;
  if (
    settledExecution.kind === "post-mutation-conflict" ||
    settledExecution.kind === "outcome"
  ) {
    // MutationProtocol already folds the outer action-lock receipt together
    // with any recovery-lock receipt. Keep that canonical value instead of
    // replacing it with the less complete outer receipt.
    settledWorkspaceLockCleanup = settledExecution.workspaceLockCleanup;
    settledExecution = {
      ...settledExecution,
      workspaceLockCleanup: settledWorkspaceLockCleanup,
    };
  }
  return {
    execution: settledExecution,
    arrival,
    workspaceLockCleanup: settledWorkspaceLockCleanup,
  };
}
