import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  CanonicalBinaryError,
  CanonicalReader,
  CanonicalWriter,
  decodeUnsignedVarint,
  encodeUnsignedVarint,
} from "../src/infrastructure/content-store/canonical-binary.ts";
import {
  RECIPE_ID_DOMAIN_TAG,
  contentIdFromBytes,
  parseContentId,
  parseMetadataId,
  parseRecipeId,
  recipeIdFromCanonicalBytes,
} from "../src/infrastructure/content-store/ids.ts";
import {
  RECORD_ENCODING_CODES,
  RECORD_KIND_CODES,
  decodeRecord,
  encodeRecord,
} from "../src/infrastructure/content-store/record.ts";

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

describe("canonical content-store primitives", () => {
  it("uses canonical unsigned LEB128 through the safe-integer boundary", () => {
    const vectors = [
      [0, "00"],
      [1, "01"],
      [127, "7f"],
      [128, "8001"],
      [16_384, "808001"],
      [Number.MAX_SAFE_INTEGER, "ffffffffffffff0f"],
    ] as const;

    for (const [value, expected] of vectors) {
      const encoded = encodeUnsignedVarint(value);
      expect(hex(encoded)).toBe(expected);
      expect(decodeUnsignedVarint(encoded)).toEqual({
        value,
        nextOffset: encoded.byteLength,
      });
    }
  });

  it("rejects truncated, overlong, overflowing, and invalid varints", () => {
    expect(() => decodeUnsignedVarint(Uint8Array.of(0x80))).toThrowError(
      expect.objectContaining({ code: "truncated" }),
    );
    expect(() => decodeUnsignedVarint(Uint8Array.of(0x80, 0x00))).toThrowError(
      expect.objectContaining({ code: "non-canonical" }),
    );
    expect(() =>
      decodeUnsignedVarint(
        Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x20),
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid-integer" }));
    expect(() => encodeUnsignedVarint(-1)).toThrowError(
      expect.objectContaining({ code: "invalid-integer" }),
    );
  });

  it("owns writer input and makes bounds and end-of-input explicit", () => {
    const source = Uint8Array.of(1, 2, 3);
    const writer = new CanonicalWriter()
      .writeByte(9)
      .writeLengthPrefixedBytes(source);
    source[0] = 99;
    const encoded = writer.finish();
    expect(hex(encoded)).toBe("0903010203");

    const reader = new CanonicalReader(encoded);
    expect(reader.readByte()).toBe(9);
    expect(reader.readLengthPrefixedBytes(3)).toEqual(Uint8Array.of(1, 2, 3));
    reader.assertEnd();

    expect(() =>
      new CanonicalReader(Uint8Array.of(4, 1, 2, 3, 4)).readLengthPrefixedBytes(
        3,
      ),
    ).toThrowError(expect.objectContaining({ code: "limit-exceeded" }));
    expect(() =>
      new CanonicalReader(Uint8Array.of(1)).assertEnd(),
    ).toThrowError(expect.objectContaining({ code: "trailing-data" }));

    const bufferInput = Buffer.from([5, 6]);
    const ownedRead = new CanonicalReader(bufferInput).readBytes(2);
    bufferInput[0] = 99;
    expect(ownedRead).toEqual(Uint8Array.of(5, 6));
  });
});

describe("logical content-store ids", () => {
  it("defines ContentId as SHA-256 of the raw bytes", () => {
    expect(contentIdFromBytes(Buffer.from("abc", "utf8"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("domain-separates canonical recipe metadata without changing content ids", () => {
    const canonical = Buffer.from("canonical recipe", "utf8");
    const expected = createHash("sha256")
      .update(RECIPE_ID_DOMAIN_TAG, "utf8")
      .update(canonical)
      .digest("hex");
    expect(recipeIdFromCanonicalBytes(canonical)).toBe(expected);
    expect(recipeIdFromCanonicalBytes(canonical)).not.toBe(
      contentIdFromBytes(canonical),
    );
  });

  it("accepts only canonical lowercase SHA-256 text", () => {
    const id = "ab".repeat(32);
    expect(parseContentId(id)).toBe(id);
    expect(parseRecipeId(id)).toBe(id);
    expect(() => parseContentId(id.toUpperCase())).toThrow(TypeError);
    expect(() => parseMetadataId("0".repeat(63))).toThrow(TypeError);
  });
});

describe("canonical record envelope", () => {
  const limits = { maxDecodedBytes: 1_000, maxPayloadBytes: 1_000 };

  it("pins kind and encoding codes without a separate chunk kind", () => {
    expect(RECORD_KIND_CODES).toEqual({
      content: 1,
      recipe: 2,
      "tree-root": 3,
      "tree-node": 4,
      scope: 5,
    });
    expect(RECORD_ENCODING_CODES).toEqual({
      raw: 0,
      "zstd-v1": 1,
      "chunked-v1": 2,
      delta1: 3,
    });
  });

  it("has a stable canonical raw-content vector", () => {
    const payload = Buffer.from("abc", "utf8");
    const record = {
      kind: "content" as const,
      encoding: "raw" as const,
      logicalId: contentIdFromBytes(payload),
      decodedLength: payload.byteLength,
      payload,
    };
    const encoded = encodeRecord(record);
    expect(hex(encoded)).toBe(
      "4359524301010000ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad0303616263",
    );
    const decoded = decodeRecord(encoded, limits);
    expect({ ...decoded, payload: Buffer.from(decoded.payload) }).toEqual({
      ...record,
      payload: Buffer.from(record.payload),
    });
  });

  it("round-trips recipe, structural, and chunked-content records", () => {
    const recipeId = parseRecipeId("11".repeat(32));
    const metadataId = parseMetadataId("22".repeat(32));
    const contentId = parseContentId("33".repeat(32));
    const records = [
      {
        kind: "recipe" as const,
        encoding: "zstd-v1" as const,
        logicalId: recipeId,
        decodedLength: 100,
        payload: Uint8Array.of(1, 2, 3),
      },
      {
        kind: "tree-node" as const,
        encoding: "raw" as const,
        logicalId: metadataId,
        decodedLength: 1,
        payload: Uint8Array.of(7),
      },
      {
        kind: "content" as const,
        encoding: "chunked-v1" as const,
        logicalId: contentId,
        decodedLength: 500,
        payload: Buffer.from(recipeId, "hex"),
      },
    ];
    for (const record of records) {
      const decoded = decodeRecord(encodeRecord(record), limits);
      expect({ ...decoded, payload: Buffer.from(decoded.payload) }).toEqual({
        ...record,
        payload: Buffer.from(record.payload),
      });
    }
  });

  it("rejects unknown fields, non-canonical headers, trailing bytes, and limits", () => {
    const payload = Buffer.from("abc", "utf8");
    const encoded = encodeRecord({
      kind: "content",
      encoding: "raw",
      logicalId: contentIdFromBytes(payload),
      decodedLength: payload.byteLength,
      payload,
    });

    for (const offset of [5, 6]) {
      const invalid = Uint8Array.from(encoded);
      invalid[offset] = 99;
      expect(() => decodeRecord(invalid, limits)).toThrowError(
        expect.objectContaining({ code: "unexpected-value" }),
      );
    }
    const nonCanonicalFlags = Buffer.concat([
      encoded.subarray(0, 7),
      Uint8Array.of(0x80, 0x00),
      encoded.subarray(8),
    ]);
    expect(() => decodeRecord(nonCanonicalFlags, limits)).toThrowError(
      expect.objectContaining({ code: "non-canonical" }),
    );
    expect(() =>
      decodeRecord(Buffer.concat([encoded, Uint8Array.of(0)]), limits),
    ).toThrowError(expect.objectContaining({ code: "trailing-data" }));
    expect(() =>
      decodeRecord(encoded, { maxDecodedBytes: 2, maxPayloadBytes: 10 }),
    ).toThrowError(expect.objectContaining({ code: "limit-exceeded" }));
  });

  it("enforces representation-specific envelope shape", () => {
    const contentId = parseContentId("33".repeat(32));
    const recipeId = parseRecipeId("44".repeat(32));
    expect(() =>
      encodeRecord({
        kind: "content",
        encoding: "raw",
        logicalId: contentId,
        decodedLength: 2,
        payload: Uint8Array.of(1),
      }),
    ).toThrowError(CanonicalBinaryError);
    expect(() =>
      encodeRecord({
        kind: "recipe",
        encoding: "delta1",
        logicalId: recipeId,
        decodedLength: 2,
        payload: Uint8Array.of(1),
      }),
    ).toThrowError(CanonicalBinaryError);
    expect(() =>
      encodeRecord({
        kind: "content",
        encoding: "chunked-v1",
        logicalId: contentId,
        decodedLength: 100,
        payload: new Uint8Array(31),
      }),
    ).toThrowError(CanonicalBinaryError);
  });
});
