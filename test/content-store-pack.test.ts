import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { CanonicalReader } from "../src/infrastructure/content-store/canonical-binary.ts";
import { MAX_RECIPE_OBJECT_BYTES } from "../src/infrastructure/content-store/chunk-recipe.ts";
import {
  contentIdFromBytes,
  parseMetadataId,
  recipeIdFromCanonicalBytes,
} from "../src/infrastructure/content-store/ids.ts";
import {
  buildMultiPackIndex,
  decodeMultiPackIndex,
} from "../src/infrastructure/content-store/multi-pack-index.ts";
import {
  decodePack,
  encodePack,
  MAX_METADATA_RECORD_BYTES,
  measurePackInputBytes,
  METADATA_PACK_HARD_MAX_BYTES,
  openAuthenticatedPack,
  PACK_AUTHENTICATION_READ_BUFFER_BYTES,
  packPlanningUpperBoundBytes,
  PackFormatError,
  type PackPositionalReader,
} from "../src/infrastructure/content-store/pack.ts";
import {
  encodeDelta1Program,
  type Delta1Program,
} from "../src/infrastructure/content-store/pack-delta.ts";
import {
  encodeRecord,
  type RecordEnvelope,
} from "../src/infrastructure/content-store/record.ts";
import { encodeZstdV1 } from "../src/infrastructure/content-store/zstd.ts";
import { ABSOLUTE_MAX_TREE_MANIFEST_BYTES } from "../src/infrastructure/tree-formats/manifest-codec.ts";

const PACK_CHECKSUM_AND_MAGIC_BYTES = 32 + 8;
const PACK_FOOTER_LENGTH_BYTES = 8;

function contentRecord(bytes: Uint8Array): RecordEnvelope {
  return {
    kind: "content",
    encoding: "raw",
    logicalId: contentIdFromBytes(bytes),
    decodedLength: bytes.byteLength,
    payload: bytes,
  };
}

function resignPack(bytes: Uint8Array): Uint8Array {
  const owned = Uint8Array.from(bytes);
  const checksumOffset = owned.byteLength - PACK_CHECKSUM_AND_MAGIC_BYTES;
  const checksum = createHash("sha256")
    .update(owned.subarray(0, checksumOffset))
    .digest();
  owned.set(checksum, checksumOffset);
  return owned;
}

function footerOffset(bytes: Uint8Array): number {
  const footerLengthOffset =
    bytes.byteLength - PACK_CHECKSUM_AND_MAGIC_BYTES - PACK_FOOTER_LENGTH_BYTES;
  const footerLength = Number(
    Buffer.from(
      bytes.subarray(
        footerLengthOffset,
        footerLengthOffset + PACK_FOOTER_LENGTH_BYTES,
      ),
    ).readBigUInt64BE(),
  );
  return footerLengthOffset - footerLength;
}

function firstFooterEntryOffsetPosition(bytes: Uint8Array): number {
  const start = footerOffset(bytes);
  const footerLengthOffset =
    bytes.byteLength - PACK_CHECKSUM_AND_MAGIC_BYTES - PACK_FOOTER_LENGTH_BYTES;
  const reader = new CanonicalReader(bytes.slice(start, footerLengthOffset));
  reader.readBytes(8, "footer magic");
  reader.readByte("footer version");
  reader.readVarint("footer flags");
  reader.readVarint("footer record count");
  for (let index = 0; index < 256; index += 1) {
    reader.readVarint("footer fanout");
  }
  reader.readBytes(32, "logical id");
  reader.readByte("record kind");
  reader.readByte("record encoding");
  reader.readVarint("decoded length");
  reader.readVarint("physical ordinal");
  return start + reader.offset;
}

class CountingPackReader implements PackPositionalReader {
  readonly #bytes: Uint8Array;
  #nextReadBlock:
    | {
        readonly started: () => void;
        readonly wait: Promise<void>;
      }
    | undefined;
  readonly reads: Array<{
    readonly position: number;
    readonly length: number;
  }> = [];
  readonly responses: Array<{
    readonly position: number;
    readonly length: number;
    readonly bytes: Uint8Array;
  }> = [];
  closeCalls = 0;
  closed = false;

  constructor(bytes: Uint8Array) {
    this.#bytes = Uint8Array.from(bytes);
  }

  get byteLength(): number {
    return this.#bytes.byteLength;
  }

  async readExactly(position: number, length: number): Promise<Uint8Array> {
    if (this.closed) throw new Error("reader is closed");
    this.reads.push({ position, length });
    const block = this.#nextReadBlock;
    if (block !== undefined) {
      this.#nextReadBlock = undefined;
      block.started();
      await block.wait;
    }
    const bytes = Uint8Array.from(
      this.#bytes.subarray(position, position + length),
    );
    this.responses.push({ position, length, bytes });
    return bytes;
  }

  blockNextRead(): {
    readonly started: Promise<void>;
    readonly release: () => void;
  } {
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#nextReadBlock = { started: markStarted, wait };
    return { started, release };
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.closed = true;
  }
}

describe("content-store pack", () => {
  it("authenticates a self-indexed data pack and verifies logical content", async () => {
    const decoded = Buffer.from("one immutable observation", "utf8");
    const input = {
      packClass: "data",
      records: [contentRecord(decoded)],
    } as const;
    const result = await encodePack(input);
    const repeated = await encodePack(input);

    expect(repeated.bytes).toEqual(result.bytes);
    expect(measurePackInputBytes(input)).toBe(result.bytes.byteLength);
    expect(
      packPlanningUpperBoundBytes(
        input.records.length,
        input.records.reduce(
          (total, record) => total + encodeRecord(record).byteLength,
          0,
        ),
      ),
    ).toBeGreaterThanOrEqual(result.bytes.byteLength);
    expect(repeated.pack.packId).toBe(result.pack.packId);
    const checksumOffset =
      result.bytes.byteLength - PACK_CHECKSUM_AND_MAGIC_BYTES;
    expect(result.pack.packId).toBe(
      createHash("sha256")
        .update(result.bytes.subarray(0, checksumOffset))
        .digest("hex"),
    );
    const reopened = decodePack(result.bytes, result.pack.packId);
    const candidates = reopened.lookup({
      kind: "content",
      logicalId: contentIdFromBytes(decoded),
    });
    expect(candidates).toHaveLength(1);
    expect(Object.isFrozen(candidates)).toBe(true);
    expect(reopened.indexView()).toEqual(result.pack.indexView());
    expect(reopened.entryForPhysicalOrdinal(0)).toEqual(candidates[0]);
    expect(Buffer.from(await reopened.readVerified(candidates[0]!))).toEqual(
      decoded,
    );
  });

  it("authenticates through bounded positional reads and owns an explicit scope", async () => {
    const records = [0x61, 0x62, 0x63].map((fill) => {
      const bytes = Buffer.alloc(200 * 1024, fill);
      return contentRecord(bytes);
    });
    const encoded = await encodePack({ packClass: "data", records });
    const source = new CountingPackReader(encoded.bytes);
    const handle = await openAuthenticatedPack(source, encoded.pack.packId);
    expect(handle.indexView()).toEqual(encoded.pack.indexView());

    const checksumOffset = encoded.bytes.byteLength - 32 - 8;
    const authenticatedWholePrefix = source.reads.some((_, start) => {
      let covered = 0;
      for (const read of source.reads.slice(start)) {
        if (read.position !== covered || covered === checksumOffset) break;
        if (read.length > PACK_AUTHENTICATION_READ_BUFFER_BYTES) return false;
        covered += read.length;
      }
      return covered === checksumOffset;
    });
    expect(authenticatedWholePrefix).toBe(true);
    expect(
      Math.max(...source.reads.map(({ length }) => length)),
    ).toBeLessThanOrEqual(PACK_AUTHENTICATION_READ_BUFFER_BYTES);

    const selected = handle.lookup({
      kind: "content",
      logicalId: records[1]!.logicalId,
    })[0]!;
    const readsBeforeEnvelope = source.reads.length;
    const envelope = await handle.readEnvelope(selected);
    expect(envelope.logicalId).toBe(selected.logicalId);
    expect(source.reads.slice(readsBeforeEnvelope)).toEqual([
      { position: selected.offset, length: selected.length },
    ]);

    const blocked = source.blockNextRead();
    const inFlightRead = handle.readEnvelope(selected);
    await blocked.started;
    const closing = handle.close();
    expect(source.closed).toBe(false);
    blocked.release();
    await expect(inFlightRead).resolves.toMatchObject({
      logicalId: selected.logicalId,
    });
    await closing;
    await handle.close();
    expect(source.closeCalls).toBe(1);
    await expect(handle.readEnvelope(selected)).rejects.toMatchObject({
      code: "invalid-input",
    });
  });

  it("transfers an owned positional raw payload without retaining mutable source state", async () => {
    const decoded = Buffer.from("one exact owned record frame", "utf8");
    const encoded = await encodePack({
      packClass: "data",
      records: [contentRecord(decoded)],
    });
    const source = new CountingPackReader(encoded.bytes);
    const handle = await openAuthenticatedPack(source, encoded.pack.packId);
    const entry = handle.entries[0]!;

    try {
      const responsesBeforeEnvelope = source.responses.length;
      const envelope = await handle.readEnvelope(entry);
      const envelopeResponses = source.responses.slice(responsesBeforeEnvelope);
      expect(envelopeResponses).toHaveLength(1);
      expect(envelopeResponses[0]).toMatchObject({
        position: entry.offset,
        length: entry.length,
      });
      expect(envelope.payload.buffer).toBe(envelopeResponses[0]!.bytes.buffer);

      envelope.payload[0] = (envelope.payload[0] ?? 0) ^ 0xff;
      const reread = await handle.readEnvelope(entry);
      expect(Buffer.from(reread.payload)).toEqual(decoded);

      const responsesBeforeVerified = source.responses.length;
      const verified = await handle.readVerified(entry);
      const verifiedResponses = source.responses.slice(responsesBeforeVerified);
      expect(verifiedResponses).toHaveLength(1);
      expect(verifiedResponses[0]).toMatchObject({
        position: entry.offset,
        length: entry.length,
      });
      expect(verified.buffer).toBe(verifiedResponses[0]!.bytes.buffer);

      verified[0] = (verified[0] ?? 0) ^ 0xff;
      expect(Buffer.from(await handle.readVerified(entry))).toEqual(decoded);
    } finally {
      await handle.close();
    }
  });

  it("rejects mixed pack classes before publication", async () => {
    const decoded = Buffer.from("metadata", "utf8");
    const recipe: RecordEnvelope = {
      kind: "recipe",
      encoding: "raw",
      logicalId: recipeIdFromCanonicalBytes(decoded),
      decodedLength: decoded.byteLength,
      payload: decoded,
    };

    await expect(
      encodePack({ packClass: "data", records: [recipe] }),
    ).rejects.toMatchObject({ code: "invalid-input" });
  });

  it("rejects recipe records beyond the canonical recipe bound", async () => {
    const decoded = Buffer.alloc(MAX_RECIPE_OBJECT_BYTES + 1, 0x61);
    const recipe: RecordEnvelope = {
      kind: "recipe",
      encoding: "raw",
      logicalId: recipeIdFromCanonicalBytes(decoded),
      decodedLength: decoded.byteLength,
      payload: decoded,
    };

    await expect(
      encodePack({ packClass: "metadata", records: [recipe] }),
    ).rejects.toMatchObject({ code: "limit-exceeded" });
  });

  it("allows multiple physical encodings for one logical content id", async () => {
    const decoded = Buffer.alloc(32 * 1024, 0x61);
    const logicalId = contentIdFromBytes(decoded);
    const compressed: RecordEnvelope = {
      kind: "content",
      encoding: "zstd-v1",
      logicalId,
      decodedLength: decoded.byteLength,
      payload: await encodeZstdV1(decoded),
    };
    const encoded = await encodePack({
      packClass: "data",
      records: [contentRecord(decoded), compressed],
    });
    const representations = encoded.pack.lookup({
      kind: "content",
      logicalId,
    });

    expect(representations.map(({ encoding }) => encoding)).toEqual([
      "raw",
      "zstd-v1",
    ]);
    for (const representation of representations) {
      expect(
        Buffer.from(await encoded.pack.readVerified(representation)),
      ).toEqual(decoded);
    }
  });

  it("requires the owning canonical codec to verify tree and scope ids", async () => {
    const decoded = Buffer.from("canonical tree root", "utf8");
    const logicalId = parseMetadataId(
      createHash("sha256")
        .update("tree-domain\0")
        .update(decoded)
        .digest("hex"),
    );
    const record: RecordEnvelope = {
      kind: "tree-root",
      encoding: "raw",
      logicalId,
      decodedLength: decoded.byteLength,
      payload: decoded,
    };

    await expect(
      encodePack({ packClass: "metadata", records: [record] }),
    ).rejects.toMatchObject({ code: "verification-required" });

    const encoded = await encodePack(
      { packClass: "metadata", records: [record] },
      {
        verifyMetadataId: (kind, candidate, bytes) =>
          kind === "tree-root" &&
          candidate === logicalId &&
          Buffer.from(bytes).equals(decoded),
      },
    );
    const [entry] = encoded.pack.entries;
    await expect(encoded.pack.readVerified(entry!)).rejects.toMatchObject({
      code: "verification-required",
    });
    expect(
      Buffer.from(
        await encoded.pack.readVerified(entry!, {
          verifyMetadataId: () => true,
        }),
      ),
    ).toEqual(decoded);
  });

  it("admits a 65 MiB metadata singleton within the format limit", async () => {
    const decoded = new Uint8Array(65 * 1024 * 1024);
    decoded[0] = 0x43;
    decoded[decoded.byteLength - 1] = 0x59;
    const logicalId = parseMetadataId("ab".repeat(32));
    const record: RecordEnvelope = {
      kind: "scope",
      encoding: "raw",
      logicalId,
      decodedLength: decoded.byteLength,
      payload: decoded,
    };

    expect(MAX_METADATA_RECORD_BYTES).toBe(ABSOLUTE_MAX_TREE_MANIFEST_BYTES);
    expect(METADATA_PACK_HARD_MAX_BYTES).toBe(
      ABSOLUTE_MAX_TREE_MANIFEST_BYTES + 1024 * 1024,
    );
    const encoded = await encodePack(
      { packClass: "metadata", records: [record] },
      {
        verifyMetadataId: (kind, candidate, bytes) =>
          kind === "scope" &&
          candidate === logicalId &&
          bytes.byteLength === decoded.byteLength &&
          bytes[0] === 0x43 &&
          bytes[bytes.byteLength - 1] === 0x59,
      },
    );

    expect(encoded.pack.byteLength).toBeGreaterThan(decoded.byteLength);
    expect(encoded.pack.byteLength).toBeLessThanOrEqual(
      METADATA_PACK_HARD_MAX_BYTES,
    );
    expect(encoded.pack.entries).toHaveLength(1);
    expect(encoded.pack.entries[0]).toMatchObject({
      kind: "scope",
      decodedLength: decoded.byteLength,
    });
    const midx = decodeMultiPackIndex(
      buildMultiPackIndex([encoded.pack]).bytes,
    );
    expect(midx.packs[0]).toMatchObject({
      packId: encoded.pack.packId,
      packClass: "metadata",
      byteLength: encoded.pack.byteLength,
    });
  }, 30_000);

  it("exposes authenticated chunked references without materializing the whole file", async () => {
    const decoded = Buffer.alloc(300 * 1024, 0x61);
    const recipeBytes = Buffer.from("recipe", "utf8");
    const recipeId = recipeIdFromCanonicalBytes(recipeBytes);
    const record: RecordEnvelope = {
      kind: "content",
      encoding: "chunked-v1",
      logicalId: contentIdFromBytes(decoded),
      decodedLength: decoded.byteLength,
      payload: Buffer.from(recipeId, "hex"),
    };

    await expect(
      encodePack(
        {
          packClass: "data",
          records: [
            {
              ...record,
              logicalId: contentIdFromBytes(Uint8Array.of(0x61)),
              decodedLength: 1,
            },
          ],
        },
        { verifyChunkedContent: () => true },
      ),
    ).rejects.toMatchObject({ code: "invalid-format" });

    await expect(
      encodePack({ packClass: "data", records: [record] }),
    ).rejects.toMatchObject({ code: "verification-required" });
    const encoded = await encodePack(
      { packClass: "data", records: [record] },
      {
        verifyChunkedContent: ({ recipeId: observed }) => {
          expect(observed).toBe(recipeId);
          return true;
        },
      },
    );
    const representations = encoded.pack.lookup({
      kind: "content",
      logicalId: record.logicalId,
    });
    expect(representations.map(({ encoding }) => encoding)).toEqual([
      "chunked-v1",
    ]);
    const chunked = representations.find(
      ({ encoding }) => encoding === "chunked-v1",
    )!;
    const envelope = encoded.pack.recordEnvelope(chunked);
    expect(envelope.encoding).toBe("chunked-v1");
    expect(Buffer.from(envelope.payload).toString("hex")).toBe(recipeId);
    envelope.payload[0] = (envelope.payload[0] ?? 0) ^ 1;
    expect(
      Buffer.from(encoded.pack.recordEnvelope(chunked).payload).toString("hex"),
    ).toBe(recipeId);
    expect(() =>
      encoded.pack.recordEnvelope({ ...chunked, offset: chunked.offset + 1 }),
    ).toThrowError(PackFormatError);
    await expect(encoded.pack.readVerified(chunked)).rejects.toMatchObject({
      code: "verification-required",
    });
  });

  it("reconstructs delta1 from an earlier full record and verifies both ids", async () => {
    const base = Buffer.from("abcdefgh", "utf8");
    const target = Buffer.from("abXYefgh", "utf8");
    const program: Delta1Program = {
      baseBackDistance: 1,
      instructions: [
        { kind: "copy", baseOffset: 0, byteLength: 2 },
        { kind: "add", bytes: Buffer.from("XY", "utf8") },
        { kind: "copy", baseOffset: 4, byteLength: 4 },
      ],
    };
    const delta: RecordEnvelope = {
      kind: "content",
      encoding: "delta1",
      logicalId: contentIdFromBytes(target),
      decodedLength: target.byteLength,
      payload: encodeDelta1Program(program, target.byteLength),
    };
    const encoded = await encodePack({
      packClass: "data",
      records: [contentRecord(base), delta],
    });
    const entry = encoded.pack.lookup({
      kind: "content",
      logicalId: delta.logicalId,
    })[0]!;

    expect(Buffer.from(await encoded.pack.readVerified(entry))).toEqual(target);

    const source = new CountingPackReader(encoded.bytes);
    const handle = await openAuthenticatedPack(source, encoded.pack.packId);
    try {
      const streamedEntry = handle.lookup({
        kind: "content",
        logicalId: delta.logicalId,
      })[0]!;
      const readsBeforeTarget = source.reads.length;
      expect(Buffer.from(await handle.readVerified(streamedEntry))).toEqual(
        target,
      );
      expect(source.reads.slice(readsBeforeTarget)).toEqual([
        {
          position: streamedEntry.offset,
          length: streamedEntry.length,
        },
        {
          position: handle.entries.find(
            ({ physicalOrdinal }) => physicalOrdinal === 0,
          )!.offset,
          length: handle.entries.find(
            ({ physicalOrdinal }) => physicalOrdinal === 0,
          )!.length,
        },
      ]);
    } finally {
      await handle.close();
    }
  });

  it("rejects delta1 references to anything except an earlier full content record", async () => {
    const target = Buffer.from("target", "utf8");
    const delta: RecordEnvelope = {
      kind: "content",
      encoding: "delta1",
      logicalId: contentIdFromBytes(target),
      decodedLength: target.byteLength,
      payload: encodeDelta1Program(
        {
          baseBackDistance: 1,
          instructions: [{ kind: "add", bytes: target }],
        },
        target.byteLength,
      ),
    };

    await expect(
      encodePack({ packClass: "data", records: [delta] }),
    ).rejects.toThrow();
  });

  it("rejects a delta1 COPY range beyond its selected base during pack authentication", async () => {
    const base = Buffer.from("abcdefgh", "utf8");
    const target = Buffer.from("ab123456", "utf8");
    const program = encodeDelta1Program(
      {
        baseBackDistance: 1,
        instructions: [
          { kind: "copy", baseOffset: 0, byteLength: 2 },
          { kind: "add", bytes: Buffer.from("123456", "utf8") },
        ],
      },
      target.byteLength,
    );
    const encoded = await encodePack({
      packClass: "data",
      records: [
        contentRecord(base),
        {
          kind: "content",
          encoding: "delta1",
          logicalId: contentIdFromBytes(target),
          decodedLength: target.byteLength,
          payload: program,
        },
      ],
    });
    const deltaEntry = encoded.pack.lookup({
      kind: "content",
      logicalId: contentIdFromBytes(target),
    })[0]!;
    const malformed = Uint8Array.from(encoded.bytes);
    const payloadOffset =
      deltaEntry.offset + deltaEntry.length - program.length;
    // The canonical program prefix is version, base distance, instruction
    // count, COPY opcode, then this single-byte base offset.
    malformed[payloadOffset + 4] = 7;
    const resigned = resignPack(malformed);

    expect(() => decodePack(resigned)).toThrow(
      /COPY range exceeds its selected base/u,
    );
    const source = new CountingPackReader(resigned);
    await expect(openAuthenticatedPack(source)).rejects.toThrow(
      /COPY range exceeds its selected base/u,
    );
    expect(source.closeCalls).toBe(1);
  });

  it("fails closed on checksum, expected-id, flags, trailing, and footer corruption", async () => {
    const encoded = await encodePack({
      packClass: "data",
      records: [contentRecord(Buffer.from("integrity", "utf8"))],
    });

    const changed = Uint8Array.from(encoded.bytes);
    changed[12] = (changed[12] ?? 0) ^ 1;
    expect(() => decodePack(changed)).toThrowError(PackFormatError);
    const changedReader = new CountingPackReader(changed);
    await expect(openAuthenticatedPack(changedReader)).rejects.toThrowError(
      PackFormatError,
    );
    expect(changedReader.closeCalls).toBe(1);
    expect(() => decodePack(encoded.bytes, "0".repeat(64))).toThrowError(
      PackFormatError,
    );
    expect(() =>
      decodePack(Uint8Array.from([...encoded.bytes, 0])),
    ).toThrowError(PackFormatError);

    const unknownFlags = Uint8Array.from(encoded.bytes);
    unknownFlags[10] = 1;
    expect(() => decodePack(resignPack(unknownFlags))).toThrowError(
      /unsupported flags/u,
    );

    const invalidFooter = Uint8Array.from(encoded.bytes);
    const invalidFooterOffset = footerOffset(invalidFooter);
    invalidFooter[invalidFooterOffset] =
      (invalidFooter[invalidFooterOffset] ?? 0) ^ 1;
    expect(() => decodePack(resignPack(invalidFooter))).toThrowError(
      PackFormatError,
    );

    const invalidOffset = Uint8Array.from(encoded.bytes);
    const offsetPosition = firstFooterEntryOffsetPosition(invalidOffset);
    invalidOffset[offsetPosition] = (invalidOffset[offsetPosition] ?? 0) + 1;
    const resignedInvalidOffset = resignPack(invalidOffset);
    expect(() => decodePack(resignedInvalidOffset)).toThrowError(
      /physical record boundary/u,
    );
    const invalidOffsetReader = new CountingPackReader(resignedInvalidOffset);
    await expect(openAuthenticatedPack(invalidOffsetReader)).rejects.toThrow(
      /physical record boundary/u,
    );
    expect(invalidOffsetReader.closeCalls).toBe(1);
  });
});
