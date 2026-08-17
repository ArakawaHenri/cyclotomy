import type { BlockedCheckpointSlot } from "../domain/checkpoint-slot.ts";
import { aggregateFailures } from "../infrastructure/failure-settlement.ts";

/** Settlement of the replaceable, process-local arrival authority. */
export type ArrivalAdmissionSettlement =
  | { readonly kind: "settled" }
  | { readonly kind: "failed"; readonly cause: unknown };

/** Durable proof that capture is closed at the observed arrival. */
export type ArrivalProtectionEvidence =
  | {
      readonly kind: "exact-slot";
      readonly slot: BlockedCheckpointSlot;
      /** Whether an exact-resolution request still named the protected value. */
      readonly expectation: "matched" | "stale";
      readonly admission: ArrivalAdmissionSettlement;
    }
  | {
      readonly kind: "session-barrier";
      readonly admission: ArrivalAdmissionSettlement;
    };

/**
 * Complete safety disposition of one Pi arrival.
 *
 * This deliberately contains no UI policy. `protected` is a durable success
 * even when rebuilding the replaceable in-memory admission failed.
 */
export type ArrivalDisposition =
  | { readonly kind: "admitted" }
  | {
      readonly kind: "protected";
      readonly evidence: ArrivalProtectionEvidence;
    }
  | { readonly kind: "unsettled"; readonly cause: unknown };

export type NonAdmittedArrivalDisposition = Exclude<
  ArrivalDisposition,
  { readonly kind: "admitted" }
>;

/** Durable protection of an ordinary (non-arrival-token) coordinate. */
export type LocationProtectionDisposition =
  | {
      readonly kind: "protected";
      readonly evidence: Extract<
        ArrivalProtectionEvidence,
        { readonly kind: "exact-slot" }
      >;
    }
  | { readonly kind: "unsettled"; readonly cause: unknown };

export function unsettledArrival(
  message: string,
  causes: readonly unknown[],
): Extract<ArrivalDisposition, { readonly kind: "unsettled" }> {
  const preserved = [...causes];
  return {
    kind: "unsettled",
    cause:
      preserved.length === 1
        ? new Error(message, { cause: preserved[0] })
        : aggregateFailures(preserved, message),
  };
}
