import {
  applyTreeToWorkspace,
  type ApplyReport,
} from "../infrastructure/apply.ts";
import {
  BlobStagingError,
  stageBlobs,
} from "../infrastructure/blob-staging.ts";
import type { ObjectStore } from "../infrastructure/object-store.ts";
import { validateTreeEntriesAgainstScope } from "../infrastructure/tree-scope-validation.ts";
import type { TreeManifest } from "../infrastructure/tree-manifest.ts";
import {
  planWorkspaceRestore,
  restorePlanHasChanges,
} from "../infrastructure/restore-plan.ts";
import {
  scanWorkspaceForScope,
  summarizeScanProblems,
  type ScanOptions,
  type ScanProblem,
  type WorkspaceSnapshot,
} from "../infrastructure/workspace-scan.ts";
import type { TreeOid } from "../domain/model.ts";
import type { ResolvedNodeState } from "./resolve.ts";

export interface RestoreDeps {
  readonly store: ObjectStore;
  readonly scanOptions?: ScanOptions;
  /** Test/embedding override for operation-local restore scratch space. */
  readonly stagingParent?: string;
  /** Runtime-scoped validation may reuse a prior attestation for this tree. */
  readonly validateManifestScope?: (
    treeOid: TreeOid,
    manifest: TreeManifest,
  ) => Promise<void>;
}

export interface RestoreOptions {
  /** Complete observation made under the same cooperative workspace lock. */
  readonly current: WorkspaceSnapshot;
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
      readonly message: string;
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
      readonly message: string;
      readonly scanProblems: readonly ScanProblem[];
    }
  | {
      readonly kind: "failed";
      readonly stage: "current-scan" | "staging" | "apply" | "verification";
      readonly message: string;
      readonly scanProblems?: readonly ScanProblem[];
    };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Purely apply one recorded target to the workspace. This function never
 * writes node metadata. The node's one state is therefore also the durable
 * retry target after an unreadable, partial, or unverifiable attempt.
 */
export async function restoreWorkspace(
  deps: RestoreDeps,
  root: string,
  resolution: ResolvedNodeState,
  options: RestoreOptions,
): Promise<RestoreOutcome> {
  let manifest;
  try {
    // A clean diff is meaningful only when the entire durable checkpoint is
    // readable. Authenticate every referenced blob before planning or staging
    // so "restored" never blesses a tree with a damaged unused member.
    manifest = await deps.store.readTree(resolution.treeOid);
    await (deps.validateManifestScope === undefined
      ? validateTreeEntriesAgainstScope(manifest, {
          scratchParent: deps.store.storageRoot,
          forbiddenRoots: [options.current.rootPath],
        })
      : deps.validateManifestScope(resolution.treeOid, manifest));
  } catch (error) {
    return {
      kind: "checkpoint-unreadable",
      treeOid: resolution.treeOid,
      message: messageOf(error),
    };
  }

  const current = options.current;
  if (current.problems.length > 0) {
    return {
      kind: "failed",
      stage: "current-scan",
      message: `current workspace scan is incomplete: ${summarizeScanProblems(
        current.problems,
      )}`,
      scanProblems: current.problems,
    };
  }
  const operationRoot = current.rootPath;
  const restorePlan = planWorkspaceRestore(current, manifest);
  if (restorePlan.problems.length > 0) {
    return {
      kind: "failed",
      stage: "current-scan",
      message: `current workspace scan is incomplete: ${summarizeScanProblems(
        restorePlan.problems,
      )}`,
      scanProblems: restorePlan.problems,
    };
  }

  let staged;
  try {
    staged = await stageBlobs(
      restorePlan.requiredBlobOids,
      (oid) => deps.store.readBlob(oid),
      {
        workspaceRoot: operationRoot,
        forbiddenRoots: [deps.store.storageRoot],
        ...(deps.stagingParent === undefined
          ? {}
          : { stagingParent: deps.stagingParent }),
      },
    );
  } catch (error) {
    if (error instanceof BlobStagingError) {
      return {
        kind: "failed",
        stage: "staging",
        message: messageOf(error),
      };
    }
    return {
      kind: "checkpoint-unreadable",
      treeOid: resolution.treeOid,
      message: messageOf(error),
    };
  }

  let report: ApplyReport;
  try {
    report = await applyTreeToWorkspace(
      root,
      manifest,
      (oid) => staged.readBlob(oid),
      current,
    );
  } catch (error) {
    return {
      kind: "failed",
      stage: "apply",
      message: messageOf(error),
    };
  } finally {
    await staged.dispose().catch(() => {});
  }

  let actual: WorkspaceSnapshot;
  try {
    actual = await scanWorkspaceForScope(
      operationRoot,
      manifest.scope,
      effectiveScanOptions(deps),
    );
  } catch (error) {
    return {
      kind: "failed",
      stage: "verification",
      message: messageOf(error),
    };
  }
  if (actual.problems.length > 0) {
    return {
      kind: "verify-failed",
      reason: "scan-incomplete",
      treeOid: resolution.treeOid,
      report,
      message: summarizeScanProblems(actual.problems),
      scanProblems: actual.problems,
    };
  }

  const verification = planWorkspaceRestore(actual, manifest);
  if (report.problems.length > 0) {
    return {
      kind: "apply-incomplete",
      treeOid: resolution.treeOid,
      report,
    };
  }
  if (verification.problems.length > 0 || restorePlanHasChanges(verification)) {
    return {
      kind: "verify-failed",
      reason: "mismatch",
      treeOid: resolution.treeOid,
      report,
    };
  }
  return {
    kind: "restored",
    treeOid: resolution.treeOid,
    report,
  };
}
