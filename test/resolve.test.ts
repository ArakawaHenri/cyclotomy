import { describe, expect, it, vi } from "vitest";

import {
  ResolutionTraversalError,
  resolveReadableNodeState,
} from "../src/application/resolve.ts";
import {
  nodeToken,
  type NodeKey,
  type NodeState,
} from "../src/domain/model.ts";

function node(sessionId: string, entryId: string): NodeKey {
  return { sessionId, entryId };
}

const state: NodeState = { treeOid: "a".repeat(64) };

function stateLookup(
  entries: readonly (readonly [NodeKey, NodeState])[],
): (node: NodeKey) => NodeState | undefined {
  const states = new Map(
    entries.map(([key, value]) => [nodeToken(key), value]),
  );
  return (key) => states.get(nodeToken(key));
}

const noState = (): NodeState | undefined => undefined;

describe("resolveReadableNodeState", () => {
  it("resolves a readable state recorded on the start node itself", async () => {
    const start = node("s", "a");
    const parentOf = vi.fn(() => undefined);
    const validate = vi.fn(async () => {});
    const resolved = await resolveReadableNodeState(
      start,
      parentOf,
      stateLookup([[start, state]]),
      validate,
    );
    expect(resolved).toEqual({
      treeOid: state.treeOid,
      foundAt: start,
    });
    // The entry must be authenticated even when it owns an exact slot.
    expect(parentOf).toHaveBeenCalledWith(start);
    expect(validate).toHaveBeenCalledWith(state, start);
  });

  it("rejects cycles instead of disguising them as missing state", async () => {
    const a = node("s", "a");
    const b = node("s", "b");
    await expect(resolveReadableNodeState(
      a,
      (key) => (nodeToken(key) === nodeToken(a) ? b : a),
      noState,
      async () => {},
    )).rejects.toMatchObject({
      name: "ResolutionTraversalError",
      reason: "cycle",
    });
  });

  it("rejects a continuing ancestry at the configured hop limit", async () => {
    const parentOf = (key: NodeKey): NodeKey =>
      node(key.sessionId, `${key.entryId}x`);
    // Even a slot on the boundary node cannot hide a continuing ancestry.
    const beyond = node("s", "axx");
    const getState = vi.fn((key: NodeKey) =>
      nodeToken(key) === nodeToken(beyond) ? state : undefined,
    );
    await expect(resolveReadableNodeState(
      node("s", "a"),
      parentOf,
      getState,
      async () => {},
      { maxHops: 3 },
    )).rejects.toMatchObject({
      name: "ResolutionTraversalError",
      reason: "hop-limit",
    });
    expect(getState).toHaveBeenCalledTimes(2);
  });

  it("allows the final permitted node to be a genuine missing root", async () => {
    const a = node("s", "a");
    const b = node("s", "b");
    const c = node("s", "c");
    const parentOf = (key: NodeKey): NodeKey | undefined => {
      switch (key.entryId) {
        case "a":
          return b;
        case "b":
          return c;
        case "c":
          return undefined;
        default:
          throw new ResolutionTraversalError("unknown-node", key.entryId);
      }
    };

    await expect(resolveReadableNodeState(
      a,
      parentOf,
      noState,
      async () => {},
      { maxHops: 3 },
    )).resolves.toBeUndefined();
  });

  it("surfaces unknown ancestry entries instead of accepting their metadata", async () => {
    const leaf = node("s", "leaf");
    const missingParent = node("s", "missing-parent");
    await expect(resolveReadableNodeState(
      leaf,
      (key) => {
        if (key.entryId === "leaf") return missingParent;
        throw new ResolutionTraversalError("unknown-node", key.entryId);
      },
      stateLookup([[missingParent, state]]),
      async () => {},
    )).rejects.toMatchObject({
      name: "ResolutionTraversalError",
      reason: "unknown-node",
    });
  });
  it("never hides an unreadable authoritative candidate with an ancestor", async () => {
    const leaf = node("s", "leaf");
    const parent = node("s", "parent");
    const leafState: NodeState = {
      treeOid: "b".repeat(64),
    };
    await expect(resolveReadableNodeState(
      leaf,
      (key) =>
        nodeToken(key) === nodeToken(leaf) ? parent : undefined,
      stateLookup([
        [leaf, leafState],
        [parent, state],
      ]),
      async (candidate) => {
        if (candidate.treeOid === leafState.treeOid) {
          throw new Error("missing tree");
        }
      },
    )).rejects.toThrow("missing tree");
  });

  it("surfaces corrupt metadata lookup instead of walking past it", async () => {
    const leaf = node("s", "leaf");
    const parent = node("s", "parent");
    await expect(resolveReadableNodeState(
      leaf,
      (key) =>
        nodeToken(key) === nodeToken(leaf) ? parent : undefined,
      (key) => {
        if (nodeToken(key) === nodeToken(leaf)) {
          throw new Error("bad oid");
        }
        return state;
      },
      async () => {},
    )).rejects.toThrow("bad oid");
  });
});
