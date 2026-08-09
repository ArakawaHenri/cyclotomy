import type { MetadataStore } from "../infrastructure/metadata.ts";
import type { ObjectStore } from "../infrastructure/object-store.ts";

export interface LegacyTreeMigrationBlocker {
  readonly treeOid: string;
  readonly message: string;
}

export interface TreeMigrationReport {
  readonly inspectedTrees: number;
  readonly currentTrees: number;
  readonly migratedTrees: number;
  readonly incompatibleTrees: readonly LegacyTreeMigrationBlocker[];
  readonly replacedNodeStates: number;
}

export class LegacyTreeMigrationBlockedError extends Error {
  readonly incompatibleTrees: readonly LegacyTreeMigrationBlocker[];

  constructor(incompatibleTrees: readonly LegacyTreeMigrationBlocker[]) {
    const first = incompatibleTrees[0];
    super(
      `${incompatibleTrees.length} published-v1 tree${
        incompatibleTrees.length === 1 ? " is" : "s are"
      } not losslessly representable as v2; metadata was left at v1${
        first === undefined
          ? ""
          : `; first incompatible tree ${first.treeOid}: ${first.message}`
      }`,
    );
    this.name = "LegacyTreeMigrationBlockedError";
    this.incompatibleTrees = incompatibleTrees;
  }
}

/**
 * Upgrade every referenced, losslessly representable v1 tree to v2.
 *
 * The caller must hold the workspace lock. Replacement objects are published
 * and authenticated first, then every compatible metadata reference changes
 * in one SQLite transaction. A crash before that transaction leaves only safe
 * orphan v2 objects; a crash after it leaves the old v1 objects for later GC.
 */
export async function migrateReferencedTrees(
  store: ObjectStore,
  metadata: MetadataStore,
): Promise<TreeMigrationReport> {
  // The SQL version is the durable tree-format migration marker. Published
  // v1 advances it only in the same transaction that rewrites every root, so
  // a current schema never needs to rehash all historical blob closures on
  // each startup.
  if (metadata.isSchemaCurrent()) {
    return {
      inspectedTrees: 0,
      currentTrees: 0,
      migratedTrees: 0,
      incompatibleTrees: [],
      replacedNodeStates: 0,
    };
  }

  const referenced = metadata.listReferencedTreeOids();
  const migrations: Array<{
    readonly oldTreeOid: string;
    readonly newTreeOid: string;
  }> = [];
  const incompatibleTrees: LegacyTreeMigrationBlocker[] = [];
  let currentTrees = 0;

  for (const treeOid of referenced) {
    const result = await store.migrateLegacyTree(treeOid);
    switch (result.kind) {
      case "current":
        currentTrees += 1;
        break;
      case "migrated":
        migrations.push({
          oldTreeOid: result.oldTreeOid,
          newTreeOid: result.treeOid,
        });
        break;
      case "legacy-incompatible":
        incompatibleTrees.push({
          treeOid: result.treeOid,
          message: result.message,
        });
        break;
    }
  }

  // A published-v1 database is still downgrade-readable. Do not perform its
  // one-way SQL cutover when any rooted tree cannot make the same transition.
  if (incompatibleTrees.length > 0) {
    throw new LegacyTreeMigrationBlockedError(incompatibleTrees);
  }

  const replacedNodeStates = metadata.migrateSchemaAndReplaceTreeOidReferences(
    migrations,
    referenced,
  );
  return {
    inspectedTrees: referenced.length,
    currentTrees,
    migratedTrees: migrations.length,
    incompatibleTrees,
    replacedNodeStates,
  };
}
