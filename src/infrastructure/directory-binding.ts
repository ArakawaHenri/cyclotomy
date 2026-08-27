import { lstatSync, realpathSync, type Stats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";

export interface DirectoryBinding {
  readonly canonicalPath: string;
  readonly device: number;
  readonly inode: number;
}

export type DirectoryBindingFailure =
  "not-directory" | "identity-unavailable" | "changed";

export class DirectoryBindingError extends Error {
  readonly path: string;
  readonly failure: DirectoryBindingFailure;

  constructor(path: string, failure: DirectoryBindingFailure, message: string) {
    super(message);
    this.name = "DirectoryBindingError";
    this.path = path;
    this.failure = failure;
  }
}

function directoryBindingMatches(
  binding: Pick<DirectoryBinding, "device" | "inode">,
  entry: Stats,
): boolean {
  return (
    entry.isDirectory() &&
    !entry.isSymbolicLink() &&
    entry.ino !== 0 &&
    entry.dev === binding.device &&
    entry.ino === binding.inode
  );
}

/** Bind a pathname to the physical directory it currently names. */
export async function bindDirectory(
  path: string,
  label = "directory",
): Promise<DirectoryBinding> {
  const canonicalPath = await realpath(path);
  const entry = await lstat(canonicalPath);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new DirectoryBindingError(
      canonicalPath,
      "not-directory",
      `${label} is not a real directory`,
    );
  }
  if (entry.ino === 0) {
    throw new DirectoryBindingError(
      canonicalPath,
      "identity-unavailable",
      `${label} does not expose a reliable filesystem identity`,
    );
  }

  const binding: DirectoryBinding = {
    canonicalPath,
    device: entry.dev,
    inode: entry.ino,
  };
  const rebound = await realpath(path);
  const reboundEntry = await lstat(rebound);
  if (!directoryBindingMatches(binding, reboundEntry)) {
    throw new DirectoryBindingError(
      canonicalPath,
      "changed",
      `${label} changed while its identity was read`,
    );
  }
  return binding;
}

export function sameDirectoryBinding(
  left: Pick<DirectoryBinding, "device" | "inode">,
  right: Pick<DirectoryBinding, "device" | "inode">,
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

export function compareDirectoryBindings(
  left: DirectoryBinding,
  right: DirectoryBinding,
): number {
  if (left.device !== right.device) return left.device < right.device ? -1 : 1;
  if (left.inode !== right.inode) return left.inode < right.inode ? -1 : 1;
  return Buffer.from(left.canonicalPath).compare(
    Buffer.from(right.canonicalPath),
  );
}

export async function directoryStillBound(
  binding: DirectoryBinding,
  path: string,
): Promise<boolean> {
  try {
    return sameDirectoryBinding(binding, await bindDirectory(path));
  } catch {
    return false;
  }
}

/** Final synchronous identity gate immediately before a durable mutation. */
export function assertDirectoryStillBound(
  binding: DirectoryBinding,
  path: string,
  label: string,
): void {
  const canonicalPath = realpathSync(path);
  const entry = lstatSync(canonicalPath);
  const rebound = realpathSync(path);
  const reboundEntry = lstatSync(rebound);
  if (
    !directoryBindingMatches(binding, entry) ||
    !directoryBindingMatches(binding, reboundEntry)
  ) {
    throw new Error(`${label} changed before the mutation`);
  }
}
