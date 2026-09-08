import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildChunkRecipePlan } from "../src/infrastructure/content-store/chunk-recipe.ts";
import { contentIdFromBytes } from "../src/infrastructure/content-store/ids.ts";
import { encodePack } from "../src/infrastructure/content-store/pack.ts";
import {
  createChunkedContentRecord,
  createContentRecord,
  createRecipeRecord,
} from "../src/infrastructure/content-store/representation.ts";
import { encodeRecord } from "../src/infrastructure/content-store/record.ts";
import { collectGarbage } from "../src/infrastructure/object-gc.ts";
import {
  nativeObjectStoreLayout,
  nativeObjectStoreRepository,
  openObjectStore,
} from "../src/infrastructure/object-store.ts";
import { withWorkspaceLock } from "../src/infrastructure/workspace-lock.ts";
import {
  nativeLooseRecordPath,
  nativeObjectPath,
  nativePackPath,
} from "../src/infrastructure/workspace-store.ts";
import { publishTestTree } from "./object-store-fixture.ts";
import { ALL_MANAGED_SCOPE } from "./workspace-scope-fixture.ts";

const roots: string[] = [];
const FILE_BYTES = 256 * 1024;

function recipeFor(bytes: Buffer, chunks: readonly Buffer[]) {
  return buildChunkRecipePlan(
    contentIdFromBytes(bytes),
    bytes.byteLength,
    chunks.map((chunk) => ({
      kind: "content" as const,
      contentId: contentIdFromBytes(chunk),
      decodedLength: chunk.byteLength,
    })),
    {
      maxChunks: 64,
      maxDecodedBytes: bytes.byteLength,
      maxDepth: 8,
      maxNodes: 64,
    },
  );
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cyclotomy-gc-coverage-"));
  roots.push(root);
  const store = await openObjectStore(root);
  const layout = nativeObjectStoreLayout(store, "GC content coverage test");
  return {
    root,
    store,
    layout,
    write: async (path: string, bytes: Uint8Array) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes, { mode: 0o600 });
    },
    collect: (treeOid: string) =>
      withWorkspaceLock(root, "GC content coverage test", (authority) =>
        collectGarbage(
          authority,
          store,
          { listReferencedTreeOids: () => [treeOid] },
          { graceMs: 0, now: Date.now() + 60_000 },
        ),
      ),
  };
}

function treeEntry(blobOid: string, path: string) {
  return { path, type: "regular" as const, blobOid, recreationMode: 0o644 };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("GC preserves the content representations authenticated by marking", () => {
  it.each(["legacy", "loose"] as const)(
    "keeps content readable when a %s full copy coexists with packed chunked content",
    async (source) => {
      const state = await fixture();
      const bytes = randomBytes(FILE_BYTES);
      const id = contentIdFromBytes(bytes);
      const chunks = [
        bytes.subarray(0, FILE_BYTES / 2),
        bytes.subarray(FILE_BYTES / 2),
      ];
      const recipe = recipeFor(bytes, chunks);
      const chunked = createChunkedContentRecord(
        id,
        bytes.byteLength,
        recipe.rootId,
      );
      const contentPack = await encodePack(
        {
          packClass: "data",
          records: [
            ...(await Promise.all(chunks.map(createContentRecord))),
            chunked,
          ],
        },
        {
          verifyChunkedContent: ({ logicalId, recipeId }) =>
            logicalId === id && recipeId === recipe.rootId,
        },
      );
      const recipePack = await encodePack({
        packClass: "metadata",
        records: await Promise.all(
          recipe.objects.map((object) => createRecipeRecord(object.bytes)),
        ),
      });
      for (const pack of [contentPack, recipePack])
        await state.write(
          nativePackPath(state.layout, pack.pack.packId),
          pack.bytes,
        );
      const tree = await publishTestTree(
        state.store,
        [treeEntry(id, "file.bin")],
        ALL_MANAGED_SCOPE,
      );
      const path =
        source === "legacy"
          ? nativeObjectPath(state.layout, "blob", id)
          : nativeLooseRecordPath(state.layout, "content", id);
      await state.write(
        path,
        source === "legacy"
          ? bytes
          : encodeRecord(await createContentRecord(bytes)),
      );
      const proof = await nativeObjectStoreRepository(
        state.store,
        "coverage test",
      ).streamContent(id, bytes.byteLength, async () => {});
      expect(
        proof.closure.objects.find((object) => object.logicalId === id)?.source,
      ).toBe(source === "legacy" ? "legacy-blob" : "loose");

      for (let pass = 0; pass < 3; pass += 1) {
        await state.collect(tree);
        await expect(state.store.readBlob(id)).resolves.toEqual(bytes);
        await expect(state.store.readTreeManifest(tree)).resolves.toMatchObject(
          { entries: [treeEntry(id, "file.bin")] },
        );
      }
    },
  );

  it.each(["chunked", "full"] as const)(
    "retains a terminal copy when the same id also has a %s file root",
    async (rootRepresentation) => {
      const state = await fixture();
      const a = randomBytes(FILE_BYTES);
      const b = randomBytes(16 * 1024);
      const c = Buffer.concat([a, b]);
      const aId = contentIdFromBytes(a),
        cId = contentIdFromBytes(c);
      const aChunks = [
        a.subarray(0, FILE_BYTES / 2),
        a.subarray(FILE_BYTES / 2),
      ];
      const aPlan = recipeFor(a, aChunks),
        cPlan = recipeFor(c, [a, b]);
      const aRoot = createChunkedContentRecord(aId, a.byteLength, aPlan.rootId);
      const cRoot = createChunkedContentRecord(cId, c.byteLength, cPlan.rootId);
      const rootsById = new Map([
        [aId, aPlan.rootId],
        [cId, cPlan.rootId],
      ]);
      const verify = {
        verifyChunkedContent: ({
          logicalId,
          recipeId,
        }: {
          logicalId: string;
          recipeId: string;
        }) => rootsById.get(logicalId as typeof aId) === recipeId,
      };
      const terminalRecords = await Promise.all(
        aChunks.map(createContentRecord),
      );
      const full = await createContentRecord(a);
      let rootPack, fullPack;
      // Separate physical ordering from the authenticated root/terminal choice.
      for (let salt = 0; ; salt += 1) {
        const noise = await createContentRecord(
          Buffer.from(`root salt ${salt}`),
        );
        const pack = await encodePack(
          { packClass: "data", records: [...terminalRecords, aRoot, noise] },
          verify,
        );
        if (Number.parseInt(pack.pack.packId.slice(0, 2), 16) < 32) {
          rootPack = pack;
          break;
        }
      }
      for (let salt = 0; ; salt += 1) {
        const noise = await createContentRecord(
          Buffer.from(`full salt ${salt}`),
        );
        const pack = await encodePack({
          packClass: "data",
          records: [full, noise],
        });
        if (Number.parseInt(pack.pack.packId.slice(0, 2), 16) >= 224) {
          fullPack = pack;
          break;
        }
      }
      const cPack = await encodePack(
        { packClass: "data", records: [await createContentRecord(b), cRoot] },
        verify,
      );
      const recipePack = await encodePack({
        packClass: "metadata",
        records: await Promise.all(
          [...aPlan.objects, ...cPlan.objects].map((object) =>
            createRecipeRecord(object.bytes),
          ),
        ),
      });
      for (const pack of [rootPack, fullPack, cPack, recipePack])
        await state.write(
          nativePackPath(state.layout, pack.pack.packId),
          pack.bytes,
        );
      if (rootRepresentation === "chunked")
        await state.write(
          nativeLooseRecordPath(state.layout, "content", aId),
          encodeRecord(aRoot),
        );
      const tree = await publishTestTree(
        state.store,
        [treeEntry(aId, "a.bin"), treeEntry(cId, "c.bin")],
        ALL_MANAGED_SCOPE,
      );
      const repository = nativeObjectStoreRepository(
        state.store,
        "terminal coverage test",
      );
      const aProof = await repository.streamContent(
        aId,
        a.byteLength,
        async () => {},
      );
      const cProof = await repository.streamContent(
        cId,
        c.byteLength,
        async () => {},
      );
      const aLocations = aProof.closure.objects.filter(
        (object) => object.logicalId === aId,
      );
      expect(
        aLocations.some((object) => object.encoding === "chunked-v1"),
      ).toBe(rootRepresentation === "chunked");
      expect(
        cProof.closure.objects
          .filter((object) => object.logicalId === aId)
          .every((object) => object.encoding !== "chunked-v1"),
      ).toBe(true);

      for (let pass = 0; pass < 3; pass += 1) {
        await state.collect(tree);
        await expect(state.store.readBlob(aId)).resolves.toEqual(a);
        await expect(state.store.readBlob(cId)).resolves.toEqual(c);
        await expect(state.store.readTreeManifest(tree)).resolves.toMatchObject(
          { entries: [treeEntry(aId, "a.bin"), treeEntry(cId, "c.bin")] },
        );
      }
    },
  );
});
