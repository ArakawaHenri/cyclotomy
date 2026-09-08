import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setImmediate as immediate } from "node:timers/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as workspaceFileOpen from "../src/infrastructure/workspace-file-open.ts";
import { isOperationCancelled } from "../src/infrastructure/workspace-operation.ts";
import {
  scanWorkspace,
  ScanError,
} from "../src/infrastructure/workspace-scan.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});
const originalFs =
  await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const roots: string[] = [];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

async function workspace(
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cyclotomy-scan-concurrency-"));
  roots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), contents);
  }
  return root;
}

function fileSet(count: number): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `file-${String(index).padStart(3, "0")}.txt`,
      `contents-${index}`,
    ]),
  );
}

function failuresIn(cause: unknown): unknown[] {
  const seen = new Set<unknown>();
  const result: unknown[] = [];
  const visit = (error: unknown): void => {
    if (seen.has(error)) return;
    seen.add(error);
    result.push(error);
    if (error instanceof AggregateError) error.errors.forEach(visit);
    if (error instanceof Error && error.cause !== undefined) visit(error.cause);
  };
  visit(cause);
  return result;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(lstat).mockImplementation(originalFs.lstat);
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("bounded workspace scanning", () => {
  it("bounds stat and open-file work across nested directories while reading files concurrently", async () => {
    const files = fileSet(32);
    for (let directory = 0; directory < 4; directory += 1) {
      for (const [name, content] of Object.entries(fileSet(16))) {
        files[`dir-${directory}/nested/${name}`] = content;
      }
    }
    const root = await workspace(files);
    const release = deferred();
    const concurrent = deferred();
    let activeStats = 0;
    let maxStats = 0;
    vi.mocked(lstat).mockImplementation(async (...args) => {
      activeStats += 1;
      maxStats = Math.max(maxStats, activeStats);
      try {
        return await originalFs.lstat(...args);
      } finally {
        activeStats -= 1;
      }
    });
    const open = workspaceFileOpen.openWorkspaceRegularCandidate;
    let activeFiles = 0;
    let maxFiles = 0;
    let opened = 0;
    let closed = 0;
    vi.spyOn(
      workspaceFileOpen,
      "openWorkspaceRegularCandidate",
    ).mockImplementation(async (path, mode) => {
      activeFiles += 1;
      maxFiles = Math.max(maxFiles, activeFiles);
      const handle = await open(path, mode);
      opened += 1;
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        try {
          await close();
        } finally {
          activeFiles -= 1;
          closed += 1;
        }
      });
      if (activeFiles > 1) concurrent.resolve();
      await release.promise;
      return handle;
    });
    const scanning = scanWorkspace(root);
    try {
      await concurrent.promise;
      release.resolve();
      const snapshot = await scanning;
      expect(snapshot.problems).toEqual([]);
      expect(snapshot.entries).toHaveLength(Object.keys(files).length);
      expect(maxStats).toBeGreaterThan(1);
      expect(maxStats).toBeLessThanOrEqual(8);
      expect(maxFiles).toBeGreaterThan(1);
      expect(maxFiles).toBeLessThanOrEqual(8);
      expect(activeStats).toBe(0);
      expect(activeFiles).toBe(0);
      expect(closed).toBe(opened);
    } finally {
      release.resolve();
      await scanning.catch(() => undefined);
    }
  });

  it("settles the active stat batch after cancellation without opening files or scheduling the next batch", async () => {
    const root = await workspace(fileSet(32));
    const controller = new AbortController();
    const started = deferred();
    const release = deferred();
    const paths: string[] = [];
    const startedAfterAbort: string[] = [];
    vi.mocked(lstat).mockImplementation(async (...args) => {
      const path = String(args[0]);
      if (!basename(path).startsWith("file-")) return originalFs.lstat(...args);
      if (controller.signal.aborted) startedAfterAbort.push(path);
      paths.push(path);
      const observation = await originalFs.lstat(...args);
      if (paths.length > 1) started.resolve();
      await release.promise;
      return observation;
    });
    const open = vi.spyOn(workspaceFileOpen, "openWorkspaceRegularCandidate");
    let settled = false;
    const scanning = scanWorkspace(root, { signal: controller.signal }).then(
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
      await started.promise;
      controller.abort();
      await immediate();
      expect(settled).toBe(false);
      release.resolve();
      expect(isOperationCancelled(await scanning, controller.signal)).toBe(
        true,
      );
      expect(paths.length).toBeGreaterThan(1);
      expect(paths.length).toBeLessThanOrEqual(8);
      expect(startedAfterAbort).toEqual([]);
      expect(open).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await scanning;
    }
  });

  it("waits for all active files to close on cancellation without starting new files", async () => {
    const root = await workspace(fileSet(40));
    const controller = new AbortController();
    const started = deferred();
    const releaseOpen = deferred();
    const closeStarted = deferred();
    const releaseClose = deferred();
    const open = workspaceFileOpen.openWorkspaceRegularCandidate;
    let opened = 0;
    let closed = 0;
    const startedAfterAbort: string[] = [];
    vi.spyOn(
      workspaceFileOpen,
      "openWorkspaceRegularCandidate",
    ).mockImplementation(async (path, mode) => {
      if (controller.signal.aborted) startedAfterAbort.push(path);
      const handle = await open(path, mode);
      opened += 1;
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        closeStarted.resolve();
        await releaseClose.promise;
        await close();
        closed += 1;
      });
      if (opened >= 2) started.resolve();
      await releaseOpen.promise;
      return handle;
    });
    let settled = false;
    const scanning = scanWorkspace(root, { signal: controller.signal }).then(
      (snapshot) => {
        settled = true;
        return { kind: "completed" as const, snapshot };
      },
      (cause: unknown) => {
        settled = true;
        return { kind: "failed" as const, cause };
      },
    );
    try {
      await started.promise;
      controller.abort();
      releaseOpen.resolve();
      await closeStarted.promise;
      expect(settled).toBe(false);
      releaseClose.resolve();
      const result = await scanning;
      expect(result.kind).toBe("failed");
      if (result.kind !== "failed") throw new Error("cancelled scan completed");
      expect(isOperationCancelled(result.cause, controller.signal)).toBe(true);
      expect(opened).toBeGreaterThan(1);
      expect(opened).toBeLessThanOrEqual(8);
      expect(closed).toBe(opened);
      expect(startedAfterAbort).toEqual([]);
    } finally {
      releaseOpen.resolve();
      releaseClose.resolve();
      await scanning;
    }
  });

  it("retains another active file's close failure when cancellation interrupts the batch", async () => {
    const root = await workspace(fileSet(24));
    const controller = new AbortController();
    const started = deferred();
    const release = deferred();
    const cleanupFailure = new Error("one concurrent file close failed");
    const open = workspaceFileOpen.openWorkspaceRegularCandidate;
    let opened = 0;
    let closed = 0;
    vi.spyOn(
      workspaceFileOpen,
      "openWorkspaceRegularCandidate",
    ).mockImplementation(async (path, mode) => {
      const handle = await open(path, mode);
      opened += 1;
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        await close();
        closed += 1;
        if (path.endsWith("file-001.txt")) throw cleanupFailure;
      });
      if (opened >= 2) started.resolve();
      await release.promise;
      return handle;
    });
    const scanning = scanWorkspace(root, { signal: controller.signal }).catch(
      (cause: unknown) => cause,
    );
    try {
      await started.promise;
      controller.abort();
      release.resolve();
      const cause = await scanning;
      expect(failuresIn(cause)).toContain(cleanupFailure);
      expect(isOperationCancelled(cause, controller.signal)).toBe(false);
      expect(closed).toBe(opened);
    } finally {
      release.resolve();
      await scanning;
    }
  });

  it("drains active files before rejecting a cumulative byte quota overflow", async () => {
    const root = await workspace(
      Object.fromEntries(
        Object.keys(fileSet(20)).map((name) => [name, "1234"]),
      ),
    );
    const firstClosed = deferred();
    const blockedOpened = deferred();
    const release = deferred();
    const open = workspaceFileOpen.openWorkspaceRegularCandidate;
    let opened = 0;
    let closed = 0;
    vi.spyOn(
      workspaceFileOpen,
      "openWorkspaceRegularCandidate",
    ).mockImplementation(async (path, mode) => {
      const handle = await open(path, mode);
      opened += 1;
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        await close();
        closed += 1;
        if (path.endsWith("file-000.txt")) firstClosed.resolve();
      });
      if (path.endsWith("file-001.txt")) {
        blockedOpened.resolve();
        await release.promise;
      }
      return handle;
    });
    let settled = false;
    const scanning = scanWorkspace(root, { maxSnapshotBytes: 9 }).then(
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
      await blockedOpened.promise;
      await firstClosed.promise;
      await immediate();
      expect(settled).toBe(false);
      release.resolve();
      expect(await scanning).toBeInstanceOf(ScanError);
      expect(closed).toBe(opened);
      expect(opened).toBeLessThanOrEqual(8);
    } finally {
      release.resolve();
      await scanning;
    }
  });

  it("enforces exact global byte and inventory quotas across completed batches", async () => {
    const files = Object.fromEntries(
      Object.keys(fileSet(24)).map((name) => [`nested/${name}`, "1234"]),
    );
    const root = await workspace(files);
    const snapshot = await scanWorkspace(root, {
      maxSnapshotBytes: 96,
      maxEntries: 26,
    });
    expect(snapshot.problems).toEqual([]);
    expect(snapshot.entries).toHaveLength(24);
    await expect(scanWorkspace(root, { maxSnapshotBytes: 95 })).rejects.toThrow(
      "95-byte limit",
    );
    await expect(scanWorkspace(root, { maxEntries: 25 })).rejects.toThrow(
      "25-entry limit",
    );
  });

  it("omits a file that changes while other files are being hashed", async () => {
    const root = await workspace(fileSet(24));
    const open = workspaceFileOpen.openWorkspaceRegularCandidate;
    const closed = new Set<string>();
    const opened = new Set<string>();
    vi.spyOn(
      workspaceFileOpen,
      "openWorkspaceRegularCandidate",
    ).mockImplementation(async (path, mode) => {
      const handle = await open(path, mode);
      opened.add(path);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        await close();
        closed.add(path);
      });
      if (path.endsWith("file-001.txt")) {
        const stat = handle.stat.bind(handle);
        vi.spyOn(handle, "stat").mockImplementationOnce(async () => {
          const before = await stat();
          await writeFile(path, "changed while scanning");
          return before;
        });
      }
      return handle;
    });
    const snapshot = await scanWorkspace(root);
    expect(snapshot.entries).toHaveLength(23);
    expect(snapshot.entries.map(({ path }) => path)).not.toContain(
      "file-001.txt",
    );
    expect(snapshot.problems).toEqual([
      {
        path: "file-001.txt",
        kind: "read-failed",
        detail: expect.stringContaining("changed while"),
      },
    ]);
    expect(closed).toEqual(opened);
  });

  it("keeps portable collision ownership in byte order when the first file finishes last", async (context) => {
    const root = await workspace({
      "I.txt": "first",
      "ı.txt": "alias",
      "z.txt": "other",
    });
    context.skip(
      (await readdir(root)).length < 3,
      "this filesystem aliases the collision spellings",
    );
    const laterClosed = deferred();
    const open = workspaceFileOpen.openWorkspaceRegularCandidate;
    vi.spyOn(
      workspaceFileOpen,
      "openWorkspaceRegularCandidate",
    ).mockImplementation(async (path, mode) => {
      const handle = await open(path, mode);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        await close();
        if (path.endsWith("z.txt")) laterClosed.resolve();
      });
      if (path.endsWith("I.txt")) await laterClosed.promise;
      return handle;
    });
    const snapshot = await scanWorkspace(root);
    expect(snapshot.entries.map(({ path }) => path)).toEqual([
      "I.txt",
      "z.txt",
    ]);
    expect(snapshot.problems).toEqual([
      {
        path: "ı.txt",
        kind: "path-collision",
        detail: expect.stringContaining("I.txt"),
      },
    ]);
  });

  it("does not reserve a colliding path for a file whose read failed", async (context) => {
    const root = await workspace({
      "I.txt": "unreadable",
      "ı.txt": "captured",
    });
    context.skip(
      (await readdir(root)).length < 2,
      "this filesystem aliases the collision spellings",
    );
    const open = workspaceFileOpen.openWorkspaceRegularCandidate;
    const readFailure = new Error("first candidate became unreadable");
    let closed = 0;
    vi.spyOn(
      workspaceFileOpen,
      "openWorkspaceRegularCandidate",
    ).mockImplementation(async (path, mode) => {
      const handle = await open(path, mode);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        await close();
        closed += 1;
      });
      if (path.endsWith("I.txt")) {
        vi.spyOn(handle, "stat").mockRejectedValueOnce(readFailure);
      }
      return handle;
    });
    const snapshot = await scanWorkspace(root);
    expect(snapshot.entries.map(({ path }) => path)).toEqual(["ı.txt"]);
    expect(snapshot.problems).toEqual([
      { path: "I.txt", kind: "read-failed", detail: readFailure.message },
    ]);
    expect(closed).toBe(2);
  });

  it("preserves UTF-8 ordering and hashes when concurrent files finish out of order", async () => {
    const names = ["a.txt", "z.txt", "中.txt", "\uE000.txt", "\u{10000}.txt"];
    const root = await workspace(
      Object.fromEntries(names.map((path) => [path, path])),
    );
    const releaseFirst = deferred();
    const open = workspaceFileOpen.openWorkspaceRegularCandidate;
    const completed: string[] = [];
    vi.spyOn(
      workspaceFileOpen,
      "openWorkspaceRegularCandidate",
    ).mockImplementation(async (path, mode) => {
      const handle = await open(path, mode);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        await close();
        completed.push(basename(path));
        if (path.endsWith("z.txt")) releaseFirst.resolve();
      });
      if (path.endsWith("a.txt")) await releaseFirst.promise;
      return handle;
    });
    const snapshot = await scanWorkspace(root);
    expect(completed.indexOf("z.txt")).toBeLessThan(completed.indexOf("a.txt"));
    const sorted = [...names].sort((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)),
    );
    expect(snapshot.entries.map(({ path }) => path)).toEqual(sorted);
    for (const entry of snapshot.entries) {
      expect(entry.kind).toBe("regular");
      if (entry.kind !== "regular") continue;
      expect(entry.sha256).toBe(
        createHash("sha256").update(entry.path).digest("hex"),
      );
    }
    expect(snapshot.problems).toEqual([]);
  });
});
