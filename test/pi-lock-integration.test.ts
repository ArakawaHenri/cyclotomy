import * as garbageCollection from "../src/infrastructure/object-gc.ts";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { contentIdFromBytes } from "../src/infrastructure/content-store/ids.ts";
import * as nativeBinding from "../src/infrastructure/native-file-lock.ts";
import { openObjectStore } from "../src/infrastructure/object-store.ts";
import { RealPiHarness } from "./real-pi.ts";

let harness: RealPiHarness | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await harness?.dispose();
  harness = undefined;
});

async function capturedWorkspace(gcIntervalMs = 0): Promise<RealPiHarness> {
  const pi = new RealPiHarness();
  harness = pi;
  await pi.start({
    settings: { locale: "en", gc: { intervalMs: gcIntervalMs } },
  });
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

function historyState(pi: RealPiHarness): string {
  const db = new DatabaseSync(join(pi.storeRoot, "state.db"), {
    readOnly: true,
  });
  try {
    return JSON.stringify({
      slots: db
        .prepare(
          "SELECT entry_id, tree_oid, capture_state FROM checkpoint_slot WHERE session_id = ? ORDER BY entry_id",
        )
        .all(pi.sessionId),
      history: db
        .prepare(
          "SELECT history_epoch, reset_pending FROM session_history WHERE session_id = ?",
        )
        .get(pi.sessionId),
    });
  } finally {
    db.close();
  }
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
    const binding = await nativeBinding.loadNativeFileLock();
    const contended = Promise.withResolvers<void>();
    const spy = vi
      .spyOn(nativeBinding, "loadNativeFileLock")
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
    const before = historyState(pi);
    await pi.writeWorkspaceFile("a.txt", "updated");

    await withExternalLock(
      pi.storeRoot,
      () => pi.turn("capture updated content"),
      () => expect(historyState(pi)).toBe(before),
    );

    expect(historyState(pi)).not.toBe(before);
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
    const before = historyState(pi);
    const file = join(pi.workspace, "a.txt");
    await pi.writeWorkspaceFile("a.txt", "changed");
    pi.selectIndex = 1;

    await withExternalLock(
      pi.storeRoot,
      () => pi.command("/restore"),
      async () => {
        expect(await readFile(file, "utf8")).toBe("changed");
        expect(historyState(pi)).toBe(before);
      },
    );

    expect(await readFile(file, "utf8")).toBe("saved");
    expect(checkpointTree(pi)).toBe(target);
    expect(pi.extensionErrors).toEqual([]);
  });

  it.each(["local", "pause", "external"] as const)(
    "yields automatic GC to a %s foreground operation, then finishes cleanup",
    async (foreground) => {
      const entered = Promise.withResolvers<void>();
      const collect = garbageCollection.collectGarbage;
      vi.spyOn(garbageCollection, "collectGarbage").mockImplementationOnce(
        async (authority, store, metadata, options) => {
          const signal = options?.signal;
          if (signal === undefined)
            throw new Error("automatic GC has no cancellation signal");
          entered.resolve();
          if (!signal.aborted) await once(signal, "abort");
          return collect(authority, store, metadata, options);
        },
      );
      const pi = await capturedWorkspace(1);
      const target = checkpointTree(pi);
      const incoming = join(pi.storeRoot, "objects", "packs", "incoming");
      await mkdir(incoming, { recursive: true });
      const garbage = join(
        incoming,
        `.${"a".repeat(64)}.${process.pid}.123e4567-e89b-42d3-a456-426614174000.pack.tmp`,
      );
      await writeFile(garbage, Buffer.alloc(4096));
      await utimes(garbage, new Date(0), new Date(0));
      await entered.promise;
      if (foreground === "local") {
        await pi.writeWorkspaceFile("a.txt", "foreground content");
        await pi.turn("capture while cleanup is running");
        const objects = await openObjectStore(pi.storeRoot);
        const tree = await objects.readTree(checkpointTree(pi));
        expect(
          tree.entries.find((entry) => entry.path === "a.txt"),
        ).toMatchObject({
          blobOid: contentIdFromBytes(Buffer.from("foreground content")),
        });
      } else if (foreground === "pause") {
        await pi.command("/cyclotomy pause");
        expect((await stat(garbage)).size).toBe(4096);
        await pi.command("/cyclotomy resume");
      } else {
        const child = fork(
          new URL("./fixtures/workspace-lock-child.ts", import.meta.url),
          [pi.storeRoot, "foreground", "hold", "10000"],
          {
            execArgv: ["--experimental-strip-types", "--no-warnings"],
            stdio: ["ignore", "ignore", "inherit", "ipc"],
          },
        );
        const exited = once(child, "exit");
        try {
          const [message] = await once(child, "message", {
            signal: AbortSignal.timeout(15000),
          });
          expect(message).toMatchObject({ type: "acquired" });
          expect((await stat(garbage)).size).toBe(4096);
        } finally {
          if (child.connected) child.disconnect();
          await exited;
        }
      }
      await vi.waitFor(
        async () => {
          await expect(stat(garbage)).rejects.toMatchObject({ code: "ENOENT" });
        },
        { timeout: 10000 },
      );
      const objects = await openObjectStore(pi.storeRoot);
      await expect(objects.readTree(target)).resolves.toBeDefined();
      expect(pi.extensionErrors).toEqual([]);
      expect(
        pi.notifications.some(({ message }) =>
          message.includes("cleanup failed"),
        ),
      ).toBe(false);
    },
  );
});
