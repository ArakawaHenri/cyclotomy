import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  prepareNodeState,
  prepareObservedNodeState,
  type CaptureDeps,
  type CaptureProgress,
} from "../src/application/capture.ts";
import {
  openObjectStore,
  type ObjectStore,
  type SnapshotPublication,
} from "../src/infrastructure/object-store.ts";
import * as workspaceFileOpen from "../src/infrastructure/workspace-file-open.ts";
import { scanWorkspace } from "../src/infrastructure/workspace-scan.ts";

const roots: string[] = [];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return await realpath(root);
}

async function workspaceFixture(files: number) {
  const workspace = await tempRoot("cyclotomy-capture-cancel-ws-");
  const store = await openObjectStore(
    await tempRoot("cyclotomy-capture-cancel-store-"),
  );
  const contents = Array.from(
    { length: files },
    (_, index) => `content-${index}\n`,
  );
  await Promise.all(
    contents.map((content, index) =>
      writeFile(
        join(workspace, `file-${String(index).padStart(3, "0")}.txt`),
        content,
      ),
    ),
  );
  const deps: CaptureDeps = { store, expectedRootPath: workspace };
  return {
    workspace,
    deps,
    bytes: contents.reduce((sum, text) => sum + Buffer.byteLength(text), 0),
  };
}

function publicationStore(
  storageRoot: string,
  publication: SnapshotPublication,
): ObjectStore {
  const unusedRead = async (): Promise<never> => {
    throw new Error("capture preparation unexpectedly read published history");
  };
  return {
    storageRoot,
    beginSnapshotPublication: () => publication,
    readBlob: unusedRead,
    streamBlob: unusedRead,
    readTree: unusedRead,
    readTreeManifest: unusedRead,
    verifyBlobs: unusedRead,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("capture cancellation and progress", () => {
  it("does not begin publication for an already cancelled capture or observation", async () => {
    const { workspace, deps } = await workspaceFixture(2);
    const snapshot = await scanWorkspace(workspace);
    const begin = vi.spyOn(deps.store, "beginSnapshotPublication");
    const onProgress = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const options = { signal: controller.signal, onProgress };

    expect(await prepareNodeState(deps, workspace, options)).toEqual({
      ok: false,
      error: { kind: "cancelled" },
    });
    expect(await prepareObservedNodeState(deps, snapshot, options)).toEqual({
      ok: false,
      error: { kind: "cancelled" },
    });
    expect(begin).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("stops scanning new files after cancellation and closes every opened file", async () => {
    const fileCount = 40;
    const { workspace, deps } = await workspaceFixture(fileCount);
    const controller = new AbortController();
    const begin = vi.spyOn(deps.store, "beginSnapshotPublication");
    const originalOpen = workspaceFileOpen.openWorkspaceRegularCandidate;
    const startedAfterCancellation: string[] = [];
    let opened = 0;
    let closed = 0;
    vi.spyOn(
      workspaceFileOpen,
      "openWorkspaceRegularCandidate",
    ).mockImplementation(async (path, mode) => {
      if (controller.signal.aborted) startedAfterCancellation.push(path);
      const handle = await originalOpen(path, mode);
      opened += 1;
      const originalClose = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        await originalClose();
        closed += 1;
      });
      return handle;
    });

    const result = await prepareNodeState(deps, workspace, {
      signal: controller.signal,
      onProgress: (progress) => {
        if (progress.phase === "scan" && progress.files > 0) controller.abort();
      },
    });

    expect(result).toEqual({ ok: false, error: { kind: "cancelled" } });
    expect(opened).toBeGreaterThan(0);
    expect(opened).toBeLessThan(fileCount);
    expect(closed).toBe(opened);
    expect(startedAfterCancellation).toEqual([]);
    expect(begin).not.toHaveBeenCalled();
  });

  it("settles active publications and cleanup before returning cancellation", async () => {
    const { workspace, deps } = await workspaceFixture(40);
    const snapshot = await scanWorkspace(workspace);
    const controller = new AbortController();
    const cancellationRequested = deferred();
    const finishWrites = deferred();
    const cleanupStarted = deferred();
    const finishCleanup = deferred();
    const started: string[] = [];
    const finished: string[] = [];
    const startedAfterCancellation: string[] = [];
    const publishTree = vi.fn(async () => "ab".repeat(32));
    const close = vi.fn(async () => {
      cleanupStarted.resolve();
      await finishCleanup.promise;
    });
    const store = publicationStore(deps.store.storageRoot, {
      publishBlobFromFile: async (path, oid) => {
        if (controller.signal.aborted) startedAfterCancellation.push(path);
        started.push(path);
        if (started.length === 2) {
          controller.abort();
          cancellationRequested.resolve();
        }
        await finishWrites.promise;
        finished.push(path);
        return oid;
      },
      publishTree,
      close,
    });
    let returned = false;
    const capture = prepareObservedNodeState({ ...deps, store }, snapshot, {
      signal: controller.signal,
    }).then((result) => {
      returned = true;
      return result;
    });

    try {
      await cancellationRequested.promise;
      expect(returned).toBe(false);
      expect(close).not.toHaveBeenCalled();
      finishWrites.resolve();
      await cleanupStarted.promise;
      expect(finished).toHaveLength(started.length);
      expect(returned).toBe(false);
      expect(startedAfterCancellation).toEqual([]);
      expect(publishTree).not.toHaveBeenCalled();
      finishCleanup.resolve();
      expect(await capture).toEqual({
        ok: false,
        error: { kind: "cancelled" },
      });
      expect(close).toHaveBeenCalledOnce();
    } finally {
      finishWrites.resolve();
      finishCleanup.resolve();
      await capture;
    }
  });

  it("retains a file close failure when scanning is cancelled with a handle open", async () => {
    const { workspace, deps } = await workspaceFixture(1);
    const controller = new AbortController();
    const cleanupFailure = new Error("workspace file close failed");
    const originalOpen = workspaceFileOpen.openWorkspaceRegularCandidate;
    vi.spyOn(
      workspaceFileOpen,
      "openWorkspaceRegularCandidate",
    ).mockImplementation(async (path, mode) => {
      const handle = await originalOpen(path, mode);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        await close();
        throw cleanupFailure;
      });
      controller.abort();
      return handle;
    });

    const result = await prepareNodeState(deps, workspace, {
      signal: controller.signal,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "scan-failed", phase: "capture" },
    });
    if (result.ok || result.error.kind !== "scan-failed")
      throw new Error("expected scan failure");
    const cause = result.error.cause;
    expect(cause).toMatchObject({ cause: expect.any(AggregateError) });
    expect(((cause as Error).cause as AggregateError).errors).toContain(
      cleanupFailure,
    );
  });

  it("retains another publication lane's cleanup failure alongside cancellation", async () => {
    const { workspace, deps } = await workspaceFixture(2);
    const snapshot = await scanWorkspace(workspace);
    const controller = new AbortController();
    const secondStarted = deferred();
    const cleanupFailure = new Error("second publication file close failed");
    let laneFailure: AggregateError | undefined;
    const publishTree = vi.fn(async () => "ab".repeat(32));
    const close = vi.fn(async () => undefined);
    const store = publicationStore(deps.store.storageRoot, {
      publishBlobFromFile: async (path) => {
        if (path.endsWith("file-000.txt")) {
          await secondStarted.promise;
          throw controller.signal.reason;
        }
        controller.abort();
        laneFailure = new AggregateError([
          controller.signal.reason,
          cleanupFailure,
        ]);
        secondStarted.resolve();
        throw laneFailure;
      },
      publishTree,
      close,
    });

    const result = await prepareObservedNodeState(
      { ...deps, store },
      snapshot,
      { signal: controller.signal },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "publish-failed" },
    });
    if (result.ok || result.error.kind !== "publish-failed")
      throw new Error("expected publication failure");
    expect(result.error.cause).toBe(laneFailure);
    expect(laneFailure?.errors).toContain(cleanupFailure);
    expect(publishTree).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("reports a publication cleanup failure even when cancellation was requested", async () => {
    const { workspace, deps } = await workspaceFixture(2);
    const snapshot = await scanWorkspace(workspace);
    const controller = new AbortController();
    const cleanupFailure = new Error("publication cleanup failed");
    const publishTree = vi.fn(async () => "ab".repeat(32));
    const store = publicationStore(deps.store.storageRoot, {
      publishBlobFromFile: async () => {
        controller.abort();
        throw controller.signal.reason;
      },
      publishTree,
      close: async () => {
        throw cleanupFailure;
      },
    });

    const result = await prepareObservedNodeState(
      { ...deps, store },
      snapshot,
      {
        signal: controller.signal,
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "publish-failed" },
    });
    expect(publishTree).not.toHaveBeenCalled();
  });

  it("does not return a prepared capture when validation is cancelled", async () => {
    const { workspace, deps } = await workspaceFixture(4);
    const controller = new AbortController();
    const phases: CaptureProgress["phase"][] = [];
    const result = await prepareNodeState(deps, workspace, {
      signal: controller.signal,
      onProgress: (progress) => {
        phases.push(progress.phase);
        if (progress.phase === "validate" && progress.files > 0)
          controller.abort();
      },
    });

    expect(result).toEqual({ ok: false, error: { kind: "cancelled" } });
    expect(phases).toContain("publish");
    expect(phases).toContain("validate");
  });

  it("reports monotonic file and byte progress through all capture phases", async () => {
    const files = 4;
    const { workspace, deps, bytes } = await workspaceFixture(files);
    const progress: CaptureProgress[] = [];
    const result = await prepareNodeState(deps, workspace, {
      onProgress: (value) => progress.push(value),
    });

    expect(result.ok).toBe(true);
    expect([...new Set(progress.map((value) => value.phase))]).toEqual([
      "scan",
      "publish",
      "validate",
    ]);
    for (const phase of ["scan", "publish", "validate"] as const) {
      const observations = progress.filter((value) => value.phase === phase);
      expect(observations.at(-1)).toEqual({ phase, files, bytes });
      for (let index = 1; index < observations.length; index += 1) {
        expect(observations[index]!.files).toBeGreaterThanOrEqual(
          observations[index - 1]!.files,
        );
        expect(observations[index]!.bytes).toBeGreaterThanOrEqual(
          observations[index - 1]!.bytes,
        );
      }
    }
  });
});
