import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { isAbsolute, join, parse as parsePath, resolve } from "node:path";

import {
  ABSOLUTE_WORKSPACE_PATH_LIMITS,
  type WorkspaceScope,
} from "./workspace-scope.ts";
import { primaryFailure, withRetainedCleanup } from "./failure-settlement.ts";
import { systemErrorCode } from "./system-error.ts";
import { openWorkspaceRegularCandidate } from "./workspace-file-open.ts";
import {
  ContentRepository,
  ContentRepositoryError,
  type ContentRepositoryResolutionScope,
  type PublishedContent,
  type VerifiedContentRead,
} from "./content-store/repository.ts";
import {
  isNativeObjectOid,
  nativeObjectLayout,
  type NativeObjectLayout,
} from "./workspace-store.ts";
import {
  ABSOLUTE_TREE_MANIFEST_LIMITS,
  assertTreeManifestLimits,
  DEFAULT_TREE_MANIFEST_LIMITS,
  TreeManifestError,
  type TreeEntry,
  type TreeManifest,
  type TreeManifestLimits,
} from "./tree-formats/manifest-codec.ts";
import {
  CURRENT_TREE_FORMAT,
  createCurrentTreeManifest,
  requireCurrentTreeManifest,
  type CurrentTreeManifest,
} from "./tree-formats/current.ts";
import {
  treeManifestBlobOids,
  upgradeTreeManifest,
} from "./tree-formats/history.ts";
import {
  publishStoredTree,
  readStoredTree,
} from "./tree-formats/stored-registry.ts";
import { STORED_TREE_FORMAT_V3 } from "./tree-formats/v3-storage.ts";
import type {
  AuthenticatedStoredTree,
  StoredTreeReadAccess,
  StoredTreeWriteAccess,
} from "./tree-formats/stored-adapter.ts";

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
  constructor(cause: unknown, retainedFailure?: unknown) {
    const failure = asStoreError("tree import admission", cause);
    super(
      failure.code,
      failure.message,
      retainedFailure === undefined ? failure : retainedFailure,
    );
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
  constructor(cause: unknown, retainedFailure?: unknown) {
    const failure = asStoreError("tree import source", cause);
    super(
      failure.code,
      failure.message,
      retainedFailure === undefined ? failure : retainedFailure,
    );
    this.name = "TreeImportSourceError";
  }
}

function rethrowTreeImportPrimary(failure: unknown): never {
  const primary = primaryFailure(failure);
  if (primary === failure) throw primary;
  if (primary instanceof TreeImportAdmissionError) {
    throw new TreeImportAdmissionError(primary, failure);
  }
  if (primary instanceof TreeImportSourceError) {
    throw new TreeImportSourceError(primary, failure);
  }
  if (primary instanceof ObjectStoreError) {
    throw new ObjectStoreError(primary.code, primary.message, failure);
  }
  throw failure;
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
  /**
   * Retire this one-shot publication and release its operation-scoped reads.
   * Closing is idempotent and waits for every blob lane that already started.
   */
  close(): Promise<void>;
}

export interface ObjectStore {
  /** Native filesystem-store root, used only to keep scratch state outside. */
  readonly storageRoot: string;
  readBlob(oid: string): Promise<Uint8Array>;
  /** Decode and authenticate logical content with bounded caller memory. */
  streamBlob(
    oid: string,
    sink: (chunk: Uint8Array) => Promise<void>,
  ): Promise<{ readonly decodedLength: number }>;
  /**
   * Open a short-lived publication boundary. Callers must publish every blob
   * through the returned object before publishing its tree.
   */
  beginSnapshotPublication(): SnapshotPublication;
  /**
   * Read and authenticate the complete closure: the canonical manifest and
   * every regular-file blob it references.
   */
  readTree(treeOid: string): Promise<CurrentTreeManifest>;
  /**
   * Read and authenticate only the tree object itself (digest and canonical
   * manifest), without verifying the blob closure. Suitable for diagnostics
   * such as diff. Anything that will apply content must authenticate every
   * blob it may write (for example by staging readBlob results) before the
   * first workspace mutation.
   */
  readTreeManifest(treeOid: string): Promise<CurrentTreeManifest>;
  /** Authenticate exactly the supplied blob ids with bounded concurrency. */
  verifyBlobs(blobOids: readonly string[]): Promise<void>;
}

/** Internal operation-scoped reader; fake stores receive a delegating shim. */
export interface ObjectStoreReadScope {
  readTreeManifest(treeOid: string): Promise<CurrentTreeManifest>;
  readBlob(oid: string): Promise<Uint8Array>;
  streamBlob(
    oid: string,
    sink: (chunk: Uint8Array) => Promise<void>,
  ): Promise<{ readonly decodedLength: number }>;
  verifyBlobs(blobOids: readonly string[]): Promise<void>;
  close(): Promise<void>;
}

export type AuthenticatedCurrentTree = Omit<
  AuthenticatedStoredTree,
  "manifest"
> & {
  readonly manifest: CurrentTreeManifest;
};

interface NativeObjectStoreReadScope extends ObjectStoreReadScope {
  readTreeClosure(treeOid: string): Promise<AuthenticatedCurrentTree>;
  readContentClosure(
    contentId: string,
    maximumBytes: number,
  ): Promise<VerifiedContentRead>;
  verifyContent(oid: string, maximumBytes: number): Promise<NativeContentProof>;
  streamVerifiedContent(
    proof: NativeContentProof,
    maximumBytes: number,
    sink: (chunk: Uint8Array) => Promise<void>,
  ): Promise<{ readonly decodedLength: number }>;
}

interface NativeObjectAccess {
  openReadScope(): NativeObjectStoreReadScope;
  upgradeStoredTree(
    treeOid: string,
    targetFormat: string,
  ): Promise<TreeFormatUpgradeResult>;
}

interface NativeContentProof {
  readonly contentId: string;
  readonly decodedLength: number;
}

interface NativeContentProofRecord {
  readonly owner: object;
  readonly contentId: string;
  readonly decodedLength: number;
}

const nativeContentProofRecords = new WeakMap<
  NativeContentProof,
  NativeContentProofRecord
>();

declare const NATIVE_OBJECT_STORE: unique symbol;

interface NativeObjectRecord {
  readonly access: NativeObjectAccess;
  readonly layout: NativeObjectLayout;
  readonly repository: ContentRepository;
}

const nativeObjectRecords = new WeakMap<object, NativeObjectRecord>();

/** A store opened over Cyclotomy's authenticated native CAS layout. */
export interface NativeObjectStore extends ObjectStore {
  readonly [NATIVE_OBJECT_STORE]: true;
  /** Authenticate the stored tree graph and expose its complete mark closure. */
  readTreeClosure(treeOid: string): Promise<AuthenticatedCurrentTree>;
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
  readonly blobProofs: ReadonlyMap<string, NativeContentProof>;
  readonly maxFileBytes: number;
}

const DEFAULT_MAX_OBJECT_BLOB_BYTES = 50 * 1024 * 1024;
/** Existing configuration has always admitted every positive safe byte size. */
const DURABLE_BLOB_VERIFICATION_CEILING = Number.MAX_SAFE_INTEGER;

function asStoreError(action: string, error: unknown): ObjectStoreError {
  const primary = primaryFailure(error);
  if (primary instanceof ObjectStoreError) {
    if (primary === error) return primary;
    return new ObjectStoreError(primary.code, primary.message, error);
  }
  if (primary instanceof ContentRepositoryError) {
    const code: ObjectStoreErrorCode =
      primary.code === "missing-object"
        ? "missing-object"
        : primary.code === "object-integrity" ||
            primary.code === "limit-exceeded"
          ? "object-integrity"
          : primary.code === "invalid-input"
            ? "invalid-object-id"
            : "storage-failure";
    return new ObjectStoreError(code, primary.message, error);
  }
  if (primary instanceof TreeManifestError) {
    return new ObjectStoreError(primary.kind, primary.message, error);
  }
  return new ObjectStoreError("storage-failure", `${action} failed`, error);
}

async function preflightSourceAccess<T>(
  operation: () => T | Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    // The caller applies a target policy to a source-authenticated value.
    // Failure to read or authenticate that value is therefore always a
    // retryable source failure, never durable evidence against the target.
    // Preserve the explicit target-size signal so the caller can translate it
    // into a deterministic admission rejection.
    if (error instanceof ObjectSizeLimitError) throw error;
    const failure = asStoreError("tree import source preflight", error);
    throw new TreeImportSourceError(failure);
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

/** Return the immutable layout authenticated with this native capability. */
export function nativeObjectStoreLayout(
  store: ObjectStore,
  operation: string,
): NativeObjectLayout {
  const native = requireNativeObjectStore(store, operation);
  return nativeObjectRecords.get(native)!.layout;
}

/** Internal representation repository bound to this native store capability. */
export function nativeObjectStoreRepository(
  store: ObjectStore,
  operation: string,
): ContentRepository {
  const native = requireNativeObjectStore(store, operation);
  return nativeObjectRecords.get(native)!.repository;
}

/** Open one bounded read operation, with a transparent non-native fallback. */
export function openObjectStoreReadScope(
  store: ObjectStore,
): ObjectStoreReadScope {
  const native = nativeObjectRecords.get(store);
  if (native !== undefined) return native.access.openReadScope();
  return Object.freeze({
    readTreeManifest: (treeOid: string) => store.readTreeManifest(treeOid),
    readBlob: (oid: string) => store.readBlob(oid),
    streamBlob: (oid: string, sink: (chunk: Uint8Array) => Promise<void>) =>
      store.streamBlob(oid, sink),
    verifyBlobs: (blobOids: readonly string[]) => store.verifyBlobs(blobOids),
    close: async () => undefined,
  });
}

/** Native superset used by import and GC without exposing repository tokens. */
export function openNativeObjectStoreReadScope(
  store: NativeObjectStore,
  operation: string,
): NativeObjectStoreReadScope {
  const native = requireNativeObjectStore(store, operation);
  return nativeObjectRecords.get(native)!.access.openReadScope();
}

/** Historical tree conversion is exposed only to the metadata migration path. */
export function upgradeStoredTree(
  store: NativeObjectStore,
  treeOid: string,
  targetFormat: string,
): Promise<TreeFormatUpgradeResult> {
  const native = requireNativeObjectStore(store, "tree migration");
  return nativeObjectRecords
    .get(native)!
    .access.upgradeStoredTree(treeOid, targetFormat);
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
  await withRetainedCleanup(
    async () => {
      const stat = await handle.stat();
      if (!stat.isDirectory()) {
        throw new ObjectStoreError(
          "storage-failure",
          "controlled object-store path is not a directory",
        );
      }
      await handle.sync();
    },
    () => handle.close(),
    "object-store directory synchronization and cleanup both failed",
  );
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
    if (systemErrorCode(error) !== "EEXIST") {
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

/**
 * Refuse a final-component symlink/reparse point before open(). This first
 * gate matters on Windows, where O_NOFOLLOW is unavailable and opening first
 * would already follow an external target. The opened handle is bound back to
 * this observation separately, closing the lstat-to-open replacement window.
 */
async function observeWorkspaceStreamSourceBeforeOpen(
  path: string,
): Promise<Stats> {
  let observation: Stats;
  try {
    observation = await lstat(path);
  } catch (error) {
    throw new StreamedFileChangedError(
      "source path no longer names the scanned regular file",
      error,
    );
  }
  if (
    observation.isSymbolicLink() ||
    !observation.isFile() ||
    observation.nlink !== 1
  ) {
    throw new StreamedFileChangedError(
      "source path no longer names the scanned regular file",
    );
  }
  return observation;
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
    if (systemErrorCode(error) === "ENOENT") return false;
    throw error;
  }
  return (
    !current.isSymbolicLink() &&
    current.isFile() &&
    current.nlink === 1 &&
    sameFileObservation(opened, current)
  );
}

async function streamWorkspaceSourceFile(
  path: string,
  onChunk: (chunk: Buffer) => Promise<void>,
  maxBytes: number,
): Promise<{
  readonly digest: string;
  readonly byteLength: number;
}> {
  const pathBefore = await observeWorkspaceStreamSourceBeforeOpen(path);
  const handle = await openWorkspaceRegularCandidate(path, constants.O_RDONLY);
  return await withRetainedCleanup(
    async () => {
      const before = await handle.stat();
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        !sameFileObservation(pathBefore, before) ||
        !(await pathStillBindsRegularFile(path, before))
      ) {
        throw new StreamedFileChangedError(
          "source path no longer names the scanned regular file",
        );
      }
      // The handle stat is the authoritative size observation. Reject before
      // allocating the streaming buffer or initializing a digest so a sparse or
      // otherwise oversized object cannot consume work proportional to its size.
      if (before.size > maxBytes) {
        throw new ObjectSizeLimitError(before.size, maxBytes);
      }
      const hash = createHash("sha256");
      let byteLength = 0;
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let position = 0;
      while (true) {
        const readLength = Math.min(
          buffer.byteLength,
          maxBytes - byteLength + 1,
        );
        const result = await handle.read(buffer, 0, readLength, position);
        if (result.bytesRead === 0) {
          break;
        }
        const chunk = buffer.subarray(0, result.bytesRead);
        byteLength += chunk.byteLength;
        if (byteLength > maxBytes) {
          throw new ObjectSizeLimitError(byteLength, maxBytes);
        }
        hash.update(chunk);
        await onChunk(chunk);
        position += result.bytesRead;
      }
      const after = await handle.stat();
      if (
        !sameFileObservation(before, after) ||
        !(await pathStillBindsRegularFile(path, after))
      ) {
        throw new StreamedFileChangedError(
          "file or its pathname changed while it was being streamed",
        );
      }
      return {
        digest: hash.digest("hex"),
        byteLength,
      };
    },
    () => handle.close(),
    "workspace source streaming and cleanup both failed",
  );
}

class FileObjectStore implements NativeObjectStore {
  declare readonly [NATIVE_OBJECT_STORE]: true;
  declare readonly storageRoot: string;
  readonly #manifestLimits: TreeManifestLimits;
  readonly #maxFileBytes: number;
  readonly #repository: ContentRepository;
  readonly #contentProofOwner = Object.freeze({});

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
    this.#repository = new ContentRepository(layout, {
      // The repository is a durable-format decoder, not an admission policy.
      // Call sites always provide their exact operation limit; schema upgrade
      // must remain able to authenticate objects captured under older config.
      maxDecodedBytes: DURABLE_BLOB_VERIFICATION_CEILING,
    });
    nativeObjectRecords.set(
      this,
      Object.freeze({
        access: this.#nativeObjectAccess,
        layout,
        repository: this.#repository,
      }),
    );
  }

  readonly #nativeObjectAccess: NativeObjectAccess = {
    openReadScope: () => this.#openNativeReadScope(),
    upgradeStoredTree: (treeOid, targetFormat) =>
      this.#upgradeStoredTree(treeOid, targetFormat),
  };

  #openNativeReadScope(): NativeObjectStoreReadScope {
    const scope = this.#repository.openResolutionScope();
    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      if (closePromise !== undefined) return closePromise;
      closePromise = this.#repository.closeResolutionScope(scope);
      return closePromise;
    };
    return Object.freeze({
      readTreeClosure: (treeOid: string) =>
        this.#readTreeClosure(treeOid, scope),
      readContentClosure: (contentId: string, maximumBytes: number) =>
        this.#repository.streamContent(
          contentId,
          maximumBytes,
          async () => undefined,
          scope,
        ),
      readTreeManifest: (treeOid: string) =>
        this.#readTreeManifest(treeOid, scope),
      readBlob: async (oid: string) => {
        const chunks: Buffer[] = [];
        const { decodedLength } = await this.#streamContent(
          oid,
          this.#maxFileBytes,
          async (chunk) => {
            chunks.push(Buffer.from(chunk));
          },
          scope,
        );
        return Buffer.concat(chunks, decodedLength);
      },
      streamBlob: (oid: string, sink: (chunk: Uint8Array) => Promise<void>) =>
        this.#streamContent(oid, this.#maxFileBytes, sink, scope),
      verifyBlobs: (blobOids: readonly string[]) =>
        this.#verifyBlobs(blobOids, undefined, scope),
      verifyContent: (oid: string, maximumBytes: number) =>
        this.#verifyContent(oid, maximumBytes, scope),
      streamVerifiedContent: (
        proof: NativeContentProof,
        maximumBytes: number,
        sink: (chunk: Uint8Array) => Promise<void>,
      ) => this.#streamVerifiedContent(proof, maximumBytes, sink, scope),
      close,
    });
  }

  #storedTreeReadAccess(
    scope: ContentRepositoryResolutionScope,
  ): StoredTreeReadAccess {
    return {
      readStructuralObject: (kind, oid, maximumBytes) =>
        this.#repository.readStructural(kind, oid, maximumBytes, scope),
      readContent: async (contentId, maximumBytes) => {
        const chunks: Buffer[] = [];
        const { decodedLength } = await this.#repository.streamContent(
          contentId,
          maximumBytes,
          async (chunk) => {
            chunks.push(Buffer.from(chunk));
          },
          scope,
        );
        return Buffer.concat(chunks, decodedLength);
      },
    };
  }

  #storedTreeWriteAccess(
    scope: ContentRepositoryResolutionScope,
  ): StoredTreeWriteAccess {
    return {
      publishStructuralObject: async (kind, oid, canonicalBytes) => {
        if (sha256(canonicalBytes) !== oid) {
          throw new ObjectStoreError(
            "object-integrity",
            "tree structural bytes do not match their object id",
          );
        }
        await this.#repository.publishStructural(
          kind,
          oid,
          canonicalBytes,
          scope,
        );
      },
      ensureContent: async (contentId, rawBytes) => {
        if (sha256(rawBytes) !== contentId) {
          throw new ObjectStoreError(
            "object-integrity",
            "tree content bytes do not match their content id",
          );
        }
        await this.#repository.ensureRawContent(contentId, rawBytes, scope);
      },
    };
  }

  async #withResolutionScope<T>(
    operation: (scope: ContentRepositoryResolutionScope) => Promise<T>,
  ): Promise<T> {
    const scope = this.#repository.openResolutionScope();
    return await withRetainedCleanup(
      () => operation(scope),
      () => this.#repository.closeResolutionScope(scope),
      "object-store operation and resolution cleanup both failed",
    );
  }

  async #publishBlobFile(
    sourcePath: string,
    expectedOid: string,
    expectedByteLength: number,
    scope?: ContentRepositoryResolutionScope,
  ): Promise<{ readonly oid: string; readonly proof: PublishedContent }> {
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
      const proof = await this.#repository.publishContentFromStream(
        expectedOid,
        expectedByteLength,
        async (sink) => {
          const observed = await streamWorkspaceSourceFile(
            sourcePath,
            async (chunk) => sink(chunk),
            Math.min(this.#maxFileBytes, expectedByteLength),
          );
          if (
            observed.byteLength !== expectedByteLength ||
            observed.digest !== expectedOid
          ) {
            throw new StreamedFileChangedError(
              "source file no longer matches the scanned blob digest and length",
            );
          }
        },
        {},
        scope,
      );
      return { oid: expectedOid, proof };
    } catch (error) {
      if (primaryFailure(error) instanceof StreamedFileChangedError) {
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
    const chunks: Buffer[] = [];
    try {
      const { decodedLength } = await this.streamBlob(oid, async (chunk) => {
        chunks.push(Buffer.from(chunk));
      });
      return Buffer.concat(chunks, decodedLength);
    } catch (error) {
      throw asStoreError("blob read", error);
    }
  }

  async streamBlob(
    oid: string,
    sink: (chunk: Uint8Array) => Promise<void>,
  ): Promise<{ readonly decodedLength: number }> {
    assertOid(oid);
    return this.#streamContent(oid, this.#maxFileBytes, sink);
  }

  async #streamContent(
    oid: string,
    maximumBytes: number,
    sink: (chunk: Uint8Array) => Promise<void>,
    scope?: ContentRepositoryResolutionScope,
  ): Promise<{ readonly decodedLength: number }> {
    assertOid(oid);
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
      throw new ObjectStoreError(
        "invalid-blob",
        "content stream limit must be a positive safe integer",
      );
    }
    try {
      const observed = await this.#repository.streamContent(
        oid,
        maximumBytes,
        sink,
        scope,
      );
      return { decodedLength: observed.decodedLength };
    } catch (error) {
      if (
        error instanceof ContentRepositoryError &&
        error.code === "limit-exceeded" &&
        maximumBytes < this.#repository.maxDecodedBytes
      ) {
        throw new ObjectSizeLimitError(maximumBytes + 1, maximumBytes);
      }
      throw asStoreError("blob stream", error);
    }
  }

  async #verifyContent(
    contentId: string,
    maximumBytes: number,
    scope?: ContentRepositoryResolutionScope,
  ): Promise<NativeContentProof> {
    assertOid(contentId);
    const { decodedLength } = await this.#streamContent(
      contentId,
      maximumBytes,
      async () => {},
      scope,
    );
    const proof = Object.freeze({ contentId, decodedLength });
    nativeContentProofRecords.set(proof, {
      owner: this.#contentProofOwner,
      contentId,
      decodedLength,
    });
    return proof;
  }

  async #streamVerifiedContent(
    proof: NativeContentProof,
    maximumBytes: number,
    sink: (chunk: Uint8Array) => Promise<void>,
    scope?: ContentRepositoryResolutionScope,
  ): Promise<{ readonly decodedLength: number }> {
    const record = nativeContentProofRecords.get(proof);
    if (
      record === undefined ||
      record.owner !== this.#contentProofOwner ||
      record.contentId !== proof.contentId ||
      record.decodedLength !== proof.decodedLength
    ) {
      throw new ObjectStoreError(
        "object-integrity",
        "content proof does not belong to this object store",
      );
    }
    const streamed = await this.#streamContent(
      record.contentId,
      maximumBytes,
      sink,
      scope,
    );
    if (streamed.decodedLength !== record.decodedLength) {
      throw new ObjectStoreError(
        "object-integrity",
        "content length changed after import preflight",
      );
    }
    return streamed;
  }

  beginSnapshotPublication(): SnapshotPublication {
    const verified = new Map<string, PublishedContent>();
    const resolutionScope = this.#repository.openResolutionScope();
    const activeBlobs = new Set<Promise<string>>();
    let blobFailure: { readonly cause: unknown } | undefined;
    let state: "open" | "tree-publishing" | "closing" | "closed" = "open";
    let treePublication: Promise<string> | undefined;
    let resourceClose: Promise<void> | undefined;
    const assertOpen = (): void => {
      if (state !== "open") {
        throw new ObjectStoreError(
          "storage-failure",
          "snapshot publication is already closed or publishing its tree",
        );
      }
    };
    const closeResources = (): Promise<void> => {
      resourceClose ??= (async () => {
        await Promise.allSettled([...activeBlobs]);
        try {
          await this.#repository.closeResolutionScope(resolutionScope);
        } finally {
          state = "closed";
        }
      })();
      return resourceClose;
    };
    const close = async (): Promise<void> => {
      if (state === "open") state = "closing";
      if (treePublication !== undefined) {
        await treePublication.catch(() => undefined);
        // Tree publication owns resource cleanup in its finally block. Do not
        // await the same rejected cleanup promise again and duplicate it in an
        // outer AggregateError.
        return;
      }
      await closeResources();
    };
    return {
      publishBlobFromFile: (sourcePath, expectedOid, expectedByteLength) => {
        assertOpen();
        const pending = (async () => {
          const { oid, proof } = await this.#publishBlobFile(
            sourcePath,
            expectedOid,
            expectedByteLength,
            resolutionScope,
          );
          verified.set(oid, proof);
          return oid;
        })();
        activeBlobs.add(pending);
        void pending.then(
          () => activeBlobs.delete(pending),
          (cause) => {
            blobFailure ??= { cause };
            activeBlobs.delete(pending);
          },
        );
        return pending;
      },
      publishTree: (entries, scope) => {
        assertOpen();
        if (scope.kind === "git" && scope.evaluator === null) {
          throw new ObjectStoreError(
            "invalid-tree-manifest",
            "new snapshot tree requires captured Git evaluator provenance",
          );
        }
        state = "tree-publishing";
        const publish = (async () => {
          await Promise.allSettled([...activeBlobs]);
          if (blobFailure !== undefined) throw blobFailure.cause;
          const prepared = this.#prepareTree(entries, scope);
          const checked = new Set<string>();
          const proofs: PublishedContent[] = [];
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
              proofs.push(proof);
            }
          }
          await runPool(
            proofs,
            (proof) =>
              this.#repository.revalidatePublishedContent(
                proof,
                this.#maxFileBytes,
                resolutionScope,
              ),
            VERIFICATION_CONCURRENCY,
          );
          return await this.#publishCurrentTree(
            prepared,
            this.#manifestLimits,
            resolutionScope,
          );
        })();
        treePublication = withRetainedCleanup(
          async () => await publish,
          closeResources,
          "snapshot tree publication and cleanup both failed",
        );
        return treePublication;
      },
      close,
    };
  }

  async #publishCurrentTree(
    manifest: CurrentTreeManifest,
    limits: TreeManifestLimits = this.#manifestLimits,
    scope?: ContentRepositoryResolutionScope,
  ): Promise<string> {
    try {
      if (scope !== undefined) {
        return await STORED_TREE_FORMAT_V3.publish(
          manifest,
          this.#storedTreeWriteAccess(scope),
          limits,
        );
      }
      return await this.#withResolutionScope((operationScope) =>
        STORED_TREE_FORMAT_V3.publish(
          manifest,
          this.#storedTreeWriteAccess(operationScope),
          limits,
        ),
      );
    } catch (error) {
      throw asStoreError("tree publication", error);
    }
  }

  async #publishAuthenticatedTreeManifest(
    manifest: TreeManifest,
    limits: TreeManifestLimits,
  ): Promise<string> {
    try {
      return await this.#withResolutionScope((scope) =>
        publishStoredTree(manifest, this.#storedTreeWriteAccess(scope), limits),
      );
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

  async readTree(treeOid: string): Promise<CurrentTreeManifest> {
    assertOid(treeOid);
    try {
      return await this.#withResolutionScope((scope) =>
        this.#readAuthenticatedTree(treeOid, undefined, scope),
      );
    } catch (error) {
      throw asStoreError("tree read", error);
    }
  }

  async readTreeManifest(treeOid: string): Promise<CurrentTreeManifest> {
    return (await this.readTreeClosure(treeOid)).manifest;
  }

  async #readTreeManifest(
    treeOid: string,
    scope: ContentRepositoryResolutionScope,
  ): Promise<CurrentTreeManifest> {
    assertOid(treeOid);
    return (await this.#readTreeClosure(treeOid, scope)).manifest;
  }

  async readTreeClosure(treeOid: string): Promise<AuthenticatedCurrentTree> {
    assertOid(treeOid);
    try {
      return await this.#withResolutionScope((scope) =>
        this.#readTreeClosure(treeOid, scope),
      );
    } catch (error) {
      throw asStoreError("tree read", error);
    }
  }

  async #readTreeClosure(
    treeOid: string,
    scope: ContentRepositoryResolutionScope,
  ): Promise<AuthenticatedCurrentTree> {
    assertOid(treeOid);
    try {
      const closure = await STORED_TREE_FORMAT_V3.readAuthenticated(
        treeOid,
        this.#storedTreeReadAccess(scope),
        ABSOLUTE_TREE_MANIFEST_LIMITS,
      );
      requireCurrentTreeManifest(closure.manifest);
      return closure as AuthenticatedCurrentTree;
    } catch (error) {
      throw asStoreError("tree read", error);
    }
  }

  async #readStoredTreeClosure(
    treeOid: string,
    scope: ContentRepositoryResolutionScope,
  ): Promise<AuthenticatedStoredTree> {
    assertOid(treeOid);
    try {
      return await readStoredTree(
        treeOid,
        this.#storedTreeReadAccess(scope),
        ABSOLUTE_TREE_MANIFEST_LIMITS,
      );
    } catch (error) {
      throw asStoreError("tree read", error);
    }
  }

  async #upgradeStoredTree(
    treeOid: string,
    targetFormat: string,
  ): Promise<TreeFormatUpgradeResult> {
    assertOid(treeOid);
    try {
      // Authenticate both the historical manifest and its complete blob
      // closure before publishing an object that metadata may later root.
      const source = await this.#readAuthenticatedStoredTree(
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
      const verified = await this.#readAuthenticatedStoredTree(
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
    const uniqueTreeOids: string[] = [];
    const seenTrees = new Set<string>();
    for (const treeOid of treeOids) {
      assertOid(treeOid);
      if (!seenTrees.has(treeOid)) {
        seenTrees.add(treeOid);
        uniqueTreeOids.push(treeOid);
      }
    }

    const sourceAccess = openNativeObjectStoreReadScope(source, "tree import");
    const targetScope = this.#repository.openResolutionScope();
    try {
      await withRetainedCleanup(
        async () => {
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
            await this.#publishTreeImport(sourceAccess, plan, targetScope);
          } catch (error) {
            throw asStoreError("tree import", error);
          }
        },
        () =>
          withRetainedCleanup(
            () => this.#repository.closeResolutionScope(targetScope),
            () => sourceAccess.close(),
            "tree import scope cleanup failed",
          ),
        "tree import operation and scope cleanup both failed",
      );
    } catch (error) {
      rethrowTreeImportPrimary(error);
    }
  }

  /**
   * Authenticate and admit the complete bundle before touching the target
   * object namespace. Manifests are deliberately reread rather than retained:
   * import memory is bounded by the distinct blob set, not historical tree
   * size, while content-addressing binds every later read to the same bytes.
   */
  async #preflightTreeImport(
    source: NativeObjectStoreReadScope,
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
      const manifest = await preflightSourceAccess(() =>
        source.readTreeManifest(treeOid),
      );
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
      for (const blobOid of CURRENT_TREE_FORMAT.referencedBlobOids(manifest)) {
        blobOids.add(blobOid);
      }
    }

    const uniqueBlobOids = [...blobOids];
    const blobProofs = new Map<string, NativeContentProof>();
    await runPool(
      uniqueBlobOids,
      async (blobOid) => {
        let proof: NativeContentProof;
        try {
          proof = await preflightSourceAccess(() =>
            source.verifyContent(blobOid, this.#maxFileBytes),
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
        if (proof.decodedLength > this.#maxFileBytes) {
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
      const manifest = await preflightSourceAccess(() =>
        source.readTreeManifest(treeOid),
      );
      let snapshotBytes = 0;
      for (const entry of manifest.entries) {
        const entryBytes =
          entry.type === "regular"
            ? blobProofs.get(entry.blobOid)?.decodedLength
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
    source: NativeObjectStoreReadScope,
    plan: TreeImportPlan,
    targetScope: ContentRepositoryResolutionScope,
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
            await this.#publishBlobFromStream(
              blobOid,
              proof.decodedLength,
              (sink) =>
                readSource(() =>
                  source.streamVerifiedContent(proof, plan.maxFileBytes, sink),
                ),
              targetScope,
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
      const manifest = await readSource(() => source.readTreeManifest(treeOid));
      const published = await this.#publishCurrentTree(
        manifest,
        ABSOLUTE_TREE_MANIFEST_LIMITS,
        targetScope,
      );
      if (published !== treeOid) {
        throw new ObjectStoreError(
          "object-integrity",
          "imported tree did not preserve its canonical object id",
        );
      }
      await this.#readTreeManifest(treeOid, targetScope);
    }

    // One final collective closure proof avoids retaining every large
    // manifest or re-hashing shared blobs once per historical checkpoint.
    await this.#verifyBlobs(plan.blobOids, undefined, targetScope);
    for (const treeOid of plan.treeOids) {
      await this.#readTreeManifest(treeOid, targetScope);
    }
  }

  async verifyBlobs(blobOids: readonly string[]): Promise<void> {
    return this.#verifyBlobs(blobOids);
  }

  async #verifyBlobs(
    blobOids: readonly string[],
    maxBlobBytes?: number,
    scope?: ContentRepositoryResolutionScope,
  ): Promise<void> {
    if (scope === undefined) {
      return await this.#withResolutionScope((operationScope) =>
        this.#verifyBlobs(blobOids, maxBlobBytes, operationScope),
      );
    }
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
          await this.#verifyContent(
            oid,
            maxBlobBytes ?? this.#maxFileBytes,
            scope,
          );
        },
        VERIFICATION_CONCURRENCY,
      );
    } catch (error) {
      throw asStoreError("blob verification", error);
    }
  }

  /** Authenticate every distinct blob referenced by the entries. */
  async #verifyCurrentClosure(
    manifest: CurrentTreeManifest,
    maxBlobBytes?: number,
    scope?: ContentRepositoryResolutionScope,
  ): Promise<void> {
    await this.#verifyBlobs(
      CURRENT_TREE_FORMAT.referencedBlobOids(manifest),
      maxBlobBytes,
      scope,
    );
  }

  /** Historical reachability is used only while preparing adjacent migration. */
  async #verifyStoredClosure(
    manifest: TreeManifest,
    maxBlobBytes?: number,
    scope?: ContentRepositoryResolutionScope,
  ): Promise<void> {
    await this.#verifyBlobs(
      treeManifestBlobOids(manifest),
      maxBlobBytes,
      scope,
    );
  }

  async #readAuthenticatedTree(
    treeOid: string,
    maxBlobBytes?: number,
    scope?: ContentRepositoryResolutionScope,
  ): Promise<CurrentTreeManifest> {
    if (scope === undefined) {
      return await this.#withResolutionScope((operationScope) =>
        this.#readAuthenticatedTree(treeOid, maxBlobBytes, operationScope),
      );
    }
    const manifest = (await this.#readTreeClosure(treeOid, scope)).manifest;
    await this.#verifyCurrentClosure(manifest, maxBlobBytes, scope);
    return manifest;
  }

  /** Historical authenticated reads exist only for adjacent tree migration. */
  async #readAuthenticatedStoredTree(
    treeOid: string,
    maxBlobBytes?: number,
    scope?: ContentRepositoryResolutionScope,
  ): Promise<TreeManifest> {
    if (scope === undefined) {
      return await this.#withResolutionScope((operationScope) =>
        this.#readAuthenticatedStoredTree(
          treeOid,
          maxBlobBytes,
          operationScope,
        ),
      );
    }
    const manifest = (await this.#readStoredTreeClosure(treeOid, scope))
      .manifest;
    await this.#verifyStoredClosure(manifest, maxBlobBytes, scope);
    return manifest;
  }

  async #publishBlobFromStream(
    oid: string,
    expectedByteLength: number,
    stream: (
      sink: (chunk: Uint8Array) => Promise<void>,
    ) => Promise<{ readonly decodedLength: number }>,
    scope?: ContentRepositoryResolutionScope,
  ): Promise<PublishedContent> {
    let targetFailure: { readonly cause: unknown } | undefined;
    try {
      return await this.#repository.publishContentFromStream(
        oid,
        expectedByteLength,
        async (sink) => {
          const authenticated = await stream(async (chunk) => {
            try {
              await sink(chunk);
            } catch (cause) {
              targetFailure = { cause };
              throw cause;
            }
          });
          if (authenticated.decodedLength !== expectedByteLength) {
            throw new TreeImportSourceError(
              new Error("imported content length changed after preflight"),
            );
          }
        },
        { authenticateSource: true },
        scope,
      );
    } catch (error) {
      if (targetFailure !== undefined) {
        throw targetFailure.cause;
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
    await ensureChildDirectory(layout.objects, parsePath(layout.records).base);
    await ensureChildDirectory(
      layout.records,
      parsePath(layout.contentRecords).base,
    );
    await ensureChildDirectory(
      layout.records,
      parsePath(layout.recipeRecords).base,
    );
    await ensureChildDirectory(layout.objects, parsePath(layout.packs).base);
    await ensureChildDirectory(
      layout.packs,
      parsePath(layout.incomingPacks).base,
    );
    return new FileObjectStore(canonicalRoot, manifestLimits, maxFileBytes);
  } catch (error) {
    throw asStoreError("object-store initialization", error);
  }
}
