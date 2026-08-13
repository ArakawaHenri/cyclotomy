import type { NodeKey } from "../domain/model.ts";
import {
  AuthorityCoordinator,
  type ArrivalToken,
  type CaptureLease as StructuralCaptureLease,
  type ProposalResult,
} from "../domain/authority.ts";
import type { SessionView } from "./session-view.ts";
import type { PendingNavigation } from "./navigation-plan.ts";

declare const PREPARATION_PERMIT: unique symbol;

/** Opaque ownership of one cancellable preparation. */
interface PreparationPermit {
  readonly [PREPARATION_PERMIT]: true;
}

export type PreparationResult<T> =
  | { readonly kind: "busy" | "stale" }
  | { readonly kind: "completed"; readonly value: T };

export type TreePreparationResult =
  ProposalResult | { readonly kind: "busy" | "cancelled" | "stale" };

interface AdmissionLocation {
  readonly leafId: string | null;
  readonly entryId: string | null;
}

export interface AdmissionLease {
  /** Opaque; provenance and expected location stay inside CheckpointAdmission. */
  readonly __admissionLease: true;
}

export type AdmissionDecision =
  | { readonly kind: "capture"; readonly lease: AdmissionLease }
  | { readonly kind: "no-coordinate" }
  | { readonly kind: "write-protected" }
  | { readonly kind: "not-admitted" };

export type EphemeralArrivalSettlement =
  | { readonly kind: "settled" }
  | { readonly kind: "unsettled"; readonly cause: unknown };

/**
 * Opaque one-shot authority to classify a committed tree arrival. The plan is
 * carried only so transition and admission state can be consumed together;
 * it is evidence for the lifecycle, never capture authority by itself.
 */
export interface ArrivalAttempt<Plan = unknown> {
  readonly planned: boolean;
  readonly plan: Plan;
}

function locationOf(
  view: SessionView,
  node: NodeKey | undefined,
): AdmissionLocation | undefined {
  if (view.sessionFile === null || !nodeMatchesSnapshot(view, node)) {
    return undefined;
  }
  return {
    leafId: view.leafId,
    entryId: node?.entryId ?? null,
  };
}

function sameSession(previous: SessionView, view: SessionView): boolean {
  return view.sessionFile !== null && view.hasSameIdentityAs(previous);
}

function nodeMatchesSnapshot(
  view: SessionView,
  node: NodeKey | undefined,
): boolean {
  const expectedEntryId = view.stableCoordinateId();
  if (expectedEntryId === undefined) return false;
  return (
    expectedEntryId === (node?.entryId ?? null) &&
    (node === undefined || node.sessionId === view.sessionId)
  );
}

function isAppendOnlyExtension(
  previous: SessionView,
  current: SessionView,
): boolean {
  try {
    return (
      sameSession(previous, current) &&
      current.isAppendOnlyExtensionOf(previous)
    );
  } catch {
    return false;
  }
}

function isNaturalDescendant(
  previous: SessionView,
  previousEntryId: string | null,
  current: SessionView,
  descendantEntryId: string,
): boolean {
  try {
    return (
      sameSession(previous, current) &&
      previousEntryId !== descendantEntryId &&
      current.isNaturalDescendantOf(
        previous,
        previousEntryId,
        descendantEntryId,
      )
    );
  } catch {
    return false;
  }
}

/**
 * Runtime authority for checkpoint capture.
 *
 * - closed: no location may be captured;
 * - live: one exact immutable session snapshot has structural authority;
 * - armed: a committed tree arrival is being authenticated, so the old live
 *   authority is retained only inside its one-shot attempt and cannot capture.
 *
 * Writable/blocked policy lives only in durable checkpoint slots. This class
 * owns the short-lived provenance tokens that prevent an asynchronous capture
 * from surviving a navigation or other authority handoff.
 */
export class CheckpointAdmission {
  readonly #authority = new AuthorityCoordinator<
    SessionView,
    AdmissionLocation,
    PendingNavigation
  >();
  #preparing: PreparationPermit | undefined;
  readonly #arrivals = new WeakMap<
    ArrivalAttempt,
    ArrivalToken<PendingNavigation>
  >();
  readonly #leases = new WeakMap<
    AdmissionLease,
    StructuralCaptureLease<SessionView, AdmissionLocation>
  >();

  reset(): void {
    this.#invalidateLifecycle();
    this.#authority.close();
  }

  /**
   * Acquire one cancellable host preparation and retire an ambiguous older
   * navigation proposal atomically from the lifecycle's point of view.
   */
  #beginPreparation(): PreparationPermit | undefined {
    if (this.#preparing !== undefined) return undefined;
    const permit = Object.freeze({}) as PreparationPermit;
    this.#preparing = permit;
    if (this.#authority.retireProposal()) {
      this.#finishPreparation(permit);
      return undefined;
    }
    return permit;
  }

  /**
   * Run one cancellable preparation under opaque ownership. The permit never
   * escapes this boundary, so throws and early returns cannot leak or release
   * a replacement preparation.
   */
  async runPreparation<T>(
    action: () => Promise<T>,
  ): Promise<PreparationResult<T>> {
    const permit = this.#beginPreparation();
    if (permit === undefined) return { kind: "busy" };
    try {
      const value = await action();
      return this.#preparationIsCurrent(permit)
        ? { kind: "completed", value }
        : { kind: "stale" };
    } finally {
      this.#finishPreparation(permit);
    }
  }

  /**
   * Publish a tree proposal only from the successful exit of the preparation
   * that produced it. The plan remains a local value while `action` awaits;
   * reset/close therefore invalidates it before it can reach host authority.
   */
  async runTreePreparation(
    action: () => Promise<PendingNavigation | undefined>,
  ): Promise<TreePreparationResult> {
    const permit = this.#beginPreparation();
    if (permit === undefined) return { kind: "busy" };
    try {
      const proposal = await action();
      if (!this.#preparationIsCurrent(permit)) {
        return { kind: "stale" };
      }
      if (proposal === undefined) return { kind: "cancelled" };
      return this.#authority.propose(proposal);
    } finally {
      this.#finishPreparation(permit);
    }
  }

  /** Reject one cancellable boundary while preparation or a stale proposal exists. */
  rejectTransitionConflict(): boolean {
    return this.#preparing !== undefined || this.#authority.retireProposal();
  }

  admit(view: SessionView, node: NodeKey | undefined): void {
    this.#setLive(view, node);
  }

  beginTreeArrival(): ArrivalAttempt<PendingNavigation | undefined> {
    this.#invalidateLifecycle();
    const token = this.#authority.beginArrival();
    const attempt: ArrivalAttempt<PendingNavigation | undefined> =
      Object.freeze({
        planned: token.planned,
        plan: token.planned ? token.proposal : undefined,
      });
    this.#arrivals.set(attempt, token);
    return attempt;
  }

  /** Consume a failed or abandoned arrival attempt without admitting anything. */
  closeArrival(attempt: ArrivalAttempt): boolean {
    const token = this.#arrivals.get(attempt);
    if (token === undefined || !this.#authority.arrivalIsCurrent(token)) {
      return false;
    }
    this.#invalidateLifecycle();
    return this.#authority.abandonArrival(token);
  }

  arrivalIsCurrent(attempt: ArrivalAttempt): boolean {
    const token = this.#arrivals.get(attempt);
    return token !== undefined && this.#authority.arrivalIsCurrent(token);
  }

  /** Non-consuming proof required before any planned arrival side effect. */
  arrivalCanProceed(
    attempt: ArrivalAttempt,
    view: SessionView,
    node: NodeKey | undefined,
  ): boolean {
    const token = this.#arrivals.get(attempt);
    if (token === undefined) return false;
    const source = this.#authority.arrivalSource(token)?.observation;
    return (
      source !== undefined &&
      nodeMatchesSnapshot(view, node) &&
      isAppendOnlyExtension(source, view)
    );
  }

  /**
   * Tree summaries may wrap the planned logical destination. Authenticate the
   * one-shot arrival plus that exact stable ancestor without widening ordinary
   * capture admission beyond the active coordinate.
   */
  arrivalCanCommitPlannedTarget(
    attempt: ArrivalAttempt<PendingNavigation | undefined>,
    view: SessionView,
    node: NodeKey,
  ): boolean {
    const token = this.#arrivals.get(attempt);
    if (token === undefined || !attempt.planned || attempt.plan === undefined) {
      return false;
    }
    const source = this.#authority.arrivalSource(token)?.observation;
    try {
      return (
        source !== undefined &&
        view.sessionFile !== null &&
        view.sessionId === node.sessionId &&
        attempt.plan.sessionId === node.sessionId &&
        attempt.plan.cwd === view.cwd &&
        attempt.plan.target.kind === "materialize-missing" &&
        attempt.plan.target.node.entryId === node.entryId &&
        isAppendOnlyExtension(source, view) &&
        view.activeStableAncestryIds.includes(node.entryId)
      );
    } catch {
      return false;
    }
  }

  admitArrival(
    attempt: ArrivalAttempt,
    view: SessionView,
    node: NodeKey | undefined,
  ): boolean {
    if (!this.arrivalCanProceed(attempt, view, node)) {
      this.closeArrival(attempt);
      return false;
    }
    return this.#settleArrival(attempt, view, node).kind === "settled";
  }

  settleProtectedArrival(
    attempt: ArrivalAttempt,
    view: SessionView,
    node: NodeKey | undefined,
  ): EphemeralArrivalSettlement {
    return this.#settleArrival(attempt, view, node);
  }

  /**
   * Settle a verified same-anchor arrival. Durable slot state independently
   * decides whether the coordinate can capture.
   * The full graph must be an append-only extension; matching just the raw or
   * stable leaf is insufficient because Pi may navigate to an existing node.
   */
  carryArrival(
    attempt: ArrivalAttempt,
    view: SessionView,
    node: NodeKey | undefined,
  ): boolean {
    const token = this.#arrivals.get(attempt);
    if (token === undefined) return false;
    const arrivalSource = this.#authority.arrivalSource(token);
    const source = arrivalSource?.location;
    try {
      if (
        source === undefined ||
        !nodeMatchesSnapshot(view, node) ||
        source.entryId !== (node?.entryId ?? null) ||
        arrivalSource === undefined ||
        !isAppendOnlyExtension(arrivalSource.observation, view)
      ) {
        this.closeArrival(attempt);
        return false;
      }
    } catch {
      this.closeArrival(attempt);
      return false;
    }
    if (source === undefined) return false;
    return this.#settleArrival(attempt, view, node).kind === "settled";
  }

  /** Preserve classification across an authenticated label/raw-leaf rewrite. */
  carry(view: SessionView, node: NodeKey | undefined): boolean {
    const state = this.#authority.snapshot();
    if (state.kind !== "live") return false;
    const source = state.location;
    try {
      if (
        !nodeMatchesSnapshot(view, node) ||
        source.entryId !== (node?.entryId ?? null) ||
        !isAppendOnlyExtension(state.observation, view)
      ) {
        this.reset();
        return false;
      }
      const location = locationOf(view, node);
      if (location === undefined || !this.#authority.advance(view, location)) {
        this.reset();
        return false;
      }
    } catch {
      this.reset();
      return false;
    }
    return this.#authority.snapshot().kind === "live";
  }

  decideCapture(input: {
    readonly view: SessionView;
    readonly node: NodeKey | undefined;
    readonly writeProtected: boolean;
  }): AdmissionDecision {
    const { view, node } = input;
    let state = this.#authority.snapshot();
    if (state.kind !== "live") return { kind: "not-admitted" };
    try {
      if (
        !sameSession(state.observation, view) ||
        !nodeMatchesSnapshot(view, node) ||
        !isAppendOnlyExtension(state.observation, view)
      ) {
        return this.#closeAndBlock();
      }
    } catch {
      return this.#closeAndBlock();
    }
    let location = state.location;

    // Pi may append or remove a label without session_tree. Carry structural
    // authority only when an immutable graph snapshot proves the same stable
    // anchor and no existing entry was rewritten.
    if (
      location.leafId !== view.leafId &&
      location.entryId === (node?.entryId ?? null)
    ) {
      if (!this.carry(view, node)) return { kind: "not-admitted" };
      state = this.#authority.snapshot();
      if (state.kind !== "live") return { kind: "not-admitted" };
      location = state.location;
    }

    if (node === undefined) {
      return location.leafId === view.leafId && location.entryId === null
        ? { kind: "no-coordinate" }
        : this.#closeAndBlock();
    }

    if (location.leafId === view.leafId && location.entryId === node.entryId) {
      if (input.writeProtected) return { kind: "write-protected" };
      return { kind: "capture", lease: this.#lease() };
    }

    if (
      !isNaturalDescendant(
        state.observation,
        location.entryId,
        view,
        node.entryId,
      )
    ) {
      return this.#closeAndBlock();
    }
    if (input.writeProtected) {
      if (!this.#advanceLive(view, node)) return this.#closeAndBlock();
      return { kind: "write-protected" };
    }
    if (!this.#advanceLive(view, node)) return this.#closeAndBlock();
    state = this.#authority.snapshot();
    return state.kind === "live"
      ? { kind: "capture", lease: this.#lease() }
      : { kind: "not-admitted" };
  }

  leaseIsCurrent(
    lease: AdmissionLease,
    view: SessionView,
    node: NodeKey,
  ): boolean {
    const structural = this.#leases.get(lease);
    if (
      structural === undefined ||
      !this.#authority.captureLeaseIsCurrent(structural)
    ) {
      return false;
    }
    const state = this.#authority.snapshot();
    if (state.kind !== "live") return false;
    const location = state.location;
    try {
      return (
        sameSession(state.observation, view) &&
        isAppendOnlyExtension(state.observation, view) &&
        nodeMatchesSnapshot(view, node) &&
        location.leafId === view.leafId &&
        location.entryId === node.entryId
      );
    } catch {
      return false;
    }
  }

  /** Validate and synchronously close one live destructive cutover. */
  cutoverMutation(view: SessionView, node: NodeKey | undefined): boolean {
    const state = this.#authority.snapshot();
    if (state.kind !== "live") return false;
    try {
      if (
        !sameSession(state.observation, view) ||
        !view.isSameSnapshotAs(state.observation)
      ) {
        return false;
      }
      if (locationOf(view, node) === undefined) return false;
    } catch {
      return false;
    }
    const cutover = this.#authority.cutoverLive();
    if (cutover) this.#invalidateLifecycle();
    return cutover;
  }

  /** Validate and synchronously close one tree-arrival destructive cutover. */
  cutoverArrivalMutation(
    attempt: ArrivalAttempt,
    view: SessionView,
    node: NodeKey | undefined,
  ): boolean {
    const token = this.#arrivals.get(attempt);
    if (token === undefined || !this.arrivalCanProceed(attempt, view, node)) {
      return false;
    }
    try {
      if (locationOf(view, node) === undefined) return false;
    } catch {
      return false;
    }
    const cutover = this.#authority.cutoverArrival(token);
    if (cutover) this.#invalidateLifecycle();
    return cutover;
  }

  #settleArrival(
    attempt: ArrivalAttempt,
    view: SessionView,
    node: NodeKey | undefined,
  ): EphemeralArrivalSettlement {
    const token = this.#arrivals.get(attempt);
    if (token === undefined || !this.#authority.arrivalIsCurrent(token)) {
      return {
        kind: "unsettled",
        cause: new Error("tree arrival authority is stale"),
      };
    }
    let location: AdmissionLocation | undefined;
    try {
      location = locationOf(view, node);
    } catch (cause) {
      if (this.#authority.arrivalIsCurrent(token)) {
        this.#invalidateLifecycle();
        this.#authority.abandonArrival(token);
      }
      return { kind: "unsettled", cause };
    }
    if (!this.#authority.arrivalIsCurrent(token)) {
      return {
        kind: "unsettled",
        cause: new Error("tree arrival authority changed during settlement"),
      };
    }
    this.#invalidateLifecycle();
    if (location === undefined) {
      this.#authority.abandonArrival(token);
      return {
        kind: "unsettled",
        cause: new Error("tree arrival has no authenticated location"),
      };
    }
    return this.#authority.settleArrival(token, view, location)
      ? { kind: "settled" }
      : {
          kind: "unsettled",
          cause: new Error("tree arrival authority changed during settlement"),
        };
  }

  #setLive(view: SessionView, node: NodeKey | undefined): void {
    // Invalidate before reading the new snapshot. An exceptional accessor can
    // never leave the preceding live authority or one of its leases usable.
    this.#invalidateLifecycle();
    this.#authority.close();
    const location = locationOf(view, node);
    if (location !== undefined) {
      this.#authority.open(view, location);
    }
  }

  #advanceLive(view: SessionView, node: NodeKey | undefined): boolean {
    const location = locationOf(view, node);
    // Natural append/label progress neither proves that an ambiguous host
    // proposal ended nor replaces the preparation that may be proving it.
    return location !== undefined && this.#authority.advance(view, location);
  }

  #invalidateLifecycle(): void {
    this.#preparing = undefined;
  }

  #preparationIsCurrent(permit: PreparationPermit): boolean {
    return this.#preparing === permit;
  }

  #finishPreparation(permit: PreparationPermit): void {
    if (!this.#preparationIsCurrent(permit)) return;
    this.#preparing = undefined;
  }

  #closeAndBlock(): AdmissionDecision {
    this.reset();
    return { kind: "not-admitted" };
  }

  #lease(): AdmissionLease {
    const structural = this.#authority.issueCaptureLease();
    if (structural === undefined) {
      throw new Error("capture authority is unavailable");
    }
    const lease: AdmissionLease = Object.freeze({
      __admissionLease: true,
    });
    this.#leases.set(lease, structural);
    return lease;
  }
}
