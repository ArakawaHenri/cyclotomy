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
import type { ObjectStore } from "../infrastructure/object-store.ts";
import type { CurrentTreeManifest } from "../infrastructure/tree-formats/current.ts";
import { upgradeTreeManifestToCurrent } from "../infrastructure/tree-formats/history.ts";
import {
  DEFAULT_MAX_WORKSPACE_RELATIVE_PATH_BYTES,
  DEFAULT_MAX_WORKSPACE_RELATIVE_PATH_COMPONENTS,
} from "../infrastructure/workspace-scope.ts";
import {
  planWorkspaceRestore,
  restorePlanHasChanges,
} from "../infrastructure/restore-plan.ts";
import {
  scanWorkspaceForScope,
  type ScanOptions,
  type ScanProblem,
  type WorkspaceSnapshot,
} from "../infrastructure/workspace-scan.ts";
import type { TreeOid } from "../domain/model.ts";
import {
  consumeWorkspaceMutationLease,
  workspaceMutationLeaseState,
  type WorkspaceMutationAuthorization,
  type WorkspaceMutationLease,
} from "./mutation-lease.ts";
import type { ResolvedNodeState } from "./resolve.ts";

export interface RestoreDeps {
  readonly store: ObjectStore;
  readonly scanOptions?: ScanOptions;
  /** Runtime-scoped validation may reuse a prior attestation for this tree. */
  readonly validateManifestScope: (
    treeOid: TreeOid,
    manifest: CurrentTreeManifest,
  ) => Promise<void>;
  /** Test/embedding seam; production uses the native private staging protocol. */
  readonly stageBlobs?: typeof stageBlobs;
}

export interface RestoreOptions {
  /** Complete observation made under the same cooperative workspace lock. */
  readonly current: WorkspaceSnapshot;
  /** Required one-shot authority consumed immediately before workspace writes. */
  readonly mutationLease: WorkspaceMutationLease<ResolvedNodeState>;
}

function effectiveScanOptions(deps: RestoreDeps): ScanOptions {
  return {
    ...deps.scanOptions,
    gitIgnoreScratchParent:
      deps.scanOptions?.gitIgnoreScratchParent ?? deps.store.storageRoot,
  };
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

export type CleanupSettlement =
  | { readonly kind: "settled" }
  | { readonly kind: "failed"; readonly cause: unknown };

interface RestoreAttempt {
  readonly outcome: RestoreOutcome;
  readonly stagingCleanup: CleanupSettlement;
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
  stagingCleanup: CleanupSettlement = CLEANUP_SETTLED,
): RestoreAttempt {
  return { outcome, stagingCleanup };
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
async function restoreWorkspaceOutcome(
  deps: RestoreDeps,
  root: string,
  resolution: ResolvedNodeState,
  options: RestoreOptions,
): Promise<RestoreAttempt> {
  let manifest;
  try {
    // Authenticate the manifest first. The plan below identifies blobs whose
    // bytes must be staged; the rest of the closure is authenticated exactly
    // once before apply may consume its mutation lease.
    manifest = upgradeTreeManifestToCurrent(
      await deps.store.readTreeManifest(resolution.treeOid),
      {
        maxPathBytes:
          deps.scanOptions?.maxPathBytes ??
          DEFAULT_MAX_WORKSPACE_RELATIVE_PATH_BYTES,
        maxPathComponents:
          deps.scanOptions?.maxPathComponents ??
          DEFAULT_MAX_WORKSPACE_RELATIVE_PATH_COMPONENTS,
      },
    );
    await deps.validateManifestScope(resolution.treeOid, manifest);
  } catch (error) {
    return restoreAttempt({
      kind: "checkpoint-unreadable",
      treeOid: resolution.treeOid,
      cause: error,
    });
  }

  const current = options.current;
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
    staged = await (deps.stageBlobs ?? stageBlobs)(
      restorePlan.requiredBlobOids,
      (oid) => deps.store.readBlob(oid),
      {
        workspaceRoot: operationRoot,
        forbiddenRoots: [deps.store.storageRoot],
      },
    );
  } catch (error) {
    const primary =
      error instanceof BlobStagingCleanupError ? error.primary : error;
    const stagingCleanup: CleanupSettlement =
      error instanceof BlobStagingCleanupError
        ? { kind: "failed", cause: error.cleanup }
        : CLEANUP_SETTLED;
    if (primary instanceof BlobStagingError) {
      return restoreAttempt(
        { kind: "failed", stage: "staging", cause: primary },
        stagingCleanup,
      );
    }
    return restoreAttempt(
      {
        kind: "checkpoint-unreadable",
        treeOid: resolution.treeOid,
        cause: primary,
      },
      stagingCleanup,
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
    await deps.store.verifyBlobs(nonRequired);
  } catch (error) {
    const stagingCleanup = await disposeStaging(staged);
    return restoreAttempt(
      {
        kind: "checkpoint-unreadable",
        treeOid: resolution.treeOid,
        cause: error,
      },
      stagingCleanup,
    );
  }

  let report: ApplyReport;
  try {
    report = await applyTreeToWorkspace(
      root,
      manifest,
      (oid) => staged.readBlob(oid),
      current,
      () => {
        consumeWorkspaceMutationLease(options.mutationLease);
        return undefined;
      },
    );
  } catch (error) {
    const stagingCleanup = await disposeStaging(staged);
    return restoreAttempt(
      { kind: "failed", stage: "apply", cause: error },
      stagingCleanup,
    );
  }
  const stagingCleanup = await disposeStaging(staged);

  let actual: WorkspaceSnapshot;
  try {
    actual = await scanWorkspaceForScope(
      operationRoot,
      manifest.scope,
      effectiveScanOptions(deps),
    );
  } catch (error) {
    return restoreAttempt(
      { kind: "failed", stage: "verification", cause: error },
      stagingCleanup,
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
      stagingCleanup,
    );
  }

  const verification = planWorkspaceRestore(actual, manifest);
  if (report.problems.length > 0) {
    return restoreAttempt(
      { kind: "apply-incomplete", treeOid: resolution.treeOid, report },
      stagingCleanup,
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
      stagingCleanup,
    );
  }
  return restoreAttempt(
    { kind: "restored", treeOid: resolution.treeOid, report },
    stagingCleanup,
  );
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
