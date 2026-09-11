import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  observeFilesystemKind,
  type FilesystemKindProbe,
  type FilesystemKindReport,
} from "../infrastructure/filesystem-kind.ts";
import {
  readMetadataReadonly,
  type MetadataReadonlyStatus,
  type MetadataSidecarFile,
  type SessionScaleStats,
} from "../infrastructure/metadata-readonly.ts";
import { systemErrorCode } from "../infrastructure/system-error.ts";
import {
  canonicalStoreRoot,
  evaluateSessionCapacityHints,
  evaluateStoreFileCapacityHint,
  filesystemKindIssues,
  metadataObservationState,
  metadataStatusIssues,
  observeStorePresence,
  physicalObservationState,
  type CapacityHint,
  type InspectionState,
  type StoreDiagnosticIssue,
} from "./store-diagnostics.ts";

export const OBJECT_WALK_MAX_ENTRIES = 100_000;
export const OBJECT_WALK_MAX_DEPTH = 8;

export interface ObjectWalkBudget {
  readonly maxEntries?: number | undefined;
  readonly maxDepth?: number | undefined;
}

export interface ObjectFileInventory {
  readonly present: boolean;
  readonly complete: boolean;
  readonly fileCount: number;
  readonly skippedEntries: number;
  /** All regular files in the object namespace, including staged and temporary files. */
  readonly objectFileBytes: bigint;
  readonly looseObjectBytes: bigint;
  readonly looseRecordBytes: bigint;
  readonly packBytes: bigint;
  readonly incomingBytes: bigint;
  readonly temporaryBytes: bigint;
  readonly otherBytes: bigint;
  readonly detail: string | null;
}

export type ReclamationFact =
  | "history-deletion-does-not-shrink-sqlite-file"
  | "free-pages-are-reused"
  | "vacuum-is-not-implicit";

export const RECLAMATION_FACTS: readonly ReclamationFact[] = Object.freeze([
  "history-deletion-does-not-shrink-sqlite-file",
  "free-pages-are-reused",
  "vacuum-is-not-implicit",
]);

export interface StoreInventoryOptions {
  readonly sessionId?: string | undefined;
  readonly filesystemKindProbe?: FilesystemKindProbe | undefined;
  readonly objectWalkBudget?: ObjectWalkBudget | undefined;
}

export interface StoreInventoryReport {
  readonly storeRoot: string;
  readonly metadataPath: string;
  readonly storePresent: boolean;
  readonly directoryPresent: boolean | null;
  readonly objectsPresent: boolean | null;
  /** SQL metadata facts: a snapshot when the read transaction completed. */
  readonly metadataState: InspectionState;
  /** File and page byte figures, always observed outside a held lock. */
  readonly metadataBytesState: InspectionState;
  readonly status: MetadataReadonlyStatus;
  readonly version: number | null;
  readonly supportedVersion: number;
  readonly sessionHistoryAvailable: boolean | null;
  readonly metadataFileBytes: bigint | null;
  readonly metadataWalBytes: bigint | null;
  readonly metadataJournalBytes: bigint | null;
  readonly metadataOtherSidecarFiles: readonly MetadataSidecarFile[];
  readonly metadataAllocatedBlocks: bigint | null;
  readonly metadataPageBytes: bigint | null;
  readonly metadataReusableBytes: bigint | null;
  readonly metadataUsedPageEstimateBytes: bigint | null;
  readonly metadataPageSizeBytes: number | null;
  readonly metadataPageCount: number | null;
  readonly metadataFreelistCount: number | null;
  readonly objectFileBytes: bigint | null;
  readonly objectState: InspectionState;
  readonly objectFiles: ObjectFileInventory | null;
  readonly sessionId: string | null;
  readonly sessionState: InspectionState;
  readonly sessionFound: boolean | null;
  readonly sessionStats: SessionScaleStats | null;
  readonly sessionLogicalContentBytes: bigint | null;
  readonly sessionLogicalContentDetail: string;
  readonly reclaimedState: InspectionState;
  readonly reclaimedBytes: bigint | null;
  readonly reclaimedBytesDetail: string;
  readonly capacityHints: readonly CapacityHint[];
  readonly reclamationFacts: readonly ReclamationFact[];
  readonly filesystem: FilesystemKindReport;
  readonly issues: readonly StoreDiagnosticIssue[];
}

interface WalkTally {
  complete: boolean;
  detail: string | null;
  fileCount: number;
  skippedEntries: number;
  looseObjectBytes: bigint;
  looseRecordBytes: bigint;
  packBytes: bigint;
  incomingBytes: bigint;
  temporaryBytes: bigint;
  otherBytes: bigint;
}

function emptyTally(): WalkTally {
  return {
    complete: true,
    detail: null,
    fileCount: 0,
    skippedEntries: 0,
    looseObjectBytes: 0n,
    looseRecordBytes: 0n,
    packBytes: 0n,
    incomingBytes: 0n,
    temporaryBytes: 0n,
    otherBytes: 0n,
  };
}

function finalizeTally(
  tally: WalkTally,
  outcome: {
    readonly present: boolean;
    readonly complete?: boolean | undefined;
    readonly detail?: string | null | undefined;
  },
): ObjectFileInventory {
  return Object.freeze({
    present: outcome.present,
    complete: outcome.complete ?? tally.complete,
    fileCount: tally.fileCount,
    skippedEntries: tally.skippedEntries,
    objectFileBytes:
      tally.looseObjectBytes +
      tally.looseRecordBytes +
      tally.packBytes +
      tally.incomingBytes +
      tally.temporaryBytes +
      tally.otherBytes,
    looseObjectBytes: tally.looseObjectBytes,
    looseRecordBytes: tally.looseRecordBytes,
    packBytes: tally.packBytes,
    incomingBytes: tally.incomingBytes,
    temporaryBytes: tally.temporaryBytes,
    otherBytes: tally.otherBytes,
    detail: outcome.detail !== undefined ? outcome.detail : tally.detail,
  });
}

function accumulate(tally: WalkTally, relative: string, bytes: bigint): void {
  tally.fileCount += 1;
  const name = relative.slice(relative.lastIndexOf("/") + 1);
  if (relative.startsWith("packs/incoming/")) {
    tally.incomingBytes += bytes;
  } else if (name.endsWith(".tmp")) {
    tally.temporaryBytes += bytes;
  } else if (relative.startsWith("blobs/") || relative.startsWith("trees/")) {
    tally.looseObjectBytes += bytes;
  } else if (relative.startsWith("records/")) {
    tally.looseRecordBytes += bytes;
  } else if (relative.startsWith("packs/")) {
    tally.packBytes += bytes;
  } else {
    tally.otherBytes += bytes;
  }
}

async function regularFileBytes(path: string): Promise<bigint | null> {
  // A concurrent GC may remove a file between readdir and stat; retry once
  // before reporting the walk as partial.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const entry = await lstat(path, { bigint: true });
      return entry.isFile() && !entry.isSymbolicLink() ? entry.size : null;
    } catch (error) {
      if (systemErrorCode(error) !== "ENOENT") throw error;
    }
  }
  return null;
}

/**
 * Bounded physical inventory of the object namespace. Symlinks are never
 * followed, the entry budget caps the walk, and the caller is told when the
 * result is partial instead of being handed a silently short sum.
 */
async function walkObjects(
  root: string,
  budget: ObjectWalkBudget | undefined,
): Promise<ObjectFileInventory> {
  const maxEntries = budget?.maxEntries ?? OBJECT_WALK_MAX_ENTRIES;
  const maxDepth = budget?.maxDepth ?? OBJECT_WALK_MAX_DEPTH;
  if (
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1 ||
    !Number.isSafeInteger(maxDepth) ||
    maxDepth < 1
  ) {
    throw new RangeError("object walk budget must be positive integers");
  }

  const tally = emptyTally();
  try {
    const entry = await lstat(root);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      return finalizeTally(tally, {
        present: true,
        complete: false,
        detail: "the object store path is not a plain directory",
      });
    }
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT") {
      return finalizeTally(tally, { present: false });
    }
    return finalizeTally(tally, {
      present: true,
      complete: false,
      detail: `the object store cannot be inspected: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }

  let seen = 0;
  const stack: {
    readonly path: string;
    readonly relative: string;
    readonly depth: number;
  }[] = [{ path: root, relative: "", depth: 0 }];
  walk: while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch (error) {
      tally.complete = false;
      tally.detail = `the object store cannot be listed: ${
        error instanceof Error ? error.message : String(error)
      }`;
      break;
    }
    entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const entry of entries) {
      seen += 1;
      if (seen > maxEntries) {
        tally.complete = false;
        tally.detail = `the object walk exceeded its ${maxEntries}-entry budget`;
        break walk;
      }
      const relative =
        current.relative === ""
          ? entry.name
          : `${current.relative}/${entry.name}`;
      const path = join(current.path, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        if (current.depth + 1 > maxDepth) {
          tally.complete = false;
          tally.detail = `the object walk exceeded its depth budget at ${relative}`;
          break walk;
        }
        stack.push({ path, relative, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile() || entry.isSymbolicLink()) {
        tally.skippedEntries += 1;
        continue;
      }
      let bytes: bigint | null;
      try {
        bytes = await regularFileBytes(path);
      } catch (error) {
        tally.complete = false;
        tally.detail = `an object file cannot be inspected: ${
          error instanceof Error ? error.message : String(error)
        }`;
        break walk;
      }
      if (bytes === null) {
        tally.complete = false;
        tally.detail = "object files changed while they were inventoried";
        tally.skippedEntries += 1;
        continue;
      }
      accumulate(tally, relative, bytes);
    }
  }

  return finalizeTally(tally, { present: true });
}

const SESSION_LOGICAL_CONTENT_DETAIL =
  "this command does not calculate deduplicated logical content bytes for a session";
const RECLAIMED_BYTES_DETAIL =
  "the store does not durably record GC deletion bytes; only the GC run that removed the files can know them";

/**
 * Read-only space inventory. Per-session logical content stays unknown until a
 * separate inventory read completes, and the sum of per-session logical bytes
 * is never presented as the store's physical size.
 */
export async function readStoreInventory(
  storeRoot: string,
  options: StoreInventoryOptions = {},
): Promise<StoreInventoryReport> {
  const canonical = await canonicalStoreRoot(storeRoot);
  const metadataPath = join(canonical, "state.db");
  const sessionId = options.sessionId ?? null;
  const metadata = readMetadataReadonly(metadataPath, (queries) =>
    sessionId === null ? null : queries.session(sessionId),
  );
  const presence = observeStorePresence(canonical);
  const storePresent =
    metadata.status.kind !== "absent" ||
    presence.objectsPresent !== false ||
    presence.issues.length > 0;
  const physical = metadata.physical;
  const sessionStats = metadata.data;

  const pageBytes =
    physical.pageSizeBytes === null || physical.pageCount === null
      ? null
      : BigInt(physical.pageCount) * BigInt(physical.pageSizeBytes);
  const reusableBytes =
    physical.pageSizeBytes === null || physical.freelistCount === null
      ? null
      : BigInt(physical.freelistCount) * BigInt(physical.pageSizeBytes);
  const usedPageEstimateBytes =
    pageBytes === null || reusableBytes === null
      ? null
      : pageBytes - reusableBytes;

  const objectFiles =
    presence.directoryPresent !== false
      ? await walkObjects(join(canonical, "objects"), options.objectWalkBudget)
      : null;

  const capacityHints: CapacityHint[] = [
    evaluateStoreFileCapacityHint(physical.fileBytes),
    ...(sessionStats === null
      ? []
      : evaluateSessionCapacityHints(sessionStats)),
  ];

  const filesystem = await observeFilesystemKind(
    canonical,
    options.filesystemKindProbe,
  );
  const objectIssues: StoreDiagnosticIssue[] =
    objectFiles !== null && !objectFiles.complete
      ? [
          Object.freeze({
            code: "object-inventory-incomplete",
            severity: "warning" as const,
            detail:
              objectFiles.detail ??
              "the object inventory did not cover the whole object store",
            params: Object.freeze({
              fileCount: objectFiles.fileCount,
              skippedEntries: objectFiles.skippedEntries,
            }),
          }),
        ]
      : [];
  const sessionIssues: StoreDiagnosticIssue[] =
    sessionId !== null &&
    metadata.status.kind === "ready" &&
    sessionStats === null
      ? [
          Object.freeze({
            code: "session-unknown",
            severity: "warning" as const,
            detail: `the store has no session ${JSON.stringify(sessionId)}`,
            params: Object.freeze({ sessionId }),
          }),
        ]
      : [];

  return Object.freeze({
    storeRoot: canonical,
    metadataPath,
    storePresent,
    directoryPresent: presence.directoryPresent,
    objectsPresent: presence.objectsPresent,
    metadataState: metadataObservationState(metadata.status, physical),
    metadataBytesState: physicalObservationState(physical),
    status: metadata.status,
    version: metadata.version,
    supportedVersion: metadata.supportedVersion,
    sessionHistoryAvailable: metadata.sessionHistoryAvailable,
    metadataFileBytes: physical.fileBytes,
    metadataWalBytes: physical.walBytes,
    metadataJournalBytes: physical.journalBytes,
    metadataOtherSidecarFiles: physical.otherSidecarFiles,
    metadataAllocatedBlocks: physical.allocatedBlocks,
    metadataPageBytes: pageBytes,
    metadataReusableBytes: reusableBytes,
    metadataUsedPageEstimateBytes: usedPageEstimateBytes,
    metadataPageSizeBytes: physical.pageSizeBytes,
    metadataPageCount: physical.pageCount,
    metadataFreelistCount: physical.freelistCount,
    objectFileBytes: objectFiles?.objectFileBytes ?? null,
    objectState: objectFiles === null ? "unavailable" : "observational",
    objectFiles,
    sessionId,
    sessionState:
      sessionId === null || sessionStats === null ? "unavailable" : "snapshot",
    sessionFound:
      sessionId === null || metadata.status.kind !== "ready"
        ? null
        : sessionStats !== null,
    sessionStats,
    sessionLogicalContentBytes: null,
    sessionLogicalContentDetail:
      sessionId === null
        ? "per-session logical content is only reported for a requested session"
        : SESSION_LOGICAL_CONTENT_DETAIL,
    reclaimedState: "unavailable",
    reclaimedBytes: null,
    reclaimedBytesDetail: RECLAIMED_BYTES_DETAIL,
    capacityHints: Object.freeze(capacityHints),
    reclamationFacts: RECLAMATION_FACTS,
    filesystem,
    issues: Object.freeze([
      ...metadataStatusIssues(metadata.status, presence.objectsPresent),
      ...presence.issues,
      ...filesystemKindIssues(filesystem),
      ...objectIssues,
      ...sessionIssues,
    ]),
  });
}
