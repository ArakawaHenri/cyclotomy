import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";

type RetryScenario =
  | "formation-before-owner"
  | "formation-after-owner"
  | "vanished-contention"
  | "transient-contention-observation";

interface RetryState {
  readonly scenario: RetryScenario;
  readonly lockPath: string;
  mkdirCalls: number;
  readdirCalls: number;
}

interface RetryResult {
  readonly scenario: RetryScenario;
  readonly expectedLockPath: string;
  readonly mkdirCalls: number;
  readonly errorName: string | undefined;
  readonly errorMessage: string | undefined;
  readonly errorLockPath: unknown;
}

const scenarios: readonly RetryScenario[] = [
  "formation-before-owner",
  "formation-after-owner",
  "vanished-contention",
  "transient-contention-observation",
];
const retriedAfterDeadline = new Error("retried after zero timeout");
let state: RetryState | undefined;

function pathString(path: unknown): string | undefined {
  return typeof path === "string" ? path : undefined;
}

function fileSystemError(code: string): Error & { readonly code: string } {
  return Object.assign(new Error(code), { code });
}

const fileSystemMock = mock.module("node:fs/promises", {
  namedExports: {
    ...fsPromises,
    mkdir: async (path: unknown, options?: unknown) => {
      if (state === undefined || pathString(path) !== state.lockPath) {
        return Reflect.apply(fsPromises.mkdir, undefined, [path, options]);
      }
      state.mkdirCalls += 1;
      if (state.mkdirCalls > 1) throw retriedAfterDeadline;
      switch (state.scenario) {
        case "formation-before-owner":
          return undefined;
        case "formation-after-owner":
          return Reflect.apply(fsPromises.mkdir, undefined, [path, options]);
        case "vanished-contention":
        case "transient-contention-observation":
          throw fileSystemError("EEXIST");
      }
    },
    lstat: async (path: unknown, options?: unknown) => {
      if (
        state !== undefined &&
        pathString(path) === state.lockPath &&
        state.scenario !== "formation-after-owner" &&
        state.scenario !== "transient-contention-observation"
      ) {
        throw fileSystemError("ENOENT");
      }
      return Reflect.apply(fsPromises.lstat, undefined, [path, options]);
    },
    readdir: async (path: unknown, options?: unknown) => {
      if (
        state !== undefined &&
        pathString(path) === state.lockPath &&
        state.scenario === "formation-after-owner"
      ) {
        state.readdirCalls += 1;
        if (state.readdirCalls <= 2) return [];
      }
      if (
        state !== undefined &&
        pathString(path) === state.lockPath &&
        state.scenario === "transient-contention-observation"
      ) {
        state.readdirCalls += 1;
        throw fileSystemError("EPERM");
      }
      return Reflect.apply(fsPromises.readdir, undefined, [path, options]);
    },
  },
});

const { acquireWorkspaceLock } =
  await import("../../src/infrastructure/workspace-lock.ts");
const results: RetryResult[] = [];

try {
  for (const scenario of scenarios) {
    const temporaryRoot = await fsPromises.mkdtemp(
      join(tmpdir(), "cyclotomy-lock-retry-"),
    );
    try {
      const root = await fsPromises.realpath(temporaryRoot);
      const lockPath = join(root, "workspace.lock");
      if (scenario === "transient-contention-observation") {
        await fsPromises.mkdir(lockPath);
      }
      state = { scenario, lockPath, mkdirCalls: 0, readdirCalls: 0 };
      let failure: unknown;
      try {
        const lock = await acquireWorkspaceLock(root, scenario, {
          timeoutMs: 0,
        });
        await lock.release();
      } catch (cause) {
        failure = cause;
      }
      results.push({
        scenario,
        expectedLockPath: lockPath,
        mkdirCalls: state.mkdirCalls,
        errorName: failure instanceof Error ? failure.name : undefined,
        errorMessage: failure instanceof Error ? failure.message : undefined,
        errorLockPath:
          typeof failure === "object" && failure !== null
            ? Reflect.get(failure, "lockPath")
            : undefined,
      });
    } finally {
      state = undefined;
      await fsPromises.rm(temporaryRoot, { recursive: true, force: true });
    }
  }
} finally {
  fileSystemMock.restore();
}

process.stdout.write(`${JSON.stringify(results)}\n`);
