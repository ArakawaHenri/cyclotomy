import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { openWorkspaceRegularCandidate } from "../src/infrastructure/workspace-file-open.ts";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const CHILD_PROCESS_WATCHDOG_MS = 30_000;

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cyclotomy-workspace-open-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("workspace regular-file candidate opening", () => {
  it("preserves ordinary regular-file read semantics", async () => {
    const root = await scratch();
    const path = join(root, "regular.txt");
    await writeFile(path, "ordinary bytes");

    const handle = await openWorkspaceRegularCandidate(
      path,
      constants.O_RDONLY,
    );
    try {
      expect((await handle.stat()).isFile()).toBe(true);
      expect(await handle.readFile("utf8")).toBe("ordinary bytes");
    } finally {
      await handle.close();
    }
  });

  it("does not wait for a writer when the candidate is a FIFO", async (context) => {
    context.skip(
      process.platform === "win32",
      "Windows filesystems do not expose POSIX FIFO entries",
    );
    const root = await scratch();
    const fifo = join(root, "raced-in-fifo");
    await execFileAsync("mkfifo", [fifo]);

    // Run the no-peer FIFO open in a child so a regression cannot wedge the
    // Vitest worker itself. Without O_NONBLOCK this process reaches the timeout.
    const moduleUrl = new URL(
      "../src/infrastructure/workspace-file-open.ts",
      import.meta.url,
    ).href;
    const script = `
      import { constants } from "node:fs";
      import { openWorkspaceRegularCandidate } from ${JSON.stringify(moduleUrl)};
      const handle = await openWorkspaceRegularCandidate(
        ${JSON.stringify(fifo)},
        constants.O_RDONLY,
      );
      try {
        process.stdout.write((await handle.stat()).isFIFO() ? "fifo" : "other");
      } finally {
        await handle.close();
      }
    `;

    const result = await execFileAsync(
      process.execPath,
      ["--input-type=module", "--eval", script],
      { timeout: CHILD_PROCESS_WATCHDOG_MS },
    );
    expect(result.stdout).toBe("fifo");
  });
});
