// Lock protocol acceptance: the current build against the published 0.2.4 client.
//
// The legacy side is the real cyclotomy@0.2.4 artifact: the package is fetched
// with npm, its lock module is relocated outside node_modules so Node's type
// stripping applies, and it is executed in its own process. Every row drives
// cross-process protocol behavior. Business entry points are exercised by
// test/maintenance-lock-integration.test.ts.
//
// Usage:
//   npm run test:lock-protocol -- [--keep]
//     [--legacy <extracted cyclotomy@0.2.4 package directory>]
//
// Exit code 0 means every row held; 1 means at least one row failed.

import { execFileSync, spawn } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyLockRecovery,
  previewLockRecovery,
} from "../src/application/lock-recovery.ts";
import {
  inspectWorkspaceLock,
  acquireWorkspaceLock,
} from "../src/infrastructure/workspace-lock.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const driverPath = fileURLToPath(
  new URL("./lock-protocol-client.mjs", import.meta.url),
);
const legacyVersion = "0.2.4";
const workRoot = await mkdtemp(join(tmpdir(), "cyclotomy-matrix-"));
const keep = process.argv.includes("--keep");
const legacyArgument = process.argv.indexOf("--legacy");
const rowResults = [];

function startClient(client, mode, store, options = {}) {
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--no-warnings",
      driverPath,
      "--client",
      client,
      "--module",
      options.module ?? modulePathFor(client),
      "--mode",
      mode,
      "--store",
      store,
      "--operation",
      "protocol-check",
      "--timeout",
      String(options.timeoutMs ?? 5_000),
      ...(options.pauseBeforeCreate ? ["--pause-before-create", "1"] : []),
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const state = {
    child,
    events: [],
    stderr: "",
    exited: false,
    exitCode: null,
    signal: null,
    waiters: new Set(),
  };
  let buffered = "";
  child.stdout.on("data", (chunk) => {
    buffered += chunk.toString();
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline === -1) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.trim().length === 0) continue;
      state.events.push(JSON.parse(line));
      notify(state);
    }
  });
  child.stderr.on("data", (chunk) => {
    state.stderr += chunk.toString();
  });
  child.once("exit", (code, signal) => {
    state.exited = true;
    state.exitCode = code;
    state.signal = signal;
    notify(state);
  });
  return state;
}

function notify(state) {
  for (const waiter of state.waiters) waiter();
  state.waiters.clear();
}

function modulePathFor(client) {
  return client === "old"
    ? join(workRoot, "legacy", "src", "infrastructure", "workspace-lock.ts")
    : join(repositoryRoot, "src", "infrastructure", "workspace-lock.ts");
}

async function waitForEvent(state, type, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  const expectedFailure = type === "error" || type === "lost";
  for (;;) {
    const index = state.events.findIndex((event) => event.event === type);
    if (index !== -1) return state.events.splice(index, 1)[0];
    const failure = state.events.find(
      (event) =>
        (event.event === "error" || event.event === "lost") &&
        event.event !== type,
    );
    if (failure !== undefined) {
      if (expectedFailure) return failure;
      throw new Error(
        `client reported ${failure.name} while waiting for "${type}": ${failure.message}\n${state.stderr}`,
      );
    }
    if (state.exited) {
      throw new Error(
        `client exited before "${type}": code=${state.exitCode} signal=${state.signal}\n${state.stderr}`,
      );
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `timed out waiting for "${type}"\n${state.stderr}\n${JSON.stringify(state.events)}`,
      );
    }
    await new Promise((resolveWait) => {
      const timer = setTimeout(() => {
        state.waiters.delete(waiter);
        resolveWait();
      }, remaining);
      const waiter = () => {
        clearTimeout(timer);
        resolveWait();
      };
      state.waiters.add(waiter);
    });
  }
}

async function waitForExit(state, timeoutMs = 15_000) {
  if (state.exited) return state;
  await new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      rejectExit(new Error(`client did not exit\n${state.stderr}`));
    }, timeoutMs);
    state.child.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
  return state;
}

function send(state, command) {
  state.child.stdin.write(`${command}\n`);
}

async function stageLegacyClient(legacyDirectory) {
  const legacyRoot = join(workRoot, "legacy");
  const files = [
    "src/domain/cleanup-settlement.ts",
    "src/infrastructure/directory-binding.ts",
    "src/infrastructure/system-error.ts",
    "src/infrastructure/workspace-lock.ts",
  ];
  for (const file of files) {
    const target = join(legacyRoot, file);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(legacyDirectory, file), target);
  }
  const version = JSON.parse(
    await readFile(join(legacyDirectory, "package.json"), "utf8"),
  ).version;
  if (version !== legacyVersion) {
    throw new Error(
      `expected cyclotomy@${legacyVersion} as the legacy client, found ${version}`,
    );
  }
  return legacyRoot;
}

async function obtainLegacyPackage() {
  if (legacyArgument !== -1) {
    const provided = process.argv[legacyArgument + 1];
    if (provided === undefined) {
      throw new Error("--legacy requires a directory");
    }
    return await stageLegacyClient(provided);
  }
  const installRoot = join(workRoot, "npm");
  await mkdir(installRoot, { recursive: true });
  emit(`fetching cyclotomy@${legacyVersion} from the registry`);
  const npmCli = process.env.npm_execpath;
  if (npmCli === undefined)
    throw new Error(
      "fetch the published client with npm run test:lock-protocol, or supply --legacy",
    );
  execFileSync(
    process.execPath,
    [
      npmCli,
      "install",
      "--no-save",
      "--omit=peer",
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
      "--prefix",
      installRoot,
      `cyclotomy@${legacyVersion}`,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  return await stageLegacyClient(
    join(installRoot, "node_modules", "cyclotomy"),
  );
}

async function newStore(name) {
  const root = join(workRoot, "stores", name);
  await mkdir(root, { recursive: true });
  return root;
}

async function pathState(path) {
  try {
    const entry = await lstat(path);
    return entry.isDirectory()
      ? "directory"
      : entry.isFile()
        ? "file"
        : "other";
  } catch {
    return "absent";
  }
}

function expect(condition, detail) {
  if (!condition) throw new Error(detail);
}

function emit(message) {
  process.stdout.write(`${message}\n`);
}

async function row(name, body) {
  try {
    const detail = await body();
    rowResults.push({ name, ok: true, detail: detail ?? "" });
    emit(`  ok   ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  } catch (error) {
    rowResults.push({
      name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    emit(`  FAIL ${name} — ${rowResults.at(-1).detail}`);
  }
}

async function main() {
  await obtainLegacyPackage();

  await row(
    "old holder blocks the switch and every ordinary new client",
    async () => {
      const store = await newStore("old-holds");
      const old = startClient("old", "hold", store);
      const acquired = await waitForEvent(old, "acquired");
      expect(
        acquired.lock.kind === "directory",
        "old client must hold a directory",
      );

      // The ordinary entry respects the live old holder during automatic handover.
      const contender = startClient("new", "acquire-once", store, {
        timeoutMs: 400,
      });
      const failure = await waitForEvent(contender, "error");
      expect(
        failure.name === "WorkspaceLockTimeoutError",
        `ordinary acquisition must time out behind the old holder, observed ${failure.name}: ${failure.message}`,
      );
      await waitForExit(contender);

      expect(
        (await pathState(join(store, "lock-protocol.json"))) === "absent",
        "a blocked switch must not publish the protocol marker",
      );
      expect(
        (await readdir(join(store, "workspace.lock"))).length === 1,
        "the old client's owner record must stay untouched",
      );

      send(old, "release");
      await waitForEvent(old, "released");
      await waitForExit(old);

      const successor = startClient("new", "acquire-once", store, {});
      await waitForEvent(successor, "acquired");
      await waitForEvent(successor, "released");
      await waitForExit(successor);
      return "old directory lock respected; ordinary acquisition completed the handover";
    },
  );

  await row(
    "an upgraded store refuses the old client, held or idle",
    async () => {
      const store = await newStore("new-holds");

      const holder = startClient("new", "hold", store);
      const acquired = await waitForEvent(holder, "acquired");
      expect(
        acquired.lock.kind === "file",
        "native lock must be a regular file",
      );

      const old = startClient("old", "acquire-once", store, {
        timeoutMs: 400,
      });
      const refused = await waitForEvent(old, "error");
      expect(
        refused.name === "UnsafeWorkspaceLockPathError",
        `published ${legacyVersion} must refuse a file lock path, observed ${refused.name}: ${refused.message}`,
      );
      await waitForExit(old);

      send(holder, "release");
      await waitForEvent(holder, "released");
      await waitForExit(holder);

      // The switch is one-way: the idle file still refuses the old client.
      const idle = startClient("old", "acquire-once", store, {
        timeoutMs: 400,
      });
      const stillRefused = await waitForEvent(idle, "error");
      expect(
        stillRefused.name === "UnsafeWorkspaceLockPathError",
        `old client must stay refused after release, observed ${stillRefused.name}`,
      );
      await waitForExit(idle);
      return `published ${legacyVersion} refused with UnsafeWorkspaceLockPathError`;
    },
  );

  await row(
    "a handover never overwrites an old client that wins the create race",
    async () => {
      const store = await newStore("create-race");
      const contender = startClient("new", "acquire-once", store, {
        timeoutMs: 8_000,
        pauseBeforeCreate: true,
      });
      await waitForEvent(contender, "observed-absent");
      const old = startClient("old", "hold", store);
      const acquired = await waitForEvent(old, "acquired");
      expect(
        acquired.lock.kind === "directory",
        "old client must win with a directory",
      );
      send(contender, "continue");
      await new Promise((done) => setTimeout(done, 100));
      expect(
        !contender.events.some(({ event }) => event === "acquired"),
        "new client must wait for the old holder",
      );
      expect(
        (await pathState(join(store, "lock-protocol.json"))) === "absent",
        "a lost create race must not publish the marker",
      );
      expect(
        (await readdir(join(store, "workspace.lock"))).length === 1,
        "the old owner must stay untouched",
      );
      send(old, "release");
      await waitForEvent(old, "released");
      await waitForExit(old);
      await waitForEvent(contender, "acquired");
      await waitForEvent(contender, "released");
      await waitForExit(contender);
      expect(
        (await pathState(join(store, "workspace.lock"))) === "file",
        "the retried handover must use the persistent lock file",
      );
      return "automatic handover retried after the old client released; no overwrite";
    },
  );

  await row(
    "killing a native holder releases the lock without recreating the file",
    async () => {
      const store = await newStore("native-crash");
      const holder = startClient("new", "hold", store);
      await waitForEvent(holder, "acquired");
      const before = await lstat(join(store, "workspace.lock"), {
        bigint: true,
      });
      expect(
        holder.child.kill("SIGKILL"),
        "the holding process must be forcibly terminated",
      );
      await waitForExit(holder);

      const successor = startClient("new", "acquire-once", store, {
        timeoutMs: 2_000,
      });
      const acquired = await waitForEvent(successor, "acquired");
      await waitForEvent(successor, "released");
      await waitForExit(successor);
      expect(
        acquired.lock.inode === String(before.ino),
        "the successor must reuse the persistent lock file",
      );
      return "OS released the killed holder's lock";
    },
  );

  await row(
    "an old client that exits holding needs the offline recovery",
    async () => {
      const store = await newStore("old-exit-holding");
      const old = startClient("old", "exit-holding", store);
      await waitForEvent(old, "acquired");
      send(old, "release");
      await waitForExit(old);

      // The directory survives its process, and no preview may treat the dead
      // owner record as proof that the lock is free.
      const observed = await inspectWorkspaceLock(store);
      expect(
        observed.kind === "legacy-directory",
        "the abandoned directory must be observed as a legacy lock",
      );
      let blocked = false;
      try {
        const lock = await acquireWorkspaceLock(store, "protocol-check", {
          timeoutMs: 400,
        });
        await lock.release();
      } catch (error) {
        blocked = error?.name === "WorkspaceLockTimeoutError";
      }
      expect(
        blocked,
        "the abandoned legacy directory must block ordinary acquisition",
      );

      const recovery = await previewLockRecovery(store);
      expect(
        recovery.recoverable,
        "the abandoned directory must be recoverable",
      );
      const quarantined = await applyLockRecovery(store, recovery.planToken, {
        offline: true,
      });
      expect(
        quarantined.kind === "quarantined",
        "offline recovery must quarantine",
      );
      expect(
        (await pathState(join(store, "workspace.lock"))) === "absent",
        "the fixed path must be free after quarantine",
      );
      expect(
        (await readdir(quarantined.path)).length === 1,
        "the quarantined directory must preserve the old owner record",
      );

      const successor = startClient("new", "acquire-once", store, {});
      await waitForEvent(successor, "acquired");
      await waitForEvent(successor, "released");
      await waitForExit(successor);
      return "only the explicit offline recovery cleared the legacy directory";
    },
  );

  await row(
    "two new clients converge on one inode and one holder",
    async () => {
      const store = await newStore("two-native");

      const first = startClient("new", "hold", store);
      const held = await waitForEvent(first, "acquired");
      const second = startClient("new", "acquire-once", store, {
        timeoutMs: 400,
      });
      const failure = await waitForEvent(second, "error");
      expect(
        failure.name === "WorkspaceLockTimeoutError",
        `the second client must time out, observed ${failure.name}`,
      );
      await waitForExit(second);

      send(first, "release");
      await waitForEvent(first, "released");
      await waitForExit(first);

      const third = startClient("new", "acquire-once", store);
      const acquired = await waitForEvent(third, "acquired");
      await waitForEvent(third, "released");
      await waitForExit(third);
      expect(
        held.lock.inode === acquired.lock.inode,
        `both holders must share one inode, saw ${held.lock.inode} and ${acquired.lock.inode}`,
      );
      expect(acquired.lock.size === "0", "the lock file must stay zero length");
      return `single inode ${held.lock.inode}`;
    },
  );

  await row(
    "replacing the lock path revokes authority and is never repaired",
    async () => {
      const store = await newStore("replacement");
      const probe = startClient("new", "probe", store);
      await waitForEvent(probe, "acquired");

      await rm(join(store, "workspace.lock"));
      await writeFile(join(store, "workspace.lock"), "replacement");
      const lost = await waitForEvent(probe, "lost");
      expect(
        lost.name === "WorkspaceLockOwnershipLostError",
        `expected ownership loss, observed ${lost.name}: ${lost.message}`,
      );

      send(probe, "release");
      await waitForExit(probe);
      const replacement = await readFile(join(store, "workspace.lock"), "utf8");
      expect(
        replacement === "replacement",
        "release must not delete or rewrite a replacement object",
      );
      const diagnostic = await inspectWorkspaceLock(store);
      expect(
        diagnostic.kind === "inconsistent",
        `the store must report the inconsistency, observed ${diagnostic.kind}`,
      );
      return "authority revoked permanently; replacement preserved";
    },
  );

  const failures = rowResults.filter((result) => !result.ok);
  emit("");
  emit(
    `${rowResults.length - failures.length}/${rowResults.length} rows passed on ${process.platform}-${process.arch}`,
  );
  if (keep) emit(`work directory: ${workRoot}`);
  return failures.length === 0 ? 0 : 1;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  emit(
    `matrix setup failed: ${error instanceof Error ? error.stack : String(error)}`,
  );
} finally {
  if (!keep) {
    await rm(workRoot, { recursive: true, force: true }).catch(() => {});
  }
}
process.exit(exitCode);
