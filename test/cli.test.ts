import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  utimes,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import * as nativeBinding from "../src/infrastructure/native-file-lock.ts";
import * as metadataApi from "../src/infrastructure/metadata.ts";
import { acquireWorkspaceLock } from "../src/infrastructure/workspace-lock.ts";

import { resolveCliContext } from "../src/cli/context.ts";
import type { CliStreams } from "../src/cli/main.ts";
import { runCli } from "../src/cli/main.ts";
import type { FilesystemKindProbe } from "../src/infrastructure/filesystem-kind.ts";
import { workspaceStorePath } from "../src/infrastructure/workspace-store.ts";
import {
  commitTestNodeState,
  createTestCurrentMetadataStore,
  withTestMetadataWriteAuthority,
} from "./metadata-fixture.ts";

const roots: string[] = [];

interface Sandbox {
  readonly agentDir: string;
  readonly workspace: string;
  readonly storeRoot: string;
}

async function sandbox(): Promise<Sandbox> {
  // realpath so platform temp aliases (/var vs /private/var) compare equal.
  const root = await realpath(await mkdtemp(join(tmpdir(), "cyclotomy-cli-")));
  roots.push(root);
  const agentDir = join(root, "agent");
  const workspace = join(root, "workspace");
  await mkdir(agentDir);
  await mkdir(workspace);
  const canonical = await realpath(workspace);
  return {
    agentDir,
    workspace: canonical,
    storeRoot: workspaceStorePath(join(agentDir, "cyclotomy"), canonical),
  };
}

async function writeGlobalSettings(
  box: Sandbox,
  settings: Record<string, unknown>,
): Promise<void> {
  const directory = join(box.agentDir, "cyclotomy");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "settings.json"), JSON.stringify(settings));
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const LOCAL_PROBE: FilesystemKindProbe = async () => ({
  kind: "local",
  source: "darwin-mount",
  filesystemType: "apfs",
  detail: null,
});

const NETWORK_PROBE: FilesystemKindProbe = async () => ({
  kind: "network",
  source: "darwin-mount",
  filesystemType: "nfs",
  detail: "mount reports nfs",
});

interface RunResult {
  readonly code: number;
  readonly out: string;
  readonly err: string;
  readonly json: () => Record<string, unknown>;
}

async function run(
  box: Sandbox,
  argv: readonly string[],
  probe: FilesystemKindProbe = LOCAL_PROBE,
  signal?: AbortSignal,
): Promise<RunResult> {
  const out: string[] = [];
  const err: string[] = [];
  const streams: CliStreams = {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  };
  const code = await runCli(["--workspace", box.workspace, ...argv], streams, {
    env: { PI_CODING_AGENT_DIR: box.agentDir },
    cwd: box.workspace,
    filesystemProbe: probe,
    signal,
  });
  const stdout = out.join("");
  return {
    code,
    out: stdout,
    err: err.join(""),
    json: () => JSON.parse(stdout) as Record<string, unknown>,
  };
}

const TREE_A = "a".repeat(64);
const TREE_B = "b".repeat(64);

/** A real current store with no sessions in it. */
async function emptyStore(box: Sandbox): Promise<void> {
  await mkdir(box.storeRoot, { recursive: true });
  const store = await createTestCurrentMetadataStore(
    join(box.storeRoot, "state.db"),
    box.storeRoot,
  );
  store.close();
}

/** A real current store, built through the same locked open path the agent uses. */
async function makeStore(box: Sandbox): Promise<void> {
  await mkdir(box.storeRoot, { recursive: true });
  const store = await createTestCurrentMetadataStore(
    join(box.storeRoot, "state.db"),
    box.storeRoot,
  );
  try {
    await withTestMetadataWriteAuthority(box.storeRoot, store, () => {
      commitTestNodeState(store, "session-a", "e1", TREE_A);
      commitTestNodeState(store, "session-a", "e2", TREE_A);
      commitTestNodeState(store, "session-a", "e3", TREE_B);
    });
  } finally {
    store.close();
  }
}

function issuesOf(envelope: Record<string, unknown>): string[] {
  const issues = envelope.issues as readonly { readonly code: string }[];
  return issues.map(({ code }) => code);
}

describe("cli arguments", () => {
  it("prints usage and succeeds for --help", async () => {
    const box = await sandbox();
    const result = await run(box, ["--help"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("Usage: cyclotomy <command>");
    expect(result.err).toBe("");
  });

  it("rejects an unknown command with exit code 2", async () => {
    const box = await sandbox();
    const result = await run(box, ["frobnicate"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("usage error");
    expect(result.out).toBe("");
  });

  it("rejects an unknown option with exit code 2", async () => {
    const box = await sandbox();
    const result = await run(box, ["doctor", "--verbose"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("usage error");
  });

  it("rejects an option the command does not accept", async () => {
    const box = await sandbox();
    const result = await run(box, ["doctor", "--apply", "0".repeat(64)]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("usage error");
  });

  it("requires --offline before recovering a lock", async () => {
    const box = await sandbox();
    const result = await run(box, ["lock", "recover"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("usage error");
  });

  it("rejects an apply token that is not a plan token", async () => {
    const box = await sandbox();
    const result = await run(box, [
      "history",
      "forget",
      "session-a",
      "--apply",
      "nope",
    ]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("usage error");
  });

  it("reports an unresolvable workspace with exit code 2", async () => {
    const box = await sandbox();
    const result = await runCli(
      ["doctor", "--workspace", join(box.workspace, "missing")],
      { out: () => {}, err: () => {} },
      { env: { PI_CODING_AGENT_DIR: box.agentDir } },
    );
    expect(result).toBe(2);
  });
});

describe("cli configuration", () => {
  it("resolves workspace overrides inside the globally selected storage directory", async () => {
    const box = await sandbox();
    await writeGlobalSettings(box, {
      storageDir: "custom-stores",
      lockTimeoutMs: 20,
      maxFileMiB: 60,
      maxEntries: 200,
    });
    const storeRoot = workspaceStorePath(
      join(box.agentDir, "custom-stores"),
      box.workspace,
    );
    const readContext = () =>
      resolveCliContext(
        { workspace: box.workspace, locale: undefined, json: true },
        { env: { PI_CODING_AGENT_DIR: box.agentDir } },
      );
    const initial = await readContext();
    expect(initial.storeRoot).toBe(storeRoot);
    expect(initial.config.lock.timeoutMs).toBe(20);
    expect(initial.config.scan.maxFileBytes).toBe(60 * 1024 * 1024);
    await expect(readdir(storeRoot)).rejects.toMatchObject({ code: "ENOENT" });

    await mkdir(storeRoot, { recursive: true });
    await writeFile(
      join(storeRoot, "settings.json"),
      JSON.stringify({ lockTimeoutMs: 400, maxFileMiB: 75 }),
    );
    const configured = await readContext();
    expect(configured.storeRoot).toBe(storeRoot);
    expect(configured.config.lock.timeoutMs).toBe(400);
    expect(configured.config.scan.maxFileBytes).toBe(75 * 1024 * 1024);
    expect(configured.config.scan.maxEntries).toBe(200);
    expect(await readdir(storeRoot)).toEqual(["settings.json"]);
  });

  it.each(["doctor", "gc"])(
    "reports invalid workspace settings before running %s",
    async (command) => {
      const box = await sandbox();
      await mkdir(box.storeRoot, { recursive: true });
      const settingsPath = join(box.storeRoot, "settings.json");
      await writeFile(
        settingsPath,
        JSON.stringify({ lockTimeoutMs: "invalid" }),
      );
      const result = await run(box, [command, "--json"]);
      expect(result.code).toBe(2);
      expect(result.out).toBe("");
      expect(result.err).toContain(JSON.stringify(settingsPath));
      expect(result.err).toContain("lockTimeoutMs");
      expect(await readdir(box.storeRoot)).toEqual(["settings.json"]);
    },
  );

  it("waits for GC's lock using the workspace timeout instead of the shorter global timeout", async () => {
    const box = await sandbox();
    await emptyStore(box);
    await writeGlobalSettings(box, { lockTimeoutMs: 20 });
    await writeFile(
      join(box.storeRoot, "settings.json"),
      JSON.stringify({ lockTimeoutMs: 2_000 }),
    );
    const held = await acquireWorkspaceLock(box.storeRoot, "holder");
    const binding = await nativeBinding.loadExclusiveFileLock();
    let releaseTimer: NodeJS.Timeout | undefined;
    let releasePending = Promise.resolve();
    vi.spyOn(nativeBinding, "loadExclusiveFileLock").mockResolvedValue({
      ...binding,
      tryAcquire(fd) {
        const acquired = binding.tryAcquire(fd);
        if (!acquired && releaseTimer === undefined) {
          // Start the hold interval only after this caller actually contends.
          releaseTimer = setTimeout(() => {
            releasePending = held.release();
            void releasePending.catch(() => undefined);
          }, 100);
        }
        return acquired;
      },
    });
    try {
      const result = await run(box, ["gc", "--json"]);
      expect(releaseTimer).toBeDefined();
      expect(result.code, result.out || result.err).toBe(0);
      expect(result.json().status).toBe("applied");
    } finally {
      clearTimeout(releaseTimer);
      await releasePending;
      await held.release();
    }
  });
});

describe("cli read commands", () => {
  it("diagnoses an absent store without creating it", async () => {
    const box = await sandbox();
    const result = await run(box, ["doctor", "--json"]);
    expect(result.code).toBe(0);
    const envelope = result.json();
    expect(envelope.command).toBe("doctor");
    expect(envelope.status).toBe("unavailable");
    expect(issuesOf(envelope)).toEqual(["store-absent"]);
    expect((envelope.store as { present: boolean }).present).toBe(false);
    // A read command creates neither the storage root nor the store.
    await expect(readdir(box.agentDir)).resolves.toEqual([]);
  });

  it("diagnoses a V5 store with a native lock as ok", async () => {
    const box = await sandbox();
    await makeStore(box);
    const result = await run(box, ["doctor", "--json"]);
    expect(result.code).toBe(0);
    const envelope = result.json();
    expect(envelope.status).toBe("ok");
    const result_ = envelope.result as {
      readonly metadata: {
        readonly version: number;
        readonly sessionCount: number;
        readonly slots: { readonly totalSlotCount: number };
      };
      readonly lock: { readonly diagnostic: { readonly kind: string } };
      readonly capacityHints: readonly {
        readonly id: string;
        readonly observed: string | null;
      }[];
    };
    expect(result_.metadata.version).toBe(5);
    expect(result_.metadata.sessionCount).toBe(1);
    expect(result_.metadata.slots.totalSlotCount).toBe(3);
    expect(result_.lock.diagnostic.kind).toBe("native-acquired");
    // Byte counts cross the JSON boundary as exact decimal strings.
    const bytes = result_.capacityHints[0]!.observed;
    expect(bytes).toMatch(/^[0-9]+$/u);
  });

  it("lists per-session history with the epoch and reset flag", async () => {
    const box = await sandbox();
    await makeStore(box);
    const result = await run(box, ["history", "--json"]);
    expect(result.code).toBe(0);
    const envelope = result.json();
    expect(envelope.status).toBe("ok");
    const result_ = envelope.result as {
      readonly sessions: readonly {
        readonly sessionId: string;
        readonly totalSlotCount: number;
        readonly checkpointedSlotCount: number;
        readonly blockedSlotCount: number;
        readonly historyEpoch: number | null;
        readonly resetPending: boolean | null;
      }[];
      readonly totals: { readonly sessionCount: number } | null;
    };
    expect(result_.totals?.sessionCount).toBe(1);
    expect(result_.sessions).toHaveLength(1);
    expect(result_.sessions[0]).toMatchObject({
      sessionId: "session-a",
      totalSlotCount: 3,
      checkpointedSlotCount: 3,
      blockedSlotCount: 0,
      historyEpoch: 0,
      resetPending: false,
    });
  });

  it("reports store space for inventory", async () => {
    const box = await sandbox();
    await makeStore(box);
    const result = await run(box, ["inventory", "--json"]);
    expect(result.code).toBe(0);
    const envelope = result.json();
    expect(envelope.status).toBe("ok");
    const result_ = envelope.result as {
      readonly storePresent: boolean;
      readonly metadataFileBytes: string | null;
      readonly metadataPageBytes: string | null;
      readonly metadataReusableBytes: string | null;
    };
    expect(result_.storePresent).toBe(true);
    expect(result_.metadataFileBytes).toMatch(/^[0-9]+$/u);
    expect(result_.metadataPageBytes).toMatch(/^[0-9]+$/u);
  });

  it("scopes inventory to one session", async () => {
    const box = await sandbox();
    await makeStore(box);
    const result = await run(box, [
      "inventory",
      "--session",
      "session-a",
      "--json",
    ]);
    expect(result.code).toBe(0);
    const result_ = result.json().result as {
      readonly sessionFound: boolean | null;
      readonly sessionStats: { readonly sessionId: string } | null;
    };
    expect(result_.sessionFound).toBe(true);
    expect(result_.sessionStats?.sessionId).toBe("session-a");
  });

  it("refuses a write on a proven network filesystem", async () => {
    const box = await sandbox();
    await makeStore(box);
    const result = await run(box, ["gc", "--json"], NETWORK_PROBE);
    expect(result.code).toBe(4);
    const envelope = result.json();
    expect(envelope.status).toBe("unsupported");
    expect(issuesOf(envelope)).toEqual(["unsupported-filesystem"]);
  });
});

describe("cli write commands", () => {
  it("refuses every write when the store is absent", async () => {
    const box = await sandbox();
    for (const argv of [
      ["gc"],
      ["lock", "recover", "--offline"],
      ["history", "forget", "session-a"],
    ]) {
      const result = await run(box, [...argv, "--json"]);
      expect(result.code, argv.join(" ")).toBe(3);
      expect(issuesOf(result.json()), argv.join(" ")).toEqual(["store-absent"]);
    }
  });

  it("previews a history forget and applies it with the returned token", async () => {
    const box = await sandbox();
    await makeStore(box);

    const preview = await run(box, [
      "history",
      "forget",
      "session-a",
      "--json",
    ]);
    expect(preview.code, preview.out || preview.err).toBe(0);
    const previewEnvelope = preview.json();
    expect(previewEnvelope.status).toBe("preview");
    const token = (previewEnvelope.result as { readonly planToken: string })
      .planToken;
    expect(token).toMatch(/^[0-9a-f]{64}$/u);

    const applied = await run(box, [
      "history",
      "forget",
      "session-a",
      "--apply",
      token,
      "--json",
    ]);
    expect(applied.code).toBe(0);
    const appliedEnvelope = applied.json();
    expect(appliedEnvelope.status).toBe("applied");
    const result_ = appliedEnvelope.result as {
      readonly epoch: number;
      readonly removedSlots: number;
      readonly applied: boolean;
    };
    expect(result_.applied).toBe(true);
    expect(result_.removedSlots).toBe(3);
    // The epoch advances exactly once, at forget time.
    expect(result_.epoch).toBe(1);
  });

  it("rejects an apply token that no longer matches the store", async () => {
    const box = await sandbox();
    await makeStore(box);
    const result = await run(box, [
      "history",
      "forget",
      "session-a",
      "--apply",
      "a".repeat(64),
      "--json",
    ]);
    expect(result.code).toBe(3);
    expect(result.json().status).toBe("busy");
    expect(issuesOf(result.json())).toEqual(["preview-changed"]);
  });

  it("reports an unknown session instead of failing", async () => {
    const box = await sandbox();
    await makeStore(box);
    const result = await run(box, [
      "history",
      "forget",
      "session-missing",
      "--json",
    ]);
    expect(result.code).toBe(3);
    const envelope = result.json();
    expect(issuesOf(envelope)).toEqual(["session-unknown"]);
    expect(envelope.status).toBe("blocked");
  });

  it("finds nothing to recover for a native lock", async () => {
    const box = await sandbox();
    await makeStore(box);
    const result = await run(box, ["lock", "recover", "--offline", "--json"]);
    expect(result.code).toBe(0);
    const envelope = result.json();
    expect(envelope.status).toBe("ok");
    expect((envelope.result as { readonly kind: string }).kind).toBe(
      "nothing-to-recover",
    );
  });

  it("collects garbage behind the workspace lock", async () => {
    const box = await sandbox();
    await emptyStore(box);
    const result = await run(box, ["gc", "--json"]);
    expect(result.code, result.out || result.err).toBe(0);
    const envelope = result.json();
    expect(envelope.status).toBe("applied");
    const result_ = envelope.result as {
      readonly removedTrees: number;
      readonly keptObjects: number;
      readonly freedBytes: string;
      readonly filesystem: { readonly kind: string };
    };
    expect(result_.removedTrees).toBe(0);
    expect(result_.keptObjects).toBe(0);
    expect(result_.freedBytes).toBe("0");
    expect(result_.filesystem.kind).toBe("local");
  });

  it("refuses to sweep while a rooted tree is unreadable", async () => {
    const box = await sandbox();
    await makeStore(box);
    const result = await run(box, ["gc", "--json"]);
    expect(result.code, result.out || result.err).toBe(5);
    const envelope = result.json();
    expect(envelope.status).toBe("error");
    expect(issuesOf(envelope)).toEqual(["io-failure"]);
    expect(result.out).toContain("refusing to sweep");
  });
});

describe("cli failure boundaries", () => {
  it("reports uninitialized metadata consistently across maintenance commands", async () => {
    const box = await sandbox();
    await mkdir(box.storeRoot, { recursive: true });
    await writeFile(join(box.storeRoot, "state.db"), "");
    for (const command of [
      ["doctor"],
      ["inventory"],
      ["history"],
      ["history", "forget", "session"],
      ["gc"],
    ]) {
      const result = await run(box, [...command, "--json"]);
      expect(result.code, result.out).toBe(5);
      expect(issuesOf(result.json())).toContain("metadata-uninitialized");
    }
    expect(await readFile(join(box.storeRoot, "state.db"))).toHaveLength(0);
  });

  it("includes staged and temporary files in the reported physical object bytes", async () => {
    const box = await sandbox();
    await emptyStore(box);
    await mkdir(join(box.storeRoot, "objects", "packs", "incoming"), {
      recursive: true,
    });
    await writeFile(
      join(box.storeRoot, "objects", "packs", "incoming", "candidate.pack"),
      Buffer.alloc(4096),
    );
    await writeFile(
      join(box.storeRoot, "objects", "packs", "abandoned.tmp"),
      Buffer.alloc(8192),
    );
    const structured = await run(box, ["inventory", "--json"]);
    expect(structured.code).toBe(0);
    expect(structured.json().result).toMatchObject({
      objectFileBytes: "12288",
      objectFiles: {
        fileCount: 2,
        incomingBytes: "4096",
        temporaryBytes: "8192",
      },
    });
    const human = await run(box, ["inventory", "--locale", "en"]);
    expect(human.out).toMatch(/^objects\s+12.0 KiB · 2 files · complete/mu);
  });

  it.each(["missing", "empty"])(
    "refuses GC and diagnoses retained objects when metadata is %s",
    async (kind) => {
      const box = await sandbox();
      const shard = join(box.storeRoot, "objects", "blobs", "aa");
      await mkdir(shard, { recursive: true });
      const saved = join(shard, "a".repeat(62));
      await writeFile(saved, "saved checkpoint content");
      await utimes(saved, new Date(0), new Date(0));
      if (kind === "empty")
        await writeFile(join(box.storeRoot, "state.db"), "");
      const code =
        kind === "missing" ? "metadata-missing" : "metadata-uninitialized";
      for (const command of ["doctor", "inventory", "history", "gc"]) {
        const result = await run(box, [command, "--json"]);
        expect(result.code, result.out).toBe(5);
        expect(issuesOf(result.json())).toContain(code);
        if (command !== "gc") {
          expect(result.json().store).toMatchObject({ present: true });
          expect(result.json().result).toMatchObject({
            directoryPresent: true,
            objectsPresent: true,
          });
        }
      }
      expect(await readFile(saved, "utf8")).toBe("saved checkpoint content");
      if (kind === "missing")
        expect(await readdir(box.storeRoot)).not.toContain("state.db");
      else
        expect(await readFile(join(box.storeRoot, "state.db"))).toHaveLength(0);
    },
  );

  it("reports a busy lock with exit 3", async () => {
    const box = await sandbox();
    await emptyStore(box);
    await writeGlobalSettings(box, { lockTimeoutMs: 20 });
    const held = await acquireWorkspaceLock(box.storeRoot, "holder");
    try {
      const result = await run(box, ["gc", "--json"]);
      expect(result.code).toBe(3);
      expect(result.json().status).toBe("busy");
      expect(issuesOf(result.json())).toEqual(["lock-busy"]);
    } finally {
      await held.release();
    }
  });

  it.each(["metadata", "lock", "platform"])(
    "reports unsupported %s with exit 4",
    async (kind) => {
      const box = await sandbox();
      await emptyStore(box);
      if (kind === "metadata") {
        const db = new DatabaseSync(join(box.storeRoot, "state.db"));
        db.exec("PRAGMA user_version=99");
        db.close();
      } else if (kind === "lock") {
        await writeFile(
          join(box.storeRoot, "lock-protocol.json"),
          JSON.stringify({ format: 99, protocol: "future" }),
        );
      } else {
        vi.spyOn(nativeBinding, "loadExclusiveFileLock").mockRejectedValue(
          new nativeBinding.NativeFileLockUnavailableError(
            new Error("binding missing"),
          ),
        );
      }
      const result = await run(box, ["gc", "--json"]);
      expect(result.code, result.out).toBe(4);
      expect(result.json().status).toBe("unsupported");
      expect(issuesOf(result.json())).toEqual([
        kind === "metadata"
          ? "store-format-newer"
          : kind === "lock"
            ? "lock-protocol-unsupported"
            : "platform-unsupported",
      ]);
    },
  );

  it.each(["gc", "forget"])(
    "keeps the completed %s result when metadata close and lock release fail",
    async (command) => {
      const box = await sandbox();
      if (command === "gc") await emptyStore(box);
      else await makeStore(box);
      const preview =
        command === "forget"
          ? await run(box, ["history", "forget", "session-a", "--json"])
          : undefined;
      const planToken = (
        preview?.json().result as { planToken: string } | undefined
      )?.planToken;
      const binding = await nativeBinding.loadExclusiveFileLock();
      vi.spyOn(nativeBinding, "loadExclusiveFileLock").mockResolvedValue({
        tryAcquire: (fd) => binding.tryAcquire(fd),
        release: (fd) => {
          binding.release(fd);
          throw new Error("unlock EIO");
        },
      });
      const open = metadataApi.openExistingMetadataStore;
      vi.spyOn(metadataApi, "openExistingMetadataStore").mockImplementation(
        async (...args) => {
          const metadata = await open(...args);
          const close = metadata.close.bind(metadata);
          vi.spyOn(metadata, "close").mockImplementation(() => {
            close();
            throw new Error("metadata close EIO");
          });
          return metadata;
        },
      );
      const result = await run(
        box,
        command === "gc"
          ? ["gc", "--json"]
          : ["history", "forget", "session-a", "--apply", planToken!, "--json"],
      );
      expect(result.code, result.out).toBe(5);
      expect(result.json().status).toBe("error");
      expect(issuesOf(result.json())).toEqual(["cleanup-failed"]);
      expect(result.out).toContain("metadata close EIO");
      expect(result.out).toContain("unlock EIO");
      expect(result.json().result).toMatchObject(
        command === "gc"
          ? { freedBytes: "0", removedBlobs: 0 }
          : { kind: "forgotten", applied: true, epoch: 1, removedSlots: 3 },
      );
    },
  );

  it("keeps cancellation and a lock cleanup error in one partial GC report", async () => {
    const box = await sandbox();
    await emptyStore(box);
    const controller = new AbortController();
    const binding = await nativeBinding.loadExclusiveFileLock();
    vi.spyOn(nativeBinding, "loadExclusiveFileLock").mockResolvedValue({
      tryAcquire: (fd) => binding.tryAcquire(fd),
      release: (fd) => {
        binding.release(fd);
        throw new Error("cancel cleanup EIO");
      },
    });
    const out: string[] = [];
    const code = await runCli(
      ["--workspace", box.workspace, "gc", "--json"],
      { out: (text) => out.push(text), err: () => {} },
      {
        env: { PI_CODING_AGENT_DIR: box.agentDir },
        filesystemProbe: LOCAL_PROBE,
        signal: controller.signal,
        onProgress: () => controller.abort(),
      },
    );
    const envelope = JSON.parse(out.join(""));
    expect(code).toBe(5);
    expect(issuesOf(envelope)).toEqual(["cancelled", "cleanup-failed"]);
    expect(envelope.result).toMatchObject({
      stopped: "cancelled",
      freedBytes: "0",
    });
  });

  it("does not hide an operation error behind a concurrent cancellation", async () => {
    const box = await sandbox();
    await emptyStore(box);
    const controller = new AbortController();
    vi.spyOn(metadataApi, "openExistingMetadataStore").mockImplementation(
      async () => {
        controller.abort();
        throw new AggregateError(
          [controller.signal.reason, new Error("real I/O failure")],
          "cancel and I/O",
        );
      },
    );
    const result = await run(
      box,
      ["gc", "--json"],
      LOCAL_PROBE,
      controller.signal,
    );
    expect(result.code).toBe(5);
    expect(result.out).toContain("real I/O failure");
    expect(issuesOf(result.json())).toEqual(["cancelled", "io-failure"]);
  });

  it("emits a JSON document for cancellation before lock acquisition", async () => {
    const box = await sandbox();
    await emptyStore(box);
    const controller = new AbortController();
    controller.abort();
    const result = await run(
      box,
      ["gc", "--json"],
      LOCAL_PROBE,
      controller.signal,
    );
    expect(result.code).toBe(130);
    expect(issuesOf(result.json())).toEqual(["cancelled"]);
  });
});

describe("cli cancellation", () => {
  it("reports 130 when cancellation stops a command before it writes", async () => {
    const box = await sandbox();
    await makeStore(box);
    const controller = new AbortController();
    controller.abort();
    const result = await run(box, ["gc"], LOCAL_PROBE, controller.signal);
    expect(result.code).toBe(130);
    expect(result.err).toContain("cancelled");
  });

  it("reports a gc stopped mid-pass as a partial document with exit 130", async () => {
    const box = await sandbox();
    await emptyStore(box);
    const controller = new AbortController();
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(
      ["--workspace", box.workspace, "gc", "--json"],
      { out: (text) => out.push(text), err: (text) => err.push(text) },
      {
        env: { PI_CODING_AGENT_DIR: box.agentDir },
        cwd: box.workspace,
        filesystemProbe: LOCAL_PROBE,
        signal: controller.signal,
        // Cancel as soon as the pass reports its first phase: the stop lands
        // inside the pass, so its document must describe the partial result.
        onProgress: () => controller.abort(),
      },
    );
    expect(code).toBe(130);
    const envelope = JSON.parse(out.join("")) as Record<string, unknown>;
    expect(envelope.status).toBe("partial");
    expect(issuesOf(envelope)).toEqual(["cancelled"]);
    const result_ = envelope.result as {
      readonly stopped: string;
      readonly removedBlobs: number;
      readonly freedBytes: string;
    };
    expect(result_.stopped).toBe("cancelled");
    expect(result_.removedBlobs).toBe(0);
    expect(result_.freedBytes).toBe("0");
    expect(err.join("")).toContain("cancelled");
  });

  it("does not claim cancellation for a command that already completed", async () => {
    const box = await sandbox();
    const controller = new AbortController();
    controller.abort();
    const result = await run(
      box,
      ["doctor", "--json"],
      LOCAL_PROBE,
      controller.signal,
    );
    // The document and the exit code agree: the diagnosis did complete.
    expect(result.code).toBe(0);
    expect(result.json().status).toBe("unavailable");
    expect(result.err).toContain("cancelled");
  });
});

describe("cli human output", () => {
  it("honors the requested locale when workspace configuration fails", async () => {
    const box = await sandbox();
    await writeGlobalSettings(box, { locale: "en" });
    await mkdir(box.storeRoot, { recursive: true });
    await writeFile(
      join(box.storeRoot, "settings.json"),
      JSON.stringify({ lockTimeoutMs: "invalid" }),
    );
    const result = await run(box, ["doctor", "--locale", "zh-CN"]);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/^配置错误：/u);
    expect(result.err).toContain("lockTimeoutMs");
  });

  it("localizes the report and keeps issue codes untranslated", async () => {
    const box = await sandbox();
    const result = await run(box, ["doctor", "--locale", "zh-CN"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("未检查");
    expect(result.out).toContain("store-absent");
    expect(result.out).toContain("工作区");
  });

  it.each(["en", "zh-CN"])(
    "uses the global %s locale unless the command overrides it",
    async (locale) => {
      const box = await sandbox();
      await writeGlobalSettings(box, { locale });
      const result = await run(box, ["history"]);
      expect(result.code).toBe(0);
      expect(result.out).toMatch(locale === "en" ? /^store\s/mu : /^存储\s/mu);
      const overridden = await run(box, [
        "history",
        "--locale",
        locale === "en" ? "zh-CN" : "en",
      ]);
      expect(overridden.code).toBe(0);
      expect(overridden.out).toMatch(
        locale === "en" ? /^存储\s/mu : /^store\s/mu,
      );
    },
  );
});
