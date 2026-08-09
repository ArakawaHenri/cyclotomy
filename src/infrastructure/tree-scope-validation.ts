import {
  createSyntheticGitIgnoreOracle,
  type SyntheticGitIgnoreScratchOptions,
} from "./git-ignore-oracle.ts";
import { TreeManifestError, type TreeManifest } from "./tree-manifest.ts";
import {
  ABSOLUTE_WORKSPACE_PATH_LIMITS,
  workspaceLocalGitignorePath,
  workspaceScopePathKey,
} from "./workspace-scope.ts";

const VALIDATION_BATCH_SIZE = 2_048;

/**
 * Authenticate the mutation boundary between a durable manifest and its
 * archived Git policy. Structural parsing proves that paths are safe; this
 * check additionally proves that every path is owned by the target policy.
 */
export async function validateTreeEntriesAgainstScope(
  manifest: TreeManifest,
  scratchOptions: SyntheticGitIgnoreScratchOptions = {},
): Promise<void> {
  const scope = manifest.scope;
  if (scope.kind === "all-managed") {
    return;
  }

  interface ValidationPath {
    readonly path: string;
    readonly isEntry: boolean;
    readonly isLocalIgnoreSource: boolean;
  }
  const pathsByKey = new Map<string, ValidationPath>(
    manifest.entries.map(({ path }) => [
      workspaceScopePathKey(scope, path, ABSOLUTE_WORKSPACE_PATH_LIMITS),
      { path, isEntry: true, isLocalIgnoreSource: false },
    ]),
  );
  for (const source of scope.gitignoreSources) {
    const localPath = workspaceLocalGitignorePath(
      scope,
      source.path,
      ABSOLUTE_WORKSPACE_PATH_LIMITS,
    );
    if (localPath === undefined) continue;
    const key = workspaceScopePathKey(
      scope,
      localPath,
      ABSOLUTE_WORKSPACE_PATH_LIMITS,
    );
    const existing = pathsByKey.get(key);
    pathsByKey.set(key, {
      path: existing?.path ?? localPath,
      isEntry: existing?.isEntry ?? false,
      isLocalIgnoreSource: true,
    });
  }
  const paths = [...pathsByKey.values()];
  if (paths.length === 0) return;

  let oracle: Awaited<ReturnType<typeof createSyntheticGitIgnoreOracle>>;
  try {
    oracle = await createSyntheticGitIgnoreOracle(scope, {
      ...scratchOptions,
      pathLimits: ABSOLUTE_WORKSPACE_PATH_LIMITS,
    });
  } catch (error) {
    throw new TreeManifestError(
      "object-integrity",
      "tree workspace scope could not be validated",
      error,
    );
  }

  let failed = false;
  try {
    for (
      let offset = 0;
      offset < paths.length;
      offset += VALIDATION_BATCH_SIZE
    ) {
      const batch = paths.slice(offset, offset + VALIDATION_BATCH_SIZE);
      const managed = await oracle.managed(
        batch.map(({ path }) => ({ path, isDirectory: false })),
      );
      if (managed.length !== batch.length) {
        throw new TreeManifestError(
          "object-integrity",
          "Git ignore oracle returned the wrong result count while validating a tree",
        );
      }
      for (let index = 0; index < batch.length; index += 1) {
        const item = batch[index]!;
        const isManaged = managed[index]!;
        if (item.isEntry && !isManaged) {
          throw new TreeManifestError(
            "object-integrity",
            `tree entry is excluded by its archived workspace scope: ${item.path}`,
          );
        }
        if (item.isLocalIgnoreSource && isManaged && !item.isEntry) {
          throw new TreeManifestError(
            "object-integrity",
            `tree omits a managed archived .gitignore source: ${item.path}`,
          );
        }
      }
    }
  } catch (error) {
    failed = true;
    if (error instanceof TreeManifestError) throw error;
    throw new TreeManifestError(
      "object-integrity",
      "tree entries could not be validated against their archived workspace scope",
      error,
    );
  } finally {
    if (failed) {
      await oracle.close().catch(() => {});
    } else {
      try {
        await oracle.close();
      } catch (error) {
        throw new TreeManifestError(
          "object-integrity",
          "tree workspace scope validator did not close cleanly",
          error,
        );
      }
    }
  }
}
