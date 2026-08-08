import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  captureNodeState,
  commitPreparedNodeState,
  prepareNodeState,
  recordObservedNodeState,
} from "../src/application/capture.ts";
import { MetadataStore } from "../src/infrastructure/metadata.ts";
import {
  openObjectStore,
  type ObjectStore,
} from "../src/infrastructure/object-store.ts";
import { scanWorkspace } from "../src/infrastructure/workspace-scan.ts";

const execFileAsync = promisify(execFile);

let root: string;
let storeRoot: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cyclotomy-capture-ws-"));
  storeRoot = await mkdtemp(join(tmpdir(), "cyclotomy-capture-store-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(storeRoot, { recursive: true, force: true });
});

async function openDeps() {
  const store = await openObjectStore(storeRoot);
  const metadata = new MetadataStore(join(storeRoot, "state.db"));
  return { store, metadata };
}

describe("captureNodeState", () => {
  it("refuses a too-large partial scan without recording a checkpoint", async () => {
    await writeFile(join(root, "large.bin"), "12345");
    const base = await openDeps();
    const deps = { ...base, scanOptions: { maxFileBytes: 4 } };
    const node = { sessionId: "s1", entryId: "too-large" };

    const result = await captureNodeState(deps, root, node);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        kind: "scan-incomplete",
        problems: [{ path: "large.bin", kind: "too-large" }],
      });
      expect(result.error.message).toContain("large.bin");
    }
    expect(base.metadata.getState("s1", "too-large")).toBeUndefined();
    base.metadata.close();
  });

  it("reports a read-failed path and does not publish it as absence", async (context) => {
    context.skip(
      process.platform === "win32",
      "Windows symlink targets are represented through Unicode APIs",
    );
    await symlink(Buffer.from([0xff]), join(root, "bad-link"));
    await writeFile(join(root, "visible.txt"), "visible");
    const deps = await openDeps();

    const result = await captureNodeState(deps, root, {
      sessionId: "s1",
      entryId: "read-failed",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("scan-incomplete");
      if (result.error.kind === "scan-incomplete") {
        expect(result.error.problems).toContainEqual(
          expect.objectContaining({
            path: "bad-link",
            kind: "read-failed",
          }),
        );
      }
    }
    expect(deps.metadata.getState("s1", "read-failed")).toBeUndefined();
    deps.metadata.close();
  });

  it("refuses unsupported entries without recording a checkpoint", async (context) => {
    context.skip(
      process.platform === "win32",
      "Windows filesystems do not expose POSIX FIFO entries",
    );
    await execFileAsync("mkfifo", [join(root, "pipe")]);
    await writeFile(join(root, "visible.txt"), "visible");
    const deps = await openDeps();

    const result = await captureNodeState(deps, root, {
      sessionId: "s1",
      entryId: "unsupported",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("scan-incomplete");
      if (result.error.kind === "scan-incomplete") {
        expect(result.error.problems).toContainEqual(
          expect.objectContaining({
            path: "pipe",
            kind: "unsupported",
          }),
        );
      }
    }
    expect(deps.metadata.getState("s1", "unsupported")).toBeUndefined();
    deps.metadata.close();
  });

  it("scans, publishes, and records the reality at a node", async () => {
    await writeFile(join(root, "a.txt"), "hello");
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "b.ts"), "export {}\n");
    const deps = await openDeps();
    const node = { sessionId: "s1", entryId: "e1" };

    const result = await captureNodeState(deps, root, node);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const recorded = deps.metadata.getState("s1", "e1");
    expect(recorded?.treeOid).toBe(result.value.treeOid);
    const manifest = await deps.store.readTree(result.value.treeOid);
    const paths = manifest.entries.map((entry) => entry.path);
    expect(paths).toContain("a.txt");
    expect(paths).toContain("src/b.ts");
    deps.metadata.close();
  });

  it("publishes a new tree when content changes", async () => {
    await writeFile(join(root, "a.txt"), "v1");
    const deps = await openDeps();
    const node = { sessionId: "s1", entryId: "e1" };
    const first = await captureNodeState(deps, root, node);

    await writeFile(join(root, "a.txt"), "v2");
    const second = await captureNodeState(deps, root, node);

    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.value.treeOid).not.toBe(first.value.treeOid);
    }
    deps.metadata.close();
  });

  it("does not let a CAS hit turn a stale scan into a committed checkpoint", async () => {
    const path = join(root, "a.txt");
    await writeFile(path, "old");
    const deps = await openDeps();
    const seeded = await captureNodeState(deps, root, {
      sessionId: "s1",
      entryId: "seed",
    });
    expect(seeded.ok).toBe(true);
    const stale = await scanWorkspace(root);
    await writeFile(path, "new");

    const result = await recordObservedNodeState(
      deps,
      { sessionId: "s1", entryId: "candidate" },
      stale,
    );

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "workspace-changed" },
    });
    expect(deps.metadata.getState("s1", "candidate")).toBeUndefined();
    deps.metadata.close();
  });

  it("rejects a namespace addition made after the observed scan", async () => {
    const deps = await openDeps();
    const stale = await scanWorkspace(root);
    await writeFile(join(root, "late.txt"), "late");

    const result = await recordObservedNodeState(
      deps,
      { sessionId: "s1", entryId: "namespace-addition" },
      stale,
    );

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "workspace-changed" },
    });
    expect(
      deps.metadata.getState("s1", "namespace-addition"),
    ).toBeUndefined();
    deps.metadata.close();
  });

  it("rejects a same-OID file moved to a second path after the observed scan", async () => {
    const firstPath = join(root, "first.txt");
    await writeFile(firstPath, "shared bytes");
    const deps = await openDeps();
    const seeded = await captureNodeState(deps, root, {
      sessionId: "s1",
      entryId: "seed",
    });
    expect(seeded.ok).toBe(true);
    const stale = await scanWorkspace(root);
    await rm(firstPath);
    await writeFile(join(root, "second.txt"), "shared bytes");

    const result = await recordObservedNodeState(
      deps,
      { sessionId: "s1", entryId: "same-oid-path-drift" },
      stale,
    );

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "workspace-changed" },
    });
    expect(
      deps.metadata.getState("s1", "same-oid-path-drift"),
    ).toBeUndefined();
    deps.metadata.close();
  });

  it("rejects symlink target drift after the observed scan", async (context) => {
    context.skip(
      process.platform === "win32",
      "Windows symlink creation depends on host privileges and target kind",
    );
    await writeFile(join(root, "first.txt"), "first");
    await writeFile(join(root, "second.txt"), "second");
    const linkPath = join(root, "pointer");
    await symlink("first.txt", linkPath);
    const deps = await openDeps();
    const stale = await scanWorkspace(root);
    await rm(linkPath);
    await symlink("second.txt", linkPath);

    const result = await recordObservedNodeState(
      deps,
      { sessionId: "s1", entryId: "symlink-drift" },
      stale,
    );

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "workspace-changed" },
    });
    expect(
      deps.metadata.getState("s1", "symlink-drift"),
    ).toBeUndefined();
    deps.metadata.close();
  });

  it("rejects ignore-policy drift after the observed scan", async () => {
    await execFileAsync("git", ["-C", root, "init", "-q"]);
    await writeFile(join(root, ".gitignore"), "ignored.txt\n");
    await writeFile(join(root, "ignored.txt"), "ignored");
    const deps = await openDeps();
    const seeded = await captureNodeState(deps, root, {
      sessionId: "s1",
      entryId: "seed",
    });
    expect(seeded.ok).toBe(true);
    const stale = await scanWorkspace(root);
    await writeFile(join(root, ".gitignore"), "other.txt\n");

    const result = await recordObservedNodeState(
      deps,
      { sessionId: "s1", entryId: "ignore-policy-drift" },
      stale,
    );

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "workspace-changed" },
    });
    expect(
      deps.metadata.getState("s1", "ignore-policy-drift"),
    ).toBeUndefined();
    deps.metadata.close();
  });

  it("rejects Git ignoreCase drift during snapshot publication", async () => {
    await execFileAsync("git", ["-C", root, "init", "-q"]);
    await execFileAsync("git", [
      "-C",
      root,
      "config",
      "core.ignoreCase",
      "false",
    ]);
    await writeFile(join(root, "a.txt"), "captured");
    const deps = await openDeps();
    const baseStore = deps.store;
    let policyChanged = false;
    const changingStore: ObjectStore = {
      storageRoot: baseStore.storageRoot,
      beginSnapshotPublication() {
        const publication = baseStore.beginSnapshotPublication();
        return {
          publishBlobFromFile: (path, oid, byteLength) =>
            publication.publishBlobFromFile(path, oid, byteLength),
          async publishTree(entries, scope) {
            await execFileAsync("git", [
              "-C",
              root,
              "config",
              "core.ignoreCase",
              "true",
            ]);
            policyChanged = true;
            return publication.publishTree(entries, scope);
          },
        };
      },
      readBlob: (oid) => baseStore.readBlob(oid),
      readTree: (oid) => baseStore.readTree(oid),
      readTreeManifest: (oid) => baseStore.readTreeManifest(oid),
      verifyBlobs: (oids) => baseStore.verifyBlobs(oids),
    };

    const result = await captureNodeState(
      { ...deps, store: changingStore },
      root,
      { sessionId: "s1", entryId: "ignore-case-drift" },
    );

    expect(policyChanged).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "workspace-changed" },
    });
    expect(
      deps.metadata.getState("s1", "ignore-case-drift"),
    ).toBeUndefined();
    deps.metadata.close();
  }, 15_000);

  it("does not let a prepared capture overwrite a changed node slot", async () => {
    await writeFile(join(root, "a.txt"), "v1");
    const deps = await openDeps();
    const node = { sessionId: "s1", entryId: "e1" };
    const initial = await captureNodeState(deps, root, node);
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    await writeFile(join(root, "a.txt"), "v2");
    const prepared = await prepareNodeState(deps, root);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const concurrent = "f".repeat(64);
    deps.metadata.setState("s1", "e1", concurrent);

    const committed = await commitPreparedNodeState(
      deps,
      node,
      prepared.value,
      { treeOid: initial.value.treeOid },
    );

    expect(committed).toMatchObject({
      ok: false,
      error: { kind: "state-changed" },
    });
    expect(deps.metadata.getState("s1", "e1")?.treeOid).toBe(concurrent);
    deps.metadata.close();
  });

  it("captures symlinks and POSIX recreation modes", async () => {
    await writeFile(join(root, "target.txt"), "data");
    await symlink("target.txt", join(root, "link"));
    await writeFile(join(root, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
    const deps = await openDeps();
    const node = { sessionId: "s1", entryId: "e1" };

    const result = await captureNodeState(deps, root, node);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const manifest = await deps.store.readTree(result.value.treeOid);
    const link = manifest.entries.find((entry) => entry.path === "link");
    expect(link).toMatchObject({ type: "symlink", target: "target.txt" });
    const script = manifest.entries.find(
      (entry) => entry.path === "run.sh",
    );
    expect(script).toMatchObject({
      type: "regular",
      recreationMode: process.platform === "win32" ? null : 0o755,
    });
    deps.metadata.close();
  });

  it("never captures .git internals", async () => {
    await mkdir(join(root, ".git", "objects"), { recursive: true });
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(root, "tracked.txt"), "x");
    const deps = await openDeps();

    const result = await captureNodeState(deps, root, {
      sessionId: "s1",
      entryId: "e1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const manifest = await deps.store.readTree(result.value.treeOid);
    expect(
      manifest.entries.some((entry) => entry.path.includes(".git")),
    ).toBe(false);
    deps.metadata.close();
  });

  it("excludes gitignored paths by default", async () => {
    await execFileAsync("git", ["-C", root, "init", "-q"]);
    await writeFile(join(root, ".gitignore"), "node_modules/\nsecret.env\n");
    await mkdir(join(root, "node_modules", "dep"), { recursive: true });
    await writeFile(join(root, "node_modules", "dep", "index.js"), "x");
    await writeFile(join(root, "secret.env"), "TOKEN=1");
    await writeFile(join(root, "tracked.txt"), "x");
    const deps = await openDeps();

    const result = await captureNodeState(deps, root, {
      sessionId: "s1",
      entryId: "e1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const manifest = await deps.store.readTree(result.value.treeOid);
    const paths = manifest.entries.map((entry) => entry.path);
    expect(paths).toContain("tracked.txt");
    expect(paths).not.toContain("node_modules/dep/index.js");
    expect(paths).not.toContain("secret.env");
    deps.metadata.close();
  });

  it("fails honestly when the workspace cannot be scanned", async () => {
    const deps = await openDeps();
    const result = await captureNodeState(
      deps,
      join(root, "does-not-exist"),
      { sessionId: "s1", entryId: "e1" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("scan-failed");
    }
    deps.metadata.close();
  });
});
