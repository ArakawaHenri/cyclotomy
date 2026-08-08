import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import { isTreeOid } from "../domain/model.ts";
import {
  canonicalizeWorkspaceScope,
  workspaceLocalGitignorePath,
  workspaceScopePathKey,
  workspaceScopeBytes,
  type WorkspaceScope,
} from "./workspace-scope.ts";

export class TreeManifestError extends Error {
  readonly kind: "invalid-tree-manifest" | "object-integrity";

  constructor(
    kind: "invalid-tree-manifest" | "object-integrity",
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "TreeManifestError";
    this.kind = kind;
  }
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export const TREE_MANIFEST_FORMAT = "cyclotomy-tree-v1";

/** Default publication limits; configuration may lower or raise them. */
export const DEFAULT_MAX_TREE_ENTRIES = 100_000;
export const DEFAULT_MAX_TREE_MANIFEST_BYTES = 64 * 1024 * 1024;

/** Absolute parser/publication ceilings, including explicitly configured use. */
export const ABSOLUTE_MAX_TREE_ENTRIES = 1_000_000;
export const ABSOLUTE_MAX_TREE_MANIFEST_BYTES = 256 * 1024 * 1024;

export interface TreeManifestLimits {
  readonly maxEntries: number;
  readonly maxManifestBytes: number;
}

export const DEFAULT_TREE_MANIFEST_LIMITS: TreeManifestLimits = {
  maxEntries: DEFAULT_MAX_TREE_ENTRIES,
  maxManifestBytes: DEFAULT_MAX_TREE_MANIFEST_BYTES,
};

const ABSOLUTE_TREE_MANIFEST_LIMITS: TreeManifestLimits = {
  maxEntries: ABSOLUTE_MAX_TREE_ENTRIES,
  maxManifestBytes: ABSOLUTE_MAX_TREE_MANIFEST_BYTES,
};

/**
 * Non-semantic creation metadata. Cyclotomy never compares or reconciles this
 * value on an existing file; it is consulted only when a regular file has to
 * be recreated. A number is the POSIX mode-bit mask (0..07777); null means the
 * source platform had no portable hint. Ownership, ACLs, xattrs, and
 * platform-specific security descriptors are deliberately excluded.
 */
export type FileRecreationMode = number | null;

/** Windows requires this flag even when a symlink target is dangling. */
export type SymlinkKind = "file" | "directory";

export type TreeEntry =
  | {
      readonly path: string;
      readonly type: "regular";
      readonly blobOid: string;
      readonly recreationMode: FileRecreationMode;
    }
  | {
      readonly path: string;
      readonly type: "symlink";
      readonly target: string;
      /** Null is a POSIX observation with no portable target kind. */
      readonly symlinkKind: SymlinkKind | null;
    };

export interface TreeManifest {
  readonly format: typeof TREE_MANIFEST_FORMAT;
  readonly entries: readonly TreeEntry[];
  readonly scope: WorkspaceScope;
}
function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length &&
    actual.every(
      (key, index) => key === canonical[index],
    )
  );
}

function invalidManifest(message: string): never {
  throw new TreeManifestError(
    "invalid-tree-manifest",
    message,
  );
}

export function assertTreeManifestLimits(limits: TreeManifestLimits): void {
  if (
    !Number.isSafeInteger(limits.maxEntries) ||
    limits.maxEntries <= 0 ||
    limits.maxEntries > ABSOLUTE_MAX_TREE_ENTRIES ||
    !Number.isSafeInteger(limits.maxManifestBytes) ||
    limits.maxManifestBytes <= 0 ||
    limits.maxManifestBytes > ABSOLUTE_MAX_TREE_MANIFEST_BYTES
  ) {
    invalidManifest("tree manifest limits are outside the supported range");
  }
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

function comparePathBytes(
  left: TreeEntry,
  right: TreeEntry,
): number {
  return Buffer.compare(
    Buffer.from(left.path, "utf8"),
    Buffer.from(right.path, "utf8"),
  );
}

function isWellFormedUnicode(value: string): boolean {
  return Buffer.from(value, "utf8").toString("utf8") === value;
}

function validateEntryPath(path: string): void {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\0") ||
    path.includes("\\") ||
    path !== path.normalize("NFC") ||
    !isWellFormedUnicode(path)
  ) {
    invalidManifest(
      `unsafe tree entry path: ${JSON.stringify(path)}`,
    );
  }
  for (const component of path.split("/")) {
    if (
      component.length === 0 ||
      component === "." ||
      component === ".." ||
      component.toLocaleLowerCase("en-US") === ".git"
    ) {
      invalidManifest(
        `unsafe tree entry path: ${JSON.stringify(path)}`,
      );
    }
  }
}

/**
 * Validate one entry and rebuild it with canonical key order. Entries land on
 * disk as canonical bytes, so the shape is validated even though callers are
 * ordinary typed objects.
 */
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

function validateEntry(
  value: unknown,
): TreeEntry {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return invalidManifest("tree entry must be an object");
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry.path !== "string") {
    return invalidManifest(
      "tree entry path must be a string",
    );
  }
  validateEntryPath(entry.path);

  if (entry.type === "regular") {
    if (
      !exactKeys(entry, [
        "path",
        "type",
        "blobOid",
        "recreationMode",
      ]) ||
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
      !exactKeys(
        entry,
        ["path", "type", "target", "symlinkKind"],
      ) ||
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

  return invalidManifest(
    "tree entry type is unsupported",
  );
}

function canonicalizeTreeEntries(
  value: unknown,
  limits: TreeManifestLimits,
): readonly TreeEntry[] {
  assertTreeManifestLimits(limits);
  assertEntryLimit(value, limits);

  const entries = value.map((entry) => validateEntry(entry));
  entries.sort(comparePathBytes);
  const byPath = new Map<string, TreeEntry>();
  const canonicalOwners = new Map<string, string>();
  for (const entry of entries) {
    if (byPath.has(entry.path)) {
      return invalidManifest(
        `duplicate tree entry path: ${entry.path}`,
      );
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
      const parentPath = entry.path.slice(
        0,
        separator,
      );
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

/**
 * Bind managed in-workspace `.gitignore` entries to their archived policy
 * bytes. An archived source may itself be ignored and therefore absent from
 * entries; policy provenance and path ownership are deliberately separate.
 */
function validateTreeScopeBindings(
  entries: readonly TreeEntry[],
  scope: WorkspaceScope,
): void {
  if (scope.kind === "all-managed") return;
  const byKey = new Map(
    entries.map((entry) => [workspaceScopePathKey(scope, entry.path), entry]),
  );
  const localSources = new Map<string, string>();
  for (const source of scope.gitignoreSources) {
    const localPath = workspaceLocalGitignorePath(scope, source.path);
    if (localPath === undefined) continue;
    const key = workspaceScopePathKey(scope, localPath);
    const expectedOid = sha256(
      workspaceScopeBytes(source.contentsBase64),
    );
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
    if (
      entry.type !== "regular" ||
      !isIgnoreSource
    ) {
      continue;
    }
    if (!localSources.has(workspaceScopePathKey(scope, entry.path))) {
      invalidManifest(
        `regular .gitignore entry is missing from workspace scope: ${entry.path}`,
      );
    }
  }
}

export function canonicalizeTreeManifest(
  entries: unknown,
  scope: unknown,
  limits: TreeManifestLimits = DEFAULT_TREE_MANIFEST_LIMITS,
): { readonly entries: readonly TreeEntry[]; readonly scope: WorkspaceScope } {
  const canonicalEntries = canonicalizeTreeEntries(entries, limits);
  let canonicalScope: WorkspaceScope;
  try {
    canonicalScope = canonicalizeWorkspaceScope(scope);
    validateTreeScopeBindings(canonicalEntries, canonicalScope);
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

export function encodeTreeManifest(
  entries: readonly TreeEntry[],
  scope: WorkspaceScope,
  limits: TreeManifestLimits = DEFAULT_TREE_MANIFEST_LIMITS,
): Buffer {
  assertTreeManifestLimits(limits);
  assertEntryLimit(entries, limits);
  const manifest: TreeManifest = {
    format: TREE_MANIFEST_FORMAT,
    entries,
    scope,
  };
  const encoded = Buffer.from(
    `${JSON.stringify(manifest)}\n`,
    "utf8",
  );
  if (encoded.byteLength > limits.maxManifestBytes) {
    invalidManifest(
      `tree manifest is ${encoded.byteLength} bytes, exceeding the ${limits.maxManifestBytes}-byte limit`,
    );
  }
  return encoded;
}

/**
 * Strictly validate a manifest read from disk: the byte encoding must be
 * exactly the canonical re-encoding of a structurally valid manifest.
 */
export function parseCanonicalTreeManifest(
  content: Uint8Array,
): TreeManifest {
  if (content.byteLength > ABSOLUTE_MAX_TREE_MANIFEST_BYTES) {
    throw new TreeManifestError(
      "object-integrity",
      `tree object exceeds the ${ABSOLUTE_MAX_TREE_MANIFEST_BYTES}-byte parser limit`,
    );
  }
  let parsed: unknown;
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
    }).decode(content);
    parsed = JSON.parse(text);
  } catch (error) {
    throw new TreeManifestError(
      "object-integrity",
      "tree object is not valid UTF-8 JSON",
      error,
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new TreeManifestError(
      "object-integrity",
      "tree object has an invalid manifest shape",
    );
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.format !== TREE_MANIFEST_FORMAT ||
    !exactKeys(candidate, ["format", "entries", "scope"])
  ) {
    throw new TreeManifestError(
      "object-integrity",
      "tree object has an unsupported manifest format",
    );
  }

  let entries: readonly TreeEntry[];
  let scope: WorkspaceScope;
  try {
    entries = canonicalizeTreeEntries(
      candidate.entries,
      ABSOLUTE_TREE_MANIFEST_LIMITS,
    );
    scope = canonicalizeWorkspaceScope(candidate.scope);
    validateTreeScopeBindings(entries, scope);
  } catch (error) {
    throw new TreeManifestError(
      "object-integrity",
      "tree object contains an invalid manifest",
      error,
    );
  }
  const canonicalBytes = encodeTreeManifest(
    entries,
    scope,
    ABSOLUTE_TREE_MANIFEST_LIMITS,
  );
  if (
    !canonicalBytes.equals(Buffer.from(content))
  ) {
    throw new TreeManifestError(
      "object-integrity",
      "tree object is not canonically encoded",
    );
  }
  return { format: TREE_MANIFEST_FORMAT, entries, scope };
}
