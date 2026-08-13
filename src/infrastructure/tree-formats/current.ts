import {
  DEFAULT_TREE_MANIFEST_LIMITS,
  TreeManifestError,
  type TreeManifest,
  type TreeManifestLimits,
} from "./manifest-codec.ts";
import { CURRENT_TREE_FORMAT, TREE_FORMAT_REGISTRY } from "./registry.ts";

/** Current format node for metadata/version-chain composition. */
export { CURRENT_TREE_FORMAT };

export const CURRENT_TREE_MANIFEST_FORMAT = CURRENT_TREE_FORMAT.format;

export type CurrentTreeManifest = TreeManifest & {
  readonly format: typeof CURRENT_TREE_MANIFEST_FORMAT;
};

/** Validate new snapshot data against the one current publication contract. */
export function createCurrentTreeManifest(
  entries: unknown,
  scope: unknown,
  limits: TreeManifestLimits = DEFAULT_TREE_MANIFEST_LIMITS,
): CurrentTreeManifest {
  return TREE_FORMAT_REGISTRY.createCurrent(
    entries,
    scope,
    limits,
  ) as CurrentTreeManifest;
}

/** Encode a current manifest that was already validated at creation. */
export function encodeCurrentTreeManifest(
  manifest: CurrentTreeManifest,
  limits: TreeManifestLimits = DEFAULT_TREE_MANIFEST_LIMITS,
): Buffer {
  if (!TREE_FORMAT_REGISTRY.isCurrent(manifest)) {
    throw new TreeManifestError(
      "invalid-tree-manifest",
      "current tree encoder received a historical manifest",
    );
  }
  return TREE_FORMAT_REGISTRY.encode(manifest, limits);
}
