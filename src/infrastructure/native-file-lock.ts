import { createRequire } from "node:module";
import { toNamespacedPath } from "node:path";

export interface NativeLockFileStat {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
}

/** Explicitly closed OS handles; environment exit releases outstanding files. */
export interface NativeLockFile {
  stat(): NativeLockFileStat;
  tryLock(shared?: boolean): boolean;
  unlock(): void;
  close(): void;
}

export interface NativeFileLockBinding {
  open(path: string, create?: boolean): NativeLockFile;
}

export class NativeFileLockUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      `native workspace locking is unavailable on ${process.platform}-${process.arch}`,
      { cause },
    );
    this.name = "NativeFileLockUnavailableError";
  }
}

let bindingPromise: Promise<NativeFileLockBinding> | undefined;

/** Non-blocking OS locks leave deadlines and cancellation with the caller. */
export async function loadNativeFileLock(): Promise<NativeFileLockBinding> {
  bindingPromise ??= Promise.resolve().then(() => {
    try {
      const require = createRequire(import.meta.url);
      const addon = require(
        `../../prebuilds/${process.platform}-${process.arch}/file-lock.node`,
      ) as NativeFileLockBinding;
      return Object.freeze({
        open(path: string, create = false): NativeLockFile {
          return addon.open(toNamespacedPath(path), create);
        },
      });
    } catch (cause) {
      throw new NativeFileLockUnavailableError(cause);
    }
  });
  return bindingPromise;
}
