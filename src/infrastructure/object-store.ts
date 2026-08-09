import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, parse as parsePath, resolve } from "node:path";

import { isTreeOid } from "../domain/model.ts";
import type { WorkspaceScope } from "./workspace-scope.ts";
import { openWorkspaceRegularCandidate } from "./workspace-file-open.ts";
import {
  ABSOLUTE_MAX_TREE_MANIFEST_BYTES,
  ABSOLUTE_TREE_MANIFEST_LIMITS,
  assertTreeManifestLimits,
  canonicalizeTreeManifest,
  DEFAULT_TREE_MANIFEST_LIMITS,
  encodeTreeManifest,
  migrateTreeManifestToCurrent,
  parseCanonicalTreeManifest,
  PUBLISHED_TREE_MANIFEST_FORMAT,
  TreeManifestError,
  type TreeEntry,
  type TreeManifest,
  type TreeManifestLimits,
} from "./tree-manifest.ts";

export {
  PUBLISHED_TREE_MANIFEST_FORMAT,
  TREE_MANIFEST_FORMAT,
  type FileRecreationMode,
  type SymlinkKind,
  type TreeEntry,
  type TreeManifest,
  type TreeManifestLimits,
} from "./tree-manifest.ts";

export type ObjectStoreErrorCode =
  | "invalid-root"
  | "invalid-blob"
  | "invalid-object-id"
  | "invalid-tree-manifest"
  | "legacy-incompatible"
  | "missing-object"
  | "object-integrity"
  | "storage-failure";

export class ObjectStoreError extends Error {
  readonly code: ObjectStoreErrorCode;

  constructor(code: ObjectStoreErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ObjectStoreError";
    this.code = code;
  }
}

/**
 * One coherent snapshot-publication session. A native store can use this
 * boundary to remember which blobs it authenticated while publishing this
 * exact snapshot, avoiding an immediate second closure hash at tree publish.
 */
export interface SnapshotPublication {
  /**
   * Materialize scanner-observed content when it is missing. Existing matching
   * objects are authenticated and reused without reopening the source path;
   * the capture boundary performs a final whole-workspace validation scan.
   */
  publishBlobFromFile(
    sourcePath: string,
    expectedOid: string,
    expectedByteLength: number,
  ): Promise<string>;
  publishTree(
    entries: readonly TreeEntry[],
    scope: WorkspaceScope,
  ): Promise<string>;
}

export interface ObjectStore {
  /** Native filesystem-store root, used only to keep scratch state outside. */
  readonly storageRoot: string;
  readBlob(oid: string): Promise<Uint8Array>;
  /**
   * Open a short-lived publication boundary. Callers must publish every blob
   * through the returned object before publishing its tree.
   */
  beginSnapshotPublication(): SnapshotPublication;
  /**
   * Read and authenticate the complete closure: the canonical manifest and
   * every regular-file blob it references.
   */
  readTree(treeOid: string): Promise<TreeManifest>;
  /**
   * Read and authenticate only the tree object itself (digest and canonical
   * manifest), without verifying the blob closure. Suitable for diagnostics
   * such as diff. Anything that will apply content must authenticate every
   * blob it may write (for example by staging readBlob results) before the
   * first workspace mutation.
   */
  readTreeManifest(treeOid: string): Promise<TreeManifest>;
  /**
   * Publish the deterministic v2 equivalent of one authenticated v1 tree.
   * The caller owns metadata reference replacement and the workspace lock.
   */
  migrateLegacyTree(treeOid: string): Promise<TreeMigrationResult>;
  /** Authenticate exactly the supplied blob ids with bounded concurrency. */
  verifyBlobs(blobOids: readonly string[]): Promise<void>;
}

export interface OpenObjectStoreOptions {
  readonly maxEntries?: number;
  readonly maxManifestBytes?: number;
  readonly maxPathBytes?: number;
  readonly maxPathComponents?: number;
}

export type TreeMigrationResult =
  | { readonly kind: "current"; readonly treeOid: string }
  | {
      readonly kind: "migrated";
      readonly oldTreeOid: string;
      readonly treeOid: string;
    }
  | {
      readonly kind: "legacy-incompatible";
      readonly treeOid: string;
      readonly message: string;
    };

type ObjectKind = "blob" | "tree";

const OBJECT_DIRECTORY = "objects";
const BLOB_DIRECTORY = "blobs";
const TREE_DIRECTORY = "trees";

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const { code } = error as { code?: unknown };
  return typeof code === "string" ? code : undefined;
}

function asStoreError(action: string, error: unknown): ObjectStoreError {
  if (error instanceof ObjectStoreError) return error;
  if (error instanceof TreeManifestError) {
    return new ObjectStoreError(error.kind, error.message, error);
  }
  return new ObjectStoreError("storage-failure", `${action} failed`, error);
}

function isReplaceableObjectFailure(error: unknown): boolean {
  return (
    error instanceof ObjectStoreError &&
    (error.code === "missing-object" || error.code === "object-integrity")
  );
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function assertOid(oid: string): void {
  if (!isTreeOid(oid)) {
    throw new ObjectStoreError(
      "invalid-object-id",
      "object id must be a lowercase SHA-256 digest",
    );
  }
}

async function syncDirectory(path: string): Promise<void> {
  // Windows has no portable directory-fsync primitive. Regular object bytes
  // are still flushed before rename; directory-entry durability is best-effort.
  if (process.platform === "win32") return;
  const handle = await open(
    path,
    constants.O_RDONLY |
      (constants.O_DIRECTORY ?? 0) |
      (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory()) {
      throw new ObjectStoreError(
        "storage-failure",
        "controlled object-store path is not a directory",
      );
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new ObjectStoreError(
      "storage-failure",
      "controlled object-store directory was replaced",
    );
  }
}

async function ensureChildDirectory(
  parent: string,
  name: string,
): Promise<string> {
  const path = join(parent, name);
  let created = false;
  try {
    await mkdir(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (errorCode(error) !== "EEXIST") {
      throw error;
    }
  }
  await assertDirectory(path);
  await syncDirectory(path);
  if (created) {
    await syncDirectory(parent);
  }
  return path;
}

class StreamedFileChangedError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "StreamedFileChangedError";
  }
}

type RegularPathRole = "private-object" | "stream-source";

function unsafeRegularPath(role: RegularPathRole, message: string): Error {
  return role === "stream-source"
    ? new StreamedFileChangedError(message)
    : new ObjectStoreError("storage-failure", message);
}

/**
 * Refuse a final-component symlink/reparse point before open(). This first
 * gate matters on Windows, where O_NOFOLLOW is unavailable and opening first
 * would already follow an external target. The opened handle is bound back to
 * this observation separately, closing the lstat-to-open replacement window.
 */
async function observeRegularPathBeforeOpen(
  path: string,
  role: RegularPathRole,
): Promise<Stats> {
  let observation: Stats;
  try {
    observation = await lstat(path);
  } catch (error) {
    if (role === "stream-source") {
      throw new StreamedFileChangedError(
        "source path no longer names the scanned regular file",
        error,
      );
    }
    throw error;
  }
  if (
    observation.isSymbolicLink() ||
    !observation.isFile() ||
    observation.nlink !== 1
  ) {
    throw unsafeRegularPath(
      role,
      role === "stream-source"
        ? "source path no longer names the scanned regular file"
        : "object path does not name a private regular file",
    );
  }
  return observation;
}

async function readRegularFile(
  path: string,
  maxBytes?: number,
): Promise<Buffer> {
  const pathBefore = await observeRegularPathBeforeOpen(path, "private-object");
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      !sameFileObservation(pathBefore, before) ||
      !(await pathStillBindsRegularFile(path, before))
    ) {
      throw new ObjectStoreError(
        "storage-failure",
        "object path does not name a private regular file",
      );
    }
    if (maxBytes !== undefined && before.size > maxBytes) {
      throw new ObjectStoreError(
        "object-integrity",
        `object exceeds the ${maxBytes}-byte read limit`,
      );
    }
    let content: Buffer;
    if (maxBytes === undefined) {
      content = await handle.readFile();
    } else {
      // Allocate only the size authenticated above. A path can grow between
      // stat and read; positional reads plus a one-byte probe detect that
      // without letting FileHandle.readFile() expand an unbounded buffer.
      const allocated = Buffer.allocUnsafe(before.size);
      let offset = 0;
      while (offset < allocated.byteLength) {
        const { bytesRead } = await handle.read(
          allocated,
          offset,
          allocated.byteLength - offset,
          offset,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const probe = Buffer.allocUnsafe(1);
      const { bytesRead: extraBytes } = await handle.read(probe, 0, 1, offset);
      if (extraBytes !== 0) {
        throw new ObjectStoreError(
          "object-integrity",
          "object grew while it was being read",
        );
      }
      content =
        offset === allocated.byteLength
          ? allocated
          : allocated.subarray(0, offset);
    }
    const after = await handle.stat();
    if (
      !sameFileObservation(before, after) ||
      !(await pathStillBindsRegularFile(path, after))
    ) {
      throw new ObjectStoreError(
        "object-integrity",
        "object or its pathname changed while it was being read",
      );
    }
    return content;
  } finally {
    await handle.close();
  }
}

const VERIFICATION_CONCURRENCY = 8;

/**
 * Run an async worker over every item with bounded concurrency, failing fast:
 * the first error is rethrown and remaining lanes stop picking up work.
 */
async function runPool<T>(
  items: readonly T[],
  worker: (item: T) => Promise<void>,
  concurrency: number,
): Promise<void> {
  if (items.length === 0) {
    return;
  }
  let next = 0;
  let failed = false;
  let failure: unknown;
  const lanes = Math.min(concurrency, items.length);
  const runners = Array.from({ length: lanes }, async () => {
    while (!failed) {
      const index = next;
      next += 1;
      if (index >= items.length) {
        return;
      }
      try {
        await worker(items[index] as T);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
        return;
      }
    }
  });
  await Promise.all(runners);
  if (failed) {
    throw failure;
  }
}

function sameFileObservation(before: Stats, after: Stats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mode === after.mode &&
    before.nlink === after.nlink &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

/**
 * Bind an opened regular-file handle back to its pathname. O_NOFOLLOW is not
 * available on Windows, so handle.stat() alone would accept a final-component
 * symlink to an external regular file. The lstat identity check is required on
 * every platform both for that static case and for a rename after open().
 */
async function pathStillBindsRegularFile(
  path: string,
  opened: Stats,
): Promise<boolean> {
  let current: Stats;
  try {
    current = await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
  return (
    !current.isSymbolicLink() &&
    current.isFile() &&
    current.nlink === 1 &&
    sameFileObservation(opened, current)
  );
}

async function streamRegularFile(
  path: string,
  onChunk?: (chunk: Buffer) => Promise<void>,
  pathRole: "private-object" | "stream-source" = "private-object",
): Promise<{
  readonly digest: string;
  readonly byteLength: number;
  readonly observation: Stats;
}> {
  const pathBefore = await observeRegularPathBeforeOpen(path, pathRole);
  const handle =
    pathRole === "stream-source"
      ? await openWorkspaceRegularCandidate(path, constants.O_RDONLY)
      : await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      !sameFileObservation(pathBefore, before) ||
      !(await pathStillBindsRegularFile(path, before))
    ) {
      if (pathRole === "stream-source") {
        throw new StreamedFileChangedError(
          "source path no longer names the scanned regular file",
        );
      }
      throw new ObjectStoreError(
        "storage-failure",
        "path does not name a private regular file",
      );
    }
    const hash = createHash("sha256");
    let byteLength = 0;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      const result = await handle.read(buffer, 0, buffer.byteLength, position);
      if (result.bytesRead === 0) {
        break;
      }
      const chunk = buffer.subarray(0, result.bytesRead);
      byteLength += chunk.byteLength;
      hash.update(chunk);
      await onChunk?.(chunk);
      position += result.bytesRead;
    }
    const after = await handle.stat();
    if (
      !sameFileObservation(before, after) ||
      !(await pathStillBindsRegularFile(path, after))
    ) {
      if (pathRole === "stream-source") {
        throw new StreamedFileChangedError(
          "file or its pathname changed while it was being streamed",
        );
      }
      throw new ObjectStoreError(
        "storage-failure",
        "private object path changed while it was being streamed",
      );
    }
    return {
      digest: hash.digest("hex"),
      byteLength,
      observation: after,
    };
  } finally {
    await handle.close();
  }
}

async function observeRegularFile(path: string): Promise<Stats> {
  const pathBefore = await observeRegularPathBeforeOpen(path, "private-object");
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const observation = await handle.stat();
    if (
      !observation.isFile() ||
      observation.nlink !== 1 ||
      !sameFileObservation(pathBefore, observation) ||
      !(await pathStillBindsRegularFile(path, observation))
    ) {
      throw new ObjectStoreError(
        "storage-failure",
        "object path does not name a private regular file",
      );
    }
    return observation;
  } finally {
    await handle.close();
  }
}

async function syncRegularFile(path: string): Promise<void> {
  const pathBefore = await observeRegularPathBeforeOpen(path, "private-object");
  const handle = await open(
    path,
    // FlushFileBuffers requires a write-capable handle on Windows. The object
    // remains immutable: this handle is used only for identity checks and
    // sync(), never for writes.
    (process.platform === "win32" ? constants.O_RDWR : constants.O_RDONLY) |
      (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      !sameFileObservation(pathBefore, before) ||
      !(await pathStillBindsRegularFile(path, before))
    ) {
      throw new ObjectStoreError(
        "storage-failure",
        "object path does not name a private regular file",
      );
    }
    await handle.sync();
    const after = await handle.stat();
    if (
      !sameFileObservation(before, after) ||
      !(await pathStillBindsRegularFile(path, after))
    ) {
      throw new ObjectStoreError(
        "storage-failure",
        "object or its pathname changed while it was being flushed",
      );
    }
  } finally {
    await handle.close();
  }
}

class FileObjectStore implements ObjectStore {
  readonly storageRoot: string;
  readonly #root: string;
  readonly #blobRoot: string;
  readonly #treeRoot: string;
  readonly #manifestLimits: TreeManifestLimits;

  constructor(
    root: string,
    blobRoot: string,
    treeRoot: string,
    manifestLimits: TreeManifestLimits,
  ) {
    this.storageRoot = root;
    this.#root = root;
    this.#blobRoot = blobRoot;
    this.#treeRoot = treeRoot;
    this.#manifestLimits = manifestLimits;
  }

  async #publishBlobFile(
    sourcePath: string,
    expectedOid: string,
    expectedByteLength: number,
  ): Promise<{ readonly oid: string; readonly observation: Stats }> {
    assertOid(expectedOid);
    if (
      !isAbsolute(sourcePath) ||
      !Number.isSafeInteger(expectedByteLength) ||
      expectedByteLength < 0
    ) {
      throw new ObjectStoreError(
        "invalid-blob",
        "streamed blob source must be absolute with a valid expected length",
      );
    }
    try {
      const observation = await this.#publishBlobFromFile(
        sourcePath,
        expectedOid,
        expectedByteLength,
      );
      return { oid: expectedOid, observation };
    } catch (error) {
      if (error instanceof StreamedFileChangedError) {
        throw new ObjectStoreError(
          "invalid-blob",
          "source file changed during streamed publication",
          error,
        );
      }
      throw asStoreError("streamed blob publication", error);
    }
  }

  async readBlob(oid: string): Promise<Uint8Array> {
    assertOid(oid);
    try {
      return await this.#readObject("blob", oid);
    } catch (error) {
      throw asStoreError("blob read", error);
    }
  }

  beginSnapshotPublication(): SnapshotPublication {
    const verified = new Map<string, Stats>();
    let treePublished = false;
    const assertOpen = (): void => {
      if (treePublished) {
        throw new ObjectStoreError(
          "storage-failure",
          "snapshot publication already published its tree",
        );
      }
    };
    return {
      publishBlobFromFile: async (
        sourcePath,
        expectedOid,
        expectedByteLength,
      ) => {
        assertOpen();
        const { oid, observation } = await this.#publishBlobFile(
          sourcePath,
          expectedOid,
          expectedByteLength,
        );
        verified.set(oid, observation);
        return oid;
      },
      publishTree: async (entries, scope) => {
        assertOpen();
        const prepared = this.#prepareTree(entries, scope);
        const checked = new Set<string>();
        for (const entry of prepared.entries) {
          if (entry.type !== "regular") {
            continue;
          }
          const proof = verified.get(entry.blobOid);
          if (proof === undefined) {
            throw new ObjectStoreError(
              "invalid-tree-manifest",
              `snapshot tree references a blob not authenticated by this publication: ${entry.blobOid}`,
            );
          }
          if (!checked.has(entry.blobOid)) {
            checked.add(entry.blobOid);
            await this.#assertStillVerified("blob", entry.blobOid, proof);
          }
        }
        treePublished = true;
        return this.#publishPreparedTree(prepared.entries, prepared.scope);
      },
    };
  }

  async #publishPreparedTree(
    entries: readonly TreeEntry[],
    scope: WorkspaceScope,
    limits: TreeManifestLimits = this.#manifestLimits,
  ): Promise<string> {
    try {
      const encoded = encodeTreeManifest(entries, scope, limits);
      const oid = sha256(encoded);
      await this.#publishObject("tree", oid, encoded);
      return oid;
    } catch (error) {
      throw asStoreError("tree publication", error);
    }
  }

  #prepareTree(
    entries: readonly TreeEntry[],
    scope: WorkspaceScope,
  ): {
    readonly entries: readonly TreeEntry[];
    readonly scope: WorkspaceScope;
  } {
    try {
      return canonicalizeTreeManifest(entries, scope, this.#manifestLimits);
    } catch (error) {
      if (error instanceof TreeManifestError) {
        throw new ObjectStoreError(
          "invalid-tree-manifest",
          error.message,
          error,
        );
      }
      throw error;
    }
  }

  async readTree(treeOid: string): Promise<TreeManifest> {
    assertOid(treeOid);
    try {
      const manifest = await this.readTreeManifest(treeOid);
      await this.#verifyClosure(manifest.entries);
      return manifest;
    } catch (error) {
      throw asStoreError("tree read", error);
    }
  }

  async readTreeManifest(treeOid: string): Promise<TreeManifest> {
    assertOid(treeOid);
    try {
      const encoded = await this.#readObject("tree", treeOid);
      return parseCanonicalTreeManifest(encoded);
    } catch (error) {
      throw asStoreError("tree read", error);
    }
  }

  async migrateLegacyTree(treeOid: string): Promise<TreeMigrationResult> {
    assertOid(treeOid);
    try {
      // Authenticate both the historical manifest and its complete blob
      // closure before publishing an object that metadata may later root.
      const legacy = await this.readTree(treeOid);
      if (legacy.format !== PUBLISHED_TREE_MANIFEST_FORMAT) {
        return { kind: "current", treeOid };
      }

      let current: ReturnType<typeof migrateTreeManifestToCurrent>;
      try {
        current = migrateTreeManifestToCurrent(legacy, {
          maxPathBytes: this.#manifestLimits.maxPathBytes,
          maxPathComponents: this.#manifestLimits.maxPathComponents,
        });
      } catch (error) {
        if (
          error instanceof TreeManifestError &&
          error.kind === "legacy-incompatible"
        ) {
          return {
            kind: "legacy-incompatible",
            treeOid,
            message: error.message,
          };
        }
        throw error;
      }

      // Migration is a schema conversion, not a new capture. Use the parser's
      // absolute published limits so a user's subsequently lowered capture
      // quota cannot strand an otherwise compatible historical checkpoint.
      const migratedOid = await this.#publishPreparedTree(
        current.entries,
        current.scope,
        ABSOLUTE_TREE_MANIFEST_LIMITS,
      );
      const verified = await this.readTree(migratedOid);
      if (verified.format === PUBLISHED_TREE_MANIFEST_FORMAT) {
        throw new ObjectStoreError(
          "object-integrity",
          "tree migration published a legacy-format object",
        );
      }
      return {
        kind: "migrated",
        oldTreeOid: treeOid,
        treeOid: migratedOid,
      };
    } catch (error) {
      throw asStoreError("tree migration", error);
    }
  }

  async verifyBlobs(blobOids: readonly string[]): Promise<void> {
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const oid of blobOids) {
      assertOid(oid);
      if (!seen.has(oid)) {
        seen.add(oid);
        unique.push(oid);
      }
    }
    try {
      await runPool(
        unique,
        async (oid) => {
          await this.#verifyObject("blob", oid);
        },
        VERIFICATION_CONCURRENCY,
      );
    } catch (error) {
      throw asStoreError("blob verification", error);
    }
  }

  /** Authenticate every distinct blob referenced by the entries. */
  async #verifyClosure(entries: readonly TreeEntry[]): Promise<void> {
    const seen = new Set<string>();
    const oids: string[] = [];
    for (const entry of entries) {
      if (entry.type === "regular" && !seen.has(entry.blobOid)) {
        seen.add(entry.blobOid);
        oids.push(entry.blobOid);
      }
    }
    await this.verifyBlobs(oids);
  }

  async #objectPath(
    kind: ObjectKind,
    oid: string,
    createShard: boolean,
  ): Promise<string> {
    assertOid(oid);
    await assertDirectory(this.#root);
    const namespace = kind === "blob" ? this.#blobRoot : this.#treeRoot;
    await assertDirectory(namespace);
    const shardName = oid.slice(0, 2);
    const shard = createShard
      ? await ensureChildDirectory(namespace, shardName)
      : join(namespace, shardName);
    if (!createShard) {
      try {
        await assertDirectory(shard);
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          throw new ObjectStoreError(
            "missing-object",
            `${kind} object does not exist`,
            error,
          );
        }
        throw error;
      }
    }
    return join(shard, oid.slice(2));
  }

  async #observeObject(kind: ObjectKind, oid: string): Promise<Stats> {
    const path = await this.#objectPath(kind, oid, false);
    try {
      return await observeRegularFile(path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        throw new ObjectStoreError(
          "missing-object",
          `${kind} object does not exist`,
          error,
        );
      }
      throw error;
    }
  }

  async #assertStillVerified(
    kind: ObjectKind,
    oid: string,
    expected: Stats,
  ): Promise<void> {
    const current = await this.#observeObject(kind, oid);
    if (sameFileObservation(expected, current)) {
      return;
    }
    // Metadata changed after the proof was made. Re-hash rather than trusting
    // stat identity; this accepts a benign atomic rewrite only when its bytes
    // still match the content-addressed id.
    await this.#verifyObject(kind, oid);
  }

  async #readObject(kind: ObjectKind, oid: string): Promise<Buffer> {
    const path = await this.#objectPath(kind, oid, false);
    let content: Buffer;
    try {
      content = await readRegularFile(
        path,
        kind === "tree" ? ABSOLUTE_MAX_TREE_MANIFEST_BYTES : undefined,
      );
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        throw new ObjectStoreError(
          "missing-object",
          `${kind} object does not exist`,
          error,
        );
      }
      throw error;
    }
    if (sha256(content) !== oid) {
      throw new ObjectStoreError(
        "object-integrity",
        `${kind} object digest does not match its id`,
      );
    }
    return content;
  }

  async #verifyObject(kind: ObjectKind, oid: string): Promise<Stats> {
    const path = await this.#objectPath(kind, oid, false);
    let observed: Awaited<ReturnType<typeof streamRegularFile>>;
    try {
      observed = await streamRegularFile(path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        throw new ObjectStoreError(
          "missing-object",
          `${kind} object does not exist`,
          error,
        );
      }
      if (error instanceof StreamedFileChangedError) {
        throw new ObjectStoreError(
          "object-integrity",
          `${kind} object changed during verification`,
          error,
        );
      }
      throw error;
    }
    if (observed.digest !== oid) {
      throw new ObjectStoreError(
        "object-integrity",
        `${kind} object digest does not match its id`,
      );
    }
    return observed.observation;
  }

  async #publishBlobFromFile(
    sourcePath: string,
    oid: string,
    expectedByteLength: number,
  ): Promise<Stats> {
    const target = await this.#objectPath("blob", oid, true);
    const parent = join(this.#blobRoot, oid.slice(0, 2));

    try {
      const observation = await this.#verifyObject("blob", oid);
      await syncRegularFile(target);
      await syncDirectory(parent);
      return observation;
    } catch (error) {
      if (!isReplaceableObjectFailure(error)) {
        throw error;
      }
    }

    const temporary = join(
      parent,
      `.${oid}.${process.pid}.${randomUUID()}.tmp`,
    );
    let targetHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      targetHandle = await open(
        temporary,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      let copiedBytes = 0;
      const observed = await streamRegularFile(
        sourcePath,
        async (chunk) => {
          if (targetHandle === undefined) {
            throw new Error("temporary blob handle closed unexpectedly");
          }
          copiedBytes += chunk.byteLength;
          if (copiedBytes > expectedByteLength) {
            throw new ObjectStoreError(
              "invalid-blob",
              "source file grew beyond the scanned blob length",
            );
          }
          await targetHandle.writeFile(chunk);
        },
        "stream-source",
      );
      if (
        observed.byteLength !== expectedByteLength ||
        observed.digest !== oid
      ) {
        throw new ObjectStoreError(
          "invalid-blob",
          "source file no longer matches the scanned blob digest and length",
        );
      }
      await targetHandle.sync();
      await targetHandle.close();
      targetHandle = undefined;

      await rename(temporary, target);
      const targetObservation = await this.#verifyObject("blob", oid);
      await syncDirectory(parent);
      return targetObservation;
    } catch (error) {
      if (targetHandle !== undefined) {
        try {
          await targetHandle.close();
        } catch {
          // Preserve the publication failure.
        }
      }
      try {
        await unlink(temporary);
      } catch (cleanupError) {
        if (errorCode(cleanupError) !== "ENOENT") {
          // Preserve the publication failure; orphan temp files are inert.
        }
      }
      throw error;
    }
  }

  async #publishObject(
    kind: ObjectKind,
    oid: string,
    content: Uint8Array,
  ): Promise<Stats> {
    const target = await this.#objectPath(kind, oid, true);
    const parent =
      kind === "blob"
        ? join(this.#blobRoot, oid.slice(0, 2))
        : join(this.#treeRoot, oid.slice(0, 2));

    try {
      const observation = await this.#verifyObject(kind, oid);
      await syncRegularFile(target);
      await syncDirectory(parent);
      return observation;
    } catch (error) {
      if (!isReplaceableObjectFailure(error)) {
        throw error;
      }
    }

    const temporary = join(
      parent,
      `.${oid}.${process.pid}.${randomUUID()}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        temporary,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      await handle.writeFile(content);
      await handle.sync();
      await handle.close();
      handle = undefined;

      await rename(temporary, target);
      const targetObservation = await this.#verifyObject(kind, oid);
      await syncDirectory(parent);
      return targetObservation;
    } catch (error) {
      if (handle !== undefined) {
        try {
          await handle.close();
        } catch {
          // Preserve the publication failure.
        }
      }
      try {
        await unlink(temporary);
      } catch (cleanupError) {
        if (errorCode(cleanupError) !== "ENOENT") {
          // Preserve the publication failure; orphan temp files are inert.
        }
      }
      throw error;
    }
  }
}

function canonicalStoreRoot(root: string): string {
  if (root.length === 0 || root.includes("\0") || !isAbsolute(root)) {
    throw new ObjectStoreError(
      "invalid-root",
      "object-store root must be an absolute path",
    );
  }
  const canonicalRoot = resolve(root);
  if (canonicalRoot === parsePath(canonicalRoot).root) {
    throw new ObjectStoreError(
      "invalid-root",
      "filesystem root cannot be used as an object store",
    );
  }
  return canonicalRoot;
}

/**
 * Open an explicitly selected object-store root. The root must be absolute and
 * must not be a filesystem root. This initializes only controlled store
 * directories; it never scans a workspace and never removes an object.
 */
export async function openObjectStore(
  root: string,
  options: OpenObjectStoreOptions = {},
): Promise<ObjectStore> {
  const canonicalRoot = canonicalStoreRoot(root);
  const manifestLimits: TreeManifestLimits = {
    maxEntries: options.maxEntries ?? DEFAULT_TREE_MANIFEST_LIMITS.maxEntries,
    maxManifestBytes:
      options.maxManifestBytes ?? DEFAULT_TREE_MANIFEST_LIMITS.maxManifestBytes,
    maxPathBytes:
      options.maxPathBytes ?? DEFAULT_TREE_MANIFEST_LIMITS.maxPathBytes,
    maxPathComponents:
      options.maxPathComponents ??
      DEFAULT_TREE_MANIFEST_LIMITS.maxPathComponents,
  };

  try {
    assertTreeManifestLimits(manifestLimits);
    await mkdir(canonicalRoot, {
      recursive: true,
      mode: 0o700,
    });
    await assertDirectory(canonicalRoot);
    await syncDirectory(canonicalRoot);
    const objects = await ensureChildDirectory(canonicalRoot, OBJECT_DIRECTORY);
    const blobs = await ensureChildDirectory(objects, BLOB_DIRECTORY);
    const trees = await ensureChildDirectory(objects, TREE_DIRECTORY);
    return new FileObjectStore(canonicalRoot, blobs, trees, manifestLimits);
  } catch (error) {
    throw asStoreError("object-store initialization", error);
  }
}
