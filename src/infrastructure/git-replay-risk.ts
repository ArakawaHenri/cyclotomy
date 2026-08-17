import type { WorkspaceScope } from "./workspace-scope.ts";

/** The external Git evaluator that authenticated one archived-policy replay. */
export interface GitReplayAttestation {
  readonly gitVersion: string | null;
}

/**
 * Restore-time uncertainty caused by replaying durable Git policy with an
 * evaluator whose provenance is absent or differs from capture.
 */
export type GitReplayRisk =
  | { readonly kind: "none" }
  | {
      readonly kind: "legacy-unattested";
      readonly currentGitVersion: string | null;
    }
  | {
      readonly kind: "version-mismatch";
      readonly capturedGitVersion: string;
      readonly currentGitVersion: string | null;
    };

const NO_GIT_REPLAY_RISK = Object.freeze({ kind: "none" } as const);

export function gitReplayRisk(
  scope: WorkspaceScope,
  currentGitVersion: string | null,
): GitReplayRisk {
  if (scope.kind === "all-managed") return NO_GIT_REPLAY_RISK;
  if (scope.evaluator === null) {
    return { kind: "legacy-unattested", currentGitVersion };
  }
  if (scope.evaluator.version !== currentGitVersion) {
    return {
      kind: "version-mismatch",
      capturedGitVersion: scope.evaluator.version,
      currentGitVersion,
    };
  }
  return NO_GIT_REPLAY_RISK;
}

/** Exact equality binds validation, preview, confirmation, and cutover. */
export function sameGitOracleVersion(
  left: string | null,
  right: string | null,
): boolean {
  return left === right;
}
