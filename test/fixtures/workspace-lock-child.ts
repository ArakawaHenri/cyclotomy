import { setTimeout as delay } from "node:timers/promises";
import { tryHoldForegroundDemand } from "../../src/infrastructure/foreground-demand.ts";
import { loadNativeFileLock } from "../../src/infrastructure/native-file-lock.ts";
import { acquireWorkspaceLock } from "../../src/infrastructure/workspace-lock.ts";

type ChildMode = "hold" | "once" | "demand";

interface ChildMessage {
  readonly type: "acquired" | "released" | "error";
  readonly pid: number;
  readonly name?: string;
  readonly message?: string;
}

function send(message: ChildMessage): Promise<void> {
  if (!process.connected || process.send === undefined) {
    return Promise.resolve();
  }
  return new Promise<void>((resolveSend, reject) => {
    process.send!(message, (error) => {
      if (error === null) {
        resolveSend();
      } else {
        reject(error);
      }
    });
  });
}

function waitForRelease(): Promise<void> {
  return new Promise<void>((resolveRelease) => {
    process.once("message", (message) => {
      if (message === "release") {
        resolveRelease();
      }
    });
    process.once("disconnect", resolveRelease);
  });
}

async function main(): Promise<void> {
  const [root, operation, rawMode, rawTimeout] = process.argv.slice(2);
  const mode = rawMode as ChildMode;
  const timeoutMs = Number(rawTimeout);
  if (
    root === undefined ||
    operation === undefined ||
    (mode !== "hold" && mode !== "once" && mode !== "demand") ||
    !Number.isFinite(timeoutMs)
  ) {
    throw new Error("invalid workspace-lock child arguments");
  }

  if (mode === "demand") {
    const binding = await loadNativeFileLock();
    let release = tryHoldForegroundDemand(root, binding);
    while (release === undefined) {
      await delay(5);
      release = tryHoldForegroundDemand(root, binding);
    }
    try {
      await send({ type: "acquired", pid: process.pid });
      await waitForRelease();
    } finally {
      release();
    }
    return;
  }

  const lock = await acquireWorkspaceLock(root, operation, {
    timeoutMs,
  });
  await send({ type: "acquired", pid: process.pid });
  if (mode === "hold") {
    await waitForRelease();
  }
  await lock.release();
  await send({ type: "released", pid: process.pid });
}

try {
  await main();
} catch (error) {
  await send({
    type: "error",
    pid: process.pid,
    name: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
} finally {
  if (process.connected) {
    process.disconnect();
  }
}
