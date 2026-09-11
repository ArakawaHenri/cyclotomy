import { assertTestWorkspaceLockReleased } from "./workspace-lock-fixture.ts";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerCyclotomy } from "../src/pi/register.ts";
import { CheckpointService } from "../src/application/checkpoint-service.ts";
import { CyclotomyRuntime } from "../src/pi/runtime.ts";
import { FakePi, FakeSessionManager } from "./fake-pi.ts";
import {
  checkpointIsBlocked,
  checkpointState,
  createTestCurrentMetadataStore,
} from "./metadata-fixture.ts";
import {} from "../src/infrastructure/workspace-lock.ts";

let workspace: string;
let agentDir: string;
let storeRoot: string;
let previousAgentDir: string | undefined;
let previousCyclotomyEnabled: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "cyclotomy-participation-ws-"));
  agentDir = await mkdtemp(join(tmpdir(), "cyclotomy-participation-home-"));
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  previousCyclotomyEnabled = process.env.CYCLOTOMY_ENABLED;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.CYCLOTOMY_ENABLED;
  await mkdir(join(agentDir, "cyclotomy"));
  await writeSettings({ locale: "en", gc: { intervalMs: 0 } });
  storeRoot = join(
    agentDir,
    "cyclotomy",
    createHash("sha256")
      .update(await realpath(workspace))
      .digest("hex"),
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  await FakePi.disposeAll();
  if (previousAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
  if (previousCyclotomyEnabled === undefined) {
    delete process.env.CYCLOTOMY_ENABLED;
  } else {
    process.env.CYCLOTOMY_ENABLED = previousCyclotomyEnabled;
  }
  await Promise.all([
    rm(workspace, { recursive: true, force: true }),
    rm(agentDir, { recursive: true, force: true }),
  ]);
});

async function writeSettings(settings: unknown): Promise<void> {
  await writeFile(
    join(agentDir, "cyclotomy", "settings.json"),
    JSON.stringify(settings),
  );
}

async function expectPiPreparationPasses(pi: FakePi): Promise<void> {
  const target = pi.manager.getEntries()[0];
  if (target === undefined) throw new Error("test session has no target entry");

  await expect(pi.preflightInput("continue normally")).resolves.toBe(
    "continued",
  );
  let bashRan = false;
  await pi.executeUserBash(
    "true",
    async () => {
      bashRan = true;
    },
    false,
  );
  expect(bashRan).toBe(true);
  await expect(pi.prepareNavigation(target.id)).resolves.toBe("ready");
  await expect(pi.prepareSwitch()).resolves.toBe("ready");
  await expect(pi.beginFork(target.id, "at")).resolves.not.toBe("cancelled");
}

async function startTwoNodeSession(pi: FakePi): Promise<string> {
  const target = pi.manager.appendEntry().id;
  pi.manager.appendEntry();

  await pi.startSession("startup");
  return target;
}

describe("Cyclotomy participation boundary", () => {
  it.each(["scan", "publish", "validate"] as const)(
    "Escape cancels %s before accepting input and preserves the previous checkpoint",
    async (phase) => {
      const pi = new FakePi(workspace, registerCyclotomy);
      const node = pi.manager.appendEntry().id;
      await writeFile(join(workspace, "state.txt"), "original");

      await pi.startSession("startup");
      const db = await createTestCurrentMetadataStore(
        join(storeRoot, "state.db"),
        storeRoot,
      );
      const saved = checkpointState(db, pi.manager.sessionId, node);
      expect(saved).toBeDefined();
      await writeFile(join(workspace, "state.txt"), "changed");

      let consumed = false;
      const prepare = CheckpointService.prototype.prepareCurrent;
      vi.spyOn(
        CheckpointService.prototype,
        "prepareCurrent",
      ).mockImplementation(function (
        this: CheckpointService,
        view,
        options = {},
      ) {
        return prepare.call(this, view, {
          ...options,
          onProgress: (progress) => {
            options.onProgress?.(progress);
            if (progress.phase === phase && !consumed) {
              expect(pi.statuses.get("cyclotomy")).toContain("Esc to cancel");
              consumed = pi.terminalInput("\u001b");
              expect(options.signal?.aborted).toBe(true);
            }
          },
        });
      });

      await expect(pi.preflightInput("continue")).resolves.toBe("handled");
      expect(consumed).toBe(true);
      expect(checkpointState(db, pi.manager.sessionId, node)).toEqual(saved);
      expect(checkpointIsBlocked(db, pi.manager.sessionId, node)).toBe(false);
      expect(await readFile(join(workspace, "state.txt"), "utf8")).toBe(
        "changed",
      );
      expect(pi.notifications.at(-1)).toEqual({
        message: "Checkpoint cancelled.",
        level: "info",
      });
      expect(pi.statuses.has("cyclotomy")).toBe(false);
      expect(pi.terminalInputHandlers.size).toBe(0);
      // The persistent lock file remains; the cancelled operation must have
      // released its exclusive native lock.
      await assertTestWorkspaceLockReleased(storeRoot);
      db.close();
    },
  );

  it("Escape cancels the first checkpoint and durably protects its unobserved location", async () => {
    const pi = new FakePi(workspace, registerCyclotomy);
    const node = pi.manager.appendEntry().id;
    await writeFile(join(workspace, "state.txt"), "initial");
    const prepare = CheckpointService.prototype.prepareCurrent;
    let consumed = false;
    vi.spyOn(CheckpointService.prototype, "prepareCurrent").mockImplementation(
      function (this: CheckpointService, view, options = {}) {
        return prepare.call(this, view, {
          ...options,
          onProgress: (progress) => {
            options.onProgress?.(progress);
            if (!consumed) consumed = pi.terminalInput("\u001b[27u");
          },
        });
      },
    );

    await pi.startSession("startup");
    expect(consumed).toBe(true);
    const db = await createTestCurrentMetadataStore(
      join(storeRoot, "state.db"),
      storeRoot,
    );
    expect(checkpointState(db, pi.manager.sessionId, node)).toBeUndefined();
    expect(checkpointIsBlocked(db, pi.manager.sessionId, node)).toBe(true);
    expect(
      pi.notifications.some(
        ({ message, level }) =>
          message ===
            "Checkpoint cancelled. Automatic checkpoints are paused at this node." &&
          level === "info",
      ),
    ).toBe(true);
    expect(pi.terminalInputHandlers.size).toBe(0);
    expect(pi.statuses.has("cyclotomy")).toBe(false);
    db.close();
  });

  it("pause aborts an initializing capture before its candidate is published", async () => {
    const pi = new FakePi(workspace, registerCyclotomy);
    const node = pi.manager.appendEntry().id;
    await writeFile(join(workspace, "state.txt"), "initial");
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let signal: AbortSignal | undefined;
    vi.spyOn(CheckpointService.prototype, "prepareCurrent").mockImplementation(
      async (_view, options = {}) => {
        signal = options.signal;
        entered();
        await new Promise<void>((resolve) =>
          signal!.addEventListener("abort", () => resolve(), { once: true }),
        );
        return { ok: false, error: { kind: "cancelled" } };
      },
    );

    const starting = pi.startSession("startup");
    await started;
    const stopping = pi.runCommand("cyclotomy", "pause");
    expect(signal?.aborted).toBe(true);
    await Promise.all([starting, stopping]);

    const db = await createTestCurrentMetadataStore(
      join(storeRoot, "state.db"),
      storeRoot,
    );
    expect(checkpointState(db, pi.manager.sessionId, node)).toBeUndefined();
    expect(checkpointIsBlocked(db, pi.manager.sessionId, node)).toBe(true);
    expect(pi.notifications.at(-1)?.message).toBe(
      "Cyclotomy paused in this Pi instance.",
    );
    expect(pi.terminalInputHandlers.size).toBe(0);
    db.close();
  });

  it("throttles file progress while showing each phase and clearing the status", async () => {
    const pi = new FakePi(workspace, registerCyclotomy);
    pi.manager.appendEntry();
    const statuses = vi.spyOn(pi.context.ui, "setStatus");
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    vi.spyOn(CheckpointService.prototype, "prepareCurrent").mockImplementation(
      async (_view, options = {}) => {
        options.onProgress?.({ phase: "scan", files: 1, bytes: 1024 });
        clock.mockReturnValue(100);
        options.onProgress?.({ phase: "scan", files: 2, bytes: 2048 });
        clock.mockReturnValue(300);
        options.onProgress?.({ phase: "scan", files: 3, bytes: 3072 });
        options.onProgress?.({ phase: "publish", files: 3, bytes: 3072 });
        options.onProgress?.({ phase: "validate", files: 3, bytes: 3072 });
        return { ok: false, error: { kind: "cancelled" } };
      },
    );

    await pi.startSession("startup");

    const progress = statuses.mock.calls
      .map(([, message]) => message)
      .filter((message) => message?.includes("files"));
    expect(progress).toHaveLength(4);
    expect(progress[0]).toContain("scanning · 0 files");
    expect(progress[1]).toContain("scanning · 3 files");
    expect(progress[2]).toContain("saving · 3 files");
    expect(progress[3]).toContain("verifying · 3 files");
    expect(pi.statuses.has("cyclotomy")).toBe(false);
  });

  it("starts paused when CYCLOTOMY_ENABLED is zero and resumes explicitly", async () => {
    process.env.CYCLOTOMY_ENABLED = "0";
    const pi = new FakePi(workspace, registerCyclotomy);
    pi.manager.appendEntry();

    await pi.startSession("startup");
    await pi.runCommand("cyclotomy");
    expect(pi.notifications.at(-1)).toEqual({
      message:
        "Cyclotomy is paused in this Pi instance. Run /cyclotomy resume to start it again.",
      level: "info",
    });
    await expectPiPreparationPasses(pi);
    await expect(access(storeRoot)).rejects.toMatchObject({ code: "ENOENT" });

    await pi.runCommand("cyclotomy", "resume");
    expect(pi.notifications.at(-1)).toEqual({
      message: "Cyclotomy resumed.",
      level: "info",
    });
    await pi.endTurn();
    const target = pi.manager.getLeafId();
    expect(target).not.toBeNull();
    const db = await createTestCurrentMetadataStore(
      join(storeRoot, "state.db"),
      storeRoot,
    );
    expect(checkpointState(db, pi.manager.sessionId, target!)).toBeDefined();
    db.close();
  });

  it.each([
    { enabled: true, environment: undefined, running: true },
    { enabled: false, environment: undefined, running: false },
    { enabled: true, environment: "0", running: false },
    { enabled: false, environment: "0", running: false },
    { enabled: true, environment: "1", running: true },
    { enabled: false, environment: "1", running: true },
  ])(
    "starts with global enabled=$enabled and environment=$environment",
    async ({ enabled, environment, running }) => {
      await writeSettings({ enabled, locale: "en", gc: { intervalMs: 0 } });
      if (environment !== undefined)
        process.env.CYCLOTOMY_ENABLED = environment;
      const pi = new FakePi(workspace, registerCyclotomy);
      pi.manager.appendEntry();

      await pi.startSession("startup");
      await pi.runCommand("cyclotomy");

      expect(pi.notifications.at(-1)?.message).toContain(
        running ? "is running" : "is paused",
      );
      if (!running) {
        await expect(access(storeRoot)).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    },
  );

  it("persists global defaults independently of each Pi instance's participation", async () => {
    const settingsPath = join(agentDir, "cyclotomy", "settings.json");
    const first = new FakePi(workspace, registerCyclotomy);
    first.manager.appendEntry();

    await first.startSession("startup");

    await first.runCommand("cyclotomy", "disable");
    expect(first.notifications.at(-1)?.message).toContain(
      "disabled by default",
    );
    const disabledSettings = await readFile(settingsPath, "utf8");
    expect(JSON.parse(disabledSettings)).toEqual({
      enabled: false,
      locale: "en",
      gc: { intervalMs: 0 },
    });
    await first.runCommand("cyclotomy");
    expect(first.notifications.at(-1)?.message).toBe("Cyclotomy is running.");

    const secondWorkspace = join(workspace, "second");
    await mkdir(secondWorkspace);

    const second = new FakePi(secondWorkspace, registerCyclotomy);
    second.manager.appendEntry();
    await second.startSession("startup");
    await second.runCommand("cyclotomy");
    expect(second.notifications.at(-1)?.message).toContain("is paused");

    await second.runCommand("cyclotomy", "resume");
    expect(second.notifications.at(-1)?.message).toBe("Cyclotomy resumed.");
    await first.runCommand("cyclotomy", "pause");
    await second.runCommand("cyclotomy");
    expect(second.notifications.at(-1)?.message).toBe("Cyclotomy is running.");
    expect(await readFile(settingsPath, "utf8")).toBe(disabledSettings);

    await first.runCommand("cyclotomy", "enable");
    expect(first.notifications.at(-1)?.message).toContain("enabled by default");
    expect(JSON.parse(await readFile(settingsPath, "utf8")).enabled).toBe(true);
    await first.runCommand("cyclotomy");
    expect(first.notifications.at(-1)?.message).toContain("is paused");

    const thirdWorkspace = join(workspace, "third");
    await mkdir(thirdWorkspace);

    const third = new FakePi(thirdWorkspace, registerCyclotomy);
    third.manager.appendEntry();
    await third.startSession("startup");
    await third.runCommand("cyclotomy");
    expect(third.notifications.at(-1)?.message).toBe("Cyclotomy is running.");
  });

  it("saves a global default even when this instance has an environment override", async () => {
    process.env.CYCLOTOMY_ENABLED = "0";
    const pi = new FakePi(workspace, registerCyclotomy);
    pi.manager.appendEntry();
    await pi.startSession("startup");

    await pi.runCommand("cyclotomy", "enable");
    expect(pi.notifications.at(-1)?.message).toContain(
      "CYCLOTOMY_ENABLED overrides",
    );
    expect(
      JSON.parse(
        await readFile(join(agentDir, "cyclotomy", "settings.json"), "utf8"),
      ).enabled,
    ).toBe(true);
    await pi.reloadExtension();
    await pi.runCommand("cyclotomy");
    expect(pi.notifications.at(-1)?.message).toContain("is paused");
    await expect(access(storeRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a settings write failure without changing active participation", async () => {
    const pi = new FakePi(workspace, registerCyclotomy);
    pi.manager.appendEntry();

    await pi.startSession("startup");
    const settingsPath = join(agentDir, "cyclotomy", "settings.json");
    await rm(settingsPath);
    await mkdir(settingsPath);

    await expect(
      pi.runCommand("cyclotomy", "disable"),
    ).resolves.toBeUndefined();

    expect(pi.notifications.at(-1)?.level).toBe("error");
    expect(pi.notifications.at(-1)?.message).toContain(
      "could not save the global default",
    );
    await pi.runCommand("cyclotomy");
    expect(pi.notifications.at(-1)?.message).toBe("Cyclotomy is running.");
  });

  it.each([
    { state: "paused", resume: false },
    { state: "explicitly resumed", resume: true },
  ])(
    "retires $state participation when Pi repeats session_start",
    async ({ resume }) => {
      process.env.CYCLOTOMY_ENABLED = "0";
      const pi = new FakePi(workspace, registerCyclotomy);
      pi.manager.appendEntry();
      await pi.startSession("startup");
      if (resume) {
        await pi.runCommand("cyclotomy", "resume");
      }

      pi.notifications.length = 0;
      await pi.emitMalformedSessionStart("reload");
      await pi.runCommand("cyclotomy");

      expect(pi.notifications.at(-1)?.message).toContain(
        "Pi delivered more than one session_start to an extension runtime",
      );
      await expectPiPreparationPasses(pi);
    },
  );

  it("retires and protects active participation when Pi repeats session_start", async () => {
    const pi = new FakePi(workspace, registerCyclotomy);
    const target = pi.manager.appendEntry().id;
    await writeFile(join(workspace, "state.txt"), "checkpoint");

    await pi.startSession("startup");
    await pi.endTurn(0);
    const before = await createTestCurrentMetadataStore(
      join(storeRoot, "state.db"),
      storeRoot,
    );
    expect(checkpointState(before, pi.manager.sessionId, target)).toBeDefined();
    expect(checkpointIsBlocked(before, pi.manager.sessionId, target)).toBe(
      false,
    );
    before.close();

    await pi.emitMalformedSessionStart("reload");
    await pi.runCommand("cyclotomy");

    expect(pi.notifications.at(-1)?.message).toContain(
      "Pi delivered more than one session_start to an extension runtime",
    );
    const after = await createTestCurrentMetadataStore(
      join(storeRoot, "state.db"),
      storeRoot,
    );
    expect(checkpointIsBlocked(after, pi.manager.sessionId, target)).toBe(true);
    after.close();
    await expectPiPreparationPasses(pi);
  });

  it.each([
    {
      name: "configuration parsing fails",
      settings: { maxFileMiB: -1 },
    },
    {
      name: "the control store overlaps the workspace",
      settings: { storageDir: "WORKSPACE", gc: { intervalMs: 0 } },
    },
  ])("leaves Pi usable when $name", async ({ settings }) => {
    await writeSettings(
      "storageDir" in settings
        ? { ...settings, storageDir: workspace }
        : settings,
    );
    const pi = new FakePi(workspace, registerCyclotomy);
    await startTwoNodeSession(pi);

    await expectPiPreparationPasses(pi);
  });

  it("retires a running engine when Pi observations become unusable", async () => {
    const pi = new FakePi(workspace, registerCyclotomy);
    await startTwoNodeSession(pi);
    pi.sessionContextThrows = true;

    await expectPiPreparationPasses(pi);
    await pi.runCommand("cyclotomy");
    expect(
      pi.notifications.some(({ message }) =>
        message.includes("test session context failure"),
      ),
    ).toBe(true);
  });

  it("pause detaches immediately, drains admitted work, then closes", async () => {
    const pi = new FakePi(workspace, registerCyclotomy);
    await startTwoNodeSession(pi);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(
      CyclotomyRuntime.prototype,
      "maybeRunAutomaticGc",
    ).mockImplementation(async () => {
      entered();
      await gate;
      return {
        kind: "completed",
        value: undefined,
        cleanup: { kind: "settled" },
      };
    });
    const close = vi.spyOn(CyclotomyRuntime.prototype, "close");
    const inFlight = pi.endTurn(0);
    await started;

    const stopping = pi.runCommand("cyclotomy", "pause");
    await Promise.resolve();
    await expect(pi.preflightInput("after detach")).resolves.toBe("continued");
    expect(close).not.toHaveBeenCalled();

    release();
    await Promise.all([inFlight, stopping]);
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    await expectPiPreparationPasses(pi);
  });

  it("pause supersedes a resume that is waiting for Pi to become idle", async () => {
    const pi = new FakePi(workspace, registerCyclotomy);
    await startTwoNodeSession(pi);
    await pi.runCommand("cyclotomy", "pause");
    let release!: () => void;
    pi.waitForIdleHook = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });

    const resuming = pi.runCommand("cyclotomy", "resume");
    await vi.waitFor(() => expect(pi.waitForIdleCalls).toBe(1));
    const stopping = pi.runCommand("cyclotomy", "pause");
    release();
    await Promise.all([resuming, stopping]);

    await pi.runCommand("cyclotomy");
    expect(pi.notifications.at(-1)?.message).toContain("paused");
    await expectPiPreparationPasses(pi);
  });

  it("resume rebuilds only Cyclotomy and applies reload-style protection", async () => {
    let adjunctState = 0;
    const factory = (pi: ExtensionAPI): void => {
      pi.registerCommand("adjunct", {
        description: "stateful test command",
        handler: async () => {
          adjunctState += 1;
        },
      });
      registerCyclotomy(pi);
    };
    const pi = new FakePi(workspace, factory);
    const leaf = pi.manager.appendEntry().id;
    await writeFile(join(workspace, "state.txt"), "checkpoint");

    await pi.startSession("startup");
    const before = await createTestCurrentMetadataStore(
      join(storeRoot, "state.db"),
      storeRoot,
    );
    const saved = checkpointState(before, pi.manager.sessionId, leaf);
    before.close();
    expect(saved).toBeDefined();

    await pi.runCommand("adjunct");
    await pi.runCommand("cyclotomy", "pause");
    const stopped = await createTestCurrentMetadataStore(
      join(storeRoot, "state.db"),
      storeRoot,
    );
    expect(checkpointIsBlocked(stopped, pi.manager.sessionId, leaf)).toBe(true);
    stopped.close();
    await writeFile(join(workspace, "state.txt"), "changed while stopped");
    await pi.runCommand("cyclotomy", "resume");
    await pi.runCommand("adjunct");

    expect(adjunctState).toBe(2);
    expect(pi.factoryLoads).toBe(1);
    expect(pi.reloadCalls).toBe(0);
    expect(pi.waitForIdleCalls).toBe(1);
    expect(await readFile(join(workspace, "state.txt"), "utf8")).toBe(
      "changed while stopped",
    );
    const after = await createTestCurrentMetadataStore(
      join(storeRoot, "state.db"),
      storeRoot,
    );
    expect(checkpointState(after, pi.manager.sessionId, leaf)).toEqual(saved);
    expect(checkpointIsBlocked(after, pi.manager.sessionId, leaf)).toBe(true);
    after.close();
  });

  it("repairs an initialization failure locally after configuration changes", async () => {
    await writeSettings({ maxFileMiB: -1 });
    const pi = new FakePi(workspace, registerCyclotomy);
    const original = pi.manager.appendEntry().id;
    await pi.startSession("startup");
    await expectPiPreparationPasses(pi);

    await writeSettings({ locale: "en", gc: { intervalMs: 0 } });

    await pi.runCommand("cyclotomy", "resume");

    expect(pi.factoryLoads).toBe(1);
    expect(pi.reloadCalls).toBe(0);
    expect(pi.waitForIdleCalls).toBe(1);
    await pi.endTurn();
    const db = await createTestCurrentMetadataStore(
      join(storeRoot, "state.db"),
      storeRoot,
    );
    expect(checkpointState(db, pi.manager.sessionId, original)).toBeUndefined();
    expect(
      checkpointState(db, pi.manager.sessionId, pi.manager.getLeafId()!),
    ).toBeDefined();
    db.close();
  });

  it("treats an in-memory session as intentional non-participation", async () => {
    const pi = new FakePi(workspace, registerCyclotomy);
    pi.manager = pi.newInMemorySession();
    pi.manager.appendEntry();

    await pi.startSession("startup");
    await pi.runCommand("cyclotomy");
    expect(pi.notifications.at(-1)).toEqual({
      message:
        "Cyclotomy is paused in this Pi instance. Run /cyclotomy resume to start it again.",
      level: "info",
    });

    pi.notifications.length = 0;
    await pi.runCommand("cyclotomy", "resume");
    expect(pi.notifications.at(-1)).toEqual({
      message: "Cyclotomy is unavailable in this session.",
      level: "info",
    });
    expect(
      pi.notifications.some(({ message }) =>
        message.includes("fix the problem"),
      ),
    ).toBe(false);
  });

  it("treats a workspace-mismatched session as intentional non-participation", async () => {
    const recordedWorkspace = join(agentDir, "recorded-workspace");
    await mkdir(recordedWorkspace);
    const pi = new FakePi(workspace, registerCyclotomy);
    pi.manager = new FakeSessionManager(
      "workspace-mismatch",
      join(agentDir, "workspace-mismatch.jsonl"),
      workspace,
      null,
      recordedWorkspace,
    );
    pi.manager.appendEntry();

    await pi.startSession("resume");
    await pi.runCommand("cyclotomy");
    expect(pi.notifications.at(-1)).toEqual({
      message:
        "Cyclotomy is paused in this Pi instance. Run /cyclotomy resume to start it again.",
      level: "info",
    });

    pi.notifications.length = 0;
    await pi.runCommand("cyclotomy", "resume");
    expect(pi.notifications.at(-1)).toEqual({
      message: "Cyclotomy is unavailable in this session.",
      level: "info",
    });
    expect(
      pi.notifications.some(({ message }) =>
        message.includes("fix the problem"),
      ),
    ).toBe(false);
  });
});
