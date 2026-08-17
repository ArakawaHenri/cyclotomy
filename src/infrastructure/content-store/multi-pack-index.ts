import { createHash, timingSafeEqual } from "node:crypto";

import {
  CanonicalBinaryError,
  CanonicalReader,
  CanonicalWriter,
} from "./canonical-binary.ts";
import {
  contentIdFromDigestBytes,
  idToBytes,
  metadataIdFromDigestBytes,
  recipeIdFromDigestBytes,
  SHA256_BYTE_LENGTH,
  type LogicalId,
} from "./ids.ts";
import {
  DATA_PACK_HARD_MAX_BYTES,
  MAX_PACK_RECORDS,
  METADATA_PACK_HARD_MAX_BYTES,
  packClassForRecordKind,
  type PackClass,
  type PackEntryKey,
  type PackId,
  type PackIndexEntry,
  type PackIndexView,
  type PackVerificationOptions,
} from "./pack.ts";
import {
  RECORD_ENCODING_CODES,
  RECORD_KIND_CODES,
  recordEncodingCode,
  recordKindCode,
  type RecordEncoding,
  type RecordKind,
} from "./record.ts";

export const MULTI_PACK_INDEX_HARD_MAX_BYTES = 64 * 1024 * 1024;
export const MAX_MULTI_PACK_INDEX_PACKS = 65_535;
export const MAX_MULTI_PACK_INDEX_ENTRIES = 1_000_000;

const MIDX_MAGIC = Uint8Array.of(
  0x43,
  0x59,
  0x4d,
  0x49,
  0x44,
  0x58,
  0x30,
  0x31,
); // CYMIDX01
const MIDX_TRAILER_MAGIC = Uint8Array.of(
  0x43,
  0x59,
  0x4d,
  0x54,
  0x52,
  0x4c,
  0x30,
  0x31,
); // CYMTRL01
export const MULTI_PACK_INDEX_FORMAT_VERSION = 1;
const MIDX_FLAGS_NONE = 0;
const FANOUT_ENTRIES = 256;
const CHECKSUM_BYTES = SHA256_BYTE_LENGTH;
const PACK_CLASS_CODES = Object.freeze({ data: 1, metadata: 2 } as const);

export type MultiPackIndexErrorCode =
  "invalid-input" | "corrupt" | "limit-exceeded";

export class MultiPackIndexError extends Error {
  readonly code: MultiPackIndexErrorCode;

  constructor(code: MultiPackIndexErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "MultiPackIndexError";
    this.code = code;
  }
}

export interface MultiPackDescriptor {
  readonly packId: PackId;
  readonly packClass: PackClass;
  readonly byteLength: number;
}

export interface MultiPackIndexEntry {
  readonly logicalId: LogicalId;
  readonly kind: RecordKind;
  readonly encoding: RecordEncoding;
  readonly decodedLength: number;
  readonly packOrdinal: number;
  readonly packId: PackId;
  readonly physicalOrdinal: number;
  readonly offset: number;
  readonly length: number;
}

export type MultiPackIndexValidation =
  | { readonly kind: "current" }
  | { readonly kind: "stale"; readonly reason: string };

export type MultiPackIndexResolution =
  | {
      readonly kind: "hit";
      readonly bytes: Uint8Array;
      readonly packEntry: PackIndexEntry;
    }
  | { readonly kind: "stale"; readonly reason: string };

/** Authenticated footer capability shared by in-memory and streaming packs. */
export interface AuthenticatedPackLookup {
  readonly packId: PackId;
  readonly packClass: PackClass;
  readonly byteLength: number;
  entryForPhysicalOrdinal(physicalOrdinal: number): PackIndexEntry | undefined;
}

export interface AuthenticatedPackReadLookup extends AuthenticatedPackLookup {
  readVerified(
    entry: PackIndexEntry,
    options?: PackVerificationOptions,
  ): Promise<Uint8Array>;
}

interface AuthenticatedPackViewSource {
  indexView(): PackIndexView;
}

export type MultiPackIndexLocation =
  | {
      readonly kind: "hit";
      readonly pack: AuthenticatedPackLookup;
      readonly packEntry: PackIndexEntry;
    }
  | { readonly kind: "stale"; readonly reason: string };

export interface BuiltMultiPackIndex {
  readonly bytes: Uint8Array;
  readonly index: MultiPackIndex;
}

function invalid(
  code: MultiPackIndexErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new MultiPackIndexError(code, message, cause);
}

function sha256(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(bytes).digest());
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    timingSafeEqual(Buffer.from(left), Buffer.from(right))
  );
}

function classFromCode(code: number): PackClass {
  if (code === PACK_CLASS_CODES.data) {
    return "data";
  }
  if (code === PACK_CLASS_CODES.metadata) {
    return "metadata";
  }
  invalid("corrupt", `unknown MIDX pack class code ${code}`);
}

function kindFromCode(code: number): RecordKind {
  for (const [kind, expected] of Object.entries(RECORD_KIND_CODES)) {
    if (code === expected) {
      return kind as RecordKind;
    }
  }
  invalid("corrupt", `unknown MIDX record kind code ${code}`);
}

function encodingFromCode(code: number): RecordEncoding {
  for (const [encoding, expected] of Object.entries(RECORD_ENCODING_CODES)) {
    if (code === expected) {
      return encoding as RecordEncoding;
    }
  }
  invalid("corrupt", `unknown MIDX record encoding code ${code}`);
}

function idFromDigest(kind: RecordKind, digest: Uint8Array): LogicalId {
  if (kind === "content") {
    return contentIdFromDigestBytes(digest);
  }
  if (kind === "recipe") {
    return recipeIdFromDigestBytes(digest);
  }
  return metadataIdFromDigestBytes(digest);
}

function compareEntries(
  left: MultiPackIndexEntry,
  right: MultiPackIndexEntry,
): number {
  const idOrder =
    left.logicalId < right.logicalId
      ? -1
      : left.logicalId > right.logicalId
        ? 1
        : 0;
  if (idOrder !== 0) {
    return idOrder;
  }
  const kindOrder = recordKindCode(left.kind) - recordKindCode(right.kind);
  if (kindOrder !== 0) {
    return kindOrder;
  }
  const encodingOrder =
    recordEncodingCode(left.encoding) - recordEncodingCode(right.encoding);
  if (encodingOrder !== 0) {
    return encodingOrder;
  }
  const packOrder = left.packOrdinal - right.packOrdinal;
  if (packOrder !== 0) {
    return packOrder;
  }
  return left.offset - right.offset;
}

function sameEntry(
  left: MultiPackIndexEntry,
  right: MultiPackIndexEntry,
): boolean {
  return (
    left.logicalId === right.logicalId &&
    left.kind === right.kind &&
    left.encoding === right.encoding &&
    left.decodedLength === right.decodedLength &&
    left.packOrdinal === right.packOrdinal &&
    left.packId === right.packId &&
    left.physicalOrdinal === right.physicalOrdinal &&
    left.offset === right.offset &&
    left.length === right.length
  );
}

function freezeEntry(entry: MultiPackIndexEntry): MultiPackIndexEntry {
  return Object.freeze({ ...entry });
}

function fanoutFor(entries: readonly MultiPackIndexEntry[]): readonly number[] {
  const counts = new Array<number>(FANOUT_ENTRIES).fill(0);
  for (const entry of entries) {
    const firstByte = Number.parseInt(entry.logicalId.slice(0, 2), 16);
    const count = counts[firstByte];
    if (count === undefined) {
      invalid("corrupt", "MIDX contains an invalid logical id");
    }
    counts[firstByte] = count + 1;
  }
  let cumulative = 0;
  for (let index = 0; index < counts.length; index += 1) {
    const count = counts[index];
    if (count === undefined) {
      invalid("corrupt", "MIDX fanout construction failed");
    }
    cumulative += count;
    counts[index] = cumulative;
  }
  return Object.freeze(counts);
}

function entryFor(
  pack: PackIndexView,
  packOrdinal: number,
  entry: PackIndexEntry,
): MultiPackIndexEntry {
  return {
    logicalId: entry.logicalId,
    kind: entry.kind,
    encoding: entry.encoding,
    decodedLength: entry.decodedLength,
    packOrdinal,
    packId: pack.packId,
    physicalOrdinal: entry.physicalOrdinal,
    offset: entry.offset,
    length: entry.length,
  };
}

function writeIndex(
  packs: readonly MultiPackDescriptor[],
  entries: readonly MultiPackIndexEntry[],
): Uint8Array {
  const fanout = fanoutFor(entries);
  const writer = new CanonicalWriter()
    .writeBytes(MIDX_MAGIC)
    .writeByte(MULTI_PACK_INDEX_FORMAT_VERSION)
    .writeVarint(MIDX_FLAGS_NONE)
    .writeVarint(packs.length)
    .writeVarint(entries.length);
  for (const pack of packs) {
    writer
      .writeBytes(Uint8Array.from(Buffer.from(pack.packId, "hex")))
      .writeByte(PACK_CLASS_CODES[pack.packClass])
      .writeVarint(pack.byteLength);
  }
  for (const count of fanout) {
    writer.writeVarint(count);
  }
  for (const entry of entries) {
    writer
      .writeBytes(idToBytes(entry.logicalId))
      .writeByte(recordKindCode(entry.kind))
      .writeByte(recordEncodingCode(entry.encoding))
      .writeVarint(entry.decodedLength)
      .writeVarint(entry.packOrdinal)
      .writeVarint(entry.physicalOrdinal)
      .writeVarint(entry.offset)
      .writeVarint(entry.length);
  }
  return writer.finish();
}

export class MultiPackIndex {
  readonly #fanout: readonly number[];

  readonly packs: readonly MultiPackDescriptor[];
  readonly entries: readonly MultiPackIndexEntry[];

  constructor(input: {
    readonly packs: readonly MultiPackDescriptor[];
    readonly entries: readonly MultiPackIndexEntry[];
    readonly fanout: readonly number[];
  }) {
    this.packs = Object.freeze(
      input.packs.map((pack) => Object.freeze({ ...pack })),
    );
    this.entries = Object.freeze(input.entries.map(freezeEntry));
    this.#fanout = Object.freeze([...input.fanout]);
    Object.freeze(this);
  }

  lookup(key: PackEntryKey): readonly MultiPackIndexEntry[] {
    if (
      !/^[0-9a-f]{64}$/u.test(key.logicalId) ||
      !Object.hasOwn(RECORD_KIND_CODES, key.kind)
    ) {
      invalid("invalid-input", "MIDX lookup key is invalid");
    }
    const firstByte = Number.parseInt(key.logicalId.slice(0, 2), 16);
    if (!Number.isInteger(firstByte)) {
      invalid("invalid-input", "MIDX lookup logical id is invalid");
    }
    const start = firstByte === 0 ? 0 : (this.#fanout[firstByte - 1] ?? 0);
    const end = this.#fanout[firstByte] ?? start;
    let lower = start;
    let upper = end;
    while (lower < upper) {
      const middle = lower + Math.floor((upper - lower) / 2);
      const candidate = this.entries[middle];
      if (candidate !== undefined && candidate.logicalId < key.logicalId) {
        lower = middle + 1;
      } else {
        upper = middle;
      }
    }
    const matches: MultiPackIndexEntry[] = [];
    for (let index = lower; index < end; index += 1) {
      const entry = this.entries[index];
      if (entry === undefined || entry.logicalId !== key.logicalId) {
        break;
      }
      if (entry.kind === key.kind) {
        matches.push(entry);
      }
    }
    return matches;
  }
}

export function buildMultiPackIndex(
  sourcePacks: readonly AuthenticatedPackViewSource[],
): BuiltMultiPackIndex {
  return buildMultiPackIndexFromViews(
    sourcePacks.map((pack) => pack.indexView()),
  );
}

/** Build from payload-free authenticated footer views, one retained per pack. */
export function buildMultiPackIndexFromViews(
  sourcePacks: readonly PackIndexView[],
): BuiltMultiPackIndex {
  if (sourcePacks.length > MAX_MULTI_PACK_INDEX_PACKS) {
    invalid(
      "limit-exceeded",
      `MIDX pack count exceeds ${MAX_MULTI_PACK_INDEX_PACKS}`,
    );
  }
  const packs = [...sourcePacks].sort((left, right) =>
    left.packId < right.packId ? -1 : left.packId > right.packId ? 1 : 0,
  );
  for (let index = 1; index < packs.length; index += 1) {
    if (packs[index - 1]?.packId === packs[index]?.packId) {
      invalid("invalid-input", "MIDX input contains a duplicate pack id");
    }
  }
  let entryCount = 0;
  for (const pack of packs) {
    if (pack.entries.length > MAX_MULTI_PACK_INDEX_ENTRIES - entryCount) {
      invalid(
        "limit-exceeded",
        `MIDX entry count exceeds ${MAX_MULTI_PACK_INDEX_ENTRIES}`,
      );
    }
    entryCount += pack.entries.length;
  }
  const descriptors: MultiPackDescriptor[] = packs.map((pack) => ({
    packId: pack.packId,
    packClass: pack.packClass,
    byteLength: pack.byteLength,
  }));
  const entries = packs
    .flatMap((pack, packOrdinal) =>
      pack.entries.map((entry) => entryFor(pack, packOrdinal, entry)),
    )
    .sort(compareEntries);
  if (entries.length > MAX_MULTI_PACK_INDEX_ENTRIES) {
    invalid(
      "limit-exceeded",
      `MIDX entry count exceeds ${MAX_MULTI_PACK_INDEX_ENTRIES}`,
    );
  }
  const body = writeIndex(descriptors, entries);
  const checksum = sha256(body);
  const bytes = new CanonicalWriter()
    .writeBytes(body)
    .writeBytes(checksum)
    .writeBytes(MIDX_TRAILER_MAGIC)
    .finish();
  if (bytes.byteLength > MULTI_PACK_INDEX_HARD_MAX_BYTES) {
    invalid(
      "limit-exceeded",
      `MIDX exceeds the ${MULTI_PACK_INDEX_HARD_MAX_BYTES}-byte limit`,
    );
  }
  const owned = Uint8Array.from(bytes);
  return { bytes: owned, index: decodeMultiPackIndex(owned) };
}

export function decodeMultiPackIndex(source: Uint8Array): MultiPackIndex {
  try {
    if (source.byteLength > MULTI_PACK_INDEX_HARD_MAX_BYTES) {
      invalid(
        "limit-exceeded",
        `MIDX exceeds the ${MULTI_PACK_INDEX_HARD_MAX_BYTES}-byte limit`,
      );
    }
    const bytes = Uint8Array.from(source);
    const fixedTrailerBytes = CHECKSUM_BYTES + MIDX_TRAILER_MAGIC.byteLength;
    if (bytes.byteLength <= fixedTrailerBytes) {
      invalid("corrupt", "MIDX is too short");
    }
    const trailerOffset = bytes.byteLength - MIDX_TRAILER_MAGIC.byteLength;
    if (!bytesEqual(bytes.subarray(trailerOffset), MIDX_TRAILER_MAGIC)) {
      invalid("corrupt", "MIDX trailer magic is invalid");
    }
    const checksumOffset = trailerOffset - CHECKSUM_BYTES;
    const expectedChecksum = bytes.subarray(checksumOffset, trailerOffset);
    const body = bytes.subarray(0, checksumOffset);
    if (!bytesEqual(expectedChecksum, sha256(body))) {
      invalid("corrupt", "MIDX checksum does not match its contents");
    }

    const reader = new CanonicalReader(body);
    reader.expectBytes(MIDX_MAGIC, "MIDX magic");
    const version = reader.readByte("MIDX version");
    if (version !== MULTI_PACK_INDEX_FORMAT_VERSION) {
      invalid("corrupt", `unsupported MIDX version ${version}`);
    }
    const flags = reader.readVarint("MIDX flags");
    if (flags !== MIDX_FLAGS_NONE) {
      invalid("corrupt", `MIDX has unsupported flags ${flags}`);
    }
    const packCount = reader.readVarint("MIDX pack count");
    if (packCount > MAX_MULTI_PACK_INDEX_PACKS) {
      invalid(
        "limit-exceeded",
        `MIDX pack count exceeds ${MAX_MULTI_PACK_INDEX_PACKS}`,
      );
    }
    const entryCount = reader.readVarint("MIDX entry count");
    if (entryCount > MAX_MULTI_PACK_INDEX_ENTRIES) {
      invalid(
        "limit-exceeded",
        `MIDX entry count exceeds ${MAX_MULTI_PACK_INDEX_ENTRIES}`,
      );
    }

    const packs: MultiPackDescriptor[] = [];
    for (let index = 0; index < packCount; index += 1) {
      const digest = reader.readBytes(SHA256_BYTE_LENGTH, "MIDX pack id");
      const packId = Buffer.from(digest).toString("hex") as PackId;
      const packClass = classFromCode(reader.readByte("MIDX pack class"));
      const byteLength = reader.readVarint("MIDX pack byte length");
      const packHardMax =
        packClass === "data"
          ? DATA_PACK_HARD_MAX_BYTES
          : METADATA_PACK_HARD_MAX_BYTES;
      if (byteLength === 0 || byteLength > packHardMax) {
        invalid("corrupt", "MIDX pack byte length is outside its class limit");
      }
      packs.push({ packId, packClass, byteLength });
    }
    for (let index = 1; index < packs.length; index += 1) {
      const previous = packs[index - 1];
      const current = packs[index];
      if (
        previous === undefined ||
        current === undefined ||
        previous.packId >= current.packId
      ) {
        invalid("corrupt", "MIDX pack table is not strictly sorted");
      }
    }

    const fanout: number[] = [];
    let previousFanout = 0;
    for (let index = 0; index < FANOUT_ENTRIES; index += 1) {
      const count = reader.readVarint(`MIDX fanout ${index}`);
      if (count < previousFanout || count > entryCount) {
        invalid("corrupt", "MIDX fanout is not cumulative");
      }
      fanout.push(count);
      previousFanout = count;
    }
    if (previousFanout !== entryCount) {
      invalid("corrupt", "MIDX fanout does not cover all entries");
    }

    const entries: MultiPackIndexEntry[] = [];
    for (let index = 0; index < entryCount; index += 1) {
      const digest = reader.readBytes(SHA256_BYTE_LENGTH, "MIDX logical id");
      const kind = kindFromCode(reader.readByte("MIDX record kind"));
      const encoding = encodingFromCode(reader.readByte("MIDX encoding"));
      const decodedLength = reader.readVarint("MIDX decoded length");
      const packOrdinal = reader.readVarint("MIDX pack ordinal");
      const physicalOrdinal = reader.readVarint("MIDX physical ordinal");
      const offset = reader.readVarint("MIDX pack offset");
      const length = reader.readVarint("MIDX record length");
      const pack = packs[packOrdinal];
      if (pack === undefined) {
        invalid("corrupt", "MIDX entry refers to an unknown pack ordinal");
      }
      if (physicalOrdinal >= MAX_PACK_RECORDS) {
        invalid("corrupt", "MIDX physical ordinal is outside its pack");
      }
      if (
        length === 0 ||
        offset > pack.byteLength ||
        length > pack.byteLength - offset
      ) {
        invalid("corrupt", "MIDX entry range is outside its pack");
      }
      if (packClassForRecordKind(kind) !== pack.packClass) {
        invalid("corrupt", "MIDX entry kind does not match its pack class");
      }
      if (
        (encoding === "chunked-v1" || encoding === "delta1") &&
        kind !== "content"
      ) {
        invalid("corrupt", "MIDX entry has an incompatible encoding");
      }
      entries.push({
        logicalId: idFromDigest(kind, digest),
        kind,
        encoding,
        decodedLength,
        packOrdinal,
        packId: pack.packId,
        physicalOrdinal,
        offset,
        length,
      });
    }
    reader.assertEnd();

    for (let index = 1; index < entries.length; index += 1) {
      const previous = entries[index - 1];
      const current = entries[index];
      if (
        previous === undefined ||
        current === undefined ||
        compareEntries(previous, current) >= 0
      ) {
        invalid("corrupt", "MIDX entries are not strictly sorted");
      }
    }
    const expectedFanout = fanoutFor(entries);
    if (expectedFanout.some((value, index) => value !== fanout[index])) {
      invalid("corrupt", "MIDX fanout does not match its entries");
    }

    return new MultiPackIndex({ packs, entries, fanout });
  } catch (error) {
    if (error instanceof MultiPackIndexError) {
      throw error;
    }
    if (error instanceof CanonicalBinaryError || error instanceof TypeError) {
      invalid("corrupt", `invalid MIDX: ${error.message}`, error);
    }
    throw error;
  }
}

function canonicalPackList(
  packs: readonly PackIndexView[],
): readonly PackIndexView[] | undefined {
  const sorted = [...packs].sort((left, right) =>
    left.packId < right.packId ? -1 : left.packId > right.packId ? 1 : 0,
  );
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1]?.packId === sorted[index]?.packId) {
      return undefined;
    }
  }
  return sorted;
}

export function validateMultiPackIndex(
  index: MultiPackIndex,
  sourcePacks: readonly AuthenticatedPackViewSource[],
): MultiPackIndexValidation {
  return validateMultiPackIndexViews(
    index,
    sourcePacks.map((pack) => pack.indexView()),
  );
}

/** Validate cache completeness using only authenticated footer views. */
export function validateMultiPackIndexViews(
  index: MultiPackIndex,
  sourcePacks: readonly PackIndexView[],
): MultiPackIndexValidation {
  const packs = canonicalPackList(sourcePacks);
  if (packs === undefined) {
    return { kind: "stale", reason: "available pack set contains duplicates" };
  }
  if (packs.length !== index.packs.length) {
    return { kind: "stale", reason: "available pack set differs from MIDX" };
  }
  let expectedEntryCount = 0;
  for (const pack of packs) {
    if (pack.entries.length > index.entries.length - expectedEntryCount) {
      return { kind: "stale", reason: "MIDX entry set is incomplete" };
    }
    expectedEntryCount += pack.entries.length;
  }
  if (expectedEntryCount !== index.entries.length) {
    return { kind: "stale", reason: "MIDX entry set is incomplete" };
  }
  for (let ordinal = 0; ordinal < packs.length; ordinal += 1) {
    const pack = packs[ordinal];
    const descriptor = index.packs[ordinal];
    if (
      pack === undefined ||
      descriptor === undefined ||
      pack.packId !== descriptor.packId ||
      pack.packClass !== descriptor.packClass ||
      pack.byteLength !== descriptor.byteLength
    ) {
      return { kind: "stale", reason: "MIDX pack table is obsolete" };
    }
  }
  const expected = packs
    .flatMap((pack, packOrdinal) =>
      pack.entries.map((entry) => entryFor(pack, packOrdinal, entry)),
    )
    .sort(compareEntries);
  if (expected.length !== index.entries.length) {
    return { kind: "stale", reason: "MIDX entry set is incomplete" };
  }
  for (let ordinal = 0; ordinal < expected.length; ordinal += 1) {
    const expectedEntry = expected[ordinal];
    const observedEntry = index.entries[ordinal];
    if (
      expectedEntry === undefined ||
      observedEntry === undefined ||
      !sameEntry(expectedEntry, observedEntry)
    ) {
      return { kind: "stale", reason: "MIDX entry set is obsolete" };
    }
  }
  return { kind: "current" };
}

/**
 * Locate one caller-selected representation. MIDX is only a cache: the
 * candidate must exactly match an authenticated pack footer entry.
 */
export function resolveMultiPackIndexEntry(
  index: MultiPackIndex,
  candidate: MultiPackIndexEntry,
  packsById: ReadonlyMap<string, AuthenticatedPackLookup>,
): MultiPackIndexLocation {
  if (
    !index
      .lookup({ logicalId: candidate.logicalId, kind: candidate.kind })
      .some((entry) => sameEntry(entry, candidate))
  ) {
    return { kind: "stale", reason: "candidate is not present in this MIDX" };
  }
  const pack = packsById.get(candidate.packId);
  if (pack === undefined) {
    return { kind: "stale", reason: "candidate pack is unavailable" };
  }
  if (pack.packId !== candidate.packId) {
    return { kind: "stale", reason: "candidate pack id is obsolete" };
  }
  const descriptor = index.packs[candidate.packOrdinal];
  if (
    descriptor === undefined ||
    descriptor.packId !== pack.packId ||
    descriptor.packClass !== pack.packClass ||
    descriptor.byteLength !== pack.byteLength
  ) {
    return { kind: "stale", reason: "candidate pack descriptor is obsolete" };
  }
  const packEntry = pack.entryForPhysicalOrdinal(candidate.physicalOrdinal);
  if (
    packEntry === undefined ||
    packEntry.offset !== candidate.offset ||
    packEntry.length !== candidate.length ||
    packEntry.logicalId !== candidate.logicalId ||
    packEntry.kind !== candidate.kind ||
    packEntry.encoding !== candidate.encoding ||
    packEntry.decodedLength !== candidate.decodedLength ||
    packEntry.physicalOrdinal !== candidate.physicalOrdinal
  ) {
    return {
      kind: "stale",
      reason: "candidate does not match the authenticated pack footer",
    };
  }
  return {
    kind: "hit",
    pack,
    packEntry,
  };
}

/** Verify and materialize a full or delta1 representation after locating it. */
export async function readMultiPackIndexEntry(
  index: MultiPackIndex,
  candidate: MultiPackIndexEntry,
  packsById: ReadonlyMap<string, AuthenticatedPackReadLookup>,
  options: PackVerificationOptions = {},
): Promise<MultiPackIndexResolution> {
  const location = resolveMultiPackIndexEntry(index, candidate, packsById);
  if (location.kind === "stale") {
    return location;
  }
  const readable = packsById.get(location.pack.packId);
  if (readable === undefined) {
    return { kind: "stale", reason: "authenticated pack is unavailable" };
  }
  return {
    kind: "hit",
    bytes: await readable.readVerified(location.packEntry, options),
    packEntry: location.packEntry,
  };
}
