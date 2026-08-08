import { lstat } from "node:fs/promises";

import {
  collectGarbage,
  type GcReport,
} from "../infrastructure/object-gc.ts";
import type {
  MetadataStore,
  PruneMissingSessionsReport,
} from "../infrastructure/metadata.ts";
import type { ObjectStore } from "../infrastructure/object-store.ts";

/** New session metadata is retained for at least a long operator-visible window. */
export const DEFAULT_SESSION_METADATA_RETENTION_MS =
  30 * 24 * 60 * 60 * 1000;

export type SessionFileProbe = (
  sessionFile: string,
) => Promise<"present" | "missing" | "unknown">;

export interface SessionMetadataGcOptions {
  readonly now?: number;
  readonly retentionMs?: number;
  /** Test/host seam. `unknown` must preserve metadata conservatively. */
  readonly probeSessionFile?: SessionFileProbe;
}

export interface SessionMetadataGcReport
  extends PruneMissingSessionsReport {
  readonly inspectedSessions: number;
  readonly presentSessions: number;
  readonly newlyMissingSessions: number;
  readonly stillMissingSessions: number;
  readonly unknownSessions: number;
  readonly staleObservations: number;
}

export interface CyclotomyGcOptions extends SessionMetadataGcOptions {
  readonly objectGraceMs?: number;
}

/** Object counts remain separate from session/row metadata counts. */
export interface CyclotomyGcReport extends GcReport {
  readonly metadata: SessionMetadataGcReport;
}

function isMissingError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}

async function defaultProbeSessionFile(
  sessionFile: string,
): Promise<"present" | "missing" | "unknown"> {
  try {
    // Any existing filesystem entry protects metadata. Pi normally provides a
    // regular JSONL file, but GC must not turn a type surprise into deletion.
    await lstat(sessionFile);
    return "present";
  } catch (error) {
    return isMissingError(error) ? "missing" : "unknown";
  }
}

/**
 * Observe registered persisted Pi sessions and conservatively prune metadata.
 * Filesystem I/O deliberately lives here rather than in the synchronous
 * SQLite boundary.
 */
export async function collectSessionMetadataGarbage(
  metadata: MetadataStore,
  options: SessionMetadataGcOptions = {},
): Promise<SessionMetadataGcReport> {
  const now = options.now ?? Date.now();
  const retentionMs =
    options.retentionMs ?? DEFAULT_SESSION_METADATA_RETENTION_MS;
  const probe = options.probeSessionFile ?? defaultProbeSessionFile;
  const registered = metadata.listRegisteredSessions();

  let presentSessions = 0;
  let newlyMissingSessions = 0;
  let stillMissingSessions = 0;
  let unknownSessions = 0;
  let staleObservations = 0;

  for (const session of registered) {
    const state = await probe(session.sessionFile).catch(
      (): "unknown" => "unknown",
    );
    if (state === "unknown") {
      unknownSessions += 1;
      continue;
    }
    const applied =
      state === "present"
        ? metadata.observeSessionPresent(
            session.sessionId,
            session.sessionFile,
          )
        : metadata.observeSessionMissing(
            session.sessionId,
            session.sessionFile,
            now,
          );
    if (!applied) {
      staleObservations += 1;
      continue;
    }
    if (state === "present") {
      presentSessions += 1;
    } else if (session.missingSince === null) {
      newlyMissingSessions += 1;
    } else {
      stillMissingSessions += 1;
    }
  }

  // Re-probe only rows that are now eligible for destructive pruning. A Pi
  // resume can recreate its session file after the first lstat but before it
  // acquires Cyclotomy's workspace lock and touches the registry. Prune each
  // exact observation synchronously after its final probe instead of leaving a
  // batch-sized probe-to-delete window.
  const cutoff = now - retentionMs;
  let removedSessions = 0;
  let removedNodeStates = 0;
  let removedMetadataRows = 0;
  for (const session of metadata.listRegisteredSessions()) {
    if (
      session.missingSince === null ||
      session.missingObservedAt === null ||
      session.missingSince > cutoff ||
      session.missingObservedAt <= session.missingSince
    ) {
      continue;
    }
    const state = await probe(session.sessionFile).catch(
      (): "unknown" => "unknown",
    );
    if (state === "missing") {
      const pruned = metadata.pruneMissingSession({
        expectedSessionId: session.sessionId,
        expectedSessionFile: session.sessionFile,
        expectedMissingSince: session.missingSince,
        expectedMissingObservedAt: session.missingObservedAt,
        now,
        retentionMs,
      });
      removedSessions += pruned.removedSessions;
      removedNodeStates += pruned.removedNodeStates;
      removedMetadataRows += pruned.removedMetadataRows;
      if (pruned.removedSessions === 0) staleObservations += 1;
      continue;
    }
    if (state === "present") {
      metadata.observeSessionPresent(
        session.sessionId,
        session.sessionFile,
      );
      presentSessions += 1;
    } else {
      unknownSessions += 1;
    }
    stillMissingSessions = Math.max(0, stillMissingSessions - 1);
  }
  return {
    removedSessions,
    removedNodeStates,
    removedMetadataRows,
    inspectedSessions: registered.length,
    presentSessions,
    newlyMissingSessions,
    stillMissingSessions,
    unknownSessions,
    staleObservations,
  };
}

/**
 * Sweep objects first so an unreadable durable root aborts before metadata is
 * changed. Session cleanup then unroots objects for a later GC cycle; that
 * one-cycle delay is the conservative price of a fail-closed control plane.
 */
export async function collectCyclotomyGarbage(
  storeRoot: string,
  store: ObjectStore,
  metadata: MetadataStore,
  options: CyclotomyGcOptions = {},
): Promise<CyclotomyGcReport> {
  const now = options.now ?? Date.now();
  const objectReport = await collectGarbage(
    storeRoot,
    store,
    metadata,
    options.objectGraceMs,
    now,
  );
  const metadataReport = await collectSessionMetadataGarbage(metadata, {
    now,
    retentionMs:
      options.retentionMs ?? DEFAULT_SESSION_METADATA_RETENTION_MS,
    ...(options.probeSessionFile === undefined
      ? {}
      : { probeSessionFile: options.probeSessionFile }),
  });
  return { ...objectReport, metadata: metadataReport };
}
