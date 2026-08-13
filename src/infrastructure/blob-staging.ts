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
  dispose(): Promise<void>;
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

async function writeStagedFile(
  path: string,
  content: Uint8Array,
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
    await handle.writeFile(content);
    const observation = await handle.stat();
    if (!observation.isFile() || observation.nlink !== 1) {
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

async function readStagedFile(path: string, expected: Stats): Promise<Buffer> {
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
    const content = await handle.readFile();
    const after = await handle.stat();
    if (!sameObservation(before, after)) {
      throw new Error("staged blob changed while it was being read");
    }
    return content;
  } finally {
    await handle.close();
  }
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
  const unique = [...new Set(oids)];
  if (unique.length === 0) {
    return {
      readBlob: async (oid) => {
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
      const content = await readBlob(oid);
      const path = join(root, String(index));
      let observation: Stats;
      try {
        observation = await writeStagedFile(path, content);
      } catch (error) {
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
      return readStagedFile(prepared.path, prepared.observation);
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
