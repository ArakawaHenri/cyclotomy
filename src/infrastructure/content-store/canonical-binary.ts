export type CanonicalBinaryErrorCode =
  | "invalid-integer"
  | "limit-exceeded"
  | "non-canonical"
  | "trailing-data"
  | "truncated"
  | "unexpected-value";

export class CanonicalBinaryError extends Error {
  readonly code: CanonicalBinaryErrorCode;

  constructor(code: CanonicalBinaryErrorCode, message: string) {
    super(message);
    this.name = "CanonicalBinaryError";
    this.code = code;
  }
}

export interface DecodedUnsignedVarint {
  readonly value: number;
  readonly nextOffset: number;
}

function assertSafeUnsignedInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CanonicalBinaryError(
      "invalid-integer",
      `${label} must be a non-negative safe integer`,
    );
  }
}

export function unsignedVarintLength(value: number): number {
  assertSafeUnsignedInteger(value, "varint value");
  let remaining = value;
  let length = 1;
  while (remaining >= 0x80) {
    remaining = Math.floor(remaining / 0x80);
    length += 1;
  }
  return length;
}

/** Canonical unsigned LEB128, restricted to JavaScript safe integers. */
export function encodeUnsignedVarint(value: number): Uint8Array {
  const encoded = new Uint8Array(unsignedVarintLength(value));
  let remaining = value;
  for (let index = 0; index < encoded.byteLength; index += 1) {
    const payload = remaining % 0x80;
    remaining = Math.floor(remaining / 0x80);
    encoded[index] = payload | (remaining === 0 ? 0 : 0x80);
  }
  return encoded;
}

export function decodeUnsignedVarint(
  input: Uint8Array,
  offset = 0,
): DecodedUnsignedVarint {
  assertSafeUnsignedInteger(offset, "varint offset");
  if (offset > input.byteLength) {
    throw new CanonicalBinaryError(
      "truncated",
      "varint offset is beyond the input",
    );
  }

  let value = 0;
  let factor = 1;
  for (let index = offset; index < input.byteLength; index += 1) {
    const byte = input[index];
    if (byte === undefined) {
      throw new CanonicalBinaryError("truncated", "truncated varint");
    }
    const payload = byte & 0x7f;
    if (payload > Math.floor((Number.MAX_SAFE_INTEGER - value) / factor)) {
      throw new CanonicalBinaryError(
        "invalid-integer",
        "varint exceeds the maximum safe integer",
      );
    }
    value += payload * factor;

    if ((byte & 0x80) === 0) {
      const encodedLength = index - offset + 1;
      if (encodedLength !== unsignedVarintLength(value)) {
        throw new CanonicalBinaryError(
          "non-canonical",
          "varint uses a non-canonical overlong encoding",
        );
      }
      return { value, nextOffset: index + 1 };
    }

    if (factor > Math.floor(Number.MAX_SAFE_INTEGER / 0x80)) {
      throw new CanonicalBinaryError(
        "invalid-integer",
        "varint exceeds the maximum safe integer",
      );
    }
    factor *= 0x80;
  }

  throw new CanonicalBinaryError("truncated", "truncated varint");
}

export class CanonicalWriter {
  readonly #parts: Uint8Array[] = [];
  #byteLength = 0;

  writeByte(value: number): this {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      throw new CanonicalBinaryError(
        "invalid-integer",
        "byte value must be an integer between 0 and 255",
      );
    }
    return this.writeBytes(Uint8Array.of(value));
  }

  writeVarint(value: number): this {
    return this.writeBytes(encodeUnsignedVarint(value));
  }

  writeBytes(value: Uint8Array): this {
    if (value.byteLength > Number.MAX_SAFE_INTEGER - this.#byteLength) {
      throw new CanonicalBinaryError(
        "limit-exceeded",
        "canonical output exceeds the maximum safe length",
      );
    }
    const owned = Uint8Array.from(value);
    this.#parts.push(owned);
    this.#byteLength += owned.byteLength;
    return this;
  }

  writeLengthPrefixedBytes(value: Uint8Array): this {
    return this.writeVarint(value.byteLength).writeBytes(value);
  }

  finish(): Uint8Array {
    const output = new Uint8Array(this.#byteLength);
    let offset = 0;
    for (const part of this.#parts) {
      output.set(part, offset);
      offset += part.byteLength;
    }
    return output;
  }
}

export class CanonicalReader {
  readonly #input: Uint8Array;
  #offset = 0;

  constructor(input: Uint8Array) {
    this.#input = input;
  }

  get offset(): number {
    return this.#offset;
  }

  get remaining(): number {
    return this.#input.byteLength - this.#offset;
  }

  readByte(label = "byte"): number {
    if (this.remaining < 1) {
      throw new CanonicalBinaryError("truncated", `missing ${label}`);
    }
    const value = this.#input[this.#offset];
    if (value === undefined) {
      throw new CanonicalBinaryError("truncated", `missing ${label}`);
    }
    this.#offset += 1;
    return value;
  }

  readVarint(label = "varint"): number {
    try {
      const decoded = decodeUnsignedVarint(this.#input, this.#offset);
      this.#offset = decoded.nextOffset;
      return decoded.value;
    } catch (error) {
      if (error instanceof CanonicalBinaryError) {
        throw new CanonicalBinaryError(
          error.code,
          `${label}: ${error.message}`,
        );
      }
      throw error;
    }
  }

  readBytes(length: number, label = "bytes"): Uint8Array {
    assertSafeUnsignedInteger(length, `${label} length`);
    if (length > this.remaining) {
      throw new CanonicalBinaryError("truncated", `truncated ${label}`);
    }
    const start = this.#offset;
    this.#offset += length;
    return Uint8Array.from(this.#input.subarray(start, this.#offset));
  }

  readLengthPrefixedBytes(maxLength: number, label = "bytes"): Uint8Array {
    assertSafeUnsignedInteger(maxLength, `${label} maximum length`);
    const length = this.readVarint(`${label} length`);
    if (length > maxLength) {
      throw new CanonicalBinaryError(
        "limit-exceeded",
        `${label} length ${length} exceeds the ${maxLength}-byte limit`,
      );
    }
    return this.readBytes(length, label);
  }

  expectBytes(expected: Uint8Array, label = "value"): void {
    const observed = this.readBytes(expected.byteLength, label);
    for (let index = 0; index < expected.byteLength; index += 1) {
      if (observed[index] !== expected[index]) {
        throw new CanonicalBinaryError(
          "unexpected-value",
          `${label} does not match the expected value`,
        );
      }
    }
  }

  assertEnd(): void {
    if (this.remaining !== 0) {
      throw new CanonicalBinaryError(
        "trailing-data",
        `canonical input has ${this.remaining} trailing byte${this.remaining === 1 ? "" : "s"}`,
      );
    }
  }
}
