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

import {
  isTreeOid,
  type NodeState,
  type TreeOid,
} from "../domain/model.ts";

/** Persistent schema version; every increment requires an explicit migration. */
const METADATA_SCHEMA_VERSION = 1;
const OPEN_BUSY_RETRY_MS = 5_000;
const OPEN_BUSY_POLL_MS = 10;
const OPEN_WAIT_CELL = new Int32Array(new SharedArrayBuffer(4));
const SIDECAR_VALIDATION_ATTEMPTS = 64;
const SIDECAR_RETRY_MS = 2;

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
        | { journal_mode: string }
        | undefined;
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
  /** Includes node-state and registry rows. */
  readonly removedMetadataRows: number;
}

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
  if (
    observed.isSymbolicLink() ||
    !observed.isFile() ||
    observed.nlink !== 1
  ) {
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
  validation:
  for (let attempt = 0; attempt < SIDECAR_VALIDATION_ATTEMPTS; attempt += 1) {
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
  if (
    !isAbsolute(path) ||
    path.includes("\0") ||
    resolve(path) !== path
  ) {
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
  const sessionFile = requireNonEmpty(
    String(row.session_file),
    "session file",
  );
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
  return { sessionId, sessionFile, missingSince, missingObservedAt };
}

/**
 * SQLite control plane for the whole product model: one state per Pi node,
 * plus the session-file identity needed for fork copying and orphan cleanup.
 */
export class MetadataStore {
  readonly #db: DatabaseSync;
  #closed = false;

  constructor(path: string) {
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
    } catch (error) {
      try {
        db?.close();
      } catch {
        // Preserve the open/configuration failure.
      }
      throw error instanceof MetadataError
        ? error
        : new MetadataError(
            `cannot open metadata database at ${path}`,
            error,
          );
    }
    this.#db = db;

    try {
      const version = this.#schemaVersion(db);
      if (version > METADATA_SCHEMA_VERSION) {
        throw new MetadataError(
          `metadata schema version ${version} is newer than supported version ${METADATA_SCHEMA_VERSION}`,
        );
      }
      if (version < METADATA_SCHEMA_VERSION) {
        this.#migrateSchema(db);
      }
      this.#validateSchema(db);
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

  /** Overwrite the node's sole state slot. */
  setState(
    sessionId: string,
    entryId: string,
    treeOid: string,
  ): void {
    requireNonEmpty(sessionId, "session id");
    requireNonEmpty(entryId, "entry id");
    const checkedTreeOid = requireTreeOid(treeOid, "node state");
    this.#database()
      .prepare(
        `INSERT INTO node_state(session_id, entry_id, tree_oid)
         VALUES (?, ?, ?)
         ON CONFLICT(session_id, entry_id)
         DO UPDATE SET tree_oid = excluded.tree_oid`,
      )
      .run(sessionId, entryId, checkedTreeOid);
  }

  /** Register the unique persisted file that owns one Pi session id. */
  touchSession(
    sessionId: string,
    sessionFile: string,
  ): SessionRegistration {
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
        | SessionRegistrationRow
        | undefined;
    if (row === undefined) {
      throw new MetadataError(
        `session id ${JSON.stringify(sessionId)} is already owned by another file`,
      );
    }
    return sessionRegistrationFromRow(row);
  }

  listRegisteredSessions(): SessionRegistration[] {
    const rows = this.#database()
      .prepare("SELECT * FROM session_registry ORDER BY session_id")
      .all() as unknown as SessionRegistrationRow[];
    return rows.map(sessionRegistrationFromRow);
  }

  /**
   * Give a fork its own immutable-by-value copy of the parent's retained
   * ancestry. Existing destination slots win, making retries idempotent and
   * keeping the two sessions independent after the copy.
   */
  copyForkAncestry(input: CopyForkAncestryInput): CopyForkAncestryReport {
    requireNonEmpty(input.targetSessionId, "fork target session id");
    requireNonEmpty(input.parentSessionFile, "fork parent session file");
    const wanted = new Set(
      input.ancestryEntryIds.map((entryId) =>
        requireNonEmpty(entryId, "fork ancestry entry id"),
      ),
    );
    if (wanted.size === 0) {
      return { sourceSessionId: undefined, copiedStates: 0 };
    }

    return this.#transaction((db) => {
      const source = db
        .prepare(
          `SELECT session_id FROM session_registry
           WHERE session_file = ?`,
        )
        .get(input.parentSessionFile) as
        | { readonly session_id: unknown }
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

      const insert = db.prepare(
        `INSERT OR IGNORE INTO node_state(
           session_id, entry_id, tree_oid
         ) VALUES (?, ?, ?)`,
      );
      let copiedStates = 0;
      for (const state of checked) {
        copiedStates += Number(
          insert.run(
            input.targetSessionId,
            state.entryId,
            state.treeOid,
          ).changes,
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
      .run(
        observedAt,
        observedAt,
        observedAt,
        sessionId,
        expectedSessionFile,
      );
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
          removedMetadataRows: 0,
        };
      }
      const removedNodeStates = Number(
        db.prepare("DELETE FROM node_state WHERE session_id = ?")
          .run(expectedSessionId).changes,
      );
      return {
        removedSessions,
        removedNodeStates,
        removedMetadataRows: removedNodeStates + removedSessions,
      };
    });
  }

  /** The single-state table is the complete object-GC root set. */
  listReferencedTreeOids(): string[] {
    const rows = this.#database()
      .prepare("SELECT DISTINCT tree_oid FROM node_state ORDER BY tree_oid")
      .all();
    return rows.map((row) =>
      requireTreeOid(row.tree_oid, "metadata GC root"),
    );
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #schemaVersion(db: DatabaseSync): number {
    const row = db
      .prepare("PRAGMA user_version")
      .get() as { user_version: number | bigint };
    const version = Number(row.user_version);
    if (!Number.isSafeInteger(version) || version < 0) {
      throw new MetadataError("metadata schema version is invalid");
    }
    return version;
  }

  #migrateSchema(db: DatabaseSync): void {
    db.exec("BEGIN IMMEDIATE");
    try {
      let version = this.#schemaVersion(db);
      // Another process may have completed the same migration while this
      // connection waited for the write lock. The version observed before
      // BEGIN is therefore only a hint; the locked version is authoritative.
      if (version > METADATA_SCHEMA_VERSION) {
        throw new MetadataError(
          `metadata schema version ${version} is newer than supported version ${METADATA_SCHEMA_VERSION}`,
        );
      }
      while (version < METADATA_SCHEMA_VERSION) {
        switch (version) {
          case 0:
            db.exec(`
              CREATE TABLE node_state(
                session_id TEXT NOT NULL,
                entry_id TEXT NOT NULL,
                tree_oid TEXT NOT NULL,
                PRIMARY KEY(session_id, entry_id)
              ) STRICT, WITHOUT ROWID;

              CREATE TABLE session_registry(
                session_id TEXT NOT NULL PRIMARY KEY,
                session_file TEXT NOT NULL UNIQUE,
                missing_since INTEGER,
                missing_observed_at INTEGER
              ) STRICT, WITHOUT ROWID;

              CREATE INDEX session_registry_missing
              ON session_registry(missing_since, missing_observed_at);
            `);
            version = 1;
            break;
          default:
            throw new MetadataError(
              `no metadata migration is available from schema version ${version}`,
            );
        }
        db.exec(`PRAGMA user_version = ${version}`);
      }
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

  #validateSchema(db: DatabaseSync): void {
    if (this.#schemaVersion(db) !== METADATA_SCHEMA_VERSION) {
      throw new MetadataError("metadata schema migration did not converge");
    }
    const tables = (db.prepare("PRAGMA table_list").all() as unknown as {
      readonly name: unknown;
      readonly type: unknown;
      readonly wr: unknown;
      readonly strict: unknown;
    }[])
      .filter((row) =>
        row.type === "table" && !String(row.name).startsWith("sqlite_")
      )
      .sort((left, right) => String(left.name).localeCompare(String(right.name)));
    if (
      tables.length !== 2 ||
      String(tables[0]?.name) !== "node_state" ||
      String(tables[1]?.name) !== "session_registry" ||
      tables.some((table) => Number(table.wr) !== 1 || Number(table.strict) !== 1)
    ) {
      throw new MetadataError(
        "metadata schema has unexpected tables or table options",
      );
    }

    // Reject executable or shadow schema objects even when the visible table
    // layouts look right. Names reserved by SQLite (autoindexes/statistics)
    // cannot be user-created and are validated semantically below where they
    // affect a product invariant.
    const userObjects = db.prepare(
      `SELECT type, name, tbl_name FROM sqlite_schema
       WHERE type IN ('trigger', 'view') OR name NOT GLOB 'sqlite_*'
       ORDER BY type, name`,
    ).all().map((row) => ({
      type: String(row.type),
      name: String(row.name),
      table: String(row.tbl_name),
    }));
    const expectedObjects = [
      {
        type: "index",
        name: "session_registry_missing",
        table: "session_registry",
      },
      { type: "table", name: "node_state", table: "node_state" },
      {
        type: "table",
        name: "session_registry",
        table: "session_registry",
      },
    ];
    if (
      userObjects.length !== expectedObjects.length ||
      userObjects.some((object, index) => {
        const expected = expectedObjects[index];
        return expected === undefined ||
          object.type !== expected.type ||
          object.name !== expected.name ||
          object.table !== expected.table;
      })
    ) {
      throw new MetadataError("metadata schema has unexpected schema objects");
    }

    type Column = {
      readonly name: string;
      readonly type: string;
      readonly notnull: number;
      readonly pk: number;
    };
    const validateColumns = (
      table: "node_state" | "session_registry",
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
          return wanted === undefined ||
            column.name !== wanted.name ||
            column.type !== wanted.type ||
            column.notnull !== wanted.notnull ||
            column.pk !== wanted.pk;
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
    validateColumns("session_registry", [
      { name: "session_id", type: "TEXT", notnull: 1, pk: 1 },
      { name: "session_file", type: "TEXT", notnull: 1, pk: 0 },
      { name: "missing_since", type: "INTEGER", notnull: 0, pk: 0 },
      { name: "missing_observed_at", type: "INTEGER", notnull: 0, pk: 0 },
    ]);

    const indexes = db.prepare("PRAGMA index_list(session_registry)").all();
    const missing = indexes.find((row) =>
      row.name === "session_registry_missing" &&
      Number(row.unique) === 0 &&
      row.origin === "c" &&
      Number(row.partial) === 0
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
