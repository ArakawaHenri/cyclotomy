import { mkdirSync, writeFileSync } from "node:fs";
import * as nativeBinding from "../src/infrastructure/native-file-lock.ts";
import { assertTestWorkspaceLockReleased } from "./workspace-lock-fixture.ts";
import { execFile, fork, type ChildProcess } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  bindDirectory,
  compareDirectoryBindings,
} from "../src/infrastructure/directory-binding.ts";
import {
  LockProtocolCorruptError,
  UnsupportedLockProtocolError,
  WorkspaceLockProtocolInconsistentError,
  inspectWorkspaceLock,
  quarantineLegacyWorkspaceLock,
} from "../src/infrastructure/workspace-lock.ts";
import {
  acquireWorkspaceLock,
  assertWorkspaceWriteAuthority,
  OrderedWorkspaceLockAcquisitionError,
  OrderedWorkspaceLockReleaseError,
  runWithOrderedWorkspaceLocks,
  runWithWorkspaceLock,
  withOrderedWorkspaceLocks,
  withWorkspaceLock,
  WorkspaceLockOwnershipLostError,
  WorkspaceLockTimeoutError,
  type OrderedWorkspaceAuthorities,
  type WorkspaceWriteAuthority,
} from "../src/infrastructure/workspace-lock.ts";

const roots: string[] = [];
const execFileAsync = promisify(execFile);
const children = new Set<LockChild>();
const CHILD_PROCESS_WATCHDOG_MS = 30_000;
const childFixture = fileURLToPath(
  new URL("./fixtures/workspace-lock-child.ts", import.meta.url),
);
const MARKER_BYTES = '{"format":1,"protocol":"native-file-v1"}\n';

type ChildMessage =
  | {
      readonly type: "acquired" | "released";
      readonly pid: number;
    }
  | {
      readonly type: "error";
      readonly pid: number;
      readonly name: string;
      readonly message: string;
    };

interface LockChild {
  readonly process: ChildProcess;
  readonly messages: ChildMessage[];
  readonly waiters: Set<() => void>;
  stderr: string;
  exited: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

interface ChildOptions {
  readonly timeoutMs?: number;
}

function startLockChild(
  root: string,
  operation: string,
  mode: "hold" | "once",
  options: ChildOptions = {},
): LockChild {
  const childProcess = fork(
    childFixture,
    [root, operation, mode, String(options.timeoutMs ?? 1_000)],
    {
      execArgv: ["--experimental-strip-types", "--no-warnings"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  const child: LockChild = {
    process: childProcess,
    messages: [],
    waiters: new Set(),
    stderr: "",
    exited: false,
    exitCode: null,
    signal: null,
  };
  children.add(child);
  childProcess.stderr?.on("data", (chunk: Buffer | string) => {
    child.stderr += chunk.toString();
  });
  childProcess.on("message", (message: ChildMessage) => {
    child.messages.push(message);
    for (const waiter of child.waiters) {
      waiter();
    }
    child.waiters.clear();
  });
  childProcess.once("exit", (code, signal) => {
    child.exited = true;
    child.exitCode = code;
    child.signal = signal;
    children.delete(child);
    for (const waiter of child.waiters) {
      waiter();
    }
    child.waiters.clear();
  });
  return child;
}

async function waitForMessage(
  child: LockChild,
  type: ChildMessage["type"],
  timeoutMs = CHILD_PROCESS_WATCHDOG_MS,
): Promise<ChildMessage> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const index = child.messages.findIndex((message) => message.type === type);
    if (index >= 0) {
      return child.messages.splice(index, 1)[0]!;
    }
    const unexpected = child.messages.find(
      (message) => message.type === "error",
    );
    if (unexpected !== undefined && type !== "error") {
      throw new Error(
        `lock child failed: ${unexpected.name}: ${unexpected.message}\n${child.stderr}`,
      );
    }
    if (child.exited) {
      throw new Error(
        `lock child exited before ${type}: code=${String(child.exitCode)} signal=${String(child.signal)}\n${child.stderr}`,
      );
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `timed out waiting for lock child ${type}\n${child.stderr}`,
      );
    }
    await new Promise<void>((resolveWait) => {
      const timer = setTimeout(() => {
        child.waiters.delete(onReady);
        resolveWait();
      }, remaining);
      const onReady = (): void => {
        clearTimeout(timer);
        resolveWait();
      };
      child.waiters.add(onReady);
    });
  }
}

async function waitForExit(
  child: LockChild,
  timeoutMs = CHILD_PROCESS_WATCHDOG_MS,
): Promise<void> {
  if (child.exited) {
    return;
  }
  await new Promise<void>((resolveExit, rejectExit) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolveExit();
    };
    const timer = setTimeout(() => {
      child.process.off("exit", onExit);
      rejectExit(
        new Error(`timed out waiting for child exit\n${child.stderr}`),
      );
    }, timeoutMs);
    child.process.once("exit", onExit);
  });
}

async function storeRootDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cyclotomy-lock-"));
  roots.push(root);
  return root;
}

async function orderedStoreRoots(): Promise<readonly [string, string]> {
  const root = await storeRootDirectory();
  const paths = [join(root, "a"), join(root, "z")];
  await Promise.all(paths.map((path) => mkdir(path)));
  const bindings = await Promise.all(paths.map((path) => bindDirectory(path)));
  bindings.sort(compareDirectoryBindings);
  return [bindings[0]!.canonicalPath, bindings[1]!.canonicalPath];
}

/** An idle store already using the native protocol. */
async function upgradedStoreRoot(): Promise<string> {
  const root = await storeRootDirectory();
  const lock = await acquireWorkspaceLock(root, "initialize test store");
  await lock.release();
  return root;
}

function lockPathOf(root: string): string {
  return join(root, "workspace.lock");
}

function markerPathOf(root: string): string {
  return join(root, "lock-protocol.json");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function legacyOwnerRecord(overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    token: "legacy",
    pid: 2_147_483_647,
    hostname: hostname(),
    operation: "capture",
    acquiredAt: 1,
    ...overrides,
  })}\n`;
}

/** Publish a complete legacy directory lock formation without holding it. */
async function plantLegacyLockDirectory(
  root: string,
  owners: Readonly<Record<string, string>>,
  options: { readonly aged?: boolean } = {},
): Promise<string> {
  const path = lockPathOf(root);
  await mkdir(path);
  for (const [name, contents] of Object.entries(owners)) {
    await writeFile(join(path, name), contents);
    if (options.aged === true) {
      const old = new Date(Date.now() - 10_000);
      await utimes(join(path, name), old, old);
    }
  }
  if (options.aged === true) {
    const old = new Date(Date.now() - 10_000);
    await utimes(path, old, old);
  }
  return path;
}

/**
 * Replace the fixed lock path with a directory. The next identity
 * revalidation fails permanently, which is how cleanup failures are injected
 * under the native protocol.
 */
async function displaceLockPathWithDirectory(root: string): Promise<void> {
  const path = lockPathOf(root);
  await rm(path, { force: true });
  await mkdir(path);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveWait) => {
    setTimeout(resolveWait, milliseconds);
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  const activeChildren = [...children];
  for (const child of activeChildren) {
    child.process.kill("SIGKILL");
  }
  await Promise.all(activeChildren.map((child) => waitForExit(child)));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("workspace lock native protocol", () => {
  it("initializes a fresh store with a persistent native lock file", async () => {
    const root = await storeRootDirectory();
    expect(await pathExists(lockPathOf(root))).toBe(false);
    expect(await inspectWorkspaceLock(root)).toEqual({ kind: "absent" });

    const lock = await acquireWorkspaceLock(root, "capture");

    const entry = await lstat(lockPathOf(root), { bigint: true });
    expect(entry.isFile()).toBe(true);
    expect(entry.isSymbolicLink()).toBe(false);
    expect(entry.nlink).toBe(1n);
    expect(entry.size).toBe(0n);
    expect(await readFile(markerPathOf(root), "utf8")).toBe(MARKER_BYTES);

    // The switch grants write authority only while the native lock is held.
    expect(await inspectWorkspaceLock(root)).toEqual({ kind: "native-busy" });
    await lock.release();

    // The lock file is persistent: release never unlinks or replaces it.
    const after = await lstat(lockPathOf(root), { bigint: true });
    expect(after.ino).toBe(entry.ino);
    expect(after.size).toBe(0n);
    expect(await inspectWorkspaceLock(root)).toMatchObject({
      kind: "native-acquired",
    });
    await assertTestWorkspaceLockReleased(root);
  });

  it("keeps one stable lock file across acquire and release cycles", async () => {
    const root = await upgradedStoreRoot();
    const identity = await lstat(lockPathOf(root), { bigint: true });

    const first = await acquireWorkspaceLock(root, "capture");
    await first.release();
    const second = await acquireWorkspaceLock(root, "restore");
    await second.release();

    const after = await lstat(lockPathOf(root), { bigint: true });
    expect(after.ino).toBe(identity.ino);
    expect(after.dev).toBe(identity.dev);
    expect(after.size).toBe(0n);
    expect(after.nlink).toBe(1n);
    expect(await readdir(root)).toEqual([
      "lock-protocol.json",
      "workspace.lock",
    ]);
  });

  it("cancels a waiter without disturbing the current owner", async () => {
    const root = await upgradedStoreRoot();
    const first = await acquireWorkspaceLock(root, "capture");
    const controller = new AbortController();
    const waiting = acquireWorkspaceLock(root, "next capture", {
      signal: controller.signal,
    });
    controller.abort();
    await expect(waiting).rejects.toBe(controller.signal.reason);

    await expect(
      acquireWorkspaceLock(root, "probe", { timeoutMs: 25 }),
    ).rejects.toBeInstanceOf(WorkspaceLockTimeoutError);

    await first.release();
    const next = await acquireWorkspaceLock(root, "restore");
    await next.release();
  });

  it("excludes another cooperative operation until release", async () => {
    const root = await upgradedStoreRoot();
    const first = await acquireWorkspaceLock(root, "capture", {});

    const failure = await acquireWorkspaceLock(root, "restore", {
      timeoutMs: 10,
    }).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(WorkspaceLockTimeoutError);
    expect(failure).toMatchObject({
      lockPath: join(await realpath(root), "workspace.lock"),
    });
    expect((failure as Error).message).toContain(
      "the lock may be active or abandoned",
    );
    expect((failure as Error).message).toContain("cyclotomy doctor");

    await first.release();
    const second = await acquireWorkspaceLock(root, "restore", {});
    await second.release();
  });

  it("excludes operations running in separate Node processes", async () => {
    const root = await upgradedStoreRoot();
    const holder = startLockChild(root, "capture", "hold", {});
    await waitForMessage(holder, "acquired");

    const contender = startLockChild(root, "restore", "once", {
      timeoutMs: 60,
    });
    const failure = await waitForMessage(contender, "error");
    expect(failure).toMatchObject({
      type: "error",
      name: "WorkspaceLockTimeoutError",
    });
    await waitForExit(contender);

    holder.process.send?.("release");
    await waitForMessage(holder, "released");
    await waitForExit(holder);

    const successor = startLockChild(root, "restore", "once", {});
    await waitForMessage(successor, "acquired");
    await waitForMessage(successor, "released");
    await waitForExit(successor);
  });

  it("releases the lock when the holding process is killed", async () => {
    const root = await upgradedStoreRoot();
    const before = await lstat(lockPathOf(root), { bigint: true });
    const holder = startLockChild(root, "capture", "hold", {});
    await waitForMessage(holder, "acquired");
    holder.process.kill("SIGKILL");
    await waitForExit(holder);

    // Crash release is a system property: no recovery step, no file rewrite.
    const successor = await acquireWorkspaceLock(root, "restore", {
      timeoutMs: 1_000,
    });
    await successor.release();

    const after = await lstat(lockPathOf(root), { bigint: true });
    expect(after.ino).toBe(before.ino);
    expect(after.size).toBe(0n);
    expect(await readFile(markerPathOf(root), "utf8")).toBe(MARKER_BYTES);
  });

  it("does not release the lock when another handle to the file is closed", async () => {
    const root = await upgradedStoreRoot();
    const lock = await acquireWorkspaceLock(root, "capture");
    const unrelated = await open(lockPathOf(root), "r");
    await unrelated.close();

    await expect(
      acquireWorkspaceLock(root, "probe", { timeoutMs: 25 }),
    ).rejects.toBeInstanceOf(WorkspaceLockTimeoutError);
    await lock.release();
    await assertTestWorkspaceLockReleased(root);
  });

  it("serializes opposite multi-workspace lock orders without deadlock", async () => {
    const firstRoot = await upgradedStoreRoot();
    const secondRoot = await upgradedStoreRoot();
    let active = 0;
    let maximumActive = 0;
    const action = async (): Promise<void> => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
      active -= 1;
    };
    const options = { timeoutMs: 1_000 };

    await Promise.all([
      withOrderedWorkspaceLocks(
        [
          { storeRoot: firstRoot, options },
          { storeRoot: secondRoot, options },
        ],
        "a-to-b",
        action,
      ),
      withOrderedWorkspaceLocks(
        [
          { storeRoot: secondRoot, options },
          { storeRoot: firstRoot, options },
        ],
        "b-to-a",
        action,
      ),
    ]);

    expect(maximumActive).toBe(1);
  });

  it("orders physical identities independently of bind-alias paths", () => {
    const lowIdentityThroughEarlyAlias = {
      canonicalPath: "/alias-a",
      device: 2n,
      inode: 20n,
    };
    const lowIdentityThroughLateAlias = {
      canonicalPath: "/alias-z",
      device: 2n,
      inode: 20n,
    };
    const highIdentity = {
      canonicalPath: "/alias-m",
      device: 10n,
      inode: 1n,
    };

    expect(
      [highIdentity, lowIdentityThroughEarlyAlias]
        .sort(compareDirectoryBindings)
        .map(({ canonicalPath }) => canonicalPath),
    ).toEqual(["/alias-a", "/alias-m"]);
    expect(
      [highIdentity, lowIdentityThroughLateAlias]
        .sort(compareDirectoryBindings)
        .map(({ canonicalPath }) => canonicalPath),
    ).toEqual(["/alias-z", "/alias-m"]);
    expect(
      compareDirectoryBindings(
        lowIdentityThroughEarlyAlias,
        lowIdentityThroughLateAlias,
      ),
    ).toBeLessThan(0);
  });

  it("deduplicates realpath aliases and invalidates ordered authorities after action", async () => {
    const root = await upgradedStoreRoot();
    const alias = join(root, "store-alias");
    await symlink(root, alias, "dir");
    const canonical = await realpath(root);
    let escapedAuthority:
      Parameters<typeof assertWorkspaceWriteAuthority>[0] | undefined;

    await withOrderedWorkspaceLocks(
      [{ storeRoot: alias }, { storeRoot: root }],
      "ordered-alias-test",
      async (authorities) => {
        expectTypeOf(authorities).toEqualTypeOf<OrderedWorkspaceAuthorities>();
        expect([...authorities.keys()]).toEqual([canonical]);
        const authority = authorities.get(canonical);
        if (authority === undefined) {
          throw new Error("missing canonical write authority");
        }
        assertWorkspaceWriteAuthority(authority, alias);
        escapedAuthority = authority;
      },
    );

    if (escapedAuthority === undefined)
      throw new Error("authority did not escape action");
    expect(() =>
      assertWorkspaceWriteAuthority(escapedAuthority!, root),
    ).toThrow(WorkspaceLockOwnershipLostError);
  });
});

describe("workspace lock fail-closed transitions", () => {
  it("treats an unmarked lock file as an interrupted switch and adopts its identity", async () => {
    const root = await storeRootDirectory();
    await writeFile(lockPathOf(root), "");
    const planted = await lstat(lockPathOf(root), { bigint: true });

    expect(await inspectWorkspaceLock(root)).toEqual({
      kind: "interrupted-switch",
    });

    const lock = await acquireWorkspaceLock(root, "capture");
    await lock.release();

    const adopted = await lstat(lockPathOf(root), { bigint: true });
    expect(adopted.ino).toBe(planted.ino);
    expect(adopted.size).toBe(0n);
    expect(await readFile(markerPathOf(root), "utf8")).toBe(MARKER_BYTES);
    expect(await readdir(root)).toEqual([
      "lock-protocol.json",
      "workspace.lock",
    ]);
  });

  it("refuses a marker whose lock file is missing and never recreates it", async () => {
    const root = await upgradedStoreRoot();
    await rm(lockPathOf(root));

    await expect(
      acquireWorkspaceLock(root, "capture", { timeoutMs: 0 }),
    ).rejects.toBeInstanceOf(WorkspaceLockProtocolInconsistentError);
    expect(await pathExists(lockPathOf(root))).toBe(false);
    expect(await inspectWorkspaceLock(root)).toMatchObject({
      kind: "inconsistent",
    });
  });

  it("refuses a replaced lock file while the marker is present", async () => {
    const root = await upgradedStoreRoot();
    await rm(lockPathOf(root));
    await writeFile(lockPathOf(root), "replacement");

    await expect(
      acquireWorkspaceLock(root, "capture", { timeoutMs: 0 }),
    ).rejects.toBeInstanceOf(WorkspaceLockProtocolInconsistentError);
    expect(await readFile(lockPathOf(root), "utf8")).toBe("replacement");
    expect(await inspectWorkspaceLock(root)).toMatchObject({
      kind: "inconsistent",
    });
  });

  it("refuses a directory at the fixed path while the marker is present", async () => {
    const root = await upgradedStoreRoot();
    await displaceLockPathWithDirectory(root);

    await expect(
      acquireWorkspaceLock(root, "capture", { timeoutMs: 0 }),
    ).rejects.toBeInstanceOf(WorkspaceLockProtocolInconsistentError);
    expect((await lstat(lockPathOf(root))).isDirectory()).toBe(true);
  });

  it("refuses a symlinked lock path and leaves its target untouched", async () => {
    const root = await upgradedStoreRoot();
    const outside = join(root, "outside");
    const sentinel = join(outside, "sentinel.txt");
    await mkdir(outside);
    await writeFile(sentinel, "keep");
    await rm(lockPathOf(root));
    await symlink(sentinel, lockPathOf(root));

    await expect(
      acquireWorkspaceLock(root, "capture", { timeoutMs: 0 }),
    ).rejects.toBeInstanceOf(WorkspaceLockProtocolInconsistentError);
    expect(await readFile(sentinel, "utf8")).toBe("keep");
    expect((await lstat(lockPathOf(root))).isSymbolicLink()).toBe(true);
  });

  it("refuses an unsupported protocol marker without creating a lock file", async () => {
    const root = await storeRootDirectory();
    await writeFile(
      markerPathOf(root),
      `${JSON.stringify({ format: 1, protocol: "native-file-v2" })}\n`,
    );

    await expect(
      acquireWorkspaceLock(root, "capture", { timeoutMs: 0 }),
    ).rejects.toBeInstanceOf(UnsupportedLockProtocolError);
    expect(await inspectWorkspaceLock(root)).toMatchObject({
      kind: "unsupported",
      observedFormat: 1,
      observedProtocol: "native-file-v2",
    });
    expect(await pathExists(lockPathOf(root))).toBe(false);
  });

  it("refuses a corrupt protocol marker", async () => {
    const root = await storeRootDirectory();
    await writeFile(markerPathOf(root), "{not-json\n");

    await expect(
      acquireWorkspaceLock(root, "capture", { timeoutMs: 0 }),
    ).rejects.toBeInstanceOf(LockProtocolCorruptError);
    expect(await inspectWorkspaceLock(root)).toMatchObject({
      kind: "corrupt",
    });
    expect(await pathExists(lockPathOf(root))).toBe(false);
  });

  it("leaves a legacy directory owned by a dead local process untouched", async () => {
    const root = await storeRootDirectory();
    const path = await plantLegacyLockDirectory(
      root,
      { "owner-dead.json": legacyOwnerRecord({ token: "dead" }) },
      { aged: true },
    );

    const failure = await acquireWorkspaceLock(root, "gc", {
      timeoutMs: 0,
    }).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(WorkspaceLockTimeoutError);

    expect(await inspectWorkspaceLock(root)).toMatchObject({
      kind: "legacy-directory",
      owner: { kind: "valid", owner: { token: "dead" } },
    });

    // A dead owner record is never proof that the legacy lock is free.
    await expect(
      acquireWorkspaceLock(root, "capture", { timeoutMs: 50 }),
    ).rejects.toBeInstanceOf(WorkspaceLockTimeoutError);
    expect(await readFile(join(path, "owner-dead.json"), "utf8")).toContain(
      '"token":"dead"',
    );
    expect(await pathExists(markerPathOf(root))).toBe(false);

    const quarantine = await quarantineLegacyWorkspaceLock(root);
    expect(quarantine.kind).toBe("quarantined");
    expect(await pathExists(path)).toBe(false);

    const lock = await acquireWorkspaceLock(root, "capture");
    await lock.release();
    expect(await readFile(markerPathOf(root), "utf8")).toBe(MARKER_BYTES);
  });

  it("leaves an expired ownerless legacy directory untouched", async () => {
    const root = await storeRootDirectory();
    const path = await plantLegacyLockDirectory(root, {}, { aged: true });

    expect(await inspectWorkspaceLock(root)).toMatchObject({
      kind: "legacy-directory",
      owner: { kind: "empty" },
    });
    await expect(
      acquireWorkspaceLock(root, "capture", { timeoutMs: 50 }),
    ).rejects.toBeInstanceOf(WorkspaceLockTimeoutError);
    expect(await readdir(path)).toEqual([]);
    expect(await pathExists(markerPathOf(root))).toBe(false);
  });

  it("never treats multiple owner records as an ownerless formation", async () => {
    const root = await storeRootDirectory();
    const path = await plantLegacyLockDirectory(
      root,
      {
        "owner-live.json": legacyOwnerRecord({
          token: "live",
          pid: process.pid,
        }),
        "owner-dead.json": legacyOwnerRecord({ token: "dead" }),
      },
      { aged: true },
    );

    expect(await inspectWorkspaceLock(root)).toMatchObject({
      kind: "legacy-directory",
      owner: { kind: "ambiguous" },
    });
    await expect(
      acquireWorkspaceLock(root, "capture", { timeoutMs: 50 }),
    ).rejects.toBeInstanceOf(WorkspaceLockTimeoutError);
    expect((await lstat(join(path, "owner-live.json"))).isFile()).toBe(true);
  });

  it("never treats a malformed owner record as an ownerless formation", async () => {
    const root = await storeRootDirectory();
    const path = await plantLegacyLockDirectory(
      root,
      { "owner-malformed.json": "{not-json\n" },
      { aged: true },
    );

    expect(await inspectWorkspaceLock(root)).toMatchObject({
      kind: "legacy-directory",
      owner: { kind: "ambiguous" },
    });
    await expect(
      acquireWorkspaceLock(root, "capture", { timeoutMs: 50 }),
    ).rejects.toBeInstanceOf(WorkspaceLockTimeoutError);
    expect(await readFile(join(path, "owner-malformed.json"), "utf8")).toBe(
      "{not-json\n",
    );
  });

  it("does not follow a symlinked legacy owner record", async (context) => {
    context.skip(
      process.platform === "win32",
      "Windows symlink creation depends on host privileges",
    );
    const root = await storeRootDirectory();
    const outside = join(root, "outside-owner.json");
    await writeFile(outside, legacyOwnerRecord({ token: "linked" }));
    const path = await plantLegacyLockDirectory(root, {}, { aged: true });
    await symlink(outside, join(path, "owner-linked.json"));

    expect(await inspectWorkspaceLock(root)).toMatchObject({
      kind: "legacy-directory",
      owner: { kind: "ambiguous" },
    });
    await expect(
      acquireWorkspaceLock(root, "capture", { timeoutMs: 50 }),
    ).rejects.toBeInstanceOf(WorkspaceLockTimeoutError);
    expect(await readFile(outside, "utf8")).toContain('"token":"linked"');
  });

  it("does not open a FIFO legacy owner record", async (context) => {
    context.skip(
      process.platform === "win32",
      "Windows filesystems do not expose POSIX FIFO entries",
    );
    const root = await storeRootDirectory();
    const path = await plantLegacyLockDirectory(root, {}, { aged: true });
    const ownerPath = join(path, "owner-fifo.json");
    await execFileAsync("mkfifo", [ownerPath]);

    expect(await inspectWorkspaceLock(root)).toMatchObject({
      kind: "legacy-directory",
      owner: { kind: "ambiguous" },
    });
    await expect(
      acquireWorkspaceLock(root, "capture", { timeoutMs: 50 }),
    ).rejects.toBeInstanceOf(WorkspaceLockTimeoutError);
    expect((await lstat(ownerPath)).isFIFO()).toBe(true);
  });

  it("does not read an oversized legacy owner record", async () => {
    const root = await storeRootDirectory();
    const path = await plantLegacyLockDirectory(root, {}, { aged: true });
    const ownerPath = join(path, "owner-oversized.json");
    await writeFile(ownerPath, "");
    await truncate(ownerPath, 64 * 1024);

    expect(await inspectWorkspaceLock(root)).toMatchObject({
      kind: "legacy-directory",
      owner: { kind: "ambiguous" },
    });
    await expect(
      acquireWorkspaceLock(root, "capture", { timeoutMs: 50 }),
    ).rejects.toBeInstanceOf(WorkspaceLockTimeoutError);
    expect((await lstat(ownerPath)).size).toBe(64 * 1024);
  });

  it("quarantines only the fixed legacy directory", async () => {
    const native = await upgradedStoreRoot();
    expect(await quarantineLegacyWorkspaceLock(native)).toEqual({
      kind: "native-protocol",
    });

    const fresh = await storeRootDirectory();
    expect(await quarantineLegacyWorkspaceLock(fresh)).toEqual({
      kind: "nothing-to-recover",
    });
  });
});

describe("workspace lock handover", () => {
  it("waits for a legacy holder before returning native authority", async () => {
    const root = await storeRootDirectory();
    const path = await plantLegacyLockDirectory(root, {
      "owner-old.json": legacyOwnerRecord({ token: "old-client" }),
    });
    let settled = false;
    const pending = acquireWorkspaceLock(root, "capture", {
      timeoutMs: 4_000,
    }).finally(() => {
      settled = true;
    });
    await delay(150);
    expect(settled).toBe(false);
    expect(await pathExists(markerPathOf(root))).toBe(false);
    expect((await lstat(path)).isDirectory()).toBe(true);
    await rm(path, { recursive: true, force: true });
    const lock = await pending;
    expect((await lstat(path)).isFile()).toBe(true);
    expect(await readFile(markerPathOf(root), "utf8")).toBe(MARKER_BYTES);
    await expect(
      acquireWorkspaceLock(root, "probe", { timeoutMs: 25 }),
    ).rejects.toBeInstanceOf(WorkspaceLockTimeoutError);
    await lock.release();
    await assertTestWorkspaceLockReleased(root);
  });

  it("honours an old client that wins the exclusive-create race", async () => {
    const root = await storeRootDirectory();
    const path = lockPathOf(root);
    const load = nativeBinding.loadExclusiveFileLock;
    vi.spyOn(nativeBinding, "loadExclusiveFileLock").mockImplementationOnce(
      async () => {
        mkdirSync(path);
        writeFileSync(
          join(path, "owner-old-client.json"),
          legacyOwnerRecord({ token: "old-client" }),
        );
        return load();
      },
    );
    await expect(
      acquireWorkspaceLock(root, "capture", { timeoutMs: 150 }),
    ).rejects.toBeInstanceOf(WorkspaceLockTimeoutError);
    expect(await pathExists(markerPathOf(root))).toBe(false);
    expect((await lstat(path)).isDirectory()).toBe(true);
    expect(
      await readFile(join(path, "owner-old-client.json"), "utf8"),
    ).toContain('"token":"old-client"');
    await rm(path, { recursive: true, force: true });
    const lock = await acquireWorkspaceLock(root, "capture");
    expect(await readFile(markerPathOf(root), "utf8")).toBe(MARKER_BYTES);
    await lock.release();
  });
});

describe("workspace write authority", () => {
  it("releases the lock when the protected action throws", async () => {
    const root = await upgradedStoreRoot();
    await expect(
      withWorkspaceLock(root, "capture", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await assertTestWorkspaceLockReleased(root);
  });

  it("permanently revokes an authority asserted for another store root", async () => {
    const root = await upgradedStoreRoot();
    const otherRoot = await upgradedStoreRoot();
    let firstOwnershipLoss: unknown;
    const captureFailure = (assertion: () => void): unknown => {
      try {
        assertion();
      } catch (cause) {
        return cause;
      }
      throw new Error("workspace authority unexpectedly remained active");
    };

    const execution = await runWithWorkspaceLock(
      root,
      "wrong-root",
      async (authority) => {
        firstOwnershipLoss = captureFailure(() =>
          assertWorkspaceWriteAuthority(authority, otherRoot),
        );
        expect(firstOwnershipLoss).toBeInstanceOf(
          WorkspaceLockOwnershipLostError,
        );
        expect(
          captureFailure(() => assertWorkspaceWriteAuthority(authority, root)),
        ).toBe(firstOwnershipLoss);
      },
    );

    expect(execution).toEqual({
      kind: "completed",
      value: undefined,
      cleanup: { kind: "settled" },
    });
  });

  it("never revives a revoked authority after its lock file is replaced and restored", async () => {
    const root = await upgradedStoreRoot();
    const lockPath = lockPathOf(root);
    const displacedPath = join(root, "displaced-workspace.lock");
    let escapedAuthority: WorkspaceWriteAuthority | undefined;
    let firstOwnershipLoss: unknown;
    const captureFailure = (assertion: () => void): unknown => {
      try {
        assertion();
      } catch (cause) {
        return cause;
      }
      throw new Error("workspace authority unexpectedly remained active");
    };

    const execution = await runWithWorkspaceLock(
      root,
      "old-owner",
      async (authority) => {
        escapedAuthority = authority;
        assertWorkspaceWriteAuthority(authority, root);

        await rename(lockPath, displacedPath);
        await writeFile(lockPath, "replacement");
        firstOwnershipLoss = captureFailure(() =>
          assertWorkspaceWriteAuthority(authority, root),
        );
        expect(firstOwnershipLoss).toBeInstanceOf(
          WorkspaceLockOwnershipLostError,
        );

        // Restoring the original inode at the fixed path does not revive it.
        await rm(lockPath);
        await rename(displacedPath, lockPath);
        expect(
          captureFailure(() => assertWorkspaceWriteAuthority(authority, root)),
        ).toBe(firstOwnershipLoss);
      },
    );

    expect(execution).toEqual({
      kind: "completed",
      value: undefined,
      cleanup: { kind: "settled" },
    });
    expect(
      captureFailure(() =>
        assertWorkspaceWriteAuthority(escapedAuthority!, root),
      ),
    ).toBe(firstOwnershipLoss);
  });

  it("revokes the authority permanently when the protocol marker changes", async () => {
    const root = await upgradedStoreRoot();
    const markerPath = markerPathOf(root);
    let firstOwnershipLoss: unknown;
    const captureFailure = (assertion: () => void): unknown => {
      try {
        assertion();
      } catch (cause) {
        return cause;
      }
      throw new Error("workspace authority unexpectedly remained active");
    };

    const execution = await runWithWorkspaceLock(
      root,
      "marker-change",
      async (authority) => {
        assertWorkspaceWriteAuthority(authority, root);
        await rm(markerPath);
        firstOwnershipLoss = captureFailure(() =>
          assertWorkspaceWriteAuthority(authority, root),
        );
        expect(firstOwnershipLoss).toBeInstanceOf(
          WorkspaceLockOwnershipLostError,
        );
        await writeFile(markerPath, MARKER_BYTES);
        expect(
          captureFailure(() => assertWorkspaceWriteAuthority(authority, root)),
        ).toBe(firstOwnershipLoss);
      },
    );

    // A replaced marker is indistinguishable from a tampered one, so release
    // reports the lost authority instead of claiming a clean settlement.
    expect(execution).toMatchObject({
      kind: "completed",
      value: undefined,
      cleanup: {
        kind: "failed",
        cause: expect.any(WorkspaceLockOwnershipLostError),
      },
    });

    // The report is about lost authority, not a leaked lock: the native lock
    // really was released and the store is immediately acquirable again.
    await assertTestWorkspaceLockReleased(root);
  });
});

describe("workspace lock cleanup settlement", () => {
  it("preserves both a single-lock action failure and cleanup failure", async () => {
    const root = await upgradedStoreRoot();
    const actionFailure = new Error("single action failed");

    const failure = await withWorkspaceLock(
      root,
      "single-release-test",
      async () => {
        await displaceLockPathWithDirectory(root);
        throw actionFailure;
      },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      actionFailure,
      expect.any(WorkspaceLockOwnershipLostError),
    ]);
  });

  it("reports a failed cleanup without losing a completed action", async () => {
    const root = await upgradedStoreRoot();
    const execution = await runWithWorkspaceLock(
      root,
      "settled-release-test",
      async () => {
        await displaceLockPathWithDirectory(root);
        return { effect: "committed" as const };
      },
    );

    expect(execution).toMatchObject({
      kind: "completed",
      value: { effect: "committed" },
      cleanup: { kind: "failed" },
    });
    if (execution.kind !== "completed") throw new Error("unreachable");
    expect(
      execution.cleanup.kind === "failed" && execution.cleanup.cause,
    ).toBeInstanceOf(WorkspaceLockOwnershipLostError);
    // Cleanup never deletes or repairs a path it cannot prove it owns.
    expect((await lstat(lockPathOf(root))).isDirectory()).toBe(true);
  });

  it("returns an action failure independently from lock cleanup", async () => {
    const root = await upgradedStoreRoot();
    const actionFailure = new Error("action failed");
    const execution = await runWithWorkspaceLock(
      root,
      "settled-action-test",
      async () => {
        throw actionFailure;
      },
    );

    expect(execution).toEqual({
      kind: "action-failed",
      cause: actionFailure,
      cleanup: { kind: "settled" },
    });
  });

  it.each(["first", "second"])(
    "identifies an ordered acquisition failure at the %s physical root",
    async (position) => {
      const [firstRoot, secondRoot] = await orderedStoreRoots();
      const lockedRoot = position === "first" ? firstRoot : secondRoot;
      const otherRoot = position === "first" ? secondRoot : firstRoot;
      const blocker = await acquireWorkspaceLock(lockedRoot, "blocker", {});
      let actionEntered = false;

      try {
        const failure = await withOrderedWorkspaceLocks(
          [secondRoot, firstRoot].map((storeRoot) => ({
            storeRoot,
            ...(storeRoot === lockedRoot ? { options: { timeoutMs: 10 } } : {}),
          })),
          "ordered-test",
          async () => {
            actionEntered = true;
          },
        ).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(OrderedWorkspaceLockAcquisitionError);
        expect(
          (failure as OrderedWorkspaceLockAcquisitionError).storeRoot,
        ).toBe(await realpath(lockedRoot));
        expect(actionEntered).toBe(false);

        if (position === "first") {
          expect(await inspectWorkspaceLock(otherRoot)).toEqual({
            kind: "absent",
          });
        } else {
          await assertTestWorkspaceLockReleased(otherRoot);
        }
      } finally {
        await blocker.release();
      }
    },
  );

  it("does not relabel an ordered action failure as an acquisition failure", async () => {
    const root = await storeRootDirectory();
    const firstRoot = join(root, "a");
    const secondRoot = join(root, "z");
    await mkdir(firstRoot);
    await mkdir(secondRoot);

    const actionFailure = new Error("ordered action failed");

    await expect(
      withOrderedWorkspaceLocks(
        [{ storeRoot: secondRoot }, { storeRoot: firstRoot }],
        "ordered-test",
        async () => {
          throw actionFailure;
        },
      ),
    ).rejects.toBe(actionFailure);
  });

  it("identifies a release-only failure after the ordered action completed", async () => {
    const root = await storeRootDirectory();
    const firstRoot = join(root, "a");
    const secondRoot = join(root, "z");
    await Promise.all([mkdir(firstRoot), mkdir(secondRoot)]);

    const failure = await withOrderedWorkspaceLocks(
      [{ storeRoot: secondRoot }, { storeRoot: firstRoot }],
      "ordered-release-test",
      async () => {
        await displaceLockPathWithDirectory(secondRoot);
        return "committed";
      },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OrderedWorkspaceLockReleaseError);
    expect((failure as OrderedWorkspaceLockReleaseError).storeRoot).toBe(
      await realpath(secondRoot),
    );
  });

  it("preserves both an ordered action failure and a cleanup failure", async () => {
    const root = await storeRootDirectory();
    const firstRoot = join(root, "a");
    const secondRoot = join(root, "z");
    await Promise.all([mkdir(firstRoot), mkdir(secondRoot)]);

    const actionFailure = new Error("ordered action failed");

    const failure = await withOrderedWorkspaceLocks(
      [{ storeRoot: secondRoot }, { storeRoot: firstRoot }],
      "ordered-release-test",
      async () => {
        await displaceLockPathWithDirectory(secondRoot);
        throw actionFailure;
      },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      actionFailure,
      expect.any(OrderedWorkspaceLockReleaseError),
    ]);
  });

  it("reports ordered cleanup failure at the exact cleanup root", async () => {
    const root = await storeRootDirectory();
    const firstRoot = join(root, "a");
    const secondRoot = join(root, "z");
    await mkdir(firstRoot);
    await mkdir(secondRoot);

    const execution = await runWithOrderedWorkspaceLocks(
      [{ storeRoot: secondRoot }, { storeRoot: firstRoot }],
      "ordered-settled-release-test",
      async () => {
        await displaceLockPathWithDirectory(secondRoot);
        return { effect: "committed" as const };
      },
    );

    expect(execution).toMatchObject({
      kind: "completed",
      value: { effect: "committed" },
      cleanup: {
        kind: "failed",
        failures: [{ storeRoot: await realpath(secondRoot) }],
      },
    });
    // The untouched member keeps its persistent lock file and is released.
    expect((await lstat(lockPathOf(firstRoot))).isFile()).toBe(true);
    await assertTestWorkspaceLockReleased(firstRoot);
  });

  it("releases an earlier ordered member when later acquisition fails", async () => {
    const [firstRoot, secondRoot] = await orderedStoreRoots();
    const blocker = await acquireWorkspaceLock(secondRoot, "blocker", {});

    try {
      await expect(
        runWithOrderedWorkspaceLocks(
          [
            { storeRoot: firstRoot },
            {
              storeRoot: secondRoot,
              options: { timeoutMs: 10 },
            },
          ],
          "ordered-settled-acquire-test",
          async () => "unreachable",
        ),
      ).rejects.toMatchObject({
        name: "OrderedWorkspaceLockAcquisitionError",
        storeRoot: await realpath(secondRoot),
      });

      await assertTestWorkspaceLockReleased(firstRoot);
    } finally {
      await blocker.release();
    }
  });
});
