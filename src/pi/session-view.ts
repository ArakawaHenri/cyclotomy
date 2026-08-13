import type {
  ExtensionContext,
  SessionTreeEvent,
} from "@earendil-works/pi-coding-agent";
import { isAbsolute, resolve } from "node:path";

import {
  projectStableGraph,
  publicEntryIsTransparent,
  publicEntryIsTreeSummary,
  publicEntrySelectionLanding,
  readPublicActiveBranch,
  readPublicTreeObservation,
  type PiReadonlySessionManager,
  type PublicSessionEntry,
  type StableGraphProjection,
  type StableCoordinate,
} from "./extension-boundary.ts";

export type ParentSessionClaim =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "candidate"; readonly path: string };

/**
 * Narrow, node-free authority retained for fail-closed session-level writes.
 *
 * This projection deliberately contains neither the current leaf nor any
 * entry coordinate. It can therefore authenticate a registered persisted
 * session even while Pi's live entry graph is temporarily unresolvable,
 * without guessing which node is current.
 */
export interface PersistedSessionIdentity {
  readonly sessionId: string;
  readonly cwd: string;
  readonly sessionCwd: string;
  readonly sessionFile: string;
  readonly parentSession: ParentSessionClaim;
}

export interface TreeArrivalExpectation {
  readonly sessionId: string;
  readonly cwd: string;
  readonly expectedOldLeafId: string | null;
  /** Stable destination selected before Pi optionally appends a summary. */
  readonly expectedDestinationId: string | null;
}

export type AuthenticatedTreeArrival =
  | {
      readonly kind: "direct";
      readonly landingId: string | null;
    }
  | {
      readonly kind: "summary";
      readonly landingId: string;
      readonly summaryEntryId: string;
      readonly summaryParentLandingId: string | null;
    };

/**
 * One coherent, immutable observation of Pi's session state.
 *
 * Every value is runtime-validated before this object is returned. Query and
 * graph-proof methods read only the captured projection; none call back into
 * Pi's live SessionManager.
 */
export interface SessionView {
  readonly sessionId: string;
  /** Effective cwd selected by Pi for this runtime. */
  readonly cwd: string;
  /** Canonical cwd persisted in Pi's session header. */
  readonly sessionCwd: string;
  readonly sessionFile: string | null;
  /** Untrusted ancestry claim persisted by Pi for forked sessions. */
  readonly parentSession: ParentSessionClaim;
  readonly leafId: string | null;
  /** Stable checkpoint coordinates projected from `entries`. */
  readonly stableCoordinates: readonly StableCoordinate[];
  /** Every retained checkpoint coordinate, in Pi's append order. */
  readonly stableEntryIds: readonly string[];
  /** Stable coordinates on the active root-to-leaf path. */
  readonly activeStableAncestryIds: readonly string[];
  /**
   * Collapse transparent host coordinates to the stable checkpoint location.
   * `null` is the valid root location; `undefined` means the supplied entry is
   * absent or its chain cannot be authenticated.
   */
  stableCoordinateId(entryId?: string | null): string | null | undefined;
  /** Stable root-to-entry ancestry for active and inactive public entries. */
  stableAncestryIds(entryId?: string | null): readonly string[] | undefined;
  /** Stable editor coordinate selected by Pi after transparent collapsing. */
  navigationLandingId(entryId: string): string | null | undefined;
  /** Authenticate Pi's complete public tree-arrival contract semantically. */
  authenticateTreeArrival(
    event: SessionTreeEvent,
    expectation: TreeArrivalExpectation,
  ): AuthenticatedTreeArrival | undefined;
  /** Exact identity/header equality, excluding leaf and entry graph. */
  hasSameIdentityAs(other: SessionView): boolean;
  /** Exact equality of every security-relevant captured value. */
  isSameSnapshotAs(other: SessionView): boolean;
  /** Whether every trusted fact in `previous` remains unchanged here. */
  isAppendOnlyExtensionOf(previous: SessionView): boolean;
  /**
   * Prove that a stable descendant was appended naturally after `previous`.
   * Existing label wrappers are transparent because they are not checkpoint
   * coordinates; every stable coordinate after the ancestor must be new.
   */
  isNaturalDescendantOf(
    previous: SessionView,
    ancestorEntryId: string | null,
    descendantEntryId: string,
  ): boolean;
}

interface SessionIdentityProjection {
  readonly sessionId: string;
  readonly cwd: string;
  readonly sessionCwd: string;
  readonly sessionFile: string | null;
  readonly parentSession: ParentSessionClaim;
}

/** Identity fields common to live and fixed-copy public SessionManager views. */
export interface PublicSessionCoreIdentity {
  readonly sessionId: string;
  readonly cwd: string;
  readonly sessionCwd: string;
}

interface IndexedEntry {
  readonly entry: PublicSessionEntry;
  readonly index: number;
}

interface TrustedSessionGraph {
  /** Append-only and private to this module. */
  readonly entries: PublicSessionEntry[];
  /** Append-only and private to this module. */
  readonly byId: Map<string, IndexedEntry>;
  /** Prefix whose complete Pi append order was observed in one full read. */
  readonly fullPrefixCount: number;
}

interface SnapshotState {
  readonly graph: TrustedSessionGraph;
  /** Immutable prefix visible to this snapshot. */
  readonly entryCount: number;
  /** Public getBranch() result, including transparent wrappers. */
  readonly activeBranchIds: readonly string[];
}

const snapshotStates = new WeakMap<SessionView, SnapshotState>();

function snapshotEntry(
  snapshot: SessionView,
  entryId: string,
): PublicSessionEntry | undefined {
  const state = snapshotStates.get(snapshot);
  if (state === undefined) {
    throw new Error("trusted Pi session snapshot state is unavailable");
  }
  return visibleEntry(state.graph, state.entryCount, entryId);
}

function snapshotEntries(snapshot: SessionView): readonly PublicSessionEntry[] {
  const state = snapshotStates.get(snapshot);
  if (state === undefined) {
    throw new Error("trusted Pi session snapshot state is unavailable");
  }
  return state.graph.entries.slice(0, state.entryCount);
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

function requireSafeString(value: unknown, description: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`Pi ${description} is not a safe non-empty string`);
  }
  return value;
}

function requireNullableSafeString(
  value: unknown,
  description: string,
): string | null {
  return value === null ? null : requireSafeString(value, description);
}

function requireCanonicalAbsolutePath(
  value: unknown,
  description: string,
): string {
  const path = requireSafeString(value, description);
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error(`Pi ${description} is not canonical and absolute`);
  }
  return path;
}

function readOptionalSessionFile(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return requireCanonicalAbsolutePath(value, "session file");
}

function readParentSessionClaim(
  header: Readonly<Record<PropertyKey, unknown>>,
  sessionFile: string | null,
): ParentSessionClaim {
  const value = Reflect.get(header, "parentSession");
  if (value === undefined) return Object.freeze({ kind: "absent" });
  if (typeof value !== "string") {
    return Object.freeze({
      kind: "invalid",
      reason: "Pi parent session path is not a string",
    });
  }
  if (
    value.length === 0 ||
    value.includes("\0") ||
    !isAbsolute(value) ||
    resolve(value) !== value
  ) {
    return Object.freeze({
      kind: "invalid",
      reason: "Pi parent session path is not canonical and absolute",
    });
  }
  if (value === sessionFile) {
    return Object.freeze({
      kind: "invalid",
      reason: "Pi fork cannot name its own session file as parent",
    });
  }
  return Object.freeze({ kind: "candidate", path: value });
}

export function sameParentSessionClaim(
  left: ParentSessionClaim,
  right: ParentSessionClaim,
): boolean {
  switch (left.kind) {
    case "absent":
      return right.kind === "absent";
    case "invalid":
      return right.kind === "invalid" && left.reason === right.reason;
    case "candidate":
      return right.kind === "candidate" && left.path === right.path;
  }
}

function validateActiveBranchShape(
  branch: readonly PublicSessionEntry[],
  leafId: string | null,
): void {
  if (leafId === null) {
    if (branch.length !== 0) {
      throw new Error("Pi session branch is non-empty while its leaf is null");
    }
    return;
  }
  if (branch.at(-1)?.id !== leafId) {
    throw new Error("Pi session branch does not end at its leaf");
  }
  const ids = new Set<string>();
  for (const [index, entry] of branch.entries()) {
    if (ids.has(entry.id)) {
      throw new Error("Pi session active branch contains a duplicate entry id");
    }
    ids.add(entry.id);
    const expectedParentId = index === 0 ? null : branch[index - 1]!.id;
    if (entry.parentId !== expectedParentId) {
      throw new Error("Pi session active branch has a broken parent chain");
    }
  }
}

/** Cross-check Pi's two public graph views without reconstructing its branch. */
function validateCompleteActiveBranch(
  entries: readonly PublicSessionEntry[],
  branch: readonly PublicSessionEntry[],
  leafId: string | null,
): void {
  validateActiveBranchShape(branch, leafId);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  for (const entry of branch) {
    if (!sameEntry(entry, byId.get(entry.id))) {
      throw new Error("Pi session entries and active branch disagree");
    }
  }
}

function sameEntry(
  left: PublicSessionEntry,
  right: PublicSessionEntry | undefined,
): boolean {
  return (
    right !== undefined &&
    left.id === right.id &&
    left.parentId === right.parentId &&
    left.type === right.type &&
    left.messageRole === right.messageRole
  );
}

function sameIdentity(
  left: SessionIdentityProjection,
  right: SessionIdentityProjection,
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.sessionFile === right.sessionFile &&
    left.cwd === right.cwd &&
    left.sessionCwd === right.sessionCwd &&
    sameParentSessionClaim(left.parentSession, right.parentSession)
  );
}

/** Exact equality of every field that authorizes a persisted session. */
export function samePersistedSessionIdentity(
  left: PersistedSessionIdentity,
  right: PersistedSessionIdentity,
): boolean {
  return sameIdentity(left, right);
}

function sameSnapshot(left: SessionView, right: SessionView): boolean {
  if (!sameIdentity(left, right) || left.leafId !== right.leafId) {
    return false;
  }
  const leftState = snapshotStates.get(left);
  const rightState = snapshotStates.get(right);
  if (
    leftState !== undefined &&
    rightState !== undefined &&
    leftState.graph === rightState.graph
  ) {
    return leftState.entryCount === rightState.entryCount;
  }
  const leftEntries = snapshotEntries(left);
  const rightEntries = snapshotEntries(right);
  if (leftEntries.length !== rightEntries.length) return false;
  return leftEntries.every((entry, index) =>
    sameEntry(entry, rightEntries[index]),
  );
}

function isAppendOnlyExtension(
  current: SessionView,
  previous: SessionView,
): boolean {
  const currentState = snapshotStates.get(current);
  const previousState = snapshotStates.get(previous);
  if (!sameIdentity(current, previous)) return false;
  const currentEntryCount =
    currentState?.entryCount ?? snapshotEntries(current).length;
  const previousEntryCount =
    previousState?.entryCount ?? snapshotEntries(previous).length;
  if (currentEntryCount < previousEntryCount) return false;
  if (
    currentState !== undefined &&
    previousState !== undefined &&
    currentState.graph === previousState.graph
  ) {
    return true;
  }
  // Incremental observations intentionally omit inactive entries that Pi
  // appended since bootstrap. A later full observation may reveal those
  // siblings between two already trusted coordinates, so cross-graph proof is
  // ordered-subsequence equality rather than array-prefix equality. Every old
  // coordinate must retain both its projection and relative append order. The
  // prefix seen by the last complete read remains an exact prefix: only the
  // later incrementally observed suffix can legitimately reveal interleaved
  // hidden siblings during a subsequent full read.
  const previousEntries = snapshotEntries(previous);
  const currentEntries = snapshotEntries(current);
  const fullPrefixCount =
    previousState?.graph.fullPrefixCount ?? previousEntries.length;
  if (
    fullPrefixCount > previousEntries.length ||
    fullPrefixCount > currentEntries.length
  ) {
    return false;
  }
  for (let index = 0; index < fullPrefixCount; index += 1) {
    if (!sameEntry(previousEntries[index]!, currentEntries[index])) {
      return false;
    }
  }

  let previousIndex = fullPrefixCount;
  for (const currentEntry of currentEntries.slice(fullPrefixCount)) {
    const expected = previousEntries[previousIndex];
    if (expected === undefined) break;
    if (currentEntry.id === expected.id) {
      if (!sameEntry(expected, currentEntry)) return false;
      previousIndex += 1;
      continue;
    }
    // Seeing a different already-trusted coordinate before the next expected
    // one proves that Pi reordered the old graph rather than only appending.
    if (snapshotEntry(previous, currentEntry.id) !== undefined) return false;
  }
  return previousIndex === previousEntries.length;
}

function visibleEntry(
  graph: TrustedSessionGraph,
  entryCount: number,
  entryId: string,
): PublicSessionEntry | undefined {
  const indexed = graph.byId.get(entryId);
  return indexed !== undefined && indexed.index < entryCount
    ? indexed.entry
    : undefined;
}

/**
 * Project the identity fields exposed by every public SessionManager.
 * Cold-parent inspection and the live host path intentionally share this
 * validation so canonical-path and header rules cannot drift.
 */
function readPublicSessionCoreIdentity(manager: PiReadonlySessionManager): {
  readonly identity: PublicSessionCoreIdentity;
  readonly header: Readonly<Record<PropertyKey, unknown>>;
} {
  const sessionId = requireSafeString(
    manager.getSessionId() as unknown,
    "session id",
  );
  const cwd = requireCanonicalAbsolutePath(
    manager.getCwd() as unknown,
    "effective cwd",
  );

  const rawHeader: unknown = manager.getHeader();
  if (!isRecord(rawHeader)) {
    throw new Error("Pi session header is missing or invalid");
  }
  if (Reflect.get(rawHeader, "type") !== "session") {
    throw new Error("Pi session header has an invalid type");
  }
  const headerSessionId = requireSafeString(
    Reflect.get(rawHeader, "id"),
    "session header id",
  );
  if (headerSessionId !== sessionId) {
    throw new Error("Pi session manager and header ids do not match");
  }
  const sessionCwd = requireCanonicalAbsolutePath(
    Reflect.get(rawHeader, "cwd"),
    "session header cwd",
  );
  return {
    identity: Object.freeze({ sessionId, cwd, sessionCwd }),
    header: rawHeader,
  };
}

export function projectPublicSessionCoreIdentity(
  manager: PiReadonlySessionManager,
): PublicSessionCoreIdentity {
  return readPublicSessionCoreIdentity(manager).identity;
}

function readSessionIdentity(
  manager: PiReadonlySessionManager,
): SessionIdentityProjection {
  const { identity: core, header } = readPublicSessionCoreIdentity(manager);
  const sessionFile = readOptionalSessionFile(
    manager.getSessionFile() as unknown,
  );
  const parentSession = readParentSessionClaim(header, sessionFile);
  return Object.freeze({
    ...core,
    sessionFile,
    parentSession,
  });
}

function requirePersistedSessionIdentity(
  identity: SessionIdentityProjection,
): PersistedSessionIdentity {
  if (identity.sessionFile === null) {
    throw new Error("Pi session has no persisted file");
  }
  return Object.freeze({
    sessionId: identity.sessionId,
    cwd: identity.cwd,
    sessionCwd: identity.sessionCwd,
    sessionFile: identity.sessionFile,
    parentSession: identity.parentSession,
  });
}

/**
 * Read only Pi's persisted session identity.
 *
 * This boundary intentionally never asks the SessionManager for its leaf,
 * entries, or entry lookup. Callers may use it only for session-scoped
 * protection whose registered authority is checked independently.
 */
export function readPersistedSessionIdentity(
  context: ExtensionContext,
): PersistedSessionIdentity {
  const manager = context.sessionManager;
  const identity = readSessionIdentity(manager);
  if (!sameIdentity(identity, readSessionIdentity(manager))) {
    throw new Error("Pi session identity changed during observation");
  }
  return requirePersistedSessionIdentity(identity);
}

/** Project an already trusted full snapshot without consulting Pi again. */
export function persistedSessionIdentityOf(
  snapshot: SessionView,
): PersistedSessionIdentity | undefined {
  return snapshot.sessionFile === null
    ? undefined
    : requirePersistedSessionIdentity(snapshot);
}

function createTrustedGraph(
  entries: readonly PublicSessionEntry[],
): TrustedSessionGraph {
  const retained = [...entries];
  return {
    entries: retained,
    byId: new Map(retained.map((entry, index) => [entry.id, { entry, index }])),
    fullPrefixCount: retained.length,
  };
}

function createSessionView(
  identity: SessionIdentityProjection,
  graph: TrustedSessionGraph,
  entryCount: number,
  leafId: string | null,
  activeBranch: readonly PublicSessionEntry[],
): SessionView {
  if (
    !Number.isSafeInteger(entryCount) ||
    entryCount < 0 ||
    entryCount > graph.entries.length
  ) {
    throw new Error("invalid trusted Pi session graph prefix");
  }
  if (
    leafId !== null &&
    visibleEntry(graph, entryCount, leafId) === undefined
  ) {
    throw new Error("Pi session leaf is absent from the entry graph");
  }
  validateActiveBranchShape(activeBranch, leafId);
  const activeBranchIds = Object.freeze(activeBranch.map(({ id }) => id));
  for (const entry of activeBranch) {
    if (!sameEntry(entry, visibleEntry(graph, entryCount, entry.id))) {
      throw new Error("Pi session active branch changed during observation");
    }
  }

  let stableGraphCache: StableGraphProjection | undefined;
  let stableEntryIdsCache: readonly string[] | undefined;
  let activeStableAncestryIdsCache: readonly string[] | undefined;
  let snapshot: SessionView;
  snapshot = {
    ...identity,
    leafId,
    get stableCoordinates() {
      stableGraphCache ??= projectStableGraph(snapshotEntries(snapshot));
      return stableGraphCache.coordinates;
    },
    get stableEntryIds() {
      stableEntryIdsCache ??= Object.freeze(
        snapshot.stableCoordinates.map((coordinate) => coordinate.id),
      );
      return stableEntryIdsCache;
    },
    get activeStableAncestryIds() {
      const ancestry = snapshot.stableAncestryIds();
      if (ancestry === undefined) {
        throw new Error("Pi session leaf is absent from the stable graph");
      }
      return ancestry;
    },
    stableCoordinateId(entryId = leafId) {
      stableGraphCache ??= projectStableGraph(snapshotEntries(snapshot));
      return stableGraphCache.stableCoordinateId(entryId);
    },
    stableAncestryIds(entryId = leafId) {
      stableGraphCache ??= projectStableGraph(snapshotEntries(snapshot));
      if (entryId !== leafId) {
        return stableGraphCache.stableAncestryIds(entryId);
      }
      activeStableAncestryIdsCache ??=
        stableGraphCache.stableAncestryIds(entryId);
      return activeStableAncestryIdsCache;
    },
    navigationLandingId(entryId) {
      const entry = visibleEntry(graph, entryCount, entryId);
      if (entry === undefined) return undefined;
      stableGraphCache ??= projectStableGraph(snapshotEntries(snapshot));
      return stableGraphCache.stableCoordinateId(
        publicEntrySelectionLanding(entry),
      );
    },
    authenticateTreeArrival(event, expectation) {
      const oldLeafId = requireNullableSafeString(
        event.oldLeafId as unknown,
        "tree-arrival old leaf id",
      );
      const newLeafId = requireNullableSafeString(
        event.newLeafId as unknown,
        "tree-arrival new leaf id",
      );
      const summary = event.summaryEntry;
      if (
        snapshot.sessionId !== expectation.sessionId ||
        snapshot.cwd !== expectation.cwd ||
        oldLeafId !== expectation.expectedOldLeafId ||
        newLeafId !== leafId
      ) {
        return undefined;
      }
      if (newLeafId === null) {
        return expectation.expectedDestinationId === null &&
          summary === undefined
          ? Object.freeze({ kind: "direct", landingId: null })
          : undefined;
      }

      stableGraphCache ??= projectStableGraph(snapshotEntries(snapshot));
      const landingId = stableGraphCache.stableCoordinateId(newLeafId);
      if (landingId === undefined) return undefined;
      if (summary === undefined) {
        return landingId === expectation.expectedDestinationId
          ? Object.freeze({ kind: "direct", landingId })
          : undefined;
      }

      // A summary is itself a stable coordinate, so a null stable landing can
      // only be the direct arrival at a root editor point through transparent
      // wrappers (for example Pi's root label).
      if (landingId === null) return undefined;

      const summaryEntryId = requireSafeString(
        summary.id as unknown,
        "tree-arrival summary id",
      );
      const summaryParentId = requireNullableSafeString(
        summary.parentId as unknown,
        "tree-arrival summary parent id",
      );
      const entry = visibleEntry(graph, entryCount, summaryEntryId);
      if (
        entry === undefined ||
        !publicEntryIsTreeSummary(entry) ||
        entry.parentId !== summaryParentId
      ) {
        return undefined;
      }
      const summaryLandingId =
        stableGraphCache.stableCoordinateId(summaryEntryId);
      const summaryParentLandingId =
        stableGraphCache.stableCoordinateId(summaryParentId);
      if (
        summaryLandingId !== summaryEntryId ||
        landingId !== summaryLandingId ||
        summaryParentLandingId === undefined ||
        summaryParentLandingId !== expectation.expectedDestinationId
      ) {
        return undefined;
      }
      return Object.freeze({
        kind: "summary",
        landingId,
        summaryEntryId,
        summaryParentLandingId,
      });
    },
    hasSameIdentityAs(other) {
      return sameIdentity(snapshot, other);
    },
    isSameSnapshotAs(other) {
      return sameSnapshot(snapshot, other);
    },
    isAppendOnlyExtensionOf(previous) {
      return isAppendOnlyExtension(snapshot, previous);
    },
    isNaturalDescendantOf(previous, ancestorEntryId, descendantEntryId) {
      if (!isAppendOnlyExtension(snapshot, previous)) return false;

      const descendant = visibleEntry(graph, entryCount, descendantEntryId);
      if (
        descendant === undefined ||
        publicEntryIsTransparent(descendant) ||
        snapshotEntry(previous, descendantEntryId) !== undefined
      ) {
        return false;
      }
      if (ancestorEntryId !== null) {
        const ancestor = snapshotEntry(previous, ancestorEntryId);
        if (ancestor === undefined || publicEntryIsTransparent(ancestor)) {
          return false;
        }
      }

      const descendantIndex = activeBranchIds.indexOf(descendantEntryId);
      if (descendantIndex < 0) return false;
      for (let index = descendantIndex; index >= 0; index -= 1) {
        const entry = visibleEntry(graph, entryCount, activeBranchIds[index]!);
        if (entry === undefined) return false;
        if (
          !publicEntryIsTransparent(entry) &&
          snapshotEntry(previous, entry.id) !== undefined
        ) {
          return entry.id === ancestorEntryId;
        }
      }
      return ancestorEntryId === null;
    },
  };
  snapshotStates.set(snapshot, { graph, entryCount, activeBranchIds });
  return Object.freeze(snapshot);
}

/**
 * Capture and validate the complete security-relevant Pi session projection.
 */
export function readSessionView(context: ExtensionContext): SessionView {
  const manager = context.sessionManager;
  const identity = readSessionIdentity(manager);
  const observation = readPublicTreeObservation(manager);
  const finalIdentity = readSessionIdentity(manager);
  if (!sameIdentity(identity, finalIdentity)) {
    throw new Error("Pi session identity changed during observation");
  }
  const { entries, branch, leafId } = observation;
  validateCompleteActiveBranch(entries, branch, leafId);
  const graph = createTrustedGraph(entries);
  return createSessionView(identity, graph, entries.length, leafId, branch);
}

/**
 * Amortized observer for Pi's documented append-only SessionManager contract.
 *
 * A full bootstrap authenticates every retained branch. Ordinary observations
 * then authenticate only the current identity, leaf, newly appended parent
 * suffix, and the known immutable anchor it joins. Full revalidation remains
 * available for registration cutovers and session replacement boundaries.
 */
export class SessionViewTracker {
  #current: SessionView | undefined;

  bootstrap(context: ExtensionContext): SessionView {
    const snapshot = readSessionView(context);
    this.#current = snapshot;
    return snapshot;
  }

  revalidate(context: ExtensionContext): SessionView {
    return this.bootstrap(context);
  }

  observe(context: ExtensionContext): SessionView {
    const previous = this.#current;
    if (previous === undefined) return this.bootstrap(context);

    const manager = context.sessionManager;
    const identity = readSessionIdentity(manager);
    if (!sameIdentity(identity, previous)) {
      throw new Error("Pi session identity changed between lifecycle events");
    }
    const state = snapshotStates.get(previous);
    if (
      state === undefined ||
      state.entryCount !== state.graph.entries.length
    ) {
      throw new Error("trusted Pi session graph is unavailable");
    }
    const { graph, entryCount, activeBranchIds } = state;
    const { branch, leafId } = readPublicActiveBranch(manager);
    const finalIdentity = readSessionIdentity(manager);
    if (!sameIdentity(identity, finalIdentity)) {
      throw new Error("Pi session identity changed during observation");
    }
    validateActiveBranchShape(branch, leafId);

    let commonCount = 0;
    const commonLimit = Math.min(activeBranchIds.length, branch.length);
    while (
      commonCount < commonLimit &&
      activeBranchIds[commonCount] === branch[commonCount]?.id
    ) {
      const known = visibleEntry(
        graph,
        entryCount,
        activeBranchIds[commonCount]!,
      );
      if (known === undefined || !sameEntry(known, branch[commonCount])) {
        throw new Error("Pi changed a retained session entry");
      }
      commonCount += 1;
    }

    // Any shortening/divergence is a branch movement or the revelation of an
    // older inactive sibling. Rebuild once from getEntries() so append order
    // remains Pi's documented order rather than an inferred one.
    if (commonCount !== activeBranchIds.length) {
      return this.revalidate(context);
    }

    // Identity, leaf, branch shape, and every retained public entry have all
    // been authenticated above. Reuse the immutable snapshot when the branch
    // has no suffix so its lazy projections remain reusable as well.
    if (commonCount === branch.length) return previous;

    const suffix = branch.slice(commonCount);
    for (const entry of suffix) {
      if (graph.byId.has(entry.id)) return this.revalidate(context);
    }
    for (const entry of suffix) {
      const index = graph.entries.length;
      graph.entries.push(entry);
      graph.byId.set(entry.id, { entry, index });
    }
    const snapshot = createSessionView(
      identity,
      graph,
      graph.entries.length,
      leafId,
      branch,
    );
    this.#current = snapshot;
    return snapshot;
  }
}
