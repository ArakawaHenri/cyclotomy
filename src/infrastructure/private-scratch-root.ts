import { type BigIntStats } from "node:fs";
import { lstat, mkdtemp, realpath, rmdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { systemErrorCode } from "./system-error.ts";

type PrivateScratchRootErrorCode =
  | "parent-forbidden"
  | "no-safe-parent"
  | "creation-invalid"
  | "cleanup-replaced"
  | "operation-failed";

/** Infrastructure failure; consumers retain their domain error vocabulary. */
export class PrivateScratchRootError extends Error {
  readonly code: PrivateScratchRootErrorCode;
  readonly path: string;

  constructor(
    code: PrivateScratchRootErrorCode,
    path: string,
    cause?: unknown,
  ) {
    super(
      `private scratch ${code} at ${path}${
        cause instanceof Error ? `: ${cause.message}` : ""
      }`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "PrivateScratchRootError";
    this.code = code;
    this.path = path;
  }
}

export interface PrivateScratchRoot {
  readonly path: string;
  dispose(): Promise<void>;
}

interface DirectoryReceipt {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

function receipt(path: string, observation: BigIntStats): DirectoryReceipt {
  if (observation.ino === 0n) {
    fail(
      "operation-failed",
      path,
      new Error("directory identity is unavailable"),
    );
  }
  return Object.freeze({ path, dev: observation.dev, ino: observation.ino });
}

function sameDirectory(
  expected: DirectoryReceipt,
  observation: BigIntStats,
): boolean {
  return (
    observation.isDirectory() &&
    !observation.isSymbolicLink() &&
    observation.dev === expected.dev &&
    observation.ino === expected.ino
  );
}

function samePhysicalDirectory(
  left: DirectoryReceipt,
  right: DirectoryReceipt,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function fail(
  code: PrivateScratchRootErrorCode,
  path: string,
  cause?: unknown,
): never {
  throw new PrivateScratchRootError(code, path, cause);
}

async function canonicalDirectory(path: string): Promise<DirectoryReceipt> {
  let canonical: string;
  let observation: BigIntStats;
  try {
    canonical = await realpath(path);
    observation = await lstat(canonical, { bigint: true });
  } catch (cause) {
    fail("operation-failed", path, cause);
  }
  if (!observation.isDirectory() || observation.isSymbolicLink()) {
    fail("operation-failed", canonical);
  }
  return receipt(canonical, observation);
}

async function isAtOrBelow(
  candidate: DirectoryReceipt,
  roots: readonly DirectoryReceipt[],
): Promise<boolean> {
  if (roots.length === 0) return false;
  let current = candidate;
  while (true) {
    if (roots.some((root) => samePhysicalDirectory(root, current))) return true;
    const parent = await canonicalDirectory(dirname(current.path));
    if (samePhysicalDirectory(parent, current)) return false;
    current = parent;
  }
}

async function selectParent(
  initial: string,
  policy: "exact" | "nearest-safe-ancestor",
  forbidden: readonly DirectoryReceipt[],
): Promise<DirectoryReceipt> {
  let candidate = await canonicalDirectory(initial);
  while (await isAtOrBelow(candidate, forbidden)) {
    if (policy === "exact") {
      fail("parent-forbidden", candidate.path);
    }
    const ancestor = await canonicalDirectory(dirname(candidate.path));
    if (samePhysicalDirectory(candidate, ancestor)) {
      fail("no-safe-parent", candidate.path);
    }
    candidate = ancestor;
  }
  return candidate;
}

async function assertCurrent(
  expected: DirectoryReceipt,
  code: "creation-invalid" | "cleanup-replaced",
): Promise<void> {
  let current: BigIntStats;
  try {
    current = await lstat(expected.path, { bigint: true });
  } catch (cause) {
    fail(code, expected.path, cause);
  }
  if (!sameDirectory(expected, current)) {
    fail(code, expected.path);
  }
}

/** Rebind a canonical root to its direct physical parent without text equality. */
async function assertBoundChild(
  root: DirectoryReceipt,
  parent: DirectoryReceipt,
  code: "creation-invalid" | "cleanup-replaced",
): Promise<void> {
  let canonical: string;
  let rootNow: BigIntStats;
  let physicalParent: DirectoryReceipt;
  try {
    canonical = await realpath(root.path);
    [rootNow, physicalParent] = await Promise.all([
      lstat(canonical, { bigint: true }),
      canonicalDirectory(dirname(canonical)),
    ]);
  } catch (cause) {
    fail(code, root.path, cause);
  }
  if (
    !sameDirectory(root, rootNow) ||
    !samePhysicalDirectory(parent, physicalParent)
  ) {
    fail(code, root.path);
  }
  // `realpath` proves where the name resolved during the check; direct
  // observations prove that neither the root nor its selected parent is now
  // a symlink that merely points back to the same inode.
  await Promise.all([assertCurrent(root, code), assertCurrent(parent, code)]);
}

async function removeCreatedEmptyRoot(
  root: DirectoryReceipt,
  parent: DirectoryReceipt,
): Promise<void> {
  try {
    const [rootNow, parentNow] = await Promise.all([
      lstat(root.path, { bigint: true }),
      lstat(parent.path, { bigint: true }),
    ]);
    if (!sameDirectory(root, rootNow) || !sameDirectory(parent, parentNow))
      return;
    // Failed authentication never authorizes recursive cleanup.
    await rmdir(root.path);
  } catch {
    // Preserve an unauthenticated, replaced, or non-empty path for inspection.
  }
}

function ownedRoot(
  root: DirectoryReceipt,
  parent: DirectoryReceipt,
): PrivateScratchRoot {
  let disposal: Promise<void> | undefined;
  return Object.freeze({
    path: root.path,
    dispose(): Promise<void> {
      disposal ??= (async () => {
        let current: BigIntStats;
        try {
          current = await lstat(root.path, { bigint: true });
        } catch (cause) {
          if (systemErrorCode(cause) === "ENOENT") {
            await assertCurrent(parent, "cleanup-replaced");
            return;
          }
          fail("operation-failed", root.path, cause);
        }
        if (!sameDirectory(root, current)) {
          fail("cleanup-replaced", root.path);
        }
        await assertCurrent(parent, "cleanup-replaced");
        await assertBoundChild(root, parent, "cleanup-replaced");

        // Node has no fd-relative recursive removal. Recheck both physical
        // identities immediately before rm; same-uid races remain outside the
        // process-local trust boundary.
        await Promise.all([
          assertCurrent(root, "cleanup-replaced"),
          assertCurrent(parent, "cleanup-replaced"),
        ]);
        try {
          await rm(root.path, { recursive: true, force: false });
        } catch (cause) {
          fail("operation-failed", root.path, cause);
        }
      })();
      return disposal;
    },
  });
}

/**
 * Create one operation-local directory outside every controlled root. Parent
 * and root identities are authenticated around mkdtemp; recursive cleanup is
 * owned solely by the returned capability.
 */
export async function createPrivateScratchRoot(options: {
  readonly parent: string;
  readonly parentPolicy: "exact" | "nearest-safe-ancestor";
  readonly forbiddenRoots?: readonly string[];
  readonly prefix: string;
}): Promise<PrivateScratchRoot> {
  const forbidden = await Promise.all(
    (options.forbiddenRoots ?? []).map(canonicalDirectory),
  );
  const parent = await selectParent(
    options.parent,
    options.parentPolicy,
    forbidden,
  );

  let path: string;
  try {
    path = await mkdtemp(join(parent.path, options.prefix));
  } catch (cause) {
    fail("operation-failed", parent.path, cause);
  }

  let root: DirectoryReceipt | undefined;
  try {
    const created = await lstat(path, { bigint: true });
    if (!created.isDirectory() || created.isSymbolicLink()) {
      fail("creation-invalid", path);
    }
    root = receipt(path, created);
    await assertBoundChild(root, parent, "creation-invalid");
    if (await isAtOrBelow(root, forbidden)) {
      fail("creation-invalid", path);
    }
    await Promise.all([
      assertCurrent(root, "creation-invalid"),
      assertCurrent(parent, "creation-invalid"),
      ...forbidden.map((item) => assertCurrent(item, "creation-invalid")),
    ]);
    return ownedRoot(root, parent);
  } catch (cause) {
    if (root !== undefined) await removeCreatedEmptyRoot(root, parent);
    if (cause instanceof PrivateScratchRootError) throw cause;
    fail("creation-invalid", path, cause);
  }
}
