#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function runNpm(args, cwd, cache) {
  const npmCli = process.env.npm_execpath;
  const command =
    npmCli === undefined
      ? process.platform === "win32"
        ? "npm.cmd"
        : "npm"
      : process.execPath;
  const commandArgs = npmCli === undefined ? args : [npmCli, ...args];
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key.toLowerCase() !== "npm_config_dry_run",
    ),
  );
  await execFileAsync(command, commandArgs, {
    cwd,
    env: {
      ...inheritedEnvironment,
      NPM_CONFIG_AUDIT: "false",
      NPM_CONFIG_CACHE: cache,
      // `npm publish --dry-run` exports this setting to prepublishOnly. The
      // nested pack/install are local smoke-test mechanics and must still
      // materialize their temporary artifact.
      NPM_CONFIG_DRY_RUN: "false",
      NPM_CONFIG_FUND: "false",
      NPM_CONFIG_UPDATE_NOTIFIER: "false",
      npm_config_dry_run: "false",
    },
    maxBuffer: 10 * 1024 * 1024,
  });
}

const sandbox = await mkdtemp(join(tmpdir(), "cyclotomy-package-smoke-"));
const npmCache = join(sandbox, "npm-cache");
const packDirectory = join(sandbox, "pack");
const agentDir = join(sandbox, "agent");
const installRoot = join(agentDir, "npm");
const workspace = join(sandbox, "workspace");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousOffline = process.env.PI_OFFLINE;

try {
  await Promise.all([
    mkdir(packDirectory, { recursive: true }),
    mkdir(installRoot, { recursive: true }),
    mkdir(npmCache, { recursive: true }),
    mkdir(workspace, { recursive: true }),
  ]);

  // Build the exact artifact npm would publish. Lifecycle scripts are disabled
  // so this smoke test can also run safely from prepublishOnly.
  await runNpm(
    ["pack", "--ignore-scripts", "--pack-destination", packDirectory],
    repositoryRoot,
    npmCache,
  );
  const archives = (await readdir(packDirectory)).filter((name) =>
    name.endsWith(".tgz"),
  );
  assert.equal(archives.length, 1, "npm pack must produce exactly one archive");
  const archive = join(packDirectory, archives[0]);

  // Install only the packed artifact into Pi's managed user-package layout.
  // Include runtime dependencies but omit Pi peers: the locked host supplies
  // the public extension API, and the CLI must start independently of Pi.
  await runNpm(
    [
      "install",
      "--prefix",
      installRoot,
      "--ignore-scripts",
      "--omit=peer",
      "--no-package-lock",
      "--no-audit",
      "--no-fund",
      archive,
    ],
    sandbox,
    npmCache,
  );

  const installedRoot = join(installRoot, "node_modules", "cyclotomy");
  const manifest = JSON.parse(
    await readFile(join(installedRoot, "package.json"), "utf8"),
  );
  assert.equal(manifest.name, "cyclotomy");
  assert.equal(typeof manifest.version, "string");
  assert.deepEqual(manifest.pi?.extensions, ["./src/index.ts"]);
  assert.deepEqual(manifest.exports, { ".": "./src/index.ts" });
  assert.deepEqual(manifest.bin, { cyclotomy: "./dist/cli.js" });
  assert.ok(
    await readFile(join(installedRoot, "dist", "cli.js"), "utf8"),
    "the packed tarball must contain the built CLI (run `npm run build`)",
  );
  const installedRequire = createRequire(
    join(installRoot, "package-smoke.cjs"),
  );
  assert.throws(
    () => installedRequire.resolve("cyclotomy/src/pi/runtime.ts"),
    (error) => error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
    "published internals must not be deep-importable",
  );

  // Resolve through Pi's configured-package path, not a direct source import.
  // Offline mode makes a missing or mismatched managed install fail rather
  // than silently repairing the test through the registry.
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  const settingsManager = SettingsManager.inMemory({
    packages: [`npm:cyclotomy@${manifest.version}`],
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: workspace,
    agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();

  const loaded = resourceLoader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0];
  assert.deepEqual([...extension.commands.keys()].sort(), [
    "cyclotomy",
    "drift",
    "restore",
  ]);
  assert.equal(
    await realpath(extension.path),
    await realpath(join(installedRoot, "src", "index.ts")),
    "Pi must load the entry point from the installed tarball",
  );

  // The installed CLI must run from the tarball alone, without Pi's peer
  // runtime and without the repository on disk.
  const cliShim = join(
    installRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "cyclotomy.cmd" : "cyclotomy",
  );
  const runInstalledCli = (args, options) =>
    process.platform === "win32"
      ? execFileAsync(
          process.env.ComSpec ?? "cmd.exe",
          [
            "/d",
            "/s",
            "/c",
            `"${[cliShim, ...args].map((argument) => `"${argument}"`).join(" ")}"`,
          ],
          { ...options, windowsVerbatimArguments: true },
        )
      : execFileAsync(cliShim, args, options);
  const help = await runInstalledCli(["--help"], {
    cwd: workspace,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => key.toLowerCase() !== "node_options",
        ),
      ),
      PI_CODING_AGENT_DIR: agentDir,
    },
  });
  assert.match(help.stdout, /Usage: cyclotomy <command>/u);

  await assert.rejects(
    runInstalledCli(["doctor", "--workspace", join(workspace, "gone")], {
      cwd: workspace,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
    }),
    (error) => error.code === 2,
    "an unresolvable workspace must exit 2",
  );

  const doctor = await runInstalledCli(["doctor", "--json"], {
    cwd: workspace,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
  });
  assert.equal(JSON.parse(doctor.stdout).schemaVersion, 1);
  assert.equal(JSON.parse(doctor.stdout).command, "doctor");

  // Load the native dependency from the installed artifact with scripts and
  // peers omitted, and exercise the compiled module's actual lock entry.
  const nativeStore = join(sandbox, "native-store");
  await mkdir(nativeStore);
  const installedLock = await import(
    pathToFileURL(
      join(installedRoot, "dist", "infrastructure", "workspace-lock.js"),
    ).href
  );
  await installedLock.withWorkspaceLock(
    nativeStore,
    "installed package smoke",
    async (authority) => {
      installedLock.assertWorkspaceWriteAuthority(authority, nativeStore);
    },
  );

  console.log("Package smoke passed: npm tarball installed and loaded by Pi.");
} finally {
  if (previousAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
  if (previousOffline === undefined) {
    delete process.env.PI_OFFLINE;
  } else {
    process.env.PI_OFFLINE = previousOffline;
  }
  await rm(sandbox, { recursive: true, force: true });
}
