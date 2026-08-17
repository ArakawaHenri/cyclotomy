import type { CheckpointSlot } from "../domain/checkpoint-slot.ts";
import type { CurrentMetadataStore } from "../infrastructure/metadata.ts";
import type { ObjectStore } from "../infrastructure/object-store.ts";
import type { WorkspaceWriteAuthority } from "../infrastructure/workspace-lock.ts";
import { publishSnapshot } from "../infrastructure/snapshot-publication.ts";
import {
  scanWorkspace,
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
  readonly scanOptions?: ScanOptions;
  /** Canonical workspace identity selected before this operation. */
  readonly expectedRootPath: string;
}

/** Authority required only at the synchronous metadata commit boundary. */
export interface CaptureCommitDeps extends CaptureDeps {
  readonly metadata: Pick<
    CurrentMetadataStore,
    "adoptBlockedMissing" | "commitCapture"
  >;
  readonly writeAuthority: WorkspaceWriteAuthority;
  /** Persisted file that must own the verified session coordinate. */
  readonly expectedSessionFile: string;
  /** Final synchronous workspace identity and lock-ownership gate. */
  readonly assertWorkspaceAuthority: () => undefined;
}

export type CaptureFailure =
  | {
      readonly kind: "scan-incomplete";
      readonly phase: "capture" | "validation";
      readonly problems: readonly ScanProblem[];
    }
  | {
      readonly kind: "scan-failed";
      readonly phase: "capture" | "validation";
      readonly cause: unknown;
    }
  | { readonly kind: "publish-failed"; readonly cause: unknown }
  | { readonly kind: "metadata-failed"; readonly cause: unknown }
  | {
      readonly kind: "state-changed";
      readonly reason: "checkpoint" | "eligibility";
    }
  | { readonly kind: "write-protected" }
  | {
      readonly kind: "workspace-changed";
      readonly reason: "root" | "contents";
    };

export interface CaptureSuccess {
  readonly treeOid: TreeOid;
  /** Complete observation that was published; reusable within the same lock. */
  readonly snapshot: WorkspaceSnapshot;
}

/**
 * The trusted structural coordinate at the final metadata cutover. Metadata
 * receives the complete root-to-current ancestry so a durable session barrier
 * can be reconciled in the same transaction as the capture.
 */
export interface CaptureCommitAuthority {
  readonly activeAncestryEntryIds: readonly string[];
  readonly expectedSlot: CheckpointSlot;
}

export type MissingNodeStateIntent = "initialize-fresh" | "adopt-protected";

function effectiveScanOptions(deps: CaptureDeps): ScanOptions {
  return {
    ...deps.scanOptions,
    gitIgnoreScratchParent:
      deps.scanOptions?.gitIgnoreScratchParent ?? deps.store.storageRoot,
  };
}

/**
 * Publish a complete current-policy observation without moving any node
 * pointer. Snapshots scanned through an older restore target's scope are not
 * capture candidates: the final current-policy scan will reject their scope.
 */
export async function prepareObservedNodeState(
  deps: CaptureDeps,
  snapshot: WorkspaceSnapshot,
): Promise<Result<CaptureSuccess, CaptureFailure>> {
  if (snapshot.rootPath !== deps.expectedRootPath) {
    return failure({
      kind: "workspace-changed",
      reason: "root",
    });
  }
  if (snapshot.problems.length > 0) {
    return failure({
      kind: "scan-incomplete",
      phase: "capture",
      problems: snapshot.problems,
    });
  }

  let treeOid: TreeOid;
  try {
    treeOid = await publishSnapshot(deps.store, snapshot);
  } catch (error) {
    return failure({
      kind: "publish-failed",
      cause: error,
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
      phase: "validation",
      cause: error,
    });
  }
  if (validated.problems.length > 0) {
    return failure({
      kind: "scan-incomplete",
      phase: "validation",
      problems: validated.problems,
    });
  }
  if (!workspaceSnapshotsEqual(snapshot, validated)) {
    return failure({
      kind: "workspace-changed",
      reason: "contents",
    });
  }

  return success({ treeOid, snapshot: validated });
}

/**
 * Move one node's sole pointer to an already published tree. Callers may also
 * require the exact pointer observed at prepare time so a concurrent capture
 * cannot be overwritten.
 */
export function commitPreparedNodeState(
  deps: CaptureCommitDeps,
  node: NodeKey,
  prepared: CaptureSuccess,
  authority: CaptureCommitAuthority,
): Result<CaptureSuccess, CaptureFailure> {
  try {
    if (deps.assertWorkspaceAuthority() !== undefined) {
      throw new Error("workspace authority check must complete synchronously");
    }
    const committed = deps.metadata.commitCapture(deps.writeAuthority, {
      identity: {
        sessionId: node.sessionId,
        sessionFile: deps.expectedSessionFile,
      },
      entryId: node.entryId,
      activeAncestryEntryIds: authority.activeAncestryEntryIds,
      treeOid: prepared.treeOid,
      expectedSlot: authority.expectedSlot,
    });
    if (committed === "slot-changed") {
      return failure({
        kind: "state-changed",
        reason: "checkpoint",
      });
    }
    if (committed === "blocked") {
      return failure({
        kind: "write-protected",
      });
    }
  } catch (error) {
    return failure({
      kind: "metadata-failed",
      cause: error,
    });
  }
  return success(prepared);
}

/** Atomically materialize a node that has no effective historical checkpoint. */
export function commitPreparedMissingNodeState(
  deps: CaptureCommitDeps,
  node: NodeKey,
  prepared: CaptureSuccess,
  intent: MissingNodeStateIntent,
  authority: Pick<CaptureCommitAuthority, "activeAncestryEntryIds">,
): Result<CaptureSuccess, CaptureFailure> {
  try {
    if (deps.assertWorkspaceAuthority() !== undefined) {
      throw new Error("workspace authority check must complete synchronously");
    }
    const identity = {
      sessionId: node.sessionId,
      sessionFile: deps.expectedSessionFile,
    };
    const committed =
      intent === "adopt-protected"
        ? deps.metadata.adoptBlockedMissing(deps.writeAuthority, {
            identity,
            entryId: node.entryId,
            treeOid: prepared.treeOid,
          })
        : deps.metadata.commitCapture(deps.writeAuthority, {
            identity,
            entryId: node.entryId,
            activeAncestryEntryIds: authority.activeAncestryEntryIds,
            treeOid: prepared.treeOid,
            expectedSlot: { kind: "open-missing" },
          });
    if (
      committed === "slot-changed" ||
      (intent === "initialize-fresh" && committed === "blocked")
    ) {
      return failure({
        kind: "state-changed",
        reason: "eligibility",
      });
    }
  } catch (error) {
    return failure({ kind: "metadata-failed", cause: error });
  }
  return success(prepared);
}

/** Scan and publish a candidate without changing node metadata. */
export async function prepareNodeState(
  deps: CaptureDeps,
  root: string,
): Promise<Result<CaptureSuccess, CaptureFailure>> {
  let snapshot;
  try {
    snapshot = await scanWorkspace(root, effectiveScanOptions(deps));
  } catch (error) {
    return failure({
      kind: "scan-failed",
      phase: "capture",
      cause: error,
    });
  }
  return prepareObservedNodeState(deps, snapshot);
}
