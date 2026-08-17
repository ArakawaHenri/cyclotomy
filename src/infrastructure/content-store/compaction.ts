import { timingSafeEqual } from "node:crypto";

import { CHUNKED_CONTENT_MIN_BYTES } from "./chunk-recipe.ts";
import {
  contentIdFromBytes,
  parseContentId,
  parseMetadataId,
  parseRecipeId,
  type ContentId,
  type MetadataId,
  type RecipeId,
} from "./ids.ts";
import {
  DATA_PACK_HARD_MAX_BYTES,
  DATA_PACK_TARGET_BYTES,
  MAX_FULL_CONTENT_RECORD_BYTES,
  MAX_METADATA_RECORD_BYTES,
  MAX_PACK_RECORDS,
  METADATA_PACK_HARD_MAX_BYTES,
  METADATA_PACK_MULTI_RECORD_MAX_BYTES,
  METADATA_PACK_TARGET_BYTES,
  measurePackInputBytes,
  packPlanningUpperBoundBytes,
  packClassForRecordKind,
  type EncodePackInput,
  type PackClass,
} from "./pack.ts";
import {
  DELTA1_MAX_BASE_BYTES,
  DELTA1_MAX_BASE_BACK_DISTANCE,
  DELTA1_MAX_PAYLOAD_BYTES,
  DELTA1_MAX_TARGET_BYTES,
  encodeDelta1Program,
  measureDelta1ProgramBytes,
  type Delta1Instruction,
} from "./pack-delta.ts";
import { encodeRecord, recordKindCode, type RecordEnvelope } from "./record.ts";
import { createContentRecord } from "./representation.ts";

export const DELTA1_MAX_ANCHORS_PER_PATH = 8;
export const DELTA1_MAX_CANDIDATES_PER_TARGET = 4;
export const DELTA1_MIN_SAVED_BYTES = 128;
export const DELTA1_MIN_SAVED_PERCENT = 35;
export const DELTA1_MAX_LENGTH_DIFFERENCE_PERCENT = 25;
/** Conservative decoded-byte admission budget for one maintenance plan. */
export const DEFAULT_COMPACTION_DECODED_BYTE_BUDGET = DATA_PACK_TARGET_BYTES;

export type LogicalRecordKey =
  | { readonly kind: "content"; readonly logicalId: ContentId }
  | { readonly kind: "recipe"; readonly logicalId: RecipeId }
  | {
      readonly kind: "tree-root" | "tree-node" | "scope";
      readonly logicalId: MetadataId;
    };

export type LiveCompactionRecord = LogicalRecordKey & {
  /** Authenticated logical dependencies already discovered by GC marking. */
  readonly dependencies: readonly LogicalRecordKey[];
};

/** One occurrence in retained snapshot history; repetitions carry frequency. */
export interface ContentPathOccurrence {
  readonly canonicalPath: string;
  readonly contentId: ContentId;
}

export interface CompactionReadAccess {
  /** Returns one already-authenticated representation for the logical record. */
  readonly readEnvelope: (key: LogicalRecordKey) => Promise<RecordEnvelope>;
  /** Returns already-authenticated decoded content bytes. */
  readonly readDecodedContent: (contentId: ContentId) => Promise<Uint8Array>;
}

export interface CompactionPackLimits {
  readonly dataTargetBytes: number;
  readonly dataHardMaxBytes: number;
  readonly metadataTargetBytes: number;
  readonly metadataMultiRecordHardMaxBytes: number;
  readonly metadataSingletonHardMaxBytes: number;
  readonly maxRecordsPerPack: number;
}

export const DEFAULT_COMPACTION_PACK_LIMITS: CompactionPackLimits =
  Object.freeze({
    dataTargetBytes: DATA_PACK_TARGET_BYTES,
    dataHardMaxBytes: DATA_PACK_HARD_MAX_BYTES,
    metadataTargetBytes: METADATA_PACK_TARGET_BYTES,
    metadataMultiRecordHardMaxBytes: METADATA_PACK_MULTI_RECORD_MAX_BYTES,
    metadataSingletonHardMaxBytes: METADATA_PACK_HARD_MAX_BYTES,
    maxRecordsPerPack: MAX_PACK_RECORDS,
  });

export interface LogicalDependencyFact {
  readonly source: LogicalRecordKey;
  readonly dependencies: readonly LogicalRecordKey[];
}

export interface Delta1DependencyFact {
  readonly encoding: "delta1";
  readonly batchIndex: number;
  readonly targetContentId: ContentId;
  readonly baseContentId: ContentId;
}

export interface CompactionPlan {
  readonly batches: readonly EncodePackInput[];
  readonly logicalDependencies: readonly LogicalDependencyFact[];
  readonly physicalDependencies: readonly Delta1DependencyFact[];
}

export interface PlanCompactionInput {
  readonly records: readonly LiveCompactionRecord[];
  readonly contentPathOccurrences: readonly ContentPathOccurrence[];
  readonly read: CompactionReadAccess;
  readonly packLimits?: CompactionPackLimits;
}

export type CompactionPlanningErrorCode =
  "invalid-input" | "integrity" | "limit-exceeded";

export class CompactionPlanningError extends Error {
  readonly code: CompactionPlanningErrorCode;

  constructor(code: CompactionPlanningErrorCode, message: string) {
    super(message);
    this.name = "CompactionPlanningError";
    this.code = code;
  }
}

interface SmallContent {
  readonly contentId: ContentId;
  readonly decoded: Uint8Array;
  readonly full: Extract<RecordEnvelope, { readonly kind: "content" }>;
}

interface PendingDeltaFact {
  readonly targetContentId: ContentId;
  readonly baseContentId: ContentId;
}

interface PendingBatch {
  readonly packClass: PackClass;
  readonly records: readonly RecordEnvelope[];
  readonly deltas: readonly PendingDeltaFact[];
}

function invalid(code: CompactionPlanningErrorCode, message: string): never {
  throw new CompactionPlanningError(code, message);
}

function cloneEnvelope(record: RecordEnvelope): RecordEnvelope {
  return {
    ...record,
    payload: Uint8Array.from(record.payload),
  } as RecordEnvelope;
}

function cloneKey(key: LogicalRecordKey): LogicalRecordKey {
  switch (key.kind) {
    case "content":
      return Object.freeze({ kind: key.kind, logicalId: key.logicalId });
    case "recipe":
      return Object.freeze({ kind: key.kind, logicalId: key.logicalId });
    case "tree-root":
    case "tree-node":
    case "scope":
      return Object.freeze({ kind: key.kind, logicalId: key.logicalId });
  }
}

function keyText(key: LogicalRecordKey): string {
  return `${recordKindCode(key.kind)}:${key.logicalId}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareCanonicalPaths(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function compareKeys(left: LogicalRecordKey, right: LogicalRecordKey): number {
  return (
    recordKindCode(left.kind) - recordKindCode(right.kind) ||
    compareText(left.logicalId, right.logicalId)
  );
}

function parseKey(key: LogicalRecordKey): LogicalRecordKey {
  switch (key.kind) {
    case "content":
      return { kind: key.kind, logicalId: parseContentId(key.logicalId) };
    case "recipe":
      return { kind: key.kind, logicalId: parseRecipeId(key.logicalId) };
    case "tree-root":
    case "tree-node":
    case "scope":
      return { kind: key.kind, logicalId: parseMetadataId(key.logicalId) };
  }
}

function assertPositiveIntegerWithin(
  value: number,
  maximum: number,
  label: string,
): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    invalid(
      "invalid-input",
      `${label} must be a positive safe integer no greater than ${maximum}`,
    );
  }
}

function validateLimits(limits: CompactionPackLimits): void {
  assertPositiveIntegerWithin(
    limits.dataHardMaxBytes,
    DATA_PACK_HARD_MAX_BYTES,
    "data hard maximum",
  );
  assertPositiveIntegerWithin(
    limits.dataTargetBytes,
    limits.dataHardMaxBytes,
    "data target",
  );
  assertPositiveIntegerWithin(
    limits.metadataSingletonHardMaxBytes,
    METADATA_PACK_HARD_MAX_BYTES,
    "metadata singleton hard maximum",
  );
  assertPositiveIntegerWithin(
    limits.metadataMultiRecordHardMaxBytes,
    Math.min(
      limits.metadataSingletonHardMaxBytes,
      METADATA_PACK_MULTI_RECORD_MAX_BYTES,
    ),
    "metadata multi-record hard maximum",
  );
  assertPositiveIntegerWithin(
    limits.metadataTargetBytes,
    limits.metadataMultiRecordHardMaxBytes,
    "metadata target",
  );
  assertPositiveIntegerWithin(
    limits.maxRecordsPerPack,
    MAX_PACK_RECORDS,
    "maximum records per pack",
  );
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    timingSafeEqual(Buffer.from(left), Buffer.from(right))
  );
}

function encodedRecordBytes(record: RecordEnvelope): number {
  return encodeRecord(record).byteLength;
}

class BatchBuilder {
  readonly #packClass: PackClass;
  readonly #targetBytes: number;
  readonly #multiRecordHardMaxBytes: number;
  readonly #singletonHardMaxBytes: number;
  readonly #maxRecords: number;
  readonly #records: RecordEnvelope[] = [];
  readonly #deltas: PendingDeltaFact[] = [];
  #encodedRecordBytes = 0;

  constructor(packClass: PackClass, limits: CompactionPackLimits) {
    this.#packClass = packClass;
    this.#targetBytes =
      packClass === "data"
        ? limits.dataTargetBytes
        : limits.metadataTargetBytes;
    this.#multiRecordHardMaxBytes =
      packClass === "data"
        ? limits.dataHardMaxBytes
        : limits.metadataMultiRecordHardMaxBytes;
    this.#singletonHardMaxBytes =
      packClass === "data"
        ? limits.dataHardMaxBytes
        : limits.metadataSingletonHardMaxBytes;
    this.#maxRecords = limits.maxRecordsPerPack;
  }

  get length(): number {
    return this.#records.length;
  }

  tryAdd(record: RecordEnvelope, delta?: PendingDeltaFact): boolean {
    if (packClassForRecordKind(record.kind) !== this.#packClass) {
      invalid("invalid-input", "record does not belong to this pack class");
    }
    if (this.#records.length === 0) {
      const exact = measurePackInputBytes({
        packClass: this.#packClass,
        records: [record],
      });
      if (exact > this.#singletonHardMaxBytes) {
        invalid(
          "limit-exceeded",
          `${record.kind} ${record.logicalId} cannot fit in a legal singleton pack`,
        );
      }
      this.#records.push(record);
      this.#encodedRecordBytes = encodedRecordBytes(record);
      if (delta !== undefined) {
        this.#deltas.push(delta);
      }
      return true;
    }
    if (this.#records.length >= this.#maxRecords) {
      return false;
    }
    const recordBytes = encodedRecordBytes(record);
    if (recordBytes > Number.MAX_SAFE_INTEGER - this.#encodedRecordBytes) {
      invalid("limit-exceeded", "planned record bytes exceed the safe limit");
    }
    const nextEncodedRecordBytes = this.#encodedRecordBytes + recordBytes;
    const limit = Math.min(this.#targetBytes, this.#multiRecordHardMaxBytes);
    if (
      packPlanningUpperBoundBytes(
        this.#records.length + 1,
        nextEncodedRecordBytes,
      ) > limit
    ) {
      return false;
    }
    this.#records.push(record);
    this.#encodedRecordBytes = nextEncodedRecordBytes;
    if (delta !== undefined) {
      this.#deltas.push(delta);
    }
    return true;
  }

  tryAddDependencyPair(
    base: RecordEnvelope,
    delta: RecordEnvelope,
    fact: PendingDeltaFact,
  ): boolean {
    if (this.#records.length !== 0) {
      invalid("invalid-input", "dependency pair requires an empty pack");
    }
    if (this.#maxRecords < 2) {
      return false;
    }
    const pair: EncodePackInput = {
      packClass: this.#packClass,
      records: [base, delta],
    };
    if (
      measurePackInputBytes(pair) >
      Math.min(this.#targetBytes, this.#multiRecordHardMaxBytes)
    ) {
      return false;
    }
    this.#records.push(base, delta);
    this.#encodedRecordBytes =
      encodedRecordBytes(base) + encodedRecordBytes(delta);
    this.#deltas.push({ ...fact });
    return true;
  }

  singletonExceedsTarget(): boolean {
    return (
      this.#records.length === 1 &&
      measurePackInputBytes({
        packClass: this.#packClass,
        records: this.#records,
      }) > this.#targetBytes
    );
  }

  take(): PendingBatch | undefined {
    if (this.#records.length === 0) {
      return undefined;
    }
    const result: PendingBatch = {
      packClass: this.#packClass,
      records: Object.freeze([...this.#records]),
      deltas: Object.freeze(this.#deltas.map((fact) => ({ ...fact }))),
    };
    this.#records.length = 0;
    this.#deltas.length = 0;
    this.#encodedRecordBytes = 0;
    return result;
  }
}

function simpleDeltaInstructions(
  base: Uint8Array,
  target: Uint8Array,
): readonly Delta1Instruction[] | undefined {
  if (
    base.byteLength > DELTA1_MAX_BASE_BYTES ||
    target.byteLength > DELTA1_MAX_TARGET_BYTES ||
    target.byteLength === 0 ||
    bytesEqual(base, target)
  ) {
    return undefined;
  }
  const sharedLimit = Math.min(base.byteLength, target.byteLength);
  let prefixLength = 0;
  while (
    prefixLength < sharedLimit &&
    base[prefixLength] === target[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < sharedLimit - prefixLength &&
    base[base.byteLength - suffixLength - 1] ===
      target[target.byteLength - suffixLength - 1]
  ) {
    suffixLength += 1;
  }

  const instructions: Delta1Instruction[] = [];
  if (prefixLength > 0) {
    instructions.push({
      kind: "copy",
      baseOffset: 0,
      byteLength: prefixLength,
    });
  }
  const middleEnd = target.byteLength - suffixLength;
  if (middleEnd > prefixLength) {
    instructions.push({
      kind: "add",
      bytes: target.slice(prefixLength, middleEnd),
    });
  }
  if (suffixLength > 0) {
    instructions.push({
      kind: "copy",
      baseOffset: base.byteLength - suffixLength,
      byteLength: suffixLength,
    });
  }
  return instructions.length === 0 ? undefined : Object.freeze(instructions);
}

function usefulDelta(fullBytes: number, deltaBytes: number): boolean {
  const savedBytes = fullBytes - deltaBytes;
  return (
    savedBytes >= DELTA1_MIN_SAVED_BYTES &&
    savedBytes * 100 >= fullBytes * DELTA1_MIN_SAVED_PERCENT
  );
}

function lengthsAreNear(left: number, right: number): boolean {
  const maximum = Math.max(left, right);
  return (
    maximum > 0 &&
    Math.abs(left - right) * 100 <=
      maximum * DELTA1_MAX_LENGTH_DIFFERENCE_PERCENT
  );
}

function deltaRecord(
  target: SmallContent,
  base: SmallContent,
  baseBackDistance: number,
): Extract<RecordEnvelope, { readonly kind: "content" }> | undefined {
  if (
    baseBackDistance <= 0 ||
    baseBackDistance > DELTA1_MAX_BASE_BACK_DISTANCE
  ) {
    return undefined;
  }
  const instructions = simpleDeltaInstructions(base.decoded, target.decoded);
  if (instructions === undefined) {
    return undefined;
  }
  const program = { baseBackDistance, instructions } as const;
  const encodedLength = measureDelta1ProgramBytes(
    program,
    target.decoded.byteLength,
  );
  if (
    encodedLength > DELTA1_MAX_PAYLOAD_BYTES ||
    !usefulDelta(target.full.payload.byteLength, encodedLength)
  ) {
    return undefined;
  }
  const payload = encodeDelta1Program(program, target.decoded.byteLength);
  return {
    kind: "content",
    encoding: "delta1",
    logicalId: target.contentId,
    decodedLength: target.decoded.byteLength,
    payload,
  };
}

function occurrenceCounts(
  occurrences: readonly ContentPathOccurrence[],
  liveContentIds: ReadonlySet<ContentId>,
  smallContent: ReadonlyMap<ContentId, SmallContent>,
): ReadonlyMap<string, ReadonlyMap<ContentId, number>> {
  const mutable = new Map<string, Map<ContentId, number>>();
  for (const occurrence of occurrences) {
    if (
      occurrence.canonicalPath.length === 0 ||
      occurrence.canonicalPath.includes("\0")
    ) {
      invalid(
        "invalid-input",
        "canonical content path is empty or contains NUL",
      );
    }
    const contentId = parseContentId(occurrence.contentId);
    if (!liveContentIds.has(contentId)) {
      invalid(
        "invalid-input",
        `content occurrence references non-live content ${contentId}`,
      );
    }
    if (!smallContent.has(contentId)) {
      continue;
    }
    let byContent = mutable.get(occurrence.canonicalPath);
    if (byContent === undefined) {
      byContent = new Map();
      mutable.set(occurrence.canonicalPath, byContent);
    }
    const previous = byContent.get(contentId) ?? 0;
    if (previous === Number.MAX_SAFE_INTEGER) {
      invalid(
        "limit-exceeded",
        "content occurrence count exceeds the safe limit",
      );
    }
    byContent.set(contentId, previous + 1);
  }
  return mutable;
}

interface RankedContent {
  readonly content: SmallContent;
  readonly occurrences: number;
}

function rankPathContents(
  counts: ReadonlyMap<ContentId, number>,
  small: ReadonlyMap<ContentId, SmallContent>,
): readonly RankedContent[] {
  return [...counts]
    .map(([contentId, occurrences]) => {
      const content = small.get(contentId);
      if (content === undefined) {
        invalid("invalid-input", `missing live content ${contentId}`);
      }
      return { content, occurrences };
    })
    .sort(
      (left, right) =>
        right.occurrences - left.occurrences ||
        left.content.decoded.byteLength - right.content.decoded.byteLength ||
        compareText(left.content.contentId, right.content.contentId),
    );
}

function candidateAnchors(
  target: SmallContent,
  anchors: readonly RankedContent[],
): readonly RankedContent[] {
  return anchors
    .filter(({ content }) =>
      lengthsAreNear(target.decoded.byteLength, content.decoded.byteLength),
    )
    .sort(
      (left, right) =>
        Math.abs(target.decoded.byteLength - left.content.decoded.byteLength) -
          Math.abs(
            target.decoded.byteLength - right.content.decoded.byteLength,
          ) ||
        right.occurrences - left.occurrences ||
        left.content.decoded.byteLength - right.content.decoded.byteLength ||
        compareText(left.content.contentId, right.content.contentId),
    )
    .slice(0, DELTA1_MAX_CANDIDATES_PER_TARGET);
}

function selectAnchorsByPath(
  countsByPath: ReadonlyMap<string, ReadonlyMap<ContentId, number>>,
  small: ReadonlyMap<ContentId, SmallContent>,
): {
  readonly anchorIds: ReadonlySet<ContentId>;
  readonly anchorsByPath: ReadonlyMap<string, readonly RankedContent[]>;
} {
  const anchorIds = new Set<ContentId>();
  const anchorsByPath = new Map<string, readonly RankedContent[]>();
  for (const path of [...countsByPath.keys()].sort(compareCanonicalPaths)) {
    const counts = countsByPath.get(path);
    if (counts === undefined) {
      continue;
    }
    const ranked = rankPathContents(counts, small);
    const anchors: RankedContent[] = [];
    // A ranked version becomes an anchor only when the existing bounded
    // anchors cannot encode it profitably. Merely having fewer than eight
    // historical versions must not force every version to remain full.
    for (const candidate of ranked) {
      const usefulExistingAnchor = candidateAnchors(
        candidate.content,
        anchors,
      ).some(
        ({ content }) =>
          deltaRecord(candidate.content, content, 1) !== undefined,
      );
      if (
        !usefulExistingAnchor &&
        anchors.length < DELTA1_MAX_ANCHORS_PER_PATH
      ) {
        anchors.push(candidate);
        anchorIds.add(candidate.content.contentId);
      }
    }
    anchorsByPath.set(path, Object.freeze([...anchors]));
  }
  return { anchorIds, anchorsByPath };
}

function chooseDeltaBases(
  small: ReadonlyMap<ContentId, SmallContent>,
  countsByPath: ReadonlyMap<string, ReadonlyMap<ContentId, number>>,
  anchorsByPath: ReadonlyMap<string, readonly RankedContent[]>,
  anchorIds: ReadonlySet<ContentId>,
): ReadonlyMap<ContentId, ContentId> {
  const pathsByContent = new Map<ContentId, string[]>();
  for (const [path, counts] of countsByPath) {
    for (const contentId of counts.keys()) {
      const paths = pathsByContent.get(contentId) ?? [];
      paths.push(path);
      pathsByContent.set(contentId, paths);
    }
  }

  const selected = new Map<ContentId, ContentId>();
  for (const target of [...small.values()].sort((left, right) =>
    compareText(left.contentId, right.contentId),
  )) {
    if (anchorIds.has(target.contentId)) {
      continue;
    }
    const rankedCandidates = new Map<ContentId, RankedContent>();
    for (const path of (pathsByContent.get(target.contentId) ?? []).sort(
      compareCanonicalPaths,
    )) {
      for (const candidate of anchorsByPath.get(path) ?? []) {
        const previous = rankedCandidates.get(candidate.content.contentId);
        if (
          previous === undefined ||
          candidate.occurrences > previous.occurrences
        ) {
          rankedCandidates.set(candidate.content.contentId, candidate);
        }
      }
    }
    const candidates = candidateAnchors(target, [...rankedCandidates.values()]);
    let best:
      | { readonly base: SmallContent; readonly payloadBytes: number }
      | undefined;
    for (const { content: base } of candidates) {
      const encoded = deltaRecord(target, base, 1);
      if (encoded === undefined) {
        continue;
      }
      if (
        best === undefined ||
        encoded.payload.byteLength < best.payloadBytes ||
        (encoded.payload.byteLength === best.payloadBytes &&
          base.contentId < best.base.contentId)
      ) {
        best = { base, payloadBytes: encoded.payload.byteLength };
      }
    }
    if (best !== undefined) {
      selected.set(target.contentId, best.base.contentId);
    }
  }
  return selected;
}

function validateEnvelopeForKey(
  key: LogicalRecordKey,
  envelope: RecordEnvelope,
): RecordEnvelope {
  if (envelope.kind !== key.kind || envelope.logicalId !== key.logicalId) {
    invalid(
      "integrity",
      `authenticated envelope does not match ${key.kind} ${key.logicalId}`,
    );
  }
  encodeRecord(envelope);
  if (
    envelope.kind === "content" &&
    (envelope.encoding === "raw" || envelope.encoding === "zstd-v1") &&
    envelope.decodedLength > MAX_FULL_CONTENT_RECORD_BYTES
  ) {
    invalid(
      "limit-exceeded",
      `full content ${envelope.logicalId} exceeds the pack format limit`,
    );
  }
  if (
    envelope.kind === "content" &&
    envelope.encoding === "chunked-v1" &&
    envelope.decodedLength < CHUNKED_CONTENT_MIN_BYTES
  ) {
    invalid(
      "integrity",
      `chunked content ${envelope.logicalId} is below the chunking threshold`,
    );
  }
  if (
    envelope.kind !== "content" &&
    envelope.decodedLength > MAX_METADATA_RECORD_BYTES
  ) {
    invalid(
      "limit-exceeded",
      `${envelope.kind} ${envelope.logicalId} exceeds the pack format limit`,
    );
  }
  return cloneEnvelope(envelope);
}

function appendPending(batches: PendingBatch[], builder: BatchBuilder): void {
  const batch = builder.take();
  if (batch !== undefined) {
    batches.push(batch);
  }
}

function appendOrdinary(
  record: RecordEnvelope,
  builder: BatchBuilder,
  batches: PendingBatch[],
): void {
  if (!builder.tryAdd(record)) {
    appendPending(batches, builder);
    if (!builder.tryAdd(record)) {
      invalid("limit-exceeded", "record cannot fit in an empty legal pack");
    }
  }
  if (builder.singletonExceedsTarget()) {
    appendPending(batches, builder);
  }
}

function freezeBatch(batch: PendingBatch): EncodePackInput {
  return Object.freeze({
    packClass: batch.packClass,
    records: Object.freeze(batch.records.map(cloneEnvelope)),
  });
}

export async function planCompaction(
  input: PlanCompactionInput,
): Promise<CompactionPlan> {
  const limits = input.packLimits ?? DEFAULT_COMPACTION_PACK_LIMITS;
  validateLimits(limits);

  const sortedInputs = [...input.records]
    .map((record) => ({ ...record, ...parseKey(record) }))
    .sort(compareKeys);
  const seen = new Set<string>();
  const envelopes: RecordEnvelope[] = [];
  const small = new Map<ContentId, SmallContent>();
  const liveContentIds = new Set<ContentId>();
  const logicalDependencies: LogicalDependencyFact[] = [];
  let admittedDecodedBytes = 0;

  for (const live of sortedInputs) {
    const key = parseKey(live);
    const serializedKey = keyText(key);
    if (seen.has(serializedKey)) {
      invalid(
        "invalid-input",
        `duplicate live logical record ${serializedKey}`,
      );
    }
    seen.add(serializedKey);
    const dependencies = [...live.dependencies]
      .map(parseKey)
      .sort(compareKeys)
      .filter(
        (dependency, index, all) =>
          index === 0 || keyText(dependency) !== keyText(all[index - 1]!),
      );
    logicalDependencies.push({
      source: cloneKey(key),
      dependencies: Object.freeze(dependencies.map(cloneKey)),
    });

    const envelope = validateEnvelopeForKey(
      key,
      await input.read.readEnvelope(key),
    );
    if (
      envelope.decodedLength > DEFAULT_COMPACTION_DECODED_BYTE_BUDGET ||
      envelope.decodedLength >
        DEFAULT_COMPACTION_DECODED_BYTE_BUDGET - admittedDecodedBytes
    ) {
      invalid(
        "limit-exceeded",
        `compaction decoded bytes exceed the ${DEFAULT_COMPACTION_DECODED_BYTE_BUDGET}-byte maintenance budget`,
      );
    }
    admittedDecodedBytes += envelope.decodedLength;
    if (envelope.kind === "content") {
      liveContentIds.add(envelope.logicalId);
    }
    if (
      envelope.kind !== "content" ||
      envelope.encoding === "chunked-v1" ||
      envelope.decodedLength > MAX_FULL_CONTENT_RECORD_BYTES
    ) {
      envelopes.push(envelope);
      continue;
    }
    const decoded = Uint8Array.from(
      await input.read.readDecodedContent(envelope.logicalId),
    );
    if (
      decoded.byteLength !== envelope.decodedLength ||
      contentIdFromBytes(decoded) !== envelope.logicalId
    ) {
      invalid(
        "integrity",
        `decoded content does not match ${envelope.logicalId}`,
      );
    }
    const full = await createContentRecord(decoded);
    small.set(envelope.logicalId, {
      contentId: envelope.logicalId,
      decoded,
      full,
    });
  }

  for (const fact of logicalDependencies) {
    for (const dependency of fact.dependencies) {
      if (!seen.has(keyText(dependency))) {
        invalid(
          "invalid-input",
          `${keyText(fact.source)} depends on absent live record ${keyText(dependency)}`,
        );
      }
    }
  }

  const countsByPath = occurrenceCounts(
    input.contentPathOccurrences,
    liveContentIds,
    small,
  );
  const { anchorIds, anchorsByPath } = selectAnchorsByPath(countsByPath, small);
  const selectedBases = chooseDeltaBases(
    small,
    countsByPath,
    anchorsByPath,
    anchorIds,
  );

  const pending: PendingBatch[] = [];
  const dataBuilder = new BatchBuilder("data", limits);
  const preservedData = envelopes
    .filter((record) => packClassForRecordKind(record.kind) === "data")
    .sort((left, right) => compareText(left.logicalId, right.logicalId));
  for (const record of preservedData) {
    appendOrdinary(record, dataBuilder, pending);
  }

  const targetsByBase = new Map<ContentId, SmallContent[]>();
  for (const [targetId, baseId] of selectedBases) {
    const target = small.get(targetId);
    if (target === undefined) {
      invalid("integrity", `missing selected delta target ${targetId}`);
    }
    const targets = targetsByBase.get(baseId) ?? [];
    targets.push(target);
    targetsByBase.set(baseId, targets);
  }

  const packedSmall = new Set<ContentId>();
  for (const baseId of [...targetsByBase.keys()].sort(compareText)) {
    const base = small.get(baseId);
    if (base === undefined) {
      invalid("integrity", `missing selected delta base ${baseId}`);
    }
    packedSmall.add(baseId);
    let baseOrdinal: number | undefined;

    const targets = targetsByBase.get(baseId) ?? [];
    targets.sort((left, right) => compareText(left.contentId, right.contentId));
    for (const target of targets) {
      if (baseOrdinal === undefined) {
        if (!dataBuilder.tryAdd(base.full)) {
          appendPending(pending, dataBuilder);
          if (!dataBuilder.tryAdd(base.full)) {
            invalid(
              "limit-exceeded",
              "delta base cannot fit in a legal data pack",
            );
          }
        }
        baseOrdinal = dataBuilder.length - 1;
      }
      let encoded = deltaRecord(target, base, dataBuilder.length - baseOrdinal);
      const fact: PendingDeltaFact = {
        targetContentId: target.contentId,
        baseContentId: base.contentId,
      };
      if (encoded !== undefined && dataBuilder.tryAdd(encoded, fact)) {
        packedSmall.add(target.contentId);
        continue;
      }

      appendPending(pending, dataBuilder);
      baseOrdinal = undefined;
      encoded = deltaRecord(target, base, 1);
      if (
        encoded !== undefined &&
        dataBuilder.tryAddDependencyPair(base.full, encoded, fact)
      ) {
        baseOrdinal = 0;
        packedSmall.add(target.contentId);
        continue;
      }
      appendOrdinary(target.full, dataBuilder, pending);
      packedSmall.add(target.contentId);
      baseOrdinal = undefined;
    }
  }

  for (const content of [...small.values()].sort((left, right) =>
    compareText(left.contentId, right.contentId),
  )) {
    if (!packedSmall.has(content.contentId)) {
      appendOrdinary(content.full, dataBuilder, pending);
      packedSmall.add(content.contentId);
    }
  }
  appendPending(pending, dataBuilder);

  const metadataBuilder = new BatchBuilder("metadata", limits);
  const metadata = envelopes
    .filter((record) => packClassForRecordKind(record.kind) === "metadata")
    .sort(
      (left, right) =>
        recordKindCode(left.kind) - recordKindCode(right.kind) ||
        compareText(left.logicalId, right.logicalId),
    );
  for (const record of metadata) {
    appendOrdinary(record, metadataBuilder, pending);
  }
  appendPending(pending, metadataBuilder);

  const batches = pending.map(freezeBatch);
  const physicalDependencies: Delta1DependencyFact[] = [];
  pending.forEach((batch, batchIndex) => {
    for (const delta of batch.deltas) {
      physicalDependencies.push(
        Object.freeze({
          encoding: "delta1",
          batchIndex,
          targetContentId: delta.targetContentId,
          baseContentId: delta.baseContentId,
        }),
      );
    }
  });

  return Object.freeze({
    batches: Object.freeze(batches),
    logicalDependencies: Object.freeze(
      logicalDependencies.map((fact) => Object.freeze(fact)),
    ),
    physicalDependencies: Object.freeze(physicalDependencies),
  });
}
