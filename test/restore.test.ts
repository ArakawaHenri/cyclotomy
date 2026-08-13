import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  commitPreparedNodeState,
  prepareNodeState,
} from "../src/application/capture.ts";
import {
  prepareWorkspaceMutationLease,
  workspaceMutationLeaseState,
} from "../src/application/mutation-lease.ts";
import type { ResolvedNodeState } from "../src/application/resolve.ts";
import {
  restoreWorkspace as executeWorkspaceRestore,
  type RestoreDeps,
  type RestoreOptions,
  type RestoreOutcome,
} from "../src/application/restore.ts";
import {
  BlobStagingCleanupError,
  BlobStagingError,
  stageBlobs,
} from "../src/infrastructure/blob-staging.ts";
import { createCurrentMetadataStore } from "../src/infrastructure/metadata.ts";
import { openObjectStore } from "../src/infrastructure/object-store.ts";
import { validateTreeEntriesAgainstScope } from "../src/infrastructure/tree-scope-validation.ts";
import {
  scanWorkspace,
  scanWorkspaceForScope,
} from "../src/infrastructure/workspace-scan.ts";
import { gitScope } from "./workspace-scope-fixture.ts";
import { checkpointState, registerTestSession } from "./metadata-fixture.ts";

const execFileAsync = promisify(execFile);

let root: string;
let storeRoot: string;

function testMutationLease(cutover: () => unknown = () => undefined) {
  return prepareWorkspaceMutationLease(() => {
    const returned = cutover();
    if (returned !== undefined) {
      // Deliberately exercise the runtime guard with a hostile JS caller.
      return returned as never;
    }
    return {
      kind: "authorized",
      pinnedResolution: {
        treeOid: "0".repeat(64),
        foundAt: { sessionId: "test", entryId: "test" },
      },
    };
  });
}

async function restoreWorkspace(
  deps: Omit<RestoreDeps, "validateManifestScope"> &
    Partial<Pick<RestoreDeps, "validateManifestScope">>,
  workspaceRoot: string,
  resolution: ResolvedNodeState,
  options: RestoreOptions,
): Promise<
  RestoreOutcome | { readonly kind: "cutover-rejected"; cause: unknown }
> {
  const execution = await executeWorkspaceRestore(
    {
      ...deps,
      validateManifestScope:
        deps.validateManifestScope ??
        (async (_treeOid, manifest) =>
          validateTreeEntriesAgainstScope(manifest, {
            scratchParent: deps.store.storageRoot,
            forbiddenRoots: [workspaceRoot],
          })),
    },
    workspaceRoot,
    resolution,
    options,
  );
  return execution.cutover.kind === "rejected"
    ? { kind: "cutover-rejected", cause: execution.cutover.cause }
    : execution.outcome;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cyclotomy-restore-ws-"));
  storeRoot = await mkdtemp(join(tmpdir(), "cyclotomy-restore-store-"));
});

afterEach(async () => {
  await chmod(root, 0o755).catch(() => {});
  await rm(root, { recursive: true, force: true });
  await rm(storeRoot, { recursive: true, force: true });
});

async function setupTarget() {
  const store = await openObjectStore(storeRoot);
  const metadata = createCurrentMetadataStore(join(storeRoot, "state.db"));
  const node = { sessionId: "s", entryId: "target" };
  const expectedSessionFile = "/test-sessions/s.jsonl";
  registerTestSession(metadata, node.sessionId, expectedSessionFile);
  const captureDeps = {
    store,
    metadata,
    expectedRootPath: await realpath(root),
    expectedSessionFile,
    assertWorkspaceAuthority: () => undefined,
  };
  const prepared = await prepareNodeState(captureDeps, root);
  const captured = prepared.ok
    ? commitPreparedNodeState(captureDeps, node, prepared.value, {
        activeAncestryEntryIds: [node.entryId],
        expectedSlot: metadata.getCheckpointSlot(node.sessionId, node.entryId),
      })
    : prepared;
  if (!captured.ok) throw new Error(captured.error.kind);
  return {
    store,
    metadata,
    node,
    resolution: { treeOid: captured.value.treeOid, foundAt: node },
    state: checkpointState(metadata, node.sessionId, node.entryId)!,
  };
}

describe("pure workspace restore", () => {
  it("rejects a forged target entry excluded by its own archived policy before mutation", async () => {
    const store = await openObjectStore(storeRoot);
    const targetPath = join(root, "ignored", "secret.txt");
    const targetBytes = Buffer.from("forged target", "utf8");
    const blobOid = createHash("sha256").update(targetBytes).digest("hex");
    await mkdir(join(root, "ignored"));
    await writeFile(targetPath, targetBytes);
    const publication = store.beginSnapshotPublication();
    await publication.publishBlobFromFile(
      targetPath,
      blobOid,
      targetBytes.byteLength,
    );
    const scope = gitScope({ globalExclude: "ignored/\n" });
    const treeOid = await publication.publishTree(
      [
        {
          path: "ignored/secret.txt",
          type: "regular",
          blobOid,
          recreationMode: 0o600,
        },
      ],
      scope,
    );
    await unlink(targetPath);
    const node = { sessionId: "s", entryId: "forged" };

    const outcome = await restoreWorkspace(
      { store },
      root,
      { treeOid, foundAt: node },
      {
        current: await scanWorkspaceForScope(root, scope),
        mutationLease: testMutationLease(),
      },
    );

    expect(outcome).toMatchObject({
      kind: "checkpoint-unreadable",
      treeOid,
      cause: {
        message: expect.stringContaining(
          "tree entry is excluded by its archived workspace scope: ignored/secret.txt",
        ),
      },
    });
    await expect(stat(targetPath)).rejects.toThrow();
  });

  it("rejects a forged file at a synthetic policy-directory path before publication", async () => {
    const store = await openObjectStore(storeRoot);
    const targetPath = join(root, "a");
    const targetBytes = Buffer.from("forged target", "utf8");
    const blobOid = createHash("sha256").update(targetBytes).digest("hex");
    await writeFile(targetPath, targetBytes);
    const publication = store.beginSnapshotPublication();
    await publication.publishBlobFromFile(
      targetPath,
      blobOid,
      targetBytes.byteLength,
    );
    const policy = "a\n!a/\n";
    const scope = gitScope({
      gitignoreSources: [
        { path: ".gitignore", contents: policy },
        { path: "a/.gitignore", contents: "" },
      ],
    });
    await expect(
      publication.publishTree(
        [
          {
            path: "a",
            type: "regular",
            blobOid,
            recreationMode: 0o600,
          },
        ],
        scope,
      ),
    ).rejects.toThrow("policy directory collides with tree path a");
    expect(await readFile(targetPath, "utf8")).toBe("forged target");
  });

  it("rejects omission of a managed archived .gitignore before it can be deleted", async () => {
    const store = await openObjectStore(storeRoot);
    const ignorePath = join(root, ".gitignore");
    const ignoreBytes = "secret.txt\n";
    await writeFile(ignorePath, ignoreBytes);
    const scope = gitScope({
      gitignoreSources: [{ path: ".gitignore", contents: ignoreBytes }],
    });
    // Structurally canonical but impossible for the scanner to produce: the
    // archived source is managed and therefore cannot be absent from entries.
    const treeOid = await store
      .beginSnapshotPublication()
      .publishTree([], scope);
    const node = { sessionId: "s", entryId: "omitted-ignore" };

    const outcome = await restoreWorkspace(
      { store },
      root,
      { treeOid, foundAt: node },
      {
        current: await scanWorkspaceForScope(root, scope),
        mutationLease: testMutationLease(),
      },
    );

    expect(outcome).toMatchObject({
      kind: "checkpoint-unreadable",
      treeOid,
      cause: {
        message: expect.stringContaining(
          "tree omits a managed archived .gitignore source: .gitignore",
        ),
      },
    });
    expect(await readFile(ignorePath, "utf8")).toBe(ignoreBytes);
  });

  it("allows an archived .gitignore source to be absent only when it ignores itself", async () => {
    const store = await openObjectStore(storeRoot);
    const ignorePath = join(root, ".gitignore");
    const ignoreBytes = ".gitignore\n";
    await writeFile(ignorePath, ignoreBytes);
    const scope = gitScope({
      gitignoreSources: [{ path: ".gitignore", contents: ignoreBytes }],
    });
    const treeOid = await store
      .beginSnapshotPublication()
      .publishTree([], scope);
    const node = { sessionId: "s", entryId: "ignored-ignore" };

    const outcome = await restoreWorkspace(
      { store },
      root,
      { treeOid, foundAt: node },
      {
        current: await scanWorkspaceForScope(root, scope),
        mutationLease: testMutationLease(),
      },
    );

    expect(outcome.kind).toBe("restored");
    expect(await readFile(ignorePath, "utf8")).toBe(ignoreBytes);
  });

  it("does not replace an unmanaged file that blocks a target implicit directory", async () => {
    await execFileAsync("git", ["-C", root, "init", "-q"]);
    await writeFile(join(root, ".gitignore"), "a\n!a/\n");
    await mkdir(join(root, "a"));
    await writeFile(join(root, "a", ".gitignore"), "");
    await writeFile(join(root, "a", "wanted.txt"), "target");
    const setup = await setupTarget();
    const target = await setup.store.readTreeManifest(setup.resolution.treeOid);

    await rm(join(root, "a"), { recursive: true });
    await writeFile(join(root, "a"), "unmanaged occupant");
    const current = await scanWorkspaceForScope(root, target.scope);
    expect(current.excludedOccupancies).toEqual([
      expect.objectContaining({ path: "a", kind: "regular" }),
    ]);

    const outcome = await restoreWorkspace(
      { store: setup.store },
      root,
      setup.resolution,
      { current, mutationLease: testMutationLease() },
    );

    expect(outcome).toMatchObject({
      kind: "scan-incomplete",
      stage: "current-scan",
      problems: expect.arrayContaining([
        expect.objectContaining({ path: "a" }),
      ]),
    });
    expect(await readFile(join(root, "a"), "utf8")).toBe("unmanaged occupant");
    setup.metadata.close();
  });

  it("restores files while leaving the node's sole state untouched", async () => {
    await writeFile(join(root, "a.txt"), "target");
    const setup = await setupTarget();
    await writeFile(join(root, "a.txt"), "changed");
    await writeFile(join(root, "extra.txt"), "delete me");

    const outcome = await restoreWorkspace(
      { store: setup.store },
      root,
      setup.resolution,
      {
        current: await scanWorkspace(root),
        mutationLease: testMutationLease(),
      },
    );

    expect(outcome.kind).toBe("restored");
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("target");
    await expect(stat(join(root, "extra.txt"))).rejects.toThrow();
    expect(checkpointState(setup.metadata, "s", "target")).toEqual(setup.state);
    setup.metadata.close();
  });

  it("does not manage existing permissions but recreates a deleted file's mode", async (context) => {
    context.skip(
      process.platform === "win32",
      "Windows has no portable POSIX mode contract",
    );
    const path = join(root, "a.txt");
    await writeFile(path, "target");
    await chmod(path, 0o600);
    const setup = await setupTarget();

    await chmod(path, 0o640);
    expect(
      (
        await restoreWorkspace({ store: setup.store }, root, setup.resolution, {
          current: await scanWorkspace(root),
          mutationLease: testMutationLease(),
        })
      ).kind,
    ).toBe("restored");
    expect((await stat(path)).mode & 0o777).toBe(0o640);

    await unlink(path);
    expect(
      (
        await restoreWorkspace({ store: setup.store }, root, setup.resolution, {
          current: await scanWorkspace(root),
          mutationLease: testMutationLease(),
        })
      ).kind,
    ).toBe("restored");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    setup.metadata.close();
  });

  it("recreates recorded POSIX special permission bits", async (context) => {
    context.skip(
      process.platform === "win32",
      "Windows has no portable POSIX mode contract",
    );
    const path = join(root, "a.txt");
    const wanted = 0o4750;
    await writeFile(path, "target");
    await chmod(path, wanted);
    if (((await stat(path)).mode & 0o7777) !== wanted) {
      context.skip("the test filesystem clears special permission bits");
    }
    const setup = await setupTarget();
    await unlink(path);

    expect(
      (
        await restoreWorkspace({ store: setup.store }, root, setup.resolution, {
          current: await scanWorkspace(root),
          mutationLease: testMutationLease(),
        })
      ).kind,
    ).toBe("restored");
    expect((await stat(path)).mode & 0o7777).toBe(wanted);
    setup.metadata.close();
  });

  it("authenticates changed blobs before the first destructive mutation", async () => {
    await writeFile(join(root, "target.txt"), "target bytes");
    const setup = await setupTarget();
    const manifest = await setup.store.readTreeManifest(
      setup.resolution.treeOid,
    );
    const blob = manifest.entries.find((entry) => entry.type === "regular");
    if (blob?.type !== "regular") throw new Error("fixture blob missing");
    await unlink(
      join(
        storeRoot,
        "objects",
        "blobs",
        blob.blobOid.slice(0, 2),
        blob.blobOid.slice(2),
      ),
    );
    await writeFile(join(root, "target.txt"), "current bytes");
    await writeFile(join(root, "keep.txt"), "must survive");

    const outcome = await restoreWorkspace(
      { store: setup.store },
      root,
      setup.resolution,
      {
        current: await scanWorkspace(root),
        mutationLease: testMutationLease(),
      },
    );

    expect(outcome.kind).toBe("checkpoint-unreadable");
    expect(await readFile(join(root, "target.txt"), "utf8")).toBe(
      "current bytes",
    );
    expect(await readFile(join(root, "keep.txt"), "utf8")).toBe("must survive");
    expect(checkpointState(setup.metadata, "s", "target")).toEqual(setup.state);
    setup.metadata.close();
  });

  it("authenticates required and unused blobs exactly once before mutation", async () => {
    await writeFile(join(root, "a.txt"), "target a");
    await writeFile(join(root, "b.txt"), "target b");
    const setup = await setupTarget();
    const manifest = await setup.store.readTreeManifest(
      setup.resolution.treeOid,
    );
    const blobByPath = new Map(
      manifest.entries
        .filter((entry) => entry.type === "regular")
        .map((entry) => [entry.path, entry.blobOid] as const),
    );
    await writeFile(join(root, "a.txt"), "current a");

    const readTree = vi.spyOn(setup.store, "readTree");
    const readTreeManifest = vi.spyOn(setup.store, "readTreeManifest");
    const readBlob = vi.spyOn(setup.store, "readBlob");
    const verifyBlobs = vi.spyOn(setup.store, "verifyBlobs");
    const outcome = await restoreWorkspace(
      { store: setup.store },
      root,
      setup.resolution,
      {
        current: await scanWorkspace(root),
        mutationLease: testMutationLease(),
      },
    );

    expect(outcome.kind).toBe("restored");
    expect(readTree).not.toHaveBeenCalled();
    expect(readTreeManifest).toHaveBeenCalledTimes(1);
    expect(readBlob).toHaveBeenCalledTimes(1);
    expect(readBlob).toHaveBeenCalledWith(blobByPath.get("a.txt"));
    expect(verifyBlobs).toHaveBeenCalledOnce();
    expect(verifyBlobs).toHaveBeenCalledWith([blobByPath.get("b.txt")]);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("target a");
    setup.metadata.close();
  });

  it("authenticates unused blobs after staging and before workspace mutation", async () => {
    await writeFile(join(root, "a.txt"), "target a");
    await writeFile(join(root, "b.txt"), "target b");
    const setup = await setupTarget();
    const manifest = await setup.store.readTreeManifest(
      setup.resolution.treeOid,
    );
    const unused = manifest.entries.find(
      (entry) => entry.type === "regular" && entry.path === "b.txt",
    );
    if (unused?.type !== "regular") throw new Error("fixture blob missing");
    await unlink(
      join(
        storeRoot,
        "objects",
        "blobs",
        unused.blobOid.slice(0, 2),
        unused.blobOid.slice(2),
      ),
    );
    await writeFile(join(root, "a.txt"), "current a");
    await writeFile(join(root, "keep.txt"), "must survive");

    const outcome = await restoreWorkspace(
      { store: setup.store },
      root,
      setup.resolution,
      {
        current: await scanWorkspace(root),
        mutationLease: testMutationLease(),
      },
    );

    expect(outcome.kind).toBe("checkpoint-unreadable");
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("current a");
    expect(await readFile(join(root, "keep.txt"), "utf8")).toBe("must survive");
    expect(checkpointState(setup.metadata, "s", "target")).toEqual(setup.state);
    setup.metadata.close();
  });

  it("authenticates the complete closure even when the workspace looks clean", async () => {
    await writeFile(join(root, "a.txt"), "a");
    await writeFile(join(root, "b.txt"), "b");
    const setup = await setupTarget();
    const manifest = await setup.store.readTreeManifest(
      setup.resolution.treeOid,
    );
    const missing = manifest.entries.find(
      (entry) => entry.type === "regular" && entry.path === "b.txt",
    );
    if (missing?.type !== "regular") throw new Error("fixture blob missing");
    await unlink(
      join(
        storeRoot,
        "objects",
        "blobs",
        missing.blobOid.slice(0, 2),
        missing.blobOid.slice(2),
      ),
    );

    const outcome = await restoreWorkspace(
      { store: setup.store },
      root,
      setup.resolution,
      {
        current: await scanWorkspace(root),
        mutationLease: testMutationLease(),
      },
    );

    expect(outcome.kind).toBe("checkpoint-unreadable");
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("a");
    expect(await readFile(join(root, "b.txt"), "utf8")).toBe("b");
    setup.metadata.close();
  });

  it("installs protection immediately before the first workspace mutation", async () => {
    await writeFile(join(root, "target.txt"), "target bytes");
    const setup = await setupTarget();
    await writeFile(join(root, "target.txt"), "current bytes");
    let protectionAttempted = false;

    const outcome = await restoreWorkspace(
      { store: setup.store },
      root,
      setup.resolution,
      {
        current: await scanWorkspace(root),
        mutationLease: testMutationLease(() => {
          protectionAttempted = true;
          throw new Error("injected protection failure");
        }),
      },
    );

    expect(protectionAttempted).toBe(true);
    expect(outcome).toMatchObject({
      kind: "cutover-rejected",
      cause: { message: "injected protection failure" },
    });
    expect(await readFile(join(root, "target.txt"), "utf8")).toBe(
      "current bytes",
    );
    setup.metadata.close();
  });

  it("preserves a rejected no-write cutover separately from staging cleanup failure", async () => {
    await writeFile(join(root, "target.txt"), "target bytes");
    const setup = await setupTarget();
    await writeFile(join(root, "target.txt"), "current bytes");
    const rejection = new Error("Pi became busy");
    const cleanup = new Error("staging cleanup failed");

    const execution = await executeWorkspaceRestore(
      {
        store: setup.store,
        validateManifestScope: async (_treeOid, manifest) =>
          validateTreeEntriesAgainstScope(manifest, {
            scratchParent: setup.store.storageRoot,
            forbiddenRoots: [root],
          }),
        stageBlobs: async (...args) => {
          const staged = await stageBlobs(...args);
          return {
            readBlob: (oid) => staged.readBlob(oid),
            dispose: async () => {
              await staged.dispose();
              throw cleanup;
            },
          };
        },
      },
      root,
      setup.resolution,
      {
        current: await scanWorkspace(root),
        mutationLease: testMutationLease(() => {
          throw rejection;
        }),
      },
    );

    expect(execution.cutover).toEqual({ kind: "rejected", cause: rejection });
    expect(execution.outcome).toMatchObject({
      kind: "failed",
      stage: "apply",
      cause: rejection,
    });
    expect(execution.stagingCleanup).toEqual({
      kind: "failed",
      cause: cleanup,
    });
    expect(await readFile(join(root, "target.txt"), "utf8")).toBe(
      "current bytes",
    );
    setup.metadata.close();
  });

  it("classifies an initial staging failure independently from its cleanup failure", async () => {
    await writeFile(join(root, "target.txt"), "target bytes");
    const setup = await setupTarget();
    await writeFile(join(root, "target.txt"), "current bytes");
    const primary = new BlobStagingError("scratch unavailable");
    const cleanup = new Error("partial scratch could not be removed");

    const execution = await executeWorkspaceRestore(
      {
        store: setup.store,
        validateManifestScope: async () => {},
        stageBlobs: async () => {
          throw new BlobStagingCleanupError(primary, cleanup);
        },
      },
      root,
      setup.resolution,
      {
        current: await scanWorkspace(root),
        mutationLease: testMutationLease(),
      },
    );

    expect(execution.cutover).toEqual({ kind: "not-requested" });
    expect(execution.outcome).toEqual({
      kind: "failed",
      stage: "staging",
      cause: primary,
    });
    expect(execution.stagingCleanup).toEqual({
      kind: "failed",
      cause: cleanup,
    });
    expect(await readFile(join(root, "target.txt"), "utf8")).toBe(
      "current bytes",
    );
    setup.metadata.close();
  });

  it("preserves a verified restore when only staging cleanup fails", async () => {
    await writeFile(join(root, "target.txt"), "target bytes");
    const setup = await setupTarget();
    await writeFile(join(root, "target.txt"), "current bytes");
    const cleanup = new Error("staging cleanup failed");

    const execution = await executeWorkspaceRestore(
      {
        store: setup.store,
        validateManifestScope: async (_treeOid, manifest) =>
          validateTreeEntriesAgainstScope(manifest, {
            scratchParent: setup.store.storageRoot,
            forbiddenRoots: [root],
          }),
        stageBlobs: async (...args) => {
          const staged = await stageBlobs(...args);
          return {
            readBlob: (oid) => staged.readBlob(oid),
            dispose: async () => {
              await staged.dispose();
              throw cleanup;
            },
          };
        },
      },
      root,
      setup.resolution,
      {
        current: await scanWorkspace(root),
        mutationLease: testMutationLease(),
      },
    );

    expect(execution.cutover.kind).toBe("authorized");
    expect(execution.outcome).toMatchObject({
      kind: "restored",
      treeOid: setup.resolution.treeOid,
    });
    expect(execution.stagingCleanup).toEqual({
      kind: "failed",
      cause: cleanup,
    });
    expect(await readFile(join(root, "target.txt"), "utf8")).toBe(
      "target bytes",
    );
    setup.metadata.close();
  });

  it("leaves mutation authority unconsumed when the workspace already matches", async () => {
    await writeFile(join(root, "target.txt"), "target bytes");
    const setup = await setupTarget();
    let cutovers = 0;

    const execution = await executeWorkspaceRestore(
      {
        store: setup.store,
        validateManifestScope: async (_treeOid, manifest) =>
          validateTreeEntriesAgainstScope(manifest, {
            scratchParent: setup.store.storageRoot,
            forbiddenRoots: [root],
          }),
      },
      root,
      setup.resolution,
      {
        current: await scanWorkspace(root),
        mutationLease: testMutationLease(() => {
          cutovers += 1;
        }),
      },
    );

    expect(execution.cutover).toEqual({ kind: "not-requested" });
    expect("outcome" in execution && execution.outcome.kind).toBe("restored");
    expect(cutovers).toBe(0);
    expect(await readFile(join(root, "target.txt"), "utf8")).toBe(
      "target bytes",
    );
    setup.metadata.close();
  });

  it("leaves mutation authority and the workspace untouched when a checkpoint blob exceeds the store limit", async () => {
    await writeFile(join(root, "target.txt"), "target bytes");
    const setup = await setupTarget();
    await writeFile(join(root, "target.txt"), "current bytes");
    const limitedStore = await openObjectStore(storeRoot, {
      maxFileBytes: Buffer.byteLength("target bytes") - 1,
    });
    let cutovers = 0;
    const lease = testMutationLease(() => {
      cutovers += 1;
    });

    const execution = await executeWorkspaceRestore(
      {
        store: limitedStore,
        validateManifestScope: async (_treeOid, manifest) =>
          validateTreeEntriesAgainstScope(manifest, {
            scratchParent: limitedStore.storageRoot,
            forbiddenRoots: [root],
          }),
      },
      root,
      setup.resolution,
      {
        current: await scanWorkspace(root),
        mutationLease: lease,
      },
    );

    expect(execution.cutover).toEqual({ kind: "not-requested" });
    expect(execution.outcome).toMatchObject({
      kind: "checkpoint-unreadable",
      treeOid: setup.resolution.treeOid,
      cause: { code: "object-integrity" },
    });
    expect(workspaceMutationLeaseState(lease)).toEqual({ kind: "pending" });
    expect(cutovers).toBe(0);
    expect(await readFile(join(root, "target.txt"), "utf8")).toBe(
      "current bytes",
    );
    setup.metadata.close();
  });

  it("rejects a non-synchronous mutation cutover without awaiting it", async () => {
    await writeFile(join(root, "target.txt"), "target bytes");
    const setup = await setupTarget();
    await writeFile(join(root, "target.txt"), "current bytes");
    let callbackReturnObserved = false;

    const outcome = await restoreWorkspace(
      { store: setup.store },
      root,
      setup.resolution,
      {
        current: await scanWorkspace(root),
        mutationLease: testMutationLease(() => ({
          then: () => {
            callbackReturnObserved = true;
            throw new Error("before-mutation return value was awaited");
          },
        })),
      },
    );

    expect(callbackReturnObserved).toBe(false);
    expect(outcome).toMatchObject({
      kind: "cutover-rejected",
      cause: {
        message: "workspace mutation authority must complete synchronously",
      },
    });
    expect(await readFile(join(root, "target.txt"), "utf8")).toBe(
      "current bytes",
    );
    setup.metadata.close();
  });

  it("never replaces the retry target with a partial workspace", async () => {
    await writeFile(join(root, "wanted.txt"), "wanted");
    const setup = await setupTarget();
    await writeFile(join(root, "extra.txt"), "observed");
    const staleObservation = await scanWorkspace(root);
    await writeFile(join(root, "extra.txt"), "raced");

    const first = await restoreWorkspace(
      { store: setup.store },
      root,
      setup.resolution,
      { current: staleObservation, mutationLease: testMutationLease() },
    );
    expect(first.kind).toBe("apply-incomplete");
    expect(await readFile(join(root, "extra.txt"), "utf8")).toBe("raced");
    expect(checkpointState(setup.metadata, "s", "target")).toEqual(setup.state);

    const retry = await restoreWorkspace(
      { store: setup.store },
      root,
      setup.resolution,
      {
        current: await scanWorkspace(root),
        mutationLease: testMutationLease(),
      },
    );
    expect(retry.kind).toBe("restored");
    await expect(stat(join(root, "extra.txt"))).rejects.toThrow();
    expect(checkpointState(setup.metadata, "s", "target")).toEqual(setup.state);
    setup.metadata.close();
  });

  it("refuses an incomplete current observation without changing files", async () => {
    await writeFile(join(root, "a.txt"), "target");
    const setup = await setupTarget();
    await writeFile(join(root, "a.txt"), "current");
    const current = await scanWorkspace(root);
    const incomplete = {
      ...current,
      problems: [
        {
          path: "blocked",
          kind: "read-failed" as const,
          detail: "injected",
        },
      ],
    };

    const outcome = await restoreWorkspace(
      { store: setup.store },
      root,
      setup.resolution,
      { current: incomplete, mutationLease: testMutationLease() },
    );
    expect(outcome).toMatchObject({
      kind: "scan-incomplete",
      stage: "current-scan",
    });
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("current");
    expect(checkpointState(setup.metadata, "s", "target")).toEqual(setup.state);
    setup.metadata.close();
  });
});
