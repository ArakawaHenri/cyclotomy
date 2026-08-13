import type { BlockedCheckpointSlot } from "../domain/checkpoint-slot.ts";
import type { ArrivalProtection } from "./arrival-protection.ts";

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

/** Convert the recovery facade's result without weakening a durable fact. */
export function dispositionFromArrivalProtection(
  protection: ArrivalProtection,
): ArrivalDisposition {
  switch (protection.kind) {
    case "exact-slot":
      return {
        kind: "protected",
        evidence: {
          kind: "exact-slot",
          slot: protection.slot,
          expectation: "matched",
          admission: protection.admission,
        },
      };
    case "session-barrier":
      return {
        kind: "protected",
        evidence: {
          kind: "session-barrier",
          // Recovery closes process-local admission before raising a barrier.
          admission: { kind: "settled" },
        },
      };
    case "unavailable":
      return { kind: "unsettled", cause: protection.cause };
  }
}

/** Compatibility view for presenters that only need the durable protection. */
export function arrivalProtectionFromDisposition(
  disposition: Exclude<ArrivalDisposition, { readonly kind: "admitted" }>,
): ArrivalProtection {
  if (disposition.kind === "unsettled") {
    return {
      kind: "unavailable",
      cause: disposition.cause,
    };
  }
  return disposition.evidence.kind === "session-barrier"
    ? { kind: "session-barrier" }
    : {
        kind: "exact-slot",
        slot: disposition.evidence.slot,
        admission: disposition.evidence.admission,
      };
}
