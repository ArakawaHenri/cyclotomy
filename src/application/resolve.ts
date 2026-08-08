import {
  nodeToken,
  type NodeKey,
  type NodeState,
  type TreeOid,
} from "../domain/model.ts";

export interface ResolvedNodeState {
  readonly treeOid: TreeOid;
  /** The node the state was actually recorded on. */
  readonly foundAt: NodeKey;
}

const DEFAULT_MAX_HOPS = 10000;

export type ResolutionTraversalFailure =
  | "cycle"
  | "hop-limit"
  | "unknown-node";

/** A malformed or unreasonably deep session ancestry is not a missing state. */
export class ResolutionTraversalError extends Error {
  readonly reason: ResolutionTraversalFailure;

  constructor(reason: ResolutionTraversalFailure, detail?: string) {
    const message =
      reason === "cycle"
        ? "session ancestry contains a cycle"
        : reason === "hop-limit"
        ? `session ancestry exceeds ${detail ?? DEFAULT_MAX_HOPS} nodes`
        : `session ancestry references an unknown node${
            detail === undefined ? "" : ` ${JSON.stringify(detail)}`
          }`;
    super(message);
    this.name = "ResolutionTraversalError";
    this.reason = reason;
  }
}

export interface AsyncResolveOptions {
  readonly maxHops?: number;
}

/**
 * Traverse one authenticated ancestry with a bounded, shared failure policy.
 * `parentOf` must return undefined only for a known root; it should throw for
 * an unknown node. The parent is read before yielding so even a metadata slot
 * attached to an unknown session entry cannot make that entry authoritative.
 */
export function* walkNodeAncestry(
  node: NodeKey,
  parentOf: (node: NodeKey) => NodeKey | undefined,
  options: AsyncResolveOptions = {},
): Generator<NodeKey> {
  const maxHops = options.maxHops ?? DEFAULT_MAX_HOPS;
  if (!Number.isSafeInteger(maxHops) || maxHops <= 0) {
    throw new RangeError("maxHops must be a positive safe integer");
  }

  const visited = new Set<string>();
  let current = node;
  let hops = 0;
  while (true) {
    const token = nodeToken(current);
    if (visited.has(token)) {
      throw new ResolutionTraversalError("cycle");
    }
    visited.add(token);

    const parent = parentOf(current);
    if (hops === maxHops - 1 && parent !== undefined) {
      throw new ResolutionTraversalError("hop-limit", String(maxHops));
    }
    yield current;
    if (parent === undefined) return;
    current = parent;
    hops += 1;
  }
}

/**
 * Resolve the nearest recorded state. Missing nodes inherit from their first
 * recorded ancestor. Once a state is found it is authoritative: validation
 * failure is surfaced and never disguised as a reason to select older data.
 */
export async function resolveReadableNodeState(
  node: NodeKey,
  parentOf: (node: NodeKey) => NodeKey | undefined,
  getState: (node: NodeKey) => NodeState | undefined,
  validate: (state: NodeState, node: NodeKey) => Promise<void>,
  options: AsyncResolveOptions = {},
): Promise<ResolvedNodeState | undefined> {
  for (const current of walkNodeAncestry(node, parentOf, options)) {
    const state = getState(current);
    if (state !== undefined) {
      await validate(state, current);
      return {
        treeOid: state.treeOid,
        foundAt: current,
      };
    }
  }
  return undefined;
}
