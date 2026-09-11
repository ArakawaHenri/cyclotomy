import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type BigIntStats,
} from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import { systemErrorCode } from "./system-error.ts";

/** Fixed lock path shared by both protocols; new code never deletes it. */
export const WORKSPACE_LOCK_FILE = "workspace.lock";
export const LOCK_PROTOCOL_MARKER_FILE = "lock-protocol.json";

const LOCK_PROTOCOL_FORMAT = 1;
const LOCK_PROTOCOL_NATIVE_FILE_V1 = "native-file-v1";
const MARKER_MAX_BYTES = 4 * 1024;
const MARKER_BYTES = Buffer.from(
  `${JSON.stringify({
    format: LOCK_PROTOCOL_FORMAT,
    protocol: LOCK_PROTOCOL_NATIVE_FILE_V1,
  })}\n`,
  "utf8",
);

export interface NativeLockProtocolMarker {
  readonly kind: "native-file-v1";
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly mode: bigint;
  readonly links: bigint;
  readonly size: bigint;
  readonly bytes: Buffer;
}

/**
 * A readable marker is either absent, valid, or an unsupported protocol.
 * Corruption is never an observation: it throws `LockProtocolCorruptError`.
 */
export type LockProtocolMarkerObservation =
  | { readonly kind: "absent" }
  | NativeLockProtocolMarker
  | {
      readonly kind: "unsupported";
      readonly observedFormat: unknown;
      readonly observedProtocol: unknown;
    };

export class UnsupportedLockProtocolError extends Error {
  readonly storeRoot: string;
  readonly observedFormat: unknown;
  readonly observedProtocol: unknown;

  constructor(
    storeRoot: string,
    observedFormat: unknown,
    observedProtocol: unknown,
  ) {
    super(`unsupported Cyclotomy lock protocol at ${storeRoot}`);
    this.name = "UnsupportedLockProtocolError";
    this.storeRoot = storeRoot;
    this.observedFormat = observedFormat;
    this.observedProtocol = observedProtocol;
  }
}

export class LockProtocolCorruptError extends Error {
  readonly storeRoot: string;
  readonly detail: string;

  constructor(storeRoot: string, detail: string, options?: ErrorOptions) {
    super(`corrupt Cyclotomy lock protocol marker at ${storeRoot}: ${detail}`, {
      cause: options?.cause,
    });
    this.name = "LockProtocolCorruptError";
    this.storeRoot = storeRoot;
    this.detail = detail;
  }
}

/** Exact canonical bytes published as a completed protocol switch marker. */
export function nativeLockProtocolMarkerBytes(): Buffer {
  return Buffer.from(MARKER_BYTES);
}

export function lockProtocolMarkerPath(storeRoot: string): string {
  return join(storeRoot, LOCK_PROTOCOL_MARKER_FILE);
}

function corrupt(
  storeRoot: string,
  detail: string,
  cause?: unknown,
): LockProtocolCorruptError {
  return new LockProtocolCorruptError(
    storeRoot,
    detail,
    cause === undefined ? undefined : { cause },
  );
}

function observationFrom(
  storeRoot: string,
  path: string,
  entry: BigIntStats,
  bytes: Buffer,
): LockProtocolMarkerObservation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch (cause) {
    throw corrupt(storeRoot, "marker is not valid UTF-8 JSON", cause);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw corrupt(storeRoot, "marker is not a JSON object");
  }
  const observedFormat: unknown = Reflect.get(parsed, "format");
  const observedProtocol: unknown = Reflect.get(parsed, "protocol");
  if (
    observedFormat !== LOCK_PROTOCOL_FORMAT ||
    observedProtocol !== LOCK_PROTOCOL_NATIVE_FILE_V1
  ) {
    return { kind: "unsupported", observedFormat, observedProtocol };
  }
  return {
    kind: "native-file-v1",
    path,
    device: entry.dev,
    inode: entry.ino,
    mode: entry.mode,
    links: entry.nlink,
    size: entry.size,
    bytes,
  };
}

function readMarkerBytes(
  storeRoot: string,
  path: string,
): { readonly entry: BigIntStats; readonly bytes: Buffer } {
  const observed = lstatSync(path, { bigint: true });
  if (
    observed.isSymbolicLink() ||
    !observed.isFile() ||
    observed.nlink !== 1n
  ) {
    throw corrupt(storeRoot, "marker is not a single-link regular file");
  }
  if (observed.size > BigInt(MARKER_MAX_BYTES)) {
    throw corrupt(storeRoot, "marker exceeds its size limit");
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      opened.dev !== observed.dev ||
      opened.ino !== observed.ino ||
      opened.mode !== observed.mode ||
      opened.size !== observed.size
    ) {
      throw corrupt(storeRoot, "marker changed while it was opened");
    }
    const size = Number(opened.size);
    const buffer = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const bytesRead = readSync(
        descriptor,
        buffer,
        offset,
        size - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const probe = Buffer.allocUnsafe(1);
    const extraBytes = readSync(descriptor, probe, 0, 1, size);
    const after = fstatSync(descriptor, { bigint: true });
    if (
      extraBytes !== 0 ||
      offset !== size ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs
    ) {
      throw corrupt(storeRoot, "marker changed while it was read");
    }
    return { entry: opened, bytes: buffer };
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the marker observation or primary failure.
      }
    }
  }
}

/**
 * Read and authenticate the durable protocol marker. The file is small and
 * bounded, so the synchronous implementation is usable on the pre-mutation
 * authority-assertion path as well as by read-only diagnostics.
 */
export function readLockProtocolMarkerSync(
  storeRoot: string,
): LockProtocolMarkerObservation {
  const path = lockProtocolMarkerPath(storeRoot);
  try {
    lstatSync(path, { bigint: true });
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT") return { kind: "absent" };
    throw corrupt(storeRoot, "marker cannot be inspected", error);
  }
  try {
    const { entry, bytes } = readMarkerBytes(storeRoot, path);
    return observationFrom(storeRoot, path, entry, bytes);
  } catch (error) {
    if (error instanceof LockProtocolCorruptError) throw error;
    throw corrupt(storeRoot, "marker cannot be read", error);
  }
}

export function lockProtocolMarkerMatches(
  expected: NativeLockProtocolMarker,
  current: LockProtocolMarkerObservation,
): boolean {
  return (
    current.kind === "native-file-v1" &&
    current.device === expected.device &&
    current.inode === expected.inode &&
    current.mode === expected.mode &&
    current.links === expected.links &&
    current.size === expected.size &&
    current.bytes.equals(expected.bytes)
  );
}

/**
 * Atomically publish the completed native protocol marker. Callers must hold
 * the exclusive native lock and have verified the fixed lock path identity; the
 * marker records a switch that already happened and never substitutes for that
 * lock. Existing valid markers make this idempotent.
 */
export async function publishLockProtocolMarker(
  storeRoot: string,
): Promise<NativeLockProtocolMarker> {
  const existing = readLockProtocolMarkerSync(storeRoot);
  if (existing.kind === "native-file-v1") return existing;
  if (existing.kind === "unsupported") {
    throw new UnsupportedLockProtocolError(
      storeRoot,
      existing.observedFormat,
      existing.observedProtocol,
    );
  }

  const target = lockProtocolMarkerPath(storeRoot);
  const temporary = join(
    storeRoot,
    `.${LOCK_PROTOCOL_MARKER_FILE}.tmp-${randomUUID()}`,
  );
  let published = false;
  try {
    const handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      await handle.writeFile(MARKER_BYTES);
      await handle.sync();
    } finally {
      await handle.close().catch(() => {});
    }
    // Concurrent publishers write identical bytes, so a rename race is safe.
    await rename(temporary, target);
    published = true;
  } finally {
    if (!published) {
      await unlink(temporary).catch(() => {});
    }
  }
  await syncDirectory(storeRoot);
  const observation = readLockProtocolMarkerSync(storeRoot);
  if (observation.kind !== "native-file-v1") {
    throw corrupt(storeRoot, "marker was not durable after publication");
  }
  return observation;
}

async function syncDirectory(path: string): Promise<void> {
  // Windows cannot open a directory for fsync through Node's fs API; the
  // rename itself is still ordered by the platform's metadata journal.
  if (process.platform === "win32") return;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } catch {
    // Directory sync is a durability preference, not a protocol condition.
  } finally {
    await handle?.close().catch(() => {});
  }
}
