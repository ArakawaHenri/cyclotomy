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
  defineSynchronousMetadataUpgrade,
  matchRegisteredSession,
  readTreeOids,
} from "../version.ts";
import { TREE_MANIFEST_FORMAT_V3 } from "../../tree-formats/v3-current.ts";
import {
  CHECKPOINT_SLOT_TABLE_LAYOUT,
  CHECKPOINT_SLOT_V3_SCHEMA_SQL,
  SESSION_CAPTURE_BARRIER_TABLE_LAYOUT,
  SESSION_CAPTURE_BARRIER_V3_SCHEMA_SQL,
  SESSION_REGISTRY_TABLE_LAYOUT,
  SESSION_REGISTRY_V3_SCHEMA_SQL,
  validateMetadataTableLayout,
  validateSessionRegistryIndexLayout,
} from "./v3.ts";

export const V5_METADATA_WRITER_PROTOCOL = 5;

/**
 * Per-session history identity. `history_epoch` advances exactly once for each
 * authorized whole-session forget, so a writer that committed against an older
 * generation can be refused without inspecting slots. `reset_pending` is the
 * treeless tombstone left by that forget: it carries no tree reference, is not
 * an object-GC root, and is cleared only by the first stable attach that
 * re-establishes protection for the coordinates that still exist.
 */
export const SESSION_HISTORY_V5_SCHEMA_SQL = `
  CREATE TABLE session_history(
    session_id TEXT NOT NULL PRIMARY KEY,
    history_epoch INTEGER NOT NULL CHECK(history_epoch >= 0),
    reset_pending INTEGER NOT NULL CHECK(reset_pending IN (0, 1))
  ) STRICT, WITHOUT ROWID
`;

export const SESSION_HISTORY_TABLE_LAYOUT = Object.freeze({
  name: "session_history",
  columns: Object.freeze([
    { name: "session_id", type: "TEXT", notnull: 1, pk: 1 },
    { name: "history_epoch", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "reset_pending", type: "INTEGER", notnull: 1, pk: 0 },
  ]),
});

export const V5_FENCED_TABLES = Object.freeze([
  "checkpoint_slot",
  "session_capture_barrier",
  "session_history",
  "session_registry",
]);

function validateV5TableShape(db: DatabaseSync): void {
  validateMetadataTableLayout(db, [
    CHECKPOINT_SLOT_TABLE_LAYOUT,
    SESSION_CAPTURE_BARRIER_TABLE_LAYOUT,
    SESSION_HISTORY_TABLE_LAYOUT,
    SESSION_REGISTRY_TABLE_LAYOUT,
  ]);
  validateSessionRegistryIndexLayout(db);
}

/** V5 adds the history identity table without touching the relational slot layout. */
export const V5_METADATA_SCHEMA = metadataSchemaSpec({
  version: 5,
  errorLabel: "metadata v5 layout",
  objects: {
    checkpoint_slot: schemaObject(
      "table",
      "checkpoint_slot",
      CHECKPOINT_SLOT_V3_SCHEMA_SQL,
    ),
    session_capture_barrier: schemaObject(
      "table",
      "session_capture_barrier",
      SESSION_CAPTURE_BARRIER_V3_SCHEMA_SQL,
    ),
    session_history: schemaObject(
      "table",
      "session_history",
      SESSION_HISTORY_V5_SCHEMA_SQL,
    ),
    session_registry: schemaObject(
      "table",
      "session_registry",
      SESSION_REGISTRY_V3_SCHEMA_SQL,
    ),
    ...writerFenceSchemaObjects(V5_FENCED_TABLES, V5_METADATA_WRITER_PROTOCOL),
  },
  fencedTables: V5_FENCED_TABLES,
  writerProtocol: V5_METADATA_WRITER_PROTOCOL,
  validateTableShape: validateV5TableShape,
});

/**
 * Existing sessions start at epoch zero with no reset pending: no forget has
 * happened for them, and the epoch is only ever advanced by one.
 */
export const V4_TO_V5_METADATA_UPGRADE = defineSynchronousMetadataUpgrade(
  (db) => {
    db.exec(`
      ${SESSION_HISTORY_V5_SCHEMA_SQL};
      INSERT INTO session_history(session_id, history_epoch, reset_pending)
      SELECT session_id, 0, 0 FROM session_registry;
      ${writerFenceSql(V5_FENCED_TABLES, V5_METADATA_WRITER_PROTOCOL).join(
        ";\n",
      )};
    `);
  },
);

function initializeV5(db: DatabaseSync): void {
  validateUninitializedMetadataDatabase(db);
  db.exec(`
    ${SESSION_REGISTRY_V3_SCHEMA_SQL};
    ${CHECKPOINT_SLOT_V3_SCHEMA_SQL};
    ${SESSION_CAPTURE_BARRIER_V3_SCHEMA_SQL};
    ${SESSION_HISTORY_V5_SCHEMA_SQL};
    ${writerFenceSql(V5_FENCED_TABLES, V5_METADATA_WRITER_PROTOCOL).join(
      ";\n",
    )};
    PRAGMA user_version = 5;
  `);
}

export const V5_METADATA_VERSION = defineMetadataVersion({
  version: 5,
  treeFormat: TREE_MANIFEST_FORMAT_V3,
  schema: V5_METADATA_SCHEMA,
  upgradeFromPrevious: V4_TO_V5_METADATA_UPGRADE,
  initializeWithinTransaction: initializeV5,
  referencedTreeOids: (db, limit) => readTreeOids(db, "checkpoint_slot", limit),
  matchSessionIdentity: matchRegisteredSession,
});
