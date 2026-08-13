import {
  ABSOLUTE_TREE_MANIFEST_LIMITS,
  canonicalizeTreeManifest,
  encodeTreeManifestDocument,
  exactKeys,
  invalidManifest,
  TreeManifestError,
} from "./manifest-codec.ts";
import type { TreeFormatNode } from "./chain.ts";
import { referencedTreeBlobOids } from "./references.ts";
import { TREE_FORMAT_V1 } from "./v1.ts";

export const TREE_MANIFEST_FORMAT_V2 = "cyclotomy-tree-v2";

export const TREE_FORMAT_V2 = Object.freeze<
  TreeFormatNode<typeof TREE_MANIFEST_FORMAT_V2>
>({
  format: TREE_MANIFEST_FORMAT_V2,
  previous: TREE_FORMAT_V1,
  create(entries, scope, limits) {
    const canonical = canonicalizeTreeManifest(entries, scope, limits);
    return { format: TREE_MANIFEST_FORMAT_V2, ...canonical };
  },
  decode(candidate, limits) {
    if (!exactKeys(candidate, ["format", "entries", "scope"])) {
      invalidManifest("tree format v2 has noncanonical fields");
    }
    return this.create(candidate.entries, candidate.scope, limits);
  },
  encode(manifest, limits) {
    return encodeTreeManifestDocument(
      TREE_MANIFEST_FORMAT_V2,
      manifest.entries,
      manifest.scope,
      limits,
    );
  },
  upgradeFromPrevious(previous, pathLimits) {
    try {
      const canonical = canonicalizeTreeManifest(
        previous.entries,
        previous.scope,
        { ...ABSOLUTE_TREE_MANIFEST_LIMITS, ...pathLimits },
      );
      return { format: TREE_MANIFEST_FORMAT_V2, ...canonical };
    } catch (error) {
      if (
        !(error instanceof TreeManifestError) ||
        error.kind !== "invalid-tree-manifest"
      ) {
        throw error;
      }
      throw new TreeManifestError(
        "format-incompatible",
        `tree format v1 cannot be represented by the v2 contract: ${error.message}`,
        error,
      );
    }
  },
  referencedBlobOids(manifest) {
    return referencedTreeBlobOids(manifest.entries);
  },
});
