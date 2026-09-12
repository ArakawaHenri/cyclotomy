import {
  readTestSessionHistory,
  resetTestSessionHistory,
} from "./session-history-fixture.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  createCurrentMetadataStore,
  MetadataHistoryResetError,
  openCurrentMetadataStore as openCurrentMetadataStoreWithLease,
  type CurrentMetadataStore,
} from "../src/infrastructure/metadata.ts";
import { METADATA_WRITER_PROTOCOL_FUNCTION } from "../src/infrastructure/metadata/schema.ts";
import { validateMetadataVersion } from "../src/infrastructure/metadata/version.ts";
import {
  V4_METADATA_VERSION,
  V4_METADATA_WRITER_PROTOCOL,
} from "../src/infrastructure/metadata/versions/v4.ts";
import { V5_METADATA_VERSION } from "../src/infrastructure/metadata/versions/v5.ts";
import {
  bindTestMetadataWriteAuthority,
  checkpointIsBlocked,
  checkpointState,
  finalizeTestSessionProjection,
  readTestSessionRegistration,
  registerTestSession,
  testMetadataWriteAuthority,
  testMetadataWriteAuthorityBinding,
} from "./metadata-fixture.ts";
import {
  holdTestWorkspaceWriteAuthority,
  releaseTestWorkspaceWriteAuthorities,
} from "./workspace-write-authority-fixture.ts";

const roots: string[] = [];
const SESSION_FILE = "/test-sessions/history.jsonl";
const FIRST_TREE = "a".repeat(64);
const SECOND_TREE = "b".repeat(64);

afterEach(async () => {
  await releaseTestWorkspaceWriteAuthorities();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

interface TestStore {
  readonly root: string;
  readonly path: string;
  readonly store: CurrentMetadataStore;
}

async function createStore(): Promise<TestStore> {
  const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-v5-"));
  roots.push(root);
  const path = join(root, "state.db");
  const authority = await holdTestWorkspaceWriteAuthority(root);
  const store = createCurrentMetadataStore(path, authority);
  bindTestMetadataWriteAuthority(store, authority, root);
  return { root, path, store };
}

async function reopen({
  root,
  path,
}: Pick<TestStore, "root" | "path">): Promise<CurrentMetadataStore> {
  const authority = await holdTestWorkspaceWriteAuthority(root);
  const store = await openCurrentMetadataStoreWithLease(
    path,
    {
      prepareTreeOidUpgrades: async (treeOids) =>
        new Map(treeOids.map((treeOid) => [treeOid, treeOid])),
    },
    authority,
  );
  bindTestMetadataWriteAuthority(store, authority, root);
  return store;
}

function authorityOf(store: CurrentMetadataStore) {
  return testMetadataWriteAuthority(store);
}

function sessionHistory(store: CurrentMetadataStore, sessionId: string) {
  return readTestSessionHistory(
    testMetadataWriteAuthorityBinding(store).storeRoot,
    sessionId,
  );
}

function resetHistory(store: CurrentMetadataStore, sessionId: string): void {
  const { storeRoot, authority } = testMetadataWriteAuthorityBinding(store);
  resetTestSessionHistory(storeRoot, sessionId, authority);
}

function registrationOf(root: string, sessionId: string) {
  return readTestSessionRegistration(join(root, "state.db"), sessionId);
}

function captureAt(
  store: CurrentMetadataStore,
  sessionId: string,
  sessionFile: string,
  coordinates: readonly string[],
  index: number,
  treeOid: string,
): void {
  const ancestry = coordinates.slice(0, index + 1);
  const entryId = ancestry.at(-1)!;
  const result = store.commitCapture(authorityOf(store), {
    identity: { sessionId, sessionFile },
    entryId,
    activeAncestryEntryIds: ancestry,
    treeOid,
    expectedSlot: store.getCheckpointSlot(sessionId, entryId),
  });
  if (result !== "committed") {
    throw new Error(`failed to capture ${sessionId}/${entryId}: ${result}`);
  }
}

/**
 * Register one lineage and checkpoint the coordinates that carry a tree. Each
 * coordinate is admitted by inheritance before it is captured, which is the
 * same sequence a growing session performs.
 */
function seedLineage(
  store: CurrentMetadataStore,
  sessionId: string,
  coordinates: readonly string[],
  trees: Readonly<Record<string, string>>,
  sessionFile: string = SESSION_FILE,
): void {
  const root = coordinates[0];
  if (root === undefined) throw new Error("a seeded lineage needs a root");
  registerTestSession(store, sessionId, sessionFile, [root], [root]);
  if (trees[root] !== undefined) {
    captureAt(store, sessionId, sessionFile, coordinates, 0, trees[root]);
  }
  for (let index = 1; index < coordinates.length; index += 1) {
    const ancestry = coordinates.slice(0, index + 1);
    const entryId = ancestry.at(-1)!;
    const { resolution } = store.resolveLineage(sessionId, ancestry);
    if (resolution.kind !== "checkpoint") {
      throw new Error(
        `seeded lineage lost its inherited checkpoint at ${entryId}`,
      );
    }
    const admitted = store.admitResolvedLocation(authorityOf(store), {
      identity: { sessionId, sessionFile },
      entryId,
      activeAncestryEntryIds: ancestry,
      expectedResolution: resolution,
    });
    if (admitted !== "admitted") {
      throw new Error(`failed to admit ${sessionId}/${entryId}: ${admitted}`);
    }
    const treeOid = trees[entryId];
    if (treeOid !== undefined) {
      captureAt(store, sessionId, sessionFile, coordinates, index, treeOid);
    }
  }
}

function capture(
  store: CurrentMetadataStore,
  sessionId: string,
  entryId: string,
  entries: readonly string[],
  treeOid: string,
  sessionFile: string = SESSION_FILE,
): ReturnType<CurrentMetadataStore["commitCapture"]> {
  return store.commitCapture(authorityOf(store), {
    identity: { sessionId, sessionFile },
    entryId,
    activeAncestryEntryIds: entries,
    treeOid,
    expectedSlot: store.getCheckpointSlot(sessionId, entryId),
  });
}

describe("metadata v5 session history generation", () => {
  it("migrates a published v4 store without touching slots and backfills every identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-v4-store-"));
    roots.push(root);
    const path = join(root, "state.db");
    const db = new DatabaseSync(path);
    db.function(
      METADATA_WRITER_PROTOCOL_FUNCTION,
      { deterministic: true, directOnly: false },
      () => V4_METADATA_WRITER_PROTOCOL,
    );
    db.exec("BEGIN IMMEDIATE");
    V4_METADATA_VERSION.initializeWithinTransaction(db);
    db.exec("COMMIT");
    db.prepare(
      `INSERT INTO session_registry(session_id, session_file, registration_state)
       VALUES ('legacy', ?, 'verified')`,
    ).run(SESSION_FILE);
    db.prepare(
      `INSERT INTO checkpoint_slot(session_id, entry_id, tree_oid, capture_state)
       VALUES ('legacy', 'first', ?, 'open')`,
    ).run(FIRST_TREE);
    db.prepare(
      `INSERT INTO checkpoint_slot(session_id, entry_id, tree_oid, capture_state)
       VALUES ('legacy', 'second', NULL, 'blocked')`,
    ).run();
    const publishedSlots = db
      .prepare(
        `SELECT session_id, entry_id, tree_oid, capture_state FROM checkpoint_slot
         ORDER BY entry_id`,
      )
      .all();
    db.close();

    const store = await reopen({ root, path });
    try {
      expect(sessionHistory(store, "legacy")).toMatchObject({
        sessionId: "legacy",
        sessionFile: SESSION_FILE,
        registrationState: "verified",
        epoch: 0,
        resetPending: false,
        slotCount: 2,
        checkpointCount: 1,
        blockedCount: 1,
        hasCaptureBarrier: false,
        treeOids: [FIRST_TREE],
      });
      const migrated = new DatabaseSync(path, { readOnly: true });
      expect(
        migrated
          .prepare(
            `SELECT session_id, entry_id, tree_oid, capture_state
             FROM checkpoint_slot ORDER BY entry_id`,
          )
          .all(),
      ).toEqual(publishedSlots);
      validateMetadataVersion(migrated, V5_METADATA_VERSION);
      migrated.close();
    } finally {
      store.close();
    }

    const staleConnection = new DatabaseSync(path);
    staleConnection.function(
      METADATA_WRITER_PROTOCOL_FUNCTION,
      { deterministic: true, directOnly: false },
      () => V4_METADATA_WRITER_PROTOCOL,
    );
    expect(() =>
      staleConnection
        .prepare(
          `UPDATE session_history SET history_epoch = history_epoch + 1
           WHERE session_id = 'legacy'`,
        )
        .run(),
    ).toThrow(/writer protocol mismatch/u);
    staleConnection.close();
  });

  it("refuses ordinary writes until a stable attach completes the reset", async () => {
    const fixture = await createStore();
    const { root, store } = fixture;
    seedLineage(store, "session", ["a", "b"], { a: FIRST_TREE });
    expect(
      store.raiseSessionBarrier(authorityOf(store), {
        sessionId: "session",
        sessionFile: SESSION_FILE,
      }),
    ).toBe(true);
    resetHistory(store, "session");

    // The connection that witnessed the forget keeps the retired generation
    // and is refused, and the failure is durable rather than a local retry.
    for (const write of [
      () => capture(store, "session", "a", ["a"], FIRST_TREE),
      () =>
        store.raiseSessionBarrier(authorityOf(store), {
          sessionId: "session",
          sessionFile: SESSION_FILE,
        }),
      () =>
        store.protectLocation(authorityOf(store), {
          identity: { sessionId: "session", sessionFile: SESSION_FILE },
          entryId: "a",
          activeAncestryEntryIds: ["a"],
          expectation: { kind: "any-current" },
        }),
    ]) {
      expect(write).toThrow(MetadataHistoryResetError);
    }
    expect(registrationOf(root, "session")?.captureBarrier).toBe(false);
    store.close();

    // A connection that never touched the session is refused as well: the
    // pending reset is durable state, not a per-connection accident.
    const second = await reopen(fixture);
    try {
      expect(() =>
        second.protectLocation(authorityOf(second), {
          identity: { sessionId: "session", sessionFile: SESSION_FILE },
          entryId: "a",
          activeAncestryEntryIds: ["a"],
          expectation: { kind: "any-current" },
        }),
      ).toThrow(/reset is pending/u);
      expect(sessionHistory(second, "session")).toMatchObject({
        epoch: 1,
        resetPending: true,
      });
    } finally {
      second.close();
    }
  });

  it("completes the reset at the next stable attach with protection rows only", async () => {
    const fixture = await createStore();
    seedLineage(fixture.store, "session", ["a", "b", "c"], {
      a: FIRST_TREE,
      b: SECOND_TREE,
    });
    resetHistory(fixture.store, "session");
    fixture.store.close();

    const store = await reopen(fixture);
    try {
      expect(
        finalizeTestSessionProjection(store, {
          targetSessionId: "session",
          targetSessionFile: SESSION_FILE,
          retainedEntryIds: ["a", "b", "c"],
          activeAncestryEntryIds: ["a", "b", "c"],
          seed: { kind: "fresh" },
        }),
      ).toEqual({ kind: "existing", historyReset: true });
      // Only the two coordinates that carried trees need a protection row; the
      // reachable leaf stays open-missing, which is the absence of a row.
      expect(sessionHistory(store, "session")).toMatchObject({
        epoch: 1,
        resetPending: false,
        slotCount: 2,
        checkpointCount: 0,
        blockedCount: 2,
        treeOids: [],
      });
      expect(store.getCheckpointSlot("session", "c")).toEqual({
        kind: "open-missing",
      });
      for (const entryId of ["a", "b"]) {
        expect(
          checkpointIsBlocked(store, "session", entryId),
          `coordinate ${entryId} must stay protected against silent reuse`,
        ).toBe(true);
        expect(checkpointState(store, "session", entryId)).toBeUndefined();
      }

      // Attaching again is idempotent: only an authorized forget advances the
      // generation, so the completed attach is not a second reset.
      expect(
        finalizeTestSessionProjection(store, {
          targetSessionId: "session",
          targetSessionFile: SESSION_FILE,
          retainedEntryIds: ["a", "b", "c"],
          activeAncestryEntryIds: ["a", "b", "c"],
          seed: { kind: "fresh" },
        }),
      ).toEqual({ kind: "existing", historyReset: false });
      expect(sessionHistory(store, "session")).toMatchObject({
        epoch: 1,
        resetPending: false,
        slotCount: 2,
      });

      // The new generation captures normally over the protection rows.
      expect(capture(store, "session", "c", ["a", "b", "c"], FIRST_TREE)).toBe(
        "committed",
      );
      expect(sessionHistory(store, "session")).toMatchObject({
        epoch: 1,
        slotCount: 3,
        checkpointCount: 1,
        treeOids: [FIRST_TREE],
      });
    } finally {
      store.close();
    }
  });

  it("keeps stale writes fenced after an external history reset", async () => {
    const fixture = await createStore();
    const stale = fixture.store;
    seedLineage(stale, "session", ["a", "b"], { a: FIRST_TREE });
    const fresh = await reopen(fixture);
    try {
      resetHistory(fresh, "session");
      finalizeTestSessionProjection(fresh, {
        targetSessionId: "session",
        targetSessionFile: SESSION_FILE,
        retainedEntryIds: ["a", "b"],
        activeAncestryEntryIds: ["a", "b"],
        seed: { kind: "fresh" },
      });

      for (let attempt = 0; attempt < 2; attempt += 1) {
        for (const write of [
          () => capture(stale, "session", "b", ["a", "b"], FIRST_TREE),
          () =>
            stale.protectLocation(authorityOf(stale), {
              identity: { sessionId: "session", sessionFile: SESSION_FILE },
              entryId: "b",
              activeAncestryEntryIds: ["a", "b"],
              expectation: { kind: "any-current" },
            }),
          () =>
            stale.raiseSessionBarrier(authorityOf(stale), {
              sessionId: "session",
              sessionFile: SESSION_FILE,
            }),
        ]) {
          expect(write).toThrow(MetadataHistoryResetError);
        }
      }
      expect(fresh.listReferencedTreeOids()).toEqual([]);
      expect(
        fresh.hasSessionBarrier({
          sessionId: "session",
          sessionFile: SESSION_FILE,
        }),
      ).toBe(false);
      expect(capture(fresh, "session", "b", ["a", "b"], SECOND_TREE)).toBe(
        "committed",
      );

      finalizeTestSessionProjection(stale, {
        targetSessionId: "session",
        targetSessionFile: SESSION_FILE,
        retainedEntryIds: ["a", "b"],
        activeAncestryEntryIds: ["a", "b"],
        seed: { kind: "fresh" },
      });
      expect(capture(stale, "session", "b", ["a", "b"], SECOND_TREE)).toBe(
        "committed",
      );
      expect(sessionHistory(stale, "session")).toMatchObject({
        epoch: 1,
        resetPending: false,
      });
    } finally {
      stale.close();
      fresh.close();
    }
  });

  it("cannot resurrect forgotten history through a fork projection", async () => {
    const { store } = await createStore();
    try {
      seedLineage(store, "session", ["a", "b"], {
        a: FIRST_TREE,
        b: SECOND_TREE,
      });
      resetHistory(store, "session");

      const projection = store.exportForkProjection({
        parentSessionFile: SESSION_FILE,
        retainedEntryIds: ["a", "b"],
      });
      expect(projection?.coordinates).toEqual([
        { entryId: "a", slot: { kind: "open-missing" } },
        { entryId: "b", slot: { kind: "open-missing" } },
      ]);

      expect(
        finalizeTestSessionProjection(store, {
          targetSessionId: "child",
          targetSessionFile: "/test-sessions/child.jsonl",
          retainedEntryIds: ["a", "b"],
          activeAncestryEntryIds: ["a", "b"],
          seed: { kind: "fork", projection: projection! },
        }),
      ).toEqual({ kind: "registered", historyReset: false });
      expect(store.listReferencedTreeOids()).toEqual([]);
      expect(checkpointState(store, "child", "a")).toBeUndefined();
      expect(checkpointState(store, "child", "b")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("keeps a forgotten generation retired across reopen", async () => {
    const fixture = await createStore();
    seedLineage(fixture.store, "session", ["a"], { a: FIRST_TREE });
    resetHistory(fixture.store, "session");
    fixture.store.close();

    const store = await reopen(fixture);
    try {
      // Reopening reads the stored generation: it neither re-increments the
      // epoch nor restores a coordinate the forget removed.
      expect(sessionHistory(store, "session")).toMatchObject({
        epoch: 1,
        resetPending: true,
        slotCount: 0,
        treeOids: [],
      });
      expect(() => capture(store, "session", "a", ["a"], FIRST_TREE)).toThrow(
        /reset is pending/u,
      );
    } finally {
      store.close();
    }
  });
});
