import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";

import {
  isNativeObjectShard,
  nativePackPath,
  nativePackShardPath,
  type NativeObjectLayout,
} from "../workspace-store.ts";
import {
  aggregateFailures,
  primaryFailure,
  retainCleanupFailure,
  withRetainedCleanup as withDeterministicCleanup,
} from "../failure-settlement.ts";
import { systemErrorCode } from "../system-error.ts";
import {
  assertWorkspaceWriteAuthority,
  type WorkspaceWriteAuthority,
} from "../workspace-lock.ts";
import {
  buildMultiPackIndexFromViews,
  decodeMultiPackIndex,
  MAX_MULTI_PACK_INDEX_ENTRIES,
  MAX_MULTI_PACK_INDEX_PACKS,
  MULTI_PACK_INDEX_HARD_MAX_BYTES,
  MultiPackIndexError,
  validateMultiPackIndexViews,
  type BuiltMultiPackIndex,
  type MultiPackIndex,
} from "./multi-pack-index.ts";
import {
  authenticatePackPublication,
  DATA_PACK_HARD_MAX_BYTES,
  METADATA_PACK_HARD_MAX_BYTES,
  openAuthenticatedPack,
  parsePackId,
  type AuthenticatedPackIndex,
  type AuthenticatedPackReader,
  type EncodedPack,
  type PackEntryKey,
  type PackId,
  type PackIndexEntry,
  type PackIndexView,
  type PackPositionalReader,
  type PackVerificationOptions,
  PackFormatError,
} from "./pack.ts";
import { Delta1FormatError } from "./pack-delta.ts";
import {
  openPrivateFileIfPresent as openStablePrivateFileIfPresent,
  observePrivateFile as observeStablePrivateFile,
  observePrivateFileIfPresent as observeStablePrivateFileIfPresent,
  privateFileIdentity as identityFor,
  PrivateFileBoundaryError,
  revalidateOpenedPrivateFile,
  sameFileObservation,
  samePrivateFileIdentity as sameCatalogIdentity,
  type OpenedPrivateFile,
  type PrivateFileIdentity,
} from "./private-file.ts";
import type { RecordEnvelope } from "./record.ts";

/** No implicit repository quota; callers may configure an operational bound. */
export const DEFAULT_MAX_PACK_CATALOG_BYTES = Number.MAX_SAFE_INTEGER;
export const DEFAULT_MAX_PACK_CATALOG_INCOMING_FILES = 1_024;
export const DEFAULT_MAX_PACK_CATALOG_INCOMING_BYTES = 512 * 1024 * 1024;

const PACK_FILE = /^[0-9a-f]{62}\.pack$/u;
const UUID_V4 =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const PACK_TEMPORARY = new RegExp(
  `^\\.[0-9a-f]{64}\\.(?:0|[1-9][0-9]*)\\.${UUID_V4}\\.pack\\.tmp$`,
  "u",
);
const MIDX_TEMPORARY = new RegExp(
  `^\\.multi-pack-index\\.(?:0|[1-9][0-9]*)\\.${UUID_V4}\\.tmp$`,
  "u",
);
const PACK_ROOT_MAX_ENTRIES = 256 + 2;
const ABSOLUTE_PACK_MAX_BYTES = Math.max(
  DATA_PACK_HARD_MAX_BYTES,
  METADATA_PACK_HARD_MAX_BYTES,
);
const CATALOG_PACK_HANDLE_TOKEN = Symbol("catalog-pack-handle");

export type PackCatalogErrorCode =
  | "invalid-input"
  | "namespace-invalid"
  | "pack-integrity"
  | "limit-exceeded"
  | "storage-failure";

export class PackCatalogError extends Error {
  readonly code: PackCatalogErrorCode;

  constructor(code: PackCatalogErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PackCatalogError";
    this.code = code;
  }
}

export interface PackCatalogLimits {
  readonly maxPacks?: number;
  readonly maxTotalPackBytes?: number;
  readonly maxIndexEntries?: number;
  readonly maxSinglePackBytes?: number;
  readonly maxIncomingFiles?: number;
  readonly maxIncomingBytes?: number;
}

export interface ResolvedPackCatalogLimits {
  readonly maxPacks: number;
  readonly maxTotalPackBytes: number;
  readonly maxIndexEntries: number;
  readonly maxSinglePackBytes: number;
  readonly maxIncomingFiles: number;
  readonly maxIncomingBytes: number;
}

export type CatalogFileIdentity = PrivateFileIdentity;

declare const CATALOG_PACK_IDENTITY_RECEIPT: unique symbol;

/**
 * Opaque capability proving that a catalog authenticated one exact pack file
 * together with its complete parent-directory chain.
 */
export interface CatalogPackIdentityReceipt {
  readonly [CATALOG_PACK_IDENTITY_RECEIPT]: true;
}

export interface PackCatalogEntry {
  readonly path: string;
  readonly identity: CatalogFileIdentity;
  readonly identityReceipt: CatalogPackIdentityReceipt;
  readonly view: PackIndexView;
}

export type PackCatalogIncomingKind = "pack" | "multi-pack-index";

export interface PackCatalogIncomingEntry {
  readonly kind: PackCatalogIncomingKind;
  readonly name: string;
  readonly path: string;
  readonly identity: CatalogFileIdentity;
}

export interface PackCatalogInventory {
  readonly packs: readonly PackCatalogEntry[];
  readonly views: readonly PackIndexView[];
  readonly incoming: readonly PackCatalogIncomingEntry[];
  readonly totalPackBytes: number;
  readonly totalIndexEntries: number;
  readonly incomingFiles: number;
  readonly incomingBytes: number;
}

export interface PublishedCatalogPack {
  readonly view: PackIndexView;
  readonly identity: CatalogFileIdentity;
  readonly disposition: "existing" | "published";
}

export type MultiPackIndexCacheRead =
  | { readonly kind: "current"; readonly index: MultiPackIndex }
  | { readonly kind: "rebuild"; readonly reason: string };

export type MultiPackIndexHintRead =
  | { readonly kind: "hint"; readonly index: MultiPackIndex }
  | { readonly kind: "rebuild"; readonly reason: string };

interface FileCandidate {
  readonly id: PackId;
  readonly path: string;
  readonly identity: CatalogFileIdentity;
  readonly parents: CatalogDirectoryChain;
}

interface IncomingCandidate {
  readonly entry: PackCatalogIncomingEntry;
  readonly parents: CatalogDirectoryChain;
}

interface NamespaceSnapshot {
  readonly candidates: readonly FileCandidate[];
  readonly incoming: readonly IncomingCandidate[];
  readonly incomingFiles: number;
  readonly incomingBytes: number;
  readonly fingerprint: string;
  readonly packFingerprint: string;
}

interface StableFileRead {
  readonly bytes: Uint8Array;
  readonly identity: CatalogFileIdentity;
}

interface OwnedTemporary {
  readonly path: string;
  readonly identity: CatalogFileIdentity;
}

interface CatalogDirectoryIdentity {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}

type CatalogDirectoryChain = readonly CatalogDirectoryIdentity[];

interface CatalogEntryReceipt {
  readonly owner: object;
  readonly parents: CatalogDirectoryChain;
}

interface CatalogPackIdentityReceiptRecord extends CatalogEntryReceipt {
  readonly identity: CatalogFileIdentity;
}

interface OpenedPackReceipt {
  readonly view: PackIndexView;
  readonly identity: CatalogFileIdentity;
  readonly identityReceipt: CatalogPackIdentityReceipt;
}

function fail(
  code: PackCatalogErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new PackCatalogError(code, message, cause);
}

function rethrowPackReadError(packId: PackId, error: unknown): never {
  const primary = primaryFailure(error);
  if (primary instanceof PackCatalogError) {
    if (primary === error) throw primary;
    fail(primary.code, primary.message, error);
  }
  if (primary instanceof PackFormatError) {
    if (
      primary.code === "invalid-input" ||
      primary.code === "verification-required"
    ) {
      fail("invalid-input", `pack ${packId} read was not admissible`, error);
    }
    fail(
      "pack-integrity",
      `pack ${packId} failed payload authentication`,
      error,
    );
  }
  if (primary instanceof Delta1FormatError) {
    fail("pack-integrity", `pack ${packId} failed delta authentication`, error);
  }
  throw error;
}

function rethrowCatalogPrimary(
  primary: unknown,
  failure: unknown,
  fallbackMessage: string,
): never {
  if (primary instanceof PackCatalogError) {
    if (primary === failure) throw primary;
    fail(primary.code, primary.message, failure);
  }
  fail("storage-failure", fallbackMessage, failure);
}

function rethrowPrivateFileFailure(
  failure: unknown,
  fallbackMessage: string,
): never {
  const primary = primaryFailure(failure);
  if (primary instanceof PrivateFileBoundaryError) {
    fail(primary.code, primary.message, failure);
  }
  rethrowCatalogPrimary(primary, failure, fallbackMessage);
}

function rethrowPackOpenFailure(packId: PackId, failure: unknown): never {
  const primary = primaryFailure(failure);
  if (primary instanceof PackFormatError) {
    fail(
      "pack-integrity",
      `pack ${packId} failed physical authentication`,
      failure,
    );
  }
  rethrowCatalogPrimary(
    primary,
    failure,
    `pack ${packId} could not be authenticated`,
  );
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertBoundedInteger(
  value: number,
  maximum: number,
  label: string,
  allowZero = true,
): void {
  if (
    !Number.isSafeInteger(value) ||
    value < (allowZero ? 0 : 1) ||
    value > maximum
  ) {
    fail(
      "invalid-input",
      `${label} must be ${allowZero ? "a non-negative" : "a positive"} integer no greater than ${maximum}`,
    );
  }
}

function resolveLimits(
  limits: PackCatalogLimits = {},
): ResolvedPackCatalogLimits {
  const resolved: ResolvedPackCatalogLimits = {
    maxPacks: limits.maxPacks ?? MAX_MULTI_PACK_INDEX_PACKS,
    maxTotalPackBytes:
      limits.maxTotalPackBytes ?? DEFAULT_MAX_PACK_CATALOG_BYTES,
    maxIndexEntries: limits.maxIndexEntries ?? MAX_MULTI_PACK_INDEX_ENTRIES,
    maxSinglePackBytes: limits.maxSinglePackBytes ?? ABSOLUTE_PACK_MAX_BYTES,
    maxIncomingFiles:
      limits.maxIncomingFiles ?? DEFAULT_MAX_PACK_CATALOG_INCOMING_FILES,
    maxIncomingBytes:
      limits.maxIncomingBytes ?? DEFAULT_MAX_PACK_CATALOG_INCOMING_BYTES,
  };
  assertBoundedInteger(
    resolved.maxPacks,
    MAX_MULTI_PACK_INDEX_PACKS,
    "maximum pack count",
  );
  assertBoundedInteger(
    resolved.maxTotalPackBytes,
    Number.MAX_SAFE_INTEGER,
    "maximum total pack bytes",
  );
  assertBoundedInteger(
    resolved.maxIndexEntries,
    MAX_MULTI_PACK_INDEX_ENTRIES,
    "maximum pack index entries",
  );
  assertBoundedInteger(
    resolved.maxSinglePackBytes,
    ABSOLUTE_PACK_MAX_BYTES,
    "maximum single pack bytes",
    false,
  );
  assertBoundedInteger(
    resolved.maxIncomingFiles,
    MAX_MULTI_PACK_INDEX_PACKS,
    "maximum incoming file count",
  );
  assertBoundedInteger(
    resolved.maxIncomingBytes,
    Number.MAX_SAFE_INTEGER,
    "maximum incoming bytes",
  );
  return Object.freeze(resolved);
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return sameFileObservation(left, right);
}

function directoryIdentity(
  path: string,
  observation: Stats,
): CatalogDirectoryIdentity {
  return Object.freeze({
    path,
    dev: observation.dev,
    ino: observation.ino,
  });
}

function sameDirectoryIdentity(
  left: CatalogDirectoryIdentity,
  right: Stats,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function directoryFingerprint(identity: CatalogDirectoryIdentity): string {
  return [identity.path, identity.dev, identity.ino].join("\0");
}

async function observeDirectory(path: string): Promise<Stats> {
  let observation: Stats;
  try {
    observation = await lstat(path);
  } catch (error) {
    fail("storage-failure", `could not inspect directory ${path}`, error);
  }
  if (observation.isSymbolicLink() || !observation.isDirectory()) {
    fail("namespace-invalid", `${path} is not a real directory`);
  }
  return observation;
}

async function observeDirectoryIfPresent(
  path: string,
): Promise<Stats | undefined> {
  let observation: Stats;
  try {
    observation = await lstat(path);
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT") return undefined;
    fail("storage-failure", `could not inspect directory ${path}`, error);
  }
  if (observation.isSymbolicLink() || !observation.isDirectory()) {
    fail("namespace-invalid", `${path} is not a real directory`);
  }
  return observation;
}

function assertSameDevice(
  parent: CatalogDirectoryIdentity,
  childPath: string,
  childDevice: number,
): void {
  if (childDevice !== parent.dev) {
    fail("namespace-invalid", `${childPath} crosses a device boundary`);
  }
}

async function observePackNamespaceChain(
  layout: NativeObjectLayout,
): Promise<CatalogDirectoryChain> {
  const root = await observeDirectory(layout.root);
  const objects = await observeDirectory(layout.objects);
  const rootIdentity = directoryIdentity(layout.root, root);
  assertSameDevice(rootIdentity, layout.objects, objects.dev);
  const objectsIdentity = directoryIdentity(layout.objects, objects);
  const packs = await observeDirectory(layout.packs);
  assertSameDevice(objectsIdentity, layout.packs, packs.dev);
  return Object.freeze([
    rootIdentity,
    objectsIdentity,
    directoryIdentity(layout.packs, packs),
  ]);
}

async function observeChildDirectoryChain(
  parents: CatalogDirectoryChain,
  path: string,
): Promise<CatalogDirectoryChain> {
  const parent = parents.at(-1);
  if (parent === undefined) {
    fail("invalid-input", "directory receipt has no parent");
  }
  const child = await observeDirectory(path);
  assertSameDevice(parent, path, child.dev);
  return Object.freeze([...parents, directoryIdentity(path, child)]);
}

async function observeChildDirectoryChainIfPresent(
  parents: CatalogDirectoryChain,
  path: string,
): Promise<CatalogDirectoryChain | undefined> {
  const parent = parents.at(-1);
  if (parent === undefined) {
    fail("invalid-input", "directory receipt has no parent");
  }
  const child = await observeDirectoryIfPresent(path);
  if (child === undefined) return undefined;
  assertSameDevice(parent, path, child.dev);
  return Object.freeze([...parents, directoryIdentity(path, child)]);
}

async function directoryChainStillCurrent(
  expected: CatalogDirectoryChain,
): Promise<boolean> {
  for (const identity of expected) {
    let current: Stats;
    try {
      current = await lstat(identity.path);
    } catch (error) {
      if (systemErrorCode(error) === "ENOENT") return false;
      fail(
        "storage-failure",
        `could not revalidate directory ${identity.path}`,
        error,
      );
    }
    if (current.isSymbolicLink() || !current.isDirectory()) {
      fail("namespace-invalid", `${identity.path} is not a real directory`);
    }
    if (!sameDirectoryIdentity(identity, current)) return false;
  }
  return true;
}

async function assertDirectoryChainCurrent(
  expected: CatalogDirectoryChain,
): Promise<void> {
  if (!(await directoryChainStillCurrent(expected))) {
    fail("namespace-invalid", "pack namespace parent changed after inventory");
  }
}

async function readDirectoryNames(
  path: string,
  maximumEntries: number,
  expected?: CatalogDirectoryIdentity,
): Promise<readonly string[]> {
  const before = await observeDirectory(path);
  if (expected !== undefined && !sameDirectoryIdentity(expected, before)) {
    fail("namespace-invalid", `${path} changed before it was inventoried`);
  }
  const names: string[] = [];
  try {
    const directory = await opendir(path);
    await withDeterministicCleanup(
      async () => {
        for await (const entry of directory) {
          if (names.length >= maximumEntries) {
            fail(
              "limit-exceeded",
              `${path} exceeds its ${maximumEntries}-entry inventory limit`,
            );
          }
          names.push(entry.name);
        }
      },
      async () => {
        await directory.close().catch((error: unknown) => {
          if (systemErrorCode(error) !== "ERR_DIR_CLOSED") throw error;
        });
      },
      `${path} inventory and cleanup both failed`,
    );
  } catch (error) {
    rethrowCatalogPrimary(
      primaryFailure(error),
      error,
      `could not read directory ${path}`,
    );
  }
  const after = await observeDirectory(path);
  if (!sameIdentity(before, after)) {
    fail("namespace-invalid", `${path} changed while it was inventoried`);
  }
  if (expected !== undefined && !sameDirectoryIdentity(expected, after)) {
    fail("namespace-invalid", `${path} changed while it was inventoried`);
  }
  return Object.freeze(names.sort(compareNames));
}

async function observePrivateFile(path: string): Promise<CatalogFileIdentity> {
  try {
    return (await observeStablePrivateFile(path)).identity;
  } catch (error) {
    rethrowPrivateFileFailure(error, `could not inspect file ${path}`);
  }
}

async function observePrivateFileIfPresent(
  path: string,
): Promise<CatalogFileIdentity | undefined> {
  try {
    return (await observeStablePrivateFileIfPresent(path))?.identity;
  } catch (error) {
    rethrowPrivateFileFailure(error, `could not inspect file ${path}`);
  }
}

async function openPrivateFileIfPresent(
  path: string,
  expected?: CatalogFileIdentity,
): Promise<OpenedPrivateFile | undefined> {
  try {
    return await openStablePrivateFileIfPresent(path, expected);
  } catch (error) {
    rethrowPrivateFileFailure(error, `could not open pack file ${path}`);
  }
}

class StableCatalogPackReader implements PackPositionalReader {
  readonly #path: string;
  readonly #handle: FileHandle;
  readonly #observation: Stats;
  readonly #identity: CatalogFileIdentity;
  readonly #parents: CatalogDirectoryChain;
  #closePromise: Promise<void> | undefined;
  #closed = false;

  readonly byteLength: number;

  constructor(input: {
    readonly path: string;
    readonly handle: FileHandle;
    readonly observation: Stats;
    readonly identity: CatalogFileIdentity;
    readonly parents: CatalogDirectoryChain;
  }) {
    this.#path = input.path;
    this.#handle = input.handle;
    this.#observation = input.observation;
    this.#identity = input.identity;
    this.#parents = input.parents;
    this.byteLength = input.observation.size;
  }

  async readExactly(position: number, length: number): Promise<Uint8Array> {
    if (this.#closed) {
      fail("invalid-input", "catalog pack handle is closed");
    }
    if (
      !Number.isSafeInteger(position) ||
      !Number.isSafeInteger(length) ||
      position < 0 ||
      length < 0 ||
      position > this.byteLength ||
      length > this.byteLength - position
    ) {
      fail("invalid-input", "pack read range is outside the opened file");
    }
    // A verified raw payload may transfer ownership of this record frame.
    // allocUnsafeSlow avoids Node's shared small-buffer pool, so callers cannot
    // mutate another positional response through the returned ArrayBuffer.
    const bytes = Buffer.allocUnsafeSlow(length);
    let offset = 0;
    try {
      while (offset < length) {
        const result = await this.#handle.read(
          bytes,
          offset,
          length - offset,
          position + offset,
        );
        if (result.bytesRead === 0) {
          fail("namespace-invalid", `${this.#path} changed while it was read`);
        }
        offset += result.bytesRead;
      }
    } catch (error) {
      if (error instanceof PackCatalogError) throw error;
      fail("storage-failure", `could not read pack file ${this.#path}`, error);
    }
    return bytes;
  }

  async assertCurrent(): Promise<void> {
    if (this.#closed) {
      fail("invalid-input", "catalog pack handle is closed");
    }
    await assertDirectoryChainCurrent(this.#parents);
    try {
      await revalidateOpenedPrivateFile({
        handle: this.#handle,
        observation: this.#observation,
        identity: this.#identity,
      });
    } catch (error) {
      rethrowPrivateFileFailure(
        error,
        `could not revalidate pack ${this.#path}`,
      );
    }
    await assertDirectoryChainCurrent(this.#parents);
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = this.#handle.close();
    return this.#closePromise;
  }
}

type HandleCloseWaiter = {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
};

function handleCloseWaiter(): HandleCloseWaiter {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

/**
 * An authenticated pack bound to the exact file and parent directories that
 * were observed when it was opened. The caller owns this asynchronous scope.
 */
export class CatalogPackHandle {
  readonly #pack: AuthenticatedPackReader;
  readonly #source: StableCatalogPackReader;
  #acceptingReads = true;
  #activeReads = 0;
  #drained: HandleCloseWaiter | undefined;
  #closePromise: Promise<void> | undefined;

  readonly identity: CatalogFileIdentity;
  readonly identityReceipt: CatalogPackIdentityReceipt;
  readonly index: AuthenticatedPackIndex;

  constructor(
    input: {
      readonly pack: AuthenticatedPackReader;
      readonly source: StableCatalogPackReader;
      readonly identity: CatalogFileIdentity;
      readonly identityReceipt: CatalogPackIdentityReceipt;
    },
    token: symbol,
  ) {
    if (token !== CATALOG_PACK_HANDLE_TOKEN) {
      fail(
        "invalid-input",
        "CatalogPackHandle can only be created by PackCatalog",
      );
    }
    this.#pack = input.pack;
    this.#source = input.source;
    this.identity = input.identity;
    this.identityReceipt = input.identityReceipt;
    this.index = input.pack.index;
    Object.freeze(this);
  }

  get packId(): PackId {
    return this.index.packId;
  }

  get packClass() {
    return this.index.packClass;
  }

  get byteLength(): number {
    return this.index.byteLength;
  }

  get entries(): readonly PackIndexEntry[] {
    return this.index.entries;
  }

  lookup(key: PackEntryKey): readonly PackIndexEntry[] {
    return this.index.lookup(key);
  }

  entryForPhysicalOrdinal(physicalOrdinal: number): PackIndexEntry | undefined {
    return this.index.entryForPhysicalOrdinal(physicalOrdinal);
  }

  indexView(): PackIndexView {
    return this.index.indexView();
  }

  async readEnvelope(entry: PackIndexEntry): Promise<RecordEnvelope> {
    try {
      return await this.#withRead(
        async () => await this.#pack.readEnvelope(entry),
      );
    } catch (error) {
      rethrowPackReadError(this.packId, error);
    }
  }

  async readVerified(
    entry: PackIndexEntry,
    options: PackVerificationOptions = {},
  ): Promise<Uint8Array> {
    try {
      return await this.#withRead(
        async () => await this.#pack.readVerified(entry, options),
      );
    } catch (error) {
      rethrowPackReadError(this.packId, error);
    }
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#acceptingReads = false;
    this.#closePromise = (async () => {
      if (this.#activeReads !== 0) {
        this.#drained ??= handleCloseWaiter();
        await this.#drained.promise;
      }
      await this.#pack.close();
    })();
    return this.#closePromise;
  }

  async #withRead<T>(action: () => Promise<T>): Promise<T> {
    if (!this.#acceptingReads) {
      fail("invalid-input", "catalog pack handle is closed");
    }
    this.#activeReads += 1;
    try {
      await this.#source.assertCurrent();
      let actionFailed = false;
      let actionFailure: unknown;
      let result: T | undefined;
      try {
        result = await action();
      } catch (error) {
        actionFailed = true;
        actionFailure = error;
      }
      try {
        await this.#source.assertCurrent();
      } catch (validationError) {
        if (actionFailed) {
          throw aggregateFailures(
            [actionFailure, validationError],
            `pack ${this.packId} read and post-read validation both failed`,
          );
        }
        throw validationError;
      }
      if (actionFailed) throw actionFailure;
      return result as T;
    } finally {
      this.#activeReads -= 1;
      if (this.#activeReads === 0) this.#drained?.resolve();
    }
  }
}

async function readPrivateFileIfPresent(
  path: string,
  maximumBytes: number,
  expected?: CatalogFileIdentity,
): Promise<StableFileRead | undefined> {
  const opened = await openPrivateFileIfPresent(path, expected);
  if (opened === undefined) return undefined;
  try {
    return await withDeterministicCleanup(
      async () => {
        if (opened.observation.size > maximumBytes) {
          fail(
            "limit-exceeded",
            `${path} exceeds its ${maximumBytes}-byte limit`,
          );
        }
        const bytes = Buffer.allocUnsafe(opened.observation.size);
        let offset = 0;
        while (offset < bytes.byteLength) {
          const result = await opened.handle.read(
            bytes,
            offset,
            bytes.byteLength - offset,
            offset,
          );
          if (result.bytesRead === 0) break;
          offset += result.bytesRead;
        }
        const probe = Buffer.allocUnsafe(1);
        const extra = await opened.handle.read(probe, 0, 1, offset);
        if (offset !== bytes.byteLength || extra.bytesRead !== 0) {
          fail("namespace-invalid", `${path} changed while it was read`);
        }
        await revalidateOpenedPrivateFile(opened);
        return {
          bytes: Uint8Array.from(bytes),
          identity: opened.identity,
        };
      },
      () => opened.handle.close(),
      `${path} read and cleanup both failed`,
    );
  } catch (error) {
    rethrowPrivateFileFailure(error, `could not read file ${path}`);
  }
}

async function syncDirectory(
  storeRoot: string,
  path: string,
  authority: WorkspaceWriteAuthority,
  expected?: CatalogDirectoryIdentity,
): Promise<void> {
  const before = await observeDirectory(path);
  if (expected !== undefined && !sameDirectoryIdentity(expected, before)) {
    fail("namespace-invalid", `${path} changed before synchronization`);
  }
  if (process.platform === "win32") return;
  let handle: FileHandle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY |
        (constants.O_DIRECTORY ?? 0) |
        (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    fail("storage-failure", `could not open directory ${path}`, error);
  }
  try {
    await withDeterministicCleanup(
      async () => {
        const observation = await handle.stat();
        if (
          !observation.isDirectory() ||
          !sameIdentity(before, observation) ||
          (expected !== undefined &&
            !sameDirectoryIdentity(expected, observation))
        ) {
          fail("namespace-invalid", `${path} changed while synchronizing`);
        }
        assertWorkspaceWriteAuthority(authority, storeRoot);
        await handle.sync();
        const after = await observeDirectory(path);
        if (
          !sameIdentity(observation, after) ||
          (expected !== undefined && !sameDirectoryIdentity(expected, after))
        ) {
          fail("namespace-invalid", `${path} changed while synchronizing`);
        }
      },
      () => handle.close(),
      `${path} synchronization and cleanup both failed`,
    );
  } catch (error) {
    rethrowCatalogPrimary(
      primaryFailure(error),
      error,
      `could not synchronize directory ${path}`,
    );
  }
}

async function ensureShardDirectory(
  layout: NativeObjectLayout,
  shard: string,
  authority: WorkspaceWriteAuthority,
): Promise<CatalogDirectoryChain> {
  const namespace = await observePackNamespaceChain(layout);
  const path = nativePackShardPath(layout, shard);
  let created = false;
  assertWorkspaceWriteAuthority(authority, layout.root);
  try {
    await mkdir(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (systemErrorCode(error) !== "EEXIST") {
      fail("storage-failure", `could not create pack shard ${path}`, error);
    }
  }
  const chain = await observeChildDirectoryChain(namespace, path);
  await assertDirectoryChainCurrent(chain);
  if (created) {
    await syncDirectory(layout.root, layout.packs, authority, namespace.at(-1));
  }
  return chain;
}

async function createAndSyncTemporary(
  layout: NativeObjectLayout,
  directory: string,
  name: string,
  bytes: Uint8Array,
  parents: CatalogDirectoryChain,
  authority: WorkspaceWriteAuthority,
): Promise<OwnedTemporary> {
  const expectedParent = parents.at(-1);
  if (expectedParent === undefined || expectedParent.path !== directory) {
    fail("invalid-input", "incoming publication has the wrong parent receipt");
  }
  await assertDirectoryChainCurrent(parents);
  const path = join(directory, name);
  let handle: FileHandle;
  assertWorkspaceWriteAuthority(authority, layout.root);
  try {
    handle = await open(
      path,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (error) {
    fail("storage-failure", `could not create incoming file ${path}`, error);
  }
  let writeFailure: unknown;
  let openedIdentity: CatalogFileIdentity | undefined;
  try {
    assertWorkspaceWriteAuthority(authority, layout.root);
    await handle.writeFile(bytes);
    assertWorkspaceWriteAuthority(authority, layout.root);
    await handle.sync();
    openedIdentity = identityFor(path, await handle.stat());
    assertSameDevice(expectedParent, path, openedIdentity.dev);
  } catch (error) {
    writeFailure = error;
  }
  if (openedIdentity === undefined) {
    try {
      openedIdentity = identityFor(path, await handle.stat());
    } catch (error) {
      writeFailure =
        writeFailure === undefined
          ? error
          : aggregateFailures(
              [writeFailure, error],
              `incoming file ${path} write and identity recovery both failed`,
            );
    }
  }
  try {
    await handle.close();
  } catch (error) {
    writeFailure =
      writeFailure === undefined
        ? error
        : aggregateFailures(
            [writeFailure, error],
            `incoming file ${path} write and close both failed`,
          );
  }
  if (writeFailure !== undefined) {
    if (openedIdentity !== undefined) {
      try {
        await removeOwnedTemporary(
          layout,
          path,
          openedIdentity,
          parents,
          authority,
        );
      } catch (cleanupError) {
        writeFailure = aggregateFailures(
          [writeFailure, cleanupError],
          `incoming file ${path} write and safe cleanup both failed`,
        );
      }
    }
    fail(
      "storage-failure",
      `could not durably write incoming file ${path}`,
      writeFailure,
    );
  }
  if (openedIdentity === undefined) {
    fail("storage-failure", `incoming file ${path} lacks an identity`);
  }
  try {
    const identity = await observePrivateFile(path);
    if (
      identity.size !== bytes.byteLength ||
      !sameCatalogIdentity(identity, openedIdentity) ||
      identity.dev !== expectedParent.dev ||
      !(await directoryChainStillCurrent(parents))
    ) {
      fail("namespace-invalid", `${path} changed after it was written`);
    }
    return Object.freeze({ path, identity });
  } catch (error) {
    try {
      await removeOwnedTemporary(
        layout,
        path,
        openedIdentity,
        parents,
        authority,
      );
    } catch (cleanupError) {
      fail(
        "storage-failure",
        `incoming file ${path} failed verification and safe cleanup`,
        aggregateFailures(
          [error, cleanupError],
          `incoming file ${path} verification and safe cleanup both failed`,
        ),
      );
    }
    throw error;
  }
}

async function removeOwnedTemporary(
  layout: NativeObjectLayout,
  path: string,
  expected: CatalogFileIdentity,
  parents: CatalogDirectoryChain,
  authority: WorkspaceWriteAuthority,
): Promise<void> {
  await assertDirectoryChainCurrent(parents);
  let current: Stats;
  try {
    current = await lstat(path);
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT") return;
    fail("storage-failure", `could not inspect incoming file ${path}`, error);
  }
  if (!sameCatalogIdentity(identityFor(path, current), expected)) {
    fail("namespace-invalid", `incoming file ${path} changed before cleanup`);
  }
  assertWorkspaceWriteAuthority(authority, layout.root);
  try {
    await unlink(path);
  } catch (error) {
    if (systemErrorCode(error) !== "ENOENT") {
      fail("storage-failure", `could not remove incoming file ${path}`, error);
    }
  }
}

async function assertPrivateIdentityCurrent(
  path: string,
  expected: CatalogFileIdentity,
  label: string,
): Promise<void> {
  let current: Stats;
  try {
    current = await lstat(path);
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT") {
      fail("namespace-invalid", `${label} disappeared before removal`);
    }
    fail("storage-failure", `could not inspect ${label} before removal`, error);
  }
  if (
    current.isSymbolicLink() ||
    !current.isFile() ||
    current.nlink !== 1 ||
    !sameCatalogIdentity(identityFor(path, current), expected)
  ) {
    fail("namespace-invalid", `${label} changed before removal`);
  }
}

async function unlinkExact(
  layout: NativeObjectLayout,
  path: string,
  label: string,
  authority: WorkspaceWriteAuthority,
): Promise<void> {
  assertWorkspaceWriteAuthority(authority, layout.root);
  try {
    await unlink(path);
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT") {
      fail("namespace-invalid", `${label} disappeared during removal`);
    }
    fail("storage-failure", `could not remove ${label}`, error);
  }
}

function freezeEntry(entry: PackCatalogEntry): PackCatalogEntry {
  return Object.freeze({
    path: entry.path,
    identity: entry.identity,
    identityReceipt: entry.identityReceipt,
    view: entry.view,
  });
}

function samePackIndexView(left: PackIndexView, right: PackIndexView): boolean {
  return (
    left.packId === right.packId &&
    left.packClass === right.packClass &&
    left.byteLength === right.byteLength &&
    left.entries.length === right.entries.length &&
    left.entries.every((entry, index) => {
      const other = right.entries[index];
      return (
        other !== undefined &&
        entry.logicalId === other.logicalId &&
        entry.kind === other.kind &&
        entry.encoding === other.encoding &&
        entry.decodedLength === other.decodedLength &&
        entry.physicalOrdinal === other.physicalOrdinal &&
        entry.offset === other.offset &&
        entry.length === other.length
      );
    })
  );
}

function fingerprintPart(identity: CatalogFileIdentity): string {
  return [
    identity.path,
    identity.dev,
    identity.ino,
    identity.size,
    identity.mode,
    identity.nlink,
    identity.mtimeMs,
    identity.ctimeMs,
  ].join("\0");
}

/**
 * Owns physical pack discovery and cache publication. Every mutating method
 * must run while the caller holds the workspace's exclusive mutation lock.
 * MIDX output is never an object receipt or a deletion authority.
 */
export class PackCatalog {
  readonly #layout: NativeObjectLayout;
  readonly #limits: ResolvedPackCatalogLimits;
  readonly #receiptOwner = Object.freeze({});
  readonly #inventoryPackFingerprints = new WeakMap<object, string>();
  readonly #entryReceipts = new WeakMap<object, CatalogEntryReceipt>();
  readonly #incomingReceipts = new WeakMap<object, CatalogEntryReceipt>();
  readonly #packIdentityReceipts = new WeakMap<
    CatalogPackIdentityReceipt,
    CatalogPackIdentityReceiptRecord
  >();

  constructor(layout: NativeObjectLayout, limits: PackCatalogLimits = {}) {
    this.#layout = layout;
    this.#limits = resolveLimits(limits);
  }

  get limits(): Readonly<ResolvedPackCatalogLimits> {
    return this.#limits;
  }

  async inventory(): Promise<PackCatalogInventory> {
    const before = await this.#namespaceSnapshot();
    const packs: PackCatalogEntry[] = [];
    let totalPackBytes = 0;
    let totalIndexEntries = 0;
    for (const candidate of before.candidates) {
      const handle = await this.#openDiscoveredPack(
        candidate.id,
        candidate.path,
        candidate.identity,
        candidate.parents,
      );
      try {
        await withDeterministicCleanup(
          async () => {
            totalPackBytes += handle.byteLength;
            if (totalPackBytes > this.#limits.maxTotalPackBytes) {
              fail(
                "limit-exceeded",
                `pack inventory exceeds ${this.#limits.maxTotalPackBytes} total bytes`,
              );
            }
            if (
              handle.entries.length >
              this.#limits.maxIndexEntries - totalIndexEntries
            ) {
              fail(
                "limit-exceeded",
                `pack inventory exceeds ${this.#limits.maxIndexEntries} index entries`,
              );
            }
            totalIndexEntries += handle.entries.length;
            const entry = freezeEntry({
              path: candidate.path,
              identity: handle.identity,
              identityReceipt: handle.identityReceipt,
              view: handle.indexView(),
            });
            packs.push(entry);
            this.#entryReceipts.set(entry, {
              owner: this.#receiptOwner,
              parents: candidate.parents,
            });
          },
          () => handle.close(),
          `pack ${candidate.id} inventory and cleanup both failed`,
        );
      } catch (error) {
        rethrowCatalogPrimary(
          primaryFailure(error),
          error,
          `pack ${candidate.id} could not be inventoried`,
        );
      }
    }
    const after = await this.#namespaceSnapshot();
    if (before.fingerprint !== after.fingerprint) {
      fail("namespace-invalid", "pack namespace changed during inventory");
    }

    const frozenPacks = Object.freeze(packs);
    const inventory = Object.freeze({
      packs: frozenPacks,
      views: Object.freeze(frozenPacks.map(({ view }) => view)),
      incoming: Object.freeze(before.incoming.map(({ entry }) => entry)),
      totalPackBytes,
      totalIndexEntries,
      incomingFiles: before.incomingFiles,
      incomingBytes: before.incomingBytes,
    });
    this.#inventoryPackFingerprints.set(inventory, before.packFingerprint);
    for (const candidate of before.incoming) {
      this.#incomingReceipts.set(candidate.entry, {
        owner: this.#receiptOwner,
        parents: candidate.parents,
      });
    }
    return inventory;
  }

  /** Recheck namespace identities without retaining or decoding pack payloads. */
  async inventoryStillCurrent(
    inventory: PackCatalogInventory,
  ): Promise<boolean> {
    const expected = this.#inventoryFingerprint(inventory);
    return (await this.#namespaceSnapshot()).packFingerprint === expected;
  }

  /** Recheck one discovered pathname before a caller relies on its identity. */
  async packIdentityStillCurrent(entry: PackCatalogEntry): Promise<boolean> {
    const receipt = this.#entryReceipt(entry);
    return await this.#packIdentityStillCurrent(
      entry.identity,
      receipt.parents,
    );
  }

  /** Revalidate an opaque pack identity without trusting caller-supplied paths. */
  async packReceiptStillCurrent(
    receipt: CatalogPackIdentityReceipt,
  ): Promise<boolean> {
    const record = this.#packIdentityReceipt(receipt);
    return await this.#packIdentityStillCurrent(
      record.identity,
      record.parents,
    );
  }

  async #packIdentityStillCurrent(
    identity: CatalogFileIdentity,
    parents: CatalogDirectoryChain,
  ): Promise<boolean> {
    if (!(await directoryChainStillCurrent(parents))) return false;
    let current: Stats;
    try {
      current = await lstat(identity.path);
    } catch (error) {
      if (systemErrorCode(error) === "ENOENT") return false;
      fail(
        "storage-failure",
        `could not revalidate pack ${identity.path}`,
        error,
      );
    }
    if (current.isSymbolicLink() || !current.isFile() || current.nlink !== 1) {
      fail(
        "namespace-invalid",
        `pack ${identity.path} is not a private regular file`,
      );
    }
    if (!sameCatalogIdentity(identityFor(identity.path, current), identity)) {
      return false;
    }
    return await directoryChainStillCurrent(parents);
  }

  /**
   * Remove one exact authenticated inventory entry. GC owns all reachability
   * and grace policy; this primitive deliberately leaves MIDX untouched.
   */
  async removePack(
    entry: PackCatalogEntry,
    authority: WorkspaceWriteAuthority,
  ): Promise<void> {
    const receipt = this.#entryReceipt(entry);
    await assertDirectoryChainCurrent(receipt.parents);
    await assertPrivateIdentityCurrent(
      entry.path,
      entry.identity,
      `pack ${entry.view.packId}`,
    );
    await unlinkExact(
      this.#layout,
      entry.path,
      `pack ${entry.view.packId}`,
      authority,
    );
    const shard = receipt.parents.at(-1);
    if (shard === undefined) {
      fail("invalid-input", "pack receipt has no shard directory");
    }
    await syncDirectory(this.#layout.root, shard.path, authority, shard);
  }

  /** Remove one exact incoming receipt; GC still chooses age and eligibility. */
  async removeIncoming(
    entry: PackCatalogIncomingEntry,
    authority: WorkspaceWriteAuthority,
  ): Promise<void> {
    const receipt = this.#incomingReceipt(entry);
    await assertDirectoryChainCurrent(receipt.parents);
    await assertPrivateIdentityCurrent(
      entry.path,
      entry.identity,
      `incoming ${entry.name}`,
    );
    await unlinkExact(
      this.#layout,
      entry.path,
      `incoming ${entry.name}`,
      authority,
    );
    const incoming = receipt.parents.at(-1);
    if (incoming === undefined) {
      fail("invalid-input", "incoming receipt has no parent directory");
    }
    await syncDirectory(this.#layout.root, incoming.path, authority, incoming);
  }

  /**
   * Open one physically authenticated pack as an explicitly owned scope.
   * An MIDX hit is intentionally insufficient; this always authenticates the
   * pack's own checksum, footer, header, and record framing.
   */
  async openPack(packId: string): Promise<CatalogPackHandle | undefined> {
    let id: PackId;
    try {
      id = parsePackId(packId);
    } catch (error) {
      fail("invalid-input", "pack id is not a lowercase SHA-256 digest", error);
    }
    const namespace = await observePackNamespaceChain(this.#layout);
    const shard = nativePackShardPath(this.#layout, id.slice(0, 2));
    const parents = await observeChildDirectoryChainIfPresent(namespace, shard);
    if (parents === undefined) {
      if (!(await directoryChainStillCurrent(namespace))) {
        fail("namespace-invalid", "pack namespace changed during lookup");
      }
      return undefined;
    }
    const path = nativePackPath(this.#layout, id);
    const parent = parents.at(-1);
    if (parent === undefined) {
      fail("invalid-input", "pack open has no shard directory");
    }
    const discovered = await observePrivateFileIfPresent(path);
    if (discovered === undefined) {
      if (!(await directoryChainStillCurrent(parents))) {
        fail("namespace-invalid", "pack namespace changed during lookup");
      }
      return undefined;
    }
    assertSameDevice(parent, path, discovered.dev);
    return await this.#openDiscoveredPack(id, path, discovered, parents);
  }

  async #openPackReceipt(
    packId: string,
    expectedView: PackIndexView,
  ): Promise<OpenedPackReceipt | undefined> {
    const handle = await this.openPack(packId);
    if (handle === undefined) return undefined;
    try {
      return await withDeterministicCleanup(
        async () => {
          const view = handle.indexView();
          if (!samePackIndexView(view, expectedView)) {
            fail(
              "pack-integrity",
              `pack ${packId} does not match its encoded publication view`,
            );
          }
          return Object.freeze({
            view,
            identity: handle.identity,
            identityReceipt: handle.identityReceipt,
          });
        },
        () => handle.close(),
        `pack ${packId} receipt validation and cleanup both failed`,
      );
    } catch (error) {
      rethrowCatalogPrimary(
        primaryFailure(error),
        error,
        `pack ${packId} receipt could not be authenticated`,
      );
    }
  }

  async #syncPackReceipt(
    receipt: OpenedPackReceipt,
    parents: CatalogDirectoryChain,
    authority: WorkspaceWriteAuthority,
  ): Promise<void> {
    const shard = parents.at(-1);
    if (shard === undefined) {
      fail("invalid-input", "pack publication has no shard directory");
    }
    const expectedShard = nativePackShardPath(
      this.#layout,
      receipt.view.packId.slice(0, 2),
    );
    if (shard.path !== expectedShard || receipt.identity.dev !== shard.dev) {
      fail(
        "namespace-invalid",
        `pack ${receipt.view.packId} is outside its authenticated shard`,
      );
    }
    if (!(await this.packReceiptStillCurrent(receipt.identityReceipt))) {
      fail(
        "namespace-invalid",
        `pack ${receipt.view.packId} changed before shard synchronization`,
      );
    }
    await syncDirectory(this.#layout.root, shard.path, authority, shard);
    if (!(await this.packReceiptStillCurrent(receipt.identityReceipt))) {
      fail(
        "namespace-invalid",
        `pack ${receipt.view.packId} changed during shard synchronization`,
      );
    }
  }

  /**
   * Durably publish an encodePack receipt. Callers must not commit metadata
   * until this returns and must hold the exclusive workspace mutation lock.
   */
  async publishPack(
    publication: EncodedPack,
    authority: WorkspaceWriteAuthority,
  ): Promise<PublishedCatalogPack> {
    let verified: ReturnType<typeof authenticatePackPublication>;
    try {
      verified = authenticatePackPublication(publication);
    } catch (error) {
      fail("invalid-input", "pack lacks a valid publication receipt", error);
    }
    if (verified.bytes.byteLength > this.#limits.maxSinglePackBytes) {
      fail(
        "limit-exceeded",
        `pack exceeds the ${this.#limits.maxSinglePackBytes}-byte catalog limit`,
      );
    }
    const expectedView = verified.pack.indexView();

    const inventory = await this.inventory();
    const existingView = inventory.views.find(
      ({ packId }) => packId === verified.pack.packId,
    );
    if (existingView !== undefined) {
      const existing = inventory.packs.find(
        ({ view }) => view.packId === existingView.packId,
      );
      if (existing === undefined) {
        fail("namespace-invalid", "existing inventory receipt is incomplete");
      }
      const reopened = await this.#openPackReceipt(
        verified.pack.packId,
        expectedView,
      );
      if (reopened === undefined) {
        fail(
          "namespace-invalid",
          `existing pack ${verified.pack.packId} disappeared during reauthentication`,
        );
      }
      await this.#syncPackReceipt(
        reopened,
        this.#entryReceipt(existing).parents,
        authority,
      );
      return Object.freeze({
        view: reopened.view,
        identity: reopened.identity,
        disposition: "existing",
      });
    }
    if (inventory.packs.length >= this.#limits.maxPacks) {
      fail(
        "limit-exceeded",
        "publishing this pack exceeds the pack count limit",
      );
    }
    if (
      verified.bytes.byteLength >
      this.#limits.maxTotalPackBytes - inventory.totalPackBytes
    ) {
      fail("limit-exceeded", "publishing this pack exceeds total pack bytes");
    }
    if (
      verified.pack.entries.length >
      this.#limits.maxIndexEntries - inventory.totalIndexEntries
    ) {
      fail("limit-exceeded", "publishing this pack exceeds index entry limits");
    }
    if (
      inventory.incomingFiles >= this.#limits.maxIncomingFiles ||
      verified.bytes.byteLength >
        this.#limits.maxIncomingBytes - inventory.incomingBytes
    ) {
      fail("limit-exceeded", "pack publication exceeds incoming-file limits");
    }

    const shard = verified.pack.packId.slice(0, 2);
    const targetParents = await ensureShardDirectory(
      this.#layout,
      shard,
      authority,
    );
    const targetDirectory = targetParents.at(-1);
    if (targetDirectory === undefined) {
      fail("invalid-input", "pack publication has no target directory");
    }
    const target = nativePackPath(this.#layout, verified.pack.packId);
    const appeared = await this.#openPackReceipt(
      verified.pack.packId,
      expectedView,
    );
    if (appeared !== undefined) {
      fail("namespace-invalid", "pack namespace changed before publication");
    }

    const temporaryName = `.${verified.pack.packId}.${process.pid}.${randomUUID()}.pack.tmp`;
    const incomingParents = await observeChildDirectoryChain(
      await observePackNamespaceChain(this.#layout),
      this.#layout.incomingPacks,
    );
    const temporary = await createAndSyncTemporary(
      this.#layout,
      this.#layout.incomingPacks,
      temporaryName,
      verified.bytes,
      incomingParents,
      authority,
    );
    let renamed = false;
    try {
      await assertDirectoryChainCurrent(targetParents);
      await assertDirectoryChainCurrent(incomingParents);
      await assertPrivateIdentityCurrent(
        temporary.path,
        temporary.identity,
        `incoming pack ${verified.pack.packId}`,
      );
      assertWorkspaceWriteAuthority(authority, this.#layout.root);
      try {
        await rename(temporary.path, target);
        renamed = true;
      } catch (error) {
        fail(
          "storage-failure",
          `could not publish pack ${verified.pack.packId}`,
          error,
        );
      }
      const published = await this.#openPackReceipt(
        verified.pack.packId,
        expectedView,
      );
      if (published === undefined) {
        fail(
          "namespace-invalid",
          "published pack disappeared during verification",
        );
      }
      await assertDirectoryChainCurrent(targetParents);
      await assertDirectoryChainCurrent(incomingParents);
      await this.#syncPackReceipt(published, targetParents, authority);
      await syncDirectory(
        this.#layout.root,
        this.#layout.incomingPacks,
        authority,
        incomingParents.at(-1),
      );
      if (!(await this.packReceiptStillCurrent(published.identityReceipt))) {
        fail(
          "namespace-invalid",
          `pack ${verified.pack.packId} changed while publication was committed`,
        );
      }
      return Object.freeze({
        view: published.view,
        identity: published.identity,
        disposition: "published",
      });
    } catch (error) {
      if (!renamed) {
        try {
          await removeOwnedTemporary(
            this.#layout,
            temporary.path,
            temporary.identity,
            incomingParents,
            authority,
          );
        } catch (cleanupError) {
          fail(
            "storage-failure",
            `pack publication failed and its incoming file could not be removed`,
            aggregateFailures(
              [error, cleanupError],
              "pack publication and incoming-file cleanup both failed",
            ),
          );
        }
      }
      throw error;
    }
  }

  async readMultiPackIndexCache(
    inventory: PackCatalogInventory,
  ): Promise<MultiPackIndexCacheRead> {
    this.#assertInventory(inventory);
    const hint = await this.readMultiPackIndexHint();
    if (hint.kind === "rebuild") return hint;
    const validation = validateMultiPackIndexViews(hint.index, inventory.views);
    if (validation.kind === "stale") {
      return { kind: "rebuild", reason: validation.reason };
    }
    return { kind: "current", index: hint.index };
  }

  /**
   * Read a bounded, checksummed lookup hint without authenticating all packs.
   * A hit must still reopen its target pack and match that pack's footer; a
   * miss is never authoritative and requires one full inventory/rebuild.
   */
  async readMultiPackIndexHint(): Promise<MultiPackIndexHintRead> {
    const parents = await observePackNamespaceChain(this.#layout);
    const packs = parents.at(-1);
    if (packs === undefined) {
      fail("invalid-input", "MIDX read has no pack namespace");
    }
    const discovered = await observePrivateFileIfPresent(
      this.#layout.multiPackIndex,
    );
    if (discovered === undefined) {
      if (!(await directoryChainStillCurrent(parents))) {
        fail("namespace-invalid", "pack namespace changed while reading MIDX");
      }
      return { kind: "rebuild", reason: "MIDX cache is absent" };
    }
    assertSameDevice(packs, this.#layout.multiPackIndex, discovered.dev);
    let read: StableFileRead | undefined;
    try {
      read = await readPrivateFileIfPresent(
        this.#layout.multiPackIndex,
        MULTI_PACK_INDEX_HARD_MAX_BYTES,
        discovered,
      );
    } catch (error) {
      if (
        error instanceof PackCatalogError &&
        error.code === "limit-exceeded"
      ) {
        return { kind: "rebuild", reason: "MIDX cache exceeds its size limit" };
      }
      throw error;
    }
    if (read === undefined) {
      if (!(await directoryChainStillCurrent(parents))) {
        fail("namespace-invalid", "pack namespace changed while reading MIDX");
      }
      return { kind: "rebuild", reason: "MIDX cache is absent" };
    }
    assertSameDevice(packs, this.#layout.multiPackIndex, read.identity.dev);
    if (!(await directoryChainStillCurrent(parents))) {
      fail("namespace-invalid", "pack namespace changed while reading MIDX");
    }
    let index: MultiPackIndex;
    try {
      index = decodeMultiPackIndex(read.bytes);
    } catch (error) {
      if (error instanceof MultiPackIndexError) {
        return { kind: "rebuild", reason: "MIDX cache is corrupt" };
      }
      throw error;
    }
    if (
      index.packs.length > this.#limits.maxPacks ||
      index.entries.length > this.#limits.maxIndexEntries
    ) {
      return {
        kind: "rebuild",
        reason: "MIDX hint exceeds catalog count limits",
      };
    }
    let describedBytes = 0;
    for (const pack of index.packs) {
      if (
        pack.byteLength > this.#limits.maxSinglePackBytes ||
        pack.byteLength > this.#limits.maxTotalPackBytes - describedBytes
      ) {
        return {
          kind: "rebuild",
          reason: "MIDX hint exceeds catalog byte limits",
        };
      }
      describedBytes += pack.byteLength;
    }
    return { kind: "hint", index };
  }

  rebuildMultiPackIndex(inventory: PackCatalogInventory): BuiltMultiPackIndex {
    this.#assertInventory(inventory);
    try {
      return buildMultiPackIndexFromViews(inventory.views);
    } catch (error) {
      if (error instanceof MultiPackIndexError) {
        fail(
          "pack-integrity",
          "authenticated views could not build MIDX",
          error,
        );
      }
      throw error;
    }
  }

  /**
   * Atomically replace the rebuildable cache. The supplied index must describe
   * this catalog's authenticated inventory exactly.
   */
  async publishMultiPackIndexCache(
    built: BuiltMultiPackIndex,
    inventory: PackCatalogInventory,
    authority: WorkspaceWriteAuthority,
  ): Promise<void> {
    this.#assertInventory(inventory);
    const bytes = Uint8Array.from(built.bytes);
    let index: MultiPackIndex;
    try {
      index = decodeMultiPackIndex(bytes);
    } catch (error) {
      fail("invalid-input", "cannot publish an invalid MIDX cache", error);
    }
    const validation = validateMultiPackIndexViews(index, inventory.views);
    if (validation.kind === "stale") {
      fail("invalid-input", `cannot publish stale MIDX: ${validation.reason}`);
    }
    if (
      inventory.incomingFiles >= this.#limits.maxIncomingFiles ||
      bytes.byteLength > this.#limits.maxIncomingBytes - inventory.incomingBytes
    ) {
      fail("limit-exceeded", "MIDX publication exceeds incoming-file limits");
    }

    const temporaryName = `.multi-pack-index.${process.pid}.${randomUUID()}.tmp`;
    const packParents = await observePackNamespaceChain(this.#layout);
    const incomingParents = await observeChildDirectoryChain(
      packParents,
      this.#layout.incomingPacks,
    );
    const temporary = await createAndSyncTemporary(
      this.#layout,
      this.#layout.incomingPacks,
      temporaryName,
      bytes,
      incomingParents,
      authority,
    );
    let renamed = false;
    try {
      await assertDirectoryChainCurrent(packParents);
      await assertDirectoryChainCurrent(incomingParents);
      await assertPrivateIdentityCurrent(
        temporary.path,
        temporary.identity,
        "incoming MIDX",
      );
      assertWorkspaceWriteAuthority(authority, this.#layout.root);
      try {
        await rename(temporary.path, this.#layout.multiPackIndex);
        renamed = true;
      } catch (error) {
        fail("storage-failure", "could not publish MIDX cache", error);
      }
      const reopened = await this.readMultiPackIndexCache(inventory);
      if (reopened.kind !== "current") {
        fail("namespace-invalid", "published MIDX cache failed revalidation");
      }
      await assertDirectoryChainCurrent(packParents);
      await assertDirectoryChainCurrent(incomingParents);
      await syncDirectory(
        this.#layout.root,
        this.#layout.packs,
        authority,
        packParents.at(-1),
      );
      await syncDirectory(
        this.#layout.root,
        this.#layout.incomingPacks,
        authority,
        incomingParents.at(-1),
      );
    } catch (error) {
      if (!renamed) {
        try {
          await removeOwnedTemporary(
            this.#layout,
            temporary.path,
            temporary.identity,
            incomingParents,
            authority,
          );
        } catch (cleanupError) {
          fail(
            "storage-failure",
            "MIDX publication failed and its incoming file could not be removed",
            aggregateFailures(
              [error, cleanupError],
              "MIDX publication and incoming-file cleanup both failed",
            ),
          );
        }
      }
      throw error;
    }
  }

  async #openDiscoveredPack(
    id: PackId,
    path: string,
    expected: CatalogFileIdentity,
    parents: CatalogDirectoryChain,
  ): Promise<CatalogPackHandle> {
    if (expected.size > this.#limits.maxSinglePackBytes) {
      fail(
        "limit-exceeded",
        `pack ${id} exceeds ${this.#limits.maxSinglePackBytes} bytes`,
      );
    }
    const parent = parents.at(-1);
    if (parent === undefined) {
      fail("invalid-input", "pack open has no parent directory");
    }
    assertSameDevice(parent, path, expected.dev);
    await assertDirectoryChainCurrent(parents);
    const opened = await openPrivateFileIfPresent(path, expected);
    if (opened === undefined) {
      fail("namespace-invalid", `pack ${id} disappeared while it was opened`);
    }
    const identity = opened.identity;
    const source = new StableCatalogPackReader({
      path,
      handle: opened.handle,
      observation: opened.observation,
      identity: opened.identity,
      parents,
    });
    try {
      await source.assertCurrent();
    } catch (error) {
      const failure = await retainCleanupFailure(
        error,
        () => source.close(),
        `pack ${id} pre-authentication and cleanup both failed`,
      );
      rethrowPackOpenFailure(id, failure);
    }

    let pack: AuthenticatedPackReader;
    try {
      // openAuthenticatedPack owns and closes the source if authentication
      // fails; do not issue a second close from this layer.
      pack = await openAuthenticatedPack(source, id);
    } catch (error) {
      rethrowPackOpenFailure(id, error);
    }

    try {
      await source.assertCurrent();
      const identityReceipt = this.#createPackIdentityReceipt(
        identity,
        parents,
      );
      return new CatalogPackHandle(
        { pack, source, identity, identityReceipt },
        CATALOG_PACK_HANDLE_TOKEN,
      );
    } catch (error) {
      const failure = await retainCleanupFailure(
        error,
        () => pack.close(),
        `pack ${id} post-authentication and cleanup both failed`,
      );
      rethrowPackOpenFailure(id, failure);
    }
  }

  #assertInventory(inventory: PackCatalogInventory): void {
    this.#inventoryFingerprint(inventory);
  }

  #inventoryFingerprint(inventory: PackCatalogInventory): string {
    const fingerprint = this.#inventoryPackFingerprints.get(inventory);
    if (fingerprint === undefined) {
      fail("invalid-input", "inventory does not belong to this pack catalog");
    }
    return fingerprint;
  }

  #entryReceipt(entry: PackCatalogEntry): CatalogEntryReceipt {
    const receipt = this.#entryReceipts.get(entry);
    if (receipt === undefined || receipt.owner !== this.#receiptOwner) {
      fail("invalid-input", "pack entry does not belong to this catalog");
    }
    return receipt;
  }

  #incomingReceipt(entry: PackCatalogIncomingEntry): CatalogEntryReceipt {
    const receipt = this.#incomingReceipts.get(entry);
    if (receipt === undefined || receipt.owner !== this.#receiptOwner) {
      fail("invalid-input", "incoming entry does not belong to this catalog");
    }
    return receipt;
  }

  #createPackIdentityReceipt(
    identity: CatalogFileIdentity,
    parents: CatalogDirectoryChain,
  ): CatalogPackIdentityReceipt {
    const receipt = Object.freeze({}) as CatalogPackIdentityReceipt;
    this.#packIdentityReceipts.set(receipt, {
      owner: this.#receiptOwner,
      identity,
      parents,
    });
    return receipt;
  }

  #packIdentityReceipt(
    receipt: CatalogPackIdentityReceipt,
  ): CatalogPackIdentityReceiptRecord {
    const record = this.#packIdentityReceipts.get(receipt);
    if (record === undefined || record.owner !== this.#receiptOwner) {
      fail(
        "invalid-input",
        "pack identity receipt does not belong to this catalog",
      );
    }
    return record;
  }

  async #namespaceSnapshot(): Promise<NamespaceSnapshot> {
    const namespace = await observePackNamespaceChain(this.#layout);
    const packsIdentity = namespace.at(-1);
    if (packsIdentity === undefined) {
      fail("invalid-input", "pack namespace receipt is empty");
    }
    const rootNames = await readDirectoryNames(
      this.#layout.packs,
      PACK_ROOT_MAX_ENTRIES,
      packsIdentity,
    );
    const candidates: FileCandidate[] = [];
    const incoming: IncomingCandidate[] = [];
    const namespaceParts = namespace.map(
      (identity) => `dir\0${directoryFingerprint(identity)}`,
    );
    const fingerprint: string[] = [...namespaceParts];
    const packFingerprint: string[] = [...namespaceParts];
    let sawIncoming = false;
    let incomingFiles = 0;
    let incomingBytes = 0;

    for (const name of rootNames) {
      const path = join(this.#layout.packs, name);
      if (name === "incoming") {
        sawIncoming = true;
        const incomingParents = await observeChildDirectoryChain(
          namespace,
          this.#layout.incomingPacks,
        );
        const incomingIdentity = incomingParents.at(-1);
        if (incomingIdentity === undefined) {
          fail("invalid-input", "incoming namespace receipt is empty");
        }
        fingerprint.push(
          `incoming-dir\0${directoryFingerprint(incomingIdentity)}`,
        );
        const incomingNames = await readDirectoryNames(
          this.#layout.incomingPacks,
          this.#limits.maxIncomingFiles,
          incomingIdentity,
        );
        for (const incomingName of incomingNames) {
          const isPack = PACK_TEMPORARY.test(incomingName);
          const isMidx = MIDX_TEMPORARY.test(incomingName);
          if (!isPack && !isMidx) {
            fail(
              "namespace-invalid",
              `unexpected incoming pack entry ${incomingName}`,
            );
          }
          const identity = await observePrivateFile(
            join(this.#layout.incomingPacks, incomingName),
          );
          assertSameDevice(incomingIdentity, identity.path, identity.dev);
          const fileLimit = isPack
            ? this.#limits.maxSinglePackBytes
            : MULTI_PACK_INDEX_HARD_MAX_BYTES;
          if (identity.size > fileLimit) {
            fail(
              "limit-exceeded",
              `incoming file ${incomingName} is oversized`,
            );
          }
          incomingFiles += 1;
          incomingBytes += identity.size;
          if (incomingBytes > this.#limits.maxIncomingBytes) {
            fail(
              "limit-exceeded",
              `incoming files exceed ${this.#limits.maxIncomingBytes} total bytes`,
            );
          }
          fingerprint.push(`incoming\0${fingerprintPart(identity)}`);
          const entry = Object.freeze({
            kind: isPack ? "pack" : "multi-pack-index",
            name: incomingName,
            path: identity.path,
            identity,
          } satisfies PackCatalogIncomingEntry);
          incoming.push(Object.freeze({ entry, parents: incomingParents }));
        }
        continue;
      }
      if (name === "multi-pack-index") {
        const identity = await observePrivateFile(path);
        assertSameDevice(packsIdentity, path, identity.dev);
        fingerprint.push(`midx\0${fingerprintPart(identity)}`);
        continue;
      }
      if (!isNativeObjectShard(name)) {
        fail("namespace-invalid", `unexpected pack namespace entry ${name}`);
      }
      const shardPath = nativePackShardPath(this.#layout, name);
      const shardParents = await observeChildDirectoryChain(
        namespace,
        shardPath,
      );
      const shardIdentity = shardParents.at(-1);
      if (shardIdentity === undefined) {
        fail("invalid-input", "pack shard receipt is empty");
      }
      const shardPart = `shard\0${directoryFingerprint(shardIdentity)}`;
      fingerprint.push(shardPart);
      packFingerprint.push(shardPart);
      const packedNames = await readDirectoryNames(
        shardPath,
        this.#limits.maxPacks + 1,
        shardIdentity,
      );
      for (const packedName of packedNames) {
        if (!PACK_FILE.test(packedName)) {
          fail(
            "namespace-invalid",
            `unexpected entry ${packedName} in pack shard ${name}`,
          );
        }
        if (candidates.length >= this.#limits.maxPacks) {
          fail("limit-exceeded", `pack count exceeds ${this.#limits.maxPacks}`);
        }
        const id = parsePackId(`${name}${packedName.slice(0, -5)}`);
        const packPath = nativePackPath(this.#layout, id);
        const identity = await observePrivateFile(packPath);
        assertSameDevice(shardIdentity, packPath, identity.dev);
        if (identity.size > this.#limits.maxSinglePackBytes) {
          fail(
            "limit-exceeded",
            `pack ${id} exceeds ${this.#limits.maxSinglePackBytes} bytes`,
          );
        }
        candidates.push({
          id,
          path: packPath,
          identity,
          parents: shardParents,
        });
        const part = `pack\0${id}\0${fingerprintPart(identity)}`;
        fingerprint.push(part);
        packFingerprint.push(part);
      }
    }
    if (!sawIncoming) {
      fail(
        "namespace-invalid",
        "pack namespace is missing its incoming directory",
      );
    }
    candidates.sort((left, right) => compareNames(left.id, right.id));
    incoming.sort((left, right) =>
      compareNames(left.entry.name, right.entry.name),
    );
    fingerprint.sort(compareNames);
    packFingerprint.sort(compareNames);
    return Object.freeze({
      candidates: Object.freeze(candidates),
      incoming: Object.freeze(incoming),
      incomingFiles,
      incomingBytes,
      fingerprint: fingerprint.join("\n"),
      packFingerprint: packFingerprint.join("\n"),
    });
  }
}
