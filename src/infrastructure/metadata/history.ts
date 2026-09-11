import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { isTreeOid, type TreeOid } from "../../domain/model.ts";
import {
  MetadataError,
  MetadataFingerprintChangedError,
} from "../metadata-error.ts";

/** Project published pre-slot layouts into the current history semantics. */
export function legacySessionProjection(version: number): string | undefined {
  return version === 1
    ? `checkpoint_slot AS (
        SELECT session_id, entry_id, tree_oid, 'open' AS capture_state FROM node_state
      ), session_capture_barrier AS (SELECT session_id FROM session_registry WHERE 0)`
    : version === 2
      ? `checkpoint_slot AS (
          SELECT state.session_id, state.entry_id, state.tree_oid,
            CASE WHEN guard.entry_id IS NULL THEN 'open' ELSE 'blocked' END AS capture_state
          FROM node_state state LEFT JOIN node_write_guard guard
            ON guard.session_id = state.session_id AND guard.entry_id = state.entry_id
          UNION ALL
          SELECT guard.session_id, guard.entry_id, NULL, 'blocked'
          FROM node_write_guard guard WHERE NOT EXISTS (
            SELECT 1 FROM node_state state
            WHERE state.session_id = guard.session_id AND state.entry_id = guard.entry_id
          )
        ), session_capture_barrier AS (
          SELECT session_id FROM session_registry WHERE pending_node_guard = 1
        )`
      : undefined;
}

export interface SessionHistoryExpectation {
  readonly sessionId: string;
  /** Advanced only after this opener commits an authenticated migration. */
  fingerprint: string;
}

/** Hash sorted coordinates in bounded memory inside the caller's transaction. */
export function readSessionHistoryFingerprint(
  db: DatabaseSync,
  version: number,
  sessionId: string,
  replacements?: ReadonlyMap<TreeOid, TreeOid>,
): string | undefined {
  if (!db.isTransaction)
    throw new MetadataError("history fingerprint requires a transaction");
  const registry = db
    .prepare(
      `SELECT session_file,
    ${version < 3 ? "'pending'" : "registration_state"} AS registration_state
    FROM session_registry WHERE session_id = ?`,
    )
    .get(sessionId);
  if (registry === undefined) return undefined;
  if (
    typeof registry.session_file !== "string" ||
    registry.session_file.length === 0 ||
    (registry.registration_state !== "pending" &&
      registry.registration_state !== "verified")
  ) {
    throw new MetadataError("invalid session identity in history fingerprint");
  }
  const history =
    version < 5
      ? { history_epoch: 0, reset_pending: 0 }
      : db
          .prepare(
            "SELECT history_epoch, reset_pending FROM session_history WHERE session_id = ?",
          )
          .get(sessionId);
  if (
    history === undefined ||
    !Number.isSafeInteger(history.history_epoch) ||
    Number(history.history_epoch) < 0 ||
    (history.reset_pending !== 0 && history.reset_pending !== 1)
  ) {
    throw new MetadataError("invalid session history identity in fingerprint");
  }
  const projection = legacySessionProjection(version);
  const prefix = projection === undefined ? "" : `WITH ${projection} `;
  const barrier =
    db
      .prepare(
        `${prefix}SELECT 1 FROM session_capture_barrier WHERE session_id = ?`,
      )
      .get(sessionId) !== undefined;
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify([
      sessionId,
      registry.session_file,
      registry.registration_state,
      history.history_epoch,
      history.reset_pending,
      barrier,
    ]) + "\n",
  );
  const rows = db
    .prepare(
      `${prefix}SELECT entry_id, tree_oid, capture_state FROM checkpoint_slot
    WHERE session_id = ? ORDER BY entry_id COLLATE BINARY`,
    )
    .iterate(sessionId);
  for (const row of rows) {
    if (
      typeof row.entry_id !== "string" ||
      row.entry_id.length === 0 ||
      (row.tree_oid !== null && !isTreeOid(row.tree_oid)) ||
      (row.capture_state !== "open" && row.capture_state !== "blocked") ||
      (row.tree_oid === null && row.capture_state === "open")
    ) {
      throw new MetadataError("invalid checkpoint slot in history fingerprint");
    }
    let treeOid = row.tree_oid;
    if (treeOid !== null && replacements !== undefined) {
      const mapped = replacements.get(treeOid as TreeOid);
      if (mapped === undefined)
        throw new MetadataError("history migration omitted a referenced tree");
      treeOid = mapped;
    }
    hash.update(
      JSON.stringify([row.entry_id, treeOid, row.capture_state]) + "\n",
    );
  }
  return hash.digest("hex");
}

export function assertSessionHistoryExpectation(
  db: DatabaseSync,
  version: number,
  expected: SessionHistoryExpectation | undefined,
): void {
  if (
    expected !== undefined &&
    readSessionHistoryFingerprint(db, version, expected.sessionId) !==
      expected.fingerprint
  ) {
    throw new MetadataFingerprintChangedError(
      "the checkpoint mapping or session identity differs",
    );
  }
}
