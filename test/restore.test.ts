import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { captureNodeState } from "../src/application/capture.ts";
import { restoreWorkspace } from "../src/application/restore.ts";
import { MetadataStore } from "../src/infrastructure/metadata.ts";
import { openObjectStore } from "../src/infrastructure/object-store.ts";
import {
  scanWorkspace,
  scanWorkspaceForScope,
} from "../src/infrastructure/workspace-scan.ts";
import { gitScope } from "./workspace-scope-fixture.ts";

const execFileAsync = promisify(execFile);

let root: string;
let storeRoot: string;

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
  const metadata = new MetadataStore(join(storeRoot, "state.db"));
  const node = { sessionId: "s", entryId: "target" };
  const captured = await captureNodeState({ store, metadata }, root, node);
  if (!captured.ok) throw new Error(captured.error.message);
  return {
    store,
    metadata,
    node,
    resolution: { treeOid: captured.value.treeOid, foundAt: node },
    state: metadata.getState(node.sessionId, node.entryId)!,
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
      { current: await scanWorkspaceForScope(root, scope) },
    );

    expect(outcome).toMatchObject({
      kind: "checkpoint-unreadable",
      treeOid,
      message: expect.stringContaining(
        "tree entry is excluded by its archived workspace scope: ignored/secret.txt",
      ),
    });
    await expect(stat(targetPath)).rejects.toThrow();
  });

  it("rejects a forged file at a synthetic policy-directory path", async () => {
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
    const treeOid = await publication.publishTree(
      [
        {
          path: "a",
          type: "regular",
          blobOid,
          recreationMode: 0o600,
        },
      ],
      scope,
    );
    await writeFile(targetPath, "unmanaged current bytes");
    const node = { sessionId: "s", entryId: "forged-policy-directory" };

    const outcome = await restoreWorkspace(
      { store },
      root,
      { treeOid, foundAt: node },
      { current: await scanWorkspaceForScope(root, scope) },
    );

    expect(outcome).toMatchObject({
      kind: "checkpoint-unreadable",
      treeOid,
      message: expect.stringContaining(
        "tree entry is excluded by its archived workspace scope: a",
      ),
    });
    expect(await readFile(targetPath, "utf8")).toBe("unmanaged current bytes");
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
      { current: await scanWorkspaceForScope(root, scope) },
    );

    expect(outcome).toMatchObject({
      kind: "checkpoint-unreadable",
      treeOid,
      message: expect.stringContaining(
        "tree omits a managed archived .gitignore source: .gitignore",
      ),
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
      { current: await scanWorkspaceForScope(root, scope) },
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
      { current },
    );

    expect(outcome).toMatchObject({
      kind: "failed",
      stage: "current-scan",
      message: expect.stringContaining("scope-blocker"),
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
      { current: await scanWorkspace(root) },
    );

    expect(outcome.kind).toBe("restored");
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("target");
    await expect(stat(join(root, "extra.txt"))).rejects.toThrow();
    expect(setup.metadata.getState("s", "target")).toEqual(setup.state);
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
        })
      ).kind,
    ).toBe("restored");
    expect((await stat(path)).mode & 0o777).toBe(0o640);

    await unlink(path);
    expect(
      (
        await restoreWorkspace({ store: setup.store }, root, setup.resolution, {
          current: await scanWorkspace(root),
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
      { current: await scanWorkspace(root) },
    );

    expect(outcome.kind).toBe("checkpoint-unreadable");
    expect(await readFile(join(root, "target.txt"), "utf8")).toBe(
      "current bytes",
    );
    expect(await readFile(join(root, "keep.txt"), "utf8")).toBe("must survive");
    expect(setup.metadata.getState("s", "target")).toEqual(setup.state);
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
      { current: await scanWorkspace(root) },
    );

    expect(outcome.kind).toBe("checkpoint-unreadable");
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("a");
    expect(await readFile(join(root, "b.txt"), "utf8")).toBe("b");
    setup.metadata.close();
  });

  it("reports local staging failure without blaming checkpoint integrity", async () => {
    await writeFile(join(root, "target.txt"), "target bytes");
    const setup = await setupTarget();
    await writeFile(join(root, "target.txt"), "current bytes");

    const outcome = await restoreWorkspace(
      {
        store: setup.store,
        // Staging inside the managed workspace is rejected before mutation.
        stagingParent: root,
      },
      root,
      setup.resolution,
      { current: await scanWorkspace(root) },
    );

    expect(outcome).toMatchObject({ kind: "failed", stage: "staging" });
    expect(await readFile(join(root, "target.txt"), "utf8")).toBe(
      "current bytes",
    );
    expect(setup.metadata.getState("s", "target")).toEqual(setup.state);
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
      { current: staleObservation },
    );
    expect(first.kind).toBe("apply-incomplete");
    expect(await readFile(join(root, "extra.txt"), "utf8")).toBe("raced");
    expect(setup.metadata.getState("s", "target")).toEqual(setup.state);

    const retry = await restoreWorkspace(
      { store: setup.store },
      root,
      setup.resolution,
      { current: await scanWorkspace(root) },
    );
    expect(retry.kind).toBe("restored");
    await expect(stat(join(root, "extra.txt"))).rejects.toThrow();
    expect(setup.metadata.getState("s", "target")).toEqual(setup.state);
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
      { current: incomplete },
    );
    expect(outcome).toMatchObject({ kind: "failed", stage: "current-scan" });
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("current");
    expect(setup.metadata.getState("s", "target")).toEqual(setup.state);
    setup.metadata.close();
  });
});
