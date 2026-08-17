import { describe, expect, it } from "vitest";

import { lockedTreeArrivalOutcome } from "../src/pi/tree-arrival-outcome.ts";

describe("locked tree arrival outcome", () => {
  it("keeps execution and arrival separate from the future lock receipt", () => {
    const execution = { kind: "protected" } as const;
    const arrival = {
      kind: "protected",
      evidence: {
        kind: "session-barrier",
        admission: {
          kind: "failed",
          cause: new Error("ephemeral admission failed"),
        },
      },
    } as const;
    const result = lockedTreeArrivalOutcome(execution, arrival);

    expect(result).toEqual({
      execution,
      arrival,
    });
    expect(result.execution).toBe(execution);
    expect(result.arrival).toBe(arrival);
    expect(result).not.toHaveProperty("workspaceLockCleanup");
  });

  it("keeps conflict execution receipt-free", () => {
    const execution = {
      kind: "initialization-conflict",
      cause: new Error("admission changed"),
    } as const;
    const result = lockedTreeArrivalOutcome(execution, {
      kind: "protected",
      evidence: {
        kind: "session-barrier",
        admission: { kind: "settled" },
      },
    });

    expect(result.execution).toBe(execution);
    expect(result.execution).not.toHaveProperty("arrival");
    expect(result.execution).not.toHaveProperty("arrivalProtection");
    expect(result.execution).not.toHaveProperty("workspaceLockCleanup");
  });

  it("keeps restore staging cleanup inside the execution fact", () => {
    const execution = {
      kind: "outcome",
      outcome: {
        kind: "restored",
        treeOid: "a".repeat(64),
        report: {
          created: [],
          updated: [],
          deleted: [],
          renamed: [],
          unchangedCount: 1,
          problems: [],
        },
      },
      cutover: { kind: "not-requested" },
      preparationCleanup: { kind: "settled" },
    } as const;
    const result = lockedTreeArrivalOutcome(execution, { kind: "admitted" });

    expect(result.execution).toBe(execution);
    expect(result.execution).not.toHaveProperty("workspaceLockCleanup");
    expect(result).not.toHaveProperty("workspaceLockCleanup");
  });
});
