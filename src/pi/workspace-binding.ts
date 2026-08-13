import { lstatSync, realpathSync, type Stats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";

/** One canonical directory pathname bound to the real object it currently names. */
export interface DirectoryBinding {
  readonly canonicalPath: string;
  readonly device: number;
  readonly inode: number;
}

export type WorkspaceBinding = DirectoryBinding;

function sameIdentity(binding: DirectoryBinding, entry: Stats): boolean {
  return (
    entry.isDirectory() &&
    !entry.isSymbolicLink() &&
    entry.dev === binding.device &&
    entry.ino === binding.inode
  );
}

async function observeDirectory(
  path: string,
  label: string,
): Promise<DirectoryBinding> {
  const canonicalPath = await realpath(path);
  const entry = await lstat(canonicalPath);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`${label} is not a real directory`);
  }
  const rebound = await realpath(path);
  const reboundEntry = await lstat(rebound);
  const binding: DirectoryBinding = {
    canonicalPath,
    device: entry.dev,
    inode: entry.ino,
  };
  if (!sameIdentity(binding, reboundEntry)) {
    throw new Error(`${label} changed while its identity was read`);
  }
  return binding;
}

/** Bind a pathname to the real directory object it currently names. */
export function bindDirectory(
  path: string,
  label = "directory",
): Promise<DirectoryBinding> {
  return observeDirectory(path, label);
}

export function sameDirectoryBinding(
  left: DirectoryBinding,
  right: DirectoryBinding,
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

/** Re-observe one pathname against a previously bound directory object. */
export async function directoryStillBound(
  binding: DirectoryBinding,
  path: string,
): Promise<boolean> {
  try {
    const current = await observeDirectory(path, "directory");
    return sameDirectoryBinding(binding, current);
  } catch {
    return false;
  }
}

/** Synchronous final gate immediately before a mutation of bound state. */
export function assertDirectoryStillBound(
  binding: DirectoryBinding,
  path: string,
  label: string,
): void {
  const canonicalPath = realpathSync(path);
  const entry = lstatSync(canonicalPath);
  const rebound = realpathSync(path);
  const reboundEntry = lstatSync(rebound);
  if (!sameIdentity(binding, entry) || !sameIdentity(binding, reboundEntry)) {
    throw new Error(`${label} changed before Cyclotomy's metadata cutover`);
  }
}

/**
 * Bind Pi's effective and persisted workspace paths to one directory object.
 * Comparing both observations with the same identity prevents two individually
 * true checks from being spliced across a symlink rebound.
 */
export async function bindSessionWorkspace(
  cwd: string,
  sessionCwd: string,
): Promise<WorkspaceBinding> {
  const [effective, persisted] = await Promise.all([
    observeDirectory(cwd, "Pi workspace"),
    observeDirectory(sessionCwd, "Pi workspace"),
  ]);
  if (!sameDirectoryBinding(effective, persisted)) {
    throw new Error("Pi opened this session outside its persisted workspace");
  }
  return effective;
}

/** Re-observe both Pi paths against one previously bound directory object. */
export async function sessionWorkspaceStillBound(
  binding: WorkspaceBinding,
  cwd: string,
  sessionCwd: string,
): Promise<boolean> {
  try {
    const [effective, persisted] = await Promise.all([
      observeDirectory(cwd, "Pi workspace"),
      observeDirectory(sessionCwd, "Pi workspace"),
    ]);
    return (
      sameDirectoryBinding(binding, effective) &&
      sameDirectoryBinding(binding, persisted)
    );
  } catch {
    return false;
  }
}

/**
 * Final synchronous authority gate. Callers must enter their synchronous
 * metadata transaction immediately after this check, without an intervening
 * await. Cooperative workspace locks cover Cyclotomy writers; the duplicate
 * path observation closes ordinary alias rebound and delete/recreate races.
 */
export function assertSessionWorkspaceStillBound(
  binding: WorkspaceBinding,
  cwd: string,
  sessionCwd: string,
): void {
  for (const path of [cwd, sessionCwd]) {
    assertDirectoryStillBound(binding, path, "Pi workspace");
  }
}
