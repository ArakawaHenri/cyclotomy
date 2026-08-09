import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MetadataStore } from "../src/infrastructure/metadata.ts";
import {
  openObjectStore,
  type ObjectStore,
} from "../src/infrastructure/object-store.ts";
import { registerCyclotomy } from "../src/pi/register.ts";
import { CyclotomyI18n, type MessageKey } from "../src/pi/i18n.ts";
import { FakePi, FakeSessionManager, type FakeEntry } from "./fake-pi.ts";
import { gitScope } from "./workspace-scope-fixture.ts";

let workspace: string;
let home: string;
let storeRoot: string;
let previousPiAgentDir: string | undefined;
const execFileAsync = promisify(execFile);
/** These tests fix the locale so wording stays a localization-test concern. */
const TEST_I18N = new CyclotomyI18n("zh-CN");

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "cyclotomy-pi-ws-"));
  home = await mkdtemp(join(tmpdir(), "cyclotomy-pi-home-"));
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

function metadata(): MetadataStore {
  return new MetadataStore(join(storeRoot, "state.db"));
}

/**
 * Lifecycle assertions name the message key, never its translation. Wording is
 * a presentation concern owned by the localization tests, so behavior tests
 * must survive a rewrite of either language.
 */
const SENTINEL = "CyclotomyTestSentinel";

function messageFor(key: MessageKey): string {
  // A template's text before its first placeholder identifies the key without
  // depending on the interpolated host detail. The sentinel must survive
  // `formatUiDetail`, which escapes control characters, so it stays ASCII.
  return TEST_I18N.t(key, { message: SENTINEL, preview: SENTINEL }).split(
    SENTINEL,
  )[0]!;
}

function notified(pi: FakePi, key: MessageKey): boolean {
  return pi.notifications.some(({ message }) =>
    message.includes(messageFor(key)),
  );
}

/** Bind a message key to the exact host detail it must interpolate. */
function notifiedWithDetail(
  pi: FakePi,
  key: MessageKey,
  detail: string,
): boolean {
  const rendered = TEST_I18N.t(key, { message: detail });
  return pi.notifications.some(({ message }) => message.includes(rendered));
}

/**
 * Assert on text Cyclotomy emits verbatim in every locale: paths, setting
 * names, command names, and preview action lines.
 */
function notifiedVerbatim(pi: FakePi, text: string): boolean {
  return pi.notifications.some(({ message }) => message.includes(text));
}

function lastStatus(pi: FakePi): string | undefined {
  return pi.statuses.get("cyclotomy");
}

async function spyOnReadTree() {
  const store = await openObjectStore(storeRoot);
  return vi.spyOn(
    Object.getPrototypeOf(store) as Pick<ObjectStore, "readTree">,
    "readTree",
  );
}

async function twoStates(pi: FakePi) {
  await pi.startSession("startup");
  await writeFile(join(workspace, "a.txt"), "v1");
  await pi.endTurn();
  const first = pi.manager.getLeafId()!;
  await writeFile(join(workspace, "a.txt"), "v2");
  await pi.endTurn();
  const second = pi.manager.getLeafId()!;
  return { first, second };
}

describe("single-state Pi lifecycle", () => {
  describe("registration and configuration", () => {
    it("registers only the two top-level commands", () => {
      const pi = new FakePi(workspace);

      registerCyclotomy(pi.api);

      expect(pi.registeredCommandNames()).toEqual(["drift", "restore"]);
      expect(pi.registeredCommandNames()).not.toContain("cyclotomy");
    });

    it("refuses control data that overlaps the workspace", async () => {
      await writeFile(
        join(home, "cyclotomy", "settings.json"),
        JSON.stringify({
          storageDir: workspace,
          locale: "zh-CN",
          gc: { intervalMs: 0 },
        }),
      );
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      pi.manager.appendEntry();
      await writeFile(join(workspace, "user.txt"), "untouched");

      await pi.startSession("startup");

      expect(notified(pi, "initFailure")).toBe(true);
      expect(await readFile(join(workspace, "user.txt"), "utf8")).toBe(
        "untouched",
      );
      await expect(
        stat(join(workspace, basename(storeRoot))),
      ).rejects.toThrow();
    });

    it("fails closed with an actionable invalid workspace-settings error", async () => {
      await mkdir(storeRoot, { recursive: true });
      await writeFile(
        join(storeRoot, "settings.json"),
        JSON.stringify({ misspelledLimit: 1 }),
      );
      await writeFile(join(workspace, "user.txt"), "untouched");
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);

      await pi.startSession("startup");

      expect(notified(pi, "initFailure")).toBe(true);
      // Paths and setting names appear verbatim in every locale.
      expect(notifiedVerbatim(pi, "settings.json")).toBe(true);
      expect(notifiedVerbatim(pi, "misspelledLimit")).toBe(true);
      expect(notifiedVerbatim(pi, "/reload")).toBe(true);
      expect(await readFile(join(workspace, "user.txt"), "utf8")).toBe(
        "untouched",
      );
      await expect(stat(join(storeRoot, "state.db"))).rejects.toThrow();
      await expect(stat(join(storeRoot, "objects"))).rejects.toThrow();
    });

    it("disables itself instead of failing Pi's extension load", async () => {
      // Pi exits when an extension factory throws, so an unusable global file
      // must leave the host fully working with checkpointing turned off.
      await writeFile(
        join(home, "cyclotomy", "settings.json"),
        JSON.stringify({ maxFileMiB: -1 }),
      );
      await writeFile(join(workspace, "user.txt"), "untouched");
      const pi = new FakePi(workspace);

      expect(() => registerCyclotomy(pi.api)).not.toThrow();
      expect(pi.registeredCommandNames()).toEqual(["drift", "restore"]);

      pi.manager.appendEntry();
      await pi.startSession("startup");

      // A rejected global file discards its locale, so this runtime reports in
      // the auto-detected language. Assert only on verbatim text.
      expect(notifiedVerbatim(pi, "settings.json")).toBe(true);
      expect(notifiedVerbatim(pi, "maxFileMiB")).toBe(true);
      expect(notifiedVerbatim(pi, "/reload")).toBe(true);

      // A completed turn must neither throw nor record any checkpoint.
      await expect(pi.endTurn()).resolves.toBeUndefined();
      await expect(stat(storeRoot)).rejects.toThrow();

      // Explicit commands still answer with the actionable configuration detail
      // rather than a blocked-session identity message.
      pi.notifications.length = 0;
      await pi.runCommand("drift");
      await pi.runCommand("restore");
      expect(pi.notifications).toHaveLength(2);
      expect(notifiedVerbatim(pi, "maxFileMiB")).toBe(true);
      expect(notified(pi, "sessionIdentityUnavailable")).toBe(false);

      expect(await readFile(join(workspace, "user.txt"), "utf8")).toBe(
        "untouched",
      );
    });
  });

  describe("session start, reload, and turn capture", () => {
    it("materializes the first observed concrete startup node and reload stays read-only", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await writeFile(join(workspace, "a.txt"), "incoming");
      const leaf = pi.manager.appendEntry();

      await pi.startSession("startup");
      let db = metadata();
      expect(db.getState(pi.manager.sessionId, leaf.id)).toBeDefined();
      db.close();
      await pi.endTurn(0);
      db = metadata();
      const saved = db.getState(pi.manager.sessionId, leaf.id);
      db.close();
      await writeFile(join(workspace, "a.txt"), "external");
      await pi.startSession("reload");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("external");
      db = metadata();
      expect(db.getState(pi.manager.sessionId, leaf.id)).toEqual(saved);
      db.close();
    });

    it.each(["startup", "new", "resume", "fork"] as const)(
      "%s materializes a genuine missing concrete anchor",
      async (reason) => {
        const pi = new FakePi(workspace);
        registerCyclotomy(pi.api);
        const leaf = pi.manager.appendEntry();
        await writeFile(join(workspace, "a.txt"), reason);

        await pi.startSession(reason);

        const db = metadata();
        expect(db.getState(pi.manager.sessionId, leaf.id)).toBeDefined();
        db.close();
        expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(reason);
      },
    );

    it("does not invent a node for an empty session or materialize on reload", async () => {
      const empty = new FakePi(workspace);
      registerCyclotomy(empty.api);
      await writeFile(join(workspace, "a.txt"), "empty");
      await empty.startSession("startup");
      let db = metadata();
      expect(db.listReferencedTreeOids()).toEqual([]);
      db.close();

      const leaf = empty.manager.appendEntry();
      await empty.startSession("reload");
      db = metadata();
      expect(db.getState(empty.manager.sessionId, leaf.id)).toBeUndefined();
      db.close();
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("empty");
    });

    it("anchors a missing active label at its stable parent", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const parent = pi.manager.appendEntry();
      const label = pi.manager.appendEntry({ type: "label" });
      await writeFile(join(workspace, "a.txt"), "label-state");

      await pi.startSession("startup");

      const db = metadata();
      expect(db.getState(pi.manager.sessionId, parent.id)).toBeDefined();
      expect(db.getState(pi.manager.sessionId, label.id)).toBeUndefined();
      db.close();
    });

    it("keeps an inherited cold-start location exact-slotless", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "ancestor-state");
      await pi.endTurn();
      const ancestor = pi.manager.getLeafId()!;
      const child = pi.manager.appendEntry();
      await writeFile(join(workspace, "a.txt"), "incoming-current");

      await pi.startSession("resume");

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "ancestor-state",
      );
      const db = metadata();
      expect(db.getState(pi.manager.sessionId, ancestor)).toBeDefined();
      expect(db.getState(pi.manager.sessionId, child.id)).toBeUndefined();
      db.close();
    });

    it("does not materialize malformed startup ancestry", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const first = pi.manager.appendEntry();
      const second = pi.manager.appendEntry();
      pi.manager.entries.set(first.id, { ...first, parentId: second.id });
      await writeFile(join(workspace, "a.txt"), "unowned");

      await pi.startSession("startup");

      const db = metadata();
      expect(db.getState(pi.manager.sessionId, first.id)).toBeUndefined();
      expect(db.getState(pi.manager.sessionId, second.id)).toBeUndefined();
      db.close();
      expect(
        notifiedWithDetail(
          pi,
          "restoreFailed",
          "session ancestry contains a cycle",
        ),
      ).toBe(true);
    });

    it("does not accept metadata ancestry that references an unknown entry", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const leaf = pi.manager.appendEntry();
      pi.manager.entries.set(leaf.id, {
        ...leaf,
        parentId: "missing-parent",
      });

      await pi.startSession("startup");

      const db = metadata();
      expect(db.getState(pi.manager.sessionId, leaf.id)).toBeUndefined();
      db.close();
      expect(
        notifiedWithDetail(
          pi,
          "restoreFailed",
          'session ancestry references an unknown node "missing-parent"',
        ),
      ).toBe(true);
    });

    it("startup asks before reconciling an existing node", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      await writeFile(join(workspace, "a.txt"), "current");

      pi.selectDestructive = false;
      await pi.startSession("startup");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("current");
      expect(pi.selections.at(-1)?.prompt).toContain(
        messageFor("choiceLoadedTitle"),
      );
      // The non-destructive choice must stay first and be Pi's initial pick.
      expect(pi.selections.at(-1)?.options).toEqual([
        messageFor("choiceLoadedSafe"),
        messageFor("choiceLoadedRestore"),
      ]);

      pi.selectDestructive = true;
      await pi.startSession("startup");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("saved");
    });

    it("does not restore a loaded session if the agent becomes busy in the dialog", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      await writeFile(join(workspace, "a.txt"), "current");
      pi.selectHook = async () => {
        pi.idle = false;
      };

      await pi.startSession("startup");

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("current");
      // Becoming busy invalidates the confirmed plan, so the apply phase reports
      // a changed location rather than a user cancellation.
      expect(notified(pi, "commandLocationChanged")).toBe(true);
    });

    it("turn_end overwrites the active node's only state", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "one");
      const leaf = pi.manager.appendEntry();
      await pi.endTurn(0);
      let db = metadata();
      const first = db.getState(pi.manager.sessionId, leaf.id)!;
      db.close();

      await writeFile(join(workspace, "a.txt"), "two");
      await pi.endTurn(0);
      db = metadata();
      const second = db.getState(pi.manager.sessionId, leaf.id)!;
      db.close();
      expect(second.treeOid).not.toBe(first.treeOid);
    });

    it("does not commit a turn capture after the active leaf changes", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "one");
      const capturedLeaf = pi.manager.appendEntry();
      await pi.endTurn(0);
      let db = metadata();
      const original = db.getState(pi.manager.sessionId, capturedLeaf.id)!;
      db.close();

      await writeFile(join(workspace, "a.txt"), "two");
      const store = await openObjectStore(storeRoot);
      const prototype = Object.getPrototypeOf(store) as {
        beginSnapshotPublication: ObjectStore["beginSnapshotPublication"];
      };
      const beginSnapshotPublication = prototype.beginSnapshotPublication;
      let advancedLeaf: FakeEntry | undefined;
      const publication = vi
        .spyOn(prototype, "beginSnapshotPublication")
        .mockImplementation(function (this: ObjectStore) {
          const candidate = beginSnapshotPublication.call(this);
          return {
            ...candidate,
            async publishTree(entries, scope) {
              const treeOid = await candidate.publishTree(entries, scope);
              advancedLeaf = pi.manager.appendEntry();
              return treeOid;
            },
          };
        });
      try {
        await pi.endTurn(0);
      } finally {
        publication.mockRestore();
      }

      expect(advancedLeaf).toBeDefined();
      db = metadata();
      expect(db.getState(pi.manager.sessionId, capturedLeaf.id)).toEqual(
        original,
      );
      expect(
        db.getState(pi.manager.sessionId, advancedLeaf!.id),
      ).toBeUndefined();
      db.close();
      expect(notified(pi, "captureLaterFailed")).toBe(true);
    });
  });

  describe("the /drift and /restore command surface", () => {
    it("fails closed in preview when a manifest smuggles an ignored target entry", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      const leaf = pi.manager.appendEntry();
      const targetPath = join(workspace, "secret.txt");
      const targetBytes = Buffer.from("forged target", "utf8");
      const blobOid = createHash("sha256").update(targetBytes).digest("hex");
      await writeFile(targetPath, targetBytes);
      const store = await openObjectStore(storeRoot);
      const publication = store.beginSnapshotPublication();
      await publication.publishBlobFromFile(
        targetPath,
        blobOid,
        targetBytes.byteLength,
      );
      const treeOid = await publication.publishTree(
        [
          {
            path: "secret.txt",
            type: "regular",
            blobOid,
            recreationMode: 0o600,
          },
        ],
        gitScope({ globalExclude: "secret.txt\n" }),
      );
      await rm(targetPath);
      const db = metadata();
      db.setState(pi.manager.sessionId, leaf.id, treeOid);
      db.close();
      const selectionsBefore = pi.selections.length;

      await pi.runCommand("drift");
      expect(
        notifiedWithDetail(
          pi,
          "commandFailed",
          "tree entry is excluded by its archived workspace scope: secret.txt",
        ),
      ).toBe(true);

      await pi.runCommand("restore");
      expect(
        notifiedWithDetail(
          pi,
          "restorePrepareFailed",
          "tree entry is excluded by its archived workspace scope: secret.txt",
        ),
      ).toBe(true);
      expect(pi.selections).toHaveLength(selectionsBefore);
      await expect(stat(targetPath)).rejects.toThrow();
    });

    it("reports drift without confirming or changing files or metadata", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      const leaf = pi.manager.getLeafId()!;
      const before = metadata();
      const stateBefore = before.getState(pi.manager.sessionId, leaf);
      const sessionsBefore = before.listRegisteredSessions();
      const rootsBefore = before.listReferencedTreeOids();
      before.close();
      await writeFile(join(workspace, "a.txt"), "current");
      const selectionsBefore = pi.selections.length;

      await pi.runCommand("drift");

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("current");
      expect(pi.selections).toHaveLength(selectionsBefore);
      const driftMessage = pi.notifications.at(-1)?.message ?? "";
      expect(driftMessage).toContain("~ a.txt");
      expect(driftMessage).not.toMatch(
        /(?:session|entry|tree OID|\+0|~0|-0)/iu,
      );
      const after = metadata();
      expect(after.getState(pi.manager.sessionId, leaf)).toEqual(stateBefore);
      expect(after.listRegisteredSessions()).toEqual(sessionsBefore);
      expect(after.listReferencedTreeOids()).toEqual(rootsBefore);
      after.close();
    });

    it("uses the checkpoint scope when Git ignoreCase drifts", async () => {
      await execFileAsync("git", ["-C", workspace, "init", "-q"]);
      await execFileAsync("git", [
        "-C",
        workspace,
        "config",
        "core.ignoreCase",
        "false",
      ]);
      await writeFile(join(workspace, ".gitignore"), "SECRET\n");
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await pi.endTurn();

      await execFileAsync("git", [
        "-C",
        workspace,
        "config",
        "core.ignoreCase",
        "true",
      ]);
      await writeFile(join(workspace, "secret"), "must be visible to target");

      await pi.runCommand("drift");
      expect(pi.notifications.at(-1)?.message).toContain("- secret");
      await pi.runCommand("restore");

      await expect(stat(join(workspace, "secret"))).rejects.toThrow();
    });

    it("restores a changed .gitignore through the checkpoint's original scope", async () => {
      await execFileAsync("git", ["-C", workspace, "init", "-q"]);
      await writeFile(join(workspace, ".gitignore"), "ignored.txt\n");
      await writeFile(join(workspace, "visible.txt"), "saved");
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await pi.endTurn();

      await writeFile(join(workspace, ".gitignore"), "visible.txt\n");
      await writeFile(join(workspace, "visible.txt"), "current");
      await writeFile(join(workspace, "ignored.txt"), "outside target scope");

      await pi.runCommand("drift");
      expect(pi.notifications.at(-1)?.message).toContain("~ .gitignore");
      expect(pi.notifications.at(-1)?.message).toContain("~ visible.txt");
      expect(pi.notifications.at(-1)?.message).not.toContain("ignored.txt");

      await pi.runCommand("restore");

      expect(await readFile(join(workspace, ".gitignore"), "utf8")).toBe(
        "ignored.txt\n",
      );
      expect(await readFile(join(workspace, "visible.txt"), "utf8")).toBe(
        "saved",
      );
      expect(await readFile(join(workspace, "ignored.txt"), "utf8")).toBe(
        "outside target scope",
      );
    });

    it("rejects non-empty drift arguments without changing state", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      const leaf = pi.manager.getLeafId()!;
      const before = metadata();
      const stateBefore = before.getState(pi.manager.sessionId, leaf);
      const sessionsBefore = before.listRegisteredSessions();
      const rootsBefore = before.listReferencedTreeOids();
      before.close();
      await writeFile(join(workspace, "a.txt"), "current");
      const selectionsBefore = pi.selections.length;
      pi.statuses.set("cyclotomy", "stale navigation notice");

      await pi.runCommand("drift", "unexpected");

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("current");
      expect(pi.selections).toHaveLength(selectionsBefore);
      expect(pi.notifications.at(-1)?.message).toBe(messageFor("driftUsage"));
      expect(lastStatus(pi)).toBe("stale navigation notice");
      const after = metadata();
      expect(after.getState(pi.manager.sessionId, leaf)).toEqual(stateBefore);
      expect(after.listRegisteredSessions()).toEqual(sessionsBefore);
      expect(after.listReferencedTreeOids()).toEqual(rootsBefore);
      after.close();
    });

    it("refuses restore while busy without confirming or changing state", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      const leaf = pi.manager.getLeafId()!;
      const before = metadata();
      const stateBefore = before.getState(pi.manager.sessionId, leaf);
      const sessionsBefore = before.listRegisteredSessions();
      const rootsBefore = before.listReferencedTreeOids();
      before.close();
      await writeFile(join(workspace, "a.txt"), "current");
      const selectionsBefore = pi.selections.length;
      pi.idle = false;

      await pi.runCommand("restore");

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("current");
      expect(pi.selections).toHaveLength(selectionsBefore);
      expect(pi.notifications.at(-1)?.message).toBe(
        messageFor("waitIdleRestore"),
      );
      const after = metadata();
      expect(after.getState(pi.manager.sessionId, leaf)).toEqual(stateBefore);
      expect(after.listRegisteredSessions()).toEqual(sessionsBefore);
      expect(after.listReferencedTreeOids()).toEqual(rootsBefore);
      after.close();
    });

    it("manual restore discards changes without creating another history", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      const leaf = pi.manager.getLeafId()!;
      const dbBefore = metadata();
      const stateBefore = dbBefore.getState(pi.manager.sessionId, leaf)!;
      dbBefore.close();
      await writeFile(join(workspace, "a.txt"), "unsaved");

      await pi.runCommand("restore");

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("saved");
      expect(pi.selections.at(-1)?.prompt).toContain(
        messageFor("choiceManualIntro"),
      );
      expect(pi.selections.at(-1)?.options).toEqual([
        messageFor("choiceManualSafe"),
        messageFor("choiceManualRestore"),
      ]);
      expect(
        pi.selections.at(-1)?.prompt.split("\n").length,
      ).toBeLessThanOrEqual(10);
      const dbAfter = metadata();
      expect(dbAfter.getState(pi.manager.sessionId, leaf)).toEqual(stateBefore);
      dbAfter.close();
      await writeFile(join(workspace, "a.txt"), "still-current");
      await pi.runCommand("restore", "--force");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "still-current",
      );
      expect(pi.notifications.at(-1)?.message).toContain("/restore");
    });

    it("authenticates a confirmed restore once per user-separated phase", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      await writeFile(join(workspace, "a.txt"), "current");
      const readTree = await spyOnReadTree();

      try {
        await pi.runCommand("restore");

        expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("saved");
        expect(readTree).toHaveBeenCalledTimes(2);
      } finally {
        readTree.mockRestore();
      }
    });

    it("safe choice, Escape, unknown UI values, and no UI leave files unchanged", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      await writeFile(join(workspace, "a.txt"), "current");
      pi.selectDestructive = false;
      await pi.runCommand("restore");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("current");

      pi.selectionOverride = null;
      await pi.runCommand("restore");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("current");

      pi.selectionOverride = "unexpected RPC value";
      await pi.runCommand("restore");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("current");

      pi.selectionOverride = undefined;
      pi.hasUI = false;
      pi.mode = "print";
      pi.selectDestructive = true;
      const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await pi.runCommand("restore");
        expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
          "current",
        );
        expect(stderr).toHaveBeenCalledWith(
          expect.stringContaining(messageFor("restoreNeedsUi")),
        );
      } finally {
        stderr.mockRestore();
      }
    });

    it("reports print-mode reconciliation and keeps its current-wins capture semantics", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      const leaf = pi.manager.getLeafId()!;
      const before = metadata();
      const savedOid = before.getState(pi.manager.sessionId, leaf)!.treeOid;
      before.close();
      await writeFile(join(workspace, "a.txt"), "current");
      pi.mode = "print";
      pi.hasUI = false;
      const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        await pi.startSession("resume");
        const unchanged = metadata();
        expect(unchanged.getState(pi.manager.sessionId, leaf)?.treeOid).toBe(
          savedOid,
        );
        unchanged.close();
        expect(stderr).toHaveBeenCalledWith(
          expect.stringContaining(messageFor("sessionRestoreNeedsUi")),
        );

        expect(await pi.submitInput()).toBe("continued");
        const accepted = metadata();
        expect(accepted.getState(pi.manager.sessionId, leaf)?.treeOid).not.toBe(
          savedOid,
        );
        accepted.close();
      } finally {
        stderr.mockRestore();
      }
    });

    it("defers loaded-session choice until RPC startup has completed", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      await writeFile(join(workspace, "a.txt"), "current");
      pi.mode = "rpc";
      const selectionsBefore = pi.selections.length;

      await pi.startSession("resume");

      expect(pi.selections).toHaveLength(selectionsBefore);
      expect(notified(pi, "sessionRestoreDeferredRpc")).toBe(true);
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("current");

      await pi.runCommand("restore");
      expect(pi.selections).toHaveLength(selectionsBefore + 1);
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("saved");
    });

    it("keeps loaded-session reconciliation fail-closed when confirm rejects", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      await writeFile(join(workspace, "a.txt"), "current");
      pi.selectHook = async () => {
        throw new Error("confirmation transport failed");
      };

      await expect(pi.startSession("resume")).resolves.toBeUndefined();

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("current");
      expect(
        notifiedWithDetail(
          pi,
          "restoreFailed",
          "confirmation transport failed",
        ),
      ).toBe(true);
    });

    it("invalidates confirmation when the workspace changes under the dialog", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      await writeFile(join(workspace, "a.txt"), "previewed");
      pi.selectHook = async () => {
        await writeFile(join(workspace, "a.txt"), "changed-during-confirm");
      };

      await pi.runCommand("restore");

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "changed-during-confirm",
      );
      expect(notified(pi, "commandPreviewStale")).toBe(true);
    });

    it("invalidates confirmation when a closer node state appears", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first, second } = await twoStates(pi);
      expect(await pi.navigate(first)).toBe("done");
      const child = pi.manager.appendEntry();
      await writeFile(join(workspace, "a.txt"), "unsaved-child");
      const db = metadata();
      const alternate = db.getState(pi.manager.sessionId, second)!;
      db.close();
      pi.selectHook = async () => {
        const concurrent = metadata();
        concurrent.setState(pi.manager.sessionId, child.id, alternate.treeOid);
        concurrent.close();
      };

      await pi.runCommand("restore");

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "unsaved-child",
      );
      expect(notified(pi, "commandTargetChanged")).toBe(true);
    });
  });

  describe("tree navigation preparation", () => {
    it("round-trips tree nodes and assigns manual edits to the source", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first, second } = await twoStates(pi);

      expect(await pi.navigate(first)).toBe("done");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v1");
      expect(lastStatus(pi)).toBeUndefined();
      await writeFile(join(workspace, "a.txt"), "branch-edit");
      expect(await pi.navigate(second)).toBe("done");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v2");
      expect(await pi.navigate(first)).toBe("done");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "branch-edit",
      );
    });

    it("authenticates navigation once in each real trust phase", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first } = await twoStates(pi);
      const db = metadata();
      const targetTreeOid = db.getState(pi.manager.sessionId, first)!.treeOid;
      db.close();
      const readTree = await spyOnReadTree();

      try {
        expect(await pi.navigate(first)).toBe("done");

        expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v1");
        expect(readTree).toHaveBeenCalledTimes(3);
        expect(readTree.mock.calls.map(([treeOid]) => treeOid)).toEqual([
          targetTreeOid,
          targetTreeOid,
          targetTreeOid,
        ]);
      } finally {
        readTree.mockRestore();
      }
    });

    it("does not checkpoint the source when navigation is declined", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first, second } = await twoStates(pi);
      const before = metadata();
      const sourceBefore = before.getState(pi.manager.sessionId, second)!;
      before.close();
      await writeFile(join(workspace, "a.txt"), "declined-edit");
      pi.selectDestructive = false;

      expect(await pi.navigate(first)).toBe("cancelled");

      expect(pi.manager.getLeafId()).toBe(second);
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "declined-edit",
      );
      const after = metadata();
      expect(after.getState(pi.manager.sessionId, second)).toEqual(
        sourceBefore,
      );
      after.close();
    });

    it("captures safely even when selecting a child prompt leaves the leaf unchanged", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      const source = pi.manager.getLeafId()!;
      const childPrompt = pi.manager.appendEntry({
        type: "message",
        message: { role: "user" },
      });
      pi.manager.setLeaf(source);
      const before = metadata();
      const sourceBefore = before.getState(pi.manager.sessionId, source)!;
      before.close();
      await writeFile(join(workspace, "a.txt"), "editor-no-op");

      expect(await pi.navigate(childPrompt.id)).toBe("done");

      expect(pi.manager.getLeafId()).toBe(source);
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "editor-no-op",
      );
      const after = metadata();
      expect(after.getState(pi.manager.sessionId, source)?.treeOid).not.toBe(
        sourceBefore.treeOid,
      );
      after.close();
    });

    it("captures the source when the same landing gains a summary or label wrapper", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      const source = pi.manager.getLeafId()!;
      const childPrompt = pi.manager.appendEntry({
        type: "message",
        message: { role: "user" },
      });
      pi.manager.setLeaf(source);
      const before = metadata();
      const sourceBefore = before.getState(pi.manager.sessionId, source)!;
      before.close();
      await writeFile(join(workspace, "a.txt"), "wrapped-movement");

      expect(await pi.prepareNavigation(childPrompt.id)).toBe("ready");
      await pi.commitPreparedSummary(childPrompt.id, true);

      const after = metadata();
      expect(after.getState(pi.manager.sessionId, source)?.treeOid).not.toBe(
        sourceBefore.treeOid,
      );
      after.close();
    });

    it("fails closed when navigation confirmation or notification UI throws", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first, second } = await twoStates(pi);
      await writeFile(join(workspace, "a.txt"), "still-current");
      pi.selectHook = async () => {
        throw new Error("test confirmation teardown");
      };
      pi.notifyThrows = true;

      expect(await pi.navigate(first)).toBe("cancelled");

      expect(pi.manager.getLeafId()).toBe(second);
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "still-current",
      );
    });

    it("cancels navigation if the agent becomes busy during confirmation", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first, second } = await twoStates(pi);
      await writeFile(join(workspace, "a.txt"), "still-current");
      pi.selectHook = async () => {
        pi.idle = false;
      };

      expect(await pi.navigate(first)).toBe("cancelled");

      expect(pi.manager.getLeafId()).toBe(second);
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "still-current",
      );
    });

    it("cancels navigation when a non-null source entry is unreadable", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first, second } = await twoStates(pi);
      const before = metadata();
      const sourceBefore = before.getState(pi.manager.sessionId, second)!;
      before.close();
      pi.manager.entries.delete(second);
      await writeFile(join(workspace, "a.txt"), "unowned-edit");

      expect(await pi.navigate(first)).toBe("cancelled");

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "unowned-edit",
      );
      const after = metadata();
      expect(after.getState(pi.manager.sessionId, second)).toEqual(
        sourceBefore,
      );
      after.close();
    });

    it("cancels navigation when an active label has no readable parent", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first } = await twoStates(pi);
      const brokenLabel: FakeEntry = {
        id: "broken-label",
        parentId: "missing-parent",
        timestamp: new Date().toISOString(),
        type: "label",
      };
      pi.manager.entries.set(brokenLabel.id, brokenLabel);
      pi.manager.setLeaf(brokenLabel.id);
      await writeFile(join(workspace, "a.txt"), "unowned-label-edit");

      expect(await pi.navigate(first)).toBe("cancelled");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "unowned-label-edit",
      );
    });

    it("fails closed when Pi session context access throws", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first } = await twoStates(pi);
      const target = pi.newDetachedSession();
      pi.sessionContextThrows = true;
      let bashRan = false;

      expect(await pi.navigate(first)).toBe("cancelled");
      expect(await pi.compact()).toBe("cancelled");
      expect(await pi.fork(first)).toBe("cancelled");
      expect(await pi.resumeTo(target)).toBe("cancelled");
      expect(await pi.submitInput()).toBe("handled");
      await pi.executeUserBash("must-not-run", async () => {
        bashRan = true;
      });
      expect(bashRan).toBe(false);
    });

    it("rejects a reentrant tree request while the first preview is open", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first } = await twoStates(pi);
      let nested: "done" | "cancelled" | undefined;
      pi.selectHook = async () => {
        pi.selectHook = undefined;
        nested = await pi.navigate(first);
      };

      expect(await pi.navigate(first)).toBe("done");

      expect(nested).toBe("cancelled");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v1");
    });

    it("cancels tree, fork, and switch requests while the agent is busy", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first, second } = await twoStates(pi);
      const target = pi.newDetachedSession();
      pi.idle = false;

      expect(await pi.navigate(first)).toBe("cancelled");
      expect(await pi.fork(first)).toBe("cancelled");
      expect(await pi.resumeTo(target)).toBe("cancelled");
      expect(pi.manager.getLeafId()).toBe(second);
    });

    it("lets a missing descendant inherit the source state being captured", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "source-old");
      await pi.endTurn();
      const source = pi.manager.getLeafId()!;
      const child = pi.manager.appendEntry();
      pi.manager.setLeaf(source);
      await writeFile(join(workspace, "a.txt"), "source-current");
      const selectionsBefore = pi.selections.length;

      expect(await pi.navigate(child.id)).toBe("done");

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "source-current",
      );
      expect(pi.selections).toHaveLength(selectionsBefore);
      const db = metadata();
      expect(db.getState(pi.manager.sessionId, source)).toBeDefined();
      expect(db.getState(pi.manager.sessionId, child.id)).toBeUndefined();
      db.close();
    });

    it("accepts Pi's summary-plus-label wrappers without inventing snapshots", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first } = await twoStates(pi);

      expect(await pi.prepareNavigation(first)).toBe("ready");
      const summary = await pi.commitPreparedSummary(first, true);
      const label = pi.manager.getLeafId()!;

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v1");
      const db = metadata();
      expect(db.getState(pi.manager.sessionId, summary)).toBeUndefined();
      expect(db.getState(pi.manager.sessionId, label)).toBeUndefined();
      db.close();
    });

    it("anchors label-active captures at a stable parent across Pi's fork rewrite", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first } = await twoStates(pi);
      expect(await pi.prepareNavigation(first)).toBe("ready");
      const summary = await pi.commitPreparedSummary(first, true);
      const oldLabel = pi.manager.getLeafId()!;
      await writeFile(join(workspace, "a.txt"), "edited-at-label");

      expect(await pi.submitInput()).toBe("continued");

      let sourceDb = metadata();
      expect(sourceDb.getState(pi.manager.sessionId, oldLabel)).toBeUndefined();
      expect(sourceDb.getState(pi.manager.sessionId, summary)).toBeDefined();
      sourceDb.close();

      // Pi removes label entries, re-chains retained entries, and appends labels
      // with new ids when it creates a forked session.
      const source = pi.manager;
      const retained = [];
      let cursor: string | null = summary;
      while (cursor !== null) {
        const entry: FakeEntry = source.getEntry(cursor)!;
        retained.push(entry);
        cursor = entry.parentId;
      }
      retained.reverse();
      const fork = new FakeSessionManager(
        "fork-rewritten",
        "/sessions/fork-rewritten.jsonl",
        workspace,
        source.getSessionFile()!,
      );
      let parentId: string | null = null;
      for (const entry of retained) {
        if (entry.type === "label") continue;
        fork.entries.set(entry.id, { ...entry, parentId });
        parentId = entry.id;
      }
      const newLabel = {
        id: "rewritten-label",
        parentId,
        timestamp: new Date().toISOString(),
        type: "label" as const,
      };
      fork.entries.set(newLabel.id, newLabel);
      fork.setLeaf(newLabel.id);
      pi.manager = fork;
      await pi.startSession("fork", source.getSessionFile());
      await writeFile(join(workspace, "a.txt"), "fork-drift");

      await pi.runCommand("restore");

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "edited-at-label",
      );
      sourceDb = metadata();
      expect(sourceDb.getState(fork.sessionId, summary)).toBeDefined();
      expect(sourceDb.getState(fork.sessionId, newLabel.id)).toBeUndefined();
      sourceDb.close();
    });
  });

  describe("tree navigation arrival and commit", () => {
    it("leaves a harmless source capture when a later tree hook cancels", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first, second } = await twoStates(pi);
      const before = metadata();
      const sourceBefore = before.getState(pi.manager.sessionId, second)!;
      before.close();
      await writeFile(join(workspace, "a.txt"), "cancelled-by-later-hook");
      pi.api.on("session_before_tree", async () => ({ cancel: true }));

      expect(await pi.navigate(first)).toBe("cancelled");

      const after = metadata();
      expect(after.getState(pi.manager.sessionId, second)?.treeOid).not.toBe(
        sourceBefore.treeOid,
      );
      after.close();
    });

    it("retires an orphaned tree plan without requiring a reload", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first } = await twoStates(pi);
      let vetoOnce = true;
      pi.api.on("session_before_tree", async () => {
        if (!vetoOnce) return undefined;
        vetoOnce = false;
        return { cancel: true };
      });

      expect(await pi.navigate(first)).toBe("cancelled");
      // The retry retires the harmless orphan and proceeds in one attempt.
      expect(await pi.navigate(first)).toBe("done");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v1");
    });

    it("never attributes an earlier arrival handler's target edit to source", async () => {
      const pi = new FakePi(workspace);
      pi.api.on("session_tree", async () => {
        await writeFile(
          join(workspace, "a.txt"),
          "written-by-earlier-target-handler",
        );
        pi.manager.appendEntry({ type: "label" });
      });
      registerCyclotomy(pi.api);
      const { first, second } = await twoStates(pi);
      await writeFile(join(workspace, "a.txt"), "source-before-navigation");

      expect(await pi.navigate(first)).toBe("done");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "written-by-earlier-target-handler",
      );
      expect(notified(pi, "navigationPlanMismatch")).toBe(true);

      pi.manager.setLeaf(second);
      await pi.runCommand("restore");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "source-before-navigation",
      );
    });

    it("does not backflow a later arrival handler after target restore", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      pi.api.on("session_tree", async () => {
        await writeFile(join(workspace, "a.txt"), "later-target-handler");
      });
      const { first, second } = await twoStates(pi);

      expect(await pi.navigate(first)).toBe("done");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "later-target-handler",
      );
      pi.manager.setLeaf(second);
      await pi.runCommand("restore");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v2");
    });

    it("never backflows event-gap changes to source and refuses stale auto-restore", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first, second } = await twoStates(pi);
      pi.beforeTreeCommit = async () => {
        await writeFile(join(workspace, "a.txt"), "gap-edit");
      };

      expect(await pi.navigate(first)).toBe("done");

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("gap-edit");
      expect(notified(pi, "navigationChangedAfterPreview")).toBe(true);
      expect(lastStatus(pi)).toBe(messageFor("navigationAttentionStatus"));
      const db = metadata();
      const secondAfter = db.getState(pi.manager.sessionId, second)!;
      const firstState = db.getState(pi.manager.sessionId, first)!;
      expect(secondAfter.treeOid).not.toBe(firstState.treeOid);
      db.close();
      pi.beforeTreeCommit = undefined;
      await pi.runCommand("restore");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v1");
      pi.manager.setLeaf(second);
      await pi.runCommand("restore");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v2");
      expect(lastStatus(pi)).toBeUndefined();
    });

    it("commits the prepared source without switching stores when cwd is retargeted", async (context) => {
      context.skip(
        process.platform === "win32",
        "Windows symlink creation is privilege-dependent",
      );
      const firstRoot = join(workspace, "first-root");
      const secondRoot = join(workspace, "second-root");
      const linkedRoot = join(workspace, "linked-root");
      await Promise.all([mkdir(firstRoot), mkdir(secondRoot)]);
      await symlink(firstRoot, linkedRoot);
      const pi = new FakePi(linkedRoot);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(firstRoot, "a.txt"), "v1");
      await pi.endTurn();
      const first = pi.manager.getLeafId()!;
      await writeFile(join(firstRoot, "a.txt"), "v2");
      await pi.endTurn();
      const source = pi.manager.getLeafId()!;
      const firstHash = createHash("sha256")
        .update(await realpath(firstRoot))
        .digest("hex");
      const firstStore = join(home, "cyclotomy", firstHash);
      let db = new MetadataStore(join(firstStore, "state.db"));
      const before = db.getState(pi.manager.sessionId, source)!;
      db.close();
      await writeFile(join(firstRoot, "a.txt"), "prepared-source");
      await writeFile(join(secondRoot, "outside.txt"), "outside");
      pi.beforeTreeCommit = async () => {
        await rm(linkedRoot);
        await symlink(secondRoot, linkedRoot);
      };

      expect(await pi.navigate(first)).toBe("done");

      expect(await readFile(join(firstRoot, "a.txt"), "utf8")).toBe(
        "prepared-source",
      );
      expect(await readFile(join(secondRoot, "outside.txt"), "utf8")).toBe(
        "outside",
      );
      db = new MetadataStore(join(firstStore, "state.db"));
      expect(db.getState(pi.manager.sessionId, source)?.treeOid).not.toBe(
        before.treeOid,
      );
      db.close();
      const secondHash = createHash("sha256")
        .update(await realpath(secondRoot))
        .digest("hex");
      await expect(
        stat(join(home, "cyclotomy", secondHash, "state.db")),
      ).rejects.toThrow();
    });

    it("keeps the verified source independent of arrival process state", async (context) => {
      context.skip(
        process.platform === "win32",
        "the test uses a POSIX executable shim",
      );
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first, second } = await twoStates(pi);
      const beforeDb = metadata();
      const before = beforeDb.getState(pi.manager.sessionId, second)!;
      beforeDb.close();
      await writeFile(join(workspace, "a.txt"), "prepared-before-scan-error");
      const fakeBin = join(workspace, "fake-bin");
      await mkdir(fakeBin);
      const fakeGit = join(fakeBin, "git");
      await writeFile(fakeGit, "#!/bin/sh\nexit 2\n");
      await chmod(fakeGit, 0o755);
      const originalPath = process.env.PATH;
      pi.beforeTreeCommit = async () => {
        process.env.PATH = fakeBin;
      };

      try {
        expect(await pi.navigate(first)).toBe("done");
      } finally {
        process.env.PATH = originalPath;
      }

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v1");
      const afterDb = metadata();
      expect(afterDb.getState(pi.manager.sessionId, second)?.treeOid).not.toBe(
        before.treeOid,
      );
      afterDb.close();
      pi.manager.setLeaf(second);
      await pi.runCommand("restore");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "prepared-before-scan-error",
      );
    });

    it("never guesses on an unplanned tree arrival", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first } = await twoStates(pi);
      const dbBefore = metadata();
      const targetBefore = dbBefore.getState(pi.manager.sessionId, first);
      dbBefore.close();

      await pi.landUnmanaged(first);

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v2");
      const dbAfter = metadata();
      expect(dbAfter.getState(pi.manager.sessionId, first)).toEqual(
        targetBefore,
      );
      dbAfter.close();
      expect(notified(pi, "navigationPlanMismatch")).toBe(true);
    });

    it("does not materialize a genuinely missing unplanned arrival", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      const ancestor = pi.manager.appendEntry();
      pi.manager.appendEntry();
      await writeFile(join(workspace, "a.txt"), "descendant");
      await pi.endTurn(0);

      await pi.landUnmanaged(ancestor.id);

      const db = metadata();
      expect(db.getState(pi.manager.sessionId, ancestor.id)).toBeUndefined();
      db.close();
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "descendant",
      );
      expect(notified(pi, "navigationPlanMismatch")).toBe(true);
    });

    it("cancels navigation when the authoritative target is corrupt", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first, second } = await twoStates(pi);
      const db = metadata();
      const target = db.getState(pi.manager.sessionId, second)!;
      db.close();
      await rm(
        join(
          storeRoot,
          "objects",
          "trees",
          target.treeOid.slice(0, 2),
          target.treeOid.slice(2),
        ),
      );
      await writeFile(join(workspace, "a.txt"), "v3");
      await pi.endTurn();

      expect(await pi.navigate(second)).toBe("cancelled");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v3");
      expect(
        notifiedWithDetail(
          pi,
          "navigationPrepareFailed",
          "tree object does not exist",
        ),
      ).toBe(true);
      // A readable older ancestor state exists, but corruption of the nearest
      // authoritative slot is never silently downgraded to inheriting it.
      const readable = metadata();
      expect(readable.getState(pi.manager.sessionId, first)).toBeDefined();
      readable.close();
    });

    it("round-trips an exact descendant through a missing ancestor and a cold start", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      const ancestor = pi.manager.appendEntry();
      await writeFile(join(workspace, "a.txt"), "child-state");
      await pi.endTurn();
      const descendant = pi.manager.getLeafId()!;
      await writeFile(join(workspace, "a.txt"), "source-edit");

      expect(await pi.navigate(ancestor.id)).toBe("done");

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "source-edit",
      );
      let db = metadata();
      expect(db.getState(pi.manager.sessionId, ancestor.id)).toBeDefined();
      expect(db.getState(pi.manager.sessionId, descendant)).toBeDefined();
      db.close();

      // A process cold-start at the newly materialized ancestor observes an
      // ordinary matching checkpoint and neither restores nor asks.
      const selectionsBefore = pi.selections.length;
      await pi.startSession("startup");
      expect(pi.selections).toHaveLength(selectionsBefore);

      await writeFile(join(workspace, "a.txt"), "ancestor-edit");
      expect(await pi.navigate(descendant)).toBe("done");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "source-edit",
      );
      expect(await pi.navigate(ancestor.id)).toBe("done");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "ancestor-edit",
      );

      db = metadata();
      expect(db.getState(pi.manager.sessionId, ancestor.id)).toBeDefined();
      expect(db.getState(pi.manager.sessionId, descendant)).toBeDefined();
      db.close();
      expect(lastStatus(pi)).toBeUndefined();
    });

    it("materializes a planned missing logical target, not its summary or label wrappers", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      const ancestor = pi.manager.appendEntry();
      await writeFile(join(workspace, "a.txt"), "descendant");
      await pi.endTurn();

      expect(await pi.prepareNavigation(ancestor.id)).toBe("ready");
      const summary = await pi.commitPreparedSummary(ancestor.id, true);
      const label = pi.manager.getLeafId()!;

      const db = metadata();
      expect(db.getState(pi.manager.sessionId, ancestor.id)).toBeDefined();
      expect(db.getState(pi.manager.sessionId, summary)).toBeUndefined();
      expect(db.getState(pi.manager.sessionId, label)).toBeUndefined();
      db.close();
    });

    it("uses an authenticated root summary when the logical destination is null", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      const rootPrompt = pi.manager.appendEntry({
        type: "message",
        message: { role: "user" },
      });
      pi.manager.setLeaf(null);
      await writeFile(join(workspace, "a.txt"), "root-summary");

      expect(await pi.prepareNavigation(rootPrompt.id)).toBe("ready");
      const summary = await pi.commitPreparedSummary(rootPrompt.id, true);
      const label = pi.manager.getLeafId()!;

      const db = metadata();
      expect(db.getState(pi.manager.sessionId, rootPrompt.id)).toBeUndefined();
      expect(db.getState(pi.manager.sessionId, summary)).toBeDefined();
      expect(db.getState(pi.manager.sessionId, label)).toBeUndefined();
      db.close();
    });

    it("never materializes a selected label id", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      const stable = pi.manager.appendEntry();
      const label = pi.manager.appendEntry({ type: "label" });
      await writeFile(join(workspace, "a.txt"), "descendant");
      await pi.endTurn();

      expect(await pi.navigate(label.id)).toBe("done");

      const db = metadata();
      expect(db.getState(pi.manager.sessionId, stable.id)).toBeDefined();
      expect(db.getState(pi.manager.sessionId, label.id)).toBeUndefined();
      db.close();
    });

    it("materializes the target-side observation made at committed arrival", async () => {
      const pi = new FakePi(workspace);
      let editArrival = false;
      pi.api.on("session_tree", async () => {
        if (editArrival) {
          await writeFile(join(workspace, "a.txt"), "target-handler-edit");
        }
      });
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      const ancestor = pi.manager.appendEntry();
      await writeFile(join(workspace, "a.txt"), "descendant-state");
      await pi.endTurn();
      const descendant = pi.manager.getLeafId()!;

      editArrival = true;
      expect(await pi.navigate(ancestor.id)).toBe("done");
      editArrival = false;
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "target-handler-edit",
      );

      expect(await pi.navigate(descendant)).toBe("done");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "descendant-state",
      );
      expect(await pi.navigate(ancestor.id)).toBe("done");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "target-handler-edit",
      );
    });

    it("cancels a transition when a complete source snapshot is impossible", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first } = await twoStates(pi);
      await writeFile(join(workspace, "hard-a"), "same inode");
      await link(join(workspace, "hard-a"), join(workspace, "hard-b"));

      await pi.runCommand("drift");
      expect(pi.notifications.at(-1)?.level).toBe("warning");
      expect(pi.notifications.at(-1)?.message)
        // Both hard links are reported, so the plural form is the expected one.
        .toContain(TEST_I18N.t("previewProblemMany", { count: 2 }));
      expect(pi.notifications.at(-1)?.message).toContain(
        messageFor("scanProblemHardlink"),
      );

      expect(await pi.navigate(first)).toBe("cancelled");
      expect(pi.manager.getLeafId()).not.toBe(first);
      expect(notified(pi, "navigationScanIncomplete")).toBe(true);
    });
  });

  describe("idle input and custom messages", () => {
    it("captures between-turn edits before appending an idle prompt", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "turn");
      await pi.endTurn();
      const source = pi.manager.getLeafId()!;
      const before = metadata();
      const beforeOid = before.getState(pi.manager.sessionId, source)!.treeOid;
      before.close();
      await writeFile(join(workspace, "a.txt"), "between-turns");

      expect(await pi.submitInput()).toBe("continued");

      const after = metadata();
      expect(after.getState(pi.manager.sessionId, source)!.treeOid).not.toBe(
        beforeOid,
      );
      after.close();
    });

    it("captures idle custom-trigger messages at the safest observable hook", async () => {
      const pi = new FakePi(workspace);
      pi.api.on("message_end", async (event) => {
        if (
          (event as { message: { role: string } }).message.role === "custom"
        ) {
          await writeFile(join(workspace, "a.txt"), "earlier-custom-handler");
        }
      });
      registerCyclotomy(pi.api);
      pi.api.on("message_end", async (event) => {
        if (
          (event as { message: { role: string } }).message.role === "custom"
        ) {
          await writeFile(join(workspace, "a.txt"), "later-custom-handler");
        }
      });
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "turn");
      await pi.endTurn();
      const source = pi.manager.getLeafId()!;

      const custom = await pi.sendCustomMessage("trigger", true);
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "later-custom-handler",
      );
      const db = metadata();
      expect(db.getState(pi.manager.sessionId, custom)).toBeUndefined();
      db.close();
      pi.manager.setLeaf(source);
      await pi.runCommand("restore");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "earlier-custom-handler",
      );
    });

    it("never backflows a later user message_end mutation to the parent", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      pi.api.on("message_end", async (event) => {
        if ((event as { message: { role: string } }).message.role === "user") {
          await writeFile(join(workspace, "a.txt"), "later-message-handler");
        }
      });
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "turn");
      await pi.endTurn();
      const source = pi.manager.getLeafId()!;
      await writeFile(join(workspace, "a.txt"), "before-input");

      expect(await pi.submitInput()).toBe("continued");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "later-message-handler",
      );
      pi.manager.setLeaf(source);
      await pi.runCommand("restore");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "before-input",
      );
    }, 15_000);

    it("keeps a harmless before-input capture when user persistence fails", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      const source = pi.manager.getLeafId()!;
      const before = metadata();
      const sourceBefore = before.getState(pi.manager.sessionId, source)!;
      before.close();
      await writeFile(join(workspace, "a.txt"), "not-persisted");
      pi.failUserMessagePersistence = true;

      await expect(pi.submitInput()).rejects.toThrow("persistence failure");
      // No post-append/context work can change the already-owned source capture.
      await pi.emitContext();

      const after = metadata();
      expect(after.getState(pi.manager.sessionId, source)?.treeOid).not.toBe(
        sourceBefore.treeOid,
      );
      after.close();
    });

    it("keeps a harmless source capture when a later input hook handles", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      const source = pi.manager.getLeafId()!;
      const before = metadata();
      const sourceBefore = before.getState(pi.manager.sessionId, source)!;
      before.close();
      await writeFile(join(workspace, "a.txt"), "not-accepted");
      pi.api.on("input", async () => ({ action: "handled" as const }));

      expect(await pi.submitInput()).toBe("handled");

      const after = metadata();
      expect(after.getState(pi.manager.sessionId, source)?.treeOid).not.toBe(
        sourceBefore.treeOid,
      );
      after.close();
    });
  });

  describe("compaction and metadata-only leaves", () => {
    it("keeps auto-compaction metadata inheriting the before-input source", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "turn");
      await pi.endTurn();
      await writeFile(join(workspace, "a.txt"), "between-turns");
      let compactionLeaf: string | undefined;
      pi.beforeUserMessageCommit = async () => {
        expect(await pi.compact()).toBe("done");
        compactionLeaf = pi.manager.getLeafId()!;
      };

      expect(await pi.submitInput()).toBe("continued");

      const userLeaf = pi.manager.getLeafId()!;
      const db = metadata();
      expect(compactionLeaf).toBeDefined();
      expect(
        db.getState(pi.manager.sessionId, compactionLeaf!),
      ).toBeUndefined();
      expect(db.getState(pi.manager.sessionId, userLeaf)).toBeUndefined();
      db.close();
    });

    it("captures before compaction and lets the metadata-only leaf inherit", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "turn");
      await pi.endTurn();
      const source = pi.manager.getLeafId()!;
      await writeFile(join(workspace, "a.txt"), "before-compact");
      pi.statuses.set("cyclotomy", "stale navigation notice");

      expect(await pi.compact()).toBe("done");
      expect(lastStatus(pi)).toBeUndefined();

      const db = metadata();
      expect(db.getState(pi.manager.sessionId, source)).toBeDefined();
      expect(
        db.getState(pi.manager.sessionId, pi.manager.getLeafId()!),
      ).toBeUndefined();
      db.close();
    });

    it("lets fire-and-forget metadata leaves inherit without parent backflow", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "turn");
      await pi.endTurn();
      const source = pi.manager.getLeafId()!;
      const before = metadata();
      const sourceBefore = before.getState(pi.manager.sessionId, source)!;
      before.close();

      await writeFile(join(workspace, "a.txt"), "before-model");
      const selected = await pi.selectModel("provider", "model", "high");
      await writeFile(join(workspace, "a.txt"), "before-thinking");
      const thinking = await pi.selectThinkingLevel("low");
      await writeFile(join(workspace, "a.txt"), "before-name");
      const sessionInfo = await pi.setSessionName("renamed");

      const db = metadata();
      expect(db.getState(pi.manager.sessionId, source)).toEqual(sourceBefore);
      expect(
        db.getState(pi.manager.sessionId, selected.modelId),
      ).toBeUndefined();
      expect(
        db.getState(pi.manager.sessionId, selected.thinkingId!),
      ).toBeUndefined();
      expect(db.getState(pi.manager.sessionId, thinking)).toBeUndefined();
      expect(db.getState(pi.manager.sessionId, sessionInfo)).toBeUndefined();
      db.close();

      pi.manager.setLeaf(source);
      await pi.runCommand("restore");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("turn");
    });

    it("does not guess when a metadata tail contains duplicate event matches", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "turn");
      await pi.endTurn();
      await writeFile(join(workspace, "a.txt"), "first-name-change");
      const firstInfo = await pi.setSessionName("same");
      await writeFile(join(workspace, "a.txt"), "ambiguous-second-change");

      await pi.setSessionName("same");

      const db = metadata();
      expect(db.getState(pi.manager.sessionId, firstInfo)).toBeUndefined();
      db.close();
    });

    it("assigns concurrent metadata-event edits only at the next safe hook", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      pi.api.on("session_info_changed", async () => {
        await writeFile(join(workspace, "a.txt"), "metadata-handler-edit");
      });
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "turn");
      await pi.endTurn();
      const source = pi.manager.getLeafId()!;
      const before = metadata();
      const sourceBefore = before.getState(pi.manager.sessionId, source)!;
      before.close();

      const metadataLeaf = await pi.setSessionName("concurrent");
      let db = metadata();
      expect(db.getState(pi.manager.sessionId, source)).toEqual(sourceBefore);
      expect(db.getState(pi.manager.sessionId, metadataLeaf)).toBeUndefined();
      db.close();

      expect(await pi.submitInput()).toBe("continued");
      db = metadata();
      expect(db.getState(pi.manager.sessionId, metadataLeaf)).toBeDefined();
      db.close();
      pi.manager.setLeaf(metadataLeaf);
      await pi.runCommand("restore");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "metadata-handler-edit",
      );
    });

    it("leaves a harmless capture when a later compaction hook cancels", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      const source = pi.manager.getLeafId()!;
      const before = metadata();
      const sourceBefore = before.getState(pi.manager.sessionId, source)!;
      before.close();
      await writeFile(join(workspace, "a.txt"), "not-compacted");
      pi.api.on("session_before_compact", async () => ({ cancel: true }));

      expect(await pi.compact()).toBe("cancelled");

      const after = metadata();
      expect(after.getState(pi.manager.sessionId, source)?.treeOid).not.toBe(
        sourceBefore.treeOid,
      );
      after.close();
    });
  });

  describe("user bash", () => {
    it("captures before user bash and allows restore through inheritance", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "before-bash");
      await pi.endTurn();

      await pi.executeUserBash("change", async () => {
        await writeFile(join(workspace, "a.txt"), "after-bash");
      });
      // The fake host appends a metadata-only bash leaf after the operation.
      await pi.runCommand("restore");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "before-bash",
      );
    });

    it("does not assume priority over an earlier user_bash interceptor", async () => {
      const pi = new FakePi(workspace);
      pi.api.on("user_bash", async () => {
        await writeFile(join(workspace, "a.txt"), "earlier-interceptor");
        return {
          result: {
            output: "intercepted",
            exitCode: 0,
            cancelled: false,
            truncated: false,
          },
        };
      });
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "turn");
      await pi.endTurn();
      const source = pi.manager.getLeafId()!;
      const before = metadata();
      const sourceBefore = before.getState(pi.manager.sessionId, source)!;
      before.close();
      let operationRan = false;

      await pi.executeUserBash("intercepted", async () => {
        operationRan = true;
      });

      expect(operationRan).toBe(false);
      const resultLeaf = pi.manager.getLeafId()!;
      let db = metadata();
      expect(db.getState(pi.manager.sessionId, source)).toEqual(sourceBefore);
      expect(db.getState(pi.manager.sessionId, resultLeaf)).toBeUndefined();
      db.close();
      // The next cancellable input assigns the inherited result location.
      expect(await pi.submitInput()).toBe("continued");
      db = metadata();
      expect(db.getState(pi.manager.sessionId, resultLeaf)).toBeDefined();
      db.close();
    });

    it("allows bash after a completed before-input capture", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      const source = pi.manager.getLeafId()!;
      const before = metadata();
      const sourceBefore = before.getState(pi.manager.sessionId, source)!;
      before.close();
      await writeFile(join(workspace, "a.txt"), "between-turns");
      expect(await pi.preflightInput()).toBe("continued");
      let executed = false;

      await pi.executeUserBash("blocked-by-pending-input", async () => {
        executed = true;
      });

      expect(executed).toBe(true);
      expect(pi.manager.getLeafId()).not.toBe(source);
      const after = metadata();
      expect(after.getState(pi.manager.sessionId, source)?.treeOid).not.toBe(
        sourceBefore.treeOid,
      );
      after.close();
      await writeFile(join(workspace, "a.txt"), "later-drift");
      await pi.runCommand("restore");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "between-turns",
      );
    });

    it("blocks bash execution when source capture fails but models Pi's result leaf", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      const source = pi.manager.getLeafId()!;
      await writeFile(join(workspace, "hard-a"), "same inode");
      await link(join(workspace, "hard-a"), join(workspace, "hard-b"));
      let executed = false;

      await pi.executeUserBash("must-not-run", async () => {
        executed = true;
        await writeFile(join(workspace, "ran"), "yes");
      });

      expect(executed).toBe(false);
      expect(pi.manager.getLeafId()).not.toBe(source);
      await expect(stat(join(workspace, "ran"))).rejects.toThrow();
      expect(notified(pi, "sourceCaptureFailed")).toBe(true);
    });

    it("refuses user bash while the agent is busy", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      const source = pi.manager.getLeafId()!;
      const before = metadata();
      const sourceBefore = before.getState(pi.manager.sessionId, source)!;
      before.close();
      pi.idle = false;
      let executed = false;

      await pi.executeUserBash("unsafe-during-stream", async () => {
        executed = true;
        await writeFile(join(workspace, "a.txt"), "changed");
      });

      expect(executed).toBe(false);
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("saved");
      const after = metadata();
      expect(after.getState(pi.manager.sessionId, source)).toEqual(
        sourceBefore,
      );
      after.close();
    });
  });

  describe("session identity and persistence", () => {
    it("disables persistence for in-memory Pi sessions", async () => {
      const pi = new FakePi(workspace);
      pi.manager = pi.newInMemorySession();
      registerCyclotomy(pi.api);
      const first = pi.manager.appendEntry();
      pi.manager.appendEntry();
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "ephemeral");

      await pi.endTurn(0);
      expect(await pi.navigate(first.id)).toBe("done");
      await pi.runCommand("drift");

      await expect(stat(storeRoot)).rejects.toThrow();
      expect(notified(pi, "memorySessionUnsupported")).toBe(true);
      expect(notified(pi, "navigationPlanMismatch")).toBe(false);
      expect(lastStatus(pi)).toBeUndefined();
    });

    it("fails closed when two physical files claim the same session id", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "original");
      await pi.endTurn();
      const sessionId = pi.manager.sessionId;
      const entryId = pi.manager.getLeafId()!;
      const before = metadata();
      const original = before.getState(sessionId, entryId)!;
      before.close();

      const duplicate = new FakeSessionManager(
        sessionId,
        "/sessions/duplicate.jsonl",
        workspace,
      );
      expect(duplicate.appendEntry().id).toBe(entryId);
      pi.manager = duplicate;
      await pi.startSession("resume");
      await writeFile(join(workspace, "a.txt"), "duplicate-workspace");
      await pi.endTurn(0);
      await pi.runCommand("restore");

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "duplicate-workspace",
      );
      const after = metadata();
      expect(after.getState(sessionId, entryId)).toEqual(original);
      expect(after.listRegisteredSessions()[0]?.sessionFile).toBe(
        "/sessions/s1.jsonl",
      );
      after.close();
      expect(
        notifiedWithDetail(
          pi,
          "sessionRegistrationFailed",
          'session id "s1" is already owned by another file',
        ),
      ).toBe(true);
    });

    it("never recovers into an unregistered duplicate identity after init failure", async () => {
      await writeFile(storeRoot, "blocks store creation");
      const pi = new FakePi(workspace);
      pi.manager = new FakeSessionManager(
        "shared-session",
        "/sessions/duplicate.jsonl",
        workspace,
      );
      const leaf = pi.manager.appendEntry();
      registerCyclotomy(pi.api);

      await pi.startSession("startup");
      expect(notified(pi, "initFailure")).toBe(true);

      await rm(storeRoot, { force: true });
      await mkdir(storeRoot, { recursive: true });
      const originalOid = "a".repeat(64);
      let db = metadata();
      db.touchSession("shared-session", "/sessions/original.jsonl");
      db.setState("shared-session", leaf.id, originalOid);
      db.close();
      await writeFile(join(workspace, "a.txt"), "must-not-be-captured");

      await pi.endTurn(0);
      await pi.runCommand("restore");

      db = metadata();
      expect(db.getState("shared-session", leaf.id)?.treeOid).toBe(originalOid);
      expect(db.listRegisteredSessions()[0]?.sessionFile).toBe(
        "/sessions/original.jsonl",
      );
      db.close();
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "must-not-be-captured",
      );
    });
  });

  describe("fork, switch, and resume", () => {
    it("resume captures the source and restores the confirmed target session", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
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

    it("keeps harmless captures when later fork and switch hooks veto", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      const source = pi.manager.getLeafId()!;
      const initial = metadata();
      const initialOid = initial.getState(
        pi.manager.sessionId,
        source,
      )!.treeOid;
      initial.close();
      await writeFile(join(workspace, "a.txt"), "before-fork-veto");
      pi.api.on("session_before_fork", async () => ({ cancel: true }));

      expect(await pi.fork(source)).toBe("cancelled");
      let db = metadata();
      const forkOid = db.getState(pi.manager.sessionId, source)!.treeOid;
      expect(forkOid).not.toBe(initialOid);
      db.close();

      await writeFile(join(workspace, "a.txt"), "before-switch-veto");
      pi.api.on("session_before_switch", async () => ({ cancel: true }));
      expect(await pi.resumeTo(pi.newDetachedSession())).toBe("cancelled");
      db = metadata();
      expect(db.getState(pi.manager.sessionId, source)?.treeOid).not.toBe(
        forkOid,
      );
      db.close();
    });

    it("never overwrites a different workspace while loading it without confirmation", async () => {
      const otherWorkspace = await mkdtemp(
        join(tmpdir(), "cyclotomy-pi-ws-b-"),
      );
      try {
        const pi = new FakePi(workspace);
        registerCyclotomy(pi.api);
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
  });
});
