import { describe, expect, it } from "vitest";

import {
  treeArrivalResult,
  type TreeArrivalResult,
} from "../src/pi/tree-arrival-outcome.ts";

describe("tree arrival result", () => {
  it("carries safety settlement independently from presentation", () => {
    const protectedResult = {
      execution: { kind: "protected" },
      arrival: {
        kind: "protected",
        evidence: {
          kind: "session-barrier",
          admission: {
            kind: "failed",
            cause: new Error("ephemeral admission failed"),
          },
        },
      },
      workspaceLockCleanup: { kind: "settled" },
    } satisfies TreeArrivalResult;

    expect(protectedResult.execution.kind).toBe("protected");
    expect(protectedResult.arrival.kind).toBe("protected");
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
});
