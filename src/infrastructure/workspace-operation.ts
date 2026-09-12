import { setImmediate as yieldImmediate } from "node:timers/promises";

/** Let queued input and cancellation reach long CPU-bound storage operations. */
export async function yieldForCancellation(
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await yieldImmediate();
  signal?.throwIfAborted();
}

export interface WorkspaceProgress {
  readonly files: number;
  readonly bytes: number;
}

export interface WorkspaceOperationOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: WorkspaceProgress) => void;
}

/** Cleanup failures attached to an abort must remain operational failures. */
export function isOperationCancelled(
  error: unknown,
  signal?: AbortSignal,
): boolean {
  if (signal?.aborted !== true) return false;
  let cause = error;
  while (!(cause instanceof AggregateError)) {
    if (cause === signal.reason) {
      return !(cause instanceof Error) || cause.cause === undefined;
    }
    if (!(cause instanceof Error) || cause.cause === undefined) return false;
    cause = cause.cause;
  }
  return false;
}
