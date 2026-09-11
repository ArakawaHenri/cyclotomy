export class MetadataError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "MetadataError";
  }
}

export class MetadataUnavailableError extends MetadataError {
  readonly path: string;
  readonly reason: "missing" | "uninitialized";

  constructor(path: string, reason: "missing" | "uninitialized") {
    super(
      `metadata at ${path} is ${reason}; existing checkpoint data must not be treated as unreferenced`,
    );
    this.name = "MetadataUnavailableError";
    this.path = path;
    this.reason = reason;
  }
}

export class MetadataVersionUnsupportedError extends MetadataError {
  readonly observedVersion: number;
  readonly supportedVersion: number;

  constructor(observedVersion: number, supportedVersion: number) {
    super(
      observedVersion > supportedVersion
        ? `metadata schema version ${observedVersion} is newer than supported version ${supportedVersion}`
        : `metadata schema version ${observedVersion} is unsupported`,
    );
    this.name = "MetadataVersionUnsupportedError";
    this.observedVersion = observedVersion;
    this.supportedVersion = supportedVersion;
  }
}

export type MetadataHistoryResetReason = "epoch-changed" | "reset-pending";

/**
 * A write carried a history generation the store no longer recognises, or the
 * session is still waiting for its first post-forget attach. Both mean the same
 * thing to a caller: this operation must not commit, and the session may only
 * continue by attaching again at a stable host boundary.
 */
export class MetadataHistoryResetError extends MetadataError {
  readonly reason: MetadataHistoryResetReason;
  readonly expectedEpoch: number;
  readonly observedEpoch: number;

  constructor(
    reason: MetadataHistoryResetReason,
    expectedEpoch: number,
    observedEpoch: number,
  ) {
    super(
      reason === "epoch-changed"
        ? `session history epoch changed from ${expectedEpoch} to ${observedEpoch}`
        : `session history reset is pending for epoch ${observedEpoch}`,
    );
    this.name = "MetadataHistoryResetError";
    this.reason = reason;
    this.expectedEpoch = expectedEpoch;
    this.observedEpoch = observedEpoch;
  }
}

/**
 * Find a retired-generation report retained anywhere in a failure's cause
 * chain. Protection and lock cleanup preserve failures as aggregate errors, so
 * the report is often nested below the operation that failed, and a caller
 * that only inspected the outermost message would retry a generation that is
 * already gone.
 */
export function metadataHistoryResetIn(
  cause: unknown,
  seen: Set<unknown> = new Set(),
): MetadataHistoryResetError | undefined {
  if (seen.has(cause)) return undefined;
  seen.add(cause);
  if (cause instanceof MetadataHistoryResetError) return cause;
  if (cause instanceof AggregateError) {
    for (const nested of cause.errors) {
      const found = metadataHistoryResetIn(nested, seen);
      if (found !== undefined) return found;
    }
  }
  if (cause instanceof Error && cause.cause !== undefined) {
    return metadataHistoryResetIn(cause.cause, seen);
  }
  return undefined;
}

/**
 * The stored history no longer matches the fingerprint a maintenance preview
 * authenticated, so applying that preview would delete something unreviewed.
 */
export class MetadataFingerprintChangedError extends MetadataError {
  constructor(detail: string) {
    super(`session history changed after it was previewed: ${detail}`);
    this.name = "MetadataFingerprintChangedError";
  }
}
