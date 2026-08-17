import {
  mkdtemp,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  contentIdFromBytes,
  idToBytes,
  parseMetadataId,
  recipeIdFromCanonicalBytes,
} from "../src/infrastructure/content-store/ids.ts";
import {
  CHUNKED_CONTENT_MIN_BYTES,
  MAX_RECIPE_OBJECT_BYTES,
} from "../src/infrastructure/content-store/chunk-recipe.ts";
import { chunkFastCdcV1 } from "../src/infrastructure/content-store/fastcdc.ts";
import { PackCatalog } from "../src/infrastructure/content-store/pack-catalog.ts";
import { PackHandlePool } from "../src/infrastructure/content-store/pack-handle-pool.ts";
import {
  encodePack,
  MAX_FULL_CONTENT_RECORD_BYTES,
} from "../src/infrastructure/content-store/pack.ts";
import {
  decodeRecord,
  encodeRecord,
} from "../src/infrastructure/content-store/record.ts";
import {
  ContentRepository,
  ContentRepositoryError,
} from "../src/infrastructure/content-store/repository.ts";
import type { RecordEnvelope } from "../src/infrastructure/content-store/record.ts";
import {
  nativeLooseRecordPath,
  nativeObjectLayout,
  nativeObjectPath,
  nativePackPath,
} from "../src/infrastructure/workspace-store.ts";
import {
  withWorkspaceLock,
  WorkspaceLockOwnershipLostError,
  type WorkspaceWriteAuthority,
} from "../src/infrastructure/workspace-lock.ts";

const roots: string[] = [];

async function withAuthority<T>(
  layout: ReturnType<typeof nativeObjectLayout>,
  action: (authority: WorkspaceWriteAuthority) => Promise<T>,
): Promise<T> {
  return await withWorkspaceLock(
    layout.root,
    "content repository test",
    action,
  );
}

async function withDisplacedAuthority<T>(
  layout: ReturnType<typeof nativeObjectLayout>,
  action: (authority: WorkspaceWriteAuthority) => Promise<T>,
): Promise<T> {
  return await withWorkspaceLock(
    layout.root,
    "content repository lost-authority test",
    async (authority) => {
      const lockPath = join(layout.root, "workspace.lock");
      const displaced = join(layout.root, "displaced-workspace-lock");
      await rename(lockPath, displaced);
      try {
        return await withWorkspaceLock(
          layout.root,
          "content repository successor test",
          async () => await action(authority),
        );
      } finally {
        await rename(displaced, lockPath);
      }
    },
  );
}

async function fileHandlePrototype(root: string): Promise<{
  readonly stat: FileHandle["stat"];
}> {
  const path = join(root, "file-handle-probe");
  const probe = await open(path, "w");
  const prototype = Object.getPrototypeOf(probe) as {
    readonly stat: FileHandle["stat"];
  };
  await probe.close();
  await unlink(path);
  return prototype;
}

function deterministicContent(length: number): Buffer {
  const bytes = Buffer.allocUnsafe(length);
  let state = 0x1234_5678;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

async function setupRepository(maxDecodedBytes = 2 * 1024 * 1024) {
  const root = await mkdtemp(join(tmpdir(), "cyclotomy-content-repository-"));
  roots.push(root);
  const layout = nativeObjectLayout(root);
  await Promise.all([
    mkdir(layout.blobs, { recursive: true }),
    mkdir(layout.trees, { recursive: true }),
    mkdir(layout.contentRecords, { recursive: true }),
    mkdir(layout.recipeRecords, { recursive: true }),
    mkdir(layout.incomingPacks, { recursive: true }),
  ]);
  return {
    layout,
    repository: new ContentRepository(layout, { maxDecodedBytes }),
  };
}

async function collect(
  repository: ContentRepository,
  contentId: string,
  maximumBytes: number,
): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  await repository.streamContent(contentId, maximumBytes, async (chunk) => {
    chunks.push(Uint8Array.from(chunk));
  });
  return Buffer.concat(chunks);
}

async function publishPackFile(
  layout: ReturnType<typeof nativeObjectLayout>,
  publication: Awaited<ReturnType<typeof encodePack>>,
): Promise<void> {
  await mkdir(join(layout.packs, publication.pack.packId.slice(0, 2)), {
    recursive: true,
  });
  await writeFile(
    nativePackPath(layout, publication.pack.packId),
    publication.bytes,
  );
}

async function publishCurrentMultiPackIndex(
  layout: ReturnType<typeof nativeObjectLayout>,
): Promise<void> {
  const catalog = new PackCatalog(layout);
  const inventory = await catalog.inventory();
  await withAuthority(layout, (authority) =>
    catalog.publishMultiPackIndexCache(
      catalog.rebuildMultiPackIndex(inventory),
      inventory,
      authority,
    ),
  );
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("content repository", () => {
  it("checks materialization authority before its first loose write", async () => {
    const { layout, repository } = await setupRepository();
    const bytes = Buffer.from("legacy materialization authority", "utf8");
    const contentId = contentIdFromBytes(bytes);
    await expect(
      withDisplacedAuthority(layout, (authority) =>
        repository.materializeLooseContent(
          contentId,
          bytes.byteLength,
          async (sink) => sink(bytes),
          authority,
        ),
      ),
    ).rejects.toBeInstanceOf(WorkspaceLockOwnershipLostError);
    expect(await readdir(layout.contentRecords)).toEqual([]);
    expect(await readdir(layout.recipeRecords)).toEqual([]);
  });

  it("retains a classified stream failure when private-file cleanup also fails", async () => {
    const { layout, repository } = await setupRepository();
    const bytes = Buffer.from("repository cleanup evidence", "utf8");
    const contentId = contentIdFromBytes(bytes);
    const path = nativeObjectPath(layout, "blob", contentId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { mode: 0o600 });

    const prototype = await fileHandlePrototype(layout.root);
    const originalStat = prototype.stat;
    const primary = new ContentRepositoryError(
      "object-integrity",
      "injected content sink failure",
    );
    const cleanup = new Error("injected private-file close failure");
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
            throw cleanup;
          },
        });
      }
      return observation;
    });

    let failure: unknown;
    try {
      await repository.streamContent(contentId, bytes.byteLength, async () => {
        throw primary;
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      name: "ContentRepositoryError",
      code: "object-integrity",
      cause: expect.any(AggregateError),
    });
    const aggregate = (failure as ContentRepositoryError)
      .cause as AggregateError;
    expect(aggregate.errors).toEqual([primary, cleanup]);
    expect(closeCalls).toBe(1);
  });

  it("publishes new small content as a loose record and seals reusable proofs", async () => {
    const { layout, repository } = await setupRepository();
    const bytes = Buffer.from("one logical observation", "utf8");
    const contentId = contentIdFromBytes(bytes);

    const first = await repository.ensureRawContent(contentId, bytes);
    expect(
      await readFile(nativeLooseRecordPath(layout, "content", contentId)),
    ).not.toHaveLength(0);
    await expect(
      readFile(nativeObjectPath(layout, "blob", contentId)),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      repository.revalidatePublishedContent(first, bytes.byteLength),
    ).resolves.toBeUndefined();

    const reused = await repository.publishContentFromStream(
      contentId,
      bytes.byteLength,
      async () => {
        throw new Error(
          "an existing representation must not reopen the source",
        );
      },
    );
    await expect(
      repository.revalidatePublishedContent(reused, bytes.byteLength),
    ).resolves.toBeUndefined();
    let sourceReads = 0;
    const sourceVerified = await repository.publishContentFromStream(
      contentId,
      bytes.byteLength,
      async (sink) => {
        sourceReads += 1;
        await sink(bytes);
      },
      { authenticateSource: true },
    );
    expect(sourceReads).toBe(1);
    await expect(
      repository.revalidatePublishedContent(sourceVerified, bytes.byteLength),
    ).resolves.toBeUndefined();
    await expect(
      repository.publishContentFromStream(
        contentId,
        bytes.byteLength,
        async (sink) => sink(Buffer.alloc(bytes.byteLength, 0x78)),
        { authenticateSource: true },
      ),
    ).rejects.toMatchObject({ code: "object-integrity" });
    const sourceFailure = new Error("source unavailable");
    await expect(
      repository.publishContentFromStream(
        contentId,
        bytes.byteLength,
        async () => {
          throw sourceFailure;
        },
        { authenticateSource: true },
      ),
    ).rejects.toBe(sourceFailure);
    let classifiedSourceReads = 0;
    const classifiedSourceFailure = new ContentRepositoryError(
      "missing-object",
      "source object disappeared",
    );
    await expect(
      repository.publishContentFromStream(
        contentId,
        bytes.byteLength,
        async () => {
          classifiedSourceReads += 1;
          throw classifiedSourceFailure;
        },
        { authenticateSource: true },
      ),
    ).rejects.toBe(classifiedSourceFailure);
    expect(classifiedSourceReads).toBe(1);
    expect(await collect(repository, contentId, bytes.byteLength)).toEqual(
      bytes,
    );

    await writeFile(
      nativeLooseRecordPath(layout, "content", contentId),
      Buffer.from("damaged", "utf8"),
    );
    await expect(
      repository.revalidatePublishedContent(reused, bytes.byteLength),
    ).rejects.toMatchObject({ code: "object-integrity" });
  });

  it("uses a one-chunk FastCDC candidate as its full root without recipe orphans", async () => {
    const { layout, repository } = await setupRepository();
    const bytes = Buffer.alloc(96 * 1024);
    expect(chunkFastCdcV1(bytes)).toEqual([
      { offset: 0, length: bytes.byteLength },
    ]);
    const contentId = contentIdFromBytes(bytes);

    await repository.publishContentFromStream(
      contentId,
      bytes.byteLength,
      async (sink) => {
        await sink(bytes.subarray(0, 31 * 1024));
        await sink(bytes.subarray(31 * 1024));
      },
    );

    const record = decodeRecord(
      await readFile(nativeLooseRecordPath(layout, "content", contentId)),
      {
        maxDecodedBytes: bytes.byteLength,
        maxPayloadBytes: 512 * 1024,
      },
    );
    expect(record.encoding).not.toBe("chunked-v1");
    expect(await readdir(layout.recipeRecords)).toEqual([]);
    expect(await collect(repository, contentId, bytes.byteLength)).toEqual(
      bytes,
    );
  });

  it("classifies short and long chunked sources as object-integrity failures", async () => {
    const bytes = deterministicContent(CHUNKED_CONTENT_MIN_BYTES + 64 * 1024);
    const contentId = contentIdFromBytes(bytes);
    const sources = [
      async (sink: (chunk: Uint8Array) => Promise<void>): Promise<void> => {
        await sink(bytes.subarray(0, bytes.byteLength - 1));
      },
      async (sink: (chunk: Uint8Array) => Promise<void>): Promise<void> => {
        await sink(bytes);
        await sink(Uint8Array.of(0));
      },
    ];

    for (const source of sources) {
      const { repository } = await setupRepository();
      let failure: unknown;
      try {
        await repository.publishContentFromStream(
          contentId,
          bytes.byteLength,
          source,
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ContentRepositoryError);
      expect(failure).not.toBeInstanceOf(RangeError);
      expect(failure).toMatchObject({ code: "object-integrity" });
    }
  });

  it("streams a chunked loose representation and fails closed on existing damage", async () => {
    const { layout, repository } = await setupRepository();
    const bytes = Buffer.alloc(400 * 1024);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = (index * 31 + Math.floor(index / 997)) & 0xff;
    }
    const contentId = contentIdFromBytes(bytes);
    await repository.publishContentFromStream(
      contentId,
      bytes.byteLength,
      async (sink) => {
        for (let offset = 0; offset < bytes.length; offset += 37 * 1024) {
          await sink(bytes.subarray(offset, offset + 37 * 1024));
        }
      },
    );
    expect(await collect(repository, contentId, bytes.byteLength)).toEqual(
      bytes,
    );

    await writeFile(
      nativeLooseRecordPath(layout, "content", contentId),
      Buffer.from("damaged", "utf8"),
    );
    await expect(
      collect(repository, contentId, bytes.byteLength),
    ).rejects.toBeInstanceOf(ContentRepositoryError);
  });

  it("coalesces concurrent publication of the same chunk graph", async () => {
    const { layout, repository } = await setupRepository();
    const bytes = deterministicContent(400 * 1024);
    const contentId = contentIdFromBytes(bytes);
    let startedSources = 0;
    let releaseSources!: () => void;
    const bothSourcesStarted = new Promise<void>((resolve) => {
      releaseSources = resolve;
    });
    const source = async (
      sink: (chunk: Uint8Array) => Promise<void>,
    ): Promise<void> => {
      startedSources += 1;
      if (startedSources === 2) releaseSources();
      await bothSourcesStarted;
      for (let offset = 0; offset < bytes.byteLength; offset += 37 * 1024) {
        await sink(bytes.subarray(offset, offset + 37 * 1024));
      }
    };

    const [left, right] = await Promise.all([
      repository.publishContentFromStream(contentId, bytes.byteLength, source),
      repository.publishContentFromStream(contentId, bytes.byteLength, source),
    ]);

    expect(startedSources).toBe(2);
    await expect(
      repository.revalidatePublishedContent(left, bytes.byteLength),
    ).resolves.toBeUndefined();
    await expect(
      repository.revalidatePublishedContent(right, bytes.byteLength),
    ).resolves.toBeUndefined();
    expect(await collect(repository, contentId, bytes.byteLength)).toEqual(
      bytes,
    );
    for (const namespace of [layout.contentRecords, layout.recipeRecords]) {
      for (const shard of await readdir(namespace)) {
        expect(await readdir(join(namespace, shard))).not.toContainEqual(
          expect.stringContaining(".tmp"),
        );
      }
    }
  });

  it("classifies a valid loose record above the caller limit as limit-exceeded", async () => {
    const { layout, repository } = await setupRepository();
    const bytes = Buffer.alloc(96 * 1024, 0x61);
    const contentId = contentIdFromBytes(bytes);
    await repository.ensureRawContent(contentId, bytes);
    expect(
      await readFile(nativeLooseRecordPath(layout, "content", contentId)),
    ).not.toHaveLength(0);

    await expect(
      repository.streamContent(
        contentId,
        bytes.byteLength - 1,
        async () => undefined,
      ),
    ).rejects.toMatchObject({ code: "limit-exceeded" });
  });

  it("rejects canonical loose records outside the durable representation policy", async () => {
    const { layout, repository } = await setupRepository(2 * 1024 * 1024);
    const publishFixture = async (
      kind: "content" | "recipe",
      logicalId: string,
      record: RecordEnvelope,
    ): Promise<void> => {
      const path = nativeLooseRecordPath(layout, kind, logicalId);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, encodeRecord(record));
    };

    const oversized = Buffer.alloc(MAX_FULL_CONTENT_RECORD_BYTES + 1, 0x41);
    const oversizedId = contentIdFromBytes(oversized);
    await publishFixture("content", oversizedId, {
      kind: "content",
      encoding: "raw",
      logicalId: oversizedId,
      decodedLength: oversized.byteLength,
      payload: oversized,
    });
    await expect(
      repository.streamContent(
        oversizedId,
        oversized.byteLength,
        async () => undefined,
      ),
    ).rejects.toMatchObject({ code: "object-integrity" });

    const recipeId = recipeIdFromCanonicalBytes(Buffer.from("recipe"));
    const undersizedChunkedId = contentIdFromBytes(
      Buffer.from("undersized chunked root"),
    );
    await publishFixture("content", undersizedChunkedId, {
      kind: "content",
      encoding: "chunked-v1",
      logicalId: undersizedChunkedId,
      decodedLength: CHUNKED_CONTENT_MIN_BYTES - 1,
      payload: idToBytes(recipeId),
    });
    await expect(
      repository.streamContent(
        undersizedChunkedId,
        CHUNKED_CONTENT_MIN_BYTES,
        async () => undefined,
      ),
    ).rejects.toMatchObject({ code: "object-integrity" });

    const oversizedRecipe = Buffer.alloc(MAX_RECIPE_OBJECT_BYTES + 1, 0x42);
    const oversizedRecipeId = recipeIdFromCanonicalBytes(oversizedRecipe);
    await publishFixture("recipe", oversizedRecipeId, {
      kind: "recipe",
      encoding: "raw",
      logicalId: oversizedRecipeId,
      decodedLength: oversizedRecipe.byteLength,
      payload: oversizedRecipe,
    });
    const contentId = contentIdFromBytes(Buffer.from("chunked recipe owner"));
    await publishFixture("content", contentId, {
      kind: "content",
      encoding: "chunked-v1",
      logicalId: contentId,
      decodedLength: CHUNKED_CONTENT_MIN_BYTES,
      payload: idToBytes(oversizedRecipeId),
    });
    await expect(
      repository.streamContent(
        contentId,
        CHUNKED_CONTENT_MIN_BYTES,
        async () => undefined,
      ),
    ).rejects.toMatchObject({ code: "object-integrity" });
  });

  it("falls through true absence to authenticated data and metadata packs", async () => {
    const { layout, repository } = await setupRepository();
    const content = Buffer.from("packed content", "utf8");
    const contentId = contentIdFromBytes(content);
    const contentRecord: RecordEnvelope = {
      kind: "content",
      encoding: "raw",
      logicalId: contentId,
      decodedLength: content.byteLength,
      payload: content,
    };
    const dataPack = await encodePack({
      packClass: "data",
      records: [contentRecord],
    });
    const dataPath = nativePackPath(layout, dataPack.pack.packId);
    await mkdir(join(layout.packs, dataPack.pack.packId.slice(0, 2)), {
      recursive: true,
    });
    await writeFile(dataPath, dataPack.bytes);

    const structure = Buffer.from("canonical structure\n", "utf8");
    const structureId = parseMetadataId(contentIdFromBytes(structure));
    const structureRecord: RecordEnvelope = {
      kind: "tree-node",
      encoding: "raw",
      logicalId: structureId,
      decodedLength: structure.byteLength,
      payload: structure,
    };
    const metadataPack = await encodePack(
      { packClass: "metadata", records: [structureRecord] },
      {
        verifyMetadataId: (_kind, id, bytes) =>
          String(id) === String(contentIdFromBytes(bytes)),
      },
    );
    const metadataPath = nativePackPath(layout, metadataPack.pack.packId);
    await mkdir(join(layout.packs, metadataPack.pack.packId.slice(0, 2)), {
      recursive: true,
    });
    await writeFile(metadataPath, metadataPack.bytes);

    expect(await collect(repository, contentId, content.byteLength)).toEqual(
      content,
    );
    expect(
      Buffer.from(
        await repository.readStructural(
          "node",
          structureId,
          structure.byteLength,
        ),
      ),
    ).toEqual(structure);
    await repository.publishStructural("node", structureId, structure);
    await expect(
      readFile(nativeObjectPath(layout, "tree", structureId)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not fall through a corrupt legacy blob to a valid pack", async () => {
    const { layout, repository } = await setupRepository();
    const content = Buffer.from("valid packed bytes", "utf8");
    const contentId = contentIdFromBytes(content);
    const packed = await encodePack({
      packClass: "data",
      records: [
        {
          kind: "content",
          encoding: "raw",
          logicalId: contentId,
          decodedLength: content.byteLength,
          payload: content,
        },
      ],
    });
    await mkdir(join(layout.packs, packed.pack.packId.slice(0, 2)), {
      recursive: true,
    });
    await writeFile(nativePackPath(layout, packed.pack.packId), packed.bytes);
    await mkdir(join(layout.blobs, contentId.slice(0, 2)), { recursive: true });
    await writeFile(
      nativeObjectPath(layout, "blob", contentId),
      Buffer.from("corrupt", "utf8"),
    );

    await expect(
      collect(repository, contentId, content.byteLength),
    ).rejects.toMatchObject({ code: "object-integrity" });
  });

  it("does not fall through a corrupt loose record to a valid pack", async () => {
    const { layout, repository } = await setupRepository();
    const content = Buffer.from("valid packed bytes", "utf8");
    const contentId = contentIdFromBytes(content);
    const packed = await encodePack({
      packClass: "data",
      records: [
        {
          kind: "content",
          encoding: "raw",
          logicalId: contentId,
          decodedLength: content.byteLength,
          payload: content,
        },
      ],
    });
    await mkdir(join(layout.packs, packed.pack.packId.slice(0, 2)), {
      recursive: true,
    });
    await writeFile(nativePackPath(layout, packed.pack.packId), packed.bytes);
    await mkdir(join(layout.contentRecords, contentId.slice(0, 2)), {
      recursive: true,
    });
    await writeFile(
      nativeLooseRecordPath(layout, "content", contentId),
      Buffer.from("corrupt", "utf8"),
    );

    await expect(
      collect(repository, contentId, content.byteLength),
    ).rejects.toMatchObject({ code: "object-integrity" });
  });

  it("uses a valid MIDX hint without inventorying or opening unrelated packs", async () => {
    const { layout, repository } = await setupRepository();
    const target = Buffer.from("hint target", "utf8");
    const targetId = contentIdFromBytes(target);
    const targetPack = await encodePack({
      packClass: "data",
      records: [
        {
          kind: "content",
          encoding: "raw",
          logicalId: targetId,
          decodedLength: target.byteLength,
          payload: target,
        },
      ],
    });
    const unrelated = Buffer.from("unrelated packed content", "utf8");
    const unrelatedPack = await encodePack({
      packClass: "data",
      records: [
        {
          kind: "content",
          encoding: "raw",
          logicalId: contentIdFromBytes(unrelated),
          decodedLength: unrelated.byteLength,
          payload: unrelated,
        },
      ],
    });
    await publishPackFile(layout, targetPack);
    await publishPackFile(layout, unrelatedPack);
    await publishCurrentMultiPackIndex(layout);

    const inventory = vi.spyOn(PackCatalog.prototype, "inventory");
    const openPack = vi.spyOn(PackCatalog.prototype, "openPack");
    expect(await collect(repository, targetId, target.byteLength)).toEqual(
      target,
    );
    expect(inventory).not.toHaveBeenCalled();
    expect(openPack.mock.calls.map(([packId]) => packId)).toEqual([
      targetPack.pack.packId,
    ]);
  });

  it("shares one MIDX read and one authenticated read per pack within an operation scope", async () => {
    const { layout, repository } = await setupRepository();
    const contents = [
      Buffer.from("first packed operation content", "utf8"),
      Buffer.from("second packed operation content", "utf8"),
    ];
    const dataPack = await encodePack({
      packClass: "data",
      records: contents.map((bytes) => ({
        kind: "content" as const,
        encoding: "raw" as const,
        logicalId: contentIdFromBytes(bytes),
        decodedLength: bytes.byteLength,
        payload: bytes,
      })),
    });
    const structures = [
      Buffer.from("first packed operation node", "utf8"),
      Buffer.from("second packed operation node", "utf8"),
      Buffer.from("third packed operation node", "utf8"),
    ];
    const metadataPack = await encodePack(
      {
        packClass: "metadata",
        records: structures.map((bytes) => ({
          kind: "tree-node" as const,
          encoding: "raw" as const,
          logicalId: parseMetadataId(contentIdFromBytes(bytes)),
          decodedLength: bytes.byteLength,
          payload: bytes,
        })),
      },
      {
        verifyMetadataId: (_kind, logicalId, bytes) =>
          String(logicalId) === String(contentIdFromBytes(bytes)),
      },
    );
    await publishPackFile(layout, dataPack);
    await publishPackFile(layout, metadataPack);
    await publishCurrentMultiPackIndex(layout);

    const readHint = vi.spyOn(PackCatalog.prototype, "readMultiPackIndexHint");
    const openPack = vi.spyOn(PackCatalog.prototype, "openPack");
    const scope = repository.openResolutionScope();
    try {
      await Promise.all([
        ...contents.map((bytes) =>
          repository.streamContent(
            contentIdFromBytes(bytes),
            bytes.byteLength,
            async () => undefined,
            scope,
          ),
        ),
        ...structures.map((bytes) =>
          repository.readStructural(
            "node",
            contentIdFromBytes(bytes),
            bytes.byteLength,
            scope,
          ),
        ),
      ]);
    } finally {
      await repository.closeResolutionScope(scope);
    }

    expect(readHint).toHaveBeenCalledTimes(1);
    expect(
      openPack.mock.calls.filter(([packId]) => packId === dataPack.pack.packId),
    ).toHaveLength(1);
    expect(
      openPack.mock.calls.filter(
        ([packId]) => packId === metadataPack.pack.packId,
      ),
    ).toHaveLength(1);

    await repository.streamContent(
      contentIdFromBytes(contents[0]!),
      contents[0]!.byteLength,
      async () => undefined,
    );
    expect(
      openPack.mock.calls.filter(([packId]) => packId === dataPack.pack.packId),
    ).toHaveLength(2);
  });

  it("preserves transient resolution and handle-cleanup failures", async () => {
    const { layout, repository } = await setupRepository();
    const bytes = Buffer.from("transient scope failure", "utf8");
    const contentId = contentIdFromBytes(bytes);
    const publication = await encodePack({
      packClass: "data",
      records: [
        {
          kind: "content",
          encoding: "raw",
          logicalId: contentId,
          decodedLength: bytes.byteLength,
          payload: bytes,
        },
      ],
    });
    await publishPackFile(layout, publication);
    await publishCurrentMultiPackIndex(layout);
    const primary = new Error("content sink failed");
    const cleanup = new Error("handle close failed");
    const originalClose = PackHandlePool.prototype.close;
    vi.spyOn(PackHandlePool.prototype, "close").mockImplementation(
      async function (this: PackHandlePool): Promise<void> {
        await originalClose.call(this);
        throw cleanup;
      },
    );

    let observed: unknown;
    try {
      await repository.streamContent(contentId, bytes.byteLength, async () => {
        throw primary;
      });
    } catch (error) {
      observed = error;
    }

    expect(observed).toBeInstanceOf(AggregateError);
    expect((observed as AggregateError).errors).toEqual([primary, cleanup]);
  });

  it("rebuilds an absent or corrupt MIDX cache before resolving a pack", async () => {
    const { layout, repository } = await setupRepository();
    const bytes = Buffer.from("inventory fallback", "utf8");
    const contentId = contentIdFromBytes(bytes);
    const packed = await encodePack({
      packClass: "data",
      records: [
        {
          kind: "content",
          encoding: "raw",
          logicalId: contentId,
          decodedLength: bytes.byteLength,
          payload: bytes,
        },
      ],
    });
    await publishPackFile(layout, packed);
    const inventory = vi.spyOn(PackCatalog.prototype, "inventory");

    expect(await collect(repository, contentId, bytes.byteLength)).toEqual(
      bytes,
    );
    expect(inventory).toHaveBeenCalledTimes(1);

    inventory.mockClear();
    await writeFile(
      layout.multiPackIndex,
      Buffer.from("corrupt cache", "utf8"),
    );
    expect(await collect(repository, contentId, bytes.byteLength)).toEqual(
      bytes,
    );
    expect(inventory).toHaveBeenCalledTimes(1);
  });

  it("fails closed on any corrupt pack encountered by a required inventory", async () => {
    const { layout, repository } = await setupRepository();
    const bytes = Buffer.from("valid inventory target", "utf8");
    const contentId = contentIdFromBytes(bytes);
    const packed = await encodePack({
      packClass: "data",
      records: [
        {
          kind: "content",
          encoding: "raw",
          logicalId: contentId,
          decodedLength: bytes.byteLength,
          payload: bytes,
        },
      ],
    });
    await publishPackFile(layout, packed);
    const corruptPackId = "00".repeat(32);
    await mkdir(join(layout.packs, corruptPackId.slice(0, 2)), {
      recursive: true,
    });
    await writeFile(
      nativePackPath(layout, corruptPackId),
      Buffer.from("corrupt unrelated pack", "utf8"),
    );

    await expect(
      collect(repository, contentId, bytes.byteLength),
    ).rejects.toMatchObject({ code: "object-integrity" });
  });

  it("does not fence an unrelated inventory drift after an exact pack hit", async () => {
    const { layout, repository } = await setupRepository();
    const bytes = Buffer.from("bounded inventory retry", "utf8");
    const contentId = contentIdFromBytes(bytes);
    const packed = await encodePack({
      packClass: "data",
      records: [
        {
          kind: "content",
          encoding: "raw",
          logicalId: contentId,
          decodedLength: bytes.byteLength,
          payload: bytes,
        },
      ],
    });
    await publishPackFile(layout, packed);
    const inventory = vi.spyOn(PackCatalog.prototype, "inventory");
    const inventoryStillCurrent = vi
      .spyOn(PackCatalog.prototype, "inventoryStillCurrent")
      .mockResolvedValueOnce(false);

    expect(await collect(repository, contentId, bytes.byteLength)).toEqual(
      bytes,
    );
    expect(inventory).toHaveBeenCalledTimes(1);
    expect(inventoryStillCurrent).not.toHaveBeenCalled();
  });

  it("finds a crash-published pack after an old hint reports a miss", async () => {
    const { layout, repository } = await setupRepository();
    const oldBytes = Buffer.from("old indexed content", "utf8");
    const oldPack = await encodePack({
      packClass: "data",
      records: [
        {
          kind: "content",
          encoding: "raw",
          logicalId: contentIdFromBytes(oldBytes),
          decodedLength: oldBytes.byteLength,
          payload: oldBytes,
        },
      ],
    });
    await publishPackFile(layout, oldPack);
    await publishCurrentMultiPackIndex(layout);

    const appeared = Buffer.from("published after the MIDX", "utf8");
    const appearedId = contentIdFromBytes(appeared);
    const appearedPack = await encodePack({
      packClass: "data",
      records: [
        {
          kind: "content",
          encoding: "raw",
          logicalId: appearedId,
          decodedLength: appeared.byteLength,
          payload: appeared,
        },
      ],
    });
    await publishPackFile(layout, appearedPack);
    const inventory = vi.spyOn(PackCatalog.prototype, "inventory");

    expect(await collect(repository, appearedId, appeared.byteLength)).toEqual(
      appeared,
    );
    expect(inventory).toHaveBeenCalledTimes(1);
  });

  it("rebuilds when a hinted pack disappeared and uses its replacement", async () => {
    const { layout, repository } = await setupRepository();
    const target = Buffer.from("repacked target", "utf8");
    const targetId = contentIdFromBytes(target);
    const original = await encodePack({
      packClass: "data",
      records: [
        {
          kind: "content",
          encoding: "raw",
          logicalId: targetId,
          decodedLength: target.byteLength,
          payload: target,
        },
      ],
    });
    await publishPackFile(layout, original);
    await publishCurrentMultiPackIndex(layout);
    await unlink(nativePackPath(layout, original.pack.packId));

    const companion = Buffer.from("forces a new pack identity", "utf8");
    const replacement = await encodePack({
      packClass: "data",
      records: [
        {
          kind: "content",
          encoding: "raw",
          logicalId: targetId,
          decodedLength: target.byteLength,
          payload: target,
        },
        {
          kind: "content",
          encoding: "raw",
          logicalId: contentIdFromBytes(companion),
          decodedLength: companion.byteLength,
          payload: companion,
        },
      ],
    });
    await publishPackFile(layout, replacement);
    const inventory = vi.spyOn(PackCatalog.prototype, "inventory");

    expect(await collect(repository, targetId, target.byteLength)).toEqual(
      target,
    );
    expect(inventory).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the pack selected by a valid hint is corrupt", async () => {
    const { layout, repository } = await setupRepository();
    const bytes = Buffer.from("candidate integrity", "utf8");
    const contentId = contentIdFromBytes(bytes);
    const packed = await encodePack({
      packClass: "data",
      records: [
        {
          kind: "content",
          encoding: "raw",
          logicalId: contentId,
          decodedLength: bytes.byteLength,
          payload: bytes,
        },
      ],
    });
    await publishPackFile(layout, packed);
    await publishCurrentMultiPackIndex(layout);
    await writeFile(
      nativePackPath(layout, packed.pack.packId),
      Buffer.from("corrupt pack", "utf8"),
    );
    const inventory = vi.spyOn(PackCatalog.prototype, "inventory");

    await expect(
      collect(repository, contentId, bytes.byteLength),
    ).rejects.toMatchObject({ code: "object-integrity" });
    expect(inventory).not.toHaveBeenCalled();
  });

  it("does not bind publication proofs to the rebuildable MIDX cache", async () => {
    const { layout, repository } = await setupRepository();
    const bytes = Buffer.from("pack-backed publication proof", "utf8");
    const contentId = contentIdFromBytes(bytes);
    const packed = await encodePack({
      packClass: "data",
      records: [
        {
          kind: "content",
          encoding: "raw",
          logicalId: contentId,
          decodedLength: bytes.byteLength,
          payload: bytes,
        },
      ],
    });
    await publishPackFile(layout, packed);
    await publishCurrentMultiPackIndex(layout);
    const proof = await repository.publishContentFromStream(
      contentId,
      bytes.byteLength,
      async () => {
        throw new Error("an existing pack must avoid its source");
      },
    );

    await writeFile(layout.multiPackIndex, Buffer.from("replacement", "utf8"));
    const inventory = vi.spyOn(PackCatalog.prototype, "inventory");
    const openPack = vi.spyOn(PackCatalog.prototype, "openPack");
    await expect(
      repository.revalidatePublishedContent(proof, bytes.byteLength),
    ).resolves.toBeUndefined();
    expect(inventory).not.toHaveBeenCalled();
    expect(openPack).not.toHaveBeenCalled();
  });

  it("fully reauthenticates a proof after its selected pack is replaced", async () => {
    const { layout, repository } = await setupRepository();
    const bytes = Buffer.from("pack replacement proof", "utf8");
    const contentId = contentIdFromBytes(bytes);
    const packed = await encodePack({
      packClass: "data",
      records: [
        {
          kind: "content",
          encoding: "raw",
          logicalId: contentId,
          decodedLength: bytes.byteLength,
          payload: bytes,
        },
      ],
    });
    await publishPackFile(layout, packed);
    await publishCurrentMultiPackIndex(layout);
    const proof = await repository.publishContentFromStream(
      contentId,
      bytes.byteLength,
      async () => undefined,
    );
    await writeFile(
      nativePackPath(layout, packed.pack.packId),
      Buffer.from("corrupt replacement", "utf8"),
    );

    await expect(
      repository.revalidatePublishedContent(proof, bytes.byteLength),
    ).rejects.toMatchObject({ code: "object-integrity" });
  });

  it("materializes large legacy content as a chunked loose representation", async () => {
    const { layout, repository } = await setupRepository();
    const bytes = Buffer.alloc(400 * 1024);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = (index * 17 + Math.floor(index / 613)) & 0xff;
    }
    const contentId = contentIdFromBytes(bytes);
    await mkdir(join(layout.blobs, contentId.slice(0, 2)), { recursive: true });
    await writeFile(nativeObjectPath(layout, "blob", contentId), bytes);

    const proof = await withAuthority(layout, (authority) =>
      repository.materializeLooseContent(
        contentId,
        bytes.byteLength,
        async (sink) => sink(bytes),
        authority,
      ),
    );
    const record = decodeRecord(
      await readFile(nativeLooseRecordPath(layout, "content", contentId)),
      {
        maxDecodedBytes: bytes.byteLength,
        maxPayloadBytes: 512 * 1024,
      },
    );
    expect(record.encoding).toBe("chunked-v1");
    await expect(
      repository.revalidatePublishedContent(proof, bytes.byteLength),
    ).resolves.toBeUndefined();
  });

  it("materializes loose content even when a packed representation exists", async () => {
    const { layout, repository } = await setupRepository();
    const bytes = Buffer.from("packed source for loose migration", "utf8");
    const contentId = contentIdFromBytes(bytes);
    const packed = await encodePack({
      packClass: "data",
      records: [
        {
          kind: "content",
          encoding: "raw",
          logicalId: contentId,
          decodedLength: bytes.byteLength,
          payload: bytes,
        },
      ],
    });
    await publishPackFile(layout, packed);
    await publishCurrentMultiPackIndex(layout);

    await withAuthority(layout, (authority) =>
      repository.materializeLooseContent(
        contentId,
        bytes.byteLength,
        async (sink) => sink(bytes),
        authority,
      ),
    );
    expect(
      await readFile(nativeLooseRecordPath(layout, "content", contentId)),
    ).not.toHaveLength(0);
  });

  it("fails closed on an existing corrupt loose root during materialization", async () => {
    const { layout, repository } = await setupRepository();
    const bytes = Buffer.from("valid legacy fallback", "utf8");
    const contentId = contentIdFromBytes(bytes);
    await mkdir(join(layout.blobs, contentId.slice(0, 2)), { recursive: true });
    await mkdir(join(layout.contentRecords, contentId.slice(0, 2)), {
      recursive: true,
    });
    await writeFile(nativeObjectPath(layout, "blob", contentId), bytes);
    await writeFile(
      nativeLooseRecordPath(layout, "content", contentId),
      Buffer.from("corrupt loose root", "utf8"),
    );
    let sourceReads = 0;

    await expect(
      withAuthority(layout, (authority) =>
        repository.materializeLooseContent(
          contentId,
          bytes.byteLength,
          async (sink) => {
            sourceReads += 1;
            await sink(bytes);
          },
          authority,
        ),
      ),
    ).rejects.toMatchObject({ code: "object-integrity" });
    expect(sourceReads).toBe(0);
  });

  it("authenticates the source before reusing an existing loose root", async () => {
    const { layout, repository } = await setupRepository();
    const bytes = Buffer.from("materialized source identity", "utf8");
    const contentId = contentIdFromBytes(bytes);
    await repository.ensureRawContent(contentId, bytes);

    await expect(
      withAuthority(layout, (authority) =>
        repository.materializeLooseContent(
          contentId,
          bytes.byteLength,
          async (sink) => sink(Buffer.alloc(bytes.byteLength, 0x78)),
          authority,
        ),
      ),
    ).rejects.toMatchObject({ code: "object-integrity" });
  });
});
