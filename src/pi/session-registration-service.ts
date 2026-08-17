import { lstat, mkdir, realpath } from "node:fs/promises";
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
  prepareTreeOidUpgrades,
  TreeFormatUpgradeBlockedError,
} from "../application/tree-migration.ts";
import {
  loadWorkspaceCyclotomyConfig,
  type CyclotomyConfig,
} from "../config.ts";
import type { TreeOid } from "../domain/model.ts";
import { retainFailureCause } from "../infrastructure/failure-settlement.ts";
import { systemErrorCode } from "../infrastructure/system-error.ts";
import {
  inspectMetadataSessionIdentity,
  openAuthenticatedCurrentMetadataStore,
  openCurrentMetadataStore,
  type CurrentMetadataStore,
  type ForkCheckpointProjection,
} from "../infrastructure/metadata.ts";
import {
  openObjectStore,
  TreeImportAdmissionError,
  type NativeObjectStore,
} from "../infrastructure/object-store.ts";
import { TreeManifestError } from "../infrastructure/tree-formats/manifest-codec.ts";
import {
  createCurrentTreeManifest,
  type CurrentTreeManifest,
} from "../infrastructure/tree-formats/current.ts";
import {
  TreeScopeMismatchError,
  validateTreeEntriesAgainstScope,
} from "../infrastructure/tree-scope-validation.ts";
import {
  runWithOrderedWorkspaceLocks,
  runWithWorkspaceLock,
  type WorkspaceWriteAuthority,
} from "../infrastructure/workspace-lock.ts";
import { workspaceStorePath } from "../infrastructure/workspace-store.ts";
import {
  provenStableCoordinateIds,
  type StableCoordinate,
} from "./extension-boundary.ts";
import {
  PiSessionSourceRejectedError,
  readPiSessionPublicObservation,
} from "./session-file.ts";
import {
  persistedSessionIdentityOf,
  sameParentSessionClaim,
  samePersistedSessionIdentity,
  type ParentSessionClaim,
  type PersistedSessionIdentity,
  type SessionView,
} from "./session-view.ts";
import {
  assertDirectoryStillBound,
  assertSessionWorkspaceStillBound,
  bindDirectory,
  bindSessionWorkspace,
  directoryStillBound,
  sameDirectoryBinding,
  sessionWorkspaceStillBound,
  type DirectoryBinding,
  type WorkspaceBinding,
} from "./workspace-binding.ts";

interface ForkSourceLocation {
  readonly workspace: string;
  readonly requestedStoreRoot: string;
  readonly sourceSessionId: string;
  readonly stableCoordinates: readonly StableCoordinate[];
}

type ForkRejectionOf<Kind extends string> = {
  readonly kind: Kind;
  readonly cause: unknown;
};

/** A durable ancestry rejection. Unknown exceptions are never members. */
export type ForkRejection =
  | ForkRejectionOf<"invalid-parent-claim">
  | ForkRejectionOf<"parent-source-missing">
  | ForkRejectionOf<"parent-source-invalid">
  | ForkRejectionOf<"parent-claim-changed">
  | ForkRejectionOf<"parent-graph-rewritten">
  | ForkRejectionOf<"unsafe-source-topology">
  | ForkRejectionOf<"source-store-missing">
  | ForkRejectionOf<"source-registration-absent">
  | ForkRejectionOf<"source-registration-conflict">
  | ForkRejectionOf<"source-registration-unverified">
  | ForkRejectionOf<"source-metadata-recovery-required">
  | ForkRejectionOf<"source-metadata-unrecognized">
  | ForkRejectionOf<"source-projection-invalid">
  | ForkRejectionOf<"target-import-rejected">;

function rejection(
  kind: ForkRejection["kind"],
  message: string,
  cause?: unknown,
): ForkRejection {
  return {
    kind,
    cause: new Error(message, cause === undefined ? undefined : { cause }),
  };
}

function unverifiedSourceRegistration(): ForkRejection {
  return rejection(
    "source-registration-unverified",
    "Cyclotomy parent registration is not verified for inheritance",
  );
}

class ForkRejectedError extends Error {
  readonly rejection: ForkRejection;

  constructor(value: ForkRejection) {
    super(
      value.cause instanceof Error
        ? value.cause.message
        : "fork source was rejected",
      { cause: value.cause },
    );
    this.name = "ForkRejectedError";
    this.rejection = value;
  }
}

type RevalidatedForkSource =
  | { readonly kind: "accepted"; readonly source: ForkSourceLocation }
  | { readonly kind: "rejected"; readonly rejection: ForkRejection };

export type SessionRegistrationPreparation =
  | {
      readonly kind: "independent";
      readonly claim: ParentSessionClaim;
    }
  | {
      readonly kind: "rejected";
      readonly claim: ParentSessionClaim;
      readonly rejection: ForkRejection;
    }
  | {
      readonly kind: "indeterminate";
      readonly claim: ParentSessionClaim;
      readonly parentSessionFile: string;
      readonly cause: unknown;
    }
  | {
      readonly kind: "observed";
      readonly claim: ParentSessionClaim;
      readonly parentSessionFile: string;
      readonly sourceSessionId: string;
      readonly recordedCwd: string;
      readonly workspaceNamespace: string;
      readonly stableCoordinates: readonly StableCoordinate[];
    };

export type SessionRegistrationOrigin =
  | { readonly kind: "independent" }
  | { readonly kind: "fork"; readonly previousSessionFile?: string };

export type RegistrationPlan =
  | { readonly kind: "fresh" }
  | {
      readonly kind: "inherit";
      readonly projection: ForkCheckpointProjection;
    }
  | { readonly kind: "quarantine"; readonly rejection: ForkRejection };

export type SessionRegistrationDisposition =
  | { readonly kind: "existing" }
  | { readonly kind: "inherited" }
  | { readonly kind: "quarantined"; readonly rejection: ForkRejection }
  | { readonly kind: "fresh" };

export interface SessionRegistrationAdvisory {
  readonly kind: "source-lock-cleanup-failed";
  readonly cause: unknown;
}

/**
 * A thrown registration made no target-session commitment.  An inactive
 * outcome names a commitment that exists durably but was not granted runtime
 * authority; callers may retry either case without reconstructing write state.
 */
export type SessionRegistrationOutcome =
  | {
      readonly kind: "active";
      readonly disposition: SessionRegistrationDisposition;
      readonly advisory?: SessionRegistrationAdvisory;
    }
  | {
      readonly kind: "durable-but-inactive";
      readonly disposition: SessionRegistrationDisposition;
      readonly cause: unknown;
    };

interface WorkspaceRuntimeContext {
  readonly config: CyclotomyConfig;
  readonly storePath: string;
  readonly storeRoot: string;
  readonly storeBinding: DirectoryBinding;
  readonly workspaceRoot: string;
  readonly store: NativeObjectStore;
  readonly metadata: CurrentMetadataStore;
}

type StoreBindingResult =
  | { readonly kind: "ready" }
  | { readonly kind: "failed"; readonly cause: unknown };

interface SessionRegistrationServiceOptions {
  readonly globalConfig: CyclotomyConfig;
  readonly registrationFailure?: unknown;
  readonly runExclusively: <T>(action: () => Promise<T>) => Promise<T>;
}

interface RegistrationTarget {
  readonly view: SessionView;
  readonly workspaceBinding: WorkspaceBinding;
  readonly targetSessionFile: string;
}

interface ExternalImportRequest extends RegistrationTarget {
  readonly prepared: Extract<
    SessionRegistrationPreparation,
    { readonly kind: "observed" }
  >;
  readonly initialSource: ForkSourceLocation;
}

type CommittedRegistration = {
  readonly kind: "committed";
  readonly disposition: SessionRegistrationDisposition;
  readonly advisory?: SessionRegistrationAdvisory;
};

type RegistrationExecution =
  | CommittedRegistration
  | {
      readonly kind: "durable-but-inactive";
      readonly disposition: SessionRegistrationDisposition;
      readonly cause: unknown;
    };

function preparationMatchesView(
  preparation: SessionRegistrationPreparation,
  view: SessionView,
): boolean {
  switch (preparation.kind) {
    case "independent":
    case "rejected":
      return sameParentSessionClaim(view.parentSession, preparation.claim);
    case "indeterminate":
    case "observed":
      return (
        sameParentSessionClaim(view.parentSession, preparation.claim) &&
        preparation.claim.kind === "candidate" &&
        preparation.claim.path === preparation.parentSessionFile
      );
  }
}

function unavailableParentRejection(message: string): ForkRejection {
  return rejection("parent-source-missing", message);
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
    throw new ForkRejectedError(
      rejection(
        "unsafe-source-topology",
        "Cyclotomy control data and workspace paths must not overlap",
      ),
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
      if (systemErrorCode(cause) !== "ENOENT") throw cause;
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
  let current = absolute;
  const target = await prospectiveRealpath(absolute);
  while (true) {
    const observed =
      current === absolute ? target : await prospectiveRealpath(current);
    if (isWithin(workspace, observed)) {
      throw new ForkRejectedError(
        rejection(
          "unsafe-source-topology",
          "Cyclotomy control data and workspace paths must not overlap",
        ),
      );
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  assertPathsDoNotOverlap(workspace, target);
}

async function existingStoreBinding(
  path: string,
): Promise<DirectoryBinding | undefined> {
  let entry: Awaited<ReturnType<typeof lstat>>;
  try {
    entry = await lstat(path);
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new ForkRejectedError(
      rejection(
        "unsafe-source-topology",
        "Cyclotomy source store is not a real directory",
      ),
    );
  }
  const binding = await bindDirectory(path, "Cyclotomy source store");
  let database: Awaited<ReturnType<typeof lstat>>;
  try {
    database = await lstat(join(binding.canonicalPath, "state.db"));
  } catch (error) {
    if (
      systemErrorCode(error) === "ENOENT" &&
      (await directoryStillBound(binding, path))
    ) {
      return undefined;
    }
    throw error;
  }
  if (database.isSymbolicLink() || !database.isFile()) {
    throw new ForkRejectedError(
      rejection(
        "unsafe-source-topology",
        "Cyclotomy source metadata is not a regular file",
      ),
    );
  }
  if (!(await directoryStillBound(binding, path))) {
    throw new Error("Cyclotomy source store changed while it was inspected");
  }
  return binding;
}

function sameForkSource(
  left: ForkSourceLocation,
  right: ForkSourceLocation,
): boolean {
  return (
    left.workspace === right.workspace &&
    left.requestedStoreRoot === right.requestedStoreRoot &&
    left.sourceSessionId === right.sourceSessionId &&
    stableCoordinatesExtend(left.stableCoordinates, right.stableCoordinates)
  );
}

/** Pi may append while registration waits, but may not rewrite observed facts. */
function stableCoordinatesExtend(
  prefix: readonly StableCoordinate[],
  current: readonly StableCoordinate[],
): boolean {
  return (
    current.length >= prefix.length &&
    prefix.every((coordinate, index) => {
      const observed = current[index];
      return (
        observed !== undefined &&
        coordinate.id === observed.id &&
        coordinate.stableParentId === observed.stableParentId &&
        coordinate.type === observed.type &&
        coordinate.messageRole === observed.messageRole
      );
    })
  );
}

function projectionContainsOnly(
  projection: ForkCheckpointProjection,
  entryIds: readonly string[],
): boolean {
  const expected = new Set(entryIds);
  return (
    expected.size === entryIds.length &&
    projection.coordinates.length === expected.size &&
    projection.coordinates.every(({ entryId }) => expected.delete(entryId)) &&
    expected.size === 0
  );
}

async function assertTargetControlsOutsideSource(
  config: CyclotomyConfig,
  targetStoreRoot: string,
  sourceWorkspace: string,
): Promise<void> {
  await assertControlPathDoesNotOverlap(
    sourceWorkspace,
    config.globalSettingsPath,
  );
  await assertControlPathDoesNotOverlap(sourceWorkspace, targetStoreRoot);
}

async function revalidateFallbackSourceTopology(
  config: CyclotomyConfig,
  targetStoreRoot: string,
  preparation: Extract<
    SessionRegistrationPreparation,
    { readonly kind: "observed" }
  >,
  currentCwd: string,
): Promise<void> {
  await assertTargetControlsOutsideSource(
    config,
    targetStoreRoot,
    preparation.workspaceNamespace,
  );
  let currentNamespace: string;
  try {
    currentNamespace = await prospectiveRealpath(currentCwd);
  } catch {
    return;
  }
  if (currentNamespace !== preparation.workspaceNamespace) {
    await assertTargetControlsOutsideSource(
      config,
      targetStoreRoot,
      currentNamespace,
    );
  }
}

async function revalidatePreparedForkSource(
  config: CyclotomyConfig,
  targetStoreRoot: string,
  preparation: Extract<
    SessionRegistrationPreparation,
    { readonly kind: "observed" }
  >,
): Promise<RevalidatedForkSource> {
  let observed: Awaited<ReturnType<typeof readPiSessionPublicObservation>>;
  try {
    observed = await readPiSessionPublicObservation(
      preparation.parentSessionFile,
    );
  } catch (error) {
    if (!(error instanceof PiSessionSourceRejectedError)) throw error;
    return {
      kind: "rejected",
      rejection: rejection("parent-source-invalid", error.message, error),
    };
  }
  if (observed.kind === "source-missing") {
    await revalidateFallbackSourceTopology(
      config,
      targetStoreRoot,
      preparation,
      preparation.recordedCwd,
    );
    return {
      kind: "rejected",
      rejection: unavailableParentRejection(
        "Pi parent session is no longer available",
      ),
    };
  }
  const header = observed;
  let sourceWorkspace: string;
  try {
    sourceWorkspace = await realpath(header.cwd);
  } catch (cause) {
    if (systemErrorCode(cause) !== "ENOENT") throw cause;
    await revalidateFallbackSourceTopology(
      config,
      targetStoreRoot,
      preparation,
      header.cwd,
    );
    return {
      kind: "rejected",
      rejection: unavailableParentRejection(
        "Pi parent workspace is no longer available",
      ),
    };
  }
  await assertTargetControlsOutsideSource(
    config,
    targetStoreRoot,
    sourceWorkspace,
  );
  if (
    header.sessionId !== preparation.sourceSessionId ||
    header.cwd !== preparation.recordedCwd ||
    sourceWorkspace !== preparation.workspaceNamespace
  ) {
    return {
      kind: "rejected",
      rejection: rejection(
        "parent-claim-changed",
        "Pi parent session identity or workspace changed during fork import",
      ),
    };
  }
  if (
    !stableCoordinatesExtend(
      preparation.stableCoordinates,
      header.stableCoordinates,
    )
  ) {
    return {
      kind: "rejected",
      rejection: rejection(
        "parent-graph-rewritten",
        "Pi parent session graph changed during fork import",
      ),
    };
  }
  return {
    kind: "accepted",
    source: {
      workspace: sourceWorkspace,
      requestedStoreRoot: workspaceStorePath(
        config.storageRootPath,
        sourceWorkspace,
      ),
      sourceSessionId: header.sessionId,
      stableCoordinates: header.stableCoordinates,
    },
  };
}

async function assertSourceStoreIsIsolated(
  source: ForkSourceLocation,
  targetWorkspace: string,
  existingBinding?: DirectoryBinding,
): Promise<void> {
  for (const workspace of [source.workspace, targetWorkspace]) {
    await assertControlPathDoesNotOverlap(workspace, source.requestedStoreRoot);
    await assertControlPathDoesNotOverlap(
      workspace,
      join(source.requestedStoreRoot, "settings.json"),
    );
    if (existingBinding !== undefined) {
      assertPathsDoNotOverlap(workspace, existingBinding.canonicalPath);
      assertPathsDoNotOverlap(
        workspace,
        await prospectiveRealpath(
          join(existingBinding.canonicalPath, "settings.json"),
        ),
      );
    }
  }
}

async function resolveIsolatedSourceStore(
  source: ForkSourceLocation,
  targetWorkspace: string,
): Promise<DirectoryBinding | undefined> {
  const binding = await existingStoreBinding(source.requestedStoreRoot);
  await assertSourceStoreIsIsolated(source, targetWorkspace, binding);
  return binding;
}

function rejectedImport(cause: unknown): {
  readonly kind: "rejected";
  readonly cause: unknown;
} {
  return { kind: "rejected", cause };
}

/** Owns cold store binding and the complete Pi-session registration protocol. */
export class SessionRegistrationService {
  readonly #options: SessionRegistrationServiceOptions;
  #context: WorkspaceRuntimeContext | undefined;
  #configuredWorkspace: string | undefined;
  #workspaceConfig: CyclotomyConfig | undefined;
  #bindingFailure: unknown;
  #workspaceBinding: WorkspaceBinding | undefined;
  #registeredAuthority: PersistedSessionIdentity | undefined;
  #closed = false;

  constructor(options: SessionRegistrationServiceOptions) {
    this.#options = options;
  }

  get config(): CyclotomyConfig {
    return this.#context?.config ?? this.#options.globalConfig;
  }

  get context(): WorkspaceRuntimeContext {
    if (this.#context === undefined) {
      throw new Error("workspace runtime context is not initialized");
    }
    return this.#context;
  }

  get isReady(): boolean {
    return this.#context !== undefined;
  }

  get registeredAuthority(): PersistedSessionIdentity | undefined {
    return this.#registeredAuthority;
  }

  #assertOpen(operation: string): void {
    if (this.#closed) {
      throw new Error(`workspace runtime closed during ${operation}`);
    }
  }

  async prepare(
    view: SessionView,
    origin: SessionRegistrationOrigin,
  ): Promise<SessionRegistrationPreparation> {
    this.#assertOpen("session registration preparation");
    if (view.parentSession.kind === "invalid") {
      return {
        kind: "rejected",
        claim: view.parentSession,
        rejection: rejection("invalid-parent-claim", view.parentSession.reason),
      };
    }
    if (view.parentSession.kind === "absent") {
      return origin.kind === "independent"
        ? { kind: "independent", claim: view.parentSession }
        : {
            kind: "rejected",
            rejection: rejection(
              "invalid-parent-claim",
              "Pi fork lifecycle has no matching child parent claim",
            ),
            claim: view.parentSession,
          };
    }
    const parentSessionFile = view.parentSession.path;
    if (origin.kind === "fork") {
      const previous = origin.previousSessionFile;
      if (
        previous === undefined ||
        previous.length === 0 ||
        previous.includes("\0") ||
        !isAbsolute(previous) ||
        resolve(previous) !== previous ||
        previous === view.sessionFile
      ) {
        return {
          kind: "rejected",
          rejection: rejection(
            "invalid-parent-claim",
            "Pi fork source session path is not canonical and absolute",
          ),
          claim: view.parentSession,
        };
      }
      if (parentSessionFile !== previous) {
        return {
          kind: "rejected",
          rejection: rejection(
            "invalid-parent-claim",
            "Pi fork lifecycle and child header disagree on the parent",
          ),
          claim: view.parentSession,
        };
      }
    }
    try {
      const observed = await readPiSessionPublicObservation(parentSessionFile);
      if (observed.kind === "source-missing") {
        return {
          kind: "rejected",
          claim: view.parentSession,
          rejection: unavailableParentRejection(
            "Pi parent session file is not persisted",
          ),
        };
      }
      return {
        kind: "observed",
        claim: view.parentSession,
        parentSessionFile,
        sourceSessionId: observed.sessionId,
        recordedCwd: observed.cwd,
        workspaceNamespace: await prospectiveRealpath(observed.cwd),
        stableCoordinates: observed.stableCoordinates,
      };
    } catch (error) {
      if (error instanceof PiSessionSourceRejectedError) {
        return {
          kind: "rejected",
          claim: view.parentSession,
          rejection: rejection("parent-source-invalid", error.message, error),
        };
      }
      return {
        kind: "indeterminate",
        claim: view.parentSession,
        parentSessionFile,
        cause: error,
      };
    }
  }

  async ensureStore(
    cwd: string,
    preparation: SessionRegistrationPreparation,
  ): Promise<StoreBindingResult> {
    if (this.#closed) {
      return {
        kind: "failed",
        cause: new Error("workspace runtime is closed"),
      };
    }
    if (this.#options.registrationFailure !== undefined) {
      return {
        kind: "failed",
        cause: this.#options.registrationFailure,
      };
    }
    try {
      await this.#options.runExclusively(() =>
        this.#ensureStoreExclusive(cwd, preparation),
      );
      this.#assertOpen("initialization");
      return { kind: "ready" };
    } catch (cause) {
      if (!this.#closed) this.#bindingFailure = cause;
      return { kind: "failed", cause };
    }
  }

  async #ensureStoreExclusive(
    cwd: string,
    preparation: SessionRegistrationPreparation,
  ): Promise<void> {
    this.#assertOpen("initialization");
    const canonical = await realpath(cwd);
    this.#assertOpen("initialization");
    if (this.#context !== undefined) {
      if (this.#context.workspaceRoot !== canonical) {
        throw new Error("runtime is already bound to another workspace");
      }
      if (
        !(await directoryStillBound(
          this.#context.storeBinding,
          this.#context.storePath,
        ))
      ) {
        throw new Error(
          "Cyclotomy workspace store changed after initialization",
        );
      }
      if (preparation.kind === "observed") {
        await assertControlPathDoesNotOverlap(
          preparation.workspaceNamespace,
          this.#options.globalConfig.globalSettingsPath,
        );
        await assertControlPathDoesNotOverlap(
          preparation.workspaceNamespace,
          this.#context.storeRoot,
        );
        await assertControlPathDoesNotOverlap(
          preparation.workspaceNamespace,
          join(this.#context.storeRoot, "settings.json"),
        );
      }
      this.#assertOpen("initialization");
      return;
    }
    if (
      this.#configuredWorkspace === canonical &&
      this.#bindingFailure !== undefined
    ) {
      throw this.#bindingFailure;
    }
    if (this.#configuredWorkspace !== canonical) {
      this.#configuredWorkspace = canonical;
      this.#workspaceConfig = undefined;
      this.#bindingFailure = undefined;
    }
    const protectedWorkspaces = [canonical];
    if (
      preparation.kind === "observed" &&
      preparation.workspaceNamespace !== canonical
    ) {
      protectedWorkspaces.push(preparation.workspaceNamespace);
    }
    for (const workspace of protectedWorkspaces) {
      await assertControlPathDoesNotOverlap(
        workspace,
        this.#options.globalConfig.globalSettingsPath,
      );
    }
    const requestedRoot = workspaceStorePath(
      this.#options.globalConfig.storageRootPath,
      canonical,
    );
    for (const workspace of protectedWorkspaces) {
      await assertControlPathDoesNotOverlap(workspace, requestedRoot);
    }
    await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
    const rootEntry = await lstat(requestedRoot);
    if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
      throw new Error(
        "Cyclotomy workspace store must be a real directory, not a symlink or another file type",
      );
    }
    const root = await realpath(requestedRoot);
    const storeBinding = await bindDirectory(
      requestedRoot,
      "Cyclotomy workspace store",
    );
    if (storeBinding.canonicalPath !== root) {
      throw new Error(
        "Cyclotomy workspace store changed during initialization",
      );
    }
    const settingsPath = await prospectiveRealpath(join(root, "settings.json"));
    for (const workspace of protectedWorkspaces) {
      assertPathsDoNotOverlap(workspace, root);
      assertPathsDoNotOverlap(workspace, settingsPath);
    }
    const config =
      this.#workspaceConfig ??
      loadWorkspaceCyclotomyConfig(this.#options.globalConfig, root);
    this.#workspaceConfig = config;
    const store = await openObjectStore(root, {
      maxFileBytes: config.scan.maxFileBytes,
      maxEntries: config.scan.maxEntries,
      maxManifestBytes: config.scan.maxManifestBytes,
      maxPathBytes: config.scan.maxPathBytes,
      maxPathComponents: config.scan.maxPathComponents,
    });
    const migration = await runWithWorkspaceLock(
      root,
      "tree-format-migrate",
      (writeAuthority) =>
        openCurrentMetadataStore(
          join(root, "state.db"),
          {
            prepareTreeOidUpgrades: (roots, targetFormat) =>
              prepareTreeOidUpgrades(store, roots, targetFormat),
          },
          writeAuthority,
        ),
      config.lock,
    );
    if (migration.kind === "action-failed") {
      if (migration.cleanup.kind === "settled") throw migration.cause;
      throw retainFailureCause(
        migration.cause,
        migration.cleanup.cause,
        "metadata migration and workspace-lock cleanup both failed",
      );
    }
    const metadata = migration.value;
    if (migration.cleanup.kind === "failed") {
      try {
        metadata.close();
      } catch (closeFailure) {
        throw new AggregateError(
          [migration.cleanup.cause, closeFailure],
          "workspace-lock cleanup and metadata connection cleanup both failed",
          { cause: migration.cleanup.cause },
        );
      }
      throw migration.cleanup.cause;
    }
    if (!(await directoryStillBound(storeBinding, requestedRoot))) {
      metadata.close();
      throw new Error(
        "Cyclotomy workspace store changed during initialization",
      );
    }
    if (this.#closed) {
      metadata.close();
      throw new Error("workspace runtime closed during initialization");
    }
    this.#context = Object.freeze({
      config,
      storePath: requestedRoot,
      storeRoot: root,
      storeBinding,
      workspaceRoot: canonical,
      store,
      metadata,
    });
  }

  async sessionOwnsCurrentWorkspace(view: SessionView): Promise<boolean> {
    if (
      view.sessionCwd === null ||
      view.sessionCwd.includes("\0") ||
      !isAbsolute(view.sessionCwd)
    ) {
      return false;
    }
    try {
      const [effective, persisted] = await Promise.all([
        realpath(view.cwd),
        realpath(view.sessionCwd),
      ]);
      return effective === persisted;
    } catch {
      return false;
    }
  }

  async workspaceStillBound(cwd: string): Promise<boolean> {
    const context = this.#context;
    const binding = this.#workspaceBinding;
    const authority = this.#registeredAuthority;
    return (
      context !== undefined &&
      binding !== undefined &&
      authority !== undefined &&
      cwd === authority.cwd &&
      (await directoryStillBound(context.storeBinding, context.storePath)) &&
      (await sessionWorkspaceStillBound(
        binding,
        authority.cwd,
        authority.sessionCwd,
      ))
    );
  }

  sessionIsUsable(view: SessionView): boolean {
    const current = persistedSessionIdentityOf(view);
    return (
      this.#registeredAuthority !== undefined &&
      current !== undefined &&
      samePersistedSessionIdentity(this.#registeredAuthority, current)
    );
  }

  assertActiveWorkspaceAuthority(
    expectedIdentity: PersistedSessionIdentity,
  ): void {
    const authority = this.#registeredAuthority;
    const binding = this.#workspaceBinding;
    const context = this.#context;
    if (
      authority === undefined ||
      binding === undefined ||
      context === undefined ||
      !samePersistedSessionIdentity(authority, expectedIdentity)
    ) {
      throw new Error("Pi workspace registration authority is unavailable");
    }
    assertDirectoryStillBound(
      context.storeBinding,
      context.storePath,
      "Cyclotomy workspace store",
    );
    this.#assertWorkspaceStillBound(binding, authority);
  }

  close(): void {
    this.#closed = true;
    try {
      this.#context?.metadata.close();
    } catch {
      // Shutdown must not throw.
    }
    this.#context = undefined;
    this.#configuredWorkspace = undefined;
    this.#workspaceConfig = undefined;
    this.#bindingFailure = undefined;
    this.#workspaceBinding = undefined;
    this.#registeredAuthority = undefined;
  }

  #revokeRegistrationAuthority(): void {
    this.#workspaceBinding = undefined;
    this.#registeredAuthority = undefined;
  }

  async register(
    view: SessionView,
    readCurrentView: () => SessionView,
    preparation: SessionRegistrationPreparation,
  ): Promise<SessionRegistrationOutcome> {
    return this.#options.runExclusively(async () => {
      this.#revokeRegistrationAuthority();
      this.#assertOpen("session registration");
      const targetSessionFile = view.sessionFile;
      if (targetSessionFile === null) {
        throw new Error("Pi session has no persisted file");
      }
      if (view.sessionCwd === null) {
        throw new Error("Pi session has no trusted persisted workspace");
      }
      const identity = persistedSessionIdentityOf(view);
      if (identity === undefined) {
        throw new Error("Pi session has no persisted registration identity");
      }
      const workspaceBinding = await bindSessionWorkspace(
        view.cwd,
        view.sessionCwd,
      );
      if (workspaceBinding.canonicalPath !== this.context.workspaceRoot) {
        throw new Error(
          "Pi session changed while Cyclotomy was registering it",
        );
      }
      if (!preparationMatchesView(preparation, view)) {
        throw new Error("Pi parent session changed before fork registration");
      }
      const execution = await this.#registerProjection(
        view,
        readCurrentView,
        preparation,
        workspaceBinding,
        targetSessionFile,
      );
      if (execution.kind === "durable-but-inactive") return execution;

      try {
        await this.#assertStillCurrent(view, readCurrentView, workspaceBinding);
        this.#assertOpen("session registration activation");
        this.#assertWorkspaceStillBound(workspaceBinding, view);
        assertDirectoryStillBound(
          this.context.storeBinding,
          this.context.storePath,
          "Cyclotomy workspace store",
        );
        this.#workspaceBinding = workspaceBinding;
        this.#registeredAuthority = identity;
        return {
          kind: "active",
          disposition: execution.disposition,
          ...(execution.advisory === undefined
            ? {}
            : { advisory: execution.advisory }),
        };
      } catch (cause) {
        return {
          kind: "durable-but-inactive",
          disposition: execution.disposition,
          cause,
        };
      }
    });
  }

  #assertSnapshotStillCurrent(
    expected: SessionView,
    readCurrentView: () => SessionView,
  ): void {
    let current: SessionView | undefined;
    try {
      current = readCurrentView();
    } catch {
      // A malformed replacement is never the snapshot being registered.
    }
    if (current === undefined || !expected.isSameSnapshotAs(current)) {
      throw new Error("Pi session changed while Cyclotomy was registering it");
    }
  }

  async #assertStillCurrent(
    view: SessionView,
    readCurrentView: () => SessionView,
    binding: WorkspaceBinding,
  ): Promise<void> {
    this.#assertSnapshotStillCurrent(view, readCurrentView);
    if (
      !(await sessionWorkspaceStillBound(binding, view.cwd, view.sessionCwd))
    ) {
      throw new Error("Pi session changed while Cyclotomy was registering it");
    }
    if (
      !(await directoryStillBound(
        this.context.storeBinding,
        this.context.storePath,
      ))
    ) {
      throw new Error(
        "Cyclotomy target store changed during session registration",
      );
    }
    this.#assertSnapshotStillCurrent(view, readCurrentView);
  }

  #assertWorkspaceStillBound(
    binding: WorkspaceBinding,
    identity: Pick<PersistedSessionIdentity, "cwd" | "sessionCwd">,
  ): void {
    assertSessionWorkspaceStillBound(
      binding,
      identity.cwd,
      identity.sessionCwd,
    );
  }

  async #validateImportedManifest(
    treeOid: TreeOid,
    manifest: CurrentTreeManifest,
  ): Promise<
    | { readonly kind: "accepted" }
    | { readonly kind: "rejected"; readonly cause: unknown }
  > {
    const { config, storeRoot, workspaceRoot } = this.context;
    const limits = {
      maxEntries: config.scan.maxEntries,
      maxManifestBytes: config.scan.maxManifestBytes,
      maxPathBytes: config.scan.maxPathBytes,
      maxPathComponents: config.scan.maxPathComponents,
    };
    let canonical: ReturnType<typeof createCurrentTreeManifest>;
    try {
      canonical = createCurrentTreeManifest(
        manifest.entries,
        manifest.scope,
        limits,
      );
    } catch (cause) {
      if (!(cause instanceof TreeManifestError)) throw cause;
      return rejectedImport(cause);
    }
    let inventoryEntries = 1 + canonical.entries.length;
    const implicitDirectories = new Set<string>();
    const inventoryRejection = (): TreeManifestError | undefined => {
      if (inventoryEntries > limits.maxEntries) {
        return new TreeManifestError(
          "invalid-tree-manifest",
          `imported tree ${treeOid} requires at least ${inventoryEntries} workspace inventory entries, exceeding the target limit of ${limits.maxEntries}`,
        );
      }
      return undefined;
    };
    let inventoryFailure = inventoryRejection();
    if (inventoryFailure !== undefined) return rejectedImport(inventoryFailure);
    for (const entry of canonical.entries) {
      let separator = entry.path.lastIndexOf("/");
      while (separator !== -1) {
        const directory = entry.path.slice(0, separator);
        if (!implicitDirectories.has(directory)) {
          implicitDirectories.add(directory);
          inventoryEntries += 1;
          inventoryFailure = inventoryRejection();
          if (inventoryFailure !== undefined)
            return rejectedImport(inventoryFailure);
        }
        separator = directory.lastIndexOf("/");
      }
    }
    try {
      await validateTreeEntriesAgainstScope(canonical, {
        scratchParent: storeRoot,
        forbiddenRoots: [workspaceRoot],
      });
    } catch (cause) {
      if (cause instanceof TreeScopeMismatchError) {
        return rejectedImport(cause);
      }
      throw cause;
    }
    return { kind: "accepted" };
  }

  async #targetStoreStillNamesCurrentContext(): Promise<boolean> {
    return directoryStillBound(
      this.context.storeBinding,
      this.context.storePath,
    );
  }

  #commitTarget(
    writeAuthority: WorkspaceWriteAuthority,
    input: RegistrationTarget,
    readCurrentView: () => SessionView,
    plan: RegistrationPlan,
    sourceAuthority?: {
      readonly authority: WorkspaceWriteAuthority;
      readonly storeRoot: string;
    },
  ): CommittedRegistration {
    const { view, workspaceBinding, targetSessionFile } = input;
    this.#assertSnapshotStillCurrent(view, readCurrentView);
    this.#assertWorkspaceStillBound(workspaceBinding, view);
    assertDirectoryStillBound(
      this.context.storeBinding,
      this.context.storePath,
      "Cyclotomy workspace store",
    );
    this.#assertOpen("session registration");
    const report = this.context.metadata.finalizeSessionProjection(
      writeAuthority,
      {
        targetSessionId: view.sessionId,
        targetSessionFile,
        retainedEntryIds: view.stableEntryIds,
        activeAncestryEntryIds: view.activeStableAncestryIds,
        seed:
          plan.kind === "inherit"
            ? { kind: "fork", projection: plan.projection }
            : plan.kind === "fresh"
              ? { kind: "fresh" }
              : { kind: "untrusted-parent" },
      },
      plan.kind === "inherit"
        ? (sourceAuthority ?? {
            authority: writeAuthority,
            storeRoot: this.context.storeRoot,
          })
        : sourceAuthority,
    );
    const disposition: SessionRegistrationDisposition =
      report.kind === "existing"
        ? { kind: "existing" }
        : plan.kind === "fresh"
          ? { kind: "fresh" }
          : plan.kind === "inherit"
            ? { kind: "inherited" }
            : { kind: "quarantined", rejection: plan.rejection };
    return { kind: "committed", disposition };
  }

  #finishExistingTarget(
    writeAuthority: WorkspaceWriteAuthority,
    input: RegistrationTarget,
    readCurrentView: () => SessionView,
  ): CommittedRegistration | undefined {
    const match = this.context.metadata.matchSessionIdentity(
      input.view.sessionId,
      input.targetSessionFile,
    );
    if (match === "absent") return undefined;
    if (match === "conflict") {
      throw new Error(
        "Pi session identity conflicts with registered Cyclotomy metadata",
      );
    }
    return this.#commitTarget(writeAuthority, input, readCurrentView, {
      kind: "fresh",
    });
  }

  async #registerTarget(
    writeAuthority: WorkspaceWriteAuthority,
    input: RegistrationTarget,
    readCurrentView: () => SessionView,
    plan: RegistrationPlan,
  ): Promise<CommittedRegistration> {
    await this.#assertStillCurrent(
      input.view,
      readCurrentView,
      input.workspaceBinding,
    );
    return this.#commitTarget(writeAuthority, input, readCurrentView, plan);
  }

  async #commitQuarantineWithTargetLock(
    input: ExternalImportRequest,
    readCurrentView: () => SessionView,
    value: ForkRejection,
  ): Promise<RegistrationExecution> {
    const { config, storeRoot } = this.context;
    const execution = await runWithWorkspaceLock(
      storeRoot,
      "session-register-quarantined-fork",
      async (writeAuthority) => {
        await this.#assertStillCurrent(
          input.view,
          readCurrentView,
          input.workspaceBinding,
        );
        return (
          this.#finishExistingTarget(writeAuthority, input, readCurrentView) ??
          (await this.#registerTarget(writeAuthority, input, readCurrentView, {
            kind: "quarantine",
            rejection: value,
          }))
        );
      },
      config.lock,
    );
    if (execution.kind === "action-failed") {
      if (execution.cleanup.kind === "settled") throw execution.cause;
      throw retainFailureCause(
        execution.cause,
        execution.cleanup.cause,
        "fork quarantine and target lock cleanup both failed",
      );
    }
    if (execution.cleanup.kind === "settled") return execution.value;
    return {
      kind: "durable-but-inactive",
      disposition: execution.value.disposition,
      cause: execution.cleanup.cause,
    };
  }

  async #registerProjection(
    view: SessionView,
    readCurrentView: () => SessionView,
    prepared: SessionRegistrationPreparation,
    workspaceBinding: WorkspaceBinding,
    targetSessionFile: string,
  ): Promise<RegistrationExecution> {
    this.#assertOpen("session registration");
    const { config, metadata, storeRoot, workspaceRoot } = this.context;
    const input = {
      view,
      workspaceBinding,
      targetSessionFile,
    };

    const initialExecution = await runWithWorkspaceLock(
      storeRoot,
      "session-register",
      async (
        writeAuthority,
      ): Promise<
        | {
            readonly kind: "complete";
            readonly outcome: CommittedRegistration;
          }
        | { readonly kind: "external"; readonly source: ForkSourceLocation }
      > => {
        await this.#assertStillCurrent(view, readCurrentView, workspaceBinding);
        const existing = this.#finishExistingTarget(
          writeAuthority,
          input,
          readCurrentView,
        );
        if (existing !== undefined) {
          return { kind: "complete", outcome: existing };
        }
        if (prepared.kind === "independent") {
          return {
            kind: "complete",
            outcome: await this.#registerTarget(
              writeAuthority,
              input,
              readCurrentView,
              {
                kind: "fresh",
              },
            ),
          };
        }
        if (prepared.kind === "rejected") {
          return {
            kind: "complete",
            outcome: await this.#registerTarget(
              writeAuthority,
              input,
              readCurrentView,
              {
                kind: "quarantine",
                rejection: prepared.rejection,
              },
            ),
          };
        }
        if (prepared.kind === "indeterminate") throw prepared.cause;

        if (prepared.workspaceNamespace === workspaceRoot) {
          const localIdentity = metadata.matchSessionIdentity(
            prepared.sourceSessionId,
            prepared.parentSessionFile,
          );
          if (localIdentity === "conflict") {
            return {
              kind: "complete",
              outcome: await this.#registerTarget(
                writeAuthority,
                input,
                readCurrentView,
                {
                  kind: "quarantine",
                  rejection: rejection(
                    "source-registration-conflict",
                    "Cyclotomy parent registration does not match Pi",
                  ),
                },
              ),
            };
          }
          if (localIdentity === "exact") {
            const localSource = metadata.exportForkProjection({
              parentSessionFile: prepared.parentSessionFile,
              retainedEntryIds: [],
            });
            if (localSource === undefined) {
              return {
                kind: "complete",
                outcome: await this.#registerTarget(
                  writeAuthority,
                  input,
                  readCurrentView,
                  {
                    kind: "quarantine",
                    rejection: unverifiedSourceRegistration(),
                  },
                ),
              };
            }
            await this.#assertStillCurrent(
              view,
              readCurrentView,
              workspaceBinding,
            );
            const current = await revalidatePreparedForkSource(
              this.#options.globalConfig,
              storeRoot,
              prepared,
            );
            this.#assertSnapshotStillCurrent(view, readCurrentView);
            if (current.kind === "rejected") {
              return {
                kind: "complete",
                outcome: await this.#registerTarget(
                  writeAuthority,
                  input,
                  readCurrentView,
                  {
                    kind: "quarantine",
                    rejection: current.rejection,
                  },
                ),
              };
            }
            if (
              current.source.workspace !== workspaceRoot ||
              current.source.sourceSessionId !== localSource.sourceSessionId
            ) {
              return {
                kind: "complete",
                outcome: await this.#registerTarget(
                  writeAuthority,
                  input,
                  readCurrentView,
                  {
                    kind: "quarantine",
                    rejection: rejection(
                      "parent-claim-changed",
                      "Pi parent session changed during fork registration",
                    ),
                  },
                ),
              };
            }
            const provenEntryIds = provenStableCoordinateIds(
              current.source.stableCoordinates,
              view.stableCoordinates,
            );
            const localProjection = metadata.exportForkProjection({
              parentSessionFile: prepared.parentSessionFile,
              retainedEntryIds: provenEntryIds,
            });
            if (localProjection === undefined) {
              return {
                kind: "complete",
                outcome: await this.#registerTarget(
                  writeAuthority,
                  input,
                  readCurrentView,
                  {
                    kind: "quarantine",
                    rejection: unverifiedSourceRegistration(),
                  },
                ),
              };
            }
            if (
              localProjection.sourceSessionId !== localSource.sourceSessionId ||
              !projectionContainsOnly(localProjection, provenEntryIds)
            ) {
              return {
                kind: "complete",
                outcome: await this.#registerTarget(
                  writeAuthority,
                  input,
                  readCurrentView,
                  {
                    kind: "quarantine",
                    rejection: rejection(
                      "source-projection-invalid",
                      "Cyclotomy parent registration changed during fork projection",
                    ),
                  },
                ),
              };
            }
            return {
              kind: "complete",
              outcome: this.#commitTarget(
                writeAuthority,
                input,
                readCurrentView,
                {
                  kind: "inherit",
                  projection: localProjection,
                },
              ),
            };
          }
        }

        const revalidated = await revalidatePreparedForkSource(
          this.#options.globalConfig,
          storeRoot,
          prepared,
        );
        if (revalidated.kind === "rejected") {
          return {
            kind: "complete",
            outcome: await this.#registerTarget(
              writeAuthority,
              input,
              readCurrentView,
              {
                kind: "quarantine",
                rejection: revalidated.rejection,
              },
            ),
          };
        }
        const source = revalidated.source;
        if (source.sourceSessionId === view.sessionId) {
          return {
            kind: "complete",
            outcome: await this.#registerTarget(
              writeAuthority,
              input,
              readCurrentView,
              {
                kind: "quarantine",
                rejection: rejection(
                  "source-registration-conflict",
                  "Pi fork source and target session ids must differ",
                ),
              },
            ),
          };
        }
        if (source.workspace === workspaceRoot) {
          return {
            kind: "complete",
            outcome: await this.#registerTarget(
              writeAuthority,
              input,
              readCurrentView,
              {
                kind: "quarantine",
                rejection: rejection(
                  "source-registration-absent",
                  "Cyclotomy parent registration is absent from its workspace",
                ),
              },
            ),
          };
        }
        try {
          await assertSourceStoreIsIsolated(source, workspaceRoot);
        } catch (error) {
          if (!(error instanceof ForkRejectedError)) throw error;
          return {
            kind: "complete",
            outcome: await this.#registerTarget(
              writeAuthority,
              input,
              readCurrentView,
              {
                kind: "quarantine",
                rejection: error.rejection,
              },
            ),
          };
        }
        return { kind: "external", source };
      },
      config.lock,
    );

    if (initialExecution.kind === "action-failed") {
      if (initialExecution.cleanup.kind === "settled") {
        throw initialExecution.cause;
      }
      throw retainFailureCause(
        initialExecution.cause,
        initialExecution.cleanup.cause,
        "session registration and target lock cleanup both failed",
      );
    }
    const initial = initialExecution.value;
    if (
      initialExecution.cleanup.kind === "failed" &&
      initial.kind === "complete"
    ) {
      return {
        kind: "durable-but-inactive",
        disposition: initial.outcome.disposition,
        cause: initialExecution.cleanup.cause,
      };
    }
    if (initialExecution.cleanup.kind === "failed") {
      throw initialExecution.cleanup.cause;
    }

    if (initial.kind === "complete") return initial.outcome;
    if (prepared.kind !== "observed") {
      throw new Error("external fork source has no authenticated locator");
    }
    return this.#importExternalProjection(
      {
        view,
        prepared,
        workspaceBinding,
        targetSessionFile,
        initialSource: initial.source,
      },
      readCurrentView,
    );
  }

  async #importExternalProjection(
    request: ExternalImportRequest,
    readCurrentView: () => SessionView,
  ): Promise<RegistrationExecution> {
    const { view, prepared, workspaceBinding, initialSource: source } = request;
    const { config, store, storeRoot, workspaceRoot } = this.context;
    const parentSessionFile = prepared.parentSessionFile;
    let sourceStoreBinding: DirectoryBinding | undefined;
    try {
      sourceStoreBinding = await resolveIsolatedSourceStore(
        source,
        workspaceRoot,
      );
    } catch (error) {
      if (!(error instanceof ForkRejectedError)) throw error;
      return this.#commitQuarantineWithTargetLock(
        request,
        readCurrentView,
        error.rejection,
      );
    }
    if (sourceStoreBinding === undefined) {
      return this.#commitQuarantineWithTargetLock(
        request,
        readCurrentView,
        rejection("source-store-missing", "Cyclotomy parent store is absent"),
      );
    }
    if (sameDirectoryBinding(sourceStoreBinding, this.context.storeBinding)) {
      return this.#commitQuarantineWithTargetLock(
        request,
        readCurrentView,
        rejection(
          "unsafe-source-topology",
          "distinct Pi workspaces resolved to the same Cyclotomy store",
        ),
      );
    }
    const authenticatedSourceStoreBinding = sourceStoreBinding;
    const authenticatedSourceStoreRoot = sourceStoreBinding.canonicalPath;
    const sourceConfig = loadWorkspaceCyclotomyConfig(
      this.#options.globalConfig,
      authenticatedSourceStoreRoot,
    );

    const execution = await runWithOrderedWorkspaceLocks(
      [
        { storeRoot, options: config.lock },
        {
          storeRoot: authenticatedSourceStoreRoot,
          options: sourceConfig.lock,
        },
      ],
      "fork-import",
      async (authorities) => {
        const targetAuthority = authorities.get(storeRoot);
        if (targetAuthority === undefined) {
          throw new Error(
            "Cyclotomy target workspace write authority is unavailable",
          );
        }
        const sourceAuthority = authorities.get(authenticatedSourceStoreRoot);
        if (sourceAuthority === undefined) {
          throw new Error(
            "Cyclotomy source workspace write authority is unavailable",
          );
        }
        await this.#assertStillCurrent(view, readCurrentView, workspaceBinding);
        if (!(await this.#targetStoreStillNamesCurrentContext())) {
          throw new Error("Cyclotomy target store changed during fork import");
        }
        if (
          !(await directoryStillBound(
            authenticatedSourceStoreBinding,
            source.requestedStoreRoot,
          ))
        ) {
          throw new Error("Cyclotomy source store changed during fork import");
        }
        const existing = this.#finishExistingTarget(
          targetAuthority,
          request,
          readCurrentView,
        );
        if (existing !== undefined) return existing;

        const revalidated = await revalidatePreparedForkSource(
          this.#options.globalConfig,
          storeRoot,
          prepared,
        );
        if (revalidated.kind === "rejected") {
          return this.#registerTarget(
            targetAuthority,
            request,
            readCurrentView,
            {
              kind: "quarantine",
              rejection: revalidated.rejection,
            },
          );
        }
        const currentSource = revalidated.source;
        if (!sameForkSource(source, currentSource)) {
          return this.#registerTarget(
            targetAuthority,
            request,
            readCurrentView,
            {
              kind: "quarantine",
              rejection: rejection(
                "parent-graph-rewritten",
                "Pi parent session changed during fork import",
              ),
            },
          );
        }

        let reboundSource: DirectoryBinding | undefined;
        try {
          reboundSource = await resolveIsolatedSourceStore(
            currentSource,
            workspaceRoot,
          );
        } catch (error) {
          if (!(error instanceof ForkRejectedError)) throw error;
          return this.#registerTarget(
            targetAuthority,
            request,
            readCurrentView,
            {
              kind: "quarantine",
              rejection: error.rejection,
            },
          );
        }
        if (
          reboundSource === undefined ||
          !sameDirectoryBinding(reboundSource, authenticatedSourceStoreBinding)
        ) {
          throw new Error("Cyclotomy source store changed during fork import");
        }
        this.#assertSnapshotStillCurrent(view, readCurrentView);

        const confirmed = inspectMetadataSessionIdentity(
          join(authenticatedSourceStoreRoot, "state.db"),
          source.sourceSessionId,
          parentSessionFile,
        );
        if (confirmed.kind !== "exact") {
          let value: ForkRejection;
          switch (confirmed.kind) {
            case "absent":
              value = rejection(
                "source-registration-absent",
                "Cyclotomy parent registration disappeared during import",
              );
              break;
            case "conflict":
              value = rejection(
                "source-registration-conflict",
                "Cyclotomy parent registration does not match Pi",
              );
              break;
            case "recovery-required":
              value = rejection(
                "source-metadata-recovery-required",
                "Cyclotomy parent metadata requires recovery before it can be inherited",
                confirmed.cause,
              );
              break;
            case "newer":
              value = rejection(
                "source-metadata-unrecognized",
                `Cyclotomy parent metadata schema version ${confirmed.observedVersion} is newer than supported version ${confirmed.supportedVersion}`,
              );
              break;
            case "unrecognized":
              value = rejection(
                "source-metadata-unrecognized",
                "Cyclotomy parent metadata schema is not recognized",
              );
              break;
          }
          return this.#registerTarget(
            targetAuthority,
            request,
            readCurrentView,
            {
              kind: "quarantine",
              rejection: value,
            },
          );
        }

        let sourceMetadata: CurrentMetadataStore | undefined;
        let sourceStore: NativeObjectStore;
        let projection: ForkCheckpointProjection;
        const provenEntryIds = provenStableCoordinateIds(
          currentSource.stableCoordinates,
          view.stableCoordinates,
        );
        try {
          sourceStore = await openObjectStore(authenticatedSourceStoreRoot, {
            maxFileBytes: sourceConfig.scan.maxFileBytes,
            maxEntries: sourceConfig.scan.maxEntries,
            maxManifestBytes: sourceConfig.scan.maxManifestBytes,
            maxPathBytes: sourceConfig.scan.maxPathBytes,
            maxPathComponents: sourceConfig.scan.maxPathComponents,
          });
          sourceMetadata = await openAuthenticatedCurrentMetadataStore(
            confirmed.proof,
            {
              prepareTreeOidUpgrades: (roots, targetFormat) =>
                prepareTreeOidUpgrades(sourceStore, roots, targetFormat),
            },
            sourceAuthority,
          );
          const exported = sourceMetadata.exportForkProjection({
            parentSessionFile,
            retainedEntryIds: provenEntryIds,
          });
          if (exported === undefined) {
            throw new ForkRejectedError(unverifiedSourceRegistration());
          }
          if (
            exported.sourceSessionId !== source.sourceSessionId ||
            !projectionContainsOnly(exported, provenEntryIds)
          ) {
            throw new ForkRejectedError(
              rejection(
                "source-projection-invalid",
                "Cyclotomy fork source registration changed during import",
              ),
            );
          }
          projection = exported;
        } catch (error) {
          try {
            sourceMetadata?.close();
          } catch {
            // Preserve the source failure that determines quarantine.
          }
          if (error instanceof TreeFormatUpgradeBlockedError) {
            return this.#registerTarget(
              targetAuthority,
              request,
              readCurrentView,
              {
                kind: "quarantine",
                rejection: rejection(
                  "source-metadata-unrecognized",
                  "Cyclotomy parent tree format cannot be upgraded",
                  error,
                ),
              },
            );
          }
          if (!(error instanceof ForkRejectedError)) throw error;
          return this.#registerTarget(
            targetAuthority,
            request,
            readCurrentView,
            {
              kind: "quarantine",
              rejection: error.rejection,
            },
          );
        }

        try {
          try {
            await store.importTreesFrom(
              sourceStore,
              [
                ...new Set(
                  projection.coordinates.flatMap(({ slot }) =>
                    slot.kind === "open-checkpoint" ||
                    slot.kind === "blocked-checkpoint"
                      ? [slot.treeOid]
                      : [],
                  ),
                ),
              ],
              {
                validateImportedTree: (treeOid, manifest) =>
                  this.#validateImportedManifest(treeOid, manifest),
                maxSnapshotBytes: config.scan.maxSnapshotBytes,
              },
            );
          } catch (error) {
            if (!(error instanceof TreeImportAdmissionError)) throw error;
            return this.#registerTarget(
              targetAuthority,
              request,
              readCurrentView,
              {
                kind: "quarantine",
                rejection: rejection(
                  "target-import-rejected",
                  "target workspace rejected the inherited checkpoint set",
                  error,
                ),
              },
            );
          }
          const finalSource = await revalidatePreparedForkSource(
            this.#options.globalConfig,
            storeRoot,
            prepared,
          );
          this.#assertSnapshotStillCurrent(view, readCurrentView);
          if (finalSource.kind === "rejected") {
            return this.#registerTarget(
              targetAuthority,
              request,
              readCurrentView,
              {
                kind: "quarantine",
                rejection: finalSource.rejection,
              },
            );
          }
          if (!sameForkSource(currentSource, finalSource.source)) {
            return this.#registerTarget(
              targetAuthority,
              request,
              readCurrentView,
              {
                kind: "quarantine",
                rejection: rejection(
                  "parent-graph-rewritten",
                  "Pi parent session changed during fork import",
                ),
              },
            );
          }
          if (!projectionContainsOnly(projection, provenEntryIds)) {
            return this.#registerTarget(
              targetAuthority,
              request,
              readCurrentView,
              {
                kind: "quarantine",
                rejection: rejection(
                  "parent-graph-rewritten",
                  "Pi parent graph changed during fork import",
                ),
              },
            );
          }
          if (!(await this.#targetStoreStillNamesCurrentContext())) {
            throw new Error(
              "Cyclotomy target store changed during fork import",
            );
          }
          if (
            !(await directoryStillBound(
              authenticatedSourceStoreBinding,
              finalSource.source.requestedStoreRoot,
            ))
          ) {
            throw new Error(
              "Cyclotomy source store changed during fork import",
            );
          }
          await this.#assertStillCurrent(
            request.view,
            readCurrentView,
            request.workspaceBinding,
          );
          return this.#commitTarget(
            targetAuthority,
            request,
            readCurrentView,
            {
              kind: "inherit",
              projection,
            },
            {
              authority: sourceAuthority,
              storeRoot: authenticatedSourceStoreRoot,
            },
          );
        } finally {
          try {
            sourceMetadata.close();
          } catch {
            // Closing source metadata cannot reverse a committed target.
          }
        }
      },
    );
    if (execution.kind === "action-failed") {
      if (execution.cleanup.kind === "settled") throw execution.cause;
      throw retainFailureCause(
        execution.cause,
        execution.cleanup.cause,
        "fork import and ordered lock cleanup both failed",
      );
    }
    if (execution.cleanup.kind === "settled") return execution.value;
    const targetCleanupFailed = execution.cleanup.failures.some(
      (failure) => failure.storeRoot === storeRoot,
    );
    const cleanupCause = execution.cleanup.cause;
    if (!targetCleanupFailed) {
      return {
        ...execution.value,
        advisory: {
          kind: "source-lock-cleanup-failed",
          cause: cleanupCause,
        },
      };
    }
    return {
      kind: "durable-but-inactive",
      disposition: execution.value.disposition,
      cause: cleanupCause,
    };
  }
}
