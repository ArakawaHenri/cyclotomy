import { execFile } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  createLiveGitIgnoreOracle,
  createSyntheticGitIgnoreOracle,
  discoverWorkspaceScope,
  readWorkspaceGitignoreSource,
  WorkspaceGitPolicyBudget,
  type GitIgnorePath,
} from "../src/infrastructure/git-ignore-oracle.ts";
import {
  SyntheticGitDirectoryShape,
  type SyntheticGitPolicySource,
} from "../src/infrastructure/synthetic-git-directory-shape.ts";
import {
  ABSOLUTE_WORKSPACE_PATH_LIMITS,
  MAX_GITIGNORE_POLICY_BYTES,
  MAX_GITIGNORE_SOURCES,
  MAX_GITIGNORE_SOURCE_BYTES,
  DEFAULT_MAX_WORKSPACE_RELATIVE_PATH_BYTES,
  WorkspaceScopeError,
  canonicalizeWorkspaceScope,
  workspaceGitignoreSource,
  workspaceScopeBytes,
  workspaceScopesEqual,
  type GitWorkspaceScope,
} from "../src/infrastructure/workspace-scope.ts";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cyclotomy-git-oracle-"));
  roots.push(root);
  return root;
}

async function git(root: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", root, ...args], {
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
  });
}

async function put(path: string, contents: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

async function executableOnPath(name: string): Promise<string> {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory === "") continue;
    const candidate = join(directory, name);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new Error(`cannot locate ${name} on PATH`);
}

async function withFakeOracleGit<T>(
  mode: "empty-pattern" | "partial-eof" | "zero-line",
  action: () => Promise<T>,
): Promise<T> {
  if (process.platform === "win32") return action();
  const executableRoot = await makeRoot();
  const actualGit = await executableOnPath("git");
  const fakeGit = join(executableRoot, "git");
  const script = `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const actualGit = ${JSON.stringify(actualGit)};
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("git version 99.0.0\\n");
} else if (!args.includes("check-ignore")) {
  const result = spawnSync(actualGit, args, { env: process.env, stdio: "inherit" });
  process.exit(result.status ?? 1);
} else {
  let pending = Buffer.alloc(0);
  process.stdin.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (true) {
      const end = pending.indexOf(0);
      if (end < 0) break;
      const path = pending.subarray(0, end);
      pending = pending.subarray(end + 1);
      if (${JSON.stringify(mode)} === "partial-eof") {
        process.stdout.write(Buffer.from(".gitignore\\0"));
        process.exit(0);
      }
      const line = ${JSON.stringify(mode)} === "zero-line" ? "0" : "1";
      const pattern = ${JSON.stringify(mode)} === "empty-pattern" ? "" : "*.log";
      process.stdout.write(Buffer.concat([
        Buffer.from(".gitignore\\0"),
        Buffer.from(line + "\\0"),
        Buffer.from(pattern + "\\0"),
        path,
        Buffer.from([0]),
      ]));
    }
  });
}
`;
  await writeFile(fakeGit, script, { flag: "wx" });
  await chmod(fakeGit, 0o755);
  return withEnvironment(
    { PATH: `${executableRoot}${delimiter}${process.env.PATH ?? ""}` },
    action,
  );
}

async function withFakeGitCommand<T>(
  mode:
    | "dirty-bool-absence"
    | "dirty-global-absence"
    | "dirty-not-repository"
    | "multiple-global-records",
  action: () => Promise<T>,
): Promise<T> {
  if (process.platform === "win32") return action();
  const executableRoot = await makeRoot();
  const actualGit = await executableOnPath("git");
  const fakeGit = join(executableRoot, "git");
  const script = `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const actualGit = ${JSON.stringify(actualGit)};
const mode = ${JSON.stringify(mode)};
const args = process.argv.slice(2);
const key = args.at(-1);
if (mode === "dirty-not-repository" && args.includes("--is-inside-work-tree")) {
  process.stdout.write("unexpected\\n");
  process.stderr.write("fatal: not a git repository (or any of the parent directories): .git\\n");
  process.exit(128);
}
if (args.includes("config") && mode === "dirty-bool-absence" && key === "core.ignoreCase") {
  process.stderr.write("unexpected config failure\\n");
  process.exit(1);
}
if (args.includes("config") && mode === "dirty-global-absence" && key === "core.excludesFile") {
  process.stdout.write(Buffer.from("unexpected\\0"));
  process.exit(1);
}
if (args.includes("config") && mode === "multiple-global-records" && key === "core.excludesFile") {
  process.stdout.write(Buffer.from("first\\0second\\0"));
  process.exit(0);
}
const result = spawnSync(actualGit, args, { env: process.env, stdio: "inherit" });
process.exit(result.status ?? 1);
`;
  await writeFile(fakeGit, script, { flag: "wx" });
  await chmod(fakeGit, 0o755);
  return withEnvironment(
    { PATH: `${executableRoot}${delimiter}${process.env.PATH ?? ""}` },
    action,
  );
}

function syntheticScope(policy = "*.log\n"): GitWorkspaceScope {
  const scope = canonicalizeWorkspaceScope({
    kind: "git",
    repositoryPrefix: "",
    evaluator: null,
    ignoreCase: false,
    gitignoreSources: [
      workspaceGitignoreSource(".gitignore", Buffer.from(policy)),
    ],
    infoExcludeBase64: "",
    globalExcludeBase64: "",
  });
  if (scope.kind !== "git") throw new Error("expected Git scope");
  return scope;
}

async function withEnvironment<T>(
  overrides: Readonly<Record<string, string | undefined>>,
  action: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await action();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("workspace Git scope", () => {
  it("keeps raw bytes, canonicalizes source order, and compares canonical values", () => {
    const left = canonicalizeWorkspaceScope({
      kind: "git",
      repositoryPrefix: "app",
      evaluator: null,
      ignoreCase: false,
      gitignoreSources: [
        workspaceGitignoreSource("app/z/.gitignore", Buffer.from([0xff, 0x0a])),
        workspaceGitignoreSource(".gitignore", Buffer.from("root\n")),
      ],
      infoExcludeBase64: Buffer.from("info\n").toString("base64"),
      globalExcludeBase64: "",
    });
    expect(left).toMatchObject({
      kind: "git",
      repositoryPrefix: "app",
      gitignoreSources: [{ path: ".gitignore" }, { path: "app/z/.gitignore" }],
    });
    if (left.kind !== "git") throw new Error("expected Git scope");
    expect(
      workspaceScopeBytes(left.gitignoreSources[1]!.contentsBase64),
    ).toEqual(Buffer.from([0xff, 0x0a]));
    expect(
      workspaceScopesEqual(
        left,
        {
          ...left,
          gitignoreSources: [...left.gitignoreSources].reverse(),
        },
        ABSOLUTE_WORKSPACE_PATH_LIMITS,
      ),
    ).toBe(true);
  });

  it("rejects noncanonical, ambiguous, unrelated, duplicate, and oversized policy", () => {
    const base = {
      kind: "git",
      repositoryPrefix: "app",
      evaluator: null,
      ignoreCase: false,
      gitignoreSources: [],
      infoExcludeBase64: "",
      globalExcludeBase64: "",
    } as const;
    for (const value of [
      { ignoreCase: false, ignoreSources: [] },
      { ...base, extra: true },
      { ...base, repositoryPrefix: "../app" },
      {
        ...base,
        gitignoreSources: [{ path: "other/.gitignore", contentsBase64: "" }],
      },
      {
        ...base,
        gitignoreSources: [
          { path: "app/.gitignore", contentsBase64: "" },
          { path: "app/.gitignore", contentsBase64: "" },
        ],
      },
      { ...base, infoExcludeBase64: "A===" },
      {
        ...base,
        globalExcludeBase64: Buffer.alloc(
          MAX_GITIGNORE_SOURCE_BYTES + 1,
        ).toString("base64"),
      },
    ]) {
      expect(() => canonicalizeWorkspaceScope(value)).toThrow(
        WorkspaceScopeError,
      );
    }

    expect(() =>
      canonicalizeWorkspaceScope({
        ...base,
        gitignoreSources: Array.from(
          { length: MAX_GITIGNORE_SOURCES + 1 },
          () => ({ path: "app/.gitignore", contentsBase64: "" }),
        ),
      }),
    ).toThrow("too many");

    const fullSource = Buffer.alloc(MAX_GITIGNORE_SOURCE_BYTES, 0x61).toString(
      "base64",
    );
    const sourcesAtTotalLimit = Array.from(
      { length: MAX_GITIGNORE_POLICY_BYTES / MAX_GITIGNORE_SOURCE_BYTES },
      (_, index) => ({
        path: `app/d${index}/.gitignore`,
        contentsBase64: fullSource,
      }),
    );
    expect(() =>
      canonicalizeWorkspaceScope({
        ...base,
        gitignoreSources: sourcesAtTotalLimit,
        infoExcludeBase64: "YQ==",
      }),
    ).toThrow("policy byte limit");
  });

  it("bounds incrementally accumulated policy before a scope is assembled", () => {
    const budget = new WorkspaceGitPolicyBudget();
    const fullSource = Buffer.alloc(MAX_GITIGNORE_SOURCE_BYTES, 0x61).toString(
      "base64",
    );
    const sourcesAtLimit =
      MAX_GITIGNORE_POLICY_BYTES / MAX_GITIGNORE_SOURCE_BYTES;
    for (let index = 0; index < sourcesAtLimit; index += 1) {
      budget.upsertGitignoreSource({
        path: `d${index}/.gitignore`,
        contentsBase64: fullSource,
      });
    }
    expect(() =>
      budget.upsertGitignoreSource({
        path: "overflow/.gitignore",
        contentsBase64: fullSource,
      }),
    ).toThrow("policy exceeds the byte limit");
  });

  it("treats a non-Git directory as all-managed", async () => {
    const root = await makeRoot();
    const discovery = await discoverWorkspaceScope(root);
    expect(discovery.scope).toEqual({ kind: "all-managed" });
    const oracle = await createSyntheticGitIgnoreOracle(discovery.scope);
    expect(oracle.gitVersion).toBeNull();
    await expect(
      oracle.managed([
        { path: ".gitignore", kind: "non-directory" },
        { path: "nested/file", kind: "non-directory" },
      ]),
    ).resolves.toEqual([true, true]);
    await oracle.close();
  });

  it("rejects a bare repository instead of managing Git control files", async () => {
    const root = await makeRoot();
    await execFileAsync("git", ["init", "--bare", "-q", root]);

    await expect(discoverWorkspaceScope(root)).rejects.toThrow(
      "cannot determine whether the workspace is a Git worktree",
    );
  });

  it("rejects a damaged ancestor .git marker after Git reports no repository", async () => {
    const root = await makeRoot();
    await execFileAsync("git", ["init", "-q", root]);
    const workspace = join(root, "nested", "workspace");
    await mkdir(workspace, { recursive: true });
    await rename(join(root, ".git"), join(root, ".git.saved"));
    await mkdir(join(root, ".git"));

    await expect(discoverWorkspaceScope(workspace)).rejects.toThrow(
      "cannot determine whether the workspace is a Git worktree",
    );
  });

  it("rejects an unreadable .git marker after Git reports no repository", async (context) => {
    context.skip(
      process.platform === "win32",
      "POSIX permission semantics are required",
    );
    context.skip(
      process.getuid?.() === 0,
      "root can bypass POSIX directory permission bits",
    );
    const root = await makeRoot();
    await execFileAsync("git", ["init", "-q", root]);
    const gitDirectory = join(root, ".git");
    await chmod(gitDirectory, 0);
    try {
      await expect(discoverWorkspaceScope(root)).rejects.toThrow(
        "cannot determine whether the workspace is a Git worktree",
      );
    } finally {
      await chmod(gitDirectory, 0o700);
    }
  });

  it("rejects a degraded bare control root", async () => {
    const root = await makeRoot();
    await execFileAsync("git", ["init", "--bare", "-q", root]);
    await rename(join(root, "objects"), join(root, "objects.saved"));
    await writeFile(join(root, "objects"), "damaged bare object directory");

    await expect(discoverWorkspaceScope(root)).rejects.toThrow(
      "cannot determine whether the workspace is a Git worktree",
    );
  });

  it("does not treat a dirty not-repository failure as an ordinary absence", async (context) => {
    context.skip(
      process.platform === "win32",
      "fake executable fixture is POSIX-only",
    );
    const root = await makeRoot();
    await expect(
      withFakeGitCommand("dirty-not-repository", () =>
        discoverWorkspaceScope(root),
      ),
    ).rejects.toThrow(
      "cannot determine whether the workspace is a Git worktree",
    );
  });
});

describe("Git ignore oracle", () => {
  async function fixture(): Promise<{
    readonly root: string;
    readonly workspace: string;
    readonly scope: GitWorkspaceScope;
  }> {
    const root = await makeRoot();
    await execFileAsync("git", ["init", "-q", root]);
    const workspace = join(root, "apps", "work");
    await mkdir(join(workspace, "sub"), { recursive: true });
    await mkdir(join(workspace, "build"));
    await put(join(root, ".gitignore"), "root-only.log\n");
    await put(join(root, "apps", ".gitignore"), "parent-only.tmp\n");
    await put(
      join(workspace, ".gitignore"),
      "*.log\n!keep.log\nbuild/\n.gitignore\n",
    );
    await put(
      join(workspace, "sub", ".gitignore"),
      Buffer.concat([
        Buffer.from("*.tmp\n# raw bytes remain exact: "),
        Buffer.from([0xff, 0x0a]),
      ]),
    );
    const infoPath = join(root, ".git", "info", "exclude");
    const globalPath = join(root, "global-ignore");
    await put(infoPath, "info.ignore\n");
    await put(globalPath, "global.ignore\n");
    await git(root, "config", "core.ignoreCase", "false");
    await git(root, "config", "core.excludesFile", globalPath);

    const discovery = await discoverWorkspaceScope(workspace);
    expect(discovery.scope).toMatchObject({
      kind: "git",
      repositoryPrefix: "apps/work",
      ignoreCase: false,
      gitignoreSources: [
        { path: ".gitignore" },
        { path: "apps/.gitignore" },
        { path: "apps/work/.gitignore" },
      ],
      infoExcludeBase64: Buffer.from("info.ignore\n").toString("base64"),
      globalExcludeBase64: Buffer.from("global.ignore\n").toString("base64"),
    });
    if (discovery.scope.kind !== "git") throw new Error("expected Git scope");
    const nested = await readWorkspaceGitignoreSource(discovery, "sub");
    if (nested === undefined) throw new Error("expected nested source");
    const scope = canonicalizeWorkspaceScope({
      ...discovery.scope,
      gitignoreSources: [...discovery.scope.gitignoreSources, nested],
    });
    if (scope.kind !== "git") throw new Error("expected Git scope");
    return { root, workspace, scope };
  }

  it.each([
    ["CR", "\r"],
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("preserves a repository root ending in %s", async (_label, suffix) => {
    if (process.platform === "win32") return;
    const container = await makeRoot();
    const root = join(container, `repository${suffix}`);
    await mkdir(root);
    await execFileAsync("git", ["init", "-q", root]);
    await put(join(root, ".gitignore"), "drop.log\n");

    const discovery = await discoverWorkspaceScope(root);
    expect(discovery.workspaceRoot).toBe(await realpath(root));
    expect(discovery.repositoryRoot).toBe(await realpath(root));
    expect(discovery.scope).toMatchObject({
      kind: "git",
      repositoryPrefix: "",
    });
    const oracle = await createLiveGitIgnoreOracle(root, discovery.scope);
    try {
      await expect(
        oracle.managed([{ path: "drop.log", kind: "non-directory" }]),
      ).resolves.toEqual([false]);
    } finally {
      await oracle.close();
    }
  });

  it("rejects legacy evaluator provenance at the live-oracle boundary", async () => {
    const root = await makeRoot();
    await execFileAsync("git", ["init", "-q", root]);
    await expect(
      createLiveGitIgnoreOracle(root, syntheticScope()),
    ).rejects.toThrow("requires captured evaluator provenance");
  });

  it("replays parent, nested, info, global, prefix, negation, and directory rules", async () => {
    const { workspace, scope } = await fixture();
    const paths: GitIgnorePath[] = [
      { path: "root-only.log", kind: "non-directory" },
      { path: "parent-only.tmp", kind: "non-directory" },
      { path: "ordinary.log", kind: "non-directory" },
      { path: "keep.log", kind: "non-directory" },
      { path: "sub/ordinary.tmp", kind: "non-directory" },
      { path: "info.ignore", kind: "non-directory" },
      { path: "global.ignore", kind: "non-directory" },
      { path: "build", kind: "directory" },
      { path: ".gitignore", kind: "non-directory" },
      { path: "line\nbreak.log", kind: "non-directory" },
      { path: "ordinary.txt", kind: "non-directory" },
    ];
    const expected = [
      false,
      false,
      false,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
    ];
    const live = await createLiveGitIgnoreOracle(workspace, scope);
    const synthetic = await createSyntheticGitIgnoreOracle(scope);
    try {
      await expect(live.managed(paths)).resolves.toEqual(expected);
      await expect(synthetic.managed(paths)).resolves.toEqual(expected);
    } finally {
      await live.close();
      await synthetic.close();
    }
  });

  it("treats CRLF blank lines as non-rules for directory queries", async () => {
    const root = await makeRoot();
    await execFileAsync("git", ["init", "-q", root]);
    await mkdir(join(root, "src"));
    await put(join(root, ".gitignore"), "src/\r\n\r\n");
    const discovery = await discoverWorkspaceScope(root);
    const live = await createLiveGitIgnoreOracle(root, discovery.scope);
    const synthetic = await createSyntheticGitIgnoreOracle(discovery.scope);
    const query: GitIgnorePath[] = [{ path: "src", kind: "directory" }];
    try {
      expect(live.gitVersion).toMatch(/^git version /u);
      expect(synthetic.gitVersion).toBe(live.gitVersion);
      await expect(live.managed(query)).resolves.toEqual([false]);
      await expect(synthetic.managed(query)).resolves.toEqual([false]);
    } finally {
      await live.close();
      await synthetic.close();
    }
  });

  it("preserves NUL-free CRLF and non-UTF-8 current policy bytes", async () => {
    const root = await makeRoot();
    await execFileAsync("git", ["init", "-q", root]);
    const policy = Buffer.from([0xff, 0x0d, 0x0a]);
    await put(join(root, ".gitignore"), policy);

    const discovery = await discoverWorkspaceScope(root);
    expect(discovery.scope).toMatchObject({
      kind: "git",
      gitignoreSources: [{ contentsBase64: policy.toString("base64") }],
    });
  });

  it.each(["gitignore", "info", "global"])(
    "rejects NUL bytes in the current %s policy before oracle startup",
    async (source) => {
      const root = await makeRoot();
      await execFileAsync("git", ["init", "-q", root]);
      const policy = Buffer.from([0x2a, 0x00, 0x0a]);
      if (source === "gitignore") {
        await put(join(root, ".gitignore"), policy);
      } else if (source === "info") {
        await put(join(root, ".git", "info", "exclude"), policy);
      } else {
        const globalPath = join(root, "global-ignore");
        await put(globalPath, policy);
        await git(root, "config", "core.excludesFile", globalPath);
      }
      await expect(discoverWorkspaceScope(root)).rejects.toThrow(
        "contains a NUL byte",
      );
    },
  );

  it("preserves nested policy loading order for a self-matching source", async () => {
    const scope = canonicalizeWorkspaceScope({
      kind: "git",
      repositoryPrefix: "",
      evaluator: null,
      ignoreCase: false,
      gitignoreSources: [
        workspaceGitignoreSource(".gitignore", Buffer.alloc(0)),
        workspaceGitignoreSource("sub/.gitignore", Buffer.from("*\n")),
      ],
      infoExcludeBase64: "",
      globalExcludeBase64: "",
    });
    const synthetic = await createSyntheticGitIgnoreOracle(scope);
    try {
      await expect(
        synthetic.managed([{ path: "sub", kind: "directory" }]),
      ).resolves.toEqual([true]);
      await expect(
        synthetic.managed([
          { path: "sub/.gitignore", kind: "non-directory" },
          { path: "sub/file.txt", kind: "non-directory" },
        ]),
      ).resolves.toEqual([false, false]);
    } finally {
      await synthetic.close();
    }
  });

  it("looks up only policy directories visible to a small query", async () => {
    const root = await makeRoot();
    let unreachablePathReads = 0;
    const unreachableSources: SyntheticGitPolicySource[] = Array.from(
      { length: 2_000 },
      (_, index) => ({
        get path() {
          unreachablePathReads += 1;
          return `archive-${index}/.gitignore`;
        },
        contents: Buffer.alloc(0),
      }),
    );
    const shape = new SyntheticGitDirectoryShape(root, [
      { path: ".gitignore", contents: Buffer.alloc(0) },
      ...unreachableSources,
    ]);
    unreachablePathReads = 0;

    await expect(
      shape.materialize([{ path: "target/file.txt", kind: "non-directory" }]),
    ).resolves.toEqual([true]);

    expect(unreachablePathReads).toBe(0);
  });

  it("does not enumerate prior query history when planning a later batch", async () => {
    const root = await makeRoot();
    const shape = new SyntheticGitDirectoryShape(root, []);
    const history = Array.from({ length: 512 }, (_, index) => ({
      path: `history-${index}`,
      kind: "non-directory" as const,
    }));
    await shape.materialize(history);

    const descriptor = Object.getOwnPropertyDescriptor(
      Map.prototype,
      Symbol.iterator,
    );
    if (descriptor?.value === undefined) {
      throw new Error("Map iterator descriptor is unavailable");
    }
    const original = descriptor.value as typeof Map.prototype.entries;
    let historyEntriesRead = 0;
    Object.defineProperty(Map.prototype, Symbol.iterator, {
      ...descriptor,
      value: function* (this: Map<unknown, unknown>) {
        const isHistory = this.size === history.length;
        for (const entry of original.call(this)) {
          if (isHistory) historyEntriesRead += 1;
          yield entry;
        }
      },
    });
    try {
      await shape.materialize([
        { path: "one-later-query", kind: "non-directory" },
      ]);
    } finally {
      Object.defineProperty(Map.prototype, Symbol.iterator, descriptor);
    }

    expect(historyEntriesRead).toBe(0);
  });

  it("materializes parent shape so a child can be re-included", async () => {
    const synthetic = await createSyntheticGitIgnoreOracle(
      syntheticScope("foo/*\n!foo/keep\n"),
    );
    try {
      await expect(
        synthetic.managed([{ path: "foo", kind: "directory" }]),
      ).resolves.toEqual([true]);
      await expect(
        synthetic.managed([
          { path: "foo/drop", kind: "non-directory" },
          { path: "foo/keep", kind: "non-directory" },
        ]),
      ).resolves.toEqual([false, true]);
    } finally {
      await synthetic.close();
    }
  });

  it("uses physical shape, not wire punctuation, for directory-only rules", async () => {
    const directoryOracle = await createSyntheticGitIgnoreOracle(
      syntheticScope("build/\n"),
    );
    const fileOracle = await createSyntheticGitIgnoreOracle(
      syntheticScope("build/\n"),
    );
    try {
      await expect(
        directoryOracle.managed([{ path: "build", kind: "directory" }]),
      ).resolves.toEqual([false]);
      await expect(
        fileOracle.managed([{ path: "build", kind: "non-directory" }]),
      ).resolves.toEqual([true]);
    } finally {
      await directoryOracle.close();
      await fileOracle.close();
    }
  });

  it("prefixes leading-colon paths so Git cannot parse pathspec magic", async () => {
    const path = ":(literal)foo";
    const synthetic = await createSyntheticGitIgnoreOracle(
      syntheticScope(`${path}\n`),
    );
    try {
      await expect(
        synthetic.managed([{ path, kind: "non-directory" }]),
      ).resolves.toEqual([false]);
    } finally {
      await synthetic.close();
    }
  });

  it("uses and fully cleans an explicit private scratch parent", async () => {
    const scratchParent = await makeRoot();
    const forbiddenRoot = await makeRoot();
    const scope = syntheticScope();
    const oracle = await createSyntheticGitIgnoreOracle(scope, {
      scratchParent,
      forbiddenRoots: [forbiddenRoot],
    });

    try {
      expect(await readdir(scratchParent)).toHaveLength(1);
      await expect(
        oracle.managed([
          { path: "drop.log", kind: "non-directory" },
          { path: "keep.txt", kind: "non-directory" },
        ]),
      ).resolves.toEqual([false, true]);
    } finally {
      await oracle.close();
    }

    expect(await readdir(scratchParent)).toEqual([]);
    expect(await readdir(forbiddenRoot)).toEqual([]);
  });

  it("cleans explicit scratch when synthetic Git initialization fails", async () => {
    const scratchParent = await makeRoot();
    const emptyExecutablePath = await makeRoot();
    const scope = syntheticScope();

    await expect(
      withEnvironment({ PATH: emptyExecutablePath }, () =>
        createSyntheticGitIgnoreOracle(scope, { scratchParent }),
      ),
    ).rejects.toThrow();

    expect(await readdir(scratchParent)).toEqual([]);
  });

  it("refuses to clean a replaced active scratch root", async (context) => {
    context.skip(
      process.platform === "win32",
      "Windows does not reliably allow renaming a running Git process's cwd",
    );
    const scratchParent = await makeRoot();
    const scope = syntheticScope();
    const oracle = await createSyntheticGitIgnoreOracle(scope, {
      scratchParent,
    });
    try {
      const entries = await readdir(scratchParent);
      expect(entries).toHaveLength(1);
      const activePath = join(scratchParent, entries[0]!);
      const displacedPath = join(scratchParent, "displaced-original");
      await rename(activePath, displacedPath);
      await mkdir(activePath);
      const sentinelPath = join(activePath, "sentinel");
      await writeFile(sentinelPath, "replacement must survive");

      await expect(oracle.close()).rejects.toThrow(
        "refusing to clean a replaced synthetic Git scratch directory",
      );

      await expect(readFile(sentinelPath, "utf8")).resolves.toBe(
        "replacement must survive",
      );
      expect(await readdir(displacedPath)).toContain("worktree");
    } finally {
      await oracle.close().catch(() => {});
    }
  });

  it("keeps a non-directory unmanaged when it conflicts with an archived policy directory", async () => {
    const policy = "a\n!a/\n*.log\n";
    const scope = canonicalizeWorkspaceScope({
      kind: "git",
      repositoryPrefix: "",
      evaluator: null,
      ignoreCase: false,
      gitignoreSources: [
        workspaceGitignoreSource(".gitignore", Buffer.from(policy)),
        workspaceGitignoreSource("a/.gitignore", Buffer.alloc(0)),
      ],
      infoExcludeBase64: "",
      globalExcludeBase64: "",
    });
    const synthetic = await createSyntheticGitIgnoreOracle(scope);
    try {
      await expect(
        synthetic.managed([{ path: "a", kind: "non-directory" }]),
      ).resolves.toEqual([false]);
    } finally {
      await synthetic.close();
    }
  });

  it("keeps a portable alias of an archived policy directory unmanaged", async () => {
    const policy = "a\n!a/\n";
    const scope = canonicalizeWorkspaceScope({
      kind: "git",
      repositoryPrefix: "",
      evaluator: null,
      ignoreCase: true,
      gitignoreSources: [
        workspaceGitignoreSource(".gitignore", Buffer.from(policy)),
        workspaceGitignoreSource("a/.gitignore", Buffer.alloc(0)),
      ],
      infoExcludeBase64: "",
      globalExcludeBase64: "",
    });
    const synthetic = await createSyntheticGitIgnoreOracle(scope);
    try {
      await expect(
        synthetic.managed([{ path: "A", kind: "non-directory" }]),
      ).resolves.toEqual([false]);
    } finally {
      await synthetic.close();
    }
  });

  it("keeps Unicode aliases of archived policy directories unmanaged", async () => {
    const scope = canonicalizeWorkspaceScope({
      kind: "git",
      repositoryPrefix: "",
      evaluator: null,
      ignoreCase: false,
      gitignoreSources: [
        workspaceGitignoreSource("Σ/.gitignore", Buffer.alloc(0)),
      ],
      infoExcludeBase64: "",
      globalExcludeBase64: "",
    });
    const synthetic = await createSyntheticGitIgnoreOracle(scope);
    try {
      await expect(
        synthetic.managed([{ path: "ς", kind: "non-directory" }]),
      ).resolves.toEqual([false]);
    } finally {
      await synthetic.close();
    }
  });

  it("rejects query kind drift after materializing a directory", async () => {
    const synthetic = await createSyntheticGitIgnoreOracle(syntheticScope());
    try {
      await expect(
        synthetic.managed([{ path: "a", kind: "directory" }]),
      ).resolves.toEqual([true]);
      await expect(
        synthetic.managed([{ path: "a", kind: "non-directory" }]),
      ).rejects.toThrow("cannot materialize the synthetic Git query shape");
    } finally {
      await synthetic.close().catch(() => {});
    }
  });

  it("keeps a directory at an archived policy-file path unmanaged", async () => {
    const synthetic = await createSyntheticGitIgnoreOracle(syntheticScope());
    try {
      await expect(
        synthetic.managed([{ path: ".gitignore", kind: "directory" }]),
      ).resolves.toEqual([false]);
    } finally {
      await synthetic.close();
    }
  });

  it("keeps synthetic control files outside legal policy and prefix paths", async () => {
    const scope = canonicalizeWorkspaceScope({
      kind: "git",
      repositoryPrefix: "empty.gitconfig/workspace",
      evaluator: null,
      ignoreCase: false,
      gitignoreSources: [
        workspaceGitignoreSource(
          "empty.gitconfig/.gitignore",
          Buffer.from("*.tmp\n"),
        ),
      ],
      infoExcludeBase64: "",
      globalExcludeBase64: "",
    });
    const oracle = await createSyntheticGitIgnoreOracle(scope);
    try {
      await expect(
        oracle.managed([
          { path: "drop.tmp", kind: "non-directory" },
          { path: "keep.txt", kind: "non-directory" },
        ]),
      ).resolves.toEqual([false, true]);
    } finally {
      await oracle.close();
    }
  });

  it("parses a fragmented multi-megabyte NUL stream without losing records", async () => {
    const { workspace, scope } = await fixture();
    const oracle = await createLiveGitIgnoreOracle(workspace, scope);
    const paths: GitIgnorePath[] = Array.from(
      { length: 8_000 },
      (_, index) => ({
        path: `fragment-${index}-${"x".repeat(160)}.log`,
        kind: "non-directory",
      }),
    );
    try {
      const managed = await oracle.managed(paths);
      expect(managed).toHaveLength(paths.length);
      expect(managed.every((value) => !value)).toBe(true);
    } finally {
      await oracle.close();
    }
  });

  it("rejects a zero line number without decoding protocol bytes as text", async (context) => {
    context.skip(
      process.platform === "win32",
      "fake executable fixture is POSIX-only",
    );
    await withFakeOracleGit("zero-line", async () => {
      const oracle = await createSyntheticGitIgnoreOracle(syntheticScope());
      try {
        await expect(
          oracle.managed([{ path: "drop.log", kind: "non-directory" }]),
        ).rejects.toThrow("returned a malformed record");
      } finally {
        await oracle.close().catch(() => {});
      }
    });
  });

  it("retains strict rejection of an empty matching pattern", async (context) => {
    context.skip(
      process.platform === "win32",
      "fake executable fixture is POSIX-only",
    );
    await withFakeOracleGit("empty-pattern", async () => {
      const oracle = await createSyntheticGitIgnoreOracle(syntheticScope());
      try {
        await expect(
          oracle.managed([{ path: "drop.log", kind: "non-directory" }]),
        ).rejects.toThrow("returned a malformed record");
      } finally {
        await oracle.close().catch(() => {});
      }
    });
  });

  it("rejects an EOF fragment instead of waiting for a query timeout", async (context) => {
    context.skip(
      process.platform === "win32",
      "fake executable fixture is POSIX-only",
    );
    await withFakeOracleGit("partial-eof", async () => {
      const oracle = await createSyntheticGitIgnoreOracle(syntheticScope());
      try {
        await expect(
          oracle.managed([{ path: "drop.log", kind: "non-directory" }]),
        ).rejects.toThrow("ended with an incomplete record");
      } finally {
        await oracle.close().catch(() => {});
      }
    });
  });

  it("rejects an overlong query path before writing it to Git", async () => {
    const oracle = await createSyntheticGitIgnoreOracle(syntheticScope());
    try {
      await expect(
        oracle.managed([
          {
            path: "a".repeat(DEFAULT_MAX_WORKSPACE_RELATIVE_PATH_BYTES + 1),
            kind: "non-directory",
          },
        ]),
      ).rejects.toThrow("invalid Git ignore query");
    } finally {
      await oracle.close();
    }
  });

  it("uses configured path limits for oracle queries", async () => {
    const overDefault = "a".repeat(
      DEFAULT_MAX_WORKSPACE_RELATIVE_PATH_BYTES + 1,
    );
    const oracle = await createSyntheticGitIgnoreOracle(
      { kind: "all-managed" },
      {
        pathLimits: {
          maxPathBytes: Buffer.byteLength(overDefault),
          maxPathComponents: 256,
        },
      },
    );
    try {
      await expect(
        oracle.managed([{ path: overDefault, kind: "non-directory" }]),
      ).resolves.toEqual([true]);
    } finally {
      await oracle.close();
    }
  });

  it("serializes concurrent batches and rejects use after close", async () => {
    const { scope } = await fixture();
    const oracle = await createSyntheticGitIgnoreOracle(scope);
    await expect(
      Promise.all([
        oracle.managed([{ path: "one.log", kind: "non-directory" }]),
        oracle.managed([{ path: "two.txt", kind: "non-directory" }]),
      ]),
    ).resolves.toEqual([[false], [true]]);
    await oracle.close();
    await expect(
      oracle.managed([{ path: "late", kind: "non-directory" }]),
    ).rejects.toThrow("closed");
  });

  it("treats an explicitly empty core.excludesFile as disabled", async () => {
    const root = await makeRoot();
    await execFileAsync("git", ["init", "-q", root]);
    await git(root, "config", "core.excludesFile", "");
    const discovery = await discoverWorkspaceScope(root);
    expect(discovery.scope).toMatchObject({
      kind: "git",
      globalExcludeBase64: "",
    });
  });

  it.each([
    ["CR", "\r"],
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])(
    "preserves a core.excludesFile path ending in %s",
    async (_label, suffix) => {
      if (process.platform === "win32") return;
      const root = await makeRoot();
      await execFileAsync("git", ["init", "-q", root]);
      const globalPath = join(root, `global-ignore${suffix}`);
      const policy = Buffer.from("global.ignore\n");
      await put(globalPath, policy);
      await git(root, "config", "core.excludesFile", globalPath);

      const discovery = await discoverWorkspaceScope(root);
      expect(discovery.scope).toMatchObject({
        kind: "git",
        globalExcludeBase64: policy.toString("base64"),
      });
    },
  );

  it.each([
    ["dirty-bool-absence", "cannot read Git core.ignoreCase"],
    ["dirty-global-absence", "cannot determine Git core.excludesFile"],
    ["multiple-global-records", "malformed core.excludesFile path"],
  ] as const)(
    "rejects %s instead of treating it as an absent config key",
    async (mode, message) => {
      if (process.platform === "win32") return;
      const root = await makeRoot();
      await execFileAsync("git", ["init", "-q", root]);
      await expect(
        withFakeGitCommand(mode, () => discoverWorkspaceScope(root)),
      ).rejects.toThrow(message);
    },
  );

  it("archives Git's default XDG global excludes file", async () => {
    const root = await makeRoot();
    const home = await makeRoot();
    const xdg = await makeRoot();
    await execFileAsync("git", ["init", "-q", root]);
    const policy = "xdg.ignore\n";
    await put(join(xdg, "git", "ignore"), policy);

    await withEnvironment({ HOME: home, XDG_CONFIG_HOME: xdg }, async () => {
      const discovery = await discoverWorkspaceScope(root);
      expect(discovery.scope).toMatchObject({
        kind: "git",
        globalExcludeBase64: Buffer.from(policy).toString("base64"),
      });
      const live = await createLiveGitIgnoreOracle(root, discovery.scope);
      try {
        await expect(
          live.managed([{ path: "xdg.ignore", kind: "non-directory" }]),
        ).resolves.toEqual([false]);
      } finally {
        await live.close();
      }
    });
  });

  it("honors process-level Git config without accepting repository routing", async () => {
    const root = await makeRoot();
    const configRoot = await makeRoot();
    await execFileAsync("git", ["init", "-q", root]);
    const policyPath = join(configRoot, "process-ignore");
    const configPath = join(configRoot, "global.gitconfig");
    await writeFile(policyPath, "process.ignore\n");
    await execFileAsync("git", [
      "config",
      "--file",
      configPath,
      "core.excludesFile",
      policyPath,
    ]);

    await withEnvironment(
      {
        GIT_CONFIG_GLOBAL: configPath,
        GIT_CONFIG_SYSTEM: undefined,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_PARAMETERS: undefined,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.ignoreCase",
        GIT_CONFIG_VALUE_0: "true",
        GIT_DIR: join(configRoot, "not-the-workspace-repository"),
      },
      async () => {
        const discovery = await discoverWorkspaceScope(root);
        expect(discovery.scope).toMatchObject({
          kind: "git",
          ignoreCase: true,
          globalExcludeBase64:
            Buffer.from("process.ignore\n").toString("base64"),
        });
        const live = await createLiveGitIgnoreOracle(root, discovery.scope);
        const synthetic = await createSyntheticGitIgnoreOracle(discovery.scope);
        try {
          await expect(
            live.managed([{ path: "process.ignore", kind: "non-directory" }]),
          ).resolves.toEqual([false]);
          await expect(
            synthetic.managed([
              { path: "process.ignore", kind: "non-directory" },
            ]),
          ).resolves.toEqual([false]);
        } finally {
          await live.close();
          await synthetic.close();
        }
      },
    );
  });

  it("isolates synthetic replay from host GIT_* routing and config injection", async () => {
    const poisonRoot = await makeRoot();
    const poison = join(poisonRoot, "poison-ignore");
    await writeFile(poison, "poisoned.txt\n");
    const scope = canonicalizeWorkspaceScope({
      kind: "git",
      repositoryPrefix: "",
      evaluator: null,
      ignoreCase: false,
      gitignoreSources: [],
      infoExcludeBase64: "",
      globalExcludeBase64: "",
    });

    await withEnvironment(
      {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.excludesFile",
        GIT_CONFIG_VALUE_0: poison,
        GIT_DIR: join(poisonRoot, "not-a-repository"),
      },
      async () => {
        const synthetic = await createSyntheticGitIgnoreOracle(scope);
        try {
          await expect(
            synthetic.managed([
              { path: "poisoned.txt", kind: "non-directory" },
            ]),
          ).resolves.toEqual([true]);
        } finally {
          await synthetic.close();
        }
      },
    );
  });

  it("fails closed with Git's diagnostics for a symlinked .gitignore", async () => {
    const root = await makeRoot();
    await execFileAsync("git", ["init", "-q", root]);
    await put(join(root, "rules"), "*.log\n");
    await symlink("rules", join(root, ".gitignore"));
    const discovery = await discoverWorkspaceScope(root);
    expect(discovery.scope).toMatchObject({
      kind: "git",
      gitignoreSources: [],
    });

    const live = await createLiveGitIgnoreOracle(root, discovery.scope);
    const synthetic = await createSyntheticGitIgnoreOracle(discovery.scope);
    try {
      const paths: GitIgnorePath[] = [
        { path: "a.log", kind: "non-directory" },
        { path: ".gitignore", kind: "non-directory" },
      ];
      await expect(live.managed(paths)).rejects.toThrow(
        "Git ignore oracle produced diagnostics",
      );
      await expect(synthetic.managed(paths)).resolves.toEqual([true, true]);
    } finally {
      await live.close().catch(() => {});
      await synthetic.close();
    }
  });

  it("captures the common info/exclude policy in a linked worktree", async () => {
    const repository = await makeRoot();
    const worktreeContainer = await makeRoot();
    const workspace = join(worktreeContainer, "linked");
    await execFileAsync("git", ["init", "-q", repository]);
    await git(
      repository,
      "-c",
      "user.name=Cyclotomy",
      "-c",
      "user.email=cyclotomy@example.invalid",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "root",
    );
    await git(repository, "worktree", "add", "-q", workspace);
    await put(join(repository, ".git", "info", "exclude"), "common.ignore\n");

    const discovery = await discoverWorkspaceScope(workspace);
    expect(discovery.scope).toMatchObject({
      kind: "git",
      infoExcludeBase64: Buffer.from("common.ignore\n").toString("base64"),
    });
    const oracle = await createLiveGitIgnoreOracle(workspace, discovery.scope);
    try {
      await expect(
        oracle.managed([{ path: "common.ignore", kind: "non-directory" }]),
      ).resolves.toEqual([false]);
    } finally {
      await oracle.close();
    }
  });
});
