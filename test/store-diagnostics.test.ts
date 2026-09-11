import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  diagnoseStore,
  evaluateStoreFileCapacityHint,
  readStoreHistory,
  SESSION_CHECKPOINTED_SLOT_LIMIT,
  STORE_FILE_BYTE_LIMIT,
} from "../src/application/store-diagnostics.ts";
import { readStoreInventory } from "../src/application/store-inventory.ts";
import type { FilesystemKindProbe } from "../src/infrastructure/filesystem-kind.ts";
import { nativeLockProtocolMarkerBytes } from "../src/infrastructure/lock-protocol.ts";
import {
  CURRENT_METADATA_VERSION,
  METADATA_VERSIONS,
} from "../src/infrastructure/metadata/current.ts";
import { METADATA_WRITER_PROTOCOL_FUNCTION } from "../src/infrastructure/metadata/schema.ts";
import { acquireWorkspaceLock } from "../src/infrastructure/workspace-lock.ts";

const roots: string[] = [];

async function storeRoot(): Promise<string> {
  // realpath so platform temp aliases (/var vs /private/var) compare equal.
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "cyclotomy-diagnostics-")),
  );
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const LOCAL_PROBE: FilesystemKindProbe = async () => ({
  kind: "local",
  source: "linux-statfs",
  filesystemType: "ext4",
  detail: null,
});

function databasePathOf(root: string): string {
  return join(root, "state.db");
}

function initializeStore(db: DatabaseSync, version: number): void {
  const schema = METADATA_VERSIONS[version - 1]!;
  db.function(
    METADATA_WRITER_PROTOCOL_FUNCTION,
    { deterministic: true, directOnly: false },
    () => schema.schema.writerProtocol ?? 0,
  );
  db.exec("BEGIN IMMEDIATE");
  schema.initializeWithinTransaction(db);
  db.exec("COMMIT");
}

function openStore(root: string, version: number): DatabaseSync {
  const db = new DatabaseSync(databasePathOf(root));
  initializeStore(db, version);
  return db;
}

function createV4Store(root: string): DatabaseSync {
  return openStore(root, 4);
}

function registerSession(
  db: DatabaseSync,
  sessionId: string,
  registrationState: "pending" | "verified" = "verified",
): void {
  db.prepare(
    `INSERT INTO session_registry(session_id, session_file, registration_state)
     VALUES (?, ?, ?)`,
  ).run(sessionId, `/sessions/${sessionId}.jsonl`, registrationState);
}

function putSlot(
  db: DatabaseSync,
  sessionId: string,
  entryId: string,
  treeOid: string | null,
  captureState: "open" | "blocked" = "open",
): void {
  db.prepare(
    `INSERT INTO checkpoint_slot(session_id, entry_id, tree_oid, capture_state)
     VALUES (?, ?, ?, ?)`,
  ).run(sessionId, entryId, treeOid, captureState);
}

async function plantNativeProtocol(root: string): Promise<void> {
  await writeFile(join(root, "workspace.lock"), "");
  await writeFile(
    join(root, "lock-protocol.json"),
    nativeLockProtocolMarkerBytes(),
  );
}

function issueCodes(issues: readonly { readonly code: string }[]): string[] {
  return issues.map(({ code }) => code);
}

describe("store doctor", () => {
  it("reports an absent store without creating anything", async () => {
    const root = await storeRoot();
    const report = await diagnoseStore(root, {
      filesystemKindProbe: LOCAL_PROBE,
    });

    expect(report.storePresent).toBe(false);
    expect(report.metadata.status).toEqual({ kind: "absent" });
    expect(report.metadata.state).toBe("unavailable");
    expect(report.metadata.sessionCount).toBeNull();
    expect(report.metadata.slots).toBeNull();
    expect(report.metadata.physical.fileBytes).toBeNull();
    expect(report.lock.diagnostic).toBeNull();
    expect(report.lock.state).toBe("unavailable");
    expect(issueCodes(report.issues)).toEqual(["store-absent"]);
    expect(report.issues[0]!.severity).toBe("info");
    expect(report.checksPerformed).toContainEqual({
      id: "session-scale",
      state: "unavailable",
    });
    expect(await readdir(root)).toEqual([]);
  });

  it("reports a readable V4 store with per-session scale and physical observations", async () => {
    const root = await storeRoot();
    const db = createV4Store(root);
    registerSession(db, "session-a");
    putSlot(db, "session-a", "e1", "tree-1");
    putSlot(db, "session-a", "e2", null, "blocked");
    putSlot(db, "session-a", "e3", "tree-1");
    registerSession(db, "session-b", "pending");
    db.close();

    const report = await diagnoseStore(root, {
      filesystemKindProbe: LOCAL_PROBE,
    });

    expect(report.storePresent).toBe(true);
    expect(report.metadata.status).toEqual({ kind: "ready" });
    expect(report.metadata.state).toBe("snapshot");
    expect(report.metadata.physicalState).toBe("observational");
    expect(report.metadata.version).toBe(4);
    expect(report.metadata.supportedVersion).toBe(
      CURRENT_METADATA_VERSION.version,
    );
    expect(report.metadata.sessionHistoryAvailable).toBe(false);
    expect(report.metadata.sessionCount).toBe(2);
    expect(report.metadata.slots).toEqual({
      totalSlotCount: 3,
      checkpointedSlotCount: 2,
      blockedSlotCount: 1,
      distinctTreeOidCount: 1,
    });
    expect(report.metadata.physical.walBytes).toBe(0n);
    expect(report.metadata.physical.pageCount).toBeGreaterThan(0);
    expect(report.metadata.physical.pageSizeBytes).toBeGreaterThan(0);
    expect(report.lock.diagnostic?.kind).toBe("absent");
    expect(issueCodes(report.issues)).toEqual(["lock-absent"]);
    expect(report.checksPerformed).toContainEqual({
      id: "session-scale",
      state: "snapshot",
    });
  });

  it("reads a V5 store and exposes the session history identity", async () => {
    const root = await storeRoot();
    const db = new DatabaseSync(databasePathOf(root));
    initializeStore(db, 5);
    registerSession(db, "v5-session");
    putSlot(db, "v5-session", "e1", "tree-v5");
    db.prepare(
      `INSERT INTO session_history(session_id, history_epoch, reset_pending)
       VALUES (?, ?, ?)`,
    ).run("v5-session", 3, 1);
    db.prepare(
      `INSERT INTO session_history(session_id, history_epoch, reset_pending)
       VALUES (?, ?, ?)`,
    ).run("forgotten", 0, 1);
    db.close();

    const report = await diagnoseStore(root, {
      filesystemKindProbe: LOCAL_PROBE,
    });
    expect(report.metadata.status).toEqual({ kind: "ready" });
    expect(report.metadata.version).toBe(5);
    expect(report.metadata.sessionHistoryAvailable).toBe(true);
    expect(report.metadata.sessionCount).toBe(2);

    const history = await readStoreHistory(root, { pageSize: 10 });
    expect(history.state).toBe("snapshot");
    expect(history.sessions.map(({ stats }) => stats.sessionId)).toEqual([
      "forgotten",
      "v5-session",
    ]);
    const forgotten = history.sessions[0]!.stats;
    expect(forgotten.totalSlotCount).toBe(0);
    expect(forgotten.historyEpoch).toBe(0);
    expect(forgotten.resetPending).toBe(true);
    const remembered = history.sessions[1]!.stats;
    expect(remembered.historyEpoch).toBe(3);
    expect(remembered.resetPending).toBe(true);
    expect(remembered.checkpointedSlotCount).toBe(1);
  });

  it("reports a newer metadata version with generic observations only", async () => {
    const root = await storeRoot();
    const newerVersion = CURRENT_METADATA_VERSION.version + 1;
    const db = new DatabaseSync(databasePathOf(root));
    // A table that happens to share a known name must never be queried.
    db.exec("CREATE TABLE checkpoint_slot(session_id TEXT, entry_id TEXT)");
    db.prepare("INSERT INTO checkpoint_slot VALUES (?, ?)").run("x", "y");
    db.exec(`PRAGMA user_version = ${newerVersion}`);
    db.close();

    const report = await diagnoseStore(root, {
      filesystemKindProbe: LOCAL_PROBE,
    });
    expect(report.metadata.status).toEqual({
      kind: "too-new",
      version: newerVersion,
      supportedVersion: CURRENT_METADATA_VERSION.version,
    });
    expect(report.metadata.state).toBe("observational");
    expect(report.metadata.sessionCount).toBeNull();
    expect(report.metadata.slots).toBeNull();
    expect(report.metadata.physical.pageCount).toBeGreaterThan(0);
    expect(issueCodes(report.issues)).toEqual([
      "store-format-newer",
      "lock-absent",
    ]);

    const history = await readStoreHistory(root);
    expect(history.sessions).toEqual([]);
    expect(history.totals).toBeNull();
    expect(issueCodes(history.issues)).toEqual(["store-format-newer"]);

    const inventory = await readStoreInventory(root, {
      filesystemKindProbe: LOCAL_PROBE,
    });
    expect(inventory.metadataPageBytes).toBeGreaterThan(0n);
    expect(inventory.metadataFileBytes).toBeGreaterThan(0n);
  });

  it("reports a malformed historical schema", async () => {
    const root = await storeRoot();
    const db = new DatabaseSync(databasePathOf(root));
    db.exec("CREATE TABLE node_state(session_id TEXT)");
    db.exec("PRAGMA user_version = 2");
    db.close();

    const report = await diagnoseStore(root, {
      filesystemKindProbe: LOCAL_PROBE,
    });
    expect(report.metadata.status).toMatchObject({
      kind: "unexpected-shape",
      version: 2,
    });
    expect(report.metadata.sessionCount).toBeNull();
    expect(issueCodes(report.issues)).toEqual([
      "store-schema-unexpected",
      "lock-absent",
    ]);
  });

  it("reports an unexpected schema shape for a recognized version", async () => {
    const root = await storeRoot();
    const db = new DatabaseSync(databasePathOf(root));
    db.exec("CREATE TABLE probe(id INTEGER PRIMARY KEY)");
    db.exec("PRAGMA user_version = 4");
    db.close();

    const report = await diagnoseStore(root, {
      filesystemKindProbe: LOCAL_PROBE,
    });
    expect(report.metadata.status).toMatchObject({
      kind: "unexpected-shape",
      version: 4,
    });
    expect(issueCodes(report.issues)).toEqual([
      "store-schema-unexpected",
      "lock-absent",
    ]);
  });

  it("reports a corrupt database without throwing", async () => {
    const root = await storeRoot();
    await writeFile(databasePathOf(root), "not a database");

    const report = await diagnoseStore(root, {
      filesystemKindProbe: LOCAL_PROBE,
    });
    expect(report.storePresent).toBe(true);
    expect(report.metadata.status).toMatchObject({ kind: "unreadable" });
    expect(report.metadata.state).toBe("observational");
    expect(report.metadata.physical.fileBytes).toBe(14n);
    expect(report.metadata.physical.pageCount).toBeNull();
    expect(issueCodes(report.issues)).toEqual([
      "store-format-unreadable",
      "lock-absent",
    ]);
  });

  it("reports a hot journal as needing recovery", async () => {
    const root = await storeRoot();
    createV4Store(root).close();
    await writeFile(`${databasePathOf(root)}-journal`, "");

    const report = await diagnoseStore(root, {
      filesystemKindProbe: LOCAL_PROBE,
    });
    expect(report.metadata.status).toMatchObject({ kind: "needs-recovery" });
    expect(report.metadata.sessionCount).toBeNull();
    expect(report.metadata.physical.journalBytes).toBe(0n);
    expect(report.metadata.physical.otherSidecarFiles).toContainEqual({
      name: "state.db-journal",
      bytes: 0n,
    });
    expect(issueCodes(report.issues)).toEqual([
      "store-needs-recovery",
      "lock-absent",
    ]);
  });

  it("reports an unmatched WAL sidecar as needing recovery", async () => {
    const root = await storeRoot();
    createV4Store(root).close();
    await writeFile(`${databasePathOf(root)}-wal`, "uncommitted frames");

    const report = await diagnoseStore(root, {
      filesystemKindProbe: LOCAL_PROBE,
    });
    expect(report.metadata.status).toMatchObject({ kind: "needs-recovery" });
    expect(report.metadata.physical.walBytes).toBe(18n);
    expect(issueCodes(report.issues)).toEqual([
      "store-needs-recovery",
      "lock-absent",
    ]);
  });

  it("reads committed rows through a live WAL pair", async () => {
    const root = await storeRoot();
    const db = new DatabaseSync(databasePathOf(root));
    db.exec("PRAGMA journal_mode = WAL");
    initializeStore(db, 4);
    registerSession(db, "wal-session");
    putSlot(db, "wal-session", "e1", "tree-wal");
    // The writer stays open, so the WAL and SHM companions are live.
    try {
      const report = await diagnoseStore(root, {
        filesystemKindProbe: LOCAL_PROBE,
      });
      expect(report.metadata.status).toEqual({ kind: "ready" });
      expect(report.metadata.sessionCount).toBe(1);
      expect(report.metadata.slots?.checkpointedSlotCount).toBe(1);
      expect(report.metadata.physical.walBytes).toBeGreaterThanOrEqual(0n);
    } finally {
      db.close();
    }
  });
});

describe("store doctor lock mapping", () => {
  it("treats an acquirable native lock as a consistent observation", async () => {
    const root = await storeRoot();
    createV4Store(root).close();
    await plantNativeProtocol(root);

    const report = await diagnoseStore(root, {
      filesystemKindProbe: LOCAL_PROBE,
    });
    expect(report.lock.diagnostic?.kind).toBe("native-acquired");
    expect(report.lock.state).toBe("snapshot");
    expect(report.lock.held).toBe(false);
    expect(issueCodes(report.issues)).toEqual([]);
  });

  it("reports a busy native lock without declaring the store broken", async () => {
    const root = await storeRoot();
    createV4Store(root).close();
    await plantNativeProtocol(root);
    const lock = await acquireWorkspaceLock(root, "diagnostics-test");
    try {
      const report = await diagnoseStore(root, {
        filesystemKindProbe: LOCAL_PROBE,
      });
      expect(report.lock.diagnostic?.kind).toBe("native-busy");
      expect(report.lock.state).toBe("observational");
      expect(report.metadata.status).toEqual({ kind: "ready" });
      expect(issueCodes(report.issues)).toEqual(["lock-busy"]);
    } finally {
      await lock.release();
    }
  });

  it("warns about the legacy directory protocol", async () => {
    const root = await storeRoot();
    createV4Store(root).close();
    await mkdir(join(root, "workspace.lock"));

    const report = await diagnoseStore(root, {
      filesystemKindProbe: LOCAL_PROBE,
    });
    expect(report.lock.diagnostic?.kind).toBe("legacy-directory");
    expect(report.lock.state).toBe("observational");
    expect(issueCodes(report.issues)).toEqual(["lock-legacy-directory"]);
  });

  it("warns about an interrupted protocol switch", async () => {
    const root = await storeRoot();
    createV4Store(root).close();
    await writeFile(join(root, "workspace.lock"), "");

    const report = await diagnoseStore(root, {
      filesystemKindProbe: LOCAL_PROBE,
    });
    expect(report.lock.diagnostic?.kind).toBe("interrupted-switch");
    expect(issueCodes(report.issues)).toEqual(["lock-interrupted-switch"]);
  });

  it("maps a corrupt marker to an unavailable lock state", async () => {
    const root = await storeRoot();
    createV4Store(root).close();
    await writeFile(join(root, "workspace.lock"), "");
    await writeFile(join(root, "lock-protocol.json"), "{not-json\n");

    const report = await diagnoseStore(root, {
      filesystemKindProbe: LOCAL_PROBE,
    });
    expect(report.lock.diagnostic?.kind).toBe("corrupt");
    expect(report.lock.state).toBe("unavailable");
    expect(issueCodes(report.issues)).toEqual(["lock-protocol-corrupt"]);
  });

  it("maps an inconsistent marker to an unavailable lock state", async () => {
    const root = await storeRoot();
    createV4Store(root).close();
    await writeFile(
      join(root, "lock-protocol.json"),
      nativeLockProtocolMarkerBytes(),
    );

    const report = await diagnoseStore(root, {
      filesystemKindProbe: LOCAL_PROBE,
    });
    expect(report.lock.diagnostic?.kind).toBe("inconsistent");
    expect(report.lock.state).toBe("unavailable");
    expect(issueCodes(report.issues)).toEqual(["lock-protocol-inconsistent"]);
  });

  it("maps an unsupported marker to an unavailable lock state", async () => {
    const root = await storeRoot();
    createV4Store(root).close();
    await writeFile(join(root, "workspace.lock"), "");
    await writeFile(
      join(root, "lock-protocol.json"),
      `${JSON.stringify({ format: 9, protocol: "future" })}\n`,
    );

    const report = await diagnoseStore(root, {
      filesystemKindProbe: LOCAL_PROBE,
    });
    expect(report.lock.diagnostic?.kind).toBe("unsupported");
    expect(report.lock.state).toBe("unavailable");
    expect(issueCodes(report.issues)).toEqual(["lock-protocol-unsupported"]);
  });
});

describe("store doctor filesystem reporting", () => {
  it("refuses a store on an identified network filesystem", async () => {
    const root = await storeRoot();
    createV4Store(root).close();
    const networkProbe: FilesystemKindProbe = async () => ({
      kind: "network",
      source: "darwin-mount",
      filesystemType: "nfs",
      detail: null,
    });

    const report = await diagnoseStore(root, {
      filesystemKindProbe: networkProbe,
    });
    expect(report.filesystem.kind).toBe("network");
    const issue = report.issues.find(
      ({ code }) => code === "unsupported-filesystem",
    );
    expect(issue?.severity).toBe("error");
    expect(issue?.params.filesystemType).toBe("nfs");
    expect(issue?.params.evidenceSource).toBe("darwin-mount");
  });

  it("keeps missing evidence unknown instead of refusing a local path", async () => {
    const root = await storeRoot();
    createV4Store(root).close();
    const unknownProbe: FilesystemKindProbe = async () => ({
      kind: "unknown",
      source: "probe-failure",
      filesystemType: null,
      detail: "statfs failed",
    });

    const report = await diagnoseStore(root, {
      filesystemKindProbe: unknownProbe,
    });
    expect(report.filesystem).toEqual({
      kind: "unknown",
      source: "probe-failure",
      filesystemType: null,
      detail: "statfs failed",
    });
    expect(issueCodes(report.issues)).not.toContain("unsupported-filesystem");
    expect(report.metadata.status).toEqual({ kind: "ready" });
  });
});

describe("store history paging", () => {
  it("pages sessions in a deterministic order with an opaque cursor", async () => {
    const root = await storeRoot();
    const db = createV4Store(root);
    for (const sessionId of ["s3", "s1", "s2", "s5", "s4", "s7", "s6"]) {
      registerSession(db, sessionId);
      putSlot(db, sessionId, "e1", `tree-${sessionId}`);
    }
    putSlot(db, "s1", "e2", "tree-s1");
    putSlot(db, "s2", "e2", null, "blocked");
    db.close();

    const first = await readStoreHistory(root, { pageSize: 3 });
    expect(first.sessions.map(({ stats }) => stats.sessionId)).toEqual([
      "s1",
      "s2",
      "s3",
    ]);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(first.totals).toEqual({
      exactness: "exact",
      sessionCount: 7,
      totalSlotCount: 9,
      checkpointedSlotCount: 8,
      blockedSlotCount: 1,
      distinctTreeOidCount: 7,
    });
    const hinted = first.sessions[0]!;
    expect(hinted.capacityHints.map(({ id }) => id)).toEqual([
      "session-checkpointed-slots",
      "session-logical-content-bytes",
    ]);

    const second = await readStoreHistory(root, {
      pageSize: 3,
      cursor: first.nextCursor,
    });
    expect(second.sessions.map(({ stats }) => stats.sessionId)).toEqual([
      "s4",
      "s5",
      "s6",
    ]);
    expect(second.hasMore).toBe(true);

    const third = await readStoreHistory(root, {
      pageSize: 3,
      cursor: second.nextCursor,
    });
    expect(third.sessions.map(({ stats }) => stats.sessionId)).toEqual(["s7"]);
    expect(third.hasMore).toBe(false);
    expect(third.nextCursor).toBeNull();
    expect(third.totals?.sessionCount).toBe(7);
  });

  it("fetches one extra row so an exactly-full page is not reported as more", async () => {
    const root = await storeRoot();
    const db = createV4Store(root);
    for (const sessionId of ["s1", "s2", "s3", "s4", "s5", "s6"]) {
      registerSession(db, sessionId);
    }
    db.close();

    const first = await readStoreHistory(root, { pageSize: 3 });
    expect(first.hasMore).toBe(true);
    const second = await readStoreHistory(root, {
      pageSize: 3,
      cursor: first.nextCursor,
    });
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
    expect(second.totals).toEqual({
      exactness: "exact",
      sessionCount: 6,
      totalSlotCount: 0,
      checkpointedSlotCount: 0,
      blockedSlotCount: 0,
      distinctTreeOidCount: 0,
    });
  });

  it("distinguishes measured zeros from unknown values", async () => {
    const root = await storeRoot();
    const db = createV4Store(root);
    registerSession(db, "known");
    putSlot(db, "known", "e1", "tree-known");
    putSlot(db, "slots-only", "e1", null, "blocked");
    registerSession(db, "registry-only", "pending");
    db.close();

    const report = await readStoreHistory(root, { pageSize: 10 });
    expect(report.totals?.sessionCount).toBe(3);
    const [known, registryOnly, slotsOnly] = report.sessions.map(
      ({ stats }) => stats,
    );
    expect(known).toMatchObject({
      sessionId: "known",
      registrationState: "verified",
      totalSlotCount: 1,
      checkpointedSlotCount: 1,
      blockedSlotCount: 0,
      distinctTreeOidCount: 1,
      lastCaptureAt: null,
    });
    expect(registryOnly).toMatchObject({
      sessionId: "registry-only",
      registrationState: "pending",
      totalSlotCount: 0,
      checkpointedSlotCount: 0,
      distinctTreeOidCount: 0,
    });
    expect(slotsOnly).toMatchObject({
      sessionId: "slots-only",
      sessionFile: null,
      registrationState: null,
      totalSlotCount: 1,
      checkpointedSlotCount: 0,
      blockedSlotCount: 1,
      distinctTreeOidCount: 0,
    });
  });

  it("returns an empty snapshot for a readable store without sessions", async () => {
    const root = await storeRoot();
    createV4Store(root).close();

    const report = await readStoreHistory(root, { pageSize: 10 });
    expect(report.state).toBe("snapshot");
    expect(report.sessions).toEqual([]);
    expect(report.hasMore).toBe(false);
    expect(report.nextCursor).toBeNull();
    expect(report.totals?.sessionCount).toBe(0);
  });

  it("rejects invalid page sizes and cursors", async () => {
    const root = await storeRoot();
    createV4Store(root).close();

    await expect(
      readStoreHistory(root, { pageSize: 0 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      readStoreHistory(root, { pageSize: 501 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      readStoreHistory(root, { pageSize: 1.5 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      readStoreHistory(root, { cursor: "%%%" }),
    ).rejects.toBeInstanceOf(RangeError);
    const futureCursor = Buffer.from(
      JSON.stringify({ v: 2, after: "s1" }),
      "utf8",
    ).toString("base64url");
    await expect(
      readStoreHistory(root, { cursor: futureCursor }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("returns no page for an absent store", async () => {
    const root = await storeRoot();

    const report = await readStoreHistory(root, { pageSize: 10 });
    expect(report.state).toBe("unavailable");
    expect(report.status).toEqual({ kind: "absent" });
    expect(report.sessions).toEqual([]);
    expect(report.totals).toBeNull();
    expect(report.hasMore).toBeNull();
    expect(issueCodes(report.issues)).toEqual(["store-absent"]);
  });
});

describe("store inventory", () => {
  it("reports unknown space fields for an absent store", async () => {
    const root = await storeRoot();
    const report = await readStoreInventory(root, {
      filesystemKindProbe: LOCAL_PROBE,
    });

    expect(report.storePresent).toBe(false);
    expect(report.metadataState).toBe("unavailable");
    expect(report.metadataBytesState).toBe("unavailable");
    expect(report.metadataFileBytes).toBeNull();
    expect(report.metadataWalBytes).toBeNull();
    expect(report.metadataPageBytes).toBeNull();
    expect(report.metadataReusableBytes).toBeNull();
    expect(report.metadataUsedPageEstimateBytes).toBeNull();
    expect(report.directoryPresent).toBe(true);
    expect(report.objectsPresent).toBe(false);
    expect(report.objectFileBytes).toBe(0n);
    expect(report.objectFiles).toMatchObject({
      present: false,
      complete: true,
      fileCount: 0,
    });
    expect(report.objectState).toBe("observational");
    expect(report.sessionLogicalContentBytes).toBeNull();
    expect(report.sessionLogicalContentDetail.length).toBeGreaterThan(0);
    expect(report.reclaimedBytes).toBeNull();
    expect(report.reclaimedBytesDetail.length).toBeGreaterThan(0);
    expect(report.reclaimedState).toBe("unavailable");
    expect(report.reclamationFacts).toEqual([
      "history-deletion-does-not-shrink-sqlite-file",
      "free-pages-are-reused",
      "vacuum-is-not-implicit",
    ]);
    expect(report.capacityHints).toHaveLength(1);
    expect(report.capacityHints[0]).toMatchObject({
      id: "store-file-bytes",
      observed: null,
      state: "unknown",
    });
    expect(issueCodes(report.issues)).toEqual(["store-absent"]);
    expect(await readdir(root)).toEqual([]);
  });

  it("computes page and freelist arithmetic from the same database", async () => {
    const root = await storeRoot();
    const path = databasePathOf(root);
    const db = new DatabaseSync(path);
    db.exec("PRAGMA page_size = 512");
    initializeStore(db, 4);
    const insert = db.prepare(
      `INSERT INTO session_registry(session_id, session_file, registration_state)
       VALUES (?, ?, 'verified')`,
    );
    db.exec("BEGIN");
    for (let index = 0; index < 400; index += 1) {
      insert.run(`s-${String(index).padStart(4, "0")}`, `/s/${index}.jsonl`);
    }
    db.exec("COMMIT");
    db.exec("DELETE FROM session_registry WHERE session_id >= 's-0010'");
    db.close();

    const raw = new DatabaseSync(path, { readOnly: true });
    const pageSize = Number(
      (raw.prepare("PRAGMA page_size").get() as { page_size: number })
        .page_size,
    );
    const pageCount = Number(
      (raw.prepare("PRAGMA page_count").get() as { page_count: number })
        .page_count,
    );
    const freelistCount = Number(
      (raw.prepare("PRAGMA freelist_count").get() as { freelist_count: number })
        .freelist_count,
    );
    raw.close();
    expect(freelistCount).toBeGreaterThan(0);

    const report = await readStoreInventory(root, {
      filesystemKindProbe: LOCAL_PROBE,
    });
    expect(report.metadataState).toBe("snapshot");
    expect(report.metadataBytesState).toBe("observational");
    expect(report.metadataFileBytes).toBe(BigInt((await lstat(path)).size));
    expect(report.metadataPageSizeBytes).toBe(pageSize);
    expect(report.metadataPageCount).toBe(pageCount);
    expect(report.metadataFreelistCount).toBe(freelistCount);
    expect(report.metadataPageBytes).toBe(BigInt(pageCount * pageSize));
    expect(report.metadataReusableBytes).toBe(BigInt(freelistCount * pageSize));
    expect(report.metadataUsedPageEstimateBytes).toBe(
      BigInt((pageCount - freelistCount) * pageSize),
    );
    expect(report.metadataOtherSidecarFiles).toEqual([]);
  });

  it("inventories object and pack files with their categories", async () => {
    const root = await storeRoot();
    createV4Store(root).close();
    const files: readonly (readonly [string, number])[] = [
      ["blobs/aa/object-a", 100],
      ["trees/bb/object-b", 200],
      ["records/content/cc/record-c", 50],
      ["records/recipe/dd/record-d", 25],
      ["packs/ee/pack-e.pack", 300],
      ["packs/multi-pack-index", 10],
      ["packs/incoming/.pending.pack.tmp", 40],
      ["packs/ff/temporary.tmp", 10],
    ];
    for (const [relative, bytes] of files) {
      const path = join(root, "objects", relative);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.alloc(bytes));
    }

    const report = await readStoreInventory(root, {
      filesystemKindProbe: LOCAL_PROBE,
    });
    const objects = report.objectFiles!;
    expect(objects.present).toBe(true);
    expect(objects.complete).toBe(true);
    expect(objects.detail).toBeNull();
    expect(objects.fileCount).toBe(8);
    expect(objects.skippedEntries).toBe(0);
    expect(objects.looseObjectBytes).toBe(300n);
    expect(objects.looseRecordBytes).toBe(75n);
    expect(objects.packBytes).toBe(310n);
    expect(objects.incomingBytes).toBe(40n);
    expect(objects.temporaryBytes).toBe(10n);
    expect(objects.otherBytes).toBe(0n);
    expect(objects.objectFileBytes).toBe(735n);
    expect(report.objectFileBytes).toBe(735n);
    expect(report.objectState).toBe("observational");
    expect(issueCodes(report.issues)).toEqual([]);
  });

  it("marks an object inventory that exceeds its budget as partial", async () => {
    const root = await storeRoot();
    createV4Store(root).close();
    const path = join(root, "objects", "blobs", "aa", "object-a");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.alloc(100));

    const entries = await readStoreInventory(root, {
      filesystemKindProbe: LOCAL_PROBE,
      objectWalkBudget: { maxEntries: 2 },
    });
    expect(entries.objectFiles?.complete).toBe(false);
    expect(entries.objectFiles?.detail).toContain("budget");
    expect(issueCodes(entries.issues)).toContain("object-inventory-incomplete");

    const depth = await readStoreInventory(root, {
      filesystemKindProbe: LOCAL_PROBE,
      objectWalkBudget: { maxDepth: 1 },
    });
    expect(depth.objectFiles?.complete).toBe(false);
    expect(depth.objectFiles?.detail).toContain("depth budget");
  });

  it("filters to one session and reports its logical content as unknown", async () => {
    const root = await storeRoot();
    const db = createV4Store(root);
    registerSession(db, "session-a");
    putSlot(db, "session-a", "e1", "tree-a");
    putSlot(db, "session-a", "e2", "tree-a");
    registerSession(db, "session-b");
    putSlot(db, "session-b", "e1", "tree-b");
    db.close();

    const report = await readStoreInventory(root, {
      sessionId: "session-a",
      filesystemKindProbe: LOCAL_PROBE,
    });
    expect(report.sessionId).toBe("session-a");
    expect(report.sessionFound).toBe(true);
    expect(report.sessionState).toBe("snapshot");
    expect(report.sessionStats).toMatchObject({
      sessionId: "session-a",
      checkpointedSlotCount: 2,
      distinctTreeOidCount: 1,
    });
    expect(report.sessionLogicalContentBytes).toBeNull();
    expect(report.sessionLogicalContentDetail).toContain("does not calculate");
    const slotHint = report.capacityHints.find(
      ({ id }) => id === "session-checkpointed-slots",
    )!;
    expect(slotHint.observed).toBe(2n);
    expect(slotHint.state).toBe("within");
    const logicalHint = report.capacityHints.find(
      ({ id }) => id === "session-logical-content-bytes",
    )!;
    expect(logicalHint.observed).toBeNull();
    expect(logicalHint.state).toBe("unknown");
    const fileHint = report.capacityHints.find(
      ({ id }) => id === "store-file-bytes",
    )!;
    expect(fileHint.observed).toBe(report.metadataFileBytes);
    expect(fileHint.state).toBe("within");
  });

  it("reports an unknown session without fabricating statistics", async () => {
    const root = await storeRoot();
    createV4Store(root).close();

    const report = await readStoreInventory(root, {
      sessionId: "missing",
      filesystemKindProbe: LOCAL_PROBE,
    });
    expect(report.sessionFound).toBe(false);
    expect(report.sessionStats).toBeNull();
    expect(report.sessionState).toBe("unavailable");
    expect(issueCodes(report.issues)).toContain("session-unknown");
  });
});

describe("capacity hints", () => {
  it("flags the store file exactly at the limit and one below", () => {
    expect(evaluateStoreFileCapacityHint(STORE_FILE_BYTE_LIMIT)).toMatchObject({
      id: "store-file-bytes",
      observed: STORE_FILE_BYTE_LIMIT,
      state: "reached",
    });
    expect(
      evaluateStoreFileCapacityHint(STORE_FILE_BYTE_LIMIT - 1n),
    ).toMatchObject({ observed: STORE_FILE_BYTE_LIMIT - 1n, state: "within" });
    expect(evaluateStoreFileCapacityHint(null)).toMatchObject({
      observed: null,
      state: "unknown",
    });
  });

  it("flags a session exactly at the checkpointed-slot limit and one below", async () => {
    const root = await storeRoot();
    const db = createV4Store(root);
    const atLimit = Number(SESSION_CHECKPOINTED_SLOT_LIMIT);
    const insert = db.prepare(
      `INSERT INTO checkpoint_slot(session_id, entry_id, tree_oid, capture_state)
       VALUES (?, ?, ?, 'open')`,
    );
    registerSession(db, "at-limit");
    registerSession(db, "below");
    db.exec("BEGIN");
    for (let index = 0; index < atLimit; index += 1) {
      insert.run("at-limit", `e-${index}`, "tree");
    }
    for (let index = 0; index < atLimit - 1; index += 1) {
      insert.run("below", `e-${index}`, "tree");
    }
    db.exec("COMMIT");
    db.close();

    const report = await readStoreHistory(root, { pageSize: 10 });
    const hintFor = (sessionId: string) =>
      report.sessions
        .find(({ stats }) => stats.sessionId === sessionId)!
        .capacityHints.find(({ id }) => id === "session-checkpointed-slots")!;

    expect(hintFor("at-limit")).toMatchObject({
      limit: SESSION_CHECKPOINTED_SLOT_LIMIT,
      observed: SESSION_CHECKPOINTED_SLOT_LIMIT,
      state: "reached",
    });
    expect(hintFor("below")).toMatchObject({
      observed: SESSION_CHECKPOINTED_SLOT_LIMIT - 1n,
      state: "within",
    });
  });
});
