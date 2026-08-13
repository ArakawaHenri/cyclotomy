import {
  type TreeEntry,
  type TreeManifest,
} from "./tree-formats/manifest-codec.ts";
import { CURRENT_TREE_MANIFEST_FORMAT } from "./tree-formats/current.ts";
import {
  ABSOLUTE_WORKSPACE_PATH_LIMITS,
  workspaceScopesEqual,
} from "./workspace-scope.ts";
import type {
  ExcludedWorkspaceOccupancy,
  ScanProblem,
  WorkspaceState,
} from "./workspace-scan.ts";

export interface RestoreScopeBlocker {
  readonly path: string;
  readonly targetPath: string;
}

/** Ephemeral physical directory spelling change; never persisted in a tree. */
export interface WorkspacePathRename {
  readonly from: string;
  readonly to: string;
}

/** One logical restore plan shared by preview, staging, and apply. */
export interface WorkspaceRestorePlan {
  /** Present in the checkpoint but absent from the current workspace. */
  readonly created: readonly string[];
  /** Present now, absent from target, and eligible for deletion by apply. */
  readonly deleted: readonly string[];
  readonly modified: readonly string[];
  /** Physical directory spelling changes proved by restore preparation. */
  readonly renamed: readonly WorkspacePathRename[];
  /** Blob objects whose bytes the planned restore may need to write. */
  readonly requiredBlobOids: readonly string[];
  /** Unmanaged descendants that prevent a target type replacement. */
  readonly scopeBlockers: readonly RestoreScopeBlocker[];
  /** Excluded namespace markers changed between two workspace observations. */
  readonly occupancyChanged: readonly string[];
  /** A non-empty list means the plan is conservative, not complete. */
  readonly problems: readonly ScanProblem[];
}

/** In-memory comparison target; never encoded as a durable tree object. */
export interface WorkspaceComparisonManifest extends TreeManifest {
  readonly excludedOccupancies: readonly ExcludedWorkspaceOccupancy[];
}

function nonDirectoryTargetAncestor(
  path: string,
  targetByPath: ReadonlyMap<string, TreeEntry>,
): string | undefined {
  let separator = path.lastIndexOf("/");
  while (separator !== -1) {
    const ancestorPath = path.slice(0, separator);
    const ancestor = targetByPath.get(ancestorPath);
    if (ancestor !== undefined) return ancestorPath;
    separator = path.lastIndexOf("/", separator - 1);
  }
  return undefined;
}

function nonDirectoryTargetAtOrAbove(
  path: string,
  targetByPath: ReadonlyMap<string, TreeEntry>,
): string | undefined {
  if (targetByPath.has(path)) return path;
  return nonDirectoryTargetAncestor(path, targetByPath);
}

function ancestorDirectories(path: string, into: Set<string>): void {
  let separator = path.lastIndexOf("/");
  while (separator !== -1) {
    const ancestor = path.slice(0, separator);
    into.add(ancestor);
    separator = ancestor.lastIndexOf("/");
  }
}

function comparisonOccupancies(
  target: TreeManifest,
): readonly ExcludedWorkspaceOccupancy[] | undefined {
  return "excludedOccupancies" in target
    ? (target as WorkspaceComparisonManifest).excludedOccupancies
    : undefined;
}

/**
 * Classify the exact logical actions needed to make `current` equal `target`.
 * Filesystem identity/race validation remains the executor's responsibility.
 */
export function planWorkspaceRestore(
  current: WorkspaceState,
  target: TreeManifest,
): WorkspaceRestorePlan {
  const targetByPath = new Map<string, TreeEntry>(
    target.entries.map((entry) => [entry.path, entry]),
  );
  const currentByPath = new Map(
    current.entries.map((entry) => [entry.path, entry] as const),
  );
  const created: string[] = [];
  const deleted: string[] = [];
  const modified: string[] = [];
  const scopeBlockers: RestoreScopeBlocker[] = [];
  const occupancyChanged: string[] = [];
  const problems = [...current.problems];
  const blockerKeys = new Set<string>();
  const addScopeBlocker = (path: string, targetPath: string): void => {
    const key = `${path}\0${targetPath}`;
    if (blockerKeys.has(key)) return;
    blockerKeys.add(key);
    scopeBlockers.push({ path, targetPath });
    problems.push({
      path,
      kind: "scope-blocker",
      detail: `excluded namespace occupancy blocks target path "${targetPath}"`,
    });
  };
  const scopeMatches = workspaceScopesEqual(
    current.scope,
    target.scope,
    ABSOLUTE_WORKSPACE_PATH_LIMITS,
  );
  if (!scopeMatches) {
    problems.push({
      path: ".",
      kind: "scope-mismatch",
      detail:
        "current inventory was not scanned through the target workspace scope",
    });
  }

  for (const entry of current.entries) {
    const wanted = targetByPath.get(entry.path);
    if (wanted === undefined) {
      // A target-scope scan emits only managed entries. Re-evaluating the
      // policy here would create a second Git implementation and could make
      // preview/apply disagree. A mismatched scope is already incomplete and
      // therefore must not authorize deletion.
      if (scopeMatches) {
        deleted.push(entry.path);
      }
    } else if (entry.kind === "regular") {
      if (wanted.type !== "regular" || wanted.blobOid !== entry.sha256) {
        modified.push(entry.path);
      }
    } else if (wanted.type !== "symlink" || wanted.target !== entry.target) {
      modified.push(entry.path);
    }
  }

  const targetImplicitDirectories = new Set<string>();
  for (const entry of target.entries) {
    ancestorDirectories(entry.path, targetImplicitDirectories);
  }
  for (const occupancy of current.excludedOccupancies) {
    const targetPath =
      nonDirectoryTargetAtOrAbove(occupancy.path, targetByPath) ??
      (targetImplicitDirectories.has(occupancy.path)
        ? occupancy.path
        : undefined);
    if (targetPath !== undefined) {
      addScopeBlocker(occupancy.path, targetPath);
    }
  }

  const expectedOccupancies = comparisonOccupancies(target);
  if (expectedOccupancies !== undefined) {
    const currentKinds = new Map(
      current.excludedOccupancies.map(
        (occupancy) => [occupancy.path, occupancy.kind] as const,
      ),
    );
    const expectedKinds = new Map(
      expectedOccupancies.map(
        (occupancy) => [occupancy.path, occupancy.kind] as const,
      ),
    );
    const paths = new Set([...currentKinds.keys(), ...expectedKinds.keys()]);
    for (const path of paths) {
      if (currentKinds.get(path) !== expectedKinds.get(path)) {
        occupancyChanged.push(path);
      }
    }
  }

  const requiredBlobOids = new Set<string>();
  for (const entry of target.entries) {
    if (!currentByPath.has(entry.path)) created.push(entry.path);
    if (entry.type !== "regular") continue;
    const observed = currentByPath.get(entry.path);
    if (observed?.kind !== "regular" || observed.sha256 !== entry.blobOid) {
      requiredBlobOids.add(entry.blobOid);
    }
  }

  created.sort();
  deleted.sort();
  modified.sort();
  scopeBlockers.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  occupancyChanged.sort();
  return {
    created,
    deleted,
    modified,
    renamed: [],
    requiredBlobOids: [...requiredBlobOids].sort(),
    scopeBlockers,
    occupancyChanged,
    problems,
  };
}

export function restorePlanHasChanges(plan: WorkspaceRestorePlan): boolean {
  return (
    plan.created.length > 0 ||
    plan.deleted.length > 0 ||
    plan.modified.length > 0 ||
    plan.renamed.length > 0 ||
    plan.occupancyChanged.length > 0
  );
}

/** Adapt one complete observation into an unpublished comparison target. */
export function workspaceSnapshotAsManifest(
  snapshot: WorkspaceState,
): WorkspaceComparisonManifest {
  return {
    format: CURRENT_TREE_MANIFEST_FORMAT,
    entries: snapshot.entries.map((entry): TreeEntry =>
      entry.kind === "regular"
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
          },
    ),
    excludedOccupancies: snapshot.excludedOccupancies.map(({ path, kind }) => ({
      path,
      kind,
    })),
    scope: snapshot.scope,
  };
}
