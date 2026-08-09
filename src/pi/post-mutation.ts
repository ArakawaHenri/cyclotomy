import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { RestoreOutcome } from "../application/restore.ts";
import { messageOf, type CyclotomyRuntime } from "./runtime.ts";
import { readSessionView } from "./session-view.ts";

export type ArrivalProtection =
  | { readonly kind: "protected" }
  | { readonly kind: "pending-node-guard" }
  | { readonly kind: "unavailable"; readonly message: string };

export interface CheckpointInitializationConflict {
  readonly kind: "initialization-conflict";
  readonly message: string;
  readonly arrivalProtection: ArrivalProtection;
}

export type PostMutationConflict =
  | {
      readonly kind: "post-mutation-conflict";
      readonly reason: "location-changed" | "target-changed";
      readonly outcome: RestoreOutcome;
      readonly arrivalProtection: ArrivalProtection;
    }
  | {
      readonly kind: "post-mutation-conflict";
      readonly reason: "control-failed";
      readonly outcome: RestoreOutcome;
      readonly message: string;
      readonly arrivalProtection: ArrivalProtection;
    };

/**
 * Protect the currently observable arrival while the caller still owns the
 * workspace lock. An unregistered session or another workspace is not guessed
 * into this runtime's metadata store.
 */
export async function protectCurrentArrivalInWorkspaceLock(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
): Promise<ArrivalProtection> {
  // An unavailable or tearing location must not inherit the original target's
  // admission. In particular, a later observable descendant must first be
  // protected instead of being mistaken for a newly appended capturable node.
  runtime.quarantineAdmission();
  try {
    const observed = readSessionView(context);
    if (!runtime.sessionIsUsable(observed)) {
      return {
        kind: "unavailable",
        message: "current persisted session identity is unavailable",
      };
    }
    if (!(await runtime.workspaceStillBound(observed.cwd))) {
      return {
        kind: "unavailable",
        message: "current workspace is not bound to this runtime",
      };
    }

    // `realpath` yields to the host. Re-read the complete location before the
    // synchronous metadata write so a stale observation is never reported as
    // the protected current arrival.
    const current = readSessionView(context);
    if (
      !runtime.sessionIsUsable(current) ||
      current.sessionId !== observed.sessionId ||
      current.sessionFile !== observed.sessionFile ||
      current.cwd !== observed.cwd ||
      current.leafId !== observed.leafId
    ) {
      return {
        kind: "unavailable",
        message: "current arrival changed during workspace authentication",
      };
    }

    let node;
    try {
      node = runtime.captureAnchor(current);
    } catch (error) {
      // A stable session/workspace identity is enough to preserve the intent,
      // even when Pi's current tree is temporarily unresolvable. A later
      // concrete observation will consume the same durable pending guard.
      if (runtime.setPendingNodeGuard(current)) {
        return { kind: "pending-node-guard" };
      }
      return {
        kind: "unavailable",
        message: `current session did not retain its pending checkpoint guard: ${messageOf(
          error,
        )}`,
      };
    }
    if (node === undefined) {
      // Persist the intent against the authenticated session. Its first
      // concrete node consumes the flag and installs its exact guard in one
      // transaction, including after process replacement.
      if (!runtime.setPendingNodeGuard(current)) {
        return {
          kind: "unavailable",
          message:
            "current session did not retain its pending checkpoint guard",
        };
      }
      return { kind: "pending-node-guard" };
    }
    runtime.protectNode(current, node);
    return runtime.metadata.isNodeWriteProtected(node.sessionId, node.entryId)
      ? { kind: "protected" }
      : {
          kind: "unavailable",
          message: "current arrival did not retain write protection",
        };
  } catch (error) {
    return { kind: "unavailable", message: messageOf(error) };
  }
}

/**
 * Recover fail-closed after the enclosing workspace operation itself rejects,
 * including a lock-release failure after its action had already completed.
 * Quarantine happens before reacquisition so a waiting retry cannot admit a
 * descendant from stale runtime state.
 */
export async function protectCurrentArrivalAfterWorkspaceFailure(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  operation: string,
): Promise<ArrivalProtection> {
  runtime.quarantineAdmission();
  try {
    return await runtime.enqueueWorkspace(operation, () =>
      protectCurrentArrivalInWorkspaceLock(runtime, context),
    );
  } catch (error) {
    runtime.quarantineAdmission();
    return {
      kind: "unavailable",
      message: `current arrival protection could not reacquire the workspace lock: ${messageOf(
        error,
      )}`,
    };
  }
}

/** Report a committed first checkpoint without admitting a stale arrival. */
export async function checkpointInitializationConflict(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  error: unknown,
  reacquireOperation?: string,
): Promise<CheckpointInitializationConflict> {
  return {
    kind: "initialization-conflict",
    message: messageOf(error),
    arrivalProtection:
      reacquireOperation === undefined
        ? await protectCurrentArrivalInWorkspaceLock(runtime, context)
        : await protectCurrentArrivalAfterWorkspaceFailure(
            runtime,
            context,
            reacquireOperation,
          ),
  };
}

/** Preserve the destructive outcome when a later control-plane step fails. */
export async function postMutationControlFailure(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  error: unknown,
  outcome: RestoreOutcome | undefined,
  reacquireOperation?: string,
): Promise<PostMutationConflict> {
  const message = messageOf(error);
  return {
    kind: "post-mutation-conflict",
    reason: "control-failed",
    outcome:
      outcome ??
      ({
        kind: "failed",
        stage: "apply",
        message,
      } satisfies RestoreOutcome),
    message,
    arrivalProtection:
      reacquireOperation === undefined
        ? await protectCurrentArrivalInWorkspaceLock(runtime, context)
        : await protectCurrentArrivalAfterWorkspaceFailure(
            runtime,
            context,
            reacquireOperation,
          ),
  };
}
