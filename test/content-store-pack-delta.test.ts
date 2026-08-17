import { describe, expect, it } from "vitest";

import {
  applyDelta1Program,
  decodeDelta1Program,
  DELTA1_MAX_BASE_BYTES,
  DELTA1_MAX_TARGET_BYTES,
  Delta1FormatError,
  encodeDelta1Program,
  measureDelta1ProgramBytes,
} from "../src/infrastructure/content-store/pack-delta.ts";

describe("pack delta1 codec", () => {
  it("round-trips a bounded COPY/ADD program", () => {
    const program = {
      baseBackDistance: 2,
      instructions: [
        { kind: "copy", baseOffset: 1, byteLength: 3 },
        { kind: "add", bytes: Uint8Array.of(0x21) },
      ],
    } as const;
    const encoded = encodeDelta1Program(program, 4);
    expect(measureDelta1ProgramBytes(program, 4)).toBe(encoded.byteLength);
    const decoded = decodeDelta1Program(encoded, 4);

    expect(decoded).toEqual(program);
    expect(
      Buffer.from(
        applyDelta1Program(decoded, Buffer.from("abcde", "utf8"), 4),
      ).toString("utf8"),
    ).toBe("bcd!");
  });

  it("bounds one-hop base and target bytes at the full-record limit", () => {
    expect(DELTA1_MAX_BASE_BYTES).toBe(256 * 1024);
    expect(DELTA1_MAX_TARGET_BYTES).toBe(256 * 1024);
    const base = new Uint8Array(DELTA1_MAX_BASE_BYTES);
    const program = {
      baseBackDistance: 1,
      instructions: [
        { kind: "copy" as const, baseOffset: 0, byteLength: base.byteLength },
      ],
    };
    const encoded = encodeDelta1Program(program, DELTA1_MAX_TARGET_BYTES);

    expect(decodeDelta1Program(encoded, DELTA1_MAX_TARGET_BYTES)).toEqual(
      program,
    );
    expect(applyDelta1Program(program, base, DELTA1_MAX_TARGET_BYTES)).toEqual(
      base,
    );
    expect(() =>
      decodeDelta1Program(encoded, DELTA1_MAX_TARGET_BYTES + 1),
    ).toThrowError(Delta1FormatError);
  });

  it("rejects non-canonical varints, trailing bytes, unknown opcodes, and COPY overflow", () => {
    expect(() =>
      decodeDelta1Program(Uint8Array.of(1, 0x81, 0, 1, 1, 1, 0x61), 1),
    ).toThrowError(Delta1FormatError);

    const canonical = encodeDelta1Program(
      {
        baseBackDistance: 1,
        instructions: [{ kind: "add", bytes: Uint8Array.of(0x61) }],
      },
      1,
    );
    expect(() =>
      decodeDelta1Program(Uint8Array.from([...canonical, 0]), 1),
    ).toThrowError(Delta1FormatError);
    expect(() =>
      decodeDelta1Program(Uint8Array.of(1, 1, 1, 9), 1),
    ).toThrowError(Delta1FormatError);
    expect(() =>
      applyDelta1Program(
        {
          baseBackDistance: 1,
          instructions: [{ kind: "copy", baseOffset: 4, byteLength: 1 }],
        },
        Uint8Array.of(1, 2, 3, 4),
        1,
      ),
    ).toThrowError(Delta1FormatError);
  });
});
