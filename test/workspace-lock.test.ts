import {
  execFile,
  fork,
  type ChildProcess,
} from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
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
  UnsafeWorkspaceLockPathError,
  withWorkspaceLock,
  WorkspaceLockTimeoutError,
} from "../src/infrastructure/workspace-lock.ts";

const roots: string[] = [];
const execFileAsync = promisify(execFile);
const children = new Set<LockChild>();
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
  timeoutMs = 2_000,
): Promise<ChildMessage> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const index = child.messages.findIndex((message) => message.type === type);
    if (index >= 0) {
      return child.messages.splice(index, 1)[0]!;
    }
    const unexpected = child.messages.find((message) => message.type === "error");
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
      throw new Error(`timed out waiting for lock child ${type}\n${child.stderr}`);
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
  timeoutMs = 2_000,
): Promise<void> {
  if (child.exited) {
    return;
  }
  await new Promise<void>((resolveExit, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for child exit\n${child.stderr}`));
    }, timeoutMs);
    child.process.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
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
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
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
});
