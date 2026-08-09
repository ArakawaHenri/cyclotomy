import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  encodeTreeManifest,
  type TreeEntry,
} from "../src/infrastructure/tree-manifest.ts";
import {
  ScanError,
  scanWorkspace,
  workspaceSnapshotsEqual,
  type WorkspaceSnapshot,
} from "../src/infrastructure/workspace-scan.ts";
const execFileAsync = promisify(execFile);

const sha256 = (content: string): string =>
  createHash("sha256").update(content).digest("hex");

const pathsOf = (snapshot: WorkspaceSnapshot): string[] =>
  snapshot.entries.map((entry) => entry.path);

const roots: string[] = [];

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cyclotomy-scan-"));
  roots.push(root);
  return root;
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

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});
describe("workspace scanner", () => {
  it("accepts a workspace root reached through a symlink", async () => {
    const parent = await mkdtemp(join(tmpdir(), "cyclotomy-scan-link-"));
    roots.push(parent);
    const actual = join(parent, "actual");
    const linked = join(parent, "linked");
    await mkdir(actual);
    await writeFile(join(actual, "a.txt"), "through-link");
    await symlink(actual, linked);

    const snapshot = await scanWorkspace(linked);

    expect(snapshot.problems).toEqual([]);
    expect(snapshot.entries.map((entry) => entry.path)).toEqual(["a.txt"]);
  });

  it("captures regular bytes, recreation modes, symlink targets, and dotfiles", async () => {
    const root = await workspace();
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.txt"), "alpha");
    await writeFile(join(root, "run"), "#!/bin/sh\n");
    await chmod(join(root, "run"), 0o755);
    await symlink("src/a.txt", join(root, "pointer"));
    await writeFile(join(root, ".env"), "secret");

    const snapshot = await scanWorkspace(root);
    const canonicalRoot = await realpath(root);
    expect(snapshot).toEqual({
      problems: [],
      rootPath: canonicalRoot,
      excludedOccupancies: [],
      directoryObservations: [
        { path: "", dev: expect.any(Number), ino: expect.any(Number) },
        { path: "src", dev: expect.any(Number), ino: expect.any(Number) },
      ],
      scope: { kind: "all-managed" },
      entries: [
        {
          path: ".env",
          kind: "regular",
          recreationMode: process.platform === "win32" ? null : 0o644,
          byteLength: 6,
          sha256: sha256("secret"),
          sourcePath: join(canonicalRoot, ".env"),
        },
        {
          path: "pointer",
          kind: "symlink",
          target: join("src", "a.txt"),
          symlinkKind: "file",
        },
        {
          path: "run",
          kind: "regular",
          recreationMode: process.platform === "win32" ? null : 0o755,
          byteLength: 10,
          sha256: sha256("#!/bin/sh\n"),
          sourcePath: join(canonicalRoot, "run"),
        },
        {
          path: "src/a.txt",
          kind: "regular",
          recreationMode: process.platform === "win32" ? null : 0o644,
          byteLength: 5,
          sha256: sha256("alpha"),
          sourcePath: join(canonicalRoot, "src", "a.txt"),
        },
      ],
    });
  });

  it("rejects a missing or non-directory root with ScanError", async () => {
    const root = await workspace();
    await writeFile(join(root, "file"), "x");

    await expect(
      scanWorkspace(join(root, "missing")),
    ).rejects.toMatchObject({
      name: "ScanError",
    });
    await expect(
      scanWorkspace(join(root, "file")),
    ).rejects.toThrow(ScanError);
  });

  it("structurally excludes .git components at any depth and casing", async () => {
    const root = await workspace();
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "config"), "secret");
    await mkdir(join(root, "nested"));
    await mkdir(join(root, "nested", ".GIT"));
    await writeFile(
      join(root, "nested", ".GIT", "HEAD"),
      "never read",
    );
    await writeFile(join(root, "visible"), "yes");

    const snapshot = await scanWorkspace(root);
    expect(snapshot.problems).toEqual([]);
    expect(pathsOf(snapshot)).toEqual(["visible"]);
  });

  it("skips files beyond the single-file quota", async () => {
    const root = await workspace();
    await writeFile(join(root, "large"), "12345");
    await writeFile(join(root, "ok"), "hi");

    const snapshot = await scanWorkspace(root, {
      maxFileBytes: 4,
    });
    expect(pathsOf(snapshot)).toEqual(["ok"]);
    expect(snapshot.problems).toEqual([
      {
        path: "large",
        kind: "too-large",
        detail: "5 bytes exceeds the 4-byte file limit",
      },
    ]);
  });

  it("refuses hardlinked files instead of picking one link", async () => {
    const root = await workspace();
    await writeFile(join(root, "original"), "x");
    await link(join(root, "original"), join(root, "copy"));

    const snapshot = await scanWorkspace(root);
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.problems).toEqual([
      {
        path: "copy",
        kind: "hardlink",
        detail: "file has 2 hard links",
      },
      {
        path: "original",
        kind: "hardlink",
        detail: "file has 2 hard links",
      },
    ]);
  });

  it("reports fifo entries as unsupported and keeps scanning", async (context) => {
    context.skip(
      process.platform === "win32",
      "Windows filesystems do not expose POSIX FIFO entries",
    );
    const root = await workspace();
    await execFileAsync("mkfifo", [join(root, "pipe")]);
    await writeFile(join(root, "after"), "still scanned");

    const snapshot = await scanWorkspace(root);
    expect(pathsOf(snapshot)).toEqual(["after"]);
    expect(snapshot.problems).toEqual([
      {
        path: "pipe",
        kind: "unsupported",
        detail: expect.stringContaining("fifo"),
      },
    ]);
  });

  it("keeps the first of two paths colliding after NFC + lowercase normalization", async (context) => {
    const root = await workspace();
    await writeFile(join(root, "README.md"), "upper");
    await writeFile(join(root, "readme.md"), "lower");
    context.skip(
      (await readdir(root)).length < 2,
      "this filesystem cannot hold two colliding names",
    );

    const snapshot = await scanWorkspace(root);
    expect(pathsOf(snapshot)).toEqual(["README.md"]);
    expect(snapshot.problems).toEqual([
      {
        path: "readme.md",
        kind: "path-collision",
        detail: expect.stringContaining("README.md"),
      },
    ]);
  });

  it("rejects colliding directory identities even when their children differ", async (context) => {
    const root = await workspace();
    await mkdir(join(root, "A"));
    const createdSecondDirectory = await mkdir(join(root, "a"))
      .then(() => true)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST") {
          return false;
        }
        throw error;
      });
    if (!createdSecondDirectory) {
      context.skip(
        true,
        "this filesystem cannot hold two colliding directory names",
      );
      return;
    }
    await writeFile(join(root, "A", "x.txt"), "x");
    await writeFile(join(root, "a", "y.txt"), "y");
    context.skip(
      (await readdir(root)).length < 2,
      "this filesystem cannot hold two colliding directory names",
    );

    const observed = await scanWorkspace(root);

    expect(pathsOf(observed)).toEqual(["A/x.txt"]);
    expect(observed.problems).toEqual([
      {
        path: "a",
        kind: "path-collision",
        detail: expect.stringContaining("A"),
      },
    ]);
  });

  it("throws ScanError once the cumulative snapshot quota overflows", async () => {
    const root = await workspace();
    await writeFile(join(root, "a"), "1234");
    await writeFile(join(root, "b"), "5678");

    await expect(
      scanWorkspace(root, { maxSnapshotBytes: 5 }),
    ).rejects.toThrow(ScanError);
    await expect(
      scanWorkspace(root, { maxSnapshotBytes: 5 }),
    ).rejects.toThrow(/5-byte limit/);
  });

  it("bounds managed, excluded, and directory observations together", async () => {
    const root = await workspace();
    await execFileAsync("git", ["-C", root, "init", "-q"]);
    await writeFile(join(root, ".gitignore"), "ignored/\n");
    await mkdir(join(root, "ignored"));
    await writeFile(join(root, "ignored", "child"), "not enumerated");

    await expect(scanWorkspace(root, { maxEntries: 3 }))
      .resolves.toMatchObject({
        problems: [],
        excludedOccupancies: [expect.objectContaining({ path: "ignored" })],
      });
    await expect(scanWorkspace(root, { maxEntries: 2 }))
      .rejects.toThrow("2-entry limit");
  });

  it("charges invalid pathnames before appending scan problems", async () => {
    const root = await workspace();
    await writeFile(join(root, "one-e\u0301"), "one");
    await writeFile(join(root, "two-e\u0301"), "two");

    const exact = await scanWorkspace(root, { maxEntries: 3 });
    expect(exact.problems).toHaveLength(2);
    expect(exact.problems.every((problem) => problem.kind === "unsupported"))
      .toBe(true);
    await expect(scanWorkspace(root, { maxEntries: 2 }))
      .rejects.toThrow("2-entry limit");
  });

  it("charges read-failed entries before appending scan problems", async (context) => {
    context.skip(
      process.platform === "win32",
      "Windows symlink targets are represented through Unicode APIs",
    );
    const root = await workspace();
    await symlink(Buffer.from([0xff]), join(root, "bad-one"));
    await symlink(Buffer.from([0xfe]), join(root, "bad-two"));

    const exact = await scanWorkspace(root, { maxEntries: 3 });
    expect(exact.problems).toHaveLength(2);
    expect(exact.problems.every((problem) => problem.kind === "read-failed"))
      .toBe(true);
    await expect(scanWorkspace(root, { maxEntries: 2 }))
      .rejects.toThrow("2-entry limit");
  });

  it("charges unsupported Windows symlinks before appending scan problems", async () => {
    const root = await workspace();
    await symlink("missing-one", join(root, "dangling-one"));
    await symlink("missing-two", join(root, "dangling-two"));

    const exact = await withSimulatedWindows(() =>
      scanWorkspace(root, { maxEntries: 3 })
    );
    expect(exact.problems).toHaveLength(2);
    expect(exact.problems.every((problem) => problem.kind === "unsupported"))
      .toBe(true);
    await expect(withSimulatedWindows(() =>
      scanWorkspace(root, { maxEntries: 2 })
    )).rejects.toThrow("2-entry limit");
  });

  it("bounds the exact canonical manifest estimate before publication", async () => {
    const root = await workspace();
    await writeFile(join(root, "entry-with-a-long-name.txt"), "content");
    const initial = await scanWorkspace(root);
    const durableEntries = initial.entries.map((entry): TreeEntry =>
      entry.kind === "regular"
        ? {
            path: entry.path,
            type: "regular",
            blobOid: entry.sha256,
            recreationMode: entry.recreationMode,
          }
        : {
            path: entry.path,
            type: "symlink",
            target: entry.target,
            symlinkKind: entry.symlinkKind,
          }
    );
    const exactBytes = encodeTreeManifest(
      durableEntries,
      initial.scope,
    ).byteLength;

    await expect(scanWorkspace(root, { maxManifestBytes: exactBytes }))
      .resolves.toMatchObject({ problems: [] });
    await expect(scanWorkspace(root, { maxManifestBytes: exactBytes - 1 }))
      .rejects.toThrow("manifest estimate");
  });

  it("compares complete snapshots without treating excluded inode churn as drift", async () => {
    const root = await workspace();
    await execFileAsync("git", ["-C", root, "init", "-q"]);
    await writeFile(join(root, ".gitignore"), "ignored\n");
    await writeFile(join(root, "managed"), "content");
    await writeFile(join(root, "ignored"), "outside scope");
    const snapshot = await scanWorkspace(root);
    const occupancy = snapshot.excludedOccupancies[0]!;

    expect(workspaceSnapshotsEqual(snapshot, snapshot)).toBe(true);
    expect(workspaceSnapshotsEqual(snapshot, {
      ...snapshot,
      excludedOccupancies: [{
        ...occupancy,
        dev: occupancy.dev + 1,
        ino: occupancy.ino + 1,
      }],
    })).toBe(true);
    expect(workspaceSnapshotsEqual(snapshot, {
      ...snapshot,
      excludedOccupancies: [{ ...occupancy, kind: "symlink" }],
    })).toBe(false);
    expect(workspaceSnapshotsEqual(snapshot, {
      ...snapshot,
      directoryObservations: snapshot.directoryObservations.map(
        (observation, index) => index === 0
          ? {
              ...observation,
              dev: observation.dev + 1,
              ino: observation.ino + 1,
            }
          : observation,
      ),
    })).toBe(false);
    expect(workspaceSnapshotsEqual(snapshot, {
      ...snapshot,
      entries: snapshot.entries.map((entry) =>
        entry.kind === "regular" && entry.path === "managed"
          ? { ...entry, sha256: "0".repeat(64) }
          : entry
      ),
    })).toBe(false);
  });

  it("sorts canonical entries by UTF-8 path bytes and rejects non-NFC names", async () => {
    const root = await workspace();
    await writeFile(join(root, "b.txt"), "b");
    await writeFile(join(root, "a.txt"), "a");
    await writeFile(join(root, "Z.txt"), "z");
    // Written in NFD ("e" + combining acute); silently changing its spelling
    // would make a later delete/recreate target a different pathname.
    await writeFile(join(root, "e\u0301.txt"), "accent");

    const snapshot = await scanWorkspace(root);
    expect(pathsOf(snapshot)).toEqual(["Z.txt", "a.txt", "b.txt"]);
    expect(snapshot.problems).toEqual([
      {
        path: "e\u0301.txt",
        kind: "unsupported",
        detail: expect.stringContaining("not NFC-normalized"),
      },
    ]);
  });

  it("rejects pathnames that cannot be represented portably", async (context) => {
    context.skip(
      process.platform === "win32",
      "Windows does not permit a backslash inside one pathname component",
    );
    const root = await workspace();
    await writeFile(join(root, "left\\right"), "content");

    const snapshot = await scanWorkspace(root);

    expect(snapshot.entries).toEqual([]);
    expect(snapshot.problems).toEqual([
      {
        path: "left\\right",
        kind: "unsupported",
        detail: expect.stringContaining("backslash"),
      },
    ]);
  });

  it("rejects symlink targets that are not valid UTF-8", async (context) => {
    context.skip(
      process.platform === "win32",
      "Windows symlink targets are represented through Unicode APIs",
    );
    const root = await workspace();
    await symlink(Buffer.from([0xff]), join(root, "bad-link"));

    const snapshot = await scanWorkspace(root);

    expect(snapshot.entries).toEqual([]);
    expect(snapshot.problems).toEqual([
      {
        path: "bad-link",
        kind: "read-failed",
        detail: expect.stringContaining("not valid UTF-8"),
      },
    ]);
  });

  it("records the observable target kind for restorable symlinks", async () => {
    const root = await workspace();
    await writeFile(join(root, "file-target"), "content");
    await mkdir(join(root, "directory-target"));
    await symlink(
      "file-target",
      join(root, "file-link"),
      process.platform === "win32" ? "file" : undefined,
    );
    await symlink(
      "directory-target",
      join(root, "directory-link"),
      process.platform === "win32" ? "dir" : undefined,
    );

    const snapshot = await scanWorkspace(root);
    const kinds = new Map(snapshot.entries.flatMap((entry) =>
      entry.kind === "symlink" ? [[entry.path, entry.symlinkKind]] : []
    ));

    expect(kinds).toEqual(new Map([
      ["directory-link", "directory"],
      ["file-link", "file"],
    ]));
  });

  it("fails closed for an unclassifiable Windows symlink", async () => {
    const root = await workspace();
    await symlink("missing-target", join(root, "dangling"));

    const snapshot = await withSimulatedWindows(() => scanWorkspace(root));

    expect(snapshot.entries).toEqual([]);
    expect(snapshot.problems).toContainEqual({
      path: "dangling",
      kind: "unsupported",
      detail: expect.stringContaining("target type is unavailable"),
    });
  });

});
