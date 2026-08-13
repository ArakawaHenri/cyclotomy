import { type DatabaseSync } from "node:sqlite";

import {
  metadataSchemaSpec,
  schemaObject,
  validateUninitializedMetadataDatabase,
} from "../schema.ts";
import {
  defineMetadataVersion,
  matchRegisteredSession,
  readTreeOids,
} from "../version.ts";
import { TREE_MANIFEST_FORMAT_V1 } from "../../tree-formats/v1.ts";

export const NODE_STATE_V1_SCHEMA_SQL = `
  CREATE TABLE node_state(
    session_id TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    tree_oid TEXT NOT NULL,
    PRIMARY KEY(session_id, entry_id)
  ) STRICT, WITHOUT ROWID
`;

export const SESSION_REGISTRY_V1_SCHEMA_SQL = `
  CREATE TABLE session_registry(
    session_id TEXT NOT NULL PRIMARY KEY,
    session_file TEXT NOT NULL UNIQUE,
    missing_since INTEGER,
    missing_observed_at INTEGER
  ) STRICT, WITHOUT ROWID
`;

export const SESSION_REGISTRY_MISSING_V1_INDEX_SQL = `
  CREATE INDEX session_registry_missing
  ON session_registry(missing_since, missing_observed_at)
`;

export const V1_METADATA_SCHEMA = metadataSchemaSpec({
  version: 1,
  errorLabel: "published v1 layout",
  objects: {
    node_state: schemaObject("table", "node_state", NODE_STATE_V1_SCHEMA_SQL),
    session_registry: schemaObject(
      "table",
      "session_registry",
      SESSION_REGISTRY_V1_SCHEMA_SQL,
    ),
    session_registry_missing: schemaObject(
      "index",
      "session_registry",
      SESSION_REGISTRY_MISSING_V1_INDEX_SQL,
    ),
  },
  fencedTables: [],
});

function initializeV1(db: DatabaseSync): void {
  validateUninitializedMetadataDatabase(db);
  db.exec(`
    ${NODE_STATE_V1_SCHEMA_SQL};
    ${SESSION_REGISTRY_V1_SCHEMA_SQL};
    ${SESSION_REGISTRY_MISSING_V1_INDEX_SQL};
    PRAGMA user_version = 1;
  `);
}

export const V1_METADATA_VERSION = defineMetadataVersion({
  version: 1,
  treeFormat: TREE_MANIFEST_FORMAT_V1,
  schema: V1_METADATA_SCHEMA,
  initializeWithinTransaction: initializeV1,
  referencedTreeOids: (db, limit) => readTreeOids(db, "node_state", limit),
  matchSessionIdentity: matchRegisteredSession,
});
