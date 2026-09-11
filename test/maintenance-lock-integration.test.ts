import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli/main.ts";
import { contentIdFromBytes } from "../src/infrastructure/content-store/ids.ts";
import { readMetadataReadonly } from "../src/infrastructure/metadata-readonly.ts";
import * as nativeBinding from "../src/infrastructure/native-file-lock.ts";
import { openObjectStore } from "../src/infrastructure/object-store.ts";
import { RealPiHarness } from "./real-pi.ts";

let harness: RealPiHarness | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await harness?.dispose();
  harness = undefined;
});

async function capturedWorkspace(): Promise<RealPiHarness> {
  const pi = new RealPiHarness();
  harness = pi;
  await pi.start();
  await pi.writeWorkspaceFile("a.txt", "saved");
  await pi.turn("capture saved content");
  expect(checkpointTree(pi)).toBeTypeOf("string");
  return pi;
}

function checkpointTree(pi: RealPiHarness): string {
  const db = new DatabaseSync(join(pi.storeRoot, "state.db"), {
    readOnly: true,
  });
  try {
    const row = db
      .prepare(
        "SELECT tree_oid FROM checkpoint_slot WHERE session_id = ? AND entry_id = ?",
      )
      .get(pi.sessionId, pi.leafId);
    expect(row?.tree_oid).toBeTypeOf("string");
    return row!.tree_oid as string;
  } finally {
    db.close();
  }
}

function historyFingerprint(pi: RealPiHarness): string {
  const result = readMetadataReadonly(
    join(pi.storeRoot, "state.db"),
    (queries) => queries.sessionFingerprint(pi.sessionId),
  );
  expect(result.status.kind).toBe("ready");
  expect(result.data).toBeTypeOf("string");
  return result.data!;
}

async function withExternalLock<T>(
  root: string,
  action: () => Promise<T>,
  whileHeld: () => Promise<void> | void,
): Promise<T> {
  const holder = fork(
    new URL("./fixtures/workspace-lock-child.ts", import.meta.url),
    [root, "external-holder", "hold", "5000"],
    {
      execArgv: ["--experimental-strip-types", "--no-warnings"],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    },
  );
  const exited = once(holder, "exit");
  const watchdog = setTimeout(() => holder.kill(), 15_000);
  let pending: Promise<T> | undefined;
  let restoreBinding: (() => void) | undefined;
  try {
    const [message] = await once(holder, "message", {
      signal: AbortSignal.timeout(10_000),
    });
    expect(message).toMatchObject({ type: "acquired" });
    const binding = await nativeBinding.loadExclusiveFileLock();
    const contended = Promise.withResolvers<void>();
    const spy = vi
      .spyOn(nativeBinding, "loadExclusiveFileLock")
      .mockResolvedValue({
        ...binding,
        tryAcquire(fd) {
          const acquired = binding.tryAcquire(fd);
          if (!acquired) contended.resolve();
          return acquired;
        },
      });
    restoreBinding = () => spy.mockRestore();
    pending = action();
    await Promise.race([
      contended.promise,
      pending.then(() => {
        throw new Error("business operation completed without contending");
      }),
    ]);
    await whileHeld();
  } finally {
    if (holder.connected) holder.disconnect();
    await exited;
    clearTimeout(watchdog);
    restoreBinding?.();
    await pending?.catch(() => undefined);
  }
  return await pending!;
}

describe("business writes under cross-process workspace contention", () => {
  it("commits a real Pi capture only after the external holder releases", async () => {
    const pi = await capturedWorkspace();
    const before = historyFingerprint(pi);
    await pi.writeWorkspaceFile("a.txt", "updated");

    await withExternalLock(
      pi.storeRoot,
      () => pi.turn("capture updated content"),
      () => expect(historyFingerprint(pi)).toBe(before),
    );

    expect(historyFingerprint(pi)).not.toBe(before);
    const objects = await openObjectStore(pi.storeRoot);
    const tree = await objects.readTree(checkpointTree(pi));
    expect(tree.entries.find((entry) => entry.path === "a.txt")).toMatchObject({
      blobOid: contentIdFromBytes(Buffer.from("updated")),
    });
    expect(pi.extensionErrors).toEqual([]);
  });

  it("applies a real Pi restore only after the external holder releases", async () => {
    const pi = await capturedWorkspace();
    const target = checkpointTree(pi);
    const before = historyFingerprint(pi);
    const file = join(pi.workspace, "a.txt");
    await pi.writeWorkspaceFile("a.txt", "changed");
    pi.selectIndex = 1;

    await withExternalLock(
      pi.storeRoot,
      () => pi.command("/restore"),
      async () => {
        expect(await readFile(file, "utf8")).toBe("changed");
        expect(historyFingerprint(pi)).toBe(before);
      },
    );

    expect(await readFile(file, "utf8")).toBe("saved");
    expect(checkpointTree(pi)).toBe(target);
    expect(pi.extensionErrors).toEqual([]);
  });

  it("deletes garbage through the CLI only after the external holder releases", async () => {
    const pi = await capturedWorkspace();
    const target = checkpointTree(pi);
    const before = historyFingerprint(pi);
    const incoming = join(pi.storeRoot, "objects", "packs", "incoming");
    await mkdir(incoming, { recursive: true });
    const garbage = join(
      incoming,
      `.${"a".repeat(64)}.${process.pid}.123e4567-e89b-42d3-a456-426614174000.pack.tmp`,
    );
    await writeFile(garbage, Buffer.alloc(4096));
    await utimes(garbage, new Date(0), new Date(0));
    const out: string[] = [];
    const err: string[] = [];

    const code = await withExternalLock(
      pi.storeRoot,
      () =>
        runCli(
          ["--workspace", pi.workspace, "gc", "--json"],
          { out: (text) => out.push(text), err: (text) => err.push(text) },
          { env: { PI_CODING_AGENT_DIR: pi.agentDir }, cwd: pi.workspace },
        ),
      async () => {
        expect((await stat(garbage)).size).toBe(4096);
        expect(historyFingerprint(pi)).toBe(before);
      },
    );

    expect(code, out.join("") || err.join("")).toBe(0);
    const result = JSON.parse(out.join("")).result;
    expect(result.removedTmpFiles).toBeGreaterThanOrEqual(1);
    expect(BigInt(result.freedBytes)).toBeGreaterThanOrEqual(4096n);
    await expect(stat(garbage)).rejects.toMatchObject({ code: "ENOENT" });
    const objects = await openObjectStore(pi.storeRoot);
    await expect(objects.readTree(target)).resolves.toBeDefined();
  });
});
