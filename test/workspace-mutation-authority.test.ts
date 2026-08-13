import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { CheckpointService } from "../src/application/checkpoint-service.ts";
import {
  consumeWorkspaceMutationLease,
  workspaceMutationLeaseState,
} from "../src/application/mutation-lease.ts";
import type { ResolvedNodeState } from "../src/application/resolve.ts";
import type {
  CheckpointAdmission,
  EphemeralArrivalSettlement,
} from "../src/pi/checkpoint-admission.ts";
import { readSessionView } from "../src/pi/session-view.ts";
import type { SessionRegistrationService } from "../src/pi/session-registration-service.ts";
import { WorkspaceMutationAuthority } from "../src/pi/workspace-mutation-authority.ts";
import type { CurrentMetadataStore } from "../src/infrastructure/metadata.ts";

const treeOid = "a".repeat(64);
const node = { sessionId: "session", entryId: "entry" } as const;
const workspace = resolve("workspace");
const sessionFile = resolve("sessions/session.jsonl");
const resolution = { treeOid, foundAt: node } satisfies ResolvedNodeState;
const protectedLocation = {
  kind: "protected",
  protectedSlot: { kind: "blocked-checkpoint", treeOid },
} as const;

function context(
  options: {
    readonly idle?: () => boolean;
    readonly entries?: () => readonly unknown[];
  } = {},
): ExtensionContext {
  const entry = { id: node.entryId, parentId: null, type: "custom" };
  const entries = options.entries ?? (() => [entry]);
  return {
    isIdle: options.idle ?? (() => true),
    sessionManager: {
      getSessionId: () => node.sessionId,
      getCwd: () => workspace,
      getHeader: () => ({
        type: "session",
        id: node.sessionId,
        cwd: workspace,
      }),
      getSessionFile: () => sessionFile,
      getLeafId: () => node.entryId,
      getEntries: entries,
      getBranch: () => [entry],
    },
  } as unknown as ExtensionContext;
}

function authority(options: {
  readonly events?: string[];
  readonly protectLocation?: () => typeof protectedLocation;
  readonly raiseSessionBarrier?: () => boolean;
  readonly admit?: () => void;
  readonly cutoverMutation?: () => boolean;
  readonly arrivalSettlement?: () => EphemeralArrivalSettlement;
  readonly workspaceCleanupFailure?: unknown;
}) {
  const events = options.events ?? [];
  const admission = {
    admit: vi.fn(options.admit),
    cutoverMutation: vi.fn(() => {
      events.push("cutover");
      return options.cutoverMutation?.() ?? true;
    }),
    arrivalIsCurrent: vi.fn(() => true),
    settleProtectedArrival: vi.fn(
      options.arrivalSettlement ?? (() => ({ kind: "settled" })),
    ),
    reset: vi.fn(() => events.push("quarantine")),
  } as unknown as CheckpointAdmission;
  const registrations = {
    registeredAuthority: {
      sessionId: node.sessionId,
      sessionFile,
      cwd: workspace,
      sessionCwd: workspace,
      parentSession: { kind: "absent" },
    },
    sessionIsUsable: () => true,
    assertActiveWorkspaceAuthority: () => events.push("binding"),
  } as unknown as SessionRegistrationService;
  const checkpoints = {
    captureAnchor: () => node,
    ancestryEntryIds: () => [node.entryId],
    resolve: () => resolution,
    locationIsBlocked: () => false,
  } as unknown as CheckpointService;
  const metadata = {
    protectLocation: vi.fn(() => {
      events.push("pin");
      return (options.protectLocation ?? (() => protectedLocation))();
    }),
    raiseSessionBarrier: vi.fn(options.raiseSessionBarrier ?? (() => true)),
  } as unknown as CurrentMetadataStore;
  return {
    service: new WorkspaceMutationAuthority({
      admission,
      registrations,
      checkpoints: () => checkpoints,
      metadata: () => metadata,
      restoreDeps: () => {
        throw new Error("unused");
      },
      enqueueWorkspaceExecution: async (_operation, action) => ({
        kind: "completed",
        value: await action(),
        cleanup:
          options.workspaceCleanupFailure === undefined
            ? { kind: "released" }
            : { kind: "failed", cause: options.workspaceCleanupFailure },
      }),
    }),
    admission,
    metadata,
  };
}

describe("workspace mutation authority", () => {
  it("pins durable metadata before consuming ephemeral first-write authority", () => {
    const events: string[] = [];
    const host = context({
      idle: () => {
        events.push("idle");
        return true;
      },
    });
    const { service } = authority({ events });
    const expected = readSessionView(host);
    const lease = service.prepareLocationMutation(
      host,
      expected,
      node,
      resolution,
    );

    expect(lease).toBeDefined();
    expect(consumeWorkspaceMutationLease(lease!)).toEqual({
      kind: "authorized",
      pinnedResolution: resolution,
    });
    expect(events).toEqual(["idle", "binding", "pin", "cutover"]);
  });

  it("permanently rejects the lease without cutting ephemeral authority when pinning fails", () => {
    const events: string[] = [];
    const failure = new Error("metadata unavailable");
    const host = context({
      idle: () => {
        events.push("idle");
        return true;
      },
    });
    const { service, admission } = authority({
      events,
      protectLocation: () => {
        throw failure;
      },
    });
    const expected = readSessionView(host);
    const lease = service.prepareLocationMutation(
      host,
      expected,
      node,
      resolution,
    )!;

    expect(() => consumeWorkspaceMutationLease(lease)).toThrow(failure);
    expect(workspaceMutationLeaseState(lease)).toEqual({
      kind: "rejected",
      cause: failure,
    });
    expect(events).toEqual(["idle", "binding", "pin"]);
    expect(admission.cutoverMutation).not.toHaveBeenCalled();
  });

  it("rejects when ephemeral cutover authority is unavailable", () => {
    const { service, admission } = authority({
      cutoverMutation: () => false,
    });
    const host = context();
    const lease = service.prepareLocationMutation(
      host,
      readSessionView(host),
      node,
      resolution,
    )!;

    expect(() => consumeWorkspaceMutationLease(lease)).toThrow(
      "workspace mutation authority changed before cutover",
    );
    expect(workspaceMutationLeaseState(lease)).toMatchObject({
      kind: "rejected",
      cause: expect.objectContaining({
        message: "workspace mutation authority changed before cutover",
      }),
    });
    expect(admission.cutoverMutation).toHaveBeenCalledOnce();
  });

  it("falls back to an authenticated session barrier when the tree snapshot is unreadable", () => {
    const events: string[] = [];
    const { service, admission, metadata } = authority({ events });
    const host = context({
      entries: () => {
        throw new Error("tree unavailable");
      },
    });

    expect(service.recoverUncertainLocationInWorkspaceLock(host)).toEqual({
      kind: "session-barrier",
    });
    expect(events).toEqual(["quarantine", "binding"]);
    expect(metadata.raiseSessionBarrier).toHaveBeenCalledWith({
      sessionId: node.sessionId,
      sessionFile,
    });
    expect(admission.admit).not.toHaveBeenCalled();
  });

  it("returns the exact durable slot after uncertain recovery", () => {
    const { service, admission } = authority({});

    expect(service.recoverUncertainLocationInWorkspaceLock(context())).toEqual({
      kind: "exact-slot",
      slot: protectedLocation.protectedSlot,
      admission: { kind: "settled" },
    });
    expect(admission.admit).toHaveBeenCalledOnce();
  });

  it("preserves exact recovery when only workspace-lock cleanup fails", async () => {
    const cleanup = new Error("workspace lock release failed");
    const { service } = authority({ workspaceCleanupFailure: cleanup });

    await expect(service.recoverUncertainLocation(context())).resolves.toEqual({
      protection: {
        kind: "exact-slot",
        slot: protectedLocation.protectedSlot,
        admission: { kind: "settled" },
      },
      workspaceLockCleanup: { kind: "failed", cause: cleanup },
    });
  });

  it("keeps exact durable protection when ephemeral admission settlement fails", () => {
    const secondaryFailure = new Error("admission unavailable");
    const { service, metadata } = authority({
      admit: () => {
        throw secondaryFailure;
      },
    });

    expect(service.recoverUncertainLocationInWorkspaceLock(context())).toEqual({
      kind: "exact-slot",
      slot: protectedLocation.protectedSlot,
      admission: { kind: "failed", cause: secondaryFailure },
    });
    expect(metadata.raiseSessionBarrier).not.toHaveBeenCalled();
  });

  it("does not weaken durable arrival protection when ephemeral settlement fails", () => {
    const settlementFailure = new Error("arrival authority changed");
    const { service } = authority({
      arrivalSettlement: () => ({
        kind: "unsettled",
        cause: settlementFailure,
      }),
    });
    const host = context();
    const current = readSessionView(host);
    const attempt = {} as ReturnType<CheckpointAdmission["beginTreeArrival"]>;

    expect(service.protectCurrentTreeArrival(attempt, current)).toEqual({
      kind: "protected",
      evidence: {
        kind: "exact-slot",
        slot: protectedLocation.protectedSlot,
        expectation: "matched",
        admission: { kind: "failed", cause: settlementFailure },
      },
    });
  });

  it("does not weaken durable arrival protection when ephemeral settlement throws", () => {
    const settlementFailure = new Error("arrival settlement threw");
    const { service } = authority({
      arrivalSettlement: () => {
        throw settlementFailure;
      },
    });
    const host = context();
    const attempt = {} as ReturnType<CheckpointAdmission["beginTreeArrival"]>;

    expect(
      service.protectCurrentTreeArrival(attempt, readSessionView(host)),
    ).toMatchObject({
      kind: "protected",
      evidence: {
        admission: { kind: "failed", cause: settlementFailure },
      },
    });
  });

  it("returns an unsettled disposition when durable protection throws", () => {
    const metadataFailure = new Error("metadata unavailable");
    const { service } = authority({
      protectLocation: () => {
        throw metadataFailure;
      },
    });
    const host = context();

    expect(service.protectCurrentNode(readSessionView(host), node)).toEqual({
      kind: "unsettled",
      cause: metadataFailure,
    });
  });
});
