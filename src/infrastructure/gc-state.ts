import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { retainCleanupFailure } from "./failure-settlement.ts";
import { systemErrorCode } from "./system-error.ts";
import {
  assertWorkspaceWriteAuthority,
  type WorkspaceWriteAuthority,
} from "./workspace-lock.ts";

/** A malformed timestamp cannot prevent collection of unreferenced objects. */
export async function readLastAutomaticGcAt(path: string): Promise<number> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (cause) {
    if (systemErrorCode(cause) === "ENOENT") return 0;
    throw cause;
  }
  try {
    const parsed = JSON.parse(contents) as { lastGcAt?: unknown };
    const timestamp = parsed.lastGcAt;
    return typeof timestamp === "number" &&
      Number.isFinite(timestamp) &&
      timestamp >= 0 &&
      timestamp <= Date.now()
      ? timestamp
      : 0;
  } catch {
    return 0;
  }
}

/** @internal Atomic schedule publisher with a synchronous mutation fence. */
export async function writeLastAutomaticGcAt(
  path: string,
  lastGcAt: number,
  authority: WorkspaceWriteAuthority,
  /** Deterministic test seam after the temporary is durable, before publish. */
  beforePublish?: () => void,
): Promise<void> {
  const storeRoot = dirname(path);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let temporaryCreated = false;
  try {
    assertWorkspaceWriteAuthority(authority, storeRoot);
    handle = await open(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    temporaryCreated = true;
    assertWorkspaceWriteAuthority(authority, storeRoot);
    await handle.writeFile(`${JSON.stringify({ lastGcAt })}\n`, "utf8");
    assertWorkspaceWriteAuthority(authority, storeRoot);
    await handle.sync();
    await handle.close();
    handle = undefined;
    beforePublish?.();
    assertWorkspaceWriteAuthority(authority, storeRoot);
    await rename(temporary, path);
    temporaryCreated = false;
  } catch (error) {
    let failure = error;
    if (handle !== undefined) {
      failure = await retainCleanupFailure(
        failure,
        () => handle!.close(),
        "automatic GC schedule write and file cleanup both failed",
      );
    }
    if (temporaryCreated) {
      let cleanupAuthorized = false;
      try {
        assertWorkspaceWriteAuthority(authority, storeRoot);
        cleanupAuthorized = true;
      } catch {
        // Lock cleanup independently reports ownership loss. Leaving this
        // UUID-named private temporary is safer than mutating a new owner.
      }
      if (cleanupAuthorized) {
        failure = await retainCleanupFailure(
          failure,
          () => unlink(temporary),
          "automatic GC schedule write and temporary-file cleanup both failed",
        );
      }
    }
    throw failure;
  }
}
