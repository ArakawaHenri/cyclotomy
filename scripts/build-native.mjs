import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const target = join(root, "prebuilds", `${process.platform}-${process.arch}`);
execFileSync(
  process.execPath,
  [
    require.resolve("node-gyp/bin/node-gyp.js"),
    "rebuild",
    "--directory",
    join(root, "native"),
    ...process.argv.slice(2),
  ],
  { stdio: "inherit" },
);
mkdirSync(target, { recursive: true });
// Replacing the inode avoids invalidating a loaded Mach-O code signature.
const staged = join(target, `.file-lock-${randomUUID()}.node`);
copyFileSync(
  join(root, "native", "build", "Release", "file-lock.node"),
  staged,
);
renameSync(staged, join(target, "file-lock.node"));
