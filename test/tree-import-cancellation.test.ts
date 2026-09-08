import { mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ContentRepository } from "../src/infrastructure/content-store/repository.ts";
import { PackCatalog } from "../src/infrastructure/content-store/pack-catalog.ts";
import {
  nativeObjectStoreRepository,
  openObjectStore,
  TreeImportAdmissionError,
  TreeImportSourceError,
  type TreeImportAdmission,
} from "../src/infrastructure/object-store.ts";
import { isOperationCancelled } from "../src/infrastructure/workspace-operation.ts";
import {
  nativeLooseRecordPath,
  nativeObjectLayout,
} from "../src/infrastructure/workspace-store.ts";
import {
  importTestTrees,
  publishTestBlob,
  publishTestTree,
} from "./object-store-fixture.ts";
import { ALL_MANAGED_SCOPE } from "./workspace-scope-fixture.ts";

const roots: string[] = [];
const admission: TreeImportAdmission = {
  validateImportedTree: async () => ({ kind: "accepted" }),
  maxSnapshotBytes: 4 * 1024 * 1024,
};

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "cyclotomy-import-cancellation-"));
  roots.push(root);
  const source = await openObjectStore(join(root, "source"));
  const target = await openObjectStore(join(root, "target"));
  const bytes = Buffer.alloc(512 * 1024, 0x41);
  const oid = await publishTestBlob(source, bytes);
  const treeOid = await publishTestTree(
    source,
    [
      {
        path: "source.bin",
        type: "regular",
        blobOid: oid,
        recreationMode: 0o644,
      },
    ],
    ALL_MANAGED_SCOPE,
  );
  return { source, target, bytes, oid, treeOid };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("tree import cancellation and source verification", () => {
  it.each([false, true])(
    "settles an admission abort with cleanup failure=%s",
    async (failCleanup) => {
      const { source, target, treeOid } = await setup();
      const controller = new AbortController();
      const reason = new Error("import cancelled during admission");
      const cleanupFailure = new Error("source scope cleanup failed");
      const sourceRepository = nativeObjectStoreRepository(source, "test");
      const close =
        sourceRepository.closeResolutionScope.bind(sourceRepository);
      const closeSource = vi
        .spyOn(sourceRepository, "closeResolutionScope")
        .mockImplementation(async (scope) => {
          await close(scope);
          if (failCleanup) throw cleanupFailure;
        });
      const begin = vi.spyOn(ContentRepository.prototype, "beginPublication");
      const failure = await importTestTrees(
        target,
        source,
        [treeOid],
        {
          ...admission,
          validateImportedTree: async () => {
            controller.abort(reason);
            return { kind: "accepted" };
          },
        },
        { signal: controller.signal },
      ).catch((error: unknown) => error);
      expect(isOperationCancelled(failure, controller.signal)).toBe(
        !failCleanup,
      );
      expect(failure).not.toBeInstanceOf(TreeImportAdmissionError);
      if (failCleanup)
        expect(failure).toMatchObject({ errors: [reason, cleanupFailure] });
      expect(begin).not.toHaveBeenCalled();
      expect(closeSource).toHaveBeenCalledTimes(1);
      expect(
        (
          await new PackCatalog(
            nativeObjectLayout(target.storageRoot),
          ).inventory()
        ).packs,
      ).toEqual([]);
      await expect(
        readdir(join(target.storageRoot, "workspace.lock")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("rejects a source damaged after preflight even when the target already contains it", async () => {
    const { source, target, bytes, oid, treeOid } = await setup();
    await publishTestBlob(target, bytes);
    const repository = nativeObjectStoreRepository(source, "test");
    const stream = repository.streamContent.bind(repository);
    let sourceReads = 0;
    vi.spyOn(repository, "streamContent").mockImplementation(
      async (...args) => {
        if (args[0] === oid && ++sourceReads === 2) {
          await writeFile(
            nativeLooseRecordPath(
              nativeObjectLayout(source.storageRoot),
              "content",
              oid,
            ),
            "corrupt source",
          );
        }
        return await stream(...args);
      },
    );
    const failure = await importTestTrees(
      target,
      source,
      [treeOid],
      admission,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TreeImportSourceError);
    expect(failure).not.toBeInstanceOf(TreeImportAdmissionError);
    expect(sourceReads).toBe(2);
    expect(await target.readBlob(oid)).toEqual(bytes);
    await expect(target.readTree(treeOid)).rejects.toMatchObject({
      code: "missing-object",
    });
  });

  it("stops replaying an existing target's import source after cancellation", async () => {
    const { source, target, bytes, oid, treeOid } = await setup();
    await publishTestBlob(target, bytes);
    const controller = new AbortController();
    const reason = new Error("source replay cancelled");
    const repository = nativeObjectStoreRepository(source, "test");
    const stream = repository.streamContent.bind(repository);
    let sourceReads = 0;
    let replayedChunks = 0;
    vi.spyOn(repository, "streamContent").mockImplementation(
      async (contentId, maximumBytes, sink, scope) => {
        if (contentId !== oid || ++sourceReads !== 2)
          return await stream(contentId, maximumBytes, sink, scope);
        return await stream(
          contentId,
          maximumBytes,
          async (chunk) => {
            replayedChunks += 1;
            controller.abort(reason);
            await sink(chunk);
          },
          scope,
        );
      },
    );
    const failure = await importTestTrees(
      target,
      source,
      [treeOid],
      admission,
      { signal: controller.signal },
    ).catch((error: unknown) => error);
    expect(isOperationCancelled(failure, controller.signal)).toBe(true);
    expect(replayedChunks).toBe(1);
    await expect(target.readTree(treeOid)).rejects.toMatchObject({
      code: "missing-object",
    });
  });

  it("settles an active pack flush before releasing either workspace lock", async () => {
    const { source, target, treeOid } = await setup();
    const controller = new AbortController();
    const reason = new Error("pack import cancelled");
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
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
    const importing = importTestTrees(target, source, [treeOid], admission, {
      signal: controller.signal,
    });
    await entered;
    controller.abort(reason);
    let settled = false;
    const outcome = importing
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    await Promise.resolve();
    expect(settled).toBe(false);
    await Promise.all(
      [source, target].map((store) =>
        readdir(join(store.storageRoot, "workspace.lock")),
      ),
    );
    release();
    const failure = await outcome;
    expect(isOperationCancelled(failure, controller.signal)).toBe(true);
    expect(
      await readdir(nativeObjectLayout(target.storageRoot).incomingPacks),
    ).toEqual([]);
    await expect(target.readTree(treeOid)).rejects.toMatchObject({
      code: "missing-object",
    });
    for (const store of [source, target])
      await expect(
        readdir(join(store.storageRoot, "workspace.lock")),
      ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a blob pack changed while the imported tree is being published", async () => {
    const { source, target, treeOid } = await setup();
    const begin = PackCatalog.prototype.beginPublication;
    vi.spyOn(PackCatalog.prototype, "beginPublication").mockImplementation(
      function (this: PackCatalog, authority) {
        const publication = begin.call(this, authority);
        let dataPath: string | undefined;
        return {
          publishPack: async (pack) => {
            const published = await publication.publishPack(pack);
            if (published.view.packClass === "data")
              dataPath = published.identity.path;
            else if (dataPath !== undefined) {
              const handle = await open(dataPath, "r+");
              await handle.write(Buffer.from([0xff]), 0, 1, 70);
              await handle.close();
            }
            return published;
          },
        };
      },
    );
    const failure = await importTestTrees(
      target,
      source,
      [treeOid],
      admission,
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "object-integrity" });
    expect(failure).not.toBeInstanceOf(TreeImportSourceError);
  });
});
