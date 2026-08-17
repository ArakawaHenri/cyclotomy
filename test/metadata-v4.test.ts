import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { validateMetadataTreeFormatComposition } from "../src/infrastructure/metadata/current.ts";
import { migrateMetadataToCurrent as migrateMetadataToCurrentWithAuthority } from "../src/infrastructure/metadata/migration-engine.ts";
import { withWorkspaceLock } from "../src/infrastructure/workspace-lock.ts";
import { METADATA_WRITER_PROTOCOL_FUNCTION } from "../src/infrastructure/metadata/schema.ts";
import { validateMetadataVersion } from "../src/infrastructure/metadata/version.ts";
import {
  V3_METADATA_VERSION,
  V3_METADATA_WRITER_PROTOCOL,
} from "../src/infrastructure/metadata/versions/v3.ts";
import {
  V4_METADATA_VERSION,
  V4_METADATA_WRITER_PROTOCOL,
} from "../src/infrastructure/metadata/versions/v4.ts";
import {
  TREE_FORMAT_V3,
  TREE_MANIFEST_FORMAT_V3,
} from "../src/infrastructure/tree-formats/v3.ts";

function initialize(db: DatabaseSync, version = V3_METADATA_VERSION): void {
  db.exec("BEGIN IMMEDIATE");
  version.initializeWithinTransaction(db);
  db.exec("COMMIT");
}

function writerProtocol(db: DatabaseSync, protocol: number): void {
  db.function(
    METADATA_WRITER_PROTOCOL_FUNCTION,
    { deterministic: true, directOnly: false },
    () => protocol,
  );
}

async function migrateTestMetadataToCurrent(
  db: DatabaseSync,
  dependencies: Parameters<typeof migrateMetadataToCurrentWithAuthority>[1],
  current: Parameters<typeof migrateMetadataToCurrentWithAuthority>[4],
): Promise<void> {
  const storeRoot = await mkdtemp(join(tmpdir(), "cyclotomy-v4-migration-"));
  try {
    await withWorkspaceLock(
      storeRoot,
      "metadata v4 migration test",
      (authority) =>
        migrateMetadataToCurrentWithAuthority(
          db,
          dependencies,
          authority,
          storeRoot,
          current,
        ),
    );
  } finally {
    await rm(storeRoot, { recursive: true, force: true });
  }
}

describe("metadata v4 tree-v3 generation", () => {
  it("composes as exactly one adjacent tree-format generation", () => {
    expect(V4_METADATA_VERSION.previous).toBe(V3_METADATA_VERSION);
    expect(V4_METADATA_VERSION.treeFormat).toBe(TREE_MANIFEST_FORMAT_V3);
    expect(V4_METADATA_VERSION.upgradeFromPrevious?.kind).toBe("tree-format");
    expect(() =>
      validateMetadataTreeFormatComposition(
        V4_METADATA_VERSION,
        TREE_FORMAT_V3,
      ),
    ).not.toThrow();
  });

  it("prepares each distinct v2 root and atomically retargets every slot", async () => {
    const db = new DatabaseSync(":memory:");
    initialize(db);
    writerProtocol(db, V3_METADATA_WRITER_PROTOCOL);
    const firstSource = "1".repeat(64);
    const secondSource = "2".repeat(64);
    const firstTarget = "a".repeat(64);
    const secondTarget = "b".repeat(64);
    const insert = db.prepare(
      `INSERT INTO checkpoint_slot(
         session_id, entry_id, tree_oid, capture_state
       ) VALUES ('session', ?, ?, 'open')`,
    );
    insert.run("first", firstSource);
    insert.run("same-root", firstSource);
    insert.run("second", secondSource);
    writerProtocol(db, V4_METADATA_WRITER_PROTOCOL);
    const prepareTreeOidUpgrades = vi.fn(
      async (roots: readonly string[], targetFormat: string) => {
        expect(roots).toEqual([firstSource, secondSource]);
        expect(targetFormat).toBe(TREE_MANIFEST_FORMAT_V3);
        return new Map([
          [firstSource, firstTarget],
          [secondSource, secondTarget],
        ]);
      },
    );

    await migrateTestMetadataToCurrent(
      db,
      { prepareTreeOidUpgrades },
      V4_METADATA_VERSION,
    );

    expect(prepareTreeOidUpgrades).toHaveBeenCalledTimes(1);
    expect(
      db
        .prepare(
          "SELECT entry_id, tree_oid FROM checkpoint_slot ORDER BY entry_id",
        )
        .all(),
    ).toEqual([
      { entry_id: "first", tree_oid: firstTarget },
      { entry_id: "same-root", tree_oid: firstTarget },
      { entry_id: "second", tree_oid: secondTarget },
    ]);
    validateMetadataVersion(db, V4_METADATA_VERSION);
    db.close();
  });

  it("leaves metadata v3 and all roots unchanged when DAG preparation fails", async () => {
    const db = new DatabaseSync(":memory:");
    initialize(db);
    writerProtocol(db, V3_METADATA_WRITER_PROTOCOL);
    const source = "3".repeat(64);
    db.prepare(
      `INSERT INTO checkpoint_slot(
         session_id, entry_id, tree_oid, capture_state
       ) VALUES ('session', 'entry', ?, 'open')`,
    ).run(source);
    writerProtocol(db, V4_METADATA_WRITER_PROTOCOL);

    await expect(
      migrateTestMetadataToCurrent(
        db,
        {
          prepareTreeOidUpgrades: async () => {
            throw new Error("v3 graph publication failed");
          },
        },
        V4_METADATA_VERSION,
      ),
    ).rejects.toThrow("v3 graph publication failed");

    validateMetadataVersion(db, V3_METADATA_VERSION);
    expect(db.prepare("SELECT tree_oid FROM checkpoint_slot").get()).toEqual({
      tree_oid: source,
    });
    db.close();
  });

  it("initializes an empty database directly with the v4 writer fence", async () => {
    const db = new DatabaseSync(":memory:");
    const prepareTreeOidUpgrades = vi.fn(async () => new Map());

    await migrateTestMetadataToCurrent(
      db,
      { prepareTreeOidUpgrades },
      V4_METADATA_VERSION,
    );

    expect(prepareTreeOidUpgrades).not.toHaveBeenCalled();
    validateMetadataVersion(db, V4_METADATA_VERSION);
    writerProtocol(db, V3_METADATA_WRITER_PROTOCOL);
    expect(() =>
      db
        .prepare(
          `INSERT INTO session_registry(
             session_id, session_file, registration_state
           ) VALUES ('stale', '/stale.jsonl', 'verified')`,
        )
        .run(),
    ).toThrow(/writer protocol mismatch/u);
    writerProtocol(db, V4_METADATA_WRITER_PROTOCOL);
    expect(
      db
        .prepare(
          `INSERT INTO session_registry(
             session_id, session_file, registration_state
           ) VALUES ('current', '/current.jsonl', 'verified')`,
        )
        .run().changes,
    ).toBe(1);
    db.close();
  });
});
