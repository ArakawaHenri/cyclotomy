import type { CheckpointSlot } from "./checkpoint-slot.ts";
import type { TreeOid } from "./model.ts";

export type CheckpointLineageResolution<Coordinate> =
  | { readonly kind: "missing" }
  | {
      readonly kind: "checkpoint";
      readonly coordinate: Coordinate;
      readonly treeOid: TreeOid;
    };

export interface ReducedCheckpointLineage<Coordinate> {
  readonly resolution: CheckpointLineageResolution<Coordinate>;
  readonly targetSlot: CheckpointSlot;
}

/**
 * The sole checkpoint-inheritance law.
 *
 * Coordinates are supplied root-to-target from an already authenticated host
 * graph. A checkpoint replaces the inherited value seen above it. Missing
 * slots preserve inheritance, except that an exact blocked-missing target is
 * authoritative negative knowledge for that location. An ancestor
 * blocked-missing slot never erases a checkpoint inherited from above it.
 */
export function reduceCheckpointLineage<Coordinate>(
  rootToTarget: readonly Coordinate[],
  slotOf: (coordinate: Coordinate) => CheckpointSlot,
): ReducedCheckpointLineage<Coordinate> {
  if (rootToTarget.length === 0) {
    throw new Error("checkpoint lineage must contain a target coordinate");
  }

  let resolution: CheckpointLineageResolution<Coordinate> = {
    kind: "missing",
  };
  let targetSlot: CheckpointSlot | undefined;
  for (let index = 0; index < rootToTarget.length; index += 1) {
    const coordinate = rootToTarget[index];
    if (coordinate === undefined) {
      throw new Error("checkpoint lineage contains a sparse coordinate");
    }
    const slot = slotOf(coordinate);
    targetSlot = slot;
    if (slot.kind === "open-checkpoint" || slot.kind === "blocked-checkpoint") {
      resolution = { kind: "checkpoint", coordinate, treeOid: slot.treeOid };
    }
  }

  if (targetSlot === undefined) {
    throw new Error("checkpoint lineage has no target slot");
  }
  if (targetSlot.kind === "blocked-missing") {
    resolution = { kind: "missing" };
  }
  return { resolution, targetSlot };
}
