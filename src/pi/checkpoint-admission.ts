import type { NodeKey } from "../domain/model.ts";
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
  | { readonly kind: "accepted" | "retired-conflict" | "closed" }
  | { readonly kind: "busy" | "cancelled" | "stale" };

interface AdmissionLocation {
  readonly leafId: string | null;
  readonly entryId: string | null;
}

interface LiveAdmission {
  readonly kind: "live";
  readonly observation: SessionView;
  readonly location: AdmissionLocation;
}

interface ArrivalAdmission {
  readonly kind: "arrival";
  readonly attempt: ArrivalAttempt<PendingNavigation | undefined>;
  readonly source: LiveAdmission | undefined;
}

type AdmissionState =
  { readonly kind: "closed" } | LiveAdmission | ArrivalAdmission;

interface PendingProposal {
  readonly plan: PendingNavigation;
  readonly source: LiveAdmission;
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

export type OrdinaryMutationClaim =
  | { readonly kind: "claimed" }
  | { readonly kind: "transition-conflict" }
  | { readonly kind: "invalid-location" };

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
 * - arrival: a committed tree arrival is being authenticated, so the old live
 *   authority is retained only inside its one-shot attempt and cannot capture.
 *
 * Writable/blocked policy lives only in durable checkpoint slots. This class
 * owns the short-lived provenance tokens that prevent an asynchronous capture
 * from surviving a navigation or other authority handoff.
 */
export class CheckpointAdmission {
  #state: AdmissionState = { kind: "closed" };
  #proposal: PendingProposal | undefined;
  #preparing: PreparationPermit | undefined;
  readonly #leases = new WeakMap<AdmissionLease, LiveAdmission>();

  reset(): void {
    this.#invalidateLifecycle();
    this.#close();
  }

  /**
   * Acquire one cancellable host preparation and retire an ambiguous older
   * navigation proposal atomically from the lifecycle's point of view.
   */
  #beginPreparation(): PreparationPermit | undefined {
    if (this.#preparing !== undefined) return undefined;
    const permit = Object.freeze({}) as PreparationPermit;
    this.#preparing = permit;
    if (this.#retireProposal()) {
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
      return this.#propose(proposal);
    } finally {
      this.#finishPreparation(permit);
    }
  }

  /** Reject one cancellable boundary while another transition owns authority. */
  rejectTransitionConflict(): boolean {
    return (
      this.#preparing !== undefined ||
      this.#state.kind === "arrival" ||
      this.#retireProposal()
    );
  }

  /**
   * Atomically replace ordinary live authority only when no transition owns it.
   * A pending proposal is retired, but the conflicting mutation is rejected
   * once; preparation and arrival authority are observed without consumption.
   */
  claimOrdinaryMutation(
    view: SessionView,
    node: NodeKey | undefined,
  ): OrdinaryMutationClaim {
    if (this.#preparing !== undefined || this.#state.kind === "arrival") {
      return { kind: "transition-conflict" };
    }
    if (this.#retireProposal()) {
      return { kind: "transition-conflict" };
    }
    return this.#setLive(view, node)
      ? { kind: "claimed" }
      : { kind: "invalid-location" };
  }

  beginTreeArrival(): ArrivalAttempt<PendingNavigation | undefined> {
    this.#invalidateLifecycle();
    const current = this.#state;
    const proposal = current.kind === "live" ? this.#proposal : undefined;
    const source =
      proposal?.source ?? (current.kind === "live" ? current : undefined);
    this.#proposal = undefined;
    const attempt: ArrivalAttempt<PendingNavigation | undefined> =
      Object.freeze({
        planned: proposal !== undefined,
        plan: proposal?.plan,
      });
    this.#state = { kind: "arrival", attempt, source };
    return attempt;
  }

  /** Consume a failed or abandoned arrival attempt without admitting anything. */
  closeArrival(attempt: ArrivalAttempt): boolean {
    if (!this.arrivalIsCurrent(attempt)) return false;
    this.#invalidateLifecycle();
    this.#close();
    return true;
  }

  arrivalIsCurrent(attempt: ArrivalAttempt): boolean {
    return this.#state.kind === "arrival" && this.#state.attempt === attempt;
  }

  /** Non-consuming proof required before any planned arrival side effect. */
  arrivalCanProceed(
    attempt: ArrivalAttempt,
    view: SessionView,
    node: NodeKey | undefined,
  ): boolean {
    const state = this.#arrival(attempt);
    const source = state?.source?.observation;
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
    const state = this.#arrival(attempt);
    if (state === undefined || !attempt.planned || attempt.plan === undefined) {
      return false;
    }
    const source = state.source?.observation;
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
    const arrivalSource = this.#arrival(attempt)?.source;
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
    return this.#settleArrival(attempt, view, node).kind === "settled";
  }

  /** Preserve classification across an authenticated label/raw-leaf rewrite. */
  carry(view: SessionView, node: NodeKey | undefined): boolean {
    const state = this.#state;
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
      if (location === undefined || !this.#advance(view, location)) {
        this.reset();
        return false;
      }
    } catch {
      this.reset();
      return false;
    }
    return this.#state.kind === "live";
  }

  decideCapture(input: {
    readonly view: SessionView;
    readonly node: NodeKey | undefined;
    readonly writeProtected: boolean;
  }): AdmissionDecision {
    const { view, node } = input;
    let state = this.#state;
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
      state = this.#state;
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
    state = this.#state;
    return state.kind === "live"
      ? { kind: "capture", lease: this.#lease() }
      : { kind: "not-admitted" };
  }

  leaseIsCurrent(
    lease: AdmissionLease,
    view: SessionView,
    node: NodeKey,
  ): boolean {
    const state = this.#leases.get(lease);
    if (state === undefined || this.#state !== state) return false;
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
    const state = this.#state;
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
    if (this.#state !== state) return false;
    this.reset();
    return true;
  }

  /** Validate and synchronously close one tree-arrival destructive cutover. */
  cutoverArrivalMutation(
    attempt: ArrivalAttempt,
    view: SessionView,
    node: NodeKey | undefined,
  ): boolean {
    const state = this.#arrival(attempt);
    if (state === undefined || !this.arrivalCanProceed(attempt, view, node)) {
      return false;
    }
    try {
      if (locationOf(view, node) === undefined) return false;
    } catch {
      return false;
    }
    if (this.#state !== state) return false;
    this.reset();
    return true;
  }

  #settleArrival(
    attempt: ArrivalAttempt,
    view: SessionView,
    node: NodeKey | undefined,
  ): EphemeralArrivalSettlement {
    const state = this.#arrival(attempt);
    if (state === undefined) {
      return {
        kind: "unsettled",
        cause: new Error("tree arrival authority is stale"),
      };
    }
    let location: AdmissionLocation | undefined;
    try {
      location = locationOf(view, node);
    } catch (cause) {
      if (this.#state === state) {
        this.#invalidateLifecycle();
        this.#close();
      }
      return { kind: "unsettled", cause };
    }
    if (this.#state !== state) {
      return {
        kind: "unsettled",
        cause: new Error("tree arrival authority changed during settlement"),
      };
    }
    this.#invalidateLifecycle();
    if (location === undefined) {
      this.#close();
      return {
        kind: "unsettled",
        cause: new Error("tree arrival has no authenticated location"),
      };
    }
    this.#state = { kind: "live", observation: view, location };
    return { kind: "settled" };
  }

  #setLive(view: SessionView, node: NodeKey | undefined): boolean {
    // Invalidate before reading the new snapshot. An exceptional accessor can
    // never leave the preceding live authority or one of its leases usable.
    this.#invalidateLifecycle();
    this.#close();
    const location = locationOf(view, node);
    if (location === undefined) return false;
    this.#state = { kind: "live", observation: view, location };
    return true;
  }

  #advanceLive(view: SessionView, node: NodeKey | undefined): boolean {
    const location = locationOf(view, node);
    // Natural append/label progress neither proves that an ambiguous host
    // proposal ended nor replaces the preparation that may be proving it.
    return location !== undefined && this.#advance(view, location);
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
    const state = this.#state;
    if (state.kind !== "live") {
      throw new Error("capture authority is unavailable");
    }
    const lease: AdmissionLease = Object.freeze({
      __admissionLease: true,
    });
    this.#leases.set(lease, state);
    return lease;
  }

  #arrival(attempt: ArrivalAttempt): ArrivalAdmission | undefined {
    const state = this.#state;
    return state.kind === "arrival" && state.attempt === attempt
      ? state
      : undefined;
  }

  #advance(observation: SessionView, location: AdmissionLocation): boolean {
    if (this.#state.kind !== "live") return false;
    this.#state = { kind: "live", observation, location };
    return true;
  }

  #close(): void {
    this.#proposal = undefined;
    this.#state = { kind: "closed" };
  }

  #propose(plan: PendingNavigation): TreePreparationResult {
    const state = this.#state;
    if (state.kind !== "live") return { kind: "closed" };
    if (this.#proposal !== undefined) {
      this.#proposal = undefined;
      return { kind: "retired-conflict" };
    }
    this.#proposal = { plan, source: state };
    return { kind: "accepted" };
  }

  #retireProposal(): boolean {
    if (this.#proposal === undefined) return false;
    this.#proposal = undefined;
    return true;
  }
}
