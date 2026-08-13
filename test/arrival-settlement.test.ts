import { describe, expect, it } from "vitest";

import {
  arrivalProtectionFromDisposition,
  dispositionFromArrivalProtection,
} from "../src/pi/arrival-settlement.ts";

describe("arrival settlement", () => {
  it("preserves every durable protection family when forming a disposition", () => {
    const admissionFailure = new Error("admission failed");
    const unavailable = new Error("protection unavailable");
    const slot = {
      kind: "blocked-checkpoint",
      treeOid: "a".repeat(64),
    } as const;

    expect(
      dispositionFromArrivalProtection({
        kind: "exact-slot",
        slot,
        admission: { kind: "failed", cause: admissionFailure },
      }),
    ).toEqual({
      kind: "protected",
      evidence: {
        kind: "exact-slot",
        slot,
        expectation: "matched",
        admission: { kind: "failed", cause: admissionFailure },
      },
    });
    expect(
      dispositionFromArrivalProtection({ kind: "session-barrier" }),
    ).toEqual({
      kind: "protected",
      evidence: {
        kind: "session-barrier",
        admission: { kind: "settled" },
      },
    });
    expect(
      dispositionFromArrivalProtection({
        kind: "unavailable",
        cause: unavailable,
      }),
    ).toEqual({ kind: "unsettled", cause: unavailable });
  });

  it("projects a disposition without weakening its durable protection", () => {
    const admissionFailure = new Error("admission failed");
    const unavailable = new Error("protection unavailable");
    const slot = { kind: "blocked-missing" } as const;

    expect(
      arrivalProtectionFromDisposition({
        kind: "protected",
        evidence: {
          kind: "exact-slot",
          slot,
          expectation: "stale",
          admission: { kind: "failed", cause: admissionFailure },
        },
      }),
    ).toEqual({
      kind: "exact-slot",
      slot,
      admission: { kind: "failed", cause: admissionFailure },
    });
    expect(
      arrivalProtectionFromDisposition({
        kind: "protected",
        evidence: {
          kind: "session-barrier",
          admission: { kind: "failed", cause: admissionFailure },
        },
      }),
    ).toEqual({ kind: "session-barrier" });
    expect(
      arrivalProtectionFromDisposition({
        kind: "unsettled",
        cause: unavailable,
      }),
    ).toEqual({ kind: "unavailable", cause: unavailable });
  });
});
