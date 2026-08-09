import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { basename, join } from "node:path";

import type { TreeManifest } from "./tree-manifest.ts";
import {
  planWorkspaceRestore,
  type RestoreScopeBlocker,
  type WorkspaceRestorePlan,
} from "./restore-plan.ts";
import type {
  DirectoryObservation,
  ExcludedWorkspaceObservation,
  ScanProblem,
  WorkspaceEntry,
  WorkspaceSnapshot,
} from "./workspace-scan.ts";
import { portableWorkspacePathKey } from "./workspace-scope.ts";

type WorkspacePathAliasSourceKind = "entry" | "directory";

/**
 * One current namespace spelling that occupies a target's portable path.
 * When `targetExisted` is true, matching device/inode identities prove a
 * physical alias. Otherwise the target spelling was proved absent and apply
 * must remove or recase the authenticated source before creating it.
 */
export interface WorkspacePathAlias {
  readonly from: string;
  readonly to: string;
  readonly sourceKind: WorkspacePathAliasSourceKind;
  readonly targetExisted: boolean;
  /** A directory rename is safe without remapping managed descendant paths. */
  readonly canRecaseDirectory: boolean;
  readonly dev: number;
  readonly ino: number;
}

interface PreparedWorkspaceRestorePlan {
  readonly plan: WorkspaceRestorePlan;
  readonly workspaceAliases: readonly WorkspacePathAlias[];
}

class RestorePreparationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RestorePreparationError";
  }
}

type CurrentNamespaceCandidate =
  | {
      readonly path: string;
      readonly kind: "entry";
      readonly entry: WorkspaceEntry;
    }
  | {
      readonly path: string;
      readonly kind: "directory";
      readonly observation: DirectoryObservation;
    }
  | {
      readonly path: string;
      readonly kind: "excluded";
      readonly observation: ExcludedWorkspaceObservation;
    };

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function usableIdentity(metadata: Stats): boolean {
  // A zero inode is the portable "identity unavailable" signal. Device alone
  // only identifies a filesystem and must never authorize path aliasing.
  return metadata.ino !== 0;
}

type NamespaceKind = "directory" | "symlink" | "regular" | "other";

function namespaceKind(metadata: Stats): NamespaceKind {
  if (metadata.isDirectory()) return "directory";
  if (metadata.isSymbolicLink()) return "symlink";
  if (metadata.isFile()) return "regular";
  return "other";
}

function identityKey(
  dev: number,
  ino: number,
  kind: NamespaceKind,
): string | undefined {
  return ino === 0 ? undefined : `${dev}\0${ino}\0${kind}`;
}

function statsIdentityKey(metadata: Stats): string | undefined {
  return identityKey(metadata.dev, metadata.ino, namespaceKind(metadata));
}

function recordedCandidateIdentityKey(
  candidate: CurrentNamespaceCandidate,
): string | undefined {
  if (candidate.kind === "entry") return undefined;
  const { dev, ino } = candidate.observation;
  return identityKey(
    dev,
    ino,
    candidate.kind === "directory" ? "directory" : candidate.observation.kind,
  );
}

function sameInode(left: Stats, right: Stats): boolean {
  return (
    usableIdentity(left) &&
    usableIdentity(right) &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    namespaceKind(left) === namespaceKind(right)
  );
}

function isAtOrBelow(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function hasPathAtOrAbove(path: string, paths: ReadonlySet<string>): boolean {
  let candidate = path;
  while (true) {
    if (paths.has(candidate)) return true;
    const separator = candidate.lastIndexOf("/");
    if (separator === -1) return false;
    candidate = candidate.slice(0, separator);
  }
}

function ancestorDirectories(path: string, into: Set<string>): void {
  let separator = path.lastIndexOf("/");
  while (separator !== -1) {
    const ancestor = path.slice(0, separator);
    into.add(ancestor);
    separator = ancestor.lastIndexOf("/");
  }
}

async function observeWorkspacePath(
  workspaceRoot: string,
  path: string,
): Promise<Stats | undefined> {
  let absolute = workspaceRoot;
  const components = path.split("/");
  for (let index = 0; index < components.length; index += 1) {
    absolute = join(absolute, components[index]!);
    let metadata: Stats;
    try {
      metadata = await lstat(absolute);
    } catch (error) {
      if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
        return undefined;
      }
      throw error;
    }
    if (
      index < components.length - 1 &&
      (metadata.isSymbolicLink() || !metadata.isDirectory())
    ) {
      return undefined;
    }
    if (index === components.length - 1) return metadata;
  }
  return undefined;
}

async function observeAliasSource(
  workspaceRoot: string,
  path: string,
): Promise<Stats> {
  try {
    const metadata = await observeWorkspacePath(workspaceRoot, path);
    if (metadata !== undefined) return metadata;
    throw new Error("path is absent or below a non-directory");
  } catch (cause) {
    throw new RestorePreparationError(
      `physical alias candidate changed after the workspace scan: ${path}`,
      { cause },
    );
  }
}

function withAliasScopeBlockers(
  plan: WorkspaceRestorePlan,
  blockers: readonly RestoreScopeBlocker[],
): WorkspaceRestorePlan {
  if (blockers.length === 0) return plan;
  const scopeBlockers = [...plan.scopeBlockers];
  const problems: ScanProblem[] = [...plan.problems];
  const seen = new Set(
    scopeBlockers.map(({ path, targetPath }) => `${path}\0${targetPath}`),
  );
  for (const blocker of blockers) {
    const key = `${blocker.path}\0${blocker.targetPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    scopeBlockers.push(blocker);
    problems.push({
      path: blocker.path,
      kind: "scope-blocker",
      detail: `excluded namespace occupancy blocks target path "${blocker.targetPath}"`,
    });
  }
  scopeBlockers.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  return { ...plan, scopeBlockers, problems };
}

/**
 * Prepare the exact logical restore plan and supplement it with authenticated
 * portable namespace aliases. Git remains the sole ignore matcher: structural
 * keys never authorize ownership, only alias preflight and ordering.
 */
export async function prepareWorkspaceRestorePlan(
  current: WorkspaceSnapshot,
  target: TreeManifest,
): Promise<PreparedWorkspaceRestorePlan> {
  const basePlan = planWorkspaceRestore(current, target);
  if (basePlan.problems.length > 0) {
    return { plan: basePlan, workspaceAliases: [] };
  }

  const candidatesByKey = new Map<string, CurrentNamespaceCandidate[]>();
  const allCandidates: CurrentNamespaceCandidate[] = [];
  const exactCurrentPaths = new Set<string>();
  const addCandidate = (candidate: CurrentNamespaceCandidate): void => {
    allCandidates.push(candidate);
    exactCurrentPaths.add(candidate.path);
    const key = portableWorkspacePathKey(candidate.path);
    const candidates = candidatesByKey.get(key) ?? [];
    candidates.push(candidate);
    candidatesByKey.set(key, candidates);
  };
  for (const entry of current.entries) {
    addCandidate({ path: entry.path, kind: "entry", entry });
  }
  for (const observation of current.directoryObservations) {
    if (observation.path !== "") {
      addCandidate({
        path: observation.path,
        kind: "directory",
        observation,
      });
    }
  }
  for (const observation of current.excludedOccupancies) {
    addCandidate({
      path: observation.path,
      kind: "excluded",
      observation,
    });
  }

  const targetDirectories = new Set<string>();
  for (const entry of target.entries) {
    ancestorDirectories(entry.path, targetDirectories);
  }
  const targetNamespacePaths = new Set<string>([
    ...targetDirectories,
    ...target.entries.map((entry) => entry.path),
  ]);
  const currentManagedDirectories = new Set<string>();
  for (const entry of current.entries) {
    ancestorDirectories(entry.path, currentManagedDirectories);
  }
  const workspaceAliases: WorkspacePathAlias[] = [];
  const aliasBlockers: RestoreScopeBlocker[] = [];
  const excludedAliasTargetRoots = new Set<string>();
  const sourceMetadata = new Map<string, Stats>();
  const metadataForCandidate = async (
    candidate: CurrentNamespaceCandidate,
  ): Promise<Stats> => {
    const cached = sourceMetadata.get(candidate.path);
    if (cached !== undefined) return cached;
    const metadata = await observeAliasSource(current.rootPath, candidate.path);
    sourceMetadata.set(candidate.path, metadata);
    return metadata;
  };
  let candidatesByIdentity:
    ReadonlyMap<string, readonly CurrentNamespaceCandidate[]> | undefined;
  const identityCandidates = async (
    targetMetadata: Stats,
  ): Promise<readonly CurrentNamespaceCandidate[]> => {
    const targetKey = statsIdentityKey(targetMetadata);
    if (targetKey === undefined) return [];
    if (candidatesByIdentity === undefined) {
      const index = new Map<string, CurrentNamespaceCandidate[]>();
      for (const candidate of allCandidates) {
        const key =
          recordedCandidateIdentityKey(candidate) ??
          statsIdentityKey(await metadataForCandidate(candidate));
        if (key === undefined) continue;
        const matches = index.get(key) ?? [];
        matches.push(candidate);
        index.set(key, matches);
      }
      candidatesByIdentity = index;
    }
    return candidatesByIdentity.get(targetKey) ?? [];
  };

  for (const targetPath of [...targetNamespacePaths].sort()) {
    // Once an excluded physical alias blocks an implicit target directory, its
    // descendants are already explained by that boundary. The scanner rightly
    // did not enumerate inside the excluded root, so probing those descendants
    // would misreport them as post-scan namespace additions.
    if (hasPathAtOrAbove(targetPath, excludedAliasTargetRoots)) continue;
    if (exactCurrentPaths.has(targetPath)) continue;
    let targetMetadata: Stats | undefined;
    try {
      targetMetadata = await observeWorkspacePath(current.rootPath, targetPath);
    } catch (error) {
      throw new RestorePreparationError(
        `cannot inspect target namespace path: ${targetPath}`,
        { cause: error },
      );
    }
    const candidates =
      candidatesByKey.get(portableWorkspacePathKey(targetPath)) ?? [];
    if (targetMetadata === undefined) {
      if (candidates.length === 0) continue;
      const excluded = candidates.filter(
        (candidate) => candidate.kind === "excluded",
      );
      if (excluded.length > 0) {
        for (const candidate of excluded) {
          aliasBlockers.push({ path: candidate.path, targetPath });
        }
        excludedAliasTargetRoots.add(targetPath);
        continue;
      }
      if (candidates.length !== 1) {
        throw new RestorePreparationError(
          `target namespace has an ambiguous portable path alias: ${targetPath}`,
        );
      }
      const candidate = candidates[0]!;
      if (candidate.kind === "excluded") {
        throw new RestorePreparationError(
          `target namespace has an unresolved excluded alias: ${targetPath}`,
        );
      }
      const metadata = await metadataForCandidate(candidate);
      workspaceAliases.push({
        from: candidate.path,
        to: targetPath,
        sourceKind: candidate.kind,
        targetExisted: false,
        canRecaseDirectory:
          candidate.kind === "directory" &&
          !hasPathAtOrAbove(candidate.path, currentManagedDirectories),
        dev: metadata.dev,
        ino: metadata.ino,
      });
      continue;
    }

    const aliases: Array<{
      readonly candidate: CurrentNamespaceCandidate;
      readonly metadata: Stats;
    }> = [];
    const inspected = new Set<string>();
    const inspectCandidate = async (
      candidate: CurrentNamespaceCandidate,
    ): Promise<void> => {
      if (candidate.path === targetPath) return;
      if (inspected.has(candidate.path)) return;
      inspected.add(candidate.path);
      const metadata = await metadataForCandidate(candidate);
      if (sameInode(metadata, targetMetadata)) {
        aliases.push({ candidate, metadata });
      }
    };
    for (const candidate of candidates) {
      await inspectCandidate(candidate);
    }
    if (aliases.length === 0) {
      // Unicode filesystem case folding is not identical to the conservative
      // portable structural key on every supported host. Fall back to identity
      // only after the target spelling is known to exist; this keeps the common
      // path cheap without making the folded key authoritative. Build the
      // identity index only once so multiple Unicode aliases stay O(N + M).
      for (const candidate of await identityCandidates(targetMetadata)) {
        await inspectCandidate(candidate);
      }
    }
    if (aliases.length !== 1) {
      throw new RestorePreparationError(
        aliases.length === 0
          ? `target namespace acquired an unobserved path after the workspace scan: ${targetPath}`
          : `target namespace has an ambiguous physical path alias: ${targetPath}`,
      );
    }

    const match = aliases[0]!;
    const { candidate, metadata } = match;
    if (candidate.kind === "excluded") {
      aliasBlockers.push({ path: candidate.path, targetPath });
      excludedAliasTargetRoots.add(targetPath);
      continue;
    }
    workspaceAliases.push({
      from: candidate.path,
      to: targetPath,
      sourceKind: candidate.kind,
      targetExisted: true,
      canRecaseDirectory: candidate.kind === "directory",
      dev: metadata.dev,
      ino: metadata.ino,
    });
  }

  // Even a content-preserving directory recase mutates the namespace that an
  // excluded descendant inhabits. Keep that entire boundary unmanaged rather
  // than silently changing paths omitted by the target-scope snapshot.
  for (const alias of workspaceAliases) {
    if (alias.sourceKind !== "directory") continue;
    for (const occupancy of current.excludedOccupancies) {
      if (isAtOrBelow(occupancy.path, alias.from)) {
        aliasBlockers.push({
          path: occupancy.path,
          targetPath: alias.to,
        });
      }
    }
  }

  workspaceAliases.sort((left, right) =>
    left.to < right.to ? -1 : left.to > right.to ? 1 : 0,
  );
  const renamed = workspaceAliases
    .filter(
      (alias) =>
        alias.sourceKind === "directory" &&
        alias.canRecaseDirectory &&
        targetDirectories.has(alias.to) &&
        basename(alias.from) !== basename(alias.to),
    )
    .map(({ from, to }) => ({ from, to }));
  return {
    plan: {
      ...withAliasScopeBlockers(basePlan, aliasBlockers),
      renamed,
    },
    workspaceAliases,
  };
}
