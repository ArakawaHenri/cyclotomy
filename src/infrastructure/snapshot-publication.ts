import { isAbsolute, join } from "node:path";

import type { TreeEntry } from "./tree-manifest.ts";
import type { ObjectStore } from "./object-store.ts";
import {
  summarizeScanProblems,
  type ScanProblem,
  type WorkspaceSnapshot,
} from "./workspace-scan.ts";

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
    throw new InconsistentSnapshotScopeError(
      "workspace root is not absolute",
    );
  }
  for (const entry of snapshot.entries) {
    if (
      entry.path.length === 0 ||
      entry.path.startsWith("/") ||
      entry.path.includes("\\") ||
      entry.path.includes("\0") ||
      entry.path !== entry.path.normalize("NFC") ||
      entry.path.split("/").some((part) =>
        part.length === 0 || part === "." || part === ".."
      )
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
  const treeEntries: TreeEntry[] = [];

  for (const entry of snapshot.entries) {
    if (entry.kind === "symlink") {
      treeEntries.push({
        path: entry.path,
        type: "symlink",
        target: entry.target,
        symlinkKind: entry.symlinkKind,
      });
      continue;
    }
    let blobOid = entry.sha256;
    if (!publishedBlobs.has(entry.sha256)) {
      blobOid = await publication.publishBlobFromFile(
        entry.sourcePath,
        entry.sha256,
        entry.byteLength,
      );
    }
    if (blobOid !== entry.sha256) {
      throw new Error(
        `object store is broken: blob id ${blobOid} does not match the scanned digest ${entry.sha256} of "${entry.path}"`,
      );
    }
    publishedBlobs.add(blobOid);
    treeEntries.push({
      path: entry.path,
      type: "regular",
      blobOid,
      recreationMode: entry.recreationMode,
    });
  }

  return publication.publishTree(treeEntries, snapshot.scope);
}
