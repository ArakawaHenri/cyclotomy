import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { CheckpointService } from "../application/checkpoint-service.ts";
import {
  prepareWorkspaceMutationLease,
  type WorkspaceMutationLease,
} from "../application/mutation-lease.ts";
import type { ResolvedNodeState } from "../application/resolve.ts";
import type { RestoreDeps } from "../application/restore.ts";
import type { NodeKey } from "../domain/model.ts";
import type { WorkspaceLockExecution } from "../infrastructure/workspace-lock.ts";
import type { PendingNavigation } from "./navigation-plan.ts";
import type {
  CurrentMetadataStore,
  ProtectLocationResult,
} from "../infrastructure/metadata.ts";
import {
  type ArrivalProtection,
  unavailableProtection,
} from "./arrival-protection.ts";
import {
  type ArrivalAdmissionSettlement,
  type ArrivalDisposition,
  type LocationProtectionDisposition,
} from "./arrival-settlement.ts";
import {
  type AdmissionDecision,
  type AdmissionLease,
  type ArrivalAttempt,
  type CheckpointAdmission,
  type EphemeralArrivalSettlement,
} from "./checkpoint-admission.ts";
import {
  persistedSessionIdentityOf,
  readPersistedSessionIdentity,
  readSessionView,
  type PersistedSessionIdentity,
  type SessionView,
} from "./session-view.ts";
import type { SessionRegistrationService } from "./session-registration-service.ts";
import type { ArrivalRecoveryExecution } from "./post-mutation.ts";

type LocationExpectation =
  | { readonly kind: "any-current" }
  | {
      readonly kind: "exact-resolution";
      readonly resolution: ResolvedNodeState;
    };

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
  readonly registrations: RegistrationAuthority;
  readonly checkpoints: () => CheckpointService;
  readonly metadata: () => CurrentMetadataStore;
  readonly restoreDeps: () => RestoreDeps;
  readonly enqueueWorkspaceExecution: <T>(
    operation: string,
    action: () => Promise<T>,
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
    context: ExtensionContext,
    expected: SessionView,
    node: NodeKey,
    resolution: ResolvedNodeState,
  ): WorkspaceMutationLease<ResolvedNodeState> | undefined {
    let current: SessionView;
    try {
      current = readSessionView(context);
      if (
        !this.sessionIsUsable(current) ||
        !current.isSameSnapshotAs(expected) ||
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
      const finalView = readSessionView(context);
      if (
        !this.sessionIsUsable(finalView) ||
        !finalView.isSameSnapshotAs(expected)
      ) {
        throw new Error("active location changed before workspace mutation");
      }
      if (!context.isIdle()) {
        throw new Error("Pi became busy before workspace mutation");
      }
      const protection = this.#protectLocation(finalView, node, {
        kind: "exact-resolution",
        resolution,
      });
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
      };
    });
  }

  /** Tree-arrival variant bound to the same opaque one-shot arrival attempt. */
  prepareTreeArrivalMutation(
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
      const finalView = readSessionView(context);
      if (
        !this.sessionIsUsable(finalView) ||
        !finalView.isSameSnapshotAs(expected)
      ) {
        throw new Error("tree arrival changed before workspace mutation");
      }
      if (!context.isIdle()) {
        throw new Error("Pi became busy before tree workspace mutation");
      }
      const protection = this.#protectLocation(finalView, node, {
        kind: "exact-resolution",
        resolution,
      });
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
      };
    });
  }

  /** Reacquire the cooperative workspace lock and run the same settlement. */
  async recoverUncertainLocation(
    context: ExtensionContext,
  ): Promise<ArrivalRecoveryExecution> {
    this.quarantineAdmission();
    try {
      const execution = await this.#options.enqueueWorkspaceExecution(
        "recover-uncertain-location",
        async () => this.recoverUncertainLocationInWorkspaceLock(context),
      );
      const workspaceLockCleanup =
        execution.cleanup.kind === "failed"
          ? { kind: "failed" as const, cause: execution.cleanup.cause }
          : { kind: "settled" as const };
      if (execution.kind === "completed") {
        return {
          protection: execution.value,
          workspaceLockCleanup,
        };
      }
      this.quarantineAdmission();
      return {
        protection: unavailableProtection(
          "arrival protection failed after reacquiring the workspace lock",
          [execution.cause],
        ),
        workspaceLockCleanup,
      };
    } catch (cause) {
      this.quarantineAdmission();
      return {
        protection: unavailableProtection(
          "arrival protection could not reacquire the workspace lock",
          [cause],
        ),
        workspaceLockCleanup: { kind: "settled" },
      };
    }
  }

  /** Settle an uncertain arrival while the caller already owns the lock. */
  recoverUncertainLocationInWorkspaceLock(
    context: ExtensionContext,
  ): ArrivalProtection {
    this.quarantineAdmission();
    let current: SessionView;
    try {
      current = readSessionView(context);
      if (!this.sessionIsUsable(current)) throw new Error("unusable session");
      const node = this.captureAnchor(current);
      if (node === undefined) {
        const identity = persistedSessionIdentityOf(current);
        if (identity === undefined) {
          return unavailableProtection(
            "current arrival has no persisted session identity",
            [new Error("persisted session identity is unavailable")],
          );
        }
        return this.#raiseSessionBarrierByIdentity(identity)
          ? { kind: "session-barrier" }
          : unavailableProtection("session barrier could not be raised", [
              new Error("registered session authority is unavailable"),
            ]);
      }
      const protection = this.#protectLocation(current, node, {
        kind: "any-current",
      });
      if (protection.kind === "unregistered") {
        return unavailableProtection("exact arrival could not be protected", [
          new Error("registered session authority is unavailable"),
        ]);
      }
      // The slot is now durably closed against capture. Keep the authenticated
      // snapshot live so the user may leave it or append a genuine descendant.
      try {
        this.#options.admission.admit(current, node);
        return {
          kind: "exact-slot",
          slot: protection.protectedSlot,
          admission: { kind: "settled" },
        };
      } catch (secondaryFailure) {
        // The metadata transaction is authoritative even when rebuilding the
        // replaceable in-memory admission state fails. Never downgrade this
        // exact durable fact to a weaker barrier or unavailable settlement.
        return {
          kind: "exact-slot",
          slot: protection.protectedSlot,
          admission: { kind: "failed", cause: secondaryFailure },
        };
      }
    } catch (primary) {
      try {
        const identity = readPersistedSessionIdentity(context);
        return this.#raiseSessionBarrierByIdentity(identity)
          ? { kind: "session-barrier" }
          : unavailableProtection("session barrier could not be raised", [
              primary,
              new Error("registered session authority is unavailable"),
            ]);
      } catch (secondary) {
        return unavailableProtection("arrival recovery failed", [
          primary,
          secondary,
        ]);
      }
    }
  }

  #raiseSessionBarrier(view: SessionView): boolean {
    const identity = persistedSessionIdentityOf(view);
    return (
      identity !== undefined && this.#raiseSessionBarrierByIdentity(identity)
    );
  }

  #raiseSessionBarrierByIdentity(identity: PersistedSessionIdentity): boolean {
    try {
      this.#options.registrations.assertActiveWorkspaceAuthority(identity);
    } catch {
      return false;
    }
    return this.#options.metadata().raiseSessionBarrier({
      sessionId: identity.sessionId,
      sessionFile: identity.sessionFile,
    });
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
    const result = this.#options
      .metadata()
      .reconcileSessionBarrier(
        { sessionId: view.sessionId, sessionFile: identity.sessionFile },
        this.#ancestryIds(view, node.entryId),
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
    view: SessionView,
    resolution: ResolvedNodeState,
  ): boolean {
    const node = this.captureAnchor(view);
    if (
      node === undefined ||
      !this.#admitResolvedLocation(view, node, resolution)
    ) {
      return false;
    }
    this.#options.admission.admit(view, node);
    return true;
  }

  admitCurrentTreeArrival(
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
      return this.#protectTreeArrival(attempt, view, { kind: "any-current" });
    }
    return this.#options.admission.admitArrival(attempt, view, node)
      ? { kind: "admitted" }
      : {
          kind: "unsettled",
          cause: new Error("tree arrival could not be admitted"),
        };
  }

  admitTreeArrivalIfResolution(
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
    if (!this.#admitResolvedLocation(view, node, resolution)) {
      return this.#protectTreeArrival(attempt, view, {
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
    return this.#protectNodeAfterArrivalSettlementFailure(view, node);
  }

  protectCurrentTreeArrival(
    attempt: ArrivalAttempt,
    view: SessionView,
  ): ArrivalDisposition {
    return this.#protectTreeArrival(attempt, view, { kind: "any-current" });
  }

  protectTreeArrivalIfResolution(
    attempt: ArrivalAttempt,
    view: SessionView,
    resolution: ResolvedNodeState,
  ): ArrivalDisposition {
    return this.#protectTreeArrival(attempt, view, {
      kind: "exact-resolution",
      resolution,
    });
  }

  protectCurrentNode(
    view: SessionView,
    node: NodeKey,
  ): LocationProtectionDisposition {
    return this.#protectNode(view, node, { kind: "any-current" });
  }

  protectNodeIfResolution(
    view: SessionView,
    node: NodeKey,
    resolution: ResolvedNodeState,
  ): LocationProtectionDisposition {
    return this.#protectNode(view, node, {
      kind: "exact-resolution",
      resolution,
    });
  }

  captureAdmission(
    view: SessionView,
    node: NodeKey | undefined,
  ): AdmissionDecision {
    if (node !== undefined) {
      const reconciled = this.reconcileSessionBarrier(view, node);
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
      this.protectCurrentNode(view, node);
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

  #admitResolvedLocation(
    view: SessionView,
    node: NodeKey,
    resolution: ResolvedNodeState,
  ): boolean {
    const identity = persistedSessionIdentityOf(view);
    if (identity === undefined) return false;
    try {
      this.#options.registrations.assertActiveWorkspaceAuthority(identity);
    } catch {
      return false;
    }
    return (
      this.#options.metadata().admitResolvedLocation({
        identity: {
          sessionId: node.sessionId,
          sessionFile: identity.sessionFile,
        },
        entryId: node.entryId,
        activeAncestryEntryIds: this.#ancestryIds(view, node.entryId),
        expectedResolution: {
          kind: "checkpoint",
          entryId: resolution.foundAt.entryId,
          treeOid: resolution.treeOid,
        },
      }) !== "slot-changed"
    );
  }

  #protectTreeArrival(
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
        raised = this.#raiseSessionBarrier(view);
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
      protection = this.#protectLocation(view, node, expectation);
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
      evidence: {
        kind: "exact-slot",
        slot: protection.protectedSlot,
        expectation: protection.kind === "protected" ? "matched" : "stale",
        admission: this.#arrivalAdmissionSettlement(settlement),
      },
    };
  }

  #protectNode(
    view: SessionView,
    node: NodeKey,
    expectation: LocationExpectation,
  ): LocationProtectionDisposition {
    let protection: ProtectLocationResult | { readonly kind: "unregistered" };
    try {
      protection = this.#protectLocation(view, node, expectation);
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
      evidence: {
        kind: "exact-slot",
        slot: protection.protectedSlot,
        expectation: protection.kind === "protected" ? "matched" : "stale",
        admission,
      },
    };
  }

  #protectNodeAfterArrivalSettlementFailure(
    view: SessionView,
    node: NodeKey,
  ): ArrivalDisposition {
    let protection: ProtectLocationResult | { readonly kind: "unregistered" };
    try {
      protection = this.#protectLocation(view, node, {
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
    view: SessionView,
    node: NodeKey,
    expectation: LocationExpectation,
  ): ProtectLocationResult | { readonly kind: "unregistered" } {
    const identity = persistedSessionIdentityOf(view);
    if (identity === undefined) return { kind: "unregistered" };
    try {
      // This re-observes cwd + session cwd against the registered dev/ino
      // binding synchronously, immediately before metadata's transaction.
      this.#options.registrations.assertActiveWorkspaceAuthority(identity);
    } catch {
      return { kind: "unregistered" };
    }
    const result = this.#options.metadata().protectLocation({
      identity: {
        sessionId: node.sessionId,
        sessionFile: identity.sessionFile,
      },
      entryId: node.entryId,
      activeAncestryEntryIds: this.#ancestryIds(view, node.entryId),
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
    });
    return result;
  }
}
