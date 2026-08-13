import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { RestoreOutcome } from "../application/restore.ts";
import {
  type ArrivalProtection,
  unavailableProtection,
} from "./arrival-protection.ts";
import {
  arrivalProtectionFromDisposition,
  type ArrivalDisposition,
} from "./arrival-settlement.ts";

type WorkspaceLockScope = "held" | "released";
export type CleanupSettlement =
  | { readonly kind: "settled" }
  | { readonly kind: "failed"; readonly cause: unknown };

/** Combine independent lock-release receipts without losing either failure. */
export function mergeCleanupSettlements(
  ...settlements: readonly CleanupSettlement[]
): CleanupSettlement {
  const failures = settlements.flatMap((settlement) =>
    settlement.kind === "failed" ? [settlement.cause] : [],
  );
  if (failures.length === 0) return { kind: "settled" };
  if (failures.length === 1) return { kind: "failed", cause: failures[0] };
  return {
    kind: "failed",
    cause: new AggregateError(
      failures,
      "multiple workspace-lock cleanup attempts failed",
      { cause: failures[0] },
    ),
  };
}

export interface ArrivalRecoveryExecution {
  readonly protection: ArrivalProtection;
  readonly workspaceLockCleanup: CleanupSettlement;
}

/** Narrow recovery capability shared by restore and lifecycle settlements. */
export interface ArrivalRecovery {
  recoverUncertainLocationInWorkspaceLock(
    context: ExtensionContext,
  ): ArrivalProtection;
  recoverUncertainLocation(
    context: ExtensionContext,
  ): Promise<ArrivalRecoveryExecution>;
}

export interface CheckpointInitializationConflict {
  readonly kind: "initialization-conflict";
  readonly cause: unknown;
  readonly arrivalProtection: ArrivalProtection;
}

/** Preserve a settlement already completed by InitializationProtocol. */
export function checkpointInitializationDispositionConflict(
  cause: unknown,
  arrival: Exclude<ArrivalDisposition, { readonly kind: "admitted" }>,
): CheckpointInitializationConflict {
  return {
    kind: "initialization-conflict",
    cause,
    arrivalProtection: arrivalProtectionFromDisposition(arrival),
  };
}

export interface RestorePreparationConflict {
  readonly kind: "preparation-conflict";
  readonly cause: unknown;
  readonly arrivalProtection: ArrivalProtection;
  readonly workspaceLockCleanup: CleanupSettlement;
}

export type PostMutationConflict =
  | {
      readonly kind: "post-mutation-conflict";
      readonly reason: "location-changed" | "target-changed";
      readonly outcome: RestoreOutcome;
      readonly arrivalProtection: ArrivalProtection;
      readonly workspaceLockCleanup: CleanupSettlement;
    }
  | {
      readonly kind: "post-mutation-conflict";
      readonly reason: "control-failed";
      readonly outcome: RestoreOutcome;
      readonly cause: unknown;
      readonly arrivalProtection: ArrivalProtection;
      readonly workspaceLockCleanup: CleanupSettlement;
    };

/**
 * The sole recovery facade for callers already holding the workspace lock.
 * Authentication, exact-slot blocking, and node-free barrier fallback all
 * live in the runtime's core recovery policy.
 */
export async function protectCurrentArrivalInWorkspaceLock(
  recovery: ArrivalRecovery,
  context: ExtensionContext,
): Promise<ArrivalRecoveryExecution> {
  try {
    return {
      protection: recovery.recoverUncertainLocationInWorkspaceLock(context),
      workspaceLockCleanup: { kind: "settled" },
    };
  } catch (cause) {
    return {
      protection: unavailableProtection(
        "current arrival could not be protected",
        [cause],
      ),
      workspaceLockCleanup: { kind: "settled" },
    };
  }
}

/** Recover after the previous lock scope failed or has already unwound. */
export async function protectCurrentArrivalAfterWorkspaceFailure(
  recovery: ArrivalRecovery,
  context: ExtensionContext,
): Promise<ArrivalRecoveryExecution> {
  try {
    return await recovery.recoverUncertainLocation(context);
  } catch (cause) {
    return {
      protection: unavailableProtection(
        "current arrival protection could not reacquire the workspace lock",
        [cause],
      ),
      workspaceLockCleanup: { kind: "settled" },
    };
  }
}

function protectCurrentArrivalForLockScope(
  recovery: ArrivalRecovery,
  context: ExtensionContext,
  lockScope: WorkspaceLockScope,
): Promise<ArrivalRecoveryExecution> {
  return lockScope === "held"
    ? protectCurrentArrivalInWorkspaceLock(recovery, context)
    : protectCurrentArrivalAfterWorkspaceFailure(recovery, context);
}

/** A loaded arrival could not even authenticate its checkpoint. */
export async function restorePreparationConflict(
  recovery: ArrivalRecovery,
  context: ExtensionContext,
  cause: unknown,
  lockScope: WorkspaceLockScope,
): Promise<RestorePreparationConflict> {
  const recoveryExecution = await protectCurrentArrivalForLockScope(
    recovery,
    context,
    lockScope,
  );
  return {
    kind: "preparation-conflict",
    cause,
    arrivalProtection: recoveryExecution.protection,
    workspaceLockCleanup: recoveryExecution.workspaceLockCleanup,
  };
}

/** Preserve the destructive outcome when a later control-plane step fails. */
export async function postMutationControlFailure(
  recovery: ArrivalRecovery,
  context: ExtensionContext,
  error: unknown,
  outcome: RestoreOutcome | undefined,
  lockScope: WorkspaceLockScope,
): Promise<PostMutationConflict> {
  const recoveryExecution = await protectCurrentArrivalForLockScope(
    recovery,
    context,
    lockScope,
  );
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
    arrivalProtection: recoveryExecution.protection,
    workspaceLockCleanup: recoveryExecution.workspaceLockCleanup,
  };
}

/** Preserve the restore result while settling a late location/target race. */
export async function postMutationStateConflict(
  recovery: ArrivalRecovery,
  context: ExtensionContext,
  reason: "location-changed" | "target-changed",
  outcome: RestoreOutcome,
  lockScope: WorkspaceLockScope,
): Promise<PostMutationConflict> {
  const recoveryExecution = await protectCurrentArrivalForLockScope(
    recovery,
    context,
    lockScope,
  );
  return {
    kind: "post-mutation-conflict",
    reason,
    outcome,
    arrivalProtection: recoveryExecution.protection,
    workspaceLockCleanup: recoveryExecution.workspaceLockCleanup,
  };
}
