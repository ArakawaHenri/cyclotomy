import type { WorkspacePathLimits } from "../workspace-scope.ts";
import { DEFAULT_WORKSPACE_PATH_LIMITS } from "../workspace-scope.ts";
import { type TreeManifest } from "./manifest-codec.ts";
import { TREE_FORMAT_REGISTRY } from "./registry.ts";

/** Authenticate canonical bytes against the complete supported format history. */
export function parseTreeManifest(content: Uint8Array): TreeManifest {
  return TREE_FORMAT_REGISTRY.parse(content) as TreeManifest;
}

/** Upgrade by walking adjacent format edges; downgrades are rejected. */
export function upgradeTreeManifest(
  manifest: TreeManifest,
  targetFormat: string,
  pathLimits: WorkspacePathLimits = DEFAULT_WORKSPACE_PATH_LIMITS,
): TreeManifest {
  return TREE_FORMAT_REGISTRY.upgradeTo(manifest, targetFormat, pathLimits);
}

/** Reachability belongs to the authenticated format node, never to callers. */
export function treeManifestBlobOids(
  manifest: TreeManifest,
): readonly string[] {
  return TREE_FORMAT_REGISTRY.referencedBlobOids(manifest);
}
