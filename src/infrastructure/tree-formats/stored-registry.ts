import { TextDecoder } from "node:util";

import type { TreeOid } from "../../domain/model.ts";
import {
  ABSOLUTE_MAX_TREE_MANIFEST_BYTES,
  ABSOLUTE_TREE_MANIFEST_LIMITS,
  assertTreeManifestLimits,
  TreeManifestError,
  type TreeManifest,
  type TreeManifestLimits,
} from "./manifest-codec.ts";
import {
  authenticateStoredObject,
  inlineStoredTreeFormatAdapter,
  type AuthenticatedStoredTree,
  type StoredTreeFormatAdapter,
  type StoredTreeReadAccess,
  type StoredTreeWriteAccess,
} from "./stored-adapter.ts";
import { TREE_FORMAT_V1 } from "./v1.ts";
import { TREE_FORMAT_V2 } from "./v2.ts";
import { TREE_FORMAT_REGISTRY } from "./registry.ts";
import { STORED_TREE_FORMAT_V3 } from "./v3-storage.ts";

export { STORED_TREE_FORMAT_V3 };

const STORED_ROOT_FIXED_OVERHEAD_BYTES = 1024 * 1024;

export const STORED_TREE_FORMAT_V1 = inlineStoredTreeFormatAdapter(
  TREE_FORMAT_V1,
  TREE_FORMAT_REGISTRY,
);

export const STORED_TREE_FORMAT_V2 = inlineStoredTreeFormatAdapter(
  TREE_FORMAT_V2,
  TREE_FORMAT_REGISTRY,
);

const STORED_TREE_FORMAT_ADAPTERS = Object.freeze([
  STORED_TREE_FORMAT_V1,
  STORED_TREE_FORMAT_V2,
  STORED_TREE_FORMAT_V3,
]);

const STORED_TREE_FORMATS: ReadonlyMap<string, StoredTreeFormatAdapter> =
  new Map(
    STORED_TREE_FORMAT_ADAPTERS.map(
      (adapter) => [adapter.format, adapter] as const,
    ),
  );

/** Authenticate and dispatch one self-describing root without a global reload. */
export async function readStoredTree(
  treeOid: TreeOid,
  access: StoredTreeReadAccess,
  limits: TreeManifestLimits = ABSOLUTE_TREE_MANIFEST_LIMITS,
): Promise<AuthenticatedStoredTree> {
  assertTreeManifestLimits(limits);
  const rootBytes = authenticateStoredObject(
    treeOid,
    await access.readStructuralObject(
      "root",
      treeOid,
      Math.min(
        ABSOLUTE_MAX_TREE_MANIFEST_BYTES,
        limits.maxManifestBytes + STORED_ROOT_FIXED_OVERHEAD_BYTES,
      ),
    ),
    "tree root",
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(rootBytes),
    );
  } catch (error) {
    throw new TreeManifestError(
      "object-integrity",
      "tree root is not valid UTF-8 JSON",
      error,
    );
  }
  let format: string | undefined;
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate.format === "string") format = candidate.format;
  }
  const adapter =
    format === undefined ? undefined : STORED_TREE_FORMATS.get(format);
  if (adapter === undefined) {
    throw new TreeManifestError(
      "object-integrity",
      "tree root has an unsupported stored format",
    );
  }
  const prefetchedAccess: StoredTreeReadAccess = {
    readStructuralObject(kind, oid, maximumBytes) {
      if (kind === "root" && oid === treeOid) {
        if (rootBytes.byteLength > maximumBytes) {
          throw new TreeManifestError(
            "object-integrity",
            "tree root exceeds its adapter read limit",
          );
        }
        return Promise.resolve(rootBytes);
      }
      return access.readStructuralObject(kind, oid, maximumBytes);
    },
    readContent: access.readContent,
  };
  return adapter.readAuthenticated(treeOid, prefetchedAccess, limits);
}

/** Publish through the adapter named by the already-canonicalized manifest. */
export function publishStoredTree(
  manifest: TreeManifest,
  access: StoredTreeWriteAccess,
  limits: TreeManifestLimits = ABSOLUTE_TREE_MANIFEST_LIMITS,
): Promise<TreeOid> {
  const adapter = STORED_TREE_FORMATS.get(manifest.format);
  if (adapter === undefined) {
    throw new TreeManifestError(
      "format-incompatible",
      `tree format ${manifest.format} has no stored adapter`,
    );
  }
  return adapter.publish(manifest, access, limits);
}
