import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { constants as fsConstants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rmdir,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  MAX_GITIGNORE_POLICY_BYTES,
  MAX_GITIGNORE_SOURCES,
  MAX_GITIGNORE_SOURCE_BYTES,
  canonicalWorkspaceRelativePath,
  canonicalizeWorkspaceScope,
  workspaceGitignoreSource,
  workspaceScopePathKey,
  workspaceScopeBytes,
  type GitWorkspaceScope,
  type WorkspaceGitignoreSource,
  type WorkspaceScope,
} from "./workspace-scope.ts";

const GIT_COMMAND_TIMEOUT_MS = 5_000;
const MAX_GIT_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const MAX_ORACLE_BATCH_PATHS = 100_000;
const MAX_ORACLE_BATCH_BYTES = 16 * 1024 * 1024;
const MAX_ORACLE_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_LIVE_ORACLE_DIAGNOSTIC_BYTES = 64 * 1024;

export class GitIgnoreOracleError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GitIgnoreOracleError";
  }
}

export interface GitIgnorePath {
  readonly path: string;
  readonly isDirectory: boolean;
}

export interface GitIgnoreOracle {
  /** `true` means the target-time policy owns the path. */
  managed(paths: readonly GitIgnorePath[]): Promise<readonly boolean[]>;
  close(): Promise<void>;
}

export interface SyntheticGitIgnoreScratchOptions {
  /**
   * Existing directory in which the private operation-local oracle directory
   * is created. Runtime callers use their authenticated object-store root;
   * standalone callers default to the process temporary directory.
   */
  readonly scratchParent?: string;
  /** Roots under which synthetic policy bytes must never be materialized. */
  readonly forbiddenRoots?: readonly string[];
}

/**
 * Bound policy accumulation before a complete scope exists to canonicalize.
 * Callers retain the source map; this keeps only byte lengths so replacement
 * accounting stays O(1).
 */
export class WorkspaceGitPolicyBudget {
  readonly #sourceBytes = new Map<string, number>();
  #totalBytes = 0;

  constructor(scope?: WorkspaceScope) {
    if (scope === undefined) return;
    const canonical = canonicalizeWorkspaceScope(scope);
    if (canonical.kind === "all-managed") return;
    for (const source of canonical.gitignoreSources) {
      this.upsertGitignoreSource(source);
    }
    this.addExternalPolicy(
      workspaceScopeBytes(canonical.infoExcludeBase64),
      "Git info/exclude",
    );
    this.addExternalPolicy(
      workspaceScopeBytes(canonical.globalExcludeBase64),
      "Git global excludes file",
    );
  }

  upsertGitignoreSource(source: WorkspaceGitignoreSource): void {
    const path = canonicalWorkspaceRelativePath(source.path, false);
    const byteLength = workspaceScopeBytes(source.contentsBase64).byteLength;
    const previousBytes = this.#sourceBytes.get(path);
    const sourceCount =
      this.#sourceBytes.size + (previousBytes === undefined ? 1 : 0);
    if (sourceCount > MAX_GITIGNORE_SOURCES) {
      throw new GitIgnoreOracleError("Git ignore policy has too many sources");
    }
    const totalBytes = this.#totalBytes - (previousBytes ?? 0) + byteLength;
    if (totalBytes > MAX_GITIGNORE_POLICY_BYTES) {
      throw new GitIgnoreOracleError(
        "Git ignore policy exceeds the byte limit",
      );
    }
    this.#sourceBytes.set(path, byteLength);
    this.#totalBytes = totalBytes;
  }

  addExternalPolicy(contents: Uint8Array, label: string): void {
    if (contents.byteLength > MAX_GITIGNORE_SOURCE_BYTES) {
      throw new GitIgnoreOracleError(
        `${label} exceeds the per-source byte limit`,
      );
    }
    const totalBytes = this.#totalBytes + contents.byteLength;
    if (totalBytes > MAX_GITIGNORE_POLICY_BYTES) {
      throw new GitIgnoreOracleError(
        "Git ignore policy exceeds the byte limit",
      );
    }
    this.#totalBytes = totalBytes;
  }
}

interface GitWorktreeContext {
  readonly workspaceRoot: string;
  readonly repositoryRoot: string;
  readonly repositoryPrefix: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface DiscoveredWorkspaceScope {
  readonly workspaceRoot: string;
  readonly repositoryRoot?: string;
  /** Ancestor `.gitignore` plus external sources; nested sources are appended by the scanner. */
  readonly scope: WorkspaceScope;
}

interface GitCommandResult {
  readonly stdout: Buffer;
}

interface GitCommandFailure extends Error {
  readonly code?: number | string;
  readonly stdout?: Buffer;
  readonly stderr?: Buffer;
  readonly killed?: boolean;
}

function isProcessGitConfigEnvironment(key: string): boolean {
  return (
    key === "GIT_CONFIG_GLOBAL" ||
    key === "GIT_CONFIG_SYSTEM" ||
    key === "GIT_CONFIG_NOSYSTEM" ||
    key === "GIT_CONFIG_PARAMETERS" ||
    key === "GIT_CONFIG_COUNT" ||
    /^GIT_CONFIG_(?:KEY|VALUE)_[0-9]+$/u.test(key)
  );
}

function sanitizedGitEnvironment(
  preserveProcessConfig = true,
): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => {
      const normalized = key.toUpperCase();
      return (
        normalized !== "LC_ALL" &&
        normalized !== "LANG" &&
        (!normalized.startsWith("GIT_") ||
          (preserveProcessConfig && isProcessGitConfigEnvironment(normalized)))
      );
    }),
  );
  return { ...env, LC_ALL: "C", LANG: "C", GIT_FLUSH: "1" };
}

function isolatedGitEnvironment(configPath: string): NodeJS.ProcessEnv {
  return {
    // Archived replay must not inherit any live process-level config overlay.
    ...sanitizedGitEnvironment(false),
    GIT_CONFIG_GLOBAL: configPath,
    GIT_CONFIG_SYSTEM: configPath,
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

function runGit(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeout = GIT_COMMAND_TIMEOUT_MS,
): Promise<GitCommandResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      [...args],
      {
        encoding: "buffer",
        env,
        timeout,
        maxBuffer: MAX_GIT_COMMAND_OUTPUT_BYTES,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          const failure = error as unknown as GitCommandFailure;
          Object.assign(failure, {
            stdout: Buffer.from(stdout),
            stderr: Buffer.from(stderr),
          });
          reject(failure);
          return;
        }
        const stderrBytes = Buffer.from(stderr);
        if (stderrBytes.byteLength !== 0) {
          reject(new GitIgnoreOracleError("Git command produced diagnostics"));
          return;
        }
        resolvePromise({ stdout: Buffer.from(stdout) });
      },
    );
  });
}

function failureStderr(cause: unknown): string {
  if (typeof cause !== "object" || cause === null) return "";
  const stderr = Reflect.get(cause, "stderr");
  if (Buffer.isBuffer(stderr)) return stderr.toString("utf8");
  return typeof stderr === "string" ? stderr : "";
}

function failureCode(cause: unknown): number | string | undefined {
  return typeof cause === "object" && cause !== null
    ? (Reflect.get(cause, "code") as number | string | undefined)
    : undefined;
}

function isNotRepository(cause: unknown): boolean {
  return (
    failureCode(cause) === 128 &&
    failureStderr(cause).includes("not a git repository")
  );
}

function decodeSingleLine(bytes: Buffer, label: string): string {
  let value = bytes;
  if (value.at(-1) === 0x0a) value = value.subarray(0, -1);
  if (value.at(-1) === 0x0d) value = value.subarray(0, -1);
  if (value.includes(0x00) || value.includes(0x0a) || value.includes(0x0d)) {
    throw new GitIgnoreOracleError(`Git returned an ambiguous ${label}`);
  }
  const text = value.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(value)) {
    throw new GitIgnoreOracleError(`Git returned a non-UTF-8 ${label}`);
  }
  return text;
}

async function locateGitWorktree(
  root: string,
): Promise<GitWorktreeContext | undefined> {
  let workspaceRoot: string;
  try {
    workspaceRoot = await realpath(resolve(root));
  } catch (cause) {
    throw new GitIgnoreOracleError("workspace root is not readable", { cause });
  }
  const env = sanitizedGitEnvironment();
  try {
    const inside = await runGit(
      ["-C", workspaceRoot, "rev-parse", "--is-inside-work-tree"],
      env,
    );
    if (decodeSingleLine(inside.stdout, "worktree result") !== "true") {
      return undefined;
    }
  } catch (cause) {
    if (isNotRepository(cause)) return undefined;
    throw new GitIgnoreOracleError(
      "cannot determine whether the workspace is a Git worktree",
      { cause },
    );
  }

  let repositoryRoot: string;
  try {
    const result = await runGit(
      ["-C", workspaceRoot, "rev-parse", "--show-toplevel"],
      env,
    );
    repositoryRoot = await realpath(
      decodeSingleLine(result.stdout, "worktree root"),
    );
  } catch (cause) {
    if (cause instanceof GitIgnoreOracleError) throw cause;
    throw new GitIgnoreOracleError("cannot determine the Git worktree root", {
      cause,
    });
  }
  const nativePrefix = relative(repositoryRoot, workspaceRoot);
  if (
    nativePrefix === ".." ||
    nativePrefix.startsWith(`..${sep}`) ||
    isAbsolute(nativePrefix)
  ) {
    throw new GitIgnoreOracleError(
      "workspace is outside the reported Git worktree",
    );
  }
  const repositoryPrefix = canonicalWorkspaceRelativePath(
    nativePrefix === "" ? "" : nativePrefix.split(sep).join("/"),
    true,
  );
  return { workspaceRoot, repositoryRoot, repositoryPrefix, env };
}

function sameFile(
  left: Awaited<ReturnType<FileHandle["stat"]>>,
  right: Awaited<ReturnType<FileHandle["stat"]>>,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function readHandleBounded(
  handle: FileHandle,
  label: string,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  let position = 0;
  while (true) {
    const chunk = Buffer.allocUnsafe(
      Math.min(64 * 1024, MAX_GITIGNORE_SOURCE_BYTES + 1 - total),
    );
    const read = await handle.read(chunk, 0, chunk.byteLength, position);
    if (read.bytesRead === 0) break;
    chunks.push(chunk.subarray(0, read.bytesRead));
    total += read.bytesRead;
    position += read.bytesRead;
    if (total > MAX_GITIGNORE_SOURCE_BYTES) {
      throw new GitIgnoreOracleError(
        `${label} exceeds the per-source byte limit`,
      );
    }
  }
  return Buffer.concat(chunks, total);
}

async function readOptionalPolicyFile(
  path: string,
  label: string,
  followSymlink: boolean,
): Promise<Buffer | undefined> {
  try {
    const observed = followSymlink ? await stat(path) : await lstat(path);
    if (observed.isSymbolicLink() && !followSymlink) return undefined;
    if (!observed.isFile()) {
      if (!followSymlink) return undefined;
      throw new GitIgnoreOracleError(`${label} is not a regular file`);
    }
    if (observed.size > MAX_GITIGNORE_SOURCE_BYTES) {
      throw new GitIgnoreOracleError(
        `${label} exceeds the per-source byte limit`,
      );
    }
    const flags =
      fsConstants.O_RDONLY |
      (followSymlink ? 0 : (fsConstants.O_NOFOLLOW ?? 0)) |
      (fsConstants.O_NONBLOCK ?? 0);
    const handle = await open(path, flags);
    try {
      const before = await handle.stat();
      if (!before.isFile() || !sameFile(observed, before)) {
        throw new GitIgnoreOracleError(`${label} changed before it was read`);
      }
      const contents = await readHandleBounded(handle, label);
      const after = await handle.stat();
      if (!sameFile(before, after)) {
        throw new GitIgnoreOracleError(`${label} changed while it was read`);
      }
      return contents;
    } finally {
      await handle.close();
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (cause instanceof GitIgnoreOracleError) throw cause;
    throw new GitIgnoreOracleError(`cannot read ${label}`, { cause });
  }
}

async function gitBoolean(
  context: GitWorktreeContext,
  key: string,
): Promise<boolean> {
  try {
    const result = await runGit(
      ["-C", context.workspaceRoot, "config", "--type=bool", "--get", key],
      context.env,
    );
    const value = decodeSingleLine(result.stdout, key);
    if (value === "true") return true;
    if (value === "false") return false;
    throw new GitIgnoreOracleError(`Git returned an invalid ${key} value`);
  } catch (cause) {
    if (failureCode(cause) === 1) return false;
    if (cause instanceof GitIgnoreOracleError) throw cause;
    throw new GitIgnoreOracleError(`cannot read Git ${key}`, { cause });
  }
}

async function gitInfoExcludePath(
  context: GitWorktreeContext,
): Promise<string> {
  try {
    const result = await runGit(
      ["-C", context.workspaceRoot, "rev-parse", "--git-path", "info/exclude"],
      context.env,
    );
    const value = decodeSingleLine(result.stdout, "info/exclude path");
    return isAbsolute(value) ? value : resolve(context.workspaceRoot, value);
  } catch (cause) {
    if (cause instanceof GitIgnoreOracleError) throw cause;
    throw new GitIgnoreOracleError("cannot determine Git info/exclude path", {
      cause,
    });
  }
}

function defaultGlobalExcludePath(
  context: GitWorktreeContext,
): string | undefined {
  const { env } = context;
  let path: string | undefined;
  if (env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME !== "") {
    path = join(env.XDG_CONFIG_HOME, "git", "ignore");
  } else {
    const home =
      env.HOME ?? (process.platform === "win32" ? homedir() : undefined);
    path =
      home === undefined || home === ""
        ? undefined
        : join(home, ".config", "git", "ignore");
  }
  if (path === undefined || isAbsolute(path)) return path;
  // Git resolves this fallback after `-C` has entered the worktree. The live
  // oracle runs from the repository root, so archive the exact same file even
  // when XDG_CONFIG_HOME (or HOME) is unusually relative.
  return resolve(context.repositoryRoot, path);
}

async function globalExcludePath(
  context: GitWorktreeContext,
): Promise<string | undefined> {
  try {
    const result = await runGit(
      [
        "-C",
        context.workspaceRoot,
        "config",
        "--path",
        "--get",
        "core.excludesFile",
      ],
      context.env,
    );
    const value = decodeSingleLine(result.stdout, "core.excludesFile path");
    // Git treats an explicitly empty core.excludesFile as disabled.
    if (value === "") return undefined;
    return isAbsolute(value) ? value : resolve(context.repositoryRoot, value);
  } catch (cause) {
    if (failureCode(cause) === 1) return defaultGlobalExcludePath(context);
    if (cause instanceof GitIgnoreOracleError) throw cause;
    throw new GitIgnoreOracleError("cannot determine Git core.excludesFile", {
      cause,
    });
  }
}

function ancestorGitignorePaths(repositoryPrefix: string): readonly string[] {
  const paths = [".gitignore"];
  if (repositoryPrefix === "") return paths;
  let base = "";
  for (const component of repositoryPrefix.split("/")) {
    base = base === "" ? component : `${base}/${component}`;
    paths.push(`${base}/.gitignore`);
  }
  return paths;
}

/**
 * Discover stable external and repo-root-to-workspace policy. The scanner
 * appends nested `.gitignore` files only after Git says their directories are
 * reachable, avoiding an incorrect all-tree policy prewalk.
 */
export async function discoverWorkspaceScope(
  root: string,
): Promise<DiscoveredWorkspaceScope> {
  const context = await locateGitWorktree(root);
  if (context === undefined) {
    let workspaceRoot: string;
    try {
      workspaceRoot = await realpath(resolve(root));
    } catch (cause) {
      throw new GitIgnoreOracleError("workspace root is not readable", {
        cause,
      });
    }
    return { workspaceRoot, scope: { kind: "all-managed" } };
  }

  const sources: WorkspaceGitignoreSource[] = [];
  const policyBudget = new WorkspaceGitPolicyBudget();
  for (const path of ancestorGitignorePaths(context.repositoryPrefix)) {
    const contents = await readOptionalPolicyFile(
      join(context.repositoryRoot, ...path.split("/")),
      `Git ignore source ${JSON.stringify(path)}`,
      false,
    );
    if (contents !== undefined) {
      const source = workspaceGitignoreSource(path, contents);
      policyBudget.upsertGitignoreSource(source);
      sources.push(source);
    }
  }
  const infoPath = await gitInfoExcludePath(context);
  const globalPath = await globalExcludePath(context);
  const [infoExclude, globalExclude] = await Promise.all([
    readOptionalPolicyFile(infoPath, "Git info/exclude", true),
    globalPath === undefined
      ? Promise.resolve(undefined)
      : readOptionalPolicyFile(globalPath, "Git global excludes file", true),
  ]);
  policyBudget.addExternalPolicy(
    infoExclude ?? Buffer.alloc(0),
    "Git info/exclude",
  );
  policyBudget.addExternalPolicy(
    globalExclude ?? Buffer.alloc(0),
    "Git global excludes file",
  );
  const scope = canonicalizeWorkspaceScope({
    kind: "git",
    repositoryPrefix: context.repositoryPrefix,
    ignoreCase: await gitBoolean(context, "core.ignoreCase"),
    gitignoreSources: sources,
    infoExcludeBase64: (infoExclude ?? Buffer.alloc(0)).toString("base64"),
    globalExcludeBase64: (globalExclude ?? Buffer.alloc(0)).toString("base64"),
  });
  return {
    workspaceRoot: context.workspaceRoot,
    repositoryRoot: context.repositoryRoot,
    scope,
  };
}

/** Safely read one scanner-reached workspace directory's `.gitignore`. */
export async function readWorkspaceGitignoreSource(
  discovery: DiscoveredWorkspaceScope,
  workspaceRelativeDirectory: string,
): Promise<WorkspaceGitignoreSource | undefined> {
  const scope = canonicalizeWorkspaceScope(discovery.scope);
  const relativeDirectory = canonicalWorkspaceRelativePath(
    workspaceRelativeDirectory,
    true,
  );
  if (scope.kind === "all-managed") return undefined;
  if (
    discovery.repositoryRoot === undefined ||
    !isAbsolute(discovery.repositoryRoot)
  ) {
    throw new GitIgnoreOracleError(
      "Git scope discovery has no absolute repository root",
    );
  }
  const base = [scope.repositoryPrefix, relativeDirectory]
    .filter((part) => part !== "")
    .join("/");
  const sourcePath = base === "" ? ".gitignore" : `${base}/.gitignore`;
  const contents = await readOptionalPolicyFile(
    join(discovery.repositoryRoot, ...sourcePath.split("/")),
    `Git ignore source ${JSON.stringify(sourcePath)}`,
    false,
  );
  return contents === undefined
    ? undefined
    : workspaceGitignoreSource(sourcePath, contents);
}

class AllManagedOracle implements GitIgnoreOracle {
  async managed(paths: readonly GitIgnorePath[]): Promise<readonly boolean[]> {
    for (const item of paths) canonicalWorkspaceRelativePath(item.path, false);
    return paths.map(() => true);
  }

  async close(): Promise<void> {
    // No subprocess or temporary state.
  }
}

interface SyntheticScratchRoot {
  readonly path: string;
  readonly observation: Stats;
  readonly parent: string;
  readonly parentObservation: Stats;
}

function sameDirectoryIdentity(expected: Stats, actual: Stats): boolean {
  return (
    actual.isDirectory() &&
    !actual.isSymbolicLink() &&
    expected.dev === actual.dev &&
    expected.ino === actual.ino
  );
}

function pathIsWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === "" ||
    (!isAbsolute(fromRoot) &&
      fromRoot !== ".." &&
      !fromRoot.startsWith(`..${sep}`))
  );
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

async function realDirectory(
  path: string,
  label: string,
): Promise<{
  readonly path: string;
  readonly observation: Stats;
}> {
  const canonical = await realpath(path);
  const observation = await lstat(canonical);
  if (!observation.isDirectory() || observation.isSymbolicLink()) {
    throw new GitIgnoreOracleError(`${label} is not a real directory`);
  }
  return { path: canonical, observation };
}

async function selectSyntheticScratchParent(
  options: SyntheticGitIgnoreScratchOptions,
): Promise<{
  readonly parent: string;
  readonly parentObservation: Stats;
  readonly forbiddenRoots: readonly string[];
}> {
  const forbiddenRoots = await Promise.all(
    (options.forbiddenRoots ?? []).map(
      async (path) =>
        (await realDirectory(path, "synthetic Git scratch forbidden root"))
          .path,
    ),
  );
  const preferred = await realDirectory(
    options.scratchParent ?? tmpdir(),
    "synthetic Git scratch parent",
  );
  let candidate = preferred;
  while (forbiddenRoots.some((root) => pathIsWithin(root, candidate.path))) {
    if (options.scratchParent !== undefined) {
      throw new GitIgnoreOracleError(
        "synthetic Git scratch parent is inside a forbidden root",
      );
    }
    const ancestor = dirname(candidate.path);
    if (ancestor === candidate.path) {
      throw new GitIgnoreOracleError(
        "cannot select synthetic Git scratch space outside forbidden roots",
      );
    }
    candidate = await realDirectory(
      ancestor,
      "synthetic Git scratch fallback parent",
    );
  }
  return {
    parent: candidate.path,
    parentObservation: candidate.observation,
    forbiddenRoots,
  };
}

async function removeSyntheticScratchRoot(
  scratch: SyntheticScratchRoot,
): Promise<void> {
  let current: Stats;
  try {
    current = await lstat(scratch.path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw new GitIgnoreOracleError(
      "cannot inspect synthetic Git scratch root before cleanup",
      { cause: error },
    );
  }
  const parentNow = await lstat(scratch.parent);
  if (
    !sameDirectoryIdentity(scratch.observation, current) ||
    !sameDirectoryIdentity(scratch.parentObservation, parentNow)
  ) {
    throw new GitIgnoreOracleError(
      "refusing to clean a replaced synthetic Git scratch directory",
    );
  }

  // Node exposes neither openat/unlinkat nor an fd-relative recursive remove.
  // Recheck both identities immediately before removing the original path and
  // never rename owned content through another replaceable pathname. rm does
  // not follow a root symlink. A process with the same uid can still win the
  // final pathname race; same-uid adversarial mutation is not a trust boundary.
  const [rootBeforeRemove, parentBeforeRemove] = await Promise.all([
    lstat(scratch.path),
    lstat(scratch.parent),
  ]);
  if (
    !sameDirectoryIdentity(scratch.observation, rootBeforeRemove) ||
    !sameDirectoryIdentity(scratch.parentObservation, parentBeforeRemove)
  ) {
    throw new GitIgnoreOracleError(
      "refusing to clean a changed synthetic Git scratch directory",
    );
  }
  try {
    await rm(scratch.path, { recursive: true, force: false });
  } catch (error) {
    throw new GitIgnoreOracleError("cannot clean synthetic Git scratch root", {
      cause: error,
    });
  }
}

async function createSyntheticScratchRoot(
  options: SyntheticGitIgnoreScratchOptions,
): Promise<SyntheticScratchRoot> {
  const selected = await selectSyntheticScratchParent(options);
  const path = await mkdtemp(join(selected.parent, "cyclotomy-ignore-"));
  let created: Stats | undefined;
  let observation: Stats;
  try {
    created = await lstat(path);
    const [canonical, parentNow] = await Promise.all([
      realpath(path),
      lstat(selected.parent),
    ]);
    if (
      canonical !== path ||
      !created.isDirectory() ||
      created.isSymbolicLink() ||
      !sameDirectoryIdentity(selected.parentObservation, parentNow) ||
      selected.forbiddenRoots.some((root) => pathIsWithin(root, canonical))
    ) {
      throw new GitIgnoreOracleError(
        "synthetic Git scratch root was not created in the selected private parent",
      );
    }
    observation = created;
  } catch (error) {
    // Never recurse when creation could not be authenticated. Remove only an
    // empty directory that still has the identity observed immediately after
    // mkdtemp; otherwise preserve it for inspection.
    const current = await lstat(path).catch(() => undefined);
    if (
      created !== undefined &&
      current !== undefined &&
      sameDirectoryIdentity(created, current)
    ) {
      await rmdir(path).catch(() => {});
    }
    if (error instanceof GitIgnoreOracleError) throw error;
    throw new GitIgnoreOracleError(
      "cannot validate synthetic Git scratch root",
      { cause: error },
    );
  }
  return {
    path,
    observation,
    parent: selected.parent,
    parentObservation: selected.parentObservation,
  };
}

interface PendingQuery {
  readonly expectedPaths: readonly Buffer[];
  readonly results: boolean[];
  responseBytes: number;
  readonly resolve: (result: readonly boolean[]) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

class ProcessGitIgnoreOracle implements GitIgnoreOracle {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #repositoryPrefix: string;
  readonly #cleanupRoot: SyntheticScratchRoot | undefined;
  readonly #allowBoundedDiagnostics: boolean;
  readonly #syntheticPolicyDirectories: ReadonlySet<string> | undefined;
  readonly #syntheticScope: GitWorkspaceScope | undefined;
  #stdout = Buffer.alloc(0);
  #diagnosticBytes = 0;
  #pending: PendingQuery | undefined;
  #tail: Promise<void> = Promise.resolve();
  #failure: GitIgnoreOracleError | undefined;
  #closed = false;
  readonly #exit: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;

  constructor(
    repositoryRoot: string,
    repositoryPrefix: string,
    env: NodeJS.ProcessEnv,
    cleanupRoot?: SyntheticScratchRoot,
    allowBoundedDiagnostics = false,
    syntheticPolicyDirectories?: ReadonlySet<string>,
    syntheticScope?: GitWorkspaceScope,
  ) {
    this.#repositoryPrefix = repositoryPrefix;
    this.#cleanupRoot = cleanupRoot;
    this.#allowBoundedDiagnostics = allowBoundedDiagnostics;
    this.#syntheticPolicyDirectories = syntheticPolicyDirectories;
    this.#syntheticScope = syntheticScope;
    this.#child = spawn(
      "git",
      [
        "-C",
        repositoryRoot,
        "check-ignore",
        "--no-index",
        "-z",
        "-v",
        "-n",
        "--stdin",
      ],
      { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.#exit = new Promise((resolveExit) => {
      this.#child.once("close", (code, signal) =>
        resolveExit({ code, signal }),
      );
    });
    this.#child.once("error", (cause) => {
      this.#fail(
        new GitIgnoreOracleError("cannot start Git ignore oracle", { cause }),
      );
    });
    this.#child.stdout.on("data", (chunk: Buffer) => this.#onStdout(chunk));
    this.#child.stdin.on("error", (cause) => {
      if (!this.#closed) {
        this.#fail(
          new GitIgnoreOracleError("Git ignore oracle input failed", { cause }),
        );
      }
    });
    this.#child.stderr.on("data", (chunk: Buffer) => {
      this.#diagnosticBytes += chunk.byteLength;
      if (
        !this.#allowBoundedDiagnostics ||
        this.#diagnosticBytes > MAX_LIVE_ORACLE_DIAGNOSTIC_BYTES
      ) {
        this.#fail(
          new GitIgnoreOracleError("Git ignore oracle produced diagnostics"),
        );
      }
    });
    this.#child.once("exit", (code, signal) => {
      if (!this.#closed) {
        this.#fail(
          new GitIgnoreOracleError(
            `Git ignore oracle exited unexpectedly (${code ?? signal ?? "unknown"})`,
          ),
        );
      }
    });
  }

  managed(paths: readonly GitIgnorePath[]): Promise<readonly boolean[]> {
    if (this.#closed) {
      return Promise.reject(
        new GitIgnoreOracleError("Git ignore oracle is closed"),
      );
    }
    if (paths.length === 0) return Promise.resolve([]);
    if (paths.length > MAX_ORACLE_BATCH_PATHS) {
      return Promise.reject(
        new GitIgnoreOracleError("Git ignore query has too many paths"),
      );
    }
    const encoded: Buffer[] = [];
    const encodedIndexes: number[] = [];
    const results = new Array<boolean>(paths.length);
    let bytes = 0;
    try {
      for (let index = 0; index < paths.length; index += 1) {
        const item = paths[index]!;
        const local = canonicalWorkspaceRelativePath(item.path, false);
        const repositoryPath =
          this.#repositoryPrefix === ""
            ? local
            : `${this.#repositoryPrefix}/${local}`;
        const pathname = Buffer.from(
          `${repositoryPath}${item.isDirectory ? "/" : ""}`,
          "utf8",
        );
        bytes += pathname.byteLength + 1;
        if (bytes > MAX_ORACLE_BATCH_BYTES) {
          throw new GitIgnoreOracleError(
            "Git ignore query exceeds the byte limit",
          );
        }
        if (
          !item.isDirectory &&
          this.#syntheticScope !== undefined &&
          this.#syntheticPolicyDirectories?.has(
            workspaceScopePathKey(this.#syntheticScope, repositoryPath),
          ) === true
        ) {
          // Nested archived sources need real parent directories in the
          // synthetic worktree. Git stats those directories even when a query
          // omits `/`, so it cannot faithfully answer a current file/symlink
          // type conflict. Conservatively keep that path unmanaged.
          results[index] = false;
          continue;
        }
        encoded.push(pathname);
        encodedIndexes.push(index);
      }
    } catch (cause) {
      return Promise.reject(
        cause instanceof GitIgnoreOracleError
          ? cause
          : new GitIgnoreOracleError("invalid Git ignore query", { cause }),
      );
    }
    if (encoded.length === 0) return Promise.resolve(results);
    const run = this.#tail.then(async () => {
      const delegated = await this.#run(encoded);
      delegated.forEach((managed, index) => {
        results[encodedIndexes[index]!] = managed;
      });
      return results;
    });
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #run(expectedPaths: readonly Buffer[]): Promise<readonly boolean[]> {
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    if (this.#pending !== undefined || this.#stdout.byteLength !== 0) {
      return Promise.reject(
        new GitIgnoreOracleError("Git ignore oracle protocol is out of sync"),
      );
    }
    return new Promise((resolveQuery, reject) => {
      const timer = setTimeout(() => {
        this.#fail(
          new GitIgnoreOracleError("Git ignore oracle query timed out"),
        );
      }, GIT_COMMAND_TIMEOUT_MS);
      this.#pending = {
        expectedPaths,
        results: [],
        responseBytes: 0,
        resolve: resolveQuery,
        reject,
        timer,
      };
      const input = Buffer.concat(
        expectedPaths.flatMap((path) => [path, Buffer.from([0])]),
      );
      this.#child.stdin.write(input, (cause) => {
        if (cause !== null && cause !== undefined) {
          this.#fail(
            new GitIgnoreOracleError("cannot write to Git ignore oracle", {
              cause,
            }),
          );
        }
      });
    });
  }

  #onStdout(chunk: Buffer): void {
    if (this.#failure !== undefined) return;
    const pending = this.#pending;
    if (pending === undefined) {
      this.#fail(
        new GitIgnoreOracleError("Git ignore oracle emitted unsolicited bytes"),
      );
      return;
    }
    pending.responseBytes += chunk.byteLength;
    if (pending.responseBytes > MAX_ORACLE_RESPONSE_BYTES) {
      this.#fail(
        new GitIgnoreOracleError(
          "Git ignore oracle response exceeds the byte limit",
        ),
      );
      return;
    }
    this.#stdout = Buffer.concat([this.#stdout, chunk]);
    const fields: Buffer[] = [];
    let start = 0;
    for (let index = 0; index < this.#stdout.byteLength; index += 1) {
      if (this.#stdout[index] !== 0) continue;
      fields.push(this.#stdout.subarray(start, index));
      start = index + 1;
    }
    this.#stdout = this.#stdout.subarray(start);
    if (fields.length % 4 !== 0) {
      // Keep complete-but-partial records until the next chunk.
      const complete = fields.length - (fields.length % 4);
      const remainder = fields.slice(complete);
      if (remainder.length > 0) {
        this.#stdout = Buffer.concat(
          remainder
            .flatMap((field) => [field, Buffer.from([0])])
            .concat(this.#stdout),
        );
      }
      fields.length = complete;
    }
    for (let index = 0; index < fields.length; index += 4) {
      const pending = this.#pending;
      if (pending === undefined) {
        this.#fail(
          new GitIgnoreOracleError(
            "Git ignore oracle emitted an unsolicited record",
          ),
        );
        return;
      }
      const source = fields[index] as Buffer;
      const line = fields[index + 1] as Buffer;
      const pattern = fields[index + 2] as Buffer;
      const pathname = fields[index + 3] as Buffer;
      const expected = pending.expectedPaths[pending.results.length];
      if (
        expected === undefined ||
        !pathname.equals(expected) ||
        (line.byteLength > 0 && !/^[0-9]+$/u.test(line.toString("ascii"))) ||
        ((source.byteLength === 0 || pattern.byteLength === 0) &&
          !(
            source.byteLength === 0 &&
            line.byteLength === 0 &&
            pattern.byteLength === 0
          ))
      ) {
        this.#fail(
          new GitIgnoreOracleError(
            "Git ignore oracle returned a malformed record",
          ),
        );
        return;
      }
      const nonMatch = source.byteLength === 0;
      const negated = !nonMatch && pattern[0] === 0x21;
      pending.results.push(nonMatch || negated);
      if (pending.results.length === pending.expectedPaths.length) {
        clearTimeout(pending.timer);
        this.#pending = undefined;
        pending.resolve(pending.results);
      }
    }
  }

  #fail(error: GitIgnoreOracleError): void {
    if (this.#failure !== undefined) return;
    this.#failure = error;
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending !== undefined) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#child.kill();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#tail;
    this.#child.stdin.end();
    const result = await this.#exit;
    try {
      if (this.#failure !== undefined) throw this.#failure;
      if (result.code !== 0 && result.code !== 1) {
        throw new GitIgnoreOracleError(
          `Git ignore oracle failed while closing (${result.code ?? result.signal ?? "unknown"})`,
        );
      }
    } finally {
      if (this.#cleanupRoot !== undefined) {
        await removeSyntheticScratchRoot(this.#cleanupRoot);
      }
    }
  }
}

/** Use the current repository as Git's semantic authority. */
export async function createLiveGitIgnoreOracle(
  root: string,
  scope: WorkspaceScope,
): Promise<GitIgnoreOracle> {
  const canonical = canonicalizeWorkspaceScope(scope);
  if (canonical.kind === "all-managed") return new AllManagedOracle();
  const context = await locateGitWorktree(root);
  if (context === undefined) {
    throw new GitIgnoreOracleError(
      "checkpoint expects Git but workspace is not a Git worktree",
    );
  }
  if (context.repositoryPrefix !== canonical.repositoryPrefix) {
    throw new GitIgnoreOracleError(
      "workspace Git repository prefix changed during discovery",
    );
  }
  return new ProcessGitIgnoreOracle(
    context.repositoryRoot,
    context.repositoryPrefix,
    context.env,
    undefined,
    true,
  );
}

/** Reconstruct a private Git worktree containing only archived policy bytes. */
export async function createSyntheticGitIgnoreOracle(
  scope: WorkspaceScope,
  options: SyntheticGitIgnoreScratchOptions = {},
): Promise<GitIgnoreOracle> {
  const canonical = canonicalizeWorkspaceScope(scope);
  if (canonical.kind === "all-managed") return new AllManagedOracle();
  const scratch = await createSyntheticScratchRoot(options);
  const scratchRoot = scratch.path;
  try {
    // Keep every Cyclotomy-owned control file outside the reconstructed
    // worktree so no legal repository path can acquire an artificial type.
    const repositoryRoot = join(scratchRoot, "worktree");
    await mkdir(repositoryRoot);
    const emptyConfig = join(scratchRoot, "empty.gitconfig");
    await writeFile(emptyConfig, Buffer.alloc(0), { flag: "wx" });
    const env = isolatedGitEnvironment(emptyConfig);
    await runGit(["init", "-q", repositoryRoot], env);
    const policyDirectories = new Set<string>();
    for (const source of canonical.gitignoreSources) {
      const components = source.path.split("/").slice(0, -1);
      let directory = "";
      for (const component of components) {
        directory = directory === "" ? component : `${directory}/${component}`;
        policyDirectories.add(workspaceScopePathKey(canonical, directory));
      }
      const path = join(repositoryRoot, ...source.path.split("/"));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, workspaceScopeBytes(source.contentsBase64), {
        flag: "wx",
      });
    }
    if (canonical.repositoryPrefix !== "") {
      await mkdir(
        join(repositoryRoot, ...canonical.repositoryPrefix.split("/")),
        { recursive: true },
      );
    }
    const infoPathResult = await runGit(
      ["-C", repositoryRoot, "rev-parse", "--git-path", "info/exclude"],
      env,
    );
    const rawInfoPath = decodeSingleLine(
      infoPathResult.stdout,
      "synthetic info/exclude path",
    );
    const infoPath = isAbsolute(rawInfoPath)
      ? rawInfoPath
      : resolve(repositoryRoot, rawInfoPath);
    await mkdir(dirname(infoPath), { recursive: true });
    await writeFile(infoPath, workspaceScopeBytes(canonical.infoExcludeBase64));
    const globalPath = join(
      repositoryRoot,
      ".git",
      "cyclotomy-global-excludes",
    );
    await writeFile(
      globalPath,
      workspaceScopeBytes(canonical.globalExcludeBase64),
      { flag: "wx" },
    );
    await runGit(
      [
        "-C",
        repositoryRoot,
        "config",
        "--local",
        "core.ignoreCase",
        String(canonical.ignoreCase),
      ],
      env,
    );
    await runGit(
      [
        "-C",
        repositoryRoot,
        "config",
        "--local",
        "core.excludesFile",
        globalPath,
      ],
      env,
    );
    return new ProcessGitIgnoreOracle(
      repositoryRoot,
      canonical.repositoryPrefix,
      env,
      scratch,
      false,
      policyDirectories,
      canonical,
    );
  } catch (cause) {
    let cleanupFailure: unknown;
    try {
      await removeSyntheticScratchRoot(scratch);
    } catch (error) {
      cleanupFailure = error;
    }
    if (cleanupFailure !== undefined) {
      throw new GitIgnoreOracleError(
        "cannot create or safely clean synthetic Git ignore oracle",
        { cause: new AggregateError([cause, cleanupFailure]) },
      );
    }
    if (cause instanceof GitIgnoreOracleError) throw cause;
    throw new GitIgnoreOracleError(
      "cannot create synthetic Git ignore oracle",
      { cause },
    );
  }
}
