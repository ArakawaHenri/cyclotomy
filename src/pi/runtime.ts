import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  commitPreparedNodeState,
  prepareNodeState,
  type CaptureDeps,
} from "../application/capture.ts";
import {
  CyclotomyConfigError,
  loadWorkspaceCyclotomyConfig,
  type CyclotomyConfig,
} from "../config.ts";
import { collectCyclotomyGarbage } from "../application/gc.ts";
import {
  ResolutionTraversalError,
  resolveReadableNodeState,
  type ResolvedNodeState,
  walkNodeAncestry,
} from "../application/resolve.ts";
import type { RestoreDeps } from "../application/restore.ts";
import type { NodeKey, TreeOid } from "../domain/model.ts";
import { MetadataStore } from "../infrastructure/metadata.ts";
import {
  openObjectStore,
  type ObjectStore,
} from "../infrastructure/object-store.ts";
import type { TreeManifest } from "../infrastructure/tree-manifest.ts";
import { validateTreeEntriesAgainstScope } from "../infrastructure/tree-scope-validation.ts";
import { withWorkspaceLock } from "../infrastructure/workspace-lock.ts";
import {
  scanWorkspace,
  scanWorkspaceForScope,
  type ScanOptions,
  type WorkspaceSnapshot,
} from "../infrastructure/workspace-scan.ts";
import type { WorkspaceScope } from "../infrastructure/workspace-scope.ts";
import { CyclotomyI18n } from "./i18n.ts";
import { formatUiDetail, formatUiPath } from "./restore-presentation.ts";
import type { SessionView } from "./session-view.ts";
import {
  TransitionState,
  type PendingSourceCapture,
} from "./transition-state.ts";

export interface ResolvedReadableTree {
  readonly resolution: ResolvedNodeState;
  readonly manifest: TreeManifest;
}

const GC_STATE_FILE = "gc-state.json";
const GC_OBJECT_GRACE_MS = 3_600_000;

async function readLastAutomaticGcAt(path: string): Promise<number> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      lastGcAt?: unknown;
    };
    return typeof parsed.lastGcAt === "number" &&
      Number.isFinite(parsed.lastGcAt) &&
      parsed.lastGcAt >= 0
      ? parsed.lastGcAt
      : 0;
  } catch {
    return 0;
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

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function initializationDetail(error: unknown): string {
  return error instanceof CyclotomyConfigError
    ? `${formatUiPath(error.settingsPath)}: ${formatUiDetail(error.detail)}`
    : formatUiDetail(messageOf(error));
}

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return (
    path === "" ||
    (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
  );
}

function assertPathsDoNotOverlap(workspace: string, candidate: string): void {
  if (isWithin(workspace, candidate) || isWithin(candidate, workspace)) {
    throw new Error(
      "Cyclotomy control data and workspace paths must not overlap",
    );
  }
}

async function prospectiveRealpath(path: string): Promise<string> {
  let current = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      return join(await realpath(current), ...missing);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      const parent = dirname(current);
      if (parent === current) throw cause;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

async function assertControlPathDoesNotOverlap(
  workspace: string,
  candidate: string,
): Promise<void> {
  const absolute = resolve(candidate);
  assertPathsDoNotOverlap(workspace, absolute);

  // Check every lexical ancestor after resolving aliases above that entry.
  // This catches a symlink directory entry inside the workspace even when its
  // target (and therefore the candidate's final realpath) is outside it.
  let current = absolute;
  const target = await prospectiveRealpath(absolute);
  while (true) {
    const observed =
      current === absolute ? target : await prospectiveRealpath(current);
    if (isWithin(workspace, observed)) {
      throw new Error(
        "Cyclotomy control data and workspace paths must not overlap",
      );
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  assertPathsDoNotOverlap(workspace, target);
}

/** Shared runtime boundary for lifecycle and the command surface. */
export class CyclotomyRuntime {
  readonly i18n: CyclotomyI18n;
  readonly transitions = new TransitionState();

  readonly #globalConfig: CyclotomyConfig;
  #config: CyclotomyConfig;
  #store: ObjectStore | undefined;
  #metadata: MetadataStore | undefined;
  #storeRoot: string | undefined;
  #workspaceRoot: string | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #initFailureNotified = false;
  #captureFailureNotified = false;
  #initFailureDetail: string | undefined;
  #notificationWorkspace: string | undefined;
  #configuredWorkspace: string | undefined;
  #workspaceConfig: CyclotomyConfig | undefined;
  #bindingFailed = false;
  #registeredSessionToken: string | undefined;
  /** One-entry cache avoids repeating the same Git oracle across preview/apply. */
  #scopeValidatedTreeOid: TreeOid | undefined;
  /** Configuration failure observed while Pi was loading the extension. */
  readonly #registrationFailure: unknown;

  constructor(
    config: CyclotomyConfig,
    i18n: CyclotomyI18n,
    registrationFailure?: unknown,
  ) {
    this.#globalConfig = config;
    this.#config = config;
    this.i18n = i18n;
    this.#registrationFailure = registrationFailure;
  }

  get config(): CyclotomyConfig {
    return this.#config;
  }

  get store(): ObjectStore {
    if (this.#store === undefined) throw new Error("store is not initialized");
    return this.#store;
  }

  get metadata(): MetadataStore {
    if (this.#metadata === undefined) {
      throw new Error("metadata is not initialized");
    }
    return this.#metadata;
  }

  get storeRoot(): string {
    if (this.#storeRoot === undefined) {
      throw new Error("store is not initialized");
    }
    return this.#storeRoot;
  }

  get workspaceRoot(): string {
    if (this.#workspaceRoot === undefined) {
      throw new Error("store is not initialized");
    }
    return this.#workspaceRoot;
  }

  #scanOptions(): ScanOptions {
    return {
      ...this.config.scan,
      gitIgnoreScratchParent: this.storeRoot,
    };
  }

  checkpointDeps(): CaptureDeps {
    return {
      store: this.store,
      metadata: this.metadata,
      scanOptions: this.#scanOptions(),
      expectedRootPath: this.workspaceRoot,
    };
  }

  restoreDeps(): RestoreDeps {
    return {
      store: this.store,
      scanOptions: this.#scanOptions(),
      validateManifestScope: (treeOid, manifest) =>
        this.#validateManifestScope(treeOid, manifest),
    };
  }

  async #validateManifestScope(
    treeOid: TreeOid,
    manifest: TreeManifest,
  ): Promise<void> {
    if (this.#scopeValidatedTreeOid === treeOid) return;
    await validateTreeEntriesAgainstScope(manifest, {
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
    const detail =
      this.#initFailureDetail === undefined
        ? ""
        : ` ${this.i18n.t("captureFailureDetail", {
            message: this.#initFailureDetail,
          })}`;
    this.notify(context, `${this.i18n.t("initFailure")}${detail}`, "error");
  }

  notifyCaptureResult(
    context: ExtensionContext,
    captured: boolean,
    failureMessage?: string,
  ): void {
    if (!captured && !this.#captureFailureNotified) {
      this.#captureFailureNotified = true;
      const detail =
        failureMessage === undefined
          ? ""
          : ` ${this.i18n.t("captureFailureDetail", {
              message: failureMessage,
            })}`;
      this.notify(
        context,
        `${this.i18n.t("captureLaterFailed")}${detail}`,
        "warning",
      );
    } else if (captured) {
      this.#captureFailureNotified = false;
      this.setStatus(context, undefined);
    }
  }

  #selectNotificationWorkspace(workspace: string): void {
    if (this.#notificationWorkspace === workspace) return;
    this.#notificationWorkspace = workspace;
    this.#initFailureNotified = false;
    this.#captureFailureNotified = false;
  }

  async ensureStore(cwd: string): Promise<boolean> {
    let notificationWorkspace = resolve(cwd);
    if (this.#registrationFailure !== undefined) {
      // Pi already loaded the extension with an unusable configuration. Fail
      // closed through the same channel a workspace settings failure uses,
      // without touching the filesystem for a store that must not be opened.
      this.#selectNotificationWorkspace(notificationWorkspace);
      this.#initFailureDetail = initializationDetail(this.#registrationFailure);
      return false;
    }
    try {
      const canonical = await realpath(cwd);
      notificationWorkspace = canonical;
      this.#selectNotificationWorkspace(canonical);
      const storeBound =
        this.#store !== undefined ||
        this.#metadata !== undefined ||
        this.#storeRoot !== undefined ||
        this.#workspaceRoot !== undefined;
      if (storeBound) {
        // One extension runtime belongs to one canonical workspace. Pi
        // closes it before session changes; rebinding an open runtime would let
        // an in-flight plan write through the wrong store.
        return (
          this.#store !== undefined &&
          this.#metadata !== undefined &&
          this.#storeRoot !== undefined &&
          this.#workspaceRoot === canonical
        );
      }
      if (this.#configuredWorkspace === canonical && this.#bindingFailed) {
        return false;
      }
      if (this.#configuredWorkspace !== canonical) {
        this.#configuredWorkspace = canonical;
        this.#workspaceConfig = undefined;
        this.#bindingFailed = false;
        this.#config = this.#globalConfig;
        this.#initFailureDetail = undefined;
      }
      const hash = createHash("sha256").update(canonical).digest("hex");
      await assertControlPathDoesNotOverlap(
        canonical,
        this.#globalConfig.globalSettingsPath,
      );
      const requestedRoot = resolve(this.#globalConfig.storageRootPath, hash);
      await assertControlPathDoesNotOverlap(canonical, requestedRoot);
      await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
      const rootEntry = await lstat(requestedRoot);
      if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
        throw new Error(
          "Cyclotomy workspace store must be a real directory, not a symlink or another file type",
        );
      }
      const root = await realpath(requestedRoot);
      assertPathsDoNotOverlap(canonical, root);
      assertPathsDoNotOverlap(
        canonical,
        await prospectiveRealpath(join(root, "settings.json")),
      );
      const config =
        this.#workspaceConfig ??
        loadWorkspaceCyclotomyConfig(this.#globalConfig, root);
      this.#workspaceConfig = config;
      const store = await openObjectStore(root, {
        maxEntries: config.scan.maxEntries,
        maxManifestBytes: config.scan.maxManifestBytes,
      });
      // Open only a validated schema; MetadataStore performs explicit,
      // transactional migrations for supported older versions.
      const metadata = new MetadataStore(join(root, "state.db"));
      this.#config = config;
      this.#storeRoot = root;
      this.#workspaceRoot = canonical;
      this.#store = store;
      this.#metadata = metadata;
      this.#initFailureNotified = false;
      this.#initFailureDetail = undefined;
      this.#captureFailureNotified = false;
      return true;
    } catch (error) {
      this.#selectNotificationWorkspace(notificationWorkspace);
      this.#initFailureDetail = initializationDetail(error);
      this.#bindingFailed = true;
      this.#config = this.#globalConfig;
      this.#store = undefined;
      this.#metadata = undefined;
      this.#storeRoot = undefined;
      this.#workspaceRoot = undefined;
      return false;
    }
  }

  /** Read-only binding check for committed after-events; never switches store. */
  async workspaceStillBound(cwd: string): Promise<boolean> {
    if (
      this.#store === undefined ||
      this.#metadata === undefined ||
      this.#workspaceRoot === undefined
    ) {
      return false;
    }
    try {
      return (await realpath(cwd)) === this.#workspaceRoot;
    } catch {
      return false;
    }
  }

  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.catch(() => {});
    return result;
  }

  enqueueWorkspace<T>(operation: string, action: () => Promise<T>): Promise<T> {
    return this.enqueue(() =>
      withWorkspaceLock(this.storeRoot, operation, action, this.config.lock),
    );
  }

  /** Scan only the canonical workspace for which the active store was opened. */
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

  async maybeRunAutomaticGc(): Promise<void> {
    const intervalMs = this.config.autoGcIntervalMs;
    if (intervalMs <= 0) return;
    const statePath = join(this.storeRoot, GC_STATE_FILE);
    if (Date.now() - (await readLastAutomaticGcAt(statePath)) < intervalMs) {
      return;
    }
    await this.enqueueWorkspace("auto-gc", async () => {
      const startedAt = Date.now();
      if (startedAt - (await readLastAutomaticGcAt(statePath)) < intervalMs) {
        return;
      }
      await collectCyclotomyGarbage(this.storeRoot, this.store, this.metadata, {
        objectGraceMs: GC_OBJECT_GRACE_MS,
        retentionMs: this.config.sessionMetadataRetentionMs,
      });
      await writeLastAutomaticGcAt(statePath, startedAt);
    });
  }

  currentNode(view: SessionView): NodeKey | undefined {
    return view.leafId === null
      ? undefined
      : { sessionId: view.sessionId, entryId: view.leafId };
  }

  /**
   * Pi rewrites label-entry ids when forking. Labels carry no conversation or
   * workspace state, so captures anchor at their nearest stable parent.
   */
  captureAnchor(
    view: SessionView,
    leafId: string | null = view.leafId,
  ): NodeKey | undefined {
    if (leafId === null) return undefined;
    for (const current of walkNodeAncestry(
      { sessionId: view.sessionId, entryId: leafId },
      this.parentOfIn(view),
    )) {
      const type = view.entryTypeOf(current.entryId);
      if (type === undefined) {
        throw new ResolutionTraversalError("unknown-node", current.entryId);
      }
      if (type !== "label") {
        return current;
      }
    }
    throw new Error("active label has no stable parent capture node");
  }

  beginSessionRegistration(): void {
    this.#registeredSessionToken = undefined;
  }

  completeSessionRegistration(view: SessionView): void {
    this.#registeredSessionToken = this.#sessionToken(view);
  }

  sessionIsUsable(view: SessionView): boolean {
    return (
      view.sessionFile !== null &&
      this.#registeredSessionToken === this.#sessionToken(view)
    );
  }

  #sessionToken(view: SessionView): string {
    return `${view.sessionId}\0${view.sessionFile ?? ""}`;
  }

  parentOfIn(view: SessionView) {
    return (node: NodeKey): NodeKey | undefined => {
      if (node.sessionId !== view.sessionId) {
        throw new ResolutionTraversalError("unknown-node", node.entryId);
      }
      if (view.entryOf(node.entryId) === undefined) {
        throw new ResolutionTraversalError("unknown-node", node.entryId);
      }
      const parentId = view.parentIdOf(node.entryId);
      if (parentId === undefined) {
        throw new ResolutionTraversalError("unknown-node", node.entryId);
      }
      if (typeof parentId !== "string") return undefined;
      if (view.entryOf(parentId) === undefined) {
        throw new ResolutionTraversalError("unknown-node", parentId);
      }
      return { sessionId: view.sessionId, entryId: parentId };
    };
  }

  ancestryIds(view: SessionView, leafId: string | null): string[] {
    if (leafId === null) return [];
    return [
      ...walkNodeAncestry(
        { sessionId: view.sessionId, entryId: leafId },
        this.parentOfIn(view),
      ),
    ]
      .map(({ entryId }) => entryId)
      .reverse();
  }

  async resolveReadableTreeIn(
    view: SessionView,
    node: NodeKey,
  ): Promise<ResolvedReadableTree | undefined> {
    let manifest: TreeManifest | undefined;
    const resolution = await resolveReadableNodeState(
      node,
      this.parentOfIn(view),
      (candidate) =>
        this.metadata.getState(candidate.sessionId, candidate.entryId),
      async (state) => {
        // Return the authenticated manifest from the same closure read that
        // selected the authoritative slot. Callers can plan from these bytes
        // without reading the whole tree a second time in the same phase.
        const candidate = await this.store.readTree(state.treeOid);
        await this.#validateManifestScope(state.treeOid, candidate);
        manifest = candidate;
      },
    );
    if (resolution === undefined) return undefined;
    if (manifest === undefined) {
      throw new Error(
        "readable tree resolution did not authenticate a manifest",
      );
    }
    return { resolution, manifest };
  }

  #resolveMetadataIn(
    view: SessionView,
    node: NodeKey,
  ): ResolvedNodeState | undefined {
    for (const current of walkNodeAncestry(node, this.parentOfIn(view))) {
      const state = this.metadata.getState(current.sessionId, current.entryId);
      if (state !== undefined) {
        return { treeOid: state.treeOid, foundAt: current };
      }
    }
    return undefined;
  }

  resolutionStillAuthoritative(
    view: SessionView,
    node: NodeKey,
    expected: ResolvedNodeState | undefined,
  ): boolean {
    // The caller already authenticated the expected closure in its prior
    // phase. This check binds only the nearest metadata slot; the next genuine
    // trust boundary performs its own full closure read.
    const current = this.#resolveMetadataIn(view, node);
    if (current === undefined || expected === undefined) {
      return current === expected;
    }
    return (
      current.treeOid === expected.treeOid &&
      current.foundAt.sessionId === expected.foundAt.sessionId &&
      current.foundAt.entryId === expected.foundAt.entryId
    );
  }

  prepareCaptureResult(view: SessionView): ReturnType<typeof prepareNodeState> {
    return prepareNodeState(this.checkpointDeps(), view.cwd);
  }

  commitPreparedCapture(
    capture: PendingSourceCapture,
  ): ReturnType<typeof commitPreparedNodeState> {
    return commitPreparedNodeState(
      this.checkpointDeps(),
      capture.source,
      capture.prepared,
      { treeOid: capture.expectedTreeOid },
    );
  }

  /** Best-effort registry hygiene after an authoritative turn checkpoint. */
  touchCapturedSession(view: SessionView): void {
    if (view.sessionFile === null) return;
    try {
      this.metadata.touchSession(view.sessionId, view.sessionFile);
    } catch {
      // The node state is already durable; registry data is hygiene only.
    }
  }

  importForkAncestry(view: SessionView): void {
    if (view.parentSessionFile === null || view.leafId === null) return;
    this.metadata.copyForkAncestry({
      targetSessionId: view.sessionId,
      parentSessionFile: view.parentSessionFile,
      ancestryEntryIds: this.ancestryIds(view, view.leafId),
    });
  }

  close(): void {
    try {
      this.#metadata?.close();
    } catch {
      // Shutdown must not throw.
    }
    this.#metadata = undefined;
    this.#store = undefined;
    this.#storeRoot = undefined;
    this.#workspaceRoot = undefined;
    this.#config = this.#globalConfig;
    this.transitions.reset();
    this.#notificationWorkspace = undefined;
    this.#initFailureNotified = false;
    this.#captureFailureNotified = false;
    this.#registeredSessionToken = undefined;
    this.#scopeValidatedTreeOid = undefined;
  }
}
