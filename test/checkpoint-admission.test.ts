import { describe, expect, it } from "vitest";

import type { NodeKey } from "../src/domain/model.ts";
import { CheckpointAdmission } from "../src/pi/checkpoint-admission.ts";
import type { SessionView } from "../src/pi/session-view.ts";

function view(
  overrides: Partial<
    Pick<SessionView, "sessionId" | "sessionFile" | "cwd" | "leafId">
  > = {},
): SessionView {
  return {
    sessionId: "session",
    sessionFile: "/sessions/session.jsonl",
    cwd: "/workspace",
    parentSessionFile: null,
    leafId: "leaf",
    parentIdOf: () => undefined,
    entryOf: () => undefined,
    entryTypeOf: () => undefined,
    navigationLandingId: () => undefined,
    ...overrides,
  };
}

function node(entryId: string): NodeKey {
  return { sessionId: "session", entryId };
}

describe("checkpoint admission", () => {
  it("carries a raw-leaf rewrite of one authenticated stable anchor", () => {
    const admission = new CheckpointAdmission();
    const stable = node("stable");
    const before = view({ leafId: "raw-before" });
    const after = view({ leafId: "raw-after" });
    admission.admit(before, stable);

    const decision = admission.decideCapture({
      view: after,
      node: stable,
      isNaturalDescendant: false,
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
    const current = view();
    admission.admit(current, node("stable-a"));

    expect(
      admission.decideCapture({
        view: current,
        node: node("stable-b"),
        isNaturalDescendant: false,
        writeProtected: false,
      }),
    ).toEqual({ kind: "blocked" });
  });

  it("admits a natural descendant after a protected parent", () => {
    const admission = new CheckpointAdmission();
    const parentView = view({ leafId: "parent" });
    const parent = node("parent");
    admission.protect(parentView, parent);
    expect(
      admission.decideCapture({
        view: parentView,
        node: parent,
        isNaturalDescendant: false,
        writeProtected: true,
      }),
    ).toEqual({ kind: "protected" });

    const childView = view({ leafId: "child" });
    const child = node("child");
    const decision = admission.decideCapture({
      view: childView,
      node: child,
      isNaturalDescendant: true,
      writeProtected: false,
    });
    expect(decision.kind).toBe("capture");
  });

  it("blocks an unplanned sibling instead of silently admitting it", () => {
    const admission = new CheckpointAdmission();
    admission.admit(view({ leafId: "left" }), node("left"));
    const siblingView = view({ leafId: "right" });

    expect(
      admission.decideCapture({
        view: siblingView,
        node: node("right"),
        isNaturalDescendant: false,
        writeProtected: false,
      }),
    ).toEqual({ kind: "blocked" });
  });

  it("invalidates leases across ABA revisions and session identity changes", () => {
    const admission = new CheckpointAdmission();
    const current = view();
    const stable = node("stable");
    admission.admit(current, stable);
    const first = admission.decideCapture({
      view: current,
      node: stable,
      isNaturalDescendant: false,
      writeProtected: false,
    });
    expect(first.kind).toBe("capture");
    if (first.kind !== "capture") return;

    admission.admit(current, stable);
    expect(admission.leaseIsCurrent(first.lease, current, stable)).toBe(false);
    const second = admission.decideCapture({
      view: current,
      node: stable,
      isNaturalDescendant: false,
      writeProtected: false,
    });
    expect(second.kind).toBe("capture");
    if (second.kind !== "capture") return;

    expect(
      admission.leaseIsCurrent(
        second.lease,
        view({ sessionFile: "/sessions/replaced.jsonl" }),
        stable,
      ),
    ).toBe(false);
    expect(
      admission.leaseIsCurrent(
        second.lease,
        view({ cwd: "/another-workspace" }),
        stable,
      ),
    ).toBe(false);
  });
});
