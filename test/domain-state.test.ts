import { describe, expect, it } from "vitest";

import {
  adoptBlockedMissingSlot,
  blockCheckpointSlot,
  captureCheckpointSlot,
  releaseCheckpointSlot,
  type CheckpointSlot,
} from "../src/domain/checkpoint-slot.ts";
import type { TreeOid } from "../src/domain/model.ts";

const treeA = "a".repeat(64) as TreeOid;
const treeB = "b".repeat(64) as TreeOid;
const openMissing = { kind: "open-missing" } as const;

describe("checkpoint slot reducer", () => {
  const slots: readonly CheckpointSlot[] = [
    openMissing,
    { kind: "open-checkpoint", treeOid: treeA },
    { kind: "blocked-missing" },
    { kind: "blocked-checkpoint", treeOid: treeA },
  ];

  it("captures exactly the two writable states", () => {
    expect(captureCheckpointSlot(slots[0]!, treeB)).toEqual({
      kind: "applied",
      slot: { kind: "open-checkpoint", treeOid: treeB },
    });
    expect(captureCheckpointSlot(slots[1]!, treeB)).toEqual({
      kind: "applied",
      slot: { kind: "open-checkpoint", treeOid: treeB },
    });
    for (const slot of slots.slice(2)) {
      expect(captureCheckpointSlot(slot, treeB)).toEqual({
        kind: "rejected",
        reason: "capture-blocked",
      });
    }
  });

  it("pins effective inherited state when blocking an empty slot", () => {
    expect(blockCheckpointSlot(openMissing, undefined)).toEqual({
      kind: "blocked-missing",
    });
    expect(blockCheckpointSlot(openMissing, treeA)).toEqual({
      kind: "blocked-checkpoint",
      treeOid: treeA,
    });
    expect(
      blockCheckpointSlot({ kind: "open-checkpoint", treeOid: treeA }, treeB),
    ).toEqual({ kind: "blocked-checkpoint", treeOid: treeA });
  });

  it("releases and adopts only an exactly authenticated blocked state", () => {
    const pinned: CheckpointSlot = {
      kind: "blocked-checkpoint",
      treeOid: treeA,
    };
    expect(releaseCheckpointSlot(pinned, treeB)).toEqual({
      kind: "rejected",
      reason: "checkpoint-mismatch",
    });
    expect(releaseCheckpointSlot(pinned, treeA)).toEqual({
      kind: "applied",
      slot: { kind: "open-checkpoint", treeOid: treeA },
    });
    expect(adoptBlockedMissingSlot({ kind: "blocked-missing" }, treeB)).toEqual(
      {
        kind: "applied",
        slot: { kind: "open-checkpoint", treeOid: treeB },
      },
    );
    expect(adoptBlockedMissingSlot(openMissing, treeB)).toEqual({
      kind: "rejected",
      reason: "not-blocked-missing",
    });
  });
});
