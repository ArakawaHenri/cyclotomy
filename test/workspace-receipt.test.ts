import { describe, expect, it } from "vitest";

import { mergeCleanupSettlements } from "../src/pi/workspace-receipt.ts";

describe("workspace receipt", () => {
  it("preserves every independent cleanup failure in order", () => {
    const first = new Error("first release failed");
    const second = new Error("second release failed");
    const cleanup = mergeCleanupSettlements(
      { kind: "settled" },
      { kind: "failed", cause: first },
      { kind: "failed", cause: second },
    );

    expect(cleanup.kind).toBe("failed");
    if (cleanup.kind === "failed") {
      expect(cleanup.cause).toBeInstanceOf(AggregateError);
      expect((cleanup.cause as AggregateError).errors).toEqual([first, second]);
      expect((cleanup.cause as AggregateError).cause).toBe(first);
    }
  });

  it("keeps repeated cleanup merges flat", () => {
    const first = new Error("first");
    const second = new Error("second");
    const third = new Error("third");
    const initial = mergeCleanupSettlements(
      { kind: "failed", cause: first },
      { kind: "failed", cause: second },
    );
    const merged = mergeCleanupSettlements(initial, {
      kind: "failed",
      cause: third,
    });

    expect(merged.kind).toBe("failed");
    if (merged.kind === "failed") {
      expect((merged.cause as AggregateError).errors).toEqual([
        first,
        second,
        third,
      ]);
    }
  });
});
