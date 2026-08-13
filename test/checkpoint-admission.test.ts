import { describe, expect, it } from "vitest";

import type { NodeKey } from "../src/domain/model.ts";
import { CheckpointAdmission } from "../src/pi/checkpoint-admission.ts";
import type { PublicSessionEntry } from "../src/pi/extension-boundary.ts";
import type { SessionView } from "../src/pi/session-view.ts";
import type { PendingNavigation } from "../src/pi/navigation-plan.ts";

interface TestEntry {
  readonly id: string;
  readonly parentId: string | null;
  readonly type?: string;
  readonly messageRole?: string | null;
}

interface TestView extends SessionView {
  readonly projection: readonly PublicSessionEntry[];
  isAppendOnlyExtensionOf(previous: SessionView): boolean;
  isNaturalDescendantOf(
    previous: SessionView,
    ancestorEntryId: string | null,
    descendantEntryId: string,
  ): boolean;
}

function isProjectionPrefix(
  previous: readonly PublicSessionEntry[],
  current: readonly PublicSessionEntry[],
): boolean {
  return (
    previous.length <= current.length &&
    previous.every((entry, index) => {
      const candidate = current[index];
      return (
        candidate !== undefined &&
        candidate.id === entry.id &&
        candidate.parentId === entry.parentId &&
        candidate.type === entry.type &&
        candidate.messageRole === entry.messageRole
      );
    })
  );
}

function view(
  overrides: Partial<
    Pick<
      SessionView,
      "sessionId" | "sessionFile" | "cwd" | "sessionCwd" | "leafId"
    >
  > & { readonly entries?: readonly TestEntry[] } = {},
): TestView {
  const { entries: entryInputs = [], ...identityOverrides } = overrides;
  const projection = Object.freeze(
    [...entryInputs].map((entry) =>
      Object.freeze({
        id: entry.id,
        parentId: entry.parentId,
        type: entry.type ?? "message",
        messageRole: entry.messageRole ?? null,
      }),
    ),
  );
  const byId = new Map(projection.map((entry) => [entry.id, entry]));
  const leafId: string | null =
    identityOverrides.leafId === undefined ? "leaf" : identityOverrides.leafId;
  const activeStableAncestryIds: string[] = [];
  let activeId = leafId;
  while (activeId !== null) {
    const entry = byId.get(activeId);
    if (entry === undefined) break;
    if (entry.type !== "label") activeStableAncestryIds.push(entry.id);
    activeId = entry.parentId;
  }
  activeStableAncestryIds.reverse();
  const result: TestView = {
    sessionId: "session",
    sessionFile: "/sessions/session.jsonl",
    cwd: "/workspace",
    sessionCwd: "/workspace",
    parentSession: { kind: "absent" },
    leafId,
    // CheckpointAdmission consumes the graph-proof methods below, not fork
    // coordinates. Some adversarial fixtures intentionally model a rewritten
    // graph that the public snapshot boundary itself would reject.
    stableCoordinates: Object.freeze([]),
    stableEntryIds: Object.freeze(
      projection
        .filter((entry) => entry.type !== "label")
        .map((entry) => entry.id),
    ),
    activeStableAncestryIds: Object.freeze(activeStableAncestryIds),
    projection,
    stableCoordinateId(entryId = leafId) {
      let current = entryId;
      while (current !== null) {
        const entry = byId.get(current);
        if (entry === undefined) return undefined;
        if (entry.type !== "label") return current;
        current = entry.parentId;
      }
      return null;
    },
    stableAncestryIds(entryId = leafId) {
      const ids: string[] = [];
      let current = entryId;
      while (current !== null) {
        const entry = byId.get(current);
        if (entry === undefined) return undefined;
        if (entry.type !== "label") ids.push(entry.id);
        current = entry.parentId;
      }
      return Object.freeze(ids.reverse());
    },
    navigationLandingId: () => undefined,
    authenticateTreeArrival: () => undefined,
    hasSameIdentityAs(other) {
      return (
        other.sessionId === result.sessionId &&
        other.sessionFile === result.sessionFile &&
        other.cwd === result.cwd &&
        other.sessionCwd === result.sessionCwd &&
        other.parentSession.kind === result.parentSession.kind
      );
    },
    isSameSnapshotAs(other) {
      const candidate = other as TestView;
      return (
        result.hasSameIdentityAs(other) &&
        other.leafId === result.leafId &&
        Array.isArray(candidate.projection) &&
        candidate.projection.length === projection.length &&
        isProjectionPrefix(projection, candidate.projection)
      );
    },
    isAppendOnlyExtensionOf(previous) {
      const source = previous as TestView;
      return (
        source.sessionId === result.sessionId &&
        source.sessionFile === result.sessionFile &&
        source.cwd === result.cwd &&
        source.sessionCwd === result.sessionCwd &&
        Array.isArray(source.projection) &&
        isProjectionPrefix(source.projection, projection)
      );
    },
    isNaturalDescendantOf(previous, ancestorEntryId, descendantEntryId) {
      if (!result.isAppendOnlyExtensionOf(previous)) return false;
      const source = previous as TestView;
      const oldIds = new Set(source.projection.map((entry) => entry.id));
      const descendant = byId.get(descendantEntryId);
      if (
        descendant === undefined ||
        descendant.type === "label" ||
        oldIds.has(descendantEntryId)
      ) {
        return false;
      }
      const visited = new Set<string>();
      let entryId: string | null = descendantEntryId;
      while (entryId !== null) {
        if (visited.has(entryId)) return false;
        visited.add(entryId);
        const entry = byId.get(entryId);
        if (entry === undefined) return false;
        if (oldIds.has(entryId) && entry.type !== "label") {
          return entryId === ancestorEntryId;
        }
        entryId = entry.parentId;
      }
      return ancestorEntryId === null;
    },
    ...identityOverrides,
  };
  return Object.freeze(result);
}

function node(entryId: string): NodeKey {
  return { sessionId: "session", entryId };
}

const parentEntry: TestEntry = {
  id: "parent",
  parentId: null,
  type: "message",
};

describe("checkpoint admission", () => {
  it("does not let a stale preparation clear its post-reset replacement", async () => {
    const admission = new CheckpointAdmission();
    let releaseStale!: () => void;
    const staleBlocked = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    const stale = admission.runPreparation(async () => {
      await staleBlocked;
      return "stale";
    });
    admission.reset();
    let releaseCurrent!: () => void;
    const currentBlocked = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const current = admission.runPreparation(async () => {
      await currentBlocked;
      return "current";
    });
    releaseStale();
    expect(await stale).toEqual({ kind: "stale" });

    releaseCurrent();
    expect(await current).toEqual({ kind: "completed", value: "current" });
  });

  it("makes a hanging preparation stale when tree arrival begins", async () => {
    const admission = new CheckpointAdmission();
    const current = view({ leafId: "parent", entries: [parentEntry] });
    admission.admit(current, node("parent"));

    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const preparation = admission.runPreparation(async () => {
      await blocked;
      return "prepared";
    });

    const arrival = admission.beginTreeArrival();
    expect(arrival.planned).toBe(false);
    release();

    await expect(preparation).resolves.toEqual({ kind: "stale" });
    expect(admission.closeArrival(arrival)).toBe(true);
  });

  it("makes a hanging preparation stale across an equal-looking admission replacement", async () => {
    const admission = new CheckpointAdmission();
    const current = view({ leafId: "parent", entries: [parentEntry] });
    const parent = node("parent");
    admission.admit(current, parent);

    let releaseStale!: () => void;
    const staleBlocked = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    const stale = admission.runPreparation(async () => {
      await staleBlocked;
      return "stale";
    });

    admission.admit(current, parent);
    let releaseReplacement!: () => void;
    const replacementBlocked = new Promise<void>((resolve) => {
      releaseReplacement = resolve;
    });
    const replacement = admission.runPreparation(async () => {
      await replacementBlocked;
      return "replacement";
    });

    releaseStale();
    await expect(stale).resolves.toEqual({ kind: "stale" });
    expect(admission.rejectTransitionConflict()).toBe(true);

    releaseReplacement();
    await expect(replacement).resolves.toEqual({
      kind: "completed",
      value: "replacement",
    });
  });

  it("keeps its permit while proving natural append-only progress", async () => {
    const admission = new CheckpointAdmission();
    const parentView = view({ leafId: "parent", entries: [parentEntry] });
    admission.admit(parentView, node("parent"));
    const childView = view({
      leafId: "child",
      entries: [
        parentEntry,
        { id: "child", parentId: "parent", type: "message" },
      ],
    });

    await expect(
      admission.runPreparation(async () => {
        expect(
          admission.decideCapture({
            view: childView,
            node: node("child"),
            writeProtected: false,
          }).kind,
        ).toBe("capture");
        return "prepared";
      }),
    ).resolves.toEqual({ kind: "completed", value: "prepared" });
  });

  it("releases permits after throws and cancellation, with stale taking precedence", async () => {
    const admission = new CheckpointAdmission();
    const failure = new Error("injected preparation failure");

    await expect(
      admission.runPreparation(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    await expect(
      admission.runPreparation(async () => "after-throw"),
    ).resolves.toEqual({ kind: "completed", value: "after-throw" });

    await expect(
      admission.runTreePreparation(async () => undefined),
    ).resolves.toEqual({ kind: "cancelled" });
    await expect(
      admission.runPreparation(async () => "after-cancel"),
    ).resolves.toEqual({ kind: "completed", value: "after-cancel" });

    let releaseStaleCancellation!: () => void;
    const staleCancellationBlocked = new Promise<void>((resolve) => {
      releaseStaleCancellation = resolve;
    });
    const staleCancellation = admission.runTreePreparation(async () => {
      await staleCancellationBlocked;
      return undefined;
    });
    admission.reset();
    releaseStaleCancellation();
    await expect(staleCancellation).resolves.toEqual({ kind: "stale" });
  });

  it("makes a hanging preparation stale at a destructive cutover", async () => {
    const admission = new CheckpointAdmission();
    const current = view({ leafId: "parent", entries: [parentEntry] });
    const parent = node("parent");
    admission.admit(current, parent);

    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const preparation = admission.runPreparation(async () => {
      await blocked;
      return "prepared";
    });

    expect(admission.cutoverMutation(current, parent)).toBe(true);
    release();
    await expect(preparation).resolves.toEqual({ kind: "stale" });
  });

  it("does not let a stale tree preparation publish across reset and replacement", async () => {
    const admission = new CheckpointAdmission();
    const current = view({ leafId: "parent", entries: [parentEntry] });
    const parent = node("parent");
    admission.admit(current, parent);

    let releaseStale!: () => void;
    const staleBlocked = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    const stalePlan: PendingNavigation = {
      sessionId: "session",
      cwd: "/workspace",
      expectedOldLeafId: "parent",
      expectedDestinationId: null,
      previewSnapshot: undefined,
      target: { kind: "no-node" },
    };
    const stale = admission.runTreePreparation(async () => {
      await staleBlocked;
      return stalePlan;
    });
    // Model a complete runtime replacement with the same public coordinates:
    // object identity, not value inequality, must close the ABA window.
    admission.reset();
    admission.admit(current, parent);
    const replacementLease = admission.decideCapture({
      view: current,
      node: parent,
      writeProtected: false,
    });
    expect(replacementLease.kind).toBe("capture");

    let releaseReplacement!: () => void;
    const replacementBlocked = new Promise<void>((resolve) => {
      releaseReplacement = resolve;
    });
    const replacementPlan: PendingNavigation = {
      ...stalePlan,
      expectedDestinationId: "parent",
      target: { kind: "same-location", node: parent },
    };
    const replacement = admission.runTreePreparation(async () => {
      await replacementBlocked;
      return replacementPlan;
    });
    releaseStale();
    await expect(stale).resolves.toEqual({ kind: "stale" });
    if (replacementLease.kind === "capture") {
      expect(
        admission.leaseIsCurrent(replacementLease.lease, current, parent),
      ).toBe(true);
    }

    releaseReplacement();
    await expect(replacement).resolves.toEqual({ kind: "accepted" });
    const arrival = admission.beginTreeArrival();
    expect(arrival.planned).toBe(true);
    expect(arrival.plan).toBe(replacementPlan);
    expect(arrival.plan).not.toBe(stalePlan);
  });

  it("carries a raw-leaf rewrite of one authenticated stable anchor", () => {
    const admission = new CheckpointAdmission();
    const stable = node("stable");
    const before = view({
      leafId: "stable",
      entries: [{ id: "stable", parentId: null, type: "message" }],
    });
    const after = view({
      leafId: "label",
      entries: [
        { id: "stable", parentId: null, type: "message" },
        { id: "label", parentId: "stable", type: "label" },
      ],
    });
    admission.admit(before, stable);

    const decision = admission.decideCapture({
      view: after,
      node: stable,
      writeProtected: false,
    });
    expect(decision.kind).toBe("capture");
    if (decision.kind === "capture") {
      expect(admission.leaseIsCurrent(decision.lease, after, stable)).toBe(
        true,
      );
    }
  });

  it("does not confuse two stable anchors at the same raw leaf", () => {
    const admission = new CheckpointAdmission();
    const current = view({
      entries: [
        { id: "stable-a", parentId: null },
        { id: "stable-b", parentId: "stable-a" },
      ],
    });
    admission.admit(current, node("stable-a"));

    expect(
      admission.decideCapture({
        view: current,
        node: node("stable-b"),
        writeProtected: false,
      }),
    ).toEqual({ kind: "not-admitted" });
  });

  it("derives natural descent from an append-only graph snapshot", () => {
    const admission = new CheckpointAdmission();
    const parentView = view({ leafId: "parent", entries: [parentEntry] });
    admission.admit(parentView, node("parent"));

    const childView = view({
      leafId: "child",
      entries: [
        parentEntry,
        { id: "child", parentId: "parent", type: "message" },
      ],
    });
    const decision = admission.decideCapture({
      view: childView,
      node: node("child"),
      writeProtected: false,
    });
    expect(decision.kind).toBe("capture");
  });

  it("allows a new stable child through a pre-existing label wrapper", () => {
    const admission = new CheckpointAdmission();
    const prior: readonly TestEntry[] = [
      parentEntry,
      { id: "label", parentId: "parent", type: "label" },
    ];
    const parentView = view({ leafId: "label", entries: prior });
    admission.admit(parentView, node("parent"));
    const childView = view({
      leafId: "child",
      entries: [...prior, { id: "child", parentId: "label", type: "message" }],
    });

    expect(
      admission.decideCapture({
        view: childView,
        node: node("child"),
        writeProtected: false,
      }).kind,
    ).toBe("capture");
  });

  it("blocks navigation to a child that already existed in the source graph", () => {
    const admission = new CheckpointAdmission();
    const entries: readonly TestEntry[] = [
      parentEntry,
      { id: "existing-child", parentId: "parent", type: "message" },
    ];
    const parentView = view({ leafId: "parent", entries });
    admission.admit(parentView, node("parent"));
    const childView = view({ leafId: "existing-child", entries });

    expect(
      admission.decideCapture({
        view: childView,
        node: node("existing-child"),
        writeProtected: false,
      }),
    ).toEqual({ kind: "not-admitted" });
  });

  it("blocks descent when an existing graph coordinate was rewritten", () => {
    const admission = new CheckpointAdmission();
    const parentView = view({ leafId: "parent", entries: [parentEntry] });
    admission.admit(parentView, node("parent"));
    const rewritten = view({
      leafId: "child",
      entries: [
        { ...parentEntry, parentId: "forged-root" },
        { id: "child", parentId: "parent", type: "message" },
      ],
    });

    expect(
      admission.decideCapture({
        view: rewritten,
        node: node("child"),
        writeProtected: false,
      }),
    ).toEqual({ kind: "not-admitted" });
  });

  it("admits the first stable child below an authenticated root editor", () => {
    const admission = new CheckpointAdmission();
    admission.admit(view({ leafId: null, entries: [] }), undefined);
    const first = view({
      leafId: "first",
      entries: [{ id: "first", parentId: null, type: "message" }],
    });

    expect(
      admission.decideCapture({
        view: first,
        node: node("first"),
        writeProtected: false,
      }).kind,
    ).toBe("capture");
  });

  it("carries an authenticated root editor through a label wrapper", () => {
    const admission = new CheckpointAdmission();
    admission.admit(view({ leafId: null, entries: [] }), undefined);
    const labeled = view({
      leafId: "root-label",
      entries: [{ id: "root-label", parentId: null, type: "label" }],
    });

    expect(
      admission.decideCapture({
        view: labeled,
        node: undefined,
        writeProtected: false,
      }),
    ).toEqual({ kind: "no-coordinate" });

    const first = view({
      leafId: "first",
      entries: [
        { id: "root-label", parentId: null, type: "label" },
        { id: "first", parentId: "root-label", type: "message" },
      ],
    });
    expect(
      admission.decideCapture({
        view: first,
        node: node("first"),
        writeProtected: false,
      }).kind,
    ).toBe("capture");
  });

  it("blocks an unplanned sibling instead of silently admitting it", () => {
    const admission = new CheckpointAdmission();
    const left = view({
      leafId: "left",
      entries: [
        { id: "root", parentId: null },
        { id: "left", parentId: "root" },
        { id: "right", parentId: "root" },
      ],
    });
    admission.admit(left, node("left"));
    const siblingView = view({
      leafId: "right",
      entries: left.projection,
    });

    expect(
      admission.decideCapture({
        view: siblingView,
        node: node("right"),
        writeProtected: false,
      }),
    ).toEqual({ kind: "not-admitted" });
  });

  it("revokes capture and old leases synchronously when tree arrival begins", async () => {
    const admission = new CheckpointAdmission();
    const current = view({
      leafId: "parent",
      entries: [parentEntry],
    });
    const parent = node("parent");
    admission.admit(current, parent);
    const decision = admission.decideCapture({
      view: current,
      node: parent,
      writeProtected: false,
    });
    expect(decision.kind).toBe("capture");
    if (decision.kind !== "capture") return;

    const plan: PendingNavigation = {
      sessionId: "session",
      cwd: "/workspace",
      expectedOldLeafId: "parent",
      expectedDestinationId: null,
      previewSnapshot: undefined,
      target: { kind: "no-node" },
    };
    await expect(
      admission.runTreePreparation(async () => plan),
    ).resolves.toEqual({ kind: "accepted" });
    const attempt = admission.beginTreeArrival();

    expect(attempt.planned).toBe(true);
    expect(attempt.plan).toBe(plan);
    expect(admission.leaseIsCurrent(decision.lease, current, parent)).toBe(
      false,
    );
    expect(
      admission.decideCapture({
        view: current,
        node: parent,
        writeProtected: false,
      }),
    ).toEqual({ kind: "not-admitted" });
    expect(admission.closeArrival(attempt)).toBe(true);
    expect(admission.closeArrival(attempt)).toBe(false);
    const unplanned = admission.beginTreeArrival();
    expect(unplanned.planned).toBe(false);
    expect(unplanned.plan).toBeUndefined();
  });

  it("lets only the latest arrival attempt settle", () => {
    const admission = new CheckpointAdmission();
    const current = view({ leafId: "parent", entries: [parentEntry] });
    admission.admit(current, node("parent"));
    const first = admission.beginTreeArrival();
    admission.admit(current, node("parent"));
    const second = admission.beginTreeArrival();

    expect(admission.admitArrival(first, current, node("parent"))).toBe(false);
    expect(admission.admitArrival(second, current, node("parent"))).toBe(true);
    expect(
      admission.settleProtectedArrival(second, current, node("parent")),
    ).toMatchObject({ kind: "unsettled" });
  });

  it("allows an unproven arrival to protect but never to admit", () => {
    const admission = new CheckpointAdmission();
    const attempt = admission.beginTreeArrival();
    const current = view({ leafId: "parent", entries: [parentEntry] });

    expect(admission.arrivalCanProceed(attempt, current, node("parent"))).toBe(
      false,
    );
    expect(
      admission.settleProtectedArrival(attempt, current, node("parent")),
    ).toEqual({ kind: "settled" });
  });

  it("authenticates only the planned missing target on the arrived stable ancestry", async () => {
    const admission = new CheckpointAdmission();
    const before = view({
      leafId: "descendant",
      entries: [
        parentEntry,
        { id: "target", parentId: "parent" },
        { id: "descendant", parentId: "target" },
      ],
    });
    admission.admit(before, node("descendant"));
    const plan: PendingNavigation = {
      sessionId: "session",
      cwd: "/workspace",
      expectedOldLeafId: "descendant",
      expectedDestinationId: "target",
      previewSnapshot: undefined,
      target: { kind: "materialize-missing", node: node("target") },
    };
    await admission.runTreePreparation(async () => plan);
    const attempt = admission.beginTreeArrival();
    const arrived = view({
      leafId: "label",
      entries: [
        ...before.projection,
        { id: "summary", parentId: "target" },
        { id: "label", parentId: "summary", type: "label" },
      ],
    });

    expect(
      admission.arrivalCanCommitPlannedTarget(attempt, arrived, node("target")),
    ).toBe(true);
    expect(
      admission.arrivalCanCommitPlannedTarget(attempt, arrived, node("parent")),
    ).toBe(false);
    expect(
      admission.arrivalCanCommitPlannedTarget(
        attempt,
        arrived,
        node("summary"),
      ),
    ).toBe(false);
  });

  it("carries the source mode through a verified same-anchor arrival", () => {
    const admission = new CheckpointAdmission();
    const before = view({ leafId: "parent", entries: [parentEntry] });
    admission.admit(before, node("parent"));
    const attempt = admission.beginTreeArrival();
    const after = view({
      leafId: "label",
      entries: [
        parentEntry,
        { id: "label", parentId: "parent", type: "label" },
      ],
    });

    expect(admission.carryArrival(attempt, after, node("parent"))).toBe(true);
    expect(
      admission.decideCapture({
        view: after,
        node: node("parent"),
        writeProtected: true,
      }),
    ).toEqual({ kind: "write-protected" });
  });

  it("refuses to carry a mode across a graph rewrite", () => {
    const admission = new CheckpointAdmission();
    const before = view({ leafId: "parent", entries: [parentEntry] });
    admission.admit(before, node("parent"));
    const attempt = admission.beginTreeArrival();
    const rewritten = view({
      leafId: "parent",
      entries: [{ ...parentEntry, parentId: "forged" }],
    });

    expect(admission.carryArrival(attempt, rewritten, node("parent"))).toBe(
      false,
    );
    expect(admission.admitArrival(attempt, before, node("parent"))).toBe(false);
    expect(
      admission.decideCapture({
        view: rewritten,
        node: node("parent"),
        writeProtected: false,
      }),
    ).toEqual({ kind: "not-admitted" });
  });

  it("cannot admit a tree arrival after its armed source graph was rewritten", () => {
    const admission = new CheckpointAdmission();
    const before = view({ leafId: "parent", entries: [parentEntry] });
    admission.admit(before, node("parent"));
    const attempt = admission.beginTreeArrival();
    const rewritten = view({
      leafId: "parent",
      entries: [{ ...parentEntry, parentId: "forged" }],
    });

    expect(
      admission.arrivalCanProceed(attempt, rewritten, node("parent")),
    ).toBe(false);
    expect(admission.admitArrival(attempt, rewritten, node("parent"))).toBe(
      false,
    );
    expect(
      admission.decideCapture({
        view: rewritten,
        node: node("parent"),
        writeProtected: false,
      }),
    ).toEqual({ kind: "not-admitted" });
  });

  it("matches an ordinary stable leaf without materializing its full ancestry", () => {
    const admission = new CheckpointAdmission();
    const current = view({ leafId: "parent", entries: [parentEntry] });
    const guarded = Object.create(current) as SessionView;
    Object.defineProperty(guarded, "activeStableAncestryIds", {
      get() {
        throw new Error("full ancestry should stay lazy");
      },
    });

    admission.admit(guarded, node("parent"));
    expect(
      admission.decideCapture({
        view: guarded,
        node: node("parent"),
        writeProtected: false,
      }).kind,
    ).toBe("capture");
  });

  it("blocks an exact-looking coordinate when its graph was rewritten", () => {
    const admission = new CheckpointAdmission();
    const before = view({ leafId: "parent", entries: [parentEntry] });
    admission.admit(before, node("parent"));
    const rewritten = view({
      leafId: "parent",
      entries: [{ ...parentEntry, parentId: "forged" }],
    });

    expect(
      admission.decideCapture({
        view: rewritten,
        node: node("parent"),
        writeProtected: false,
      }),
    ).toEqual({ kind: "not-admitted" });
  });

  it("rejects a node key from another session", () => {
    const admission = new CheckpointAdmission();
    const current = view({ leafId: "parent", entries: [parentEntry] });
    admission.admit(current, node("parent"));
    const foreign = { sessionId: "other", entryId: "parent" };

    expect(
      admission.decideCapture({
        view: current,
        node: foreign,
        writeProtected: false,
      }),
    ).toEqual({ kind: "not-admitted" });
  });

  it("does not let a caller substitute an inactive graph coordinate", () => {
    const admission = new CheckpointAdmission();
    const current = view({
      leafId: "active",
      entries: [
        parentEntry,
        { id: "active", parentId: "parent" },
        { id: "inactive", parentId: "parent" },
      ],
    });
    admission.admit(current, node("inactive"));

    expect(
      admission.decideCapture({
        view: current,
        node: node("inactive"),
        writeProtected: false,
      }),
    ).toEqual({ kind: "not-admitted" });
  });

  it("revokes the prior right before reading a replacement snapshot", () => {
    const admission = new CheckpointAdmission();
    const current = view({ leafId: "parent", entries: [parentEntry] });
    const parent = node("parent");
    admission.admit(current, parent);
    const decision = admission.decideCapture({
      view: current,
      node: parent,
      writeProtected: false,
    });
    expect(decision.kind).toBe("capture");
    if (decision.kind !== "capture") return;

    const throwing = Object.create(current) as SessionView;
    Object.defineProperty(throwing, "sessionFile", {
      get() {
        throw new Error("injected snapshot accessor failure");
      },
    });

    expect(() => admission.admit(throwing, parent)).toThrow(
      "injected snapshot accessor failure",
    );
    expect(admission.leaseIsCurrent(decision.lease, current, parent)).toBe(
      false,
    );
  });

  it("invalidates leases across state replacement and session identity changes", () => {
    const admission = new CheckpointAdmission();
    const current = view({ leafId: "parent", entries: [parentEntry] });
    const parent = node("parent");
    admission.admit(current, parent);
    const first = admission.decideCapture({
      view: current,
      node: parent,
      writeProtected: false,
    });
    expect(first.kind).toBe("capture");
    if (first.kind !== "capture") return;

    admission.admit(current, parent);
    expect(admission.leaseIsCurrent(first.lease, current, parent)).toBe(false);
    const second = admission.decideCapture({
      view: current,
      node: parent,
      writeProtected: false,
    });
    expect(second.kind).toBe("capture");
    if (second.kind !== "capture") return;

    expect(
      admission.leaseIsCurrent(
        second.lease,
        view({
          sessionFile: "/sessions/replaced.jsonl",
          leafId: "parent",
          entries: [parentEntry],
        }),
        parent,
      ),
    ).toBe(false);
    expect(
      admission.leaseIsCurrent(
        second.lease,
        view({
          cwd: "/another-workspace",
          leafId: "parent",
          entries: [parentEntry],
        }),
        parent,
      ),
    ).toBe(false);
    expect(
      admission.leaseIsCurrent(
        second.lease,
        view({
          sessionCwd: "/other",
          leafId: "parent",
          entries: [parentEntry],
        }),
        parent,
      ),
    ).toBe(false);
  });

  it("cuts over exactly once and closes ordinary capture", () => {
    const admission = new CheckpointAdmission();
    const current = view({ leafId: "parent", entries: [parentEntry] });
    const parent = node("parent");
    admission.admit(current, parent);

    expect(admission.cutoverMutation(current, parent)).toBe(true);
    expect(
      admission.decideCapture({
        view: current,
        node: parent,
        writeProtected: false,
      }),
    ).toEqual({ kind: "not-admitted" });
    expect(admission.cutoverMutation(current, parent)).toBe(false);
  });

  it("does not cut over a different snapshot", () => {
    const admission = new CheckpointAdmission();
    const current = view({ leafId: "parent", entries: [parentEntry] });
    const parent = node("parent");
    admission.admit(current, parent);
    const changed = view({
      leafId: "parent",
      entries: [parentEntry, { id: "other", parentId: "parent" }],
    });
    expect(admission.cutoverMutation(changed, parent)).toBe(false);
    expect(
      admission.decideCapture({
        view: current,
        node: parent,
        writeProtected: false,
      }).kind,
    ).toBe("capture");
  });
});
