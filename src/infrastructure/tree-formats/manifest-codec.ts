import { createHash } from "node:crypto";
import { isTreeOid } from "../../domain/model.ts";
import {
  ABSOLUTE_MAX_WORKSPACE_RELATIVE_PATH_BYTES,
  ABSOLUTE_MAX_WORKSPACE_RELATIVE_PATH_COMPONENTS,
  ABSOLUTE_WORKSPACE_PATH_LIMITS,
  canonicalWorkspaceRelativePath,
  canonicalizeWorkspaceScope,
  DEFAULT_WORKSPACE_PATH_LIMITS,
  portableWorkspacePathKey,
  workspaceLocalGitignorePath,
  type WorkspacePathLimits,
  type WorkspaceScope,
} from "../workspace-scope.ts";

export class TreeManifestError extends Error {
  readonly kind:
    "invalid-tree-manifest" | "format-incompatible" | "object-integrity";

  constructor(
    kind: "invalid-tree-manifest" | "format-incompatible" | "object-integrity",
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

/** Default publication limits; configuration may lower or raise them. */
export const DEFAULT_MAX_TREE_ENTRIES = 100_000;
export const DEFAULT_MAX_TREE_MANIFEST_BYTES = 64 * 1024 * 1024;

/** Absolute parser/publication ceilings, including explicitly configured use. */
export const ABSOLUTE_MAX_TREE_ENTRIES = 1_000_000;
export const ABSOLUTE_MAX_TREE_MANIFEST_BYTES = 256 * 1024 * 1024;

export interface TreeManifestLimits extends WorkspacePathLimits {
  readonly maxEntries: number;
  readonly maxManifestBytes: number;
}

export const DEFAULT_TREE_MANIFEST_LIMITS: TreeManifestLimits = {
  maxEntries: DEFAULT_MAX_TREE_ENTRIES,
  maxManifestBytes: DEFAULT_MAX_TREE_MANIFEST_BYTES,
  ...DEFAULT_WORKSPACE_PATH_LIMITS,
};

export const ABSOLUTE_TREE_MANIFEST_LIMITS: TreeManifestLimits = {
  maxEntries: ABSOLUTE_MAX_TREE_ENTRIES,
  maxManifestBytes: ABSOLUTE_MAX_TREE_MANIFEST_BYTES,
  ...ABSOLUTE_WORKSPACE_PATH_LIMITS,
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
  readonly format: string;
  readonly entries: readonly TreeEntry[];
  readonly scope: WorkspaceScope;
}

/** Freeze the complete canonical manifest graph at a trust boundary. */
export function freezeTreeManifest<Manifest extends TreeManifest>(
  manifest: Manifest,
): Manifest {
  for (const entry of manifest.entries) Object.freeze(entry);
  Object.freeze(manifest.entries);
  if (manifest.scope.kind === "git") {
    if (manifest.scope.evaluator !== null) {
      Object.freeze(manifest.scope.evaluator);
    }
    for (const source of manifest.scope.gitignoreSources) Object.freeze(source);
    Object.freeze(manifest.scope.gitignoreSources);
  }
  Object.freeze(manifest.scope);
  return Object.freeze(manifest);
}
export function exactKeys(
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

export function invalidManifest(message: string): never {
  throw new TreeManifestError("invalid-tree-manifest", message);
}

export function assertTreeManifestLimits(limits: TreeManifestLimits): void {
  if (
    !Number.isSafeInteger(limits.maxEntries) ||
    limits.maxEntries <= 0 ||
    limits.maxEntries > ABSOLUTE_MAX_TREE_ENTRIES ||
    !Number.isSafeInteger(limits.maxManifestBytes) ||
    limits.maxManifestBytes <= 0 ||
    limits.maxManifestBytes > ABSOLUTE_MAX_TREE_MANIFEST_BYTES ||
    !Number.isSafeInteger(limits.maxPathBytes) ||
    limits.maxPathBytes <= 0 ||
    limits.maxPathBytes > ABSOLUTE_MAX_WORKSPACE_RELATIVE_PATH_BYTES ||
    !Number.isSafeInteger(limits.maxPathComponents) ||
    limits.maxPathComponents <= 0 ||
    limits.maxPathComponents > ABSOLUTE_MAX_WORKSPACE_RELATIVE_PATH_COMPONENTS
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

function comparePathBytes(left: TreeEntry, right: TreeEntry): number {
  return Buffer.compare(
    Buffer.from(left.path, "utf8"),
    Buffer.from(right.path, "utf8"),
  );
}

function isWellFormedUnicode(value: string): boolean {
  return Buffer.from(value, "utf8").toString("utf8") === value;
}

function validateEntryPath(path: string, limits: WorkspacePathLimits): void {
  try {
    canonicalWorkspaceRelativePath(path, false, limits);
  } catch {
    invalidManifest(`unsafe tree entry path: ${JSON.stringify(path)}`);
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

function validateEntryWithPath(
  value: unknown,
  validatePath: (path: string) => void,
): TreeEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidManifest("tree entry must be an object");
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry.path !== "string") {
    return invalidManifest("tree entry path must be a string");
  }
  validatePath(entry.path);

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

function validateEntry(value: unknown, limits: WorkspacePathLimits): TreeEntry {
  return validateEntryWithPath(value, (path) =>
    validateEntryPath(path, limits),
  );
}

type TreeNamespaceMember =
  | {
      readonly kind: "entry";
      readonly path: string;
      readonly entry: TreeEntry;
    }
  | {
      readonly kind: "directory";
      readonly path: string;
    };

interface CanonicalizedTreeEntries {
  readonly entries: readonly TreeEntry[];
  readonly namespaceByPortablePath: ReadonlyMap<string, TreeNamespaceMember>;
}

function canonicalizeTreeEntries(
  value: unknown,
  limits: TreeManifestLimits,
): CanonicalizedTreeEntries {
  assertTreeManifestLimits(limits);
  assertEntryLimit(value, limits);

  const entries = value.map((entry) => validateEntry(entry, limits));
  entries.sort(comparePathBytes);
  const byPath = new Map<string, TreeEntry>();
  const namespaceByPortablePath = new Map<string, TreeNamespaceMember>();
  for (const entry of entries) {
    if (byPath.has(entry.path)) {
      return invalidManifest(`duplicate tree entry path: ${entry.path}`);
    }
    const canonical = portableWorkspacePathKey(entry.path);
    const owner = namespaceByPortablePath.get(canonical);
    if (owner !== undefined) {
      return invalidManifest(
        `tree entry path collides with ${owner.path} after portable case normalization: ${entry.path}`,
      );
    }
    byPath.set(entry.path, entry);
    namespaceByPortablePath.set(canonical, {
      kind: "entry",
      path: entry.path,
      entry,
    });
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
      const canonical = portableWorkspacePathKey(parentPath);
      const owner = namespaceByPortablePath.get(canonical);
      if (owner !== undefined && owner.path !== parentPath) {
        return invalidManifest(
          `tree entry path collides with ${owner.path} after portable case normalization: ${parentPath}`,
        );
      }
      if (owner === undefined) {
        namespaceByPortablePath.set(canonical, {
          kind: "directory",
          path: parentPath,
        });
      }
      separator = parentPath.lastIndexOf("/");
    }
  }

  return { entries, namespaceByPortablePath };
}

/**
 * Bind managed in-workspace `.gitignore` entries to their archived policy
 * bytes. An archived source may itself be ignored and therefore absent from
 * entries; policy provenance and path ownership are deliberately separate.
 */
function validateTreeScopeBindings(
  tree: CanonicalizedTreeEntries,
  scope: WorkspaceScope,
  limits: WorkspacePathLimits,
): void {
  if (scope.kind === "all-managed") return;
  const policyNamespace = new Map<
    string,
    { readonly kind: "directory" | "source"; readonly path: string }
  >();
  const addPolicyDirectory = (path: string): void => {
    const key = portableWorkspacePathKey(path);
    const previous = policyNamespace.get(key);
    if (
      previous !== undefined &&
      (previous.kind !== "directory" || previous.path !== path)
    ) {
      invalidManifest(
        `workspace scope policy path aliases ${previous.path}: ${path}`,
      );
    }
    const target = tree.namespaceByPortablePath.get(key);
    if (
      target !== undefined &&
      (target.kind !== "directory" || target.path !== path)
    ) {
      invalidManifest(
        `workspace scope policy directory collides with tree path ${target.path}: ${path}`,
      );
    }
    policyNamespace.set(key, { kind: "directory", path });
  };
  for (const source of scope.gitignoreSources) {
    const localPath = workspaceLocalGitignorePath(scope, source.path, limits);
    if (localPath === undefined) continue;
    let separator = localPath.lastIndexOf("/");
    while (separator !== -1) {
      const ancestor = localPath.slice(0, separator);
      addPolicyDirectory(ancestor);
      separator = ancestor.lastIndexOf("/");
    }

    const key = portableWorkspacePathKey(localPath);
    // The selected scope codec has already authenticated canonical base64.
    // Decode without reapplying current policy so frozen historical codecs
    // retain their released acceptance set.
    const expectedOid = sha256(Buffer.from(source.contentsBase64, "base64"));
    const previousPolicyPath = policyNamespace.get(key);
    if (
      previousPolicyPath !== undefined &&
      (previousPolicyPath.kind !== "source" ||
        previousPolicyPath.path !== localPath)
    ) {
      invalidManifest(
        `workspace scope ignore source aliases ${previousPolicyPath.path}: ${localPath}`,
      );
    }
    policyNamespace.set(key, { kind: "source", path: localPath });
    const target = tree.namespaceByPortablePath.get(key);
    if (
      target !== undefined &&
      (target.kind !== "entry" ||
        target.entry.type !== "regular" ||
        target.entry.blobOid !== expectedOid)
    ) {
      invalidManifest(
        `workspace scope ignore source does not match tree entry: ${localPath}`,
      );
    }
  }
  for (const entry of tree.entries) {
    const basename = entry.path.slice(entry.path.lastIndexOf("/") + 1);
    const isIgnoreSource = portableWorkspacePathKey(basename) === ".gitignore";
    if (entry.type !== "regular" || !isIgnoreSource) {
      continue;
    }
    if (
      policyNamespace.get(portableWorkspacePathKey(entry.path))?.kind !==
      "source"
    ) {
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
  return canonicalizeTreeManifestUsingScopeCodec(
    entries,
    scope,
    limits,
    canonicalizeWorkspaceScope,
  );
}

/** Shared v2/v3 entry grammar with an explicitly versioned scope codec. */
export function canonicalizeTreeManifestUsingScopeCodec(
  entries: unknown,
  scope: unknown,
  limits: TreeManifestLimits,
  canonicalizeScope: (
    value: unknown,
    limits: WorkspacePathLimits,
  ) => WorkspaceScope,
): { readonly entries: readonly TreeEntry[]; readonly scope: WorkspaceScope } {
  const canonicalEntries = canonicalizeTreeEntries(entries, limits);
  let canonicalScope: WorkspaceScope;
  try {
    canonicalScope = canonicalizeScope(scope, limits);
    validateTreeScopeBindings(canonicalEntries, canonicalScope, limits);
  } catch (error) {
    if (error instanceof TreeManifestError) throw error;
    throw new TreeManifestError(
      "invalid-tree-manifest",
      "tree has an invalid workspace scope",
      error,
    );
  }
  return { entries: canonicalEntries.entries, scope: canonicalScope };
}

export function encodeTreeManifestDocument(
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
