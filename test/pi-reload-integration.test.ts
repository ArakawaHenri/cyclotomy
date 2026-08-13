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

import {
  createCurrentMetadataStore,
  type CurrentMetadataStore,
} from "../src/infrastructure/metadata.ts";
import { registerCyclotomy } from "../src/pi/register.ts";
import { checkpointIsBlocked, checkpointState } from "./metadata-fixture.ts";
import { FakePi, type FakeForkPlan } from "./fake-pi.ts";

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
  await FakePi.disposeAll();
  if (previousPiAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
  }
  await rm(workspace, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

function metadata(): CurrentMetadataStore {
  return createCurrentMetadataStore(join(storeRoot, "state.db"));
}

async function twoStateSession(pi: FakePi) {
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
    const pi = new FakePi(workspace, registerCyclotomy);
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
    expect(
      checkpointState(db, pi.manager.sessionId, failedLeaf),
    ).toBeUndefined();
    db.close();

    await pi.reloadExtension();
    expect(pi.factoryLoads).toBe(2);
    expect(await readFile(join(workspace, "large.bin"))).toEqual(contents);
    db = metadata();
    expect(
      checkpointState(db, pi.manager.sessionId, failedLeaf),
    ).toBeUndefined();
    db.close();
    await pi.endTurn();
    db = metadata();
    expect(
      checkpointState(db, pi.manager.sessionId, pi.manager.getLeafId()!),
    ).toBeDefined();
    db.close();
  });

  it("recovers from an unusable global settings file after a reload", async () => {
    const settingsPath = join(home, "cyclotomy", "settings.json");
    await writeFile(settingsPath, JSON.stringify({ maxFileMiB: -1 }));

    // Pi loads the extension with an unusable configuration. Registration must
    // survive it, so the host keeps running with Cyclotomy disabled.
    const pi = new FakePi(workspace, registerCyclotomy);
    await pi.startSession("startup");
    await writeFile(join(workspace, "a.txt"), "v1");
    await pi.endTurn();
    const disabledLeaf = pi.manager.getLeafId()!;

    expect(
      pi.notifications.some(({ message }) => message.includes("/reload")),
    ).toBe(true);
    // The disabled runtime must not have created the hashed store at all.
    expect(() => metadata()).toThrow();

    await writeFile(
      settingsPath,
      JSON.stringify({ locale: "zh-CN", gc: { intervalMs: 0 } }),
    );
    await pi.reloadExtension();
    expect(pi.factoryLoads).toBe(2);
    // Recovery may inspect existing checkpoints, but never captures or restores.
    expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v1");

    await pi.endTurn();
    const db = metadata();
    expect(
      checkpointState(db, pi.manager.sessionId, disabledLeaf),
    ).toBeUndefined();
    expect(
      checkpointState(db, pi.manager.sessionId, pi.manager.getLeafId()!),
    ).toBeDefined();
    db.close();
  });

  it("keeps a declined node write-protected across reload and cold start", async () => {
    const pi = new FakePi(workspace, registerCyclotomy);
    await pi.startSession("startup");
    await writeFile(join(workspace, "a.txt"), "saved");
    await pi.endTurn();
    const leaf = pi.manager.getLeafId()!;
    let db = metadata();
    const savedState = checkpointState(db, pi.manager.sessionId, leaf)!;
    db.close();
    const persistedSession = pi.manager;
    expect(await pi.resumeTo(pi.newDetachedSession())).toBe("done");
    await writeFile(join(workspace, "a.txt"), "kept-current");
    pi.hasUI = false;

    expect(await pi.resumeTo(persistedSession)).toBe("done");
    db = metadata();
    expect(checkpointIsBlocked(db, pi.manager.sessionId, leaf)).toBe(true);
    expect(checkpointState(db, pi.manager.sessionId, leaf)).toEqual(savedState);
    db.close();

    await pi.reloadExtension();
    await pi.endTurn(0);
    db = metadata();
    expect(checkpointIsBlocked(db, pi.manager.sessionId, leaf)).toBe(true);
    expect(checkpointState(db, pi.manager.sessionId, leaf)).toEqual(savedState);
    db.close();
    expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
      "kept-current",
    );

    await pi.dispose();
    const restarted = new FakePi(
      workspace,
      registerCyclotomy,
      persistedSession,
    );
    restarted.hasUI = false;
    await restarted.startSession("startup");
    await restarted.endTurn(0);

    db = metadata();
    expect(checkpointIsBlocked(db, restarted.manager.sessionId, leaf)).toBe(
      true,
    );
    expect(checkpointState(db, restarted.manager.sessionId, leaf)).toEqual(
      savedState,
    );
    db.close();
    expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
      "kept-current",
    );
  });

  it("does not trust a reload handoff through a disabled runtime", async () => {
    const settingsPath = join(home, "cyclotomy", "settings.json");
    const pi = new FakePi(workspace, registerCyclotomy);
    await pi.startSession("startup");
    await writeFile(join(workspace, "a.txt"), "saved");
    await pi.endTurn();
    const protectedLeaf = pi.manager.getLeafId()!;
    let db = metadata();
    const savedState = checkpointState(
      db,
      pi.manager.sessionId,
      protectedLeaf,
    )!;
    db.close();

    await writeFile(settingsPath, JSON.stringify({ maxFileMiB: -1 }));
    await pi.reloadExtension();
    await writeFile(join(workspace, "a.txt"), "kept-current");
    await writeFile(
      settingsPath,
      JSON.stringify({ locale: "zh-CN", gc: { intervalMs: 0 } }),
    );
    await pi.reloadExtension();

    db = metadata();
    expect(checkpointState(db, pi.manager.sessionId, protectedLeaf)).toEqual(
      savedState,
    );
    expect(checkpointIsBlocked(db, pi.manager.sessionId, protectedLeaf)).toBe(
      true,
    );
    db.close();

    await pi.endTurn();
    const descendant = pi.manager.getLeafId()!;
    db = metadata();
    expect(checkpointState(db, pi.manager.sessionId, protectedLeaf)).toEqual(
      savedState,
    );
    expect(checkpointState(db, pi.manager.sessionId, descendant)).toBeDefined();
    expect(checkpointIsBlocked(db, pi.manager.sessionId, descendant)).toBe(
      false,
    );
    db.close();
    expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
      "kept-current",
    );
  });

  it("copies only retained ancestry and restores the selected state", async () => {
    const pi = new FakePi(workspace, registerCyclotomy);
    const { first, second, sourceSession } = await twoStateSession(pi);

    expect(await pi.fork(first, "at")).toBe("done");
    expect(pi.factoryLoads).toBe(2);
    expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v1");

    const db = metadata();
    expect(checkpointState(db, sourceSession, second)).toBeDefined();
    expect(checkpointState(db, pi.manager.sessionId, first)).toBeDefined();
    expect(checkpointState(db, pi.manager.sessionId, second)).toBeUndefined();
    db.close();
  });

  it("preserves a guarded missing historical node across a real fork replacement", async () => {
    const pi = new FakePi(workspace, registerCyclotomy);
    await pi.startSession("startup");
    const ancestor = pi.manager.appendEntry();
    const descendant = pi.manager.appendEntry();
    await writeFile(join(workspace, "a.txt"), "descendant-workspace");
    await pi.endTurn(0);

    await pi.landUnmanaged(ancestor.id);
    const sourceSessionId = pi.manager.sessionId;
    let db = metadata();
    expect(checkpointState(db, sourceSessionId, ancestor.id)).toBeUndefined();
    expect(checkpointIsBlocked(db, sourceSessionId, ancestor.id)).toBe(true);
    expect(checkpointState(db, sourceSessionId, descendant.id)).toBeDefined();
    db.close();

    expect(await pi.fork(ancestor.id, "at")).toBe("done");
    expect(pi.factoryLoads).toBe(2);
    const forkSessionId = pi.manager.sessionId;
    expect(forkSessionId).not.toBe(sourceSessionId);

    db = metadata();
    expect(checkpointState(db, forkSessionId, ancestor.id)).toBeUndefined();
    expect(checkpointIsBlocked(db, forkSessionId, ancestor.id)).toBe(true);
    db.close();
    expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
      "descendant-workspace",
    );

    await pi.endTurn(0);
    db = metadata();
    expect(checkpointState(db, forkSessionId, ancestor.id)).toBeUndefined();
    expect(checkpointIsBlocked(db, forkSessionId, ancestor.id)).toBe(true);
    db.close();
  });

  it("captures the source and restores confirmed resume targets across runtime replacement", async () => {
    const pi = new FakePi(workspace, registerCyclotomy);
    await pi.startSession("startup");
    await writeFile(join(workspace, "a.txt"), "session-one");
    await pi.endTurn();
    const firstManager = pi.manager;
    const secondManager = pi.newDetachedSession();

    expect(await pi.resumeTo(secondManager)).toBe("done");
    await writeFile(join(workspace, "a.txt"), "session-two");
    await pi.endTurn();
    expect(await pi.resumeTo(firstManager)).toBe("done");
    expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
      "session-one",
    );

    await writeFile(join(workspace, "a.txt"), "session-one-edit");
    expect(await pi.resumeTo(secondManager)).toBe("done");
    expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
      "session-two",
    );
    expect(await pi.resumeTo(firstManager)).toBe("done");
    expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
      "session-one-edit",
    );
  });

  it("never overwrites a different workspace without confirmation after resume replacement", async () => {
    const otherWorkspace = await mkdtemp(
      join(tmpdir(), "cyclotomy-reload-ws-b-"),
    );
    try {
      const pi = new FakePi(workspace, registerCyclotomy);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "session-a");
      await pi.endTurn();
      const managerA = pi.manager;
      const managerB = pi.newDetachedSession(otherWorkspace);

      expect(await pi.resumeTo(managerB)).toBe("done");
      await writeFile(join(otherWorkspace, "b.txt"), "session-b");
      await pi.endTurn();
      expect(await pi.resumeTo(managerA)).toBe("done");
      await writeFile(join(otherWorkspace, "b.txt"), "external-b");

      pi.selectDestructive = false;
      expect(await pi.resumeTo(managerB)).toBe("done");
      expect(await readFile(join(otherWorkspace, "b.txt"), "utf8")).toBe(
        "external-b",
      );

      pi.selectDestructive = true;
      await pi.runCommand("restore");
      expect(await readFile(join(otherWorkspace, "b.txt"), "utf8")).toBe(
        "session-b",
      );
    } finally {
      await rm(otherWorkspace, { recursive: true, force: true });
    }
  });

  it("authenticates a process-gap CLI-style child from its public parent claim", async () => {
    const oldHost = new FakePi(workspace, registerCyclotomy);
    const { first } = await twoStateSession(oldHost);
    const prepared = await oldHost.beginFork(first, "at");
    expect(prepared).not.toBe("cancelled");
    const plan = prepared as FakeForkPlan;
    await oldHost.shutdownForkRuntime(plan);

    const restarted = new FakePi(
      workspace,
      registerCyclotomy,
      plan.nextManager,
    );
    // Pi's initial CLI --fork starts the new runtime with reason `startup`.
    // The child header supplies only the locator; the cold public graph and
    // Cyclotomy source registration still supply the inheritance authority.
    await restarted.startSession("startup");
    expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v1");
    const db = metadata();
    expect(
      checkpointState(db, restarted.manager.sessionId, first),
    ).toBeDefined();
    expect(checkpointIsBlocked(db, restarted.manager.sessionId, first)).toBe(
      false,
    );
    db.close();

    await restarted.runCommand("restore");
    expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v1");
  });

  it("quarantines a fork when its declared parent disappears before startup", async () => {
    const oldHost = new FakePi(workspace, registerCyclotomy);
    const { first } = await twoStateSession(oldHost);
    const prepared = await oldHost.beginFork(first, "at");
    expect(prepared).not.toBe("cancelled");
    const plan = prepared as FakeForkPlan;
    await oldHost.shutdownForkRuntime(plan);
    await rm(plan.previousSessionFile);

    const restarted = new FakePi(
      workspace,
      registerCyclotomy,
      plan.nextManager,
    );
    await restarted.startSession("fork", plan.previousSessionFile);

    expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v2");
    const db = metadata();
    expect(
      checkpointState(db, restarted.manager.sessionId, first),
    ).toBeUndefined();
    expect(checkpointIsBlocked(db, restarted.manager.sessionId, first)).toBe(
      true,
    );
    db.close();
  });

  it("fork copies diverge independently after materialization", async () => {
    const pi = new FakePi(workspace, registerCyclotomy);
    const { first, sourceSession } = await twoStateSession(pi);
    const sourceBefore = metadata();
    const sourceState = checkpointState(sourceBefore, sourceSession, first);
    sourceBefore.close();

    expect(await pi.fork(first, "at")).toBe("done");
    await writeFile(join(workspace, "a.txt"), "fork-only");
    await pi.endTurn();

    const db = metadata();
    expect(checkpointState(db, sourceSession, first)).toEqual(sourceState);
    expect(
      checkpointState(db, pi.manager.sessionId, pi.manager.getLeafId()!)
        ?.treeOid,
    ).not.toBe(sourceState?.treeOid);
    db.close();
  });

  it("fork-before restores the selected entry's parent", async () => {
    const pi = new FakePi(workspace, registerCyclotomy);
    const { first, second } = await twoStateSession(pi);

    expect(await pi.fork(second, "before")).toBe("done");

    expect(pi.manager.getLeafId()).toBe(first);
    expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v1");
    const db = metadata();
    expect(checkpointState(db, pi.manager.sessionId, first)).toBeDefined();
    expect(checkpointState(db, pi.manager.sessionId, second)).toBeUndefined();
    db.close();
  });
});
