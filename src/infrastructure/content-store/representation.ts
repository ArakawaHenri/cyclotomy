import {
  idToBytes,
  contentIdFromBytes,
  recipeIdFromDigestBytes,
  recipeIdFromCanonicalBytes,
  SHA256_BYTE_LENGTH,
  type ContentId,
  type RecipeId,
} from "./ids.ts";
import { CHUNKED_CONTENT_MIN_BYTES } from "./chunk-recipe.ts";
import { FASTCDC_V1_PROFILE } from "./fastcdc.ts";
import { type RecordEnvelope, type RecordEncoding } from "./record.ts";
import { decodeZstdV1, encodeOwnedZstdV1 } from "./zstd.ts";

export type FullRecordEncoding = Extract<RecordEncoding, "raw" | "zstd-v1">;

export interface EncodedPayload {
  readonly encoding: FullRecordEncoding;
  readonly decodedLength: number;
  readonly payload: Uint8Array;
}

export type ContentRecord = Extract<
  RecordEnvelope,
  { readonly kind: "content" }
>;

export type RecipeRecord = Extract<RecordEnvelope, { readonly kind: "recipe" }>;

export type FullContentRecord = ContentRecord & {
  readonly encoding: FullRecordEncoding;
};

export type ChunkedContentRecord = ContentRecord & {
  readonly encoding: "chunked-v1";
};

export type FullRecipeRecord = RecipeRecord & {
  readonly encoding: FullRecordEncoding;
};

export type SelfAuthenticatingRecord = FullContentRecord | FullRecipeRecord;

export type ContentRepresentationErrorCode =
  "decoded-length-mismatch" | "identity-mismatch" | "unsupported-encoding";

export class ContentRepresentationError extends Error {
  readonly code: ContentRepresentationErrorCode;

  constructor(code: ContentRepresentationErrorCode, message: string) {
    super(message);
    this.name = "ContentRepresentationError";
    this.code = code;
  }
}

export function minimumUsefulCompressionSavings(decodedLength: number): number {
  if (!Number.isSafeInteger(decodedLength) || decodedLength < 0) {
    throw new TypeError("decoded length must be a non-negative safe integer");
  }
  const fivePercent =
    Math.floor(decodedLength / 20) + (decodedLength % 20 === 0 ? 0 : 1);
  return Math.max(64, fivePercent);
}

export function compressionIsUseful(
  decodedLength: number,
  encodedLength: number,
): boolean {
  if (!Number.isSafeInteger(encodedLength) || encodedLength < 0) {
    throw new TypeError("encoded length must be a non-negative safe integer");
  }
  return (
    decodedLength - encodedLength >=
    minimumUsefulCompressionSavings(decodedLength)
  );
}

/** Choose raw or the fixed zstd profile from one immutable byte observation. */
export async function encodePayload(
  decoded: Uint8Array,
): Promise<EncodedPayload> {
  const ownedDecoded = Uint8Array.from(decoded);
  return await encodeOwnedPayload(ownedDecoded);
}

/** Ownership-transfer variant; callers must not mutate `decoded` afterward. */
export async function encodeOwnedPayload(
  decoded: Uint8Array,
): Promise<EncodedPayload> {
  // A positive frame cannot save the required 64 bytes from an input this
  // small, so avoid scheduling codec work whose result is provably unusable.
  if (
    decoded.byteLength <= minimumUsefulCompressionSavings(decoded.byteLength)
  ) {
    return {
      encoding: "raw",
      decodedLength: decoded.byteLength,
      payload: decoded,
    };
  }
  const compressed = await encodeOwnedZstdV1(decoded);
  if (compressionIsUseful(decoded.byteLength, compressed.byteLength)) {
    return {
      encoding: "zstd-v1",
      decodedLength: decoded.byteLength,
      payload: compressed,
    };
  }
  return {
    encoding: "raw",
    decodedLength: decoded.byteLength,
    payload: decoded,
  };
}

export async function decodePayload(
  encoded: EncodedPayload,
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(encoded.decodedLength) ||
    encoded.decodedLength < 0
  ) {
    throw new ContentRepresentationError(
      "decoded-length-mismatch",
      "decoded length must be a non-negative safe integer",
    );
  }
  if (encoded.encoding === "raw") {
    if (encoded.payload.byteLength !== encoded.decodedLength) {
      throw new ContentRepresentationError(
        "decoded-length-mismatch",
        `raw payload has ${encoded.payload.byteLength} bytes; expected ${encoded.decodedLength}`,
      );
    }
    return Uint8Array.from(encoded.payload);
  }
  if (encoded.encoding === "zstd-v1") {
    return await decodeZstdV1(encoded.payload, encoded.decodedLength);
  }
  throw new ContentRepresentationError(
    "unsupported-encoding",
    `full payload cannot use ${String(encoded.encoding)} encoding`,
  );
}

export async function createContentRecord(
  decoded: Uint8Array,
): Promise<FullContentRecord> {
  const ownedDecoded = Uint8Array.from(decoded);
  return await createOwnedContentRecord(ownedDecoded);
}

/** Ownership-transfer path for the owned chunks emitted by the stream plan. */
export async function createOwnedContentRecord(
  decoded: Uint8Array,
): Promise<FullContentRecord> {
  if (decoded.byteLength > FASTCDC_V1_PROFILE.maximumBytes) {
    throw new ContentRepresentationError(
      "unsupported-encoding",
      `full content cannot exceed ${FASTCDC_V1_PROFILE.maximumBytes} decoded bytes`,
    );
  }
  const logicalId = contentIdFromBytes(decoded);
  const encoded = await encodeOwnedPayload(decoded);
  return {
    kind: "content",
    logicalId,
    ...encoded,
  };
}

export async function createRecipeRecord(
  canonicalRecipe: Uint8Array,
): Promise<FullRecipeRecord> {
  const ownedRecipe = Uint8Array.from(canonicalRecipe);
  const encoded = await encodeOwnedPayload(ownedRecipe);
  return {
    kind: "recipe",
    logicalId: recipeIdFromCanonicalBytes(ownedRecipe),
    ...encoded,
  };
}

export async function decodeRecordPayload(
  record: RecordEnvelope,
): Promise<Uint8Array> {
  if (record.encoding === "chunked-v1" || record.encoding === "delta1") {
    throw new ContentRepresentationError(
      "unsupported-encoding",
      `${record.encoding} records require their authenticated dependency graph`,
    );
  }
  return await decodePayload({
    encoding: record.encoding,
    decodedLength: record.decodedLength,
    payload: record.payload,
  });
}

export function createChunkedContentRecord(
  contentId: ContentId,
  decodedLength: number,
  rootRecipeId: RecipeId,
): ChunkedContentRecord {
  if (!Number.isSafeInteger(decodedLength) || decodedLength < 0) {
    throw new TypeError("decoded length must be a non-negative safe integer");
  }
  if (decodedLength < CHUNKED_CONTENT_MIN_BYTES) {
    throw new ContentRepresentationError(
      "unsupported-encoding",
      `chunked content must be at least ${CHUNKED_CONTENT_MIN_BYTES} decoded bytes`,
    );
  }
  return {
    kind: "content",
    encoding: "chunked-v1",
    logicalId: contentId,
    decodedLength,
    payload: idToBytes(rootRecipeId),
  };
}

export function chunkedContentRecipeId(record: ChunkedContentRecord): RecipeId {
  if (
    record.encoding !== "chunked-v1" ||
    record.payload.byteLength !== SHA256_BYTE_LENGTH
  ) {
    throw new ContentRepresentationError(
      "unsupported-encoding",
      "content record is not a canonical chunked-v1 reference",
    );
  }
  return recipeIdFromDigestBytes(record.payload);
}

/**
 * Authenticate one self-contained full record. Chunked and delta records need
 * their dependency-specific verifier and cannot use this shortcut.
 */
export async function authenticateFullRecordPayload(
  record: SelfAuthenticatingRecord,
): Promise<Uint8Array> {
  const decoded = await decodeRecordPayload(record);
  const observedId: ContentId | RecipeId =
    record.kind === "recipe"
      ? recipeIdFromCanonicalBytes(decoded)
      : contentIdFromBytes(decoded);
  if (observedId !== record.logicalId) {
    throw new ContentRepresentationError(
      "identity-mismatch",
      `${record.kind} record decoded bytes do not match logical id ${record.logicalId}`,
    );
  }
  return decoded;
}
