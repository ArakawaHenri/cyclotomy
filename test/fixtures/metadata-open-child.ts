import { DatabaseSync } from "node:sqlite";

import { MetadataStore } from "../../src/infrastructure/metadata.ts";
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

function waitForStart(): Promise<void> {
  return new Promise<void>((resolveStart) => {
    process.once("message", (message) => {
      if (message === "start") resolveStart();
    });
  });
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
if (mode !== "write" && mode !== "open-only" && mode !== "legacy-live") {
  throw new Error(`unsupported metadata child mode: ${mode}`);
}

try {
  if (mode === "legacy-live") {
    const legacy = new DatabaseSync(path);
    const staleUpdate = legacy.prepare(
      `UPDATE node_state SET tree_oid = ?
       WHERE session_id = 'legacy-process' AND entry_id = 'entry'`,
    );
    await send({ type: "ready", pid: process.pid });
    await waitForStart();
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
  } else {
    await send({ type: "ready", pid: process.pid });
    await waitForStart();
    await send({ type: "opening", pid: process.pid });
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const store = new MetadataStore(path);
      if (mode === "write") {
        commitTestNodeState(
          store,
          "concurrent-open",
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
