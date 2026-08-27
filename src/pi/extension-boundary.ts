import type {
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

/** The read-only session surface Pi deliberately exposes to extensions. */
export type PiReadonlySessionManager = ExtensionContext["sessionManager"];

/**
 * Host details retained by the adapter.  The rest of Cyclotomy treats entries
 * as coordinates and does not need Pi's concrete entry union.
 */
export interface PublicSessionEntry {
  readonly id: string;
  readonly parentId: string | null;
  readonly type: string;
  readonly messageRole: string | null;
}

/**
 * A checkpoint coordinate derived solely from Pi's public entry projection.
 * Transparent host entries do not appear here; their nearest stable ancestor
 * is carried into their stable descendants as `stableParentId`.
 */
export interface StableCoordinate {
  readonly id: string;
  readonly stableParentId: string | null;
  readonly type: string;
  readonly messageRole: string | null;
}

type EntrySemantics = {
  readonly coordinate: "stable" | "transparent";
  readonly selection: "self" | "parent";
  readonly treeArrival: "ordinary" | "summary";
};

type KnownEntryType = SessionEntry["type"];

const STABLE_SELF_SEMANTICS = {
  coordinate: "stable",
  selection: "self",
  treeArrival: "ordinary",
} as const satisfies EntrySemantics;
const STABLE_PARENT_SEMANTICS = {
  coordinate: "stable",
  selection: "parent",
  treeArrival: "ordinary",
} as const satisfies EntrySemantics;
const TRANSPARENT_SELF_SEMANTICS = {
  coordinate: "transparent",
  selection: "self",
  treeArrival: "ordinary",
} as const satisfies EntrySemantics;
const TREE_SUMMARY_SEMANTICS = {
  coordinate: "stable",
  selection: "self",
  treeArrival: "summary",
} as const satisfies EntrySemantics;

/**
 * `satisfies Record<SessionEntry["type"], ...>` is intentional: a new member
 * in Pi's public union makes the locked/latest type-check ask us to classify
 * it.  Runtime values outside that union remain forward-compatible opaque
 * coordinates below.
 */
const KNOWN_ENTRY_SEMANTICS = {
  message: STABLE_SELF_SEMANTICS,
  thinking_level_change: STABLE_SELF_SEMANTICS,
  model_change: STABLE_SELF_SEMANTICS,
  compaction: STABLE_SELF_SEMANTICS,
  branch_summary: TREE_SUMMARY_SEMANTICS,
  custom: STABLE_SELF_SEMANTICS,
  custom_message: STABLE_PARENT_SEMANTICS,
  label: TRANSPARENT_SELF_SEMANTICS,
  session_info: STABLE_SELF_SEMANTICS,
} satisfies Record<KnownEntryType, EntrySemantics>;

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

function requireSafeString(value: unknown, description: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`Pi ${description} is not a safe non-empty string`);
  }
  return value;
}

function semanticsFor(
  type: string,
  messageRole: string | null,
): EntrySemantics {
  if (!Object.hasOwn(KNOWN_ENTRY_SEMANTICS, type)) {
    // An entry added by a future Pi remains a usable opaque coordinate.  Its
    // special semantics, if any, must arrive through a reviewed public API and
    // the latest-host probe rather than an internal implementation guess.
    return STABLE_SELF_SEMANTICS;
  }
  const known = KNOWN_ENTRY_SEMANTICS[type as KnownEntryType];
  return type === "message" && messageRole === "user"
    ? STABLE_PARENT_SEMANTICS
    : known;
}

/** Validate and detach one entry returned by Pi's public read-only API. */
export function projectPublicSessionEntry(value: unknown): PublicSessionEntry {
  if (!isRecord(value)) {
    throw new Error("Pi session contains a non-object entry");
  }
  const id = requireSafeString(Reflect.get(value, "id"), "entry id");
  const rawParentId = Reflect.get(value, "parentId");
  const parentId =
    rawParentId === null
      ? null
      : requireSafeString(rawParentId, "entry parent id");
  const type = requireSafeString(Reflect.get(value, "type"), "entry type");

  let messageRole: string | null = null;
  if (type === "message") {
    const message = Reflect.get(value, "message");
    if (!isRecord(message)) {
      throw new Error("Pi message entry does not contain a message object");
    }
    messageRole = requireSafeString(
      Reflect.get(message, "role"),
      "message role",
    );
  }

  return Object.freeze({ id, parentId, type, messageRole });
}

export function publicEntryIsTransparent(entry: PublicSessionEntry): boolean {
  return (
    semanticsFor(entry.type, entry.messageRole).coordinate === "transparent"
  );
}

export function publicEntrySelectionLanding(
  entry: PublicSessionEntry,
): string | null {
  const semantics = semanticsFor(entry.type, entry.messageRole);
  return semantics.selection === "parent" ? entry.parentId : entry.id;
}

/** Pi's reviewed public semantic for the entry created by tree summarization. */
export function publicEntryIsTreeSummary(entry: PublicSessionEntry): boolean {
  return semanticsFor(entry.type, entry.messageRole).treeArrival === "summary";
}

/**
 * Immutable index of one complete stable-coordinate projection.
 *
 * Both active and inactive ancestry queries use this same graph. Parent order
 * is authenticated while the index is built, so traversal needs neither a
 * heuristic hop limit nor a second interpretation of Pi entry semantics.
 */
export interface StableGraphProjection {
  readonly coordinates: readonly StableCoordinate[];
  /** undefined means the raw entry is absent from this projection. */
  stableCoordinateId(entryId: string | null): string | null | undefined;
  /** Root-to-coordinate stable ancestry; undefined means the raw entry is absent. */
  stableAncestryIds(entryId: string | null): readonly string[] | undefined;
}

/**
 * Collapse a validated public append-order graph into checkpoint coordinates.
 *
 * The function validates the ordering facts it consumes as well, so live and
 * cold callers cannot accidentally obtain different coordinate semantics by
 * validating their public observations differently.
 */
export function projectStableGraph(
  entries: readonly PublicSessionEntry[],
): StableGraphProjection {
  const nearestStable = new Map<string, string | null>();
  const stableParentById = new Map<string, string | null>();
  const coordinates: StableCoordinate[] = [];
  for (const entry of entries) {
    if (nearestStable.has(entry.id)) {
      throw new Error("Pi session contains a duplicate entry id");
    }
    const stableParentId =
      entry.parentId === null ? null : nearestStable.get(entry.parentId);
    if (stableParentId === undefined) {
      throw new Error(
        "Pi session contains an unknown or forward parent reference",
      );
    }
    if (publicEntryIsTransparent(entry)) {
      nearestStable.set(entry.id, stableParentId);
      continue;
    }
    nearestStable.set(entry.id, entry.id);
    stableParentById.set(entry.id, stableParentId);
    coordinates.push(
      Object.freeze({
        id: entry.id,
        stableParentId,
        type: entry.type,
        messageRole: entry.messageRole,
      }),
    );
  }
  const frozenCoordinates = Object.freeze(coordinates);
  return Object.freeze({
    coordinates: frozenCoordinates,
    stableCoordinateId(entryId: string | null) {
      if (entryId === null) return null;
      return nearestStable.has(entryId)
        ? nearestStable.get(entryId)
        : undefined;
    },
    stableAncestryIds(entryId: string | null) {
      if (entryId === null) return Object.freeze([]);
      if (!nearestStable.has(entryId)) return undefined;
      let current = nearestStable.get(entryId) ?? null;
      const reversed: string[] = [];
      while (current !== null) {
        reversed.push(current);
        // Every stable parent was authenticated as an earlier coordinate when
        // this projection was constructed; absence is therefore impossible.
        current = stableParentById.get(current) ?? null;
      }
      reversed.reverse();
      return Object.freeze(reversed);
    },
  });
}

function indexStableCoordinates(
  coordinates: readonly StableCoordinate[],
): ReadonlyMap<
  string,
  { readonly coordinate: StableCoordinate; readonly index: number }
> {
  const byId = new Map<
    string,
    { readonly coordinate: StableCoordinate; readonly index: number }
  >();
  for (const [index, coordinate] of coordinates.entries()) {
    if (byId.has(coordinate.id)) {
      throw new Error(
        "Pi stable coordinate projection contains a duplicate id",
      );
    }
    if (
      coordinate.stableParentId !== null &&
      !byId.has(coordinate.stableParentId)
    ) {
      throw new Error(
        "Pi stable coordinate projection contains an unknown or forward parent",
      );
    }
    byId.set(coordinate.id, { coordinate, index });
  }
  return byId;
}

/**
 * Prove the ordered, ancestry-closed intersection of two public projections.
 * IDs are never mapped or predicted: changed and child-only coordinates are
 * omitted for the metadata finalizer to verify conservatively.
 */
export function provenStableCoordinateIds(
  source: readonly StableCoordinate[],
  child: readonly StableCoordinate[],
): readonly string[] {
  const sourceById = indexStableCoordinates(source);
  indexStableCoordinates(child);

  const proven = new Set<string>();
  const ids: string[] = [];
  let lastSourceIndex = -1;
  for (const childCoordinate of child) {
    const sourceEntry = sourceById.get(childCoordinate.id);
    if (sourceEntry === undefined) continue;
    const { coordinate: sourceCoordinate, index } = sourceEntry;
    if (
      childCoordinate.type !== sourceCoordinate.type ||
      childCoordinate.messageRole !== sourceCoordinate.messageRole ||
      childCoordinate.stableParentId !== sourceCoordinate.stableParentId ||
      (childCoordinate.stableParentId !== null &&
        !proven.has(childCoordinate.stableParentId)) ||
      index <= lastSourceIndex
    ) {
      continue;
    }
    proven.add(childCoordinate.id);
    ids.push(childCoordinate.id);
    lastSourceIndex = index;
  }
  return Object.freeze(ids);
}

export interface PublicTreeObservation {
  readonly entries: readonly PublicSessionEntry[];
  readonly branch: readonly PublicSessionEntry[];
  readonly leafId: string | null;
}

/** Validate the complete retained public graph before asking Pi to walk it. */
export function validatePublicEntryGraph(
  entries: readonly PublicSessionEntry[],
): void {
  const indexById = new Map<string, number>();
  for (const [index, entry] of entries.entries()) {
    if (indexById.has(entry.id)) {
      throw new Error("Pi session contains a duplicate entry id");
    }
    indexById.set(entry.id, index);
  }

  // Zero represents a root; every parent index is stored one-based so the
  // complete graph can be validated with compact indexed state.
  const parentIndexPlusOne = new Uint32Array(entries.length);
  for (const [index, entry] of entries.entries()) {
    if (entry.parentId === null) continue;
    const parentIndex = indexById.get(entry.parentId);
    if (parentIndex === undefined) {
      throw new Error("Pi session contains an orphaned parent reference");
    }
    parentIndexPlusOne[index] = parentIndex + 1;
  }

  // 0 = unseen, 1 = visiting in the current walk, 2 = complete. A single
  // reusable path replaces one Set allocation per retained entry while
  // preserving cycle diagnostics before append-order diagnostics.
  const state = new Uint8Array(entries.length);
  const path: number[] = [];
  for (let start = 0; start < entries.length; start += 1) {
    if (state[start] !== 0) continue;
    let index: number | undefined = start;
    while (index !== undefined && state[index] === 0) {
      state[index] = 1;
      path.push(index);
      const parent: number = parentIndexPlusOne[index]!;
      index = parent === 0 ? undefined : parent - 1;
    }
    if (index !== undefined && state[index] === 1) {
      throw new Error("Pi session contains a parent cycle");
    }
    for (const visited of path) state[visited] = 2;
    path.length = 0;
  }

  // Pi's persisted log is append-only, so every parent must precede its child.
  // Besides rejecting rewrites, this makes every observed prefix self-contained.
  for (let index = 0; index < parentIndexPlusOne.length; index += 1) {
    const parent = parentIndexPlusOne[index]!;
    if (parent !== 0 && parent - 1 >= index) {
      throw new Error("Pi session contains a parent that follows its child");
    }
  }
}

function readLeafId(manager: PiReadonlySessionManager): string | null {
  const value: unknown = manager.getLeafId();
  return value === null ? null : requireSafeString(value, "session leaf id");
}

function readEntryArray(value: unknown, description: string) {
  if (!Array.isArray(value)) {
    throw new Error(`Pi session ${description} is not an array`);
  }
  return Object.freeze(Array.from(value, projectPublicSessionEntry));
}

/**
 * Make one synchronous observation through one captured read-only manager.
 * The two leaf reads reject a host mutation that straddles its public calls.
 */
export function readPublicTreeObservation(
  manager: PiReadonlySessionManager,
): PublicTreeObservation {
  const leafId = readLeafId(manager);
  const entries = readEntryArray(manager.getEntries(), "entries");
  // `getBranch()` necessarily walks the retained parent graph. Authenticate
  // that graph first so malformed public data cannot make the host traversal
  // loop or obscure the structural error we can report directly.
  validatePublicEntryGraph(entries);
  const branch = readEntryArray(manager.getBranch(), "active branch");
  if (readLeafId(manager) !== leafId) {
    throw new Error("Pi session leaf changed during observation");
  }
  return Object.freeze({ entries, branch, leafId });
}

/** Lighter observation used after a fully authenticated bootstrap. */
export function readPublicActiveBranch(
  manager: PiReadonlySessionManager,
): Pick<PublicTreeObservation, "branch" | "leafId"> {
  const leafId = readLeafId(manager);
  const branch = readEntryArray(manager.getBranch(), "active branch");
  if (readLeafId(manager) !== leafId) {
    throw new Error("Pi session leaf changed during observation");
  }
  return Object.freeze({ branch, leafId });
}
