import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { portableWorkspacePathKey } from "./workspace-scope.ts";

export type SyntheticGitPathKind = "directory" | "non-directory";

export interface SyntheticGitShapePath {
  /** Canonical repository-relative path. */
  readonly path: string;
  readonly kind: SyntheticGitPathKind;
}

export interface SyntheticGitPolicySource {
  /** Canonical repository-relative `.gitignore` path. */
  readonly path: string;
  readonly contents: Uint8Array;
}

interface PolicyEntry extends SyntheticGitShapePath {
  readonly source: boolean;
}

interface PublishedPolicyObservation {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

function pathDepth(path: string): number {
  return path.split("/").length;
}

function parentPaths(path: string): readonly string[] {
  const components = path.split("/");
  const parents: string[] = [];
  let parent = "";
  for (const component of components.slice(0, -1)) {
    parent = parent === "" ? component : `${parent}/${component}`;
    parents.push(parent);
  }
  return parents;
}

function policyDirectory(path: string): string {
  const suffix = "/.gitignore";
  return path === ".gitignore" ? "" : path.slice(0, -suffix.length);
}

function sameObservation(
  expected: PublishedPolicyObservation,
  actual: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return (
    actual.isFile() &&
    !actual.isSymbolicLink() &&
    expected.dev === actual.dev &&
    expected.ino === actual.ino &&
    expected.size === actual.size &&
    expected.mtimeMs === actual.mtimeMs &&
    expected.ctimeMs === actual.ctimeMs
  );
}

/**
 * Owns the filesystem shape that Git consults while replaying archived policy.
 *
 * Query parents and directory targets are materialized before their protocol
 * write. Nested policy is published only when its directory is a strict query
 * ancestor, matching Git's loading order: a directory's own `.gitignore` does
 * not decide whether that directory is reachable. A current path that cannot
 * coexist with archived policy is conservatively classified unmanaged without
 * asking Git; contradictory observations between queries remain fatal drift.
 */
export class SyntheticGitDirectoryShape {
  readonly #repositoryRoot: string;
  readonly #policySourceByDirectory = new Map<
    string,
    SyntheticGitPolicySource
  >();
  readonly #policyByAlias = new Map<string, PolicyEntry>();
  readonly #queriesByAlias = new Map<string, SyntheticGitShapePath>();
  readonly #publishedPolicies = new Map<string, PublishedPolicyObservation>();

  constructor(
    repositoryRoot: string,
    policySources: readonly SyntheticGitPolicySource[],
  ) {
    this.#repositoryRoot = repositoryRoot;
    // Git init always creates this control directory. Scanner queries exclude
    // it, but direct adapter callers still receive a conservative conflict.
    this.#registerPolicy({
      path: ".git",
      kind: "directory",
      source: false,
    });
    for (const source of policySources) {
      const directory = policyDirectory(source.path);
      if (this.#policySourceByDirectory.has(directory)) {
        throw new Error(
          `synthetic Git policy has duplicate sources for ${JSON.stringify(directory)}`,
        );
      }
      this.#policySourceByDirectory.set(directory, source);
      for (const parent of parentPaths(source.path)) {
        this.#registerPolicy({
          path: parent,
          kind: "directory",
          source: false,
        });
      }
      this.#registerPolicy({
        path: source.path,
        kind: "non-directory",
        source: true,
      });
    }
  }

  /** `true` means the corresponding query can be delegated to Git. */
  async materialize(
    paths: readonly SyntheticGitShapePath[],
  ): Promise<readonly boolean[]> {
    const plannedQueries = new Map<string, SyntheticGitShapePath>();
    const representable = paths.map(() => true);

    // Validate the complete logical batch before changing the synthetic FS.
    for (let index = 0; index < paths.length; index += 1) {
      const item = paths[index]!;
      const shape = [
        ...parentPaths(item.path).map((path) => ({
          path,
          kind: "directory" as const,
        })),
        item,
      ];
      for (const component of shape) {
        this.#planQuery(plannedQueries, component);
        if (!this.#compatibleWithPolicy(component)) {
          representable[index] = false;
        }
      }
    }
    const delegated = paths.filter((_, index) => representable[index]);
    const directories = new Set<string>();
    for (const item of delegated) {
      for (const parent of parentPaths(item.path)) directories.add(parent);
      if (item.kind === "directory") directories.add(item.path);
    }
    for (const path of [...directories].sort((left, right) => {
      const depth = pathDepth(left) - pathDepth(right);
      return depth === 0
        ? Buffer.compare(Buffer.from(left), Buffer.from(right))
        : depth;
    })) {
      await this.#ensureDirectory(path);
    }

    const visiblePolicies = new Set<SyntheticGitPolicySource>();
    const rootPolicy = this.#policySourceByDirectory.get("");
    if (rootPolicy !== undefined && delegated.length > 0) {
      visiblePolicies.add(rootPolicy);
    }
    for (const { path } of delegated) {
      for (const parent of parentPaths(path)) {
        const source = this.#policySourceByDirectory.get(parent);
        if (source !== undefined) visiblePolicies.add(source);
      }
    }
    for (const source of [...visiblePolicies].sort((left, right) =>
      Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
    )) {
      await this.#publishPolicy(source);
    }
    for (const item of delegated) await this.#assertFilesystemKind(item);
    for (const [key, item] of plannedQueries) {
      this.#queriesByAlias.set(key, item);
    }
    return representable;
  }

  #registerPolicy(entry: PolicyEntry): void {
    const key = portableWorkspacePathKey(entry.path);
    const existing = this.#policyByAlias.get(key);
    if (existing === undefined) {
      this.#policyByAlias.set(key, entry);
      return;
    }
    if (existing.path !== entry.path) {
      throw new Error(
        `synthetic Git policy aliases ${JSON.stringify(existing.path)} and ${JSON.stringify(entry.path)}`,
      );
    }
    if (existing.kind !== entry.kind) {
      throw new Error(
        `synthetic Git policy changes kind at ${JSON.stringify(entry.path)}`,
      );
    }
  }

  #planQuery(
    entries: Map<string, SyntheticGitShapePath>,
    candidate: SyntheticGitShapePath,
  ): void {
    const key = portableWorkspacePathKey(candidate.path);
    const existing = entries.get(key) ?? this.#queriesByAlias.get(key);
    if (existing === undefined) {
      entries.set(key, candidate);
      return;
    }
    if (existing.path !== candidate.path) {
      const policy = this.#policyByAlias.get(key);
      if (
        policy?.source === true &&
        policy.kind === "non-directory" &&
        existing.kind === "non-directory" &&
        candidate.kind === "non-directory"
      ) {
        // A manifest may carry the statically authenticated policy occupant
        // under its actual portable alias while validation also queries the
        // canonical source path. Both spellings denote that one policy file.
        return;
      }
      throw new Error(
        `synthetic Git queries alias ${JSON.stringify(existing.path)} and ${JSON.stringify(candidate.path)}`,
      );
    }
    if (existing.kind !== candidate.kind) {
      throw new Error(
        `synthetic Git query changes kind at ${JSON.stringify(candidate.path)}`,
      );
    }
  }

  #compatibleWithPolicy(candidate: SyntheticGitShapePath): boolean {
    const policy = this.#policyByAlias.get(
      portableWorkspacePathKey(candidate.path),
    );
    if (policy === undefined) return true;
    if (policy.path === candidate.path) return policy.kind === candidate.kind;
    // A same-kind alias of a policy file is one statically bound occupant.
    // Tree manifests authenticate its bytes before the oracle is consulted.
    return (
      policy.source &&
      policy.kind === "non-directory" &&
      candidate.kind === "non-directory"
    );
  }

  async #ensureDirectory(path: string): Promise<void> {
    const absolute = join(this.#repositoryRoot, ...path.split("/"));
    try {
      const observation = await lstat(absolute);
      if (!observation.isDirectory() || observation.isSymbolicLink()) {
        throw new Error(
          `synthetic Git path is not a real directory: ${JSON.stringify(path)}`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(absolute);
      const observation = await lstat(absolute);
      if (!observation.isDirectory() || observation.isSymbolicLink()) {
        throw new Error(
          `synthetic Git directory changed while materializing ${JSON.stringify(path)}`,
        );
      }
    }
  }

  async #publishPolicy(source: SyntheticGitPolicySource): Promise<void> {
    const absolute = join(this.#repositoryRoot, ...source.path.split("/"));
    const published = this.#publishedPolicies.get(source.path);
    if (published !== undefined) {
      const observation = await lstat(absolute);
      if (!sameObservation(published, observation)) {
        throw new Error(
          `synthetic Git policy changed at ${JSON.stringify(source.path)}`,
        );
      }
      return;
    }
    await writeFile(absolute, source.contents, { flag: "wx" });
    const observation = await lstat(absolute);
    if (!observation.isFile() || observation.isSymbolicLink()) {
      throw new Error(
        `synthetic Git policy is not a regular file: ${JSON.stringify(source.path)}`,
      );
    }
    this.#publishedPolicies.set(source.path, {
      dev: observation.dev,
      ino: observation.ino,
      size: observation.size,
      mtimeMs: observation.mtimeMs,
      ctimeMs: observation.ctimeMs,
    });
  }

  async #assertFilesystemKind(query: SyntheticGitShapePath): Promise<void> {
    const absolute = join(this.#repositoryRoot, ...query.path.split("/"));
    const observation = await lstat(absolute).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (query.kind === "directory") {
      if (
        observation === undefined ||
        !observation.isDirectory() ||
        observation.isSymbolicLink()
      ) {
        throw new Error(
          `synthetic Git directory shape changed at ${JSON.stringify(query.path)}`,
        );
      }
      return;
    }
    const policy = this.#policyByAlias.get(
      portableWorkspacePathKey(query.path),
    );
    if (observation === undefined) return;
    if (
      policy?.source !== true ||
      policy.kind !== "non-directory" ||
      observation.isDirectory() ||
      observation.isSymbolicLink()
    ) {
      throw new Error(
        `synthetic Git non-directory shape changed at ${JSON.stringify(query.path)}`,
      );
    }
  }
}
