import {
  WorkspaceScopeError,
  type GitWorkspaceScope,
  type WorkspaceScope,
} from "../workspace-scope.ts";

// These are format-v1 grammar constants, not current configuration. Keep them
// beside the historical decoder so later scope-policy changes cannot rewrite
// which 0.0.1 objects authenticate.
const V1_MAX_GITIGNORE_SOURCES = 100_000;
const V1_MAX_GITIGNORE_SOURCE_BYTES = 256 * 1024;
const V1_MAX_GITIGNORE_POLICY_BYTES = 16 * 1024 * 1024;

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

/** Frozen repository-relative path grammar shipped by cyclotomy@0.0.1. */
export function canonicalV1WorkspaceRelativePath(
  value: unknown,
  allowRoot: boolean,
): string {
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
  if (value === "" && allowRoot) return value;
  for (const component of value.split("/")) {
    if (
      component.length === 0 ||
      component === "." ||
      component === ".." ||
      component.toLocaleLowerCase("en-US") === ".git"
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
    value.length > Math.ceil(V1_MAX_GITIGNORE_SOURCE_BYTES / 3) * 4
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
  if (decoded.byteLength > V1_MAX_GITIGNORE_SOURCE_BYTES) {
    return invalidScope(`${label} exceeds the per-source byte limit`);
  }
  return decoded;
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

export function v1WorkspaceLocalGitignorePath(
  scope: GitWorkspaceScope,
  repositoryPath: string,
): string | undefined {
  const path = canonicalV1WorkspaceRelativePath(repositoryPath, false);
  if (scope.repositoryPrefix === "") return path;
  const prefix = `${scope.repositoryPrefix}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
}

export function v1WorkspaceScopePathKey(
  scope: GitWorkspaceScope,
  workspacePath: string,
): string {
  const path = canonicalV1WorkspaceRelativePath(workspacePath, false);
  return scope.ignoreCase ? path.toLocaleLowerCase("en-US") : path;
}

/** Frozen scope grammar and canonical ordering shipped by cyclotomy@0.0.1. */
export function canonicalizeV1WorkspaceScope(value: unknown): WorkspaceScope {
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
  if (candidate.gitignoreSources.length > V1_MAX_GITIGNORE_SOURCES) {
    return invalidScope("Git workspace scope has too many ignore sources");
  }

  const repositoryPrefix = canonicalV1WorkspaceRelativePath(
    candidate.repositoryPrefix,
    true,
  );
  let totalBytes = 0;
  const decodeBudgeted = (encoded: unknown, label: string): string => {
    const decoded = decodeCanonicalBase64(encoded, label);
    totalBytes += decoded.byteLength;
    if (totalBytes > V1_MAX_GITIGNORE_POLICY_BYTES) {
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
    const path = canonicalV1WorkspaceRelativePath(record.path, false);
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
    evaluator: null,
    ignoreCase: candidate.ignoreCase,
    gitignoreSources,
    infoExcludeBase64,
    globalExcludeBase64,
  };
}

export function v1WorkspaceScopeBytes(encoded: string): Buffer {
  return decodeCanonicalBase64(encoded, "workspace policy bytes");
}
