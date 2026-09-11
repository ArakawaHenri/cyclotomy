import { realpath } from "node:fs/promises";

import {
  inspectWorkspaceLock,
  quarantineLegacyWorkspaceLock,
  type WorkspaceLockDiagnostic,
  type LegacyWorkspaceLockOwnerObservation,
} from "../infrastructure/workspace-lock.ts";
import {
  MaintenanceBlockedError,
  MaintenancePreviewChangedError,
  maintenancePlanToken,
  type MaintenanceIssue,
} from "./maintenance-plan.ts";

export type LockRecoveryIssueCode =
  | "lock-protocol-corrupt"
  | "lock-protocol-inconsistent"
  | "lock-protocol-unsupported";

export type LockRecoveryIssue = MaintenanceIssue & {
  readonly code: LockRecoveryIssueCode;
};

export interface LockRecoveryPreview {
  readonly storeRoot: string;
  readonly lockProtocol: WorkspaceLockDiagnostic;
  /**
   * Only a legacy directory lock can be quarantined. A native lock file is
   * never removed, renamed or recreated by any recovery.
   */
  readonly recoverable: boolean;
  readonly planToken: string | null;
  readonly issues: readonly LockRecoveryIssue[];
}

export type LockRecoveryResult =
  | {
      readonly kind: "quarantined";
      readonly storeRoot: string;
      readonly path: string;
    }
  | {
      readonly kind: "nothing-to-recover";
      readonly storeRoot: string;
      readonly lockProtocol: WorkspaceLockDiagnostic;
    };

export interface LockRecoveryOptions {
  /**
   * The operator asserts that every process which may access this store has
   * stopped. Lock occupancy probing cannot prove that, so this is an explicit
   * precondition rather than something the implementation infers.
   */
  readonly offline: true;
  readonly signal?: AbortSignal;
}

function ownerPlanFacts(
  observation: LegacyWorkspaceLockOwnerObservation,
): readonly unknown[] {
  if (observation.kind !== "valid") return [observation.kind];
  const { token, pid, hostname, operation, acquiredAt } = observation.owner;
  return ["valid", token, pid, hostname, operation, acquiredAt];
}

/**
 * Preview the one-off offline recovery of a legacy directory lock. Read-only:
 * it neither creates an owner record nor deletes the directory.
 */
export async function previewLockRecovery(
  storeRoot: string,
): Promise<LockRecoveryPreview> {
  const canonicalRoot = await realpath(storeRoot);
  const lockProtocol = await inspectWorkspaceLock(canonicalRoot);
  const issues = Object.freeze(lockRecoveryIssues(lockProtocol));
  const recoverable = lockProtocol.kind === "legacy-directory";
  return Object.freeze({
    storeRoot: canonicalRoot,
    lockProtocol,
    recoverable,
    planToken:
      recoverable && issues.length === 0
        ? maintenancePlanToken([
            canonicalRoot,
            ownerPlanFacts(lockProtocol.owner),
          ])
        : null,
    issues,
  });
}

function lockRecoveryIssues(
  diagnostic: WorkspaceLockDiagnostic,
): readonly LockRecoveryIssue[] {
  switch (diagnostic.kind) {
    case "corrupt":
      return [{ code: "lock-protocol-corrupt", detail: diagnostic.detail }];
    case "inconsistent":
      return [
        { code: "lock-protocol-inconsistent", detail: diagnostic.detail },
      ];
    case "unsupported":
      return [
        {
          code: "lock-protocol-unsupported",
          detail: `observed protocol ${String(
            diagnostic.observedProtocol,
          )} with format ${String(diagnostic.observedFormat)}`,
        },
      ];
    default:
      return [];
  }
}

/**
 * Isolate a legacy directory lock that no live protocol can release, after the
 * operator established the offline window. The preview token must still match,
 * so a store that became native, or whose owner record changed, is never
 * quarantined on a stale plan.
 */
export async function applyLockRecovery(
  storeRoot: string,
  planToken: string,
  options: LockRecoveryOptions,
): Promise<LockRecoveryResult> {
  if (options.offline !== true) {
    throw new TypeError(
      "offline lock recovery requires an explicit offline precondition",
    );
  }
  options.signal?.throwIfAborted();

  const preview = await previewLockRecovery(storeRoot);
  if (preview.issues.length > 0) {
    throw new MaintenanceBlockedError(preview.storeRoot, preview.issues);
  }
  options.signal?.throwIfAborted();
  if (!preview.recoverable) {
    return Object.freeze({
      kind: "nothing-to-recover" as const,
      storeRoot: preview.storeRoot,
      lockProtocol: preview.lockProtocol,
    });
  }
  if (preview.planToken === null || preview.planToken !== planToken) {
    throw new MaintenancePreviewChangedError(preview.storeRoot);
  }

  const quarantine = await quarantineLegacyWorkspaceLock(preview.storeRoot);
  if (quarantine.kind !== "quarantined") {
    // The path stopped being a legacy directory between preview and apply.
    throw new MaintenancePreviewChangedError(preview.storeRoot);
  }
  return Object.freeze({
    kind: "quarantined" as const,
    storeRoot: preview.storeRoot,
    path: quarantine.path,
  });
}
