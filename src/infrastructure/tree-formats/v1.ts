import {
  canonicalizeV1TreeManifest,
  encodeV1TreeManifest,
} from "./v1-manifest-codec.ts";
import type { TreeFormatNode } from "./chain.ts";
import { exactKeys, invalidManifest } from "./manifest-codec.ts";
import { referencedTreeBlobOids } from "./references.ts";

/** Exact immutable format shipped by cyclotomy@0.0.1. */
export const TREE_MANIFEST_FORMAT_V1 = "cyclotomy-tree-v1";

export const TREE_FORMAT_V1 = Object.freeze<
  TreeFormatNode<typeof TREE_MANIFEST_FORMAT_V1>
>({
  format: TREE_MANIFEST_FORMAT_V1,
  create(entries, scope, limits) {
    const canonical = canonicalizeV1TreeManifest(entries, scope, limits);
    return { format: TREE_MANIFEST_FORMAT_V1, ...canonical };
  },
  decode(candidate, limits) {
    if (!exactKeys(candidate, ["format", "entries", "scope"])) {
      invalidManifest("tree format v1 has noncanonical fields");
    }
    return this.create(candidate.entries, candidate.scope, limits);
  },
  encode(manifest, limits) {
    return encodeV1TreeManifest(
      TREE_MANIFEST_FORMAT_V1,
      manifest.entries,
      manifest.scope,
      limits,
    );
  },
  referencedBlobOids(manifest) {
    return referencedTreeBlobOids(manifest.entries);
  },
});
