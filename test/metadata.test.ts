import { fork, type ChildProcess } from "node:child_process";
import {
  link,
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  MetadataError,
  MetadataStore,
} from "../src/infrastructure/metadata.ts";

const roots: string[] = [];
const metadataOpenFixture = fileURLToPath(
  new URL("./fixtures/metadata-open-child.ts", import.meta.url),
);

interface MetadataChildMessage {
  readonly type: "ready" | "opening" | "opened" | "error";
  readonly pid: number;
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
  writeState = true,
): MetadataChild {
  const child = fork(metadataOpenFixture, [
    path,
    String(iterations),
    writeState ? "write" : "open-only",
  ], {
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
  return new Promise<void>((resolveExit) => child.once("exit", () => {
    resolveExit();
  }));
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

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("single-state metadata", () => {
  it("creates only node state and session registry tables", async () => {
    const { path, store } = await createStore();
    store.close();
    const db = new DatabaseSync(path);
    const tables = db.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    ).all().map((row) => String(row.name));
    expect(tables).toEqual(["node_state", "session_registry"]);
    expect(Number(
      (db.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
    )).toBe(1);
    db.close();
  });

  it("serializes concurrent first-open migrations from the locked version", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-race-"));
    roots.push(root);
    const path = join(root, "state.db");
    const gate = new DatabaseSync(path);
    gate.exec("PRAGMA journal_mode=WAL;");
    gate.exec("BEGIN IMMEDIATE;");
    let gateOpen = true;
    const children = Array.from({ length: 4 }, () =>
      startMetadataChild(path)
    );

    try {
      await Promise.all(children.map((child) => child.ready));
      const opening = children.map((child) =>
        waitForChildMessage(child.process, "opening", child.stderr)
      );
      const opened = children.map((child) =>
        waitForChildMessage(child.process, "opened", child.stderr)
      );
      for (const child of children) child.process.send?.("start");
      await Promise.all(opening);
      // Keep version 0 visible while every process enters its open path;
      // they then queue on the same migration writer lock.
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100));
      gate.exec("COMMIT;");
      gateOpen = false;

      const results = await Promise.all(opened);
      await Promise.all(
        children.map((child) => waitForChildExit(child.process)),
      );
      const store = new MetadataStore(path);
      for (const result of results) {
        expect(
          store.getState("concurrent-open", `${result.pid}-0`),
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
      await Promise.all(
        children.map((child) => waitForChildExit(child.process)),
      );
    }
  });

  it("tolerates concurrent SQLite WAL sidecar lifecycle churn", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-churn-"));
    roots.push(root);
    const path = join(root, "state.db");
    const initial = new MetadataStore(path);
    initial.close();

    const iterations = 20;
    const children = Array.from({ length: 4 }, () =>
      startMetadataChild(path, iterations, false)
    );
    try {
      await Promise.all(children.map((child) => child.ready));
      const opening = children.map((child) =>
        waitForChildMessage(child.process, "opening", child.stderr)
      );
      const opened = children.map((child) =>
        waitForChildMessage(child.process, "opened", child.stderr)
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
    store.setState("s", "e", first);
    expect(store.getState("s", "e")).toEqual({ treeOid: first });
    store.setState("s", "e", second);
    expect(store.getState("s", "e")).toEqual({ treeOid: second });
    expect(store.getState("other", "e")).toBeUndefined();
    expect(() => store.setState("s", "bad", "not-an-oid"))
      .toThrow(MetadataError);
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
    store.setState("source", "root", root);
    store.setState("source", "selected", selected);
    store.setState("source", "sibling", sibling);
    store.setState("fork", "selected", destinationWins);

    const copied = store.copyForkAncestry({
      targetSessionId: "fork",
      parentSessionFile: "/sessions/source.jsonl",
      ancestryEntryIds: ["root", "selected"],
    });
    expect(copied).toEqual({ sourceSessionId: "source", copiedStates: 1 });
    expect(store.getState("fork", "root")).toEqual({ treeOid: root });
    expect(store.getState("fork", "selected")?.treeOid).toBe(destinationWins);
    expect(store.getState("fork", "sibling")).toBeUndefined();
    expect(store.copyForkAncestry({
      targetSessionId: "fork",
      parentSessionFile: "/sessions/source.jsonl",
      ancestryEntryIds: ["root", "selected"],
    }).copiedStates).toBe(0);
    store.close();
  });

  it("does not guess when a fork parent was never registered", async () => {
    const { store } = await createStore();
    expect(store.copyForkAncestry({
      targetSessionId: "fork",
      parentSessionFile: "/missing.jsonl",
      ancestryEntryIds: ["root"],
    })).toEqual({ sourceSessionId: undefined, copiedStates: 0 });
    expect(store.getState("fork", "root")).toBeUndefined();
    store.close();
  });

  it("enforces unique ownership of a persisted session file", async () => {
    const { store } = await createStore();
    store.touchSession("s1", "/sessions/shared.jsonl");
    expect(() => store.touchSession("s2", "/sessions/shared.jsonl"))
      .toThrow();
    expect(store.listRegisteredSessions()).toHaveLength(1);
    store.close();
  });

  it("never remaps one session id to a different persisted file", async () => {
    const { store } = await createStore();
    store.touchSession("same", "/sessions/original.jsonl");
    expect(() =>
      store.touchSession("same", "/sessions/duplicate.jsonl")
    ).toThrow(MetadataError);
    expect(store.listRegisteredSessions()).toEqual([
      expect.objectContaining({
        sessionId: "same",
        sessionFile: "/sessions/original.jsonl",
      }),
    ]);
    store.close();
  });

  it("prunes only after two missing observations beyond retention", async () => {
    const { store } = await createStore();
    store.touchSession("s", "/sessions/s.jsonl");
    store.setState("s", "e", "a".repeat(64));
    expect(store.observeSessionMissing("s", "/sessions/s.jsonl", 100)).toBe(
      true,
    );
    expect(store.pruneMissingSession({
      expectedSessionId: "s",
      expectedSessionFile: "/sessions/s.jsonl",
      expectedMissingSince: 100,
      expectedMissingObservedAt: 100,
      now: 1_000,
      retentionMs: 500,
    }))
      .toMatchObject({ removedSessions: 0, removedNodeStates: 0 });
    expect(store.observeSessionMissing("s", "/sessions/s.jsonl", 1_000)).toBe(
      true,
    );
    expect(store.pruneMissingSession({
      expectedSessionId: "s",
      expectedSessionFile: "/sessions/s.jsonl",
      expectedMissingSince: 100,
      expectedMissingObservedAt: 1_000,
      now: 1_000,
      retentionMs: 500,
    }))
      .toEqual({
        removedSessions: 1,
        removedNodeStates: 1,
        removedMetadataRows: 2,
      });
    expect(store.listReferencedTreeOids()).toEqual([]);
    store.close();
  });

  it("CAS-prunes only the exact retained missing registry row", async () => {
    const { store } = await createStore();
    const sessionFile = "/sessions/resumed.jsonl";
    store.touchSession("s", sessionFile);
    store.setState("s", "e", "a".repeat(64));
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
        removedMetadataRows: 0,
      });
    }

    store.observeSessionPresent("s", sessionFile);
    expect(store.pruneMissingSession(expected)).toEqual({
      removedSessions: 0,
      removedNodeStates: 0,
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
    store.setState("s1", "e1", "a".repeat(64));
    store.setState("s2", "e2", "a".repeat(64));
    store.setState("s2", "e3", "b".repeat(64));
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
    db.exec("PRAGMA user_version = 1");
    db.close();

    expect(() => new MetadataStore(path)).toThrow(/unexpected tables/u);
  });

  it.each([
    [
      "trigger",
      `CREATE TRIGGER sabotage AFTER INSERT ON node_state
       BEGIN DELETE FROM node_state; END`,
    ],
    [
      "view",
      "CREATE VIEW leaked_node_state AS SELECT * FROM node_state",
    ],
    [
      "extra index",
      "CREATE INDEX unexpected_node_state_oid ON node_state(tree_oid)",
    ],
  ])("rejects an unexpected user %s in a current schema", async (_kind, sql) => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-object-"));
    roots.push(root);
    const path = join(root, "state.db");
    const initial = new MetadataStore(path);
    initial.close();
    const db = new DatabaseSync(path);
    db.exec(sql);
    db.close();

    expect(() => new MetadataStore(path)).toThrow(/unexpected schema objects/u);
  });

  it("refuses a newer schema without mutating it", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-metadata-newer-"));
    roots.push(root);
    const path = join(root, "state.db");
    const db = new DatabaseSync(path);
    db.exec("PRAGMA user_version = 2");
    db.close();
    expect(() => new MetadataStore(path)).toThrow(/newer than supported/u);
    const check = new DatabaseSync(path);
    expect(
      Number((check.prepare("PRAGMA user_version").get() as {
        user_version: number;
      }).user_version),
    ).toBe(2);
    check.close();
  });
});
