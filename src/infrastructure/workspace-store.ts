import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";

import { isTreeOid } from "../domain/model.ts";

export type NativeObjectKind = "blob" | "tree";

export interface NativeObjectLayout {
  readonly root: string;
  readonly objects: string;
  readonly blobs: string;
  readonly trees: string;
}

const OBJECT_DIRECTORY = "objects";
const OBJECT_NAMESPACES: Readonly<Record<NativeObjectKind, string>> = {
  blob: "blobs",
  tree: "trees",
};
const OBJECT_SHARD = /^[0-9a-f]{2}$/u;
const TEMPORARY_OBJECT = /^\.[0-9a-f]{64}\.[0-9]+\.[0-9a-f-]{36}\.tmp$/u;

/** One owner for the native CAS directory layout. */
export function nativeObjectLayout(root: string): NativeObjectLayout {
  const objects = join(root, OBJECT_DIRECTORY);
  return Object.freeze({
    root,
    objects,
    blobs: join(objects, OBJECT_NAMESPACES.blob),
    trees: join(objects, OBJECT_NAMESPACES.tree),
  });
}

export function nativeObjectNamespacePath(
  layout: NativeObjectLayout,
  kind: NativeObjectKind,
): string {
  return kind === "blob" ? layout.blobs : layout.trees;
}

export function nativeObjectShardPath(
  layout: NativeObjectLayout,
  kind: NativeObjectKind,
  shard: string,
): string {
  return join(nativeObjectNamespacePath(layout, kind), shard);
}

export function nativeObjectPath(
  layout: NativeObjectLayout,
  kind: NativeObjectKind,
  oid: string,
): string {
  return join(
    nativeObjectShardPath(layout, kind, oid.slice(0, 2)),
    oid.slice(2),
  );
}

export function isNativeObjectOid(value: unknown): value is string {
  return isTreeOid(value);
}

export function isNativeObjectShard(value: string): boolean {
  return OBJECT_SHARD.test(value);
}

export function nativeObjectEntry(
  shard: string,
  name: string,
):
  | { readonly kind: "object"; readonly oid: string }
  | { readonly kind: "temporary" }
  | undefined {
  if (TEMPORARY_OBJECT.test(name)) return { kind: "temporary" };
  const oid = `${shard}${name}`;
  return isNativeObjectOid(oid) ? { kind: "object", oid } : undefined;
}

export function nativeTemporaryObjectName(
  oid: string,
  processId: number,
  nonce: string,
): string {
  return `.${oid}.${processId}.${nonce}.tmp`;
}

/** Deterministic per-workspace store path shared by active bind and fork import. */
export function workspaceStorePath(
  storageRootPath: string,
  canonicalWorkspace: string,
): string {
  if (
    canonicalWorkspace.length === 0 ||
    canonicalWorkspace.includes("\0") ||
    !isAbsolute(canonicalWorkspace) ||
    resolve(canonicalWorkspace) !== canonicalWorkspace
  ) {
    throw new Error("canonical workspace path must be absolute");
  }
  const hash = createHash("sha256").update(canonicalWorkspace).digest("hex");
  return resolve(storageRootPath, hash);
}
