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
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MetadataStore } from "../src/infrastructure/metadata.ts";
import { registerCyclotomy } from "../src/pi/register.ts";
import {
  ReloadingFakePi,
  type ReloadingForkPlan,
} from "./reloading-fake-pi.ts";

let workspace: string;
let home: string;
let storeRoot: string;
let previousPiAgentDir: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "cyclotomy-reload-ws-"));
  home = await mkdtemp(join(tmpdir(), "cyclotomy-reload-home-"));
  previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = home;
  await mkdir(join(home, "cyclotomy"));
  await writeFile(
    join(home, "cyclotomy", "settings.json"),
    JSON.stringify({ locale: "zh-CN" }),
  );
  const hash = createHash("sha256")
    .update(await realpath(workspace))
    .digest("hex");
  storeRoot = join(home, "cyclotomy", hash);
});

afterEach(async () => {
  await ReloadingFakePi.disposeAll();
  if (previousPiAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
  }
  await rm(workspace, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

function metadata(): MetadataStore {
  return new MetadataStore(join(storeRoot, "state.db"));
}

async function twoStateSession(pi: ReloadingFakePi) {
  await pi.startSession("startup");
  await writeFile(join(workspace, "a.txt"), "v1");
  await pi.endTurn();
  const first = pi.manager.getLeafId()!;
  await writeFile(join(workspace, "a.txt"), "v2");
  await pi.endTurn();
  const second = pi.manager.getLeafId()!;
  return { first, second, sourceSession: pi.manager.sessionId };
}

describe("Pi runtime replacement", () => {
  it("applies edited settings only after Pi reloads the extension", async () => {
    const settingsPath = join(home, "cyclotomy", "settings.json");
    await writeFile(
      settingsPath,
      JSON.stringify({
        locale: "zh-CN",
        maxFileMiB: 0.001,
        gc: { intervalMs: 0 },
      }),
    );
    const pi = new ReloadingFakePi(workspace, registerCyclotomy);
    await writeFile(
      settingsPath,
      JSON.stringify({
        locale: "zh-CN",
        maxFileMiB: 0.003,
        gc: { intervalMs: 0 },
      }),
    );
    await pi.startSession("startup");
    const contents = Buffer.alloc(2 * 1024, 0x61);
    await writeFile(join(workspace, "large.bin"), contents);

    await pi.endTurn();
    const failedLeaf = pi.manager.getLeafId()!;
    let db = metadata();
    expect(db.getState(pi.manager.sessionId, failedLeaf)).toBeUndefined();
    db.close();

    await pi.reloadExtension();
    expect(pi.factoryLoads).toBe(2);
    expect(await readFile(join(workspace, "large.bin"))).toEqual(contents);
    db = metadata();
    expect(db.getState(pi.manager.sessionId, failedLeaf)).toBeUndefined();
    db.close();
    await pi.endTurn();
    db = metadata();
    expect(db.getState(pi.manager.sessionId, pi.manager.getLeafId()!))
      .toBeDefined();
    db.close();
  });

  it("recovers from an unusable global settings file after a reload", async () => {
    const settingsPath = join(home, "cyclotomy", "settings.json");
    await writeFile(settingsPath, JSON.stringify({ maxFileMiB: -1 }));

    // Pi loads the extension with an unusable configuration. Registration must
    // survive it, so the host keeps running with Cyclotomy disabled.
    const pi = new ReloadingFakePi(workspace, registerCyclotomy);
    await pi.startSession("startup");
    await writeFile(join(workspace, "a.txt"), "v1");
    await pi.endTurn();
    const disabledLeaf = pi.manager.getLeafId()!;

    expect(pi.notifications.some(({ message }) => message.includes("/reload")))
      .toBe(true);
    // The disabled runtime must not have created the hashed store at all.
    expect(() => metadata()).toThrow();

    await writeFile(
      settingsPath,
      JSON.stringify({ locale: "zh-CN", gc: { intervalMs: 0 } }),
    );
    await pi.reloadExtension();
    expect(pi.factoryLoads).toBe(2);
    // Recovery must not reconcile files: reload never scans or restores.
    expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v1");

    await pi.endTurn();
    const db = metadata();
    expect(db.getState(pi.manager.sessionId, disabledLeaf)).toBeUndefined();
    expect(db.getState(pi.manager.sessionId, pi.manager.getLeafId()!))
      .toBeDefined();
    db.close();
  });

  it("copies only retained ancestry and restores the selected state", async () => {
    const pi = new ReloadingFakePi(workspace, registerCyclotomy);
    const { first, second, sourceSession } = await twoStateSession(pi);

    expect(await pi.fork(first, "at")).toBe("done");
    expect(pi.factoryLoads).toBe(2);
    expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v1");

    const db = metadata();
    expect(db.getState(sourceSession, second)).toBeDefined();
    expect(db.getState(pi.manager.sessionId, first)).toBeDefined();
    expect(db.getState(pi.manager.sessionId, second)).toBeUndefined();
    db.close();
  });

  it("survives a process gap using Pi's persisted parentSession header", async () => {
    const oldHost = new ReloadingFakePi(workspace, registerCyclotomy);
    const { first } = await twoStateSession(oldHost);
    const prepared = await oldHost.beginFork(first, "at");
    expect(prepared).not.toBe("cancelled");
    const plan = prepared as ReloadingForkPlan;
    await oldHost.shutdownForkRuntime(plan);

    const restarted = new ReloadingFakePi(
      workspace,
      registerCyclotomy,
      plan.nextManager,
    );
    // Existing startup state is reconciled through the normal confirmation.
    await restarted.startSession("startup");
    expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v1");
    const db = metadata();
    expect(db.getState(restarted.manager.sessionId, first)).toBeDefined();
    db.close();

    await restarted.runCommand("restore");
    expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v1");
  });

  it("fork copies diverge independently after materialization", async () => {
    const pi = new ReloadingFakePi(workspace, registerCyclotomy);
    const { first, sourceSession } = await twoStateSession(pi);
    const sourceBefore = metadata();
    const sourceState = sourceBefore.getState(sourceSession, first);
    sourceBefore.close();

    expect(await pi.fork(first, "at")).toBe("done");
    await writeFile(join(workspace, "a.txt"), "fork-only");
    await pi.endTurn();

    const db = metadata();
    expect(db.getState(sourceSession, first)).toEqual(sourceState);
    expect(db.getState(pi.manager.sessionId, pi.manager.getLeafId()!)?.treeOid)
      .not.toBe(sourceState?.treeOid);
    db.close();
  });

  it("fork-before restores the selected entry's parent", async () => {
    const pi = new ReloadingFakePi(workspace, registerCyclotomy);
    const { first, second } = await twoStateSession(pi);

    expect(await pi.fork(second, "before")).toBe("done");

    expect(pi.manager.getLeafId()).toBe(first);
    expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v1");
    const db = metadata();
    expect(db.getState(pi.manager.sessionId, first)).toBeDefined();
    expect(db.getState(pi.manager.sessionId, second)).toBeUndefined();
    db.close();
  });
});
