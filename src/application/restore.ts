import {
  applyTreeToWorkspace,
  type ApplyReport,
} from "../infrastructure/apply.ts";
import {
  BlobStagingCleanupError,
  BlobStagingError,
  stageBlobs,
  type StagedBlobs,
} from "../infrastructure/blob-staging.ts";
import {
  openObjectStoreReadScope,
  type ObjectStore,
  type ObjectStoreReadScope,
} from "../infrastructure/object-store.ts";
import type { CurrentTreeManifest } from "../infrastructure/tree-formats/current.ts";
import {
  planWorkspaceRestore,
  restorePlanHasChanges,
} from "../infrastructure/restore-plan.ts";
import {
  scanWorkspaceForRestoreComparison,
  type ScanProblem,
  type WorkspaceSnapshot,
} from "../infrastructure/workspace-scan.ts";
import type { TreeOid } from "../domain/model.ts";
import type { CleanupSettlement } from "../domain/cleanup-settlement.ts";
import {
  aggregateFailures,
  retainFailureCause,
} from "../infrastructure/failure-settlement.ts";
import {
  sameGitOracleVersion,
  type GitReplayAttestation,
} from "../infrastructure/git-replay-risk.ts";
import {
  consumeWorkspaceMutationLease,
  workspaceMutationLeaseState,
  type WorkspaceMutationAuthorization,
  type WorkspaceMutationLease,
} from "./mutation-lease.ts";
import type { ResolvedNodeState } from "./resolve.ts";

export interface RestoreDeps {
  readonly store: ObjectStore;
  /** Runtime-scoped validation may reuse a prior attestation for this tree. */
  readonly validateManifestScope: (
    manifest: CurrentTreeManifest,
  ) => Promise<GitReplayAttestation>;
}

export interface RestoreOptions {
  /** Complete observation made under the same cooperative workspace lock. */
  readonly current: WorkspaceSnapshot;
  /** Required one-shot authority consumed immediately before workspace writes. */
  readonly mutationLease: WorkspaceMutationLease<ResolvedNodeState>;
}

export type RestoreOutcome =
  | {
      readonly kind: "restored";
      readonly treeOid: TreeOid;
      readonly report: ApplyReport;
    }
  | {
      readonly kind: "checkpoint-unreadable";
      readonly treeOid: TreeOid;
      readonly cause: unknown;
    }
  | {
      readonly kind: "apply-incomplete";
      readonly treeOid: TreeOid;
      readonly report: ApplyReport;
    }
  | {
      readonly kind: "verify-failed";
      readonly treeOid: TreeOid;
      readonly report: ApplyReport;
      readonly reason: "mismatch";
    }
  | {
      readonly kind: "verify-failed";
      readonly treeOid: TreeOid;
      readonly report: ApplyReport;
      readonly reason: "scan-incomplete";
      readonly problems: readonly ScanProblem[];
    }
  | {
      readonly kind: "scan-incomplete";
      readonly stage: "current-scan";
      readonly problems: readonly ScanProblem[];
    }
  | {
      readonly kind: "failed";
      readonly stage: "current-scan" | "staging" | "apply" | "verification";
      readonly cause: unknown;
    };

interface RestoreAttempt {
  readonly outcome: RestoreOutcome;
  /** Cleanup for every resource owned by pre-mutation restore preparation. */
  readonly preparationCleanup: CleanupSettlement;
}

export type RestoreExecution = RestoreAttempt &
  (
    | {
        readonly cutover: { readonly kind: "not-requested" };
      }
    | {
        readonly cutover: {
          readonly kind: "rejected";
          readonly cause: unknown;
        };
      }
    | {
        readonly cutover: WorkspaceMutationAuthorization<ResolvedNodeState>;
      }
  );

const CLEANUP_SETTLED = { kind: "settled" } as const;

function restoreAttempt(
  outcome: RestoreOutcome,
  preparationCleanup: CleanupSettlement = CLEANUP_SETTLED,
): RestoreAttempt {
  return { outcome, preparationCleanup };
}

function retainPreparationCleanup(
  attempt: RestoreAttempt,
  cleanup: unknown,
): RestoreAttempt {
  const existing = attempt.preparationCleanup;
  return {
    ...attempt,
    preparationCleanup: {
      kind: "failed",
      cause:
        existing.kind === "settled"
          ? cleanup
          : aggregateFailures(
              [existing.cause, cleanup],
              "multiple restore preparation cleanup attempts failed",
            ),
    },
  };
}

async function disposeStaging(staged: StagedBlobs): Promise<CleanupSettlement> {
  try {
    await staged.dispose();
    return CLEANUP_SETTLED;
  } catch (cause) {
    return { kind: "failed", cause };
  }
}

/**
 * Purely apply one recorded target to the workspace. This function never
 * writes node metadata. The node's one state is therefore also the durable
 * retry target after an unreadable, partial, or unverifiable attempt.
 */
async function restoreWorkspaceOutcomeWithReads(
  deps: RestoreDeps,
  reads: ObjectStoreReadScope,
  root: string,
  resolution: ResolvedNodeState,
  options: RestoreOptions,
): Promise<RestoreAttempt> {
  let manifest;
  let scopeValidation: GitReplayAttestation;
  try {
    // Authenticate the manifest first. The plan below identifies blobs whose
    // bytes must be staged; the rest of the closure is authenticated exactly
    // once before apply may consume its mutation lease.
    manifest = await reads.readTreeManifest(resolution.treeOid);
    scopeValidation = await deps.validateManifestScope(manifest);
  } catch (error) {
    return restoreAttempt({
      kind: "checkpoint-unreadable",
      treeOid: resolution.treeOid,
      cause: error,
    });
  }

  const current = options.current;
  if (
    !sameGitOracleVersion(scopeValidation.gitVersion, current.gitOracleVersion)
  ) {
    return restoreAttempt({
      kind: "failed",
      stage: "current-scan",
      cause: new Error(
        "Git evaluator changed after the workspace restore observation",
      ),
    });
  }
  if (current.problems.length > 0) {
    return restoreAttempt({
      kind: "scan-incomplete",
      stage: "current-scan",
      problems: current.problems,
    });
  }
  const operationRoot = current.rootPath;
  let restorePlan: ReturnType<typeof planWorkspaceRestore>;
  try {
    restorePlan = planWorkspaceRestore(current, manifest);
  } catch (error) {
    return restoreAttempt({
      kind: "failed",
      stage: "current-scan",
      cause: error,
    });
  }
  if (restorePlan.problems.length > 0) {
    return restoreAttempt({
      kind: "scan-incomplete",
      stage: "current-scan",
      problems: restorePlan.problems,
    });
  }

  let staged;
  try {
    staged = await stageBlobs(
      restorePlan.requiredBlobOids,
      (oid, sink) => reads.streamBlob(oid, sink),
      {
        workspaceRoot: operationRoot,
        forbiddenRoots: [deps.store.storageRoot],
      },
    );
  } catch (error) {
    const primary =
      error instanceof BlobStagingCleanupError ? error.primary : error;
    const preparationCleanup: CleanupSettlement =
      error instanceof BlobStagingCleanupError
        ? { kind: "failed", cause: error.cleanup }
        : CLEANUP_SETTLED;
    if (primary instanceof BlobStagingError) {
      return restoreAttempt(
        { kind: "failed", stage: "staging", cause: primary },
        preparationCleanup,
      );
    }
    return restoreAttempt(
      {
        kind: "checkpoint-unreadable",
        treeOid: resolution.treeOid,
        cause: primary,
      },
      preparationCleanup,
    );
  }

  try {
    const required = new Set(restorePlan.requiredBlobOids);
    const nonRequired: string[] = [];
    const seen = new Set<string>();
    for (const entry of manifest.entries) {
      if (
        entry.type === "regular" &&
        !required.has(entry.blobOid) &&
        !seen.has(entry.blobOid)
      ) {
        seen.add(entry.blobOid);
        nonRequired.push(entry.blobOid);
      }
    }
    await reads.verifyBlobs(nonRequired);
  } catch (error) {
    const preparationCleanup = await disposeStaging(staged);
    return restoreAttempt(
      {
        kind: "checkpoint-unreadable",
        treeOid: resolution.treeOid,
        cause: error,
      },
      preparationCleanup,
    );
  }

  // No object-store reads remain beyond this point. Release pack handles
  // before workspace mutation; the outer owner records that the
  // close was attempted so a rejection is not awaited and reported twice.
  try {
    await reads.close();
  } catch (error) {
    return restoreAttempt(
      {
        kind: "failed",
        stage: "staging",
        cause: error,
      },
      await disposeStaging(staged),
    );
  }

  let report: ApplyReport;
  try {
    report = await applyTreeToWorkspace(
      root,
      manifest,
      staged.streamBlob,
      current,
      () => consumeWorkspaceMutationLease(options.mutationLease),
    );
  } catch (error) {
    const preparationCleanup = await disposeStaging(staged);
    return restoreAttempt(
      { kind: "failed", stage: "apply", cause: error },
      preparationCleanup,
    );
  }
  const preparationCleanup = await disposeStaging(staged);

  let actual: WorkspaceSnapshot;
  try {
    actual = await scanWorkspaceForRestoreComparison(
      operationRoot,
      manifest.scope,
      { gitIgnoreScratchParent: deps.store.storageRoot },
    );
  } catch (error) {
    return restoreAttempt(
      { kind: "failed", stage: "verification", cause: error },
      preparationCleanup,
    );
  }
  if (actual.problems.length > 0) {
    return restoreAttempt(
      {
        kind: "verify-failed",
        reason: "scan-incomplete",
        treeOid: resolution.treeOid,
        report,
        problems: actual.problems,
      },
      preparationCleanup,
    );
  }

  const verification = planWorkspaceRestore(actual, manifest);
  if (report.problems.length > 0) {
    return restoreAttempt(
      { kind: "apply-incomplete", treeOid: resolution.treeOid, report },
      preparationCleanup,
    );
  }
  if (verification.problems.length > 0 || restorePlanHasChanges(verification)) {
    return restoreAttempt(
      {
        kind: "verify-failed",
        reason: "mismatch",
        treeOid: resolution.treeOid,
        report,
      },
      preparationCleanup,
    );
  }
  return restoreAttempt(
    { kind: "restored", treeOid: resolution.treeOid, report },
    preparationCleanup,
  );
}

async function restoreWorkspaceOutcome(
  deps: RestoreDeps,
  root: string,
  resolution: ResolvedNodeState,
  options: RestoreOptions,
): Promise<RestoreAttempt> {
  const ownedReads = openObjectStoreReadScope(deps.store);
  let closeAttempted = false;
  const reads = Object.freeze({
    ...ownedReads,
    close: (): Promise<void> => {
      closeAttempted = true;
      return ownedReads.close();
    },
  });
  let result:
    | { readonly kind: "completed"; readonly attempt: RestoreAttempt }
    | { readonly kind: "failed"; readonly cause: unknown };
  try {
    result = {
      kind: "completed",
      attempt: await restoreWorkspaceOutcomeWithReads(
        deps,
        reads,
        root,
        resolution,
        options,
      ),
    };
  } catch (cause) {
    result = { kind: "failed", cause };
  }

  let readCleanup: CleanupSettlement = CLEANUP_SETTLED;
  if (!closeAttempted) {
    try {
      await ownedReads.close();
    } catch (cause) {
      readCleanup = { kind: "failed", cause };
    }
  }

  if (result.kind === "failed") {
    if (readCleanup.kind === "failed") {
      throw retainFailureCause(
        result.cause,
        readCleanup.cause,
        "workspace restore and object-read cleanup both failed",
      );
    }
    throw result.cause;
  }
  if (readCleanup.kind === "failed") {
    return retainPreparationCleanup(result.attempt, readCleanup.cause);
  }
  return result.attempt;
}

/**
 * Restore one checkpoint and report the exact first-write cutover fact.
 * Callers must never infer destructive progress from an outcome kind: a
 * no-op restore is successful without consuming its lease, while a rejected
 * cutover may have installed durable checkpoint protection before refusing
 * every filesystem mutation.
 */
export async function restoreWorkspace(
  deps: RestoreDeps,
  root: string,
  resolution: ResolvedNodeState,
  options: RestoreOptions,
): Promise<RestoreExecution> {
  const attempt = await restoreWorkspaceOutcome(
    deps,
    root,
    resolution,
    options,
  );
  const cutover = workspaceMutationLeaseState(options.mutationLease);
  switch (cutover.kind) {
    case "pending":
      return { cutover: { kind: "not-requested" }, ...attempt };
    case "rejected":
      return { cutover, ...attempt };
    case "authorized":
      return { cutover: cutover.authorization, ...attempt };
  }
}
