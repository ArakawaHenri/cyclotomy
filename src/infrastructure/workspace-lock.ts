import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  type BigIntStats,
} from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import type { CleanupSettlement } from "../domain/cleanup-settlement.ts";
import {
  assertDirectoryStillBound,
  bindDirectory,
  compareDirectoryBindings,
  DirectoryBindingError,
  sameDirectoryBinding,
  type DirectoryBinding,
} from "./directory-binding.ts";
import {
  lockProtocolMarkerMatches,
  LockProtocolCorruptError,
  publishLockProtocolMarker,
  readLockProtocolMarkerSync,
  UnsupportedLockProtocolError,
  WORKSPACE_LOCK_FILE,
  type NativeLockProtocolMarker,
  type LockProtocolMarkerObservation,
} from "./lock-protocol.ts";
import {
  loadExclusiveFileLock,
  type ExclusiveFileLockBinding,
} from "./native-file-lock.ts";
import { systemErrorCode } from "./system-error.ts";

export {
  LOCK_PROTOCOL_MARKER_FILE,
  lockProtocolMarkerPath,
  LockProtocolCorruptError,
  readLockProtocolMarkerSync,
  UnsupportedLockProtocolError,
  WORKSPACE_LOCK_FILE,
} from "./lock-protocol.ts";
export type {
  LockProtocolMarkerObservation,
  NativeLockProtocolMarker,
} from "./lock-protocol.ts";
export {
  NativeFileLockUnavailableError,
  type ExclusiveFileLockBinding,
} from "./native-file-lock.ts";

const LEGACY_OWNER_PREFIX = "owner-";
const LEGACY_OWNER_SUFFIX = ".json";
const LEGACY_OWNER_FILE_MAX_BYTES = 16 * 1024;
const LOCK_POLL_MS = 25;

export interface WorkspaceLockOptions {
  /** Time to wait for another cooperative operation. Default 5 seconds. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface WorkspaceLock {
  readonly operation: string;
  readonly acquiredAt: number;
  release(): Promise<void>;
}

declare const WORKSPACE_WRITE_AUTHORITY: unique symbol;

/** Opaque, root-bound authority for writes during one workspace-lock action. */
export interface WorkspaceWriteAuthority {
  readonly [WORKSPACE_WRITE_AUTHORITY]: true;
}

/** Owner record of the legacy directory protocol, for diagnostics only. */
export interface LegacyWorkspaceLockOwner {
  readonly token: string;
  readonly pid: number;
  readonly hostname: string;
  readonly operation: string;
  readonly acquiredAt: number;
}

interface LegacyOwnerRecord {
  readonly owner: LegacyWorkspaceLockOwner;
  readonly path: string;
}

/** Read-only view of the legacy directory lock's owner record. */
export type LegacyWorkspaceLockOwnerObservation =
  | { readonly kind: "empty" }
  | { readonly kind: "valid"; readonly owner: LegacyWorkspaceLockOwner }
  | { readonly kind: "ambiguous" };

interface LockFileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly mode: bigint;
  readonly links: bigint;
  readonly size: bigint;
}

interface ParentChainEntry {
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
}

type WorkspaceWriteAuthorityPhase =
  | { readonly kind: "active" }
  | {
      readonly kind: "revoked";
      readonly cause: WorkspaceLockOwnershipLostError;
    }
  | {
      readonly kind: "closed";
      readonly cause: WorkspaceLockOwnershipLostError;
    };

interface WorkspaceWriteAuthorityState {
  readonly binding: DirectoryBinding;
  readonly lockPath: string;
  readonly parentChain: readonly ParentChainEntry[];
  readonly lockFile: LockFileIdentity;
  readonly descriptor: number;
  readonly nativeBinding: ExclusiveFileLockBinding;
  readonly marker: NativeLockProtocolMarker;
  readonly operation: string;
  readonly acquiredAt: number;
  phase: WorkspaceWriteAuthorityPhase;
}

const workspaceWriteAuthorityStates = new WeakMap<
  WorkspaceWriteAuthority,
  WorkspaceWriteAuthorityState
>();
const workspaceLockAuthorities = new WeakMap<
  WorkspaceLock,
  WorkspaceWriteAuthority
>();

function authorityStateOf(
  authority: WorkspaceWriteAuthority,
  expectedStoreRoot: string,
): WorkspaceWriteAuthorityState {
  const state = workspaceWriteAuthorityStates.get(authority);
  if (state === undefined) {
    throw new WorkspaceLockOwnershipLostError(
      resolve(expectedStoreRoot),
      "write authority is not recognized by this process",
    );
  }
  return state;
}

function activeWorkspaceWriteAuthorityState(
  authority: WorkspaceWriteAuthority,
  expectedStoreRoot: string,
): WorkspaceWriteAuthorityState {
  const state = authorityStateOf(authority, expectedStoreRoot);
  if (state.phase.kind !== "active") throw state.phase.cause;
  return state;
}

export class WorkspaceLockTimeoutError extends Error {
  readonly lockPath: string;

  constructor(operation: string, timeoutMs: number, lockPath: string) {
    super(
      `timed out after ${timeoutMs} ms waiting for the Cyclotomy workspace lock (${operation}) at ${lockPath}; the lock may be active or abandoned. Run "cyclotomy doctor" to inspect it. If it reports an abandoned legacy lock, confirm that every process using this store has stopped, then run "cyclotomy lock recover --offline"`,
    );
    this.name = "WorkspaceLockTimeoutError";
    this.lockPath = lockPath;
  }
}

export class UnsafeWorkspaceLockPathError extends Error {
  constructor(path: string, options?: ErrorOptions) {
    super(
      `refusing to use an unsafe Cyclotomy workspace lock path: ${path}`,
      options,
    );
    this.name = "UnsafeWorkspaceLockPathError";
  }
}

/** The fixed lock path no longer names the exact acquired lock. */
export class WorkspaceLockOwnershipLostError extends Error {
  constructor(storeRoot: string, detail: string, options?: ErrorOptions) {
    super(
      `workspace lock ownership was lost at ${storeRoot}: ${detail}`,
      options,
    );
    this.name = "WorkspaceLockOwnershipLostError";
  }
}

/** The durable marker and the fixed lock path disagree about the protocol. */
export class WorkspaceLockProtocolInconsistentError extends Error {
  readonly storeRoot: string;
  readonly detail: string;

  constructor(storeRoot: string, detail: string) {
    super(
      `inconsistent Cyclotomy lock protocol at ${storeRoot}: ${detail}. Run "cyclotomy doctor" for diagnostics`,
    );
    this.name = "WorkspaceLockProtocolInconsistentError";
    this.storeRoot = storeRoot;
    this.detail = detail;
  }
}

/** Failure to acquire one member of an ordered workspace-lock set. */
export class OrderedWorkspaceLockAcquisitionError extends Error {
  readonly storeRoot: string;

  constructor(storeRoot: string, cause: unknown) {
    super(`cannot acquire the ordered workspace lock at ${storeRoot}`, {
      cause,
    });
    this.name = "OrderedWorkspaceLockAcquisitionError";
    this.storeRoot = storeRoot;
  }
}

/** Failure to release one member of an ordered workspace-lock set. */
export class OrderedWorkspaceLockReleaseError extends Error {
  readonly storeRoot: string;

  constructor(storeRoot: string, cause: unknown) {
    super(`cannot release the ordered workspace lock at ${storeRoot}`, {
      cause,
    });
    this.name = "OrderedWorkspaceLockReleaseError";
    this.storeRoot = storeRoot;
  }
}

function isTransientContentionError(error: unknown): boolean {
  if (process.platform !== "win32") return false;
  const code = systemErrorCode(error);
  return code === "EACCES" || code === "EPERM";
}

async function bindStoreRoot(path: string): Promise<DirectoryBinding> {
  try {
    return await bindDirectory(path, "Cyclotomy workspace store");
  } catch (cause) {
    if (cause instanceof DirectoryBindingError) {
      if (cause.failure === "changed") {
        throw new WorkspaceLockOwnershipLostError(
          cause.path,
          "workspace store changed while its identity was read",
          { cause },
        );
      }
      throw new UnsafeWorkspaceLockPathError(cause.path, { cause });
    }
    throw cause;
  }
}

function nativeLockFileShape(entry: BigIntStats): boolean {
  return entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1n;
}

function lockFileIdentityOf(entry: BigIntStats): LockFileIdentity {
  return {
    device: entry.dev,
    inode: entry.ino,
    mode: entry.mode,
    links: entry.nlink,
    size: entry.size,
  };
}

function sameLockFileIdentity(
  expected: LockFileIdentity,
  current: BigIntStats,
): boolean {
  return (
    current.dev === expected.device &&
    current.ino === expected.inode &&
    current.mode === expected.mode &&
    current.nlink === expected.links &&
    current.size === expected.size
  );
}

function parentChainOf(lockPath: string): readonly ParentChainEntry[] {
  const chain: ParentChainEntry[] = [];
  let current = dirname(lockPath);
  for (;;) {
    const entry = lstatSync(current, { bigint: true });
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.ino === 0n) {
      throw new UnsafeWorkspaceLockPathError(current);
    }
    chain.push({ path: current, device: entry.dev, inode: entry.ino });
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return Object.freeze(chain);
}

function assertParentChain(chain: readonly ParentChainEntry[]): void {
  for (const ancestor of chain) {
    const entry = lstatSync(ancestor.path, { bigint: true });
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      entry.dev !== ancestor.device ||
      entry.ino !== ancestor.inode
    ) {
      throw new Error(
        `workspace store parent ${ancestor.path} no longer names the bound directory`,
      );
    }
  }
}

function ownershipLoss(
  state: WorkspaceWriteAuthorityState,
  detail: string,
  cause?: unknown,
): WorkspaceLockOwnershipLostError {
  return new WorkspaceLockOwnershipLostError(
    state.binding.canonicalPath,
    detail,
    cause === undefined ? undefined : { cause },
  );
}

function revokeWorkspaceWriteAuthority(
  state: WorkspaceWriteAuthorityState,
  detail: string,
  cause?: unknown,
): WorkspaceLockOwnershipLostError {
  if (state.phase.kind !== "active") return state.phase.cause;
  const loss = ownershipLoss(state, detail, cause);
  state.phase = { kind: "revoked", cause: loss };
  return loss;
}

function closeWorkspaceWriteAuthority(
  state: WorkspaceWriteAuthorityState,
): void {
  if (state.phase.kind === "closed") return;
  state.phase = {
    kind: "closed",
    cause:
      state.phase.kind === "revoked"
        ? state.phase.cause
        : ownershipLoss(state, "write authority is no longer active"),
  };
}

/**
 * Re-verify handle, fixed path, store-root/parent chain and protocol marker.
 * The lock file is never deleted or replaced by us, so any mismatch means an
 * external actor changed the protocol: the authority must fail closed and can
 * never be revived by restoring the old pathname.
 */
function verifyNativeLockState(
  state: WorkspaceWriteAuthorityState,
  expectedStoreRoot: string,
): void {
  assertDirectoryStillBound(
    state.binding,
    state.binding.canonicalPath,
    "workspace store",
  );
  assertDirectoryStillBound(
    state.binding,
    expectedStoreRoot,
    "expected workspace store",
  );
  assertParentChain(state.parentChain);
  const opened = fstatSync(state.descriptor, { bigint: true });
  if (
    !nativeLockFileShape(opened) ||
    !sameLockFileIdentity(state.lockFile, opened)
  ) {
    throw new Error("open lock handle no longer names the acquired lock file");
  }
  const pathEntry = lstatSync(state.lockPath, { bigint: true });
  if (
    !nativeLockFileShape(pathEntry) ||
    pathEntry.dev !== state.lockFile.device ||
    pathEntry.ino !== state.lockFile.inode
  ) {
    throw new Error("fixed lock path names a different file");
  }
  const marker = readLockProtocolMarkerSync(state.binding.canonicalPath);
  if (!lockProtocolMarkerMatches(state.marker, marker)) {
    throw new Error("lock protocol marker changed");
  }
}

/**
 * Synchronously revalidate an opaque authority immediately before one durable
 * write. The first failed revalidation revokes it permanently. Callers must not
 * await between this check and the guarded mutation.
 */
export function assertWorkspaceWriteAuthority(
  authority: WorkspaceWriteAuthority,
  expectedStoreRoot: string,
): void {
  const state = activeWorkspaceWriteAuthorityState(
    authority,
    expectedStoreRoot,
  );
  try {
    verifyNativeLockState(state, expectedStoreRoot);
  } catch (cause) {
    throw revokeWorkspaceWriteAuthority(
      state,
      "exact native lock identity could not be revalidated",
      cause,
    );
  }
}

/** Check that an already-authenticated authority was not closed or revoked. */
export function assertWorkspaceWriteAuthorityActive(
  authority: WorkspaceWriteAuthority,
  expectedStoreRoot: string,
): void {
  activeWorkspaceWriteAuthorityState(authority, expectedStoreRoot);
}

function validateTimingOptions(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError("invalid workspace lock timing options");
  }
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveWait) => {
    setTimeout(resolveWait, milliseconds);
  });
}

async function waitWithinDeadline(
  startedAt: number,
  timeoutMs: number,
  operation: string,
  lockPath: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  signal?.throwIfAborted();
  const remaining = timeoutMs - (performance.now() - startedAt);
  if (remaining <= 0) {
    throw new WorkspaceLockTimeoutError(operation, timeoutMs, lockPath);
  }
  await wait(Math.min(LOCK_POLL_MS, remaining));
}

type LockPathKind = "absent" | "directory" | "file" | "other";

async function observeLockPathKind(lockPath: string): Promise<LockPathKind> {
  try {
    const entry = await lstat(lockPath, { bigint: true });
    if (entry.isSymbolicLink()) return "other";
    if (entry.isDirectory()) return "directory";
    if (entry.isFile()) return "file";
    return "other";
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT") return "absent";
    throw error;
  }
}

function inconsistent(storeRoot: string, detail: string): never {
  throw new WorkspaceLockProtocolInconsistentError(storeRoot, detail);
}

/**
 * Open the fixed lock path without creating it, and prove that the opened
 * handle and the pathname both name one zero-length single-link regular file.
 */
async function openNativeLockFile(lockPath: string): Promise<{
  readonly descriptor: number;
  readonly identity: LockFileIdentity;
}> {
  const storeRoot = dirname(lockPath);
  const observedKind = await observeLockPathKind(lockPath);
  if (observedKind !== "file") {
    inconsistent(
      storeRoot,
      observedKind === "directory"
        ? `${lockPath} is a directory, but the completed native protocol requires the persistent regular lock file`
        : `the native protocol marker is present but ${lockPath} cannot be opened as a regular file`,
    );
  }
  let descriptor: number;
  try {
    descriptor = openSync(
      lockPath,
      constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    const code = systemErrorCode(error);
    if (code === "ENOENT" || code === "ELOOP" || code === "EISDIR") {
      inconsistent(
        storeRoot,
        `the native protocol marker is present but ${lockPath} cannot be opened as a regular file`,
      );
    }
    throw error;
  }
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    let pathEntry: BigIntStats;
    try {
      pathEntry = lstatSync(lockPath, { bigint: true });
    } catch {
      inconsistent(storeRoot, `${lockPath} changed while it was opened`);
    }
    if (
      !nativeLockFileShape(opened) ||
      !nativeLockFileShape(pathEntry) ||
      opened.size !== 0n ||
      pathEntry.size !== 0n ||
      opened.dev !== pathEntry.dev ||
      opened.ino !== pathEntry.ino
    ) {
      inconsistent(
        storeRoot,
        `${lockPath} is not the exact zero-length regular lock file`,
      );
    }
    return { descriptor, identity: lockFileIdentityOf(opened) };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

interface WorkspaceLockAttempt {
  readonly binding: DirectoryBinding;
  readonly parentChain: readonly ParentChainEntry[];
  readonly lockPath: string;
  readonly operation: string;
  readonly startedAt: number;
  readonly timeoutMs: number;
  readonly signal: AbortSignal | undefined;
}

function assertLockAttempt(attempt: WorkspaceLockAttempt): void {
  attempt.signal?.throwIfAborted();
  if (
    attempt.timeoutMs > 0 &&
    performance.now() - attempt.startedAt >= attempt.timeoutMs
  ) {
    throw new WorkspaceLockTimeoutError(
      attempt.operation,
      attempt.timeoutMs,
      attempt.lockPath,
    );
  }
  assertDirectoryStillBound(
    attempt.binding,
    attempt.binding.canonicalPath,
    "workspace store",
  );
  assertParentChain(attempt.parentChain);
}

function waitForLock(attempt: WorkspaceLockAttempt): Promise<void> {
  return waitWithinDeadline(
    attempt.startedAt,
    attempt.timeoutMs,
    attempt.operation,
    attempt.lockPath,
    attempt.signal,
  );
}

async function acquireNativeBinding(
  nativeBinding: ExclusiveFileLockBinding,
  descriptor: number,
  attempt: WorkspaceLockAttempt,
): Promise<void> {
  for (;;) {
    assertLockAttempt(attempt);
    if (nativeBinding.tryAcquire(descriptor)) return;
    await waitForLock(attempt);
  }
}

/** Build the opaque lock/authority pair for one verified native lock state. */
function authorityLock(state: WorkspaceWriteAuthorityState): WorkspaceLock {
  const authority = Object.freeze({}) as WorkspaceWriteAuthority;
  workspaceWriteAuthorityStates.set(authority, state);

  let releaseInFlight: Promise<void> | undefined;
  let released = false;
  const lock: WorkspaceLock = {
    operation: state.operation,
    acquiredAt: state.acquiredAt,
    async release(): Promise<void> {
      if (releaseInFlight !== undefined) return releaseInFlight;
      closeWorkspaceWriteAuthority(state);
      releaseInFlight = (async () => {
        let loss: WorkspaceLockOwnershipLostError | undefined;
        try {
          verifyNativeLockState(state, state.binding.canonicalPath);
        } catch (cause) {
          loss = ownershipLoss(
            state,
            "native lock identity changed before release",
            cause,
          );
        }
        let releaseError: unknown;
        try {
          if (!released) state.nativeBinding.release(state.descriptor);
        } catch (error) {
          releaseError = error;
        } finally {
          if (!released) {
            released = true;
            closeSync(state.descriptor);
          }
        }
        if (releaseError !== undefined) throw releaseError;
        if (loss !== undefined) throw loss;
      })();
      return releaseInFlight;
    },
  };
  workspaceLockAuthorities.set(lock, authority);
  return lock;
}

interface WorkspaceLockProtocol {
  readonly id: "legacy-directory" | "native-file-v1";
  readonly acquire: (
    attempt: WorkspaceLockAttempt,
    marker: LockProtocolMarkerObservation,
  ) => Promise<WorkspaceLock>;
  readonly upgradeFromPrevious?: (
    attempt: WorkspaceLockAttempt,
    held: WorkspaceLock,
  ) => Promise<WorkspaceLock>;
}

const WORKSPACE_LOCK_PROTOCOLS: readonly WorkspaceLockProtocol[] =
  Object.freeze([
    Object.freeze({ id: "legacy-directory", acquire: acquireLegacyProtocol }),
    Object.freeze({
      id: "native-file-v1",
      acquire: acquireNativeProtocol,
      upgradeFromPrevious: upgradeToNativeProtocol,
    }),
  ]);
const LOCK_PROTOCOL_INDEX = new Map(
  WORKSPACE_LOCK_PROTOCOLS.map(({ id }, index) => [id, index]),
);
const CURRENT_LOCK_PROTOCOL = WORKSPACE_LOCK_PROTOCOLS.at(-1)!;

/** Another cooperative client advanced the protocol while this call waited. */
class WorkspaceLockProtocolChanged extends Error {}

/** Acquire the current protocol, performing any adjacent handover on the way. */
export async function acquireWorkspaceLock(
  storeRoot: string,
  operation: string,
  options: WorkspaceLockOptions = {},
): Promise<WorkspaceLock> {
  options.signal?.throwIfAborted();
  const startedAt = performance.now();
  const timeoutMs = options.timeoutMs ?? 5_000;
  validateTimingOptions(timeoutMs);
  const binding = await bindStoreRoot(storeRoot);
  const lockPath = join(binding.canonicalPath, WORKSPACE_LOCK_FILE);
  const attempt: WorkspaceLockAttempt = {
    binding,
    parentChain: parentChainOf(lockPath),
    lockPath,
    operation,
    startedAt,
    timeoutMs,
    signal: options.signal,
  };

  for (;;) {
    assertLockAttempt(attempt);
    const marker = readLockProtocolMarkerSync(binding.canonicalPath);
    if (marker.kind === "unsupported") {
      throw new UnsupportedLockProtocolError(
        binding.canonicalPath,
        marker.observedFormat,
        marker.observedProtocol,
      );
    }
    const pathKind = await observeLockPathKind(lockPath);
    if (marker.kind === "absent" && pathKind === "other") {
      throw new UnsafeWorkspaceLockPathError(lockPath);
    }
    const protocol =
      marker.kind === "absent"
        ? pathKind === "directory"
          ? "legacy-directory"
          : CURRENT_LOCK_PROTOCOL.id
        : marker.kind;
    const sourceIndex = LOCK_PROTOCOL_INDEX.get(protocol)!;
    let held: WorkspaceLock | undefined;
    try {
      held = await WORKSPACE_LOCK_PROTOCOLS[sourceIndex]!.acquire(
        attempt,
        marker,
      );
      for (
        let index = sourceIndex + 1;
        index < WORKSPACE_LOCK_PROTOCOLS.length;
        index += 1
      ) {
        held = await WORKSPACE_LOCK_PROTOCOLS[index]!.upgradeFromPrevious!(
          attempt,
          held,
        );
      }
      return held;
    } catch (cause) {
      try {
        await held?.release();
      } catch (cleanup) {
        throw new AggregateError(
          [cause, cleanup],
          "workspace lock handover and cleanup both failed",
          { cause },
        );
      }
      if (!(cause instanceof WorkspaceLockProtocolChanged)) throw cause;
      await waitForLock(attempt);
    }
  }
}

async function acquireLegacyProtocol(
  attempt: WorkspaceLockAttempt,
): Promise<WorkspaceLock> {
  const legacy = await acquireLegacyDirectoryLock(attempt);
  let released: Promise<void> | undefined;
  return {
    operation: attempt.operation,
    acquiredAt: legacy.owner.acquiredAt,
    release: () => (released ??= releaseLegacyDirectoryLock(legacy)),
  };
}

async function upgradeToNativeProtocol(
  attempt: WorkspaceLockAttempt,
  held: WorkspaceLock,
): Promise<WorkspaceLock> {
  assertLockAttempt(attempt);
  await held.release();
  return createAndPublishNativeLock(attempt);
}

async function acquireNativeProtocol(
  attempt: WorkspaceLockAttempt,
  marker: LockProtocolMarkerObservation,
): Promise<WorkspaceLock> {
  if (marker.kind === "absent") return createAndPublishNativeLock(attempt);
  if (marker.kind !== "native-file-v1") {
    throw new UnsupportedLockProtocolError(
      attempt.binding.canonicalPath,
      marker.observedFormat,
      marker.observedProtocol,
    );
  }
  const nativeBinding = await loadExclusiveFileLock();
  assertLockAttempt(attempt);
  const opened = await openNativeLockFile(attempt.lockPath);
  return holdNativeLock(attempt, opened, nativeBinding, marker);
}

/** Exclusive creation respects a directory or file another client won first. */
async function openOrCreateNativeLockFile(
  attempt: WorkspaceLockAttempt,
): Promise<{
  readonly descriptor: number;
  readonly identity: LockFileIdentity;
}> {
  for (;;) {
    assertLockAttempt(attempt);
    let descriptor: number;
    try {
      descriptor = openSync(
        attempt.lockPath,
        constants.O_RDWR |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
    } catch (error) {
      if (systemErrorCode(error) === "EEXIST") {
        const kind = await observeLockPathKind(attempt.lockPath);
        if (kind === "file") return openNativeLockFile(attempt.lockPath);
        if (kind === "directory") throw new WorkspaceLockProtocolChanged();
        if (kind === "other")
          throw new UnsafeWorkspaceLockPathError(attempt.lockPath);
      } else if (!isTransientContentionError(error)) {
        throw error;
      }
      await waitForLock(attempt);
      continue;
    }
    try {
      const entry = fstatSync(descriptor, { bigint: true });
      if (!nativeLockFileShape(entry) || entry.size !== 0n) {
        inconsistent(
          attempt.binding.canonicalPath,
          "the newly created lock file is not a zero-length regular file",
        );
      }
      return { descriptor, identity: lockFileIdentityOf(entry) };
    } catch (cause) {
      closeSync(descriptor);
      throw cause;
    }
  }
}

async function createAndPublishNativeLock(
  attempt: WorkspaceLockAttempt,
): Promise<WorkspaceLock> {
  const nativeBinding = await loadExclusiveFileLock();
  assertLockAttempt(attempt);
  const opened = await openOrCreateNativeLockFile(attempt);
  return holdNativeLock(attempt, opened, nativeBinding);
}

/** The marker is committed only while the exact persistent file is locked. */
async function holdNativeLock(
  attempt: WorkspaceLockAttempt,
  opened: { readonly descriptor: number; readonly identity: LockFileIdentity },
  nativeBinding: ExclusiveFileLockBinding,
  marker?: NativeLockProtocolMarker,
): Promise<WorkspaceLock> {
  try {
    await acquireNativeBinding(nativeBinding, opened.descriptor, attempt);
    assertLockAttempt(attempt);
    const pathEntry = lstatSync(attempt.lockPath, { bigint: true });
    if (
      !nativeLockFileShape(pathEntry) ||
      !sameLockFileIdentity(opened.identity, pathEntry)
    ) {
      throw new WorkspaceLockOwnershipLostError(
        attempt.binding.canonicalPath,
        "native lock identity changed while it was acquired",
      );
    }
    if (marker === undefined) {
      attempt.signal?.throwIfAborted();
      marker = await publishLockProtocolMarker(attempt.binding.canonicalPath);
    }
    const state: WorkspaceWriteAuthorityState = {
      binding: attempt.binding,
      lockPath: attempt.lockPath,
      parentChain: attempt.parentChain,
      lockFile: opened.identity,
      descriptor: opened.descriptor,
      nativeBinding,
      marker,
      operation: attempt.operation,
      acquiredAt: Date.now(),
      phase: { kind: "active" },
    };
    try {
      verifyNativeLockState(state, attempt.binding.canonicalPath);
    } catch (cause) {
      throw new WorkspaceLockOwnershipLostError(
        attempt.binding.canonicalPath,
        "native lock identity changed while it was acquired",
        { cause },
      );
    }
    assertLockAttempt(attempt);
    return authorityLock(state);
  } catch (cause) {
    try {
      nativeBinding.release(opened.descriptor);
    } catch {
      // Preserve acquisition, publication or identity failure.
    }
    closeSync(opened.descriptor);
    throw cause;
  }
}

function sameOwnerFileObservation(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function parseLegacyOwner(
  text: string,
  expectedToken: string | undefined,
): LegacyWorkspaceLockOwner | undefined {
  let parsed: Partial<LegacyWorkspaceLockOwner>;
  try {
    parsed = JSON.parse(text) as Partial<LegacyWorkspaceLockOwner>;
  } catch {
    return undefined;
  }
  if (
    typeof parsed.token !== "string" ||
    parsed.token.length === 0 ||
    (expectedToken !== undefined && parsed.token !== expectedToken) ||
    typeof parsed.pid !== "number" ||
    !Number.isSafeInteger(parsed.pid) ||
    parsed.pid <= 0 ||
    typeof parsed.hostname !== "string" ||
    parsed.hostname.length === 0 ||
    typeof parsed.operation !== "string" ||
    typeof parsed.acquiredAt !== "number" ||
    !Number.isFinite(parsed.acquiredAt)
  ) {
    return undefined;
  }
  return {
    token: parsed.token,
    pid: parsed.pid,
    hostname: parsed.hostname,
    operation: parsed.operation,
    acquiredAt: parsed.acquiredAt,
  };
}

async function readLegacyOwnerFile(
  path: string,
  expectedToken: string | undefined,
): Promise<LegacyOwnerRecord | undefined> {
  let pathBefore: BigIntStats;
  try {
    pathBefore = await lstat(path, { bigint: true });
  } catch {
    return undefined;
  }
  if (
    pathBefore.isSymbolicLink() ||
    !pathBefore.isFile() ||
    pathBefore.nlink !== 1n ||
    pathBefore.size > LEGACY_OWNER_FILE_MAX_BYTES
  ) {
    return undefined;
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size > LEGACY_OWNER_FILE_MAX_BYTES ||
      !sameOwnerFileObservation(pathBefore, before)
    ) {
      return undefined;
    }
    const allocated = Buffer.allocUnsafe(Number(before.size));
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
    const [after, pathAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
    ]);
    if (
      extraBytes !== 0 ||
      offset !== allocated.byteLength ||
      !sameOwnerFileObservation(before, after) ||
      !sameOwnerFileObservation(after, pathAfter)
    ) {
      return undefined;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(allocated);
    const owner = parseLegacyOwner(text, expectedToken);
    return owner === undefined ? undefined : { owner, path };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function observeLegacyOwnerState(
  lockPath: string,
): Promise<LegacyWorkspaceLockOwnerObservation | undefined> {
  let names: string[];
  try {
    names = await readdir(lockPath);
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  if (names.length === 0) return { kind: "empty" };
  const ownerNames = names.filter(
    (name) =>
      name.startsWith(LEGACY_OWNER_PREFIX) &&
      name.endsWith(LEGACY_OWNER_SUFFIX),
  );
  const name = ownerNames[0];
  if (ownerNames.length !== 1 || name === undefined || names.length !== 1) {
    return { kind: "ambiguous" };
  }
  const token = name.slice(
    LEGACY_OWNER_PREFIX.length,
    -LEGACY_OWNER_SUFFIX.length,
  );
  const record = await readLegacyOwnerFile(join(lockPath, name), token);
  return record === undefined
    ? { kind: "ambiguous" }
    : { kind: "valid", owner: record.owner };
}

async function removeEmptyDirectory(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (error) {
    const code = systemErrorCode(error);
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
      throw error;
    }
  }
}

interface LegacyLockState {
  readonly lockPath: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly owner: LegacyWorkspaceLockOwner;
  readonly ownerPath: string;
  readonly ownerFile: LockFileIdentity;
}

/**
 * Really acquire the legacy directory lock. A contender using the published
 * 0.2.4 algorithm is excluded by the same `mkdir` that grants this call, so
 * automatic stale takeover stays disabled: an owner record that looks
 * abandoned is never proof that no old process is running.
 */
async function acquireLegacyDirectoryLock(
  attempt: WorkspaceLockAttempt,
): Promise<LegacyLockState> {
  const { lockPath, operation } = attempt;
  const canonicalPath = attempt.binding.canonicalPath;
  const owner: LegacyWorkspaceLockOwner = {
    token: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    operation,
    acquiredAt: Date.now(),
  };
  const ownerPath = join(
    lockPath,
    `${LEGACY_OWNER_PREFIX}${owner.token}${LEGACY_OWNER_SUFFIX}`,
  );

  for (;;) {
    assertLockAttempt(attempt);
    let created: BigIntStats;
    try {
      await mkdir(lockPath, { mode: 0o700 });
      created = await lstat(lockPath, { bigint: true });
      const names = await readdir(lockPath);
      if (
        !created.isDirectory() ||
        created.isSymbolicLink() ||
        names.length !== 0
      ) {
        throw new WorkspaceLockOwnershipLostError(
          canonicalPath,
          "the legacy lock directory was not empty after exclusive creation",
        );
      }
    } catch (error) {
      if (error instanceof WorkspaceLockOwnershipLostError) throw error;
      if (
        systemErrorCode(error) !== "EEXIST" &&
        !isTransientContentionError(error)
      ) {
        throw error;
      }
      const kind = await observeLockPathKind(lockPath);
      if (kind === "file") throw new WorkspaceLockProtocolChanged();
      if (kind === "other") throw new UnsafeWorkspaceLockPathError(lockPath);
      await waitForLock(attempt);
      continue;
    }

    try {
      await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      const observed = await observeLegacyOwnerState(lockPath);
      const publishedOwner = await lstat(ownerPath, { bigint: true });
      const current = await lstat(lockPath, { bigint: true });
      if (
        observed === undefined ||
        observed.kind !== "valid" ||
        observed.owner.token !== owner.token ||
        current.dev !== created.dev ||
        current.ino !== created.ino ||
        !publishedOwner.isFile() ||
        publishedOwner.isSymbolicLink() ||
        publishedOwner.nlink !== 1n
      ) {
        throw new WorkspaceLockOwnershipLostError(
          canonicalPath,
          "the legacy lock formation changed while its owner was published",
        );
      }
      return {
        lockPath,
        device: created.dev,
        inode: created.ino,
        owner,
        ownerPath,
        ownerFile: lockFileIdentityOf(publishedOwner),
      };
    } catch (error) {
      // Only an unchanged, empty directory may be removed through the fixed
      // pathname; any other residue is preserved for diagnostics and the
      // operation fails closed.
      await removeEmptyDirectory(lockPath).catch(() => {});
      throw error;
    }
  }
}

async function unlinkExactLegacyOwnerFile(
  state: LegacyLockState,
): Promise<void> {
  let current: BigIntStats;
  try {
    current = await lstat(state.ownerPath, { bigint: true });
  } catch (cause) {
    throw new WorkspaceLockOwnershipLostError(
      dirname(state.lockPath),
      "legacy owner record disappeared during release",
      { cause },
    );
  }
  if (!sameLockFileIdentity(state.ownerFile, current)) {
    throw new WorkspaceLockOwnershipLostError(
      dirname(state.lockPath),
      "legacy owner record was replaced during release",
    );
  }
  try {
    await unlink(state.ownerPath);
  } catch (cause) {
    if (systemErrorCode(cause) === "ENOENT") {
      throw new WorkspaceLockOwnershipLostError(
        dirname(state.lockPath),
        "legacy owner record disappeared during unlink",
        { cause },
      );
    }
    throw cause;
  }
}

async function releaseLegacyDirectoryLock(
  state: LegacyLockState,
): Promise<void> {
  await unlinkExactLegacyOwnerFile(state);
  let current: BigIntStats;
  try {
    current = await lstat(state.lockPath, { bigint: true });
  } catch (cause) {
    if (systemErrorCode(cause) === "ENOENT") {
      throw new WorkspaceLockOwnershipLostError(
        dirname(state.lockPath),
        "lock directory disappeared during release",
        { cause },
      );
    }
    throw cause;
  }
  if (current.dev !== state.device || current.ino !== state.inode) {
    throw new WorkspaceLockOwnershipLostError(
      dirname(state.lockPath),
      "lock directory was replaced during release",
    );
  }
  try {
    await rmdir(state.lockPath);
  } catch (cause) {
    if (systemErrorCode(cause) === "ENOENT") {
      throw new WorkspaceLockOwnershipLostError(
        dirname(state.lockPath),
        "lock directory disappeared during final release",
        { cause },
      );
    }
    throw cause;
  }
}

/** Read-only lock observation used by diagnostics; never creates or deletes. */
export type WorkspaceLockDiagnostic =
  | {
      /**
       * The native lock was acquirable: one non-blocking attempt succeeded and
       * was released before this observation returned.
       */
      readonly kind: "native-acquired";
      readonly marker: NativeLockProtocolMarker;
    }
  | { readonly kind: "native-busy" }
  | {
      readonly kind: "legacy-directory";
      readonly owner: LegacyWorkspaceLockOwnerObservation;
    }
  | { readonly kind: "absent" }
  | { readonly kind: "interrupted-switch" }
  | { readonly kind: "corrupt"; readonly detail: string }
  | { readonly kind: "inconsistent"; readonly detail: string }
  | {
      readonly kind: "unsupported";
      readonly observedFormat: unknown;
      readonly observedProtocol: unknown;
    };

/**
 * Observe the lock without business write authority. A native lock is held for
 * at most one non-blocking attempt and released before returning.
 */
export async function inspectWorkspaceLock(
  storeRoot: string,
): Promise<WorkspaceLockDiagnostic> {
  const binding = await bindStoreRoot(storeRoot);
  const lockPath = join(binding.canonicalPath, WORKSPACE_LOCK_FILE);
  let marker: ReturnType<typeof readLockProtocolMarkerSync>;
  try {
    marker = readLockProtocolMarkerSync(binding.canonicalPath);
  } catch (error) {
    if (error instanceof LockProtocolCorruptError) {
      return { kind: "corrupt", detail: error.detail };
    }
    throw error;
  }
  if (marker.kind === "unsupported") {
    return {
      kind: "unsupported",
      observedFormat: marker.observedFormat,
      observedProtocol: marker.observedProtocol,
    };
  }
  if (marker.kind === "absent") {
    switch (await observeLockPathKind(lockPath)) {
      case "absent":
        return { kind: "absent" };
      case "directory":
        return {
          kind: "legacy-directory",
          owner: (await observeLegacyOwnerState(lockPath)) ?? {
            kind: "ambiguous",
          },
        };
      case "file":
        return { kind: "interrupted-switch" };
      default:
        return {
          kind: "inconsistent",
          detail:
            "the fixed lock path is neither a regular file nor a directory",
        };
    }
  }

  switch (await observeLockPathKind(lockPath)) {
    case "absent":
      return {
        kind: "inconsistent",
        detail:
          "the native protocol marker is present but the lock file is missing",
      };
    case "file":
      break;
    case "directory":
      return {
        kind: "inconsistent",
        detail:
          "the native protocol marker is present but the fixed lock path is a directory",
      };
    default:
      return {
        kind: "inconsistent",
        detail:
          "the native protocol marker is present but the fixed lock path is not a regular file",
      };
  }

  let descriptor: number;
  try {
    descriptor = openSync(
      lockPath,
      constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (isTransientContentionError(error)) {
      return {
        kind: "inconsistent",
        detail:
          "the lock file cannot be opened for exclusivity (permissions or read-only media)",
      };
    }
    throw error;
  }
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!nativeLockFileShape(opened) || opened.size !== 0n) {
      return {
        kind: "inconsistent",
        detail:
          "the fixed lock path is not a zero-length single-link regular file",
      };
    }
    const nativeBinding = await loadExclusiveFileLock();
    if (!nativeBinding.tryAcquire(descriptor)) return { kind: "native-busy" };
    nativeBinding.release(descriptor);
    return { kind: "native-acquired", marker };
  } finally {
    closeSync(descriptor);
  }
}

/**
 * One-off offline recovery: isolate a legacy directory lock that no live
 * protocol can release. Requires the operator-asserted stop condition; only the
 * fixed legacy directory is renamed, never a native lock file or any other path.
 */
export async function quarantineLegacyWorkspaceLock(
  storeRoot: string,
): Promise<
  | { readonly kind: "quarantined"; readonly path: string }
  | { readonly kind: "nothing-to-recover" }
  | { readonly kind: "native-protocol" }
> {
  const binding = await bindStoreRoot(storeRoot);
  const lockPath = join(binding.canonicalPath, WORKSPACE_LOCK_FILE);
  const marker = readLockProtocolMarkerSync(binding.canonicalPath);
  if (marker.kind === "native-file-v1") return { kind: "native-protocol" };
  if ((await observeLockPathKind(lockPath)) !== "directory") {
    return { kind: "nothing-to-recover" };
  }
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const target = `${lockPath}.abandoned-${stamp}-${randomUUID().slice(0, 8)}`;
  await rename(lockPath, target);
  return { kind: "quarantined", path: target };
}

/**
 * Preserve the action effect independently from lock cleanup. Acquisition still
 * throws because the action provably did not run; after acquisition every fact
 * is returned without reconstructing it from an AggregateError.
 */
export type WorkspaceLockExecution<T> =
  | {
      readonly kind: "completed";
      readonly value: T;
      readonly cleanup: CleanupSettlement;
    }
  | {
      readonly kind: "action-failed";
      readonly cause: unknown;
      readonly cleanup: CleanupSettlement;
    };

export async function runWithWorkspaceLock<T>(
  storeRoot: string,
  operation: string,
  action: (authority: WorkspaceWriteAuthority) => Promise<T>,
  options?: WorkspaceLockOptions,
): Promise<WorkspaceLockExecution<T>> {
  const lock = await acquireWorkspaceLock(storeRoot, operation, options);
  const authority = workspaceLockAuthorities.get(lock);
  if (authority === undefined) {
    throw new WorkspaceLockOwnershipLostError(
      resolve(storeRoot),
      "acquisition did not produce a write authority",
    );
  }
  let actionResult:
    | { readonly kind: "completed"; readonly value: T }
    | { readonly kind: "action-failed"; readonly cause: unknown };
  try {
    actionResult = { kind: "completed", value: await action(authority) };
  } catch (cause) {
    actionResult = { kind: "action-failed", cause };
  }
  closeWorkspaceWriteAuthority(authorityStateOf(authority, resolve(storeRoot)));
  let cleanup: CleanupSettlement = { kind: "settled" };
  try {
    await lock.release();
  } catch (cause) {
    cleanup = { kind: "failed", cause };
  }
  return { ...actionResult, cleanup };
}

export async function withWorkspaceLock<T>(
  storeRoot: string,
  operation: string,
  action: (authority: WorkspaceWriteAuthority) => Promise<T>,
  options?: WorkspaceLockOptions,
): Promise<T> {
  const execution = await runWithWorkspaceLock(
    storeRoot,
    operation,
    action,
    options,
  );
  if (execution.kind === "completed") {
    if (execution.cleanup.kind === "settled") return execution.value;
    throw execution.cleanup.cause;
  }
  if (execution.cleanup.kind === "settled") throw execution.cause;
  throw new AggregateError(
    [execution.cause, execution.cleanup.cause],
    "workspace-lock operation and cleanup both failed",
    { cause: execution.cause },
  );
}

export interface OrderedWorkspaceLockTarget {
  readonly storeRoot: string;
  readonly options?: WorkspaceLockOptions;
}

/** Canonical store root to its one physically deduplicated write authority. */
export type OrderedWorkspaceAuthorities = ReadonlyMap<
  string,
  WorkspaceWriteAuthority
>;

interface BoundOrderedWorkspaceLockTarget extends OrderedWorkspaceLockTarget {
  readonly binding: DirectoryBinding;
}

export type OrderedWorkspaceLockCleanup =
  | { readonly kind: "settled" }
  | {
      readonly kind: "failed";
      readonly cause: unknown;
      readonly failures: readonly OrderedWorkspaceLockReleaseError[];
    };

export type OrderedWorkspaceLockExecution<T> =
  | {
      readonly kind: "completed";
      readonly value: T;
      readonly cleanup: OrderedWorkspaceLockCleanup;
    }
  | {
      readonly kind: "action-failed";
      readonly cause: unknown;
      readonly cleanup: OrderedWorkspaceLockCleanup;
    };

async function orderedTargets(
  targets: readonly OrderedWorkspaceLockTarget[],
): Promise<readonly BoundOrderedWorkspaceLockTarget[]> {
  const unique = new Map<string, BoundOrderedWorkspaceLockTarget>();
  for (const target of targets) {
    let binding: DirectoryBinding;
    try {
      binding = await bindStoreRoot(target.storeRoot);
    } catch (cause) {
      throw new OrderedWorkspaceLockAcquisitionError(
        resolve(target.storeRoot),
        cause,
      );
    }
    const physicalIdentity = `${binding.device}:${binding.inode}`;
    if (!unique.has(physicalIdentity)) {
      unique.set(physicalIdentity, {
        ...target,
        storeRoot: binding.canonicalPath,
        binding,
      });
    }
  }
  return [...unique.values()].sort((left, right) =>
    compareDirectoryBindings(left.binding, right.binding),
  );
}

async function releaseOrderedLocks(
  acquired: readonly {
    readonly target: OrderedWorkspaceLockTarget;
    readonly lock: WorkspaceLock;
  }[],
): Promise<OrderedWorkspaceLockCleanup> {
  for (const member of acquired) {
    const authority = workspaceLockAuthorities.get(member.lock);
    if (authority !== undefined) {
      closeWorkspaceWriteAuthority(
        authorityStateOf(authority, member.target.storeRoot),
      );
    }
  }
  const failures: OrderedWorkspaceLockReleaseError[] = [];
  for (let index = acquired.length - 1; index >= 0; index -= 1) {
    const member = acquired[index];
    if (member === undefined) continue;
    try {
      await member.lock.release();
    } catch (cause) {
      failures.push(
        new OrderedWorkspaceLockReleaseError(member.target.storeRoot, cause),
      );
    }
  }
  if (failures.length === 0) return { kind: "settled" };
  const cause =
    failures.length === 1
      ? failures[0]
      : new AggregateError(failures, "ordered workspace-lock cleanup failed", {
          cause: failures[0],
        });
  return { kind: "failed", cause, failures };
}

/** Acquire canonically and preserve the action result independently per cleanup root. */
export async function runWithOrderedWorkspaceLocks<T>(
  targets: readonly OrderedWorkspaceLockTarget[],
  operation: string,
  action: (authorities: OrderedWorkspaceAuthorities) => Promise<T>,
): Promise<OrderedWorkspaceLockExecution<T>> {
  const acquired: Array<{
    readonly target: BoundOrderedWorkspaceLockTarget;
    readonly lock: WorkspaceLock;
  }> = [];
  for (const target of await orderedTargets(targets)) {
    try {
      const lock = await acquireWorkspaceLock(
        target.storeRoot,
        operation,
        target.options,
      );
      acquired.push({ target, lock });
      const authority = workspaceLockAuthorities.get(lock);
      const acquiredBinding =
        authority === undefined
          ? undefined
          : workspaceWriteAuthorityStates.get(authority)?.binding;
      if (
        acquiredBinding === undefined ||
        !sameDirectoryBinding(acquiredBinding, target.binding)
      ) {
        throw new WorkspaceLockOwnershipLostError(
          target.storeRoot,
          "ordered target changed between physical ordering and acquisition",
        );
      }
    } catch (cause) {
      const acquisition = new OrderedWorkspaceLockAcquisitionError(
        target.storeRoot,
        cause,
      );
      const cleanup = await releaseOrderedLocks(acquired);
      if (cleanup.kind === "settled") throw acquisition;
      throw new AggregateError(
        [acquisition, ...cleanup.failures],
        "ordered workspace-lock acquisition and cleanup both failed",
        { cause: acquisition },
      );
    }
  }

  let actionResult:
    | { readonly kind: "completed"; readonly value: T }
    | { readonly kind: "action-failed"; readonly cause: unknown };
  try {
    const authorities = new Map<string, WorkspaceWriteAuthority>();
    for (const member of acquired) {
      const authority = workspaceLockAuthorities.get(member.lock);
      if (authority === undefined) {
        throw new WorkspaceLockOwnershipLostError(
          member.target.storeRoot,
          "ordered acquisition did not produce a write authority",
        );
      }
      authorities.set(member.target.storeRoot, authority);
    }
    actionResult = {
      kind: "completed",
      value: await action(authorities),
    };
  } catch (cause) {
    actionResult = { kind: "action-failed", cause };
  }
  return { ...actionResult, cleanup: await releaseOrderedLocks(acquired) };
}

/** Acquire multiple workspace locks in one canonical order to avoid AB/BA deadlocks. */
export async function withOrderedWorkspaceLocks<T>(
  targets: readonly OrderedWorkspaceLockTarget[],
  operation: string,
  action: (authorities: OrderedWorkspaceAuthorities) => Promise<T>,
): Promise<T> {
  const execution = await runWithOrderedWorkspaceLocks(
    targets,
    operation,
    action,
  );
  if (execution.kind === "completed") {
    if (execution.cleanup.kind === "settled") return execution.value;
    throw execution.cleanup.cause;
  }
  if (execution.cleanup.kind === "settled") throw execution.cause;
  throw new AggregateError(
    [execution.cause, ...execution.cleanup.failures],
    "ordered workspace-lock operation and cleanup both failed",
    { cause: execution.cause },
  );
}
