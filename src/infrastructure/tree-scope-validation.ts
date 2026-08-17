import {
  createSyntheticGitIgnoreOracle,
  type SyntheticGitIgnoreScratchOptions,
} from "./git-ignore-oracle.ts";
import { primaryFailure, withRetainedCleanup } from "./failure-settlement.ts";
import type { GitReplayAttestation } from "./git-replay-risk.ts";
import { TreeManifestError } from "./tree-formats/manifest-codec.ts";
import type { CurrentTreeManifest } from "./tree-formats/current.ts";
import {
  ABSOLUTE_WORKSPACE_PATH_LIMITS,
  workspaceLocalGitignorePath,
  workspaceScopePathKey,
} from "./workspace-scope.ts";

const VALIDATION_BATCH_SIZE = 2_048;

/** A deterministic mismatch between a tree and its archived ownership policy. */
export class TreeScopeMismatchError extends TreeManifestError {
  constructor(message: string) {
    super("object-integrity", message);
    this.name = "TreeScopeMismatchError";
  }
}

/**
 * Authenticate the mutation boundary between a durable manifest and its
 * archived Git policy. Structural parsing proves that paths are safe; this
 * check additionally proves that every path is owned by the target policy
 * and returns the evaluator provenance that made that decision.
 */
export async function validateTreeEntriesAgainstScope(
  manifest: CurrentTreeManifest,
  scratchOptions: SyntheticGitIgnoreScratchOptions = {},
): Promise<GitReplayAttestation> {
  const scope = manifest.scope;
  if (scope.kind === "all-managed") {
    return { gitVersion: null };
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

  try {
    await withRetainedCleanup(
      async () => {
        try {
          for (
            let offset = 0;
            offset < paths.length;
            offset += VALIDATION_BATCH_SIZE
          ) {
            const batch = paths.slice(offset, offset + VALIDATION_BATCH_SIZE);
            const managed = await oracle.managed(
              batch.map(({ path }) => ({ path, kind: "non-directory" })),
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
                throw new TreeScopeMismatchError(
                  `tree entry is excluded by its archived workspace scope: ${item.path}`,
                );
              }
              if (item.isLocalIgnoreSource && isManaged && !item.isEntry) {
                throw new TreeScopeMismatchError(
                  `tree omits a managed archived .gitignore source: ${item.path}`,
                );
              }
            }
          }
        } catch (error) {
          if (error instanceof TreeManifestError) throw error;
          throw new TreeManifestError(
            "object-integrity",
            "tree entries could not be validated against their archived workspace scope",
            error,
          );
        }
      },
      async () => {
        try {
          await oracle.close();
        } catch (error) {
          throw new TreeManifestError(
            "object-integrity",
            "tree workspace scope validator did not close cleanly",
            error,
          );
        }
      },
      "tree workspace scope validation and cleanup both failed",
    );
  } catch (error) {
    const primary = primaryFailure(error);
    if (primary instanceof TreeManifestError) {
      if (primary === error) throw primary;
      throw new TreeManifestError(primary.kind, primary.message, error);
    }
    throw error;
  }
  return { gitVersion: oracle.gitVersion };
}
