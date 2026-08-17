import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { CaptureFailure, CaptureSuccess } from "../application/capture.ts";
import type { ResolvedNodeState } from "../application/resolve.ts";
import type { NodeKey } from "../domain/model.ts";
import {
  checkpointSlotsEqual,
  type CheckpointSlot,
} from "../domain/checkpoint-slot.ts";
import type { WorkspaceWriteAuthority } from "../infrastructure/workspace-lock.ts";
import {
  planWorkspaceRestore,
  restorePlanHasChanges,
  type WorkspaceRestorePlan,
  workspaceSnapshotAsManifest,
} from "../infrastructure/restore-plan.ts";
import { prepareWorkspaceRestorePlan } from "../infrastructure/restore-preparation.ts";
import { sameGitOracleVersion } from "../infrastructure/git-replay-risk.ts";
import type {
  ScanProblem,
  WorkspaceSnapshot,
} from "../infrastructure/workspace-scan.ts";
import {
  revalidateNavigationLocation,
  sameNavigationNode,
} from "./navigation-authentication.ts";
import type { NavigationTargetPlan } from "./navigation-plan.ts";
import type { CyclotomyRuntime } from "./runtime.ts";
import type { SessionView, SessionViewTracker } from "./session-view.ts";

type ClassifiedNavigationTargetKind = Exclude<
  NavigationTargetPlan["kind"],
  "detach"
>;

type NavigationSourceKind = "capture" | "write-protected" | "no-coordinate";

export type SourceBlockReason = "not-admitted" | "changed-before-publication";

interface PreparedNavigationDeparture {
  readonly kind: "ready";
  readonly sourceKind: NavigationSourceKind;
  readonly sourceSnapshot: WorkspaceSnapshot | undefined;
  readonly sourceExpectedSlot: CheckpointSlot | undefined;
  readonly restoreSnapshot: WorkspaceSnapshot | undefined;
  readonly resolution: ResolvedNodeState | undefined;
  readonly targetKind: ClassifiedNavigationTargetKind;
  readonly drift: WorkspaceRestorePlan | undefined;
}

type NavigationDeparturePreparation =
  | PreparedNavigationDeparture
  | { readonly kind: "location-changed" }
  | { readonly kind: "source-blocked"; readonly reason: SourceBlockReason }
  | {
      readonly kind: "scan-incomplete";
      readonly problems: readonly ScanProblem[];
    };

type NavigationDepartureCommit =
  | {
      readonly kind: "ready";
      readonly snapshot: WorkspaceSnapshot | undefined;
      readonly target: NavigationTargetPlan;
    }
  | {
      readonly kind:
        | "busy"
        | "location-changed"
        | "preview-stale"
        | "target-changed"
        | "workspace-binding-lost";
    }
  | { readonly kind: "source-blocked"; readonly reason: SourceBlockReason }
  | {
      readonly kind: "scan-incomplete";
      readonly problems: readonly ScanProblem[];
    }
  | { readonly kind: "capture-failed"; readonly failure: CaptureFailure };

/** Whether capturing source will become target's nearest exact slot. */
function targetWillInheritSource(
  runtime: CyclotomyRuntime,
  view: SessionView,
  source: NodeKey | undefined,
  target: NodeKey | undefined,
): boolean {
  if (
    source === undefined ||
    target === undefined ||
    source.sessionId !== target.sessionId
  ) {
    return false;
  }
  const ancestry = runtime.checkpoints.ancestryEntryIds(view, target.entryId);
  const sourceIndex = ancestry.lastIndexOf(source.entryId);
  if (sourceIndex < 0) return false;
  return ancestry.slice(sourceIndex + 1).every(
    (entryId) =>
      runtime.checkpoints.checkpointSlot({
        sessionId: target.sessionId,
        entryId,
      }).kind === "open-missing",
  );
}

function classifyTarget(
  runtime: CyclotomyRuntime,
  view: SessionView,
  source: NodeKey | undefined,
  target: NodeKey | undefined,
  sourceKind: NavigationSourceKind,
  hasResolution: boolean,
): ClassifiedNavigationTargetKind {
  if (target === undefined) return "no-node";
  if (sameNavigationNode(source, target)) return "same-location";
  if (runtime.checkpoints.locationIsBlocked(target)) {
    return hasResolution ? "restore" : "protected-missing";
  }
  if (
    sourceKind === "capture" &&
    targetWillInheritSource(runtime, view, source, target)
  ) {
    return "inherit-source";
  }
  if (hasResolution) return "restore";
  if (sourceKind === "write-protected") {
    return "protected-missing";
  }
  return "materialize-missing";
}

function preparedTargetStillMatches(
  runtime: CyclotomyRuntime,
  view: SessionView,
  source: NodeKey | undefined,
  target: NodeKey | undefined,
  sourceKind: NavigationSourceKind,
  expectedKind: ClassifiedNavigationTargetKind,
  resolution: ResolvedNodeState | undefined,
): boolean {
  const currentKind = classifyTarget(
    runtime,
    view,
    source,
    target,
    sourceKind,
    resolution !== undefined,
  );
  if (currentKind !== expectedKind) return false;
  return (
    target === undefined ||
    currentKind === "inherit-source" ||
    currentKind === "same-location" ||
    (resolution === undefined
      ? runtime.workspaceMutations.locationIsUnresolved(view, target)
      : runtime.workspaceMutations.resolutionStillAuthoritative(
          view,
          target,
          resolution,
        ))
  );
}

/** Observe the source and target needed to preview one navigation departure. */
export async function prepareNavigationDepartureInWorkspaceLock(
  runtime: CyclotomyRuntime,
  views: SessionViewTracker,
  context: ExtensionContext,
  writeAuthority: WorkspaceWriteAuthority,
  expectedView: SessionView,
  source: NodeKey | undefined,
  target: NodeKey | undefined,
): Promise<NavigationDeparturePreparation> {
  const current = revalidateNavigationLocation(
    runtime,
    views,
    context,
    expectedView,
  );
  if (current === undefined) {
    return { kind: "location-changed" };
  }
  const sourceAdmission = runtime.workspaceMutations.captureAdmission(
    writeAuthority,
    current,
    source,
  );
  if (sourceAdmission.kind === "not-admitted") {
    return { kind: "source-blocked", reason: "not-admitted" };
  }
  let sourceSnapshot: WorkspaceSnapshot | undefined;
  let sourceExpectedSlot: CheckpointSlot | undefined;
  let preparedView = current;
  if (sourceAdmission.kind === "capture") {
    if (source !== undefined) {
      sourceExpectedSlot = runtime.checkpoints.checkpointSlot(source);
    }
    sourceSnapshot = await runtime.scanCurrentWorkspace(expectedView.cwd);
    if (sourceSnapshot.problems.length > 0) {
      return { kind: "scan-incomplete", problems: sourceSnapshot.problems };
    }
    const observed = revalidateNavigationLocation(
      runtime,
      views,
      context,
      expectedView,
    );
    if (observed === undefined) {
      return { kind: "location-changed" };
    }
    preparedView = observed;
  }

  const targetKind = classifyTarget(
    runtime,
    preparedView,
    source,
    target,
    sourceAdmission.kind,
    false,
  );
  if (
    targetKind === "no-node" ||
    targetKind === "same-location" ||
    targetKind === "inherit-source"
  ) {
    return {
      kind: "ready",
      sourceKind: sourceAdmission.kind,
      sourceSnapshot,
      sourceExpectedSlot,
      restoreSnapshot: undefined,
      resolution: undefined,
      targetKind,
      drift: undefined,
    };
  }
  if (target === undefined) {
    throw new Error("classified navigation target is missing");
  }
  const readable = await runtime.resolveReadableTreeIn(preparedView, target);
  if (readable === undefined) {
    const missingKind = classifyTarget(
      runtime,
      preparedView,
      source,
      target,
      sourceAdmission.kind,
      false,
    );
    return {
      kind: "ready",
      sourceKind: sourceAdmission.kind,
      sourceSnapshot,
      sourceExpectedSlot,
      restoreSnapshot: undefined,
      resolution: undefined,
      targetKind: missingKind,
      drift: undefined,
    };
  }
  const { resolution, manifest, scopeValidation } = readable;
  const restoreSnapshot = await runtime.scanCurrentWorkspaceForScope(
    expectedView.cwd,
    manifest.scope,
  );
  if (restoreSnapshot.problems.length > 0) {
    return { kind: "scan-incomplete", problems: restoreSnapshot.problems };
  }
  if (
    !sameGitOracleVersion(
      scopeValidation.gitVersion,
      restoreSnapshot.gitOracleVersion,
    )
  ) {
    throw new Error("Git evaluator changed while preparing navigation");
  }
  const drift = (await prepareWorkspaceRestorePlan(restoreSnapshot, manifest))
    .plan;
  if (drift.problems.length > 0) {
    return { kind: "scan-incomplete", problems: drift.problems };
  }
  return {
    kind: "ready",
    sourceKind: sourceAdmission.kind,
    sourceSnapshot,
    sourceExpectedSlot,
    restoreSnapshot,
    resolution,
    targetKind: "restore",
    drift,
  };
}

/** Reauthenticate previewed facts and publish the immutable departure plan. */
export async function commitNavigationDepartureInWorkspaceLock(
  runtime: CyclotomyRuntime,
  views: SessionViewTracker,
  context: ExtensionContext,
  writeAuthority: WorkspaceWriteAuthority,
  expectedView: SessionView,
  source: NodeKey | undefined,
  target: NodeKey | undefined,
  prepared: PreparedNavigationDeparture,
  navigationChoice: "restore" | "detach",
): Promise<NavigationDepartureCommit> {
  // `isIdle` has only its public product meaning: never begin or publish
  // transition work while Pi is streaming. It is not a transition mutex.
  if (!context.isIdle()) return { kind: "busy" };
  const commitView = revalidateNavigationLocation(
    runtime,
    views,
    context,
    expectedView,
  );
  if (commitView === undefined) {
    return { kind: "location-changed" };
  }
  const sourceAdmission = runtime.workspaceMutations.captureAdmission(
    writeAuthority,
    commitView,
    source,
  );
  if (sourceAdmission.kind === "not-admitted") {
    return { kind: "source-blocked", reason: "not-admitted" };
  }
  if (sourceAdmission.kind !== prepared.sourceKind) {
    return { kind: "target-changed" };
  }

  let sourceCurrent: WorkspaceSnapshot | undefined;
  if (sourceAdmission.kind === "capture") {
    if (prepared.sourceSnapshot === undefined) {
      return { kind: "target-changed" };
    }
    if (source === undefined || prepared.sourceExpectedSlot === undefined) {
      return { kind: "target-changed" };
    }
    if (
      !checkpointSlotsEqual(
        runtime.checkpoints.checkpointSlot(source),
        prepared.sourceExpectedSlot,
      )
    ) {
      return { kind: "target-changed" };
    }
    sourceCurrent = await runtime.scanCurrentWorkspace(expectedView.cwd);
    if (sourceCurrent.problems.length > 0) {
      return { kind: "scan-incomplete", problems: sourceCurrent.problems };
    }
    if (sourceCurrent.rootPath !== prepared.sourceSnapshot.rootPath) {
      return { kind: "location-changed" };
    }
    const sourceGap = planWorkspaceRestore(
      sourceCurrent,
      workspaceSnapshotAsManifest(prepared.sourceSnapshot),
    );
    if (sourceGap.problems.length > 0 || restorePlanHasChanges(sourceGap)) {
      return { kind: "preview-stale" };
    }
  }
  if (
    !preparedTargetStillMatches(
      runtime,
      commitView,
      source,
      target,
      sourceAdmission.kind,
      prepared.targetKind,
      prepared.resolution,
    )
  ) {
    return { kind: "target-changed" };
  }
  // The preview may have crossed an interactive confirmation. Authenticate
  // the unchanged target closure once more before Pi can leave the source.
  if (prepared.resolution !== undefined && prepared.targetKind === "restore") {
    await runtime.store.readTree(prepared.resolution.treeOid);
  }

  let restoreCurrent: WorkspaceSnapshot | undefined;
  if (prepared.targetKind === "restore" && navigationChoice === "restore") {
    if (prepared.restoreSnapshot === undefined) {
      return { kind: "target-changed" };
    }
    restoreCurrent = await runtime.scanCurrentWorkspaceForScope(
      expectedView.cwd,
      prepared.restoreSnapshot.scope,
    );
    if (restoreCurrent.problems.length > 0) {
      return { kind: "scan-incomplete", problems: restoreCurrent.problems };
    }
    if (restoreCurrent.rootPath !== prepared.restoreSnapshot.rootPath) {
      return { kind: "location-changed" };
    }
    if (
      !sameGitOracleVersion(
        restoreCurrent.gitOracleVersion,
        prepared.restoreSnapshot.gitOracleVersion,
      )
    ) {
      return { kind: "preview-stale" };
    }
    const restoreGap = planWorkspaceRestore(
      restoreCurrent,
      workspaceSnapshotAsManifest(prepared.restoreSnapshot),
    );
    if (restoreGap.problems.length > 0 || restorePlanHasChanges(restoreGap)) {
      return { kind: "preview-stale" };
    }
  } else if (prepared.targetKind === "inherit-source") {
    if (sourceCurrent === undefined) {
      return { kind: "target-changed" };
    }
    restoreCurrent = sourceCurrent;
  }

  let preparedSource: CaptureSuccess | undefined;
  if (sourceAdmission.kind === "capture" && source !== undefined) {
    if (sourceCurrent === undefined) {
      return { kind: "target-changed" };
    }
    const currentView = revalidateNavigationLocation(
      runtime,
      views,
      context,
      expectedView,
    );
    if (
      currentView === undefined ||
      !runtime.workspaceMutations.captureLeaseIsCurrent(
        sourceAdmission.lease,
        currentView,
        source,
      )
    ) {
      return {
        kind: "source-blocked",
        reason: "changed-before-publication",
      };
    }
    const published = await runtime.checkpoints.prepareObserved(sourceCurrent);
    if (!published.ok) {
      return { kind: "capture-failed", failure: published.error };
    }
    preparedSource = published.value;
    if (!(await runtime.registrations.workspaceStillBound(expectedView.cwd))) {
      return { kind: "workspace-binding-lost" };
    }
    if (!context.isIdle()) return { kind: "busy" };
    const validatedView = revalidateNavigationLocation(
      runtime,
      views,
      context,
      expectedView,
    );
    if (
      validatedView === undefined ||
      !runtime.workspaceMutations.captureLeaseIsCurrent(
        sourceAdmission.lease,
        validatedView,
        source,
      )
    ) {
      return { kind: "location-changed" };
    }
    if (!context.isIdle()) return { kind: "busy" };
    const sourceExpectedSlot = prepared.sourceExpectedSlot;
    if (sourceExpectedSlot === undefined) {
      return { kind: "target-changed" };
    }
    const sourceCommitted = runtime.commitPreparedCapture(
      writeAuthority,
      validatedView,
      source,
      preparedSource,
      sourceExpectedSlot,
    );
    if (!sourceCommitted.ok) {
      if (sourceCommitted.error.kind === "write-protected") {
        runtime.workspaceMutations.protectCurrentNode(
          writeAuthority,
          validatedView,
          source,
        );
      }
      return { kind: "capture-failed", failure: sourceCommitted.error };
    }
  }

  if (!(await runtime.registrations.workspaceStillBound(expectedView.cwd))) {
    return { kind: "workspace-binding-lost" };
  }
  if (!context.isIdle()) return { kind: "busy" };
  const departureView = revalidateNavigationLocation(
    runtime,
    views,
    context,
    expectedView,
  );
  if (departureView === undefined) {
    return { kind: "location-changed" };
  }
  if (
    sourceAdmission.kind === "capture" &&
    (source === undefined ||
      !runtime.workspaceMutations.captureLeaseIsCurrent(
        sourceAdmission.lease,
        departureView,
        source,
      ))
  ) {
    return { kind: "location-changed" };
  }
  if (
    !preparedTargetStillMatches(
      runtime,
      departureView,
      source,
      target,
      sourceAdmission.kind,
      prepared.targetKind,
      prepared.resolution,
    )
  ) {
    return { kind: "target-changed" };
  }

  let targetPlan: NavigationTargetPlan;
  switch (prepared.targetKind) {
    case "no-node":
      targetPlan = { kind: "no-node" };
      break;
    case "materialize-missing":
      if (target === undefined) return { kind: "target-changed" };
      targetPlan = { kind: "materialize-missing", node: target };
      break;
    case "protected-missing":
      if (target === undefined) return { kind: "target-changed" };
      targetPlan = { kind: "protected-missing", node: target };
      break;
    case "same-location":
      if (target === undefined) return { kind: "target-changed" };
      targetPlan = { kind: "same-location", node: target };
      break;
    case "inherit-source":
      if (
        source === undefined ||
        target === undefined ||
        preparedSource === undefined
      ) {
        return { kind: "target-changed" };
      }
      targetPlan = {
        kind: "inherit-source",
        node: target,
        resolution: {
          treeOid: preparedSource.treeOid,
          foundAt: source,
        },
      };
      break;
    case "restore":
      if (target === undefined || prepared.resolution === undefined) {
        return { kind: "target-changed" };
      }
      targetPlan =
        navigationChoice === "detach"
          ? {
              kind: "detach",
              node: target,
              resolution: prepared.resolution,
            }
          : {
              kind: "restore",
              node: target,
              resolution: prepared.resolution,
            };
      break;
  }
  return { kind: "ready", snapshot: restoreCurrent, target: targetPlan };
}
