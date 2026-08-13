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
      /** Keep live files detached from the destination's effective state. */
      readonly kind: "detach";
      readonly node: NodeKey;
      readonly resolution: ResolvedNodeState;
    }
  | {
      /** Source capture is the destination's nearest inherited checkpoint. */
      readonly kind: "inherit-source";
      readonly node: NodeKey;
      readonly resolution: ResolvedNodeState;
    }
  | {
      /** Pi stayed on the same stable anchor or created a wrapper below it. */
      readonly kind: "same-location";
      readonly node: NodeKey;
    }
  | { readonly kind: "materialize-missing"; readonly node: NodeKey }
  | { readonly kind: "protected-missing"; readonly node: NodeKey }
  | { readonly kind: "no-node" };

export interface PendingNavigation {
  readonly sessionId: string;
  readonly cwd: string;
  readonly expectedOldLeafId: string | null;
  /** Pi's effective selected landing before an optional summary wrapper. */
  readonly expectedDestinationId: string | null;
  /** Present only when arrival must authenticate a restore/inheritance preview. */
  readonly previewSnapshot: WorkspaceSnapshot | undefined;
  readonly target: NavigationTargetPlan;
}
