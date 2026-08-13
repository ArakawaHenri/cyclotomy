import {
  commitPreparedMissingNodeState,
  commitPreparedNodeState,
  prepareNodeState,
  prepareObservedNodeState,
  type CaptureCommitDeps,
  type CaptureDeps,
  type CaptureFailure,
  type CaptureSuccess,
  type MissingNodeStateIntent,
} from "./capture.ts";
import type { ResolvedNodeState } from "./resolve.ts";
import {
  checkpointSlotIsBlocked,
  type CheckpointSlot,
} from "../domain/checkpoint-slot.ts";
import type { NodeKey, Result, TreeOid } from "../domain/model.ts";
import type { CurrentMetadataStore } from "../infrastructure/metadata.ts";
import type { NativeObjectStore } from "../infrastructure/object-store.ts";
import type { TreeManifest } from "../infrastructure/tree-formats/manifest-codec.ts";
import type {
  ScanOptions,
  WorkspaceSnapshot,
} from "../infrastructure/workspace-scan.ts";

/** The authenticated host facts checkpoint logic needs; no raw Pi entry leaks. */
export interface CheckpointSessionView {
  readonly sessionId: string;
  readonly cwd: string;
  readonly leafId: string | null;
  stableCoordinateId(entryId?: string | null): string | null | undefined;
  stableAncestryIds(entryId?: string | null): readonly string[] | undefined;
}

export interface ResolvedReadableTree {
  readonly resolution: ResolvedNodeState;
  readonly manifest: TreeManifest;
}

export interface CheckpointCommitAuthority {
  readonly expectedSessionFile: string;
  readonly assertWorkspaceAuthority: () => undefined;
}

export interface CheckpointServiceOptions {
  readonly store: NativeObjectStore;
  readonly metadata: CurrentMetadataStore;
  readonly expectedRootPath: string;
  readonly scanOptions?: ScanOptions;
  readonly validateManifestScope: (
    treeOid: TreeOid,
    manifest: TreeManifest,
  ) => Promise<void>;
}

/**
 * The single application owner of checkpoint coordinates, inheritance,
 * capture, and readable-tree authentication. The host adapter authenticates
 * the graph; metadata owns the transactional lineage snapshot.
 */
export class CheckpointService {
  readonly #options: CheckpointServiceOptions;

  constructor(options: CheckpointServiceOptions) {
    this.#options = options;
  }

  captureAnchor(
    view: CheckpointSessionView,
    leafId: string | null = view.leafId,
  ): NodeKey | undefined {
    const entryId = view.stableCoordinateId(leafId);
    if (entryId === undefined) {
      throw new Error(
        `authenticated session view has no stable coordinate for ${JSON.stringify(leafId)}`,
      );
    }
    return entryId === null
      ? undefined
      : { sessionId: view.sessionId, entryId };
  }

  ancestryEntryIds(
    view: CheckpointSessionView,
    leafId: string | null,
  ): readonly string[] {
    const ancestry = view.stableAncestryIds(leafId);
    if (ancestry === undefined) {
      throw new Error(
        `authenticated session view has no stable ancestry for ${JSON.stringify(leafId)}`,
      );
    }
    return ancestry;
  }

  checkpointSlot(node: NodeKey): CheckpointSlot {
    return this.#options.metadata.getCheckpointSlot(
      node.sessionId,
      node.entryId,
    );
  }

  locationIsBlocked(node: NodeKey): boolean {
    return checkpointSlotIsBlocked(this.checkpointSlot(node));
  }

  resolve(
    view: CheckpointSessionView,
    node: NodeKey,
  ): ResolvedNodeState | undefined {
    this.#assertSession(view, node);
    const reduced = this.#options.metadata.resolveLineage(
      node.sessionId,
      this.ancestryEntryIds(view, node.entryId),
    );
    return reduced.resolution.kind === "missing"
      ? undefined
      : {
          treeOid: reduced.resolution.treeOid,
          foundAt: {
            sessionId: node.sessionId,
            entryId: reduced.resolution.entryId,
          },
        };
  }

  async resolveReadableTree(
    view: CheckpointSessionView,
    node: NodeKey,
  ): Promise<ResolvedReadableTree | undefined> {
    const resolution = this.resolve(view, node);
    if (resolution === undefined) return undefined;
    const manifest = await this.#options.store.readTree(resolution.treeOid);
    await this.#options.validateManifestScope(resolution.treeOid, manifest);
    return { resolution, manifest };
  }

  /** Scan and publish the service's current workspace policy. */
  prepareCurrent(
    view: CheckpointSessionView,
  ): Promise<Result<CaptureSuccess, CaptureFailure>> {
    return prepareNodeState(this.#captureDeps(), view.cwd);
  }

  /** Publish an already authenticated workspace observation without metadata. */
  prepareObserved(
    snapshot: WorkspaceSnapshot,
  ): Promise<Result<CaptureSuccess, CaptureFailure>> {
    return prepareObservedNodeState(this.#captureDeps(), snapshot);
  }

  /** Commit one prepared tree at an authenticated active-path coordinate. */
  commitPrepared(
    view: CheckpointSessionView,
    node: NodeKey,
    prepared: CaptureSuccess,
    expectedSlot: CheckpointSlot,
    authority: CheckpointCommitAuthority,
  ): Result<CaptureSuccess, CaptureFailure> {
    this.#assertActiveCoordinate(view, node);
    return this.#commitPrepared(view, node, prepared, expectedSlot, authority);
  }

  /**
   * Commit a coordinate authenticated by Pi's tree-arrival protocol.
   * Summary and label wrappers may make the logical destination an ancestor
   * of the final raw leaf, so this deliberately accepts only that active path.
   */
  commitPreparedTreeArrival(
    view: CheckpointSessionView,
    node: NodeKey,
    prepared: CaptureSuccess,
    expectedSlot: CheckpointSlot,
    authority: CheckpointCommitAuthority,
  ): Result<CaptureSuccess, CaptureFailure> {
    this.#assertActiveAncestryCoordinate(view, node);
    return this.#commitPrepared(view, node, prepared, expectedSlot, authority);
  }

  #commitPrepared(
    view: CheckpointSessionView,
    node: NodeKey,
    prepared: CaptureSuccess,
    expectedSlot: CheckpointSlot,
    authority: CheckpointCommitAuthority,
  ): Result<CaptureSuccess, CaptureFailure> {
    return commitPreparedNodeState(
      this.#commitDeps(authority),
      node,
      prepared,
      {
        activeAncestryEntryIds: this.ancestryEntryIds(view, node.entryId),
        expectedSlot,
      },
    );
  }

  /** Materialize a prepared tree at an authenticated missing coordinate. */
  commitMissing(
    view: CheckpointSessionView,
    node: NodeKey,
    prepared: CaptureSuccess,
    intent: MissingNodeStateIntent,
    authority: CheckpointCommitAuthority,
  ): Result<CaptureSuccess, CaptureFailure> {
    this.#assertActiveCoordinate(view, node);
    return commitPreparedMissingNodeState(
      this.#commitDeps(authority),
      node,
      prepared,
      intent,
      { activeAncestryEntryIds: this.ancestryEntryIds(view, node.entryId) },
    );
  }

  #captureDeps(): CaptureDeps {
    return {
      store: this.#options.store,
      ...(this.#options.scanOptions === undefined
        ? {}
        : { scanOptions: this.#options.scanOptions }),
      expectedRootPath: this.#options.expectedRootPath,
    };
  }

  #commitDeps(authority: CheckpointCommitAuthority): CaptureCommitDeps {
    return {
      ...this.#captureDeps(),
      metadata: this.#options.metadata,
      expectedSessionFile: authority.expectedSessionFile,
      assertWorkspaceAuthority: authority.assertWorkspaceAuthority,
    };
  }

  #assertSession(view: CheckpointSessionView, node: NodeKey): void {
    if (node.sessionId !== view.sessionId) {
      throw new Error("checkpoint coordinate belongs to another session");
    }
  }

  #assertActiveCoordinate(view: CheckpointSessionView, node: NodeKey): void {
    this.#assertSession(view, node);
    const active = this.captureAnchor(view);
    if (active === undefined || active.entryId !== node.entryId) {
      throw new Error("capture target is not the active stable coordinate");
    }
  }

  #assertActiveAncestryCoordinate(
    view: CheckpointSessionView,
    node: NodeKey,
  ): void {
    this.#assertSession(view, node);
    const ancestry = this.ancestryEntryIds(view, view.leafId);
    if (!ancestry.includes(node.entryId)) {
      throw new Error(
        "tree-arrival capture target is not on the active stable ancestry",
      );
    }
  }
}
