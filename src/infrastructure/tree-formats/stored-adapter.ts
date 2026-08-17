import { createHash } from "node:crypto";

import { isTreeOid, type TreeOid } from "../../domain/model.ts";
import type { TreeFormatEngine, TreeFormatNode } from "./chain.ts";
import {
  ABSOLUTE_MAX_TREE_MANIFEST_BYTES,
  ABSOLUTE_TREE_MANIFEST_LIMITS,
  TreeManifestError,
  type TreeManifest,
  type TreeManifestLimits,
} from "./manifest-codec.ts";

/**
 * Minimal CAS capabilities used by every stored tree format.
 *
 * Structural objects are domain-tagged canonical bytes whose SHA-256 is their
 * TreeOid. Content objects are exact workspace bytes whose SHA-256 is their
 * ContentId. Implementations must publish durably and authenticate an existing
 * object before treating either publication callback as successful.
 */
export interface StoredTreeReadAccess {
  readonly readStructuralObject: (
    kind: StoredTreeStructuralKind,
    oid: TreeOid,
    maximumBytes: number,
  ) => Promise<Uint8Array>;
  readonly readContent: (
    contentId: string,
    maximumBytes: number,
  ) => Promise<Uint8Array>;
}

export interface StoredTreeWriteAccess {
  readonly publishStructuralObject: (
    kind: StoredTreeStructuralKind,
    oid: TreeOid,
    canonicalBytes: Uint8Array,
  ) => Promise<void>;
  readonly ensureContent: (
    contentId: string,
    rawBytes: Uint8Array,
  ) => Promise<void>;
}

/** Logical structure class; physical stores may map these to distinct records. */
export type StoredTreeStructuralKind = "root" | "node" | "scope";

export interface AuthenticatedStoredTree {
  readonly manifest: TreeManifest;
  /** Authenticated structural closure with the physical record class intact. */
  readonly structuralObjects: readonly {
    readonly kind: StoredTreeStructuralKind;
    readonly oid: TreeOid;
  }[];
  /** Root first; the remaining order has no semantic meaning. */
  readonly structuralObjectOids: readonly TreeOid[];
  /** Complete raw-content closure, including regular files. */
  readonly contentIds: readonly string[];
}

/** Async storage contract, independent of the semantic adjacent-format chain. */
export interface StoredTreeFormatAdapter {
  readonly format: string;
  readonly readAuthenticated: (
    treeOid: TreeOid,
    access: StoredTreeReadAccess,
    limits?: TreeManifestLimits,
  ) => Promise<AuthenticatedStoredTree>;
  readonly publish: (
    manifest: TreeManifest,
    access: StoredTreeWriteAccess,
    limits?: TreeManifestLimits,
  ) => Promise<TreeOid>;
}

export function storedObjectOid(content: Uint8Array): TreeOid {
  return createHash("sha256").update(content).digest("hex");
}

export function authenticateStoredObject(
  oid: TreeOid,
  content: Uint8Array,
  label: string,
): Buffer {
  if (!isTreeOid(oid) || storedObjectOid(content) !== oid) {
    throw new TreeManifestError(
      "object-integrity",
      `${label} does not match its content-addressed identity`,
    );
  }
  return Buffer.from(content);
}

/** Wrap a v1/v2 self-contained canonical JSON object in the async contract. */
export function inlineStoredTreeFormatAdapter(
  node: TreeFormatNode,
  engine: TreeFormatEngine,
): StoredTreeFormatAdapter {
  if (node.decode === undefined || node.encode === undefined) {
    throw new TypeError("inline stored tree adapter requires inline codecs");
  }
  const encode = node.encode;
  return Object.freeze({
    format: node.format,
    async readAuthenticated(
      treeOid: TreeOid,
      access: StoredTreeReadAccess,
      limits = ABSOLUTE_TREE_MANIFEST_LIMITS,
    ) {
      const content = authenticateStoredObject(
        treeOid,
        await access.readStructuralObject(
          "root",
          treeOid,
          ABSOLUTE_MAX_TREE_MANIFEST_BYTES,
        ),
        "tree object",
      );
      const manifest = engine.parse(content);
      if (manifest.format !== node.format) {
        throw new TreeManifestError(
          "format-incompatible",
          `tree object is ${manifest.format}, not ${node.format}`,
        );
      }
      // Re-encoding under the caller's limits preserves maxManifest semantics
      // for historical objects without conflating it with a storage read cap.
      encode(manifest, limits);
      return Object.freeze({
        manifest,
        structuralObjects: Object.freeze([
          Object.freeze({ kind: "root" as const, oid: treeOid }),
        ]),
        structuralObjectOids: Object.freeze([treeOid]),
        contentIds: Object.freeze([...node.referencedBlobOids(manifest)]),
      });
    },
    async publish(
      manifest: TreeManifest,
      access: StoredTreeWriteAccess,
      limits = ABSOLUTE_TREE_MANIFEST_LIMITS,
    ) {
      if (manifest.format !== node.format) {
        throw new TreeManifestError(
          "format-incompatible",
          `cannot publish ${manifest.format} through the ${node.format} adapter`,
        );
      }
      const content = encode(manifest, limits);
      const treeOid = storedObjectOid(content);
      await access.publishStructuralObject("root", treeOid, content);
      return treeOid;
    },
  });
}
