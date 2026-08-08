/**
 * Cyclotomy domain vocabulary.
 *
 * A node is an exact Pi session-tree coordinate. Each node has at most one
 * recorded state: the tree object id of the workspace reality last observed
 * while standing on that node. States are complete immutable snapshots of the
 * managed scope; there is no baseline/overlay split.
 */

export interface NodeKey {
  readonly sessionId: string;
  readonly entryId: string;
}

/** Lowercase SHA-256 hex digest identifying a canonical tree object. */
export type TreeOid = string;

export interface NodeState {
  readonly treeOid: TreeOid;
}

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function success<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function failure<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** Map/Set token for a node. NUL cannot appear in Pi session or entry ids. */
export function nodeToken(node: NodeKey): string {
  return `${node.sessionId}\0${node.entryId}`;
}

const SHA_256_HEX = /^[0-9a-f]{64}$/u;

export function isTreeOid(value: unknown): value is TreeOid {
  return typeof value === "string" && SHA_256_HEX.test(value);
}
