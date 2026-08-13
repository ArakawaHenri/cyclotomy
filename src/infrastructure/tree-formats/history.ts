import type { WorkspacePathLimits } from "../workspace-scope.ts";
import { DEFAULT_WORKSPACE_PATH_LIMITS } from "../workspace-scope.ts";
import {
  CURRENT_TREE_MANIFEST_FORMAT,
  type CurrentTreeManifest,
} from "./current.ts";
import {
  ABSOLUTE_TREE_MANIFEST_LIMITS,
  type TreeManifest,
  type TreeManifestLimits,
} from "./manifest-codec.ts";
import { TREE_FORMAT_REGISTRY } from "./registry.ts";

/** Authenticate canonical bytes against the complete supported format history. */
export function parseTreeManifest(content: Uint8Array): TreeManifest {
  return TREE_FORMAT_REGISTRY.parse(content) as TreeManifest;
}

/** Encode a manifest already authenticated by the supported format history. */
export function encodeTreeManifest(
  manifest: TreeManifest,
  limits: TreeManifestLimits = ABSOLUTE_TREE_MANIFEST_LIMITS,
): Buffer {
  return TREE_FORMAT_REGISTRY.encode(manifest, limits);
}

/** Upgrade by walking adjacent format edges; downgrades are rejected. */
export function upgradeTreeManifest(
  manifest: TreeManifest,
  targetFormat: string,
  pathLimits: WorkspacePathLimits = DEFAULT_WORKSPACE_PATH_LIMITS,
): TreeManifest {
  return TREE_FORMAT_REGISTRY.upgradeTo(manifest, targetFormat, pathLimits);
}

export function upgradeTreeManifestToCurrent(
  manifest: TreeManifest,
  pathLimits: WorkspacePathLimits = DEFAULT_WORKSPACE_PATH_LIMITS,
): CurrentTreeManifest {
  return upgradeTreeManifest(
    manifest,
    CURRENT_TREE_MANIFEST_FORMAT,
    pathLimits,
  ) as CurrentTreeManifest;
}

export function isCurrentTreeManifest(
  manifest: TreeManifest,
): manifest is CurrentTreeManifest {
  return TREE_FORMAT_REGISTRY.isCurrent(manifest);
}

/** Reachability belongs to the authenticated format node, never to callers. */
export function treeManifestBlobOids(
  manifest: TreeManifest,
): readonly string[] {
  return TREE_FORMAT_REGISTRY.referencedBlobOids(manifest);
}
