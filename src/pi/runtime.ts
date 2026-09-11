import type {
  AgentStartEvent,
  AgentSettledEvent,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { basename, join } from "node:path";

import type {
  CaptureFailure,
  CaptureOperationOptions,
  CaptureProgress,
  CaptureSuccess,
  MissingNodeStateIntent,
} from "../application/capture.ts";
import {
  CheckpointService,
  type CheckpointCommitAuthority,
  type ResolvedReadableTree,
} from "../application/checkpoint-service.ts";
import { CyclotomyConfigError, type CyclotomyConfig } from "../config.ts";
import { collectCyclotomyGarbage } from "../application/gc.ts";
import type { GcReport } from "../infrastructure/object-gc.ts";
import type { NodeKey, Result } from "../domain/model.ts";
import type { CheckpointSlot } from "../domain/checkpoint-slot.ts";
import type { CurrentMetadataStore } from "../infrastructure/metadata.ts";
import {
  metadataHistoryResetIn,
  type MetadataHistoryResetError,
} from "../infrastructure/metadata-error.ts";
import type { NativeObjectStore } from "../infrastructure/object-store.ts";
import {
  readLastAutomaticGcAt,
  writeLastAutomaticGcAt,
} from "../infrastructure/gc-state.ts";
import type { GitReplayAttestation } from "../infrastructure/git-replay-risk.ts";
import type { CurrentTreeManifest } from "../infrastructure/tree-formats/current.ts";
import { validateTreeEntriesAgainstScope } from "../infrastructure/tree-scope-validation.ts";
import {
  runWithWorkspaceLock,
  type WorkspaceLockExecution,
  type WorkspaceWriteAuthority,
} from "../infrastructure/workspace-lock.ts";
import {
  scanWorkspace,
  scanWorkspaceForRestoreComparison,
  type ScanOptions,
  type WorkspaceSnapshot,
} from "../infrastructure/workspace-scan.ts";
import type { WorkspaceScope } from "../infrastructure/workspace-scope.ts";
import {
  isOperationCancelled,
  type WorkspaceOperationOptions,
  type WorkspaceProgress,
} from "../infrastructure/workspace-operation.ts";
import { CyclotomyI18n } from "../presentation/i18n.ts";
import {
  CheckpointAdmission,
  type ArrivalAttempt,
} from "./checkpoint-admission.ts";
import type { PendingNavigation } from "./navigation-plan.ts";
import type { SessionActivation } from "./pi-host-adapter.ts";
import type { ArrivalRecoverySettlement } from "./workspace-receipt.ts";
import {
  formatUiDetail,
  formatUiPath,
} from "../presentation/restore-presentation.ts";
import type { SessionView } from "./session-view.ts";
import { messageOfUnknown } from "../presentation/unknown-error.ts";
import {
  SessionRegistrationService,
  type SessionRegistrationPreparation,
} from "./session-registration-service.ts";
import { WorkspaceMutationAuthority } from "./workspace-mutation-authority.ts";

const GC_STATE_FILE = "gc-state.json";
const GC_OBJECT_GRACE_MS = 3_600_000;
// Automatic maintenance yields at safe batch boundaries when its budget ends.
const GC_AUTOMATIC_BUDGET_MS = 1_000;

function initializationDetail(error: unknown): string {
  return error instanceof CyclotomyConfigError
    ? `${formatUiPath(basename(error.settingsPath))}: ${formatUiDetail(
        error.detail,
      )} (${formatUiPath(error.settingsPath)})`
    : formatUiDetail(messageOfUnknown(error));
}

/** Shared runtime boundary for lifecycle and the command surface. */
export class CyclotomyRuntime {
  readonly i18n: CyclotomyI18n;
  readonly #admission = new CheckpointAdmission();
  readonly #registrations: SessionRegistrationService;
  readonly #workspaceMutations: WorkspaceMutationAuthority;
  readonly #captureAbortController = new AbortController();
  #checkpointService: CheckpointService | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #agentRunActive = false;
  #initFailureNotified = false;
  #captureFailureNotified = false;
  #historyReset: MetadataHistoryResetError | undefined;
  #initFailureDetail: string | undefined;
  #activation: SessionActivation = {
    kind: "unavailable",
    cause: new Error("Pi session registration has not completed"),
  };

  constructor(
    config: CyclotomyConfig,
    i18n: CyclotomyI18n,
    registrationFailure?: unknown,
  ) {
    this.i18n = i18n;
    this.#registrations = new SessionRegistrationService({
      signal: this.captureSignal,
      globalConfig: config,
      registrationFailure,
      runExclusively: (action) => this.enqueue(action),
    });
    this.#workspaceMutations = new WorkspaceMutationAuthority({
      admission: this.#admission,
      participationIsActive: () => this.isActive,
      agentIsRunning: (context) => this.agentIsRunning(context),
      registrations: this.#registrations,
      checkpoints: () => this.checkpoints,
      metadata: () => this.metadata,
      workspaceStoreRoot: () => this.storeRoot,
      restoreDeps: () => ({
        store: this.store,
        validateManifestScope: (manifest) =>
          this.#validateManifestScope(manifest),
      }),
      enqueueWorkspaceExecution: (operation, action) =>
        this.enqueueWorkspaceExecution(operation, action),
    });
  }

  observeAgentRun(event: AgentStartEvent | AgentSettledEvent): void {
    this.#agentRunActive = event.type === "agent_start";
  }

  /** Navigation itself keeps Pi non-idle; agent settlement includes retry gaps. */
  agentIsRunning(context: ExtensionContext): boolean {
    // The signal also covers a run before our agent_start handler is reached.
    return this.#agentRunActive || context.signal !== undefined;
  }

  get config(): CyclotomyConfig {
    return this.#registrations.config;
  }

  get store(): NativeObjectStore {
    if (!this.#registrations.isReady) {
      throw new Error("store is not initialized");
    }
    return this.#registrations.context.store;
  }

  get metadata(): CurrentMetadataStore {
    if (!this.#registrations.isReady) {
      throw new Error("metadata is not initialized");
    }
    return this.#registrations.context.metadata;
  }

  get storeRoot(): string {
    if (!this.#registrations.isReady) {
      throw new Error("store is not initialized");
    }
    return this.#registrations.context.storeRoot;
  }

  get workspaceRoot(): string {
    if (!this.#registrations.isReady) {
      throw new Error("store is not initialized");
    }
    return this.#registrations.context.workspaceRoot;
  }

  #scanOptions(): ScanOptions {
    return {
      ...this.config.scan,
      gitIgnoreScratchParent: this.storeRoot,
    };
  }

  get workspaceMutations(): WorkspaceMutationAuthority {
    return this.#workspaceMutations;
  }

  get admission(): CheckpointAdmission {
    return this.#admission;
  }

  get registrations(): SessionRegistrationService {
    return this.#registrations;
  }

  get activation(): SessionActivation {
    return this.#activation;
  }

  /** Whether this engine completed registration and may accept Pi events. */
  get isActive(): boolean {
    return this.#activation.kind === "active";
  }

  get captureSignal(): AbortSignal {
    return this.#captureAbortController.signal;
  }

  /** Assert that this Pi observation still names the registered authority. */
  assertSessionUsable(view: SessionView): void {
    if (!this.#registrations.sessionIsUsable(view)) {
      throw new Error("current persisted session identity is unavailable");
    }
  }

  markSessionActive(): void {
    if (this.#captureAbortController.signal.aborted) return;
    this.#activation = { kind: "active" };
  }

  markSessionIntentionallyInactive(): void {
    this.#admission.reset();
    this.#activation = { kind: "intentionally-inactive" };
  }

  markSessionUnavailable(cause: unknown): void {
    this.#admission.reset();
    this.#activation = { kind: "unavailable", cause };
  }

  /**
   * The retired-generation report this engine withdrew for, if any. Callers
   * use it to report the one deliberate maintenance outcome instead of every
   * protection failure it caused.
   */
  get historyReset(): MetadataHistoryResetError | undefined {
    return this.#historyReset;
  }

  /**
   * Withdraw when the store reports that this session's history generation was
   * retired. Every write under a retired generation is refused durably, so
   * retrying cannot succeed: this engine stops participating and the next
   * stable registration adopts the current generation. Returns whether the
   * cause was such a report.
   */
  noteHistoryReset(cause: unknown): boolean {
    const reset = metadataHistoryResetIn(cause);
    if (reset === undefined) return false;
    this.#historyReset = reset;
    if (this.#activation.kind !== "closed") {
      this.markSessionUnavailable(reset);
    }
    return true;
  }

  /**
   * A capture that could not commit because the generation was retired retires
   * this engine's participation in the same step, so the caller only has to
   * report the failure.
   */
  #settleCaptureResult(
    result: Result<CaptureSuccess, CaptureFailure>,
  ): Result<CaptureSuccess, CaptureFailure> {
    if (!result.ok && result.error.kind === "history-reset") {
      this.noteHistoryReset(result.error.cause);
    }
    return result;
  }

  /**
   * Atomically withdraw from Pi participation before durably closing the
   * current coordinate. The early authority revocation makes concurrent Pi
   * events pass through while the cooperative workspace lock is reacquired.
   */
  withdrawFromParticipation(
    context: ExtensionContext,
    cause: unknown,
  ): Promise<ArrivalRecoverySettlement> {
    this.markSessionUnavailable(cause);
    return this.#workspaceMutations.protectCurrentLocationForRetirement(
      context,
    );
  }

  /**
   * Stop accepting new protocol authority without tearing resources out from
   * underneath an in-flight handler. The owning controller drains the engine
   * before calling `close()`.
   */
  retire(): void {
    if (this.#activation.kind === "closed") return;
    this.#captureAbortController.abort();
    this.markSessionIntentionallyInactive();
  }

  /** Wait for every operation already admitted to the runtime queue. */
  async drain(): Promise<void> {
    await this.#queue;
  }

  get checkpoints(): CheckpointService {
    if (this.#checkpointService === undefined) {
      this.#checkpointService = new CheckpointService({
        store: this.store,
        metadata: this.metadata,
        expectedRootPath: this.workspaceRoot,
        scanOptions: this.#scanOptions(),
        validateManifestScope: (manifest) =>
          this.#validateManifestScope(manifest),
      });
    }
    return this.#checkpointService;
  }

  prepareCurrentCapture(
    context: ExtensionContext,
    view: SessionView,
    writeAuthority: WorkspaceWriteAuthority,
  ): Promise<Result<CaptureSuccess, CaptureFailure>> {
    return this.#runCapture(context, writeAuthority, "scan", (options) =>
      this.checkpoints.prepareCurrent(view, options),
    );
  }

  prepareObservedCapture(
    context: ExtensionContext,
    snapshot: WorkspaceSnapshot,
    writeAuthority: WorkspaceWriteAuthority,
  ): Promise<Result<CaptureSuccess, CaptureFailure>> {
    return this.#runCapture(context, writeAuthority, "publish", (options) =>
      this.checkpoints.prepareObserved(snapshot, options),
    );
  }

  prepareWorkspaceObservation(
    context: ExtensionContext,
    cwd: string,
    writeAuthority: WorkspaceWriteAuthority,
    scope?: WorkspaceScope,
  ): Promise<Result<WorkspaceSnapshot, CaptureFailure>> {
    return this.#runCapture(
      context,
      writeAuthority,
      "scan",
      async (options) => {
        const scanOptions = {
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          onProgress: (progress: WorkspaceProgress) =>
            options.onProgress?.({ ...progress, phase: "scan" }),
        };
        try {
          const snapshot =
            scope === undefined
              ? await this.scanCurrentWorkspace(cwd, scanOptions)
              : await this.scanCurrentWorkspaceForScope(
                  cwd,
                  scope,
                  scanOptions,
                );
          return { ok: true, value: snapshot };
        } catch (cause) {
          return {
            ok: false,
            error: isOperationCancelled(cause, options.signal)
              ? { kind: "cancelled" }
              : { kind: "scan-failed", phase: "capture", cause },
          };
        }
      },
    );
  }

  async #runCapture<Value>(
    context: ExtensionContext,
    writeAuthority: WorkspaceWriteAuthority,
    initialPhase: CaptureProgress["phase"],
    action: (
      options: CaptureOperationOptions,
    ) => Promise<Result<Value, CaptureFailure>>,
  ): Promise<Result<Value, CaptureFailure>> {
    const cancellation = new AbortController();
    const signal = AbortSignal.any([
      this.#captureAbortController.signal,
      cancellation.signal,
    ]);
    let unsubscribe: (() => void) | undefined;
    let lastPhase: CaptureProgress["phase"] | undefined;
    let lastUpdateAt = 0;
    try {
      if (context.hasUI && context.mode === "tui") {
        unsubscribe = context.ui.onTerminalInput((data) => {
          if (!matchesKey(data, "escape")) return undefined;
          cancellation.abort();
          return { consume: true };
        });
      }
    } catch {
      // Terminal controls can disappear while Pi replaces the active UI.
    }
    const onProgress = (progress: CaptureProgress): void => {
      const now = performance.now();
      if (lastPhase === progress.phase && now - lastUpdateAt < 250) return;
      lastPhase = progress.phase;
      lastUpdateAt = now;
      this.setStatus(
        context,
        this.i18n.t("captureProgress", {
          phase: this.i18n.t(
            progress.phase === "scan"
              ? "captureProgressScan"
              : progress.phase === "publish"
                ? "captureProgressPublish"
                : "captureProgressValidate",
          ),
          files: progress.files,
          bytes: (progress.bytes / (1024 * 1024)).toFixed(1),
          cancel:
            unsubscribe === undefined
              ? ""
              : this.i18n.t("captureProgressCancel"),
        }),
      );
    };
    try {
      onProgress({ phase: initialPhase, files: 0, bytes: 0 });
      return await action({ signal, onProgress, writeAuthority });
    } finally {
      try {
        unsubscribe?.();
      } catch {
        // A stale UI must not turn capture cleanup into a storage failure.
      }
      this.setStatus(context, undefined);
    }
  }

  async #validateManifestScope(
    manifest: CurrentTreeManifest,
  ): Promise<GitReplayAttestation> {
    return validateTreeEntriesAgainstScope(manifest, {
      scratchParent: this.storeRoot,
      forbiddenRoots: [this.workspaceRoot],
    });
  }

  notify(
    context: ExtensionContext,
    message: string,
    level: "info" | "warning" | "error" = "info",
  ): void {
    try {
      if (context.hasUI) {
        context.ui.notify(message, level);
      } else {
        // Print mode owns stdout and JSON mode owns a JSONL stdout protocol.
        // stderr is the only mode-safe fallback when Pi supplies its no-op UI.
        console.error(`[Cyclotomy:${level}] ${message}`);
      }
    } catch {
      // Notifications are advisory. A stale or tearing-down UI must never
      // turn an intended fail-closed lifecycle return into host fail-open.
    }
  }

  setStatus(context: ExtensionContext, message: string | undefined): void {
    try {
      if (context.hasUI) context.ui.setStatus("cyclotomy", message);
    } catch {
      // Status is advisory. Restore confirmation itself remains fail-closed
      // when its required selector cannot be shown.
    }
  }

  /**
   * Report the initialization failure once per workspace. Explicit user
   * commands pass `force` so an already-notified runtime still answers them
   * instead of appearing to do nothing.
   */
  notifyInitFailure(
    context: ExtensionContext,
    options: { readonly force?: boolean } = {},
  ): void {
    if (this.#initFailureNotified && options.force !== true) return;
    this.#initFailureNotified = true;
    this.notify(
      context,
      `${this.i18n.t("initFailure")}${
        this.#initFailureDetail === undefined
          ? ""
          : ` ${this.i18n.t("captureFailureDetail", {
              message: this.#initFailureDetail,
            })}`
      }`,
      "error",
    );
  }

  notifyCaptureResult(
    context: ExtensionContext,
    captured: boolean,
    failureMessage?: string,
  ): void {
    if (!captured && !this.#captureFailureNotified) {
      this.#captureFailureNotified = true;
      this.notify(
        context,
        `${this.i18n.t("captureLaterFailed")}${
          failureMessage === undefined
            ? ""
            : ` ${this.i18n.t("captureFailureDetail", {
                message: failureMessage,
              })}`
        }`,
        "warning",
      );
    } else if (captured) {
      this.#captureFailureNotified = false;
      this.setStatus(context, undefined);
    }
  }

  async ensureStore(cwd: string): Promise<boolean> {
    return this.#ensureStore(cwd, {
      kind: "independent",
      claim: { kind: "absent" },
    });
  }

  async ensureRegistrationStore(
    cwd: string,
    preparation: SessionRegistrationPreparation,
  ): Promise<boolean> {
    return this.#ensureStore(cwd, preparation);
  }

  async #ensureStore(
    cwd: string,
    preparation: SessionRegistrationPreparation,
  ): Promise<boolean> {
    const result = await this.#registrations.ensureStore(cwd, preparation);
    return this.#applyStoreBindingResult(result);
  }

  #applyStoreBindingResult(
    result: Awaited<ReturnType<SessionRegistrationService["ensureStore"]>>,
  ): boolean {
    if (result.kind === "failed") {
      this.#initFailureDetail = initializationDetail(result.cause);
      this.markSessionUnavailable(result.cause);
      return false;
    }
    this.#initFailureNotified = false;
    this.#initFailureDetail = undefined;
    this.#captureFailureNotified = false;
    return true;
  }

  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.catch(() => {});
    return result;
  }

  enqueueWorkspaceExecution<T>(
    operation: string,
    action: (writeAuthority: WorkspaceWriteAuthority) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<WorkspaceLockExecution<T>> {
    return this.enqueue(async () => {
      const execution = await runWithWorkspaceLock(
        this.storeRoot,
        operation,
        action,
        signal === undefined
          ? this.config.lock
          : { ...this.config.lock, signal },
      );
      // A failed release leaves the cooperative lock's future ownership
      // uncertain. Preserve the action's typed result, but stop this engine
      // from admitting any later operation.
      if (
        execution.cleanup.kind === "failed" &&
        this.#activation.kind === "active"
      ) {
        this.markSessionUnavailable(execution.cleanup.cause);
      }
      return execution;
    });
  }

  async scanCurrentWorkspace(
    cwd: string,
    options: WorkspaceOperationOptions = {},
  ): Promise<WorkspaceSnapshot> {
    const snapshot = await scanWorkspace(cwd, {
      ...this.#scanOptions(),
      ...options,
      signal:
        options.signal === undefined
          ? this.captureSignal
          : AbortSignal.any([this.captureSignal, options.signal]),
    });
    if (snapshot.rootPath !== this.workspaceRoot) {
      throw new Error(
        "workspace root changed after the checkpoint store was selected",
      );
    }
    return snapshot;
  }

  /** Inventory current paths through the restore target's durable scope. */
  async scanCurrentWorkspaceForScope(
    cwd: string,
    targetScope: WorkspaceScope,
    options: WorkspaceOperationOptions = {},
  ): Promise<WorkspaceSnapshot> {
    const snapshot = await scanWorkspaceForRestoreComparison(cwd, targetScope, {
      gitIgnoreScratchParent: this.store.storageRoot,
      ...options,
      signal:
        options.signal === undefined
          ? this.captureSignal
          : AbortSignal.any([this.captureSignal, options.signal]),
    });
    if (snapshot.rootPath !== this.workspaceRoot) {
      throw new Error(
        "workspace root changed after the checkpoint store was selected",
      );
    }
    return snapshot;
  }

  async maybeRunAutomaticGc(): Promise<
    WorkspaceLockExecution<GcReport | undefined>
  > {
    const intervalMs = this.config.autoGcIntervalMs;
    if (intervalMs <= 0) {
      return {
        kind: "completed",
        value: undefined,
        cleanup: { kind: "settled" },
      };
    }
    const storeRoot = this.storeRoot;
    const statePath = join(storeRoot, GC_STATE_FILE);
    if (Date.now() - (await readLastAutomaticGcAt(statePath)) < intervalMs) {
      return {
        kind: "completed",
        value: undefined,
        cleanup: { kind: "settled" },
      };
    }
    return this.enqueueWorkspaceExecution("auto-gc", async (writeAuthority) => {
      const startedAt = Date.now();
      if (startedAt - (await readLastAutomaticGcAt(statePath)) < intervalMs) {
        return undefined;
      }
      // Record partial passes too: a store that needs a maintenance window
      // must not consume the same interactive budget on every turn.
      const report = await collectCyclotomyGarbage(
        writeAuthority,
        this.store,
        this.metadata,
        {
          objectGraceMs: GC_OBJECT_GRACE_MS,
          budgetMs: GC_AUTOMATIC_BUDGET_MS,
          signal: this.captureSignal,
        },
      );
      await writeLastAutomaticGcAt(statePath, startedAt, writeAuthority);
      return report;
    });
  }

  async resolveReadableTreeIn(
    view: SessionView,
    node: NodeKey,
  ): Promise<ResolvedReadableTree | undefined> {
    if (this.#workspaceMutations.sessionHasBarrier(view) === true) {
      return undefined;
    }
    return this.checkpoints.resolveReadableTree(view, node);
  }

  commitPreparedCapture(
    writeAuthority: WorkspaceWriteAuthority,
    view: SessionView,
    node: NodeKey,
    prepared: CaptureSuccess,
    expectedSlot: CheckpointSlot,
  ): Result<CaptureSuccess, CaptureFailure> {
    return this.#settleCaptureResult(
      this.checkpoints.commitPrepared(
        view,
        node,
        prepared,
        expectedSlot,
        this.#captureCommitAuthority(writeAuthority),
      ),
    );
  }

  commitMissingCapture(
    writeAuthority: WorkspaceWriteAuthority,
    view: SessionView,
    node: NodeKey,
    prepared: CaptureSuccess,
    intent: MissingNodeStateIntent,
  ): Result<CaptureSuccess, CaptureFailure> {
    return this.#settleCaptureResult(
      this.checkpoints.commitMissing(
        view,
        node,
        prepared,
        intent,
        this.#captureCommitAuthority(writeAuthority),
      ),
    );
  }

  commitTreeArrivalCapture(
    writeAuthority: WorkspaceWriteAuthority,
    arrival: ArrivalAttempt<PendingNavigation | undefined>,
    view: SessionView,
    node: NodeKey,
    prepared: CaptureSuccess,
    expectedSlot: CheckpointSlot,
  ): Result<CaptureSuccess, CaptureFailure> {
    if (!this.#workspaceMutations.treeArrivalCanProceed(arrival, view, node)) {
      throw new Error("tree arrival authority changed before capture commit");
    }
    return this.#settleCaptureResult(
      this.checkpoints.commitPreparedTreeArrival(
        view,
        node,
        prepared,
        expectedSlot,
        this.#captureCommitAuthority(writeAuthority),
      ),
    );
  }

  #captureCommitAuthority(
    writeAuthority: WorkspaceWriteAuthority,
  ): CheckpointCommitAuthority {
    const authority = this.#registrations.registeredAuthority;
    if (authority === undefined) {
      throw new Error("Pi session registration authority is unavailable");
    }
    return {
      writeAuthority,
      expectedSessionFile: authority.sessionFile,
      assertWorkspaceAuthority: () => {
        if (!this.isActive) {
          throw new Error("capture commit authority was retired");
        }
        this.#registrations.assertActiveWorkspaceAuthority(authority);
        return undefined;
      },
    };
  }

  close(): void {
    this.#captureAbortController.abort();
    this.#activation = { kind: "closed" };
    this.#registrations.close();
    this.#checkpointService = undefined;
    this.#admission.reset();
    this.#initFailureNotified = false;
    this.#captureFailureNotified = false;
  }
}
