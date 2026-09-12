/** Return the first actionable failure retained by nested AggregateErrors. */
export function primaryFailure(error: unknown): unknown {
  let primary = error;
  const visited = new Set<AggregateError>();
  while (
    primary instanceof AggregateError &&
    primary.errors.length > 0 &&
    primary.errors[0] !== primary &&
    !visited.has(primary)
  ) {
    visited.add(primary);
    primary = primary.errors[0];
  }
  return primary;
}

/** Whether a classified failure also retained a mandatory cleanup failure. */
export function hasRetainedCleanupFailure(error: unknown): boolean {
  return (
    error instanceof AggregateError ||
    (error instanceof Error && error.cause instanceof AggregateError)
  );
}

function appendFailure(
  failure: unknown,
  failures: unknown[],
  visited: Set<AggregateError>,
): void {
  if (!(failure instanceof AggregateError) || visited.has(failure)) {
    failures.push(failure);
    return;
  }
  visited.add(failure);
  if (failure.errors.length === 0) {
    failures.push(failure);
    return;
  }
  for (const nested of failure.errors) {
    if (nested === failure) failures.push(nested);
    else appendFailure(nested, failures, visited);
  }
}

/** Flatten failures in deterministic primary-before-cleanup order. */
export function aggregateFailures(
  failures: readonly unknown[],
  message: string,
): AggregateError {
  const flattened: unknown[] = [];
  const visited = new Set<AggregateError>();
  for (const failure of failures) {
    appendFailure(failure, flattened, visited);
  }
  return new AggregateError(flattened, message, { cause: flattened[0] });
}

/** Preserve an Error's identity and taxonomy while attaching cleanup evidence. */
export function retainFailureCause(
  primary: unknown,
  cleanup: unknown,
  message: string,
): unknown {
  if (primary === cleanup) return primary;
  if (!(primary instanceof Error)) {
    return aggregateFailures([primary, cleanup], message);
  }
  if (primary instanceof AggregateError) {
    let retainedMessage = message;
    try {
      const actionable = primaryFailure(primary);
      if (actionable instanceof Error && actionable.message.length > 0) {
        retainedMessage = actionable.message;
      }
    } catch {
      // The complete error list below remains authoritative.
    }
    return aggregateFailures([primary, cleanup], retainedMessage);
  }
  try {
    const existingCause = primary.cause;
    const retainedCause =
      existingCause === undefined
        ? cleanup
        : existingCause === cleanup
          ? cleanup
          : aggregateFailures([existingCause, cleanup], message);
    Object.defineProperty(primary, "cause", {
      configurable: true,
      writable: true,
      value: retainedCause,
    });
    return primary;
  } catch {
    let primaryMessage = message;
    try {
      if (primary.message.length > 0) primaryMessage = primary.message;
    } catch {
      // A hostile Error subclass must not hide either retained failure.
    }
    return new AggregateError([primary, cleanup], primaryMessage, {
      cause: primary,
    });
  }
}

/** Run cleanup without discarding a failure that already occurred. */
export async function retainCleanupFailure(
  primary: unknown,
  cleanup: () => Promise<void>,
  message: string,
): Promise<unknown> {
  try {
    await cleanup();
    return primary;
  } catch (cleanupError) {
    return aggregateFailures([primary, cleanupError], message);
  }
}

/** Settle one action and its mandatory cleanup exactly once. */
export async function withRetainedCleanup<T>(
  action: () => Promise<T>,
  cleanup: () => Promise<void>,
  message: string,
): Promise<T> {
  let failed = false;
  let failure: unknown;
  let result: T | undefined;
  try {
    result = await action();
  } catch (error) {
    failed = true;
    failure = error;
  }
  if (failed) throw await retainCleanupFailure(failure, cleanup, message);
  await cleanup();
  return result as T;
}
