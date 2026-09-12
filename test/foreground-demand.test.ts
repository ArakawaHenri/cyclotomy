import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { watchForegroundDemand } from "../src/infrastructure/foreground-demand.ts";
import { acquireWorkspaceLock } from "../src/infrastructure/workspace-lock.ts";
import { testWorkspaceLockIsHeld } from "./workspace-lock-fixture.ts";

const roots: string[] = [];
const children: Array<ReturnType<typeof startChild>> = [];

function startChild(root: string, mode: "demand" | "hold") {
  const child = fork(
    new URL("./fixtures/workspace-lock-child.ts", import.meta.url),
    [root, "foreground", mode, "10000"],
    {
      execArgv: ["--experimental-strip-types", "--no-warnings"],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    },
  );
  const exited = once(child, "exit");
  const acquired = once(child, "message").then(([message]) => {
    expect(message).toMatchObject({ type: "acquired" });
  });
  return { child, exited, acquired };
}

async function root() {
  const path = await mkdtemp(join(tmpdir(), "cyclotomy-demand-"));
  roots.push(path);
  return path;
}

afterEach(async () => {
  for (const holder of children) {
    if (holder.child.exitCode === null && holder.child.signalCode === null)
      holder.child.kill();
  }
  await Promise.allSettled(children.splice(0).map(({ exited }) => exited));
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("foreground demand", () => {
  it("retains concurrent demand until the last process exits", async () => {
    const path = await root();
    const first = startChild(path, "demand");
    const second = startChild(path, "demand");
    children.push(first, second);
    await Promise.all([first.acquired, second.acquired]);
    let watch = await watchForegroundDemand(path);
    expect(watch.signal.aborted).toBe(true);
    watch.close();

    first.child.kill("SIGKILL");
    await first.exited;
    watch = await watchForegroundDemand(path);
    expect(watch.signal.aborted).toBe(true);
    watch.close();

    second.child.kill("SIGKILL");
    await second.exited;
    watch = await watchForegroundDemand(path);
    expect(watch.signal.aborted).toBe(false);
    watch.close();
  });

  it("asks background work to yield without releasing its write lock", async () => {
    const path = await root();
    const background = await acquireWorkspaceLock(path, "gc", {
      background: true,
    });
    const watch = await watchForegroundDemand(path);
    const foreground = startChild(path, "hold");
    children.push(foreground);
    try {
      await vi.waitFor(() => expect(watch.signal.aborted).toBe(true), {
        timeout: 10000,
      });
      expect(await testWorkspaceLockIsHeld(path)).toBe(true);
      await background.release();
      await foreground.acquired;
      expect(await testWorkspaceLockIsHeld(path)).toBe(true);
      foreground.child.disconnect();
      await foreground.exited;
      expect(await testWorkspaceLockIsHeld(path)).toBe(false);
    } finally {
      watch.close();
      await background.release();
    }
  });

  it("removes a cancelled waiter's demand while preserving the holder", async () => {
    const path = await root();
    const background = await acquireWorkspaceLock(path, "gc", {
      background: true,
    });
    const watch = await watchForegroundDemand(path);
    const cancellation = new AbortController();
    const waiting = acquireWorkspaceLock(path, "capture", {
      signal: cancellation.signal,
    });
    const failure = waiting.catch((cause: unknown) => cause);
    try {
      await vi.waitFor(() => expect(watch.signal.aborted).toBe(true));
      cancellation.abort();
      expect(await failure).toBe(cancellation.signal.reason);
      const next = await watchForegroundDemand(path);
      expect(next.signal.aborted).toBe(false);
      next.close();
      expect(await testWorkspaceLockIsHeld(path)).toBe(true);
    } finally {
      cancellation.abort();
      await failure;
      watch.close();
      await background.release();
    }
  });

  it("stops observing a replaced demand file", async () => {
    const path = await root();
    const watch = await watchForegroundDemand(path);
    try {
      await rename(join(path, "foreground.lock"), join(path, "displaced.lock"));
      await vi.waitFor(() => expect(watch.signal.aborted).toBe(true));
    } finally {
      watch.close();
    }
  });
});
