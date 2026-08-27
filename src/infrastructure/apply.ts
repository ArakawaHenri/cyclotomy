import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  rmdir,
  stat,
  symlink,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import {
  type FileRecreationMode,
  type TreeEntry,
} from "./tree-formats/manifest-codec.ts";
import type { CurrentTreeManifest } from "./tree-formats/current.ts";
import {
  prepareWorkspaceRestorePlan,
  type WorkspacePathAlias,
} from "./restore-preparation.ts";
import type { WorkspacePathRename } from "./restore-plan.ts";
import { systemErrorCode } from "./system-error.ts";
import {
  summarizeScanProblems,
  type WorkspaceEntry,
  type WorkspaceSnapshot,
} from "./workspace-scan.ts";
import { openWorkspaceRegularCandidate } from "./workspace-file-open.ts";
import { portableWorkspacePathKey } from "./workspace-scope.ts";
import {
  addWorkspacePathAncestors,
  workspacePathIsAtOrBelow,
  workspacePathSetHasAtOrAbove,
} from "./workspace-path-relations.ts";
import {
  assertWorkspaceWriteAuthority,
  assertWorkspaceWriteAuthorityActive,
  type WorkspaceWriteAuthority,
} from "./workspace-lock.ts";

export type ApplyProblemKind =
  "write-failed" | "delete-failed" | "mkdir-failed" | "read-failed";

export interface ApplyProblem {
  readonly path: string;
  readonly kind: ApplyProblemKind;
  readonly detail: string;
}

/**
 * Diff result of one apply run. The path buckets cover file and symlink
 * paths only: `created` holds target paths absent from the current
 * snapshot, `updated` holds file/symlink paths whose type, content, or target
 * text changed (including file<->directory migrations), `deleted` holds
 * current paths the target drops entirely, and `renamed` records physical
 * directory spelling changes. Other pruned directories are implicit structure
 * and are not listed; every per-path failure lands in `problems` without
 * aborting the remaining paths.
 */
export interface ApplyReport {
  readonly created: readonly string[];
  readonly updated: readonly string[];
  readonly deleted: readonly string[];
  readonly renamed: readonly WorkspacePathRename[];
  readonly unchangedCount: number;
  readonly problems: readonly ApplyProblem[];
}

/**
 * Preflight failures only: the current inventory is incomplete or stale at a
 * replacement boundary, the target lacks platform-required creation metadata,
 * or the workspace root is unavailable. Per-path failures raced after this
 * preflight are reported in ApplyReport.problems instead of being thrown.
 */
export class ApplyError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ApplyError";
  }
}

type RegularTargetEntry = Extract<TreeEntry, { readonly type: "regular" }>;
type SymlinkTargetEntry = Extract<TreeEntry, { readonly type: "symlink" }>;

const GIT_INTERNAL_DETAIL = "git-internal path refused";
const UNOBSERVED_PATH_DETAIL =
  "refusing to replace a path that exists but was absent from the current inventory";
const BLOCKED_ANCESTOR_DETAIL =
  "refusing to mutate below an unsafe or unavailable target directory";
const APPLY_WRITE_WINDOW_BYTES = 1024 * 1024;

interface WorkspaceWriteAccess {
  readonly writeAuthority: WorkspaceWriteAuthority;
  readonly storeRoot: string;
}

type WorkspaceMutationCutover = () => WorkspaceWriteAccess;

/**
 * A restore may spend an arbitrary amount of time in asynchronous preflight.
 * The first mutation is the synchronous business cutover from observation to
 * mutation. Every later destructive unit reauthenticates the physical lock;
 * writes within one already-authorized file stream only need to confirm that
 * this process has not closed or revoked the authority. A rejected gate stays
 * rejected so per-path error collection can never let a later path mutate. A
 * no-op apply never enters.
 */
class WorkspaceMutationGate {
  #state:
    | { readonly kind: "ready" }
    | { readonly kind: "authorized"; readonly access: WorkspaceWriteAccess }
    | { readonly kind: "rejected"; readonly cause: unknown } = {
    kind: "ready",
  };
  readonly #cutover: WorkspaceMutationCutover;

  constructor(cutover: WorkspaceMutationCutover) {
    this.#cutover = cutover;
  }

  authorizeMutation(): void {
    if (this.#state.kind === "rejected") throw this.#state.cause;

    try {
      if (this.#state.kind === "ready") {
        const access = this.#cutover();
        this.#state = { kind: "authorized", access };
      }
      assertWorkspaceWriteAuthority(
        this.#state.access.writeAuthority,
        this.#state.access.storeRoot,
      );
    } catch (error) {
      this.#state = { kind: "rejected", cause: error };
      throw error;
    }
  }

  continueMutation(): void {
    if (this.#state.kind === "ready") {
      this.authorizeMutation();
      return;
    }
    if (this.#state.kind === "rejected") throw this.#state.cause;
    try {
      assertWorkspaceWriteAuthorityActive(
        this.#state.access.writeAuthority,
        this.#state.access.storeRoot,
      );
    } catch (error) {
      this.#state = { kind: "rejected", cause: error };
      throw error;
    }
  }

  throwIfRejected(): void {
    if (this.#state.kind === "rejected") throw this.#state.cause;
  }
}

function errorDetail(action: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${action}: ${message}`;
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function pathDepth(relativePath: string): number {
  return relativePath.split("/").length;
}

/**
 * Defense in depth: scanners and manifests never carry git internals, but a
 * path that still names a `.git` component (NFC-normalized, case-insensitive)
 * must never be created, modified, or deleted by an apply run.
 */
function isGitInternalPath(relativePath: string): boolean {
  return relativePath
    .split("/")
    .some((component) => portableWorkspacePathKey(component) === ".git");
}

/** Publish a missing/recreated regular file through an atomic sibling rename. */
async function writeRegularAtomically(
  absolute: string,
  blobOid: string,
  streamBlob: ApplyBlobStreamReader,
  writeWindow: Uint8Array,
  recreationMode: FileRecreationMode,
  beforeCommit: () => Promise<void>,
  mutationGate: WorkspaceMutationGate,
): Promise<void> {
  const temporary = join(
    dirname(absolute),
    `.cyclotomy-${process.pid}-${randomUUID()}.tmp`,
  );
  let handle: FileHandle | undefined;
  let temporaryCreated = false;
  try {
    await beforeCommit();
    mutationGate.authorizeMutation();
    handle = await open(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    temporaryCreated = true;
    await streamBlobIntoHandle(
      handle,
      blobOid,
      streamBlob,
      writeWindow,
      mutationGate,
    );
    if (process.platform !== "win32" && recreationMode !== null) {
      mutationGate.authorizeMutation();
      await handle.chmod(recreationMode);
    }
    mutationGate.authorizeMutation();
    await handle.sync();
    await handle.close();
    handle = undefined;
    await beforeCommit();
    mutationGate.authorizeMutation();
    await rename(temporary, absolute);
  } catch (error) {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // Preserve the original write failure.
      }
    }
    if (temporaryCreated) {
      try {
        mutationGate.authorizeMutation();
        await unlink(temporary);
      } catch (cleanupError) {
        if (systemErrorCode(cleanupError) !== "ENOENT") {
          // Orphan temporary files are inert; preserve the original failure.
        }
      }
    }
    throw error;
  }
}

function sameInode(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertSingleLinkRegular(metadata: Stats, detail: string): void {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error(detail);
  }
}

async function assertPathBindsOpenedRegular(
  absolute: string,
  opened: Stats,
): Promise<void> {
  const pathNow = await lstat(absolute);
  if (
    pathNow.isSymbolicLink() ||
    !pathNow.isFile() ||
    !sameInode(pathNow, opened)
  ) {
    throw new Error("regular file pathname no longer names the opened inode");
  }
}

async function hashOpenedRegular(
  handle: FileHandle,
  maximumBytes: number,
): Promise<{ readonly byteLength: number; readonly sha256: string }> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let byteLength = 0;
  while (true) {
    const { bytesRead } = await handle.read(
      buffer,
      0,
      buffer.byteLength,
      byteLength,
    );
    if (bytesRead === 0) break;
    byteLength += bytesRead;
    if (byteLength > maximumBytes) {
      throw new Error("regular file grew while its content was verified");
    }
    hash.update(buffer.subarray(0, bytesRead));
  }
  return { byteLength, sha256: hash.digest("hex") };
}

function assertStableRead(before: Stats, after: Stats): void {
  if (
    !sameInode(before, after) ||
    before.size !== after.size ||
    before.nlink !== after.nlink ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  ) {
    throw new Error("regular file changed while its content was verified");
  }
}

async function writeAll(
  handle: FileHandle,
  content: Uint8Array,
  mutationGate: WorkspaceMutationGate,
  position = 0,
): Promise<void> {
  let offset = 0;
  while (offset < content.byteLength) {
    mutationGate.continueMutation();
    const { bytesWritten } = await handle.write(
      content,
      offset,
      content.byteLength - offset,
      position + offset,
    );
    if (bytesWritten === 0) {
      throw new Error("zero-byte write during in-place regular-file rewrite");
    }
    offset += bytesWritten;
  }
}

export type ApplyBlobStreamReader = (
  oid: string,
  sink: (chunk: Uint8Array) => Promise<void>,
) => Promise<{ readonly decodedLength: number }>;

async function streamBlobIntoHandle(
  handle: FileHandle,
  oid: string,
  streamBlob: ApplyBlobStreamReader,
  writeWindow: Uint8Array,
  mutationGate: WorkspaceMutationGate,
): Promise<number> {
  const hash = createHash("sha256");
  let byteLength = 0;
  let writtenLength = 0;
  let bufferedLength = 0;

  const write = async (content: Uint8Array): Promise<void> => {
    await writeAll(handle, content, mutationGate, writtenLength);
    writtenLength += content.byteLength;
  };
  const flush = async (): Promise<void> => {
    if (bufferedLength === 0) return;
    await write(writeWindow.subarray(0, bufferedLength));
    bufferedLength = 0;
  };

  const streamed = await streamBlob(oid, async (chunk) => {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const remaining = chunk.byteLength - offset;
      if (bufferedLength === 0 && remaining >= writeWindow.byteLength) {
        await write(chunk.subarray(offset, offset + writeWindow.byteLength));
        offset += writeWindow.byteLength;
        continue;
      }
      const copied = Math.min(
        remaining,
        writeWindow.byteLength - bufferedLength,
      );
      writeWindow.set(chunk.subarray(offset, offset + copied), bufferedLength);
      bufferedLength += copied;
      offset += copied;
      if (bufferedLength === writeWindow.byteLength) await flush();
    }
    hash.update(chunk);
    byteLength += chunk.byteLength;
  });
  await flush();
  if (streamed.decodedLength !== byteLength || hash.digest("hex") !== oid) {
    throw new Error("blob stream does not match its content id");
  }
  return byteLength;
}

/**
 * Rewrite a changed regular file through its already-opened inode. This is
 * deliberately not a rename: owner, ACLs, xattrs, flags, and mode remain the
 * host filesystem's responsibility and naturally stay attached to the inode.
 * The tradeoff is explicit: unlike creation through a temporary sibling, an
 * in-place rewrite is not single-file atomic, so a crash or I/O error after
 * truncate can leave partial content. Every observable failure is reported by
 * the caller and a later restore can retry it.
 */
async function rewriteRegularInPlace(
  absolute: string,
  blobOid: string,
  streamBlob: ApplyBlobStreamReader,
  writeWindow: Uint8Array,
  observed: Extract<WorkspaceEntry, { readonly kind: "regular" }>,
  validateAncestors: () => Promise<void>,
  mutationGate: WorkspaceMutationGate,
): Promise<void> {
  await validateAncestors();
  const handle = await openWorkspaceRegularCandidate(
    absolute,
    constants.O_RDWR,
  );
  try {
    const opened = await handle.stat();
    assertSingleLinkRegular(
      opened,
      "existing path is no longer a single-link regular file",
    );
    await assertPathBindsOpenedRegular(absolute, opened);

    const beforeRead = await handle.stat();
    assertSingleLinkRegular(
      beforeRead,
      "existing path is no longer a single-link regular file",
    );
    const previous = await hashOpenedRegular(handle, observed.byteLength);
    const afterRead = await handle.stat();
    assertSingleLinkRegular(
      afterRead,
      "existing path is no longer a single-link regular file",
    );
    assertStableRead(beforeRead, afterRead);
    if (
      previous.byteLength !== observed.byteLength ||
      previous.sha256 !== observed.sha256
    ) {
      throw new Error("regular file content changed after scan");
    }

    // Tighten the pathname race window as far as Node's path-based APIs
    // permit before the first destructive operation. The opened handle is
    // the sole object truncated and written from this point onward.
    await validateAncestors();
    const beforeCommit = await handle.stat();
    assertSingleLinkRegular(
      beforeCommit,
      "existing path is no longer a single-link regular file",
    );
    if (!sameInode(opened, beforeCommit)) {
      throw new Error("opened regular-file identity changed before rewrite");
    }
    await assertPathBindsOpenedRegular(absolute, opened);

    mutationGate.authorizeMutation();
    await handle.truncate(0);
    const decodedLength = await streamBlobIntoHandle(
      handle,
      blobOid,
      streamBlob,
      writeWindow,
      mutationGate,
    );
    mutationGate.authorizeMutation();
    await handle.truncate(decodedLength);
    mutationGate.authorizeMutation();
    await handle.sync();

    const beforeVerification = await handle.stat();
    assertSingleLinkRegular(
      beforeVerification,
      "rewritten inode is no longer a single-link regular file",
    );
    if (!sameInode(opened, beforeVerification)) {
      throw new Error("opened regular-file identity changed during rewrite");
    }
    const written = await hashOpenedRegular(handle, decodedLength);
    const afterVerification = await handle.stat();
    assertSingleLinkRegular(
      afterVerification,
      "rewritten inode is no longer a single-link regular file",
    );
    assertStableRead(beforeVerification, afterVerification);
    if (written.byteLength !== decodedLength || written.sha256 !== blobOid) {
      throw new Error("rewritten regular-file content failed verification");
    }
    await validateAncestors();
    await assertPathBindsOpenedRegular(absolute, opened);
  } finally {
    await handle.close();
  }
}

/** Prepare a sibling symlink and atomically rename it over a non-directory. */
async function writeSymlinkAtomically(
  absolute: string,
  target: string,
  symlinkKind: SymlinkTargetEntry["symlinkKind"],
  beforeCommit: () => Promise<void>,
  mutationGate: WorkspaceMutationGate,
): Promise<void> {
  const temporary = join(
    dirname(absolute),
    `.cyclotomy-${process.pid}-${randomUUID()}.tmp`,
  );
  let temporaryCreated = false;
  try {
    await beforeCommit();
    if (process.platform === "win32") {
      if (symlinkKind === null) {
        throw new Error(
          "cannot safely recreate a Windows symlink without a recorded target type",
        );
      }
      mutationGate.authorizeMutation();
      await symlink(
        target,
        temporary,
        symlinkKind === "directory" ? "dir" : "file",
      );
    } else {
      mutationGate.authorizeMutation();
      await symlink(target, temporary);
    }
    temporaryCreated = true;
    await beforeCommit();
    mutationGate.authorizeMutation();
    await rename(temporary, absolute);
  } catch (error) {
    if (temporaryCreated) {
      try {
        mutationGate.authorizeMutation();
        await unlink(temporary);
      } catch {
        // A stale owner must leave its inert private temporary untouched.
      }
    }
    throw error;
  }
}

function targetRecreationMode(entry: RegularTargetEntry): FileRecreationMode {
  if (process.platform === "win32") return null;
  return entry.recreationMode;
}

async function syncDirectory(
  absolute: string,
  mutationGate: WorkspaceMutationGate,
): Promise<void> {
  // Windows does not expose a portable directory FlushFileBuffers contract.
  // File contents are still fsynced; directory-entry crash durability remains
  // best-effort on that platform instead of making capture/restore unusable.
  if (process.platform === "win32") return;
  const handle = await open(
    absolute,
    constants.O_RDONLY |
      (constants.O_DIRECTORY ?? 0) |
      (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isDirectory()) {
      throw new Error("path is no longer a directory");
    }
    mutationGate.authorizeMutation();
    await handle.sync();
  } finally {
    await handle.close();
  }
}

type DirectoryObservation = WorkspaceSnapshot["directoryObservations"][number];
type ExcludedObservation = WorkspaceSnapshot["excludedOccupancies"][number];

async function assertObservedDirectory(
  workspaceRoot: string,
  observation: DirectoryObservation,
): Promise<void> {
  const absolute =
    observation.path === ""
      ? workspaceRoot
      : join(workspaceRoot, observation.path);
  const current = await lstat(absolute);
  if (
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    current.dev !== observation.dev ||
    current.ino !== observation.ino
  ) {
    throw new ApplyError(
      `workspace directory changed since scan: ${observation.path || "."}`,
    );
  }
}

async function hasExactDirectoryEntry(absolute: string): Promise<boolean> {
  const names = await readdir(dirname(absolute));
  return names.includes(basename(absolute));
}

async function assertPreparedDirectoryAlias(
  workspaceRoot: string,
  alias: WorkspacePathAlias,
): Promise<void> {
  const source = await lstat(join(workspaceRoot, alias.from));
  if (
    source.isSymbolicLink() ||
    !source.isDirectory() ||
    alias.ino === 0 ||
    source.dev !== alias.dev ||
    source.ino !== alias.ino
  ) {
    throw new Error("workspace directory alias changed after preflight");
  }
  try {
    const target = await lstat(join(workspaceRoot, alias.to));
    if (
      !alias.targetExisted ||
      target.isSymbolicLink() ||
      !target.isDirectory() ||
      target.dev !== alias.dev ||
      target.ino !== alias.ino
    ) {
      throw new Error("workspace directory alias changed after preflight");
    }
  } catch (error) {
    if (
      !alias.targetExisted &&
      (systemErrorCode(error) === "ENOENT" ||
        systemErrorCode(error) === "ENOTDIR")
    ) {
      return;
    }
    throw error;
  }
}

class CommittedDirectoryRecaseError extends Error {
  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `directory rename committed but post-commit validation failed: ${detail}`,
      { cause },
    );
    this.name = "CommittedDirectoryRecaseError";
  }
}

/**
 * Change one observed directory entry's spelling without rebuilding its
 * contents. The exact-name check rejects filesystems that accept a case-only
 * rename as a no-op; apply then fails closed without a second crash window.
 */
async function recasePreparedDirectory(
  workspaceRoot: string,
  alias: WorkspacePathAlias,
  mutationGate: WorkspaceMutationGate,
): Promise<boolean> {
  const source = join(workspaceRoot, alias.from);
  const target = join(workspaceRoot, alias.to);
  await assertPreparedDirectoryAlias(workspaceRoot, alias);
  if (await hasExactDirectoryEntry(target)) {
    if (!alias.targetExisted) {
      throw new Error("target directory spelling appeared after preflight");
    }
    return false;
  }

  mutationGate.authorizeMutation();
  await rename(source, target);
  try {
    const targetMetadata = await lstat(target);
    if (
      targetMetadata.isSymbolicLink() ||
      !targetMetadata.isDirectory() ||
      targetMetadata.dev !== alias.dev ||
      targetMetadata.ino !== alias.ino
    ) {
      throw new Error("renamed directory identity changed after commit");
    }
    if (!(await hasExactDirectoryEntry(target))) {
      throw new Error(
        "filesystem did not preserve the target directory spelling",
      );
    }
  } catch (cause) {
    throw new CommittedDirectoryRecaseError(cause);
  }
  return true;
}

function observedAncestorPaths(relativePath: string): string[] {
  const result = [""];
  let separator = relativePath.indexOf("/");
  while (separator !== -1) {
    result.push(relativePath.slice(0, separator));
    separator = relativePath.indexOf("/", separator + 1);
  }
  return result;
}

async function assertObservedAncestors(
  workspaceRoot: string,
  relativePath: string,
  observations: ReadonlyMap<string, DirectoryObservation>,
): Promise<void> {
  for (const path of observedAncestorPaths(relativePath)) {
    const observation = observations.get(path);
    if (observation !== undefined) {
      await assertObservedDirectory(workspaceRoot, observation);
    }
  }
}

function excludedKind(metadata: Stats): ExcludedObservation["kind"] {
  if (metadata.isDirectory()) return "directory";
  if (metadata.isSymbolicLink()) return "symlink";
  if (metadata.isFile()) return "regular";
  return "other";
}

async function assertExcludedObservation(
  workspaceRoot: string,
  observation: ExcludedObservation,
  directories: ReadonlyMap<string, DirectoryObservation>,
): Promise<void> {
  await assertObservedAncestors(workspaceRoot, observation.path, directories);
  const current = await lstat(join(workspaceRoot, observation.path));
  if (
    current.dev !== observation.dev ||
    current.ino !== observation.ino ||
    excludedKind(current) !== observation.kind
  ) {
    throw new ApplyError(
      `excluded workspace path changed since scan: ${observation.path}`,
    );
  }
}

async function preflightScopeBlockers(
  workspaceRoot: string,
  blockers: readonly { readonly path: string; readonly targetPath: string }[],
  excluded: ReadonlyMap<string, ExcludedObservation>,
  directories: ReadonlyMap<string, DirectoryObservation>,
): Promise<void> {
  const blocker = blockers[0];
  if (blocker === undefined) return;
  const observation = excluded.get(blocker.path);
  if (observation !== undefined) {
    try {
      await assertExcludedObservation(workspaceRoot, observation, directories);
    } catch (error) {
      throw new ApplyError(
        `refusing a stale replacement preflight for excluded path "${blocker.path}"`,
        error,
      );
    }
  }
  throw new ApplyError(
    `refusing to replace target path "${blocker.targetPath}": unmanaged descendant "${blocker.path}" would have to be deleted`,
  );
}

function currentEntryAncestor(
  relativePath: string,
  current: ReadonlyMap<string, WorkspaceEntry>,
): WorkspaceEntry | undefined {
  let separator = relativePath.lastIndexOf("/");
  while (separator !== -1) {
    const entry = current.get(relativePath.slice(0, separator));
    if (entry !== undefined) return entry;
    separator = relativePath.lastIndexOf("/", separator - 1);
  }
  return undefined;
}

function physicalAliasAncestor(
  relativePath: string,
  aliases: ReadonlyMap<string, WorkspacePathAlias>,
): WorkspacePathAlias | undefined {
  let separator = relativePath.lastIndexOf("/");
  while (separator !== -1) {
    const alias = aliases.get(relativePath.slice(0, separator));
    if (alias !== undefined) return alias;
    separator = relativePath.lastIndexOf("/", separator - 1);
  }
  return undefined;
}

async function assertUnobservedPathAbsent(
  workspaceRoot: string,
  relativePath: string,
  directories: ReadonlyMap<string, DirectoryObservation>,
): Promise<void> {
  await assertObservedAncestors(workspaceRoot, relativePath, directories);
  try {
    await lstat(join(workspaceRoot, relativePath));
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT") return;
    throw error;
  }
  throw new Error(UNOBSERVED_PATH_DETAIL);
}

async function assertWorkspaceEntryKindUnchanged(
  workspaceRoot: string,
  entry: WorkspaceEntry,
  directories: ReadonlyMap<string, DirectoryObservation>,
): Promise<void> {
  await assertObservedAncestors(workspaceRoot, entry.path, directories);
  const current = await lstat(join(workspaceRoot, entry.path));
  const matches =
    entry.kind === "regular"
      ? !current.isSymbolicLink() && current.isFile()
      : current.isSymbolicLink();
  if (!matches) {
    throw new Error(`workspace entry type changed since scan: ${entry.path}`);
  }
  await assertObservedAncestors(workspaceRoot, entry.path, directories);
}

async function assertReplacementDirectoryInventory(
  workspaceRoot: string,
  replacementRoot: string,
  current: ReadonlyMap<string, WorkspaceEntry>,
  excluded: ReadonlyMap<string, ExcludedObservation>,
  directories: ReadonlyMap<string, DirectoryObservation>,
): Promise<void> {
  const observedDirectories = [...directories.values()]
    .filter((observation) =>
      workspacePathIsAtOrBelow(observation.path, replacementRoot),
    )
    .sort((left, right) => comparePaths(left.path, right.path));
  if (observedDirectories[0]?.path !== replacementRoot) {
    throw new Error(
      "replacement directory was absent from the current inventory",
    );
  }

  // Validate the namespace kind of every managed leaf that will have to
  // disappear before this directory can become a non-directory. Content is
  // deliberately left to the existing per-path TOCTOU checks, avoiding a
  // second full-workspace hash pass on the normal restore path.
  for (const entry of current.values()) {
    if (entry.path.startsWith(`${replacementRoot}/`)) {
      await assertWorkspaceEntryKindUnchanged(
        workspaceRoot,
        entry,
        directories,
      );
    }
  }

  const expectedChildren = new Map<string, Set<string>>();
  const addKnownPath = (path: string): void => {
    if (
      path === replacementRoot ||
      !workspacePathIsAtOrBelow(path, replacementRoot)
    ) {
      return;
    }
    const parentValue = dirname(path);
    const parent = parentValue === "." ? "" : parentValue;
    if (!directories.has(parent)) return;
    const names = expectedChildren.get(parent) ?? new Set<string>();
    names.add(basename(path));
    expectedChildren.set(parent, names);
  };
  for (const path of directories.keys()) addKnownPath(path);
  for (const path of current.keys()) addKnownPath(path);
  for (const path of excluded.keys()) addKnownPath(path);

  for (const observation of observedDirectories) {
    await assertObservedDirectory(workspaceRoot, observation);
    const actual = await readdir(join(workspaceRoot, observation.path));
    await assertObservedDirectory(workspaceRoot, observation);
    const expected = [...(expectedChildren.get(observation.path) ?? [])].sort(
      comparePaths,
    );
    actual.sort(comparePaths);
    if (
      actual.length !== expected.length ||
      actual.some((name, index) => name !== expected[index])
    ) {
      throw new Error(
        `replacement directory contents changed since scan: ${observation.path}`,
      );
    }
  }
}

/** Validate every namespace root whose type or absence apply relies on. */
async function preflightReplacementNamespace(
  workspaceRoot: string,
  target: ReadonlyMap<string, TreeEntry>,
  targetDirectories: ReadonlySet<string>,
  plannedCreates: ReadonlySet<string>,
  plannedModifications: ReadonlySet<string>,
  current: ReadonlyMap<string, WorkspaceEntry>,
  excluded: ReadonlyMap<string, ExcludedObservation>,
  directories: ReadonlyMap<string, DirectoryObservation>,
  aliasesByTarget: ReadonlyMap<string, WorkspacePathAlias>,
): Promise<void> {
  const validatedEntries = new Set<string>();
  const validateEntry = async (entry: WorkspaceEntry): Promise<void> => {
    if (validatedEntries.has(entry.path)) return;
    await assertWorkspaceEntryKindUnchanged(workspaceRoot, entry, directories);
    validatedEntries.add(entry.path);
  };
  const validatedAliases = new Set<string>();
  const inventoriedAliasDirectories = new Set<string>();
  const validateAlias = async (alias: WorkspacePathAlias): Promise<void> => {
    if (validatedAliases.has(alias.to)) return;
    if (alias.sourceKind === "entry") {
      const source = current.get(alias.from);
      if (source === undefined) {
        throw new Error("workspace path alias lost its managed source entry");
      }
      await validateEntry(source);
    } else {
      const observation = directories.get(alias.from);
      if (observation === undefined) {
        throw new Error("workspace path alias lost its source directory");
      }
      await assertObservedDirectory(workspaceRoot, observation);
      const covered = [...inventoriedAliasDirectories].some((root) =>
        workspacePathIsAtOrBelow(alias.from, root),
      );
      if (!covered) {
        await assertReplacementDirectoryInventory(
          workspaceRoot,
          alias.from,
          current,
          excluded,
          directories,
        );
        inventoriedAliasDirectories.add(alias.from);
      }
    }
    const sourceNow = await lstat(join(workspaceRoot, alias.from));
    if (
      alias.ino === 0 ||
      sourceNow.dev !== alias.dev ||
      sourceNow.ino !== alias.ino ||
      (alias.sourceKind === "directory" &&
        (sourceNow.isSymbolicLink() || !sourceNow.isDirectory()))
    ) {
      throw new Error("workspace path alias changed after restore preparation");
    }
    if (alias.targetExisted) {
      const targetNow = await lstat(join(workspaceRoot, alias.to));
      if (
        targetNow.dev !== alias.dev ||
        targetNow.ino !== alias.ino ||
        excludedKind(sourceNow) !== excludedKind(targetNow)
      ) {
        throw new Error(
          "workspace path alias changed after restore preparation",
        );
      }
    } else {
      await assertUnobservedPathAbsent(workspaceRoot, alias.to, directories);
    }
    validatedAliases.add(alias.to);
  };

  try {
    for (const path of [...targetDirectories].sort(comparePaths)) {
      const entry = current.get(path);
      if (entry !== undefined) {
        await validateEntry(entry);
        continue;
      }
      const observation = directories.get(path);
      if (observation !== undefined) {
        await assertObservedDirectory(workspaceRoot, observation);
        continue;
      }
      const ancestor = currentEntryAncestor(path, current);
      if (ancestor !== undefined) {
        await validateEntry(ancestor);
        continue;
      }
      const alias =
        aliasesByTarget.get(path) ??
        physicalAliasAncestor(path, aliasesByTarget);
      if (alias !== undefined) {
        await validateAlias(alias);
        continue;
      }
      await assertUnobservedPathAbsent(workspaceRoot, path, directories);
    }

    for (const entry of target.values()) {
      if (
        !plannedCreates.has(entry.path) &&
        !plannedModifications.has(entry.path)
      ) {
        continue;
      }
      const observed = current.get(entry.path);
      if (observed !== undefined) {
        await validateEntry(observed);
        continue;
      }
      if (directories.has(entry.path)) {
        await assertReplacementDirectoryInventory(
          workspaceRoot,
          entry.path,
          current,
          excluded,
          directories,
        );
        continue;
      }
      const ancestor = currentEntryAncestor(entry.path, current);
      if (ancestor !== undefined) {
        await validateEntry(ancestor);
        continue;
      }
      const alias =
        aliasesByTarget.get(entry.path) ??
        physicalAliasAncestor(entry.path, aliasesByTarget);
      if (alias !== undefined) {
        await validateAlias(alias);
        continue;
      }
      await assertUnobservedPathAbsent(workspaceRoot, entry.path, directories);
    }
  } catch (error) {
    throw new ApplyError(
      "workspace replacement namespace changed since the current scan",
      error,
    );
  }
}

function preflightWindowsSymlinkKinds(
  target: ReadonlyMap<string, TreeEntry>,
  created: readonly string[],
  modified: readonly string[],
): void {
  if (process.platform !== "win32") return;
  const writes = new Set([...created, ...modified]);
  for (const entry of target.values()) {
    if (
      entry.type === "symlink" &&
      writes.has(entry.path) &&
      entry.symlinkKind === null
    ) {
      throw new ApplyError(
        `cannot safely recreate Windows symlink "${entry.path}" without a recorded target type`,
      );
    }
  }
}

async function assertRegularEntryUnchanged(
  absolute: string,
  entry: Extract<WorkspaceEntry, { readonly kind: "regular" }>,
): Promise<void> {
  const handle = await openWorkspaceRegularCandidate(
    absolute,
    constants.O_RDONLY,
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) {
      throw new Error("path is no longer a single-link regular file");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let byteLength = 0;
    while (true) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.byteLength,
        null,
      );
      if (bytesRead === 0) break;
      byteLength += bytesRead;
      if (byteLength > entry.byteLength) {
        throw new Error("regular file grew after scan");
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    const pathNow = await lstat(absolute);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.nlink !== after.nlink ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      pathNow.isSymbolicLink() ||
      !pathNow.isFile() ||
      pathNow.dev !== after.dev ||
      pathNow.ino !== after.ino ||
      byteLength !== entry.byteLength ||
      hash.digest("hex") !== entry.sha256
    ) {
      throw new Error("regular file content changed after scan");
    }
  } finally {
    await handle.close();
  }
}

async function assertWorkspaceEntryUnchanged(
  workspaceRoot: string,
  entry: WorkspaceEntry,
  observations: ReadonlyMap<string, DirectoryObservation>,
): Promise<void> {
  await assertObservedAncestors(workspaceRoot, entry.path, observations);
  const absolute = join(workspaceRoot, entry.path);
  if (entry.kind === "regular") {
    await assertRegularEntryUnchanged(absolute, entry);
  } else {
    const targetBytes = await readlink(absolute, { encoding: "buffer" });
    if (!targetBytes.equals(Buffer.from(entry.target, "utf8"))) {
      throw new Error("symlink target changed after scan");
    }
  }
  // A long content read must not let an ancestor swap redirect the pathname
  // mutation that immediately follows this check.
  await assertObservedAncestors(workspaceRoot, entry.path, observations);
}

/**
 * Materialize a target tree into a workspace: diff the freshly scanned
 * current snapshot against the target manifest, then delete, prune, create,
 * and rewrite paths until the workspace matches the target. Steps run in a
 * fixed order (unlink, prune directories, create directories, write regular
 * files, write symlinks) so a run is idempotent and
 * safe to re-enter: applying the same target twice leaves every path
 * unchanged. The caller owns scanning `current` beforehand and re-scanning
 * for verification afterwards.
 */
export async function applyTreeToWorkspace(
  root: string,
  target: CurrentTreeManifest,
  streamBlob: ApplyBlobStreamReader,
  current: WorkspaceSnapshot,
  cutover: WorkspaceMutationCutover,
): Promise<ApplyReport> {
  const mutationGate = new WorkspaceMutationGate(cutover);
  if (current.problems.length > 0) {
    throw new ApplyError(
      `refusing to apply from an incomplete current workspace scan: ${summarizeScanProblems(
        current.problems,
      )}`,
    );
  }
  let workspaceRoot: string;
  try {
    // Match scanner/store identity when Pi entered the workspace through a
    // symlink, and freeze that trusted root so a later symlink retarget cannot
    // redirect mutations outside the inventory we preflighted.
    workspaceRoot = await realpath(resolve(root));
  } catch (error) {
    throw new ApplyError(
      `workspace root does not exist or is not readable: ${root}`,
      error,
    );
  }
  if (current.rootPath !== workspaceRoot) {
    throw new ApplyError(
      `workspace root changed since the current inventory was scanned: ${root}`,
    );
  }
  let rootMetadata: Stats;
  try {
    rootMetadata = await stat(workspaceRoot);
  } catch (error) {
    throw new ApplyError(
      `workspace root does not exist or is not readable: ${root}`,
      error,
    );
  }
  if (!rootMetadata.isDirectory()) {
    throw new ApplyError(`workspace root is not a directory: ${root}`);
  }

  const directoryObservations = new Map<string, DirectoryObservation>();
  for (const observation of current.directoryObservations) {
    directoryObservations.set(observation.path, observation);
  }
  if (!directoryObservations.has("")) {
    throw new ApplyError("workspace inventory lacks a root identity");
  }
  // Bind the operation to the scanned root up front. Individual mutation
  // paths validate their observed ancestors and content just before commit;
  // hashing every untouched file here would make a restore re-read the
  // entire workspace solely for preflight.
  await assertObservedDirectory(workspaceRoot, directoryObservations.get("")!);

  const problems: ApplyProblem[] = [];
  const created: string[] = [];
  const updated: string[] = [];
  const deleted: string[] = [];
  const renamed: WorkspacePathRename[] = [];
  let unchangedCount = 0;
  // Directories whose entries changed, relative to the root ("" names the
  // root itself); each is fsynced once after all mutations complete.
  const dirtiedDirectories = new Set<string>();
  const blockedDirectories = new Set<string>();
  const isBlocked = (relativePath: string): boolean => {
    for (const blocked of blockedDirectories) {
      if (relativePath === blocked || relativePath.startsWith(`${blocked}/`)) {
        return true;
      }
    }
    return false;
  };
  const markDirty = (relativePath: string): void => {
    const parent = dirname(relativePath);
    dirtiedDirectories.add(parent === "." ? "" : parent);
  };

  // Index both sides, refusing git-internal paths before anything else can
  // touch them.
  const refusedPaths = new Set<string>();
  const refuseGitInternal = (relativePath: string): void => {
    if (refusedPaths.has(relativePath)) {
      return;
    }
    refusedPaths.add(relativePath);
    problems.push({
      path: relativePath,
      kind: "write-failed",
      detail: GIT_INTERNAL_DETAIL,
    });
  };

  const targetByPath = new Map<string, TreeEntry>();
  for (const entry of target.entries) {
    if (isGitInternalPath(entry.path)) {
      refuseGitInternal(entry.path);
      continue;
    }
    targetByPath.set(entry.path, entry);
  }

  const currentByPath = new Map<string, WorkspaceEntry>();
  const excludedByPath = new Map<string, ExcludedObservation>();
  for (const observation of current.excludedOccupancies) {
    if (isGitInternalPath(observation.path)) {
      refuseGitInternal(observation.path);
      continue;
    }
    excludedByPath.set(observation.path, observation);
  }
  const currentDirectories = new Set<string>();
  for (const entry of current.entries) {
    if (isGitInternalPath(entry.path)) {
      refuseGitInternal(entry.path);
      continue;
    }
    currentByPath.set(entry.path, entry);
    addWorkspacePathAncestors(entry.path, currentDirectories);
  }
  for (const directory of currentDirectories) {
    if (!directoryObservations.has(directory)) {
      throw new ApplyError(
        `workspace inventory lacks directory identity: ${directory}`,
      );
    }
  }
  let preparedRestore: Awaited<ReturnType<typeof prepareWorkspaceRestorePlan>>;
  try {
    preparedRestore = await prepareWorkspaceRestorePlan(current, target);
  } catch (error) {
    throw new ApplyError(
      "workspace replacement namespace changed since the current scan",
      error,
    );
  }
  const restorePlan = preparedRestore.plan;
  const aliasesByTarget = new Map(
    preparedRestore.workspaceAliases.map((alias) => [alias.to, alias] as const),
  );
  const aliasesBySource = new Map<string, WorkspacePathAlias[]>();
  for (const alias of preparedRestore.workspaceAliases) {
    const aliases = aliasesBySource.get(alias.from) ?? [];
    aliases.push(alias);
    aliasesBySource.set(alias.from, aliases);
  }
  await preflightScopeBlockers(
    workspaceRoot,
    restorePlan.scopeBlockers,
    excludedByPath,
    directoryObservations,
  );
  if (restorePlan.problems.length > 0) {
    throw new ApplyError(
      `refusing to apply an invalid restore plan: ${summarizeScanProblems(
        restorePlan.problems,
      )}`,
    );
  }
  preflightWindowsSymlinkKinds(
    targetByPath,
    restorePlan.created,
    restorePlan.modified,
  );
  const plannedCreates = new Set(restorePlan.created);
  const plannedDeletes = new Set(restorePlan.deleted);
  const plannedModifications = new Set(restorePlan.modified);

  // Directories are implicit ancestors of managed content paths; empty
  // directories are deliberately outside the checkpoint model.
  const targetKeptDirectories = new Set<string>();
  for (const entry of targetByPath.values()) {
    addWorkspacePathAncestors(entry.path, targetKeptDirectories);
  }
  await preflightReplacementNamespace(
    workspaceRoot,
    targetByPath,
    targetKeptDirectories,
    plannedCreates,
    plannedModifications,
    currentByPath,
    excludedByPath,
    directoryObservations,
    aliasesByTarget,
  );

  const assertCurrentPath = async (entry: WorkspaceEntry): Promise<void> => {
    await assertWorkspaceEntryUnchanged(
      workspaceRoot,
      entry,
      directoryObservations,
    );
  };
  const assertCreatedPathStillAbsent = async (
    relativePath: string,
  ): Promise<void> => {
    await assertObservedAncestors(
      workspaceRoot,
      relativePath,
      directoryObservations,
    );
    try {
      await lstat(join(workspaceRoot, relativePath));
    } catch (error) {
      if (systemErrorCode(error) === "ENOENT") return;
      throw error;
    }
    throw new Error(UNOBSERVED_PATH_DETAIL);
  };

  const blockedDirectoryReplacements = new Set<string>();
  const directoryAliases = preparedRestore.workspaceAliases
    .filter((alias) => alias.sourceKind === "directory")
    .sort(
      (left, right) =>
        pathDepth(left.from) - pathDepth(right.from) ||
        comparePaths(left.from, right.from),
    );
  const directoryRecases = directoryAliases.filter(
    (alias) => alias.canRecaseDirectory && targetKeptDirectories.has(alias.to),
  );
  const failedDirectoryAliasSources = new Set<string>();
  const committedDirectoryRecases: WorkspacePathRename[] = [];
  const pathAfterCommittedRecases = (path: string): string => {
    let current = path;
    for (const recase of committedDirectoryRecases) {
      if (workspacePathIsAtOrBelow(current, recase.from)) {
        current = `${recase.to}${current.slice(recase.from.length)}`;
      }
    }
    return current;
  };
  const copyDirectoryObservations = (from: string, to: string): void => {
    for (const observation of [...directoryObservations.values()]) {
      if (!workspacePathIsAtOrBelow(observation.path, from)) continue;
      const suffix = observation.path.slice(from.length);
      const targetPath = `${to}${suffix}`;
      directoryObservations.set(targetPath, {
        path: targetPath,
        dev: observation.dev,
        ino: observation.ino,
      });
    }
  };

  // Re-spell real directory entries only after every replacement and scope
  // boundary has passed the shared preflight. Renaming preserves empty
  // directories, which are deliberately observed for safety but absent from
  // checkpoint semantics. Keep the source observations as well: current
  // managed entries still use their scanned spelling for later validation.
  for (const alias of directoryRecases) {
    const failedAncestor = [...failedDirectoryAliasSources].some((source) =>
      workspacePathIsAtOrBelow(alias.from, source),
    );
    if (failedAncestor) {
      failedDirectoryAliasSources.add(alias.from);
      blockedDirectories.add(alias.to);
      if (targetByPath.has(alias.to)) {
        blockedDirectoryReplacements.add(alias.to);
      }
      continue;
    }
    const effectiveFrom = pathAfterCommittedRecases(alias.from);
    const effectiveAlias: WorkspacePathAlias =
      effectiveFrom === alias.from ? alias : { ...alias, from: effectiveFrom };
    const observation = directoryObservations.get(effectiveFrom);
    if (observation === undefined) {
      problems.push({
        path: alias.to,
        kind: "write-failed",
        detail: "workspace directory alias lost its scanned observation",
      });
      failedDirectoryAliasSources.add(alias.from);
      blockedDirectories.add(alias.to);
      if (targetByPath.has(alias.to)) {
        blockedDirectoryReplacements.add(alias.to);
      }
      continue;
    }
    try {
      await assertObservedAncestors(
        workspaceRoot,
        effectiveFrom,
        directoryObservations,
      );
      await assertObservedDirectory(workspaceRoot, observation);
      if (effectiveFrom === alias.to) {
        const targetMetadata = await lstat(join(workspaceRoot, alias.to));
        if (
          targetMetadata.isSymbolicLink() ||
          !targetMetadata.isDirectory() ||
          targetMetadata.dev !== alias.dev ||
          targetMetadata.ino !== alias.ino ||
          !(await hasExactDirectoryEntry(join(workspaceRoot, alias.to)))
        ) {
          throw new Error(
            "parent directory recase did not preserve the nested target alias",
          );
        }
        continue;
      }
      const changed = await recasePreparedDirectory(
        workspaceRoot,
        effectiveAlias,
        mutationGate,
      );
      copyDirectoryObservations(effectiveFrom, alias.to);
      if (changed) {
        committedDirectoryRecases.push({
          from: effectiveFrom,
          to: alias.to,
        });
        renamed.push({ from: alias.from, to: alias.to });
        markDirty(effectiveFrom);
        markDirty(alias.to);
      }
    } catch (error) {
      if (error instanceof CommittedDirectoryRecaseError) {
        renamed.push({ from: alias.from, to: alias.to });
        markDirty(alias.from);
        markDirty(alias.to);
      }
      problems.push({
        path: alias.to,
        kind: "write-failed",
        detail: errorDetail("rename directory spelling", error),
      });
      failedDirectoryAliasSources.add(alias.from);
      blockedDirectories.add(alias.to);
      if (targetByPath.has(alias.to)) {
        blockedDirectoryReplacements.add(alias.to);
      }
    }
  }

  // Step 1: unlink current files/symlinks the target does not have. File and
  // symlink replacements remain in place until a prepared sibling can rename
  // over them atomically in a later step.
  const currentEntries = [...currentByPath.values()].sort((left, right) =>
    comparePaths(left.path, right.path),
  );
  for (const currentEntry of currentEntries) {
    const relativePath = currentEntry.path;
    if (
      [...failedDirectoryAliasSources].some((source) =>
        workspacePathIsAtOrBelow(relativePath, source),
      )
    ) {
      continue;
    }
    if (targetByPath.has(relativePath)) {
      continue;
    }
    if (
      !targetKeptDirectories.has(relativePath) &&
      !plannedDeletes.has(relativePath)
    ) {
      continue;
    }
    try {
      await assertCurrentPath(currentEntry);
      mutationGate.authorizeMutation();
      await unlink(join(workspaceRoot, relativePath));
      markDirty(relativePath);
      if (targetKeptDirectories.has(relativePath)) {
        // The path survives as a directory in the target state.
        updated.push(relativePath);
      } else {
        deleted.push(relativePath);
      }
    } catch (error) {
      for (const alias of aliasesBySource.get(relativePath) ?? []) {
        blockedDirectories.add(alias.to);
        blockedDirectoryReplacements.add(alias.to);
      }
      problems.push({
        path: relativePath,
        kind: "delete-failed",
        detail: errorDetail("unlink", error),
      });
    }
  }

  // Step 2: prune directories the target no longer needs, deepest first.
  // A directory that still holds unmanaged content is kept on purpose.
  const prunableDirectories = [...currentDirectories]
    .filter(
      (relativePath) =>
        !targetKeptDirectories.has(relativePath) &&
        !directoryAliases.some((alias) =>
          workspacePathIsAtOrBelow(relativePath, alias.from),
        ),
    )
    .sort(
      (left, right) =>
        pathDepth(right) - pathDepth(left) || comparePaths(left, right),
    );
  for (const relativePath of prunableDirectories) {
    try {
      await assertObservedAncestors(
        workspaceRoot,
        relativePath,
        directoryObservations,
      );
      const observation = directoryObservations.get(relativePath);
      if (observation !== undefined) {
        await assertObservedDirectory(workspaceRoot, observation);
      }
      mutationGate.authorizeMutation();
      await rmdir(join(workspaceRoot, relativePath));
      // The pruned directory itself can no longer be fsynced; its removal
      // is covered by the parent fsync.
      directoryObservations.delete(relativePath);
      dirtiedDirectories.delete(relativePath);
      markDirty(relativePath);
    } catch (error) {
      const code = systemErrorCode(error);
      if (code === "ENOTEMPTY" || code === "ENOTDIR" || code === "EEXIST") {
        continue;
      }
      problems.push({
        path: relativePath,
        kind: "delete-failed",
        detail: errorDetail("rmdir", error),
      });
    }
  }

  // Empty directories are deliberately absent from the logical snapshot, but
  // the scanner still records their identities. A target file or symlink may
  // therefore collide with a wholly empty observed subtree without having a
  // current entry. Remove that subtree deepest-first, revalidating every
  // directory. rmdir is atomic with respect to non-emptiness, so ignored
  // content or a raced-in child makes the replacement fail closed instead of
  // being deleted.
  const directoryReplacementRootsByTarget = new Map<
    string,
    { readonly targetPath: string; readonly observedRoot: string }
  >();
  const directoryReplacementObservedRoots = new Set<string>();
  const addDirectoryReplacementRoot = (
    targetPath: string,
    observedRoot: string,
  ): void => {
    if (directoryReplacementRootsByTarget.has(targetPath)) return;
    const effectiveObservedRoot = pathAfterCommittedRecases(observedRoot);
    if (
      workspacePathSetHasAtOrAbove(
        effectiveObservedRoot,
        directoryReplacementObservedRoots,
      )
    ) {
      return;
    }
    directoryReplacementRootsByTarget.set(targetPath, {
      targetPath,
      observedRoot: effectiveObservedRoot,
    });
    directoryReplacementObservedRoots.add(effectiveObservedRoot);
  };
  for (const alias of directoryAliases) {
    if (!alias.canRecaseDirectory) {
      addDirectoryReplacementRoot(alias.to, alias.from);
    }
  }
  for (const targetPath of targetByPath.keys()) {
    if (currentByPath.has(targetPath)) continue;
    if (directoryObservations.has(targetPath)) {
      addDirectoryReplacementRoot(targetPath, targetPath);
      continue;
    }
    const alias = aliasesByTarget.get(targetPath);
    if (alias?.sourceKind === "directory") {
      addDirectoryReplacementRoot(targetPath, alias.from);
    }
  }
  const directoryReplacementRoots = [
    ...directoryReplacementRootsByTarget.values(),
  ].sort((left, right) => comparePaths(left.targetPath, right.targetPath));
  for (const { targetPath, observedRoot } of directoryReplacementRoots) {
    const observedSubtree = [...directoryObservations.keys()]
      .filter(
        (relativePath) =>
          relativePath === observedRoot ||
          relativePath.startsWith(`${observedRoot}/`),
      )
      .sort(
        (left, right) =>
          pathDepth(right) - pathDepth(left) || comparePaths(left, right),
      );
    for (const relativePath of observedSubtree) {
      try {
        await assertObservedAncestors(
          workspaceRoot,
          relativePath,
          directoryObservations,
        );
        await assertObservedDirectory(
          workspaceRoot,
          directoryObservations.get(relativePath)!,
        );
        mutationGate.authorizeMutation();
        await rmdir(join(workspaceRoot, relativePath));
        directoryObservations.delete(relativePath);
        dirtiedDirectories.delete(relativePath);
        markDirty(relativePath);
      } catch (error) {
        problems.push({
          path: relativePath,
          kind: "delete-failed",
          detail: errorDetail("rmdir before type replacement", error),
        });
        blockedDirectoryReplacements.add(targetPath);
        blockedDirectories.add(targetPath);
        break;
      }
    }
  }

  // Step 3: create target directories, shallowest first so parents exist.
  // A file or symlink sitting at a directory path is unlinked first.
  const directoriesToCreate = [...targetKeptDirectories].sort(
    (left, right) =>
      pathDepth(left) - pathDepth(right) || comparePaths(left, right),
  );
  for (const relativePath of directoriesToCreate) {
    if (isBlocked(relativePath)) {
      blockedDirectories.add(relativePath);
      continue;
    }
    const absolute = join(workspaceRoot, relativePath);
    let existing: Stats | undefined;
    try {
      existing = await lstat(absolute);
    } catch (error) {
      if (systemErrorCode(error) !== "ENOENT") {
        problems.push({
          path: relativePath,
          kind: "read-failed",
          detail: errorDetail("lstat", error),
        });
        blockedDirectories.add(relativePath);
        continue;
      }
    }
    let replacedManagedEntry = false;
    if (existing !== undefined) {
      if (!existing.isSymbolicLink() && existing.isDirectory()) {
        const observation = directoryObservations.get(relativePath);
        if (observation === undefined) {
          problems.push({
            path: relativePath,
            kind: "write-failed",
            detail: UNOBSERVED_PATH_DETAIL,
          });
          blockedDirectories.add(relativePath);
          continue;
        }
        try {
          await assertObservedDirectory(workspaceRoot, observation);
        } catch (error) {
          problems.push({
            path: relativePath,
            kind: "write-failed",
            detail: errorDetail("validate directory", error),
          });
          blockedDirectories.add(relativePath);
          continue;
        }
        if (existing.dev !== rootMetadata.dev) {
          problems.push({
            path: relativePath,
            kind: "write-failed",
            detail:
              "refusing to use a cross-device directory as a target ancestor",
          });
          blockedDirectories.add(relativePath);
        }
        continue;
      }
      if (!currentByPath.has(relativePath)) {
        problems.push({
          path: relativePath,
          kind: "write-failed",
          detail: UNOBSERVED_PATH_DETAIL,
        });
        blockedDirectories.add(relativePath);
        continue;
      }
      try {
        const observed = currentByPath.get(relativePath);
        if (observed !== undefined) {
          await assertCurrentPath(observed);
        }
        mutationGate.authorizeMutation();
        await unlink(absolute);
        markDirty(relativePath);
        replacedManagedEntry = currentByPath.has(relativePath);
      } catch (error) {
        problems.push({
          path: relativePath,
          kind: "delete-failed",
          detail: errorDetail("unlink", error),
        });
        blockedDirectories.add(relativePath);
        continue;
      }
    }
    try {
      // The earlier lstat only classified the path. Revalidate every
      // observed ancestor and the final absence immediately before mkdir so
      // an ancestor swapped for a symlink cannot redirect directory creation
      // outside the scanned workspace.
      await assertCreatedPathStillAbsent(relativePath);
      mutationGate.authorizeMutation();
      await mkdir(absolute);
      // mkdir has already changed the parent entry even if the identity
      // check below fails, so record that durability obligation immediately.
      markDirty(relativePath);
      const created = await lstat(absolute);
      if (
        created.isSymbolicLink() ||
        !created.isDirectory() ||
        created.dev !== rootMetadata.dev
      ) {
        throw new Error("created directory identity is unsafe");
      }
      directoryObservations.set(relativePath, {
        path: relativePath,
        dev: created.dev,
        ino: created.ino,
      });
      if (replacedManagedEntry) {
        // A managed file or symlink became a directory.
        updated.push(relativePath);
      }
    } catch (error) {
      problems.push({
        path: relativePath,
        kind: "mkdir-failed",
        detail: errorDetail("mkdir", error),
      });
      blockedDirectories.add(relativePath);
    }
  }

  // Classify target file/symlink entries before writing so steps 4-5 run in
  // a fixed order. A regular entry's content matches exactly when the
  // scanned SHA-256 equals the blob oid (the object store names blobs by
  // their SHA-256 digest).
  const regularWrites: Array<{
    readonly entry: RegularTargetEntry;
    readonly createdPath: boolean;
    readonly existingRegular:
      Extract<WorkspaceEntry, { readonly kind: "regular" }> | undefined;
  }> = [];
  const symlinkWrites: Array<{
    readonly entry: SymlinkTargetEntry;
    readonly createdPath: boolean;
  }> = [];
  const targetPaths = [...targetByPath.keys()].sort(comparePaths);
  for (const relativePath of targetPaths) {
    const entry = targetByPath.get(relativePath);
    if (entry === undefined) {
      continue;
    }
    const currentEntry = currentByPath.get(relativePath);
    const createdPath = plannedCreates.has(relativePath);
    if (!createdPath && !plannedModifications.has(relativePath)) {
      unchangedCount += 1;
      continue;
    }
    if (entry.type === "regular") {
      regularWrites.push({
        entry,
        createdPath,
        existingRegular:
          currentEntry?.kind === "regular" ? currentEntry : undefined,
      });
      continue;
    }
    symlinkWrites.push({
      entry,
      createdPath,
    });
  }

  // Step 4: write new and changed regular files.
  let writeWindow: Uint8Array | undefined;
  for (const { entry, createdPath, existingRegular } of regularWrites) {
    if (blockedDirectoryReplacements.has(entry.path)) {
      continue;
    }
    if (isBlocked(dirname(entry.path) === "." ? "" : dirname(entry.path))) {
      problems.push({
        path: entry.path,
        kind: "write-failed",
        detail: BLOCKED_ANCESTOR_DETAIL,
      });
      continue;
    }
    if (createdPath) {
      try {
        await lstat(join(workspaceRoot, entry.path));
        problems.push({
          path: entry.path,
          kind: "write-failed",
          detail: UNOBSERVED_PATH_DETAIL,
        });
        continue;
      } catch (error) {
        if (systemErrorCode(error) !== "ENOENT") {
          problems.push({
            path: entry.path,
            kind: "read-failed",
            detail: errorDetail("lstat before create", error),
          });
          continue;
        }
      }
    }
    try {
      const absolute = join(workspaceRoot, entry.path);
      writeWindow ??= Buffer.allocUnsafe(APPLY_WRITE_WINDOW_BYTES);
      if (existingRegular !== undefined) {
        await rewriteRegularInPlace(
          absolute,
          entry.blobOid,
          streamBlob,
          writeWindow,
          existingRegular,
          () =>
            assertObservedAncestors(
              workspaceRoot,
              entry.path,
              directoryObservations,
            ),
          mutationGate,
        );
      } else {
        const validateDestination = createdPath
          ? () => assertCreatedPathStillAbsent(entry.path)
          : () => assertCurrentPath(currentByPath.get(entry.path)!);
        await validateDestination();
        await writeRegularAtomically(
          absolute,
          entry.blobOid,
          streamBlob,
          writeWindow,
          targetRecreationMode(entry),
          validateDestination,
          mutationGate,
        );
      }
      // In-place content writes fsync the inode itself and do not mutate a
      // directory entry. Atomic publication of a missing/recreated inode does.
      if (existingRegular === undefined) {
        markDirty(entry.path);
      }
      if (createdPath) {
        created.push(entry.path);
      } else {
        updated.push(entry.path);
      }
    } catch (error) {
      problems.push({
        path: entry.path,
        kind: "write-failed",
        detail: errorDetail("write", error),
      });
    }
  }

  // Step 5: create or replace symlinks whose target text differs.
  for (const { entry, createdPath } of symlinkWrites) {
    if (blockedDirectoryReplacements.has(entry.path)) {
      continue;
    }
    if (isBlocked(dirname(entry.path) === "." ? "" : dirname(entry.path))) {
      problems.push({
        path: entry.path,
        kind: "write-failed",
        detail: BLOCKED_ANCESTOR_DETAIL,
      });
      continue;
    }
    const absolute = join(workspaceRoot, entry.path);
    try {
      if (createdPath) {
        try {
          await lstat(absolute);
          problems.push({
            path: entry.path,
            kind: "write-failed",
            detail: UNOBSERVED_PATH_DETAIL,
          });
          continue;
        } catch (error) {
          if (systemErrorCode(error) !== "ENOENT") {
            throw error;
          }
        }
      }
      await writeSymlinkAtomically(
        absolute,
        entry.target,
        entry.symlinkKind,
        createdPath
          ? () => assertCreatedPathStillAbsent(entry.path)
          : () => assertCurrentPath(currentByPath.get(entry.path)!),
        mutationGate,
      );
      markDirty(entry.path);
      if (createdPath) {
        created.push(entry.path);
      } else {
        updated.push(entry.path);
      }
    } catch (error) {
      problems.push({
        path: entry.path,
        kind: "write-failed",
        detail: errorDetail("symlink", error),
      });
    }
  }

  // Fsync every directory that gained or lost an entry, once each.
  const dirtied = [...dirtiedDirectories].sort(comparePaths);
  for (const relativePath of dirtied) {
    // A failed identity check can leave a newly created directory untrusted.
    // Its parent is still synced; never open the untrusted directory itself.
    if (!directoryObservations.has(relativePath)) {
      continue;
    }
    try {
      await assertObservedAncestors(
        workspaceRoot,
        relativePath === ""
          ? ".cyclotomy-durability-barrier"
          : `${relativePath}/.cyclotomy-durability-barrier`,
        directoryObservations,
      );
      await syncDirectory(
        relativePath === "" ? workspaceRoot : join(workspaceRoot, relativePath),
        mutationGate,
      );
    } catch (error) {
      if (systemErrorCode(error) === "ENOENT") {
        // The directory was removed after it was dirtied (e.g. a pruned
        // parent took it away); the removal is the parent's fsync concern.
        continue;
      }
      problems.push({
        path: relativePath === "" ? "." : relativePath,
        kind: "write-failed",
        detail: errorDetail("fsync directory", error),
      });
    }
  }

  created.sort(comparePaths);
  updated.sort(comparePaths);
  deleted.sort(comparePaths);
  renamed.sort((left, right) => comparePaths(left.to, right.to));
  mutationGate.throwIfRejected();
  return { created, updated, deleted, renamed, unchangedCount, problems };
}
