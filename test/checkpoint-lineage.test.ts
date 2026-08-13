import { describe, expect, it } from "vitest";

import { reduceCheckpointLineage } from "../src/domain/checkpoint-lineage.ts";
import type { CheckpointSlot } from "../src/domain/checkpoint-slot.ts";

const MISSING = { kind: "open-missing" } as const;
const BLOCKED = { kind: "blocked-missing" } as const;
const ROOT_TREE = "a".repeat(64);
const CHILD_TREE = "b".repeat(64);

function reduce(slots: readonly CheckpointSlot[]) {
  return reduceCheckpointLineage(
    slots.map((_, index) => String(index)),
    (coordinate) => slots[Number(coordinate)]!,
  );
}

describe("checkpoint lineage", () => {
  it("preserves inherited checkpoints through open and blocked ancestors", () => {
    expect(
      reduce([
        { kind: "open-checkpoint", treeOid: ROOT_TREE },
        BLOCKED,
        MISSING,
      ]).resolution,
    ).toEqual({ kind: "checkpoint", coordinate: "0", treeOid: ROOT_TREE });
  });

  it("lets a nearer checkpoint replace the inherited value", () => {
    expect(
      reduce([
        { kind: "open-checkpoint", treeOid: ROOT_TREE },
        { kind: "blocked-checkpoint", treeOid: CHILD_TREE },
        MISSING,
      ]).resolution,
    ).toEqual({ kind: "checkpoint", coordinate: "1", treeOid: CHILD_TREE });
  });

  it("treats exact blocked-missing as authoritative negative knowledge", () => {
    const reduced = reduce([
      { kind: "open-checkpoint", treeOid: ROOT_TREE },
      BLOCKED,
    ]);
    expect(reduced.resolution).toEqual({ kind: "missing" });
    expect(reduced.targetSlot).toEqual(BLOCKED);
  });

  it("rejects an empty lineage as a caller contract violation", () => {
    expect(() => reduceCheckpointLineage([], () => MISSING)).toThrow(
      "checkpoint lineage must contain a target coordinate",
    );
  });

  it("has no artificial ancestry-depth limit", () => {
    const lineage = Array.from({ length: 100_001 }, (_, index) => index);
    expect(
      reduceCheckpointLineage(lineage, (coordinate) =>
        coordinate === 0
          ? { kind: "open-checkpoint", treeOid: ROOT_TREE }
          : MISSING,
      ).resolution,
    ).toEqual({ kind: "checkpoint", coordinate: 0, treeOid: ROOT_TREE });
  });
});
