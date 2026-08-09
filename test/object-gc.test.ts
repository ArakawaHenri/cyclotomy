import {
  mkdir,
  mkdtemp,
  readFile,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  collectGarbage,
  GarbageCollectionMarkError,
  GarbageCollectionNamespaceError,
} from "../src/infrastructure/object-gc.ts";
import { MetadataStore } from "../src/infrastructure/metadata.ts";
import { openObjectStore } from "../src/infrastructure/object-store.ts";
import { commitTestNodeState } from "./metadata-fixture.ts";
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

function objectPath(
  root: string,
  kind: "blobs" | "trees",
  oid: string,
): string {
  return join(root, "objects", kind, oid.slice(0, 2), oid.slice(2));
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("object garbage collection", () => {
  it("removes multiple expired orphan objects from one shard", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-gc-"));
    roots.push(root);
    const store = await openObjectStore(root);
    const metadata = new MetadataStore(join(root, "state.db"));
    const shard = join(root, "objects", "blobs", "aa");
    await mkdir(shard);
    const first = join(shard, "b".repeat(62));
    const second = join(shard, "c".repeat(62));
    await writeFile(first, "first orphan");
    await writeFile(second, "second orphan");
    const old = new Date(Date.now() - 10_000);
    await utimes(first, old, old);
    await utimes(second, old, old);

    const report = await collectGarbage(root, store, metadata, 1, Date.now());

    expect(report.removedBlobs).toBe(2);
    await expect(stat(first)).rejects.toThrow();
    await expect(stat(second)).rejects.toThrow();
    metadata.close();
  });

  it("rejects a symlinked shard without deleting an outside sentinel", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-gc-"));
    const outside = await mkdtemp(join(tmpdir(), "cyclotomy-gc-outside-"));
    roots.push(root, outside);
    const store = await openObjectStore(root);
    const metadata = new MetadataStore(join(root, "state.db"));
    const sentinel = join(outside, "b".repeat(62));
    await writeFile(sentinel, "outside");
    const old = new Date(Date.now() - 10_000);
    await utimes(sentinel, old, old);
    await mkdir(join(root, "objects", "blobs"), { recursive: true });
    await symlink(outside, join(root, "objects", "blobs", "aa"));

    await expect(
      collectGarbage(root, store, metadata, 1, Date.now()),
    ).rejects.toBeInstanceOf(GarbageCollectionNamespaceError);
    await expect(stat(sentinel)).resolves.toBeDefined();
    metadata.close();
  });

  it("fails closed before sweeping when a rooted tree manifest is unreadable", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-gc-"));
    roots.push(root);
    const store = await openObjectStore(root);
    const metadata = new MetadataStore(join(root, "state.db"));
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
    commitTestNodeState(metadata, "s1", "e1", treeOid);

    const old = new Date(Date.now() - 10_000);
    await utimes(objectPath(root, "blobs", blobOid), old, old);
    await writeFile(objectPath(root, "trees", treeOid), "corrupt");

    await expect(
      collectGarbage(root, store, metadata, 1, Date.now()),
    ).rejects.toBeInstanceOf(GarbageCollectionMarkError);
    await expect(
      stat(objectPath(root, "blobs", blobOid)),
    ).resolves.toBeDefined();
    metadata.close();
  });

  it("uses authenticated manifests for reachability without hashing rooted blob contents", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-gc-"));
    roots.push(root);
    const store = await openObjectStore(root);
    const metadata = new MetadataStore(join(root, "state.db"));
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
    commitTestNodeState(metadata, "s1", "e1", treeOid);

    const rootedPath = objectPath(root, "blobs", blobOid);
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

    const report = await collectGarbage(root, store, metadata, 1, Date.now());

    expect(report.removedBlobs).toBe(1);
    await expect(stat(rootedPath)).resolves.toBeDefined();
    await expect(stat(orphanPath)).rejects.toThrow();
    metadata.close();
  });

  it("marks the blob closure of a valid v1 tree that portable v2 quarantines", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-gc-v1-"));
    roots.push(root);
    const store = await openObjectStore(root);
    const metadata = new MetadataStore(join(root, "state.db"));
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
    commitTestNodeState(metadata, "legacy", "blocked", incompatibleV1TreeOid);

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

    const report = await collectGarbage(root, store, metadata, 1, Date.now());

    expect(report.removedBlobs).toBe(1);
    expect(report.removedTrees).toBe(0);
    await expect(
      stat(objectPath(root, "blobs", incompatibleV1BlobOid)),
    ).resolves.toBeDefined();
    await expect(
      stat(objectPath(root, "trees", incompatibleV1TreeOid)),
    ).resolves.toBeDefined();
    await expect(stat(orphanPath)).rejects.toThrow();
    metadata.close();
  });
});
