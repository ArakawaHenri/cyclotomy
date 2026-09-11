import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setTimeout } from "node:timers/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { chunkFastCdcV1 } from "../src/infrastructure/content-store/fastcdc.ts";
import { contentIdFromBytes } from "../src/infrastructure/content-store/ids.ts";
import { PackCatalog } from "../src/infrastructure/content-store/pack-catalog.ts";
import { encodePack } from "../src/infrastructure/content-store/pack.ts";
import { encodePayload } from "../src/infrastructure/content-store/representation.ts";
import { openObjectStore } from "../src/infrastructure/object-store.ts";
import { publishSnapshot } from "../src/infrastructure/snapshot-publication.ts";
import { withWorkspaceLock } from "../src/infrastructure/workspace-lock.ts";
import {
  scanWorkspace,
  workspaceEntryAsTreeEntry,
} from "../src/infrastructure/workspace-scan.ts";
import { nativeObjectLayout } from "../src/infrastructure/workspace-store.ts";

const LARGE_FILE_BYTES = 12 * 1024 * 1024;
const MANY_FILE_COUNT = 1_000;
const UNIQUE_FILE_COUNT = 1_000;
const UNIQUE_FILE_BYTES = 2 * 1024;
const HISTORY_PACK_COUNT = 16;
const HISTORY_RECORDS_PER_PACK = 32;
const NEW_FILES_WITH_HISTORY = 100;
const FASTCDC_BENCHMARK_BYTES = 32 * 1024 * 1024;
// This prevents a wedged filesystem operation from hanging the suite. Timing
// observations below are indicators only and are never pass/fail thresholds.
const INDICATOR_TEST_TIMEOUT_MS = 30_000;

const roots: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function openTempStore(prefix: string) {
  const store = await openObjectStore(await tempRoot(prefix));

  return store;
}

function reportIndicator(
  scenario: string,
  measurements: Readonly<Record<string, number>>,
): void {
  console.info(
    `[cyclotomy:performance] ${JSON.stringify({
      scenario,
      ...Object.fromEntries(
        Object.entries(measurements).map(([name, value]) => [
          name,
          Math.round(value * 10) / 10,
        ]),
      ),
    })}`,
  );
}

async function measureOperation<T>(
  scenario: string,
  operation: () => Promise<T>,
  measurements: Readonly<Record<string, number>> = {},
): Promise<T> {
  const probe = await open(
    join(await tempRoot("cyclotomy-perf-probe-"), "probe"),
    "w",
  );
  const prototype = Object.getPrototypeOf(probe) as {
    sync: FileHandle["sync"];
  };
  await probe.close();
  const originalSync = prototype.sync;
  let syncCalls = 0;
  let syncMs = 0;
  const sync = vi.spyOn(prototype, "sync").mockImplementation(async function (
    this: FileHandle,
  ) {
    syncCalls += 1;
    const started = performance.now();
    try {
      await originalSync.call(this);
    } finally {
      syncMs += performance.now() - started;
    }
  });
  const delay = monitorEventLoopDelay({ resolution: 5 });
  delay.enable();
  await setTimeout(10);
  delay.reset();
  const started = performance.now();
  const cpuStarted = process.cpuUsage();
  try {
    const value = await operation();
    const elapsedMs = performance.now() - started;
    const cpu = process.cpuUsage(cpuStarted);
    await setTimeout(10);
    reportIndicator(scenario, {
      ...measurements,
      elapsedMs,
      cpuMs: (cpu.user + cpu.system) / 1_000,
      eventLoopP99Ms: delay.percentile(99) / 1_000_000,
      eventLoopMaxMs: delay.max / 1_000_000,
      syncCalls,
      // Concurrent sync calls overlap, so their total can exceed elapsedMs.
      syncMs,
    });
    return value;
  } finally {
    delay.disable();
    sync.mockRestore();
  }
}

function uniqueContent(index: number): Buffer {
  return Buffer.from(
    `export function value${index}() { return "workspace-content-${index}"; }\n`
      .repeat(40)
      .slice(0, UNIQUE_FILE_BYTES),
  );
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("scan and publication performance indicators", () => {
  it(
    "publishes and reuses a 12 MiB file with repeated chunks",
    async () => {
      const workspace = await tempRoot("cyclotomy-perf-large-ws-");
      const store = await openTempStore("cyclotomy-perf-large-store-");
      await writeFile(
        join(workspace, "large.bin"),
        Buffer.alloc(LARGE_FILE_BYTES, 0x41),
      );
      const snapshot = await measureOperation(
        "repeated-chunks/scan",
        () => scanWorkspace(workspace, { maxFileBytes: LARGE_FILE_BYTES }),
        { bytes: LARGE_FILE_BYTES },
      );
      const first = await measureOperation(
        "repeated-chunks/first-publication",
        () => publishSnapshot(store, snapshot),
      );

      expect(snapshot.problems).toEqual([]);
      const entry = snapshot.entries[0];
      expect(entry).toMatchObject({
        kind: "regular",
        byteLength: LARGE_FILE_BYTES,
        sourcePath: join(await realpath(workspace), "large.bin"),
      });
      expect(entry).not.toHaveProperty("contentsBase64");
      if (entry?.kind !== "regular") throw new Error("expected a regular file");
      await rm(workspace, { recursive: true, force: true });
      const second = await measureOperation(
        "repeated-chunks/repeated-publication",
        () => publishSnapshot(store, snapshot),
      );
      expect(second).toBe(first);

      const reopened = await openObjectStore(store.storageRoot);
      const digest = createHash("sha256");
      const observed = await reopened.streamBlob(
        entry.sha256,
        async (chunk) => {
          digest.update(chunk);
        },
      );
      expect(observed.decodedLength).toBe(LARGE_FILE_BYTES);
      expect(digest.digest("hex")).toBe(entry.sha256);
    },
    INDICATOR_TEST_TIMEOUT_MS,
  );

  it(
    "reports first and repeated publication for 1,000 files",
    async () => {
      const workspace = await tempRoot("cyclotomy-perf-many-ws-");
      const store = await openTempStore("cyclotomy-perf-many-store-");
      for (let group = 0; group < MANY_FILE_COUNT / 50; group += 1) {
        const directory = join(workspace, `group-${group}`);
        await mkdir(directory);
        await Promise.all(
          Array.from({ length: 50 }, (_, offset) => {
            const index = group * 50 + offset;
            return writeFile(
              join(directory, `file-${index}.txt`),
              `shared-payload-${index % 10}`,
            );
          }),
        );
      }

      const snapshot = await measureOperation(
        "many-files-with-object-reuse/scan",
        () => scanWorkspace(workspace),
        { files: MANY_FILE_COUNT, distinctContents: 10 },
      );
      const first = await measureOperation(
        "many-files-with-object-reuse/first-publication",
        () => publishSnapshot(store, snapshot),
      );
      await rm(workspace, { recursive: true, force: true });
      const second = await measureOperation(
        "many-files-with-object-reuse/repeated-publication",
        () => publishSnapshot(store, snapshot),
      );

      expect(snapshot.problems).toEqual([]);
      expect(snapshot.entries).toHaveLength(MANY_FILE_COUNT);
      expect(second).toBe(first);
    },
    INDICATOR_TEST_TIMEOUT_MS,
  );

  it(
    "publishes and reopens 1,000 unique compressed small files",
    async () => {
      const workspace = await tempRoot("cyclotomy-perf-unique-ws-");
      const store = await openTempStore("cyclotomy-perf-unique-store-");
      for (let group = 0; group < UNIQUE_FILE_COUNT / 50; group += 1) {
        const directory = join(workspace, `group-${group}`, "src", "nested");
        await mkdir(directory, { recursive: true });
        await Promise.all(
          Array.from({ length: 50 }, (_, offset) => {
            const index = group * 50 + offset;
            return writeFile(
              join(directory, `file-${index}.ts`),
              uniqueContent(index),
            );
          }),
        );
      }

      const snapshot = await measureOperation(
        "unique-small-files/scan",
        () => scanWorkspace(workspace),
        { files: UNIQUE_FILE_COUNT, bytesPerFile: UNIQUE_FILE_BYTES },
      );
      const first = await measureOperation(
        "unique-small-files/first-publication",
        () => publishSnapshot(store, snapshot),
      );
      await rm(workspace, { recursive: true, force: true });
      const second = await measureOperation(
        "unique-small-files/repeated-publication",
        () => publishSnapshot(store, snapshot),
      );

      expect(snapshot.problems).toEqual([]);
      expect(snapshot.entries).toHaveLength(UNIQUE_FILE_COUNT);
      expect(second).toBe(first);
      const reopened = await openObjectStore(store.storageRoot);
      const manifest = await reopened.readTree(first);
      expect(manifest.entries).toEqual(
        snapshot.entries.map(workspaceEntryAsTreeEntry),
      );
    },
    INDICATOR_TEST_TIMEOUT_MS,
  );

  it(
    "publishes new files alongside content held only in historical packs",
    async () => {
      const workspace = await tempRoot("cyclotomy-perf-history-ws-");
      const store = await openTempStore("cyclotomy-perf-history-store-");
      const catalog = new PackCatalog(nativeObjectLayout(store.storageRoot));
      const reusedPaths: string[] = [];
      await withWorkspaceLock(
        store.storageRoot,
        "performance fixture",
        async (authority) => {
          for (
            let packIndex = 0;
            packIndex < HISTORY_PACK_COUNT;
            packIndex += 1
          ) {
            const records = await Promise.all(
              Array.from(
                { length: HISTORY_RECORDS_PER_PACK },
                async (_, recordIndex) => {
                  const bytes = uniqueContent(
                    10_000 + packIndex * HISTORY_RECORDS_PER_PACK + recordIndex,
                  );
                  if (recordIndex === 0) {
                    const path = join(workspace, `historical-${packIndex}.ts`);
                    await writeFile(path, bytes);
                    reusedPaths.push(path);
                  }
                  return {
                    kind: "content" as const,
                    logicalId: contentIdFromBytes(bytes),
                    ...(await encodePayload(bytes)),
                  };
                },
              ),
            );
            await catalog.publishPack(
              await encodePack({ packClass: "data", records }),
              authority,
            );
          }
        },
      );
      await Promise.all(
        Array.from({ length: NEW_FILES_WITH_HISTORY }, (_, index) =>
          writeFile(join(workspace, `new-${index}.ts`), uniqueContent(index)),
        ),
      );
      const snapshot = await measureOperation(
        "historical-packs/scan",
        () => scanWorkspace(workspace),
        {
          packs: HISTORY_PACK_COUNT,
          historicalContents: HISTORY_PACK_COUNT * HISTORY_RECORDS_PER_PACK,
          newFiles: NEW_FILES_WITH_HISTORY,
          reusedFiles: reusedPaths.length,
        },
      );
      expect(snapshot.problems).toEqual([]);
      // Removing these sources makes successful publication depend on pack reuse.
      await Promise.all(reusedPaths.map((path) => rm(path)));
      const first = await measureOperation(
        "historical-packs/first-publication",
        () => publishSnapshot(store, snapshot),
      );
      await rm(workspace, { recursive: true, force: true });
      const second = await measureOperation(
        "historical-packs/repeated-publication",
        () => publishSnapshot(store, snapshot),
      );
      expect(second).toBe(first);
      const reopened = await openObjectStore(store.storageRoot);
      const manifest = await reopened.readTree(first);
      expect(manifest.entries).toEqual(
        snapshot.entries.map(workspaceEntryAsTreeEntry),
      );
    },
    INDICATOR_TEST_TIMEOUT_MS,
  );

  it(
    "reports fixed-profile FastCDC throughput",
    () => {
      const input = Buffer.allocUnsafe(FASTCDC_BENCHMARK_BYTES);
      let state = 0x1234_5678;
      for (let index = 0; index < input.byteLength; index += 1) {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        input[index] = state >>> 24;
      }

      // Warm the optimizing compiler before measuring the fixed profile.
      chunkFastCdcV1(input);
      const started = performance.now();
      const chunks = chunkFastCdcV1(input);
      const elapsedMs = performance.now() - started;
      const throughputMiBPerSecond =
        FASTCDC_BENCHMARK_BYTES / (1024 * 1024) / (elapsedMs / 1_000);

      expect(chunks.length).toBeGreaterThan(0);
      reportIndicator("fastcdc-v1", {
        bytes: FASTCDC_BENCHMARK_BYTES,
        elapsedMs,
        throughputMiBPerSecond,
      });
    },
    INDICATOR_TEST_TIMEOUT_MS,
  );
});
