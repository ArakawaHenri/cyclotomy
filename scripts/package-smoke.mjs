#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function runNpm(args, cwd) {
  const npmCli = process.env.npm_execpath;
  const command = npmCli === undefined
    ? (process.platform === "win32" ? "npm.cmd" : "npm")
    : process.execPath;
  const commandArgs = npmCli === undefined ? args : [npmCli, ...args];
  await execFileAsync(command, commandArgs, {
    cwd,
    env: {
      ...process.env,
      NPM_CONFIG_AUDIT: "false",
      NPM_CONFIG_FUND: "false",
      NPM_CONFIG_UPDATE_NOTIFIER: "false",
    },
    maxBuffer: 10 * 1024 * 1024,
  });
}

const sandbox = await mkdtemp(join(tmpdir(), "cyclotomy-package-smoke-"));
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
    mkdir(workspace, { recursive: true }),
  ]);

  // Build the exact artifact npm would publish. Lifecycle scripts are disabled
  // so this smoke test can also run safely from prepublishOnly.
  await runNpm([
    "pack",
    "--ignore-scripts",
    "--pack-destination",
    packDirectory,
  ], repositoryRoot);
  const archives = (await readdir(packDirectory))
    .filter((name) => name.endsWith(".tgz"));
  assert.equal(archives.length, 1, "npm pack must produce exactly one archive");
  const archive = join(packDirectory, archives[0]);

  // Install only the packed artifact into Pi's managed user-package layout.
  // Cyclotomy has no runtime dependencies; legacy-peer-deps deliberately keeps
  // npm from fetching its Pi peer and proves the locked host can supply it.
  await runNpm([
    "install",
    "--prefix",
    installRoot,
    "--ignore-scripts",
    "--legacy-peer-deps",
    "--no-package-lock",
    "--no-audit",
    "--no-fund",
    archive,
  ], sandbox);

  const installedRoot = join(installRoot, "node_modules", "cyclotomy");
  const manifest = JSON.parse(
    await readFile(join(installedRoot, "package.json"), "utf8"),
  );
  assert.equal(manifest.name, "cyclotomy");
  assert.equal(typeof manifest.version, "string");
  assert.deepEqual(manifest.pi?.extensions, ["./src/index.ts"]);

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
  assert.deepEqual([...extension.commands.keys()].sort(), ["drift", "restore"]);
  assert.equal(
    await realpath(extension.path),
    await realpath(join(installedRoot, "src", "index.ts")),
    "Pi must load the entry point from the installed tarball",
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
