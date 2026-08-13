import type { NodeKey, TreeOid } from "../domain/model.ts";

export interface ResolvedNodeState {
  readonly treeOid: TreeOid;
  /** The coordinate that owns the authoritative checkpoint. */
  readonly foundAt: NodeKey;
}
