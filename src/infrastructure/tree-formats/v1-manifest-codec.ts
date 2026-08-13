import { createHash } from "node:crypto";

import { isTreeOid } from "../../domain/model.ts";
import type { WorkspaceScope } from "../workspace-scope.ts";
import {
  TreeManifestError,
  assertTreeManifestLimits,
  type FileRecreationMode,
  type SymlinkKind,
  type TreeEntry,
  type TreeManifest,
  type TreeManifestLimits,
} from "./manifest-codec.ts";
import {
  canonicalV1WorkspaceRelativePath,
  canonicalizeV1WorkspaceScope,
  v1WorkspaceLocalGitignorePath,
  v1WorkspaceScopeBytes,
  v1WorkspaceScopePathKey,
} from "./v1-workspace-scope.ts";

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function invalidManifest(message: string): never {
  throw new TreeManifestError("invalid-tree-manifest", message);
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

function assertEntryLimit(
  value: unknown,
  limits: TreeManifestLimits,
): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) {
    invalidManifest("tree entries must be an array");
  }
  if (value.length > limits.maxEntries) {
    invalidManifest(
      `tree has ${value.length} entries, exceeding the ${limits.maxEntries}-entry limit`,
    );
  }
}

function comparePathBytes(left: TreeEntry, right: TreeEntry): number {
  return Buffer.compare(
    Buffer.from(left.path, "utf8"),
    Buffer.from(right.path, "utf8"),
  );
}

function isWellFormedUnicode(value: string): boolean {
  return Buffer.from(value, "utf8").toString("utf8") === value;
}

function validateRecreationMode(value: unknown): FileRecreationMode {
  if (value === null) return null;
  if (
    Number.isSafeInteger(value) &&
    Number(value) >= 0 &&
    Number(value) <= 0o7777
  ) {
    return Number(value);
  }
  return invalidManifest("regular entry has an invalid recreation mode");
}

function validateEntry(value: unknown): TreeEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidManifest("tree entry must be an object");
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry.path !== "string") {
    return invalidManifest("tree entry path must be a string");
  }
  try {
    canonicalV1WorkspaceRelativePath(entry.path, false);
  } catch {
    invalidManifest(`unsafe tree entry path: ${JSON.stringify(entry.path)}`);
  }

  if (entry.type === "regular") {
    if (
      !exactKeys(entry, ["path", "type", "blobOid", "recreationMode"]) ||
      !isTreeOid(entry.blobOid)
    ) {
      return invalidManifest(
        "regular entry has invalid or noncanonical fields",
      );
    }
    return {
      path: entry.path,
      type: "regular",
      blobOid: entry.blobOid,
      recreationMode: validateRecreationMode(entry.recreationMode),
    };
  }

  if (entry.type === "symlink") {
    if (
      !exactKeys(entry, ["path", "type", "target", "symlinkKind"]) ||
      typeof entry.target !== "string" ||
      entry.target.length === 0 ||
      entry.target.includes("\0") ||
      !isWellFormedUnicode(entry.target) ||
      (entry.symlinkKind !== null &&
        entry.symlinkKind !== "file" &&
        entry.symlinkKind !== "directory")
    ) {
      return invalidManifest(
        "symlink entry has invalid or noncanonical fields",
      );
    }
    return {
      path: entry.path,
      type: "symlink",
      target: entry.target,
      symlinkKind: entry.symlinkKind as SymlinkKind | null,
    };
  }

  return invalidManifest("tree entry type is unsupported");
}

function canonicalizeEntries(
  value: unknown,
  limits: TreeManifestLimits,
): readonly TreeEntry[] {
  assertTreeManifestLimits(limits);
  assertEntryLimit(value, limits);

  const entries = value.map(validateEntry);
  entries.sort(comparePathBytes);
  const byPath = new Map<string, TreeEntry>();
  const canonicalOwners = new Map<string, string>();
  for (const entry of entries) {
    if (byPath.has(entry.path)) {
      return invalidManifest(`duplicate tree entry path: ${entry.path}`);
    }
    const canonical = entry.path.toLocaleLowerCase("en-US");
    const owner = canonicalOwners.get(canonical);
    if (owner !== undefined) {
      return invalidManifest(
        `tree entry path collides with ${owner} after lowercase normalization: ${entry.path}`,
      );
    }
    byPath.set(entry.path, entry);
    canonicalOwners.set(canonical, entry.path);
  }

  for (const entry of entries) {
    let separator = entry.path.lastIndexOf("/");
    while (separator !== -1) {
      const parentPath = entry.path.slice(0, separator);
      const parent = byPath.get(parentPath);
      if (parent !== undefined) {
        return invalidManifest(
          `tree entry parent is a managed non-directory: ${parentPath}`,
        );
      }
      const canonical = parentPath.toLocaleLowerCase("en-US");
      const owner = canonicalOwners.get(canonical);
      if (owner !== undefined && owner !== parentPath) {
        return invalidManifest(
          `tree entry path collides with ${owner} after lowercase normalization: ${parentPath}`,
        );
      }
      canonicalOwners.set(canonical, parentPath);
      separator = parentPath.lastIndexOf("/");
    }
  }

  return entries;
}

function validateScopeBindings(
  entries: readonly TreeEntry[],
  scope: WorkspaceScope,
): void {
  if (scope.kind === "all-managed") return;
  const byKey = new Map(
    entries.map((entry) => [v1WorkspaceScopePathKey(scope, entry.path), entry]),
  );
  const localSources = new Map<string, string>();
  for (const source of scope.gitignoreSources) {
    const localPath = v1WorkspaceLocalGitignorePath(scope, source.path);
    if (localPath === undefined) continue;
    const key = v1WorkspaceScopePathKey(scope, localPath);
    const expectedOid = sha256(v1WorkspaceScopeBytes(source.contentsBase64));
    const previous = localSources.get(key);
    if (previous !== undefined && previous !== localPath) {
      invalidManifest(
        `workspace scope ignore sources alias each other: ${previous} and ${localPath}`,
      );
    }
    localSources.set(key, localPath);
    const entry = byKey.get(key);
    if (
      entry !== undefined &&
      (entry.type !== "regular" || entry.blobOid !== expectedOid)
    ) {
      invalidManifest(
        `workspace scope ignore source does not match tree entry: ${localPath}`,
      );
    }
  }
  for (const entry of entries) {
    const basename = entry.path.slice(entry.path.lastIndexOf("/") + 1);
    const isIgnoreSource = scope.ignoreCase
      ? basename.toLocaleLowerCase("en-US") === ".gitignore"
      : basename === ".gitignore";
    if (entry.type !== "regular" || !isIgnoreSource) continue;
    if (!localSources.has(v1WorkspaceScopePathKey(scope, entry.path))) {
      invalidManifest(
        `regular .gitignore entry is missing from workspace scope: ${entry.path}`,
      );
    }
  }
}

/** Authenticate and rebuild the exact tree contract shipped in 0.0.1. */
export function canonicalizeV1TreeManifest(
  entries: unknown,
  scope: unknown,
  limits: TreeManifestLimits,
): { readonly entries: readonly TreeEntry[]; readonly scope: WorkspaceScope } {
  const canonicalEntries = canonicalizeEntries(entries, limits);
  let canonicalScope: WorkspaceScope;
  try {
    canonicalScope = canonicalizeV1WorkspaceScope(scope);
    validateScopeBindings(canonicalEntries, canonicalScope);
  } catch (error) {
    if (error instanceof TreeManifestError) throw error;
    throw new TreeManifestError(
      "invalid-tree-manifest",
      "tree has an invalid workspace scope",
      error,
    );
  }
  return { entries: canonicalEntries, scope: canonicalScope };
}

/** Reproduce the exact newline-terminated JSON bytes shipped in 0.0.1. */
export function encodeV1TreeManifest(
  format: string,
  entries: readonly TreeEntry[],
  scope: WorkspaceScope,
  limits: TreeManifestLimits,
): Buffer {
  assertTreeManifestLimits(limits);
  assertEntryLimit(entries, limits);
  const manifest: TreeManifest = { format, entries, scope };
  const encoded = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
  if (encoded.byteLength > limits.maxManifestBytes) {
    invalidManifest(
      `tree manifest is ${encoded.byteLength} bytes, exceeding the ${limits.maxManifestBytes}-byte limit`,
    );
  }
  return encoded;
}
