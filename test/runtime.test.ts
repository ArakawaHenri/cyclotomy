import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CyclotomyConfigError,
  defaultCyclotomyConfig,
  loadCyclotomyConfig,
} from "../src/config.ts";
import {
  TreeImportAdmissionError,
  TreeImportSourceError,
} from "../src/infrastructure/object-store.ts";
import { ContentRepository } from "../src/infrastructure/content-store/repository.ts";
import { CURRENT_METADATA_VERSION } from "../src/infrastructure/metadata/current.ts";
import { METADATA_WRITER_PROTOCOL_FUNCTION } from "../src/infrastructure/metadata/schema.ts";
import { CURRENT_TREE_MANIFEST_FORMAT } from "../src/infrastructure/tree-formats/current.ts";
import type { WorkspaceScope } from "../src/infrastructure/workspace-scope.ts";
import {
  acquireWorkspaceLock,
  OrderedWorkspaceLockAcquisitionError,
  runWithWorkspaceLock,
  type WorkspaceWriteAuthority,
} from "../src/infrastructure/workspace-lock.ts";
import {
  nativeLooseRecordPath,
  nativeObjectLayout,
} from "../src/infrastructure/workspace-store.ts";
import { CyclotomyI18n } from "../src/pi/i18n.ts";
import { SessionRegistrationService } from "../src/pi/session-registration-service.ts";
import { projectStableGraph } from "../src/pi/extension-boundary.ts";
import { CyclotomyRuntime } from "../src/pi/runtime.ts";
import type { SessionView } from "../src/pi/session-view.ts";
import {
  checkpointIsBlocked,
  checkpointState,
  commitTestNodeState,
  createTestCurrentMetadataStore,
  protectTestLocation,
  readTestSessionRegistration,
  registerTestSession,
  withTestMetadataWriteAuthority,
} from "./metadata-fixture.ts";
import { publishTestBlob, publishTestTree } from "./object-store-fixture.ts";
import { ALL_MANAGED_SCOPE, gitScope } from "./workspace-scope-fixture.ts";

const roots: string[] = [];
const TEST_SCOPE = ALL_MANAGED_SCOPE;
const compatibleV1TreeOid =
  "0c53042c58202208b41f5cf8fd2b96f7c9f275ba2a38fb4d884831eae5ed5557";
const compatibleV2TreeOid =
  "0500eb0932f28766eda94dfb32673db387e463cb3b56e1eaf6dfb89b1c794568";
const compatibleV3TreeOid =
  "07932c7d17030c109a7d199af9a7a972153597341b1cc66c11c379d88d6d52fa";
const compatibleV1BlobOid =
  "657ac5c3ed8157bd26ba717404992b3a2e7eb771d53dd299c631c637a8aa3f33";

function objectPath(
  root: string,
  kind: "blobs" | "trees",
  oid: string,
): string {
  return join(root, "objects", kind, oid.slice(0, 2), oid.slice(2));
}

function makeCurrentWorkspaceLockReleaseFail(storeRoot: string): void {
  const lockPath = join(storeRoot, "workspace.lock");
  writeFileSync(join(lockPath, "unexpected-entry"), "preserve");
}

async function seedCompatiblePublishedV1Store(
  home: string,
  workspace: string,
): Promise<string> {
  const hash = createHash("sha256")
    .update(await realpath(workspace))
    .digest("hex");
  const storeRoot = join(home, "cyclotomy", hash);
  for (const [kind, oid, fixture] of [
    ["blobs", compatibleV1BlobOid, "compatible.blob"],
    ["trees", compatibleV1TreeOid, "compatible.tree"],
  ] as const) {
    const path = objectPath(storeRoot, kind, oid);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      await readFile(
        new URL(`./fixtures/cyclotomy-0.0.1-tree/${fixture}`, import.meta.url),
      ),
    );
  }
  const db = new DatabaseSync(join(storeRoot, "state.db"));
  db.exec(`
    CREATE TABLE node_state(
      session_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      tree_oid TEXT NOT NULL,
      PRIMARY KEY(session_id, entry_id)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE session_registry(
      session_id TEXT NOT NULL PRIMARY KEY,
      session_file TEXT NOT NULL UNIQUE,
      missing_since INTEGER,
      missing_observed_at INTEGER
    ) STRICT, WITHOUT ROWID;
    CREATE INDEX session_registry_missing
    ON session_registry(missing_since, missing_observed_at);
    INSERT INTO node_state(session_id, entry_id, tree_oid)
    VALUES ('legacy', 'checkpoint', '${compatibleV1TreeOid}');
    PRAGMA user_version = 1;
  `);
  db.close();
  return storeRoot;
}

async function createRuntime() {
  const parent = await mkdtemp(join(tmpdir(), "cyclotomy-runtime-"));
  roots.push(parent);
  const workspace = join(parent, "workspace");
  const home = join(parent, "home");
  await Promise.all([mkdir(workspace), mkdir(home)]);
  const runtime = new CyclotomyRuntime(
    loadCyclotomyConfig(home),
    new CyclotomyI18n("en"),
  );
  expect(await runtime.ensureStore(workspace)).toBe(true);
  return { parent, workspace, home, runtime };
}

async function mutateRuntimeMetadata<T>(
  runtime: CyclotomyRuntime,
  operation: () => T,
): Promise<T> {
  return withTestMetadataWriteAuthority(
    runtime.storeRoot,
    runtime.metadata,
    operation,
  );
}

function view(
  cwd: string,
  leafId: string,
  parents: Readonly<Record<string, string | null>>,
): SessionView {
  const entries = Object.entries(parents).map(([id, parentId]) => ({
    id,
    parentId,
    type: "custom",
    messageRole: null,
  }));
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const activeStableAncestryIds: string[] = [];
  let active: string | null = leafId;
  while (active !== null) {
    activeStableAncestryIds.unshift(active);
    active = parents[active] ?? null;
  }
  let snapshot: SessionView;
  snapshot = {
    cwd,
    sessionCwd: cwd,
    sessionId: "s",
    sessionFile: null,
    parentSession: { kind: "absent" },
    leafId,
    stableCoordinates: projectStableGraph(entries).coordinates,
    stableEntryIds: entries.map((entry) => entry.id),
    activeStableAncestryIds,
    stableCoordinateId(entryId = leafId) {
      return entryId === null || byId.has(entryId) ? entryId : undefined;
    },
    stableAncestryIds(entryId = leafId) {
      if (entryId === null) return [];
      if (!byId.has(entryId)) return undefined;
      const reversed: string[] = [];
      let current: string | null = entryId;
      while (current !== null) {
        reversed.push(current);
        current = parents[current] ?? null;
      }
      return reversed.reverse();
    },
    navigationLandingId(entryId) {
      return Object.hasOwn(parents, entryId) ? entryId : undefined;
    },
    authenticateTreeArrival: () => undefined,
    hasSameIdentityAs(other) {
      return (
        snapshot.sessionId === other.sessionId &&
        snapshot.sessionFile === other.sessionFile &&
        snapshot.cwd === other.cwd &&
        snapshot.sessionCwd === other.sessionCwd
      );
    },
    isSameSnapshotAs(other) {
      return snapshot === other;
    },
    isAppendOnlyExtensionOf(previous) {
      return snapshot === previous;
    },
    isNaturalDescendantOf() {
      return false;
    },
  };
  return snapshot;
}

function registrationView(options: {
  readonly cwd: string;
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly parentSessionFile?: string;
  readonly retainedEntryIds?: readonly string[];
}): SessionView {
  const entries = (options.retainedEntryIds ?? []).map((id, index, all) => ({
    id,
    parentId: index === 0 ? null : all[index - 1]!,
    type: "custom",
    messageRole: null,
  }));
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  let snapshot: SessionView;
  snapshot = {
    cwd: options.cwd,
    sessionCwd: options.cwd,
    sessionId: options.sessionId,
    sessionFile: options.sessionFile,
    parentSession:
      options.parentSessionFile === undefined
        ? { kind: "absent" }
        : {
            kind: "candidate",
            path: options.parentSessionFile,
          },
    leafId: entries.at(-1)?.id ?? null,
    stableCoordinates: projectStableGraph(entries).coordinates,
    stableEntryIds: entries.map((entry) => entry.id),
    activeStableAncestryIds: entries.map((entry) => entry.id),
    stableCoordinateId(entryId = snapshot.leafId) {
      return entryId === null || byId.has(entryId) ? entryId : undefined;
    },
    stableAncestryIds(entryId = snapshot.leafId) {
      if (entryId === null) return [];
      const index = entries.findIndex((entry) => entry.id === entryId);
      return index < 0
        ? undefined
        : entries.slice(0, index + 1).map((entry) => entry.id);
    },
    navigationLandingId: (entryId) => (byId.has(entryId) ? entryId : undefined),
    authenticateTreeArrival: () => undefined,
    hasSameIdentityAs(other) {
      return (
        snapshot.sessionId === other.sessionId &&
        snapshot.sessionFile === other.sessionFile &&
        snapshot.cwd === other.cwd &&
        snapshot.sessionCwd === other.sessionCwd
      );
    },
    isSameSnapshotAs(other) {
      return snapshot === other;
    },
    isAppendOnlyExtensionOf(previous) {
      return snapshot === previous;
    },
    isNaturalDescendantOf() {
      return false;
    },
  };
  return snapshot;
}

async function createExternalForkFixture(
  prefix: string,
  lockTimeoutMs?: number,
  scope: WorkspaceScope = TEST_SCOPE,
) {
  const parent = await mkdtemp(join(tmpdir(), prefix));
  roots.push(parent);
  const sourceWorkspace = join(parent, "source");
  const targetWorkspace = join(parent, "target");
  const home = join(parent, "home");
  await Promise.all([
    mkdir(sourceWorkspace),
    mkdir(targetWorkspace),
    mkdir(home),
  ]);
  const parentFile = join(home, "parent.jsonl");
  const childFile = join(home, "child.jsonl");
  await Promise.all([
    writeFile(
      parentFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "parent",
          cwd: sourceWorkspace,
        }),
        JSON.stringify({
          type: "custom",
          id: "retained",
          parentId: null,
          timestamp: new Date(0).toISOString(),
          customType: "test",
        }),
      ].join("\n") + "\n",
    ),
    writeFile(
      childFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "child",
        cwd: targetWorkspace,
      })}\n`,
    ),
  ]);
  const loaded = loadCyclotomyConfig(home);
  const config =
    lockTimeoutMs === undefined
      ? loaded
      : {
          ...loaded,
          lock: { ...loaded.lock, timeoutMs: lockTimeoutMs },
        };
  const sourceRuntime = new CyclotomyRuntime(config, new CyclotomyI18n("en"));
  expect(await sourceRuntime.ensureStore(sourceWorkspace)).toBe(true);
  const blobOid = await publishTestBlob(
    sourceRuntime.store,
    Buffer.from("parent state"),
  );
  const treeOid = await publishTestTree(
    sourceRuntime.store,
    [
      {
        path: "state.txt",
        type: "regular",
        blobOid,
        recreationMode: 0o644,
      },
    ],
    scope,
  );
  await mutateRuntimeMetadata(sourceRuntime, () => {
    registerTestSession(sourceRuntime.metadata, "parent", parentFile, [
      "retained",
    ]);
    commitTestNodeState(sourceRuntime.metadata, "parent", "retained", treeOid);
  });
  const sourceStoreRoot = sourceRuntime.storeRoot;
  sourceRuntime.close();

  return {
    child: registrationView({
      cwd: targetWorkspace,
      sessionId: "child",
      sessionFile: childFile,
      parentSessionFile: parentFile,
      retainedEntryIds: ["retained"],
    }),
    config,
    parentFile,
    sourceStoreRoot,
    targetWorkspace,
    treeOid,
  };
}

type ExternalForkFixture = Awaited<
  ReturnType<typeof createExternalForkFixture>
>;

async function openExternalForkTarget(fixture: ExternalForkFixture) {
  const runtime = new CyclotomyRuntime(fixture.config, new CyclotomyI18n("en"));
  const preparation = await runtime.registrations.prepare(fixture.child, {
    kind: "fork",
    previousSessionFile: fixture.parentFile,
  });
  expect(preparation.kind).toBe("observed");
  expect(
    await runtime.ensureRegistrationStore(fixture.targetWorkspace, preparation),
  ).toBe(true);
  return { preparation, runtime };
}

async function expectExternalForkInheritance(
  fixture: ExternalForkFixture,
): Promise<void> {
  const { preparation, runtime } = await openExternalForkTarget(fixture);
  await expect(
    runtime.registrations.register(
      fixture.child,
      () => fixture.child,
      preparation,
    ),
  ).resolves.toEqual(activeRegistration("inherited"));
  expect(
    runtime.metadata.getCheckpointSlot(fixture.child.sessionId, "retained"),
  ).toEqual({ kind: "open-checkpoint", treeOid: fixture.treeOid });
  runtime.close();
}

function activeRegistration<
  const Kind extends "existing" | "fresh" | "inherited",
>(
  kind: Kind,
): {
  readonly kind: "active";
  readonly disposition: { readonly kind: Kind };
} {
  return { kind: "active", disposition: { kind } };
}

function readSessionProjectionResidue(
  metadataPath: string,
  sessionId: string,
): {
  readonly barriers: number;
  readonly registrations: number;
  readonly slots: number;
} {
  const db = new DatabaseSync(metadataPath, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM session_registry WHERE session_id = ?) AS registrations,
           (SELECT COUNT(*) FROM checkpoint_slot WHERE session_id = ?) AS slots,
           (SELECT COUNT(*) FROM session_capture_barrier WHERE session_id = ?) AS barriers`,
      )
      .get(sessionId, sessionId, sessionId) as {
      readonly barriers: number;
      readonly registrations: number;
      readonly slots: number;
    };
  } finally {
    db.close();
  }
}

function setSessionRegistrationState(
  storeRoot: string,
  sessionId: string,
  state: "pending" | "verified",
): void {
  const writerProtocol = CURRENT_METADATA_VERSION.schema.writerProtocol;
  if (writerProtocol === undefined) {
    throw new Error("current metadata lacks a writer protocol");
  }
  const db = new DatabaseSync(join(storeRoot, "state.db"));
  try {
    db.function(
      METADATA_WRITER_PROTOCOL_FUNCTION,
      { deterministic: true, directOnly: false },
      () => writerProtocol,
    );
    const updated = db
      .prepare(
        `UPDATE session_registry
         SET registration_state = ?
         WHERE session_id = ?`,
      )
      .run(state, sessionId);
    if (Number(updated.changes) !== 1) {
      throw new Error("test session registration is absent");
    }
  } finally {
    db.close();
  }
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Cyclotomy runtime", () => {
  it("projects an inactive transparent ancestry in one traversal", async () => {
    const { workspace, runtime } = await createRuntime();
    const labelCount = 10_050;
    const entries = [
      { id: "root", parentId: null, type: "custom", messageRole: null },
      ...Array.from({ length: labelCount }, (_, index) => ({
        id: `label-${index}`,
        parentId: index === 0 ? "root" : `label-${index - 1}`,
        type: "label",
        messageRole: null,
      })),
      { id: "current", parentId: "root", type: "custom", messageRole: null },
    ];
    const stableGraph = projectStableGraph(entries);
    let stableAncestryCalls = 0;
    const base = view(workspace, "current", { root: null, current: "root" });
    const observed: SessionView = {
      ...base,
      stableCoordinates: projectStableGraph(entries).coordinates,
      stableEntryIds: ["root", "current"],
      activeStableAncestryIds: ["root", "current"],
      stableCoordinateId(entryId = "current") {
        if (entryId === "current") return "current";
        throw new Error(
          "inactive coordinates must not be repeatedly collapsed",
        );
      },
      stableAncestryIds(entryId = "current") {
        stableAncestryCalls += 1;
        return stableGraph.stableAncestryIds(entryId);
      },
    };

    expect(
      runtime.checkpoints.ancestryEntryIds(observed, `label-${labelCount - 1}`),
    ).toEqual(["root"]);
    expect(stableAncestryCalls).toBe(1);
    runtime.close();
  });

  it("migrates a published-v1 store before exposing the runtime", async () => {
    const parent = await mkdtemp(join(tmpdir(), "cyclotomy-runtime-v1-"));
    roots.push(parent);
    const workspace = join(parent, "workspace");
    const home = join(parent, "home");
    await Promise.all([mkdir(workspace), mkdir(home)]);
    const storeRoot = await seedCompatiblePublishedV1Store(home, workspace);
    const runtime = new CyclotomyRuntime(
      loadCyclotomyConfig(home),
      new CyclotomyI18n("en"),
    );

    expect(await runtime.ensureStore(workspace)).toBe(true);
    expect(
      checkpointState(runtime.metadata, "legacy", "checkpoint")?.treeOid,
    ).toBe(compatibleV3TreeOid);
    await expect(
      runtime.store.readTree(compatibleV1TreeOid),
    ).rejects.toMatchObject({ code: "object-integrity" });
    await expect(
      runtime.store.readTree(compatibleV2TreeOid),
    ).rejects.toMatchObject({ code: "object-integrity" });
    await expect(
      runtime.store.readTree(compatibleV3TreeOid),
    ).resolves.toMatchObject({ format: CURRENT_TREE_MANIFEST_FORMAT });
    await expect(
      lstat(objectPath(storeRoot, "trees", compatibleV1TreeOid)),
    ).resolves.toBeDefined();
    runtime.close();
  });

  it("closes migrated metadata when initialization lock cleanup fails", async () => {
    const parent = await mkdtemp(
      join(tmpdir(), "cyclotomy-runtime-migration-release-"),
    );
    roots.push(parent);
    const workspace = join(parent, "workspace");
    const home = join(parent, "home");
    await Promise.all([mkdir(workspace), mkdir(home)]);
    const storeRoot = await seedCompatiblePublishedV1Store(home, workspace);
    const originalPublish = ContentRepository.prototype.publishStructural;
    const publish = vi
      .spyOn(ContentRepository.prototype, "publishStructural")
      .mockImplementation(async function (this: ContentRepository, ...args) {
        await originalPublish.call(this, ...args);
        if (args[1] === compatibleV3TreeOid) {
          makeCurrentWorkspaceLockReleaseFail(storeRoot);
        }
      });
    const metadataProbe = await createTestCurrentMetadataStore(
      join(parent, "metadata-probe.db"),
      parent,
    );
    const metadataPrototype = Object.getPrototypeOf(metadataProbe) as {
      close(): void;
    };
    metadataProbe.close();
    const close = vi.spyOn(metadataPrototype, "close");
    const runtime = new CyclotomyRuntime(
      loadCyclotomyConfig(home),
      new CyclotomyI18n("en"),
    );
    try {
      expect(await runtime.ensureStore(workspace)).toBe(false);
      expect(runtime.registrations.isReady).toBe(false);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      runtime.close();
      close.mockRestore();
      publish.mockRestore();
    }
  });

  it("fails closed without opening a store after a registration failure", async () => {
    const parent = await mkdtemp(join(tmpdir(), "cyclotomy-runtime-disabled-"));
    roots.push(parent);
    const workspace = join(parent, "workspace");
    const home = join(parent, "home");
    await Promise.all([mkdir(workspace), mkdir(home)]);
    const settingsPath = join(home, "cyclotomy", "settings.json");
    const runtime = new CyclotomyRuntime(
      defaultCyclotomyConfig(home),
      new CyclotomyI18n("en"),
      new CyclotomyConfigError(
        settingsPath,
        "maxFileMiB must be a positive number",
      ),
    );

    expect(await runtime.ensureStore(workspace)).toBe(false);

    // A disabled runtime must not create the hashed store while binding.
    expect(await readdir(join(home, "cyclotomy")).catch(() => [])).toEqual([]);
    expect(() => runtime.store).toThrow("store is not initialized");
    expect(() => runtime.metadata).toThrow("metadata is not initialized");

    const notifications: {
      message: string;
      level: string | undefined;
    }[] = [];
    const context = {
      hasUI: true,
      ui: {
        notify(message: string, level?: string) {
          notifications.push({ message, level });
        },
        setStatus(): void {},
      },
    } as never;
    runtime.notifyInitFailure(context);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.level).toBe("error");
    // The basename and diagnostic lead the bounded detail so a long absolute
    // path cannot hide the actionable setting name.
    expect(notifications[0]!.message).toContain(basename(settingsPath));
    expect(notifications[0]!.message).toContain("maxFileMiB");
    expect(notifications[0]!.message).toContain("/cyclotomy resume");

    // Repeated lifecycle reports stay deduplicated; commands force a re-report.
    runtime.notifyInitFailure(context);
    expect(notifications).toHaveLength(1);
    runtime.notifyInitFailure(context, { force: true });
    expect(notifications).toHaveLength(2);

    // Closing a disabled runtime must not re-enable it.
    runtime.close();
    expect(await runtime.ensureStore(workspace)).toBe(false);
  });

  it("loads workspace settings after selecting the canonical store", async () => {
    const parent = await mkdtemp(join(tmpdir(), "cyclotomy-runtime-config-"));
    roots.push(parent);
    const workspace = join(parent, "workspace");
    const home = join(parent, "home");
    await Promise.all([mkdir(workspace), mkdir(home)]);
    await mkdir(join(home, "cyclotomy"));
    await writeFile(
      join(home, "cyclotomy", "settings.json"),
      JSON.stringify({
        storageDir: "../external-store",
        maxFileMiB: 8,
        maxPathBytes: 80 * 1024,
        maxPathComponents: 384,
        gc: { intervalMs: 90_000 },
      }),
    );
    const globalConfig = loadCyclotomyConfig(home);
    const hash = createHash("sha256")
      .update(await realpath(workspace))
      .digest("hex");
    const storeRoot = join(globalConfig.storageRootPath, hash);
    await mkdir(storeRoot, { recursive: true });
    await writeFile(
      join(storeRoot, "settings.json"),
      JSON.stringify({
        maxFileMiB: 2,
        maxPathComponents: 320,
        gc: { intervalMs: 0 },
      }),
    );
    const runtime = new CyclotomyRuntime(globalConfig, new CyclotomyI18n("en"));

    expect(await runtime.ensureStore(workspace)).toBe(true);
    expect(runtime.storeRoot).toBe(await realpath(storeRoot));
    expect(runtime.config.scan.maxFileBytes).toBe(2 * 1024 * 1024);
    expect(runtime.config.scan.maxPathBytes).toBe(80 * 1024);
    expect(runtime.config.scan.maxPathComponents).toBe(320);
    expect(runtime.config.autoGcIntervalMs).toBe(0);
    runtime.close();
  });

  it("reloads workspace configuration in a new runtime after close", async () => {
    const parent = await mkdtemp(join(tmpdir(), "cyclotomy-runtime-reload-"));
    roots.push(parent);
    const workspace = join(parent, "workspace");
    const home = join(parent, "home");
    await Promise.all([mkdir(workspace), mkdir(home)]);
    const hash = createHash("sha256")
      .update(await realpath(workspace))
      .digest("hex");
    const storeRoot = join(home, "cyclotomy", hash);
    const settingsPath = join(storeRoot, "settings.json");
    await mkdir(storeRoot, { recursive: true });
    await writeFile(settingsPath, JSON.stringify({ maxFileMiB: 2 }));
    const globalConfig = loadCyclotomyConfig(home);
    const runtime = new CyclotomyRuntime(globalConfig, new CyclotomyI18n("en"));

    expect(await runtime.ensureStore(workspace)).toBe(true);
    expect(runtime.config.scan.maxFileBytes).toBe(2 * 1024 * 1024);
    runtime.close();
    await writeFile(settingsPath, JSON.stringify({ maxFileMiB: 3 }));
    expect(await runtime.ensureStore(workspace)).toBe(false);
    const reloaded = new CyclotomyRuntime(
      globalConfig,
      new CyclotomyI18n("en"),
    );
    expect(await reloaded.ensureStore(workspace)).toBe(true);
    expect(reloaded.config.scan.maxFileBytes).toBe(3 * 1024 * 1024);
    reloaded.close();
  });

  it("keeps an invalid workspace configuration failed closed for its runtime", async () => {
    const parent = await mkdtemp(join(tmpdir(), "cyclotomy-runtime-invalid-"));
    roots.push(parent);
    const workspace = join(parent, "workspace");
    const home = join(parent, "home");
    await Promise.all([mkdir(workspace), mkdir(home)]);
    const hash = createHash("sha256")
      .update(await realpath(workspace))
      .digest("hex");
    const storeRoot = join(home, "cyclotomy", hash);
    const settingsPath = join(storeRoot, "settings.json");
    await mkdir(storeRoot, { recursive: true });
    await writeFile(settingsPath, "{");
    const runtime = new CyclotomyRuntime(
      loadCyclotomyConfig(home),
      new CyclotomyI18n("en"),
    );

    expect(await runtime.ensureStore(workspace)).toBe(false);
    await writeFile(settingsPath, "{}");
    expect(await runtime.ensureStore(workspace)).toBe(false);
    runtime.close();
    expect(await runtime.ensureStore(workspace)).toBe(false);
    const reloaded = new CyclotomyRuntime(
      loadCyclotomyConfig(home),
      new CyclotomyI18n("en"),
    );
    expect(await reloaded.ensureStore(workspace)).toBe(true);
    reloaded.close();
  });

  it("rejects a global settings file inside the managed workspace", async () => {
    const parent = await mkdtemp(join(tmpdir(), "cyclotomy-runtime-control-"));
    roots.push(parent);
    const workspace = join(parent, "workspace");
    const external = join(parent, "external-store");
    await mkdir(join(workspace, "cyclotomy"), { recursive: true });
    await writeFile(
      join(workspace, "cyclotomy", "settings.json"),
      JSON.stringify({ storageDir: external }),
    );
    const runtime = new CyclotomyRuntime(
      loadCyclotomyConfig(workspace),
      new CyclotomyI18n("en"),
    );

    expect(await runtime.ensureStore(workspace)).toBe(false);
    await expect(lstat(external)).rejects.toMatchObject({ code: "ENOENT" });
    runtime.close();
  });

  it("rejects a target store inside the authenticated parent workspace before creation", async () => {
    const parent = await mkdtemp(
      join(tmpdir(), "cyclotomy-runtime-parent-control-"),
    );
    roots.push(parent);
    const sourceWorkspace = join(parent, "source");
    const targetWorkspace = join(parent, "target");
    const home = join(parent, "home");
    const storageRoot = join(sourceWorkspace, ".control");
    await Promise.all([
      mkdir(sourceWorkspace),
      mkdir(targetWorkspace),
      mkdir(join(home, "cyclotomy"), { recursive: true }),
    ]);
    await writeFile(
      join(home, "cyclotomy", "settings.json"),
      JSON.stringify({ storageDir: storageRoot }),
    );
    const runtime = new CyclotomyRuntime(
      loadCyclotomyConfig(home),
      new CyclotomyI18n("en"),
    );
    const targetHash = createHash("sha256")
      .update(await realpath(targetWorkspace))
      .digest("hex");

    expect(
      await runtime.ensureRegistrationStore(targetWorkspace, {
        kind: "observed",
        claim: {
          kind: "candidate",
          path: join(home, "parent.jsonl"),
        },
        parentSessionFile: join(home, "parent.jsonl"),
        sourceSessionId: "parent",
        recordedCwd: sourceWorkspace,
        workspaceNamespace: await realpath(sourceWorkspace),
        stableCoordinates: [],
      }),
    ).toBe(false);
    await expect(lstat(join(storageRoot, targetHash))).rejects.toMatchObject({
      code: "ENOENT",
    });
    runtime.close();
  });

  it("rejects a parent workspace alias rebound onto the target controls", async (context) => {
    context.skip(
      process.platform === "win32",
      "Windows symlink creation is privilege-dependent",
    );
    const parent = await mkdtemp(join(tmpdir(), "cyclotomy-runtime-rebound-"));
    roots.push(parent);
    const sourceBefore = join(parent, "source-before");
    const sourceAfter = join(parent, "source-after");
    const sourceAlias = join(parent, "source-alias");
    const targetWorkspace = join(parent, "target");
    const home = join(parent, "home");
    await Promise.all([
      mkdir(sourceBefore),
      mkdir(sourceAfter),
      mkdir(targetWorkspace),
      mkdir(join(home, "cyclotomy"), { recursive: true }),
    ]);
    await symlink(sourceBefore, sourceAlias);
    await writeFile(
      join(home, "cyclotomy", "settings.json"),
      JSON.stringify({ storageDir: sourceAfter }),
    );
    const parentFile = join(home, "parent.jsonl");
    const childFile = join(home, "child.jsonl");
    await Promise.all([
      writeFile(
        parentFile,
        `${JSON.stringify({
          type: "session",
          id: "parent",
          cwd: sourceAlias,
        })}\n`,
      ),
      writeFile(
        childFile,
        `${JSON.stringify({
          type: "session",
          id: "child",
          cwd: targetWorkspace,
        })}\n`,
      ),
    ]);
    const runtime = new CyclotomyRuntime(
      loadCyclotomyConfig(home),
      new CyclotomyI18n("en"),
    );
    const child = registrationView({
      cwd: targetWorkspace,
      sessionId: "child",
      sessionFile: childFile,
      parentSessionFile: parentFile,
    });
    const preparation = await runtime.registrations.prepare(child, {
      kind: "fork",
      previousSessionFile: parentFile,
    });
    expect(
      await runtime.ensureRegistrationStore(targetWorkspace, preparation),
    ).toBe(true);

    await rm(sourceAlias);
    await symlink(sourceAfter, sourceAlias);

    await expect(
      runtime.registrations.register(child, () => child, preparation),
    ).rejects.toThrow(/must not overlap/u);
    expect(
      readTestSessionRegistration(join(runtime.storeRoot, "state.db"), "child"),
    ).toBeUndefined();
    runtime.close();
  });

  it("retries when the parent workspace alias becomes unresolvable", async (context) => {
    context.skip(
      process.platform === "win32",
      "Windows symlink creation is privilege-dependent",
    );
    const parent = await mkdtemp(
      join(tmpdir(), "cyclotomy-runtime-parent-loop-"),
    );
    roots.push(parent);
    const sourceWorkspace = join(parent, "source");
    const sourceAlias = join(parent, "source-alias");
    const targetWorkspace = join(parent, "target");
    const home = join(parent, "home");
    await Promise.all([
      mkdir(sourceWorkspace),
      mkdir(targetWorkspace),
      mkdir(home),
    ]);
    await symlink(sourceWorkspace, sourceAlias);
    const parentFile = join(home, "parent.jsonl");
    const childFile = join(home, "child.jsonl");
    await Promise.all([
      writeFile(
        parentFile,
        `${JSON.stringify({
          type: "session",
          id: "parent",
          cwd: sourceAlias,
        })}\n`,
      ),
      writeFile(
        childFile,
        `${JSON.stringify({
          type: "session",
          id: "child",
          cwd: targetWorkspace,
        })}\n`,
      ),
    ]);
    const runtime = new CyclotomyRuntime(
      loadCyclotomyConfig(home),
      new CyclotomyI18n("en"),
    );
    const child = registrationView({
      cwd: targetWorkspace,
      sessionId: "child",
      sessionFile: childFile,
      parentSessionFile: parentFile,
    });
    const preparation = await runtime.registrations.prepare(child, {
      kind: "fork",
      previousSessionFile: parentFile,
    });
    expect(preparation.kind).toBe("observed");
    expect(
      await runtime.ensureRegistrationStore(targetWorkspace, preparation),
    ).toBe(true);

    await rm(sourceAlias);
    await symlink(basename(sourceAlias), sourceAlias);

    await expect(
      runtime.registrations.register(child, () => child, preparation),
    ).rejects.toMatchObject({ code: "ELOOP" });
    expect(
      readSessionProjectionResidue(
        join(runtime.storeRoot, "state.db"),
        "child",
      ),
    ).toEqual({ barriers: 0, registrations: 0, slots: 0 });
    runtime.close();
  });

  it("revokes capture authority when a registered workspace path is recreated", async () => {
    const parent = await mkdtemp(
      join(tmpdir(), "cyclotomy-runtime-workspace-recreated-"),
    );
    roots.push(parent);
    const workspace = join(parent, "workspace");
    const displaced = join(parent, "displaced");
    const home = join(parent, "home");
    await Promise.all([mkdir(workspace), mkdir(home)]);
    const runtime = new CyclotomyRuntime(
      loadCyclotomyConfig(home),
      new CyclotomyI18n("en"),
    );
    const parentFile = join(home, "missing-parent.jsonl");
    const child = registrationView({
      cwd: workspace,
      sessionId: "child",
      sessionFile: join(home, "child.jsonl"),
      parentSessionFile: parentFile,
      retainedEntryIds: ["retained"],
    });
    const preparation = await runtime.registrations.prepare(child, {
      kind: "fork",
      previousSessionFile: parentFile,
    });
    expect(await runtime.ensureRegistrationStore(workspace, preparation)).toBe(
      true,
    );
    await expect(
      runtime.registrations.register(child, () => child, preparation),
    ).resolves.toMatchObject({
      kind: "active",
      disposition: { kind: "quarantined" },
    });

    await rename(workspace, displaced);
    await mkdir(workspace);

    await expect(
      runtime.registrations.workspaceStillBound(workspace),
    ).resolves.toBe(false);
    const committed = runtime.commitPreparedCapture(
      {} as WorkspaceWriteAuthority,
      child,
      { sessionId: "child", entryId: "retained" },
      {
        treeOid: "a".repeat(64),
        snapshot: {} as never,
      },
      { kind: "open-missing" },
    );
    expect(committed).toMatchObject({
      ok: false,
      error: { kind: "metadata-failed" },
    });
    expect(
      checkpointState(runtime.metadata, "child", "retained"),
    ).toBeUndefined();
    runtime.close();
  });

  it("rejects a prepared capture at the metadata fence after lock ownership is lost", async () => {
    const { workspace, home, runtime } = await createRuntime();
    const current = registrationView({
      cwd: workspace,
      sessionId: "capture-lock-loss",
      sessionFile: join(home, "capture-lock-loss.jsonl"),
      retainedEntryIds: ["retained"],
    });
    const preparation = await runtime.registrations.prepare(current, {
      kind: "independent",
    });
    await expect(
      runtime.registrations.register(current, () => current, preparation),
    ).resolves.toEqual(activeRegistration("fresh"));
    const commitCapture = vi.spyOn(runtime.metadata, "commitCapture");
    const storeRoot = runtime.storeRoot;

    const execution = await runWithWorkspaceLock(
      storeRoot,
      "capture-lock-loss-test",
      async (writeAuthority) => {
        await rename(
          join(storeRoot, "workspace.lock"),
          join(storeRoot, "displaced.lock"),
        );
        return runtime.commitPreparedCapture(
          writeAuthority,
          current,
          { sessionId: current.sessionId, entryId: "retained" },
          { treeOid: "a".repeat(64), snapshot: {} as never },
          { kind: "open-missing" },
        );
      },
    );

    expect(execution.kind).toBe("completed");
    if (execution.kind !== "completed") throw execution.cause;
    expect(execution.value).toMatchObject({
      ok: false,
      error: {
        kind: "metadata-failed",
        cause: { name: "WorkspaceLockOwnershipLostError" },
      },
    });
    expect(commitCapture).toHaveBeenCalledOnce();
    expect(execution.cleanup.kind).toBe("failed");
    runtime.close();
  });

  it("revokes active authority when the workspace store path is recreated", async (context) => {
    context.skip(
      process.platform === "win32",
      "Windows does not rename a directory containing an open SQLite database",
    );
    const { workspace, home, runtime } = await createRuntime();
    const current = registrationView({
      cwd: workspace,
      sessionId: "store-recreated",
      sessionFile: join(home, "store-recreated.jsonl"),
      retainedEntryIds: ["retained"],
    });
    const preparation = await runtime.registrations.prepare(current, {
      kind: "independent",
    });
    await expect(
      runtime.registrations.register(current, () => current, preparation),
    ).resolves.toEqual(activeRegistration("fresh"));
    const storeRoot = runtime.storeRoot;
    const displaced = `${storeRoot}.displaced`;

    await rename(storeRoot, displaced);
    await mkdir(storeRoot);

    await expect(
      runtime.registrations.workspaceStillBound(workspace),
    ).resolves.toBe(false);
    expect(await runtime.ensureStore(workspace)).toBe(false);
    const committed = runtime.commitPreparedCapture(
      {} as WorkspaceWriteAuthority,
      current,
      { sessionId: current.sessionId, entryId: "retained" },
      {
        treeOid: "a".repeat(64),
        snapshot: {} as never,
      },
      { kind: "open-missing" },
    );
    expect(committed).toMatchObject({
      ok: false,
      error: { kind: "metadata-failed" },
    });
    expect(
      checkpointState(runtime.metadata, current.sessionId, "retained"),
    ).toBeUndefined();
    runtime.close();
  });

  it("opens only the active leaf of a genuinely fresh session", async () => {
    const { workspace, home, runtime } = await createRuntime();
    const current = registrationView({
      cwd: workspace,
      sessionId: "fresh",
      sessionFile: join(home, "fresh.jsonl"),
      retainedEntryIds: ["root", "leaf"],
    });
    const preparation = await runtime.registrations.prepare(current, {
      kind: "independent",
    });
    expect(preparation).toEqual({
      kind: "independent",
      claim: { kind: "absent" },
    });
    await expect(
      runtime.registrations.register(current, () => current, preparation),
    ).resolves.toEqual(activeRegistration("fresh"));

    expect(runtime.metadata.getCheckpointSlot("fresh", "root")).toEqual({
      kind: "blocked-missing",
    });
    expect(runtime.metadata.getCheckpointSlot("fresh", "leaf")).toEqual({
      kind: "open-missing",
    });
    expect(
      runtime.metadata.hasSessionBarrier({
        sessionId: "fresh",
        sessionFile: current.sessionFile!,
      }),
    ).toBe(false);
    runtime.close();
  });

  it("keeps a committed fresh registration inactive after target lock cleanup fails", async () => {
    const { workspace, home, runtime } = await createRuntime();
    const current = registrationView({
      cwd: workspace,
      sessionId: "fresh-release-failure",
      sessionFile: join(home, "fresh-release-failure.jsonl"),
      retainedEntryIds: ["leaf"],
    });
    const preparation = await runtime.registrations.prepare(current, {
      kind: "independent",
    });
    const storeRoot = runtime.storeRoot;
    const originalFinalize = runtime.metadata.finalizeSessionProjection.bind(
      runtime.metadata,
    );
    vi.spyOn(runtime.metadata, "finalizeSessionProjection").mockImplementation(
      (authority, input, sourceAuthority) => {
        const report = originalFinalize(authority, input, sourceAuthority);
        makeCurrentWorkspaceLockReleaseFail(storeRoot);
        return report;
      },
    );

    await expect(
      runtime.registrations.register(current, () => current, preparation),
    ).resolves.toMatchObject({
      kind: "durable-but-inactive",
      disposition: { kind: "fresh" },
      cause: expect.any(Error),
    });
    expect(runtime.registrations.sessionIsUsable(current)).toBe(false);
    expect(
      readTestSessionRegistration(
        join(storeRoot, "state.db"),
        current.sessionId,
      ),
    ).toBeDefined();
    runtime.close();
  });

  it("revokes an earlier authority when re-registration cannot activate", async () => {
    const { workspace, home, runtime } = await createRuntime();
    const current = registrationView({
      cwd: workspace,
      sessionId: "reloaded-release-failure",
      sessionFile: join(home, "reloaded-release-failure.jsonl"),
      retainedEntryIds: ["leaf"],
    });
    const preparation = await runtime.registrations.prepare(current, {
      kind: "independent",
    });
    await expect(
      runtime.registrations.register(current, () => current, preparation),
    ).resolves.toEqual(activeRegistration("fresh"));
    expect(runtime.registrations.sessionIsUsable(current)).toBe(true);

    const originalFinalize = runtime.metadata.finalizeSessionProjection.bind(
      runtime.metadata,
    );
    vi.spyOn(runtime.metadata, "finalizeSessionProjection").mockImplementation(
      (authority, input, sourceAuthority) => {
        const report = originalFinalize(authority, input, sourceAuthority);
        makeCurrentWorkspaceLockReleaseFail(runtime.storeRoot);
        return report;
      },
    );

    await expect(
      runtime.registrations.register(current, () => current, preparation),
    ).resolves.toMatchObject({
      kind: "durable-but-inactive",
      disposition: { kind: "existing" },
    });
    expect(runtime.registrations.sessionIsUsable(current)).toBe(false);
    runtime.close();
  });

  it("lets an existing target outrank an indeterminate parent observation", async () => {
    const { workspace, home, runtime } = await createRuntime();
    const parentFile = join(home, "temporarily-unreadable-parent.jsonl");
    const child = registrationView({
      cwd: workspace,
      sessionId: "existing-child",
      sessionFile: join(home, "existing-child.jsonl"),
      parentSessionFile: parentFile,
      retainedEntryIds: ["retained"],
    });
    await mutateRuntimeMetadata(runtime, () =>
      registerTestSession(
        runtime.metadata,
        child.sessionId,
        child.sessionFile!,
        child.stableEntryIds,
      ),
    );
    const cause = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });

    await expect(
      runtime.registrations.register(child, () => child, {
        kind: "indeterminate",
        claim: child.parentSession,
        parentSessionFile: parentFile,
        cause,
      }),
    ).resolves.toEqual(activeRegistration("existing"));
    expect(runtime.registrations.sessionIsUsable(child)).toBe(true);
    runtime.close();
  });

  it("does not register an absent target from indeterminate evidence", async () => {
    const { workspace, home, runtime } = await createRuntime();
    const parentFile = join(home, "temporarily-unreadable-parent.jsonl");
    const child = registrationView({
      cwd: workspace,
      sessionId: "retry-child",
      sessionFile: join(home, "retry-child.jsonl"),
      parentSessionFile: parentFile,
      retainedEntryIds: ["retained"],
    });
    const cause = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });

    await expect(
      runtime.registrations.register(child, () => child, {
        kind: "indeterminate",
        claim: child.parentSession,
        parentSessionFile: parentFile,
        cause,
      }),
    ).rejects.toBe(cause);
    expect(
      readSessionProjectionResidue(
        join(runtime.storeRoot, "state.db"),
        child.sessionId,
      ),
    ).toEqual({ barriers: 0, registrations: 0, slots: 0 });
    runtime.close();
  });

  it("atomically barriers every coordinate from an untrusted parent", async () => {
    const { workspace, home, runtime } = await createRuntime();
    const parentFile = join(home, "missing-parent.jsonl");
    const current = registrationView({
      cwd: workspace,
      sessionId: "untrusted-child",
      sessionFile: join(home, "untrusted-child.jsonl"),
      parentSessionFile: parentFile,
      retainedEntryIds: ["root", "leaf"],
    });
    const preparation = await runtime.registrations.prepare(current, {
      kind: "fork",
      previousSessionFile: parentFile,
    });
    expect(preparation.kind).toBe("rejected");
    await expect(
      runtime.registrations.register(current, () => current, preparation),
    ).resolves.toMatchObject({
      kind: "active",
      disposition: { kind: "quarantined" },
    });

    expect(
      runtime.metadata.getCheckpointSlot("untrusted-child", "root"),
    ).toEqual({ kind: "blocked-missing" });
    expect(
      runtime.metadata.getCheckpointSlot("untrusted-child", "leaf"),
    ).toEqual({ kind: "blocked-missing" });
    expect(
      runtime.metadata.hasSessionBarrier({
        sessionId: "untrusted-child",
        sessionFile: current.sessionFile!,
      }),
    ).toBe(true);
    runtime.close();
  });

  it("uses a cold child parent claim only as an authenticated-source locator", async () => {
    const { workspace, home, runtime } = await createRuntime();
    const parentFile = join(home, "header-only-parent.jsonl");
    await writeFile(
      parentFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "header-only-parent",
        cwd: workspace,
      })}\n`,
    );
    const child = registrationView({
      cwd: workspace,
      sessionId: "header-only-child",
      sessionFile: join(home, "header-only-child.jsonl"),
      parentSessionFile: parentFile,
      retainedEntryIds: ["retained"],
    });

    const preparation = await runtime.registrations.prepare(child, {
      kind: "independent",
    });

    expect(preparation).toMatchObject({
      kind: "observed",
      parentSessionFile: parentFile,
      sourceSessionId: "header-only-parent",
    });
    await expect(
      runtime.registrations.register(child, () => child, preparation),
    ).resolves.toMatchObject({
      kind: "active",
      disposition: { kind: "quarantined" },
    });
    expect(
      runtime.metadata.getCheckpointSlot(child.sessionId, "retained"),
    ).toEqual({ kind: "blocked-missing" });
    runtime.close();
  });

  it("does not treat a fork start with no previous session as fresh", async () => {
    const { workspace, home, runtime } = await createRuntime();
    const child = registrationView({
      cwd: workspace,
      sessionId: "source-less-fork",
      sessionFile: join(home, "source-less-fork.jsonl"),
      retainedEntryIds: ["retained"],
    });

    const preparation = await runtime.registrations.prepare(child, {
      kind: "fork",
    });

    expect(preparation).toMatchObject({
      kind: "rejected",
      rejection: {
        kind: "invalid-parent-claim",
        cause: expect.any(Error),
      },
    });
    await expect(
      runtime.registrations.register(child, () => child, preparation),
    ).resolves.toMatchObject({
      kind: "active",
      disposition: { kind: "quarantined" },
    });
    expect(
      runtime.metadata.getCheckpointSlot(child.sessionId, "retained"),
    ).toEqual({ kind: "blocked-missing" });
    runtime.close();
  });

  it("inherits only publicly proven parent coordinates and blocks child-only entries", async () => {
    const { workspace, home, runtime } = await createRuntime();
    const parentFile = join(home, "projection-parent.jsonl");
    await writeFile(
      parentFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "parent",
          cwd: workspace,
        }),
        JSON.stringify({
          type: "custom",
          id: "shared",
          parentId: null,
          timestamp: new Date(0).toISOString(),
          customType: "test",
        }),
      ].join("\n") + "\n",
    );
    const treeOid = "a".repeat(64);
    await mutateRuntimeMetadata(runtime, () => {
      registerTestSession(runtime.metadata, "parent", parentFile, ["shared"]);
      commitTestNodeState(runtime.metadata, "parent", "shared", treeOid);
    });
    const child = registrationView({
      cwd: workspace,
      sessionId: "projection-child",
      sessionFile: join(home, "projection-child.jsonl"),
      parentSessionFile: parentFile,
      retainedEntryIds: ["shared", "child-only"],
    });
    const preparation = await runtime.registrations.prepare(child, {
      kind: "fork",
      previousSessionFile: parentFile,
    });
    await expect(
      runtime.registrations.register(child, () => child, preparation),
    ).resolves.toEqual(activeRegistration("inherited"));

    expect(
      runtime.metadata.getCheckpointSlot("projection-child", "shared"),
    ).toEqual({ kind: "open-checkpoint", treeOid });
    expect(
      runtime.metadata.getCheckpointSlot("projection-child", "child-only"),
    ).toEqual({ kind: "blocked-missing" });
    runtime.close();
  });

  it.each([
    { rejectedExport: 1, stage: "initial authentication" },
    { rejectedExport: 2, stage: "retained projection" },
  ])(
    "quarantines an unverified local parent during $stage without late inheritance",
    async ({ rejectedExport }) => {
      const { workspace, home, runtime } = await createRuntime();
      const parentFile = join(home, "pending-parent.jsonl");
      await writeFile(
        parentFile,
        [
          JSON.stringify({
            type: "session",
            version: 3,
            id: "pending-parent",
            cwd: workspace,
          }),
          JSON.stringify({
            type: "custom",
            id: "shared",
            parentId: null,
            timestamp: new Date(0).toISOString(),
            customType: "test",
          }),
        ].join("\n") + "\n",
      );
      const treeOid = "e".repeat(64);
      await mutateRuntimeMetadata(runtime, () => {
        registerTestSession(runtime.metadata, "pending-parent", parentFile, [
          "shared",
        ]);
        commitTestNodeState(
          runtime.metadata,
          "pending-parent",
          "shared",
          treeOid,
        );
      });
      const child = registrationView({
        cwd: workspace,
        sessionId: "pending-child",
        sessionFile: join(home, "pending-child.jsonl"),
        parentSessionFile: parentFile,
        retainedEntryIds: ["shared"],
      });
      const preparation = await runtime.registrations.prepare(child, {
        kind: "fork",
        previousSessionFile: parentFile,
      });
      const originalExport = runtime.metadata.exportForkProjection.bind(
        runtime.metadata,
      );
      let exportCount = 0;
      const projection = vi
        .spyOn(runtime.metadata, "exportForkProjection")
        .mockImplementation((input) => {
          exportCount += 1;
          return exportCount === rejectedExport
            ? undefined
            : originalExport(input);
        });

      await expect(
        runtime.registrations.register(child, () => child, preparation),
      ).resolves.toMatchObject({
        kind: "active",
        disposition: {
          kind: "quarantined",
          rejection: { kind: "source-registration-unverified" },
        },
      });
      expect(exportCount).toBe(rejectedExport);
      expect(
        readSessionProjectionResidue(
          join(runtime.storeRoot, "state.db"),
          child.sessionId,
        ),
      ).toEqual({ barriers: 1, registrations: 1, slots: 1 });
      expect(
        runtime.metadata.getCheckpointSlot(child.sessionId, "shared"),
      ).toEqual({ kind: "blocked-missing" });

      projection.mockRestore();
      await expect(
        runtime.registrations.register(child, () => child, preparation),
      ).resolves.toEqual(activeRegistration("existing"));
      expect(
        runtime.metadata.getCheckpointSlot(child.sessionId, "shared"),
      ).toEqual({ kind: "blocked-missing" });
      runtime.close();
    },
  );

  it("quarantines a declared fork when its parent file is unavailable", async () => {
    const { workspace, home, runtime } = await createRuntime();
    const parentFile = join(home, "unavailable-parent.jsonl");
    const treeOid = "c".repeat(64);
    await mutateRuntimeMetadata(runtime, () => {
      registerTestSession(runtime.metadata, "unavailable-parent", parentFile, [
        "shared",
      ]);
      commitTestNodeState(
        runtime.metadata,
        "unavailable-parent",
        "shared",
        treeOid,
      );
    });

    const child = registrationView({
      cwd: workspace,
      sessionId: "unavailable-child",
      sessionFile: join(home, "unavailable-child.jsonl"),
      parentSessionFile: parentFile,
      retainedEntryIds: ["shared"],
    });
    const preparation = await runtime.registrations.prepare(child, {
      kind: "fork",
      previousSessionFile: parentFile,
    });
    expect(preparation).toMatchObject({ kind: "rejected" });
    await expect(
      runtime.registrations.register(child, () => child, preparation),
    ).resolves.toMatchObject({
      kind: "active",
      disposition: { kind: "quarantined" },
    });
    expect(
      runtime.metadata.getCheckpointSlot("unavailable-child", "shared"),
    ).toEqual({ kind: "blocked-missing" });
    runtime.close();
  });

  it("uses the cold public parent graph rather than newer local metadata", async () => {
    const { workspace, home, runtime } = await createRuntime();
    const parentFile = join(home, "cold-parent.jsonl");
    await writeFile(
      parentFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "cold-parent",
        cwd: workspace,
      })}\n`,
    );
    const treeOid = "d".repeat(64);
    await mutateRuntimeMetadata(runtime, () => {
      registerTestSession(runtime.metadata, "cold-parent", parentFile, [
        "shared",
      ]);
      commitTestNodeState(runtime.metadata, "cold-parent", "shared", treeOid);
    });

    const child = registrationView({
      cwd: workspace,
      sessionId: "cold-child",
      sessionFile: join(home, "cold-child.jsonl"),
      parentSessionFile: parentFile,
      retainedEntryIds: ["shared"],
    });
    const preparation = await runtime.registrations.prepare(child, {
      kind: "fork",
      previousSessionFile: parentFile,
    });
    expect(preparation).toMatchObject({
      kind: "observed",
      stableCoordinates: [],
    });
    await expect(
      runtime.registrations.register(child, () => child, preparation),
    ).resolves.toEqual(activeRegistration("inherited"));
    expect(
      runtime.metadata.getCheckpointSlot(child.sessionId, "shared"),
    ).toEqual({ kind: "blocked-missing" });
    runtime.close();
  });

  it.each(["semantic type", "stable parent"] as const)(
    "does not inherit an id whose public %s changed",
    async (change) => {
      const { workspace, home, runtime } = await createRuntime();
      const parentFile = join(home, `forged-${change}.jsonl`);
      await writeFile(
        parentFile,
        [
          JSON.stringify({
            type: "session",
            version: 3,
            id: "parent",
            cwd: workspace,
          }),
          JSON.stringify({
            type: "custom",
            id: "source-root",
            parentId: null,
            timestamp: new Date(0).toISOString(),
            customType: "test",
          }),
          JSON.stringify({
            type: "custom",
            id: "shared",
            parentId: "source-root",
            timestamp: new Date(0).toISOString(),
            customType: "test",
          }),
        ].join("\n") + "\n",
      );
      const treeOid = "b".repeat(64);
      await mutateRuntimeMetadata(runtime, () => {
        registerTestSession(runtime.metadata, "parent", parentFile, [
          "source-root",
          "shared",
        ]);
        commitTestNodeState(runtime.metadata, "parent", "shared", treeOid);
      });

      const base = registrationView({
        cwd: workspace,
        sessionId: `forged-${change}`,
        sessionFile: join(home, `forged-child-${change}.jsonl`),
        parentSessionFile: parentFile,
        retainedEntryIds:
          change === "stable parent"
            ? ["different-root", "shared"]
            : ["source-root", "shared"],
      });
      const forgedCoordinates = base.stableCoordinates.map((coordinate) =>
        coordinate.id === "shared" && change === "semantic type"
          ? { ...coordinate, type: "session_info" }
          : coordinate,
      );
      let child: SessionView;
      child = {
        ...base,
        stableCoordinates: Object.freeze(forgedCoordinates),
        isSameSnapshotAs: (other) => other === child,
        isAppendOnlyExtensionOf: (previous) => previous === child,
      };
      const preparation = await runtime.registrations.prepare(child, {
        kind: "fork",
        previousSessionFile: parentFile,
      });
      await expect(
        runtime.registrations.register(child, () => child, preparation),
      ).resolves.toEqual(activeRegistration("inherited"));
      expect(
        runtime.metadata.getCheckpointSlot(child.sessionId, "shared"),
      ).toEqual({ kind: "blocked-missing" });
      runtime.close();
    },
  );

  it("keeps a durable guard when an armed tree arrival rewrites its source graph", async () => {
    const { workspace, home, runtime } = await createRuntime();
    const sessionFile = join(home, "guarded-arrival.jsonl");
    const current = registrationView({
      cwd: workspace,
      sessionId: "guarded-arrival",
      sessionFile,
      retainedEntryIds: ["retained"],
    });
    const preparation = await runtime.registrations.prepare(current, {
      kind: "independent",
    });
    await expect(
      runtime.registrations.register(current, () => current, preparation),
    ).resolves.toEqual(activeRegistration("fresh"));

    const treeOid = "a".repeat(64);
    await mutateRuntimeMetadata(runtime, () =>
      commitTestNodeState(
        runtime.metadata,
        current.sessionId,
        "retained",
        treeOid,
        sessionFile,
      ),
    );
    const resolution = {
      treeOid,
      foundAt: { sessionId: current.sessionId, entryId: "retained" },
    };
    await expect(
      runtime.enqueueWorkspaceExecution("test-admit-location", async (lease) =>
        runtime.workspaceMutations.admitLocationIfResolution(
          lease,
          current,
          resolution,
        ),
      ),
    ).resolves.toMatchObject({ kind: "completed", value: true });
    expect(
      await mutateRuntimeMetadata(
        runtime,
        () =>
          protectTestLocation(
            runtime.metadata,
            { sessionId: current.sessionId, sessionFile },
            "retained",
          ).kind,
      ),
    ).toBe("protected");

    const arrival = runtime.admission.beginTreeArrival();
    const rewritten: SessionView = {
      ...current,
      isAppendOnlyExtensionOf: () => false,
    };
    await expect(
      runtime.enqueueWorkspaceExecution("test-admit-arrival", async (lease) =>
        runtime.workspaceMutations.admitTreeArrivalIfResolution(
          lease,
          arrival,
          rewritten,
          resolution,
        ),
      ),
    ).resolves.toMatchObject({
      kind: "completed",
      value: { kind: "unsettled", cause: expect.any(Error) },
    });
    expect(
      checkpointIsBlocked(runtime.metadata, current.sessionId, "retained"),
    ).toBe(true);
    runtime.close();
  });

  it("fails a stale planned protection while pinning the inherited current checkpoint", async () => {
    const { workspace, home, runtime } = await createRuntime();
    const sessionFile = join(home, "stale-inherited.jsonl");
    const rootView = registrationView({
      cwd: workspace,
      sessionId: "stale-inherited",
      sessionFile,
      retainedEntryIds: ["root"],
    });
    const preparation = await runtime.registrations.prepare(rootView, {
      kind: "independent",
    });
    await expect(
      runtime.registrations.register(rootView, () => rootView, preparation),
    ).resolves.toEqual(activeRegistration("fresh"));

    const before = "a".repeat(64);
    const after = "b".repeat(64);
    await mutateRuntimeMetadata(runtime, () =>
      commitTestNodeState(
        runtime.metadata,
        rootView.sessionId,
        "root",
        before,
        sessionFile,
      ),
    );
    const leafView = registrationView({
      cwd: workspace,
      sessionId: rootView.sessionId,
      sessionFile,
      retainedEntryIds: ["root", "leaf"],
    });
    const staleResolution = {
      treeOid: before,
      foundAt: { sessionId: rootView.sessionId, entryId: "root" },
    };
    await expect(
      runtime.enqueueWorkspaceExecution("test-admit-inherited", async (lease) =>
        runtime.workspaceMutations.admitLocationIfResolution(
          lease,
          leafView,
          staleResolution,
        ),
      ),
    ).resolves.toMatchObject({ kind: "completed", value: true });

    const concurrent = await createTestCurrentMetadataStore(
      join(runtime.storeRoot, "state.db"),
      runtime.storeRoot,
    );
    await expect(
      runWithWorkspaceLock(
        runtime.storeRoot,
        "runtime metadata concurrency test",
        async (authority) =>
          concurrent.commitCapture(authority, {
            identity: { sessionId: rootView.sessionId, sessionFile },
            entryId: "root",
            activeAncestryEntryIds: ["root"],
            treeOid: after,
            expectedSlot: { kind: "open-checkpoint", treeOid: before },
          }),
      ),
    ).resolves.toMatchObject({ kind: "completed", value: "committed" });
    concurrent.close();

    await expect(
      runtime.enqueueWorkspaceExecution(
        "test-protect-inherited",
        async (lease) =>
          runtime.workspaceMutations.protectNodeIfResolution(
            lease,
            leafView,
            { sessionId: rootView.sessionId, entryId: "leaf" },
            staleResolution,
          ),
      ),
    ).resolves.toMatchObject({
      kind: "completed",
      value: {
        kind: "protected",
        evidence: { kind: "exact-slot", expectation: "stale" },
      },
    });
    expect(
      runtime.metadata.getCheckpointSlot(rootView.sessionId, "leaf"),
    ).toEqual({ kind: "blocked-checkpoint", treeOid: after });
    runtime.close();
  });

  it("quarantines when an authenticated parent later changes identity", async () => {
    const parent = await mkdtemp(
      join(tmpdir(), "cyclotomy-runtime-parent-drift-"),
    );
    roots.push(parent);
    const sourceWorkspace = join(parent, "source");
    const targetWorkspace = join(parent, "target");
    const home = join(parent, "home");
    await Promise.all([
      mkdir(sourceWorkspace),
      mkdir(targetWorkspace),
      mkdir(home),
    ]);
    const parentFile = join(home, "parent.jsonl");
    const childFile = join(home, "child.jsonl");
    await Promise.all([
      writeFile(
        parentFile,
        `${JSON.stringify({
          type: "session",
          id: "parent",
          cwd: sourceWorkspace,
        })}\n`,
      ),
      writeFile(
        childFile,
        `${JSON.stringify({
          type: "session",
          id: "child",
          cwd: targetWorkspace,
        })}\n`,
      ),
    ]);
    const runtime = new CyclotomyRuntime(
      loadCyclotomyConfig(home),
      new CyclotomyI18n("en"),
    );
    const child = registrationView({
      cwd: targetWorkspace,
      sessionId: "child",
      sessionFile: childFile,
      parentSessionFile: parentFile,
    });
    const preparation = await runtime.registrations.prepare(child, {
      kind: "fork",
      previousSessionFile: parentFile,
    });
    expect(preparation.kind).toBe("observed");
    expect(
      await runtime.ensureRegistrationStore(targetWorkspace, preparation),
    ).toBe(true);

    await writeFile(
      parentFile,
      `${JSON.stringify({
        type: "session",
        id: "replacement",
        cwd: sourceWorkspace,
      })}\n`,
    );

    await expect(
      runtime.registrations.register(child, () => child, preparation),
    ).resolves.toMatchObject({
      kind: "active",
      disposition: {
        kind: "quarantined",
        rejection: { cause: expect.any(Error) },
      },
    });
    expect(
      readTestSessionRegistration(join(runtime.storeRoot, "state.db"), "child"),
    ).toBeDefined();
    runtime.close();
  });

  it("revalidates a local parent after the final target currentness check", async () => {
    const parent = await mkdtemp(
      join(tmpdir(), "cyclotomy-runtime-local-final-parent-"),
    );
    roots.push(parent);
    const workspace = join(parent, "workspace");
    const home = join(parent, "home");
    await Promise.all([mkdir(workspace), mkdir(home)]);
    const parentFile = join(home, "parent.jsonl");
    const childFile = join(home, "child.jsonl");
    await Promise.all([
      writeFile(
        parentFile,
        `${JSON.stringify({
          type: "session",
          id: "parent",
          cwd: workspace,
        })}\n`,
      ),
      writeFile(
        childFile,
        `${JSON.stringify({
          type: "session",
          id: "child",
          cwd: workspace,
        })}\n`,
      ),
    ]);
    const runtime = new CyclotomyRuntime(
      loadCyclotomyConfig(home),
      new CyclotomyI18n("en"),
    );
    const child = registrationView({
      cwd: workspace,
      sessionId: "child",
      sessionFile: childFile,
      parentSessionFile: parentFile,
      retainedEntryIds: ["retained"],
    });
    const preparation = await runtime.registrations.prepare(child, {
      kind: "fork",
      previousSessionFile: parentFile,
    });
    expect(await runtime.ensureRegistrationStore(workspace, preparation)).toBe(
      true,
    );
    await mutateRuntimeMetadata(runtime, () => {
      registerTestSession(runtime.metadata, "parent", parentFile, ["retained"]);
      commitTestNodeState(
        runtime.metadata,
        "parent",
        "retained",
        "a".repeat(64),
      );
    });

    const originalExport = runtime.metadata.exportForkProjection.bind(
      runtime.metadata,
    );
    let initialSourceProjectionRead = false;
    vi.spyOn(runtime.metadata, "exportForkProjection").mockImplementation(
      (input) => {
        const projection = originalExport(input);
        if (input.retainedEntryIds.length === 0) {
          initialSourceProjectionRead = true;
        }
        return projection;
      },
    );
    let targetChecksAfterSourceRead = 0;
    let sourceMutationScheduled = false;
    const readCurrentView = () => {
      if (initialSourceProjectionRead) {
        targetChecksAfterSourceRead += 1;
        if (targetChecksAfterSourceRead === 2) {
          sourceMutationScheduled = true;
          // Run after assertStillCurrent's final synchronous observation but
          // before its awaiting caller begins source authentication.
          queueMicrotask(() => {
            writeFileSync(
              parentFile,
              `${JSON.stringify({
                type: "session",
                id: "replacement",
                cwd: workspace,
              })}\n`,
            );
          });
        }
      }
      return child;
    };

    await expect(
      runtime.registrations.register(child, readCurrentView, preparation),
    ).resolves.toMatchObject({
      kind: "active",
      disposition: {
        kind: "quarantined",
        rejection: { cause: expect.any(Error) },
      },
    });
    expect(sourceMutationScheduled).toBe(true);
    expect(
      readTestSessionRegistration(join(runtime.storeRoot, "state.db"), "child"),
    ).toBeDefined();
    expect(
      checkpointState(runtime.metadata, "child", "retained"),
    ).toBeUndefined();
    runtime.close();
  });

  it("aborts a preflight source access failure and inherits on retry", async () => {
    const fixture = await createExternalForkFixture(
      "cyclotomy-runtime-source-publication-",
    );
    const { preparation, runtime } = await openExternalForkTarget(fixture);
    const sourceTreePath = objectPath(
      fixture.sourceStoreRoot,
      "trees",
      fixture.treeOid,
    );
    const heldTreePath = `${sourceTreePath}.held`;
    await rename(sourceTreePath, heldTreePath);
    await mkdir(sourceTreePath);

    try {
      await expect(
        runtime.registrations.register(
          fixture.child,
          () => fixture.child,
          preparation,
        ),
      ).rejects.toBeInstanceOf(TreeImportSourceError);
      expect(
        readSessionProjectionResidue(
          join(runtime.storeRoot, "state.db"),
          fixture.child.sessionId,
        ),
      ).toEqual({ barriers: 0, registrations: 0, slots: 0 });
    } finally {
      runtime.close();
      await rm(sourceTreePath, { recursive: true, force: true });
      await rename(heldTreePath, sourceTreePath);
    }

    await expectExternalForkInheritance(fixture);
  });

  it("does not quarantine an operational Pi parent parse failure", async () => {
    const fixture = await createExternalForkFixture(
      "cyclotomy-runtime-parent-parse-",
    );
    const { preparation, runtime } = await openExternalForkTarget(fixture);
    await writeFile(fixture.parentFile, "{\n");

    await expect(
      runtime.registrations.register(
        fixture.child,
        () => fixture.child,
        preparation,
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(
      readSessionProjectionResidue(
        join(runtime.storeRoot, "state.db"),
        fixture.child.sessionId,
      ),
    ).toEqual({ barriers: 0, registrations: 0, slots: 0 });
    runtime.close();
  });

  it("does not quarantine an operational target policy evaluation failure", async () => {
    const fixture = await createExternalForkFixture(
      "cyclotomy-runtime-import-policy-operation-",
      undefined,
      gitScope(),
    );
    const { preparation, runtime } = await openExternalForkTarget(fixture);
    const previousPath = process.env.PATH;
    process.env.PATH = join(fixture.targetWorkspace, "missing-bin");
    try {
      await expect(
        runtime.registrations.register(
          fixture.child,
          () => fixture.child,
          preparation,
        ),
      ).rejects.toBeInstanceOf(Error);
      expect(
        readSessionProjectionResidue(
          join(runtime.storeRoot, "state.db"),
          fixture.child.sessionId,
        ),
      ).toEqual({ barriers: 0, registrations: 0, slots: 0 });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      runtime.close();
    }

    await expectExternalForkInheritance(fixture);
  });

  it("quarantines an unverified external parent without late inheritance", async () => {
    const fixture = await createExternalForkFixture(
      "cyclotomy-runtime-source-unverified-",
    );
    setSessionRegistrationState(fixture.sourceStoreRoot, "parent", "pending");
    const { preparation, runtime } = await openExternalForkTarget(fixture);

    await expect(
      runtime.registrations.register(
        fixture.child,
        () => fixture.child,
        preparation,
      ),
    ).resolves.toMatchObject({
      kind: "active",
      disposition: {
        kind: "quarantined",
        rejection: { kind: "source-registration-unverified" },
      },
    });
    expect(
      runtime.metadata.getCheckpointSlot(fixture.child.sessionId, "retained"),
    ).toEqual({ kind: "blocked-missing" });
    runtime.close();

    setSessionRegistrationState(fixture.sourceStoreRoot, "parent", "verified");
    const reopened = await openExternalForkTarget(fixture);
    await expect(
      reopened.runtime.registrations.register(
        fixture.child,
        () => fixture.child,
        reopened.preparation,
      ),
    ).resolves.toEqual(activeRegistration("existing"));
    expect(
      reopened.runtime.metadata.getCheckpointSlot(
        fixture.child.sessionId,
        "retained",
      ),
    ).toEqual({ kind: "blocked-missing" });
    reopened.runtime.close();
  });

  it("uses the source workspace lock timeout and inherits on retry", async () => {
    const fixture = await createExternalForkFixture(
      "cyclotomy-runtime-source-lock-",
      100,
    );
    await writeFile(
      join(fixture.sourceStoreRoot, "settings.json"),
      JSON.stringify({ lockTimeoutMs: 25 }),
    );
    const { preparation, runtime } = await openExternalForkTarget(fixture);
    const sourceLock = await acquireWorkspaceLock(
      fixture.sourceStoreRoot,
      "test-hold-fork-source",
      fixture.config.lock,
    );
    try {
      await expect(
        runtime.registrations.register(
          fixture.child,
          () => fixture.child,
          preparation,
        ),
      ).rejects.toMatchObject({
        name: OrderedWorkspaceLockAcquisitionError.name,
        storeRoot: fixture.sourceStoreRoot,
        cause: {
          name: "WorkspaceLockTimeoutError",
          message: expect.stringContaining("25 ms"),
        },
      });
      expect(
        readSessionProjectionResidue(
          join(runtime.storeRoot, "state.db"),
          fixture.child.sessionId,
        ),
      ).toEqual({ barriers: 0, registrations: 0, slots: 0 });
    } finally {
      await sourceLock.release();
    }
    runtime.close();

    await expectExternalForkInheritance(fixture);
  });

  it("returns an existing external target without reading source settings", async () => {
    const fixture = await createExternalForkFixture(
      "cyclotomy-runtime-source-config-shortcut-",
    );
    const { preparation, runtime } = await openExternalForkTarget(fixture);
    await mutateRuntimeMetadata(runtime, () =>
      registerTestSession(
        runtime.metadata,
        fixture.child.sessionId,
        fixture.child.sessionFile!,
        fixture.child.stableEntryIds,
      ),
    );
    await writeFile(join(fixture.sourceStoreRoot, "settings.json"), "{");

    await expect(
      runtime.registrations.register(
        fixture.child,
        () => fixture.child,
        preparation,
      ),
    ).resolves.toEqual(activeRegistration("existing"));
    runtime.close();
  });

  it("does not quarantine invalid source settings and inherits on retry", async () => {
    const fixture = await createExternalForkFixture(
      "cyclotomy-runtime-source-config-operation-",
    );
    const settingsPath = join(fixture.sourceStoreRoot, "settings.json");
    await writeFile(settingsPath, "{");
    const { preparation, runtime } = await openExternalForkTarget(fixture);

    await expect(
      runtime.registrations.register(
        fixture.child,
        () => fixture.child,
        preparation,
      ),
    ).rejects.toBeInstanceOf(CyclotomyConfigError);
    expect(
      readSessionProjectionResidue(
        join(runtime.storeRoot, "state.db"),
        fixture.child.sessionId,
      ),
    ).toEqual({ barriers: 0, registrations: 0, slots: 0 });
    runtime.close();

    await writeFile(settingsPath, "{}");
    await expectExternalForkInheritance(fixture);
  });

  it("quarantines a newer source metadata schema with its unsupported version", async () => {
    const fixture = await createExternalForkFixture(
      "cyclotomy-runtime-source-metadata-newer-",
    );
    const newerVersion = CURRENT_METADATA_VERSION.version + 1;
    const metadataPath = join(fixture.sourceStoreRoot, "state.db");
    const metadata = new DatabaseSync(metadataPath);
    metadata.exec(`PRAGMA user_version = ${newerVersion}`);
    metadata.close();
    const { preparation, runtime } = await openExternalForkTarget(fixture);

    await expect(
      runtime.registrations.register(
        fixture.child,
        () => fixture.child,
        preparation,
      ),
    ).resolves.toMatchObject({
      kind: "active",
      disposition: {
        kind: "quarantined",
        rejection: {
          kind: "source-metadata-unrecognized",
          cause: {
            message: `Cyclotomy parent metadata schema version ${newerVersion} is newer than supported version ${CURRENT_METADATA_VERSION.version}`,
          },
        },
      },
    });
    expect(
      readTestSessionRegistration(
        join(runtime.storeRoot, "state.db"),
        fixture.child.sessionId,
      ),
    ).toBeDefined();
    runtime.close();
  });

  it("quarantines ancestry when source metadata sidecars require recovery", async () => {
    const fixture = await createExternalForkFixture(
      "cyclotomy-runtime-source-metadata-sidecar-",
    );
    const { preparation, runtime } = await openExternalForkTarget(fixture);
    const metadataPath = join(fixture.sourceStoreRoot, "state.db");
    const walPath = `${metadataPath}-wal`;
    const shmPath = `${metadataPath}-shm`;
    await rm(shmPath, { force: true });
    await writeFile(walPath, "unrecovered WAL sentinel");
    await expect(
      runtime.registrations.register(
        fixture.child,
        () => fixture.child,
        preparation,
      ),
    ).resolves.toMatchObject({
      kind: "active",
      disposition: {
        kind: "quarantined",
        rejection: { kind: "source-metadata-recovery-required" },
      },
    });
    expect(
      readSessionProjectionResidue(
        join(runtime.storeRoot, "state.db"),
        fixture.child.sessionId,
      ),
    ).toEqual({ barriers: 1, registrations: 1, slots: 1 });
    expect(
      runtime.metadata.getCheckpointSlot(fixture.child.sessionId, "retained"),
    ).toEqual({ kind: "blocked-missing" });
    await rm(walPath, { force: true });
    runtime.close();

    const reopened = new CyclotomyRuntime(
      fixture.config,
      new CyclotomyI18n("en"),
    );
    const retried = await reopened.registrations.prepare(fixture.child, {
      kind: "fork",
      previousSessionFile: fixture.parentFile,
    });
    expect(
      await reopened.ensureRegistrationStore(fixture.targetWorkspace, retried),
    ).toBe(true);
    await expect(
      reopened.registrations.register(
        fixture.child,
        () => fixture.child,
        retried,
      ),
    ).resolves.toEqual(activeRegistration("existing"));
    expect(
      reopened.metadata.getCheckpointSlot(fixture.child.sessionId, "retained"),
    ).toEqual({ kind: "blocked-missing" });
    reopened.close();
  });

  it("accepts a semantic-prefix append while external inheritance waits", async () => {
    const fixture = await createExternalForkFixture(
      "cyclotomy-runtime-parent-append-",
    );
    const { preparation, runtime } = await openExternalForkTarget(fixture);
    await appendFile(
      fixture.parentFile,
      `${JSON.stringify({
        type: "custom",
        id: "appended-after-fork",
        parentId: "retained",
        timestamp: new Date(1).toISOString(),
        customType: "test",
      })}\n`,
    );

    await expect(
      runtime.registrations.register(
        fixture.child,
        () => fixture.child,
        preparation,
      ),
    ).resolves.toEqual(activeRegistration("inherited"));
    expect(
      runtime.metadata.getCheckpointSlot(fixture.child.sessionId, "retained"),
    ).toEqual({ kind: "open-checkpoint", treeOid: fixture.treeOid });
    runtime.close();
  });

  it("quarantines an external fork that reuses its source session id", async () => {
    const fixture = await createExternalForkFixture(
      "cyclotomy-runtime-source-id-conflict-",
    );
    await writeFile(
      fixture.child.sessionFile!,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "parent",
        cwd: fixture.targetWorkspace,
      })}\n`,
    );
    const child = registrationView({
      cwd: fixture.targetWorkspace,
      sessionId: "parent",
      sessionFile: fixture.child.sessionFile!,
      parentSessionFile: fixture.parentFile,
      retainedEntryIds: ["retained"],
    });
    const runtime = new CyclotomyRuntime(
      fixture.config,
      new CyclotomyI18n("en"),
    );
    const preparation = await runtime.registrations.prepare(child, {
      kind: "fork",
      previousSessionFile: fixture.parentFile,
    });
    expect(
      await runtime.ensureRegistrationStore(
        fixture.targetWorkspace,
        preparation,
      ),
    ).toBe(true);

    await expect(
      runtime.registrations.register(child, () => child, preparation),
    ).resolves.toMatchObject({
      kind: "active",
      disposition: {
        kind: "quarantined",
        rejection: { kind: "source-registration-conflict" },
      },
    });
    runtime.close();
  });

  it("activates a committed import after only the source lock cleanup fails", async () => {
    const fixture = await createExternalForkFixture(
      "cyclotomy-runtime-source-release-",
    );
    const { preparation, runtime } = await openExternalForkTarget(fixture);
    const originalFinalize = runtime.metadata.finalizeSessionProjection.bind(
      runtime.metadata,
    );
    vi.spyOn(runtime.metadata, "finalizeSessionProjection").mockImplementation(
      (authority, input, sourceAuthority) => {
        const report = originalFinalize(authority, input, sourceAuthority);
        makeCurrentWorkspaceLockReleaseFail(fixture.sourceStoreRoot);
        return report;
      },
    );

    const registration = await runtime.registrations.register(
      fixture.child,
      () => fixture.child,
      preparation,
    );
    expect(registration).toMatchObject({
      kind: "active",
      disposition: { kind: "inherited" },
      advisory: {
        kind: "source-lock-cleanup-failed",
        cause: expect.any(Error),
      },
    });
    expect(runtime.registrations.sessionIsUsable(fixture.child)).toBe(true);
    runtime.close();
  });

  it("reports a committed import inactive after target lock cleanup fails", async () => {
    const fixture = await createExternalForkFixture(
      "cyclotomy-runtime-target-release-",
    );
    const { preparation, runtime } = await openExternalForkTarget(fixture);
    const targetStoreRoot = runtime.storeRoot;
    const originalFinalize = runtime.metadata.finalizeSessionProjection.bind(
      runtime.metadata,
    );
    vi.spyOn(runtime.metadata, "finalizeSessionProjection").mockImplementation(
      (authority, input, sourceAuthority) => {
        const report = originalFinalize(authority, input, sourceAuthority);
        makeCurrentWorkspaceLockReleaseFail(targetStoreRoot);
        return report;
      },
    );

    await expect(
      runtime.registrations.register(
        fixture.child,
        () => fixture.child,
        preparation,
      ),
    ).resolves.toMatchObject({
      kind: "durable-but-inactive",
      disposition: { kind: "inherited" },
      cause: expect.any(Error),
    });
    expect(runtime.registrations.sessionIsUsable(fixture.child)).toBe(false);
    expect(
      readTestSessionRegistration(
        join(targetStoreRoot, "state.db"),
        fixture.child.sessionId,
      ),
    ).toBeDefined();
    runtime.close();
  });

  it("does not commit or activate through a same-path target store replacement", async (context) => {
    context.skip(
      process.platform === "win32",
      "Windows does not rename a directory containing an open SQLite database",
    );
    const fixture = await createExternalForkFixture(
      "cyclotomy-runtime-target-store-replaced-",
    );
    const { preparation, runtime } = await openExternalForkTarget(fixture);
    const targetStoreRoot = runtime.storeRoot;
    const displaced = `${targetStoreRoot}.displaced`;
    const importTrees = runtime.store.importTreesFrom.bind(runtime.store);
    vi.spyOn(runtime.store, "importTreesFrom").mockImplementation(
      async (...args) => {
        await importTrees(...args);
        await rename(targetStoreRoot, displaced);
        await mkdir(targetStoreRoot);
      },
    );

    await expect(
      runtime.registrations.register(
        fixture.child,
        () => fixture.child,
        preparation,
      ),
    ).rejects.toThrow(/target store changed/u);
    expect(runtime.registrations.sessionIsUsable(fixture.child)).toBe(false);
    runtime.close();
    expect(
      readSessionProjectionResidue(
        join(displaced, "state.db"),
        fixture.child.sessionId,
      ),
    ).toEqual({ barriers: 0, registrations: 0, slots: 0 });
  });

  it("does not commit an imported projection after target lock ownership is lost", async (context) => {
    context.skip(
      process.platform === "win32",
      "Windows does not rename a live workspace lock directory reliably",
    );
    const fixture = await createExternalForkFixture(
      "cyclotomy-runtime-target-lock-replaced-",
    );
    const { preparation, runtime } = await openExternalForkTarget(fixture);
    const targetStoreRoot = runtime.storeRoot;
    const lockPath = join(targetStoreRoot, "workspace.lock");
    const displacedLock = `${lockPath}.displaced`;
    const importTrees = runtime.store.importTreesFrom.bind(runtime.store);
    vi.spyOn(runtime.store, "importTreesFrom").mockImplementation(
      async (...args) => {
        await importTrees(...args);
        await rename(lockPath, displacedLock);
        await mkdir(lockPath);
      },
    );

    await expect(
      runtime.registrations.register(
        fixture.child,
        () => fixture.child,
        preparation,
      ),
    ).rejects.toThrow(/workspace lock ownership was lost/u);
    expect(runtime.registrations.sessionIsUsable(fixture.child)).toBe(false);
    expect(
      readSessionProjectionResidue(
        join(targetStoreRoot, "state.db"),
        fixture.child.sessionId,
      ),
    ).toEqual({ barriers: 0, registrations: 0, slots: 0 });
    runtime.close();
  });

  it("does not commit an imported projection after source lock ownership is lost", async (context) => {
    context.skip(
      process.platform === "win32",
      "Windows does not rename a live workspace lock directory reliably",
    );
    const fixture = await createExternalForkFixture(
      "cyclotomy-runtime-source-lock-replaced-",
    );
    const { preparation, runtime } = await openExternalForkTarget(fixture);
    const lockPath = join(fixture.sourceStoreRoot, "workspace.lock");
    const displacedLock = `${lockPath}.displaced`;
    const importTrees = runtime.store.importTreesFrom.bind(runtime.store);
    vi.spyOn(runtime.store, "importTreesFrom").mockImplementation(
      async (...args) => {
        await importTrees(...args);
        await rename(lockPath, displacedLock);
        await mkdir(lockPath);
      },
    );

    await expect(
      runtime.registrations.register(
        fixture.child,
        () => fixture.child,
        preparation,
      ),
    ).rejects.toThrow(/workspace lock ownership was lost/u);
    expect(runtime.registrations.sessionIsUsable(fixture.child)).toBe(false);
    expect(
      readSessionProjectionResidue(
        join(runtime.storeRoot, "state.db"),
        fixture.child.sessionId,
      ),
    ).toEqual({ barriers: 0, registrations: 0, slots: 0 });
    runtime.close();
  });

  it("does not quarantine a same-path source store replacement", async (context) => {
    context.skip(
      process.platform === "win32",
      "Windows does not rename a directory containing an open SQLite database",
    );
    const fixture = await createExternalForkFixture(
      "cyclotomy-runtime-source-store-replaced-",
    );
    const { preparation, runtime } = await openExternalForkTarget(fixture);
    const displaced = `${fixture.sourceStoreRoot}.displaced`;
    const importTrees = runtime.store.importTreesFrom.bind(runtime.store);
    vi.spyOn(runtime.store, "importTreesFrom").mockImplementation(
      async (...args) => {
        await importTrees(...args);
        await rename(fixture.sourceStoreRoot, displaced);
        await mkdir(fixture.sourceStoreRoot);
      },
    );

    await expect(
      runtime.registrations.register(
        fixture.child,
        () => fixture.child,
        preparation,
      ),
    ).rejects.toThrow(/source store changed/u);
    expect(
      readSessionProjectionResidue(
        join(runtime.storeRoot, "state.db"),
        fixture.child.sessionId,
      ),
    ).toEqual({ barriers: 0, registrations: 0, slots: 0 });
    runtime.close();

    await rm(fixture.sourceStoreRoot, { recursive: true });
    await rm(join(displaced, "workspace.lock"), {
      recursive: true,
      force: true,
    });
    await rename(displaced, fixture.sourceStoreRoot);
    await expectExternalForkInheritance(fixture);
  });

  it("rejects a source alias to the target before ordered self-locking", async (context) => {
    context.skip(
      process.platform === "win32",
      "Windows symlink creation is privilege-dependent",
    );
    const fixture = await createExternalForkFixture(
      "cyclotomy-runtime-source-store-alias-",
      25,
    );
    const { preparation, runtime } = await openExternalForkTarget(fixture);
    await rm(fixture.sourceStoreRoot, { recursive: true });
    await symlink(runtime.storeRoot, fixture.sourceStoreRoot, "dir");

    await expect(
      runtime.registrations.register(
        fixture.child,
        () => fixture.child,
        preparation,
      ),
    ).resolves.toMatchObject({
      kind: "active",
      disposition: {
        kind: "quarantined",
        rejection: { kind: "unsafe-source-topology" },
      },
    });
    runtime.close();
  });

  it("durably quarantines ancestry rejected by target admission", async () => {
    const fixture = await createExternalForkFixture(
      "cyclotomy-runtime-import-admission-",
    );
    const { preparation, runtime } = await openExternalForkTarget(fixture);
    const admissionFailure = new TreeImportAdmissionError(
      new Error("target policy rejected ancestry"),
    );
    vi.spyOn(runtime.store, "importTreesFrom").mockRejectedValueOnce(
      admissionFailure,
    );

    await expect(
      runtime.registrations.register(
        fixture.child,
        () => fixture.child,
        preparation,
      ),
    ).resolves.toMatchObject({
      kind: "active",
      disposition: {
        kind: "quarantined",
        rejection: { kind: "target-import-rejected" },
      },
    });
    expect(
      readSessionProjectionResidue(
        join(runtime.storeRoot, "state.db"),
        fixture.child.sessionId,
      ),
    ).toEqual({ barriers: 1, registrations: 1, slots: 1 });
    expect(
      runtime.metadata.getCheckpointSlot(fixture.child.sessionId, "retained"),
    ).toEqual({ kind: "blocked-missing" });
    runtime.close();

    const reloaded = await openExternalForkTarget(fixture);
    await expect(
      reloaded.runtime.registrations.register(
        fixture.child,
        () => fixture.child,
        reloaded.preparation,
      ),
    ).resolves.toEqual(activeRegistration("existing"));
    expect(
      reloaded.runtime.metadata.getCheckpointSlot(
        fixture.child.sessionId,
        "retained",
      ),
    ).toEqual({ kind: "blocked-missing" });
    reloaded.runtime.close();
  });

  it("does not trust a local parent registry after its missing file appears with another identity", async () => {
    const parent = await mkdtemp(join(tmpdir(), "cyclotomy-runtime-appeared-"));
    roots.push(parent);
    const targetWorkspace = join(parent, "target");
    const externalWorkspace = join(parent, "external");
    const home = join(parent, "home");
    await Promise.all([
      mkdir(targetWorkspace),
      mkdir(externalWorkspace),
      mkdir(home),
    ]);
    const parentFile = join(home, "parent.jsonl");
    const childFile = join(home, "child.jsonl");
    await writeFile(
      childFile,
      `${JSON.stringify({
        type: "session",
        id: "child",
        cwd: targetWorkspace,
      })}\n`,
    );
    const runtime = new CyclotomyRuntime(
      loadCyclotomyConfig(home),
      new CyclotomyI18n("en"),
    );
    const child = registrationView({
      cwd: targetWorkspace,
      sessionId: "child",
      sessionFile: childFile,
      parentSessionFile: parentFile,
      retainedEntryIds: ["retained"],
    });
    const preparation = await runtime.registrations.prepare(child, {
      kind: "fork",
      previousSessionFile: parentFile,
    });
    expect(preparation.kind).toBe("rejected");
    expect(
      await runtime.ensureRegistrationStore(targetWorkspace, preparation),
    ).toBe(true);
    await mutateRuntimeMetadata(runtime, () => {
      registerTestSession(runtime.metadata, "parent", parentFile, ["retained"]);
      commitTestNodeState(
        runtime.metadata,
        "parent",
        "retained",
        "a".repeat(64),
      );
    });

    await writeFile(
      parentFile,
      `${JSON.stringify({
        type: "session",
        id: "different",
        cwd: externalWorkspace,
      })}\n`,
    );
    await expect(
      runtime.registrations.register(child, () => child, preparation),
    ).resolves.toMatchObject({
      kind: "active",
      disposition: { kind: "quarantined" },
    });
    expect(
      readTestSessionRegistration(join(runtime.storeRoot, "state.db"), "child"),
    ).toBeDefined();
    expect(
      checkpointState(runtime.metadata, "child", "retained"),
    ).toBeUndefined();
    runtime.close();
  });

  it("rejects a store symlink located inside the managed workspace", async (context) => {
    context.skip(
      process.platform === "win32",
      "Windows symlink creation is privilege-dependent",
    );
    const parent = await mkdtemp(
      join(tmpdir(), "cyclotomy-runtime-store-link-"),
    );
    roots.push(parent);
    const workspace = join(parent, "workspace");
    const home = join(parent, "home");
    const external = join(parent, "external-store");
    await Promise.all([
      mkdir(workspace),
      mkdir(join(home, "cyclotomy"), { recursive: true }),
      mkdir(external),
    ]);
    const linkedStorage = join(workspace, "cyclotomy-control");
    await symlink(external, linkedStorage);
    await writeFile(
      join(home, "cyclotomy", "settings.json"),
      JSON.stringify({ storageDir: linkedStorage }),
    );
    const runtime = new CyclotomyRuntime(
      loadCyclotomyConfig(home),
      new CyclotomyI18n("en"),
    );

    expect(await runtime.ensureStore(workspace)).toBe(false);
    expect((await lstat(linkedStorage)).isSymbolicLink()).toBe(true);
    expect(await readdir(external)).toEqual([]);
    runtime.close();
  });

  it("rejects a workspace hash symlink to another workspace store", async (context) => {
    context.skip(
      process.platform === "win32",
      "Windows symlink creation is privilege-dependent",
    );
    const parent = await mkdtemp(
      join(tmpdir(), "cyclotomy-runtime-hash-link-"),
    );
    roots.push(parent);
    const first = join(parent, "first");
    const second = join(parent, "second");
    const home = join(parent, "home");
    const storageRoot = join(home, "cyclotomy");
    await Promise.all([
      mkdir(first),
      mkdir(second),
      mkdir(storageRoot, { recursive: true }),
    ]);
    const firstHash = createHash("sha256")
      .update(await realpath(first))
      .digest("hex");
    const secondHash = createHash("sha256")
      .update(await realpath(second))
      .digest("hex");
    const secondRoot = join(storageRoot, secondHash);
    await mkdir(secondRoot);
    await symlink(secondRoot, join(storageRoot, firstHash));
    const config = loadCyclotomyConfig(home);
    const firstRuntime = new CyclotomyRuntime(config, new CyclotomyI18n("en"));
    const secondRuntime = new CyclotomyRuntime(config, new CyclotomyI18n("en"));

    expect(await firstRuntime.ensureStore(first)).toBe(false);
    expect(await readdir(secondRoot)).toEqual([]);
    expect(await secondRuntime.ensureStore(second)).toBe(true);
    await expect(firstRuntime.ensureStore(first)).resolves.toBe(false);
    firstRuntime.close();
    secondRuntime.close();
  });

  it("publishes the automatic-GC timestamp through a private temporary file", async () => {
    const { runtime } = await createRuntime();
    const startedAfter = Date.now();

    await runtime.maybeRunAutomaticGc();

    const statePath = join(runtime.storeRoot, "gc-state.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      lastGcAt: number;
    };
    expect(state.lastGcAt).toBeGreaterThanOrEqual(startedAfter);
    expect(state.lastGcAt).toBeLessThanOrEqual(Date.now());
    if (process.platform !== "win32") {
      expect((await lstat(statePath)).mode & 0o777).toBe(0o600);
    }
    expect(
      (await readdir(runtime.storeRoot)).filter(
        (name) =>
          name.startsWith(`gc-state.json.${process.pid}.`) &&
          name.endsWith(".tmp"),
      ),
    ).toEqual([]);
    runtime.close();
  });

  it("does not disguise a corrupted automatic-GC schedule as never run", async () => {
    const { runtime } = await createRuntime();
    const statePath = join(runtime.storeRoot, "gc-state.json");
    await writeFile(statePath, "{not-json\n");

    await expect(runtime.maybeRunAutomaticGc()).rejects.toThrow(
      "automatic GC schedule is unreadable",
    );
    expect(await readFile(statePath, "utf8")).toBe("{not-json\n");
    runtime.close();
  });

  it("does not follow the former predictable GC-state temporary symlink", async (context) => {
    context.skip(
      process.platform === "win32",
      "Windows symlink creation is privilege-dependent",
    );
    const { parent, runtime } = await createRuntime();
    const statePath = join(runtime.storeRoot, "gc-state.json");
    const predictable = `${statePath}.${process.pid}.tmp`;
    const victim = join(parent, "victim.txt");
    await writeFile(victim, "must remain untouched");
    await symlink(victim, predictable);

    await runtime.maybeRunAutomaticGc();

    expect(await readFile(victim, "utf8")).toBe("must remain untouched");
    expect((await lstat(predictable)).isSymbolicLink()).toBe(true);
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      lastGcAt: number;
    };
    expect(Number.isFinite(state.lastGcAt)).toBe(true);
    runtime.close();
  });

  it("binds one runtime to one canonical workspace", async () => {
    const parent = await mkdtemp(join(tmpdir(), "cyclotomy-runtime-two-"));
    roots.push(parent);
    const first = join(parent, "first");
    const second = join(parent, "second");
    const home = join(parent, "home");
    await Promise.all([mkdir(first), mkdir(second), mkdir(home)]);
    const runtime = new CyclotomyRuntime(
      loadCyclotomyConfig(home),
      new CyclotomyI18n("en"),
    );
    expect(await runtime.ensureStore(first)).toBe(true);
    const firstRoot = runtime.storeRoot;
    await mutateRuntimeMetadata(runtime, () =>
      commitTestNodeState(runtime.metadata, "s", "e", "a".repeat(64)),
    );
    expect(await runtime.ensureStore(second)).toBe(false);
    expect(runtime.storeRoot).toBe(firstRoot);
    expect(checkpointState(runtime.metadata, "s", "e")?.treeOid).toBe(
      "a".repeat(64),
    );

    runtime.close();
    expect(await runtime.ensureStore(second)).toBe(false);
    const replacement = new CyclotomyRuntime(
      loadCyclotomyConfig(home),
      new CyclotomyI18n("en"),
    );
    expect(await replacement.ensureStore(second)).toBe(true);
    expect(replacement.storeRoot).not.toBe(firstRoot);
    expect(checkpointState(replacement.metadata, "s", "e")).toBeUndefined();
    replacement.close();
  });

  it("does not revive a queued cold initialization after terminal close", async () => {
    const parent = await mkdtemp(join(tmpdir(), "cyclotomy-runtime-close-"));
    roots.push(parent);
    const workspace = join(parent, "workspace");
    const home = join(parent, "home");
    await Promise.all([mkdir(workspace), mkdir(home)]);

    let enterQueue!: () => void;
    const queued = new Promise<void>((resolveQueued) => {
      enterQueue = resolveQueued;
    });
    let releaseQueue!: () => void;
    const queueGate = new Promise<void>((resolveQueue) => {
      releaseQueue = resolveQueue;
    });
    const registrations = new SessionRegistrationService({
      globalConfig: loadCyclotomyConfig(home),
      runExclusively: async (action) => {
        enterQueue();
        await queueGate;
        return action();
      },
    });

    const opening = registrations.ensureStore(workspace, {
      kind: "independent",
      claim: { kind: "absent" },
    });
    await queued;
    registrations.close();
    releaseQueue();

    await expect(opening).resolves.toMatchObject({ kind: "failed" });
    expect(registrations.isReady).toBe(false);
    await expect(
      registrations.ensureStore(workspace, {
        kind: "independent",
        claim: { kind: "absent" },
      }),
    ).resolves.toMatchObject({ kind: "failed" });
  });

  it("rejects a cwd symlink retargeted after store selection", async (context) => {
    context.skip(
      process.platform === "win32",
      "Windows symlink creation is privilege-dependent",
    );
    const parent = await mkdtemp(join(tmpdir(), "cyclotomy-runtime-link-"));
    roots.push(parent);
    const first = join(parent, "first");
    const second = join(parent, "second");
    const link = join(parent, "workspace-link");
    const home = join(parent, "home");
    await Promise.all([mkdir(first), mkdir(second), mkdir(home)]);
    await symlink(first, link);
    const runtime = new CyclotomyRuntime(
      loadCyclotomyConfig(home),
      new CyclotomyI18n("en"),
    );
    expect(await runtime.ensureStore(link)).toBe(true);
    expect(runtime.workspaceRoot).toBe(await realpath(first));
    await rm(link);
    await symlink(second, link);

    await expect(runtime.scanCurrentWorkspace(link)).rejects.toThrow(
      "workspace root changed",
    );
    const prepared = await runtime.checkpoints.prepareCurrent(
      view(link, "leaf", { leaf: null }),
    );
    expect(prepared).toMatchObject({
      ok: false,
      error: { kind: "workspace-changed", reason: "root" },
    });
    expect(checkpointState(runtime.metadata, "s", "leaf")).toBeUndefined();
    runtime.close();
  });

  it("treats the nearest recorded ancestor as authoritative", async () => {
    const { workspace, runtime } = await createRuntime();
    const parentBlob = await publishTestBlob(
      runtime.store,
      Buffer.from("parent"),
    );
    const parentTree = await publishTestTree(
      runtime.store,
      [
        {
          path: "file.txt",
          type: "regular",
          blobOid: parentBlob,
          recreationMode: 0o600,
        },
      ],
      TEST_SCOPE,
    );
    const leafBlob = await publishTestBlob(runtime.store, Buffer.from("leaf"));
    const leafTree = await publishTestTree(
      runtime.store,
      [
        {
          path: "file.txt",
          type: "regular",
          blobOid: leafBlob,
          recreationMode: 0o600,
        },
      ],
      TEST_SCOPE,
    );
    await mutateRuntimeMetadata(runtime, () => {
      commitTestNodeState(runtime.metadata, "s", "parent", parentTree);
      commitTestNodeState(runtime.metadata, "s", "leaf", leafTree);
    });
    await writeFile(join(workspace, "file.txt"), "current");
    await rm(
      nativeLooseRecordPath(
        nativeObjectLayout(runtime.storeRoot),
        "content",
        leafBlob,
      ),
    );

    const currentView = view(workspace, "leaf", {
      parent: null,
      leaf: "parent",
    });
    await expect(
      runtime.resolveReadableTreeIn(currentView, {
        sessionId: "s",
        entryId: "leaf",
      }),
    ).rejects.toThrow();
    expect(
      runtime.workspaceMutations.resolutionStillAuthoritative(
        currentView,
        { sessionId: "s", entryId: "leaf" },
        {
          treeOid: leafTree,
          foundAt: { sessionId: "s", entryId: "leaf" },
        },
      ),
    ).toBe(true);
    expect(checkpointState(runtime.metadata, "s", "parent")?.treeOid).toBe(
      parentTree,
    );
    runtime.close();
  });
});
