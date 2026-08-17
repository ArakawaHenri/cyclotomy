import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  TreeFormatUpgradeBlockedError,
  prepareTreeOidUpgrades,
} from "../src/application/tree-migration.ts";
import { openCurrentMetadataStore as openCurrentMetadataStoreWithLease } from "../src/infrastructure/metadata.ts";
import { checkpointState } from "./metadata-fixture.ts";
import {
  openObjectStore,
  upgradeStoredTree,
} from "../src/infrastructure/object-store.ts";
import { CURRENT_TREE_MANIFEST_FORMAT } from "../src/infrastructure/tree-formats/current.ts";
import { parseTreeManifest } from "../src/infrastructure/tree-formats/history.ts";
import { TREE_MANIFEST_FORMAT_V1 } from "../src/infrastructure/tree-formats/v1.ts";
import { TREE_MANIFEST_FORMAT_V2 } from "../src/infrastructure/tree-formats/v2.ts";
import { withWorkspaceLock } from "../src/infrastructure/workspace-lock.ts";

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
const compatibleV3TreeOid =
  "07932c7d17030c109a7d199af9a7a972153597341b1cc66c11c379d88d6d52fa";

function openCurrentMetadataStore(
  path: string,
  dependencies: Parameters<typeof openCurrentMetadataStoreWithLease>[1],
): ReturnType<typeof openCurrentMetadataStoreWithLease> {
  return withWorkspaceLock(dirname(path), "tree migration test", (lease) =>
    openCurrentMetadataStoreWithLease(path, dependencies, lease),
  );
}

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

  it("migrates published-v1 paths against the absolute format contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-tree-v1-scope-"));
    roots.push(root);
    const store = await openObjectStore(root);
    await installFixture(
      root,
      "incompatible-scope-prefix",
      expected.incompatibleScopePrefix,
    );

    const legacy = parseTreeManifest(
      await readFile(join(fixtureRoot, "incompatible-scope-prefix.tree")),
    );
    expect(legacy.format).toBe(TREE_MANIFEST_FORMAT_V1);
    expect(legacy.scope).toMatchObject({
      kind: "git",
      repositoryPrefix: Array(257).fill("a").join("/"),
      evaluator: null,
    });
    const result = await upgradeStoredTree(
      store,
      expected.incompatibleScopePrefix.treeOid,
      CURRENT_TREE_MANIFEST_FORMAT,
    );
    expect(result).toMatchObject({
      kind: "upgraded",
      sourceTreeOid: expected.incompatibleScopePrefix.treeOid,
    });
    if (result.kind !== "upgraded") {
      throw new Error("expected the published v1 path to remain migratable");
    }
    await expect(store.readTree(result.treeOid)).resolves.toMatchObject({
      format: CURRENT_TREE_MANIFEST_FORMAT,
      scope: {
        kind: "git",
        repositoryPrefix: Array(257).fill("a").join("/"),
        evaluator: null,
      },
    });
  });

  it("does not apply current capture limits to durable tree migration", async () => {
    const baselineRoot = await mkdtemp(
      join(tmpdir(), "cyclotomy-tree-v1-baseline-"),
    );
    const limitedRoot = await mkdtemp(
      join(tmpdir(), "cyclotomy-tree-v1-limit-"),
    );
    roots.push(baselineRoot, limitedRoot);
    const baselineStore = await openObjectStore(baselineRoot);
    const limitedStore = await openObjectStore(limitedRoot, {
      maxPathBytes: 1,
      maxPathComponents: 1,
    });
    await Promise.all([
      installFixture(
        baselineRoot,
        "incompatible-scope-prefix",
        expected.incompatibleScopePrefix,
      ),
      installFixture(
        limitedRoot,
        "incompatible-scope-prefix",
        expected.incompatibleScopePrefix,
      ),
    ]);

    const [baseline, limited] = await Promise.all([
      upgradeStoredTree(
        baselineStore,
        expected.incompatibleScopePrefix.treeOid,
        CURRENT_TREE_MANIFEST_FORMAT,
      ),
      upgradeStoredTree(
        limitedStore,
        expected.incompatibleScopePrefix.treeOid,
        CURRENT_TREE_MANIFEST_FORMAT,
      ),
    ]);
    expect(baseline).toMatchObject({ kind: "upgraded" });
    expect(limited).toMatchObject({ kind: "upgraded" });
    if (baseline.kind !== "upgraded" || limited.kind !== "upgraded") {
      throw new Error("expected capture limits not to affect tree migration");
    }
    expect(limited.treeOid).toBe(baseline.treeOid);
    await expect(limitedStore.readTree(limited.treeOid)).resolves.toMatchObject(
      {
        format: CURRENT_TREE_MANIFEST_FORMAT,
        scope: {
          kind: "git",
          repositoryPrefix: Array(257).fill("a").join("/"),
          evaluator: null,
        },
      },
    );
  });

  it("publishes adjacent generations before atomically retargeting shared v1 roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-tree-migration-"));
    roots.push(root);
    const store = await openObjectStore(root);
    await installFixture(root, "compatible", expected.compatible);
    const metadataPath = join(root, "state.db");
    openPublishedV1Metadata(metadataPath, [
      { entryId: "one", treeOid: expected.compatible.treeOid },
      { entryId: "two", treeOid: expected.compatible.treeOid },
    ]);
    const metadata = await openCurrentMetadataStore(metadataPath, {
      prepareTreeOidUpgrades: (treeOids, targetFormat) =>
        prepareTreeOidUpgrades(store, treeOids, targetFormat),
    });
    expect(checkpointState(metadata, "legacy", "one")?.treeOid).toBe(
      compatibleV3TreeOid,
    );
    expect(checkpointState(metadata, "legacy", "two")?.treeOid).toBe(
      compatibleV3TreeOid,
    );
    await expect(
      store.readTree(expected.compatible.treeOid),
    ).rejects.toMatchObject({ code: "object-integrity" });
    const migratedV2 = parseTreeManifest(
      await readFile(
        objectPath(root, "trees", expected.compatible.migratedTreeOid!),
      ),
    );
    expect(migratedV2.format).toBe(TREE_MANIFEST_FORMAT_V2);
    const migrated = await store.readTree(compatibleV3TreeOid);
    expect(migrated.format).toBe(CURRENT_TREE_MANIFEST_FORMAT);
    const legacy = parseTreeManifest(
      await readFile(join(fixtureRoot, "compatible.tree")),
    );
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
          .replace(TREE_MANIFEST_FORMAT_V1, TREE_MANIFEST_FORMAT_V2),
      ),
    );

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
    await expect(
      openCurrentMetadataStore(metadataPath, {
        prepareTreeOidUpgrades: (treeOids, targetFormat) =>
          prepareTreeOidUpgrades(store, treeOids, targetFormat),
      }),
    ).rejects.toBeInstanceOf(TreeFormatUpgradeBlockedError);
    await expect(
      store.readTree(expected.incompatibleGitignore.treeOid),
    ).rejects.toMatchObject({ code: "object-integrity" });
    expect(
      digest(
        await readFile(
          objectPath(root, "trees", expected.incompatibleGitignore.treeOid),
        ),
      ),
    ).toBe(expected.incompatibleGitignore.treeOid);
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

  it("leaves v3 metadata at its authenticated v2 NUL root when v3 tree admission blocks", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-tree-nul-blocked-"));
    roots.push(root);
    const store = await openObjectStore(root);
    const treeBytes = Buffer.from(
      `${JSON.stringify({
        format: TREE_MANIFEST_FORMAT_V1,
        entries: [],
        scope: {
          kind: "git",
          repositoryPrefix: "",
          ignoreCase: false,
          gitignoreSources: [],
          infoExcludeBase64: "AA==",
          globalExcludeBase64: "",
        },
      })}\n`,
    );
    const treeOid = digest(treeBytes);
    const v2TreeBytes = Buffer.from(
      treeBytes
        .toString("utf8")
        .replace(TREE_MANIFEST_FORMAT_V1, TREE_MANIFEST_FORMAT_V2),
    );
    const v2TreeOid = digest(v2TreeBytes);
    const treePath = objectPath(root, "trees", treeOid);
    await mkdir(dirname(treePath), { recursive: true });
    await writeFile(treePath, treeBytes);
    const metadataPath = join(root, "state.db");
    openPublishedV1Metadata(metadataPath, [{ entryId: "nul", treeOid }]);

    await expect(
      openCurrentMetadataStore(metadataPath, {
        prepareTreeOidUpgrades: (treeOids, targetFormat) =>
          prepareTreeOidUpgrades(store, treeOids, targetFormat),
      }),
    ).rejects.toMatchObject({
      name: "TreeFormatUpgradeBlockedError",
      incompatibleTrees: [
        expect.objectContaining({
          treeOid: v2TreeOid,
          cause: expect.objectContaining({ kind: "format-incompatible" }),
        }),
      ],
    });

    const check = new DatabaseSync(metadataPath);
    expect(
      Number(
        (
          check.prepare("PRAGMA user_version").get() as {
            user_version: number;
          }
        ).user_version,
      ),
    ).toBe(3);
    expect(
      (
        check
          .prepare("SELECT tree_oid FROM checkpoint_slot WHERE entry_id = ?")
          .get("nul") as { readonly tree_oid: string }
      ).tree_oid,
    ).toBe(v2TreeOid);
    check.close();
    expect(await readFile(treePath)).toEqual(treeBytes);
    expect(await readFile(objectPath(root, "trees", v2TreeOid))).toEqual(
      v2TreeBytes,
    );
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
    await expect(
      openCurrentMetadataStore(metadataPath, {
        prepareTreeOidUpgrades: (treeOids, targetFormat) =>
          prepareTreeOidUpgrades(store, treeOids, targetFormat),
      }),
    ).rejects.toBeInstanceOf(TreeFormatUpgradeBlockedError);
    // Publishing is deliberately allowed before the SQL decision: on abort,
    // the v2 object is merely an unreferenced, content-addressed GC candidate.
    await expect(
      store.readTree(expected.compatible.migratedTreeOid!),
    ).rejects.toMatchObject({ code: "object-integrity" });
    expect(
      parseTreeManifest(
        await readFile(
          objectPath(root, "trees", expected.compatible.migratedTreeOid!),
        ),
      ).format,
    ).toBe(TREE_MANIFEST_FORMAT_V2);
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
