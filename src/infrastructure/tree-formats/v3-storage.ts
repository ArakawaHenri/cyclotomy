import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import { isTreeOid, type TreeOid } from "../../domain/model.ts";
import {
  MAX_GITIGNORE_POLICY_BYTES,
  MAX_GITIGNORE_SOURCE_BYTES,
  MAX_GITIGNORE_SOURCES,
  workspaceScopeBytes,
  type GitWorkspaceEvaluator,
  type WorkspaceScope,
} from "../workspace-scope.ts";
import {
  ABSOLUTE_MAX_TREE_MANIFEST_BYTES,
  ABSOLUTE_TREE_MANIFEST_LIMITS,
  assertTreeManifestLimits,
  canonicalizeTreeManifest,
  encodeTreeManifestDocument,
  exactKeys,
  freezeTreeManifest,
  TreeManifestError,
  type TreeEntry,
  type TreeManifest,
  type TreeManifestLimits,
} from "./manifest-codec.ts";
import {
  authenticateStoredObject,
  storedObjectOid,
  type AuthenticatedStoredTree,
  type StoredTreeFormatAdapter,
  type StoredTreeReadAccess,
  type StoredTreeStructuralKind,
  type StoredTreeWriteAccess,
} from "./stored-adapter.ts";
import {
  TREE_FORMAT_V3_CURRENT,
  TREE_MANIFEST_FORMAT_V3,
} from "./v3-current.ts";

export const TREE_V3_PROLLY_PROFILE = "cyclotomy-prolly-key-v1";
export const TREE_V3_MINIMUM_NODE_PAYLOAD = 8 * 1024;
export const TREE_V3_TARGET_NODE_PAYLOAD = 16 * 1024;
export const TREE_V3_MAXIMUM_NODE_PAYLOAD = 32 * 1024;
export const TREE_V3_MAXIMUM_STRUCTURAL_OBJECT_BYTES =
  ABSOLUTE_MAX_TREE_MANIFEST_BYTES;

const TREE_V3_ROOT_KIND = "cyclotomy-tree-root";
const TREE_V3_NODE_KIND = "cyclotomy-tree-node";
const TREE_V3_SCOPE_KIND = "cyclotomy-tree-scope";
const TREE_V3_SCOPE_SOURCE_NODE_KIND = "cyclotomy-tree-scope-source-node";
const TREE_V3_STRUCTURE_VERSION = 1;
const TREE_V3_MAXIMUM_HEIGHT = 64;
const TREE_V3_PUBLICATION_CONCURRENCY = 8;
const TREE_V3_STRUCTURAL_BUDGET_MULTIPLIER = 4;
const TREE_V3_STRUCTURAL_BUDGET_FIXED_BYTES = 1024 * 1024;
const BOUNDARY_HASH_DOMAIN = Buffer.from(
  "cyclotomy-prolly-key-boundary-v1\0",
  "utf8",
);

interface V3RootDocument {
  readonly kind: typeof TREE_V3_ROOT_KIND;
  readonly version: typeof TREE_V3_STRUCTURE_VERSION;
  readonly format: typeof TREE_MANIFEST_FORMAT_V3;
  readonly profile: typeof TREE_V3_PROLLY_PROFILE;
  readonly height: number;
  readonly entryCount: number;
  readonly entryMapRoot: TreeOid | null;
  readonly scopeOid: TreeOid;
}

type V3LeafEntry =
  | {
      readonly path: string;
      readonly type: "regular";
      readonly blobOid: string;
      readonly recreationMode: number | null;
    }
  | {
      readonly path: string;
      readonly type: "symlink";
      readonly targetContentId: string;
      readonly targetByteLength: number;
      readonly symlinkKind: "file" | "directory" | null;
    };

interface V3LeafNodeDocument {
  readonly kind: typeof TREE_V3_NODE_KIND;
  readonly version: typeof TREE_V3_STRUCTURE_VERSION;
  readonly level: 0;
  readonly entries: readonly V3LeafEntry[];
}

interface V3ChildReference {
  readonly highKey: string;
  readonly oid: TreeOid;
  readonly entryCount: number;
}

interface V3InternalNodeDocument {
  readonly kind: typeof TREE_V3_NODE_KIND;
  readonly version: typeof TREE_V3_STRUCTURE_VERSION;
  readonly level: number;
  readonly children: readonly V3ChildReference[];
}

type V3NodeDocument = V3LeafNodeDocument | V3InternalNodeDocument;

interface V3ContentReference {
  readonly contentId: string;
  readonly byteLength: number;
}

interface V3GitignoreReference extends V3ContentReference {
  readonly path: string;
}

interface V3ScopeSourceChildReference {
  readonly highKey: string;
  readonly oid: TreeOid;
  readonly sourceCount: number;
}

interface V3ScopeSourceLeafDocument {
  readonly kind: typeof TREE_V3_SCOPE_SOURCE_NODE_KIND;
  readonly version: typeof TREE_V3_STRUCTURE_VERSION;
  readonly level: 0;
  readonly sources: readonly V3GitignoreReference[];
}

interface V3ScopeSourceInternalDocument {
  readonly kind: typeof TREE_V3_SCOPE_SOURCE_NODE_KIND;
  readonly version: typeof TREE_V3_STRUCTURE_VERSION;
  readonly level: number;
  readonly children: readonly V3ScopeSourceChildReference[];
}

type V3ScopeSourceNodeDocument =
  V3ScopeSourceLeafDocument | V3ScopeSourceInternalDocument;

type V3ScopeDocument =
  | {
      readonly kind: typeof TREE_V3_SCOPE_KIND;
      readonly version: typeof TREE_V3_STRUCTURE_VERSION;
      readonly scopeKind: "all-managed";
    }
  | {
      readonly kind: typeof TREE_V3_SCOPE_KIND;
      readonly version: typeof TREE_V3_STRUCTURE_VERSION;
      readonly scopeKind: "git";
      readonly repositoryPrefix: string;
      readonly evaluator: GitWorkspaceEvaluator | null;
      readonly ignoreCase: boolean;
      readonly gitignoreSourceCount: number;
      readonly gitignoreSourceRoot: TreeOid | null;
      readonly infoExclude: V3ContentReference;
      readonly globalExclude: V3ContentReference;
    };

interface StructuralObject {
  readonly kind: StoredTreeStructuralKind;
  readonly oid: TreeOid;
  readonly bytes: Buffer;
}

interface NodeReference extends V3ChildReference {
  readonly level: number;
}

interface ScopeSourceNodeReference extends V3ScopeSourceChildReference {
  readonly level: number;
}

interface BuiltV3Graph {
  readonly manifest: TreeManifest;
  readonly root: V3RootDocument;
  readonly rootOid: TreeOid;
  /** Dependency-first, root-last publication order. */
  readonly structuralObjects: readonly StructuralObject[];
  /** Only v3-introduced raw content; regular blobs already exist. */
  readonly introducedContent: ReadonlyMap<string, Buffer>;
}

function integrity(message: string, cause?: unknown): never {
  throw new TreeManifestError("object-integrity", message, cause);
}

function canonicalDocument(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function structuralByteBudget(limits: TreeManifestLimits): number {
  return (
    limits.maxManifestBytes * TREE_V3_STRUCTURAL_BUDGET_MULTIPLIER +
    TREE_V3_STRUCTURAL_BUDGET_FIXED_BYTES
  );
}

function compareKeys(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function isSafeNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validEvaluator(value: unknown): value is GitWorkspaceEvaluator | null {
  if (value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    exactKeys(candidate, ["version", "precomposeUnicode"]) &&
    typeof candidate.version === "string" &&
    typeof candidate.precomposeUnicode === "boolean"
  );
}

function isSafePositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function decodeCanonicalDocument(
  content: Uint8Array,
  label: string,
): Readonly<Record<string, unknown>> {
  let decoded: string;
  let parsed: unknown;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(content);
    parsed = JSON.parse(decoded);
  } catch (error) {
    return integrity(`${label} is not valid UTF-8 JSON`, error);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return integrity(`${label} has an invalid document shape`);
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function requireCanonicalDocument(
  content: Uint8Array,
  document: unknown,
  label: string,
): void {
  if (!canonicalDocument(document).equals(Buffer.from(content))) {
    integrity(`${label} is not canonically encoded`);
  }
}

function contentReference(content: Buffer): V3ContentReference {
  return {
    contentId: storedObjectOid(content),
    byteLength: content.byteLength,
  };
}

function addUniqueObject(
  ordered: StructuralObject[],
  byOid: Map<TreeOid, Buffer>,
  kind: StoredTreeStructuralKind,
  document: unknown,
): TreeOid {
  const bytes = canonicalDocument(document);
  if (bytes.byteLength > TREE_V3_MAXIMUM_STRUCTURAL_OBJECT_BYTES) {
    throw new TreeManifestError(
      "invalid-tree-manifest",
      `tree v3 ${kind} structural object exceeds the ${TREE_V3_MAXIMUM_STRUCTURAL_OBJECT_BYTES}-byte absolute limit`,
    );
  }
  const oid = storedObjectOid(bytes);
  const existing = byOid.get(oid);
  if (existing !== undefined) {
    if (!existing.equals(bytes)) {
      throw new Error("SHA-256 collision between canonical tree structures");
    }
    return oid;
  }
  byOid.set(oid, bytes);
  ordered.push(Object.freeze({ kind, oid, bytes }));
  return oid;
}

function addIntroducedContent(
  content: Buffer,
  byId: Map<string, Buffer>,
): V3ContentReference {
  const reference = contentReference(content);
  const previous = byId.get(reference.contentId);
  if (previous !== undefined && !previous.equals(content)) {
    throw new Error("SHA-256 collision between raw tree content objects");
  }
  if (previous === undefined) byId.set(reference.contentId, content);
  return reference;
}

function buildScopeSourceMap(
  sources: readonly V3GitignoreReference[],
  structuralObjects: StructuralObject[],
  structuralByOid: Map<TreeOid, Buffer>,
): ScopeSourceNodeReference | undefined {
  let nodes: ScopeSourceNodeReference[] = partitionByKey(
    sources,
    (source) => source.path,
    false,
  ).map((group) => {
    const document: V3ScopeSourceLeafDocument = {
      kind: TREE_V3_SCOPE_SOURCE_NODE_KIND,
      version: TREE_V3_STRUCTURE_VERSION,
      level: 0,
      sources: group,
    };
    return {
      highKey: group.at(-1)!.path,
      oid: addUniqueObject(
        structuralObjects,
        structuralByOid,
        "scope",
        document,
      ),
      sourceCount: group.length,
      level: 0,
    };
  });

  while (nodes.length > 1) {
    const level = nodes[0]!.level + 1;
    const groups = partitionByKey(nodes, (node) => node.highKey, true);
    nodes = groups.map((children) => {
      if (children.length < 2) {
        throw new Error("canonical scope builder produced a unary node");
      }
      const document: V3ScopeSourceInternalDocument = {
        kind: TREE_V3_SCOPE_SOURCE_NODE_KIND,
        version: TREE_V3_STRUCTURE_VERSION,
        level,
        children: children.map(({ highKey, oid, sourceCount }) => ({
          highKey,
          oid,
          sourceCount,
        })),
      };
      return {
        highKey: children.at(-1)!.highKey,
        oid: addUniqueObject(
          structuralObjects,
          structuralByOid,
          "scope",
          document,
        ),
        sourceCount: children.reduce(
          (total, child) => total + child.sourceCount,
          0,
        ),
        level,
      };
    });
  }
  return nodes[0];
}

function buildScopeDocument(
  scope: WorkspaceScope,
  introducedContent: Map<string, Buffer>,
  structuralObjects: StructuralObject[],
  structuralByOid: Map<TreeOid, Buffer>,
): V3ScopeDocument {
  if (scope.kind === "all-managed") {
    return {
      kind: TREE_V3_SCOPE_KIND,
      version: TREE_V3_STRUCTURE_VERSION,
      scopeKind: "all-managed",
    };
  }
  const gitignoreSources: V3GitignoreReference[] = scope.gitignoreSources.map(
    (source) => ({
      path: source.path,
      ...addIntroducedContent(
        workspaceScopeBytes(source.contentsBase64),
        introducedContent,
      ),
    }),
  );
  const sourceMap = buildScopeSourceMap(
    gitignoreSources,
    structuralObjects,
    structuralByOid,
  );
  return {
    kind: TREE_V3_SCOPE_KIND,
    version: TREE_V3_STRUCTURE_VERSION,
    scopeKind: "git",
    repositoryPrefix: scope.repositoryPrefix,
    evaluator: scope.evaluator,
    ignoreCase: scope.ignoreCase,
    gitignoreSourceCount: gitignoreSources.length,
    gitignoreSourceRoot: sourceMap?.oid ?? null,
    infoExclude: addIntroducedContent(
      workspaceScopeBytes(scope.infoExcludeBase64),
      introducedContent,
    ),
    globalExclude: addIntroducedContent(
      workspaceScopeBytes(scope.globalExcludeBase64),
      introducedContent,
    ),
  };
}

function estimatedKeyPayload(key: string): number {
  // The estimate deliberately excludes values: content/mode changes must not
  // perturb node boundaries. The fixed allowance covers descriptor framing.
  return Buffer.byteLength(key, "utf8") + 192;
}

function keySelectsBoundary(key: string, estimatedPayload: number): boolean {
  const hash = createHash("sha256")
    .update(BOUNDARY_HASH_DOMAIN)
    .update(key, "utf8")
    .digest()
    .readUInt32BE(0);
  const boundedWeight = Math.min(estimatedPayload, TREE_V3_TARGET_NODE_PAYLOAD);
  const threshold = Math.floor(
    (boundedWeight * 0x1_0000_0000) / TREE_V3_TARGET_NODE_PAYLOAD,
  );
  return hash < threshold;
}

function partitionByKey<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
  internal: boolean,
): readonly (readonly T[])[] {
  if (values.length === 0) return [];
  const groups: T[][] = [];
  let group: T[] = [];
  let payload = 0;
  const finish = (): void => {
    if (group.length > 0) groups.push(group);
    group = [];
    payload = 0;
  };

  for (const value of values) {
    const key = keyOf(value);
    const weight = estimatedKeyPayload(key);
    if (group.length > 0 && payload + weight > TREE_V3_MAXIMUM_NODE_PAYLOAD) {
      finish();
    }
    group.push(value);
    payload += weight;
    if (
      payload >= TREE_V3_MAXIMUM_NODE_PAYLOAD ||
      (payload >= TREE_V3_MINIMUM_NODE_PAYLOAD &&
        keySelectsBoundary(key, weight))
    ) {
      finish();
    }
  }
  finish();

  if (!internal || groups.length <= 1) return groups;

  // Internal nodes must have at least two children. Normalize unary groups in
  // one forward pass: pair consecutive singletons, and only fold a final odd
  // singleton into its predecessor. A run of singleton groups therefore
  // cannot collapse into one unbounded node.
  const normalized: T[][] = [];
  for (let index = 0; index < groups.length;) {
    const current = groups[index]!;
    if (current.length !== 1) {
      normalized.push(current);
      index += 1;
      continue;
    }
    const next = groups[index + 1];
    if (next !== undefined) {
      normalized.push([...current, ...next]);
      index += 2;
      continue;
    }
    const previous = normalized.pop();
    if (previous === undefined) {
      throw new Error("internal partition cannot contain one unary group");
    }
    normalized.push([...previous, ...current]);
    index += 1;
  }
  return normalized;
}

function canonicalV3Manifest(
  manifest: TreeManifest,
  limits: TreeManifestLimits,
): TreeManifest {
  if (manifest.format !== TREE_MANIFEST_FORMAT_V3) {
    throw new TreeManifestError(
      "format-incompatible",
      `cannot store ${manifest.format} as ${TREE_MANIFEST_FORMAT_V3}`,
    );
  }
  const canonical = canonicalizeTreeManifest(
    manifest.entries,
    manifest.scope,
    limits,
  );
  // maxManifestMiB remains the size of the equivalent complete semantic document,
  // never the size of one Prolly node or of the compact root.
  encodeTreeManifestDocument(
    TREE_MANIFEST_FORMAT_V3,
    canonical.entries,
    canonical.scope,
    limits,
  );
  return {
    format: TREE_MANIFEST_FORMAT_V3,
    entries: canonical.entries,
    scope: canonical.scope,
  };
}

function buildV3Graph(
  input: TreeManifest,
  limits: TreeManifestLimits,
): BuiltV3Graph {
  const manifest = canonicalV3Manifest(input, limits);
  const structuralObjects: StructuralObject[] = [];
  const structuralByOid = new Map<TreeOid, Buffer>();
  const introducedContent = new Map<string, Buffer>();

  const scopeDocument = buildScopeDocument(
    manifest.scope,
    introducedContent,
    structuralObjects,
    structuralByOid,
  );
  const scopeOid = addUniqueObject(
    structuralObjects,
    structuralByOid,
    "scope",
    scopeDocument,
  );

  const leafEntries: V3LeafEntry[] = manifest.entries.map((entry) => {
    if (entry.type === "regular") {
      return {
        path: entry.path,
        type: "regular",
        blobOid: entry.blobOid,
        recreationMode: entry.recreationMode,
      };
    }
    const target = Buffer.from(entry.target, "utf8");
    const reference = addIntroducedContent(target, introducedContent);
    return {
      path: entry.path,
      type: "symlink",
      targetContentId: reference.contentId,
      targetByteLength: reference.byteLength,
      symlinkKind: entry.symlinkKind,
    };
  });

  let nodes: NodeReference[] = partitionByKey(
    leafEntries,
    (entry) => entry.path,
    false,
  ).map((entries) => {
    const document: V3LeafNodeDocument = {
      kind: TREE_V3_NODE_KIND,
      version: TREE_V3_STRUCTURE_VERSION,
      level: 0,
      entries,
    };
    return {
      highKey: entries.at(-1)!.path,
      oid: addUniqueObject(
        structuralObjects,
        structuralByOid,
        "node",
        document,
      ),
      entryCount: entries.length,
      level: 0,
    };
  });

  while (nodes.length > 1) {
    const level = nodes[0]!.level + 1;
    const groups = partitionByKey(nodes, (node) => node.highKey, true);
    nodes = groups.map((children) => {
      if (children.length < 2) {
        throw new Error("canonical Prolly builder produced a unary node");
      }
      const document: V3InternalNodeDocument = {
        kind: TREE_V3_NODE_KIND,
        version: TREE_V3_STRUCTURE_VERSION,
        level,
        children: children.map(({ highKey, oid, entryCount }) => ({
          highKey,
          oid,
          entryCount,
        })),
      };
      return {
        highKey: children.at(-1)!.highKey,
        oid: addUniqueObject(
          structuralObjects,
          structuralByOid,
          "node",
          document,
        ),
        entryCount: children.reduce(
          (total, child) => total + child.entryCount,
          0,
        ),
        level,
      };
    });
  }

  const top = nodes[0];
  const root: V3RootDocument = {
    kind: TREE_V3_ROOT_KIND,
    version: TREE_V3_STRUCTURE_VERSION,
    format: TREE_MANIFEST_FORMAT_V3,
    profile: TREE_V3_PROLLY_PROFILE,
    height: top?.level ?? 0,
    entryCount: manifest.entries.length,
    entryMapRoot: top?.oid ?? null,
    scopeOid,
  };
  const rootOid = addUniqueObject(
    structuralObjects,
    structuralByOid,
    "root",
    root,
  );
  const structuralBytes = structuralObjects.reduce(
    (total, object) => total + object.bytes.byteLength,
    0,
  );
  if (structuralBytes > structuralByteBudget(limits)) {
    throw new Error(
      "canonical tree v3 graph exceeds its structural byte budget",
    );
  }
  return {
    manifest,
    root,
    rootOid,
    structuralObjects,
    introducedContent,
  };
}

function parseRoot(content: Uint8Array): V3RootDocument {
  const candidate = decodeCanonicalDocument(content, "tree v3 root");
  if (
    !exactKeys(candidate as Record<string, unknown>, [
      "kind",
      "version",
      "format",
      "profile",
      "height",
      "entryCount",
      "entryMapRoot",
      "scopeOid",
    ]) ||
    candidate.kind !== TREE_V3_ROOT_KIND ||
    candidate.version !== TREE_V3_STRUCTURE_VERSION ||
    candidate.format !== TREE_MANIFEST_FORMAT_V3 ||
    candidate.profile !== TREE_V3_PROLLY_PROFILE ||
    !isSafeNonnegativeInteger(candidate.height) ||
    Number(candidate.height) > TREE_V3_MAXIMUM_HEIGHT ||
    !isSafeNonnegativeInteger(candidate.entryCount) ||
    (candidate.entryMapRoot !== null && !isTreeOid(candidate.entryMapRoot)) ||
    !isTreeOid(candidate.scopeOid)
  ) {
    return integrity("tree v3 root has invalid fields");
  }
  const root: V3RootDocument = {
    kind: TREE_V3_ROOT_KIND,
    version: TREE_V3_STRUCTURE_VERSION,
    format: TREE_MANIFEST_FORMAT_V3,
    profile: TREE_V3_PROLLY_PROFILE,
    height: Number(candidate.height),
    entryCount: Number(candidate.entryCount),
    entryMapRoot: candidate.entryMapRoot as TreeOid | null,
    scopeOid: candidate.scopeOid,
  };
  requireCanonicalDocument(content, root, "tree v3 root");
  return root;
}

function parseContentReference(
  value: unknown,
  label: string,
): V3ContentReference {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return integrity(`${label} has an invalid reference shape`);
  }
  const candidate = value as Record<string, unknown>;
  if (
    !exactKeys(candidate, ["contentId", "byteLength"]) ||
    !isTreeOid(candidate.contentId) ||
    !isSafeNonnegativeInteger(candidate.byteLength) ||
    Number(candidate.byteLength) > ABSOLUTE_MAX_TREE_MANIFEST_BYTES
  ) {
    return integrity(`${label} has an invalid content reference`);
  }
  return {
    contentId: candidate.contentId,
    byteLength: Number(candidate.byteLength),
  };
}

function parseGitignoreReference(
  value: unknown,
  label: string,
): V3GitignoreReference {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return integrity(`${label} has an invalid shape`);
  }
  const candidate = value as Record<string, unknown>;
  if (
    !exactKeys(candidate, ["path", "contentId", "byteLength"]) ||
    typeof candidate.path !== "string"
  ) {
    return integrity(`${label} has invalid fields`);
  }
  return {
    path: candidate.path,
    ...parseContentReference(
      {
        contentId: candidate.contentId,
        byteLength: candidate.byteLength,
      },
      label,
    ),
  };
}

function parseScopeSourceChildren(
  value: unknown,
): readonly V3ScopeSourceChildReference[] {
  if (!Array.isArray(value) || value.length < 2) {
    return integrity(
      "tree v3 scope-source internal node must have at least two children",
    );
  }
  const children = value.map((candidate) => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      return integrity("tree v3 scope-source child has an invalid shape");
    }
    const record = candidate as Record<string, unknown>;
    if (
      !exactKeys(record, ["highKey", "oid", "sourceCount"]) ||
      typeof record.highKey !== "string" ||
      !isTreeOid(record.oid) ||
      !isSafePositiveInteger(record.sourceCount)
    ) {
      return integrity("tree v3 scope-source child has invalid fields");
    }
    return {
      highKey: record.highKey,
      oid: record.oid,
      sourceCount: Number(record.sourceCount),
    };
  });
  for (let index = 1; index < children.length; index += 1) {
    if (
      compareKeys(children[index - 1]!.highKey, children[index]!.highKey) >= 0
    ) {
      return integrity(
        "tree v3 scope-source child high keys are not strictly byte-sorted",
      );
    }
  }
  return children;
}

function parseScopeSourceNode(content: Uint8Array): V3ScopeSourceNodeDocument {
  const candidate = decodeCanonicalDocument(
    content,
    "tree v3 scope-source node",
  );
  if (
    candidate.kind !== TREE_V3_SCOPE_SOURCE_NODE_KIND ||
    candidate.version !== TREE_V3_STRUCTURE_VERSION ||
    !isSafeNonnegativeInteger(candidate.level) ||
    Number(candidate.level) > TREE_V3_MAXIMUM_HEIGHT
  ) {
    return integrity("tree v3 scope-source node has an invalid header");
  }
  if (candidate.level === 0) {
    if (
      !exactKeys(candidate as Record<string, unknown>, [
        "kind",
        "version",
        "level",
        "sources",
      ]) ||
      !Array.isArray(candidate.sources) ||
      candidate.sources.length === 0
    ) {
      return integrity("tree v3 scope-source leaf has invalid fields");
    }
    const sources = candidate.sources.map((source, index) =>
      parseGitignoreReference(source, `Git ignore source ${index}`),
    );
    for (let index = 1; index < sources.length; index += 1) {
      if (compareKeys(sources[index - 1]!.path, sources[index]!.path) >= 0) {
        return integrity(
          "tree v3 scope-source leaf keys are not strictly byte-sorted",
        );
      }
    }
    const document: V3ScopeSourceLeafDocument = {
      kind: TREE_V3_SCOPE_SOURCE_NODE_KIND,
      version: TREE_V3_STRUCTURE_VERSION,
      level: 0,
      sources,
    };
    requireCanonicalDocument(content, document, "tree v3 scope-source leaf");
    return document;
  }
  if (
    !exactKeys(candidate as Record<string, unknown>, [
      "kind",
      "version",
      "level",
      "children",
    ])
  ) {
    return integrity("tree v3 scope-source internal node has invalid fields");
  }
  const document: V3ScopeSourceInternalDocument = {
    kind: TREE_V3_SCOPE_SOURCE_NODE_KIND,
    version: TREE_V3_STRUCTURE_VERSION,
    level: Number(candidate.level),
    children: parseScopeSourceChildren(candidate.children),
  };
  requireCanonicalDocument(
    content,
    document,
    "tree v3 scope-source internal node",
  );
  return document;
}

async function readRawContent(
  reference: V3ContentReference,
  access: StoredTreeReadAccess,
  cache: Map<string, Buffer>,
  label: string,
): Promise<Buffer> {
  const previous = cache.get(reference.contentId);
  if (previous !== undefined) {
    if (previous.byteLength !== reference.byteLength) {
      return integrity(`${label} disagrees about shared content length`);
    }
    return previous;
  }
  const content = Buffer.from(
    await access.readContent(reference.contentId, reference.byteLength),
  );
  if (
    content.byteLength !== reference.byteLength ||
    storedObjectOid(content) !== reference.contentId
  ) {
    return integrity(`${label} does not match its raw content identity`);
  }
  cache.set(reference.contentId, content);
  return content;
}

async function readScope(
  content: Uint8Array,
  access: StoredTreeReadAccess,
  contentCache: Map<string, Buffer>,
  readScopeObject: (oid: TreeOid) => Promise<Buffer>,
): Promise<WorkspaceScope> {
  const candidate = decodeCanonicalDocument(content, "tree v3 scope");
  if (
    candidate.kind !== TREE_V3_SCOPE_KIND ||
    candidate.version !== TREE_V3_STRUCTURE_VERSION
  ) {
    return integrity("tree v3 scope has an invalid domain tag");
  }
  if (candidate.scopeKind === "all-managed") {
    if (
      !exactKeys(candidate as Record<string, unknown>, [
        "kind",
        "version",
        "scopeKind",
      ])
    ) {
      return integrity("all-managed tree v3 scope has invalid fields");
    }
    const document: V3ScopeDocument = {
      kind: TREE_V3_SCOPE_KIND,
      version: TREE_V3_STRUCTURE_VERSION,
      scopeKind: "all-managed",
    };
    requireCanonicalDocument(content, document, "tree v3 scope");
    return { kind: "all-managed" };
  }
  if (
    candidate.scopeKind !== "git" ||
    !exactKeys(candidate as Record<string, unknown>, [
      "kind",
      "version",
      "scopeKind",
      "repositoryPrefix",
      "evaluator",
      "ignoreCase",
      "gitignoreSourceCount",
      "gitignoreSourceRoot",
      "infoExclude",
      "globalExclude",
    ]) ||
    typeof candidate.repositoryPrefix !== "string" ||
    typeof candidate.ignoreCase !== "boolean" ||
    !validEvaluator(candidate.evaluator) ||
    !isSafeNonnegativeInteger(candidate.gitignoreSourceCount) ||
    Number(candidate.gitignoreSourceCount) > MAX_GITIGNORE_SOURCES ||
    (candidate.gitignoreSourceRoot !== null &&
      !isTreeOid(candidate.gitignoreSourceRoot))
  ) {
    return integrity("Git tree v3 scope has invalid fields");
  }
  const gitignoreSourceCount = Number(candidate.gitignoreSourceCount);
  const gitignoreSourceRoot = candidate.gitignoreSourceRoot as TreeOid | null;
  if ((gitignoreSourceCount === 0) !== (gitignoreSourceRoot === null)) {
    return integrity("Git tree v3 scope-source root fields disagree");
  }

  const infoExclude = parseContentReference(
    candidate.infoExclude,
    "Git info/exclude",
  );
  const globalExclude = parseContentReference(
    candidate.globalExclude,
    "Git global excludes file",
  );
  const document: V3ScopeDocument = {
    kind: TREE_V3_SCOPE_KIND,
    version: TREE_V3_STRUCTURE_VERSION,
    scopeKind: "git",
    repositoryPrefix: candidate.repositoryPrefix,
    evaluator: candidate.evaluator,
    ignoreCase: candidate.ignoreCase,
    gitignoreSourceCount,
    gitignoreSourceRoot,
    infoExclude,
    globalExclude,
  };
  requireCanonicalDocument(content, document, "tree v3 scope");

  const references: V3GitignoreReference[] = [];
  const usedSourceNodeOids = new Set<TreeOid>();
  const maximumSourceNodeCount = Math.max(1, gitignoreSourceCount * 2);
  const visitSourceNode = async (
    oid: TreeOid,
    expectedSourceCount: number,
    expectedLevel?: number,
  ): Promise<string> => {
    if (usedSourceNodeOids.has(oid)) {
      return integrity(
        "tree v3 reuses one scope-source node at multiple map positions",
      );
    }
    usedSourceNodeOids.add(oid);
    if (usedSourceNodeOids.size > maximumSourceNodeCount) {
      return integrity(
        "tree v3 scope-source graph exceeds its source-derived bound",
      );
    }
    const sourceNode = parseScopeSourceNode(await readScopeObject(oid));
    if (expectedLevel !== undefined && sourceNode.level !== expectedLevel) {
      return integrity(
        "tree v3 scope-source node level disagrees with its parent",
      );
    }
    if ("sources" in sourceNode) {
      if (sourceNode.sources.length !== expectedSourceCount) {
        return integrity(
          "tree v3 scope-source leaf count disagrees with its parent",
        );
      }
      references.push(...sourceNode.sources);
      return sourceNode.sources.at(-1)!.path;
    }

    const declaredCount = sourceNode.children.reduce(
      (total, child) => total + child.sourceCount,
      0,
    );
    if (
      !Number.isSafeInteger(declaredCount) ||
      declaredCount !== expectedSourceCount
    ) {
      return integrity(
        "tree v3 scope-source internal count disagrees with its parent",
      );
    }
    for (const child of sourceNode.children) {
      const observedHighKey = await visitSourceNode(
        child.oid,
        child.sourceCount,
        sourceNode.level - 1,
      );
      if (observedHighKey !== child.highKey) {
        return integrity(
          "tree v3 scope-source child high key is not authenticated",
        );
      }
    }
    return sourceNode.children.at(-1)!.highKey;
  };

  if (gitignoreSourceRoot !== null) {
    await visitSourceNode(gitignoreSourceRoot, gitignoreSourceCount);
  }
  if (references.length !== gitignoreSourceCount) {
    return integrity("Git tree v3 scope-source count is not authenticated");
  }
  for (let index = 1; index < references.length; index += 1) {
    if (
      compareKeys(references[index - 1]!.path, references[index]!.path) >= 0
    ) {
      return integrity(
        "tree v3 scope-source keys are not strictly byte-sorted",
      );
    }
  }

  const policyReferences = [...references, infoExclude, globalExclude];
  if (
    policyReferences.some(
      ({ byteLength }) => byteLength > MAX_GITIGNORE_SOURCE_BYTES,
    ) ||
    policyReferences.reduce((total, { byteLength }) => total + byteLength, 0) >
      MAX_GITIGNORE_POLICY_BYTES
  ) {
    return integrity("Git tree v3 scope exceeds its raw policy byte budget");
  }

  const sources = [];
  for (const reference of references) {
    sources.push({
      path: reference.path,
      contentsBase64: (
        await readRawContent(reference, access, contentCache, reference.path)
      ).toString("base64"),
    });
  }
  return {
    kind: "git",
    repositoryPrefix: candidate.repositoryPrefix,
    evaluator: candidate.evaluator,
    ignoreCase: candidate.ignoreCase,
    gitignoreSources: sources,
    infoExcludeBase64: (
      await readRawContent(
        infoExclude,
        access,
        contentCache,
        "Git info/exclude",
      )
    ).toString("base64"),
    globalExcludeBase64: (
      await readRawContent(
        globalExclude,
        access,
        contentCache,
        "Git global excludes file",
      )
    ).toString("base64"),
  };
}

function parseRegularLeaf(value: Record<string, unknown>): V3LeafEntry {
  if (
    !exactKeys(value, ["path", "type", "blobOid", "recreationMode"]) ||
    typeof value.path !== "string" ||
    value.type !== "regular" ||
    !isTreeOid(value.blobOid) ||
    (value.recreationMode !== null &&
      (!isSafeNonnegativeInteger(value.recreationMode) ||
        Number(value.recreationMode) > 0o7777))
  ) {
    return integrity("tree v3 regular leaf has invalid fields");
  }
  return {
    path: value.path,
    type: "regular",
    blobOid: value.blobOid,
    recreationMode:
      value.recreationMode === null ? null : Number(value.recreationMode),
  };
}

function parseSymlinkLeaf(value: Record<string, unknown>): V3LeafEntry {
  if (
    !exactKeys(value, [
      "path",
      "type",
      "targetContentId",
      "targetByteLength",
      "symlinkKind",
    ]) ||
    typeof value.path !== "string" ||
    value.type !== "symlink" ||
    !isTreeOid(value.targetContentId) ||
    !isSafePositiveInteger(value.targetByteLength) ||
    Number(value.targetByteLength) > ABSOLUTE_MAX_TREE_MANIFEST_BYTES ||
    (value.symlinkKind !== null &&
      value.symlinkKind !== "file" &&
      value.symlinkKind !== "directory")
  ) {
    return integrity("tree v3 symlink leaf has invalid fields");
  }
  return {
    path: value.path,
    type: "symlink",
    targetContentId: value.targetContentId,
    targetByteLength: Number(value.targetByteLength),
    symlinkKind: value.symlinkKind as "file" | "directory" | null,
  };
}

function parseLeafEntries(value: unknown): readonly V3LeafEntry[] {
  if (!Array.isArray(value) || value.length === 0) {
    return integrity("tree v3 leaf must contain at least one entry");
  }
  const entries = value.map((candidate) => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      return integrity("tree v3 leaf entry has an invalid shape");
    }
    const record = candidate as Record<string, unknown>;
    return record.type === "regular"
      ? parseRegularLeaf(record)
      : parseSymlinkLeaf(record);
  });
  for (let index = 1; index < entries.length; index += 1) {
    if (compareKeys(entries[index - 1]!.path, entries[index]!.path) >= 0) {
      return integrity("tree v3 leaf keys are not strictly byte-sorted");
    }
  }
  return entries;
}

function parseChildren(value: unknown): readonly V3ChildReference[] {
  if (!Array.isArray(value) || value.length < 2) {
    return integrity("tree v3 internal node must have at least two children");
  }
  const children = value.map((candidate) => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      return integrity("tree v3 child reference has an invalid shape");
    }
    const record = candidate as Record<string, unknown>;
    if (
      !exactKeys(record, ["highKey", "oid", "entryCount"]) ||
      typeof record.highKey !== "string" ||
      !isTreeOid(record.oid) ||
      !isSafePositiveInteger(record.entryCount)
    ) {
      return integrity("tree v3 child reference has invalid fields");
    }
    return {
      highKey: record.highKey,
      oid: record.oid,
      entryCount: Number(record.entryCount),
    };
  });
  for (let index = 1; index < children.length; index += 1) {
    if (
      compareKeys(children[index - 1]!.highKey, children[index]!.highKey) >= 0
    ) {
      return integrity("tree v3 child high keys are not strictly byte-sorted");
    }
  }
  return children;
}

function parseNode(content: Uint8Array): V3NodeDocument {
  const candidate = decodeCanonicalDocument(content, "tree v3 node");
  if (
    candidate.kind !== TREE_V3_NODE_KIND ||
    candidate.version !== TREE_V3_STRUCTURE_VERSION ||
    !isSafeNonnegativeInteger(candidate.level) ||
    Number(candidate.level) > TREE_V3_MAXIMUM_HEIGHT
  ) {
    return integrity("tree v3 node has an invalid header");
  }
  if (candidate.level === 0) {
    if (
      !exactKeys(candidate as Record<string, unknown>, [
        "kind",
        "version",
        "level",
        "entries",
      ])
    ) {
      return integrity("tree v3 leaf has invalid fields");
    }
    const document: V3LeafNodeDocument = {
      kind: TREE_V3_NODE_KIND,
      version: TREE_V3_STRUCTURE_VERSION,
      level: 0,
      entries: parseLeafEntries(candidate.entries),
    };
    requireCanonicalDocument(content, document, "tree v3 leaf");
    return document;
  }
  if (
    !exactKeys(candidate as Record<string, unknown>, [
      "kind",
      "version",
      "level",
      "children",
    ])
  ) {
    return integrity("tree v3 internal node has invalid fields");
  }
  const document: V3InternalNodeDocument = {
    kind: TREE_V3_NODE_KIND,
    version: TREE_V3_STRUCTURE_VERSION,
    level: Number(candidate.level),
    children: parseChildren(candidate.children),
  };
  requireCanonicalDocument(content, document, "tree v3 internal node");
  return document;
}

function sameOidSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const canonicalLeft = [...new Set(left)].sort();
  const canonicalRight = [...new Set(right)].sort();
  return (
    canonicalLeft.length === canonicalRight.length &&
    canonicalLeft.every((oid, index) => oid === canonicalRight[index])
  );
}

async function publishBounded<T>(
  values: readonly T[],
  publish: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const failures: Array<{ readonly index: number; readonly cause: unknown }> =
    [];
  const workers = Array.from(
    {
      length: Math.min(TREE_V3_PUBLICATION_CONCURRENCY, values.length),
    },
    async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        const value = values[index];
        if (value === undefined) return;
        try {
          await publish(value);
        } catch (cause) {
          failures.push({ index, cause });
        }
      }
    },
  );
  await Promise.all(workers);
  const failure = failures.sort((left, right) => left.index - right.index)[0];
  if (failure !== undefined) throw failure.cause;
}

async function readV3Tree(
  treeOid: TreeOid,
  access: StoredTreeReadAccess,
  limits: TreeManifestLimits,
): Promise<AuthenticatedStoredTree> {
  assertTreeManifestLimits(limits);
  if (!isTreeOid(treeOid)) {
    return integrity("tree v3 root has an invalid object id");
  }
  const structuralKinds = new Map<TreeOid, StoredTreeStructuralKind>();
  let remainingStructuralBytes = structuralByteBudget(limits);
  const readStructural = async (
    kind: StoredTreeStructuralKind,
    oid: TreeOid,
  ): Promise<Buffer> => {
    const previousKind = structuralKinds.get(oid);
    if (previousKind !== undefined) {
      return integrity(
        previousKind === kind
          ? "tree v3 reuses one structural object"
          : "tree v3 structural object changes logical kind",
      );
    }
    const maximumBytes = Math.min(
      ABSOLUTE_MAX_TREE_MANIFEST_BYTES,
      remainingStructuralBytes,
    );
    if (maximumBytes <= 0) {
      return integrity("tree v3 structural graph exceeds its byte budget");
    }
    const content = authenticateStoredObject(
      oid,
      await access.readStructuralObject(kind, oid, maximumBytes),
      "tree v3 structural object",
    );
    if (
      content.byteLength > maximumBytes ||
      content.byteLength > remainingStructuralBytes
    ) {
      return integrity("tree v3 structural graph exceeds its byte budget");
    }
    remainingStructuralBytes -= content.byteLength;
    structuralKinds.set(oid, kind);
    return content;
  };

  const root = parseRoot(await readStructural("root", treeOid));
  if (root.entryCount > limits.maxEntries) {
    return integrity(
      `tree v3 has ${root.entryCount} entries, exceeding the ${limits.maxEntries}-entry limit`,
    );
  }
  if ((root.entryCount === 0) !== (root.entryMapRoot === null)) {
    return integrity("tree v3 empty-map root fields disagree");
  }

  const contentCache = new Map<string, Buffer>();
  const scope = await readScope(
    await readStructural("scope", root.scopeOid),
    access,
    contentCache,
    (oid) => readStructural("scope", oid),
  );
  const entries: TreeEntry[] = [];
  const usedNodeOids = new Set<TreeOid>();
  const maximumNodeCount = Math.max(1, root.entryCount * 2);
  let symlinkTargetBytes = 0;

  const visitNode = async (
    oid: TreeOid,
    expectedLevel: number,
    expectedEntryCount: number,
  ): Promise<string> => {
    if (usedNodeOids.has(oid)) {
      return integrity("tree v3 reuses one node at multiple map positions");
    }
    usedNodeOids.add(oid);
    if (usedNodeOids.size > maximumNodeCount) {
      return integrity("tree v3 node graph exceeds its entry-derived bound");
    }
    const document = parseNode(await readStructural("node", oid));
    if (document.level !== expectedLevel) {
      return integrity("tree v3 node level disagrees with its parent");
    }
    if ("entries" in document) {
      if (document.entries.length !== expectedEntryCount) {
        return integrity("tree v3 leaf count disagrees with its parent");
      }
      for (const stored of document.entries) {
        if (stored.type === "regular") {
          entries.push({
            path: stored.path,
            type: "regular",
            blobOid: stored.blobOid,
            recreationMode: stored.recreationMode,
          });
          continue;
        }
        symlinkTargetBytes += stored.targetByteLength;
        if (symlinkTargetBytes > limits.maxManifestBytes) {
          return integrity(
            "tree v3 symlink targets exceed the semantic manifest byte budget",
          );
        }
        const targetBytes = await readRawContent(
          {
            contentId: stored.targetContentId,
            byteLength: stored.targetByteLength,
          },
          access,
          contentCache,
          `symlink target ${JSON.stringify(stored.path)}`,
        );
        let target: string;
        try {
          target = new TextDecoder("utf-8", { fatal: true }).decode(
            targetBytes,
          );
        } catch (error) {
          return integrity("tree v3 symlink target is not valid UTF-8", error);
        }
        entries.push({
          path: stored.path,
          type: "symlink",
          target,
          symlinkKind: stored.symlinkKind,
        });
      }
      return document.entries.at(-1)!.path;
    }

    const declaredCount = document.children.reduce(
      (total, child) => total + child.entryCount,
      0,
    );
    if (
      !Number.isSafeInteger(declaredCount) ||
      declaredCount !== expectedEntryCount
    ) {
      return integrity("tree v3 internal count disagrees with its parent");
    }
    for (const child of document.children) {
      const observedHighKey = await visitNode(
        child.oid,
        expectedLevel - 1,
        child.entryCount,
      );
      if (observedHighKey !== child.highKey) {
        return integrity("tree v3 child high key is not authenticated");
      }
    }
    return document.children.at(-1)!.highKey;
  };

  if (root.entryMapRoot !== null) {
    await visitNode(root.entryMapRoot, root.height, root.entryCount);
  }

  let canonical: TreeManifest;
  try {
    canonical = canonicalV3Manifest(
      { format: TREE_MANIFEST_FORMAT_V3, entries, scope },
      limits,
    );
  } catch (error) {
    return integrity(
      "tree v3 DAG does not materialize a valid manifest",
      error,
    );
  }

  // Rebuilding from the complete semantic map is the canonicality proof. It
  // rejects history-dependent partitions, noncanonical scope factoring, and
  // any root metadata that merely describes a readable but different graph.
  const rebuilt = buildV3Graph(canonical, limits);
  if (
    rebuilt.rootOid !== treeOid ||
    rebuilt.root.height !== root.height ||
    rebuilt.root.entryCount !== root.entryCount ||
    rebuilt.root.entryMapRoot !== root.entryMapRoot ||
    rebuilt.root.scopeOid !== root.scopeOid ||
    !sameOidSet(
      rebuilt.structuralObjects.map(({ oid }) => oid),
      [...structuralKinds.keys()],
    ) ||
    !sameOidSet([...rebuilt.introducedContent.keys()], [...contentCache.keys()])
  ) {
    return integrity(
      "tree v3 DAG is not the canonical rebuild of its manifest",
    );
  }

  const structuralObjectOids = Object.freeze([
    treeOid,
    ...[...structuralKinds.keys()].filter((oid) => oid !== treeOid).sort(),
  ]);
  const contentIds = [...TREE_FORMAT_V3_CURRENT.referencedBlobOids(canonical)];
  const seenContentIds = new Set(contentIds);
  for (const contentId of rebuilt.introducedContent.keys()) {
    if (!seenContentIds.has(contentId)) {
      seenContentIds.add(contentId);
      contentIds.push(contentId);
    }
  }
  return Object.freeze({
    manifest: freezeTreeManifest(canonical),
    structuralObjects: Object.freeze(
      structuralObjectOids.map((oid) =>
        Object.freeze({ kind: structuralKinds.get(oid)!, oid }),
      ),
    ),
    structuralObjectOids,
    contentIds: Object.freeze(contentIds),
  });
}

async function publishV3Tree(
  manifest: TreeManifest,
  access: StoredTreeWriteAccess,
  limits: TreeManifestLimits,
): Promise<TreeOid> {
  const graph = buildV3Graph(manifest, limits);
  await publishBounded([...graph.introducedContent], ([contentId, content]) =>
    access.ensureContent(contentId, content),
  );

  // Every dependency is immutable and unrooted, so it may be published in
  // parallel. The root remains the sole publication barrier and is written
  // only after every referenced object has settled successfully.
  const root = graph.structuralObjects.find(
    (object) => object.kind === "root" && object.oid === graph.rootOid,
  );
  if (root === undefined) {
    throw new Error("canonical tree graph omitted its root object");
  }
  await publishBounded(
    graph.structuralObjects.filter((object) => object !== root),
    (object) =>
      access.publishStructuralObject(object.kind, object.oid, object.bytes),
  );
  await access.publishStructuralObject(root.kind, root.oid, root.bytes);
  return graph.rootOid;
}

export const STORED_TREE_FORMAT_V3 = Object.freeze<StoredTreeFormatAdapter>({
  format: TREE_MANIFEST_FORMAT_V3,
  readAuthenticated(treeOid, access, limits = ABSOLUTE_TREE_MANIFEST_LIMITS) {
    return readV3Tree(treeOid, access, limits);
  },
  publish(manifest, access, limits = ABSOLUTE_TREE_MANIFEST_LIMITS) {
    return publishV3Tree(manifest, access, limits);
  },
});
