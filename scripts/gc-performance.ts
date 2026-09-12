import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import assert from "node:assert/strict";

import { contentIdFromBytes } from "../src/infrastructure/content-store/ids.ts";
import {
  collectGarbage,
  type GarbageCollectionOptions,
  type GcReport,
} from "../src/infrastructure/object-gc.ts";
import {
  nativeObjectStoreLayout,
  openObjectStore,
  type NativeObjectStore,
} from "../src/infrastructure/object-store.ts";
import type { CurrentMetadataStore } from "../src/infrastructure/metadata.ts";
import type { TreeEntry } from "../src/infrastructure/tree-formats/manifest-codec.ts";
import { withWorkspaceLock } from "../src/infrastructure/workspace-lock.ts";
const ALL_MANAGED_SCOPE = { kind: "all-managed" } as const;

/**
 * GC scale indicators for the budgets in docs/performance-contract.md
 * §3-§4: G10-vs-G1 peak-RSS delta (<= 128 MiB), full-GC duration ratio
 * (<= 15), and extra file descriptors
 * (<= 64).
 *
 * These runs are indicators and trends only. The contract reserves acceptance
 * for the fixed R1 reference machine and its dataset: 1,000 / 10,000 roots,
 * 1,000 files per tree, each new root changing 16 bytes in one file, plus
 * unreferenced data at the same physical-object proportion. Reproduce that
 * shape on R1 with:
 *
 *   CYCLOTOMY_GC_BENCH_ROOTS=1000 CYCLOTOMY_GC_BENCH_FILES=1000 \
 *     npm run test:performance:gc
 *
 * A performance claim must attach the raw reference-machine output.
 * `CYCLOTOMY_GC_BENCH_ROOTS` fixes the G1 root count; G10 always uses ten
 * times that count with the identical per-tree shape, so the ratios stay
 * meaningful. Defaults keep a laptop run quick (under a minute) while
 * exercising the same code paths.
 */
const G1_ROOTS = positiveIntegerEnv("CYCLOTOMY_GC_BENCH_ROOTS", 32);
const G10_ROOTS = G1_ROOTS * 10;
const FILES_PER_TREE = positiveIntegerEnv("CYCLOTOMY_GC_BENCH_FILES", 64);
const BLOB_BYTES = 1024;
const CHANGED_BYTES = 16;
const PUBLICATION_CONCURRENCY = 32;
const RSS_SAMPLE_INTERVAL_MS = 20;
const OPERATION = "GC performance benchmark";

type RegularTreeEntry = Extract<TreeEntry, { readonly type: "regular" }>;

interface GcBenchmarkFixture {
  readonly storeRoot: string;
  readonly store: NativeObjectStore;
  readonly rootOids: string[];
  readonly deadObjectCount: number;
  readonly deadSamplePaths: readonly string[];
}

const roots: string[] = [];

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, received ${raw}`);
  }
  return parsed;
}

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

type IndicatorValue = number | string | boolean | null;

function reportIndicator(
  scenario: string,
  values: Readonly<Record<string, IndicatorValue>>,
): void {
  const rounded: Record<string, IndicatorValue> = {};
  for (const [name, value] of Object.entries(values)) {
    rounded[name] =
      typeof value === "number" && Number.isFinite(value)
        ? Math.round(value * 10) / 10
        : value;
  }
  console.info(
    `[cyclotomy:performance] ${JSON.stringify({ scenario, ...rounded })}`,
  );
}

async function forEachConcurrent<T>(
  items: readonly T[],
  limit: number,
  action: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, Math.max(items.length, 1)) },
    async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        await action(items[index]!);
      }
    },
  );
  await Promise.all(workers);
}

function deterministicBlobBytes(label: string): Buffer {
  const bytes = Buffer.allocUnsafe(BLOB_BYTES);
  let state = createHash("sha256").update(label).digest().readUInt32BE(0);
  if (state === 0) state = 0x9e37_79b9;
  for (let index = 0; index < BLOB_BYTES; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

function treeEntryPath(fileIndex: number): string {
  return `file-${String(fileIndex).padStart(6, "0")}.bin`;
}

/**
 * Build the §3 G-scale shape through the real snapshot-publication path: every
 * distinct 1 KiB blob is materialized on disk once, then each root publishes
 * its tree in its own publication (a publication authenticates its own blob
 * proofs and accepts exactly one tree). Already-published blobs are
 * authenticated and reused without reopening their source, so only the root's
 * single 16-byte variant is read from disk; `publishTestTree` would instead
 * rewrite every referenced file from disk for every root.
 */
async function buildGcBenchmarkFixture(
  rootCount: number,
  filesPerTree: number,
): Promise<GcBenchmarkFixture> {
  const parent = await tempRoot("cyclotomy-gc-bench-");
  const store = await openObjectStore(join(parent, "store"));

  const sourcesRoot = join(parent, "sources");
  await mkdir(sourcesRoot, { recursive: true });

  const baseBlobs: Buffer[] = [];
  const baseOids: string[] = [];
  for (let fileIndex = 0; fileIndex < filesPerTree; fileIndex += 1) {
    const bytes = deterministicBlobBytes(`base-${fileIndex}`);
    baseBlobs.push(bytes);
    baseOids.push(contentIdFromBytes(bytes));
  }

  // Root 0 references the base generation; every later root changes the first
  // file's 16 bytes, so consecutive trees differ in exactly one blob.
  const firstBase = baseBlobs[0]!;
  const variants: Buffer[] = [firstBase];
  const variantOids: string[] = [baseOids[0]!];
  for (let rootIndex = 1; rootIndex < rootCount; rootIndex += 1) {
    const variant = Buffer.from(firstBase);
    variant.writeBigUInt64BE(BigInt(rootIndex), 0);
    variant.writeBigUInt64BE(BigInt(rootIndex), CHANGED_BYTES / 2);
    if (variant.equals(firstBase)) {
      variant[CHANGED_BYTES - 1] = variant.readUInt8(CHANGED_BYTES - 1) ^ 0xff;
    }
    variants.push(variant);
    variantOids.push(contentIdFromBytes(variant));
  }

  const distinctBlobs = new Map<string, Buffer>();
  for (let fileIndex = 0; fileIndex < filesPerTree; fileIndex += 1) {
    distinctBlobs.set(baseOids[fileIndex]!, baseBlobs[fileIndex]!);
  }
  for (let rootIndex = 1; rootIndex < rootCount; rootIndex += 1) {
    const oid = variantOids[rootIndex]!;
    if (!distinctBlobs.has(oid)) distinctBlobs.set(oid, variants[rootIndex]!);
  }

  const sourcePathByOid = new Map<string, string>();
  await forEachConcurrent(
    [...distinctBlobs],
    PUBLICATION_CONCURRENCY,
    async ([oid, bytes]) => {
      const sourcePath = join(sourcesRoot, `${oid}.blob`);
      await writeFile(sourcePath, bytes);
      sourcePathByOid.set(oid, sourcePath);
    },
  );

  const rootOids: string[] = [];
  for (let rootIndex = 0; rootIndex < rootCount; rootIndex += 1) {
    const entries: RegularTreeEntry[] = [];
    for (let fileIndex = 0; fileIndex < filesPerTree; fileIndex += 1) {
      entries.push({
        path: treeEntryPath(fileIndex),
        type: "regular",
        blobOid:
          fileIndex === 0 ? variantOids[rootIndex]! : baseOids[fileIndex]!,
        recreationMode: 0o644,
      });
    }
    const publication = store.beginSnapshotPublication();
    try {
      await forEachConcurrent(
        entries,
        PUBLICATION_CONCURRENCY,
        async (entry) => {
          await publication.publishBlobFromFile(
            sourcePathByOid.get(entry.blobOid)!,
            entry.blobOid,
            BLOB_BYTES,
          );
        },
      );
      rootOids.push(await publication.publishTree(entries, ALL_MANAGED_SCOPE));
    } finally {
      await publication.close();
    }
  }

  // Unreferenced loose blobs at the same 1:1 physical-object proportion as the
  // distinct live blobs, expired so a zero-grace pass can remove them.
  const deadObjectCount = distinctBlobs.size;
  const blobsRoot = join(store.storageRoot, "objects", "blobs");
  const deadPaths: string[] = [];
  const deadShards = new Set<string>();
  for (let index = 0; index < deadObjectCount; index += 1) {
    const oid = createHash("sha256")
      .update(`cyclotomy-gc-bench-dead-${index}`)
      .digest("hex");
    const shard = oid.slice(0, 2);
    deadShards.add(shard);
    deadPaths.push(join(blobsRoot, shard, oid.slice(2)));
  }
  for (const shard of deadShards) {
    await mkdir(join(blobsRoot, shard), { recursive: true });
  }
  const deadBytes = Buffer.alloc(BLOB_BYTES, 0x5a);
  const expiredAt = new Date(Date.now() - 60_000);
  await forEachConcurrent(deadPaths, 64, async (path) => {
    await writeFile(path, deadBytes);
    await utimes(path, expiredAt, expiredAt);
  });

  return {
    storeRoot: store.storageRoot,
    store,
    rootOids,
    deadObjectCount,
    deadSamplePaths: deadPaths.slice(0, 3),
  };
}

function fdProbeDirectory(): string | null {
  if (process.platform === "darwin") return "/dev/fd";
  if (process.platform === "linux") return "/proc/self/fd";
  return null;
}

function openFileDescriptorCount(): number | null {
  const directory = fdProbeDirectory();
  if (directory === null) return null;
  try {
    return readdirSync(directory).length;
  } catch {
    return null;
  }
}

interface MeasuredPass {
  readonly report: GcReport;
  readonly durationMs: number;
  readonly peakRssDeltaBytes: number;
  readonly rssDeltaBytes: number;
  readonly exposedGc: boolean;
  readonly rssDeltaMeasurement: "explicit-gc" | "sampled";
  readonly peakExtraFds: number | null;
  readonly fdsAfterDelta: number | null;
}

function withCollectionLock(
  store: NativeObjectStore,
  metadata: Pick<CurrentMetadataStore, "listReferencedTreeOids">,
  options: GarbageCollectionOptions,
): Promise<GcReport> {
  const root = nativeObjectStoreLayout(store, OPERATION).root;
  return withWorkspaceLock(root, OPERATION, (authority) =>
    collectGarbage(authority, store, metadata, options),
  );
}

async function runMeasuredPass(
  store: NativeObjectStore,
  metadata: Pick<CurrentMetadataStore, "listReferencedTreeOids">,
  options: GarbageCollectionOptions,
): Promise<MeasuredPass> {
  const collect = globalThis.gc;
  const exposedGc = collect !== undefined;
  if (collect !== undefined) {
    collect();
    await delay(30);
  }
  const baselineRss = process.memoryUsage().rss;
  const baselineFds = openFileDescriptorCount();
  let peakRss = baselineRss;
  let peakFds = baselineFds;
  const sample = (): void => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    const currentFds = openFileDescriptorCount();
    if (currentFds !== null) {
      peakFds = peakFds === null ? currentFds : Math.max(peakFds, currentFds);
    }
  };
  const sampler = setInterval(sample, RSS_SAMPLE_INTERVAL_MS);
  sampler.unref();
  const startedAt = performance.now();
  let report: GcReport;
  try {
    report = await withCollectionLock(store, metadata, {
      ...options,
      onProgress: () => sample(),
    });
  } finally {
    clearInterval(sampler);
    sample();
  }
  const durationMs = performance.now() - startedAt;
  if (collect !== undefined) {
    collect();
    await delay(25);
  }
  const finalRss = process.memoryUsage().rss;
  const finalFds = openFileDescriptorCount();
  return {
    report,
    durationMs,
    peakRssDeltaBytes: Math.round(peakRss - baselineRss),
    rssDeltaBytes: Math.round(finalRss - baselineRss),
    exposedGc,
    rssDeltaMeasurement: exposedGc ? "explicit-gc" : "sampled",
    peakExtraFds:
      peakFds === null || baselineFds === null ? null : peakFds - baselineFds,
    fdsAfterDelta:
      finalFds === null || baselineFds === null ? null : finalFds - baselineFds,
  };
}

interface ScaleMeasurement {
  readonly peakRssDeltaBytes: number;
  readonly durationMs: number;
}

async function measureScaleScenario(
  scenario: string,
  rootCount: number,
  filesPerTree: number,
): Promise<ScaleMeasurement> {
  const fixture = await buildGcBenchmarkFixture(rootCount, filesPerTree);
  const metadata = { listReferencedTreeOids: () => fixture.rootOids };
  // A duplicate would silently shrink the dataset that the ratio compares.
  assert.equal(fixture.rootOids.length, rootCount);
  assert.equal(new Set(fixture.rootOids).size, rootCount);
  const pass = await runMeasuredPass(fixture.store, metadata, {
    graceMs: 0,
    now: Date.now(),
  });

  reportIndicator(scenario, {
    roots: rootCount,
    filesPerTree,
    liveEntries: rootCount * filesPerTree,
    deadObjects: fixture.deadObjectCount,
    durationMs: pass.durationMs,
    peakRssDeltaBytes: pass.peakRssDeltaBytes,
    rssDeltaBytes: pass.rssDeltaBytes,
    exposedGc: pass.exposedGc,
    rssDeltaMeasurement: pass.rssDeltaMeasurement,
    peakExtraFds: pass.peakExtraFds,
    fdsAfterDelta: pass.fdsAfterDelta,
    fdProbe: fdProbeDirectory() ?? "unsupported-platform",
    stopped: pass.report.stopped ?? null,
    removedBlobs: pass.report.removedBlobs,
    removedTrees: pass.report.removedTrees,
    removedPacks: pass.report.removedPacks ?? 0,
    removedTmpFiles: pass.report.removedTmpFiles,
    removedRecords: pass.report.removedRecords ?? 0,
    compactedObjects: pass.report.compactedObjects ?? 0,
    writtenPacks: pass.report.writtenPacks ?? 0,
    keptObjects: pass.report.keptObjects,
    freedBytes: pass.report.freedBytes,
  });

  assert.equal(pass.report.stopped, undefined);
  assert.ok(pass.report.removedBlobs >= fixture.deadObjectCount);
  assert.ok(pass.report.freedBytes > 0);
  for (const deadPath of fixture.deadSamplePaths) {
    await assert.rejects(stat(deadPath), { code: "ENOENT" });
  }
  await fixture.store.readTree(fixture.rootOids.at(-1)!);

  return {
    peakRssDeltaBytes: pass.peakRssDeltaBytes,
    durationMs: pass.durationMs,
  };
}

async function reportScaleIndicators(): Promise<void> {
  const g1 = await measureScaleScenario(
    "gc-scale/g1",
    G1_ROOTS,
    FILES_PER_TREE,
  );
  const g10 = await measureScaleScenario(
    "gc-scale/g10",
    G10_ROOTS,
    FILES_PER_TREE,
  );
  reportIndicator("gc-scale/ratios", {
    g1Roots: G1_ROOTS,
    g10Roots: G10_ROOTS,
    filesPerTree: FILES_PER_TREE,
    g1PeakRssDeltaBytes: g1.peakRssDeltaBytes,
    g10PeakRssDeltaBytes: g10.peakRssDeltaBytes,
    rssDeltaRatio:
      g1.peakRssDeltaBytes > 0
        ? g10.peakRssDeltaBytes / g1.peakRssDeltaBytes
        : null,
    g1DurationMs: g1.durationMs,
    g10DurationMs: g10.durationMs,
    durationRatio: g1.durationMs > 0 ? g10.durationMs / g1.durationMs : null,
    contractPeakRssDeltaBytes: 128 * 1024 * 1024,
    contractDurationRatio: 15,
    contractPeakExtraFds: 64,
  });
}

try {
  await reportScaleIndicators();
} finally {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
}
