import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  lstatSync,
  realpathSync,
  renameSync,
  symlinkSync,
} from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  ApplyError,
  applyTreeToWorkspace,
} from "../src/infrastructure/apply.ts";
import {
  TREE_MANIFEST_FORMAT,
  type FileRecreationMode,
  type TreeEntry,
  type TreeManifest,
} from "../src/infrastructure/object-store.ts";
import {
  scanWorkspace as scanRealWorkspace,
  scanWorkspaceForScope,
  type WorkspaceEntry,
  type WorkspaceSnapshot,
} from "../src/infrastructure/workspace-scan.ts";
import { planWorkspaceRestore } from "../src/infrastructure/restore-plan.ts";
import {
  ALL_MANAGED_SCOPE,
  gitScope,
} from "./workspace-scope-fixture.ts";

const encoder = new TextEncoder();
const execFileAsync = promisify(execFile);
const completeScope = ALL_MANAGED_SCOPE;
let root: string;

function sha256Hex(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function regularWorkspaceEntry(
  path: string,
  content: string,
  recreationMode: FileRecreationMode = 0o644,
): WorkspaceEntry {
  const bytes = encoder.encode(content);
  return {
    path,
    kind: "regular",
    recreationMode,
    byteLength: bytes.byteLength,
    sha256: sha256Hex(bytes),
    sourcePath: join(root, path),
  };
}

function symlinkWorkspaceEntry(
  path: string,
  target: string,
): WorkspaceEntry {
  return { path, kind: "symlink", target, symlinkKind: null };
}

function snapshot(entries: readonly WorkspaceEntry[]): WorkspaceSnapshot {
  // Match fs.promises.realpath on Windows, where the legacy sync resolver can
  // preserve a long path while libuv returns its canonical short spelling.
  const rootPath = realpathSync.native(root);
  const directoryPaths = new Set([""]);
  for (const entry of entries) {
    let parent = dirname(entry.path);
    while (parent !== ".") {
      directoryPaths.add(parent);
      parent = dirname(parent);
    }
  }
  const directoryObservations = [...directoryPaths].flatMap((path) => {
    try {
      const metadata = lstatSync(path === "" ? rootPath : join(rootPath, path));
      return metadata.isDirectory() && !metadata.isSymbolicLink()
        ? [{ path, dev: metadata.dev, ino: metadata.ino }]
        : [];
    } catch {
      return [];
    }
  });
  return {
    entries,
    excludedOccupancies: [],
    problems: [],
    rootPath,
    directoryObservations,
    scope: completeScope,
  };
}

function manifest(entries: readonly TreeEntry[]): TreeManifest {
  return {
    format: TREE_MANIFEST_FORMAT,
    entries,
    scope: completeScope,
  };
}

let blobs = new Map<string, Uint8Array>();

function publish(content: string): string {
  const bytes = encoder.encode(content);
  const oid = sha256Hex(bytes);
  blobs.set(oid, bytes);
  return oid;
}

async function readBlob(oid: string): Promise<Uint8Array> {
  const content = blobs.get(oid);
  if (content === undefined) {
    throw new Error(`missing blob: ${oid}`);
  }
  return content;
}

async function withSimulatedWindows<T>(action: () => Promise<T>): Promise<T> {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  if (platform === undefined) {
    throw new Error("process.platform descriptor is unavailable");
  }
  Object.defineProperty(process, "platform", {
    ...platform,
    value: "win32",
  });
  try {
    return await action();
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
}

function regularTarget(
  path: string,
  content: string,
  recreationMode: FileRecreationMode = 0o644,
): TreeEntry {
  return {
    path,
    type: "regular",
    blobOid: publish(content),
    recreationMode,
  };
}

describe("applyTreeToWorkspace", () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cyclotomy-apply-"));
    blobs = new Map();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("refuses to delete an unmanaged descendant for an ancestor type replacement", async () => {
    await mkdir(join(root, "a"));
    await writeFile(join(root, "a", "b"), "secret");
    await writeFile(join(root, ".gitignore"), "");
    const targetScope = gitScope({
      gitignoreSources: [{ path: ".gitignore", contents: "a/b\n" }],
    });
    const unmanaged = await lstat(join(root, "a", "b"));
    const current: WorkspaceSnapshot = {
      ...snapshot([
        regularWorkspaceEntry(".gitignore", ""),
      ]),
      excludedOccupancies: [{
        path: "a/b",
        kind: "regular",
        dev: unmanaged.dev,
        ino: unmanaged.ino,
      }],
      scope: targetScope,
    };
    const target: TreeManifest = {
      format: TREE_MANIFEST_FORMAT,
      entries: [
        regularTarget(".gitignore", "a/b\n"),
        regularTarget("a", "target"),
      ],
      scope: targetScope,
    };

    await expect(
      applyTreeToWorkspace(root, target, readBlob, current),
    ).rejects.toThrow(/unmanaged descendant "a\/b"/u);
    expect(await readFile(join(root, "a", "b"), "utf8")).toBe("secret");
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe("");
  });

  it.each([
    {
      name: "an ignored same-name regular blocks a target implicit directory",
      policy: "p\n!p/\n!p/child\n",
      seed: async () => {
        await writeFile(join(root, "p"), "ignored current file");
      },
      targetEntry: () => regularTarget("p/child", "target child"),
      blockerPath: "p",
      targetPath: "p",
    },
    {
      name: "an ignored descendant blocks a target regular file",
      policy: "p/hidden\n",
      seed: async () => {
        await mkdir(join(root, "p"));
        await writeFile(join(root, "p", "managed"), "managed child");
        await writeFile(join(root, "p", "hidden"), "ignored child");
      },
      targetEntry: () => regularTarget("p", "target file"),
      blockerPath: "p/hidden",
      targetPath: "p",
    },
    {
      name: "a wholly ignored directory blocks a target symlink",
      policy: "p/\n",
      seed: async () => {
        await mkdir(join(root, "p"));
        await writeFile(join(root, "p", "hidden"), "unread subtree");
      },
      targetEntry: (): TreeEntry => ({
        path: "p",
        type: "symlink",
        target: "destination",
        symlinkKind: null,
      }),
      blockerPath: "p",
      targetPath: "p",
    },
  ])("preflights $name before every mutation", async ({
    policy,
    seed,
    targetEntry,
    blockerPath,
    targetPath,
  }) => {
    await writeFile(join(root, ".gitignore"), policy);
    await writeFile(join(root, "delete-me"), "must survive preflight");
    await seed();
    const scope = gitScope({
      gitignoreSources: [{ path: ".gitignore", contents: policy }],
    });
    const target: TreeManifest = {
      format: TREE_MANIFEST_FORMAT,
      entries: [
        regularTarget(".gitignore", policy),
        targetEntry(),
      ],
      scope,
    };
    const current = await scanWorkspaceForScope(root, scope);

    const plan = planWorkspaceRestore(current, target);
    expect(plan.scopeBlockers).toContainEqual({
      path: blockerPath,
      targetPath,
    });
    await expect(
      applyTreeToWorkspace(root, target, readBlob, current),
    ).rejects.toThrow(/unmanaged descendant/u);

    expect(await readFile(join(root, "delete-me"), "utf8"))
      .toBe("must survive preflight");
    if (blockerPath === "p") {
      expect(await lstat(join(root, "p"))).toBeDefined();
    } else {
      expect(await readFile(join(root, blockerPath), "utf8"))
        .toBe("ignored child");
      expect(await readFile(join(root, "p", "managed"), "utf8"))
        .toBe("managed child");
    }
  }, 15_000);

  it("preflights excluded-occupancy identity drift before every mutation", async () => {
    const policy = "p\n!p/\n!p/child\n";
    await writeFile(join(root, ".gitignore"), policy);
    await writeFile(join(root, "delete-me"), "must survive preflight");
    await writeFile(join(root, "p"), "observed ignored file");
    const scope = gitScope({
      gitignoreSources: [{ path: ".gitignore", contents: policy }],
    });
    const target: TreeManifest = {
      format: TREE_MANIFEST_FORMAT,
      entries: [
        regularTarget(".gitignore", policy),
        regularTarget("p/child", "target child"),
      ],
      scope,
    };
    const current = await scanWorkspaceForScope(root, scope);
    await rename(join(root, "p"), join(root, "p-observed"));
    await writeFile(join(root, "p"), "replacement ignored file");

    await expect(
      applyTreeToWorkspace(root, target, readBlob, current),
    ).rejects.toThrow(/stale replacement preflight/u);
    await expectRegular("delete-me", "must survive preflight");
    await expectRegular("p", "replacement ignored file");
  });

  it("preflights occupancy that appears after a real scan", async () => {
    const policy = "p\n!p/\n!p/child\n";
    await writeFile(join(root, ".gitignore"), policy);
    await writeFile(join(root, "delete-me"), "must survive preflight");
    const scope = gitScope({
      gitignoreSources: [{ path: ".gitignore", contents: policy }],
    });
    const target: TreeManifest = {
      format: TREE_MANIFEST_FORMAT,
      entries: [
        regularTarget(".gitignore", policy),
        regularTarget("p/child", "target child"),
      ],
      scope,
    };
    const current = await scanWorkspaceForScope(root, scope);
    expect(planWorkspaceRestore(current, target).scopeBlockers).toEqual([]);
    await writeFile(join(root, "p"), "late ignored file");

    await expect(
      applyTreeToWorkspace(root, target, readBlob, current),
    ).rejects.toThrow(/replacement namespace changed/u);
    await expectRegular("delete-me", "must survive preflight");
    await expectRegular("p", "late ignored file");
  });

  it("refuses a current inventory captured under a different scope", async () => {
    const currentEntry = await seedRegular("keep.txt", "current");
    const current = snapshot([currentEntry]);
    const target: TreeManifest = {
      format: TREE_MANIFEST_FORMAT,
      entries: [regularTarget("keep.txt", "target")],
      scope: gitScope({ ignoreCase: true }),
    };

    await expect(
      applyTreeToWorkspace(root, target, readBlob, current),
    ).rejects.toThrow(/scope-mismatch/u);
    await expectRegular("keep.txt", "current");
  });

  async function seedRegular(
    path: string,
    content: string,
    recreationMode = 0o644,
  ): Promise<WorkspaceEntry> {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
    if (process.platform !== "win32") {
      await chmod(absolute, recreationMode);
    }
    return regularWorkspaceEntry(
      path,
      content,
      process.platform === "win32" ? null : recreationMode,
    );
  }

  async function seedSymlink(
    path: string,
    target: string,
  ): Promise<WorkspaceEntry> {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await symlink(target, absolute);
    return symlinkWorkspaceEntry(path, target);
  }

  it("refuses an incomplete inventory before a recovered path can be deleted", async () => {
    await writeFile(join(root, "recovered.txt"), "still here");
    const incompleteCurrent: WorkspaceSnapshot = {
      ...snapshot([]),
      entries: [],
      scope: completeScope,
      problems: [
        {
          path: "recovered.txt",
          kind: "read-failed",
          detail: "permission denied during inventory",
        },
      ],
    };

    await expect(
      applyTreeToWorkspace(
        root,
        manifest([]),
        readBlob,
        incompleteCurrent,
      ),
    ).rejects.toThrow(/incomplete current workspace scan/);
    expect(await readFile(join(root, "recovered.txt"), "utf8")).toBe(
      "still here",
    );
  });

  it("applies through a symlinked workspace root without following child symlinks", async () => {
    const parent = await mkdtemp(join(tmpdir(), "cyclotomy-apply-link-"));
    const actual = join(parent, "actual");
    const linked = join(parent, "linked");
    await mkdir(actual);
    await symlink(actual, linked);
    try {
      const report = await applyTreeToWorkspace(
        linked,
        manifest([regularTarget("created.txt", "target")]),
        readBlob,
        await scanRealWorkspace(linked),
      );

      expect(await readFile(join(actual, "created.txt"), "utf8")).toBe(
        "target",
      );
      expect(report.created).toEqual(["created.txt"]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("refuses when a symlinked workspace root is retargeted after inventory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "cyclotomy-apply-retarget-"));
    const first = join(parent, "first");
    const second = join(parent, "second");
    const linked = join(parent, "linked");
    await mkdir(first);
    await mkdir(second);
    await symlink(first, linked);
    const observed = await scanRealWorkspace(linked);
    await unlink(linked);
    await symlink(second, linked);
    try {
      await expect(
        applyTreeToWorkspace(
          linked,
          manifest([regularTarget("created.txt", "target")]),
          readBlob,
          observed,
        ),
      ).rejects.toThrow(/root changed since.*scanned/);
      await expect(readFile(join(second, "created.txt"))).rejects.toThrow();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("preflights target-explicit paths absent from the current inventory", async () => {
    await seedRegular("hidden.txt", "unobserved current bytes");
    await seedSymlink("hidden-link", "current-target");
    const deleteMe = await seedRegular("delete-me", "must survive preflight");
    const target = manifest([
      regularTarget("hidden.txt", "checkpoint bytes"),
      {
        path: "hidden-link",
        type: "symlink",
        target: "checkpoint-target",
        symlinkKind: process.platform === "win32" ? "file" : null,
      },
    ]);

    await expect(applyTreeToWorkspace(
      root,
      target,
      readBlob,
      snapshot([deleteMe]),
    )).rejects.toThrow(/replacement namespace changed/u);

    await expectRegular("hidden.txt", "unobserved current bytes");
    expect(await readlink(join(root, "hidden-link"))).toBe("current-target");
    await expectRegular("delete-me", "must survive preflight");
  });

  it("preserves files changed after a real scan instead of deleting or replacing them", async () => {
    await writeFile(join(root, "delete.txt"), "observed delete");
    await writeFile(join(root, "update.txt"), "observed update");
    const current = await scanRealWorkspace(root);
    await writeFile(join(root, "delete.txt"), "late delete bytes");
    await writeFile(join(root, "update.txt"), "late update bytes");

    const report = await applyTreeToWorkspace(
      root,
      manifest([regularTarget("update.txt", "checkpoint bytes")]),
      readBlob,
      current,
    );

    expect(await readFile(join(root, "delete.txt"), "utf8")).toBe(
      "late delete bytes",
    );
    expect(await readFile(join(root, "update.txt"), "utf8")).toBe(
      "late update bytes",
    );
    expect(report.deleted).toEqual([]);
    expect(report.updated).toEqual([]);
    expect(report.problems.map((problem) => problem.path).sort()).toEqual([
      "delete.txt",
      "update.txt",
    ]);
  });

  it("refuses a replacement workspace root even when its pathname is unchanged", async () => {
    await writeFile(join(root, "observed.txt"), "observed");
    const current = await scanRealWorkspace(root);
    const oldRoot = `${root}-old`;
    await rename(root, oldRoot);
    await mkdir(root);
    await writeFile(join(root, "late.txt"), "late");
    try {
      await expect(
        applyTreeToWorkspace(root, manifest([]), readBlob, current),
      ).rejects.toThrow(/workspace directory changed since scan: \./u);
      expect(await readFile(join(root, "late.txt"), "utf8")).toBe("late");
      expect(await readFile(join(oldRoot, "observed.txt"), "utf8")).toBe(
        "observed",
      );
    } finally {
      await rm(oldRoot, { recursive: true, force: true });
    }
  });

  it("never follows an observed ancestor replaced by an external symlink", async () => {
    await mkdir(join(root, "dir"));
    await writeFile(join(root, "dir", "victim.txt"), "observed");
    const current = await scanRealWorkspace(root);
    const observedDirectory = join(root, "observed-dir");
    const outside = await mkdtemp(join(tmpdir(), "cyclotomy-apply-outside-"));
    await writeFile(join(outside, "victim.txt"), "outside late bytes");
    await rename(join(root, "dir"), observedDirectory);
    await symlink(outside, join(root, "dir"));
    try {
      const report = await applyTreeToWorkspace(
        root,
        manifest([]),
        readBlob,
        current,
      );

      expect(await readFile(join(outside, "victim.txt"), "utf8")).toBe(
        "outside late bytes",
      );
      expect(await readFile(join(observedDirectory, "victim.txt"), "utf8")).toBe(
        "observed",
      );
      expect(report.deleted).toEqual([]);
      expect(report.problems.some((problem) =>
        problem.detail.includes("workspace directory changed since scan: dir")
      )).toBe(true);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("revalidates an observed ancestor immediately before creating a directory", async () => {
    await mkdir(join(root, "safe"));
    const current = await scanRealWorkspace(root);
    const observed = current.directoryObservations.find(
      (entry) => entry.path === "safe",
    );
    expect(observed).toBeDefined();
    const moved = join(root, "safe-observed");
    const outside = await mkdtemp(join(tmpdir(), "cyclotomy-apply-outside-"));
    let swapped = false;
    const racedCurrent: WorkspaceSnapshot = {
      ...current,
      directoryObservations: current.directoryObservations.map((entry) =>
        entry.path === "safe"
          ? {
              path: entry.path,
              get dev(): number {
                if (!swapped) {
                  renameSync(join(root, "safe"), moved);
                  symlinkSync(
                    outside,
                    join(root, "safe"),
                    process.platform === "win32" ? "junction" : undefined,
                  );
                  swapped = true;
                }
                return observed!.dev;
              },
              get ino(): number {
                return observed!.ino;
              },
            }
          : entry
      ),
    };

    try {
      await expect(applyTreeToWorkspace(
        root,
        manifest([regularTarget("safe/new/file.txt", "checkpoint")]),
        readBlob,
        racedCurrent,
      )).rejects.toThrow(/replacement namespace changed/u);

      expect(swapped).toBe(true);
      await expect(lstat(join(outside, "new"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("never writes through an ignored symlink target ancestor", async () => {
    const outside = await mkdtemp(join(tmpdir(), "cyclotomy-apply-outside-"));
    await symlink(outside, join(root, "sub"));
    const deleteMe = await seedRegular("delete-me", "must survive preflight");
    const target = manifest([
      regularTarget("sub/new.txt", "must stay inside"),
    ]);
    try {
      await expect(applyTreeToWorkspace(
        root,
        target,
        readBlob,
        snapshot([deleteMe]),
      )).rejects.toThrow(/replacement namespace changed/u);

      await expect(readFile(join(outside, "new.txt"))).rejects.toThrow();
      expect((await lstat(join(root, "sub"))).isSymbolicLink()).toBe(true);
      await expectRegular("delete-me", "must survive preflight");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("does not enter an excluded directory represented only by occupancy", async () => {
    await writeFile(join(root, ".gitignore"), "hidden/\n");
    await mkdir(join(root, "hidden"));
    await writeFile(join(root, "hidden", "file.txt"), "unobserved");
    const hiddenDirectory = await lstat(join(root, "hidden"));
    const target: TreeManifest = {
      format: TREE_MANIFEST_FORMAT,
      entries: [
        regularTarget(".gitignore", ""),
        regularTarget("hidden/file.txt", "checkpoint"),
      ],
      scope: gitScope({
        gitignoreSources: [{ path: ".gitignore", contents: "" }],
      }),
    };
    const scanned = await scanRealWorkspace(root);
    // The target-scope scanner omits unmanaged descendants from entries and
    // carries their namespace identity exclusively as an occupancy proof.
    const current: WorkspaceSnapshot = {
      ...scanned,
      entries: scanned.entries.filter((entry) =>
        entry.path !== "hidden/file.txt"
      ),
      excludedOccupancies: [{
        path: "hidden",
        kind: "directory",
        dev: hiddenDirectory.dev,
        ino: hiddenDirectory.ino,
      }],
      scope: target.scope,
    };

    const probe = await open(join(root, "sync-hidden-probe"), "w");
    const prototype = Object.getPrototypeOf(probe) as {
      sync: FileHandle["sync"];
    };
    await probe.close();
    await unlink(join(root, "sync-hidden-probe"));
    const originalSync = prototype.sync;
    let hiddenDirectorySynced = false;
    const syncSpy = vi.spyOn(prototype, "sync").mockImplementation(
      async function (this: FileHandle): Promise<void> {
        const metadata = await this.stat();
        if (
          metadata.isDirectory() &&
          metadata.dev === hiddenDirectory.dev &&
          metadata.ino === hiddenDirectory.ino
        ) {
          hiddenDirectorySynced = true;
        }
        await originalSync.call(this);
      },
    );

    try {
      await expect(
        applyTreeToWorkspace(root, target, readBlob, current),
      ).rejects.toThrow(/unmanaged descendant "hidden"/u);
    } finally {
      syncSpy.mockRestore();
    }

    expect(await readFile(join(root, ".gitignore"), "utf8"))
      .toBe("hidden/\n");
    expect(await readFile(join(root, "hidden", "file.txt"), "utf8")).toBe(
      "unobserved",
    );
    expect(hiddenDirectorySynced).toBe(false);

    const retry = await applyTreeToWorkspace(
      root,
      target,
      readBlob,
      await scanWorkspaceForScope(root, target.scope),
    );
    expect(retry.problems).toEqual([]);
    expect(await readFile(join(root, "hidden", "file.txt"), "utf8")).toBe(
      "checkpoint",
    );
  });

  // Minimal rescan, mirroring what the caller's scanner would produce.
  async function scanWorkspace(
    relative: string,
  ): Promise<WorkspaceEntry[]> {
    const absolute = join(root, relative);
    const dirents = await readdir(absolute, { withFileTypes: true });
    const entries: WorkspaceEntry[] = [];
    for (const dirent of dirents) {
      const child =
        relative === "" ? dirent.name : `${relative}/${dirent.name}`;
      const childAbsolute = join(absolute, dirent.name);
      if (dirent.isDirectory()) {
        entries.push(...(await scanWorkspace(child)));
      } else if (dirent.isSymbolicLink()) {
        entries.push(
          symlinkWorkspaceEntry(child, await readlink(childAbsolute)),
        );
      } else if (dirent.isFile()) {
        const content = await readFile(childAbsolute);
        const metadata = await lstat(childAbsolute);
        entries.push({
          path: child,
          kind: "regular",
          recreationMode:
            process.platform === "win32" ? null : metadata.mode & 0o777,
          byteLength: content.byteLength,
          sha256: sha256Hex(content),
          sourcePath: childAbsolute,
        });
      }
    }
    return entries.sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
  }

  async function expectRegular(
    path: string,
    content: string,
  ): Promise<void> {
    const absolute = join(root, path);
    const metadata = await lstat(absolute);
    expect(metadata.isFile()).toBe(true);
    expect(metadata.isSymbolicLink()).toBe(false);
    expect(await readFile(absolute, "utf8")).toBe(content);
  }

  async function expectAbsent(path: string): Promise<void> {
    let code: string | undefined;
    try {
      await lstat(join(root, path));
    } catch (error) {
      code = (error as NodeJS.ErrnoException).code;
    }
    // ENOENT: the path itself is gone; ENOTDIR: an ancestor is now a file.
    expect(code, `expected ${path} to be absent`).toMatch(
      /^(ENOENT|ENOTDIR)$/,
    );
  }

  it("creates files, symlinks, and exact recreation modes", async () => {
    const linkTarget = join("..", "src", "index.ts");
    const target = manifest([
      regularTarget("src/index.ts", "console.log('hi')\n", 0o755),
      {
        path: "bin/tool",
        type: "symlink",
        target: linkTarget,
        symlinkKind: process.platform === "win32" ? "file" : null,
      },
      regularTarget("README.md", "# demo\n"),
      regularTarget(".gitignore", "node_modules/\n"),
    ]);
    const report = await applyTreeToWorkspace(
      root,
      target,
      readBlob,
      snapshot([]),
    );

    await expectRegular("src/index.ts", "console.log('hi')\n");
    await expectRegular("README.md", "# demo\n");
    await expectRegular(".gitignore", "node_modules/\n");
    expect(await readlink(join(root, "bin/tool"))).toBe(linkTarget);
    // `bin` was only an implicit ancestor of the symlink entry.
    expect((await lstat(join(root, "bin"))).isDirectory()).toBe(true);
    if (process.platform !== "win32") {
      expect(
        (await lstat(join(root, "src/index.ts"))).mode & 0o777,
      ).toBe(0o755);
      expect(
        (await lstat(join(root, "README.md"))).mode & 0o777,
      ).toBe(0o644);
    }

    expect(report.created).toEqual([
      ".gitignore",
      "README.md",
      "bin/tool",
      "src/index.ts",
    ]);
    expect(report.updated).toEqual([]);
    expect(report.deleted).toEqual([]);
    expect(report.unchangedCount).toBe(0);
    expect(report.problems).toEqual([]);
  });

  it("updates existing file content", async () => {
    const current = await seedRegular("a.txt", "old\n");
    const target = manifest([regularTarget("a.txt", "new\n")]);
    const report = await applyTreeToWorkspace(
      root,
      target,
      readBlob,
      snapshot([current]),
    );

    await expectRegular("a.txt", "new\n");
    expect(report.created).toEqual([]);
    expect(report.updated).toEqual(["a.txt"]);
    expect(report.deleted).toEqual([]);
    expect(report.unchangedCount).toBe(0);
    expect(report.problems).toEqual([]);
  });

  it("rewrites existing regular files without replacing their inode or mode", async (context) => {
    context.skip(
      process.platform === "win32",
      "Windows has no portable POSIX recreation mode",
    );
    const cases = [
      { path: "private-group.txt", mode: 0o640 },
      { path: "executable.txt", mode: 0o711 },
      { path: "sticky.txt", mode: 0o1640 },
    ] as const;
    const current: WorkspaceEntry[] = [];
    const target: TreeEntry[] = [];
    const beforeByPath = new Map<string, Awaited<ReturnType<typeof lstat>>>();
    for (const item of cases) {
      current.push(
        await seedRegular(
          item.path,
          `old ${item.path}\n`,
          item.mode,
        ),
      );
      await chmod(join(root, item.path), item.mode);
      beforeByPath.set(item.path, await lstat(join(root, item.path)));
      // A deliberately different hint proves that an existing file's current
      // mode wins over target recreation metadata.
      target.push(
        regularTarget(item.path, `new ${item.path}\n`, 0o600),
      );
    }

    const report = await applyTreeToWorkspace(
      root,
      manifest(target),
      readBlob,
      snapshot(current),
    );

    for (const item of cases) {
      expect(await readFile(join(root, item.path), "utf8")).toBe(
        `new ${item.path}\n`,
      );
      const before = beforeByPath.get(item.path)!;
      const after = await lstat(join(root, item.path));
      expect({ dev: after.dev, ino: after.ino }).toEqual({
        dev: before.dev,
        ino: before.ino,
      });
      expect({ uid: after.uid, gid: after.gid }).toEqual({
        uid: before.uid,
        gid: before.gid,
      });
      expect(after.mode & 0o7777).toBe(item.mode);
    }
    expect(report.created).toEqual([]);
    expect(report.updated).toEqual(cases.map((item) => item.path).sort());
    expect(report.problems).toEqual([]);
  });

  it("leaves a concurrent mode change alone during an in-place rewrite", async (context) => {
    context.skip(
      process.platform === "win32",
      "Windows has no portable POSIX recreation mode",
    );
    const path = join(root, "mode-race.txt");
    const existing = await seedRegular("mode-race.txt", "original", 0o640);
    await chmod(path, 0o640);
    const original = await lstat(path);
    const probe = await open(join(root, "mode-race-probe"), "w");
    const prototype = Object.getPrototypeOf(probe) as {
      sync: FileHandle["sync"];
    };
    await probe.close();
    await unlink(join(root, "mode-race-probe"));
    const originalSync = prototype.sync;
    let injected = false;
    const spy = vi.spyOn(prototype, "sync").mockImplementation(
      async function (this: FileHandle): Promise<void> {
        const metadata = await this.stat();
        await originalSync.call(this);
        if (
          !injected &&
          metadata.isFile() &&
          metadata.dev === original.dev &&
          metadata.ino === original.ino
        ) {
          injected = true;
          await chmod(path, 0o400);
        }
      },
    );

    let report:
      | Awaited<ReturnType<typeof applyTreeToWorkspace>>
      | undefined;
    try {
      report = await applyTreeToWorkspace(
        root,
        manifest([regularTarget("mode-race.txt", "replacement", 0o711)]),
        readBlob,
        snapshot([existing]),
      );
    } finally {
      spy.mockRestore();
    }

    expect(injected).toBe(true);
    expect(await readFile(path, "utf8")).toBe("replacement");
    expect((await lstat(path)).mode & 0o777).toBe(0o400);
    expect(report!.updated).toEqual(["mode-race.txt"]);
    expect(report!.problems).toEqual([]);
    expect(
      (await readdir(root)).filter((name) => name.startsWith(".cyclotomy-")),
    ).toEqual([]);
  });

  it("reports a pathname replacement raced against an in-place rewrite", async (context) => {
    context.skip(
      process.platform === "win32",
      "renaming an open file is not portable on Windows",
    );
    const path = join(root, "raced.txt");
    const moved = join(root, "raced-original.txt");
    const existing = await seedRegular("raced.txt", "original");
    const original = await lstat(path);
    const probe = await open(join(root, "race-probe"), "w");
    const prototype = Object.getPrototypeOf(probe) as {
      sync: FileHandle["sync"];
    };
    await probe.close();
    await unlink(join(root, "race-probe"));
    const originalSync = prototype.sync;
    let injected = false;
    const spy = vi.spyOn(prototype, "sync").mockImplementation(
      async function (this: FileHandle): Promise<void> {
        const metadata = await this.stat();
        await originalSync.call(this);
        if (
          !injected &&
          metadata.isFile() &&
          metadata.dev === original.dev &&
          metadata.ino === original.ino
        ) {
          injected = true;
          await rename(path, moved);
          await writeFile(path, "racer");
        }
      },
    );

    let report:
      | Awaited<ReturnType<typeof applyTreeToWorkspace>>
      | undefined;
    try {
      report = await applyTreeToWorkspace(
        root,
        manifest([regularTarget("raced.txt", "checkpoint")]),
        readBlob,
        snapshot([existing]),
      );
    } finally {
      spy.mockRestore();
    }

    expect(injected).toBe(true);
    expect(await readFile(path, "utf8")).toBe("racer");
    expect(await readFile(moved, "utf8")).toBe("checkpoint");
    expect(report!.updated).toEqual([]);
    expect(report!.problems).toEqual([
      expect.objectContaining({
        path: "raced.txt",
        kind: "write-failed",
        detail: expect.stringContaining(
          "pathname no longer names the opened inode",
        ),
      }),
    ]);
  });

  it("keeps an existing macOS extended attribute on the same inode", async (context) => {
    context.skip(
      process.platform !== "darwin",
      "the portable Node API does not expose extended attributes",
    );
    const path = join(root, "xattr.txt");
    const existing = await seedRegular("xattr.txt", "original", 0o640);
    await execFileAsync("/usr/bin/xattr", [
      "-w",
      "com.cyclotomy.test",
      "preserved",
      path,
    ]);
    const before = await lstat(path);

    const report = await applyTreeToWorkspace(
      root,
      manifest([regularTarget("xattr.txt", "replacement", 0o711)]),
      readBlob,
      snapshot([existing]),
    );

    const after = await lstat(path);
    const attribute = await execFileAsync("/usr/bin/xattr", [
      "-p",
      "com.cyclotomy.test",
      path,
    ]);
    expect(await readFile(path, "utf8")).toBe("replacement");
    expect({ dev: after.dev, ino: after.ino }).toEqual({
      dev: before.dev,
      ino: before.ino,
    });
    expect(attribute.stdout.trim()).toBe("preserved");
    expect(report.problems).toEqual([]);
  });

  it("uses recorded modes only when regular files are recreated", async (context) => {
    context.skip(
      process.platform === "win32",
      "Windows has no portable POSIX recreation mode",
    );
    const replaced = await seedSymlink("replace", "old-target");
    const report = await applyTreeToWorkspace(
      root,
      manifest([
        regularTarget("missing", "created\n", 0o640),
        regularTarget("replace", "regular now\n", 0o711),
      ]),
      readBlob,
      snapshot([replaced]),
    );

    expect(await readFile(join(root, "missing"), "utf8")).toBe("created\n");
    expect((await lstat(join(root, "missing"))).mode & 0o777).toBe(0o640);
    expect(await readFile(join(root, "replace"), "utf8")).toBe(
      "regular now\n",
    );
    expect((await lstat(join(root, "replace"))).mode & 0o777).toBe(0o711);
    expect(report.created).toEqual(["missing"]);
    expect(report.updated).toEqual(["replace"]);
    expect(report.problems).toEqual([]);
  });

  it("ignores recreation-mode-only changes on an existing file", async () => {
    const content = "#!/bin/sh\necho hi\n";
    const current = await seedRegular("run.sh", content, 0o644);
    const target = manifest([regularTarget("run.sh", content, 0o755)]);
    const report = await applyTreeToWorkspace(
      root,
      target,
      readBlob,
      snapshot([current]),
    );

    await expectRegular("run.sh", content);
    if (process.platform !== "win32") {
      expect(
        (await lstat(join(root, "run.sh"))).mode & 0o777,
      ).toBe(0o644);
    }
    expect(report.created).toEqual([]);
    expect(report.updated).toEqual([]);
    expect(report.unchangedCount).toBe(1);
    expect(report.problems).toEqual([]);
  });

  it("does not publish a newly recreated file when temp-file chmod fails", async (context) => {
    context.skip(
      process.platform === "win32",
      "Windows does not apply POSIX recreation modes",
    );
    const probe = await open(join(root, "chmod-probe"), "w");
    const prototype = Object.getPrototypeOf(probe) as {
      chmod: FileHandle["chmod"];
    };
    await probe.close();
    await unlink(join(root, "chmod-probe"));
    const spy = vi.spyOn(prototype, "chmod").mockRejectedValueOnce(
      new Error("injected temp chmod failure"),
    );

    const report = await applyTreeToWorkspace(
      root,
      manifest([regularTarget("safe.txt", "replacement", 0o711)]),
      readBlob,
      snapshot([]),
    );
    spy.mockRestore();

    await expect(lstat(join(root, "safe.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(report.problems).toEqual([
      expect.objectContaining({
        path: "safe.txt",
        detail: expect.stringContaining("injected temp chmod failure"),
      }),
    ]);
    expect(
      (await readdir(root)).filter((name) => name.startsWith(".cyclotomy-")),
    ).toEqual([]);
  });

  it("uses a safe host default when a recreation mode is unavailable", async (context) => {
    context.skip(
      process.platform === "win32",
      "Windows does not expose a portable POSIX mode",
    );
    const report = await applyTreeToWorkspace(
      root,
      manifest([regularTarget("safe-default.txt", "content", null)]),
      readBlob,
      snapshot([]),
    );

    const mode = (await lstat(join(root, "safe-default.txt"))).mode & 0o777;
    expect(mode & ~0o600).toBe(0);
    expect(await readFile(join(root, "safe-default.txt"), "utf8")).toBe(
      "content",
    );
    expect(report.problems).toEqual([]);
  });

  it("restores a legal near-NAME_MAX basename with a short temp name", async () => {
    const name = "x".repeat(240);
    const existing = await seedRegular(name, "old");

    const report = await applyTreeToWorkspace(
      root,
      manifest([regularTarget(name, "new")]),
      readBlob,
      snapshot([existing]),
    );

    expect(await readFile(join(root, name), "utf8")).toBe("new");
    expect(report.problems).toEqual([]);
  });

  it("keeps an existing symlink when preparing its replacement fails", async (context) => {
    context.skip(
      process.platform === "win32" || process.getuid?.() === 0,
      "portable directory write-denial setup requires an unprivileged POSIX user",
    );
    await symlink("old-target", join(root, "link"));
    const current = symlinkWorkspaceEntry("link", "old-target");
    await chmod(root, 0o555);
    try {
      const report = await applyTreeToWorkspace(
        root,
        manifest([{
          path: "link",
          type: "symlink",
          target: "new-target",
          symlinkKind: null,
        }]),
        readBlob,
        snapshot([current]),
      );

      expect(await readlink(join(root, "link"))).toBe("old-target");
      expect(report.problems).toEqual([
        expect.objectContaining({ path: "link", kind: "write-failed" }),
      ]);
    } finally {
      await chmod(root, 0o755);
    }
  });

  it("preflights a Windows symlink without a recorded target type", async () => {
    const deleteMe = await seedRegular("delete-me", "must survive preflight");
    await expect(withSimulatedWindows(() =>
      applyTreeToWorkspace(
        root,
        manifest([{
          path: "dangling-link",
          type: "symlink",
          target: "missing-directory",
          symlinkKind: null,
        }]),
        readBlob,
        snapshot([deleteMe]),
      )
    )).rejects.toThrow(/without a recorded target type/u);
    await expectAbsent("dangling-link");
    await expectRegular("delete-me", "must survive preflight");
  });

  it("recreates a Windows directory symlink when its type is observable", async () => {
    await mkdir(join(root, "directory-target"));
    const report = await withSimulatedWindows(() =>
      applyTreeToWorkspace(
        root,
        manifest([{
          path: "directory-link",
          type: "symlink",
          target: "directory-target",
          symlinkKind: "directory",
        }]),
        readBlob,
        snapshot([]),
      )
    );

    expect(await readlink(join(root, "directory-link"))).toBe(
      "directory-target",
    );
    expect(report.problems).toEqual([]);
  });

  it("deletes files and symlinks absent from the target", async () => {
    const fileEntry = await seedRegular("gone.txt", "x");
    const linkEntry = await seedSymlink("gone-link", "gone.txt");
    const report = await applyTreeToWorkspace(
      root,
      manifest([]),
      readBlob,
      snapshot([fileEntry, linkEntry]),
    );

    await expectAbsent("gone.txt");
    await expectAbsent("gone-link");
    expect(report.created).toEqual([]);
    expect(report.updated).toEqual([]);
    expect(report.deleted).toEqual(["gone-link", "gone.txt"]);
    expect(report.problems).toEqual([]);
  });

  it("migrates a regular file to a symlink", async () => {
    const current = await seedRegular("link", "payload");
    const target = manifest([
      {
        path: "link",
        type: "symlink",
        target: "elsewhere",
        symlinkKind: process.platform === "win32" ? "file" : null,
      },
    ]);
    const report = await applyTreeToWorkspace(
      root,
      target,
      readBlob,
      snapshot([current]),
    );

    expect((await lstat(join(root, "link"))).isSymbolicLink()).toBe(
      true,
    );
    expect(await readlink(join(root, "link"))).toBe("elsewhere");
    expect(report.updated).toEqual(["link"]);
    expect(report.created).toEqual([]);
    expect(report.deleted).toEqual([]);
    expect(report.problems).toEqual([]);
  });

  it("migrates a symlink to a regular file", async () => {
    const current = await seedSymlink("link", "elsewhere");
    const target = manifest([regularTarget("link", "payload\n")]);
    const report = await applyTreeToWorkspace(
      root,
      target,
      readBlob,
      snapshot([current]),
    );

    await expectRegular("link", "payload\n");
    expect(report.created).toEqual([]);
    expect(report.updated).toEqual(["link"]);
    expect(report.deleted).toEqual([]);
    expect(report.problems).toEqual([]);
  });

  it("retargets an existing symlink", async () => {
    const current = await seedSymlink("link", "old-target");
    const target = manifest([
      {
        path: "link",
        type: "symlink",
        target: "new-target",
        symlinkKind: process.platform === "win32" ? "file" : null,
      },
    ]);
    const report = await applyTreeToWorkspace(
      root,
      target,
      readBlob,
      snapshot([current]),
    );

    expect(await readlink(join(root, "link"))).toBe("new-target");
    expect(report.updated).toEqual(["link"]);
    expect(report.unchangedCount).toBe(0);
    expect(report.problems).toEqual([]);
  });

  it("migrates a regular file to a directory", async () => {
    await seedRegular("sub", "was a file");
    const target = manifest([
      regularTarget("sub/child.txt", "child\n"),
    ]);
    const current = await scanWorkspaceForScope(root, target.scope);
    expect(planWorkspaceRestore(current, target).scopeBlockers).toEqual([]);
    const report = await applyTreeToWorkspace(
      root,
      target,
      readBlob,
      current,
    );

    expect((await lstat(join(root, "sub"))).isDirectory()).toBe(true);
    await expectRegular("sub/child.txt", "child\n");
    expect(report.created).toEqual(["sub/child.txt"]);
    expect(report.updated).toEqual(["sub"]);
    expect(report.deleted).toEqual([]);
    expect(report.problems).toEqual([]);
  });

  it("migrates a file into an implicit parent directory", async () => {
    const current = await seedRegular("a", "was a file");
    const target = manifest([regularTarget("a/b.txt", "nested\n")]);
    const report = await applyTreeToWorkspace(
      root,
      target,
      readBlob,
      snapshot([current]),
    );

    expect((await lstat(join(root, "a"))).isDirectory()).toBe(true);
    await expectRegular("a/b.txt", "nested\n");
    expect(report.created).toEqual(["a/b.txt"]);
    expect(report.updated).toEqual(["a"]);
    expect(report.deleted).toEqual([]);
    expect(report.problems).toEqual([]);
  });

  it("migrates a directory to a regular file", async () => {
    await seedRegular("sub/old.txt", "old\n");
    const target = manifest([regularTarget("sub", "now a file")]);
    const current = await scanWorkspaceForScope(root, target.scope);
    expect(planWorkspaceRestore(current, target).scopeBlockers).toEqual([]);
    const report = await applyTreeToWorkspace(
      root,
      target,
      readBlob,
      current,
    );

    await expectRegular("sub", "now a file");
    await expectAbsent("sub/old.txt");
    expect(report.created).toEqual(["sub"]);
    expect(report.updated).toEqual([]);
    expect(report.deleted).toEqual(["sub/old.txt"]);
    expect(report.problems).toEqual([]);
  });

  it("replaces an observed empty directory with a regular file", async () => {
    await mkdir(join(root, "empty"));
    const current = await scanRealWorkspace(root);

    const report = await applyTreeToWorkspace(
      root,
      manifest([regularTarget("empty", "now a file")]),
      readBlob,
      current,
    );

    await expectRegular("empty", "now a file");
    expect(report.created).toEqual(["empty"]);
    expect(report.problems).toEqual([]);
  });

  it("replaces a nested observed empty subtree with a regular file", async () => {
    await mkdir(join(root, "empty", "nested"), { recursive: true });
    const current = await scanRealWorkspace(root);

    const report = await applyTreeToWorkspace(
      root,
      manifest([regularTarget("empty", "now a file")]),
      readBlob,
      current,
    );

    await expectRegular("empty", "now a file");
    expect(report.created).toEqual(["empty"]);
    expect(report.problems).toEqual([]);
  });

  it("replaces an observed empty directory with a symlink", async (context) => {
    context.skip(
      process.platform === "win32",
      "Windows cannot portably infer or create this symlink type",
    );
    await mkdir(join(root, "empty"));
    const current = await scanRealWorkspace(root);

    const report = await applyTreeToWorkspace(
      root,
      manifest([{
        path: "empty",
        type: "symlink",
        target: "target",
        symlinkKind: null,
      }]),
      readBlob,
      current,
    );

    expect((await lstat(join(root, "empty"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(root, "empty"))).toBe("target");
    expect(report.created).toEqual(["empty"]);
    expect(report.problems).toEqual([]);
  });

  it("never removes content raced into an observed empty directory", async () => {
    await mkdir(join(root, "empty"));
    await writeFile(join(root, "delete-me"), "must survive preflight");
    const current = await scanRealWorkspace(root);
    await writeFile(join(root, "empty", "raced.txt"), "keep");

    await expect(applyTreeToWorkspace(
      root,
      manifest([regularTarget("empty", "target")]),
      readBlob,
      current,
    )).rejects.toThrow(/replacement namespace changed/u);

    expect(await readFile(join(root, "empty", "raced.txt"), "utf8"))
      .toBe("keep");
    await expectRegular("delete-me", "must survive preflight");
  });

  it("never removes content raced into a nested observed empty subtree", async () => {
    await mkdir(join(root, "empty", "nested"), { recursive: true });
    await writeFile(join(root, "delete-me"), "must survive preflight");
    const current = await scanRealWorkspace(root);
    await writeFile(join(root, "empty", "nested", "raced.txt"), "keep");

    await expect(applyTreeToWorkspace(
      root,
      manifest([regularTarget("empty", "target")]),
      readBlob,
      current,
    )).rejects.toThrow(/replacement namespace changed/u);

    expect(
      await readFile(
        join(root, "empty", "nested", "raced.txt"),
        "utf8",
      ),
    ).toBe("keep");
    await expectRegular("delete-me", "must survive preflight");
  });

  it("does not bypass host permissions to rewrite a read-only file", async (context) => {
    context.skip(
      process.platform === "win32" || process.getuid?.() === 0,
      "POSIX mode-bit denial requires an unprivileged process",
    );
    const kept = await seedRegular("ro.txt", "old\n");
    const removed = await seedRegular("ro-gone.txt", "bye\n");
    await chmod(join(root, "ro.txt"), 0o444);
    await chmod(join(root, "ro-gone.txt"), 0o444);
    const target = manifest([regularTarget("ro.txt", "new\n")]);
    const report = await applyTreeToWorkspace(
      root,
      target,
      readBlob,
      snapshot([kept, removed]),
    );

    await expectRegular("ro.txt", "old\n");
    await expectAbsent("ro-gone.txt");
    expect(report.created).toEqual([]);
    expect(report.updated).toEqual([]);
    expect(report.deleted).toEqual(["ro-gone.txt"]);
    expect(report.problems).toEqual([
      expect.objectContaining({
        path: "ro.txt",
        kind: "write-failed",
      }),
    ]);
  });

  it("prunes empty directories and keeps directories with unmanaged content", async () => {
    const inEmpty = await seedRegular("empty/x.txt", "x");
    const inKeep = await seedRegular("keep/y.txt", "y");
    // On disk but deliberately not listed in the snapshot.
    await writeFile(join(root, "keep/unmanaged.txt"), "stay");
    const report = await applyTreeToWorkspace(
      root,
      manifest([]),
      readBlob,
      snapshot([inEmpty, inKeep]),
    );

    await expectAbsent("empty");
    await expectAbsent("empty/x.txt");
    await expectAbsent("keep/y.txt");
    expect((await lstat(join(root, "keep"))).isDirectory()).toBe(true);
    await expectRegular("keep/unmanaged.txt", "stay");
    expect(report.created).toEqual([]);
    expect(report.updated).toEqual([]);
    expect(report.deleted).toEqual(["empty/x.txt", "keep/y.txt"]);
    expect(report.problems).toEqual([]);
  });

  it("refuses git-internal paths on both sides", async () => {
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(
      join(root, ".git/HEAD"),
      "ref: refs/heads/main\n",
    );
    const currentGit = regularWorkspaceEntry(
      ".git/HEAD",
      "ref: refs/heads/main\n",
    );
    const target = manifest([
      regularTarget(".git/HEAD", "other\n"),
      regularTarget(".git/config", "[core]\n"),
      regularTarget("sub/.GIT/hooks/pre-commit", "hook"),
      regularTarget("ok.txt", "fine\n"),
    ]);
    const report = await applyTreeToWorkspace(
      root,
      target,
      readBlob,
      snapshot([currentGit]),
    );

    await expectRegular("ok.txt", "fine\n");
    // The on-disk git-internal file must survive untouched.
    await expectRegular(
      ".git/HEAD",
      "ref: refs/heads/main\n",
    );
    await expectAbsent(".git/config");
    await expectAbsent("sub");
    expect(report.created).toEqual(["ok.txt"]);
    expect(report.deleted).toEqual([]);
    const refused = report.problems.filter(
      (problem) => problem.detail === "git-internal path refused",
    );
    // `.git/HEAD` appears on both sides but is reported once.
    expect(refused.map((problem) => problem.path).sort()).toEqual([
      ".git/HEAD",
      ".git/config",
      "sub/.GIT/hooks/pre-commit",
    ]);
    expect(
      refused.every((problem) => problem.kind === "write-failed"),
    ).toBe(true);
    expect(report.problems).toHaveLength(3);
  });

  it("is idempotent across consecutive runs", async () => {
    const linkTarget = join("src", "deep", "mod.ts");
    const target = manifest([
      regularTarget("src/deep/mod.ts", "export {}\n"),
      regularTarget("run.sh", "#!/bin/sh\nexit 0\n", 0o755),
      {
        path: "link",
        type: "symlink",
        target: linkTarget,
        symlinkKind: process.platform === "win32" ? "file" : null,
      },
      regularTarget("README.md", "docs\n"),
    ]);
    const first = await applyTreeToWorkspace(
      root,
      target,
      readBlob,
      snapshot([]),
    );
    expect(first.problems).toEqual([]);

    const rescanned = snapshot(await scanWorkspace(""));
    const second = await applyTreeToWorkspace(
      root,
      target,
      readBlob,
      rescanned,
    );
    expect(second.created).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.deleted).toEqual([]);
    expect(second.unchangedCount).toBe(4);
    expect(second.problems).toEqual([]);
  });

  it("records write-failed when a blob read fails and continues", async () => {
    const good = regularTarget("good.txt", "good\n");
    const bad = regularTarget("bad.txt", "bad\n");
    if (bad.type !== "regular") {
      throw new Error("unreachable");
    }
    blobs.delete(bad.blobOid);
    // `bad.txt` sorts before `good.txt`, so it fails first.
    const target = manifest([good, bad]);
    const report = await applyTreeToWorkspace(
      root,
      target,
      readBlob,
      snapshot([]),
    );

    await expectRegular("good.txt", "good\n");
    await expectAbsent("bad.txt");
    expect(report.created).toEqual(["good.txt"]);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toMatchObject({
      path: "bad.txt",
      kind: "write-failed",
    });
    // No temporary file is left behind.
    expect((await readdir(root)).sort()).toEqual(["good.txt"]);
  });

  it("throws ApplyError when the root is missing or not a directory", async () => {
    await expect(
      applyTreeToWorkspace(
        join(root, "missing"),
        manifest([]),
        readBlob,
        snapshot([]),
      ),
    ).rejects.toBeInstanceOf(ApplyError);

    await writeFile(join(root, "file-root"), "x");
    await expect(
      applyTreeToWorkspace(
        join(root, "file-root"),
        manifest([]),
        readBlob,
        snapshot([]),
      ),
    ).rejects.toBeInstanceOf(ApplyError);
  });
});
