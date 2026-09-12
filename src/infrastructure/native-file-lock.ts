import type * as FsNativeExtensions from "fs-native-extensions";

/**
 * Whole-file locks implemented by the operating system. The lock
 * is owned by the open file description, so unrelated open/close calls in the
 * same process cannot release it, and process termination releases it without
 * touching the file. Acquisition is always non-blocking; callers own deadline
 * and cancellation so no thread-pool wait is uninterruptible.
 */
export interface NativeFileLockBinding {
  tryAcquire(fd: number): boolean;
  tryAcquireShared(fd: number): boolean;
  release(fd: number): void;
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

function loadBinding(): Promise<NativeFileLockBinding> {
  bindingPromise ??= import("fs-native-extensions").then(
    (module: typeof FsNativeExtensions) =>
      Object.freeze({
        tryAcquire(fd: number): boolean {
          return module.tryLock(fd);
        },
        tryAcquireShared(fd: number): boolean {
          return module.tryLock(fd, 0, 0, { shared: true });
        },
        release(fd: number): void {
          module.unlock(fd);
        },
      }),
  );
  return bindingPromise;
}

/** Resolve the platform binding once; failures stay fail-closed and typed. */
export async function loadNativeFileLock(): Promise<NativeFileLockBinding> {
  try {
    return await loadBinding();
  } catch (cause) {
    if (cause instanceof NativeFileLockUnavailableError) throw cause;
    throw new NativeFileLockUnavailableError(cause);
  }
}
