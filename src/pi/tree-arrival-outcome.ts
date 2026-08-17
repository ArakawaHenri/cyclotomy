import type { CaptureFailure } from "../application/capture.ts";
import type { ScanProblem } from "../infrastructure/workspace-scan.ts";
import type { ArrivalDisposition } from "./arrival-settlement.ts";
import type {
  CheckpointInitializationConflictExecution,
  PostMutationConflictExecution,
} from "./post-mutation.ts";
import type { RestoreProtocolOutcome } from "./workspace-mutation-protocol.ts";
import type {
  ArrivalReceipt,
  LockedArrivalOutcome,
} from "./workspace-receipt.ts";

/** Complete factual execution at one authenticated tree arrival. */
export type TreeArrivalExecution =
  | CheckpointInitializationConflictExecution
  | PostMutationConflictExecution
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

export type TreeArrivalResult = ArrivalReceipt<TreeArrivalExecution>;
export type LockedTreeArrivalOutcome =
  LockedArrivalOutcome<TreeArrivalExecution>;

/** Construct a tree-arrival outcome while its action lock is still held. */
export function lockedTreeArrivalOutcome(
  execution: TreeArrivalExecution,
  arrival: ArrivalDisposition,
): LockedTreeArrivalOutcome {
  return { execution, arrival };
}
