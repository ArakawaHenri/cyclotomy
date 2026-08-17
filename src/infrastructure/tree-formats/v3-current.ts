import { canonicalizeTreeManifest } from "./manifest-codec.ts";
import type { TreeFormatNode } from "./chain.ts";
import { referencedTreeBlobOids } from "./references.ts";

export const TREE_MANIFEST_FORMAT_V3 = "cyclotomy-tree-v3";

/** Current v3 semantics without importing or traversing historical formats. */
export const TREE_FORMAT_V3_CURRENT = Object.freeze<
  TreeFormatNode<typeof TREE_MANIFEST_FORMAT_V3>
>({
  format: TREE_MANIFEST_FORMAT_V3,
  create(entries, scope, limits) {
    const canonical = canonicalizeTreeManifest(entries, scope, limits);
    return { format: TREE_MANIFEST_FORMAT_V3, ...canonical };
  },
  referencedBlobOids(manifest) {
    return referencedTreeBlobOids(manifest.entries);
  },
});
