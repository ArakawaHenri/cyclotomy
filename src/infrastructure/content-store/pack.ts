import { createHash, timingSafeEqual } from "node:crypto";

import {
  CanonicalBinaryError,
  CanonicalReader,
  CanonicalWriter,
  decodeUnsignedVarint,
  unsignedVarintLength,
} from "./canonical-binary.ts";
import {
  CHUNKED_CONTENT_MIN_BYTES,
  MAX_RECIPE_OBJECT_BYTES,
} from "./chunk-recipe.ts";
import {
  contentIdFromBytes,
  contentIdFromDigestBytes,
  idToBytes,
  metadataIdFromDigestBytes,
  parseContentId,
  parseMetadataId,
  parseRecipeId,
  recipeIdFromCanonicalBytes,
  recipeIdFromDigestBytes,
  SHA256_BYTE_LENGTH,
  type ContentId,
  type LogicalId,
  type MetadataId,
  type RecipeId,
} from "./ids.ts";
import {
  applyDelta1Program,
  decodeDelta1Program,
  DELTA1_MAX_BASE_BYTES,
  DELTA1_MAX_PAYLOAD_BYTES,
  DELTA1_MAX_TARGET_BYTES,
  Delta1FormatError,
  type Delta1Program,
} from "./pack-delta.ts";
import {
  decodeRecord,
  encodeRecord,
  RECORD_ENCODING_CODES,
  RECORD_KIND_CODES,
  recordEncodingCode,
  recordKindCode,
  type RecordEncoding,
  type RecordEnvelope,
  type RecordKind,
} from "./record.ts";
import { decodeZstdV1, ZstdCodecError } from "./zstd.ts";
import { ABSOLUTE_MAX_TREE_MANIFEST_BYTES } from "../tree-formats/manifest-codec.ts";

export const DATA_PACK_TARGET_BYTES = 32 * 1024 * 1024;
export const DATA_PACK_HARD_MAX_BYTES = 64 * 1024 * 1024;
export const METADATA_PACK_TARGET_BYTES = 4 * 1024 * 1024;
export const METADATA_PACK_MULTI_RECORD_MAX_BYTES = 32 * 1024 * 1024;
/** One oversized metadata object may occupy a singleton pack. */
export const METADATA_PACK_HARD_MAX_BYTES =
  ABSOLUTE_MAX_TREE_MANIFEST_BYTES + 1024 * 1024;
export const MAX_PACK_RECORDS = 65_535;
export const MAX_FULL_CONTENT_RECORD_BYTES = 256 * 1024;
export const MAX_METADATA_RECORD_BYTES = ABSOLUTE_MAX_TREE_MANIFEST_BYTES;

const PACK_MAGIC = Uint8Array.of(
  0x43,
  0x59,
  0x50,
  0x41,
  0x43,
  0x4b,
  0x30,
  0x31,
); // CYPACK01
const FOOTER_MAGIC = Uint8Array.of(
  0x43,
  0x59,
  0x50,
  0x46,
  0x54,
  0x52,
  0x30,
  0x31,
); // CYPFTR01
const TRAILER_MAGIC = Uint8Array.of(
  0x43,
  0x59,
  0x50,
  0x54,
  0x52,
  0x4c,
  0x30,
  0x31,
); // CYPTRL01
export const PACK_FORMAT_VERSION = 1;
export const PACK_FOOTER_FORMAT_VERSION = 1;
const PACK_FLAGS_NONE = 0;
const FOOTER_FLAGS_NONE = 0;
const PACK_CLASS_CODES = Object.freeze({ data: 1, metadata: 2 } as const);
const CHECKSUM_BYTES = SHA256_BYTE_LENGTH;
const FOOTER_LENGTH_BYTES = 8;
const FANOUT_ENTRIES = 256;
const FIXED_TRAILER_BYTES =
  FOOTER_LENGTH_BYTES + CHECKSUM_BYTES + TRAILER_MAGIC.byteLength;
const AUTHENTICATED_PACK_TOKEN = Symbol("authenticated-pack");
const PACK_INDEX_TOKEN = Symbol("pack-index");
const PACK_READER_TOKEN = Symbol("pack-reader");
const RECORD_MAGIC = Uint8Array.of(0x43, 0x59, 0x52, 0x43); // CYRC
const RECORD_FORMAT_VERSION = 1;
const RECORD_FLAGS_NONE = 0;
const MAX_SAFE_VARINT_BYTES = unsignedVarintLength(Number.MAX_SAFE_INTEGER);
const MAX_RECORD_HEADER_BYTES =
  RECORD_MAGIC.byteLength + 3 + MAX_SAFE_VARINT_BYTES * 3 + SHA256_BYTE_LENGTH;
const MAX_PACK_HEADER_BYTES =
  PACK_MAGIC.byteLength + 2 + MAX_SAFE_VARINT_BYTES * 2;
const MAX_PACK_FOOTER_BYTES =
  FOOTER_MAGIC.byteLength +
  1 +
  MAX_SAFE_VARINT_BYTES * (2 + FANOUT_ENTRIES) +
  MAX_PACK_RECORDS * (SHA256_BYTE_LENGTH + 2 + MAX_SAFE_VARINT_BYTES * 4);

/** Maximum request used while hashing and probing an authenticated pack. */
export const PACK_AUTHENTICATION_READ_BUFFER_BYTES = 64 * 1024;
const packPublicationEvidence = new WeakMap<
  object,
  {
    readonly pack: AuthenticatedPack;
    readonly packId: PackId;
    readonly byteLength: number;
    readonly bytesDigest: Uint8Array;
  }
>();

declare const PACK_ID: unique symbol;
export type PackId = string & { readonly [PACK_ID]: true };
export type PackClass = keyof typeof PACK_CLASS_CODES;

export type PackErrorCode =
  | "invalid-input"
  | "invalid-format"
  | "integrity"
  | "limit-exceeded"
  | "verification-required";

export class PackFormatError extends Error {
  readonly code: PackErrorCode;

  constructor(code: PackErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PackFormatError";
    this.code = code;
  }
}

export interface PackIndexEntry {
  readonly logicalId: LogicalId;
  readonly kind: RecordKind;
  readonly encoding: RecordEncoding;
  readonly decodedLength: number;
  readonly physicalOrdinal: number;
  readonly offset: number;
  readonly length: number;
}

export interface PackEntryKey {
  readonly logicalId: LogicalId;
  readonly kind: RecordKind;
}

/**
 * Minimal random-access source for authenticating a pack file without loading
 * it as one Uint8Array. Each successful read must return a freshly owned,
 * immutable snapshot of exactly the requested range; the source must never
 * mutate that returned storage afterward or share its backing ArrayBuffer with
 * another returned range. This lets a scoped reader transfer ownership of an
 * authenticated raw payload without another whole-record copy. Implementations
 * must make close deterministic and idempotent.
 */
export interface PackPositionalReader {
  readonly byteLength: number;
  readExactly(position: number, length: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** Authenticated footer facts detached from record payloads. */
export interface PackIndexView {
  readonly packId: PackId;
  readonly packClass: PackClass;
  readonly byteLength: number;
  readonly entries: readonly PackIndexEntry[];
}

export interface PackVerificationOptions {
  /**
   * Tree and scope IDs have format-specific domain tags. The owning canonical
   * codec must verify those IDs; absence is a hard failure, never an implicit
   * trust of the footer or MIDX.
   */
  readonly verifyMetadataId?: (
    kind: "tree-root" | "tree-node" | "scope",
    logicalId: MetadataId,
    decoded: Uint8Array,
  ) => boolean | Promise<boolean>;
}

export interface PackPublicationOptions extends PackVerificationOptions {
  /** Authenticate the recipe closure without requiring whole-file materialization. */
  readonly verifyChunkedContent?: (input: {
    readonly logicalId: ContentId;
    readonly recipeId: RecipeId;
    readonly decodedLength: number;
  }) => boolean | Promise<boolean>;
}

export interface EncodePackInput {
  readonly packClass: PackClass;
  readonly records: readonly RecordEnvelope[];
}

export interface EncodedPack {
  readonly bytes: Uint8Array;
  readonly pack: AuthenticatedPack;
}

export interface VerifiedPackPublication {
  readonly bytes: Uint8Array;
  readonly pack: AuthenticatedPack;
}

interface PhysicalRecord {
  readonly envelope: RecordEnvelope;
  readonly entry: PackIndexEntry;
}

interface PreparedPackLayout {
  readonly header: Uint8Array;
  readonly records: readonly RecordEnvelope[];
  readonly entries: readonly PackIndexEntry[];
  readonly physicalRecords: readonly PhysicalRecord[];
  readonly recordFrames: readonly Uint8Array[];
  readonly footer: Uint8Array;
  readonly byteLength: number;
}

const PACK_ID_PATTERN = /^[0-9a-f]{64}$/u;

function invalid(code: PackErrorCode, message: string, cause?: unknown): never {
  throw new PackFormatError(code, message, cause);
}

function packHardMax(packClass: PackClass): number {
  return packClass === "data"
    ? DATA_PACK_HARD_MAX_BYTES
    : METADATA_PACK_HARD_MAX_BYTES;
}

export function parsePackId(value: string): PackId {
  if (!PACK_ID_PATTERN.test(value)) {
    invalid(
      "invalid-input",
      "pack id must be exactly 64 lowercase hexadecimal digits",
    );
  }
  return value as PackId;
}

function sha256Bytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(bytes).digest());
}

function digestToPackId(bytes: Uint8Array): PackId {
  return Buffer.from(bytes).toString("hex") as PackId;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    timingSafeEqual(Buffer.from(left), Buffer.from(right))
  );
}

function writeUnsigned64(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalid("invalid-input", "unsigned 64-bit value must be a safe integer");
  }
  const encoded = Buffer.alloc(FIXED_U64_BYTES);
  encoded.writeBigUInt64BE(BigInt(value));
  return Uint8Array.from(encoded);
}

const FIXED_U64_BYTES = 8;

function readUnsigned64(
  bytes: Uint8Array,
  offset: number,
  label: string,
): number {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > bytes.byteLength - FIXED_U64_BYTES
  ) {
    invalid("invalid-format", `missing ${label}`);
  }
  const value = Buffer.from(
    bytes.subarray(offset, offset + FIXED_U64_BYTES),
  ).readBigUInt64BE();
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    invalid("limit-exceeded", `${label} exceeds the safe integer limit`);
  }
  return Number(value);
}

function classFromCode(code: number): PackClass {
  if (code === PACK_CLASS_CODES.data) {
    return "data";
  }
  if (code === PACK_CLASS_CODES.metadata) {
    return "metadata";
  }
  invalid("invalid-format", `unknown pack class code ${code}`);
}

function kindFromCode(code: number): RecordKind {
  for (const [kind, expected] of Object.entries(RECORD_KIND_CODES)) {
    if (code === expected) {
      return kind as RecordKind;
    }
  }
  invalid("invalid-format", `unknown pack index record kind code ${code}`);
}

function encodingFromCode(code: number): RecordEncoding {
  for (const [encoding, expected] of Object.entries(RECORD_ENCODING_CODES)) {
    if (code === expected) {
      return encoding as RecordEncoding;
    }
  }
  invalid("invalid-format", `unknown pack index encoding code ${code}`);
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

function assertKeyShape(kind: RecordKind, logicalId: LogicalId): void {
  if (!Object.hasOwn(RECORD_KIND_CODES, kind)) {
    invalid("invalid-input", `unknown record kind ${String(kind)}`);
  }
  if (kind === "content") {
    parseContentId(logicalId);
    return;
  }
  if (kind === "recipe") {
    parseRecipeId(logicalId);
    return;
  }
  parseMetadataId(logicalId);
}

export function packClassForRecordKind(kind: RecordKind): PackClass {
  switch (kind) {
    case "content":
      return "data";
    case "recipe":
    case "tree-root":
    case "tree-node":
    case "scope":
      return "metadata";
  }
}

function cloneEnvelope(envelope: RecordEnvelope): RecordEnvelope {
  return {
    ...envelope,
    payload: Uint8Array.from(envelope.payload),
  } as RecordEnvelope;
}

function assertRecordHeaderLimits(input: {
  readonly kind: RecordKind;
  readonly encoding: RecordEncoding;
  readonly decodedLength: number;
  readonly payloadLength: number;
}): void {
  if (!Number.isSafeInteger(input.decodedLength) || input.decodedLength < 0) {
    invalid("invalid-format", "record decoded length is not a safe integer");
  }
  if (!Number.isSafeInteger(input.payloadLength) || input.payloadLength < 0) {
    invalid("invalid-format", "record payload length is not a safe integer");
  }
  if (
    input.kind === "content" &&
    (input.encoding === "raw" || input.encoding === "zstd-v1") &&
    (input.decodedLength > MAX_FULL_CONTENT_RECORD_BYTES ||
      input.payloadLength > MAX_FULL_CONTENT_RECORD_BYTES)
  ) {
    invalid(
      "limit-exceeded",
      `full content record exceeds ${MAX_FULL_CONTENT_RECORD_BYTES} decoded bytes`,
    );
  }
  if (
    input.kind === "content" &&
    input.encoding === "chunked-v1" &&
    input.decodedLength < CHUNKED_CONTENT_MIN_BYTES
  ) {
    invalid(
      "invalid-format",
      `chunked-v1 content must be at least ${CHUNKED_CONTENT_MIN_BYTES} decoded bytes`,
    );
  }
  if (
    input.kind === "content" &&
    input.encoding === "chunked-v1" &&
    input.payloadLength !== SHA256_BYTE_LENGTH
  ) {
    invalid(
      "invalid-format",
      `chunked-v1 content payload must be ${SHA256_BYTE_LENGTH} bytes`,
    );
  }
  if (
    input.kind === "content" &&
    input.encoding === "delta1" &&
    (input.decodedLength > DELTA1_MAX_TARGET_BYTES ||
      input.payloadLength > DELTA1_MAX_PAYLOAD_BYTES)
  ) {
    invalid(
      "limit-exceeded",
      "delta1 record exceeds its target or program limit",
    );
  }
  if (
    input.kind === "recipe" &&
    (input.decodedLength > MAX_RECIPE_OBJECT_BYTES ||
      input.payloadLength > MAX_RECIPE_OBJECT_BYTES)
  ) {
    invalid(
      "limit-exceeded",
      `recipe record exceeds ${MAX_RECIPE_OBJECT_BYTES} bytes`,
    );
  }
  if (
    input.kind !== "content" &&
    input.kind !== "recipe" &&
    (input.decodedLength > MAX_METADATA_RECORD_BYTES ||
      input.payloadLength > MAX_METADATA_RECORD_BYTES)
  ) {
    invalid(
      "limit-exceeded",
      `metadata record exceeds ${MAX_METADATA_RECORD_BYTES} decoded bytes`,
    );
  }
}

function assertRecordLimits(record: RecordEnvelope): void {
  assertRecordHeaderLimits({
    kind: record.kind,
    encoding: record.encoding,
    decodedLength: record.decodedLength,
    payloadLength: record.payload.byteLength,
  });
}

function cloneEntry(entry: PackIndexEntry): PackIndexEntry {
  return Object.freeze({ ...entry });
}

function compareHex(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareEntries(left: PackIndexEntry, right: PackIndexEntry): number {
  const idOrder = compareHex(left.logicalId, right.logicalId);
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
  return left.physicalOrdinal - right.physicalOrdinal;
}

function entryEquals(left: PackIndexEntry, right: PackIndexEntry): boolean {
  return (
    left.logicalId === right.logicalId &&
    left.kind === right.kind &&
    left.encoding === right.encoding &&
    left.decodedLength === right.decodedLength &&
    left.physicalOrdinal === right.physicalOrdinal &&
    left.offset === right.offset &&
    left.length === right.length
  );
}

function fanoutFor(entries: readonly PackIndexEntry[]): readonly number[] {
  const counts = new Array<number>(FANOUT_ENTRIES).fill(0);
  for (const entry of entries) {
    const firstByte = Number.parseInt(entry.logicalId.slice(0, 2), 16);
    const current = counts[firstByte];
    if (current === undefined) {
      invalid("invalid-format", "pack index contains an invalid logical id");
    }
    counts[firstByte] = current + 1;
  }
  let cumulative = 0;
  for (let index = 0; index < counts.length; index += 1) {
    const count = counts[index];
    if (count === undefined) {
      invalid("invalid-format", "pack fanout construction failed");
    }
    cumulative += count;
    counts[index] = cumulative;
  }
  return Object.freeze(counts);
}

function writeFooter(entries: readonly PackIndexEntry[]): Uint8Array {
  const sorted = [...entries].sort(compareEntries);
  const fanout = fanoutFor(sorted);
  const writer = new CanonicalWriter()
    .writeBytes(FOOTER_MAGIC)
    .writeByte(PACK_FOOTER_FORMAT_VERSION)
    .writeVarint(FOOTER_FLAGS_NONE)
    .writeVarint(sorted.length);
  for (const count of fanout) {
    writer.writeVarint(count);
  }
  for (const entry of sorted) {
    writer
      .writeBytes(idToBytes(entry.logicalId))
      .writeByte(recordKindCode(entry.kind))
      .writeByte(recordEncodingCode(entry.encoding))
      .writeVarint(entry.decodedLength)
      .writeVarint(entry.physicalOrdinal)
      .writeVarint(entry.offset)
      .writeVarint(entry.length);
  }
  return writer.finish();
}

function readFooter(encoded: Uint8Array): {
  readonly entries: readonly PackIndexEntry[];
  readonly fanout: readonly number[];
} {
  const reader = new CanonicalReader(encoded);
  reader.expectBytes(FOOTER_MAGIC, "pack footer magic");
  const version = reader.readByte("pack footer version");
  if (version !== PACK_FOOTER_FORMAT_VERSION) {
    invalid("invalid-format", `unsupported pack footer version ${version}`);
  }
  const flags = reader.readVarint("pack footer flags");
  if (flags !== FOOTER_FLAGS_NONE) {
    invalid("invalid-format", `pack footer has unsupported flags ${flags}`);
  }
  const recordCount = reader.readVarint("pack footer record count");
  if (recordCount === 0 || recordCount > MAX_PACK_RECORDS) {
    invalid(
      "limit-exceeded",
      `pack footer record count must be between 1 and ${MAX_PACK_RECORDS}`,
    );
  }

  const fanout: number[] = [];
  let previous = 0;
  for (let index = 0; index < FANOUT_ENTRIES; index += 1) {
    const count = reader.readVarint(`pack footer fanout ${index}`);
    if (count < previous || count > recordCount) {
      invalid("invalid-format", "pack footer fanout is not cumulative");
    }
    fanout.push(count);
    previous = count;
  }
  if (previous !== recordCount) {
    invalid("invalid-format", "pack footer fanout does not cover all records");
  }

  const entries: PackIndexEntry[] = [];
  for (let index = 0; index < recordCount; index += 1) {
    const digest = reader.readBytes(
      SHA256_BYTE_LENGTH,
      "pack index logical id",
    );
    const kind = kindFromCode(reader.readByte("pack index record kind"));
    const encoding = encodingFromCode(reader.readByte("pack index encoding"));
    const decodedLength = reader.readVarint("pack index decoded length");
    const physicalOrdinal = reader.readVarint("pack index physical ordinal");
    const offset = reader.readVarint("pack index offset");
    const length = reader.readVarint("pack index length");
    entries.push({
      logicalId: idFromDigest(kind, digest),
      kind,
      encoding,
      decodedLength,
      physicalOrdinal,
      offset,
      length,
    });
  }
  reader.assertEnd();

  for (let index = 1; index < entries.length; index += 1) {
    const previousEntry = entries[index - 1];
    const entry = entries[index];
    if (
      previousEntry === undefined ||
      entry === undefined ||
      compareEntries(previousEntry, entry) >= 0
    ) {
      invalid("invalid-format", "pack footer index is not strictly sorted");
    }
  }
  const expectedFanout = fanoutFor(entries);
  if (expectedFanout.some((value, index) => value !== fanout[index])) {
    invalid("invalid-format", "pack footer fanout does not match its entries");
  }
  return {
    entries: Object.freeze(entries.map(cloneEntry)),
    fanout: Object.freeze([...fanout]),
  };
}

interface ParsedPackHeader {
  readonly packClass: PackClass;
  readonly recordCount: number;
  readonly byteLength: number;
}

interface ParsedRecordHeader {
  readonly logicalId: LogicalId;
  readonly kind: RecordKind;
  readonly encoding: RecordEncoding;
  readonly decodedLength: number;
  readonly payloadLength: number;
  readonly headerLength: number;
}

function parsePackHeader(bytes: Uint8Array): ParsedPackHeader {
  const reader = new CanonicalReader(bytes);
  reader.expectBytes(PACK_MAGIC, "pack magic");
  const version = reader.readByte("pack version");
  if (version !== PACK_FORMAT_VERSION) {
    invalid("invalid-format", `unsupported pack version ${version}`);
  }
  const packClass = classFromCode(reader.readByte("pack class"));
  const flags = reader.readVarint("pack flags");
  if (flags !== PACK_FLAGS_NONE) {
    invalid("invalid-format", `pack has unsupported flags ${flags}`);
  }
  const recordCount = reader.readVarint("pack record count");
  if (recordCount === 0 || recordCount > MAX_PACK_RECORDS) {
    invalid(
      "limit-exceeded",
      `pack record count must be between 1 and ${MAX_PACK_RECORDS}`,
    );
  }
  return { packClass, recordCount, byteLength: reader.offset };
}

function parseRecordHeader(bytes: Uint8Array): ParsedRecordHeader {
  const reader = new CanonicalReader(bytes);
  reader.expectBytes(RECORD_MAGIC, "record magic");
  const version = reader.readByte("record version");
  if (version !== RECORD_FORMAT_VERSION) {
    invalid("invalid-format", `unsupported record version ${version}`);
  }
  const kind = kindFromCode(reader.readByte("record kind"));
  const encoding = encodingFromCode(reader.readByte("record encoding"));
  if (
    (encoding === "chunked-v1" || encoding === "delta1") &&
    kind !== "content"
  ) {
    invalid(
      "invalid-format",
      `record kind ${kind} cannot use ${encoding} encoding`,
    );
  }
  const flags = reader.readVarint("record flags");
  if (flags !== RECORD_FLAGS_NONE) {
    invalid("invalid-format", `record has unsupported flags ${flags}`);
  }
  const digest = reader.readBytes(SHA256_BYTE_LENGTH, "record logical id");
  const decodedLength = reader.readVarint("record decoded length");
  const payloadLength = reader.readVarint("record payload length");
  if (encoding === "raw" && payloadLength !== decodedLength) {
    invalid(
      "invalid-format",
      "raw record payload length must equal its decoded length",
    );
  }
  if (encoding === "chunked-v1" && payloadLength !== SHA256_BYTE_LENGTH) {
    invalid(
      "invalid-format",
      `chunked-v1 payload must be exactly ${SHA256_BYTE_LENGTH} bytes`,
    );
  }
  assertRecordHeaderLimits({
    kind,
    encoding,
    decodedLength,
    payloadLength,
  });
  return {
    logicalId: idFromDigest(kind, digest),
    kind,
    encoding,
    decodedLength,
    payloadLength,
    headerLength: reader.offset,
  };
}

function validateReaderRange(
  byteLength: number,
  position: number,
  length: number,
): void {
  if (
    !Number.isSafeInteger(position) ||
    !Number.isSafeInteger(length) ||
    position < 0 ||
    length < 0 ||
    position > byteLength ||
    length > byteLength - position
  ) {
    invalid("invalid-input", "pack reader range is outside the pack");
  }
}

async function readExactly(
  source: PackPositionalReader,
  position: number,
  length: number,
  label: string,
): Promise<Uint8Array> {
  validateReaderRange(source.byteLength, position, length);
  const bytes = await source.readExactly(position, length);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) {
    invalid("invalid-format", `pack reader returned a truncated ${label}`);
  }
  return bytes;
}

class PackReadWindow {
  readonly #source: PackPositionalReader;
  #position = 0;
  #bytes: Uint8Array = new Uint8Array();

  constructor(source: PackPositionalReader) {
    this.#source = source;
  }

  async readExactly(
    position: number,
    length: number,
    label: string,
  ): Promise<Uint8Array> {
    validateReaderRange(this.#source.byteLength, position, length);
    if (
      position >= this.#position &&
      length <= this.#bytes.byteLength - (position - this.#position)
    ) {
      const offset = position - this.#position;
      return Uint8Array.from(this.#bytes.subarray(offset, offset + length));
    }
    if (length > PACK_AUTHENTICATION_READ_BUFFER_BYTES) {
      return await readExactly(this.#source, position, length, label);
    }
    const windowLength = Math.min(
      PACK_AUTHENTICATION_READ_BUFFER_BYTES,
      this.#source.byteLength - position,
    );
    this.#position = position;
    this.#bytes = await readExactly(
      this.#source,
      position,
      windowLength,
      label,
    );
    return Uint8Array.from(this.#bytes.subarray(0, length));
  }
}

async function hashAuthenticatedPrefix(
  source: PackPositionalReader,
  checksumOffset: number,
): Promise<Uint8Array> {
  const hash = createHash("sha256");
  let position = 0;
  while (position < checksumOffset) {
    const length = Math.min(
      PACK_AUTHENTICATION_READ_BUFFER_BYTES,
      checksumOffset - position,
    );
    hash.update(
      await readExactly(source, position, length, "pack checksum range"),
    );
    position += length;
  }
  return Uint8Array.from(hash.digest());
}

function entryMatchesHeader(
  entry: PackIndexEntry,
  header: ParsedRecordHeader,
): boolean {
  return (
    entry.logicalId === header.logicalId &&
    entry.kind === header.kind &&
    entry.encoding === header.encoding &&
    entry.decodedLength === header.decodedLength
  );
}

function assertDeltaBaseCompatibility(
  program: Delta1Program,
  baseDecodedLength: number,
): void {
  for (const instruction of program.instructions) {
    if (
      instruction.kind === "copy" &&
      (instruction.baseOffset > baseDecodedLength ||
        instruction.byteLength > baseDecodedLength - instruction.baseOffset)
    ) {
      invalid(
        "invalid-format",
        "delta1 COPY range exceeds its selected base content",
      );
    }
  }
}

interface ParsedPackIndex {
  readonly index: PackIndex;
  readonly expectedChecksum: Uint8Array;
  readonly footerOffset: number;
  readonly header: ParsedPackHeader;
  readonly physicalEntries: readonly PackIndexEntry[];
}

/**
 * Read the pack's own routing metadata without authenticating unrelated record
 * payloads. A logical read still verifies every record it consumes against its
 * declared id; whole-pack authentication is reserved for publication and
 * maintenance operations.
 */
async function readPackIndexInternal(
  source: PackPositionalReader,
  expectedPackId?: PackId,
): Promise<ParsedPackIndex> {
  const absoluteMax = Math.max(
    DATA_PACK_HARD_MAX_BYTES,
    METADATA_PACK_HARD_MAX_BYTES,
  );
  if (
    !Number.isSafeInteger(source.byteLength) ||
    source.byteLength < 0 ||
    source.byteLength > absoluteMax
  ) {
    invalid(
      "limit-exceeded",
      `pack exceeds the ${absoluteMax}-byte absolute limit`,
    );
  }
  if (source.byteLength <= FIXED_TRAILER_BYTES) {
    invalid("invalid-format", "pack is too short");
  }

  const fixedTrailerOffset = source.byteLength - FIXED_TRAILER_BYTES;
  const fixedTrailer = await readExactly(
    source,
    fixedTrailerOffset,
    FIXED_TRAILER_BYTES,
    "pack trailer",
  );
  const footerLength = readUnsigned64(fixedTrailer, 0, "pack footer length");
  if (footerLength === 0 || footerLength > MAX_PACK_FOOTER_BYTES) {
    invalid("limit-exceeded", "pack footer length is outside its format limit");
  }
  const footerLengthOffset = fixedTrailerOffset;
  const footerOffset = footerLengthOffset - footerLength;
  if (footerOffset <= 0) {
    invalid("invalid-format", "pack footer length is outside the pack");
  }
  const expectedChecksum = fixedTrailer.subarray(
    FOOTER_LENGTH_BYTES,
    FOOTER_LENGTH_BYTES + CHECKSUM_BYTES,
  );
  const trailerMagic = fixedTrailer.subarray(
    FOOTER_LENGTH_BYTES + CHECKSUM_BYTES,
  );
  if (!bytesEqual(trailerMagic, TRAILER_MAGIC)) {
    invalid("invalid-format", "pack trailer magic is invalid");
  }
  const packId = digestToPackId(expectedChecksum);
  if (expectedPackId !== undefined && packId !== expectedPackId) {
    invalid("integrity", "pack bytes do not match the expected pack id");
  }

  const footer = readFooter(
    await readExactly(source, footerOffset, footerLength, "pack footer"),
  );
  const prefix = await readExactly(
    source,
    0,
    Math.min(MAX_PACK_HEADER_BYTES, footerOffset),
    "pack header",
  );
  const header = parsePackHeader(prefix);
  if (source.byteLength > packHardMax(header.packClass)) {
    invalid(
      "limit-exceeded",
      `${header.packClass} pack exceeds its ${packHardMax(header.packClass)}-byte hard limit`,
    );
  }
  if (footer.entries.length !== header.recordCount) {
    invalid("invalid-format", "pack header and footer record counts differ");
  }
  if (
    header.packClass === "metadata" &&
    header.recordCount > 1 &&
    source.byteLength > METADATA_PACK_MULTI_RECORD_MAX_BYTES
  ) {
    invalid(
      "limit-exceeded",
      `multi-record metadata pack exceeds ${METADATA_PACK_MULTI_RECORD_MAX_BYTES} bytes`,
    );
  }

  const physicalEntries = new Array<PackIndexEntry | undefined>(
    header.recordCount,
  );
  for (const entry of footer.entries) {
    if (
      entry.physicalOrdinal >= header.recordCount ||
      physicalEntries[entry.physicalOrdinal] !== undefined
    ) {
      invalid(
        "invalid-format",
        "pack footer physical ordinals are not a complete unique sequence",
      );
    }
    physicalEntries[entry.physicalOrdinal] = entry;
    if (packClassForRecordKind(entry.kind) !== header.packClass) {
      invalid(
        "invalid-format",
        `${header.packClass} pack cannot contain ${entry.kind} records`,
      );
    }
  }

  let nextOffset = header.byteLength;
  for (let ordinal = 0; ordinal < physicalEntries.length; ordinal += 1) {
    const entry = physicalEntries[ordinal];
    if (
      entry === undefined ||
      entry.offset !== nextOffset ||
      entry.length === 0 ||
      entry.length > footerOffset - nextOffset
    ) {
      invalid(
        "integrity",
        "pack footer entry does not match its physical record boundary",
      );
    }
    nextOffset += entry.length;
  }
  if (nextOffset !== footerOffset) {
    invalid("invalid-format", "pack body has unindexed trailing bytes");
  }

  return {
    index: new PackIndex(
      {
        packId,
        packClass: header.packClass,
        byteLength: source.byteLength,
        entries: footer.entries,
        fanout: footer.fanout,
      },
      PACK_INDEX_TOKEN,
    ),
    expectedChecksum: Uint8Array.from(expectedChecksum),
    footerOffset,
    header,
    physicalEntries: Object.freeze(
      physicalEntries.map((entry) => {
        if (entry === undefined) {
          invalid("invalid-format", "pack footer physical index is incomplete");
        }
        return entry;
      }),
    ),
  };
}

async function authenticatePackIndexInternal(
  source: PackPositionalReader,
  expectedPackId?: PackId,
): Promise<PackIndex> {
  const parsed = await readPackIndexInternal(source, expectedPackId);
  const checksumOffset =
    source.byteLength - (CHECKSUM_BYTES + TRAILER_MAGIC.byteLength);
  const observedChecksum = await hashAuthenticatedPrefix(
    source,
    checksumOffset,
  );
  if (!bytesEqual(parsed.expectedChecksum, observedChecksum)) {
    invalid("integrity", "pack checksum does not match its contents");
  }
  const packId = digestToPackId(observedChecksum);
  if (expectedPackId !== undefined && packId !== expectedPackId) {
    invalid("integrity", "pack bytes do not match the expected pack id");
  }

  const window = new PackReadWindow(source);
  const duplicateKeys = new Set<string>();
  let nextOffset = parsed.header.byteLength;
  for (
    let physicalOrdinal = 0;
    physicalOrdinal < parsed.header.recordCount;
    physicalOrdinal += 1
  ) {
    const entry = parsed.physicalEntries[physicalOrdinal];
    if (entry === undefined || entry.offset !== nextOffset) {
      invalid(
        "integrity",
        "pack footer entry does not match its physical record boundary",
      );
    }
    const prefixLength = Math.min(
      MAX_SAFE_VARINT_BYTES,
      parsed.footerOffset - nextOffset,
    );
    const framePrefix = await window.readExactly(
      nextOffset,
      prefixLength,
      `pack record ${physicalOrdinal} length`,
    );
    const decodedFrameLength = decodeUnsignedVarint(framePrefix);
    const recordLength = decodedFrameLength.value;
    if (
      recordLength === 0 ||
      recordLength > packHardMax(parsed.header.packClass)
    ) {
      invalid(
        "limit-exceeded",
        `pack record ${physicalOrdinal} length is outside the pack limit`,
      );
    }
    const frameLength = decodedFrameLength.nextOffset + recordLength;
    if (
      frameLength !== entry.length ||
      frameLength > parsed.footerOffset - nextOffset
    ) {
      invalid(
        "integrity",
        "pack footer entry does not match its physical record boundary",
      );
    }
    const recordOffset = nextOffset + decodedFrameLength.nextOffset;
    const recordHeader = parseRecordHeader(
      await window.readExactly(
        recordOffset,
        Math.min(MAX_RECORD_HEADER_BYTES, recordLength),
        `pack record ${physicalOrdinal} header`,
      ),
    );
    if (
      recordHeader.headerLength + recordHeader.payloadLength !== recordLength ||
      !entryMatchesHeader(entry, recordHeader) ||
      packClassForRecordKind(recordHeader.kind) !== parsed.header.packClass
    ) {
      invalid(
        "integrity",
        "pack footer entry does not match its physical record envelope",
      );
    }
    const duplicateKey = `${entry.logicalId}:${entry.kind}:${entry.encoding}`;
    if (duplicateKeys.has(duplicateKey)) {
      invalid(
        "invalid-format",
        "pack contains duplicate logical kind/id/encoding records",
      );
    }
    duplicateKeys.add(duplicateKey);

    if (recordHeader.encoding === "delta1") {
      const payload = await window.readExactly(
        recordOffset + recordHeader.headerLength,
        recordHeader.payloadLength,
        `pack record ${physicalOrdinal} delta1 payload`,
      );
      const program = decodeDelta1Program(payload, recordHeader.decodedLength);
      if (program.baseBackDistance > physicalOrdinal) {
        invalid(
          "invalid-format",
          "delta1 base back-reference precedes the pack",
        );
      }
      const base =
        parsed.physicalEntries[physicalOrdinal - program.baseBackDistance];
      if (
        base === undefined ||
        base.kind !== "content" ||
        (base.encoding !== "raw" && base.encoding !== "zstd-v1") ||
        base.decodedLength > DELTA1_MAX_BASE_BYTES
      ) {
        invalid(
          "invalid-format",
          "delta1 base must be an earlier full content record in the same pack",
        );
      }
      assertDeltaBaseCompatibility(program, base.decodedLength);
    }
    nextOffset += frameLength;
  }
  if (nextOffset !== parsed.footerOffset) {
    invalid("invalid-format", "pack body has unindexed trailing bytes");
  }
  return parsed.index;
}

function readPhysicalRecords(
  reader: CanonicalReader,
  recordCount: number,
  packClass: PackClass,
  hardMax: number,
): readonly PhysicalRecord[] {
  const records: PhysicalRecord[] = [];
  const duplicateKeys = new Set<string>();
  for (
    let physicalOrdinal = 0;
    physicalOrdinal < recordCount;
    physicalOrdinal += 1
  ) {
    const offset = reader.offset;
    const recordLength = reader.readVarint(
      `pack record ${physicalOrdinal} length`,
    );
    if (recordLength === 0 || recordLength > hardMax) {
      invalid(
        "limit-exceeded",
        `pack record ${physicalOrdinal} length is outside the pack limit`,
      );
    }
    const recordBytes = reader.readBytes(
      recordLength,
      `pack record ${physicalOrdinal}`,
    );
    const envelope = decodeRecord(recordBytes, {
      maxDecodedBytes: Number.MAX_SAFE_INTEGER,
      maxPayloadBytes: hardMax,
    });
    assertRecordLimits(envelope);
    if (packClassForRecordKind(envelope.kind) !== packClass) {
      invalid(
        "invalid-format",
        `${packClass} pack cannot contain ${envelope.kind} records`,
      );
    }
    const length = reader.offset - offset;
    const entry: PackIndexEntry = {
      logicalId: envelope.logicalId,
      kind: envelope.kind,
      encoding: envelope.encoding,
      decodedLength: envelope.decodedLength,
      physicalOrdinal,
      offset,
      length,
    };
    const duplicateKey = `${entry.logicalId}:${entry.kind}:${entry.encoding}`;
    if (duplicateKeys.has(duplicateKey)) {
      invalid(
        "invalid-format",
        "pack contains duplicate logical kind/id/encoding records",
      );
    }
    duplicateKeys.add(duplicateKey);
    records.push({ envelope, entry });
  }
  reader.assertEnd();

  for (const record of records) {
    if (record.envelope.encoding !== "delta1") {
      continue;
    }
    const program = decodeDelta1Program(
      record.envelope.payload,
      record.envelope.decodedLength,
    );
    if (program.baseBackDistance > record.entry.physicalOrdinal) {
      invalid("invalid-format", "delta1 base back-reference precedes the pack");
    }
    const baseOrdinal = record.entry.physicalOrdinal - program.baseBackDistance;
    const base = records[baseOrdinal];
    if (
      base === undefined ||
      base.envelope.kind !== "content" ||
      (base.envelope.encoding !== "raw" &&
        base.envelope.encoding !== "zstd-v1") ||
      base.envelope.decodedLength > DELTA1_MAX_BASE_BYTES
    ) {
      invalid(
        "invalid-format",
        "delta1 base must be an earlier full content record in the same pack",
      );
    }
    assertDeltaBaseCompatibility(program, base.envelope.decodedLength);
  }
  return records;
}

async function decodeFullRecord(record: RecordEnvelope): Promise<Uint8Array> {
  if (record.encoding === "raw") {
    return Uint8Array.from(record.payload);
  }
  if (record.encoding === "zstd-v1") {
    try {
      return await decodeZstdV1(record.payload, record.decodedLength);
    } catch (error) {
      if (error instanceof ZstdCodecError) {
        invalid("integrity", "zstd-v1 record payload is invalid", error);
      }
      throw error;
    }
  }
  invalid(
    "invalid-format",
    `${record.encoding} record is not a full representation`,
  );
}

/**
 * Positional reads own their complete record frame. A raw payload may therefore
 * transfer that frame-backed storage to the caller; compressed output is
 * already newly allocated by the codec. The in-memory AuthenticatedPack keeps
 * using decodeFullRecord so its persistent envelopes cannot be mutated through
 * a returned value.
 */
async function decodeOwnedFullRecord(
  record: RecordEnvelope,
): Promise<Uint8Array> {
  if (record.encoding === "raw") return record.payload;
  return await decodeFullRecord(record);
}

async function verifyLogicalId(
  record: RecordEnvelope,
  decoded: Uint8Array,
  options: PackVerificationOptions,
): Promise<void> {
  if (decoded.byteLength !== record.decodedLength) {
    invalid(
      "integrity",
      `decoded ${decoded.byteLength} bytes; expected ${record.decodedLength}`,
    );
  }
  if (record.kind === "content") {
    if (contentIdFromBytes(decoded) !== record.logicalId) {
      invalid(
        "integrity",
        `${record.kind} bytes do not match their logical id`,
      );
    }
    return;
  }
  if (record.kind === "recipe") {
    if (recipeIdFromCanonicalBytes(decoded) !== record.logicalId) {
      invalid("integrity", "recipe bytes do not match their logical id");
    }
    return;
  }

  const verifier = options.verifyMetadataId;
  if (verifier === undefined) {
    invalid(
      "verification-required",
      `verification for ${record.kind} logical ids requires its canonical codec`,
    );
  }
  if (!(await verifier(record.kind, record.logicalId, decoded))) {
    invalid("integrity", `${record.kind} bytes do not match their logical id`);
  }
}

async function decodeAndVerifyRecord(
  records: readonly PhysicalRecord[],
  physicalOrdinal: number,
  options: PackVerificationOptions,
): Promise<Uint8Array> {
  const physical = records[physicalOrdinal];
  if (physical === undefined) {
    invalid("invalid-input", "pack entry physical ordinal is out of range");
  }
  const record = physical.envelope;
  let decoded: Uint8Array;
  if (record.encoding === "raw" || record.encoding === "zstd-v1") {
    decoded = await decodeFullRecord(record);
  } else if (record.encoding === "chunked-v1") {
    invalid(
      "verification-required",
      "chunked-v1 content must be streamed through its authenticated recipe closure",
    );
  } else {
    const program = decodeDelta1Program(record.payload, record.decodedLength);
    const baseOrdinal = physicalOrdinal - program.baseBackDistance;
    const baseRecord = records[baseOrdinal];
    if (
      baseRecord === undefined ||
      baseRecord.envelope.kind !== "content" ||
      (baseRecord.envelope.encoding !== "raw" &&
        baseRecord.envelope.encoding !== "zstd-v1")
    ) {
      invalid(
        "integrity",
        "delta1 base is not an earlier full content record in this pack",
      );
    }
    const base = await decodeFullRecord(baseRecord.envelope);
    await verifyLogicalId(baseRecord.envelope, base, options);
    decoded = applyDelta1Program(program, base, record.decodedLength);
  }
  await verifyLogicalId(record, decoded, options);
  return decoded;
}

/** Parsed pack identity and footer facts without retained payloads. */
export class PackIndex {
  readonly #fanout: readonly number[];
  readonly #physicalEntries: readonly PackIndexEntry[];

  readonly packId: PackId;
  readonly packClass: PackClass;
  readonly byteLength: number;
  readonly entries: readonly PackIndexEntry[];

  constructor(
    input: {
      readonly packId: PackId;
      readonly packClass: PackClass;
      readonly byteLength: number;
      readonly entries: readonly PackIndexEntry[];
      readonly fanout: readonly number[];
    },
    authenticationToken: symbol,
  ) {
    if (authenticationToken !== PACK_INDEX_TOKEN) {
      invalid(
        "invalid-input",
        "PackIndex can only be created by reading pack metadata",
      );
    }
    this.packId = input.packId;
    this.packClass = input.packClass;
    this.byteLength = input.byteLength;
    this.entries = Object.freeze(input.entries.map(cloneEntry));
    this.#fanout = Object.freeze([...input.fanout]);
    const physicalEntries = new Array<PackIndexEntry>(this.entries.length);
    for (const entry of this.entries) {
      physicalEntries[entry.physicalOrdinal] = entry;
    }
    this.#physicalEntries = Object.freeze(physicalEntries);
    Object.freeze(this);
  }

  lookup(key: PackEntryKey): readonly PackIndexEntry[] {
    assertKeyShape(key.kind, key.logicalId);
    const firstByte = Number.parseInt(key.logicalId.slice(0, 2), 16);
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
    const matches: PackIndexEntry[] = [];
    for (let index = lower; index < end; index += 1) {
      const entry = this.entries[index];
      if (entry === undefined || entry.logicalId !== key.logicalId) break;
      if (entry.kind === key.kind) matches.push(entry);
    }
    return Object.freeze(matches);
  }

  entryForPhysicalOrdinal(physicalOrdinal: number): PackIndexEntry | undefined {
    if (!Number.isSafeInteger(physicalOrdinal) || physicalOrdinal < 0) {
      return undefined;
    }
    const entry = this.#physicalEntries[physicalOrdinal];
    return entry === undefined ? undefined : cloneEntry(entry);
  }

  indexView(): PackIndexView {
    return Object.freeze({
      packId: this.packId,
      packClass: this.packClass,
      byteLength: this.byteLength,
      entries: this.entries,
    });
  }
}

async function readEnvelopeFromReader(
  source: PackPositionalReader,
  index: PackIndex,
  entry: PackIndexEntry,
): Promise<RecordEnvelope> {
  const physical = index.entryForPhysicalOrdinal(entry.physicalOrdinal);
  if (physical === undefined || !entryEquals(physical, entry)) {
    invalid("invalid-input", "pack entry does not belong to this pack");
  }
  const frame = await readExactly(
    source,
    entry.offset,
    entry.length,
    `pack record ${entry.physicalOrdinal}`,
  );
  const decodedFrameLength = decodeUnsignedVarint(frame);
  const recordLength = decodedFrameLength.value;
  if (
    recordLength === 0 ||
    decodedFrameLength.nextOffset + recordLength !== frame.byteLength
  ) {
    invalid("integrity", "pack entry no longer matches its record boundary");
  }
  const recordBytes = frame.subarray(decodedFrameLength.nextOffset);
  const header = parseRecordHeader(recordBytes);
  if (header.headerLength + header.payloadLength !== recordBytes.byteLength) {
    invalid("integrity", "pack entry no longer matches its record envelope");
  }
  const payload = recordBytes.subarray(header.headerLength);
  const envelope = {
    kind: header.kind,
    encoding: header.encoding,
    logicalId: header.logicalId,
    decodedLength: header.decodedLength,
    payload,
  } as RecordEnvelope;
  if (
    packClassForRecordKind(envelope.kind) !== index.packClass ||
    !entryMatchesHeader(entry, header)
  ) {
    invalid("integrity", "pack entry no longer matches its record envelope");
  }
  return envelope;
}

type CloseWaiter = {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
};

function closeWaiter(): CloseWaiter {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

/**
 * Scope-owned pack reader. Closing stops new reads, waits for reads
 * already in flight, and closes its source exactly once.
 */
export class PackReader {
  readonly #source: PackPositionalReader;
  #acceptingReads = true;
  #activeReads = 0;
  #drained: CloseWaiter | undefined;
  #closePromise: Promise<void> | undefined;

  readonly index: PackIndex;

  constructor(
    source: PackPositionalReader,
    index: PackIndex,
    authenticationToken: symbol,
  ) {
    if (authenticationToken !== PACK_READER_TOKEN) {
      invalid(
        "invalid-input",
        "PackReader can only be created by opening a pack source",
      );
    }
    this.#source = source;
    this.index = index;
    Object.freeze(this);
  }

  get packId(): PackId {
    return this.index.packId;
  }

  get packClass(): PackClass {
    return this.index.packClass;
  }

  get byteLength(): number {
    return this.index.byteLength;
  }

  get entries(): readonly PackIndexEntry[] {
    return this.index.entries;
  }

  lookup(key: PackEntryKey): readonly PackIndexEntry[] {
    return this.index.lookup(key);
  }

  entryForPhysicalOrdinal(physicalOrdinal: number): PackIndexEntry | undefined {
    return this.index.entryForPhysicalOrdinal(physicalOrdinal);
  }

  indexView(): PackIndexView {
    return this.index.indexView();
  }

  async readEnvelope(entry: PackIndexEntry): Promise<RecordEnvelope> {
    return await this.#withRead(
      async () => await readEnvelopeFromReader(this.#source, this.index, entry),
    );
  }

  async readVerified(
    entry: PackIndexEntry,
    options: PackVerificationOptions = {},
  ): Promise<Uint8Array> {
    return await this.#withRead(async () => {
      const record = await readEnvelopeFromReader(
        this.#source,
        this.index,
        entry,
      );
      let decoded: Uint8Array;
      if (record.encoding === "raw" || record.encoding === "zstd-v1") {
        decoded = await decodeOwnedFullRecord(record);
      } else if (record.encoding === "chunked-v1") {
        invalid(
          "verification-required",
          "chunked-v1 content must be streamed through its authenticated recipe closure",
        );
      } else {
        const program = decodeDelta1Program(
          record.payload,
          record.decodedLength,
        );
        const baseOrdinal = entry.physicalOrdinal - program.baseBackDistance;
        const baseEntry = this.index.entryForPhysicalOrdinal(baseOrdinal);
        if (
          baseEntry === undefined ||
          baseEntry.kind !== "content" ||
          (baseEntry.encoding !== "raw" && baseEntry.encoding !== "zstd-v1")
        ) {
          invalid(
            "integrity",
            "delta1 base is not an earlier full content record in this pack",
          );
        }
        const baseRecord = await readEnvelopeFromReader(
          this.#source,
          this.index,
          baseEntry,
        );
        const base = await decodeOwnedFullRecord(baseRecord);
        await verifyLogicalId(baseRecord, base, options);
        decoded = applyDelta1Program(program, base, record.decodedLength);
      }
      await verifyLogicalId(record, decoded, options);
      return decoded;
    });
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#acceptingReads = false;
    this.#closePromise = (async () => {
      if (this.#activeReads !== 0) {
        this.#drained ??= closeWaiter();
        await this.#drained.promise;
      }
      await this.#source.close();
    })();
    return this.#closePromise;
  }

  async #withRead<T>(action: () => Promise<T>): Promise<T> {
    if (!this.#acceptingReads) {
      invalid("invalid-input", "pack reader is closed");
    }
    this.#activeReads += 1;
    try {
      return await action();
    } finally {
      this.#activeReads -= 1;
      if (this.#activeReads === 0) this.#drained?.resolve();
    }
  }
}

/** Authenticate an open source without taking ownership of its lifetime. */
export async function authenticatePackReader(
  source: PackPositionalReader,
  expectedPackId?: string,
): Promise<PackIndex> {
  try {
    return await authenticatePackIndexInternal(
      source,
      expectedPackId === undefined ? undefined : parsePackId(expectedPackId),
    );
  } catch (error) {
    if (error instanceof PackFormatError) throw error;
    if (
      error instanceof CanonicalBinaryError ||
      error instanceof Delta1FormatError ||
      error instanceof TypeError
    ) {
      invalid("invalid-format", `invalid pack: ${error.message}`, error);
    }
    throw error;
  }
}

/** Read and validate pack routing metadata without hashing record payloads. */
export async function readPackIndex(
  source: PackPositionalReader,
  expectedPackId: string,
): Promise<PackIndex> {
  try {
    return (await readPackIndexInternal(source, parsePackId(expectedPackId)))
      .index;
  } catch (error) {
    if (error instanceof PackFormatError) throw error;
    if (error instanceof CanonicalBinaryError || error instanceof TypeError) {
      invalid("invalid-format", `invalid pack: ${error.message}`, error);
    }
    throw error;
  }
}

async function openPackWithIndex(
  source: PackPositionalReader,
  loadIndex: () => Promise<PackIndex>,
): Promise<PackReader> {
  try {
    return new PackReader(source, await loadIndex(), PACK_READER_TOKEN);
  } catch (error) {
    try {
      await source.close();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        "pack open and reader cleanup both failed",
      );
    }
    throw error;
  }
}

/** Open a pack for logical reads without hashing unrelated payloads. */
export async function openPackForRead(
  source: PackPositionalReader,
  expectedPackId: string,
): Promise<PackReader> {
  return await openPackWithIndex(
    source,
    async () => await readPackIndex(source, expectedPackId),
  );
}

/** Authenticate a source and transfer its lifetime to an explicit handle. */
export async function openAuthenticatedPack(
  source: PackPositionalReader,
  expectedPackId?: string,
): Promise<PackReader> {
  return await openPackWithIndex(
    source,
    async () => await authenticatePackReader(source, expectedPackId),
  );
}

export class AuthenticatedPack {
  readonly #records: readonly PhysicalRecord[];
  readonly #index: PackIndex;

  constructor(
    input: {
      readonly packId: PackId;
      readonly packClass: PackClass;
      readonly byteLength: number;
      readonly records: readonly PhysicalRecord[];
      readonly entries: readonly PackIndexEntry[];
      readonly fanout: readonly number[];
    },
    authenticationToken: symbol,
  ) {
    if (authenticationToken !== AUTHENTICATED_PACK_TOKEN) {
      invalid(
        "invalid-input",
        "AuthenticatedPack can only be created by verifying pack bytes",
      );
    }
    this.#records = input.records;
    this.#index = new PackIndex(
      {
        packId: input.packId,
        packClass: input.packClass,
        byteLength: input.byteLength,
        entries: input.entries,
        fanout: input.fanout,
      },
      PACK_INDEX_TOKEN,
    );
    Object.freeze(this);
  }

  get packId(): PackId {
    return this.#index.packId;
  }

  get packClass(): PackClass {
    return this.#index.packClass;
  }

  get byteLength(): number {
    return this.#index.byteLength;
  }

  get entries(): readonly PackIndexEntry[] {
    return this.#index.entries;
  }

  lookup(key: PackEntryKey): readonly PackIndexEntry[] {
    return this.#index.lookup(key);
  }

  entryForPhysicalOrdinal(physicalOrdinal: number): PackIndexEntry | undefined {
    return this.#index.entryForPhysicalOrdinal(physicalOrdinal);
  }

  /** Retain only authenticated footer facts so the full pack can be released. */
  indexView(): PackIndexView {
    return this.#index.indexView();
  }

  /**
   * Return a physically authenticated, owned envelope after proving membership.
   * Callers still verify full/delta bytes or stream the chunked recipe closure.
   */
  recordEnvelope(entry: PackIndexEntry): RecordEnvelope {
    const physical = this.#recordForEntry(entry);
    return cloneEnvelope(physical.envelope);
  }

  async readVerified(
    entry: PackIndexEntry,
    options: PackVerificationOptions = {},
  ): Promise<Uint8Array> {
    const physical = this.#recordForEntry(entry);
    return await decodeAndVerifyRecord(
      this.#records,
      physical.entry.physicalOrdinal,
      options,
    );
  }

  #recordForEntry(entry: PackIndexEntry): PhysicalRecord {
    const physical = this.#records[entry.physicalOrdinal];
    if (physical === undefined || !entryEquals(physical.entry, entry)) {
      invalid("invalid-input", "pack entry does not belong to this pack");
    }
    return physical;
  }
}

function decodeAuthenticatedPack(
  source: Uint8Array,
  expectedPackId?: PackId,
): AuthenticatedPack {
  const absoluteMax = Math.max(
    DATA_PACK_HARD_MAX_BYTES,
    METADATA_PACK_HARD_MAX_BYTES,
  );
  if (source.byteLength > absoluteMax) {
    invalid(
      "limit-exceeded",
      `pack exceeds the ${absoluteMax}-byte absolute limit`,
    );
  }
  const bytes = Uint8Array.from(source);
  if (bytes.byteLength <= FIXED_TRAILER_BYTES) {
    invalid("invalid-format", "pack is too short");
  }

  const trailerOffset = bytes.byteLength - TRAILER_MAGIC.byteLength;
  if (!bytesEqual(bytes.subarray(trailerOffset), TRAILER_MAGIC)) {
    invalid("invalid-format", "pack trailer magic is invalid");
  }
  const checksumOffset = trailerOffset - CHECKSUM_BYTES;
  const footerLengthOffset = checksumOffset - FOOTER_LENGTH_BYTES;
  if (footerLengthOffset <= 0) {
    invalid("invalid-format", "pack trailer is truncated");
  }
  const expectedChecksum = bytes.subarray(checksumOffset, trailerOffset);
  const observedChecksum = sha256Bytes(bytes.subarray(0, checksumOffset));
  if (!bytesEqual(expectedChecksum, observedChecksum)) {
    invalid("integrity", "pack checksum does not match its contents");
  }
  const packId = digestToPackId(observedChecksum);
  if (expectedPackId !== undefined && packId !== parsePackId(expectedPackId)) {
    invalid("integrity", "pack bytes do not match the expected pack id");
  }

  const footerLength = readUnsigned64(
    bytes,
    footerLengthOffset,
    "pack footer length",
  );
  const footerOffset = footerLengthOffset - footerLength;
  if (footerLength === 0 || footerOffset <= 0) {
    invalid("invalid-format", "pack footer length is outside the pack");
  }
  const footer = readFooter(bytes.slice(footerOffset, footerLengthOffset));

  const bodyReader = new CanonicalReader(bytes.slice(0, footerOffset));
  bodyReader.expectBytes(PACK_MAGIC, "pack magic");
  const version = bodyReader.readByte("pack version");
  if (version !== PACK_FORMAT_VERSION) {
    invalid("invalid-format", `unsupported pack version ${version}`);
  }
  const packClass = classFromCode(bodyReader.readByte("pack class"));
  if (bytes.byteLength > packHardMax(packClass)) {
    invalid(
      "limit-exceeded",
      `${packClass} pack exceeds its ${packHardMax(packClass)}-byte hard limit`,
    );
  }
  const flags = bodyReader.readVarint("pack flags");
  if (flags !== PACK_FLAGS_NONE) {
    invalid("invalid-format", `pack has unsupported flags ${flags}`);
  }
  const recordCount = bodyReader.readVarint("pack record count");
  if (recordCount === 0 || recordCount > MAX_PACK_RECORDS) {
    invalid(
      "limit-exceeded",
      `pack record count must be between 1 and ${MAX_PACK_RECORDS}`,
    );
  }
  if (footer.entries.length !== recordCount) {
    invalid("invalid-format", "pack header and footer record counts differ");
  }
  if (
    packClass === "metadata" &&
    recordCount > 1 &&
    bytes.byteLength > METADATA_PACK_MULTI_RECORD_MAX_BYTES
  ) {
    invalid(
      "limit-exceeded",
      `multi-record metadata pack exceeds ${METADATA_PACK_MULTI_RECORD_MAX_BYTES} bytes`,
    );
  }
  const records = readPhysicalRecords(
    bodyReader,
    recordCount,
    packClass,
    packHardMax(packClass),
  );
  for (const footerEntry of footer.entries) {
    const physical = records[footerEntry.physicalOrdinal];
    if (physical === undefined || !entryEquals(physical.entry, footerEntry)) {
      invalid(
        "integrity",
        "pack footer entry does not match its physical record boundary",
      );
    }
  }

  return new AuthenticatedPack(
    {
      packId,
      packClass,
      byteLength: bytes.byteLength,
      records,
      entries: footer.entries,
      fanout: footer.fanout,
    },
    AUTHENTICATED_PACK_TOKEN,
  );
}

export function decodePack(
  bytes: Uint8Array,
  expectedPackId?: string,
): AuthenticatedPack {
  try {
    return decodeAuthenticatedPack(
      bytes,
      expectedPackId === undefined ? undefined : parsePackId(expectedPackId),
    );
  } catch (error) {
    if (error instanceof PackFormatError) {
      throw error;
    }
    if (
      error instanceof CanonicalBinaryError ||
      error instanceof Delta1FormatError ||
      error instanceof TypeError
    ) {
      invalid("invalid-format", `invalid pack: ${error.message}`, error);
    }
    throw error;
  }
}

/**
 * Authenticate an encodePack publication capability and return owned bytes.
 * The private digest binds the mutable byte view to the encoder's verified
 * layout; the catalog independently reopens the durable file positionally.
 */
export function authenticatePackPublication(
  publication: EncodedPack,
): VerifiedPackPublication {
  const evidence = packPublicationEvidence.get(publication);
  if (
    evidence === undefined ||
    publication.pack !== evidence.pack ||
    publication.pack.packId !== evidence.packId ||
    publication.bytes.byteLength !== evidence.byteLength
  ) {
    invalid(
      "verification-required",
      "pack publication requires an unmodified encodePack receipt",
    );
  }
  const bytes = Uint8Array.from(publication.bytes);
  if (!bytesEqual(sha256Bytes(bytes), evidence.bytesDigest)) {
    invalid(
      "verification-required",
      "pack publication bytes changed after encoder verification",
    );
  }
  return Object.freeze({ bytes, pack: evidence.pack });
}

function preparePackLayout(input: EncodePackInput): PreparedPackLayout {
  if (input.packClass !== "data" && input.packClass !== "metadata") {
    invalid("invalid-input", "pack class must be data or metadata");
  }
  if (input.records.length === 0 || input.records.length > MAX_PACK_RECORDS) {
    invalid(
      "limit-exceeded",
      `pack record count must be between 1 and ${MAX_PACK_RECORDS}`,
    );
  }

  const hardMax = packHardMax(input.packClass);
  let totalPayloadBytes = 0;
  for (const record of input.records) {
    if (packClassForRecordKind(record.kind) !== input.packClass) {
      invalid(
        "invalid-input",
        `${input.packClass} pack cannot contain ${record.kind} records`,
      );
    }
    assertRecordLimits(record);
    if (record.payload.byteLength > hardMax - totalPayloadBytes) {
      invalid(
        "limit-exceeded",
        `${input.packClass} pack payloads exceed its ${hardMax}-byte hard limit`,
      );
    }
    totalPayloadBytes += record.payload.byteLength;
  }
  const records = input.records.map(cloneEnvelope);

  const header = new CanonicalWriter()
    .writeBytes(PACK_MAGIC)
    .writeByte(PACK_FORMAT_VERSION)
    .writeByte(PACK_CLASS_CODES[input.packClass])
    .writeVarint(PACK_FLAGS_NONE)
    .writeVarint(records.length)
    .finish();
  const entries: PackIndexEntry[] = [];
  const physicalRecords: PhysicalRecord[] = [];
  const recordFrames: Uint8Array[] = [];
  const duplicateKeys = new Set<string>();
  let nextOffset = header.byteLength;
  for (
    let physicalOrdinal = 0;
    physicalOrdinal < records.length;
    physicalOrdinal += 1
  ) {
    const record = records[physicalOrdinal];
    if (record === undefined) {
      invalid("invalid-input", "pack input record is missing");
    }
    const encoded = encodeRecord(record);
    const frame = new CanonicalWriter()
      .writeVarint(encoded.byteLength)
      .writeBytes(encoded)
      .finish();
    const offset = nextOffset;
    const length = frame.byteLength;
    if (length > hardMax - nextOffset) {
      invalid(
        "limit-exceeded",
        `${input.packClass} pack records exceed its ${hardMax}-byte hard limit`,
      );
    }
    nextOffset += length;
    const entry: PackIndexEntry = {
      logicalId: record.logicalId,
      kind: record.kind,
      encoding: record.encoding,
      decodedLength: record.decodedLength,
      physicalOrdinal,
      offset,
      length,
    };
    const duplicateKey = `${entry.logicalId}:${entry.kind}:${entry.encoding}`;
    if (duplicateKeys.has(duplicateKey)) {
      invalid(
        "invalid-input",
        "pack input contains duplicate logical kind/id/encoding records",
      );
    }
    duplicateKeys.add(duplicateKey);
    entries.push(entry);
    physicalRecords.push({ envelope: record, entry });
    recordFrames.push(frame);
  }

  const footer = writeFooter(entries);
  const byteLength = nextOffset + footer.byteLength + FIXED_TRAILER_BYTES;
  if (!Number.isSafeInteger(byteLength) || byteLength > hardMax) {
    invalid(
      "limit-exceeded",
      `${input.packClass} pack exceeds its ${hardMax}-byte hard limit`,
    );
  }
  if (
    input.packClass === "metadata" &&
    records.length > 1 &&
    byteLength > METADATA_PACK_MULTI_RECORD_MAX_BYTES
  ) {
    invalid(
      "limit-exceeded",
      `multi-record metadata pack exceeds ${METADATA_PACK_MULTI_RECORD_MAX_BYTES} bytes`,
    );
  }

  return {
    header,
    records,
    entries,
    physicalRecords,
    recordFrames,
    footer,
    byteLength,
  };
}

/**
 * Return the exact encoded pack length using the encoder's canonical layout
 * pass. This validates format and size policy but does not verify logical
 * content hashes or recipe closures.
 */
export function measurePackInputBytes(input: EncodePackInput): number {
  try {
    return preparePackLayout(input).byteLength;
  } catch (error) {
    if (error instanceof PackFormatError) {
      throw error;
    }
    if (
      error instanceof CanonicalBinaryError ||
      error instanceof Delta1FormatError ||
      error instanceof TypeError
    ) {
      invalid("invalid-input", `invalid pack input: ${error.message}`, error);
    }
    throw error;
  }
}

/**
 * O(1) conservative bound for batching already-encoded record envelopes.
 * The bound is derived from this format's canonical framing and remains valid
 * for every partition of `encodedRecordBytes` across `recordCount` records.
 */
export function packPlanningUpperBoundBytes(
  recordCount: number,
  encodedRecordBytes: number,
): number {
  if (
    !Number.isSafeInteger(recordCount) ||
    recordCount < 0 ||
    recordCount > MAX_PACK_RECORDS ||
    !Number.isSafeInteger(encodedRecordBytes) ||
    encodedRecordBytes < 0
  ) {
    invalid(
      "invalid-input",
      "pack planning inputs must be bounded non-negative safe integers",
    );
  }
  if (recordCount === 0 && encodedRecordBytes !== 0) {
    invalid("invalid-input", "an empty pack cannot contain record bytes");
  }

  const checkedAdd = (left: number, right: number): number => {
    if (right > Number.MAX_SAFE_INTEGER - left) {
      invalid("limit-exceeded", "pack planning bound exceeds safe integers");
    }
    return left + right;
  };
  const checkedMultiply = (left: number, right: number): number => {
    if (left !== 0 && right > Math.floor(Number.MAX_SAFE_INTEGER / left)) {
      invalid("limit-exceeded", "pack planning bound exceeds safe integers");
    }
    return left * right;
  };

  const countVarintBytes = unsignedVarintLength(recordCount);
  let bodyBytes =
    PACK_MAGIC.byteLength +
    2 +
    unsignedVarintLength(PACK_FLAGS_NONE) +
    countVarintBytes;
  if (recordCount > 0) {
    bodyBytes = checkedAdd(bodyBytes, encodedRecordBytes);
    bodyBytes = checkedAdd(
      bodyBytes,
      checkedMultiply(recordCount, unsignedVarintLength(encodedRecordBytes)),
    );
  }

  const rangeVarintBytes = unsignedVarintLength(bodyBytes);
  const entryBytes =
    SHA256_BYTE_LENGTH +
    2 +
    unsignedVarintLength(Number.MAX_SAFE_INTEGER) +
    unsignedVarintLength(Math.max(0, recordCount - 1)) +
    rangeVarintBytes * 2;
  let total = checkedAdd(
    bodyBytes,
    FOOTER_MAGIC.byteLength +
      1 +
      unsignedVarintLength(FOOTER_FLAGS_NONE) +
      countVarintBytes,
  );
  total = checkedAdd(total, checkedMultiply(FANOUT_ENTRIES, countVarintBytes));
  total = checkedAdd(total, checkedMultiply(recordCount, entryBytes));
  return checkedAdd(total, FIXED_TRAILER_BYTES);
}

async function encodePackInternal(
  input: EncodePackInput,
  options: PackPublicationOptions = {},
): Promise<EncodedPack> {
  const layout = preparePackLayout(input);

  for (let ordinal = 0; ordinal < layout.physicalRecords.length; ordinal += 1) {
    const physical = layout.physicalRecords[ordinal];
    if (physical === undefined) {
      invalid("invalid-input", "pack input record is missing");
    }
    if (physical.envelope.encoding !== "chunked-v1") {
      await decodeAndVerifyRecord(layout.physicalRecords, ordinal, options);
      continue;
    }
    if (physical.envelope.kind !== "content") {
      invalid("invalid-input", "chunked-v1 record is not content");
    }
    const verifier = options.verifyChunkedContent;
    if (verifier === undefined) {
      invalid(
        "verification-required",
        "chunked-v1 publication requires an authenticated recipe closure",
      );
    }
    if (
      !(await verifier({
        logicalId: physical.envelope.logicalId,
        recipeId: recipeIdFromDigestBytes(physical.envelope.payload),
        decodedLength: physical.envelope.decodedLength,
      }))
    ) {
      invalid(
        "integrity",
        "chunked-v1 recipe closure does not match its logical content id",
      );
    }
  }

  const authenticatedWriter = new CanonicalWriter().writeBytes(layout.header);
  for (const frame of layout.recordFrames) {
    authenticatedWriter.writeBytes(frame);
  }
  const authenticatedBytes = authenticatedWriter
    .writeBytes(layout.footer)
    .writeBytes(writeUnsigned64(layout.footer.byteLength))
    .finish();
  const checksum = sha256Bytes(authenticatedBytes);
  const complete = new CanonicalWriter()
    .writeBytes(authenticatedBytes)
    .writeBytes(checksum)
    .writeBytes(TRAILER_MAGIC)
    .finish();
  if (complete.byteLength !== layout.byteLength) {
    invalid("invalid-format", "pack layout measurement diverged from encoding");
  }
  const bytes = complete;
  const sortedEntries = [...layout.entries].sort(compareEntries);
  const pack = new AuthenticatedPack(
    {
      packId: digestToPackId(checksum),
      packClass: input.packClass,
      byteLength: bytes.byteLength,
      records: layout.physicalRecords,
      entries: sortedEntries,
      fanout: fanoutFor(sortedEntries),
    },
    AUTHENTICATED_PACK_TOKEN,
  );
  const publication = Object.freeze({
    bytes,
    pack,
  });
  packPublicationEvidence.set(publication, {
    pack: publication.pack,
    packId: publication.pack.packId,
    byteLength: publication.bytes.byteLength,
    bytesDigest: sha256Bytes(publication.bytes),
  });
  return publication;
}

export async function encodePack(
  input: EncodePackInput,
  options: PackPublicationOptions = {},
): Promise<EncodedPack> {
  try {
    return await encodePackInternal(input, options);
  } catch (error) {
    if (error instanceof PackFormatError) {
      throw error;
    }
    if (
      error instanceof CanonicalBinaryError ||
      error instanceof Delta1FormatError ||
      error instanceof TypeError
    ) {
      invalid("invalid-input", `invalid pack input: ${error.message}`, error);
    }
    throw error;
  }
}
