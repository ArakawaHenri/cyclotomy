import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { NodeKey } from "../domain/model.ts";
import { checkpointSlotTreeOid } from "../domain/checkpoint-slot.ts";
import type { WorkspaceWriteAuthority } from "../infrastructure/workspace-lock.ts";
import {
  planWorkspaceRestore,
  restorePlanHasChanges,
  workspaceSnapshotAsManifest,
} from "../infrastructure/restore-plan.ts";
import { sameGitOracleVersion } from "../infrastructure/git-replay-risk.ts";
import type { WorkspaceSnapshot } from "../infrastructure/workspace-scan.ts";
import { checkpointInitializationDispositionConflict } from "./post-mutation.ts";
import { settleCheckpointInitialization } from "./checkpoint-initialization-protocol.ts";
import type { ArrivalAttempt } from "./checkpoint-admission.ts";
import type { PendingNavigation } from "./navigation-plan.ts";
import {
  revalidateNavigationLocation,
  sameNavigationNode,
} from "./navigation-authentication.ts";
import type { CyclotomyRuntime } from "./runtime.ts";
import type {
  AuthenticatedTreeArrival,
  SessionView,
  SessionViewTracker,
} from "./session-view.ts";
import {
  lockedTreeArrivalOutcome,
  type LockedTreeArrivalOutcome,
  type TreeArrivalExecution,
} from "./tree-arrival-outcome.ts";
import type { WorkspaceMutationProtocol } from "./workspace-mutation-protocol.ts";
import { assertNever } from "./assert-never.ts";

/** Immutable host facts authenticated before entering the arrival lock. */
interface TreeArrivalRequest {
  readonly arrival: ArrivalAttempt<PendingNavigation | undefined>;
  readonly expectedView: SessionView;
  readonly authenticatedArrival: AuthenticatedTreeArrival;
  readonly actualAnchor: NodeKey | undefined;
}

/**
 * Execute one authenticated tree arrival while the workspace lock is held.
 * This owns every target revalidation and mutation, but never manufactures a
 * workspace-lock cleanup fact or presents the result.
 */
export async function executeTreeArrivalInWorkspaceLock(
  runtime: CyclotomyRuntime,
  views: SessionViewTracker,
  context: ExtensionContext,
  mutationProtocol: WorkspaceMutationProtocol,
  writeAuthority: WorkspaceWriteAuthority,
  request: TreeArrivalRequest,
): Promise<TreeArrivalExecution | LockedTreeArrivalOutcome> {
  const { arrival, expectedView, authenticatedArrival, actualAnchor } = request;
  const plan = arrival.plan;
  if (plan === undefined) {
    throw new Error("tree-arrival protocol requires a planned arrival");
  }

  if (!(await runtime.registrations.workspaceStillBound(expectedView.cwd))) {
    return { kind: "location-changed" };
  }
  const arrivalView = revalidateNavigationLocation(
    runtime,
    views,
    context,
    expectedView,
  );
  if (arrivalView === undefined) {
    return { kind: "location-changed" };
  }
  if (
    !runtime.admission.arrivalCanProceed(
      arrival,
      arrivalView,
      runtime.checkpoints.captureAnchor(arrivalView),
    )
  ) {
    return { kind: "target-changed" };
  }
  if (!context.isIdle()) return { kind: "busy" };

  switch (plan.target.kind) {
    case "protected-missing": {
      const disposition = runtime.workspaceMutations.protectCurrentTreeArrival(
        writeAuthority,
        arrival,
        arrivalView,
      );
      return disposition.kind === "protected" &&
        runtime.checkpoints.locationIsBlocked(plan.target.node)
        ? lockedTreeArrivalOutcome({ kind: "protected" }, disposition)
        : lockedTreeArrivalOutcome({ kind: "target-changed" }, disposition);
    }
    case "detach": {
      const authenticatedAnchor =
        runtime.checkpoints.captureAnchor(arrivalView);
      if (
        actualAnchor === undefined ||
        authenticatedAnchor === undefined ||
        !sameNavigationNode(authenticatedAnchor, actualAnchor)
      ) {
        return { kind: "target-changed" };
      }
      const readable = await runtime.resolveReadableTreeIn(
        arrivalView,
        authenticatedAnchor,
      );
      if (
        readable === undefined ||
        readable.resolution.treeOid !== plan.target.resolution.treeOid ||
        !sameNavigationNode(
          readable.resolution.foundAt,
          plan.target.resolution.foundAt,
        )
      ) {
        return { kind: "target-changed" };
      }
      if (
        !(await runtime.registrations.workspaceStillBound(expectedView.cwd))
      ) {
        return { kind: "location-changed" };
      }
      const current = revalidateNavigationLocation(
        runtime,
        views,
        context,
        expectedView,
      );
      if (current === undefined) {
        return { kind: "location-changed" };
      }
      if (!context.isIdle()) return { kind: "busy" };
      const currentAnchor = runtime.checkpoints.captureAnchor(current);
      if (!sameNavigationNode(currentAnchor, actualAnchor)) {
        return { kind: "location-changed" };
      }
      if (
        currentAnchor === undefined ||
        !runtime.workspaceMutations.resolutionStillAuthoritative(
          current,
          currentAnchor,
          readable.resolution,
        )
      ) {
        return { kind: "target-changed" };
      }
      const disposition =
        runtime.workspaceMutations.protectTreeArrivalIfResolution(
          writeAuthority,
          arrival,
          current,
          readable.resolution,
        );
      if (disposition.kind !== "protected") {
        return lockedTreeArrivalOutcome(
          { kind: "target-changed" },
          disposition,
        );
      }
      if (
        checkpointSlotTreeOid(
          runtime.checkpoints.checkpointSlot(currentAnchor),
        ) !== readable.resolution.treeOid ||
        !runtime.checkpoints.locationIsBlocked(currentAnchor)
      ) {
        return { kind: "target-changed" };
      }
      return lockedTreeArrivalOutcome({ kind: "detached" }, disposition);
    }
    case "no-node":
    case "materialize-missing":
    case "same-location":
    case "inherit-source":
    case "restore":
      break;
    default:
      return assertNever(plan.target, "unhandled tree-arrival target");
  }

  const authenticatedRootSummary =
    plan.target.kind === "no-node" &&
    plan.expectedDestinationId === null &&
    authenticatedArrival.kind === "summary" &&
    authenticatedArrival.summaryParentLandingId === null
      ? {
          sessionId: plan.sessionId,
          entryId: authenticatedArrival.summaryEntryId,
        }
      : undefined;
  const sameLocationSummary =
    plan.target.kind === "same-location" &&
    actualAnchor !== undefined &&
    runtime.checkpoints
      .ancestryEntryIds(arrivalView, actualAnchor.entryId)
      .includes(plan.target.node.entryId)
      ? actualAnchor
      : undefined;
  const missingTarget =
    plan.target.kind === "materialize-missing"
      ? plan.target.node
      : (authenticatedRootSummary ?? sameLocationSummary);

  if (plan.target.kind === "no-node" && missingTarget === undefined) {
    const disposition = runtime.workspaceMutations.admitCurrentTreeArrival(
      writeAuthority,
      arrival,
      arrivalView,
    );
    return disposition.kind === "admitted"
      ? lockedTreeArrivalOutcome({ kind: "no-node" }, disposition)
      : lockedTreeArrivalOutcome({ kind: "target-changed" }, disposition);
  }

  if (missingTarget !== undefined) {
    // A normal missing destination was authenticated in before_tree. The sole
    // late-bound exception is Pi's explicit summary entry for a null logical
    // destination; a wrapping label never owns state.
    const targetNode = missingTarget;
    if (runtime.checkpoints.locationIsBlocked(targetNode)) {
      const disposition = runtime.workspaceMutations.protectCurrentTreeArrival(
        writeAuthority,
        arrival,
        arrivalView,
      );
      return disposition.kind === "protected"
        ? lockedTreeArrivalOutcome({ kind: "protected" }, disposition)
        : lockedTreeArrivalOutcome({ kind: "target-changed" }, disposition);
    }
    if (
      sameLocationSummary === undefined &&
      !runtime.workspaceMutations.locationIsUnresolved(arrivalView, targetNode)
    ) {
      return { kind: "target-changed" };
    }

    let targetCurrent: WorkspaceSnapshot;
    try {
      // This is deliberately a fresh current-policy observation. Host work
      // between before_tree and session_tree belongs to the newly arrived,
      // previously unknown location.
      targetCurrent = await runtime.scanCurrentWorkspace(expectedView.cwd);
    } catch (error) {
      return { kind: "scan-failed", cause: error };
    }
    if (targetCurrent.problems.length > 0) {
      return { kind: "scan-incomplete", problems: targetCurrent.problems };
    }
    const preparedTarget =
      await runtime.checkpoints.prepareObserved(targetCurrent);
    if (!preparedTarget.ok) {
      return { kind: "capture-failed", failure: preparedTarget.error };
    }
    if (!(await runtime.registrations.workspaceStillBound(expectedView.cwd))) {
      return { kind: "location-changed" };
    }
    const current = revalidateNavigationLocation(
      runtime,
      views,
      context,
      expectedView,
    );
    if (current === undefined) {
      return { kind: "location-changed" };
    }
    if (
      runtime.checkpoints.locationIsBlocked(targetNode) ||
      (sameLocationSummary === undefined &&
        !runtime.workspaceMutations.locationIsUnresolved(current, targetNode))
    ) {
      return { kind: "target-changed" };
    }
    if (!context.isIdle()) return { kind: "busy" };
    const committedTarget = runtime.commitTreeArrivalCapture(
      writeAuthority,
      arrival,
      current,
      targetNode,
      preparedTarget.value,
      runtime.checkpoints.checkpointSlot(targetNode),
    );
    if (!committedTarget.ok) {
      if (committedTarget.error.kind === "write-protected") {
        const disposition =
          runtime.workspaceMutations.protectCurrentTreeArrival(
            writeAuthority,
            arrival,
            current,
          );
        return disposition.kind === "protected"
          ? lockedTreeArrivalOutcome({ kind: "protected" }, disposition)
          : lockedTreeArrivalOutcome({ kind: "target-changed" }, disposition);
      }
      return {
        kind: "capture-failed",
        failure: committedTarget.error,
      };
    }
    const resolution = {
      treeOid: preparedTarget.value.treeOid,
      foundAt: targetNode,
    };
    const arrivalDisposition = await settleCheckpointInitialization(
      {
        readCurrentView: () => views.revalidate(context),
        sessionIsUsable: (candidate) =>
          runtime.registrations.sessionIsUsable(candidate),
        captureAnchor: (candidate) =>
          runtime.checkpoints.captureAnchor(candidate),
        protectCommittedArrival: () =>
          runtime.workspaceMutations.recoverUncertainLocationInWorkspaceLock(
            writeAuthority,
            context,
          ),
      },
      {
        expected: expectedView,
        node: targetNode,
        resolution,
        locationMatches: (committedView, node) =>
          runtime.workspaceMutations.treeArrivalCanProceed(
            arrival,
            committedView,
            node,
          ),
        admit: (committedView) =>
          runtime.workspaceMutations.admitTreeArrivalIfResolution(
            writeAuthority,
            arrival,
            committedView,
            resolution,
          ),
      },
    );
    return arrivalDisposition.kind === "admitted"
      ? lockedTreeArrivalOutcome({ kind: "materialized" }, arrivalDisposition)
      : checkpointInitializationDispositionConflict(
          arrivalDisposition.kind === "unsettled"
            ? arrivalDisposition.cause
            : new Error(
                "checkpoint initialization protected a changed arrival",
              ),
          arrivalDisposition,
        );
  }

  if (
    plan.target.kind === "no-node" ||
    plan.target.kind === "materialize-missing" ||
    plan.target.kind === "same-location"
  ) {
    return { kind: "target-changed" };
  }
  const previewSnapshot = plan.previewSnapshot;
  if (previewSnapshot === undefined) {
    return { kind: "target-changed" };
  }

  let restoreCurrent: WorkspaceSnapshot;
  try {
    restoreCurrent = await runtime.scanCurrentWorkspaceForScope(
      expectedView.cwd,
      previewSnapshot.scope,
    );
  } catch (error) {
    return { kind: "scan-failed", cause: error };
  }
  if (restoreCurrent.problems.length > 0) {
    return { kind: "scan-incomplete", problems: restoreCurrent.problems };
  }
  if (restoreCurrent.rootPath !== previewSnapshot.rootPath) {
    return { kind: "location-changed" };
  }
  if (
    !sameGitOracleVersion(
      restoreCurrent.gitOracleVersion,
      previewSnapshot.gitOracleVersion,
    )
  ) {
    return { kind: "preview-stale" };
  }
  const gap = planWorkspaceRestore(
    restoreCurrent,
    workspaceSnapshotAsManifest(previewSnapshot),
  );
  if (gap.problems.length > 0 || restorePlanHasChanges(gap)) {
    return { kind: "preview-stale" };
  }
  const restoredView = revalidateNavigationLocation(
    runtime,
    views,
    context,
    expectedView,
  );
  if (restoredView === undefined) {
    return { kind: "location-changed" };
  }
  if (
    !runtime.workspaceMutations.resolutionStillAuthoritative(
      restoredView,
      plan.target.node,
      plan.target.resolution,
    )
  ) {
    return { kind: "target-changed" };
  }
  if (plan.target.kind === "inherit-source") {
    if (!context.isIdle()) return { kind: "busy" };
    const disposition = runtime.workspaceMutations.admitTreeArrivalIfResolution(
      writeAuthority,
      arrival,
      restoredView,
      plan.target.resolution,
    );
    return disposition.kind === "admitted"
      ? lockedTreeArrivalOutcome({ kind: "inherited" }, disposition)
      : lockedTreeArrivalOutcome({ kind: "target-changed" }, disposition);
  }
  if (actualAnchor === undefined) {
    return { kind: "target-changed" };
  }
  return mutationProtocol.restoreTreeArrival(
    {
      arrival,
      expected: restoredView,
      node: actualAnchor,
      resolution: plan.target.resolution,
      current: restoreCurrent,
    },
    writeAuthority,
  );
}
