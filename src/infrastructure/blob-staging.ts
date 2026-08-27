import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createPrivateScratchRoot,
  PrivateScratchRootError,
  type PrivateScratchRoot,
} from "./private-scratch-root.ts";

/**
 * Operation-local, already-authenticated blob bytes. The private staging
 * directory bounds memory use while allowing every distinct object-store
 * blob to be read and hashed exactly once before workspace mutation begins.
 */
export interface StagedBlobs {
  readonly streamBlob: (
    oid: string,
    sink: (chunk: Uint8Array) => Promise<void>,
  ) => Promise<{ readonly decodedLength: number }>;
  dispose(): Promise<void>;
}

export type BlobStreamReader = (
  oid: string,
  sink: (chunk: Uint8Array) => Promise<void>,
) => Promise<{ readonly decodedLength: number }>;

const CONTENT_ID = /^[0-9a-f]{64}$/u;

function assertContentId(oid: string): void {
  if (!CONTENT_ID.test(oid)) {
    throw new Error("restore blob id is not a canonical SHA-256 digest");
  }
}

class BlobStreamSourceError extends Error {
  declare readonly cause: unknown;

  constructor(cause: unknown) {
    super("authenticated blob source could not be streamed", { cause });
    this.name = "BlobStreamSourceError";
  }
}

/** A local scratch-space failure, distinct from unreadable checkpoint bytes. */
export class BlobStagingError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BlobStagingError";
  }
}

/** Preserve a staging failure separately from failure to remove partial bytes. */
export class BlobStagingCleanupError extends Error {
  readonly primary: unknown;
  readonly cleanup: unknown;

  constructor(primary: unknown, cleanup: unknown) {
    super("restore staging and cleanup both failed", { cause: primary });
    this.name = "BlobStagingCleanupError";
    this.primary = primary;
    this.cleanup = cleanup;
  }
}

async function writeAll(
  handle: FileHandle,
  content: Uint8Array,
  position: number,
): Promise<void> {
  let offset = 0;
  while (offset < content.byteLength) {
    const { bytesWritten } = await handle.write(
      content,
      offset,
      content.byteLength - offset,
      position + offset,
    );
    if (bytesWritten === 0) {
      throw new Error("zero-byte write while staging a blob");
    }
    offset += bytesWritten;
  }
}

async function writeStagedFile(
  path: string,
  oid: string,
  streamBlob: BlobStreamReader,
): Promise<Stats> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const hash = createHash("sha256");
    let byteLength = 0;
    let localWriteFailure: { readonly cause: unknown } | undefined;
    let streamed: { readonly decodedLength: number };
    try {
      streamed = await streamBlob(oid, async (chunk) => {
        try {
          await writeAll(handle!, chunk, byteLength);
        } catch (cause) {
          localWriteFailure = { cause };
          throw cause;
        }
        hash.update(chunk);
        byteLength += chunk.byteLength;
      });
    } catch (cause) {
      if (localWriteFailure !== undefined) throw localWriteFailure.cause;
      throw new BlobStreamSourceError(cause);
    }
    const digest = hash.digest("hex");
    if (streamed.decodedLength !== byteLength || digest !== oid) {
      throw new BlobStreamSourceError(
        new Error("staged blob bytes do not match their content id"),
      );
    }
    await handle.sync();
    const observation = await handle.stat();
    if (
      !observation.isFile() ||
      observation.nlink !== 1 ||
      observation.size !== byteLength
    ) {
      throw new Error("staged blob is not a private regular file");
    }
    await handle.close();
    handle = undefined;
    return observation;
  } finally {
    if (handle !== undefined) {
      await handle.close().catch(() => {});
    }
  }
}

function sameObservation(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function streamStagedFile(
  path: string,
  expected: Stats,
  sink: (chunk: Uint8Array) => Promise<void>,
): Promise<{ readonly decodedLength: number }> {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      !sameObservation(expected, before)
    ) {
      throw new Error("staged blob is no longer a private regular file");
    }
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let decodedLength = 0;
    while (true) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.byteLength,
        decodedLength,
      );
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      decodedLength += bytesRead;
      if (decodedLength > expected.size) {
        throw new Error("staged blob grew while it was being streamed");
      }
      await sink(chunk);
    }
    const after = await handle.stat();
    if (!sameObservation(before, after) || decodedLength !== expected.size) {
      throw new Error("staged blob changed while it was being read");
    }
    return { decodedLength };
  } finally {
    await handle.close();
  }
}

function stagingCreationDetail(error: unknown): string {
  if (
    error instanceof PrivateScratchRootError &&
    error.code === "parent-forbidden"
  ) {
    return `restore staging directory must be outside managed roots: ${error.path}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function stagingCleanupError(error: unknown): BlobStagingError {
  if (
    error instanceof PrivateScratchRootError &&
    error.code === "cleanup-replaced"
  ) {
    return new BlobStagingError(
      "refusing to clean a replaced private restore staging directory",
      error,
    );
  }
  return new BlobStagingError("cannot clean private restore staging", error);
}

async function disposeStagingRoot(root: PrivateScratchRoot): Promise<void> {
  try {
    await root.dispose();
  } catch (error) {
    throw stagingCleanupError(error);
  }
}

/**
 * Authenticate and spool each distinct blob before apply. Staging is
 * sequential so memory stays bounded while the full changed closure is made
 * available before workspace mutation begins.
 */
export async function stageBlobs(
  oids: readonly string[],
  streamBlob: BlobStreamReader,
  options: {
    /** Canonicalized before any staging directory is created. */
    readonly workspaceRoot: string;
    /** Other controlled roots (for example the object store) to exclude. */
    readonly forbiddenRoots?: readonly string[];
    /** Test/embedding override; defaults to the process temporary directory. */
    readonly stagingParent?: string;
  },
): Promise<StagedBlobs> {
  const unique = [...new Set(oids)];
  for (const oid of unique) assertContentId(oid);
  if (unique.length === 0) {
    return {
      streamBlob: async (oid) => {
        throw new Error(`blob ${oid} was not prepared for this apply`);
      },
      dispose: async () => {},
    };
  }

  // TMPDIR is process-controlled and may itself point into the managed
  // workspace. Authenticate and reject that topology before mkdir:
  // preparation must not mutate the workspace it promises to leave untouched.
  let scratch: PrivateScratchRoot;
  try {
    scratch = await createPrivateScratchRoot({
      parent: options.stagingParent ?? tmpdir(),
      parentPolicy: "exact",
      forbiddenRoots: [
        options.workspaceRoot,
        ...(options.forbiddenRoots ?? []),
      ],
      prefix: "cyclotomy-restore-blobs-",
    });
  } catch (error) {
    throw new BlobStagingError(
      `cannot prepare private restore staging: ${stagingCreationDetail(error)}`,
      error,
    );
  }
  const root = scratch.path;
  const staged = new Map<
    string,
    { readonly path: string; readonly observation: Stats }
  >();
  let disposed = false;
  try {
    for (const [index, oid] of unique.entries()) {
      const path = join(root, String(index));
      let observation: Stats;
      try {
        observation = await writeStagedFile(path, oid, streamBlob);
      } catch (error) {
        if (error instanceof BlobStreamSourceError) throw error.cause;
        throw new BlobStagingError(
          `cannot stage restore blob ${oid}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          error,
        );
      }
      staged.set(oid, { path, observation });
    }
  } catch (error) {
    try {
      await disposeStagingRoot(scratch);
    } catch (cleanup) {
      throw new BlobStagingCleanupError(error, cleanup);
    }
    throw error;
  }

  return {
    streamBlob: async (oid, sink) => {
      if (disposed) {
        throw new Error("prepared blobs have already been disposed");
      }
      const prepared = staged.get(oid);
      if (prepared === undefined) {
        throw new Error(`blob ${oid} was not prepared for this apply`);
      }
      return streamStagedFile(prepared.path, prepared.observation, sink);
    },
    dispose: async () => {
      disposed = true;
      await disposeStagingRoot(scratch);
    },
  };
}
