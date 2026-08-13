import { describe, expect, it } from "vitest";

import {
  messageEndNeedsSourceCapture,
  sessionStartPolicy,
} from "../src/pi/host-event-contract.ts";

describe("Pi public lifecycle contract", () => {
  it("keeps start registration and reconciliation policy in one table", () => {
    expect(sessionStartPolicy("fork")).toEqual({
      registration: "fork",
      reconciliation: "loaded",
    });
    expect(sessionStartPolicy("reload")).toEqual({
      registration: "independent",
      reconciliation: "reloaded",
    });
    expect(sessionStartPolicy("startup")).toEqual({
      registration: "independent",
      reconciliation: "loaded",
    });
  });

  it("captures only messages without another preflight boundary", () => {
    expect(messageEndNeedsSourceCapture("custom")).toBe(true);
    for (const role of [
      "user",
      "assistant",
      "toolResult",
      "bashExecution",
      "branchSummary",
      "compactionSummary",
    ] as const) {
      expect(messageEndNeedsSourceCapture(role)).toBe(false);
    }
  });
});
