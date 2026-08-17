import type { ArrivalDisposition } from "./arrival-settlement.ts";
import type { CyclotomyRuntime } from "./runtime.ts";

/** Apply the one fail-closed runtime transition shared by every active arrival. */
export function applyActiveArrivalSettlement(
  runtime: CyclotomyRuntime,
  arrival: ArrivalDisposition,
): void {
  if (runtime.activation.kind !== "active") return;
  if (arrival.kind === "unsettled") {
    runtime.markSessionUnavailable(arrival.cause);
  }
}
