import { type DatabaseSync } from "node:sqlite";

import { isTreeOid, type TreeOid } from "../../domain/model.ts";
import {
  MetadataError,
  MetadataVersionUnsupportedError,
} from "../metadata-error.ts";
import {
  isDefinedMetadataSchema,
  metadataSchemaVersion,
  type MetadataSchemaSpec,
  validateMetadataSchema,
} from "./schema.ts";

export type MetadataSessionIdentityMatch = "absent" | "conflict" | "exact";

export interface MetadataMigrationDependencies {
  readonly signal?: AbortSignal | undefined;
  /**
   * Publish the requested-format equivalent of every supplied rooted tree.
   * The result is total: unchanged roots map to themselves.
   */
  readonly prepareTreeOidUpgrades: (
    roots: readonly TreeOid[],
    targetFormat: string,
  ) => Promise<ReadonlyMap<TreeOid, TreeOid>>;
}

export interface MetadataTreeRootReplacement {
  readonly source: TreeOid;
  readonly target: TreeOid;
}

/**
 * Total, engine-authenticated replacement of one source generation's rooted
 * trees. Arrays are canonical sets (unique and sorted) so the engine can prove
 * the same roots immediately before and after the SQL cutover.
 */
export interface PreparedMetadataTreeUpgrade {
  readonly sourceRoots: readonly TreeOid[];
  readonly replacements: readonly MetadataTreeRootReplacement[];
  readonly successorRoots: readonly TreeOid[];
}

interface OrdinaryAdjacentMetadataUpgrade {
  readonly kind: "ordinary";
  readonly applyWithinTransaction: (db: DatabaseSync) => void;
}

interface TreeFormatAdjacentMetadataUpgrade {
  readonly kind: "tree-format";
  readonly applyWithinTransaction: (
    db: DatabaseSync,
    prepared: PreparedMetadataTreeUpgrade,
  ) => void;
}

export type AdjacentMetadataUpgrade =
  OrdinaryAdjacentMetadataUpgrade | TreeFormatAdjacentMetadataUpgrade;

export function defineSynchronousMetadataUpgrade(
  applyWithinTransaction: (db: DatabaseSync) => void,
): AdjacentMetadataUpgrade {
  return Object.freeze({
    kind: "ordinary",
    applyWithinTransaction: (db: DatabaseSync) => applyWithinTransaction(db),
  });
}

/**
 * Define the SQL half of a durable tree-format cutover. Object preparation,
 * total-map validation, source-root CAS, and successor-root verification stay
 * in the adjacent-chain engine and cannot be omitted by an individual version.
 */
export function defineTreeFormatMetadataUpgrade(
  applyWithinTransaction: (
    db: DatabaseSync,
    prepared: PreparedMetadataTreeUpgrade,
  ) => void,
): AdjacentMetadataUpgrade {
  return Object.freeze({
    kind: "tree-format",
    applyWithinTransaction,
  });
}

export interface MetadataVersion {
  readonly version: number;
  /** Tree format durably rooted by this metadata generation. */
  readonly treeFormat: string;
  readonly schema: Readonly<MetadataSchemaSpec>;
  readonly upgradeFromPrevious?: AdjacentMetadataUpgrade;
  readonly initializeWithinTransaction: (db: DatabaseSync) => void;
  readonly referencedTreeOids: (
    db: DatabaseSync,
    limit?: number,
  ) => readonly TreeOid[];
  readonly matchSessionIdentity: (
    db: DatabaseSync,
    sessionId: string,
    sessionFile: string,
  ) => MetadataSessionIdentityMatch;
}

/** Define one published schema and its upgrade from the preceding version. */
export function defineMetadataVersion(
  definition: MetadataVersion,
): MetadataVersion {
  if (
    !isDefinedMetadataSchema(definition.schema) ||
    !Number.isSafeInteger(definition.version) ||
    definition.version <= 0 ||
    definition.schema.version !== definition.version
  ) {
    throw new TypeError("metadata version and schema identity must agree");
  }
  if (definition.treeFormat.length === 0) {
    throw new TypeError("metadata tree format identity must be non-empty");
  }
  return Object.freeze(definition);
}

/** Version n occupies index n - 1; only adjacent upgrades can be registered. */
export function defineMetadataVersions(
  definitions: readonly MetadataVersion[],
): readonly MetadataVersion[] {
  if (definitions.length === 0)
    throw new TypeError("metadata versions must not be empty");
  for (const [index, definition] of definitions.entries()) {
    if (definition.version !== index + 1) {
      throw new TypeError(
        "metadata versions must be consecutive starting at one",
      );
    }
    const previous = definitions[index - 1];
    const edge = definition.upgradeFromPrevious;
    if (previous === undefined) {
      if (edge !== undefined)
        throw new TypeError(
          "first metadata version cannot have an upgrade edge",
        );
      continue;
    }
    if (edge === undefined)
      throw new TypeError("metadata successor requires an adjacent upgrade");
    if (
      previous.schema.writerProtocol !== undefined &&
      definition.schema.writerProtocol === undefined
    ) {
      throw new TypeError(
        "metadata successor cannot remove writer-fence protection",
      );
    }
    const changesTreeFormat = definition.treeFormat !== previous.treeFormat;
    if (changesTreeFormat && edge.kind !== "tree-format") {
      throw new TypeError(
        "metadata tree-format change requires an externally prepared adjacent edge",
      );
    }
    if (!changesTreeFormat && edge.kind === "tree-format") {
      throw new TypeError(
        "metadata tree-format edge must change the durable tree format",
      );
    }
  }
  return Object.freeze([...definitions]);
}

export function requireMetadataVersion(
  versions: readonly MetadataVersion[],
  db: DatabaseSync,
): MetadataVersion {
  const observed = metadataSchemaVersion(db);
  const version = versions[observed - 1];
  if (version !== undefined) return version;
  const current = versions.at(-1)!;
  throw new MetadataVersionUnsupportedError(observed, current.version);
}

export function validateMetadataVersion(
  db: DatabaseSync,
  version: MetadataVersion,
): void {
  validateMetadataSchema(db, version.schema);
}

export function readTreeOids(
  db: DatabaseSync,
  table: string,
  limit?: number,
): readonly TreeOid[] {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) {
    throw new RangeError("metadata tree-root limit must be a positive integer");
  }
  const statement = db.prepare(
    `SELECT DISTINCT tree_oid FROM ${table}
     WHERE tree_oid IS NOT NULL ORDER BY tree_oid${
       limit === undefined ? "" : " LIMIT ?"
     }`,
  );
  const rows = limit === undefined ? statement.all() : statement.all(limit);
  return rows.map((row) => {
    if (!isTreeOid(row.tree_oid)) {
      throw new MetadataError("invalid tree oid in metadata root set");
    }
    return row.tree_oid;
  });
}

export function matchRegisteredSession(
  db: DatabaseSync,
  sessionId: string,
  sessionFile: string,
): MetadataSessionIdentityMatch {
  const rows = db
    .prepare(
      `SELECT session_id, session_file FROM session_registry
       WHERE session_id = ? OR session_file = ?`,
    )
    .all(sessionId, sessionFile);
  if (rows.length === 0) return "absent";
  if (rows.length !== 1) return "conflict";
  const row = rows[0]!;
  return row.session_id === sessionId && row.session_file === sessionFile
    ? "exact"
    : "conflict";
}
