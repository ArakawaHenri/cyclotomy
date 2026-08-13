import { isAbsolute, join } from "node:path";

import type { TreeEntry } from "./tree-formats/manifest-codec.ts";
import type { ObjectStore } from "./object-store.ts";
import {
  summarizeScanProblems,
  type ScanProblem,
  type WorkspaceSnapshot,
} from "./workspace-scan.ts";

const PUBLICATION_CONCURRENCY = 8;

/** Stop scheduling on failure, await in-flight writes, then fail by input order. */
async function runPublicationPool<T>(
  items: readonly T[],
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failed = false;
  const failures: Array<{ readonly index: number; readonly error: unknown }> =
    [];
  const lanes = Math.min(PUBLICATION_CONCURRENCY, items.length);
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      while (!failed) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        try {
          await worker(items[index] as T);
        } catch (error) {
          failures.push({ index, error });
          failed = true;
        }
      }
    }),
  );
  if (failures.length > 0) {
    failures.sort((left, right) => left.index - right.index);
    throw failures[0]!.error;
  }
}

/** Publishing a partial inventory would turn unknown paths into absences. */
export class IncompleteSnapshotError extends Error {
  readonly problems: readonly ScanProblem[];

  constructor(problems: readonly ScanProblem[]) {
    super(
      `refusing to publish an incomplete workspace snapshot: ${summarizeScanProblems(
        problems,
      )}`,
    );
    this.name = "IncompleteSnapshotError";
    this.problems = problems;
  }
}

/** Snapshot paths and regular-file sources must stay bound to the scan root. */
export class InconsistentSnapshotScopeError extends Error {
  constructor(message: string) {
    super(`refusing to publish inconsistent workspace scope: ${message}`);
    this.name = "InconsistentSnapshotScopeError";
  }
}

/** Refuse forged snapshots that would make publication read outside its scan. */
function assertEntrySourcesBound(snapshot: WorkspaceSnapshot): void {
  if (!isAbsolute(snapshot.rootPath)) {
    throw new InconsistentSnapshotScopeError("workspace root is not absolute");
  }
  for (const entry of snapshot.entries) {
    if (
      entry.path.length === 0 ||
      entry.path.startsWith("/") ||
      entry.path.includes("\\") ||
      entry.path.includes("\0") ||
      entry.path !== entry.path.normalize("NFC") ||
      entry.path
        .split("/")
        .some((part) => part.length === 0 || part === "." || part === "..")
    ) {
      throw new InconsistentSnapshotScopeError(
        `unsafe entry path ${JSON.stringify(entry.path)}`,
      );
    }
    if (
      entry.kind === "regular" &&
      entry.sourcePath !== join(snapshot.rootPath, entry.path)
    ) {
      throw new InconsistentSnapshotScopeError(
        `regular entry source is outside its scanned path: ${entry.path}`,
      );
    }
  }
}

/**
 * Materialize a scan-time observation and assemble its tree object. Missing
 * blobs are streamed from scanner-bound source paths; authenticated CAS hits
 * are safely reused. The capture boundary, rather than object occupancy,
 * decides freshness with a final whole-workspace validation scan.
 */
export async function publishSnapshot(
  store: ObjectStore,
  snapshot: WorkspaceSnapshot,
): Promise<string> {
  if (snapshot.problems.length > 0) {
    throw new IncompleteSnapshotError(snapshot.problems);
  }
  assertEntrySourcesBound(snapshot);
  const publication = store.beginSnapshotPublication();

  const publishedBlobs = new Set<string>();
  const blobSources: Array<{
    readonly sourcePath: string;
    readonly oid: string;
    readonly byteLength: number;
    readonly entryPath: string;
  }> = [];
  for (const entry of snapshot.entries) {
    if (entry.kind === "regular" && !publishedBlobs.has(entry.sha256)) {
      publishedBlobs.add(entry.sha256);
      blobSources.push({
        sourcePath: entry.sourcePath,
        oid: entry.sha256,
        byteLength: entry.byteLength,
        entryPath: entry.path,
      });
    }
  }

  await runPublicationPool(blobSources, async (source) => {
    const blobOid = await publication.publishBlobFromFile(
      source.sourcePath,
      source.oid,
      source.byteLength,
    );
    if (blobOid !== source.oid) {
      throw new Error(
        `object store is broken: blob id ${blobOid} does not match the scanned digest ${source.oid} of "${source.entryPath}"`,
      );
    }
  });

  const treeEntries: TreeEntry[] = snapshot.entries.map((entry) =>
    entry.kind === "symlink"
      ? {
          path: entry.path,
          type: "symlink",
          target: entry.target,
          symlinkKind: entry.symlinkKind,
        }
      : {
          path: entry.path,
          type: "regular",
          blobOid: entry.sha256,
          recreationMode: entry.recreationMode,
        },
  );

  return publication.publishTree(treeEntries, snapshot.scope);
}
