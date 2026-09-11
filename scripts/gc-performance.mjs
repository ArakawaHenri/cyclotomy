// Run isolated GC measurements with an explicit collector available.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

execFileSync(
  process.execPath,
  [
    "--expose-gc",
    "--experimental-strip-types",
    fileURLToPath(new URL("./gc-performance.ts", import.meta.url)),
  ],
  {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: "inherit",
  },
);
