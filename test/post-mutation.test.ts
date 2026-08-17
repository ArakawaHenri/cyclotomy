import { describe, expect, it, vi } from "vitest";

import {
  finalizeArrivalAfterWorkspaceExecution,
  protectCurrentArrivalAfterWorkspaceFailure,
  protectCurrentArrivalInWorkspaceLock,
  postMutationStateConflict,
  restorePreparationConflict,
  type ArrivalRecovery,
} from "../src/pi/post-mutation.ts";
import { aggregateFailures } from "../src/infrastructure/failure-settlement.ts";
import type { WorkspaceWriteAuthority } from "../src/infrastructure/workspace-lock.ts";

const writeAuthority = {} as WorkspaceWriteAuthority;

const exactArrival = {
  kind: "protected",
  evidence: {
    kind: "exact-slot",
    slot: { kind: "blocked-missing" },
    expectation: "matched",
    admission: { kind: "settled" },
  },
} as const;

const barrierArrival = {
  kind: "protected",
  evidence: {
    kind: "session-barrier",
    admission: { kind: "settled" },
  },
} as const;

function recoveryWith(overrides: Partial<ArrivalRecovery>): ArrivalRecovery {
  const unexpected = () => {
    throw new Error("unexpected recovery path");
  };
  return {
    recoverUncertainLocationInWorkspaceLock: unexpected,
    recoverUncertainLocation: async () => ({
      arrival: unexpected(),
      workspaceLockCleanup: { kind: "settled" },
    }),
    ...overrides,
  };
}

describe("post-mutation recovery facade", () => {
  it.each([exactArrival, barrierArrival] as const)(
    "forwards canonical $kind recovery without duplicating policy",
    async (arrival) => {
      const recover = vi.fn(() => arrival);
      const recovery = recoveryWith({
        recoverUncertainLocationInWorkspaceLock: recover,
      });
      const context = {} as never;

      await expect(
        protectCurrentArrivalInWorkspaceLock(recovery, writeAuthority, context),
      ).resolves.toBe(arrival);
      expect(recover).toHaveBeenCalledWith(writeAuthority, context);
    },
  );

  it("preserves a thrown recovery cause as an unsettled arrival", async () => {
    const cause = new Error("metadata unavailable");
    const recovery = recoveryWith({
      recoverUncertainLocationInWorkspaceLock: () => {
        throw cause;
      },
    });

    await expect(
      protectCurrentArrivalInWorkspaceLock(
        recovery,
        writeAuthority,
        {} as never,
      ),
    ).resolves.toEqual({
      kind: "unsettled",
      cause: expect.objectContaining({
        message: "current arrival could not be protected",
        cause,
      }),
    });
  });

  it("delegates reacquisition without translating its receipt", async () => {
    const receipt = {
      arrival: barrierArrival,
      workspaceLockCleanup: {
        kind: "failed" as const,
        cause: new Error("release failed"),
      },
    };
    const recover = vi.fn(async () => receipt);
    const recovery = recoveryWith({ recoverUncertainLocation: recover });
    const context = {} as never;

    await expect(
      protectCurrentArrivalAfterWorkspaceFailure(recovery, context),
    ).resolves.toEqual(receipt);
    expect(recover).toHaveBeenCalledWith(context);
  });

  it("keeps execution, arrival, and cleanup in one preparation receipt", async () => {
    const primary = new Error("checkpoint unreadable");
    const cleanup = new Error("recovery release failed");
    const recovery = recoveryWith({
      recoverUncertainLocation: async () => ({
        arrival: barrierArrival,
        workspaceLockCleanup: { kind: "failed", cause: cleanup },
      }),
    });

    await expect(
      restorePreparationConflict(recovery, {} as never, primary, {
        kind: "released",
      }),
    ).resolves.toEqual({
      execution: { kind: "preparation-conflict", cause: primary },
      arrival: barrierArrival,
      workspaceLockCleanup: { kind: "failed", cause: cleanup },
    });
  });

  it("uses only the recovery permitted by the current lock scope", async () => {
    const recoverHeld = vi.fn(() => exactArrival);
    const recoverReleased = vi.fn(async () => ({
      arrival: barrierArrival,
      workspaceLockCleanup: { kind: "settled" as const },
    }));
    const recovery = recoveryWith({
      recoverUncertainLocationInWorkspaceLock: recoverHeld,
      recoverUncertainLocation: recoverReleased,
    });

    await expect(
      restorePreparationConflict(
        recovery,
        {} as never,
        new Error("checkpoint unreadable"),
        { kind: "released" },
      ),
    ).resolves.toMatchObject({
      execution: { kind: "preparation-conflict" },
      arrival: barrierArrival,
    });
    expect(recoverReleased).toHaveBeenCalledOnce();
    expect(recoverHeld).not.toHaveBeenCalled();
  });

  it("constructs a released receipt without rerunning completed recovery", async () => {
    const execution = { kind: "failed-after-release" } as const;
    const outerCleanup = new Error("action lock release failed");
    const recoveryCleanup = new Error("recovery lock release failed");
    const recover = vi.fn();

    const result = await finalizeArrivalAfterWorkspaceExecution(
      recoveryWith({ recoverUncertainLocation: recover }),
      {} as never,
      execution,
      { kind: "failed", cause: outerCleanup },
      {
        arrival: barrierArrival,
        workspaceLockCleanup: { kind: "failed", cause: recoveryCleanup },
      },
    );

    expect(result.execution).toBe(execution);
    expect(result.arrival).toBe(barrierArrival);
    expect(
      (result.workspaceLockCleanup as { cause: AggregateError }).cause.errors,
    ).toEqual([outerCleanup, recoveryCleanup]);
    expect(recover).not.toHaveBeenCalled();
  });

  it("does not retry an arrival that is already settled", async () => {
    const recover = vi.fn();
    const receipt = {
      execution: { kind: "kept" },
      arrival: barrierArrival,
      workspaceLockCleanup: { kind: "settled" as const },
    };

    await expect(
      finalizeArrivalAfterWorkspaceExecution(
        recoveryWith({ recoverUncertainLocation: recover }),
        {} as never,
        {
          execution: receipt.execution,
          arrival: receipt.arrival,
        },
        receipt.workspaceLockCleanup,
      ),
    ).resolves.toEqual(receipt);
    expect(recover).not.toHaveBeenCalled();
  });

  it("retries a held failure once while preserving its execution", async () => {
    const execution = { kind: "kept" } as const;
    const recovery = recoveryWith({
      recoverUncertainLocation: async () => ({
        arrival: exactArrival,
        workspaceLockCleanup: { kind: "settled" },
      }),
    });

    const result = await finalizeArrivalAfterWorkspaceExecution(
      recovery,
      {} as never,
      {
        execution,
        arrival: { kind: "unsettled", cause: new Error("held recovery") },
      },
      { kind: "settled" },
    );

    expect(result.execution).toBe(execution);
    expect(result.arrival).toBe(exactArrival);
  });

  it("flattens failures from both recovery attempts", async () => {
    const first = new Error("first");
    const second = new Error("second");
    const third = new Error("third");
    const recovery = recoveryWith({
      recoverUncertainLocation: async () => ({
        arrival: { kind: "unsettled", cause: third },
        workspaceLockCleanup: { kind: "settled" },
      }),
    });

    const result = await finalizeArrivalAfterWorkspaceExecution(
      recovery,
      {} as never,
      {
        execution: { kind: "kept" },
        arrival: {
          kind: "unsettled",
          cause: aggregateFailures([first, second], "earlier failures"),
        },
      },
      { kind: "settled" },
    );

    expect(result.arrival.kind).toBe("unsettled");
    if (result.arrival.kind !== "unsettled") {
      throw new Error("expected both recovery attempts to remain unsettled");
    }
    expect((result.arrival.cause as AggregateError).message).toBe(
      "earlier failures",
    );
    expect((result.arrival.cause as AggregateError).errors).toEqual([
      first,
      second,
      third,
    ]);
  });

  it("merges cleanup independently from a successful retry", async () => {
    const firstCleanup = new Error("first cleanup");
    const secondCleanup = new Error("second cleanup");
    const recovery = recoveryWith({
      recoverUncertainLocation: async () => ({
        arrival: barrierArrival,
        workspaceLockCleanup: { kind: "failed", cause: secondCleanup },
      }),
    });

    const result = await finalizeArrivalAfterWorkspaceExecution(
      recovery,
      {} as never,
      {
        execution: { kind: "kept" },
        arrival: { kind: "unsettled", cause: new Error("held recovery") },
      },
      { kind: "failed", cause: firstCleanup },
    );

    expect(result.arrival).toBe(barrierArrival);
    expect(
      (result.workspaceLockCleanup as { cause: AggregateError }).cause.errors,
    ).toEqual([firstCleanup, secondCleanup]);
  });

  it("carries preparation cleanup through a late state conflict", async () => {
    const cleanup = {
      kind: "failed" as const,
      cause: new Error("restore staging remained"),
    };
    const recovery = recoveryWith({
      recoverUncertainLocationInWorkspaceLock: () => exactArrival,
    });

    const result = await postMutationStateConflict(
      recovery,
      {} as never,
      "target-changed",
      {
        kind: "failed",
        stage: "verification",
        cause: new Error("verification stopped"),
      },
      cleanup,
      { kind: "held", writeAuthority },
    );

    expect(result.execution.preparationCleanup).toBe(cleanup);
    expect(result.execution.reason).toBe("target-changed");
  });
});
