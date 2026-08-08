import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  collectCyclotomyGarbage,
  collectSessionMetadataGarbage,
} from "../src/application/gc.ts";
import { MetadataStore } from "../src/infrastructure/metadata.ts";
import { openObjectStore } from "../src/infrastructure/object-store.ts";
import { publishTestBlob, publishTestTree } from "./object-store-fixture.ts";
import { ALL_MANAGED_SCOPE } from "./workspace-scope-fixture.ts";

const oidA = "a".repeat(64);

describe("session metadata garbage collection", () => {
  let directory: string;
  let metadata: MetadataStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-gc-"));
    metadata = new MetadataStore(join(directory, "state.db"));
  });

  afterEach(async () => {
    metadata.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("requires a retained second missing-file observation before pruning", async () => {
    const sessionFile = join(directory, "deleted-session.jsonl");
    metadata.touchSession("s1", sessionFile);
    metadata.setState("s1", "e1", oidA);

    const first = await collectSessionMetadataGarbage(metadata, {
      now: 100,
      retentionMs: 100,
    });
    expect(first).toMatchObject({
      newlyMissingSessions: 1,
      stillMissingSessions: 0,
      removedSessions: 0,
      removedMetadataRows: 0,
    });
    expect(metadata.getState("s1", "e1")?.treeOid).toBe(oidA);

    const second = await collectSessionMetadataGarbage(metadata, {
      now: 200,
      retentionMs: 100,
    });
    expect(second).toMatchObject({
      newlyMissingSessions: 0,
      stillMissingSessions: 1,
      removedSessions: 1,
      removedNodeStates: 1,
      removedMetadataRows: 2,
    });
    expect(metadata.getState("s1", "e1")).toBeUndefined();
  });

  it("cancels missing state when the session file reappears", async () => {
    const sessionFile = join(directory, "reappeared-session.jsonl");
    metadata.touchSession("s1", sessionFile);
    metadata.setState("s1", "e1", oidA);

    await collectSessionMetadataGarbage(metadata, {
      now: 100,
      retentionMs: 100,
    });
    await writeFile(sessionFile, "{}\n", "utf8");
    const present = await collectSessionMetadataGarbage(metadata, {
      now: 200,
      retentionMs: 100,
    });
    expect(present).toMatchObject({
      presentSessions: 1,
      removedSessions: 0,
    });
    expect(metadata.listRegisteredSessions()[0]).toMatchObject({
      missingSince: null,
      missingObservedAt: null,
    });

    await rm(sessionFile);
    const missingAgain = await collectSessionMetadataGarbage(metadata, {
      now: 300,
      retentionMs: 100,
    });
    expect(missingAgain).toMatchObject({
      newlyMissingSessions: 1,
      removedSessions: 0,
    });
    expect(metadata.getState("s1", "e1")?.treeOid).toBe(oidA);
  });

  it("re-probes an eligible session immediately before destructive pruning", async () => {
    const sessionFile = join(directory, "racing-resume.jsonl");
    metadata.touchSession("s1", sessionFile);
    metadata.setState("s1", "e1", oidA);
    await collectSessionMetadataGarbage(metadata, {
      now: 100,
      retentionMs: 10,
      probeSessionFile: async () => "missing",
    });

    let probes = 0;
    const report = await collectSessionMetadataGarbage(metadata, {
      now: 200,
      retentionMs: 10,
      probeSessionFile: async () => {
        probes += 1;
        if (probes === 1) {
          // The file appears immediately after the first missing observation,
          // before the destructive candidate is selected.
          await writeFile(sessionFile, "{}\n", "utf8");
          return "missing";
        }
        return "present";
      },
    });

    expect(probes).toBe(2);
    expect(report.removedSessions).toBe(0);
    expect(metadata.getState("s1", "e1")?.treeOid).toBe(oidA);
    expect(metadata.listRegisteredSessions()[0]).toMatchObject({
      missingSince: null,
      missingObservedAt: null,
    });
  });

  it("prunes each exact observation synchronously after its final probe", async () => {
    const firstFile = join(directory, "first.jsonl");
    const secondFile = join(directory, "second.jsonl");
    metadata.touchSession("s1", firstFile);
    metadata.touchSession("s2", secondFile);
    metadata.setState("s1", "e1", oidA);
    metadata.setState("s2", "e2", oidA);
    await collectSessionMetadataGarbage(metadata, {
      now: 100,
      retentionMs: 10,
      probeSessionFile: async () => "missing",
    });

    const events: string[] = [];
    const pruneMissingSession = metadata.pruneMissingSession.bind(metadata);
    vi.spyOn(metadata, "pruneMissingSession").mockImplementation((options) => {
      events.push(`prune:${options.expectedSessionId}`);
      return pruneMissingSession(options);
    });
    const report = await collectSessionMetadataGarbage(metadata, {
      now: 200,
      retentionMs: 10,
      probeSessionFile: async (sessionFile) => {
        events.push(
          `probe:${sessionFile === firstFile ? "s1" : "s2"}`,
        );
        return "missing";
      },
    });

    expect(events).toEqual([
      "probe:s1",
      "probe:s2",
      "probe:s1",
      "prune:s1",
      "probe:s2",
      "prune:s2",
    ]);
    expect(report).toMatchObject({
      removedSessions: 2,
      removedNodeStates: 2,
      removedMetadataRows: 4,
    });
  });

  it("preserves rows when probing is inconclusive", async () => {
    metadata.touchSession("s1", "/unreadable/session.jsonl");
    metadata.setState("s1", "e1", oidA);
    const report = await collectSessionMetadataGarbage(metadata, {
      now: 1_000,
      retentionMs: 0,
      probeSessionFile: async () => "unknown",
    });
    expect(report).toMatchObject({
      unknownSessions: 1,
      newlyMissingSessions: 0,
      removedSessions: 0,
    });
    expect(metadata.getState("s1", "e1")?.treeOid).toBe(oidA);
  });

  it("reports object and metadata collection separately", async () => {
    const sessionFile = join(directory, "deleted.jsonl");
    const store = await openObjectStore(directory);
    const blobOid = await publishTestBlob(store, Buffer.from("rooted"));
    const treeOid = await publishTestTree(store, [
      {
        path: "rooted.txt",
        type: "regular",
        blobOid,
        recreationMode: 0o644,
      },
    ], ALL_MANAGED_SCOPE);
    metadata.touchSession("s1", sessionFile);
    metadata.setState("s1", "e1", treeOid);
    metadata.observeSessionMissing("s1", sessionFile, 10);

    const report = await collectCyclotomyGarbage(
      directory,
      store,
      metadata,
      {
        now: 20,
        retentionMs: 0,
        objectGraceMs: 0,
      },
    );
    expect(report).toMatchObject({
      removedTrees: 0,
      removedBlobs: 0,
      metadata: {
        removedSessions: 1,
        removedNodeStates: 1,
        removedMetadataRows: 2,
      },
    });
  });
});
