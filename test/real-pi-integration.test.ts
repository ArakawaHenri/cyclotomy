import {
  SessionManager,
  type ExtensionFactory,
  type SessionTreeEvent,
} from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createCurrentMetadataStore } from "../src/infrastructure/metadata.ts";
import {
  readSessionView,
  SessionViewTracker,
  type SessionView,
} from "../src/pi/session-view.ts";
import { RealPiHarness } from "./real-pi.ts";
import {
  checkpointState,
  readTestSessionRegistration,
} from "./metadata-fixture.ts";

/**
 * Integration probe against the Pi version actually installed.
 *
 * These tests deliberately stay coarse. Their job is to detect that Cyclotomy
 * still integrates with the host: event order, session-tree shape, command
 * dispatch, and the confirmation UI. Adversarial handler ordering and race
 * windows remain the fake-Pi suite's responsibility, because a real host cannot
 * be asked to produce them on demand.
 *
 * A failure here means the host contract moved, not that Cyclotomy's internal
 * logic regressed. `peerDependencies` intentionally has no upper bound, so this
 * file is the executable check on that openness.
 */

let harness: RealPiHarness | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

async function startHarness(
  options: Parameters<RealPiHarness["start"]>[0] = {},
): Promise<RealPiHarness> {
  const started = new RealPiHarness();
  harness = started;
  await started.start(options);
  return started;
}

async function startHarnessWithRootUser(): Promise<RealPiHarness> {
  const started = new RealPiHarness();
  harness = started;
  await started.start({ initialUserMessage: "fork this root prompt" });
  return started;
}

function readState(
  pi: RealPiHarness,
  sessionId: string,
  entryId: string,
): string | undefined {
  const db = createCurrentMetadataStore(join(pi.storeRoot, "state.db"));
  try {
    return checkpointState(db, sessionId, entryId)?.treeOid;
  } finally {
    db.close();
  }
}

describe("real Pi integration", () => {
  it("dispatches an extension command before input while streaming", async () => {
    let commands = 0;
    let inputs = 0;
    const probe: ExtensionFactory = (pi) => {
      pi.registerCommand("escape-probe", {
        description: "test Pi's streaming command boundary",
        handler: async () => {
          commands += 1;
        },
      });
      pi.on("input", () => {
        inputs += 1;
        return { action: "continue" };
      });
    };
    const pi = await startHarness({
      includeCyclotomy: false,
      afterCyclotomy: [{ name: "escape-probe", factory: probe }],
    });
    const pause = pi.pauseNextModelTurn();
    const turn = pi.turn("enter streaming");
    await pause.started;
    inputs = 0;

    try {
      expect(pi.session.isStreaming).toBe(true);
      await pi.command("/escape-probe");
      expect(commands).toBe(1);
      expect(inputs).toBe(0);
      expect(pi.session.isStreaming).toBe(true);
    } finally {
      pause.release();
      await turn;
    }
  });

  it("exposes cold-fork provenance through Pi's package-root API", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-realpi-fork-"));
    try {
      const sourceWorkspace = join(root, "source-workspace");
      const targetWorkspace = join(root, "target-workspace");
      await Promise.all([mkdir(sourceWorkspace), mkdir(targetWorkspace)]);

      const source = SessionManager.create(
        sourceWorkspace,
        join(root, "source-sessions"),
      );
      source.appendMessage({
        role: "user",
        content: "fork this persisted session",
        timestamp: Date.now(),
      });
      source.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        api: "openai-completions",
        provider: "cyclotomy-test-provider",
        model: "cyclotomy-test-model",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      });
      const sourceFile = source.getSessionFile();
      expect(sourceFile).toBeDefined();
      await expect(stat(sourceFile!)).resolves.toBeDefined();

      const child = SessionManager.forkFrom(
        sourceFile!,
        targetWorkspace,
        join(root, "target-sessions"),
      );

      expect(child.getHeader()).toMatchObject({
        cwd: targetWorkspace,
        parentSession: sourceFile,
      });
      expect(child.getEntries()).toEqual(source.getEntries());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("inherits a persisted checkpoint when a forked child starts normally", async () => {
    const pi = await startHarness();
    await pi.writeWorkspaceFile("forked.txt", "source checkpoint");
    await pi.turn("persist the source");
    const sourceSessionId = pi.sessionId;
    const sourceLeafId = pi.leafId;
    const sourceTreeOid = readState(pi, sourceSessionId, sourceLeafId);
    expect(sourceTreeOid).toBeDefined();

    // Select the destructive loaded-session option in the fresh target. The
    // child runtime is created without a fork start event, matching Pi's
    // package-root SessionManager.forkFrom + ordinary startup contract.
    pi.selectIndex = 1;
    const source = await pi.startupForkToNewWorkspace();

    expect(source).toMatchObject({ sourceSessionId, sourceLeafId });
    expect(pi.sessionId).not.toBe(sourceSessionId);
    expect(pi.sessionManager.getHeader()?.parentSession).toBe(
      source.sourceSessionFile,
    );
    expect(readState(pi, pi.sessionId, sourceLeafId)).toBe(sourceTreeOid);
    expect(await readFile(join(pi.workspace, "forked.txt"), "utf8")).toBe(
      "source checkpoint",
    );
  });

  it("loads as an extension and registers its three commands", async () => {
    const pi = await startHarness();

    // Read what Pi itself registered, so a renamed or dropped command fails.
    expect(pi.registeredCommandNames).toEqual([
      "cyclotomy",
      "drift",
      "restore",
    ]);
    // A concrete cold-start leaf is materialized from the first observed
    // workspace so later navigation has an honest baseline.
    await expect(stat(join(pi.storeRoot, "state.db"))).resolves.toBeDefined();
    const db = createCurrentMetadataStore(join(pi.storeRoot, "state.db"));
    try {
      const treeOids = db.listReferencedTreeOids();
      expect(treeOids).toHaveLength(1);
      expect(checkpointState(db, pi.sessionId, pi.leafId)?.treeOid).toBe(
        treeOids[0],
      );
    } finally {
      db.close();
    }
  });

  it("records a checkpoint on each real turn_end", async () => {
    const pi = await startHarness();

    await pi.writeWorkspaceFile("a.txt", "v1");
    await pi.turn();
    const first = pi.leafId;
    const firstOid = readState(pi, pi.sessionId, first);

    await pi.writeWorkspaceFile("a.txt", "v2");
    await pi.turn();
    const second = pi.leafId;
    const secondOid = readState(pi, pi.sessionId, second);

    expect(first).not.toBe(second);
    expect(firstOid).toBeDefined();
    expect(secondOid).toBeDefined();
    // Distinct workspace content must produce distinct recorded trees.
    expect(firstOid).not.toBe(secondOid);
  });

  it("keeps an unsaved root fork live before the first assistant turn", async () => {
    const pi = await startHarnessWithRootUser();
    // Pi buffers the JSONL until the first assistant and permits a `before`
    // fork from a root user entry while that parent file is still absent.
    expect(
      pi.sessionManager.getEntry(pi.initialUserEntryId)?.parentId,
    ).toBeNull();
    const parentSessionFile = pi.sessionManager.getSessionFile();
    expect(parentSessionFile).toBeDefined();
    await expect(stat(parentSessionFile!)).rejects.toMatchObject({
      code: "ENOENT",
    });

    const parentSessionId = pi.sessionId;
    await pi.fork(pi.initialUserEntryId);

    const childSessionId = pi.sessionId;
    const childSessionFile = pi.sessionManager.getSessionFile();
    expect(childSessionId).not.toBe(parentSessionId);
    expect(childSessionFile).toBeDefined();
    expect(pi.sessionManager.getHeader()?.parentSession).toBe(
      parentSessionFile,
    );

    const metadataPath = join(pi.storeRoot, "state.db");
    const metadata = createCurrentMetadataStore(metadataPath);
    try {
      expect(
        readTestSessionRegistration(metadataPath, childSessionId),
      ).toMatchObject({
        sessionFile: childSessionFile,
      });
    } finally {
      metadata.close();
    }

    await pi.writeWorkspaceFile("after-fork.txt", "child state");
    await pi.turn("first child turn");
    expect(readState(pi, childSessionId, pi.leafId)).toBeDefined();
  });

  it("restores the selected checkpoint through real Pi tree navigation", async () => {
    const pi = await startHarness();
    await pi.writeWorkspaceFile("branch.txt", "first");
    await pi.turn("first turn");
    const first = pi.leafId;
    await pi.turn("second turn");
    await pi.writeWorkspaceFile("branch.txt", "second");

    pi.selectIndex = 2;
    await pi.navigate(first);

    expect(await readFile(join(pi.workspace, "branch.txt"), "utf8")).toBe(
      "first",
    );
    expect(pi.selections.at(-1)?.options).toHaveLength(3);
  });

  it("reports drift through Pi's own command dispatch", async () => {
    const pi = await startHarness();
    await pi.writeWorkspaceFile("a.txt", "v1");
    await pi.turn();
    await pi.writeWorkspaceFile("a.txt", "changed");

    pi.notifications.length = 0;
    await pi.command("/drift");

    const reported = pi.notifications.map(({ message }) => message).join("\n");
    expect(reported).toContain("~ a.txt");
    // A read-only preview must not touch files.
    expect(await readFile(join(pi.workspace, "a.txt"), "utf8")).toBe("changed");
  });

  it("keeps files unchanged when the restore selector is cancelled", async () => {
    const pi = await startHarness();
    await pi.writeWorkspaceFile("a.txt", "saved");
    await pi.turn();
    await pi.writeWorkspaceFile("a.txt", "current");

    pi.selectIndex = 0;
    pi.selections.length = 0;
    await pi.command("/restore");

    // Pi's real selector must offer the non-destructive option first.
    expect(pi.selections).toHaveLength(1);
    expect(pi.selections[0]!.options).toHaveLength(2);
    expect(await readFile(join(pi.workspace, "a.txt"), "utf8")).toBe("current");
  });

  it("restores the workspace when the destructive option is chosen", async () => {
    const pi = await startHarness();
    await pi.writeWorkspaceFile("a.txt", "saved");
    await pi.turn();
    const leaf = pi.leafId;
    const savedOid = readState(pi, pi.sessionId, leaf);
    await pi.writeWorkspaceFile("a.txt", "current");

    pi.selectIndex = 1;
    await pi.command("/restore");

    expect(await readFile(join(pi.workspace, "a.txt"), "utf8")).toBe("saved");
    // Restore is a pure apply: the node keeps its original retry target.
    expect(readState(pi, pi.sessionId, leaf)).toBe(savedOid);
  });

  it("captures between-turn edits at the source before a new turn", async () => {
    const pi = await startHarness();
    await pi.writeWorkspaceFile("a.txt", "turn-1");
    await pi.turn();
    const source = pi.leafId;
    const afterTurn = readState(pi, pi.sessionId, source);

    // An edit made while Pi is idle belongs to the node standing there now.
    await pi.writeWorkspaceFile("a.txt", "edited-between-turns");
    await pi.turn();

    const reassigned = readState(pi, pi.sessionId, source);
    expect(afterTurn).toBeDefined();
    expect(reassigned).toBeDefined();
    expect(reassigned).not.toBe(afterTurn);
  });

  it("reports a throwing before-tree handler but cancels only on an explicit result", async () => {
    let behavior: "throw" | "cancel" = "throw";
    let arrivals = 0;
    const gate: ExtensionFactory = (pi) => {
      pi.on("session_before_tree", () => {
        if (behavior === "throw") {
          throw new Error("adjunct before-tree failure");
        }
        return { cancel: true };
      });
      pi.on("session_tree", () => {
        arrivals += 1;
      });
    };
    const pi = await startHarness({
      includeCyclotomy: false,
      beforeCyclotomy: [{ name: "tree-gate", factory: gate }],
    });
    await pi.turn("first branch point");
    const first = pi.leafId;
    await pi.turn("second branch point");
    const second = pi.leafId;

    const continued = await pi.navigateResult(first);

    expect(continued.cancelled).toBe(false);
    expect(pi.leafId).toBe(first);
    expect(arrivals).toBe(1);
    expect(pi.extensionErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "session_before_tree",
          error: "adjunct before-tree failure",
        }),
      ]),
    );

    behavior = "cancel";
    const leafBeforeCancel = pi.leafId;
    const cancelled = await pi.navigateResult(second);

    expect(cancelled.cancelled).toBe(true);
    expect(pi.leafId).toBe(leafBeforeCancel);
    expect(arrivals).toBe(1);
  });

  it("exposes a labeled branch summary as a stable summary under a raw label leaf", async () => {
    let arrival:
      | { readonly event: SessionTreeEvent; readonly view: SessionView }
      | undefined;
    const observer: ExtensionFactory = (pi) => {
      pi.on("session_tree", (event, context) => {
        arrival = { event, view: readSessionView(context) };
      });
    };
    const pi = await startHarness({
      includeCyclotomy: false,
      afterCyclotomy: [{ name: "tree-observer", factory: observer }],
    });
    await pi.turn("first branch point");
    const target = pi.leafId;
    await pi.turn("abandoned branch content");

    const result = await pi.navigateResult(target, {
      summarize: true,
      label: "kept branch",
    });

    expect(result.cancelled).toBe(false);
    expect(result.summaryEntry).toBeDefined();
    if (result.summaryEntry === undefined || arrival === undefined) {
      throw new Error("real Pi did not expose the summarized tree arrival");
    }
    const { event, view } = arrival;
    const rawLeafId = event.newLeafId;
    expect(rawLeafId).not.toBeNull();
    if (rawLeafId === null) {
      throw new Error("labeled summary unexpectedly landed at root");
    }
    expect(event.summaryEntry).toEqual(result.summaryEntry);
    expect(rawLeafId).not.toBe(result.summaryEntry.id);
    expect(pi.sessionManager.getEntry(rawLeafId)).toMatchObject({
      type: "label",
      targetId: result.summaryEntry.id,
      label: "kept branch",
    });
    expect(view.leafId).toBe(rawLeafId);
    expect(view.stableCoordinateId(rawLeafId)).toBe(result.summaryEntry.id);
    expect(view.stableCoordinateId(result.summaryEntry.id)).toBe(
      result.summaryEntry.id,
    );
    expect(view.activeStableAncestryIds.at(-1)).toBe(result.summaryEntry.id);
  });

  it("carries a direct setLabel append into the next public observation without a tree event", async () => {
    const tracker = new SessionViewTracker();
    let treeEvents = 0;
    let targetId: string | undefined;
    let labelLeafId: string | undefined;
    let carried: SessionView | undefined;
    const labeler: ExtensionFactory = (pi) => {
      pi.on("session_start", (_event, context) => {
        tracker.bootstrap(context);
      });
      pi.on("input", (_event, context) => {
        const observed = tracker.observe(context);
        if (labelLeafId !== undefined) carried = observed;
      });
      pi.on("turn_end", (_event, context) => {
        tracker.observe(context);
        if (targetId !== undefined) return;
        const current = context.sessionManager.getLeafId();
        if (current === null) throw new Error("turn ended without a Pi leaf");
        targetId = current;
        pi.setLabel(current, "direct label");
        labelLeafId = context.sessionManager.getLeafId() ?? undefined;
      });
      pi.on("session_tree", () => {
        treeEvents += 1;
      });
    };
    const pi = await startHarness({
      includeCyclotomy: false,
      afterCyclotomy: [{ name: "direct-labeler", factory: labeler }],
    });

    await pi.turn("create the labeled leaf");

    expect(targetId).toBeDefined();
    expect(labelLeafId).toBeDefined();
    expect(treeEvents).toBe(0);
    expect(pi.sessionManager.getEntry(labelLeafId!)).toMatchObject({
      type: "label",
      targetId,
      label: "direct label",
    });

    await pi.turn("observe after the transparent label");

    expect(carried).toBeDefined();
    expect(carried?.stableCoordinateId(labelLeafId)).toBe(targetId);
    expect(treeEvents).toBe(0);
    expect(pi.extensionErrors).toEqual([]);
  });

  it.each(["aborted", "error"] as const)(
    "leaves no tree arrival after an accepted summary %s and continues at the next boundary",
    async (outcome) => {
      let preparations = 0;
      let arrivals = 0;
      const observer: ExtensionFactory = (pi) => {
        pi.on("session_before_tree", () => {
          preparations += 1;
        });
        pi.on("session_tree", () => {
          arrivals += 1;
        });
      };
      const pi = await startHarness({
        includeCyclotomy: false,
        afterCyclotomy: [{ name: "summary-observer", factory: observer }],
      });
      await pi.turn("first branch point");
      const target = pi.leafId;
      await pi.turn("content that requires a branch summary");
      const originalLeaf = pi.leafId;
      const originalEntryCount = pi.sessionManager.getEntries().length;
      pi.modelOutcome = outcome;

      if (outcome === "aborted") {
        await expect(
          pi.navigateResult(target, { summarize: true }),
        ).resolves.toMatchObject({ cancelled: true, aborted: true });
      } else {
        await expect(
          pi.navigateResult(target, { summarize: true }),
        ).rejects.toThrow("Cyclotomy real-Pi test failed the request");
      }

      expect(preparations).toBe(1);
      expect(arrivals).toBe(0);
      expect(pi.leafId).toBe(originalLeaf);
      expect(pi.sessionManager.getEntries()).toHaveLength(originalEntryCount);

      pi.modelOutcome = "success";
      await pi.turn("continue after the failed summary");
      expect(pi.leafId).not.toBe(originalLeaf);
      expect(pi.sessionManager.getEntries().length).toBeGreaterThan(
        originalEntryCount,
      );
      expect(arrivals).toBe(0);
    },
  );

  it("retires Cyclotomy's orphaned tree proposal at exactly one later boundary", async () => {
    let preparations = 0;
    let arrivals = 0;
    const observer: ExtensionFactory = (pi) => {
      pi.on("session_before_tree", () => {
        preparations += 1;
      });
      pi.on("session_tree", () => {
        arrivals += 1;
      });
    };
    const pi = await startHarness({
      afterCyclotomy: [{ name: "orphan-observer", factory: observer }],
    });
    await pi.turn("first branch point");
    const target = pi.leafId;
    await pi.turn("content that requires a branch summary");
    const originalLeaf = pi.leafId;
    const originalEntryCount = pi.sessionManager.getEntries().length;
    pi.modelOutcome = "aborted";

    await expect(
      pi.navigateResult(target, { summarize: true }),
    ).resolves.toMatchObject({ cancelled: true, aborted: true });
    expect(preparations).toBe(1);
    expect(arrivals).toBe(0);

    pi.modelOutcome = "success";
    await pi.turn("retire the ambiguous proposal");
    expect(pi.leafId).toBe(originalLeaf);
    expect(pi.sessionManager.getEntries()).toHaveLength(originalEntryCount);

    await pi.turn("continue after proposal retirement");
    expect(pi.leafId).not.toBe(originalLeaf);
    expect(pi.sessionManager.getEntries().length).toBeGreaterThan(
      originalEntryCount,
    );
    expect(arrivals).toBe(0);
  });

  it("emits turn_end while active after the final message is publicly persisted", async () => {
    let observation:
      | {
          readonly idle: boolean;
          readonly leafId: string | null;
          readonly leafEntry: ReturnType<SessionManager["getEntry"]>;
          readonly eventMessage: unknown;
        }
      | undefined;
    const observer: ExtensionFactory = (pi) => {
      pi.on("turn_end", (event, context) => {
        const leafId = context.sessionManager.getLeafId();
        observation = {
          idle: context.isIdle(),
          leafId,
          leafEntry:
            leafId === null
              ? undefined
              : context.sessionManager.getEntry(leafId),
          eventMessage: event.message,
        };
      });
    };
    const pi = await startHarness({
      includeCyclotomy: false,
      afterCyclotomy: [{ name: "turn-observer", factory: observer }],
    });

    await pi.turn("observe the real turn boundary");

    expect(observation).toBeDefined();
    expect(observation?.idle).toBe(false);
    expect(observation?.leafId).toBe(pi.leafId);
    expect(observation?.leafEntry).toMatchObject({
      type: "message",
      message: { role: "assistant" },
    });
    if (observation?.leafEntry?.type !== "message") {
      throw new Error("turn_end leaf was not Pi's persisted final message");
    }
    expect(observation.leafEntry.message).toEqual(observation.eventMessage);
  });
});
