import { execFile, fork, type ChildProcess } from "node:child_process";
import {
  lstat,
  mkdtemp,
  mkdir,
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

import { afterEach, describe, expect, expectTypeOf, it } from "vitest";

import { compareDirectoryBindings } from "../src/infrastructure/directory-binding.ts";
import {
  acquireWorkspaceLock,
  assertWorkspaceWriteAuthority,
  OrderedWorkspaceLockAcquisitionError,
  OrderedWorkspaceLockReleaseError,
  UnsafeWorkspaceLockPathError,
  withOrderedWorkspaceLocks,
  runWithWorkspaceLock,
  runWithOrderedWorkspaceLocks,
  withWorkspaceLock,
  type WorkspaceLockOptions,
  type OrderedWorkspaceAuthorities,
  type WorkspaceWriteAuthority,
  WorkspaceLockTimeoutError,
  WorkspaceLockOwnershipLostError,
} from "../src/infrastructure/workspace-lock.ts";

const roots: string[] = [];
const execFileAsync = promisify(execFile);
const children = new Set<LockChild>();
const CHILD_PROCESS_WATCHDOG_MS = 30_000;
const childFixture = fileURLToPath(
  new URL("./fixtures/workspace-lock-child.ts", import.meta.url),
);
const timeoutRetryFixture = fileURLToPath(
  new URL("./fixtures/workspace-lock-timeout-retry-child.ts", import.meta.url),
);

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

async function storeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cyclotomy-lock-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  const activeChildren = [...children];
  for (const child of activeChildren) {
    child.process.kill("SIGKILL");
  }
  await Promise.all(activeChildren.map((child) => waitForExit(child)));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("workspace lock", () => {
  it("keeps the public options and on-disk protocol owner-only", async () => {
    expectTypeOf<keyof WorkspaceLockOptions>().toEqualTypeOf<"timeoutMs">();
    const root = await storeRoot();
    const lock = await acquireWorkspaceLock(root, "protocol-test");

    expect(await readdir(join(root, "workspace.lock"))).toEqual([
      expect.stringMatching(/^owner-.*\.json$/u),
    ]);
    await lock.release();
  });

  it("excludes another cooperative operation until release", async () => {
    const root = await storeRoot();
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
    expect((failure as Error).message).toContain(
      "README recovery instructions",
    );

    await first.release();
    const second = await acquireWorkspaceLock(root, "restore", {});
    await second.release();
  });

  it("applies the same deadline before every acquisition retry", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--experimental-test-module-mocks",
        "--no-warnings",
        timeoutRetryFixture,
      ],
      { timeout: CHILD_PROCESS_WATCHDOG_MS },
    );
    const results = JSON.parse(stdout) as Array<{
      readonly scenario: string;
      readonly expectedLockPath: string;
      readonly mkdirCalls: number;
      readonly errorName?: string;
      readonly errorMessage?: string;
      readonly errorLockPath?: unknown;
    }>;

    expect(results.map(({ scenario }) => scenario)).toEqual([
      "formation-before-owner",
      "formation-after-owner",
      "vanished-contention",
      "transient-contention-observation",
    ]);
    for (const result of results) {
      expect(result).toMatchObject({
        mkdirCalls: 1,
        errorName: "WorkspaceLockTimeoutError",
        errorLockPath: result.expectedLockPath,
      });
      expect(result.errorMessage).toContain(
        "the lock may be active or abandoned",
      );
    }
  });

  it("serializes opposite multi-workspace lock orders without deadlock", async () => {
    const firstRoot = await storeRoot();
    const secondRoot = await storeRoot();
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
      device: 2,
      inode: 20,
    };
    const lowIdentityThroughLateAlias = {
      canonicalPath: "/alias-z",
      device: 2,
      inode: 20,
    };
    const highIdentity = {
      canonicalPath: "/alias-m",
      device: 10,
      inode: 1,
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

  it("excludes operations running in separate Node processes", async () => {
    const root = await storeRoot();
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

  it("does not automatically recover a lock left by a killed process", async () => {
    const root = await storeRoot();
    const holder = startLockChild(root, "capture", "hold", {});
    await waitForMessage(holder, "acquired");
    holder.process.kill("SIGKILL");
    await waitForExit(holder);
    const lockPath = join(root, "workspace.lock");
    const abandonedEntries = await readdir(lockPath);

    const contender = startLockChild(root, "restore", "once", {
      timeoutMs: 60,
    });
    const failure = await waitForMessage(contender, "error");
    expect(failure).toMatchObject({
      type: "error",
      name: "WorkspaceLockTimeoutError",
    });
    await waitForExit(contender);
    expect(await readdir(lockPath)).toEqual(abandonedEntries);

    // Explicit removal is the only recovery path. A timed-out contender has no
    // deferred takeover that can later move or delete this fresh successor.
    await rm(lockPath, { recursive: true });
    const successor = await acquireWorkspaceLock(root, "restore", {});
    expect((await lstat(lockPath)).isDirectory()).toBe(true);
    await successor.release();
  });

  it("leaves an expired lock owned by a dead local process untouched", async () => {
    const root = await storeRoot();
    const path = join(root, "workspace.lock");
    await mkdir(path);
    await writeFile(
      join(path, "owner-dead.json"),
      `${JSON.stringify({
        token: "dead",
        pid: 2_147_483_647,
        hostname: hostname(),
        operation: "capture",
        acquiredAt: 1,
      })}\n`,
    );
    const old = new Date(Date.now() - 10_000);
    await utimes(join(path, "owner-dead.json"), old, old);
    await utimes(path, old, old);

    await expect(
      acquireWorkspaceLock(root, "gc", {
        timeoutMs: 0,
      }),
    ).rejects.toBeInstanceOf(WorkspaceLockTimeoutError);
    expect(await readFile(join(path, "owner-dead.json"), "utf8")).toContain(
      '"token":"dead"',
    );
    expect(await readdir(root)).toEqual(["workspace.lock"]);
  });

  it("leaves an expired ownerless lock untouched", async () => {
    const root = await storeRoot();
    const path = join(root, "workspace.lock");
    await mkdir(path);
    const old = new Date(Date.now() - 10_000);
    await utimes(path, old, old);

    await expect(
      acquireWorkspaceLock(root, "restore", {
        timeoutMs: 0,
      }),
    ).rejects.toBeInstanceOf(WorkspaceLockTimeoutError);
    expect(await readdir(path)).toEqual([]);
  });

  it("never treats multiple owner records as an ownerless formation", async () => {
    const root = await storeRoot();
    const path = join(root, "workspace.lock");
    await mkdir(path);
    await writeFile(
      join(path, "owner-live.json"),
      `${JSON.stringify({
        token: "live",
        pid: process.pid,
        hostname: hostname(),
        operation: "capture",
        acquiredAt: 1,
      })}\n`,
    );
    await writeFile(
      join(path, "owner-dead.json"),
      `${JSON.stringify({
        token: "dead",
        pid: 2_147_483_647,
        hostname: hostname(),
        operation: "capture",
        acquiredAt: 1,
      })}\n`,
    );
    const old = new Date(Date.now() - 10_000);
    await utimes(path, old, old);

    await expect(
      acquireWorkspaceLock(root, "restore", {
        timeoutMs: 25,
      }),
    ).rejects.toBeInstanceOf(WorkspaceLockTimeoutError);
    expect((await lstat(join(path, "owner-live.json"))).isFile()).toBe(true);
  });

  it("never treats a malformed owner record as an ownerless formation", async () => {
    const root = await storeRoot();
    const path = join(root, "workspace.lock");
    await mkdir(path);
    const ownerPath = join(path, "owner-malformed.json");
    await writeFile(ownerPath, "{not-json\n");
    const old = new Date(Date.now() - 10_000);
    await utimes(ownerPath, old, old);
    await utimes(path, old, old);

    await expect(
      acquireWorkspaceLock(root, "restore", {
        timeoutMs: 25,
      }),
    ).rejects.toBeInstanceOf(WorkspaceLockTimeoutError);
    expect(await readFile(ownerPath, "utf8")).toBe("{not-json\n");
  });

  it("does not follow a symlinked owner protocol file", async (context) => {
    context.skip(
      process.platform === "win32",
      "Windows symlink creation depends on host privileges",
    );
    const root = await storeRoot();
    const path = join(root, "workspace.lock");
    await mkdir(path);
    const outside = join(root, "outside-owner.json");
    await writeFile(
      outside,
      `${JSON.stringify({
        token: "linked",
        pid: process.pid,
        hostname: hostname(),
        operation: "capture",
        acquiredAt: 1,
      })}\n`,
    );
    await symlink(outside, join(path, "owner-linked.json"));
    const old = new Date(Date.now() - 10_000);
    await utimes(path, old, old);

    await expect(
      acquireWorkspaceLock(root, "restore", {
        timeoutMs: 25,
      }),
    ).rejects.toBeInstanceOf(WorkspaceLockTimeoutError);
    expect(await readFile(outside, "utf8")).toContain('"token":"linked"');
  });

  it("does not open a FIFO owner protocol file", async (context) => {
    context.skip(
      process.platform === "win32",
      "Windows filesystems do not expose POSIX FIFO entries",
    );
    const root = await storeRoot();
    const path = join(root, "workspace.lock");
    await mkdir(path);
    const ownerPath = join(path, "owner-fifo.json");
    await execFileAsync("mkfifo", [ownerPath]);
    const old = new Date(Date.now() - 10_000);
    await utimes(path, old, old);

    await expect(
      acquireWorkspaceLock(root, "restore", {
        timeoutMs: 25,
      }),
    ).rejects.toBeInstanceOf(WorkspaceLockTimeoutError);
    expect((await lstat(ownerPath)).isFIFO()).toBe(true);
  });

  it("does not read an oversized owner protocol file", async () => {
    const root = await storeRoot();
    const path = join(root, "workspace.lock");
    await mkdir(path);
    const ownerPath = join(path, "owner-oversized.json");
    await writeFile(ownerPath, "");
    await truncate(ownerPath, 64 * 1024);
    const old = new Date(Date.now() - 10_000);
    await utimes(path, old, old);

    await expect(
      acquireWorkspaceLock(root, "restore", {
        timeoutMs: 25,
      }),
    ).rejects.toBeInstanceOf(WorkspaceLockTimeoutError);
    expect((await lstat(ownerPath)).size).toBe(64 * 1024);
  });

  it("does not release a replacement lock owned by another token", async () => {
    const root = await storeRoot();
    const first = await acquireWorkspaceLock(root, "capture", {});
    const displacedPath = join(root, "displaced-workspace.lock");
    await rename(join(root, "workspace.lock"), displacedPath);

    const replacement = await acquireWorkspaceLock(root, "restore", {});
    await expect(first.release()).rejects.toBeInstanceOf(
      WorkspaceLockOwnershipLostError,
    );

    await expect(
      acquireWorkspaceLock(root, "gc", {
        timeoutMs: 40,
      }),
    ).rejects.toBeInstanceOf(WorkspaceLockTimeoutError);

    await replacement.release();
    await rm(displacedPath, { recursive: true, force: true });
  });

  it("fails release without deleting a different valid owner token", async () => {
    const root = await storeRoot();
    const lock = await acquireWorkspaceLock(root, "capture");
    const lockPath = join(root, "workspace.lock");
    const names = await readdir(lockPath);
    const ownerName = names.find((name) => name.startsWith("owner-"));
    if (ownerName === undefined) {
      throw new Error("acquired lock protocol is incomplete");
    }
    const owner = JSON.parse(
      await readFile(join(lockPath, ownerName), "utf8"),
    ) as Record<string, unknown>;
    const replacementToken = "replacement-token";
    await rm(join(lockPath, ownerName));
    await writeFile(
      join(lockPath, `owner-${replacementToken}.json`),
      `${JSON.stringify({ ...owner, token: replacementToken })}\n`,
    );

    await expect(lock.release()).rejects.toBeInstanceOf(
      WorkspaceLockOwnershipLostError,
    );
    expect(await readdir(lockPath)).toEqual([`owner-${replacementToken}.json`]);
  });

  it("fails release when the acquired owner protocol becomes empty", async () => {
    const root = await storeRoot();
    const lock = await acquireWorkspaceLock(root, "capture");
    const lockPath = join(root, "workspace.lock");
    for (const name of await readdir(lockPath)) {
      await rm(join(lockPath, name));
    }

    await expect(lock.release()).rejects.toBeInstanceOf(
      WorkspaceLockOwnershipLostError,
    );
    expect(await readdir(lockPath)).toEqual([]);
  });

  it("deduplicates realpath aliases and invalidates ordered authorities after action", async () => {
    const root = await storeRoot();
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

  it("permanently revokes an authority asserted for another store root", async () => {
    const root = await storeRoot();
    const otherRoot = await storeRoot();
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

  it("never revives a revoked authority when its old lock path is restored", async () => {
    const root = await storeRoot();
    const lockPath = join(root, "workspace.lock");
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

        firstOwnershipLoss = captureFailure(() =>
          assertWorkspaceWriteAuthority(authority, root),
        );
        expect(firstOwnershipLoss).toBeInstanceOf(
          WorkspaceLockOwnershipLostError,
        );

        const successor = await runWithWorkspaceLock(
          root,
          "successor",
          async (successorAuthority) => {
            assertWorkspaceWriteAuthority(successorAuthority, root);
          },
        );
        expect(successor).toEqual({
          kind: "completed",
          value: undefined,
          cleanup: { kind: "settled" },
        });

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
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to follow a workspace.lock symlink", async () => {
    const root = await storeRoot();
    const external = join(root, "external");
    const sentinel = join(external, "sentinel.txt");
    await mkdir(external);
    await writeFile(sentinel, "keep");
    await symlink(external, join(root, "workspace.lock"), "dir");

    await expect(
      acquireWorkspaceLock(root, "capture", {
        timeoutMs: 0,
      }),
    ).rejects.toBeInstanceOf(UnsafeWorkspaceLockPathError);
    expect(await readFile(sentinel, "utf8")).toBe("keep");
    expect((await lstat(join(root, "workspace.lock"))).isSymbolicLink()).toBe(
      true,
    );
  });

  it("releases the lock when the protected action throws", async () => {
    const root = await storeRoot();
    await expect(
      withWorkspaceLock(root, "capture", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const lock = await acquireWorkspaceLock(root, "restore");
    await lock.release();
  });

  it("preserves both a single-lock action failure and cleanup failure", async () => {
    const root = await storeRoot();
    const actionFailure = new Error("single action failed");

    const failure = await withWorkspaceLock(
      root,
      "single-release-test",
      async () => {
        const lockPath = join(root, "workspace.lock");
        await writeFile(join(lockPath, "unexpected-entry"), "preserve");
        throw actionFailure;
      },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      actionFailure,
      expect.any(Error),
    ]);
  });

  it("reports stray release residue without losing a completed action", async () => {
    const root = await storeRoot();
    const lockPath = join(root, "workspace.lock");
    const strayName = "unexpected-entry";
    const execution = await runWithWorkspaceLock(
      root,
      "settled-release-test",
      async () => {
        await writeFile(join(lockPath, strayName), "preserve");
        return { effect: "committed" as const };
      },
    );

    expect(execution).toMatchObject({
      kind: "completed",
      value: { effect: "committed" },
      cleanup: { kind: "failed" },
    });
    expect(await readdir(lockPath)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^owner-.*\.json$/u),
        strayName,
      ]),
    );
  });

  it("returns an action failure independently from lock cleanup", async () => {
    const root = await storeRoot();
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

  it.each(["a", "z"])(
    "identifies an ordered acquisition failure at the %s-sorted root",
    async (lockedName) => {
      const root = await storeRoot();
      const firstRoot = join(root, "a");
      const secondRoot = join(root, "z");
      await mkdir(firstRoot);
      await mkdir(secondRoot);
      const lockedRoot = lockedName === "a" ? firstRoot : secondRoot;
      const otherRoot = lockedName === "a" ? secondRoot : firstRoot;
      const blocker = await acquireWorkspaceLock(lockedRoot, "blocker", {});
      let actionEntered = false;

      const failure = await withOrderedWorkspaceLocks(
        [
          {
            storeRoot: secondRoot,
            options: { timeoutMs: 10 },
          },
          {
            storeRoot: firstRoot,
            options: { timeoutMs: 10 },
          },
        ],
        "ordered-test",
        async () => {
          actionEntered = true;
        },
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(OrderedWorkspaceLockAcquisitionError);
      expect((failure as OrderedWorkspaceLockAcquisitionError).storeRoot).toBe(
        await realpath(lockedRoot),
      );
      expect(actionEntered).toBe(false);

      // When the blocked root sorts second, this also proves that the first
      // acquired member was released before the failure escaped.
      const other = await acquireWorkspaceLock(otherRoot, "probe", {
        timeoutMs: 40,
      });
      await other.release();
      await blocker.release();
    },
  );

  it("does not relabel an ordered action failure as an acquisition failure", async () => {
    const root = await storeRoot();
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
    const root = await storeRoot();
    const firstRoot = join(root, "a");
    const secondRoot = join(root, "z");
    await Promise.all([mkdir(firstRoot), mkdir(secondRoot)]);

    const failure = await withOrderedWorkspaceLocks(
      [{ storeRoot: secondRoot }, { storeRoot: firstRoot }],
      "ordered-release-test",
      async () => {
        const lockPath = join(secondRoot, "workspace.lock");
        await writeFile(join(lockPath, "unexpected-entry"), "preserve");
        return "committed";
      },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OrderedWorkspaceLockReleaseError);
    expect((failure as OrderedWorkspaceLockReleaseError).storeRoot).toBe(
      await realpath(secondRoot),
    );
  });

  it("preserves both an ordered action failure and a cleanup failure", async () => {
    const root = await storeRoot();
    const firstRoot = join(root, "a");
    const secondRoot = join(root, "z");
    await Promise.all([mkdir(firstRoot), mkdir(secondRoot)]);
    const actionFailure = new Error("ordered action failed");

    const failure = await withOrderedWorkspaceLocks(
      [{ storeRoot: secondRoot }, { storeRoot: firstRoot }],
      "ordered-release-test",
      async () => {
        const lockPath = join(secondRoot, "workspace.lock");
        await writeFile(join(lockPath, "unexpected-entry"), "preserve");
        throw actionFailure;
      },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      actionFailure,
      expect.any(OrderedWorkspaceLockReleaseError),
    ]);
  });

  it("reports ordered stray residue at the exact cleanup root", async () => {
    const root = await storeRoot();
    const firstRoot = join(root, "a");
    const secondRoot = join(root, "z");
    const secondLockPath = join(secondRoot, "workspace.lock");
    const strayName = "unexpected-entry";
    await mkdir(firstRoot);
    await mkdir(secondRoot);

    const execution = await runWithOrderedWorkspaceLocks(
      [{ storeRoot: secondRoot }, { storeRoot: firstRoot }],
      "ordered-settled-release-test",
      async () => {
        await writeFile(join(secondLockPath, strayName), "preserve");
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
    expect(await readdir(secondLockPath)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^owner-.*\.json$/u),
        strayName,
      ]),
    );
    await expect(
      lstat(join(firstRoot, "workspace.lock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("releases an earlier ordered member when later acquisition fails", async () => {
    const root = await storeRoot();
    const firstRoot = join(root, "a");
    const secondRoot = join(root, "z");
    await mkdir(firstRoot);
    await mkdir(secondRoot);
    const blocker = await acquireWorkspaceLock(secondRoot, "blocker", {});

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

    const probe = await acquireWorkspaceLock(firstRoot, "probe", {
      timeoutMs: 40,
    });
    await probe.release();
    await blocker.release();
  });
});
