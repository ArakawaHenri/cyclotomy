import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CatalogPackHandle,
  PackCatalog,
} from "../src/infrastructure/content-store/pack-catalog.ts";
import {
  PackHandlePool,
  PackHandlePoolClosedError,
} from "../src/infrastructure/content-store/pack-handle-pool.ts";
import { contentIdFromBytes } from "../src/infrastructure/content-store/ids.ts";
import {
  encodePack,
  type PackId,
} from "../src/infrastructure/content-store/pack.ts";
import { nativeObjectLayout } from "../src/infrastructure/workspace-store.ts";
import { withWorkspaceLock } from "../src/infrastructure/workspace-lock.ts";

const roots: string[] = [];

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function setup(): Promise<{
  readonly catalog: PackCatalog;
  readonly packIds: readonly PackId[];
}> {
  const root = await mkdtemp(join(tmpdir(), "cyclotomy-pack-pool-"));
  roots.push(root);
  const layout = nativeObjectLayout(root);
  await mkdir(layout.incomingPacks, { recursive: true, mode: 0o700 });
  const catalog = new PackCatalog(layout);
  const packIds: PackId[] = [];
  await withWorkspaceLock(
    layout.root,
    "pack handle pool fixture",
    async (authority) => {
      for (const text of ["first", "second", "third"]) {
        const bytes = Buffer.from(`pack handle pool ${text}`, "utf8");
        const encoded = await encodePack({
          packClass: "data",
          records: [
            {
              kind: "content",
              encoding: "raw",
              logicalId: contentIdFromBytes(bytes),
              decodedLength: bytes.byteLength,
              payload: bytes,
            },
          ],
        });
        await catalog.publishPack(encoded, authority);
        packIds.push(encoded.pack.packId);
      }
    },
  );
  return { catalog, packIds };
}

async function flushReservations(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("pack handle pool", () => {
  it("single-flights concurrent acquisition of one deferred pack", async () => {
    const { catalog, packIds } = await setup();
    const gate = deferred();
    const originalOpen = catalog.openPack.bind(catalog);
    const opened = vi
      .spyOn(catalog, "openPack")
      .mockImplementation(async (packId) => {
        await gate.promise;
        return await originalOpen(packId);
      });
    const pool = new PackHandlePool(catalog, 2);

    const firstPending = pool.acquire(packIds[0]!);
    const secondPending = pool.acquire(packIds[0]!);
    await flushReservations();
    expect(opened).toHaveBeenCalledTimes(1);

    gate.resolve();
    const [first, second] = await Promise.all([firstPending, secondPending]);
    expect(first.kind).toBe("acquired");
    expect(second.kind).toBe("acquired");
    if (first.kind !== "acquired" || second.kind !== "acquired") return;
    expect(first.lease.handle).toBe(second.lease.handle);
    await first.lease.release();
    await second.lease.release();
    await pool.close();
  });

  it("waits at the two-handle bound and closes the LRU before replacement", async () => {
    const { catalog, packIds } = await setup();
    const events: string[] = [];
    const originalOpen = catalog.openPack.bind(catalog);
    vi.spyOn(catalog, "openPack").mockImplementation(async (packId) => {
      events.push(`open:${packId}`);
      return await originalOpen(packId);
    });
    const originalClose = CatalogPackHandle.prototype.close;
    vi.spyOn(CatalogPackHandle.prototype, "close").mockImplementation(function (
      this: CatalogPackHandle,
    ) {
      events.push(`close:${this.packId}`);
      return originalClose.call(this);
    });
    const pool = new PackHandlePool(catalog, 2);
    const first = await pool.acquire(packIds[0]!);
    const second = await pool.acquire(packIds[1]!);
    if (first.kind !== "acquired" || second.kind !== "acquired") return;

    const thirdPending = pool.acquire(packIds[2]!);
    await flushReservations();
    expect(events).not.toContain(`open:${packIds[2]}`);
    await first.lease.release();
    const third = await thirdPending;
    expect(third.kind).toBe("acquired");
    expect(events.indexOf(`close:${packIds[0]}`)).toBeLessThan(
      events.indexOf(`open:${packIds[2]}`),
    );
    await second.lease.release();
    if (third.kind === "acquired") await third.lease.release();
    await pool.close();
  });

  it("counts an invalidated active handle against the hard capacity", async () => {
    const { catalog, packIds } = await setup();
    const events: string[] = [];
    const live = new Set<CatalogPackHandle>();
    const closeStarted = deferred();
    const allowClose = deferred();
    let maximumLive = 0;
    let deferredHandle: CatalogPackHandle | undefined;
    const originalOpen = catalog.openPack.bind(catalog);
    const opened = vi
      .spyOn(catalog, "openPack")
      .mockImplementation(async (packId) => {
        const handle = await originalOpen(packId);
        events.push(`open:${packId}`);
        if (handle !== undefined) {
          live.add(handle);
          maximumLive = Math.max(maximumLive, live.size);
        }
        return handle;
      });
    const originalClose = CatalogPackHandle.prototype.close;
    vi.spyOn(CatalogPackHandle.prototype, "close").mockImplementation(
      async function (this: CatalogPackHandle): Promise<void> {
        if (this === deferredHandle) {
          events.push(`close-start:${this.packId}`);
          closeStarted.resolve();
          await allowClose.promise;
        }
        await originalClose.call(this);
        live.delete(this);
        events.push(`close:${this.packId}`);
      },
    );
    const pool = new PackHandlePool(catalog, 2);
    const first = await pool.acquire(packIds[0]!);
    const second = await pool.acquire(packIds[1]!);
    if (first.kind !== "acquired" || second.kind !== "acquired") return;

    deferredHandle = second.lease.handle;
    await second.lease.release();
    await pool.invalidate(packIds[0]!);
    const secondRetirement = pool.invalidate(packIds[1]!);
    await closeStarted.promise;
    const thirdPending = pool.acquire(packIds[2]!);
    await flushReservations();
    expect(opened.mock.calls.map(([packId]) => packId)).toEqual([
      packIds[0],
      packIds[1],
    ]);

    allowClose.resolve();
    await secondRetirement;
    await flushReservations();
    expect(opened.mock.calls.map(([packId]) => packId)).toEqual(packIds);
    const third = await thirdPending;

    expect(third.kind).toBe("acquired");
    expect(maximumLive).toBe(2);
    expect(events.indexOf(`close:${packIds[1]}`)).toBeLessThan(
      events.indexOf(`open:${packIds[2]}`),
    );
    await first.lease.release();
    if (third.kind === "acquired") await third.lease.release();
    await pool.close();
    expect(live.size).toBe(0);
  });

  it("closes a retired owner once and rejects its reserve waiter on close", async () => {
    const { catalog, packIds } = await setup();
    const opened = vi.spyOn(catalog, "openPack");
    const closed = vi.spyOn(CatalogPackHandle.prototype, "close");
    const pool = new PackHandlePool(catalog, 2);
    const owner = await pool.acquire(packIds[0]!);
    if (owner.kind !== "acquired") return;

    await Promise.all([
      pool.invalidate(packIds[0]!),
      pool.invalidate(packIds[0]!),
    ]);
    const waiterPending = pool.acquire(packIds[0]!);
    await flushReservations();
    expect(opened).toHaveBeenCalledTimes(1);
    const waiterRejection = expect(waiterPending).rejects.toBeInstanceOf(
      PackHandlePoolClosedError,
    );
    const closePending = pool.close();

    await owner.lease.release();
    await Promise.all([waiterRejection, closePending]);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("releases capacity after reporting a retirement failure", async () => {
    const { catalog, packIds } = await setup();
    const opened = vi.spyOn(catalog, "openPack");
    const pool = new PackHandlePool(catalog, 1);
    const first = await pool.acquire(packIds[0]!);
    if (first.kind !== "acquired") return;
    const firstHandle = first.lease.handle;
    await first.lease.release();

    const failure = new Error("injected pack close failure");
    const originalClose = CatalogPackHandle.prototype.close;
    const closed = vi
      .spyOn(CatalogPackHandle.prototype, "close")
      .mockImplementation(function (this: CatalogPackHandle): Promise<void> {
        return this === firstHandle
          ? Promise.reject(failure)
          : originalClose.call(this);
      });

    await expect(pool.invalidate(packIds[0]!)).rejects.toBe(failure);
    const second = await pool.acquire(packIds[1]!);
    expect(second.kind).toBe("acquired");
    if (second.kind === "acquired") await second.lease.release();
    await pool.close();
    expect(opened.mock.calls.map(([packId]) => packId)).toEqual([
      packIds[0],
      packIds[1],
    ]);
    expect(closed).toHaveBeenCalledTimes(2);

    await originalClose.call(firstHandle);
  });

  it("rejects a permit waiter after close and drains a deferred owner", async () => {
    const { catalog, packIds } = await setup();
    const gate = deferred();
    const originalOpen = catalog.openPack.bind(catalog);
    const opened = vi
      .spyOn(catalog, "openPack")
      .mockImplementation(async (packId) => {
        await gate.promise;
        return await originalOpen(packId);
      });
    const closed = vi.spyOn(CatalogPackHandle.prototype, "close");
    const pool = new PackHandlePool(catalog, 1);
    const ownerPending = pool.acquire(packIds[0]!);
    await flushReservations();
    const waiterPending = pool.acquire(packIds[1]!);
    const waiterRejection = expect(waiterPending).rejects.toBeInstanceOf(
      PackHandlePoolClosedError,
    );
    const closePending = pool.close();

    await waiterRejection;
    gate.resolve();
    const owner = await ownerPending;
    if (owner.kind === "acquired") await owner.lease.release();
    await closePending;
    expect(opened.mock.calls.map(([packId]) => packId)).toEqual([packIds[0]]);
    expect(closed).toHaveBeenCalledTimes(1);
  });
});
