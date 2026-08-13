import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectCyclotomyGarbage } from "../src/application/gc.ts";
import {
  createCurrentMetadataStore,
  type CurrentMetadataStore,
} from "../src/infrastructure/metadata.ts";
import { openObjectStore } from "../src/infrastructure/object-store.ts";
import {
  checkpointState,
  commitTestNodeState,
  readTestSessionRegistration,
  registerTestSession,
} from "./metadata-fixture.ts";
import { publishTestBlob, publishTestTree } from "./object-store-fixture.ts";
import { ALL_MANAGED_SCOPE } from "./workspace-scope-fixture.ts";

describe("Cyclotomy garbage collection", () => {
  let directory: string;
  let metadata: CurrentMetadataStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "cyclotomy-gc-"));
    metadata = createCurrentMetadataStore(join(directory, "state.db"));
  });

  afterEach(async () => {
    metadata.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("keeps checkpoint objects rooted regardless of session-file existence", async () => {
    const store = await openObjectStore(directory);
    const blobOid = await publishTestBlob(store, Buffer.from("rooted"));
    const treeOid = await publishTestTree(
      store,
      [
        {
          path: "rooted.txt",
          type: "regular",
          blobOid,
          recreationMode: 0o644,
        },
      ],
      ALL_MANAGED_SCOPE,
    );
    const sessionFile = join(directory, "not-yet-persisted.jsonl");
    registerTestSession(metadata, "live", sessionFile, ["entry"]);
    commitTestNodeState(metadata, "live", "entry", treeOid);

    const report = await collectCyclotomyGarbage(store, metadata, {
      now: Date.now() + 1_000,
      objectGraceMs: 0,
    });

    expect(report).toMatchObject({ removedTrees: 0, removedBlobs: 0 });
    expect(
      readTestSessionRegistration(join(directory, "state.db"), "live"),
    ).toBeDefined();
    expect(checkpointState(metadata, "live", "entry")?.treeOid).toBe(treeOid);
  });

  it("removes old objects that have no durable checkpoint root", async () => {
    const store = await openObjectStore(directory);
    const blobOid = await publishTestBlob(store, Buffer.from("orphan"));
    await publishTestTree(
      store,
      [
        {
          path: "orphan.txt",
          type: "regular",
          blobOid,
          recreationMode: 0o644,
        },
      ],
      ALL_MANAGED_SCOPE,
    );

    const report = await collectCyclotomyGarbage(store, metadata, {
      now: Date.now() + 1_000,
      objectGraceMs: 0,
    });

    expect(report.removedTrees).toBe(1);
    expect(report.removedBlobs).toBe(1);
  });
});
