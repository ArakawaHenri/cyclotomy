import type { CaptureFailure, CaptureSuccess } from "../application/capture.ts";
import type { CheckpointSlot } from "../domain/checkpoint-slot.ts";
import type { NodeKey, Result } from "../domain/model.ts";
import type {
  AdmissionDecision,
  AdmissionLease,
} from "./checkpoint-admission.ts";
import type { SessionView } from "./session-view.ts";

export type CaptureProtocolFailure =
  | {
      readonly kind: "location-changed";
      readonly phase: "before-capture" | "during-capture";
    }
  | { readonly kind: "workspace-unavailable" }
  | { readonly kind: "not-admitted" }
  | { readonly kind: "capture-failed"; readonly failure: CaptureFailure }
  | { readonly kind: "failed"; readonly cause: unknown };

export type CaptureProtocolResult =
  | { readonly kind: "captured"; readonly capture: CaptureSuccess }
  | { readonly kind: "no-coordinate" }
  | { readonly kind: "write-protected" }
  | CaptureProtocolFailure;

/** Capabilities used by one capture while the caller owns the workspace lock. */
export interface CaptureProtocolDeps {
  readonly readCurrentView: () => SessionView;
  readonly sessionIsUsable: (view: SessionView) => boolean;
  readonly captureAnchor: (
    view: SessionView,
    leafId?: string | null,
  ) => NodeKey | undefined;
  readonly captureAdmission: (
    view: SessionView,
    node: NodeKey | undefined,
  ) => AdmissionDecision;
  readonly checkpointSlot: (node: NodeKey) => CheckpointSlot;
  readonly prepareCurrent: (
    view: SessionView,
  ) => Promise<Result<CaptureSuccess, CaptureFailure>>;
  readonly workspaceStillBound: (cwd: string) => Promise<boolean>;
  readonly captureLeaseIsCurrent: (
    lease: AdmissionLease,
    view: SessionView,
    node: NodeKey,
  ) => boolean;
  readonly commitPrepared: (
    view: SessionView,
    node: NodeKey,
    prepared: CaptureSuccess,
    expectedSlot: CheckpointSlot,
  ) => Result<CaptureSuccess, CaptureFailure>;
}

export interface CaptureProtocolRequest {
  readonly expected: SessionView;
  /** Omit to capture the expected view's current stable coordinate. */
  readonly leafId?: string | null;
}

function exactCurrentView(
  deps: CaptureProtocolDeps,
  expected: SessionView,
): SessionView | undefined {
  const current = deps.readCurrentView();
  return deps.sessionIsUsable(current) && current.isSameSnapshotAs(expected)
    ? current
    : undefined;
}

/**
 * Capture one authenticated current location.
 *
 * Queueing, UI, and entry-point policy stay outside. This protocol owns the
 * single read/admit/scan/rebind/lease/commit sequence shared by Pi boundaries.
 */
export async function runCaptureProtocol(
  deps: CaptureProtocolDeps,
  request: CaptureProtocolRequest,
): Promise<CaptureProtocolResult> {
  try {
    const node = deps.captureAnchor(request.expected, request.leafId);
    const admittedView = exactCurrentView(deps, request.expected);
    if (admittedView === undefined) {
      return { kind: "location-changed", phase: "before-capture" };
    }

    const admission = deps.captureAdmission(admittedView, node);
    switch (admission.kind) {
      case "no-coordinate":
        return { kind: "no-coordinate" };
      case "write-protected":
        return { kind: "write-protected" };
      case "not-admitted":
        return { kind: "not-admitted" };
      case "capture":
        break;
    }
    if (node === undefined) {
      return {
        kind: "failed",
        cause: new Error("capture admission has no coordinate"),
      };
    }

    const expectedSlot = deps.checkpointSlot(node);
    const prepared = await deps.prepareCurrent(admittedView);
    if (!prepared.ok) {
      return { kind: "capture-failed", failure: prepared.error };
    }
    if (!(await deps.workspaceStillBound(admittedView.cwd))) {
      return { kind: "workspace-unavailable" };
    }
    const current = exactCurrentView(deps, request.expected);
    if (
      current === undefined ||
      !deps.captureLeaseIsCurrent(admission.lease, current, node)
    ) {
      return { kind: "location-changed", phase: "during-capture" };
    }

    const committed = deps.commitPrepared(
      current,
      node,
      prepared.value,
      expectedSlot,
    );
    if (committed.ok) {
      return { kind: "captured", capture: committed.value };
    }
    if (committed.error.kind === "write-protected") {
      return { kind: "write-protected" };
    }
    return { kind: "capture-failed", failure: committed.error };
  } catch (cause) {
    return { kind: "failed", cause };
  }
}
