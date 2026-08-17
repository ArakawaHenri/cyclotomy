import { describe, expect, it } from "vitest";

import type { TreeOid } from "../src/domain/model.ts";
import { createCurrentTreeManifest } from "../src/infrastructure/tree-formats/current.ts";
import {
  encodeTreeManifestDocument,
  type TreeEntry,
  type TreeManifest,
  type TreeManifestLimits,
} from "../src/infrastructure/tree-formats/manifest-codec.ts";
import {
  storedObjectOid,
  type StoredTreeReadAccess,
  type StoredTreeStructuralKind,
  type StoredTreeWriteAccess,
} from "../src/infrastructure/tree-formats/stored-adapter.ts";
import {
  publishStoredTree,
  readStoredTree,
  STORED_TREE_FORMAT_V2,
  STORED_TREE_FORMAT_V3,
} from "../src/infrastructure/tree-formats/stored-registry.ts";
import {
  TREE_FORMAT_V2,
  TREE_MANIFEST_FORMAT_V2,
} from "../src/infrastructure/tree-formats/v2.ts";
import { TREE_MANIFEST_FORMAT_V3 } from "../src/infrastructure/tree-formats/v3.ts";
import {
  TREE_V3_MAXIMUM_NODE_PAYLOAD,
  TREE_V3_MAXIMUM_STRUCTURAL_OBJECT_BYTES,
} from "../src/infrastructure/tree-formats/v3-storage.ts";

const limits: TreeManifestLimits = {
  maxEntries: 10_000,
  maxManifestBytes: 16 * 1024 * 1024,
  maxPathBytes: 128 * 1024,
  maxPathComponents: 256,
};

interface StoredStructure {
  readonly kind: StoredTreeStructuralKind;
  readonly bytes: Buffer;
}

function memoryAccess() {
  const structures = new Map<TreeOid, StoredStructure>();
  const contents = new Map<string, Buffer>();
  const read: StoredTreeReadAccess = {
    async readStructuralObject(kind, oid, maximumBytes) {
      const object = structures.get(oid);
      if (object === undefined || object.kind !== kind) {
        throw new Error(`missing ${kind} ${oid}`);
      }
      if (object.bytes.byteLength > maximumBytes) {
        throw new Error("structural read exceeds caller bound");
      }
      return Buffer.from(object.bytes);
    },
    async readContent(contentId, maximumBytes) {
      const content = contents.get(contentId);
      if (content === undefined)
        throw new Error(`missing content ${contentId}`);
      if (content.byteLength > maximumBytes) {
        throw new Error("content read exceeds caller bound");
      }
      return Buffer.from(content);
    },
  };
  const write: StoredTreeWriteAccess = {
    async publishStructuralObject(kind, oid, bytes) {
      expect(storedObjectOid(bytes)).toBe(oid);
      const previous = structures.get(oid);
      if (previous !== undefined) {
        expect(previous.kind).toBe(kind);
        expect(previous.bytes.equals(Buffer.from(bytes))).toBe(true);
      } else {
        structures.set(oid, { kind, bytes: Buffer.from(bytes) });
      }
    },
    async ensureContent(contentId, bytes) {
      expect(storedObjectOid(bytes)).toBe(contentId);
      const previous = contents.get(contentId);
      if (previous !== undefined) {
        expect(previous.equals(Buffer.from(bytes))).toBe(true);
      } else {
        contents.set(contentId, Buffer.from(bytes));
      }
    },
  };
  return { structures, contents, read, write };
}

function v3Manifest(
  entries: readonly TreeEntry[],
  scope: unknown = { kind: "all-managed" },
): TreeManifest {
  return createCurrentTreeManifest(entries, scope, limits);
}

function manyEntries(count: number): readonly TreeEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `src/file-${index.toString().padStart(5, "0")}.ts`,
    type: "regular" as const,
    blobOid: index.toString(16).padStart(64, "0"),
    recreationMode: 0o644,
  }));
}

function manyGitignoreSources(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    path: `rules/${index.toString().padStart(5, "0")}-${"x".repeat(512)}/.gitignore`,
    contentsBase64: Buffer.from(`ignored-${index}\n`, "utf8").toString(
      "base64",
    ),
  }));
}

function canonicalJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

describe("stored tree format v3", () => {
  it("has a history-independent TreeOid and authenticates the complete DAG", async () => {
    const firstStore = memoryAccess();
    const secondStore = memoryAccess();
    const ascending = manyEntries(800);
    const descending = [...ascending].reverse();

    const firstOid = await publishStoredTree(
      v3Manifest(ascending),
      firstStore.write,
      limits,
    );
    const secondOid = await STORED_TREE_FORMAT_V3.publish(
      v3Manifest(descending),
      secondStore.write,
      limits,
    );

    expect(firstOid).toBe(
      "44d8410ecb551793be0647acda2aca66593612cbfb0eb703516dff621d03a21b",
    );
    expect(secondOid).toBe(firstOid);
    expect([...secondStore.structures.keys()].sort()).toEqual(
      [...firstStore.structures.keys()].sort(),
    );
    const authenticated = await readStoredTree(
      firstOid,
      firstStore.read,
      limits,
    );
    expect(authenticated.manifest.entries).toEqual(ascending);
    expect(authenticated.structuralObjectOids).toContain(firstOid);
    expect(authenticated.structuralObjects[0]).toEqual({
      kind: "root",
      oid: firstOid,
    });
    expect(
      authenticated.structuralObjects.some(({ kind }) => kind === "scope"),
    ).toBe(true);
    expect(
      authenticated.structuralObjects.some(({ kind }) => kind === "node"),
    ).toBe(true);
    expect(authenticated.structuralObjects.map(({ oid }) => oid)).toEqual(
      authenticated.structuralObjectOids,
    );
    expect(authenticated.contentIds).toEqual(
      ascending.map((entry) => {
        if (entry.type !== "regular") throw new Error("expected regular entry");
        return entry.blobOid;
      }),
    );
    expect(Object.isFrozen(authenticated.manifest)).toBe(true);
  });

  it("keeps key boundaries stable when one regular file changes", async () => {
    const store = memoryAccess();
    const original = manyEntries(800);
    const originalOid = await STORED_TREE_FORMAT_V3.publish(
      v3Manifest(original),
      store.write,
      limits,
    );
    const originalNodes = new Set(
      [...store.structures]
        .filter(([, object]) => object.kind === "node")
        .map(([oid]) => oid),
    );
    const changed = original.map((entry, index) =>
      index === 400 && entry.type === "regular"
        ? { ...entry, blobOid: "f".repeat(64) }
        : entry,
    );
    const changedOid = await STORED_TREE_FORMAT_V3.publish(
      v3Manifest(changed),
      store.write,
      limits,
    );
    const changedTree = await STORED_TREE_FORMAT_V3.readAuthenticated(
      changedOid,
      store.read,
      limits,
    );
    const changedNodes = changedTree.structuralObjectOids.filter(
      (oid) => store.structures.get(oid)?.kind === "node",
    );

    expect(changedOid).not.toBe(originalOid);
    expect(changedNodes.length).toBe(originalNodes.size);
    expect(
      changedNodes.filter((oid) => originalNodes.has(oid)).length,
    ).toBeGreaterThan(0);
  });

  it("factors symlink targets and Git policy as raw content IDs", async () => {
    const store = memoryAccess();
    const ignoreBytes = Buffer.from("dist/\n", "utf8");
    const infoBytes = Buffer.from("private/\n", "utf8");
    const globalBytes = Buffer.from("*.bak\n", "utf8");
    const targetBytes = Buffer.from("../target.txt", "utf8");
    const entries: TreeEntry[] = [
      {
        path: ".gitignore",
        type: "regular",
        blobOid: storedObjectOid(ignoreBytes),
        recreationMode: 0o644,
      },
      {
        path: "link",
        type: "symlink",
        target: targetBytes.toString("utf8"),
        symlinkKind: "file",
      },
    ];
    const manifest = v3Manifest(entries, {
      kind: "git",
      repositoryPrefix: "",
      evaluator: {
        version: "git version fixture",
        precomposeUnicode: false,
      },
      ignoreCase: false,
      gitignoreSources: [
        { path: ".gitignore", contentsBase64: ignoreBytes.toString("base64") },
      ],
      infoExcludeBase64: infoBytes.toString("base64"),
      globalExcludeBase64: globalBytes.toString("base64"),
    });
    const treeOid = await STORED_TREE_FORMAT_V3.publish(
      manifest,
      store.write,
      limits,
    );

    expect([...store.contents.keys()].sort()).toEqual(
      [ignoreBytes, infoBytes, globalBytes, targetBytes]
        .map((bytes) => storedObjectOid(bytes))
        .sort(),
    );
    const authenticated = await STORED_TREE_FORMAT_V3.readAuthenticated(
      treeOid,
      store.read,
      limits,
    );
    expect(authenticated.manifest).toEqual(manifest);
    if (authenticated.manifest.scope.kind !== "git") {
      throw new Error("expected Git scope");
    }
    expect(Object.isFrozen(authenticated.manifest.scope.evaluator)).toBe(true);
    expect([...authenticated.contentIds].sort()).toEqual(
      [
        storedObjectOid(ignoreBytes),
        storedObjectOid(targetBytes),
        storedObjectOid(infoBytes),
        storedObjectOid(globalBytes),
      ].sort(),
    );
  });

  it("persists Git evaluator provenance as part of tree identity", async () => {
    const store = memoryAccess();
    const baseScope = {
      kind: "git",
      repositoryPrefix: "",
      evaluator: {
        version: "git version fixture",
        precomposeUnicode: false,
      },
      ignoreCase: false,
      gitignoreSources: [],
      infoExcludeBase64: "",
      globalExcludeBase64: "",
    } as const;
    const baseline = v3Manifest([], baseScope);
    const versionChanged = v3Manifest([], {
      ...baseScope,
      evaluator: {
        ...baseScope.evaluator,
        version: "git version fixture-patched",
      },
    });
    const precomposeChanged = v3Manifest([], {
      ...baseScope,
      evaluator: { ...baseScope.evaluator, precomposeUnicode: true },
    });
    const legacy = v3Manifest([], {
      ...baseScope,
      evaluator: null,
    });

    const oids = await Promise.all(
      [baseline, versionChanged, precomposeChanged, legacy].map((manifest) =>
        STORED_TREE_FORMAT_V3.publish(manifest, store.write, limits),
      ),
    );
    expect(new Set(oids)).toHaveLength(oids.length);
    await expect(
      Promise.all(
        oids.map((oid) =>
          STORED_TREE_FORMAT_V3.readAuthenticated(oid, store.read, limits),
        ),
      ),
    ).resolves.toEqual(
      [baseline, versionChanged, precomposeChanged, legacy].map((manifest) =>
        expect.objectContaining({ manifest }),
      ),
    );
  });

  it("pages Git scope sources into a canonical history-independent DAG", async () => {
    const firstStore = memoryAccess();
    const secondStore = memoryAccess();
    const sources = manyGitignoreSources(400);
    const scope = {
      kind: "git",
      repositoryPrefix: "",
      evaluator: {
        version: "git version fixture",
        precomposeUnicode: false,
      },
      ignoreCase: false,
      gitignoreSources: sources,
      infoExcludeBase64: "",
      globalExcludeBase64: "",
    };
    const manifest = v3Manifest([], scope);
    const firstOid = await STORED_TREE_FORMAT_V3.publish(
      manifest,
      firstStore.write,
      limits,
    );
    const secondOid = await STORED_TREE_FORMAT_V3.publish(
      v3Manifest([], {
        ...scope,
        gitignoreSources: [...sources].reverse(),
      }),
      secondStore.write,
      limits,
    );

    expect(firstOid).toBe(
      "dc26617bb20f5a2ff9b41c30a8c8818c9d5c0db71fb6f1fb10bf03af85f37951",
    );
    expect(secondOid).toBe(firstOid);
    expect([...secondStore.structures.keys()].sort()).toEqual(
      [...firstStore.structures.keys()].sort(),
    );
    const sourceNodes = [...firstStore.structures.values()].filter(
      ({ kind, bytes }) =>
        kind === "scope" &&
        (
          JSON.parse(bytes.toString("utf8")) as {
            kind?: string;
          }
        ).kind === "cyclotomy-tree-scope-source-node",
    );
    expect(sourceNodes.length).toBeGreaterThan(1);
    expect(
      sourceNodes.some(
        ({ bytes }) =>
          (JSON.parse(bytes.toString("utf8")) as { level: number }).level > 0,
      ),
    ).toBe(true);
    expect(
      sourceNodes.every(
        ({ bytes }) =>
          bytes.byteLength <= TREE_V3_MAXIMUM_STRUCTURAL_OBJECT_BYTES,
      ),
    ).toBe(true);

    const treeRoot = JSON.parse(
      firstStore.structures.get(firstOid)!.bytes.toString("utf8"),
    ) as { scopeOid: TreeOid };
    const scopeRoot = JSON.parse(
      firstStore.structures.get(treeRoot.scopeOid)!.bytes.toString("utf8"),
    ) as Record<string, unknown>;
    expect(scopeRoot).toMatchObject({
      scopeKind: "git",
      evaluator: {
        version: "git version fixture",
        precomposeUnicode: false,
      },
      gitignoreSourceCount: sources.length,
    });
    expect(scopeRoot.gitignoreSourceRoot).toMatch(/^[0-9a-f]{64}$/u);
    expect(scopeRoot).not.toHaveProperty("gitignoreSources");

    const authenticated = await STORED_TREE_FORMAT_V3.readAuthenticated(
      firstOid,
      firstStore.read,
      limits,
    );
    expect(authenticated.manifest).toEqual(manifest);
    expect([...authenticated.structuralObjectOids].sort()).toEqual(
      [...firstStore.structures.keys()].sort(),
    );
  });

  it("round-trips a legal Git scope path larger than the soft node target", async () => {
    const store = memoryAccess();
    const longPath = `rules/${"x".repeat(96 * 1024)}/.gitignore`;
    const manifest = v3Manifest([], {
      kind: "git",
      repositoryPrefix: "",
      evaluator: {
        version: "git version fixture",
        precomposeUnicode: false,
      },
      ignoreCase: false,
      gitignoreSources: [{ path: longPath, contentsBase64: "" }],
      infoExcludeBase64: "",
      globalExcludeBase64: "",
    });
    const treeOid = await STORED_TREE_FORMAT_V3.publish(
      manifest,
      store.write,
      limits,
    );
    const sourceLeaf = [...store.structures.values()].find(
      ({ kind, bytes }) =>
        kind === "scope" &&
        (
          JSON.parse(bytes.toString("utf8")) as {
            kind?: string;
          }
        ).kind === "cyclotomy-tree-scope-source-node",
    );

    expect(sourceLeaf!.bytes.byteLength).toBeGreaterThan(
      TREE_V3_MAXIMUM_NODE_PAYLOAD,
    );
    expect(sourceLeaf!.bytes.byteLength).toBeLessThanOrEqual(
      TREE_V3_MAXIMUM_STRUCTURAL_OBJECT_BYTES,
    );
    await expect(
      STORED_TREE_FORMAT_V3.readAuthenticated(treeOid, store.read, limits),
    ).resolves.toMatchObject({ manifest });
  });

  it("rejects a readable but noncanonical Git scope-source partition", async () => {
    const store = memoryAccess();
    const sources = manyGitignoreSources(400);
    const treeOid = await STORED_TREE_FORMAT_V3.publish(
      v3Manifest([], {
        kind: "git",
        repositoryPrefix: "",
        evaluator: {
          version: "git version fixture",
          precomposeUnicode: false,
        },
        ignoreCase: false,
        gitignoreSources: sources,
        infoExcludeBase64: "",
        globalExcludeBase64: "",
      }),
      store.write,
      limits,
    );
    const root = JSON.parse(
      store.structures.get(treeOid)!.bytes.toString("utf8"),
    ) as Record<string, unknown>;
    const scope = JSON.parse(
      store.structures.get(root.scopeOid as TreeOid)!.bytes.toString("utf8"),
    ) as Record<string, unknown>;
    const mergedSources = [...store.structures.values()]
      .filter(({ kind, bytes }) => {
        if (kind !== "scope") return false;
        const document = JSON.parse(bytes.toString("utf8")) as {
          kind?: string;
          level?: number;
        };
        return (
          document.kind === "cyclotomy-tree-scope-source-node" &&
          document.level === 0
        );
      })
      .flatMap(
        ({ bytes }) =>
          (
            JSON.parse(bytes.toString("utf8")) as {
              sources: Array<{ path: string }>;
            }
          ).sources,
      )
      .sort((left, right) =>
        Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
      );
    const mergedLeaf = canonicalJson({
      kind: "cyclotomy-tree-scope-source-node",
      version: 1,
      level: 0,
      sources: mergedSources,
    });
    const mergedLeafOid = storedObjectOid(mergedLeaf);
    store.structures.set(mergedLeafOid, { kind: "scope", bytes: mergedLeaf });
    const changedScope = canonicalJson({
      ...scope,
      gitignoreSourceRoot: mergedLeafOid,
    });
    const changedScopeOid = storedObjectOid(changedScope);
    store.structures.set(changedScopeOid, {
      kind: "scope",
      bytes: changedScope,
    });
    const changedRoot = canonicalJson({ ...root, scopeOid: changedScopeOid });
    const changedTreeOid = storedObjectOid(changedRoot);
    store.structures.set(changedTreeOid, {
      kind: "root",
      bytes: changedRoot,
    });

    await expect(
      STORED_TREE_FORMAT_V3.readAuthenticated(
        changedTreeOid,
        store.read,
        limits,
      ),
    ).rejects.toThrow("not the canonical rebuild");
  });

  it("rejects a readable but noncanonical Prolly partition", async () => {
    const store = memoryAccess();
    const treeOid = await STORED_TREE_FORMAT_V3.publish(
      v3Manifest(manyEntries(800)),
      store.write,
      limits,
    );
    const rootObject = store.structures.get(treeOid)!;
    const root = JSON.parse(rootObject.bytes.toString("utf8")) as Record<
      string,
      unknown
    >;
    const leaves = [...store.structures.values()]
      .filter(({ kind, bytes }) => {
        if (kind !== "node") return false;
        return (
          (JSON.parse(bytes.toString("utf8")) as { level: number }).level === 0
        );
      })
      .flatMap(
        ({ bytes }) =>
          (JSON.parse(bytes.toString("utf8")) as { entries: unknown[] })
            .entries,
      )
      .sort((left, right) =>
        Buffer.compare(
          Buffer.from((left as { path: string }).path),
          Buffer.from((right as { path: string }).path),
        ),
      );
    const mergedLeaf = canonicalJson({
      kind: "cyclotomy-tree-node",
      version: 1,
      level: 0,
      entries: leaves,
    });
    const mergedLeafOid = storedObjectOid(mergedLeaf);
    store.structures.set(mergedLeafOid, { kind: "node", bytes: mergedLeaf });
    const noncanonicalRoot = canonicalJson({
      kind: root.kind,
      version: root.version,
      format: root.format,
      profile: root.profile,
      height: 0,
      entryCount: root.entryCount,
      entryMapRoot: mergedLeafOid,
      scopeOid: root.scopeOid,
    });
    const noncanonicalRootOid = storedObjectOid(noncanonicalRoot);
    store.structures.set(noncanonicalRootOid, {
      kind: "root",
      bytes: noncanonicalRoot,
    });

    await expect(
      STORED_TREE_FORMAT_V3.readAuthenticated(
        noncanonicalRootOid,
        store.read,
        limits,
      ),
    ).rejects.toThrow("not the canonical rebuild");
  });

  it("permits one oversized leaf entry while preserving the semantic limit", async () => {
    const store = memoryAccess();
    const longPath = `${"a".repeat(40 * 1024)}.txt`;
    const manifest = v3Manifest([
      {
        path: longPath,
        type: "regular",
        blobOid: "a".repeat(64),
        recreationMode: null,
      },
    ]);
    const treeOid = await STORED_TREE_FORMAT_V3.publish(
      manifest,
      store.write,
      limits,
    );
    const leaf = [...store.structures.values()].find(
      ({ kind }) => kind === "node",
    );

    expect(leaf!.bytes.byteLength).toBeGreaterThan(
      TREE_V3_MAXIMUM_NODE_PAYLOAD,
    );
    expect(
      (
        await STORED_TREE_FORMAT_V3.readAuthenticated(
          treeOid,
          store.read,
          limits,
        )
      ).manifest,
    ).toEqual(manifest);
  });

  it("bounds aggregate structural reads before materializing a hostile DAG", async () => {
    const store = memoryAccess();
    const hostileLimits: TreeManifestLimits = {
      ...limits,
      maxEntries: 4,
      maxManifestBytes: 1024 * 1024,
      maxPathBytes: 1024 * 1024,
    };
    const paths = ["a", "b", "c", "d"].map(
      (prefix) => `${prefix}${"x".repeat(900 * 1024 - 1)}`,
    );
    const children = paths.map((path, index) => {
      const bytes = canonicalJson({
        kind: "cyclotomy-tree-node",
        version: 1,
        level: 0,
        entries: [
          {
            path,
            type: "regular",
            blobOid: index.toString(16).padStart(64, "0"),
            recreationMode: null,
          },
        ],
      });
      const oid = storedObjectOid(bytes);
      store.structures.set(oid, { kind: "node", bytes });
      return { highKey: path, oid, entryCount: 1 };
    });
    const internalBytes = canonicalJson({
      kind: "cyclotomy-tree-node",
      version: 1,
      level: 1,
      children,
    });
    const internalOid = storedObjectOid(internalBytes);
    store.structures.set(internalOid, {
      kind: "node",
      bytes: internalBytes,
    });
    const scopeBytes = canonicalJson({
      kind: "cyclotomy-tree-scope",
      version: 1,
      scopeKind: "all-managed",
    });
    const scopeOid = storedObjectOid(scopeBytes);
    store.structures.set(scopeOid, { kind: "scope", bytes: scopeBytes });
    const rootBytes = canonicalJson({
      kind: "cyclotomy-tree-root",
      version: 1,
      format: "cyclotomy-tree-v3",
      profile: "cyclotomy-prolly-key-v1",
      height: 1,
      entryCount: 4,
      entryMapRoot: internalOid,
      scopeOid,
    });
    const treeOid = storedObjectOid(rootBytes);
    store.structures.set(treeOid, { kind: "root", bytes: rootBytes });
    const structuralReadLimits: number[] = [];
    const boundedRead: StoredTreeReadAccess = {
      async readStructuralObject(kind, oid, maximumBytes) {
        structuralReadLimits.push(maximumBytes);
        return store.read.readStructuralObject(kind, oid, maximumBytes);
      },
      readContent: store.read.readContent,
    };

    await expect(
      readStoredTree(treeOid, boundedRead, hostileLimits),
    ).rejects.toThrow("structural read exceeds caller bound");
    expect(structuralReadLimits.length).toBeGreaterThan(4);
    expect(structuralReadLimits.at(-1)).toBeLessThan(
      store.structures.get(children[1]!.oid)!.bytes.byteLength,
    );
  });

  it("bounds a hostile scope-source DAG before reading its full closure", async () => {
    const store = memoryAccess();
    const hostileLimits: TreeManifestLimits = {
      ...limits,
      maxEntries: 4,
      maxManifestBytes: 1024 * 1024,
      maxPathBytes: 1024 * 1024,
    };
    const empty = Buffer.alloc(0);
    const emptyContentId = storedObjectOid(empty);
    store.contents.set(emptyContentId, empty);
    const paths = ["a", "b", "c", "d"].map(
      (prefix) => `${prefix}${"x".repeat(900 * 1024 - 1)}`,
    );
    const children = paths.map((path) => {
      const bytes = canonicalJson({
        kind: "cyclotomy-tree-scope-source-node",
        version: 1,
        level: 0,
        sources: [{ path, contentId: emptyContentId, byteLength: 0 }],
      });
      const oid = storedObjectOid(bytes);
      store.structures.set(oid, { kind: "scope", bytes });
      return { highKey: path, oid, sourceCount: 1 };
    });
    const sourceRootBytes = canonicalJson({
      kind: "cyclotomy-tree-scope-source-node",
      version: 1,
      level: 1,
      children,
    });
    const sourceRootOid = storedObjectOid(sourceRootBytes);
    store.structures.set(sourceRootOid, {
      kind: "scope",
      bytes: sourceRootBytes,
    });
    const scopeBytes = canonicalJson({
      kind: "cyclotomy-tree-scope",
      version: 1,
      scopeKind: "git",
      repositoryPrefix: "",
      evaluator: {
        version: "git version fixture",
        precomposeUnicode: false,
      },
      ignoreCase: false,
      gitignoreSourceCount: children.length,
      gitignoreSourceRoot: sourceRootOid,
      infoExclude: { contentId: emptyContentId, byteLength: 0 },
      globalExclude: { contentId: emptyContentId, byteLength: 0 },
    });
    const scopeOid = storedObjectOid(scopeBytes);
    store.structures.set(scopeOid, { kind: "scope", bytes: scopeBytes });
    const rootBytes = canonicalJson({
      kind: "cyclotomy-tree-root",
      version: 1,
      format: "cyclotomy-tree-v3",
      profile: "cyclotomy-prolly-key-v1",
      height: 0,
      entryCount: 0,
      entryMapRoot: null,
      scopeOid,
    });
    const treeOid = storedObjectOid(rootBytes);
    store.structures.set(treeOid, { kind: "root", bytes: rootBytes });
    const structuralReadLimits: number[] = [];
    const boundedRead: StoredTreeReadAccess = {
      async readStructuralObject(kind, oid, maximumBytes) {
        structuralReadLimits.push(maximumBytes);
        return store.read.readStructuralObject(kind, oid, maximumBytes);
      },
      readContent: store.read.readContent,
    };

    await expect(
      readStoredTree(treeOid, boundedRead, hostileLimits),
    ).rejects.toThrow("structural read exceeds caller bound");
    expect(structuralReadLimits).toHaveLength(5);
    expect(structuralReadLimits.at(-1)).toBeLessThan(
      store.structures.get(children[1]!.oid)!.bytes.byteLength,
    );
  });

  it("measures maxManifest against the complete v3 semantic document", async () => {
    const store = memoryAccess();
    const entries = manyEntries(100);
    const manifest = v3Manifest(entries);
    const equivalent = encodeTreeManifestDocument(
      TREE_MANIFEST_FORMAT_V3,
      manifest.entries,
      manifest.scope,
      limits,
    );

    await expect(
      STORED_TREE_FORMAT_V3.publish(manifest, store.write, {
        ...limits,
        maxManifestBytes: equivalent.byteLength - 1,
      }),
    ).rejects.toThrow("tree manifest is");
  });

  it("does not charge fixed graph-root framing to the semantic manifest", async () => {
    const store = memoryAccess();
    const manifest = v3Manifest([]);
    const equivalent = encodeTreeManifestDocument(
      TREE_MANIFEST_FORMAT_V3,
      manifest.entries,
      manifest.scope,
      limits,
    );
    const exactSemanticLimits = {
      ...limits,
      maxManifestBytes: equivalent.byteLength,
    };
    const treeOid = await publishStoredTree(
      manifest,
      store.write,
      exactSemanticLimits,
    );

    expect(store.structures.get(treeOid)!.bytes.byteLength).toBeGreaterThan(
      exactSemanticLimits.maxManifestBytes,
    );
    await expect(
      readStoredTree(treeOid, store.read, exactSemanticLimits),
    ).resolves.toMatchObject({ manifest });
  });

  it("wraps legacy v2 as one async canonical structural object", async () => {
    const store = memoryAccess();
    const manifest = TREE_FORMAT_V2.create(
      manyEntries(2),
      { kind: "all-managed" },
      limits,
    );
    const treeOid = await STORED_TREE_FORMAT_V2.publish(
      manifest,
      store.write,
      limits,
    );
    const authenticated = await STORED_TREE_FORMAT_V2.readAuthenticated(
      treeOid,
      store.read,
      limits,
    );

    expect(authenticated.manifest.format).toBe(TREE_MANIFEST_FORMAT_V2);
    expect(authenticated.structuralObjectOids).toEqual([treeOid]);
    expect(authenticated.structuralObjects).toEqual([
      { kind: "root", oid: treeOid },
    ]);
    expect([...store.structures.values()].map(({ kind }) => kind)).toEqual([
      "root",
    ]);
  });
});
