// One client process for cross-version lock protocol acceptance.
//
// `--client old` loads the published cyclotomy@0.2.4 lock module (relocated out
// of node_modules so Node's type stripping applies); `--client new` loads this
// repository's current module. Both speak the same line protocol on stdout so
// the matrix can drive real cross-process contention.
//
// Usage:
//   node --experimental-strip-types lock-protocol-client.mjs \
//     --client <old|new> --module <path-to-workspace-lock.ts> \
//     --mode <acquire-once|hold|exit-holding|probe> \
//     --store <storeRoot> --operation <name> --timeout <ms>

import fs, { lstatSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const client = argument("--client");
const modulePath = argument("--module");
const mode = argument("--mode");
const storeRoot = argument("--store");
const operation = argument("--operation") ?? "capture";
const timeoutMs = Number(argument("--timeout") ?? "5000");

if (
  client === undefined ||
  modulePath === undefined ||
  mode === undefined ||
  storeRoot === undefined
) {
  process.stderr.write("lock-protocol-client: missing arguments\n");
  process.exit(64);
}

const lockModule = await import(pathToFileURL(modulePath).href);
const lockPath = join(await fs.promises.realpath(storeRoot), "workspace.lock");

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ client, pid: process.pid, ...event })}\n`,
  );
}

function lockFileState() {
  try {
    const entry = lstatSync(lockPath, { bigint: true });
    return {
      kind: entry.isDirectory()
        ? "directory"
        : entry.isFile()
          ? "file"
          : "other",
      inode: String(entry.ino),
      size: String(entry.size),
    };
  } catch (error) {
    return { kind: "absent", detail: String(error?.code ?? error) };
  }
}

// Commands are buffered from process start: a parent may send one before this
// process reaches its wait, and creating the interface lazily would either lose
// the line or resolve the wait with the interface's own synchronous "close".
const pendingCommands = [];
const commandWaiters = [];
let stdinClosed = false;
const commands = createInterface({ input: process.stdin });
commands.on("line", (line) => {
  const waiter = commandWaiters.shift();
  if (waiter === undefined) pendingCommands.push(line.trim());
  else waiter(line.trim());
});
commands.on("close", () => {
  stdinClosed = true;
  for (const waiter of commandWaiters.splice(0)) waiter(null);
});

function waitForCommand() {
  const buffered = pendingCommands.shift();
  if (buffered !== undefined) return Promise.resolve(buffered);
  if (stdinClosed) return Promise.resolve(null);
  return new Promise((resolveCommand) => commandWaiters.push(resolveCommand));
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function acquire(options = {}) {
  return await lockModule.acquireWorkspaceLock(storeRoot, operation, {
    timeoutMs: Number(timeoutMs),
    ...options,
  });
}

// Pause after a real absence observation, letting an old process win mkdir
// before the new implementation reaches its exclusive file creation.
if (argument("--pause-before-create") === "1") {
  const lstat = fs.promises.lstat;
  let paused = false;
  fs.promises.lstat = async (path, ...options) => {
    try {
      return await lstat(path, ...options);
    } catch (cause) {
      if (!paused && path === lockPath && cause.code === "ENOENT") {
        paused = true;
        emit({ event: "observed-absent" });
        if ((await waitForCommand()) === null)
          throw new Error("create-race controller closed");
      }
      throw cause;
    }
  };
  syncBuiltinESMExports();
}

try {
  switch (mode) {
    case "acquire-once": {
      const lock = await acquire();
      emit({ event: "acquired", lock: lockFileState() });
      await lock.release();
      emit({ event: "released" });
      break;
    }
    case "hold": {
      const lock = await acquire();
      emit({ event: "acquired", lock: lockFileState() });
      const command = await waitForCommand();
      if (command === null) process.exit(70);
      await lock.release();
      emit({ event: "released" });
      break;
    }
    case "exit-holding": {
      const lock = await acquire();
      emit({ event: "acquired", lock: lockFileState() });
      const command = await waitForCommand();
      if (command === null) process.exit(70);
      // Leave without releasing: the legacy directory survives the process,
      // while a native whole-file lock is released by the operating system.
      emit({ event: "exited-holding", operation: lock.operation });
      process.exit(0);
      break;
    }
    case "probe": {
      const execution = await lockModule.runWithWorkspaceLock(
        storeRoot,
        operation,
        async (authority) => {
          emit({ event: "acquired", lock: lockFileState() });
          let release = false;
          void waitForCommand().then(() => {
            release = true;
          });
          while (!release) {
            await delay(40);
            try {
              lockModule.assertWorkspaceWriteAuthority(authority, storeRoot);
            } catch (error) {
              emit({
                event: "lost",
                name: error?.name,
                message: error?.message,
              });
              return "lost";
            }
          }
          return "released";
        },
      );
      emit({
        event: "settled",
        kind: execution.kind,
        cleanup: execution.cleanup.kind,
        outcome: execution.kind === "completed" ? execution.value : undefined,
      });
      break;
    }
    default: {
      process.stderr.write(`lock-protocol-client: unknown mode ${mode}\n`);
      process.exit(64);
    }
  }
  // The command interface keeps stdin referenced, so every completed mode must
  // leave explicitly rather than waiting for the event loop to drain.
  process.exit(0);
} catch (error) {
  emit({
    event: "error",
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    lock: lockFileState(),
  });
  process.exit(3);
}
