import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

/**
 * Open an already-observed workspace pathname without letting a raced-in FIFO
 * stall the operation while it waits for a peer. This is deliberately only an
 * opening primitive: callers must still use FileHandle.stat() and bind the
 * handle back to their lstat observation before reading or mutating it.
 *
 * O_NOFOLLOW is unavailable on Windows, where the callers' pre-open lstat and
 * post-open pathname identity checks remain the final-component reparse-point
 * defense. O_NONBLOCK has no effect on ordinary disk-file I/O on supported
 * POSIX hosts, so regular-file read and write semantics are unchanged.
 */
export function openWorkspaceRegularCandidate(
  path: string,
  accessMode: number,
): Promise<FileHandle> {
  if (accessMode !== constants.O_RDONLY && accessMode !== constants.O_RDWR) {
    throw new TypeError(
      "workspace regular candidates may only be opened read-only or read-write",
    );
  }
  return open(
    path,
    accessMode | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
}
