import { describe, expect, it } from "vitest";

import { treeArrivalResult } from "../src/pi/tree-arrival-outcome.ts";

describe("tree arrival result", () => {
  it("carries safety settlement independently from presentation", () => {
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
    const cleanup = { kind: "settled" } as const;
    const protectedResult = treeArrivalResult(execution, arrival, cleanup);

    expect(protectedResult.execution).toBe(execution);
    expect(protectedResult.arrival).toBe(arrival);
    expect(protectedResult.workspaceLockCleanup).toBe(cleanup);
    if (
      protectedResult.arrival.kind === "protected" &&
      protectedResult.arrival.evidence.admission.kind === "failed"
    ) {
      expect(protectedResult.arrival.evidence.admission.cause).toBeInstanceOf(
        Error,
      );
    }
  });

  it("makes the final arrival settlement the conflict's sole protection fact", () => {
    const first = new Error("first protection attempt failed");
    const finalArrival = {
      kind: "protected",
      evidence: {
        kind: "session-barrier",
        admission: { kind: "settled" },
      },
    } as const;

    const result = treeArrivalResult(
      {
        kind: "initialization-conflict",
        cause: new Error("admission changed"),
        arrivalProtection: { kind: "unavailable", cause: first },
      },
      finalArrival,
      { kind: "settled" },
    );

    expect(result.arrival).toBe(finalArrival);
    expect(result.execution).toMatchObject({
      kind: "initialization-conflict",
      arrivalProtection: { kind: "session-barrier" },
    });
  });

  it("preserves mutation recovery's combined workspace-lock cleanup fact", () => {
    const recoveryCleanup = new AggregateError(
      [new Error("outer release failed"), new Error("recovery release failed")],
      "both workspace-lock cleanups failed",
    );

    const result = treeArrivalResult(
      {
        kind: "post-mutation-conflict",
        reason: "control-failed",
        outcome: {
          kind: "failed",
          stage: "apply",
          cause: new Error("control failed"),
        },
        cause: new Error("control failed"),
        arrivalProtection: {
          kind: "unavailable",
          cause: new Error("arrival protection failed"),
        },
        workspaceLockCleanup: {
          kind: "failed",
          cause: recoveryCleanup,
        },
      },
      { kind: "unsettled", cause: new Error("arrival remains unsettled") },
      { kind: "failed", cause: new Error("outer release failed") },
    );

    expect(result.workspaceLockCleanup).toEqual({
      kind: "failed",
      cause: recoveryCleanup,
    });
    expect(result.execution).toMatchObject({
      kind: "post-mutation-conflict",
      workspaceLockCleanup: { kind: "failed", cause: recoveryCleanup },
    });
  });

  it("keeps a mutation outcome's canonical cleanup receipt", () => {
    const canonicalCleanup = {
      kind: "failed",
      cause: new Error("combined cleanup failed"),
    } as const;
    const result = treeArrivalResult(
      {
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
        stagingCleanup: { kind: "settled" },
        workspaceLockCleanup: canonicalCleanup,
      },
      { kind: "admitted" },
      { kind: "failed", cause: new Error("outer cleanup failed") },
    );

    expect(result.workspaceLockCleanup).toBe(canonicalCleanup);
    expect(result.execution).toMatchObject({
      kind: "outcome",
      workspaceLockCleanup: canonicalCleanup,
    });
  });
});
