import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { afterEach, describe, expect, it } from "vitest";

import { openObjectStore } from "../src/infrastructure/object-store.ts";
import { publishSnapshot } from "../src/infrastructure/snapshot-publication.ts";
import { scanWorkspace } from "../src/infrastructure/workspace-scan.ts";

const LARGE_FILE_BYTES = 12 * 1024 * 1024;
const MANY_FILE_COUNT = 1_000;
const UNIQUE_FILE_COUNT = 100;
// This prevents a wedged filesystem operation from hanging the suite. Timing
// observations below are indicators only and are never pass/fail thresholds.
const INDICATOR_TEST_TIMEOUT_MS = 30_000;

const roots: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
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

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("scan and publication performance indicators", () => {
  it(
    "streams a 12 MiB file without embedding a base64 copy",
    async () => {
      const workspace = await tempRoot("cyclotomy-perf-large-ws-");
      const store = await openObjectStore(
        await tempRoot("cyclotomy-perf-large-store-"),
      );
      await writeFile(
        join(workspace, "large.bin"),
        Buffer.alloc(LARGE_FILE_BYTES, 0x41),
      );
      let started = performance.now();
      const snapshot = await scanWorkspace(workspace, {
        maxFileBytes: LARGE_FILE_BYTES,
      });
      const scanMs = performance.now() - started;
      started = performance.now();
      await publishSnapshot(store, snapshot);
      const publishMs = performance.now() - started;

      expect(snapshot.problems).toEqual([]);
      const entry = snapshot.entries[0];
      expect(entry).toMatchObject({
        kind: "regular",
        byteLength: LARGE_FILE_BYTES,
        sourcePath: join(await realpath(workspace), "large.bin"),
      });
      expect(entry).not.toHaveProperty("contentsBase64");
      reportIndicator("single-large-file", {
        bytes: LARGE_FILE_BYTES,
        scanMs,
        publishMs,
      });
    },
    INDICATOR_TEST_TIMEOUT_MS,
  );

  it(
    "reports first and repeated publication for 1,000 files",
    async () => {
      const workspace = await tempRoot("cyclotomy-perf-many-ws-");
      const store = await openObjectStore(
        await tempRoot("cyclotomy-perf-many-store-"),
      );
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

      let started = performance.now();
      const snapshot = await scanWorkspace(workspace);
      const scanMs = performance.now() - started;
      started = performance.now();
      const first = await publishSnapshot(store, snapshot);
      const firstPublishMs = performance.now() - started;
      await rm(workspace, { recursive: true, force: true });
      started = performance.now();
      const second = await publishSnapshot(store, snapshot);
      const repeatedPublishMs = performance.now() - started;

      expect(snapshot.problems).toEqual([]);
      expect(snapshot.entries).toHaveLength(MANY_FILE_COUNT);
      expect(second).toBe(first);
      reportIndicator("many-files-with-object-reuse", {
        files: MANY_FILE_COUNT,
        scanMs,
        firstPublishMs,
        repeatedPublishMs,
      });
    },
    INDICATOR_TEST_TIMEOUT_MS,
  );

  it(
    "reports first and repeated publication for 100 unique blobs",
    async () => {
      const workspace = await tempRoot("cyclotomy-perf-unique-ws-");
      const store = await openObjectStore(
        await tempRoot("cyclotomy-perf-unique-store-"),
      );
      await Promise.all(
        Array.from({ length: UNIQUE_FILE_COUNT }, (_, index) =>
          writeFile(
            join(workspace, `file-${index}.txt`),
            `unique-payload-${index}`,
          ),
        ),
      );

      let started = performance.now();
      const snapshot = await scanWorkspace(workspace);
      const scanMs = performance.now() - started;
      started = performance.now();
      const first = await publishSnapshot(store, snapshot);
      const firstPublishMs = performance.now() - started;
      await rm(workspace, { recursive: true, force: true });
      started = performance.now();
      const second = await publishSnapshot(store, snapshot);
      const repeatedPublishMs = performance.now() - started;

      expect(snapshot.problems).toEqual([]);
      expect(snapshot.entries).toHaveLength(UNIQUE_FILE_COUNT);
      expect(second).toBe(first);
      reportIndicator("unique-blobs", {
        files: UNIQUE_FILE_COUNT,
        scanMs,
        firstPublishMs,
        repeatedPublishMs,
      });
    },
    INDICATOR_TEST_TIMEOUT_MS,
  );
});
