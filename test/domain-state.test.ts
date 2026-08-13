import { describe, expect, it } from "vitest";

import { AuthorityCoordinator } from "../src/domain/authority.ts";
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

describe("structural authority coordinator", () => {
  it("keeps source authority live while a proposal is pending", () => {
    const authority = new AuthorityCoordinator<string, string, string>();
    authority.open("snapshot-a", "node-a");
    const lease = authority.issueCaptureLease();
    expect(lease).toBeDefined();
    expect(authority.propose("restore-b").kind).toBe("accepted");
    expect(lease === undefined || authority.captureLeaseIsCurrent(lease)).toBe(
      true,
    );

    const arrival = authority.beginArrival();
    expect(arrival.planned).toBe(true);
    expect(arrival.proposal).toBe("restore-b");
    expect(lease === undefined || authority.captureLeaseIsCurrent(lease)).toBe(
      false,
    );
    expect(authority.arrivalSource(arrival)).toEqual({
      observation: "snapshot-a",
      location: "node-a",
    });
  });

  it("keeps a proposal bound to its original source across a proven live advance", () => {
    const authority = new AuthorityCoordinator<string, string, string>();
    authority.open("snapshot-a", "node-a");
    expect(authority.propose("restore-b").kind).toBe("accepted");
    expect(authority.advance("snapshot-a+child", "node-child")).toBe(true);

    const arrival = authority.beginArrival();
    expect(arrival).toMatchObject({ planned: true, proposal: "restore-b" });
    expect(authority.arrivalSource(arrival)).toEqual({
      observation: "snapshot-a",
      location: "node-a",
    });
  });

  it("retires an ambiguous old proposal and cancels the new proposal once", () => {
    const authority = new AuthorityCoordinator<string, string, string>();
    authority.open("snapshot-a", "node-a");
    expect(authority.propose("first").kind).toBe("accepted");
    expect(authority.propose("second")).toEqual({
      kind: "retired-conflict",
    });
    expect(authority.beginArrival()).toMatchObject({ planned: false });
    authority.open("snapshot-a", "node-a");
    expect(authority.propose("retry").kind).toBe("accepted");
    expect(authority.beginArrival().proposal).toBe("retry");
  });

  it("distinguishes an unplanned arrival from an undefined proposal", () => {
    const authority = new AuthorityCoordinator<string, string, undefined>();
    authority.open("snapshot", "node");
    expect(authority.beginArrival()).toMatchObject({ planned: false });
    authority.open("snapshot", "node");
    expect(authority.propose(undefined).kind).toBe("accepted");
    expect(authority.beginArrival()).toMatchObject({
      planned: true,
      proposal: undefined,
    });
  });

  it("accepts only the current arrival and invalidates it after settlement", () => {
    const authority = new AuthorityCoordinator<string, string, string>();
    authority.open("a", "node-a");
    const stale = authority.beginArrival();
    authority.open("b", "node-b");
    const current = authority.beginArrival();
    expect(authority.settleArrival(stale, "x", "node-x")).toBe(false);
    expect(authority.settleArrival(current, "c", "node-c")).toBe(true);
    expect(authority.settleArrival(current, "d", "node-d")).toBe(false);
    expect(authority.snapshot()).toMatchObject({
      kind: "live",
      observation: "c",
      location: "node-c",
    });
  });

  it("cuts over a live authority synchronously and only once", () => {
    const authority = new AuthorityCoordinator<string, string, never>();
    authority.open("snapshot", "node");
    const capture = authority.issueCaptureLease();
    expect(authority.cutoverLive()).toBe(true);
    expect(
      capture === undefined || authority.captureLeaseIsCurrent(capture),
    ).toBe(false);
    expect(authority.cutoverLive()).toBe(false);
    expect(authority.snapshot().kind).toBe("closed");
  });
});
