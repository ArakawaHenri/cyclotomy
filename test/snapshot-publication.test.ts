import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  openObjectStore,
  TREE_MANIFEST_FORMAT,
  type ObjectStore,
} from "../src/infrastructure/object-store.ts";
import {
  IncompleteSnapshotError,
  publishSnapshot,
} from "../src/infrastructure/snapshot-publication.ts";
import {
  scanWorkspace,
  type WorkspaceSnapshot,
} from "../src/infrastructure/workspace-scan.ts";
import { ALL_MANAGED_SCOPE, gitScope } from "./workspace-scope-fixture.ts";

const sha256 = (content: string): string =>
  createHash("sha256").update(content).digest("hex");

const scope = ALL_MANAGED_SCOPE;

const roots: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function scanTempWorkspace(): Promise<WorkspaceSnapshot> {
  const root = await tempRoot("cyclotomy-publish-workspace-");
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "main.ts"), "export {};\n");
  await writeFile(join(root, "run"), "#!/bin/sh\n");
  await chmod(join(root, "run"), 0o755);
  await symlink("src/main.ts", join(root, "pointer"));

  const snapshot = await scanWorkspace(root);
  expect(snapshot.problems).toEqual([]);
  return snapshot;
}

describe("snapshot publication", () => {
  it("allows an archived policy source that Git excluded from the managed tree", async () => {
    const store = await openObjectStore(
      await tempRoot("cyclotomy-publish-objects-"),
    );
    const workspace = await tempRoot("cyclotomy-publish-workspace-");
    const scanned = await scanWorkspace(workspace);
    const snapshot: WorkspaceSnapshot = {
      ...scanned,
      scope: gitScope({
        gitignoreSources: [
          {
            path: ".gitignore",
            contents: ".gitignore\nsecret\n",
          },
        ],
      }),
    };

    await expect(publishSnapshot(store, snapshot)).resolves.toMatch(
      /^[0-9a-f]{64}$/u,
    );
  });

  it("refuses scope policy whose .gitignore bytes differ from the entry", async () => {
    const store = await openObjectStore(
      await tempRoot("cyclotomy-publish-objects-"),
    );
    const workspace = await tempRoot("cyclotomy-publish-workspace-");
    await writeFile(join(workspace, ".gitignore"), "other\n");
    const scanned = await scanWorkspace(workspace);
    const inconsistent: WorkspaceSnapshot = {
      ...scanned,
      scope: gitScope({
        gitignoreSources: [{ path: ".gitignore", contents: "secret\n" }],
      }),
    };

    await expect(publishSnapshot(store, inconsistent)).rejects.toThrow(
      /does not match tree entry/,
    );
  });

  it("refuses to publish a snapshot with unresolved scan problems", async () => {
    const store = await openObjectStore(
      await tempRoot("cyclotomy-publish-objects-"),
    );
    const workspace = await tempRoot("cyclotomy-publish-workspace-");
    const scanned = await scanWorkspace(workspace);
    const incomplete: WorkspaceSnapshot = {
      ...scanned,
      entries: [],
      problems: [
        {
          path: "large.bin",
          kind: "too-large",
          detail: "size limit exceeded",
        },
      ],
      scope,
    };

    await expect(publishSnapshot(store, incomplete)).rejects.toMatchObject({
      name: "IncompleteSnapshotError",
      problems: incomplete.problems,
    });
    await expect(publishSnapshot(store, incomplete)).rejects.toThrow(
      IncompleteSnapshotError,
    );
  });

  it("publishes blobs and a tree that reads back with the same entries and bytes", async () => {
    const snapshot = await scanTempWorkspace();
    const store = await openObjectStore(
      await tempRoot("cyclotomy-publish-objects-"),
    );

    const treeOid = await publishSnapshot(store, snapshot);
    expect(treeOid).toMatch(/^[0-9a-f]{64}$/u);

    const manifest = await store.readTree(treeOid);
    expect(manifest.format).toBe(TREE_MANIFEST_FORMAT);
    expect(manifest.scope).toEqual(ALL_MANAGED_SCOPE);
    expect(manifest.entries).toEqual([
      {
        path: "pointer",
        type: "symlink",
        target: join("src", "main.ts"),
        symlinkKind: "file",
      },
      {
        path: "run",
        type: "regular",
        blobOid: sha256("#!/bin/sh\n"),
        recreationMode: process.platform === "win32" ? null : 0o755,
      },
      {
        path: "src/main.ts",
        type: "regular",
        blobOid: sha256("export {};\n"),
        recreationMode: process.platform === "win32" ? null : 0o644,
      },
    ]);
    expect(
      Buffer.from(await store.readBlob(sha256("export {};\n"))).toString(),
    ).toBe("export {};\n");
    expect(
      Buffer.from(await store.readBlob(sha256("#!/bin/sh\n"))).toString(),
    ).toBe("#!/bin/sh\n");
  });

  it("is idempotent: republishing the same snapshot returns the same tree oid", async () => {
    const snapshot = await scanTempWorkspace();
    const store = await openObjectStore(
      await tempRoot("cyclotomy-publish-objects-"),
    );

    const first = await publishSnapshot(store, snapshot);
    const second = await publishSnapshot(store, snapshot);
    expect(second).toBe(first);
    expect((await store.readTree(second)).entries).toEqual(
      (await store.readTree(first)).entries,
    );
  });

  it("does not immediately rehash the closure after publishing every blob", async () => {
    const snapshot = await scanTempWorkspace();
    const store = await openObjectStore(
      await tempRoot("cyclotomy-publish-objects-"),
    );
    const deepVerification = vi.spyOn(store, "verifyBlobs");

    const treeOid = await publishSnapshot(store, snapshot);

    expect(deepVerification).not.toHaveBeenCalled();
    await expect(store.readTreeManifest(treeOid)).resolves.toBeDefined();
  });

  it("publishes duplicate content once and reuses it without source files", async () => {
    const workspace = await tempRoot("cyclotomy-publish-dedup-");
    await writeFile(join(workspace, "one.txt"), "same bytes");
    await writeFile(join(workspace, "two.txt"), "same bytes");
    const snapshot = await scanWorkspace(workspace);
    const baseStore = await openObjectStore(
      await tempRoot("cyclotomy-publish-objects-"),
    );
    let streamedPublications = 0;
    const store: ObjectStore = {
      storageRoot: baseStore.storageRoot,
      beginSnapshotPublication() {
        const publication = baseStore.beginSnapshotPublication();
        return {
          publishBlobFromFile: async (path, oid, byteLength) => {
            streamedPublications += 1;
            return publication.publishBlobFromFile(path, oid, byteLength);
          },
          publishTree: (entries, scope) =>
            publication.publishTree(entries, scope),
        };
      },
      readBlob: (oid) => baseStore.readBlob(oid),
      readTree: (oid) => baseStore.readTree(oid),
      readTreeManifest: (oid) => baseStore.readTreeManifest(oid),
      verifyBlobs: (oids) => baseStore.verifyBlobs(oids),
    };

    const first = await publishSnapshot(store, snapshot);
    expect(streamedPublications).toBe(1);
    await rm(workspace, { recursive: true, force: true });

    const second = await publishSnapshot(store, snapshot);
    expect(second).toBe(first);
    expect(streamedPublications).toBe(2);
  });

  it("rejects a source file changed after its streamed scan", async () => {
    const workspace = await tempRoot("cyclotomy-publish-race-");
    const path = join(workspace, "changing.txt");
    await writeFile(path, "before");
    const snapshot = await scanWorkspace(workspace);
    await writeFile(path, "after!");
    const store = await openObjectStore(
      await tempRoot("cyclotomy-publish-objects-"),
    );

    await expect(publishSnapshot(store, snapshot)).rejects.toMatchObject({
      code: "invalid-blob",
    });
  });

  it("rejects a forged regular source outside the scanned path", async () => {
    const workspace = await tempRoot("cyclotomy-publish-workspace-");
    const outside = await tempRoot("cyclotomy-publish-outside-");
    await writeFile(join(workspace, "file.txt"), "same");
    await writeFile(join(outside, "file.txt"), "same");
    const scanned = await scanWorkspace(workspace);
    const regular = scanned.entries[0];
    expect(regular?.kind).toBe("regular");
    if (regular?.kind !== "regular") return;
    const forged: WorkspaceSnapshot = {
      ...scanned,
      entries: [{ ...regular, sourcePath: join(outside, "file.txt") }],
    };
    const store = await openObjectStore(
      await tempRoot("cyclotomy-publish-objects-"),
    );

    await expect(publishSnapshot(store, forged)).rejects.toThrow(
      /outside its scanned path/u,
    );
  });

  it("throws when the store returns a blob id that is not the content digest", async () => {
    const snapshot = await scanTempWorkspace();
    const store = await openObjectStore(
      await tempRoot("cyclotomy-publish-objects-"),
    );
    const broken: ObjectStore = {
      storageRoot: store.storageRoot,
      beginSnapshotPublication() {
        return {
          publishBlobFromFile: () => Promise.resolve("0".repeat(64)),
          publishTree: (entries, targetScope) =>
            store.beginSnapshotPublication().publishTree(entries, targetScope),
        };
      },
      readBlob: (oid) => store.readBlob(oid),
      readTree: (oid) => store.readTree(oid),
      readTreeManifest: (oid) => store.readTreeManifest(oid),
      verifyBlobs: (oids) => store.verifyBlobs(oids),
    };

    await expect(publishSnapshot(broken, snapshot)).rejects.toThrow(
      /does not match the scanned digest/,
    );
  });

  it("leaves duplicate path rejection to the store's canonical validation", async () => {
    const store = await openObjectStore(
      await tempRoot("cyclotomy-publish-objects-"),
    );
    const workspace = await tempRoot("cyclotomy-publish-workspace-");
    await writeFile(join(workspace, "dup"), "x");
    const scanned = await scanWorkspace(workspace);
    const entry = scanned.entries[0]!;
    const forged: WorkspaceSnapshot = {
      ...scanned,
      entries: [entry, entry],
    };

    await expect(publishSnapshot(store, forged)).rejects.toThrow(/duplicate/);
  });
});
