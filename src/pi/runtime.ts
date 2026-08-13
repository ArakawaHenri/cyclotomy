import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { basename, join } from "node:path";

import type {
  CaptureFailure,
  CaptureSuccess,
  MissingNodeStateIntent,
} from "../application/capture.ts";
import {
  CheckpointService,
  type ResolvedReadableTree,
} from "../application/checkpoint-service.ts";
import { CyclotomyConfigError, type CyclotomyConfig } from "../config.ts";
import { collectCyclotomyGarbage } from "../application/gc.ts";
import type { NodeKey, Result, TreeOid } from "../domain/model.ts";
import type { CheckpointSlot } from "../domain/checkpoint-slot.ts";
import type { CurrentMetadataStore } from "../infrastructure/metadata.ts";
import type { NativeObjectStore } from "../infrastructure/object-store.ts";
import type { TreeManifest } from "../infrastructure/tree-formats/manifest-codec.ts";
import { upgradeTreeManifestToCurrent } from "../infrastructure/tree-formats/history.ts";
import { validateTreeEntriesAgainstScope } from "../infrastructure/tree-scope-validation.ts";
import {
  runWithWorkspaceLock,
  type WorkspaceLockExecution,
} from "../infrastructure/workspace-lock.ts";
import {
  scanWorkspace,
  scanWorkspaceForScope,
  type ScanOptions,
  type WorkspaceSnapshot,
} from "../infrastructure/workspace-scan.ts";
import type { WorkspaceScope } from "../infrastructure/workspace-scope.ts";
import { CyclotomyI18n } from "./i18n.ts";
import {
  CheckpointAdmission,
  type ArrivalAttempt,
} from "./checkpoint-admission.ts";
import type { PendingNavigation } from "./navigation-plan.ts";
import type { SessionActivation } from "./pi-host-adapter.ts";
import { formatUiDetail, formatUiPath } from "./restore-presentation.ts";
import type { SessionView } from "./session-view.ts";
import { messageOfUnknown } from "./unknown-error.ts";
import {
  SessionRegistrationService,
  type SessionRegistrationPreparation,
} from "./session-registration-service.ts";
import { WorkspaceMutationAuthority } from "./workspace-mutation-authority.ts";

const GC_STATE_FILE = "gc-state.json";
const GC_OBJECT_GRACE_MS = 3_600_000;
const PRESENTATION_FAILURE_MESSAGE =
  "Cyclotomy blocked this operation, but could not render its diagnostic message.";
const PRESENTATION_STATUS_FALLBACK = "Cyclotomy · safety check in progress…";

function systemErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null
    ? typeof Reflect.get(error, "code") === "string"
      ? (Reflect.get(error, "code") as string)
      : undefined
    : undefined;
}

type GcScheduleState =
  | { readonly kind: "absent" }
  | { readonly kind: "valid"; readonly lastRunAt: number }
  | { readonly kind: "invalid"; readonly cause: unknown };

async function readAutomaticGcSchedule(path: string): Promise<GcScheduleState> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (cause) {
    return systemErrorCode(cause) === "ENOENT"
      ? { kind: "absent" }
      : { kind: "invalid", cause };
  }
  try {
    const parsed = JSON.parse(contents) as { lastGcAt?: unknown };
    if (
      typeof parsed.lastGcAt === "number" &&
      Number.isFinite(parsed.lastGcAt) &&
      parsed.lastGcAt >= 0
    ) {
      return { kind: "valid", lastRunAt: parsed.lastGcAt };
    }
    throw new Error("automatic GC schedule has an invalid lastGcAt value");
  } catch (cause) {
    return { kind: "invalid", cause };
  }
}

async function lastAutomaticGcAt(path: string): Promise<number> {
  const state = await readAutomaticGcSchedule(path);
  switch (state.kind) {
    case "absent":
      return 0;
    case "valid":
      return state.lastRunAt;
    case "invalid":
      throw new Error("automatic GC schedule is unreadable", {
        cause: state.cause,
      });
  }
}

async function writeLastAutomaticGcAt(
  path: string,
  lastGcAt: number,
): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(`${JSON.stringify({ lastGcAt })}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => {});
    }
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

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
  #checkpointService: CheckpointService | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #initFailureNotified = false;
  #captureFailureNotified = false;
  #initFailureDetail: string | undefined;
  #activation: SessionActivation = {
    kind: "unavailable",
    cause: new Error("Pi session registration has not completed"),
  };
  /** One-entry cache avoids repeating the same Git oracle across preview/apply. */
  #scopeValidatedTreeOid: TreeOid | undefined;

  constructor(
    config: CyclotomyConfig,
    i18n: CyclotomyI18n,
    registrationFailure?: unknown,
  ) {
    this.i18n = i18n;
    this.#registrations = new SessionRegistrationService({
      globalConfig: config,
      registrationFailure,
      runExclusively: (action) => this.enqueue(action),
    });
    this.#workspaceMutations = new WorkspaceMutationAuthority({
      admission: this.#admission,
      registrations: this.#registrations,
      checkpoints: () => this.checkpoints,
      metadata: () => this.metadata,
      restoreDeps: () => ({
        store: this.store,
        scanOptions: this.#scanOptions(),
        validateManifestScope: (treeOid, manifest) =>
          this.#validateManifestScope(treeOid, manifest),
      }),
      enqueueWorkspaceExecution: (operation, action) =>
        this.enqueueWorkspaceExecution(operation, action),
    });
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

  /** Assert that this Pi observation still names the registered authority. */
  assertSessionUsable(view: SessionView): void {
    if (!this.#registrations.sessionIsUsable(view)) {
      throw new Error("current persisted session identity is unavailable");
    }
  }

  markSessionActive(): void {
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

  get checkpoints(): CheckpointService {
    if (this.#checkpointService === undefined) {
      this.#checkpointService = new CheckpointService({
        store: this.store,
        metadata: this.metadata,
        expectedRootPath: this.workspaceRoot,
        scanOptions: this.#scanOptions(),
        validateManifestScope: (treeOid, manifest) =>
          this.#validateManifestScope(treeOid, manifest),
      });
    }
    return this.#checkpointService;
  }

  async #validateManifestScope(
    treeOid: TreeOid,
    manifest: TreeManifest,
  ): Promise<void> {
    if (this.#scopeValidatedTreeOid === treeOid) return;
    const current = upgradeTreeManifestToCurrent(manifest, {
      maxPathBytes: this.config.scan.maxPathBytes,
      maxPathComponents: this.config.scan.maxPathComponents,
    });
    await validateTreeEntriesAgainstScope(current, {
      scratchParent: this.storeRoot,
      forbiddenRoots: [this.workspaceRoot],
    });
    this.#scopeValidatedTreeOid = treeOid;
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

  /**
   * Render advisory text behind a total boundary. Pi intentionally continues
   * after extension-handler exceptions, so presentation must never decide
   * whether a safety-critical handler reaches its veto or durable settlement.
   */
  notifyBestEffort(
    context: ExtensionContext,
    render: () => string,
    level: "info" | "warning" | "error" = "info",
    fallback: string = PRESENTATION_FAILURE_MESSAGE,
  ): void {
    let message = fallback;
    try {
      message = render();
    } catch {
      // The bounded fallback remains visible even when localization fails.
    }
    this.notify(context, message, level);
  }

  setStatusBestEffort(context: ExtensionContext, render: () => string): void {
    let message = PRESENTATION_STATUS_FALLBACK;
    try {
      message = render();
    } catch {
      // Status is advisory; retain a generic non-empty safety status.
    }
    this.setStatus(context, message);
  }

  renderBestEffort(render: () => string, fallback: string): string {
    try {
      return render();
    } catch {
      return fallback;
    }
  }

  presentBestEffort(
    context: ExtensionContext,
    present: () => void,
    fallbackLevel: "warning" | "error" = "error",
  ): void {
    try {
      present();
    } catch {
      this.notify(context, PRESENTATION_FAILURE_MESSAGE, fallbackLevel);
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
    this.notifyBestEffort(
      context,
      () => {
        const detail =
          this.#initFailureDetail === undefined
            ? ""
            : ` ${this.i18n.t("captureFailureDetail", {
                message: this.#initFailureDetail,
              })}`;
        return `${this.i18n.t("initFailure")}${detail}`;
      },
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
      this.notifyBestEffort(
        context,
        () => {
          const detail =
            failureMessage === undefined
              ? ""
              : ` ${this.i18n.t("captureFailureDetail", {
                  message: failureMessage,
                })}`;
          return `${this.i18n.t("captureLaterFailed")}${detail}`;
        },
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
    action: () => Promise<T>,
  ): Promise<WorkspaceLockExecution<T>> {
    return this.enqueue(() =>
      runWithWorkspaceLock(this.storeRoot, operation, action, this.config.lock),
    );
  }

  async scanCurrentWorkspace(cwd: string): Promise<WorkspaceSnapshot> {
    const snapshot = await scanWorkspace(cwd, this.#scanOptions());
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
  ): Promise<WorkspaceSnapshot> {
    const snapshot = await scanWorkspaceForScope(
      cwd,
      targetScope,
      this.#scanOptions(),
    );
    if (snapshot.rootPath !== this.workspaceRoot) {
      throw new Error(
        "workspace root changed after the checkpoint store was selected",
      );
    }
    return snapshot;
  }

  async maybeRunAutomaticGc(): Promise<WorkspaceLockExecution<void>> {
    const intervalMs = this.config.autoGcIntervalMs;
    if (intervalMs <= 0) {
      return {
        kind: "completed",
        value: undefined,
        cleanup: { kind: "released" },
      };
    }
    const statePath = join(this.storeRoot, GC_STATE_FILE);
    if (Date.now() - (await lastAutomaticGcAt(statePath)) < intervalMs) {
      return {
        kind: "completed",
        value: undefined,
        cleanup: { kind: "released" },
      };
    }
    return this.enqueueWorkspaceExecution("auto-gc", async () => {
      const startedAt = Date.now();
      if (startedAt - (await lastAutomaticGcAt(statePath)) < intervalMs) {
        return;
      }
      await collectCyclotomyGarbage(this.store, this.metadata, {
        objectGraceMs: GC_OBJECT_GRACE_MS,
      });
      await writeLastAutomaticGcAt(statePath, startedAt);
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
    view: SessionView,
    node: NodeKey,
    prepared: CaptureSuccess,
    expectedSlot: CheckpointSlot,
  ): Result<CaptureSuccess, CaptureFailure> {
    const authority = this.#registrations.registeredAuthority;
    if (authority === undefined) {
      throw new Error("Pi session registration authority is unavailable");
    }
    return this.checkpoints.commitPrepared(view, node, prepared, expectedSlot, {
      expectedSessionFile: authority.sessionFile,
      assertWorkspaceAuthority: () => {
        this.#registrations.assertActiveWorkspaceAuthority(authority);
        return undefined;
      },
    });
  }

  commitMissingCapture(
    view: SessionView,
    node: NodeKey,
    prepared: CaptureSuccess,
    intent: MissingNodeStateIntent,
  ): Result<CaptureSuccess, CaptureFailure> {
    const authority = this.#registrations.registeredAuthority;
    if (authority === undefined) {
      throw new Error("Pi session registration authority is unavailable");
    }
    return this.checkpoints.commitMissing(view, node, prepared, intent, {
      expectedSessionFile: authority.sessionFile,
      assertWorkspaceAuthority: () => {
        this.#registrations.assertActiveWorkspaceAuthority(authority);
        return undefined;
      },
    });
  }

  commitTreeArrivalCapture(
    arrival: ArrivalAttempt<PendingNavigation | undefined>,
    view: SessionView,
    node: NodeKey,
    prepared: CaptureSuccess,
    expectedSlot: CheckpointSlot,
  ): Result<CaptureSuccess, CaptureFailure> {
    if (!this.#workspaceMutations.treeArrivalCanProceed(arrival, view, node)) {
      throw new Error("tree arrival authority changed before capture commit");
    }
    const authority = this.#registrations.registeredAuthority;
    if (authority === undefined) {
      throw new Error("Pi session registration authority is unavailable");
    }
    return this.checkpoints.commitPreparedTreeArrival(
      view,
      node,
      prepared,
      expectedSlot,
      {
        expectedSessionFile: authority.sessionFile,
        assertWorkspaceAuthority: () => {
          this.#registrations.assertActiveWorkspaceAuthority(authority);
          return undefined;
        },
      },
    );
  }

  close(): void {
    this.#activation = { kind: "closed" };
    this.#registrations.close();
    this.#checkpointService = undefined;
    this.#admission.reset();
    this.#initFailureNotified = false;
    this.#captureFailureNotified = false;
    this.#scopeValidatedTreeOid = undefined;
  }
}
