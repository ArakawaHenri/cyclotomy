import type { BlockedCheckpointSlot } from "../domain/checkpoint-slot.ts";

export type ArrivalProtection =
  | {
      readonly kind: "exact-slot";
      readonly slot: BlockedCheckpointSlot;
      readonly admission:
        | { readonly kind: "settled" }
        | { readonly kind: "failed"; readonly cause: unknown };
    }
  | { readonly kind: "session-barrier" }
  | { readonly kind: "unavailable"; readonly cause: unknown };

export function unavailableProtection(
  message: string,
  causes: readonly unknown[],
): Extract<ArrivalProtection, { readonly kind: "unavailable" }> {
  const preserved = [...causes];
  return {
    kind: "unavailable",
    cause:
      preserved.length === 1
        ? new Error(message, { cause: preserved[0] })
        : new AggregateError(preserved, message, {
            cause: preserved[0],
          }),
  };
}
