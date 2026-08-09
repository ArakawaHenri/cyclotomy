import type { CaptureSuccess } from "../application/capture.ts";
import type { ResolvedNodeState } from "../application/resolve.ts";
import type { NodeKey } from "../domain/model.ts";
import type { WorkspaceSnapshot } from "../infrastructure/workspace-scan.ts";

export type NavigationTargetPlan =
  | {
      readonly kind: "restore";
      readonly node: NodeKey;
      readonly resolution: ResolvedNodeState;
    }
  | {
      /** Source capture is the destination's nearest inherited checkpoint. */
      readonly kind: "inherit-source";
      readonly node: NodeKey;
      readonly resolution: ResolvedNodeState;
    }
  | { readonly kind: "materialize-missing"; readonly node: NodeKey }
  | { readonly kind: "no-node" };

export interface PendingNavigation {
  readonly sessionId: string;
  readonly cwd: string;
  readonly expectedOldLeafId: string | null;
  /** Pi's effective selected landing before an optional summary wrapper. */
  readonly expectedDestinationId: string | null;
  readonly previewSnapshot: WorkspaceSnapshot;
  readonly target: NavigationTargetPlan;
}

export interface PendingSourceCapture {
  readonly source: NodeKey;
  readonly prepared: CaptureSuccess;
  /** Exact source slot seen while the candidate was prepared. */
  readonly expectedTreeOid: string | undefined;
}

export type TransitionKind =
  "input" | "tree" | "compaction" | "fork" | "switch";

/**
 * Short-lived plans that bridge Pi before/after events. This is deliberately
 * in-memory: an unplanned arrival must fail closed instead of being replayed.
 */
export class TransitionState {
  #navigation: PendingNavigation | undefined;
  #preparing: TransitionKind | undefined;

  setNavigation(value: PendingNavigation | undefined): void {
    this.#navigation = value;
  }

  takeNavigation(): PendingNavigation | undefined {
    const value = this.#navigation;
    this.#navigation = undefined;
    return value;
  }

  /**
   * Pi has no post-cancel event when a later extension vetoes a before hook.
   * A navigation plan left behind while no preparation is active is therefore
   * known to be orphaned. Its source was already committed in before_tree, so
   * retiring it is safe and must not force another user-visible cancellation.
   */
  rejectConflict(): boolean {
    if (this.#preparing === undefined) {
      this.#navigation = undefined;
      return false;
    }
    return true;
  }

  tryBegin(kind: TransitionKind): boolean {
    if (this.rejectConflict()) return false;
    this.#preparing = kind;
    return true;
  }

  finish(kind: TransitionKind): void {
    if (this.#preparing === kind) this.#preparing = undefined;
  }

  reset(): void {
    this.#navigation = undefined;
    this.#preparing = undefined;
  }
}
