import type { MetadataReadonlyStatus } from "../infrastructure/metadata-readonly.ts";
import type { CleanupSettlement } from "../domain/cleanup-settlement.ts";
import { combineCleanupSettlements } from "../infrastructure/failure-settlement.ts";
import { storeDirectoryPresent } from "../infrastructure/store-presence.ts";
import { cliFailure, withCleanupOutcome } from "./failure.ts";
import { join } from "node:path";

import { collectCyclotomyGarbage } from "../application/gc.ts";
import { prepareTreeOidUpgrades } from "../application/tree-migration.ts";
import {
  applySessionHistoryForget,
  previewSessionHistoryForget,
} from "../application/history-forget.ts";
import {
  applyLockRecovery,
  previewLockRecovery,
} from "../application/lock-recovery.ts";

import {
  diagnoseStore,
  doctorLockState,
  evaluateStoreFileCapacityHint,
  readStoreHistory,
  type InspectionState,
  type StoreDoctorReport,
} from "../application/store-diagnostics.ts";
import { readStoreInventory } from "../application/store-inventory.ts";
import {
  observeFilesystemKind,
  type FilesystemKindReport,
} from "../infrastructure/filesystem-kind.ts";
import { openExistingMetadataStore } from "../infrastructure/metadata.ts";
import {
  type GcPhase,
  type GcProgress,
  type GcReport,
} from "../infrastructure/object-gc.ts";
import { openObjectStore } from "../infrastructure/object-store.ts";
import {
  runWithWorkspaceLock,
  type WorkspaceLockOptions,
} from "../infrastructure/workspace-lock.ts";
import type { CliInvocation } from "./arguments.ts";
import type { CliContext } from "./context.ts";
import {
  cliIssue,
  maintenanceIssue,
  storeDiagnosticIssue,
  type CliIssue,
  type CliOutcome,
  type CliStatus,
} from "./envelope.ts";
import {
  doctorHuman,
  forgetAppliedHuman,
  forgetPreviewHuman,
  gcHuman,
  historyHuman,
  inventoryHuman,
  lockRecoveryAppliedHuman,
  lockRecoveryPreviewHuman,
} from "./human.ts";
import type {
  DoctorResult,
  GcResult,
  HistoryForgetAppliedResult,
  HistoryForgetPreviewResult,
  HistoryResult,
  LockRecoveryAppliedResult,
  LockRecoveryPreviewResult,
} from "./results.ts";

/** Grace period the extension also uses before an unreferenced object is removed. */
const GC_OBJECT_GRACE_MS = 3_600_000;
/** Minimum spacing between two progress lines inside one phase. */
const GC_PROGRESS_INTERVAL_MS = 2_000;

export interface CliCommandExecution {
  readonly command: string;
  readonly storePresent: boolean | null;
  readonly storeState: InspectionState;
  readonly outcome: CliOutcome;
  /** Localized text lines; empty when the command produced no result. */
  readonly human: readonly string[];
}

export async function runCliCommand(
  context: CliContext,
  invocation: CliInvocation,
): Promise<CliCommandExecution> {
  const command = invocation.command;
  switch (command.kind) {
    case "doctor":
      return runDoctor(context);
    case "history":
      return runHistory(context, invocation);
    case "inventory":
      return runInventory(context, command.sessionId);
    case "history-forget":
      return runHistoryForget(context, command.sessionId, command.applyToken);
    case "lock-recover":
      return runLockRecovery(context, command.applyToken);
    case "gc":
      return runGc(context);
  }
}

function execution(
  command: string,
  storePresent: boolean | null,
  storeState: InspectionState,
  outcome: CliOutcome,
  human: readonly string[],
): CliCommandExecution {
  return { command, storePresent, storeState, outcome, human };
}

/** Configured lock timeout plus this process's cancellation signal. */
function lockOptions(context: CliContext): WorkspaceLockOptions {
  return context.signal === undefined
    ? { ...context.config.lock }
    : { ...context.config.lock, signal: context.signal };
}

function refusal(command: string, issue: CliIssue): CliCommandExecution {
  return execution(
    command,
    false,
    "unavailable",
    {
      status: "blocked",
      result: null,
      issues: [issue],
      checksPerformed: [],
    },
    [],
  );
}

function storeAbsentRefusal(
  context: CliContext,
  command: string,
): CliCommandExecution {
  return refusal(
    command,
    cliIssue(
      "store-absent",
      context.i18n.t("cliStoreAbsentRefusal"),
      {},
      "info",
    ),
  );
}

/**
 * Write commands refuse a store this platform classified as a network
 * filesystem. `unknown` is not a refusal: the contract only rejects proven
 * network storage, and doctor reports the classification either way.
 */
async function networkRefusal(
  context: CliContext,
  command: string,
): Promise<CliCommandExecution | undefined> {
  const filesystem = await observeFilesystemKind(
    context.storeRoot,
    context.filesystemProbe,
  );
  if (filesystem.kind !== "network") return undefined;
  return execution(
    command,
    true,
    "unavailable",
    {
      status: "unsupported",
      result: null,
      issues: [
        cliIssue(
          "unsupported-filesystem",
          context.i18n.t("cliNetworkRefusal", {
            filesystem: filesystem.filesystemType ?? filesystem.source,
          }),
          {
            filesystemType: filesystem.filesystemType,
            evidenceSource: filesystem.source,
          },
        ),
      ],
      checksPerformed: [{ id: "filesystem-kind", state: "observational" }],
    },
    [],
  );
}

function statusFromMetadataStatus(
  kind: MetadataReadonlyStatus["kind"],
): CliStatus {
  switch (kind) {
    case "ready":
      return "ok";
    case "absent":
      return "unavailable";
    case "busy":
      return "busy";
    case "too-new":
    case "unsupported-version":
      return "unsupported";
    case "uninitialized":
    case "needs-recovery":
    case "unreadable":
    case "unexpected-shape":
      return "error";
  }
}

async function runDoctor(context: CliContext): Promise<CliCommandExecution> {
  const report: StoreDoctorReport = await diagnoseStore(context.storeRoot, {
    filesystemKindProbe: context.filesystemProbe,
  });
  const issues = report.issues.map(storeDiagnosticIssue);
  const storeState: InspectionState = report.storePresent
    ? report.metadata.state
    : "unavailable";
  const result: DoctorResult = {
    directoryPresent: report.directoryPresent,
    objectsPresent: report.objectsPresent,
    metadataPath: report.metadataPath,
    metadata: report.metadata,
    lock: report.lock,
    filesystem: report.filesystem,
    capacityHints: [
      evaluateStoreFileCapacityHint(report.metadata.physical.fileBytes),
    ],
  };
  return execution(
    "doctor",
    report.storePresent,
    storeState,
    {
      status: doctorStatus(report),
      result,
      issues,
      checksPerformed: report.checksPerformed,
      // A store that does not exist is a completed diagnosis, not a failure.
      ...(report.storePresent ? {} : { exitCode: 0 }),
    },
    doctorHuman(result, context.i18n),
  );
}

/**
 * Doctor's four reportable conclusions: a consistent snapshot, plain
 * observations, a busy store, or something that could not be checked at all.
 */
function doctorStatus(report: StoreDoctorReport): CliStatus {
  if (!report.storePresent) return "unavailable";
  const metadata = statusFromMetadataStatus(report.metadata.status.kind);
  if (metadata !== "ok") return metadata;
  const lock = report.lock.diagnostic;
  if (lock === null) return "error";
  switch (lock.kind) {
    case "native-acquired":
      return "ok";
    case "native-busy":
      return "busy";
    case "unsupported":
      return "unsupported";
    case "corrupt":
    case "inconsistent":
      return "error";
    case "legacy-directory":
    case "absent":
    case "interrupted-switch":
      return "observational";
  }
}

async function runHistory(
  context: CliContext,
  invocation: CliInvocation,
): Promise<CliCommandExecution> {
  const report = await readStoreHistory(context.storeRoot, {
    pageSize: invocation.pageSize,
    cursor: invocation.cursor,
  });
  const status = statusFromMetadataStatus(report.status.kind);
  const staged = report.status.kind === "ready" ? "ok" : status;
  const result: HistoryResult = {
    directoryPresent: report.directoryPresent,
    objectsPresent: report.objectsPresent,
    metadataPath: report.metadataPath,
    state: report.state,
    metadataStatus: report.status,
    version: report.version,
    supportedVersion: report.supportedVersion,
    sessionHistoryAvailable: report.sessionHistoryAvailable,
    physical: report.physical,
    sessions: report.sessions.map((entry) =>
      Object.freeze({ ...entry.stats, capacityHints: entry.capacityHints }),
    ),
    pageSize: report.pageSize,
    hasMore: report.hasMore,
    nextCursor: report.nextCursor,
    totals: report.totals,
  };
  return execution(
    "history",
    report.storePresent,
    report.state,
    {
      status: staged,
      result,
      issues: report.issues.map(storeDiagnosticIssue),
      checksPerformed: [{ id: "metadata-snapshot", state: report.state }],
      ...(report.storePresent ? {} : { exitCode: 0 }),
    },
    historyHuman(result, context.i18n),
  );
}

async function runInventory(
  context: CliContext,
  sessionId: string | undefined,
): Promise<CliCommandExecution> {
  const report = await readStoreInventory(context.storeRoot, {
    sessionId,
    filesystemKindProbe: context.filesystemProbe,
  });
  const incompleteObjects =
    report.objectFiles !== null && !report.objectFiles.complete;
  const status: CliStatus = !report.storePresent
    ? "unavailable"
    : statusFromMetadataStatus(report.status.kind) !== "ok"
      ? statusFromMetadataStatus(report.status.kind)
      : incompleteObjects
        ? "partial"
        : "ok";
  const { storeRoot: _root, issues, ...result } = report;
  return execution(
    "inventory",
    report.storePresent,
    report.metadataState,
    {
      status,
      result,
      issues: issues.map(storeDiagnosticIssue),
      checksPerformed: [
        { id: "metadata-snapshot", state: report.metadataState },
        { id: "metadata-bytes", state: report.metadataBytesState },
        { id: "objects", state: report.objectState },
        { id: "session", state: report.sessionState },
        { id: "reclaimed-bytes", state: report.reclaimedState },
      ],
      ...(report.storePresent ? {} : { exitCode: 0 }),
    },
    inventoryHuman(result, context.i18n),
  );
}

async function runHistoryForget(
  context: CliContext,
  sessionId: string,
  applyToken: string | undefined,
): Promise<CliCommandExecution> {
  const command = "history-forget";
  if (!(await storeDirectoryPresent(context.storeRoot))) {
    return storeAbsentRefusal(context, command);
  }
  if (applyToken === undefined) {
    const preview = await previewSessionHistoryForget(
      context.storeRoot,
      sessionId,
    );
    const result: HistoryForgetPreviewResult = {
      sessionId: preview.sessionId,
      stateDbPath: preview.stateDbPath,
      facts: preview.facts,
      inspection: preview.inspection,
      planToken: preview.planToken,
      applied: false,
    };
    return execution(
      command,
      true,
      "unavailable",
      {
        status: result.planToken === null ? "blocked" : "preview",
        result,
        issues: preview.issues.map(maintenanceIssue),
        checksPerformed: [{ id: "session-history", state: preview.inspection }],
      },
      forgetPreviewHuman(result, context.i18n),
    );
  }
  const network = await networkRefusal(context, command);
  if (network !== undefined) return network;
  try {
    const applied = await applySessionHistoryForget(
      context.storeRoot,
      sessionId,
      applyToken,
      { ...lockOptions(context) },
    );
    if (applied.kind === "action-failed")
      return execution(
        command,
        true,
        "locked",
        withCleanupOutcome(
          cliFailure(applied.cause, context.signal),
          applied.cleanup,
        ),
        [],
      );
    const result: HistoryForgetAppliedResult = {
      ...applied.value,
      applied: true,
    };
    return execution(
      command,
      true,
      "locked",
      withCleanupOutcome(
        {
          status: "applied",
          result,
          issues: [],
          checksPerformed: [{ id: "session-history", state: "locked" }],
        },
        applied.cleanup,
      ),
      forgetAppliedHuman(result, context.i18n),
    );
  } catch (cause) {
    const failure = cliFailure(cause, context.signal);
    return execution(command, true, "unavailable", failure, []);
  }
}

async function runLockRecovery(
  context: CliContext,
  applyToken: string | undefined,
): Promise<CliCommandExecution> {
  const command = "lock-recover";
  if (!(await storeDirectoryPresent(context.storeRoot))) {
    return storeAbsentRefusal(context, command);
  }
  if (applyToken === undefined) {
    const preview = await previewLockRecovery(context.storeRoot);
    const result: LockRecoveryPreviewResult = {
      kind: preview.recoverable ? "preview" : "nothing-to-recover",
      recoverable: preview.recoverable,
      lockProtocol: preview.lockProtocol,
      planToken: preview.planToken,
      applied: false,
    };
    const lockState = doctorLockState(preview.lockProtocol);
    return execution(
      command,
      true,
      lockState,
      {
        status: preview.recoverable ? "preview" : "ok",
        result,
        issues: preview.issues.map(maintenanceIssue),
        checksPerformed: [{ id: "workspace-lock", state: lockState }],
      },
      lockRecoveryPreviewHuman(result, context.i18n),
    );
  }
  const network = await networkRefusal(context, command);
  if (network !== undefined) return network;
  try {
    const applied = await applyLockRecovery(context.storeRoot, applyToken, {
      offline: true,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    const result: LockRecoveryAppliedResult =
      applied.kind === "quarantined"
        ? {
            kind: "quarantined",
            storeRoot: applied.storeRoot,
            path: applied.path,
            applied: true,
          }
        : {
            kind: "nothing-to-recover",
            storeRoot: applied.storeRoot,
            path: null,
            applied: false,
          };
    return execution(
      command,
      true,
      "locked",
      {
        status: result.kind === "quarantined" ? "applied" : "ok",
        result,
        issues: [],
        checksPerformed: [{ id: "workspace-lock", state: "locked" }],
      },
      lockRecoveryAppliedHuman(result, context.i18n),
    );
  } catch (cause) {
    const failure = cliFailure(cause, context.signal);
    return execution(command, true, "unavailable", failure, []);
  }
}

/** GC owns the store for one bounded pass; nothing is deleted without the lock. */
async function runGc(context: CliContext): Promise<CliCommandExecution> {
  const command = "gc";
  if (!(await storeDirectoryPresent(context.storeRoot))) {
    return storeAbsentRefusal(context, command);
  }
  const network = await networkRefusal(context, command);
  if (network !== undefined) return network;
  const filesystem: FilesystemKindReport = await observeFilesystemKind(
    context.storeRoot,
    context.filesystemProbe,
  );
  let store: Awaited<ReturnType<typeof openObjectStore>> | undefined;
  const objects = async () =>
    (store ??= await openObjectStore(context.storeRoot, {
      maxFileBytes: context.config.scan.maxFileBytes,
      maxEntries: context.config.scan.maxEntries,
      maxManifestBytes: context.config.scan.maxManifestBytes,
      maxPathBytes: context.config.scan.maxPathBytes,
      maxPathComponents: context.config.scan.maxPathComponents,
    }));
  let metadataCleanup: CleanupSettlement = { kind: "settled" };
  const locked = await runWithWorkspaceLock(
    context.storeRoot,
    "gc",
    async (authority) => {
      const metadata = await openExistingMetadataStore(
        join(context.storeRoot, "state.db"),
        {
          signal: context.signal,
          prepareTreeOidUpgrades: async (roots, targetFormat) =>
            prepareTreeOidUpgrades(await objects(), roots, targetFormat, {
              signal: context.signal,
            }),
        },
        authority,
      );
      try {
        return await collectCyclotomyGarbage(
          authority,
          await objects(),
          metadata,
          {
            objectGraceMs: GC_OBJECT_GRACE_MS,
            ...(context.signal === undefined ? {} : { signal: context.signal }),
            onProgress: gcProgressReporter(context),
          },
        );
      } finally {
        try {
          metadata.close();
        } catch (cause) {
          metadataCleanup = { kind: "failed", cause };
        }
      }
    },
    lockOptions(context),
  );
  const cleanup = combineCleanupSettlements(metadataCleanup, locked.cleanup);
  if (locked.kind === "action-failed") {
    return execution(
      command,
      true,
      "locked",
      withCleanupOutcome(cliFailure(locked.cause, context.signal), cleanup),
      [],
    );
  }
  const report: GcReport = locked.value;
  const result: GcResult = {
    ...report,
    freedBytes: report.freedBytes.toString(),
    filesystem,
  };
  return execution(
    command,
    true,
    "locked",
    withCleanupOutcome(
      {
        // A stopped pass is honest about being partial in both directions: the
        // report says exactly what it removed, and the status says it is not the
        // whole plan. Only cancellation is a user decision, so only that one
        // takes the documented 130.
        status: report.stopped === undefined ? "applied" : "partial",
        result,
        issues:
          report.stopped === undefined
            ? []
            : [
                cliIssue(
                  report.stopped,
                  context.i18n.t(
                    report.stopped === "cancelled"
                      ? "cliGcCancelled"
                      : "cliGcBudgetExceeded",
                  ),
                ),
              ],
        ...(report.stopped === "cancelled" ? { exitCode: 130 } : {}),
        checksPerformed: [
          { id: "workspace-lock", state: "locked" },
          { id: "object-gc", state: "locked" },
        ],
      },
      cleanup,
    ),
    gcHuman(result, context.i18n),
  );
}

/**
 * One stderr line per phase change, and at most one every couple of seconds
 * inside a phase. Phase names are stable identifiers, like issue codes; the
 * surrounding line is localized.
 */
function gcProgressReporter(
  context: CliContext,
): (progress: GcProgress) => void {
  let lastPhase: GcPhase | undefined;
  let lastAt = 0;
  return (progress) => {
    const at = Date.now();
    const changed = progress.phase !== lastPhase;
    if (!changed && at - lastAt < GC_PROGRESS_INTERVAL_MS) return;
    lastPhase = progress.phase;
    lastAt = at;
    context.progress(
      context.i18n.t("cliGcProgress", {
        phase: progress.phase,
        detail:
          progress.total === null
            ? ""
            : ` · ${progress.done}/${progress.total}`,
      }),
    );
  };
}
