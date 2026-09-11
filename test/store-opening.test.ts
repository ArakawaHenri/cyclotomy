import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  openCurrentMetadataStore,
  openExistingMetadataStore,
} from "../src/infrastructure/metadata.ts";
import { MetadataUnavailableError } from "../src/infrastructure/metadata-error.ts";
import { withWorkspaceLock } from "../src/infrastructure/workspace-lock.ts";
import { METADATA_WRITER_PROTOCOL_FUNCTION } from "../src/infrastructure/metadata/schema.ts";
import { V4_METADATA_VERSION } from "../src/infrastructure/metadata/versions/v4.ts";

const roots: string[] = [];
async function root() {
  const path = await mkdtemp(join(tmpdir(), "cyclotomy-opening-"));
  roots.push(path);
  return path;
}
const dependencies = {
  prepareTreeOidUpgrades: async () => {
    throw new Error("unexpected tree migration");
  },
};
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("store opening", () => {
  it("initializes an empty layout and resumes an interrupted empty database", async () => {
    for (const interrupted of [false, true]) {
      const path = await root();
      await mkdir(join(path, "objects", "packs", "incoming"), {
        recursive: true,
      });
      if (interrupted) await writeFile(join(path, "state.db"), "");
      await withWorkspaceLock(path, "open", async (authority) => {
        const store = await openCurrentMetadataStore(
          join(path, "state.db"),
          dependencies,
          authority,
        );
        expect(store.listReferencedTreeOids()).toEqual([]);
        store.close();
      });
    }
  });

  it.each(["missing", "empty"])(
    "preserves existing objects when metadata is %s",
    async (kind) => {
      const path = await root();
      const object = join(path, "objects", "blobs", "aa", "saved");
      await mkdir(join(path, "objects", "blobs", "aa"), { recursive: true });
      await writeFile(object, "checkpoint data");
      if (kind === "empty") await writeFile(join(path, "state.db"), "");
      for (const open of [
        openCurrentMetadataStore,
        openExistingMetadataStore,
      ]) {
        await expect(
          withWorkspaceLock(path, "open", async (authority) => {
            const store = await open(
              join(path, "state.db"),
              dependencies,
              authority,
            );
            store.close();
          }),
        ).rejects.toBeInstanceOf(MetadataUnavailableError);
      }
      expect(await readFile(object, "utf8")).toBe("checkpoint data");
      if (kind === "missing")
        expect(await readdir(path)).not.toContain("state.db");
      else expect(await readFile(join(path, "state.db"))).toHaveLength(0);
    },
  );

  it("never initializes metadata for maintenance", async () => {
    const path = await root();
    await expect(
      withWorkspaceLock(path, "gc", (authority) =>
        openExistingMetadataStore(
          join(path, "state.db"),
          dependencies,
          authority,
        ),
      ),
    ).rejects.toBeInstanceOf(MetadataUnavailableError);
    expect(await readdir(path)).not.toContain("state.db");
  });

  it.each(["wal", "journal"])(
    "lets SQLite recover a valid %s before migration",
    async (kind) => {
      const source = await root();
      const target = await root();
      const sourcePath = join(source, "state.db");
      const db = new DatabaseSync(sourcePath);
      db.function(
        METADATA_WRITER_PROTOCOL_FUNCTION,
        { deterministic: true, directOnly: false },
        () => 4,
      );
      if (kind === "wal") db.exec("PRAGMA journal_mode=WAL");
      V4_METADATA_VERSION.initializeWithinTransaction(db);
      db.prepare(
        "INSERT INTO session_registry VALUES ('saved', '/saved.jsonl', 'verified')",
      ).run();
      if (kind === "wal") {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        db.prepare(
          "INSERT INTO session_registry VALUES ('committed', '/committed.jsonl', 'verified')",
        ).run();
      } else {
        db.exec("PRAGMA cache_size=1; BEGIN IMMEDIATE");
        for (let i = 0; i < 10; i++)
          db.prepare(
            "INSERT INTO session_registry VALUES (?, ?, 'verified')",
          ).run(`uncommitted-${i}`, `${i}/${"x".repeat(20_000)}`);
      }
      // This sole writer remains idle while the coherent file set is copied.
      await copyFile(sourcePath, join(target, "state.db"));
      await copyFile(`${sourcePath}-${kind}`, join(target, `state.db-${kind}`));
      if (kind === "journal") db.exec("ROLLBACK");
      db.close();
      await withWorkspaceLock(target, "open", async (authority) => {
        const store = await openExistingMetadataStore(
          join(target, "state.db"),
          dependencies,
          authority,
        );
        expect(store.describeSessionHistory("saved")).toBeDefined();
        expect(store.describeSessionHistory("committed") !== undefined).toBe(
          kind === "wal",
        );
        expect(store.describeSessionHistory("uncommitted-0")).toBeUndefined();
        store.close();
      });
    },
  );
});
