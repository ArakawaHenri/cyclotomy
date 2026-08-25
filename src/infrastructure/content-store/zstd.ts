import {
  constants,
  zstdCompress,
  zstdDecompress,
  type ZstdOptions,
} from "node:zlib";

export const ZSTD_V1_COMPRESSION_LEVEL = 3;
export const ZSTD_V1_WINDOW_LOG = 18;

export type ZstdCodecErrorCode =
  | "decode-failed"
  | "decoded-length-mismatch"
  | "encode-failed"
  | "invalid-length"
  | "trailing-data";

export class ZstdCodecError extends Error {
  readonly code: ZstdCodecErrorCode;

  constructor(code: ZstdCodecErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ZstdCodecError";
    this.code = code;
  }
}

interface ZstdEngineInfo {
  readonly bytesWritten: number;
}

interface ZstdInfoResult {
  readonly buffer: Buffer;
  readonly engine: ZstdEngineInfo;
}

interface ZstdEncoderOptions extends ZstdOptions {
  /** Documented by Node but absent from @types/node's experimental surface. */
  readonly pledgedSrcSize: number;
}

type ZstdDecompressWithInfo = (
  input: Uint8Array,
  options: ZstdOptions & { readonly info: true },
  callback: (error: Error | null, result: ZstdInfoResult) => void,
) => void;

/**
 * Mirrors zstd's one-shot worst-case compression bound and leaves one output
 * byte spare. Some node:zlib implementations can otherwise continue after a
 * full output slab and append an empty frame.
 */
function oneShotOutputChunkSize(inputLength: number): number {
  const smallInputMargin =
    inputLength < 128 * 1024
      ? Math.floor((128 * 1024 - inputLength) / 2048)
      : 0;
  return inputLength + Math.floor(inputLength / 256) + smallInputMargin + 1;
}

function encoderOptions(inputLength: number): ZstdEncoderOptions {
  return {
    chunkSize: oneShotOutputChunkSize(inputLength),
    pledgedSrcSize: inputLength,
    params: {
      [constants.ZSTD_c_compressionLevel]: ZSTD_V1_COMPRESSION_LEVEL,
      [constants.ZSTD_c_checksumFlag]: 1,
      [constants.ZSTD_c_contentSizeFlag]: 1,
      [constants.ZSTD_c_windowLog]: ZSTD_V1_WINDOW_LOG,
    },
  };
}

function decoderOptions(expectedDecodedLength: number): ZstdOptions & {
  readonly info: true;
} {
  return {
    info: true,
    maxOutputLength: Math.max(1, expectedDecodedLength),
    params: {
      [constants.ZSTD_d_windowLogMax]: ZSTD_V1_WINDOW_LOG,
    },
  };
}

function assertExpectedLength(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ZstdCodecError(
      "invalid-length",
      "expected decoded length must be a non-negative safe integer",
    );
  }
}

/** Encode one independent standard zstd frame using the repository v1 profile. */
export async function encodeZstdV1(input: Uint8Array): Promise<Uint8Array> {
  return await encodeOwnedZstdV1(Buffer.from(input));
}

/**
 * Ownership-transfer variant for bounded publication lanes. The caller must
 * not mutate `input` until the returned promise settles.
 */
export async function encodeOwnedZstdV1(
  input: Uint8Array,
): Promise<Uint8Array> {
  return await new Promise<Uint8Array>((resolve, reject) => {
    zstdCompress(input, encoderOptions(input.byteLength), (error, result) => {
      if (error !== null) {
        reject(
          new ZstdCodecError("encode-failed", "zstd-v1 encoding failed", error),
        );
        return;
      }
      resolve(result);
    });
  });
}

/**
 * Decode exactly one complete frame. Node reports the compressed byte count
 * consumed by the engine; comparing it with the owned input rejects both
 * ignored suffixes and concatenated frames.
 */
export async function decodeZstdV1(
  encoded: Uint8Array,
  expectedDecodedLength: number,
): Promise<Uint8Array> {
  assertExpectedLength(expectedDecodedLength);
  const ownedInput = Buffer.from(encoded);
  const decompressWithInfo =
    zstdDecompress as unknown as ZstdDecompressWithInfo;
  const result = await new Promise<ZstdInfoResult>((resolve, reject) => {
    decompressWithInfo(
      ownedInput,
      decoderOptions(expectedDecodedLength),
      (error, decoded) => {
        if (error !== null) {
          reject(
            new ZstdCodecError(
              "decode-failed",
              "zstd-v1 decoding failed",
              error,
            ),
          );
          return;
        }
        resolve(decoded);
      },
    );
  });

  if (
    !Number.isSafeInteger(result.engine.bytesWritten) ||
    result.engine.bytesWritten !== ownedInput.byteLength
  ) {
    throw new ZstdCodecError(
      "trailing-data",
      `zstd-v1 frame consumed ${String(result.engine.bytesWritten)} of ${ownedInput.byteLength} encoded bytes`,
    );
  }
  if (result.buffer.byteLength !== expectedDecodedLength) {
    throw new ZstdCodecError(
      "decoded-length-mismatch",
      `zstd-v1 decoded ${result.buffer.byteLength} bytes; expected ${expectedDecodedLength}`,
    );
  }
  return result.buffer;
}
