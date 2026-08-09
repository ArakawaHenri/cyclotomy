import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  planWorkspaceRestore,
  restorePlanHasChanges,
  workspaceSnapshotAsManifest,
  type WorkspaceRestorePlan,
} from "../infrastructure/restore-plan.ts";
import {
  restoreWorkspace,
  type RestoreOutcome,
} from "../application/restore.ts";
import type { ResolvedNodeState } from "../application/resolve.ts";
import type { NodeKey } from "../domain/model.ts";
import type { WorkspaceSnapshot } from "../infrastructure/workspace-scan.ts";
import { requestRestoreChoice } from "./restore-choice.ts";
import { messageOf, type CyclotomyRuntime } from "./runtime.ts";
import { readSessionView, type SessionView } from "./session-view.ts";

export type ConfirmedRestoreMode = "manual" | "loaded-session";

export type ConfirmedRestoreResult =
  | { readonly kind: "missing" }
  | { readonly kind: "matches" }
  | { readonly kind: "needs-ui" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "location-changed" }
  | { readonly kind: "target-changed" }
  | { readonly kind: "preview-stale" }
  | { readonly kind: "scan-incomplete"; readonly message: string }
  | {
      readonly kind: "failed";
      readonly phase: "prepare" | "apply";
      readonly message: string;
    }
  | { readonly kind: "outcome"; readonly outcome: RestoreOutcome };

interface PreparedRestore {
  readonly resolution: ResolvedNodeState;
  readonly snapshot: WorkspaceSnapshot;
  readonly drift: WorkspaceRestorePlan;
}

function stillAtNode(
  context: ExtensionContext,
  node: NodeKey,
  cwd: string,
): boolean {
  const current = readSessionView(context);
  return (
    current.sessionId === node.sessionId &&
    current.leafId === node.entryId &&
    current.cwd === cwd
  );
}

/**
 * The one destructive confirmation protocol shared by explicit restore and
 * loading an existing session. It binds the user's preview to the session,
 * node, canonical workspace, authoritative target, and complete observation.
 */
export async function runConfirmedRestore(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  view: SessionView,
  node: NodeKey,
  mode: ConfirmedRestoreMode,
): Promise<ConfirmedRestoreResult> {
  let prepared: PreparedRestore | undefined;
  runtime.setStatus(context, runtime.i18n.t("checkingWorkspace"));
  try {
    const result = await runtime.enqueueWorkspace(
      `${mode}-restore-prepare`,
      async () => {
        if (!stillAtNode(context, node, view.cwd)) {
          return { kind: "location-changed" as const };
        }
        const readable = await runtime.resolveReadableTreeIn(view, node);
        if (readable === undefined) return { kind: "missing" as const };
        const { resolution, manifest } = readable;
        const snapshot = await runtime.scanCurrentWorkspaceForScope(
          view.cwd,
          manifest.scope,
        );
        if (snapshot.problems.length > 0) {
          return {
            kind: "scan-incomplete" as const,
            message: runtime.i18n.formatScanProblems(snapshot.problems),
          };
        }
        const drift = planWorkspaceRestore(snapshot, manifest);
        if (drift.problems.length > 0) {
          return {
            kind: "scan-incomplete" as const,
            message: runtime.i18n.formatScanProblems(drift.problems),
          };
        }
        if (!restorePlanHasChanges(drift)) {
          return { kind: "matches" as const };
        }
        return {
          kind: "prepared" as const,
          resolution,
          snapshot,
          drift,
        };
      },
    );
    if (result.kind !== "prepared") return result;
    prepared = result;
  } catch (error) {
    return { kind: "failed", phase: "prepare", message: messageOf(error) };
  } finally {
    runtime.setStatus(context, undefined);
  }

  // Pi binds RPC stdin only after session_start finishes. Opening a selector
  // while loading the session would therefore wait for a response the client
  // cannot send yet. Manual RPC /restore runs after startup and remains fully
  // interactive.
  if (
    !context.hasUI ||
    (mode === "loaded-session" && context.mode === "rpc")
  ) {
    return { kind: "needs-ui" };
  }
  let confirmed: boolean;
  try {
    confirmed = await requestRestoreChoice(
      runtime,
      context,
      mode,
      prepared.drift,
    );
  } catch (error) {
    return {
      kind: "failed",
      phase: "prepare",
      message: messageOf(error),
    };
  }
  if (!confirmed) return { kind: "cancelled" };

  runtime.setStatus(context, runtime.i18n.t("restoringWorkspace"));
  try {
    return await runtime.enqueueWorkspace(
      `${mode}-restore-apply`,
      async (): Promise<ConfirmedRestoreResult> => {
        if (
          !context.isIdle() ||
          (mode === "manual" && runtime.transitions.rejectConflict())
        ) {
          return { kind: "location-changed" };
        }
        if (!stillAtNode(context, node, view.cwd)) {
          return { kind: "location-changed" };
        }
        if (!runtime.resolutionStillAuthoritative(
          view,
          node,
          prepared.resolution,
        )) {
          return { kind: "target-changed" };
        }
        const current = await runtime.scanCurrentWorkspaceForScope(
          view.cwd,
          prepared.snapshot.scope,
        );
        if (current.problems.length > 0) {
          return {
            kind: "scan-incomplete",
            message: runtime.i18n.formatScanProblems(current.problems),
          };
        }
        if (current.rootPath !== prepared.snapshot.rootPath) {
          return { kind: "location-changed" };
        }
        const gap = planWorkspaceRestore(
          current,
          workspaceSnapshotAsManifest(prepared.snapshot),
        );
        if (gap.problems.length > 0 || restorePlanHasChanges(gap)) {
          return { kind: "preview-stale" };
        }
        return {
          kind: "outcome",
          outcome: await restoreWorkspace(
            runtime.restoreDeps(),
            view.cwd,
            prepared.resolution,
            { current },
          ),
        };
      },
    );
  } catch (error) {
    return { kind: "failed", phase: "apply", message: messageOf(error) };
  } finally {
    runtime.setStatus(context, undefined);
  }
}
