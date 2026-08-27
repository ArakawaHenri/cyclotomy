import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";

import {
  isNativeObjectOid,
  nativeLooseRecordPath,
  nativeObjectPath,
  nativeTemporaryObjectName,
  type NativeLooseRecordKind,
  type NativeObjectLayout,
} from "../workspace-store.ts";
import {
  hasRetainedCleanupFailure,
  primaryFailure,
  retainCleanupFailure,
  withRetainedCleanup,
} from "../failure-settlement.ts";
import { systemErrorCode } from "../system-error.ts";
import {
  assertWorkspaceWriteAuthority,
  type WorkspaceWriteAuthority,
} from "../workspace-lock.ts";
import {
  CHUNKED_CONTENT_MIN_BYTES,
  ChunkedContentPlanBuilder,
  MAX_RECIPE_DEPTH,
  MAX_RECIPE_OBJECT_BYTES,
  authenticateChunkRecipeGraph,
  type RecipeGraphLimits,
} from "./chunk-recipe.ts";
import {
  contentIdFromBytes,
  parseContentId,
  parseMetadataId,
  type ContentId,
  type LogicalId,
  type RecipeId,
} from "./ids.ts";
import {
  buildMultiPackIndexFromViews,
  resolveMultiPackIndexEntry,
  type MultiPackIndex,
  type MultiPackIndexEntry,
} from "./multi-pack-index.ts";
import { PackHandlePool, type PackHandleLease } from "./pack-handle-pool.ts";
import {
  MAX_FULL_CONTENT_RECORD_BYTES,
  type PackId,
  type PackIndexEntry,
} from "./pack.ts";
import {
  type CatalogPackHandle,
  DEFAULT_MAX_PACK_CATALOG_BYTES,
  PackCatalog,
  PackCatalogError,
  type PackCatalogInventory,
  type PackCatalogReadEntry,
  type PackCatalogReadInventory,
  type CatalogPackIdentityReceipt,
} from "./pack-catalog.ts";
import {
  openPrivateFileIfPresent as openStablePrivateFileIfPresent,
  PrivateFileBoundaryError,
  revalidateOpenedPrivateFile,
  type OpenedPrivateFile,
  type PrivateFileIdentity as FileIdentity,
} from "./private-file.ts";
import { decodeDelta1Program } from "./pack-delta.ts";
import {
  authenticateFullRecordPayload,
  chunkedContentRecipeId,
  createChunkedContentRecord,
  createContentRecord,
  createRecipeRecord,
  type ChunkedContentRecord,
  type SelfAuthenticatingRecord,
} from "./representation.ts";
import {
  decodeRecord,
  encodeRecord,
  type RecordEncoding,
  type RecordEnvelope,
  type RecordKind,
} from "./record.ts";

const MAX_LOOSE_CONTENT_RECORD_BYTES = 512 * 1024;
const MAX_LOOSE_RECIPE_RECORD_BYTES = 128 * 1024;
const STREAM_BUFFER_BYTES = 64 * 1024;
const MAX_CONTEXT_PACKS = 2;

export type StructuralRecordKind = "root" | "node" | "scope";

export interface ContentRepositoryOptions {
  readonly maxDecodedBytes: number;
  /** Bounds the pack inventory used to rebuild the MIDX hint. */
  readonly maxPackInventoryBytes?: number;
}

export type ContentStreamSink = (chunk: Uint8Array) => Promise<void>;
export type ContentStreamSource = (sink: ContentStreamSink) => Promise<void>;

export interface ContentPublicationOptions {
  /** Import uses this to reauthenticate its source even when target data exists. */
  readonly authenticateSource?: boolean;
}

export type VerifiedObjectLocation =
  | {
      readonly source: "legacy-blob";
      readonly kind: "content";
      readonly logicalId: string;
      readonly encoding: "raw";
      /** Whether this object is part of the logical graph or only this representation. */
      readonly retention: "logical";
    }
  | {
      readonly source: "loose";
      readonly kind: NativeLooseRecordKind;
      readonly logicalId: string;
      readonly encoding: RecordEncoding;
      /** Whether this object is part of the logical graph or only this representation. */
      readonly retention: "logical";
    }
  | {
      readonly source: "pack";
      readonly kind: RecordKind;
      readonly logicalId: string;
      readonly encoding: RecordEncoding;
      /** Pack-local dependencies authenticate the representation but are not roots. */
      readonly retention: "logical" | "pack-local";
      readonly packId: PackId;
      readonly physicalOrdinal: number;
    };

export interface VerifiedContentClosure {
  /** Selected representations, including recipe, chunk and delta-base records. */
  readonly objects: readonly VerifiedObjectLocation[];
}

export interface VerifiedContentRead {
  readonly decodedLength: number;
  readonly closure: VerifiedContentClosure;
}

export interface PublishedContent extends VerifiedContentRead {
  readonly contentId: string;
}

export interface LooseContentMaterialization {
  readonly disposition: "reused" | "published";
  readonly proof: PublishedContent;
}

interface PublishedContentRecord {
  readonly owner: object;
  readonly contentId: string;
  decodedLength: number;
  identities: readonly VerifiedDependencyIdentity[];
}

type VerifiedDependencyIdentity =
  | { readonly source: "file"; readonly identity: FileIdentity }
  | {
      readonly source: "pack";
      readonly receipt: CatalogPackIdentityReceipt;
    };

const publishedContentRecords = new WeakMap<
  PublishedContent,
  PublishedContentRecord
>();
const verifiedClosureIdentities = new WeakMap<
  VerifiedContentClosure,
  readonly VerifiedDependencyIdentity[]
>();

export type ContentRepositoryErrorCode =
  | "invalid-input"
  | "missing-object"
  | "object-integrity"
  | "limit-exceeded"
  | "namespace-invalid"
  | "storage-failure";

export class ContentRepositoryError extends Error {
  readonly code: ContentRepositoryErrorCode;

  constructor(
    code: ContentRepositoryErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ContentRepositoryError";
    this.code = code;
  }
}

function candidateFailureRank(error: unknown): number {
  const primary = primaryFailure(error);
  if (primary instanceof ContentRepositoryError) {
    switch (primary.code) {
      case "namespace-invalid":
        return 5;
      case "storage-failure":
        return 4;
      case "limit-exceeded":
        return 3;
      case "object-integrity":
        return 2;
      case "missing-object":
        return 1;
      case "invalid-input":
        return 0;
    }
  }
  if (primary instanceof PackCatalogError) {
    switch (primary.code) {
      case "namespace-invalid":
        return 5;
      case "storage-failure":
        return 4;
      case "limit-exceeded":
        return 3;
      case "pack-integrity":
        return 2;
      case "invalid-input":
        return 0;
    }
  }
  return 0;
}

function preferredCandidateFailure(
  current: unknown,
  candidate: unknown,
): unknown {
  return current === undefined ||
    candidateFailureRank(candidate) > candidateFailureRank(current)
    ? candidate
    : current;
}

function invalid(message: string, cause?: unknown): never {
  throw new ContentRepositoryError("invalid-input", message, cause);
}

function integrity(message: string, cause?: unknown): never {
  throw new ContentRepositoryError("object-integrity", message, cause);
}

function storage(message: string, cause?: unknown): never {
  throw new ContentRepositoryError("storage-failure", message, cause);
}

function rethrowRepositoryPrimary(primary: unknown, failure: unknown): never {
  if (primary instanceof ContentRepositoryError) {
    if (primary === failure) throw primary;
    throw new ContentRepositoryError(primary.code, primary.message, failure);
  }
  throw failure;
}

async function withDeterministicCleanup<T>(
  action: () => Promise<T>,
  cleanup: () => Promise<void>,
  message: string,
): Promise<T> {
  try {
    return await withRetainedCleanup(action, cleanup, message);
  } catch (error) {
    rethrowRepositoryPrimary(primaryFailure(error), error);
  }
}

function assertLimit(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalid(`${label} must be a non-negative safe integer`);
  }
}

function assertOid(value: string, label: string): void {
  if (!isNativeObjectOid(value)) {
    invalid(`${label} must be a lowercase SHA-256 digest`);
  }
}

/** Only the first lstat ENOENT is an admissible resolver miss. */
async function openPrivateFileIfPresent(
  path: string,
): Promise<OpenedPrivateFile | undefined> {
  try {
    return await openStablePrivateFileIfPresent(path);
  } catch (error) {
    const primary = primaryFailure(error);
    if (
      primary instanceof PrivateFileBoundaryError &&
      primary.code === "namespace-invalid"
    ) {
      integrity("object path changed or is not a private regular file", error);
    }
    storage("could not open object path", error);
  }
}

async function finishPrivateRead(opened: OpenedPrivateFile): Promise<void> {
  try {
    await revalidateOpenedPrivateFile(opened);
  } catch (error) {
    const primary = primaryFailure(error);
    if (
      primary instanceof PrivateFileBoundaryError &&
      primary.code === "namespace-invalid"
    ) {
      integrity("object or its pathname changed while it was read", error);
    }
    storage("could not revalidate object after reading", error);
  }
}

interface PrivateFileRead {
  readonly bytes: Uint8Array;
  readonly identity: FileIdentity;
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.path === right.path &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function readPrivateFileRange(
  opened: OpenedPrivateFile,
  buffer: Uint8Array,
  offset: number,
  length: number,
  position: number,
): Promise<number> {
  try {
    return (await opened.handle.read(buffer, offset, length, position))
      .bytesRead;
  } catch (error) {
    storage("could not read object bytes", error);
  }
}

async function readPrivateFileWithIdentityIfPresent(
  path: string,
  maximumBytes: number,
): Promise<PrivateFileRead | undefined> {
  assertLimit(maximumBytes, "maximum object bytes");
  const opened = await openPrivateFileIfPresent(path);
  if (opened === undefined) return undefined;
  return await withDeterministicCleanup(
    async () => {
      if (opened.observation.size > maximumBytes) {
        throw new ContentRepositoryError(
          "limit-exceeded",
          `object size ${opened.observation.size} exceeds the ${maximumBytes}-byte limit`,
        );
      }
      const bytes = Buffer.allocUnsafe(opened.observation.size);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const bytesRead = await readPrivateFileRange(
          opened,
          bytes,
          offset,
          bytes.byteLength - offset,
          offset,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const probe = Buffer.allocUnsafe(1);
      const extraBytes = await readPrivateFileRange(
        opened,
        probe,
        0,
        1,
        offset,
      );
      if (extraBytes !== 0 || offset !== bytes.byteLength) {
        integrity("object size changed while it was read");
      }
      await finishPrivateRead(opened);
      return {
        bytes: Uint8Array.from(bytes),
        identity: opened.identity,
      };
    },
    () => opened.handle.close(),
    "private object read and cleanup both failed",
  );
}

async function readPrivateFileIfPresent(
  path: string,
  maximumBytes: number,
): Promise<Uint8Array | undefined> {
  return (await readPrivateFileWithIdentityIfPresent(path, maximumBytes))
    ?.bytes;
}

async function streamPrivateFileIfPresent(
  path: string,
  maximumBytes: number,
  sink: ContentStreamSink,
  expectedIdentity?: FileIdentity,
): Promise<
  | {
      readonly digest: string;
      readonly byteLength: number;
      readonly identity: FileIdentity;
    }
  | undefined
> {
  assertLimit(maximumBytes, "maximum object bytes");
  const opened = await openPrivateFileIfPresent(path);
  if (opened === undefined) return undefined;
  return await withDeterministicCleanup(
    async () => {
      if (
        expectedIdentity !== undefined &&
        !sameFileIdentity(opened.identity, expectedIdentity)
      ) {
        integrity("object identity changed before it was streamed");
      }
      if (opened.observation.size > maximumBytes) {
        throw new ContentRepositoryError(
          "limit-exceeded",
          `object size ${opened.observation.size} exceeds the ${maximumBytes}-byte limit`,
        );
      }
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(STREAM_BUFFER_BYTES);
      let offset = 0;
      while (offset < opened.observation.size) {
        const bytesRead = await readPrivateFileRange(
          opened,
          buffer,
          0,
          Math.min(buffer.byteLength, opened.observation.size - offset),
          offset,
        );
        if (bytesRead === 0) integrity("object was truncated while streaming");
        const chunk = Buffer.from(buffer.subarray(0, bytesRead));
        hash.update(chunk);
        offset += bytesRead;
        await sink(chunk);
      }
      const probeBytes = await readPrivateFileRange(
        opened,
        buffer,
        0,
        1,
        offset,
      );
      if (probeBytes !== 0) integrity("object grew while streaming");
      await finishPrivateRead(opened);
      return {
        digest: hash.digest("hex"),
        byteLength: offset,
        identity: opened.identity,
      };
    },
    () => opened.handle.close(),
    "private object stream and cleanup both failed",
  );
}

async function assertDirectory(path: string): Promise<void> {
  let observation: Stats;
  try {
    observation = await lstat(path);
  } catch (error) {
    storage("controlled object-store directory is unavailable", error);
  }
  if (observation.isSymbolicLink() || !observation.isDirectory()) {
    storage("controlled object-store path is not a directory");
  }
}

async function syncDirectory(
  storeRoot: string,
  path: string,
  authority?: WorkspaceWriteAuthority,
): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(
    path,
    constants.O_RDONLY |
      (constants.O_DIRECTORY ?? 0) |
      (constants.O_NOFOLLOW ?? 0),
  );
  await withDeterministicCleanup(
    async () => {
      const stat = await handle.stat();
      if (!stat.isDirectory()) storage("controlled path is not a directory");
      if (authority !== undefined) {
        assertWorkspaceWriteAuthority(authority, storeRoot);
      }
      await handle.sync();
    },
    () => handle.close(),
    "directory synchronization and cleanup both failed",
  );
}

async function ensureChildDirectory(
  storeRoot: string,
  parent: string,
  name: string,
  authority?: WorkspaceWriteAuthority,
): Promise<string> {
  await assertDirectory(parent);
  const path = join(parent, name);
  let created = false;
  if (authority !== undefined) {
    assertWorkspaceWriteAuthority(authority, storeRoot);
  }
  try {
    await mkdir(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (systemErrorCode(error) !== "EEXIST")
      storage("could not create object-store directory", error);
  }
  await assertDirectory(path);
  if (created) await syncDirectory(storeRoot, parent, authority);
  return path;
}

async function unlinkIfPresent(
  storeRoot: string,
  path: string,
  authority?: WorkspaceWriteAuthority,
): Promise<void> {
  if (authority !== undefined) {
    assertWorkspaceWriteAuthority(authority, storeRoot);
  }
  try {
    await unlink(path);
  } catch (error) {
    if (systemErrorCode(error) !== "ENOENT") throw error;
  }
}

async function publishImmutableFile(
  storeRoot: string,
  parent: string,
  target: string,
  temporaryName: string,
  bytes: Uint8Array,
  verifyExisting: () => Promise<void>,
  authority?: WorkspaceWriteAuthority,
): Promise<void> {
  try {
    await verifyExisting();
    await syncDirectory(storeRoot, parent, authority);
    return;
  } catch (error) {
    if (
      !(error instanceof ContentRepositoryError) ||
      error.code !== "missing-object"
    ) {
      throw error;
    }
  }

  const temporary = join(parent, temporaryName);
  let handle: FileHandle | undefined;
  try {
    if (authority !== undefined) {
      assertWorkspaceWriteAuthority(authority, storeRoot);
    }
    handle = await open(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    if (authority !== undefined) {
      assertWorkspaceWriteAuthority(authority, storeRoot);
    }
    await handle.writeFile(bytes);
    if (authority !== undefined) {
      assertWorkspaceWriteAuthority(authority, storeRoot);
    }
    await handle.sync();
    const completedHandle = handle;
    handle = undefined;
    await completedHandle.close();
    try {
      if (authority !== undefined) {
        assertWorkspaceWriteAuthority(authority, storeRoot);
      }
      await rename(temporary, target);
    } catch (renameError) {
      // Windows refuses to rename over a concurrently published object. A
      // winner is acceptable only after the caller authenticates the exact
      // immutable representation that this publication intended to write.
      try {
        await verifyExisting();
      } catch (verificationError) {
        if (
          verificationError instanceof ContentRepositoryError &&
          verificationError.code === "missing-object"
        ) {
          throw renameError;
        }
        throw verificationError;
      }
      await unlinkIfPresent(storeRoot, temporary, authority);
      await syncDirectory(storeRoot, parent, authority);
      return;
    }
    await verifyExisting();
    await syncDirectory(storeRoot, parent, authority);
  } catch (error) {
    let failure = error;
    if (handle !== undefined) {
      const abandonedHandle = handle;
      handle = undefined;
      failure = await retainCleanupFailure(
        failure,
        () => abandonedHandle.close(),
        "immutable publication and file cleanup both failed",
      );
    }
    failure = await retainCleanupFailure(
      failure,
      async () => {
        await unlinkIfPresent(storeRoot, temporary, authority);
      },
      "immutable publication and temporary-file cleanup both failed",
    );
    rethrowRepositoryPrimary(primaryFailure(error), failure);
  }
}

function locationKey(location: VerifiedObjectLocation): string {
  return location.source === "pack"
    ? `pack:${location.packId}:${location.physicalOrdinal}`
    : `${location.source}:${location.kind}:${location.logicalId}`;
}

class ClosureAccumulator {
  readonly #objects = new Map<string, VerifiedObjectLocation>();
  readonly #identities = new Map<string, VerifiedDependencyIdentity>();

  add(
    location: VerifiedObjectLocation,
    identity: FileIdentity,
    packReceipt?: CatalogPackIdentityReceipt,
  ): void {
    const key = locationKey(location);
    const previous = this.#objects.get(key);
    if (previous?.retention !== "logical") {
      this.#objects.set(key, Object.freeze({ ...location }));
    }
    this.#identities.set(
      identity.path,
      location.source === "pack"
        ? packReceipt === undefined
          ? invalid("packed closure location lacks its identity receipt")
          : Object.freeze({ source: "pack", receipt: packReceipt })
        : Object.freeze({ source: "file", identity }),
    );
  }

  merge(other: ClosureAccumulator): void {
    for (const [key, location] of other.#objects) {
      const previous = this.#objects.get(key);
      if (previous?.retention !== "logical") {
        this.#objects.set(key, location);
      }
    }
    for (const [key, identity] of other.#identities) {
      this.#identities.set(key, identity);
    }
  }

  identities(): readonly VerifiedDependencyIdentity[] {
    return [...this.#identities.values()];
  }

  finish(): VerifiedContentClosure {
    const closure = Object.freeze({
      objects: Object.freeze([...this.#objects.values()]),
    });
    verifiedClosureIdentities.set(
      closure,
      Object.freeze([...this.#identities.values()]),
    );
    return closure;
  }
}

interface ResolvedLooseRecord {
  readonly source: "loose";
  readonly envelope: RecordEnvelope;
  readonly location: VerifiedObjectLocation;
  readonly identity: FileIdentity;
}

interface ResolvedLegacyRecord {
  readonly source: "legacy-blob";
  readonly path: string;
  readonly logicalId: ContentId;
  readonly byteLength: number;
  readonly identity: FileIdentity;
}

interface ResolvedPackRecord {
  readonly source: "pack";
  readonly pack: CatalogPackHandle;
  readonly entry: PackIndexEntry;
  readonly envelope: RecordEnvelope;
  readonly location: VerifiedObjectLocation;
  readonly identity: FileIdentity;
  readonly identityReceipt: CatalogPackIdentityReceipt;
  readonly release: () => Promise<void>;
}

type RecordCandidate =
  ResolvedLegacyRecord | ResolvedLooseRecord | ResolvedPackRecord;
type EncodedRecordCandidate = Exclude<RecordCandidate, ResolvedLegacyRecord>;

interface AuthenticatedContentPlan {
  readonly decodedLength: number;
  replay(sink: ContentStreamSink): Promise<void>;
}

interface LoadedPackInventory {
  readonly inventory: PackCatalogInventory | PackCatalogReadInventory;
  readonly index: MultiPackIndex;
  readonly entriesByPackId: ReadonlyMap<string, PackCatalogReadEntry>;
}

interface ResolutionContext {
  packHint?: Promise<MultiPackIndex | undefined>;
  packInventory?: Promise<LoadedPackInventory>;
  packPool?: PackHandlePool;
  closed?: boolean;
}

declare const CONTENT_REPOSITORY_RESOLUTION_SCOPE: unique symbol;

/**
 * Opaque lifetime token for one repository operation. Resolution hints and at
 * most two pack handles may be shared only while this token is
 * open; callers cannot inspect or manufacture its cache state.
 */
export interface ContentRepositoryResolutionScope {
  readonly [CONTENT_REPOSITORY_RESOLUTION_SCOPE]: true;
}

/** Filesystem owner for logical content representations and v3 structures. */
export class ContentRepository {
  readonly #layout: NativeObjectLayout;
  readonly #options: Required<ContentRepositoryOptions>;
  readonly #catalog: PackCatalog;
  readonly #proofOwner = Object.freeze({});
  readonly #loosePublications = new Map<string, Promise<void>>();
  readonly #resolutionScopes = new WeakMap<
    ContentRepositoryResolutionScope,
    ResolutionContext
  >();

  constructor(layout: NativeObjectLayout, options: ContentRepositoryOptions) {
    assertLimit(options.maxDecodedBytes, "maximum decoded bytes");
    if (options.maxDecodedBytes === 0) {
      invalid("maximum decoded bytes must be positive");
    }
    if (options.maxPackInventoryBytes !== undefined) {
      assertLimit(
        options.maxPackInventoryBytes,
        "maximum pack inventory bytes",
      );
    }
    this.#layout = layout;
    this.#options = {
      maxDecodedBytes: options.maxDecodedBytes,
      maxPackInventoryBytes:
        options.maxPackInventoryBytes ?? DEFAULT_MAX_PACK_CATALOG_BYTES,
    };
    this.#catalog = new PackCatalog(layout, {
      maxTotalPackBytes: this.#options.maxPackInventoryBytes,
    });
  }

  get layout(): NativeObjectLayout {
    return this.#layout;
  }

  get maxDecodedBytes(): number {
    return this.#options.maxDecodedBytes;
  }

  openResolutionScope(): ContentRepositoryResolutionScope {
    const scope = Object.freeze({}) as ContentRepositoryResolutionScope;
    this.#resolutionScopes.set(scope, {});
    return scope;
  }

  async closeResolutionScope(
    scope: ContentRepositoryResolutionScope,
  ): Promise<void> {
    const context = this.#resolutionScopes.get(scope);
    if (context === undefined) {
      invalid("resolution scope is closed or belongs to another repository");
    }
    this.#resolutionScopes.delete(scope);
    await this.#closeResolutionContext(context);
  }

  async #withinResolutionScope<T>(
    scope: ContentRepositoryResolutionScope | undefined,
    operation: (context: ResolutionContext) => Promise<T>,
  ): Promise<T> {
    if (scope !== undefined) {
      const context = this.#resolutionScopes.get(scope);
      if (context === undefined || context.closed === true) {
        invalid("resolution scope is closed or belongs to another repository");
      }
      return await operation(context);
    }

    const context: ResolutionContext = {};
    return await withDeterministicCleanup(
      () => operation(context),
      () => this.#closeResolutionContext(context),
      "content resolution and cleanup both failed",
    );
  }

  async #closeResolutionContext(context: ResolutionContext): Promise<void> {
    context.closed = true;
    delete context.packHint;
    delete context.packInventory;
    const pool = context.packPool;
    delete context.packPool;
    if (pool !== undefined) await pool.close();
  }

  async streamContent(
    contentId: string,
    maximumBytes: number,
    sink: ContentStreamSink,
    scope?: ContentRepositoryResolutionScope,
  ): Promise<VerifiedContentRead> {
    assertOid(contentId, "content id");
    assertLimit(maximumBytes, "maximum content bytes");
    return await this.#withinResolutionScope(scope, async (context) => {
      const closure = new ClosureAccumulator();
      const decodedLength = await this.#streamContent(
        parseContentId(contentId),
        Math.min(maximumBytes, this.#options.maxDecodedBytes),
        sink,
        closure,
        context,
        true,
      );
      return Object.freeze({ decodedLength, closure: closure.finish() });
    });
  }

  async publishContentFromStream(
    contentId: string,
    decodedLength: number,
    source: ContentStreamSource,
    options: ContentPublicationOptions = {},
    scope?: ContentRepositoryResolutionScope,
  ): Promise<PublishedContent> {
    assertOid(contentId, "content id");
    assertLimit(decodedLength, "decoded content length");
    if (decodedLength > this.#options.maxDecodedBytes) {
      throw new ContentRepositoryError(
        "limit-exceeded",
        `content length exceeds the ${this.#options.maxDecodedBytes}-byte repository limit`,
      );
    }
    return await this.#withinResolutionScope(scope, async (context) => {
      const expectedId = parseContentId(contentId);

      // Reuse any authenticated representation. Capture performs its own final
      // workspace validation, so an existing object need not reopen the source.
      let existing: PublishedContent | undefined;
      try {
        existing = await this.#authenticateContentRepresentation(
          expectedId,
          decodedLength,
          "any",
          context,
        );
      } catch (error) {
        if (!this.#isOptionalReuseFailure(error)) throw error;
      }
      if (existing !== undefined) {
        if (options.authenticateSource === true) {
          await this.#verifySource(expectedId, decodedLength, source);
        }
        return existing;
      }

      // A damaged pack or legacy copy can be replaced additively. The loose
      // pathname is the publication target itself and must remain immutable.
      try {
        const loose = await this.#authenticateContentRepresentation(
          expectedId,
          decodedLength,
          "loose",
          context,
        );
        if (options.authenticateSource === true) {
          await this.#verifySource(expectedId, decodedLength, source);
        }
        return loose;
      } catch (error) {
        if (
          !(error instanceof ContentRepositoryError) ||
          error.code !== "missing-object"
        ) {
          throw error;
        }
      }

      await this.#publishNewLooseRepresentation(
        expectedId,
        decodedLength,
        source,
        context,
      );
      return await this.#authenticateContentRepresentation(
        expectedId,
        decodedLength,
        "loose",
        context,
      );
    });
  }

  /**
   * Ensure that the logical content has a loose root representation. This is
   * the lazy-migration seam used by maintenance: legacy and packed roots are
   * deliberately ignored, while an existing loose root remains fail-closed.
   */
  async materializeLooseContent(
    contentId: string,
    decodedLength: number,
    source: ContentStreamSource,
    authority: WorkspaceWriteAuthority,
    scope?: ContentRepositoryResolutionScope,
  ): Promise<LooseContentMaterialization> {
    assertOid(contentId, "content id");
    assertLimit(decodedLength, "decoded content length");
    if (decodedLength > this.#options.maxDecodedBytes) {
      throw new ContentRepositoryError(
        "limit-exceeded",
        `content length exceeds the ${this.#options.maxDecodedBytes}-byte repository limit`,
      );
    }
    return await this.#withinResolutionScope(scope, async (context) => {
      const expectedId = parseContentId(contentId);
      let existing: PublishedContent | undefined;
      try {
        existing = await this.#authenticateContentRepresentation(
          expectedId,
          decodedLength,
          "loose",
          context,
        );
      } catch (error) {
        if (
          !(error instanceof ContentRepositoryError) ||
          error.code !== "missing-object"
        ) {
          throw error;
        }
      }
      if (existing !== undefined) {
        await this.#verifySource(expectedId, decodedLength, source);
        return Object.freeze({ disposition: "reused", proof: existing });
      }
      await this.#publishNewLooseRepresentation(
        expectedId,
        decodedLength,
        source,
        context,
        authority,
      );
      const proof = await this.#authenticateContentRepresentation(
        expectedId,
        decodedLength,
        "loose",
        context,
      );
      return Object.freeze({ disposition: "published", proof });
    });
  }

  async ensureRawContent(
    contentId: string,
    bytes: Uint8Array,
    scope?: ContentRepositoryResolutionScope,
  ): Promise<PublishedContent> {
    assertOid(contentId, "content id");
    if (
      bytes.byteLength > this.#options.maxDecodedBytes ||
      contentIdFromBytes(bytes) !== contentId
    ) {
      integrity(
        "raw content does not match its declared id or repository limit",
      );
    }
    return await this.publishContentFromStream(
      contentId,
      bytes.byteLength,
      async (sink) => sink(bytes),
      {},
      scope,
    );
  }

  async readStructural(
    kind: StructuralRecordKind,
    oid: string,
    maximumBytes: number,
    scope?: ContentRepositoryResolutionScope,
  ): Promise<Uint8Array> {
    assertOid(oid, "structural object id");
    assertLimit(maximumBytes, "maximum structural bytes");
    return await this.#withinResolutionScope(scope, (context) =>
      this.#readStructural(kind, oid, maximumBytes, context),
    );
  }

  async #readStructural(
    kind: StructuralRecordKind,
    oid: string,
    maximumBytes: number,
    context: ResolutionContext,
  ): Promise<Uint8Array> {
    let firstFailure: unknown;
    try {
      const raw = await readPrivateFileIfPresent(
        nativeObjectPath(this.#layout, "tree", oid),
        maximumBytes,
      );
      if (raw !== undefined) {
        if (contentIdFromBytes(raw) !== oid) {
          integrity("structural object does not match its id");
        }
        return raw;
      }
    } catch (error) {
      if (!this.#isCandidateFailure(error)) throw error;
      firstFailure = preferredCandidateFailure(firstFailure, error);
    }

    const recordKind = this.#structuralRecordKind(kind);
    try {
      const packed = await this.#findAuthenticatedPackedRecord(
        recordKind,
        parseMetadataId(oid),
        context,
        async (candidate) => {
          if (candidate.envelope.decodedLength > maximumBytes) {
            throw new ContentRepositoryError(
              "limit-exceeded",
              "structural object exceeds its read limit",
            );
          }
          if (
            candidate.envelope.kind !== recordKind ||
            candidate.envelope.logicalId !== oid
          ) {
            integrity("packed structural object has the wrong identity");
          }
          try {
            return await candidate.pack.readVerified(candidate.entry, {
              verifyMetadataId: (_candidateKind, logicalId, decoded) =>
                logicalId === oid && contentIdFromBytes(decoded) === oid,
            });
          } catch (error) {
            integrity("packed structural object failed authentication", error);
          }
        },
      );
      if (packed !== undefined) return packed;
    } catch (error) {
      if (!this.#isCandidateFailure(error)) throw error;
      firstFailure = preferredCandidateFailure(firstFailure, error);
    }

    if (firstFailure !== undefined) throw firstFailure;
    throw new ContentRepositoryError(
      "missing-object",
      "structural object does not exist",
    );
  }

  async publishStructural(
    kind: StructuralRecordKind,
    oid: string,
    bytes: Uint8Array,
    scope?: ContentRepositoryResolutionScope,
  ): Promise<void> {
    assertOid(oid, "structural object id");
    if (contentIdFromBytes(bytes) !== oid) {
      integrity("structural bytes do not match their declared id");
    }
    await this.#withinResolutionScope(scope, async (context) => {
      try {
        const existing = await this.#readStructural(
          kind,
          oid,
          bytes.byteLength,
          context,
        );
        if (!Buffer.from(existing).equals(bytes)) {
          integrity("existing structural object has conflicting bytes");
        }
        return;
      } catch (error) {
        if (!this.#isOptionalReuseFailure(error)) throw error;
      }
      await this.#publishLooseStructuralObject(oid, bytes);
    });
  }

  /** Fast identity check; a drift falls back to full logical authentication. */
  async revalidatePublishedContent(
    proof: PublishedContent,
    maximumBytes: number,
    scope?: ContentRepositoryResolutionScope,
  ): Promise<void> {
    assertLimit(maximumBytes, "maximum content bytes");
    const record = publishedContentRecords.get(proof);
    if (record === undefined || record.owner !== this.#proofOwner) {
      invalid("publication proof does not belong to this repository");
    }
    if (
      record.decodedLength > maximumBytes ||
      record.decodedLength > this.#options.maxDecodedBytes
    ) {
      throw new ContentRepositoryError(
        "limit-exceeded",
        "published content exceeds its revalidation limit",
      );
    }
    if (await this.#identitiesStillMatch(record.identities)) return;

    const verified = await this.streamContent(
      record.contentId,
      maximumBytes,
      async () => undefined,
      scope,
    );
    if (verified.decodedLength !== record.decodedLength) {
      integrity("published content changed its decoded length");
    }
    record.identities = await this.#captureClosureIdentities(verified.closure);
  }

  async #sealPublishedContent(
    proof: PublishedContent,
  ): Promise<PublishedContent> {
    const identities = await this.#captureClosureIdentities(proof.closure);
    publishedContentRecords.set(proof, {
      owner: this.#proofOwner,
      contentId: proof.contentId,
      decodedLength: proof.decodedLength,
      identities,
    });
    return proof;
  }

  async #authenticateContentRepresentation(
    contentId: ContentId,
    decodedLength: number,
    rootSource: "any" | "loose",
    context: ResolutionContext,
  ): Promise<PublishedContent> {
    const closure = new ClosureAccumulator();
    const plan = await this.#authenticateContentPlan(
      contentId,
      decodedLength,
      closure,
      context,
      true,
      rootSource,
    );
    if (!(await this.#identitiesStillMatch(closure.identities()))) {
      integrity("content representation changed during authentication");
    }
    if (plan.decodedLength !== decodedLength) {
      integrity("content has an unexpected decoded length");
    }
    return await this.#sealPublishedContent(
      Object.freeze({
        contentId,
        decodedLength: plan.decodedLength,
        closure: closure.finish(),
      }),
    );
  }

  async #publishNewLooseRepresentation(
    expectedId: ContentId,
    decodedLength: number,
    source: ContentStreamSource,
    context: ResolutionContext,
    authority?: WorkspaceWriteAuthority,
  ): Promise<void> {
    if (decodedLength < CHUNKED_CONTENT_MIN_BYTES) {
      const bytes = Buffer.allocUnsafe(decodedLength);
      let offset = 0;
      await source(async (chunk) => {
        if (chunk.byteLength > decodedLength - offset) {
          integrity("content source exceeded its declared length");
        }
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      });
      if (
        offset !== decodedLength ||
        contentIdFromBytes(bytes) !== expectedId
      ) {
        integrity("content source does not match its declared id and length");
      }
      await this.#publishLooseRecord(
        await createContentRecord(bytes),
        authority,
      );
      return;
    }

    const publishedChunks = new Map<ContentId, number>();
    const publishedRecipes = new Set<RecipeId>();
    const builder = new ChunkedContentPlanBuilder(
      decodedLength,
      this.#recipeLimits(decodedLength),
      {
        content: async (chunk) => {
          const record = await createContentRecord(chunk.bytes);
          if (record.logicalId !== chunk.contentId) {
            integrity("chunk record identity changed during encoding");
          }
          await this.#publishLooseRecord(record, authority);
          publishedChunks.set(chunk.contentId, chunk.length);
        },
        recipe: async (object) => {
          const record = await createRecipeRecord(object.bytes);
          if (record.logicalId !== object.recipeId) {
            integrity("recipe record identity changed during encoding");
          }
          await this.#publishLooseRecord(record, authority);
          publishedRecipes.add(object.recipeId);
        },
      },
    );
    let observedLength = 0;
    await source(async (chunk) => {
      if (chunk.byteLength > decodedLength - observedLength) {
        integrity("content source exceeded its declared length");
      }
      observedLength += chunk.byteLength;
      await builder.push(chunk);
    });
    if (observedLength !== decodedLength) {
      integrity("content source ended before its declared length");
    }
    const plan = await builder.finish();
    if (plan.contentId !== expectedId || plan.decodedLength !== decodedLength) {
      integrity("content source does not match its declared id and length");
    }
    if (plan.kind === "full") {
      if (
        publishedRecipes.size !== 0 ||
        publishedChunks.size !== 1 ||
        publishedChunks.get(plan.contentId) !== plan.decodedLength
      ) {
        integrity("single-chunk publication lost its full-content receipt");
      }
      return;
    }
    const graph = await authenticateChunkRecipeGraph(
      plan.rootId,
      { contentId: expectedId, decodedLength },
      (recipeId) =>
        this.#authenticateRecipe(
          recipeId,
          context,
          new ClosureAccumulator(),
          "loose",
        ),
      this.#recipeLimits(decodedLength),
    );
    if (
      graph.recipeIds.some((id) => !publishedRecipes.has(id)) ||
      graph.chunks.some(
        (chunk) => publishedChunks.get(chunk.contentId) !== chunk.decodedLength,
      )
    ) {
      integrity("published chunked representation lost a dependency receipt");
    }
    await this.#publishLooseRecord(
      createChunkedContentRecord(expectedId, decodedLength, plan.rootId),
      authority,
    );
  }

  async #verifySource(
    expectedId: ContentId,
    expectedLength: number,
    source: ContentStreamSource,
  ): Promise<void> {
    const hash = createHash("sha256");
    let observedLength = 0;
    await source(async (chunk) => {
      if (chunk.byteLength > expectedLength - observedLength) {
        integrity("content source exceeded its declared length");
      }
      observedLength += chunk.byteLength;
      hash.update(chunk);
    });
    if (
      observedLength !== expectedLength ||
      hash.digest("hex") !== expectedId
    ) {
      integrity("content source does not match its declared id and length");
    }
  }

  async #captureClosureIdentities(
    closure: VerifiedContentClosure,
  ): Promise<readonly VerifiedDependencyIdentity[]> {
    const identities = verifiedClosureIdentities.get(closure);
    if (identities === undefined) {
      invalid("content closure was not authenticated by this repository");
    }
    return identities;
  }

  async #identitiesStillMatch(
    identities: readonly VerifiedDependencyIdentity[],
  ): Promise<boolean> {
    for (const dependency of identities) {
      if (dependency.source === "pack") {
        try {
          if (
            !(await this.#catalog.packReceiptStillCurrent(dependency.receipt))
          )
            return false;
        } catch (error) {
          this.#rethrowCatalogError(error);
        }
        continue;
      }
      const expected = dependency.identity;
      let observed: Stats;
      try {
        observed = await lstat(expected.path);
      } catch (error) {
        if (systemErrorCode(error) === "ENOENT") return false;
        storage("could not inspect published content dependency", error);
      }
      if (
        observed.isSymbolicLink() ||
        !observed.isFile() ||
        observed.dev !== expected.dev ||
        observed.ino !== expected.ino ||
        observed.size !== expected.size ||
        observed.mode !== expected.mode ||
        observed.nlink !== expected.nlink ||
        observed.mtimeMs !== expected.mtimeMs ||
        observed.ctimeMs !== expected.ctimeMs
      ) {
        return false;
      }
    }
    return true;
  }

  #recipeLimits(maximumBytes: number): RecipeGraphLimits {
    const maxChunks = Math.min(
      1_000_000,
      Math.ceil(maximumBytes / (16 * 1024)) + 1,
    );
    return Object.freeze({
      maxChunks,
      maxDecodedBytes: maximumBytes,
      maxDepth: MAX_RECIPE_DEPTH,
      maxNodes: Math.min(1_000_000, maxChunks * 2 + MAX_RECIPE_DEPTH),
    });
  }

  #structuralRecordKind(kind: StructuralRecordKind): RecordKind {
    switch (kind) {
      case "root":
        return "tree-root";
      case "node":
        return "tree-node";
      case "scope":
        return "scope";
    }
  }

  async #streamContent(
    contentId: ContentId,
    maximumBytes: number,
    sink: ContentStreamSink,
    closure: ClosureAccumulator,
    context: ResolutionContext,
    allowChunked: boolean,
    rootSource: "any" | "loose" = "any",
  ): Promise<number> {
    const plan = await this.#authenticateContentPlan(
      contentId,
      maximumBytes,
      closure,
      context,
      allowChunked,
      rootSource,
    );
    const identities = closure.identities();
    if (!(await this.#identitiesStillMatch(identities))) {
      integrity("content representation changed before replay");
    }
    await plan.replay(sink);
    if (!(await this.#identitiesStillMatch(identities))) {
      integrity("content representation changed during replay");
    }
    return plan.decodedLength;
  }

  async #authenticateContentPlan(
    contentId: ContentId,
    maximumBytes: number,
    closure: ClosureAccumulator,
    context: ResolutionContext,
    allowChunked: boolean,
    rootSource: "any" | "loose",
  ): Promise<AuthenticatedContentPlan> {
    let firstFailure: unknown;

    if (rootSource === "any") {
      const legacyPath = nativeObjectPath(this.#layout, "blob", contentId);
      try {
        const legacy = await streamPrivateFileIfPresent(
          legacyPath,
          maximumBytes,
          async () => undefined,
        );
        if (legacy !== undefined) {
          if (legacy.digest !== contentId) {
            integrity("legacy blob bytes do not match their content id");
          }
          const candidate: RecordCandidate = Object.freeze({
            source: "legacy-blob",
            path: legacyPath,
            logicalId: contentId,
            byteLength: legacy.byteLength,
            identity: legacy.identity,
          });
          const candidateClosure = new ClosureAccumulator();
          candidateClosure.add(
            {
              source: "legacy-blob",
              kind: "content",
              logicalId: candidate.logicalId,
              encoding: "raw",
              retention: "logical",
            },
            candidate.identity,
          );
          closure.merge(candidateClosure);
          return this.#legacyContentPlan(candidate, maximumBytes);
        }
      } catch (error) {
        if (!this.#isCandidateFailure(error)) throw error;
        firstFailure = preferredCandidateFailure(firstFailure, error);
      }
    }

    try {
      const loose = await this.#readLooseRecord("content", contentId);
      if (loose !== undefined) {
        const candidateClosure = new ClosureAccumulator();
        const plan = await this.#authenticateRecordCandidate(
          loose,
          contentId,
          maximumBytes,
          candidateClosure,
          context,
          allowChunked,
          rootSource,
        );
        closure.merge(candidateClosure);
        return plan;
      }
    } catch (error) {
      if (!this.#isCandidateFailure(error)) throw error;
      firstFailure = preferredCandidateFailure(firstFailure, error);
    }

    if (rootSource === "any") {
      try {
        const packed = await this.#findAuthenticatedPackedRecord(
          "content",
          contentId,
          context,
          async (candidate) => {
            const candidateClosure = new ClosureAccumulator();
            const plan = await this.#authenticateRecordCandidate(
              candidate,
              contentId,
              maximumBytes,
              candidateClosure,
              context,
              allowChunked,
              rootSource,
            );
            return { plan, closure: candidateClosure };
          },
        );
        if (packed !== undefined) {
          closure.merge(packed.closure);
          return packed.plan;
        }
      } catch (error) {
        if (!this.#isCandidateFailure(error)) throw error;
        firstFailure = preferredCandidateFailure(firstFailure, error);
      }
    }

    if (firstFailure !== undefined) throw firstFailure;
    throw new ContentRepositoryError(
      "missing-object",
      `content ${contentId} does not exist`,
    );
  }

  #legacyContentPlan(
    candidate: ResolvedLegacyRecord,
    maximumBytes: number,
  ): AuthenticatedContentPlan {
    return Object.freeze({
      decodedLength: candidate.byteLength,
      replay: async (sink: ContentStreamSink): Promise<void> => {
        const replayed = await streamPrivateFileIfPresent(
          candidate.path,
          maximumBytes,
          sink,
          candidate.identity,
        );
        if (
          replayed === undefined ||
          replayed.byteLength !== candidate.byteLength ||
          replayed.digest !== candidate.logicalId
        ) {
          integrity("legacy blob changed before it was replayed");
        }
      },
    });
  }

  async #authenticateRecordCandidate(
    candidate: EncodedRecordCandidate,
    contentId: ContentId,
    maximumBytes: number,
    closure: ClosureAccumulator,
    context: ResolutionContext,
    allowChunked: boolean,
    rootSource: "any" | "loose",
  ): Promise<AuthenticatedContentPlan> {
    const record = candidate.envelope;
    if (record.decodedLength > maximumBytes) {
      throw new ContentRepositoryError(
        "limit-exceeded",
        `content exceeds the ${maximumBytes}-byte read limit`,
      );
    }
    if (record.kind !== "content" || record.logicalId !== contentId) {
      integrity("resolved content has the wrong namespace identity");
    }

    if (record.encoding === "raw" || record.encoding === "zstd-v1") {
      let decoded: Uint8Array;
      try {
        decoded =
          candidate.source === "pack"
            ? await candidate.pack.readVerified(candidate.entry)
            : await authenticateFullRecordPayload(
                record as SelfAuthenticatingRecord,
              );
      } catch (error) {
        integrity("content record failed authentication", error);
      }
      closure.add(
        candidate.location,
        candidate.identity,
        candidate.source === "pack" ? candidate.identityReceipt : undefined,
      );
      return this.#fullContentPlan(candidate, decoded, context);
    }

    if (record.encoding === "delta1") {
      if (candidate.source !== "pack") {
        integrity("delta1 is only valid inside a pack");
      }
      let decoded: Uint8Array;
      try {
        const program = decodeDelta1Program(
          record.payload,
          record.decodedLength,
        );
        const baseEntry = candidate.pack.entryForPhysicalOrdinal(
          candidate.entry.physicalOrdinal - program.baseBackDistance,
        );
        if (baseEntry === undefined) integrity("delta1 base is unavailable");
        closure.add(
          this.#packLocation(candidate.pack, baseEntry, "pack-local"),
          candidate.identity,
          candidate.identityReceipt,
        );
        decoded = await candidate.pack.readVerified(candidate.entry);
      } catch (error) {
        integrity("delta1 record failed authentication", error);
      }
      closure.add(
        candidate.location,
        candidate.identity,
        candidate.identityReceipt,
      );
      return this.#fullContentPlan(candidate, decoded, context);
    }

    if (!allowChunked) {
      integrity("a chunk recipe referenced another chunked representation");
    }

    const rootId = chunkedContentRecipeId(record as ChunkedContentRecord);
    if (candidate.source === "pack") await candidate.release();
    const graph = await authenticateChunkRecipeGraph(
      rootId,
      { contentId, decodedLength: record.decodedLength },
      (recipeId) =>
        this.#authenticateRecipe(recipeId, context, closure, rootSource),
      this.#recipeLimits(maximumBytes),
    ).catch((error: unknown) => {
      integrity("chunk recipe failed authentication", error);
    });

    const chunks: AuthenticatedContentPlan[] = [];
    const hash = createHash("sha256");
    let decodedLength = 0;
    for (const chunk of graph.chunks) {
      const plan = await this.#authenticateContentPlan(
        chunk.contentId,
        chunk.decodedLength,
        closure,
        context,
        false,
        rootSource,
      );
      if (plan.decodedLength !== chunk.decodedLength) {
        integrity("chunk decoded length does not match its recipe reference");
      }
      await plan.replay(async (bytes) => {
        hash.update(bytes);
        decodedLength += bytes.byteLength;
        if (decodedLength > record.decodedLength) {
          integrity("chunk recipe emitted too many bytes");
        }
      });
      chunks.push(plan);
    }
    if (
      decodedLength !== record.decodedLength ||
      hash.digest("hex") !== contentId
    ) {
      integrity("reconstructed chunks do not match the logical content");
    }
    closure.add(
      candidate.location,
      candidate.identity,
      candidate.source === "pack" ? candidate.identityReceipt : undefined,
    );
    return Object.freeze({
      decodedLength,
      replay: async (sink: ContentStreamSink): Promise<void> => {
        for (const chunk of chunks) await chunk.replay(sink);
      },
    });
  }

  #fullContentPlan(
    candidate: EncodedRecordCandidate,
    authenticatedBytes: Uint8Array,
    context: ResolutionContext,
  ): AuthenticatedContentPlan {
    let cached: Uint8Array | undefined = authenticatedBytes;
    return Object.freeze({
      decodedLength: authenticatedBytes.byteLength,
      replay: async (sink: ContentStreamSink): Promise<void> => {
        const bytes = cached;
        cached = undefined;
        if (bytes !== undefined) {
          await sink(bytes);
          return;
        }
        const replayed = await this.#readExactFullCandidate(candidate, context);
        await sink(replayed);
      },
    });
  }

  async #readExactFullCandidate(
    candidate: EncodedRecordCandidate,
    context: ResolutionContext,
  ): Promise<Uint8Array> {
    if (candidate.source === "loose") {
      const current = await this.#readLooseRecord(
        candidate.envelope.kind as NativeLooseRecordKind,
        candidate.envelope.logicalId as ContentId | RecipeId,
      );
      if (
        current === undefined ||
        !sameFileIdentity(current.identity, candidate.identity) ||
        current.envelope.kind !== "content" ||
        current.envelope.logicalId !== candidate.envelope.logicalId ||
        (current.envelope.encoding !== "raw" &&
          current.envelope.encoding !== "zstd-v1")
      ) {
        integrity("loose content representation changed before replay");
      }
      try {
        return await authenticateFullRecordPayload(
          current.envelope as SelfAuthenticatingRecord,
        );
      } catch (error) {
        integrity("loose content representation failed replay", error);
      }
    }

    const acquired = await this.#acquireContextPack(
      candidate.pack.packId,
      context,
      candidate.identity,
    );
    if (acquired.kind !== "acquired") {
      integrity("packed content representation changed before replay");
    }
    return await withDeterministicCleanup(
      async () => {
        const entry = acquired.lease.handle.entryForPhysicalOrdinal(
          candidate.entry.physicalOrdinal,
        );
        if (
          entry === undefined ||
          !this.#samePackEntry(entry, candidate.entry)
        ) {
          integrity("packed content entry changed before replay");
        }
        try {
          return await acquired.lease.handle.readVerified(entry);
        } catch (error) {
          integrity("packed content representation failed replay", error);
        }
      },
      acquired.lease.release,
      "packed content replay and lease release both failed",
    );
  }

  async #authenticateRecipe(
    recipeId: RecipeId,
    context: ResolutionContext,
    closure: ClosureAccumulator,
    rootSource: "any" | "loose" = "any",
  ): Promise<Uint8Array> {
    let firstFailure: unknown;
    try {
      const loose = await this.#readLooseRecord("recipe", recipeId);
      if (loose !== undefined) {
        const candidateClosure = new ClosureAccumulator();
        const bytes = await this.#authenticateRecipeCandidate(
          loose,
          recipeId,
          candidateClosure,
        );
        closure.merge(candidateClosure);
        return bytes;
      }
    } catch (error) {
      if (!this.#isCandidateFailure(error)) throw error;
      firstFailure = preferredCandidateFailure(firstFailure, error);
    }

    if (rootSource === "any") {
      try {
        const packed = await this.#findAuthenticatedPackedRecord(
          "recipe",
          recipeId,
          context,
          async (candidate) => {
            const candidateClosure = new ClosureAccumulator();
            const bytes = await this.#authenticateRecipeCandidate(
              candidate,
              recipeId,
              candidateClosure,
            );
            return { bytes, closure: candidateClosure };
          },
        );
        if (packed !== undefined) {
          closure.merge(packed.closure);
          return packed.bytes;
        }
      } catch (error) {
        if (!this.#isCandidateFailure(error)) throw error;
        firstFailure = preferredCandidateFailure(firstFailure, error);
      }
    }
    if (firstFailure !== undefined) throw firstFailure;
    throw new ContentRepositoryError(
      "missing-object",
      `recipe ${recipeId} does not exist`,
    );
  }

  async #authenticateRecipeCandidate(
    candidate: EncodedRecordCandidate,
    recipeId: RecipeId,
    closure: ClosureAccumulator,
  ): Promise<Uint8Array> {
    if (
      candidate.envelope.kind !== "recipe" ||
      candidate.envelope.logicalId !== recipeId ||
      (candidate.envelope.encoding !== "raw" &&
        candidate.envelope.encoding !== "zstd-v1")
    ) {
      integrity("recipe does not have a full representation");
    }
    let bytes: Uint8Array;
    try {
      bytes =
        candidate.source === "pack"
          ? await candidate.pack.readVerified(candidate.entry)
          : await authenticateFullRecordPayload(
              candidate.envelope as SelfAuthenticatingRecord,
            );
    } catch (error) {
      integrity("recipe record failed authentication", error);
    }
    closure.add(
      candidate.location,
      candidate.identity,
      candidate.source === "pack" ? candidate.identityReceipt : undefined,
    );
    return bytes;
  }

  async #readLooseRecord(
    kind: NativeLooseRecordKind,
    logicalId: ContentId | RecipeId,
  ): Promise<ResolvedLooseRecord | undefined> {
    const path = nativeLooseRecordPath(this.#layout, kind, logicalId);
    let read: PrivateFileRead | undefined;
    try {
      read = await readPrivateFileWithIdentityIfPresent(
        path,
        kind === "content"
          ? MAX_LOOSE_CONTENT_RECORD_BYTES
          : MAX_LOOSE_RECIPE_RECORD_BYTES,
      );
    } catch (error) {
      if (
        error instanceof ContentRepositoryError &&
        error.code === "limit-exceeded"
      ) {
        integrity("loose record exceeds its representation limit", error);
      }
      throw error;
    }
    if (read === undefined) return undefined;
    let envelope: RecordEnvelope;
    try {
      envelope = decodeRecord(read.bytes, {
        // Envelope decoding is a durable-format operation. A caller's
        // admission limit is applied by #streamContent only after this valid
        // representation has been identified, preserving limit taxonomy.
        maxDecodedBytes:
          kind === "content"
            ? this.#options.maxDecodedBytes
            : MAX_RECIPE_OBJECT_BYTES,
        maxPayloadBytes:
          kind === "content"
            ? MAX_LOOSE_CONTENT_RECORD_BYTES
            : MAX_LOOSE_RECIPE_RECORD_BYTES,
      });
    } catch (error) {
      integrity("loose record is not canonically encoded", error);
    }
    if (envelope.kind !== kind || envelope.logicalId !== logicalId) {
      integrity("loose record does not match its namespace identity");
    }
    try {
      if (envelope.kind === "content") {
        if (
          (envelope.encoding === "raw" || envelope.encoding === "zstd-v1") &&
          envelope.decodedLength > MAX_FULL_CONTENT_RECORD_BYTES
        ) {
          integrity("loose full content exceeds its representation limit");
        }
        if (envelope.encoding === "chunked-v1") {
          if (envelope.decodedLength < CHUNKED_CONTENT_MIN_BYTES) {
            integrity(
              "loose chunked content is below its representation limit",
            );
          }
          chunkedContentRecipeId(envelope as ChunkedContentRecord);
        }
        if (envelope.encoding === "delta1") {
          integrity("loose delta1 record has no pack-local base");
        }
      } else {
        if (
          (envelope.encoding !== "raw" && envelope.encoding !== "zstd-v1") ||
          envelope.decodedLength > MAX_RECIPE_OBJECT_BYTES ||
          envelope.payload.byteLength > MAX_RECIPE_OBJECT_BYTES
        ) {
          integrity("loose recipe violates its representation limits");
        }
      }
    } catch (error) {
      if (error instanceof ContentRepositoryError) throw error;
      integrity("loose record violates its representation policy", error);
    }
    return {
      source: "loose",
      envelope,
      location: Object.freeze({
        source: "loose",
        kind: envelope.kind,
        logicalId,
        encoding: envelope.encoding,
        retention: "logical",
      }),
      identity: read.identity,
    };
  }

  async #findAuthenticatedPackedRecord<T>(
    kind: RecordKind,
    logicalId: LogicalId,
    context: ResolutionContext,
    authenticate: (candidate: ResolvedPackRecord) => Promise<T>,
  ): Promise<T | undefined> {
    const seen = new Set<string>();
    try {
      if (context.packInventory === undefined) {
        context.packHint ??= this.#readPackHint();
        const hint = await context.packHint;
        if (hint !== undefined) {
          const hinted = await this.#tryPackCandidates(
            hint,
            hint.lookup({ kind, logicalId }),
            context,
            seen,
            authenticate,
            undefined,
          );
          if (hinted !== undefined) return hinted;
        }
      }

      context.packInventory ??= this.#loadPackInventory();
      const routing = await context.packInventory;
      const routed = await this.#tryPackCandidates(
        routing.index,
        routing.index.lookup({ kind, logicalId }),
        context,
        seen,
        authenticate,
        routing.entriesByPackId,
      );
      if (routed !== undefined) return routed;

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const inventory = await this.#loadAuthenticatedPackInventory();
        let authoritativeFailure: unknown;
        const authenticated = await this.#tryPackCandidates(
          inventory.index,
          inventory.index.lookup({ kind, logicalId }),
          context,
          new Set(),
          authenticate,
          inventory.entriesByPackId,
          (error) => {
            authoritativeFailure = preferredCandidateFailure(
              authoritativeFailure,
              error,
            );
          },
        );
        if (authenticated !== undefined) return authenticated;
        if (await this.#catalog.inventoryStillCurrent(inventory.inventory)) {
          if (authoritativeFailure !== undefined) throw authoritativeFailure;
          return undefined;
        }
      }
      integrity("pack namespace did not stabilize while resolving an object");
    } catch (error) {
      this.#rethrowCatalogError(error);
    }
  }

  async #resolvedPackRecord(
    lease: PackHandleLease,
    entry: PackIndexEntry,
  ): Promise<ResolvedPackRecord> {
    const { handle } = lease;
    try {
      return {
        source: "pack",
        pack: handle,
        entry,
        envelope: await handle.readEnvelope(entry),
        location: this.#packLocation(handle, entry),
        identity: handle.identity,
        identityReceipt: handle.identityReceipt,
        release: lease.release,
      };
    } catch (error) {
      const failure = await retainCleanupFailure(
        error,
        lease.release,
        "pack record resolution and lease release both failed",
      );
      rethrowRepositoryPrimary(primaryFailure(error), failure);
    }
  }

  #packLocation(
    pack: CatalogPackHandle,
    entry: PackIndexEntry,
    retention: VerifiedObjectLocation["retention"] = "logical",
  ): VerifiedObjectLocation {
    return Object.freeze({
      source: "pack",
      kind: entry.kind,
      logicalId: entry.logicalId,
      encoding: entry.encoding,
      retention,
      packId: pack.packId,
      physicalOrdinal: entry.physicalOrdinal,
    });
  }

  async #readPackHint(): Promise<MultiPackIndex | undefined> {
    const read = await this.#catalog.readMultiPackIndexHint();
    return read.kind === "hint" ? read.index : undefined;
  }

  #indexPackInventory(
    inventory: PackCatalogInventory | PackCatalogReadInventory,
  ): LoadedPackInventory {
    const index = buildMultiPackIndexFromViews(inventory.views).index;
    return {
      inventory,
      index,
      entriesByPackId: new Map(
        inventory.packs.map((entry) => [entry.view.packId, entry]),
      ),
    };
  }

  async #loadPackInventory(): Promise<LoadedPackInventory> {
    return this.#indexPackInventory(await this.#catalog.readInventory());
  }

  async #loadAuthenticatedPackInventory(): Promise<LoadedPackInventory> {
    return this.#indexPackInventory(await this.#catalog.inventory());
  }

  async #tryPackCandidates<T>(
    index: MultiPackIndex,
    candidates: readonly MultiPackIndexEntry[],
    context: ResolutionContext,
    seen: Set<string>,
    authenticate: (candidate: ResolvedPackRecord) => Promise<T>,
    entriesByPackId?: ReadonlyMap<string, PackCatalogReadEntry>,
    recordFailure?: (error: unknown) => void,
  ): Promise<T | undefined> {
    for (const candidate of candidates) {
      const candidateKey = `${candidate.packId}:${candidate.physicalOrdinal}`;
      if (seen.has(candidateKey)) continue;
      seen.add(candidateKey);
      const expected = entriesByPackId?.get(candidate.packId);
      if (entriesByPackId !== undefined && expected === undefined) {
        integrity("pack index refers to an absent inventory entry");
      }
      let acquired;
      try {
        acquired = await this.#acquireContextPack(
          candidate.packId,
          context,
          expected?.identity,
        );
      } catch (error) {
        if (!this.#isPackCandidateFailure(error)) throw error;
        recordFailure?.(error);
        await context.packPool?.invalidate(candidate.packId);
        continue;
      }
      if (acquired.kind !== "acquired") {
        await context.packPool?.invalidate(candidate.packId);
        continue;
      }
      let handedOff = false;
      try {
        const { handle } = acquired.lease;
        const location = resolveMultiPackIndexEntry(
          index,
          candidate,
          new Map([[handle.packId, handle]]),
        );
        if (location.kind === "stale") {
          await context.packPool?.invalidate(candidate.packId);
          continue;
        }
        handedOff = true;
        try {
          const resolved = await this.#resolvedPackRecord(
            acquired.lease,
            location.packEntry,
          );
          const result = await authenticate(resolved);
          await resolved.release();
          return result;
        } catch (error) {
          if (!this.#isPackCandidateFailure(error)) throw error;
          recordFailure?.(error);
          handedOff = false;
          await context.packPool?.invalidate(candidate.packId);
          const settled = await retainCleanupFailure(
            error,
            acquired.lease.release,
            "pack candidate rejection and lease release both failed",
          );
          handedOff = true;
          if (settled !== error) {
            rethrowRepositoryPrimary(primaryFailure(error), settled);
          }
        }
      } finally {
        if (!handedOff) await acquired.lease.release();
      }
    }
    return undefined;
  }

  #isCandidateFailure(error: unknown): boolean {
    if (hasRetainedCleanupFailure(error)) return false;
    const primary = primaryFailure(error);
    return (
      primary instanceof ContentRepositoryError &&
      primary.code !== "invalid-input"
    );
  }

  #isOptionalReuseFailure(error: unknown): boolean {
    return this.#isCandidateFailure(error);
  }

  #isPackCandidateFailure(error: unknown): boolean {
    if (hasRetainedCleanupFailure(error)) return false;
    const primary = primaryFailure(error);
    return (
      this.#isCandidateFailure(primary) ||
      (primary instanceof PackCatalogError && primary.code !== "invalid-input")
    );
  }

  #samePackEntry(left: PackIndexEntry, right: PackIndexEntry): boolean {
    return (
      left.logicalId === right.logicalId &&
      left.kind === right.kind &&
      left.encoding === right.encoding &&
      left.decodedLength === right.decodedLength &&
      left.physicalOrdinal === right.physicalOrdinal &&
      left.offset === right.offset &&
      left.length === right.length
    );
  }

  async #acquireContextPack(
    packId: PackId,
    context: ResolutionContext,
    expectedIdentity?: FileIdentity,
  ) {
    if (context.closed === true) {
      invalid("resolution scope closed while resolving a packed object");
    }
    context.packPool ??= new PackHandlePool(
      this.#catalog,
      MAX_CONTEXT_PACKS,
      "logical-read",
    );
    return await context.packPool.acquire(packId, expectedIdentity);
  }

  #rethrowCatalogError(error: unknown): never {
    const primary = primaryFailure(error);
    if (!(primary instanceof PackCatalogError)) throw error;
    const code: ContentRepositoryErrorCode =
      primary.code === "pack-integrity" ? "object-integrity" : primary.code;
    throw new ContentRepositoryError(code, primary.message, error);
  }

  async #publishLooseRecord(
    record: RecordEnvelope,
    authority?: WorkspaceWriteAuthority,
  ): Promise<void> {
    if (record.kind !== "content" && record.kind !== "recipe") {
      invalid("only content and recipe records have loose namespaces");
    }
    if (record.encoding === "delta1") {
      invalid("delta1 records can only be published inside packs");
    }
    const kind: NativeLooseRecordKind = record.kind;
    const shard = record.logicalId.slice(0, 2);
    const namespace =
      kind === "content"
        ? this.#layout.contentRecords
        : this.#layout.recipeRecords;
    const parent = await ensureChildDirectory(
      this.#layout.root,
      namespace,
      shard,
      authority,
    );
    const target = nativeLooseRecordPath(this.#layout, kind, record.logicalId);
    const encoded = encodeRecord(record);
    const verifyExisting = async (): Promise<void> => {
      const observed = await this.#readLooseRecord(kind, record.logicalId);
      if (observed === undefined) {
        throw new ContentRepositoryError(
          "missing-object",
          "loose record does not exist",
        );
      }
      if (
        observed.envelope.encoding === "raw" ||
        observed.envelope.encoding === "zstd-v1"
      ) {
        try {
          await authenticateFullRecordPayload(
            observed.envelope as SelfAuthenticatingRecord,
          );
        } catch (error) {
          integrity("published loose record failed authentication", error);
        }
        return;
      }
      if (!Buffer.from(encodeRecord(observed.envelope)).equals(encoded)) {
        integrity("existing loose record uses a conflicting representation");
      }
    };
    const publicationKey = `${kind}:${record.logicalId}`;
    const preceding = this.#loosePublications.get(publicationKey);
    if (preceding !== undefined) {
      await preceding;
      await verifyExisting();
      return;
    }

    const publication = publishImmutableFile(
      this.#layout.root,
      parent,
      target,
      nativeTemporaryObjectName(record.logicalId, process.pid, randomUUID()),
      encoded,
      verifyExisting,
      authority,
    );
    this.#loosePublications.set(publicationKey, publication);
    try {
      await publication;
    } finally {
      if (this.#loosePublications.get(publicationKey) === publication) {
        this.#loosePublications.delete(publicationKey);
      }
    }
  }

  async #publishLooseStructuralObject(
    oid: string,
    bytes: Uint8Array,
  ): Promise<void> {
    const parent = await ensureChildDirectory(
      this.#layout.root,
      this.#layout.trees,
      oid.slice(0, 2),
    );
    const target = nativeObjectPath(this.#layout, "tree", oid);
    const verifyExisting = async (): Promise<void> => {
      const observed = await readPrivateFileIfPresent(target, bytes.byteLength);
      if (observed === undefined) {
        throw new ContentRepositoryError(
          "missing-object",
          "structural object does not exist",
        );
      }
      if (
        observed.byteLength !== bytes.byteLength ||
        contentIdFromBytes(observed) !== oid ||
        !Buffer.from(observed).equals(bytes)
      ) {
        integrity("existing structural object is corrupt");
      }
    };
    await publishImmutableFile(
      this.#layout.root,
      parent,
      target,
      nativeTemporaryObjectName(oid, process.pid, randomUUID()),
      bytes,
      verifyExisting,
    );
  }
}
