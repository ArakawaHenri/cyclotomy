import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Worker } from "node:worker_threads";

const [root, version] = process.argv.slice(2);
const { loadNativeFileLock } = await import(
  pathToFileURL(join(root, "src/infrastructure/native-file-lock.ts"))
);
const { acquireWorkspaceLock } = await import(
  pathToFileURL(join(root, "src/infrastructure/workspace-lock.ts"))
);
const binding = await loadNativeFileLock();
const files = new Map();
const locks = new Map();
const workers = new Map();
function open(path) {
  if (version === "current") return binding.open(path);
  const fd = openSync(path, "r+");
  return {
    tryLock: (shared = false) =>
      shared ? binding.tryAcquireShared(fd) : binding.tryAcquire(fd),
    close: () => closeSync(fd),
  };
}
async function execute(c) {
  switch (c.op) {
    case "open":
      files.set(c.id, open(c.path));
      return true;
    case "try":
      return files.get(c.id).tryLock(c.shared ?? false);
    case "close":
      files.get(c.id).close();
      files.delete(c.id);
      return true;
    case "acquire":
      locks.set(
        c.id,
        await acquireWorkspaceLock(c.path, "interop", {
          timeoutMs: c.timeout ?? 0,
        }),
      );
      return true;
    case "release":
      await locks.get(c.id).release();
      locks.delete(c.id);
      return true;
    case "cancel": {
      const controller = new AbortController();
      const pending = acquireWorkspaceLock(c.path, "cancel", {
        signal: controller.signal,
      });
      const timer = setTimeout(() => controller.abort(), 50);
      try {
        await assert.rejects(pending, { name: "AbortError" });
      } finally {
        clearTimeout(timer);
      }
      return true;
    }
    case "stress": {
      for (let i = 0; i < c.count; i++) {
        const lock = await acquireWorkspaceLock(c.path, "stress", {
          timeoutMs: 20000,
        });
        try {
          const n = Number(readFileSync(c.counter, "utf8"));
          await delay(1);
          writeFileSync(c.counter, String(n + 1));
        } finally {
          await lock.release();
        }
        await delay(1);
      }
      return true;
    }
    case "lifecycle": {
      const bindingPath = join(
        root,
        "native/build/Release/file-lock-tracked.node",
      );
      const tracked = createRequire(import.meta.url)(bindingPath);
      assert.equal(tracked.outstanding(), 0);
      for (const close of [true, false]) {
        for (let i = 0; i < 3; i++) {
          const worker = new Worker(
            new URL(
              "../test/fixtures/native-lock-lifecycle-worker.mjs",
              import.meta.url,
            ),
            { workerData: { bindingPath, path: c.path, close } },
          );
          try {
            const outstanding = await new Promise((resolve, reject) => {
              worker.once("message", resolve);
              worker.once("error", reject);
            });
            if (close)
              assert.equal(
                outstanding,
                0,
                "explicit close must reclaim native allocations",
              );
          } finally {
            await worker.terminate();
          }
          const deadline = performance.now() + 5000;
          while (tracked.outstanding() !== 0 && performance.now() < deadline)
            await delay(5);
          assert.equal(
            tracked.outstanding(),
            0,
            "worker exit must reclaim native allocations",
          );
        }
      }
      return true;
    }
    case "worker": {
      const worker = new Worker(
        new URL("../test/fixtures/native-lock-worker.mjs", import.meta.url),
        { workerData: { root, path: c.path } },
      );
      workers.set(c.id, worker);
      return await new Promise((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
      });
    }
    case "terminate":
      await workers.get(c.id).terminate();
      workers.delete(c.id);
      return true;
    default:
      throw new Error(`Unknown command: ${c.op}`);
  }
}
console.log(JSON.stringify({ ready: true }));
try {
  for await (const line of createInterface({ input: process.stdin })) {
    try {
      console.log(
        JSON.stringify({ ok: true, value: await execute(JSON.parse(line)) }),
      );
    } catch (error) {
      console.log(
        JSON.stringify({ ok: false, name: error.name, message: error.message }),
      );
    }
  }
} finally {
  for (const lock of locks.values()) await lock.release();
  for (const file of files.values()) file.close();
  for (const worker of workers.values()) await worker.terminate();
}
