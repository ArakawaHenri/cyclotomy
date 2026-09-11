import {
  storeDirectoryPresent,
  storedObjectsPresent,
} from "../infrastructure/store-presence.ts";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  observeFilesystemKind,
  type FilesystemKindProbe,
  type FilesystemKindReport,
} from "../infrastructure/filesystem-kind.ts";
import {
  readMetadataReadonly,
  type MetadataPhysicalObservation,
  type MetadataReadonlyStatus,
  type SessionScaleStats,
  type SessionStatsPage,
  type StoreSlotTotals,
} from "../infrastructure/metadata-readonly.ts";
import {
  inspectWorkspaceLock,
  type WorkspaceLockDiagnostic,
} from "../infrastructure/workspace-lock.ts";

/**
 * How one report section was obtained. `locked` means this process held the
 * workspace lock for the whole section; `snapshot` means a SQLite read
 * transaction; `observational` means a bounded read outside any stable scope;
 * `unavailable` means the section was not obtained. Byte figures observed
 * without a held scope are never evidence for deletion.
 */
export type InspectionState =
  "snapshot" | "locked" | "observational" | "unavailable";

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface StoreDiagnosticIssue {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly detail: string;
  readonly params: Readonly<Record<string, string | number | boolean | null>>;
}

function issue(
  code: string,
  severity: DiagnosticSeverity,
  detail: string,
  params: Readonly<Record<string, string | number | boolean | null>> = {},
): StoreDiagnosticIssue {
  return Object.freeze({
    code,
    severity,
    detail,
    params: Object.freeze({ ...params }),
  });
}

/** Map one read-only metadata outcome to the stable issue vocabulary. */
export function metadataStatusIssues(
  status: MetadataReadonlyStatus,
  objectsPresent: boolean | null = false,
): readonly StoreDiagnosticIssue[] {
  if (objectsPresent !== false && status.kind === "absent")
    return [
      issue(
        "metadata-missing",
        "error",
        "object storage remains but its metadata database is missing",
      ),
    ];
  switch (status.kind) {
    case "ready":
      return [];
    case "uninitialized":
      return [issue("metadata-uninitialized", "error", status.detail)];
    case "absent":
      return [issue("store-absent", "info", "the store does not exist")];
    case "needs-recovery":
      return [issue("store-needs-recovery", "error", status.detail)];
    case "unreadable":
      return [issue("store-format-unreadable", "error", status.detail)];
    case "busy":
      return [issue("store-metadata-busy", "warning", status.detail)];
    case "too-new":
      return [
        issue(
          "store-format-newer",
          "error",
          `metadata schema version ${status.version} is newer than the supported version ${status.supportedVersion}`,
          {
            observedVersion: status.version,
            supportedVersion: status.supportedVersion,
          },
        ),
      ];
    case "unsupported-version":
      return [
        issue("store-format-unsupported", "error", status.detail, {
          observedVersion: status.version,
          supportedVersion: status.supportedVersion,
        }),
      ];
    case "unexpected-shape":
      return [
        issue("store-schema-unexpected", "error", status.detail, {
          observedVersion: status.version,
          supportedVersion: status.supportedVersion,
        }),
      ];
  }
}

function lockDiagnosticIssues(
  diagnostic: WorkspaceLockDiagnostic,
): readonly StoreDiagnosticIssue[] {
  switch (diagnostic.kind) {
    case "native-acquired":
      return [];
    case "native-busy":
      return [
        issue(
          "lock-busy",
          "warning",
          "another process currently holds the native workspace lock",
        ),
      ];
    case "legacy-directory":
      return [
        issue(
          "lock-legacy-directory",
          "warning",
          "the legacy directory lock protocol will switch automatically on the next writable open",
        ),
      ];
    case "absent":
      return [
        issue(
          "lock-absent",
          "warning",
          "the native lock protocol will initialize automatically on the next writable open",
        ),
      ];
    case "interrupted-switch":
      return [
        issue(
          "lock-interrupted-switch",
          "warning",
          "the interrupted native lock protocol switch will resume on the next writable open",
        ),
      ];
    case "corrupt":
      return [issue("lock-protocol-corrupt", "error", diagnostic.detail)];
    case "inconsistent":
      return [issue("lock-protocol-inconsistent", "error", diagnostic.detail)];
    case "unsupported":
      return [
        issue(
          "lock-protocol-unsupported",
          "error",
          `observed lock protocol ${String(diagnostic.observedProtocol)} with format ${String(diagnostic.observedFormat)}`,
          {
            observedProtocol: String(diagnostic.observedProtocol),
            observedFormat: String(diagnostic.observedFormat),
          },
        ),
      ];
  }
}

/**
 * Doctor's consistency label for one lock observation. `locked` is reserved for
 * a section this process holds throughout; the read-only probe releases its one
 * non-blocking acquisition before returning, so no section may claim it here
 * and no cross-file consistency is implied.
 */
export function doctorLockState(
  diagnostic: WorkspaceLockDiagnostic,
): InspectionState {
  switch (diagnostic.kind) {
    case "native-acquired":
      return "snapshot";
    case "native-busy":
    case "legacy-directory":
    case "absent":
    case "interrupted-switch":
      return "observational";
    case "corrupt":
    case "inconsistent":
    case "unsupported":
      return "unavailable";
  }
}

export type CapacityHintId =
  | "session-checkpointed-slots"
  | "session-logical-content-bytes"
  | "store-file-bytes";

export type CapacityHintState = "within" | "reached" | "unknown";

/**
 * A fixed, visible capacity hint. Reaching one authorizes no deletion and no
 * capture refusal; it only makes long-term growth visible.
 */
export interface CapacityHint {
  readonly id: CapacityHintId;
  /** Slot count for the session hint, bytes for the other two. */
  readonly limit: bigint;
  readonly observed: bigint | null;
  readonly state: CapacityHintState;
  readonly detail: string | null;
}

export const SESSION_CHECKPOINTED_SLOT_LIMIT = 10_000n;
export const SESSION_LOGICAL_CONTENT_BYTE_LIMIT = 5n * 1024n * 1024n * 1024n;
export const STORE_FILE_BYTE_LIMIT = 10n * 1024n * 1024n * 1024n;

function capacityHint(
  id: CapacityHintId,
  limit: bigint,
  observed: bigint | null,
): CapacityHint {
  return Object.freeze({
    id,
    limit,
    observed,
    state:
      observed === null ? "unknown" : observed >= limit ? "reached" : "within",
    detail: null,
  });
}

export function evaluateSessionCapacityHints(
  stats: SessionScaleStats,
): readonly CapacityHint[] {
  return Object.freeze([
    capacityHint(
      "session-checkpointed-slots",
      SESSION_CHECKPOINTED_SLOT_LIMIT,
      BigInt(stats.checkpointedSlotCount),
    ),
    capacityHint(
      "session-logical-content-bytes",
      SESSION_LOGICAL_CONTENT_BYTE_LIMIT,
      null,
    ),
  ]);
}

export function evaluateStoreFileCapacityHint(
  fileBytes: bigint | null,
): CapacityHint {
  return capacityHint("store-file-bytes", STORE_FILE_BYTE_LIMIT, fileBytes);
}

export type DoctorCheckId =
  | "store-directory"
  | "metadata-snapshot"
  | "workspace-lock"
  | "filesystem-kind"
  | "session-scale";

export interface DoctorCheck {
  readonly id: DoctorCheckId;
  readonly state: InspectionState;
}

export interface DoctorMetadataSection {
  readonly state: InspectionState;
  /** File and page observations are never obtained under a held scope. */
  readonly physicalState: InspectionState;
  readonly status: MetadataReadonlyStatus;
  readonly version: number | null;
  readonly supportedVersion: number;
  readonly sessionHistoryAvailable: boolean | null;
  readonly physical: MetadataPhysicalObservation;
  readonly sessionCount: number | null;
  readonly slots: StoreSlotTotals | null;
}

export interface DoctorLockObservation {
  readonly state: InspectionState;
  readonly diagnostic: WorkspaceLockDiagnostic | null;
  readonly detail: string | null;
  /** True only when the checks ran under a lock this process still holds. */
  readonly held: boolean;
}

export interface StorePresenceObservation {
  readonly directoryPresent: boolean | null;
  readonly objectsPresent: boolean | null;
  readonly issues: readonly StoreDiagnosticIssue[];
}

export function observeStorePresence(root: string): StorePresenceObservation {
  const issues: StoreDiagnosticIssue[] = [];
  let directoryPresent: boolean | null = null;
  let objectsPresent: boolean | null = null;
  try {
    directoryPresent = storeDirectoryPresent(root);
  } catch (cause) {
    issues.push(issue("io-failure", "error", String(cause)));
  }
  try {
    objectsPresent = storedObjectsPresent(root);
  } catch (cause) {
    issues.push(issue("io-failure", "error", String(cause)));
  }
  return { directoryPresent, objectsPresent, issues };
}

export interface StoreDoctorReport {
  readonly storeRoot: string;
  readonly metadataPath: string;
  readonly storePresent: boolean;
  readonly directoryPresent: boolean | null;
  readonly objectsPresent: boolean | null;
  readonly metadata: DoctorMetadataSection;
  readonly lock: DoctorLockObservation;
  readonly filesystem: FilesystemKindReport;
  readonly checksPerformed: readonly DoctorCheck[];
  readonly issues: readonly StoreDiagnosticIssue[];
}

export interface StoreDoctorOptions {
  readonly filesystemKindProbe?: FilesystemKindProbe | undefined;
}

interface MetadataOverviewData {
  readonly sessionCount: number;
  readonly slots: StoreSlotTotals;
}

/** Canonical store root; a missing path resolves without being created. */
export async function canonicalStoreRoot(storeRoot: string): Promise<string> {
  try {
    return await realpath(storeRoot);
  } catch {
    return resolve(storeRoot);
  }
}

/**
 * Physical byte figures are read outside any held workspace lock, so they are
 * observations and never deletion evidence.
 */
export function physicalObservationState(
  physical: MetadataPhysicalObservation,
): InspectionState {
  const observed =
    physical.fileBytes !== null ||
    physical.walBytes !== null ||
    physical.pageCount !== null;
  return observed ? "observational" : "unavailable";
}

/**
 * Metadata facts are SQL snapshots only when the read transaction completed;
 * otherwise the section degrades to whatever physical observation remains.
 */
export function metadataObservationState(
  status: MetadataReadonlyStatus,
  physical: MetadataPhysicalObservation,
): InspectionState {
  if (status.kind === "ready") return "snapshot";
  return physicalObservationState(physical);
}

export function filesystemKindIssues(
  report: FilesystemKindReport,
): readonly StoreDiagnosticIssue[] {
  if (report.kind !== "network") return [];
  return [
    issue(
      "unsupported-filesystem",
      "error",
      `write commands will refuse a store on a network filesystem (${report.filesystemType ?? report.source})`,
      {
        filesystemType: report.filesystemType,
        evidenceSource: report.source,
      },
    ),
  ];
}

/**
 * Bounded, read-only store diagnosis. No migration, repair, VACUUM, lock
 * creation or recovery happens here; an absent store stays absent.
 */
export async function diagnoseStore(
  storeRoot: string,
  options: StoreDoctorOptions = {},
): Promise<StoreDoctorReport> {
  const canonical = await canonicalStoreRoot(storeRoot);
  const metadataPath = join(canonical, "state.db");
  const metadata = readMetadataReadonly<MetadataOverviewData | null>(
    metadataPath,
    (queries) => queries.overview(),
  );
  const presence = observeStorePresence(canonical);
  const storePresent =
    metadata.status.kind !== "absent" ||
    presence.objectsPresent !== false ||
    presence.issues.length > 0;
  const overview = metadata.data;

  const storeSection: DoctorMetadataSection = Object.freeze({
    state: metadataObservationState(metadata.status, metadata.physical),
    physicalState: physicalObservationState(metadata.physical),
    status: metadata.status,
    version: metadata.version,
    supportedVersion: metadata.supportedVersion,
    sessionHistoryAvailable: metadata.sessionHistoryAvailable,
    physical: metadata.physical,
    sessionCount: overview?.sessionCount ?? null,
    slots: overview?.slots ?? null,
  });

  let lock: DoctorLockObservation;
  const lockIssues: StoreDiagnosticIssue[] = [];
  if (storePresent) {
    try {
      const diagnostic = await inspectWorkspaceLock(canonical);
      lock = Object.freeze({
        state: doctorLockState(diagnostic),
        diagnostic,
        detail: null,
        held: false,
      });
      lockIssues.push(...lockDiagnosticIssues(diagnostic));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      lock = Object.freeze({
        state: "unavailable",
        diagnostic: null,
        detail,
        held: false,
      });
      lockIssues.push(issue("lock-inspection-failed", "error", detail));
    }
  } else {
    lock = Object.freeze({
      state: "unavailable",
      diagnostic: null,
      detail: "the store does not exist",
      held: false,
    });
  }

  const filesystem = await observeFilesystemKind(
    canonical,
    options.filesystemKindProbe,
  );

  const checksPerformed: readonly DoctorCheck[] = Object.freeze([
    { id: "store-directory", state: "observational" },
    { id: "metadata-snapshot", state: storeSection.state },
    {
      id: "session-scale",
      state: overview === null ? "unavailable" : "snapshot",
    },
    { id: "workspace-lock", state: lock.state },
    { id: "filesystem-kind", state: "observational" },
  ]);

  return Object.freeze({
    storeRoot: canonical,
    metadataPath,
    storePresent,
    directoryPresent: presence.directoryPresent,
    objectsPresent: presence.objectsPresent,
    metadata: storeSection,
    lock,
    filesystem,
    checksPerformed,
    issues: Object.freeze([
      ...metadataStatusIssues(metadata.status, presence.objectsPresent),
      ...presence.issues,
      ...lockIssues,
      ...filesystemKindIssues(filesystem),
    ]),
  });
}

export interface SessionHistoryEntry {
  readonly stats: SessionScaleStats;
  readonly capacityHints: readonly CapacityHint[];
}

export interface StoreHistoryOptions {
  readonly pageSize?: number | undefined;
  readonly cursor?: string | null | undefined;
}

export interface StoreHistoryReport {
  readonly storePresent: boolean;
  readonly directoryPresent: boolean | null;
  readonly objectsPresent: boolean | null;
  readonly storeRoot: string;
  readonly metadataPath: string;
  readonly state: InspectionState;
  readonly status: MetadataReadonlyStatus;
  readonly version: number | null;
  readonly supportedVersion: number;
  readonly sessionHistoryAvailable: boolean | null;
  readonly physical: MetadataPhysicalObservation;
  /** Empty while the store cannot be read; never a fabricated page. */
  readonly sessions: readonly SessionHistoryEntry[];
  readonly pageSize: number | null;
  readonly hasMore: boolean | null;
  readonly nextCursor: string | null;
  readonly totals: SessionStatsPage["totals"] | null;
  readonly issues: readonly StoreDiagnosticIssue[];
}

/** One bounded, deterministic history page ordered by session id. */
export async function readStoreHistory(
  storeRoot: string,
  options: StoreHistoryOptions = {},
): Promise<StoreHistoryReport> {
  const canonical = await canonicalStoreRoot(storeRoot);
  const metadataPath = join(canonical, "state.db");
  const metadata = readMetadataReadonly(metadataPath, (queries) =>
    queries.sessionPage({ pageSize: options.pageSize, cursor: options.cursor }),
  );
  const presence = observeStorePresence(canonical);
  const page = metadata.data;
  const sessions: readonly SessionHistoryEntry[] = Object.freeze(
    (page?.sessions ?? []).map((stats) =>
      Object.freeze({
        stats,
        capacityHints: evaluateSessionCapacityHints(stats),
      }),
    ),
  );
  return Object.freeze({
    storeRoot: canonical,
    metadataPath,
    storePresent:
      metadata.status.kind !== "absent" ||
      presence.objectsPresent !== false ||
      presence.issues.length > 0,
    directoryPresent: presence.directoryPresent,
    objectsPresent: presence.objectsPresent,
    state: page === null ? "unavailable" : "snapshot",
    status: metadata.status,
    version: metadata.version,
    supportedVersion: metadata.supportedVersion,
    sessionHistoryAvailable: metadata.sessionHistoryAvailable,
    physical: metadata.physical,
    sessions,
    pageSize: page?.pageSize ?? null,
    hasMore: page?.hasMore ?? null,
    nextCursor: page?.nextCursor ?? null,
    totals: page?.totals ?? null,
    issues: Object.freeze([
      ...metadataStatusIssues(metadata.status, presence.objectsPresent),
      ...presence.issues,
    ]),
  });
}
