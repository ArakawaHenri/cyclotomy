import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CatalogPackHandle,
  PackCatalog,
  PackCatalogError,
  type CatalogPackIdentityReceipt,
} from "../src/infrastructure/content-store/pack-catalog.ts";
import {
  contentIdFromBytes,
  parseMetadataId,
} from "../src/infrastructure/content-store/ids.ts";
import {
  decodePack,
  encodePack,
  PackFormatError,
  parsePackId,
  type EncodedPack,
} from "../src/infrastructure/content-store/pack.ts";
import type { RecordEnvelope } from "../src/infrastructure/content-store/record.ts";
import {
  nativeObjectLayout,
  nativePackPath,
  nativePackShardPath,
  type NativeObjectLayout,
} from "../src/infrastructure/workspace-store.ts";
import {
  withWorkspaceLock,
  WorkspaceLockOwnershipLostError,
  type WorkspaceWriteAuthority,
} from "../src/infrastructure/workspace-lock.ts";

const temporaryRoots: string[] = [];

async function createLayout(): Promise<NativeObjectLayout> {
  const root = await mkdtemp(join(tmpdir(), "cyclotomy-pack-catalog-"));
  temporaryRoots.push(root);
  const layout = nativeObjectLayout(root);
  await mkdir(layout.incomingPacks, { recursive: true, mode: 0o700 });
  return layout;
}

async function withAuthority<T>(
  layout: NativeObjectLayout,
  action: (authority: WorkspaceWriteAuthority) => Promise<T>,
): Promise<T> {
  return await withWorkspaceLock(layout.root, "pack catalog test", action);
}

async function withDisplacedAuthority<T>(
  layout: NativeObjectLayout,
  action: (authority: WorkspaceWriteAuthority) => Promise<T>,
): Promise<T> {
  return await withWorkspaceLock(
    layout.root,
    "pack catalog lost-authority test",
    async (authority) => {
      const lockPath = join(layout.root, "workspace.lock");
      const displaced = join(
        layout.root,
        `displaced-workspace-lock-${randomUUID()}`,
      );
      await rename(lockPath, displaced);
      try {
        return await withWorkspaceLock(
          layout.root,
          "pack catalog successor test",
          async () => await action(authority),
        );
      } finally {
        await rename(displaced, lockPath);
      }
    },
  );
}

function contentRecord(text: string): RecordEnvelope {
  const bytes = Buffer.from(text, "utf8");
  return {
    kind: "content",
    encoding: "raw",
    logicalId: contentIdFromBytes(bytes),
    decodedLength: bytes.byteLength,
    payload: bytes,
  };
}

async function dataPack(text: string): Promise<EncodedPack> {
  return await encodePack({
    packClass: "data",
    records: [contentRecord(text)],
  });
}

async function fileHandlePrototype(root: string): Promise<{
  readonly stat: FileHandle["stat"];
}> {
  const path = join(root, `file-handle-probe-${randomUUID()}`);
  const probe = await open(path, "w");
  const prototype = Object.getPrototypeOf(probe) as {
    readonly stat: FileHandle["stat"];
  };
  await probe.close();
  await unlink(path);
  return prototype;
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected operation to reject");
}

function resignPack(bytes: Uint8Array): {
  readonly bytes: Uint8Array;
  readonly packId: string;
} {
  const owned = Uint8Array.from(bytes);
  const checksumOffset = owned.byteLength - 32 - 8;
  const checksum = createHash("sha256")
    .update(owned.subarray(0, checksumOffset))
    .digest();
  owned.set(checksum, checksumOffset);
  return { bytes: owned, packId: checksum.toString("hex") };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("pack catalog", () => {
  it("checks mutation authority before pack or MIDX staging writes", async () => {
    const layout = await createLayout();
    const catalog = new PackCatalog(layout);
    const encoded = await dataPack("publication authority");

    await expect(
      withDisplacedAuthority(layout, (authority) =>
        catalog.publishPack(encoded, authority),
      ),
    ).rejects.toBeInstanceOf(WorkspaceLockOwnershipLostError);
    let inventory = await catalog.inventory();
    expect(inventory.packs).toEqual([]);
    expect(inventory.incoming).toEqual([]);

    await expect(
      withDisplacedAuthority(layout, (authority) =>
        catalog.publishMultiPackIndexCache(
          catalog.rebuildMultiPackIndex(inventory),
          inventory,
          authority,
        ),
      ),
    ).rejects.toBeInstanceOf(WorkspaceLockOwnershipLostError);
    inventory = await catalog.inventory();
    expect(inventory.packs).toEqual([]);
    expect(inventory.incoming).toEqual([]);
    await expect(readFile(layout.multiPackIndex)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("retains opened-file validation and cleanup failures without changing the primary category", async () => {
    const layout = await createLayout();
    const catalog = new PackCatalog(layout);
    const encoded = await dataPack("opened file cleanup evidence");
    await withAuthority(layout, (authority) =>
      catalog.publishPack(encoded, authority),
    );

    const prototype = await fileHandlePrototype(layout.root);
    const validationFailure = new Error("injected file stat failure");
    const cleanupFailure = new Error("injected file close failure");
    let closeCalls = 0;
    const stat = vi
      .spyOn(prototype, "stat")
      .mockImplementationOnce(async function (this: FileHandle) {
        const originalClose = this.close;
        Object.defineProperty(this, "close", {
          configurable: true,
          enumerable: true,
          writable: true,
          value: async (): Promise<void> => {
            closeCalls += 1;
            await originalClose.call(this);
            throw cleanupFailure;
          },
        });
        throw validationFailure;
      });

    const failure = await rejected(catalog.openPack(encoded.pack.packId));
    expect(failure).toMatchObject({
      name: "PackCatalogError",
      code: "storage-failure",
      cause: expect.any(AggregateError),
    });
    const aggregate = (failure as PackCatalogError).cause as AggregateError;
    expect(aggregate.errors).toEqual([validationFailure, cleanupFailure]);
    expect(stat).toHaveBeenCalledTimes(1);
    expect(closeCalls).toBe(1);
  });

  it("durably publishes authenticated packs and a rebuildable MIDX cache", async () => {
    const layout = await createLayout();
    const catalog = new PackCatalog(layout);
    const encoded = await dataPack("catalog publication");

    const published = await withAuthority(layout, (authority) =>
      catalog.publishPack(encoded, authority),
    );
    expect(published.disposition).toBe("published");
    expect(published.view.packId).toBe(encoded.pack.packId);
    expect(Object.keys(published).sort()).toEqual([
      "disposition",
      "identity",
      "view",
    ]);
    const reopen = vi.spyOn(catalog, "openPack");
    const existing = await withAuthority(layout, (authority) =>
      catalog.publishPack(encoded, authority),
    );
    expect(existing.disposition).toBe("existing");
    expect(existing.view).toEqual(encoded.pack.indexView());
    expect(reopen).toHaveBeenCalledTimes(1);
    expect(reopen).toHaveBeenCalledWith(encoded.pack.packId);
    reopen.mockRestore();

    const inventory = await catalog.inventory();
    expect(inventory.packs).toHaveLength(1);
    expect(inventory.totalPackBytes).toBe(encoded.bytes.byteLength);
    expect(inventory.totalIndexEntries).toBe(1);
    expect(await catalog.readMultiPackIndexHint()).toMatchObject({
      kind: "rebuild",
    });
    expect(await catalog.readMultiPackIndexCache(inventory)).toMatchObject({
      kind: "rebuild",
    });

    const built = catalog.rebuildMultiPackIndex(inventory);
    await withAuthority(layout, (authority) =>
      catalog.publishMultiPackIndexCache(built, inventory, authority),
    );
    const cache = await catalog.readMultiPackIndexCache(inventory);
    expect(cache.kind).toBe("current");
    expect(await catalog.readMultiPackIndexHint()).toMatchObject({
      kind: "hint",
    });
    if (cache.kind === "current") {
      expect(cache.index.packs[0]?.packId).toBe(encoded.pack.packId);
    }
    await expect(catalog.inventoryStillCurrent(inventory)).resolves.toBe(true);
    await expect(
      catalog.packIdentityStillCurrent(inventory.packs[0]!),
    ).resolves.toBe(true);
    await expect(
      catalog.packReceiptStillCurrent(inventory.packs[0]!.identityReceipt),
    ).resolves.toBe(true);

    const handle = await catalog.openPack(encoded.pack.packId);
    expect(handle?.packId).toBe(encoded.pack.packId);
    expect(Object.keys(handle!.identityReceipt)).toEqual([]);
    await expect(
      catalog.packReceiptStillCurrent(handle!.identityReceipt),
    ).resolves.toBe(true);
    const contentId = contentIdFromBytes(
      Buffer.from("catalog publication", "utf8"),
    );
    const entry = handle?.lookup({ kind: "content", logicalId: contentId })[0];
    expect(entry).toBeDefined();
    const verified = await handle!.readVerified(entry!);
    expect(Buffer.from(verified).toString("utf8")).toBe("catalog publication");
    expect(verified.buffer.byteLength).toBe(entry!.length);
    await handle!.close();
    await handle!.close();
    await expect(
      catalog.packReceiptStillCurrent(handle!.identityReceipt),
    ).resolves.toBe(true);
    await expect(
      catalog.packReceiptStillCurrent(
        Object.freeze({}) as CatalogPackIdentityReceipt,
      ),
    ).rejects.toMatchObject({ code: "invalid-input" });
    await expect(handle!.readEnvelope(entry!)).rejects.toMatchObject({
      code: "invalid-input",
    });

    const replacement = join(layout.root, "replacement-pack");
    await writeFile(replacement, encoded.bytes);
    await rename(replacement, inventory.packs[0]!.path);
    await expect(catalog.inventoryStillCurrent(inventory)).resolves.toBe(false);
    await expect(
      catalog.packIdentityStillCurrent(inventory.packs[0]!),
    ).resolves.toBe(false);
  });

  it("treats corrupt and stale MIDX bytes only as a cache miss", async () => {
    const layout = await createLayout();
    const catalog = new PackCatalog(layout);
    const first = await dataPack("first pack");
    await withAuthority(layout, (authority) =>
      catalog.publishPack(first, authority),
    );
    const firstInventory = await catalog.inventory();
    await withAuthority(layout, (authority) =>
      catalog.publishMultiPackIndexCache(
        catalog.rebuildMultiPackIndex(firstInventory),
        firstInventory,
        authority,
      ),
    );

    await writeFile(layout.multiPackIndex, Buffer.from("corrupt cache"));
    await expect(catalog.readMultiPackIndexHint()).resolves.toMatchObject({
      kind: "rebuild",
      reason: "MIDX cache is corrupt",
    });
    await expect(
      catalog.readMultiPackIndexCache(firstInventory),
    ).resolves.toMatchObject({
      kind: "rebuild",
      reason: "MIDX cache is corrupt",
    });

    await withAuthority(layout, (authority) =>
      catalog.publishMultiPackIndexCache(
        catalog.rebuildMultiPackIndex(firstInventory),
        firstInventory,
        authority,
      ),
    );
    await withAuthority(layout, async (authority) => {
      await catalog.publishPack(await dataPack("second pack"), authority);
    });
    const currentInventory = await catalog.inventory();
    await expect(catalog.readMultiPackIndexHint()).resolves.toMatchObject({
      kind: "hint",
    });
    await expect(
      catalog.readMultiPackIndexCache(currentInventory),
    ).resolves.toMatchObject({ kind: "rebuild" });
  });

  it("retains a private-file read failure when closing it also fails", async () => {
    const layout = await createLayout();
    await writeFile(layout.multiPackIndex, "untrusted MIDX hint", {
      mode: 0o600,
    });
    const prototype = await fileHandlePrototype(layout.root);
    const originalStat = prototype.stat;
    const readFailure = new Error("injected post-read stat failure");
    const cleanupFailure = new Error("injected MIDX close failure");
    let statCalls = 0;
    let closeCalls = 0;
    vi.spyOn(prototype, "stat").mockImplementation(async function (
      this: FileHandle,
    ) {
      statCalls += 1;
      if (statCalls === 2) {
        const originalClose = this.close;
        Object.defineProperty(this, "close", {
          configurable: true,
          enumerable: true,
          writable: true,
          value: async (): Promise<void> => {
            closeCalls += 1;
            await originalClose.call(this);
            throw cleanupFailure;
          },
        });
        throw readFailure;
      }
      return await originalStat.call(this);
    });

    const failure = await rejected(
      new PackCatalog(layout).readMultiPackIndexHint(),
    );
    expect(failure).toMatchObject({
      name: "PackCatalogError",
      code: "storage-failure",
      cause: expect.any(AggregateError),
    });
    const aggregate = (failure as PackCatalogError).cause as AggregateError;
    expect(aggregate.errors).toEqual([readFailure, cleanupFailure]);
    expect(statCalls).toBe(2);
    expect(closeCalls).toBe(1);
  });

  it("requires an unforgeable encodePack publication receipt", async () => {
    const layout = await createLayout();
    const catalog = new PackCatalog(layout);
    const encoded = await dataPack("verified receipt");
    const forged: EncodedPack = {
      bytes: Uint8Array.from(encoded.bytes),
      pack: decodePack(encoded.bytes, encoded.pack.packId),
    };

    await expect(
      withAuthority(layout, (authority) =>
        catalog.publishPack(forged, authority),
      ),
    ).rejects.toMatchObject({
      code: "invalid-input",
    });
  });

  it("rejects publication bytes mutated after encoder verification", async () => {
    const layout = await createLayout();
    const catalog = new PackCatalog(layout);
    const encoded = await dataPack("mutable publication bytes");
    encoded.bytes[12] = (encoded.bytes[12] ?? 0) ^ 0xff;

    await expect(
      withAuthority(layout, (authority) =>
        catalog.publishPack(encoded, authority),
      ),
    ).rejects.toMatchObject({
      code: "invalid-input",
      cause: {
        code: "verification-required",
        message: expect.stringContaining("changed after encoder verification"),
      },
    });
    await expect(catalog.inventory()).resolves.toMatchObject({ packs: [] });
  });

  it("retains publication-view and receipt-cleanup failures without closing twice", async () => {
    const layout = await createLayout();
    const catalog = new PackCatalog(layout);
    const foreign = await dataPack("foreign authenticated view");
    const intended = await dataPack("intended authenticated view");
    await withAuthority(layout, (authority) =>
      catalog.publishPack(foreign, authority),
    );
    const foreignHandle = await catalog.openPack(foreign.pack.packId);
    if (foreignHandle === undefined) throw new Error("foreign pack missing");

    const cleanupFailure = new Error("injected receipt close failure");
    const originalClose = CatalogPackHandle.prototype.close;
    let closeCalls = 0;
    vi.spyOn(CatalogPackHandle.prototype, "close").mockImplementation(
      async function (this: CatalogPackHandle): Promise<void> {
        await originalClose.call(this);
        if (this === foreignHandle) {
          closeCalls += 1;
          throw cleanupFailure;
        }
      },
    );

    const openPack = vi
      .spyOn(catalog, "openPack")
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(foreignHandle);
    const failure = await rejected(
      withAuthority(layout, (authority) =>
        catalog.publishPack(intended, authority),
      ),
    );
    expect(failure).toMatchObject({
      code: "pack-integrity",
      message: expect.stringContaining("encoded publication view"),
      cause: expect.any(AggregateError),
    });
    const aggregate = (failure as PackCatalogError).cause as AggregateError;
    expect(aggregate.errors[0]).toMatchObject({
      name: "PackCatalogError",
      code: "pack-integrity",
    });
    expect(aggregate.errors[1]).toBe(cleanupFailure);
    expect(openPack).toHaveBeenCalledTimes(2);
    expect(closeCalls).toBe(1);
    openPack.mockRestore();

    const intendedHandle = await catalog.openPack(intended.pack.packId);
    expect(intendedHandle?.indexView()).toEqual(intended.pack.indexView());
    await intendedHandle?.close();
  });

  it("rejects an existing pack receipt that drifts during durable synchronization", async () => {
    const layout = await createLayout();
    const catalog = new PackCatalog(layout);
    const encoded = await dataPack("durability receipt fence");
    await withAuthority(layout, (authority) =>
      catalog.publishPack(encoded, authority),
    );

    const stillCurrent = vi
      .spyOn(catalog, "packReceiptStillCurrent")
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    await expect(
      withAuthority(layout, (authority) =>
        catalog.publishPack(encoded, authority),
      ),
    ).rejects.toMatchObject({
      code: "namespace-invalid",
      message: expect.stringContaining("during shard synchronization"),
    });
    expect(stillCurrent).toHaveBeenCalledTimes(2);
    stillCurrent.mockRestore();
  });

  it("allows only recognized bounded incoming crash residue", async () => {
    const layout = await createLayout();
    const catalog = new PackCatalog(layout);
    const encoded = await dataPack("orphaned incoming publication");
    const temporary = `.${encoded.pack.packId}.${process.pid}.${randomUUID()}.pack.tmp`;
    await writeFile(join(layout.incomingPacks, temporary), encoded.bytes, {
      mode: 0o600,
    });

    const inventory = await catalog.inventory();
    expect(inventory.incomingFiles).toBe(1);
    expect(inventory.incomingBytes).toBe(encoded.bytes.byteLength);
    expect(inventory.incoming[0]).toMatchObject({
      kind: "pack",
      name: temporary,
    });
    await expect(
      withAuthority(layout, (authority) =>
        catalog.removeIncoming({ ...inventory.incoming[0]! }, authority),
      ),
    ).rejects.toMatchObject({ code: "invalid-input" });
    await expect(
      withDisplacedAuthority(layout, (authority) =>
        catalog.removeIncoming(inventory.incoming[0]!, authority),
      ),
    ).rejects.toBeInstanceOf(WorkspaceLockOwnershipLostError);
    await expect(
      readFile(join(layout.incomingPacks, temporary)),
    ).resolves.toEqual(Buffer.from(encoded.bytes));
    await withAuthority(layout, (authority) =>
      catalog.removeIncoming(inventory.incoming[0]!, authority),
    );
    await expect(catalog.inventory()).resolves.toMatchObject({
      incomingFiles: 0,
      incomingBytes: 0,
    });
    await expect(
      withAuthority(layout, (authority) =>
        catalog.removeIncoming(inventory.incoming[0]!, authority),
      ),
    ).rejects.toMatchObject({ code: "namespace-invalid" });

    await writeFile(join(layout.incomingPacks, "foreign.tmp"), "unexpected");
    await expect(catalog.inventory()).rejects.toMatchObject({
      code: "namespace-invalid",
    });
  });

  it("removes only exact pack receipts and deliberately leaves MIDX stale", async () => {
    const layout = await createLayout();
    const catalog = new PackCatalog(layout);
    const encoded = await dataPack("garbage-collected pack");
    await withAuthority(layout, (authority) =>
      catalog.publishPack(encoded, authority),
    );
    const inventory = await catalog.inventory();
    const entry = inventory.packs[0]!;
    await withAuthority(layout, (authority) =>
      catalog.publishMultiPackIndexCache(
        catalog.rebuildMultiPackIndex(inventory),
        inventory,
        authority,
      ),
    );

    await expect(
      withAuthority(layout, (authority) =>
        catalog.removePack({ ...entry }, authority),
      ),
    ).rejects.toMatchObject({ code: "invalid-input" });
    await expect(
      withDisplacedAuthority(layout, (authority) =>
        catalog.removePack(entry, authority),
      ),
    ).rejects.toBeInstanceOf(WorkspaceLockOwnershipLostError);
    const retained = await catalog.openPack(encoded.pack.packId);
    expect(retained).toBeDefined();
    await retained!.close();
    await withAuthority(layout, (authority) =>
      catalog.removePack(entry, authority),
    );
    await expect(
      catalog.openPack(encoded.pack.packId),
    ).resolves.toBeUndefined();
    await expect(catalog.readMultiPackIndexHint()).resolves.toMatchObject({
      kind: "hint",
    });
    await expect(
      withAuthority(layout, (authority) =>
        catalog.removePack(entry, authority),
      ),
    ).rejects.toMatchObject({
      code: "namespace-invalid",
    });
  });

  it("rejects a pack receipt after its pack parent is replaced", async (context) => {
    context.skip(
      process.platform === "win32",
      "Windows does not allow renaming a directory that contains an open pack",
    );
    const layout = await createLayout();
    const catalog = new PackCatalog(layout);
    const encoded = await dataPack("parent-bound pack receipt");
    await withAuthority(layout, (authority) =>
      catalog.publishPack(encoded, authority),
    );
    const inventory = await catalog.inventory();
    const entry = inventory.packs[0]!;
    const handle = await catalog.openPack(encoded.pack.packId);
    const contentEntry = handle!.entries[0]!;
    const shard = encoded.pack.packId.slice(0, 2);
    const displaced = join(layout.root, `displaced-packs-${randomUUID()}`);

    await rename(layout.packs, displaced);
    await mkdir(layout.packs, { mode: 0o700 });
    await rename(join(displaced, "incoming"), layout.incomingPacks);
    await rename(join(displaced, shard), nativePackShardPath(layout, shard));

    await expect(catalog.packIdentityStillCurrent(entry)).resolves.toBe(false);
    await expect(
      catalog.packReceiptStillCurrent(entry.identityReceipt),
    ).resolves.toBe(false);
    await expect(
      withAuthority(layout, (authority) =>
        catalog.removePack(entry, authority),
      ),
    ).rejects.toMatchObject({
      code: "namespace-invalid",
      message: expect.stringContaining("parent changed"),
    });
    await expect(handle!.readEnvelope(contentEntry)).rejects.toMatchObject({
      code: "namespace-invalid",
      message: expect.stringContaining("parent changed"),
    });
    await expect(
      catalog.packReceiptStillCurrent(handle!.identityReceipt),
    ).resolves.toBe(false);
    await handle!.close();
    await expect(readFile(entry.path)).resolves.toEqual(
      Buffer.from(encoded.bytes),
    );
  });

  it("fails an open handle closed when its exact pack file is replaced", async (context) => {
    context.skip(
      process.platform === "win32",
      "Windows does not allow replacing an open pack",
    );
    const layout = await createLayout();
    const catalog = new PackCatalog(layout);
    const encoded = await dataPack("identity-bound handle");
    await withAuthority(layout, (authority) =>
      catalog.publishPack(encoded, authority),
    );
    const handle = await catalog.openPack(encoded.pack.packId);
    const entry = handle!.entries[0]!;

    const replacement = join(layout.root, "replacement-pack");
    await writeFile(replacement, encoded.bytes, { mode: 0o600 });
    await rename(replacement, nativePackPath(layout, encoded.pack.packId));

    await expect(handle!.readEnvelope(entry)).rejects.toMatchObject({
      code: "namespace-invalid",
      message: expect.stringContaining("changed"),
    });
    await expect(
      catalog.packReceiptStillCurrent(handle!.identityReceipt),
    ).resolves.toBe(false);
    await handle!.close();
  });

  it("normalizes stable payload corruption without misclassifying caller verification", async () => {
    const corruptLayout = await createLayout();
    const corrupt = await dataPack("payload integrity");
    const changed = Uint8Array.from(corrupt.bytes);
    const payload = Buffer.from("payload integrity", "utf8");
    const payloadOffset = Buffer.from(changed).indexOf(payload);
    expect(payloadOffset).toBeGreaterThanOrEqual(0);
    changed[payloadOffset] = (changed[payloadOffset] ?? 0) ^ 1;
    const resigned = resignPack(changed);
    const corruptId = parsePackId(resigned.packId);
    await mkdir(nativePackShardPath(corruptLayout, corruptId.slice(0, 2)), {
      mode: 0o700,
    });
    await writeFile(nativePackPath(corruptLayout, corruptId), resigned.bytes, {
      mode: 0o600,
    });
    const corruptCatalog = new PackCatalog(corruptLayout);
    const corruptHandle = await corruptCatalog.openPack(corruptId);
    try {
      await expect(
        corruptHandle!.readVerified(corruptHandle!.entries[0]!),
      ).rejects.toMatchObject({
        name: "PackCatalogError",
        code: "pack-integrity",
      });
    } finally {
      await corruptHandle!.close();
    }

    const metadataLayout = await createLayout();
    const metadata = Buffer.from("metadata verification", "utf8");
    const encodedMetadata = await encodePack(
      {
        packClass: "metadata",
        records: [
          {
            kind: "tree-root",
            encoding: "raw",
            logicalId: parseMetadataId(contentIdFromBytes(metadata)),
            decodedLength: metadata.byteLength,
            payload: metadata,
          },
        ],
      },
      { verifyMetadataId: () => true },
    );
    const metadataCatalog = new PackCatalog(metadataLayout);
    await withAuthority(metadataLayout, (authority) =>
      metadataCatalog.publishPack(encodedMetadata, authority),
    );
    const metadataHandle = await metadataCatalog.openPack(
      encodedMetadata.pack.packId,
    );
    try {
      await expect(
        metadataHandle!.readVerified(metadataHandle!.entries[0]!),
      ).rejects.toMatchObject({
        name: "PackCatalogError",
        code: "invalid-input",
        cause: { code: "verification-required" },
      });
    } finally {
      await metadataHandle!.close();
    }
  });

  it("retains a payload failure when post-read identity validation also fails", async (context) => {
    context.skip(
      process.platform === "win32",
      "Windows does not allow replacing an open pack",
    );
    const layout = await createLayout();
    const metadata = Buffer.from("dual read failure", "utf8");
    const encoded = await encodePack(
      {
        packClass: "metadata",
        records: [
          {
            kind: "tree-root",
            encoding: "raw",
            logicalId: parseMetadataId(contentIdFromBytes(metadata)),
            decodedLength: metadata.byteLength,
            payload: metadata,
          },
        ],
      },
      { verifyMetadataId: () => true },
    );
    const catalog = new PackCatalog(layout);
    await withAuthority(layout, (authority) =>
      catalog.publishPack(encoded, authority),
    );
    const handle = await catalog.openPack(encoded.pack.packId);
    if (handle === undefined) throw new Error("published pack is missing");
    const replacement = join(layout.root, "replacement-pack");
    await writeFile(replacement, encoded.bytes, { mode: 0o600 });

    const failure = await rejected(
      handle.readVerified(handle.entries[0]!, {
        verifyMetadataId: async () => {
          await rename(
            replacement,
            nativePackPath(layout, encoded.pack.packId),
          );
          return false;
        },
      }),
    );
    expect(failure).toMatchObject({
      name: "PackCatalogError",
      code: "pack-integrity",
      cause: expect.any(AggregateError),
    });
    const aggregate = (failure as PackCatalogError).cause as AggregateError;
    expect(aggregate.errors[0]).toBeInstanceOf(PackFormatError);
    expect(aggregate.errors[1]).toMatchObject({
      name: "PackCatalogError",
      code: "namespace-invalid",
    });
    await handle.close();
  });

  it("rejects an incoming receipt after its pack parent is replaced", async () => {
    const layout = await createLayout();
    const catalog = new PackCatalog(layout);
    const encoded = await dataPack("parent-bound incoming receipt");
    const temporary = `.${encoded.pack.packId}.${process.pid}.${randomUUID()}.pack.tmp`;
    const path = join(layout.incomingPacks, temporary);
    await writeFile(path, encoded.bytes, { mode: 0o600 });
    const inventory = await catalog.inventory();
    const entry = inventory.incoming[0]!;
    const displaced = join(layout.root, `displaced-packs-${randomUUID()}`);

    await rename(layout.packs, displaced);
    await mkdir(layout.packs, { mode: 0o700 });
    await rename(join(displaced, "incoming"), layout.incomingPacks);

    await expect(
      withAuthority(layout, (authority) =>
        catalog.removeIncoming(entry, authority),
      ),
    ).rejects.toMatchObject({
      code: "namespace-invalid",
      message: expect.stringContaining("parent changed"),
    });
    await expect(readFile(path)).resolves.toEqual(Buffer.from(encoded.bytes));
  });

  it("fails closed on foreign names and private-file violations", async () => {
    const foreignLayout = await createLayout();
    await writeFile(join(foreignLayout.packs, "foreign"), "unexpected");
    await expect(
      new PackCatalog(foreignLayout).inventory(),
    ).rejects.toMatchObject({ code: "namespace-invalid" });

    const linkedLayout = await createLayout();
    const encoded = await dataPack("linked pack");
    const source = join(linkedLayout.root, "outside-pack-namespace");
    await writeFile(source, encoded.bytes);
    const shard = encoded.pack.packId.slice(0, 2);
    await mkdir(nativePackShardPath(linkedLayout, shard), { mode: 0o700 });
    await link(source, nativePackPath(linkedLayout, encoded.pack.packId));
    await expect(
      new PackCatalog(linkedLayout).inventory(),
    ).rejects.toMatchObject({ code: "namespace-invalid" });
  });

  it("reports only an initial ENOENT as a missing pack", async () => {
    const layout = await createLayout();
    const catalog = new PackCatalog(layout);
    const absent = parsePackId("00".repeat(32));
    await expect(catalog.openPack(absent)).resolves.toBeUndefined();

    await writeFile(nativePackShardPath(layout, "00"), "not a directory");
    await expect(catalog.openPack(absent)).rejects.toMatchObject({
      code: "namespace-invalid",
    });
    await unlink(nativePackShardPath(layout, "00"));
    await mkdir(nativePackShardPath(layout, "00"), { mode: 0o700 });
    await writeFile(nativePackPath(layout, absent), "not a pack", {
      mode: 0o600,
    });
    await expect(catalog.openPack(absent)).rejects.toBeInstanceOf(
      PackCatalogError,
    );
  });

  it("does not close twice when authentication and its owned cleanup both fail", async () => {
    const layout = await createLayout();
    const packId = parsePackId("11".repeat(32));
    await mkdir(nativePackShardPath(layout, packId.slice(0, 2)), {
      mode: 0o700,
    });
    await writeFile(nativePackPath(layout, packId), "not a pack", {
      mode: 0o600,
    });
    const prototype = await fileHandlePrototype(layout.root);
    const cleanupFailure = new Error("injected authentication close failure");
    const originalStat = prototype.stat;
    let closeCalls = 0;
    let installed = false;
    vi.spyOn(prototype, "stat").mockImplementation(async function (
      this: FileHandle,
    ) {
      const observation = await originalStat.call(this);
      if (!installed) {
        installed = true;
        const originalClose = this.close;
        Object.defineProperty(this, "close", {
          configurable: true,
          enumerable: true,
          writable: true,
          value: async (): Promise<void> => {
            closeCalls += 1;
            await originalClose.call(this);
            throw cleanupFailure;
          },
        });
      }
      return observation;
    });

    const failure = await rejected(new PackCatalog(layout).openPack(packId));
    expect(failure).toMatchObject({
      name: "PackCatalogError",
      code: "pack-integrity",
      cause: expect.any(AggregateError),
    });
    const aggregate = (failure as PackCatalogError).cause as AggregateError;
    expect(aggregate.errors[0]).toBeInstanceOf(PackFormatError);
    expect(aggregate.errors[1]).toBe(cleanupFailure);
    expect(closeCalls).toBe(1);
  });

  it("enforces explicit pack, byte, entry, and incoming budgets", async () => {
    const layout = await createLayout();
    const encoded = await dataPack("bounded pack");
    const noPacks = new PackCatalog(layout, { maxPacks: 0 });
    await expect(
      withAuthority(layout, (authority) =>
        noPacks.publishPack(encoded, authority),
      ),
    ).rejects.toMatchObject({
      code: "limit-exceeded",
    });

    const incomingLimited = new PackCatalog(layout, { maxIncomingFiles: 0 });
    const temporary = `.${encoded.pack.packId}.${process.pid}.${randomUUID()}.pack.tmp`;
    await writeFile(join(layout.incomingPacks, temporary), encoded.bytes);
    await expect(incomingLimited.inventory()).rejects.toMatchObject({
      code: "limit-exceeded",
    });
    await unlink(join(layout.incomingPacks, temporary));
  });

  it("retains an inventory limit failure when pack cleanup also fails", async () => {
    const layout = await createLayout();
    const encoded = await dataPack("inventory cleanup evidence");
    await withAuthority(layout, (authority) =>
      new PackCatalog(layout).publishPack(encoded, authority),
    );

    const cleanupFailure = new Error("injected inventory close failure");
    const originalClose = CatalogPackHandle.prototype.close;
    let closeCalls = 0;
    vi.spyOn(CatalogPackHandle.prototype, "close").mockImplementation(
      async function (this: CatalogPackHandle): Promise<void> {
        closeCalls += 1;
        await originalClose.call(this);
        throw cleanupFailure;
      },
    );

    const failure = await rejected(
      new PackCatalog(layout, { maxTotalPackBytes: 0 }).inventory(),
    );
    expect(failure).toMatchObject({
      name: "PackCatalogError",
      code: "limit-exceeded",
      cause: expect.any(AggregateError),
    });
    const aggregate = (failure as PackCatalogError).cause as AggregateError;
    expect(aggregate.errors[0]).toMatchObject({
      name: "PackCatalogError",
      code: "limit-exceeded",
    });
    expect(aggregate.errors[1]).toBe(cleanupFailure);
    expect(closeCalls).toBe(1);
  });
});
