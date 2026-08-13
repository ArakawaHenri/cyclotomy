import { execFile, fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
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

import { afterEach, describe, expect, it } from "vitest";

import {
  acquireWorkspaceLock,
  OrderedWorkspaceLockAcquisitionError,
  OrderedWorkspaceLockReleaseError,
  UnsafeWorkspaceLockPathError,
  withOrderedWorkspaceLocks,
  runWithWorkspaceLock,
  runWithOrderedWorkspaceLocks,
  withWorkspaceLock,
  WorkspaceLockTimeoutError,
} from "../src/infrastructure/workspace-lock.ts";

const roots: string[] = [];
const execFileAsync = promisify(execFile);
const children = new Set<LockChild>();
const CHILD_PROCESS_WATCHDOG_MS = 30_000;
const childFixture = fileURLToPath(
  new URL("./fixtures/workspace-lock-child.ts", import.meta.url),
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
  readonly heartbeatMs?: number;
  readonly staleMs?: number;
}

function startLockChild(
  root: string,
  operation: string,
  mode: "hold" | "once",
  options: ChildOptions = {},
): LockChild {
  const childProcess = fork(
    childFixture,
    [
      root,
      operation,
      mode,
      String(options.timeoutMs ?? 1_000),
      String(options.heartbeatMs ?? 20),
      String(options.staleMs ?? 100),
    ],
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
  it("excludes another cooperative operation until release", async () => {
    const root = await storeRoot();
    const first = await acquireWorkspaceLock(root, "capture", {
      heartbeatMs: 20,
      staleMs: 100,
    });

    await expect(
      acquireWorkspaceLock(root, "restore", {
        timeoutMs: 10,
        heartbeatMs: 20,
        staleMs: 100,
      }),
    ).rejects.toBeInstanceOf(WorkspaceLockTimeoutError);

    await first.release();
    const second = await acquireWorkspaceLock(root, "restore", {
      heartbeatMs: 20,
      staleMs: 100,
    });
    await second.release();
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
    const options = { timeoutMs: 1_000, heartbeatMs: 20, staleMs: 100 };

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

  it("excludes operations running in separate Node processes", async () => {
    const root = await storeRoot();
    const holder = startLockChild(root, "capture", "hold", {
      heartbeatMs: 20,
      staleMs: 200,
    });
    await waitForMessage(holder, "acquired");

    const contender = startLockChild(root, "restore", "once", {
      timeoutMs: 60,
      heartbeatMs: 20,
      staleMs: 200,
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

    const successor = startLockChild(root, "restore", "once", {
      heartbeatMs: 20,
      staleMs: 200,
    });
    await waitForMessage(successor, "acquired");
    await waitForMessage(successor, "released");
    await waitForExit(successor);
  });

  it("recovers after a lock-holding Node process is killed", async () => {
    const root = await storeRoot();
    const holder = startLockChild(root, "capture", "hold", {
      heartbeatMs: 15,
      staleMs: 75,
    });
    await waitForMessage(holder, "acquired");
    holder.process.kill("SIGKILL");
    await waitForExit(holder);

    const recovery = startLockChild(root, "restore", "once", {
      timeoutMs: 750,
      heartbeatMs: 15,
      staleMs: 75,
    });
    await waitForMessage(recovery, "acquired");
    await waitForMessage(recovery, "released");
    await waitForExit(recovery);
  });

  it("recovers an expired lock owned by a dead local process", async () => {
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

    const lock = await acquireWorkspaceLock(root, "gc", {
      heartbeatMs: 20,
      staleMs: 100,
    });
    await lock.release();
  });

  it("recovers a stale ownerless lock after the formation identity expires", async () => {
    const root = await storeRoot();
    const path = join(root, "workspace.lock");
    await mkdir(path);
    const old = new Date(Date.now() - 10_000);
    await utimes(path, old, old);

    const lock = await acquireWorkspaceLock(root, "restore", {
      timeoutMs: 250,
      heartbeatMs: 20,
      staleMs: 100,
    });
    await lock.release();
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
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
    await writeFile(join(path, "heartbeat-live"), "");
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
        heartbeatMs: 20,
        staleMs: 100,
      }),
    ).rejects.toBeInstanceOf(WorkspaceLockTimeoutError);
    expect((await lstat(join(path, "heartbeat-live"))).isFile()).toBe(true);
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
        heartbeatMs: 20,
        staleMs: 100,
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
        heartbeatMs: 20,
        staleMs: 100,
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
        heartbeatMs: 20,
        staleMs: 100,
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
        heartbeatMs: 20,
        staleMs: 100,
      }),
    ).rejects.toBeInstanceOf(WorkspaceLockTimeoutError);
    expect((await lstat(ownerPath)).size).toBe(64 * 1024);
  });

  it("distinguishes PID reuse with a process-start identity", async () => {
    const root = await storeRoot();
    const path = join(root, "workspace.lock");
    await mkdir(path);
    const ownerPath = join(path, "owner-reused.json");
    await writeFile(
      ownerPath,
      `${JSON.stringify({
        token: "reused",
        pid: process.pid,
        hostname: hostname(),
        operation: "capture",
        acquiredAt: 1,
        processIdentity: "old-process-start",
      })}\n`,
    );
    const old = new Date(Date.now() - 10_000);
    await utimes(ownerPath, old, old);
    await utimes(path, old, old);

    const lock = await acquireWorkspaceLock(root, "restore", {
      timeoutMs: 250,
      heartbeatMs: 20,
      staleMs: 100,
      identifyProcess: async () => "current-process-start",
    });
    await lock.release();
  });

  it("recovers a stale takeover claim left by a killed contender", async () => {
    const root = await storeRoot();
    const path = join(root, "workspace.lock");
    await mkdir(path);
    await writeFile(
      join(path, "owner-dead-owner.json"),
      `${JSON.stringify({
        token: "dead-owner",
        pid: 2_147_483_647,
        hostname: hostname(),
        operation: "capture",
        acquiredAt: 1,
      })}\n`,
    );
    const lockInfo = await lstat(path);
    const claimIdentity = createHash("sha256")
      .update(String(lockInfo.dev))
      .update("\0")
      .update(String(lockInfo.ino))
      .update("\0")
      .update("dead-owner")
      .digest("hex")
      .slice(0, 32);
    const claimPath = `${path}.steal-claim-${claimIdentity}`;
    await mkdir(claimPath);
    const claimOwnerPath = join(claimPath, "owner-dead-claim.json");
    await writeFile(
      claimOwnerPath,
      `${JSON.stringify({
        token: "dead-claim",
        pid: 2_147_483_647,
        hostname: hostname(),
        operation: "stale-lock-takeover",
        acquiredAt: 1,
      })}\n`,
    );
    const old = new Date(Date.now() - 10_000);
    await utimes(join(path, "owner-dead-owner.json"), old, old);
    await utimes(claimOwnerPath, old, old);
    await utimes(claimPath, old, old);
    await utimes(path, old, old);

    const lock = await acquireWorkspaceLock(root, "gc", {
      heartbeatMs: 20,
      staleMs: 100,
    });
    await lock.release();
  });

  it("does not release a replacement lock owned by another token", async () => {
    const root = await storeRoot();
    const first = await acquireWorkspaceLock(root, "capture", {
      heartbeatMs: 20,
      staleMs: 200,
    });
    const displacedPath = join(root, "displaced-workspace.lock");
    await rename(join(root, "workspace.lock"), displacedPath);

    const replacement = await acquireWorkspaceLock(root, "restore", {
      heartbeatMs: 20,
      staleMs: 200,
    });
    await first.release();

    await expect(
      acquireWorkspaceLock(root, "gc", {
        timeoutMs: 40,
        heartbeatMs: 20,
        staleMs: 200,
      }),
    ).rejects.toBeInstanceOf(WorkspaceLockTimeoutError);

    await replacement.release();
    await rm(displacedPath, { recursive: true, force: true });
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
        heartbeatMs: 20,
        staleMs: 100,
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
      withWorkspaceLock(
        root,
        "capture",
        async () => {
          throw new Error("boom");
        },
        { heartbeatMs: 20, staleMs: 100 },
      ),
    ).rejects.toThrow("boom");

    const lock = await acquireWorkspaceLock(root, "restore", {
      heartbeatMs: 20,
      staleMs: 100,
    });
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
        const heartbeat = (await readdir(lockPath)).find((name) =>
          name.startsWith("heartbeat-"),
        );
        if (heartbeat === undefined) throw new Error("missing lock heartbeat");
        const heartbeatPath = join(lockPath, heartbeat);
        await rm(heartbeatPath);
        await mkdir(heartbeatPath);
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
    expect(await readdir(lockPath)).toEqual([strayName]);
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
      cleanup: { kind: "released" },
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
      const blocker = await acquireWorkspaceLock(lockedRoot, "blocker", {
        heartbeatMs: 20,
        staleMs: 100,
      });
      let actionEntered = false;

      const failure = await withOrderedWorkspaceLocks(
        [
          {
            storeRoot: secondRoot,
            options: { timeoutMs: 10, heartbeatMs: 20, staleMs: 100 },
          },
          {
            storeRoot: firstRoot,
            options: { timeoutMs: 10, heartbeatMs: 20, staleMs: 100 },
          },
        ],
        "ordered-test",
        async () => {
          actionEntered = true;
        },
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(OrderedWorkspaceLockAcquisitionError);
      expect((failure as OrderedWorkspaceLockAcquisitionError).storeRoot).toBe(
        lockedRoot,
      );
      expect(actionEntered).toBe(false);

      // When the blocked root sorts second, this also proves that the first
      // acquired member was released before the failure escaped.
      const other = await acquireWorkspaceLock(otherRoot, "probe", {
        timeoutMs: 40,
        heartbeatMs: 20,
        staleMs: 100,
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
        const heartbeat = (await readdir(lockPath)).find((name) =>
          name.startsWith("heartbeat-"),
        );
        if (heartbeat === undefined) throw new Error("missing lock heartbeat");
        const heartbeatPath = join(lockPath, heartbeat);
        await rm(heartbeatPath);
        await mkdir(heartbeatPath);
        return "committed";
      },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OrderedWorkspaceLockReleaseError);
    expect((failure as OrderedWorkspaceLockReleaseError).storeRoot).toBe(
      secondRoot,
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
        const heartbeat = (await readdir(lockPath)).find((name) =>
          name.startsWith("heartbeat-"),
        );
        if (heartbeat === undefined) throw new Error("missing lock heartbeat");
        const heartbeatPath = join(lockPath, heartbeat);
        await rm(heartbeatPath);
        await mkdir(heartbeatPath);
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
        failures: [{ storeRoot: secondRoot }],
      },
    });
    expect(await readdir(secondLockPath)).toEqual([strayName]);
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
    const blocker = await acquireWorkspaceLock(secondRoot, "blocker", {
      heartbeatMs: 20,
      staleMs: 100,
    });

    await expect(
      runWithOrderedWorkspaceLocks(
        [
          { storeRoot: firstRoot },
          {
            storeRoot: secondRoot,
            options: { timeoutMs: 10, heartbeatMs: 20, staleMs: 100 },
          },
        ],
        "ordered-settled-acquire-test",
        async () => "unreachable",
      ),
    ).rejects.toMatchObject({
      name: "OrderedWorkspaceLockAcquisitionError",
      storeRoot: secondRoot,
    });

    const probe = await acquireWorkspaceLock(firstRoot, "probe", {
      timeoutMs: 40,
      heartbeatMs: 20,
      staleMs: 100,
    });
    await probe.release();
    await blocker.release();
  });
});
