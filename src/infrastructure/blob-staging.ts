import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { mkdtemp, open, realpath, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

/**
 * Operation-local, already-authenticated blob bytes. The private staging
 * directory bounds memory use while allowing every distinct object-store
 * blob to be read and hashed exactly once before workspace mutation begins.
 */
export interface StagedBlobs {
  readBlob(oid: string): Promise<Uint8Array>;
  readonly streamBlob?: (
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
    if (
      streamed.decodedLength !== byteLength ||
      (CONTENT_ID.test(oid) && digest !== oid)
    ) {
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

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!isAbsolute(pathFromRoot) &&
      pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`))
  );
}

async function streamStagedFile(
  path: string,
  oid: string,
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
    const hash = createHash("sha256");
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
      hash.update(chunk);
      await sink(chunk);
    }
    const after = await handle.stat();
    const digest = hash.digest("hex");
    if (
      !sameObservation(before, after) ||
      decodedLength !== expected.size ||
      (CONTENT_ID.test(oid) && digest !== oid)
    ) {
      throw new Error("staged blob changed while it was being read");
    }
    return { decodedLength };
  } finally {
    await handle.close();
  }
}

async function readStagedFile(
  path: string,
  oid: string,
  expected: Stats,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const { decodedLength } = await streamStagedFile(
    path,
    oid,
    expected,
    async (chunk) => {
      chunks.push(Buffer.from(chunk));
    },
  );
  return Buffer.concat(chunks, decodedLength);
}

/**
 * Authenticate and spool each distinct oid before apply. `readBlob` is the
 * object-store trust boundary: its contract requires a digest-checked result.
 * Staging is deliberately sequential so peak memory is one blob, not the
 * whole changed closure (snapshots may be as large as 2 GiB).
 */
export async function stageBlobs(
  oids: readonly string[],
  readBlob: (oid: string) => Promise<Uint8Array>,
  options: {
    /** Canonicalized before any staging directory is created. */
    readonly workspaceRoot: string;
    /** Other controlled roots (for example the object store) to exclude. */
    readonly forbiddenRoots?: readonly string[];
    /** Test/embedding override; defaults to the process temporary directory. */
    readonly stagingParent?: string;
  },
): Promise<StagedBlobs> {
  return stageBlobStreams(
    oids,
    async (oid, sink) => {
      const content = await readBlob(oid);
      await sink(content);
      return { decodedLength: content.byteLength };
    },
    options,
  );
}

/** Stream authenticated logical content into private restore staging files. */
export async function stageBlobStreams(
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
  if (unique.length === 0) {
    return {
      readBlob: async (oid) => {
        throw new Error(`blob ${oid} was not prepared for this apply`);
      },
      streamBlob: async (oid) => {
        throw new Error(`blob ${oid} was not prepared for this apply`);
      },
      dispose: async () => {},
    };
  }

  // TMPDIR is process-controlled and may itself point into the managed
  // workspace. Resolve and reject that topology before mkdir: preparation
  // must not mutate the workspace it promises to leave untouched on failure.
  let root: string;
  try {
    const [controlledRoots, stagingParent] = await Promise.all([
      Promise.all(
        [options.workspaceRoot, ...(options.forbiddenRoots ?? [])].map((path) =>
          realpath(path),
        ),
      ),
      realpath(options.stagingParent ?? tmpdir()),
    ]);
    if (controlledRoots.some((path) => isWithin(path, stagingParent))) {
      throw new Error(
        `restore staging directory must be outside managed roots: ${stagingParent}`,
      );
    }
    root = await mkdtemp(join(stagingParent, "cyclotomy-restore-blobs-"));
  } catch (error) {
    throw new BlobStagingError(
      `cannot prepare private restore staging: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error,
    );
  }
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
      await rm(root, { recursive: true, force: true });
    } catch (cleanup) {
      throw new BlobStagingCleanupError(error, cleanup);
    }
    throw error;
  }

  return {
    readBlob: async (oid) => {
      if (disposed) {
        throw new Error("prepared blobs have already been disposed");
      }
      const prepared = staged.get(oid);
      if (prepared === undefined) {
        throw new Error(`blob ${oid} was not prepared for this apply`);
      }
      return readStagedFile(prepared.path, oid, prepared.observation);
    },
    streamBlob: async (oid, sink) => {
      if (disposed) {
        throw new Error("prepared blobs have already been disposed");
      }
      const prepared = staged.get(oid);
      if (prepared === undefined) {
        throw new Error(`blob ${oid} was not prepared for this apply`);
      }
      return streamStagedFile(prepared.path, oid, prepared.observation, sink);
    },
    dispose: async () => {
      if (disposed) {
        return;
      }
      disposed = true;
      await rm(root, { recursive: true, force: true });
    },
  };
}
