import { constants, zstdCompress } from "node:zlib";
import { describe, expect, it } from "vitest";

import {
  contentIdFromBytes,
  parseContentId,
  parseRecipeId,
  recipeIdFromCanonicalBytes,
} from "../src/infrastructure/content-store/ids.ts";
import { CHUNKED_CONTENT_MIN_BYTES } from "../src/infrastructure/content-store/chunk-recipe.ts";
import { FASTCDC_V1_PROFILE } from "../src/infrastructure/content-store/fastcdc.ts";
import {
  authenticateFullRecordPayload,
  chunkedContentRecipeId,
  compressionIsUseful,
  createChunkedContentRecord,
  createContentRecord,
  createOwnedContentRecord,
  createRecipeRecord,
  decodeRecordPayload,
  encodePayload,
  encodeOwnedPayload,
  minimumUsefulCompressionSavings,
} from "../src/infrastructure/content-store/representation.ts";
import {
  decodeZstdV1,
  encodeZstdV1,
} from "../src/infrastructure/content-store/zstd.ts";

function deterministicBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = 0x1234_5678;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

async function encodeWithWindowLog(
  input: Uint8Array,
  windowLog: number,
): Promise<Uint8Array> {
  return await new Promise<Uint8Array>((resolve, reject) => {
    zstdCompress(
      input,
      {
        pledgedSrcSize: input.byteLength,
        params: {
          [constants.ZSTD_c_contentSizeFlag]: 1,
          [constants.ZSTD_c_windowLog]: windowLog,
        },
      } as Parameters<typeof zstdCompress>[1] & { pledgedSrcSize: number },
      (error, encoded) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(encoded);
      },
    );
  });
}

describe("zstd-v1 codec", () => {
  it("writes one checksummed, content-sized frame and decodes it exactly", async () => {
    for (const input of [
      new Uint8Array(),
      Buffer.from("hello", "utf8"),
      Buffer.alloc(200_000, 0x61),
    ]) {
      const encoded = await encodeZstdV1(input);
      expect(Buffer.from(encoded.subarray(0, 4))).toEqual(
        Buffer.from([0x28, 0xb5, 0x2f, 0xfd]),
      );
      const frameDescriptor = encoded[4];
      expect(frameDescriptor).toBeDefined();
      expect((frameDescriptor ?? 0) & 0x04).toBe(0x04); // checksum flag
      expect((frameDescriptor ?? 0) & 0x20).toBe(0x20); // pledged single segment
      expect(
        Buffer.from(await decodeZstdV1(encoded, input.byteLength)),
      ).toEqual(Buffer.from(input));
    }
  });

  it("emits one complete frame when output fills the host chunk", async () => {
    const input = deterministicBytes(16_370);
    const encoded = await encodeZstdV1(input);
    expect(encoded.byteLength).toBe(16 * 1024);
    expect(Buffer.from(await decodeZstdV1(encoded, input.byteLength))).toEqual(
      Buffer.from(input),
    );
  });

  it("authenticates a production-selected zstd record beyond the host chunk", async () => {
    const input = deterministicBytes(20_000);
    input.fill(0, 0, 3_000);

    const record = await createContentRecord(input);
    expect(record.encoding).toBe("zstd-v1");
    expect(record.payload.byteLength).toBeGreaterThan(16 * 1024);
    expect(Buffer.from(await authenticateFullRecordPayload(record))).toEqual(
      Buffer.from(input),
    );
  });

  it("rejects ignored suffixes and concatenated frames", async () => {
    const input = Buffer.alloc(10_000, 0x61);
    const encoded = await encodeZstdV1(input);
    await expect(
      decodeZstdV1(
        Buffer.concat([encoded, Uint8Array.of(0)]),
        input.byteLength,
      ),
    ).rejects.toMatchObject({ code: "trailing-data" });
    await expect(
      decodeZstdV1(Buffer.concat([encoded, encoded]), input.byteLength),
    ).rejects.toMatchObject({ code: "trailing-data" });
  });

  it("enforces decoded length, checksum, and an 18-bit maximum window", async () => {
    const input = Buffer.alloc(20_000, 0x61);
    const encoded = await encodeZstdV1(input);
    await expect(
      decodeZstdV1(encoded, input.byteLength + 1),
    ).rejects.toMatchObject({ code: "decoded-length-mismatch" });
    await expect(
      decodeZstdV1(encoded, input.byteLength - 1),
    ).rejects.toMatchObject({ code: "decode-failed" });

    const corrupted = Uint8Array.from(encoded);
    const lastIndex = corrupted.byteLength - 1;
    corrupted[lastIndex] = (corrupted[lastIndex] ?? 0) ^ 0xff;
    await expect(
      decodeZstdV1(corrupted, input.byteLength),
    ).rejects.toMatchObject({ code: "decode-failed" });

    const large = deterministicBytes(600_000);
    const largeWindow = await encodeWithWindowLog(large, 19);
    await expect(
      decodeZstdV1(largeWindow, large.byteLength),
    ).rejects.toMatchObject({ code: "decode-failed" });
  });
});

describe("full content representation", () => {
  it("uses the exact max(64 bytes, 5%) savings policy", () => {
    expect(minimumUsefulCompressionSavings(1_000)).toBe(64);
    expect(compressionIsUseful(1_000, 936)).toBe(true);
    expect(compressionIsUseful(1_000, 937)).toBe(false);
    expect(minimumUsefulCompressionSavings(2_000)).toBe(100);
    expect(compressionIsUseful(2_000, 1_900)).toBe(true);
    expect(compressionIsUseful(2_000, 1_901)).toBe(false);
  });

  it("chooses raw for incompressible bytes and zstd-v1 for useful compression", async () => {
    const incompressible = deterministicBytes(8_192);
    const raw = await encodePayload(incompressible);
    expect(raw.encoding).toBe("raw");
    expect(raw.payload).toEqual(incompressible);

    const compressible = Buffer.alloc(8_192, 0x61);
    const compressed = await encodePayload(compressible);
    expect(compressed.encoding).toBe("zstd-v1");
    expect(compressed.payload.byteLength).toBeLessThan(
      compressible.byteLength -
        minimumUsefulCompressionSavings(compressible.byteLength),
    );

    const transferred = deterministicBytes(8_192);
    const owned = await encodeOwnedPayload(transferred);
    expect(owned.encoding).toBe("raw");
    expect(owned.payload).toBe(transferred);
    const tiny = await createOwnedContentRecord(deterministicBytes(64));
    expect(tiny).toMatchObject({ kind: "content", encoding: "raw" });
  });

  it("owns the observed bytes across asynchronous encoding", async () => {
    const source = Buffer.alloc(8_192, 0x61);
    const expectedId = contentIdFromBytes(source);
    const pending = createContentRecord(source);
    source.fill(0x62);
    const record = await pending;
    expect(record.logicalId).toBe(expectedId);
    expect(Buffer.from(await authenticateFullRecordPayload(record))).toEqual(
      Buffer.alloc(8_192, 0x61),
    );
  });

  it("authenticates content and domain-tagged recipe records", async () => {
    const content = Buffer.from("plain content", "utf8");
    const contentRecord = await createContentRecord(content);
    expect(contentRecord.kind).toBe("content");
    expect(contentRecord.logicalId).toBe(contentIdFromBytes(content));
    expect(
      Buffer.from(await authenticateFullRecordPayload(contentRecord)),
    ).toEqual(content);

    const recipe = Buffer.from("canonical recipe", "utf8");
    const recipeRecord = await createRecipeRecord(recipe);
    expect(recipeRecord.logicalId).toBe(recipeIdFromCanonicalBytes(recipe));
    expect(
      Buffer.from(await authenticateFullRecordPayload(recipeRecord)),
    ).toEqual(recipe);

    await expect(
      authenticateFullRecordPayload({
        ...contentRecord,
        logicalId: parseContentId("00".repeat(32)),
      }),
    ).rejects.toMatchObject({ code: "identity-mismatch" });
  });

  it("represents chunked content only as a fixed root RecipeId reference", async () => {
    const contentId = parseContentId("11".repeat(32));
    const recipeId = parseRecipeId("22".repeat(32));
    const record = createChunkedContentRecord(contentId, 300_000, recipeId);
    expect(record).toMatchObject({
      kind: "content",
      encoding: "chunked-v1",
      logicalId: contentId,
      decodedLength: 300_000,
    });
    expect(record.payload.byteLength).toBe(32);
    expect(chunkedContentRecipeId(record)).toBe(recipeId);
    await expect(decodeRecordPayload(record)).rejects.toMatchObject({
      code: "unsupported-encoding",
    });
    await expect(
      createContentRecord(new Uint8Array(FASTCDC_V1_PROFILE.maximumBytes + 1)),
    ).rejects.toMatchObject({ code: "unsupported-encoding" });
    expect(() =>
      createChunkedContentRecord(
        contentId,
        CHUNKED_CONTENT_MIN_BYTES - 1,
        recipeId,
      ),
    ).toThrowError(expect.objectContaining({ code: "unsupported-encoding" }));
  });
});
