import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  openObjectStore,
  type ObjectStore,
} from "../src/infrastructure/object-store.ts";
import { ContentRepository } from "../src/infrastructure/content-store/repository.ts";
import { CURRENT_TREE_MANIFEST_FORMAT } from "../src/infrastructure/tree-formats/current.ts";
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
  vi.restoreAllMocks();
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
  it("rejects unattested or mismatched Git capture before opening publication", async () => {
    const scanned = await scanWorkspace(
      await tempRoot("cyclotomy-publish-evaluator-workspace-"),
    );
    const store = await openObjectStore(
      await tempRoot("cyclotomy-publish-evaluator-objects-"),
    );
    const begin = vi.spyOn(store, "beginSnapshotPublication");

    await expect(
      publishSnapshot(store, {
        ...scanned,
        gitOracleVersion: "git version fixture",
        scope: gitScope({ evaluator: null }),
      }),
    ).rejects.toThrow("legacy-unknown evaluator provenance");
    await expect(
      publishSnapshot(store, {
        ...scanned,
        gitOracleVersion: "git version changed",
        scope: gitScope(),
      }),
    ).rejects.toThrow("does not match its workspace observation");
    expect(begin).not.toHaveBeenCalled();
  });

  it("does not let a direct snapshot publication create unattested v3", async () => {
    const store = await openObjectStore(
      await tempRoot("cyclotomy-publish-evaluator-direct-"),
    );
    const publication = store.beginSnapshotPublication();

    await expect(
      Promise.resolve().then(() =>
        publication.publishTree([], gitScope({ evaluator: null })),
      ),
    ).rejects.toMatchObject({ code: "invalid-tree-manifest" });
    await publication.close();
  });

  it("preserves both a tree failure and resolution cleanup failure", async () => {
    const store = await openObjectStore(
      await tempRoot("cyclotomy-publish-cleanup-"),
    );
    const cleanupFailure = new Error("resolution cleanup failed");
    vi.spyOn(
      ContentRepository.prototype,
      "closeResolutionScope",
    ).mockRejectedValue(cleanupFailure);
    const publication = store.beginSnapshotPublication();
    let observed: unknown;
    try {
      await publication.publishTree(
        [
          {
            path: "missing.txt",
            type: "regular",
            blobOid: "00".repeat(32),
            recreationMode: 0o644,
          },
        ],
        scope,
      );
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(AggregateError);
    const failures = (observed as AggregateError).errors;
    expect(failures[0]).toMatchObject({ code: "invalid-tree-manifest" });
    expect(failures[1]).toBe(cleanupFailure);
  });

  it("reports native tree and cleanup failures once through publishSnapshot", async () => {
    const snapshot = await scanWorkspace(
      await tempRoot("cyclotomy-publish-native-cleanup-workspace-"),
    );
    const store = await openObjectStore(
      await tempRoot("cyclotomy-publish-native-cleanup-objects-"),
    );
    const primary = new Error("tree publication failed");
    const cleanup = new Error("resolution cleanup failed");
    vi.spyOn(
      ContentRepository.prototype,
      "publishStructural",
    ).mockRejectedValue(primary);
    vi.spyOn(
      ContentRepository.prototype,
      "closeResolutionScope",
    ).mockRejectedValue(cleanup);

    let observed: unknown;
    try {
      await publishSnapshot(store, snapshot);
    } catch (error) {
      observed = error;
    }

    expect(observed).toBeInstanceOf(AggregateError);
    const failures = (observed as AggregateError).errors;
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatchObject({
      code: "storage-failure",
      cause: primary,
    });
    expect(failures[1]).toBe(cleanup);
  });

  it("does not mistake a thrown undefined value for publication success", async () => {
    const snapshot = await scanWorkspace(
      await tempRoot("cyclotomy-publish-undefined-"),
    );
    const cleanupFailure = new Error("outer cleanup failed");
    const base = await openObjectStore(
      await tempRoot("cyclotomy-publish-undefined-objects-"),
    );
    const store: ObjectStore = {
      storageRoot: base.storageRoot,
      beginSnapshotPublication: () => ({
        publishBlobFromFile: async () => "00".repeat(32),
        publishTree: () => Promise.reject(undefined),
        close: () => Promise.reject(cleanupFailure),
      }),
      readBlob: (oid) => base.readBlob(oid),
      streamBlob: (oid, sink) => base.streamBlob(oid, sink),
      readTree: (oid) => base.readTree(oid),
      readTreeManifest: (oid) => base.readTreeManifest(oid),
      verifyBlobs: (oids) => base.verifyBlobs(oids),
    };

    let observed: unknown;
    try {
      await publishSnapshot(store, snapshot);
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(AggregateError);
    expect((observed as AggregateError).errors).toEqual([
      undefined,
      cleanupFailure,
    ]);
  });

  it("allows an archived policy source that Git excluded from the managed tree", async () => {
    const store = await openObjectStore(
      await tempRoot("cyclotomy-publish-objects-"),
    );
    const workspace = await tempRoot("cyclotomy-publish-workspace-");
    const scanned = await scanWorkspace(workspace);
    const snapshot: WorkspaceSnapshot = {
      ...scanned,
      gitOracleVersion: "git version fixture",
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
      gitOracleVersion: "git version fixture",
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
    expect(manifest.format).toBe(CURRENT_TREE_MANIFEST_FORMAT);
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
          close: () => publication.close(),
        };
      },
      readBlob: (oid) => baseStore.readBlob(oid),
      streamBlob: (oid, sink) => baseStore.streamBlob(oid, sink),
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

  it("publishes distinct blobs with fixed bounded concurrency before the tree", async () => {
    const workspace = await tempRoot("cyclotomy-publish-concurrent-");
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        writeFile(join(workspace, `file-${index}.txt`), `unique-${index}`),
      ),
    );
    const snapshot = await scanWorkspace(workspace);
    const baseStore = await openObjectStore(
      await tempRoot("cyclotomy-publish-objects-"),
    );
    let active = 0;
    let maxActive = 0;
    let completed = 0;
    let treePublications = 0;
    const store: ObjectStore = {
      storageRoot: baseStore.storageRoot,
      beginSnapshotPublication() {
        const publication = baseStore.beginSnapshotPublication();
        return {
          publishBlobFromFile: async (path, oid, byteLength) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            try {
              await new Promise<void>((resolve) => setImmediate(resolve));
              const published = await publication.publishBlobFromFile(
                path,
                oid,
                byteLength,
              );
              completed += 1;
              return published;
            } finally {
              active -= 1;
            }
          },
          publishTree: (entries, targetScope) => {
            expect(active).toBe(0);
            expect(completed).toBe(12);
            treePublications += 1;
            return publication.publishTree(entries, targetScope);
          },
          close: () => publication.close(),
        };
      },
      readBlob: (oid) => baseStore.readBlob(oid),
      streamBlob: (oid, sink) => baseStore.streamBlob(oid, sink),
      readTree: (oid) => baseStore.readTree(oid),
      readTreeManifest: (oid) => baseStore.readTreeManifest(oid),
      verifyBlobs: (oids) => baseStore.verifyBlobs(oids),
    };

    const treeOid = await publishSnapshot(store, snapshot);

    expect(maxActive).toBe(8);
    expect(treePublications).toBe(1);
    expect((await baseStore.readTree(treeOid)).entries).toHaveLength(12);
  });

  it("reports concurrent publication failures in snapshot order", async () => {
    const workspace = await tempRoot("cyclotomy-publish-fail-order-");
    await Promise.all([
      writeFile(join(workspace, "first.txt"), "first"),
      writeFile(join(workspace, "second.txt"), "second"),
    ]);
    const snapshot = await scanWorkspace(workspace);
    const baseStore = await openObjectStore(
      await tempRoot("cyclotomy-publish-fail-objects-"),
    );
    let treePublications = 0;
    const close = vi.fn(() => Promise.resolve());
    const store: ObjectStore = {
      storageRoot: baseStore.storageRoot,
      beginSnapshotPublication() {
        return {
          publishBlobFromFile: async (path) => {
            if (path.endsWith("first.txt")) {
              await new Promise<void>((resolve) => setImmediate(resolve));
              throw new Error("first input failed");
            }
            throw new Error("second input failed");
          },
          publishTree: () => {
            treePublications += 1;
            throw new Error("tree must not be published");
          },
          close,
        };
      },
      readBlob: (oid) => baseStore.readBlob(oid),
      streamBlob: (oid, sink) => baseStore.streamBlob(oid, sink),
      readTree: (oid) => baseStore.readTree(oid),
      readTreeManifest: (oid) => baseStore.readTreeManifest(oid),
      verifyBlobs: (oids) => baseStore.verifyBlobs(oids),
    };

    await expect(publishSnapshot(store, snapshot)).rejects.toThrow(
      "first input failed",
    );
    expect(treePublications).toBe(0);
    expect(close).toHaveBeenCalledTimes(1);
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
    expect(await readdir(join(store.storageRoot, "objects", "trees"))).toEqual(
      [],
    );
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
          close: () => Promise.resolve(),
        };
      },
      readBlob: (oid) => store.readBlob(oid),
      streamBlob: (oid, sink) => store.streamBlob(oid, sink),
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
