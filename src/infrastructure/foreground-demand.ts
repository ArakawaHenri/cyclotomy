import { closeSync, constants, fstatSync, lstatSync, openSync } from "node:fs";
import { join } from "node:path";

import {
  loadNativeFileLock,
  type NativeFileLockBinding,
} from "./native-file-lock.ts";

const DEMAND_FILE = "foreground.lock";
const POLL_MS = 25;

function openDemandFile(storeRoot: string) {
  const path = join(storeRoot, DEMAND_FILE);
  const descriptor = openSync(
    path,
    constants.O_RDWR |
      constants.O_CREAT |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
    0o600,
  );
  try {
    const identity = fstatSync(descriptor, { bigint: true });
    const assertCurrent = (): void => {
      const current = lstatSync(path, { bigint: true });
      if (
        !identity.isFile() ||
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
    return { descriptor, assertCurrent };
  } catch (cause) {
    closeSync(descriptor);
    throw cause;
  }
}

/** Shared holders represent actual waiters; process exit releases their demand. */
export function tryHoldForegroundDemand(
  storeRoot: string,
  binding: NativeFileLockBinding,
): (() => void) | undefined {
  let descriptor: number | undefined;
  try {
    const file = openDemandFile(storeRoot);
    descriptor = file.descriptor;
    if (!binding.tryAcquireShared(descriptor)) {
      closeSync(descriptor);
      return undefined;
    }
    file.assertCurrent();
    const held = descriptor;
    return () => {
      // Closing the descriptor releases the advisory lock on every platform.
      try {
        closeSync(held);
      } catch {
        // Demand is only a scheduling hint, never a workspace write authority.
      }
    };
  } catch {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
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
  const file = openDemandFile(storeRoot);
  const cancellation = new AbortController();
  const probe = (): void => {
    if (cancellation.signal.aborted) return;
    try {
      file.assertCurrent();
      if (binding.tryAcquire(file.descriptor)) {
        binding.release(file.descriptor);
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
      closeSync(file.descriptor);
    },
  };
}
