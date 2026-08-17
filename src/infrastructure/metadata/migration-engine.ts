import { type DatabaseSync } from "node:sqlite";

import { isTreeOid, type TreeOid } from "../../domain/model.ts";
import { MetadataError } from "../metadata-error.ts";
import {
  assertWorkspaceWriteAuthority,
  type WorkspaceWriteAuthority,
} from "../workspace-lock.ts";
import { CURRENT_METADATA_VERSION } from "./current.ts";
import {
  dropWriterFences,
  metadataSchemaVersion,
  validateUninitializedMetadataDatabase,
} from "./schema.ts";
import {
  type AdjacentMetadataUpgrade,
  findMetadataVersion,
  metadataVersionChain,
  type MetadataMigrationDependencies,
  type PreparedMetadataTreeUpgrade,
  type MetadataVersionNode,
  requireMetadataVersion,
  validateMetadataVersion,
} from "./version.ts";

type OrdinaryMetadataUpgrade = Extract<
  AdjacentMetadataUpgrade,
  { readonly kind: "ordinary" }
>;

type TreeFormatMetadataUpgrade = Extract<
  AdjacentMetadataUpgrade,
  { readonly kind: "tree-format" }
>;

type CapturedAdjacentUpgrade =
  | {
      readonly kind: "ordinary";
      readonly source: MetadataVersionNode;
      readonly successor: MetadataVersionNode;
      readonly edge: OrdinaryMetadataUpgrade;
    }
  | {
      readonly kind: "tree-format";
      readonly source: MetadataVersionNode;
      readonly successor: MetadataVersionNode;
      readonly edge: TreeFormatMetadataUpgrade;
      readonly sourceRoots: readonly TreeOid[];
    };

type PreparedAdjacentUpgrade =
  | {
      readonly kind: "ordinary";
      readonly source: MetadataVersionNode;
      readonly successor: MetadataVersionNode;
      readonly edge: OrdinaryMetadataUpgrade;
    }
  | {
      readonly kind: "tree-format";
      readonly source: MetadataVersionNode;
      readonly successor: MetadataVersionNode;
      readonly edge: TreeFormatMetadataUpgrade;
      readonly prepared: PreparedMetadataTreeUpgrade;
    };

// Tree publication happens outside SQLite's writer transaction. Bound repeated
// source-root drift so a misused opener or a continuously churning peer cannot
// publish an unbounded number of immutable, unreferenced upgrade objects in one
// call. Successful adjacent commits and peer version progress reset the budget.
const MAX_CONSECUTIVE_TREE_ROOT_DRIFT_RETRIES = 8;

type ApplyPreparedUpgradeResult =
  "applied" | "version-changed" | "tree-roots-changed";

function rollbackPreservingPrimary(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // Preserve the operation failure.
  }
}

function successorOf(
  current: MetadataVersionNode,
  source: MetadataVersionNode,
): MetadataVersionNode {
  const chain = metadataVersionChain(current);
  const sourceIndex = chain.indexOf(source);
  const successor = chain[sourceIndex + 1];
  if (
    sourceIndex < 0 ||
    successor === undefined ||
    successor.previous !== source ||
    successor.upgradeFromPrevious === undefined
  ) {
    throw new MetadataError(
      `metadata schema has no adjacent migration from version ${source.version}`,
    );
  }
  return successor;
}

function canonicalTreeRoots(roots: readonly TreeOid[]): readonly TreeOid[] {
  const unique = new Set<TreeOid>();
  for (const treeOid of roots) {
    if (!isTreeOid(treeOid)) {
      throw new MetadataError("invalid tree oid in metadata root set");
    }
    unique.add(treeOid);
  }
  return Object.freeze([...unique].sort());
}

function treeRootsAreEqual(
  left: readonly TreeOid[],
  right: readonly TreeOid[],
): boolean {
  return (
    left.length === right.length &&
    left.every((treeOid, index) => treeOid === right[index])
  );
}

function prepareTotalTreeUpgrade(
  sourceRoots: readonly TreeOid[],
  proposed: ReadonlyMap<TreeOid, TreeOid>,
): PreparedMetadataTreeUpgrade {
  if (proposed.size !== sourceRoots.length) {
    throw new MetadataError(
      "tree-format migration did not return one result per metadata root",
    );
  }

  const replacements = sourceRoots.map((source) => {
    const target = proposed.get(source);
    if (!isTreeOid(target)) {
      throw new MetadataError(
        `tree-format migration omitted or returned an invalid target for ${source}`,
      );
    }
    return Object.freeze({ source, target });
  });
  const expectedSources = new Set(sourceRoots);
  for (const source of proposed.keys()) {
    if (!expectedSources.has(source)) {
      throw new MetadataError(
        "tree-format migration returned an unexpected metadata root",
      );
    }
  }

  return Object.freeze({
    sourceRoots,
    replacements: Object.freeze(replacements),
    successorRoots: canonicalTreeRoots(
      replacements.map(({ target }) => target),
    ),
  });
}

export function initializeMetadataVersionWithinTransaction(
  db: DatabaseSync,
  current: MetadataVersionNode = CURRENT_METADATA_VERSION,
): void {
  if (!db.isTransaction) {
    throw new MetadataError(
      "metadata initialization requires an active writer transaction",
    );
  }
  validateUninitializedMetadataDatabase(db);
  current.initializeWithinTransaction(db);
  validateMetadataVersion(db, current);
}

async function captureAndPrepareNextUpgrade(
  db: DatabaseSync,
  current: MetadataVersionNode,
  dependencies: MetadataMigrationDependencies,
): Promise<
  | { readonly kind: "current" }
  | {
      readonly kind: "prepared";
      readonly upgrade: PreparedAdjacentUpgrade;
    }
> {
  db.exec("BEGIN");
  let capturedUpgrade: CapturedAdjacentUpgrade;
  try {
    const source = requireMetadataVersion(current, db);
    validateMetadataVersion(db, source);
    if (source === current) {
      db.exec("COMMIT");
      return { kind: "current" };
    }
    const successor = successorOf(current, source);
    const edge = successor.upgradeFromPrevious;
    if (edge === undefined) {
      throw new MetadataError(
        `metadata schema has no adjacent migration from version ${source.version}`,
      );
    }
    capturedUpgrade =
      edge.kind === "tree-format"
        ? {
            kind: "tree-format",
            source,
            successor,
            edge,
            sourceRoots: canonicalTreeRoots(source.referencedTreeOids(db)),
          }
        : {
            kind: "ordinary",
            source,
            successor,
            edge,
          };
    db.exec("COMMIT");
  } catch (error) {
    rollbackPreservingPrimary(db);
    throw error;
  }

  if (capturedUpgrade.kind === "tree-format") {
    const proposed = await dependencies.prepareTreeOidUpgrades(
      capturedUpgrade.sourceRoots,
      capturedUpgrade.successor.treeFormat,
    );
    return {
      kind: "prepared",
      upgrade: {
        kind: "tree-format",
        source: capturedUpgrade.source,
        successor: capturedUpgrade.successor,
        edge: capturedUpgrade.edge,
        prepared: prepareTotalTreeUpgrade(
          capturedUpgrade.sourceRoots,
          proposed,
        ),
      },
    };
  }

  return {
    kind: "prepared",
    upgrade: {
      kind: "ordinary",
      source: capturedUpgrade.source,
      successor: capturedUpgrade.successor,
      edge: capturedUpgrade.edge,
    },
  };
}

function applyPreparedUpgrade(
  db: DatabaseSync,
  current: MetadataVersionNode,
  authority: WorkspaceWriteAuthority,
  storeRoot: string,
  prepared: Extract<
    Awaited<ReturnType<typeof captureAndPrepareNextUpgrade>>,
    { readonly kind: "prepared" }
  >,
): ApplyPreparedUpgradeResult {
  const upgrade = prepared.upgrade;
  db.exec("BEGIN IMMEDIATE");
  try {
    const observed = metadataSchemaVersion(db);
    if (observed !== upgrade.source.version) {
      // Another process advanced while external immutable objects were being
      // prepared. Re-discover the next edge from the committed version.
      db.exec("ROLLBACK");
      if (findMetadataVersion(current, observed) === undefined) {
        requireMetadataVersion(current, db);
      }
      return "version-changed";
    }
    validateMetadataVersion(db, upgrade.source);
    if (
      upgrade.kind === "tree-format" &&
      !treeRootsAreEqual(
        canonicalTreeRoots(upgrade.source.referencedTreeOids(db)),
        upgrade.prepared.sourceRoots,
      )
    ) {
      // Root authority changed while immutable objects were being prepared.
      // Retry the same adjacent edge from a fresh authenticated root set.
      db.exec("ROLLBACK");
      return "tree-roots-changed";
    }

    assertWorkspaceWriteAuthority(authority, storeRoot);
    dropWriterFences(db, upgrade.source.schema);
    if (upgrade.kind === "tree-format") {
      upgrade.edge.applyWithinTransaction(db, upgrade.prepared);
    } else {
      upgrade.edge.applyWithinTransaction(db);
    }
    db.exec(`PRAGMA user_version = ${upgrade.successor.version}`);
    validateMetadataVersion(db, upgrade.successor);
    if (
      upgrade.kind === "tree-format" &&
      !treeRootsAreEqual(
        canonicalTreeRoots(upgrade.successor.referencedTreeOids(db)),
        upgrade.prepared.successorRoots,
      )
    ) {
      throw new MetadataError(
        "tree-format migration did not preserve the exact mapped root set",
      );
    }
    db.exec("COMMIT");
    return "applied";
  } catch (error) {
    rollbackPreservingPrimary(db);
    throw error;
  }
}

/**
 * Bring one opened connection to `current`. Empty databases initialize current
 * directly; published databases commit exactly one adjacent edge at a time.
 */
export async function migrateMetadataToCurrent(
  db: DatabaseSync,
  dependencies: MetadataMigrationDependencies,
  authority: WorkspaceWriteAuthority,
  storeRoot: string,
  current: MetadataVersionNode = CURRENT_METADATA_VERSION,
): Promise<void> {
  let consecutiveTreeRootDriftRetries = 0;
  while (true) {
    if (metadataSchemaVersion(db) === 0) {
      db.exec("BEGIN IMMEDIATE");
      try {
        if (metadataSchemaVersion(db) === 0) {
          assertWorkspaceWriteAuthority(authority, storeRoot);
          initializeMetadataVersionWithinTransaction(db, current);
          db.exec("COMMIT");
          return;
        }
        db.exec("ROLLBACK");
      } catch (error) {
        rollbackPreservingPrimary(db);
        throw error;
      }
      continue;
    }

    const next = await captureAndPrepareNextUpgrade(db, current, dependencies);
    if (next.kind === "current") return;
    const result = applyPreparedUpgrade(
      db,
      current,
      authority,
      storeRoot,
      next,
    );
    if (result === "tree-roots-changed") {
      consecutiveTreeRootDriftRetries += 1;
      if (
        consecutiveTreeRootDriftRetries >=
        MAX_CONSECUTIVE_TREE_ROOT_DRIFT_RETRIES
      ) {
        throw new MetadataError(
          "metadata tree roots kept changing during adjacent format migration",
        );
      }
    } else {
      consecutiveTreeRootDriftRetries = 0;
    }
  }
}
