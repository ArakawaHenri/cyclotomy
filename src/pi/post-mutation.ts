import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { RestoreOutcome } from "../application/restore.ts";
import type { CleanupSettlement } from "../domain/cleanup-settlement.ts";
import type { WorkspaceWriteAuthority } from "../infrastructure/workspace-lock.ts";
import {
  type NonAdmittedArrivalDisposition,
  unsettledArrival,
} from "./arrival-settlement.ts";
import {
  mergeCleanupSettlements,
  type ArrivalReceipt,
  type ArrivalRecoverySettlement,
  type LockedArrivalOutcome,
} from "./workspace-receipt.ts";
import { messageOfUnknown } from "./unknown-error.ts";

type WorkspaceLockScope =
  | {
      readonly kind: "held";
      readonly writeAuthority: WorkspaceWriteAuthority;
    }
  | { readonly kind: "released" };

/** Narrow recovery capability shared by restore and lifecycle settlements. */
export interface ArrivalRecovery {
  recoverUncertainLocationInWorkspaceLock(
    writeAuthority: WorkspaceWriteAuthority,
    context: ExtensionContext,
  ): NonAdmittedArrivalDisposition;
  recoverUncertainLocation(
    context: ExtensionContext,
  ): Promise<ArrivalRecoverySettlement>;
}

export interface CheckpointInitializationConflictExecution {
  readonly kind: "initialization-conflict";
  readonly cause: unknown;
}

export type CheckpointInitializationConflict =
  ArrivalReceipt<CheckpointInitializationConflictExecution> & {
    readonly arrival: NonAdmittedArrivalDisposition;
  };

type LockedCheckpointInitializationConflict =
  LockedArrivalOutcome<CheckpointInitializationConflictExecution> & {
    readonly arrival: NonAdmittedArrivalDisposition;
  };

/** Preserve a settlement already completed by InitializationProtocol. */
export function checkpointInitializationDispositionConflict(
  cause: unknown,
  arrival: NonAdmittedArrivalDisposition,
): LockedCheckpointInitializationConflict {
  return {
    execution: { kind: "initialization-conflict", cause },
    arrival,
  };
}

export interface RestorePreparationConflictExecution {
  readonly kind: "preparation-conflict";
  readonly cause: unknown;
}

export type RestorePreparationConflict =
  ArrivalReceipt<RestorePreparationConflictExecution> & {
    readonly arrival: NonAdmittedArrivalDisposition;
  };

type LockedRestorePreparationConflict =
  LockedArrivalOutcome<RestorePreparationConflictExecution> & {
    readonly arrival: NonAdmittedArrivalDisposition;
  };

export type PostMutationConflictExecution = {
  readonly kind: "post-mutation-conflict";
  readonly outcome: RestoreOutcome;
  readonly preparationCleanup: CleanupSettlement;
} & (
  | {
      readonly reason: "location-changed" | "target-changed";
    }
  | {
      readonly reason: "control-failed";
      readonly cause: unknown;
    }
);

export type PostMutationConflict =
  ArrivalReceipt<PostMutationConflictExecution> & {
    readonly arrival: NonAdmittedArrivalDisposition;
  };

type LockedPostMutationConflict =
  LockedArrivalOutcome<PostMutationConflictExecution> & {
    readonly arrival: NonAdmittedArrivalDisposition;
  };

/**
 * The sole recovery facade for callers already holding the workspace lock.
 * Authentication, exact-slot blocking, and node-free barrier fallback all
 * live in the runtime's core recovery policy.
 */
export async function protectCurrentArrivalInWorkspaceLock(
  recovery: ArrivalRecovery,
  writeAuthority: WorkspaceWriteAuthority,
  context: ExtensionContext,
): Promise<NonAdmittedArrivalDisposition> {
  try {
    return recovery.recoverUncertainLocationInWorkspaceLock(
      writeAuthority,
      context,
    );
  } catch (cause) {
    return unsettledArrival("current arrival could not be protected", [cause]);
  }
}

/** Recover after the previous lock scope failed or has already unwound. */
export async function protectCurrentArrivalAfterWorkspaceFailure(
  recovery: ArrivalRecovery,
  context: ExtensionContext,
): Promise<ArrivalRecoverySettlement> {
  try {
    return await recovery.recoverUncertainLocation(context);
  } catch (cause) {
    return {
      arrival: unsettledArrival(
        "current arrival protection could not reacquire the workspace lock",
        [cause],
      ),
      workspaceLockCleanup: { kind: "settled" },
    };
  }
}

export function isLockedArrivalOutcome<Execution>(
  value: Execution | LockedArrivalOutcome<Execution>,
): value is LockedArrivalOutcome<Execution> {
  return typeof value === "object" && value !== null && "execution" in value;
}

/**
 * Construct the sole final arrival receipt after the action lock has unwound.
 * A locked outcome never guesses at cleanup, and held recovery is retried once.
 */
export function finalizeArrivalAfterWorkspaceExecution<Execution>(
  recovery: ArrivalRecovery,
  context: ExtensionContext,
  outcome: LockedArrivalOutcome<Execution>,
  workspaceLockCleanup: ArrivalReceipt<Execution>["workspaceLockCleanup"],
): Promise<ArrivalReceipt<Execution>>;
export function finalizeArrivalAfterWorkspaceExecution<Execution>(
  recovery: ArrivalRecovery,
  context: ExtensionContext,
  execution: Execution,
  workspaceLockCleanup: ArrivalReceipt<Execution>["workspaceLockCleanup"],
  releasedSettlement: ArrivalRecoverySettlement,
): Promise<ArrivalReceipt<Execution>>;
export async function finalizeArrivalAfterWorkspaceExecution<Execution>(
  recovery: ArrivalRecovery,
  context: ExtensionContext,
  outcome: Execution | LockedArrivalOutcome<Execution>,
  workspaceLockCleanup: ArrivalReceipt<Execution>["workspaceLockCleanup"],
  releasedSettlement?: ArrivalRecoverySettlement,
): Promise<ArrivalReceipt<Execution>> {
  if (releasedSettlement !== undefined) {
    return {
      execution: outcome as Execution,
      arrival: releasedSettlement.arrival,
      workspaceLockCleanup: mergeCleanupSettlements(
        workspaceLockCleanup,
        releasedSettlement.workspaceLockCleanup,
      ),
    };
  }
  const receipt: ArrivalReceipt<Execution> = {
    ...(outcome as LockedArrivalOutcome<Execution>),
    workspaceLockCleanup,
  };
  if (receipt.arrival.kind !== "unsettled") return receipt;
  const retried = await protectCurrentArrivalAfterWorkspaceFailure(
    recovery,
    context,
  );
  return {
    ...receipt,
    arrival:
      retried.arrival.kind === "unsettled"
        ? unsettledArrival(messageOfUnknown(receipt.arrival.cause), [
            receipt.arrival.cause,
            retried.arrival.cause,
          ])
        : retried.arrival,
    workspaceLockCleanup: mergeCleanupSettlements(
      receipt.workspaceLockCleanup,
      retried.workspaceLockCleanup,
    ),
  };
}

async function protectCurrentArrivalForLockScope(
  recovery: ArrivalRecovery,
  context: ExtensionContext,
  lockScope: WorkspaceLockScope,
): Promise<
  | {
      readonly kind: "held";
      readonly arrival: NonAdmittedArrivalDisposition;
    }
  | {
      readonly kind: "released";
      readonly settlement: ArrivalRecoverySettlement;
    }
> {
  return lockScope.kind === "held"
    ? {
        kind: "held",
        arrival: await protectCurrentArrivalInWorkspaceLock(
          recovery,
          lockScope.writeAuthority,
          context,
        ),
      }
    : {
        kind: "released",
        settlement: await protectCurrentArrivalAfterWorkspaceFailure(
          recovery,
          context,
        ),
      };
}

/** A loaded arrival could not even authenticate its checkpoint. */
export function restorePreparationConflict(
  recovery: ArrivalRecovery,
  context: ExtensionContext,
  cause: unknown,
  lockScope: Extract<WorkspaceLockScope, { readonly kind: "held" }>,
): Promise<LockedRestorePreparationConflict>;
export function restorePreparationConflict(
  recovery: ArrivalRecovery,
  context: ExtensionContext,
  cause: unknown,
  lockScope: Extract<WorkspaceLockScope, { readonly kind: "released" }>,
): Promise<RestorePreparationConflict>;
export async function restorePreparationConflict(
  recovery: ArrivalRecovery,
  context: ExtensionContext,
  cause: unknown,
  lockScope: WorkspaceLockScope,
): Promise<LockedRestorePreparationConflict | RestorePreparationConflict> {
  const recovered = await protectCurrentArrivalForLockScope(
    recovery,
    context,
    lockScope,
  );
  if (recovered.kind === "held") {
    return {
      execution: { kind: "preparation-conflict", cause },
      arrival: recovered.arrival,
    };
  }
  return finalizeArrivalAfterWorkspaceExecution(
    recovery,
    context,
    { kind: "preparation-conflict", cause },
    { kind: "settled" },
    recovered.settlement,
  ) as Promise<RestorePreparationConflict>;
}

/** Preserve the destructive outcome when a later control-plane step fails. */
export function postMutationControlFailure(
  recovery: ArrivalRecovery,
  context: ExtensionContext,
  error: unknown,
  outcome: RestoreOutcome | undefined,
  preparationCleanup: CleanupSettlement,
  lockScope: Extract<WorkspaceLockScope, { readonly kind: "held" }>,
): Promise<LockedPostMutationConflict>;
export function postMutationControlFailure(
  recovery: ArrivalRecovery,
  context: ExtensionContext,
  error: unknown,
  outcome: RestoreOutcome | undefined,
  preparationCleanup: CleanupSettlement,
  lockScope: Extract<WorkspaceLockScope, { readonly kind: "released" }>,
): Promise<PostMutationConflict>;
export async function postMutationControlFailure(
  recovery: ArrivalRecovery,
  context: ExtensionContext,
  error: unknown,
  outcome: RestoreOutcome | undefined,
  preparationCleanup: CleanupSettlement,
  lockScope: WorkspaceLockScope,
): Promise<LockedPostMutationConflict | PostMutationConflict> {
  const recovered = await protectCurrentArrivalForLockScope(
    recovery,
    context,
    lockScope,
  );
  const execution = postMutationControlFailureExecution(
    error,
    outcome,
    preparationCleanup,
  );
  if (recovered.kind === "held") {
    return { execution, arrival: recovered.arrival };
  }
  return finalizeArrivalAfterWorkspaceExecution(
    recovery,
    context,
    execution,
    { kind: "settled" },
    recovered.settlement,
  ) as Promise<PostMutationConflict>;
}

export function postMutationControlFailureExecution(
  error: unknown,
  outcome: RestoreOutcome | undefined,
  preparationCleanup: CleanupSettlement,
): PostMutationConflictExecution {
  return {
    kind: "post-mutation-conflict",
    reason: "control-failed",
    outcome:
      outcome ??
      ({
        kind: "failed",
        stage: "apply",
        cause: error,
      } satisfies RestoreOutcome),
    cause: error,
    preparationCleanup,
  };
}

/** Preserve the restore result while settling a late location/target race. */
export async function postMutationStateConflict(
  recovery: ArrivalRecovery,
  context: ExtensionContext,
  reason: "location-changed" | "target-changed",
  outcome: RestoreOutcome,
  preparationCleanup: CleanupSettlement,
  lockScope: Extract<WorkspaceLockScope, { readonly kind: "held" }>,
): Promise<LockedPostMutationConflict> {
  const arrival = await protectCurrentArrivalInWorkspaceLock(
    recovery,
    lockScope.writeAuthority,
    context,
  );
  return {
    execution: {
      kind: "post-mutation-conflict",
      reason,
      outcome,
      preparationCleanup,
    },
    arrival,
  };
}
