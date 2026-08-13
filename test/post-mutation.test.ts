import { describe, expect, it, vi } from "vitest";

import {
  protectCurrentArrivalAfterWorkspaceFailure,
  protectCurrentArrivalInWorkspaceLock,
  restorePreparationConflict,
  type ArrivalRecovery,
} from "../src/pi/post-mutation.ts";
import { unavailableProtection } from "../src/pi/arrival-protection.ts";

const exactProtection = {
  kind: "exact-slot",
  slot: { kind: "blocked-missing" },
  admission: { kind: "settled" },
} as const;

function recoveryWith(overrides: Partial<ArrivalRecovery>): ArrivalRecovery {
  const unexpected = () => {
    throw new Error("unexpected recovery path");
  };
  return {
    recoverUncertainLocationInWorkspaceLock: unexpected,
    recoverUncertainLocation: async () => ({
      protection: unexpected(),
      workspaceLockCleanup: { kind: "settled" },
    }),
    ...overrides,
  };
}

describe("post-mutation recovery facade", () => {
  it("preserves an explicit undefined throw as the sole recovery cause", () => {
    const result = unavailableProtection("recovery failed", [undefined]);

    expect(result.cause).toBeInstanceOf(Error);
    expect(result.cause).not.toBeInstanceOf(AggregateError);
    expect(Object.hasOwn(result.cause as object, "cause")).toBe(true);
    expect((result.cause as Error).cause).toBeUndefined();
  });

  it.each([exactProtection, { kind: "session-barrier" }] as const)(
    "forwards core $kind recovery without duplicating policy",
    async (report) => {
      const recover = vi.fn(() => report);
      const recovery = recoveryWith({
        recoverUncertainLocationInWorkspaceLock: recover,
      });
      const context = {} as never;

      await expect(
        protectCurrentArrivalInWorkspaceLock(recovery, context),
      ).resolves.toEqual({
        protection: report,
        workspaceLockCleanup: { kind: "settled" },
      });
      expect(recover).toHaveBeenCalledWith(context);
    },
  );

  it("reports unavailable lock-scoped recovery", async () => {
    const recovery = recoveryWith({
      recoverUncertainLocationInWorkspaceLock: () => ({
        kind: "unavailable",
        cause: new Error("current arrival could not be protected"),
      }),
    });

    await expect(
      protectCurrentArrivalInWorkspaceLock(recovery, {} as never),
    ).resolves.toEqual({
      protection: {
        kind: "unavailable",
        cause: expect.objectContaining({
          message: "current arrival could not be protected",
        }),
      },
      workspaceLockCleanup: { kind: "settled" },
    });
  });

  it("preserves a thrown recovery cause as unavailable", async () => {
    const cause = new Error("metadata unavailable");
    const recovery = recoveryWith({
      recoverUncertainLocationInWorkspaceLock: () => {
        throw cause;
      },
    });

    await expect(
      protectCurrentArrivalInWorkspaceLock(recovery, {} as never),
    ).resolves.toEqual({
      protection: {
        kind: "unavailable",
        cause: expect.objectContaining({
          message: "current arrival could not be protected",
          cause,
        }),
      },
      workspaceLockCleanup: { kind: "settled" },
    });
  });

  it("delegates reacquisition to the same runtime recovery core", async () => {
    const recover = vi.fn(async () => ({
      protection: { kind: "session-barrier" as const },
      workspaceLockCleanup: { kind: "settled" as const },
    }));
    const recovery = recoveryWith({
      recoverUncertainLocation: recover,
    });
    const context = {} as never;

    await expect(
      protectCurrentArrivalAfterWorkspaceFailure(recovery, context),
    ).resolves.toEqual({
      protection: { kind: "session-barrier" },
      workspaceLockCleanup: { kind: "settled" },
    });
    expect(recover).toHaveBeenCalledWith(context);
  });

  it("keeps a loaded primary failure when protection is also unavailable", async () => {
    const primary = new Error("checkpoint unreadable");
    const protection = new Error("metadata protection failed");
    const recovery = recoveryWith({
      recoverUncertainLocationInWorkspaceLock: () => {
        throw protection;
      },
    });

    await expect(
      restorePreparationConflict(recovery, {} as never, primary, "held"),
    ).resolves.toEqual({
      kind: "preparation-conflict",
      cause: primary,
      arrivalProtection: {
        kind: "unavailable",
        cause: expect.objectContaining({
          message: "current arrival could not be protected",
          cause: protection,
        }),
      },
      workspaceLockCleanup: { kind: "settled" },
    });
  });

  it("reacquires recovery only when the lock scope was released", async () => {
    const recoverHeld = vi.fn(() => exactProtection);
    const recoverReleased = vi.fn(async () => ({
      protection: { kind: "session-barrier" as const },
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
        "released",
      ),
    ).resolves.toMatchObject({
      kind: "preparation-conflict",
      arrivalProtection: { kind: "session-barrier" },
    });
    expect(recoverReleased).toHaveBeenCalledOnce();
    expect(recoverHeld).not.toHaveBeenCalled();
  });
});
