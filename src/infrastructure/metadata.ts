import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { isTreeOid, type NodeState, type TreeOid } from "../domain/model.ts";

/** Persistent metadata schema; cyclotomy@0.0.1 shipped version 1. */
const METADATA_SCHEMA_VERSION = 2;
const METADATA_WRITER_PROTOCOL_FUNCTION = "cyclotomy_writer_protocol";
const OPEN_BUSY_RETRY_MS = 5_000;
const OPEN_BUSY_POLL_MS = 10;
const OPEN_WAIT_CELL = new Int32Array(new SharedArrayBuffer(4));
const SIDECAR_VALIDATION_ATTEMPTS = 64;
const SIDECAR_RETRY_MS = 2;

function normalizeSchemaSql(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\s+/gu, " ")
    .replace(/\s*([(),])\s*/gu, "$1")
    .trim()
    .toUpperCase();
}

interface ExpectedSchemaObject {
  readonly type: "index" | "table" | "trigger";
  readonly table: string;
  readonly sql: string;
}

const NODE_STATE_SCHEMA_SQL = `
  CREATE TABLE node_state(
    session_id TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    tree_oid TEXT NOT NULL,
    PRIMARY KEY(session_id, entry_id)
  ) STRICT, WITHOUT ROWID
`;

const NODE_WRITE_GUARD_SCHEMA_SQL = `
  CREATE TABLE node_write_guard(
    session_id TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    PRIMARY KEY(session_id, entry_id)
  ) STRICT, WITHOUT ROWID
`;

const SESSION_REGISTRY_V1_SCHEMA_SQL = `
  CREATE TABLE session_registry(
    session_id TEXT NOT NULL PRIMARY KEY,
    session_file TEXT NOT NULL UNIQUE,
    missing_since INTEGER,
    missing_observed_at INTEGER
  ) STRICT, WITHOUT ROWID
`;

const SESSION_REGISTRY_SCHEMA_SQL = `
  CREATE TABLE session_registry(
    session_id TEXT NOT NULL PRIMARY KEY,
    session_file TEXT NOT NULL UNIQUE,
    missing_since INTEGER,
    missing_observed_at INTEGER,
    pending_node_guard INTEGER NOT NULL DEFAULT 0
      CHECK(pending_node_guard IN (0, 1))
  ) STRICT, WITHOUT ROWID
`;

const SESSION_REGISTRY_MISSING_INDEX_SQL = `
  CREATE INDEX session_registry_missing
  ON session_registry(missing_since, missing_observed_at)
`;

const METADATA_TABLES = [
  "node_state",
  "node_write_guard",
  "session_registry",
] as const;
const METADATA_DML_EVENTS = ["DELETE", "INSERT", "UPDATE"] as const;

type MetadataTable = (typeof METADATA_TABLES)[number];
type MetadataDmlEvent = (typeof METADATA_DML_EVENTS)[number];

function writerFenceTriggerName(
  table: MetadataTable,
  event: MetadataDmlEvent,
): string {
  return `cyclotomy_writer_fence_${table}_${event.toLowerCase()}`;
}

function writerFenceTriggerSql(
  table: MetadataTable,
  event: MetadataDmlEvent,
): string {
  return `
    CREATE TRIGGER ${writerFenceTriggerName(table, event)}
    BEFORE ${event} ON ${table}
    WHEN ${METADATA_WRITER_PROTOCOL_FUNCTION}() IS NOT ${METADATA_SCHEMA_VERSION}
    BEGIN
      SELECT RAISE(ABORT, 'Cyclotomy metadata writer protocol mismatch');
    END
  `;
}

const WRITER_FENCE_TRIGGER_SQL = METADATA_TABLES.flatMap((table) =>
  METADATA_DML_EVENTS.map((event) => writerFenceTriggerSql(table, event)),
);

/** Exact user-authored schema shipped in the public 0.0.1 tarball. */
const PUBLISHED_V1_SCHEMA = new Map<string, ExpectedSchemaObject>([
  [
    "node_state",
    {
      type: "table",
      table: "node_state",
      sql: normalizeSchemaSql(NODE_STATE_SCHEMA_SQL),
    },
  ],
  [
    "session_registry",
    {
      type: "table",
      table: "session_registry",
      sql: normalizeSchemaSql(SESSION_REGISTRY_V1_SCHEMA_SQL),
    },
  ],
  [
    "session_registry_missing",
    {
      type: "index",
      table: "session_registry",
      sql: normalizeSchemaSql(SESSION_REGISTRY_MISSING_INDEX_SQL),
    },
  ],
]);

const CURRENT_DATA_SCHEMA = new Map<string, ExpectedSchemaObject>([
  [
    "node_state",
    {
      type: "table",
      table: "node_state",
      sql: normalizeSchemaSql(NODE_STATE_SCHEMA_SQL),
    },
  ],
  [
    "node_write_guard",
    {
      type: "table",
      table: "node_write_guard",
      sql: normalizeSchemaSql(NODE_WRITE_GUARD_SCHEMA_SQL),
    },
  ],
  [
    "session_registry",
    {
      type: "table",
      table: "session_registry",
      sql: normalizeSchemaSql(SESSION_REGISTRY_SCHEMA_SQL),
    },
  ],
  [
    "session_registry_missing",
    {
      type: "index",
      table: "session_registry",
      sql: normalizeSchemaSql(SESSION_REGISTRY_MISSING_INDEX_SQL),
    },
  ],
]);

const CURRENT_SCHEMA = new Map<string, ExpectedSchemaObject>([
  ...CURRENT_DATA_SCHEMA,
  ...METADATA_TABLES.flatMap((table) =>
    METADATA_DML_EVENTS.map(
      (event) =>
        [
          writerFenceTriggerName(table, event),
          {
            type: "trigger",
            table,
            sql: normalizeSchemaSql(writerFenceTriggerSql(table, event)),
          },
        ] as const,
    ),
  ),
]);

function systemErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

function isTransientSidecarAccess(error: unknown): boolean {
  const code = systemErrorCode(error);
  return code === "EACCES" || code === "EBUSY" || code === "EPERM";
}

function isSqliteBusy(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = Reflect.get(error, "code");
  const message = Reflect.get(error, "message");
  return (
    code === "SQLITE_BUSY" ||
    code === "SQLITE_LOCKED" ||
    (typeof message === "string" && /database (?:is )?locked/iu.test(message))
  );
}

function enableWalWithRetry(db: DatabaseSync): void {
  const deadline = Date.now() + OPEN_BUSY_RETRY_MS;
  while (true) {
    try {
      const row = db.prepare("PRAGMA journal_mode=WAL").get() as
        { journal_mode: string } | undefined;
      if (row?.journal_mode.toLowerCase() !== "wal") {
        throw new Error("SQLite refused WAL journal mode");
      }
      return;
    } catch (error) {
      if (!isSqliteBusy(error) || Date.now() >= deadline) throw error;
      Atomics.wait(OPEN_WAIT_CELL, 0, 0, OPEN_BUSY_POLL_MS);
    }
  }
}

export interface SessionRegistration {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly missingSince: number | null;
  readonly missingObservedAt: number | null;
  readonly pendingNodeGuard: boolean;
}

export interface PruneMissingSessionOptions {
  readonly expectedSessionId: string;
  readonly expectedSessionFile: string;
  readonly expectedMissingSince: number;
  readonly expectedMissingObservedAt: number;
  readonly now?: number;
  readonly retentionMs: number;
}

export interface SessionMetadataRemovalReport {
  readonly removedSessions: number;
  readonly removedNodeStates: number;
  readonly removedNodeWriteGuards: number;
  /** Includes node-state, guard, and registry rows. */
  readonly removedMetadataRows: number;
}

export type CommitNodeStateResult =
  "committed" | "state-changed" | "write-protected";

export interface NodeStatePin {
  /** Effective checkpoint to materialize at the protected node. */
  readonly treeOid: TreeOid;
  /** Exact slot observed before protection; undefined means it was absent. */
  readonly expectedTreeOid: TreeOid | undefined;
}

export type ProtectNodeWriteResult = "protected" | "state-changed";
export type MissingNodeStateIntent = "initialize-fresh" | "adopt-protected";
export type MaterializeMissingNodeStateResult = "committed" | "state-changed";
type ConsumePendingNodeGuardResult =
  "protected" | "not-pending" | "session-unregistered";
export type ClearNodeWriteProtectionResult =
  "cleared" | "unguarded" | "state-changed";

export interface CopyForkAncestryInput {
  readonly targetSessionId: string;
  readonly parentSessionFile: string;
  /** The root-to-leaf ancestry Pi actually retained in the fork. */
  readonly ancestryEntryIds: readonly string[];
}

export interface CopyForkAncestryReport {
  /** Undefined means the parent file was never registered in this workspace. */
  readonly sourceSessionId: string | undefined;
  readonly copiedStates: number;
}

interface NodeStateRow {
  readonly entry_id: unknown;
  readonly tree_oid: unknown;
}

interface SessionRegistrationRow {
  readonly session_id: unknown;
  readonly session_file: unknown;
  readonly missing_since: unknown;
  readonly missing_observed_at: unknown;
  readonly pending_node_guard: unknown;
}

export class MetadataError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "MetadataError";
  }
}

function metadataPathError(path: string, detail: string): MetadataError {
  return new MetadataError(
    `unsafe metadata database path ${JSON.stringify(path)}: ${detail}`,
  );
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function checkedRegularMetadataPath(path: string): Stats {
  let observed: Stats;
  try {
    observed = lstatSync(path);
  } catch (error) {
    throw metadataPathError(
      path,
      `cannot inspect file (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (observed.isSymbolicLink() || !observed.isFile() || observed.nlink !== 1) {
    throw metadataPathError(
      path,
      "must be a single-link regular file, not a symlink or another file type",
    );
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      !sameFileIdentity(observed, opened)
    ) {
      throw metadataPathError(path, "changed while it was being validated");
    }
    return opened;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function optionalMetadataSidecar(path: string): void {
  validation: for (
    let attempt = 0;
    attempt < SIDECAR_VALIDATION_ATTEMPTS;
    attempt += 1
  ) {
    let before: Stats;
    try {
      before = lstatSync(path);
    } catch (error) {
      // SQLite is allowed to delete a WAL/SHM sidecar as the last connection
      // closes. Disappearance at any observation point is a valid absence.
      if (systemErrorCode(error) === "ENOENT") return;
      if (
        isTransientSidecarAccess(error) &&
        attempt + 1 < SIDECAR_VALIDATION_ATTEMPTS
      ) {
        Atomics.wait(OPEN_WAIT_CELL, 0, 0, SIDECAR_RETRY_MS);
        continue;
      }
      throw error;
    }
    // A sidecar can be unlinked immediately after a successful lookup. Some
    // kernels expose that legitimate race as a regular-file stat with zero
    // links rather than ENOENT.
    if (before.nlink === 0) return;
    if (before.isSymbolicLink() || !before.isFile() || before.nlink > 1) {
      throw metadataPathError(
        path,
        "must be a single-link regular file, not a symlink or another file type",
      );
    }

    let descriptor: number | undefined;
    let changed = false;
    try {
      descriptor = openSync(
        path,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      );
      const opened = fstatSync(descriptor);
      let after: Stats;
      try {
        after = lstatSync(path);
      } catch (error) {
        if (systemErrorCode(error) === "ENOENT") return;
        if (
          isTransientSidecarAccess(error) &&
          attempt + 1 < SIDECAR_VALIDATION_ATTEMPTS
        ) {
          Atomics.wait(OPEN_WAIT_CELL, 0, 0, SIDECAR_RETRY_MS);
          continue validation;
        }
        throw error;
      }
      if (after.nlink === 0) return;
      if (
        opened.isFile() &&
        opened.nlink === 1 &&
        !after.isSymbolicLink() &&
        after.isFile() &&
        after.nlink === 1 &&
        sameFileIdentity(before, opened) &&
        sameFileIdentity(opened, after)
      ) {
        return;
      }
      if (
        sameFileIdentity(opened, after) &&
        (!opened.isFile() ||
          opened.nlink > 1 ||
          after.isSymbolicLink() ||
          !after.isFile() ||
          after.nlink > 1)
      ) {
        throw metadataPathError(
          path,
          "must be a single-link regular file, not a symlink or another file type",
        );
      }
      changed = true;
    } catch (error) {
      if (systemErrorCode(error) === "ENOENT") return;
      // A nofollow open reports ELOOP when a regular sidecar is replaced by a
      // symlink between lstat and open. Reobserve it; a stable symlink is
      // rejected by the next iteration without ever being followed.
      if (
        systemErrorCode(error) === "ELOOP" ||
        isTransientSidecarAccess(error)
      ) {
        changed = true;
      } else {
        throw error;
      }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }

    if (changed && attempt + 1 < SIDECAR_VALIDATION_ATTEMPTS) {
      Atomics.wait(OPEN_WAIT_CELL, 0, 0, SIDECAR_RETRY_MS);
    }
  }
  throw metadataPathError(
    path,
    "changed repeatedly while it was being validated",
  );
}

/**
 * SQLite cannot accept an already O_NOFOLLOW-opened descriptor. This closes
 * the practical pre-created-symlink hole and pairs a pre-open observation with
 * a post-open inode check; the containing control directory remains a trusted
 * same-user boundary against an active replacement race.
 */
function prepareMetadataPath(path: string): {
  readonly canonicalPath: string;
  readonly observation: Stats;
} {
  if (!isAbsolute(path) || path.includes("\0") || resolve(path) !== path) {
    throw metadataPathError(path, "path must be canonical and absolute");
  }
  const parent = dirname(path);
  let parentInfo: Stats;
  try {
    parentInfo = lstatSync(parent);
  } catch (error) {
    throw metadataPathError(
      path,
      `parent directory is unavailable (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
    throw metadataPathError(path, "parent must be a real directory");
  }
  const canonicalParent = realpathSync(parent);

  let pathExists = false;
  try {
    lstatSync(path);
    pathExists = true;
  } catch (error) {
    if (systemErrorCode(error) !== "ENOENT") {
      throw metadataPathError(
        path,
        `cannot inspect database file (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  if (!pathExists) {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        path,
        fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_RDWR |
          (fsConstants.O_NOFOLLOW ?? 0),
        0o600,
      );
    } catch (error) {
      // Another opener may have won the first-create race. Revalidate the
      // pathname below; pre-existing entries were inspected before this open.
      if (systemErrorCode(error) !== "EEXIST") {
        throw metadataPathError(
          path,
          `cannot create private database file (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  const observation = checkedRegularMetadataPath(path);
  optionalMetadataSidecar(`${path}-wal`);
  optionalMetadataSidecar(`${path}-shm`);
  return {
    canonicalPath: join(canonicalParent, basename(path)),
    observation,
  };
}

function requireTreeOid(value: unknown, context: string): TreeOid {
  if (!isTreeOid(value)) {
    throw new MetadataError(`invalid tree oid for ${context}`);
  }
  return value;
}

function requireTimestamp(value: number, context: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MetadataError(`${context} must be a non-negative integer`);
  }
  return value;
}

function requireNonEmpty(value: string, context: string): string {
  if (value.length === 0) {
    throw new MetadataError(`${context} must be non-empty`);
  }
  return value;
}

function sessionRegistrationFromRow(
  row: SessionRegistrationRow,
): SessionRegistration {
  const sessionId = requireNonEmpty(String(row.session_id), "session id");
  const sessionFile = requireNonEmpty(String(row.session_file), "session file");
  const missingSince =
    row.missing_since === null
      ? null
      : requireTimestamp(Number(row.missing_since), "missing_since");
  const missingObservedAt =
    row.missing_observed_at === null
      ? null
      : requireTimestamp(
          Number(row.missing_observed_at),
          "missing_observed_at",
        );
  if (
    (missingSince === null) !== (missingObservedAt === null) ||
    (missingSince !== null &&
      missingObservedAt !== null &&
      missingObservedAt < missingSince)
  ) {
    throw new MetadataError("invalid session registry missing interval");
  }
  const pendingNodeGuard = Number(row.pending_node_guard);
  if (pendingNodeGuard !== 0 && pendingNodeGuard !== 1) {
    throw new MetadataError("invalid session registry pending node guard");
  }
  return {
    sessionId,
    sessionFile,
    missingSince,
    missingObservedAt,
    pendingNodeGuard: pendingNodeGuard === 1,
  };
}

function consumePendingNodeGuardIn(
  db: DatabaseSync,
  sessionId: string,
  entryIds: readonly string[],
  expectedSessionFile?: string,
): ConsumePendingNodeGuardResult {
  const row = db
    .prepare(
      `SELECT session_file, pending_node_guard FROM session_registry
       WHERE session_id = ?`,
    )
    .get(sessionId) as
    | {
        readonly session_file: unknown;
        readonly pending_node_guard: unknown;
      }
    | undefined;
  if (
    row === undefined ||
    (expectedSessionFile !== undefined &&
      String(row.session_file) !== expectedSessionFile)
  ) {
    return "session-unregistered";
  }
  const pending = Number(row.pending_node_guard);
  if (pending !== 0 && pending !== 1) {
    throw new MetadataError("invalid session registry pending node guard");
  }
  if (pending === 0) return "not-pending";

  const insertGuard = db.prepare(
    `INSERT OR IGNORE INTO node_write_guard(session_id, entry_id)
     VALUES (?, ?)`,
  );
  for (const entryId of entryIds) insertGuard.run(sessionId, entryId);
  const cleared = db
    .prepare(
      `UPDATE session_registry
       SET pending_node_guard = 0
       WHERE session_id = ?
         AND session_file = ?
         AND pending_node_guard = 1`,
    )
    .run(sessionId, String(row.session_file));
  if (Number(cleared.changes) !== 1) {
    throw new MetadataError("pending node guard changed while consumed");
  }
  return "protected";
}

/**
 * SQLite control plane for the whole product model: one state and optional
 * write guard per Pi node, plus session identity for fork copying and cleanup.
 */
export interface MetadataStoreOptions {
  /**
   * Leave an exact published-v1 database untouched so object-format migration
   * can preflight every referenced tree before the one-way schema cutover.
   */
  readonly deferPublishedV1Migration?: boolean;
}

interface CheckedTreeOidMigration {
  readonly oldTreeOid: TreeOid;
  readonly newTreeOid: TreeOid;
}

export class MetadataStore {
  readonly #db: DatabaseSync;
  #closed = false;

  constructor(path: string, options: MetadataStoreOptions = {}) {
    let db: DatabaseSync | undefined;
    try {
      const prepared = prepareMetadataPath(path);
      db = new DatabaseSync(prepared.canonicalPath);
      db.exec("PRAGMA busy_timeout=5000;");
      enableWalWithRetry(db);
      db.exec("PRAGMA synchronous=FULL;");
      const opened = checkedRegularMetadataPath(prepared.canonicalPath);
      if (!sameFileIdentity(prepared.observation, opened)) {
        throw metadataPathError(
          path,
          "database file changed while SQLite was opening it",
        );
      }
      optionalMetadataSidecar(`${prepared.canonicalPath}-wal`);
      optionalMetadataSidecar(`${prepared.canonicalPath}-shm`);
      // The persistent writer-fence triggers call this connection-private
      // capability. Connections opened by an older Cyclotomy process do not
      // have it, so their next metadata mutation fails closed after migration.
      db.function(
        METADATA_WRITER_PROTOCOL_FUNCTION,
        { deterministic: true, directOnly: false },
        () => METADATA_SCHEMA_VERSION,
      );
    } catch (error) {
      try {
        db?.close();
      } catch {
        // Preserve the open/configuration failure.
      }
      throw error instanceof MetadataError
        ? error
        : new MetadataError(`cannot open metadata database at ${path}`, error);
    }
    this.#db = db;

    try {
      const version = this.#schemaVersion(db);
      if (version > METADATA_SCHEMA_VERSION) {
        throw new MetadataError(
          `metadata schema version ${version} is newer than supported version ${METADATA_SCHEMA_VERSION}`,
        );
      }
      if (version === 1 && options.deferPublishedV1Migration === true) {
        this.#validateExactSchema(
          db,
          1,
          PUBLISHED_V1_SCHEMA,
          "published layout",
        );
      } else if (version < METADATA_SCHEMA_VERSION) {
        this.#migrateSchema(db);
      }
      if (this.#schemaVersion(db) === METADATA_SCHEMA_VERSION) {
        this.#validateSchema(db);
      }
    } catch (error) {
      try {
        db.close();
      } catch {
        // Preserve the schema failure.
      }
      throw error instanceof MetadataError
        ? error
        : new MetadataError("metadata schema initialization failed", error);
    }
  }

  isSchemaCurrent(): boolean {
    return this.#schemaVersion(this.#database()) === METADATA_SCHEMA_VERSION;
  }

  migrateSchemaToCurrent(): void {
    const db = this.#database();
    const version = this.#schemaVersion(db);
    if (version > METADATA_SCHEMA_VERSION) {
      throw new MetadataError(
        `metadata schema version ${version} is newer than supported version ${METADATA_SCHEMA_VERSION}`,
      );
    }
    if (version < METADATA_SCHEMA_VERSION) this.#migrateSchema(db);
    this.#validateSchema(db);
  }

  getState(sessionId: string, entryId: string): NodeState | undefined {
    const row = this.#database()
      .prepare(
        `SELECT tree_oid FROM node_state
         WHERE session_id = ? AND entry_id = ?`,
      )
      .get(sessionId, entryId);
    if (row === undefined) return undefined;
    return {
      treeOid: requireTreeOid(row.tree_oid, `${sessionId}/${entryId}`),
    };
  }

  isNodeWriteProtected(sessionId: string, entryId: string): boolean {
    requireNonEmpty(sessionId, "session id");
    requireNonEmpty(entryId, "entry id");
    return (
      this.#database()
        .prepare(
          `SELECT 1 FROM node_write_guard
           WHERE session_id = ? AND entry_id = ?`,
        )
        .get(sessionId, entryId) !== undefined
    );
  }

  /**
   * Protect one exact node from capture. When the node currently inherits its
   * checkpoint, `pin` materializes that authenticated tree in the same write
   * transaction so later ancestor captures cannot move the restore target.
   */
  protectNodeWrite(
    sessionId: string,
    entryId: string,
    pin?: NodeStatePin,
  ): ProtectNodeWriteResult {
    requireNonEmpty(sessionId, "session id");
    requireNonEmpty(entryId, "entry id");
    const checkedPin =
      pin === undefined
        ? undefined
        : {
            treeOid: requireTreeOid(pin.treeOid, "protected node state"),
            expectedTreeOid:
              pin.expectedTreeOid === undefined
                ? undefined
                : requireTreeOid(
                    pin.expectedTreeOid,
                    "expected protected node state",
                  ),
          };
    return this.#transaction((db) => {
      const guarded =
        db
          .prepare(
            `SELECT 1 FROM node_write_guard
             WHERE session_id = ? AND entry_id = ?`,
          )
          .get(sessionId, entryId) !== undefined;
      // The first guard owns the meaning of this node. Repeated protection is
      // intentionally idempotent and must never retarget an existing guard.
      if (guarded) return "protected";

      if (checkedPin !== undefined) {
        const existing = db
          .prepare(
            `SELECT tree_oid FROM node_state
             WHERE session_id = ? AND entry_id = ?`,
          )
          .get(sessionId, entryId) as
          { readonly tree_oid: unknown } | undefined;
        const existingTreeOid =
          existing === undefined
            ? undefined
            : requireTreeOid(existing.tree_oid, `${sessionId}/${entryId}`);
        if (existingTreeOid === checkedPin.expectedTreeOid) {
          if (existingTreeOid !== checkedPin.treeOid) {
            db.prepare(
              `INSERT INTO node_state(session_id, entry_id, tree_oid)
               VALUES (?, ?, ?)
               ON CONFLICT(session_id, entry_id)
               DO UPDATE SET tree_oid = excluded.tree_oid`,
            ).run(sessionId, entryId, checkedPin.treeOid);
          }
        } else {
          // A concurrent exact capture wins its pointer, but not the right to
          // keep writing: install the guard before reporting the stale pin.
          db.prepare(
            `INSERT INTO node_write_guard(session_id, entry_id)
             VALUES (?, ?)`,
          ).run(sessionId, entryId);
          return "state-changed";
        }
      }

      db.prepare(
        `INSERT INTO node_write_guard(session_id, entry_id)
         VALUES (?, ?)`,
      ).run(sessionId, entryId);
      return "protected";
    });
  }

  /**
   * Clear protection only while the pinned exact checkpoint still names the
   * tree that was just matched or restored.
   */
  clearNodeWriteProtection(
    sessionId: string,
    entryId: string,
    expectedTreeOid: TreeOid,
  ): ClearNodeWriteProtectionResult {
    requireNonEmpty(sessionId, "session id");
    requireNonEmpty(entryId, "entry id");
    const checkedTreeOid = requireTreeOid(
      expectedTreeOid,
      "restored node state",
    );
    return this.#transaction((db) => {
      const guarded =
        db
          .prepare(
            `SELECT 1 FROM node_write_guard
             WHERE session_id = ? AND entry_id = ?`,
          )
          .get(sessionId, entryId) !== undefined;
      if (!guarded) return "unguarded";
      const existing = db
        .prepare(
          `SELECT tree_oid FROM node_state
           WHERE session_id = ? AND entry_id = ?`,
        )
        .get(sessionId, entryId) as { readonly tree_oid: unknown } | undefined;
      const existingTreeOid =
        existing === undefined
          ? undefined
          : requireTreeOid(existing.tree_oid, `${sessionId}/${entryId}`);
      if (existingTreeOid !== checkedTreeOid) return "state-changed";
      db.prepare(
        `DELETE FROM node_write_guard
         WHERE session_id = ? AND entry_id = ?`,
      ).run(sessionId, entryId);
      return "cleared";
    });
  }

  /** Atomically honor both the caller's slot CAS and durable write protection. */
  commitNodeState(
    sessionId: string,
    entryId: string,
    treeOid: string,
    expected?: { readonly treeOid: TreeOid | undefined },
  ): CommitNodeStateResult {
    requireNonEmpty(sessionId, "session id");
    requireNonEmpty(entryId, "entry id");
    const checkedTreeOid = requireTreeOid(treeOid, "node state");
    return this.#transaction((db) => {
      if (consumePendingNodeGuardIn(db, sessionId, [entryId]) === "protected") {
        return "write-protected";
      }
      const guarded = db
        .prepare(
          `SELECT 1 FROM node_write_guard
           WHERE session_id = ? AND entry_id = ?`,
        )
        .get(sessionId, entryId);
      if (guarded !== undefined) return "write-protected";

      const existing = db
        .prepare(
          `SELECT tree_oid FROM node_state
           WHERE session_id = ? AND entry_id = ?`,
        )
        .get(sessionId, entryId) as { readonly tree_oid: unknown } | undefined;
      const existingTreeOid =
        existing === undefined
          ? undefined
          : requireTreeOid(existing.tree_oid, `${sessionId}/${entryId}`);
      if (expected !== undefined && existingTreeOid !== expected.treeOid) {
        return "state-changed";
      }
      if (existingTreeOid !== checkedTreeOid) {
        db.prepare(
          `INSERT INTO node_state(session_id, entry_id, tree_oid)
           VALUES (?, ?, ?)
           ON CONFLICT(session_id, entry_id)
           DO UPDATE SET tree_oid = excluded.tree_oid`,
        ).run(sessionId, entryId, checkedTreeOid);
      }
      return "committed";
    });
  }

  /** Materialize a missing node only while its caller's intent remains true. */
  materializeMissingNodeState(
    sessionId: string,
    entryId: string,
    treeOid: string,
    intent: MissingNodeStateIntent,
  ): MaterializeMissingNodeStateResult {
    requireNonEmpty(sessionId, "session id");
    requireNonEmpty(entryId, "entry id");
    if (intent !== "initialize-fresh" && intent !== "adopt-protected") {
      throw new MetadataError("missing node state intent is invalid");
    }
    const checkedTreeOid = requireTreeOid(treeOid, "missing node state");
    return this.#transaction((db) => {
      if (consumePendingNodeGuardIn(db, sessionId, [entryId]) === "protected") {
        return "state-changed";
      }
      const existing = db
        .prepare(
          `SELECT 1 FROM node_state
           WHERE session_id = ? AND entry_id = ?`,
        )
        .get(sessionId, entryId);
      if (existing !== undefined) return "state-changed";

      const guarded =
        db
          .prepare(
            `SELECT 1 FROM node_write_guard
             WHERE session_id = ? AND entry_id = ?`,
          )
          .get(sessionId, entryId) !== undefined;
      if (
        (intent === "initialize-fresh" && guarded) ||
        (intent === "adopt-protected" && !guarded)
      ) {
        return "state-changed";
      }
      db.prepare(
        `INSERT INTO node_state(session_id, entry_id, tree_oid)
         VALUES (?, ?, ?)`,
      ).run(sessionId, entryId, checkedTreeOid);
      if (intent === "adopt-protected") {
        db.prepare(
          `DELETE FROM node_write_guard
           WHERE session_id = ? AND entry_id = ?`,
        ).run(sessionId, entryId);
      }
      return "committed";
    });
  }

  /** Register the unique persisted file that owns one Pi session id. */
  touchSession(sessionId: string, sessionFile: string): SessionRegistration {
    requireNonEmpty(sessionId, "session id");
    requireNonEmpty(sessionFile, "session file");
    const row = this.#database()
      .prepare(
        `INSERT INTO session_registry(
           session_id, session_file, missing_since, missing_observed_at
         ) VALUES (?, ?, NULL, NULL)
         ON CONFLICT(session_id)
         DO UPDATE SET
           missing_since = NULL,
           missing_observed_at = NULL
         WHERE session_registry.session_file = excluded.session_file
         RETURNING *`,
      )
      .get(sessionId, sessionFile) as unknown as
      SessionRegistrationRow | undefined;
    if (row === undefined) {
      throw new MetadataError(
        `session id ${JSON.stringify(sessionId)} is already owned by another file`,
      );
    }
    return sessionRegistrationFromRow(row);
  }

  /** Persist fail-closed intent until this exact session gains a real node. */
  setPendingNodeGuard(sessionId: string, expectedSessionFile: string): boolean {
    requireNonEmpty(sessionId, "session id");
    requireNonEmpty(expectedSessionFile, "expected session file");
    const result = this.#database()
      .prepare(
        `UPDATE session_registry
         SET pending_node_guard = 1
         WHERE session_id = ? AND session_file = ?`,
      )
      .run(sessionId, expectedSessionFile);
    return Number(result.changes) === 1;
  }

  pendingNodeGuard(
    sessionId: string,
    expectedSessionFile: string,
  ): boolean | undefined {
    requireNonEmpty(sessionId, "session id");
    requireNonEmpty(expectedSessionFile, "expected session file");
    const row = this.#database()
      .prepare(
        `SELECT pending_node_guard FROM session_registry
         WHERE session_id = ? AND session_file = ?`,
      )
      .get(sessionId, expectedSessionFile) as
      { readonly pending_node_guard: unknown } | undefined;
    if (row === undefined) return undefined;
    const pending = Number(row.pending_node_guard);
    if (pending !== 0 && pending !== 1) {
      throw new MetadataError("invalid session registry pending node guard");
    }
    return pending === 1;
  }

  /** Explicit reload of the still-empty session abandons the pending intent. */
  clearPendingNodeGuard(
    sessionId: string,
    expectedSessionFile: string,
  ): boolean {
    requireNonEmpty(sessionId, "session id");
    requireNonEmpty(expectedSessionFile, "expected session file");
    const result = this.#database()
      .prepare(
        `UPDATE session_registry
         SET pending_node_guard = 0
         WHERE session_id = ? AND session_file = ?`,
      )
      .run(sessionId, expectedSessionFile);
    return Number(result.changes) === 1;
  }

  /**
   * Move a pending session-level guard onto the complete first-observed stable
   * ancestry. Every guard and the flag change atomically, so multiple host
   * entries appended before an observable hook cannot leave an earlier arrival
   * available for fresh materialization.
   */
  consumePendingNodeGuard(
    sessionId: string,
    expectedSessionFile: string,
    entryIds: readonly string[],
  ): ConsumePendingNodeGuardResult {
    requireNonEmpty(sessionId, "session id");
    requireNonEmpty(expectedSessionFile, "expected session file");
    if (entryIds.length === 0) {
      throw new MetadataError("pending node guard ancestry must be non-empty");
    }
    const checkedEntryIds = entryIds.map((entryId) =>
      requireNonEmpty(entryId, "entry id"),
    );
    return this.#transaction((db) =>
      consumePendingNodeGuardIn(
        db,
        sessionId,
        checkedEntryIds,
        expectedSessionFile,
      ),
    );
  }

  listRegisteredSessions(): SessionRegistration[] {
    const rows = this.#database()
      .prepare("SELECT * FROM session_registry ORDER BY session_id")
      .all() as unknown as SessionRegistrationRow[];
    return rows.map(sessionRegistrationFromRow);
  }

  /**
   * Give a fork its own immutable-by-value copy of the parent's retained
   * ancestry, including the negative state of guarded nodes that have no exact
   * checkpoint. Existing destination slots, guards, and pending intent win,
   * making retries idempotent and keeping the sessions independent after the
   * copy. A pending parent transfers its uncertainty instead of supplying
   * ancestry state.
   */
  copyForkAncestry(input: CopyForkAncestryInput): CopyForkAncestryReport {
    requireNonEmpty(input.targetSessionId, "fork target session id");
    requireNonEmpty(input.parentSessionFile, "fork parent session file");
    const wanted = new Set(
      input.ancestryEntryIds.map((entryId) =>
        requireNonEmpty(entryId, "fork ancestry entry id"),
      ),
    );

    return this.#transaction((db) => {
      const source = db
        .prepare(
          `SELECT session_id, pending_node_guard FROM session_registry
           WHERE session_file = ?`,
        )
        .get(input.parentSessionFile) as
        | {
            readonly session_id: unknown;
            readonly pending_node_guard: unknown;
          }
        | undefined;
      if (source === undefined) {
        return { sourceSessionId: undefined, copiedStates: 0 };
      }
      const sourceSessionId = requireNonEmpty(
        String(source.session_id),
        "fork source session id",
      );
      if (sourceSessionId === input.targetSessionId) {
        return { sourceSessionId, copiedStates: 0 };
      }
      const sourcePending = Number(source.pending_node_guard);
      if (sourcePending !== 0 && sourcePending !== 1) {
        throw new MetadataError("invalid fork source pending node guard");
      }
      const targetPending = db
        .prepare(
          `SELECT pending_node_guard FROM session_registry
           WHERE session_id = ?`,
        )
        .get(input.targetSessionId) as
        { readonly pending_node_guard: unknown } | undefined;
      if (sourcePending === 1) {
        // A cold fork has no source before-hook in which to retire ambiguous
        // no-node bytes. Transfer that durable uncertainty only to an exact,
        // already-registered destination and never import state underneath it.
        if (targetPending !== undefined) {
          db.prepare(
            `UPDATE session_registry
             SET pending_node_guard = 1
             WHERE session_id = ?`,
          ).run(input.targetSessionId);
        }
        return { sourceSessionId, copiedStates: 0 };
      }
      if (wanted.size === 0) {
        return { sourceSessionId, copiedStates: 0 };
      }
      if (Number(targetPending?.pending_node_guard ?? 0) === 1) {
        return { sourceSessionId, copiedStates: 0 };
      }

      const sourceRows = db
        .prepare(
          `SELECT entry_id, tree_oid FROM node_state
           WHERE session_id = ?`,
        )
        .all(sourceSessionId) as unknown as NodeStateRow[];
      const checked = sourceRows
        .filter((row) => wanted.has(String(row.entry_id)))
        .map((row) => ({
          entryId: requireNonEmpty(
            String(row.entry_id),
            "fork source entry id",
          ),
          treeOid: requireTreeOid(row.tree_oid, "fork source node state"),
        }));
      const sourceGuardRows = db
        .prepare(
          `SELECT guard.entry_id
           FROM node_write_guard AS guard
           WHERE guard.session_id = ?
             AND NOT EXISTS (
               SELECT 1 FROM node_state AS state
               WHERE state.session_id = guard.session_id
                 AND state.entry_id = guard.entry_id
             )`,
        )
        .all(sourceSessionId) as unknown as {
        readonly entry_id: unknown;
      }[];
      const guardedMissingEntryIds = sourceGuardRows
        .filter((row) => wanted.has(String(row.entry_id)))
        .map((row) =>
          requireNonEmpty(String(row.entry_id), "fork source guarded entry id"),
        );

      const insertState = db.prepare(
        `INSERT OR IGNORE INTO node_state(
           session_id, entry_id, tree_oid
         )
         SELECT ?, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM node_write_guard
           WHERE session_id = ? AND entry_id = ?
         )`,
      );
      let copiedStates = 0;
      for (const state of checked) {
        copiedStates += Number(
          insertState.run(
            input.targetSessionId,
            state.entryId,
            state.treeOid,
            input.targetSessionId,
            state.entryId,
          ).changes,
        );
      }
      const insertGuard = db.prepare(
        `INSERT OR IGNORE INTO node_write_guard(session_id, entry_id)
         SELECT ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM node_state
           WHERE session_id = ? AND entry_id = ?
         )`,
      );
      for (const entryId of guardedMissingEntryIds) {
        insertGuard.run(
          input.targetSessionId,
          entryId,
          input.targetSessionId,
          entryId,
        );
      }
      return { sourceSessionId, copiedStates };
    });
  }

  observeSessionPresent(
    sessionId: string,
    expectedSessionFile: string,
  ): boolean {
    const result = this.#database()
      .prepare(
        `UPDATE session_registry
         SET missing_since = NULL, missing_observed_at = NULL
         WHERE session_id = ? AND session_file = ?`,
      )
      .run(sessionId, expectedSessionFile);
    return Number(result.changes) === 1;
  }

  observeSessionMissing(
    sessionId: string,
    expectedSessionFile: string,
    observedAt: number = Date.now(),
  ): boolean {
    requireTimestamp(observedAt, "session missing observedAt");
    const result = this.#database()
      .prepare(
        `UPDATE session_registry
         SET missing_since = COALESCE(missing_since, ?),
             missing_observed_at = MAX(COALESCE(missing_observed_at, ?), ?)
         WHERE session_id = ? AND session_file = ?`,
      )
      .run(observedAt, observedAt, observedAt, sessionId, expectedSessionFile);
    return Number(result.changes) === 1;
  }

  /**
   * Remove one retained missing session only if its complete registry
   * observation still matches the caller's final filesystem probe.
   */
  pruneMissingSession(
    options: PruneMissingSessionOptions,
  ): SessionMetadataRemovalReport {
    const expectedSessionId = requireNonEmpty(
      options.expectedSessionId,
      "expected session id",
    );
    const expectedSessionFile = requireNonEmpty(
      options.expectedSessionFile,
      "expected session file",
    );
    const expectedMissingSince = requireTimestamp(
      options.expectedMissingSince,
      "expected missing_since",
    );
    const expectedMissingObservedAt = requireTimestamp(
      options.expectedMissingObservedAt,
      "expected missing_observed_at",
    );
    const now = requireTimestamp(options.now ?? Date.now(), "GC now");
    const retentionMs = requireTimestamp(
      options.retentionMs,
      "session metadata retentionMs",
    );
    const cutoff = now - retentionMs;

    return this.#transaction((db) => {
      const deletedRegistry = db
        .prepare(
          `DELETE FROM session_registry
           WHERE session_id = ?
             AND session_file = ?
             AND missing_since = ?
             AND missing_observed_at = ?
             AND missing_since <= ?
             AND missing_observed_at > missing_since`,
        )
        .run(
          expectedSessionId,
          expectedSessionFile,
          expectedMissingSince,
          expectedMissingObservedAt,
          cutoff,
        );
      const removedSessions = Number(deletedRegistry.changes);
      if (removedSessions === 0) {
        return {
          removedSessions: 0,
          removedNodeStates: 0,
          removedNodeWriteGuards: 0,
          removedMetadataRows: 0,
        };
      }
      const removedNodeStates = Number(
        db
          .prepare("DELETE FROM node_state WHERE session_id = ?")
          .run(expectedSessionId).changes,
      );
      const removedNodeWriteGuards = Number(
        db
          .prepare("DELETE FROM node_write_guard WHERE session_id = ?")
          .run(expectedSessionId).changes,
      );
      return {
        removedSessions,
        removedNodeStates,
        removedNodeWriteGuards,
        removedMetadataRows:
          removedNodeStates + removedNodeWriteGuards + removedSessions,
      };
    });
  }

  /**
   * Perform the published-v1 SQL upgrade and tree-format reference cutover in
   * one transaction. `expectedTreeOids` is the authenticated root set used to
   * prepare the replacement objects; any intervening metadata write aborts the
   * entire cutover before it can commit a mixed state.
   */
  migrateSchemaAndReplaceTreeOidReferences(
    migrations: readonly {
      readonly oldTreeOid: string;
      readonly newTreeOid: string;
    }[],
    expectedTreeOids: readonly string[],
  ): number {
    const checked = this.#checkTreeOidMigrations(migrations);
    const expected = this.#checkExpectedTreeOids(expectedTreeOids);
    const expectedSet = new Set(expected);
    if (checked.some((migration) => !expectedSet.has(migration.oldTreeOid))) {
      throw new MetadataError(
        "tree migration source is not an authenticated metadata root",
      );
    }

    return this.#transaction((db) => {
      this.#assertReferencedTreeOids(db, expected);
      this.#migrateSchemaWithinTransaction(db);
      const replaced = this.#replaceTreeOidReferences(db, checked);
      const migratedBySource = new Map(
        checked.map((migration) => [
          migration.oldTreeOid,
          migration.newTreeOid,
        ]),
      );
      const expectedAfter = [
        ...new Set(
          expected.map((treeOid) => migratedBySource.get(treeOid) ?? treeOid),
        ),
      ].sort();
      this.#assertReferencedTreeOids(db, expectedAfter);
      this.#validateSchema(db);
      return replaced;
    });
  }

  #checkTreeOidMigrations(
    migrations: readonly {
      readonly oldTreeOid: string;
      readonly newTreeOid: string;
    }[],
  ): CheckedTreeOidMigration[] {
    const checked: CheckedTreeOidMigration[] = [];
    const oldOids = new Set<string>();
    for (const migration of migrations) {
      const oldTreeOid = requireTreeOid(
        migration.oldTreeOid,
        "legacy tree migration source",
      );
      const newTreeOid = requireTreeOid(
        migration.newTreeOid,
        "legacy tree migration target",
      );
      if (oldTreeOid === newTreeOid) {
        throw new MetadataError("tree migration must change the object id");
      }
      if (oldOids.has(oldTreeOid)) {
        throw new MetadataError("tree migration contains a duplicate source");
      }
      oldOids.add(oldTreeOid);
      checked.push({ oldTreeOid, newTreeOid });
    }
    if (checked.some((migration) => oldOids.has(migration.newTreeOid))) {
      throw new MetadataError(
        "tree migration target must not also be a migration source",
      );
    }
    return checked;
  }

  #checkExpectedTreeOids(treeOids: readonly string[]): TreeOid[] {
    const checked = treeOids.map((treeOid) =>
      requireTreeOid(treeOid, "tree migration expected root"),
    );
    const unique = new Set(checked);
    if (unique.size !== checked.length) {
      throw new MetadataError(
        "tree migration expected roots contain duplicates",
      );
    }
    return [...checked].sort();
  }

  #assertReferencedTreeOids(
    db: DatabaseSync,
    expectedTreeOids: readonly TreeOid[],
  ): void {
    const actual = db
      .prepare("SELECT DISTINCT tree_oid FROM node_state ORDER BY tree_oid")
      .all()
      .map((row) => requireTreeOid(row.tree_oid, "metadata migration root"));
    if (
      actual.length !== expectedTreeOids.length ||
      actual.some((treeOid, index) => treeOid !== expectedTreeOids[index])
    ) {
      throw new MetadataError(
        "tree references changed while object-format migration was preparing",
      );
    }
  }

  #replaceTreeOidReferences(
    db: DatabaseSync,
    migrations: readonly CheckedTreeOidMigration[],
  ): number {
    const replace = db.prepare(
      "UPDATE node_state SET tree_oid = ? WHERE tree_oid = ?",
    );
    let replaced = 0;
    for (const migration of migrations) {
      replaced += Number(
        replace.run(migration.newTreeOid, migration.oldTreeOid).changes,
      );
    }
    return replaced;
  }

  /** The single-state table is the complete object-GC root set. */
  listReferencedTreeOids(): string[] {
    const rows = this.#database()
      .prepare("SELECT DISTINCT tree_oid FROM node_state ORDER BY tree_oid")
      .all();
    return rows.map((row) => requireTreeOid(row.tree_oid, "metadata GC root"));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #schemaVersion(db: DatabaseSync): number {
    const row = db.prepare("PRAGMA user_version").get() as {
      user_version: number | bigint;
    };
    const version = Number(row.user_version);
    if (!Number.isSafeInteger(version) || version < 0) {
      throw new MetadataError("metadata schema version is invalid");
    }
    return version;
  }

  #migrateSchema(db: DatabaseSync): void {
    db.exec("BEGIN IMMEDIATE");
    try {
      this.#migrateSchemaWithinTransaction(db);
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the original failure.
      }
      throw error;
    }
  }

  #migrateSchemaWithinTransaction(db: DatabaseSync): void {
    let version = this.#schemaVersion(db);
    // Another process may have completed the same migration while this
    // connection waited for the write lock. The version observed before
    // BEGIN is therefore only a hint; the locked version is authoritative.
    if (version > METADATA_SCHEMA_VERSION) {
      throw new MetadataError(
        `metadata schema version ${version} is newer than supported version ${METADATA_SCHEMA_VERSION}`,
      );
    }
    if (version === 0) {
      db.exec(`
        ${NODE_STATE_SCHEMA_SQL};
        ${NODE_WRITE_GUARD_SCHEMA_SQL};
        ${SESSION_REGISTRY_SCHEMA_SQL};
        ${SESSION_REGISTRY_MISSING_INDEX_SQL};
        ${WRITER_FENCE_TRIGGER_SQL.join(";\n")};
      `);
      version = METADATA_SCHEMA_VERSION;
    } else if (version === 1) {
      // Version 1 is public. Refuse to reinterpret a claimed v1 database
      // unless it is exactly the layout shipped in cyclotomy@0.0.1.
      this.#validateExactSchema(db, 1, PUBLISHED_V1_SCHEMA, "published layout");
      db.exec(`
        ${NODE_WRITE_GUARD_SCHEMA_SQL};

        ALTER TABLE session_registry
        ADD COLUMN pending_node_guard INTEGER NOT NULL DEFAULT 0
          CHECK(pending_node_guard IN (0, 1));

        ${WRITER_FENCE_TRIGGER_SQL.join(";\n")};
      `);
      version = METADATA_SCHEMA_VERSION;
    }
    db.exec(`PRAGMA user_version = ${version}`);
    this.#validateSchema(db);
  }

  #validateExactSchema(
    db: DatabaseSync,
    version: number,
    expectedSchema: ReadonlyMap<string, ExpectedSchemaObject>,
    label: string,
  ): void {
    if (this.#schemaVersion(db) !== version) {
      throw new MetadataError("metadata schema migration did not converge");
    }
    const actual = db
      .prepare(
        `SELECT type, name, tbl_name, sql FROM sqlite_schema
         WHERE type IN ('trigger', 'view') OR name NOT GLOB 'sqlite_*'
         ORDER BY type, name`,
      )
      .all();
    if (
      actual.length !== expectedSchema.size ||
      actual.some((row) => {
        const name = String(row.name);
        const expected = expectedSchema.get(name);
        return (
          expected === undefined ||
          row.type !== expected.type ||
          String(row.tbl_name) !== expected.table ||
          normalizeSchemaSql(row.sql) !== expected.sql
        );
      })
    ) {
      throw new MetadataError(
        `metadata schema v${version} does not match the ${label}`,
      );
    }
  }

  #validateSchema(db: DatabaseSync): void {
    this.#validateExactSchema(
      db,
      METADATA_SCHEMA_VERSION,
      CURRENT_SCHEMA,
      "current layout",
    );
    const tables = (
      db.prepare("PRAGMA table_list").all() as unknown as {
        readonly name: unknown;
        readonly type: unknown;
        readonly wr: unknown;
        readonly strict: unknown;
      }[]
    )
      .filter(
        (row) =>
          row.type === "table" && !String(row.name).startsWith("sqlite_"),
      )
      .sort((left, right) =>
        String(left.name).localeCompare(String(right.name)),
      );
    if (
      tables.length !== 3 ||
      String(tables[0]?.name) !== "node_state" ||
      String(tables[1]?.name) !== "node_write_guard" ||
      String(tables[2]?.name) !== "session_registry" ||
      tables.some(
        (table) => Number(table.wr) !== 1 || Number(table.strict) !== 1,
      )
    ) {
      throw new MetadataError(
        "metadata schema has unexpected tables or table options",
      );
    }

    type Column = {
      readonly name: string;
      readonly type: string;
      readonly notnull: number;
      readonly pk: number;
    };
    const validateColumns = (
      table: "node_state" | "node_write_guard" | "session_registry",
      expected: readonly Column[],
    ): void => {
      const rows = db.prepare(`PRAGMA table_info(${table})`).all();
      const actual = rows.map((row) => ({
        name: String(row.name),
        type: String(row.type),
        notnull: Number(row.notnull),
        pk: Number(row.pk),
      }));
      if (
        actual.length !== expected.length ||
        actual.some((column, index) => {
          const wanted = expected[index];
          return (
            wanted === undefined ||
            column.name !== wanted.name ||
            column.type !== wanted.type ||
            column.notnull !== wanted.notnull ||
            column.pk !== wanted.pk
          );
        })
      ) {
        throw new MetadataError(
          `metadata table ${table} has an unexpected column layout`,
        );
      }
    };
    validateColumns("node_state", [
      { name: "session_id", type: "TEXT", notnull: 1, pk: 1 },
      { name: "entry_id", type: "TEXT", notnull: 1, pk: 2 },
      { name: "tree_oid", type: "TEXT", notnull: 1, pk: 0 },
    ]);
    validateColumns("node_write_guard", [
      { name: "session_id", type: "TEXT", notnull: 1, pk: 1 },
      { name: "entry_id", type: "TEXT", notnull: 1, pk: 2 },
    ]);
    validateColumns("session_registry", [
      { name: "session_id", type: "TEXT", notnull: 1, pk: 1 },
      { name: "session_file", type: "TEXT", notnull: 1, pk: 0 },
      { name: "missing_since", type: "INTEGER", notnull: 0, pk: 0 },
      { name: "missing_observed_at", type: "INTEGER", notnull: 0, pk: 0 },
      { name: "pending_node_guard", type: "INTEGER", notnull: 1, pk: 0 },
    ]);

    const indexes = db.prepare("PRAGMA index_list(session_registry)").all();
    const missing = indexes.find(
      (row) =>
        row.name === "session_registry_missing" &&
        Number(row.unique) === 0 &&
        row.origin === "c" &&
        Number(row.partial) === 0,
    );
    const uniqueSessionFile = indexes.find((row) => {
      if (Number(row.unique) !== 1 || row.origin !== "u") return false;
      const columns = db
        .prepare(`PRAGMA index_info(${String(row.name)})`)
        .all();
      return columns.length === 1 && columns[0]?.name === "session_file";
    });
    const missingColumns = db
      .prepare("PRAGMA index_info(session_registry_missing)")
      .all()
      .map((row) => String(row.name));
    if (
      missing === undefined ||
      uniqueSessionFile === undefined ||
      missingColumns.length !== 2 ||
      missingColumns[0] !== "missing_since" ||
      missingColumns[1] !== "missing_observed_at"
    ) {
      throw new MetadataError("metadata schema has unexpected indexes");
    }
  }

  #transaction<T>(operation: (db: DatabaseSync) => T): T {
    const db = this.#database();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation(db);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the original failure.
      }
      throw error;
    }
  }

  #database(): DatabaseSync {
    if (this.#closed) throw new MetadataError("metadata store is closed");
    return this.#db;
  }
}
