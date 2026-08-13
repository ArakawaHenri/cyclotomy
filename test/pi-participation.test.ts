import { createHash } from "node:crypto";
import {
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

import { createCurrentMetadataStore } from "../src/infrastructure/metadata.ts";
import { CyclotomyEngine } from "../src/pi/cyclotomy-engine.ts";
import { registerCyclotomy } from "../src/pi/register.ts";
import { CyclotomyRuntime } from "../src/pi/runtime.ts";
import { FakePi } from "./fake-pi.ts";
import { checkpointIsBlocked, checkpointState } from "./metadata-fixture.ts";

let workspace: string;
let agentDir: string;
let storeRoot: string;
let previousAgentDir: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "cyclotomy-participation-ws-"));
  agentDir = await mkdtemp(join(tmpdir(), "cyclotomy-participation-home-"));
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
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

  it("normalizes an undefined handler failure before retiring", async () => {
    const pi = new FakePi(workspace, registerCyclotomy);
    await startTwoNodeSession(pi);
    const dispatch = vi
      .spyOn(CyclotomyEngine.prototype, "dispatch")
      .mockRejectedValueOnce(undefined);

    try {
      await expect(pi.preflightInput("continue normally")).resolves.toBe(
        "continued",
      );
    } finally {
      dispatch.mockRestore();
    }
    await pi.runCommand("cyclotomy");
    expect(pi.notifications.at(-1)?.message).toContain(
      "handler failed without an error value",
    );
  });

  it("stop detaches immediately, drains admitted work, then closes", async () => {
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
        cleanup: { kind: "released" },
      };
    });
    const close = vi.spyOn(CyclotomyRuntime.prototype, "close");
    const inFlight = pi.endTurn(0);
    await started;

    const stopping = pi.runCommand("cyclotomy", "stop");
    await Promise.resolve();
    await expect(pi.preflightInput("after detach")).resolves.toBe("continued");
    expect(close).not.toHaveBeenCalled();

    release();
    await Promise.all([inFlight, stopping]);
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    await expectPiPreparationPasses(pi);
  });

  it("stop supersedes a resume that is waiting for Pi to become idle", async () => {
    const pi = new FakePi(workspace, registerCyclotomy);
    await startTwoNodeSession(pi);
    await pi.runCommand("cyclotomy", "stop");
    let release!: () => void;
    pi.waitForIdleHook = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });

    const resuming = pi.runCommand("cyclotomy", "resume");
    await vi.waitFor(() => expect(pi.waitForIdleCalls).toBe(1));
    const stopping = pi.runCommand("cyclotomy", "stop");
    release();
    await Promise.all([resuming, stopping]);

    await pi.runCommand("cyclotomy");
    expect(pi.notifications.at(-1)?.message).toContain("stopped");
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
    const before = createCurrentMetadataStore(join(storeRoot, "state.db"));
    const saved = checkpointState(before, pi.manager.sessionId, leaf);
    before.close();
    expect(saved).toBeDefined();

    await pi.runCommand("adjunct");
    await pi.runCommand("cyclotomy", "stop");
    const stopped = createCurrentMetadataStore(join(storeRoot, "state.db"));
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
    const after = createCurrentMetadataStore(join(storeRoot, "state.db"));
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
    const db = createCurrentMetadataStore(join(storeRoot, "state.db"));
    expect(checkpointState(db, pi.manager.sessionId, original)).toBeUndefined();
    expect(
      checkpointState(db, pi.manager.sessionId, pi.manager.getLeafId()!),
    ).toBeDefined();
    db.close();
  });
});
