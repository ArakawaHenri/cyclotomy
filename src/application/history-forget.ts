import { realpath } from "node:fs/promises";

import {
  openExistingMetadataStore,
  type ForgetSessionHistoryReport,
} from "../infrastructure/metadata.ts";
import type { CleanupSettlement } from "../domain/cleanup-settlement.ts";
import { combineCleanupSettlements } from "../infrastructure/failure-settlement.ts";
import {
  readMetadataReadonly,
  type MetadataReadonlyResult,
  type ReadonlyMetadataQueries,
} from "../infrastructure/metadata-readonly.ts";
import { storeMetadataPath } from "../infrastructure/workspace-store.ts";
import {
  runWithWorkspaceLock,
  type WorkspaceLockExecution,
  type WorkspaceLockOptions,
} from "../infrastructure/workspace-lock.ts";
import {
  MaintenanceBlockedError,
  MaintenancePreviewChangedError,
  maintenancePlanToken,
  type MaintenanceIssue,
} from "./maintenance-plan.ts";
import {
  observeStorePresence,
  metadataStatusIssues,
  type InspectionState,
} from "./store-diagnostics.ts";
import { prepareTreeOidUpgrades } from "./tree-migration.ts";
import {
  openObjectStore,
  type NativeObjectStore,
} from "../infrastructure/object-store.ts";

export interface SessionHistoryForgetFacts {
  readonly fingerprint: string;
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly registrationState: "pending" | "verified";
  readonly epoch: number;
  readonly resetPending: boolean;
  readonly slotCount: number;
  readonly checkpointCount: number;
  readonly blockedCount: number;
  readonly distinctTreeOidCount: number;
  readonly hasCaptureBarrier: boolean;
}

export interface SessionHistoryForgetPreview {
  readonly storeRoot: string;
  readonly stateDbPath: string;
  readonly sessionId: string;
  readonly facts: SessionHistoryForgetFacts | null;
  readonly inspection: InspectionState;
  /**
   * Non-null exactly when the preview may be applied. Deleting history is
   * never implied by a read-only command, and never by a stale token.
   */
  readonly planToken: string | null;
  readonly issues: readonly MaintenanceIssue[];
}

export interface SessionHistoryForgetResult {
  readonly kind: "forgotten";
  readonly storeRoot: string;
  readonly sessionId: string;
  readonly epoch: number;
  readonly removedSlots: number;
  readonly removedCaptureBarrier: boolean;
  /**
   * Slots are metadata rows. Their content becomes reclaimable only once GC
   * observes the references are gone, so no byte figure is promised here.
   */
  readonly reclaimedBytes: null;
}

function issue(code: string, detail: string): MaintenanceIssue {
  return Object.freeze({ code, detail });
}

type ReadFacts =
  | { readonly kind: "session"; readonly facts: SessionHistoryForgetFacts }
  | { readonly kind: "unknown-session" }
  /** A registry row that cannot describe its session is not a readable store. */
  | { readonly kind: "inconsistent"; readonly detail: string };

/**
 * Facts are read inside one SQLite read transaction, so the counts, the epoch
 * and the reference set all describe the same committed state.
 */
function readFacts(
  queries: ReadonlyMetadataQueries,
  sessionId: string,
): ReadFacts {
  const stats = queries.session(sessionId);
  if (stats === null) return { kind: "unknown-session" };
  if (
    queries.version >= 5 &&
    (stats.historyEpoch === null || stats.resetPending === null)
  ) {
    return {
      kind: "inconsistent",
      detail: "the session has no history identity",
    };
  }
  const fingerprint = queries.sessionFingerprint(sessionId);
  if (
    stats.sessionFile === null ||
    stats.registrationState === null ||
    fingerprint === undefined
  ) {
    return {
      kind: "inconsistent",
      detail: "the session registry row does not describe a complete session",
    };
  }
  return {
    kind: "session",
    facts: Object.freeze({
      fingerprint,
      sessionId: stats.sessionId,
      sessionFile: stats.sessionFile,
      registrationState: stats.registrationState,
      epoch: stats.historyEpoch ?? 0,
      resetPending: stats.resetPending ?? false,
      slotCount: stats.totalSlotCount,
      checkpointCount: stats.checkpointedSlotCount,
      blockedCount: stats.blockedSlotCount,
      distinctTreeOidCount: stats.distinctTreeOidCount,
      hasCaptureBarrier: queries.sessionCaptureBarrier(sessionId),
    }),
  };
}

/**
 * Preview removing one session's whole history. Read-only: it holds no
 * workspace lock, migrates nothing, and refuses to offer a token for a store
 * this build may not write.
 */
export async function previewSessionHistoryForget(
  storeRoot: string,
  sessionId: string,
): Promise<SessionHistoryForgetPreview> {
  const canonicalRoot = await realpath(storeRoot);
  const stateDbPath = storeMetadataPath(canonicalRoot);
  const target = requireSessionId(sessionId);
  const observed: MetadataReadonlyResult<ReadFacts> = readMetadataReadonly(
    stateDbPath,
    (queries) => readFacts(queries, target),
  );
  const read = observed.status.kind === "ready" ? observed.data : null;
  const presence = observeStorePresence(canonicalRoot);
  const issues = [
    ...(read === null
      ? metadataStatusIssues(observed.status, presence.objectsPresent).map(
          ({ code, detail }) => issue(code, detail),
        )
      : previewIssues(read)),
    ...presence.issues.map((entry) => issue("io-failure", entry.detail)),
  ];
  const facts = read?.kind === "session" ? read.facts : null;
  return Object.freeze({
    storeRoot: canonicalRoot,
    stateDbPath,
    sessionId: target,
    facts,
    inspection: observed.status.kind === "ready" ? "snapshot" : "unavailable",
    planToken:
      issues.length === 0 && facts !== null
        ? maintenancePlanToken([canonicalRoot, facts.fingerprint])
        : null,
    issues: Object.freeze(issues),
  });
}

function previewIssues(read: ReadFacts): readonly MaintenanceIssue[] {
  switch (read.kind) {
    case "session":
      return read.facts.resetPending
        ? [
            issue(
              "session-history-reset-pending",
              "this session's history was already forgotten and is waiting for its next attach; no references remain to remove",
            ),
          ]
        : [];
    case "unknown-session":
      return [issue("session-unknown", "the store has no such session")];
    case "inconsistent":
      return [issue("store-format-unreadable", read.detail)];
  }
}

/**
 * Apply a previewed forget. The workspace lock is held across the re-read and
 * the transaction, and the live facts must still match the token, so a capture
 * that landed after the preview is refused instead of deleted. The metadata
 * store repeats the comparison against every checkpoint coordinate inside its own
 * writer transaction.
 */
export async function applySessionHistoryForget(
  storeRoot: string,
  sessionId: string,
  planToken: string,
  options: WorkspaceLockOptions = {},
): Promise<WorkspaceLockExecution<SessionHistoryForgetResult>> {
  options.signal?.throwIfAborted();
  const preview = await previewSessionHistoryForget(storeRoot, sessionId);
  if (preview.issues.length > 0) {
    throw new MaintenanceBlockedError(preview.storeRoot, preview.issues);
  }
  const expected = preview.facts;
  if (
    expected === null ||
    preview.planToken === null ||
    preview.planToken !== planToken
  ) {
    throw new MaintenancePreviewChangedError(preview.storeRoot);
  }

  const canonicalRoot = preview.storeRoot;
  let metadataCleanup: CleanupSettlement = { kind: "settled" };
  const execution = await runWithWorkspaceLock(
    canonicalRoot,
    "history-forget",
    async (authority) => {
      const source = await previewSessionHistoryForget(
        canonicalRoot,
        expected.sessionId,
      );
      if (source.planToken !== planToken || source.facts === null) {
        throw new MaintenancePreviewChangedError(canonicalRoot);
      }
      options.signal?.throwIfAborted();
      const history = {
        sessionId: expected.sessionId,
        fingerprint: source.facts.fingerprint,
      };
      let objects: NativeObjectStore | undefined;
      const store = await openExistingMetadataStore(
        preview.stateDbPath,
        {
          signal: options.signal,
          history,
          prepareTreeOidUpgrades: async (roots, targetFormat) => {
            objects ??= await openObjectStore(canonicalRoot);
            return prepareTreeOidUpgrades(
              objects,
              roots,
              targetFormat,
              options,
            );
          },
        },
        authority,
      );
      try {
        options.signal?.throwIfAborted();
        const report: ForgetSessionHistoryReport = store.forgetSessionHistory(
          authority,
          {
            sessionId: expected.sessionId,
            sessionFile: expected.sessionFile,
            expectedFingerprint: history.fingerprint,
          },
        );
        return Object.freeze({
          kind: "forgotten" as const,
          storeRoot: canonicalRoot,
          sessionId: report.sessionId,
          epoch: report.epoch,
          removedSlots: report.removedSlots,
          removedCaptureBarrier: report.removedCaptureBarrier,
          reclaimedBytes: null,
        });
      } finally {
        try {
          store.close();
        } catch (cause) {
          metadataCleanup = { kind: "failed", cause };
        }
      }
    },
    options,
  );
  return {
    ...execution,
    cleanup: combineCleanupSettlements(metadataCleanup, execution.cleanup),
  };
}

function requireSessionId(sessionId: string): string {
  if (typeof sessionId !== "string" || sessionId.trim() === "") {
    throw new TypeError("session id must be a non-empty string");
  }
  return sessionId;
}
