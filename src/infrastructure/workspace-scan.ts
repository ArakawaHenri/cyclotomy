import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import {
  constants as fsConstants,
  lstat,
  opendir,
  readlink,
  realpath,
  stat as statPath,
  type FileHandle,
} from "node:fs/promises";
import { join, resolve } from "node:path";

import { compareUtf8 } from "./utf8-order.ts";
import {
  aggregateFailures,
  primaryFailure,
  withRetainedCleanup,
} from "./failure-settlement.ts";
import {
  ABSOLUTE_MAX_TREE_ENTRIES,
  ABSOLUTE_MAX_TREE_MANIFEST_BYTES,
  DEFAULT_MAX_TREE_ENTRIES,
  DEFAULT_MAX_TREE_MANIFEST_BYTES,
  encodeTreeManifestDocument,
  type FileRecreationMode,
  type SymlinkKind,
  type TreeEntry,
} from "./tree-formats/manifest-codec.ts";
import {
  CURRENT_TREE_MANIFEST_FORMAT,
  createCurrentTreeManifest,
} from "./tree-formats/current.ts";
import {
  createLiveGitIgnoreOracle,
  createSyntheticGitIgnoreOracle,
  discoverWorkspaceScope,
  readWorkspaceGitignoreSource,
  WorkspaceGitPolicyBudget,
  type GitIgnorePath,
} from "./git-ignore-oracle.ts";
import {
  ABSOLUTE_MAX_WORKSPACE_RELATIVE_PATH_BYTES,
  ABSOLUTE_MAX_WORKSPACE_RELATIVE_PATH_COMPONENTS,
  ABSOLUTE_WORKSPACE_PATH_LIMITS,
  canonicalWorkspaceRelativePath,
  canonicalizeWorkspaceScope,
  DEFAULT_MAX_WORKSPACE_RELATIVE_PATH_BYTES,
  DEFAULT_MAX_WORKSPACE_RELATIVE_PATH_COMPONENTS,
  portableWorkspacePathKey,
  workspaceScopesEqual,
  type WorkspaceGitignoreSource,
  type WorkspacePathLimits,
  type WorkspaceScope,
} from "./workspace-scope.ts";
import { openWorkspaceRegularCandidate } from "./workspace-file-open.ts";
import {
  isOperationCancelled,
  type WorkspaceOperationOptions,
} from "./workspace-operation.ts";

export interface RegularWorkspaceStateEntry {
  readonly path: string;
  readonly kind: "regular";
  /** Non-semantic and used only if the file is rebuilt. */
  readonly recreationMode: FileRecreationMode;
  readonly byteLength: number;
  readonly sha256: string;
}

export type WorkspaceStateEntry =
  | RegularWorkspaceStateEntry
  | {
      readonly path: string;
      readonly kind: "symlink";
      readonly target: string;
      readonly symlinkKind: SymlinkKind | null;
    };

export type WorkspaceEntry =
  | (RegularWorkspaceStateEntry & {
      /** Absolute source path, revalidated during streamed publication. */
      readonly sourcePath: string;
    })
  | Extract<WorkspaceStateEntry, { readonly kind: "symlink" }>;

/**
 * Minimal namespace state for one path excluded by the active workspace
 * scope. Excluded bytes and symlink targets remain deliberately unobserved;
 * only occupancy that can block a later type replacement is retained.
 */
export interface ExcludedWorkspaceOccupancy {
  readonly path: string;
  readonly kind: "regular" | "symlink" | "directory" | "other";
}

/** Ephemeral identity proof attached by the real scanner. */
export interface ExcludedWorkspaceObservation extends ExcludedWorkspaceOccupancy {
  readonly dev: number;
  readonly ino: number;
}

export type ScanProblemKind =
  | "too-large"
  | "read-failed"
  | "unsupported"
  | "hardlink"
  | "cross-device"
  | "path-collision"
  /** Observation was not made through the target checkpoint's scope. */
  | "scope-mismatch"
  /** Unmanaged content prevents a target type replacement. */
  | "scope-blocker";

export interface ScanProblem {
  readonly path: string;
  readonly kind: ScanProblemKind;
  readonly detail: string;
}

/** Logical inventory used by comparison-only code; it carries no apply proof. */
export interface WorkspaceState {
  readonly entries: readonly WorkspaceStateEntry[];
  /** Minimal roots of every namespace boundary excluded by this scope. */
  readonly excludedOccupancies: readonly ExcludedWorkspaceOccupancy[];
  readonly problems: readonly ScanProblem[];
  readonly scope: WorkspaceScope;
}

/** Complete scanner output required by publication and workspace mutation. */
export interface WorkspaceSnapshot extends WorkspaceState {
  readonly entries: readonly WorkspaceEntry[];
  readonly excludedOccupancies: readonly ExcludedWorkspaceObservation[];
  /** Git executable that classified this scan, or null for all-managed scope. */
  readonly gitOracleVersion: string | null;
  /** Canonical root frozen by the scan. */
  readonly rootPath: string;
  /** Ephemeral real-directory identities used to bind a later apply. */
  readonly directoryObservations: readonly DirectoryObservation[];
}

export interface DirectoryObservation {
  /** Workspace-relative directory; root is the empty string. */
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}

/**
 * Produce a compact, stable diagnostic for an incomplete workspace scan.
 * Paths and problem kinds are included so callers can tell users what must be
 * fixed or excluded without dumping an unbounded list into the UI.
 */
export function summarizeScanProblems(
  problems: readonly ScanProblem[],
  maxExamples = 3,
): string {
  if (problems.length === 0) {
    return "no scan problems";
  }
  const limit = Math.max(0, Math.floor(maxExamples));
  const examples = problems
    .slice(0, limit)
    .map((problem) => `${problem.kind} at "${problem.path}"`);
  const remaining = problems.length - examples.length;
  const suffix = remaining > 0 ? `; ${remaining} more` : "";
  const exampleText = examples.length > 0 ? `: ${examples.join("; ")}` : "";
  return `${problems.length} scan problem${
    problems.length === 1 ? "" : "s"
  }${exampleText}${suffix}`;
}

export interface ScanOptions extends WorkspaceOperationOptions {
  /** Files larger than this become a "too-large" problem. Default 50 MiB. */
  readonly maxFileBytes?: number;
  /** Cumulative snapshot quota; overflow throws ScanError. Default 2 GiB. */
  readonly maxSnapshotBytes?: number;
  /** Managed entries, excluded boundaries, and traversed directories combined. */
  readonly maxEntries?: number;
  /** Estimated canonical durable tree-manifest byte ceiling. */
  readonly maxManifestBytes?: number;
  /** UTF-8 byte ceiling for one workspace-relative path. */
  readonly maxPathBytes?: number;
  /** Slash-separated component ceiling for one workspace-relative path. */
  readonly maxPathComponents?: number;
  /**
   * Existing private parent for operation-local synthetic Git state. Pi uses
   * its authenticated object-store root; standalone scans default to TMPDIR
   * and safely escape it when TMPDIR is inside the workspace.
   */
  readonly gitIgnoreScratchParent?: string;
}

export class ScanError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ScanError";
  }
}

const SCAN_CONCURRENCY = 8;

const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_SNAPSHOT_BYTES = 2 * 1024 ** 3;

// --- path and entry helpers ------------------------------------------------

function isGitComponent(name: string): boolean {
  return portableWorkspacePathKey(name) === ".git";
}

function errorDetail(cause: unknown): string {
  const primary = primaryFailure(cause);
  return primary instanceof Error ? primary.message : String(primary);
}

async function withScanCleanup<T>(
  action: () => Promise<T>,
  cleanup: () => Promise<void>,
  message: string,
): Promise<T> {
  try {
    return await withRetainedCleanup(action, cleanup, message);
  } catch (error) {
    const primary = primaryFailure(error);
    if (primary instanceof ScanError) {
      if (primary === error) throw primary;
      throw new ScanError(primary.message, { cause: error });
    }
    throw new ScanError(
      primary instanceof Error ? primary.message : String(primary),
      { cause: error },
    );
  }
}

function unsupportedType(stat: Stats): string {
  if (stat.isBlockDevice()) return "block-device";
  if (stat.isCharacterDevice()) return "character-device";
  if (stat.isFIFO()) return "fifo";
  if (stat.isSocket()) return "socket";
  return "unknown";
}

function excludedKind(stat: Stats): ExcludedWorkspaceObservation["kind"] {
  if (stat.isDirectory()) return "directory";
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isFile()) return "regular";
  return "other";
}

function excludedObservation(
  path: string,
  stat: Stats,
): ExcludedWorkspaceObservation {
  return {
    path,
    kind: excludedKind(stat),
    dev: stat.dev,
    ino: stat.ino,
  };
}

function entriesEqual(
  left: WorkspaceSnapshot["entries"],
  right: WorkspaceSnapshot["entries"],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const candidate = right[index];
    if (
      candidate === undefined ||
      entry.path !== candidate.path ||
      entry.kind !== candidate.kind
    ) {
      return false;
    }
    if (entry.kind === "regular" && candidate.kind === "regular") {
      return (
        entry.byteLength === candidate.byteLength &&
        entry.sha256 === candidate.sha256 &&
        entry.recreationMode === candidate.recreationMode
      );
    }
    return (
      entry.kind === "symlink" &&
      candidate.kind === "symlink" &&
      entry.target === candidate.target &&
      entry.symlinkKind === candidate.symlinkKind
    );
  });
}

function excludedOccupanciesEqual(
  left: readonly ExcludedWorkspaceObservation[],
  right: readonly ExcludedWorkspaceObservation[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        entry.path === candidate.path &&
        entry.kind === candidate.kind
      );
    })
  );
}

function directoryObservationsEqual(
  left: readonly DirectoryObservation[],
  right: readonly DirectoryObservation[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        entry.path === candidate.path &&
        entry.dev === candidate.dev &&
        entry.ino === candidate.ino
      );
    })
  );
}

/** Stable equality for a scan followed by its final validation scan. */
export function workspaceSnapshotsEqual(
  left: WorkspaceSnapshot,
  right: WorkspaceSnapshot,
): boolean {
  return (
    left.rootPath === right.rootPath &&
    left.gitOracleVersion === right.gitOracleVersion &&
    workspaceScopesEqual(
      left.scope,
      right.scope,
      ABSOLUTE_WORKSPACE_PATH_LIMITS,
    ) &&
    entriesEqual(left.entries, right.entries) &&
    excludedOccupanciesEqual(
      left.excludedOccupancies,
      right.excludedOccupancies,
    ) &&
    directoryObservationsEqual(
      left.directoryObservations,
      right.directoryObservations,
    )
  );
}

/** Project a physical scan observation into the current tree's semantics. */
export function workspaceEntryAsTreeEntry(
  entry: WorkspaceStateEntry,
): TreeEntry {
  return entry.kind === "regular"
    ? {
        path: entry.path,
        type: "regular",
        blobOid: entry.sha256,
        recreationMode: entry.recreationMode,
      }
    : {
        path: entry.path,
        type: "symlink",
        target: entry.target,
        symlinkKind: entry.symlinkKind,
      };
}

function sameFileObservation(before: Stats, after: Stats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mode === after.mode &&
    before.nlink === after.nlink &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

async function hashFileHandle(
  handle: FileHandle,
  maxFileBytes: number,
  signal?: AbortSignal,
): Promise<
  | { readonly tooLarge: true; readonly bytesRead: number }
  | {
      readonly tooLarge: false;
      readonly byteLength: number;
      readonly sha256: string;
    }
> {
  const hash = createHash("sha256");
  let bytesRead = 0;
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (true) {
    signal?.throwIfAborted();
    const result = await handle.read(buffer, 0, buffer.byteLength, position);
    if (result.bytesRead === 0) {
      break;
    }
    const chunk = buffer.subarray(0, result.bytesRead);
    bytesRead += chunk.byteLength;
    if (bytesRead > maxFileBytes) {
      return { tooLarge: true, bytesRead };
    }
    hash.update(chunk);
    position += result.bytesRead;
  }
  return {
    tooLarge: false,
    byteLength: bytesRead,
    sha256: hash.digest("hex"),
  };
}

interface ScanCandidate {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly stat: Stats;
}

type RegularScanResult =
  | { readonly kind: "too-large"; readonly detail: string }
  | {
      readonly kind: "entry";
      readonly entry: Extract<WorkspaceEntry, { kind: "regular" }>;
    };

async function readRegularCandidate(
  { relativePath, absolutePath, stat }: ScanCandidate,
  maxFileBytes: number,
  options: WorkspaceOperationOptions,
): Promise<RegularScanResult> {
  options.signal?.throwIfAborted();
  const handle = await openWorkspaceRegularCandidate(
    absolutePath,
    fsConstants.O_RDONLY,
  );
  return await withRetainedCleanup(
    async (): Promise<RegularScanResult> => {
      const before = await handle.stat();
      if (!before.isFile() || !sameFileObservation(stat, before)) {
        throw new Error("entry changed before it could be read safely");
      }
      if (before.size > maxFileBytes) {
        return {
          kind: "too-large",
          detail: `${before.size} bytes exceeds the ${maxFileBytes}-byte file limit`,
        };
      }

      const hashed = await hashFileHandle(handle, maxFileBytes, options.signal);
      if (hashed.tooLarge) {
        return {
          kind: "too-large",
          detail: `more than ${maxFileBytes} bytes were read before the file limit was detected`,
        };
      }
      const after = await handle.stat();
      if (!sameFileObservation(before, after)) {
        throw new Error("entry changed while it was being scanned");
      }
      return {
        kind: "entry",
        entry: {
          path: relativePath,
          kind: "regular",
          recreationMode:
            process.platform === "win32" ? null : after.mode & 0o7777,
          byteLength: hashed.byteLength,
          sha256: hashed.sha256,
          sourcePath: absolutePath,
        },
      };
    },
    () => handle.close(),
    `workspace entry ${relativePath} scan and cleanup both failed`,
  );
}

function settleScanTask<T>(task: Promise<T>): Promise<PromiseSettledResult<T>> {
  return task.then(
    (value) => ({ status: "fulfilled", value }),
    (reason: unknown) => ({ status: "rejected", reason }),
  );
}

function rethrowScanBatchFailure(
  cause: unknown,
  results: readonly PromiseSettledResult<unknown>[],
  signal?: AbortSignal,
): never {
  const failures = [
    ...new Set([
      cause,
      ...results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      ),
    ]),
  ].filter((error) => !isOperationCancelled(error, signal));
  if (failures.length === 0) throw cause;
  if (failures.length === 1) throw failures[0];
  throw aggregateFailures(failures, "workspace scan batch failed");
}

/** Capture the workspace using its current Git ignore policy. */
export async function scanWorkspace(
  root: string,
  options: ScanOptions = {},
): Promise<WorkspaceSnapshot> {
  return scanWorkspaceWithScope(root, options);
}

/**
 * Scan the physical workspace through an existing snapshot's managed-path
 * boundary. Current Git configuration and `.gitignore` contents do not alter
 * that boundary; current policy files are captured as ordinary file state.
 */
export async function scanWorkspaceForScope(
  root: string,
  targetScope: WorkspaceScope,
  options: ScanOptions = {},
): Promise<WorkspaceSnapshot> {
  return scanWorkspaceWithScope(root, options, targetScope);
}

export interface RestoreComparisonScanOptions extends WorkspaceOperationOptions {
  readonly gitIgnoreScratchParent?: string;
}

/** Compare a workspace with durable history, independent of capture quotas. */
export async function scanWorkspaceForRestoreComparison(
  root: string,
  targetScope: WorkspaceScope,
  options: RestoreComparisonScanOptions = {},
): Promise<WorkspaceSnapshot> {
  return scanWorkspaceWithScope(
    root,
    {
      ...options,
      maxFileBytes: Number.MAX_SAFE_INTEGER,
      maxSnapshotBytes: Number.MAX_SAFE_INTEGER,
      maxEntries: ABSOLUTE_MAX_TREE_ENTRIES,
      maxManifestBytes: ABSOLUTE_MAX_TREE_MANIFEST_BYTES,
      maxPathBytes: ABSOLUTE_MAX_WORKSPACE_RELATIVE_PATH_BYTES,
      maxPathComponents: ABSOLUTE_MAX_WORKSPACE_RELATIVE_PATH_COMPONENTS,
    },
    targetScope,
  );
}

/**
 * Recursively hash a workspace into a snapshot description. Regular files
 * are read in bounded chunks and retain an absolute source reference for the
 * publisher, which revalidates their digest when an object is not already
 * available. The walk never follows symlinks, structurally excludes any
 * `.git` path component, and records per-entry problems instead of aborting;
 * only an invalid root or a snapshot-quota overflow throws ScanError.
 */
async function scanWorkspaceWithScope(
  root: string,
  options: ScanOptions,
  targetScope?: WorkspaceScope,
): Promise<WorkspaceSnapshot> {
  options.signal?.throwIfAborted();
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxSnapshotBytes =
    options.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_TREE_ENTRIES;
  const maxManifestBytes =
    options.maxManifestBytes ?? DEFAULT_MAX_TREE_MANIFEST_BYTES;
  const maxPathBytes =
    options.maxPathBytes ?? DEFAULT_MAX_WORKSPACE_RELATIVE_PATH_BYTES;
  const maxPathComponents =
    options.maxPathComponents ?? DEFAULT_MAX_WORKSPACE_RELATIVE_PATH_COMPONENTS;
  const pathLimits: WorkspacePathLimits = {
    maxPathBytes,
    maxPathComponents,
  };
  if (
    !Number.isSafeInteger(maxFileBytes) ||
    maxFileBytes <= 0 ||
    !Number.isSafeInteger(maxSnapshotBytes) ||
    maxSnapshotBytes <= 0 ||
    !Number.isSafeInteger(maxEntries) ||
    maxEntries <= 0 ||
    maxEntries > ABSOLUTE_MAX_TREE_ENTRIES ||
    !Number.isSafeInteger(maxManifestBytes) ||
    maxManifestBytes <= 0 ||
    maxManifestBytes > ABSOLUTE_MAX_TREE_MANIFEST_BYTES ||
    !Number.isSafeInteger(maxPathBytes) ||
    maxPathBytes <= 0 ||
    maxPathBytes > ABSOLUTE_MAX_WORKSPACE_RELATIVE_PATH_BYTES ||
    !Number.isSafeInteger(maxPathComponents) ||
    maxPathComponents <= 0 ||
    maxPathComponents > ABSOLUTE_MAX_WORKSPACE_RELATIVE_PATH_COMPONENTS
  ) {
    throw new ScanError("scan limits are outside the supported range");
  }

  const requestedRoot = resolve(root);
  let workspaceRoot: string;
  try {
    // Pi may legitimately enter a workspace through a symlink. Resolve that
    // trusted root once so store identity and scanning agree; descendants are
    // still opened with lstat/O_NOFOLLOW and are never traversed through a
    // symlink.
    workspaceRoot = await realpath(requestedRoot);
  } catch (cause) {
    if (options.signal?.aborted) throw cause;
    throw new ScanError(`workspace root is not readable: ${root}`, { cause });
  }
  let rootStat: Stats;
  try {
    rootStat = await lstat(workspaceRoot);
  } catch (cause) {
    if (options.signal?.aborted) throw cause;
    throw new ScanError(`workspace root is not readable: ${root}`, { cause });
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new ScanError(`workspace root is not a real directory: ${root}`);
  }
  const discovery =
    targetScope === undefined
      ? await discoverWorkspaceScope(workspaceRoot, pathLimits)
      : undefined;
  if (discovery !== undefined && discovery.workspaceRoot !== workspaceRoot) {
    throw new ScanError("Git discovery changed the canonical workspace root");
  }
  const initialScope =
    targetScope === undefined
      ? discovery!.scope
      : canonicalizeWorkspaceScope(targetScope, pathLimits);
  const policyBudget = new WorkspaceGitPolicyBudget(initialScope, pathLimits);
  const syntheticScratch = {
    forbiddenRoots: [workspaceRoot],
    ...(options.gitIgnoreScratchParent === undefined
      ? {}
      : { scratchParent: options.gitIgnoreScratchParent }),
    pathLimits,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  const oracle =
    targetScope === undefined
      ? await createLiveGitIgnoreOracle(
          workspaceRoot,
          initialScope,
          pathLimits,
          options.signal,
        )
      : await createSyntheticGitIgnoreOracle(initialScope, syntheticScratch);

  const entries: WorkspaceEntry[] = [];
  const excludedOccupancies: ExcludedWorkspaceObservation[] = [];
  const directoryObservations: DirectoryObservation[] = [];
  const problems: ScanProblem[] = [];
  const canonicalOwners = new Map<string, string>();
  const policySources = new Map<string, WorkspaceGitignoreSource>(
    initialScope.kind === "git"
      ? initialScope.gitignoreSources.map((source) => [source.path, source])
      : [],
  );
  const reachedDirectories: string[] = [];
  interface OracleDecision extends GitIgnorePath {
    readonly managed: boolean;
  }
  const liveDecisions: OracleDecision[] = [];
  let totalBytes = 0;
  let inventoryCount = 0;
  options.onProgress?.({ files: 0, bytes: 0 });

  const addInventory = (): void => {
    inventoryCount += 1;
    if (inventoryCount > maxEntries) {
      throw new ScanError(
        `workspace inventory exceeds the ${maxEntries}-entry limit`,
      );
    }
  };

  const addBytes = (bytes: number): void => {
    totalBytes += bytes;
    if (totalBytes > maxSnapshotBytes) {
      throw new ScanError(
        `snapshot exceeds the ${maxSnapshotBytes}-byte limit (${totalBytes} bytes so far)`,
      );
    }
  };

  const classify = async (
    queries: readonly GitIgnorePath[],
  ): Promise<readonly boolean[]> => {
    const results: boolean[] = [];
    // Keep each protocol write comfortably below the oracle's byte ceiling,
    // while retaining one long-lived Git process for the whole scan.
    for (let offset = 0; offset < queries.length; offset += 2_048) {
      options.signal?.throwIfAborted();
      const batch = queries.slice(offset, offset + 2_048);
      const managed = await oracle.managed(batch);
      if (managed.length !== batch.length) {
        throw new ScanError(
          "Git ignore oracle returned the wrong result count",
        );
      }
      results.push(...managed);
      if (discovery?.scope.kind === "git") {
        batch.forEach((query, index) => {
          liveDecisions.push({
            ...query,
            managed: managed[index]!,
          });
        });
      }
    }
    return results;
  };

  const walk = async (
    absoluteDirectory: string,
    relativeDirectory: string,
    expectedDirectory: Stats,
  ): Promise<void> => {
    options.signal?.throwIfAborted();
    const assertDirectoryStable = async (): Promise<boolean> => {
      try {
        const observed = await lstat(absoluteDirectory);
        if (
          observed.isSymbolicLink() ||
          !observed.isDirectory() ||
          !sameFileObservation(expectedDirectory, observed)
        ) {
          throw new Error("directory changed while the workspace was scanned");
        }
        return true;
      } catch (cause) {
        if (options.signal?.aborted) throw cause;
        problems.push({
          path: relativeDirectory === "" ? "." : relativeDirectory,
          kind: "read-failed",
          detail: errorDetail(cause),
        });
        return false;
      }
    };
    if (!(await assertDirectoryStable())) {
      return;
    }
    directoryObservations.push({
      path: relativeDirectory,
      dev: expectedDirectory.dev,
      ino: expectedDirectory.ino,
    });
    reachedDirectories.push(relativeDirectory);

    const loadedIgnore =
      discovery?.scope.kind === "git"
        ? await readWorkspaceGitignoreSource(discovery, relativeDirectory)
        : undefined;
    if (loadedIgnore !== undefined) {
      const existing = policySources.get(loadedIgnore.path);
      if (
        existing !== undefined &&
        existing.contentsBase64 !== loadedIgnore.contentsBase64
      ) {
        throw new ScanError(
          "Git ignore policy changed while it was discovered",
        );
      }
      policyBudget.upsertGitignoreSource(loadedIgnore);
      policySources.set(loadedIgnore.path, loadedIgnore);
    }

    let names: string[];
    try {
      names = [];
      const directory = await opendir(absoluteDirectory);
      for await (const entry of directory) {
        options.signal?.throwIfAborted();
        // Repository metadata is never part of the workspace inventory.
        if (isGitComponent(entry.name)) continue;
        // The root consumes one slot before walking. Every other directory,
        // managed/excluded leaf, and problematic entry consumes exactly one
        // slot here, before classification can append an unbounded problem.
        addInventory();
        names.push(entry.name);
      }
    } catch (cause) {
      if (options.signal?.aborted) throw cause;
      if (cause instanceof ScanError) throw cause;
      problems.push({
        path: relativeDirectory === "" ? "." : relativeDirectory,
        kind: "read-failed",
        detail: errorDetail(cause),
      });
      await assertDirectoryStable();
      return;
    }
    // Deterministic visit order makes path-collision first-wins stable. The
    // array is bounded by the global inventory limit before each push.
    names.sort(compareUtf8);

    const candidates: ScanCandidate[] = [];
    for (let offset = 0; offset < names.length; offset += SCAN_CONCURRENCY) {
      options.signal?.throwIfAborted();
      const batch = names.slice(offset, offset + SCAN_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(
          async (
            name,
          ): Promise<
            | { readonly candidate: ScanCandidate }
            | { readonly problem: ScanProblem }
          > => {
            options.signal?.throwIfAborted();
            const relativePath =
              relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
            if (name !== name.normalize("NFC") || name.includes("\\")) {
              return {
                problem: {
                  path: relativePath,
                  kind: "unsupported",
                  detail:
                    name !== name.normalize("NFC")
                      ? "pathname is not NFC-normalized and cannot be restored byte-for-byte"
                      : "pathname contains a backslash and is not representable in the portable manifest",
                },
              };
            }
            try {
              canonicalWorkspaceRelativePath(relativePath, false, pathLimits);
            } catch (cause) {
              return {
                problem: {
                  path: relativePath,
                  kind: "unsupported",
                  detail: errorDetail(cause),
                },
              };
            }
            const absolutePath = join(absoluteDirectory, name);
            try {
              return {
                candidate: {
                  relativePath,
                  absolutePath,
                  stat: await lstat(absolutePath),
                },
              };
            } catch (cause) {
              if (options.signal?.aborted) throw cause;
              return {
                problem: {
                  path: relativePath,
                  kind: "read-failed",
                  detail: errorDetail(cause),
                },
              };
            }
          },
        ),
      );
      try {
        options.signal?.throwIfAborted();
        for (const result of results) {
          if (result.status === "rejected") throw result.reason;
          if ("problem" in result.value) problems.push(result.value.problem);
          else candidates.push(result.value.candidate);
        }
      } catch (cause) {
        rethrowScanBatchFailure(cause, results, options.signal);
      }
    }

    const managed = await classify(
      candidates.map(({ relativePath, stat }) => ({
        path: relativePath,
        kind: stat.isDirectory() ? "directory" : "non-directory",
      })),
    );
    const pending: Array<{
      readonly candidate: ScanCandidate;
      readonly result: Promise<PromiseSettledResult<RegularScanResult>>;
    }> = [];
    const pendingPaths = new Set<string>();
    let pendingBytes = 0;
    const flush = async (): Promise<void> => {
      if (pending.length === 0) return;
      const batch = pending.splice(0);
      const results = await Promise.all(batch.map(({ result }) => result));
      pendingPaths.clear();
      pendingBytes = 0;
      try {
        for (let index = 0; index < batch.length; index += 1) {
          options.signal?.throwIfAborted();
          const { relativePath } = batch[index]!.candidate;
          const result = results[index]!;
          if (result.status === "rejected") {
            if (result.reason instanceof ScanError) throw result.reason;
            problems.push({
              path: relativePath,
              kind: "read-failed",
              detail: errorDetail(result.reason),
            });
            continue;
          }
          const scanned = result.value;
          if (scanned.kind === "too-large") {
            problems.push({
              path: relativePath,
              kind: "too-large",
              detail: scanned.detail,
            });
            continue;
          }
          canonicalOwners.set(
            portableWorkspacePathKey(relativePath),
            relativePath,
          );
          entries.push(scanned.entry);
          addBytes(scanned.entry.byteLength);
          options.onProgress?.({ files: entries.length, bytes: totalBytes });
        }
        options.signal?.throwIfAborted();
      } catch (cause) {
        rethrowScanBatchFailure(cause, results, options.signal);
      }
    };
    try {
      for (let index = 0; index < candidates.length; index += 1) {
        options.signal?.throwIfAborted();
        const candidate = candidates[index]!;
        const { relativePath, absolutePath, stat } = candidate;
        // Resolve preceding path claims before recursion or a colliding candidate.
        if (
          !managed[index] ||
          !stat.isFile() ||
          stat.dev !== rootStat.dev ||
          stat.nlink > 1 ||
          stat.size > maxFileBytes ||
          pendingPaths.has(portableWorkspacePathKey(relativePath)) ||
          stat.size > maxSnapshotBytes - totalBytes - pendingBytes
        )
          await flush();
        if (!managed[index]) {
          // Record only the first excluded namespace boundary. Git cannot
          // re-include a child while its parent directory remains excluded.
          excludedOccupancies.push(excludedObservation(relativePath, stat));
          continue;
        }

        if (stat.isDirectory()) {
          if (stat.dev !== rootStat.dev) {
            problems.push({
              path: relativePath,
              kind: "cross-device",
              detail: "directory is on a different device",
            });
            continue;
          }
          const canonical = portableWorkspacePathKey(relativePath);
          const previous = canonicalOwners.get(canonical);
          if (previous !== undefined) {
            problems.push({
              path: relativePath,
              kind: "path-collision",
              detail: `collides with "${previous}" after portable case normalization`,
            });
            continue;
          }
          canonicalOwners.set(canonical, relativePath);
          await walk(absolutePath, relativePath, stat);
          continue;
        }
        if (stat.dev !== rootStat.dev) {
          problems.push({
            path: relativePath,
            kind: "cross-device",
            detail: "entry is on a different device",
          });
          continue;
        }

        const canonical = portableWorkspacePathKey(relativePath);
        const previous = canonicalOwners.get(canonical);
        if (previous !== undefined) {
          problems.push({
            path: relativePath,
            kind: "path-collision",
            detail: `collides with "${previous}" after portable case normalization`,
          });
          continue;
        }

        if (stat.isSymbolicLink()) {
          try {
            const targetBytes = await readlink(absolutePath, {
              encoding: "buffer",
            });
            const target = targetBytes.toString("utf8");
            if (!Buffer.from(target, "utf8").equals(targetBytes)) {
              throw new Error(
                "symlink target is not valid UTF-8 and cannot be restored byte-for-byte",
              );
            }
            let symlinkKind: SymlinkKind | null = null;
            try {
              const targetMetadata = await statPath(absolutePath);
              symlinkKind = targetMetadata.isDirectory() ? "directory" : "file";
            } catch {
              if (process.platform === "win32") {
                problems.push({
                  path: relativePath,
                  kind: "unsupported",
                  detail:
                    "Windows cannot portably capture a symlink whose target type is unavailable",
                });
                continue;
              }
            }
            canonicalOwners.set(canonical, relativePath);
            entries.push({
              path: relativePath,
              kind: "symlink",
              target,
              symlinkKind,
            });
            addBytes(Buffer.byteLength(target));
            options.onProgress?.({ files: entries.length, bytes: totalBytes });
          } catch (cause) {
            if (options.signal?.aborted) throw cause;
            if (cause instanceof ScanError) throw cause;
            problems.push({
              path: relativePath,
              kind: "read-failed",
              detail: errorDetail(cause),
            });
          }
          continue;
        }

        if (!stat.isFile()) {
          problems.push({
            path: relativePath,
            kind: "unsupported",
            detail: `${unsupportedType(stat)} entries are not part of a workspace snapshot`,
          });
          continue;
        }
        if (stat.nlink > 1) {
          problems.push({
            path: relativePath,
            kind: "hardlink",
            detail: `file has ${stat.nlink} hard links`,
          });
          continue;
        }
        if (stat.size > maxFileBytes) {
          problems.push({
            path: relativePath,
            kind: "too-large",
            detail: `${stat.size} bytes exceeds the ${maxFileBytes}-byte file limit`,
          });
          continue;
        }

        pendingPaths.add(canonical);
        pendingBytes += stat.size;
        pending.push({
          candidate,
          result: settleScanTask(
            readRegularCandidate(candidate, maxFileBytes, options),
          ),
        });
        if (pending.length === SCAN_CONCURRENCY) await flush();
      }
      await flush();
    } catch (cause) {
      const results = await Promise.all(pending.map(({ result }) => result));
      rethrowScanBatchFailure(cause, results, options.signal);
    }
    await assertDirectoryStable();
  };

  // The canonical root has no parent directory entry to charge its one slot.
  addInventory();
  await withScanCleanup(
    () => walk(workspaceRoot, "", rootStat),
    () => oracle.close(),
    "workspace scan and Git oracle cleanup both failed",
  );
  options.signal?.throwIfAborted();

  entries.sort((left, right) => compareUtf8(left.path, right.path));
  excludedOccupancies.sort((left, right) => compareUtf8(left.path, right.path));
  directoryObservations.sort((left, right) =>
    compareUtf8(left.path, right.path),
  );
  let scope = initialScope;
  if (discovery !== undefined) {
    const rediscovered = await discoverWorkspaceScope(
      workspaceRoot,
      pathLimits,
    );
    if (
      !workspaceScopesEqual(discovery.scope, rediscovered.scope, pathLimits)
    ) {
      throw new ScanError(
        "Git ignore policy changed while the workspace was scanned",
      );
    }
    if (discovery.scope.kind === "git") {
      if (rediscovered.scope.kind !== "git") {
        throw new ScanError(
          "Git worktree disappeared while the workspace was scanned",
        );
      }
      const finalSources = new Map<string, WorkspaceGitignoreSource>(
        rediscovered.scope.gitignoreSources.map((source) => [
          source.path,
          source,
        ]),
      );
      const finalPolicyBudget = new WorkspaceGitPolicyBudget(
        rediscovered.scope,
        pathLimits,
      );
      for (const directory of reachedDirectories) {
        options.signal?.throwIfAborted();
        const source = await readWorkspaceGitignoreSource(
          rediscovered,
          directory,
        );
        if (source !== undefined) {
          finalPolicyBudget.upsertGitignoreSource(source);
          finalSources.set(source.path, source);
        }
      }
      const observedScope = canonicalizeWorkspaceScope(
        {
          ...discovery.scope,
          gitignoreSources: [...policySources.values()],
        },
        pathLimits,
      );
      const finalScope = canonicalizeWorkspaceScope(
        {
          ...rediscovered.scope,
          gitignoreSources: [...finalSources.values()],
        },
        pathLimits,
      );
      if (!workspaceScopesEqual(observedScope, finalScope, pathLimits)) {
        throw new ScanError(
          "Git ignore policy changed while the workspace was scanned",
        );
      }
      scope = finalScope;
      if (scope.kind !== "git") {
        throw new ScanError(
          "Git scope disappeared while finalizing the workspace scan",
        );
      }
      const finalGitScope = scope;

      // The live Git process classified current paths. Replay every observed
      // decision through the archived policy before publishing that policy as
      // a durable deletion boundary.
      const replay = await createSyntheticGitIgnoreOracle(
        scope,
        syntheticScratch,
      );
      await withScanCleanup(
        async () => {
          if (
            finalGitScope.evaluator === null ||
            replay.gitVersion !== finalGitScope.evaluator.version
          ) {
            throw new ScanError(
              "archived Git policy was replayed by a different Git version",
            );
          }
          for (let offset = 0; offset < liveDecisions.length; offset += 2_048) {
            options.signal?.throwIfAborted();
            const expected = liveDecisions.slice(offset, offset + 2_048);
            const actual = await replay.managed(expected);
            if (
              actual.length !== expected.length ||
              actual.some(
                (managed, index) => managed !== expected[index]!.managed,
              )
            ) {
              throw new ScanError(
                "archived Git policy does not reproduce the live workspace boundary",
              );
            }
          }
        },
        () => replay.close(),
        "archived Git policy replay and cleanup both failed",
      );
    } else {
      scope = rediscovered.scope;
    }
  }
  const treeEntries = entries.map(workspaceEntryAsTreeEntry);
  if (targetScope === undefined) {
    try {
      // Live capture must satisfy the complete durable admission contract for
      // both Git and all-managed scopes.
      createCurrentTreeManifest(treeEntries, scope, {
        maxEntries,
        maxManifestBytes,
        ...pathLimits,
      });
    } catch (cause) {
      if (options.signal?.aborted) throw cause;
      throw new ScanError(
        "workspace entries do not satisfy the current tree manifest contract",
        { cause },
      );
    }
  } else {
    try {
      // A restore comparison deliberately combines an archived policy with
      // current policy-file bytes.  It is not a publishable manifest, but its
      // semantic projection is still charged by the exact same byte codec.
      encodeTreeManifestDocument(
        CURRENT_TREE_MANIFEST_FORMAT,
        treeEntries,
        scope,
        { maxEntries, maxManifestBytes, ...pathLimits },
      );
    } catch (cause) {
      if (options.signal?.aborted) throw cause;
      throw new ScanError(
        "workspace comparison exceeds the current tree manifest contract",
        { cause },
      );
    }
  }
  return {
    entries,
    excludedOccupancies,
    problems,
    rootPath: workspaceRoot,
    directoryObservations,
    gitOracleVersion: oracle.gitVersion,
    scope,
  };
}
