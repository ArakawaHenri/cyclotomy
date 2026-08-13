import type { TreeOid } from "../domain/model.ts";
import type {
  NativeObjectStore,
  TreeFormatUpgradeResult,
} from "../infrastructure/object-store.ts";

export type TreeFormatUpgradeBlocker = Extract<
  TreeFormatUpgradeResult,
  { readonly kind: "incompatible" }
>;

export class TreeFormatUpgradeBlockedError extends Error {
  readonly targetFormat: string;
  readonly incompatibleTrees: readonly TreeFormatUpgradeBlocker[];

  constructor(
    targetFormat: string,
    incompatibleTrees: readonly TreeFormatUpgradeBlocker[],
  ) {
    const first = incompatibleTrees[0];
    super(
      `${incompatibleTrees.length} rooted tree${
        incompatibleTrees.length === 1 ? " is" : "s are"
      } not losslessly upgradeable to tree format ${targetFormat}; metadata was left unchanged${
        first === undefined
          ? ""
          : `; first incompatible tree ${first.treeOid}: ${first.cause.message}`
      }`,
      first === undefined ? undefined : { cause: first.cause },
    );
    this.name = "TreeFormatUpgradeBlockedError";
    this.targetFormat = targetFormat;
    this.incompatibleTrees = incompatibleTrees;
  }
}

/**
 * Prepare the requested-format equivalent of each rooted tree.
 *
 * Metadata's adjacent upgrade edge owns the authenticated root snapshot and
 * the atomic SQL cutover. This helper owns only immutable object publication;
 * a failure may leave harmless unreferenced CAS objects for later GC.
 */
export async function prepareTreeOidUpgrades(
  store: NativeObjectStore,
  roots: readonly TreeOid[],
  targetFormat: string,
): Promise<ReadonlyMap<TreeOid, TreeOid>> {
  const upgraded = new Map<TreeOid, TreeOid>();
  const incompatibleTrees: TreeFormatUpgradeBlocker[] = [];

  for (const treeOid of roots) {
    const result = await store.upgradeTree(treeOid, targetFormat);
    switch (result.kind) {
      case "already-target":
        upgraded.set(treeOid, result.treeOid);
        break;
      case "upgraded":
        upgraded.set(treeOid, result.treeOid);
        break;
      case "incompatible":
        incompatibleTrees.push(result);
        break;
    }
  }

  if (incompatibleTrees.length > 0) {
    throw new TreeFormatUpgradeBlockedError(targetFormat, incompatibleTrees);
  }
  return upgraded;
}
