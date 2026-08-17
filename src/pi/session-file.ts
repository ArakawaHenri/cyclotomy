import { SessionManager } from "@earendil-works/pi-coding-agent";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import {
  projectStableGraph,
  readPublicTreeObservation,
  type StableCoordinate,
} from "./extension-boundary.ts";
import { projectPublicSessionCoreIdentity } from "./session-view.ts";
import { systemErrorCode } from "../infrastructure/system-error.ts";

const COPY_CHUNK_BYTES = 64 * 1024;
const MAX_COLD_PARENT_SESSION_BYTES = 64 * 1024 * 1024;

export interface PiSessionPublicObservation {
  readonly sessionId: string;
  readonly cwd: string;
  readonly stableCoordinates: readonly StableCoordinate[];
}

export type PiSessionPublicObservationResult =
  | (PiSessionPublicObservation & { readonly kind: "observed" })
  | { readonly kind: "source-missing" };

export type PiSessionSourceRejectionKind =
  "invalid-path" | "not-regular" | "empty" | "too-large";

/** A structural source fact proved before Pi parses the private copy. */
export class PiSessionSourceRejectedError extends Error {
  readonly kind: PiSessionSourceRejectionKind;

  constructor(kind: PiSessionSourceRejectionKind, message: string) {
    super(message);
    this.name = "PiSessionSourceRejectedError";
    this.kind = kind;
  }
}

async function runWithCleanup<T>(
  body: () => Promise<T>,
  cleanup: () => Promise<void>,
  aggregateMessage: string,
): Promise<T> {
  let bodyOutcome:
    | { readonly kind: "returned"; readonly value: T }
    | { readonly kind: "threw"; readonly error: unknown };
  try {
    bodyOutcome = { kind: "returned", value: await body() };
  } catch (error) {
    bodyOutcome = { kind: "threw", error };
  }

  let cleanupOutcome:
    | { readonly kind: "returned" }
    | { readonly kind: "threw"; readonly error: unknown };
  try {
    await cleanup();
    cleanupOutcome = { kind: "returned" };
  } catch (error) {
    cleanupOutcome = { kind: "threw", error };
  }

  if (bodyOutcome.kind === "threw" && cleanupOutcome.kind === "threw") {
    throw new AggregateError(
      [bodyOutcome.error, cleanupOutcome.error],
      aggregateMessage,
      {
        cause: bodyOutcome.error,
      },
    );
  }
  if (bodyOutcome.kind === "threw") throw bodyOutcome.error;
  if (cleanupOutcome.kind === "threw") throw cleanupOutcome.error;
  return bodyOutcome.value;
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileVersion(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function requireRegularFile(stat: BigIntStats): void {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new PiSessionSourceRejectedError(
      "not-regular",
      "Pi parent session must be a real regular file",
    );
  }
  if (stat.size === 0n) {
    // SessionManager.open() intentionally initializes an empty explicit path.
    // A fork parent, however, must already identify a persisted source.
    throw new PiSessionSourceRejectedError(
      "empty",
      "Pi parent session is empty",
    );
  }
  if (stat.size > BigInt(MAX_COLD_PARENT_SESSION_BYTES)) {
    throw new PiSessionSourceRejectedError(
      "too-large",
      "Pi parent session exceeds the supported copy limit",
    );
  }
}

async function reboundPath(path: string): Promise<BigIntStats> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    throw new Error("Pi parent session changed while it was copied", {
      cause: error,
    });
  }
}

async function copyFixedSnapshot(
  source: FileHandle,
  destination: FileHandle,
  size: number,
): Promise<void> {
  const buffer = Buffer.allocUnsafe(Math.min(COPY_CHUNK_BYTES, size || 1));
  let position = 0;
  while (position < size) {
    const length = Math.min(buffer.length, size - position);
    const { bytesRead } = await source.read(buffer, 0, length, position);
    if (bytesRead === 0) {
      throw new Error("Pi parent session changed while it was copied");
    }
    let written = 0;
    while (written < bytesRead) {
      const result = await destination.write(
        buffer,
        written,
        bytesRead - written,
        position + written,
      );
      if (result.bytesWritten === 0) {
        throw new Error("Could not copy the Pi parent session");
      }
      written += result.bytesWritten;
    }
    position += bytesRead;
  }
}

/**
 * Inspect an inactive parent through Pi's public SessionManager API.
 *
 * Pi may migrate a session when it opens it, so the original file is never
 * passed to SessionManager.open().  A bounded snapshot is copied from one
 * fixed descriptor into a private temporary directory; any migration is then
 * confined to that disposable copy.
 */
export async function readPiSessionPublicObservation(
  sessionFile: string,
): Promise<PiSessionPublicObservationResult> {
  if (
    sessionFile.length === 0 ||
    sessionFile.includes("\0") ||
    !isAbsolute(sessionFile) ||
    resolve(sessionFile) !== sessionFile
  ) {
    throw new PiSessionSourceRejectedError(
      "invalid-path",
      "Pi parent session path must be canonical and absolute",
    );
  }

  let before: BigIntStats;
  try {
    before = await lstat(sessionFile, { bigint: true });
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT") {
      return { kind: "source-missing" };
    }
    throw error;
  }
  requireRegularFile(before);
  let source: FileHandle;
  try {
    source = await open(
      sessionFile,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    // The path existed at the initial observation. Losing it before the fixed
    // descriptor is acquired is a race, not durable evidence of absence.
    if (systemErrorCode(error) === "ENOENT") {
      throw new Error("Pi parent session changed before it was copied", {
        cause: error,
      });
    }
    throw error;
  }
  let temporaryRoot: string | undefined;
  return runWithCleanup(
    async () => {
      const opened = await source.stat({ bigint: true });
      const bound = await reboundPath(sessionFile);
      if (!sameFileVersion(before, opened) || !sameFileVersion(opened, bound)) {
        throw new Error("Pi parent session changed before it was copied");
      }
      requireRegularFile(opened);
      requireRegularFile(bound);

      temporaryRoot = await mkdtemp(join(tmpdir(), "cyclotomy-pi-parent-"));
      const copyPath = join(temporaryRoot, "session.jsonl");
      const destination = await open(
        copyPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      await runWithCleanup(
        () => copyFixedSnapshot(source, destination, Number(opened.size)),
        () => destination.close(),
        "Pi parent session copy and destination cleanup both failed",
      );

      const after = await source.stat({ bigint: true });
      const rebound = await reboundPath(sessionFile);
      if (!sameFileVersion(opened, after) || !sameFileVersion(after, rebound)) {
        throw new Error("Pi parent session changed while it was copied");
      }
      requireRegularFile(after);
      requireRegularFile(rebound);

      // Public open may migrate/rewrite copyPath. No Pi parser or migration
      // implementation is reproduced in Cyclotomy.
      const manager = SessionManager.open(copyPath, temporaryRoot);
      const identity = projectPublicSessionCoreIdentity(manager);
      if (identity.cwd !== identity.sessionCwd) {
        throw new Error(
          "Pi parent session manager and header cwd do not match",
        );
      }
      const tree = readPublicTreeObservation(manager);
      return Object.freeze({
        kind: "observed" as const,
        sessionId: identity.sessionId,
        cwd: identity.sessionCwd,
        stableCoordinates: projectStableGraph(tree.entries).coordinates,
      });
    },
    async () => {
      const failures: unknown[] = [];
      try {
        await source.close();
      } catch (error) {
        failures.push(error);
      }
      if (temporaryRoot !== undefined) {
        try {
          await rm(temporaryRoot, { recursive: true, force: true });
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          "Pi parent session source and scratch cleanup both failed",
        );
      }
    },
    "Pi parent session observation and cleanup both failed",
  );
}
