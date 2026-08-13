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
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { isTreeOid, type TreeOid } from "../domain/model.ts";
import {
  adoptBlockedMissingSlot,
  blockCheckpointSlot,
  captureCheckpointSlot,
  checkpointSlotIsBlocked,
  checkpointSlotsEqual,
  releaseCheckpointSlot,
  type BlockedCheckpointSlot,
  type CheckpointSlot,
} from "../domain/checkpoint-slot.ts";
import {
  reduceCheckpointLineage,
  type ReducedCheckpointLineage,
} from "../domain/checkpoint-lineage.ts";
import { MetadataError } from "./metadata-error.ts";
import {
  METADATA_WRITER_PROTOCOL_FUNCTION,
  metadataSchemaVersion,
  validateUninitializedMetadataDatabase,
} from "./metadata/schema.ts";
import { CURRENT_METADATA_VERSION } from "./metadata/current.ts";
import {
  initializeMetadataVersionWithinTransaction,
  migrateMetadataToCurrent,
} from "./metadata/migration-engine.ts";
import {
  findMetadataVersion,
  type MetadataMigrationDependencies,
  type MetadataSessionIdentityMatch,
  type MetadataVersionNode,
  requireMetadataVersion,
  validateMetadataVersion,
} from "./metadata/version.ts";

export { MetadataError } from "./metadata-error.ts";

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

function inReadTransaction<T>(
  db: DatabaseSync,
  operation: (snapshot: DatabaseSync) => T,
): T {
  db.exec("BEGIN");
  try {
    const result = operation(db);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the validation failure.
    }
    throw error;
  }
}

interface SessionRegistration {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly captureBarrier: boolean;
  readonly registrationState: SessionRegistrationState;
}

type SessionRegistrationState = "pending" | "verified";

export interface MetadataSessionIdentity {
  readonly sessionId: string;
  readonly sessionFile: string;
}

export interface ForkCheckpointProjection {
  readonly sourceSessionId: string;
  readonly barrier: boolean;
  /** Total projection over every retained source coordinate requested. */
  readonly coordinates: readonly {
    readonly entryId: string;
    readonly slot: CheckpointSlot;
  }[];
}

export interface ExportForkProjectionInput {
  readonly parentSessionFile: string;
  readonly retainedEntryIds: readonly string[];
}

export type CommitCaptureResult = "blocked" | "committed" | "slot-changed";
export type AdmitResolvedLocationResult = "admitted" | "slot-changed";
export type ReconcileSessionBarrierResult =
  "absent" | "reconciled" | "unregistered";

export type ResolvedCheckpoint =
  | { readonly kind: "missing" }
  | {
      readonly kind: "checkpoint";
      readonly entryId: string;
      readonly treeOid: TreeOid;
    };

export interface ResolvedCheckpointLineage {
  readonly resolution: ResolvedCheckpoint;
  readonly targetSlot: CheckpointSlot;
}

export interface CommitCaptureInput {
  readonly identity: MetadataSessionIdentity;
  readonly entryId: string;
  /** Trusted root-to-current ancestry; its final coordinate must be entryId. */
  readonly activeAncestryEntryIds: readonly string[];
  readonly treeOid: TreeOid;
  /** Exact slot observed before asynchronous capture preparation began. */
  readonly expectedSlot: CheckpointSlot;
}

export interface ProtectLocationInput {
  readonly identity: MetadataSessionIdentity;
  readonly entryId: string;
  /** Trusted root-to-target ancestry; its final coordinate must be entryId. */
  readonly activeAncestryEntryIds: readonly string[];
  readonly expectation:
    | { readonly kind: "any-current" }
    | {
        readonly kind: "exact-resolution";
        readonly resolution: Exclude<
          ResolvedCheckpoint,
          { readonly kind: "missing" }
        >;
      };
}

export interface ProtectLocationResult {
  /** A stale planned mutation must abort; its protectedSlot still committed. */
  readonly kind: "protected" | "stale";
  readonly protectedSlot: BlockedCheckpointSlot;
}

export interface AdmitResolvedLocationInput {
  readonly identity: MetadataSessionIdentity;
  readonly entryId: string;
  /** Trusted root-to-target ancestry; its final coordinate must be entryId. */
  readonly activeAncestryEntryIds: readonly string[];
  readonly expectedResolution: Exclude<
    ResolvedCheckpoint,
    { readonly kind: "missing" }
  >;
}

export interface AdoptBlockedMissingInput {
  readonly identity: MetadataSessionIdentity;
  readonly entryId: string;
  readonly treeOid: TreeOid;
}

export interface FinalizeSessionRegistrationReport {
  readonly kind: "registered" | "existing";
}

export interface FinalizeSessionProjectionInput {
  readonly targetSessionId: string;
  readonly targetSessionFile: string;
  readonly retainedEntryIds: readonly string[];
  readonly activeAncestryEntryIds: readonly string[];
  /** The complete provenance policy committed with a new registration. */
  readonly seed:
    | { readonly kind: "fresh" }
    | { readonly kind: "untrusted-parent" }
    | {
        readonly kind: "fork";
        readonly projection: ForkCheckpointProjection;
      };
}

declare const METADATA_IDENTITY_PROOF: unique symbol;

/** Opaque capability returned only after a read-only identity inspection. */
export interface MetadataIdentityProof {
  readonly [METADATA_IDENTITY_PROOF]: true;
}

export type MetadataIdentityInspection =
  | { readonly kind: "exact"; readonly proof: MetadataIdentityProof }
  | { readonly kind: "absent" | "conflict" | "unrecognized" }
  | { readonly kind: "recovery-required"; readonly cause: MetadataError };

interface CheckpointSlotRow {
  readonly capture_state: unknown;
  readonly entry_id?: unknown;
  readonly tree_oid: unknown;
}

const READ_CHECKPOINT_SLOT_SQL = `SELECT tree_oid, capture_state
  FROM checkpoint_slot WHERE session_id = ? AND entry_id = ?`;
const DELETE_CHECKPOINT_SLOT_SQL = `DELETE FROM checkpoint_slot
  WHERE session_id = ? AND entry_id = ?`;
const UPSERT_CHECKPOINT_SLOT_SQL = `INSERT INTO checkpoint_slot(
    session_id, entry_id, tree_oid, capture_state
  ) VALUES (?, ?, ?, ?)
  ON CONFLICT(session_id, entry_id)
  DO UPDATE SET tree_oid = excluded.tree_oid,
                capture_state = excluded.capture_state`;

interface SessionRegistrationRow {
  readonly session_id: unknown;
  readonly session_file: unknown;
  readonly capture_barrier: unknown;
  readonly registration_state: unknown;
}

interface MetadataSidecarSet {
  readonly journal: boolean;
  readonly shm: boolean;
  readonly wal: boolean;
}

interface MetadataIdentityProofDetails {
  readonly canonicalPath: string;
  readonly observation: Stats;
  readonly metadataVersion: MetadataVersionNode;
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly sidecars: MetadataSidecarSet;
}

const metadataIdentityProofDetails = new WeakMap<
  MetadataIdentityProof,
  MetadataIdentityProofDetails
>();

interface MetadataStoreOpenOptions {
  readonly allowHistorical: boolean;
  readonly authenticatedProof?: MetadataIdentityProof;
}

function metadataPathError(
  path: string,
  detail: string,
  cause?: unknown,
): MetadataError {
  return new MetadataError(
    `unsafe metadata database path ${JSON.stringify(path)}: ${detail}`,
    cause,
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
      error,
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

function optionalMetadataSidecar(path: string): boolean {
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
      if (systemErrorCode(error) === "ENOENT") return false;
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
    if (before.nlink === 0) return false;
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
        if (systemErrorCode(error) === "ENOENT") return false;
        if (
          isTransientSidecarAccess(error) &&
          attempt + 1 < SIDECAR_VALIDATION_ATTEMPTS
        ) {
          Atomics.wait(OPEN_WAIT_CELL, 0, 0, SIDECAR_RETRY_MS);
          continue validation;
        }
        throw error;
      }
      if (after.nlink === 0) return false;
      if (
        opened.isFile() &&
        opened.nlink === 1 &&
        !after.isSymbolicLink() &&
        after.isFile() &&
        after.nlink === 1 &&
        sameFileIdentity(before, opened) &&
        sameFileIdentity(opened, after)
      ) {
        return true;
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
      if (systemErrorCode(error) === "ENOENT") return false;
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

function metadataSidecars(path: string): MetadataSidecarSet {
  return {
    journal: optionalMetadataSidecar(`${path}-journal`),
    shm: optionalMetadataSidecar(`${path}-shm`),
    wal: optionalMetadataSidecar(`${path}-wal`),
  };
}

function sameMetadataSidecars(
  left: MetadataSidecarSet,
  right: MetadataSidecarSet,
): boolean {
  return (
    left.journal === right.journal &&
    left.shm === right.shm &&
    left.wal === right.wal
  );
}

function canonicalMetadataPath(path: string): string {
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
      error,
    );
  }
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
    throw metadataPathError(path, "parent must be a real directory");
  }
  try {
    return join(realpathSync(parent), basename(path));
  } catch (error) {
    throw metadataPathError(
      path,
      `cannot resolve parent directory (${error instanceof Error ? error.message : String(error)})`,
      error,
    );
  }
}

function prepareExistingMetadataPath(path: string): {
  readonly canonicalPath: string;
  readonly observation: Stats;
  readonly sidecars: MetadataSidecarSet;
} {
  const canonicalPath = canonicalMetadataPath(path);
  const observation = checkedRegularMetadataPath(path);
  return {
    canonicalPath,
    observation,
    sidecars: metadataSidecars(canonicalPath),
  };
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
  readonly sidecars: MetadataSidecarSet;
} {
  const canonicalPath = canonicalMetadataPath(path);

  let pathExists = false;
  try {
    lstatSync(path);
    pathExists = true;
  } catch (error) {
    if (systemErrorCode(error) !== "ENOENT") {
      throw metadataPathError(
        path,
        `cannot inspect database file (${error instanceof Error ? error.message : String(error)})`,
        error,
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
          error,
        );
      }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  const observation = checkedRegularMetadataPath(path);
  return {
    canonicalPath,
    observation,
    sidecars: metadataSidecars(canonicalPath),
  };
}

function requireTreeOid(value: unknown, context: string): TreeOid {
  if (!isTreeOid(value)) {
    throw new MetadataError(`invalid tree oid for ${context}`);
  }
  return value;
}

function requireNonEmpty(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new MetadataError(
      `${context} must be a non-empty string without NUL bytes`,
    );
  }
  return value;
}

function checkpointSlotFromRow(
  row: CheckpointSlotRow | undefined,
  context: string,
): CheckpointSlot {
  if (row === undefined) return { kind: "open-missing" };
  if (row.capture_state !== "open" && row.capture_state !== "blocked") {
    throw new MetadataError(`invalid capture state for ${context}`);
  }
  const treeOid =
    row.tree_oid === null
      ? undefined
      : requireTreeOid(row.tree_oid, `${context} checkpoint`);
  if (treeOid === undefined) {
    if (row.capture_state !== "blocked") {
      throw new MetadataError(`invalid missing checkpoint for ${context}`);
    }
    return { kind: "blocked-missing" };
  }
  return row.capture_state === "open"
    ? { kind: "open-checkpoint", treeOid }
    : { kind: "blocked-checkpoint", treeOid };
}

function checkpointSlotIn(
  db: DatabaseSync,
  sessionId: string,
  entryId: string,
): CheckpointSlot {
  return checkpointSlotReader(db)(sessionId, entryId);
}

type CheckpointSlotReader = (
  sessionId: string,
  entryId: string,
) => CheckpointSlot;

function checkpointSlotReader(db: DatabaseSync): CheckpointSlotReader {
  let statement: StatementSync | undefined;
  return (sessionId, entryId) => {
    statement ??= db.prepare(READ_CHECKPOINT_SLOT_SQL);
    const row = statement.get(sessionId, entryId) as
      CheckpointSlotRow | undefined;
    return checkpointSlotFromRow(row, `${sessionId}/${entryId}`);
  };
}

type CheckpointSlotWriter = (
  sessionId: string,
  entryId: string,
  slot: CheckpointSlot,
) => void;

function checkpointSlotWriter(db: DatabaseSync): CheckpointSlotWriter {
  let deleteStatement: StatementSync | undefined;
  let upsertStatement: StatementSync | undefined;
  return (sessionId, entryId, slot) => {
    if (slot.kind === "open-missing") {
      deleteStatement ??= db.prepare(DELETE_CHECKPOINT_SLOT_SQL);
      deleteStatement.run(sessionId, entryId);
      return;
    }
    const treeOid =
      slot.kind === "open-checkpoint" || slot.kind === "blocked-checkpoint"
        ? slot.treeOid
        : null;
    const captureState = checkpointSlotIsBlocked(slot) ? "blocked" : "open";
    upsertStatement ??= db.prepare(UPSERT_CHECKPOINT_SLOT_SQL);
    upsertStatement.run(sessionId, entryId, treeOid, captureState);
  };
}

/**
 * Resolve one trusted root-to-target lineage from the same database snapshot
 * as the mutation that consumes it. A blocked-missing target is authoritative
 * negative knowledge for that exact location; an earlier blocked-missing slot
 * does not erase checkpoint inheritance for a descendant.
 */
function resolveCheckpointIn(
  readSlot: CheckpointSlotReader,
  sessionId: string,
  ancestryEntryIds: readonly string[],
): ResolvedCheckpointLineage {
  if (ancestryEntryIds.length === 0) {
    throw new MetadataError("checkpoint ancestry must not be empty");
  }
  const reduced: ReducedCheckpointLineage<string> = reduceCheckpointLineage(
    ancestryEntryIds,
    (entryId) => readSlot(sessionId, entryId),
  );
  return {
    resolution:
      reduced.resolution.kind === "missing"
        ? { kind: "missing" }
        : {
            kind: "checkpoint",
            entryId: reduced.resolution.coordinate,
            treeOid: reduced.resolution.treeOid,
          },
    targetSlot: reduced.targetSlot,
  };
}

function resolutionsEqual(
  left: ResolvedCheckpoint,
  right: ResolvedCheckpoint,
): boolean {
  if (left.kind !== right.kind) return false;
  return (
    left.kind === "missing" ||
    (right.kind === "checkpoint" &&
      left.entryId === right.entryId &&
      left.treeOid === right.treeOid)
  );
}

function writeCheckpointSlotIn(
  db: DatabaseSync,
  sessionId: string,
  entryId: string,
  slot: CheckpointSlot,
): void {
  checkpointSlotWriter(db)(sessionId, entryId, slot);
}

function sessionHasBarrierIn(db: DatabaseSync, sessionId: string): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM session_capture_barrier WHERE session_id = ?`)
      .get(sessionId) !== undefined
  );
}

/**
 * Authenticate an existing source database without changing its schema,
 * journal mode, main database, or WAL. A clean database is opened
 * through SQLite's immutable URI. An already-live WAL is opened read-only only
 * when its SHM companion exists; SQLite may update transient SHM read marks.
 */
export function inspectMetadataSessionIdentity(
  path: string,
  sessionId: string,
  sessionFile: string,
): MetadataIdentityInspection {
  requireNonEmpty(sessionId, "session id");
  requireNonEmpty(sessionFile, "session file");
  try {
    const prepared = prepareExistingMetadataPath(path);
    if (
      prepared.sidecars.journal ||
      prepared.sidecars.wal !== prepared.sidecars.shm
    ) {
      return {
        kind: "recovery-required",
        cause: metadataPathError(
          path,
          "database sidecars require recovery before read-only identity inspection",
        ),
      };
    }

    const location = prepared.sidecars.wal
      ? prepared.canonicalPath
      : (() => {
          const immutable = pathToFileURL(prepared.canonicalPath);
          immutable.searchParams.set("immutable", "1");
          return immutable;
        })();
    let db: DatabaseSync | undefined;
    let inspection:
      | { readonly kind: "absent" | "conflict" | "unrecognized" }
      | {
          readonly kind: "exact";
          readonly metadataVersion: MetadataVersionNode;
        }
      | undefined;
    try {
      db = new DatabaseSync(location, { readOnly: true });
      const metadataVersion = findMetadataVersion(
        CURRENT_METADATA_VERSION,
        metadataSchemaVersion(db),
      );
      if (metadataVersion === undefined) {
        inspection = { kind: "unrecognized" };
      } else {
        try {
          validateMetadataVersion(db, metadataVersion);
        } catch (error) {
          if (!(error instanceof MetadataError)) throw error;
          inspection = { kind: "unrecognized" };
        }
        if (inspection === undefined) {
          const match = metadataVersion.matchSessionIdentity(
            db,
            sessionId,
            sessionFile,
          );
          inspection =
            match === "exact"
              ? { kind: "exact", metadataVersion }
              : { kind: match };
        }
      }
    } finally {
      try {
        db?.close();
      } catch {
        // Preserve the inspection result or primary failure.
      }
    }

    const reopened = checkedRegularMetadataPath(prepared.canonicalPath);
    const sidecars = metadataSidecars(prepared.canonicalPath);
    if (
      !sameFileIdentity(prepared.observation, reopened) ||
      !sameMetadataSidecars(prepared.sidecars, sidecars)
    ) {
      throw metadataPathError(
        path,
        "database or sidecars changed while identity was inspected",
      );
    }
    if (inspection === undefined) {
      throw new MetadataError("metadata identity inspection did not complete");
    }
    if (inspection.kind !== "exact") return inspection;

    const proof = Object.freeze({}) as MetadataIdentityProof;
    metadataIdentityProofDetails.set(proof, {
      canonicalPath: prepared.canonicalPath,
      observation: reopened,
      metadataVersion: inspection.metadataVersion,
      sessionId,
      sessionFile,
      sidecars,
    });
    return { kind: "exact", proof };
  } catch (error) {
    throw error instanceof MetadataError
      ? error
      : new MetadataError(`cannot inspect metadata database at ${path}`, error);
  }
}

function sessionRegistrationFromRow(
  row: SessionRegistrationRow,
): SessionRegistration {
  const sessionId = requireNonEmpty(row.session_id, "session id");
  const sessionFile = requireNonEmpty(row.session_file, "session file");
  const captureBarrier = sessionCaptureBarrierFrom(row.capture_barrier);
  const registrationState = sessionRegistrationStateFrom(
    row.registration_state,
  );
  return {
    sessionId,
    sessionFile,
    captureBarrier,
    registrationState,
  };
}

function sessionCaptureBarrierFrom(value: unknown): boolean {
  if (value !== 0 && value !== 1) {
    throw new MetadataError("invalid session capture barrier");
  }
  return value === 1;
}

function sessionRegistrationStateFrom(
  value: unknown,
): SessionRegistrationState {
  if (value !== "pending" && value !== "verified") {
    throw new MetadataError("invalid session registration state");
  }
  return value;
}

function requireVerifiedSessionIn(
  db: DatabaseSync,
  sessionId: string,
  expectedSessionFile: string,
): void {
  const row = db
    .prepare(
      `SELECT session_file, registration_state FROM session_registry
       WHERE session_id = ?`,
    )
    .get(sessionId) as
    | {
        readonly session_file: unknown;
        readonly registration_state: unknown;
      }
    | undefined;
  const registeredFile =
    row === undefined
      ? undefined
      : requireNonEmpty(row.session_file, "session file");
  const registrationState =
    row === undefined
      ? undefined
      : sessionRegistrationStateFrom(row.registration_state);
  if (
    row === undefined ||
    registrationState !== "verified" ||
    registeredFile !== requireNonEmpty(expectedSessionFile, "session file")
  ) {
    throw new MetadataError(
      `session ${JSON.stringify(sessionId)} is not verified for metadata writes`,
    );
  }
}

function reconcileSessionBarrierIn(
  db: DatabaseSync,
  sessionId: string,
  entryIds: readonly string[],
  expectedSessionFile: string,
): ReconcileSessionBarrierResult {
  const row = db
    .prepare(
      `SELECT registry.session_file, registry.registration_state,
              EXISTS(
                SELECT 1 FROM session_capture_barrier AS barrier
                WHERE barrier.session_id = registry.session_id
              ) AS capture_barrier
       FROM session_registry AS registry
       WHERE session_id = ?`,
    )
    .get(sessionId) as
    | {
        readonly session_file: unknown;
        readonly capture_barrier: unknown;
        readonly registration_state: unknown;
      }
    | undefined;
  const registeredFile =
    row === undefined
      ? undefined
      : requireNonEmpty(row.session_file, "session file");
  const registrationState =
    row === undefined
      ? undefined
      : sessionRegistrationStateFrom(row.registration_state);
  if (
    row === undefined ||
    registrationState !== "verified" ||
    registeredFile !== requireNonEmpty(expectedSessionFile, "session file")
  ) {
    return "unregistered";
  }
  if (!sessionCaptureBarrierFrom(row.capture_barrier)) return "absent";

  const readSlot = checkpointSlotReader(db);
  const writeSlot = checkpointSlotWriter(db);
  let effectiveTreeOid: TreeOid | undefined;
  for (const entryId of entryIds) {
    const slot = readSlot(sessionId, entryId);
    if (slot.kind === "open-checkpoint" || slot.kind === "blocked-checkpoint") {
      effectiveTreeOid = slot.treeOid;
    }
    if (slot.kind === "open-checkpoint" || slot.kind === "open-missing") {
      writeSlot(
        sessionId,
        entryId,
        blockCheckpointSlot(slot, effectiveTreeOid),
      );
    }
    // BlockedMissing deliberately does not erase an effective ancestor.
  }
  const cleared = db
    .prepare(`DELETE FROM session_capture_barrier WHERE session_id = ?`)
    .run(sessionId);
  if (Number(cleared.changes) !== 1) {
    throw new MetadataError("session capture barrier changed while reconciled");
  }
  return "reconciled";
}

function uniqueEntrySet(
  entryIds: readonly string[],
  context: string,
): ReadonlySet<string> {
  if (!Array.isArray(entryIds)) {
    throw new MetadataError(`${context} must be an array`);
  }
  const retained = new Set<string>();
  for (const rawEntryId of entryIds) {
    const entryId = requireNonEmpty(rawEntryId, `${context} entry id`);
    if (retained.has(entryId)) {
      throw new MetadataError(`${context} must be unique`);
    }
    retained.add(entryId);
  }
  return retained;
}

function checkedLocationAncestry(
  entryIds: readonly string[],
  entryId: string,
  context: string,
): readonly string[] {
  const ancestry = [...uniqueEntrySet(entryIds, context)];
  if (ancestry.at(-1) !== entryId) {
    throw new MetadataError(`${context} must end at the location coordinate`);
  }
  return ancestry;
}

function checkedExpectedResolution(
  resolution: Exclude<ResolvedCheckpoint, { readonly kind: "missing" }>,
  ancestry: readonly string[],
  context: string,
): Exclude<ResolvedCheckpoint, { readonly kind: "missing" }> {
  if (
    typeof resolution !== "object" ||
    resolution === null ||
    resolution.kind !== "checkpoint"
  ) {
    throw new MetadataError(`${context} must be a checkpoint`);
  }
  const entryId = requireNonEmpty(
    resolution.entryId,
    `${context} source entry id`,
  );
  if (!ancestry.includes(entryId)) {
    throw new MetadataError(`${context} source must belong to the ancestry`);
  }
  return {
    kind: "checkpoint",
    entryId,
    treeOid: requireTreeOid(resolution.treeOid, context),
  };
}

function retainedEntrySet(entryIds: readonly string[]): ReadonlySet<string> {
  return uniqueEntrySet(entryIds, "fork retained entry ids");
}

function activeAncestry(
  entryIds: readonly string[],
  retained: ReadonlySet<string>,
): readonly string[] {
  const active = [...uniqueEntrySet(entryIds, "active ancestry entry ids")];
  if (active.some((entryId) => !retained.has(entryId))) {
    throw new MetadataError(
      "active ancestry must be contained in retained entry ids",
    );
  }
  return active;
}

function checkedProjectedSlot(
  value: CheckpointSlot,
  context: string,
): CheckpointSlot {
  if (typeof value !== "object" || value === null) {
    throw new MetadataError(`${context} is invalid`);
  }
  switch (value.kind) {
    case "open-missing":
    case "blocked-missing":
      return { kind: value.kind };
    case "open-checkpoint":
    case "blocked-checkpoint":
      return {
        kind: value.kind,
        treeOid: requireTreeOid(value.treeOid, context),
      };
    default:
      throw new MetadataError(`${context} is invalid`);
  }
}

function checkedForkProjection(
  projection: ForkCheckpointProjection | undefined,
  retained: ReadonlySet<string>,
):
  | {
      readonly barrier: boolean;
      readonly sourceSessionId: string;
      readonly slots: ReadonlyMap<string, CheckpointSlot>;
    }
  | undefined {
  if (projection === undefined) return undefined;
  if (
    typeof projection !== "object" ||
    projection === null ||
    typeof projection.barrier !== "boolean" ||
    !Array.isArray(projection.coordinates)
  ) {
    throw new MetadataError("fork checkpoint projection is invalid");
  }
  const sourceSessionId = requireNonEmpty(
    projection.sourceSessionId,
    "fork source session id",
  );
  const slots = new Map<string, CheckpointSlot>();
  for (const coordinate of projection.coordinates) {
    if (typeof coordinate !== "object" || coordinate === null) {
      throw new MetadataError("fork checkpoint coordinate is invalid");
    }
    const entryId = requireNonEmpty(
      coordinate.entryId,
      "fork checkpoint coordinate entry id",
    );
    if (!retained.has(entryId)) {
      throw new MetadataError(
        "fork projection contains a coordinate the target did not retain",
      );
    }
    if (slots.has(entryId)) {
      throw new MetadataError("fork projection contains duplicate coordinates");
    }
    slots.set(
      entryId,
      checkedProjectedSlot(coordinate.slot, "fork checkpoint coordinate"),
    );
  }
  return { barrier: projection.barrier, sourceSessionId, slots };
}

interface TrustedSessionCoordinates {
  readonly stateIds: ReadonlySet<string>;
  readonly guardedIds: ReadonlySet<string>;
}

function validateSessionCoordinatesRetainedIn(
  db: DatabaseSync,
  registration: SessionRegistration,
  retained: ReadonlySet<string>,
  context: "pending" | "verified",
): TrustedSessionCoordinates {
  const slotRows = db
    .prepare(
      `SELECT entry_id, tree_oid, capture_state FROM checkpoint_slot
       WHERE session_id = ?`,
    )
    .all(registration.sessionId) as unknown as CheckpointSlotRow[];
  const stateIds = new Set<string>();
  const guardedIds = new Set<string>();
  for (const row of slotRows) {
    const entryId = requireNonEmpty(
      row.entry_id,
      `${context} checkpoint slot entry id`,
    );
    const slot = checkpointSlotFromRow(
      row,
      `${context} checkpoint slot ${entryId}`,
    );
    if (!retained.has(entryId)) {
      throw new MetadataError(
        `${context} session contains checkpoint metadata outside the trusted session graph`,
      );
    }
    if (slot.kind === "open-checkpoint" || slot.kind === "blocked-checkpoint") {
      stateIds.add(entryId);
    }
    if (slot.kind === "blocked-missing" || slot.kind === "blocked-checkpoint") {
      guardedIds.add(entryId);
    }
  }

  return { stateIds, guardedIds };
}

function verifyPendingRegistrationIn(
  db: DatabaseSync,
  registration: SessionRegistration,
  retained: ReadonlySet<string>,
  active: readonly string[],
): void {
  const { stateIds, guardedIds } = validateSessionCoordinatesRetainedIn(
    db,
    registration,
    retained,
    "pending",
  );

  const writeSlot = checkpointSlotWriter(db);
  for (const entryId of retained) {
    if (!stateIds.has(entryId) && !guardedIds.has(entryId)) {
      writeSlot(registration.sessionId, entryId, {
        kind: "blocked-missing",
      });
    }
  }
  const verified = db
    .prepare(
      `UPDATE session_registry
       SET registration_state = 'verified'
       WHERE session_id = ?
         AND session_file = ?
         AND registration_state = 'pending'`,
    )
    .run(registration.sessionId, registration.sessionFile);
  if (Number(verified.changes) !== 1) {
    throw new MetadataError(
      "pending session registration changed while verified",
    );
  }
  if (registration.captureBarrier && active.length > 0) {
    const reconciled = reconcileSessionBarrierIn(
      db,
      registration.sessionId,
      active,
      registration.sessionFile,
    );
    if (reconciled !== "reconciled") {
      throw new MetadataError("pending session barrier changed while verified");
    }
  }
}

function exportForkProjectionIn(
  db: DatabaseSync,
  parentSessionFile: string,
  retainedEntryIds: ReadonlySet<string>,
): ForkCheckpointProjection | undefined {
  const source = db
    .prepare(
      `SELECT registry.session_id, registry.registration_state,
              EXISTS(
                SELECT 1 FROM session_capture_barrier AS barrier
                WHERE barrier.session_id = registry.session_id
              ) AS capture_barrier
       FROM session_registry AS registry
       WHERE registry.session_file = ?`,
    )
    .get(parentSessionFile) as
    | {
        readonly capture_barrier: unknown;
        readonly registration_state: unknown;
        readonly session_id: unknown;
      }
    | undefined;
  const registrationState =
    source === undefined
      ? undefined
      : sessionRegistrationStateFrom(source.registration_state);
  if (source === undefined || registrationState === "pending") {
    return undefined;
  }
  const sourceSessionId = requireNonEmpty(
    source.session_id,
    "fork source session id",
  );
  const barrier = sessionCaptureBarrierFrom(source.capture_barrier);
  const readSlot = checkpointSlotReader(db);
  return {
    sourceSessionId,
    barrier,
    coordinates: [...retainedEntryIds].map((entryId) => ({
      entryId,
      slot: readSlot(sourceSessionId, entryId),
    })),
  };
}

/** Operations available only after the database is at the current schema. */
export interface CurrentMetadataStore {
  getCheckpointSlot(sessionId: string, entryId: string): CheckpointSlot;
  resolveLineage(
    sessionId: string,
    rootToTargetEntryIds: readonly string[],
  ): ResolvedCheckpointLineage;
  commitCapture(input: CommitCaptureInput): CommitCaptureResult;
  protectLocation(input: ProtectLocationInput): ProtectLocationResult;
  admitResolvedLocation(
    input: AdmitResolvedLocationInput,
  ): AdmitResolvedLocationResult;
  adoptBlockedMissing(
    input: AdoptBlockedMissingInput,
  ): "committed" | "slot-changed";
  raiseSessionBarrier(identity: MetadataSessionIdentity): boolean;
  hasSessionBarrier(identity: MetadataSessionIdentity): boolean | undefined;
  reconcileSessionBarrier(
    identity: MetadataSessionIdentity,
    activeAncestryEntryIds: readonly string[],
  ): ReconcileSessionBarrierResult;
  matchSessionIdentity(
    sessionId: string,
    sessionFile: string,
  ): MetadataSessionIdentityMatch;
  exportForkProjection(
    input: ExportForkProjectionInput,
  ): ForkCheckpointProjection | undefined;
  finalizeSessionProjection(
    input: FinalizeSessionProjectionInput,
  ): FinalizeSessionRegistrationReport;
  listReferencedTreeOids(limit?: number): string[];
  close(): void;
}

class SqliteMetadataConnection implements CurrentMetadataStore {
  readonly #db: DatabaseSync;
  #closed = false;

  constructor(path: string, options: MetadataStoreOpenOptions) {
    const authenticatedProof = options.authenticatedProof;
    const authenticated =
      authenticatedProof === undefined
        ? undefined
        : metadataIdentityProofDetails.get(authenticatedProof);
    if (authenticatedProof !== undefined && authenticated === undefined) {
      throw new MetadataError("metadata identity proof is invalid or expired");
    }
    let db: DatabaseSync | undefined;
    try {
      const prepared =
        authenticated === undefined
          ? prepareMetadataPath(path)
          : prepareExistingMetadataPath(path);
      if (
        authenticated !== undefined &&
        (prepared.canonicalPath !== authenticated.canonicalPath ||
          !sameFileIdentity(prepared.observation, authenticated.observation) ||
          !sameMetadataSidecars(prepared.sidecars, authenticated.sidecars))
      ) {
        throw metadataPathError(
          path,
          "database or sidecars changed after identity was authenticated",
        );
      }
      db = new DatabaseSync(prepared.canonicalPath);
      const opened = checkedRegularMetadataPath(prepared.canonicalPath);
      if (!sameFileIdentity(prepared.observation, opened)) {
        throw metadataPathError(
          path,
          "database file changed while SQLite was opening it",
        );
      }
      db.exec("PRAGMA busy_timeout=5000;");
      // Authenticate every read that decides whether this connection may
      // mutate SQLite's journal in one snapshot. A second writer can finish a
      // legitimate first initialization between transactions, but cannot make
      // these version and schema reads observe different database states.
      inReadTransaction(db, (snapshot) => {
        if (authenticated !== undefined) {
          try {
            validateMetadataVersion(snapshot, authenticated.metadataVersion);
            if (
              authenticated.metadataVersion.matchSessionIdentity(
                snapshot,
                authenticated.sessionId,
                authenticated.sessionFile,
              ) !== "exact"
            ) {
              throw new MetadataError("metadata session identity changed");
            }
          } catch (error) {
            throw metadataPathError(
              path,
              "database identity changed before authenticated write access",
              error,
            );
          }
        }
        const observedVersion = metadataSchemaVersion(snapshot);
        if (observedVersion === 0) {
          validateUninitializedMetadataDatabase(snapshot);
          return;
        }
        const observed = requireMetadataVersion(
          CURRENT_METADATA_VERSION,
          snapshot,
        );
        validateMetadataVersion(snapshot, observed);
        if (observed !== CURRENT_METADATA_VERSION && !options.allowHistorical) {
          throw new MetadataError(
            `metadata schema version ${observed.version} requires openCurrentMetadataStore()`,
          );
        }
      });
      enableWalWithRetry(db);
      db.exec("PRAGMA synchronous=FULL;");
      optionalMetadataSidecar(`${prepared.canonicalPath}-wal`);
      optionalMetadataSidecar(`${prepared.canonicalPath}-shm`);
      // The persistent writer-fence triggers call this connection-private
      // capability. Connections opened by an older Cyclotomy process do not
      // have it, so their next metadata mutation fails closed after migration.
      db.function(
        METADATA_WRITER_PROTOCOL_FUNCTION,
        { deterministic: true, directOnly: false },
        () => {
          const protocol = CURRENT_METADATA_VERSION.schema.writerProtocol;
          if (protocol === undefined) {
            throw new MetadataError(
              "current metadata schema lacks writer-fence authority",
            );
          }
          return protocol;
        },
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
      // EMPTY initializes current directly. A published historical layout is
      // validated without reinterpretation and may only remain open inside the
      // async adjacent-version migration protocol.
      if (metadataSchemaVersion(db) === 0) {
        this.#transaction((locked) => {
          if (metadataSchemaVersion(locked) === 0) {
            initializeMetadataVersionWithinTransaction(
              locked,
              CURRENT_METADATA_VERSION,
            );
          } else {
            const observed = requireMetadataVersion(
              CURRENT_METADATA_VERSION,
              locked,
            );
            validateMetadataVersion(locked, observed);
            if (
              observed !== CURRENT_METADATA_VERSION &&
              !options.allowHistorical
            ) {
              throw new MetadataError(
                `metadata schema version ${observed.version} requires openCurrentMetadataStore()`,
              );
            }
          }
        });
      } else {
        const observed = requireMetadataVersion(CURRENT_METADATA_VERSION, db);
        validateMetadataVersion(db, observed);
        if (observed !== CURRENT_METADATA_VERSION && !options.allowHistorical) {
          throw new MetadataError(
            `metadata schema version ${observed.version} requires openCurrentMetadataStore()`,
          );
        }
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

  async migrateToCurrent(
    dependencies: MetadataMigrationDependencies,
  ): Promise<void> {
    await migrateMetadataToCurrent(
      this.#database(),
      dependencies,
      CURRENT_METADATA_VERSION,
    );
    validateMetadataVersion(this.#database(), CURRENT_METADATA_VERSION);
  }

  getCheckpointSlot(sessionId: string, entryId: string): CheckpointSlot {
    return checkpointSlotIn(
      this.#database(),
      requireNonEmpty(sessionId, "session id"),
      requireNonEmpty(entryId, "entry id"),
    );
  }

  /** Resolve one authenticated root-to-target lineage in one read snapshot. */
  resolveLineage(
    sessionId: string,
    rootToTargetEntryIds: readonly string[],
  ): ResolvedCheckpointLineage {
    const checkedSessionId = requireNonEmpty(sessionId, "session id");
    const ancestry = [
      ...uniqueEntrySet(rootToTargetEntryIds, "checkpoint ancestry"),
    ];
    return this.#readTransaction((db) =>
      resolveCheckpointIn(checkpointSlotReader(db), checkedSessionId, ancestry),
    );
  }

  commitCapture(input: CommitCaptureInput): CommitCaptureResult {
    const sessionId = requireNonEmpty(input.identity.sessionId, "session id");
    const sessionFile = requireNonEmpty(
      input.identity.sessionFile,
      "session file",
    );
    const entryId = requireNonEmpty(input.entryId, "entry id");
    const ancestry = [
      ...uniqueEntrySet(
        input.activeAncestryEntryIds,
        "capture active ancestry",
      ),
    ];
    if (ancestry.at(-1) !== entryId) {
      throw new MetadataError(
        "capture coordinate must end its active ancestry",
      );
    }
    const treeOid = requireTreeOid(input.treeOid, "captured checkpoint");
    return this.#transaction((db) => {
      requireVerifiedSessionIn(db, sessionId, sessionFile);
      if (
        reconcileSessionBarrierIn(db, sessionId, ancestry, sessionFile) ===
        "reconciled"
      ) {
        return "blocked";
      }
      const { targetSlot: current } = resolveCheckpointIn(
        checkpointSlotReader(db),
        sessionId,
        ancestry,
      );
      const transition = captureCheckpointSlot(current, treeOid);
      if (transition.kind === "rejected") return "blocked";
      if (!checkpointSlotsEqual(current, input.expectedSlot)) {
        return "slot-changed";
      }
      writeCheckpointSlotIn(db, sessionId, entryId, transition.slot);
      return "committed";
    });
  }

  /**
   * Protect one exact location against the effective checkpoint resolved in
   * this SQLite writer transaction. The target always receives a durable pin:
   * a checkpoint pin when one is inherited, or blocked-missing only when the
   * transaction itself resolves no checkpoint.
   *
   * Planned mutations additionally compare their trusted resolution. A stale
   * result tells the caller to abort, but is not a protection failure: the
   * returned slot was committed against the actual resolution in this same
   * transaction. Uncertain recovery requests unconditional protection.
   */
  protectLocation(input: ProtectLocationInput): ProtectLocationResult {
    const sessionId = requireNonEmpty(input.identity.sessionId, "session id");
    const sessionFile = requireNonEmpty(
      input.identity.sessionFile,
      "session file",
    );
    const entryId = requireNonEmpty(input.entryId, "entry id");
    const ancestry = checkedLocationAncestry(
      input.activeAncestryEntryIds,
      entryId,
      "protection active ancestry",
    );
    const expected =
      input.expectation.kind === "exact-resolution"
        ? checkedExpectedResolution(
            input.expectation.resolution,
            ancestry,
            "expected protected resolution",
          )
        : undefined;
    return this.#transaction((db) => {
      requireVerifiedSessionIn(db, sessionId, sessionFile);
      const hasBarrier = sessionHasBarrierIn(db, sessionId);
      const { resolution: actualResolution, targetSlot: current } =
        resolveCheckpointIn(checkpointSlotReader(db), sessionId, ancestry);
      const protectedSlot = blockCheckpointSlot(
        current,
        actualResolution.kind === "checkpoint"
          ? actualResolution.treeOid
          : undefined,
      );
      if (!checkpointSlotsEqual(current, protectedSlot)) {
        writeCheckpointSlotIn(db, sessionId, entryId, protectedSlot);
      }
      return {
        kind:
          expected !== undefined &&
          (hasBarrier || !resolutionsEqual(actualResolution, expected))
            ? "stale"
            : "protected",
        protectedSlot,
      };
    });
  }

  /**
   * Admit a location only while the complete effective resolution is still
   * authoritative. Inherited open slots need no materialization; an exact
   * matching pin is reopened by value.
   */
  admitResolvedLocation(
    input: AdmitResolvedLocationInput,
  ): AdmitResolvedLocationResult {
    const sessionId = requireNonEmpty(input.identity.sessionId, "session id");
    const sessionFile = requireNonEmpty(
      input.identity.sessionFile,
      "session file",
    );
    const entryId = requireNonEmpty(input.entryId, "entry id");
    const ancestry = checkedLocationAncestry(
      input.activeAncestryEntryIds,
      entryId,
      "admission active ancestry",
    );
    const expected = checkedExpectedResolution(
      input.expectedResolution,
      ancestry,
      "expected admitted resolution",
    );
    return this.#transaction((db) => {
      requireVerifiedSessionIn(db, sessionId, sessionFile);
      if (sessionHasBarrierIn(db, sessionId)) return "slot-changed";
      const { resolution: resolved, targetSlot: current } = resolveCheckpointIn(
        checkpointSlotReader(db),
        sessionId,
        ancestry,
      );
      if (!resolutionsEqual(resolved, expected)) return "slot-changed";

      if (current.kind === "open-missing") return "admitted";
      if (current.kind === "open-checkpoint") {
        return current.treeOid === expected.treeOid
          ? "admitted"
          : "slot-changed";
      }
      if (current.kind === "blocked-checkpoint") {
        const transition = releaseCheckpointSlot(current, expected.treeOid);
        if (transition.kind === "rejected") return "slot-changed";
        writeCheckpointSlotIn(db, sessionId, entryId, transition.slot);
        return "admitted";
      }
      return "slot-changed";
    });
  }

  adoptBlockedMissing(
    input: AdoptBlockedMissingInput,
  ): "committed" | "slot-changed" {
    const sessionId = requireNonEmpty(input.identity.sessionId, "session id");
    const sessionFile = requireNonEmpty(
      input.identity.sessionFile,
      "session file",
    );
    const entryId = requireNonEmpty(input.entryId, "entry id");
    const treeOid = requireTreeOid(input.treeOid, "adopted checkpoint");
    return this.#transaction((db) => {
      requireVerifiedSessionIn(db, sessionId, sessionFile);
      if (sessionHasBarrierIn(db, sessionId)) return "slot-changed";
      const transition = adoptBlockedMissingSlot(
        checkpointSlotIn(db, sessionId, entryId),
        treeOid,
      );
      if (transition.kind === "rejected") return "slot-changed";
      writeCheckpointSlotIn(db, sessionId, entryId, transition.slot);
      return "committed";
    });
  }

  raiseSessionBarrier(identity: MetadataSessionIdentity): boolean {
    const sessionId = requireNonEmpty(identity.sessionId, "session id");
    const sessionFile = requireNonEmpty(identity.sessionFile, "session file");
    return this.#transaction((db) => {
      requireVerifiedSessionIn(db, sessionId, sessionFile);
      db.prepare(
        `INSERT OR IGNORE INTO session_capture_barrier(session_id) VALUES (?)`,
      ).run(sessionId);
      return true;
    });
  }

  hasSessionBarrier(identity: MetadataSessionIdentity): boolean | undefined {
    const sessionId = requireNonEmpty(identity.sessionId, "session id");
    const sessionFile = requireNonEmpty(identity.sessionFile, "session file");
    const row = this.#database()
      .prepare(
        `SELECT registry.registration_state,
                EXISTS(
                  SELECT 1 FROM session_capture_barrier AS barrier
                  WHERE barrier.session_id = registry.session_id
                ) AS capture_barrier
         FROM session_registry AS registry
         WHERE registry.session_id = ? AND registry.session_file = ?`,
      )
      .get(sessionId, sessionFile) as
      | {
          readonly capture_barrier: unknown;
          readonly registration_state: unknown;
        }
      | undefined;
    if (
      row === undefined ||
      sessionRegistrationStateFrom(row.registration_state) !== "verified"
    ) {
      return undefined;
    }
    return sessionCaptureBarrierFrom(row.capture_barrier);
  }

  reconcileSessionBarrier(
    identity: MetadataSessionIdentity,
    activeAncestryEntryIds: readonly string[],
  ): ReconcileSessionBarrierResult {
    const sessionId = requireNonEmpty(identity.sessionId, "session id");
    const sessionFile = requireNonEmpty(identity.sessionFile, "session file");
    const ancestry = [
      ...uniqueEntrySet(
        activeAncestryEntryIds,
        "session barrier active ancestry",
      ),
    ];
    if (ancestry.length === 0) {
      throw new MetadataError(
        "session barrier cannot be reconciled without a stable ancestry",
      );
    }
    const result = this.#transaction((db) =>
      reconcileSessionBarrierIn(db, sessionId, ancestry, sessionFile),
    );
    return result;
  }

  /**
   * Authenticate Pi's `(id, file)` pair without depending on post-v1 columns.
   * This is intentionally usable before a published-v1 tree/schema migration.
   */
  matchSessionIdentity(
    sessionId: string,
    sessionFile: string,
  ): MetadataSessionIdentityMatch {
    requireNonEmpty(sessionId, "session id");
    requireNonEmpty(sessionFile, "session file");
    return CURRENT_METADATA_VERSION.matchSessionIdentity(
      this.#database(),
      sessionId,
      sessionFile,
    );
  }

  /**
   * Export an authenticated total slot projection. An explicit open-missing
   * slot proves absence in the verified source; an undefined projection means
   * the source itself was not authenticated.
   */
  exportForkProjection(
    input: ExportForkProjectionInput,
  ): ForkCheckpointProjection | undefined {
    const parentSessionFile = requireNonEmpty(
      input.parentSessionFile,
      "fork parent session file",
    );
    const retained = retainedEntrySet(input.retainedEntryIds);
    return this.#readTransaction((db) =>
      exportForkProjectionIn(db, parentSessionFile, retained),
    );
  }

  /** Register a session from a total, authenticated slot projection. */
  finalizeSessionProjection(
    input: FinalizeSessionProjectionInput,
  ): FinalizeSessionRegistrationReport {
    const targetSessionId = requireNonEmpty(
      input.targetSessionId,
      "fork target session id",
    );
    const targetSessionFile = requireNonEmpty(
      input.targetSessionFile,
      "fork target session file",
    );
    const retained = retainedEntrySet(input.retainedEntryIds);
    const active = activeAncestry(input.activeAncestryEntryIds, retained);

    return this.#transaction((db) => {
      const matches = db
        .prepare(
          `SELECT registry.session_id, registry.session_file,
                  registry.registration_state,
                  EXISTS(
                    SELECT 1 FROM session_capture_barrier AS barrier
                    WHERE barrier.session_id = registry.session_id
                  ) AS capture_barrier
           FROM session_registry AS registry
           WHERE registry.session_id = ? OR registry.session_file = ?`,
        )
        .all(
          targetSessionId,
          targetSessionFile,
        ) as unknown as SessionRegistrationRow[];
      if (matches.length > 0) {
        if (matches.length !== 1) {
          throw new MetadataError(
            "session identity conflicts with registered metadata",
          );
        }
        const registration = sessionRegistrationFromRow(matches[0]!);
        if (
          registration.sessionId !== targetSessionId ||
          registration.sessionFile !== targetSessionFile
        ) {
          throw new MetadataError(
            "session identity conflicts with registered metadata",
          );
        }
        if (registration.registrationState === "pending") {
          verifyPendingRegistrationIn(db, registration, retained, active);
        } else {
          validateSessionCoordinatesRetainedIn(
            db,
            registration,
            retained,
            "verified",
          );
        }
        return { kind: "existing" };
      }

      // Published v1/v2 schemas and write APIs did not enforce registry/slot
      // coupling. Claim that schema-valid recovery shape conservatively: the
      // trusted graph must contain every old coordinate, every unclassified
      // retained coordinate is blocked, and the verified registry row is
      // committed (or rolled back) as one unit.
      const orphaned = db
        .prepare(
          `SELECT EXISTS(
             SELECT 1 FROM checkpoint_slot WHERE session_id = ?
           ) AS has_slot,
           EXISTS(
             SELECT 1 FROM session_capture_barrier WHERE session_id = ?
           ) AS has_barrier`,
        )
        .get(targetSessionId, targetSessionId) as {
        readonly has_barrier: unknown;
        readonly has_slot: unknown;
      };
      const hasOrphanedSlot = Number(orphaned.has_slot);
      const hasOrphanedBarrier = Number(orphaned.has_barrier);
      if (
        (hasOrphanedSlot !== 0 && hasOrphanedSlot !== 1) ||
        (hasOrphanedBarrier !== 0 && hasOrphanedBarrier !== 1)
      ) {
        throw new MetadataError("invalid orphaned session metadata state");
      }
      if (hasOrphanedSlot === 1 || hasOrphanedBarrier === 1) {
        db.prepare(
          `INSERT INTO session_registry(
           session_id, session_file, registration_state
           ) VALUES (?, ?, 'pending')`,
        ).run(targetSessionId, targetSessionFile);
        verifyPendingRegistrationIn(
          db,
          {
            sessionId: targetSessionId,
            sessionFile: targetSessionFile,
            captureBarrier: hasOrphanedBarrier === 1,
            registrationState: "pending",
          },
          retained,
          active,
        );
        return { kind: "existing" };
      }

      let projection: ReturnType<typeof checkedForkProjection> | undefined;
      let openLeaf: string | undefined;
      let raiseBarrier = false;
      if (typeof input.seed !== "object" || input.seed === null) {
        throw new MetadataError("session registration seed is invalid");
      }
      switch (input.seed.kind) {
        case "fresh":
          openLeaf = active.at(-1);
          break;
        case "untrusted-parent":
          raiseBarrier = true;
          break;
        case "fork":
          projection = checkedForkProjection(input.seed.projection, retained);
          if (projection === undefined) {
            throw new MetadataError("fork registration projection is missing");
          }
          if (projection.sourceSessionId === targetSessionId) {
            throw new MetadataError(
              "fork source and target session ids must differ",
            );
          }
          raiseBarrier = projection.barrier;
          break;
        default:
          throw new MetadataError("session registration seed is invalid");
      }

      db.prepare(
        `INSERT INTO session_registry(
         session_id, session_file, registration_state
         ) VALUES (?, ?, 'verified')`,
      ).run(targetSessionId, targetSessionFile);

      const writeSlot = checkpointSlotWriter(db);
      for (const entryId of retained) {
        const projected = projection?.slots.get(entryId);
        const slot =
          projected ??
          (entryId === openLeaf
            ? ({ kind: "open-missing" } as const)
            : ({ kind: "blocked-missing" } as const));
        writeSlot(targetSessionId, entryId, slot);
      }
      if (raiseBarrier) {
        db.prepare(
          `INSERT INTO session_capture_barrier(session_id) VALUES (?)`,
        ).run(targetSessionId);
      }
      return { kind: "registered" };
    });
  }

  /** Every checkpoint-bearing slot, open or blocked, is an object-GC root. */
  listReferencedTreeOids(limit?: number): string[] {
    return [
      ...CURRENT_METADATA_VERSION.referencedTreeOids(this.#database(), limit),
    ];
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #readTransaction<T>(operation: (db: DatabaseSync) => T): T {
    return this.#runTransaction("BEGIN", operation);
  }

  #transaction<T>(operation: (db: DatabaseSync) => T): T {
    return this.#runTransaction("BEGIN IMMEDIATE", operation);
  }

  #runTransaction<T>(
    begin: "BEGIN" | "BEGIN IMMEDIATE",
    operation: (db: DatabaseSync) => T,
  ): T {
    const db = this.#database();
    db.exec(begin);
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

interface HistoricalMetadataCandidate {
  migrate(
    dependencies: MetadataMigrationDependencies,
  ): Promise<CurrentMetadataStore>;
  close(): void;
}

function openHistoricalMetadataCandidate(
  path: string,
  proof?: MetadataIdentityProof,
): HistoricalMetadataCandidate {
  let store: SqliteMetadataConnection | undefined =
    new SqliteMetadataConnection(path, {
      allowHistorical: true,
      ...(proof === undefined ? {} : { authenticatedProof: proof }),
    });
  const activeStore = (): SqliteMetadataConnection => {
    if (store === undefined) {
      throw new MetadataError("historical metadata candidate is closed");
    }
    return store;
  };
  return Object.freeze({
    async migrate(
      dependencies: MetadataMigrationDependencies,
    ): Promise<CurrentMetadataStore> {
      const migrated = activeStore();
      await migrated.migrateToCurrent(dependencies);
      store = undefined;
      return migrated;
    },
    close(): void {
      const active = store;
      store = undefined;
      active?.close();
    },
  });
}

async function finishOpeningCurrentMetadataStore(
  candidate: HistoricalMetadataCandidate,
  dependencies: MetadataMigrationDependencies,
): Promise<CurrentMetadataStore> {
  try {
    return await candidate.migrate(dependencies);
  } catch (primary) {
    try {
      candidate.close();
    } catch (cleanup) {
      throw new AggregateError(
        [primary, cleanup],
        "metadata migration and connection cleanup both failed",
        { cause: primary },
      );
    }
    throw primary;
  }
}

/** Create an empty store, or synchronously reopen an exact current store. */
export function createCurrentMetadataStore(path: string): CurrentMetadataStore {
  return new SqliteMetadataConnection(path, { allowHistorical: false });
}

/** Open, initialize or traverse every adjacent edge before exposing the store. */
export function openCurrentMetadataStore(
  path: string,
  dependencies: MetadataMigrationDependencies,
): Promise<CurrentMetadataStore> {
  return finishOpeningCurrentMetadataStore(
    openHistoricalMetadataCandidate(path),
    dependencies,
  );
}

/** Reopen a previously authenticated source and upgrade it before exposure. */
export function openAuthenticatedCurrentMetadataStore(
  proof: MetadataIdentityProof,
  dependencies: MetadataMigrationDependencies,
): Promise<CurrentMetadataStore> {
  const details = metadataIdentityProofDetails.get(proof);
  if (details === undefined) {
    throw new MetadataError("metadata identity proof is invalid or expired");
  }
  return finishOpeningCurrentMetadataStore(
    openHistoricalMetadataCandidate(details.canonicalPath, proof),
    dependencies,
  );
}
