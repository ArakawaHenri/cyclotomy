import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { CheckpointService } from "../src/application/checkpoint-service.ts";
import {
  consumeWorkspaceMutationLease,
  workspaceMutationLeaseState,
} from "../src/application/mutation-lease.ts";
import type { ResolvedNodeState } from "../src/application/resolve.ts";
import {
  CheckpointAdmission,
  type EphemeralArrivalSettlement,
  type OrdinaryMutationClaim,
} from "../src/pi/checkpoint-admission.ts";
import { readSessionView } from "../src/pi/session-view.ts";
import type { SessionRegistrationService } from "../src/pi/session-registration-service.ts";
import { WorkspaceMutationAuthority } from "../src/pi/workspace-mutation-authority.ts";
import type {
  CurrentMetadataStore,
  ProtectLocationResult,
} from "../src/infrastructure/metadata.ts";
import {
  assertWorkspaceWriteAuthority,
  runWithWorkspaceLock,
  type WorkspaceWriteAuthority,
} from "../src/infrastructure/workspace-lock.ts";

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
  readonly checkpointAdmission?: CheckpointAdmission;
  readonly captureAnchor?: () => typeof node | undefined;
  readonly locationIsBlocked?: () => boolean;
  readonly sessionHasBarrier?: () => boolean | undefined;
  readonly protectLocation?: () => ProtectLocationResult;
  readonly raiseSessionBarrier?: () => boolean;
  readonly admitResolvedLocation?: (
    writeAuthority: WorkspaceWriteAuthority,
  ) => "admitted" | "slot-changed";
  readonly admit?: () => void;
  readonly ordinaryClaim?: () => OrdinaryMutationClaim;
  readonly admitArrival?: () => boolean;
  readonly arrivalCanProceed?: () => boolean;
  readonly arrivalCanCommitPlannedTarget?: () => boolean;
  readonly arrivalIsCurrent?: () => boolean;
  readonly closeArrival?: () => boolean;
  readonly cutoverMutation?: () => boolean;
  readonly cutoverArrivalMutation?: () => boolean;
  readonly arrivalSettlement?: () => EphemeralArrivalSettlement;
  readonly carryArrival?: () => boolean;
  readonly decideCapture?: () =>
    | {
        readonly kind: "capture";
        readonly lease: { readonly __admissionLease: true };
      }
    | { readonly kind: "no-coordinate" | "write-protected" | "not-admitted" };
  readonly leaseIsCurrent?: () => boolean;
  readonly reconcileSessionBarrier?: () =>
    "reconciled" | "absent" | "unregistered";
  readonly workspaceCleanupFailure?: unknown;
  readonly participationIsActive?: () => boolean;
  readonly storeRoot?: string;
  readonly writeAuthority?: WorkspaceWriteAuthority;
}) {
  const events = options.events ?? [];
  const admit = vi.fn(options.admit);
  const admission =
    options.checkpointAdmission ??
    ({
      admit,
      claimOrdinaryMutation: vi.fn(() => {
        const claim =
          options.ordinaryClaim?.() ?? ({ kind: "claimed" } as const);
        if (claim.kind === "claimed") admit();
        return claim;
      }),
      admitArrival: vi.fn(options.admitArrival ?? (() => true)),
      arrivalCanProceed: vi.fn(options.arrivalCanProceed ?? (() => true)),
      arrivalCanCommitPlannedTarget: vi.fn(
        options.arrivalCanCommitPlannedTarget ?? (() => false),
      ),
      cutoverMutation: vi.fn(() => {
        events.push("cutover");
        return options.cutoverMutation?.() ?? true;
      }),
      cutoverArrivalMutation: vi.fn(() => {
        events.push("arrival-cutover");
        return options.cutoverArrivalMutation?.() ?? true;
      }),
      arrivalIsCurrent: vi.fn(options.arrivalIsCurrent ?? (() => true)),
      closeArrival: vi.fn(options.closeArrival ?? (() => true)),
      carryArrival: vi.fn(options.carryArrival ?? (() => true)),
      decideCapture: vi.fn(
        options.decideCapture ?? (() => ({ kind: "not-admitted" })),
      ),
      leaseIsCurrent: vi.fn(options.leaseIsCurrent ?? (() => true)),
      settleProtectedArrival: vi.fn(
        options.arrivalSettlement ?? (() => ({ kind: "settled" })),
      ),
      reset: vi.fn(() => events.push("quarantine")),
    } as unknown as CheckpointAdmission);
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
    captureAnchor: options.captureAnchor ?? (() => node),
    ancestryEntryIds: () => [node.entryId],
    resolve: () => resolution,
    locationIsBlocked: options.locationIsBlocked ?? (() => false),
  } as unknown as CheckpointService;
  const metadata = {
    admitResolvedLocation: vi.fn(
      (writeAuthority: WorkspaceWriteAuthority) =>
        options.admitResolvedLocation?.(writeAuthority) ?? "admitted",
    ),
    protectLocation: vi.fn(() => {
      events.push("pin");
      return (options.protectLocation ?? (() => protectedLocation))();
    }),
    raiseSessionBarrier: vi.fn(() => {
      events.push("barrier");
      return options.raiseSessionBarrier?.() ?? true;
    }),
    reconcileSessionBarrier: vi.fn(
      options.reconcileSessionBarrier ?? (() => "absent"),
    ),
    hasSessionBarrier: vi.fn(options.sessionHasBarrier ?? (() => false)),
  } as unknown as CurrentMetadataStore;
  return {
    service: new WorkspaceMutationAuthority({
      admission,
      participationIsActive: options.participationIsActive ?? (() => true),
      registrations,
      checkpoints: () => checkpoints,
      metadata: () => metadata,
      restoreDeps: () => {
        throw new Error("unused");
      },
      workspaceStoreRoot: () => options.storeRoot ?? workspace,
      enqueueWorkspaceExecution: async (_operation, action) => ({
        kind: "completed",
        value: await action(
          options.writeAuthority ??
            (Object.freeze({}) as WorkspaceWriteAuthority),
        ),
        cleanup:
          options.workspaceCleanupFailure === undefined
            ? { kind: "settled" }
            : { kind: "failed", cause: options.workspaceCleanupFailure },
      }),
    }),
    admission,
    metadata,
  };
}

async function withWorkspaceWriteAuthority<T>(
  action: (lease: WorkspaceWriteAuthority, storeRoot: string) => T,
): Promise<T> {
  const storeRoot = await mkdtemp(join(tmpdir(), "cyclotomy-mutation-"));
  try {
    const execution = await runWithWorkspaceLock(
      storeRoot,
      "mutation-authority-test",
      async (lease) => action(lease, storeRoot),
    );
    if (execution.kind === "action-failed") throw execution.cause;
    if (execution.cleanup.kind === "failed") throw execution.cleanup.cause;
    return execution.value;
  } finally {
    await rm(storeRoot, { recursive: true, force: true });
  }
}

describe("workspace mutation authority", () => {
  it("pins durable metadata before consuming ephemeral first-write authority", async () => {
    const events: string[] = [];
    const host = context({
      idle: () => {
        events.push("idle");
        return true;
      },
    });
    await withWorkspaceWriteAuthority((writeAuthority, storeRoot) => {
      const { service } = authority({ events, storeRoot });
      const expected = readSessionView(host);
      const lease = service.prepareLocationMutation(
        writeAuthority,
        host,
        expected,
        node,
        resolution,
      );

      expect(lease).toBeDefined();
      expect(consumeWorkspaceMutationLease(lease!)).toMatchObject({
        kind: "authorized",
        pinnedResolution: resolution,
        writeAuthority,
        storeRoot,
      });
      expect(events).toEqual(["idle", "binding", "pin", "cutover"]);
    });
  });

  it("keeps tree-arrival cutover distinct while preserving the same durable-first order", async () => {
    const events: string[] = [];
    const host = context({
      idle: () => {
        events.push("idle");
        return true;
      },
    });
    await withWorkspaceWriteAuthority((writeAuthority, storeRoot) => {
      const { service, admission } = authority({ events, storeRoot });
      const expected = readSessionView(host);
      const attempt = {} as ReturnType<CheckpointAdmission["beginTreeArrival"]>;
      const lease = service.prepareTreeArrivalMutation(
        writeAuthority,
        host,
        attempt,
        expected,
        node,
        resolution,
      );

      expect(lease).toBeDefined();
      expect(consumeWorkspaceMutationLease(lease!)).toMatchObject({
        kind: "authorized",
        pinnedResolution: resolution,
        writeAuthority,
        storeRoot,
      });
      expect(events).toEqual(["idle", "binding", "pin", "arrival-cutover"]);
      expect(admission.cutoverMutation).not.toHaveBeenCalled();
      expect(admission.cutoverArrivalMutation).toHaveBeenCalledOnce();
      const [cutoverAttempt, cutoverView, cutoverNode] = vi.mocked(
        admission.cutoverArrivalMutation,
      ).mock.calls[0]!;
      expect(cutoverAttempt).toBe(attempt);
      expect(cutoverView.isSameSnapshotAs(expected)).toBe(true);
      expect(cutoverNode).toEqual(node);
    });
  });

  it("permanently rejects the lease without cutting ephemeral authority when pinning fails", async () => {
    const events: string[] = [];
    const failure = new Error("metadata unavailable");
    const host = context({
      idle: () => {
        events.push("idle");
        return true;
      },
    });
    await withWorkspaceWriteAuthority((writeAuthority, storeRoot) => {
      const { service, admission } = authority({
        events,
        storeRoot,
        protectLocation: () => {
          throw failure;
        },
      });
      const expected = readSessionView(host);
      const lease = service.prepareLocationMutation(
        writeAuthority,
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
  });

  it("rejects when ephemeral cutover authority is unavailable", async () => {
    await withWorkspaceWriteAuthority((writeAuthority, storeRoot) => {
      const { service, admission } = authority({
        storeRoot,
        cutoverMutation: () => false,
      });
      const host = context();
      const lease = service.prepareLocationMutation(
        writeAuthority,
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
  });

  it("does not mint a workspace mutation lease after participation is withdrawn", async () => {
    await withWorkspaceWriteAuthority((writeAuthority, storeRoot) => {
      const { service, admission, metadata } = authority({
        participationIsActive: () => false,
        storeRoot,
      });
      const host = context();

      expect(
        service.prepareLocationMutation(
          writeAuthority,
          host,
          readSessionView(host),
          node,
          resolution,
        ),
      ).toBeUndefined();
      expect(
        service.prepareTreeArrivalMutation(
          writeAuthority,
          host,
          {} as ReturnType<CheckpointAdmission["beginTreeArrival"]>,
          readSessionView(host),
          node,
          resolution,
        ),
      ).toBeUndefined();
      expect(admission.claimOrdinaryMutation).not.toHaveBeenCalled();
      expect(admission.arrivalCanProceed).not.toHaveBeenCalled();
      expect(metadata.protectLocation).not.toHaveBeenCalled();
    });
  });

  it("rejects a pre-write lease locally but preserves terminal claim failures", async () => {
    const failure = new Error("admission snapshot unavailable");
    await withWorkspaceWriteAuthority((writeAuthority, storeRoot) => {
      const { service, metadata } = authority({
        ordinaryClaim: () => {
          throw failure;
        },
        storeRoot,
      });
      const host = context();
      const current = readSessionView(host);

      expect(
        service.prepareLocationMutation(
          writeAuthority,
          host,
          current,
          node,
          resolution,
        ),
      ).toBeUndefined();
      expect(() => service.admitCurrentLocation(current)).toThrow(failure);
      expect(metadata.protectLocation).not.toHaveBeenCalled();
      expect(metadata.admitResolvedLocation).not.toHaveBeenCalled();
    });
  });

  it("rejects an ordinary mutation lease retired before its first write", async () => {
    let active = true;
    await withWorkspaceWriteAuthority((writeAuthority, storeRoot) => {
      const { service, admission, metadata } = authority({
        participationIsActive: () => active,
        storeRoot,
      });
      const host = context();
      const lease = service.prepareLocationMutation(
        writeAuthority,
        host,
        readSessionView(host),
        node,
        resolution,
      );
      active = false;

      expect(lease).toBeDefined();
      expect(() => consumeWorkspaceMutationLease(lease!)).toThrow(
        "workspace mutation authority was retired",
      );
      expect(metadata.protectLocation).not.toHaveBeenCalled();
      expect(admission.cutoverMutation).not.toHaveBeenCalled();
    });
  });

  it("rejects a tree mutation lease retired before its first write", async () => {
    let active = true;
    await withWorkspaceWriteAuthority((writeAuthority, storeRoot) => {
      const { service, admission, metadata } = authority({
        participationIsActive: () => active,
        storeRoot,
      });
      const host = context();
      const lease = service.prepareTreeArrivalMutation(
        writeAuthority,
        host,
        {} as ReturnType<CheckpointAdmission["beginTreeArrival"]>,
        readSessionView(host),
        node,
        resolution,
      );
      active = false;

      expect(lease).toBeDefined();
      expect(() => consumeWorkspaceMutationLease(lease!)).toThrow(
        "tree mutation authority was retired",
      );
      expect(metadata.protectLocation).not.toHaveBeenCalled();
      expect(admission.cutoverArrivalMutation).not.toHaveBeenCalled();
    });
  });

  it("rejects the first-write cutover after workspace lock ownership is lost", async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), "cyclotomy-mutation-loss-"));
    try {
      const events: string[] = [];
      const execution = await runWithWorkspaceLock(
        storeRoot,
        "mutation-authority-loss-test",
        async (writeAuthority) => {
          const { service, admission, metadata } = authority({
            events,
            storeRoot,
          });
          const host = context();
          const mutationLease = service.prepareLocationMutation(
            writeAuthority,
            host,
            readSessionView(host),
            node,
            resolution,
          )!;
          await rename(
            join(storeRoot, "workspace.lock"),
            join(storeRoot, "displaced.lock"),
          );
          let failure: unknown;
          try {
            consumeWorkspaceMutationLease(mutationLease);
          } catch (cause) {
            failure = cause;
          }
          return { failure, admission, metadata };
        },
      );

      expect(execution.kind).toBe("completed");
      if (execution.kind !== "completed") throw execution.cause;
      expect(execution.value.failure).toMatchObject({
        name: "WorkspaceLockOwnershipLostError",
      });
      expect(execution.value.metadata.protectLocation).not.toHaveBeenCalled();
      expect(execution.value.admission.cutoverMutation).not.toHaveBeenCalled();
      expect(events).toEqual([]);
      expect(execution.cleanup.kind).toBe("failed");
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it("revalidates workspace lock ownership after the first-write cutover", async () => {
    const storeRoot = await mkdtemp(
      join(tmpdir(), "cyclotomy-mutation-fence-"),
    );
    try {
      const execution = await runWithWorkspaceLock(
        storeRoot,
        "mutation-authority-fence-test",
        async (writeAuthority) => {
          const { service, admission, metadata } = authority({ storeRoot });
          const host = context();
          const mutationLease = service.prepareLocationMutation(
            writeAuthority,
            host,
            readSessionView(host),
            node,
            resolution,
          )!;
          const authorization = consumeWorkspaceMutationLease(mutationLease);
          await rename(
            join(storeRoot, "workspace.lock"),
            join(storeRoot, "displaced.lock"),
          );
          let failure: unknown;
          try {
            assertWorkspaceWriteAuthority(
              authorization.writeAuthority,
              authorization.storeRoot,
            );
          } catch (cause) {
            failure = cause;
          }
          return { failure, admission, metadata };
        },
      );

      expect(execution.kind).toBe("completed");
      if (execution.kind !== "completed") throw execution.cause;
      expect(execution.value.failure).toMatchObject({
        name: "WorkspaceLockOwnershipLostError",
      });
      expect(execution.value.metadata.protectLocation).toHaveBeenCalledOnce();
      expect(execution.value.admission.cutoverMutation).toHaveBeenCalledOnce();
      expect(execution.cleanup.kind).toBe("failed");
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it("cannot mutate metadata after workspace lock ownership is lost", async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), "cyclotomy-admit-loss-"));
    try {
      const execution = await runWithWorkspaceLock(
        storeRoot,
        "admission-authority-loss-test",
        async (writeAuthority) => {
          const { service, metadata } = authority({
            storeRoot,
            admitResolvedLocation: (currentAuthority) => {
              assertWorkspaceWriteAuthority(currentAuthority, storeRoot);
              return "admitted";
            },
          });
          const host = context();
          await rename(
            join(storeRoot, "workspace.lock"),
            join(storeRoot, "displaced.lock"),
          );
          let failure: unknown;
          try {
            service.admitLocationIfResolution(
              writeAuthority,
              readSessionView(host),
              resolution,
            );
          } catch (cause) {
            failure = cause;
          }
          return { failure, metadata };
        },
      );

      expect(execution.kind).toBe("completed");
      if (execution.kind !== "completed") throw execution.cause;
      expect(execution.value.failure).toMatchObject({
        name: "WorkspaceLockOwnershipLostError",
      });
      expect(
        execution.value.metadata.admitResolvedLocation,
      ).toHaveBeenCalledOnce();
      expect(execution.cleanup.kind).toBe("failed");
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it("claims transition authority before reopening an exact durable location", async () => {
    await withWorkspaceWriteAuthority((writeAuthority, storeRoot) => {
      const currentEvents: string[] = [];
      const current = authority({
        events: currentEvents,
        storeRoot,
        admit: () => currentEvents.push("ephemeral-admit"),
      });
      const host = context();
      const view = readSessionView(host);

      expect(current.service.admitCurrentLocation(view)).toBe(true);
      expect(currentEvents).toEqual(["ephemeral-admit"]);
      expect(current.metadata.admitResolvedLocation).not.toHaveBeenCalled();

      const exactEvents: string[] = [];
      const exact = authority({
        events: exactEvents,
        storeRoot,
        admitResolvedLocation: () => {
          exactEvents.push("durable-admit");
          return "admitted";
        },
        admit: () => exactEvents.push("ephemeral-admit"),
      });

      expect(
        exact.service.admitLocationIfResolution(
          writeAuthority,
          view,
          resolution,
        ),
      ).toBe(true);
      expect(exactEvents).toEqual([
        "ephemeral-admit",
        "binding",
        "durable-admit",
      ]);
    });
  });

  it("does not durably admit an ordinary location while a transition owns authority", async () => {
    await withWorkspaceWriteAuthority((writeAuthority, storeRoot) => {
      const { service, admission, metadata } = authority({
        ordinaryClaim: () => ({ kind: "transition-conflict" }),
        storeRoot,
      });
      const current = readSessionView(context());

      expect(
        service.admitLocationIfResolution(writeAuthority, current, resolution),
      ).toBe(false);
      expect(admission.claimOrdinaryMutation).toHaveBeenCalledOnce();
      expect(metadata.admitResolvedLocation).not.toHaveBeenCalled();
    });
  });

  it("does not admit an ordinary location through either terminal while inactive", async () => {
    await withWorkspaceWriteAuthority((writeAuthority, storeRoot) => {
      const { service, admission, metadata } = authority({
        participationIsActive: () => false,
        storeRoot,
      });
      const current = readSessionView(context());

      expect(service.admitCurrentLocation(current)).toBe(false);
      expect(
        service.admitLocationIfResolution(writeAuthority, current, resolution),
      ).toBe(false);
      expect(admission.claimOrdinaryMutation).not.toHaveBeenCalled();
      expect(metadata.admitResolvedLocation).not.toHaveBeenCalled();
    });
  });

  it("routes current tree arrivals through exactly one durable policy branch", async () => {
    await withWorkspaceWriteAuthority((writeAuthority, storeRoot) => {
      const view = readSessionView(context());
      const attempt = {} as ReturnType<CheckpointAdmission["beginTreeArrival"]>;

      const writableEvents: string[] = [];
      const writable = authority({
        events: writableEvents,
        storeRoot,
        admitArrival: () => {
          writableEvents.push("arrival-admit");
          return true;
        },
      });
      expect(
        writable.service.admitCurrentTreeArrival(writeAuthority, attempt, view),
      ).toEqual({ kind: "admitted" });
      expect(writableEvents).toEqual(["arrival-admit"]);
      expect(writable.metadata.protectLocation).not.toHaveBeenCalled();

      const blockedEvents: string[] = [];
      const blocked = authority({
        events: blockedEvents,
        storeRoot,
        locationIsBlocked: () => true,
        arrivalSettlement: () => {
          blockedEvents.push("arrival-settlement");
          return { kind: "settled" };
        },
      });
      expect(
        blocked.service.admitCurrentTreeArrival(writeAuthority, attempt, view),
      ).toEqual({
        kind: "protected",
        evidence: {
          kind: "exact-slot",
          slot: protectedLocation.protectedSlot,
          expectation: "matched",
          admission: { kind: "settled" },
        },
      });
      expect(blockedEvents).toEqual(["binding", "pin", "arrival-settlement"]);
      expect(blocked.admission.admitArrival).not.toHaveBeenCalled();
    });
  });

  it("protects rather than admits a tree arrival after participation is withdrawn", async () => {
    await withWorkspaceWriteAuthority((writeAuthority, storeRoot) => {
      const { service, admission, metadata } = authority({
        participationIsActive: () => false,
        storeRoot,
      });
      const current = readSessionView(context());
      const attempt = {} as ReturnType<CheckpointAdmission["beginTreeArrival"]>;

      expect(
        service.admitCurrentTreeArrival(writeAuthority, attempt, current),
      ).toEqual({
        kind: "protected",
        evidence: {
          kind: "exact-slot",
          slot: protectedLocation.protectedSlot,
          expectation: "matched",
          admission: { kind: "settled" },
        },
      });
      expect(metadata.protectLocation).toHaveBeenCalledOnce();
      expect(admission.admitArrival).not.toHaveBeenCalled();
      expect(admission.settleProtectedArrival).not.toHaveBeenCalled();
      expect(admission.reset).toHaveBeenCalled();
    });
  });

  it("protects an exact tree arrival after durable admission observes resolution drift", async () => {
    await withWorkspaceWriteAuthority((writeAuthority, storeRoot) => {
      const events: string[] = [];
      const { service, admission } = authority({
        events,
        storeRoot,
        admitResolvedLocation: () => {
          events.push("durable-admit");
          return "slot-changed";
        },
        protectLocation: () => ({
          kind: "stale",
          protectedSlot: protectedLocation.protectedSlot,
        }),
        arrivalSettlement: () => {
          events.push("arrival-settlement");
          return { kind: "settled" };
        },
      });
      const view = readSessionView(context());
      const attempt = {} as ReturnType<CheckpointAdmission["beginTreeArrival"]>;

      expect(
        service.admitTreeArrivalIfResolution(
          writeAuthority,
          attempt,
          view,
          resolution,
        ),
      ).toEqual({
        kind: "protected",
        evidence: {
          kind: "exact-slot",
          slot: protectedLocation.protectedSlot,
          expectation: "stale",
          admission: { kind: "settled" },
        },
      });
      expect(events).toEqual([
        "binding",
        "durable-admit",
        "binding",
        "pin",
        "arrival-settlement",
      ]);
      expect(admission.admitArrival).not.toHaveBeenCalled();
    });
  });

  it("recloses a durably admitted tree coordinate when ephemeral admission fails", async () => {
    await withWorkspaceWriteAuthority((writeAuthority, storeRoot) => {
      const events: string[] = [];
      const { service } = authority({
        events,
        storeRoot,
        admitResolvedLocation: () => {
          events.push("durable-admit");
          return "admitted";
        },
        admitArrival: () => {
          events.push("ephemeral-admit");
          return false;
        },
        // This path protects unconditionally after durable admission. Its
        // evidence remains matched even if a defensive test double returns a
        // stale-shaped result that real any-current metadata cannot produce.
        protectLocation: () => ({
          kind: "stale",
          protectedSlot: protectedLocation.protectedSlot,
        }),
      });
      const view = readSessionView(context());
      const attempt = {} as ReturnType<CheckpointAdmission["beginTreeArrival"]>;

      expect(
        service.admitTreeArrivalIfResolution(
          writeAuthority,
          attempt,
          view,
          resolution,
        ),
      ).toMatchObject({
        kind: "protected",
        evidence: {
          kind: "exact-slot",
          slot: protectedLocation.protectedSlot,
          expectation: "matched",
          admission: {
            kind: "failed",
            cause: expect.objectContaining({
              message: "tree arrival could not be admitted",
            }),
          },
        },
      });
      expect(events).toEqual([
        "binding",
        "durable-admit",
        "ephemeral-admit",
        "binding",
        "pin",
      ]);
    });
  });

  it("raises a session barrier before settling a node-free tree arrival", async () => {
    await withWorkspaceWriteAuthority((writeAuthority, storeRoot) => {
      const events: string[] = [];
      const { service } = authority({
        events,
        storeRoot,
        captureAnchor: () => undefined,
        arrivalSettlement: () => {
          events.push("arrival-settlement");
          return { kind: "settled" };
        },
      });
      const view = readSessionView(context());
      const attempt = {} as ReturnType<CheckpointAdmission["beginTreeArrival"]>;

      expect(
        service.protectCurrentTreeArrival(writeAuthority, attempt, view),
      ).toEqual({
        kind: "protected",
        evidence: {
          kind: "session-barrier",
          admission: { kind: "settled" },
        },
      });
      expect(events).toEqual(["binding", "barrier", "arrival-settlement"]);
    });
  });

  it("protects a capture conflict without consuming its active arrival", async () => {
    await withWorkspaceWriteAuthority((writeAuthority, storeRoot) => {
      const checkpointAdmission = new CheckpointAdmission();
      const current = readSessionView(context());
      checkpointAdmission.admit(current, node);
      const attempt = checkpointAdmission.beginTreeArrival();
      const { service, metadata } = authority({
        checkpointAdmission,
        storeRoot,
      });

      expect(
        service.settleCaptureBoundary(writeAuthority, current, node),
      ).toEqual({ kind: "not-admitted" });
      expect(metadata.protectLocation).toHaveBeenCalledOnce();
      expect(checkpointAdmission.arrivalIsCurrent(attempt)).toBe(true);
    });
  });

  it("reports failure to protect a capture conflict", async () => {
    const failure = new Error("metadata unavailable");
    await withWorkspaceWriteAuthority((writeAuthority, storeRoot) => {
      const { service } = authority({
        protectLocation: () => {
          throw failure;
        },
        storeRoot,
      });

      expect(
        service.settleCaptureBoundary(
          writeAuthority,
          readSessionView(context()),
          node,
        ),
      ).toEqual({ kind: "settlement-failed", cause: failure });
    });
  });

  it("rebuilds ordinary authority after projecting a durable session barrier", async () => {
    await withWorkspaceWriteAuthority((writeAuthority, storeRoot) => {
      const { service, admission, metadata } = authority({
        reconcileSessionBarrier: () => "reconciled",
        storeRoot,
      });

      expect(
        service.settleCaptureBoundary(
          writeAuthority,
          readSessionView(context()),
          node,
        ),
      ).toEqual({ kind: "write-protected" });
      expect(metadata.reconcileSessionBarrier).toHaveBeenCalledOnce();
      expect(admission.claimOrdinaryMutation).toHaveBeenCalledOnce();
      expect(admission.decideCapture).not.toHaveBeenCalled();
    });
  });

  it("does not consume an arrival while projecting its durable session barrier", async () => {
    await withWorkspaceWriteAuthority((writeAuthority, storeRoot) => {
      const checkpointAdmission = new CheckpointAdmission();
      const current = readSessionView(context());
      checkpointAdmission.admit(current, node);
      const attempt = checkpointAdmission.beginTreeArrival();
      const { service } = authority({
        checkpointAdmission,
        reconcileSessionBarrier: () => "reconciled",
        storeRoot,
      });

      expect(
        service.settleCaptureBoundary(writeAuthority, current, node),
      ).toEqual({ kind: "not-admitted" });
      expect(checkpointAdmission.arrivalIsCurrent(attempt)).toBe(true);
    });
  });

  it("closes inactive capture boundaries with durable protection only", async () => {
    await withWorkspaceWriteAuthority((writeAuthority, storeRoot) => {
      const exact = authority({
        participationIsActive: () => false,
        storeRoot,
      });
      const current = readSessionView(context());

      expect(
        exact.service.settleCaptureBoundary(writeAuthority, current, node),
      ).toEqual({ kind: "write-protected" });
      expect(exact.metadata.protectLocation).toHaveBeenCalledOnce();
      expect(exact.admission.decideCapture).not.toHaveBeenCalled();
      expect(exact.admission.claimOrdinaryMutation).not.toHaveBeenCalled();
      expect(exact.admission.reset).toHaveBeenCalled();

      const nodeFree = authority({
        captureAnchor: () => undefined,
        participationIsActive: () => false,
        storeRoot,
      });
      expect(
        nodeFree.service.settleCaptureBoundary(
          writeAuthority,
          current,
          undefined,
        ),
      ).toEqual({ kind: "write-protected" });
      expect(nodeFree.metadata.raiseSessionBarrier).toHaveBeenCalledOnce();
      expect(nodeFree.admission.decideCapture).not.toHaveBeenCalled();
      expect(nodeFree.admission.claimOrdinaryMutation).not.toHaveBeenCalled();
    });
  });

  it("fences capture leases and tree-arrival capabilities while inactive", () => {
    const { service, admission } = authority({
      participationIsActive: () => false,
    });
    const current = readSessionView(context());
    const lease = { __admissionLease: true } as const;
    const attempt = {} as ReturnType<CheckpointAdmission["beginTreeArrival"]>;

    expect(service.captureLeaseIsCurrent(lease, current, node)).toBe(false);
    expect(service.carryCurrentTreeArrival(attempt, current, node)).toBe(false);
    expect(service.treeArrivalCanProceed(attempt, current, node)).toBe(false);
    expect(admission.leaseIsCurrent).not.toHaveBeenCalled();
    expect(admission.carryArrival).not.toHaveBeenCalled();
    expect(admission.arrivalCanProceed).not.toHaveBeenCalled();
    expect(admission.arrivalCanCommitPlannedTarget).not.toHaveBeenCalled();
  });

  it("falls back to an authenticated session barrier when the tree snapshot is unreadable", async () => {
    await withWorkspaceWriteAuthority((writeAuthority, storeRoot) => {
      const events: string[] = [];
      const { service, admission, metadata } = authority({ events, storeRoot });
      const host = context({
        entries: () => {
          throw new Error("tree unavailable");
        },
      });

      expect(
        service.recoverUncertainLocationInWorkspaceLock(writeAuthority, host),
      ).toEqual({
        kind: "protected",
        evidence: {
          kind: "session-barrier",
          admission: { kind: "settled" },
        },
      });
      expect(events).toEqual(["quarantine", "binding", "barrier"]);
      expect(metadata.raiseSessionBarrier).toHaveBeenCalledWith(
        writeAuthority,
        {
          sessionId: node.sessionId,
          sessionFile,
        },
      );
      expect(admission.admit).not.toHaveBeenCalled();
    });
  });

  it("returns the exact durable slot after uncertain recovery", async () => {
    await withWorkspaceWriteAuthority((writeAuthority, storeRoot) => {
      const events: string[] = [];
      const { service, admission } = authority({
        events,
        storeRoot,
        admit: () => events.push("ephemeral-admit"),
      });

      expect(
        service.recoverUncertainLocationInWorkspaceLock(
          writeAuthority,
          context(),
        ),
      ).toEqual({
        kind: "protected",
        evidence: {
          kind: "exact-slot",
          slot: protectedLocation.protectedSlot,
          expectation: "matched",
          admission: { kind: "settled" },
        },
      });
      expect(admission.admit).toHaveBeenCalledOnce();
      expect(events).toEqual([
        "quarantine",
        "binding",
        "pin",
        "ephemeral-admit",
      ]);
    });
  });

  it("preserves exact recovery when only workspace-lock cleanup fails", async () => {
    const cleanup = new Error("workspace lock release failed");
    await withWorkspaceWriteAuthority(async (writeAuthority, storeRoot) => {
      const { service } = authority({
        workspaceCleanupFailure: cleanup,
        writeAuthority,
        storeRoot,
      });

      await expect(
        service.recoverUncertainLocation(context()),
      ).resolves.toEqual({
        arrival: {
          kind: "protected",
          evidence: {
            kind: "exact-slot",
            slot: protectedLocation.protectedSlot,
            expectation: "matched",
            admission: { kind: "settled" },
          },
        },
        workspaceLockCleanup: { kind: "failed", cause: cleanup },
      });
    });
  });

  it("protects retirement without reopening ephemeral admission", async () => {
    await withWorkspaceWriteAuthority(async (writeAuthority, storeRoot) => {
      const { service, admission } = authority({
        writeAuthority,
        storeRoot,
      });

      await expect(
        service.protectCurrentLocationForRetirement(context()),
      ).resolves.toMatchObject({
        arrival: {
          kind: "protected",
          evidence: {
            kind: "exact-slot",
            slot: protectedLocation.protectedSlot,
          },
        },
      });
      expect(admission.admit).not.toHaveBeenCalled();
      expect(admission.reset).toHaveBeenCalled();
    });
  });

  it("does not reopen admission after participation is withdrawn", async () => {
    await withWorkspaceWriteAuthority(async (writeAuthority, storeRoot) => {
      const { service, admission } = authority({
        participationIsActive: () => false,
        writeAuthority,
        storeRoot,
      });

      await expect(
        service.recoverUncertainLocation(context()),
      ).resolves.toMatchObject({
        arrival: {
          kind: "protected",
          evidence: {
            kind: "exact-slot",
            slot: protectedLocation.protectedSlot,
          },
        },
      });
      expect(admission.admit).not.toHaveBeenCalled();
    });
  });

  it("keeps exact durable protection when ephemeral admission settlement fails", async () => {
    const secondaryFailure = new Error("admission unavailable");
    await withWorkspaceWriteAuthority((writeAuthority, storeRoot) => {
      const { service, metadata } = authority({
        storeRoot,
        admit: () => {
          throw secondaryFailure;
        },
      });

      expect(
        service.recoverUncertainLocationInWorkspaceLock(
          writeAuthority,
          context(),
        ),
      ).toEqual({
        kind: "protected",
        evidence: {
          kind: "exact-slot",
          slot: protectedLocation.protectedSlot,
          expectation: "matched",
          admission: { kind: "failed", cause: secondaryFailure },
        },
      });
      expect(metadata.raiseSessionBarrier).not.toHaveBeenCalled();
    });
  });

  it("does not weaken durable arrival protection when ephemeral settlement fails", async () => {
    const settlementFailure = new Error("arrival authority changed");
    await withWorkspaceWriteAuthority((writeAuthority, storeRoot) => {
      const { service } = authority({
        storeRoot,
        arrivalSettlement: () => ({
          kind: "unsettled",
          cause: settlementFailure,
        }),
      });
      const host = context();
      const current = readSessionView(host);
      const attempt = {} as ReturnType<CheckpointAdmission["beginTreeArrival"]>;

      expect(
        service.protectCurrentTreeArrival(writeAuthority, attempt, current),
      ).toEqual({
        kind: "protected",
        evidence: {
          kind: "exact-slot",
          slot: protectedLocation.protectedSlot,
          expectation: "matched",
          admission: { kind: "failed", cause: settlementFailure },
        },
      });
    });
  });

  it("does not weaken durable arrival protection when ephemeral settlement throws", async () => {
    const settlementFailure = new Error("arrival settlement threw");
    await withWorkspaceWriteAuthority((writeAuthority, storeRoot) => {
      const { service } = authority({
        storeRoot,
        arrivalSettlement: () => {
          throw settlementFailure;
        },
      });
      const host = context();
      const attempt = {} as ReturnType<CheckpointAdmission["beginTreeArrival"]>;

      expect(
        service.protectCurrentTreeArrival(
          writeAuthority,
          attempt,
          readSessionView(host),
        ),
      ).toMatchObject({
        kind: "protected",
        evidence: {
          admission: { kind: "failed", cause: settlementFailure },
        },
      });
    });
  });

  it("keeps durable protection without misreporting a preserved transition", async () => {
    await withWorkspaceWriteAuthority((writeAuthority, storeRoot) => {
      const { service, admission, metadata } = authority({
        ordinaryClaim: () => ({ kind: "transition-conflict" }),
        storeRoot,
      });

      expect(
        service.protectCurrentNode(
          writeAuthority,
          readSessionView(context()),
          node,
        ),
      ).toMatchObject({
        kind: "protected",
        evidence: {
          kind: "exact-slot",
          slot: protectedLocation.protectedSlot,
          admission: { kind: "settled" },
        },
      });
      expect(metadata.protectLocation).toHaveBeenCalledOnce();
      expect(admission.claimOrdinaryMutation).toHaveBeenCalledOnce();
    });
  });

  it("never reopens ephemeral node authority after inactive protection", async () => {
    await withWorkspaceWriteAuthority((writeAuthority, storeRoot) => {
      const { service, admission, metadata } = authority({
        participationIsActive: () => false,
        storeRoot,
      });

      expect(
        service.protectCurrentNode(
          writeAuthority,
          readSessionView(context()),
          node,
        ),
      ).toMatchObject({
        kind: "protected",
        evidence: { admission: { kind: "settled" } },
      });
      expect(metadata.protectLocation).toHaveBeenCalledOnce();
      expect(admission.claimOrdinaryMutation).not.toHaveBeenCalled();
      expect(admission.reset).toHaveBeenCalled();
    });
  });

  it("returns an unsettled disposition when durable protection throws", async () => {
    const metadataFailure = new Error("metadata unavailable");
    await withWorkspaceWriteAuthority((writeAuthority, storeRoot) => {
      const { service } = authority({
        storeRoot,
        protectLocation: () => {
          throw metadataFailure;
        },
      });
      const host = context();

      expect(
        service.protectCurrentNode(writeAuthority, readSessionView(host), node),
      ).toEqual({
        kind: "unsettled",
        cause: metadataFailure,
      });
    });
  });
});
