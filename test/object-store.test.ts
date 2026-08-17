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
  parseContentId,
  parseMetadataId,
} from "../src/infrastructure/content-store/ids.ts";
import { PackCatalog } from "../src/infrastructure/content-store/pack-catalog.ts";
import { encodePack } from "../src/infrastructure/content-store/pack.ts";
import {
  decodeRecord,
  encodeRecord,
  type RecordEnvelope,
} from "../src/infrastructure/content-store/record.ts";
import {
  ObjectStoreError,
  nativeObjectStoreRepository,
  openObjectStore,
  upgradeStoredTree,
  TreeImportAdmissionError,
  TreeImportSourceError,
  type NativeObjectStore,
  type ObjectStore,
  type TreeImportAdmission,
} from "../src/infrastructure/object-store.ts";
import {
  ABSOLUTE_MAX_TREE_MANIFEST_BYTES,
  type TreeEntry,
} from "../src/infrastructure/tree-formats/manifest-codec.ts";
import { CURRENT_TREE_MANIFEST_FORMAT } from "../src/infrastructure/tree-formats/current.ts";
import { TREE_MANIFEST_FORMAT_V1 } from "../src/infrastructure/tree-formats/v1.ts";
import {
  nativeObjectLayout,
  nativePackPath,
} from "../src/infrastructure/workspace-store.ts";
import { withWorkspaceLock } from "../src/infrastructure/workspace-lock.ts";
import {
  publishTestBlob,
  publishTestBlobInPublication,
  publishTestTree,
} from "./object-store-fixture.ts";
import { ALL_MANAGED_SCOPE, gitScope } from "./workspace-scope-fixture.ts";
const completeScope = ALL_MANAGED_SCOPE;
const TEST_BARRIER_WATCHDOG_MS = 30_000;
const DEFAULT_IMPORT_ADMISSION = Object.freeze<TreeImportAdmission>({
  validateImportedTree: async () => ({ kind: "accepted" }),
  maxSnapshotBytes: Number.MAX_SAFE_INTEGER,
});

function importAdmission(
  overrides: Partial<TreeImportAdmission> = {},
): TreeImportAdmission {
  return { ...DEFAULT_IMPORT_ADMISSION, ...overrides };
}

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

async function publishedObjectPaths(root: string): Promise<string[]> {
  const paths: string[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relative = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await visit(path, relative);
      } else {
        paths.push(relative);
      }
    }
  };
  for (const namespace of ["blobs", "trees", "records", "packs"] as const) {
    await visit(join(root, "objects", namespace), namespace);
  }
  return paths.sort();
}

async function installTreeObject(
  root: string,
  content: Buffer,
): Promise<string> {
  const oid = digest(content);
  const path = physicalObjectPath(root, "trees", oid);
  await mkdir(join(root, "objects", "trees", oid.slice(0, 2)), {
    recursive: true,
  });
  await writeFile(path, content, { flag: "wx" });
  return oid;
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
  let store: NativeObjectStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cyclotomy-object-store-"));
    store = await openObjectStore(root);
  });

  it("keeps a streamed-file failure primary when its handle close also fails", async () => {
    const source = join(root, "stream-source");
    const content = Buffer.from("stream cleanup evidence", "utf8");
    await writeFile(source, content);
    const prototype = await fileHandlePrototype();
    const primary = new ObjectStoreError(
      "invalid-blob",
      "injected streamed-file failure",
    );
    const cleanup = new Error("injected stream close failure");
    let closeCalls = 0;
    vi.spyOn(prototype, "stat").mockImplementationOnce(async function (
      this: FileHandle,
    ): Promise<Stats> {
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
      throw primary;
    });

    const publication = store.beginSnapshotPublication();
    try {
      const failure = await publication
        .publishBlobFromFile(source, digest(content), content.byteLength)
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({
        name: "ObjectStoreError",
        code: "invalid-blob",
        cause: expect.any(AggregateError),
      });
      expect(
        ((failure as ObjectStoreError).cause as AggregateError).errors,
      ).toEqual([primary, cleanup]);
      expect(closeCalls).toBe(1);
    } finally {
      await publication.close();
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("publishes content at its sharded loose-record path and reads it back", async () => {
    const content = Buffer.from("hello\n", "utf8");
    const oid = await publishTestBlob(store, content);

    expect(oid).toBe(digest(content));
    expect(oid).toMatch(/^[0-9a-f]{64}$/u);
    expect((await stat(contentRecordPath(root, oid))).isFile()).toBe(true);
    await expect(
      stat(physicalObjectPath(root, "blobs", oid)),
    ).rejects.toMatchObject({ code: "ENOENT" });
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
    expect((await stat(contentRecordPath(root, oid))).size).toBeGreaterThan(0);
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

  it("rejects a multiply-linked workspace stream source", async () => {
    const source = join(root, "multiply-linked-stream-source.bin");
    const alias = join(root, "stream-source-alias.bin");
    const content = Buffer.from("workspace source must have one name", "utf8");
    await writeFile(source, content);
    await link(source, alias);

    await expect(
      store
        .beginSnapshotPublication()
        .publishBlobFromFile(source, digest(content), content.byteLength),
    ).rejects.toMatchObject({ code: "invalid-blob" });
    expect(await readFile(alias)).toEqual(content);
  });

  it("does not rewrite objects on an idempotent publication", async () => {
    const content = Buffer.from("stable object", "utf8");
    const blobOid = await publishTestBlob(store, content);
    const blobPath = contentRecordPath(root, blobOid);
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

  it("migrates an authenticated published-v1 tree to a deterministic v2 object", async () => {
    const legacyBytes = Buffer.from(
      `${JSON.stringify({
        format: TREE_MANIFEST_FORMAT_V1,
        entries: [],
        scope: completeScope,
      })}\n`,
    );
    const oldTreeOid = await installTreeObject(root, legacyBytes);

    await expect(store.readTree(oldTreeOid)).rejects.toMatchObject({
      code: "object-integrity",
    });
    await expect(
      upgradeStoredTree(store, oldTreeOid, TREE_MANIFEST_FORMAT_V1),
    ).resolves.toEqual({ kind: "already-target", treeOid: oldTreeOid });
    const first = await upgradeStoredTree(
      store,
      oldTreeOid,
      CURRENT_TREE_MANIFEST_FORMAT,
    );
    expect(first).toMatchObject({
      kind: "upgraded",
      sourceTreeOid: oldTreeOid,
    });
    if (first.kind !== "upgraded") throw new Error("expected upgrade");
    expect(first.treeOid).not.toBe(oldTreeOid);
    expect(
      await readFile(physicalObjectPath(root, "trees", oldTreeOid)),
    ).toEqual(legacyBytes);
    expect(await store.readTree(first.treeOid)).toEqual({
      format: CURRENT_TREE_MANIFEST_FORMAT,
      entries: [],
      scope: completeScope,
    });

    const migratedPath = physicalObjectPath(root, "trees", first.treeOid);
    const beforeRetry = await stat(migratedPath);
    await expect(
      upgradeStoredTree(store, oldTreeOid, CURRENT_TREE_MANIFEST_FORMAT),
    ).resolves.toEqual(first);
    const afterRetry = await stat(migratedPath);
    expect(afterRetry.ino).toBe(beforeRetry.ino);
    expect(afterRetry.mtimeMs).toBe(beforeRetry.mtimeMs);
  });

  it("rejects a canonical future stored-tree root in current reads and migration", async () => {
    const futureBytes = Buffer.from(
      `${JSON.stringify({
        kind: "cyclotomy-tree-root",
        version: 1,
        format: "cyclotomy-tree-v4",
        profile: "cyclotomy-prolly-key-v1",
        height: 0,
        entryCount: 0,
        entryMapRoot: null,
        scopeOid: "0".repeat(64),
      })}\n`,
    );
    const treeOid = await installTreeObject(root, futureBytes);

    await expect(store.readTree(treeOid)).rejects.toMatchObject({
      code: "object-integrity",
    });
    await expect(
      upgradeStoredTree(store, treeOid, CURRENT_TREE_MANIFEST_FORMAT),
    ).rejects.toMatchObject({ code: "object-integrity" });
  });

  it("verifies durable tree closures independently of current capture limits", async () => {
    const content = Buffer.from("historical blob", "utf8");
    const publishingStore = await openObjectStore(root, {
      maxFileBytes: content.byteLength,
    });
    const blobOid = await publishTestBlob(publishingStore, content);
    const legacyBytes = Buffer.from(
      `${JSON.stringify({
        format: TREE_MANIFEST_FORMAT_V1,
        entries: [
          {
            path: "historical.txt",
            type: "regular",
            blobOid,
            recreationMode: 0o600,
          },
        ],
        scope: completeScope,
      })}\n`,
    );
    const legacyTreeOid = await installTreeObject(root, legacyBytes);
    const limitedStore = await openObjectStore(root, { maxFileBytes: 1 });

    await expect(limitedStore.readTree(legacyTreeOid)).rejects.toMatchObject({
      code: "object-integrity",
    });
    const upgraded = await upgradeStoredTree(
      limitedStore,
      legacyTreeOid,
      CURRENT_TREE_MANIFEST_FORMAT,
    );
    expect(upgraded).toMatchObject({
      kind: "upgraded",
      sourceTreeOid: legacyTreeOid,
    });
    if (upgraded.kind !== "upgraded") throw new Error("expected upgrade");
    await expect(
      limitedStore.readTreeManifest(upgraded.treeOid),
    ).resolves.toMatchObject({ format: CURRENT_TREE_MANIFEST_FORMAT });
    await expect(limitedStore.readTree(upgraded.treeOid)).rejects.toMatchObject(
      { code: "object-integrity" },
    );
    await expect(
      upgradeStoredTree(
        limitedStore,
        upgraded.treeOid,
        CURRENT_TREE_MANIFEST_FORMAT,
      ),
    ).resolves.toEqual({
      kind: "already-target",
      treeOid: upgraded.treeOid,
    });
  });

  it("authenticates the closure before returning an already-target migration", async () => {
    const content = Buffer.from("authenticated closure", "utf8");
    const publishingStore = await openObjectStore(root, {
      maxFileBytes: content.byteLength,
    });
    const blobOid = await publishTestBlob(publishingStore, content);
    const treeOid = await publishTestTree(
      publishingStore,
      [
        {
          path: "file.txt",
          type: "regular",
          blobOid,
          recreationMode: 0o600,
        },
      ],
      completeScope,
    );
    const limitedStore = await openObjectStore(root, { maxFileBytes: 1 });

    await expect(
      upgradeStoredTree(limitedStore, treeOid, CURRENT_TREE_MANIFEST_FORMAT),
    ).resolves.toEqual({ kind: "already-target", treeOid });

    await writeFile(
      contentRecordPath(root, blobOid),
      Buffer.alloc(content.byteLength, 0x78),
    );
    await expect(
      upgradeStoredTree(limitedStore, treeOid, CURRENT_TREE_MANIFEST_FORMAT),
    ).rejects.toMatchObject({ code: "object-integrity" });
  });

  it("keeps a valid v1 tree isolated when portable v2 conversion is lossy", async () => {
    const blobOid = await publishTestBlob(store, Buffer.from("legacy"));
    const entry = (path: string) => ({
      path,
      type: "regular" as const,
      blobOid,
      recreationMode: 0o600,
    });
    const legacyBytes = Buffer.from(
      `${JSON.stringify({
        format: TREE_MANIFEST_FORMAT_V1,
        entries: [entry("Σ/a"), entry("ς/b")],
        scope: completeScope,
      })}\n`,
    );
    const treeOid = await installTreeObject(root, legacyBytes);

    await expect(store.readTree(treeOid)).rejects.toMatchObject({
      code: "object-integrity",
    });
    await expect(
      upgradeStoredTree(store, treeOid, CURRENT_TREE_MANIFEST_FORMAT),
    ).resolves.toMatchObject({
      kind: "incompatible",
      treeOid,
    });
    expect(await readdir(join(root, "objects", "trees"))).toEqual([
      treeOid.slice(0, 2),
    ]);
  });

  it("detects loose-record tampering and never overwrites the evidence", async () => {
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

    await writeFile(contentRecordPath(root, blobOid), "tampered");
    await expect(store.readBlob(blobOid)).rejects.toMatchObject({
      code: "object-integrity",
    });
    await expect(store.readTree(treeOid)).rejects.toMatchObject({
      code: "object-integrity",
    });
    await expect(publishTestBlob(store, original)).rejects.toMatchObject({
      code: "object-integrity",
    });
    await expect(store.readBlob(blobOid)).rejects.toMatchObject({
      code: "object-integrity",
    });
    await expect(store.readTree(treeOid)).rejects.toMatchObject({
      code: "object-integrity",
    });
  });

  it("never repairs through a hardlinked object namespace entry", async () => {
    const original = Buffer.from("original", "utf8");
    const blobOid = await publishTestBlob(store, original);
    const objectPath = contentRecordPath(root, blobOid);
    const outsideLink = join(root, "outside-link");
    await link(objectPath, outsideLink);

    await expect(publishTestBlob(store, original)).rejects.toMatchObject({
      code: "object-integrity",
    });
    expect(await readFile(outsideLink)).toEqual(await readFile(objectPath));
  });

  it("never repairs through a symlinked object namespace entry", async () => {
    const original = Buffer.from("original", "utf8");
    const blobOid = await publishTestBlob(store, original);
    const objectPath = contentRecordPath(root, blobOid);
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
      code: "object-integrity",
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
    const objectPath = contentRecordPath(root, blobOid);
    const missingOutside = join(root, "missing-outside-target");
    await unlink(objectPath);
    await symlink(
      missingOutside,
      objectPath,
      process.platform === "win32" ? "file" : undefined,
    );

    await expect(publishTestBlob(store, original)).rejects.toMatchObject({
      code: "object-integrity",
    });
    expect((await lstat(objectPath)).isSymbolicLink()).toBe(true);
    await expect(readFile(missingOutside)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a pathname replaced after its object handle opens", async () => {
    const content = Buffer.from("stable object", "utf8");
    const blobOid = await publishTestBlob(store, content);
    const objectPath = contentRecordPath(root, blobOid);
    const encodedRecord = await readFile(objectPath);
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
        await writeFile(objectPath, encodedRecord);
      }
      return observation;
    });

    await expect(store.readBlob(blobOid)).rejects.toMatchObject({
      code: "object-integrity",
    });
    expect(replaced).toBe(true);
    expect(await readFile(objectPath)).toEqual(encodedRecord);
    expect(await readFile(displacedPath)).toEqual(encodedRecord);
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
      format: CURRENT_TREE_MANIFEST_FORMAT,
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
      evaluator: {
        version: "git version fixture",
        precomposeUnicode: false,
      },
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
      format: CURRENT_TREE_MANIFEST_FORMAT,
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

  it("does not apply the regular-file limit to v3 symlink and policy content", async () => {
    const limited = await openObjectStore(root, { maxFileBytes: 1 });
    const entries: TreeEntry[] = [
      {
        path: "link",
        type: "symlink",
        target: "target/longer-than-one-byte",
        symlinkKind: "file",
      },
    ];
    const scope = gitScope({
      infoExclude: "private/\n",
      globalExclude: "*.scratch\n",
    });
    const treeOid = await publishTestTree(limited, entries, scope);

    await expect(limited.readTree(treeOid)).resolves.toEqual({
      format: CURRENT_TREE_MANIFEST_FORMAT,
      entries,
      scope,
    });
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
      format: CURRENT_TREE_MANIFEST_FORMAT,
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
      format: CURRENT_TREE_MANIFEST_FORMAT,
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
        evaluator: {
          version: "git version fixture",
          precomposeUnicode: false,
        },
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
    await unlink(contentRecordPath(root, blobOid));

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

  it.each(["ordinary", "sparse"] as const)(
    "rejects an oversized %s blob from its opened-handle stat before reading or hashing",
    async (fixture) => {
      const maxFileBytes = 4;
      const limited = await openObjectStore(root, { maxFileBytes });
      const oid = fixture === "ordinary" ? "1".repeat(64) : "2".repeat(64);
      const path = physicalObjectPath(root, "blobs", oid);
      await mkdir(join(root, "objects", "blobs", oid.slice(0, 2)), {
        recursive: true,
      });
      if (fixture === "ordinary") {
        // Deliberately does not match `oid`: the size gate must win before the
        // digest can inspect any bytes.
        await writeFile(path, Buffer.alloc(maxFileBytes + 1, 0x61));
      } else {
        await writeFile(path, "");
        await truncate(path, maxFileBytes + 1);
      }

      const prototype = await fileHandlePrototype();
      const readablePrototype = prototype as typeof prototype & {
        read(...args: unknown[]): Promise<unknown>;
      };
      const originalRead = readablePrototype.read;
      let reads = 0;
      const spy = vi
        .spyOn(readablePrototype, "read")
        .mockImplementation(async function (
          this: FileHandle,
          ...args: unknown[]
        ): Promise<unknown> {
          reads += 1;
          return Reflect.apply(originalRead, this, args);
        });

      await expect(limited.readBlob(oid)).rejects.toMatchObject({
        code: "object-integrity",
        message: expect.stringContaining(`${maxFileBytes}-byte limit`),
      });
      await expect(limited.verifyBlobs([oid])).rejects.toMatchObject({
        code: "object-integrity",
        message: expect.stringContaining(`${maxFileBytes}-byte limit`),
      });
      spy.mockRestore();
      expect(reads).toBe(0);
    },
  );

  it("keeps the tree read bounded when the file grows after the initial stat", async () => {
    const content = Buffer.from(
      `${JSON.stringify({
        format: CURRENT_TREE_MANIFEST_FORMAT,
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
        format: CURRENT_TREE_MANIFEST_FORMAT,
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
        format: CURRENT_TREE_MANIFEST_FORMAT,
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
    const shard = join(root, "objects", "records", "content", oid.slice(0, 2));
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
    await expect(stat(contentRecordPath(root, oid))).rejects.toMatchObject({
      code: "ENOENT",
    });
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
async function corruptInPlace(path: string): Promise<void> {
  const before = await stat(path);
  const replacement = Buffer.from(await readFile(path));
  replacement[replacement.byteLength - 1] =
    (replacement[replacement.byteLength - 1] ?? 0) ^ 0xff;
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

describe("cross-store tree import", () => {
  it("copies authenticated deduplicated closures and preserves their ids", async () => {
    const sourceRoot = await mkdtemp(
      join(tmpdir(), "cyclotomy-import-source-"),
    );
    const targetRoot = await mkdtemp(
      join(tmpdir(), "cyclotomy-import-target-"),
    );
    try {
      const source = await openObjectStore(sourceRoot);
      const target = await openObjectStore(targetRoot);
      const blobOid = await publishTestBlob(source, Buffer.from("shared\n"));
      const firstTree = await publishTestTree(
        source,
        [
          {
            path: "first.txt",
            type: "regular",
            blobOid,
            recreationMode: 0o644,
          },
        ],
        completeScope,
      );
      const secondTree = await publishTestTree(
        source,
        [
          {
            path: "second.txt",
            type: "regular",
            blobOid,
            recreationMode: 0o600,
          },
        ],
        completeScope,
      );
      const validated: string[] = [];

      await target.importTreesFrom(
        source,
        [firstTree, secondTree, firstTree],
        importAdmission({
          validateImportedTree: async (treeOid) => {
            validated.push(treeOid);
            return { kind: "accepted" };
          },
        }),
      );

      expect(validated).toEqual([firstTree, secondTree]);
      await expect(target.readTree(firstTree)).resolves.toEqual(
        await source.readTree(firstTree),
      );
      await expect(target.readTree(secondTree)).resolves.toEqual(
        await source.readTree(secondTree),
      );
      expect(Buffer.from(await target.readBlob(blobOid)).toString("utf8")).toBe(
        "shared\n",
      );
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(targetRoot, { recursive: true, force: true });
    }
  });

  it("applies the target blob limit without inheriting the source's current limit", async () => {
    const sourceRoot = await mkdtemp(
      join(tmpdir(), "cyclotomy-import-source-"),
    );
    const targetRoot = await mkdtemp(
      join(tmpdir(), "cyclotomy-import-target-"),
    );
    try {
      const content = Buffer.from("historical source blob", "utf8");
      const publishingSource = await openObjectStore(sourceRoot, {
        maxFileBytes: content.byteLength,
      });
      const blobOid = await publishTestBlob(publishingSource, content);
      const treeOid = await publishTestTree(
        publishingSource,
        [
          {
            path: "historical.txt",
            type: "regular",
            blobOid,
            recreationMode: 0o600,
          },
        ],
        completeScope,
      );
      const limitedSource = await openObjectStore(sourceRoot, {
        maxFileBytes: 1,
      });
      const target = await openObjectStore(targetRoot, {
        maxFileBytes: content.byteLength,
      });

      await expect(limitedSource.readTree(treeOid)).rejects.toMatchObject({
        code: "object-integrity",
      });
      await expect(
        target.importTreesFrom(
          limitedSource,
          [treeOid],
          DEFAULT_IMPORT_ADMISSION,
        ),
      ).resolves.toBeUndefined();
      await expect(target.readTree(treeOid)).resolves.toBeDefined();
      await expect(target.readBlob(blobOid)).resolves.toEqual(content);
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(targetRoot, { recursive: true, force: true });
    }
  });

  it("does not let an asynchronous import validator mutate authenticated manifests", async () => {
    const sourceRoot = await mkdtemp(
      join(tmpdir(), "cyclotomy-import-source-"),
    );
    const targetRoot = await mkdtemp(
      join(tmpdir(), "cyclotomy-import-target-"),
    );
    try {
      const source = await openObjectStore(sourceRoot);
      const target = await openObjectStore(targetRoot);
      const blobOid = await publishTestBlob(source, Buffer.from("stable\n"));
      const treeOid = await publishTestTree(
        source,
        [
          {
            path: "stable.txt",
            type: "regular",
            blobOid,
            recreationMode: 0o644,
          },
        ],
        gitScope({
          gitignoreSources: [{ path: ".gitignore", contents: "ignored/\n" }],
        }),
      );

      await target.importTreesFrom(
        source,
        [treeOid],
        importAdmission({
          validateImportedTree: async (_treeOid, manifest) => {
            await Promise.resolve();
            expect(Object.isFrozen(manifest)).toBe(true);
            expect(Object.isFrozen(manifest.entries)).toBe(true);
            expect(Object.isFrozen(manifest.entries[0])).toBe(true);
            expect(Reflect.set(manifest, "format", "forged-format")).toBe(
              false,
            );
            expect(
              Reflect.set(manifest.entries[0]!, "blobOid", "f".repeat(64)),
            ).toBe(false);
            expect(Reflect.deleteProperty(manifest.entries, "0")).toBe(false);
            expect(manifest.scope.kind).toBe("git");
            if (manifest.scope.kind === "git") {
              expect(Object.isFrozen(manifest.scope)).toBe(true);
              expect(Object.isFrozen(manifest.scope.gitignoreSources)).toBe(
                true,
              );
              expect(Object.isFrozen(manifest.scope.gitignoreSources[0])).toBe(
                true,
              );
              expect(
                Reflect.set(manifest.scope, "repositoryPrefix", "mutated"),
              ).toBe(false);
              expect(
                Reflect.set(
                  manifest.scope.gitignoreSources[0]!,
                  "path",
                  "mutated",
                ),
              ).toBe(false);
            }
            return { kind: "accepted" };
          },
        }),
      );

      await expect(target.readTree(treeOid)).resolves.toEqual(
        await source.readTree(treeOid),
      );
      await expect(target.readBlob(blobOid)).resolves.toEqual(
        Buffer.from("stable\n"),
      );
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(targetRoot, { recursive: true, force: true });
    }
  });

  it("classifies a source tree removed after admission as a publication source failure", async () => {
    const sourceRoot = await mkdtemp(
      join(tmpdir(), "cyclotomy-import-source-"),
    );
    const targetRoot = await mkdtemp(
      join(tmpdir(), "cyclotomy-import-target-"),
    );
    let syncSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const source = await openObjectStore(sourceRoot);
      const target = await openObjectStore(targetRoot);
      const blobOid = await publishTestBlob(source, Buffer.from("source"));
      const treeOid = await publishTestTree(
        source,
        [
          {
            path: "source.txt",
            type: "regular",
            blobOid,
            recreationMode: 0o644,
          },
        ],
        completeScope,
      );
      const prototype = await fileHandlePrototype();
      const originalSync = prototype.sync;
      let removed = false;
      syncSpy = vi.spyOn(prototype, "sync").mockImplementation(async function (
        this: FileHandle,
      ) {
        if (!removed && (await this.stat()).isFile()) {
          removed = true;
          await unlink(physicalObjectPath(sourceRoot, "trees", treeOid));
        }
        return originalSync.call(this);
      });

      const rejection = await target
        .importTreesFrom(source, [treeOid], DEFAULT_IMPORT_ADMISSION)
        .catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(TreeImportSourceError);
      expect(rejection).not.toBeInstanceOf(TreeImportAdmissionError);
      expect(Buffer.from(await target.readBlob(blobOid))).toEqual(
        Buffer.from("source"),
      );
      await expect(target.readTree(treeOid)).rejects.toMatchObject({
        code: "missing-object",
      });
    } finally {
      syncSpy?.mockRestore();
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(targetRoot, { recursive: true, force: true });
    }
  });

  it("keeps target publication failures distinct from source failures", async () => {
    const sourceRoot = await mkdtemp(
      join(tmpdir(), "cyclotomy-import-source-"),
    );
    const targetRoot = await mkdtemp(
      join(tmpdir(), "cyclotomy-import-target-"),
    );
    try {
      const source = await openObjectStore(sourceRoot);
      const target = await openObjectStore(targetRoot);
      const blobOid = await publishTestBlob(source, Buffer.from("source"));
      const treeOid = await publishTestTree(
        source,
        [
          {
            path: "source.txt",
            type: "regular",
            blobOid,
            recreationMode: 0o644,
          },
        ],
        completeScope,
      );
      const targetContentRoot = join(
        targetRoot,
        "objects",
        "records",
        "content",
      );
      await rm(targetContentRoot, { recursive: true });
      await writeFile(targetContentRoot, "blocks target publication");

      const rejection = await target
        .importTreesFrom(source, [treeOid], DEFAULT_IMPORT_ADMISSION)
        .catch((error: unknown) => error);

      expect(rejection).toMatchObject({ code: "storage-failure" });
      expect(rejection).not.toBeInstanceOf(TreeImportAdmissionError);
      expect(rejection).not.toBeInstanceOf(TreeImportSourceError);
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(targetRoot, { recursive: true, force: true });
    }
  });

  it("prefers a later target failure over the first source failure across active lanes", async () => {
    const sourceRoot = await mkdtemp(
      join(tmpdir(), "cyclotomy-import-source-"),
    );
    const targetRoot = await mkdtemp(
      join(tmpdir(), "cyclotomy-import-target-"),
    );
    let syncSpy: ReturnType<typeof vi.spyOn> | undefined;
    const originalHasInstance = Object.getOwnPropertyDescriptor(
      TreeImportSourceError,
      Symbol.hasInstance,
    );
    let hasInstanceOverridden = false;
    let sourceClassifiedTimer: NodeJS.Timeout | undefined;
    try {
      const source = await openObjectStore(sourceRoot);
      const target = await openObjectStore(targetRoot);
      const { treeOid } = await publishTwoBlobTree(source);
      const prototype = await fileHandlePrototype();
      const originalSync = prototype.sync;
      const sourceFailure = new TreeImportSourceError(
        new Error("source lane failed first"),
      );
      const targetFailure = new ObjectStoreError(
        "storage-failure",
        "target lane failed later",
      );
      const events: string[] = [];
      let signalSourceClassified: () => void = () => {};
      const sourceClassified = new Promise<void>((resolve, reject) => {
        sourceClassifiedTimer = setTimeout(() => {
          reject(new Error("timed out waiting for source-lane classification"));
        }, TEST_BARRIER_WATCHDOG_MS);
        signalSourceClassified = () => {
          clearTimeout(sourceClassifiedTimer);
          sourceClassifiedTimer = undefined;
          resolve();
        };
      });
      Object.defineProperty(TreeImportSourceError, Symbol.hasInstance, {
        configurable: true,
        value(candidate: unknown): boolean {
          const matches = Function.prototype[Symbol.hasInstance].call(
            TreeImportSourceError,
            candidate,
          ) as boolean;
          if (matches && candidate === sourceFailure) {
            events.push("source-classified");
            signalSourceClassified();
          }
          return matches;
        },
      });
      hasInstanceOverridden = true;
      let regularFileSyncs = 0;
      syncSpy = vi.spyOn(prototype, "sync").mockImplementation(async function (
        this: FileHandle,
      ) {
        if (!(await this.stat()).isFile()) {
          return originalSync.call(this);
        }
        regularFileSyncs += 1;
        if (regularFileSyncs === 1) {
          events.push("source-thrown");
          throw sourceFailure;
        }
        if (regularFileSyncs === 2) {
          await sourceClassified;
          // Let runPool retain the classified source failure before the
          // already-active second lane reports the target failure.
          await new Promise<void>((resolve) => setImmediate(resolve));
          events.push("target-thrown");
          throw targetFailure;
        }
        return originalSync.call(this);
      });

      const rejection = await target
        .importTreesFrom(source, [treeOid], DEFAULT_IMPORT_ADMISSION)
        .catch((error: unknown) => error);

      expect(events).toEqual([
        "source-thrown",
        "source-classified",
        "target-thrown",
      ]);
      expect(rejection).toBe(targetFailure);
      expect(rejection).not.toBeInstanceOf(TreeImportSourceError);
    } finally {
      clearTimeout(sourceClassifiedTimer);
      syncSpy?.mockRestore();
      if (hasInstanceOverridden) {
        if (originalHasInstance === undefined) {
          Reflect.deleteProperty(TreeImportSourceError, Symbol.hasInstance);
        } else {
          Object.defineProperty(
            TreeImportSourceError,
            Symbol.hasInstance,
            originalHasInstance,
          );
        }
      }
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(targetRoot, { recursive: true, force: true });
    }
  });

  it("publishes nothing when one source blob in the bundle is corrupt", async () => {
    const sourceRoot = await mkdtemp(
      join(tmpdir(), "cyclotomy-import-source-"),
    );
    const targetRoot = await mkdtemp(
      join(tmpdir(), "cyclotomy-import-target-"),
    );
    try {
      const source = await openObjectStore(sourceRoot);
      const target = await openObjectStore(targetRoot);
      const goodBlobOid = await publishTestBlob(source, Buffer.from("good"));
      const corruptBlobOid = await publishTestBlob(
        source,
        Buffer.from("intact"),
      );
      const treeOid = await publishTestTree(
        source,
        [
          {
            path: "good.txt",
            type: "regular",
            blobOid: goodBlobOid,
            recreationMode: 0o644,
          },
          {
            path: "corrupt.txt",
            type: "regular",
            blobOid: corruptBlobOid,
            recreationMode: 0o644,
          },
        ],
        completeScope,
      );
      await truncate(contentRecordPath(sourceRoot, corruptBlobOid), 1);

      await expect(
        target.importTreesFrom(source, [treeOid], DEFAULT_IMPORT_ADMISSION),
      ).rejects.toMatchObject({ code: "object-integrity" });
      expect(await publishedObjectPaths(targetRoot)).toEqual([]);
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(targetRoot, { recursive: true, force: true });
    }
  });

  it("enforces target file and snapshot byte limits during import", async () => {
    const sourceRoot = await mkdtemp(
      join(tmpdir(), "cyclotomy-import-source-"),
    );
    const targetRoot = await mkdtemp(
      join(tmpdir(), "cyclotomy-import-target-"),
    );
    try {
      const source = await openObjectStore(sourceRoot);
      const target = await openObjectStore(targetRoot, { maxFileBytes: 6 });
      const smallBlobOid = await publishTestBlob(source, Buffer.from("ok"));
      const blobOid = await publishTestBlob(source, Buffer.from("seven!!"));
      const fileTree = await publishTestTree(
        source,
        [
          {
            path: "small.txt",
            type: "regular",
            blobOid: smallBlobOid,
            recreationMode: 0o644,
          },
          {
            path: "file.txt",
            type: "regular",
            blobOid,
            recreationMode: 0o644,
          },
        ],
        completeScope,
      );
      await expect(
        target.importTreesFrom(source, [fileTree], DEFAULT_IMPORT_ADMISSION),
      ).rejects.toThrow(/target file limit/u);
      expect(await publishedObjectPaths(targetRoot)).toEqual([]);

      const snapshotTree = await publishTestTree(
        source,
        [
          {
            path: "first.txt",
            type: "regular",
            blobOid,
            recreationMode: 0o644,
          },
          {
            path: "second.txt",
            type: "regular",
            blobOid,
            recreationMode: 0o644,
          },
          {
            path: "link",
            type: "symlink",
            target: "file.txt",
            symlinkKind: "file",
          },
        ],
        completeScope,
      );
      const snapshotTarget = await openObjectStore(targetRoot, {
        maxFileBytes: 16,
      });
      await expect(
        snapshotTarget.importTreesFrom(
          source,
          [snapshotTree],
          importAdmission({ maxSnapshotBytes: 20 }),
        ),
      ).rejects.toThrow(/target snapshot limit/u);
      expect(await publishedObjectPaths(targetRoot)).toEqual([]);
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(targetRoot, { recursive: true, force: true });
    }
  });

  it("rejects an oversized imported blob before hashing its corrupt bytes", async () => {
    const sourceRoot = await mkdtemp(
      join(tmpdir(), "cyclotomy-import-source-"),
    );
    const targetRoot = await mkdtemp(
      join(tmpdir(), "cyclotomy-import-target-"),
    );
    try {
      const source = await openObjectStore(sourceRoot);
      const target = await openObjectStore(targetRoot, { maxFileBytes: 6 });
      const bytes = Buffer.from("seven!!");
      const blobOid = await publishTestBlob(source, bytes);
      const treeOid = await publishTestTree(
        source,
        [
          {
            path: "oversized.txt",
            type: "regular",
            blobOid,
            recreationMode: 0o600,
          },
        ],
        completeScope,
      );
      // Keep the oversized length but invalidate the digest. Target admission
      // must report its byte limit without doing the otherwise failing hash.
      await writeFile(
        contentRecordPath(sourceRoot, blobOid),
        encodeRecord({
          kind: "content",
          encoding: "raw",
          logicalId: parseContentId(blobOid),
          decodedLength: bytes.byteLength,
          payload: Buffer.from("corrupt"),
        }),
      );

      await expect(
        target.importTreesFrom(source, [treeOid], DEFAULT_IMPORT_ADMISSION),
      ).rejects.toThrow(/target file limit/u);
      expect(await publishedObjectPaths(targetRoot)).toEqual([]);
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(targetRoot, { recursive: true, force: true });
    }
  });

  it("preflights every manifest before publishing earlier closures", async () => {
    const sourceRoot = await mkdtemp(
      join(tmpdir(), "cyclotomy-import-source-"),
    );
    const targetRoot = await mkdtemp(
      join(tmpdir(), "cyclotomy-import-target-"),
    );
    try {
      const source = await openObjectStore(sourceRoot);
      const target = await openObjectStore(targetRoot);
      const blobOid = await publishTestBlob(source, Buffer.from("valid"));
      const validTree = await publishTestTree(
        source,
        [
          {
            path: "valid.txt",
            type: "regular",
            blobOid,
            recreationMode: 0o644,
          },
        ],
        completeScope,
      );
      const invalidTree = await installTreeObject(
        sourceRoot,
        Buffer.from("{}\n"),
      );

      await expect(
        target.importTreesFrom(
          source,
          [validTree, invalidTree],
          DEFAULT_IMPORT_ADMISSION,
        ),
      ).rejects.toMatchObject({ code: "object-integrity" });
      expect(await publishedObjectPaths(targetRoot)).toEqual([]);
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(targetRoot, { recursive: true, force: true });
    }
  });

  it("preflights every tree policy before publishing earlier closures", async () => {
    const sourceRoot = await mkdtemp(
      join(tmpdir(), "cyclotomy-import-source-"),
    );
    const targetRoot = await mkdtemp(
      join(tmpdir(), "cyclotomy-import-target-"),
    );
    try {
      const source = await openObjectStore(sourceRoot);
      const target = await openObjectStore(targetRoot);
      const firstBlob = await publishTestBlob(source, Buffer.from("first"));
      const secondBlob = await publishTestBlob(source, Buffer.from("second"));
      const firstTree = await publishTestTree(
        source,
        [
          {
            path: "first.txt",
            type: "regular",
            blobOid: firstBlob,
            recreationMode: 0o644,
          },
        ],
        completeScope,
      );
      const rejectedTree = await publishTestTree(
        source,
        [
          {
            path: "second.txt",
            type: "regular",
            blobOid: secondBlob,
            recreationMode: 0o644,
          },
        ],
        completeScope,
      );

      const operationalFailure = new Error("policy evaluator unavailable");
      const operational = await target
        .importTreesFrom(
          source,
          [firstTree, rejectedTree],
          importAdmission({
            validateImportedTree: async () => {
              throw operationalFailure;
            },
          }),
        )
        .catch((error: unknown) => error);
      expect(operational).toBe(operationalFailure);
      expect(operational).not.toBeInstanceOf(TreeImportAdmissionError);
      expect(await publishedObjectPaths(targetRoot)).toEqual([]);

      const rejection = await target
        .importTreesFrom(
          source,
          [firstTree, rejectedTree],
          importAdmission({
            validateImportedTree: async (treeOid) => {
              return treeOid === rejectedTree
                ? { kind: "rejected", cause: new Error("policy rejected") }
                : { kind: "accepted" };
            },
          }),
        )
        .catch((error: unknown) => error);
      expect(rejection).toBeInstanceOf(TreeImportAdmissionError);
      expect(rejection).toMatchObject({ code: "storage-failure" });
      expect(await publishedObjectPaths(targetRoot)).toEqual([]);

      const sourceShapedCause = new TreeImportSourceError(
        new Error("policy diagnostic resembles a source failure"),
      );
      const taggedRejection = await target
        .importTreesFrom(
          source,
          [rejectedTree],
          importAdmission({
            validateImportedTree: async () => ({
              kind: "rejected",
              cause: sourceShapedCause,
            }),
          }),
        )
        .catch((error: unknown) => error);
      expect(taggedRejection).toBeInstanceOf(TreeImportAdmissionError);
      expect(taggedRejection).not.toBeInstanceOf(TreeImportSourceError);
      expect(await publishedObjectPaths(targetRoot)).toEqual([]);
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(targetRoot, { recursive: true, force: true });
    }
  });

  it("keeps an admission rejection primary when scope cleanup also fails", async () => {
    const sourceRoot = await mkdtemp(
      join(tmpdir(), "cyclotomy-import-source-"),
    );
    const targetRoot = await mkdtemp(
      join(tmpdir(), "cyclotomy-import-target-"),
    );
    try {
      const source = await openObjectStore(sourceRoot);
      const target = await openObjectStore(targetRoot);
      const treeOid = await publishTestTree(source, [], completeScope);
      const rejectionCause = new Error("policy rejected imported tree");
      const cleanupFailure = new Error("injected target scope close failure");
      const targetRepository = nativeObjectStoreRepository(target, "test");
      const sourceRepository = nativeObjectStoreRepository(source, "test");
      const closeTargetScope =
        targetRepository.closeResolutionScope.bind(targetRepository);
      const targetClose = vi
        .spyOn(targetRepository, "closeResolutionScope")
        .mockImplementationOnce(async (scope) => {
          await closeTargetScope(scope);
          throw cleanupFailure;
        });
      const sourceClose = vi.spyOn(sourceRepository, "closeResolutionScope");

      const failure = await target
        .importTreesFrom(
          source,
          [treeOid],
          importAdmission({
            validateImportedTree: async () => ({
              kind: "rejected",
              cause: rejectionCause,
            }),
          }),
        )
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(TreeImportAdmissionError);
      expect(failure).not.toBeInstanceOf(AggregateError);
      expect(failure).toMatchObject({
        code: "storage-failure",
        cause: expect.any(AggregateError),
      });
      const retained = (failure as TreeImportAdmissionError)
        .cause as AggregateError;
      expect(retained.errors).toHaveLength(2);
      expect(retained.errors[0]).toBeInstanceOf(TreeImportAdmissionError);
      expect(retained.errors[1]).toBe(cleanupFailure);
      expect(targetClose).toHaveBeenCalledTimes(1);
      expect(sourceClose).toHaveBeenCalledTimes(1);
      expect(await publishedObjectPaths(targetRoot)).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(targetRoot, { recursive: true, force: true });
    }
  });

  it("preflights every tree quota before publishing earlier trees", async () => {
    const sourceRoot = await mkdtemp(
      join(tmpdir(), "cyclotomy-import-source-"),
    );
    const targetRoot = await mkdtemp(
      join(tmpdir(), "cyclotomy-import-target-"),
    );
    try {
      const source = await openObjectStore(sourceRoot);
      const target = await openObjectStore(targetRoot);
      const blobOid = await publishTestBlob(source, Buffer.from("four"));
      const firstTree = await publishTestTree(
        source,
        [
          {
            path: "first.txt",
            type: "regular",
            blobOid,
            recreationMode: 0o644,
          },
        ],
        completeScope,
      );
      const oversizedTree = await publishTestTree(
        source,
        [
          {
            path: "first.txt",
            type: "regular",
            blobOid,
            recreationMode: 0o644,
          },
          {
            path: "second.txt",
            type: "regular",
            blobOid,
            recreationMode: 0o644,
          },
        ],
        completeScope,
      );

      await expect(
        target.importTreesFrom(
          source,
          [firstTree, oversizedTree],
          importAdmission({
            maxSnapshotBytes: 7,
          }),
        ),
      ).rejects.toThrow(/target snapshot limit/u);
      expect(await publishedObjectPaths(targetRoot)).toEqual([]);
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(targetRoot, { recursive: true, force: true });
    }
  });

  it("counts shared blobs per path and symlinks in UTF-8 bytes", async () => {
    const sourceRoot = await mkdtemp(
      join(tmpdir(), "cyclotomy-import-source-"),
    );
    const targetRoot = await mkdtemp(
      join(tmpdir(), "cyclotomy-import-target-"),
    );
    try {
      const source = await openObjectStore(sourceRoot);
      const target = await openObjectStore(targetRoot);
      const blobOid = await publishTestBlob(source, Buffer.from("seven!!"));
      const treeOid = await publishTestTree(
        source,
        [
          {
            path: "first.txt",
            type: "regular",
            blobOid,
            recreationMode: 0o644,
          },
          {
            path: "second.txt",
            type: "regular",
            blobOid,
            recreationMode: 0o644,
          },
          {
            path: "link",
            type: "symlink",
            target: "猫",
            symlinkKind: "file",
          },
        ],
        completeScope,
      );

      await expect(
        target.importTreesFrom(
          source,
          [treeOid],
          importAdmission({ maxSnapshotBytes: 16 }),
        ),
      ).rejects.toThrow(/target snapshot limit/u);
      expect(await publishedObjectPaths(targetRoot)).toEqual([]);

      await expect(
        target.importTreesFrom(
          source,
          [treeOid],
          importAdmission({ maxSnapshotBytes: 17 }),
        ),
      ).resolves.toBeUndefined();
      expect(await target.readBlob(blobOid)).toEqual(Buffer.from("seven!!"));
      await expect(target.readTree(treeOid)).resolves.toMatchObject({
        entries: expect.arrayContaining([
          expect.objectContaining({ path: "link", target: "猫" }),
        ]),
      });
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(targetRoot, { recursive: true, force: true });
    }
  });
});

describe("targeted blob verification", () => {
  let root: string;
  let store: NativeObjectStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cyclotomy-targeted-verification-"));
    store = await openObjectStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("readTreeManifest ignores the blob closure that readTree still enforces", async () => {
    const { treeOid, blobOids } = await publishTwoBlobTree(store);
    await unlink(contentRecordPath(root, blobOids[0]!));

    const manifest = await store.readTreeManifest(treeOid);
    expect(manifest.entries).toHaveLength(2);
    await expect(store.readTree(treeOid)).rejects.toMatchObject({
      code: "missing-object",
    });
    await expect(store.readTreeManifest("a".repeat(64))).rejects.toMatchObject({
      code: "missing-object",
    });
  });

  it("authenticates each shared pack once per tree read, publication, and import side", async () => {
    const contents = [
      Buffer.from("packed alpha\n", "utf8"),
      Buffer.from("packed beta\n", "utf8"),
    ];
    const blobOids = await Promise.all(
      contents.map((content) => publishTestBlob(store, content)),
    );
    const entries: TreeEntry[] = [
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
    ];
    const treeOid = await publishTestTree(store, entries, completeScope);
    const closure = await store.readTreeClosure(treeOid);
    const layout = nativeObjectLayout(root);
    const dataRecords = await Promise.all(
      blobOids.map(async (oid) =>
        decodeRecord(await readFile(contentRecordPath(root, oid)), {
          maxDecodedBytes: 1024,
          maxPayloadBytes: 1024,
        }),
      ),
    );
    const structuralRecords: RecordEnvelope[] = await Promise.all(
      closure.structuralObjects.map(async ({ kind, oid }) => {
        const bytes = await readFile(physicalObjectPath(root, "trees", oid));
        return {
          kind:
            kind === "root"
              ? "tree-root"
              : kind === "node"
                ? "tree-node"
                : "scope",
          encoding: "raw",
          logicalId: parseMetadataId(oid),
          decodedLength: bytes.byteLength,
          payload: bytes,
        };
      }),
    );
    const dataPack = await encodePack({
      packClass: "data",
      records: dataRecords,
    });
    const metadataPack = await encodePack(
      { packClass: "metadata", records: structuralRecords },
      {
        verifyMetadataId: (_kind, logicalId, bytes) =>
          logicalId === digest(bytes),
      },
    );
    for (const publication of [dataPack, metadataPack]) {
      await mkdir(join(layout.packs, publication.pack.packId.slice(0, 2)), {
        recursive: true,
      });
      await writeFile(
        nativePackPath(layout, publication.pack.packId),
        publication.bytes,
      );
    }
    const catalog = new PackCatalog(layout);
    const inventory = await catalog.inventory();
    await withWorkspaceLock(
      root,
      "publish test pack index",
      async (authority) =>
        catalog.publishMultiPackIndexCache(
          catalog.rebuildMultiPackIndex(inventory),
          inventory,
          authority,
        ),
    );
    await Promise.all([
      ...blobOids.map((oid) => unlink(contentRecordPath(root, oid))),
      ...closure.structuralObjects.map(({ oid }) =>
        unlink(physicalObjectPath(root, "trees", oid)),
      ),
    ]);

    const openPack = vi.spyOn(PackCatalog.prototype, "openPack");
    await expect(store.readTree(treeOid)).resolves.toMatchObject({ entries });
    expect(
      openPack.mock.calls.filter(([packId]) => packId === dataPack.pack.packId),
    ).toHaveLength(1);
    expect(
      openPack.mock.calls.filter(
        ([packId]) => packId === metadataPack.pack.packId,
      ),
    ).toHaveLength(1);

    openPack.mockClear();
    const publication = store.beginSnapshotPublication();
    await Promise.all(
      blobOids.map((oid, index) =>
        publication.publishBlobFromFile(
          join(root, `absent-${index}`),
          oid,
          contents[index]!.byteLength,
        ),
      ),
    );
    await expect(publication.publishTree(entries, completeScope)).resolves.toBe(
      treeOid,
    );
    expect(
      openPack.mock.calls.filter(([packId]) => packId === dataPack.pack.packId),
    ).toHaveLength(1);
    expect(
      openPack.mock.calls.filter(
        ([packId]) => packId === metadataPack.pack.packId,
      ),
    ).toHaveLength(1);

    const targetRoot = await mkdtemp(join(tmpdir(), "cyclotomy-scope-target-"));
    try {
      const target = await openObjectStore(targetRoot);
      const targetLayout = nativeObjectLayout(targetRoot);
      for (const packed of [dataPack, metadataPack]) {
        await mkdir(join(targetLayout.packs, packed.pack.packId.slice(0, 2)), {
          recursive: true,
        });
        await writeFile(
          nativePackPath(targetLayout, packed.pack.packId),
          packed.bytes,
        );
      }
      const targetCatalog = new PackCatalog(targetLayout);
      const targetInventory = await targetCatalog.inventory();
      await withWorkspaceLock(
        targetRoot,
        "publish target test pack index",
        async (authority) =>
          targetCatalog.publishMultiPackIndexCache(
            targetCatalog.rebuildMultiPackIndex(targetInventory),
            targetInventory,
            authority,
          ),
      );

      openPack.mockClear();
      await target.importTreesFrom(store, [treeOid], DEFAULT_IMPORT_ADMISSION);
      expect(
        openPack.mock.calls.filter(
          ([packId]) => packId === dataPack.pack.packId,
        ),
      ).toHaveLength(2);
      expect(
        openPack.mock.calls.filter(
          ([packId]) => packId === metadataPack.pack.packId,
        ),
      ).toHaveLength(2);
    } finally {
      await rm(targetRoot, { recursive: true, force: true });
    }

    const interrupted = store.beginSnapshotPublication();
    await Promise.all(
      blobOids.map((oid, index) =>
        interrupted.publishBlobFromFile(
          join(root, `still-absent-${index}`),
          oid,
          contents[index]!.byteLength,
        ),
      ),
    );
    await unlink(nativePackPath(layout, dataPack.pack.packId));
    await expect(
      interrupted.publishTree(entries, completeScope),
    ).rejects.toMatchObject({ code: "missing-object" });
  });

  it("never treats matching size and mtime as a substitute for hashing", async () => {
    const { treeOid, blobOids } = await publishTwoBlobTree(store);
    await store.readTree(treeOid);

    // Same size and mtime, drifted content: both deep tree verification and a
    // direct content read must still reject the object.
    const blobPath = contentRecordPath(root, blobOids[0]!);
    await corruptInPlace(blobPath);
    await expect(store.readTree(treeOid)).rejects.toMatchObject({
      code: "object-integrity",
    });
    await expect(store.readBlob(blobOids[0]!)).rejects.toMatchObject({
      code: "object-integrity",
    });
  });

  it("authenticates only the explicitly requested blob set", async () => {
    const { treeOid, blobOids } = await publishTwoBlobTree(store);
    const corruptPath = contentRecordPath(root, blobOids[0]!);
    await corruptInPlace(corruptPath);

    await expect(
      store.verifyBlobs([blobOids[1]!, blobOids[1]!]),
    ).resolves.toBeUndefined();
    await expect(store.verifyBlobs([blobOids[0]!])).rejects.toMatchObject({
      code: "object-integrity",
    });
    await expect(store.readTreeManifest(treeOid)).resolves.toBeDefined();
  });

  it("reuses blob proofs only inside one snapshot publication", async () => {
    const rejectedPublication = store.beginSnapshotPublication();
    const verify = vi.spyOn(store, "verifyBlobs");
    const outsideOid = await publishTestBlob(store, Buffer.from("outside"));
    await expect(
      rejectedPublication.publishTree(
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

    const publication = store.beginSnapshotPublication();
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
    const path = contentRecordPath(root, oid);
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
