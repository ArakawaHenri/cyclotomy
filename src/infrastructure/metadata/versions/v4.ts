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
import { TREE_MANIFEST_FORMAT_V3 } from "../../tree-formats/v3-current.ts";
import {
  CHECKPOINT_SLOT_V3_SCHEMA_SQL,
  SESSION_CAPTURE_BARRIER_V3_SCHEMA_SQL,
  SESSION_REGISTRY_V3_SCHEMA_SQL,
  V3_METADATA_SCHEMA,
  V3_METADATA_VERSION,
} from "./v3.ts";

export const V4_METADATA_WRITER_PROTOCOL = 4;

export const V4_FENCED_TABLES = Object.freeze([
  "checkpoint_slot",
  "session_capture_barrier",
  "session_registry",
]);

/** V4 changes the rooted tree generation, not the relational table layout. */
export const V4_METADATA_SCHEMA = metadataSchemaSpec({
  version: 4,
  errorLabel: "metadata v4 layout",
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
    ...writerFenceSchemaObjects(V4_FENCED_TABLES, V4_METADATA_WRITER_PROTOCOL),
  },
  fencedTables: V4_FENCED_TABLES,
  writerProtocol: V4_METADATA_WRITER_PROTOCOL,
  ...(V3_METADATA_SCHEMA.validateTableShape === undefined
    ? {}
    : { validateTableShape: V3_METADATA_SCHEMA.validateTableShape }),
});

function replaceCheckpointTreeRoots(
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
    `UPDATE checkpoint_slot AS slot
     SET tree_oid = replacement.new_tree_oid
     FROM temp.cyclotomy_tree_oid_replacement AS replacement
     WHERE slot.tree_oid = replacement.old_tree_oid`,
  ).run();
  db.exec("DROP TABLE temp.cyclotomy_tree_oid_replacement");
}

/** SQL half of the single, externally prepared tree-v2 -> tree-v3 cutover. */
export const V3_TO_V4_METADATA_UPGRADE = defineTreeFormatMetadataUpgrade(
  (db, prepared) => {
    replaceCheckpointTreeRoots(db, prepared.replacements);
    db.exec(
      writerFenceSql(V4_FENCED_TABLES, V4_METADATA_WRITER_PROTOCOL).join(";\n"),
    );
  },
);

function initializeV4(db: DatabaseSync): void {
  validateUninitializedMetadataDatabase(db);
  db.exec(`
    ${SESSION_REGISTRY_V3_SCHEMA_SQL};
    ${CHECKPOINT_SLOT_V3_SCHEMA_SQL};
    ${SESSION_CAPTURE_BARRIER_V3_SCHEMA_SQL};
    ${writerFenceSql(V4_FENCED_TABLES, V4_METADATA_WRITER_PROTOCOL).join(
      ";\n",
    )};
    PRAGMA user_version = 4;
  `);
}

export const V4_METADATA_VERSION = defineMetadataVersion({
  version: 4,
  treeFormat: TREE_MANIFEST_FORMAT_V3,
  schema: V4_METADATA_SCHEMA,
  previous: V3_METADATA_VERSION,
  upgradeFromPrevious: V3_TO_V4_METADATA_UPGRADE,
  initializeWithinTransaction: initializeV4,
  referencedTreeOids: (db, limit) => readTreeOids(db, "checkpoint_slot", limit),
  matchSessionIdentity: matchRegisteredSession,
});
