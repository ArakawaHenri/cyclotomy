import { type DatabaseSync } from "node:sqlite";

import { MetadataError } from "../../metadata-error.ts";
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
import { V2_METADATA_VERSION } from "./v2.ts";
import { TREE_MANIFEST_FORMAT_V2 } from "../../tree-formats/v2.ts";

export const V3_METADATA_WRITER_PROTOCOL = 3;

export const CHECKPOINT_SLOT_V3_SCHEMA_SQL = `
  CREATE TABLE checkpoint_slot(
    session_id TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    tree_oid TEXT,
    capture_state TEXT NOT NULL
      CHECK(capture_state IN ('open', 'blocked')),
    PRIMARY KEY(session_id, entry_id),
    CHECK(tree_oid IS NOT NULL OR capture_state = 'blocked')
  ) STRICT, WITHOUT ROWID
`;

export const SESSION_CAPTURE_BARRIER_V3_SCHEMA_SQL = `
  CREATE TABLE session_capture_barrier(
    session_id TEXT NOT NULL PRIMARY KEY
  ) STRICT, WITHOUT ROWID
`;

export const SESSION_REGISTRY_V3_SCHEMA_SQL = `
  CREATE TABLE session_registry(
    session_id TEXT NOT NULL PRIMARY KEY,
    session_file TEXT NOT NULL UNIQUE,
    registration_state TEXT NOT NULL
      CHECK(registration_state IN ('pending', 'verified'))
  ) STRICT, WITHOUT ROWID
`;

export const V3_FENCED_TABLES = Object.freeze([
  "checkpoint_slot",
  "session_capture_barrier",
  "session_registry",
]);

function validateV3TableShape(db: DatabaseSync): void {
  const tables = (
    db.prepare("PRAGMA table_list").all() as unknown as {
      readonly name: unknown;
      readonly type: unknown;
      readonly wr: unknown;
      readonly strict: unknown;
    }[]
  )
    .filter(
      (row) => row.type === "table" && !String(row.name).startsWith("sqlite_"),
    )
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
  const expectedTables = [
    "checkpoint_slot",
    "session_capture_barrier",
    "session_registry",
  ];
  if (
    tables.length !== expectedTables.length ||
    tables.some(
      (table, index) =>
        String(table.name) !== expectedTables[index] ||
        Number(table.wr) !== 1 ||
        Number(table.strict) !== 1,
    )
  ) {
    throw new MetadataError(
      "metadata schema has unexpected tables or table options",
    );
  }

  type Column = {
    readonly name: string;
    readonly type: string;
    readonly notnull: number;
    readonly pk: number;
  };
  const validateColumns = (
    table: string,
    expected: readonly Column[],
  ): void => {
    const actual = db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => ({
        name: String(row.name),
        type: String(row.type),
        notnull: Number(row.notnull),
        pk: Number(row.pk),
      }));
    if (
      actual.length !== expected.length ||
      actual.some((column, index) => {
        const wanted = expected[index];
        return (
          wanted === undefined ||
          column.name !== wanted.name ||
          column.type !== wanted.type ||
          column.notnull !== wanted.notnull ||
          column.pk !== wanted.pk
        );
      })
    ) {
      throw new MetadataError(
        `metadata table ${table} has an unexpected column layout`,
      );
    }
  };

  validateColumns("checkpoint_slot", [
    { name: "session_id", type: "TEXT", notnull: 1, pk: 1 },
    { name: "entry_id", type: "TEXT", notnull: 1, pk: 2 },
    { name: "tree_oid", type: "TEXT", notnull: 0, pk: 0 },
    { name: "capture_state", type: "TEXT", notnull: 1, pk: 0 },
  ]);
  validateColumns("session_capture_barrier", [
    { name: "session_id", type: "TEXT", notnull: 1, pk: 1 },
  ]);
  validateColumns("session_registry", [
    { name: "session_id", type: "TEXT", notnull: 1, pk: 1 },
    { name: "session_file", type: "TEXT", notnull: 1, pk: 0 },
    { name: "registration_state", type: "TEXT", notnull: 1, pk: 0 },
  ]);

  const indexes = db.prepare("PRAGMA index_list(session_registry)").all();
  const uniqueSessionFile = indexes.find((row) => {
    if (Number(row.unique) !== 1 || row.origin !== "u") return false;
    const columns = db.prepare(`PRAGMA index_info(${String(row.name)})`).all();
    return columns.length === 1 && columns[0]?.name === "session_file";
  });
  if (
    uniqueSessionFile === undefined ||
    indexes.some((row) => row.origin === "c")
  ) {
    throw new MetadataError("metadata schema has unexpected indexes");
  }
}

export const V3_METADATA_SCHEMA = metadataSchemaSpec({
  version: 3,
  errorLabel: "metadata v3 layout",
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
    session_registry: schemaObject(
      "table",
      "session_registry",
      SESSION_REGISTRY_V3_SCHEMA_SQL,
    ),
    ...writerFenceSchemaObjects(V3_FENCED_TABLES, V3_METADATA_WRITER_PROTOCOL),
  },
  fencedTables: V3_FENCED_TABLES,
  writerProtocol: V3_METADATA_WRITER_PROTOCOL,
  validateTableShape: validateV3TableShape,
});

export const V2_TO_V3_METADATA_UPGRADE = defineSynchronousMetadataUpgrade(
  (db) => {
    db.exec(`
      ${CHECKPOINT_SLOT_V3_SCHEMA_SQL};

      INSERT INTO checkpoint_slot(
        session_id, entry_id, tree_oid, capture_state
      )
      SELECT
        state.session_id,
        state.entry_id,
        state.tree_oid,
        CASE WHEN guard.entry_id IS NULL THEN 'open' ELSE 'blocked' END
      FROM node_state AS state
      LEFT JOIN node_write_guard AS guard
        ON guard.session_id = state.session_id
       AND guard.entry_id = state.entry_id;

      INSERT INTO checkpoint_slot(
        session_id, entry_id, tree_oid, capture_state
      )
      SELECT guard.session_id, guard.entry_id, NULL, 'blocked'
      FROM node_write_guard AS guard
      WHERE NOT EXISTS (
        SELECT 1 FROM node_state AS state
        WHERE state.session_id = guard.session_id
          AND state.entry_id = guard.entry_id
      );

      ${SESSION_CAPTURE_BARRIER_V3_SCHEMA_SQL};
      INSERT INTO session_capture_barrier(session_id)
      SELECT session_id FROM session_registry
      WHERE pending_node_guard = 1;

      ALTER TABLE session_registry RENAME TO cyclotomy_v2_session_registry;
      ${SESSION_REGISTRY_V3_SCHEMA_SQL};
      INSERT INTO session_registry(
        session_id, session_file, registration_state
      )
      SELECT session_id, session_file, 'pending'
      FROM cyclotomy_v2_session_registry;

      DROP TABLE cyclotomy_v2_session_registry;
      DROP TABLE node_write_guard;
      DROP TABLE node_state;

      ${writerFenceSql(V3_FENCED_TABLES, V3_METADATA_WRITER_PROTOCOL).join(
        ";\n",
      )};
    `);
  },
);

function initializeV3(db: DatabaseSync): void {
  validateUninitializedMetadataDatabase(db);
  db.exec(`
    ${SESSION_REGISTRY_V3_SCHEMA_SQL};
    ${CHECKPOINT_SLOT_V3_SCHEMA_SQL};
    ${SESSION_CAPTURE_BARRIER_V3_SCHEMA_SQL};
    ${writerFenceSql(V3_FENCED_TABLES, V3_METADATA_WRITER_PROTOCOL).join(
      ";\n",
    )};
    PRAGMA user_version = 3;
  `);
}

export const V3_METADATA_VERSION = defineMetadataVersion({
  version: 3,
  treeFormat: TREE_MANIFEST_FORMAT_V2,
  schema: V3_METADATA_SCHEMA,
  previous: V2_METADATA_VERSION,
  upgradeFromPrevious: V2_TO_V3_METADATA_UPGRADE,
  initializeWithinTransaction: initializeV3,
  referencedTreeOids: (db, limit) => readTreeOids(db, "checkpoint_slot", limit),
  matchSessionIdentity: matchRegisteredSession,
});
