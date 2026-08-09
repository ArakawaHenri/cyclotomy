import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

const LOCK_DIRECTORY = "workspace.lock";
const OWNER_PREFIX = "owner-";
const OWNER_SUFFIX = ".json";
const HEARTBEAT_PREFIX = "heartbeat-";
const STEAL_CLAIM_PREFIX = "steal-claim";
const OWNER_FILE_MAX_BYTES = 16 * 1024;
const execFileAsync = promisify(execFile);

export type ProcessIdentityResolver = (
  pid: number,
) => Promise<string | undefined>;

export interface WorkspaceLockOptions {
  /** Time to wait for another cooperative operation. Default 5 seconds. */
  readonly timeoutMs?: number;
  /** Heartbeat interval while the lock is held. Default 5 seconds. */
  readonly heartbeatMs?: number;
  /** Orphan age after which a dead owner's lock may be stolen. Default 30 seconds. */
  readonly staleMs?: number;
  readonly now?: () => number;
  /** Test/platform seam used to distinguish a live owner from PID reuse. */
  readonly identifyProcess?: ProcessIdentityResolver;
}

export interface WorkspaceLock {
  readonly operation: string;
  readonly acquiredAt: number;
  release(): Promise<void>;
}

interface LockOwner {
  readonly token: string;
  readonly pid: number;
  readonly hostname: string;
  readonly operation: string;
  readonly acquiredAt: number;
  /** OS process-start identity; null when the platform cannot provide one. */
  readonly processIdentity: string | null;
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
  readonly heartbeatMtimeMs: number;
}

interface StealClaim {
  readonly path: string;
  readonly ownerPath: string;
}

export class WorkspaceLockTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(
      `timed out after ${timeoutMs} ms waiting for the Cyclotomy workspace lock (${operation})`,
    );
    this.name = "WorkspaceLockTimeoutError";
  }
}

export class UnsafeWorkspaceLockPathError extends Error {
  constructor(path: string) {
    super(`refusing to use a non-directory Cyclotomy workspace lock: ${path}`);
    this.name = "UnsafeWorkspaceLockPathError";
  }
}

class WorkspaceLockFormationChangedError extends Error {
  constructor() {
    super("workspace lock directory changed during owner publication");
    this.name = "WorkspaceLockFormationChangedError";
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const value = Reflect.get(error, "code");
  return typeof value === "string" ? value : undefined;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means that the process exists but we are not allowed to signal it.
    return errorCode(error) !== "ESRCH";
  }
}

async function defaultProcessIdentity(
  pid: number,
): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (process.platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const fields =
        close === -1
          ? []
          : stat
              .slice(close + 2)
              .trim()
              .split(/\s+/u);
      // The suffix starts at field 3; Linux field 22 is process start ticks.
      const started = fields[19];
      return started === undefined ? undefined : `linux:${started}`;
    } catch {
      return undefined;
    }
  }
  if (
    process.platform === "darwin" ||
    process.platform === "freebsd" ||
    process.platform === "openbsd"
  ) {
    try {
      const result = await execFileAsync(
        "ps",
        ["-p", String(pid), "-o", "lstart="],
        {
          encoding: "utf8",
          timeout: 2_000,
          maxBuffer: 4_096,
          env: { ...process.env, LC_ALL: "C", LANG: "C" },
        },
      );
      const started = result.stdout.trim().replace(/\s+/gu, " ");
      return started.length === 0 ? undefined : `ps:${started}`;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

let selfProcessIdentity: Promise<string | undefined> | undefined;

function identifyCurrentProcess(
  injected: ProcessIdentityResolver | undefined,
): Promise<string | undefined> {
  if (injected !== undefined) {
    return injected(process.pid).catch(() => undefined);
  }
  selfProcessIdentity ??= defaultProcessIdentity(process.pid);
  return selfProcessIdentity;
}

function ownerFileName(token: string): string {
  return `${OWNER_PREFIX}${token}${OWNER_SUFFIX}`;
}

function heartbeatFileName(token: string): string {
  return `${HEARTBEAT_PREFIX}${token}`;
}

function stealClaimPath(
  lockPath: string,
  observation: LockObservation,
): string {
  const identity = createHash("sha256")
    .update(String(observation.device))
    .update("\0")
    .update(String(observation.inode))
    .update("\0")
    .update(
      observation.owner.kind === "valid"
        ? observation.owner.record.owner.token
        : observation.owner.kind,
    )
    .digest("hex")
    .slice(0, 32);
  return `${lockPath}.${STEAL_CLAIM_PREFIX}-${identity}`;
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
    !Number.isFinite(parsed.acquiredAt) ||
    (parsed.processIdentity !== undefined &&
      parsed.processIdentity !== null &&
      (typeof parsed.processIdentity !== "string" ||
        parsed.processIdentity.length === 0))
  ) {
    return undefined;
  }
  return {
    token: parsed.token,
    pid: parsed.pid,
    hostname: parsed.hostname,
    operation: parsed.operation,
    acquiredAt: parsed.acquiredAt,
    processIdentity:
      typeof parsed.processIdentity === "string"
        ? parsed.processIdentity
        : null,
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
    if (errorCode(error) === "ENOENT") {
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
  const allowedHeartbeat = heartbeatFileName(record.owner.token);
  if (names.some((entry) => entry !== name && entry !== allowedHeartbeat)) {
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
    if (errorCode(error) === "ENOENT") {
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
  let heartbeatMtimeMs = lockInfo.mtimeMs;
  if (owner.kind === "valid") {
    const record = owner.record;
    const heartbeatPath = join(lockPath, heartbeatFileName(record.owner.token));
    try {
      const heartbeatInfo = await lstat(heartbeatPath);
      if (!heartbeatInfo.isFile()) {
        throw new UnsafeWorkspaceLockPathError(heartbeatPath);
      }
      heartbeatMtimeMs = heartbeatInfo.mtimeMs;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw error;
      }
      // A process can die after publishing its owner record but before
      // creating the heartbeat marker. The owner-file timestamp is then the
      // conservative lease timestamp.
      try {
        const ownerInfo = await lstat(record.path);
        if (!ownerInfo.isFile()) {
          throw new UnsafeWorkspaceLockPathError(record.path);
        }
        heartbeatMtimeMs = ownerInfo.mtimeMs;
      } catch (ownerError) {
        if (errorCode(ownerError) !== "ENOENT") {
          throw ownerError;
        }
      }
    }
  }

  return {
    device: lockInfo.dev,
    inode: lockInfo.ino,
    owner,
    heartbeatMtimeMs,
  };
}

function sameLock(left: LockObservation, right: LockObservation): boolean {
  const sameOwner =
    left.owner.kind === right.owner.kind &&
    (left.owner.kind !== "valid" ||
      (right.owner.kind === "valid" &&
        left.owner.record.owner.token === right.owner.record.owner.token));
  return (
    left.device === right.device && left.inode === right.inode && sameOwner
  );
}

async function canRecoverOwner(
  owner: LockOwnerState,
  identifyProcess: ProcessIdentityResolver,
): Promise<boolean> {
  if (owner.kind === "empty") {
    // Acquisition verifies the directory inode after owner publication. A
    // process paused in this formation window cannot resume as a second owner
    // after the stale directory is renamed.
    return true;
  }
  // Multiple, malformed, or stray protocol files are not proof of an empty
  // formation. Preserve them for audit and require manual recovery.
  if (owner.kind === "ambiguous") return false;
  const record = owner.record;
  if (record.owner.hostname !== hostname()) {
    // A PID is only meaningful on its originating host. Prefer a timeout to
    // stealing a potentially live lock on a shared filesystem.
    return false;
  }
  if (!processIsAlive(record.owner.pid)) return true;
  if (record.owner.processIdentity === null) return false;
  const current = await identifyProcess(record.owner.pid).catch(
    () => undefined,
  );
  return current !== undefined && current !== record.owner.processIdentity;
}

function isStale(
  observation: LockObservation,
  staleMs: number,
  now: number,
): boolean {
  return now - observation.heartbeatMtimeMs >= staleMs;
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
      errorCode(error) !== "ENOENT" &&
      errorCode(error) !== "ENOTEMPTY" &&
      errorCode(error) !== "EEXIST"
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
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  if (current.dev === expected.device && current.ino === expected.inode) {
    await removeEmptyDirectory(path);
  }
}

async function removeStaleStealClaim(
  claimPath: string,
  staleMs: number,
  now: number,
  identifyProcess: ProcessIdentityResolver,
): Promise<boolean> {
  const observed = await observeLock(claimPath);
  if (observed === undefined) return true;
  if (
    !isStale(observed, staleMs, now) ||
    !(await canRecoverOwner(observed.owner, identifyProcess))
  ) {
    return false;
  }

  // Reobserve the directory protocol state and inode before touching a token
  // path or accepting an actually empty interrupted formation.
  const confirmed = await observeLock(claimPath);
  if (confirmed === undefined) return true;
  if (
    !sameLock(observed, confirmed) ||
    !isStale(confirmed, staleMs, now) ||
    !(await canRecoverOwner(confirmed.owner, identifyProcess))
  ) {
    return false;
  }
  if (confirmed.owner.kind === "valid") {
    await unlinkOwnedFile(confirmed.owner.record.path);
  }

  await removeEmptyDirectory(claimPath);
  return (await observeLock(claimPath)) === undefined;
}

async function acquireStealClaim(
  claimPath: string,
  staleMs: number,
  now: number,
  identifyProcess: ProcessIdentityResolver,
  processIdentity: string | undefined,
): Promise<StealClaim | undefined> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(claimPath, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return undefined;
      }
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
      if (
        !(await removeStaleStealClaim(claimPath, staleMs, now, identifyProcess))
      ) {
        return undefined;
      }
      continue;
    }

    const created = await observeLock(claimPath);
    if (created === undefined || created.owner.kind !== "empty") {
      return undefined;
    }

    const claimOwner: LockOwner = {
      token: randomUUID(),
      pid: process.pid,
      hostname: hostname(),
      operation: "stale-lock-takeover",
      acquiredAt: now,
      processIdentity: processIdentity ?? null,
    };
    const ownerPath = join(claimPath, ownerFileName(claimOwner.token));
    try {
      await writeFile(ownerPath, `${JSON.stringify(claimOwner)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      const published = await observeLock(claimPath);
      if (
        published === undefined ||
        published.device !== created.device ||
        published.inode !== created.inode ||
        published.owner.kind !== "valid" ||
        published.owner.record.owner.token !== claimOwner.token
      ) {
        throw new WorkspaceLockFormationChangedError();
      }
      return { path: claimPath, ownerPath };
    } catch (error) {
      await unlinkOwnedFile(ownerPath);
      await removeDirectoryIfSame(claimPath, created);
      if (errorCode(error) === "ENOENT") {
        return undefined;
      }
      if (error instanceof WorkspaceLockFormationChangedError) {
        return undefined;
      }
      throw error;
    }
  }
  return undefined;
}

async function releaseStealClaim(claim: StealClaim): Promise<void> {
  await unlinkOwnedFile(claim.ownerPath);
  await removeEmptyDirectory(claim.path);
}

/**
 * Remove an orphaned cooperative lock. An adjacent claim keyed to the
 * observed lock identity serializes stale takeover attempts before the
 * directory rename. Without it, two contenders can both observe owner A,
 * then the slower one can rename and delete a fresh lock B installed by the
 * faster contender.
 */
async function stealIfOrphaned(
  lockPath: string,
  staleMs: number,
  now: number,
  identifyProcess: ProcessIdentityResolver,
  processIdentity: string | undefined,
): Promise<boolean> {
  const initial = await observeLock(lockPath);
  if (initial === undefined) {
    return true;
  }
  if (
    !isStale(initial, staleMs, now) ||
    !(await canRecoverOwner(initial.owner, identifyProcess))
  ) {
    return false;
  }

  const claim = await acquireStealClaim(
    stealClaimPath(lockPath, initial),
    staleMs,
    now,
    identifyProcess,
    processIdentity,
  );
  if (claim === undefined) {
    return (await observeLock(lockPath)) === undefined;
  }

  const orphanPath = `${lockPath}.orphan-${randomUUID()}`;
  try {
    const confirmed = await observeLock(lockPath);
    if (confirmed === undefined) {
      return true;
    }
    if (
      !sameLock(initial, confirmed) ||
      !isStale(confirmed, staleMs, now) ||
      !(await canRecoverOwner(confirmed.owner, identifyProcess))
    ) {
      return false;
    }

    try {
      await rename(lockPath, orphanPath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return true;
      }
      throw error;
    }
  } finally {
    await releaseStealClaim(claim);
  }

  await rm(orphanPath, { recursive: true, force: true });
  return true;
}

function validateTimingOptions(
  timeoutMs: number,
  heartbeatMs: number,
  staleMs: number,
): void {
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 0 ||
    !Number.isFinite(heartbeatMs) ||
    heartbeatMs <= 0 ||
    !Number.isFinite(staleMs) ||
    staleMs <= heartbeatMs
  ) {
    throw new RangeError("invalid workspace lock timing options");
  }
}

async function unlinkOwnedFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
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
  const heartbeatMs = options.heartbeatMs ?? 5_000;
  const staleMs = options.staleMs ?? 30_000;
  const now = options.now ?? Date.now;
  const identifyProcess = options.identifyProcess ?? defaultProcessIdentity;
  validateTimingOptions(timeoutMs, heartbeatMs, staleMs);

  const lockPath = join(resolve(storeRoot), LOCK_DIRECTORY);
  const wallStartedAt = now();
  if (!Number.isFinite(wallStartedAt)) {
    throw new RangeError("workspace lock clock returned a non-finite value");
  }
  const monotonicStartedAt = performance.now();
  const processIdentity = await identifyCurrentProcess(options.identifyProcess);
  const owner: LockOwner = {
    token: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    operation,
    acquiredAt: wallStartedAt,
    processIdentity: processIdentity ?? null,
  };
  const ownerPath = join(lockPath, ownerFileName(owner.token));
  const heartbeatPath = join(lockPath, heartbeatFileName(owner.token));

  while (true) {
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
        await writeFile(heartbeatPath, "", {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        const published = await observeLock(lockPath);
        if (
          published === undefined ||
          published.device !== created.device ||
          published.inode !== created.inode ||
          published.owner.kind !== "valid" ||
          published.owner.record.owner.token !== owner.token
        ) {
          throw new WorkspaceLockFormationChangedError();
        }
      } catch (error) {
        await unlinkOwnedFile(heartbeatPath);
        await unlinkOwnedFile(ownerPath);
        await removeDirectoryIfSame(lockPath, created);
        if (error instanceof WorkspaceLockFormationChangedError) {
          continue;
        }
        throw error;
      }
      break;
    } catch (error) {
      if (error instanceof WorkspaceLockFormationChangedError) {
        continue;
      }
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
      const current = now();
      if (!Number.isFinite(current)) {
        throw new RangeError(
          "workspace lock clock returned a non-finite value",
        );
      }
      if (
        await stealIfOrphaned(
          lockPath,
          staleMs,
          current,
          identifyProcess,
          processIdentity,
        )
      ) {
        continue;
      }
      const elapsed = performance.now() - monotonicStartedAt;
      if (elapsed >= timeoutMs) {
        throw new WorkspaceLockTimeoutError(operation, timeoutMs);
      }
      await wait(Math.min(50, Math.max(1, timeoutMs - elapsed)));
    }
  }

  let releaseRequested = false;
  let releaseInFlight: Promise<void> | undefined;
  let heartbeatInFlight: Promise<void> | undefined;
  const refreshHeartbeat = (): void => {
    if (heartbeatInFlight !== undefined || releaseRequested) {
      return;
    }
    const value = now();
    if (!Number.isFinite(value)) {
      return;
    }
    const time = new Date(value);
    heartbeatInFlight = utimes(heartbeatPath, time, time)
      .catch(() => {})
      .finally(() => {
        heartbeatInFlight = undefined;
      });
  };
  const heartbeat = setInterval(refreshHeartbeat, heartbeatMs);
  heartbeat.unref();

  return {
    operation,
    acquiredAt: owner.acquiredAt,
    async release(): Promise<void> {
      if (releaseInFlight !== undefined) {
        return releaseInFlight;
      }
      releaseRequested = true;
      releaseInFlight = (async () => {
        clearInterval(heartbeat);
        await heartbeatInFlight;

        const current = await observeLock(lockPath);
        if (
          current?.owner.kind !== "valid" ||
          current.owner.record.owner.token !== owner.token
        ) {
          return;
        }

        // Every removable path includes our random token. If the fixed lock
        // path has been replaced, these unlinks cannot remove the new owner's
        // files; the final non-recursive rmdir also refuses to remove a
        // non-empty lock.
        await unlinkOwnedFile(heartbeatPath);
        await unlinkOwnedFile(ownerPath);
        await removeEmptyDirectory(lockPath);
      })();
      return releaseInFlight;
    },
  };
}

export async function withWorkspaceLock<T>(
  storeRoot: string,
  operation: string,
  action: () => Promise<T>,
  options?: WorkspaceLockOptions,
): Promise<T> {
  const lock = await acquireWorkspaceLock(storeRoot, operation, options);
  try {
    return await action();
  } finally {
    await lock.release();
  }
}
