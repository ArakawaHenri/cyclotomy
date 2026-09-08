import * as childProcess from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createLiveGitIgnoreOracle,
  createSyntheticGitIgnoreOracle,
  discoverWorkspaceScope,
} from "../src/infrastructure/git-ignore-oracle.ts";
import { scanWorkspace } from "../src/infrastructure/workspace-scan.ts";
import { DEFAULT_WORKSPACE_PATH_LIMITS } from "../src/infrastructure/workspace-scope.ts";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: vi.fn(original.spawn) };
});

const execFileAsync = promisify(childProcess.execFile);
const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cyclotomy-git-cancel-"));
  roots.push(root);
  return root;
}

async function repositoryFixture() {
  const workspace = await tempRoot();
  await execFileAsync("git", ["-C", workspace, "init", "-q"]);
  await writeFile(join(workspace, ".gitignore"), "*.log\n");
  const discovery = await discoverWorkspaceScope(workspace);
  return { workspace, scope: discovery.scope };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Git ignore cancellation", () => {
  it.each(["live", "synthetic"] as const)(
    "cancels active and queued %s queries and waits for process exit",
    async (kind) => {
      const { workspace, scope } = await repositoryFixture();
      const scratchParent = await tempRoot();
      const controller = new AbortController();
      const reason = new Error("capture cancelled");
      const spawn = vi.mocked(childProcess.spawn);
      const oracle =
        kind === "live"
          ? await createLiveGitIgnoreOracle(
              workspace,
              scope,
              DEFAULT_WORKSPACE_PATH_LIMITS,
              controller.signal,
            )
          : await createSyntheticGitIgnoreOracle(scope, {
              scratchParent,
              signal: controller.signal,
            });
      const child = spawn.mock.results.at(-1)!
        .value as ChildProcessWithoutNullStreams;
      let exited = false;
      child.once("close", () => {
        exited = true;
      });
      // Cancel on Git's first response before the oracle consumes its bytes.
      child.stdout.prependOnceListener("data", () => controller.abort(reason));
      const active = expect(
        oracle.managed([{ path: "drop.log", kind: "non-directory" }]),
      ).rejects.toBe(reason);
      const queued = expect(
        oracle.managed([{ path: "keep.txt", kind: "non-directory" }]),
      ).rejects.toBe(reason);
      try {
        await Promise.all([active, queued]);
        await oracle.close();
        expect(exited).toBe(true);
        expect(await readdir(scratchParent)).toEqual([]);
      } finally {
        controller.abort(reason);
        await oracle.close();
      }
    },
  );

  it("retains synthetic scratch cleanup failures after cancellation", async () => {
    const { scope } = await repositoryFixture();
    const scratchParent = await tempRoot();
    const controller = new AbortController();
    const spawn = vi.mocked(childProcess.spawn);
    const oracle = await createSyntheticGitIgnoreOracle(scope, {
      scratchParent,
      signal: controller.signal,
    });
    const child = spawn.mock.results.at(-1)!
      .value as ChildProcessWithoutNullStreams;
    const exited = once(child, "close");
    controller.abort();
    await exited;
    const entries = await readdir(scratchParent);
    expect(entries).toHaveLength(1);
    const activePath = join(scratchParent, entries[0]!);
    await rename(activePath, join(scratchParent, "displaced"));
    await mkdir(activePath);
    const sentinelPath = join(activePath, "sentinel");
    await writeFile(sentinelPath, "replacement must survive");

    await expect(oracle.close()).rejects.toThrow(
      "refusing to clean a replaced synthetic Git scratch directory",
    );
    expect(await readFile(sentinelPath, "utf8")).toBe(
      "replacement must survive",
    );
  });

  it("cancels a real Git workspace scan and closes its ignore subprocess", async () => {
    const { workspace } = await repositoryFixture();
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        writeFile(join(workspace, `file-${index}.txt`), `contents-${index}`),
      ),
    );
    const scratchParent = await tempRoot();
    const controller = new AbortController();
    const reason = new Error("scan cancelled");
    const spawn = vi.mocked(childProcess.spawn);

    await expect(
      scanWorkspace(workspace, {
        gitIgnoreScratchParent: scratchParent,
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.files > 0) controller.abort(reason);
        },
      }),
    ).rejects.toThrow(reason.message);

    const children = spawn.mock.results.map(
      (result) => result.value as ChildProcessWithoutNullStreams,
    );
    expect(children.length).toBeGreaterThan(0);
    expect(
      children.every(
        (child) => child.exitCode !== null || child.signalCode !== null,
      ),
    ).toBe(true);
    expect(await readdir(scratchParent)).toEqual([]);
  });
});
