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
  DEFAULT_WORKSPACE_PATH_LIMITS,
  MAX_GITIGNORE_POLICY_BYTES,
  MAX_GITIGNORE_SOURCES,
  MAX_GITIGNORE_SOURCE_BYTES,
  MAX_GIT_VERSION_BYTES,
  canonicalWorkspaceRelativePath,
  canonicalizeWorkspaceScope,
  workspaceGitignoreSource,
  workspaceScopeBytes,
  type WorkspaceGitignoreSource,
  type WorkspacePathLimits,
  type WorkspaceScope,
} from "./workspace-scope.ts";
import {
  SyntheticGitDirectoryShape,
  type SyntheticGitShapePath,
} from "./synthetic-git-directory-shape.ts";
import { systemErrorCode } from "./system-error.ts";

const GIT_COMMAND_TIMEOUT_MS = 5_000;
const MAX_GIT_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const MAX_ORACLE_BATCH_PATHS = 100_000;
const MAX_ORACLE_BATCH_BYTES = 16 * 1024 * 1024;
const MAX_ORACLE_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_ORACLE_DIAGNOSTIC_BYTES = 64 * 1024;
const MAX_ORACLE_WRITE_CHUNK_BYTES = 64 * 1024;

export class GitIgnoreOracleError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GitIgnoreOracleError";
  }
}

export interface GitIgnorePath {
  readonly path: string;
  readonly kind: "directory" | "non-directory";
}

export interface GitIgnoreOracle {
  /** Exact version of the Git executable serving this oracle. */
  readonly gitVersion: string | null;
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
  /** Path limits used to authenticate scope and oracle queries. */
  readonly pathLimits?: WorkspacePathLimits;
}

/**
 * Bound policy accumulation before a complete scope exists to canonicalize.
 * Callers retain the source map; this keeps only byte lengths so replacement
 * accounting stays O(1).
 */
export class WorkspaceGitPolicyBudget {
  readonly #sourceBytes = new Map<string, number>();
  readonly #pathLimits: WorkspacePathLimits;
  #totalBytes = 0;

  constructor(
    scope?: WorkspaceScope,
    pathLimits: WorkspacePathLimits = DEFAULT_WORKSPACE_PATH_LIMITS,
  ) {
    this.#pathLimits = pathLimits;
    if (scope === undefined) return;
    const canonical = canonicalizeWorkspaceScope(scope, pathLimits);
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
    const path = canonicalWorkspaceRelativePath(
      source.path,
      false,
      this.#pathLimits,
    );
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
  readonly pathLimits: WorkspacePathLimits;
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
  return {
    ...env,
    LC_ALL: "C",
    LANG: "C",
    GIT_FLUSH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
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
          reject(
            new GitIgnoreOracleError(
              `Git command produced diagnostics: ${diagnosticDetail(stderrBytes)}`,
            ),
          );
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

function failureBytes(
  cause: unknown,
  field: "stdout" | "stderr",
): Buffer | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  const value = Reflect.get(cause, field);
  return Buffer.isBuffer(value) ? value : undefined;
}

function hasExpectedFailureLifecycle(cause: unknown, code: number): boolean {
  if (typeof cause !== "object" || cause === null) return false;
  return (
    failureCode(cause) === code &&
    Reflect.get(cause, "killed") !== true &&
    (Reflect.get(cause, "signal") === null ||
      Reflect.get(cause, "signal") === undefined)
  );
}

/** `git config --get` uses a clean exit 1 to report an absent key. */
function isExpectedConfigAbsence(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) return false;
  const stdout = failureBytes(cause, "stdout");
  const stderr = failureBytes(cause, "stderr");
  return (
    hasExpectedFailureLifecycle(cause, 1) &&
    stdout?.byteLength === 0 &&
    stderr?.byteLength === 0
  );
}

function isNotRepository(cause: unknown): boolean {
  const stdout = failureBytes(cause, "stdout");
  const stderr = failureBytes(cause, "stderr");
  return (
    hasExpectedFailureLifecycle(cause, 128) &&
    stdout?.byteLength === 0 &&
    stderr !== undefined &&
    failureStderr(cause).includes("not a git repository")
  );
}

async function namespacePathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Git's ordinary not-repository diagnostic also covers unreadable or damaged
 * repositories. Prove that no worktree marker or bare control root exists on
 * the same-device discovery chain before treating that diagnostic as absence.
 */
async function hasGitControlBoundary(workspaceRoot: string): Promise<boolean> {
  const workspace = await lstat(workspaceRoot);
  if (!workspace.isDirectory() || workspace.isSymbolicLink()) {
    throw new Error("workspace root changed during Git discovery");
  }

  let directory = workspaceRoot;
  while (true) {
    if (await namespacePathExists(join(directory, ".git"))) return true;

    const bareSignature = await Promise.all(
      ["HEAD", "objects", "refs"].map((name) =>
        namespacePathExists(join(directory, name)),
      ),
    );
    if (bareSignature.every(Boolean)) return true;

    const parent = dirname(directory);
    if (parent === directory) return false;
    const parentObservation = await lstat(parent);
    if (
      !parentObservation.isDirectory() ||
      parentObservation.isSymbolicLink()
    ) {
      throw new Error("workspace ancestor changed during Git discovery");
    }
    if (parentObservation.dev !== workspace.dev) return false;
    directory = parent;
  }
}

function decodeExactUtf8(bytes: Buffer, label: string): string {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw new GitIgnoreOracleError(`Git returned a non-UTF-8 ${label}`);
  }
  return text;
}

/** Decode a Git command whose documented result is one scalar text line. */
function decodeGitScalarLine(bytes: Buffer, label: string): string {
  if (bytes.at(-1) !== 0x0a) {
    throw new GitIgnoreOracleError(`Git returned a malformed ${label}`);
  }
  let value = bytes.subarray(0, -1);
  // Git for Windows may use the platform line ending. Any remaining CR is
  // invalid scalar data and is rejected with the other framing bytes below.
  if (process.platform === "win32" && value.at(-1) === 0x0d) {
    value = value.subarray(0, -1);
  }
  if (value.includes(0x00) || value.includes(0x0a) || value.includes(0x0d)) {
    throw new GitIgnoreOracleError(`Git returned a malformed ${label}`);
  }
  return decodeExactUtf8(value, label);
}

/** Decode a Git path terminated by one transport newline. */
function decodeGitPathLine(bytes: Buffer, label: string): string {
  if (bytes.at(-1) !== 0x0a) {
    throw new GitIgnoreOracleError(`Git returned a malformed ${label}`);
  }
  let value = bytes.subarray(0, -1);
  // A Windows pathname cannot contain CR. On POSIX it is legal data, so only
  // the documented LF transport delimiter is removed.
  if (process.platform === "win32" && value.at(-1) === 0x0d) {
    value = value.subarray(0, -1);
  }
  if (value.byteLength === 0 || value.includes(0x00)) {
    throw new GitIgnoreOracleError(`Git returned a malformed ${label}`);
  }
  return decodeExactUtf8(value, label);
}

/** Decode exactly one `-z` record, preserving every non-NUL payload byte. */
function decodeSingleNulRecord(bytes: Buffer, label: string): string {
  if (bytes.at(-1) !== 0x00) {
    throw new GitIgnoreOracleError(`Git returned a malformed ${label}`);
  }
  const value = bytes.subarray(0, -1);
  if (value.includes(0x00)) {
    throw new GitIgnoreOracleError(`Git returned a malformed ${label}`);
  }
  return decodeExactUtf8(value, label);
}

function diagnosticDetail(bytes: Buffer, truncated = false): string {
  const text = bytes.toString("utf8");
  return `${JSON.stringify(text)}${truncated ? " (truncated)" : ""}`;
}

async function readGitVersion(env: NodeJS.ProcessEnv): Promise<string> {
  let result: GitCommandResult;
  try {
    result = await runGit(["--version"], env);
  } catch (cause) {
    throw new GitIgnoreOracleError("cannot determine the Git version", {
      cause,
    });
  }
  const version = decodeGitScalarLine(result.stdout, "version");
  if (
    version.length === 0 ||
    Buffer.byteLength(version, "utf8") > MAX_GIT_VERSION_BYTES ||
    [...Buffer.from(version, "utf8")].some((byte) => byte < 0x20 || byte > 0x7e)
  ) {
    throw new GitIgnoreOracleError("Git returned an invalid version");
  }
  return version;
}

async function locateGitWorktree(
  root: string,
  pathLimits: WorkspacePathLimits,
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
    if (decodeGitScalarLine(inside.stdout, "worktree result") !== "true") {
      throw new GitIgnoreOracleError(
        "Git repository does not provide a workspace worktree",
      );
    }
  } catch (cause) {
    if (isNotRepository(cause)) {
      try {
        if (!(await hasGitControlBoundary(workspaceRoot))) return undefined;
      } catch (inspectionCause) {
        throw new GitIgnoreOracleError(
          "cannot prove that the workspace is an ordinary non-Git directory",
          { cause: new AggregateError([cause, inspectionCause]) },
        );
      }
    }
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
      decodeGitPathLine(result.stdout, "worktree root"),
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
    pathLimits,
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

function assertNulFreeGitPolicy(contents: Buffer, label: string): void {
  if (contents.includes(0x00)) {
    const hasWideTextBom =
      (contents[0] === 0xff && contents[1] === 0xfe) ||
      (contents[0] === 0xfe && contents[1] === 0xff) ||
      (contents[0] === 0x00 &&
        contents[1] === 0x00 &&
        contents[2] === 0xfe &&
        contents[3] === 0xff);
    throw new GitIgnoreOracleError(
      hasWideTextBom
        ? `${label} contains NUL bytes and appears to be UTF-16/UTF-32; save the policy file as UTF-8 or another NUL-free encoding`
        : `${label} contains a NUL byte; Git policy files must be NUL-free`,
    );
  }
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
      assertNulFreeGitPolicy(contents, label);
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
      [
        "-C",
        context.workspaceRoot,
        "config",
        "-z",
        "--type=bool",
        "--get",
        key,
      ],
      context.env,
    );
    const value = decodeSingleNulRecord(result.stdout, key);
    if (value === "true") return true;
    if (value === "false") return false;
    throw new GitIgnoreOracleError(`Git returned an invalid ${key} value`);
  } catch (cause) {
    if (isExpectedConfigAbsence(cause)) return false;
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
    const value = decodeGitPathLine(result.stdout, "info/exclude path");
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
        "-z",
        "--path",
        "--get",
        "core.excludesFile",
      ],
      context.env,
    );
    const value = decodeSingleNulRecord(
      result.stdout,
      "core.excludesFile path",
    );
    // Git treats an explicitly empty core.excludesFile as disabled.
    if (value === "") return undefined;
    return isAbsolute(value) ? value : resolve(context.repositoryRoot, value);
  } catch (cause) {
    if (isExpectedConfigAbsence(cause)) {
      return defaultGlobalExcludePath(context);
    }
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
  pathLimits: WorkspacePathLimits = DEFAULT_WORKSPACE_PATH_LIMITS,
): Promise<DiscoveredWorkspaceScope> {
  const context = await locateGitWorktree(root, pathLimits);
  if (context === undefined) {
    let workspaceRoot: string;
    try {
      workspaceRoot = await realpath(resolve(root));
    } catch (cause) {
      throw new GitIgnoreOracleError("workspace root is not readable", {
        cause,
      });
    }
    return {
      workspaceRoot,
      scope: { kind: "all-managed" },
      pathLimits,
    };
  }

  const sources: WorkspaceGitignoreSource[] = [];
  const policyBudget = new WorkspaceGitPolicyBudget(undefined, pathLimits);
  for (const path of ancestorGitignorePaths(context.repositoryPrefix)) {
    const contents = await readOptionalPolicyFile(
      join(context.repositoryRoot, ...path.split("/")),
      `Git ignore source ${JSON.stringify(path)}`,
      false,
    );
    if (contents !== undefined) {
      const source = workspaceGitignoreSource(path, contents, pathLimits);
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
  const [gitVersion, ignoreCase, precomposeUnicode] = await Promise.all([
    readGitVersion(context.env),
    gitBoolean(context, "core.ignoreCase"),
    gitBoolean(context, "core.precomposeUnicode"),
  ]);
  const scope = canonicalizeWorkspaceScope(
    {
      kind: "git",
      repositoryPrefix: context.repositoryPrefix,
      evaluator: { version: gitVersion, precomposeUnicode },
      ignoreCase,
      gitignoreSources: sources,
      infoExcludeBase64: (infoExclude ?? Buffer.alloc(0)).toString("base64"),
      globalExcludeBase64: (globalExclude ?? Buffer.alloc(0)).toString(
        "base64",
      ),
    },
    pathLimits,
  );
  return {
    workspaceRoot: context.workspaceRoot,
    repositoryRoot: context.repositoryRoot,
    scope,
    pathLimits,
  };
}

/** Safely read one scanner-reached workspace directory's `.gitignore`. */
export async function readWorkspaceGitignoreSource(
  discovery: DiscoveredWorkspaceScope,
  workspaceRelativeDirectory: string,
): Promise<WorkspaceGitignoreSource | undefined> {
  const scope = canonicalizeWorkspaceScope(
    discovery.scope,
    discovery.pathLimits,
  );
  const relativeDirectory = canonicalWorkspaceRelativePath(
    workspaceRelativeDirectory,
    true,
    discovery.pathLimits,
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
    : workspaceGitignoreSource(sourcePath, contents, discovery.pathLimits);
}

class AllManagedOracle implements GitIgnoreOracle {
  readonly gitVersion = null;
  readonly #pathLimits: WorkspacePathLimits;

  constructor(pathLimits: WorkspacePathLimits) {
    this.#pathLimits = pathLimits;
  }

  async managed(paths: readonly GitIgnorePath[]): Promise<readonly boolean[]> {
    for (const item of paths) {
      canonicalWorkspaceRelativePath(item.path, false, this.#pathLimits);
      if (item.kind !== "directory" && item.kind !== "non-directory") {
        throw new GitIgnoreOracleError("invalid Git ignore query kind");
      }
    }
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
    if (systemErrorCode(error) === "ENOENT") return;
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

class NulRecordFramer {
  readonly #fieldChunks: Buffer[] = [];
  readonly #recordFields: Buffer[] = [];
  #fieldBytes = 0;

  push(chunk: Buffer): readonly (readonly Buffer[])[] {
    const records: Buffer[][] = [];
    let start = 0;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== 0) continue;
      this.#append(chunk.subarray(start, index));
      this.#recordFields.push(this.#finishField());
      if (this.#recordFields.length === 4) {
        records.push(this.#recordFields.splice(0));
      }
      start = index + 1;
    }
    this.#append(chunk.subarray(start));
    return records;
  }

  hasFragment(): boolean {
    return this.#recordFields.length !== 0 || this.#fieldBytes !== 0;
  }

  #append(bytes: Buffer): void {
    if (bytes.byteLength === 0) return;
    this.#fieldChunks.push(bytes);
    this.#fieldBytes += bytes.byteLength;
  }

  #finishField(): Buffer {
    const field =
      this.#fieldChunks.length === 0
        ? Buffer.alloc(0)
        : this.#fieldChunks.length === 1
          ? this.#fieldChunks[0]!
          : Buffer.concat(this.#fieldChunks, this.#fieldBytes);
    this.#fieldChunks.length = 0;
    this.#fieldBytes = 0;
    return field;
  }
}

function isPositiveDecimalLine(line: Buffer): boolean {
  if (line.byteLength === 0) return false;
  let positive = false;
  for (const byte of line) {
    if (byte < 0x30 || byte > 0x39) return false;
    if (byte !== 0x30) positive = true;
  }
  return positive;
}

interface ProcessGitIgnoreOracleOptions {
  readonly repositoryRoot: string;
  readonly repositoryPrefix: string;
  readonly env: NodeJS.ProcessEnv;
  readonly gitVersion: string;
  readonly cleanupRoot?: SyntheticScratchRoot;
  readonly syntheticShape?: SyntheticGitDirectoryShape;
  readonly pathLimits?: WorkspacePathLimits;
}

class ProcessGitIgnoreOracle implements GitIgnoreOracle {
  readonly gitVersion: string;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #repositoryPrefix: string;
  readonly #cleanupRoot: SyntheticScratchRoot | undefined;
  readonly #syntheticShape: SyntheticGitDirectoryShape | undefined;
  readonly #pathLimits: WorkspacePathLimits;
  readonly #framer = new NulRecordFramer();
  #diagnostics = Buffer.alloc(0);
  #diagnosticsTruncated = false;
  #diagnosticBytes = 0;
  #pending: PendingQuery | undefined;
  #tail: Promise<void> = Promise.resolve();
  #failure: GitIgnoreOracleError | undefined;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  readonly #exit: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;

  constructor(options: ProcessGitIgnoreOracleOptions) {
    this.gitVersion = options.gitVersion;
    this.#repositoryPrefix = options.repositoryPrefix;
    this.#cleanupRoot = options.cleanupRoot;
    this.#syntheticShape = options.syntheticShape;
    this.#pathLimits = options.pathLimits ?? DEFAULT_WORKSPACE_PATH_LIMITS;
    this.#child = spawn(
      "git",
      [
        "-C",
        options.repositoryRoot,
        "check-ignore",
        "--no-index",
        "-z",
        "-v",
        "-n",
        "--stdin",
      ],
      {
        env: options.env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.#exit = new Promise((resolveExit) => {
      this.#child.once("close", (code, signal) => {
        if (!this.#closed || this.#pending !== undefined) {
          this.#fail(
            new GitIgnoreOracleError(
              this.#framer.hasFragment()
                ? "Git ignore oracle ended with an incomplete record"
                : `Git ignore oracle exited unexpectedly (${code ?? signal ?? "unknown"})`,
            ),
          );
        }
        resolveExit({ code, signal });
      });
    });
    this.#child.once("error", (cause) => {
      this.#fail(
        new GitIgnoreOracleError("cannot start Git ignore oracle", { cause }),
      );
    });
    this.#child.stdout.on("data", (chunk: Buffer) => this.#onStdout(chunk));
    this.#child.stdin.on("error", (cause) => {
      this.#fail(
        new GitIgnoreOracleError("Git ignore oracle input failed", { cause }),
      );
    });
    this.#child.stderr.on("data", (chunk: Buffer) => this.#onStderr(chunk));
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
    const shapePaths: SyntheticGitShapePath[] = [];
    const encodedIndexes: number[] = [];
    const results = new Array<boolean>(paths.length);
    let bytes = 0;
    try {
      for (let index = 0; index < paths.length; index += 1) {
        const item = paths[index]!;
        if (item.kind !== "directory" && item.kind !== "non-directory") {
          throw new GitIgnoreOracleError("invalid Git ignore query kind");
        }
        const local = canonicalWorkspaceRelativePath(
          item.path,
          false,
          this.#pathLimits,
        );
        const repositoryPath = canonicalWorkspaceRelativePath(
          this.#repositoryPrefix === ""
            ? local
            : `${this.#repositoryPrefix}/${local}`,
          false,
          this.#pathLimits,
        );
        // A leading `./` prevents Git from interpreting a legal leading colon
        // as pathspec magic. Directory semantics come only from filesystem
        // shape, never from an ambiguous trailing slash on the wire.
        const pathname = Buffer.from(`./${repositoryPath}`, "utf8");
        bytes += pathname.byteLength + 1;
        if (bytes > MAX_ORACLE_BATCH_BYTES) {
          throw new GitIgnoreOracleError(
            "Git ignore query exceeds the byte limit",
          );
        }
        encoded.push(pathname);
        encodedIndexes.push(index);
        shapePaths.push({ path: repositoryPath, kind: item.kind });
      }
    } catch (cause) {
      return Promise.reject(
        cause instanceof GitIgnoreOracleError
          ? cause
          : new GitIgnoreOracleError("invalid Git ignore query", { cause }),
      );
    }
    const run = this.#tail.then(async () => {
      let delegatedPaths = encoded;
      let delegatedIndexes = encodedIndexes;
      if (this.#syntheticShape !== undefined) {
        try {
          const representable =
            await this.#syntheticShape.materialize(shapePaths);
          delegatedPaths = [];
          delegatedIndexes = [];
          representable.forEach((canDelegate, index) => {
            if (canDelegate) {
              delegatedPaths.push(encoded[index]!);
              delegatedIndexes.push(encodedIndexes[index]!);
            } else {
              results[encodedIndexes[index]!] = false;
            }
          });
        } catch (cause) {
          const error = new GitIgnoreOracleError(
            "cannot materialize the synthetic Git query shape",
            { cause },
          );
          this.#fail(error);
          throw error;
        }
      }
      if (delegatedPaths.length === 0) return results;
      const delegated = await this.#run(delegatedPaths);
      delegated.forEach((managed, index) => {
        results[delegatedIndexes[index]!] = managed;
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
    if (this.#pending !== undefined || this.#framer.hasFragment()) {
      return Promise.reject(
        new GitIgnoreOracleError("Git ignore oracle protocol is out of sync"),
      );
    }
    const response = new Promise<readonly boolean[]>((resolveQuery, reject) => {
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
    });
    const write = this.#writeInput(expectedPaths).catch((cause: unknown) => {
      const error =
        cause instanceof GitIgnoreOracleError
          ? cause
          : new GitIgnoreOracleError("cannot write to Git ignore oracle", {
              cause,
            });
      this.#fail(error);
      throw error;
    });
    // Do not release the serialization lane until both the response and the
    // final write callback have settled. Otherwise a late EPIPE from one batch
    // could be misattributed to its successor.
    return Promise.all([response, write]).then(([results]) => results);
  }

  async #writeInput(expectedPaths: readonly Buffer[]): Promise<void> {
    const nul = Buffer.from([0]);
    let parts: Buffer[] = [];
    let bytes = 0;
    const flush = async (): Promise<void> => {
      if (bytes === 0) return;
      const chunk = Buffer.concat(parts, bytes);
      parts = [];
      bytes = 0;
      await this.#writeChunk(chunk);
    };
    for (const path of expectedPaths) {
      if (
        bytes > 0 &&
        bytes + path.byteLength + 1 > MAX_ORACLE_WRITE_CHUNK_BYTES
      ) {
        await flush();
      }
      parts.push(path, nul);
      bytes += path.byteLength + 1;
    }
    await flush();
  }

  #writeChunk(chunk: Buffer): Promise<void> {
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    return new Promise((resolveWrite, reject) => {
      // Waiting for each write callback bounds the writable queue even when
      // Git applies backpressure; at most one protocol chunk is outstanding.
      this.#child.stdin.write(chunk, (cause) => {
        if (cause !== null && cause !== undefined) {
          reject(
            new GitIgnoreOracleError("cannot write to Git ignore oracle", {
              cause,
            }),
          );
          return;
        }
        resolveWrite();
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
    const records = this.#framer.push(chunk);
    for (const fields of records) {
      const source = fields[0]!;
      const line = fields[1]!;
      const pattern = fields[2]!;
      const pathname = fields[3]!;
      const expected = pending.expectedPaths[pending.results.length];
      const nonMatch = source.byteLength === 0;
      const validNonMatch =
        nonMatch && line.byteLength === 0 && pattern.byteLength === 0;
      const validMatch =
        !nonMatch && isPositiveDecimalLine(line) && pattern.byteLength !== 0;
      if (
        expected === undefined ||
        !pathname.equals(expected) ||
        (!validNonMatch && !validMatch)
      ) {
        this.#fail(
          new GitIgnoreOracleError(
            "Git ignore oracle returned a malformed record",
          ),
        );
        return;
      }
      const negated = !nonMatch && pattern[0] === 0x21;
      pending.results.push(nonMatch || negated);
    }
    if (pending.results.length === pending.expectedPaths.length) {
      if (this.#framer.hasFragment()) {
        this.#fail(
          new GitIgnoreOracleError(
            "Git ignore oracle returned a trailing record fragment",
          ),
        );
        return;
      }
      clearTimeout(pending.timer);
      this.#pending = undefined;
      pending.resolve(pending.results);
    }
  }

  #onStderr(chunk: Buffer): void {
    this.#diagnosticBytes += chunk.byteLength;
    const remaining =
      MAX_ORACLE_DIAGNOSTIC_BYTES - this.#diagnostics.byteLength;
    if (remaining > 0) {
      this.#diagnostics = Buffer.concat([
        this.#diagnostics,
        chunk.subarray(0, remaining),
      ]);
    }
    if (this.#diagnosticBytes > MAX_ORACLE_DIAGNOSTIC_BYTES) {
      this.#diagnosticsTruncated = true;
    }
    this.#fail(
      new GitIgnoreOracleError(
        `Git ignore oracle produced diagnostics: ${diagnosticDetail(this.#diagnostics, this.#diagnosticsTruncated)}`,
      ),
    );
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

  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    this.#closed = true;
    await this.#tail;
    if (!this.#child.stdin.destroyed) this.#child.stdin.end();
    let result = await this.#exitWithin(GIT_COMMAND_TIMEOUT_MS);
    if (result === undefined) {
      this.#child.kill();
      result = await this.#exitWithin(1_000);
    }
    if (result === undefined) {
      this.#child.kill("SIGKILL");
      result = await this.#exitWithin(1_000);
    }
    const exited = result !== undefined;
    let primaryFailure: unknown;
    try {
      if (result === undefined) {
        throw new GitIgnoreOracleError(
          "Git ignore oracle did not exit within the close deadline",
        );
      }
      const completed = result;
      if (this.#failure !== undefined) throw this.#failure;
      if (this.#framer.hasFragment()) {
        throw new GitIgnoreOracleError(
          "Git ignore oracle ended with an incomplete record",
        );
      }
      if (completed.code !== 0 && completed.code !== 1) {
        throw new GitIgnoreOracleError(
          `Git ignore oracle failed while closing (${completed.code ?? completed.signal ?? "unknown"})`,
        );
      }
    } catch (error) {
      primaryFailure = error;
    }
    let cleanupFailure: unknown;
    // Preserve a synthetic worktree if its subprocess could still be using
    // it. A later tmp-directory sweep may recover that bounded orphan.
    if (exited && this.#cleanupRoot !== undefined) {
      try {
        await removeSyntheticScratchRoot(this.#cleanupRoot);
      } catch (error) {
        cleanupFailure = error;
      }
    }
    if (primaryFailure !== undefined && cleanupFailure !== undefined) {
      const primaryDetail =
        primaryFailure instanceof Error
          ? primaryFailure.message
          : String(primaryFailure);
      const cleanupDetail =
        cleanupFailure instanceof Error
          ? cleanupFailure.message
          : String(cleanupFailure);
      throw new GitIgnoreOracleError(
        `Git ignore oracle failed (${primaryDetail}); its synthetic scratch could not be cleaned (${cleanupDetail})`,
        { cause: new AggregateError([primaryFailure, cleanupFailure]) },
      );
    }
    if (primaryFailure !== undefined) throw primaryFailure;
    if (cleanupFailure !== undefined) throw cleanupFailure;
  }

  #exitWithin(milliseconds: number): Promise<
    | {
        readonly code: number | null;
        readonly signal: NodeJS.Signals | null;
      }
    | undefined
  > {
    return new Promise((resolveExit) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolveExit(undefined);
      }, milliseconds);
      timer.unref();
      void this.#exit.then((result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveExit(result);
      });
    });
  }
}

/** Use the current repository as Git's semantic authority. */
export async function createLiveGitIgnoreOracle(
  root: string,
  scope: WorkspaceScope,
  pathLimits: WorkspacePathLimits = DEFAULT_WORKSPACE_PATH_LIMITS,
): Promise<GitIgnoreOracle> {
  const canonical = canonicalizeWorkspaceScope(scope, pathLimits);
  if (canonical.kind === "all-managed") {
    return new AllManagedOracle(pathLimits);
  }
  if (canonical.evaluator === null) {
    throw new GitIgnoreOracleError(
      "live Git ignore oracle requires captured evaluator provenance",
    );
  }
  const context = await locateGitWorktree(root, pathLimits);
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
  const [gitVersion, ignoreCase, precomposeUnicode] = await Promise.all([
    readGitVersion(context.env),
    gitBoolean(context, "core.ignoreCase"),
    gitBoolean(context, "core.precomposeUnicode"),
  ]);
  if (
    canonical.ignoreCase !== ignoreCase ||
    canonical.evaluator.version !== gitVersion ||
    canonical.evaluator.precomposeUnicode !== precomposeUnicode
  ) {
    throw new GitIgnoreOracleError(
      "workspace Git semantics changed after policy discovery",
    );
  }
  return new ProcessGitIgnoreOracle({
    repositoryRoot: context.repositoryRoot,
    repositoryPrefix: context.repositoryPrefix,
    env: context.env,
    gitVersion,
    pathLimits,
  });
}

/** Reconstruct a private Git worktree containing only archived policy bytes. */
export async function createSyntheticGitIgnoreOracle(
  scope: WorkspaceScope,
  options: SyntheticGitIgnoreScratchOptions = {},
): Promise<GitIgnoreOracle> {
  const pathLimits = options.pathLimits ?? DEFAULT_WORKSPACE_PATH_LIMITS;
  const canonical = canonicalizeWorkspaceScope(scope, pathLimits);
  if (canonical.kind === "all-managed") {
    return new AllManagedOracle(pathLimits);
  }
  const policySources = canonical.gitignoreSources.map(
    ({ path, contentsBase64 }) => ({
      path,
      contents: workspaceScopeBytes(contentsBase64),
    }),
  );
  const infoExclude = workspaceScopeBytes(canonical.infoExcludeBase64);
  const globalExclude = workspaceScopeBytes(canonical.globalExcludeBase64);
  for (const source of policySources) {
    assertNulFreeGitPolicy(
      source.contents,
      `Git ignore source ${JSON.stringify(source.path)}`,
    );
  }
  assertNulFreeGitPolicy(infoExclude, "Git info/exclude");
  assertNulFreeGitPolicy(globalExclude, "Git global excludes file");
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
    const gitVersion = await readGitVersion(env);
    await runGit(["init", "-q", repositoryRoot], env);
    const syntheticShape = new SyntheticGitDirectoryShape(
      repositoryRoot,
      policySources,
    );
    const infoPathResult = await runGit(
      ["-C", repositoryRoot, "rev-parse", "--git-path", "info/exclude"],
      env,
    );
    if (canonical.evaluator !== null) {
      await runGit(
        [
          "-C",
          repositoryRoot,
          "config",
          "--local",
          "core.precomposeUnicode",
          String(canonical.evaluator.precomposeUnicode),
        ],
        env,
      );
    }
    const rawInfoPath = decodeGitPathLine(
      infoPathResult.stdout,
      "synthetic info/exclude path",
    );
    const infoPath = isAbsolute(rawInfoPath)
      ? rawInfoPath
      : resolve(repositoryRoot, rawInfoPath);
    await mkdir(dirname(infoPath), { recursive: true });
    await writeFile(infoPath, infoExclude);
    const globalPath = join(
      repositoryRoot,
      ".git",
      "cyclotomy-global-excludes",
    );
    await writeFile(globalPath, globalExclude, { flag: "wx" });
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
    return new ProcessGitIgnoreOracle({
      repositoryRoot,
      repositoryPrefix: canonical.repositoryPrefix,
      env,
      gitVersion,
      cleanupRoot: scratch,
      syntheticShape,
      pathLimits,
    });
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
