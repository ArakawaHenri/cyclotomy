import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  LegacyTreeMigrationBlockedError,
  migrateReferencedTrees,
} from "../src/application/tree-migration.ts";
import { MetadataStore } from "../src/infrastructure/metadata.ts";
import { openObjectStore } from "../src/infrastructure/object-store.ts";
import {
  PUBLISHED_TREE_MANIFEST_FORMAT,
  TREE_MANIFEST_FORMAT,
} from "../src/infrastructure/tree-manifest.ts";

interface FixtureObject {
  readonly blobBytes: number;
  readonly blobOid: string;
  readonly treeBytes: number;
  readonly treeOid: string;
  readonly migratedTreeOid?: string;
}

interface FixtureExpected {
  readonly provenance: {
    readonly npmShasum: string;
    readonly npmIntegrity: string;
    readonly gitHead: string;
    readonly treeManifestSourceSha256: string;
    readonly workspaceScopeSourceSha256: string;
  };
  readonly compatible: FixtureObject;
  readonly incompatibleGitignore: FixtureObject;
  readonly incompatibleScopePrefix: FixtureObject;
}

const fixtureRoot = fileURLToPath(
  new URL("./fixtures/cyclotomy-0.0.1-tree/", import.meta.url),
);
const expected = JSON.parse(
  await readFile(join(fixtureRoot, "expected.json"), "utf8"),
) as FixtureExpected;
const roots: string[] = [];

function digest(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function objectPath(
  root: string,
  kind: "blobs" | "trees",
  oid: string,
): string {
  return join(root, "objects", kind, oid.slice(0, 2), oid.slice(2));
}

async function installFixture(
  root: string,
  name: "compatible" | "incompatible-gitignore" | "incompatible-scope-prefix",
  object: FixtureObject,
): Promise<void> {
  const blob = await readFile(join(fixtureRoot, `${name}.blob`));
  const tree = await readFile(join(fixtureRoot, `${name}.tree`));
  expect(blob.byteLength).toBe(object.blobBytes);
  expect(tree.byteLength).toBe(object.treeBytes);
  expect(digest(blob)).toBe(object.blobOid);
  expect(digest(tree)).toBe(object.treeOid);
  for (const [kind, oid, bytes] of [
    ["blobs", object.blobOid, blob],
    ["trees", object.treeOid, tree],
  ] as const) {
    const path = objectPath(root, kind, oid);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { flag: "wx" });
  }
}

function openPublishedV1Metadata(
  path: string,
  states: readonly { readonly entryId: string; readonly treeOid: string }[],
): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE node_state(
      session_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      tree_oid TEXT NOT NULL,
      PRIMARY KEY(session_id, entry_id)
    ) STRICT, WITHOUT ROWID;

    CREATE TABLE session_registry(
      session_id TEXT NOT NULL PRIMARY KEY,
      session_file TEXT NOT NULL UNIQUE,
      missing_since INTEGER,
      missing_observed_at INTEGER
    ) STRICT, WITHOUT ROWID;

    CREATE INDEX session_registry_missing
    ON session_registry(missing_since, missing_observed_at);

    PRAGMA user_version = 1;
  `);
  const insert = db.prepare(
    "INSERT INTO node_state(session_id, entry_id, tree_oid) VALUES (?, ?, ?)",
  );
  for (const state of states) {
    insert.run("legacy", state.entryId, state.treeOid);
  }
  db.close();
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("published tree migration", () => {
  it("pins the raw npm 0.0.1 fixtures by byte length and object id", async () => {
    expect(expected.provenance).toEqual({
      npmShasum: "a6b62a4ca006bdd9ad9d49a208a78dec22eacefc",
      npmIntegrity:
        "sha512-Mf5ETfsOl3gC4fGb+i7/J5SjBkaBJxzWWT1tWzX5xMkwk1AaBvs4u9A2Ba0LXrwCKTJ+lSkcoV+go3YpiJxh7A==",
      gitHead: "1cc897c6f9ff30614393a2b6e88d8ef3739daf83",
      treeManifestSourceSha256:
        "5210d4ca7de2a005fb3841c5c0c7b82d42a922d7f648b4fc203b8922183d1b7a",
      workspaceScopeSourceSha256:
        "4017fca882620d0e03a5f59d07bcb638aea6151664b2453cb5b182a7057660a3",
    });
    for (const [name, object] of [
      ["compatible", expected.compatible],
      ["incompatible-gitignore", expected.incompatibleGitignore],
      ["incompatible-scope-prefix", expected.incompatibleScopePrefix],
    ] as const) {
      const blob = await readFile(join(fixtureRoot, `${name}.blob`));
      const tree = await readFile(join(fixtureRoot, `${name}.tree`));
      expect([blob.byteLength, digest(blob)]).toEqual([
        object.blobBytes,
        object.blobOid,
      ]);
      expect([tree.byteLength, digest(tree)]).toEqual([
        object.treeBytes,
        object.treeOid,
      ]);
    }
  });

  it("freezes the published-v1 scope grammar before applying v2 limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-tree-v1-scope-"));
    roots.push(root);
    const store = await openObjectStore(root);
    await installFixture(
      root,
      "incompatible-scope-prefix",
      expected.incompatibleScopePrefix,
    );

    const legacy = await store.readTree(
      expected.incompatibleScopePrefix.treeOid,
    );
    expect(legacy.format).toBe(PUBLISHED_TREE_MANIFEST_FORMAT);
    expect(legacy.scope).toMatchObject({
      kind: "git",
      repositoryPrefix: Array(257).fill("a").join("/"),
    });
    await expect(
      store.migrateLegacyTree(expected.incompatibleScopePrefix.treeOid),
    ).resolves.toMatchObject({
      kind: "legacy-incompatible",
      treeOid: expected.incompatibleScopePrefix.treeOid,
    });
  });

  it("uses configured path limits when migrating a published-v1 tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-tree-v1-limit-"));
    roots.push(root);
    const store = await openObjectStore(root, { maxPathComponents: 257 });
    await installFixture(
      root,
      "incompatible-scope-prefix",
      expected.incompatibleScopePrefix,
    );

    const result = await store.migrateLegacyTree(
      expected.incompatibleScopePrefix.treeOid,
    );
    expect(result).toMatchObject({
      kind: "migrated",
      oldTreeOid: expected.incompatibleScopePrefix.treeOid,
    });
    if (result.kind !== "migrated") {
      throw new Error("expected the raised component limit to allow migration");
    }
    await expect(store.readTree(result.treeOid)).resolves.toMatchObject({
      format: TREE_MANIFEST_FORMAT,
      scope: {
        kind: "git",
        repositoryPrefix: Array(257).fill("a").join("/"),
      },
    });
  });

  it("publishes v2 before atomically retargeting every shared v1 root", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-tree-migration-"));
    roots.push(root);
    const store = await openObjectStore(root);
    await installFixture(root, "compatible", expected.compatible);
    const metadataPath = join(root, "state.db");
    openPublishedV1Metadata(metadataPath, [
      { entryId: "one", treeOid: expected.compatible.treeOid },
      { entryId: "two", treeOid: expected.compatible.treeOid },
    ]);
    const metadata = new MetadataStore(metadataPath, {
      deferPublishedV1Migration: true,
    });

    const report = await migrateReferencedTrees(store, metadata);
    expect(report).toMatchObject({
      inspectedTrees: 1,
      currentTrees: 0,
      migratedTrees: 1,
      incompatibleTrees: [],
      replacedNodeStates: 2,
    });
    expect(metadata.isSchemaCurrent()).toBe(true);
    expect(metadata.getState("legacy", "one")?.treeOid).toBe(
      expected.compatible.migratedTreeOid,
    );
    expect(metadata.getState("legacy", "two")?.treeOid).toBe(
      expected.compatible.migratedTreeOid,
    );
    expect((await store.readTree(expected.compatible.treeOid)).format).toBe(
      PUBLISHED_TREE_MANIFEST_FORMAT,
    );
    const migrated = await store.readTree(expected.compatible.migratedTreeOid!);
    expect(migrated.format).toBe(TREE_MANIFEST_FORMAT);
    const legacy = await store.readTree(expected.compatible.treeOid);
    expect({ entries: migrated.entries, scope: migrated.scope }).toEqual({
      entries: legacy.entries,
      scope: legacy.scope,
    });
    const legacyBytes = await readFile(join(fixtureRoot, "compatible.tree"));
    const migratedBytes = await readFile(
      objectPath(root, "trees", expected.compatible.migratedTreeOid!),
    );
    expect(migratedBytes).toEqual(
      Buffer.from(
        legacyBytes
          .toString("utf8")
          .replace(PUBLISHED_TREE_MANIFEST_FORMAT, TREE_MANIFEST_FORMAT),
      ),
    );

    const second = await migrateReferencedTrees(store, metadata);
    expect(second).toMatchObject({
      inspectedTrees: 0,
      currentTrees: 0,
      migratedTrees: 0,
      incompatibleTrees: [],
      replacedNodeStates: 0,
    });
    metadata.close();
  });

  it("leaves SQL v1 and every old root untouched when migration is lossy", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-tree-blocked-"));
    roots.push(root);
    const store = await openObjectStore(root);
    await installFixture(
      root,
      "incompatible-gitignore",
      expected.incompatibleGitignore,
    );
    const metadataPath = join(root, "state.db");
    openPublishedV1Metadata(metadataPath, [
      {
        entryId: "blocked",
        treeOid: expected.incompatibleGitignore.treeOid,
      },
    ]);
    const metadata = new MetadataStore(metadataPath, {
      deferPublishedV1Migration: true,
    });

    await expect(
      migrateReferencedTrees(store, metadata),
    ).rejects.toBeInstanceOf(LegacyTreeMigrationBlockedError);
    expect(metadata.isSchemaCurrent()).toBe(false);
    expect(metadata.getState("legacy", "blocked")?.treeOid).toBe(
      expected.incompatibleGitignore.treeOid,
    );
    expect(
      (await store.readTree(expected.incompatibleGitignore.treeOid)).format,
    ).toBe(PUBLISHED_TREE_MANIFEST_FORMAT);
    metadata.close();

    const check = new DatabaseSync(metadataPath);
    expect(
      Number(
        (
          check.prepare("PRAGMA user_version").get() as {
            user_version: number;
          }
        ).user_version,
      ),
    ).toBe(1);
    check.close();
  });

  it("does not partially cut over a mixed compatible and incompatible v1 database", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-tree-mixed-v1-"));
    roots.push(root);
    const store = await openObjectStore(root);
    await installFixture(root, "compatible", expected.compatible);
    await installFixture(
      root,
      "incompatible-gitignore",
      expected.incompatibleGitignore,
    );
    const metadataPath = join(root, "state.db");
    openPublishedV1Metadata(metadataPath, [
      { entryId: "compatible", treeOid: expected.compatible.treeOid },
      {
        entryId: "blocked",
        treeOid: expected.incompatibleGitignore.treeOid,
      },
    ]);
    const metadata = new MetadataStore(metadataPath, {
      deferPublishedV1Migration: true,
    });

    await expect(
      migrateReferencedTrees(store, metadata),
    ).rejects.toBeInstanceOf(LegacyTreeMigrationBlockedError);
    expect(metadata.isSchemaCurrent()).toBe(false);
    expect(metadata.getState("legacy", "compatible")?.treeOid).toBe(
      expected.compatible.treeOid,
    );
    expect(metadata.getState("legacy", "blocked")?.treeOid).toBe(
      expected.incompatibleGitignore.treeOid,
    );
    // Publishing is deliberately allowed before the SQL decision: on abort,
    // the v2 object is merely an unreferenced, content-addressed GC candidate.
    await expect(
      store.readTree(expected.compatible.migratedTreeOid!),
    ).resolves.toMatchObject({ format: TREE_MANIFEST_FORMAT });
    metadata.close();

    const check = new DatabaseSync(metadataPath);
    expect(
      Number(
        (
          check.prepare("PRAGMA user_version").get() as {
            user_version: number;
          }
        ).user_version,
      ),
    ).toBe(1);
    check.close();
  });
});
