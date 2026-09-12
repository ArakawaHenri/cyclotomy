import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { METADATA_WRITER_PROTOCOL_FUNCTION } from "../src/infrastructure/metadata/schema.ts";
import { V5_METADATA_WRITER_PROTOCOL } from "../src/infrastructure/metadata/versions/v5.ts";
import {
  assertWorkspaceWriteAuthority,
  type WorkspaceWriteAuthority,
} from "../src/infrastructure/workspace-lock.ts";

/** Persist the V5 reset state written by a concurrent 0.3.0 client. */
export function resetTestSessionHistory(
  storeRoot: string,
  sessionId: string,
  authority: WorkspaceWriteAuthority,
): void {
  assertWorkspaceWriteAuthority(authority, storeRoot);
  const db = new DatabaseSync(join(storeRoot, "state.db"));
  try {
    db.function(
      METADATA_WRITER_PROTOCOL_FUNCTION,
      () => V5_METADATA_WRITER_PROTOCOL,
    );
    db.exec("BEGIN IMMEDIATE");
    db.prepare("DELETE FROM checkpoint_slot WHERE session_id = ?").run(
      sessionId,
    );
    db.prepare("DELETE FROM session_capture_barrier WHERE session_id = ?").run(
      sessionId,
    );
    db.prepare(
      "UPDATE session_history SET history_epoch = history_epoch + 1, reset_pending = 1 WHERE session_id = ?",
    ).run(sessionId);
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

export function readTestSessionHistory(storeRoot: string, sessionId: string) {
  const db = new DatabaseSync(join(storeRoot, "state.db"), { readOnly: true });
  try {
    const row = db
      .prepare(
        `SELECT r.session_file, r.registration_state, h.history_epoch, h.reset_pending
      FROM session_registry r JOIN session_history h USING(session_id) WHERE session_id = ?`,
      )
      .get(sessionId);
    if (row === undefined) return undefined;
    const slots = db
      .prepare(
        "SELECT tree_oid, capture_state FROM checkpoint_slot WHERE session_id = ?",
      )
      .all(sessionId);
    return {
      sessionId,
      sessionFile: row.session_file,
      registrationState: row.registration_state,
      epoch: row.history_epoch,
      resetPending: row.reset_pending === 1,
      slotCount: slots.length,
      checkpointCount: slots.filter((slot) => slot.tree_oid !== null).length,
      blockedCount: slots.filter((slot) => slot.capture_state === "blocked")
        .length,
      hasCaptureBarrier:
        db
          .prepare("SELECT 1 FROM session_capture_barrier WHERE session_id = ?")
          .get(sessionId) !== undefined,
      treeOids: [
        ...new Set(
          slots.flatMap((slot) =>
            typeof slot.tree_oid === "string" ? [slot.tree_oid] : [],
          ),
        ),
      ].sort(),
    };
  } finally {
    db.close();
  }
}
