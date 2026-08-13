import type { TreeOid } from "./model.ts";

/**
 * The complete durable state of one exact session coordinate.
 *
 * `open-missing` is represented by the absence of a database row. Blocking is
 * exact-coordinate policy: it never changes how a descendant resolves its
 * own ancestry.
 */
export type CheckpointSlot =
  | { readonly kind: "open-missing" }
  | { readonly kind: "open-checkpoint"; readonly treeOid: TreeOid }
  | { readonly kind: "blocked-missing" }
  | { readonly kind: "blocked-checkpoint"; readonly treeOid: TreeOid };

export type BlockedCheckpointSlot = Extract<
  CheckpointSlot,
  { readonly kind: "blocked-missing" | "blocked-checkpoint" }
>;

export type SlotTransitionFailure =
  "capture-blocked" | "not-blocked-missing" | "checkpoint-mismatch";

export type SlotTransition =
  | { readonly kind: "applied"; readonly slot: CheckpointSlot }
  | { readonly kind: "rejected"; readonly reason: SlotTransitionFailure };

/** Whether this exact coordinate rejects ordinary checkpoint capture. */
export function checkpointSlotIsBlocked(slot: CheckpointSlot): boolean {
  switch (slot.kind) {
    case "open-missing":
    case "open-checkpoint":
      return false;
    case "blocked-missing":
    case "blocked-checkpoint":
      return true;
  }
}

/** Exact value equality for prepare-to-commit slot authority. */
export function checkpointSlotsEqual(
  left: CheckpointSlot,
  right: CheckpointSlot,
): boolean {
  if (left.kind !== right.kind) return false;
  return (
    (left.kind !== "open-checkpoint" && left.kind !== "blocked-checkpoint") ||
    left.treeOid ===
      (
        right as Extract<
          CheckpointSlot,
          { readonly kind: "open-checkpoint" | "blocked-checkpoint" }
        >
      ).treeOid
  );
}

function applied(slot: CheckpointSlot): SlotTransition {
  return { kind: "applied", slot };
}

/** Record current workspace reality when this exact coordinate is writable. */
export function captureCheckpointSlot(
  slot: CheckpointSlot,
  treeOid: TreeOid,
): SlotTransition {
  switch (slot.kind) {
    case "open-missing":
    case "open-checkpoint":
      return applied({ kind: "open-checkpoint", treeOid });
    case "blocked-missing":
    case "blocked-checkpoint":
      return { kind: "rejected", reason: "capture-blocked" };
  }
}

/**
 * Close one exact coordinate. An inherited effective checkpoint is pinned so
 * later writes to its ancestor cannot silently retarget this coordinate.
 */
export function blockCheckpointSlot(
  slot: CheckpointSlot,
  effectiveTreeOid: TreeOid | undefined,
): BlockedCheckpointSlot {
  switch (slot.kind) {
    case "open-missing":
      return effectiveTreeOid === undefined
        ? { kind: "blocked-missing" }
        : { kind: "blocked-checkpoint", treeOid: effectiveTreeOid };
    case "open-checkpoint":
      return { kind: "blocked-checkpoint", treeOid: slot.treeOid };
    case "blocked-missing":
    case "blocked-checkpoint":
      return slot;
  }
}

/** Re-open only the exact pinned checkpoint that was authenticated. */
export function releaseCheckpointSlot(
  slot: CheckpointSlot,
  expectedTreeOid: TreeOid,
): SlotTransition {
  if (slot.kind !== "blocked-checkpoint") {
    return { kind: "rejected", reason: "checkpoint-mismatch" };
  }
  return slot.treeOid === expectedTreeOid
    ? applied({ kind: "open-checkpoint", treeOid: slot.treeOid })
    : { kind: "rejected", reason: "checkpoint-mismatch" };
}

/** Give an explicitly confirmed initial checkpoint to a protected empty slot. */
export function adoptBlockedMissingSlot(
  slot: CheckpointSlot,
  treeOid: TreeOid,
): SlotTransition {
  return slot.kind === "blocked-missing"
    ? applied({ kind: "open-checkpoint", treeOid })
    : { kind: "rejected", reason: "not-blocked-missing" };
}

export function checkpointSlotTreeOid(
  slot: CheckpointSlot,
): TreeOid | undefined {
  return slot.kind === "open-checkpoint" || slot.kind === "blocked-checkpoint"
    ? slot.treeOid
    : undefined;
}
