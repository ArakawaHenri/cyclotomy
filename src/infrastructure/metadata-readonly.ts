import { lstatSync, type BigIntStats } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  CURRENT_METADATA_VERSION,
  METADATA_VERSIONS,
} from "./metadata/current.ts";
import {
  legacySessionProjection,
  readSessionHistoryFingerprint,
} from "./metadata/history.ts";
import { validateMetadataVersion } from "./metadata/version.ts";
import { MetadataError } from "./metadata-error.ts";
import { systemErrorCode } from "./system-error.ts";

/**
 * Read-only metadata diagnostics for the maintenance CLI.
 *
 * The reader never migrates, repairs, VACUUMs, writes a PRAGMA or opens the
 * store through SQLite's `immutable=1` URI: bypassing coordination could
 * report a state no writer ever committed. Every durable outcome below is a
 * structured value; a thrown error only signals a programming mistake.
 */

const BUSY_TIMEOUT_MS = 250;
const MIN_READABLE_VERSION = METADATA_VERSIONS[0]!.version;
/** V5 adds session_history; older versions must not be probed for it. */
const SESSION_HISTORY_VERSION = 5;
const CURSOR_VERSION = 1;
const MAX_CURSOR_LENGTH = 1_024;

export const SESSION_HISTORY_PAGE_DEFAULT_SIZE = 50;
export const SESSION_HISTORY_PAGE_MAX_SIZE = 500;

export interface MetadataSidecarFile {
  readonly name: "state.db-journal" | "state.db-shm";
  readonly bytes: bigint;
}

/**
 * Generic physical observations, available even for a store this build cannot
 * interpret. `walBytes` is 0n when the sidecar is verifiably absent and null
 * when it could not be inspected; page statistics stay null until a read-only
 * connection succeeds.
 */
export interface MetadataPhysicalObservation {
  readonly fileBytes: bigint | null;
  /** Allocated 512-byte blocks from lstat; null where the platform omits them. */
  readonly allocatedBlocks: bigint | null;
  readonly walBytes: bigint | null;
  readonly journalBytes: bigint | null;
  readonly otherSidecarFiles: readonly MetadataSidecarFile[];
  readonly pageSizeBytes: number | null;
  readonly pageCount: number | null;
  readonly freelistCount: number | null;
}

export interface MetadataReadonlyReadyStatus {
  readonly kind: "ready";
}

export type MetadataReadonlyUnavailableStatus =
  | { readonly kind: "absent" }
  | { readonly kind: "uninitialized"; readonly detail: string }
  | { readonly kind: "needs-recovery"; readonly detail: string }
  | { readonly kind: "unreadable"; readonly detail: string }
  | { readonly kind: "busy"; readonly detail: string }
  | {
      readonly kind: "too-new";
      readonly version: number;
      readonly supportedVersion: number;
    }
  | {
      readonly kind: "unsupported-version";
      readonly version: number;
      readonly supportedVersion: number;
      readonly detail: string;
    }
  | {
      readonly kind: "unexpected-shape";
      readonly version: number;
      readonly supportedVersion: number;
      readonly detail: string;
    };

export type MetadataReadonlyStatus =
  MetadataReadonlyReadyStatus | MetadataReadonlyUnavailableStatus;

export interface SessionScaleStats {
  readonly sessionId: string;
  readonly sessionFile: string | null;
  readonly registrationState: "pending" | "verified" | null;
  readonly totalSlotCount: number;
  readonly checkpointedSlotCount: number;
  readonly blockedSlotCount: number;
  readonly distinctTreeOidCount: number;
  /** Present only on V5 stores; null when session_history does not exist. */
  readonly historyEpoch: number | null;
  readonly resetPending: boolean | null;
  /**
   * No durable last-capture timestamp exists in the metadata schema, so this
   * stays unknown instead of being inferred from Pi JSONL mtimes.
   */
  readonly lastCaptureAt: null;
}

export interface StoreSlotTotals {
  readonly totalSlotCount: number;
  readonly checkpointedSlotCount: number;
  readonly blockedSlotCount: number;
  readonly distinctTreeOidCount: number;
}

export interface MetadataOverview {
  readonly sessionCount: number;
  readonly slots: StoreSlotTotals;
}

export interface SessionHistoryTotals extends StoreSlotTotals {
  /** Totals are computed inside the same read transaction as the page. */
  readonly exactness: "exact";
  readonly sessionCount: number;
}

export interface SessionStatsPage {
  readonly sessions: readonly SessionScaleStats[];
  readonly pageSize: number;
  readonly hasMore: boolean;
  /** Opaque continuation; null when this page is the last. */
  readonly nextCursor: string | null;
  readonly totals: SessionHistoryTotals;
}

export interface SessionHistoryPageRequest {
  readonly pageSize?: number | undefined;
  readonly cursor?: string | null | undefined;
}

/** Read-only queries valid only while the surrounding read transaction lives. */
export interface ReadonlyMetadataQueries {
  readonly version: number;
  overview(): MetadataOverview;
  sessionPage(request?: SessionHistoryPageRequest): SessionStatsPage;
  session(sessionId: string): SessionScaleStats | null;
  sessionCaptureBarrier(sessionId: string): boolean;
  sessionFingerprint(sessionId: string): string | undefined;
}

export interface MetadataReadonlyObservation {
  readonly version: number | null;
  readonly supportedVersion: number;
  readonly physical: MetadataPhysicalObservation;
}

/**
 * `data` is present exactly when `status.kind === "ready"`; every other status
 * carries null data so an unavailable store is never rendered as empty facts.
 */
export type MetadataReadonlyResult<T> =
  | (MetadataReadonlyObservation & {
      readonly status: MetadataReadonlyReadyStatus;
      readonly sessionHistoryAvailable: boolean;
      readonly data: T;
    })
  | (MetadataReadonlyObservation & {
      readonly status: MetadataReadonlyUnavailableStatus;
      readonly sessionHistoryAvailable: null;
      readonly data: null;
    });

interface SidecarObservation {
  readonly present: boolean;
  /** 0n when verifiably absent, the size when present, null when unreadable. */
  readonly bytes: bigint | null;
}

type DatabaseFileObservation =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly detail: string }
  | {
      readonly kind: "file";
      readonly bytes: bigint;
      readonly blocks: bigint | null;
    };

type UserVersionObservation =
  | { readonly kind: "version"; readonly version: number }
  | { readonly kind: "invalid"; readonly detail: string };

interface PageStats {
  readonly pageSizeBytes: number;
  readonly pageCount: number;
  readonly freelistCount: number;
}

type PageStatsObservation =
  | ({ readonly kind: "ok" } & PageStats)
  | { readonly kind: "unreadable"; readonly detail: string };

type ShapeObservation =
  | { readonly kind: "ok"; readonly sessionHistoryAvailable: boolean }
  | { readonly kind: "unexpected"; readonly detail: string };

/** A value that violates the validated schema shape; the store is unreadable. */
class MetadataReadonlyValueError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "MetadataReadonlyValueError";
  }
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function observeDatabaseFile(path: string): DatabaseFileObservation {
  let entry: BigIntStats;
  try {
    entry = lstatSync(path, { bigint: true });
  } catch (error) {
    return systemErrorCode(error) === "ENOENT"
      ? { kind: "absent" }
      : { kind: "invalid", detail: detailOf(error) };
  }
  if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1n) {
    return {
      kind: "invalid",
      detail: "the metadata database is not a single-link regular file",
    };
  }
  return {
    kind: "file",
    bytes: entry.size,
    blocks: entry.blocks > 0n ? entry.blocks : null,
  };
}

function observeSidecar(path: string): SidecarObservation {
  let entry: BigIntStats;
  try {
    entry = lstatSync(path, { bigint: true });
  } catch (error) {
    return systemErrorCode(error) === "ENOENT"
      ? { present: false, bytes: 0n }
      : { present: false, bytes: null };
  }
  // A non-regular sidecar still makes the database unusable for reading, so it
  // counts as present and forces the recovery outcome.
  if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1n) {
    return { present: true, bytes: null };
  }
  return { present: true, bytes: entry.size };
}

function physicalObservation(
  database: DatabaseFileObservation,
  journal: SidecarObservation,
  wal: SidecarObservation,
  shm: SidecarObservation,
): MetadataPhysicalObservation {
  const otherSidecarFiles: MetadataSidecarFile[] = [];
  if (journal.present && journal.bytes !== null) {
    otherSidecarFiles.push({
      name: "state.db-journal",
      bytes: journal.bytes,
    });
  }
  if (shm.present && shm.bytes !== null) {
    otherSidecarFiles.push({ name: "state.db-shm", bytes: shm.bytes });
  }
  return Object.freeze({
    fileBytes: database.kind === "file" ? database.bytes : null,
    allocatedBlocks: database.kind === "file" ? database.blocks : null,
    walBytes: wal.bytes,
    journalBytes: journal.bytes,
    otherSidecarFiles: Object.freeze(otherSidecarFiles),
    pageSizeBytes: null,
    pageCount: null,
    freelistCount: null,
  });
}

function absentPhysical(): MetadataPhysicalObservation {
  return Object.freeze({
    fileBytes: null,
    allocatedBlocks: null,
    walBytes: null,
    journalBytes: null,
    otherSidecarFiles: Object.freeze([]),
    pageSizeBytes: null,
    pageCount: null,
    freelistCount: null,
  });
}

function withPageStats(
  physical: MetadataPhysicalObservation,
  page: PageStats,
): MetadataPhysicalObservation {
  return Object.freeze({
    ...physical,
    pageSizeBytes: page.pageSizeBytes,
    pageCount: page.pageCount,
    freelistCount: page.freelistCount,
  });
}

function unavailable<T>(
  status: MetadataReadonlyUnavailableStatus,
  version: number | null,
  supportedVersion: number,
  physical: MetadataPhysicalObservation,
): MetadataReadonlyResult<T> {
  return Object.freeze({
    status,
    version,
    supportedVersion,
    physical,
    sessionHistoryAvailable: null,
    data: null,
  });
}

function readUserVersion(db: DatabaseSync): UserVersionObservation {
  const row = db.prepare("PRAGMA user_version").get() as
    { readonly user_version?: unknown } | undefined;
  const raw = row?.user_version;
  const version = typeof raw === "bigint" ? Number(raw) : raw;
  if (
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version < 0
  ) {
    return {
      kind: "invalid",
      detail: "the database does not report a usable schema version",
    };
  }
  return { kind: "version", version };
}

function readPageStats(db: DatabaseSync): PageStatsObservation {
  try {
    const read = (pragma: string): number => {
      const row = db.prepare(`PRAGMA ${pragma}`).get() as
        Record<string, unknown> | undefined;
      const value = row?.[pragma];
      const numeric = typeof value === "bigint" ? Number(value) : value;
      if (
        typeof numeric !== "number" ||
        !Number.isSafeInteger(numeric) ||
        numeric < 0
      ) {
        throw new MetadataReadonlyValueError(
          `the database reports an invalid ${pragma}`,
        );
      }
      return numeric;
    };
    return {
      kind: "ok",
      pageSizeBytes: read("page_size"),
      pageCount: read("page_count"),
      freelistCount: read("freelist_count"),
    };
  } catch (error) {
    return { kind: "unreadable", detail: detailOf(error) };
  }
}

function validateReadableShape(
  db: DatabaseSync,
  version: number,
): ShapeObservation {
  try {
    validateMetadataVersion(db, METADATA_VERSIONS[version - 1]!);
    return {
      kind: "ok",
      sessionHistoryAvailable: version >= SESSION_HISTORY_VERSION,
    };
  } catch (cause) {
    if (!(cause instanceof MetadataError)) throw cause;
    return { kind: "unexpected", detail: cause.message };
  }
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new MetadataReadonlyValueError(`metadata field ${field} is not text`);
  }
  return value;
}

function requireCount(value: unknown, field: string): number {
  const numeric = typeof value === "bigint" ? Number(value) : value;
  if (
    typeof numeric !== "number" ||
    !Number.isSafeInteger(numeric) ||
    numeric < 0
  ) {
    throw new MetadataReadonlyValueError(
      `metadata field ${field} is not a non-negative safe integer`,
    );
  }
  return numeric;
}

function sessionStatsFromRow(row: Record<string, unknown>): SessionScaleStats {
  const resetPending = row.reset_pending;
  if (
    resetPending !== null &&
    resetPending !== undefined &&
    resetPending !== 0 &&
    resetPending !== 1
  ) {
    throw new MetadataReadonlyValueError(
      "metadata field reset_pending is not 0 or 1",
    );
  }
  const registrationState = row.registration_state;
  return Object.freeze({
    sessionId: requireText(row.session_id, "session_id"),
    sessionFile:
      row.session_file === null || row.session_file === undefined
        ? null
        : requireText(row.session_file, "session_file"),
    registrationState:
      registrationState === "pending" || registrationState === "verified"
        ? registrationState
        : null,
    totalSlotCount: requireCount(row.total_slot_count, "total_slot_count"),
    checkpointedSlotCount: requireCount(
      row.checkpointed_slot_count,
      "checkpointed_slot_count",
    ),
    blockedSlotCount: requireCount(
      row.blocked_slot_count,
      "blocked_slot_count",
    ),
    distinctTreeOidCount: requireCount(
      row.distinct_tree_oid_count,
      "distinct_tree_oid_count",
    ),
    historyEpoch:
      row.history_epoch === null || row.history_epoch === undefined
        ? null
        : requireCount(row.history_epoch, "history_epoch"),
    resetPending:
      resetPending === null || resetPending === undefined
        ? null
        : resetPending === 1,
    lastCaptureAt: null,
  });
}

function encodeCursor(sessionId: string): string {
  return Buffer.from(
    JSON.stringify({ v: CURSOR_VERSION, after: sessionId }),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(cursor: string | null | undefined): string | null {
  if (cursor === null || cursor === undefined) return null;
  if (
    typeof cursor !== "string" ||
    cursor.length === 0 ||
    cursor.length > MAX_CURSOR_LENGTH
  ) {
    throw new RangeError("invalid session history cursor");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new RangeError("invalid session history cursor");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RangeError("invalid session history cursor");
  }
  const version = Reflect.get(parsed, "v");
  const after = Reflect.get(parsed, "after");
  if (
    version !== CURSOR_VERSION ||
    typeof after !== "string" ||
    after.length === 0
  ) {
    throw new RangeError("invalid session history cursor");
  }
  return after;
}

function normalizePageSize(pageSize: number | undefined): number {
  const resolved = pageSize ?? SESSION_HISTORY_PAGE_DEFAULT_SIZE;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 1 ||
    resolved > SESSION_HISTORY_PAGE_MAX_SIZE
  ) {
    throw new RangeError(
      `session history page size must be between 1 and ${SESSION_HISTORY_PAGE_MAX_SIZE}`,
    );
  }
  return resolved;
}

function buildQueries(
  db: DatabaseSync,
  version: number,
): ReadonlyMetadataQueries {
  const sessionHistoryAvailable = version >= SESSION_HISTORY_VERSION;
  const legacyProjection = legacySessionProjection(version);
  const ctes = legacyProjection === undefined ? "" : `${legacyProjection}, `;
  const selectPrefix =
    legacyProjection === undefined ? "" : `WITH ${legacyProjection} `;
  const registrationState =
    version < 3
      ? "CASE WHEN registry.session_id IS NULL THEN NULL ELSE 'pending' END"
      : "registry.registration_state";
  const historyUnion = sessionHistoryAvailable
    ? "\n        UNION SELECT session_id FROM session_history"
    : "";
  const universeSql = `SELECT session_id FROM session_registry
        UNION SELECT session_id FROM checkpoint_slot${historyUnion}`;
  const historyColumns = sessionHistoryAvailable
    ? `registry.session_file AS session_file,
        ${registrationState} AS registration_state,
        history.history_epoch AS history_epoch,
        history.reset_pending AS reset_pending,`
    : `registry.session_file AS session_file,
        ${registrationState} AS registration_state,
        NULL AS history_epoch,
        NULL AS reset_pending,`;
  const perSessionCounts = (owner: string): string => `
        (SELECT COUNT(*) FROM checkpoint_slot slot
          WHERE slot.session_id = ${owner}) AS total_slot_count,
        (SELECT COUNT(*) FROM checkpoint_slot slot
          WHERE slot.session_id = ${owner} AND slot.tree_oid IS NOT NULL)
          AS checkpointed_slot_count,
        (SELECT COUNT(*) FROM checkpoint_slot slot
          WHERE slot.session_id = ${owner} AND slot.capture_state = 'blocked')
          AS blocked_slot_count,
        (SELECT COUNT(DISTINCT slot.tree_oid) FROM checkpoint_slot slot
          WHERE slot.session_id = ${owner} AND slot.tree_oid IS NOT NULL)
          AS distinct_tree_oid_count`;

  const totalsSql = `WITH ${ctes}universe(session_id) AS (${universeSql})
      SELECT
        (SELECT COUNT(*) FROM universe) AS session_count,
        (SELECT COUNT(*) FROM checkpoint_slot) AS slot_count,
        (SELECT COUNT(*) FROM checkpoint_slot WHERE tree_oid IS NOT NULL)
          AS checkpointed_slot_count,
        (SELECT COUNT(*) FROM checkpoint_slot WHERE capture_state = 'blocked')
          AS blocked_slot_count,
        (SELECT COUNT(DISTINCT tree_oid) FROM checkpoint_slot
          WHERE tree_oid IS NOT NULL) AS distinct_tree_oid_count`;

  const readTotals = (): SessionHistoryTotals => {
    const row = db.prepare(totalsSql).get() as Record<string, unknown>;
    return Object.freeze({
      exactness: "exact" as const,
      sessionCount: requireCount(row.session_count, "session_count"),
      totalSlotCount: requireCount(row.slot_count, "slot_count"),
      checkpointedSlotCount: requireCount(
        row.checkpointed_slot_count,
        "checkpointed_slot_count",
      ),
      blockedSlotCount: requireCount(
        row.blocked_slot_count,
        "blocked_slot_count",
      ),
      distinctTreeOidCount: requireCount(
        row.distinct_tree_oid_count,
        "distinct_tree_oid_count",
      ),
    });
  };

  return Object.freeze({
    version,
    overview(): MetadataOverview {
      const row = db.prepare(totalsSql).get() as Record<string, unknown>;
      return Object.freeze({
        sessionCount: requireCount(row.session_count, "session_count"),
        slots: Object.freeze({
          totalSlotCount: requireCount(row.slot_count, "slot_count"),
          checkpointedSlotCount: requireCount(
            row.checkpointed_slot_count,
            "checkpointed_slot_count",
          ),
          blockedSlotCount: requireCount(
            row.blocked_slot_count,
            "blocked_slot_count",
          ),
          distinctTreeOidCount: requireCount(
            row.distinct_tree_oid_count,
            "distinct_tree_oid_count",
          ),
        }),
      });
    },

    sessionPage(request?: SessionHistoryPageRequest): SessionStatsPage {
      const pageSize = normalizePageSize(request?.pageSize);
      const after = decodeCursor(request?.cursor);
      const pageJoin = sessionHistoryAvailable
        ? "LEFT JOIN session_history history ON history.session_id = page.session_id"
        : "";
      const rows = db
        .prepare(
          `WITH ${ctes}universe(session_id) AS (${universeSql}),
           page(session_id) AS (
             SELECT session_id FROM universe
             WHERE session_id > ? ORDER BY session_id LIMIT ?
           )
           SELECT page.session_id AS session_id,
             ${historyColumns}
             ${perSessionCounts("page.session_id")}
           FROM page
           LEFT JOIN session_registry registry
             ON registry.session_id = page.session_id
           ${pageJoin}
           ORDER BY page.session_id`,
        )
        .all(after ?? "", pageSize + 1) as unknown as Record<string, unknown>[];
      const hasMore = rows.length > pageSize;
      const sessions = Object.freeze(
        rows.slice(0, pageSize).map(sessionStatsFromRow),
      );
      const last = sessions.at(-1);
      return Object.freeze({
        sessions,
        pageSize,
        hasMore,
        nextCursor:
          hasMore && last !== undefined ? encodeCursor(last.sessionId) : null,
        totals: readTotals(),
      });
    },

    session(sessionId: string): SessionScaleStats | null {
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        throw new RangeError("session id must be a non-empty string");
      }
      const sessionJoin = sessionHistoryAvailable
        ? "LEFT JOIN session_history history ON history.session_id = universe.session_id"
        : "";
      const row = db
        .prepare(
          `WITH ${ctes}universe(session_id) AS (${universeSql})
           SELECT universe.session_id AS session_id,
             registry.session_file AS session_file,
             ${registrationState} AS registration_state,
             ${sessionHistoryAvailable ? "history.history_epoch AS history_epoch, history.reset_pending AS reset_pending," : "NULL AS history_epoch, NULL AS reset_pending,"}
             ${perSessionCounts("universe.session_id")}
           FROM universe
           LEFT JOIN session_registry registry
             ON registry.session_id = universe.session_id
           ${sessionJoin}
           WHERE universe.session_id = ?`,
        )
        .get(sessionId) as Record<string, unknown> | undefined;
      return row === undefined ? null : sessionStatsFromRow(row);
    },

    sessionFingerprint(sessionId: string) {
      return readSessionHistoryFingerprint(db, version, sessionId);
    },

    sessionCaptureBarrier(sessionId: string): boolean {
      return (
        db
          .prepare(
            `${selectPrefix}SELECT 1 FROM session_capture_barrier WHERE session_id = ?`,
          )
          .get(sessionId) !== undefined
      );
    },
  });
}

function isSqliteFailure(error: unknown): boolean {
  return systemErrorCode(error)?.startsWith("ERR_SQLITE_") === true;
}

function databaseFailure(error: unknown): MetadataReadonlyUnavailableStatus {
  const errcode = Reflect.get(
    typeof error === "object" && error !== null ? error : {},
    "errcode",
  );
  const primary = typeof errcode === "number" ? errcode & 0xff : undefined;
  const detail = detailOf(error);
  if (primary === 5 || primary === 6) return { kind: "busy", detail };
  return { kind: "unreadable", detail };
}

export function readMetadataReadonly<T>(
  stateDbPath: string,
  read: (queries: ReadonlyMetadataQueries) => T,
): MetadataReadonlyResult<T> {
  const supportedVersion = CURRENT_METADATA_VERSION.version;
  const database = observeDatabaseFile(stateDbPath);
  if (database.kind === "absent") {
    return unavailable(
      { kind: "absent" },
      null,
      supportedVersion,
      absentPhysical(),
    );
  }
  const journal = observeSidecar(`${stateDbPath}-journal`);
  const wal = observeSidecar(`${stateDbPath}-wal`);
  const shm = observeSidecar(`${stateDbPath}-shm`);
  const physical = physicalObservation(database, journal, wal, shm);
  if (database.kind === "invalid") {
    return unavailable(
      { kind: "unreadable", detail: database.detail },
      null,
      supportedVersion,
      physical,
    );
  }
  if (journal.present || wal.present !== shm.present) {
    return unavailable(
      {
        kind: "needs-recovery",
        detail:
          "the metadata database has a journal or an unmatched WAL/SHM pair and needs recovery before it can be read",
      },
      null,
      supportedVersion,
      physical,
    );
  }

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(stateDbPath, {
      readOnly: true,
      timeout: BUSY_TIMEOUT_MS,
    });
  } catch (error) {
    if (!isSqliteFailure(error)) throw error;
    return unavailable(
      databaseFailure(error),
      null,
      supportedVersion,
      physical,
    );
  }

  let version: number | null = null;
  let observedPhysical = physical;
  try {
    db.exec("BEGIN");
    const observedVersion = readUserVersion(db);
    if (observedVersion.kind === "invalid") {
      return unavailable(
        { kind: "unreadable", detail: observedVersion.detail },
        null,
        supportedVersion,
        physical,
      );
    }
    version = observedVersion.version;
    const page = readPageStats(db);
    if (page.kind !== "ok") {
      return unavailable(
        { kind: "unreadable", detail: page.detail },
        version,
        supportedVersion,
        physical,
      );
    }
    const withPages = withPageStats(physical, page);
    observedPhysical = withPages;
    if (version > supportedVersion) {
      return unavailable(
        { kind: "too-new", version, supportedVersion },
        version,
        supportedVersion,
        withPages,
      );
    }
    if (version === 0) {
      return unavailable(
        {
          kind: "uninitialized",
          detail: "the metadata database has not been initialized",
        },
        version,
        supportedVersion,
        withPages,
      );
    }
    if (version < MIN_READABLE_VERSION) {
      return unavailable(
        {
          kind: "unsupported-version",
          version,
          supportedVersion,
          detail: `metadata schema v${version} is outside the supported history`,
        },
        version,
        supportedVersion,
        withPages,
      );
    }
    const shape = validateReadableShape(db, version);
    if (shape.kind === "unexpected") {
      return unavailable(
        {
          kind: "unexpected-shape",
          version,
          supportedVersion,
          detail: shape.detail,
        },
        version,
        supportedVersion,
        withPages,
      );
    }
    const queries = buildQueries(db, version);
    const data = read(queries);
    db.exec("COMMIT");
    return Object.freeze({
      status: Object.freeze({ kind: "ready" as const }),
      version,
      supportedVersion,
      sessionHistoryAvailable: shape.sessionHistoryAvailable,
      physical: withPages,
      data,
    });
  } catch (error) {
    if (
      error instanceof MetadataReadonlyValueError ||
      error instanceof MetadataError ||
      isSqliteFailure(error)
    ) {
      return unavailable(
        databaseFailure(error),
        version,
        supportedVersion,
        observedPhysical,
      );
    }
    throw error;
  } finally {
    try {
      db.close();
    } catch {
      // Preserve the observation or primary failure.
    }
  }
}
