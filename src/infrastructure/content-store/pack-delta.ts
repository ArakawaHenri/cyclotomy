import {
  CanonicalBinaryError,
  CanonicalReader,
  CanonicalWriter,
  unsignedVarintLength,
} from "./canonical-binary.ts";
import { FASTCDC_V1_PROFILE } from "./fastcdc.ts";

export const DELTA1_MAX_TARGET_BYTES = FASTCDC_V1_PROFILE.maximumBytes;
export const DELTA1_MAX_BASE_BYTES = FASTCDC_V1_PROFILE.maximumBytes;
export const DELTA1_MAX_INSTRUCTIONS = 8 * 1024;
export const DELTA1_MAX_PAYLOAD_BYTES = 256 * 1024;
export const DELTA1_MAX_BASE_BACK_DISTANCE = 65_535;

export const DELTA1_FORMAT_VERSION = 1;
const COPY_OPCODE = 0;
const ADD_OPCODE = 1;

export type Delta1Instruction =
  | {
      readonly kind: "copy";
      readonly baseOffset: number;
      readonly byteLength: number;
    }
  | { readonly kind: "add"; readonly bytes: Uint8Array };

export interface Delta1Program {
  /** Number of physical records between this delta and its earlier full base. */
  readonly baseBackDistance: number;
  readonly instructions: readonly Delta1Instruction[];
}

export class Delta1FormatError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "Delta1FormatError";
  }
}

function invalidDelta(message: string, cause?: unknown): never {
  throw new Delta1FormatError(message, cause);
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    invalidDelta(`${label} must be a positive safe integer`);
  }
}

function assertTargetLength(targetLength: number): void {
  if (
    !Number.isSafeInteger(targetLength) ||
    targetLength < 0 ||
    targetLength > DELTA1_MAX_TARGET_BYTES
  ) {
    invalidDelta(
      `delta1 target length must be between 0 and ${DELTA1_MAX_TARGET_BYTES} bytes`,
    );
  }
}

function checkedOutputLength(current: number, added: number): number {
  if (added > DELTA1_MAX_TARGET_BYTES - current) {
    invalidDelta(
      `delta1 instructions exceed the ${DELTA1_MAX_TARGET_BYTES}-byte target limit`,
    );
  }
  return current + added;
}

function validateProgram(
  program: Delta1Program,
  expectedTargetLength: number,
): void {
  assertTargetLength(expectedTargetLength);
  assertPositiveSafeInteger(
    program.baseBackDistance,
    "delta1 base back-distance",
  );
  if (program.baseBackDistance > DELTA1_MAX_BASE_BACK_DISTANCE) {
    invalidDelta(
      `delta1 base back-distance exceeds ${DELTA1_MAX_BASE_BACK_DISTANCE}`,
    );
  }
  if (
    program.instructions.length === 0 ||
    program.instructions.length > DELTA1_MAX_INSTRUCTIONS
  ) {
    invalidDelta(
      `delta1 instruction count must be between 1 and ${DELTA1_MAX_INSTRUCTIONS}`,
    );
  }

  let outputLength = 0;
  for (const instruction of program.instructions) {
    switch (instruction.kind) {
      case "copy": {
        if (
          !Number.isSafeInteger(instruction.baseOffset) ||
          instruction.baseOffset < 0 ||
          instruction.baseOffset > DELTA1_MAX_BASE_BYTES
        ) {
          invalidDelta(
            `delta1 COPY offset must be between 0 and ${DELTA1_MAX_BASE_BYTES}`,
          );
        }
        assertPositiveSafeInteger(instruction.byteLength, "delta1 COPY length");
        if (
          instruction.byteLength >
          DELTA1_MAX_BASE_BYTES - instruction.baseOffset
        ) {
          invalidDelta(
            `delta1 COPY range exceeds the ${DELTA1_MAX_BASE_BYTES}-byte base limit`,
          );
        }
        outputLength = checkedOutputLength(
          outputLength,
          instruction.byteLength,
        );
        break;
      }
      case "add": {
        assertPositiveSafeInteger(
          instruction.bytes.byteLength,
          "delta1 ADD length",
        );
        outputLength = checkedOutputLength(
          outputLength,
          instruction.bytes.byteLength,
        );
        break;
      }
    }
  }

  if (outputLength !== expectedTargetLength) {
    invalidDelta(
      `delta1 produces ${outputLength} bytes, expected ${expectedTargetLength}`,
    );
  }
}

export function encodeDelta1Program(
  program: Delta1Program,
  expectedTargetLength: number,
): Uint8Array {
  const expectedEncodedLength = measureDelta1ProgramBytes(
    program,
    expectedTargetLength,
  );
  if (expectedEncodedLength > DELTA1_MAX_PAYLOAD_BYTES) {
    invalidDelta(
      `delta1 payload exceeds the ${DELTA1_MAX_PAYLOAD_BYTES}-byte limit`,
    );
  }
  const writer = new CanonicalWriter()
    .writeByte(DELTA1_FORMAT_VERSION)
    .writeVarint(program.baseBackDistance)
    .writeVarint(program.instructions.length);

  for (const instruction of program.instructions) {
    switch (instruction.kind) {
      case "copy":
        writer
          .writeByte(COPY_OPCODE)
          .writeVarint(instruction.baseOffset)
          .writeVarint(instruction.byteLength);
        break;
      case "add":
        writer
          .writeByte(ADD_OPCODE)
          .writeLengthPrefixedBytes(instruction.bytes);
        break;
    }
  }

  const encoded = writer.finish();
  if (encoded.byteLength !== expectedEncodedLength) {
    invalidDelta("delta1 program length calculation drifted from its codec");
  }
  return encoded;
}

/** Exact canonical byte length without allocating the encoded program. */
export function measureDelta1ProgramBytes(
  program: Delta1Program,
  expectedTargetLength: number,
): number {
  validateProgram(program, expectedTargetLength);
  let length =
    1 +
    unsignedVarintLength(program.baseBackDistance) +
    unsignedVarintLength(program.instructions.length);
  for (const instruction of program.instructions) {
    length += 1;
    if (instruction.kind === "copy") {
      length +=
        unsignedVarintLength(instruction.baseOffset) +
        unsignedVarintLength(instruction.byteLength);
    } else {
      length +=
        unsignedVarintLength(instruction.bytes.byteLength) +
        instruction.bytes.byteLength;
    }
  }
  return length;
}

export function decodeDelta1Program(
  encoded: Uint8Array,
  expectedTargetLength: number,
): Delta1Program {
  assertTargetLength(expectedTargetLength);
  if (encoded.byteLength > DELTA1_MAX_PAYLOAD_BYTES) {
    invalidDelta(
      `delta1 payload exceeds the ${DELTA1_MAX_PAYLOAD_BYTES}-byte limit`,
    );
  }

  try {
    const reader = new CanonicalReader(encoded);
    const version = reader.readByte("delta1 version");
    if (version !== DELTA1_FORMAT_VERSION) {
      invalidDelta(`unsupported delta1 format version ${version}`);
    }

    const baseBackDistance = reader.readVarint("delta1 base back-distance");
    if (
      baseBackDistance === 0 ||
      baseBackDistance > DELTA1_MAX_BASE_BACK_DISTANCE
    ) {
      invalidDelta(
        `delta1 base back-distance must be between 1 and ${DELTA1_MAX_BASE_BACK_DISTANCE}`,
      );
    }

    const instructionCount = reader.readVarint("delta1 instruction count");
    if (instructionCount === 0 || instructionCount > DELTA1_MAX_INSTRUCTIONS) {
      invalidDelta(
        `delta1 instruction count must be between 1 and ${DELTA1_MAX_INSTRUCTIONS}`,
      );
    }

    const instructions: Delta1Instruction[] = [];
    let outputLength = 0;
    for (let index = 0; index < instructionCount; index += 1) {
      const opcode = reader.readByte(`delta1 instruction ${index} opcode`);
      if (opcode === COPY_OPCODE) {
        const baseOffset = reader.readVarint(
          `delta1 instruction ${index} COPY offset`,
        );
        const byteLength = reader.readVarint(
          `delta1 instruction ${index} COPY length`,
        );
        if (byteLength === 0) {
          invalidDelta(`delta1 instruction ${index} COPY length is zero`);
        }
        if (
          baseOffset > DELTA1_MAX_BASE_BYTES ||
          byteLength > DELTA1_MAX_BASE_BYTES - baseOffset
        ) {
          invalidDelta(
            `delta1 instruction ${index} COPY range exceeds the base limit`,
          );
        }
        outputLength = checkedOutputLength(outputLength, byteLength);
        instructions.push({ kind: "copy", baseOffset, byteLength });
        continue;
      }

      if (opcode === ADD_OPCODE) {
        const bytes = reader.readLengthPrefixedBytes(
          DELTA1_MAX_TARGET_BYTES,
          `delta1 instruction ${index} ADD bytes`,
        );
        if (bytes.byteLength === 0) {
          invalidDelta(`delta1 instruction ${index} ADD length is zero`);
        }
        outputLength = checkedOutputLength(outputLength, bytes.byteLength);
        instructions.push({ kind: "add", bytes });
        continue;
      }

      invalidDelta(`unknown delta1 opcode ${opcode}`);
    }
    reader.assertEnd();

    const program = { baseBackDistance, instructions } as const;
    validateProgram(program, expectedTargetLength);
    return program;
  } catch (error) {
    if (error instanceof Delta1FormatError) {
      throw error;
    }
    if (error instanceof CanonicalBinaryError) {
      invalidDelta(`invalid delta1 payload: ${error.message}`, error);
    }
    throw error;
  }
}

export function applyDelta1Program(
  program: Delta1Program,
  base: Uint8Array,
  expectedTargetLength: number,
): Uint8Array {
  validateProgram(program, expectedTargetLength);
  if (base.byteLength > DELTA1_MAX_BASE_BYTES) {
    invalidDelta(`delta1 base exceeds the ${DELTA1_MAX_BASE_BYTES}-byte limit`);
  }

  const target = new Uint8Array(expectedTargetLength);
  let targetOffset = 0;
  for (const instruction of program.instructions) {
    if (instruction.kind === "copy") {
      if (
        instruction.baseOffset > base.byteLength ||
        instruction.byteLength > base.byteLength - instruction.baseOffset
      ) {
        invalidDelta("delta1 COPY range exceeds the decoded base");
      }
      target.set(
        base.subarray(
          instruction.baseOffset,
          instruction.baseOffset + instruction.byteLength,
        ),
        targetOffset,
      );
      targetOffset += instruction.byteLength;
      continue;
    }

    target.set(instruction.bytes, targetOffset);
    targetOffset += instruction.bytes.byteLength;
  }

  if (targetOffset !== expectedTargetLength) {
    invalidDelta(
      `delta1 reconstructed ${targetOffset} bytes, expected ${expectedTargetLength}`,
    );
  }
  return target;
}
