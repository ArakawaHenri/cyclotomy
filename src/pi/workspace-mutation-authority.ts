import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { CheckpointService } from "../application/checkpoint-service.ts";
import {
  prepareWorkspaceMutationLease,
  type WorkspaceMutationLease,
} from "../application/mutation-lease.ts";
import type { ResolvedNodeState } from "../application/resolve.ts";
import type { RestoreDeps } from "../application/restore.ts";
import type { NodeKey } from "../domain/model.ts";
import {
  assertWorkspaceWriteAuthority,
  type WorkspaceWriteAuthority,
  type WorkspaceLockExecution,
} from "../infrastructure/workspace-lock.ts";
import type { PendingNavigation } from "./navigation-plan.ts";
import type {
  CurrentMetadataStore,
  ProtectLocationResult,
} from "../infrastructure/metadata.ts";
import {
  type ArrivalAdmissionSettlement,
  type ArrivalDisposition,
  type ArrivalProtectionEvidence,
  type LocationProtectionDisposition,
  type NonAdmittedArrivalDisposition,
  unsettledArrival,
} from "./arrival-settlement.ts";
import {
  type AdmissionDecision,
  type AdmissionLease,
  type ArrivalAttempt,
  type CheckpointAdmission,
  type EphemeralArrivalSettlement,
} from "./checkpoint-admission.ts";
import {
  isExactUsableSessionView,
  persistedSessionIdentityOf,
  readPersistedSessionIdentity,
  readSessionView,
  type PersistedSessionIdentity,
  type SessionView,
} from "./session-view.ts";
import type { SessionRegistrationService } from "./session-registration-service.ts";
import type { ArrivalRecoverySettlement } from "./workspace-receipt.ts";

type LocationExpectation =
  | { readonly kind: "any-current" }
  | {
      readonly kind: "exact-resolution";
      readonly resolution: ResolvedNodeState;
    };

type RegisteredLocationInput = Omit<
  Parameters<CurrentMetadataStore["protectLocation"]>[1],
  "expectation"
>;

type ExactSlotProtectionEvidence = Extract<
  ArrivalProtectionEvidence,
  { readonly kind: "exact-slot" }
>;

function exactSlotProtectionEvidence(
  protection: ProtectLocationResult,
  admission: ArrivalAdmissionSettlement,
): ExactSlotProtectionEvidence {
  return {
    kind: "exact-slot",
    slot: protection.protectedSlot,
    expectation: protection.kind === "protected" ? "matched" : "stale",
    admission,
  };
}

type RegistrationAuthority = Pick<
  SessionRegistrationService,
  "registeredAuthority" | "sessionIsUsable" | "assertActiveWorkspaceAuthority"
>;

type MutationAdmission = Pick<
  CheckpointAdmission,
  | "admit"
  | "admitArrival"
  | "arrivalCanProceed"
  | "arrivalCanCommitPlannedTarget"
  | "arrivalIsCurrent"
  | "closeArrival"
  | "cutoverArrivalMutation"
  | "cutoverMutation"
  | "decideCapture"
  | "leaseIsCurrent"
  | "settleProtectedArrival"
  | "reset"
>;

export interface WorkspaceMutationAuthorityOptions {
  readonly admission: MutationAdmission;
  readonly participationIsActive: () => boolean;
  readonly registrations: RegistrationAuthority;
  readonly checkpoints: () => CheckpointService;
  readonly metadata: () => CurrentMetadataStore;
  readonly restoreDeps: () => RestoreDeps;
  readonly workspaceStoreRoot: () => string;
  readonly enqueueWorkspaceExecution: <T>(
    operation: string,
    action: (writeAuthority: WorkspaceWriteAuthority) => Promise<T>,
  ) => Promise<WorkspaceLockExecution<T>>;
}

/**
 * Owns the complete authority protocol around workspace writes.
 *
 * Public Pi snapshots establish location facts; the registration service
 * proves the bound workspace object; metadata pins the checkpoint in one
 * synchronous transaction; and CheckpointAdmission consumes the one-shot
 * in-memory right immediately before the first file syscall. Runtime only
 * wires these capabilities together and serializes the outer workspace lock.
 */
export class WorkspaceMutationAuthority {
  readonly #options: WorkspaceMutationAuthorityOptions;

  constructor(options: WorkspaceMutationAuthorityOptions) {
    this.#options = options;
  }

  restoreDependencies(): RestoreDeps {
    return this.#options.restoreDeps();
  }

  captureAnchor(
    view: SessionView,
    leafId: string | null = view.leafId,
  ): NodeKey | undefined {
    return this.#options.checkpoints().captureAnchor(view, leafId);
  }

  #ancestryIds(view: SessionView, leafId: string | null): readonly string[] {
    return this.#options.checkpoints().ancestryEntryIds(view, leafId);
  }

  #locationIsBlocked(node: NodeKey): boolean {
    return this.#options.checkpoints().locationIsBlocked(node);
  }

  sessionIsUsable(view: SessionView): boolean {
    return this.#options.registrations.sessionIsUsable(view);
  }

  resolutionStillAuthoritative(
    view: SessionView,
    node: NodeKey,
    expected: ResolvedNodeState,
  ): boolean {
    const current = this.#options.checkpoints().resolve(view, node);
    if (current === undefined) return false;
    return (
      current.treeOid === expected.treeOid &&
      current.foundAt.sessionId === expected.foundAt.sessionId &&
      current.foundAt.entryId === expected.foundAt.entryId
    );
  }

  locationIsUnresolved(view: SessionView, node: NodeKey): boolean {
    return this.#options.checkpoints().resolve(view, node) === undefined;
  }

  quarantineAdmission(): void {
    this.#options.admission.reset();
  }

  /**
   * Mint the one-shot lease whose synchronous callback is the final authority
   * boundary immediately before the restore application's first write.
   */
  prepareLocationMutation(
    writeAuthority: WorkspaceWriteAuthority,
    context: ExtensionContext,
    expected: SessionView,
    node: NodeKey,
    resolution: ResolvedNodeState,
  ): WorkspaceMutationLease<ResolvedNodeState> | undefined {
    let current: SessionView;
    try {
      current = readSessionView(context);
      if (
        !isExactUsableSessionView(current, expected, (candidate) =>
          this.sessionIsUsable(candidate),
        ) ||
        !this.resolutionStillAuthoritative(current, node, resolution)
      ) {
        return undefined;
      }
      // Explicit restore authenticates this complete public snapshot at the
      // command boundary. Rebase ephemeral authority to that exact fact; the
      // durable slot is checked and pinned again in the callback below.
      this.#options.admission.admit(current, node);
    } catch {
      return undefined;
    }
    return prepareWorkspaceMutationLease(() => {
      const storeRoot = this.#options.workspaceStoreRoot();
      assertWorkspaceWriteAuthority(writeAuthority, storeRoot);
      const finalView = readSessionView(context);
      if (
        !isExactUsableSessionView(finalView, expected, (candidate) =>
          this.sessionIsUsable(candidate),
        )
      ) {
        throw new Error("active location changed before workspace mutation");
      }
      if (!context.isIdle()) {
        throw new Error("Pi became busy before workspace mutation");
      }
      const protection = this.#protectLocation(
        writeAuthority,
        finalView,
        node,
        {
          kind: "exact-resolution",
          resolution,
        },
      );
      if (protection.kind === "unregistered") {
        throw new Error("workspace registration changed before mutation");
      }
      if (protection.kind === "stale") {
        throw new Error(
          "checkpoint changed while workspace mutation was authorized",
        );
      }
      const pinnedResolution = { treeOid: resolution.treeOid, foundAt: node };
      if (!this.#options.admission.cutoverMutation(finalView, node)) {
        throw new Error("workspace mutation authority changed before cutover");
      }
      return {
        kind: "authorized",
        pinnedResolution,
        writeAuthority,
        storeRoot,
      };
    });
  }

  /** Tree-arrival variant bound to the same opaque one-shot arrival attempt. */
  prepareTreeArrivalMutation(
    writeAuthority: WorkspaceWriteAuthority,
    context: ExtensionContext,
    attempt: ArrivalAttempt,
    expected: SessionView,
    node: NodeKey,
    resolution: ResolvedNodeState,
  ): WorkspaceMutationLease<ResolvedNodeState> | undefined {
    if (!this.#options.admission.arrivalCanProceed(attempt, expected, node)) {
      return undefined;
    }
    return prepareWorkspaceMutationLease(() => {
      const storeRoot = this.#options.workspaceStoreRoot();
      assertWorkspaceWriteAuthority(writeAuthority, storeRoot);
      const finalView = readSessionView(context);
      if (
        !isExactUsableSessionView(finalView, expected, (candidate) =>
          this.sessionIsUsable(candidate),
        )
      ) {
        throw new Error("tree arrival changed before workspace mutation");
      }
      if (!context.isIdle()) {
        throw new Error("Pi became busy before tree workspace mutation");
      }
      const protection = this.#protectLocation(
        writeAuthority,
        finalView,
        node,
        {
          kind: "exact-resolution",
          resolution,
        },
      );
      if (protection.kind === "unregistered") {
        throw new Error("workspace registration changed before tree mutation");
      }
      if (protection.kind === "stale") {
        throw new Error(
          "tree checkpoint changed while workspace mutation was authorized",
        );
      }
      const pinnedResolution = { treeOid: resolution.treeOid, foundAt: node };
      if (
        !this.#options.admission.cutoverArrivalMutation(
          attempt,
          finalView,
          node,
        )
      ) {
        throw new Error("tree mutation authority changed before cutover");
      }
      return {
        kind: "authorized",
        pinnedResolution,
        writeAuthority,
        storeRoot,
      };
    });
  }

  /** Reacquire the cooperative workspace lock and run the same settlement. */
  async recoverUncertainLocation(
    context: ExtensionContext,
  ): Promise<ArrivalRecoverySettlement> {
    return this.#recoverUncertainLocation(context, true);
  }

  /** Durably close the current location without reopening runtime authority. */
  async protectCurrentLocationForRetirement(
    context: ExtensionContext,
  ): Promise<ArrivalRecoverySettlement> {
    return this.#recoverUncertainLocation(context, false);
  }

  async #recoverUncertainLocation(
    context: ExtensionContext,
    restoreAdmission: boolean,
  ): Promise<ArrivalRecoverySettlement> {
    this.quarantineAdmission();
    try {
      const execution = await this.#options.enqueueWorkspaceExecution(
        restoreAdmission
          ? "recover-uncertain-location"
          : "protect-location-for-retirement",
        async (writeAuthority) =>
          this.#recoverUncertainLocationInWorkspaceLock(
            writeAuthority,
            context,
            restoreAdmission,
          ),
      );
      const workspaceLockCleanup = execution.cleanup;
      if (execution.kind === "completed") {
        return {
          arrival: execution.value,
          workspaceLockCleanup,
        };
      }
      this.quarantineAdmission();
      return {
        arrival: unsettledArrival(
          "arrival protection failed after reacquiring the workspace lock",
          [execution.cause],
        ),
        workspaceLockCleanup,
      };
    } catch (cause) {
      this.quarantineAdmission();
      return {
        arrival: unsettledArrival(
          "arrival protection could not reacquire the workspace lock",
          [cause],
        ),
        workspaceLockCleanup: { kind: "settled" },
      };
    }
  }

  /** Settle an uncertain arrival while the caller already owns the lock. */
  recoverUncertainLocationInWorkspaceLock(
    writeAuthority: WorkspaceWriteAuthority,
    context: ExtensionContext,
  ): NonAdmittedArrivalDisposition {
    return this.#recoverUncertainLocationInWorkspaceLock(
      writeAuthority,
      context,
      true,
    );
  }

  #recoverUncertainLocationInWorkspaceLock(
    writeAuthority: WorkspaceWriteAuthority,
    context: ExtensionContext,
    restoreAdmission: boolean,
  ): NonAdmittedArrivalDisposition {
    this.quarantineAdmission();
    let current: SessionView;
    try {
      current = readSessionView(context);
      if (!this.sessionIsUsable(current)) throw new Error("unusable session");
      const node = this.captureAnchor(current);
      if (node === undefined) {
        const identity = persistedSessionIdentityOf(current);
        if (identity === undefined) {
          return unsettledArrival(
            "current arrival has no persisted session identity",
            [new Error("persisted session identity is unavailable")],
          );
        }
        return this.#raiseSessionBarrierByIdentity(writeAuthority, identity)
          ? {
              kind: "protected",
              evidence: {
                kind: "session-barrier",
                admission: { kind: "settled" },
              },
            }
          : unsettledArrival("session barrier could not be raised", [
              new Error("registered session authority is unavailable"),
            ]);
      }
      const protection = this.#protectLocation(writeAuthority, current, node, {
        kind: "any-current",
      });
      if (protection.kind === "unregistered") {
        return unsettledArrival("exact arrival could not be protected", [
          new Error("registered session authority is unavailable"),
        ]);
      }
      if (!restoreAdmission || !this.#options.participationIsActive()) {
        return {
          kind: "protected",
          evidence: exactSlotProtectionEvidence(protection, {
            kind: "settled",
          }),
        };
      }
      // The slot is now durably closed against capture. Recovery keeps the
      // authenticated snapshot live so a still-running engine may leave it or
      // append a genuine descendant. Retirement deliberately skips this step.
      try {
        this.#options.admission.admit(current, node);
        return {
          kind: "protected",
          evidence: exactSlotProtectionEvidence(protection, {
            kind: "settled",
          }),
        };
      } catch (secondaryFailure) {
        // The metadata transaction is authoritative even when rebuilding the
        // replaceable in-memory admission state fails. Never downgrade this
        // exact durable fact to a weaker barrier or unavailable settlement.
        return {
          kind: "protected",
          evidence: exactSlotProtectionEvidence(protection, {
            kind: "failed",
            cause: secondaryFailure,
          }),
        };
      }
    } catch (primary) {
      try {
        const identity = readPersistedSessionIdentity(context);
        return this.#raiseSessionBarrierByIdentity(writeAuthority, identity)
          ? {
              kind: "protected",
              evidence: {
                kind: "session-barrier",
                admission: { kind: "settled" },
              },
            }
          : unsettledArrival("session barrier could not be raised", [
              primary,
              new Error("registered session authority is unavailable"),
            ]);
      } catch (secondary) {
        return unsettledArrival("arrival recovery failed", [
          primary,
          secondary,
        ]);
      }
    }
  }

  #raiseSessionBarrier(
    writeAuthority: WorkspaceWriteAuthority,
    view: SessionView,
  ): boolean {
    const identity = persistedSessionIdentityOf(view);
    return (
      identity !== undefined &&
      this.#raiseSessionBarrierByIdentity(writeAuthority, identity)
    );
  }

  #raiseSessionBarrierByIdentity(
    writeAuthority: WorkspaceWriteAuthority,
    identity: PersistedSessionIdentity,
  ): boolean {
    try {
      this.#options.registrations.assertActiveWorkspaceAuthority(identity);
    } catch {
      return false;
    }
    const metadata = this.#options.metadata();
    const input = {
      sessionId: identity.sessionId,
      sessionFile: identity.sessionFile,
    };
    return metadata.raiseSessionBarrier(writeAuthority, input);
  }

  sessionHasBarrier(view: SessionView): boolean | undefined {
    return view.sessionFile === null
      ? undefined
      : this.#options.metadata().hasSessionBarrier({
          sessionId: view.sessionId,
          sessionFile: view.sessionFile,
        });
  }

  reconcileSessionBarrier(
    writeAuthority: WorkspaceWriteAuthority,
    view: SessionView,
    node: NodeKey,
  ): "reconciled" | "absent" | "unregistered" {
    const identity = persistedSessionIdentityOf(view);
    if (identity === undefined) return "unregistered";
    try {
      this.#options.registrations.assertActiveWorkspaceAuthority(identity);
    } catch {
      return "unregistered";
    }
    const current = this.captureAnchor(view);
    if (
      current === undefined ||
      current.sessionId !== node.sessionId ||
      current.entryId !== node.entryId
    ) {
      return "absent";
    }
    const metadata = this.#options.metadata();
    const metadataIdentity = {
      sessionId: view.sessionId,
      sessionFile: identity.sessionFile,
    };
    const ancestry = this.#ancestryIds(view, node.entryId);
    const result = metadata.reconcileSessionBarrier(
      writeAuthority,
      metadataIdentity,
      ancestry,
    );
    if (result === "unregistered") this.quarantineAdmission();
    return result;
  }

  admitCurrentLocation(view: SessionView): boolean {
    const node = this.captureAnchor(view);
    if (
      (node !== undefined && this.#locationIsBlocked(node)) ||
      this.sessionHasBarrier(view) !== false
    ) {
      return false;
    }
    this.#options.admission.admit(view, node);
    return true;
  }

  admitLocationIfResolution(
    writeAuthority: WorkspaceWriteAuthority,
    view: SessionView,
    resolution: ResolvedNodeState,
  ): boolean {
    const node = this.captureAnchor(view);
    if (
      node === undefined ||
      !this.#admitResolvedLocation(writeAuthority, view, node, resolution)
    ) {
      return false;
    }
    this.#options.admission.admit(view, node);
    return true;
  }

  admitCurrentTreeArrival(
    writeAuthority: WorkspaceWriteAuthority,
    attempt: ArrivalAttempt,
    view: SessionView,
  ): ArrivalDisposition {
    const node = this.captureAnchor(view);
    if (!this.#options.admission.arrivalCanProceed(attempt, view, node)) {
      this.#options.admission.closeArrival(attempt);
      return {
        kind: "unsettled",
        cause: new Error("tree arrival no longer matches its source"),
      };
    }
    if (
      this.sessionHasBarrier(view) !== false ||
      (node !== undefined && this.#locationIsBlocked(node))
    ) {
      return this.#protectTreeArrival(writeAuthority, attempt, view, {
        kind: "any-current",
      });
    }
    return this.#options.admission.admitArrival(attempt, view, node)
      ? { kind: "admitted" }
      : {
          kind: "unsettled",
          cause: new Error("tree arrival could not be admitted"),
        };
  }

  admitTreeArrivalIfResolution(
    writeAuthority: WorkspaceWriteAuthority,
    attempt: ArrivalAttempt,
    view: SessionView,
    resolution: ResolvedNodeState,
  ): ArrivalDisposition {
    const node = this.captureAnchor(view);
    if (
      node === undefined ||
      !this.#options.admission.arrivalCanProceed(attempt, view, node)
    ) {
      this.#options.admission.closeArrival(attempt);
      return {
        kind: "unsettled",
        cause: new Error("tree arrival no longer matches its target"),
      };
    }
    if (!this.#admitResolvedLocation(writeAuthority, view, node, resolution)) {
      return this.#protectTreeArrival(writeAuthority, attempt, view, {
        kind: "exact-resolution",
        resolution,
      });
    }
    if (this.#options.admission.admitArrival(attempt, view, node)) {
      return { kind: "admitted" };
    }
    // Metadata admission may have reopened an exact pin before the replaceable
    // arrival token became stale. Close the coordinate again and preserve the
    // durable fact even though this attempt can no longer be settled.
    return this.#protectNodeAfterArrivalSettlementFailure(
      writeAuthority,
      view,
      node,
    );
  }

  protectCurrentTreeArrival(
    writeAuthority: WorkspaceWriteAuthority,
    attempt: ArrivalAttempt,
    view: SessionView,
  ): ArrivalDisposition {
    return this.#protectTreeArrival(writeAuthority, attempt, view, {
      kind: "any-current",
    });
  }

  protectTreeArrivalIfResolution(
    writeAuthority: WorkspaceWriteAuthority,
    attempt: ArrivalAttempt,
    view: SessionView,
    resolution: ResolvedNodeState,
  ): ArrivalDisposition {
    return this.#protectTreeArrival(writeAuthority, attempt, view, {
      kind: "exact-resolution",
      resolution,
    });
  }

  protectCurrentNode(
    writeAuthority: WorkspaceWriteAuthority,
    view: SessionView,
    node: NodeKey,
  ): LocationProtectionDisposition {
    return this.#protectNode(writeAuthority, view, node, {
      kind: "any-current",
    });
  }

  protectNodeIfResolution(
    writeAuthority: WorkspaceWriteAuthority,
    view: SessionView,
    node: NodeKey,
    resolution: ResolvedNodeState,
  ): LocationProtectionDisposition {
    return this.#protectNode(writeAuthority, view, node, {
      kind: "exact-resolution",
      resolution,
    });
  }

  captureAdmission(
    writeAuthority: WorkspaceWriteAuthority,
    view: SessionView,
    node: NodeKey | undefined,
  ): AdmissionDecision {
    if (node !== undefined) {
      const reconciled = this.reconcileSessionBarrier(
        writeAuthority,
        view,
        node,
      );
      if (reconciled === "reconciled") {
        this.#options.admission.admit(view, node);
        return { kind: "write-protected" };
      }
      if (reconciled === "unregistered") return { kind: "not-admitted" };
    }
    const writeProtected = node !== undefined && this.#locationIsBlocked(node);
    const decision = this.#options.admission.decideCapture({
      view,
      node,
      writeProtected,
    });
    if (decision.kind === "not-admitted" && node !== undefined) {
      this.protectCurrentNode(writeAuthority, view, node);
    }
    return decision;
  }

  captureLeaseIsCurrent(
    lease: AdmissionLease,
    view: SessionView,
    node: NodeKey,
  ): boolean {
    return (
      this.#options.admission.leaseIsCurrent(lease, view, node) &&
      !this.#locationIsBlocked(node)
    );
  }

  treeArrivalCanProceed(
    attempt: ArrivalAttempt<PendingNavigation | undefined>,
    view: SessionView,
    node: NodeKey,
  ): boolean {
    return (
      this.#options.admission.arrivalCanProceed(attempt, view, node) ||
      this.#options.admission.arrivalCanCommitPlannedTarget(attempt, view, node)
    );
  }

  /**
   * Build one terminal metadata input after synchronously revalidating the
   * registered workspace binding. Callers consume it immediately and never
   * retain it or cross an asynchronous boundary before the metadata command.
   */
  #registeredLocationInput(
    view: SessionView,
    node: NodeKey,
  ): RegisteredLocationInput | undefined {
    const identity = persistedSessionIdentityOf(view);
    if (identity === undefined) return undefined;
    try {
      this.#options.registrations.assertActiveWorkspaceAuthority(identity);
    } catch {
      return undefined;
    }
    return {
      identity: {
        sessionId: node.sessionId,
        sessionFile: identity.sessionFile,
      },
      entryId: node.entryId,
      activeAncestryEntryIds: this.#ancestryIds(view, node.entryId),
    };
  }

  #admitResolvedLocation(
    writeAuthority: WorkspaceWriteAuthority,
    view: SessionView,
    node: NodeKey,
    resolution: ResolvedNodeState,
  ): boolean {
    const location = this.#registeredLocationInput(view, node);
    if (location === undefined) return false;
    const input: Parameters<CurrentMetadataStore["admitResolvedLocation"]>[1] =
      {
        ...location,
        expectedResolution: {
          kind: "checkpoint" as const,
          entryId: resolution.foundAt.entryId,
          treeOid: resolution.treeOid,
        },
      };
    return (
      this.#options.metadata().admitResolvedLocation(writeAuthority, input) !==
      "slot-changed"
    );
  }

  #protectTreeArrival(
    writeAuthority: WorkspaceWriteAuthority,
    attempt: ArrivalAttempt,
    view: SessionView,
    expectation: LocationExpectation,
  ): ArrivalDisposition {
    let node: NodeKey | undefined;
    try {
      if (!this.#options.admission.arrivalIsCurrent(attempt)) {
        return {
          kind: "unsettled",
          cause: new Error("tree arrival authority is stale"),
        };
      }
      node = this.captureAnchor(view);
    } catch (cause) {
      return {
        kind: "unsettled",
        cause,
      };
    }
    if (node === undefined) {
      let raised: boolean;
      try {
        raised = this.#raiseSessionBarrier(writeAuthority, view);
      } catch (cause) {
        return { kind: "unsettled", cause };
      }
      if (!raised) {
        return {
          kind: "unsettled",
          cause: new Error("session capture barrier could not be raised"),
        };
      }
      const settlement = this.#settleProtectedArrival(attempt, view, node);
      return {
        kind: "protected",
        evidence: {
          kind: "session-barrier",
          admission: this.#arrivalAdmissionSettlement(settlement),
        },
      };
    }
    let protection: ProtectLocationResult | { readonly kind: "unregistered" };
    try {
      protection = this.#protectLocation(
        writeAuthority,
        view,
        node,
        expectation,
      );
    } catch (cause) {
      return { kind: "unsettled", cause };
    }
    if (protection.kind === "unregistered") {
      return {
        kind: "unsettled",
        cause: new Error("registered session authority is unavailable"),
      };
    }
    const settlement = this.#settleProtectedArrival(attempt, view, node);
    return {
      kind: "protected",
      evidence: exactSlotProtectionEvidence(
        protection,
        this.#arrivalAdmissionSettlement(settlement),
      ),
    };
  }

  #protectNode(
    writeAuthority: WorkspaceWriteAuthority,
    view: SessionView,
    node: NodeKey,
    expectation: LocationExpectation,
  ): LocationProtectionDisposition {
    let protection: ProtectLocationResult | { readonly kind: "unregistered" };
    try {
      protection = this.#protectLocation(
        writeAuthority,
        view,
        node,
        expectation,
      );
    } catch (cause) {
      return { kind: "unsettled", cause };
    }
    if (protection.kind === "unregistered") {
      return {
        kind: "unsettled",
        cause: new Error("registered session authority is unavailable"),
      };
    }
    let admission: ArrivalAdmissionSettlement;
    try {
      this.#options.admission.admit(view, node);
      admission = { kind: "settled" };
    } catch (cause) {
      admission = { kind: "failed", cause };
    }
    return {
      kind: "protected",
      evidence: exactSlotProtectionEvidence(protection, admission),
    };
  }

  #protectNodeAfterArrivalSettlementFailure(
    writeAuthority: WorkspaceWriteAuthority,
    view: SessionView,
    node: NodeKey,
  ): ArrivalDisposition {
    let protection: ProtectLocationResult | { readonly kind: "unregistered" };
    try {
      protection = this.#protectLocation(writeAuthority, view, node, {
        kind: "any-current",
      });
    } catch (cause) {
      return { kind: "unsettled", cause };
    }
    if (protection.kind === "unregistered") {
      return {
        kind: "unsettled",
        cause: new Error(
          "tree arrival admission failed and the coordinate could not be protected",
        ),
      };
    }
    return {
      kind: "protected",
      evidence: {
        kind: "exact-slot",
        slot: protection.protectedSlot,
        expectation: "matched",
        admission: {
          kind: "failed",
          cause: new Error("tree arrival could not be admitted"),
        },
      },
    };
  }

  #arrivalAdmissionSettlement(
    settlement: EphemeralArrivalSettlement,
  ): ArrivalAdmissionSettlement {
    return settlement.kind === "settled"
      ? settlement
      : { kind: "failed", cause: settlement.cause };
  }

  #settleProtectedArrival(
    attempt: ArrivalAttempt,
    view: SessionView,
    node: NodeKey | undefined,
  ): EphemeralArrivalSettlement {
    try {
      return this.#options.admission.settleProtectedArrival(
        attempt,
        view,
        node,
      );
    } catch (cause) {
      return { kind: "unsettled", cause };
    }
  }

  #protectLocation(
    writeAuthority: WorkspaceWriteAuthority,
    view: SessionView,
    node: NodeKey,
    expectation: LocationExpectation,
  ): ProtectLocationResult | { readonly kind: "unregistered" } {
    const location = this.#registeredLocationInput(view, node);
    if (location === undefined) return { kind: "unregistered" };
    const input: Parameters<CurrentMetadataStore["protectLocation"]>[1] = {
      ...location,
      expectation:
        expectation.kind === "any-current"
          ? expectation
          : {
              kind: "exact-resolution",
              resolution: {
                kind: "checkpoint",
                entryId: expectation.resolution.foundAt.entryId,
                treeOid: expectation.resolution.treeOid,
              },
            },
    };
    return this.#options.metadata().protectLocation(writeAuthority, input);
  }
}
