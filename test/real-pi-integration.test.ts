import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MetadataStore } from "../src/infrastructure/metadata.ts";
import { RealPiHarness } from "./real-pi.ts";

/**
 * Integration probe against the Pi version actually installed.
 *
 * These tests deliberately stay coarse. Their job is to detect that Cyclotomy
 * still integrates with the host: event order, session-tree shape, command
 * dispatch, and the confirmation UI. Adversarial handler ordering and race
 * windows remain the fake-Pi suite's responsibility, because a real host cannot
 * be asked to produce them on demand.
 *
 * A failure here means the host contract moved, not that Cyclotomy's internal
 * logic regressed. `peerDependencies` intentionally has no upper bound, so this
 * file is the executable check on that openness.
 */

let harness: RealPiHarness | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

async function startHarness(): Promise<RealPiHarness> {
  const started = new RealPiHarness();
  harness = started;
  await started.start();
  return started;
}

function readState(
  pi: RealPiHarness,
  sessionId: string,
  entryId: string,
): string | undefined {
  const db = new MetadataStore(join(pi.storeRoot, "state.db"));
  try {
    return db.getState(sessionId, entryId)?.treeOid;
  } finally {
    db.close();
  }
}

describe("real Pi integration", () => {
  it("loads as an extension and registers both commands", async () => {
    const pi = await startHarness();

    // Read what Pi itself registered, so a renamed or dropped command fails.
    expect(pi.registeredCommandNames).toEqual(["drift", "restore"]);
    // A concrete cold-start leaf is materialized from the first observed
    // workspace so later navigation has an honest baseline.
    await expect(stat(join(pi.storeRoot, "state.db"))).resolves.toBeDefined();
    const db = new MetadataStore(join(pi.storeRoot, "state.db"));
    try {
      const treeOids = db.listReferencedTreeOids();
      expect(treeOids).toHaveLength(1);
      expect(db.getState(pi.sessionId, pi.leafId)?.treeOid).toBe(treeOids[0]);
    } finally {
      db.close();
    }
  });

  it("records a checkpoint on each real turn_end", async () => {
    const pi = await startHarness();

    await pi.writeWorkspaceFile("a.txt", "v1");
    await pi.turn();
    const first = pi.leafId;
    const firstOid = readState(pi, pi.sessionId, first);

    await pi.writeWorkspaceFile("a.txt", "v2");
    await pi.turn();
    const second = pi.leafId;
    const secondOid = readState(pi, pi.sessionId, second);

    expect(first).not.toBe(second);
    expect(firstOid).toBeDefined();
    expect(secondOid).toBeDefined();
    // Distinct workspace content must produce distinct recorded trees.
    expect(firstOid).not.toBe(secondOid);
  });

  it("reports drift through Pi's own command dispatch", async () => {
    const pi = await startHarness();
    await pi.writeWorkspaceFile("a.txt", "v1");
    await pi.turn();
    await pi.writeWorkspaceFile("a.txt", "changed");

    pi.notifications.length = 0;
    await pi.command("/drift");

    const reported = pi.notifications.map(({ message }) => message).join("\n");
    expect(reported).toContain("~ a.txt");
    // A read-only preview must not touch files.
    expect(await readFile(join(pi.workspace, "a.txt"), "utf8"))
      .toBe("changed");
  });

  it("keeps files unchanged when the restore selector is cancelled", async () => {
    const pi = await startHarness();
    await pi.writeWorkspaceFile("a.txt", "saved");
    await pi.turn();
    await pi.writeWorkspaceFile("a.txt", "current");

    pi.selectIndex = 0;
    pi.selections.length = 0;
    await pi.command("/restore");

    // Pi's real selector must offer the non-destructive option first.
    expect(pi.selections).toHaveLength(1);
    expect(pi.selections[0]!.options).toHaveLength(2);
    expect(await readFile(join(pi.workspace, "a.txt"), "utf8"))
      .toBe("current");
  });

  it("restores the workspace when the destructive option is chosen", async () => {
    const pi = await startHarness();
    await pi.writeWorkspaceFile("a.txt", "saved");
    await pi.turn();
    const leaf = pi.leafId;
    const savedOid = readState(pi, pi.sessionId, leaf);
    await pi.writeWorkspaceFile("a.txt", "current");

    pi.selectIndex = 1;
    await pi.command("/restore");

    expect(await readFile(join(pi.workspace, "a.txt"), "utf8")).toBe("saved");
    // Restore is a pure apply: the node keeps its original retry target.
    expect(readState(pi, pi.sessionId, leaf)).toBe(savedOid);
  });

  it("captures between-turn edits at the source before a new turn", async () => {
    const pi = await startHarness();
    await pi.writeWorkspaceFile("a.txt", "turn-1");
    await pi.turn();
    const source = pi.leafId;
    const afterTurn = readState(pi, pi.sessionId, source);

    // An edit made while Pi is idle belongs to the node standing there now.
    await pi.writeWorkspaceFile("a.txt", "edited-between-turns");
    await pi.turn();

    const reassigned = readState(pi, pi.sessionId, source);
    expect(afterTurn).toBeDefined();
    expect(reassigned).toBeDefined();
    expect(reassigned).not.toBe(afterTurn);
  });
});
