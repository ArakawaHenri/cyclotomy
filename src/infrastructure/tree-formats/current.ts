import {
  DEFAULT_TREE_MANIFEST_LIMITS,
  encodeTreeManifestDocument,
  freezeTreeManifest,
  TreeManifestError,
  type TreeManifest,
  type TreeManifestLimits,
} from "./manifest-codec.ts";
import { TREE_FORMAT_V3_CURRENT } from "./v3-current.ts";

/** Current semantic node; it has no dependency on historical formats. */
export const CURRENT_TREE_FORMAT = TREE_FORMAT_V3_CURRENT;

export const CURRENT_TREE_MANIFEST_FORMAT = CURRENT_TREE_FORMAT.format;

export type CurrentTreeManifest = TreeManifest & {
  readonly format: typeof CURRENT_TREE_MANIFEST_FORMAT;
};

function isCurrentTreeManifest(
  manifest: TreeManifest,
): manifest is CurrentTreeManifest {
  return manifest.format === CURRENT_TREE_MANIFEST_FORMAT;
}

/** Require the tree generation promised by current metadata/runtime APIs. */
export function requireCurrentTreeManifest(
  manifest: TreeManifest,
): CurrentTreeManifest {
  if (!isCurrentTreeManifest(manifest)) {
    throw new TreeManifestError(
      "object-integrity",
      `current metadata references historical tree format ${JSON.stringify(manifest.format)}`,
    );
  }
  return manifest;
}

/** Validate new snapshot data against the one current publication contract. */
export function createCurrentTreeManifest(
  entries: unknown,
  scope: unknown,
  limits: TreeManifestLimits = DEFAULT_TREE_MANIFEST_LIMITS,
): CurrentTreeManifest {
  const manifest = CURRENT_TREE_FORMAT.create(entries, scope, limits);
  if (manifest.format !== CURRENT_TREE_MANIFEST_FORMAT) {
    throw new Error("current tree creator returned a different format");
  }
  // Creation is the sole admission boundary for new current manifests.  The
  // v3 graph has a different physical representation, but the configured
  // manifest ceiling is defined over this canonical semantic document.
  encodeTreeManifestDocument(
    CURRENT_TREE_MANIFEST_FORMAT,
    manifest.entries,
    manifest.scope,
    limits,
  );
  return freezeTreeManifest(manifest) as CurrentTreeManifest;
}

/** Encode a current manifest that was already validated at creation. */
export function encodeCurrentTreeManifest(
  manifest: CurrentTreeManifest,
  limits: TreeManifestLimits = DEFAULT_TREE_MANIFEST_LIMITS,
): Buffer {
  if (!isCurrentTreeManifest(manifest)) {
    throw new TreeManifestError(
      "invalid-tree-manifest",
      "current tree encoder received a historical manifest",
    );
  }
  // Graph formats still expose one canonical, complete semantic projection
  // for policy validation and the configured maxManifestBytes contract. These
  // bytes are never published as the stored tree root.
  return encodeTreeManifestDocument(
    CURRENT_TREE_MANIFEST_FORMAT,
    manifest.entries,
    manifest.scope,
    limits,
  );
}
