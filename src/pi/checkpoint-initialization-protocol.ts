import type { ResolvedNodeState } from "../application/resolve.ts";
import type { NodeKey } from "../domain/model.ts";
import {
  type ArrivalDisposition,
  type NonAdmittedArrivalDisposition,
  unsettledArrival,
} from "./arrival-settlement.ts";
import { isExactUsableSessionView, type SessionView } from "./session-view.ts";

export interface CheckpointInitializationProtocolDeps {
  readonly readCurrentView: () => SessionView;
  readonly sessionIsUsable: (view: SessionView) => boolean;
  readonly captureAnchor: (view: SessionView) => NodeKey | undefined;
  /** Runs in the caller's current lock scope and must durably fail closed. */
  readonly protectCommittedArrival: (
    cause: unknown,
  ) => NonAdmittedArrivalDisposition | Promise<NonAdmittedArrivalDisposition>;
}

export interface CheckpointInitializationRequest {
  readonly expected: SessionView;
  readonly node: NodeKey;
  readonly resolution: ResolvedNodeState;
  /** Entry points with an opaque Pi proof may authenticate a logical ancestor. */
  readonly locationMatches?: (view: SessionView, node: NodeKey) => boolean;
  /** Entry-point-specific admission; preparation and commit stay outside. */
  readonly admit: (
    view: SessionView,
    resolution: ResolvedNodeState,
  ) => ArrivalDisposition;
}

export function locationInitializationAdmission(
  admitted: boolean,
  cause: unknown = new Error(
    "checkpoint admission changed after initialization",
  ),
): ArrivalDisposition {
  return admitted ? { kind: "admitted" } : { kind: "unsettled", cause };
}

function sameNode(left: NodeKey | undefined, right: NodeKey): boolean {
  return left?.sessionId === right.sessionId && left.entryId === right.entryId;
}

async function protectAfterInitialization(
  deps: CheckpointInitializationProtocolDeps,
  primary: unknown,
): Promise<ArrivalDisposition> {
  try {
    const disposition = await deps.protectCommittedArrival(primary);
    if (disposition.kind !== "unsettled") return disposition;
    return unsettledArrival(
      "checkpoint initialization and arrival protection both failed",
      [primary, disposition.cause],
    );
  } catch (secondary) {
    return unsettledArrival(
      "checkpoint initialization and arrival protection both failed",
      [primary, secondary],
    );
  }
}

/**
 * Settle only the post-commit half of first-checkpoint initialization.
 *
 * Manual adoption, loaded-session materialization, and tree-arrival capture
 * keep their distinct preconditions. Once metadata committed, all three use
 * this one reauthentication/admission/protection sequence.
 */
export async function settleCheckpointInitialization(
  deps: CheckpointInitializationProtocolDeps,
  request: CheckpointInitializationRequest,
): Promise<ArrivalDisposition> {
  let current: SessionView;
  try {
    current = deps.readCurrentView();
    if (
      !isExactUsableSessionView(current, request.expected, (candidate) =>
        deps.sessionIsUsable(candidate),
      ) ||
      !(
        request.locationMatches?.(current, request.node) ??
        sameNode(deps.captureAnchor(current), request.node)
      )
    ) {
      return protectAfterInitialization(
        deps,
        new Error("active location changed after checkpoint initialization"),
      );
    }
    const admission = request.admit(current, request.resolution);
    // `protected` is already a durable settlement supplied by the entry point;
    // only a truly unsettled admission needs the protocol's fallback recovery.
    return admission.kind === "unsettled"
      ? protectAfterInitialization(deps, admission.cause)
      : admission;
  } catch (cause) {
    return protectAfterInitialization(deps, cause);
  }
}
