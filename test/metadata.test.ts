import { fork, type ChildProcess } from "node:child_process";
import { link, mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  MetadataError,
  MetadataStore,
} from "../src/infrastructure/metadata.ts";
import { commitTestNodeState } from "./metadata-fixture.ts";

const roots: string[] = [];
const metadataOpenFixture = fileURLToPath(
  new URL("./fixtures/metadata-open-child.ts", import.meta.url),
);

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
    }, 10_000);
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
  mode: "write" | "open-only" | "legacy-live" = "write",
): MetadataChild {
  const child = fork(metadataOpenFixture, [path, String(iterations), mode], {
    execArgv: ["--experimental-strip-types", "--no-warnings"],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
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

function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise<void>((resolveExit) =>
    child.once("exit", () => {
      resolveExit();
    }),
  );
}

async function createStore(): Promise<{
  root: string;
  path: string;
  store: MetadataStore;
}> {
  const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-"));
  roots.push(root);
  const path = join(root, "state.db");
  return { root, path, store: new MetadataStore(path) };
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

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("single-state metadata", () => {
  it("creates fresh stores directly at the current v2 schema", async () => {
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
      "node_state",
      "node_write_guard",
      "session_registry",
    ]);
    expect(
      Number(
        (db.prepare("PRAGMA user_version").get() as { user_version: number })
          .user_version,
      ),
    ).toBe(2);
    expect(
      db
        .prepare("PRAGMA table_info(session_registry)")
        .all()
        .map((row) => String(row.name)),
    ).toEqual([
      "session_id",
      "session_file",
      "missing_since",
      "missing_observed_at",
      "pending_node_guard",
    ]);
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

  it("atomically migrates the published v1 schema without losing data", async () => {
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

    const migrated = new MetadataStore(path);
    expect(migrated.getState("legacy", "entry")).toEqual({ treeOid });
    expect(migrated.listRegisteredSessions()).toEqual([
      {
        sessionId: "legacy",
        sessionFile: "/sessions/legacy.jsonl",
        missingSince: 100,
        missingObservedAt: 200,
        pendingNodeGuard: false,
      },
    ]);
    expect(migrated.isNodeWriteProtected("legacy", "entry")).toBe(false);
    migrated.close();

    const db = new DatabaseSync(path);
    expect(
      Number(
        (db.prepare("PRAGMA user_version").get() as { user_version: number })
          .user_version,
      ),
    ).toBe(2);
    expect(
      db
        .prepare("PRAGMA table_info(session_registry)")
        .all()
        .map((row) => String(row.name)),
    ).toEqual([
      "session_id",
      "session_file",
      "missing_since",
      "missing_observed_at",
      "pending_node_guard",
    ]);
    expect(
      Number(
        (
          db
            .prepare("SELECT count(*) AS count FROM node_write_guard")
            .get() as {
            count: number;
          }
        ).count,
      ),
    ).toBe(0);
    expect(() =>
      db
        .prepare(
          `UPDATE session_registry SET pending_node_guard = 2
           WHERE session_id = 'legacy'`,
        )
        .run(),
    ).toThrow();
    db.close();
  });

  it("can defer the published-v1 cutover until tree objects are preflighted", async () => {
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

    const deferred = new MetadataStore(path, {
      deferPublishedV1Migration: true,
    });
    expect(deferred.isSchemaCurrent()).toBe(false);
    expect(deferred.listReferencedTreeOids()).toEqual([treeOid]);
    deferred.close();

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
    untouched.close();

    const resumed = new MetadataStore(path, {
      deferPublishedV1Migration: true,
    });
    resumed.migrateSchemaToCurrent();
    expect(resumed.isSchemaCurrent()).toBe(true);
    expect(resumed.getState("legacy", "entry")).toEqual({ treeOid });
    resumed.close();
  });

  it("rolls back the SQL cutover when authenticated tree roots became stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-tree-cas-"));
    roots.push(root);
    const path = join(root, "state.db");
    const originalTreeOid = "a".repeat(64);
    const lateTreeOid = "b".repeat(64);
    const migratedTreeOid = "c".repeat(64);
    const legacy = openPublishedV1Metadata(path);
    legacy
      .prepare(
        `INSERT INTO node_state(session_id, entry_id, tree_oid)
         VALUES (?, ?, ?)`,
      )
      .run("legacy", "original", originalTreeOid);
    legacy.close();

    const deferred = new MetadataStore(path, {
      deferPublishedV1Migration: true,
    });
    const authenticatedRoots = deferred.listReferencedTreeOids();
    const interveningWriter = new DatabaseSync(path);
    interveningWriter
      .prepare(
        `INSERT INTO node_state(session_id, entry_id, tree_oid)
         VALUES (?, ?, ?)`,
      )
      .run("legacy", "late", lateTreeOid);
    interveningWriter.close();

    expect(() =>
      deferred.migrateSchemaAndReplaceTreeOidReferences(
        [{ oldTreeOid: originalTreeOid, newTreeOid: migratedTreeOid }],
        authenticatedRoots,
      ),
    ).toThrowError(
      new MetadataError(
        "tree references changed while object-format migration was preparing",
      ),
    );
    expect(deferred.isSchemaCurrent()).toBe(false);
    expect(deferred.listReferencedTreeOids()).toEqual([
      originalTreeOid,
      lateTreeOid,
    ]);
    expect(deferred.getState("legacy", "original")).toEqual({
      treeOid: originalTreeOid,
    });
    deferred.close();

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
          `SELECT 1 FROM sqlite_schema
           WHERE type = 'table' AND name = 'node_write_guard'`,
        )
        .get(),
    ).toBeUndefined();
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

    const current = new MetadataStore(path);
    expect(current.protectNodeWrite("legacy", "entry")).toBe("protected");

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
      expect(mutate).toThrow(/no such function: cyclotomy_writer_protocol/u);
    }

    expect(current.getState("legacy", "entry")).toEqual({
      treeOid: original,
    });
    expect(current.getState("legacy", "new-entry")).toBeUndefined();
    expect(current.isNodeWriteProtected("legacy", "entry")).toBe(true);
    expect(current.isNodeWriteProtected("legacy", "new-guard")).toBe(false);
    expect(current.listRegisteredSessions()).toEqual([
      {
        sessionId: "legacy",
        sessionFile: "/sessions/legacy.jsonl",
        missingSince: null,
        missingObservedAt: null,
        pendingNodeGuard: false,
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
    legacy.close();

    const child = startMetadataChild(path, 1, "legacy-live");
    try {
      await child.ready;
      const opened = waitForChildMessage(child.process, "opened", child.stderr);

      const current = new MetadataStore(path);
      expect(current.protectNodeWrite("legacy-process", "entry")).toBe(
        "protected",
      );
      child.process.send?.("start");
      const result = await opened;
      await waitForChildExit(child.process);

      expect(result.blocked).toBe(true);
      expect(result.message).toMatch(
        /no such function: cyclotomy_writer_protocol/u,
      );
      expect(current.getState("legacy-process", "entry")).toEqual({
        treeOid: original,
      });
      expect(current.isNodeWriteProtected("legacy-process", "entry")).toBe(
        true,
      );
      current.close();
    } finally {
      if (child.process.exitCode === null) child.process.kill("SIGKILL");
      await waitForChildExit(child.process);
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
      const children = Array.from({ length: 4 }, () =>
        startMetadataChild(path),
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
        // Keep the starting version visible while every process enters its open
        // path; they then queue on the same schema-migration writer lock.
        await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100));
        gate.exec("COMMIT;");
        gateOpen = false;

        const results = await Promise.all(opened);
        await Promise.all(
          children.map((child) => waitForChildExit(child.process)),
        );
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
        check.close();
        const store = new MetadataStore(path);
        for (const result of results) {
          expect(store.getState("concurrent-open", `${result.pid}-0`)).toEqual({
            treeOid: "a".repeat(64),
          });
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
        await Promise.all(
          children.map((child) => waitForChildExit(child.process)),
        );
      }
    },
  );

  it("tolerates concurrent SQLite WAL sidecar lifecycle churn", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-churn-"));
    roots.push(root);
    const path = join(root, "state.db");
    const initial = new MetadataStore(path);
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
      await Promise.all(
        children.map((child) => waitForChildExit(child.process)),
      );

      const store = new MetadataStore(path);
      expect(store.getState("concurrent-open", "unused")).toBeUndefined();
      store.close();
    } finally {
      for (const child of children) {
        if (child.process.exitCode === null) child.process.kill("SIGKILL");
      }
      await Promise.all(
        children.map((child) => waitForChildExit(child.process)),
      );
    }
  });

  it("keeps exactly one overwritable state per session node", async () => {
    const { store } = await createStore();
    const first = "a".repeat(64);
    const second = "b".repeat(64);
    commitTestNodeState(store, "s", "e", first);
    expect(store.getState("s", "e")).toEqual({ treeOid: first });
    commitTestNodeState(store, "s", "e", second);
    expect(store.getState("s", "e")).toEqual({ treeOid: second });
    expect(store.getState("other", "e")).toBeUndefined();
    expect(() => commitTestNodeState(store, "s", "bad", "not-an-oid")).toThrow(
      MetadataError,
    );
    store.close();
  });

  it("persists write protection and keeps repeated protection idempotent", async () => {
    const { path, store } = await createStore();
    const original = "a".repeat(64);
    commitTestNodeState(store, "s", "e", original);
    expect(store.protectNodeWrite("s", "e")).toBe("protected");
    store.close();

    const reopened = new MetadataStore(path);
    expect(reopened.isNodeWriteProtected("s", "e")).toBe(true);
    expect(
      reopened.protectNodeWrite("s", "e", {
        treeOid: "b".repeat(64),
        expectedTreeOid: original,
      }),
    ).toBe("protected");
    expect(reopened.getState("s", "e")).toEqual({ treeOid: original });
    reopened.close();
  });

  it("rejects both guarded inserts and guarded updates", async () => {
    const { store } = await createStore();
    const original = "a".repeat(64);
    const replacement = "b".repeat(64);
    store.protectNodeWrite("s", "missing");
    expect(
      store.commitNodeState("s", "missing", replacement, {
        treeOid: undefined,
      }),
    ).toBe("write-protected");
    expect(store.getState("s", "missing")).toBeUndefined();

    commitTestNodeState(store, "s", "existing", original);
    store.protectNodeWrite("s", "existing");
    expect(
      store.commitNodeState("s", "existing", replacement, {
        treeOid: original,
      }),
    ).toBe("write-protected");
    expect(store.getState("s", "existing")).toEqual({ treeOid: original });
    store.close();
  });

  it("pins an inherited checkpoint while installing protection", async () => {
    const { store } = await createStore();
    const inherited = "a".repeat(64);
    expect(
      store.protectNodeWrite("s", "child", {
        treeOid: inherited,
        expectedTreeOid: undefined,
      }),
    ).toBe("protected");
    expect(store.getState("s", "child")).toEqual({ treeOid: inherited });
    expect(store.isNodeWriteProtected("s", "child")).toBe(true);
    store.close();
  });

  it("keeps a concurrent exact state when a pin is stale, but still protects it", async () => {
    const { store } = await createStore();
    const inherited = "a".repeat(64);
    const concurrent = "b".repeat(64);
    commitTestNodeState(store, "s", "child", concurrent);
    expect(
      store.protectNodeWrite("s", "child", {
        treeOid: inherited,
        expectedTreeOid: undefined,
      }),
    ).toBe("state-changed");
    expect(store.getState("s", "child")).toEqual({ treeOid: concurrent });
    expect(store.isNodeWriteProtected("s", "child")).toBe(true);
    store.close();
  });

  it("clears protection only for the expected exact checkpoint", async () => {
    const { store } = await createStore();
    const expected = "a".repeat(64);
    commitTestNodeState(store, "s", "e", expected);
    store.protectNodeWrite("s", "e");
    expect(store.clearNodeWriteProtection("s", "e", "b".repeat(64))).toBe(
      "state-changed",
    );
    expect(store.isNodeWriteProtected("s", "e")).toBe(true);
    expect(store.clearNodeWriteProtection("s", "e", expected)).toBe("cleared");
    expect(store.isNodeWriteProtected("s", "e")).toBe(false);
    expect(store.clearNodeWriteProtection("s", "e", expected)).toBe(
      "unguarded",
    );
    store.close();
  });

  it("materializes a missing node only while the requested guard state holds", async () => {
    const { store } = await createStore();
    const fresh = "a".repeat(64);
    const adopted = "b".repeat(64);

    expect(
      store.materializeMissingNodeState(
        "s",
        "fresh",
        fresh,
        "initialize-fresh",
      ),
    ).toBe("committed");
    expect(store.getState("s", "fresh")).toEqual({ treeOid: fresh });

    store.protectNodeWrite("s", "guarded");
    expect(
      store.materializeMissingNodeState(
        "s",
        "guarded",
        adopted,
        "initialize-fresh",
      ),
    ).toBe("state-changed");
    expect(store.getState("s", "guarded")).toBeUndefined();
    expect(store.isNodeWriteProtected("s", "guarded")).toBe(true);
    expect(
      store.materializeMissingNodeState(
        "s",
        "guarded",
        adopted,
        "adopt-protected",
      ),
    ).toBe("committed");
    expect(store.getState("s", "guarded")).toEqual({ treeOid: adopted });
    expect(store.isNodeWriteProtected("s", "guarded")).toBe(false);

    expect(
      store.materializeMissingNodeState(
        "s",
        "unguarded-adoption",
        adopted,
        "adopt-protected",
      ),
    ).toBe("state-changed");
    expect(store.getState("s", "unguarded-adoption")).toBeUndefined();
    store.close();
  });

  it("copies only a fork's actual ancestry and never overwrites it", async () => {
    const { store } = await createStore();
    const root = "a".repeat(64);
    const selected = "b".repeat(64);
    const sibling = "c".repeat(64);
    const destinationWins = "d".repeat(64);
    store.touchSession("source", "/sessions/source.jsonl");
    store.touchSession("fork", "/sessions/fork.jsonl");
    commitTestNodeState(store, "source", "root", root);
    commitTestNodeState(store, "source", "selected", selected);
    commitTestNodeState(store, "source", "sibling", sibling);
    commitTestNodeState(store, "fork", "selected", destinationWins);

    const copied = store.copyForkAncestry({
      targetSessionId: "fork",
      parentSessionFile: "/sessions/source.jsonl",
      ancestryEntryIds: ["root", "selected"],
    });
    expect(copied).toEqual({ sourceSessionId: "source", copiedStates: 1 });
    expect(store.getState("fork", "root")).toEqual({ treeOid: root });
    expect(store.getState("fork", "selected")?.treeOid).toBe(destinationWins);
    expect(store.getState("fork", "sibling")).toBeUndefined();
    expect(
      store.copyForkAncestry({
        targetSessionId: "fork",
        parentSessionFile: "/sessions/source.jsonl",
        ancestryEntryIds: ["root", "selected"],
      }).copiedStates,
    ).toBe(0);
    expect(
      store.copyForkAncestry({
        targetSessionId: "fork",
        parentSessionFile: "/sessions/source.jsonl",
        ancestryEntryIds: [],
      }),
    ).toEqual({ sourceSessionId: "source", copiedStates: 0 });
    store.close();
  });

  it("copies a pinned fork checkpoint without copying its write guard", async () => {
    const { store } = await createStore();
    const pinned = "a".repeat(64);
    store.touchSession("source", "/sessions/source.jsonl");
    store.protectNodeWrite("source", "child", {
      treeOid: pinned,
      expectedTreeOid: undefined,
    });

    expect(
      store.copyForkAncestry({
        targetSessionId: "fork",
        parentSessionFile: "/sessions/source.jsonl",
        ancestryEntryIds: ["child"],
      }),
    ).toEqual({ sourceSessionId: "source", copiedStates: 1 });
    expect(store.getState("fork", "child")).toEqual({ treeOid: pinned });
    expect(store.isNodeWriteProtected("source", "child")).toBe(true);
    expect(store.isNodeWriteProtected("fork", "child")).toBe(false);
    store.close();
  });

  it("copies guarded Missing ancestry without overriding target truth", async () => {
    const { store } = await createStore();
    const sourceFile = "/sessions/source.jsonl";
    const pinned = "a".repeat(64);
    const targetOwned = "b".repeat(64);
    store.touchSession("source", sourceFile);
    store.touchSession("fork", "/sessions/fork.jsonl");
    store.protectNodeWrite("source", "selected-missing");
    store.protectNodeWrite("source", "unselected-missing");
    store.protectNodeWrite("source", "pinned", {
      treeOid: pinned,
      expectedTreeOid: undefined,
    });
    store.protectNodeWrite("source", "target-owned");
    commitTestNodeState(store, "fork", "target-owned", targetOwned);

    const input = {
      targetSessionId: "fork",
      parentSessionFile: sourceFile,
      ancestryEntryIds: ["selected-missing", "pinned", "target-owned"],
    } as const;
    expect(store.copyForkAncestry(input)).toEqual({
      sourceSessionId: "source",
      copiedStates: 1,
    });
    expect(store.getState("fork", "selected-missing")).toBeUndefined();
    expect(store.isNodeWriteProtected("fork", "selected-missing")).toBe(true);
    expect(store.getState("fork", "pinned")).toEqual({ treeOid: pinned });
    expect(store.isNodeWriteProtected("fork", "pinned")).toBe(false);
    expect(store.getState("fork", "target-owned")).toEqual({
      treeOid: targetOwned,
    });
    expect(store.isNodeWriteProtected("fork", "target-owned")).toBe(false);
    expect(store.isNodeWriteProtected("fork", "unselected-missing")).toBe(
      false,
    );
    expect(store.copyForkAncestry(input).copiedStates).toBe(0);
    expect(store.isNodeWriteProtected("fork", "selected-missing")).toBe(true);
    store.close();
  });

  it("rolls back fork states when guarded-Missing copying fails", async () => {
    const { path, store } = await createStore();
    const sourceFile = "/sessions/source.jsonl";
    store.touchSession("source", sourceFile);
    store.touchSession("fork", "/sessions/fork.jsonl");
    commitTestNodeState(store, "source", "state", "a".repeat(64));
    store.protectNodeWrite("source", "missing");
    const sabotage = new DatabaseSync(path);
    sabotage.exec(`
      CREATE TRIGGER fail_fork_guard
      BEFORE INSERT ON node_write_guard
      WHEN NEW.session_id = 'fork'
      BEGIN
        SELECT RAISE(ABORT, 'fork guard sabotage');
      END;
    `);

    try {
      expect(() =>
        store.copyForkAncestry({
          targetSessionId: "fork",
          parentSessionFile: sourceFile,
          ancestryEntryIds: ["state", "missing"],
        }),
      ).toThrow(/fork guard sabotage/u);
      expect(store.getState("fork", "state")).toBeUndefined();
      expect(store.isNodeWriteProtected("fork", "missing")).toBe(false);
    } finally {
      sabotage.exec("DROP TRIGGER fail_fork_guard");
      sabotage.close();
      store.close();
    }
  });

  it("does not import fork ancestry while its first-node guard is pending", async () => {
    const { store } = await createStore();
    const parentState = "a".repeat(64);
    store.touchSession("source", "/sessions/source.jsonl");
    store.touchSession("fork", "/sessions/fork.jsonl");
    commitTestNodeState(store, "source", "retained", parentState);
    store.setPendingNodeGuard("fork", "/sessions/fork.jsonl");

    expect(
      store.copyForkAncestry({
        targetSessionId: "fork",
        parentSessionFile: "/sessions/source.jsonl",
        ancestryEntryIds: ["retained"],
      }),
    ).toEqual({ sourceSessionId: "source", copiedStates: 0 });
    expect(store.getState("fork", "retained")).toBeUndefined();
    expect(store.pendingNodeGuard("fork", "/sessions/fork.jsonl")).toBe(true);
    store.close();
  });

  it("atomically propagates a pending parent to a registered cold fork", async () => {
    const { store } = await createStore();
    const parentState = "a".repeat(64);
    const sourceFile = "/sessions/source.jsonl";
    const forkFile = "/sessions/fork.jsonl";
    store.touchSession("source", sourceFile);
    store.touchSession("fork", forkFile);
    commitTestNodeState(store, "source", "retained", parentState);
    expect(store.setPendingNodeGuard("source", sourceFile)).toBe(true);

    const emptyInput = {
      targetSessionId: "fork",
      parentSessionFile: sourceFile,
      ancestryEntryIds: [],
    } as const;
    expect(store.copyForkAncestry(emptyInput)).toEqual({
      sourceSessionId: "source",
      copiedStates: 0,
    });
    expect(store.pendingNodeGuard("fork", forkFile)).toBe(true);
    expect(store.getState("fork", "retained")).toBeUndefined();

    // Replaying startup import is idempotent: it neither clears the inherited
    // intent nor slips parent state underneath it.
    expect(
      store.copyForkAncestry({
        ...emptyInput,
        ancestryEntryIds: ["retained"],
      }),
    ).toEqual({
      sourceSessionId: "source",
      copiedStates: 0,
    });
    expect(store.pendingNodeGuard("fork", forkFile)).toBe(true);
    expect(store.getState("fork", "retained")).toBeUndefined();
    store.close();
  });

  it("does not create orphan fork metadata for a pending parent", async () => {
    const { store } = await createStore();
    const sourceFile = "/sessions/source.jsonl";
    store.touchSession("source", sourceFile);
    commitTestNodeState(store, "source", "retained", "a".repeat(64));
    expect(store.setPendingNodeGuard("source", sourceFile)).toBe(true);

    expect(
      store.copyForkAncestry({
        targetSessionId: "unregistered-fork",
        parentSessionFile: sourceFile,
        ancestryEntryIds: ["retained"],
      }),
    ).toEqual({ sourceSessionId: "source", copiedStates: 0 });
    expect(store.getState("unregistered-fork", "retained")).toBeUndefined();
    expect(store.listRegisteredSessions()).toHaveLength(1);
    store.close();
  });

  it("does not assign later parent state to a guarded missing fork node", async () => {
    const { store } = await createStore();
    const laterParentState = "a".repeat(64);
    store.touchSession("source", "/sessions/source.jsonl");
    store.protectNodeWrite("fork", "child");
    commitTestNodeState(store, "source", "child", laterParentState);

    expect(
      store.copyForkAncestry({
        targetSessionId: "fork",
        parentSessionFile: "/sessions/source.jsonl",
        ancestryEntryIds: ["child"],
      }),
    ).toEqual({ sourceSessionId: "source", copiedStates: 0 });
    expect(store.getState("fork", "child")).toBeUndefined();
    expect(store.isNodeWriteProtected("fork", "child")).toBe(true);
    store.close();
  });

  it("does not guess when a fork parent was never registered", async () => {
    const { store } = await createStore();
    expect(
      store.copyForkAncestry({
        targetSessionId: "fork",
        parentSessionFile: "/missing.jsonl",
        ancestryEntryIds: ["root"],
      }),
    ).toEqual({ sourceSessionId: undefined, copiedStates: 0 });
    expect(store.getState("fork", "root")).toBeUndefined();
    store.close();
  });

  it("enforces unique ownership of a persisted session file", async () => {
    const { store } = await createStore();
    store.touchSession("s1", "/sessions/shared.jsonl");
    expect(() => store.touchSession("s2", "/sessions/shared.jsonl")).toThrow();
    expect(store.listRegisteredSessions()).toHaveLength(1);
    store.close();
  });

  it("never remaps one session id to a different persisted file", async () => {
    const { store } = await createStore();
    store.touchSession("same", "/sessions/original.jsonl");
    expect(() =>
      store.touchSession("same", "/sessions/duplicate.jsonl"),
    ).toThrow(MetadataError);
    expect(store.listRegisteredSessions()).toEqual([
      expect.objectContaining({
        sessionId: "same",
        sessionFile: "/sessions/original.jsonl",
      }),
    ]);
    store.close();
  });

  it("moves a pending session guard onto the first observed ancestry atomically", async () => {
    const { path, store } = await createStore();
    const sessionFile = "/sessions/s.jsonl";
    store.touchSession("s", sessionFile);
    expect(store.pendingNodeGuard("s", sessionFile)).toBe(false);
    expect(store.setPendingNodeGuard("s", sessionFile)).toBe(true);
    // Registration refreshes liveness but must not discard safety intent.
    expect(store.touchSession("s", sessionFile).pendingNodeGuard).toBe(true);

    const second = new MetadataStore(path);
    expect(
      second.consumePendingNodeGuard("s", sessionFile, [
        "first-child",
        "second-child",
      ]),
    ).toBe("protected");
    expect(store.pendingNodeGuard("s", sessionFile)).toBe(false);
    expect(store.isNodeWriteProtected("s", "first-child")).toBe(true);
    expect(store.isNodeWriteProtected("s", "second-child")).toBe(true);
    expect(
      store.materializeMissingNodeState(
        "s",
        "first-child",
        "a".repeat(64),
        "initialize-fresh",
      ),
    ).toBe("state-changed");
    expect(
      store.consumePendingNodeGuard("s", sessionFile, ["later-child"]),
    ).toBe("not-pending");
    expect(store.isNodeWriteProtected("s", "later-child")).toBe(false);

    // Commit CAS operations provide the same transaction boundary if another
    // SQLite connection sets the flag after an earlier runtime observation.
    expect(second.setPendingNodeGuard("s", sessionFile)).toBe(true);
    expect(store.commitNodeState("s", "capture-race", "b".repeat(64))).toBe(
      "write-protected",
    );
    expect(store.getState("s", "capture-race")).toBeUndefined();
    expect(store.isNodeWriteProtected("s", "capture-race")).toBe(true);
    expect(second.setPendingNodeGuard("s", sessionFile)).toBe(true);
    expect(
      store.materializeMissingNodeState(
        "s",
        "materialize-race",
        "c".repeat(64),
        "initialize-fresh",
      ),
    ).toBe("state-changed");
    expect(store.getState("s", "materialize-race")).toBeUndefined();
    expect(store.isNodeWriteProtected("s", "materialize-race")).toBe(true);
    expect(store.pendingNodeGuard("s", sessionFile)).toBe(false);
    second.close();
    store.close();
  });

  it("authenticates pending guard updates against the exact registered file", async () => {
    const { store } = await createStore();
    const sessionFile = "/sessions/s.jsonl";
    store.touchSession("s", sessionFile);

    expect(store.setPendingNodeGuard("s", "/sessions/other.jsonl")).toBe(false);
    expect(
      store.consumePendingNodeGuard("s", "/sessions/other.jsonl", ["child"]),
    ).toBe("session-unregistered");
    expect(
      store.pendingNodeGuard("s", "/sessions/other.jsonl"),
    ).toBeUndefined();
    expect(store.clearPendingNodeGuard("s", "/sessions/other.jsonl")).toBe(
      false,
    );
    expect(store.setPendingNodeGuard("s", sessionFile)).toBe(true);
    expect(store.clearPendingNodeGuard("s", sessionFile)).toBe(true);
    expect(store.pendingNodeGuard("s", sessionFile)).toBe(false);
    store.close();
  });

  it("prunes only after two missing observations beyond retention", async () => {
    const { store } = await createStore();
    store.touchSession("s", "/sessions/s.jsonl");
    commitTestNodeState(store, "s", "e", "a".repeat(64));
    store.protectNodeWrite("s", "guarded");
    expect(store.observeSessionMissing("s", "/sessions/s.jsonl", 100)).toBe(
      true,
    );
    expect(
      store.pruneMissingSession({
        expectedSessionId: "s",
        expectedSessionFile: "/sessions/s.jsonl",
        expectedMissingSince: 100,
        expectedMissingObservedAt: 100,
        now: 1_000,
        retentionMs: 500,
      }),
    ).toMatchObject({ removedSessions: 0, removedNodeStates: 0 });
    expect(store.observeSessionMissing("s", "/sessions/s.jsonl", 1_000)).toBe(
      true,
    );
    expect(
      store.pruneMissingSession({
        expectedSessionId: "s",
        expectedSessionFile: "/sessions/s.jsonl",
        expectedMissingSince: 100,
        expectedMissingObservedAt: 1_000,
        now: 1_000,
        retentionMs: 500,
      }),
    ).toEqual({
      removedSessions: 1,
      removedNodeStates: 1,
      removedNodeWriteGuards: 1,
      removedMetadataRows: 3,
    });
    expect(store.isNodeWriteProtected("s", "guarded")).toBe(false);
    expect(store.listReferencedTreeOids()).toEqual([]);
    store.close();
  });

  it("CAS-prunes only the exact retained missing registry row", async () => {
    const { store } = await createStore();
    const sessionFile = "/sessions/resumed.jsonl";
    store.touchSession("s", sessionFile);
    commitTestNodeState(store, "s", "e", "a".repeat(64));
    store.observeSessionMissing("s", sessionFile, 100);
    store.observeSessionMissing("s", sessionFile, 200);

    const expected = {
      expectedSessionId: "s",
      expectedSessionFile: sessionFile,
      expectedMissingSince: 100,
      expectedMissingObservedAt: 200,
      now: 1_000,
      retentionMs: 500,
    };
    for (const stale of [
      { ...expected, expectedSessionId: "another" },
      { ...expected, expectedSessionFile: "/sessions/another.jsonl" },
      { ...expected, expectedMissingSince: 101 },
      { ...expected, expectedMissingObservedAt: 201 },
    ]) {
      expect(store.pruneMissingSession(stale)).toEqual({
        removedSessions: 0,
        removedNodeStates: 0,
        removedNodeWriteGuards: 0,
        removedMetadataRows: 0,
      });
    }

    store.observeSessionPresent("s", sessionFile);
    expect(store.pruneMissingSession(expected)).toEqual({
      removedSessions: 0,
      removedNodeStates: 0,
      removedNodeWriteGuards: 0,
      removedMetadataRows: 0,
    });
    expect(store.getState("s", "e")?.treeOid).toBe("a".repeat(64));
    expect(store.listRegisteredSessions()).toEqual([
      expect.objectContaining({
        sessionId: "s",
        sessionFile,
        missingSince: null,
        missingObservedAt: null,
      }),
    ]);
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

    expect(() => new MetadataStore(path)).toThrow(/single-link regular file/u);
    await expect(stat(outside)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a hard-linked metadata database", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-hardlink-"));
    roots.push(root);
    const outside = join(root, "outside.db");
    const seeded = new DatabaseSync(outside);
    seeded.close();
    const path = join(root, "state.db");
    await link(outside, path);

    expect(() => new MetadataStore(path)).toThrow(/single-link regular file/u);
  });

  it.each(["wal", "shm"])(
    "refuses a stable symlink at the metadata -%s sidecar",
    async (sidecar) => {
      const { root, path, store } = await createStore();
      store.close();
      const outside = join(root, `outside-${sidecar}`);
      await symlink(outside, `${path}-${sidecar}`);

      expect(() => new MetadataStore(path)).toThrow(
        /single-link regular file/u,
      );
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

    expect(() => new MetadataStore(path)).toThrow(/single-link regular file/u);
  });

  it("refuses a stable non-file metadata sidecar", async () => {
    const { path, store } = await createStore();
    store.close();
    await mkdir(`${path}-shm`);

    expect(() => new MetadataStore(path)).toThrow(/single-link regular file/u);
  });

  it("rejects a claimed current version whose physical schema is incomplete", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-shape-"));
    roots.push(root);
    const path = join(root, "state.db");
    const db = new DatabaseSync(path);
    db.exec("PRAGMA user_version = 2");
    db.close();

    expect(() => new MetadataStore(path)).toThrow(
      /does not match the current layout/u,
    );
  });

  it("rejects a non-public claimed v1 before making migration changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-fake-v1-"));
    roots.push(root);
    const path = join(root, "state.db");
    const forged = openPublishedV1Metadata(path);
    forged.exec("ALTER TABLE node_state ADD COLUMN forged TEXT");
    forged.close();

    expect(() => new MetadataStore(path)).toThrow(
      /does not match the published layout/u,
    );

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

    expect(() => new MetadataStore(path)).toThrow(
      /does not match the published layout/u,
    );
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

  it("rolls back fresh initialization when current-v2 validation fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-v0-"));
    roots.push(root);
    const path = join(root, "state.db");
    const forged = new DatabaseSync(path);
    forged.exec("CREATE TABLE injected(value TEXT) STRICT");
    forged.close();

    expect(() => new MetadataStore(path)).toThrow(
      /does not match the current layout/u,
    );

    const check = new DatabaseSync(path);
    expect(
      Number(
        (
          check.prepare("PRAGMA user_version").get() as {
            user_version: number;
          }
        ).user_version,
      ),
    ).toBe(0);
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
    check.close();
  });

  it.each([
    [
      "trigger",
      `CREATE TRIGGER sabotage AFTER INSERT ON node_state
       BEGIN DELETE FROM node_state; END`,
    ],
    ["view", "CREATE VIEW leaked_node_state AS SELECT * FROM node_state"],
    [
      "extra index",
      "CREATE INDEX unexpected_node_state_oid ON node_state(tree_oid)",
    ],
  ])(
    "rejects an unexpected user %s in a current schema",
    async (_kind, sql) => {
      const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-object-"));
      roots.push(root);
      const path = join(root, "state.db");
      const initial = new MetadataStore(path);
      initial.close();
      const db = new DatabaseSync(path);
      db.exec(sql);
      db.close();

      expect(() => new MetadataStore(path)).toThrow(
        /does not match the current layout/u,
      );
    },
  );

  it.each([
    ["is missing", "DROP TRIGGER cyclotomy_writer_fence_node_state_update"],
    [
      "is replaced by a no-op",
      `DROP TRIGGER cyclotomy_writer_fence_node_state_update;
       CREATE TRIGGER cyclotomy_writer_fence_node_state_update
       BEFORE UPDATE ON node_state BEGIN SELECT 1; END`,
    ],
    [
      "accepts the wrong protocol",
      `DROP TRIGGER cyclotomy_writer_fence_node_state_update;
       CREATE TRIGGER cyclotomy_writer_fence_node_state_update
       BEFORE UPDATE ON node_state
       WHEN cyclotomy_writer_protocol() IS NOT 1
       BEGIN
         SELECT RAISE(ABORT, 'Cyclotomy metadata writer protocol mismatch');
       END`,
    ],
  ])("rejects a current writer fence that %s", async (_case, sql) => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-fence-"));
    roots.push(root);
    const path = join(root, "state.db");
    const initial = new MetadataStore(path);
    initial.close();
    const db = new DatabaseSync(path);
    db.exec(sql);
    db.close();

    expect(() => new MetadataStore(path)).toThrow(
      /does not match the current layout/u,
    );
  });

  it("refuses a newer schema without mutating it", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-newer-"));
    roots.push(root);
    const path = join(root, "state.db");
    const db = new DatabaseSync(path);
    db.exec("PRAGMA user_version = 3");
    db.close();
    expect(() => new MetadataStore(path)).toThrow(/newer than supported/u);
    const check = new DatabaseSync(path);
    expect(
      Number(
        (
          check.prepare("PRAGMA user_version").get() as {
            user_version: number;
          }
        ).user_version,
      ),
    ).toBe(3);
    check.close();
  });
});
