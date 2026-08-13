import { existsSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  openCurrentMetadataStore,
  type CurrentMetadataStore,
} from "../../src/infrastructure/metadata.ts";
import { commitTestNodeState } from "../metadata-fixture.ts";

interface ChildMessage {
  readonly type: "ready" | "opening" | "opened" | "error";
  readonly pid: number;
  readonly blocked?: boolean;
  readonly name?: string;
  readonly message?: string;
}

function send(message: ChildMessage): Promise<void> {
  if (!process.connected || process.send === undefined) {
    return Promise.resolve();
  }
  return new Promise<void>((resolveSend, reject) => {
    process.send!(message, (error) => {
      if (error === null) {
        resolveSend();
      } else {
        reject(error);
      }
    });
  });
}

function waitForMessage(
  expected: "start" | "settle" | "finish",
): Promise<void> {
  return new Promise<void>((resolveStart) => {
    process.once("message", (message) => {
      if (message === expected) resolveStart();
    });
  });
}

const gateWaitCell = new Int32Array(new SharedArrayBuffer(4));

async function openAtSchemaGate(
  path: string,
  pausedPath: string,
  releasePath: string,
): Promise<CurrentMetadataStore> {
  const originalExec = DatabaseSync.prototype.exec;
  let paused = false;
  DatabaseSync.prototype.exec = function (sql: string): void {
    if (!paused && /^\s*BEGIN IMMEDIATE\s*;?\s*$/u.test(sql)) {
      paused = true;
      writeFileSync(pausedPath, "", { flag: "wx" });
      while (!existsSync(releasePath)) {
        Atomics.wait(gateWaitCell, 0, 0, 10);
      }
    }
    originalExec.call(this, sql);
  };
  try {
    return await openCurrentMetadataStore(path, {
      prepareTreeOidUpgrades: async (roots, _targetFormat) =>
        new Map(roots.map((treeOid) => [treeOid, treeOid])),
    });
  } finally {
    DatabaseSync.prototype.exec = originalExec;
  }
}

const path = process.argv[2];
if (path === undefined) {
  throw new Error("metadata path is required");
}
const iterations = Number(process.argv[3] ?? "1");
if (!Number.isSafeInteger(iterations) || iterations < 1) {
  throw new Error("metadata open iterations must be a positive integer");
}
const mode = process.argv[4] ?? "write";
const pausedPath = process.argv[5];
const releasePath = process.argv[6];
if (
  mode !== "write" &&
  mode !== "gated-write" &&
  mode !== "open-only" &&
  mode !== "legacy-live" &&
  mode !== "settle-sidecar"
) {
  throw new Error(`unsupported metadata child mode: ${mode}`);
}
if (
  mode === "gated-write" &&
  (pausedPath === undefined || releasePath === undefined)
) {
  throw new Error("gated metadata child requires pause and release paths");
}

try {
  if (mode === "legacy-live") {
    const legacy = new DatabaseSync(path);
    const staleUpdate = legacy.prepare(
      `UPDATE node_state SET tree_oid = ?
       WHERE session_id = 'legacy-process' AND entry_id = 'entry'`,
    );
    const started = waitForMessage("start");
    await send({ type: "ready", pid: process.pid });
    await started;
    await send({ type: "opening", pid: process.pid });
    try {
      staleUpdate.run("b".repeat(64));
      await send({ type: "opened", pid: process.pid, blocked: false });
    } catch (error) {
      await send({
        type: "opened",
        pid: process.pid,
        blocked: true,
        name: error instanceof Error ? error.name : "UnknownError",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      legacy.close();
    }
  } else if (mode === "settle-sidecar") {
    const started = waitForMessage("start");
    await send({ type: "ready", pid: process.pid });
    await started;
    const settled = waitForMessage("settle");
    await send({ type: "opening", pid: process.pid });
    await settled;
    Atomics.wait(gateWaitCell, 0, 0, 10);
    rmSync(`${path}-wal`, { force: true });
    const finished = waitForMessage("finish");
    await send({ type: "opened", pid: process.pid });
    await finished;
  } else {
    const started = waitForMessage("start");
    await send({ type: "ready", pid: process.pid });
    await started;
    await send({ type: "opening", pid: process.pid });
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const store = await (mode === "gated-write" && iteration === 0
        ? openAtSchemaGate(path, pausedPath!, releasePath!)
        : openCurrentMetadataStore(path, {
            prepareTreeOidUpgrades: async (roots, _targetFormat) =>
              new Map(roots.map((treeOid) => [treeOid, treeOid])),
          }));
      if (mode === "write" || mode === "gated-write") {
        commitTestNodeState(
          store,
          `concurrent-open-${process.pid}`,
          `${process.pid}-${iteration}`,
          "a".repeat(64),
        );
      }
      store.close();
    }
    await send({ type: "opened", pid: process.pid });
  }
} catch (error) {
  await send({
    type: "error",
    pid: process.pid,
    name: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
} finally {
  if (process.connected) process.disconnect();
}
