import { describe, expect, it, vi } from "vitest";

import type { ResolvedNodeState } from "../src/application/resolve.ts";
import type { NodeKey } from "../src/domain/model.ts";
import type { NonAdmittedArrivalDisposition } from "../src/pi/arrival-settlement.ts";
import {
  settleCheckpointInitialization,
  type CheckpointInitializationProtocolDeps,
} from "../src/pi/checkpoint-initialization-protocol.ts";
import type { SessionView } from "../src/pi/session-view.ts";

const node: NodeKey = { sessionId: "session", entryId: "entry" };
const resolution: ResolvedNodeState = {
  treeOid: "a".repeat(64),
  foundAt: node,
};

function view(name: string): SessionView {
  const value: {
    readonly name: string;
    isSameSnapshotAs(other: SessionView): boolean;
  } = {
    name,
    isSameSnapshotAs(other: SessionView): boolean {
      return other === (value as unknown as SessionView);
    },
  };
  return value as unknown as SessionView;
}

function deps(
  current: SessionView,
  protectCommittedArrival: (
    cause: unknown,
  ) =>
    | NonAdmittedArrivalDisposition
    | Promise<NonAdmittedArrivalDisposition> = vi.fn(() => ({
    kind: "protected" as const,
    evidence: {
      kind: "session-barrier" as const,
      admission: { kind: "settled" as const },
    },
  })),
): CheckpointInitializationProtocolDeps {
  return {
    readCurrentView: () => current,
    sessionIsUsable: () => true,
    captureAnchor: () => node,
    protectCommittedArrival,
  };
}

describe("checkpoint initialization settlement", () => {
  it("admits an unchanged committed coordinate", async () => {
    const expected = view("expected");
    const protectCommittedArrival = vi.fn(() => ({
      kind: "protected" as const,
      evidence: {
        kind: "session-barrier" as const,
        admission: { kind: "settled" as const },
      },
    }));
    const admit = vi.fn(() => ({ kind: "admitted" as const }));

    await expect(
      settleCheckpointInitialization(deps(expected, protectCommittedArrival), {
        expected,
        node,
        resolution,
        admit,
      }),
    ).resolves.toEqual({ kind: "admitted" });
    expect(admit).toHaveBeenCalledWith(expected, resolution);
    expect(protectCommittedArrival).not.toHaveBeenCalled();
  });

  it("accepts an entry-point proof for a planned logical ancestor", async () => {
    const expected = view("expected");
    const admit = vi.fn(() => ({ kind: "admitted" as const }));
    const locationMatches = vi.fn(() => true);
    const protocolDeps = {
      ...deps(expected),
      captureAnchor: () => ({ sessionId: "session", entryId: "summary" }),
    };

    await expect(
      settleCheckpointInitialization(protocolDeps, {
        expected,
        node,
        resolution,
        locationMatches,
        admit,
      }),
    ).resolves.toEqual({ kind: "admitted" });
    expect(locationMatches).toHaveBeenCalledWith(expected, node);
    expect(admit).toHaveBeenCalledOnce();
  });

  it("durably protects a committed checkpoint when location changed", async () => {
    const expected = view("expected");
    const protectCommittedArrival = vi.fn(() => ({
      kind: "protected" as const,
      evidence: {
        kind: "exact-slot" as const,
        slot: {
          kind: "blocked-checkpoint" as const,
          treeOid: resolution.treeOid,
        },
        expectation: "matched" as const,
        admission: {
          kind: "failed" as const,
          cause: new Error("ephemeral rebuild failed"),
        },
      },
    }));
    const admit = vi.fn(() => ({ kind: "admitted" as const }));

    const result = await settleCheckpointInitialization(
      deps(view("other"), protectCommittedArrival),
      { expected, node, resolution, admit },
    );

    expect(result).toMatchObject({
      kind: "protected",
      evidence: {
        kind: "exact-slot",
        expectation: "matched",
        admission: { kind: "failed" },
      },
    });
    expect(admit).not.toHaveBeenCalled();
    expect(protectCommittedArrival).toHaveBeenCalledOnce();
  });

  it("reports both admission and recovery failures without throwing", async () => {
    const expected = view("expected");
    const admissionFailure = new Error("admission failed");
    const recoveryFailure = new Error("recovery failed");

    const result = await settleCheckpointInitialization(
      deps(expected, () => {
        throw recoveryFailure;
      }),
      {
        expected,
        node,
        resolution,
        admit: () => ({ kind: "unsettled", cause: admissionFailure }),
      },
    );

    expect(result.kind).toBe("unsettled");
    if (result.kind === "unsettled") {
      expect(result.cause).toBeInstanceOf(AggregateError);
      expect((result.cause as AggregateError).errors).toEqual([
        admissionFailure,
        recoveryFailure,
      ]);
    }
  });
});
