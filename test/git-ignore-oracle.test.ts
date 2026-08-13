import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

function syntheticScope(policy = "*.log\n"): GitWorkspaceScope {
  const scope = canonicalizeWorkspaceScope({
    kind: "git",
    repositoryPrefix: "",
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

    const fullSource = Buffer.alloc(MAX_GITIGNORE_SOURCE_BYTES).toString(
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
        infoExcludeBase64: "AA==",
      }),
    ).toThrow("policy byte limit");
  });

  it("bounds incrementally accumulated policy before a scope is assembled", () => {
    const budget = new WorkspaceGitPolicyBudget();
    const fullSource = Buffer.alloc(MAX_GITIGNORE_SOURCE_BYTES).toString(
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
    await expect(
      oracle.managed([
        { path: ".gitignore", isDirectory: false },
        { path: "nested/file", isDirectory: false },
      ]),
    ).resolves.toEqual([true, true]);
    await oracle.close();
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

  it("replays parent, nested, info, global, prefix, negation, and directory rules", async () => {
    const { workspace, scope } = await fixture();
    const paths: GitIgnorePath[] = [
      { path: "root-only.log", isDirectory: false },
      { path: "parent-only.tmp", isDirectory: false },
      { path: "ordinary.log", isDirectory: false },
      { path: "keep.log", isDirectory: false },
      { path: "sub/ordinary.tmp", isDirectory: false },
      { path: "info.ignore", isDirectory: false },
      { path: "global.ignore", isDirectory: false },
      { path: "build", isDirectory: true },
      { path: "build", isDirectory: false },
      { path: ".gitignore", isDirectory: false },
      { path: "line\nbreak.log", isDirectory: false },
      { path: "ordinary.txt", isDirectory: false },
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
      true,
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
          { path: "drop.log", isDirectory: false },
          { path: "keep.txt", isDirectory: false },
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

  it("does not let synthetic policy directories change a non-directory decision", async () => {
    const root = await makeRoot();
    await execFileAsync("git", ["init", "-q", root]);
    const policy = "a\n!a/\n*.log\n";
    await put(join(root, ".gitignore"), policy);
    await put(join(root, "a"), "current regular file");
    const scope = canonicalizeWorkspaceScope({
      kind: "git",
      repositoryPrefix: "",
      ignoreCase: false,
      gitignoreSources: [
        workspaceGitignoreSource(".gitignore", Buffer.from(policy)),
        workspaceGitignoreSource("a/.gitignore", Buffer.alloc(0)),
      ],
      infoExcludeBase64: "",
      globalExcludeBase64: "",
    });
    const paths: GitIgnorePath[] = [
      { path: "ordinary.txt", isDirectory: false },
      { path: "a", isDirectory: false },
      { path: "a", isDirectory: true },
      { path: "drop.log", isDirectory: false },
    ];
    const live = await createLiveGitIgnoreOracle(root, scope);
    const synthetic = await createSyntheticGitIgnoreOracle(scope);
    try {
      await expect(live.managed(paths)).resolves.toEqual([
        true,
        false,
        true,
        false,
      ]);
      await expect(synthetic.managed(paths)).resolves.toEqual([
        true,
        false,
        true,
        false,
      ]);
    } finally {
      await live.close();
      await synthetic.close();
    }
  });

  it("detects synthetic policy-directory conflicts through ignoreCase aliases", async () => {
    const root = await makeRoot();
    await execFileAsync("git", ["init", "-q", root]);
    await git(root, "config", "core.ignoreCase", "true");
    const policy = "a\n!a/\n";
    await put(join(root, ".gitignore"), policy);
    await put(join(root, "A"), "current regular file");
    const scope = canonicalizeWorkspaceScope({
      kind: "git",
      repositoryPrefix: "",
      ignoreCase: true,
      gitignoreSources: [
        workspaceGitignoreSource(".gitignore", Buffer.from(policy)),
        workspaceGitignoreSource("a/.gitignore", Buffer.alloc(0)),
      ],
      infoExcludeBase64: "",
      globalExcludeBase64: "",
    });
    const paths: GitIgnorePath[] = [
      { path: "ordinary.txt", isDirectory: false },
      { path: "A", isDirectory: false },
      { path: "A", isDirectory: true },
    ];
    const live = await createLiveGitIgnoreOracle(root, scope);
    const synthetic = await createSyntheticGitIgnoreOracle(scope);
    try {
      await expect(live.managed(paths)).resolves.toEqual([true, false, true]);
      await expect(synthetic.managed(paths)).resolves.toEqual([
        true,
        false,
        true,
      ]);
    } finally {
      await live.close();
      await synthetic.close();
    }
  });

  it("keeps Unicode policy-directory aliases unmanaged when Git matching is case-sensitive", async () => {
    const scope = canonicalizeWorkspaceScope({
      kind: "git",
      repositoryPrefix: "",
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
        synthetic.managed([
          { path: "ς", isDirectory: false },
          { path: "ς", isDirectory: true },
        ]),
      ).resolves.toEqual([false, true]);
    } finally {
      await synthetic.close();
    }
  });

  it("keeps synthetic control files outside legal policy and prefix paths", async () => {
    const scope = canonicalizeWorkspaceScope({
      kind: "git",
      repositoryPrefix: "empty.gitconfig/workspace",
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
          { path: "drop.tmp", isDirectory: false },
          { path: "keep.txt", isDirectory: false },
        ]),
      ).resolves.toEqual([false, true]);
    } finally {
      await oracle.close();
    }
  });

  it("parses a fragmented multi-megabyte NUL stream without losing records", async () => {
    const { workspace, scope } = await fixture();
    const oracle = await createLiveGitIgnoreOracle(workspace, scope);
    const paths = Array.from({ length: 8_000 }, (_, index) => ({
      path: `fragment-${index}-${"x".repeat(160)}.log`,
      isDirectory: false,
    }));
    try {
      const managed = await oracle.managed(paths);
      expect(managed).toHaveLength(paths.length);
      expect(managed.every((value) => !value)).toBe(true);
    } finally {
      await oracle.close();
    }
  });

  it("rejects an overlong query path before writing it to Git", async () => {
    const oracle = await createSyntheticGitIgnoreOracle(syntheticScope());
    try {
      await expect(
        oracle.managed([
          {
            path: "a".repeat(DEFAULT_MAX_WORKSPACE_RELATIVE_PATH_BYTES + 1),
            isDirectory: false,
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
        oracle.managed([{ path: overDefault, isDirectory: false }]),
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
        oracle.managed([{ path: "one.log", isDirectory: false }]),
        oracle.managed([{ path: "two.txt", isDirectory: false }]),
      ]),
    ).resolves.toEqual([[false], [true]]);
    await oracle.close();
    await expect(
      oracle.managed([{ path: "late", isDirectory: false }]),
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
          live.managed([{ path: "xdg.ignore", isDirectory: false }]),
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
            live.managed([{ path: "process.ignore", isDirectory: false }]),
          ).resolves.toEqual([false]);
          await expect(
            synthetic.managed([{ path: "process.ignore", isDirectory: false }]),
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
            synthetic.managed([{ path: "poisoned.txt", isDirectory: false }]),
          ).resolves.toEqual([true]);
        } finally {
          await synthetic.close();
        }
      },
    );
  });

  it("handles Git's expected live warning for a symlinked .gitignore", async () => {
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
      const paths = [
        { path: "a.log", isDirectory: false },
        { path: ".gitignore", isDirectory: false },
      ];
      await expect(live.managed(paths)).resolves.toEqual([true, true]);
      await expect(synthetic.managed(paths)).resolves.toEqual([true, true]);
    } finally {
      await live.close();
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
        oracle.managed([{ path: "common.ignore", isDirectory: false }]),
      ).resolves.toEqual([false]);
    } finally {
      await oracle.close();
    }
  });
});
