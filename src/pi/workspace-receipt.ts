import type { CleanupSettlement } from "../domain/cleanup-settlement.ts";
import { aggregateFailures } from "../infrastructure/failure-settlement.ts";
import type {
  ArrivalDisposition,
  NonAdmittedArrivalDisposition,
} from "./arrival-settlement.ts";

/** One execution together with the cleanup receipt owned by its workspace lock. */
export interface WorkspaceReceipt<Execution> {
  readonly execution: Execution;
  readonly workspaceLockCleanup: CleanupSettlement;
}

/** An execution paired with the arrival disposition established under its lock. */
export interface LockedArrivalOutcome<Execution> {
  readonly execution: Execution;
  readonly arrival: ArrivalDisposition;
}

/** The final arrival disposition and actual cleanup of one workspace execution. */
export interface ArrivalReceipt<Execution>
  extends WorkspaceReceipt<Execution>, LockedArrivalOutcome<Execution> {}

/** Recovery has no independent execution payload, only its final settlement. */
export interface ArrivalRecoverySettlement {
  readonly arrival: NonAdmittedArrivalDisposition;
  readonly workspaceLockCleanup: CleanupSettlement;
}

/** Combine independent lock-release receipts without losing either failure. */
export function mergeCleanupSettlements(
  ...settlements: readonly CleanupSettlement[]
): CleanupSettlement {
  const failures = settlements.flatMap((settlement) =>
    settlement.kind === "failed" ? [settlement.cause] : [],
  );
  if (failures.length === 0) return { kind: "settled" };
  if (failures.length === 1) return { kind: "failed", cause: failures[0] };
  return {
    kind: "failed",
    cause: aggregateFailures(
      failures,
      "multiple workspace-lock cleanup attempts failed",
    ),
  };
}
