import type { MetadataStore } from "../infrastructure/metadata.ts";
import type { ObjectStore } from "../infrastructure/object-store.ts";
import { publishSnapshot } from "../infrastructure/snapshot-publication.ts";
import {
  scanWorkspace,
  summarizeScanProblems,
  workspaceSnapshotsEqual,
  type ScanProblem,
  type ScanOptions,
  type WorkspaceSnapshot,
} from "../infrastructure/workspace-scan.ts";
import {
  failure,
  success,
  type NodeKey,
  type Result,
  type TreeOid,
} from "../domain/model.ts";

export interface CaptureDeps {
  readonly store: ObjectStore;
  readonly metadata: MetadataStore;
  readonly scanOptions?: ScanOptions;
  /** Canonical workspace identity selected before this operation. */
  readonly expectedRootPath?: string;
}

export type CaptureErrorKind =
  | "scan-failed"
  | "scan-incomplete"
  | "publish-failed"
  | "metadata-failed"
  | "state-changed"
  | "workspace-changed";

export type CaptureError =
  | {
      readonly kind: "scan-incomplete";
      readonly message: string;
      readonly problems: readonly ScanProblem[];
    }
  | {
      readonly kind: Exclude<CaptureErrorKind, "scan-incomplete">;
      readonly message: string;
    };

export interface CaptureSuccess {
  readonly treeOid: TreeOid;
  /** Complete observation that was published; reusable within the same lock. */
  readonly snapshot: WorkspaceSnapshot;
}

function effectiveScanOptions(deps: CaptureDeps): ScanOptions {
  return {
    ...deps.scanOptions,
    gitIgnoreScratchParent:
      deps.scanOptions?.gitIgnoreScratchParent ?? deps.store.storageRoot,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Publish a complete current-policy observation without moving any node
 * pointer. Snapshots scanned through an older restore target's scope are not
 * capture candidates: the final current-policy scan will reject their scope.
 */
export async function prepareObservedNodeState(
  deps: CaptureDeps,
  snapshot: WorkspaceSnapshot,
): Promise<Result<CaptureSuccess, CaptureError>> {
  if (
    deps.expectedRootPath !== undefined &&
    snapshot.rootPath !== deps.expectedRootPath
  ) {
    return failure({
      kind: "scan-failed",
      message: "workspace root changed after the checkpoint store was selected",
    });
  }
  if (snapshot.problems.length > 0) {
    return failure({
      kind: "scan-incomplete",
      message: `workspace scan is incomplete; checkpoint was not published: ${summarizeScanProblems(
        snapshot.problems,
      )}`,
      problems: snapshot.problems,
    });
  }

  let treeOid: TreeOid;
  try {
    treeOid = await publishSnapshot(deps.store, snapshot);
  } catch (error) {
    return failure({
      kind: "publish-failed",
      message: messageOf(error),
    });
  }

  let validated: WorkspaceSnapshot;
  try {
    // Re-discover both Git policy sources and core.ignoreCase. Reusing the
    // observed scope here would miss a policy-only change outside managed file
    // content and could commit an already-stale namespace boundary.
    validated = await scanWorkspace(
      snapshot.rootPath,
      effectiveScanOptions(deps),
    );
  } catch (error) {
    return failure({
      kind: "scan-failed",
      message: `final workspace validation failed: ${messageOf(error)}`,
    });
  }
  if (validated.problems.length > 0) {
    return failure({
      kind: "scan-incomplete",
      message: `final workspace validation is incomplete; checkpoint was not committed: ${summarizeScanProblems(
        validated.problems,
      )}`,
      problems: validated.problems,
    });
  }
  if (!workspaceSnapshotsEqual(snapshot, validated)) {
    return failure({
      kind: "workspace-changed",
      message:
        "workspace changed between capture scan and final validation; checkpoint was not committed",
    });
  }

  return success({ treeOid, snapshot: validated });
}

/**
 * Move one node's sole pointer to an already published tree. Callers may also
 * require the exact pointer observed at prepare time so a concurrent capture
 * cannot be overwritten.
 */
export async function commitPreparedNodeState(
  deps: CaptureDeps,
  node: NodeKey,
  prepared: CaptureSuccess,
  expected?: { readonly treeOid: TreeOid | undefined },
): Promise<Result<CaptureSuccess, CaptureError>> {
  try {
    const existing = deps.metadata.getState(node.sessionId, node.entryId);
    if (expected !== undefined && existing?.treeOid !== expected.treeOid) {
      return failure({
        kind: "state-changed",
        message: "node checkpoint changed after capture preparation",
      });
    }
    if (existing?.treeOid !== prepared.treeOid) {
      deps.metadata.setState(node.sessionId, node.entryId, prepared.treeOid);
    }
  } catch (error) {
    return failure({
      kind: "metadata-failed",
      message: messageOf(error),
    });
  }
  return success(prepared);
}

/**
 * Publish and record a current-policy observation already made under the
 * lock. A target-scope restore observation is deliberately rejected by final
 * validation rather than silently becoming a capture policy.
 */
export async function recordObservedNodeState(
  deps: CaptureDeps,
  node: NodeKey,
  snapshot: WorkspaceSnapshot,
): Promise<Result<CaptureSuccess, CaptureError>> {
  const prepared = await prepareObservedNodeState(deps, snapshot);
  return prepared.ok
    ? await commitPreparedNodeState(deps, node, prepared.value)
    : prepared;
}

/** Scan and publish a candidate without changing node metadata. */
export async function prepareNodeState(
  deps: CaptureDeps,
  root: string,
): Promise<Result<CaptureSuccess, CaptureError>> {
  let snapshot;
  try {
    snapshot = await scanWorkspace(root, effectiveScanOptions(deps));
  } catch (error) {
    return failure({
      kind: "scan-failed",
      message: messageOf(error),
    });
  }
  return prepareObservedNodeState(deps, snapshot);
}

/**
 * Scan the workspace, publish the snapshot, and record it as the reality
 * observed at `node`. Capture is the only operation that writes node states;
 * restore deliberately leaves the target pointer untouched.
 */
export async function captureNodeState(
  deps: CaptureDeps,
  root: string,
  node: NodeKey,
): Promise<Result<CaptureSuccess, CaptureError>> {
  const prepared = await prepareNodeState(deps, root);
  return prepared.ok
    ? await commitPreparedNodeState(deps, node, prepared.value)
    : prepared;
}
