// Build the complete CLI dependency graph and prepare its npm bin entry.
import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const outputPath = fileURLToPath(new URL("../dist", import.meta.url));
rmSync(outputPath, { recursive: true, force: true });
execFileSync(
  process.execPath,
  [
    fileURLToPath(
      new URL("../node_modules/typescript/bin/tsc", import.meta.url),
    ),
    "-p",
    "tsconfig.build.json",
  ],
  { cwd: repositoryRoot, stdio: "inherit" },
);

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
if (!readFileSync(cliPath, "utf8").startsWith("#!/usr/bin/env node")) {
  throw new Error("dist/cli.js must start with the node shebang");
}
chmodSync(cliPath, 0o755);
