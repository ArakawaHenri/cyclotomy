import {
  mkdir,
  mkdtemp,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  collectGarbage,
  GarbageCollectionMarkError,
  GarbageCollectionNamespaceError,
} from "../src/infrastructure/object-gc.ts";
import { MetadataStore } from "../src/infrastructure/metadata.ts";
import { openObjectStore } from "../src/infrastructure/object-store.ts";
import { publishTestBlob, publishTestTree } from "./object-store-fixture.ts";
import { ALL_MANAGED_SCOPE } from "./workspace-scope-fixture.ts";

const roots: string[] = [];
const scope = ALL_MANAGED_SCOPE;

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
    metadata.setState("s1", "e1", treeOid);

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
    metadata.setState("s1", "e1", treeOid);

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
});
