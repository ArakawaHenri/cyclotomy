import { randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { contentIdFromBytes } from "../src/infrastructure/content-store/ids.ts";
import { PackCatalog } from "../src/infrastructure/content-store/pack-catalog.ts";
import { ContentRepository } from "../src/infrastructure/content-store/repository.ts";
import * as zstd from "../src/infrastructure/content-store/zstd.ts";
import {
  nativeLooseRecordPath,
  nativeObjectLayout,
} from "../src/infrastructure/workspace-store.ts";
import {
  withWorkspaceLock,
  WorkspaceLockOwnershipLostError,
} from "../src/infrastructure/workspace-lock.ts";

const roots: string[] = [];

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "cyclotomy-publication-"));
  roots.push(root);
  const layout = nativeObjectLayout(root);
  await Promise.all(
    [
      layout.blobs,
      layout.trees,
      layout.contentRecords,
      layout.recipeRecords,
      layout.incomingPacks,
    ].map((path) => mkdir(path, { recursive: true })),
  );
  return {
    layout,
    repository: new ContentRepository(layout, {
      maxDecodedBytes: 16 * 1024 * 1024,
    }),
  };
}

async function collect(
  repository: ContentRepository,
  bytes: Uint8Array,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await repository.streamContent(
    contentIdFromBytes(bytes),
    bytes.byteLength,
    async (chunk) => {
      chunks.push(Buffer.from(chunk));
    },
  );
  return Buffer.concat(chunks);
}

function source(bytes: Uint8Array) {
  return async (sink: (chunk: Uint8Array) => Promise<void>) => {
    for (let offset = 0; offset < bytes.byteLength; offset += 64 * 1024) {
      await sink(bytes.subarray(offset, offset + 64 * 1024));
    }
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("batched content publication", () => {
  it.each(["stored", "pending"] as const)(
    "authenticates an import source even when its target content is %s",
    async (state) => {
      const { layout, repository } = await setup();
      const bytes = Buffer.from("shared target content");
      const oid = contentIdFromBytes(bytes);
      if (state === "stored") await repository.ensureRawContent(oid, bytes);
      await withWorkspaceLock(
        layout.root,
        "source authentication",
        async (authority) => {
          const publication = repository.beginPublication(authority);
          try {
            if (state === "pending")
              await publication.ensureRawContent(oid, bytes);
            const input = vi.fn(source(Buffer.alloc(bytes.byteLength, 0x41)));
            await expect(
              publication.publishContentFromStream(
                oid,
                bytes.byteLength,
                input,
                { authenticateSource: true },
              ),
            ).rejects.toMatchObject({ code: "object-integrity" });
            expect(input).toHaveBeenCalledTimes(1);
            await expect(publication.flush()).rejects.toMatchObject({
              code: "object-integrity",
            });
          } finally {
            await publication.close();
          }
        },
      );
    },
  );

  it("makes a batch durable and reuses its authentication across all content receipts", async () => {
    const { layout, repository } = await setup();
    const files = Array.from({ length: 100 }, (_, index) =>
      Buffer.from(`${index}:` + "source text ".repeat(300)),
    );
    await withWorkspaceLock(
      layout.root,
      "batched publication test",
      async (authority) => {
        const publication = repository.beginPublication(authority);
        try {
          const receipts = await Promise.all(
            files.map((bytes) =>
              publication.publishContentFromStream(
                contentIdFromBytes(bytes),
                bytes.byteLength,
                source(bytes),
              ),
            ),
          );
          expect(await readdir(layout.contentRecords)).toEqual([]);
          expect(await readdir(layout.packs)).toEqual(["incoming"]);
          await publication.flush();
          const checks = vi.spyOn(
            PackCatalog.prototype,
            "packReceiptStillCurrent",
          );
          checks.mockClear();
          await Promise.all(
            receipts.map((receipt) =>
              publication.revalidateContent(receipt, 4096),
            ),
          );
          expect(checks).toHaveBeenCalledTimes(1);
        } finally {
          await publication.close();
        }
      },
    );
    const catalog = new PackCatalog(layout);
    const stored = await catalog.inventory();
    expect(stored.packs).toHaveLength(1);
    expect(stored.totalIndexEntries).toBe(files.length);
    const reopened = new ContentRepository(layout, { maxDecodedBytes: 4096 });
    for (const bytes of [files[0]!, files[49]!, files[99]!]) {
      expect(await collect(reopened, bytes)).toEqual(bytes);
    }
    const encode = vi.spyOn(zstd, "encodeOwnedZstdV1");
    await withWorkspaceLock(
      layout.root,
      "repeated publication test",
      async (authority) => {
        const publication = repository.beginPublication(authority);
        try {
          const input = vi.fn(async () => {
            throw new Error("source is gone");
          });
          for (const bytes of files) {
            const receipt = await publication.publishContentFromStream(
              contentIdFromBytes(bytes),
              bytes.byteLength,
              input,
            );
            await publication.revalidateContent(receipt, 4096);
          }
          await publication.flush();
          expect(input).not.toHaveBeenCalled();
          expect(encode).not.toHaveBeenCalled();
        } finally {
          await publication.close();
        }
      },
    );
    expect((await catalog.inventory()).packs).toHaveLength(1);
  });

  it("encodes a repeated chunk once and preserves the complete large-file content", async () => {
    const { layout, repository } = await setup();
    const bytes = Buffer.alloc(12 * 1024 * 1024, 0x41);
    const encode = vi.spyOn(zstd, "encodeOwnedZstdV1");
    await withWorkspaceLock(
      layout.root,
      "chunk deduplication test",
      async (authority) => {
        const publication = repository.beginPublication(authority);
        try {
          const receipt = await publication.publishContentFromStream(
            contentIdFromBytes(bytes),
            bytes.byteLength,
            source(bytes),
          );
          expect(
            encode.mock.calls.filter(
              ([input]) => input.byteLength === 256 * 1024,
            ),
          ).toHaveLength(1);
          await publication.flush();
          await publication.revalidateContent(receipt, bytes.byteLength);
        } finally {
          await publication.close();
        }
      },
    );
    expect((await collect(repository, bytes)).equals(bytes)).toBe(true);
    const inventory = await new PackCatalog(layout).inventory();
    expect(
      inventory.packs.filter(({ view }) => view.packClass === "data"),
    ).toHaveLength(1);
    expect(
      inventory.views
        .flatMap(({ entries }) => entries)
        .filter((entry) => entry.kind === "content"),
    ).toHaveLength(2);
  });

  it("flushes bounded batches while streaming and verifies dependencies across later flushes", async () => {
    const { layout, repository } = await setup();
    const bytes = randomBytes(6 * 1024 * 1024);
    await withWorkspaceLock(
      layout.root,
      "bounded publication test",
      async (authority) => {
        const publication = repository.beginPublication(authority);
        try {
          const receipt = await publication.publishContentFromStream(
            contentIdFromBytes(bytes),
            bytes.byteLength,
            source(bytes),
          );
          const intermediate = await new PackCatalog(layout).inventory();
          expect(intermediate.packs.length).toBeGreaterThan(0);
          await publication.flush();
          await publication.revalidateContent(receipt, bytes.byteLength);
          const structure = Buffer.from("canonical structural bytes");
          const oid = contentIdFromBytes(structure);
          await publication.publishStructural("node", oid, structure);
          await publication.flush();
          await publication.revalidateContent(receipt, bytes.byteLength);
          expect(
            await repository.readStructural("node", oid, structure.byteLength),
          ).toEqual(structure);
        } finally {
          await publication.close();
        }
      },
    );
    expect((await collect(repository, bytes)).equals(bytes)).toBe(true);
    const inventory = await new PackCatalog(layout).inventory();
    const data = inventory.packs.filter(
      ({ view }) => view.packClass === "data",
    );
    expect(data.length).toBeGreaterThan(1);
    for (const { view } of data) {
      expect(
        view.entries.reduce(
          (sum, entry) =>
            sum + (entry.encoding === "chunked-v1" ? 0 : entry.decodedLength),
          0,
        ),
      ).toBeLessThanOrEqual(4 * 1024 * 1024);
    }
  });

  it("discards pending objects after a mismatched source or cancellation", async () => {
    for (const cancel of [false, true]) {
      const { layout, repository } = await setup();
      const bytes = Buffer.alloc(1024 * 1024, 0x42);
      const controller = new AbortController();
      const reason = new Error("capture cancelled");
      await withWorkspaceLock(
        layout.root,
        "failed publication test",
        async (authority) => {
          const publication = repository.beginPublication(authority, {
            signal: controller.signal,
          });
          const contentId = contentIdFromBytes(
            cancel ? bytes : Buffer.alloc(bytes.byteLength, 0x43),
          );
          const writing = publication.publishContentFromStream(
            contentId,
            bytes.byteLength,
            async (sink) => {
              await sink(bytes.subarray(0, 512 * 1024));
              if (cancel) controller.abort(reason);
              await sink(bytes.subarray(512 * 1024));
            },
          );
          if (cancel) await expect(writing).rejects.toBe(reason);
          else
            await expect(writing).rejects.toMatchObject({
              code: "object-integrity",
            });
          await expect(publication.flush()).rejects.toBeDefined();
          await publication.close();
          await publication.close();
        },
      );
      expect(await readdir(layout.packs)).toEqual(["incoming"]);
      expect(await readdir(layout.incomingPacks)).toEqual([]);
    }
  });

  it("fails closed when a published pack changes before revalidation", async () => {
    const { layout, repository } = await setup();
    const bytes = Buffer.from("snapshot contents".repeat(50));
    await withWorkspaceLock(
      layout.root,
      "pack drift test",
      async (authority) => {
        const publication = repository.beginPublication(authority);
        try {
          const receipt = await publication.publishContentFromStream(
            contentIdFromBytes(bytes),
            bytes.byteLength,
            source(bytes),
          );
          await publication.flush();
          const inventory = await new PackCatalog(layout).inventory();
          const path = inventory.packs[0]!.path;
          const handle = await open(path, "r+");
          await handle.write(Buffer.from([0xff]), 0, 1, 20);
          await handle.close();
          await expect(
            publication.revalidateContent(receipt, bytes.byteLength),
          ).rejects.toMatchObject({ code: "object-integrity" });
        } finally {
          await publication.close();
        }
      },
    );
  });

  it("publishes new content when an unrelated historical pack payload is damaged", async () => {
    const { layout, repository } = await setup();
    const old = Buffer.from("unrelated historical content".repeat(100));
    await withWorkspaceLock(
      layout.root,
      "historical publication",
      async (authority) => {
        const publication = repository.beginPublication(authority);
        try {
          await publication.ensureRawContent(contentIdFromBytes(old), old);
          await publication.flush();
        } finally {
          await publication.close();
        }
      },
    );
    const inventory = await new PackCatalog(layout).inventory();
    const pack = inventory.packs[0]!;
    const entry = pack.view.entries[0]!;
    const handle = await open(pack.path, "r+");
    await handle.write(
      Buffer.from([0xff]),
      0,
      1,
      entry.offset + entry.length - 1,
    );
    await handle.close();

    const fresh = Buffer.from("new independent content".repeat(100));
    await withWorkspaceLock(
      layout.root,
      "new publication",
      async (authority) => {
        const publication = repository.beginPublication(authority);
        try {
          const receipt = await publication.ensureRawContent(
            contentIdFromBytes(fresh),
            fresh,
          );
          await publication.flush();
          await publication.revalidateContent(receipt, fresh.byteLength);
        } finally {
          await publication.close();
        }
      },
    );
    expect(await collect(repository, fresh)).toEqual(fresh);
    await expect(collect(repository, old)).rejects.toBeDefined();
  });

  it("settles an in-flight pack flush before closing after cancellation", async () => {
    const { layout, repository } = await setup();
    const controller = new AbortController();
    const reason = new Error("cancel during pack publication");
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const begin = PackCatalog.prototype.beginPublication;
    vi.spyOn(PackCatalog.prototype, "beginPublication").mockImplementation(
      function (this: PackCatalog, authority) {
        const publication = begin.call(this, authority);
        return {
          publishPack: async (pack) => {
            started();
            await gate;
            return await publication.publishPack(pack);
          },
        };
      },
    );
    await withWorkspaceLock(
      layout.root,
      "cancel during flush test",
      async (authority) => {
        const publication = repository.beginPublication(authority, {
          signal: controller.signal,
        });
        const bytes = Buffer.from("pending pack contents".repeat(100));
        await publication.ensureRawContent(contentIdFromBytes(bytes), bytes);
        const flushing = publication.flush();
        await writing;
        controller.abort(reason);
        let closed = false;
        const closing = publication.close().then(() => {
          closed = true;
        });
        await Promise.resolve();
        expect(closed).toBe(false);
        release();
        await expect(flushing).rejects.toBe(reason);
        await closing;
        expect(closed).toBe(true);
        expect(await readdir(layout.incomingPacks)).toEqual([]);
        expect((await new PackCatalog(layout).inventory()).packs).toHaveLength(
          1,
        );
      },
    );
  });

  it("rejects corrupt immutable loose roots and revoked write authority", async () => {
    const { layout, repository } = await setup();
    const bytes = Buffer.from("immutable content");
    const oid = contentIdFromBytes(bytes);
    const target = nativeLooseRecordPath(layout, "content", oid);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from("corrupt"));
    await withWorkspaceLock(
      layout.root,
      "corrupt loose root test",
      async (authority) => {
        const publication = repository.beginPublication(authority);
        await expect(
          publication.publishContentFromStream(
            oid,
            bytes.byteLength,
            source(bytes),
          ),
        ).rejects.toMatchObject({ code: "object-integrity" });
        await publication.close();
      },
    );
    await withWorkspaceLock(
      layout.root,
      "revoked writer test",
      async (authority) => {
        const publication = repository.beginPublication(authority);
        const valid = Buffer.from("new valid content");
        await publication.publishContentFromStream(
          contentIdFromBytes(valid),
          valid.byteLength,
          source(valid),
        );
        const lock = join(layout.root, "workspace.lock");
        const displaced = join(layout.root, "displaced-lock");
        await rename(lock, displaced);
        try {
          await expect(publication.flush()).rejects.toBeInstanceOf(
            WorkspaceLockOwnershipLostError,
          );
        } finally {
          await publication.close();
          await rename(displaced, lock);
        }
      },
    );
    expect(await readdir(layout.incomingPacks)).toEqual([]);
    expect(await readdir(layout.packs)).toEqual(["incoming"]);
    expect(await readdir(layout.trees)).toEqual([]);
  });

  it("preserves a pack write failure and releases its temporary file", async () => {
    const { layout, repository } = await setup();
    const probe = await open(join(layout.root, "probe"), "w");
    const prototype = Object.getPrototypeOf(probe) as {
      writeFile: typeof probe.writeFile;
    };
    await probe.close();
    const failure = new Error("pack disk write failed");
    const bytes = Buffer.from("new contents".repeat(100));
    await withWorkspaceLock(
      layout.root,
      "pack write failure test",
      async (authority) => {
        const publication = repository.beginPublication(authority);
        await publication.publishContentFromStream(
          contentIdFromBytes(bytes),
          bytes.byteLength,
          source(bytes),
        );
        const write = vi
          .spyOn(prototype, "writeFile")
          .mockRejectedValueOnce(failure);
        await expect(publication.flush()).rejects.toBeDefined();
        write.mockRestore();
        await publication.close();
        expect(await readdir(layout.incomingPacks)).toEqual([]);
        const inventory = await new PackCatalog(layout).inventory();
        expect(inventory.packs).toHaveLength(0);
      },
    );
  });
});
