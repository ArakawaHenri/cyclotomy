export interface FastCdcChunk {
  readonly offset: number;
  readonly length: number;
}

export interface FastCdcStreamChunk extends FastCdcChunk {
  /** Owned bytes, valid independently of subsequent builder operations. */
  readonly bytes: Uint8Array;
}

export type FastCdcStreamSink = (
  chunk: FastCdcStreamChunk,
) => void | Promise<void>;

export interface FastCdcStreamResult {
  readonly chunkCount: number;
  readonly decodedLength: number;
}

const MINIMUM_BYTES = 16 * 1024;
const AVERAGE_BYTES = 64 * 1024;
const MAXIMUM_BYTES = 256 * 1024;
const PRE_AVERAGE_MASK = 0x0003_ffff; // 18 bits: harder before average.
const POST_AVERAGE_MASK = 0x0000_3fff; // 14 bits: easier after average.

/** SHA-256 of the 256 generated uint32 values serialized little-endian. */
const GEAR_TABLE_SHA256 =
  "bee0cf4dc94f60a1f2135be81664737899efa088ea4ca06d8d848c92da00b3b5";

export const FASTCDC_V1_PROFILE = Object.freeze({
  id: "fastcdc-v1",
  minimumBytes: MINIMUM_BYTES,
  averageBytes: AVERAGE_BYTES,
  maximumBytes: MAXIMUM_BYTES,
  normalizationLevel: 2,
  preAverageMask: PRE_AVERAGE_MASK,
  postAverageMask: POST_AVERAGE_MASK,
  gearTableSha256: GEAR_TABLE_SHA256,
} as const);

/**
 * The fixed profile table. The xorshift expansion is part of fastcdc-v1, not a
 * runtime seed or configuration surface; golden vectors pin all boundaries.
 */
function createGearTable(): Uint32Array {
  const table = new Uint32Array(256);
  let state = 0x243f_6a88;
  for (let index = 0; index < 256; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    table[index] = state;
  }
  return table;
}

const GEAR_TABLE = createGearTable();

function nextChunkLength(input: Uint8Array, start: number): number {
  const remaining = input.byteLength - start;
  if (remaining <= MINIMUM_BYTES) {
    return remaining;
  }

  const boundedLength = Math.min(remaining, MAXIMUM_BYTES);
  const normalLength = Math.min(boundedLength, AVERAGE_BYTES);
  let fingerprint = 0;
  let index = start + MINIMUM_BYTES;
  const normalEnd = start + normalLength;
  for (; index < normalEnd; index += 1) {
    // Both indices are bounded by the loop. Keeping the fingerprint in the
    // signed 32-bit lane avoids a floating-point deopt while preserving the
    // exact modulo-2^32 Gear recurrence pinned by the golden vectors.
    fingerprint = ((fingerprint << 1) + GEAR_TABLE[input[index]!]!) | 0;
    if ((fingerprint & PRE_AVERAGE_MASK) === 0) {
      return index - start;
    }
  }

  const boundedEnd = start + boundedLength;
  for (; index < boundedEnd; index += 1) {
    fingerprint = ((fingerprint << 1) + GEAR_TABLE[input[index]!]!) | 0;
    if ((fingerprint & POST_AVERAGE_MASK) === 0) {
      return index - start;
    }
  }
  return boundedLength;
}

/** Pure, fixed-profile FastCDC partitioning over one owned observation. */
export function chunkFastCdcV1(input: Uint8Array): readonly FastCdcChunk[] {
  const chunks: FastCdcChunk[] = [];
  let offset = 0;
  while (offset < input.byteLength) {
    const length = nextChunkLength(input, offset);
    if (length <= 0) {
      throw new RangeError("FastCDC failed to make forward progress");
    }
    chunks.push(Object.freeze({ offset, length }));
    offset += length;
  }
  return Object.freeze(chunks);
}

/**
 * Backpressured streaming builder. It retains at most one maximum-sized chunk;
 * the sink receives owned chunks in order and must settle before input resumes.
 */
export class FastCdcV1StreamBuilder {
  readonly #sink: FastCdcStreamSink;
  readonly #buffer = new Uint8Array(MAXIMUM_BYTES);
  #bufferedBytes = 0;
  #chunkCount = 0;
  #decodedLength = 0;
  #active = false;
  #closed = false;
  #failed = false;

  constructor(sink: FastCdcStreamSink) {
    this.#sink = sink;
  }

  async push(input: Uint8Array): Promise<void> {
    this.#beginOperation("push");
    try {
      let inputOffset = 0;
      while (inputOffset < input.byteLength) {
        const copiedBytes = Math.min(
          input.byteLength - inputOffset,
          MAXIMUM_BYTES - this.#bufferedBytes,
        );
        this.#buffer.set(
          input.subarray(inputOffset, inputOffset + copiedBytes),
          this.#bufferedBytes,
        );
        this.#bufferedBytes += copiedBytes;
        inputOffset += copiedBytes;
        if (this.#bufferedBytes === MAXIMUM_BYTES) {
          await this.#emitOneChunk();
        }
      }
    } catch (error) {
      this.#failed = true;
      throw error;
    } finally {
      this.#active = false;
    }
  }

  async finish(): Promise<FastCdcStreamResult> {
    this.#beginOperation("finish");
    try {
      while (this.#bufferedBytes > 0) {
        await this.#emitOneChunk();
      }
      this.#closed = true;
      return Object.freeze({
        chunkCount: this.#chunkCount,
        decodedLength: this.#decodedLength,
      });
    } catch (error) {
      this.#failed = true;
      throw error;
    } finally {
      this.#active = false;
    }
  }

  #beginOperation(operation: "push" | "finish"): void {
    if (this.#active) {
      throw new Error(
        `cannot ${operation} while another builder call is active`,
      );
    }
    if (this.#closed || this.#failed) {
      throw new Error(`cannot ${operation} after the builder has settled`);
    }
    this.#active = true;
  }

  async #emitOneChunk(): Promise<void> {
    const length = nextChunkLength(
      this.#buffer.subarray(0, this.#bufferedBytes),
      0,
    );
    if (length <= 0 || length > this.#bufferedBytes) {
      throw new RangeError("FastCDC emitted an invalid chunk length");
    }
    const offset = this.#decodedLength;
    const bytes = this.#buffer.slice(0, length);
    this.#buffer.copyWithin(0, length, this.#bufferedBytes);
    this.#bufferedBytes -= length;
    if (length > Number.MAX_SAFE_INTEGER - this.#decodedLength) {
      throw new RangeError(
        "FastCDC stream length exceeds the safe integer limit",
      );
    }
    if (this.#chunkCount === Number.MAX_SAFE_INTEGER) {
      throw new RangeError(
        "FastCDC chunk count exceeds the safe integer limit",
      );
    }
    this.#decodedLength += length;
    this.#chunkCount += 1;
    await this.#sink(Object.freeze({ offset, length, bytes }));
  }
}
