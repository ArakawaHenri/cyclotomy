#!/usr/bin/env node
import { runCli } from "./cli/main.ts";

/**
 * The `cyclotomy` command. It reads one workspace store, writes only through an
 * explicit `--apply`, and turns SIGINT into a cancelled run (exit code 130)
 * rather than an abrupt termination mid-write.
 */
const controller = new AbortController();
const cancel = (): void => {
  controller.abort();
};
process.on("SIGINT", cancel);

try {
  process.exitCode = await runCli(
    process.argv.slice(2),
    {
      out: (text) => {
        process.stdout.write(text);
      },
      err: (text) => {
        process.stderr.write(text);
      },
    },
    { signal: controller.signal },
  );
} finally {
  process.off("SIGINT", cancel);
}
