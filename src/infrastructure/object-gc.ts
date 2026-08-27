import { createHash } from "node:crypto";

import {
  authenticateChunkRecipeGraph,
  MAX_RECIPE_DEPTH,
  type RecipeGraphLimits,
} from "./content-store/chunk-recipe.ts";
import {
  DEFAULT_COMPACTION_DECODED_BYTE_BUDGET,
  DELTA1_MAX_ANCHORS_PER_PATH,
  DELTA1_MIN_SAVED_BYTES,
  DELTA1_MIN_SAVED_PERCENT,
  planCompaction,
  type CompactionPlan,
  type ContentPathOccurrence,
  type LogicalRecordKey,
} from "./content-store/compaction.ts";
import {
  contentIdFromBytes,
  parseContentId,
  parseMetadataId,
  parseRecipeId,
  type ContentId,
  type RecipeId,
} from "./content-store/ids.ts";
import { FASTCDC_V1_PROFILE } from "./content-store/fastcdc.ts";
import {
  ObjectStoreMaintenance,
  ObjectStoreMaintenanceError,
  type MaintenanceInventory,
  type MaintenanceObject,
} from "./content-store/maintenance.ts";
import {
  buildMultiPackIndexFromViews,
  MAX_MULTI_PACK_INDEX_ENTRIES,
  MAX_MULTI_PACK_INDEX_PACKS,
  MultiPackIndexError,
} from "./content-store/multi-pack-index.ts";
import {
  PackHandlePool,
  type PackHandleLease,
} from "./content-store/pack-handle-pool.ts";
import {
  PackCatalog,
  PackCatalogError,
  type CatalogFileIdentity,
  type PackCatalogEntry,
  type PackCatalogInventory,
} from "./content-store/pack-catalog.ts";
import {
  DATA_PACK_TARGET_BYTES,
  encodePack,
  MAX_FULL_CONTENT_RECORD_BYTES,
  measurePackInputBytes,
  METADATA_PACK_TARGET_BYTES,
  type PackClass,
  type PackIndexEntry,
} from "./content-store/pack.ts";
import { DELTA1_MAX_TARGET_BYTES } from "./content-store/pack-delta.ts";
import {
  authenticateFullRecordPayload,
  chunkedContentRecipeId,
  createContentRecord,
  type ChunkedContentRecord,
  type SelfAuthenticatingRecord,
} from "./content-store/representation.ts";
import {
  decodeRecord,
  encodeRecord,
  type RecordEnvelope,
  type RecordKind,
} from "./content-store/record.ts";
import type {
  ContentRepositoryResolutionScope,
  PublishedContent,
  VerifiedObjectLocation,
} from "./content-store/repository.ts";
import { primaryFailure, withRetainedCleanup } from "./failure-settlement.ts";
import type { CurrentMetadataStore } from "./metadata.ts";
import {
  assertWorkspaceWriteAuthority,
  type WorkspaceWriteAuthority,
} from "./workspace-lock.ts";
import {
  nativeObjectStoreLayout,
  nativeObjectStoreRepository,
  openNativeObjectStoreReadScope,
  type NativeObjectStore,
} from "./object-store.ts";
import { ABSOLUTE_MAX_TREE_ENTRIES } from "./tree-formats/manifest-codec.ts";
import type { StoredTreeStructuralKind } from "./tree-formats/stored-adapter.ts";

export interface GcReport {
  readonly removedTrees: number;
  readonly removedBlobs: number;
  readonly removedTmpFiles: number;
  readonly freedBytes: number;
  readonly keptObjects: number;
  /** New physical-layer detail; legacy consumers can ignore these fields. */
  readonly removedRecords?: number;
  readonly removedPacks?: number;
  readonly compactedObjects?: number;
  readonly writtenPacks?: number;
}

export interface GarbageCollectionOptions {
  readonly graceMs?: number;
  readonly now?: number;
  /** Test/embedding override; production remains bounded by the absolute cap. */
  readonly maxObjects?: number;
  /** Bounds one maintenance pass without adding persistent cursor state. */
  readonly maxCompactionObjects?: number;
}

// A maximum-size v3 snapshot can contain one content object per entry plus
// singleton leaf/internal structural nodes and its root/scope. Pack/MIDX has
// its own tighter physical index bound and fails before mutation if exceeded.
const ABSOLUTE_MAX_GC_OBJECTS = ABSOLUTE_MAX_TREE_ENTRIES * 4 + 4_096;
const DEFAULT_MAX_COMPACTION_OBJECTS = 4_096;
const PARTIAL_PACK_REWRITE_PERCENT = 50;
const SIZE_TIER_FAN_IN = 4;
// A clean historical pack is rewritten solely to make a one-hop delta only
// when even the delta admission floor projects at most four bytes rewritten
// per byte saved. This still lets a new small generation meet the next one,
// without dragging a large, otherwise-clean pack through every GC pass.
const MAX_CROSS_GENERATION_REWRITE_TO_SAVINGS_RATIO = 4;
// Compaction owns two bounded pools: exact inventory reads here and logical
// repository reconstruction below. Each retains at most two pack handles.
const MAX_RESOLVER_PACKS = 2;

export class GarbageCollectionMarkError extends Error {
  readonly treeOid: string;

  constructor(treeOid: string, cause: unknown) {
    super(`refusing to sweep because rooted tree ${treeOid} is unreadable`, {
      cause,
    });
    this.name = "GarbageCollectionMarkError";
    this.treeOid = treeOid;
  }
}

export class GarbageCollectionNamespaceError extends Error {
  readonly path: string;
  readonly detail: string;

  constructor(path: string, detail: string, cause?: unknown) {
    super(`refusing to sweep unsafe object-store path ${path}: ${detail}`, {
      cause,
    });
    this.name = "GarbageCollectionNamespaceError";
    this.path = path;
    this.detail = detail;
  }
}

export class GarbageCollectionRootDriftError extends Error {
  constructor() {
    super("refusing to sweep because metadata roots changed during collection");
    this.name = "GarbageCollectionRootDriftError";
  }
}

class GarbageCollectionLimitError extends RangeError {}

function rethrowGarbageCollectionPrimary(failure: unknown): never {
  const primary = primaryFailure(failure);
  if (primary === failure) throw primary;
  if (primary instanceof GarbageCollectionMarkError) {
    throw new GarbageCollectionMarkError(primary.treeOid, failure);
  }
  if (primary instanceof GarbageCollectionNamespaceError) {
    throw new GarbageCollectionNamespaceError(
      primary.path,
      primary.detail,
      failure,
    );
  }
  if (primary instanceof GarbageCollectionLimitError) {
    throw new GarbageCollectionLimitError(primary.message, {
      cause: failure,
    });
  }
  if (primary instanceof RangeError) {
    throw new RangeError(primary.message, { cause: failure });
  }
  throw failure;
}

interface MarkState {
  readonly liveKeys: ReadonlyMap<string, LogicalRecordKey>;
  readonly structuralKinds: ReadonlyMap<
    string,
    ReadonlySet<StoredTreeStructuralKind>
  >;
  readonly occurrences: readonly ContentPathOccurrence[];
  /** Exact physical receipts authenticated while traversing the roots. */
  readonly authenticatedCoverage: ReadonlySet<string>;
}

interface PackRewriteSelection {
  readonly fullyDeadPackIds: ReadonlySet<string>;
  readonly partialPackIds: ReadonlySet<string>;
  readonly redundantPackIds: ReadonlySet<string>;
  readonly replacementKeys: ReadonlyMap<string, LogicalRecordKey>;
  /** Logical records whose replacement is required before each pack unlinks. */
  readonly rewriteRequirements: ReadonlyMap<string, ReadonlySet<string>>;
  /** Clean packs admitted only so this pass can form a cross-generation delta. */
  readonly opportunisticPackIds: ReadonlySet<string>;
  /** Keys introduced solely by each opportunistic pack. */
  readonly opportunisticAddedKeys: ReadonlyMap<string, ReadonlySet<string>>;
}

interface SizeTierRewriteGroup {
  readonly packClass: PackClass;
  readonly packs: readonly PackCatalogEntry[];
  readonly inputBytes: number;
}

interface PlannedPackClassMetrics {
  readonly packs: number;
  readonly bytes: number;
}

export interface TieredRewriteMetrics {
  readonly baseline: Readonly<Record<PackClass, PlannedPackClassMetrics>>;
  readonly candidate: Readonly<Record<PackClass, PlannedPackClassMetrics>>;
  readonly packClass: PackClass;
  readonly sourcePacks: number;
  readonly sourceBytes: number;
}

interface MaterializedContent {
  readonly proofs: readonly PublishedContent[];
  readonly liveKeys: ReadonlyMap<string, LogicalRecordKey>;
  readonly skippedContentIds: ReadonlySet<string>;
  readonly published: boolean;
}

interface MutableReport {
  removedTrees: number;
  removedBlobs: number;
  removedTmpFiles: number;
  freedBytes: number;
  keptObjects: number;
  removedRecords: number;
  removedPacks: number;
  compactedObjects: number;
  writtenPacks: number;
}

function recordKey(kind: RecordKind, logicalId: string): string {
  return `${kind}:${logicalId}`;
}

function packCoverageKey(packId: string, physicalOrdinal: number): string {
  return `pack:${packId}:${physicalOrdinal}`;
}

function objectCoverageKey(
  objectKind: MaintenanceObject["kind"],
  kind: RecordKind,
  logicalId: string,
): string {
  return `object:${objectKind}:${kind}:${logicalId}`;
}

function verifiedLocationCoverageKey(location: VerifiedObjectLocation): string {
  if (location.source === "pack") {
    return packCoverageKey(location.packId, location.physicalOrdinal);
  }
  if (location.source === "legacy-blob") {
    return objectCoverageKey("legacy-blob", "content", location.logicalId);
  }
  return objectCoverageKey(
    location.kind === "content" ? "loose-content" : "loose-recipe",
    location.kind,
    location.logicalId,
  );
}

function logicalKey(kind: RecordKind, logicalId: string): LogicalRecordKey {
  switch (kind) {
    case "content":
      return Object.freeze({ kind, logicalId: parseContentId(logicalId) });
    case "recipe":
      return Object.freeze({ kind, logicalId: parseRecipeId(logicalId) });
    case "tree-root":
    case "tree-node":
    case "scope":
      return Object.freeze({ kind, logicalId: parseMetadataId(logicalId) });
  }
}

function structuralRecordKind(kind: StoredTreeStructuralKind): RecordKind {
  switch (kind) {
    case "root":
      return "tree-root";
    case "node":
      return "tree-node";
    case "scope":
      return "scope";
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableRoots(roots: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(roots)].sort(compareText));
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function addLiveKey(
  keys: Map<string, LogicalRecordKey>,
  key: LogicalRecordKey,
  maximum: number,
): void {
  keys.set(recordKey(key.kind, key.logicalId), key);
  if (keys.size > maximum) {
    throw new GarbageCollectionLimitError(
      `refusing to sweep because the rooted object graph exceeds the ${maximum}-object limit`,
    );
  }
}

function extendLiveMark(
  mark: MarkState,
  additions: ReadonlyMap<string, LogicalRecordKey>,
  maximum: number,
): MarkState {
  const liveKeys = new Map(mark.liveKeys);
  for (const key of additions.values()) addLiveKey(liveKeys, key, maximum);
  return Object.freeze({ ...mark, liveKeys });
}

function extendCompactionSelection(
  selection: PackRewriteSelection,
  additions: ReadonlyMap<string, LogicalRecordKey>,
  maximum: number,
): PackRewriteSelection {
  const replacementKeys = new Map(selection.replacementKeys);
  for (const [text, key] of [...additions].sort(([left], [right]) =>
    compareText(left, right),
  )) {
    if (replacementKeys.has(text)) continue;
    if (replacementKeys.size >= maximum) break;
    replacementKeys.set(text, key);
  }
  return Object.freeze({ ...selection, replacementKeys });
}

function omitReplacementKeys(
  selection: PackRewriteSelection,
  omittedContentIds: ReadonlySet<string>,
): PackRewriteSelection {
  if (omittedContentIds.size === 0) return selection;
  const replacementKeys = new Map(
    [...selection.replacementKeys].filter(
      ([, key]) =>
        key.kind !== "content" || !omittedContentIds.has(key.logicalId),
    ),
  );
  return Object.freeze({ ...selection, replacementKeys });
}

function withoutReplacementWork(
  selection: PackRewriteSelection,
): PackRewriteSelection {
  return Object.freeze({
    ...selection,
    partialPackIds: new Set<string>(),
    replacementKeys: new Map<string, LogicalRecordKey>(),
    rewriteRequirements: new Map<string, ReadonlySet<string>>(),
    opportunisticPackIds: new Set<string>(),
    opportunisticAddedKeys: new Map<string, ReadonlySet<string>>(),
  });
}

function recipeLimits(maximumBytes: number): RecipeGraphLimits {
  const maxChunks = Math.min(
    1_000_000,
    Math.ceil(maximumBytes / (16 * 1024)) + 1,
  );
  return Object.freeze({
    maxChunks,
    maxDecodedBytes: maximumBytes,
    maxDepth: MAX_RECIPE_DEPTH,
    maxNodes: Math.min(1_000_000, maxChunks * 2 + MAX_RECIPE_DEPTH),
  });
}

function identitiesEqual(
  left: CatalogFileIdentity,
  right: CatalogFileIdentity,
): boolean {
  return (
    left.path === right.path &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function expired(modifiedAt: number, graceMs: number, now: number): boolean {
  return modifiedAt < now - graceMs;
}

function mapInfrastructureError(path: string, error: unknown): never {
  if (
    (error instanceof ObjectStoreMaintenanceError ||
      error instanceof PackCatalogError) &&
    error.code === "limit-exceeded"
  ) {
    throw new RangeError(error.message, { cause: error });
  }
  if (
    (error instanceof ObjectStoreMaintenanceError ||
      error instanceof PackCatalogError) &&
    (error.code === "namespace-invalid" || error.code === "pack-integrity")
  ) {
    throw new GarbageCollectionNamespaceError(path, error.message, error);
  }
  throw error;
}

async function authenticateRoots(
  store: NativeObjectStore,
  roots: readonly string[],
  maximumObjects: number,
): Promise<MarkState> {
  const repository = nativeObjectStoreRepository(store, "garbage collection");
  const reads = openNativeObjectStoreReadScope(store, "garbage collection");
  const liveKeys = new Map<string, LogicalRecordKey>();
  const structuralKinds = new Map<string, Set<StoredTreeStructuralKind>>();
  const occurrences: ContentPathOccurrence[] = [];
  const authenticatedContent = new Set<string>();
  const authenticatedCoverage = new Set<string>();

  try {
    return await withRetainedCleanup(
      async () => {
        for (const treeOid of roots) {
          try {
            const closure = await reads.readTreeClosure(treeOid);
            for (const object of closure.structuralObjects) {
              const kind = structuralRecordKind(object.kind);
              addLiveKey(
                liveKeys,
                logicalKey(kind, object.oid),
                maximumObjects,
              );
              const kinds = structuralKinds.get(object.oid) ?? new Set();
              kinds.add(object.kind);
              structuralKinds.set(object.oid, kinds);
            }
            for (const entry of closure.manifest.entries) {
              if (
                entry.type === "regular" &&
                occurrences.length < maximumObjects
              ) {
                occurrences.push(
                  Object.freeze({
                    canonicalPath: entry.path,
                    contentId: parseContentId(entry.blobOid),
                  }),
                );
              }
            }
            for (const contentId of closure.contentIds) {
              addLiveKey(
                liveKeys,
                logicalKey("content", contentId),
                maximumObjects,
              );
              if (authenticatedContent.has(contentId)) continue;
              const verified = await reads.readContentClosure(
                contentId,
                repository.maxDecodedBytes,
              );
              authenticatedContent.add(contentId);
              for (const object of verified.closure.objects) {
                authenticatedCoverage.add(verifiedLocationCoverageKey(object));
                if (object.retention !== "logical") continue;
                addLiveKey(
                  liveKeys,
                  logicalKey(object.kind, object.logicalId),
                  maximumObjects,
                );
              }
            }
          } catch (error) {
            if (error instanceof GarbageCollectionLimitError) throw error;
            throw new GarbageCollectionMarkError(treeOid, error);
          }
        }

        return Object.freeze({
          liveKeys,
          structuralKinds: new Map(
            [...structuralKinds].map(([oid, kinds]) => [
              oid,
              Object.freeze(new Set(kinds)),
            ]),
          ),
          occurrences: Object.freeze(occurrences),
          authenticatedCoverage: Object.freeze(authenticatedCoverage),
        });
      },
      () => reads.close(),
      "garbage-collection marking and read cleanup both failed",
    );
  } catch (error) {
    rethrowGarbageCollectionPrimary(error);
  }
}

function maintenanceObjectKeys(
  object: MaintenanceObject,
  mark: MarkState,
): readonly LogicalRecordKey[] {
  if (object.temporary || object.logicalId === undefined) return [];
  switch (object.kind) {
    case "legacy-blob":
    case "loose-content":
      return [logicalKey("content", object.logicalId)];
    case "loose-recipe":
      return [logicalKey("recipe", object.logicalId)];
    case "loose-structural":
      return [...(mark.structuralKinds.get(object.logicalId) ?? [])].map(
        (kind) => logicalKey(structuralRecordKind(kind), object.logicalId!),
      );
  }
}

function objectIsLive(object: MaintenanceObject, mark: MarkState): boolean {
  return maintenanceObjectKeys(object, mark).some((key) =>
    mark.liveKeys.has(recordKey(key.kind, key.logicalId)),
  );
}

function inventoryObjectCount(inventories: {
  readonly objects: MaintenanceInventory;
  readonly packs: PackCatalogInventory;
}): number {
  return (
    inventories.objects.objects.length +
    inventories.packs.totalIndexEntries +
    inventories.packs.incoming.length
  );
}

export interface CompactionAdditiveCapacity {
  readonly newRecords: number;
  readonly newPacks: number;
  readonly largestIncomingBytes: number;
  readonly currentObjects: number;
  readonly currentIndexEntries: number;
  readonly currentPacks: number;
  readonly currentIncomingFiles: number;
  readonly currentIncomingBytes: number;
  readonly maxObjects: number;
  readonly maxIndexEntries: number;
  readonly maxPacks: number;
  readonly maxIncomingFiles: number;
  readonly maxIncomingBytes: number;
}

/** Pure whole-plan admission fence used before the first additive publish. */
export function compactionFitsAdditiveCapacity(
  input: CompactionAdditiveCapacity,
): boolean {
  const fits = (addition: number, current: number, maximum: number): boolean =>
    Number.isSafeInteger(addition) &&
    addition >= 0 &&
    Number.isSafeInteger(current) &&
    current >= 0 &&
    Number.isSafeInteger(maximum) &&
    maximum >= current &&
    addition <= maximum - current;
  return (
    fits(input.newRecords, input.currentObjects, input.maxObjects) &&
    fits(input.newRecords, input.currentIndexEntries, input.maxIndexEntries) &&
    fits(input.newPacks, input.currentPacks, input.maxPacks) &&
    (input.newPacks === 0 ||
      (fits(1, input.currentIncomingFiles, input.maxIncomingFiles) &&
        fits(
          input.largestIncomingBytes,
          input.currentIncomingBytes,
          input.maxIncomingBytes,
        )))
  );
}

export interface CompactionDecodedCandidate {
  readonly key: string;
  readonly decodedLength: number | undefined;
}

export interface CrossGenerationRewriteProjection {
  readonly selectedTargetBytes: number;
  readonly sourcePackBytes: number;
}

/** Deterministic conservative gate for a rewrite whose only purpose is delta. */
export function crossGenerationRewriteIsWorthwhile(
  projection: CrossGenerationRewriteProjection,
): boolean {
  const { selectedTargetBytes, sourcePackBytes } = projection;
  if (
    !Number.isSafeInteger(selectedTargetBytes) ||
    selectedTargetBytes <= DELTA1_MIN_SAVED_BYTES ||
    !Number.isSafeInteger(sourcePackBytes) ||
    sourcePackBytes <= 0
  ) {
    return false;
  }
  const projectedSavings = Math.max(
    DELTA1_MIN_SAVED_BYTES,
    Math.ceil((selectedTargetBytes * DELTA1_MIN_SAVED_PERCENT) / 100),
  );
  return (
    sourcePackBytes <=
    projectedSavings * MAX_CROSS_GENERATION_REWRITE_TO_SAVINGS_RATIO
  );
}

/** A tier rewrite must reduce this class's pack count without growing it. */
export function tieredRewriteIsConvergent(
  metrics: TieredRewriteMetrics,
): boolean {
  const { baseline, candidate, packClass, sourcePacks, sourceBytes } = metrics;
  if (
    (packClass !== "data" && packClass !== "metadata") ||
    sourcePacks !== SIZE_TIER_FAN_IN ||
    !Number.isSafeInteger(sourceBytes) ||
    sourceBytes <= 0
  ) {
    return false;
  }
  for (const currentClass of ["data", "metadata"] as const) {
    const before = baseline[currentClass];
    const after = candidate[currentClass];
    if (
      !Number.isSafeInteger(before.packs) ||
      before.packs < 0 ||
      !Number.isSafeInteger(before.bytes) ||
      before.bytes < 0 ||
      !Number.isSafeInteger(after.packs) ||
      after.packs < 0 ||
      !Number.isSafeInteger(after.bytes) ||
      after.bytes < 0
    ) {
      return false;
    }
    if (
      currentClass !== packClass &&
      (after.packs !== before.packs || after.bytes !== before.bytes)
    ) {
      return false;
    }
  }
  const addedPacks = candidate[packClass].packs - baseline[packClass].packs;
  const addedBytes = candidate[packClass].bytes - baseline[packClass].bytes;
  return addedPacks < sourcePacks && addedBytes <= sourceBytes;
}

function compactionPlanMetrics(
  plan: CompactionPlan,
): Readonly<Record<PackClass, PlannedPackClassMetrics>> {
  const mutable: Record<PackClass, { packs: number; bytes: number }> = {
    data: { packs: 0, bytes: 0 },
    metadata: { packs: 0, bytes: 0 },
  };
  for (const batch of plan.batches) {
    const metrics = mutable[batch.packClass];
    metrics.packs += 1;
    metrics.bytes += measurePackInputBytes(batch);
    if (!Number.isSafeInteger(metrics.bytes)) {
      throw new RangeError("planned pack bytes exceed the safe limit");
    }
  }
  return Object.freeze({
    data: Object.freeze({ ...mutable.data }),
    metadata: Object.freeze({ ...mutable.metadata }),
  });
}

function compactionPlanDecodedBytes(plan: CompactionPlan): number {
  let total = 0;
  for (const batch of plan.batches) {
    for (const record of batch.records) {
      if (record.decodedLength > Number.MAX_SAFE_INTEGER - total) {
        throw new RangeError("planned decoded bytes exceed the safe limit");
      }
      total += record.decodedLength;
    }
  }
  return total;
}

/** Pure-integer floor(log2(bytes)); pack sizes are positive safe integers. */
function physicalSizeTier(bytes: number): number {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new RangeError("pack size is not a positive safe integer");
  }
  let tier = 0;
  let remaining = bytes;
  while (remaining > 1) {
    remaining = Math.floor(remaining / 2);
    tier += 1;
  }
  return tier;
}

/**
 * Deterministically admit whole logical records into one maintenance byte
 * budget. Unknown, malformed, individually oversized, and later overflowing
 * records remain for a future pass; no partial record is ever admitted.
 */
export function selectCompactionKeysWithinDecodedBudget(
  candidates: readonly CompactionDecodedCandidate[],
  maximumDecodedBytes = DEFAULT_COMPACTION_DECODED_BYTE_BUDGET,
): ReadonlySet<string> {
  if (!Number.isSafeInteger(maximumDecodedBytes) || maximumDecodedBytes < 0) {
    throw new RangeError("compaction decoded-byte budget is invalid");
  }
  const admitted = new Set<string>();
  let admittedBytes = 0;
  for (const { key, decodedLength } of [...candidates].sort((left, right) =>
    compareText(left.key, right.key),
  )) {
    if (
      admitted.has(key) ||
      decodedLength === undefined ||
      !Number.isSafeInteger(decodedLength) ||
      decodedLength < 0 ||
      decodedLength > maximumDecodedBytes - admittedBytes
    ) {
      continue;
    }
    admitted.add(key);
    admittedBytes += decodedLength;
  }
  return admitted;
}

async function strictInventories(
  maintenance: ObjectStoreMaintenance,
  catalog: PackCatalog,
  maximumObjects: number,
): Promise<{
  readonly objects: MaintenanceInventory;
  readonly packs: PackCatalogInventory;
}> {
  try {
    const objects = await maintenance.inventory(maximumObjects);
    const packs = await catalog.inventory();
    const count = inventoryObjectCount({ objects, packs });
    if (count > maximumObjects) {
      throw new RangeError(
        `refusing to sweep because object inventory exceeds the ${maximumObjects}-candidate limit`,
      );
    }
    return { objects, packs };
  } catch (error) {
    mapInfrastructureError("objects", error);
  }
}

function withAuthenticatedStructuralCoverage(
  mark: MarkState,
  inventory: MaintenanceInventory,
): MarkState {
  const authenticatedCoverage = new Set(mark.authenticatedCoverage);
  const looseStructuralIds = new Set(
    inventory.objects
      .filter(
        (object) => !object.temporary && object.kind === "loose-structural",
      )
      .map(({ logicalId }) => logicalId),
  );
  for (const [oid, kinds] of mark.structuralKinds) {
    const loose = looseStructuralIds.has(oid);
    for (const kind of kinds) {
      const recordKind = structuralRecordKind(kind);
      if (loose) {
        authenticatedCoverage.add(
          objectCoverageKey("loose-structural", recordKind, oid),
        );
      }
    }
  }
  return Object.freeze({ ...mark, authenticatedCoverage });
}

class CompactionResolver {
  readonly #repository: ReturnType<typeof nativeObjectStoreRepository>;
  readonly #maintenance: ObjectStoreMaintenance;
  readonly #objectInventory: MaintenanceInventory;
  readonly #catalog: PackCatalog;
  readonly #objectsByKey = new Map<string, MaintenanceObject[]>();
  readonly #packEntriesByKey = new Map<
    string,
    Array<{
      readonly catalog: PackCatalogEntry;
      readonly entry: PackIndexEntry;
    }>
  >();
  readonly #packPool: PackHandlePool;
  readonly #repositoryScope: ContentRepositoryResolutionScope;
  readonly #verifiedChunked = new Set<string>();

  constructor(
    store: NativeObjectStore,
    maintenance: ObjectStoreMaintenance,
    objectInventory: MaintenanceInventory,
    catalog: PackCatalog,
    packInventory: PackCatalogInventory,
    mark: MarkState,
  ) {
    this.#repository = nativeObjectStoreRepository(store, "compaction");
    this.#maintenance = maintenance;
    this.#objectInventory = objectInventory;
    this.#catalog = catalog;
    this.#packPool = new PackHandlePool(catalog, MAX_RESOLVER_PACKS);
    for (const object of objectInventory.objects) {
      for (const key of maintenanceObjectKeys(object, mark)) {
        const text = recordKey(key.kind, key.logicalId);
        const candidates = this.#objectsByKey.get(text) ?? [];
        candidates.push(object);
        this.#objectsByKey.set(text, candidates);
      }
    }
    for (const catalogEntry of packInventory.packs) {
      for (const entry of catalogEntry.view.entries) {
        const text = recordKey(entry.kind, entry.logicalId);
        const candidates = this.#packEntriesByKey.get(text) ?? [];
        candidates.push({ catalog: catalogEntry, entry });
        this.#packEntriesByKey.set(text, candidates);
      }
    }
    for (const candidates of this.#packEntriesByKey.values()) {
      candidates.sort(
        (left, right) =>
          compareText(left.catalog.view.packId, right.catalog.view.packId) ||
          left.entry.physicalOrdinal - right.entry.physicalOrdinal,
      );
    }
    this.#repositoryScope = this.#repository.openResolutionScope();
  }

  readEnvelope(key: LogicalRecordKey): Promise<RecordEnvelope> {
    return this.#readEnvelope(key);
  }

  readDecodedContent(contentId: ContentId): Promise<Uint8Array> {
    return this.#readDecodedContent(contentId);
  }

  async dispose(): Promise<void> {
    const settled = await Promise.allSettled([
      this.#packPool.close(),
      this.#repository.closeResolutionScope(this.#repositoryScope),
    ]);
    const failures = settled
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      )
      .map(({ reason }) => reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        "multiple compaction read scopes failed to close",
      );
    }
  }

  async verifyChunkedPublication(input: {
    readonly logicalId: ContentId;
    readonly recipeId: RecipeId;
    readonly decodedLength: number;
  }): Promise<boolean> {
    return this.#verifiedChunked.has(
      `${input.logicalId}:${input.recipeId}:${input.decodedLength}`,
    );
  }

  async verifyObjectCoverage(
    object: MaintenanceObject,
    key: LogicalRecordKey,
  ): Promise<void> {
    const bytes = await this.#maintenance.readObject(
      this.#objectInventory,
      object,
      object.byteLength,
    );
    if (object.kind === "legacy-blob") {
      if (
        key.kind !== "content" ||
        contentIdFromBytes(bytes) !== String(key.logicalId)
      ) {
        throw new Error("legacy blob does not cover its logical key");
      }
      return;
    }
    if (object.kind === "loose-structural") {
      if (
        (key.kind !== "tree-root" &&
          key.kind !== "tree-node" &&
          key.kind !== "scope") ||
        contentIdFromBytes(bytes) !== String(key.logicalId)
      ) {
        throw new Error("loose structural object does not cover its key");
      }
      return;
    }
    if (object.kind !== "loose-content" && object.kind !== "loose-recipe") {
      throw new Error("temporary object cannot provide retained coverage");
    }
    const envelope = decodeRecord(bytes, {
      maxDecodedBytes: this.#repository.maxDecodedBytes,
      maxPayloadBytes: bytes.byteLength,
    });
    if (envelope.kind !== key.kind || envelope.logicalId !== key.logicalId) {
      throw new Error("loose object does not cover its logical key");
    }
    await this.#authenticateEnvelope(envelope);
  }

  objectCoverageStillCurrent(object: MaintenanceObject): Promise<boolean> {
    return this.#maintenance.objectIdentityStillCurrent(
      this.#objectInventory,
      object,
    );
  }

  async verifyPackCoverage(
    catalogEntry: PackCatalogEntry,
    entry: PackIndexEntry,
    key: LogicalRecordKey,
  ): Promise<void> {
    if (entry.kind !== key.kind || entry.logicalId !== key.logicalId) {
      throw new Error("pack entry does not cover its logical key");
    }
    const lease = await this.#acquirePack(catalogEntry);
    const envelope = await withRetainedCleanup(
      async () => {
        const read = await lease.handle.readEnvelope(entry);
        if (read.encoding !== "chunked-v1") {
          await lease.handle.readVerified(entry, {
            verifyMetadataId: (_kind, id, decoded) =>
              contentIdFromBytes(decoded) === String(id),
          });
        }
        return read;
      },
      () => lease.release(),
      "pack coverage verification and lease release both failed",
    );
    if (envelope.encoding === "chunked-v1") {
      await this.#authenticateEnvelope(envelope);
    }
  }

  packCoverageStillCurrent(pack: PackCatalogEntry): Promise<boolean> {
    return this.#catalog.packIdentityStillCurrent(pack);
  }

  async #readEnvelope(key: LogicalRecordKey): Promise<RecordEnvelope> {
    if (
      key.kind === "tree-root" ||
      key.kind === "tree-node" ||
      key.kind === "scope"
    ) {
      const loose = (
        this.#objectsByKey.get(recordKey(key.kind, key.logicalId)) ?? []
      ).find(
        (object) => !object.temporary && object.kind === "loose-structural",
      );
      if (loose !== undefined) {
        const bytes = await this.#maintenance.readObject(
          this.#objectInventory,
          loose,
          loose.byteLength,
        );
        if (contentIdFromBytes(bytes) !== String(key.logicalId)) {
          throw new Error("authenticated structural object changed identity");
        }
        return {
          kind: key.kind,
          encoding: "raw",
          logicalId: key.logicalId,
          decodedLength: bytes.byteLength,
          payload: bytes,
        };
      }
      const packed = this.#packEntriesByKey.get(
        recordKey(key.kind, key.logicalId),
      )?.[0];
      if (packed !== undefined) {
        return await this.#readPackedEnvelope(packed, key);
      }
      throw new Error(`no authenticated representation for ${key.kind}`);
    }

    const loose = (
      this.#objectsByKey.get(recordKey(key.kind, key.logicalId)) ?? []
    )
      .filter(
        (object) =>
          !object.temporary &&
          (object.kind === "loose-content" || object.kind === "loose-recipe"),
      )
      .sort((left, right) => compareText(left.kind, right.kind))[0];
    if (loose !== undefined) {
      const bytes = await this.#maintenance.readObject(
        this.#objectInventory,
        loose,
        loose.byteLength,
      );
      const envelope = decodeRecord(bytes, {
        maxDecodedBytes: this.#repository.maxDecodedBytes,
        maxPayloadBytes: bytes.byteLength,
      });
      if (envelope.kind !== key.kind || envelope.logicalId !== key.logicalId) {
        throw new Error("loose record does not match its inventory key");
      }
      await this.#authenticateEnvelope(envelope);
      return envelope;
    }

    const packed = this.#packEntriesByKey.get(
      recordKey(key.kind, key.logicalId),
    )?.[0];
    if (packed !== undefined) {
      return await this.#readPackedEnvelope(packed, key);
    }

    if (key.kind === "content") {
      const legacy = (
        this.#objectsByKey.get(recordKey(key.kind, key.logicalId)) ?? []
      ).find((object) => !object.temporary && object.kind === "legacy-blob");
      if (legacy !== undefined) {
        const bytes = await this.#maintenance.readObject(
          this.#objectInventory,
          legacy,
          MAX_FULL_CONTENT_RECORD_BYTES,
        );
        const envelope = await createContentRecord(bytes);
        if (envelope.logicalId !== key.logicalId) {
          throw new Error("legacy blob does not match its logical id");
        }
        return envelope;
      }
    }
    throw new Error(`no authenticated representation for ${key.kind}`);
  }

  async #authenticateEnvelope(envelope: RecordEnvelope): Promise<void> {
    if (envelope.encoding === "raw" || envelope.encoding === "zstd-v1") {
      if (envelope.kind === "content" || envelope.kind === "recipe") {
        await authenticateFullRecordPayload(
          envelope as SelfAuthenticatingRecord,
        );
      }
      return;
    }
    if (envelope.encoding === "delta1") {
      throw new Error("a loose delta record is not admissible");
    }
    if (envelope.kind !== "content") {
      throw new Error("only content can use chunked encoding");
    }
    const rootId = chunkedContentRecipeId(envelope as ChunkedContentRecord);
    const graph = await authenticateChunkRecipeGraph(
      rootId,
      {
        contentId: envelope.logicalId,
        decodedLength: envelope.decodedLength,
      },
      async (recipeId) => {
        const recipe = await this.readEnvelope(logicalKey("recipe", recipeId));
        return await authenticateFullRecordPayload(
          recipe as SelfAuthenticatingRecord,
        );
      },
      recipeLimits(envelope.decodedLength),
    );
    const hash = createHash("sha256");
    let total = 0;
    for (const chunk of graph.chunks) {
      const read = await this.#repository.streamContent(
        chunk.contentId,
        chunk.decodedLength,
        async (bytes) => {
          total += bytes.byteLength;
          hash.update(bytes);
        },
        this.#repositoryScope,
      );
      if (read.decodedLength !== chunk.decodedLength) {
        throw new Error("chunked representation has a length mismatch");
      }
    }
    if (
      total !== envelope.decodedLength ||
      hash.digest("hex") !== envelope.logicalId
    ) {
      throw new Error("chunked representation does not match its content id");
    }
    this.#verifiedChunked.add(
      `${envelope.logicalId}:${rootId}:${envelope.decodedLength}`,
    );
  }

  async #readDecodedContent(contentId: ContentId): Promise<Uint8Array> {
    const chunks: Buffer[] = [];
    let total = 0;
    const read = await this.#repository.streamContent(
      contentId,
      MAX_FULL_CONTENT_RECORD_BYTES,
      async (bytes) => {
        total += bytes.byteLength;
        if (total > MAX_FULL_CONTENT_RECORD_BYTES) {
          throw new RangeError("compaction content exceeds its decode limit");
        }
        chunks.push(Buffer.from(bytes));
      },
      this.#repositoryScope,
    );
    if (read.decodedLength !== total) {
      throw new Error("decoded compaction content changed length");
    }
    return Uint8Array.from(Buffer.concat(chunks, total));
  }

  async #readPackedEnvelope(
    packed: {
      readonly catalog: PackCatalogEntry;
      readonly entry: PackIndexEntry;
    },
    key: LogicalRecordKey,
  ): Promise<RecordEnvelope> {
    const lease = await this.#acquirePack(packed.catalog);
    const envelope = await withRetainedCleanup(
      async () => {
        const read = await lease.handle.readEnvelope(packed.entry);
        if (read.kind !== key.kind || read.logicalId !== key.logicalId) {
          throw new Error("pack record does not match its authenticated index");
        }
        if (read.encoding !== "chunked-v1") {
          await lease.handle.readVerified(packed.entry, {
            verifyMetadataId: (_kind, id, decoded) =>
              contentIdFromBytes(decoded) === String(id),
          });
        }
        return read;
      },
      () => lease.release(),
      "packed-envelope read and lease release both failed",
    );
    if (envelope.encoding === "chunked-v1") {
      await this.#authenticateEnvelope(envelope);
    }
    return envelope;
  }

  async #acquirePack(entry: PackCatalogEntry): Promise<PackHandleLease> {
    const acquired = await this.#packPool.acquire(
      entry.view.packId,
      entry.identity,
    );
    if (acquired.kind !== "acquired") {
      await this.#packPool.invalidate(entry.view.packId);
      throw new Error("pack changed after compaction inventory");
    }
    return acquired.lease;
  }
}

type RetainedCoverage =
  | {
      readonly source: "object";
      readonly object: MaintenanceObject;
    }
  | {
      readonly source: "pack";
      readonly pack: PackCatalogEntry;
      readonly entry: PackIndexEntry;
    };

async function authenticateRetainedCoverage(
  inventories: {
    readonly objects: MaintenanceInventory;
    readonly packs: PackCatalogInventory;
  },
  mark: MarkState,
  resolver: CompactionResolver,
  removableObjects: ReadonlySet<MaintenanceObject>,
  removablePackIds: ReadonlySet<string>,
  replacementPackIds: ReadonlySet<string>,
  authenticatedCoverage: ReadonlySet<string>,
): Promise<void> {
  const candidates = new Map<string, RetainedCoverage[]>();
  const currentCoverage = new Map<string, Promise<boolean>>();
  const append = (text: string, coverage: RetainedCoverage): void => {
    const values = candidates.get(text) ?? [];
    values.push(coverage);
    candidates.set(text, values);
  };
  for (const object of inventories.objects.objects) {
    if (object.temporary || removableObjects.has(object)) continue;
    for (const key of maintenanceObjectKeys(object, mark)) {
      append(recordKey(key.kind, key.logicalId), {
        source: "object",
        object,
      });
    }
  }
  for (const pack of inventories.packs.packs) {
    if (removablePackIds.has(pack.view.packId)) continue;
    for (const entry of pack.view.entries) {
      const text = recordKey(entry.kind, entry.logicalId);
      if (!mark.liveKeys.has(text)) continue;
      append(text, { source: "pack", pack, entry });
    }
  }

  for (const [text, key] of [...mark.liveKeys].sort(([left], [right]) =>
    compareText(left, right),
  )) {
    const coverageKey = (coverage: RetainedCoverage): string =>
      coverage.source === "pack"
        ? packCoverageKey(
            coverage.pack.view.packId,
            coverage.entry.physicalOrdinal,
          )
        : objectCoverageKey(coverage.object.kind, key.kind, key.logicalId);
    const rank = (coverage: RetainedCoverage): number => {
      if (
        coverage.source === "pack" &&
        replacementPackIds.has(coverage.pack.view.packId)
      ) {
        return 0;
      }
      if (authenticatedCoverage.has(coverageKey(coverage))) return 1;
      return coverage.source === "pack" ? 2 : 3;
    };
    const retained = (candidates.get(text) ?? []).sort((left, right) => {
      const rankOrder = rank(left) - rank(right);
      if (rankOrder !== 0) return rankOrder;
      if (left.source !== right.source) {
        return left.source === "pack" ? -1 : 1;
      }
      if (left.source === "object" && right.source === "object") {
        return (
          compareText(left.object.kind, right.object.kind) ||
          compareText(left.object.logicalId ?? "", right.object.logicalId ?? "")
        );
      }
      if (left.source === "pack" && right.source === "pack") {
        const leftReplacement = replacementPackIds.has(left.pack.view.packId);
        const rightReplacement = replacementPackIds.has(right.pack.view.packId);
        return (
          Number(rightReplacement) - Number(leftReplacement) ||
          compareText(left.pack.view.packId, right.pack.view.packId) ||
          left.entry.physicalOrdinal - right.entry.physicalOrdinal
        );
      }
      return 0;
    })[0];
    if (retained === undefined) {
      throw new GarbageCollectionNamespaceError(
        "objects",
        `planned deletion has no retained coverage for ${text}`,
      );
    }
    if (
      (retained.source === "pack" &&
        replacementPackIds.has(retained.pack.view.packId)) ||
      authenticatedCoverage.has(coverageKey(retained))
    ) {
      const token =
        retained.source === "pack"
          ? `pack:${retained.pack.view.packId}`
          : `object:${retained.object.kind}:${retained.object.logicalId ?? "temporary"}`;
      let pendingCurrent = currentCoverage.get(token);
      if (pendingCurrent === undefined) {
        pendingCurrent =
          retained.source === "pack"
            ? resolver.packCoverageStillCurrent(retained.pack)
            : resolver.objectCoverageStillCurrent(retained.object);
        currentCoverage.set(token, pendingCurrent);
      }
      const current = await pendingCurrent;
      if (!current) {
        throw new GarbageCollectionNamespaceError(
          retained.source === "pack" ? retained.pack.path : "objects",
          `retained coverage for ${text} changed before cutover`,
        );
      }
      continue;
    }
    try {
      if (retained.source === "object") {
        await resolver.verifyObjectCoverage(retained.object, key);
      } else {
        await resolver.verifyPackCoverage(retained.pack, retained.entry, key);
      }
    } catch (error) {
      throw new GarbageCollectionNamespaceError(
        retained.source === "object" ? "objects" : retained.pack.path,
        `retained coverage for ${text} failed authentication`,
        error,
      );
    }
  }
}

function livePackKeys(
  pack: PackCatalogEntry,
  mark: MarkState,
): readonly LogicalRecordKey[] {
  return [
    ...new Map(
      pack.view.entries
        .filter((entry) =>
          mark.liveKeys.has(recordKey(entry.kind, entry.logicalId)),
        )
        .map((entry) => {
          const key = logicalKey(entry.kind, entry.logicalId);
          return [recordKey(key.kind, key.logicalId), key] as const;
        }),
    ).values(),
  ];
}

function sizeTierRewriteGroups(
  selection: PackRewriteSelection,
  packs: PackCatalogInventory,
  mark: MarkState,
  graceMs: number,
  now: number,
): readonly SizeTierRewriteGroup[] {
  const selectedPackIds = new Set([
    ...selection.fullyDeadPackIds,
    ...selection.partialPackIds,
    ...selection.redundantPackIds,
    ...selection.opportunisticPackIds,
  ]);
  const byClassAndTier: Record<PackClass, Map<number, PackCatalogEntry[]>> = {
    data: new Map(),
    metadata: new Map(),
  };
  for (const pack of packs.packs) {
    const targetBytes =
      pack.view.packClass === "data"
        ? DATA_PACK_TARGET_BYTES
        : METADATA_PACK_TARGET_BYTES;
    if (
      selectedPackIds.has(pack.view.packId) ||
      pack.identity.size >= targetBytes / SIZE_TIER_FAN_IN ||
      !expired(pack.identity.mtimeMs, graceMs, now) ||
      pack.view.entries.length === 0 ||
      pack.view.entries.some(
        (entry) => !mark.liveKeys.has(recordKey(entry.kind, entry.logicalId)),
      )
    ) {
      continue;
    }
    const keys = livePackKeys(pack, mark);
    if (
      keys.length === 0 ||
      keys.some((key) =>
        selection.replacementKeys.has(recordKey(key.kind, key.logicalId)),
      )
    ) {
      continue;
    }
    const tiers = byClassAndTier[pack.view.packClass];
    const tier = physicalSizeTier(pack.identity.size);
    const candidates = tiers.get(tier) ?? [];
    candidates.push(pack);
    tiers.set(tier, candidates);
  }

  const groups: SizeTierRewriteGroup[] = [];
  for (const packClass of ["data", "metadata"] as const) {
    const tiers = byClassAndTier[packClass];
    for (const tier of [...tiers.keys()].sort((left, right) => left - right)) {
      const candidates = tiers
        .get(tier)!
        .sort((left, right) =>
          compareText(left.view.packId, right.view.packId),
        );
      if (candidates.length < SIZE_TIER_FAN_IN) continue;
      const group = candidates.slice(0, SIZE_TIER_FAN_IN);
      const inputBytes = group.reduce((total, pack) => {
        if (pack.identity.size > Number.MAX_SAFE_INTEGER - total) {
          throw new RangeError("size-tier input bytes exceed the safe limit");
        }
        return total + pack.identity.size;
      }, 0);
      groups.push(
        Object.freeze({
          packClass: group[0]!.view.packClass,
          packs: Object.freeze(group),
          inputBytes,
        }),
      );
      break;
    }
  }
  return Object.freeze(groups);
}

function extendWithSizeTierRewrite(
  selection: PackRewriteSelection,
  group: SizeTierRewriteGroup,
  baselineDecodedBytes: number,
  maximumCompactionObjects: number,
): PackRewriteSelection | undefined {
  const groupedKeys = new Map<
    string,
    { readonly key: LogicalRecordKey; readonly decodedLength: number }
  >();
  const requirements = new Map<string, ReadonlySet<string>>();
  for (const pack of group.packs) {
    const required = new Set<string>();
    for (const entry of pack.view.entries) {
      const key = logicalKey(entry.kind, entry.logicalId);
      const text = recordKey(key.kind, key.logicalId);
      required.add(text);
      const previous = groupedKeys.get(text);
      if (
        previous !== undefined &&
        previous.decodedLength !== entry.decodedLength
      ) {
        throw new GarbageCollectionNamespaceError(
          pack.path,
          `duplicate ${text} has inconsistent decoded lengths`,
        );
      }
      groupedKeys.set(text, { key, decodedLength: entry.decodedLength });
    }
    requirements.set(pack.view.packId, Object.freeze(required));
  }

  const additions = [...groupedKeys].filter(
    ([text]) => !selection.replacementKeys.has(text),
  );
  if (
    additions.length >
    maximumCompactionObjects - selection.replacementKeys.size
  ) {
    return undefined;
  }
  let decodedBytes = baselineDecodedBytes;
  for (const [, { decodedLength }] of additions) {
    if (
      !Number.isSafeInteger(decodedLength) ||
      decodedLength < 0 ||
      decodedLength > DEFAULT_COMPACTION_DECODED_BYTE_BUDGET - decodedBytes
    ) {
      return undefined;
    }
    decodedBytes += decodedLength;
  }

  const replacementKeys = new Map(selection.replacementKeys);
  for (const [text, { key }] of additions) replacementKeys.set(text, key);
  return Object.freeze({
    ...selection,
    partialPackIds: new Set([
      ...selection.partialPackIds,
      ...group.packs.map(({ view }) => view.packId),
    ]),
    replacementKeys,
    rewriteRequirements: new Map([
      ...selection.rewriteRequirements,
      ...requirements,
    ]),
  });
}

function selectCompaction(
  objects: MaintenanceInventory,
  packs: PackCatalogInventory,
  mark: MarkState,
  maximumCompactionObjects: number,
  graceMs: number,
  now: number,
): PackRewriteSelection {
  const replacementKeys = new Map<string, LogicalRecordKey>();
  const fullyDeadPackIds = new Set<string>();
  const partialPackIds = new Set<string>();
  const redundantPackIds = new Set<string>();
  const rewriteRequirements = new Map<string, Set<string>>();
  const opportunisticPackIds = new Set<string>();
  const opportunisticAddedKeys = new Map<string, ReadonlySet<string>>();
  const addKeys = (keys: readonly LogicalRecordKey[]): boolean => {
    const additions = [
      ...new Map(
        keys.map((key) => [recordKey(key.kind, key.logicalId), key] as const),
      ),
    ]
      .filter(([text]) => !replacementKeys.has(text))
      .map(([, key]) => key);
    if (additions.length > maximumCompactionObjects - replacementKeys.size) {
      return false;
    }
    for (const key of additions) {
      replacementKeys.set(recordKey(key.kind, key.logicalId), key);
    }
    return true;
  };

  const sortedPacks = [...packs.packs].sort((left, right) =>
    compareText(left.view.packId, right.view.packId),
  );
  const rewritePack = (
    pack: PackCatalogEntry,
    keys: readonly LogicalRecordKey[] = livePackKeys(pack, mark),
  ): boolean => {
    if (!addKeys(keys)) return false;
    partialPackIds.add(pack.view.packId);
    const required = rewriteRequirements.get(pack.view.packId) ?? new Set();
    for (const key of keys) {
      required.add(recordKey(key.kind, key.logicalId));
    }
    rewriteRequirements.set(pack.view.packId, required);
    return true;
  };

  const packOccurrences = new Map<
    string,
    Array<{ readonly pack: PackCatalogEntry; readonly entry: PackIndexEntry }>
  >();
  const contentPhysicalBytes = new Map<string, number>();
  const unpackedContentIds = new Set<string>();
  const noteContentPhysicalBytes = (logicalId: string, byteLength: number) => {
    const previous = contentPhysicalBytes.get(logicalId);
    if (previous === undefined || byteLength < previous) {
      contentPhysicalBytes.set(logicalId, byteLength);
    }
  };
  for (const pack of sortedPacks) {
    for (const entry of pack.view.entries) {
      if (entry.kind === "content") {
        noteContentPhysicalBytes(entry.logicalId, entry.length);
      }
      const text = recordKey(entry.kind, entry.logicalId);
      if (!mark.liveKeys.has(text)) continue;
      const candidates = packOccurrences.get(text) ?? [];
      candidates.push({ pack, entry });
      packOccurrences.set(text, candidates);
    }
  }
  for (const object of objects.objects) {
    if (
      !object.temporary &&
      object.logicalId !== undefined &&
      (object.kind === "legacy-blob" || object.kind === "loose-content")
    ) {
      noteContentPhysicalBytes(object.logicalId, object.byteLength);
      unpackedContentIds.add(object.logicalId);
    }
  }

  const liveLoose = objects.objects
    .filter((object) => !object.temporary && objectIsLive(object, mark))
    .sort(
      (left, right) =>
        compareText(left.kind, right.kind) ||
        compareText(left.logicalId ?? "", right.logicalId ?? ""),
    );
  for (const object of liveLoose) {
    addKeys(maintenanceObjectKeys(object, mark));
  }

  for (const pack of sortedPacks) {
    const live = pack.view.entries.filter((entry) =>
      mark.liveKeys.has(recordKey(entry.kind, entry.logicalId)),
    );
    const dead = pack.view.entries.length - live.length;
    const totalRecordBytes = pack.view.entries.reduce(
      (total, entry) => total + entry.length,
      0,
    );
    const liveRecordBytes = live.reduce(
      (total, entry) => total + entry.length,
      0,
    );
    const deadRecordBytes = totalRecordBytes - liveRecordBytes;
    const hasLiveDelta = live.some(({ encoding }) => encoding === "delta1");
    if (live.length === 0 && expired(pack.identity.mtimeMs, graceMs, now)) {
      fullyDeadPackIds.add(pack.view.packId);
      continue;
    }
    if (
      live.length === 0 ||
      dead === 0 ||
      (!hasLiveDelta &&
        dead * 100 < pack.view.entries.length * PARTIAL_PACK_REWRITE_PERCENT &&
        deadRecordBytes * 100 <
          totalRecordBytes * PARTIAL_PACK_REWRITE_PERCENT) ||
      !expired(pack.identity.mtimeMs, graceMs, now)
    ) {
      continue;
    }
    const keys = [
      ...new Map(
        live.map((entry) => {
          const key = logicalKey(entry.kind, entry.logicalId);
          return [recordKey(key.kind, key.logicalId), key] as const;
        }),
      ).values(),
    ];
    rewritePack(pack, keys);
  }

  // A newly loose revision may meet an already packed revision in this pass,
  // but never at the price of repeatedly rewriting a much larger clean pack.
  // When that gate declines, the new revision lands full in a small pack; a
  // later revision can then use that small generation as its bounded anchor.
  const selectedContent = new Set(
    [...replacementKeys.values()]
      .filter((key) => key.kind === "content")
      .map((key) => key.logicalId),
  );
  const byPath = new Map<string, Map<ContentId, number>>();
  for (const occurrence of mark.occurrences) {
    let counts = byPath.get(occurrence.canonicalPath);
    if (counts === undefined) {
      counts = new Map();
      byPath.set(occurrence.canonicalPath, counts);
    }
    counts.set(
      occurrence.contentId,
      (counts.get(occurrence.contentId) ?? 0) + 1,
    );
  }
  for (const path of [...byPath.keys()].sort(compareText)) {
    const counts = byPath.get(path)!;
    const selectedTargets = [...counts.keys()].filter((contentId) =>
      selectedContent.has(contentId),
    );
    if (selectedTargets.length === 0) {
      continue;
    }
    const candidates = [...counts]
      .filter(
        ([contentId]) =>
          !selectedContent.has(contentId) &&
          mark.liveKeys.has(recordKey("content", contentId)),
      )
      .sort(
        ([leftId, leftCount], [rightId, rightCount]) =>
          rightCount - leftCount || compareText(leftId, rightId),
      )
      .slice(0, DELTA1_MAX_ANCHORS_PER_PATH);
    const packedCandidates = new Map<string, PackCatalogEntry>();
    for (const [contentId] of candidates) {
      const text = recordKey("content", contentId);
      if (unpackedContentIds.has(contentId)) {
        if (addKeys([logicalKey("content", contentId)])) {
          selectedContent.add(contentId);
        }
        continue;
      }
      for (const packed of packOccurrences.get(text) ?? []) {
        if (packed.entry.decodedLength <= DELTA1_MAX_TARGET_BYTES) {
          packedCandidates.set(packed.pack.view.packId, packed.pack);
        }
      }
    }

    let selectedTargetBytes = 0;
    for (const contentId of selectedTargets) {
      const bytes = Math.min(
        contentPhysicalBytes.get(contentId) ?? 0,
        DELTA1_MAX_TARGET_BYTES,
      );
      if (bytes > Number.MAX_SAFE_INTEGER - selectedTargetBytes) {
        selectedTargetBytes = Number.MAX_SAFE_INTEGER;
        break;
      }
      selectedTargetBytes += bytes;
    }
    const source = [...packedCandidates.values()]
      .sort(
        (left, right) =>
          left.identity.size - right.identity.size ||
          compareText(left.view.packId, right.view.packId),
      )
      .find((pack) =>
        crossGenerationRewriteIsWorthwhile({
          selectedTargetBytes,
          sourcePackBytes: pack.identity.size,
        }),
      );
    const beforeRewrite = new Set(replacementKeys.keys());
    if (source !== undefined && rewritePack(source)) {
      opportunisticPackIds.add(source.view.packId);
      opportunisticAddedKeys.set(
        source.view.packId,
        Object.freeze(
          new Set(
            livePackKeys(source, mark)
              .map((key) => recordKey(key.kind, key.logicalId))
              .filter((text) => !beforeRewrite.has(text)),
          ),
        ),
      );
      for (const key of livePackKeys(source, mark)) {
        if (key.kind === "content") selectedContent.add(key.logicalId);
      }
    }
  }

  // Assign each duplicated logical record to one stable source pack. A pack
  // containing only non-owned copies can be removed without replacement. A
  // mixed pack is rewritten with its owned records when the bounded budget
  // permits; repeated passes therefore converge without an external cursor.
  const ownerByKey = new Map<string, string>();
  for (const [text, occurrences] of packOccurrences) {
    if (occurrences.length > 1) {
      ownerByKey.set(text, occurrences[0]!.pack.view.packId);
    }
  }
  for (const pack of sortedPacks) {
    const live = livePackKeys(pack, mark);
    if (live.length === 0) continue;
    const owned: LogicalRecordKey[] = [];
    let hasNonOwnedDuplicate = false;
    for (const key of live) {
      const text = recordKey(key.kind, key.logicalId);
      const owner = ownerByKey.get(text);
      if (owner === undefined || owner === pack.view.packId) {
        owned.push(key);
      } else {
        hasNonOwnedDuplicate = true;
      }
    }
    if (!hasNonOwnedDuplicate) continue;
    if (owned.length === 0) {
      if (!partialPackIds.has(pack.view.packId)) {
        redundantPackIds.add(pack.view.packId);
      }
      continue;
    }
    if (rewritePack(pack, owned)) {
      // Duplicate convergence already requires this rewrite independently of
      // any speculative delta benefit, so the later delta audit must not
      // cancel it.
      opportunisticPackIds.delete(pack.view.packId);
      opportunisticAddedKeys.delete(pack.view.packId);
    }
  }
  return Object.freeze({
    fullyDeadPackIds,
    partialPackIds,
    redundantPackIds,
    replacementKeys,
    rewriteRequirements: new Map(
      [...rewriteRequirements].map(([packId, required]) => [
        packId,
        Object.freeze(new Set(required)),
      ]),
    ),
    opportunisticPackIds: Object.freeze(new Set(opportunisticPackIds)),
    opportunisticAddedKeys: new Map(opportunisticAddedKeys),
  });
}

async function pruneUnproductiveCrossGenerationRewrites(
  selection: PackRewriteSelection,
  compaction: CompactionPlan,
  packs: PackCatalogInventory,
  resolver: CompactionResolver,
): Promise<PackRewriteSelection> {
  if (selection.opportunisticPackIds.size === 0) return selection;
  const packsById = new Map<string, PackCatalogEntry>(
    packs.packs.map((pack) => [pack.view.packId, pack] as const),
  );
  const deltaRecords = new Map<
    string,
    Extract<RecordEnvelope, { readonly kind: "content" }>
  >();
  for (const dependency of compaction.physicalDependencies) {
    const batch = compaction.batches[dependency.batchIndex];
    const delta = batch?.records.find(
      (record) =>
        record.kind === "content" &&
        record.logicalId === dependency.targetContentId &&
        record.encoding === "delta1",
    );
    if (delta?.kind === "content") {
      deltaRecords.set(dependency.targetContentId, delta);
    }
  }

  const fullRecordBytes = new Map<string, Promise<number>>();
  const readFullRecordBytes = (contentId: ContentId): Promise<number> => {
    let pending = fullRecordBytes.get(contentId);
    if (pending === undefined) {
      pending = resolver
        .readDecodedContent(contentId)
        .then(createContentRecord)
        .then((record) => encodeRecord(record).byteLength);
      fullRecordBytes.set(contentId, pending);
    }
    return pending;
  };

  const allIntroduced = new Set(
    [...selection.opportunisticAddedKeys.values()].flatMap((keys) => [...keys]),
  );
  const failed = new Set<string>();
  for (const packId of [...selection.opportunisticPackIds].sort(compareText)) {
    const pack = packsById.get(packId);
    const added = selection.opportunisticAddedKeys.get(packId) ?? new Set();
    if (pack === undefined || added.size === 0) {
      failed.add(packId);
      continue;
    }
    const seenTargets = new Set<string>();
    let actualSavedBytes = 0;
    for (const dependency of compaction.physicalDependencies) {
      const baseIntroduced = added.has(
        recordKey("content", dependency.baseContentId),
      );
      const targetIntroduced = added.has(
        recordKey("content", dependency.targetContentId),
      );
      const otherEndpoint = baseIntroduced
        ? recordKey("content", dependency.targetContentId)
        : recordKey("content", dependency.baseContentId);
      if (
        baseIntroduced === targetIntroduced ||
        allIntroduced.has(otherEndpoint) ||
        seenTargets.has(dependency.targetContentId)
      ) {
        continue;
      }
      const delta = deltaRecords.get(dependency.targetContentId);
      if (delta === undefined) continue;
      const saved =
        (await readFullRecordBytes(dependency.targetContentId)) -
        encodeRecord(delta).byteLength;
      if (saved <= 0) continue;
      seenTargets.add(dependency.targetContentId);
      actualSavedBytes += saved;
    }
    if (
      actualSavedBytes === 0 ||
      pack.identity.size >
        actualSavedBytes * MAX_CROSS_GENERATION_REWRITE_TO_SAVINGS_RATIO
    ) {
      failed.add(packId);
    }
  }
  if (failed.size === 0) return selection;

  const rewriteRequirements = new Map(
    [...selection.rewriteRequirements].filter(
      ([packId]) => !failed.has(packId),
    ),
  );
  const requiredByRetainedRewrites = new Set(
    [...rewriteRequirements.values()].flatMap((required) => [...required]),
  );
  const failedAdditions = new Set<string>();
  for (const packId of failed) {
    for (const text of selection.opportunisticAddedKeys.get(packId) ?? []) {
      failedAdditions.add(text);
    }
  }
  const replacementKeys = new Map(selection.replacementKeys);
  for (const text of failedAdditions) {
    if (!requiredByRetainedRewrites.has(text)) replacementKeys.delete(text);
  }
  return Object.freeze({
    ...selection,
    partialPackIds: new Set(
      [...selection.partialPackIds].filter((packId) => !failed.has(packId)),
    ),
    replacementKeys,
    rewriteRequirements,
    opportunisticPackIds: new Set(
      [...selection.opportunisticPackIds].filter(
        (packId) => !failed.has(packId),
      ),
    ),
    opportunisticAddedKeys: new Map(
      [...selection.opportunisticAddedKeys].filter(
        ([packId]) => !failed.has(packId),
      ),
    ),
  });
}

async function boundCompactionDecodedBytes(
  selection: PackRewriteSelection,
  inventories: {
    readonly objects: MaintenanceInventory;
    readonly packs: PackCatalogInventory;
  },
  maintenance: ObjectStoreMaintenance,
): Promise<PackRewriteSelection> {
  const lengths = new Map<string, number>();
  const updateLength = (text: string, length: number): void => {
    if (!selection.replacementKeys.has(text)) return;
    lengths.set(text, Math.max(lengths.get(text) ?? 0, length));
  };
  for (const pack of inventories.packs.packs) {
    for (const entry of pack.view.entries) {
      updateLength(recordKey(entry.kind, entry.logicalId), entry.decodedLength);
    }
  }
  const keysByLogicalId = new Map<string, LogicalRecordKey[]>();
  for (const key of selection.replacementKeys.values()) {
    const candidates = keysByLogicalId.get(key.logicalId) ?? [];
    candidates.push(key);
    keysByLogicalId.set(key.logicalId, candidates);
  }
  for (const object of inventories.objects.objects) {
    if (object.temporary || object.logicalId === undefined) continue;
    const candidates = keysByLogicalId.get(object.logicalId) ?? [];
    if (candidates.length === 0) continue;
    if (object.kind === "legacy-blob") {
      if (candidates.some(({ kind }) => kind === "content")) {
        updateLength(recordKey("content", object.logicalId), object.byteLength);
      }
      continue;
    }
    if (object.kind === "loose-structural") {
      for (const key of candidates) {
        if (
          key.kind === "tree-root" ||
          key.kind === "tree-node" ||
          key.kind === "scope"
        ) {
          updateLength(recordKey(key.kind, key.logicalId), object.byteLength);
        }
      }
      continue;
    }
    if (object.kind !== "loose-content" && object.kind !== "loose-recipe") {
      continue;
    }
    const bytes = await maintenance.readObject(
      inventories.objects,
      object,
      object.byteLength,
    );
    const envelope = decodeRecord(bytes, {
      maxDecodedBytes: Number.MAX_SAFE_INTEGER,
      maxPayloadBytes: bytes.byteLength,
    });
    const expectedKind = object.kind === "loose-content" ? "content" : "recipe";
    if (
      envelope.kind !== expectedKind ||
      envelope.logicalId !== object.logicalId
    ) {
      throw new GarbageCollectionNamespaceError(
        "objects",
        "loose record does not match its inventory namespace",
      );
    }
    updateLength(
      recordKey(envelope.kind, envelope.logicalId),
      envelope.decodedLength,
    );
  }

  const admitted = selectCompactionKeysWithinDecodedBudget(
    [...selection.replacementKeys.keys()].map((key) => ({
      key,
      decodedLength: lengths.get(key),
    })),
  );
  const replacementKeys = new Map(
    [...selection.replacementKeys].filter(([text]) => admitted.has(text)),
  );

  const partialPackIds = new Set<string>();
  const rewriteRequirements = new Map<string, ReadonlySet<string>>();
  for (const packId of selection.partialPackIds) {
    const required = selection.rewriteRequirements.get(packId);
    if (
      required === undefined ||
      [...required].some((text) => !replacementKeys.has(text))
    ) {
      continue;
    }
    partialPackIds.add(packId);
    rewriteRequirements.set(packId, required);
  }
  return Object.freeze({
    ...selection,
    replacementKeys,
    partialPackIds,
    rewriteRequirements,
  });
}

async function ensureLargeLegacyRepresentations(
  repository: ReturnType<typeof nativeObjectStoreRepository>,
  inventory: MaintenanceInventory,
  mark: MarkState,
  replacements: ReadonlyMap<string, LogicalRecordKey>,
  maximumNewLooseObjects: number,
  maximumNewReplacementKeys: number,
  authority: WorkspaceWriteAuthority,
): Promise<MaterializedContent> {
  const proofs: PublishedContent[] = [];
  const liveKeys = new Map<string, LogicalRecordKey>();
  const skippedContentIds = new Set<string>();
  let published = false;
  let remainingLooseObjects = maximumNewLooseObjects;
  let remainingReplacementKeys = maximumNewReplacementKeys;
  for (const object of inventory.objects) {
    if (
      object.kind !== "legacy-blob" ||
      object.temporary ||
      object.logicalId === undefined ||
      object.byteLength <= MAX_FULL_CONTENT_RECORD_BYTES ||
      !mark.liveKeys.has(recordKey("content", object.logicalId)) ||
      !replacements.has(recordKey("content", object.logicalId))
    ) {
      continue;
    }
    const contentId = object.logicalId;
    const maximumChunks =
      Math.ceil(object.byteLength / FASTCDC_V1_PROFILE.minimumBytes) + 1;
    // One content root, at most one full record per minimum-sized chunk,
    // recipe nodes bounded by the same public graph admission formula, and
    // one recipe root. This deliberately overestimates deduplication.
    const maximumGraphObjects =
      1 + maximumChunks + (maximumChunks * 2 + MAX_RECIPE_DEPTH) + 1;
    if (
      maximumGraphObjects > remainingLooseObjects ||
      maximumGraphObjects > remainingReplacementKeys
    ) {
      skippedContentIds.add(contentId);
      continue;
    }
    const materialized = await repository.materializeLooseContent(
      contentId,
      object.byteLength,
      async (sink) => {
        const source = await repository.streamContent(
          contentId,
          object.byteLength,
          sink,
        );
        if (source.decodedLength !== object.byteLength) {
          throw new Error("legacy content changed during lazy migration");
        }
      },
      authority,
    );
    const { proof } = materialized;
    if (materialized.disposition === "published") {
      published = true;
      remainingLooseObjects -= maximumGraphObjects;
      remainingReplacementKeys -= maximumGraphObjects;
    }
    proofs.push(proof);
    for (const dependency of proof.closure.objects) {
      if (dependency.retention !== "logical") continue;
      const key = logicalKey(dependency.kind, dependency.logicalId);
      liveKeys.set(recordKey(key.kind, key.logicalId), key);
    }
  }
  return Object.freeze({
    proofs: Object.freeze(proofs),
    liveKeys,
    skippedContentIds,
    published,
  });
}

async function ensureMultiPackIndex(
  catalog: PackCatalog,
  inventory: PackCatalogInventory,
  authority: WorkspaceWriteAuthority,
): Promise<void> {
  const cache = await catalog.readMultiPackIndexCache(inventory);
  if (cache.kind === "current") return;
  const built = catalog.rebuildMultiPackIndex(inventory);
  await catalog.publishMultiPackIndexCache(built, inventory, authority);
}

function countRemovedRecord(report: MutableReport, kind: RecordKind): void {
  report.removedRecords += 1;
  if (kind === "tree-root" || kind === "tree-node" || kind === "scope") {
    report.removedTrees += 1;
  } else {
    report.removedBlobs += 1;
  }
}

/**
 * Authenticate, compact, then sweep under the caller's exclusive workspace
 * lock. Every write before the final root fence is additive; deletion starts
 * only after the new packs, MIDX cache, complete rooted closure, and a second
 * metadata-root observation have all succeeded.
 */
export async function collectGarbage(
  authority: WorkspaceWriteAuthority,
  store: NativeObjectStore,
  metadata: Pick<CurrentMetadataStore, "listReferencedTreeOids">,
  options: GarbageCollectionOptions = {},
): Promise<GcReport> {
  const graceMs = options.graceMs ?? 3_600_000;
  const now = options.now ?? Date.now();
  const maxObjects = options.maxObjects ?? ABSOLUTE_MAX_GC_OBJECTS;
  const maxCompactionObjects =
    options.maxCompactionObjects ??
    Math.min(DEFAULT_MAX_COMPACTION_OBJECTS, maxObjects);
  if (
    !Number.isSafeInteger(graceMs) ||
    graceMs < 0 ||
    !Number.isFinite(now) ||
    now < 0 ||
    !Number.isSafeInteger(maxObjects) ||
    maxObjects <= 0 ||
    maxObjects > ABSOLUTE_MAX_GC_OBJECTS ||
    !Number.isSafeInteger(maxCompactionObjects) ||
    maxCompactionObjects <= 0 ||
    maxCompactionObjects > maxObjects
  ) {
    throw new RangeError(
      `garbage-collection options are outside their supported range (maximum ${ABSOLUTE_MAX_GC_OBJECTS} objects)`,
    );
  }

  const layout = nativeObjectStoreLayout(store, "garbage collection");
  const repository = nativeObjectStoreRepository(store, "garbage collection");
  const maintenance = new ObjectStoreMaintenance(layout);
  const maxCatalogPacks = Math.min(maxObjects, MAX_MULTI_PACK_INDEX_PACKS);
  const maxCatalogEntries = Math.min(maxObjects, MAX_MULTI_PACK_INDEX_ENTRIES);
  const maxIncomingFiles = Math.min(maxObjects, MAX_MULTI_PACK_INDEX_PACKS);
  const catalog = new PackCatalog(layout, {
    maxPacks: maxCatalogPacks,
    maxTotalPackBytes: Number.MAX_SAFE_INTEGER,
    maxIndexEntries: maxCatalogEntries,
    maxIncomingFiles,
    maxIncomingBytes: Number.MAX_SAFE_INTEGER,
  });
  const initialRoots = stableRoots(
    metadata.listReferencedTreeOids(maxObjects + 1),
  );
  if (initialRoots.length > maxObjects) {
    throw new RangeError(
      `refusing to sweep because the rooted object graph exceeds the ${maxObjects}-object limit`,
    );
  }
  let mark = await authenticateRoots(store, initialRoots, maxObjects);
  let inventories = await strictInventories(maintenance, catalog, maxObjects);
  let selection = selectCompaction(
    inventories.objects,
    inventories.packs,
    mark,
    maxCompactionObjects,
    graceMs,
    now,
  );
  selection = await boundCompactionDecodedBytes(
    selection,
    inventories,
    maintenance,
  );
  const plannedPacksById = new Map(
    inventories.packs.packs.map((entry) => [entry.view.packId, entry]),
  );

  // Large legacy files first become a normal chunk graph. This is additive;
  // an interruption leaves the still-rooted legacy bytes plus harmless loose
  // duplicates and the next pass resumes without persistent migration state.
  const initialHeadroom = maxObjects - inventoryObjectCount(inventories);
  const existingReplacementReservation = selection.replacementKeys.size * 2;
  const maximumNewLooseObjects = Math.floor(
    Math.max(0, initialHeadroom - existingReplacementReservation) / 2,
  );
  const materialized = await ensureLargeLegacyRepresentations(
    repository,
    inventories.objects,
    mark,
    selection.replacementKeys,
    maximumNewLooseObjects,
    Math.max(0, maxCompactionObjects - selection.replacementKeys.size),
    authority,
  );
  selection = omitReplacementKeys(selection, materialized.skippedContentIds);
  mark = extendLiveMark(mark, materialized.liveKeys, maxObjects);
  selection = extendCompactionSelection(
    selection,
    materialized.liveKeys,
    maxCompactionObjects,
  );
  inventories = await strictInventories(maintenance, catalog, maxObjects);
  selection = await boundCompactionDecodedBytes(
    selection,
    inventories,
    maintenance,
  );
  const resolver = new CompactionResolver(
    store,
    maintenance,
    inventories.objects,
    catalog,
    inventories.packs,
    mark,
  );
  let report!: MutableReport;
  const replacementPackIds = new Set<string>();
  try {
    await withRetainedCleanup(
      async () => {
        const planSelection = async (
          selected: PackRewriteSelection,
        ): Promise<CompactionPlan> => {
          const replacementContent = new Set(
            [...selected.replacementKeys.values()]
              .filter((key) => key.kind === "content")
              .map((key) => key.logicalId),
          );
          return await planCompaction({
            records: Object.freeze(
              [...selected.replacementKeys.values()].map((key) =>
                Object.freeze({ ...key, dependencies: Object.freeze([]) }),
              ),
            ),
            contentPathOccurrences: Object.freeze(
              mark.occurrences.filter((occurrence) =>
                replacementContent.has(occurrence.contentId),
              ),
            ),
            read: {
              readEnvelope: (key) => resolver.readEnvelope(key),
              readDecodedContent: (contentId) =>
                resolver.readDecodedContent(contentId),
            },
          });
        };
        let compaction = await planSelection(selection);
        const auditedSelection = await pruneUnproductiveCrossGenerationRewrites(
          selection,
          compaction,
          inventories.packs,
          resolver,
        );
        if (auditedSelection !== selection) {
          selection = auditedSelection;
          compaction = await planSelection(selection);
        }
        for (const group of sizeTierRewriteGroups(
          selection,
          inventories.packs,
          mark,
          graceMs,
          now,
        )) {
          const candidateSelection = extendWithSizeTierRewrite(
            selection,
            group,
            compactionPlanDecodedBytes(compaction),
            maxCompactionObjects,
          );
          if (candidateSelection === undefined) continue;
          const candidateCompaction = await planSelection(candidateSelection);
          if (
            !tieredRewriteIsConvergent({
              baseline: compactionPlanMetrics(compaction),
              candidate: compactionPlanMetrics(candidateCompaction),
              packClass: group.packClass,
              sourcePacks: group.packs.length,
              sourceBytes: group.inputBytes,
            })
          ) {
            continue;
          }
          selection = candidateSelection;
          compaction = candidateCompaction;
        }
        const plannedPackEntries = compaction.batches.reduce(
          (total, batch) => total + batch.records.length,
          0,
        );
        const capacityFor = (
          newRecords: number,
          newPacks: number,
          largestIncomingBytes: number,
        ): boolean =>
          compactionFitsAdditiveCapacity({
            newRecords,
            newPacks,
            largestIncomingBytes,
            currentObjects: inventoryObjectCount(inventories),
            currentIndexEntries: inventories.packs.totalIndexEntries,
            currentPacks: inventories.packs.packs.length,
            currentIncomingFiles: inventories.packs.incomingFiles,
            currentIncomingBytes: inventories.packs.incomingBytes,
            maxObjects,
            maxIndexEntries: maxCatalogEntries,
            maxPacks: maxCatalogPacks,
            maxIncomingFiles,
            maxIncomingBytes: Number.MAX_SAFE_INTEGER,
          });
        if (!capacityFor(plannedPackEntries, compaction.batches.length, 0)) {
          // `maxObjects` is an operational admission bound, not a quota. Do not
          // publish an additive replacement that the mandatory final inventory
          // could no longer admit. Dead and redundant containers can still be
          // removed in this pass, making room for a later bounded rewrite.
          selection = withoutReplacementWork(selection);
          compaction = await planCompaction({
            records: Object.freeze([]),
            contentPathOccurrences: Object.freeze([]),
            read: {
              readEnvelope: (key) => resolver.readEnvelope(key),
              readDecodedContent: (contentId) =>
                resolver.readDecodedContent(contentId),
            },
          });
        }

        let encodedBatches: Array<Awaited<ReturnType<typeof encodePack>>> = [];
        for (const batch of compaction.batches) {
          encodedBatches.push(
            await encodePack(batch, {
              verifyMetadataId: (_kind, id, decoded) =>
                contentIdFromBytes(decoded) === String(id),
              verifyChunkedContent: (input) =>
                resolver.verifyChunkedPublication(input),
            }),
          );
        }
        if (encodedBatches.length > 0) {
          const existingPackIds = new Set(
            inventories.packs.packs.map(({ view }) => view.packId),
          );
          const uniqueEncoded = new Map(
            encodedBatches.map(
              (encoded) => [encoded.pack.packId, encoded] as const,
            ),
          );
          encodedBatches = [...uniqueEncoded.values()];
          const newEncoded = encodedBatches.filter(
            ({ pack }) => !existingPackIds.has(pack.packId),
          );
          const newRecords = newEncoded.reduce(
            (total, { pack }) => total + pack.entries.length,
            0,
          );
          const largestIncomingBytes = newEncoded.reduce(
            (maximum, { bytes }) => Math.max(maximum, bytes.byteLength),
            0,
          );
          let prospectiveFits = capacityFor(
            newRecords,
            newEncoded.length,
            largestIncomingBytes,
          );
          if (prospectiveFits) {
            const views = new Map(
              inventories.packs.views.map(
                (view) => [view.packId, view] as const,
              ),
            );
            for (const encoded of newEncoded) {
              views.set(encoded.pack.packId, encoded.pack.indexView());
            }
            try {
              buildMultiPackIndexFromViews([...views.values()]);
            } catch (error) {
              if (
                error instanceof MultiPackIndexError &&
                error.code === "limit-exceeded"
              ) {
                prospectiveFits = false;
              } else {
                throw error;
              }
            }
          }
          if (!prospectiveFits) {
            selection = withoutReplacementWork(selection);
            encodedBatches = [];
          }
        }

        report = {
          removedTrees: 0,
          removedBlobs: 0,
          removedTmpFiles: 0,
          freedBytes: 0,
          keptObjects: 0,
          removedRecords: 0,
          removedPacks: 0,
          compactedObjects: 0,
          writtenPacks: 0,
        };
        try {
          for (const encoded of encodedBatches) {
            const published = await catalog.publishPack(encoded, authority);
            replacementPackIds.add(published.view.packId);
            if (published.disposition === "published") report.writtenPacks += 1;
          }
          inventories = await strictInventories(
            maintenance,
            catalog,
            maxObjects,
          );
          const publishedPackIds = new Set<string>(
            inventories.packs.packs.map(({ view }) => view.packId),
          );
          for (const packId of replacementPackIds) {
            if (!publishedPackIds.has(packId)) {
              throw new GarbageCollectionNamespaceError(
                layout.packs,
                `replacement pack ${packId} disappeared before cutover`,
              );
            }
          }
          await ensureMultiPackIndex(catalog, inventories.packs, authority);
        } catch (error) {
          mapInfrastructureError(layout.packs, error);
        }
      },
      () => resolver.dispose(),
      "garbage collection and compaction cleanup both failed",
    );
  } catch (error) {
    rethrowGarbageCollectionPrimary(error);
  }

  // Final fence: strict current inventory, complete logical authentication,
  // then another root observation immediately before the first unlink.
  inventories = await strictInventories(maintenance, catalog, maxObjects);
  const rootsBeforeVerification = stableRoots(
    metadata.listReferencedTreeOids(maxObjects + 1),
  );
  if (!sameStrings(initialRoots, rootsBeforeVerification)) {
    throw new GarbageCollectionRootDriftError();
  }
  for (const proof of materialized.proofs) {
    await repository.revalidatePublishedContent(
      proof,
      repository.maxDecodedBytes,
    );
  }
  mark = await authenticateRoots(store, initialRoots, maxObjects);
  mark = extendLiveMark(mark, materialized.liveKeys, maxObjects);
  mark = withAuthenticatedStructuralCoverage(mark, inventories.objects);
  const removableObjects: MaintenanceObject[] = [];
  for (const object of inventories.objects.objects) {
    const isExpired = expired(object.modifiedAt, graceMs, now);
    if (object.temporary) {
      if (isExpired) removableObjects.push(object);
      continue;
    }
    const live = objectIsLive(object, mark);
    if (!live) {
      if (isExpired) removableObjects.push(object);
      continue;
    }
    const keys = maintenanceObjectKeys(object, mark);
    if (
      keys.length > 0 &&
      keys.every((key) =>
        selection.replacementKeys.has(recordKey(key.kind, key.logicalId)),
      )
    ) {
      removableObjects.push(object);
    }
  }

  const removablePacks: PackCatalogEntry[] = [];
  for (const pack of inventories.packs.packs) {
    if (replacementPackIds.has(pack.view.packId)) continue;
    const liveKeys = [
      ...new Map(
        pack.view.entries
          .filter((entry) =>
            mark.liveKeys.has(recordKey(entry.kind, entry.logicalId)),
          )
          .map((entry) => {
            const key = logicalKey(entry.kind, entry.logicalId);
            return [recordKey(key.kind, key.logicalId), key] as const;
          }),
      ).values(),
    ];
    if (
      liveKeys.length === 0 &&
      selection.fullyDeadPackIds.has(pack.view.packId) &&
      expired(pack.identity.mtimeMs, graceMs, now)
    ) {
      removablePacks.push(pack);
      continue;
    }
    if (
      selection.partialPackIds.has(pack.view.packId) ||
      (selection.redundantPackIds.has(pack.view.packId) &&
        expired(pack.identity.mtimeMs, graceMs, now))
    ) {
      removablePacks.push(pack);
    }
  }
  for (const pack of removablePacks) {
    const expected = plannedPacksById.get(pack.view.packId);
    if (
      expected === undefined ||
      !identitiesEqual(expected.identity, pack.identity)
    ) {
      throw new GarbageCollectionNamespaceError(
        pack.path,
        "pack changed between planning and cutover",
      );
    }
  }

  const removableObjectSet = new Set(removableObjects);
  const removablePackIdSet = new Set(
    removablePacks.map(({ view }) => view.packId),
  );
  const coverageResolver = new CompactionResolver(
    store,
    maintenance,
    inventories.objects,
    catalog,
    inventories.packs,
    mark,
  );
  try {
    await withRetainedCleanup(
      () =>
        authenticateRetainedCoverage(
          inventories,
          mark,
          coverageResolver,
          removableObjectSet,
          removablePackIdSet,
          replacementPackIds,
          mark.authenticatedCoverage,
        ),
      () => coverageResolver.dispose(),
      "retained-coverage authentication and cleanup both failed",
    );
  } catch (error) {
    rethrowGarbageCollectionPrimary(error);
  }

  try {
    for (const object of removableObjects) {
      if (
        !(await maintenance.objectIdentityStillCurrent(
          inventories.objects,
          object,
        ))
      ) {
        throw new GarbageCollectionNamespaceError(
          layout.objects,
          "object changed between final inventory and cutover",
        );
      }
    }
    for (const pack of removablePacks) {
      if (!(await catalog.packIdentityStillCurrent(pack))) {
        throw new GarbageCollectionNamespaceError(
          pack.path,
          "pack changed between final inventory and cutover",
        );
      }
    }
  } catch (error) {
    mapInfrastructureError(layout.objects, error);
  }

  const removableIncoming = inventories.packs.incoming.filter((incoming) =>
    expired(incoming.identity.mtimeMs, graceMs, now),
  );
  if (
    removableObjects.length > 0 ||
    removablePacks.length > 0 ||
    removableIncoming.length > 0
  ) {
    const rootsAtCutover = stableRoots(
      metadata.listReferencedTreeOids(maxObjects + 1),
    );
    if (!sameStrings(initialRoots, rootsAtCutover)) {
      throw new GarbageCollectionRootDriftError();
    }
    assertWorkspaceWriteAuthority(authority, layout.root);
  }

  try {
    for (const object of removableObjects) {
      const wasLive = objectIsLive(object, mark);
      const bytes = await maintenance.removeObject(
        inventories.objects,
        object,
        authority,
      );
      report.freedBytes += bytes;
      if (object.temporary) {
        report.removedTmpFiles += 1;
      } else {
        if (object.kind === "loose-content" || object.kind === "loose-recipe") {
          report.removedRecords += 1;
        }
        if (wasLive) {
          report.compactedObjects += 1;
        } else if (object.kind === "loose-structural") {
          report.removedTrees += 1;
        } else {
          report.removedBlobs += 1;
        }
      }
    }
  } catch (error) {
    mapInfrastructureError(layout.objects, error);
  }

  try {
    for (const pack of removablePacks) {
      await catalog.removePack(pack, authority);
      report.removedPacks += 1;
      report.freedBytes += pack.identity.size;
      for (const entry of pack.view.entries) {
        if (!mark.liveKeys.has(recordKey(entry.kind, entry.logicalId))) {
          countRemovedRecord(report, entry.kind);
        }
      }
    }
    for (const incoming of removableIncoming) {
      await catalog.removeIncoming(incoming, authority);
      report.removedTmpFiles += 1;
      report.freedBytes += incoming.identity.size;
    }
    const afterDeletion = await catalog.inventory();
    await ensureMultiPackIndex(catalog, afterDeletion, authority);
  } catch (error) {
    mapInfrastructureError(layout.packs, error);
  }

  report.keptObjects += inventories.objects.objects.filter(
    (object) => !object.temporary && !removableObjectSet.has(object),
  ).length;
  const removedPackIds = new Set(removablePacks.map(({ view }) => view.packId));
  report.keptObjects += inventories.packs.packs
    .filter(({ view }) => !removedPackIds.has(view.packId))
    .reduce((count, pack) => count + pack.view.entries.length, 0);
  return Object.freeze({ ...report });
}
