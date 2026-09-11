import type { MaintenanceIssue } from "../application/maintenance-plan.ts";
import type {
  InspectionState,
  StoreDiagnosticIssue,
} from "../application/store-diagnostics.ts";

/**
 * The overall answer a command produced. Read commands describe how well the
 * store could be inspected; maintenance commands say whether a plan was made
 * or applied. `unavailable`, `blocked` and `partial` are honest outcomes, not
 * failures: the exit code table below turns them into a status a script reads.
 */
export type CliStatus =
  | "ok"
  | "observational"
  | "partial"
  | "busy"
  | "unavailable"
  | "unsupported"
  | "blocked"
  | "preview"
  | "applied"
  | "error";

export type CliIssueSeverity = "error" | "warning" | "info";

/** One script-readable problem; `code` is stable, `detail` is not translated. */
export interface CliIssue {
  readonly code: string;
  readonly severity: CliIssueSeverity;
  readonly detail: string;
  readonly params: Readonly<Record<string, string | number | boolean | null>>;
}

export interface CliCheck {
  readonly id: string;
  readonly state: InspectionState;
}

export interface CliOutcome {
  readonly status: CliStatus;
  readonly result: unknown;
  readonly issues: readonly CliIssue[];
  readonly checksPerformed: readonly CliCheck[];
  /**
   * Set only where the status alone cannot choose the documented exit class —
   * an absent store is a completed read but a refused write.
   */
  readonly exitCode?: number | undefined;
}

export interface CliEnvelope {
  readonly schemaVersion: 1;
  readonly command: string;
  readonly status: CliStatus;
  readonly workspace: {
    readonly requested: string;
    readonly canonical: string;
  };
  readonly store: {
    readonly root: string;
    readonly present: boolean | null;
    readonly state: InspectionState;
  };
  readonly result: unknown;
  readonly issues: readonly CliIssue[];
  readonly checksPerformed: readonly CliCheck[];
}

/**
 * Issue classes for exit codes 5 > 4 > 3. A code outside these tables keeps its
 * own severity, so a new informational issue never silently turns a completed
 * command into a failure.
 */
const EXIT_FIVE = new Set([
  "metadata-missing",
  "metadata-uninitialized",
  "cleanup-failed",
  "store-format-unreadable",
  "store-schema-unexpected",
  "store-needs-recovery",
  "lock-protocol-corrupt",
  "lock-protocol-inconsistent",
  "lock-inspection-failed",
  "io-failure",
]);

const EXIT_FOUR = new Set([
  "store-format-newer",
  "store-format-unsupported",
  "lock-protocol-unsupported",
  "unsupported-filesystem",
  "platform-unsupported",
]);

const EXIT_THREE = new Set([
  "store-metadata-busy",
  "lock-busy",
  "preview-changed",
  "session-unknown",
  "session-history-reset-pending",
  "object-inventory-incomplete",
  "concurrent-change",
  "budget-exceeded",
  "graph-limit",
]);

const DEFAULT_EXIT: Readonly<Record<CliStatus, number>> = {
  ok: 0,
  observational: 0,
  preview: 0,
  applied: 0,
  partial: 3,
  busy: 3,
  blocked: 3,
  unavailable: 3,
  unsupported: 4,
  error: 5,
};

export function severityOfCode(code: string): CliIssueSeverity {
  if (EXIT_FIVE.has(code) || EXIT_FOUR.has(code)) return "error";
  if (EXIT_THREE.has(code)) return "warning";
  return "info";
}

export function cliIssue(
  code: string,
  detail: string,
  params: Readonly<Record<string, string | number | boolean | null>> = {},
  severity: CliIssueSeverity = severityOfCode(code),
): CliIssue {
  return Object.freeze({
    code,
    severity,
    detail,
    params: Object.freeze({ ...params }),
  });
}

/** A maintenance service issue carries no severity; the code class supplies it. */
export function maintenanceIssue(issue: MaintenanceIssue): CliIssue {
  return cliIssue(issue.code, issue.detail);
}

export function storeDiagnosticIssue(issue: StoreDiagnosticIssue): CliIssue {
  return cliIssue(issue.code, issue.detail, issue.params, issue.severity);
}

function classifiedExit(issues: readonly CliIssue[]): number | undefined {
  let highest = 0;
  for (const issue of issues) {
    const code = EXIT_FIVE.has(issue.code)
      ? 5
      : EXIT_FOUR.has(issue.code)
        ? 4
        : EXIT_THREE.has(issue.code)
          ? 3
          : issue.severity === "error"
            ? 5
            : 0;
    if (code > highest) highest = code;
  }
  return highest === 0 ? undefined : highest;
}

/** Exit codes: 0 completed, 3 unstable/incomplete, 4 unsupported, 5 failed. */
export function exitCodeOf(outcome: CliOutcome): number {
  if (classifiedExit(outcome.issues) === 5) return 5;
  if (outcome.exitCode !== undefined) return outcome.exitCode;
  return classifiedExit(outcome.issues) ?? DEFAULT_EXIT[outcome.status];
}

export function buildEnvelope(
  command: string,
  workspace: { readonly requested: string; readonly canonical: string },
  store: { readonly root: string; readonly present: boolean | null },
  storeState: InspectionState,
  outcome: CliOutcome,
): CliEnvelope {
  return Object.freeze({
    schemaVersion: 1 as const,
    command,
    status: outcome.status,
    workspace: Object.freeze({ ...workspace }),
    store: Object.freeze({
      root: store.root,
      present: store.present,
      state: storeState,
    }),
    result: outcome.result,
    issues: Object.freeze([...outcome.issues]),
    checksPerformed: Object.freeze([...outcome.checksPerformed]),
  });
}

/**
 * One JSON document. Byte counts are already decimal strings by construction;
 * bigints that reach this boundary are converted here so no counter can lose
 * precision through a JavaScript number.
 */
export function serializeEnvelope(envelope: CliEnvelope): string {
  return JSON.stringify(
    envelope,
    (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    2,
  );
}
