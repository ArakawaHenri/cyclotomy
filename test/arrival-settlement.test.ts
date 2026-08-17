import { describe, expect, it } from "vitest";

import { unsettledArrival } from "../src/pi/arrival-settlement.ts";

describe("arrival settlement", () => {
  it("preserves an explicit undefined as the sole recovery cause", () => {
    const result = unsettledArrival("recovery failed", [undefined]);

    expect(result.cause).toBeInstanceOf(Error);
    expect(result.cause).not.toBeInstanceOf(AggregateError);
    expect(Object.hasOwn(result.cause as object, "cause")).toBe(true);
    expect((result.cause as Error).cause).toBeUndefined();
  });

  it("preserves every independent failure when settlement is unavailable", () => {
    const admission = new Error("admission failed");
    const recovery = new Error("recovery failed");
    const result = unsettledArrival("arrival is unsettled", [
      admission,
      recovery,
    ]);

    expect(result.cause).toBeInstanceOf(AggregateError);
    expect((result.cause as AggregateError).errors).toEqual([
      admission,
      recovery,
    ]);
    expect((result.cause as AggregateError).cause).toBe(admission);
  });

  it("keeps repeated settlement aggregation flat", () => {
    const admission = new Error("admission failed");
    const firstRecovery = new Error("first recovery failed");
    const secondRecovery = new Error("second recovery failed");
    const earlier = unsettledArrival("first attempt failed", [
      admission,
      firstRecovery,
    ]);

    const result = unsettledArrival("all attempts failed", [
      earlier.cause,
      secondRecovery,
    ]);

    expect((result.cause as AggregateError).errors).toEqual([
      admission,
      firstRecovery,
      secondRecovery,
    ]);
  });
});
