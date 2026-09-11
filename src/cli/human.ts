import type { CapacityHint } from "../application/store-diagnostics.ts";
import type { MetadataPhysicalObservation } from "../infrastructure/metadata-readonly.ts";
import { formatUiDetail } from "../presentation/restore-presentation.ts";
import type { CyclotomyI18n, MessageKey } from "../presentation/i18n.ts";
import type { CliIssue, CliStatus } from "./envelope.ts";
import type {
  DoctorResult,
  GcResult,
  HistoryForgetAppliedResult,
  HistoryForgetPreviewResult,
  HistoryResult,
  InventoryResult,
  LockRecoveryAppliedResult,
  LockRecoveryPreviewResult,
} from "./results.ts";

const LABEL_WIDTH = 11;

const STATUS_KEYS: Readonly<Record<CliStatus, MessageKey>> = {
  ok: "cliStatusOk",
  observational: "cliStatusObservational",
  partial: "cliStatusPartial",
  busy: "cliStatusBusy",
  unavailable: "cliStatusUnavailable",
  unsupported: "cliStatusUnsupported",
  blocked: "cliStatusBlocked",
  preview: "cliStatusPreview",
  applied: "cliStatusApplied",
  error: "cliStatusError",
};

export function localizedStatus(
  status: CliStatus,
  i18n: CyclotomyI18n,
): string {
  return i18n.t(STATUS_KEYS[status]);
}

/** One aligned `label value` line; every value is sanitized for a terminal. */
export function line(
  label: string,
  value: string,
  width = LABEL_WIDTH,
): string {
  return `${label.padEnd(width)} ${formatUiDetail(value)}`;
}

const IEC_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;

/** Human-scale bytes; the JSON document keeps the exact decimal integer. */
export function formatBytes(value: bigint | null, i18n: CyclotomyI18n): string {
  if (value === null) return i18n.t("cliLabelUnknown");
  if (value < 1024n) return `${value} B`;
  let divisor = 1024;
  let unit = 1;
  while (unit < IEC_UNITS.length - 1 && value >= BigInt(divisor) * 1024n) {
    divisor *= 1024;
    unit += 1;
  }
  const scaled = Number(value) / divisor;
  const digits = scaled >= 100 ? 0 : 1;
  return `${scaled.toFixed(digits)} ${IEC_UNITS[unit] ?? "B"}`;
}

function count(value: number | null, i18n: CyclotomyI18n): string {
  return value === null ? i18n.t("cliLabelUnknown") : String(value);
}

function yesNo(value: boolean, i18n: CyclotomyI18n): string {
  return i18n.t(value ? "cliLabelYes" : "cliLabelNo");
}

function hintValue(hint: CapacityHint, i18n: CyclotomyI18n): string {
  const observed =
    hint.id === "session-checkpointed-slots"
      ? (hint.observed?.toString() ?? i18n.t("cliLabelUnknown"))
      : formatBytes(hint.observed, i18n);
  const limit =
    hint.id === "session-checkpointed-slots"
      ? hint.limit.toString()
      : formatBytes(hint.limit, i18n);
  const state =
    hint.state === "unknown"
      ? undefined
      : hint.state === "reached"
        ? i18n.t("cliLabelIncomplete")
        : i18n.t("cliLabelCapacityWithin");
  return `${hint.id} ${observed} / ${limit}${
    state === undefined ? "" : ` (${state})`
  }`;
}

function capacityLines(
  hints: readonly CapacityHint[],
  i18n: CyclotomyI18n,
): string[] {
  return hints.map((hint) =>
    line(i18n.t("cliLabelCapacity"), hintValue(hint, i18n)),
  );
}

function physicalLines(
  physical: MetadataPhysicalObservation,
  i18n: CyclotomyI18n,
): string {
  const page =
    physical.pageSizeBytes === null || physical.pageCount === null
      ? i18n.t("cliLabelUnknown")
      : `${physical.pageCount} × ${physical.pageSizeBytes} B = ${formatBytes(
          BigInt(physical.pageCount) * BigInt(physical.pageSizeBytes),
          i18n,
        )}`;
  return [
    `file ${formatBytes(physical.fileBytes, i18n)}`,
    `WAL ${formatBytes(physical.walBytes, i18n)}`,
    `journal ${formatBytes(physical.journalBytes, i18n)}`,
    `page ${page}`,
    `reusable ${formatBytes(
      physical.freelistCount === null || physical.pageSizeBytes === null
        ? null
        : BigInt(physical.freelistCount) * BigInt(physical.pageSizeBytes),
      i18n,
    )}`,
  ].join(" · ");
}

function sessionLine(
  stats: {
    readonly sessionId: string;
    readonly totalSlotCount: number;
    readonly checkpointedSlotCount: number;
    readonly blockedSlotCount: number;
    readonly distinctTreeOidCount: number;
    readonly historyEpoch: number | null;
    readonly resetPending: boolean | null;
  },
  i18n: CyclotomyI18n,
): string {
  const parts = [
    `${i18n.t("cliLabelSlots")} ${stats.totalSlotCount}`,
    `${i18n.t("cliLabelCheckpointed")} ${stats.checkpointedSlotCount}`,
    `${i18n.t("cliLabelBlockedSlots")} ${stats.blockedSlotCount}`,
    `${i18n.t("cliLabelTrees")} ${stats.distinctTreeOidCount}`,
  ];
  if (stats.historyEpoch !== null) {
    parts.push(`${i18n.t("cliLabelEpoch")} ${stats.historyEpoch}`);
  }
  if (stats.resetPending !== null) {
    parts.push(
      `${i18n.t("cliLabelResetPending")} ${yesNo(stats.resetPending, i18n)}`,
    );
  }
  return `${formatUiDetail(stats.sessionId)} · ${parts.join(" · ")}`;
}

export function doctorHuman(
  result: DoctorResult,
  i18n: CyclotomyI18n,
): string[] {
  const { metadata, lock, filesystem } = result;
  const slots = metadata.slots;
  return [
    line(
      i18n.t("cliLabelMetadata"),
      `${metadata.status.kind} · ${i18n.t("cliLabelSchema")} ${
        metadata.version ?? i18n.t("cliLabelUnknown")
      }/${metadata.supportedVersion} · ${metadata.state}`,
    ),
    line(
      i18n.t("cliLabelSessions"),
      `${count(metadata.sessionCount, i18n)} · ${i18n.t("cliLabelSlots")} ${
        slots?.totalSlotCount ?? i18n.t("cliLabelUnknown")
      } · ${i18n.t("cliLabelCheckpointed")} ${
        slots?.checkpointedSlotCount ?? i18n.t("cliLabelUnknown")
      } · ${i18n.t("cliLabelBlockedSlots")} ${
        slots?.blockedSlotCount ?? i18n.t("cliLabelUnknown")
      }`,
    ),
    line(i18n.t("cliLabelBytes"), physicalLines(metadata.physical, i18n)),
    line(
      i18n.t("cliLabelLock"),
      `${lock.diagnostic?.kind ?? i18n.t("cliLabelUnknown")} · ${lock.state}${
        lock.detail === null ? "" : ` · ${formatUiDetail(lock.detail)}`
      }`,
    ),
    line(
      i18n.t("cliLabelFilesystem"),
      `${filesystem.kind} · ${filesystem.filesystemType ?? filesystem.source}`,
    ),
    ...capacityLines(result.capacityHints, i18n),
  ];
}

export function historyHuman(
  result: HistoryResult,
  i18n: CyclotomyI18n,
): string[] {
  const totals = result.totals;
  const lines = [
    line(
      i18n.t("cliLabelTotals"),
      totals === null
        ? i18n.t("cliLabelUnknown")
        : `${i18n.t("cliLabelSessions")} ${totals.sessionCount} · ${i18n.t(
            "cliLabelSlots",
          )} ${totals.totalSlotCount} · ${i18n.t("cliLabelCheckpointed")} ${
            totals.checkpointedSlotCount
          } · ${i18n.t("cliLabelBlockedSlots")} ${totals.blockedSlotCount}`,
    ),
    line(i18n.t("cliLabelBytes"), physicalLines(result.physical, i18n)),
    ...result.sessions.map((session) =>
      line(i18n.t("cliLabelSession"), sessionLine(session, i18n)),
    ),
  ];
  if (result.hasMore === true && result.nextCursor !== null) {
    lines.push(
      line(i18n.t("cliLabelNextCursor"), result.nextCursor, LABEL_WIDTH),
    );
  }
  return lines;
}

export function inventoryHuman(
  result: InventoryResult,
  i18n: CyclotomyI18n,
): string[] {
  const lines = [
    line(
      i18n.t("cliLabelMetadata"),
      [
        `file ${formatBytes(result.metadataFileBytes, i18n)}`,
        `WAL ${formatBytes(result.metadataWalBytes, i18n)}`,
        `journal ${formatBytes(result.metadataJournalBytes, i18n)}`,
        `pages ${count(result.metadataPageCount, i18n)}`,
        `reusable ${formatBytes(result.metadataReusableBytes, i18n)}`,
      ].join(" · "),
    ),
  ];
  if (result.objectFiles !== null) {
    lines.push(
      line(
        i18n.t("cliLabelObjects"),
        `${formatBytes(result.objectFileBytes, i18n)} · ${
          result.objectFiles.fileCount
        } ${i18n.t("cliLabelFiles")} · ${
          result.objectFiles.complete
            ? i18n.t("cliLabelComplete")
            : i18n.t("cliLabelIncomplete")
        }`,
      ),
    );
  }
  if (result.sessionStats !== null) {
    lines.push(
      line(i18n.t("cliLabelSession"), sessionLine(result.sessionStats, i18n)),
    );
  }
  lines.push(...capacityLines(result.capacityHints, i18n));
  lines.push(
    line(i18n.t("cliLabelFacts"), result.reclamationFacts.join(" · ")),
  );
  return lines;
}

export function forgetPreviewHuman(
  result: HistoryForgetPreviewResult,
  i18n: CyclotomyI18n,
): string[] {
  const lines = [line(i18n.t("cliLabelSession"), result.sessionId)];
  if (result.facts !== null) {
    lines.push(
      line(
        i18n.t("cliLabelFacts"),
        `${i18n.t("cliLabelEpoch")} ${result.facts.epoch} · ${i18n.t(
          "cliLabelSlots",
        )} ${result.facts.slotCount} · ${i18n.t("cliLabelCheckpointed")} ${
          result.facts.checkpointCount
        } · ${i18n.t("cliLabelBlockedSlots")} ${result.facts.blockedCount} · ${i18n.t(
          "cliLabelTrees",
        )} ${result.facts.distinctTreeOidCount}`,
      ),
    );
  }
  if (result.planToken !== null) {
    lines.push(line(i18n.t("cliLabelPlanToken"), result.planToken));
    lines.push(
      line("", i18n.t("cliLabelApplyHint", { token: result.planToken })),
    );
  }
  return lines;
}

export function forgetAppliedHuman(
  result: HistoryForgetAppliedResult,
  i18n: CyclotomyI18n,
): string[] {
  return [
    line(i18n.t("cliLabelSession"), result.sessionId),
    line(
      i18n.t("cliLabelRemovedSlots"),
      `${result.removedSlots} · ${i18n.t("cliLabelEpoch")} ${result.epoch}`,
    ),
  ];
}

export function lockRecoveryPreviewHuman(
  result: LockRecoveryPreviewResult,
  i18n: CyclotomyI18n,
): string[] {
  const lines = [
    line(
      i18n.t("cliLabelRecoverable"),
      `${yesNo(result.recoverable, i18n)} · ${result.lockProtocol.kind}`,
    ),
  ];
  if (result.planToken !== null) {
    lines.push(line(i18n.t("cliLabelPlanToken"), result.planToken));
    lines.push(
      line("", i18n.t("cliLabelApplyHint", { token: result.planToken })),
    );
  }
  return lines;
}

export function lockRecoveryAppliedHuman(
  result: LockRecoveryAppliedResult,
  i18n: CyclotomyI18n,
): string[] {
  return [
    result.path === null
      ? i18n.t("cliLabelNothingToRecover")
      : i18n.t("cliLabelQuarantined", { path: result.path }),
  ];
}

export function gcHuman(result: GcResult, i18n: CyclotomyI18n): string[] {
  const lines = [
    line(
      i18n.t("cliLabelRemoved"),
      `trees ${result.removedTrees} · blobs ${result.removedBlobs} · records ${
        result.removedRecords ?? 0
      } · tmp ${result.removedTmpFiles} · packs ${result.removedPacks ?? 0}`,
    ),
    line(
      i18n.t("cliLabelFreed"),
      `${formatBytes(BigInt(result.freedBytes), i18n)} · ${i18n.t(
        "cliLabelKept",
      )} ${result.keptObjects ?? i18n.t("cliLabelUnknown")}`,
    ),
  ];
  if (result.stopped !== undefined) {
    lines.push(
      line(
        i18n.t("cliLabelStopped"),
        i18n.t(
          result.stopped === "cancelled"
            ? "cliGcCancelled"
            : "cliGcBudgetExceeded",
        ),
      ),
    );
  }
  return lines;
}

export function issueLines(
  issues: readonly CliIssue[],
  i18n: CyclotomyI18n,
): string[] {
  if (issues.length === 0) {
    return [line(i18n.t("cliLabelIssues"), i18n.t("cliLabelNone"))];
  }
  return [
    `${i18n.t("cliLabelIssues")} (${issues.length}):`,
    ...issues.map(
      (issue) =>
        `  [${issue.severity}] ${issue.code}: ${formatUiDetail(issue.detail)}`,
    ),
  ];
}
