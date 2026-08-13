import {
  CURRENT_SESSION_VERSION,
  SessionManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  provenStableCoordinateIds,
  publicEntryIsTransparent,
  publicEntrySelectionLanding,
  type PublicSessionEntry,
} from "../src/pi/extension-boundary.ts";
import {
  persistedSessionIdentityOf,
  readPersistedSessionIdentity,
  readSessionView,
  SessionViewTracker,
} from "../src/pi/session-view.ts";

function context(manager: SessionManager): ExtensionContext {
  return {
    cwd: manager.getCwd(),
    sessionManager: manager,
  } as unknown as ExtensionContext;
}

interface RawContextOptions {
  readonly sessionId?: unknown;
  readonly cwd?: unknown;
  readonly sessionFile?: unknown;
  readonly header?: unknown;
  readonly entries?: unknown;
  readonly branch?: unknown;
  readonly leafId?: unknown;
}

function branchFrom(entries: unknown, leafId: unknown): unknown[] {
  if (!Array.isArray(entries) || typeof leafId !== "string") return [];
  const byId = new Map<unknown, Record<string, unknown>>();
  for (const value of entries) {
    if (typeof value === "object" && value !== null) {
      const record = value as Record<string, unknown>;
      byId.set(record.id, record);
    }
  }
  const reversed: unknown[] = [];
  const visited = new Set<unknown>();
  let id: unknown = leafId;
  while (typeof id === "string" && !visited.has(id)) {
    visited.add(id);
    const value = byId.get(id);
    if (value === undefined) break;
    reversed.push(value);
    id = value.parentId;
  }
  return reversed.reverse();
}

function rawContext(options: RawContextOptions = {}): ExtensionContext {
  const workspace = resolve("session-view-workspace");
  const sessionId = options.sessionId ?? "session";
  const cwd = options.cwd ?? workspace;
  const sessionFile =
    "sessionFile" in options
      ? options.sessionFile
      : join(workspace, "session.jsonl");
  const header =
    "header" in options
      ? options.header
      : {
          type: "session",
          version: CURRENT_SESSION_VERSION,
          id: sessionId,
          cwd,
        };
  const entries = options.entries ?? [];
  const leafId = "leafId" in options ? options.leafId : null;
  const branch =
    "branch" in options ? options.branch : branchFrom(entries, leafId);
  return {
    cwd,
    sessionManager: {
      getSessionId: () => sessionId,
      getCwd: () => cwd,
      getSessionFile: () => sessionFile,
      getHeader: () => header,
      getEntries: () => entries,
      getBranch: () => branch,
      getLeafId: () => leafId,
    },
  } as unknown as ExtensionContext;
}

function entry(
  id: unknown,
  parentId: unknown,
  type: unknown = "custom",
): Record<string, unknown> {
  return { id, parentId, type };
}

describe("trusted session snapshot boundary", () => {
  it("reads a persisted identity without observing any node coordinate", () => {
    const workspace = resolve("identity-only-workspace");
    const sessionFile = join(workspace, "session.jsonl");
    const parentSession = join(workspace, "parent.jsonl");
    const getEntries = () => {
      throw new Error("identity reader must not read entries");
    };
    const getLeafId = () => {
      throw new Error("identity reader must not read the leaf");
    };
    const getEntry = () => {
      throw new Error("identity reader must not look up an entry");
    };
    const identity = readPersistedSessionIdentity({
      cwd: workspace,
      sessionManager: {
        getSessionId: () => "session",
        getSessionFile: () => sessionFile,
        getCwd: () => workspace,
        getHeader: () => ({
          type: "session",
          version: CURRENT_SESSION_VERSION,
          id: "session",
          cwd: workspace,
          parentSession,
        }),
        getEntries,
        getLeafId,
        getEntry,
      },
    } as unknown as ExtensionContext);

    expect(identity).toEqual({
      sessionId: "session",
      sessionFile,
      cwd: workspace,
      sessionCwd: workspace,
      parentSession: { kind: "candidate", path: parentSession },
    });
    expect(Object.isFrozen(identity)).toBe(true);
    expect(Object.isFrozen(identity.parentSession)).toBe(true);
  });

  it("projects the current Pi API into one immutable graph", () => {
    const manager = SessionManager.inMemory(resolve("workspace"), { id: "s1" });
    const userId = manager.appendMessage({
      role: "user",
      content: "hello",
      timestamp: Date.now(),
    });
    const customId = manager.appendCustomMessageEntry("test", "context", false);
    const stateId = manager.appendThinkingLevelChange("high");
    const snapshot = readSessionView(context(manager));

    expect(snapshot).toMatchObject({
      sessionId: "s1",
      cwd: manager.getCwd(),
      sessionCwd: manager.getCwd(),
      sessionFile: null,
      parentSession: { kind: "absent" },
      leafId: stateId,
      stableEntryIds: [userId, customId, stateId],
      activeStableAncestryIds: [userId, customId, stateId],
    });
    expect(snapshot.stableAncestryIds(userId)).toEqual([userId]);
    expect(snapshot.stableAncestryIds(customId)).toEqual([userId, customId]);
    expect(snapshot.navigationLandingId(userId)).toBeNull();
    expect(snapshot.navigationLandingId(customId)).toBe(userId);
    expect(snapshot.navigationLandingId(stateId)).toBe(stateId);
    expect(snapshot.navigationLandingId("missing")).toBeUndefined();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.stableCoordinates)).toBe(true);
    expect(snapshot.stableCoordinates.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(snapshot.stableEntryIds)).toBe(true);
    expect(Object.isFrozen(snapshot.activeStableAncestryIds)).toBe(true);
    expect(readSessionView(context(manager)).isSameSnapshotAs(snapshot)).toBe(
      true,
    );
    expect(persistedSessionIdentityOf(snapshot)).toBeUndefined();
  });

  it("does not retain live SessionManager entries", () => {
    const rawEntry = {
      id: "entry",
      parentId: null,
      type: "message",
      message: { role: "user" },
    };
    const snapshot = readSessionView(
      rawContext({ entries: [rawEntry], leafId: "entry" }),
    );

    rawEntry.id = "changed";
    rawEntry.parentId = "changed-parent" as never;
    rawEntry.message.role = "assistant";

    expect(snapshot.stableCoordinates).toEqual([
      {
        id: "entry",
        stableParentId: null,
        type: "message",
        messageRole: "user",
      },
    ]);
    expect(snapshot.stableCoordinateId("changed")).toBeUndefined();
    expect(snapshot.navigationLandingId("entry")).toBeNull();
  });

  it("derives entry semantics solely from the detached public projection", () => {
    const projected = (
      type: string,
      messageRole: string | null = null,
    ): PublicSessionEntry =>
      Object.freeze({
        id: "entry",
        parentId: "parent",
        type,
        messageRole,
      });

    expect(publicEntrySelectionLanding(projected("message", "user"))).toBe(
      "parent",
    );
    expect(publicEntrySelectionLanding(projected("message", "assistant"))).toBe(
      "entry",
    );
    expect(publicEntryIsTransparent(projected("label"))).toBe(true);
    expect(publicEntryIsTransparent(projected("future_wrapper"))).toBe(false);
  });

  it.each([
    [
      "an object",
      (root: string): unknown => ({ path: join(root, "parent.jsonl") }),
      "invalid",
    ],
    ["an empty string", (): unknown => "", "invalid"],
    [
      "a canonical path",
      (root: string): unknown => join(root, "parent.jsonl"),
      "candidate",
    ],
  ])(
    "preserves a distinct parentSession claim for %s",
    async (_name, valueFor, expectedKind) => {
      const root = await mkdtemp(join(tmpdir(), "cyclotomy-session-view-"));
      const sessionFile = join(root, "session.jsonl");
      const parentSession = valueFor(root);
      await writeFile(
        sessionFile,
        `${JSON.stringify({
          type: "session",
          version: CURRENT_SESSION_VERSION,
          id: "boundary",
          timestamp: new Date(0).toISOString(),
          cwd: root,
          parentSession,
        })}\n`,
      );
      try {
        const manager = SessionManager.open(sessionFile);
        const claim = readSessionView(context(manager)).parentSession;
        expect(claim).toMatchObject(
          expectedKind === "candidate"
            ? { kind: "candidate", path: parentSession }
            : { kind: "invalid", reason: expect.any(String) },
        );
        expect(Object.isFrozen(claim)).toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("keeps a self-parent claim invalid rather than trusting it", () => {
    const workspace = resolve("session-view-workspace");
    const sessionFile = join(workspace, "session.jsonl");
    const snapshot = readSessionView(
      rawContext({
        sessionFile,
        header: {
          type: "session",
          version: CURRENT_SESSION_VERSION,
          id: "session",
          cwd: workspace,
          parentSession: sessionFile,
        },
      }),
    );
    expect(snapshot.parentSession).toMatchObject({ kind: "invalid" });
  });

  it.each([
    ["a numeric session id", { sessionId: 1 }, /session id/u],
    [
      "a header id mismatch",
      {
        header: {
          type: "session",
          version: CURRENT_SESSION_VERSION,
          id: "other",
          cwd: resolve("session-view-workspace"),
        },
      },
      /ids do not match/u,
    ],
    ["a missing header", { header: null }, /header is missing/u],
    [
      "a non-session header",
      {
        header: {
          type: "entry",
          version: CURRENT_SESSION_VERSION,
          id: "session",
          cwd: resolve("session-view-workspace"),
        },
      },
      /invalid type/u,
    ],
    ["a relative effective cwd", { cwd: "workspace" }, /effective cwd/u],
    [
      "a relative session file",
      { sessionFile: "session.jsonl" },
      /session file/u,
    ],
    [
      "a relative header cwd",
      {
        header: {
          type: "session",
          version: CURRENT_SESSION_VERSION,
          id: "session",
          cwd: "workspace",
        },
      },
      /session header cwd/u,
    ],
  ])("rejects %s", (_name, options, message) => {
    expect(() => readSessionView(rawContext(options))).toThrow(message);
  });

  it("does not second-guess a future header version already opened by Pi", () => {
    const snapshot = readSessionView(
      rawContext({
        header: {
          type: "session",
          version: CURRENT_SESSION_VERSION + 1,
          id: "session",
          cwd: resolve("session-view-workspace"),
        },
      }),
    );

    expect(snapshot.sessionId).toBe("session");
  });

  it.each([
    ["a non-object entry", [null], /non-object entry/u],
    ["a numeric id", [entry(1, null)], /entry id/u],
    ["an empty id", [entry("", null)], /entry id/u],
    ["an id containing NUL", [entry("bad\0id", null)], /entry id/u],
    [
      "duplicate ids",
      [entry("same", null), entry("same", null)],
      /duplicate entry id/u,
    ],
    ["a numeric parent", [entry("child", 1)], /entry parent id/u],
    ["an orphan", [entry("child", "absent")], /orphaned parent reference/u],
    [
      "a cycle outside the active branch",
      [entry("active", null), entry("left", "right"), entry("right", "left")],
      /parent cycle/u,
    ],
    [
      "a child serialized before its parent",
      [entry("child", "parent"), entry("parent", null)],
      /parent that follows its child/u,
    ],
    ["a numeric type", [entry("node", null, 1)], /entry type/u],
    [
      "a message without an object",
      [{ ...entry("node", null, "message"), message: null }],
      /message object/u,
    ],
    [
      "a numeric message role",
      [{ ...entry("node", null, "message"), message: { role: 1 } }],
      /message role/u,
    ],
  ])("rejects %s in the complete graph", (_name, entries, message) => {
    expect(() =>
      readSessionView(rawContext({ entries, leafId: null })),
    ).toThrow(message);
  });

  it.each([
    [
      "duplicates before parent defects",
      [entry("same", "absent"), entry("same", null)],
      /duplicate entry id/u,
    ],
    [
      "orphans before cycles",
      [
        entry("orphan", "absent"),
        entry("left", "right"),
        entry("right", "left"),
      ],
      /orphaned parent reference/u,
    ],
    [
      "cycles before append-order defects",
      [
        entry("child", "parent"),
        entry("parent", null),
        entry("left", "right"),
        entry("right", "left"),
      ],
      /parent cycle/u,
    ],
  ])("diagnoses %s", (_name, entries, message) => {
    expect(() =>
      readSessionView(rawContext({ entries, leafId: null })),
    ).toThrow(message);
  });

  it("validates a deeply retained graph with compact indexed state", () => {
    const entryCount = 50_000;
    const entries = Array.from({ length: entryCount }, (_, index) =>
      entry(`node-${index}`, index === 0 ? null : `node-${index - 1}`),
    );

    const snapshot = readSessionView(rawContext({ entries, leafId: null }));
    expect(snapshot.stableEntryIds).toHaveLength(entryCount);
    expect(snapshot.stableAncestryIds(`node-${entryCount - 1}`)).toHaveLength(
      entryCount,
    );
  }, 30_000);

  it("rejects disagreement between Pi's public tree and branch views", () => {
    const root = entry("root", null);
    const child = entry("child", "root");
    expect(() =>
      readSessionView(
        rawContext({
          entries: [root, child],
          branch: [root, { ...child, type: "model_change" }],
          leafId: "child",
        }),
      ),
    ).toThrow(/entries and active branch disagree/u);
  });

  it("rejects a leaf change that tears a synchronous public observation", () => {
    const root = entry("root", null);
    const child = entry("child", "root");
    let leafId = "root";
    const tearing = rawContext({ entries: [root, child], leafId });
    tearing.sessionManager = {
      ...tearing.sessionManager,
      getEntries: () => [root, child],
      getBranch: () => {
        leafId = "child";
        return [root];
      },
      getLeafId: () => leafId,
    } as unknown as ExtensionContext["sessionManager"];

    expect(() => readSessionView(tearing)).toThrow(
      /leaf changed during observation/u,
    );
  });

  it("captures the public manager once for a complete observation", () => {
    const raw = rawContext();
    const manager = raw.sessionManager;
    let reads = 0;
    const observed = {
      ...raw,
      get sessionManager() {
        reads += 1;
        return manager;
      },
    } as ExtensionContext;

    readSessionView(observed);
    expect(reads).toBe(1);
  });

  it("keeps a future entry type as an opaque stable coordinate", () => {
    const snapshot = readSessionView(
      rawContext({
        entries: [entry("future", null, "future_wrapper")],
        leafId: "future",
      }),
    );

    expect(snapshot.stableCoordinates[0]?.type).toBe("future_wrapper");
    expect(snapshot.stableEntryIds).toEqual(["future"]);
    expect(snapshot.activeStableAncestryIds).toEqual(["future"]);
    expect(snapshot.navigationLandingId("future")).toBe("future");
  });

  it("uses one unbounded stable projection for inactive ancestry", () => {
    const depth = 10_050;
    const inactive = Array.from({ length: depth }, (_, index) =>
      entry(
        `inactive-${index}`,
        index === 0 ? "root" : `inactive-${index - 1}`,
      ),
    );
    const root = entry("root", null);
    const active = entry("active", "root");
    const snapshot = readSessionView(
      rawContext({
        entries: [root, ...inactive, active],
        branch: [root, active],
        leafId: "active",
      }),
    );

    expect(snapshot.stableAncestryIds(`inactive-${depth - 1}`)).toHaveLength(
      depth + 1,
    );
    expect(snapshot.stableAncestryIds("active")).toBe(
      snapshot.activeStableAncestryIds,
    );
  });

  it("authenticates tree summaries through one semantic host boundary", () => {
    const snapshot = readSessionView(
      rawContext({
        entries: [
          entry("summary", null, "branch_summary"),
          entry("label", "summary", "label"),
          entry("ordinary", null),
        ],
        branch: [
          entry("summary", null, "branch_summary"),
          entry("label", "summary", "label"),
        ],
        leafId: "label",
      }),
    );
    const expectation = {
      sessionId: snapshot.sessionId,
      cwd: snapshot.cwd,
      expectedOldLeafId: "old",
      expectedDestinationId: null,
    } as const;
    const summaryEntry = {
      type: "branch_summary",
      id: "summary",
      parentId: null,
      timestamp: new Date(0).toISOString(),
      fromId: "old",
      summary: "summary",
    } as const;

    expect(
      snapshot.authenticateTreeArrival(
        {
          type: "session_tree",
          oldLeafId: "old",
          newLeafId: "label",
          summaryEntry,
        },
        expectation,
      ),
    ).toEqual({
      kind: "summary",
      landingId: "summary",
      summaryEntryId: "summary",
      summaryParentLandingId: null,
    });
    expect(
      snapshot.authenticateTreeArrival(
        {
          type: "session_tree",
          oldLeafId: "old",
          newLeafId: "label",
          summaryEntry: { ...summaryEntry, id: "ordinary" },
        },
        expectation,
      ),
    ).toBeUndefined();
  });

  it("collapses selected labels and authenticates a transparent root arrival", () => {
    const rooted = readSessionView(
      rawContext({
        entries: [entry("stable", null), entry("label", "stable", "label")],
        leafId: "label",
      }),
    );
    expect(rooted.navigationLandingId("label")).toBe("stable");

    const rootLabel = readSessionView(
      rawContext({
        entries: [entry("label", null, "label")],
        leafId: "label",
      }),
    );
    expect(rootLabel.navigationLandingId("label")).toBeNull();
    expect(
      rootLabel.authenticateTreeArrival(
        {
          type: "session_tree",
          oldLeafId: "old",
          newLeafId: "label",
        },
        {
          sessionId: rootLabel.sessionId,
          cwd: rootLabel.cwd,
          expectedOldLeafId: "old",
          expectedDestinationId: null,
        },
      ),
    ).toEqual({ kind: "direct", landingId: null });
  });

  it("treats an extension-defined message role as a stable self landing", () => {
    const snapshot = readSessionView(
      rawContext({
        entries: [
          {
            ...entry("node", null, "message"),
            message: { role: "extension-role" },
          },
        ],
        leafId: "node",
      }),
    );
    expect(snapshot.navigationLandingId("node")).toBe("node");
  });

  it.each([
    ["a numeric leaf", 1, /session leaf id/u],
    ["an unknown leaf", "missing", /branch does not end at its leaf/u],
  ])("rejects %s", (_name, leafId, message) => {
    expect(() =>
      readSessionView(rawContext({ entries: [entry("root", null)], leafId })),
    ).toThrow(message);
  });

  it("accepts multiple append-only roots created by Pi root navigation", () => {
    const snapshot = readSessionView(
      rawContext({
        entries: [entry("first", null), entry("second", null)],
        leafId: "second",
      }),
    );
    expect(snapshot.stableEntryIds).toEqual(["first", "second"]);
    expect(snapshot.activeStableAncestryIds).toEqual(["second"]);
  });

  it("proves exact append-only graph extensions and stable descendants", () => {
    const manager = SessionManager.inMemory(resolve("workspace"), { id: "s1" });
    const parentId = manager.appendThinkingLevelChange("low");
    const previous = readSessionView(context(manager));
    const childId = manager.appendThinkingLevelChange("high");
    const current = readSessionView(context(manager));

    expect(previous.stableCoordinateId(childId)).toBeUndefined();
    expect(current.isAppendOnlyExtensionOf(previous)).toBe(true);
    expect(current.isNaturalDescendantOf(previous, parentId, childId)).toBe(
      true,
    );
    expect(current.isNaturalDescendantOf(previous, null, childId)).toBe(false);
    expect(current.isSameSnapshotAs(previous)).toBe(false);
    expect(current.hasSameIdentityAs(previous)).toBe(true);
    expect(readSessionView(context(manager)).isSameSnapshotAs(current)).toBe(
      true,
    );
  });

  it("does not mistake navigation to an existing child for a natural append", () => {
    const manager = SessionManager.inMemory(resolve("workspace"), { id: "s1" });
    const parentId = manager.appendThinkingLevelChange("low");
    const childId = manager.appendThinkingLevelChange("high");
    manager.branch(parentId);
    const previous = readSessionView(context(manager));
    manager.branch(childId);
    const current = readSessionView(context(manager));

    expect(current.isAppendOnlyExtensionOf(previous)).toBe(true);
    expect(current.isNaturalDescendantOf(previous, parentId, childId)).toBe(
      false,
    );
  });

  it("treats retained labels as transparent stable-lineage wrappers", () => {
    const manager = SessionManager.inMemory(resolve("workspace"), { id: "s1" });
    const parentId = manager.appendThinkingLevelChange("low");
    const labelId = manager.appendLabelChange(parentId, "bookmark");
    const previous = readSessionView(context(manager));
    const childId = manager.appendThinkingLevelChange("high");
    const current = readSessionView(context(manager));

    expect(previous.leafId).toBe(labelId);
    expect(previous.stableEntryIds).toEqual([parentId]);
    expect(previous.activeStableAncestryIds).toEqual([parentId]);
    expect(current.isNaturalDescendantOf(previous, parentId, childId)).toBe(
      true,
    );
  });

  it("treats arbitrary label chains as transparent on the public branch", () => {
    const entries = [
      entry("root", null),
      entry("label-1", "root", "label"),
      entry("label-2", "label-1", "label"),
      entry("child", "label-2"),
      entry("label-3", "child", "label"),
    ];
    const snapshot = readSessionView(
      rawContext({ entries, leafId: "label-3" }),
    );

    expect(snapshot.stableEntryIds).toEqual(["root", "child"]);
    expect(snapshot.stableCoordinates).toEqual([
      {
        id: "root",
        stableParentId: null,
        type: "custom",
        messageRole: null,
      },
      {
        id: "child",
        stableParentId: "root",
        type: "custom",
        messageRole: null,
      },
    ]);
    expect(Object.isFrozen(snapshot.stableCoordinates)).toBe(true);
    expect(snapshot.stableCoordinates.every(Object.isFrozen)).toBe(true);
    expect(snapshot.activeStableAncestryIds).toEqual(["root", "child"]);
  });

  it("proves only an ordered, ancestry-closed stable intersection", () => {
    const coordinate = (
      id: string,
      stableParentId: string | null,
      type = "custom",
    ) => ({ id, stableParentId, type, messageRole: null });

    expect(
      provenStableCoordinateIds(
        [coordinate("root", null), coordinate("child", "root")],
        [coordinate("root", null, "session_info"), coordinate("child", "root")],
      ),
    ).toEqual([]);
    expect(
      provenStableCoordinateIds(
        [coordinate("first", null), coordinate("second", null)],
        [coordinate("second", null), coordinate("first", null)],
      ),
    ).toEqual(["second"]);
  });

  it("proves the first stable node appended after an empty root", () => {
    const manager = SessionManager.inMemory(resolve("workspace"), { id: "s1" });
    const previous = readSessionView(context(manager));
    const firstId = manager.appendThinkingLevelChange("high");
    const current = readSessionView(context(manager));

    expect(current.isNaturalDescendantOf(previous, null, firstId)).toBe(true);
  });

  it("observes an append-only deep suffix without rescanning retained entries", () => {
    const workspace = resolve("session-view-workspace");
    const retained: Record<string, unknown>[] = [entry("root", null)];
    let leafId = "root";
    let getEntriesCalls = 0;
    let getBranchCalls = 0;
    const incrementalContext = rawContext();
    incrementalContext.sessionManager = {
      ...incrementalContext.sessionManager,
      getSessionId: () => "session",
      getCwd: () => workspace,
      getSessionFile: () => join(workspace, "session.jsonl"),
      getHeader: () => ({
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: "session",
        cwd: workspace,
      }),
      getEntries: () => {
        getEntriesCalls += 1;
        return retained;
      },
      getBranch: () => {
        getBranchCalls += 1;
        return branchFrom(retained, leafId);
      },
      getLeafId: () => leafId,
    } as unknown as ExtensionContext["sessionManager"];

    const tracker = new SessionViewTracker();
    const previous = tracker.bootstrap(incrementalContext);
    const appendedCount = 20_000;
    let parentId = "root";
    for (let index = 0; index < appendedCount; index += 1) {
      const id = `node-${index}`;
      const value = entry(id, parentId);
      retained.push(value);
      parentId = id;
    }
    leafId = parentId;

    const current = tracker.observe(incrementalContext);
    expect(getEntriesCalls).toBe(1);
    expect(getBranchCalls).toBe(2);
    expect(previous.stableEntryIds).toHaveLength(1);
    expect(previous.stableCoordinateId("node-0")).toBeUndefined();
    expect(current.activeStableAncestryIds).toHaveLength(appendedCount + 1);
    expect(current.isNaturalDescendantOf(previous, "root", parentId)).toBe(
      true,
    );

    const unchanged = tracker.observe(incrementalContext);
    expect(getEntriesCalls).toBe(1);
    expect(getBranchCalls).toBe(3);
    expect(unchanged).toBe(current);
  }, 30_000);

  it("reconciles a later full graph that reveals an inactive appended sibling", () => {
    const manager = SessionManager.inMemory(resolve("workspace"), { id: "s1" });
    const rootId = manager.appendThinkingLevelChange("low");
    const tracker = new SessionViewTracker();
    tracker.bootstrap(context(manager));

    const hiddenSiblingId = manager.appendThinkingLevelChange("high");
    manager.branch(rootId);
    const activeChildId = manager.appendModelChange("provider", "model");
    const incremental = tracker.observe(context(manager));
    const complete = readSessionView(context(manager));

    expect(incremental.stableCoordinateId(hiddenSiblingId)).toBeUndefined();
    expect(complete.isAppendOnlyExtensionOf(incremental)).toBe(true);
    expect(
      complete.isNaturalDescendantOf(incremental, rootId, activeChildId),
    ).toBe(false);
  });

  it("rejects a cross-graph reorder of already trusted siblings", () => {
    const root = entry("root", null);
    const left = entry("left", "root");
    const right = entry("right", "root");
    const previous = readSessionView(
      rawContext({ entries: [root, left, right], leafId: "left" }),
    );
    const reordered = readSessionView(
      rawContext({ entries: [root, right, left], leafId: "left" }),
    );

    expect(reordered.isAppendOnlyExtensionOf(previous)).toBe(false);
  });

  it("rejects insertion into a prefix previously observed in full", () => {
    const root = entry("root", null);
    const child = entry("child", "root");
    const previous = readSessionView(
      rawContext({ entries: [root, child], leafId: "child" }),
    );
    const inserted = entry("inserted", "root");
    const current = readSessionView(
      rawContext({ entries: [root, inserted, child], leafId: "child" }),
    );

    expect(current.isAppendOnlyExtensionOf(previous)).toBe(false);
  });

  it("authenticates the known anchor before accepting an incremental suffix", () => {
    const workspace = resolve("session-view-workspace");
    const root = entry("root", null);
    const child = entry("child", "root");
    const retained = [root];
    let leafId = "root";
    const incrementalContext = rawContext();
    incrementalContext.sessionManager = {
      ...incrementalContext.sessionManager,
      getEntries: () => retained,
      getBranch: () => branchFrom(retained, leafId),
      getLeafId: () => leafId,
      getCwd: () => workspace,
      getSessionFile: () => join(workspace, "session.jsonl"),
      getHeader: () => ({
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: "session",
        cwd: workspace,
      }),
    } as unknown as ExtensionContext["sessionManager"];

    const tracker = new SessionViewTracker();
    tracker.bootstrap(incrementalContext);
    retained.push(child);
    root.type = "label";
    leafId = "child";

    expect(() => tracker.observe(incrementalContext)).toThrow(
      /changed a retained session entry/u,
    );
  });

  it("keeps full revalidation as the session replacement trust gate", () => {
    const workspace = resolve("session-view-workspace");
    const retained = [entry("root", null)];
    let getEntriesCalls = 0;
    const incrementalContext = rawContext();
    incrementalContext.sessionManager = {
      ...incrementalContext.sessionManager,
      getEntries: () => {
        getEntriesCalls += 1;
        return retained;
      },
      getBranch: () => branchFrom(retained, "root"),
      getLeafId: () => "root",
      getCwd: () => workspace,
      getSessionFile: () => join(workspace, "session.jsonl"),
      getHeader: () => ({
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: "session",
        cwd: workspace,
      }),
    } as unknown as ExtensionContext["sessionManager"];

    const tracker = new SessionViewTracker();
    tracker.bootstrap(incrementalContext);
    const hidden = entry("hidden", "root");
    retained.push(hidden);

    expect(
      tracker.observe(incrementalContext).stableCoordinateId("hidden"),
    ).toBeUndefined();
    expect(
      tracker.revalidate(incrementalContext).stableCoordinateId("hidden"),
    ).toBe("hidden");
    expect(getEntriesCalls).toBe(2);
  });

  it("rebuilds the true append order when an older hidden sibling becomes active", () => {
    const workspace = resolve("session-view-workspace");
    const root = entry("root", null);
    const hidden = entry("hidden", "root");
    const active = entry("active", "root");
    const retained = [root];
    let leafId = "root";
    let getEntriesCalls = 0;
    const incrementalContext = rawContext();
    incrementalContext.sessionManager = {
      ...incrementalContext.sessionManager,
      getEntries: () => {
        getEntriesCalls += 1;
        return retained;
      },
      getBranch: () => branchFrom(retained, leafId),
      getLeafId: () => leafId,
      getCwd: () => workspace,
      getSessionFile: () => join(workspace, "session.jsonl"),
      getHeader: () => ({
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: "session",
        cwd: workspace,
      }),
    } as unknown as ExtensionContext["sessionManager"];

    const tracker = new SessionViewTracker();
    tracker.bootstrap(incrementalContext);
    retained.push(hidden, active);
    leafId = "active";
    expect(tracker.observe(incrementalContext).stableEntryIds).toEqual([
      "root",
      "active",
    ]);
    expect(getEntriesCalls).toBe(1);

    leafId = "hidden";
    const observed = tracker.observe(incrementalContext);
    const full = readSessionView(incrementalContext);
    expect(observed.stableEntryIds).toEqual(["root", "hidden", "active"]);
    expect(observed.isSameSnapshotAs(full)).toBe(true);
    expect(getEntriesCalls).toBe(3);
  });
});
