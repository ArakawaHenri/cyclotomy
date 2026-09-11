import type { SessionHistoryForgetFacts } from "../application/history-forget.ts";
import type { ReclamationFact } from "../application/store-inventory.ts";
import type {
  CapacityHint,
  DoctorLockObservation,
  DoctorMetadataSection,
  InspectionState,
} from "../application/store-diagnostics.ts";
import type { FilesystemKindReport } from "../infrastructure/filesystem-kind.ts";
import type { GcReport } from "../infrastructure/object-gc.ts";
import type {
  MetadataPhysicalObservation,
  MetadataReadonlyStatus,
  MetadataSidecarFile,
  SessionHistoryTotals,
  SessionScaleStats,
} from "../infrastructure/metadata-readonly.ts";
import type { WorkspaceLockDiagnostic } from "../infrastructure/workspace-lock.ts";

/** The JSON payload of one command, mirrored for the human renderer. */
export interface DoctorResult {
  readonly directoryPresent: boolean | null;
  readonly objectsPresent: boolean | null;
  readonly metadataPath: string;
  readonly metadata: DoctorMetadataSection;
  readonly lock: DoctorLockObservation;
  readonly filesystem: FilesystemKindReport;
  readonly capacityHints: readonly CapacityHint[];
}

export interface SessionHistoryLine extends SessionScaleStats {
  readonly capacityHints: readonly CapacityHint[];
}

export interface HistoryResult {
  readonly directoryPresent: boolean | null;
  readonly objectsPresent: boolean | null;
  readonly metadataPath: string;
  readonly state: InspectionState;
  readonly metadataStatus: MetadataReadonlyStatus;
  readonly version: number | null;
  readonly supportedVersion: number;
  readonly sessionHistoryAvailable: boolean | null;
  readonly physical: MetadataPhysicalObservation;
  readonly sessions: readonly SessionHistoryLine[];
  readonly pageSize: number | null;
  readonly hasMore: boolean | null;
  readonly nextCursor: string | null;
  readonly totals: SessionHistoryTotals | null;
}

export interface InventoryResult {
  readonly directoryPresent: boolean | null;
  readonly objectsPresent: boolean | null;
  readonly metadataPath: string;
  readonly storePresent: boolean;
  readonly metadataState: InspectionState;
  readonly metadataBytesState: InspectionState;
  readonly status: MetadataReadonlyStatus;
  readonly version: number | null;
  readonly supportedVersion: number;
  readonly sessionHistoryAvailable: boolean | null;
  readonly metadataFileBytes: bigint | null;
  readonly metadataWalBytes: bigint | null;
  readonly metadataJournalBytes: bigint | null;
  readonly metadataOtherSidecarFiles: readonly MetadataSidecarFile[];
  readonly metadataAllocatedBlocks: bigint | null;
  readonly metadataPageBytes: bigint | null;
  readonly metadataReusableBytes: bigint | null;
  readonly metadataUsedPageEstimateBytes: bigint | null;
  readonly metadataPageSizeBytes: number | null;
  readonly metadataPageCount: number | null;
  readonly metadataFreelistCount: number | null;
  readonly objectFileBytes: bigint | null;
  readonly objectState: InspectionState;
  readonly objectFiles: {
    readonly present: boolean;
    readonly complete: boolean;
    readonly fileCount: number;
    readonly skippedEntries: number;
    readonly objectFileBytes: bigint;
    readonly looseObjectBytes: bigint;
    readonly looseRecordBytes: bigint;
    readonly packBytes: bigint;
    readonly incomingBytes: bigint;
    readonly temporaryBytes: bigint;
    readonly otherBytes: bigint;
    readonly detail: string | null;
  } | null;
  readonly sessionId: string | null;
  readonly sessionState: InspectionState;
  readonly sessionFound: boolean | null;
  readonly sessionStats: SessionScaleStats | null;
  readonly sessionLogicalContentBytes: bigint | null;
  readonly sessionLogicalContentDetail: string;
  readonly reclaimedState: InspectionState;
  readonly reclaimedBytes: bigint | null;
  readonly reclaimedBytesDetail: string;
  readonly capacityHints: readonly CapacityHint[];
  readonly reclamationFacts: readonly ReclamationFact[];
  readonly filesystem: FilesystemKindReport;
}

export interface HistoryForgetPreviewResult {
  readonly sessionId: string;
  readonly stateDbPath: string;
  readonly facts: SessionHistoryForgetFacts | null;
  readonly inspection: InspectionState;
  readonly planToken: string | null;
  readonly applied: false;
}

export interface HistoryForgetAppliedResult {
  readonly kind: "forgotten";
  readonly storeRoot: string;
  readonly sessionId: string;
  readonly epoch: number;
  readonly removedSlots: number;
  readonly removedCaptureBarrier: boolean;
  readonly reclaimedBytes: null;
  readonly applied: true;
}

export interface LockRecoveryPreviewResult {
  readonly kind: "preview" | "nothing-to-recover";
  readonly recoverable: boolean;
  readonly lockProtocol: WorkspaceLockDiagnostic;
  readonly planToken: string | null;
  readonly applied: false;
}

export interface LockRecoveryAppliedResult {
  readonly kind: "quarantined" | "nothing-to-recover";
  readonly storeRoot: string;
  /** Quarantine destination; null when there was nothing to recover. */
  readonly path: string | null;
  readonly applied: boolean;
}

/** GC's report with its reclaimed byte total as a decimal integer string. */
export interface GcResult extends Omit<GcReport, "freedBytes"> {
  readonly freedBytes: string;
  readonly filesystem: FilesystemKindReport;
}
