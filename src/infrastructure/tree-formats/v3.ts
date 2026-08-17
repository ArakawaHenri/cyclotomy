import {
  ABSOLUTE_TREE_MANIFEST_LIMITS,
  canonicalizeTreeManifest,
  TreeManifestError,
} from "./manifest-codec.ts";
import type { TreeFormatNode } from "./chain.ts";
import { TREE_FORMAT_V2 } from "./v2.ts";
import {
  TREE_FORMAT_V3_CURRENT,
  TREE_MANIFEST_FORMAT_V3,
} from "./v3-current.ts";

export { TREE_MANIFEST_FORMAT_V3 };

/**
 * V3 changes only storage: public manifests retain the same complete snapshot
 * semantics while their canonical representation becomes a Prolly DAG.
 */
export const TREE_FORMAT_V3 = Object.freeze<
  TreeFormatNode<typeof TREE_MANIFEST_FORMAT_V3>
>({
  ...TREE_FORMAT_V3_CURRENT,
  previous: TREE_FORMAT_V2,
  upgradeFromPrevious(previous, pathLimits) {
    try {
      // V1/v2 never recorded the external Git evaluator. Migration must be
      // deterministic and must not attribute the migration host's Git facts
      // to a checkpoint captured elsewhere.
      const scope =
        previous.scope.kind === "all-managed"
          ? previous.scope
          : {
              ...previous.scope,
              evaluator: null,
            };
      const canonical = canonicalizeTreeManifest(previous.entries, scope, {
        ...ABSOLUTE_TREE_MANIFEST_LIMITS,
        ...pathLimits,
      });
      return { format: TREE_MANIFEST_FORMAT_V3, ...canonical };
    } catch (error) {
      if (
        !(error instanceof TreeManifestError) ||
        error.kind !== "invalid-tree-manifest"
      ) {
        throw error;
      }
      throw new TreeManifestError(
        "format-incompatible",
        `tree format v2 cannot be represented by the v3 contract: ${error.message}`,
        error,
      );
    }
  },
});
