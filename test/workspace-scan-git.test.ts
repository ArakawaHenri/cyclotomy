import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  scanWorkspace,
  scanWorkspaceForScope,
  type WorkspaceSnapshot,
} from "../src/infrastructure/workspace-scan.ts";
import {
  ABSOLUTE_WORKSPACE_PATH_LIMITS,
  canonicalizeWorkspaceScope,
  workspaceScopesEqual,
  type WorkspaceScope,
} from "../src/infrastructure/workspace-scope.ts";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function temporaryWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cyclotomy-scan-git-"));
  roots.push(root);
  return root;
}

async function initializeRepository(root: string): Promise<void> {
  await execFileAsync("git", ["-C", root, "init", "-q"]);
}

function pathsOf(snapshot: WorkspaceSnapshot): readonly string[] {
  return snapshot.entries.map(({ path }) => path);
}

function targetScope(
  policy: Uint8Array | string,
  ignoreCase = false,
): WorkspaceScope {
  const bytes = typeof policy === "string" ? Buffer.from(policy) : policy;
  return canonicalizeWorkspaceScope({
    kind: "git",
    repositoryPrefix: "",
    ignoreCase,
    gitignoreSources: [
      {
        path: ".gitignore",
        contentsBase64: Buffer.from(bytes).toString("base64"),
      },
    ],
    infoExcludeBase64: "",
    globalExcludeBase64: "",
  });
}

async function withTemporaryDirectoryEnvironment<T>(
  path: string,
  action: () => Promise<T>,
): Promise<T> {
  const names = ["TMPDIR", "TMP", "TEMP"] as const;
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) process.env[name] = path;
  try {
    return await action();
  } finally {
    for (const name of names) {
      const value = previous.get(name);
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

async function directoryChangeTimes(path: string): Promise<{
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}> {
  const observation = await lstat(path, { bigint: true });
  return {
    mtimeNs: observation.mtimeNs,
    ctimeNs: observation.ctimeNs,
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("workspace scanner Git policy integration", () => {
  it("treats a non-Git directory as all-managed", async () => {
    const root = await temporaryWorkspace();
    await writeFile(join(root, ".gitignore"), "ignored.txt\n");
    await writeFile(join(root, "ignored.txt"), "ordinary workspace data");

    const snapshot = await scanWorkspace(root);

    expect(snapshot.scope).toEqual({ kind: "all-managed" });
    expect(pathsOf(snapshot)).toEqual([".gitignore", "ignored.txt"]);
    expect(snapshot.excludedOccupancies).toEqual([]);
  });

  it("archives and applies repository-parent .gitignore policy", async () => {
    const repository = await temporaryWorkspace();
    await initializeRepository(repository);
    await writeFile(join(repository, ".gitignore"), "hidden.txt\n");
    const root = join(repository, "project");
    await mkdir(root);
    await writeFile(join(root, "hidden.txt"), "ignored by parent");
    await writeFile(join(root, "visible.txt"), "managed");

    const snapshot = await scanWorkspace(root);

    expect(pathsOf(snapshot)).toEqual(["visible.txt"]);
    expect(snapshot.excludedOccupancies).toEqual([
      expect.objectContaining({ path: "hidden.txt", kind: "regular" }),
    ]);
    expect(snapshot.scope).toMatchObject({
      kind: "git",
      repositoryPrefix: "project",
      gitignoreSources: [{ path: ".gitignore" }],
    });
  });

  it("archives info/exclude and the effective core.excludesFile", async () => {
    const root = await temporaryWorkspace();
    await initializeRepository(root);
    const global = join(root, "global-ignore");
    await writeFile(join(root, ".git", "info", "exclude"), "info.txt\n");
    await writeFile(global, "global.txt\n");
    await execFileAsync("git", [
      "-C",
      root,
      "config",
      "core.excludesFile",
      global,
    ]);
    await writeFile(join(root, "info.txt"), "info");
    await writeFile(join(root, "global.txt"), "global");
    await writeFile(join(root, "visible.txt"), "visible");

    const snapshot = await scanWorkspace(root);

    expect(pathsOf(snapshot)).toEqual(["global-ignore", "visible.txt"]);
    expect(snapshot.scope).toMatchObject({
      kind: "git",
      infoExcludeBase64: Buffer.from("info.txt\n").toString("base64"),
      globalExcludeBase64: Buffer.from("global.txt\n").toString("base64"),
    });
  });

  it("resolves a relative default XDG exclude path from the repository root", async () => {
    const root = await temporaryWorkspace();
    await initializeRepository(root);
    const relativeXdg = "relative-xdg";
    await mkdir(join(root, relativeXdg, "git"), { recursive: true });
    await writeFile(
      join(root, relativeXdg, "git", "ignore"),
      "future.ignore\n",
    );
    const previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = relativeXdg;

    try {
      // No current path matches the global rule, so live/synthetic decision
      // replay alone cannot prove that the fallback source was archived.
      const target = await scanWorkspace(root);
      expect(target.scope).toMatchObject({
        kind: "git",
        globalExcludeBase64: Buffer.from("future.ignore\n").toString("base64"),
      });

      await writeFile(join(root, "future.ignore"), "unmanaged");
      const current = await scanWorkspaceForScope(root, target.scope);
      expect(pathsOf(current)).not.toContain("future.ignore");
      expect(current.excludedOccupancies).toContainEqual(
        expect.objectContaining({ path: "future.ignore", kind: "regular" }),
      );
    } finally {
      if (previousXdg === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previousXdg;
      }
    }
  });

  it("lets a reachable nested source override a shallower rule", async () => {
    const root = await temporaryWorkspace();
    await initializeRepository(root);
    await writeFile(join(root, ".gitignore"), "*.log\n");
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "sub", ".gitignore"), "!keep.log\n");
    await writeFile(join(root, "sub", "keep.log"), "keep");
    await writeFile(join(root, "sub", "drop.log"), "drop");

    const snapshot = await scanWorkspace(root);

    expect(pathsOf(snapshot)).toEqual([
      ".gitignore",
      "sub/.gitignore",
      "sub/keep.log",
    ]);
    expect(snapshot.scope).toMatchObject({
      kind: "git",
      gitignoreSources: [{ path: ".gitignore" }, { path: "sub/.gitignore" }],
    });
  });

  it("prunes an ignored directory without importing unreachable policy", async () => {
    const root = await temporaryWorkspace();
    await initializeRepository(root);
    await writeFile(join(root, ".gitignore"), "logs/\n");
    await mkdir(join(root, "logs"));
    await writeFile(join(root, "logs", ".gitignore"), "!keep.txt\n");
    await writeFile(join(root, "logs", "keep.txt"), "unreachable");

    const snapshot = await scanWorkspace(root);

    expect(pathsOf(snapshot)).toEqual([".gitignore"]);
    expect(snapshot.excludedOccupancies).toEqual([
      expect.objectContaining({ path: "logs", kind: "directory" }),
    ]);
    expect(snapshot.scope).toMatchObject({
      kind: "git",
      gitignoreSources: [{ path: ".gitignore" }],
    });
  });

  it("archives a self-ignored source without forcing it into managed entries", async () => {
    const root = await temporaryWorkspace();
    await initializeRepository(root);
    await writeFile(join(root, ".gitignore"), ".gitignore\n");
    await writeFile(join(root, "visible.txt"), "visible");

    const snapshot = await scanWorkspace(root);

    expect(pathsOf(snapshot)).toEqual(["visible.txt"]);
    expect(snapshot.excludedOccupancies).toEqual([
      expect.objectContaining({ path: ".gitignore", kind: "regular" }),
    ]);
    expect(snapshot.scope).toMatchObject({
      kind: "git",
      gitignoreSources: [
        {
          path: ".gitignore",
          contentsBase64: Buffer.from(".gitignore\n").toString("base64"),
        },
      ],
    });
  });

  it("replays an archived target after the live policy changes", async () => {
    const root = await temporaryWorkspace();
    await initializeRepository(root);
    await writeFile(join(root, ".gitignore"), "ignored.txt\n");
    await writeFile(join(root, "ignored.txt"), "ignored");
    await writeFile(join(root, "other.txt"), "managed");
    const target = await scanWorkspace(root);

    await writeFile(join(root, ".gitignore"), "other.txt\n");
    const current = await scanWorkspaceForScope(root, target.scope);

    expect(pathsOf(current)).toEqual([".gitignore", "other.txt"]);
    expect(
      workspaceScopesEqual(
        current.scope,
        target.scope,
        ABSOLUTE_WORKSPACE_PATH_LIMITS,
      ),
    ).toBe(true);
    const source = current.entries.find(({ path }) => path === ".gitignore");
    expect(source).toMatchObject({
      kind: "regular",
      byteLength: Buffer.byteLength("other.txt\n"),
    });
  });

  it("keeps a live scan read-only when TMPDIR is the workspace", async () => {
    const root = await temporaryWorkspace();
    await initializeRepository(root);
    await writeFile(join(root, ".gitignore"), "ignored.txt\n");
    await writeFile(join(root, "ignored.txt"), "unmanaged");
    await writeFile(join(root, "visible.txt"), "managed");
    const before = await directoryChangeTimes(root);

    const snapshot = await withTemporaryDirectoryEnvironment(root, () =>
      scanWorkspace(root),
    );

    expect(snapshot.problems).toEqual([]);
    expect(pathsOf(snapshot)).toEqual([".gitignore", "visible.txt"]);
    expect(await directoryChangeTimes(root)).toEqual(before);
    expect(
      (await readdir(root)).some((name) =>
        name.startsWith("cyclotomy-ignore-"),
      ),
    ).toBe(false);
  });

  it("keeps a target scan read-only when TMPDIR is inside the workspace", async () => {
    const root = await temporaryWorkspace();
    await initializeRepository(root);
    await writeFile(join(root, ".gitignore"), ".scratch/\nignored.txt\n");
    await writeFile(join(root, "ignored.txt"), "unmanaged");
    await writeFile(join(root, "visible.txt"), "managed");
    const target = await scanWorkspace(root);
    const nestedTemporaryDirectory = join(root, ".scratch");
    await mkdir(nestedTemporaryDirectory);
    const rootBefore = await directoryChangeTimes(root);
    const temporaryDirectoryBefore = await directoryChangeTimes(
      nestedTemporaryDirectory,
    );

    const current = await withTemporaryDirectoryEnvironment(
      nestedTemporaryDirectory,
      () => scanWorkspaceForScope(root, target.scope),
    );

    expect(current.problems).toEqual([]);
    expect(pathsOf(current)).toEqual([".gitignore", "visible.txt"]);
    expect(await directoryChangeTimes(root)).toEqual(rootBefore);
    expect(await directoryChangeTimes(nestedTemporaryDirectory)).toEqual(
      temporaryDirectoryBefore,
    );
    expect(await readdir(nestedTemporaryDirectory)).toEqual([]);
  });

  it("rejects an explicit synthetic scratch parent inside the workspace", async () => {
    const root = await temporaryWorkspace();
    const scratch = join(root, "scratch");
    await mkdir(scratch);

    await expect(
      scanWorkspaceForScope(root, targetScope("ignored.txt\n"), {
        gitIgnoreScratchParent: scratch,
      }),
    ).rejects.toThrow(
      "synthetic Git scratch parent is inside a forbidden root",
    );
    expect(await readdir(scratch)).toEqual([]);
  });

  it("keeps a file unmanaged when archived nested policy needs that path as a directory", async () => {
    const root = await temporaryWorkspace();
    await writeFile(join(root, "a"), "unmanaged occupant");
    await writeFile(join(root, "visible.txt"), "managed");
    const policy = "a\n!a/\n";
    const scope = canonicalizeWorkspaceScope({
      kind: "git",
      repositoryPrefix: "",
      ignoreCase: false,
      gitignoreSources: [
        {
          path: ".gitignore",
          contentsBase64: Buffer.from(policy).toString("base64"),
        },
        { path: "a/.gitignore", contentsBase64: "" },
      ],
      infoExcludeBase64: "",
      globalExcludeBase64: "",
    });

    const snapshot = await scanWorkspaceForScope(root, scope);

    expect(pathsOf(snapshot)).toEqual(["visible.txt"]);
    expect(snapshot.excludedOccupancies).toEqual([
      expect.objectContaining({ path: "a", kind: "regular" }),
    ]);
  });

  it("uses archived core.ignoreCase in a synthetic target scan", async () => {
    const root = await temporaryWorkspace();
    await writeFile(join(root, "foo"), "case probe");
    const policy = "foo\n!FOO\n";

    expect(
      pathsOf(await scanWorkspaceForScope(root, targetScope(policy, false))),
    ).toEqual([]);
    expect(
      pathsOf(await scanWorkspaceForScope(root, targetScope(policy, true))),
    ).toEqual(["foo"]);
  });

  it("binds the actual casing of a live .gitignore entry", async () => {
    const root = await temporaryWorkspace();
    await initializeRepository(root);
    await execFileAsync("git", [
      "-C",
      root,
      "config",
      "core.ignoreCase",
      "true",
    ]);
    const policy = "*.tmp\n";
    await writeFile(join(root, ".GITIGNORE"), policy);
    const aliasesCanonicalName = await lstat(join(root, ".gitignore")).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );

    if (!aliasesCanonicalName) {
      await expect(scanWorkspace(root)).rejects.toThrow(
        "workspace entries do not match the captured Git ignore sources",
      );
      return;
    }
    const snapshot = await scanWorkspace(root);
    expect(pathsOf(snapshot)).toContain(".GITIGNORE");
    expect(snapshot.scope).toMatchObject({
      kind: "git",
      ignoreCase: true,
      gitignoreSources: [
        {
          path: ".gitignore",
          contentsBase64: Buffer.from(policy).toString("base64"),
        },
      ],
    });
  });

  it("rejects different bytes behind an ignoreCase source alias", async (context) => {
    const root = await temporaryWorkspace();
    await initializeRepository(root);
    await execFileAsync("git", [
      "-C",
      root,
      "config",
      "core.ignoreCase",
      "true",
    ]);
    await writeFile(join(root, ".GITIGNORE"), "different\n");
    const aliasesCanonicalName = await lstat(join(root, ".gitignore")).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
    context.skip(
      aliasesCanonicalName,
      "case-insensitive filesystems cannot hold two differently cased sources",
    );
    await writeFile(join(root, ".gitignore"), "canonical\n");

    await expect(scanWorkspace(root)).rejects.toThrow(
      "workspace entries do not match the captured Git ignore sources",
    );
  });

  it("archives non-UTF-8 policy bytes without interpreting them in JavaScript", async () => {
    const root = await temporaryWorkspace();
    await initializeRepository(root);
    const policy = Buffer.concat([
      Buffer.from("ignored.txt\n"),
      Buffer.from([0xff, 0x0a]),
    ]);
    await writeFile(join(root, ".gitignore"), policy);
    await writeFile(join(root, "ignored.txt"), "ignored");
    await writeFile(join(root, "visible.txt"), "visible");

    const snapshot = await scanWorkspace(root);

    expect(pathsOf(snapshot)).toEqual([".gitignore", "visible.txt"]);
    expect(snapshot.scope).toMatchObject({
      kind: "git",
      gitignoreSources: [
        {
          path: ".gitignore",
          contentsBase64: policy.toString("base64"),
        },
      ],
    });
  });

  it("does not follow a symlinked .gitignore as policy", async (context) => {
    context.skip(
      process.platform === "win32",
      "Windows symlink creation requires host-specific privileges",
    );
    const root = await temporaryWorkspace();
    await initializeRepository(root);
    const outside = join(await temporaryWorkspace(), "outside-ignore");
    await writeFile(outside, "hidden.txt\n");
    await symlink(outside, join(root, ".gitignore"));
    await writeFile(join(root, "hidden.txt"), "managed");

    const snapshot = await scanWorkspace(root);

    expect(pathsOf(snapshot)).toEqual([".gitignore", "hidden.txt"]);
    expect(snapshot.scope).toMatchObject({
      kind: "git",
      gitignoreSources: [],
    });
  });
});
