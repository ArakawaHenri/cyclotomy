/** A `.gitignore` captured at its repository-relative location. */
export interface WorkspaceGitignoreSource {
  readonly path: string;
  /** Canonical base64 of the exact bytes Git consumed. */
  readonly contentsBase64: string;
}

export interface AllManagedWorkspaceScope {
  /** Non-Git workspaces have no implicit unmanaged namespace. */
  readonly kind: "all-managed";
}

export interface GitWorkspaceEvaluator {
  /** Exact single-line `git --version` output used during capture. */
  readonly version: string;
  /** Captured `core.precomposeUnicode` value. */
  readonly precomposeUnicode: boolean;
}

export interface GitWorkspaceScope {
  readonly kind: "git";
  /** Repository-relative workspace directory; the repository root is "". */
  readonly repositoryPrefix: string;
  /** Evaluator facts captured with v3, or null after a legacy tree upgrade. */
  readonly evaluator: GitWorkspaceEvaluator | null;
  readonly ignoreCase: boolean;
  /** Repository/worktree `.gitignore` files relevant to this workspace. */
  readonly gitignoreSources: readonly WorkspaceGitignoreSource[];
  /** Exact `$GIT_DIR/info/exclude` bytes, or empty bytes when absent. */
  readonly infoExcludeBase64: string;
  /** Exact effective `core.excludesFile` bytes, or empty bytes when absent. */
  readonly globalExcludeBase64: string;
}

/** Durable target-time ownership policy for one workspace tree. */
export type WorkspaceScope = AllManagedWorkspaceScope | GitWorkspaceScope;

export const MAX_GITIGNORE_SOURCES = 100_000;
export const MAX_GITIGNORE_SOURCE_BYTES = 256 * 1024;
export const MAX_GITIGNORE_POLICY_BYTES = 16 * 1024 * 1024;
export const MAX_GIT_VERSION_BYTES = 256;
/**
 * Defaults for newly observed/published paths. Configuration may lower or
 * raise them within the absolute parser ceilings below.
 */
export const DEFAULT_MAX_WORKSPACE_RELATIVE_PATH_BYTES = 64 * 1024;
export const DEFAULT_MAX_WORKSPACE_RELATIVE_PATH_COMPONENTS = 256;

/**
 * Absolute parser ceilings. They remain finite so an untrusted manifest cannot
 * turn path normalization or ancestor enumeration into an unbounded operation,
 * while leaving ample room above every practical native filesystem limit.
 */
export const ABSOLUTE_MAX_WORKSPACE_RELATIVE_PATH_BYTES = 1024 * 1024;
export const ABSOLUTE_MAX_WORKSPACE_RELATIVE_PATH_COMPONENTS = 4_096;

export interface WorkspacePathLimits {
  readonly maxPathBytes: number;
  readonly maxPathComponents: number;
}

export const DEFAULT_WORKSPACE_PATH_LIMITS: WorkspacePathLimits = {
  maxPathBytes: DEFAULT_MAX_WORKSPACE_RELATIVE_PATH_BYTES,
  maxPathComponents: DEFAULT_MAX_WORKSPACE_RELATIVE_PATH_COMPONENTS,
};

export const ABSOLUTE_WORKSPACE_PATH_LIMITS: WorkspacePathLimits = {
  maxPathBytes: ABSOLUTE_MAX_WORKSPACE_RELATIVE_PATH_BYTES,
  maxPathComponents: ABSOLUTE_MAX_WORKSPACE_RELATIVE_PATH_COMPONENTS,
};

export class WorkspaceScopeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceScopeError";
  }
}

/**
 * Conservative key for one physical workspace namespace.
 *
 * This is not a Git matcher: Git ownership continues to use
 * `workspaceScopePathKey`. The second fixed case-normalization pass closes the
 * capital-sharp-s mapping exposed by case-insensitive APFS while keeping this
 * structural check deterministic and fixed-pass.
 */
export function portableWorkspacePathKey(path: string): string {
  const once = path
    .normalize("NFC")
    .toLocaleUpperCase("en-US")
    .toLocaleLowerCase("en-US")
    .normalize("NFC");
  return once
    .toLocaleUpperCase("en-US")
    .toLocaleLowerCase("en-US")
    .normalize("NFC");
}

function invalidScope(message: string): never {
  throw new WorkspaceScopeError(message);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index])
  );
}

function isExactUtf8String(value: string): boolean {
  return Buffer.from(value, "utf8").toString("utf8") === value;
}

function comparePathBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function assertWorkspacePathLimits(limits: WorkspacePathLimits): void {
  if (
    !Number.isSafeInteger(limits.maxPathBytes) ||
    limits.maxPathBytes <= 0 ||
    limits.maxPathBytes > ABSOLUTE_MAX_WORKSPACE_RELATIVE_PATH_BYTES ||
    !Number.isSafeInteger(limits.maxPathComponents) ||
    limits.maxPathComponents <= 0 ||
    limits.maxPathComponents > ABSOLUTE_MAX_WORKSPACE_RELATIVE_PATH_COMPONENTS
  ) {
    invalidScope("workspace path limits are outside the supported range");
  }
}

/** Validate one normalized repository-relative path. */
export function canonicalWorkspaceRelativePath(
  value: unknown,
  allowRoot: boolean,
  limits: WorkspacePathLimits = DEFAULT_WORKSPACE_PATH_LIMITS,
): string {
  assertWorkspacePathLimits(limits);
  if (
    typeof value !== "string" ||
    !isExactUtf8String(value) ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value !== value.normalize("NFC") ||
    (!allowRoot && value.length === 0)
  ) {
    return invalidScope("scope contains an unsafe or noncanonical path");
  }
  if (Buffer.byteLength(value, "utf8") > limits.maxPathBytes) {
    return invalidScope("scope path exceeds the portable byte limit");
  }
  if (value === "" && allowRoot) return value;
  const components = value.split("/");
  if (components.length > limits.maxPathComponents) {
    return invalidScope("scope path exceeds the portable component limit");
  }
  for (const component of components) {
    if (
      component.length === 0 ||
      component === "." ||
      component === ".." ||
      portableWorkspacePathKey(component) === ".git"
    ) {
      return invalidScope("scope contains an unsafe or noncanonical path");
    }
  }
  return value;
}

function decodeCanonicalBase64(value: unknown, label: string): Buffer {
  if (
    typeof value !== "string" ||
    value.length % 4 !== 0 ||
    value.length > Math.ceil(MAX_GITIGNORE_SOURCE_BYTES / 3) * 4
  ) {
    return invalidScope(`${label} is not canonical base64`);
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  for (let index = 0; index < value.length - padding; index += 1) {
    const code = value.charCodeAt(index);
    if (
      !(code >= 0x41 && code <= 0x5a) &&
      !(code >= 0x61 && code <= 0x7a) &&
      !(code >= 0x30 && code <= 0x39) &&
      code !== 0x2b &&
      code !== 0x2f
    ) {
      return invalidScope(`${label} is not canonical base64`);
    }
  }
  for (let index = value.length - padding; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 0x3d) {
      return invalidScope(`${label} is not canonical base64`);
    }
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    return invalidScope(`${label} is not canonical base64`);
  }
  if (decoded.byteLength > MAX_GITIGNORE_SOURCE_BYTES) {
    return invalidScope(`${label} exceeds the per-source byte limit`);
  }
  if (decoded.includes(0x00)) {
    const hasWideTextBom =
      (decoded[0] === 0xff && decoded[1] === 0xfe) ||
      (decoded[0] === 0xfe && decoded[1] === 0xff) ||
      (decoded[0] === 0x00 &&
        decoded[1] === 0x00 &&
        decoded[2] === 0xfe &&
        decoded[3] === 0xff);
    return invalidScope(
      hasWideTextBom
        ? `${label} contains NUL bytes and appears to be UTF-16/UTF-32; save the policy file as UTF-8 or another NUL-free encoding`
        : `${label} contains a NUL byte; Git policy files must be NUL-free`,
    );
  }
  return decoded;
}

function canonicalGitVersion(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_GIT_VERSION_BYTES ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code > 0x7e;
    })
  ) {
    return invalidScope(
      "Git version must be a non-empty printable ASCII line of at most 256 bytes",
    );
  }
  return value;
}

function canonicalGitEvaluator(value: unknown): GitWorkspaceEvaluator | null {
  if (value === null) return null;
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    !exactKeys(value as Record<string, unknown>, [
      "version",
      "precomposeUnicode",
    ])
  ) {
    return invalidScope("Git evaluator provenance has an invalid shape");
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.precomposeUnicode !== "boolean") {
    return invalidScope("Git evaluator provenance has an invalid shape");
  }
  return {
    version: canonicalGitVersion(candidate.version),
    precomposeUnicode: candidate.precomposeUnicode,
  };
}

function sourceIsRelevant(path: string, repositoryPrefix: string): boolean {
  const suffix = "/.gitignore";
  const base =
    path === ".gitignore"
      ? ""
      : path.endsWith(suffix)
        ? path.slice(0, -suffix.length)
        : undefined;
  if (base === undefined) return false;
  return (
    base === repositoryPrefix ||
    base === "" ||
    repositoryPrefix.startsWith(`${base}/`) ||
    base.startsWith(repositoryPrefix === "" ? "" : `${repositoryPrefix}/`)
  );
}

/** Build one source without ever interpreting its bytes as text. */
export function workspaceGitignoreSource(
  path: string,
  contents: Uint8Array,
  limits: WorkspacePathLimits = DEFAULT_WORKSPACE_PATH_LIMITS,
): WorkspaceGitignoreSource {
  return {
    path: canonicalWorkspaceRelativePath(path, false, limits),
    contentsBase64: Buffer.from(contents).toString("base64"),
  };
}

/** Map one repository policy source into this workspace, if it is local. */
export function workspaceLocalGitignorePath(
  scope: GitWorkspaceScope,
  repositoryPath: string,
  limits: WorkspacePathLimits = DEFAULT_WORKSPACE_PATH_LIMITS,
): string | undefined {
  const path = canonicalWorkspaceRelativePath(repositoryPath, false, limits);
  if (scope.repositoryPrefix === "") return path;
  const prefix = `${scope.repositoryPrefix}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
}

/** Canonical key for paths whose Git policy comparison is case-insensitive. */
export function workspaceScopePathKey(
  scope: GitWorkspaceScope,
  workspacePath: string,
  limits: WorkspacePathLimits = DEFAULT_WORKSPACE_PATH_LIMITS,
): string {
  const path = canonicalWorkspaceRelativePath(workspacePath, false, limits);
  return scope.ignoreCase ? path.toLocaleLowerCase("en-US") : path;
}

/** Validate untrusted scope data and rebuild its canonical byte-sorted form. */
export function canonicalizeWorkspaceScope(
  value: unknown,
  limits: WorkspacePathLimits = DEFAULT_WORKSPACE_PATH_LIMITS,
): WorkspaceScope {
  assertWorkspacePathLimits(limits);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidScope("workspace scope must be an object");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "all-managed") {
    if (!exactKeys(candidate, ["kind"])) {
      return invalidScope("all-managed workspace scope has an invalid shape");
    }
    return { kind: "all-managed" };
  }
  if (
    candidate.kind !== "git" ||
    !exactKeys(candidate, [
      "kind",
      "repositoryPrefix",
      "evaluator",
      "ignoreCase",
      "gitignoreSources",
      "infoExcludeBase64",
      "globalExcludeBase64",
    ]) ||
    typeof candidate.ignoreCase !== "boolean" ||
    !Array.isArray(candidate.gitignoreSources)
  ) {
    return invalidScope("Git workspace scope has an invalid shape");
  }
  if (candidate.gitignoreSources.length > MAX_GITIGNORE_SOURCES) {
    return invalidScope("Git workspace scope has too many ignore sources");
  }

  const repositoryPrefix = canonicalWorkspaceRelativePath(
    candidate.repositoryPrefix,
    true,
    limits,
  );
  const evaluator = canonicalGitEvaluator(candidate.evaluator);
  let totalBytes = 0;
  const decodeBudgeted = (encoded: unknown, label: string): string => {
    const decoded = decodeCanonicalBase64(encoded, label);
    if (decoded.byteLength > MAX_GITIGNORE_SOURCE_BYTES) {
      return invalidScope(`${label} exceeds the per-source byte limit`);
    }
    totalBytes += decoded.byteLength;
    if (totalBytes > MAX_GITIGNORE_POLICY_BYTES) {
      return invalidScope("Git workspace scope exceeds the policy byte limit");
    }
    return encoded as string;
  };

  const gitignoreSources = candidate.gitignoreSources.map((source) => {
    if (
      typeof source !== "object" ||
      source === null ||
      Array.isArray(source)
    ) {
      return invalidScope("Git ignore source must be an object");
    }
    const record = source as Record<string, unknown>;
    if (!exactKeys(record, ["path", "contentsBase64"])) {
      return invalidScope("Git ignore source has an invalid shape");
    }
    const path = canonicalWorkspaceRelativePath(record.path, false, limits);
    if (!sourceIsRelevant(path, repositoryPrefix)) {
      return invalidScope("Git ignore source is unrelated to the workspace");
    }
    return {
      path,
      contentsBase64: decodeBudgeted(
        record.contentsBase64,
        `Git ignore source ${JSON.stringify(path)}`,
      ),
    };
  });
  gitignoreSources.sort((left, right) =>
    comparePathBytes(left.path, right.path),
  );
  for (let index = 1; index < gitignoreSources.length; index += 1) {
    if (gitignoreSources[index]?.path === gitignoreSources[index - 1]?.path) {
      return invalidScope("Git workspace scope has duplicate ignore sources");
    }
  }

  const infoExcludeBase64 = decodeBudgeted(
    candidate.infoExcludeBase64,
    "Git info/exclude",
  );
  const globalExcludeBase64 = decodeBudgeted(
    candidate.globalExcludeBase64,
    "Git global excludes file",
  );
  return {
    kind: "git",
    repositoryPrefix,
    evaluator,
    ignoreCase: candidate.ignoreCase,
    gitignoreSources,
    infoExcludeBase64,
    globalExcludeBase64,
  };
}

/** Decode policy bytes only at the Git process/file boundary. */
export function workspaceScopeBytes(encoded: string): Buffer {
  return decodeCanonicalBase64(encoded, "workspace policy bytes");
}

/** Compare scopes by their canonical semantic representation. */
export function workspaceScopesEqual(
  left: WorkspaceScope,
  right: WorkspaceScope,
  limits: WorkspacePathLimits,
): boolean {
  return (
    JSON.stringify(canonicalizeWorkspaceScope(left, limits)) ===
    JSON.stringify(canonicalizeWorkspaceScope(right, limits))
  );
}
