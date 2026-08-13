import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, parse as parsePath, resolve } from "node:path";

import {
  ABSOLUTE_WORKSPACE_PATH_LIMITS,
  type WorkspaceScope,
} from "./workspace-scope.ts";
import { openWorkspaceRegularCandidate } from "./workspace-file-open.ts";
import {
  isNativeObjectOid,
  nativeObjectLayout,
  nativeObjectNamespacePath,
  nativeObjectPath,
  nativeObjectShardPath,
  nativeTemporaryObjectName,
  type NativeObjectKind,
  type NativeObjectLayout,
} from "./workspace-store.ts";
import {
  ABSOLUTE_MAX_TREE_MANIFEST_BYTES,
  ABSOLUTE_TREE_MANIFEST_LIMITS,
  assertTreeManifestLimits,
  DEFAULT_TREE_MANIFEST_LIMITS,
  TreeManifestError,
  type TreeEntry,
  type TreeManifest,
  type TreeManifestLimits,
} from "./tree-formats/manifest-codec.ts";
import {
  createCurrentTreeManifest,
  encodeCurrentTreeManifest,
  type CurrentTreeManifest,
} from "./tree-formats/current.ts";
import {
  encodeTreeManifest,
  isCurrentTreeManifest,
  parseTreeManifest,
  treeManifestBlobOids,
  upgradeTreeManifest,
} from "./tree-formats/history.ts";

export type ObjectStoreErrorCode =
  | "invalid-root"
  | "invalid-blob"
  | "invalid-object-id"
  | "invalid-tree-manifest"
  | "format-incompatible"
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

class ObjectSizeLimitError extends ObjectStoreError {
  readonly observedBytes: number;
  readonly maxBytes: number;

  constructor(observedBytes: number, maxBytes: number) {
    super(
      "object-integrity",
      `object size ${observedBytes} exceeds the ${maxBytes}-byte limit`,
    );
    this.name = "ObjectSizeLimitError";
    this.observedBytes = observedBytes;
    this.maxBytes = maxBytes;
  }
}

/**
 * Import was deterministically rejected before publication. The target object
 * namespace is guaranteed untouched; operational validator failures are not
 * members of this type and remain retryable by callers.
 */
export class TreeImportAdmissionError extends ObjectStoreError {
  constructor(cause: unknown) {
    const failure = asStoreError("tree import admission", cause);
    super(failure.code, failure.message, failure);
    this.name = "TreeImportAdmissionError";
  }
}

/**
 * An authenticated import source was operationally unavailable during
 * preflight or changed while its closure was being published. The target may
 * contain unreferenced immutable objects, but callers have not yet committed
 * metadata that points to them.
 */
export class TreeImportSourceError extends ObjectStoreError {
  constructor(cause: unknown) {
    const failure = asStoreError("tree import source", cause);
    super(failure.code, failure.message, failure);
    this.name = "TreeImportSourceError";
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
   * Distinct blobs in one publication may be submitted concurrently.
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
  /** Authenticate exactly the supplied blob ids with bounded concurrency. */
  verifyBlobs(blobOids: readonly string[]): Promise<void>;
}

interface NativeObjectAccess {
  readObject(kind: NativeObjectKind, oid: string): Promise<Buffer>;
  verifyObject(
    kind: NativeObjectKind,
    oid: string,
    maxBlobBytes?: number,
  ): Promise<Stats>;
  objectPath(kind: NativeObjectKind, oid: string): Promise<string>;
  assertStillVerified(
    kind: NativeObjectKind,
    oid: string,
    expected: Stats,
    maxBlobBytes?: number,
  ): Promise<void>;
}

declare const NATIVE_OBJECT_STORE: unique symbol;

interface NativeObjectRecord {
  readonly access: NativeObjectAccess;
  readonly layout: NativeObjectLayout;
}

const nativeObjectRecords = new WeakMap<object, NativeObjectRecord>();

/** A store opened over Cyclotomy's authenticated native CAS layout. */
export interface NativeObjectStore extends ObjectStore {
  readonly [NATIVE_OBJECT_STORE]: true;
  /** Publish an authenticated tree in one explicit supported target format. */
  upgradeTree(
    treeOid: string,
    targetFormat: string,
  ): Promise<TreeFormatUpgradeResult>;
  /** Import authenticated closures from another native CAS capability. */
  importTreesFrom(
    source: NativeObjectStore,
    treeOids: readonly string[],
    admission: TreeImportAdmission,
  ): Promise<void>;
}

export interface OpenObjectStoreOptions {
  /** Maximum bytes admitted for one blob. Default 50 MiB. */
  readonly maxFileBytes?: number;
  readonly maxEntries?: number;
  readonly maxManifestBytes?: number;
  readonly maxPathBytes?: number;
  readonly maxPathComponents?: number;
}

export interface TreeImportAdmission {
  readonly validateImportedTree: (
    treeOid: string,
    manifest: CurrentTreeManifest,
  ) => Promise<TreeImportAdmissionDecision>;
  /** Target workspace admission limit including files and symlink targets. */
  readonly maxSnapshotBytes: number;
}

export type TreeImportAdmissionDecision =
  | { readonly kind: "accepted" }
  | { readonly kind: "rejected"; readonly cause: unknown };

export type TreeFormatUpgradeResult =
  | { readonly kind: "already-target"; readonly treeOid: string }
  | {
      readonly kind: "upgraded";
      readonly sourceTreeOid: string;
      readonly treeOid: string;
    }
  | {
      readonly kind: "incompatible";
      readonly treeOid: string;
      readonly cause: TreeManifestError;
    };

interface TreeImportPlan {
  readonly treeOids: readonly string[];
  readonly blobOids: readonly string[];
  readonly blobProofs: ReadonlyMap<string, Stats>;
  readonly maxFileBytes: number;
}

const DEFAULT_MAX_OBJECT_BLOB_BYTES = 50 * 1024 * 1024;
/** Existing configuration has always admitted every positive safe byte size. */
const DURABLE_BLOB_VERIFICATION_CEILING = Number.MAX_SAFE_INTEGER;

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

async function preflightSourceAccess<T>(
  operation: () => T | Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const failure = asStoreError("tree import source preflight", error);
    if (failure.code === "storage-failure") {
      throw new TreeImportSourceError(failure);
    }
    throw error;
  }
}

/** Keeps an operational policy evaluator failure out of durable rejection. */
class TreeImportValidatorFailure extends Error {
  declare readonly cause: unknown;

  constructor(cause: unknown) {
    super("tree import validator failed", { cause });
    this.name = "TreeImportValidatorFailure";
  }
}

function isReplaceableObjectFailure(error: unknown): boolean {
  return (
    error instanceof ObjectStoreError &&
    (error.code === "missing-object" || error.code === "object-integrity")
  );
}

function requireNativeObjectStore(
  store: ObjectStore,
  operation: string,
): NativeObjectStore {
  if (!nativeObjectRecords.has(store)) {
    throw new ObjectStoreError(
      "storage-failure",
      `${operation} requires a native Cyclotomy object store`,
    );
  }
  return store as NativeObjectStore;
}

function nativeObjectAccess(source: NativeObjectStore): NativeObjectAccess {
  const native = requireNativeObjectStore(source, "tree import");
  return nativeObjectRecords.get(native)!.access;
}

/** Return the immutable layout authenticated with this native capability. */
export function nativeObjectStoreLayout(
  store: ObjectStore,
  operation: string,
): NativeObjectLayout {
  const native = requireNativeObjectStore(store, operation);
  return nativeObjectRecords.get(native)!.layout;
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function assertOid(oid: string): void {
  if (!isNativeObjectOid(oid)) {
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
      throw new ObjectSizeLimitError(before.size, maxBytes);
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
 * Run an async worker with bounded concurrency. On failure, remaining lanes
 * stop taking work; in-flight failures are reported in deterministic input
 * order after every started operation settles.
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
  const failures: Array<{ readonly index: number; readonly error: unknown }> =
    [];
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
        failures.push({ index, error });
        failed = true;
        return;
      }
    }
  });
  await Promise.all(runners);
  if (failures.length > 0) {
    failures.sort((left, right) => left.index - right.index);
    throw failures[0]!.error;
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
  maxBytes?: number,
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
    // The handle stat is the authoritative size observation. Reject before
    // allocating the streaming buffer or initializing a digest so a sparse or
    // otherwise oversized object cannot consume work proportional to its size.
    if (maxBytes !== undefined && before.size > maxBytes) {
      throw new ObjectSizeLimitError(before.size, maxBytes);
    }
    const hash = createHash("sha256");
    let byteLength = 0;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      const readLength =
        maxBytes === undefined
          ? buffer.byteLength
          : Math.min(buffer.byteLength, maxBytes - byteLength + 1);
      const result = await handle.read(buffer, 0, readLength, position);
      if (result.bytesRead === 0) {
        break;
      }
      const chunk = buffer.subarray(0, result.bytesRead);
      byteLength += chunk.byteLength;
      if (maxBytes !== undefined && byteLength > maxBytes) {
        throw new ObjectSizeLimitError(byteLength, maxBytes);
      }
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

class FileObjectStore implements NativeObjectStore {
  declare readonly [NATIVE_OBJECT_STORE]: true;
  declare readonly storageRoot: string;
  readonly #manifestLimits: TreeManifestLimits;
  readonly #maxFileBytes: number;

  constructor(
    root: string,
    manifestLimits: TreeManifestLimits,
    maxFileBytes: number,
  ) {
    Object.defineProperty(this, "storageRoot", {
      value: root,
      enumerable: true,
      writable: false,
      configurable: false,
    });
    const layout = nativeObjectLayout(root);
    this.#manifestLimits = manifestLimits;
    this.#maxFileBytes = maxFileBytes;
    nativeObjectRecords.set(
      this,
      Object.freeze({ access: this.#nativeObjectAccess, layout }),
    );
  }

  #layout(): NativeObjectLayout {
    return nativeObjectRecords.get(this)!.layout;
  }

  readonly #nativeObjectAccess: NativeObjectAccess = {
    readObject: (kind, oid) => this.#readObject(kind, oid),
    verifyObject: (kind, oid, maxBlobBytes) =>
      this.#verifyObject(kind, oid, maxBlobBytes),
    objectPath: (kind, oid) => this.#objectPath(kind, oid, false),
    assertStillVerified: (kind, oid, expected, maxBlobBytes) =>
      this.#assertStillVerified(kind, oid, expected, maxBlobBytes),
  };

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
    if (expectedByteLength > this.#maxFileBytes) {
      throw new ObjectStoreError(
        "invalid-blob",
        `streamed blob exceeds the ${this.#maxFileBytes}-byte file limit`,
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
        const proofs: Array<{
          readonly oid: string;
          readonly observation: Stats;
        }> = [];
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
            proofs.push({ oid: entry.blobOid, observation: proof });
          }
        }
        await runPool(
          proofs,
          ({ oid, observation }) =>
            this.#assertStillVerified("blob", oid, observation),
          VERIFICATION_CONCURRENCY,
        );
        treePublished = true;
        return this.#publishCurrentTree(prepared);
      },
    };
  }

  async #publishCurrentTree(
    manifest: CurrentTreeManifest,
    limits: TreeManifestLimits = this.#manifestLimits,
  ): Promise<string> {
    try {
      const encoded = encodeCurrentTreeManifest(manifest, limits);
      const oid = sha256(encoded);
      await this.#publishObject("tree", oid, encoded);
      return oid;
    } catch (error) {
      throw asStoreError("tree publication", error);
    }
  }

  async #publishAuthenticatedTreeManifest(
    manifest: TreeManifest,
    limits: TreeManifestLimits,
  ): Promise<string> {
    try {
      const encoded = encodeTreeManifest(manifest, limits);
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
  ): CurrentTreeManifest {
    try {
      return createCurrentTreeManifest(entries, scope, this.#manifestLimits);
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
      return await this.#readAuthenticatedTree(treeOid);
    } catch (error) {
      throw asStoreError("tree read", error);
    }
  }

  async readTreeManifest(treeOid: string): Promise<TreeManifest> {
    assertOid(treeOid);
    try {
      const encoded = await this.#readObject("tree", treeOid);
      return parseTreeManifest(encoded);
    } catch (error) {
      throw asStoreError("tree read", error);
    }
  }

  async upgradeTree(
    treeOid: string,
    targetFormat: string,
  ): Promise<TreeFormatUpgradeResult> {
    assertOid(treeOid);
    try {
      // Authenticate both the historical manifest and its complete blob
      // closure before publishing an object that metadata may later root.
      const source = await this.#readAuthenticatedTree(
        treeOid,
        DURABLE_BLOB_VERIFICATION_CEILING,
      );
      if (source.format === targetFormat) {
        return { kind: "already-target", treeOid };
      }

      let target: TreeManifest;
      try {
        // Durable schema conversion is independent of current capture policy.
        // Target-workspace admission still applies its configured limits when
        // a checkpoint is restored or imported elsewhere.
        target = upgradeTreeManifest(
          source,
          targetFormat,
          ABSOLUTE_WORKSPACE_PATH_LIMITS,
        );
      } catch (error) {
        if (
          error instanceof TreeManifestError &&
          error.kind === "format-incompatible"
        ) {
          return {
            kind: "incompatible",
            treeOid,
            cause: error,
          };
        }
        throw error;
      }

      const upgradedOid = await this.#publishAuthenticatedTreeManifest(
        target,
        ABSOLUTE_TREE_MANIFEST_LIMITS,
      );
      const verified = await this.#readAuthenticatedTree(
        upgradedOid,
        DURABLE_BLOB_VERIFICATION_CEILING,
      );
      if (verified.format !== targetFormat) {
        throw new ObjectStoreError(
          "object-integrity",
          "tree upgrade published an object in the wrong target format",
        );
      }
      return {
        kind: "upgraded",
        sourceTreeOid: treeOid,
        treeOid: upgradedOid,
      };
    } catch (error) {
      throw asStoreError("tree migration", error);
    }
  }

  async importTreesFrom(
    source: NativeObjectStore,
    treeOids: readonly string[],
    admission: TreeImportAdmission,
  ): Promise<void> {
    const sourceAccess = nativeObjectAccess(source);
    const uniqueTreeOids: string[] = [];
    const seenTrees = new Set<string>();
    for (const treeOid of treeOids) {
      assertOid(treeOid);
      if (!seenTrees.has(treeOid)) {
        seenTrees.add(treeOid);
        uniqueTreeOids.push(treeOid);
      }
    }

    let plan: TreeImportPlan;
    try {
      plan = await this.#preflightTreeImport(
        sourceAccess,
        uniqueTreeOids,
        admission,
      );
    } catch (error) {
      if (error instanceof TreeImportSourceError) throw error;
      if (error instanceof TreeImportValidatorFailure) throw error.cause;
      if (error instanceof TreeImportAdmissionError) throw error;
      throw new TreeImportAdmissionError(error);
    }
    try {
      await this.#publishTreeImport(sourceAccess, plan);
    } catch (error) {
      throw asStoreError("tree import", error);
    }
  }

  /**
   * Authenticate and admit the complete bundle before touching the target
   * object namespace. Manifests are deliberately reread rather than retained:
   * import memory is bounded by the distinct blob set, not historical tree
   * size, while content-addressing binds every later read to the same bytes.
   */
  async #preflightTreeImport(
    source: NativeObjectAccess,
    treeOids: readonly string[],
    admission: TreeImportAdmission,
  ): Promise<TreeImportPlan> {
    if (
      !Number.isSafeInteger(admission.maxSnapshotBytes) ||
      admission.maxSnapshotBytes <= 0
    ) {
      throw new ObjectStoreError(
        "invalid-tree-manifest",
        "tree import maxSnapshotBytes must be a positive safe integer",
      );
    }
    const blobOids = new Set<string>();
    for (const treeOid of treeOids) {
      const encoded = await preflightSourceAccess(() =>
        source.readObject("tree", treeOid),
      );
      const manifest = parseTreeManifest(encoded);
      if (!isCurrentTreeManifest(manifest)) {
        throw new ObjectStoreError(
          "invalid-tree-manifest",
          "non-current tree must be upgraded before cross-store import",
        );
      }
      let decision: TreeImportAdmissionDecision;
      try {
        decision = await admission.validateImportedTree(treeOid, manifest);
      } catch (cause) {
        throw new TreeImportValidatorFailure(cause);
      }
      if (decision.kind === "rejected") {
        throw new TreeImportAdmissionError(decision.cause);
      }
      if (decision.kind !== "accepted") {
        throw new TreeImportValidatorFailure(
          new Error("tree import validator returned an invalid decision"),
        );
      }
      for (const blobOid of treeManifestBlobOids(manifest)) {
        blobOids.add(blobOid);
      }
    }

    const uniqueBlobOids = [...blobOids];
    const blobProofs = new Map<string, Stats>();
    await runPool(
      uniqueBlobOids,
      async (blobOid) => {
        let proof: Stats;
        try {
          proof = await preflightSourceAccess(() =>
            source.verifyObject("blob", blobOid, this.#maxFileBytes),
          );
        } catch (error) {
          if (
            error instanceof ObjectSizeLimitError &&
            error.maxBytes === this.#maxFileBytes
          ) {
            throw new ObjectStoreError(
              "invalid-tree-manifest",
              `imported blob ${blobOid} exceeds the ${this.#maxFileBytes}-byte target file limit`,
              error,
            );
          }
          throw error;
        }
        if (proof.size > this.#maxFileBytes) {
          throw new ObjectStoreError(
            "invalid-tree-manifest",
            `imported blob ${blobOid} exceeds the ${this.#maxFileBytes}-byte target file limit`,
          );
        }
        blobProofs.set(blobOid, proof);
      },
      VERIFICATION_CONCURRENCY,
    );

    // Count logical content per manifest entry. Repeated paths to a shared
    // blob consume snapshot quota independently even though CAS publishes the
    // physical blob only once; symlink targets count their UTF-8 byte length.
    for (const treeOid of treeOids) {
      const manifest = parseTreeManifest(
        await preflightSourceAccess(() => source.readObject("tree", treeOid)),
      );
      let snapshotBytes = 0;
      for (const entry of manifest.entries) {
        const entryBytes =
          entry.type === "regular"
            ? blobProofs.get(entry.blobOid)?.size
            : Buffer.byteLength(entry.target, "utf8");
        if (entryBytes === undefined) {
          throw new ObjectStoreError(
            "object-integrity",
            `imported tree ${treeOid} references an unverified blob`,
          );
        }
        if (entryBytes > admission.maxSnapshotBytes - snapshotBytes) {
          throw new ObjectStoreError(
            "invalid-tree-manifest",
            `imported tree ${treeOid} exceeds the ${admission.maxSnapshotBytes}-byte target snapshot limit`,
          );
        }
        snapshotBytes += entryBytes;
      }
    }

    return {
      treeOids,
      blobOids: uniqueBlobOids,
      blobProofs,
      maxFileBytes: this.#maxFileBytes,
    };
  }

  /** Publish only a bundle that passed every predictable admission check. */
  async #publishTreeImport(
    source: NativeObjectAccess,
    plan: TreeImportPlan,
  ): Promise<void> {
    const readSource = async <T>(
      operation: () => T | Promise<T>,
    ): Promise<T> => {
      try {
        return await operation();
      } catch (error) {
        throw new TreeImportSourceError(error);
      }
    };

    let targetFailure: { readonly error: unknown } | undefined;
    try {
      await runPool(
        plan.blobOids,
        async (blobOid) => {
          try {
            const proof = plan.blobProofs.get(blobOid);
            if (proof === undefined) {
              throw new ObjectStoreError(
                "object-integrity",
                "tree import plan omitted an authenticated blob proof",
              );
            }
            const sourcePath = await readSource(() =>
              source.objectPath("blob", blobOid),
            );
            try {
              await this.#publishBlobFromFile(sourcePath, blobOid, proof.size);
            } catch (error) {
              if (error instanceof StreamedFileChangedError) {
                throw new TreeImportSourceError(error);
              }
              throw error;
            }
            await readSource(() =>
              source.assertStillVerified(
                "blob",
                blobOid,
                proof,
                plan.maxFileBytes,
              ),
            );
          } catch (error) {
            // A source failure selected by input order must not hide a target
            // failure from another already-active lane: target failure stays
            // fatal regardless of which lane reports first.
            if (!(error instanceof TreeImportSourceError)) {
              targetFailure ??= { error };
            }
            throw error;
          }
        },
        VERIFICATION_CONCURRENCY,
      );
    } catch (error) {
      if (targetFailure !== undefined) throw targetFailure.error;
      throw error;
    }

    for (const treeOid of plan.treeOids) {
      const manifest = await readSource(async () => {
        const current = parseTreeManifest(
          await source.readObject("tree", treeOid),
        );
        if (!isCurrentTreeManifest(current)) {
          throw new ObjectStoreError(
            "invalid-tree-manifest",
            "non-current tree must be upgraded before cross-store import",
          );
        }
        return current;
      });
      const published = await this.#publishCurrentTree(
        manifest,
        ABSOLUTE_TREE_MANIFEST_LIMITS,
      );
      if (published !== treeOid) {
        throw new ObjectStoreError(
          "object-integrity",
          "imported tree did not preserve its canonical object id",
        );
      }
      await this.readTreeManifest(treeOid);
    }

    // One final collective closure proof avoids retaining every large
    // manifest or re-hashing shared blobs once per historical checkpoint.
    await this.verifyBlobs(plan.blobOids);
    for (const treeOid of plan.treeOids) {
      await this.readTreeManifest(treeOid);
    }
  }

  async verifyBlobs(blobOids: readonly string[]): Promise<void> {
    return this.#verifyBlobs(blobOids);
  }

  async #verifyBlobs(
    blobOids: readonly string[],
    maxBlobBytes?: number,
  ): Promise<void> {
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
          await this.#verifyObject("blob", oid, maxBlobBytes);
        },
        VERIFICATION_CONCURRENCY,
      );
    } catch (error) {
      throw asStoreError("blob verification", error);
    }
  }

  /** Authenticate every distinct blob referenced by the entries. */
  async #verifyClosure(
    manifest: TreeManifest,
    maxBlobBytes?: number,
  ): Promise<void> {
    await this.#verifyBlobs(treeManifestBlobOids(manifest), maxBlobBytes);
  }

  async #readAuthenticatedTree(
    treeOid: string,
    maxBlobBytes?: number,
  ): Promise<TreeManifest> {
    const manifest = await this.readTreeManifest(treeOid);
    await this.#verifyClosure(manifest, maxBlobBytes);
    return manifest;
  }

  async #objectPath(
    kind: NativeObjectKind,
    oid: string,
    createShard: boolean,
  ): Promise<string> {
    assertOid(oid);
    const layout = this.#layout();
    await assertDirectory(layout.root);
    const namespace = nativeObjectNamespacePath(layout, kind);
    await assertDirectory(namespace);
    const shardName = oid.slice(0, 2);
    const shard = createShard
      ? await ensureChildDirectory(namespace, shardName)
      : nativeObjectShardPath(layout, kind, shardName);
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
    return nativeObjectPath(layout, kind, oid);
  }

  async #observeObject(kind: NativeObjectKind, oid: string): Promise<Stats> {
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
    kind: NativeObjectKind,
    oid: string,
    expected: Stats,
    maxBlobBytes?: number,
  ): Promise<void> {
    const current = await this.#observeObject(kind, oid);
    if (sameFileObservation(expected, current)) {
      return;
    }
    // Metadata changed after the proof was made. Re-hash rather than trusting
    // stat identity; this accepts a benign atomic rewrite only when its bytes
    // still match the content-addressed id.
    await this.#verifyObject(kind, oid, maxBlobBytes);
  }

  async #readObject(kind: NativeObjectKind, oid: string): Promise<Buffer> {
    const path = await this.#objectPath(kind, oid, false);
    let content: Buffer;
    try {
      content = await readRegularFile(
        path,
        kind === "tree" ? ABSOLUTE_MAX_TREE_MANIFEST_BYTES : this.#maxFileBytes,
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

  async #verifyObject(
    kind: NativeObjectKind,
    oid: string,
    maxBlobBytes?: number,
  ): Promise<Stats> {
    const path = await this.#objectPath(kind, oid, false);
    let maxBytes = ABSOLUTE_MAX_TREE_MANIFEST_BYTES;
    if (kind === "blob") {
      maxBytes = maxBlobBytes ?? this.#maxFileBytes;
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
        throw new ObjectStoreError(
          "invalid-blob",
          "blob verification limit must be a positive safe integer",
        );
      }
    }
    let observed: Awaited<ReturnType<typeof streamRegularFile>>;
    try {
      observed = await streamRegularFile(
        path,
        undefined,
        "private-object",
        maxBytes,
      );
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
    const parent = nativeObjectShardPath(
      this.#layout(),
      "blob",
      oid.slice(0, 2),
    );

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
      nativeTemporaryObjectName(oid, process.pid, randomUUID()),
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
      let targetStreamFailure: { readonly error: unknown } | undefined;
      let observed: Awaited<ReturnType<typeof streamRegularFile>>;
      try {
        observed = await streamRegularFile(
          sourcePath,
          async (chunk) => {
            if (targetHandle === undefined) {
              const error = new ObjectStoreError(
                "storage-failure",
                "temporary blob handle closed unexpectedly",
              );
              targetStreamFailure = { error };
              throw error;
            }
            copiedBytes += chunk.byteLength;
            if (copiedBytes > expectedByteLength) {
              throw new StreamedFileChangedError(
                "source file grew beyond the scanned blob length",
              );
            }
            try {
              await targetHandle.writeFile(chunk);
            } catch (error) {
              targetStreamFailure = { error };
              throw error;
            }
          },
          "stream-source",
          // The scanned length is both an integrity fact and a tighter
          // operation-local resource bound. A growth race is rejected on the
          // opened handle before hashing even one byte beyond that proof.
          Math.min(this.#maxFileBytes, expectedByteLength),
        );
      } catch (error) {
        if (targetStreamFailure !== undefined) {
          throw targetStreamFailure.error;
        }
        throw error instanceof StreamedFileChangedError
          ? error
          : new StreamedFileChangedError(
              "source file could not be streamed",
              error,
            );
      }
      if (
        observed.byteLength !== expectedByteLength ||
        observed.digest !== oid
      ) {
        throw new StreamedFileChangedError(
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
    kind: NativeObjectKind,
    oid: string,
    content: Uint8Array,
  ): Promise<Stats> {
    const target = await this.#objectPath(kind, oid, true);
    const parent = nativeObjectShardPath(this.#layout(), kind, oid.slice(0, 2));

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
      nativeTemporaryObjectName(oid, process.pid, randomUUID()),
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
): Promise<NativeObjectStore> {
  const canonicalRoot = canonicalStoreRoot(root);
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_OBJECT_BLOB_BYTES;
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
    if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0) {
      throw new ObjectStoreError(
        "invalid-blob",
        "object-store maxFileBytes must be a positive safe integer",
      );
    }
    assertTreeManifestLimits(manifestLimits);
    await mkdir(canonicalRoot, {
      recursive: true,
      mode: 0o700,
    });
    await assertDirectory(canonicalRoot);
    await syncDirectory(canonicalRoot);
    const layout = nativeObjectLayout(canonicalRoot);
    await ensureChildDirectory(canonicalRoot, parsePath(layout.objects).base);
    await ensureChildDirectory(layout.objects, parsePath(layout.blobs).base);
    await ensureChildDirectory(layout.objects, parsePath(layout.trees).base);
    return new FileObjectStore(canonicalRoot, manifestLimits, maxFileBytes);
  } catch (error) {
    throw asStoreError("object-store initialization", error);
  }
}
