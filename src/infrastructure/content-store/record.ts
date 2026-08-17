import {
  CanonicalBinaryError,
  CanonicalReader,
  CanonicalWriter,
} from "./canonical-binary.ts";
import {
  contentIdFromDigestBytes,
  idToBytes,
  metadataIdFromDigestBytes,
  parseContentId,
  parseMetadataId,
  parseRecipeId,
  recipeIdFromDigestBytes,
  SHA256_BYTE_LENGTH,
  type ContentId,
  type MetadataId,
  type RecipeId,
} from "./ids.ts";

const RECORD_MAGIC = Uint8Array.of(0x43, 0x59, 0x52, 0x43); // CYRC
const RECORD_FLAGS_NONE = 0;

export const RECORD_FORMAT_VERSION = 1;

export const RECORD_KIND_CODES = Object.freeze({
  content: 1,
  recipe: 2,
  "tree-root": 3,
  "tree-node": 4,
  scope: 5,
} as const);

export const RECORD_ENCODING_CODES = Object.freeze({
  raw: 0,
  "zstd-v1": 1,
  "chunked-v1": 2,
  delta1: 3,
} as const);

export type RecordKind = keyof typeof RECORD_KIND_CODES;
export type RecordEncoding = keyof typeof RECORD_ENCODING_CODES;

interface RecordFields {
  readonly encoding: RecordEncoding;
  readonly decodedLength: number;
  readonly payload: Uint8Array;
}

export type RecordEnvelope =
  | (RecordFields & {
      readonly kind: "content";
      readonly logicalId: ContentId;
    })
  | (RecordFields & {
      readonly kind: "recipe";
      readonly logicalId: RecipeId;
    })
  | (RecordFields & {
      readonly kind: "tree-root" | "tree-node" | "scope";
      readonly logicalId: MetadataId;
    });

export interface RecordDecodeLimits {
  readonly maxDecodedBytes: number;
  readonly maxPayloadBytes: number;
}

function assertLength(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

function kindFromCode(code: number): RecordKind {
  for (const [kind, expectedCode] of Object.entries(RECORD_KIND_CODES)) {
    if (code === expectedCode) {
      return kind as RecordKind;
    }
  }
  throw new CanonicalBinaryError(
    "unexpected-value",
    `unknown record kind code ${code}`,
  );
}

function encodingFromCode(code: number): RecordEncoding {
  for (const [encoding, expectedCode] of Object.entries(
    RECORD_ENCODING_CODES,
  )) {
    if (code === expectedCode) {
      return encoding as RecordEncoding;
    }
  }
  throw new CanonicalBinaryError(
    "unexpected-value",
    `unknown record encoding code ${code}`,
  );
}

function assertCompatibleEncoding(
  kind: RecordKind,
  encoding: RecordEncoding,
): void {
  if (
    (encoding === "chunked-v1" || encoding === "delta1") &&
    kind !== "content"
  ) {
    throw new CanonicalBinaryError(
      "unexpected-value",
      `record kind ${kind} cannot use ${encoding} encoding`,
    );
  }
}

function assertRecordShape(record: RecordEnvelope): void {
  assertLength(record.decodedLength, "record decoded length");
  if (record.kind === "recipe") {
    parseRecipeId(record.logicalId);
  } else if (record.kind === "content") {
    parseContentId(record.logicalId);
  } else {
    parseMetadataId(record.logicalId);
  }
  assertCompatibleEncoding(record.kind, record.encoding);
  if (
    record.encoding === "raw" &&
    record.payload.byteLength !== record.decodedLength
  ) {
    throw new CanonicalBinaryError(
      "unexpected-value",
      "raw record payload length must equal its decoded length",
    );
  }
  if (
    record.encoding === "chunked-v1" &&
    record.payload.byteLength !== SHA256_BYTE_LENGTH
  ) {
    throw new CanonicalBinaryError(
      "unexpected-value",
      `chunked-v1 payload must be exactly ${SHA256_BYTE_LENGTH} bytes`,
    );
  }
}

export function recordKindCode(kind: RecordKind): number {
  return RECORD_KIND_CODES[kind];
}

export function recordEncodingCode(encoding: RecordEncoding): number {
  return RECORD_ENCODING_CODES[encoding];
}

export function encodeRecord(record: RecordEnvelope): Uint8Array {
  assertRecordShape(record);
  return new CanonicalWriter()
    .writeBytes(RECORD_MAGIC)
    .writeByte(RECORD_FORMAT_VERSION)
    .writeByte(recordKindCode(record.kind))
    .writeByte(recordEncodingCode(record.encoding))
    .writeVarint(RECORD_FLAGS_NONE)
    .writeBytes(idToBytes(record.logicalId))
    .writeVarint(record.decodedLength)
    .writeVarint(record.payload.byteLength)
    .writeBytes(record.payload)
    .finish();
}

/**
 * Parse and bound one canonical envelope. This deliberately does not
 * authenticate the logical id or enforce placement/representation policy;
 * repositories must apply the verifier for the selected encoding afterward.
 */
export function decodeRecord(
  encoded: Uint8Array,
  limits: RecordDecodeLimits,
): RecordEnvelope {
  assertLength(limits.maxDecodedBytes, "maximum decoded bytes");
  assertLength(limits.maxPayloadBytes, "maximum payload bytes");

  const reader = new CanonicalReader(encoded);
  reader.expectBytes(RECORD_MAGIC, "record magic");
  const version = reader.readByte("record version");
  if (version !== RECORD_FORMAT_VERSION) {
    throw new CanonicalBinaryError(
      "unexpected-value",
      `unsupported record version ${version}`,
    );
  }
  const kind = kindFromCode(reader.readByte("record kind"));
  const encoding = encodingFromCode(reader.readByte("record encoding"));
  assertCompatibleEncoding(kind, encoding);
  const flags = reader.readVarint("record flags");
  if (flags !== RECORD_FLAGS_NONE) {
    throw new CanonicalBinaryError(
      "unexpected-value",
      `record has unsupported flags ${flags}`,
    );
  }

  const digest = reader.readBytes(SHA256_BYTE_LENGTH, "record logical id");
  const decodedLength = reader.readVarint("record decoded length");
  if (decodedLength > limits.maxDecodedBytes) {
    throw new CanonicalBinaryError(
      "limit-exceeded",
      `record decoded length ${decodedLength} exceeds the ${limits.maxDecodedBytes}-byte limit`,
    );
  }
  const payloadLength = reader.readVarint("record payload length");
  if (payloadLength > limits.maxPayloadBytes) {
    throw new CanonicalBinaryError(
      "limit-exceeded",
      `record payload length ${payloadLength} exceeds the ${limits.maxPayloadBytes}-byte limit`,
    );
  }
  const payload = reader.readBytes(payloadLength, "record payload");
  reader.assertEnd();

  if (encoding === "raw" && payloadLength !== decodedLength) {
    throw new CanonicalBinaryError(
      "unexpected-value",
      "raw record payload length must equal its decoded length",
    );
  }
  if (encoding === "chunked-v1" && payloadLength !== SHA256_BYTE_LENGTH) {
    throw new CanonicalBinaryError(
      "unexpected-value",
      `chunked-v1 payload must be exactly ${SHA256_BYTE_LENGTH} bytes`,
    );
  }

  if (kind === "recipe") {
    return {
      kind,
      encoding,
      logicalId: recipeIdFromDigestBytes(digest),
      decodedLength,
      payload,
    };
  }
  if (kind === "content") {
    return {
      kind,
      encoding,
      logicalId: contentIdFromDigestBytes(digest),
      decodedLength,
      payload,
    };
  }
  return {
    kind,
    encoding,
    logicalId: metadataIdFromDigestBytes(digest),
    decodedLength,
    payload,
  };
}
