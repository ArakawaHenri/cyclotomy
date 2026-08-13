import { type DatabaseSync } from "node:sqlite";

import {
  metadataSchemaSpec,
  schemaObject,
  validateUninitializedMetadataDatabase,
  writerFenceSchemaObjects,
  writerFenceSql,
} from "../schema.ts";
import {
  defineMetadataVersion,
  defineTreeFormatMetadataUpgrade,
  matchRegisteredSession,
  type PreparedMetadataTreeUpgrade,
  readTreeOids,
} from "../version.ts";
import {
  NODE_STATE_V1_SCHEMA_SQL,
  SESSION_REGISTRY_MISSING_V1_INDEX_SQL,
  V1_METADATA_VERSION,
} from "./v1.ts";
import { TREE_MANIFEST_FORMAT_V2 } from "../../tree-formats/v2.ts";

export const V2_METADATA_WRITER_PROTOCOL = 2;

export const NODE_WRITE_GUARD_V2_SCHEMA_SQL = `
  CREATE TABLE node_write_guard(
    session_id TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    PRIMARY KEY(session_id, entry_id)
  ) STRICT, WITHOUT ROWID
`;

export const SESSION_REGISTRY_V2_SCHEMA_SQL = `
  CREATE TABLE session_registry(
    session_id TEXT NOT NULL PRIMARY KEY,
    session_file TEXT NOT NULL UNIQUE,
    missing_since INTEGER,
    missing_observed_at INTEGER,
    pending_node_guard INTEGER NOT NULL DEFAULT 0
      CHECK(pending_node_guard IN (0, 1))
  ) STRICT, WITHOUT ROWID
`;

export const V2_FENCED_TABLES = Object.freeze([
  "node_state",
  "node_write_guard",
  "session_registry",
]);

export const V2_METADATA_SCHEMA = metadataSchemaSpec({
  version: 2,
  errorLabel: "published v2 layout",
  objects: {
    node_state: schemaObject("table", "node_state", NODE_STATE_V1_SCHEMA_SQL),
    node_write_guard: schemaObject(
      "table",
      "node_write_guard",
      NODE_WRITE_GUARD_V2_SCHEMA_SQL,
    ),
    session_registry: schemaObject(
      "table",
      "session_registry",
      SESSION_REGISTRY_V2_SCHEMA_SQL,
    ),
    session_registry_missing: schemaObject(
      "index",
      "session_registry",
      SESSION_REGISTRY_MISSING_V1_INDEX_SQL,
    ),
    ...writerFenceSchemaObjects(V2_FENCED_TABLES, V2_METADATA_WRITER_PROTOCOL),
  },
  fencedTables: V2_FENCED_TABLES,
  writerProtocol: V2_METADATA_WRITER_PROTOCOL,
});

function replaceTreeRoots(
  db: DatabaseSync,
  replacements: PreparedMetadataTreeUpgrade["replacements"],
): void {
  if (replacements.length === 0) return;
  db.exec(`
    DROP TABLE IF EXISTS temp.cyclotomy_tree_oid_replacement;
    CREATE TEMP TABLE cyclotomy_tree_oid_replacement(
      old_tree_oid TEXT NOT NULL PRIMARY KEY,
      new_tree_oid TEXT NOT NULL
    ) STRICT, WITHOUT ROWID;
  `);
  const insert = db.prepare(
    `INSERT INTO temp.cyclotomy_tree_oid_replacement(
       old_tree_oid, new_tree_oid
     ) VALUES (?, ?)`,
  );
  for (const { source, target } of replacements) {
    insert.run(source, target);
  }
  db.prepare(
    `UPDATE node_state AS state
     SET tree_oid = replacement.new_tree_oid
     FROM temp.cyclotomy_tree_oid_replacement AS replacement
     WHERE state.tree_oid = replacement.old_tree_oid`,
  ).run();
  db.exec("DROP TABLE temp.cyclotomy_tree_oid_replacement");
}

export const V1_TO_V2_METADATA_UPGRADE = defineTreeFormatMetadataUpgrade(
  (db, prepared) => {
    db.exec(`
      ${NODE_WRITE_GUARD_V2_SCHEMA_SQL};
      ALTER TABLE session_registry
      ADD COLUMN pending_node_guard INTEGER NOT NULL DEFAULT 0
        CHECK(pending_node_guard IN (0, 1));
    `);
    replaceTreeRoots(db, prepared.replacements);
    db.exec(
      writerFenceSql(V2_FENCED_TABLES, V2_METADATA_WRITER_PROTOCOL).join(";\n"),
    );
  },
);

function initializeV2(db: DatabaseSync): void {
  validateUninitializedMetadataDatabase(db);
  db.exec(`
    ${NODE_STATE_V1_SCHEMA_SQL};
    ${NODE_WRITE_GUARD_V2_SCHEMA_SQL};
    ${SESSION_REGISTRY_V2_SCHEMA_SQL};
    ${SESSION_REGISTRY_MISSING_V1_INDEX_SQL};
    ${writerFenceSql(V2_FENCED_TABLES, V2_METADATA_WRITER_PROTOCOL).join(
      ";\n",
    )};
    PRAGMA user_version = 2;
  `);
}

export const V2_METADATA_VERSION = defineMetadataVersion({
  version: 2,
  treeFormat: TREE_MANIFEST_FORMAT_V2,
  schema: V2_METADATA_SCHEMA,
  previous: V1_METADATA_VERSION,
  upgradeFromPrevious: V1_TO_V2_METADATA_UPGRADE,
  initializeWithinTransaction: initializeV2,
  referencedTreeOids: (db, limit) => readTreeOids(db, "node_state", limit),
  matchSessionIdentity: matchRegisteredSession,
});
