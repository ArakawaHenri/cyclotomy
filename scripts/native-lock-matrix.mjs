import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const clientPath = fileURLToPath(
  new URL("./native-lock-client.mjs", import.meta.url),
);
const sandbox = await mkdtemp(join(tmpdir(), "cyclotomy-native-matrix-"));
const clients = new Set();

class Client {
  constructor(runtime) {
    this.runtime = runtime;
    this.pending = [];
    this.child = spawn(
      runtime.command,
      [...runtime.args, clientPath, runtime.root, runtime.version],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    this.stderr = "";
    this.child.stderr.on("data", (data) => {
      this.stderr += data;
    });
    this.exited = once(this.child, "exit");
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => {
      const next = this.pending.shift();
      assert.ok(next, `Unexpected child output: ${line}`);
      clearTimeout(next.timer);
      next.resolve(JSON.parse(line));
    });
    this.child.on("exit", (code, signal) => {
      for (const next of this.pending.splice(0)) {
        clearTimeout(next.timer);
        next.reject(
          new Error(`${runtime.name} exited ${code ?? signal}: ${this.stderr}`),
        );
      }
    });
    clients.add(this);
    this.ready = this.receive();
  }
  receive() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error(`${this.runtime.name} timed out: ${this.stderr}`)),
        40000,
      );
      this.pending.push({ resolve, reject, timer });
    });
  }
  async call(command, errorName) {
    await this.ready;
    const response = this.receive();
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
    const result = await response;
    if (errorName) assert.equal(result.name, errorName, JSON.stringify(result));
    else
      assert.equal(
        result.ok,
        true,
        `${this.runtime.name}: ${JSON.stringify(result)}`,
      );
    return result.value;
  }
  async close(kill = false) {
    if (kill) this.child.kill("SIGKILL");
    else this.child.stdin.end();
    const [code] = await this.exited;
    if (!kill) assert.equal(code, 0, this.stderr);
    clients.delete(this);
  }
}

try {
  // Install the released package, then relocate its TS sources outside node_modules.
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, "Run this matrix through npm run test:lock-runtimes");
  execFileSync(
    process.execPath,
    [
      npmCli,
      "install",
      "--prefix",
      sandbox,
      "--ignore-scripts",
      "--omit=peer",
      "--no-package-lock",
      "--no-audit",
      "--no-fund",
      "cyclotomy@0.3.1",
    ],
    { stdio: "inherit" },
  );
  const released = join(sandbox, "released");
  await cp(join(sandbox, "node_modules/cyclotomy"), released, {
    recursive: true,
  });
  const runtimes = [
    {
      name: "Node current",
      command: process.execPath,
      args: [],
      root,
      version: "current",
    },
    {
      name: "Deno current",
      command: process.env.DENO_BIN ?? "deno",
      args: [
        "run",
        "--no-config",
        "--no-lock",
        "--node-modules-dir=manual",
        "-A",
      ],
      root,
      version: "current",
    },
    {
      name: "Node 0.3.1",
      command: process.execPath,
      args: [],
      root: released,
      version: "released",
    },
  ];
  const store = join(sandbox, "store");
  await mkdir(store);
  const lockPath = join(store, "workspace.lock");
  // The production acquisition path creates and validates the persistent lock file.
  const setup = new Client(runtimes[0]);
  await setup.call({ op: "acquire", path: store, id: "s" });
  await setup.call({ op: "release", id: "s" });
  await setup.close();
  for (const holder of runtimes)
    for (const waiter of runtimes) {
      const h = new Client(holder),
        w = new Client(waiter);
      await h.call({ op: "acquire", path: store, id: "h" });
      await w.call(
        { op: "acquire", path: store, id: "w" },
        "WorkspaceLockTimeoutError",
      );
      await w.call({ op: "cancel", path: store });
      await h.call({ op: "release", id: "h" });
      await w.call({ op: "acquire", path: store, id: "w" });
      await w.call({ op: "release", id: "w" });
      await h.call({ op: "open", path: lockPath, id: "s" });
      await w.call({ op: "open", path: lockPath, id: "s" });
      await w.call({ op: "open", path: lockPath, id: "probe" });
      assert.equal(await h.call({ op: "try", id: "s", shared: true }), true);
      assert.equal(await w.call({ op: "try", id: "s", shared: true }), true);
      assert.equal(await w.call({ op: "try", id: "probe" }), false);
      await h.call({ op: "close", id: "s" });
      assert.equal(await w.call({ op: "try", id: "probe" }), false);
      await w.call({ op: "close", id: "s" });
      assert.equal(await w.call({ op: "try", id: "probe" }), true);
      await w.call({ op: "close", id: "probe" });
      await h.call({ op: "acquire", path: store, id: "h" });
      await h.close(true);
      await w.call({ op: "acquire", path: store, id: "w", timeout: 5000 });
      await w.call({ op: "release", id: "w" });
      await w.close();
      console.log(`Passed: ${holder.name} → ${waiter.name}`);
    }
  const counter = join(sandbox, "counter");
  await writeFile(counter, "0");
  const concurrent = runtimes.map((runtime) => new Client(runtime));
  await Promise.all(
    concurrent.map((c) =>
      c.call({ op: "stress", path: store, counter, count: 100 }),
    ),
  );
  assert.equal(await readFile(counter, "utf8"), "300");
  await Promise.all(concurrent.map((c) => c.close()));
  for (const runtime of runtimes.filter((r) => r.version === "current")) {
    const c = new Client(runtime);
    await c.call({ op: "lifecycle", path: lockPath });
    assert.equal(await c.call({ op: "worker", path: lockPath, id: "w" }), true);
    await c.call({ op: "open", path: lockPath, id: "probe" });
    assert.equal(await c.call({ op: "try", id: "probe" }), false);
    await c.call({ op: "terminate", id: "w" });
    assert.equal(await c.call({ op: "try", id: "probe" }), true);
    await c.close();
  }
  console.log(
    "Native lock matrix passed: production locks, cancellation, shared holders, crash/worker release, native allocation cleanup, concurrent writes.",
  );
} finally {
  await Promise.all([...clients].map((c) => c.close(true)));
  await rm(sandbox, { recursive: true, force: true });
}
