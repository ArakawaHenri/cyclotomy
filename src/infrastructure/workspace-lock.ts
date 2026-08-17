import { randomUUID } from "node:crypto";
import {
  constants,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  type Stats,
} from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  readdir,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import type { CleanupSettlement } from "../domain/cleanup-settlement.ts";
import { systemErrorCode } from "./system-error.ts";

const LOCK_DIRECTORY = "workspace.lock";
const OWNER_PREFIX = "owner-";
const OWNER_SUFFIX = ".json";
const OWNER_FILE_MAX_BYTES = 16 * 1024;

export interface WorkspaceLockOptions {
  /** Time to wait for another cooperative operation. Default 5 seconds. */
  readonly timeoutMs?: number;
  /** Deterministic test seam immediately before the final lock-directory release. */
  readonly beforeFinalRelease?: () => Promise<void>;
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

interface LockOwner {
  readonly token: string;
  readonly pid: number;
  readonly hostname: string;
  readonly operation: string;
  readonly acquiredAt: number;
}

interface OwnerRecord {
  readonly owner: LockOwner;
  readonly path: string;
}

type LockOwnerState =
  | { readonly kind: "empty" }
  | { readonly kind: "valid"; readonly record: OwnerRecord }
  | { readonly kind: "ambiguous" };

interface LockObservation {
  readonly device: number;
  readonly inode: number;
  readonly owner: LockOwnerState;
}

interface DirectoryObservation {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
}

type PhysicalWorkspaceOrderKey = Pick<
  DirectoryObservation,
  "path" | "device" | "inode"
>;

interface ProtocolFileObservation {
  readonly device: number;
  readonly inode: number;
  readonly mode: number;
  readonly links: number;
  readonly size: number;
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
  readonly binding: DirectoryObservation;
  readonly lockPath: string;
  readonly lock: LockObservation;
  readonly owner: LockOwner;
  readonly ownerPath: string;
  readonly ownerFile: ProtocolFileObservation;
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

export class WorkspaceLockTimeoutError extends Error {
  readonly lockPath: string;

  constructor(operation: string, timeoutMs: number, lockPath: string) {
    super(
      `timed out after ${timeoutMs} ms waiting for the Cyclotomy workspace lock (${operation}) at ${lockPath}; the lock may be active or abandoned. Confirm that every process using this store has stopped before following the README recovery instructions`,
    );
    this.name = "WorkspaceLockTimeoutError";
    this.lockPath = lockPath;
  }
}

export class UnsafeWorkspaceLockPathError extends Error {
  constructor(path: string) {
    super(`refusing to use a non-directory Cyclotomy workspace lock: ${path}`);
    this.name = "UnsafeWorkspaceLockPathError";
  }
}

/** The fixed lock path no longer names the exact acquired owner. */
export class WorkspaceLockOwnershipLostError extends Error {
  constructor(storeRoot: string, detail: string, options?: ErrorOptions) {
    super(
      `workspace lock ownership was lost at ${storeRoot}: ${detail}`,
      options,
    );
    this.name = "WorkspaceLockOwnershipLostError";
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

class WorkspaceLockFormationChangedError extends Error {
  constructor() {
    super("workspace lock directory changed during owner publication");
    this.name = "WorkspaceLockFormationChangedError";
  }
}

function isTransientContentionObservationError(error: unknown): boolean {
  const code = systemErrorCode(error);
  return code === "EACCES" || code === "EPERM";
}

function sameDirectoryObservation(
  expected: DirectoryObservation,
  current: Stats,
): boolean {
  return (
    current.isDirectory() &&
    !current.isSymbolicLink() &&
    current.dev === expected.device &&
    current.ino === expected.inode
  );
}

async function bindStoreRoot(path: string): Promise<DirectoryObservation> {
  const canonicalPath = await realpath(path);
  const first = await lstat(canonicalPath);
  if (!first.isDirectory() || first.isSymbolicLink()) {
    throw new UnsafeWorkspaceLockPathError(canonicalPath);
  }
  const rebound = await realpath(path);
  const reboundEntry = await lstat(rebound);
  const binding = {
    path: canonicalPath,
    device: first.dev,
    inode: first.ino,
  };
  if (
    rebound !== canonicalPath ||
    !sameDirectoryObservation(binding, reboundEntry)
  ) {
    throw new WorkspaceLockOwnershipLostError(
      canonicalPath,
      "workspace store changed while its identity was read",
    );
  }
  return binding;
}

function protocolFileObservation(entry: Stats): ProtocolFileObservation {
  return {
    device: entry.dev,
    inode: entry.ino,
    mode: entry.mode,
    links: entry.nlink,
    size: entry.size,
  };
}

function sameProtocolFile(
  expected: ProtocolFileObservation,
  current: Stats,
): boolean {
  return (
    current.isFile() &&
    !current.isSymbolicLink() &&
    current.nlink === 1 &&
    current.dev === expected.device &&
    current.ino === expected.inode &&
    current.mode === expected.mode &&
    current.nlink === expected.links &&
    current.size === expected.size
  );
}

function ownershipLoss(
  state: WorkspaceWriteAuthorityState,
  detail: string,
  cause?: unknown,
): WorkspaceLockOwnershipLostError {
  return new WorkspaceLockOwnershipLostError(
    state.binding.path,
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

function assertBoundDirectory(
  expected: DirectoryObservation,
  path: string,
  label: string,
): void {
  const canonical = realpathSync(path);
  const current = lstatSync(canonical);
  // The physical directory is the authority boundary. Windows may return a
  // different canonical spelling for the same directory (for example after
  // expanding a short path or normalizing case), so comparing realpath text
  // would revoke a valid authority. Device and inode still reject any path
  // rebound to another directory, including a lexical alias.
  if (!sameDirectoryObservation(expected, current)) {
    throw new Error(`${label} changed`);
  }
}

/**
 * Synchronously revalidate an opaque authority immediately before one durable
 * write. The first failed revalidation revokes it permanently, even if the old
 * lock pathname is later restored. Callers must not await between this check
 * and the mutation.
 */
export function assertWorkspaceWriteAuthority(
  authority: WorkspaceWriteAuthority,
  expectedStoreRoot: string,
): void {
  const state = workspaceWriteAuthorityStates.get(authority);
  if (state === undefined) {
    throw new WorkspaceLockOwnershipLostError(
      resolve(expectedStoreRoot),
      "write authority is not recognized by this process",
    );
  }
  if (state.phase.kind !== "active") throw state.phase.cause;
  try {
    assertBoundDirectory(state.binding, state.binding.path, "workspace store");
    assertBoundDirectory(
      state.binding,
      expectedStoreRoot,
      "expected workspace store",
    );
    const lock = lstatSync(state.lockPath);
    if (
      !lock.isDirectory() ||
      lock.isSymbolicLink() ||
      lock.dev !== state.lock.device ||
      lock.ino !== state.lock.inode
    ) {
      throw new Error("fixed lock path names a different directory");
    }
    const names = readdirSync(state.lockPath).sort();
    const expectedNames = [state.ownerPath.slice(state.lockPath.length + 1)];
    if (
      names.length !== expectedNames.length ||
      names.some((name, index) => name !== expectedNames[index])
    ) {
      throw new Error("lock protocol entries changed");
    }
    const ownerEntry = lstatSync(state.ownerPath);
    if (!sameProtocolFile(state.ownerFile, ownerEntry)) {
      throw new Error("owner record changed");
    }
    if (ownerEntry.size > OWNER_FILE_MAX_BYTES) {
      throw new Error("owner record exceeds its size limit");
    }
    const ownerBytes = readFileSync(state.ownerPath);
    const owner = parseOwner(
      new TextDecoder("utf-8", { fatal: true }).decode(ownerBytes),
      state.owner.token,
    );
    if (owner === undefined) {
      throw new Error("owner record is malformed or names another token");
    }
  } catch (cause) {
    throw revokeWorkspaceWriteAuthority(
      state,
      "exact owner could not be revalidated",
      cause,
    );
  }
}

function ownerFileName(token: string): string {
  return `${OWNER_PREFIX}${token}${OWNER_SUFFIX}`;
}

function parseOwner(
  text: string,
  expectedToken: string | undefined,
): LockOwner | undefined {
  let parsed: Partial<LockOwner>;
  try {
    parsed = JSON.parse(text) as Partial<LockOwner>;
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

async function readOwnerFile(
  path: string,
  expectedToken: string | undefined,
): Promise<OwnerRecord | undefined> {
  let pathBefore: Stats;
  try {
    pathBefore = await lstat(path);
  } catch {
    return undefined;
  }
  if (
    pathBefore.isSymbolicLink() ||
    !pathBefore.isFile() ||
    pathBefore.nlink !== 1 ||
    pathBefore.size > OWNER_FILE_MAX_BYTES
  ) {
    return undefined;
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size > OWNER_FILE_MAX_BYTES ||
      !sameOwnerFileObservation(pathBefore, before)
    ) {
      return undefined;
    }
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
    const [after, pathAfter] = await Promise.all([handle.stat(), lstat(path)]);
    if (
      extraBytes !== 0 ||
      offset !== allocated.byteLength ||
      !sameOwnerFileObservation(before, after) ||
      !sameOwnerFileObservation(after, pathAfter)
    ) {
      return undefined;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(allocated);
    const owner = parseOwner(text, expectedToken);
    return owner === undefined ? undefined : { owner, path };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function sameOwnerFileObservation(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function readOwnerState(
  lockPath: string,
): Promise<LockOwnerState | undefined> {
  let names: string[];
  try {
    names = await readdir(lockPath);
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  const ownerNames = names.filter(
    (name) => name.startsWith(OWNER_PREFIX) && name.endsWith(OWNER_SUFFIX),
  );
  if (names.length === 0) {
    return { kind: "empty" };
  }
  if (ownerNames.length !== 1) {
    return { kind: "ambiguous" };
  }
  const name = ownerNames[0]!;
  const token = name.slice(OWNER_PREFIX.length, -OWNER_SUFFIX.length);
  const record = await readOwnerFile(join(lockPath, name), token);
  if (record === undefined) {
    return { kind: "ambiguous" };
  }
  if (names.some((entry) => entry !== name)) {
    return { kind: "ambiguous" };
  }
  return { kind: "valid", record };
}

async function observeLock(
  lockPath: string,
): Promise<LockObservation | undefined> {
  let lockInfo;
  try {
    lockInfo = await lstat(lockPath);
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  // Never follow a lock-path symlink into an unrelated directory.
  if (!lockInfo.isDirectory()) {
    throw new UnsafeWorkspaceLockPathError(lockPath);
  }

  const owner = await readOwnerState(lockPath);
  if (owner === undefined) return undefined;
  return {
    device: lockInfo.dev,
    inode: lockInfo.ino,
    owner,
  };
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveWait) => {
    setTimeout(resolveWait, milliseconds);
  });
}

async function removeEmptyDirectory(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (error) {
    if (
      systemErrorCode(error) !== "ENOENT" &&
      systemErrorCode(error) !== "ENOTEMPTY" &&
      systemErrorCode(error) !== "EEXIST"
    ) {
      throw error;
    }
  }
}

async function removeDirectoryIfSame(
  path: string,
  expected: LockObservation,
): Promise<void> {
  let current: Awaited<ReturnType<typeof lstat>>;
  try {
    current = await lstat(path);
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT") return;
    throw error;
  }
  if (current.dev === expected.device && current.ino === expected.inode) {
    await removeEmptyDirectory(path);
  }
}

async function releaseDirectoryIfSame(
  path: string,
  expected: LockObservation,
  storeRoot: string,
): Promise<void> {
  let current: Awaited<ReturnType<typeof lstat>>;
  try {
    current = await lstat(path);
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT") {
      throw new WorkspaceLockOwnershipLostError(
        storeRoot,
        "lock directory disappeared during release",
        { cause: error },
      );
    }
    throw error;
  }
  if (current.dev !== expected.device || current.ino !== expected.inode) {
    throw new WorkspaceLockOwnershipLostError(
      storeRoot,
      "lock directory was replaced during release",
    );
  }
  try {
    await rmdir(path);
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT") {
      throw new WorkspaceLockOwnershipLostError(
        storeRoot,
        "lock directory disappeared during final release",
        { cause: error },
      );
    }
    throw error;
  }
}

function validateTimingOptions(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError("invalid workspace lock timing options");
  }
}

async function unlinkExactProtocolFile(
  path: string,
  expected: ProtocolFileObservation,
  state: WorkspaceWriteAuthorityState,
  label: string,
): Promise<void> {
  let current: Stats;
  try {
    current = await lstat(path);
  } catch (cause) {
    throw ownershipLoss(state, `${label} disappeared during release`, cause);
  }
  if (!sameProtocolFile(expected, current)) {
    throw ownershipLoss(state, `${label} was replaced during release`);
  }
  try {
    await unlink(path);
  } catch (cause) {
    if (systemErrorCode(cause) === "ENOENT") {
      throw ownershipLoss(state, `${label} disappeared during unlink`, cause);
    }
    throw cause;
  }
}

/**
 * Acquire the workspace-wide cooperative mutex used by capture, restore and
 * GC. It deliberately serializes all of them first; a reader/writer scheme can
 * be introduced later without changing callers.
 */
export async function acquireWorkspaceLock(
  storeRoot: string,
  operation: string,
  options: WorkspaceLockOptions = {},
): Promise<WorkspaceLock> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  validateTimingOptions(timeoutMs);

  const binding = await bindStoreRoot(storeRoot);
  const lockPath = join(binding.path, LOCK_DIRECTORY);
  const wallStartedAt = Date.now();
  const monotonicStartedAt = performance.now();
  const owner: LockOwner = {
    token: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    operation,
    acquiredAt: wallStartedAt,
  };
  const ownerPath = join(lockPath, ownerFileName(owner.token));

  let acquired: LockObservation | undefined;
  let acquiredOwnerFile: ProtocolFileObservation | undefined;
  let firstAttempt = true;
  while (acquired === undefined) {
    if (!firstAttempt) {
      const elapsed = performance.now() - monotonicStartedAt;
      if (elapsed >= timeoutMs) {
        throw new WorkspaceLockTimeoutError(operation, timeoutMs, lockPath);
      }
    }
    firstAttempt = false;
    try {
      await mkdir(lockPath, { mode: 0o700 });
      const created = await observeLock(lockPath);
      if (created === undefined || created.owner.kind !== "empty") {
        throw new WorkspaceLockFormationChangedError();
      }
      try {
        await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        const published = await observeLock(lockPath);
        const publishedOwner = await lstat(ownerPath);
        if (
          published === undefined ||
          published.device !== created.device ||
          published.inode !== created.inode ||
          published.owner.kind !== "valid" ||
          published.owner.record.owner.token !== owner.token ||
          !publishedOwner.isFile() ||
          publishedOwner.isSymbolicLink() ||
          publishedOwner.nlink !== 1
        ) {
          throw new WorkspaceLockFormationChangedError();
        }
        acquired = published;
        acquiredOwnerFile = protocolFileObservation(publishedOwner);
      } catch (error) {
        // A formation failure cannot safely unlink through the fixed pathname:
        // an external replacement may already own it. Remove only an unchanged
        // empty directory; otherwise preserve the residue and fail closed.
        await removeDirectoryIfSame(lockPath, created);
        if (error instanceof WorkspaceLockFormationChangedError) {
          continue;
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof WorkspaceLockFormationChangedError) {
        continue;
      }
      if (systemErrorCode(error) !== "EEXIST") {
        throw error;
      }
      // Automatic stale takeover is deliberately disabled. Renaming a fixed
      // lock pathname cannot be conditioned on the inode observed earlier, so
      // an old contender could otherwise move and delete a fresh successor.
      let observed: LockObservation | undefined;
      try {
        observed = await observeLock(lockPath);
      } catch (error) {
        // Windows can briefly deny directory enumeration while the current
        // owner removes the lock. We still cannot acquire through that state,
        // so treat it as contention and let the shared deadline bound retries.
        if (isTransientContentionObservationError(error)) {
          const elapsed = performance.now() - monotonicStartedAt;
          if (elapsed < timeoutMs) {
            await wait(Math.min(50, Math.max(1, timeoutMs - elapsed)));
          }
          continue;
        }
        throw error;
      }
      if (observed === undefined) {
        continue;
      }
      const elapsed = performance.now() - monotonicStartedAt;
      if (elapsed < timeoutMs) {
        await wait(Math.min(50, Math.max(1, timeoutMs - elapsed)));
      }
    }
  }

  if (acquiredOwnerFile === undefined) {
    throw new WorkspaceLockFormationChangedError();
  }

  const authority = Object.freeze({}) as WorkspaceWriteAuthority;
  const authorityState: WorkspaceWriteAuthorityState = {
    binding,
    lockPath,
    lock: acquired,
    owner,
    ownerPath,
    ownerFile: acquiredOwnerFile,
    phase: { kind: "active" },
  };
  workspaceWriteAuthorityStates.set(authority, authorityState);

  let releaseInFlight: Promise<void> | undefined;

  const lock: WorkspaceLock = {
    operation,
    acquiredAt: owner.acquiredAt,
    async release(): Promise<void> {
      if (releaseInFlight !== undefined) {
        return releaseInFlight;
      }
      closeWorkspaceWriteAuthority(authorityState);
      releaseInFlight = (async () => {
        const current = await observeLock(lockPath);
        if (current === undefined) {
          throw ownershipLoss(
            authorityState,
            "lock directory disappeared before release",
          );
        }
        if (
          current.device !== acquired.device ||
          current.inode !== acquired.inode
        ) {
          throw ownershipLoss(
            authorityState,
            "lock directory was replaced before release",
          );
        }
        if (current.owner.kind !== "valid") {
          throw ownershipLoss(
            authorityState,
            `owner state became ${current.owner.kind} before release`,
          );
        }
        if (current.owner.record.owner.token !== owner.token) {
          throw ownershipLoss(
            authorityState,
            "owner token changed before release",
          );
        }

        await unlinkExactProtocolFile(
          ownerPath,
          authorityState.ownerFile,
          authorityState,
          "owner record",
        );
        await options.beforeFinalRelease?.();
        await releaseDirectoryIfSame(lockPath, acquired, binding.path);
      })();
      return releaseInFlight;
    },
  };
  workspaceLockAuthorities.set(lock, authority);
  return lock;
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
  closeWorkspaceWriteAuthority(workspaceWriteAuthorityStates.get(authority)!);
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
  readonly binding: DirectoryObservation;
}

export type OrderedWorkspaceLockCleanup =
  | Extract<CleanupSettlement, { readonly kind: "settled" }>
  | (Extract<CleanupSettlement, { readonly kind: "failed" }> & {
      readonly failures: readonly OrderedWorkspaceLockReleaseError[];
    });

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
    let binding: DirectoryObservation;
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
        storeRoot: binding.path,
        binding,
      });
    }
  }
  return [...unique.values()].sort((left, right) =>
    compareWorkspaceLockPhysicalOrder(left.binding, right.binding),
  );
}

/** @internal Pure ordering seam for physical-identity regression tests. */
export function compareWorkspaceLockPhysicalOrder(
  left: PhysicalWorkspaceOrderKey,
  right: PhysicalWorkspaceOrderKey,
): number {
  if (left.device !== right.device) return left.device < right.device ? -1 : 1;
  if (left.inode !== right.inode) return left.inode < right.inode ? -1 : 1;
  return Buffer.from(left.path).compare(Buffer.from(right.path));
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
        workspaceWriteAuthorityStates.get(authority)!,
      );
    }
  }
  const failures: OrderedWorkspaceLockReleaseError[] = [];
  for (let index = acquired.length - 1; index >= 0; index -= 1) {
    const member = acquired[index]!;
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
        acquiredBinding.device !== target.binding.device ||
        acquiredBinding.inode !== target.binding.inode
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
