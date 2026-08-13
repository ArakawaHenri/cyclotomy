import type {
  ExtensionEvent,
  MessageEndEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

type PublicSessionEvent = Extract<
  ExtensionEvent,
  { readonly type: `session_${string}` }
>;

type SessionEventPolicy =
  "bootstrap" | "prepare" | "settle" | "close" | "ignore-nonstructural";

/**
 * Compile-time inventory of Pi's public session lifecycle.
 *
 * This is deliberately a policy manifest rather than a dynamic dispatcher:
 * Pi's typed `on()` overloads remain the registration authority, while a new
 * public session event makes both the locked and latest-host type checks ask
 * for an explicit Cyclotomy policy.
 */
Object.freeze({
  session_start: "bootstrap",
  session_info_changed: "ignore-nonstructural",
  session_before_switch: "prepare",
  session_before_fork: "prepare",
  session_before_compact: "prepare",
  session_compact: "settle",
  session_shutdown: "close",
  session_before_tree: "prepare",
  session_tree: "settle",
} as const satisfies Record<PublicSessionEvent["type"], SessionEventPolicy>);

export interface SessionStartPolicy {
  readonly registration: "independent" | "fork";
  readonly reconciliation: "loaded" | "reloaded";
}

const SESSION_START_POLICY = {
  startup: { registration: "independent", reconciliation: "loaded" },
  reload: { registration: "independent", reconciliation: "reloaded" },
  new: { registration: "independent", reconciliation: "loaded" },
  resume: { registration: "independent", reconciliation: "loaded" },
  fork: { registration: "fork", reconciliation: "loaded" },
} as const satisfies Record<SessionStartEvent["reason"], SessionStartPolicy>;

/** Runtime guard complements exhaustiveness when a newer host loads old JS. */
export function sessionStartPolicy(
  reason: SessionStartEvent["reason"],
): SessionStartPolicy {
  if (!Object.hasOwn(SESSION_START_POLICY, reason)) {
    throw new Error(`unsupported Pi session-start reason: ${String(reason)}`);
  }
  return SESSION_START_POLICY[reason];
}

type MessageRole = MessageEndEvent["message"]["role"];

const MESSAGE_END_POLICY = {
  user: "other-boundary",
  assistant: "other-boundary",
  toolResult: "other-boundary",
  bashExecution: "other-boundary",
  custom: "capture-observed-location",
  branchSummary: "other-boundary",
  compactionSummary: "other-boundary",
} as const satisfies Record<
  MessageRole,
  "capture-observed-location" | "other-boundary"
>;

/** Only extension custom messages lack a dedicated cancellable preflight. */
export function messageEndNeedsSourceCapture(role: MessageRole): boolean {
  if (!Object.hasOwn(MESSAGE_END_POLICY, role)) {
    // A newer Pi may reach older emitted JavaScript with a role that was not
    // present at compile time. Observing that boundary is safer than assuming
    // another event already captured its source; the table above still makes
    // every role in the installed Pi types an explicit compile-time decision.
    return true;
  }
  return MESSAGE_END_POLICY[role] === "capture-observed-location";
}
