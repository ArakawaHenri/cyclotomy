import { describe, expect, it } from "vitest";

import {
  FASTCDC_V1_PROFILE,
  FastCdcV1StreamBuilder,
  chunkFastCdcV1,
} from "../src/infrastructure/content-store/fastcdc.ts";

function deterministicBytes(length: number, seed = 0x1234_5678): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

describe("fastcdc-v1", () => {
  it("pins the repository profile and Gear table identity", () => {
    expect(FASTCDC_V1_PROFILE).toEqual({
      id: "fastcdc-v1",
      minimumBytes: 16 * 1024,
      averageBytes: 64 * 1024,
      maximumBytes: 256 * 1024,
      normalizationLevel: 2,
      preAverageMask: 0x0003_ffff,
      postAverageMask: 0x0000_3fff,
      gearTableSha256:
        "bee0cf4dc94f60a1f2135be81664737899efa088ea4ca06d8d848c92da00b3b5",
    });
  });

  it("matches the deterministic fastcdc-v1 golden vector", () => {
    const chunks = chunkFastCdcV1(deterministicBytes(1024 * 1024));
    expect(chunks.map((chunk) => chunk.length)).toEqual([
      94_469, 70_941, 70_712, 89_051, 37_196, 71_364, 74_862, 67_831, 66_913,
      72_733, 86_376, 130_609, 17_352, 85_242, 12_925,
    ]);
  });

  it("covers input exactly and enforces the fixed size bounds", () => {
    const input = deterministicBytes(3 * 1024 * 1024, 0xdecafbad);
    const chunks = chunkFastCdcV1(input);
    expect(chunks[0]?.offset).toBe(0);
    let offset = 0;
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      expect(chunk).toBeDefined();
      if (chunk === undefined) {
        throw new Error("missing chunk");
      }
      expect(chunk.offset).toBe(offset);
      expect(chunk.length).toBeGreaterThan(0);
      expect(chunk.length).toBeLessThanOrEqual(FASTCDC_V1_PROFILE.maximumBytes);
      if (index < chunks.length - 1) {
        expect(chunk.length).toBeGreaterThanOrEqual(
          FASTCDC_V1_PROFILE.minimumBytes,
        );
      }
      offset += chunk.length;
    }
    expect(offset).toBe(input.byteLength);
    expect(chunkFastCdcV1(new Uint8Array())).toEqual([]);
  });

  it("makes every emitted chunk a one-chunk input from a fresh boundary", () => {
    const input = deterministicBytes(3 * 1024 * 1024, 0x5eed_cdc1);
    const chunks = chunkFastCdcV1(input);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const bytes = input.subarray(chunk.offset, chunk.offset + chunk.length);
      expect(chunkFastCdcV1(bytes)).toEqual([
        { offset: 0, length: chunk.length },
      ]);
    }
  });

  it("produces identical boundaries under arbitrary streamed push sizes", async () => {
    const input = deterministicBytes(2 * 1024 * 1024, 0x1020_3040);
    const expected = chunkFastCdcV1(input);
    const observed: { offset: number; length: number; bytes: Uint8Array }[] =
      [];
    const builder = new FastCdcV1StreamBuilder((chunk) => {
      observed.push(chunk);
    });
    const pushSizes = [1, 17, 16_383, 65_537, 3, 262_144, 8_191];
    let offset = 0;
    let pushIndex = 0;
    while (offset < input.byteLength) {
      const requested = pushSizes[pushIndex % pushSizes.length] ?? 1;
      const length = Math.min(requested, input.byteLength - offset);
      await builder.push(input.subarray(offset, offset + length));
      offset += length;
      pushIndex += 1;
    }
    const result = await builder.finish();

    expect(
      observed.map((chunk) => ({
        offset: chunk.offset,
        length: chunk.length,
      })),
    ).toEqual(expected);
    expect(result).toEqual({
      chunkCount: expected.length,
      decodedLength: input.byteLength,
    });
    expect(Buffer.concat(observed.map((chunk) => chunk.bytes))).toEqual(
      Buffer.from(input),
    );
  });

  it("backpressures its sink and rejects concurrent or post-finish calls", async () => {
    let enterSink: (() => void) | undefined;
    let releaseSink: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enterSink = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseSink = resolve;
    });
    const builder = new FastCdcV1StreamBuilder(async () => {
      enterSink?.();
      await released;
    });
    const pending = builder.push(
      new Uint8Array(FASTCDC_V1_PROFILE.maximumBytes),
    );
    await entered;
    await expect(builder.push(Uint8Array.of(1))).rejects.toThrow(
      /another builder call/u,
    );
    releaseSink?.();
    await pending;
    await builder.finish();
    await expect(builder.push(Uint8Array.of(1))).rejects.toThrow(/settled/u);
    await expect(builder.finish()).rejects.toThrow(/settled/u);
  });
});
