import { type DatabaseSync } from "node:sqlite";

import { MetadataError } from "../metadata-error.ts";

export const METADATA_WRITER_PROTOCOL_FUNCTION = "cyclotomy_writer_protocol";

export interface ExpectedSchemaObject {
  readonly type: "index" | "table" | "trigger";
  readonly table: string;
  readonly sql: string;
}

export interface MetadataSchemaSpec {
  readonly version: number;
  readonly errorLabel: string;
  readonly objects: Readonly<Record<string, ExpectedSchemaObject>>;
  readonly fencedTables: readonly string[];
  readonly writerProtocol?: number;
  readonly validateTableShape?: (db: DatabaseSync) => void;
}

const definedMetadataSchemas = new WeakSet<object>();
const WRITER_FENCE_PREFIX = "cyclotomy_writer_fence_";

export function normalizeSchemaSql(value: unknown): string {
  if (typeof value !== "string") return "";
  const quoted: string[] = [];
  const protectedSql = value.replace(
    /'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]/gu,
    (literal) => {
      const index = quoted.push(literal) - 1;
      return `\0${index}\0`;
    },
  );
  return protectedSql
    .replace(/\s+/gu, " ")
    .replace(/\s*([(),])\s*/gu, "$1")
    .trim()
    .replace(/\0([0-9]+)\0/gu, (_placeholder, index: string) => {
      const literal = quoted[Number(index)];
      return literal ?? "";
    });
}

export function schemaObject(
  type: ExpectedSchemaObject["type"],
  table: string,
  sql: string,
): ExpectedSchemaObject {
  return Object.freeze({ type, table, sql: normalizeSchemaSql(sql) });
}

export function metadataSchemaSpec(
  spec: MetadataSchemaSpec,
): Readonly<MetadataSchemaSpec> {
  const objects = Object.freeze(
    Object.fromEntries(
      Object.entries(spec.objects).map(([name, object]) => [
        name,
        schemaObject(object.type, object.table, object.sql),
      ]),
    ),
  );
  const tables = Object.entries(objects)
    .filter(([, object]) => object.type === "table")
    .map(([name]) => name)
    .sort();
  const fencedTables = [...spec.fencedTables].sort();
  if (new Set(fencedTables).size !== fencedTables.length) {
    throw new TypeError("metadata fenced tables must be unique");
  }
  if ((spec.writerProtocol === undefined) !== (fencedTables.length === 0)) {
    throw new TypeError(
      "metadata writer protocol and fenced tables must be declared together",
    );
  }
  const expectedFenceNames = new Set<string>();
  if (spec.writerProtocol !== undefined) {
    if (spec.writerProtocol !== spec.version) {
      throw new TypeError(
        "metadata writer protocol must advance with its schema version",
      );
    }
    if (
      tables.length !== fencedTables.length ||
      tables.some((table, index) => table !== fencedTables[index])
    ) {
      throw new TypeError("every metadata table must be writer-fenced");
    }
    for (const table of tables) {
      for (const event of METADATA_DML_EVENTS) {
        const name = writerFenceTriggerName(table, event);
        expectedFenceNames.add(name);
        const expected = schemaObject(
          "trigger",
          table,
          writerFenceTriggerSql(table, event, spec.writerProtocol),
        );
        const actual = objects[name];
        if (
          actual === undefined ||
          actual.type !== expected.type ||
          actual.table !== expected.table ||
          actual.sql !== expected.sql
        ) {
          throw new TypeError(
            `metadata table ${table} lacks its exact ${event} writer fence`,
          );
        }
      }
    }
  }
  for (const name of Object.keys(objects)) {
    if (name.startsWith(WRITER_FENCE_PREFIX) && !expectedFenceNames.has(name)) {
      throw new TypeError(
        `metadata schema contains an unexpected writer fence ${name}`,
      );
    }
  }
  const defined = Object.freeze({
    ...spec,
    objects,
    fencedTables: Object.freeze([...spec.fencedTables]),
  });
  definedMetadataSchemas.add(defined);
  return defined;
}

/** Only schemas normalized and authenticated by this module may form nodes. */
export function isDefinedMetadataSchema(
  spec: Readonly<MetadataSchemaSpec>,
): boolean {
  return definedMetadataSchemas.has(spec);
}

export const METADATA_DML_EVENTS = Object.freeze([
  "DELETE",
  "INSERT",
  "UPDATE",
] as const);
export type MetadataDmlEvent = (typeof METADATA_DML_EVENTS)[number];

export function writerFenceTriggerName(
  table: string,
  event: MetadataDmlEvent,
): string {
  return `cyclotomy_writer_fence_${table}_${event.toLowerCase()}`;
}

export function writerFenceTriggerSql(
  table: string,
  event: MetadataDmlEvent,
  protocol: number,
): string {
  return `
    CREATE TRIGGER ${writerFenceTriggerName(table, event)}
    BEFORE ${event} ON ${table}
    WHEN ${METADATA_WRITER_PROTOCOL_FUNCTION}() IS NOT ${protocol}
    BEGIN
      SELECT RAISE(ABORT, 'Cyclotomy metadata writer protocol mismatch');
    END
  `;
}

export function writerFenceSql(
  tables: readonly string[],
  protocol: number,
): readonly string[] {
  return tables.flatMap((table) =>
    METADATA_DML_EVENTS.map((event) =>
      writerFenceTriggerSql(table, event, protocol),
    ),
  );
}

export function writerFenceSchemaObjects(
  tables: readonly string[],
  protocol: number,
): Readonly<Record<string, ExpectedSchemaObject>> {
  return Object.fromEntries(
    tables.flatMap((table) =>
      METADATA_DML_EVENTS.map((event) => [
        writerFenceTriggerName(table, event),
        schemaObject(
          "trigger",
          table,
          writerFenceTriggerSql(table, event, protocol),
        ),
      ]),
    ),
  );
}

export function dropWriterFences(
  db: DatabaseSync,
  from: Readonly<MetadataSchemaSpec>,
): void {
  if (from.fencedTables.length === 0) return;
  db.exec(
    from.fencedTables
      .flatMap((table) =>
        METADATA_DML_EVENTS.map(
          (event) => `DROP TRIGGER ${writerFenceTriggerName(table, event)}`,
        ),
      )
      .join(";\n"),
  );
}

export function metadataSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as {
    readonly user_version: number | bigint;
  };
  const version = Number(row.user_version);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new MetadataError("metadata schema version is invalid");
  }
  return version;
}

/** Authenticate SQLite's empty sentinel without treating it as a version. */
export function validateUninitializedMetadataDatabase(db: DatabaseSync): void {
  if (metadataSchemaVersion(db) !== 0) {
    throw new MetadataError("metadata database is not uninitialized");
  }
  const objects = db
    .prepare(
      `SELECT type, name FROM main.sqlite_schema
       WHERE name NOT GLOB 'sqlite_*'
       ORDER BY type, name`,
    )
    .all();
  if (objects.length !== 0) {
    throw new MetadataError(
      "unversioned metadata database contains unexpected schema objects",
    );
  }
}

export function validateMetadataSchema(
  db: DatabaseSync,
  spec: Readonly<MetadataSchemaSpec>,
): void {
  const version = metadataSchemaVersion(db);
  if (version !== spec.version) {
    throw new MetadataError("metadata schema migration did not converge");
  }
  const expected = spec.objects;
  const actual = db
    .prepare(
      `SELECT type, name, tbl_name, sql FROM main.sqlite_schema
       WHERE type IN ('trigger', 'view') OR name NOT GLOB 'sqlite_*'
       ORDER BY type, name`,
    )
    .all();
  if (
    actual.length !== Object.keys(expected).length ||
    actual.some((row) => {
      const wanted = expected[String(row.name)];
      return (
        wanted === undefined ||
        row.type !== wanted.type ||
        String(row.tbl_name) !== wanted.table ||
        normalizeSchemaSql(row.sql) !== wanted.sql
      );
    })
  ) {
    throw new MetadataError(
      `metadata schema v${version} does not match the ${spec.errorLabel}`,
    );
  }
  spec.validateTableShape?.(db);
}
