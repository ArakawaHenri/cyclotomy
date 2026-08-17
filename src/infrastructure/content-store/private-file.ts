import { constants, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";

import { retainCleanupFailure } from "../failure-settlement.ts";
import { systemErrorCode } from "../system-error.ts";

export interface PrivateFileIdentity {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mode: number;
  readonly nlink: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

export interface OpenedPrivateFile {
  readonly handle: FileHandle;
  readonly observation: Stats;
  readonly identity: PrivateFileIdentity;
}

export type PrivateFileBoundaryErrorCode =
  "namespace-invalid" | "storage-failure";

/** Low-level pathname/handle failure; callers retain their domain taxonomy. */
export class PrivateFileBoundaryError extends Error {
  readonly code: PrivateFileBoundaryErrorCode;

  constructor(
    code: PrivateFileBoundaryErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PrivateFileBoundaryError";
    this.code = code;
  }
}

function fail(
  code: PrivateFileBoundaryErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new PrivateFileBoundaryError(code, message, cause);
}

function privateRegularFile(observation: Stats): boolean {
  return (
    !observation.isSymbolicLink() &&
    observation.isFile() &&
    observation.nlink === 1 &&
    Number.isSafeInteger(observation.size) &&
    observation.size >= 0
  );
}

export function sameFileObservation(
  left: Pick<
    Stats,
    "dev" | "ino" | "size" | "mode" | "nlink" | "mtimeMs" | "ctimeMs"
  >,
  right: Pick<
    Stats,
    "dev" | "ino" | "size" | "mode" | "nlink" | "mtimeMs" | "ctimeMs"
  >,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

export function privateFileIdentity(
  path: string,
  observation: Pick<
    Stats,
    "dev" | "ino" | "size" | "mode" | "nlink" | "mtimeMs" | "ctimeMs"
  >,
): PrivateFileIdentity {
  return Object.freeze({
    path,
    dev: observation.dev,
    ino: observation.ino,
    size: observation.size,
    mode: observation.mode,
    nlink: observation.nlink,
    mtimeMs: observation.mtimeMs,
    ctimeMs: observation.ctimeMs,
  });
}

export function samePrivateFileIdentity(
  left: PrivateFileIdentity,
  right: PrivateFileIdentity,
): boolean {
  return left.path === right.path && sameFileObservation(left, right);
}

async function observe(
  path: string,
  ifPresent: boolean,
): Promise<
  | { readonly observation: Stats; readonly identity: PrivateFileIdentity }
  | undefined
> {
  let observation: Stats;
  try {
    observation = await lstat(path);
  } catch (error) {
    if (ifPresent && systemErrorCode(error) === "ENOENT") return undefined;
    fail("storage-failure", `could not inspect private file ${path}`, error);
  }
  if (!privateRegularFile(observation)) {
    fail(
      "namespace-invalid",
      `${path} is not a private single-link regular file`,
    );
  }
  return {
    observation,
    identity: privateFileIdentity(path, observation),
  };
}

export async function observePrivateFile(path: string): Promise<{
  readonly observation: Stats;
  readonly identity: PrivateFileIdentity;
}> {
  return (await observe(path, false))!;
}

export async function observePrivateFileIfPresent(
  path: string,
): Promise<
  | { readonly observation: Stats; readonly identity: PrivateFileIdentity }
  | undefined
> {
  return await observe(path, true);
}

async function pathStillNamesPrivateFile(
  path: string,
  expected: Stats,
): Promise<boolean> {
  let current: Stats;
  try {
    current = await lstat(path);
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT") return false;
    fail("storage-failure", `could not revalidate private file ${path}`, error);
  }
  return privateRegularFile(current) && sameFileObservation(current, expected);
}

function classifyOpenFailure(error: unknown): PrivateFileBoundaryErrorCode {
  switch (systemErrorCode(error)) {
    case "ENOENT":
    case "ENOTDIR":
    case "ELOOP":
    case "EISDIR":
      return "namespace-invalid";
    default:
      return "storage-failure";
  }
}

/** Only the first lstat ENOENT is an admissible miss. */
export async function openPrivateFileIfPresent(
  path: string,
  expected?: PrivateFileIdentity,
): Promise<OpenedPrivateFile | undefined> {
  const before = await observePrivateFileIfPresent(path);
  if (before === undefined) return undefined;
  if (
    expected !== undefined &&
    !samePrivateFileIdentity(expected, before.identity)
  ) {
    fail("namespace-invalid", `${path} changed after namespace discovery`);
  }

  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    fail(
      classifyOpenFailure(error),
      `${path} changed or could not be opened as a private file`,
      error,
    );
  }
  try {
    const opened = await handle.stat();
    if (
      !privateRegularFile(opened) ||
      !sameFileObservation(before.observation, opened) ||
      !(await pathStillNamesPrivateFile(path, opened))
    ) {
      fail("namespace-invalid", `${path} changed while it was opened`);
    }
    return {
      handle,
      observation: opened,
      identity: privateFileIdentity(path, opened),
    };
  } catch (error) {
    const failure = await retainCleanupFailure(
      error,
      () => handle.close(),
      `${path} validation and cleanup both failed`,
    );
    throw failure;
  }
}

/** Rebind one open handle to the exact private pathname observed at open. */
export async function revalidateOpenedPrivateFile(
  opened: OpenedPrivateFile,
): Promise<void> {
  const current = await opened.handle.stat();
  if (
    !privateRegularFile(current) ||
    !sameFileObservation(opened.observation, current) ||
    !(await pathStillNamesPrivateFile(opened.identity.path, current))
  ) {
    fail(
      "namespace-invalid",
      `${opened.identity.path} or its pathname changed after open`,
    );
  }
}
