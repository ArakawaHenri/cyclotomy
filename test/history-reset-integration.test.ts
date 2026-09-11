import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applySessionHistoryForget,
  previewSessionHistoryForget,
} from "../src/application/history-forget.ts";
import { CyclotomyI18n } from "../src/presentation/i18n.ts";
import { registerCyclotomy } from "../src/pi/register.ts";
import {
  checkpointState,
  createTestCurrentMetadataStore,
} from "./metadata-fixture.ts";
import { FakePi } from "./fake-pi.ts";

let workspace: string;
let home: string;
let storeRoot: string;
let previousPiAgentDir: string | undefined;

/** These tests fix the locale so wording stays a localization-test concern. */
const TEST_I18N = new CyclotomyI18n("zh-CN");

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "cyclotomy-reset-ws-"));
  home = await mkdtemp(join(tmpdir(), "cyclotomy-reset-home-"));
  previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = home;
  await mkdir(join(home, "cyclotomy"));
  await writeFile(
    join(home, "cyclotomy", "settings.json"),
    JSON.stringify({ locale: "zh-CN", gc: { intervalMs: 0 } }),
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

async function sessionHistory(
  sessionId: string,
): Promise<{ readonly epoch: number; readonly resetPending: number }> {
  const db = new DatabaseSync(join(storeRoot, "state.db"), { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT history_epoch AS epoch, reset_pending AS resetPending
         FROM session_history WHERE session_id = ?`,
      )
      .get(sessionId) as {
      readonly epoch: number;
      readonly resetPending: number;
    };
  } finally {
    db.close();
  }
}

function notified(pi: FakePi, text: string): boolean {
  return pi.notifications.some(({ message }) => message.includes(text));
}

describe("history reset across instances", () => {
  it("withdraws the old generation and adopts the new one on reload", async () => {
    const pi = new FakePi(workspace, registerCyclotomy);

    await pi.startSession("startup");
    await writeFile(join(workspace, "a.txt"), "v1");
    await pi.endTurn();
    const sessionId = pi.manager.sessionId;
    const firstLeaf = pi.manager.getLeafId()!;
    expect(await sessionHistory(sessionId)).toEqual({
      epoch: 0,
      resetPending: 0,
    });

    // Another instance forgets this session's history while this engine is idle.
    const preview = await previewSessionHistoryForget(storeRoot, sessionId);
    expect(preview.issues).toEqual([]);
    expect(preview.facts?.slotCount).toBe(1);
    await applySessionHistoryForget(storeRoot, sessionId, preview.planToken!);
    expect(await sessionHistory(sessionId)).toEqual({
      epoch: 1,
      resetPending: 1,
    });

    // The next capture cannot commit under the retired generation, and the
    // engine says so in the history-reset terms instead of retrying.
    pi.notifications.length = 0;
    await writeFile(join(workspace, "a.txt"), "v2");
    await pi.endTurn();
    expect(notified(pi, TEST_I18N.t("captureHistoryReset"))).toBe(true);
    let db = await createTestCurrentMetadataStore(
      join(storeRoot, "state.db"),
      storeRoot,
    );
    expect(
      checkpointState(db, sessionId, pi.manager.getLeafId()!),
    ).toBeUndefined();
    expect(checkpointState(db, sessionId, firstLeaf)).toBeUndefined();
    db.close();

    // A Pi reload is a legal boundary: this registration completes the pending
    // reset with protection rows only, states the outcome, and lets new work
    // checkpoint under the new generation.
    pi.notifications.length = 0;
    await pi.reloadExtension();
    expect(notified(pi, TEST_I18N.t("sessionHistoryResetAttached"))).toBe(true);
    expect(await sessionHistory(sessionId)).toEqual({
      epoch: 1,
      resetPending: 0,
    });

    await writeFile(join(workspace, "a.txt"), "v3");
    await pi.endTurn();
    db = await createTestCurrentMetadataStore(
      join(storeRoot, "state.db"),
      storeRoot,
    );
    const newLeaf = pi.manager.getLeafId()!;
    expect(checkpointState(db, sessionId, newLeaf)).toBeDefined();
    // The forgotten coordinate was not re-imported by the new generation.
    expect(checkpointState(db, sessionId, firstLeaf)).toBeUndefined();
    db.close();
  });

  it("refuses the stale generation when two engines hold the same session", async () => {
    // The first engine keeps running while the forget lands, so its in-memory
    // generation is stale rather than absent.
    const pi = new FakePi(workspace, registerCyclotomy);

    await pi.startSession("startup");
    await writeFile(join(workspace, "a.txt"), "v1");
    await pi.endTurn();
    const sessionId = pi.manager.sessionId;

    const preview = await previewSessionHistoryForget(storeRoot, sessionId);
    await applySessionHistoryForget(storeRoot, sessionId, preview.planToken!);

    // Reopening the same session attaches the new generation without asking
    // again and without restoring the removed coordinate.
    const reopened = new FakePi(workspace, registerCyclotomy, pi.manager);
    await reopened.startSession("reload");
    expect(notified(reopened, TEST_I18N.t("sessionHistoryResetAttached"))).toBe(
      true,
    );
    expect(await sessionHistory(sessionId)).toEqual({
      epoch: 1,
      resetPending: 0,
    });
    await writeFile(join(workspace, "a.txt"), "v2");
    await reopened.endTurn();
    const db = await createTestCurrentMetadataStore(
      join(storeRoot, "state.db"),
      storeRoot,
    );
    expect(
      checkpointState(db, sessionId, reopened.manager.getLeafId()!),
    ).toBeDefined();
    db.close();
  });
});
