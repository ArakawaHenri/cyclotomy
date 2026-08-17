import { createHash } from "node:crypto";

import {
  CanonicalBinaryError,
  CanonicalReader,
  CanonicalWriter,
} from "./canonical-binary.ts";
import {
  FASTCDC_V1_PROFILE,
  FastCdcV1StreamBuilder,
  chunkFastCdcV1,
  type FastCdcChunk,
  type FastCdcStreamChunk,
} from "./fastcdc.ts";
import {
  contentIdFromBytes,
  contentIdFromDigestBytes,
  idToBytes,
  parseContentId,
  parseRecipeId,
  recipeIdFromCanonicalBytes,
  recipeIdFromDigestBytes,
  SHA256_BYTE_LENGTH,
  type ContentId,
  type RecipeId,
} from "./ids.ts";

const ROOT_MAGIC = Uint8Array.of(0x43, 0x59, 0x52, 0x52); // CYRR
const NODE_MAGIC = Uint8Array.of(0x43, 0x59, 0x52, 0x4e); // CYRN
const RECIPE_FORMAT_VERSION = 1;
const FASTCDC_V1_PROFILE_CODE = 1;
const LEAF_NODE_CODE = 1;
const BRANCH_NODE_CODE = 2;
const CONTENT_REFERENCE_CODE = 1;
const RECIPE_REFERENCE_CODE = 2;
const MAX_LEAF_REFERENCES = 768;
const MAX_BRANCH_REFERENCES = 480;

/**
 * Files no larger than 64 KiB always use a full representation. Larger files
 * are FastCDC candidates, but a candidate that produces one chunk still uses
 * that chunk as its full top-level representation.
 */
export const CHUNKED_CONTENT_MIN_BYTES = 64 * 1024 + 1;
export const MAX_RECIPE_OBJECT_BYTES = 32 * 1024;
export const MAX_RECIPE_DEPTH = 8;

export interface ContentChunkReference {
  readonly kind: "content";
  readonly contentId: ContentId;
  readonly decodedLength: number;
}

export interface ChildRecipeReference {
  readonly kind: "recipe";
  readonly recipeId: RecipeId;
  readonly decodedLength: number;
  readonly depth: number;
  readonly nodeCount: number;
  readonly chunkCount: number;
}

export interface LeafRecipeNode {
  readonly kind: "leaf";
  readonly decodedLength: number;
  readonly depth: 1;
  readonly nodeCount: 1;
  readonly chunkCount: number;
  readonly chunks: readonly ContentChunkReference[];
}

export interface BranchRecipeNode {
  readonly kind: "branch";
  readonly decodedLength: number;
  readonly depth: number;
  readonly nodeCount: number;
  readonly chunkCount: number;
  readonly children: readonly ChildRecipeReference[];
}

export type RecipeNode = LeafRecipeNode | BranchRecipeNode;

export interface RecipeRoot {
  readonly kind: "root";
  readonly profile: typeof FASTCDC_V1_PROFILE.id;
  readonly contentId: ContentId;
  readonly decodedLength: number;
  readonly depth: number;
  readonly nodeCount: number;
  readonly chunkCount: number;
  readonly child: ChildRecipeReference;
}

export interface CanonicalRecipeObject {
  readonly recipeId: RecipeId;
  readonly bytes: Uint8Array;
  readonly value: RecipeRoot | RecipeNode;
}

export interface ChunkRecipePlan {
  readonly rootId: RecipeId;
  readonly root: RecipeRoot;
  /** Unique objects in children-before-parents publication order. */
  readonly objects: readonly CanonicalRecipeObject[];
}

export interface RecipeGraphLimits {
  readonly maxChunks: number;
  readonly maxDecodedBytes: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
}

export interface ExpectedChunkedContent {
  readonly contentId: ContentId;
  readonly decodedLength: number;
}

/**
 * Authenticated recipe structure only. The referenced content records are not
 * read here; callers must require a non-chunked terminal representation and
 * hash the ordered reconstructed bytes against `contentId` before trusting the
 * content. The repository currently admits authenticated raw, zstd, or
 * one-hop delta terminals and rejects another chunk recipe at a leaf.
 */
export interface AuthenticatedChunkRecipeGraph {
  readonly contentId: ContentId;
  readonly decodedLength: number;
  readonly chunks: readonly ContentChunkReference[];
  readonly recipeIds: readonly RecipeId[];
}

export type RecipeObjectReader = (recipeId: RecipeId) => Promise<Uint8Array>;

export interface ContentChunkCandidate extends FastCdcStreamChunk {
  readonly contentId: ContentId;
}

export type ContentChunkSink = (
  chunk: ContentChunkCandidate,
) => void | Promise<void>;

export type RecipeObjectSink = (
  object: CanonicalRecipeObject,
) => void | Promise<void>;

export interface ChunkedContentPlanSinks {
  /** Must durably publish a full raw/zstd content representation. */
  readonly content: ContentChunkSink;
  /** Receives dependency-first recipe nodes and finally the root. */
  readonly recipe: RecipeObjectSink;
}

export interface ChunkedContentPlanResult {
  readonly kind: "chunked";
  readonly contentId: ContentId;
  readonly decodedLength: number;
  readonly rootId: RecipeId;
  readonly root: RecipeRoot;
}

export interface FullContentPlanResult {
  readonly kind: "full";
  readonly contentId: ContentId;
  readonly decodedLength: number;
  readonly chunk: ContentChunkReference;
}

export type ContentRepresentationPlanResult =
  FullContentPlanResult | ChunkedContentPlanResult;

function assertSafeLength(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CanonicalBinaryError(
      "invalid-integer",
      `${label} must be a non-negative safe integer`,
    );
  }
}

function assertPositiveLength(value: number, label: string): void {
  assertSafeLength(value, label);
  if (value === 0) {
    throw new CanonicalBinaryError(
      "unexpected-value",
      `${label} must be positive`,
    );
  }
}

function checkedAdd(left: number, right: number, label: string): number {
  if (right > Number.MAX_SAFE_INTEGER - left) {
    throw new CanonicalBinaryError(
      "invalid-integer",
      `${label} exceeds the maximum safe integer`,
    );
  }
  return left + right;
}

function assertLimits(limits: RecipeGraphLimits): void {
  assertSafeLength(limits.maxChunks, "maximum chunk count");
  assertSafeLength(limits.maxDecodedBytes, "maximum decoded bytes");
  assertSafeLength(limits.maxDepth, "maximum recipe depth");
  assertSafeLength(limits.maxNodes, "maximum recipe node count");
}

function assertWithinLimits(
  decodedLength: number,
  depth: number,
  nodeCount: number,
  chunkCount: number,
  limits: RecipeGraphLimits,
): void {
  if (decodedLength > limits.maxDecodedBytes) {
    throw new CanonicalBinaryError(
      "limit-exceeded",
      `recipe decoded length ${decodedLength} exceeds the ${limits.maxDecodedBytes}-byte limit`,
    );
  }
  if (depth > Math.min(limits.maxDepth, MAX_RECIPE_DEPTH)) {
    throw new CanonicalBinaryError(
      "limit-exceeded",
      `recipe depth ${depth} exceeds the supported limit`,
    );
  }
  if (nodeCount > limits.maxNodes) {
    throw new CanonicalBinaryError(
      "limit-exceeded",
      `recipe node count ${nodeCount} exceeds the ${limits.maxNodes}-node limit`,
    );
  }
  if (chunkCount > limits.maxChunks) {
    throw new CanonicalBinaryError(
      "limit-exceeded",
      `recipe chunk count ${chunkCount} exceeds the ${limits.maxChunks}-chunk limit`,
    );
  }
}

function freezeContentReference(
  reference: ContentChunkReference,
): ContentChunkReference {
  return Object.freeze({
    kind: "content",
    contentId: parseContentId(reference.contentId),
    decodedLength: reference.decodedLength,
  });
}

function freezeRecipeReference(
  reference: ChildRecipeReference,
): ChildRecipeReference {
  return Object.freeze({
    kind: "recipe",
    recipeId: parseRecipeId(reference.recipeId),
    decodedLength: reference.decodedLength,
    depth: reference.depth,
    nodeCount: reference.nodeCount,
    chunkCount: reference.chunkCount,
  });
}

function summarizeLeaf(
  references: readonly ContentChunkReference[],
): LeafRecipeNode {
  if (references.length === 0 || references.length > MAX_LEAF_REFERENCES) {
    throw new CanonicalBinaryError(
      "limit-exceeded",
      `leaf recipe must contain 1 to ${MAX_LEAF_REFERENCES} references`,
    );
  }
  let decodedLength = 0;
  const chunks = references.map((reference) => {
    const owned = freezeContentReference(reference);
    assertPositiveLength(owned.decodedLength, "chunk decoded length");
    if (owned.decodedLength > FASTCDC_V1_PROFILE.maximumBytes) {
      throw new CanonicalBinaryError(
        "unexpected-value",
        `chunk length exceeds ${FASTCDC_V1_PROFILE.maximumBytes} bytes`,
      );
    }
    decodedLength = checkedAdd(
      decodedLength,
      owned.decodedLength,
      "leaf decoded length",
    );
    return owned;
  });
  return Object.freeze({
    kind: "leaf",
    decodedLength,
    depth: 1,
    nodeCount: 1,
    chunkCount: chunks.length,
    chunks: Object.freeze(chunks),
  });
}

function summarizeBranch(
  references: readonly ChildRecipeReference[],
): BranchRecipeNode {
  if (references.length === 0 || references.length > MAX_BRANCH_REFERENCES) {
    throw new CanonicalBinaryError(
      "limit-exceeded",
      `branch recipe must contain 1 to ${MAX_BRANCH_REFERENCES} references`,
    );
  }
  let decodedLength = 0;
  let childNodeCount = 0;
  let chunkCount = 0;
  let childDepth = 0;
  const children = references.map((reference) => {
    const owned = freezeRecipeReference(reference);
    assertPositiveLength(owned.decodedLength, "child recipe decoded length");
    assertPositiveLength(owned.depth, "child recipe depth");
    assertPositiveLength(owned.nodeCount, "child recipe node count");
    assertPositiveLength(owned.chunkCount, "child recipe chunk count");
    decodedLength = checkedAdd(
      decodedLength,
      owned.decodedLength,
      "branch decoded length",
    );
    childNodeCount = checkedAdd(
      childNodeCount,
      owned.nodeCount,
      "branch node count",
    );
    chunkCount = checkedAdd(chunkCount, owned.chunkCount, "branch chunk count");
    childDepth = Math.max(childDepth, owned.depth);
    return owned;
  });
  const depth = childDepth + 1;
  if (depth >= MAX_RECIPE_DEPTH) {
    throw new CanonicalBinaryError(
      "limit-exceeded",
      `branch recipe depth must be below ${MAX_RECIPE_DEPTH}`,
    );
  }
  return Object.freeze({
    kind: "branch",
    decodedLength,
    depth,
    nodeCount: checkedAdd(1, childNodeCount, "branch node count"),
    chunkCount,
    children: Object.freeze(children),
  });
}

function referenceFor(
  recipeId: RecipeId,
  node: RecipeNode,
): ChildRecipeReference {
  return freezeRecipeReference({
    kind: "recipe",
    recipeId,
    decodedLength: node.decodedLength,
    depth: node.depth,
    nodeCount: node.nodeCount,
    chunkCount: node.chunkCount,
  });
}

function writeRecipeReference(
  writer: CanonicalWriter,
  reference: ChildRecipeReference,
): void {
  writer
    .writeByte(RECIPE_REFERENCE_CODE)
    .writeBytes(idToBytes(reference.recipeId))
    .writeVarint(reference.decodedLength)
    .writeVarint(reference.depth)
    .writeVarint(reference.nodeCount)
    .writeVarint(reference.chunkCount);
}

function readRecipeReference(reader: CanonicalReader): ChildRecipeReference {
  const kind = reader.readByte("recipe reference kind");
  if (kind !== RECIPE_REFERENCE_CODE) {
    throw new CanonicalBinaryError(
      "unexpected-value",
      `expected child-recipe reference code ${RECIPE_REFERENCE_CODE}; received ${kind}`,
    );
  }
  const reference = freezeRecipeReference({
    kind: "recipe",
    recipeId: recipeIdFromDigestBytes(
      reader.readBytes(SHA256_BYTE_LENGTH, "child recipe id"),
    ),
    decodedLength: reader.readVarint("child recipe decoded length"),
    depth: reader.readVarint("child recipe depth"),
    nodeCount: reader.readVarint("child recipe node count"),
    chunkCount: reader.readVarint("child recipe chunk count"),
  });
  assertPositiveLength(reference.decodedLength, "child recipe decoded length");
  assertPositiveLength(reference.depth, "child recipe depth");
  assertPositiveLength(reference.nodeCount, "child recipe node count");
  assertPositiveLength(reference.chunkCount, "child recipe chunk count");
  return reference;
}

function assertObjectSize(encoded: Uint8Array): void {
  if (encoded.byteLength > MAX_RECIPE_OBJECT_BYTES) {
    throw new CanonicalBinaryError(
      "limit-exceeded",
      `recipe object is ${encoded.byteLength} bytes; limit is ${MAX_RECIPE_OBJECT_BYTES}`,
    );
  }
}

export function encodeRecipeNode(node: RecipeNode): Uint8Array {
  const canonical =
    node.kind === "leaf"
      ? summarizeLeaf(node.chunks)
      : summarizeBranch(node.children);
  if (
    canonical.decodedLength !== node.decodedLength ||
    canonical.depth !== node.depth ||
    canonical.nodeCount !== node.nodeCount ||
    canonical.chunkCount !== node.chunkCount
  ) {
    throw new CanonicalBinaryError(
      "non-canonical",
      "recipe node summary does not match its references",
    );
  }
  const writer = new CanonicalWriter()
    .writeBytes(NODE_MAGIC)
    .writeByte(RECIPE_FORMAT_VERSION)
    .writeByte(node.kind === "leaf" ? LEAF_NODE_CODE : BRANCH_NODE_CODE)
    .writeVarint(node.decodedLength);
  if (node.kind === "leaf") {
    writer.writeVarint(node.chunks.length);
    for (const chunk of node.chunks) {
      writer
        .writeByte(CONTENT_REFERENCE_CODE)
        .writeBytes(idToBytes(chunk.contentId))
        .writeVarint(chunk.decodedLength);
    }
  } else {
    writer.writeVarint(node.children.length);
    for (const child of node.children) {
      writeRecipeReference(writer, child);
    }
  }
  const encoded = writer.finish();
  assertObjectSize(encoded);
  return encoded;
}

export function decodeRecipeNode(
  encoded: Uint8Array,
  limits: RecipeGraphLimits,
): RecipeNode {
  assertLimits(limits);
  assertObjectSize(encoded);
  const reader = new CanonicalReader(encoded);
  reader.expectBytes(NODE_MAGIC, "recipe node magic");
  const version = reader.readByte("recipe node version");
  if (version !== RECIPE_FORMAT_VERSION) {
    throw new CanonicalBinaryError(
      "unexpected-value",
      `unsupported recipe node version ${version}`,
    );
  }
  const kind = reader.readByte("recipe node kind");
  const claimedDecodedLength = reader.readVarint("recipe node decoded length");
  if (claimedDecodedLength > limits.maxDecodedBytes) {
    throw new CanonicalBinaryError(
      "limit-exceeded",
      "recipe node decoded length exceeds its limit",
    );
  }
  const referenceCount = reader.readVarint("recipe reference count");

  let node: RecipeNode;
  if (kind === LEAF_NODE_CODE) {
    if (referenceCount > Math.min(MAX_LEAF_REFERENCES, limits.maxChunks)) {
      throw new CanonicalBinaryError(
        "limit-exceeded",
        "leaf recipe reference count exceeds its limit",
      );
    }
    const chunks: ContentChunkReference[] = [];
    for (let index = 0; index < referenceCount; index += 1) {
      const referenceKind = reader.readByte(`chunk ${index} reference kind`);
      if (referenceKind !== CONTENT_REFERENCE_CODE) {
        throw new CanonicalBinaryError(
          "unexpected-value",
          `expected full-content reference code ${CONTENT_REFERENCE_CODE}; received ${referenceKind}`,
        );
      }
      chunks.push({
        kind: "content",
        contentId: contentIdFromDigestBytes(
          reader.readBytes(SHA256_BYTE_LENGTH, `chunk ${index} content id`),
        ),
        decodedLength: reader.readVarint(`chunk ${index} decoded length`),
      });
    }
    node = summarizeLeaf(chunks);
  } else if (kind === BRANCH_NODE_CODE) {
    if (referenceCount > Math.min(MAX_BRANCH_REFERENCES, limits.maxNodes)) {
      throw new CanonicalBinaryError(
        "limit-exceeded",
        "branch recipe reference count exceeds its limit",
      );
    }
    const children: ChildRecipeReference[] = [];
    for (let index = 0; index < referenceCount; index += 1) {
      children.push(readRecipeReference(reader));
    }
    node = summarizeBranch(children);
  } else {
    throw new CanonicalBinaryError(
      "unexpected-value",
      `unknown recipe node kind ${kind}`,
    );
  }
  reader.assertEnd();
  if (node.decodedLength !== claimedDecodedLength) {
    throw new CanonicalBinaryError(
      "non-canonical",
      `recipe node references total ${node.decodedLength}; header claims ${claimedDecodedLength}`,
    );
  }
  assertWithinLimits(
    node.decodedLength,
    node.depth,
    node.nodeCount,
    node.chunkCount,
    limits,
  );
  return node;
}

export function encodeRecipeRoot(root: RecipeRoot): Uint8Array {
  parseContentId(root.contentId);
  const child = freezeRecipeReference(root.child);
  const expectedDepth = child.depth + 1;
  const expectedNodes = checkedAdd(1, child.nodeCount, "root node count");
  if (
    root.profile !== FASTCDC_V1_PROFILE.id ||
    root.decodedLength !== child.decodedLength ||
    root.depth !== expectedDepth ||
    root.nodeCount !== expectedNodes ||
    root.chunkCount !== child.chunkCount
  ) {
    throw new CanonicalBinaryError(
      "non-canonical",
      "recipe root summary does not match its child",
    );
  }
  if (root.decodedLength < CHUNKED_CONTENT_MIN_BYTES || root.chunkCount < 2) {
    throw new CanonicalBinaryError(
      "unexpected-value",
      "chunked content must exceed 64 KiB and reference at least two chunks",
    );
  }
  if (root.depth > MAX_RECIPE_DEPTH) {
    throw new CanonicalBinaryError(
      "limit-exceeded",
      `recipe root depth exceeds ${MAX_RECIPE_DEPTH}`,
    );
  }
  const writer = new CanonicalWriter()
    .writeBytes(ROOT_MAGIC)
    .writeByte(RECIPE_FORMAT_VERSION)
    .writeByte(FASTCDC_V1_PROFILE_CODE)
    .writeBytes(idToBytes(root.contentId))
    .writeVarint(root.decodedLength);
  writeRecipeReference(writer, child);
  const encoded = writer.finish();
  assertObjectSize(encoded);
  return encoded;
}

export function decodeRecipeRoot(
  encoded: Uint8Array,
  limits: RecipeGraphLimits,
): RecipeRoot {
  assertLimits(limits);
  assertObjectSize(encoded);
  const reader = new CanonicalReader(encoded);
  reader.expectBytes(ROOT_MAGIC, "recipe root magic");
  const version = reader.readByte("recipe root version");
  if (version !== RECIPE_FORMAT_VERSION) {
    throw new CanonicalBinaryError(
      "unexpected-value",
      `unsupported recipe root version ${version}`,
    );
  }
  const profile = reader.readByte("recipe profile");
  if (profile !== FASTCDC_V1_PROFILE_CODE) {
    throw new CanonicalBinaryError(
      "unexpected-value",
      `unsupported recipe profile code ${profile}`,
    );
  }
  const contentId = contentIdFromDigestBytes(
    reader.readBytes(SHA256_BYTE_LENGTH, "recipe root content id"),
  );
  const claimedDecodedLength = reader.readVarint("recipe root decoded length");
  const child = readRecipeReference(reader);
  reader.assertEnd();
  const root = Object.freeze({
    kind: "root",
    profile: FASTCDC_V1_PROFILE.id,
    contentId,
    decodedLength: child.decodedLength,
    depth: child.depth + 1,
    nodeCount: checkedAdd(1, child.nodeCount, "root node count"),
    chunkCount: child.chunkCount,
    child,
  } as const);
  if (root.decodedLength !== claimedDecodedLength) {
    throw new CanonicalBinaryError(
      "non-canonical",
      `recipe child covers ${root.decodedLength} bytes; root claims ${claimedDecodedLength}`,
    );
  }
  if (root.decodedLength < CHUNKED_CONTENT_MIN_BYTES || root.chunkCount < 2) {
    throw new CanonicalBinaryError(
      "unexpected-value",
      "chunked content must exceed 64 KiB and reference at least two chunks",
    );
  }
  assertWithinLimits(
    root.decodedLength,
    root.depth,
    root.nodeCount,
    root.chunkCount,
    limits,
  );
  return root;
}

function canonicalObject(
  value: RecipeNode | RecipeRoot,
): CanonicalRecipeObject {
  const bytes =
    value.kind === "root" ? encodeRecipeRoot(value) : encodeRecipeNode(value);
  return Object.freeze({
    recipeId: recipeIdFromCanonicalBytes(bytes),
    bytes,
    value,
  });
}

function validateContentReferences(
  references: readonly ContentChunkReference[],
  decodedLength: number,
): void {
  if (references.length < 2) {
    throw new CanonicalBinaryError(
      "unexpected-value",
      "chunked content must reference at least two content objects",
    );
  }
  let total = 0;
  for (let index = 0; index < references.length; index += 1) {
    const reference = references[index];
    if (reference === undefined) {
      throw new CanonicalBinaryError("truncated", "missing content reference");
    }
    parseContentId(reference.contentId);
    assertPositiveLength(reference.decodedLength, "chunk decoded length");
    if (
      reference.decodedLength > FASTCDC_V1_PROFILE.maximumBytes ||
      (index < references.length - 1 &&
        reference.decodedLength < FASTCDC_V1_PROFILE.minimumBytes)
    ) {
      throw new CanonicalBinaryError(
        "unexpected-value",
        "chunk sizes do not satisfy the fastcdc-v1 profile",
      );
    }
    total = checkedAdd(
      total,
      reference.decodedLength,
      "content decoded length",
    );
  }
  if (total !== decodedLength) {
    throw new CanonicalBinaryError(
      "unexpected-value",
      `chunk references total ${total}; expected ${decodedLength}`,
    );
  }
}

export function buildChunkRecipePlan(
  contentId: ContentId,
  decodedLength: number,
  chunks: readonly ContentChunkReference[],
  limits: RecipeGraphLimits,
): ChunkRecipePlan {
  assertLimits(limits);
  parseContentId(contentId);
  assertSafeLength(decodedLength, "content decoded length");
  if (decodedLength < CHUNKED_CONTENT_MIN_BYTES) {
    throw new CanonicalBinaryError(
      "unexpected-value",
      `chunked content must be at least ${CHUNKED_CONTENT_MIN_BYTES} bytes`,
    );
  }
  validateContentReferences(chunks, decodedLength);
  if (chunks.length > limits.maxChunks) {
    throw new CanonicalBinaryError(
      "limit-exceeded",
      "chunk count exceeds the build limit",
    );
  }

  const uniqueObjects = new Map<RecipeId, CanonicalRecipeObject>();
  let references: ChildRecipeReference[] = [];
  for (let offset = 0; offset < chunks.length; offset += MAX_LEAF_REFERENCES) {
    const node = summarizeLeaf(
      chunks.slice(offset, offset + MAX_LEAF_REFERENCES),
    );
    const object = canonicalObject(node);
    uniqueObjects.set(object.recipeId, object);
    references.push(referenceFor(object.recipeId, node));
  }
  while (references.length > 1) {
    const parents: ChildRecipeReference[] = [];
    for (
      let offset = 0;
      offset < references.length;
      offset += MAX_BRANCH_REFERENCES
    ) {
      const node = summarizeBranch(
        references.slice(offset, offset + MAX_BRANCH_REFERENCES),
      );
      const object = canonicalObject(node);
      uniqueObjects.set(object.recipeId, object);
      parents.push(referenceFor(object.recipeId, node));
    }
    references = parents;
  }
  const child = references[0];
  if (child === undefined) {
    throw new CanonicalBinaryError(
      "truncated",
      "recipe plan has no root child",
    );
  }
  const root = Object.freeze({
    kind: "root",
    profile: FASTCDC_V1_PROFILE.id,
    contentId,
    decodedLength,
    depth: child.depth + 1,
    nodeCount: checkedAdd(1, child.nodeCount, "root node count"),
    chunkCount: child.chunkCount,
    child,
  } as const);
  assertWithinLimits(
    root.decodedLength,
    root.depth,
    root.nodeCount,
    root.chunkCount,
    limits,
  );
  const rootObject = canonicalObject(root);
  uniqueObjects.set(rootObject.recipeId, rootObject);
  return Object.freeze({
    rootId: rootObject.recipeId,
    root,
    objects: Object.freeze([...uniqueObjects.values()]),
  });
}

function assertAuthenticatedRecipeObject(
  expectedId: RecipeId,
  bytes: Uint8Array,
): void {
  if (recipeIdFromCanonicalBytes(bytes) !== expectedId) {
    throw new CanonicalBinaryError(
      "unexpected-value",
      `recipe bytes do not match id ${expectedId}`,
    );
  }
}

export async function authenticateChunkRecipeGraph(
  rootId: RecipeId,
  expected: ExpectedChunkedContent,
  readObject: RecipeObjectReader,
  limits: RecipeGraphLimits,
): Promise<AuthenticatedChunkRecipeGraph> {
  assertLimits(limits);
  parseRecipeId(rootId);
  parseContentId(expected.contentId);
  assertSafeLength(expected.decodedLength, "expected decoded length");
  if (expected.decodedLength < CHUNKED_CONTENT_MIN_BYTES) {
    throw new CanonicalBinaryError(
      "unexpected-value",
      `chunked content must be at least ${CHUNKED_CONTENT_MIN_BYTES} bytes`,
    );
  }
  if (expected.decodedLength > limits.maxDecodedBytes) {
    throw new CanonicalBinaryError(
      "limit-exceeded",
      "expected decoded length exceeds the recipe graph limit",
    );
  }
  const rootBytes = Uint8Array.from(await readObject(rootId));
  assertAuthenticatedRecipeObject(rootId, rootBytes);
  const root = decodeRecipeRoot(rootBytes, limits);
  if (root.contentId !== expected.contentId) {
    throw new CanonicalBinaryError(
      "unexpected-value",
      "recipe root is bound to a different content id",
    );
  }
  if (root.decodedLength !== expected.decodedLength) {
    throw new CanonicalBinaryError(
      "unexpected-value",
      "recipe root is bound to a different decoded length",
    );
  }

  const decodedCache = new Map<RecipeId, RecipeNode>();
  const active = new Set<RecipeId>();
  const recipeIds = new Set<RecipeId>([rootId]);
  let visitedNodes = 1;

  interface VisitResult {
    readonly chunks: readonly ContentChunkReference[];
    readonly decodedLength: number;
    readonly depth: number;
    readonly nodeCount: number;
    readonly chunkCount: number;
  }

  const visit = async (
    reference: ChildRecipeReference,
  ): Promise<VisitResult> => {
    visitedNodes += 1;
    if (visitedNodes > limits.maxNodes) {
      throw new CanonicalBinaryError(
        "limit-exceeded",
        "recipe traversal exceeded its node limit",
      );
    }
    if (active.has(reference.recipeId)) {
      throw new CanonicalBinaryError(
        "unexpected-value",
        `recipe graph contains a cycle at ${reference.recipeId}`,
      );
    }
    active.add(reference.recipeId);
    recipeIds.add(reference.recipeId);
    try {
      let node = decodedCache.get(reference.recipeId);
      if (node === undefined) {
        const bytes = Uint8Array.from(await readObject(reference.recipeId));
        assertAuthenticatedRecipeObject(reference.recipeId, bytes);
        node = decodeRecipeNode(bytes, limits);
        decodedCache.set(reference.recipeId, node);
      }
      if (
        node.decodedLength !== reference.decodedLength ||
        node.depth !== reference.depth ||
        node.nodeCount !== reference.nodeCount ||
        node.chunkCount !== reference.chunkCount
      ) {
        throw new CanonicalBinaryError(
          "unexpected-value",
          `recipe reference summary does not match ${reference.recipeId}`,
        );
      }
      if (node.kind === "leaf") {
        return {
          chunks: node.chunks,
          decodedLength: node.decodedLength,
          depth: 1,
          nodeCount: 1,
          chunkCount: node.chunkCount,
        };
      }

      const chunks: ContentChunkReference[] = [];
      let decodedLength = 0;
      let nodeCount = 1;
      let chunkCount = 0;
      let childDepth = 0;
      for (const child of node.children) {
        const childResult = await visit(child);
        decodedLength = checkedAdd(
          decodedLength,
          childResult.decodedLength,
          "verified branch decoded length",
        );
        nodeCount = checkedAdd(
          nodeCount,
          childResult.nodeCount,
          "verified branch node count",
        );
        chunkCount = checkedAdd(
          chunkCount,
          childResult.chunkCount,
          "verified branch chunk count",
        );
        childDepth = Math.max(childDepth, childResult.depth);
        if (childResult.chunks.length > limits.maxChunks - chunks.length) {
          throw new CanonicalBinaryError(
            "limit-exceeded",
            "recipe traversal exceeded its chunk limit",
          );
        }
        for (const chunk of childResult.chunks) chunks.push(chunk);
      }
      const result = {
        chunks: Object.freeze(chunks),
        decodedLength,
        depth: childDepth + 1,
        nodeCount,
        chunkCount,
      };
      if (
        result.decodedLength !== node.decodedLength ||
        result.depth !== node.depth ||
        result.nodeCount !== node.nodeCount ||
        result.chunkCount !== node.chunkCount
      ) {
        throw new CanonicalBinaryError(
          "unexpected-value",
          `verified recipe closure does not match ${reference.recipeId}`,
        );
      }
      return result;
    } finally {
      active.delete(reference.recipeId);
    }
  };

  const child = await visit(root.child);
  const chunks = Array.from(child.chunks);
  validateContentReferences(chunks, root.decodedLength);
  if (
    child.depth + 1 !== root.depth ||
    child.nodeCount + 1 !== root.nodeCount ||
    child.chunkCount !== root.chunkCount ||
    visitedNodes !== root.nodeCount
  ) {
    throw new CanonicalBinaryError(
      "unexpected-value",
      "verified recipe graph does not match its root summary",
    );
  }
  return Object.freeze({
    contentId: root.contentId,
    decodedLength: root.decodedLength,
    chunks: Object.freeze(chunks),
    recipeIds: Object.freeze([...recipeIds]),
  });
}

export function describeChunkedContent(
  input: Uint8Array,
  limits: RecipeGraphLimits,
): ChunkRecipePlan & { readonly chunks: readonly FastCdcChunk[] } {
  if (input.byteLength < CHUNKED_CONTENT_MIN_BYTES) {
    throw new RangeError(
      `chunked content must be at least ${CHUNKED_CONTENT_MIN_BYTES} bytes`,
    );
  }
  const boundaries = chunkFastCdcV1(input);
  if (boundaries.length < 2) {
    throw new RangeError(
      "content produces one FastCDC chunk and must use a full representation",
    );
  }
  const references = boundaries.map((chunk) => ({
    kind: "content" as const,
    contentId: contentIdFromBytes(
      input.subarray(chunk.offset, chunk.offset + chunk.length),
    ),
    decodedLength: chunk.length,
  }));
  const plan = buildChunkRecipePlan(
    contentIdFromBytes(input),
    input.byteLength,
    references,
    limits,
  );
  return Object.freeze({ ...plan, chunks: boundaries });
}

/**
 * Streaming representation-plan builder. Full chunks and dependency-first
 * recipe objects are emitted with backpressure; only one chunk plus one
 * bounded accumulator per recipe level remains resident.
 */
export class ChunkedContentPlanBuilder {
  readonly #expectedDecodedLength: number;
  readonly #limits: RecipeGraphLimits;
  readonly #contentHash = createHash("sha256");
  readonly #sinks: ChunkedContentPlanSinks;
  readonly #leafReferences: ContentChunkReference[] = [];
  readonly #branchLevels: ChildRecipeReference[][] = [];
  readonly #chunker: FastCdcV1StreamBuilder;
  #observedDecodedLength = 0;
  #chunkCount = 0;
  #emittedNodeCount = 0;
  #active = false;
  #settled = false;

  constructor(
    expectedDecodedLength: number,
    limits: RecipeGraphLimits,
    sinks: ChunkedContentPlanSinks,
  ) {
    assertLimits(limits);
    assertSafeLength(expectedDecodedLength, "expected decoded length");
    if (expectedDecodedLength < CHUNKED_CONTENT_MIN_BYTES) {
      throw new RangeError(
        `FastCDC candidates must be at least ${CHUNKED_CONTENT_MIN_BYTES} bytes`,
      );
    }
    if (expectedDecodedLength > limits.maxDecodedBytes) {
      throw new RangeError("expected decoded length exceeds the build limit");
    }
    this.#expectedDecodedLength = expectedDecodedLength;
    this.#limits = limits;
    this.#sinks = sinks;
    this.#chunker = new FastCdcV1StreamBuilder(async (chunk) => {
      if (this.#chunkCount >= this.#limits.maxChunks) {
        throw new CanonicalBinaryError(
          "limit-exceeded",
          "streaming chunk count exceeds the build limit",
        );
      }
      const contentId = contentIdFromBytes(chunk.bytes);
      await this.#sinks.content(Object.freeze({ ...chunk, contentId }));
      this.#chunkCount += 1;
      this.#leafReferences.push(
        freezeContentReference({
          kind: "content",
          contentId,
          decodedLength: chunk.length,
        }),
      );
      if (this.#leafReferences.length === MAX_LEAF_REFERENCES) {
        await this.#flushLeaf();
      }
    });
  }

  async push(input: Uint8Array): Promise<void> {
    this.#begin("push");
    try {
      if (
        input.byteLength >
        this.#expectedDecodedLength - this.#observedDecodedLength
      ) {
        throw new RangeError("streamed content exceeds its expected length");
      }
      this.#contentHash.update(input);
      this.#observedDecodedLength += input.byteLength;
      await this.#chunker.push(input);
    } catch (error) {
      this.#settled = true;
      throw error;
    } finally {
      this.#active = false;
    }
  }

  async finish(): Promise<ContentRepresentationPlanResult> {
    this.#begin("finish");
    try {
      if (this.#observedDecodedLength !== this.#expectedDecodedLength) {
        throw new RangeError(
          `streamed ${this.#observedDecodedLength} bytes; expected ${this.#expectedDecodedLength}`,
        );
      }
      await this.#chunker.finish();
      const contentId = contentIdFromDigestBytes(this.#contentHash.digest());
      if (this.#chunkCount === 1) {
        const chunk = this.#leafReferences[0];
        if (
          chunk === undefined ||
          this.#leafReferences.length !== 1 ||
          this.#emittedNodeCount !== 0 ||
          chunk.contentId !== contentId ||
          chunk.decodedLength !== this.#observedDecodedLength
        ) {
          throw new CanonicalBinaryError(
            "non-canonical",
            "single FastCDC chunk does not match the complete content",
          );
        }
        this.#settled = true;
        return Object.freeze({
          kind: "full",
          contentId,
          decodedLength: this.#observedDecodedLength,
          chunk,
        });
      }
      if (this.#chunkCount < 2) {
        throw new CanonicalBinaryError(
          "truncated",
          "chunking candidate produced no content",
        );
      }
      const child = await this.#finishNodeHierarchy();
      const root = Object.freeze({
        kind: "root",
        profile: FASTCDC_V1_PROFILE.id,
        contentId,
        decodedLength: this.#observedDecodedLength,
        depth: child.depth + 1,
        nodeCount: checkedAdd(1, child.nodeCount, "root node count"),
        chunkCount: child.chunkCount,
        child,
      } as const);
      if (
        root.chunkCount !== this.#chunkCount ||
        root.nodeCount !== this.#emittedNodeCount + 1
      ) {
        throw new CanonicalBinaryError(
          "non-canonical",
          "streamed recipe summary does not match emitted dependencies",
        );
      }
      assertWithinLimits(
        root.decodedLength,
        root.depth,
        root.nodeCount,
        root.chunkCount,
        this.#limits,
      );
      const rootObject = canonicalObject(root);
      await this.#sinks.recipe(rootObject);
      this.#settled = true;
      return Object.freeze({
        kind: "chunked",
        contentId,
        decodedLength: root.decodedLength,
        rootId: rootObject.recipeId,
        root,
      });
    } catch (error) {
      this.#settled = true;
      throw error;
    } finally {
      this.#active = false;
    }
  }

  #begin(operation: "push" | "finish"): void {
    if (this.#active) {
      throw new Error(
        `cannot ${operation} while another builder call is active`,
      );
    }
    if (this.#settled) {
      throw new Error(`cannot ${operation} after the builder has settled`);
    }
    this.#active = true;
  }

  async #flushLeaf(): Promise<void> {
    if (this.#leafReferences.length === 0) {
      return;
    }
    const references = this.#leafReferences.splice(
      0,
      this.#leafReferences.length,
    );
    const node = summarizeLeaf(references);
    await this.#emitNode(node);
  }

  async #emitNode(node: RecipeNode): Promise<void> {
    if (this.#emittedNodeCount + 2 > this.#limits.maxNodes) {
      throw new CanonicalBinaryError(
        "limit-exceeded",
        "streaming recipe node count exceeds the build limit",
      );
    }
    const object = canonicalObject(node);
    await this.#sinks.recipe(object);
    this.#emittedNodeCount += 1;
    await this.#pushChildReference(
      node.depth - 1,
      referenceFor(object.recipeId, node),
    );
  }

  async #pushChildReference(
    level: number,
    reference: ChildRecipeReference,
  ): Promise<void> {
    let accumulator = this.#branchLevels[level];
    if (accumulator === undefined) {
      accumulator = [];
      this.#branchLevels[level] = accumulator;
    }
    accumulator.push(reference);
    if (accumulator.length === MAX_BRANCH_REFERENCES) {
      await this.#flushBranch(level);
    }
  }

  async #flushBranch(level: number): Promise<void> {
    const accumulator = this.#branchLevels[level];
    if (accumulator === undefined || accumulator.length === 0) {
      return;
    }
    const children = accumulator.splice(0, accumulator.length);
    const node = summarizeBranch(children);
    await this.#emitNode(node);
  }

  #hasReferenceAbove(level: number): boolean {
    for (let index = level + 1; index < this.#branchLevels.length; index += 1) {
      if ((this.#branchLevels[index]?.length ?? 0) > 0) {
        return true;
      }
    }
    return false;
  }

  async #finishNodeHierarchy(): Promise<ChildRecipeReference> {
    await this.#flushLeaf();
    let level = 0;
    while (level < MAX_RECIPE_DEPTH - 1) {
      const accumulator = this.#branchLevels[level];
      if (accumulator === undefined || accumulator.length === 0) {
        level += 1;
        continue;
      }
      if (accumulator.length === 1 && !this.#hasReferenceAbove(level)) {
        const top = accumulator.shift();
        if (top === undefined) {
          throw new CanonicalBinaryError(
            "truncated",
            "streamed recipe hierarchy lost its top reference",
          );
        }
        return top;
      }
      await this.#flushBranch(level);
      level = 0;
    }
    throw new CanonicalBinaryError(
      "limit-exceeded",
      "streamed recipe hierarchy exceeds its maximum depth",
    );
  }
}
