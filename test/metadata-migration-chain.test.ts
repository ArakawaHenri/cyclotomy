import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  openCurrentMetadataStore,
  type CurrentMetadataStore,
} from "../src/infrastructure/metadata.ts";
import {
  CURRENT_METADATA_VERSION,
  validateMetadataTreeFormatComposition,
} from "../src/infrastructure/metadata/current.ts";
import { migrateMetadataToCurrent } from "../src/infrastructure/metadata/migration-engine.ts";
import {
  dropWriterFences,
  METADATA_WRITER_PROTOCOL_FUNCTION,
  metadataSchemaSpec,
  schemaObject,
  writerFenceSchemaObjects,
  writerFenceSql,
} from "../src/infrastructure/metadata/schema.ts";
import {
  defineMetadataVersion,
  defineSynchronousMetadataUpgrade,
  defineTreeFormatMetadataUpgrade,
  type PreparedMetadataTreeUpgrade,
  type MetadataVersionNode,
  validateMetadataVersion,
} from "../src/infrastructure/metadata/version.ts";
import {
  NODE_STATE_V1_SCHEMA_SQL,
  SESSION_REGISTRY_MISSING_V1_INDEX_SQL,
  SESSION_REGISTRY_V1_SCHEMA_SQL,
} from "../src/infrastructure/metadata/versions/v1.ts";
import { TREE_MANIFEST_FORMAT_V2 } from "../src/infrastructure/tree-formats/v2.ts";
import { CURRENT_TREE_FORMAT } from "../src/infrastructure/tree-formats/current.ts";
import { TREE_MANIFEST_FORMAT_V1 } from "../src/infrastructure/tree-formats/v1.ts";

const roots: string[] = [];
const CURRENT_METADATA_SCHEMA_VERSION = CURRENT_METADATA_VERSION.version;
const SUCCESSOR_METADATA_VERSION = CURRENT_METADATA_SCHEMA_VERSION + 1;
const SYNTHETIC_SUCCESSOR_TREE_FORMAT = "cyclotomy-tree-successor-test";

function createPublishedV1(db: DatabaseSync, treeOid?: string): void {
  db.exec(`
    ${NODE_STATE_V1_SCHEMA_SQL};
    ${SESSION_REGISTRY_V1_SCHEMA_SQL};
    ${SESSION_REGISTRY_MISSING_V1_INDEX_SQL};
    PRAGMA user_version = 1;
  `);
  if (treeOid !== undefined) {
    db.prepare(
      `INSERT INTO node_state(session_id, entry_id, tree_oid)
       VALUES ('session', 'entry', ?)`,
    ).run(treeOid);
  }
}

function syntheticSuccessorSchema() {
  const protocol = SUCCESSOR_METADATA_VERSION;
  const tables = CURRENT_METADATA_VERSION.schema.fencedTables;
  const objects = Object.fromEntries(
    Object.entries(CURRENT_METADATA_VERSION.schema.objects)
      .filter(([, object]) => object.type !== "trigger")
      .map(([name, object]) => [
        name,
        schemaObject(object.type, object.table, object.sql),
      ]),
  );
  return metadataSchemaSpec({
    version: SUCCESSOR_METADATA_VERSION,
    errorLabel: "synthetic successor layout",
    objects: { ...objects, ...writerFenceSchemaObjects(tables, protocol) },
    fencedTables: tables,
    writerProtocol: protocol,
    ...(CURRENT_METADATA_VERSION.schema.validateTableShape === undefined
      ? {}
      : {
          validateTableShape:
            CURRENT_METADATA_VERSION.schema.validateTableShape,
        }),
  });
}

function initializeSyntheticSuccessor(db: DatabaseSync): void {
  CURRENT_METADATA_VERSION.initializeWithinTransaction(db);
  dropWriterFences(db, CURRENT_METADATA_VERSION.schema);
  db.exec(
    writerFenceSql(
      CURRENT_METADATA_VERSION.schema.fencedTables,
      SUCCESSOR_METADATA_VERSION,
    ).join(";\n"),
  );
  db.exec(`PRAGMA user_version = ${SUCCESSOR_METADATA_VERSION}`);
}

function syntheticSuccessor(
  apply: (db: DatabaseSync) => void,
): MetadataVersionNode {
  const tables = CURRENT_METADATA_VERSION.schema.fencedTables;
  return defineMetadataVersion({
    version: SUCCESSOR_METADATA_VERSION,
    treeFormat: CURRENT_METADATA_VERSION.treeFormat,
    schema: syntheticSuccessorSchema(),
    previous: CURRENT_METADATA_VERSION,
    upgradeFromPrevious: defineSynchronousMetadataUpgrade((db) => {
      db.exec(writerFenceSql(tables, SUCCESSOR_METADATA_VERSION).join(";\n"));
      apply(db);
    }),
    initializeWithinTransaction: initializeSyntheticSuccessor,
    referencedTreeOids: CURRENT_METADATA_VERSION.referencedTreeOids,
    matchSessionIdentity: CURRENT_METADATA_VERSION.matchSessionIdentity,
  });
}

function syntheticTreeFormatSuccessor(
  replaceRoots: (
    db: DatabaseSync,
    prepared: PreparedMetadataTreeUpgrade,
  ) => void = (db, prepared) => {
    const update = db.prepare(
      "UPDATE checkpoint_slot SET tree_oid = ? WHERE tree_oid = ?",
    );
    for (const { source, target } of prepared.replacements) {
      update.run(target, source);
    }
  },
): MetadataVersionNode {
  const tables = CURRENT_METADATA_VERSION.schema.fencedTables;
  return defineMetadataVersion({
    version: SUCCESSOR_METADATA_VERSION,
    treeFormat: SYNTHETIC_SUCCESSOR_TREE_FORMAT,
    schema: syntheticSuccessorSchema(),
    previous: CURRENT_METADATA_VERSION,
    upgradeFromPrevious: defineTreeFormatMetadataUpgrade((db, prepared) => {
      db.exec(writerFenceSql(tables, SUCCESSOR_METADATA_VERSION).join(";\n"));
      replaceRoots(db, prepared);
    }),
    initializeWithinTransaction: initializeSyntheticSuccessor,
    referencedTreeOids: CURRENT_METADATA_VERSION.referencedTreeOids,
    matchSessionIdentity: CURRENT_METADATA_VERSION.matchSessionIdentity,
  });
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("metadata adjacent-version chain", () => {
  it("does not encode a named or numeric legacy root in the chain engine", () => {
    const rootSchema = metadataSchemaSpec({
      version: 7,
      errorLabel: "synthetic root",
      objects: {},
      fencedTables: [],
    });
    const root = defineMetadataVersion({
      version: 7,
      treeFormat: "synthetic-tree-root",
      schema: rootSchema,
      initializeWithinTransaction: () => {},
      referencedTreeOids: () => [],
      matchSessionIdentity: () => "absent",
    });

    expect(root.previous).toBeUndefined();
  });

  it("rejects an unverified successor schema that reuses the old writer protocol", () => {
    expect(() =>
      defineMetadataVersion({
        version: SUCCESSOR_METADATA_VERSION,
        treeFormat: CURRENT_METADATA_VERSION.treeFormat,
        schema: Object.freeze({
          ...CURRENT_METADATA_VERSION.schema,
          version: SUCCESSOR_METADATA_VERSION,
        }),
        previous: CURRENT_METADATA_VERSION,
        upgradeFromPrevious: defineSynchronousMetadataUpgrade(() => {}),
        initializeWithinTransaction: () => {},
        referencedTreeOids: () => [],
        matchSessionIdentity: () => "absent",
      }),
    ).toThrow("metadata version and schema identity must agree");
  });

  it("rejects an extra writer fence outside the exact table-event matrix", () => {
    expect(() =>
      metadataSchemaSpec({
        version: SUCCESSOR_METADATA_VERSION,
        errorLabel: "bad synthetic layout",
        objects: {
          table: schemaObject("table", "table", "CREATE TABLE table(id TEXT)"),
          ...writerFenceSchemaObjects(["table"], SUCCESSOR_METADATA_VERSION),
          cyclotomy_writer_fence_extra_insert: schemaObject(
            "trigger",
            "table",
            "CREATE TRIGGER cyclotomy_writer_fence_extra_insert BEFORE INSERT ON table BEGIN SELECT 1; END",
          ),
        },
        fencedTables: ["table"],
        writerProtocol: SUCCESSOR_METADATA_VERSION,
      }),
    ).toThrow("unexpected writer fence");
  });

  it("requires a metadata successor edge when the durable tree format changes", () => {
    expect(() =>
      defineMetadataVersion({
        version: SUCCESSOR_METADATA_VERSION,
        treeFormat: SYNTHETIC_SUCCESSOR_TREE_FORMAT,
        schema: syntheticSuccessorSchema(),
        previous: CURRENT_METADATA_VERSION,
        upgradeFromPrevious: defineSynchronousMetadataUpgrade(() => {}),
        initializeWithinTransaction: initializeSyntheticSuccessor,
        referencedTreeOids: CURRENT_METADATA_VERSION.referencedTreeOids,
        matchSessionIdentity: CURRENT_METADATA_VERSION.matchSessionIdentity,
      }),
    ).toThrow(
      "tree-format change requires an externally prepared adjacent edge",
    );
  });

  it("rejects metadata history that names a tree format outside its chain", () => {
    const outside = defineMetadataVersion({
      version: SUCCESSOR_METADATA_VERSION,
      treeFormat: "outside-tree-history",
      schema: syntheticSuccessorSchema(),
      previous: CURRENT_METADATA_VERSION,
      upgradeFromPrevious: defineTreeFormatMetadataUpgrade(() => {}),
      initializeWithinTransaction: initializeSyntheticSuccessor,
      referencedTreeOids: CURRENT_METADATA_VERSION.referencedTreeOids,
      matchSessionIdentity: CURRENT_METADATA_VERSION.matchSessionIdentity,
    });

    expect(() =>
      validateMetadataTreeFormatComposition(outside, CURRENT_TREE_FORMAT),
    ).toThrow("outside the supported history");
  });

  it("rejects metadata history that moves its tree format backwards", () => {
    const backwards = defineMetadataVersion({
      version: SUCCESSOR_METADATA_VERSION,
      treeFormat: TREE_MANIFEST_FORMAT_V1,
      schema: syntheticSuccessorSchema(),
      previous: CURRENT_METADATA_VERSION,
      upgradeFromPrevious: defineTreeFormatMetadataUpgrade(() => {}),
      initializeWithinTransaction: initializeSyntheticSuccessor,
      referencedTreeOids: CURRENT_METADATA_VERSION.referencedTreeOids,
      matchSessionIdentity: CURRENT_METADATA_VERSION.matchSessionIdentity,
    });

    expect(() =>
      validateMetadataTreeFormatComposition(backwards, CURRENT_TREE_FORMAT),
    ).toThrow("moves its durable tree format backwards");
  });

  it("initializes EMPTY directly at current without invoking an upgrade", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-chain-empty-"));
    roots.push(root);
    const prepareTreeOidUpgrades = vi.fn(() => {
      throw new Error("EMPTY must not traverse a published version edge");
    });

    const store = await openCurrentMetadataStore(join(root, "state.db"), {
      prepareTreeOidUpgrades,
    });
    expect(prepareTreeOidUpgrades).not.toHaveBeenCalled();
    store.close();

    const db = new DatabaseSync(join(root, "state.db"), { readOnly: true });
    expect(
      Number(
        (db.prepare("PRAGMA user_version").get() as { user_version: number })
          .user_version,
      ),
    ).toBe(CURRENT_METADATA_SCHEMA_VERSION);
    validateMetadataVersion(db, CURRENT_METADATA_VERSION);
    db.close();
  });

  it("lets the v1-to-v2 edge prepare and atomically retarget tree roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-chain-v1-"));
    roots.push(root);
    const path = join(root, "state.db");
    const oldTreeOid = "a".repeat(64);
    const newTreeOid = "b".repeat(64);
    const legacy = new DatabaseSync(path);
    createPublishedV1(legacy, oldTreeOid);
    legacy.close();
    const prepareTreeOidUpgrades = vi.fn(
      async (treeOids: readonly string[], targetFormat: string) => {
        expect(treeOids).toEqual([oldTreeOid]);
        expect(targetFormat).toBe(TREE_MANIFEST_FORMAT_V2);
        return new Map([[oldTreeOid, newTreeOid]]);
      },
    );

    const store: CurrentMetadataStore = await openCurrentMetadataStore(path, {
      prepareTreeOidUpgrades,
    });
    expect(prepareTreeOidUpgrades).toHaveBeenCalledTimes(1);
    expect(store.getCheckpointSlot("session", "entry")).toEqual({
      kind: "open-checkpoint",
      treeOid: newTreeOid,
    });
    store.close();
  });

  it("does not advance or rewrite roots when external edge preparation fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-chain-prepare-fail-"));
    roots.push(root);
    const path = join(root, "state.db");
    const treeOid = "f".repeat(64);
    const legacy = new DatabaseSync(path);
    createPublishedV1(legacy, treeOid);
    legacy.close();

    await expect(
      openCurrentMetadataStore(path, {
        prepareTreeOidUpgrades: async () => {
          throw new Error("tree upgrade unavailable");
        },
      }),
    ).rejects.toThrow("tree upgrade unavailable");

    const check = new DatabaseSync(path, { readOnly: true });
    expect(
      Number(
        (check.prepare("PRAGMA user_version").get() as { user_version: number })
          .user_version,
      ),
    ).toBe(1);
    expect(check.prepare("SELECT tree_oid FROM node_state").get()).toEqual({
      tree_oid: treeOid,
    });
    check.close();
  });

  it("exposes the shared lineage law through one current-store read snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-chain-lineage-"));
    roots.push(root);
    const store = await openCurrentMetadataStore(join(root, "state.db"), {
      prepareTreeOidUpgrades: async () => new Map(),
    });
    const identity = {
      sessionId: "session",
      sessionFile: "/sessions/session.jsonl",
    };
    store.finalizeSessionProjection({
      targetSessionId: identity.sessionId,
      targetSessionFile: identity.sessionFile,
      retainedEntryIds: ["root"],
      activeAncestryEntryIds: ["root"],
      seed: { kind: "fresh" },
    });
    const treeOid = "e".repeat(64);
    expect(
      store.commitCapture({
        identity,
        entryId: "root",
        activeAncestryEntryIds: ["root"],
        treeOid,
        expectedSlot: { kind: "open-missing" },
      }),
    ).toBe("committed");

    expect(
      store.resolveLineage(identity.sessionId, ["root", "middle"]),
    ).toEqual({
      resolution: { kind: "checkpoint", entryId: "root", treeOid },
      targetSlot: { kind: "open-missing" },
    });
    store.protectLocation({
      identity,
      entryId: "target",
      activeAncestryEntryIds: ["target"],
      expectation: { kind: "any-current" },
    });
    expect(
      store.resolveLineage(identity.sessionId, ["root", "target"]),
    ).toEqual({
      resolution: { kind: "missing" },
      targetSlot: { kind: "blocked-missing" },
    });
    store.close();
  });

  it("keeps current metadata rooted in its tree format when a successor edge fails", async () => {
    const db = new DatabaseSync(":memory:");
    const oldTreeOid = "c".repeat(64);
    const v2TreeOid = "d".repeat(64);
    createPublishedV1(db, oldTreeOid);
    const successor = syntheticTreeFormatSuccessor();
    const prepareTreeOidUpgrades = vi.fn(
      async (treeOids: readonly string[], targetFormat: string) => {
        if (targetFormat === TREE_MANIFEST_FORMAT_V2) {
          expect(treeOids).toEqual([oldTreeOid]);
          return new Map([[oldTreeOid, v2TreeOid]]);
        }
        expect(targetFormat).toBe(SYNTHETIC_SUCCESSOR_TREE_FORMAT);
        expect(treeOids).toEqual([v2TreeOid]);
        throw new Error("synthetic successor tree upgrade unavailable");
      },
    );

    await expect(
      migrateMetadataToCurrent(db, { prepareTreeOidUpgrades }, successor),
    ).rejects.toThrow("synthetic successor tree upgrade unavailable");

    // Published adjacent edges reach the current schema first; the unavailable
    // successor must not leave current metadata pointing at future tree bytes.
    expect(
      Number(
        (db.prepare("PRAGMA user_version").get() as { user_version: number })
          .user_version,
      ),
    ).toBe(CURRENT_METADATA_SCHEMA_VERSION);
    validateMetadataVersion(db, CURRENT_METADATA_VERSION);
    expect(
      db
        .prepare(
          `SELECT tree_oid FROM checkpoint_slot
           WHERE session_id = 'session' AND entry_id = 'entry'`,
        )
        .get(),
    ).toEqual({ tree_oid: v2TreeOid });
    expect(prepareTreeOidUpgrades).toHaveBeenNthCalledWith(
      1,
      [oldTreeOid],
      TREE_MANIFEST_FORMAT_V2,
    );
    expect(prepareTreeOidUpgrades).toHaveBeenNthCalledWith(
      2,
      [v2TreeOid],
      SYNTHETIC_SUCCESSOR_TREE_FORMAT,
    );
    db.close();
  });

  it("reaches a synthetic successor without changing the migration engine", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("BEGIN IMMEDIATE");
    CURRENT_METADATA_VERSION.initializeWithinTransaction(db);
    db.exec("COMMIT");
    const successor = syntheticSuccessor(() => {});
    const prepareTreeOidUpgrades = vi.fn(async () => new Map());

    await migrateMetadataToCurrent(
      db,
      {
        prepareTreeOidUpgrades,
      },
      successor,
    );

    expect(prepareTreeOidUpgrades).not.toHaveBeenCalled();
    expect(
      Number(
        (db.prepare("PRAGMA user_version").get() as { user_version: number })
          .user_version,
      ),
    ).toBe(SUCCESSOR_METADATA_VERSION);
    validateMetadataVersion(db, successor);
    db.close();
  });

  it("lets a successor generation upgrade roots already stored by current metadata", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("BEGIN IMMEDIATE");
    CURRENT_METADATA_VERSION.initializeWithinTransaction(db);
    db.exec("COMMIT");
    db.function(
      METADATA_WRITER_PROTOCOL_FUNCTION,
      { deterministic: true, directOnly: false },
      () => CURRENT_METADATA_SCHEMA_VERSION,
    );
    const source = "8".repeat(64);
    const target = "9".repeat(64);
    db.prepare(
      `INSERT INTO checkpoint_slot(
         session_id, entry_id, tree_oid, capture_state
       ) VALUES ('session', 'entry', ?, 'open')`,
    ).run(source);
    db.function(
      METADATA_WRITER_PROTOCOL_FUNCTION,
      { deterministic: true, directOnly: false },
      () => SUCCESSOR_METADATA_VERSION,
    );
    const prepareTreeOidUpgrades = vi.fn(
      async () => new Map([[source, target]]),
    );

    await migrateMetadataToCurrent(
      db,
      { prepareTreeOidUpgrades },
      syntheticTreeFormatSuccessor(),
    );

    expect(prepareTreeOidUpgrades).toHaveBeenCalledWith(
      [source],
      SYNTHETIC_SUCCESSOR_TREE_FORMAT,
    );
    expect(db.prepare("SELECT tree_oid FROM checkpoint_slot").get()).toEqual({
      tree_oid: target,
    });
    db.close();
  });

  it("retries a future tree-format edge when its source root set drifts", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("BEGIN IMMEDIATE");
    CURRENT_METADATA_VERSION.initializeWithinTransaction(db);
    db.exec("COMMIT");
    db.function(
      METADATA_WRITER_PROTOCOL_FUNCTION,
      { deterministic: true, directOnly: false },
      () => CURRENT_METADATA_SCHEMA_VERSION,
    );
    const source = "1".repeat(64);
    const lateSource = "2".repeat(64);
    const target = "3".repeat(64);
    const lateTarget = "4".repeat(64);
    const insert = db.prepare(
      `INSERT INTO checkpoint_slot(
         session_id, entry_id, tree_oid, capture_state
       ) VALUES ('session', ?, ?, 'open')`,
    );
    insert.run("first", source);
    db.function(
      METADATA_WRITER_PROTOCOL_FUNCTION,
      { deterministic: true, directOnly: false },
      () => SUCCESSOR_METADATA_VERSION,
    );

    let preparation = 0;
    const prepareTreeOidUpgrades = vi.fn(
      async (treeOids: readonly string[], targetFormat: string) => {
        preparation += 1;
        expect(targetFormat).toBe(SYNTHETIC_SUCCESSOR_TREE_FORMAT);
        if (preparation === 1) {
          expect(treeOids).toEqual([source]);
          db.function(
            METADATA_WRITER_PROTOCOL_FUNCTION,
            { deterministic: true, directOnly: false },
            () => CURRENT_METADATA_SCHEMA_VERSION,
          );
          insert.run("late", lateSource);
          db.function(
            METADATA_WRITER_PROTOCOL_FUNCTION,
            { deterministic: true, directOnly: false },
            () => SUCCESSOR_METADATA_VERSION,
          );
          return new Map([[source, target]]);
        }
        expect(treeOids).toEqual([source, lateSource]);
        return new Map([
          [source, target],
          [lateSource, lateTarget],
        ]);
      },
    );

    await migrateMetadataToCurrent(
      db,
      { prepareTreeOidUpgrades },
      syntheticTreeFormatSuccessor(),
    );

    expect(prepareTreeOidUpgrades).toHaveBeenCalledTimes(2);
    expect(
      db
        .prepare(
          "SELECT entry_id, tree_oid FROM checkpoint_slot ORDER BY entry_id",
        )
        .all(),
    ).toEqual([
      { entry_id: "first", tree_oid: target },
      { entry_id: "late", tree_oid: lateTarget },
    ]);
    validateMetadataVersion(db, syntheticTreeFormatSuccessor());
    db.close();
  });

  it("bounds repeated tree-root drift without advancing the schema", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("BEGIN IMMEDIATE");
    CURRENT_METADATA_VERSION.initializeWithinTransaction(db);
    db.exec("COMMIT");
    db.function(
      METADATA_WRITER_PROTOCOL_FUNCTION,
      { deterministic: true, directOnly: false },
      () => CURRENT_METADATA_SCHEMA_VERSION,
    );
    const insert = db.prepare(
      `INSERT INTO checkpoint_slot(
         session_id, entry_id, tree_oid, capture_state
       ) VALUES ('session', ?, ?, 'open')`,
    );
    insert.run("initial", "0".repeat(64));
    db.function(
      METADATA_WRITER_PROTOCOL_FUNCTION,
      { deterministic: true, directOnly: false },
      () => SUCCESSOR_METADATA_VERSION,
    );

    let drift = 0;
    const prepareTreeOidUpgrades = vi.fn(
      async (treeOids: readonly string[]) => {
        drift += 1;
        db.function(
          METADATA_WRITER_PROTOCOL_FUNCTION,
          { deterministic: true, directOnly: false },
          () => CURRENT_METADATA_SCHEMA_VERSION,
        );
        insert.run(`late-${drift}`, drift.toString(16).repeat(64));
        db.function(
          METADATA_WRITER_PROTOCOL_FUNCTION,
          { deterministic: true, directOnly: false },
          () => SUCCESSOR_METADATA_VERSION,
        );
        return new Map(treeOids.map((treeOid) => [treeOid, treeOid]));
      },
    );

    await expect(
      migrateMetadataToCurrent(
        db,
        { prepareTreeOidUpgrades },
        syntheticTreeFormatSuccessor(),
      ),
    ).rejects.toThrow(
      "metadata tree roots kept changing during adjacent format migration",
    );

    expect(prepareTreeOidUpgrades).toHaveBeenCalledTimes(8);
    expect(
      Number(
        (db.prepare("PRAGMA user_version").get() as { user_version: number })
          .user_version,
      ),
    ).toBe(CURRENT_METADATA_SCHEMA_VERSION);
    validateMetadataVersion(db, CURRENT_METADATA_VERSION);
    db.close();
  });

  it("rejects a non-total tree-root map before starting its SQL cutover", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("BEGIN IMMEDIATE");
    CURRENT_METADATA_VERSION.initializeWithinTransaction(db);
    db.exec("COMMIT");
    db.function(
      METADATA_WRITER_PROTOCOL_FUNCTION,
      { deterministic: true, directOnly: false },
      () => CURRENT_METADATA_SCHEMA_VERSION,
    );
    const source = "5".repeat(64);
    db.prepare(
      `INSERT INTO checkpoint_slot(
         session_id, entry_id, tree_oid, capture_state
       ) VALUES ('session', 'entry', ?, 'open')`,
    ).run(source);
    db.function(
      METADATA_WRITER_PROTOCOL_FUNCTION,
      { deterministic: true, directOnly: false },
      () => SUCCESSOR_METADATA_VERSION,
    );

    await expect(
      migrateMetadataToCurrent(
        db,
        { prepareTreeOidUpgrades: async () => new Map() },
        syntheticTreeFormatSuccessor(),
      ),
    ).rejects.toThrow("did not return one result per metadata root");

    expect(
      Number(
        (db.prepare("PRAGMA user_version").get() as { user_version: number })
          .user_version,
      ),
    ).toBe(CURRENT_METADATA_SCHEMA_VERSION);
    expect(db.prepare("SELECT tree_oid FROM checkpoint_slot").get()).toEqual({
      tree_oid: source,
    });
    db.close();
  });

  it("rolls back an edge that does not publish its exact mapped root set", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("BEGIN IMMEDIATE");
    CURRENT_METADATA_VERSION.initializeWithinTransaction(db);
    db.exec("COMMIT");
    db.function(
      METADATA_WRITER_PROTOCOL_FUNCTION,
      { deterministic: true, directOnly: false },
      () => CURRENT_METADATA_SCHEMA_VERSION,
    );
    const source = "6".repeat(64);
    const target = "7".repeat(64);
    db.prepare(
      `INSERT INTO checkpoint_slot(
         session_id, entry_id, tree_oid, capture_state
       ) VALUES ('session', 'entry', ?, 'open')`,
    ).run(source);
    db.function(
      METADATA_WRITER_PROTOCOL_FUNCTION,
      { deterministic: true, directOnly: false },
      () => SUCCESSOR_METADATA_VERSION,
    );

    await expect(
      migrateMetadataToCurrent(
        db,
        {
          prepareTreeOidUpgrades: async () => new Map([[source, target]]),
        },
        syntheticTreeFormatSuccessor(() => {}),
      ),
    ).rejects.toThrow("did not preserve the exact mapped root set");

    expect(
      Number(
        (db.prepare("PRAGMA user_version").get() as { user_version: number })
          .user_version,
      ),
    ).toBe(CURRENT_METADATA_SCHEMA_VERSION);
    expect(db.prepare("SELECT tree_oid FROM checkpoint_slot").get()).toEqual({
      tree_oid: source,
    });
    validateMetadataVersion(db, CURRENT_METADATA_VERSION);
    db.close();
  });

  it("initializes a synthetic successor directly from EMPTY", async () => {
    const db = new DatabaseSync(":memory:");
    const prepareTreeOidUpgrades = vi.fn(async () => new Map());
    const successor = syntheticSuccessor(() => {});

    await migrateMetadataToCurrent(db, { prepareTreeOidUpgrades }, successor);

    expect(prepareTreeOidUpgrades).not.toHaveBeenCalled();
    validateMetadataVersion(db, successor);
    db.close();
  });

  it("fences a writer prepared by the previous metadata generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-chain-writer-fence-"));
    roots.push(root);
    const path = join(root, "state.db");
    const oldWriter = new DatabaseSync(path);
    oldWriter.exec("BEGIN IMMEDIATE");
    CURRENT_METADATA_VERSION.initializeWithinTransaction(oldWriter);
    oldWriter.exec("COMMIT");
    oldWriter.function(
      METADATA_WRITER_PROTOCOL_FUNCTION,
      { deterministic: true, directOnly: false },
      () => CURRENT_METADATA_SCHEMA_VERSION,
    );
    const staleInsert = oldWriter.prepare(
      `INSERT INTO session_registry(
         session_id, session_file, registration_state
       ) VALUES ('stale', '/stale.jsonl', 'verified')`,
    );

    const migrator = new DatabaseSync(path);
    migrator.function(
      METADATA_WRITER_PROTOCOL_FUNCTION,
      { deterministic: true, directOnly: false },
      () => SUCCESSOR_METADATA_VERSION,
    );
    await migrateMetadataToCurrent(
      migrator,
      { prepareTreeOidUpgrades: async () => new Map() },
      syntheticSuccessor(() => {}),
    );

    expect(() => staleInsert.run()).toThrow(/writer protocol mismatch/u);
    expect(
      migrator
        .prepare(
          `INSERT INTO session_registry(
             session_id, session_file, registration_state
           ) VALUES ('current', '/current.jsonl', 'verified')`,
        )
        .run().changes,
    ).toBe(1);
    oldWriter.close();
    migrator.close();
  });
});
