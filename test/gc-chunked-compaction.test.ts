import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseContentId,
  parseRecipeId,
} from "../src/infrastructure/content-store/ids.ts";
import { createChunkedContentRecord } from "../src/infrastructure/content-store/representation.ts";
import { encodeRecord } from "../src/infrastructure/content-store/record.ts";
import { ContentRepository } from "../src/infrastructure/content-store/repository.ts";
import {
  PackCatalog,
  CatalogPackHandle,
} from "../src/infrastructure/content-store/pack-catalog.ts";
import {
  collectGarbage,
  GarbageCollectionMarkError,
  GarbageCollectionNamespaceError,
} from "../src/infrastructure/object-gc.ts";
import {
  nativeObjectStoreLayout,
  openObjectStore,
} from "../src/infrastructure/object-store.ts";
import { publishSnapshot } from "../src/infrastructure/snapshot-publication.ts";
import { withWorkspaceLock } from "../src/infrastructure/workspace-lock.ts";
import { scanWorkspace } from "../src/infrastructure/workspace-scan.ts";

const roots: string[] = [];
const LARGE_FILE_BYTES = 40 * 1024 * 1024;
const DEAD_FILES = 60;
const DEAD_FILE_BYTES = 32 * 1024;

async function mixedPack() {
  const base = await mkdtemp(join(tmpdir(), "cyclotomy-gc-chunked-"));
  roots.push(base);
  const workspace = join(base, "workspace");
  const storeRoot = join(base, "store");
  await mkdir(workspace);
  await mkdir(storeRoot);
  const store = await openObjectStore(storeRoot);

  const large = Buffer.alloc(LARGE_FILE_BYTES, 0x41);
  const contentId = createHash("sha256").update(large).digest("hex");
  await writeFile(join(workspace, "large.bin"), large);
  for (let index = 0; index < DEAD_FILES; index += 1) {
    await writeFile(
      join(workspace, `small-${index}.bin`),
      randomBytes(DEAD_FILE_BYTES),
    );
  }
  await publishSnapshot(store, await scanWorkspace(workspace));
  const catalog = new PackCatalog(
    nativeObjectStoreLayout(store, "chunked GC test"),
  );
  const inventory = await catalog.inventory();
  const rootPack = inventory.packs.find(({ view }) =>
    view.entries.some((entry) => entry.logicalId === contentId),
  )!;
  const recipePack = inventory.packs.find(({ view }) =>
    view.entries.some((entry) => entry.kind === "recipe"),
  )!;
  expect(rootPack.view.entries.length).toBe(DEAD_FILES + 2);
  expect(rootPack.identity.size).toBeGreaterThan(DEAD_FILES * DEAD_FILE_BYTES);
  for (let index = 0; index < DEAD_FILES; index += 1) {
    await rm(join(workspace, `small-${index}.bin`));
  }
  const treeOid = await publishSnapshot(store, await scanWorkspace(workspace));
  return {
    base,
    store,
    storeRoot,
    catalog,
    contentId,
    treeOid,
    rootPack,
    recipePack,
    collect: () =>
      withWorkspaceLock(storeRoot, "chunked GC test", (authority) =>
        collectGarbage(
          authority,
          store,
          { listReferencedTreeOids: () => [treeOid] },
          {
            graceMs: 0,
            now: Date.now() + 60_000,
          },
        ),
      ),
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("chunked roots in mixed compaction packs", () => {
  it("reclaims dead neighbors of a 40 MiB root using its exact marked closure", async () => {
    const fixture = await mixedPack();
    const read = vi.spyOn(ContentRepository.prototype, "streamContent");
    const proofCheck = vi.spyOn(
      ContentRepository.prototype,
      "verifiedContentClosureStillCurrent",
    );
    const report = await fixture.collect();

    expect(report.removedBlobs).toBe(DEAD_FILES);
    await expect(stat(fixture.rootPack.path)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const inventory = await fixture.catalog.inventory();
    expect(
      inventory.packs
        .filter(({ view }) => view.packClass === "data")
        .reduce((total, pack) => total + pack.identity.size, 0),
    ).toBeLessThan(1024);
    expect(proofCheck).toHaveBeenCalled();
    // The full file is still authenticated at both destructive-operation fences.
    expect(
      read.mock.calls.filter(([id]) => id === fixture.contentId),
    ).toHaveLength(2);
    const digest = createHash("sha256");
    const restored = await fixture.store.streamBlob(
      fixture.contentId,
      async (chunk) => {
        digest.update(chunk);
      },
    );
    expect(restored.decodedLength).toBe(LARGE_FILE_BYTES);
    expect(digest.digest("hex")).toBe(fixture.contentId);
    expect((await fixture.collect()).removedPacks).toBe(0);
  });

  it("uses the marked pack when a loose root names a different recipe for the same content id", async () => {
    const fixture = await mixedPack();
    const replacement = createChunkedContentRecord(
      parseContentId(fixture.contentId),
      LARGE_FILE_BYTES,
      parseRecipeId("55".repeat(32)),
    );
    const loosePath = join(
      fixture.storeRoot,
      "objects",
      "records",
      "content",
      fixture.contentId.slice(0, 2),
      fixture.contentId.slice(2),
    );
    await mkdir(dirname(loosePath), { recursive: true });
    await writeFile(loosePath, encodeRecord(replacement), { mode: 0o600 });

    const report = await fixture.collect();

    expect(report.removedBlobs).toBe(DEAD_FILES);
    await expect(stat(loosePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(fixture.rootPack.path)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      fixture.store.verifyBlobs([fixture.contentId]),
    ).resolves.toBeUndefined();
  });

  it("rejects a different recipe descriptor at an already marked root location", async () => {
    const fixture = await mixedPack();
    const close = ContentRepository.prototype.closeResolutionScope;
    const read = CatalogPackHandle.prototype.readEnvelope;
    const publish = vi.spyOn(PackCatalog.prototype, "publishPack");
    const remove = vi.spyOn(PackCatalog.prototype, "removePack");
    let marked = false;
    let replaced = false;
    vi.spyOn(
      ContentRepository.prototype,
      "closeResolutionScope",
    ).mockImplementation(async function (this: ContentRepository, scope) {
      await close.call(this, scope);
      marked = true;
    });
    vi.spyOn(CatalogPackHandle.prototype, "readEnvelope").mockImplementation(
      async function (this: CatalogPackHandle, entry) {
        const envelope = await read.call(this, entry);
        if (
          marked &&
          envelope.encoding === "chunked-v1" &&
          envelope.logicalId === fixture.contentId
        ) {
          replaced = true;
          return { ...envelope, payload: Buffer.alloc(32, 0x55) };
        }
        return envelope;
      },
    );

    await expect(fixture.collect()).rejects.toBeInstanceOf(
      GarbageCollectionNamespaceError,
    );
    expect(replaced).toBe(true);
    expect(publish).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    await expect(stat(fixture.rootPack.path)).resolves.toBeDefined();
  });

  it.each(["root", "recipe"] as const)(
    "refuses to reuse a marked closure after its %s pack is replaced",
    async (dependency) => {
      const fixture = await mixedPack();
      const pack =
        dependency === "root" ? fixture.rootPack : fixture.recipePack;
      const close = ContentRepository.prototype.closeResolutionScope;
      const remove = vi.spyOn(PackCatalog.prototype, "removePack");
      let replaced = false;
      vi.spyOn(
        ContentRepository.prototype,
        "closeResolutionScope",
      ).mockImplementation(async function (this: ContentRepository, scope) {
        await close.call(this, scope);
        if (!replaced) {
          replaced = true;
          const replacement = join(fixture.base, "replacement.pack");
          await writeFile(replacement, await readFile(pack.path), {
            mode: 0o600,
          });
          await rename(replacement, pack.path);
        }
      });

      await expect(fixture.collect()).rejects.toBeInstanceOf(
        GarbageCollectionNamespaceError,
      );
      expect(replaced).toBe(true);
      expect(remove).not.toHaveBeenCalled();
      await expect(stat(fixture.rootPack.path)).resolves.toBeDefined();
      await expect(stat(fixture.recipePack.path)).resolves.toBeDefined();
      await expect(
        fixture.store.verifyBlobs([fixture.contentId]),
      ).resolves.toBeUndefined();
    },
  );

  it("authenticates the entire root again after compaction preparation", async () => {
    const fixture = await mixedPack();
    const check =
      ContentRepository.prototype.verifiedContentClosureStillCurrent;
    const close = ContentRepository.prototype.closeResolutionScope;
    const remove = vi.spyOn(PackCatalog.prototype, "removePack");
    let proofReused = false;
    let changed = false;
    vi.spyOn(
      ContentRepository.prototype,
      "verifiedContentClosureStillCurrent",
    ).mockImplementation(async function (this: ContentRepository, closure) {
      const current = await check.call(this, closure);
      proofReused ||= current;
      return current;
    });
    vi.spyOn(
      ContentRepository.prototype,
      "closeResolutionScope",
    ).mockImplementation(async function (this: ContentRepository, scope) {
      await close.call(this, scope);
      if (proofReused && !changed) {
        changed = true;
        const inventory = await fixture.catalog.inventory();
        for (const pack of inventory.packs) {
          if (pack.view.entries.some((entry) => entry.kind === "recipe")) {
            await writeFile(pack.path, "changed recipe pack");
          }
        }
      }
    });

    await expect(fixture.collect()).rejects.toBeInstanceOf(
      GarbageCollectionMarkError,
    );
    expect(proofReused).toBe(true);
    expect(changed).toBe(true);
    expect(remove).not.toHaveBeenCalled();
    await expect(stat(fixture.rootPack.path)).resolves.toBeDefined();
  });
});
