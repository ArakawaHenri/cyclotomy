import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  unlink,
  utimes,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse as parsePath } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  openObjectStore,
  TREE_MANIFEST_FORMAT,
  type ObjectStore,
  type TreeEntry,
} from "../src/infrastructure/object-store.ts";
import { ABSOLUTE_MAX_TREE_MANIFEST_BYTES } from "../src/infrastructure/tree-manifest.ts";
import {
  publishTestBlob,
  publishTestBlobInPublication,
  publishTestTree,
} from "./object-store-fixture.ts";
import { ALL_MANAGED_SCOPE, gitScope } from "./workspace-scope-fixture.ts";
const completeScope = ALL_MANAGED_SCOPE;

function digest(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function physicalObjectPath(
  root: string,
  kind: "blobs" | "trees",
  oid: string,
): string {
  return join(root, "objects", kind, oid.slice(0, 2), oid.slice(2));
}

async function fileHandlePrototype(): Promise<{
  readonly sync: FileHandle["sync"];
  readonly stat: () => Promise<Stats>;
}> {
  const probePath = join(
    tmpdir(),
    `cyclotomy-file-handle-${process.pid}-${Date.now()}`,
  );
  const probe = await open(probePath, "w");
  const prototype = Object.getPrototypeOf(probe) as {
    readonly sync: FileHandle["sync"];
    readonly stat: () => Promise<Stats>;
  };
  await probe.close();
  await rm(probePath, { force: true });
  return prototype;
}

describe("object store", () => {
  let root: string;
  let store: ObjectStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cyclotomy-object-store-"));
    store = await openObjectStore(root);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("publishes a blob at its sharded object path and reads it back", async () => {
    const content = Buffer.from("hello\n", "utf8");
    const oid = await publishTestBlob(store, content);

    expect(oid).toBe(digest(content));
    expect(oid).toMatch(/^[0-9a-f]{64}$/u);
    const path = physicalObjectPath(root, "blobs", oid);
    expect(Buffer.from(await readFile(path))).toEqual(content);
    expect(Buffer.from(await store.readBlob(oid))).toEqual(content);
  });

  it("streams a file blob and reuses the authenticated object after source removal", async () => {
    const source = join(root, "stream-source.bin");
    const content = Buffer.alloc(8 * 1024 * 1024, 0x5a);
    await writeFile(source, content);
    const oid = digest(content);
    const firstPublication = store.beginSnapshotPublication();

    expect(
      await firstPublication.publishBlobFromFile(
        source,
        oid,
        content.byteLength,
      ),
    ).toBe(oid);
    expect((await stat(physicalObjectPath(root, "blobs", oid))).size).toBe(
      content.byteLength,
    );
    await rm(source);

    expect(
      await store
        .beginSnapshotPublication()
        .publishBlobFromFile(source, oid, content.byteLength),
    ).toBe(oid);
  });

  it("classifies a missing required stream source as invalid blob input", async () => {
    const source = join(root, "missing-stream-source.bin");
    const content = Buffer.from("source must be reopened", "utf8");
    const oid = digest(content);

    await expect(
      store
        .beginSnapshotPublication()
        .publishBlobFromFile(source, oid, content.byteLength),
    ).rejects.toMatchObject({ code: "invalid-blob" });
  });

  it("rejects a symlinked stream source before following its target", async () => {
    const outside = join(root, "outside-stream-source.bin");
    const source = join(root, "linked-stream-source.bin");
    const content = Buffer.from("outside source", "utf8");
    await writeFile(outside, content);
    await symlink(
      outside,
      source,
      process.platform === "win32" ? "file" : undefined,
    );

    await expect(
      store
        .beginSnapshotPublication()
        .publishBlobFromFile(source, digest(content), content.byteLength),
    ).rejects.toMatchObject({ code: "invalid-blob" });
    expect(await readFile(outside)).toEqual(content);
  });

  it("does not rewrite objects on an idempotent publication", async () => {
    const content = Buffer.from("stable object", "utf8");
    const blobOid = await publishTestBlob(store, content);
    const blobPath = physicalObjectPath(root, "blobs", blobOid);
    const beforeBlob = await stat(blobPath);

    expect(await publishTestBlob(store, content)).toBe(blobOid);
    const afterBlob = await stat(blobPath);
    expect(afterBlob.ino).toBe(beforeBlob.ino);
    expect(afterBlob.mtimeMs).toBe(beforeBlob.mtimeMs);

    const treeOid = await publishTestTree(
      store,
      [
        {
          path: "file",
          type: "regular",
          blobOid,
          recreationMode: 0o600,
        },
      ],
      completeScope,
    );
    const treePath = physicalObjectPath(root, "trees", treeOid);
    const beforeTree = await stat(treePath);

    expect(
      await publishTestTree(
        store,
        [
          {
            path: "file",
            type: "regular",
            blobOid,
            recreationMode: 0o600,
          },
        ],
        completeScope,
      ),
    ).toBe(treeOid);
    const afterTree = await stat(treePath);
    expect(afterTree.ino).toBe(beforeTree.ino);
    expect(afterTree.mtimeMs).toBe(beforeTree.mtimeMs);
  });

  it("detects blob tampering on reads and repairs it from authenticated bytes", async () => {
    const original = Buffer.from("original", "utf8");
    const blobOid = await publishTestBlob(store, original);
    const treeOid = await publishTestTree(
      store,
      [
        {
          path: "file",
          type: "regular",
          blobOid,
          recreationMode: 0o600,
        },
      ],
      completeScope,
    );

    await writeFile(physicalObjectPath(root, "blobs", blobOid), "tampered");
    await expect(store.readBlob(blobOid)).rejects.toMatchObject({
      code: "object-integrity",
    });
    await expect(store.readTree(treeOid)).rejects.toMatchObject({
      code: "object-integrity",
    });
    await expect(publishTestBlob(store, original)).resolves.toBe(blobOid);
    expect(Buffer.from(await store.readBlob(blobOid))).toEqual(original);
    await expect(store.readTree(treeOid)).resolves.toBeDefined();
  });

  it("never repairs through a hardlinked object namespace entry", async () => {
    const original = Buffer.from("original", "utf8");
    const blobOid = await publishTestBlob(store, original);
    const objectPath = physicalObjectPath(root, "blobs", blobOid);
    const outsideLink = join(root, "outside-link");
    await link(objectPath, outsideLink);

    await expect(publishTestBlob(store, original)).rejects.toMatchObject({
      code: "storage-failure",
    });
    expect(await readFile(outsideLink)).toEqual(original);
  });

  it("never repairs through a symlinked object namespace entry", async () => {
    const original = Buffer.from("original", "utf8");
    const blobOid = await publishTestBlob(store, original);
    const objectPath = physicalObjectPath(root, "blobs", blobOid);
    const outside = join(root, "outside-target");
    await writeFile(outside, original);
    await unlink(objectPath);
    await symlink(outside, objectPath);
    const prototype = await fileHandlePrototype();
    const originalStat = prototype.stat;
    let regularHandleStats = 0;
    vi.spyOn(prototype, "stat").mockImplementation(async function (
      this: FileHandle,
    ): Promise<Stats> {
      const observation = await originalStat.call(this);
      if (observation.isFile()) regularHandleStats += 1;
      return observation;
    });

    await expect(publishTestBlob(store, original)).rejects.toMatchObject({
      code: "storage-failure",
    });
    // In particular, Windows must reject the reparse point before open(),
    // where O_NOFOLLOW is unavailable. Directory durability probes are fine,
    // but no object/source regular-file handle may be reached.
    expect(regularHandleStats).toBe(0);
    expect(await readFile(outside)).toEqual(original);
  });

  it("never treats a dangling object symlink as a repairable missing object", async () => {
    const original = Buffer.from("original", "utf8");
    const blobOid = await publishTestBlob(store, original);
    const objectPath = physicalObjectPath(root, "blobs", blobOid);
    const missingOutside = join(root, "missing-outside-target");
    await unlink(objectPath);
    await symlink(
      missingOutside,
      objectPath,
      process.platform === "win32" ? "file" : undefined,
    );

    await expect(publishTestBlob(store, original)).rejects.toMatchObject({
      code: "storage-failure",
    });
    expect((await lstat(objectPath)).isSymbolicLink()).toBe(true);
    await expect(readFile(missingOutside)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a pathname replaced after its object handle opens", async () => {
    const content = Buffer.from("stable object", "utf8");
    const blobOid = await publishTestBlob(store, content);
    const objectPath = physicalObjectPath(root, "blobs", blobOid);
    const displacedPath = `${objectPath}.displaced`;
    const prototype = await fileHandlePrototype();
    const originalStat = prototype.stat;
    let replaced = false;
    vi.spyOn(prototype, "stat").mockImplementation(async function (
      this: FileHandle,
    ): Promise<Stats> {
      const observation = await originalStat.call(this);
      if (!replaced) {
        replaced = true;
        await rename(objectPath, displacedPath);
        await writeFile(objectPath, content);
      }
      return observation;
    });

    await expect(store.readBlob(blobOid)).rejects.toMatchObject({
      code: "storage-failure",
    });
    expect(replaced).toBe(true);
    expect(await readFile(objectPath)).toEqual(content);
    expect(await readFile(displacedPath)).toEqual(content);
  });

  it("rejects missing objects and malformed identifiers", async () => {
    await expect(store.readBlob("0".repeat(64))).rejects.toMatchObject({
      code: "missing-object",
    });
    await expect(store.readBlob("../escape")).rejects.toMatchObject({
      code: "invalid-object-id",
    });
    await expect(store.readTree("A".repeat(64))).rejects.toMatchObject({
      code: "invalid-object-id",
    });
    await expect(
      store
        .beginSnapshotPublication()
        .publishBlobFromFile("relative/source", "0".repeat(64), 1),
    ).rejects.toMatchObject({ code: "invalid-blob" });
  });

  it("publishes a canonical tree independent of input order and reads it back", async () => {
    const blobOid = await publishTestBlob(
      store,
      Buffer.from("hello\n", "utf8"),
    );
    const entries: TreeEntry[] = [
      {
        path: "src/current",
        type: "symlink",
        target: "../outside",
        symlinkKind: null,
      },
      {
        path: "src/file.txt",
        type: "regular",
        blobOid,
        recreationMode: 0o700,
      },
    ];

    const first = await publishTestTree(store, entries, completeScope);
    const second = await publishTestTree(
      store,
      [...entries].reverse(),
      completeScope,
    );

    expect(second).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    await stat(physicalObjectPath(root, "trees", first));
    expect(await store.readTree(first)).toEqual({
      format: TREE_MANIFEST_FORMAT,
      entries: [
        {
          path: "src/current",
          type: "symlink",
          target: "../outside",
          symlinkKind: null,
        },
        {
          path: "src/file.txt",
          type: "regular",
          blobOid,
          recreationMode: 0o700,
        },
      ],
      scope: completeScope,
    });
  });

  it("publishes a canonical target-time scope", async () => {
    const rootIgnoreOid = await publishTestBlob(
      store,
      Buffer.from(".env\n", "utf8"),
    );
    const nestedIgnoreOid = await publishTestBlob(
      store,
      Buffer.from("*.tmp\n", "utf8"),
    );
    const scope = {
      kind: "git",
      repositoryPrefix: "",
      ignoreCase: false,
      gitignoreSources: [
        {
          path: "z/.gitignore",
          contentsBase64: Buffer.from("*.tmp\n").toString("base64"),
        },
        {
          path: ".gitignore",
          contentsBase64: Buffer.from(".env\n").toString("base64"),
        },
      ],
      infoExcludeBase64: "",
      globalExcludeBase64: "",
    } as const;

    const entries: TreeEntry[] = [
      {
        path: ".gitignore",
        type: "regular",
        blobOid: rootIgnoreOid,
        recreationMode: 0o600,
      },
      {
        path: "z/.gitignore",
        type: "regular",
        blobOid: nestedIgnoreOid,
        recreationMode: 0o600,
      },
    ];
    const oid = await publishTestTree(store, entries, scope);
    expect(await store.readTree(oid)).toEqual({
      format: TREE_MANIFEST_FORMAT,
      entries,
      scope: gitScope({
        gitignoreSources: [
          { path: ".gitignore", contents: ".env\n" },
          { path: "z/.gitignore", contents: "*.tmp\n" },
        ],
      }),
    });

    const caseInsensitiveOid = await publishTestTree(store, entries, {
      ...scope,
      ignoreCase: true,
    });
    expect(caseInsensitiveOid).not.toBe(oid);
    const caseInsensitive = (await store.readTree(caseInsensitiveOid)).scope;
    expect(caseInsensitive.kind).toBe("git");
    if (caseInsensitive.kind === "git") {
      expect(caseInsensitive.ignoreCase).toBe(true);
    }
  });

  it("publishes canonical recreation hints including an unavailable hint", async () => {
    const firstBlob = await publishTestBlob(store, Buffer.from("first\n"));
    const secondBlob = await publishTestBlob(store, Buffer.from("second\n"));
    const entries: TreeEntry[] = [
      {
        path: "z.txt",
        type: "regular",
        blobOid: secondBlob,
        recreationMode: null,
      },
      {
        path: "a.txt",
        type: "regular",
        blobOid: firstBlob,
        recreationMode: 0o640,
      },
    ];

    const first = await publishTestTree(store, entries, completeScope);
    const second = await publishTestTree(
      store,
      [...entries].reverse(),
      completeScope,
    );

    expect(second).toBe(first);
    expect(await store.readTree(first)).toEqual({
      format: TREE_MANIFEST_FORMAT,
      entries: [
        {
          path: "a.txt",
          type: "regular",
          blobOid: firstBlob,
          recreationMode: 0o640,
        },
        {
          path: "z.txt",
          type: "regular",
          blobOid: secondBlob,
          recreationMode: null,
        },
      ],
      scope: completeScope,
    });

    const empty = await publishTestTree(store, [], completeScope);
    expect(await store.readTree(empty)).toEqual({
      format: TREE_MANIFEST_FORMAT,
      entries: [],
      scope: completeScope,
    });
  });

  it("rejects invalid recreation modes before publishing a tree", async () => {
    const blobOid = await publishTestBlob(store, Buffer.from("content"));
    for (const recreationMode of [
      -1,
      0o10000,
      1.5,
      Number.NaN,
      "0644",
      undefined,
    ]) {
      await expect(
        store.beginSnapshotPublication().publishTree(
          [
            {
              path: "file",
              type: "regular",
              blobOid,
              recreationMode: recreationMode as never,
            },
          ],
          completeScope,
        ),
      ).rejects.toMatchObject({ code: "invalid-tree-manifest" });
    }
  });

  it("rejects noncanonical regular permission fields", async () => {
    const blobOid = await publishTestBlob(store, Buffer.from("content"));

    await expect(
      store.beginSnapshotPublication().publishTree(
        [
          {
            path: "obsolete",
            type: "regular",
            blobOid,
            executable: false,
          } as never,
          {
            path: "current",
            type: "regular",
            blobOid,
            recreationMode: 0o600,
          },
        ],
        completeScope,
      ),
    ).rejects.toMatchObject({ code: "invalid-tree-manifest" });

    await expect(
      store.beginSnapshotPublication().publishTree(
        [
          {
            path: "both",
            type: "regular",
            blobOid,
            executable: false,
            recreationMode: 0o600,
          } as never,
        ],
        completeScope,
      ),
    ).rejects.toMatchObject({ code: "invalid-tree-manifest" });
  });

  it("rejects an invalid workspace scope on publication", async () => {
    await expect(
      store.beginSnapshotPublication().publishTree([], {
        kind: "git",
        repositoryPrefix: "",
        ignoreCase: false,
        gitignoreSources: [
          { path: "same/.gitignore", contentsBase64: "b25l" },
          { path: "same/.gitignore", contentsBase64: "dHdv" },
        ],
        infoExcludeBase64: "",
        globalExcludeBase64: "",
      }),
    ).rejects.toMatchObject({ code: "invalid-tree-manifest" });

    await expect(
      store.beginSnapshotPublication().publishTree([], {
        kind: "all-managed",
        format: "nested-scope-version-is-not-supported",
      } as never),
    ).rejects.toMatchObject({ code: "invalid-tree-manifest" });
  });

  it("allows archived excluded policy sources but binds managed .gitignore entries", async () => {
    const ignoreOid = await publishTestBlob(store, Buffer.from("secret\n"));
    await expect(
      store.beginSnapshotPublication().publishTree(
        [],
        gitScope({
          gitignoreSources: [{ path: ".gitignore", contents: "secret\n" }],
        }),
      ),
    ).resolves.toMatch(/^[0-9a-f]{64}$/u);

    await expect(
      store.beginSnapshotPublication().publishTree(
        [
          {
            path: ".gitignore",
            type: "regular",
            blobOid: ignoreOid,
            recreationMode: 0o600,
          },
        ],
        gitScope(),
      ),
    ).rejects.toMatchObject({ code: "invalid-tree-manifest" });
  });

  it("rejects unsafe tree entry paths", async () => {
    const blobOid = await publishTestBlob(
      store,
      Buffer.from("content", "utf8"),
    );
    for (const path of [
      "",
      "../escape",
      "/absolute",
      "a//b",
      "./child",
      "nested/../escape",
      "windows\\escape",
      "nul\0byte",
      "bad-\uD800",
      ".git/config",
      "sub/.GIT/index",
    ]) {
      await expect(
        store.beginSnapshotPublication().publishTree(
          [
            {
              path,
              type: "regular",
              blobOid,
              recreationMode: 0o600,
            },
          ],
          completeScope,
        ),
      ).rejects.toMatchObject({
        code: "invalid-tree-manifest",
      });
    }
  });

  it("rejects a symlink target containing malformed Unicode", async () => {
    await expect(
      store.beginSnapshotPublication().publishTree(
        [
          {
            path: "link",
            type: "symlink",
            target: "bad-\uD800",
            symlinkKind: null,
          },
        ],
        completeScope,
      ),
    ).rejects.toMatchObject({ code: "invalid-tree-manifest" });
  });

  it("archives nested policy sources even when an ancestor policy excludes them", async () => {
    const rootPolicy = "vendor/\n";
    const nestedPolicy = "*.tmp\n";
    const rootIgnoreOid = await publishTestBlob(store, Buffer.from(rootPolicy));
    await expect(
      publishTestTree(
        store,
        [
          {
            path: ".gitignore",
            type: "regular",
            blobOid: rootIgnoreOid,
            recreationMode: 0o600,
          },
        ],
        gitScope({
          gitignoreSources: [
            { path: ".gitignore", contents: rootPolicy },
            { path: "vendor/.gitignore", contents: nestedPolicy },
          ],
        }),
      ),
    ).resolves.toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects NFC or case-fold-colliding tree paths", async () => {
    const blobOid = await publishTestBlob(store, Buffer.from("content"));
    await expect(
      store.beginSnapshotPublication().publishTree(
        [
          {
            path: "A/x",
            type: "regular",
            blobOid,
            recreationMode: 0o600,
          },
          {
            path: "a/y",
            type: "regular",
            blobOid,
            recreationMode: 0o600,
          },
        ],
        completeScope,
      ),
    ).rejects.toMatchObject({ code: "invalid-tree-manifest" });
    await expect(
      store.beginSnapshotPublication().publishTree(
        [
          {
            path: "e\u0301.txt",
            type: "regular",
            blobOid,
            recreationMode: 0o600,
          },
        ],
        completeScope,
      ),
    ).rejects.toMatchObject({ code: "invalid-tree-manifest" });
  });

  it("rejects structurally invalid or noncanonical manifests", async () => {
    const blobOid = await publishTestBlob(
      store,
      Buffer.from("content", "utf8"),
    );

    await expect(
      publishTestTree(
        store,
        [
          {
            path: "implicit/parent",
            type: "regular",
            blobOid,
            recreationMode: 0o600,
          },
        ],
        completeScope,
      ),
    ).resolves.toMatch(/^[0-9a-f]{64}$/u);
    await expect(
      store.beginSnapshotPublication().publishTree(
        [
          {
            path: "parent",
            type: "regular",
            blobOid,
            recreationMode: 0o600,
          },
          {
            path: "parent/child",
            type: "regular",
            blobOid,
            recreationMode: 0o600,
          },
        ],
        completeScope,
      ),
    ).rejects.toMatchObject({
      code: "invalid-tree-manifest",
    });
    await expect(
      store.beginSnapshotPublication().publishTree(
        [
          {
            path: "same",
            type: "regular",
            blobOid,
            recreationMode: 0o600,
          },
          {
            path: "same",
            type: "regular",
            blobOid,
            recreationMode: 0o600,
          },
        ],
        completeScope,
      ),
    ).rejects.toMatchObject({
      code: "invalid-tree-manifest",
    });
    await expect(
      store.beginSnapshotPublication().publishTree(
        [
          {
            path: "link",
            type: "symlink",
            target: "target",
            executable: true,
          } as never,
        ],
        completeScope,
      ),
    ).rejects.toMatchObject({
      code: "invalid-tree-manifest",
    });
    await expect(
      store.beginSnapshotPublication().publishTree(
        [
          {
            path: "file",
            type: "regular",
            blobOid: "not-a-digest",
            recreationMode: 0o600,
          },
        ],
        completeScope,
      ),
    ).rejects.toMatchObject({
      code: "invalid-tree-manifest",
    });

    const empty = await publishTestTree(store, [], completeScope);
    expect((await store.readTree(empty)).entries).toEqual([]);
  });

  it("publishes no tree whose referenced blob closure is missing", async () => {
    const publication = store.beginSnapshotPublication();
    const blobOid = await publishTestBlobInPublication(
      publication,
      Buffer.from("removed after proof"),
    );
    await unlink(physicalObjectPath(root, "blobs", blobOid));

    await expect(
      publication.publishTree(
        [
          {
            path: "missing",
            type: "regular",
            blobOid,
            recreationMode: 0o600,
          },
        ],
        completeScope,
      ),
    ).rejects.toMatchObject({ code: "missing-object" });

    const treeRoot = join(root, "objects", "trees");
    expect(await readdir(treeRoot)).toEqual([]);
  });

  it("detects a tampered tree object before parsing it", async () => {
    const treeOid = await publishTestTree(store, [], completeScope);
    await writeFile(
      physicalObjectPath(root, "trees", treeOid),
      '{"format":"cyclotomy-tree-v1","entries":[]}',
    );

    await expect(store.readTree(treeOid)).rejects.toMatchObject({
      code: "object-integrity",
    });
  });

  it("rejects an oversized tree object before reading it into memory", async () => {
    const oid = "0".repeat(64);
    const path = physicalObjectPath(root, "trees", oid);
    await mkdir(join(root, "objects", "trees", oid.slice(0, 2)), {
      recursive: true,
    });
    await writeFile(path, "");
    await truncate(path, ABSOLUTE_MAX_TREE_MANIFEST_BYTES + 1);

    await expect(store.readTree(oid)).rejects.toMatchObject({
      code: "object-integrity",
    });
  });

  it("keeps the tree read bounded when the file grows after the initial stat", async () => {
    const content = Buffer.from(
      `${JSON.stringify({
        format: TREE_MANIFEST_FORMAT,
        entries: [],
        scope: completeScope,
      })}\n`,
      "utf8",
    );
    const oid = digest(content);
    const path = physicalObjectPath(root, "trees", oid);
    await mkdir(join(root, "objects", "trees", oid.slice(0, 2)), {
      recursive: true,
    });
    await writeFile(path, content);

    const prototype = await fileHandlePrototype();
    const readablePrototype = prototype as typeof prototype & {
      read(...args: unknown[]): Promise<unknown>;
    };
    const originalRead = readablePrototype.read;
    let grew = false;
    const spy = vi
      .spyOn(readablePrototype, "read")
      .mockImplementation(async function (
        this: FileHandle,
        ...args: unknown[]
      ): Promise<unknown> {
        if (!grew) {
          grew = true;
          await truncate(path, ABSOLUTE_MAX_TREE_MANIFEST_BYTES + 1);
        }
        return Reflect.apply(originalRead, this, args);
      });

    await expect(store.readTree(oid)).rejects.toMatchObject({
      code: "object-integrity",
    });
    spy.mockRestore();
    expect(grew).toBe(true);
  });

  it("enforces configured entry and encoded-manifest publication limits", async () => {
    const entryLimited = await openObjectStore(root, {
      maxEntries: 1,
      maxManifestBytes: 1024,
    });
    await expect(
      entryLimited.beginSnapshotPublication().publishTree(
        [
          { path: "a", type: "symlink", target: "a", symlinkKind: null },
          { path: "b", type: "symlink", target: "b", symlinkKind: null },
        ],
        completeScope,
      ),
    ).rejects.toMatchObject({
      code: "invalid-tree-manifest",
    });

    const byteLimited = await openObjectStore(root, {
      maxEntries: 10,
      maxManifestBytes: 1,
    });
    await expect(
      byteLimited.beginSnapshotPublication().publishTree([], completeScope),
    ).rejects.toMatchObject({ code: "invalid-tree-manifest" });
  });

  it("rejects a noncanonical manifest even when its digest matches", async () => {
    for (const bytes of [
      '{"entries":[],"format":"cyclotomy-tree-v1"}\n',
      '{"format":"cyclotomy-tree-v1","entries":[],"extra":1}\n',
    ]) {
      const content = Buffer.from(bytes, "utf8");
      const oid = digest(content);
      const shard = join(root, "objects", "trees", oid.slice(0, 2));
      await mkdir(shard, { recursive: true });
      await writeFile(join(shard, oid.slice(2)), content);

      await expect(store.readTree(oid)).rejects.toMatchObject({
        code: "object-integrity",
      });
    }
  });

  it("rejects a noncanonical scope even when its digest matches", async () => {
    const content = Buffer.from(
      `${JSON.stringify({
        format: TREE_MANIFEST_FORMAT,
        entries: [],
        scope: {
          kind: "git",
          repositoryPrefix: "",
          ignoreCase: false,
          gitignoreSources: [
            { path: "z/.gitignore", contentsBase64: "eg==" },
            { path: "a/.gitignore", contentsBase64: "YQ==" },
          ],
          infoExcludeBase64: "",
          globalExcludeBase64: "",
        },
      })}\n`,
      "utf8",
    );
    const oid = digest(content);
    const shard = join(root, "objects", "trees", oid.slice(0, 2));
    await mkdir(shard, { recursive: true });
    await writeFile(join(shard, oid.slice(2)), content);

    await expect(store.readTree(oid)).rejects.toMatchObject({
      code: "object-integrity",
    });
  });

  it("rejects a canonical object whose managed .gitignore lacks an archived source", async () => {
    const ignoreBytes = Buffer.from("secret\n");
    const content = Buffer.from(
      `${JSON.stringify({
        format: TREE_MANIFEST_FORMAT,
        entries: [
          {
            path: ".gitignore",
            type: "regular",
            blobOid: digest(ignoreBytes),
            recreationMode: 0o600,
          },
        ],
        scope: gitScope(),
      })}\n`,
      "utf8",
    );
    const oid = digest(content);
    const shard = join(root, "objects", "trees", oid.slice(0, 2));
    await mkdir(shard, { recursive: true });
    await writeFile(join(shard, oid.slice(2)), content);

    await expect(store.readTree(oid)).rejects.toMatchObject({
      code: "object-integrity",
    });
  });

  it("cleans an unpublished temp object after an fsync failure", async () => {
    const content = Buffer.from("fsync failure", "utf8");
    const oid = digest(content);
    const shard = join(root, "objects", "blobs", oid.slice(0, 2));
    await mkdir(shard);

    const prototype = await fileHandlePrototype();
    const originalSync = prototype.sync;
    let injected = false;
    const spy = vi.spyOn(prototype, "sync").mockImplementation(async function (
      this: FileHandle,
    ): Promise<void> {
      const metadata = await this.stat();
      if (metadata.isFile() && !injected) {
        injected = true;
        throw new Error("injected fsync failure");
      }
      await originalSync.call(this);
    });

    await expect(publishTestBlob(store, content)).rejects.toMatchObject({
      code: "storage-failure",
    });
    spy.mockRestore();

    expect(injected).toBe(true);
    expect(await readdir(shard)).toEqual([]);
    await expect(
      stat(physicalObjectPath(root, "blobs", oid)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await publishTestBlob(store, content)).toBe(oid);
  });

  it("recovers idempotently when parent fsync fails after rename", async (context) => {
    context.skip(
      process.platform === "win32",
      "Windows directory-entry durability is best-effort",
    );
    const content = Buffer.from("directory fsync failure", "utf8");
    const oid = digest(content);
    const prototype = await fileHandlePrototype();
    const originalSync = prototype.sync;
    let fileSynced = false;
    let injected = false;
    const spy = vi.spyOn(prototype, "sync").mockImplementation(async function (
      this: FileHandle,
    ): Promise<void> {
      const metadata = await this.stat();
      if (metadata.isFile()) {
        fileSynced = true;
        await originalSync.call(this);
        return;
      }
      if (fileSynced && !injected) {
        injected = true;
        throw new Error("injected parent-directory fsync failure");
      }
      await originalSync.call(this);
    });

    await expect(publishTestBlob(store, content)).rejects.toMatchObject({
      code: "storage-failure",
    });
    spy.mockRestore();

    expect(injected).toBe(true);
    expect(Buffer.from(await store.readBlob(oid))).toEqual(content);
    expect(await publishTestBlob(store, content)).toBe(oid);
  });

  it("requires a safe explicit root and preserves unrelated entries", async () => {
    await expect(openObjectStore("relative/store")).rejects.toMatchObject({
      code: "invalid-root",
    });
    await expect(openObjectStore(parsePath(root).root)).rejects.toMatchObject({
      code: "invalid-root",
    });

    const regularRoot = join(root, "regular-root");
    await writeFile(regularRoot, "not a directory");
    await expect(openObjectStore(regularRoot)).rejects.toMatchObject({
      code: "storage-failure",
    });

    const realRoot = join(root, "real-root");
    const linkedRoot = join(root, "linked-root");
    await mkdir(realRoot);
    await symlink(realRoot, linkedRoot);
    await expect(openObjectStore(linkedRoot)).rejects.toMatchObject({
      code: "storage-failure",
    });

    const sentinel = join(root, "unrelated");
    await writeFile(sentinel, "keep");
    await openObjectStore(root);
    expect(await stat(sentinel)).toMatchObject({
      size: 4,
    });
  });
});

/** Rewrite a file keeping its exact size and mtime so only content drifts. */
async function corruptInPlace(
  path: string,
  replacement: Buffer,
): Promise<void> {
  const before = await stat(path);
  expect(replacement.byteLength).toBe(before.size);
  await writeFile(path, replacement);
  // Decimal seconds preserve sub-millisecond precision that Date truncates.
  await utimes(path, before.atimeMs / 1000, before.mtimeMs / 1000);
}

async function publishTwoBlobTree(
  store: ObjectStore,
): Promise<{ treeOid: string; blobOids: string[] }> {
  const blobOids = [
    await publishTestBlob(store, Buffer.from("alpha\n", "utf8")),
    await publishTestBlob(store, Buffer.from("beta\n\n", "utf8")),
  ];
  const treeOid = await publishTestTree(
    store,
    [
      {
        path: "a.txt",
        type: "regular",
        blobOid: blobOids[0]!,
        recreationMode: 0o600,
      },
      {
        path: "b.txt",
        type: "regular",
        blobOid: blobOids[1]!,
        recreationMode: 0o600,
      },
    ],
    completeScope,
  );
  return { treeOid, blobOids };
}

describe("targeted blob verification", () => {
  let root: string;
  let store: ObjectStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cyclotomy-targeted-verification-"));
    store = await openObjectStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("readTreeManifest ignores the blob closure that readTree still enforces", async () => {
    const { treeOid, blobOids } = await publishTwoBlobTree(store);
    await unlink(physicalObjectPath(root, "blobs", blobOids[0]!));

    const manifest = await store.readTreeManifest(treeOid);
    expect(manifest.entries).toHaveLength(2);
    await expect(store.readTree(treeOid)).rejects.toMatchObject({
      code: "missing-object",
    });
    await expect(store.readTreeManifest("a".repeat(64))).rejects.toMatchObject({
      code: "missing-object",
    });
  });

  it("never treats matching size and mtime as a substitute for hashing", async () => {
    const { treeOid, blobOids } = await publishTwoBlobTree(store);
    await store.readTree(treeOid);

    // Same size and mtime, drifted content: both deep tree verification and a
    // direct content read must still reject the object.
    const blobPath = physicalObjectPath(root, "blobs", blobOids[0]!);
    await corruptInPlace(blobPath, Buffer.from("ALPHA\n", "utf8"));
    await expect(store.readTree(treeOid)).rejects.toMatchObject({
      code: "object-integrity",
    });
    await expect(store.readBlob(blobOids[0]!)).rejects.toMatchObject({
      code: "object-integrity",
    });
  });

  it("authenticates only the explicitly requested blob set", async () => {
    const { treeOid, blobOids } = await publishTwoBlobTree(store);
    const corruptPath = physicalObjectPath(root, "blobs", blobOids[0]!);
    await corruptInPlace(corruptPath, Buffer.from("ALPHA\n", "utf8"));

    await expect(
      store.verifyBlobs([blobOids[1]!, blobOids[1]!]),
    ).resolves.toBeUndefined();
    await expect(store.verifyBlobs([blobOids[0]!])).rejects.toMatchObject({
      code: "object-integrity",
    });
    await expect(store.readTreeManifest(treeOid)).resolves.toBeDefined();
  });

  it("reuses blob proofs only inside one snapshot publication", async () => {
    const publication = store.beginSnapshotPublication();
    const verify = vi.spyOn(store, "verifyBlobs");
    const outsideOid = await publishTestBlob(store, Buffer.from("outside"));
    await expect(
      publication.publishTree(
        [
          {
            path: "outside.txt",
            type: "regular",
            blobOid: outsideOid,
            recreationMode: 0o600,
          },
        ],
        completeScope,
      ),
    ).rejects.toMatchObject({ code: "invalid-tree-manifest" });

    const insideOid = await publishTestBlobInPublication(
      publication,
      Buffer.from("inside"),
    );
    const treeOid = await publication.publishTree(
      [
        {
          path: "inside.txt",
          type: "regular",
          blobOid: insideOid,
          recreationMode: 0o600,
        },
      ],
      completeScope,
    );
    expect(verify).not.toHaveBeenCalled();
    expect((await store.readTreeManifest(treeOid)).entries).toHaveLength(1);
    await expect(
      publishTestBlobInPublication(publication, Buffer.from("too late")),
    ).rejects.toMatchObject({ code: "storage-failure" });
  });

  it("rejects a blob changed after its snapshot-publication proof", async () => {
    const publication = store.beginSnapshotPublication();
    const oid = await publishTestBlobInPublication(
      publication,
      Buffer.from("stable"),
    );
    const path = physicalObjectPath(root, "blobs", oid);
    const replacement = `${path}.replacement`;
    await writeFile(replacement, "broken");
    await rename(replacement, path);

    await expect(
      publication.publishTree(
        [
          {
            path: "file.txt",
            type: "regular",
            blobOid: oid,
            recreationMode: 0o600,
          },
        ],
        completeScope,
      ),
    ).rejects.toMatchObject({ code: "object-integrity" });
    expect(await readdir(join(root, "objects", "trees"))).toEqual([]);
  });
});
