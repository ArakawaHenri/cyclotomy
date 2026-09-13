import { lstatSync } from "node:fs";
import { join } from "node:path";

import {
  loadNativeFileLock,
  type NativeFileLockBinding,
  type NativeLockFile,
} from "./native-file-lock.ts";
import { systemErrorCode } from "./system-error.ts";

const DEMAND_FILE = "foreground.lock";
const POLL_MS = 25;

function openDemandFile(storeRoot: string, binding: NativeFileLockBinding) {
  const path = join(storeRoot, DEMAND_FILE);
  let handle: NativeLockFile;
  try {
    handle = binding.open(path, true);
  } catch (cause) {
    if (systemErrorCode(cause) !== "EEXIST") throw cause;
    const existing = lstatSync(path);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error("foreground demand path is not a regular file");
    }
    handle = binding.open(path);
  }
  try {
    const identity = handle.stat();
    const assertCurrent = (): void => {
      const current = lstatSync(path, { bigint: true });
      if (
        (identity.mode & 0o170000n) !== 0o100000n ||
        !current.isFile() ||
        current.isSymbolicLink() ||
        identity.size !== 0n ||
        current.size !== 0n ||
        identity.nlink !== 1n ||
        current.nlink !== 1n ||
        identity.dev !== current.dev ||
        identity.ino !== current.ino
      ) {
        throw new Error("foreground demand file changed identity");
      }
    };
    assertCurrent();
    return { handle, assertCurrent };
  } catch (cause) {
    handle.close();
    throw cause;
  }
}

/** Shared holders represent actual waiters; process exit releases their demand. */
export function tryHoldForegroundDemand(
  storeRoot: string,
  binding: NativeFileLockBinding,
): (() => void) | undefined {
  let handle: NativeLockFile | undefined;
  try {
    const file = openDemandFile(storeRoot, binding);
    handle = file.handle;
    if (!binding.tryAcquireShared(handle)) {
      handle.close();
      return undefined;
    }
    file.assertCurrent();
    const held = handle;
    return () => {
      // Closing the descriptor releases the advisory lock on every platform.
      try {
        held.close();
      } catch {
        // Demand is only a scheduling hint, never a workspace write authority.
      }
    };
  } catch {
    if (handle !== undefined) {
      try {
        handle.close();
      } catch {
        // An unavailable hint must not prevent ordinary workspace locking.
      }
    }
    return undefined;
  }
}

/** An exclusive probe is released immediately so foreground waiters can register. */
export async function watchForegroundDemand(storeRoot: string): Promise<{
  readonly signal: AbortSignal;
  poll(): void;
  close(): void;
}> {
  const binding = await loadNativeFileLock();
  const file = openDemandFile(storeRoot, binding);
  const cancellation = new AbortController();
  const probe = (): void => {
    if (cancellation.signal.aborted) return;
    try {
      file.assertCurrent();
      if (binding.tryAcquire(file.handle)) {
        binding.release(file.handle);
      } else {
        cancellation.abort();
      }
    } catch (cause) {
      cancellation.abort(cause);
    }
  };
  probe();
  const timer = setInterval(probe, POLL_MS);
  timer.unref();
  return {
    signal: cancellation.signal,
    poll: probe,
    close() {
      clearInterval(timer);
      file.handle.close();
    },
  };
}
