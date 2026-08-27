import { createHash } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  compactionFitsAdditiveCapacity,
  collectGarbage as collectGarbageWithLease,
  crossGenerationRewriteIsWorthwhile,
  GarbageCollectionMarkError,
  GarbageCollectionNamespaceError,
  GarbageCollectionRootDriftError,
  selectCompactionKeysWithinDecodedBudget,
  tieredRewriteIsConvergent,
} from "../src/infrastructure/object-gc.ts";
import { createContentRecord } from "../src/infrastructure/content-store/representation.ts";
import { encodeRecord } from "../src/infrastructure/content-store/record.ts";
import { parseMetadataId } from "../src/infrastructure/content-store/ids.ts";
import { encodePack } from "../src/infrastructure/content-store/pack.ts";
import { decodeDelta1Program } from "../src/infrastructure/content-store/pack-delta.ts";
import {
  CatalogPackHandle,
  PackCatalog,
} from "../src/infrastructure/content-store/pack-catalog.ts";
import { PackHandlePool } from "../src/infrastructure/content-store/pack-handle-pool.ts";
import { ObjectStoreMaintenance } from "../src/infrastructure/content-store/maintenance.ts";
import { ContentRepository } from "../src/infrastructure/content-store/repository.ts";
import {
  nativeObjectStoreLayout,
  openObjectStore,
} from "../src/infrastructure/object-store.ts";
import {
  runWithWorkspaceLock,
  withWorkspaceLock,
  WorkspaceLockOwnershipLostError,
} from "../src/infrastructure/workspace-lock.ts";
import { nativeObjectLayout } from "../src/infrastructure/workspace-store.ts";
import {
  commitTestNodeState,
  createTestCurrentMetadataStore,
  registerTestSession,
  withTestMetadataWriteAuthority,
} from "./metadata-fixture.ts";
import { publishTestBlob, publishTestTree } from "./object-store-fixture.ts";
import { ALL_MANAGED_SCOPE } from "./workspace-scope-fixture.ts";

const roots: string[] = [];
const scope = ALL_MANAGED_SCOPE;
const publishedV1FixtureRoot = fileURLToPath(
  new URL("./fixtures/cyclotomy-0.0.1-tree/", import.meta.url),
);
const incompatibleV1TreeOid =
  "a3c2394720cce94c55e5b9d40fdd9a9ced03d42611e0069a61982936f502310d";
const incompatibleV1BlobOid =
  "4e8ee7bb37a569f50dcbca3d59db6b6303d2d63a30d691580b5ae856fe059831";

async function collectGarbage(
  store: Parameters<typeof collectGarbageWithLease>[1],
  metadata: Parameters<typeof collectGarbageWithLease>[2],
  options?: Parameters<typeof collectGarbageWithLease>[3],
): ReturnType<typeof collectGarbageWithLease> {
  const root = nativeObjectStoreLayout(store, "garbage-collection test").root;
  return withWorkspaceLock(root, "garbage-collection test", (authority) =>
    collectGarbageWithLease(authority, store, metadata, options),
  );
}

describe("compaction additive capacity", () => {
  const base = {
    newRecords: 2,
    newPacks: 1,
    largestIncomingBytes: 64,
    currentObjects: 8,
    currentIndexEntries: 8,
    currentPacks: 2,
    currentIncomingFiles: 0,
    currentIncomingBytes: 0,
    maxObjects: 10,
    maxIndexEntries: 10,
    maxPacks: 3,
    maxIncomingFiles: 1,
    maxIncomingBytes: 64,
  } as const;

  it("requires simultaneous object, index, pack, and incoming headroom", () => {
    expect(compactionFitsAdditiveCapacity(base)).toBe(true);
    expect(
      compactionFitsAdditiveCapacity({ ...base, currentIndexEntries: 9 }),
    ).toBe(false);
    expect(compactionFitsAdditiveCapacity({ ...base, currentPacks: 3 })).toBe(
      false,
    );
    expect(
      compactionFitsAdditiveCapacity({ ...base, currentIncomingFiles: 1 }),
    ).toBe(false);
    expect(
      compactionFitsAdditiveCapacity({ ...base, currentIncomingBytes: 1 }),
    ).toBe(false);
  });

  it("admits a deterministic whole-record prefix within the decoded budget", () => {
    const candidates = [
      { key: "d", decodedLength: 11 },
      { key: "b", decodedLength: 6 },
      { key: "a", decodedLength: 5 },
      { key: "c", decodedLength: undefined },
    ] as const;

    expect([
      ...selectCompactionKeysWithinDecodedBudget(candidates, 10),
    ]).toEqual(["a"]);
    expect([
      ...selectCompactionKeysWithinDecodedBudget([...candidates].reverse(), 11),
    ]).toEqual(["a", "b"]);
  });

  it("bounds a delta-only historical rewrite by projected byte savings", () => {
    expect(
      crossGenerationRewriteIsWorthwhile({
        selectedTargetBytes: 10_000,
        sourcePackBytes: 14_000,
      }),
    ).toBe(true);
    expect(
      crossGenerationRewriteIsWorthwhile({
        selectedTargetBytes: 10_000,
        sourcePackBytes: 14_001,
      }),
    ).toBe(false);
    expect(
      crossGenerationRewriteIsWorthwhile({
        selectedTargetBytes: 128,
        sourcePackBytes: 1,
      }),
    ).toBe(false);
    expect(
      crossGenerationRewriteIsWorthwhile({
        selectedTargetBytes: 100_000,
        sourcePackBytes: 140_000,
      }),
    ).toBe(true);
    expect(
      crossGenerationRewriteIsWorthwhile({
        selectedTargetBytes: 100_000,
        sourcePackBytes: 140_001,
      }),
    ).toBe(false);
  });

  it("admits only class-local tier rewrites that reduce pack count and bytes", () => {
    const baseline = {
      data: { packs: 1, bytes: 1_000 },
      metadata: { packs: 2, bytes: 2_000 },
    } as const;
    expect(
      tieredRewriteIsConvergent({
        baseline,
        candidate: {
          data: { packs: 4, bytes: 5_000 },
          metadata: baseline.metadata,
        },
        packClass: "data",
        sourcePacks: 4,
        sourceBytes: 4_000,
      }),
    ).toBe(true);
    expect(
      tieredRewriteIsConvergent({
        baseline,
        candidate: {
          data: { packs: 5, bytes: 5_000 },
          metadata: baseline.metadata,
        },
        packClass: "data",
        sourcePacks: 4,
        sourceBytes: 4_000,
      }),
    ).toBe(false);
    expect(
      tieredRewriteIsConvergent({
        baseline,
        candidate: {
          data: { packs: 4, bytes: 5_001 },
          metadata: baseline.metadata,
        },
        packClass: "data",
        sourcePacks: 4,
        sourceBytes: 4_000,
      }),
    ).toBe(false);
    expect(
      tieredRewriteIsConvergent({
        baseline,
        candidate: {
          data: { packs: 4, bytes: 5_000 },
          metadata: { packs: 2, bytes: 1_999 },
        },
        packClass: "data",
        sourcePacks: 4,
        sourceBytes: 4_000,
      }),
    ).toBe(false);
  });
});

function objectPath(
  root: string,
  kind: "blobs" | "trees",
  oid: string,
): string {
  return join(root, "objects", kind, oid.slice(0, 2), oid.slice(2));
}

function contentRecordPath(root: string, oid: string): string {
  return join(
    root,
    "objects",
    "records",
    "content",
    oid.slice(0, 2),
    oid.slice(2),
  );
}

async function packPaths(root: string): Promise<readonly string[]> {
  const packs = join(root, "objects", "packs");
  const result: string[] = [];
  for (const name of await readdir(packs)) {
    if (!/^[0-9a-f]{2}$/u.test(name)) continue;
    for (const file of await readdir(join(packs, name))) {
      if (file.endsWith(".pack")) result.push(join(packs, name, file));
    }
  }
  return result.sort();
}

async function publishDataPack(
  root: string,
  contents: readonly Uint8Array[],
): Promise<{
  readonly catalog: PackCatalog;
  readonly packId: string;
  readonly contentIds: readonly string[];
}> {
  const layout = nativeObjectLayout(root);
  const catalog = new PackCatalog(layout);
  const records = await Promise.all(contents.map(createContentRecord));
  const published = await withWorkspaceLock(
    layout.root,
    "object GC pack fixture",
    async (authority) => {
      const publication = await catalog.publishPack(
        await encodePack({ packClass: "data", records }),
        authority,
      );
      const inventory = await catalog.inventory();
      await catalog.publishMultiPackIndexCache(
        catalog.rebuildMultiPackIndex(inventory),
        inventory,
        authority,
      );
      return publication;
    },
  );
  return {
    catalog,
    packId: published.view.packId,
    contentIds: records.map(({ logicalId }) => logicalId),
  };
}

async function publishLooseFullRecord(
  root: string,
  content: Uint8Array,
): Promise<string> {
  const record = await createContentRecord(content);
  const path = contentRecordPath(root, record.logicalId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, encodeRecord(record));
  return record.logicalId;
}

afterEach(async () => {
  vi.restoreAllMocks();
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("object garbage collection", () => {
  it("refuses no-delete MIDX publication after its authority is displaced", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-gc-midx-lease-"));
    roots.push(root);
    const store = await openObjectStore(root);
    const layout = nativeObjectLayout(root);
    const displacedLock = join(root, "displaced-workspace.lock");
    const incomingBefore = await readdir(layout.incomingPacks);
    const publishMultiPackIndexCache =
      PackCatalog.prototype.publishMultiPackIndexCache;
    vi.spyOn(
      PackCatalog.prototype,
      "publishMultiPackIndexCache",
    ).mockImplementationOnce(async function (
      this: PackCatalog,
      built,
      inventory,
      authority,
    ) {
      renameSync(join(root, "workspace.lock"), displacedLock);
      await publishMultiPackIndexCache.call(this, built, inventory, authority);
    });

    const execution = await runWithWorkspaceLock(
      root,
      "garbage-collection MIDX lease-fence test",
      (authority) =>
        collectGarbageWithLease(authority, store, {
          listReferencedTreeOids: () => [],
        }),
    );

    expect(execution).toMatchObject({
      kind: "action-failed",
      cause: expect.any(WorkspaceLockOwnershipLostError),
      cleanup: { kind: "failed" },
    });
    expect(await readdir(layout.incomingPacks)).toEqual(incomingBefore);
    await expect(readFile(layout.multiPackIndex)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await rm(displacedLock, { recursive: true, force: true });
  });

  it("refuses its first unlink after its write authority is displaced", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-gc-lease-"));
    roots.push(root);
    const store = await openObjectStore(root);
    const shard = join(root, "objects", "blobs", "aa");
    await mkdir(shard);
    const orphan = join(shard, "b".repeat(62));
    await writeFile(orphan, "must survive lost GC authority");
    const old = new Date(Date.now() - 10_000);
    await utimes(orphan, old, old);
    const displacedLock = join(root, "displaced-workspace.lock");
    let rootObservations = 0;

    const execution = await runWithWorkspaceLock(
      root,
      "garbage-collection lease-fence test",
      (authority) =>
        collectGarbageWithLease(
          authority,
          store,
          {
            listReferencedTreeOids: () => {
              rootObservations += 1;
              if (rootObservations === 3) {
                renameSync(join(root, "workspace.lock"), displacedLock);
              }
              return [];
            },
          },
          { graceMs: 1, now: Date.now() },
        ),
    );

    expect(rootObservations).toBe(3);
    expect(execution).toMatchObject({
      kind: "action-failed",
      cause: expect.any(WorkspaceLockOwnershipLostError),
      cleanup: { kind: "failed" },
    });
    expect((await stat(orphan)).isFile()).toBe(true);
    await rm(displacedLock, { recursive: true, force: true });
  });

  it("removes multiple expired orphan objects from one shard", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-gc-"));
    roots.push(root);
    const store = await openObjectStore(root);
    const metadata = await createTestCurrentMetadataStore(
      join(root, "state.db"),
      root,
    );
    const shard = join(root, "objects", "blobs", "aa");
    await mkdir(shard);
    const first = join(shard, "b".repeat(62));
    const second = join(shard, "c".repeat(62));
    await writeFile(first, "first orphan");
    await writeFile(second, "second orphan");
    const old = new Date(Date.now() - 10_000);
    await utimes(first, old, old);
    await utimes(second, old, old);

    const report = await collectGarbage(store, metadata, {
      graceMs: 1,
      now: Date.now(),
    });

    expect(report.removedBlobs).toBe(2);
    await expect(stat(first)).rejects.toThrow();
    await expect(stat(second)).rejects.toThrow();
    metadata.close();
  });

  it("refuses an oversized inventory before deleting any candidate", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-gc-limit-"));
    roots.push(root);
    const store = await openObjectStore(root);
    const metadata = await createTestCurrentMetadataStore(
      join(root, "state.db"),
      root,
    );
    const shard = join(root, "objects", "blobs", "aa");
    await mkdir(shard);
    const first = join(shard, "b".repeat(62));
    const second = join(shard, "c".repeat(62));
    await writeFile(first, "first orphan");
    await writeFile(second, "second orphan");
    const old = new Date(Date.now() - 10_000);
    await utimes(first, old, old);
    await utimes(second, old, old);

    await expect(
      collectGarbage(store, metadata, {
        graceMs: 1,
        now: Date.now(),
        maxObjects: 1,
      }),
    ).rejects.toThrow("object inventory exceeds the 1-candidate limit");

    await expect(stat(first)).resolves.toBeDefined();
    await expect(stat(second)).resolves.toBeDefined();
    metadata.close();
  });

  it("classifies a rooted closure budget overflow as a resource limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-gc-root-limit-"));
    roots.push(root);
    const store = await openObjectStore(root);
    const metadata = await createTestCurrentMetadataStore(
      join(root, "state.db"),
      root,
    );
    const firstBlob = await publishTestBlob(store, Buffer.from("first"));
    const secondBlob = await publishTestBlob(store, Buffer.from("second"));
    const treeOid = await publishTestTree(
      store,
      [
        {
          path: "first.txt",
          type: "regular",
          blobOid: firstBlob,
          recreationMode: 0o644,
        },
        {
          path: "second.txt",
          type: "regular",
          blobOid: secondBlob,
          recreationMode: 0o644,
        },
      ],
      scope,
    );
    await withTestMetadataWriteAuthority(root, metadata, () => {
      registerTestSession(metadata, "s", "/sessions/s.jsonl", ["leaf"]);
      commitTestNodeState(metadata, "s", "leaf", treeOid);
    });

    await expect(
      collectGarbage(store, metadata, { maxObjects: 2 }),
    ).rejects.toBeInstanceOf(RangeError);
    metadata.close();
  });

  it("rejects a symlinked shard without deleting an outside sentinel", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-gc-"));
    const outside = await mkdtemp(join(tmpdir(), "cyclotomy-gc-outside-"));
    roots.push(root, outside);
    const store = await openObjectStore(root);
    const metadata = await createTestCurrentMetadataStore(
      join(root, "state.db"),
      root,
    );
    const sentinel = join(outside, "b".repeat(62));
    await writeFile(sentinel, "outside");
    const old = new Date(Date.now() - 10_000);
    await utimes(sentinel, old, old);
    await mkdir(join(root, "objects", "blobs"), { recursive: true });
    await symlink(outside, join(root, "objects", "blobs", "aa"));

    await expect(
      collectGarbage(store, metadata, { graceMs: 1, now: Date.now() }),
    ).rejects.toBeInstanceOf(GarbageCollectionNamespaceError);
    await expect(stat(sentinel)).resolves.toBeDefined();
    metadata.close();
  });

  it("fails closed before sweeping when a rooted tree manifest is unreadable", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-gc-"));
    roots.push(root);
    const store = await openObjectStore(root);
    const metadata = await createTestCurrentMetadataStore(
      join(root, "state.db"),
      root,
    );
    const blobOid = await publishTestBlob(
      store,
      Buffer.from("still referenced"),
    );
    const treeOid = await publishTestTree(
      store,
      [
        {
          path: "a.txt",
          type: "regular",
          blobOid,
          recreationMode: 0o644,
        },
      ],
      scope,
    );
    await withTestMetadataWriteAuthority(root, metadata, () =>
      commitTestNodeState(metadata, "s1", "e1", treeOid),
    );

    const old = new Date(Date.now() - 10_000);
    await utimes(contentRecordPath(root, blobOid), old, old);
    await writeFile(objectPath(root, "trees", treeOid), "corrupt");

    await expect(
      collectGarbage(store, metadata, { graceMs: 1, now: Date.now() }),
    ).rejects.toBeInstanceOf(GarbageCollectionMarkError);
    await expect(stat(contentRecordPath(root, blobOid))).resolves.toBeDefined();
    metadata.close();
  });

  it("preserves both a mark failure and read-scope cleanup failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-gc-cleanup-"));
    roots.push(root);
    const store = await openObjectStore(root);
    const cleanupFailure = new Error("mark scope cleanup failed");
    const closeResolutionScope =
      ContentRepository.prototype.closeResolutionScope;
    vi.spyOn(
      ContentRepository.prototype,
      "closeResolutionScope",
    ).mockImplementation(async function (this: ContentRepository, scope) {
      await closeResolutionScope.call(this, scope);
      throw cleanupFailure;
    });
    let observed: unknown;
    try {
      await collectGarbage(
        store,
        { listReferencedTreeOids: () => ["00".repeat(32)] },
        { graceMs: 0, now: Date.now() },
      );
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(GarbageCollectionMarkError);
    expect(observed).toMatchObject({ cause: expect.any(AggregateError) });
    const failures = (
      (observed as GarbageCollectionMarkError).cause as AggregateError
    ).errors;
    expect(failures[0]).toBeInstanceOf(GarbageCollectionMarkError);
    expect(failures[1]).toBe(cleanupFailure);
  });

  it.each([
    [
      "namespace",
      new GarbageCollectionNamespaceError(
        "objects",
        "injected compaction namespace failure",
      ),
      GarbageCollectionNamespaceError,
    ],
    ["range", new RangeError("injected compaction resource limit"), RangeError],
  ] as const)(
    "keeps a %s failure primary when compaction cleanup also fails",
    async (_label, operationFailure, ExpectedError) => {
      const root = await mkdtemp(join(tmpdir(), "cyclotomy-gc-cleanup-"));
      roots.push(root);
      const store = await openObjectStore(root);
      const metadata = await createTestCurrentMetadataStore(
        join(root, "state.db"),
        root,
      );
      const treeOid = await publishTestTree(store, [], scope);
      await withTestMetadataWriteAuthority(root, metadata, () =>
        commitTestNodeState(metadata, "session", "entry", treeOid),
      );
      const cleanupFailure = new Error("compaction scope cleanup failed");
      let operationStarted = false;
      vi.spyOn(
        ObjectStoreMaintenance.prototype,
        "readObject",
      ).mockImplementationOnce(async () => {
        operationStarted = true;
        throw operationFailure;
      });
      const closeResolutionScope =
        ContentRepository.prototype.closeResolutionScope;
      vi.spyOn(
        ContentRepository.prototype,
        "closeResolutionScope",
      ).mockImplementation(async function (
        this: ContentRepository,
        resolutionScope,
      ) {
        await closeResolutionScope.call(this, resolutionScope);
        if (operationStarted) throw cleanupFailure;
      });

      const observed = await collectGarbage(store, metadata).catch(
        (error: unknown) => error,
      );

      expect(observed).toBeInstanceOf(ExpectedError);
      expect(observed).toMatchObject({ cause: expect.any(AggregateError) });
      expect(((observed as Error).cause as AggregateError).errors).toEqual([
        operationFailure,
        cleanupFailure,
      ]);
      metadata.close();
    },
  );

  it("retains a packed read failure when its lease release also fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-gc-pack-lease-"));
    roots.push(root);
    const store = await openObjectStore(root);
    const live = Buffer.from("live packed failure evidence");
    const dead = Buffer.from("dead packed failure evidence");
    const packed = await publishDataPack(root, [live, dead]);
    const treeOid = await publishTestTree(
      store,
      [
        {
          path: "live.txt",
          type: "regular",
          blobOid: packed.contentIds[0]!,
          recreationMode: 0o644,
        },
      ],
      scope,
    );
    const oldPack = (await packPaths(root)).find((path) =>
      path.endsWith(`${packed.packId.slice(2)}.pack`),
    )!;
    const old = new Date(Date.now() - 10_000);
    await utimes(oldPack, old, old);

    let planningStarted = false;
    const inventoryObjects = ObjectStoreMaintenance.prototype.inventory;
    vi.spyOn(ObjectStoreMaintenance.prototype, "inventory").mockImplementation(
      async function (this: ObjectStoreMaintenance, maximumObjects) {
        const inventory = await inventoryObjects.call(this, maximumObjects);
        planningStarted = true;
        return inventory;
      },
    );
    const operationFailure = new Error("packed envelope read failed");
    const readEnvelope = CatalogPackHandle.prototype.readEnvelope;
    vi.spyOn(CatalogPackHandle.prototype, "readEnvelope").mockImplementation(
      async function (this: CatalogPackHandle, entry) {
        if (planningStarted) throw operationFailure;
        return await readEnvelope.call(this, entry);
      },
    );
    const cleanupFailure = new Error("packed lease release failed");
    const acquire = PackHandlePool.prototype.acquire;
    vi.spyOn(PackHandlePool.prototype, "acquire").mockImplementation(
      async function (this: PackHandlePool, packId, expectedIdentity) {
        const acquired = await acquire.call(this, packId, expectedIdentity);
        if (!planningStarted || acquired.kind !== "acquired") return acquired;
        return {
          kind: "acquired" as const,
          lease: Object.freeze({
            handle: acquired.lease.handle,
            release: async (): Promise<void> => {
              await acquired.lease.release();
              throw cleanupFailure;
            },
          }),
        };
      },
    );

    const observed = await collectGarbage(
      store,
      { listReferencedTreeOids: () => [treeOid] },
      { graceMs: 1, now: Date.now() },
    ).catch((error: unknown) => error);

    expect(observed).toBeInstanceOf(AggregateError);
    expect((observed as AggregateError).errors).toEqual([
      operationFailure,
      cleanupFailure,
    ]);
    await expect(stat(oldPack)).resolves.toBeDefined();
  });

  it("fails closed before sweeping when rooted content is corrupt", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-gc-"));
    roots.push(root);
    const store = await openObjectStore(root);
    const metadata = await createTestCurrentMetadataStore(
      join(root, "state.db"),
      root,
    );
    const blobOid = await publishTestBlob(store, Buffer.from("rooted bytes"));
    const treeOid = await publishTestTree(
      store,
      [
        {
          path: "rooted.txt",
          type: "regular",
          blobOid,
          recreationMode: 0o644,
        },
      ],
      scope,
    );
    await withTestMetadataWriteAuthority(root, metadata, () =>
      commitTestNodeState(metadata, "s1", "e1", treeOid),
    );

    const rootedPath = contentRecordPath(root, blobOid);
    await writeFile(rootedPath, "corrupt but still reachable");
    const orphanOid = "f".repeat(64);
    const orphanPath = objectPath(root, "blobs", orphanOid);
    await mkdir(join(root, "objects", "blobs", orphanOid.slice(0, 2)), {
      recursive: true,
    });
    await writeFile(orphanPath, "orphan");
    const old = new Date(Date.now() - 10_000);
    await utimes(rootedPath, old, old);
    await utimes(orphanPath, old, old);

    await expect(
      collectGarbage(store, metadata, {
        graceMs: 1,
        now: Date.now(),
      }),
    ).rejects.toBeInstanceOf(GarbageCollectionMarkError);

    await expect(stat(rootedPath)).resolves.toBeDefined();
    await expect(stat(orphanPath)).resolves.toBeDefined();
    metadata.close();
  });

  it("fails closed when current metadata illegally roots a historical tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-gc-v1-"));
    roots.push(root);
    const store = await openObjectStore(root);
    const metadata = await createTestCurrentMetadataStore(
      join(root, "state.db"),
      root,
    );
    for (const [kind, oid, fixture] of [
      ["blobs", incompatibleV1BlobOid, "incompatible-gitignore.blob"],
      ["trees", incompatibleV1TreeOid, "incompatible-gitignore.tree"],
    ] as const) {
      const path = objectPath(root, kind, oid);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        await readFile(join(publishedV1FixtureRoot, fixture)),
      );
    }
    await withTestMetadataWriteAuthority(root, metadata, () =>
      commitTestNodeState(metadata, "legacy", "blocked", incompatibleV1TreeOid),
    );

    const orphanOid = "f".repeat(64);
    const orphanPath = objectPath(root, "blobs", orphanOid);
    await mkdir(dirname(orphanPath), { recursive: true });
    await writeFile(orphanPath, "orphan");
    const old = new Date(Date.now() - 10_000);
    await Promise.all([
      utimes(objectPath(root, "blobs", incompatibleV1BlobOid), old, old),
      utimes(objectPath(root, "trees", incompatibleV1TreeOid), old, old),
      utimes(orphanPath, old, old),
    ]);

    await expect(
      collectGarbage(store, metadata, {
        graceMs: 1,
        now: Date.now(),
      }),
    ).rejects.toBeInstanceOf(GarbageCollectionMarkError);

    await expect(
      stat(objectPath(root, "blobs", incompatibleV1BlobOid)),
    ).resolves.toBeDefined();
    await expect(
      stat(objectPath(root, "trees", incompatibleV1TreeOid)),
    ).resolves.toBeDefined();
    await expect(stat(orphanPath)).resolves.toBeDefined();
    await expect(store.readTree(incompatibleV1TreeOid)).rejects.toMatchObject({
      code: "object-integrity",
    });
    metadata.close();
  });

  it("compacts same-path history into an authenticated one-hop delta", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-gc-delta-"));
    roots.push(root);
    const store = await openObjectStore(root);
    const first = Buffer.allocUnsafe(8 * 1024);
    let state = 0x12345678;
    for (let index = 0; index < first.byteLength; index += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      first[index] = state >>> 24;
    }
    const second = Buffer.from(first);
    second.fill(0x5a, 3_000, 3_064);
    const firstId = await publishTestBlob(store, first);
    const secondId = await publishTestBlob(store, second);
    const firstTree = await publishTestTree(
      store,
      [
        {
          path: "history.bin",
          type: "regular",
          blobOid: firstId,
          recreationMode: 0o644,
        },
      ],
      scope,
    );
    const secondTree = await publishTestTree(
      store,
      [
        {
          path: "history.bin",
          type: "regular",
          blobOid: secondId,
          recreationMode: 0o644,
        },
      ],
      scope,
    );
    const metadata = {
      listReferencedTreeOids: () => [firstTree, secondTree],
    };

    const report = await collectGarbage(store, metadata, {
      graceMs: 0,
      now: Date.now() + 1_000,
    });

    const inventory = await new PackCatalog(
      nativeObjectLayout(root),
    ).inventory();
    expect(
      inventory.views
        .flatMap(({ entries }) => entries)
        .some(({ encoding }) => encoding === "delta1"),
    ).toBe(true);
    expect(report.compactedObjects).toBeGreaterThanOrEqual(2);
    await expect(store.readBlob(firstId)).resolves.toEqual(first);
    await expect(store.readBlob(secondId)).resolves.toEqual(second);
  });

  it("materializes a delta target after its pack-local base becomes unrooted", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-gc-delta-rebase-"));
    roots.push(root);
    const store = await openObjectStore(root);
    const first = Buffer.allocUnsafe(12 * 1024);
    for (let index = 0; index < first.byteLength; index += 1) {
      first[index] = (index * 131 + Math.floor(index / 97)) & 0xff;
    }
    const second = Buffer.from(first);
    second.fill(0x3c, 5_000, 5_064);
    const firstId = await publishTestBlob(store, first);
    const secondId = await publishTestBlob(store, second);
    const trees = new Map([
      [
        firstId,
        await publishTestTree(
          store,
          [
            {
              path: "history.bin",
              type: "regular",
              blobOid: firstId,
              recreationMode: 0o644,
            },
          ],
          scope,
        ),
      ],
      [
        secondId,
        await publishTestTree(
          store,
          [
            {
              path: "history.bin",
              type: "regular",
              blobOid: secondId,
              recreationMode: 0o644,
            },
          ],
          scope,
        ),
      ],
    ]);
    let rootedTrees = [...trees.values()];
    const metadata = { listReferencedTreeOids: () => rootedTrees };
    const options = { graceMs: 0, now: Date.now() + 60_000 };

    await collectGarbage(store, metadata, options);
    let inventory = await new PackCatalog(nativeObjectLayout(root)).inventory();
    const deltaOccurrence = inventory.packs
      .flatMap((pack) => pack.view.entries.map((entry) => ({ pack, entry })))
      .find(({ entry }) => entry.encoding === "delta1");
    if (deltaOccurrence === undefined) {
      throw new Error("test history did not produce a delta");
    }
    const catalog = new PackCatalog(nativeObjectLayout(root));
    const handle = await catalog.openPack(deltaOccurrence.pack.view.packId);
    if (handle === undefined) throw new Error("test delta pack disappeared");
    let targetId: string;
    let baseId: string;
    try {
      const envelope = await handle.readEnvelope(deltaOccurrence.entry);
      if (envelope.encoding !== "delta1") {
        throw new Error("test target is not delta encoded");
      }
      const program = decodeDelta1Program(
        envelope.payload,
        envelope.decodedLength,
      );
      const base = handle.entryForPhysicalOrdinal(
        deltaOccurrence.entry.physicalOrdinal - program.baseBackDistance,
      );
      if (base === undefined) throw new Error("test delta has no base");
      targetId = deltaOccurrence.entry.logicalId;
      baseId = base.logicalId;
    } finally {
      await handle.close();
    }
    rootedTrees = [trees.get(targetId)!];

    await collectGarbage(store, metadata, options);

    inventory = await catalog.inventory();
    const entries = inventory.views.flatMap(({ entries }) => entries);
    expect(
      entries.filter(
        ({ kind, logicalId }) => kind === "content" && logicalId === targetId,
      ),
    ).toHaveLength(1);
    expect(
      entries.find(
        ({ kind, logicalId }) => kind === "content" && logicalId === targetId,
      )?.encoding,
    ).not.toBe("delta1");
    expect(
      entries.some(
        ({ kind, logicalId }) => kind === "content" && logicalId === baseId,
      ),
    ).toBe(false);
    await expect(store.readBlob(targetId)).resolves.toEqual(
      targetId === firstId ? first : second,
    );
    await expect(store.readBlob(baseId)).rejects.toThrow();
  });

  it("skips a large anchor pack, then deltas against the small generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-gc-history-step-"));
    roots.push(root);
    const store = await openObjectStore(root);
    const first = Buffer.allocUnsafe(96 * 1024);
    let state = 0x41c6_4e6d;
    for (let index = 0; index < first.byteLength; index += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      first[index] = state >>> 24;
    }
    const second = Buffer.from(first);
    second.fill(0xa7, 2_000, 2_048);
    const third = Buffer.from(second);
    third.fill(0x3c, 6_000, 6_064);
    const ballastBytes = Array.from({ length: 16 }, (_, ballastIndex) => {
      const bytes = Buffer.allocUnsafe(8 * 1024);
      let ballastState = (0x9e37_79b9 ^ ballastIndex) >>> 0;
      for (let index = 0; index < bytes.byteLength; index += 1) {
        ballastState = (Math.imul(ballastState, 1_103_515_245) + 12_345) >>> 0;
        bytes[index] = ballastState >>> 24;
      }
      return bytes;
    });
    const seeded = await publishDataPack(root, [first, ...ballastBytes]);
    const firstId = seeded.contentIds[0]!;
    const ballast = seeded.contentIds.slice(1).map((blobOid, index) => ({
      path: `ballast-${index}.bin`,
      blobOid,
    }));
    const firstTree = await publishTestTree(
      store,
      [
        {
          path: "history.bin",
          type: "regular",
          blobOid: firstId,
          recreationMode: 0o644,
        },
        ...ballast.map(({ path, blobOid }) => ({
          path,
          type: "regular" as const,
          blobOid,
          recreationMode: 0o644,
        })),
      ],
      scope,
    );
    const options = { graceMs: 0, now: Date.now() + 60_000 };
    await collectGarbage(
      store,
      { listReferencedTreeOids: () => [firstTree] },
      options,
    );
    const catalog = new PackCatalog(nativeObjectLayout(root));
    const firstPack = (await catalog.inventory()).packs.find(({ view }) =>
      view.entries.some(
        ({ kind, logicalId }) => kind === "content" && logicalId === firstId,
      ),
    );
    expect(firstPack).toBeDefined();

    const secondId = await publishLooseFullRecord(root, second);
    const secondRecordBytes = (await stat(contentRecordPath(root, secondId)))
      .size;
    expect(
      crossGenerationRewriteIsWorthwhile({
        selectedTargetBytes: secondRecordBytes,
        sourcePackBytes: firstPack!.identity.size,
      }),
    ).toBe(false);
    const secondTree = await publishTestTree(
      store,
      [
        {
          path: "history.bin",
          type: "regular",
          blobOid: secondId,
          recreationMode: 0o644,
        },
      ],
      scope,
    );
    await collectGarbage(
      store,
      { listReferencedTreeOids: () => [firstTree, secondTree] },
      options,
    );

    let inventory = await catalog.inventory();
    expect(
      inventory.packs.some(
        ({ view }) => view.packId === firstPack!.view.packId,
      ),
    ).toBe(true);
    const secondPack = inventory.packs.find(({ view }) =>
      view.entries.some(
        ({ kind, logicalId }) => kind === "content" && logicalId === secondId,
      ),
    );
    expect(secondPack).toBeDefined();
    expect(secondPack!.view.packId).not.toBe(firstPack!.view.packId);
    expect(
      secondPack!.view.entries.find(
        ({ kind, logicalId }) => kind === "content" && logicalId === secondId,
      )?.encoding,
    ).not.toBe("delta1");

    const thirdId = await publishLooseFullRecord(root, third);
    expect(
      crossGenerationRewriteIsWorthwhile({
        selectedTargetBytes: (await stat(contentRecordPath(root, thirdId)))
          .size,
        sourcePackBytes: secondPack!.identity.size,
      }),
    ).toBe(true);
    const thirdTree = await publishTestTree(
      store,
      [
        {
          path: "history.bin",
          type: "regular",
          blobOid: thirdId,
          recreationMode: 0o644,
        },
      ],
      scope,
    );
    await collectGarbage(
      store,
      {
        listReferencedTreeOids: () => [firstTree, secondTree, thirdTree],
      },
      options,
    );

    inventory = await catalog.inventory();
    expect(
      inventory.packs.some(
        ({ view }) => view.packId === firstPack!.view.packId,
      ),
    ).toBe(true);
    expect(
      inventory.packs.some(
        ({ view }) => view.packId === secondPack!.view.packId,
      ),
    ).toBe(false);
    const recentEntries = inventory.packs.flatMap(({ view }) =>
      view.entries.filter(
        ({ kind, logicalId }) =>
          kind === "content" &&
          (logicalId === secondId || logicalId === thirdId),
      ),
    );
    expect(recentEntries).toHaveLength(2);
    expect(recentEntries.some(({ encoding }) => encoding === "delta1")).toBe(
      true,
    );

    const stablePackIds = inventory.packs.map(({ view }) => view.packId).sort();
    const settled = await collectGarbage(
      store,
      {
        listReferencedTreeOids: () => [firstTree, secondTree, thirdTree],
      },
      options,
    );
    expect(settled).toMatchObject({
      removedPacks: 0,
      removedRecords: 0,
      writtenPacks: 0,
    });
    expect(
      (await catalog.inventory()).packs.map(({ view }) => view.packId).sort(),
    ).toEqual(stablePackIds);
    await expect(store.readBlob(firstId)).resolves.toEqual(first);
    await expect(store.readBlob(secondId)).resolves.toEqual(second);
    await expect(store.readBlob(thirdId)).resolves.toEqual(third);
  });

  it("does not rewrite a small historical pack when no delta is useful", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-gc-history-miss-"));
    roots.push(root);
    const store = await openObjectStore(root);
    const deterministic = (seed: number): Buffer => {
      const bytes = Buffer.allocUnsafe(96 * 1024);
      let state = seed >>> 0;
      for (let index = 0; index < bytes.byteLength; index += 1) {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        bytes[index] = state >>> 24;
      }
      return bytes;
    };
    const first = deterministic(0x1234_5678);
    const second = deterministic(0x8765_4321);
    const seeded = await publishDataPack(root, [first]);
    const firstId = seeded.contentIds[0]!;
    const firstTree = await publishTestTree(
      store,
      [
        {
          path: "history.bin",
          type: "regular",
          blobOid: firstId,
          recreationMode: 0o644,
        },
      ],
      scope,
    );
    const options = { graceMs: 0, now: Date.now() + 60_000 };
    await collectGarbage(
      store,
      { listReferencedTreeOids: () => [firstTree] },
      options,
    );
    const catalog = new PackCatalog(nativeObjectLayout(root));
    const firstPack = (await catalog.inventory()).packs.find(({ view }) =>
      view.entries.some(
        ({ kind, logicalId }) => kind === "content" && logicalId === firstId,
      ),
    );
    expect(firstPack).toBeDefined();

    const secondId = await publishLooseFullRecord(root, second);
    expect(
      crossGenerationRewriteIsWorthwhile({
        selectedTargetBytes: (await stat(contentRecordPath(root, secondId)))
          .size,
        sourcePackBytes: firstPack!.identity.size,
      }),
    ).toBe(true);
    const secondTree = await publishTestTree(
      store,
      [
        {
          path: "history.bin",
          type: "regular",
          blobOid: secondId,
          recreationMode: 0o644,
        },
      ],
      scope,
    );
    const metadata = {
      listReferencedTreeOids: () => [firstTree, secondTree],
    };
    const report = await collectGarbage(store, metadata, options);
    let inventory = await catalog.inventory();
    expect(report.removedPacks).toBe(0);
    expect(
      inventory.packs.some(
        ({ view }) => view.packId === firstPack!.view.packId,
      ),
    ).toBe(true);
    expect(
      inventory.packs
        .flatMap(({ view }) => view.entries)
        .filter(
          ({ kind, logicalId }) =>
            kind === "content" &&
            (logicalId === firstId || logicalId === secondId),
        )
        .every(({ encoding }) => encoding !== "delta1"),
    ).toBe(true);

    const publishIndex = vi.spyOn(
      PackCatalog.prototype,
      "publishMultiPackIndexCache",
    );
    const stablePackIds = inventory.packs.map(({ view }) => view.packId).sort();
    const settled = await collectGarbage(store, metadata, options);
    inventory = await catalog.inventory();
    expect(settled).toMatchObject({
      removedPacks: 0,
      removedRecords: 0,
      writtenPacks: 0,
    });
    expect(publishIndex).not.toHaveBeenCalled();
    expect(inventory.packs.map(({ view }) => view.packId).sort()).toEqual(
      stablePackIds,
    );
    await expect(store.readBlob(firstId)).resolves.toEqual(first);
    await expect(store.readBlob(secondId)).resolves.toEqual(second);
  });

  it("merges at most one same-tier group per class and reaches a fixed point", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-gc-size-tier-"));
    roots.push(root);
    const store = await openObjectStore(root);
    const sources: Buffer[] = [];
    const sourcePackIds: string[] = [];
    const contentIds: string[] = [];
    for (let sourceIndex = 0; sourceIndex < 8; sourceIndex += 1) {
      const bytes = Buffer.allocUnsafe(8 * 1024);
      let state = (0xa341_316c ^ sourceIndex) >>> 0;
      for (let index = 0; index < bytes.byteLength; index += 1) {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        bytes[index] = state >>> 24;
      }
      const packed = await publishDataPack(root, [bytes]);
      sources.push(bytes);
      sourcePackIds.push(packed.packId);
      contentIds.push(packed.contentIds[0]!);
    }
    const treeOid = await publishTestTree(
      store,
      contentIds.map((blobOid, index) => ({
        path: `rooted-${index}.bin`,
        type: "regular" as const,
        blobOid,
        recreationMode: 0o644,
      })),
      scope,
    );
    const metadata = { listReferencedTreeOids: () => [treeOid] };
    const options = { graceMs: 0, now: Date.now() + 60_000 };
    const catalog = new PackCatalog(nativeObjectLayout(root));
    const sourceBytes = new Map<string, number>(
      (await catalog.inventory()).packs
        .filter(({ view }) => sourcePackIds.includes(view.packId))
        .map(({ identity, view }) => [view.packId, identity.size] as const),
    );

    const report = await collectGarbage(store, metadata, options);
    let inventory = await catalog.inventory();
    expect(report.removedPacks).toBe(4);
    expect(
      inventory.packs.filter(({ view }) => view.packClass === "data"),
    ).toHaveLength(5);
    expect(
      inventory.packs.filter(({ view }) => sourcePackIds.includes(view.packId)),
    ).toHaveLength(4);
    const removedSourceIds = sourcePackIds.filter(
      (packId) => !inventory.packs.some(({ view }) => view.packId === packId),
    );
    const replacementDataPacks = inventory.packs.filter(
      ({ view }) =>
        view.packClass === "data" && !sourcePackIds.includes(view.packId),
    );
    expect(removedSourceIds).toHaveLength(4);
    expect(replacementDataPacks).toHaveLength(1);
    expect(replacementDataPacks[0]!.identity.size).toBeLessThanOrEqual(
      removedSourceIds.reduce(
        (total, packId) => total + sourceBytes.get(packId)!,
        0,
      ),
    );

    const advanced = await collectGarbage(store, metadata, options);
    inventory = await catalog.inventory();
    expect(advanced.removedPacks).toBe(4);
    expect(
      inventory.packs.filter(({ view }) => view.packClass === "data"),
    ).toHaveLength(2);
    expect(
      inventory.packs.some(({ view }) => sourcePackIds.includes(view.packId)),
    ).toBe(false);

    const publishIndex = vi.spyOn(
      PackCatalog.prototype,
      "publishMultiPackIndexCache",
    );
    const stablePackIds = inventory.packs.map(({ view }) => view.packId).sort();
    const settled = await collectGarbage(store, metadata, options);
    inventory = await catalog.inventory();
    expect(settled).toMatchObject({
      removedPacks: 0,
      removedRecords: 0,
      writtenPacks: 0,
    });
    expect(publishIndex).not.toHaveBeenCalled();
    expect(inventory.packs.map(({ view }) => view.packId).sort()).toEqual(
      stablePackIds,
    );
    await Promise.all(
      contentIds.map((contentId, index) =>
        expect(store.readBlob(contentId)).resolves.toEqual(sources[index]),
      ),
    );
  });

  it("does not merge three expired packs with a young fourth peer", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-gc-size-tier-age-"));
    roots.push(root);
    const store = await openObjectStore(root);
    const packed = [];
    for (let index = 0; index < 4; index += 1) {
      packed.push(
        await publishDataPack(root, [Buffer.alloc(8 * 1024, 0x20 + index)]),
      );
    }
    const treeOid = await publishTestTree(
      store,
      packed.map(({ contentIds }, index) => ({
        path: `rooted-${index}.bin`,
        type: "regular" as const,
        blobOid: contentIds[0]!,
        recreationMode: 0o644,
      })),
      scope,
    );
    const now = Date.now();
    const paths = await packPaths(root);
    for (const { packId } of packed.slice(0, 3)) {
      const path = paths.find((candidate) =>
        candidate.endsWith(`${packId.slice(2)}.pack`),
      );
      expect(path).toBeDefined();
      await utimes(path!, new Date(now - 10_000), new Date(now - 10_000));
    }

    const report = await collectGarbage(
      store,
      { listReferencedTreeOids: () => [treeOid] },
      { graceMs: 5_000, now },
    );
    const inventory = await new PackCatalog(
      nativeObjectLayout(root),
    ).inventory();
    expect(report.removedPacks).toBe(0);
    expect(
      inventory.packs.filter(({ view }) => view.packClass === "data"),
    ).toHaveLength(4);
  });

  it("admits a size-tier group atomically within the compaction budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-gc-size-tier-cap-"));
    roots.push(root);
    const store = await openObjectStore(root);
    const packed = [];
    for (let index = 0; index < 4; index += 1) {
      packed.push(
        await publishDataPack(root, [Buffer.alloc(8 * 1024, 0x40 + index)]),
      );
    }
    const treeOid = await publishTestTree(
      store,
      packed.map(({ contentIds }, index) => ({
        path: `rooted-${index}.bin`,
        type: "regular" as const,
        blobOid: contentIds[0]!,
        recreationMode: 0o644,
      })),
      scope,
    );
    const metadata = { listReferencedTreeOids: () => [treeOid] };
    const options = { graceMs: 0, now: Date.now() + 60_000 };

    const bounded = await collectGarbage(store, metadata, {
      ...options,
      maxCompactionObjects: 3,
    });
    let inventory = await new PackCatalog(nativeObjectLayout(root)).inventory();
    expect(bounded.removedPacks).toBe(0);
    expect(
      inventory.packs.filter(({ view }) => view.packClass === "data"),
    ).toHaveLength(4);

    const converged = await collectGarbage(store, metadata, options);
    inventory = await new PackCatalog(nativeObjectLayout(root)).inventory();
    expect(converged.removedPacks).toBe(4);
    expect(
      inventory.packs.filter(({ view }) => view.packClass === "data"),
    ).toHaveLength(1);
  });

  it("converges duplicate rooted pack representations to one coverage", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-gc-duplicate-pack-"));
    roots.push(root);
    const store = await openObjectStore(root);
    const content = Buffer.from("rooted duplicate pack content");
    const first = await publishDataPack(root, [
      content,
      Buffer.from("first crash remnant"),
    ]);
    const second = await publishDataPack(root, [
      content,
      Buffer.from("second crash remnant"),
    ]);
    const contentId = first.contentIds[0]!;
    expect(second.contentIds[0]).toBe(contentId);
    const treeOid = await publishTestTree(
      store,
      [
        {
          path: "rooted.txt",
          type: "regular",
          blobOid: contentId,
          recreationMode: 0o644,
        },
      ],
      scope,
    );
    const old = new Date(Date.now() - 10_000);
    await Promise.all(
      (await packPaths(root)).map((path) => utimes(path, old, old)),
    );

    await collectGarbage(
      store,
      { listReferencedTreeOids: () => [treeOid] },
      { graceMs: 1, now: Date.now() },
    );

    const entries = (
      await new PackCatalog(nativeObjectLayout(root)).inventory()
    ).views.flatMap(({ entries }) => entries);
    expect(
      entries.filter(
        ({ kind, logicalId }) => kind === "content" && logicalId === contentId,
      ),
    ).toHaveLength(1);
    await expect(store.readBlob(contentId)).resolves.toEqual(content);
  });

  it("authenticates the exact retained pack for duplicate structural ids", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "cyclotomy-gc-duplicate-structural-pack-"),
    );
    roots.push(root);
    const store = await openObjectStore(root);
    const contentId = await publishTestBlob(
      store,
      Buffer.from("structural duplicate content", "utf8"),
    );
    const treeOid = await publishTestTree(
      store,
      [
        {
          path: "rooted.txt",
          type: "regular",
          blobOid: contentId,
          recreationMode: 0o644,
        },
      ],
      scope,
    );
    const metadata = { listReferencedTreeOids: () => [treeOid] };
    const options = { graceMs: 0, now: Date.now() + 60_000 };
    await collectGarbage(store, metadata, options);

    const catalog = new PackCatalog(nativeObjectLayout(root));
    const initial = await catalog.inventory();
    const correct = initial.packs.find(({ view }) =>
      view.entries.some(
        ({ kind, logicalId }) => kind === "tree-root" && logicalId === treeOid,
      ),
    );
    expect(correct).toBeDefined();
    const stableHint = await catalog.readMultiPackIndexHint();
    expect(stableHint.kind).toBe("hint");

    let corrupt: Awaited<ReturnType<typeof encodePack>> | undefined;
    for (let nonce = 0; nonce < 1_000; nonce += 1) {
      const payload = Buffer.from(`invalid tree root ${nonce}`, "utf8");
      const candidate = await encodePack(
        {
          packClass: "metadata",
          records: [
            {
              kind: "tree-root",
              encoding: "raw",
              logicalId: parseMetadataId(treeOid),
              decodedLength: payload.byteLength,
              payload,
            },
          ],
        },
        { verifyMetadataId: () => true },
      );
      if (candidate.pack.packId < correct!.view.packId) {
        corrupt = candidate;
        break;
      }
    }
    expect(corrupt).toBeDefined();
    await withWorkspaceLock(
      root,
      "object GC corrupt pack fixture",
      (authority) => catalog.publishPack(corrupt!, authority),
    );
    // Model a crash before replacement of the rebuildable lookup cache. Both
    // complete logical marks may still use the valid old hint, while strict GC
    // inventory sees the lexically preferred bad duplicate and must
    // authenticate that exact retained location.
    vi.spyOn(
      PackCatalog.prototype,
      "publishMultiPackIndexCache",
    ).mockResolvedValue();
    const cleanupFailure = new Error("coverage lease release failed");
    const acquire = PackHandlePool.prototype.acquire;
    vi.spyOn(PackHandlePool.prototype, "acquire").mockImplementation(
      async function (this: PackHandlePool, packId, expectedIdentity) {
        const acquired = await acquire.call(this, packId, expectedIdentity);
        if (packId !== corrupt!.pack.packId || acquired.kind !== "acquired") {
          return acquired;
        }
        return {
          kind: "acquired" as const,
          lease: Object.freeze({
            handle: acquired.lease.handle,
            release: async (): Promise<void> => {
              await acquired.lease.release();
              throw cleanupFailure;
            },
          }),
        };
      },
    );
    const before = await packPaths(root);
    const old = new Date(Date.now() - 10_000);
    await Promise.all(before.map((path) => utimes(path, old, old)));

    const observed = await collectGarbage(store, metadata, options).catch(
      (error: unknown) => error,
    );
    expect(observed).toMatchObject({
      name: "GarbageCollectionNamespaceError",
      message: expect.stringContaining("retained coverage"),
    });
    expect(observed).toMatchObject({ cause: expect.any(AggregateError) });
    expect(
      ((observed as GarbageCollectionNamespaceError).cause as AggregateError)
        .errors[1],
    ).toBe(cleanupFailure);

    expect(await packPaths(root)).toEqual(expect.arrayContaining([...before]));
    await expect(store.readTreeManifest(treeOid)).resolves.toMatchObject({
      entries: [{ path: "rooted.txt", blobOid: contentId }],
    });
  });

  it("uses additive headroom before publishing replacement packs", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-gc-headroom-"));
    roots.push(root);
    const store = await openObjectStore(root);
    const content = Buffer.from("rooted loose content");
    const contentId = await publishTestBlob(store, content);
    const treeOid = await publishTestTree(
      store,
      [
        {
          path: "rooted.txt",
          type: "regular",
          blobOid: contentId,
          recreationMode: 0o644,
        },
      ],
      scope,
    );
    const dead = await publishDataPack(root, [Buffer.from("expired pack")]);
    const deadPath = (await packPaths(root)).find((path) =>
      path.endsWith(`${dead.packId.slice(2)}.pack`),
    )!;
    const old = new Date(Date.now() - 10_000);
    await utimes(deadPath, old, old);
    const layout = nativeObjectLayout(root);
    const objects = await new ObjectStoreMaintenance(layout).inventory(1_000);
    const packs = await new PackCatalog(layout).inventory();
    const exactCurrentCount =
      objects.objects.length + packs.totalIndexEntries + packs.incoming.length;

    const report = await collectGarbage(
      store,
      { listReferencedTreeOids: () => [treeOid] },
      {
        graceMs: 1,
        now: Date.now(),
        maxObjects: exactCurrentCount,
      },
    );

    expect(report.writtenPacks).toBe(0);
    expect(report.removedPacks).toBe(1);
    await expect(stat(deadPath)).rejects.toThrow();
    await expect(
      stat(contentRecordPath(root, contentId)),
    ).resolves.toBeDefined();
    await expect(store.readBlob(contentId)).resolves.toEqual(content);
  });

  it("packs and restores a chunked recipe closure without loose dependencies", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-gc-recipe-"));
    roots.push(root);
    const store = await openObjectStore(root);
    const content = Buffer.allocUnsafe(400 * 1024);
    for (let index = 0; index < content.byteLength; index += 1) {
      content[index] = (index * 31 + Math.floor(index / 257)) & 0xff;
    }
    const contentId = await publishTestBlob(store, content);
    const treeOid = await publishTestTree(
      store,
      [
        {
          path: "large.bin",
          type: "regular",
          blobOid: contentId,
          recreationMode: 0o644,
        },
      ],
      scope,
    );

    await collectGarbage(
      store,
      { listReferencedTreeOids: () => [treeOid] },
      { graceMs: 0, now: Date.now() + 1_000 },
    );

    const inventory = await new PackCatalog(
      nativeObjectLayout(root),
    ).inventory();
    const entries = inventory.views.flatMap(({ entries }) => entries);
    expect(entries.some(({ encoding }) => encoding === "chunked-v1")).toBe(
      true,
    );
    expect(entries.some(({ kind }) => kind === "recipe")).toBe(true);
    await expect(store.readBlob(contentId)).resolves.toEqual(content);
  });

  it("keeps a newly materialized large legacy closure live through zero-grace cutover", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-gc-legacy-large-"));
    roots.push(root);
    const store = await openObjectStore(root);
    const content = Buffer.allocUnsafe(400 * 1024);
    for (let index = 0; index < content.byteLength; index += 1) {
      content[index] = (index * 17 + Math.floor(index / 193)) & 0xff;
    }
    const contentId = createHash("sha256").update(content).digest("hex");
    const legacyPath = objectPath(root, "blobs", contentId);
    await mkdir(dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, content);
    const treeOid = await publishTestTree(
      store,
      [
        {
          path: "legacy-large.bin",
          type: "regular",
          blobOid: contentId,
          recreationMode: 0o644,
        },
      ],
      scope,
    );
    await expect(stat(contentRecordPath(root, contentId))).rejects.toThrow();

    await collectGarbage(
      store,
      { listReferencedTreeOids: () => [treeOid] },
      { graceMs: 0, now: Date.now() + 60_000 },
    );

    await expect(stat(legacyPath)).rejects.toThrow();
    await expect(store.readBlob(contentId)).resolves.toEqual(content);
    const entries = (
      await new PackCatalog(nativeObjectLayout(root)).inventory()
    ).views.flatMap(({ entries }) => entries);
    expect(entries.some(({ encoding }) => encoding === "chunked-v1")).toBe(
      true,
    );
    expect(entries.some(({ kind }) => kind === "recipe")).toBe(true);
  });

  it("rewrites a half-dead pack before deleting its exact old receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-gc-partial-"));
    roots.push(root);
    const store = await openObjectStore(root);
    const live = Buffer.from("live packed content");
    const dead = Buffer.from("dead packed content");
    const packed = await publishDataPack(root, [live, dead]);
    const [liveId, deadId] = packed.contentIds;
    const treeOid = await publishTestTree(
      store,
      [
        {
          path: "live.txt",
          type: "regular",
          blobOid: liveId!,
          recreationMode: 0o644,
        },
      ],
      scope,
    );
    const oldPack = (await packPaths(root)).find((path) =>
      path.endsWith(`${packed.packId.slice(2)}.pack`),
    )!;
    const old = new Date(Date.now() - 10_000);
    await utimes(oldPack, old, old);

    const report = await collectGarbage(
      store,
      { listReferencedTreeOids: () => [treeOid] },
      { graceMs: 1, now: Date.now() },
    );

    expect(report.removedPacks).toBe(1);
    expect(report.removedBlobs).toBe(1);
    await expect(stat(oldPack)).rejects.toThrow();
    await expect(store.readBlob(liveId!)).resolves.toEqual(live);
    await expect(store.readBlob(deadId!)).rejects.toThrow();
  });

  it("rewrites a pack when a minority of dead records holds most bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-gc-dead-bytes-"));
    roots.push(root);
    const store = await openObjectStore(root);
    const live = [
      Buffer.from("live-a"),
      Buffer.from("live-b"),
      Buffer.from("live-c"),
    ];
    const dead = Buffer.allocUnsafe(192 * 1024);
    for (let index = 0; index < dead.byteLength; index += 1) {
      dead[index] = (index * 131 + Math.floor(index / 251)) & 0xff;
    }
    const packed = await publishDataPack(root, [...live, dead]);
    const liveIds = packed.contentIds.slice(0, live.length);
    const deadId = packed.contentIds.at(-1)!;
    const treeOid = await publishTestTree(
      store,
      liveIds.map((blobOid, index) => ({
        path: `live-${index}.txt`,
        type: "regular" as const,
        blobOid,
        recreationMode: 0o644,
      })),
      scope,
    );
    const oldPack = (await packPaths(root)).find((path) =>
      path.endsWith(`${packed.packId.slice(2)}.pack`),
    )!;
    const old = new Date(Date.now() - 10_000);
    await utimes(oldPack, old, old);

    const report = await collectGarbage(
      store,
      { listReferencedTreeOids: () => [treeOid] },
      { graceMs: 1, now: Date.now() },
    );

    expect(report.removedPacks).toBe(1);
    await expect(stat(oldPack)).rejects.toThrow();
    for (const [index, contentId] of liveIds.entries()) {
      await expect(store.readBlob(contentId!)).resolves.toEqual(live[index]);
    }
    await expect(store.readBlob(deadId)).rejects.toThrow();
  });

  it("deletes a fully dead pack and rebuilds the MIDX cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-gc-dead-pack-"));
    roots.push(root);
    const store = await openObjectStore(root);
    const packed = await publishDataPack(root, [Buffer.from("orphan pack")]);
    const oldPack = (await packPaths(root))[0]!;
    const old = new Date(Date.now() - 10_000);
    await utimes(oldPack, old, old);
    await writeFile(join(root, "objects", "packs", "multi-pack-index"), "bad");

    const report = await collectGarbage(
      store,
      { listReferencedTreeOids: () => [] },
      { graceMs: 1, now: Date.now() },
    );

    expect(report.removedPacks).toBe(1);
    expect(await packPaths(root)).toEqual([]);
    await expect(store.readBlob(packed.contentIds[0]!)).rejects.toThrow();
    await expect(
      readFile(join(root, "objects", "packs", "multi-pack-index")),
    ).resolves.not.toEqual(Buffer.from("bad"));
  });

  it("rechecks the complete root set before the first destructive action", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-gc-root-drift-"));
    roots.push(root);
    const store = await openObjectStore(root);
    const contentId = await publishTestBlob(store, Buffer.from("rooted"));
    const treeOid = await publishTestTree(
      store,
      [
        {
          path: "rooted.txt",
          type: "regular",
          blobOid: contentId,
          recreationMode: 0o644,
        },
      ],
      scope,
    );
    const orphanId = "e".repeat(64);
    const orphan = objectPath(root, "blobs", orphanId);
    await mkdir(dirname(orphan), { recursive: true });
    await writeFile(orphan, "must survive aborted cutover");
    const old = new Date(Date.now() - 10_000);
    await utimes(orphan, old, old);
    let observations = 0;
    const metadata = {
      listReferencedTreeOids: () => (observations++ === 0 ? [treeOid] : []),
    };

    await expect(
      collectGarbage(store, metadata, { graceMs: 1, now: Date.now() }),
    ).rejects.toBeInstanceOf(GarbageCollectionRootDriftError);

    await expect(stat(orphan)).resolves.toBeDefined();
    await expect(store.readBlob(contentId)).resolves.toEqual(
      Buffer.from("rooted"),
    );
  });

  it("rejects an identity race before unlinking the replacement pathname", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-gc-identity-race-"));
    roots.push(root);
    const store = await openObjectStore(root);
    const orphanId = "d".repeat(64);
    const orphan = objectPath(root, "blobs", orphanId);
    await mkdir(dirname(orphan), { recursive: true });
    await writeFile(orphan, "inventoried orphan");
    const old = new Date(Date.now() - 10_000);
    await utimes(orphan, old, old);
    let observations = 0;
    const metadata = {
      listReferencedTreeOids: () => {
        observations += 1;
        if (observations === 2) {
          writeFileSync(orphan, "replacement must not be unlinked");
        }
        return [];
      },
    };

    await expect(
      collectGarbage(store, metadata, { graceMs: 1, now: Date.now() }),
    ).rejects.toBeInstanceOf(GarbageCollectionNamespaceError);

    await expect(readFile(orphan, "utf8")).resolves.toBe(
      "replacement must not be unlinked",
    );
  });

  it("removes only expired authenticated incoming publication remnants", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-gc-incoming-"));
    roots.push(root);
    const store = await openObjectStore(root);
    const incoming = join(
      root,
      "objects",
      "packs",
      "incoming",
      `.${"a".repeat(64)}.${process.pid}.123e4567-e89b-42d3-a456-426614174000.pack.tmp`,
    );
    await writeFile(incoming, "orphan publication");
    const old = new Date(Date.now() - 10_000);
    await utimes(incoming, old, old);

    const report = await collectGarbage(
      store,
      { listReferencedTreeOids: () => [] },
      { graceMs: 1, now: Date.now() },
    );

    expect(report.removedTmpFiles).toBe(1);
    await expect(stat(incoming)).rejects.toThrow();
  });
});
