import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  applySessionHistoryForget,
  previewSessionHistoryForget,
} from "../src/application/history-forget.ts";
import {
  MaintenanceBlockedError,
  MaintenancePreviewChangedError,
} from "../src/application/maintenance-plan.ts";
import { METADATA_WRITER_PROTOCOL_FUNCTION } from "../src/infrastructure/metadata/schema.ts";
import { METADATA_VERSIONS } from "../src/infrastructure/metadata/current.ts";
import {
  openObjectStore,
  upgradeStoredTree,
} from "../src/infrastructure/object-store.ts";
import { storeMetadataPath } from "../src/infrastructure/workspace-store.ts";
import { WorkspaceLockTimeoutError } from "../src/infrastructure/workspace-lock.ts";
import { createCurrentMetadataStore } from "../src/infrastructure/metadata.ts";
import {
  bindTestMetadataWriteAuthority,
  registerTestSession,
  testMetadataWriteAuthority,
} from "./metadata-fixture.ts";
import {
  holdTestWorkspaceWriteAuthority,
  releaseTestWorkspaceWriteAuthorities,
} from "./workspace-write-authority-fixture.ts";

const roots: string[] = [];
const SESSION_ID = "session";
const SESSION_FILE = "/test-sessions/history-forget.jsonl";
const FIRST_TREE = "a".repeat(64);
const SECOND_TREE = "b".repeat(64);

afterEach(async () => {
  await releaseTestWorkspaceWriteAuthorities();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/**
 * A store with one session whose lineage carries two checkpoints. The write
 * authority is released before the test runs, because the maintenance path
 * takes the workspace lock itself.
 */
async function openTestStore(root: string) {
  const path = storeMetadataPath(root);
  const authority = await holdTestWorkspaceWriteAuthority(root);
  const store = createCurrentMetadataStore(path, authority);
  bindTestMetadataWriteAuthority(store, authority, root);
  return store;
}

async function seededStore(
  options: { readonly barrier?: boolean } = {},
): Promise<string> {
  const root = await makeRoot("cyclotomy-history-forget-");
  const store = await openTestStore(root);
  const authority = testMetadataWriteAuthority(store);
  const identity = { sessionId: SESSION_ID, sessionFile: SESSION_FILE };
  registerTestSession(store, SESSION_ID, SESSION_FILE, ["a"], ["a"]);
  const captured = store.commitCapture(authority, {
    identity,
    entryId: "a",
    activeAncestryEntryIds: ["a"],
    treeOid: FIRST_TREE,
    expectedSlot: store.getCheckpointSlot(SESSION_ID, "a"),
  });
  if (captured !== "committed") throw new Error(`capture failed: ${captured}`);
  // The child coordinate inherits the parent checkpoint before it captures.
  const admitted = store.admitResolvedLocation(authority, {
    identity,
    entryId: "b",
    activeAncestryEntryIds: ["a", "b"],
    expectedResolution: {
      kind: "checkpoint",
      entryId: "a",
      treeOid: FIRST_TREE,
    },
  });
  if (admitted !== "admitted") throw new Error(`admit failed: ${admitted}`);
  const capturedChild = store.commitCapture(authority, {
    identity,
    entryId: "b",
    activeAncestryEntryIds: ["a", "b"],
    treeOid: SECOND_TREE,
    expectedSlot: store.getCheckpointSlot(SESSION_ID, "b"),
  });
  if (capturedChild !== "committed") {
    throw new Error(`capture failed: ${capturedChild}`);
  }
  if (options.barrier === true) {
    store.raiseSessionBarrier(authority, {
      sessionId: SESSION_ID,
      sessionFile: SESSION_FILE,
    });
  }
  store.close();
  await releaseTestWorkspaceWriteAuthorities();
  return root;
}

/** Run one mutation through a fresh write authority, then release the lock. */
async function mutate<T>(
  root: string,
  operation: (store: Awaited<ReturnType<typeof openTestStore>>) => T,
): Promise<T> {
  const store = await openTestStore(root);
  try {
    return operation(store);
  } finally {
    store.close();
    await releaseTestWorkspaceWriteAuthorities();
  }
}

function readVersion(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Number(db.prepare("PRAGMA user_version").get()!.user_version);
  } finally {
    db.close();
  }
}

describe("history forget", () => {
  it("previews the exact history a forget would remove", async () => {
    const root = await seededStore();

    const preview = await previewSessionHistoryForget(root, SESSION_ID);
    expect(preview.issues).toEqual([]);
    expect(preview.inspection).toBe("snapshot");
    expect(preview.planToken).toMatch(/^[0-9a-f]{64}$/u);
    expect(preview.facts).toMatchObject({
      sessionId: SESSION_ID,
      sessionFile: SESSION_FILE,
      registrationState: "verified",
      epoch: 0,
      resetPending: false,
      slotCount: 2,
      checkpointCount: 2,
      blockedCount: 0,
      distinctTreeOidCount: 2,
      hasCaptureBarrier: false,
    });

    // A preview removes nothing and leaves the store's slot rows untouched.
    const db = new DatabaseSync(storeMetadataPath(root), {
      readOnly: true,
    });
    try {
      expect(
        db.prepare("SELECT count(*) AS count FROM checkpoint_slot").get(),
      ).toEqual({ count: 2 });
      expect(
        db
          .prepare("SELECT max(history_epoch) AS epoch FROM session_history")
          .get(),
      ).toEqual({ epoch: 0 });
    } finally {
      db.close();
    }
  });

  it("forgets the previewed history and leaves the session awaiting re-attach", async () => {
    const root = await seededStore({ barrier: true });
    const preview = await previewSessionHistoryForget(root, SESSION_ID);
    expect(preview.facts?.hasCaptureBarrier).toBe(true);

    const forgotten = await applySessionHistoryForget(
      root,
      SESSION_ID,
      preview.planToken!,
    );
    expect(forgotten.kind).toBe("completed");
    if (forgotten.kind !== "completed") throw forgotten.cause;
    expect(forgotten.cleanup.kind).toBe("settled");
    expect(forgotten.value).toEqual({
      kind: "forgotten",
      // The report is bound to the canonical store root, not the caller's path.
      storeRoot: await realpath(root),
      sessionId: SESSION_ID,
      epoch: 1,
      removedSlots: 2,
      removedCaptureBarrier: true,
      reclaimedBytes: null,
    });

    const after = await previewSessionHistoryForget(root, SESSION_ID);
    expect(after.facts).toMatchObject({
      epoch: 1,
      resetPending: true,
      slotCount: 0,
      checkpointCount: 0,
      distinctTreeOidCount: 0,
      hasCaptureBarrier: false,
    });
    // Nothing is left to decide on, so no token is offered at all.
    expect(after.planToken).toBeNull();
    expect(after.issues.map(({ code }) => code)).toEqual([
      "session-history-reset-pending",
    ]);
  });

  it("refuses a token whose history changed after the preview", async () => {
    const root = await seededStore();
    const preview = await previewSessionHistoryForget(root, SESSION_ID);

    // A re-capture that keeps every count identical must still invalidate the
    // token, because the referenced trees are what a forget deletes.
    const recaptured = await mutate(root, (store) => {
      registerTestSession(
        store,
        SESSION_ID,
        SESSION_FILE,
        ["a", "b"],
        ["a", "b"],
      );
      return store.commitCapture(testMetadataWriteAuthority(store), {
        identity: { sessionId: SESSION_ID, sessionFile: SESSION_FILE },
        entryId: "a",
        activeAncestryEntryIds: ["a"],
        treeOid: SECOND_TREE,
        expectedSlot: store.getCheckpointSlot(SESSION_ID, "a"),
      });
    });
    expect(recaptured).toBe("committed");

    await expect(
      applySessionHistoryForget(root, SESSION_ID, preview.planToken!),
    ).rejects.toThrow(MaintenancePreviewChangedError);

    const changed = await previewSessionHistoryForget(root, SESSION_ID);
    expect(changed.facts).toMatchObject({ epoch: 0, slotCount: 2 });
    expect(changed.facts?.distinctTreeOidCount).toBe(1);
    expect(changed.planToken).not.toBe(preview.planToken);
  });

  it("invalidates a preview when coordinates change but counts and distinct trees do not", async () => {
    const root = await seededStore();
    const db = new DatabaseSync(storeMetadataPath(root));
    db.function(
      METADATA_WRITER_PROTOCOL_FUNCTION,
      { deterministic: true, directOnly: false },
      () => 5,
    );
    db.prepare("INSERT INTO checkpoint_slot VALUES (?, 'c', ?, 'open')").run(
      SESSION_ID,
      SECOND_TREE,
    );
    db.prepare(
      "UPDATE checkpoint_slot SET tree_oid = ? WHERE session_id = ? AND entry_id = 'b'",
    ).run(FIRST_TREE, SESSION_ID);
    const preview = await previewSessionHistoryForget(root, SESSION_ID);
    const store = await openTestStore(root);
    const expectedFingerprint =
      store.describeSessionHistory(SESSION_ID)!.fingerprint;
    // A,A,B -> B,A,B preserves every scale count and the distinct root set.
    db.prepare(
      "UPDATE checkpoint_slot SET tree_oid = ? WHERE session_id = ? AND entry_id = 'a'",
    ).run(SECOND_TREE, SESSION_ID);
    const changed = await previewSessionHistoryForget(root, SESSION_ID);
    expect(changed.facts).toMatchObject({
      slotCount: preview.facts!.slotCount,
      checkpointCount: preview.facts!.checkpointCount,
      distinctTreeOidCount: preview.facts!.distinctTreeOidCount,
    });
    expect(changed.planToken).not.toBe(preview.planToken);
    expect(() =>
      store.forgetSessionHistory(testMetadataWriteAuthority(store), {
        sessionId: SESSION_ID,
        sessionFile: SESSION_FILE,
        expectedFingerprint,
      }),
    ).toThrow(/history changed/u);
    store.close();
    db.close();
    await releaseTestWorkspaceWriteAuthorities();
    await expect(
      applySessionHistoryForget(root, SESSION_ID, preview.planToken!),
    ).rejects.toThrow(MaintenancePreviewChangedError);
    expect(
      (await previewSessionHistoryForget(root, SESSION_ID)).facts?.slotCount,
    ).toBe(3);
  });

  it("refuses a token issued for another session or for another plan", async () => {
    const root = await seededStore();
    const preview = await previewSessionHistoryForget(root, SESSION_ID);

    await expect(
      applySessionHistoryForget(root, "other-session", preview.planToken!),
    ).rejects.toThrow(MaintenanceBlockedError);
    await expect(
      applySessionHistoryForget(root, SESSION_ID, "0".repeat(64)),
    ).rejects.toThrow(MaintenancePreviewChangedError);

    const unchanged = await previewSessionHistoryForget(root, SESSION_ID);
    expect(unchanged.facts).toMatchObject({ epoch: 0, slotCount: 2 });
    expect(unchanged.planToken).toBe(preview.planToken);
  });

  it("reports an unknown session without offering a token", async () => {
    const root = await seededStore();

    const preview = await previewSessionHistoryForget(root, "absent");
    expect(preview.facts).toBeNull();
    expect(preview.planToken).toBeNull();
    expect(preview.issues.map(({ code }) => code)).toEqual(["session-unknown"]);
    await expect(
      applySessionHistoryForget(root, "absent", "0".repeat(64)),
    ).rejects.toThrow(MaintenanceBlockedError);
  });

  it.each([1, 2, 3, 4])(
    "previews v%i without writes and migrates the approved history during apply",
    async (version) => {
      const root = await makeRoot("cyclotomy-history-forget-legacy-");
      const path = storeMetadataPath(root);
      let originalTree = "";
      for (const [kind, suffix] of [
        ["blobs", "blob"],
        ["trees", "tree"],
      ] as const) {
        const bytes = await readFile(
          new URL(
            `./fixtures/cyclotomy-0.0.1-tree/compatible.${suffix}`,
            import.meta.url,
          ),
        );
        const oid = createHash("sha256").update(bytes).digest("hex");
        const objectPath = join(
          root,
          "objects",
          kind,
          oid.slice(0, 2),
          oid.slice(2),
        );
        await mkdir(dirname(objectPath), { recursive: true });
        await writeFile(objectPath, bytes);
        if (kind === "trees") originalTree = oid;
      }
      const objects = await openObjectStore(root);
      const definition = METADATA_VERSIONS[version - 1]!;
      const prepared = await upgradeStoredTree(
        objects,
        originalTree,
        definition.treeFormat,
      );
      if (prepared.kind === "incompatible") throw prepared.cause;
      const treeOid = prepared.treeOid;
      const db = new DatabaseSync(path);
      db.function(
        METADATA_WRITER_PROTOCOL_FUNCTION,
        { deterministic: true, directOnly: false },
        () => definition.schema.writerProtocol ?? 0,
      );
      db.exec("BEGIN IMMEDIATE");
      definition.initializeWithinTransaction(db);
      db.exec("COMMIT");
      for (const session of [SESSION_ID, "survivor"]) {
        if (version < 3) {
          db.prepare(
            "INSERT INTO session_registry(session_id, session_file) VALUES (?, ?)",
          ).run(
            session,
            session === SESSION_ID ? SESSION_FILE : "/survivor.jsonl",
          );
          db.prepare(
            "INSERT INTO node_state(session_id, entry_id, tree_oid) VALUES (?, 'a', ?)",
          ).run(session, treeOid);
        } else {
          db.prepare(
            "INSERT INTO session_registry(session_id, session_file, registration_state) VALUES (?, ?, 'verified')",
          ).run(
            session,
            session === SESSION_ID ? SESSION_FILE : "/survivor.jsonl",
          );
          db.prepare(
            "INSERT INTO checkpoint_slot(session_id, entry_id, tree_oid, capture_state) VALUES (?, 'a', ?, 'open')",
          ).run(session, treeOid);
        }
      }
      if (version === 2) {
        db.prepare(
          "INSERT INTO node_write_guard(session_id, entry_id) VALUES (?, 'b')",
        ).run(SESSION_ID);
        db.prepare(
          "UPDATE session_registry SET pending_node_guard = 1 WHERE session_id = ?",
        ).run(SESSION_ID);
      } else if (version >= 3) {
        db.prepare(
          "INSERT INTO checkpoint_slot(session_id, entry_id, tree_oid, capture_state) VALUES (?, 'b', NULL, 'blocked')",
        ).run(SESSION_ID);
        db.prepare(
          "INSERT INTO session_capture_barrier(session_id) VALUES (?)",
        ).run(SESSION_ID);
      }
      db.close();

      const preview = await previewSessionHistoryForget(root, SESSION_ID);
      expect(preview.issues).toEqual([]);
      expect(preview.facts).toMatchObject({
        epoch: 0,
        slotCount: version === 1 ? 1 : 2,
        distinctTreeOidCount: 1,
      });
      expect(preview.planToken).not.toBeNull();
      expect(readVersion(path)).toBe(version);
      await expect(stat(join(root, "workspace.lock"))).rejects.toMatchObject({
        code: "ENOENT",
      });

      const result = await applySessionHistoryForget(
        root,
        SESSION_ID,
        preview.planToken!,
      );
      expect(result.kind).toBe("completed");
      if (result.kind !== "completed") throw result.cause;
      expect(result.cleanup.kind).toBe("settled");
      expect(result.value).toMatchObject({
        kind: "forgotten",
        epoch: 1,
        removedSlots: version === 1 ? 1 : 2,
        removedCaptureBarrier: version > 1,
      });
      expect(readVersion(path)).toBe(5);
      const store = await openTestStore(root);
      try {
        expect(store.describeSessionHistory(SESSION_ID)).toMatchObject({
          epoch: 1,
          resetPending: true,
          slotCount: 0,
          treeOids: [],
        });
        const survivor = store.describeSessionHistory("survivor")!;
        expect(survivor.slotCount).toBe(1);
        expect(survivor.treeOids).toHaveLength(1);
        await expect(
          objects.readTree(survivor.treeOids[0]!),
        ).resolves.toMatchObject({ format: "cyclotomy-tree-v3" });
      } finally {
        store.close();
      }
    },
  );

  it("reports an absent store instead of creating one", async () => {
    const root = await makeRoot("cyclotomy-history-forget-absent-");
    const path = storeMetadataPath(root);

    const preview = await previewSessionHistoryForget(root, SESSION_ID);
    expect(preview.inspection).toBe("unavailable");
    expect(preview.planToken).toBeNull();
    expect(preview.issues.map(({ code }) => code)).toEqual(["store-absent"]);
    await expect(stat(path)).rejects.toThrow(/ENOENT/u);
  });

  it("waits for the workspace lock instead of forgetting beside a live holder", async () => {
    const root = await seededStore();
    const preview = await previewSessionHistoryForget(root, SESSION_ID);
    await holdTestWorkspaceWriteAuthority(root);

    await expect(
      applySessionHistoryForget(root, SESSION_ID, preview.planToken!, {
        timeoutMs: 50,
      }),
    ).rejects.toThrow(WorkspaceLockTimeoutError);
    const blocked = await previewSessionHistoryForget(root, SESSION_ID);
    expect(blocked.facts).toMatchObject({ epoch: 0, slotCount: 2 });

    // Once the holder releases, the same unchanged plan still applies.
    await releaseTestWorkspaceWriteAuthorities();
    expect(
      await applySessionHistoryForget(root, SESSION_ID, preview.planToken!),
    ).toMatchObject({
      kind: "completed",
      cleanup: { kind: "settled" },
      value: { kind: "forgotten", epoch: 1, removedSlots: 2 },
    });
  });
});
