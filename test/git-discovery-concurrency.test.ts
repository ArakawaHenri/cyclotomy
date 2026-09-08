import * as childProcess from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import { discoverWorkspaceScope } from "../src/infrastructure/git-ignore-oracle.ts";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});
const actualProcess =
  await vi.importActual<typeof import("node:child_process")>(
    "node:child_process",
  );
const execFileAsync = promisify(actualProcess.execFile);
const roots: string[] = [];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "cyclotomy-discovery-reads-"));
  roots.push(root);
  await execFileAsync("git", ["-C", root, "init", "-q"]);
  await writeFile(join(root, ".gitignore"), "node_modules/\n*.log\n");
  return root;
}

function isDiscoveryCommand(args: readonly string[]): boolean {
  return (
    args[0] === "--version" ||
    args.includes("--git-path") ||
    ["core.excludesFile", "core.ignoreCase", "core.precomposeUnicode"].includes(
      args.at(-1) ?? "",
    )
  );
}

type GitCallback = (
  error: childProcess.ExecFileException | null,
  stdout: Buffer,
  stderr: Buffer,
) => void;

afterEach(async () => {
  vi.mocked(childProcess.execFile).mockImplementation(actualProcess.execFile);
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("parallel Git scope discovery", () => {
  it("reads the independent Git settings concurrently without changing the discovered scope bytes", async () => {
    const root = await repository();
    const expected = JSON.stringify((await discoverWorkspaceScope(root)).scope);
    const allStarted = deferred();
    const release = deferred();
    let started = 0;
    vi.mocked(childProcess.execFile).mockImplementation(((
      file: string,
      args: readonly string[],
      options: childProcess.ExecFileOptionsWithBufferEncoding,
      callback: GitCallback,
    ) => {
      const independent = isDiscoveryCommand(args);
      if (independent && ++started === 5) allStarted.resolve();
      return actualProcess.execFile(
        file,
        args,
        options,
        (error, stdout, stderr) => {
          if (independent)
            void release.promise.then(() => callback(error, stdout, stderr));
          else callback(error, stdout, stderr);
        },
      );
    }) as typeof childProcess.execFile);
    const discovering = discoverWorkspaceScope(root);
    try {
      await allStarted.promise;
      release.resolve();
      expect(JSON.stringify((await discovering).scope)).toBe(expected);
      expect(started).toBe(5);
    } finally {
      release.resolve();
      await discovering;
    }
  });

  it("settles every in-flight Git command before surfacing a discovery failure", async () => {
    const root = await repository();
    const othersFinished = deferred();
    const release = deferred();
    const failed = new Error("injected info/exclude lookup failure");
    const children: childProcess.ChildProcess[] = [];
    let held = 0;
    vi.mocked(childProcess.execFile).mockImplementation(((
      file: string,
      args: readonly string[],
      options: childProcess.ExecFileOptionsWithBufferEncoding,
      callback: GitCallback,
    ) => {
      const independent = isDiscoveryCommand(args);
      const child = actualProcess.execFile(
        file,
        args,
        options,
        (error, stdout, stderr) => {
          if (!independent) callback(error, stdout, stderr);
          else if (args.includes("--git-path"))
            callback(failed, Buffer.alloc(0), Buffer.alloc(0));
          else {
            held += 1;
            if (held === 4) othersFinished.resolve();
            void release.promise.then(() => callback(error, stdout, stderr));
          }
        },
      );
      if (independent) children.push(child);
      return child;
    }) as typeof childProcess.execFile);
    let settled = false;
    const discovering = discoverWorkspaceScope(root).then(
      () => {
        settled = true;
        return undefined;
      },
      (cause: unknown) => {
        settled = true;
        return cause;
      },
    );
    try {
      await othersFinished.promise;
      expect(settled).toBe(false);
      release.resolve();
      expect(await discovering).toMatchObject({
        message: "cannot determine Git info/exclude path",
        cause: failed,
      });
      expect(children).toHaveLength(5);
      expect(
        children.every(
          (child) => child.exitCode !== null || child.signalCode !== null,
        ),
      ).toBe(true);
    } finally {
      release.resolve();
      await discovering;
    }
  });
});
