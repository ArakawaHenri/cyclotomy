/**
 * Host-independent structural authority for an asynchronously observed
 * location. The coordinator knows nothing about Pi, checkpoints, or files; a
 * boundary supplies immutable observations and decides what equivalence means.
 */

declare const ARRIVAL_TOKEN: unique symbol;
declare const CAPTURE_LEASE: unique symbol;

export interface ArrivalToken<Proposal> {
  /** Distinguishes an unplanned arrival from a proposal whose value is undefined. */
  readonly planned: boolean;
  readonly proposal: Proposal | undefined;
  readonly [ARRIVAL_TOKEN]: true;
}

export interface CaptureLease<Observation, Location> {
  readonly observation: Observation;
  readonly location: Location;
  readonly [CAPTURE_LEASE]: true;
}

export type ProposalResult =
  | { readonly kind: "accepted" }
  | {
      /** The old proposal was retired; the new operation must be cancelled. */
      readonly kind: "retired-conflict";
    }
  | { readonly kind: "closed" };

interface LiveAuthority<Observation, Location> {
  readonly kind: "live";
  readonly observation: Observation;
  readonly location: Location;
}

interface ClosedAuthority {
  readonly kind: "closed";
}

interface ArrivalAuthority<Observation, Location, Proposal> {
  readonly kind: "arrival";
  readonly token: ArrivalToken<Proposal>;
  readonly source: LiveAuthority<Observation, Location> | undefined;
}

type AuthorityState<Observation, Location, Proposal> =
  | ClosedAuthority
  | LiveAuthority<Observation, Location>
  | ArrivalAuthority<Observation, Location, Proposal>;

interface ProposalState<Observation, Location, Proposal> {
  readonly value: Proposal;
  readonly source: LiveAuthority<Observation, Location>;
}

export type AuthoritySnapshot<Observation, Location> =
  | { readonly kind: "closed" }
  | {
      readonly kind: "live";
      readonly observation: Observation;
      readonly location: Location;
    }
  | { readonly kind: "arrival" };

/**
 * Owns only ephemeral structural authority.
 *
 * A proposal is orthogonal to a live source: preparing a host transition does
 * not revoke capture rights. `beginArrival` is the sole synchronous cutover.
 * Every lease and arrival is authenticated by unforgeable object provenance;
 * state-object identity provides ABA safety without a parallel epoch model.
 */
export class AuthorityCoordinator<Observation, Location, Proposal = never> {
  #state: AuthorityState<Observation, Location, Proposal> = { kind: "closed" };
  #proposal: ProposalState<Observation, Location, Proposal> | undefined;
  #captureLeases = new WeakMap<
    CaptureLease<Observation, Location>,
    LiveAuthority<Observation, Location>
  >();

  snapshot(): AuthoritySnapshot<Observation, Location> {
    const state = this.#state;
    switch (state.kind) {
      case "closed":
        return { kind: "closed" };
      case "arrival":
        return { kind: "arrival" };
      case "live":
        return {
          kind: "live",
          observation: state.observation,
          location: state.location,
        };
    }
  }

  close(): void {
    this.#proposal = undefined;
    this.#state = { kind: "closed" };
  }

  open(observation: Observation, location: Location): void {
    // Revoke first so construction of a future richer live state can never
    // preserve preceding rights if it throws.
    this.close();
    this.#state = { kind: "live", observation, location };
  }

  /** Advance only after the boundary proves an append-only same-location successor. */
  advance(observation: Observation, location: Location): boolean {
    if (this.#state.kind !== "live") return false;
    this.#state = { kind: "live", observation, location };
    return true;
  }

  /**
   * Prepare a possible host transition without closing the live source.
   * Encountering an older proposal retires it and rejects this operation once.
   */
  propose(value: Proposal): ProposalResult {
    const state = this.#state;
    if (state.kind !== "live") return { kind: "closed" };
    if (this.#proposal !== undefined) {
      this.#proposal = undefined;
      return { kind: "retired-conflict" };
    }
    this.#proposal = { value, source: state };
    return { kind: "accepted" };
  }

  retireProposal(): boolean {
    if (this.#proposal === undefined) return false;
    this.#proposal = undefined;
    return true;
  }

  /** Revoke the source and consume the pending proposal without yielding. */
  beginArrival(): ArrivalToken<Proposal> {
    const proposal = this.#takeCurrentProposal();
    const source = proposal.present
      ? proposal.source
      : this.#state.kind === "live"
        ? this.#state
        : undefined;
    this.#proposal = undefined;
    this.#state = { kind: "closed" };
    const token = Object.freeze({
      planned: proposal.present,
      proposal: proposal.present ? proposal.value : undefined,
    }) as ArrivalToken<Proposal>;
    this.#state = { kind: "arrival", token, source };
    return token;
  }

  arrivalIsCurrent(token: ArrivalToken<Proposal>): boolean {
    return this.#state.kind === "arrival" && this.#state.token === token;
  }

  arrivalSource(
    token: ArrivalToken<Proposal>,
  ):
    | { readonly observation: Observation; readonly location: Location }
    | undefined {
    const state = this.#state;
    if (
      state.kind !== "arrival" ||
      state.token !== token ||
      state.source === undefined
    ) {
      return undefined;
    }
    return {
      observation: state.source.observation,
      location: state.source.location,
    };
  }

  settleArrival(
    token: ArrivalToken<Proposal>,
    observation: Observation,
    location: Location,
  ): boolean {
    if (!this.arrivalIsCurrent(token)) return false;
    this.#state = { kind: "live", observation, location };
    return true;
  }

  abandonArrival(token: ArrivalToken<Proposal>): boolean {
    if (!this.arrivalIsCurrent(token)) return false;
    this.#state = { kind: "closed" };
    return true;
  }

  issueCaptureLease(): CaptureLease<Observation, Location> | undefined {
    const state = this.#state;
    if (state.kind !== "live") return undefined;
    const lease = Object.freeze({
      observation: state.observation,
      location: state.location,
    }) as CaptureLease<Observation, Location>;
    this.#captureLeases.set(lease, state);
    return lease;
  }

  captureLeaseIsCurrent(lease: CaptureLease<Observation, Location>): boolean {
    const source = this.#captureLeases.get(lease);
    return source !== undefined && this.#state === source;
  }

  /** Synchronously revoke one still-live location at a destructive cutover. */
  cutoverLive(): boolean {
    if (this.#state.kind !== "live") return false;
    this.close();
    return true;
  }

  /** Synchronously consume one still-current arrival at a destructive cutover. */
  cutoverArrival(token: ArrivalToken<Proposal>): boolean {
    if (!this.arrivalIsCurrent(token)) return false;
    this.close();
    return true;
  }

  #takeCurrentProposal():
    | {
        readonly present: true;
        readonly value: Proposal;
        readonly source: LiveAuthority<Observation, Location>;
      }
    | { readonly present: false } {
    const state = this.#state;
    const proposal = this.#proposal;
    this.#proposal = undefined;
    return state.kind === "live" && proposal !== undefined
      ? { present: true, value: proposal.value, source: proposal.source }
      : { present: false };
  }
}
