import { describe, expect, it, vi } from "vitest";

import { applyActiveArrivalSettlement } from "../src/pi/active-arrival-settlement.ts";
import type { CyclotomyRuntime } from "../src/pi/runtime.ts";

function runtime(
  activation: CyclotomyRuntime["activation"] = { kind: "active" },
) {
  const markSessionUnavailable = vi.fn();
  return {
    value: {
      activation,
      markSessionUnavailable,
    } as unknown as CyclotomyRuntime,
    markSessionUnavailable,
  };
}

describe("active arrival settlement", () => {
  it("deactivates on an unsettled arrival", () => {
    const arrivalFailure = new Error("arrival failed");
    const target = runtime();

    applyActiveArrivalSettlement(target.value, {
      kind: "unsettled",
      cause: arrivalFailure,
    });

    expect(target.markSessionUnavailable).toHaveBeenCalledOnce();
    expect(target.markSessionUnavailable).toHaveBeenCalledWith(arrivalFailure);
  });

  it("keeps durable protection active despite an ephemeral admission failure", () => {
    const target = runtime();

    applyActiveArrivalSettlement(target.value, {
      kind: "protected",
      evidence: {
        kind: "session-barrier",
        admission: { kind: "failed", cause: new Error("admission failed") },
      },
    });

    expect(target.markSessionUnavailable).not.toHaveBeenCalled();
  });

  it("does not rewrite an already inactive lifecycle", () => {
    const target = runtime({ kind: "intentionally-inactive" });

    applyActiveArrivalSettlement(target.value, {
      kind: "unsettled",
      cause: new Error("late failure"),
    });

    expect(target.markSessionUnavailable).not.toHaveBeenCalled();
  });
});
