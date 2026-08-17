import { fork, type ChildProcess } from "node:child_process";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  createCurrentMetadataStore,
  inspectMetadataSessionIdentity,
  MetadataError,
  openAuthenticatedCurrentMetadataStore as openAuthenticatedCurrentMetadataStoreWithLease,
  openCurrentMetadataStore as openCurrentMetadataStoreWithLease,
  type CurrentMetadataStore,
} from "../src/infrastructure/metadata.ts";
import { CURRENT_METADATA_VERSION } from "../src/infrastructure/metadata/current.ts";
import { initializeMetadataVersionWithinTransaction } from "../src/infrastructure/metadata/migration-engine.ts";
import { TREE_MANIFEST_FORMAT_V2 } from "../src/infrastructure/tree-formats/v2.ts";
import {
  bindTestMetadataWriteAuthority,
  checkpointIsBlocked,
  checkpointState,
  commitTestNodeState,
  createTestCurrentMetadataStore,
  finalizeTestSessionProjection,
  protectTestLocation,
  readTestSessionRegistration,
  readTestSessionRegistrations,
  registerTestSession,
  testMetadataWriteAuthority,
} from "./metadata-fixture.ts";
import {
  holdTestWorkspaceWriteAuthority,
  releaseTestWorkspaceWriteAuthorities,
} from "./workspace-write-authority-fixture.ts";

const roots: string[] = [];
const CHILD_PROCESS_WATCHDOG_MS = 30_000;
const metadataOpenFixture = fileURLToPath(
  new URL("./fixtures/metadata-open-child.ts", import.meta.url),
);

async function openCurrentMetadataStore(
  path: string,
  dependencies: Parameters<typeof openCurrentMetadataStoreWithLease>[1],
): ReturnType<typeof openCurrentMetadataStoreWithLease> {
  const storeRoot = dirname(path);
  const authority = await holdTestWorkspaceWriteAuthority(storeRoot);
  const store = await openCurrentMetadataStoreWithLease(
    path,
    dependencies,
    authority,
  );
  bindTestMetadataWriteAuthority(store, authority, storeRoot);
  return store;
}

async function openAuthenticatedWithLease(
  storeRoot: string,
  proof: Parameters<typeof openAuthenticatedCurrentMetadataStoreWithLease>[0],
  dependencies: Parameters<
    typeof openAuthenticatedCurrentMetadataStoreWithLease
  >[1],
): ReturnType<typeof openAuthenticatedCurrentMetadataStoreWithLease> {
  const authority = await holdTestWorkspaceWriteAuthority(storeRoot);
  const store = await openAuthenticatedCurrentMetadataStoreWithLease(
    proof,
    dependencies,
    authority,
  );
  bindTestMetadataWriteAuthority(store, authority, storeRoot);
  return store;
}

interface MetadataChildMessage {
  readonly type: "ready" | "opening" | "opened" | "error";
  readonly pid: number;
  readonly blocked?: boolean;
  readonly name?: string;
  readonly message?: string;
}

interface MetadataChild {
  readonly process: ChildProcess;
  readonly ready: Promise<MetadataChildMessage>;
  readonly stderr: () => string;
}

interface MetadataOpenGate {
  readonly pausedPath: string;
  readonly releasePath: string;
}

function waitForChildMessage(
  child: ChildProcess,
  expected: "ready" | "opening" | "opened",
  stderr: () => string,
): Promise<MetadataChildMessage> {
  return new Promise<MetadataChildMessage>((resolveMessage, rejectMessage) => {
    const timer = setTimeout(() => {
      cleanup();
      rejectMessage(
        new Error(
          `timed out waiting for metadata child ${expected}\n${stderr()}`,
        ),
      );
    }, CHILD_PROCESS_WATCHDOG_MS);
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    const onMessage = (message: MetadataChildMessage): void => {
      if (message.type !== expected && message.type !== "error") return;
      cleanup();
      if (message.type === "error") {
        rejectMessage(
          new Error(
            `metadata child failed: ${message.name ?? "Error"}: ${
              message.message ?? "unknown error"
            }\n${stderr()}`,
          ),
        );
      } else {
        resolveMessage(message);
      }
    };
    const onExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      cleanup();
      rejectMessage(
        new Error(
          `metadata child exited before ${expected}: code=${String(
            code,
          )} signal=${String(signal)}\n${stderr()}`,
        ),
      );
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

function startMetadataChild(
  path: string,
  iterations = 1,
  mode:
    | "write"
    | "gated-write"
    | "open-only"
    | "legacy-live"
    | "settle-sidecar" = "write",
  gate?: MetadataOpenGate,
): MetadataChild {
  const child = fork(
    metadataOpenFixture,
    [
      path,
      String(iterations),
      mode,
      ...(gate === undefined ? [] : [gate.pausedPath, gate.releasePath]),
    ],
    {
      execArgv: ["--experimental-strip-types", "--no-warnings"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  const readStderr = (): string => stderr;
  return {
    process: child,
    ready: waitForChildMessage(child, "ready", readStderr),
    stderr: readStderr,
  };
}

async function waitForAnyGatePause(
  children: readonly MetadataChild[],
  pausedPaths: readonly string[],
): Promise<void> {
  const deadline = Date.now() + CHILD_PROCESS_WATCHDOG_MS;
  while (true) {
    for (const pausedPath of pausedPaths) {
      try {
        await stat(pausedPath);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (
      children.every(
        ({ process }) =>
          process.exitCode !== null || process.signalCode !== null,
      )
    ) {
      throw new Error("all metadata children exited before the schema gate");
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error("timed out waiting for one metadata schema gate");
    }
    await new Promise<void>((resolveWait) =>
      setTimeout(resolveWait, Math.min(10, remaining)),
    );
  }
}

function waitForChildExit(child: MetadataChild): Promise<void> {
  if (child.process.exitCode !== null || child.process.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise<void>((resolveExit, rejectExit) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolveExit();
    };
    const timer = setTimeout(() => {
      child.process.off("exit", onExit);
      rejectExit(
        new Error(
          `timed out waiting for metadata child exit\n${child.stderr()}`,
        ),
      );
    }, CHILD_PROCESS_WATCHDOG_MS);
    child.process.once("exit", onExit);
  });
}

async function createStore(): Promise<{
  root: string;
  path: string;
  store: CurrentMetadataStore;
}> {
  const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-"));
  roots.push(root);
  const path = join(root, "state.db");
  const authority = await holdTestWorkspaceWriteAuthority(root);
  const store = createCurrentMetadataStore(path, authority);
  bindTestMetadataWriteAuthority(store, authority, root);
  return { root, path, store };
}

function openCurrentWithTreeUpgrades(
  path: string,
  prepareTreeOidUpgrades: (
    roots: readonly string[],
    targetFormat: string,
  ) => Promise<ReadonlyMap<string, string>> = async (treeOids) =>
    new Map(treeOids.map((treeOid) => [treeOid, treeOid])),
): Promise<CurrentMetadataStore> {
  return openCurrentMetadataStore(path, { prepareTreeOidUpgrades });
}

/** Reproduce the exact metadata schema published in cyclotomy@0.0.1. */
function openPublishedV1Metadata(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE node_state(
      session_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      tree_oid TEXT NOT NULL,
      PRIMARY KEY(session_id, entry_id)
    ) STRICT, WITHOUT ROWID;

    CREATE TABLE session_registry(
      session_id TEXT NOT NULL PRIMARY KEY,
      session_file TEXT NOT NULL UNIQUE,
      missing_since INTEGER,
      missing_observed_at INTEGER
    ) STRICT, WITHOUT ROWID;

    CREATE INDEX session_registry_missing
    ON session_registry(missing_since, missing_observed_at);

    PRAGMA user_version = 1;
  `);
  return db;
}

/** Reproduce the exact metadata schema published in cyclotomy@0.0.2. */
function openPublishedV2Metadata(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE node_state(
      session_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      tree_oid TEXT NOT NULL,
      PRIMARY KEY(session_id, entry_id)
    ) STRICT, WITHOUT ROWID;

    CREATE TABLE node_write_guard(
      session_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      PRIMARY KEY(session_id, entry_id)
    ) STRICT, WITHOUT ROWID;

    CREATE TABLE session_registry(
      session_id TEXT NOT NULL PRIMARY KEY,
      session_file TEXT NOT NULL UNIQUE,
      missing_since INTEGER,
      missing_observed_at INTEGER,
      pending_node_guard INTEGER NOT NULL DEFAULT 0
        CHECK(pending_node_guard IN (0, 1))
    ) STRICT, WITHOUT ROWID;

    CREATE INDEX session_registry_missing
    ON session_registry(missing_since, missing_observed_at);

    ${["node_state", "node_write_guard", "session_registry"]
      .flatMap((table) =>
        ["DELETE", "INSERT", "UPDATE"].map(
          (event) => `
            CREATE TRIGGER cyclotomy_writer_fence_${table}_${event.toLowerCase()}
            BEFORE ${event} ON ${table}
            WHEN cyclotomy_writer_protocol() IS NOT 2
            BEGIN
              SELECT RAISE(ABORT, 'Cyclotomy metadata writer protocol mismatch');
            END;
          `,
        ),
      )
      .join("\n")}

    PRAGMA user_version = 2;
  `);
  db.function(
    "cyclotomy_writer_protocol",
    { deterministic: true, directOnly: false },
    () => 2,
  );
  return db;
}

async function snapshotDirectory(root: string): Promise<{
  readonly names: readonly string[];
  readonly contents: Readonly<Record<string, string>>;
}> {
  const names = (await readdir(root))
    .filter((name) => name !== "workspace.lock")
    .sort();
  const contents = Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [
        name,
        (await readFile(join(root, name))).toString("base64"),
      ]),
    ),
  );
  return { names, contents };
}

afterEach(async () => {
  await releaseTestWorkspaceWriteAuthorities();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("checkpoint slot metadata", () => {
  it("creates fresh stores directly at the current v4 schema", async () => {
    const { path, store } = await createStore();
    store.close();
    const db = new DatabaseSync(path);
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
      )
      .all()
      .map((row) => String(row.name));
    expect(tables).toEqual([
      "checkpoint_slot",
      "session_capture_barrier",
      "session_registry",
    ]);
    expect(
      Number(
        (db.prepare("PRAGMA user_version").get() as { user_version: number })
          .user_version,
      ),
    ).toBe(CURRENT_METADATA_VERSION.version);
    expect(
      db
        .prepare("PRAGMA table_info(session_registry)")
        .all()
        .map((row) => String(row.name)),
    ).toEqual(["session_id", "session_file", "registration_state"]);
    expect(
      db
        .prepare(
          `SELECT count(*) AS count FROM sqlite_schema
           WHERE type = 'trigger'
             AND name GLOB 'cyclotomy_writer_fence_*'`,
        )
        .get(),
    ).toEqual({ count: 9 });
    db.close();
  });

  it("requires the caller's writer transaction for direct initialization", () => {
    const db = new DatabaseSync(":memory:");
    expect(() => initializeMetadataVersionWithinTransaction(db)).toThrow(
      /active writer transaction/u,
    );
    db.close();
  });

  it("keeps published v1 deferred until the atomic tree/schema cutover", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-v1-"));
    roots.push(root);
    const path = join(root, "state.db");
    const treeOid = "a".repeat(64);
    const legacy = openPublishedV1Metadata(path);
    legacy
      .prepare(
        `INSERT INTO node_state(session_id, entry_id, tree_oid)
         VALUES (?, ?, ?)`,
      )
      .run("legacy", "entry", treeOid);
    legacy
      .prepare(
        `INSERT INTO session_registry(
           session_id, session_file, missing_since, missing_observed_at
         ) VALUES (?, ?, ?, ?)`,
      )
      .run("legacy", "/sessions/legacy.jsonl", 100, 200);
    legacy.close();

    const migrated = await openCurrentWithTreeUpgrades(path);
    expect(checkpointState(migrated, "legacy", "entry")).toEqual({ treeOid });
    expect(readTestSessionRegistrations(path)).toEqual([
      {
        sessionId: "legacy",
        sessionFile: "/sessions/legacy.jsonl",
        captureBarrier: false,
        registrationState: "pending",
      },
    ]);
    expect(checkpointIsBlocked(migrated, "legacy", "entry")).toBe(false);
    migrated.close();

    const db = new DatabaseSync(path);
    expect(
      Number(
        (db.prepare("PRAGMA user_version").get() as { user_version: number })
          .user_version,
      ),
    ).toBe(CURRENT_METADATA_VERSION.version);
    expect(
      db
        .prepare("PRAGMA table_info(session_registry)")
        .all()
        .map((row) => String(row.name)),
    ).toEqual(["session_id", "session_file", "registration_state"]);
    expect(
      Number(
        (
          db
            .prepare(
              `SELECT count(*) AS count FROM checkpoint_slot
               WHERE capture_state = 'blocked'`,
            )
            .get() as {
            count: number;
          }
        ).count,
      ),
    ).toBe(0);
    expect(() =>
      db
        .prepare(
          `UPDATE session_registry SET registration_state = 'invalid'
           WHERE session_id = 'legacy'`,
        )
        .run(),
    ).toThrow();
    db.close();
  });

  it("migrates published v2 through every adjacent step to current", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-v2-"));
    roots.push(root);
    const path = join(root, "state.db");
    const legacy = openPublishedV2Metadata(path);
    legacy
      .prepare(
        `INSERT INTO session_registry(
           session_id, session_file, missing_since, missing_observed_at
         ) VALUES (?, ?, NULL, NULL)`,
      )
      .run("legacy", "/sessions/legacy.jsonl");
    legacy
      .prepare(
        `INSERT INTO node_state(session_id, entry_id, tree_oid)
         VALUES (?, ?, ?)`,
      )
      .run("legacy", "known", "a".repeat(64));

    await expect(
      createTestCurrentMetadataStore(path, dirname(path)),
    ).rejects.toThrow(/schema version 2 requires openCurrentMetadataStore/u);
    const current = await openCurrentWithTreeUpgrades(path);
    expect(readTestSessionRegistration(path, "legacy")).toEqual({
      sessionId: "legacy",
      sessionFile: "/sessions/legacy.jsonl",
      captureBarrier: false,
      registrationState: "pending",
    });
    expect(() =>
      legacy
        .prepare(
          `UPDATE node_state SET tree_oid = ?
           WHERE session_id = 'legacy' AND entry_id = 'known'`,
        )
        .run("b".repeat(64)),
    ).toThrow(/writer protocol mismatch|no such table/u);
    current.close();
    legacy.close();
  });

  it("maps every published-v2 state/guard combination into one v3 slot", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-v2-slots-"));
    roots.push(root);
    const path = join(root, "state.db");
    const legacy = openPublishedV2Metadata(path);
    legacy
      .prepare(
        `INSERT INTO session_registry(
           session_id, session_file, missing_since, missing_observed_at,
           pending_node_guard
         ) VALUES ('s', '/sessions/s.jsonl', NULL, NULL, 1)`,
      )
      .run();
    const insertState = legacy.prepare(
      `INSERT INTO node_state(session_id, entry_id, tree_oid)
       VALUES ('s', ?, ?)`,
    );
    insertState.run("open", "a".repeat(64));
    insertState.run("blocked", "b".repeat(64));
    const insertGuard = legacy.prepare(
      `INSERT INTO node_write_guard(session_id, entry_id) VALUES ('s', ?)`,
    );
    insertGuard.run("blocked");
    insertGuard.run("missing");
    legacy.close();

    const current = await openCurrentWithTreeUpgrades(path);
    expect(current.getCheckpointSlot("s", "absent")).toEqual({
      kind: "open-missing",
    });
    expect(current.getCheckpointSlot("s", "open")).toEqual({
      kind: "open-checkpoint",
      treeOid: "a".repeat(64),
    });
    expect(current.getCheckpointSlot("s", "missing")).toEqual({
      kind: "blocked-missing",
    });
    expect(current.getCheckpointSlot("s", "blocked")).toEqual({
      kind: "blocked-checkpoint",
      treeOid: "b".repeat(64),
    });
    expect(readTestSessionRegistration(path, "s")).toMatchObject({
      captureBarrier: true,
      registrationState: "pending",
    });
    current.close();
  });

  it("claims and conservatively verifies published-v2 slots whose registry update was lost", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-v2-claim-"));
    roots.push(root);
    const path = join(root, "state.db");
    const legacy = openPublishedV2Metadata(path);
    const insertState = legacy.prepare(
      `INSERT INTO node_state(session_id, entry_id, tree_oid)
       VALUES ('s', ?, ?)`,
    );
    insertState.run("open", "a".repeat(64));
    insertState.run("blocked", "b".repeat(64));
    const insertGuard = legacy.prepare(
      `INSERT INTO node_write_guard(session_id, entry_id) VALUES ('s', ?)`,
    );
    insertGuard.run("blocked");
    insertGuard.run("missing");
    legacy.close();

    const current = await openCurrentWithTreeUpgrades(path);
    expect(
      finalizeTestSessionProjection(current, {
        targetSessionId: "s",
        targetSessionFile: "/sessions/s.jsonl",
        retainedEntryIds: ["open", "blocked", "missing", "unclassified"],
        activeAncestryEntryIds: ["open", "unclassified"],
        // An orphan claim is a migrated recovery path and must not
        // interpret a new-registration seed.
        seed: { kind: "fresh" },
      }),
    ).toEqual({ kind: "existing" });
    expect(current.getCheckpointSlot("s", "open")).toEqual({
      kind: "open-checkpoint",
      treeOid: "a".repeat(64),
    });
    expect(current.getCheckpointSlot("s", "blocked")).toEqual({
      kind: "blocked-checkpoint",
      treeOid: "b".repeat(64),
    });
    expect(current.getCheckpointSlot("s", "missing")).toEqual({
      kind: "blocked-missing",
    });
    expect(current.getCheckpointSlot("s", "unclassified")).toEqual({
      kind: "blocked-missing",
    });
    expect(readTestSessionRegistration(path, "s")).toMatchObject({
      sessionFile: "/sessions/s.jsonl",
      registrationState: "verified",
    });

    expect(
      finalizeTestSessionProjection(current, {
        targetSessionId: "s",
        targetSessionFile: "/sessions/s.jsonl",
        retainedEntryIds: ["open", "blocked", "missing", "unclassified"],
        activeAncestryEntryIds: ["open", "unclassified"],
        seed: { kind: "untrusted-parent" },
      }),
    ).toEqual({ kind: "existing" });
    current.close();
  });

  it("claims a published-v1 state only after the atomic tree/schema cutover", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-v1-claim-"));
    roots.push(root);
    const path = join(root, "state.db");
    const treeOid = "a".repeat(64);
    const legacy = openPublishedV1Metadata(path);
    legacy
      .prepare(
        `INSERT INTO node_state(session_id, entry_id, tree_oid)
         VALUES ('s', 'known', ?)`,
      )
      .run(treeOid);
    legacy.close();

    const current = await openCurrentWithTreeUpgrades(path);
    expect(
      finalizeTestSessionProjection(current, {
        targetSessionId: "s",
        targetSessionFile: "/sessions/s.jsonl",
        retainedEntryIds: ["known", "unclassified"],
        activeAncestryEntryIds: ["known", "unclassified"],
        seed: { kind: "fresh" },
      }),
    ).toEqual({ kind: "existing" });
    expect(current.getCheckpointSlot("s", "known")).toEqual({
      kind: "open-checkpoint",
      treeOid,
    });
    expect(current.getCheckpointSlot("s", "unclassified")).toEqual({
      kind: "blocked-missing",
    });
    current.close();
  });

  it("rolls back an orphan claim whose coordinates are outside the trusted graph", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "cyclotomy-metadata-claim-rollback-"),
    );
    roots.push(root);
    const path = join(root, "state.db");
    const legacy = openPublishedV2Metadata(path);
    legacy
      .prepare(
        `INSERT INTO node_state(session_id, entry_id, tree_oid)
         VALUES ('s', 'orphan', ?)`,
      )
      .run("a".repeat(64));
    legacy.close();

    const current = await openCurrentWithTreeUpgrades(path);
    expect(() =>
      finalizeTestSessionProjection(current, {
        targetSessionId: "s",
        targetSessionFile: "/sessions/s.jsonl",
        retainedEntryIds: ["trusted"],
        activeAncestryEntryIds: ["trusted"],
        seed: { kind: "fresh" },
      }),
    ).toThrow(/outside the trusted session graph/u);
    expect(readTestSessionRegistration(path, "s")).toBeUndefined();
    expect(current.getCheckpointSlot("s", "orphan")).toEqual({
      kind: "open-checkpoint",
      treeOid: "a".repeat(64),
    });
    expect(current.getCheckpointSlot("s", "trusted")).toEqual({
      kind: "open-missing",
    });
    current.close();
  });

  it("refuses to reinterpret a claimed v2 layout before its adjacent migration", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-v2-forged-"));
    roots.push(root);
    const path = join(root, "state.db");
    const forged = openPublishedV2Metadata(path);
    forged.exec("DROP TRIGGER cyclotomy_writer_fence_node_state_update");
    forged.close();

    await expect(
      createTestCurrentMetadataStore(path, dirname(path)),
    ).rejects.toThrow(/v2 does not match the published v2 layout/u);
    const check = new DatabaseSync(path);
    expect(
      Number(
        (
          check.prepare("PRAGMA user_version").get() as {
            user_version: number;
          }
        ).user_version,
      ),
    ).toBe(2);
    expect(
      check
        .prepare("PRAGMA table_info(session_registry)")
        .all()
        .map((row) => String(row.name)),
    ).not.toContain("registration_state");
    check.close();
  });

  it("verifies migrated rows from the trusted retained graph", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-legacy-"));
    roots.push(root);
    const path = join(root, "state.db");
    const legacy = openPublishedV2Metadata(path);
    legacy
      .prepare(
        `INSERT INTO session_registry(
           session_id, session_file, missing_since, missing_observed_at,
           pending_node_guard
         ) VALUES (?, ?, NULL, NULL, 1)`,
      )
      .run("child", "/sessions/child.jsonl");
    legacy
      .prepare(
        `INSERT INTO node_state(session_id, entry_id, tree_oid)
         VALUES (?, ?, ?)`,
      )
      .run("child", "known", "a".repeat(64));
    legacy
      .prepare(
        `INSERT INTO node_write_guard(session_id, entry_id)
         VALUES (?, ?)`,
      )
      .run("child", "guarded");
    legacy.close();

    const current = await openCurrentWithTreeUpgrades(path);
    expect(
      finalizeTestSessionProjection(current, {
        targetSessionId: "child",
        targetSessionFile: "/sessions/child.jsonl",
        retainedEntryIds: ["known", "guarded", "parent-only"],
        activeAncestryEntryIds: ["known", "parent-only"],
        seed: { kind: "fresh" },
      }),
    ).toEqual({ kind: "existing" });
    expect(checkpointState(current, "child", "known")).toEqual({
      treeOid: "a".repeat(64),
    });
    expect(checkpointState(current, "child", "parent-only")).toBeUndefined();
    expect(checkpointIsBlocked(current, "child", "known")).toBe(true);
    expect(checkpointIsBlocked(current, "child", "guarded")).toBe(true);
    expect(checkpointIsBlocked(current, "child", "parent-only")).toBe(true);
    expect(
      current.hasSessionBarrier({
        sessionId: "child",
        sessionFile: "/sessions/child.jsonl",
      }),
    ).toBe(false);
    expect(readTestSessionRegistration(path, "child")?.registrationState).toBe(
      "verified",
    );
    current.close();
  });

  it("rolls back pending verification when coordinates are outside the trusted graph", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-orphan-"));
    roots.push(root);
    const path = join(root, "state.db");
    const legacy = openPublishedV2Metadata(path);
    legacy
      .prepare(
        `INSERT INTO session_registry(
           session_id, session_file, missing_since, missing_observed_at
         ) VALUES (?, ?, NULL, NULL)`,
      )
      .run("child", "/sessions/child.jsonl");
    legacy
      .prepare(
        `INSERT INTO node_state(session_id, entry_id, tree_oid)
         VALUES (?, ?, ?)`,
      )
      .run("child", "orphan", "a".repeat(64));
    legacy.close();

    const current = await openCurrentWithTreeUpgrades(path);
    expect(() =>
      finalizeTestSessionProjection(current, {
        targetSessionId: "child",
        targetSessionFile: "/sessions/child.jsonl",
        retainedEntryIds: ["trusted"],
        activeAncestryEntryIds: ["trusted"],
        seed: { kind: "fresh" },
      }),
    ).toThrow(/outside the trusted session graph/u);
    expect(readTestSessionRegistration(path, "child")?.registrationState).toBe(
      "pending",
    );
    expect(checkpointIsBlocked(current, "child", "trusted")).toBe(false);
    expect(() =>
      protectTestLocation(
        current,
        {
          sessionId: "child",
          sessionFile: "/sessions/child.jsonl",
        },
        "trusted",
      ),
    ).toThrow(/not verified/u);
    current.close();
  });

  it("keeps a migrated capture barrier until a stable active ancestry exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-pending-"));
    roots.push(root);
    const path = join(root, "state.db");
    const legacy = openPublishedV2Metadata(path);
    legacy
      .prepare(
        `INSERT INTO session_registry(
           session_id, session_file, missing_since, missing_observed_at,
           pending_node_guard
         ) VALUES (?, ?, NULL, NULL, 1)`,
      )
      .run("child", "/sessions/child.jsonl");
    legacy.close();

    const current = await openCurrentWithTreeUpgrades(path);
    finalizeTestSessionProjection(current, {
      targetSessionId: "child",
      targetSessionFile: "/sessions/child.jsonl",
      retainedEntryIds: [],
      activeAncestryEntryIds: [],
      seed: { kind: "fresh" },
    });
    expect(
      current.hasSessionBarrier({
        sessionId: "child",
        sessionFile: "/sessions/child.jsonl",
      }),
    ).toBe(true);
    expect(
      current.reconcileSessionBarrier(
        testMetadataWriteAuthority(current),
        { sessionId: "child", sessionFile: "/sessions/child.jsonl" },
        ["first"],
      ),
    ).toBe("reconciled");
    expect(checkpointIsBlocked(current, "child", "first")).toBe(true);
    current.close();
  });

  it("reconciles a session barrier against the effective checkpoint lineage", async () => {
    const { store } = await createStore();
    registerTestSession(store, "s", "/sessions/s.jsonl", ["root"]);
    commitTestNodeState(store, "s", "root", "a".repeat(64));
    expect(
      protectTestLocation(
        store,
        { sessionId: "s", sessionFile: "/sessions/s.jsonl" },
        "gap",
      ).kind,
    ).toBe("protected");
    expect(
      store.raiseSessionBarrier(testMetadataWriteAuthority(store), {
        sessionId: "s",
        sessionFile: "/sessions/s.jsonl",
      }),
    ).toBe(true);

    expect(
      store.reconcileSessionBarrier(
        testMetadataWriteAuthority(store),
        { sessionId: "s", sessionFile: "/sessions/s.jsonl" },
        ["root", "gap", "leaf"],
      ),
    ).toBe("reconciled");
    expect(store.getCheckpointSlot("s", "root")).toEqual({
      kind: "blocked-checkpoint",
      treeOid: "a".repeat(64),
    });
    expect(store.getCheckpointSlot("s", "gap")).toEqual({
      kind: "blocked-missing",
    });
    expect(store.getCheckpointSlot("s", "leaf")).toEqual({
      kind: "blocked-checkpoint",
      treeOid: "a".repeat(64),
    });
    expect(
      store.hasSessionBarrier({
        sessionId: "s",
        sessionFile: "/sessions/s.jsonl",
      }),
    ).toBe(false);
    store.close();
  });

  it("resolves an exact blocked-missing target without erasing descendant inheritance", async () => {
    const { store } = await createStore();
    const sessionFile = "/sessions/s.jsonl";
    const rootTree = "a".repeat(64);
    registerTestSession(store, "s", sessionFile, ["root"]);
    commitTestNodeState(store, "s", "root", rootTree);
    expect(
      protectTestLocation(store, { sessionId: "s", sessionFile }, "gap").kind,
    ).toBe("protected");

    expect(store.getCheckpointSlot("s", "gap")).toEqual({
      kind: "blocked-missing",
    });
    expect(store.getCheckpointSlot("s", "leaf")).toEqual({
      kind: "open-missing",
    });
    expect(store.getCheckpointSlot("s", "root")).toEqual({
      kind: "open-checkpoint",
      treeOid: rootTree,
    });
    store.close();
  });

  it("atomically pins an inherited resolution at the target location", async () => {
    const { store } = await createStore();
    const sessionFile = "/sessions/s.jsonl";
    const rootTree = "a".repeat(64);
    registerTestSession(store, "s", sessionFile, ["root"]);
    commitTestNodeState(store, "s", "root", rootTree);

    expect(
      store.protectLocation(testMetadataWriteAuthority(store), {
        identity: { sessionId: "s", sessionFile },
        entryId: "leaf",
        activeAncestryEntryIds: ["root", "leaf"],
        expectation: {
          kind: "exact-resolution",
          resolution: {
            kind: "checkpoint",
            entryId: "root",
            treeOid: rootTree,
          },
        },
      }),
    ).toEqual({
      kind: "protected",
      protectedSlot: { kind: "blocked-checkpoint", treeOid: rootTree },
    });
    expect(store.getCheckpointSlot("s", "leaf")).toEqual({
      kind: "blocked-checkpoint",
      treeOid: rootTree,
    });
    store.close();
  });

  it("atomically rejects stale inherited provenance and pins the current ancestor", async () => {
    const { path, store } = await createStore();
    const sessionFile = "/sessions/s.jsonl";
    const before = "a".repeat(64);
    const after = "b".repeat(64);
    registerTestSession(store, "s", sessionFile, ["root"]);
    commitTestNodeState(store, "s", "root", before);

    const concurrent = createCurrentMetadataStore(
      path,
      testMetadataWriteAuthority(store),
    );
    bindTestMetadataWriteAuthority(
      concurrent,
      testMetadataWriteAuthority(store),
      dirname(path),
    );
    expect(
      concurrent.commitCapture(testMetadataWriteAuthority(concurrent), {
        identity: { sessionId: "s", sessionFile },
        entryId: "root",
        activeAncestryEntryIds: ["root"],
        treeOid: after,
        expectedSlot: { kind: "open-checkpoint", treeOid: before },
      }),
    ).toBe("committed");
    concurrent.close();

    expect(
      store.protectLocation(testMetadataWriteAuthority(store), {
        identity: { sessionId: "s", sessionFile },
        entryId: "leaf",
        activeAncestryEntryIds: ["root", "leaf"],
        expectation: {
          kind: "exact-resolution",
          resolution: {
            kind: "checkpoint",
            entryId: "root",
            treeOid: before,
          },
        },
      }),
    ).toEqual({
      kind: "stale",
      protectedSlot: { kind: "blocked-checkpoint", treeOid: after },
    });
    expect(store.getCheckpointSlot("s", "leaf")).toEqual({
      kind: "blocked-checkpoint",
      treeOid: after,
    });
    expect(store.getCheckpointSlot("s", "root")).toEqual({
      kind: "open-checkpoint",
      treeOid: after,
    });
    store.close();
  });

  it("keeps a session barrier authoritative while pinning its inherited target", async () => {
    const { store } = await createStore();
    const sessionFile = "/sessions/s.jsonl";
    const treeOid = "a".repeat(64);
    registerTestSession(store, "s", sessionFile, ["root"]);
    commitTestNodeState(store, "s", "root", treeOid);
    expect(
      store.raiseSessionBarrier(testMetadataWriteAuthority(store), {
        sessionId: "s",
        sessionFile,
      }),
    ).toBe(true);

    expect(
      store.protectLocation(testMetadataWriteAuthority(store), {
        identity: { sessionId: "s", sessionFile },
        entryId: "leaf",
        activeAncestryEntryIds: ["root", "leaf"],
        expectation: {
          kind: "exact-resolution",
          resolution: {
            kind: "checkpoint",
            entryId: "root",
            treeOid,
          },
        },
      }),
    ).toEqual({
      kind: "stale",
      protectedSlot: { kind: "blocked-checkpoint", treeOid },
    });
    expect(store.getCheckpointSlot("s", "leaf")).toEqual({
      kind: "blocked-checkpoint",
      treeOid,
    });
    expect(store.hasSessionBarrier({ sessionId: "s", sessionFile })).toBe(true);
    store.close();
  });

  it("accepts an existing block only for the same exact resolution", async () => {
    const { store } = await createStore();
    const sessionFile = "/sessions/s.jsonl";
    const actual = "a".repeat(64);
    const other = "b".repeat(64);
    registerTestSession(store, "s", sessionFile, ["leaf"]);
    commitTestNodeState(store, "s", "leaf", actual);
    expect(
      protectTestLocation(store, { sessionId: "s", sessionFile }, "leaf").kind,
    ).toBe("protected");

    expect(
      store.protectLocation(testMetadataWriteAuthority(store), {
        identity: { sessionId: "s", sessionFile },
        entryId: "leaf",
        activeAncestryEntryIds: ["leaf"],
        expectation: {
          kind: "exact-resolution",
          resolution: {
            kind: "checkpoint",
            entryId: "leaf",
            treeOid: actual,
          },
        },
      }).kind,
    ).toBe("protected");
    expect(
      store.protectLocation(testMetadataWriteAuthority(store), {
        identity: { sessionId: "s", sessionFile },
        entryId: "leaf",
        activeAncestryEntryIds: ["leaf"],
        expectation: {
          kind: "exact-resolution",
          resolution: {
            kind: "checkpoint",
            entryId: "leaf",
            treeOid: other,
          },
        },
      }).kind,
    ).toBe("stale");
    expect(store.getCheckpointSlot("s", "leaf")).toEqual({
      kind: "blocked-checkpoint",
      treeOid: actual,
    });
    store.close();
  });

  it("admits inherited open locations without materializing them", async () => {
    const { store } = await createStore();
    const sessionFile = "/sessions/s.jsonl";
    const rootTree = "a".repeat(64);
    registerTestSession(store, "s", sessionFile, ["root"]);
    commitTestNodeState(store, "s", "root", rootTree);

    expect(
      store.admitResolvedLocation(testMetadataWriteAuthority(store), {
        identity: { sessionId: "s", sessionFile },
        entryId: "leaf",
        activeAncestryEntryIds: ["root", "leaf"],
        expectedResolution: {
          kind: "checkpoint",
          entryId: "root",
          treeOid: rootTree,
        },
      }),
    ).toBe("admitted");
    expect(store.getCheckpointSlot("s", "leaf")).toEqual({
      kind: "open-missing",
    });
    expect(
      store.commitCapture(testMetadataWriteAuthority(store), {
        identity: { sessionId: "s", sessionFile },
        entryId: "root",
        activeAncestryEntryIds: ["root"],
        treeOid: "b".repeat(64),
        expectedSlot: { kind: "open-checkpoint", treeOid: rootTree },
      }),
    ).toBe("committed");
    expect(
      store.admitResolvedLocation(testMetadataWriteAuthority(store), {
        identity: { sessionId: "s", sessionFile },
        entryId: "leaf",
        activeAncestryEntryIds: ["root", "leaf"],
        expectedResolution: {
          kind: "checkpoint",
          entryId: "root",
          treeOid: rootTree,
        },
      }),
    ).toBe("slot-changed");
    expect(store.getCheckpointSlot("s", "leaf")).toEqual({
      kind: "open-missing",
    });
    store.close();
  });

  it("reports a concurrently protected capture slot as blocked", async () => {
    const { store } = await createStore();
    const sessionFile = "/sessions/s.jsonl";
    registerTestSession(store, "s", sessionFile, ["leaf"]);

    expect(
      store.protectLocation(testMetadataWriteAuthority(store), {
        identity: { sessionId: "s", sessionFile },
        entryId: "leaf",
        activeAncestryEntryIds: ["leaf"],
        expectation: { kind: "any-current" },
      }),
    ).toMatchObject({ protectedSlot: { kind: "blocked-missing" } });
    expect(
      store.commitCapture(testMetadataWriteAuthority(store), {
        identity: { sessionId: "s", sessionFile },
        entryId: "leaf",
        activeAncestryEntryIds: ["leaf"],
        treeOid: "a".repeat(64),
        expectedSlot: { kind: "open-missing" },
      }),
    ).toBe("blocked");
    store.close();
  });

  it("releases only an exact matching blocked checkpoint without a session barrier", async () => {
    const { store } = await createStore();
    const sessionFile = "/sessions/s.jsonl";
    const treeOid = "a".repeat(64);
    registerTestSession(store, "s", sessionFile, ["leaf"]);
    commitTestNodeState(store, "s", "leaf", treeOid);
    protectTestLocation(store, { sessionId: "s", sessionFile }, "leaf");

    store.raiseSessionBarrier(testMetadataWriteAuthority(store), {
      sessionId: "s",
      sessionFile,
    });
    const input = {
      identity: { sessionId: "s", sessionFile },
      entryId: "leaf",
      activeAncestryEntryIds: ["leaf"],
      expectedResolution: {
        kind: "checkpoint" as const,
        entryId: "leaf",
        treeOid,
      },
    };
    expect(
      store.admitResolvedLocation(testMetadataWriteAuthority(store), input),
    ).toBe("slot-changed");
    expect(store.getCheckpointSlot("s", "leaf").kind).toBe(
      "blocked-checkpoint",
    );
    expect(
      store.reconcileSessionBarrier(
        testMetadataWriteAuthority(store),
        { sessionId: "s", sessionFile },
        ["leaf"],
      ),
    ).toBe("reconciled");
    expect(
      store.admitResolvedLocation(testMetadataWriteAuthority(store), input),
    ).toBe("admitted");
    expect(store.getCheckpointSlot("s", "leaf")).toEqual({
      kind: "open-checkpoint",
      treeOid,
    });
    store.close();
  });

  it("projects authenticated missing slots and blocks unproven child coordinates", async () => {
    const { store } = await createStore();
    registerTestSession(store, "source", "/sessions/source.jsonl", ["root"]);
    commitTestNodeState(store, "source", "root", "a".repeat(64));
    expect(
      protectTestLocation(
        store,
        {
          sessionId: "source",
          sessionFile: "/sessions/source.jsonl",
        },
        "root",
      ).kind,
    ).toBe("protected");
    expect(
      protectTestLocation(
        store,
        {
          sessionId: "source",
          sessionFile: "/sessions/source.jsonl",
        },
        "missing",
      ).kind,
    ).toBe("protected");
    store.raiseSessionBarrier(testMetadataWriteAuthority(store), {
      sessionId: "source",
      sessionFile: "/sessions/source.jsonl",
    });

    const projection = store.exportForkProjection({
      parentSessionFile: "/sessions/source.jsonl",
      retainedEntryIds: ["root", "missing", "open"],
    });
    expect(projection).toEqual({
      sourceSessionId: "source",
      barrier: true,
      coordinates: [
        {
          entryId: "root",
          slot: {
            kind: "blocked-checkpoint",
            treeOid: "a".repeat(64),
          },
        },
        { entryId: "missing", slot: { kind: "blocked-missing" } },
        { entryId: "open", slot: { kind: "open-missing" } },
      ],
    });

    finalizeTestSessionProjection(store, {
      targetSessionId: "child",
      targetSessionFile: "/sessions/child.jsonl",
      seed: { kind: "fork", projection: projection! },
      retainedEntryIds: ["root", "missing", "open", "child-only"],
      activeAncestryEntryIds: ["root", "child-only"],
    });
    expect(store.getCheckpointSlot("child", "root")).toEqual({
      kind: "blocked-checkpoint",
      treeOid: "a".repeat(64),
    });
    expect(store.getCheckpointSlot("child", "missing")).toEqual({
      kind: "blocked-missing",
    });
    expect(store.getCheckpointSlot("child", "open")).toEqual({
      kind: "open-missing",
    });
    expect(store.getCheckpointSlot("child", "child-only")).toEqual({
      kind: "blocked-missing",
    });
    expect(
      store.hasSessionBarrier({
        sessionId: "child",
        sessionFile: "/sessions/child.jsonl",
      }),
    ).toBe(true);
    store.close();
  });

  it("exports a consistent fork projection while another writer is reserved", async () => {
    const { path, store } = await createStore();
    registerTestSession(store, "source", "/sessions/source.jsonl", ["root"]);
    commitTestNodeState(store, "source", "root", "a".repeat(64));

    const writer = new DatabaseSync(path);
    writer.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
    try {
      expect(
        store.exportForkProjection({
          parentSessionFile: "/sessions/source.jsonl",
          retainedEntryIds: ["root", "missing"],
        }),
      ).toEqual({
        sourceSessionId: "source",
        barrier: false,
        coordinates: [
          {
            entryId: "root",
            slot: { kind: "open-checkpoint", treeOid: "a".repeat(64) },
          },
          { entryId: "missing", slot: { kind: "open-missing" } },
        ],
      });
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
      store.close();
    }
  });

  it("commits an untrusted parent as blocked coordinates plus one session barrier", async () => {
    const { store } = await createStore();

    expect(
      finalizeTestSessionProjection(store, {
        targetSessionId: "child",
        targetSessionFile: "/sessions/child.jsonl",
        seed: { kind: "untrusted-parent" },
        retainedEntryIds: ["root", "leaf"],
        activeAncestryEntryIds: ["root", "leaf"],
      }),
    ).toEqual({ kind: "registered" });
    expect(store.getCheckpointSlot("child", "root")).toEqual({
      kind: "blocked-missing",
    });
    expect(store.getCheckpointSlot("child", "leaf")).toEqual({
      kind: "blocked-missing",
    });
    expect(
      store.hasSessionBarrier({
        sessionId: "child",
        sessionFile: "/sessions/child.jsonl",
      }),
    ).toBe(true);
    store.close();
  });

  it("keeps an untrusted empty parent barrier until a concrete ancestry exists", async () => {
    const { store } = await createStore();
    finalizeTestSessionProjection(store, {
      targetSessionId: "child",
      targetSessionFile: "/sessions/child.jsonl",
      seed: { kind: "untrusted-parent" },
      retainedEntryIds: [],
      activeAncestryEntryIds: [],
    });

    expect(
      store.hasSessionBarrier({
        sessionId: "child",
        sessionFile: "/sessions/child.jsonl",
      }),
    ).toBe(true);
    expect(() =>
      store.reconcileSessionBarrier(
        testMetadataWriteAuthority(store),
        { sessionId: "child", sessionFile: "/sessions/child.jsonl" },
        [],
      ),
    ).toThrow(/without a stable ancestry/u);
    expect(
      store.hasSessionBarrier({
        sessionId: "child",
        sessionFile: "/sessions/child.jsonl",
      }),
    ).toBe(true);
    store.close();
  });

  it("treats a migrated source as unavailable until it is verified", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-export-"));
    roots.push(root);
    const path = join(root, "state.db");
    const legacy = openPublishedV2Metadata(path);
    legacy
      .prepare(
        `INSERT INTO session_registry(
           session_id, session_file, missing_since, missing_observed_at
         ) VALUES (?, ?, NULL, NULL)`,
      )
      .run("source", "/sessions/source.jsonl");
    legacy.close();

    const current = await openCurrentWithTreeUpgrades(path);
    expect(
      current.exportForkProjection({
        parentSessionFile: "/sessions/source.jsonl",
        retainedEntryIds: [],
      }),
    ).toBeUndefined();
    finalizeTestSessionProjection(current, {
      targetSessionId: "source",
      targetSessionFile: "/sessions/source.jsonl",
      retainedEntryIds: [],
      activeAncestryEntryIds: [],
      seed: { kind: "fresh" },
    });
    expect(
      current.exportForkProjection({
        parentSessionFile: "/sessions/source.jsonl",
        retainedEntryIds: [],
      }),
    ).toEqual({
      sourceSessionId: "source",
      barrier: false,
      coordinates: [],
    });
    current.close();
  });

  it("rejects non-string identifiers before SQLite can coerce coordinates", async () => {
    const { path, store } = await createStore();
    expect(() =>
      finalizeTestSessionProjection(store, {
        targetSessionId: 1 as unknown as string,
        targetSessionFile: "/sessions/numeric.jsonl",
        retainedEntryIds: [],
        activeAncestryEntryIds: [],
        seed: { kind: "fresh" },
      }),
    ).toThrow(/non-empty string/u);
    registerTestSession(store, "1.0", "/sessions/string.jsonl");
    expect(() =>
      store.commitCapture(testMetadataWriteAuthority(store), {
        identity: {
          sessionId: 1 as unknown as string,
          sessionFile: "/sessions/string.jsonl",
        },
        entryId: "entry",
        activeAncestryEntryIds: ["entry"],
        treeOid: "a".repeat(64),
        expectedSlot: { kind: "open-missing" },
      }),
    ).toThrow(/non-empty string/u);
    expect(readTestSessionRegistrations(path)).toHaveLength(1);
    store.close();
  });

  it("always defers the published-v1 cutover until tree objects are preflighted", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-deferred-"));
    roots.push(root);
    const path = join(root, "state.db");
    const treeOid = "a".repeat(64);
    const legacy = openPublishedV1Metadata(path);
    legacy
      .prepare(
        `INSERT INTO node_state(session_id, entry_id, tree_oid)
         VALUES (?, ?, ?)`,
      )
      .run("legacy", "entry", treeOid);
    legacy.close();

    if (false) {
      // @ts-expect-error The factory accepts no hidden compatibility options.
      createCurrentMetadataStore(path, {});
    }
    await expect(
      createTestCurrentMetadataStore(path, dirname(path)),
    ).rejects.toThrow(/schema version 1 requires openCurrentMetadataStore/u);

    const untouched = new DatabaseSync(path);
    expect(
      Number(
        (
          untouched.prepare("PRAGMA user_version").get() as {
            user_version: number;
          }
        ).user_version,
      ),
    ).toBe(1);
    expect(untouched.prepare("PRAGMA journal_mode").get()).toEqual({
      journal_mode: "delete",
    });
    expect(untouched.prepare("SELECT tree_oid FROM node_state").all()).toEqual([
      { tree_oid: treeOid },
    ]);
    untouched.close();

    const resumed = await openCurrentWithTreeUpgrades(path);
    expect(checkpointState(resumed, "legacy", "entry")).toEqual({ treeOid });
    resumed.close();
  });

  it("retargets many shared roots with one set-based mapping cutover", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-mapping-"));
    roots.push(root);
    const path = join(root, "state.db");
    const mappings = Array.from({ length: 128 }, (_, index) => ({
      oldTreeOid: (index + 1).toString(16).padStart(64, "0"),
      newTreeOid: (index + 257).toString(16).padStart(64, "0"),
    }));
    const legacy = openPublishedV1Metadata(path);
    const insert = legacy.prepare(
      `INSERT INTO node_state(session_id, entry_id, tree_oid)
       VALUES (?, ?, ?)`,
    );
    for (const [index, mapping] of mappings.entries()) {
      insert.run("legacy", `first-${index}`, mapping.oldTreeOid);
      insert.run("legacy", `second-${index}`, mapping.oldTreeOid);
    }
    legacy.close();

    const upgraded = new Map(
      mappings.map(({ oldTreeOid, newTreeOid }) => [oldTreeOid, newTreeOid]),
    );
    const metadata = await openCurrentWithTreeUpgrades(
      path,
      async (treeOids, targetFormat) =>
        new Map(
          treeOids.map((treeOid) => [
            treeOid,
            targetFormat === TREE_MANIFEST_FORMAT_V2
              ? upgraded.get(treeOid)!
              : treeOid,
          ]),
        ),
    );
    for (const [index, mapping] of mappings.entries()) {
      expect(checkpointState(metadata, "legacy", `first-${index}`)).toEqual({
        treeOid: mapping.newTreeOid,
      });
      expect(checkpointState(metadata, "legacy", `second-${index}`)).toEqual({
        treeOid: mapping.newTreeOid,
      });
    }
    metadata.close();
  });

  it("retries the SQL cutover when authenticated tree roots become stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-tree-cas-"));
    roots.push(root);
    const path = join(root, "state.db");
    const originalTreeOid = "a".repeat(64);
    const lateTreeOid = "b".repeat(64);
    const migratedTreeOid = "c".repeat(64);
    const migratedLateTreeOid = "d".repeat(64);
    const legacy = openPublishedV1Metadata(path);
    legacy
      .prepare(
        `INSERT INTO node_state(session_id, entry_id, tree_oid)
         VALUES (?, ?, ?)`,
      )
      .run("legacy", "original", originalTreeOid);
    legacy.close();

    let preparation = 0;
    const metadata = await openCurrentWithTreeUpgrades(
      path,
      async (authenticatedRoots, targetFormat) => {
        if (targetFormat !== TREE_MANIFEST_FORMAT_V2) {
          return new Map(
            authenticatedRoots.map((treeOid) => [treeOid, treeOid]),
          );
        }
        preparation += 1;
        if (preparation === 2) {
          expect(authenticatedRoots).toEqual([originalTreeOid, lateTreeOid]);
          return new Map([
            [originalTreeOid, migratedTreeOid],
            [lateTreeOid, migratedLateTreeOid],
          ]);
        }
        expect(authenticatedRoots).toEqual([originalTreeOid]);
        const interveningWriter = new DatabaseSync(path);
        interveningWriter
          .prepare(
            `INSERT INTO node_state(session_id, entry_id, tree_oid)
             VALUES (?, ?, ?)`,
          )
          .run("legacy", "late", lateTreeOid);
        interveningWriter.close();
        return new Map([[originalTreeOid, migratedTreeOid]]);
      },
    );
    expect(preparation).toBe(2);
    expect(checkpointState(metadata, "legacy", "original")).toEqual({
      treeOid: migratedTreeOid,
    });
    expect(checkpointState(metadata, "legacy", "late")).toEqual({
      treeOid: migratedLateTreeOid,
    });
    metadata.close();

    const check = new DatabaseSync(path, { readOnly: true });
    expect(
      Number(
        (
          check.prepare("PRAGMA user_version").get() as {
            user_version: number;
          }
        ).user_version,
      ),
    ).toBe(CURRENT_METADATA_VERSION.version);
    check.close();
  });

  it("fences every metadata mutation from a published-v1 connection kept live across migration", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-live-v1-"));
    roots.push(root);
    const path = join(root, "state.db");
    const original = "a".repeat(64);
    const replacement = "b".repeat(64);
    const legacy = openPublishedV1Metadata(path);
    legacy
      .prepare(
        `INSERT INTO node_state(session_id, entry_id, tree_oid)
         VALUES (?, ?, ?)`,
      )
      .run("legacy", "entry", original);
    legacy
      .prepare(
        `INSERT INTO session_registry(
           session_id, session_file, missing_since, missing_observed_at
         ) VALUES (?, ?, NULL, NULL)`,
      )
      .run("legacy", "/sessions/legacy.jsonl");

    const current = await openCurrentWithTreeUpgrades(path);
    expect(() =>
      protectTestLocation(
        current,
        {
          sessionId: "legacy",
          sessionFile: "/sessions/legacy.jsonl",
        },
        "entry",
      ),
    ).toThrow(/not verified/u);
    expect(
      finalizeTestSessionProjection(current, {
        targetSessionId: "legacy",
        targetSessionFile: "/sessions/legacy.jsonl",
        retainedEntryIds: ["entry"],
        activeAncestryEntryIds: ["entry"],
        seed: { kind: "fresh" },
      }),
    ).toEqual({ kind: "existing" });
    expect(
      protectTestLocation(
        current,
        {
          sessionId: "legacy",
          sessionFile: "/sessions/legacy.jsonl",
        },
        "entry",
      ).kind,
    ).toBe("protected");

    const staleMutations = [
      () =>
        legacy
          .prepare(
            `INSERT INTO node_state(session_id, entry_id, tree_oid)
             VALUES ('legacy', 'new-entry', ?)`,
          )
          .run(replacement),
      () =>
        legacy
          .prepare(
            `UPDATE node_state SET tree_oid = ?
             WHERE session_id = 'legacy' AND entry_id = 'entry'`,
          )
          .run(replacement),
      () =>
        legacy
          .prepare(
            `DELETE FROM node_state
             WHERE session_id = 'legacy' AND entry_id = 'entry'`,
          )
          .run(),
      () =>
        legacy
          .prepare(
            `INSERT INTO node_write_guard(session_id, entry_id)
             VALUES ('legacy', 'new-guard')`,
          )
          .run(),
      () =>
        legacy
          .prepare(
            `UPDATE node_write_guard SET entry_id = 'moved-entry'
             WHERE session_id = 'legacy' AND entry_id = 'entry'`,
          )
          .run(),
      () =>
        legacy
          .prepare(
            `DELETE FROM node_write_guard
             WHERE session_id = 'legacy' AND entry_id = 'entry'`,
          )
          .run(),
      () =>
        legacy
          .prepare(
            `INSERT INTO session_registry(
               session_id, session_file, missing_since, missing_observed_at
             ) VALUES ('new-session', '/sessions/new.jsonl', NULL, NULL)`,
          )
          .run(),
      () =>
        legacy
          .prepare(
            `UPDATE session_registry SET missing_since = 1
             WHERE session_id = 'legacy'`,
          )
          .run(),
      () =>
        legacy
          .prepare("DELETE FROM session_registry WHERE session_id = 'legacy'")
          .run(),
    ];
    for (const mutate of staleMutations) {
      expect(mutate).toThrow(
        /no such function: cyclotomy_writer_protocol|no such table|no (?:such column:|column named) missing_since/u,
      );
    }

    expect(checkpointState(current, "legacy", "entry")).toEqual({
      treeOid: original,
    });
    expect(checkpointState(current, "legacy", "new-entry")).toBeUndefined();
    expect(checkpointIsBlocked(current, "legacy", "entry")).toBe(true);
    expect(checkpointIsBlocked(current, "legacy", "new-guard")).toBe(false);
    expect(readTestSessionRegistrations(path)).toEqual([
      {
        sessionId: "legacy",
        sessionFile: "/sessions/legacy.jsonl",
        captureBarrier: false,
        registrationState: "verified",
      },
    ]);
    current.close();
    legacy.close();
  });

  it("fences a prepared write from a published-v1 process kept live across migration", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "cyclotomy-metadata-live-v1-process-"),
    );
    roots.push(root);
    const path = join(root, "state.db");
    const original = "a".repeat(64);
    const legacy = openPublishedV1Metadata(path);
    legacy
      .prepare(
        `INSERT INTO node_state(session_id, entry_id, tree_oid)
         VALUES ('legacy-process', 'entry', ?)`,
      )
      .run(original);
    legacy
      .prepare(
        `INSERT INTO session_registry(
           session_id, session_file, missing_since, missing_observed_at
         ) VALUES ('legacy-process', '/sessions/legacy-process.jsonl', NULL, NULL)`,
      )
      .run();
    legacy.close();

    const child = startMetadataChild(path, 1, "legacy-live");
    try {
      await child.ready;
      const opened = waitForChildMessage(child.process, "opened", child.stderr);

      const current = await openCurrentWithTreeUpgrades(path);
      finalizeTestSessionProjection(current, {
        targetSessionId: "legacy-process",
        targetSessionFile: "/sessions/legacy-process.jsonl",
        retainedEntryIds: ["entry"],
        activeAncestryEntryIds: ["entry"],
        seed: { kind: "fresh" },
      });
      expect(
        protectTestLocation(
          current,
          {
            sessionId: "legacy-process",
            sessionFile: "/sessions/legacy-process.jsonl",
          },
          "entry",
        ).kind,
      ).toBe("protected");
      child.process.send?.("start");
      const result = await opened;
      await waitForChildExit(child);

      expect(result.blocked).toBe(true);
      expect(result.message).toMatch(
        /no such function: cyclotomy_writer_protocol|no such table/u,
      );
      expect(checkpointState(current, "legacy-process", "entry")).toEqual({
        treeOid: original,
      });
      expect(checkpointIsBlocked(current, "legacy-process", "entry")).toBe(
        true,
      );
      current.close();
    } finally {
      if (child.process.exitCode === null) child.process.kill("SIGKILL");
      await waitForChildExit(child);
    }
  });

  it.each(["fresh", "published-v1"] as const)(
    "serializes concurrent %s schema opening from the locked version",
    async (startingSchema) => {
      const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-race-"));
      roots.push(root);
      const path = join(root, "state.db");
      const gate =
        startingSchema === "published-v1"
          ? openPublishedV1Metadata(path)
          : new DatabaseSync(path);
      gate.exec("PRAGMA journal_mode=WAL;");
      gate.exec("BEGIN IMMEDIATE;");
      let gateOpen = true;
      const releasePath = join(root, "schema-gate-release");
      const pausedPaths = Array.from({ length: 4 }, (_, index) =>
        join(root, `schema-gate-paused-${index}`),
      );
      const children = pausedPaths.map((pausedPath) =>
        startMetadataChild(path, 1, "gated-write", {
          pausedPath,
          releasePath,
        }),
      );

      try {
        await Promise.all(children.map((child) => child.ready));
        const opening = children.map((child) =>
          waitForChildMessage(child.process, "opening", child.stderr),
        );
        for (const child of children) child.process.send?.("start");
        await Promise.all(opening);
        // The exclusive workspace lease admits one opener to SQLite's schema
        // gate; the remaining openers wait outside the mutation boundary.
        await waitForAnyGatePause(children, pausedPaths);
        const opened = children.map((child) =>
          waitForChildMessage(child.process, "opened", child.stderr),
        );
        gate.exec("COMMIT;");
        gateOpen = false;
        await writeFile(releasePath, "", { flag: "wx" });

        const results = await Promise.all(opened);
        await Promise.all(children.map((child) => waitForChildExit(child)));
        const check = new DatabaseSync(path);
        expect(
          Number(
            (
              check.prepare("PRAGMA user_version").get() as {
                user_version: number;
              }
            ).user_version,
          ),
        ).toBe(CURRENT_METADATA_VERSION.version);
        check.close();
        const store = await createTestCurrentMetadataStore(path, dirname(path));
        for (const result of results) {
          expect(
            checkpointState(
              store,
              `concurrent-open-${result.pid}`,
              `${result.pid}-0`,
            ),
          ).toEqual({ treeOid: "a".repeat(64) });
        }
        store.close();
      } finally {
        if (gateOpen) {
          try {
            gate.exec("ROLLBACK;");
          } catch {
            // Preserve the test failure.
          }
        }
        gate.close();
        for (const child of children) {
          if (child.process.exitCode === null) child.process.kill("SIGKILL");
        }
        await Promise.all(children.map((child) => waitForChildExit(child)));
      }
    },
  );

  it("tolerates concurrent SQLite WAL sidecar lifecycle churn", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-churn-"));
    roots.push(root);
    const path = join(root, "state.db");
    const initial = await createTestCurrentMetadataStore(path, dirname(path));
    initial.close();

    const iterations = 20;
    const children = Array.from({ length: 4 }, () =>
      startMetadataChild(path, iterations, "open-only"),
    );
    try {
      await Promise.all(children.map((child) => child.ready));
      const opening = children.map((child) =>
        waitForChildMessage(child.process, "opening", child.stderr),
      );
      const opened = children.map((child) =>
        waitForChildMessage(child.process, "opened", child.stderr),
      );
      for (const child of children) child.process.send?.("start");
      await Promise.all(opening);
      await Promise.all(opened);
      await Promise.all(children.map((child) => waitForChildExit(child)));

      const store = await createTestCurrentMetadataStore(path, dirname(path));
      expect(
        checkpointState(store, "concurrent-open", "unused"),
      ).toBeUndefined();
      store.close();
    } finally {
      for (const child of children) {
        if (child.process.exitCode === null) child.process.kill("SIGKILL");
      }
      await Promise.all(children.map((child) => waitForChildExit(child)));
    }
  });

  it("does not expose historical capabilities through the current factory", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-identity-"));
    roots.push(root);
    const path = join(root, "state.db");
    const legacy = openPublishedV1Metadata(path);
    legacy
      .prepare(
        `INSERT INTO session_registry(
           session_id, session_file, missing_since, missing_observed_at
         ) VALUES (?, ?, NULL, NULL)`,
      )
      .run("source", "/sessions/source.jsonl");
    legacy.close();

    await expect(
      createTestCurrentMetadataStore(path, dirname(path)),
    ).rejects.toThrow(/schema version 1 requires openCurrentMetadataStore/u);
    const store = await openCurrentWithTreeUpgrades(path);
    expect(store.matchSessionIdentity("missing", "/missing.jsonl")).toBe(
      "absent",
    );
    expect(store.matchSessionIdentity("source", "/sessions/source.jsonl")).toBe(
      "exact",
    );
    expect(store.matchSessionIdentity("other", "/sessions/source.jsonl")).toBe(
      "conflict",
    );
    expect(store.matchSessionIdentity("source", "/sessions/other.jsonl")).toBe(
      "conflict",
    );
    store.close();
  });

  it("authenticates a clean current store without changing any files", async () => {
    const { root, path, store } = await createStore();
    registerTestSession(store, "source", "/sessions/source.jsonl");
    store.close();
    const before = await snapshotDirectory(root);

    const inspection = inspectMetadataSessionIdentity(
      path,
      "source",
      "/sessions/source.jsonl",
    );
    expect(inspection.kind).toBe("exact");
    expect(await snapshotDirectory(root)).toEqual(before);
    if (inspection.kind !== "exact") throw new Error("expected exact proof");

    const authenticated = await openAuthenticatedWithLease(
      root,
      inspection.proof,
      {
        prepareTreeOidUpgrades: async (roots) =>
          new Map(roots.map((treeOid) => [treeOid, treeOid])),
      },
    );
    expect(
      authenticated.matchSessionIdentity("source", "/sessions/source.jsonl"),
    ).toBe("exact");
    authenticated.close();
  });

  it.each(["journal", "wal", "shm"] as const)(
    "reports that an unrecovered metadata -%s sidecar requires recovery",
    async (sidecar) => {
      const { path, store } = await createStore();
      registerTestSession(store, "source", "/sessions/source.jsonl");
      store.close();
      if (sidecar === "wal") await rm(`${path}-shm`, { force: true });
      await writeFile(`${path}-${sidecar}`, "unrecovered sidecar sentinel");

      expect(
        inspectMetadataSessionIdentity(
          path,
          "source",
          "/sessions/source.jsonl",
        ),
      ).toMatchObject({
        kind: "recovery-required",
        cause: expect.objectContaining({
          name: MetadataError.name,
          message: expect.stringMatching(/require recovery/u),
        }),
      });
    },
  );

  it("allows a transient unpaired WAL sidecar to settle before inspection", async () => {
    const { path, store } = await createStore();
    registerTestSession(store, "source", "/sessions/source.jsonl");
    store.close();
    await writeFile(`${path}-wal`, "transient WAL sentinel");
    const child = startMetadataChild(path, 1, "settle-sidecar");
    let opened: Promise<MetadataChildMessage> | undefined;

    try {
      await child.ready;
      const opening = waitForChildMessage(
        child.process,
        "opening",
        child.stderr,
      );
      child.process.send?.("start");
      await opening;
      opened = waitForChildMessage(child.process, "opened", child.stderr);
      child.process.send?.("settle");

      expect(
        inspectMetadataSessionIdentity(
          path,
          "source",
          "/sessions/source.jsonl",
        ),
      ).toMatchObject({ kind: "exact" });
      await opened;
      child.process.send?.("finish");
      await waitForChildExit(child);
    } finally {
      if (child.process.exitCode === null) child.process.kill("SIGKILL");
      await opened?.catch(() => {});
      await waitForChildExit(child);
    }
  });

  it("probes published v1 identity variants without migrating or switching journals", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-probe-v1-"));
    roots.push(root);
    const path = join(root, "state.db");
    const legacy = openPublishedV1Metadata(path);
    legacy
      .prepare(
        `INSERT INTO session_registry(
           session_id, session_file, missing_since, missing_observed_at
         ) VALUES (?, ?, NULL, NULL)`,
      )
      .run("source", "/sessions/source.jsonl");
    legacy.close();
    const before = await snapshotDirectory(root);

    const exact = inspectMetadataSessionIdentity(
      path,
      "source",
      "/sessions/source.jsonl",
    );
    expect(exact.kind).toBe("exact");
    expect(
      inspectMetadataSessionIdentity(path, "missing", "/missing.jsonl"),
    ).toEqual({ kind: "absent" });
    expect(
      inspectMetadataSessionIdentity(path, "other", "/sessions/source.jsonl"),
    ).toEqual({ kind: "conflict" });
    expect(await snapshotDirectory(root)).toEqual(before);

    if (exact.kind !== "exact") throw new Error("expected exact proof");
    const authenticated = await openAuthenticatedWithLease(root, exact.proof, {
      prepareTreeOidUpgrades: async (roots) =>
        new Map(roots.map((treeOid) => [treeOid, treeOid])),
    });
    expect(
      authenticated.matchSessionIdentity("source", "/sessions/source.jsonl"),
    ).toBe("exact");
    authenticated.close();
  });

  it("authenticates published v2 through the recognized-version path", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-probe-v2-"));
    roots.push(root);
    const path = join(root, "state.db");
    const published = openPublishedV2Metadata(path);
    published
      .prepare(
        `INSERT INTO session_registry(
           session_id, session_file, missing_since, missing_observed_at
         ) VALUES (?, ?, NULL, NULL)`,
      )
      .run("source", "/sessions/source.jsonl");
    published.close();
    const before = await snapshotDirectory(root);

    const inspection = inspectMetadataSessionIdentity(
      path,
      "source",
      "/sessions/source.jsonl",
    );
    expect(inspection.kind).toBe("exact");
    expect(await snapshotDirectory(root)).toEqual(before);
    if (inspection.kind !== "exact") throw new Error("expected exact proof");

    const authenticated = await openAuthenticatedWithLease(
      root,
      inspection.proof,
      {
        prepareTreeOidUpgrades: async (roots) =>
          new Map(roots.map((treeOid) => [treeOid, treeOid])),
      },
    );
    authenticated.close();
  });

  it.each([
    { version: 0, label: "unversioned" },
    { version: 1, label: "forged-v1" },
  ])(
    "leaves an unrelated $label SQLite database byte-for-byte untouched",
    async ({ version }) => {
      const root = await mkdtemp(
        join(tmpdir(), "cyclotomy-metadata-probe-unrelated-"),
      );
      roots.push(root);
      const path = join(root, "state.db");
      const unrelated = new DatabaseSync(path);
      unrelated.exec(`
        CREATE TABLE unrelated(value TEXT);
        INSERT INTO unrelated(value) VALUES ('keep me');
        PRAGMA user_version = ${version};
      `);
      unrelated.close();
      const before = await snapshotDirectory(root);

      expect(
        inspectMetadataSessionIdentity(
          path,
          "source",
          "/sessions/source.jsonl",
        ),
      ).toEqual({ kind: "unrecognized" });
      expect(await snapshotDirectory(root)).toEqual(before);

      const check = new DatabaseSync(path, { readOnly: true });
      expect(
        Number(
          (
            check.prepare("PRAGMA user_version").get() as {
              user_version: number;
            }
          ).user_version,
        ),
      ).toBe(version);
      expect(check.prepare("PRAGMA journal_mode").get()).toEqual({
        journal_mode: "delete",
      });
      expect(check.prepare("SELECT value FROM unrelated").get()).toEqual({
        value: "keep me",
      });
      check.close();
      expect((await readdir(root)).sort()).toEqual(["state.db"]);
    },
  );

  it("classifies a newer schema without validating or changing its layout", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "cyclotomy-metadata-probe-newer-"),
    );
    roots.push(root);
    const path = join(root, "state.db");
    const newerVersion = CURRENT_METADATA_VERSION.version + 1;
    const unrelated = new DatabaseSync(path);
    unrelated.exec(`
      CREATE TABLE unrelated(value TEXT);
      INSERT INTO unrelated(value) VALUES ('keep me');
      PRAGMA user_version = ${newerVersion};
    `);
    unrelated.close();
    const before = await snapshotDirectory(root);

    expect(
      inspectMetadataSessionIdentity(path, "source", "/sessions/source.jsonl"),
    ).toEqual({
      kind: "newer",
      observedVersion: newerVersion,
      supportedVersion: CURRENT_METADATA_VERSION.version,
    });
    expect(await snapshotDirectory(root)).toEqual(before);
  });

  it("reads a live WAL without changing its durable database bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-probe-wal-"));
    roots.push(root);
    const path = join(root, "state.db");
    const live = openPublishedV1Metadata(path);
    live.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
    live
      .prepare(
        `INSERT INTO session_registry(
           session_id, session_file, missing_since, missing_observed_at
         ) VALUES (?, ?, NULL, NULL)`,
      )
      .run("source", "/sessions/source.jsonl");
    const namesBefore = (await readdir(root)).sort();
    const databaseBefore = await readFile(path);
    const walBefore = await readFile(`${path}-wal`);

    expect(
      inspectMetadataSessionIdentity(path, "source", "/sessions/source.jsonl")
        .kind,
    ).toBe("exact");
    expect((await readdir(root)).sort()).toEqual(namesBefore);
    expect(await readFile(path)).toEqual(databaseBefore);
    expect(await readFile(`${path}-wal`)).toEqual(walBefore);
    live.close();
  });

  it("rejects an authenticated proof after the database pathname is rebound", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "cyclotomy-metadata-probe-rebound-"),
    );
    roots.push(root);
    const path = join(root, "state.db");
    const legacy = openPublishedV1Metadata(path);
    legacy
      .prepare(
        `INSERT INTO session_registry(
           session_id, session_file, missing_since, missing_observed_at
         ) VALUES (?, ?, NULL, NULL)`,
      )
      .run("source", "/sessions/source.jsonl");
    legacy.close();
    const inspection = inspectMetadataSessionIdentity(
      path,
      "source",
      "/sessions/source.jsonl",
    );
    if (inspection.kind !== "exact") throw new Error("expected exact proof");

    await rename(path, `${path}.authenticated`);
    const replacement = new DatabaseSync(path);
    replacement.exec("CREATE TABLE unrelated(value TEXT)");
    replacement.close();
    const before = await snapshotDirectory(root);

    await expect(
      Promise.resolve().then(() =>
        openAuthenticatedWithLease(root, inspection.proof, {
          prepareTreeOidUpgrades: async (roots) =>
            new Map(roots.map((treeOid) => [treeOid, treeOid])),
        }),
      ),
    ).rejects.toThrow(/changed after identity was authenticated/u);
    expect(await snapshotDirectory(root)).toEqual(before);
  });

  it("rechecks an authenticated identity before WAL when the inode changed in place", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "cyclotomy-metadata-probe-rewritten-"),
    );
    roots.push(root);
    const path = join(root, "state.db");
    const legacy = openPublishedV1Metadata(path);
    legacy
      .prepare(
        `INSERT INTO session_registry(
           session_id, session_file, missing_since, missing_observed_at
         ) VALUES (?, ?, NULL, NULL)`,
      )
      .run("source", "/sessions/source.jsonl");
    legacy.close();
    const inspection = inspectMetadataSessionIdentity(
      path,
      "source",
      "/sessions/source.jsonl",
    );
    if (inspection.kind !== "exact") throw new Error("expected exact proof");

    const replacementPath = join(root, "replacement.db");
    const replacement = new DatabaseSync(replacementPath);
    replacement.exec("CREATE TABLE unrelated(value TEXT)");
    replacement.close();
    const inode = (await stat(path)).ino;
    await writeFile(path, await readFile(replacementPath));
    expect((await stat(path)).ino).toBe(inode);
    const before = await snapshotDirectory(root);

    await expect(
      Promise.resolve().then(() =>
        openAuthenticatedWithLease(root, inspection.proof, {
          prepareTreeOidUpgrades: async (roots) =>
            new Map(roots.map((treeOid) => [treeOid, treeOid])),
        }),
      ),
    ).rejects.toThrow(/identity changed before authenticated write access/u);
    expect(await snapshotDirectory(root)).toEqual(before);
  });

  it("never registers a fork under its parent's session id", async () => {
    const { path, store } = await createStore();
    expect(() =>
      finalizeTestSessionProjection(store, {
        targetSessionId: "same",
        targetSessionFile: "/sessions/child.jsonl",
        retainedEntryIds: [],
        activeAncestryEntryIds: [],
        seed: {
          kind: "fork",
          projection: {
            sourceSessionId: "same",
            barrier: false,
            coordinates: [],
          },
        },
      }),
    ).toThrow(/source and target session ids must differ/u);
    expect(readTestSessionRegistration(path, "same")).toBeUndefined();
    store.close();
  });

  it("enforces unique ownership of a persisted session file", async () => {
    const { path, store } = await createStore();
    registerTestSession(store, "s1", "/sessions/shared.jsonl");
    expect(() =>
      registerTestSession(store, "s2", "/sessions/shared.jsonl"),
    ).toThrow();
    expect(readTestSessionRegistrations(path)).toHaveLength(1);
    store.close();
  });

  it("never remaps one session id to a different persisted file", async () => {
    const { path, store } = await createStore();
    registerTestSession(store, "same", "/sessions/original.jsonl");
    expect(() =>
      finalizeTestSessionProjection(store, {
        targetSessionId: "same",
        targetSessionFile: "/sessions/duplicate.jsonl",
        retainedEntryIds: [],
        activeAncestryEntryIds: [],
        seed: { kind: "fresh" },
      }),
    ).toThrow(MetadataError);
    expect(readTestSessionRegistrations(path)).toEqual([
      expect.objectContaining({
        sessionId: "same",
        sessionFile: "/sessions/original.jsonl",
      }),
    ]);
    store.close();
  });

  it("moves a session capture barrier onto the first observed ancestry atomically", async () => {
    const { path, store } = await createStore();
    const sessionFile = "/sessions/s.jsonl";
    registerTestSession(store, "s", sessionFile);
    expect(store.hasSessionBarrier({ sessionId: "s", sessionFile })).toBe(
      false,
    );
    expect(
      store.raiseSessionBarrier(testMetadataWriteAuthority(store), {
        sessionId: "s",
        sessionFile,
      }),
    ).toBe(true);
    expect(store.hasSessionBarrier({ sessionId: "s", sessionFile })).toBe(true);

    const second = createCurrentMetadataStore(
      path,
      testMetadataWriteAuthority(store),
    );
    bindTestMetadataWriteAuthority(
      second,
      testMetadataWriteAuthority(store),
      dirname(path),
    );
    expect(
      second.reconcileSessionBarrier(
        testMetadataWriteAuthority(second),
        { sessionId: "s", sessionFile },
        ["first-child", "second-child"],
      ),
    ).toBe("reconciled");
    expect(store.hasSessionBarrier({ sessionId: "s", sessionFile })).toBe(
      false,
    );
    expect(checkpointIsBlocked(store, "s", "first-child")).toBe(true);
    expect(checkpointIsBlocked(store, "s", "second-child")).toBe(true);
    expect(
      store.commitCapture(testMetadataWriteAuthority(store), {
        identity: { sessionId: "s", sessionFile },
        entryId: "first-child",
        activeAncestryEntryIds: ["first-child"],
        treeOid: "a".repeat(64),
        expectedSlot: store.getCheckpointSlot("s", "first-child"),
      }),
    ).toBe("blocked");
    expect(
      store.reconcileSessionBarrier(
        testMetadataWriteAuthority(store),
        { sessionId: "s", sessionFile },
        ["later-child"],
      ),
    ).toBe("absent");
    expect(checkpointIsBlocked(store, "s", "later-child")).toBe(false);

    // Commit CAS operations provide the same transaction boundary if another
    // SQLite connection sets the flag after an earlier runtime observation.
    expect(
      second.raiseSessionBarrier(testMetadataWriteAuthority(second), {
        sessionId: "s",
        sessionFile,
      }),
    ).toBe(true);
    expect(
      store.commitCapture(testMetadataWriteAuthority(store), {
        identity: { sessionId: "s", sessionFile },
        entryId: "capture-race",
        activeAncestryEntryIds: ["capture-race"],
        treeOid: "b".repeat(64),
        expectedSlot: { kind: "open-missing" },
      }),
    ).toBe("blocked");
    expect(checkpointState(store, "s", "capture-race")).toBeUndefined();
    expect(checkpointIsBlocked(store, "s", "capture-race")).toBe(true);
    expect(
      second.raiseSessionBarrier(testMetadataWriteAuthority(second), {
        sessionId: "s",
        sessionFile,
      }),
    ).toBe(true);
    expect(
      store.commitCapture(testMetadataWriteAuthority(store), {
        identity: { sessionId: "s", sessionFile },
        entryId: "materialize-race",
        activeAncestryEntryIds: ["materialize-race"],
        treeOid: "c".repeat(64),
        expectedSlot: { kind: "open-missing" },
      }),
    ).toBe("blocked");
    expect(checkpointState(store, "s", "materialize-race")).toBeUndefined();
    expect(checkpointIsBlocked(store, "s", "materialize-race")).toBe(true);
    expect(store.hasSessionBarrier({ sessionId: "s", sessionFile })).toBe(
      false,
    );
    second.close();
    store.close();
  });

  it("authenticates capture barrier updates against the exact registered file", async () => {
    const { store } = await createStore();
    const sessionFile = "/sessions/s.jsonl";
    registerTestSession(store, "s", sessionFile);

    expect(
      store.hasSessionBarrier({
        sessionId: "s",
        sessionFile: "/sessions/other.jsonl",
      }),
    ).toBeUndefined();
    expect(() =>
      store.raiseSessionBarrier(testMetadataWriteAuthority(store), {
        sessionId: "s",
        sessionFile: "/sessions/other.jsonl",
      }),
    ).toThrow(/not verified/u);
    expect(
      store.reconcileSessionBarrier(
        testMetadataWriteAuthority(store),
        { sessionId: "s", sessionFile: "/sessions/other.jsonl" },
        ["child"],
      ),
    ).toBe("unregistered");
    expect(
      store.raiseSessionBarrier(testMetadataWriteAuthority(store), {
        sessionId: "s",
        sessionFile,
      }),
    ).toBe(true);
    expect(
      store.reconcileSessionBarrier(
        testMetadataWriteAuthority(store),
        { sessionId: "s", sessionFile },
        ["child"],
      ),
    ).toBe("reconciled");
    expect(store.hasSessionBarrier({ sessionId: "s", sessionFile })).toBe(
      false,
    );
    store.close();
  });

  it("roots only current node states for object collection", async () => {
    const { store } = await createStore();
    commitTestNodeState(store, "s1", "e1", "a".repeat(64));
    commitTestNodeState(store, "s2", "e2", "a".repeat(64));
    commitTestNodeState(store, "s2", "e3", "b".repeat(64));
    expect(store.listReferencedTreeOids()).toEqual([
      "a".repeat(64),
      "b".repeat(64),
    ]);
    store.close();
  });

  it("refuses a pre-created metadata symlink without writing its target", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-link-"));
    roots.push(root);
    const path = join(root, "state.db");
    const outside = join(root, "outside.db");
    await symlink(outside, path);

    await expect(
      createTestCurrentMetadataStore(path, dirname(path)),
    ).rejects.toThrow(/single-link regular file/u);
    await expect(stat(outside)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves the system cause of an unsafe identity-inspection path", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-cause-"));
    roots.push(root);
    const path = join(root, "missing.db");

    let failure: unknown;
    try {
      inspectMetadataSessionIdentity(path, "source", "/sessions/source.jsonl");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(MetadataError);
    expect((failure as MetadataError).cause).toMatchObject({ code: "ENOENT" });
  });

  it("refuses a hard-linked metadata database", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-hardlink-"));
    roots.push(root);
    const outside = join(root, "outside.db");
    const seeded = new DatabaseSync(outside);
    seeded.close();
    const path = join(root, "state.db");
    await link(outside, path);

    await expect(
      createTestCurrentMetadataStore(path, dirname(path)),
    ).rejects.toThrow(/single-link regular file/u);
  });

  it.each(["wal", "shm"])(
    "refuses a stable symlink at the metadata -%s sidecar",
    async (sidecar) => {
      const { root, path, store } = await createStore();
      store.close();
      const outside = join(root, `outside-${sidecar}`);
      await symlink(outside, `${path}-${sidecar}`);

      expect(() =>
        createCurrentMetadataStore(path, testMetadataWriteAuthority(store)),
      ).toThrow(/single-link regular file/u);
      await expect(stat(outside)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("refuses a stable hard link at a metadata sidecar", async () => {
    const { root, path, store } = await createStore();
    store.close();
    const outside = join(root, "outside-sidecar");
    const seeded = new DatabaseSync(outside);
    seeded.close();
    await link(outside, `${path}-wal`);

    expect(() =>
      createCurrentMetadataStore(path, testMetadataWriteAuthority(store)),
    ).toThrow(/single-link regular file/u);
  });

  it("refuses a stable non-file metadata sidecar", async () => {
    const { path, store } = await createStore();
    store.close();
    await mkdir(`${path}-shm`);

    expect(() =>
      createCurrentMetadataStore(path, testMetadataWriteAuthority(store)),
    ).toThrow(/single-link regular file/u);
  });

  it("rejects a claimed current version whose physical schema is incomplete", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-shape-"));
    roots.push(root);
    const path = join(root, "state.db");
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA user_version = ${CURRENT_METADATA_VERSION.version}`);
    db.close();

    await expect(
      createTestCurrentMetadataStore(path, dirname(path)),
    ).rejects.toThrow(/does not match the metadata v4 layout/u);
  });

  it("authenticates string literals in the current schema exactly", async () => {
    const { path, store } = await createStore();
    store.close();
    const forged = new DatabaseSync(path);
    forged.enableDefensive(false);
    forged.exec("PRAGMA writable_schema = ON");
    const changed = forged
      .prepare(
        `UPDATE sqlite_schema
         SET sql = replace(
           sql,
           '''pending'', ''verified''',
           '''PENDING'', ''VERIFIED'''
         )
         WHERE name = 'session_registry'`,
      )
      .run();
    forged.exec("PRAGMA writable_schema = OFF");
    forged.close();
    expect(Number(changed.changes)).toBe(1);

    expect(() =>
      createCurrentMetadataStore(path, testMetadataWriteAuthority(store)),
    ).toThrow(/does not match the metadata v4 layout/u);
  });

  it("does not normalize whitespace inside schema string literals", async () => {
    const { path, store } = await createStore();
    store.close();
    const forged = new DatabaseSync(path);
    forged.enableDefensive(false);
    forged.exec("PRAGMA writable_schema = ON");
    const changed = forged
      .prepare(
        `UPDATE sqlite_schema
         SET sql = replace(
           sql,
           'writer protocol mismatch',
           'writer  protocol mismatch'
         )
         WHERE type = 'trigger'`,
      )
      .run();
    forged.exec("PRAGMA writable_schema = OFF");
    forged.close();
    expect(Number(changed.changes)).toBe(9);

    expect(() =>
      createCurrentMetadataStore(path, testMetadataWriteAuthority(store)),
    ).toThrow(/does not match the metadata v4 layout/u);
  });

  it("rejects a non-public claimed v1 before making migration changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-fake-v1-"));
    roots.push(root);
    const path = join(root, "state.db");
    const forged = openPublishedV1Metadata(path);
    forged.exec("ALTER TABLE node_state ADD COLUMN forged TEXT");
    forged.close();

    await expect(
      createTestCurrentMetadataStore(path, dirname(path)),
    ).rejects.toThrow(/does not match the published v1 layout/u);

    const check = new DatabaseSync(path);
    expect(
      Number(
        (
          check.prepare("PRAGMA user_version").get() as {
            user_version: number;
          }
        ).user_version,
      ),
    ).toBe(1);
    expect(
      check
        .prepare(
          `SELECT name FROM sqlite_schema
           WHERE type = 'table' AND name NOT GLOB 'sqlite_*'
           ORDER BY name`,
        )
        .all()
        .map((row) => String(row.name)),
    ).toEqual(["node_state", "session_registry"]);
    expect(
      check
        .prepare("PRAGMA table_info(session_registry)")
        .all()
        .map((row) => String(row.name)),
    ).not.toContain("pending_node_guard");
    check.close();
  });

  it("rejects a claimed v1 whose SQL adds an unshipped constraint", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-check-v1-"));
    roots.push(root);
    const path = join(root, "state.db");
    const forged = new DatabaseSync(path);
    forged.exec(`
      CREATE TABLE node_state(
        session_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        tree_oid TEXT NOT NULL,
        PRIMARY KEY(session_id, entry_id)
      ) STRICT, WITHOUT ROWID;

      CREATE TABLE session_registry(
        session_id TEXT NOT NULL PRIMARY KEY,
        session_file TEXT NOT NULL UNIQUE,
        missing_since INTEGER,
        missing_observed_at INTEGER,
        CHECK(missing_since IS NULL OR missing_since >= 0)
      ) STRICT, WITHOUT ROWID;

      CREATE INDEX session_registry_missing
      ON session_registry(missing_since, missing_observed_at);

      PRAGMA user_version = 1;
    `);
    forged.close();

    await expect(
      createTestCurrentMetadataStore(path, dirname(path)),
    ).rejects.toThrow(/does not match the published v1 layout/u);
    const check = new DatabaseSync(path);
    expect(
      Number(
        (
          check.prepare("PRAGMA user_version").get() as {
            user_version: number;
          }
        ).user_version,
      ),
    ).toBe(1);
    expect(
      check
        .prepare("PRAGMA table_info(session_registry)")
        .all()
        .map((row) => String(row.name)),
    ).not.toContain("pending_node_guard");
    expect(
      check
        .prepare(
          `SELECT 1 FROM sqlite_schema
           WHERE type = 'table' AND name = 'node_write_guard'`,
        )
        .get(),
    ).toBeUndefined();
    check.close();
  });

  it("rejects a nonempty unversioned database without reinterpreting it", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-empty-"));
    roots.push(root);
    const path = join(root, "state.db");
    const forged = new DatabaseSync(path);
    forged.exec(`
      CREATE TABLE injected(value TEXT) STRICT;
      INSERT INTO injected(value) VALUES ('preserve me');
    `);
    forged.close();
    const before = await snapshotDirectory(root);

    await expect(
      createTestCurrentMetadataStore(path, dirname(path)),
    ).rejects.toThrow(
      /unversioned metadata database contains unexpected schema objects/u,
    );
    expect(await snapshotDirectory(root)).toEqual(before);

    const check = new DatabaseSync(path, { readOnly: true });
    expect(
      Number(
        (
          check.prepare("PRAGMA user_version").get() as {
            user_version: number;
          }
        ).user_version,
      ),
    ).toBe(0);
    expect(check.prepare("PRAGMA journal_mode").get()).toEqual({
      journal_mode: "delete",
    });
    expect(
      check
        .prepare(
          `SELECT name FROM sqlite_schema
           WHERE type = 'table' AND name NOT GLOB 'sqlite_*'
           ORDER BY name`,
        )
        .all()
        .map((row) => String(row.name)),
    ).toEqual(["injected"]);
    expect(check.prepare("SELECT value FROM injected").all()).toEqual([
      { value: "preserve me" },
    ]);
    check.close();
    expect((await readdir(root)).sort()).toEqual(["state.db"]);
  });

  it.each([
    [
      "trigger",
      `CREATE TRIGGER sabotage AFTER INSERT ON checkpoint_slot
       BEGIN DELETE FROM checkpoint_slot; END`,
    ],
    [
      "view",
      "CREATE VIEW leaked_checkpoint_slot AS SELECT * FROM checkpoint_slot",
    ],
    [
      "extra index",
      "CREATE INDEX unexpected_checkpoint_oid ON checkpoint_slot(tree_oid)",
    ],
  ])(
    "rejects an unexpected user %s in a current schema",
    async (_kind, sql) => {
      const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-object-"));
      roots.push(root);
      const path = join(root, "state.db");
      const initial = await createTestCurrentMetadataStore(path, dirname(path));
      initial.close();
      const db = new DatabaseSync(path);
      db.exec(sql);
      db.close();

      await expect(
        createTestCurrentMetadataStore(path, dirname(path)),
      ).rejects.toThrow(/does not match the metadata v4 layout/u);
    },
  );

  it.each([
    [
      "is missing",
      "DROP TRIGGER cyclotomy_writer_fence_checkpoint_slot_update",
    ],
    [
      "is replaced by a no-op",
      `DROP TRIGGER cyclotomy_writer_fence_checkpoint_slot_update;
       CREATE TRIGGER cyclotomy_writer_fence_checkpoint_slot_update
       BEFORE UPDATE ON checkpoint_slot BEGIN SELECT 1; END`,
    ],
    [
      "accepts the wrong protocol",
      `DROP TRIGGER cyclotomy_writer_fence_checkpoint_slot_update;
       CREATE TRIGGER cyclotomy_writer_fence_checkpoint_slot_update
       BEFORE UPDATE ON checkpoint_slot
       WHEN cyclotomy_writer_protocol() IS NOT 1
       BEGIN
         SELECT RAISE(ABORT, 'Cyclotomy metadata writer protocol mismatch');
       END`,
    ],
  ])("rejects a current writer fence that %s", async (_case, sql) => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-fence-"));
    roots.push(root);
    const path = join(root, "state.db");
    const initial = await createTestCurrentMetadataStore(path, dirname(path));
    initial.close();
    const db = new DatabaseSync(path);
    db.exec(sql);
    db.close();

    await expect(
      createTestCurrentMetadataStore(path, dirname(path)),
    ).rejects.toThrow(/does not match the metadata v4 layout/u);
  });

  it("refuses a newer schema before preparing migrations or mutating it", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-newer-"));
    roots.push(root);
    const path = join(root, "state.db");
    const db = new DatabaseSync(path);
    const newerVersion = CURRENT_METADATA_VERSION.version + 1;
    db.exec(`PRAGMA user_version = ${newerVersion}`);
    db.close();
    const before = await snapshotDirectory(root);
    let preparationCalls = 0;

    await expect(
      createTestCurrentMetadataStore(path, dirname(path)),
    ).rejects.toThrow(/newer than supported/u);
    await expect(
      Promise.resolve().then(() =>
        openCurrentMetadataStore(path, {
          prepareTreeOidUpgrades: async () => {
            preparationCalls += 1;
            return new Map();
          },
        }),
      ),
    ).rejects.toThrow(/newer than supported/u);
    expect(preparationCalls).toBe(0);
    expect(await snapshotDirectory(root)).toEqual(before);
  });
});
