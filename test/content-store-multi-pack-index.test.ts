import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { CanonicalReader } from "../src/infrastructure/content-store/canonical-binary.ts";
import { contentIdFromBytes } from "../src/infrastructure/content-store/ids.ts";
import {
  buildMultiPackIndexFromViews,
  decodeMultiPackIndex,
  MultiPackIndexError,
  resolveMultiPackIndexEntry,
  validateMultiPackIndexViews,
} from "../src/infrastructure/content-store/multi-pack-index.ts";
import {
  encodePack,
  type AuthenticatedPack,
} from "../src/infrastructure/content-store/pack.ts";
import type { RecordEnvelope } from "../src/infrastructure/content-store/record.ts";

const MIDX_CHECKSUM_AND_MAGIC_BYTES = 32 + 8;

async function dataPack(bytes: Uint8Array): Promise<AuthenticatedPack> {
  const record: RecordEnvelope = {
    kind: "content",
    encoding: "raw",
    logicalId: contentIdFromBytes(bytes),
    decodedLength: bytes.byteLength,
    payload: bytes,
  };
  return (await encodePack({ packClass: "data", records: [record] })).pack;
}

function resignMidx(bytes: Uint8Array): Uint8Array {
  const owned = Uint8Array.from(bytes);
  const checksumOffset = owned.byteLength - MIDX_CHECKSUM_AND_MAGIC_BYTES;
  owned.set(
    createHash("sha256").update(owned.subarray(0, checksumOffset)).digest(),
    checksumOffset,
  );
  return owned;
}

function firstMidxEntryOffsetPosition(bytes: Uint8Array): number {
  const bodyEnd = bytes.byteLength - MIDX_CHECKSUM_AND_MAGIC_BYTES;
  const reader = new CanonicalReader(bytes.slice(0, bodyEnd));
  reader.readBytes(8, "MIDX magic");
  reader.readByte("MIDX version");
  reader.readVarint("MIDX flags");
  const packCount = reader.readVarint("MIDX pack count");
  reader.readVarint("MIDX entry count");
  for (let index = 0; index < packCount; index += 1) {
    reader.readBytes(32, "pack id");
    reader.readByte("pack class");
    reader.readVarint("pack byte length");
  }
  for (let index = 0; index < 256; index += 1) {
    reader.readVarint("MIDX fanout");
  }
  reader.readBytes(32, "logical id");
  reader.readByte("record kind");
  reader.readByte("record encoding");
  reader.readVarint("decoded length");
  reader.readVarint("pack ordinal");
  reader.readVarint("physical ordinal");
  return reader.offset;
}

describe("multi-pack index", () => {
  it("builds a canonical cache and resolves only through a matching pack footer", async () => {
    const firstBytes = Buffer.from("first", "utf8");
    const secondBytes = Buffer.from("second", "utf8");
    const first = await dataPack(firstBytes);
    const second = await dataPack(secondBytes);
    const built = buildMultiPackIndexFromViews([
      second.indexView(),
      first.indexView(),
    ]);
    expect(
      buildMultiPackIndexFromViews([first.indexView(), second.indexView()])
        .bytes,
    ).toEqual(built.bytes);
    const firstView = first.indexView();
    const secondView = second.indexView();
    expect(Object.keys(firstView).sort()).toEqual([
      "byteLength",
      "entries",
      "packClass",
      "packId",
    ]);
    expect(Object.isFrozen(firstView)).toBe(true);
    const reopened = decodeMultiPackIndex(built.bytes);

    expect(
      validateMultiPackIndexViews(reopened, [secondView, firstView]),
    ).toEqual({ kind: "current" });
    const candidates = reopened.lookup({
      kind: "content",
      logicalId: contentIdFromBytes(secondBytes),
    });
    expect(candidates).toHaveLength(1);
    const resolved = resolveMultiPackIndexEntry(
      reopened,
      candidates[0]!,
      new Map([
        [first.packId, first],
        [second.packId, second],
      ]),
    );
    expect(resolved.kind).toBe("hit");
    if (resolved.kind === "hit") {
      expect(
        Buffer.from(await second.readVerified(resolved.packEntry)),
      ).toEqual(secondBytes);
    }
  });

  it("reports an obsolete pack set as stale instead of treating MIDX as authority", async () => {
    const first = await dataPack(Buffer.from("first", "utf8"));
    const second = await dataPack(Buffer.from("second", "utf8"));
    const { index } = buildMultiPackIndexFromViews([
      first.indexView(),
      second.indexView(),
    ]);
    const candidate = index.entries[0]!;

    expect(
      validateMultiPackIndexViews(index, [first.indexView()]),
    ).toMatchObject({
      kind: "stale",
    });
    expect(
      resolveMultiPackIndexEntry(index, candidate, new Map()),
    ).toMatchObject({ kind: "stale" });
  });

  it("rejects candidates that do not exactly match their pack footer", async () => {
    const pack = await dataPack(Buffer.from("content", "utf8"));
    const { index } = buildMultiPackIndexFromViews([pack.indexView()]);
    const candidate = index.entries[0]!;
    const changed = { ...candidate, offset: candidate.offset + 1 };

    expect(
      resolveMultiPackIndexEntry(
        index,
        changed,
        new Map([[pack.packId, pack]]),
      ),
    ).toMatchObject({ kind: "stale" });
  });

  it("detects a checksummed but stale cached offset against the pack footer", async () => {
    const pack = await dataPack(Buffer.from("content", "utf8"));
    const built = buildMultiPackIndexFromViews([pack.indexView()]);
    const staleBytes = Uint8Array.from(built.bytes);
    const offsetPosition = firstMidxEntryOffsetPosition(staleBytes);
    staleBytes[offsetPosition] = (staleBytes[offsetPosition] ?? 0) + 1;
    const stale = decodeMultiPackIndex(resignMidx(staleBytes));
    const [candidate] = stale.entries;

    expect(
      resolveMultiPackIndexEntry(
        stale,
        candidate!,
        new Map([[pack.packId, pack]]),
      ),
    ).toMatchObject({ kind: "stale" });
  });

  it("round-trips an empty rebuildable cache", () => {
    const built = buildMultiPackIndexFromViews([]);
    const decoded = decodeMultiPackIndex(built.bytes);

    expect(decoded.packs).toEqual([]);
    expect(decoded.entries).toEqual([]);
    expect(validateMultiPackIndexViews(decoded, [])).toEqual({
      kind: "current",
    });
  });

  it("rejects checksum damage, trailing bytes, and authenticated unknown flags", async () => {
    const pack = await dataPack(Buffer.from("content", "utf8"));
    const built = buildMultiPackIndexFromViews([pack.indexView()]);
    const damaged = Uint8Array.from(built.bytes);
    damaged[12] = (damaged[12] ?? 0) ^ 1;

    expect(() => decodeMultiPackIndex(damaged)).toThrowError(
      MultiPackIndexError,
    );
    expect(() =>
      decodeMultiPackIndex(Uint8Array.from([...built.bytes, 0])),
    ).toThrowError(MultiPackIndexError);

    const unknownFlags = Uint8Array.from(built.bytes);
    unknownFlags[9] = 1;
    expect(() => decodeMultiPackIndex(resignMidx(unknownFlags))).toThrowError(
      /unsupported flags/u,
    );
  });
});
