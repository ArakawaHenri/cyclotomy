import type { Stats } from "node:fs";
import { lstat, opendir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { CurrentMetadataStore } from "./metadata.ts";
import {
  nativeObjectStoreLayout,
  type NativeObjectStore,
} from "./object-store.ts";
import { ABSOLUTE_MAX_TREE_ENTRIES } from "./tree-formats/manifest-codec.ts";
import { treeManifestBlobOids } from "./tree-formats/history.ts";
import {
  isNativeObjectShard,
  nativeObjectEntry,
  nativeObjectNamespacePath,
  nativeObjectShardPath,
  type NativeObjectKind,
  type NativeObjectLayout,
} from "./workspace-store.ts";

export interface GcReport {
  readonly removedTrees: number;
  readonly removedBlobs: number;
  readonly removedTmpFiles: number;
  readonly freedBytes: number;
  readonly keptObjects: number;
}

export interface GarbageCollectionOptions {
  readonly graceMs?: number;
  readonly now?: number;
  /** Test/embedding override; production remains bounded by the absolute cap. */
  readonly maxObjects?: number;
}

const ABSOLUTE_MAX_GC_OBJECTS = ABSOLUTE_MAX_TREE_ENTRIES + 1;

export class GarbageCollectionMarkError extends Error {
  readonly treeOid: string;

  constructor(treeOid: string, cause: unknown) {
    super(`refusing to sweep because rooted tree ${treeOid} is unreadable`, {
      cause,
    });
    this.name = "GarbageCollectionMarkError";
    this.treeOid = treeOid;
  }
}

export class GarbageCollectionNamespaceError extends Error {
  readonly path: string;

  constructor(path: string, detail: string, cause?: unknown) {
    super(`refusing to sweep unsafe object-store path ${path}: ${detail}`, {
      cause,
    });
    this.name = "GarbageCollectionNamespaceError";
    this.path = path;
  }
}

interface GcCandidate {
  readonly storeRoot: string;
  readonly storeRootStat: Stats;
  readonly objectsRoot: string;
  readonly objectsRootStat: Stats;
  readonly path: string;
  readonly namespace: string;
  readonly namespaceStat: Stats;
  readonly shardDir: string;
  readonly shardStat: Stats;
  readonly entryStat: Stats;
  readonly kind: NativeObjectKind;
  readonly isTmp: boolean;
  readonly marked: boolean;
  readonly expired: boolean;
}

function sameObservation(before: Stats, after: Stats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.nlink === after.nlink &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

/** Child removal mutates directory size/timestamps, but not its identity. */
function sameDirectoryIdentity(before: Stats, after: Stats): boolean {
  return (
    after.isDirectory() &&
    !after.isSymbolicLink() &&
    before.dev === after.dev &&
    before.ino === after.ino
  );
}

async function observeRealDirectory(path: string): Promise<Stats | undefined> {
  let info: Stats;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new GarbageCollectionNamespaceError(
      path,
      "cannot inspect directory",
      error,
    );
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new GarbageCollectionNamespaceError(
      path,
      "expected a real directory",
    );
  }
  return info;
}

/** Stream directory names so the configured object budget also bounds heap use. */
async function* directoryNames(
  path: string,
  detail: string,
): AsyncGenerator<string> {
  let directory;
  try {
    directory = await opendir(path);
  } catch (error) {
    throw new GarbageCollectionNamespaceError(path, detail, error);
  }
  try {
    for await (const entry of directory) yield entry.name;
  } catch (error) {
    throw new GarbageCollectionNamespaceError(path, detail, error);
  }
}

async function inventoryNamespace(
  layout: NativeObjectLayout,
  kind: NativeObjectKind,
  marked: ReadonlySet<string>,
  graceMs: number,
  now: number,
  budget: { count: number; readonly maximum: number },
): Promise<readonly GcCandidate[]> {
  const storeRoot = layout.root;
  const storeRootStat = await observeRealDirectory(storeRoot);
  if (storeRootStat === undefined) {
    throw new GarbageCollectionNamespaceError(
      storeRoot,
      "store root disappeared",
    );
  }
  const objectsRoot = layout.objects;
  const objectsRootStat = await observeRealDirectory(objectsRoot);
  if (objectsRootStat === undefined) {
    return [];
  }
  if (objectsRootStat.dev !== storeRootStat.dev) {
    throw new GarbageCollectionNamespaceError(
      objectsRoot,
      "cross-device objects directory is not controlled by this store",
    );
  }
  const namespace = nativeObjectNamespacePath(layout, kind);
  const namespaceStat = await observeRealDirectory(namespace);
  if (namespaceStat === undefined) {
    return [];
  }
  if (namespaceStat.dev !== objectsRootStat.dev) {
    throw new GarbageCollectionNamespaceError(
      namespace,
      "cross-device namespace is not controlled by this store",
    );
  }
  const candidates: GcCandidate[] = [];
  for await (const shard of directoryNames(
    namespace,
    "cannot list directory",
  )) {
    if (!isNativeObjectShard(shard)) {
      throw new GarbageCollectionNamespaceError(
        join(namespace, shard),
        "unexpected shard name",
      );
    }
    const shardDir = nativeObjectShardPath(layout, kind, shard);
    const shardStat = await observeRealDirectory(shardDir);
    if (shardStat === undefined) {
      throw new GarbageCollectionNamespaceError(
        shardDir,
        "shard disappeared during inventory",
      );
    }
    if (shardStat.dev !== namespaceStat.dev) {
      throw new GarbageCollectionNamespaceError(
        shardDir,
        "cross-device shard is not controlled by this store",
      );
    }
    for await (const file of directoryNames(shardDir, "cannot list shard")) {
      const path = join(shardDir, file);
      budget.count += 1;
      if (budget.count > budget.maximum) {
        throw new RangeError(
          `refusing to sweep because object inventory exceeds the ${budget.maximum}-candidate limit`,
        );
      }
      const entry = nativeObjectEntry(shard, file);
      if (entry === undefined) {
        throw new GarbageCollectionNamespaceError(
          path,
          "unexpected object name",
        );
      }
      const isTmp = entry.kind === "temporary";
      let entryStat: Stats;
      try {
        entryStat = await lstat(path);
      } catch (error) {
        throw new GarbageCollectionNamespaceError(
          path,
          "cannot inspect object",
          error,
        );
      }
      if (
        entryStat.isSymbolicLink() ||
        !entryStat.isFile() ||
        entryStat.nlink !== 1 ||
        entryStat.dev !== shardStat.dev
      ) {
        throw new GarbageCollectionNamespaceError(
          path,
          "object must be a single-link regular file on the store device",
        );
      }
      candidates.push({
        storeRoot,
        storeRootStat,
        objectsRoot,
        objectsRootStat,
        path,
        namespace,
        namespaceStat,
        shardDir,
        shardStat,
        entryStat,
        kind,
        isTmp,
        marked: entry.kind === "object" && marked.has(entry.oid),
        expired: entryStat.mtimeMs < now - graceMs,
      });
    }
  }
  return candidates;
}

/**
 * Mark-and-sweep over the object store. Roots are every tree oid referenced by
 * node metadata plus every blob oid named by each authenticated tree manifest.
 * Unreferenced objects and orphaned publication temp files are removed only
 * when older than the grace window, so a concurrent capture in another process
 * is never swept mid-publish.
 */
export async function collectGarbage(
  store: NativeObjectStore,
  metadata: Pick<CurrentMetadataStore, "listReferencedTreeOids">,
  options: GarbageCollectionOptions = {},
): Promise<GcReport> {
  const graceMs = options.graceMs ?? 3_600_000;
  const now = options.now ?? Date.now();
  const maxObjects = options.maxObjects ?? ABSOLUTE_MAX_GC_OBJECTS;
  if (
    !Number.isSafeInteger(graceMs) ||
    graceMs < 0 ||
    !Number.isFinite(now) ||
    now < 0 ||
    !Number.isSafeInteger(maxObjects) ||
    maxObjects <= 0 ||
    maxObjects > ABSOLUTE_MAX_GC_OBJECTS
  ) {
    throw new RangeError(
      `garbage-collection options are outside their supported range (maximum ${ABSOLUTE_MAX_GC_OBJECTS} objects)`,
    );
  }
  const layout = nativeObjectStoreLayout(store, "garbage collection");
  const referencedTrees = metadata.listReferencedTreeOids(maxObjects + 1);
  if (referencedTrees.length > maxObjects) {
    throw new RangeError(
      `refusing to sweep because the rooted object graph exceeds the ${maxObjects}-object limit`,
    );
  }
  const markedTrees = new Set(referencedTrees);
  const markedBlobs = new Set<string>();
  for (const treeOid of markedTrees) {
    let manifest;
    try {
      manifest = await store.readTreeManifest(treeOid);
    } catch (error) {
      // Continuing without this manifest could sweep old blobs that remain
      // semantically rooted. Fail before the first filesystem mutation so a
      // repair/backup still has every potentially referenced object.
      throw new GarbageCollectionMarkError(treeOid, error);
    }
    for (const blobOid of treeManifestBlobOids(manifest)) {
      markedBlobs.add(blobOid);
      if (markedTrees.size + markedBlobs.size > maxObjects) {
        throw new RangeError(
          `refusing to sweep because the rooted object graph exceeds the ${maxObjects}-object limit`,
        );
      }
    }
  }

  const report = {
    removedTrees: 0,
    removedBlobs: 0,
    removedTmpFiles: 0,
    freedBytes: 0,
    keptObjects: 0,
  };

  // Inventory and validate every namespace before the first deletion. A
  // malformed late shard therefore cannot leave an earlier shard half-swept.
  const budget = { count: 0, maximum: maxObjects };
  const candidates = [
    ...(await inventoryNamespace(
      layout,
      "blob",
      markedBlobs,
      graceMs,
      now,
      budget,
    )),
    ...(await inventoryNamespace(
      layout,
      "tree",
      markedTrees,
      graceMs,
      now,
      budget,
    )),
  ];

  for (const candidate of candidates) {
    const shouldRemove =
      candidate.expired && (candidate.isTmp || !candidate.marked);
    if (!shouldRemove) {
      report.keptObjects += candidate.isTmp ? 0 : 1;
      continue;
    }
    const [storeNow, objectsNow, namespaceNow, shardNow, entryNow] =
      await Promise.all([
        observeRealDirectory(candidate.storeRoot),
        observeRealDirectory(candidate.objectsRoot),
        observeRealDirectory(candidate.namespace),
        observeRealDirectory(candidate.shardDir),
        lstat(candidate.path).catch((error: unknown) => {
          throw new GarbageCollectionNamespaceError(
            candidate.path,
            "cannot revalidate object before removal",
            error,
          );
        }),
      ]);
    if (
      storeNow === undefined ||
      objectsNow === undefined ||
      namespaceNow === undefined ||
      shardNow === undefined ||
      !sameDirectoryIdentity(candidate.storeRootStat, storeNow) ||
      !sameDirectoryIdentity(candidate.objectsRootStat, objectsNow) ||
      !sameDirectoryIdentity(candidate.namespaceStat, namespaceNow) ||
      !sameDirectoryIdentity(candidate.shardStat, shardNow) ||
      !sameObservation(candidate.entryStat, entryNow) ||
      entryNow.isSymbolicLink() ||
      !entryNow.isFile()
    ) {
      throw new GarbageCollectionNamespaceError(
        candidate.path,
        "namespace or object changed after inventory",
      );
    }
    await rm(candidate.path);
    if (candidate.isTmp) {
      report.removedTmpFiles += 1;
    } else if (candidate.kind === "blob") {
      report.removedBlobs += 1;
    } else {
      report.removedTrees += 1;
    }
    report.freedBytes += candidate.entryStat.size;
  }
  return report;
}
