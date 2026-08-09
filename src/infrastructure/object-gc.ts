import type { Stats } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { MetadataStore } from "./metadata.ts";
import type { ObjectStore } from "./object-store.ts";

export interface GcReport {
  readonly removedTrees: number;
  readonly removedBlobs: number;
  readonly removedTmpFiles: number;
  readonly freedBytes: number;
  readonly keptObjects: number;
}

const HEX_64 = /^[0-9a-f]{64}$/u;
const TEMP_OBJECT = /^\.[0-9a-f]{64}\.[0-9]+\.[0-9a-f-]{36}\.tmp$/u;

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
  readonly kind: "blobs" | "trees";
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

async function inventoryNamespace(
  storeRoot: string,
  kind: "blobs" | "trees",
  marked: ReadonlySet<string>,
  graceMs: number,
  now: number,
): Promise<readonly GcCandidate[]> {
  const storeRootStat = await observeRealDirectory(storeRoot);
  if (storeRootStat === undefined) {
    throw new GarbageCollectionNamespaceError(
      storeRoot,
      "store root disappeared",
    );
  }
  const objectsRoot = join(storeRoot, "objects");
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
  const namespace = join(storeRoot, "objects", kind);
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
  let shards: string[];
  try {
    shards = await readdir(namespace);
  } catch (error) {
    throw new GarbageCollectionNamespaceError(
      namespace,
      "cannot list directory",
      error,
    );
  }
  const candidates: GcCandidate[] = [];
  for (const shard of shards) {
    if (!/^[0-9a-f]{2}$/u.test(shard)) {
      throw new GarbageCollectionNamespaceError(
        join(namespace, shard),
        "unexpected shard name",
      );
    }
    const shardDir = join(namespace, shard);
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
    let files: string[];
    try {
      files = await readdir(shardDir);
    } catch (error) {
      throw new GarbageCollectionNamespaceError(
        shardDir,
        "cannot list shard",
        error,
      );
    }
    for (const file of files) {
      const path = join(shardDir, file);
      const oid = `${shard}${file}`;
      const isTmp = TEMP_OBJECT.test(file);
      if (!isTmp && !HEX_64.test(oid)) {
        throw new GarbageCollectionNamespaceError(
          path,
          "unexpected object name",
        );
      }
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
        marked: !isTmp && marked.has(oid),
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
  storeRoot: string,
  store: ObjectStore,
  metadata: MetadataStore,
  graceMs = 3_600_000,
  now: number = Date.now(),
): Promise<GcReport> {
  const markedTrees = new Set(metadata.listReferencedTreeOids());
  const markedBlobs = new Set<string>();
  for (const treeOid of markedTrees) {
    try {
      const manifest = await store.readTreeManifest(treeOid);
      for (const entry of manifest.entries) {
        if (entry.type === "regular") {
          markedBlobs.add(entry.blobOid);
        }
      }
    } catch (error) {
      // Continuing without this manifest could sweep old blobs that remain
      // semantically rooted. Fail before the first filesystem mutation so a
      // repair/backup still has every potentially referenced object.
      throw new GarbageCollectionMarkError(treeOid, error);
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
  const candidates = [
    ...(await inventoryNamespace(
      storeRoot,
      "blobs",
      markedBlobs,
      graceMs,
      now,
    )),
    ...(await inventoryNamespace(
      storeRoot,
      "trees",
      markedTrees,
      graceMs,
      now,
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
    } else if (candidate.kind === "blobs") {
      report.removedBlobs += 1;
    } else {
      report.removedTrees += 1;
    }
    report.freedBytes += candidate.entryStat.size;
  }
  return report;
}
