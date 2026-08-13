import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadCyclotomyConfig } from "../src/config.ts";
import {
  createCurrentMetadataStore,
  type CurrentMetadataStore,
} from "../src/infrastructure/metadata.ts";
import {
  openObjectStore,
  type ObjectStore,
} from "../src/infrastructure/object-store.ts";
import { acquireWorkspaceLock } from "../src/infrastructure/workspace-lock.ts";
import { scanWorkspace } from "../src/infrastructure/workspace-scan.ts";
import { registerCyclotomy } from "../src/pi/register.ts";
import {
  createDriftCommandHandler,
  createRestoreCommandHandler,
} from "../src/pi/commands.ts";
import { CyclotomyI18n, type MessageKey } from "../src/pi/i18n.ts";
import { registerCyclotomyLifecycle } from "../src/pi/lifecycle.ts";
import { CyclotomyRuntime } from "../src/pi/runtime.ts";
import { WorkspaceMutationAuthority } from "../src/pi/workspace-mutation-authority.ts";
import { FakePi, FakeSessionManager, type FakeEntry } from "./fake-pi.ts";
import {
  captureBarrier,
  checkpointIsBlocked,
  checkpointState,
  commitTestNodeState,
  protectTestLocation,
  readTestSessionRegistration,
  readTestSessionRegistrations,
  registerTestSession,
} from "./metadata-fixture.ts";
import { gitScope } from "./workspace-scope-fixture.ts";

let workspace: string;
let home: string;
let storeRoot: string;
let previousPiAgentDir: string | undefined;
const execFileAsync = promisify(execFile);
/** These tests fix the locale so wording stays a localization-test concern. */
const TEST_I18N = new CyclotomyI18n("zh-CN");

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "cyclotomy-pi-ws-"));
  home = await mkdtemp(join(tmpdir(), "cyclotomy-pi-home-"));
  previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = home;
  await mkdir(join(home, "cyclotomy"));
  await writeFile(
    join(home, "cyclotomy", "settings.json"),
    JSON.stringify({ locale: "zh-CN", gc: { intervalMs: 0 } }),
  );
  const hash = createHash("sha256")
    .update(await realpath(workspace))
    .digest("hex");
  storeRoot = join(home, "cyclotomy", hash);
});

afterEach(async () => {
  await FakePi.disposeAll();
  if (previousPiAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
  }
  await rm(workspace, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

function metadata(): CurrentMetadataStore {
  return createCurrentMetadataStore(metadataPath());
}

function metadataPath(): string {
  return join(storeRoot, "state.db");
}

async function preparedRuntime(): Promise<CyclotomyRuntime> {
  const runtime = new CyclotomyRuntime(
    loadCyclotomyConfig(home),
    new CyclotomyI18n("zh-CN"),
  );
  if (!(await runtime.ensureStore(workspace))) {
    throw new Error("failed to prepare test runtime metadata");
  }
  return runtime;
}

function registerPreparedRuntime(
  api: ExtensionAPI,
  runtime: CyclotomyRuntime,
): void {
  registerCyclotomyLifecycle(api, runtime);
  api.on("session_shutdown", async () => {
    runtime.retire();
    try {
      await runtime.drain();
    } finally {
      runtime.close();
    }
  });
  api.registerCommand("drift", {
    handler: createDriftCommandHandler(runtime),
  });
  api.registerCommand("restore", {
    handler: createRestoreCommandHandler(runtime),
  });
}

async function metadataFor(cwd: string): Promise<CurrentMetadataStore> {
  return createCurrentMetadataStore(await metadataPathFor(cwd));
}

async function metadataPathFor(cwd: string): Promise<string> {
  const hash = createHash("sha256")
    .update(await realpath(cwd))
    .digest("hex");
  return join(home, "cyclotomy", hash, "state.db");
}

/**
 * Lifecycle assertions name the message key, never its translation. Wording is
 * a presentation concern owned by the localization tests, so behavior tests
 * must survive a rewrite of either language.
 */
const SENTINEL = "CyclotomyTestSentinel";

function messageFor(key: MessageKey): string {
  // A template's text before its first placeholder identifies the key without
  // depending on the interpolated host detail. The sentinel must survive
  // `formatUiDetail`, which escapes control characters, so it stays ASCII.
  return TEST_I18N.t(key, {
    applied: SENTINEL,
    count: SENTINEL,
    message: SENTINEL,
    mutations: SENTINEL,
    preview: SENTINEL,
    problems: SENTINEL,
  }).split(SENTINEL)[0]!;
}

function notified(pi: FakePi, key: MessageKey): boolean {
  return pi.notifications.some(({ message }) =>
    message.includes(messageFor(key)),
  );
}

/** Bind a message key to the exact host detail it must interpolate. */
function notifiedWithDetail(
  pi: FakePi,
  key: MessageKey,
  detail: string,
): boolean {
  const rendered = TEST_I18N.t(key, { message: detail });
  return pi.notifications.some(({ message }) => message.includes(rendered));
}

/**
 * Assert on text Cyclotomy emits verbatim in every locale: paths, setting
 * names, command names, and preview action lines.
 */
function notifiedVerbatim(pi: FakePi, text: string): boolean {
  return pi.notifications.some(({ message }) => message.includes(text));
}

function failWorkspaceLockCleanup(
  operation: string,
  cause: Error,
): ReturnType<typeof vi.spyOn> {
  const original = CyclotomyRuntime.prototype.enqueueWorkspaceExecution;
  return vi
    .spyOn(CyclotomyRuntime.prototype, "enqueueWorkspaceExecution")
    .mockImplementation(function <T>(
      this: CyclotomyRuntime,
      candidate: string,
      action: () => Promise<T>,
    ) {
      const enqueue = original.bind(this) as (
        name: string,
        run: () => Promise<T>,
      ) => ReturnType<CyclotomyRuntime["enqueueWorkspaceExecution"]>;
      return enqueue(candidate, action).then((execution) =>
        candidate === operation
          ? {
              ...execution,
              cleanup: { kind: "failed" as const, cause },
            }
          : execution,
      );
    });
}

function lastStatus(pi: FakePi): string | undefined {
  return pi.statuses.get("cyclotomy");
}

/** Inject a renderer failure without disturbing unrelated lifecycle copy. */
function throwTranslations(...keys: MessageKey[]) {
  const original = CyclotomyI18n.prototype.t;
  const selected = new Set(keys);
  return vi.spyOn(CyclotomyI18n.prototype, "t").mockImplementation(function (
    this: CyclotomyI18n,
    key: MessageKey,
    variables?: Parameters<CyclotomyI18n["t"]>[1],
  ) {
    if (selected.has(key)) {
      throw new Error(`injected ${key} translation failure`);
    }
    return original.call(this, key, variables);
  });
}

async function workspaceAliasesCase(): Promise<boolean> {
  const lower = join(workspace, ".cyclotomy-case-probe");
  const upper = join(workspace, ".CYCLOTOMY-CASE-PROBE");
  await mkdir(lower);
  try {
    const observed = await lstat(lower);
    const alias = await lstat(upper).catch(() => undefined);
    return (
      alias !== undefined &&
      observed.dev === alias.dev &&
      observed.ino === alias.ino
    );
  } finally {
    await rm(lower, { recursive: true, force: true });
    await rm(upper, { recursive: true, force: true });
  }
}

async function spyOnReadTree() {
  const store = await openObjectStore(storeRoot);
  return vi.spyOn(
    Object.getPrototypeOf(store) as Pick<ObjectStore, "readTree">,
    "readTree",
  );
}

async function spyOnReadTreeManifest() {
  const store = await openObjectStore(storeRoot);
  return vi.spyOn(
    Object.getPrototypeOf(store) as Pick<ObjectStore, "readTreeManifest">,
    "readTreeManifest",
  );
}

async function twoStates(pi: FakePi) {
  await pi.startSession("startup");
  await writeFile(join(workspace, "a.txt"), "v1");
  await pi.endTurn();
  const first = pi.manager.getLeafId()!;
  await writeFile(join(workspace, "a.txt"), "v2");
  await pi.endTurn();
  const second = pi.manager.getLeafId()!;
  return { first, second };
}

async function leavePendingNoNodeAfterRestore(pi: FakePi): Promise<string> {
  const { first } = await twoStates(pi);
  pi.manager.setLeaf(first);
  const getLeafId = pi.manager.getLeafId.bind(pi.manager);
  let leafSpy: ReturnType<typeof vi.spyOn> | undefined;
  pi.selectHook = async () => {
    leafSpy = vi
      .spyOn(pi.manager, "getLeafId")
      .mockImplementation(() =>
        readFileSync(join(workspace, "a.txt"), "utf8") === "v1"
          ? null
          : getLeafId(),
      );
  };
  try {
    await pi.runCommand("restore");
  } finally {
    leafSpy?.mockRestore();
    pi.selectHook = undefined;
  }
  pi.manager.setLeaf(null);
  return first;
}

describe("checkpoint authority lifecycle", () => {
  describe("registration and configuration", () => {
    it("registers the three top-level commands", () => {
      const pi = new FakePi(workspace);

      registerCyclotomy(pi.api);

      expect(pi.registeredCommandNames()).toEqual([
        "cyclotomy",
        "drift",
        "restore",
      ]);
    });

    it("reports a new automatic GC failure after a successful recovery", async () => {
      const maybeRunAutomaticGc = vi
        .spyOn(CyclotomyRuntime.prototype, "maybeRunAutomaticGc")
        .mockRejectedValueOnce(new Error("first failure"))
        .mockRejectedValueOnce(new Error("repeated failure"))
        .mockResolvedValueOnce({
          kind: "completed",
          value: undefined,
          cleanup: { kind: "released" },
        })
        .mockRejectedValueOnce(new Error("new failure"));
      try {
        const pi = new FakePi(workspace);
        registerCyclotomy(pi.api);
        pi.manager.appendEntry();
        const failureCount = (): number =>
          pi.notifications.filter(({ message }) =>
            message.includes(messageFor("automaticGcFailed")),
          ).length;

        await pi.startSession("startup");
        expect(failureCount()).toBe(1);
        await pi.endTurn(0);
        expect(failureCount()).toBe(1);
        await pi.endTurn(0);
        expect(failureCount()).toBe(1);
        await pi.endTurn(0);
        expect(failureCount()).toBe(2);
      } finally {
        maybeRunAutomaticGc.mockRestore();
      }
    });

    it("keeps automatic GC failure presentation total", async () => {
      const maybeRunAutomaticGc = vi
        .spyOn(CyclotomyRuntime.prototype, "maybeRunAutomaticGc")
        .mockRejectedValue(new Error("injected automatic GC failure"));
      const rendering = throwTranslations("automaticGcFailed");
      try {
        const pi = new FakePi(workspace);
        registerCyclotomy(pi.api);
        pi.manager.appendEntry();

        await expect(pi.startSession("startup")).resolves.toBeUndefined();
        await expect(pi.endTurn(0)).resolves.toBeUndefined();

        expect(maybeRunAutomaticGc).toHaveBeenCalledTimes(2);
        expect(pi.notifications).toContainEqual({
          message:
            "Cyclotomy blocked this operation, but could not render its diagnostic message.",
          level: "warning",
        });
      } finally {
        rendering.mockRestore();
        maybeRunAutomaticGc.mockRestore();
      }
    });

    it("reports automatic-GC lock cleanup without rewriting the completed run", async () => {
      await writeFile(
        join(home, "cyclotomy", "settings.json"),
        JSON.stringify({ locale: "zh-CN", gc: { intervalMs: 1 } }),
      );
      const runtime = await preparedRuntime();
      const pi = new FakePi(workspace);
      registerPreparedRuntime(pi.api, runtime);
      pi.manager.appendEntry();
      const cleanupFailure = failWorkspaceLockCleanup(
        "auto-gc",
        new Error("automatic GC lock release failed"),
      );

      try {
        await pi.startSession("startup");
      } finally {
        cleanupFailure.mockRestore();
      }

      expect(notified(pi, "automaticGcFailed")).toBe(false);
      expect(
        pi.notifications.filter(({ message }) =>
          message.includes(messageFor("workspaceLockCleanupFailed")),
        ),
      ).toHaveLength(1);
    });

    it("refuses control data that overlaps the workspace", async () => {
      await writeFile(
        join(home, "cyclotomy", "settings.json"),
        JSON.stringify({
          storageDir: workspace,
          locale: "zh-CN",
          gc: { intervalMs: 0 },
        }),
      );
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      pi.manager.appendEntry();
      await writeFile(join(workspace, "user.txt"), "untouched");

      await pi.startSession("startup");

      expect(notified(pi, "initFailure")).toBe(true);
      expect(await readFile(join(workspace, "user.txt"), "utf8")).toBe(
        "untouched",
      );
      await expect(
        stat(join(workspace, basename(storeRoot))),
      ).rejects.toThrow();
    });

    it("ignores unknown workspace settings during registration", async () => {
      await mkdir(storeRoot, { recursive: true });
      await writeFile(
        join(storeRoot, "settings.json"),
        JSON.stringify({ futureWorkspaceSetting: { enabled: true } }),
      );
      await writeFile(join(workspace, "user.txt"), "untouched");
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const leaf = pi.manager.appendEntry();

      await pi.startSession("startup");
      await pi.endTurn(0);

      expect(notified(pi, "initFailure")).toBe(false);
      expect(await readFile(join(workspace, "user.txt"), "utf8")).toBe(
        "untouched",
      );
      const db = metadata();
      expect(checkpointState(db, pi.manager.sessionId, leaf.id)).toBeDefined();
      db.close();
    });

    it("disables itself instead of failing Pi's extension load", async () => {
      // Pi exits when an extension factory throws, so an unusable global file
      // must leave the host fully working with checkpointing turned off.
      await writeFile(
        join(home, "cyclotomy", "settings.json"),
        JSON.stringify({ maxFileMiB: -1 }),
      );
      await writeFile(join(workspace, "user.txt"), "untouched");
      const pi = new FakePi(workspace);

      expect(() => registerCyclotomy(pi.api)).not.toThrow();
      expect(pi.registeredCommandNames()).toEqual([
        "cyclotomy",
        "drift",
        "restore",
      ]);

      pi.manager.appendEntry();
      await pi.startSession("startup");

      // A rejected global file discards its locale, so this runtime reports in
      // the auto-detected language. Assert only on verbatim text.
      expect(notifiedVerbatim(pi, "settings.json")).toBe(true);
      expect(notifiedVerbatim(pi, "maxFileMiB")).toBe(true);
      expect(notifiedVerbatim(pi, "/cyclotomy resume")).toBe(true);

      // A completed turn must neither throw nor record any checkpoint.
      await expect(pi.endTurn()).resolves.toBeUndefined();
      await expect(stat(storeRoot)).rejects.toThrow();

      // Explicit commands still answer with the actionable configuration detail
      // rather than a blocked-session identity message.
      pi.notifications.length = 0;
      await pi.runCommand("drift");
      await pi.runCommand("restore");
      expect(pi.notifications).toHaveLength(2);
      expect(notifiedVerbatim(pi, "maxFileMiB")).toBe(true);
      expect(notified(pi, "sessionIdentityUnavailable")).toBe(false);

      expect(await readFile(join(workspace, "user.txt"), "utf8")).toBe(
        "untouched",
      );
    });
  });

  describe("session start, reload, and turn capture", () => {
    it("materializes the first observed concrete startup node and reload stays read-only", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await writeFile(join(workspace, "a.txt"), "incoming");
      const leaf = pi.manager.appendEntry();

      await pi.startSession("startup");
      let db = metadata();
      expect(checkpointState(db, pi.manager.sessionId, leaf.id)).toBeDefined();
      db.close();
      await pi.endTurn(0);
      db = metadata();
      const saved = checkpointState(db, pi.manager.sessionId, leaf.id);
      db.close();
      await writeFile(join(workspace, "a.txt"), "external");
      await pi.replaceRuntime(registerCyclotomy, "reload");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("external");
      db = metadata();
      expect(checkpointState(db, pi.manager.sessionId, leaf.id)).toEqual(saved);
      db.close();
      expect(notified(pi, "reloadProtected")).toBe(true);
    });

    it("keeps a completed reload admission when only lock cleanup fails", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const leaf = pi.manager.appendEntry();
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.startSession("startup");
      const before = metadata();
      const saved = checkpointState(before, pi.manager.sessionId, leaf.id)!;
      expect(checkpointIsBlocked(before, pi.manager.sessionId, leaf.id)).toBe(
        false,
      );
      before.close();
      pi.notifications.length = 0;
      const cleanupFailure = failWorkspaceLockCleanup(
        "reload-reconcile",
        new Error("reload lock release failed"),
      );

      try {
        await pi.replaceRuntime(registerCyclotomy, "reload");
      } finally {
        cleanupFailure.mockRestore();
      }

      const after = metadata();
      expect(checkpointState(after, pi.manager.sessionId, leaf.id)).toEqual(
        saved,
      );
      expect(checkpointIsBlocked(after, pi.manager.sessionId, leaf.id)).toBe(
        false,
      );
      after.close();
      expect(notified(pi, "reloadProtected")).toBe(false);
      expect(notified(pi, "captureLaterFailed")).toBe(false);
      expect(
        pi.notifications.filter(({ message }) =>
          message.includes(messageFor("workspaceLockCleanupFailed")),
        ),
      ).toHaveLength(1);
    });

    it("keeps a completed barrier projection when only lock cleanup fails", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const leaf = pi.manager.appendEntry();
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.startSession("startup");
      const sessionFile = pi.manager.getSessionFile()!;
      const before = metadata();
      expect(
        before.raiseSessionBarrier({
          sessionId: pi.manager.sessionId,
          sessionFile,
        }),
      ).toBe(true);
      before.close();
      pi.notifications.length = 0;
      const cleanupFailure = failWorkspaceLockCleanup(
        "project-session-capture-barrier",
        new Error("barrier projection lock release failed"),
      );

      try {
        await pi.emitContext();
      } finally {
        cleanupFailure.mockRestore();
      }

      const after = metadata();
      expect(checkpointIsBlocked(after, pi.manager.sessionId, leaf.id)).toBe(
        true,
      );
      expect(captureBarrier(after, pi.manager.sessionId, sessionFile)).toBe(
        false,
      );
      after.close();
      expect(notified(pi, "captureLaterFailed")).toBe(false);
      expect(
        pi.notifications.filter(({ message }) =>
          message.includes(messageFor("workspaceLockCleanupFailed")),
        ),
      ).toHaveLength(1);
    });

    it("reports reload protection when a concurrent exact state makes its pin stale", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const leaf = pi.manager.appendEntry();
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "external");
      pi.notifications.length = 0;

      const replacement = await preparedRuntime();
      const replacementMetadata = replacement.metadata;
      const concurrentTreeOid = "f".repeat(64);
      const original =
        replacementMetadata.protectLocation.bind(replacementMetadata);
      const raced = vi
        .spyOn(replacementMetadata, "protectLocation")
        .mockImplementationOnce((input) => {
          const concurrent = metadata();
          try {
            commitTestNodeState(
              concurrent,
              input.identity.sessionId,
              input.entryId,
              concurrentTreeOid,
              pi.manager.getSessionFile(),
            );
          } finally {
            concurrent.close();
          }
          return original(input);
        });

      try {
        await pi.replaceRuntime(
          (api) => registerPreparedRuntime(api, replacement),
          "reload",
        );
      } finally {
        raced.mockRestore();
      }

      const db = metadata();
      expect(checkpointState(db, pi.manager.sessionId, leaf.id)?.treeOid).toBe(
        concurrentTreeOid,
      );
      expect(checkpointIsBlocked(db, pi.manager.sessionId, leaf.id)).toBe(true);
      db.close();
      expect(notified(pi, "reloadProtected")).toBe(true);
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("external");
    });

    it("reports a guard installed between missing authority and reload admission", async () => {
      const pi = new FakePi(workspace);
      const runtime = await preparedRuntime();
      registerPreparedRuntime(pi.api, runtime);
      const leaf = pi.manager.appendEntry();
      const original = runtime.workspaceMutations.admitCurrentLocation.bind(
        runtime.workspaceMutations,
      );
      const raced = vi
        .spyOn(runtime.workspaceMutations, "admitCurrentLocation")
        .mockImplementationOnce((view) => {
          const concurrent = metadata();
          try {
            expect(
              protectTestLocation(
                concurrent,
                {
                  sessionId: pi.manager.sessionId,
                  sessionFile: pi.manager.getSessionFile()!,
                },
                leaf.id,
              ).kind,
            ).toBe("protected");
          } finally {
            concurrent.close();
          }
          return original(view);
        });

      try {
        await pi.startSession("reload");
      } finally {
        raced.mockRestore();
      }

      const db = metadata();
      expect(
        checkpointState(db, pi.manager.sessionId, leaf.id),
      ).toBeUndefined();
      expect(checkpointIsBlocked(db, pi.manager.sessionId, leaf.id)).toBe(true);
      db.close();
      expect(notified(pi, "sessionMissingProtected")).toBe(true);
    });

    it("durably protects a missing arrival reached while reload reconciliation is yielding", async () => {
      const firstHost = new FakePi(workspace);
      const initialRuntime = await preparedRuntime();
      registerPreparedRuntime(firstHost.api, initialRuntime);
      await writeFile(join(workspace, "a.txt"), "ancestor");
      const ancestor = firstHost.manager.appendEntry();
      await firstHost.startSession("startup");
      firstHost.manager.setLeaf(null);
      const missingArrival = firstHost.manager.appendEntry();

      firstHost.manager.setLeaf(ancestor.id);
      await writeFile(join(workspace, "a.txt"), "ambiguous");
      const replacement = await preparedRuntime();
      const original = replacement.registrations.workspaceStillBound.bind(
        replacement.registrations,
      );
      const raced = vi
        .spyOn(replacement.registrations, "workspaceStillBound")
        .mockImplementationOnce(async (root: string) => {
          const bound = await original(root);
          // Registration uses its own final binding gate. Race the first
          // yielded reload-reconciliation gate this test intends to exercise.
          firstHost.manager.setLeaf(missingArrival.id);
          return bound;
        });

      try {
        await firstHost.replaceRuntime(
          (api) => registerPreparedRuntime(api, replacement),
          "reload",
        );
      } finally {
        raced.mockRestore();
      }

      let db = metadata();
      expect(
        checkpointState(db, firstHost.manager.sessionId, missingArrival.id),
      ).toBeUndefined();
      expect(
        checkpointIsBlocked(db, firstHost.manager.sessionId, missingArrival.id),
      ).toBe(true);
      db.close();

      const persistedSession = firstHost.manager;
      await firstHost.dispose();
      const restarted = new FakePi(workspace);
      restarted.manager = persistedSession;
      registerCyclotomy(restarted.api);
      await restarted.startSession("startup");

      db = metadata();
      expect(
        checkpointState(db, restarted.manager.sessionId, missingArrival.id),
      ).toBeUndefined();
      expect(
        checkpointIsBlocked(db, restarted.manager.sessionId, missingArrival.id),
      ).toBe(true);
      db.close();
      expect(notified(restarted, "sessionMissingProtected")).toBe(true);
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "ambiguous",
      );
    });

    it.each(["startup", "new", "resume"] as const)(
      "%s materializes a genuine missing concrete anchor",
      async (reason) => {
        const pi = new FakePi(workspace);
        registerCyclotomy(pi.api);
        const leaf = pi.manager.appendEntry();
        await writeFile(join(workspace, "a.txt"), reason);

        await pi.startSession(reason);

        const db = metadata();
        expect(
          checkpointState(db, pi.manager.sessionId, leaf.id),
        ).toBeDefined();
        db.close();
        expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(reason);
      },
    );

    it.each(["prepare", "commit"] as const)(
      "durably protects a fresh loaded anchor when first checkpoint %s fails",
      async (phase) => {
        const pi = new FakePi(workspace);
        const runtime = await preparedRuntime();
        registerPreparedRuntime(pi.api, runtime);
        const leaf = pi.manager.appendEntry();
        await writeFile(join(workspace, "a.txt"), "unassigned");
        const failure =
          phase === "prepare"
            ? vi
                .spyOn(runtime.checkpoints, "prepareCurrent")
                .mockResolvedValueOnce({
                  ok: false,
                  error: {
                    kind: "publish-failed",
                    cause: new Error("injected publication failure"),
                  },
                })
            : vi
                .spyOn(runtime.metadata, "commitCapture")
                .mockImplementationOnce(() => {
                  throw new Error("injected metadata failure");
                });

        try {
          await pi.startSession("startup");
        } finally {
          failure.mockRestore();
        }

        const db = metadata();
        expect(
          checkpointState(db, pi.manager.sessionId, leaf.id),
        ).toBeUndefined();
        expect(checkpointIsBlocked(db, pi.manager.sessionId, leaf.id)).toBe(
          true,
        );
        db.close();
        expect(notified(pi, "captureLaterFailed")).toBe(true);
      },
    );

    it("protects the actual loaded arrival when the confirmation moves", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first, second } = await twoStates(pi);
      await writeFile(join(workspace, "a.txt"), "kept-current");
      pi.selectDestructive = false;
      pi.selectHook = async () => {
        pi.manager.setLeaf(first);
      };

      await pi.replaceRuntime(registerCyclotomy, "resume");

      const db = metadata();
      expect(checkpointIsBlocked(db, pi.manager.sessionId, second)).toBe(true);
      expect(checkpointIsBlocked(db, pi.manager.sessionId, first)).toBe(true);
      db.close();
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "kept-current",
      );
    });

    it("retries durable arrival recovery when reload queue control fails", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const leaf = pi.manager.appendEntry();
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "external");
      const queueFailure = vi
        .spyOn(CyclotomyRuntime.prototype, "enqueueWorkspaceExecution")
        .mockRejectedValueOnce(new Error("injected reload queue failure"));

      try {
        await pi.replaceRuntime(registerCyclotomy, "reload");
      } finally {
        queueFailure.mockRestore();
      }

      const db = metadata();
      expect(checkpointIsBlocked(db, pi.manager.sessionId, leaf.id)).toBe(true);
      db.close();
      expect(notified(pi, "reloadProtected")).toBe(true);
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("external");
    });

    it("preserves a guard installed after fresh-node preparation", async () => {
      const pi = new FakePi(workspace);
      const runtime = await preparedRuntime();
      registerPreparedRuntime(pi.api, runtime);
      const leaf = pi.manager.appendEntry();
      await writeFile(join(workspace, "a.txt"), "unassigned");

      const metadataStore = runtime.metadata;
      const original = metadataStore.commitCapture.bind(metadataStore);
      const raced = vi
        .spyOn(metadataStore, "commitCapture")
        .mockImplementationOnce((input) => {
          expect(input.expectedSlot).toEqual({ kind: "open-missing" });
          const concurrent = metadata();
          try {
            expect(
              protectTestLocation(concurrent, input.identity, input.entryId)
                .kind,
            ).toBe("protected");
          } finally {
            concurrent.close();
          }
          return original(input);
        });

      try {
        await pi.startSession("startup");
      } finally {
        raced.mockRestore();
      }

      let db = metadata();
      expect(
        checkpointState(db, pi.manager.sessionId, leaf.id),
      ).toBeUndefined();
      expect(checkpointIsBlocked(db, pi.manager.sessionId, leaf.id)).toBe(true);
      db.close();
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "unassigned",
      );
      expect(notified(pi, "sessionMissingProtected")).toBe(true);

      await pi.endTurn(0);
      db = metadata();
      expect(
        checkpointState(db, pi.manager.sessionId, leaf.id),
      ).toBeUndefined();
      expect(checkpointIsBlocked(db, pi.manager.sessionId, leaf.id)).toBe(true);
      db.close();
    });

    it("does not admit a different arrival after fresh checkpoint initialization", async () => {
      const pi = new FakePi(workspace);
      const runtime = await preparedRuntime();
      registerPreparedRuntime(pi.api, runtime);
      const intended = pi.manager.appendEntry();
      pi.manager.setLeaf(null);
      const lateArrival = pi.manager.appendEntry();
      pi.manager.setLeaf(intended.id);
      await writeFile(join(workspace, "a.txt"), "first-observation");

      const metadataStore = runtime.metadata;
      const original = metadataStore.commitCapture.bind(metadataStore);
      const raced = vi
        .spyOn(metadataStore, "commitCapture")
        .mockImplementationOnce((input) => {
          expect(input.entryId).toBe(intended.id);
          expect(input.expectedSlot).toEqual({ kind: "open-missing" });
          const result = original(input);
          pi.manager.setLeaf(lateArrival.id);
          return result;
        });

      try {
        await pi.startSession("startup");
      } finally {
        raced.mockRestore();
      }

      let db = metadata();
      expect(
        checkpointState(db, pi.manager.sessionId, intended.id),
      ).toBeDefined();
      expect(
        checkpointState(db, pi.manager.sessionId, lateArrival.id),
      ).toBeUndefined();
      expect(
        checkpointIsBlocked(db, pi.manager.sessionId, lateArrival.id),
      ).toBe(true);
      db.close();
      expect(notified(pi, "checkpointInitializedConflictProtected")).toBe(true);
      expect(notified(pi, "restoreInitialized")).toBe(false);

      await pi.endTurn(0);
      db = metadata();
      expect(
        checkpointState(db, pi.manager.sessionId, lateArrival.id),
      ).toBeUndefined();
      expect(
        checkpointIsBlocked(db, pi.manager.sessionId, lateArrival.id),
      ).toBe(true);
      db.close();
    });

    it("does not invent a node for an empty session or materialize on reload", async () => {
      const empty = new FakePi(workspace);
      registerCyclotomy(empty.api);
      await writeFile(join(workspace, "a.txt"), "empty");
      await empty.startSession("startup");
      let db = metadata();
      expect(db.listReferencedTreeOids()).toEqual([]);
      db.close();

      const leaf = empty.manager.appendEntry();
      await empty.replaceRuntime(registerCyclotomy, "reload");
      db = metadata();
      expect(
        checkpointState(db, empty.manager.sessionId, leaf.id),
      ).toBeUndefined();
      db.close();
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("empty");
    });

    it.each([
      ["startup", "barrier-read"],
      ["startup", "admission"],
      ["reload", "barrier-read"],
      ["reload", "admission"],
    ] as const)(
      "reports unavailable protection when node-free %s %s and recovery both fail",
      async (reason, fault) => {
        const pi = new FakePi(workspace);
        registerCyclotomy(pi.api);
        await pi.startSession("startup");
        pi.notifications.length = 0;
        const replacement = await preparedRuntime();

        const primary =
          fault === "barrier-read"
            ? vi
                .spyOn(replacement.metadata, "hasSessionBarrier")
                .mockImplementation(() => {
                  throw new Error("injected session barrier read failure");
                })
            : vi
                .spyOn(replacement.workspaceMutations, "admitCurrentLocation")
                .mockImplementation(() => {
                  throw new Error("injected node-free admission failure");
                });
        const recovery = vi
          .spyOn(replacement.metadata, "raiseSessionBarrier")
          .mockImplementation(() => {
            throw new Error("injected session barrier write failure");
          });

        try {
          await expect(
            pi.replaceRuntime(
              (api) => registerPreparedRuntime(api, replacement),
              reason,
            ),
          ).resolves.toBeUndefined();
        } finally {
          recovery.mockRestore();
          primary.mockRestore();
        }

        const unavailable = pi.notifications.find(({ message }) =>
          message.includes(messageFor("arrivalProtectionUnavailable")),
        );
        expect(unavailable?.level).toBe("error");
        expect(await pi.submitInput("still-unassigned")).toBe("handled");
      },
    );

    it("reports both a turn capture failure and unavailable recovery", async () => {
      const pi = new FakePi(workspace);
      const runtime = await preparedRuntime();
      registerPreparedRuntime(pi.api, runtime);
      await pi.startSession("startup");
      const capture = vi
        .spyOn(runtime.checkpoints, "prepareCurrent")
        .mockResolvedValueOnce({
          ok: false,
          error: {
            kind: "publish-failed",
            cause: new Error("injected capture publication failure"),
          },
        });
      const exactProtection = vi
        .spyOn(runtime.metadata, "protectLocation")
        .mockImplementationOnce(() => {
          throw new Error("injected exact protection failure");
        });
      const barrierProtection = vi
        .spyOn(runtime.metadata, "raiseSessionBarrier")
        .mockImplementationOnce(() => {
          throw new Error("injected barrier protection failure");
        });

      try {
        await expect(pi.endTurn()).resolves.toBeUndefined();
      } finally {
        barrierProtection.mockRestore();
        exactProtection.mockRestore();
        capture.mockRestore();
      }

      expect(notified(pi, "captureLaterFailed")).toBe(true);
      const unavailable = pi.notifications.find(({ message }) =>
        message.includes(messageFor("arrivalProtectionUnavailable")),
      );
      expect(unavailable?.level).toBe("error");
    });

    it("durably protects a compacted arrival when store revalidation fails", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      pi.manager.appendEntry();
      await pi.startSession("startup");
      const ensureStore = vi
        .spyOn(CyclotomyRuntime.prototype, "ensureStore")
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      try {
        await expect(pi.compact()).resolves.toBe("done");
      } finally {
        ensureStore.mockRestore();
      }

      const compacted = pi.manager.getLeafId()!;
      const db = metadata();
      expect(
        checkpointState(db, pi.manager.sessionId, compacted),
      ).toBeDefined();
      expect(checkpointIsBlocked(db, pi.manager.sessionId, compacted)).toBe(
        true,
      );
      db.close();
      expect(notified(pi, "initFailure")).toBe(true);
    });

    it("anchors a missing active label at its stable parent", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const parent = pi.manager.appendEntry();
      const label = pi.manager.appendEntry({ type: "label" });
      await writeFile(join(workspace, "a.txt"), "label-state");

      await pi.startSession("startup");

      const db = metadata();
      expect(
        checkpointState(db, pi.manager.sessionId, parent.id),
      ).toBeDefined();
      expect(
        checkpointState(db, pi.manager.sessionId, label.id),
      ).toBeUndefined();
      db.close();
    });

    it("pins a successful inherited cold-start restore at its exact node", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "ancestor-state");
      await pi.endTurn();
      const ancestor = pi.manager.getLeafId()!;
      const child = pi.manager.appendEntry();
      await writeFile(join(workspace, "a.txt"), "incoming-current");

      await pi.replaceRuntime(registerCyclotomy, "resume");

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "ancestor-state",
      );
      const db = metadata();
      const ancestorState = checkpointState(db, pi.manager.sessionId, ancestor);
      expect(ancestorState).toBeDefined();
      expect(checkpointState(db, pi.manager.sessionId, child.id)).toEqual(
        ancestorState,
      );
      expect(checkpointIsBlocked(db, pi.manager.sessionId, child.id)).toBe(
        false,
      );
      db.close();
    });

    it("does not materialize malformed startup ancestry", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const first = pi.manager.appendEntry();
      const second = pi.manager.appendEntry();
      pi.manager.entries.set(first.id, { ...first, parentId: second.id });
      await writeFile(join(workspace, "a.txt"), "unowned");

      await pi.startSession("startup");

      await expect(lstat(storeRoot)).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        notifiedWithDetail(
          pi,
          "sessionRegistrationFailed",
          "Pi session contains a parent cycle",
        ),
      ).toBe(true);
    });

    it("does not accept metadata ancestry that references an unknown entry", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const leaf = pi.manager.appendEntry();
      pi.manager.entries.set(leaf.id, {
        ...leaf,
        parentId: "missing-parent",
      });

      await pi.startSession("startup");

      await expect(lstat(storeRoot)).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        notifiedWithDetail(
          pi,
          "sessionRegistrationFailed",
          "Pi session contains an orphaned parent reference",
        ),
      ).toBe(true);
    });

    it("startup asks before reconciling an existing node", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      await writeFile(join(workspace, "a.txt"), "current");

      pi.selectDestructive = false;
      await pi.replaceRuntime(registerCyclotomy, "startup");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("current");
      expect(pi.selections.at(-1)?.prompt).toContain(
        messageFor("choiceLoadedTitle"),
      );
      // The non-destructive choice must stay first and be Pi's initial pick.
      expect(pi.selections.at(-1)?.options).toEqual([
        messageFor("choiceLoadedSafe"),
        messageFor("choiceLoadedRestore"),
      ]);

      pi.selectDestructive = true;
      await pi.replaceRuntime(registerCyclotomy, "startup");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("saved");
    });

    it("settles a declined loaded arrival when checking status rendering throws", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      const loaded = pi.manager.getLeafId()!;
      await writeFile(join(workspace, "a.txt"), "kept-current");
      pi.selectDestructive = false;
      const rendering = throwTranslations("checkingWorkspace");

      try {
        await expect(
          pi.replaceRuntime(registerCyclotomy, "resume"),
        ).resolves.toBeUndefined();
      } finally {
        rendering.mockRestore();
      }

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "kept-current",
      );
      const db = metadata();
      expect(checkpointIsBlocked(db, pi.manager.sessionId, loaded)).toBe(true);
      db.close();
    });

    it("preserves a declined loaded node while checkpointing new work", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      const loaded = pi.manager.getLeafId()!;
      let db = metadata();
      const savedState = checkpointState(db, pi.manager.sessionId, loaded)!;
      db.close();
      await writeFile(join(workspace, "a.txt"), "kept-current");
      pi.selectDestructive = false;

      await pi.replaceRuntime(registerCyclotomy, "resume");
      expect(await pi.submitInput()).toBe("continued");
      const descendant = pi.manager.getLeafId()!;
      await pi.endTurn(0);

      db = metadata();
      expect(checkpointState(db, pi.manager.sessionId, loaded)).toEqual(
        savedState,
      );
      expect(checkpointIsBlocked(db, pi.manager.sessionId, loaded)).toBe(true);
      expect(
        checkpointState(db, pi.manager.sessionId, descendant),
      ).toBeDefined();
      expect(checkpointIsBlocked(db, pi.manager.sessionId, descendant)).toBe(
        false,
      );
      db.close();
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "kept-current",
      );
    });

    it("does not restore a loaded session if the agent becomes busy in the dialog", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      await writeFile(join(workspace, "a.txt"), "current");
      pi.selectHook = async () => {
        pi.idle = false;
      };

      await pi.replaceRuntime(registerCyclotomy, "startup");

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("current");
      // Becoming busy invalidates the confirmed plan, so the apply phase reports
      // a changed location rather than a user cancellation.
      expect(notified(pi, "commandLocationChanged")).toBe(true);
    });

    it("protects the actual loaded arrival when cutover is rejected after staging", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      const loaded = pi.manager.getLeafId()!;
      await writeFile(join(workspace, "a.txt"), "current");

      const store = await openObjectStore(storeRoot);
      const prototype = Object.getPrototypeOf(store) as Pick<
        ObjectStore,
        "readBlob"
      >;
      const original = prototype.readBlob;
      let actualArrival: FakeEntry | undefined;
      const readBlob = vi
        .spyOn(prototype, "readBlob")
        .mockImplementation(async function (this: ObjectStore, oid: string) {
          const content = await original.call(this, oid);
          actualArrival ??= pi.manager.appendEntry();
          return content;
        });

      try {
        await pi.replaceRuntime(registerCyclotomy, "startup");
      } finally {
        readBlob.mockRestore();
      }

      expect(actualArrival).toBeDefined();
      expect(pi.manager.getLeafId()).toBe(actualArrival!.id);
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("current");
      expect(
        notifiedWithDetail(
          pi,
          "restoreNotStarted",
          "active location changed before workspace mutation",
        ),
      ).toBe(true);
      const db = metadata();
      expect(checkpointIsBlocked(db, pi.manager.sessionId, loaded)).toBe(true);
      expect(
        checkpointIsBlocked(db, pi.manager.sessionId, actualArrival!.id),
      ).toBe(true);
      db.close();
    });

    it("turn_end overwrites the active node's only state", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "one");
      const leaf = pi.manager.appendEntry();
      await pi.endTurn(0);
      let db = metadata();
      const first = checkpointState(db, pi.manager.sessionId, leaf.id)!;
      db.close();

      await writeFile(join(workspace, "a.txt"), "two");
      await pi.endTurn(0);
      db = metadata();
      const second = checkpointState(db, pi.manager.sessionId, leaf.id)!;
      db.close();
      expect(second.treeOid).not.toBe(first.treeOid);
    });

    it("keeps a completed turn checkpoint open when only lock cleanup fails", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "captured");
      const cleanupFailure = failWorkspaceLockCleanup(
        "capture-turn",
        new Error("capture lock release failed"),
      );

      try {
        await pi.endTurn();
      } finally {
        cleanupFailure.mockRestore();
      }

      const leaf = pi.manager.getLeafId()!;
      const db = metadata();
      expect(checkpointState(db, pi.manager.sessionId, leaf)).toBeDefined();
      expect(checkpointIsBlocked(db, pi.manager.sessionId, leaf)).toBe(false);
      db.close();
      expect(notified(pi, "captureLaterFailed")).toBe(false);
      expect(
        pi.notifications.filter(({ message }) =>
          message.includes(messageFor("workspaceLockCleanupFailed")),
        ),
      ).toHaveLength(1);
    });

    it("observes ordinary turn appends without rescanning the full Pi graph", async () => {
      const pi = new FakePi(workspace);
      const getEntries = vi.spyOn(pi.manager, "getEntries");
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      const fullReadsAfterRegistration = getEntries.mock.calls.length;

      pi.manager.appendEntry();
      await pi.endTurn(0);

      expect(getEntries).toHaveBeenCalledTimes(fullReadsAfterRegistration);
    });

    it("does not commit a turn capture after the active leaf changes", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "one");
      const capturedLeaf = pi.manager.appendEntry();
      await pi.endTurn(0);
      let db = metadata();
      const original = checkpointState(
        db,
        pi.manager.sessionId,
        capturedLeaf.id,
      )!;
      db.close();

      await writeFile(join(workspace, "a.txt"), "two");
      const store = await openObjectStore(storeRoot);
      const prototype = Object.getPrototypeOf(store) as {
        beginSnapshotPublication: ObjectStore["beginSnapshotPublication"];
      };
      const beginSnapshotPublication = prototype.beginSnapshotPublication;
      let advancedLeaf: FakeEntry | undefined;
      const publication = vi
        .spyOn(prototype, "beginSnapshotPublication")
        .mockImplementation(function (this: ObjectStore) {
          const candidate = beginSnapshotPublication.call(this);
          return {
            ...candidate,
            async publishTree(entries, scope) {
              const treeOid = await candidate.publishTree(entries, scope);
              // Pi persists the append-only session log before exposing the
              // new coordinate at a lifecycle boundary.
              advancedLeaf = pi.manager.appendEntry();
              await pi.persistSession();
              return treeOid;
            },
          };
        });
      try {
        await pi.endTurn(0);
      } finally {
        publication.mockRestore();
      }

      expect(advancedLeaf).toBeDefined();
      db = metadata();
      expect(
        checkpointState(db, pi.manager.sessionId, capturedLeaf.id),
      ).toEqual(original);
      expect(
        db.getCheckpointSlot(pi.manager.sessionId, advancedLeaf!.id),
      ).toEqual({
        kind: "blocked-checkpoint",
        treeOid: original.treeOid,
      });
      db.close();
      expect(notified(pi, "captureLaterFailed")).toBe(true);
    });
  });

  describe("the /drift and /restore command surface", () => {
    it("fails closed in preview when a manifest smuggles an ignored target entry", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      const leaf = pi.manager.appendEntry();
      const targetPath = join(workspace, "secret.txt");
      const targetBytes = Buffer.from("forged target", "utf8");
      const blobOid = createHash("sha256").update(targetBytes).digest("hex");
      await writeFile(targetPath, targetBytes);
      const store = await openObjectStore(storeRoot);
      const publication = store.beginSnapshotPublication();
      await publication.publishBlobFromFile(
        targetPath,
        blobOid,
        targetBytes.byteLength,
      );
      const treeOid = await publication.publishTree(
        [
          {
            path: "secret.txt",
            type: "regular",
            blobOid,
            recreationMode: 0o600,
          },
        ],
        gitScope({ globalExclude: "secret.txt\n" }),
      );
      await rm(targetPath);
      const db = metadata();
      commitTestNodeState(
        db,
        pi.manager.sessionId,
        leaf.id,
        treeOid,
        pi.manager.getSessionFile(),
      );
      db.close();
      const selectionsBefore = pi.selections.length;

      await pi.runCommand("drift");
      expect(
        notifiedWithDetail(
          pi,
          "commandFailed",
          "tree entry is excluded by its archived workspace scope: secret.txt",
        ),
      ).toBe(true);

      // The first operational failure retires Cyclotomy. Exercise the restore
      // presenter with a fresh runtime so both commands prove their own boundary.
      const restoreRuntime = await preparedRuntime();
      await pi.replaceRuntime(
        (api) => registerPreparedRuntime(api, restoreRuntime),
        "reload",
      );
      await pi.runCommand("restore");
      expect(
        notifiedWithDetail(
          pi,
          "restorePrepareFailed",
          "tree entry is excluded by its archived workspace scope: secret.txt",
        ),
      ).toBe(true);
      expect(pi.selections).toHaveLength(selectionsBefore);
      await expect(stat(targetPath)).rejects.toThrow();
    });

    it("reports drift without confirming or changing files or metadata", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      const leaf = pi.manager.getLeafId()!;
      const before = metadata();
      const stateBefore = checkpointState(before, pi.manager.sessionId, leaf);
      const sessionsBefore = readTestSessionRegistrations(metadataPath());
      const rootsBefore = before.listReferencedTreeOids();
      before.close();
      await writeFile(join(workspace, "a.txt"), "current");
      const selectionsBefore = pi.selections.length;

      await pi.runCommand("drift");

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("current");
      expect(pi.selections).toHaveLength(selectionsBefore);
      const driftMessage = pi.notifications.at(-1)?.message ?? "";
      expect(driftMessage).toContain("~ a.txt");
      expect(driftMessage).not.toMatch(
        /(?:session|entry|tree OID|\+0|~0|-0)/iu,
      );
      const after = metadata();
      expect(checkpointState(after, pi.manager.sessionId, leaf)).toEqual(
        stateBefore,
      );
      expect(readTestSessionRegistrations(metadataPath())).toEqual(
        sessionsBefore,
      );
      expect(after.listReferencedTreeOids()).toEqual(rootsBefore);
      after.close();
    });

    it("uses the checkpoint scope when Git ignoreCase drifts", async () => {
      await execFileAsync("git", ["-C", workspace, "init", "-q"]);
      await execFileAsync("git", [
        "-C",
        workspace,
        "config",
        "core.ignoreCase",
        "false",
      ]);
      await writeFile(join(workspace, ".gitignore"), "SECRET\n");
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await pi.endTurn();

      await execFileAsync("git", [
        "-C",
        workspace,
        "config",
        "core.ignoreCase",
        "true",
      ]);
      await writeFile(join(workspace, "secret"), "must be visible to target");

      await pi.runCommand("drift");
      expect(pi.notifications.at(-1)?.message).toContain("- secret");
      await pi.runCommand("restore");

      await expect(stat(join(workspace, "secret"))).rejects.toThrow();
    });

    it("restores a changed .gitignore through the checkpoint's original scope", async () => {
      await execFileAsync("git", ["-C", workspace, "init", "-q"]);
      await writeFile(join(workspace, ".gitignore"), "ignored.txt\n");
      await writeFile(join(workspace, "visible.txt"), "saved");
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await pi.endTurn();

      await writeFile(join(workspace, ".gitignore"), "visible.txt\n");
      await writeFile(join(workspace, "visible.txt"), "current");
      await writeFile(join(workspace, "ignored.txt"), "outside target scope");

      await pi.runCommand("drift");
      expect(pi.notifications.at(-1)?.message).toContain("~ .gitignore");
      expect(pi.notifications.at(-1)?.message).toContain("~ visible.txt");
      expect(pi.notifications.at(-1)?.message).not.toContain("ignored.txt");

      await pi.runCommand("restore");

      expect(await readFile(join(workspace, ".gitignore"), "utf8")).toBe(
        "ignored.txt\n",
      );
      expect(await readFile(join(workspace, "visible.txt"), "utf8")).toBe(
        "saved",
      );
      expect(await readFile(join(workspace, "ignored.txt"), "utf8")).toBe(
        "outside target scope",
      );
    });

    it("rejects non-empty drift arguments without changing state", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      const leaf = pi.manager.getLeafId()!;
      const before = metadata();
      const stateBefore = checkpointState(before, pi.manager.sessionId, leaf);
      const sessionsBefore = readTestSessionRegistrations(metadataPath());
      const rootsBefore = before.listReferencedTreeOids();
      before.close();
      await writeFile(join(workspace, "a.txt"), "current");
      const selectionsBefore = pi.selections.length;
      pi.statuses.set("cyclotomy", "stale navigation notice");

      await pi.runCommand("drift", "unexpected");

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("current");
      expect(pi.selections).toHaveLength(selectionsBefore);
      expect(pi.notifications.at(-1)?.message).toBe(messageFor("driftUsage"));
      expect(lastStatus(pi)).toBe("stale navigation notice");
      const after = metadata();
      expect(checkpointState(after, pi.manager.sessionId, leaf)).toEqual(
        stateBefore,
      );
      expect(readTestSessionRegistrations(metadataPath())).toEqual(
        sessionsBefore,
      );
      expect(after.listReferencedTreeOids()).toEqual(rootsBefore);
      after.close();
    });

    it("refuses restore while busy without confirming or changing state", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      const leaf = pi.manager.getLeafId()!;
      const before = metadata();
      const stateBefore = checkpointState(before, pi.manager.sessionId, leaf);
      const sessionsBefore = readTestSessionRegistrations(metadataPath());
      const rootsBefore = before.listReferencedTreeOids();
      before.close();
      await writeFile(join(workspace, "a.txt"), "current");
      const selectionsBefore = pi.selections.length;
      pi.idle = false;

      await pi.runCommand("restore");

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("current");
      expect(pi.selections).toHaveLength(selectionsBefore);
      expect(pi.notifications.at(-1)?.message).toBe(
        messageFor("waitIdleRestore"),
      );
      const after = metadata();
      expect(checkpointState(after, pi.manager.sessionId, leaf)).toEqual(
        stateBefore,
      );
      expect(readTestSessionRegistrations(metadataPath())).toEqual(
        sessionsBefore,
      );
      expect(after.listReferencedTreeOids()).toEqual(rootsBefore);
      after.close();
    });

    it("manual restore discards changes without creating another history", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      const leaf = pi.manager.getLeafId()!;
      const dbBefore = metadata();
      const stateBefore = checkpointState(
        dbBefore,
        pi.manager.sessionId,
        leaf,
      )!;
      dbBefore.close();
      await writeFile(join(workspace, "a.txt"), "unsaved");

      await pi.runCommand("restore");

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("saved");
      expect(pi.selections.at(-1)?.prompt).toContain(
        messageFor("choiceManualIntro"),
      );
      expect(pi.selections.at(-1)?.options).toEqual([
        messageFor("choiceManualSafe"),
        messageFor("choiceManualRestore"),
      ]);
      expect(
        pi.selections.at(-1)?.prompt.split("\n").length,
      ).toBeLessThanOrEqual(10);
      const dbAfter = metadata();
      expect(checkpointState(dbAfter, pi.manager.sessionId, leaf)).toEqual(
        stateBefore,
      );
      dbAfter.close();
      await writeFile(join(workspace, "a.txt"), "still-current");
      await pi.runCommand("restore", "--force");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "still-current",
      );
      expect(pi.notifications.at(-1)?.message).toContain("/restore");
    });

    it("does not apply a restore after its preparation lock cleanup fails", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      const leaf = pi.manager.getLeafId()!;
      await writeFile(join(workspace, "a.txt"), "current");
      const selectionsBefore = pi.selections.length;
      const cleanupFailure = failWorkspaceLockCleanup(
        "manual-restore-prepare",
        new Error("restore preparation lock release failed"),
      );

      try {
        await pi.runCommand("restore");
      } finally {
        cleanupFailure.mockRestore();
      }

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("current");
      expect(pi.selections).toHaveLength(selectionsBefore);
      const db = metadata();
      expect(checkpointIsBlocked(db, pi.manager.sessionId, leaf)).toBe(true);
      db.close();
      expect(notified(pi, "workspaceLockCleanupFailed")).toBe(true);
      await pi.runCommand("cyclotomy");
      expect(notified(pi, "cyclotomyStoppedWithError")).toBe(true);
    });

    it("does not widen a rejected metadata pin into post-mutation protection", async () => {
      const pi = new FakePi(workspace);
      const runtime = await preparedRuntime();
      registerPreparedRuntime(pi.api, runtime);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      const leaf = pi.manager.getLeafId()!;
      const before = metadata();
      const slotBefore = before.getCheckpointSlot(pi.manager.sessionId, leaf);
      before.close();
      expect(slotBefore.kind).toBe("open-checkpoint");
      await writeFile(join(workspace, "a.txt"), "current");
      const failed = vi
        .spyOn(runtime.metadata, "protectLocation")
        .mockImplementationOnce(() => {
          throw new Error("metadata pin failed");
        });

      try {
        await pi.runCommand("restore");
      } finally {
        failed.mockRestore();
      }

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("current");
      expect(
        notifiedWithDetail(pi, "restoreNotStarted", "metadata pin failed"),
      ).toBe(true);
      expect(notified(pi, "restorePostMutationControlProtected")).toBe(false);
      const db = metadata();
      expect(db.getCheckpointSlot(pi.manager.sessionId, leaf)).toEqual(
        slotBefore,
      );
      db.close();
    });

    it("does not block a manual restore target rejected after staging", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      const leaf = pi.manager.getLeafId()!;
      const before = metadata();
      const slotBefore = before.getCheckpointSlot(pi.manager.sessionId, leaf);
      before.close();
      if (slotBefore.kind !== "open-checkpoint") {
        throw new Error("manual restore fixture has no open checkpoint");
      }
      await writeFile(join(workspace, "a.txt"), "current");

      const store = await openObjectStore(storeRoot);
      const prototype = Object.getPrototypeOf(store) as Pick<
        ObjectStore,
        "readBlob"
      >;
      const original = prototype.readBlob;
      const readBlob = vi
        .spyOn(prototype, "readBlob")
        .mockImplementation(async function (this: ObjectStore, oid: string) {
          const content = await original.call(this, oid);
          pi.idle = false;
          return content;
        });

      try {
        await pi.runCommand("restore");
      } finally {
        readBlob.mockRestore();
        pi.idle = true;
      }

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("current");
      expect(
        notifiedWithDetail(
          pi,
          "restoreNotStarted",
          "Pi became busy before workspace mutation",
        ),
      ).toBe(true);
      expect(notified(pi, "restorePostMutationControlProtected")).toBe(false);
      const after = metadata();
      expect(after.getCheckpointSlot(pi.manager.sessionId, leaf)).toEqual(
        slotBefore,
      );
      after.close();
    });

    it("preserves a completed manual outcome when the workspace operation rejects afterward", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first } = await twoStates(pi);
      const before = metadata();
      const firstState = checkpointState(before, pi.manager.sessionId, first)!;
      before.close();
      pi.manager.setLeaf(first);

      const releaseFailure = failWorkspaceLockCleanup(
        "manual-restore-apply",
        new Error("workspace lock release failed"),
      );

      try {
        await pi.runCommand("restore");
      } finally {
        releaseFailure.mockRestore();
      }

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v1");
      expect(
        notifiedWithDetail(
          pi,
          "restorePostMutationControlProtected",
          "workspace lock release failed",
        ),
      ).toBe(true);
      expect(notified(pi, "restoreSuccessOne")).toBe(true);
      expect(notified(pi, "restoreExecutionFailed")).toBe(false);
      const db = metadata();
      expect(checkpointState(db, pi.manager.sessionId, first)).toEqual(
        firstState,
      );
      expect(checkpointIsBlocked(db, pi.manager.sessionId, first)).toBe(true);
      db.close();
    });

    it("rejects an inactive graph rewrite before manual restore mutation", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first, second } = await twoStates(pi);
      pi.manager.setLeaf(first);
      const inactive = pi.manager.appendEntry();
      pi.manager.setLeaf(first);
      pi.selectHook = async () => {
        const entry = pi.manager.entries.get(inactive.id)!;
        pi.manager.entries.set(inactive.id, {
          ...entry,
          parentId: second,
        });
      };

      await pi.runCommand("restore");

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v2");
      expect(notified(pi, "commandLocationChanged")).toBe(true);
      expect(notified(pi, "restoreSuccessOne")).toBe(false);
    });

    it("protects a late manual arrival after a verified restore mutation", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first, second } = await twoStates(pi);
      const before = metadata();
      const firstState = checkpointState(before, pi.manager.sessionId, first)!;
      const secondState = checkpointState(
        before,
        pi.manager.sessionId,
        second,
      )!;
      before.close();
      pi.manager.setLeaf(first);
      let leafSpy: ReturnType<typeof vi.spyOn> | undefined;
      pi.selectHook = async () => {
        const getLeafId = pi.manager.getLeafId.bind(pi.manager);
        leafSpy = vi
          .spyOn(pi.manager, "getLeafId")
          .mockImplementation(() =>
            readFileSync(join(workspace, "a.txt"), "utf8") === "v1"
              ? second
              : getLeafId(),
          );
      };

      try {
        await pi.runCommand("restore");

        expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v1");
        expect(notified(pi, "restorePostMutationLocationBarrier")).toBe(true);
        expect(notified(pi, "commandLocationChanged")).toBe(false);
        let db = metadata();
        expect(checkpointState(db, pi.manager.sessionId, first)).toEqual(
          firstState,
        );
        expect(checkpointIsBlocked(db, pi.manager.sessionId, first)).toBe(true);
        expect(checkpointState(db, pi.manager.sessionId, second)).toEqual(
          secondState,
        );
        // The public observation tore while identifying the arrival, so no
        // exact second coordinate is guessed; the session barrier protects
        // whichever complete concrete ancestry is observed next.
        expect(checkpointIsBlocked(db, pi.manager.sessionId, second)).toBe(
          false,
        );
        expect(
          captureBarrier(
            db,
            pi.manager.sessionId,
            pi.manager.getSessionFile()!,
          ),
        ).toBe(true);
        db.close();

        await pi.endTurn(0);
        db = metadata();
        expect(checkpointState(db, pi.manager.sessionId, second)).toEqual(
          secondState,
        );
        expect(checkpointIsBlocked(db, pi.manager.sessionId, second)).toBe(
          false,
        );
        expect(
          captureBarrier(
            db,
            pi.manager.sessionId,
            pi.manager.getSessionFile()!,
          ),
        ).toBe(true);
        db.close();

        leafSpy?.mockRestore();
        leafSpy = undefined;
        pi.manager.setLeaf(second);
        await pi.runCommand("restore");
        expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v2");
        db = metadata();
        expect(checkpointState(db, pi.manager.sessionId, second)).toEqual(
          secondState,
        );
        expect(checkpointIsBlocked(db, pi.manager.sessionId, second)).toBe(
          false,
        );
        db.close();
      } finally {
        leafSpy?.mockRestore();
      }
    });

    it("protects a late manual arrival after a partial restore", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first, second } = await twoStates(pi);
      const before = metadata();
      const firstState = checkpointState(before, pi.manager.sessionId, first)!;
      const secondState = checkpointState(
        before,
        pi.manager.sessionId,
        second,
      )!;
      before.close();
      const extra = join(workspace, "extra.txt");
      await writeFile(extra, "observed");
      pi.manager.setLeaf(first);
      const statePath = join(workspace, "a.txt");
      const getLeafId = pi.manager.getLeafId.bind(pi.manager);
      const leafSpy = vi
        .spyOn(pi.manager, "getLeafId")
        .mockImplementation(() =>
          readFileSync(statePath, "utf8") === "raced" ? second : getLeafId(),
        );
      let commandFinished = false;
      const raceLaterPath = async (): Promise<void> => {
        const deadline = Date.now() + 30_000;
        while (
          await lstat(extra).then(
            () => true,
            () => false,
          )
        ) {
          if (commandFinished) {
            throw new Error("restore finished before its first mutation");
          }
          if (Date.now() >= deadline) {
            throw new Error("restore did not reach its first mutation");
          }
          await new Promise<void>((resolveWait) => setImmediate(resolveWait));
        }
        // Deleting the extra path is the first committed mutation. Race the
        // later regular-file rewrite during its asynchronous staged-blob read,
        // so apply must report a genuine partial result and the public Pi view
        // changes only after mutation authority has already been consumed.
        await writeFile(statePath, "raced");
      };

      try {
        await Promise.all([
          pi.runCommand("restore").finally(() => {
            commandFinished = true;
          }),
          raceLaterPath(),
        ]);

        expect(await readFile(statePath, "utf8")).toBe("raced");
        await expect(lstat(extra)).rejects.toMatchObject({ code: "ENOENT" });
        expect(pi.notifications.map(({ message }) => message)).toEqual(
          expect.arrayContaining([
            expect.stringContaining(messageFor("restoreApplyIncomplete")),
          ]),
        );
        expect(notified(pi, "restorePostMutationLocationBarrier")).toBe(true);
        let db = metadata();
        expect(checkpointState(db, pi.manager.sessionId, first)).toEqual(
          firstState,
        );
        expect(checkpointIsBlocked(db, pi.manager.sessionId, first)).toBe(true);
        expect(checkpointState(db, pi.manager.sessionId, second)).toEqual(
          secondState,
        );
        expect(checkpointIsBlocked(db, pi.manager.sessionId, second)).toBe(
          false,
        );
        expect(
          captureBarrier(
            db,
            pi.manager.sessionId,
            pi.manager.getSessionFile()!,
          ),
        ).toBe(true);
        db.close();

        await pi.endTurn(0);
        db = metadata();
        expect(checkpointState(db, pi.manager.sessionId, second)).toEqual(
          secondState,
        );
        expect(checkpointIsBlocked(db, pi.manager.sessionId, second)).toBe(
          false,
        );
        expect(
          captureBarrier(
            db,
            pi.manager.sessionId,
            pi.manager.getSessionFile()!,
          ),
        ).toBe(true);
        db.close();
      } finally {
        commandFinished = true;
        leafSpy.mockRestore();
      }
    });

    it("reports when a post-mutation arrival cannot be authenticated", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first } = await twoStates(pi);
      const before = metadata();
      const firstState = checkpointState(before, pi.manager.sessionId, first)!;
      before.close();
      pi.manager.setLeaf(first);
      let sessionSpy: ReturnType<typeof vi.spyOn> | undefined;
      pi.selectHook = async () => {
        const getSessionId = pi.manager.getSessionId.bind(pi.manager);
        sessionSpy = vi
          .spyOn(pi.manager, "getSessionId")
          .mockImplementation(() =>
            readFileSync(join(workspace, "a.txt"), "utf8") === "v1"
              ? "unregistered-session"
              : getSessionId(),
          );
      };

      try {
        await pi.runCommand("restore");

        expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v1");
        expect(
          notifiedWithDetail(
            pi,
            "restorePostMutationLocationUnavailable",
            "arrival recovery failed",
          ),
        ).toBe(true);
        expect(pi.notifications.at(-1)?.level).toBe("error");
        const db = metadata();
        expect(checkpointState(db, pi.manager.sessionId, first)).toEqual(
          firstState,
        );
        expect(checkpointIsBlocked(db, pi.manager.sessionId, first)).toBe(true);
        expect(
          checkpointState(db, "unregistered-session", first),
        ).toBeUndefined();
        expect(checkpointIsBlocked(db, "unregistered-session", first)).toBe(
          false,
        );
        db.close();
      } finally {
        sessionSpy?.mockRestore();
      }
    });

    it("persists pending protection for an unresolvable post-mutation arrival", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first, second } = await twoStates(pi);
      const before = metadata();
      const firstState = checkpointState(before, pi.manager.sessionId, first)!;
      const secondState = checkpointState(
        before,
        pi.manager.sessionId,
        second,
      )!;
      before.close();
      pi.manager.setLeaf(first);
      let leafSpy: ReturnType<typeof vi.spyOn> | undefined;
      pi.selectHook = async () => {
        const getLeafId = pi.manager.getLeafId.bind(pi.manager);
        leafSpy = vi
          .spyOn(pi.manager, "getLeafId")
          .mockImplementation(() =>
            readFileSync(join(workspace, "a.txt"), "utf8") === "v1"
              ? "unknown-post-mutation-arrival"
              : getLeafId(),
          );
      };

      try {
        await pi.runCommand("restore");

        expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v1");
        expect(notified(pi, "restorePostMutationLocationBarrier")).toBe(true);
        let db = metadata();
        expect(checkpointState(db, pi.manager.sessionId, first)).toEqual(
          firstState,
        );
        expect(checkpointIsBlocked(db, pi.manager.sessionId, first)).toBe(true);
        expect(
          captureBarrier(
            db,
            pi.manager.sessionId,
            pi.manager.getSessionFile()!,
          ),
        ).toBe(true);
        db.close();

        leafSpy.mockRestore();
        leafSpy = undefined;
        pi.manager.setLeaf(second);
        await pi.endTurn(0);

        db = metadata();
        expect(checkpointState(db, pi.manager.sessionId, second)).toEqual(
          secondState,
        );
        expect(checkpointIsBlocked(db, pi.manager.sessionId, second)).toBe(
          true,
        );
        expect(
          captureBarrier(
            db,
            pi.manager.sessionId,
            pi.manager.getSessionFile()!,
          ),
        ).toBe(false);
        db.close();
      } finally {
        leafSpy?.mockRestore();
      }
    });

    it("keeps real input blocked while a no-node guard is pending", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await leavePendingNoNodeAfterRestore(pi);

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v1");
      expect(notified(pi, "restorePostMutationLocationBarrier")).toBe(true);
      let db = metadata();
      expect(
        captureBarrier(db, pi.manager.sessionId, pi.manager.getSessionFile()!),
      ).toBe(true);
      db.close();

      expect(await pi.submitInput("after-conflict")).toBe("handled");
      expect(pi.manager.getLeafId()).toBeNull();
      db = metadata();
      expect(
        captureBarrier(db, pi.manager.sessionId, pi.manager.getSessionFile()!),
      ).toBe(true);
      db.close();
    });

    it("guards the first custom child at Pi's post-persistence context hook", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await leavePendingNoNodeAfterRestore(pi);

      const custom = await pi.sendCustomMessage("after-conflict", true);
      const db = metadata();
      expect(checkpointState(db, pi.manager.sessionId, custom)).toBeUndefined();
      expect(checkpointIsBlocked(db, pi.manager.sessionId, custom)).toBe(true);
      expect(
        captureBarrier(db, pi.manager.sessionId, pi.manager.getSessionFile()!),
      ).toBe(false);
      db.close();
    });

    it("reports protected Missing after /drift consumes a pending bash child", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await leavePendingNoNodeAfterRestore(pi);
      await pi.executeUserBash("echo blocked", async () => {
        throw new Error("pending protection must block bash execution");
      });
      const child = pi.manager.getLeafId()!;
      pi.notifications.length = 0;

      await pi.runCommand("drift");

      const db = metadata();
      expect(checkpointState(db, pi.manager.sessionId, child)).toBeUndefined();
      expect(checkpointIsBlocked(db, pi.manager.sessionId, child)).toBe(true);
      expect(
        captureBarrier(db, pi.manager.sessionId, pi.manager.getSessionFile()!),
      ).toBe(false);
      db.close();
      expect(notified(pi, "driftMissingProtected")).toBe(true);
      expect(notified(pi, "driftMissing")).toBe(false);
    });

    it.each(["bash", "custom"] as const)(
      "keeps a pending %s child unassigned across an immediate cold restart",
      async (entryKind) => {
        const firstHost = new FakePi(workspace);
        registerCyclotomy(firstHost.api);
        await leavePendingNoNodeAfterRestore(firstHost);

        let child: string;
        if (entryKind === "bash") {
          let ran = false;
          await firstHost.executeUserBash("echo unsafe", async () => {
            ran = true;
          });
          expect(ran).toBe(false);
          child = firstHost.manager.getLeafId()!;
        } else {
          firstHost.afterCustomMessageCommit = async () => {
            throw new Error("simulated process loss before context");
          };
          await expect(
            firstHost.sendCustomMessage("after-conflict", true),
          ).rejects.toThrow("simulated process loss before context");
          child = firstHost.manager.getLeafId()!;
        }

        let db = metadata();
        expect(
          checkpointState(db, firstHost.manager.sessionId, child),
        ).toBeUndefined();
        expect(
          checkpointIsBlocked(db, firstHost.manager.sessionId, child),
        ).toBe(false);
        expect(
          captureBarrier(
            db,
            firstHost.manager.sessionId,
            firstHost.manager.getSessionFile()!,
          ),
        ).toBe(true);
        db.close();

        const persistedSession = firstHost.manager;
        await firstHost.dispose();
        const restarted = new FakePi(workspace);
        restarted.manager = persistedSession;
        registerCyclotomy(restarted.api);
        await restarted.startSession("startup");

        db = metadata();
        expect(
          checkpointState(db, restarted.manager.sessionId, child),
        ).toBeUndefined();
        expect(
          checkpointIsBlocked(db, restarted.manager.sessionId, child),
        ).toBe(true);
        expect(
          captureBarrier(
            db,
            restarted.manager.sessionId,
            restarted.manager.getSessionFile()!,
          ),
        ).toBe(false);
        db.close();
        expect(notified(restarted, "sessionMissingProtected")).toBe(true);
      },
    );

    it("guards every stable control node appended before pending intent is observed", async () => {
      const firstHost = new FakePi(workspace);
      registerCyclotomy(firstHost.api);
      await leavePendingNoNodeAfterRestore(firstHost);

      // Pi persists both entries before its awaited model_select hook. A cold
      // runtime must protect the whole newly visible ancestry, not only its leaf.
      const selected = await firstHost.selectModel("provider", "model", "high");
      const persistedSession = firstHost.manager;
      await firstHost.dispose();

      const restarted = new FakePi(workspace);
      restarted.manager = persistedSession;
      registerCyclotomy(restarted.api);
      await restarted.startSession("startup");

      let db = metadata();
      expect(
        captureBarrier(
          db,
          restarted.manager.sessionId,
          restarted.manager.getSessionFile()!,
        ),
      ).toBe(false);
      expect(
        checkpointIsBlocked(db, restarted.manager.sessionId, selected.modelId),
      ).toBe(true);
      expect(
        checkpointIsBlocked(
          db,
          restarted.manager.sessionId,
          selected.thinkingId!,
        ),
      ).toBe(true);
      expect(
        checkpointState(db, restarted.manager.sessionId, selected.modelId),
      ).toBeUndefined();
      expect(
        checkpointState(db, restarted.manager.sessionId, selected.thinkingId!),
      ).toBeUndefined();
      db.close();

      expect(await restarted.navigate(selected.modelId)).toBe("done");
      db = metadata();
      expect(
        checkpointState(db, restarted.manager.sessionId, selected.modelId),
      ).toBeUndefined();
      expect(
        checkpointIsBlocked(db, restarted.manager.sessionId, selected.modelId),
      ).toBe(true);
      db.close();
    });

    it.each(["empty", "concrete"] as const)(
      "propagates a pending parent into a cold %s fork",
      async (shape) => {
        const parentHost = new FakePi(workspace);
        registerCyclotomy(parentHost.api);
        await leavePendingNoNodeAfterRestore(parentHost);
        const parentSessionFile = parentHost.manager.getSessionFile()!;
        await parentHost.dispose();

        const fork = new FakeSessionManager(
          `cold-${shape}-fork`,
          join(home, `cold-${shape}-fork.jsonl`),
          workspace,
          parentSessionFile,
        );
        const leaf = shape === "concrete" ? fork.appendEntry() : undefined;
        const forkHost = new FakePi(workspace);
        forkHost.manager = fork;
        registerCyclotomy(forkHost.api);

        await forkHost.startSession("fork", parentSessionFile);

        const db = metadata();
        if (leaf === undefined) {
          expect(
            captureBarrier(db, fork.sessionId, fork.getSessionFile()!),
          ).toBe(true);
          expect(notified(forkHost, "sessionCaptureBarrier")).toBe(true);
        } else {
          expect(checkpointState(db, fork.sessionId, leaf.id)).toBeUndefined();
          expect(checkpointIsBlocked(db, fork.sessionId, leaf.id)).toBe(true);
          expect(
            captureBarrier(db, fork.sessionId, fork.getSessionFile()!),
          ).toBe(false);
          expect(notified(forkHost, "sessionMissingProtected")).toBe(true);
        }
        db.close();
      },
    );

    it("keeps a cold empty session barrier quarantined across reload", async () => {
      const firstHost = new FakePi(workspace);
      registerCyclotomy(firstHost.api);
      const target = await leavePendingNoNodeAfterRestore(firstHost);
      const persistedSession = firstHost.manager;
      await firstHost.dispose();

      const restarted = new FakePi(workspace);
      restarted.manager = persistedSession;
      registerCyclotomy(restarted.api);
      await restarted.startSession("startup");
      expect(notified(restarted, "sessionCaptureBarrier")).toBe(true);
      expect(await restarted.submitInput("still-blocked")).toBe("handled");
      expect(restarted.manager.getLeafId()).toBeNull();
      restarted.notifications.length = 0;
      await restarted.replaceRuntime(registerCyclotomy, "resume");
      expect(notified(restarted, "sessionCaptureBarrier")).toBe(true);
      expect(await restarted.navigate(target)).toBe("cancelled");
      expect(await restarted.compact()).toBe("cancelled");
      expect(await restarted.fork(target)).toBe("cancelled");
      expect(await restarted.resumeTo(restarted.newDetachedSession())).toBe(
        "cancelled",
      );

      let db = metadata();
      expect(
        captureBarrier(
          db,
          restarted.manager.sessionId,
          restarted.manager.getSessionFile()!,
        ),
      ).toBe(true);
      db.close();

      // Reload is another node-free observation, not proof that previously
      // uncertain files acquired an owner. The durable barrier therefore
      // survives until a concrete public coordinate is reconciled.
      await restarted.replaceRuntime(registerCyclotomy, "reload");
      db = metadata();
      expect(
        captureBarrier(
          db,
          restarted.manager.sessionId,
          restarted.manager.getSessionFile()!,
        ),
      ).toBe(true);
      db.close();
      expect(await restarted.submitInput("after-reload")).toBe("handled");
    });

    it("rejects an arrival that changes during post-mutation workspace authentication", async () => {
      const pi = new FakePi(workspace);
      const runtime = await preparedRuntime();
      registerPreparedRuntime(pi.api, runtime);
      const { first, second } = await twoStates(pi);
      await writeFile(join(workspace, "a.txt"), "v3");
      await pi.endTurn();
      const third = pi.manager.getLeafId()!;
      const before = metadata();
      const firstState = checkpointState(before, pi.manager.sessionId, first)!;
      const thirdState = checkpointState(before, pi.manager.sessionId, third)!;
      before.close();
      pi.manager.setLeaf(first);
      let reportedLeaf = second;
      let leafSpy: ReturnType<typeof vi.spyOn> | undefined;
      let bindingSpy: ReturnType<typeof vi.spyOn> | undefined;
      pi.selectHook = async () => {
        const getLeafId = pi.manager.getLeafId.bind(pi.manager);
        leafSpy = vi
          .spyOn(pi.manager, "getLeafId")
          .mockImplementation(() =>
            readFileSync(join(workspace, "a.txt"), "utf8") === "v1"
              ? reportedLeaf
              : getLeafId(),
          );
        const workspaceStillBound =
          runtime.registrations.workspaceStillBound.bind(runtime.registrations);
        bindingSpy = vi
          .spyOn(runtime.registrations, "workspaceStillBound")
          .mockImplementation(async (cwd: string) => {
            const bound = await workspaceStillBound(cwd);
            if (readFileSync(join(workspace, "a.txt"), "utf8") === "v1") {
              reportedLeaf = third;
            }
            return bound;
          });
      };

      try {
        await pi.runCommand("restore");

        expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v1");
        expect(notified(pi, "restorePostMutationLocationBarrier")).toBe(true);
        let db = metadata();
        expect(checkpointState(db, pi.manager.sessionId, first)).toEqual(
          firstState,
        );
        expect(checkpointIsBlocked(db, pi.manager.sessionId, first)).toBe(true);
        // The session-level marker is durable before another lifecycle hook;
        // a crash here cannot initialize the tearing arrival from restored files.
        expect(
          captureBarrier(
            db,
            pi.manager.sessionId,
            pi.manager.getSessionFile()!,
          ),
        ).toBe(true);
        db.close();

        bindingSpy.mockRestore();
        bindingSpy = undefined;
        leafSpy.mockRestore();
        leafSpy = undefined;
        pi.manager.setLeaf(third);
        await pi.endTurn(0);

        db = metadata();
        expect(checkpointState(db, pi.manager.sessionId, third)).toEqual(
          thirdState,
        );
        expect(checkpointIsBlocked(db, pi.manager.sessionId, third)).toBe(true);
        db.close();
      } finally {
        bindingSpy?.mockRestore();
        leafSpy?.mockRestore();
      }
    });

    it("shows the complete destructive plan in the interactive confirmation", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      pi.manager.appendEntry();
      await pi.startSession("startup");
      for (let index = 0; index < 6; index += 1) {
        await writeFile(join(workspace, `delete-${index}.txt`), "current");
      }
      pi.selectDestructive = false;

      await pi.runCommand("restore");

      const prompt = pi.selections.at(-1)?.prompt;
      expect(prompt).toBeDefined();
      for (let index = 0; index < 6; index += 1) {
        expect(prompt).toContain(`- delete-${index}.txt`);
      }
      expect(prompt).not.toContain("more");
      expect(await readFile(join(workspace, "delete-5.txt"), "utf8")).toBe(
        "current",
      );
    });

    it("clears write protection only after a verified restore", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      const leaf = pi.manager.getLeafId()!;
      const before = metadata();
      const savedOid = checkpointState(
        before,
        pi.manager.sessionId,
        leaf,
      )!.treeOid;
      before.close();
      await writeFile(join(workspace, "a.txt"), "kept-current");

      pi.selectDestructive = false;
      await pi.replaceRuntime(registerCyclotomy, "resume");
      let db = metadata();
      expect(checkpointIsBlocked(db, pi.manager.sessionId, leaf)).toBe(true);
      expect(checkpointState(db, pi.manager.sessionId, leaf)?.treeOid).toBe(
        savedOid,
      );
      db.close();

      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.runCommand("drift");
      expect(notified(pi, "driftCleanProtected")).toBe(true);
      expect(pi.notifications.at(-1)?.message).toContain("Detached");
      db = metadata();
      expect(checkpointIsBlocked(db, pi.manager.sessionId, leaf)).toBe(true);
      db.close();
      await writeFile(join(workspace, "a.txt"), "kept-current");

      pi.selectDestructive = true;
      await pi.runCommand("restore");
      db = metadata();
      expect(checkpointIsBlocked(db, pi.manager.sessionId, leaf)).toBe(false);
      db.close();
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("saved");

      await writeFile(join(workspace, "a.txt"), "after-restore");
      await pi.endTurn(0);
      db = metadata();
      expect(checkpointState(db, pi.manager.sessionId, leaf)?.treeOid).not.toBe(
        savedOid,
      );
      db.close();
    });

    it("authenticates a confirmed restore once per user-separated phase", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      await writeFile(join(workspace, "a.txt"), "current");
      const readTree = await spyOnReadTree();
      const readTreeManifest = await spyOnReadTreeManifest();

      try {
        await pi.runCommand("restore");

        expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("saved");
        expect(readTree).toHaveBeenCalledOnce();
        // One manifest-only restore read plus readTree's own manifest read.
        expect(readTreeManifest).toHaveBeenCalledTimes(2);
      } finally {
        readTree.mockRestore();
        readTreeManifest.mockRestore();
      }
    });

    it("safe choice, Escape, unknown UI values, and no UI leave files unchanged", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      await writeFile(join(workspace, "a.txt"), "current");
      pi.selectDestructive = false;
      await pi.runCommand("restore");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("current");

      pi.selectionOverride = null;
      await pi.runCommand("restore");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("current");

      pi.selectionOverride = "unexpected RPC value";
      await pi.runCommand("restore");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("current");

      pi.selectionOverride = undefined;
      pi.hasUI = false;
      pi.mode = "print";
      pi.selectDestructive = true;
      const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await pi.runCommand("restore");
        expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
          "current",
        );
        expect(stderr).toHaveBeenCalledWith(
          expect.stringContaining(messageFor("restoreNeedsUi")),
        );
        const diagnostic = stderr.mock.calls.flat().join("\n");
        expect(diagnostic).toContain("/drift");
        expect(diagnostic).toContain("/restore");
        expect(diagnostic).toContain("交互式 TUI");
      } finally {
        stderr.mockRestore();
      }
    });

    it("keeps a no-UI loaded node protected while admitting its descendant", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      const leaf = pi.manager.getLeafId()!;
      const before = metadata();
      const savedOid = checkpointState(
        before,
        pi.manager.sessionId,
        leaf,
      )!.treeOid;
      before.close();
      await writeFile(join(workspace, "a.txt"), "current");
      pi.mode = "print";
      pi.hasUI = false;
      const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        await pi.replaceRuntime(registerCyclotomy, "resume");
        const unchanged = metadata();
        expect(
          checkpointState(unchanged, pi.manager.sessionId, leaf)?.treeOid,
        ).toBe(savedOid);
        expect(checkpointIsBlocked(unchanged, pi.manager.sessionId, leaf)).toBe(
          true,
        );
        unchanged.close();
        expect(stderr).toHaveBeenCalledWith(
          expect.stringContaining(messageFor("sessionRestoreNeedsUi")),
        );

        expect(await pi.submitInput()).toBe("continued");
        const descendant = pi.manager.getLeafId()!;
        let accepted = metadata();
        expect(
          checkpointState(accepted, pi.manager.sessionId, leaf)?.treeOid,
        ).toBe(savedOid);
        expect(checkpointIsBlocked(accepted, pi.manager.sessionId, leaf)).toBe(
          true,
        );
        expect(
          checkpointState(accepted, pi.manager.sessionId, descendant),
        ).toBeUndefined();
        accepted.close();

        await pi.endTurn(0);
        accepted = metadata();
        expect(
          checkpointState(accepted, pi.manager.sessionId, descendant),
        ).toBeDefined();
        expect(
          checkpointIsBlocked(accepted, pi.manager.sessionId, descendant),
        ).toBe(false);
        accepted.close();
      } finally {
        stderr.mockRestore();
      }
    });

    it("defers loaded-session choice until RPC startup has completed", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      await writeFile(join(workspace, "a.txt"), "current");
      pi.mode = "rpc";
      const selectionsBefore = pi.selections.length;

      await pi.replaceRuntime(registerCyclotomy, "resume");

      expect(pi.selections).toHaveLength(selectionsBefore);
      expect(notified(pi, "sessionRestoreDeferredRpc")).toBe(true);
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("current");

      await pi.runCommand("restore");
      expect(pi.selections).toHaveLength(selectionsBefore + 1);
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("saved");
    });

    it("keeps loaded-session reconciliation fail-closed when confirm rejects", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      await writeFile(join(workspace, "a.txt"), "current");
      pi.selectHook = async () => {
        throw new Error("confirmation transport failed");
      };

      await expect(
        pi.replaceRuntime(registerCyclotomy, "resume"),
      ).resolves.toBeUndefined();

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("current");
      expect(
        notifiedWithDetail(
          pi,
          "restoreFailed",
          "confirmation transport failed",
        ),
      ).toBe(true);
    });

    it("invalidates confirmation when the workspace changes under the dialog", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      await writeFile(join(workspace, "a.txt"), "previewed");
      pi.selectHook = async () => {
        await writeFile(join(workspace, "a.txt"), "changed-during-confirm");
      };

      await pi.runCommand("restore");

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "changed-during-confirm",
      );
      expect(notified(pi, "commandPreviewStale")).toBe(true);
    });

    it("invalidates confirmation when a closer node state appears", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first, second } = await twoStates(pi);
      expect(await pi.navigate(first)).toBe("done");
      const child = pi.manager.appendEntry();
      await writeFile(join(workspace, "a.txt"), "unsaved-child");
      const db = metadata();
      const alternate = checkpointState(db, pi.manager.sessionId, second)!;
      db.close();
      pi.selectHook = async () => {
        const concurrent = metadata();
        commitTestNodeState(
          concurrent,
          pi.manager.sessionId,
          child.id,
          alternate.treeOid,
          pi.manager.getSessionFile(),
        );
        concurrent.close();
      };

      await pi.runCommand("restore");

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "unsaved-child",
      );
      expect(notified(pi, "commandTargetChanged")).toBe(true);
    });
  });

  describe("tree navigation preparation", () => {
    it("protects the source and passes navigation when its store becomes unavailable", async () => {
      const pi = new FakePi(workspace);
      const runtime = await preparedRuntime();
      registerPreparedRuntime(pi.api, runtime);
      const { first, second } = await twoStates(pi);
      const cause = new Error("injected navigation store failure");
      const ensureStore = vi
        .spyOn(runtime, "ensureStore")
        .mockImplementationOnce(async () => {
          runtime.markSessionUnavailable(cause);
          return false;
        });

      try {
        expect(await pi.navigate(first)).toBe("done");
      } finally {
        ensureStore.mockRestore();
      }

      expect(pi.manager.getLeafId()).toBe(first);
      expect(runtime.activation).toEqual({ kind: "unavailable", cause });
      const db = metadata();
      expect(checkpointIsBlocked(db, pi.manager.sessionId, second)).toBe(true);
      db.close();
    });

    it.each(["acquisition", "action"] as const)(
      "protects the source and passes navigation when tree-prepare lock %s fails",
      async (phase) => {
        const pi = new FakePi(workspace);
        const runtime = await preparedRuntime();
        registerPreparedRuntime(pi.api, runtime);
        const { first, second } = await twoStates(pi);
        const cause = new Error(`injected tree-prepare ${phase} failure`);
        const execution = vi.spyOn(runtime, "enqueueWorkspaceExecution");
        if (phase === "acquisition") {
          execution.mockRejectedValueOnce(cause);
        } else {
          execution.mockResolvedValueOnce({
            kind: "action-failed",
            cause,
            cleanup: { kind: "released" },
          });
        }

        try {
          expect(await pi.navigate(first)).toBe("done");
        } finally {
          execution.mockRestore();
        }

        expect(pi.manager.getLeafId()).toBe(first);
        expect(runtime.activation).toEqual({ kind: "unavailable", cause });
        const db = metadata();
        expect(checkpointIsBlocked(db, pi.manager.sessionId, second)).toBe(
          true,
        );
        db.close();
      },
    );

    it("protects the source and passes navigation when source publication fails", async () => {
      const pi = new FakePi(workspace);
      const runtime = await preparedRuntime();
      registerPreparedRuntime(pi.api, runtime);
      const { first, second } = await twoStates(pi);
      await writeFile(join(workspace, "a.txt"), "unpublished-source");
      const cause = new Error("injected source publication failure");
      const publication = vi
        .spyOn(runtime.checkpoints, "prepareObserved")
        .mockResolvedValueOnce({
          ok: false,
          error: { kind: "publish-failed", cause },
        });

      try {
        expect(await pi.navigate(first)).toBe("done");
      } finally {
        publication.mockRestore();
      }

      expect(pi.manager.getLeafId()).toBe(first);
      expect(runtime.activation.kind).toBe("unavailable");
      expect(notified(pi, "sourceCaptureFailed")).toBe(true);
      const db = metadata();
      expect(checkpointIsBlocked(db, pi.manager.sessionId, second)).toBe(true);
      db.close();
    });

    it("preserves source capture and lets Pi depart when commit lock cleanup fails", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first, second } = await twoStates(pi);
      const before = metadata();
      const sourceBefore = checkpointState(
        before,
        pi.manager.sessionId,
        second,
      )!;
      before.close();
      await writeFile(join(workspace, "a.txt"), "source-current");
      const cleanupFailure = failWorkspaceLockCleanup(
        "tree-commit",
        new Error("tree commit lock release failed"),
      );

      try {
        expect(await pi.navigate(first)).toBe("done");
      } finally {
        cleanupFailure.mockRestore();
      }

      expect(pi.manager.getLeafId()).toBe(first);
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "source-current",
      );
      const after = metadata();
      expect(
        checkpointState(after, pi.manager.sessionId, second)?.treeOid,
      ).not.toBe(sourceBefore.treeOid);
      expect(checkpointIsBlocked(after, pi.manager.sessionId, second)).toBe(
        false,
      );
      after.close();
      expect(notified(pi, "sourceCaptureFailed")).toBe(false);
      expect(
        pi.notifications.filter(({ message }) =>
          message.includes(messageFor("workspaceLockCleanupFailed")),
        ),
      ).toHaveLength(1);
    });

    it("admits a different coordinate when restoring an identical tree is a no-op", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "same.txt"), "same");
      await pi.endTurn();
      const first = pi.manager.getLeafId()!;
      await pi.endTurn();
      const second = pi.manager.getLeafId()!;

      let db = metadata();
      expect(checkpointState(db, pi.manager.sessionId, first)).toEqual(
        checkpointState(db, pi.manager.sessionId, second),
      );
      db.close();

      expect(await pi.navigate(first)).toBe("done");

      db = metadata();
      expect(checkpointIsBlocked(db, pi.manager.sessionId, first)).toBe(false);
      db.close();
      expect(notified(pi, "restorePostMutationTargetProtected")).toBe(false);
      expect(notified(pi, "restorePostMutationTargetBarrier")).toBe(false);

      await writeFile(join(workspace, "same.txt"), "changed-after-no-op");
      await pi.endTurn(0);
      db = metadata();
      expect(checkpointIsBlocked(db, pi.manager.sessionId, first)).toBe(false);
      expect(checkpointState(db, pi.manager.sessionId, first)).not.toEqual(
        checkpointState(db, pi.manager.sessionId, second),
      );
      db.close();
    });

    it("round-trips tree nodes and assigns manual edits to the source", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first, second } = await twoStates(pi);

      expect(await pi.navigate(first)).toBe("done");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v1");
      expect(lastStatus(pi)).toBeUndefined();
      await writeFile(join(workspace, "a.txt"), "branch-edit");
      expect(await pi.navigate(second)).toBe("done");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v2");
      expect(await pi.navigate(first)).toBe("done");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "branch-edit",
      );
    });

    it("navigates with current files while protecting the exact destination", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first, second } = await twoStates(pi);
      let db = metadata();
      const targetBefore = checkpointState(db, pi.manager.sessionId, first)!;
      const sourceBefore = checkpointState(db, pi.manager.sessionId, second)!;
      db.close();
      await writeFile(join(workspace, "a.txt"), "source-current");
      pi.selectionOverride = messageFor("choiceNavigationDetach");
      const readTree = await spyOnReadTree();

      try {
        expect(await pi.navigate(first)).toBe("done");
        expect(readTree.mock.calls.map(([treeOid]) => treeOid)).toEqual([
          targetBefore.treeOid,
          targetBefore.treeOid,
          targetBefore.treeOid,
        ]);
      } finally {
        readTree.mockRestore();
      }

      expect(pi.selections.at(-1)?.options).toEqual([
        messageFor("choiceNavigationSafe"),
        messageFor("choiceNavigationDetach"),
        messageFor("choiceNavigationRestore"),
      ]);
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "source-current",
      );
      db = metadata();
      expect(checkpointState(db, pi.manager.sessionId, first)).toEqual(
        targetBefore,
      );
      expect(checkpointIsBlocked(db, pi.manager.sessionId, first)).toBe(true);
      expect(
        checkpointState(db, pi.manager.sessionId, second)?.treeOid,
      ).not.toBe(sourceBefore.treeOid);
      expect(checkpointIsBlocked(db, pi.manager.sessionId, second)).toBe(false);
      db.close();
      expect(notified(pi, "navigationDetached")).toBe(true);
      expect(lastStatus(pi)).toBeUndefined();

      pi.notifications.length = 0;
      await pi.runCommand("drift");
      expect(notified(pi, "driftTitleDetached")).toBe(true);
      db = metadata();
      expect(checkpointIsBlocked(db, pi.manager.sessionId, first)).toBe(true);
      db.close();

      // The protected destination cannot absorb the carried workspace, while
      // a natural descendant remains an independent checkpoint location.
      await pi.endTurn(0);
      const child = pi.manager.appendEntry();
      await pi.endTurn(0);
      db = metadata();
      expect(checkpointState(db, pi.manager.sessionId, first)).toEqual(
        targetBefore,
      );
      expect(checkpointIsBlocked(db, pi.manager.sessionId, first)).toBe(true);
      expect(checkpointState(db, pi.manager.sessionId, child.id)).toBeDefined();
      expect(checkpointIsBlocked(db, pi.manager.sessionId, child.id)).toBe(
        false,
      );
      db.close();

      // Explicit reconciliation restores the pinned target and retires only
      // that exact node's guard.
      pi.manager.setLeaf(first);
      pi.selectionOverride = undefined;
      await pi.runCommand("restore");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v1");
      db = metadata();
      expect(checkpointState(db, pi.manager.sessionId, first)).toEqual(
        targetBefore,
      );
      expect(checkpointIsBlocked(db, pi.manager.sessionId, first)).toBe(false);
      db.close();
    });

    it("pins an inherited destination before keeping the current workspace", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "ancestor");
      await pi.endTurn();
      const ancestor = pi.manager.getLeafId()!;
      const target = pi.manager.appendEntry();
      pi.manager.setLeaf(ancestor);
      const source = pi.manager.appendEntry();
      await writeFile(join(workspace, "a.txt"), "source");
      await pi.endTurn(0);
      let db = metadata();
      const ancestorState = checkpointState(
        db,
        pi.manager.sessionId,
        ancestor,
      )!;
      const sourceState = checkpointState(db, pi.manager.sessionId, source.id)!;
      expect(
        checkpointState(db, pi.manager.sessionId, target.id),
      ).toBeUndefined();
      db.close();
      pi.selectionOverride = messageFor("choiceNavigationDetach");

      expect(await pi.navigate(target.id)).toBe("done");

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("source");
      db = metadata();
      expect(checkpointState(db, pi.manager.sessionId, target.id)).toEqual(
        ancestorState,
      );
      expect(checkpointIsBlocked(db, pi.manager.sessionId, target.id)).toBe(
        true,
      );
      commitTestNodeState(
        db,
        pi.manager.sessionId,
        ancestor,
        sourceState.treeOid,
        pi.manager.getSessionFile(),
      );
      expect(checkpointState(db, pi.manager.sessionId, target.id)).toEqual(
        ancestorState,
      );
      db.close();
    });

    it("keeps a protected source untouched while protecting the destination", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first, second } = await twoStates(pi);
      let db = metadata();
      const sourceBefore = checkpointState(db, pi.manager.sessionId, second)!;
      db.close();
      await writeFile(join(workspace, "a.txt"), "protected-source");
      pi.selectDestructive = false;
      await pi.replaceRuntime(registerCyclotomy, "resume");
      pi.selectionOverride = messageFor("choiceNavigationDetach");

      expect(await pi.navigate(first)).toBe("done");

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "protected-source",
      );
      db = metadata();
      expect(checkpointState(db, pi.manager.sessionId, second)).toEqual(
        sourceBefore,
      );
      expect(checkpointIsBlocked(db, pi.manager.sessionId, second)).toBe(true);
      expect(checkpointIsBlocked(db, pi.manager.sessionId, first)).toBe(true);
      db.close();
    });

    it("lets Pi depart when a protected source loses its workspace binding", async () => {
      const pi = new FakePi(workspace);
      const initialRuntime = await preparedRuntime();
      registerPreparedRuntime(pi.api, initialRuntime);
      const { first, second } = await twoStates(pi);
      await writeFile(join(workspace, "a.txt"), "protected-source");
      pi.selectDestructive = false;
      const runtime = await preparedRuntime();
      await pi.replaceRuntime(
        (api) => registerPreparedRuntime(api, runtime),
        "resume",
      );
      pi.selectionOverride = messageFor("choiceNavigationDetach");
      const spies: Array<{ mockRestore(): void }> = [];
      pi.selectHook = async () => {
        spies.push(
          vi
            .spyOn(runtime.registrations, "workspaceStillBound")
            .mockResolvedValue(false),
        );
      };

      try {
        expect(await pi.navigate(first)).toBe("done");
      } finally {
        for (const spy of spies) spy.mockRestore();
      }

      expect(pi.manager.getLeafId()).toBe(first);
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "protected-source",
      );
      expect(runtime.activation.kind).toBe("unavailable");
      const db = metadata();
      expect(checkpointIsBlocked(db, pi.manager.sessionId, second)).toBe(true);
      expect(checkpointIsBlocked(db, pi.manager.sessionId, first)).toBe(false);
      db.close();
    });

    it("does not publish the source after its final binding check yields", async () => {
      const pi = new FakePi(workspace);
      const runtime = await preparedRuntime();
      registerPreparedRuntime(pi.api, runtime);
      const { first, second } = await twoStates(pi);
      const before = metadata();
      const sourceBefore = checkpointState(
        before,
        pi.manager.sessionId,
        second,
      )!;
      before.close();
      await writeFile(join(workspace, "a.txt"), "source-during-binding-check");
      pi.selectionOverride = messageFor("choiceNavigationDetach");
      const original = runtime.registrations.workspaceStillBound.bind(
        runtime.registrations,
      );
      const spies: Array<{ mockRestore(): void }> = [];
      pi.selectHook = async () => {
        spies.push(
          vi
            .spyOn(runtime.registrations, "workspaceStillBound")
            .mockImplementation(async (cwd: string) => {
              const bound = await original(cwd);
              pi.idle = false;
              return bound;
            }),
        );
      };

      try {
        expect(await pi.navigate(first)).toBe("cancelled");
      } finally {
        for (const spy of spies) spy.mockRestore();
        pi.idle = true;
      }

      expect(pi.manager.getLeafId()).toBe(second);
      expect(runtime.activation.kind).toBe("active");
      const after = metadata();
      expect(checkpointState(after, pi.manager.sessionId, second)).toEqual(
        sourceBefore,
      );
      expect(checkpointIsBlocked(after, pi.manager.sessionId, first)).toBe(
        false,
      );
      after.close();
    });

    it("authenticates navigation once in each real trust phase", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first } = await twoStates(pi);
      const db = metadata();
      const targetTreeOid = checkpointState(
        db,
        pi.manager.sessionId,
        first,
      )!.treeOid;
      db.close();
      const readTree = await spyOnReadTree();
      const readTreeManifest = await spyOnReadTreeManifest();

      try {
        expect(await pi.navigate(first)).toBe("done");

        expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v1");
        expect(readTree).toHaveBeenCalledTimes(2);
        expect(readTree.mock.calls.map(([treeOid]) => treeOid)).toEqual([
          targetTreeOid,
          targetTreeOid,
        ]);
        // Two readTree phases each load the manifest; restore adds one
        // manifest-only read without repeating closure verification.
        expect(readTreeManifest).toHaveBeenCalledTimes(3);
        expect(readTreeManifest).toHaveBeenCalledWith(targetTreeOid);
      } finally {
        readTree.mockRestore();
        readTreeManifest.mockRestore();
      }
    });

    it("keeps every safe navigation choice fail-closed", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first, second } = await twoStates(pi);
      const before = metadata();
      const targetBefore = checkpointState(
        before,
        pi.manager.sessionId,
        first,
      )!;
      const sourceBefore = checkpointState(
        before,
        pi.manager.sessionId,
        second,
      )!;
      before.close();
      await writeFile(join(workspace, "a.txt"), "declined-edit");
      pi.selectDestructive = false;

      expect(await pi.navigate(first)).toBe("cancelled");
      pi.selectionOverride = null;
      expect(await pi.navigate(first)).toBe("cancelled");
      pi.selectionOverride = "unexpected RPC value";
      expect(await pi.navigate(first)).toBe("cancelled");
      pi.selectionOverride = undefined;
      pi.hasUI = false;
      expect(await pi.navigate(first)).toBe("cancelled");

      expect(pi.manager.getLeafId()).toBe(second);
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "declined-edit",
      );
      const after = metadata();
      expect(checkpointState(after, pi.manager.sessionId, second)).toEqual(
        sourceBefore,
      );
      expect(checkpointState(after, pi.manager.sessionId, first)).toEqual(
        targetBefore,
      );
      expect(checkpointIsBlocked(after, pi.manager.sessionId, first)).toBe(
        false,
      );
      after.close();
    });

    it("retires Cyclotomy on an incomplete navigation preview without offering destructive actions", async (context) => {
      context.skip(
        !(await workspaceAliasesCase()),
        "requires a case-insensitive physical namespace",
      );
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      const targetNode = pi.manager.appendEntry();
      const targetBytes = Buffer.from("target", "utf8");
      const blobOid = createHash("sha256").update(targetBytes).digest("hex");
      const payload = join(home, "target-payload");
      await writeFile(payload, targetBytes);
      const store = await openObjectStore(storeRoot);
      const publication = store.beginSnapshotPublication();
      await publication.publishBlobFromFile(
        payload,
        blobOid,
        targetBytes.byteLength,
      );
      const treeOid = await publication.publishTree(
        [
          {
            path: "x",
            type: "regular",
            blobOid,
            recreationMode: process.platform === "win32" ? null : 0o600,
          },
        ],
        gitScope({ globalExclude: "X\n" }),
      );
      const db = metadata();
      commitTestNodeState(
        db,
        pi.manager.sessionId,
        targetNode.id,
        treeOid,
        pi.manager.getSessionFile(),
      );
      db.close();
      const sourceNode = pi.manager.appendEntry();
      await writeFile(join(workspace, "X"), "ignored current");
      await writeFile(join(workspace, "delete-me"), "must survive preview");
      const selectionsBefore = pi.selections.length;

      expect(await pi.navigate(targetNode.id)).toBe("done");

      expect(pi.manager.getLeafId()).toBe(targetNode.id);
      expect(pi.selections).toHaveLength(selectionsBefore);
      expect(notified(pi, "navigationScanIncomplete")).toBe(true);
      expect(await readFile(join(workspace, "X"), "utf8")).toBe(
        "ignored current",
      );
      expect(await readFile(join(workspace, "delete-me"), "utf8")).toBe(
        "must survive preview",
      );
      const protectedSource = metadata();
      expect(
        checkpointIsBlocked(
          protectedSource,
          pi.manager.sessionId,
          sourceNode.id,
        ),
      ).toBe(true);
      protectedSource.close();
    });

    it("captures safely even when selecting a child prompt leaves the leaf unchanged", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      const source = pi.manager.getLeafId()!;
      const childPrompt = pi.manager.appendEntry({
        type: "message",
        message: { role: "user" },
      });
      pi.manager.setLeaf(source);
      const before = metadata();
      const sourceBefore = checkpointState(
        before,
        pi.manager.sessionId,
        source,
      )!;
      before.close();
      await writeFile(join(workspace, "a.txt"), "editor-no-op");

      expect(await pi.navigate(childPrompt.id)).toBe("done");

      expect(pi.manager.getLeafId()).toBe(source);
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "editor-no-op",
      );
      const after = metadata();
      expect(
        checkpointState(after, pi.manager.sessionId, source)?.treeOid,
      ).not.toBe(sourceBefore.treeOid);
      after.close();
    });

    it("captures the source when the same landing gains a summary or label wrapper", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      const source = pi.manager.getLeafId()!;
      const childPrompt = pi.manager.appendEntry({
        type: "message",
        message: { role: "user" },
      });
      pi.manager.setLeaf(source);
      const before = metadata();
      const sourceBefore = checkpointState(
        before,
        pi.manager.sessionId,
        source,
      )!;
      before.close();
      await writeFile(join(workspace, "a.txt"), "wrapped-movement");

      expect(await pi.prepareNavigation(childPrompt.id)).toBe("ready");
      await pi.commitPreparedSummary(childPrompt.id, true);

      const after = metadata();
      expect(
        checkpointState(after, pi.manager.sessionId, source)?.treeOid,
      ).not.toBe(sourceBefore.treeOid);
      after.close();
    });

    it("retires Cyclotomy and lets Pi navigate when confirmation UI throws", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first, second } = await twoStates(pi);
      await writeFile(join(workspace, "a.txt"), "still-current");
      pi.selectHook = async () => {
        throw new Error("test confirmation teardown");
      };
      pi.notifyThrows = true;

      expect(await pi.navigate(first)).toBe("done");

      expect(pi.manager.getLeafId()).toBe(first);
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "still-current",
      );
      const db = metadata();
      expect(checkpointIsBlocked(db, pi.manager.sessionId, second)).toBe(true);
      db.close();
      expect(await pi.submitInput()).toBe("continued");
    });

    it("directs a stale pre-departure preview back to navigation", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first, second } = await twoStates(pi);
      await writeFile(join(workspace, "a.txt"), "previewed-source");
      pi.selectHook = async () => {
        await writeFile(join(workspace, "a.txt"), "changed-during-preview");
      };

      expect(await pi.navigate(first)).toBe("cancelled");

      expect(pi.manager.getLeafId()).toBe(second);
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "changed-during-preview",
      );
      expect(notified(pi, "navigationChangedBeforeDeparture")).toBe(true);
      expect(pi.notifications.at(-1)?.message).toContain("/tree");
      expect(pi.notifications.at(-1)?.message).not.toContain("/restore");
    });

    it("does not overwrite a source checkpoint changed during the choice", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first, second } = await twoStates(pi);
      const before = metadata();
      const concurrentState = checkpointState(
        before,
        pi.manager.sessionId,
        first,
      )!;
      before.close();
      await writeFile(join(workspace, "a.txt"), "previewed-source");
      pi.selectHook = async () => {
        const concurrent = metadata();
        commitTestNodeState(
          concurrent,
          pi.manager.sessionId,
          second,
          concurrentState.treeOid,
          pi.manager.getSessionFile(),
        );
        concurrent.close();
      };

      expect(await pi.navigate(first)).toBe("cancelled");

      expect(pi.manager.getLeafId()).toBe(second);
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "previewed-source",
      );
      const after = metadata();
      expect(checkpointState(after, pi.manager.sessionId, second)).toEqual(
        concurrentState,
      );
      expect(checkpointIsBlocked(after, pi.manager.sessionId, first)).toBe(
        false,
      );
      after.close();
      expect(notified(pi, "navigationChangedBeforeDeparture")).toBe(true);
    });

    it("rechecks the destination after publishing the source checkpoint", async () => {
      const pi = new FakePi(workspace);
      const runtime = await preparedRuntime();
      registerPreparedRuntime(pi.api, runtime);
      const { first, second } = await twoStates(pi);
      const before = metadata();
      const concurrentState = checkpointState(
        before,
        pi.manager.sessionId,
        second,
      )!;
      const sourceBefore = concurrentState.treeOid;
      before.close();
      await writeFile(join(workspace, "a.txt"), "source-publication");

      const metadataStore = runtime.metadata;
      const original = metadataStore.commitCapture.bind(metadataStore);
      const raced = vi
        .spyOn(metadataStore, "commitCapture")
        .mockImplementation((input) => {
          const result = original(input);
          if (input.entryId === second && result === "committed") {
            const concurrent = metadata();
            commitTestNodeState(
              concurrent,
              pi.manager.sessionId,
              first,
              concurrentState.treeOid,
              pi.manager.getSessionFile(),
            );
            concurrent.close();
          }
          return result;
        });

      try {
        expect(await pi.navigate(first)).toBe("cancelled");
      } finally {
        raced.mockRestore();
      }

      const after = metadata();
      expect(checkpointState(after, pi.manager.sessionId, first)).toEqual(
        concurrentState,
      );
      expect(
        checkpointState(after, pi.manager.sessionId, second)?.treeOid,
      ).not.toBe(sourceBefore);
      expect(checkpointIsBlocked(after, pi.manager.sessionId, first)).toBe(
        false,
      );
      after.close();
      expect(notified(pi, "navigationChangedBeforeDeparture")).toBe(true);
    });

    it("cancels navigation if the agent becomes busy during confirmation", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first, second } = await twoStates(pi);
      await writeFile(join(workspace, "a.txt"), "still-current");
      pi.selectHook = async () => {
        pi.idle = false;
      };

      expect(await pi.navigate(first)).toBe("cancelled");

      expect(pi.manager.getLeafId()).toBe(second);
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "still-current",
      );
    });

    it("retires Cyclotomy when a non-null source entry is unreadable", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first, second } = await twoStates(pi);
      const before = metadata();
      const sourceBefore = checkpointState(
        before,
        pi.manager.sessionId,
        second,
      )!;
      before.close();
      pi.manager.entries.delete(second);
      await writeFile(join(workspace, "a.txt"), "unowned-edit");

      expect(await pi.navigate(first)).toBe("done");

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "unowned-edit",
      );
      const after = metadata();
      expect(checkpointState(after, pi.manager.sessionId, second)).toEqual(
        sourceBefore,
      );
      after.close();
    });

    it("retires Cyclotomy when an active label has no readable parent", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first } = await twoStates(pi);
      const brokenLabel: FakeEntry = {
        id: "broken-label",
        parentId: "missing-parent",
        timestamp: new Date().toISOString(),
        type: "label",
      };
      pi.manager.entries.set(brokenLabel.id, brokenLabel);
      pi.manager.setLeaf(brokenLabel.id);
      await writeFile(join(workspace, "a.txt"), "unowned-label-edit");

      expect(await pi.navigate(first)).toBe("done");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "unowned-label-edit",
      );
    });

    it("retires Cyclotomy and leaves Pi usable when session context and diagnostics throw", async () => {
      const pi = new FakePi(workspace, registerCyclotomy);
      const { first } = await twoStates(pi);
      pi.sessionContextThrows = true;
      let bashRan = false;
      const rendering = throwTranslations(
        "navigationPrepareFailed",
        "inputCaptureFailed",
        "sourceCaptureFailed",
      );

      try {
        expect(await pi.navigate(first)).toBe("done");
        expect(await pi.compact()).toBe("done");
        expect(await pi.fork(first)).toBe("done");
        expect(await pi.submitInput()).toBe("continued");
        await pi.executeUserBash("must-not-run", async () => {
          bashRan = true;
        });
      } finally {
        rendering.mockRestore();
      }
      expect(bashRan).toBe(true);
    });

    it("rejects a reentrant tree request while the first preview is open", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first } = await twoStates(pi);
      let nested: "done" | "cancelled" | undefined;
      pi.selectHook = async () => {
        pi.selectHook = undefined;
        nested = await pi.navigate(first);
      };

      expect(await pi.navigate(first)).toBe("done");

      expect(nested).toBe("cancelled");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v1");
    });

    it("cancels tree, fork, and switch requests while the agent is busy", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first, second } = await twoStates(pi);
      const target = pi.newDetachedSession();
      pi.idle = false;

      expect(await pi.navigate(first)).toBe("cancelled");
      expect(await pi.fork(first)).toBe("cancelled");
      expect(await pi.resumeTo(target)).toBe("cancelled");
      expect(pi.manager.getLeafId()).toBe(second);
    });

    it("lets a missing descendant inherit the source state being captured", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "source-old");
      await pi.endTurn();
      const source = pi.manager.getLeafId()!;
      const child = pi.manager.appendEntry();
      pi.manager.setLeaf(source);
      await writeFile(join(workspace, "a.txt"), "source-current");
      const selectionsBefore = pi.selections.length;

      expect(await pi.navigate(child.id)).toBe("done");

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "source-current",
      );
      expect(pi.selections).toHaveLength(selectionsBefore);
      const db = metadata();
      expect(checkpointState(db, pi.manager.sessionId, source)).toBeDefined();
      expect(
        checkpointState(db, pi.manager.sessionId, child.id),
      ).toBeUndefined();
      db.close();
    });

    it("keeps repeated summary and label round-trips on the stable anchor", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first, second } = await twoStates(pi);

      expect(await pi.prepareNavigation(first)).toBe("ready");
      const summary = await pi.commitPreparedSummary(first, true);
      const label = pi.manager.getLeafId()!;

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v1");
      let db = metadata();
      expect(checkpointState(db, pi.manager.sessionId, summary)).toBeDefined();
      expect(checkpointState(db, pi.manager.sessionId, label)).toBeUndefined();
      db.close();

      await writeFile(join(workspace, "a.txt"), "summary-edit");
      expect(await pi.navigate(second)).toBe("done");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v2");

      for (let round = 0; round < 2; round += 1) {
        expect(await pi.navigate(summary)).toBe("done");
        expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
          "summary-edit",
        );
        expect(await pi.navigate(second)).toBe("done");
        expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v2");
      }

      db = metadata();
      expect(checkpointState(db, pi.manager.sessionId, summary)).toBeDefined();
      expect(checkpointState(db, pi.manager.sessionId, label)).toBeUndefined();
      expect(checkpointIsBlocked(db, pi.manager.sessionId, summary)).toBe(
        false,
      );
      db.close();
    });

    it("protects the actual summary anchor when keeping the workspace", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first } = await twoStates(pi);
      const before = metadata();
      const targetBefore = checkpointState(
        before,
        pi.manager.sessionId,
        first,
      )!;
      before.close();
      pi.selectionOverride = messageFor("choiceNavigationDetach");

      expect(await pi.prepareNavigation(first)).toBe("ready");
      const summary = await pi.commitPreparedSummary(first, true);
      const label = pi.manager.getLeafId()!;

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v2");
      let db = metadata();
      expect(checkpointState(db, pi.manager.sessionId, first)).toEqual(
        targetBefore,
      );
      expect(checkpointIsBlocked(db, pi.manager.sessionId, first)).toBe(false);
      expect(checkpointState(db, pi.manager.sessionId, summary)).toEqual(
        targetBefore,
      );
      expect(checkpointIsBlocked(db, pi.manager.sessionId, summary)).toBe(true);
      expect(checkpointState(db, pi.manager.sessionId, label)).toBeUndefined();
      db.close();

      const child = pi.manager.appendEntry();
      await pi.endTurn(0);
      db = metadata();
      expect(checkpointState(db, pi.manager.sessionId, summary)).toEqual(
        targetBefore,
      );
      expect(checkpointIsBlocked(db, pi.manager.sessionId, summary)).toBe(true);
      expect(checkpointState(db, pi.manager.sessionId, child.id)).toBeDefined();
      expect(checkpointIsBlocked(db, pi.manager.sessionId, child.id)).toBe(
        false,
      );
      db.close();
    });

    it("recovers the actual summary anchor when protected arrival settlement loses authority", async () => {
      const pi = new FakePi(workspace);
      const runtime = await preparedRuntime();
      registerPreparedRuntime(pi.api, runtime);
      await pi.startSession("startup");
      const target = pi.manager.appendEntry();
      const descendant = pi.manager.appendEntry();
      await writeFile(join(workspace, "a.txt"), "descendant");
      await pi.endTurn(0);

      // An unplanned landing protects this target while neither it nor its
      // ancestors has a checkpoint. It is therefore genuinely
      // blocked-missing, rather than a blocked slot pinning inherited state.
      await pi.landUnmanaged(target.id);

      let db = metadata();
      expect(
        checkpointState(db, pi.manager.sessionId, target.id),
      ).toBeUndefined();
      expect(checkpointIsBlocked(db, pi.manager.sessionId, target.id)).toBe(
        true,
      );
      db.close();

      expect(await pi.navigate(descendant.id)).toBe("done");
      expect(await pi.prepareNavigation(target.id)).toBe("ready");
      const authorityFailure = vi
        .spyOn(runtime.registrations, "assertActiveWorkspaceAuthority")
        .mockImplementationOnce(() => {
          throw new Error("injected arrival protection authority failure");
        });
      let summary: string;
      try {
        summary = await pi.commitPreparedSummary(target.id, true);
      } finally {
        authorityFailure.mockRestore();
      }
      const label = pi.manager.getLeafId()!;

      db = metadata();
      expect(checkpointIsBlocked(db, pi.manager.sessionId, target.id)).toBe(
        true,
      );
      const protectedSummaryState = checkpointState(
        db,
        pi.manager.sessionId,
        summary,
      );
      expect(protectedSummaryState).toBeUndefined();
      expect(checkpointIsBlocked(db, pi.manager.sessionId, summary)).toBe(true);
      expect(checkpointIsBlocked(db, pi.manager.sessionId, label)).toBe(false);
      db.close();
      expect(notified(pi, "commandTargetChanged")).toBe(true);
      expect(notified(pi, "sessionMissingProtected")).toBe(false);

      await writeFile(join(workspace, "a.txt"), "unassigned-summary-edit");
      await pi.endTurn(0);
      db = metadata();
      expect(checkpointState(db, pi.manager.sessionId, summary)).toEqual(
        protectedSummaryState,
      );
      expect(checkpointIsBlocked(db, pi.manager.sessionId, summary)).toBe(true);
      db.close();
    });

    it("anchors label-active captures at a stable parent across Pi's fork rewrite", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first } = await twoStates(pi);
      expect(await pi.prepareNavigation(first)).toBe("ready");
      const summary = await pi.commitPreparedSummary(first, true);
      const oldLabel = pi.manager.getLeafId()!;
      await writeFile(join(workspace, "a.txt"), "edited-at-label");

      expect(await pi.submitInput()).toBe("continued");

      let sourceDb = metadata();
      expect(
        checkpointState(sourceDb, pi.manager.sessionId, oldLabel),
      ).toBeUndefined();
      expect(
        checkpointState(sourceDb, pi.manager.sessionId, summary),
      ).toBeDefined();
      sourceDb.close();

      // Pi removes label entries, re-chains retained entries, and appends labels
      // with new ids when it creates a forked session.
      const source = pi.manager;
      const retained = [];
      let cursor: string | null = summary;
      while (cursor !== null) {
        const entry: FakeEntry = source.getEntry(cursor)!;
        retained.push(entry);
        cursor = entry.parentId;
      }
      retained.reverse();
      // This test constructs Pi's fork rewrite manually, so persist the same
      // public source graph the real host would make available at the fork
      // boundary before replacing the manager.
      await pi.persistSession();
      const fork = new FakeSessionManager(
        "fork-rewritten",
        join(home, "fork-rewritten.jsonl"),
        workspace,
        source.getSessionFile()!,
      );
      let parentId: string | null = null;
      for (const entry of retained) {
        if (entry.type === "label") continue;
        fork.entries.set(entry.id, { ...entry, parentId });
        parentId = entry.id;
      }
      const newLabel = {
        id: "rewritten-label",
        parentId,
        timestamp: new Date().toISOString(),
        type: "label" as const,
      };
      fork.entries.set(newLabel.id, newLabel);
      fork.setLeaf(newLabel.id);
      await pi.replaceSession(
        fork,
        registerCyclotomy,
        "fork",
        source.getSessionFile(),
      );
      await writeFile(join(workspace, "a.txt"), "fork-drift");

      await pi.runCommand("restore");

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "edited-at-label",
      );
      sourceDb = metadata();
      expect(checkpointState(sourceDb, fork.sessionId, summary)).toBeDefined();
      expect(
        checkpointState(sourceDb, fork.sessionId, newLabel.id),
      ).toBeUndefined();
      sourceDb.close();
    });
  });

  describe("tree navigation arrival and commit", () => {
    it("keeps a completed inherited arrival admitted when only lock cleanup fails", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "source-old");
      await pi.endTurn();
      const source = pi.manager.getLeafId()!;
      const child = pi.manager.appendEntry();
      pi.manager.setLeaf(source);
      await writeFile(join(workspace, "a.txt"), "source-current");
      const cleanupFailure = failWorkspaceLockCleanup(
        "tree-arrival",
        new Error("arrival lock release failed"),
      );

      try {
        expect(await pi.navigate(child.id)).toBe("done");
      } finally {
        cleanupFailure.mockRestore();
      }

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "source-current",
      );
      const db = metadata();
      expect(
        checkpointState(db, pi.manager.sessionId, child.id),
      ).toBeUndefined();
      expect(checkpointIsBlocked(db, pi.manager.sessionId, child.id)).toBe(
        false,
      );
      db.close();
      expect(lastStatus(pi)).toBeUndefined();
      expect(
        pi.notifications.filter(({ message }) =>
          message.includes(messageFor("workspaceLockCleanupFailed")),
        ),
      ).toHaveLength(1);
    });

    it("settles a restored arrival when restoring status rendering throws", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first } = await twoStates(pi);
      let rendering: ReturnType<typeof throwTranslations> | undefined;
      pi.beforeTreeCommit = async () => {
        rendering = throwTranslations("restoringWorkspace");
      };

      try {
        expect(await pi.navigate(first)).toBe("done");
      } finally {
        rendering?.mockRestore();
        pi.beforeTreeCommit = undefined;
      }

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v1");
      const db = metadata();
      expect(checkpointIsBlocked(db, pi.manager.sessionId, first)).toBe(false);
      db.close();
    });

    it("settles an exact detached arrival when checking status rendering throws", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first } = await twoStates(pi);
      pi.selectionOverride = messageFor("choiceNavigationDetach");
      let rendering: ReturnType<typeof throwTranslations> | undefined;
      pi.beforeTreeCommit = async () => {
        rendering = throwTranslations("checkingWorkspace");
      };

      try {
        expect(await pi.navigate(first)).toBe("done");
      } finally {
        rendering?.mockRestore();
        pi.beforeTreeCommit = undefined;
      }

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v2");
      const db = metadata();
      expect(checkpointIsBlocked(db, pi.manager.sessionId, first)).toBe(true);
      db.close();
    });

    it("settles a node-free arrival with a barrier when checking status rendering throws", async () => {
      const pi = new FakePi(workspace);
      const runtime = await preparedRuntime();
      registerPreparedRuntime(pi.api, runtime);
      await pi.startSession("startup");
      const rootPrompt = pi.manager.appendEntry({
        type: "message",
        message: { role: "user" },
      });
      await writeFile(join(workspace, "a.txt"), "source-state");
      await pi.endTurn();

      let rendering: ReturnType<typeof throwTranslations> | undefined;
      let arrivalCheck: ReturnType<typeof vi.spyOn> | undefined;
      pi.beforeTreeCommit = async () => {
        rendering = throwTranslations("checkingWorkspace");
        arrivalCheck = vi
          .spyOn(runtime.admission, "arrivalCanProceed")
          .mockReturnValueOnce(false);
      };

      try {
        expect(await pi.navigate(rootPrompt.id)).toBe("done");
      } finally {
        arrivalCheck?.mockRestore();
        rendering?.mockRestore();
        pi.beforeTreeCommit = undefined;
      }

      expect(pi.manager.getLeafId()).toBeNull();
      const db = metadata();
      expect(
        captureBarrier(db, pi.manager.sessionId, pi.manager.getSessionFile()!),
      ).toBe(true);
      db.close();
    });

    it("leaves a harmless source capture when a later tree hook cancels", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first, second } = await twoStates(pi);
      const before = metadata();
      const sourceBefore = checkpointState(
        before,
        pi.manager.sessionId,
        second,
      )!;
      before.close();
      await writeFile(join(workspace, "a.txt"), "cancelled-by-later-hook");
      pi.selectionOverride = messageFor("choiceNavigationDetach");
      pi.api.on("session_before_tree", async () => ({ cancel: true }));

      expect(await pi.navigate(first)).toBe("cancelled");

      const after = metadata();
      expect(
        checkpointState(after, pi.manager.sessionId, second)?.treeOid,
      ).not.toBe(sourceBefore.treeOid);
      expect(checkpointIsBlocked(after, pi.manager.sessionId, first)).toBe(
        false,
      );
      after.close();
    });

    it("keeps event-gap edits unassigned after Detached navigation", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first, second } = await twoStates(pi);
      const before = metadata();
      const targetBefore = checkpointState(
        before,
        pi.manager.sessionId,
        first,
      )!;
      const sourceBefore = checkpointState(
        before,
        pi.manager.sessionId,
        second,
      )!;
      before.close();
      pi.selectionOverride = messageFor("choiceNavigationDetach");
      pi.beforeTreeCommit = async () => {
        await writeFile(join(workspace, "a.txt"), "event-gap");
      };

      expect(await pi.navigate(first)).toBe("done");

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "event-gap",
      );
      const after = metadata();
      expect(checkpointState(after, pi.manager.sessionId, second)).toEqual(
        sourceBefore,
      );
      expect(checkpointState(after, pi.manager.sessionId, first)).toEqual(
        targetBefore,
      );
      expect(checkpointIsBlocked(after, pi.manager.sessionId, first)).toBe(
        true,
      );
      after.close();
      expect(notified(pi, "navigationDetached")).toBe(true);
      expect(notified(pi, "navigationChangedAfterPreview")).toBe(false);
    });

    it("preserves a concurrently replaced destination before protecting it", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first, second } = await twoStates(pi);
      const before = metadata();
      const concurrentState = checkpointState(
        before,
        pi.manager.sessionId,
        second,
      )!;
      before.close();
      pi.selectionOverride = messageFor("choiceNavigationDetach");
      pi.beforeTreeCommit = async () => {
        const concurrent = metadata();
        commitTestNodeState(
          concurrent,
          pi.manager.sessionId,
          first,
          concurrentState.treeOid,
          pi.manager.getSessionFile(),
        );
        concurrent.close();
      };

      expect(await pi.navigate(first)).toBe("done");

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v2");
      const after = metadata();
      expect(checkpointState(after, pi.manager.sessionId, first)).toEqual(
        concurrentState,
      );
      expect(checkpointIsBlocked(after, pi.manager.sessionId, first)).toBe(
        true,
      );
      after.close();
      expect(notified(pi, "commandTargetChanged")).toBe(true);
      expect(notified(pi, "navigationDetached")).toBe(false);
      expect(lastStatus(pi)).toBe(messageFor("navigationAttentionStatus"));
    });

    it("retires an ambiguous tree proposal and cancels exactly one retry", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first } = await twoStates(pi);
      let vetoOnce = true;
      pi.api.on("session_before_tree", async () => {
        if (!vetoOnce) return undefined;
        vetoOnce = false;
        return { cancel: true };
      });

      expect(await pi.navigate(first)).toBe("cancelled");
      // Pi exposes no completion event when a later extension vetoes the
      // operation. The first retry can only retire the ambiguous proposal.
      expect(await pi.navigate(first)).toBe("cancelled");
      expect(await pi.navigate(first)).toBe("done");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v1");
    });

    it("does not treat a custom-trigger turn as proof that a vetoed tree operation ended", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first, second } = await twoStates(pi);
      pi.api.on("session_before_tree", async () => ({ cancel: true }));

      expect(await pi.navigate(first)).toBe("cancelled");
      await pi.sendCustomMessage("after-veto", true);
      await writeFile(join(workspace, "a.txt"), "custom-turn-state");
      await pi.endTurn();
      const child = pi.manager.getLeafId()!;

      const db = metadata();
      expect(checkpointState(db, pi.manager.sessionId, child)).toBeDefined();
      expect(
        checkpointState(db, pi.manager.sessionId, child)?.treeOid,
      ).not.toBe(checkpointState(db, pi.manager.sessionId, second)?.treeOid);
      expect(checkpointIsBlocked(db, pi.manager.sessionId, child)).toBe(false);
      db.close();
      expect(notified(pi, "captureLaterFailed")).toBe(false);

      await writeFile(join(workspace, "a.txt"), "later-drift");
      await pi.runCommand("restore");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "later-drift",
      );
      await pi.runCommand("restore");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "custom-turn-state",
      );
    });

    it("does not settle a prepare-only tree proposal from custom-trigger completion", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first, second } = await twoStates(pi);

      // Pi emits no session_tree when branch summarization is aborted after its
      // before hook. Running preparation without commit models that native gap.
      expect(await pi.prepareNavigation(first)).toBe("ready");
      await pi.sendCustomMessage("after-summary-abort", true);
      await writeFile(join(workspace, "a.txt"), "post-abort-turn-state");
      await pi.endTurn();
      const child = pi.manager.getLeafId()!;

      const db = metadata();
      expect(checkpointState(db, pi.manager.sessionId, child)).toBeDefined();
      expect(
        checkpointState(db, pi.manager.sessionId, child)?.treeOid,
      ).not.toBe(checkpointState(db, pi.manager.sessionId, second)?.treeOid);
      expect(checkpointIsBlocked(db, pi.manager.sessionId, child)).toBe(false);
      db.close();
      expect(notified(pi, "captureLaterFailed")).toBe(false);

      await writeFile(join(workspace, "a.txt"), "later-drift");
      await pi.runCommand("restore");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "later-drift",
      );
      await pi.runCommand("restore");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "post-abort-turn-state",
      );
    });

    it("raises a barrier for a torn late navigation arrival after restore mutation", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first, second } = await twoStates(pi);
      const before = metadata();
      const firstState = checkpointState(before, pi.manager.sessionId, first)!;
      const secondState = checkpointState(
        before,
        pi.manager.sessionId,
        second,
      )!;
      before.close();
      let leafSpy: ReturnType<typeof vi.spyOn> | undefined;
      pi.selectHook = async () => {
        const getLeafId = pi.manager.getLeafId.bind(pi.manager);
        leafSpy = vi.spyOn(pi.manager, "getLeafId").mockImplementation(() => {
          const actual = getLeafId();
          return actual === first &&
            readFileSync(join(workspace, "a.txt"), "utf8") === "v1"
            ? second
            : actual;
        });
      };

      try {
        expect(await pi.navigate(first)).toBe("done");

        expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v1");
        expect(notified(pi, "restorePostMutationLocationBarrier")).toBe(true);
        expect(lastStatus(pi)).toBe(messageFor("navigationAttentionStatus"));
        let db = metadata();
        expect(checkpointState(db, pi.manager.sessionId, first)).toEqual(
          firstState,
        );
        expect(checkpointIsBlocked(db, pi.manager.sessionId, first)).toBe(true);
        expect(checkpointState(db, pi.manager.sessionId, second)).toEqual(
          secondState,
        );
        expect(checkpointIsBlocked(db, pi.manager.sessionId, second)).toBe(
          false,
        );
        expect(
          captureBarrier(
            db,
            pi.manager.sessionId,
            pi.manager.getSessionFile()!,
          ),
        ).toBe(true);
        db.close();

        await pi.endTurn(0);
        db = metadata();
        expect(checkpointState(db, pi.manager.sessionId, second)).toEqual(
          secondState,
        );
        expect(checkpointIsBlocked(db, pi.manager.sessionId, second)).toBe(
          false,
        );
        expect(
          captureBarrier(
            db,
            pi.manager.sessionId,
            pi.manager.getSessionFile()!,
          ),
        ).toBe(true);
        db.close();
      } finally {
        leafSpy?.mockRestore();
      }
    });

    it("rejects an inactive graph rewrite before navigation restore mutation", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first, second } = await twoStates(pi);
      pi.manager.setLeaf(first);
      const inactive = pi.manager.appendEntry();
      pi.manager.setLeaf(second);

      const scanForScope =
        CyclotomyRuntime.prototype.scanCurrentWorkspaceForScope;
      let rewritten = false;
      const rewriteDuringArrivalScan = vi
        .spyOn(CyclotomyRuntime.prototype, "scanCurrentWorkspaceForScope")
        .mockImplementation(async function (
          this: CyclotomyRuntime,
          ...args: Parameters<CyclotomyRuntime["scanCurrentWorkspaceForScope"]>
        ) {
          const snapshot = await scanForScope.call(this, ...args);
          if (!rewritten && pi.manager.getLeafId() === first) {
            const entry = pi.manager.entries.get(inactive.id)!;
            pi.manager.entries.set(inactive.id, {
              ...entry,
              parentId: second,
            });
            rewritten = true;
          }
          return snapshot;
        });

      try {
        expect(await pi.navigate(first)).toBe("done");
      } finally {
        rewriteDuringArrivalScan.mockRestore();
      }

      expect(rewritten).toBe(true);
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v2");
      expect(notified(pi, "commandLocationChanged")).toBe(true);
      const db = metadata();
      expect(checkpointIsBlocked(db, pi.manager.sessionId, first)).toBe(true);
      db.close();
    });

    it("blocks the actual arrival when an earlier tree handler makes Pi busy", async () => {
      const pi = new FakePi(workspace);
      pi.api.on("session_tree", async () => {
        pi.idle = false;
      });
      registerCyclotomy(pi.api);
      const { first } = await twoStates(pi);
      const before = metadata();
      const firstSlot = before.getCheckpointSlot(pi.manager.sessionId, first);
      before.close();
      if (firstSlot.kind !== "open-checkpoint") {
        throw new Error("two-state fixture did not capture its first node");
      }

      try {
        expect(await pi.navigate(first)).toBe("done");
      } finally {
        pi.idle = true;
      }

      expect(pi.manager.getLeafId()).toBe(first);
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v2");
      expect(notified(pi, "transitionInProgress")).toBe(true);
      expect(lastStatus(pi)).toBe(messageFor("navigationAttentionStatus"));
      const db = metadata();
      expect(db.getCheckpointSlot(pi.manager.sessionId, first)).toEqual({
        kind: "blocked-checkpoint",
        treeOid: firstSlot.treeOid,
      });
      expect(
        db.hasSessionBarrier({
          sessionId: pi.manager.sessionId,
          sessionFile: pi.manager.getSessionFile()!,
        }),
      ).toBe(false);
      db.close();
    });

    it("rejects the mutation lease if Pi becomes busy after restore staging", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first } = await twoStates(pi);
      const before = metadata();
      const firstSlot = before.getCheckpointSlot(pi.manager.sessionId, first);
      before.close();
      if (firstSlot.kind !== "open-checkpoint") {
        throw new Error("two-state fixture did not capture its first node");
      }

      const store = await openObjectStore(storeRoot);
      const prototype = Object.getPrototypeOf(store) as Pick<
        ObjectStore,
        "readBlob"
      >;
      const original = prototype.readBlob;
      let staged = false;
      const readBlob = vi
        .spyOn(prototype, "readBlob")
        .mockImplementation(async function (this: ObjectStore, oid: string) {
          const content = await original.call(this, oid);
          staged = true;
          pi.idle = false;
          return content;
        });

      try {
        expect(await pi.navigate(first)).toBe("done");
      } finally {
        readBlob.mockRestore();
        pi.idle = true;
      }

      expect(staged).toBe(true);
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v2");
      expect(
        notifiedWithDetail(
          pi,
          "restoreNotStarted",
          "Pi became busy before tree workspace mutation",
        ),
      ).toBe(true);
      expect(lastStatus(pi)).toBe(messageFor("navigationAttentionStatus"));
      const db = metadata();
      expect(db.getCheckpointSlot(pi.manager.sessionId, first)).toEqual({
        kind: "blocked-checkpoint",
        treeOid: firstSlot.treeOid,
      });
      db.close();
    });

    it("revalidates Pi after apply's asynchronous preflight and before its first write", async () => {
      const pi = new FakePi(workspace);
      const probePath = join(workspace, ".file-handle-prototype-probe");
      const probe = await open(probePath, "w");
      const prototype = Object.getPrototypeOf(probe) as {
        readFile(): Promise<Buffer>;
      };
      await probe.close();
      await rm(probePath);
      const originalReadFile = prototype.readFile;
      let readCount = 0;
      let releaseApplyRead: (() => void) | undefined;
      const applyReadReleased = new Promise<void>((resolve) => {
        releaseApplyRead = resolve;
      });
      let observeApplyRead: (() => void) | undefined;
      let applyReadTimer: NodeJS.Timeout | undefined;
      const applyReadObserved = new Promise<void>((resolve, reject) => {
        applyReadTimer = setTimeout(
          () => reject(new Error("apply did not reach its staged-blob read")),
          30_000,
        );
        observeApplyRead = () => {
          clearTimeout(applyReadTimer);
          applyReadTimer = undefined;
          resolve();
        };
      });
      let readFileSpy: ReturnType<typeof vi.spyOn> | undefined;
      // Install only after Pi has committed the tree arrival. Source capture
      // and every pre-arrival phase are therefore outside the probe.
      pi.api.on("session_tree", async () => {
        readFileSpy = vi
          .spyOn(prototype, "readFile")
          .mockImplementation(async function (this: FileHandle) {
            readCount += 1;
            // Object-store authentication is bounded and no longer uses an
            // unbounded FileHandle.readFile(). This first such read is apply
            // consuming the private staged blob, after its asynchronous
            // preflight and before any workspace mutation is possible.
            if (readCount === 1) {
              observeApplyRead?.();
              await applyReadReleased;
            }
            return originalReadFile.call(this);
          });
      });
      registerCyclotomy(pi.api);
      const { first } = await twoStates(pi);
      const before = metadata();
      const firstSlot = before.getCheckpointSlot(pi.manager.sessionId, first);
      before.close();
      if (firstSlot.kind !== "open-checkpoint") {
        throw new Error("two-state fixture did not capture its first node");
      }

      const navigating = pi.navigate(first);
      try {
        await applyReadObserved;
        expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v2");
        pi.idle = false;
        releaseApplyRead?.();
        expect(await navigating).toBe("done");
      } finally {
        if (applyReadTimer !== undefined) clearTimeout(applyReadTimer);
        releaseApplyRead?.();
        readFileSpy?.mockRestore();
        pi.idle = true;
      }

      expect(pi.manager.getLeafId()).toBe(first);
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v2");
      expect(
        notifiedWithDetail(
          pi,
          "restoreNotStarted",
          "Pi became busy before tree workspace mutation",
        ),
      ).toBe(true);
      expect(lastStatus(pi)).toBe(messageFor("navigationAttentionStatus"));
      const db = metadata();
      expect(db.getCheckpointSlot(pi.manager.sessionId, first)).toEqual({
        kind: "blocked-checkpoint",
        treeOid: firstSlot.treeOid,
      });
      db.close();
    });

    it("preserves a completed navigation outcome when post-restore admission throws", async () => {
      const pi = new FakePi(workspace);
      const runtime = await preparedRuntime();
      registerPreparedRuntime(pi.api, runtime);
      const { first } = await twoStates(pi);
      const before = metadata();
      const firstState = checkpointState(before, pi.manager.sessionId, first)!;
      before.close();

      const original =
        WorkspaceMutationAuthority.prototype.admitLocationIfResolution;
      let rejectTargetAdmission = true;
      const admissionFailure = vi
        .spyOn(
          WorkspaceMutationAuthority.prototype,
          "admitLocationIfResolution",
        )
        .mockImplementation(function (
          this: WorkspaceMutationAuthority,
          view,
          resolution,
        ) {
          if (
            rejectTargetAdmission &&
            resolution?.treeOid === firstState.treeOid &&
            pi.manager.getLeafId() === first &&
            readFileSync(join(workspace, "a.txt"), "utf8") === "v1"
          ) {
            rejectTargetAdmission = false;
            throw new Error("post-restore admission failed");
          }
          return original.call(this, view, resolution);
        });
      const recoveryAdmissionFailure = vi
        .spyOn(runtime.admission, "admit")
        .mockImplementationOnce(() => {
          throw new Error("recovery admission failed");
        });

      try {
        expect(await pi.navigate(first)).toBe("done");
      } finally {
        recoveryAdmissionFailure.mockRestore();
        admissionFailure.mockRestore();
      }

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v1");
      expect(
        notifiedWithDetail(
          pi,
          "restorePostMutationControlProtected",
          "post-restore admission failed",
        ),
      ).toBe(true);
      expect(
        pi.notifications.filter(({ message }) =>
          message.includes(messageFor("arrivalAdmissionUnavailable")),
        ),
      ).toHaveLength(1);
      expect(
        notifiedWithDetail(
          pi,
          "arrivalAdmissionUnavailable",
          "recovery admission failed",
        ),
      ).toBe(true);
      expect(notified(pi, "restoreSuccessOne")).toBe(true);
      expect(lastStatus(pi)).toBe(messageFor("navigationAttentionStatus"));
      const db = metadata();
      expect(checkpointState(db, pi.manager.sessionId, first)).toEqual(
        firstState,
      );
      expect(checkpointIsBlocked(db, pi.manager.sessionId, first)).toBe(true);
      db.close();
    });

    it("never attributes an earlier arrival handler's target edit to source", async () => {
      const pi = new FakePi(workspace);
      pi.api.on("session_tree", async () => {
        await writeFile(
          join(workspace, "a.txt"),
          "written-by-earlier-target-handler",
        );
        pi.manager.appendEntry({ type: "label" });
      });
      registerCyclotomy(pi.api);
      const { first, second } = await twoStates(pi);
      await writeFile(join(workspace, "a.txt"), "source-before-navigation");

      expect(await pi.navigate(first)).toBe("done");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "written-by-earlier-target-handler",
      );
      expect(notified(pi, "navigationPlanMismatch")).toBe(true);

      pi.manager.setLeaf(second);
      await pi.runCommand("restore");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "source-before-navigation",
      );
    });

    it("does not backflow a later arrival handler after target restore", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      pi.api.on("session_tree", async () => {
        await writeFile(join(workspace, "a.txt"), "later-target-handler");
      });
      const { first, second } = await twoStates(pi);

      expect(await pi.navigate(first)).toBe("done");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "later-target-handler",
      );
      pi.manager.setLeaf(second);
      await pi.runCommand("restore");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v2");
    });

    it("never backflows event-gap changes to source and refuses stale auto-restore", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first, second } = await twoStates(pi);
      pi.beforeTreeCommit = async () => {
        await writeFile(join(workspace, "a.txt"), "gap-edit");
      };

      expect(await pi.navigate(first)).toBe("done");

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("gap-edit");
      expect(notified(pi, "navigationChangedAfterPreview")).toBe(true);
      expect(lastStatus(pi)).toBe(messageFor("navigationAttentionStatus"));
      const db = metadata();
      const secondAfter = checkpointState(db, pi.manager.sessionId, second)!;
      const firstState = checkpointState(db, pi.manager.sessionId, first)!;
      expect(secondAfter.treeOid).not.toBe(firstState.treeOid);
      db.close();
      pi.beforeTreeCommit = undefined;
      await pi.runCommand("restore");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v1");
      pi.manager.setLeaf(second);
      await pi.runCommand("restore");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v2");
      expect(lastStatus(pi)).toBeUndefined();
    });

    it("commits the prepared source without switching stores when cwd is retargeted", async (context) => {
      context.skip(
        process.platform === "win32",
        "Windows symlink creation is privilege-dependent",
      );
      const firstRoot = join(workspace, "first-root");
      const secondRoot = join(workspace, "second-root");
      const linkedRoot = join(workspace, "linked-root");
      await Promise.all([mkdir(firstRoot), mkdir(secondRoot)]);
      await symlink(firstRoot, linkedRoot);
      const pi = new FakePi(linkedRoot);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(firstRoot, "a.txt"), "v1");
      await pi.endTurn();
      const first = pi.manager.getLeafId()!;
      await writeFile(join(firstRoot, "a.txt"), "v2");
      await pi.endTurn();
      const source = pi.manager.getLeafId()!;
      const firstHash = createHash("sha256")
        .update(await realpath(firstRoot))
        .digest("hex");
      const firstStore = join(home, "cyclotomy", firstHash);
      let db = createCurrentMetadataStore(join(firstStore, "state.db"));
      const before = checkpointState(db, pi.manager.sessionId, source)!;
      db.close();
      await writeFile(join(firstRoot, "a.txt"), "prepared-source");
      await writeFile(join(secondRoot, "outside.txt"), "outside");
      pi.beforeTreeCommit = async () => {
        await rm(linkedRoot);
        await symlink(secondRoot, linkedRoot);
      };

      expect(await pi.navigate(first)).toBe("done");

      expect(await readFile(join(firstRoot, "a.txt"), "utf8")).toBe(
        "prepared-source",
      );
      expect(await readFile(join(secondRoot, "outside.txt"), "utf8")).toBe(
        "outside",
      );
      db = createCurrentMetadataStore(join(firstStore, "state.db"));
      expect(
        checkpointState(db, pi.manager.sessionId, source)?.treeOid,
      ).not.toBe(before.treeOid);
      db.close();
      const secondHash = createHash("sha256")
        .update(await realpath(secondRoot))
        .digest("hex");
      await expect(
        stat(join(home, "cyclotomy", secondHash, "state.db")),
      ).rejects.toThrow();
    });

    it("keeps the verified source independent of arrival process state", async (context) => {
      context.skip(
        process.platform === "win32",
        "the test uses a POSIX executable shim",
      );
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first, second } = await twoStates(pi);
      const beforeDb = metadata();
      const before = checkpointState(beforeDb, pi.manager.sessionId, second)!;
      beforeDb.close();
      await writeFile(join(workspace, "a.txt"), "prepared-before-scan-error");
      const fakeBin = join(workspace, "fake-bin");
      await mkdir(fakeBin);
      const fakeGit = join(fakeBin, "git");
      await writeFile(fakeGit, "#!/bin/sh\nexit 2\n");
      await chmod(fakeGit, 0o755);
      const originalPath = process.env.PATH;
      pi.beforeTreeCommit = async () => {
        process.env.PATH = fakeBin;
      };

      try {
        expect(await pi.navigate(first)).toBe("done");
      } finally {
        process.env.PATH = originalPath;
      }

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v1");
      const afterDb = metadata();
      expect(
        checkpointState(afterDb, pi.manager.sessionId, second)?.treeOid,
      ).not.toBe(before.treeOid);
      afterDb.close();
      pi.manager.setLeaf(second);
      await pi.runCommand("restore");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "prepared-before-scan-error",
      );
    });

    it("never guesses on an unplanned tree arrival", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first } = await twoStates(pi);
      const dbBefore = metadata();
      const targetBefore = checkpointState(
        dbBefore,
        pi.manager.sessionId,
        first,
      );
      dbBefore.close();

      await pi.landUnmanaged(first);

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v2");
      const dbAfter = metadata();
      expect(checkpointState(dbAfter, pi.manager.sessionId, first)).toEqual(
        targetBefore,
      );
      dbAfter.close();
      expect(notified(pi, "navigationPlanMismatch")).toBe(true);
    });

    it.each([
      "view-read",
      "temporarily-unusable",
      "matcher-accessor",
      "protection-lock",
      "protection-cleanup",
    ] as const)(
      "preserves an existing descendant checkpoint after a %s arrival failure",
      async (fault) => {
        const pi = new FakePi(workspace);
        const runtime = await preparedRuntime();
        let poisonMatcher = false;
        if (fault === "matcher-accessor") {
          pi.api.on("session_tree", async (event) => {
            if (!poisonMatcher) return;
            poisonMatcher = false;
            Object.defineProperty(event as object, "newLeafId", {
              configurable: true,
              get() {
                throw new Error("injected arrival matcher accessor failure");
              },
            });
          });
        }
        registerPreparedRuntime(pi.api, runtime);
        const { first, second } = await twoStates(pi);
        expect(await pi.navigate(first)).toBe("done");
        expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v1");

        const before = metadata();
        const targetBefore = checkpointState(
          before,
          pi.manager.sessionId,
          second,
        )!;
        before.close();

        const spies: Array<{ mockRestore(): void }> = [];
        pi.beforeTreeCommit = async () => {
          if (
            fault === "view-read" ||
            fault === "protection-lock" ||
            fault === "protection-cleanup"
          ) {
            spies.push(
              vi.spyOn(pi.manager, "getEntries").mockImplementationOnce(() => {
                throw new Error("injected arrival snapshot failure");
              }),
            );
          }
          if (fault === "temporarily-unusable") {
            spies.push(
              vi
                .spyOn(runtime.registrations, "sessionIsUsable")
                .mockImplementationOnce(() => false),
            );
          }
          if (fault === "protection-lock") {
            spies.push(
              vi
                .spyOn(CyclotomyRuntime.prototype, "enqueueWorkspaceExecution")
                .mockRejectedValueOnce(
                  new Error("injected protection lock acquisition failure"),
                ),
            );
          }
          if (fault === "protection-cleanup") {
            spies.push(
              failWorkspaceLockCleanup(
                "recover-uncertain-location",
                new Error("injected protection lock cleanup failure"),
              ),
            );
          }
          poisonMatcher = fault === "matcher-accessor";
        };

        try {
          expect(await pi.navigate(second)).toBe("done");
        } finally {
          for (const spy of spies) spy.mockRestore();
          pi.beforeTreeCommit = undefined;
        }

        // The failed arrival left v1 live at an existing v2 coordinate. A
        // successful recovery closes it durably; unavailable recovery instead
        // retires the runtime so no later capture can rewrite the checkpoint.
        await pi.endTurn(0);
        const after = metadata();
        expect(checkpointState(after, pi.manager.sessionId, second)).toEqual(
          targetBefore,
        );
        expect(checkpointIsBlocked(after, pi.manager.sessionId, second)).toBe(
          fault !== "protection-lock",
        );
        after.close();
        if (fault === "protection-lock" || fault === "protection-cleanup") {
          expect(runtime.activation.kind).toBe("unavailable");
        } else {
          expect(runtime.activation.kind).toBe("active");
        }
        if (fault === "protection-lock") {
          const unavailable = pi.notifications.find(({ message }) =>
            message.includes(messageFor("arrivalProtectionUnavailable")),
          );
          expect(unavailable?.level).toBe("error");
        } else if (fault === "protection-cleanup") {
          expect(notified(pi, "workspaceLockCleanupFailed")).toBe(true);
        }
      },
    );

    it("does not inherit live workspace state from a protected source", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      const ancestor = pi.manager.appendEntry();
      pi.manager.appendEntry();
      await writeFile(join(workspace, "a.txt"), "descendant");
      await pi.endTurn(0);

      await pi.landUnmanaged(ancestor.id);

      let db = metadata();
      expect(
        checkpointState(db, pi.manager.sessionId, ancestor.id),
      ).toBeUndefined();
      expect(checkpointIsBlocked(db, pi.manager.sessionId, ancestor.id)).toBe(
        true,
      );
      db.close();
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "descendant",
      );
      expect(notified(pi, "navigationPlanMismatch")).toBe(true);

      const child = pi.manager.appendEntry();
      pi.manager.setLeaf(ancestor.id);
      expect(await pi.navigate(child.id)).toBe("done");

      db = metadata();
      expect(
        checkpointState(db, pi.manager.sessionId, ancestor.id),
      ).toBeUndefined();
      expect(
        checkpointState(db, pi.manager.sessionId, child.id),
      ).toBeUndefined();
      expect(checkpointIsBlocked(db, pi.manager.sessionId, child.id)).toBe(
        true,
      );
      db.close();
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "descendant",
      );
      expect(notified(pi, "sessionMissingProtected")).toBe(true);
    });

    it("keeps a guarded missing node unassigned across a cold runtime restart", async () => {
      const firstHost = new FakePi(workspace);
      registerCyclotomy(firstHost.api);
      await firstHost.startSession("startup");
      const ancestor = firstHost.manager.appendEntry();
      firstHost.manager.appendEntry();
      await writeFile(join(workspace, "a.txt"), "unassigned-current");
      await firstHost.endTurn(0);

      await firstHost.landUnmanaged(ancestor.id);
      let db = metadata();
      expect(
        checkpointState(db, firstHost.manager.sessionId, ancestor.id),
      ).toBeUndefined();
      expect(
        checkpointIsBlocked(db, firstHost.manager.sessionId, ancestor.id),
      ).toBe(true);
      db.close();

      const persistedSession = firstHost.manager;
      await firstHost.dispose();
      const restarted = new FakePi(workspace);
      restarted.manager = persistedSession;
      registerCyclotomy(restarted.api);

      await restarted.startSession("startup");
      // A normal capture boundary must also retain the durable classification,
      // rather than treating it as an unknown fresh node on the first event.
      await restarted.endTurn(0);

      db = metadata();
      expect(
        checkpointState(db, restarted.manager.sessionId, ancestor.id),
      ).toBeUndefined();
      expect(
        checkpointIsBlocked(db, restarted.manager.sessionId, ancestor.id),
      ).toBe(true);
      db.close();
      expect(notified(restarted, "sessionMissingProtected")).toBe(true);
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "unassigned-current",
      );

      restarted.notifications.length = 0;
      await restarted.replaceRuntime(registerCyclotomy, "reload");
      expect(notified(restarted, "sessionMissingProtected")).toBe(true);

      await restarted.runCommand("drift");
      expect(notified(restarted, "driftMissingProtected")).toBe(true);
      db = metadata();
      expect(
        checkpointState(db, restarted.manager.sessionId, ancestor.id),
      ).toBeUndefined();
      expect(
        checkpointIsBlocked(db, restarted.manager.sessionId, ancestor.id),
      ).toBe(true);
      db.close();

      await restarted.runCommand("restore");

      db = metadata();
      expect(
        checkpointState(db, restarted.manager.sessionId, ancestor.id),
      ).toBeDefined();
      expect(
        checkpointIsBlocked(db, restarted.manager.sessionId, ancestor.id),
      ).toBe(false);
      db.close();
      expect(notified(restarted, "restoreInitialized")).toBe(true);
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "unassigned-current",
      );
    });

    it("does not admit a different arrival after guarded-node adoption", async () => {
      const pi = new FakePi(workspace);
      const runtime = await preparedRuntime();
      registerPreparedRuntime(pi.api, runtime);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "ancestor-state");
      await pi.endTurn();
      const lateArrival = pi.manager.getLeafId()!;
      const intended = pi.manager.appendEntry();
      await writeFile(join(workspace, "a.txt"), "intended-first-state");

      let db = metadata();
      const lateArrivalState = checkpointState(
        db,
        pi.manager.sessionId,
        lateArrival,
      )!;
      expect(
        protectTestLocation(
          db,
          {
            sessionId: pi.manager.sessionId,
            sessionFile: pi.manager.getSessionFile()!,
          },
          intended.id,
        ).kind,
      ).toBe("protected");
      db.close();

      const metadataStore = runtime.metadata;
      const original = metadataStore.adoptBlockedMissing.bind(metadataStore);
      const raced = vi
        .spyOn(metadataStore, "adoptBlockedMissing")
        .mockImplementationOnce((input) => {
          expect(input.entryId).toBe(intended.id);
          const result = original(input);
          pi.manager.setLeaf(lateArrival);
          return result;
        });

      try {
        await pi.runCommand("restore");
      } finally {
        raced.mockRestore();
      }

      db = metadata();
      expect(
        checkpointState(db, pi.manager.sessionId, intended.id),
      ).toBeDefined();
      expect(checkpointState(db, pi.manager.sessionId, lateArrival)).toEqual(
        lateArrivalState,
      );
      expect(checkpointIsBlocked(db, pi.manager.sessionId, lateArrival)).toBe(
        true,
      );
      db.close();
      expect(notified(pi, "checkpointInitializedConflictProtected")).toBe(true);
      expect(notified(pi, "restoreInitialized")).toBe(false);

      await pi.endTurn(0);
      db = metadata();
      expect(checkpointState(db, pi.manager.sessionId, lateArrival)).toEqual(
        lateArrivalState,
      );
      expect(checkpointIsBlocked(db, pi.manager.sessionId, lateArrival)).toBe(
        true,
      );
      db.close();
    });

    it("materializes a guarded missing node without adopting a later ancestor state", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      const ancestor = pi.manager.appendEntry();
      const target = pi.manager.appendEntry();
      pi.manager.setLeaf(null);
      const rootPrompt = pi.manager.appendEntry({
        type: "message",
        message: { role: "user" },
      });
      await writeFile(join(workspace, "a.txt"), "unplanned-target");

      // Neither the target nor any of its ancestry owns a checkpoint when the
      // unplanned arrival makes the target fail-closed.
      await pi.landUnmanaged(target.id);
      let db = metadata();
      expect(
        checkpointState(db, pi.manager.sessionId, ancestor.id),
      ).toBeUndefined();
      expect(
        checkpointState(db, pi.manager.sessionId, target.id),
      ).toBeUndefined();
      expect(checkpointIsBlocked(db, pi.manager.sessionId, target.id)).toBe(
        true,
      );
      db.close();

      // Leave through Pi's root-prompt landing, then give only the ancestor a
      // state. The older target must remain truly missing despite inheritance.
      expect(await pi.navigate(rootPrompt.id)).toBe("done");
      expect(pi.manager.getLeafId()).toBeNull();
      await writeFile(join(workspace, "a.txt"), "ancestor-state");
      expect(await pi.navigate(ancestor.id)).toBe("done");

      await writeFile(join(workspace, "a.txt"), "later-ancestor-state");
      expect(await pi.navigate(target.id)).toBe("done");
      db = metadata();
      const ancestorState = checkpointState(
        db,
        pi.manager.sessionId,
        ancestor.id,
      );
      expect(ancestorState).toBeDefined();
      expect(
        checkpointState(db, pi.manager.sessionId, target.id),
      ).toBeUndefined();
      expect(checkpointIsBlocked(db, pi.manager.sessionId, target.id)).toBe(
        true,
      );
      db.close();

      // With no effective restore target, explicit restore adopts the current
      // workspace as this node's first exact state and retires its guard.
      await writeFile(join(workspace, "a.txt"), "target-current");
      await pi.runCommand("restore");
      db = metadata();
      const targetState = checkpointState(db, pi.manager.sessionId, target.id);
      expect(targetState).toBeDefined();
      expect(targetState?.treeOid).not.toBe(ancestorState?.treeOid);
      expect(checkpointIsBlocked(db, pi.manager.sessionId, target.id)).toBe(
        false,
      );
      db.close();

      await writeFile(join(workspace, "a.txt"), "target-drift");
      await pi.runCommand("restore");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "target-current",
      );
    });

    it("retires Cyclotomy and lets Pi navigate when the authoritative target is corrupt", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first, second } = await twoStates(pi);
      const db = metadata();
      const target = checkpointState(db, pi.manager.sessionId, second)!;
      db.close();
      await rm(
        join(
          storeRoot,
          "objects",
          "trees",
          target.treeOid.slice(0, 2),
          target.treeOid.slice(2),
        ),
      );
      await writeFile(join(workspace, "a.txt"), "v3");
      await pi.endTurn();

      expect(await pi.navigate(second)).toBe("done");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v3");
      expect(
        notifiedWithDetail(
          pi,
          "navigationPrepareFailed",
          "tree object does not exist",
        ),
      ).toBe(true);
      // A readable older ancestor state exists, but corruption of the nearest
      // authoritative slot is never silently downgraded to inheriting it.
      const readable = metadata();
      expect(
        checkpointState(readable, pi.manager.sessionId, first),
      ).toBeDefined();
      readable.close();
    });

    it("round-trips an exact descendant through a missing ancestor and a cold start", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      const ancestor = pi.manager.appendEntry();
      await writeFile(join(workspace, "a.txt"), "child-state");
      await pi.endTurn();
      const descendant = pi.manager.getLeafId()!;
      await writeFile(join(workspace, "a.txt"), "source-edit");

      expect(await pi.navigate(ancestor.id)).toBe("done");

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "source-edit",
      );
      let db = metadata();
      expect(
        checkpointState(db, pi.manager.sessionId, ancestor.id),
      ).toBeDefined();
      expect(
        checkpointState(db, pi.manager.sessionId, descendant),
      ).toBeDefined();
      db.close();

      // A genuinely new runtime at the newly materialized ancestor observes
      // an ordinary matching checkpoint and neither restores nor asks.
      const persistedSession = pi.manager;
      await pi.dispose();
      const restarted = new FakePi(workspace);
      restarted.manager = persistedSession;
      registerCyclotomy(restarted.api);
      await restarted.startSession("startup");
      expect(restarted.selections).toHaveLength(0);

      await writeFile(join(workspace, "a.txt"), "ancestor-edit");
      expect(await restarted.navigate(descendant)).toBe("done");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "source-edit",
      );
      expect(await restarted.navigate(ancestor.id)).toBe("done");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "ancestor-edit",
      );

      db = metadata();
      expect(
        checkpointState(db, restarted.manager.sessionId, ancestor.id),
      ).toBeDefined();
      expect(
        checkpointState(db, restarted.manager.sessionId, descendant),
      ).toBeDefined();
      db.close();
      expect(lastStatus(restarted)).toBeUndefined();
    });

    it("materializes a planned missing logical target, not its summary or label wrappers", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      const ancestor = pi.manager.appendEntry();
      await writeFile(join(workspace, "a.txt"), "descendant");
      await pi.endTurn();

      expect(await pi.prepareNavigation(ancestor.id)).toBe("ready");
      const summary = await pi.commitPreparedSummary(ancestor.id, true);
      const label = pi.manager.getLeafId()!;

      const db = metadata();
      expect(db.getCheckpointSlot(pi.manager.sessionId, ancestor.id).kind).toBe(
        "open-checkpoint",
      );
      expect(db.getCheckpointSlot(pi.manager.sessionId, summary)).toEqual({
        kind: "open-missing",
      });
      expect(db.getCheckpointSlot(pi.manager.sessionId, label)).toEqual({
        kind: "open-missing",
      });
      db.close();
      expect(notified(pi, "checkpointInitializedConflictProtected")).toBe(
        false,
      );
      expect(notified(pi, "checkpointInitializedConflictBarrier")).toBe(false);
      expect(notified(pi, "checkpointInitializedConflictUnavailable")).toBe(
        false,
      );
      expect(lastStatus(pi)).toBeUndefined();
    });

    it("does not admit a different arrival after planned target initialization", async () => {
      const pi = new FakePi(workspace);
      const runtime = await preparedRuntime();
      registerPreparedRuntime(pi.api, runtime);
      await pi.startSession("startup");
      const intended = pi.manager.appendEntry();
      await writeFile(join(workspace, "a.txt"), "source-state");
      await pi.endTurn();
      const lateArrival = pi.manager.getLeafId()!;
      const before = metadata();
      const lateArrivalState = checkpointState(
        before,
        pi.manager.sessionId,
        lateArrival,
      )!;
      before.close();

      const metadataStore = runtime.metadata;
      const original = metadataStore.commitCapture.bind(metadataStore);
      const raced = vi
        .spyOn(metadataStore, "commitCapture")
        .mockImplementation((input) => {
          const result = original(input);
          if (input.entryId === intended.id && result === "committed") {
            pi.manager.setLeaf(lateArrival);
          }
          return result;
        });
      const recoveryAdmissionFailure = vi
        .spyOn(runtime.admission, "admit")
        .mockImplementationOnce(() => {
          throw new Error("initialization recovery admission failed");
        });

      try {
        expect(await pi.navigate(intended.id)).toBe("done");
      } finally {
        recoveryAdmissionFailure.mockRestore();
        raced.mockRestore();
      }

      const db = metadata();
      expect(
        checkpointState(db, pi.manager.sessionId, intended.id),
      ).toBeDefined();
      expect(checkpointState(db, pi.manager.sessionId, lateArrival)).toEqual(
        lateArrivalState,
      );
      expect(checkpointIsBlocked(db, pi.manager.sessionId, lateArrival)).toBe(
        true,
      );
      db.close();
      expect(notified(pi, "checkpointInitializedConflictProtected")).toBe(true);
      expect(
        pi.notifications.filter(({ message }) =>
          message.includes(messageFor("arrivalAdmissionUnavailable")),
        ),
      ).toHaveLength(1);
      expect(
        notifiedWithDetail(
          pi,
          "arrivalAdmissionUnavailable",
          "initialization recovery admission failed",
        ),
      ).toBe(true);
      expect(lastStatus(pi)).toBe(messageFor("navigationAttentionStatus"));
    });

    it("reports a failed session-barrier admission exactly once for an initialization conflict", async () => {
      const pi = new FakePi(workspace);
      const runtime = await preparedRuntime();
      registerPreparedRuntime(pi.api, runtime);
      await pi.startSession("startup");
      const intended = pi.manager.appendEntry();
      await writeFile(join(workspace, "a.txt"), "source-state");
      await pi.endTurn();

      const admissionFailure = new Error("barrier admission failed");
      const admission = vi
        .spyOn(runtime.workspaceMutations, "admitTreeArrivalIfResolution")
        .mockReturnValueOnce({
          kind: "protected",
          evidence: {
            kind: "session-barrier",
            admission: { kind: "failed", cause: admissionFailure },
          },
        });

      try {
        expect(await pi.navigate(intended.id)).toBe("done");
      } finally {
        admission.mockRestore();
      }

      expect(notified(pi, "checkpointInitializedConflictBarrier")).toBe(true);
      const admissionNotifications = pi.notifications.filter(({ message }) =>
        message.includes(messageFor("arrivalAdmissionUnavailable")),
      );
      expect(admissionNotifications).toHaveLength(1);
      expect(admissionNotifications[0]?.message).toContain(
        "barrier admission failed",
      );
    });

    it("uses an authenticated root summary when the logical destination is null", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      const rootPrompt = pi.manager.appendEntry({
        type: "message",
        message: { role: "user" },
      });
      pi.manager.setLeaf(null);
      await writeFile(join(workspace, "a.txt"), "root-summary");

      expect(await pi.prepareNavigation(rootPrompt.id)).toBe("ready");
      const summary = await pi.commitPreparedSummary(rootPrompt.id, true);
      const label = pi.manager.getLeafId()!;

      const db = metadata();
      expect(
        checkpointState(db, pi.manager.sessionId, rootPrompt.id),
      ).toBeUndefined();
      expect(checkpointState(db, pi.manager.sessionId, summary)).toBeDefined();
      expect(checkpointState(db, pi.manager.sessionId, label)).toBeUndefined();
      db.close();
    });

    it("authenticates a root summary through arbitrary transparent wrapper chains", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      const rootPrompt = pi.manager.appendEntry({
        type: "message",
        message: { role: "user" },
      });
      pi.manager.setLeaf(null);
      await writeFile(join(workspace, "a.txt"), "wrapped-root-summary");

      expect(await pi.prepareNavigation(rootPrompt.id)).toBe("ready");
      const summary = await pi.commitPreparedSummary(rootPrompt.id, {
        beforeLabels: 2,
        afterLabels: 3,
      });
      const labels = pi.manager
        .getEntries()
        .filter((entry) => entry.type === "label")
        .map((entry) => entry.id);

      expect(labels).toHaveLength(5);
      const db = metadata();
      expect(
        checkpointState(db, pi.manager.sessionId, rootPrompt.id),
      ).toBeUndefined();
      expect(checkpointState(db, pi.manager.sessionId, summary)).toBeDefined();
      for (const label of labels) {
        expect(
          checkpointState(db, pi.manager.sessionId, label),
        ).toBeUndefined();
      }
      db.close();
    });

    it("rejects a summary event whose claimed wrapper disagrees with the trusted graph", async () => {
      const pi = new FakePi(workspace);
      let forged:
        | { readonly actualLeaf: string; readonly claimedParent: string }
        | undefined;
      pi.api.on("session_tree", async (event) => {
        if (forged === undefined) return;
        pi.manager.setLeaf(forged.actualLeaf);
        Object.defineProperty(event, "newLeafId", {
          configurable: true,
          value: forged.actualLeaf,
        });
        Object.defineProperty(event, "summaryEntry", {
          configurable: true,
          value: {
            id: forged.actualLeaf,
            parentId: forged.claimedParent,
          },
        });
      });
      registerCyclotomy(pi.api);
      const { first, second } = await twoStates(pi);
      const before = metadata();
      const secondState = checkpointState(
        before,
        pi.manager.sessionId,
        second,
      )!;
      before.close();

      expect(await pi.prepareNavigation(first)).toBe("ready");
      forged = { actualLeaf: second, claimedParent: first };
      await pi.commitPreparedSummary(first);

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v2");
      expect(notified(pi, "navigationPlanMismatch")).toBe(true);
      const after = metadata();
      expect(checkpointState(after, pi.manager.sessionId, second)).toEqual(
        secondState,
      );
      expect(checkpointIsBlocked(after, pi.manager.sessionId, second)).toBe(
        true,
      );
      after.close();
    });

    it("treats a root label without a summary as an admitted no-node arrival", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      const rootPrompt = pi.manager.appendEntry({
        type: "message",
        message: { role: "user" },
      });
      await writeFile(join(workspace, "a.txt"), "source-state");
      await pi.endTurn();
      const source = pi.manager.getLeafId()!;

      expect(await pi.prepareNavigation(rootPrompt.id)).toBe("ready");
      // Pi resets its leaf for the root editor point before appendLabelChange,
      // so a no-summary label is structurally rooted at null.
      pi.manager.setLeaf(null);
      const label = pi.manager.appendEntry({ type: "label" });
      pi.manager.setLeaf(source);
      await pi.landUnmanaged(label.id);

      let db = metadata();
      expect(
        captureBarrier(db, pi.manager.sessionId, pi.manager.getSessionFile()!),
      ).toBe(false);
      expect(
        checkpointState(db, pi.manager.sessionId, rootPrompt.id),
      ).toBeUndefined();
      expect(
        checkpointState(db, pi.manager.sessionId, label.id),
      ).toBeUndefined();
      db.close();
      expect(notified(pi, "navigationPlanMismatch")).toBe(false);
      expect(await pi.submitInput("continue-from-root")).toBe("continued");

      await writeFile(join(workspace, "a.txt"), "root-turn-state");
      await pi.endTurn();
      const child = pi.manager.getLeafId()!;
      db = metadata();
      expect(checkpointState(db, pi.manager.sessionId, child)).toBeDefined();
      expect(checkpointIsBlocked(db, pi.manager.sessionId, child)).toBe(false);
      db.close();
      expect(notified(pi, "captureLaterFailed")).toBe(false);
      expect(notified(pi, "sourceCaptureFailed")).toBe(false);
      expect(notified(pi, "inputCaptureFailed")).toBe(false);
    });

    it("never materializes a selected label id", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      const stable = pi.manager.appendEntry();
      const label = pi.manager.appendEntry({ type: "label" });
      await writeFile(join(workspace, "a.txt"), "descendant");
      await pi.endTurn();

      expect(await pi.navigate(label.id)).toBe("done");

      const db = metadata();
      expect(
        checkpointState(db, pi.manager.sessionId, stable.id),
      ).toBeDefined();
      expect(
        checkpointState(db, pi.manager.sessionId, label.id),
      ).toBeUndefined();
      db.close();
    });

    it("materializes the target-side observation made at committed arrival", async () => {
      const pi = new FakePi(workspace);
      let editArrival = false;
      pi.api.on("session_tree", async () => {
        if (editArrival) {
          await writeFile(join(workspace, "a.txt"), "target-handler-edit");
        }
      });
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      const ancestor = pi.manager.appendEntry();
      await writeFile(join(workspace, "a.txt"), "descendant-state");
      await pi.endTurn();
      const descendant = pi.manager.getLeafId()!;

      editArrival = true;
      expect(await pi.navigate(ancestor.id)).toBe("done");
      editArrival = false;
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "target-handler-edit",
      );

      expect(await pi.navigate(descendant)).toBe("done");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "descendant-state",
      );
      expect(await pi.navigate(ancestor.id)).toBe("done");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "target-handler-edit",
      );
    });

    it("scans only the target scope when leaving a protected source", async () => {
      await execFileAsync("git", ["-C", workspace, "init", "-q"]);
      await writeFile(join(workspace, ".gitignore"), "outside/\n");
      await writeFile(join(workspace, "a.txt"), "v1");
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await pi.endTurn();
      const target = pi.manager.getLeafId()!;
      await writeFile(join(workspace, "a.txt"), "v2");
      await pi.endTurn();
      const source = pi.manager.getLeafId()!;

      // Current policy sees both hard links and therefore cannot produce a
      // complete full-workspace snapshot. The target's archived policy excludes
      // their namespace, so they are irrelevant to restoring that checkpoint.
      await writeFile(join(workspace, ".gitignore"), "");
      await mkdir(join(workspace, "outside"));
      await writeFile(join(workspace, "outside", "hard-a"), "same inode");
      await link(
        join(workspace, "outside", "hard-a"),
        join(workspace, "outside", "hard-b"),
      );
      const fullScan = await scanWorkspace(workspace);
      expect(
        fullScan.problems
          .filter(({ kind }) => kind === "hardlink")
          .map(({ path }) => path),
      ).toEqual(["outside/hard-a", "outside/hard-b"]);

      pi.selectDestructive = false;
      await pi.replaceRuntime(registerCyclotomy, "resume");
      let db = metadata();
      expect(checkpointIsBlocked(db, pi.manager.sessionId, source)).toBe(true);
      db.close();

      pi.selectDestructive = true;
      expect(await pi.navigate(target)).toBe("done");

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("v1");
      expect(await readFile(join(workspace, ".gitignore"), "utf8")).toBe(
        "outside/\n",
      );
      expect(await readFile(join(workspace, "outside", "hard-b"), "utf8")).toBe(
        "same inode",
      );
      expect(notified(pi, "navigationScanIncomplete")).toBe(false);
      db = metadata();
      expect(checkpointIsBlocked(db, pi.manager.sessionId, source)).toBe(true);
      expect(checkpointIsBlocked(db, pi.manager.sessionId, target)).toBe(false);
      db.close();
    });

    it("retires Cyclotomy when a complete source snapshot is impossible", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      const { first } = await twoStates(pi);
      await writeFile(join(workspace, "hard-a"), "same inode");
      await link(join(workspace, "hard-a"), join(workspace, "hard-b"));

      await pi.runCommand("drift");
      expect(pi.notifications.at(-1)?.level).toBe("warning");
      expect(pi.notifications.at(-1)?.message)
        // Both hard links are reported, so the plural form is the expected one.
        .toContain(TEST_I18N.t("previewProblemMany", { count: 2 }));
      expect(pi.notifications.at(-1)?.message).toContain(
        messageFor("scanProblemHardlink"),
      );

      expect(await pi.navigate(first)).toBe("done");
      expect(pi.manager.getLeafId()).toBe(first);
      expect(notified(pi, "navigationScanIncomplete")).toBe(true);
    });
  });

  describe("idle input and custom messages", () => {
    it("carries admission across direct label and unlabel changes", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "baseline");
      await pi.endTurn();
      const firstStable = pi.manager.getLeafId()!;
      let db = metadata();
      const baselineOid = checkpointState(
        db,
        pi.manager.sessionId,
        firstStable,
      )!.treeOid;
      db.close();

      // Pi's label command changes only the raw leaf and emits no tree event.
      const firstLabel = pi.manager.appendEntry({ type: "label" });
      await writeFile(join(workspace, "a.txt"), "labelled-edit");
      expect(await pi.submitInput()).toBe("continued");

      db = metadata();
      expect(
        checkpointState(db, pi.manager.sessionId, firstStable)?.treeOid,
      ).not.toBe(baselineOid);
      expect(checkpointIsBlocked(db, pi.manager.sessionId, firstStable)).toBe(
        false,
      );
      expect(
        checkpointState(db, pi.manager.sessionId, firstLabel.id),
      ).toBeUndefined();
      db.close();

      // Establish the new stable node while its label is active, then model
      // Pi's unlabel command by returning the raw leaf without session_tree.
      const secondStable = pi.manager.getLeafId()!;
      await pi.endTurn(0);
      const secondLabel = pi.manager.appendEntry({ type: "label" });
      await pi.endTurn(0);
      db = metadata();
      const labelledOid = checkpointState(
        db,
        pi.manager.sessionId,
        secondStable,
      )!.treeOid;
      db.close();
      pi.manager.setLeaf(secondStable);
      await writeFile(join(workspace, "a.txt"), "unlabelled-edit");

      expect(await pi.submitInput()).toBe("continued");

      db = metadata();
      expect(
        checkpointState(db, pi.manager.sessionId, secondStable)?.treeOid,
      ).not.toBe(labelledOid);
      expect(checkpointIsBlocked(db, pi.manager.sessionId, secondStable)).toBe(
        false,
      );
      expect(
        checkpointState(db, pi.manager.sessionId, secondLabel.id),
      ).toBeUndefined();
      db.close();
    });

    it("captures between-turn edits before appending an idle prompt", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "turn");
      await pi.endTurn();
      const source = pi.manager.getLeafId()!;
      const before = metadata();
      const beforeOid = checkpointState(
        before,
        pi.manager.sessionId,
        source,
      )!.treeOid;
      before.close();
      await writeFile(join(workspace, "a.txt"), "between-turns");

      expect(await pi.submitInput()).toBe("continued");

      const after = metadata();
      expect(
        checkpointState(after, pi.manager.sessionId, source)!.treeOid,
      ).not.toBe(beforeOid);
      after.close();
    });

    it("captures idle custom-trigger messages at the safest observable hook", async () => {
      const pi = new FakePi(workspace);
      pi.api.on("message_end", async (event) => {
        if (
          (event as { message: { role: string } }).message.role === "custom"
        ) {
          await writeFile(join(workspace, "a.txt"), "earlier-custom-handler");
        }
      });
      registerCyclotomy(pi.api);
      pi.api.on("message_end", async (event) => {
        if (
          (event as { message: { role: string } }).message.role === "custom"
        ) {
          await writeFile(join(workspace, "a.txt"), "later-custom-handler");
        }
      });
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "turn");
      await pi.endTurn();
      const source = pi.manager.getLeafId()!;

      const custom = await pi.sendCustomMessage("trigger", true);
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "later-custom-handler",
      );
      const db = metadata();
      expect(checkpointState(db, pi.manager.sessionId, custom)).toBeUndefined();
      db.close();
      pi.manager.setLeaf(source);
      await pi.runCommand("restore");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "earlier-custom-handler",
      );
    });

    it("never backflows a later user message_end mutation to the parent", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      pi.api.on("message_end", async (event) => {
        if ((event as { message: { role: string } }).message.role === "user") {
          await writeFile(join(workspace, "a.txt"), "later-message-handler");
        }
      });
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "turn");
      await pi.endTurn();
      const source = pi.manager.getLeafId()!;
      await writeFile(join(workspace, "a.txt"), "before-input");

      expect(await pi.submitInput()).toBe("continued");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "later-message-handler",
      );
      pi.manager.setLeaf(source);
      await pi.runCommand("restore");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "before-input",
      );
    });

    it("keeps a harmless before-input capture when user persistence fails", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      const source = pi.manager.getLeafId()!;
      const before = metadata();
      const sourceBefore = checkpointState(
        before,
        pi.manager.sessionId,
        source,
      )!;
      before.close();
      await writeFile(join(workspace, "a.txt"), "not-persisted");
      pi.failUserMessagePersistence = true;

      await expect(pi.submitInput()).rejects.toThrow("persistence failure");
      // No post-append/context work can change the already-owned source capture.
      await pi.emitContext();

      const after = metadata();
      expect(
        checkpointState(after, pi.manager.sessionId, source)?.treeOid,
      ).not.toBe(sourceBefore.treeOid);
      after.close();
    });

    it("keeps a harmless source capture when a later input hook handles", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      const source = pi.manager.getLeafId()!;
      const before = metadata();
      const sourceBefore = checkpointState(
        before,
        pi.manager.sessionId,
        source,
      )!;
      before.close();
      await writeFile(join(workspace, "a.txt"), "not-accepted");
      pi.api.on("input", async () => ({ action: "handled" as const }));

      expect(await pi.submitInput()).toBe("handled");

      const after = metadata();
      expect(
        checkpointState(after, pi.manager.sessionId, source)?.treeOid,
      ).not.toBe(sourceBefore.treeOid);
      after.close();
    });
  });

  describe("compaction and metadata-only leaves", () => {
    it("pins auto-compaction at its stable metadata node", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "turn");
      await pi.endTurn();
      await writeFile(join(workspace, "a.txt"), "between-turns");
      let compactionLeaf: string | undefined;
      pi.afterUserMessageCommit = async () => {
        pi.idle = false;
        try {
          expect(await pi.compact("threshold")).toBe("done");
          compactionLeaf = pi.manager.getLeafId()!;
        } finally {
          pi.idle = true;
        }
      };

      expect(await pi.submitInput()).toBe("continued");

      const userLeaf = pi.manager.getLeafId()!;
      const db = metadata();
      expect(compactionLeaf).toBeDefined();
      expect(
        checkpointState(db, pi.manager.sessionId, compactionLeaf!),
      ).toBeDefined();
      expect(userLeaf).toBe(compactionLeaf);
      db.close();
    });

    it("captures both sides of compaction at their exact stable nodes", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "turn");
      await pi.endTurn();
      const source = pi.manager.getLeafId()!;
      await writeFile(join(workspace, "a.txt"), "before-compact");
      pi.statuses.set("cyclotomy", "stale navigation notice");

      expect(await pi.compact()).toBe("done");
      expect(lastStatus(pi)).toBeUndefined();

      const db = metadata();
      expect(checkpointState(db, pi.manager.sessionId, source)).toBeDefined();
      expect(
        checkpointState(db, pi.manager.sessionId, pi.manager.getLeafId()!),
      ).toBeDefined();
      db.close();
    });

    it("lets fire-and-forget metadata leaves inherit without parent backflow", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "turn");
      await pi.endTurn();
      const source = pi.manager.getLeafId()!;
      const before = metadata();
      const sourceBefore = checkpointState(
        before,
        pi.manager.sessionId,
        source,
      )!;
      before.close();

      await writeFile(join(workspace, "a.txt"), "before-model");
      const selected = await pi.selectModel("provider", "model", "high");
      await writeFile(join(workspace, "a.txt"), "before-thinking");
      const thinking = await pi.selectThinkingLevel("low");
      await writeFile(join(workspace, "a.txt"), "before-name");
      const sessionInfo = await pi.setSessionName("renamed");

      const db = metadata();
      expect(checkpointState(db, pi.manager.sessionId, source)).toEqual(
        sourceBefore,
      );
      expect(
        checkpointState(db, pi.manager.sessionId, selected.modelId),
      ).toBeUndefined();
      expect(
        checkpointState(db, pi.manager.sessionId, selected.thinkingId!),
      ).toBeUndefined();
      expect(
        checkpointState(db, pi.manager.sessionId, thinking),
      ).toBeUndefined();
      expect(
        checkpointState(db, pi.manager.sessionId, sessionInfo),
      ).toBeUndefined();
      db.close();

      pi.manager.setLeaf(source);
      await pi.runCommand("restore");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("turn");
    });

    it("does not guess when a metadata tail contains duplicate event matches", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "turn");
      await pi.endTurn();
      await writeFile(join(workspace, "a.txt"), "first-name-change");
      const firstInfo = await pi.setSessionName("same");
      await writeFile(join(workspace, "a.txt"), "ambiguous-second-change");

      await pi.setSessionName("same");

      const db = metadata();
      expect(
        checkpointState(db, pi.manager.sessionId, firstInfo),
      ).toBeUndefined();
      db.close();
    });

    it("assigns concurrent metadata-event edits only at the next safe hook", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      pi.api.on("session_info_changed", async () => {
        await writeFile(join(workspace, "a.txt"), "metadata-handler-edit");
      });
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "turn");
      await pi.endTurn();
      const source = pi.manager.getLeafId()!;
      const before = metadata();
      const sourceBefore = checkpointState(
        before,
        pi.manager.sessionId,
        source,
      )!;
      before.close();

      const metadataLeaf = await pi.setSessionName("concurrent");
      let db = metadata();
      expect(checkpointState(db, pi.manager.sessionId, source)).toEqual(
        sourceBefore,
      );
      expect(
        checkpointState(db, pi.manager.sessionId, metadataLeaf),
      ).toBeUndefined();
      db.close();

      expect(await pi.submitInput()).toBe("continued");
      db = metadata();
      expect(
        checkpointState(db, pi.manager.sessionId, metadataLeaf),
      ).toBeDefined();
      db.close();
      pi.manager.setLeaf(metadataLeaf);
      await pi.runCommand("restore");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "metadata-handler-edit",
      );
    });

    it("leaves a harmless capture when a later compaction hook cancels", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      const source = pi.manager.getLeafId()!;
      const before = metadata();
      const sourceBefore = checkpointState(
        before,
        pi.manager.sessionId,
        source,
      )!;
      before.close();
      await writeFile(join(workspace, "a.txt"), "not-compacted");
      pi.api.on("session_before_compact", async () => ({ cancel: true }));

      expect(await pi.compact()).toBe("cancelled");

      const after = metadata();
      expect(
        checkpointState(after, pi.manager.sessionId, source)?.treeOid,
      ).not.toBe(sourceBefore.treeOid);
      after.close();
    });
  });

  describe("user bash", () => {
    it.each([true, false])(
      "captures before user bash whether result persistence is %s",
      async (persistResultEntry) => {
        const pi = new FakePi(workspace);
        registerCyclotomy(pi.api);
        await pi.startSession("startup");
        await writeFile(join(workspace, "a.txt"), "before-bash");
        await pi.endTurn();
        const source = pi.manager.getLeafId()!;

        await pi.executeUserBash(
          "change",
          async () => {
            await writeFile(join(workspace, "a.txt"), "after-bash");
          },
          persistResultEntry,
        );
        if (persistResultEntry) {
          expect(await pi.navigate(source)).toBe("done");
        } else {
          await pi.runCommand("restore");
        }
        expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
          "before-bash",
        );
      },
    );

    it("does not assume priority over an earlier user_bash interceptor", async () => {
      const pi = new FakePi(workspace);
      pi.api.on("user_bash", async () => {
        await writeFile(join(workspace, "a.txt"), "earlier-interceptor");
        return {
          result: {
            output: "intercepted",
            exitCode: 0,
            cancelled: false,
            truncated: false,
          },
        };
      });
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "turn");
      await pi.endTurn();
      const source = pi.manager.getLeafId()!;
      const before = metadata();
      const sourceBefore = checkpointState(
        before,
        pi.manager.sessionId,
        source,
      )!;
      before.close();
      let operationRan = false;

      await pi.executeUserBash("intercepted", async () => {
        operationRan = true;
      });

      expect(operationRan).toBe(false);
      const resultLeaf = pi.manager.getLeafId()!;
      let db = metadata();
      expect(checkpointState(db, pi.manager.sessionId, source)).toEqual(
        sourceBefore,
      );
      expect(
        checkpointState(db, pi.manager.sessionId, resultLeaf),
      ).toBeUndefined();
      db.close();
      // The next cancellable input assigns the inherited result location.
      expect(await pi.submitInput()).toBe("continued");
      db = metadata();
      expect(
        checkpointState(db, pi.manager.sessionId, resultLeaf),
      ).toBeDefined();
      db.close();
    });

    it("allows bash after a completed before-input capture", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      const source = pi.manager.getLeafId()!;
      const before = metadata();
      const sourceBefore = checkpointState(
        before,
        pi.manager.sessionId,
        source,
      )!;
      before.close();
      await writeFile(join(workspace, "a.txt"), "between-turns");
      expect(await pi.preflightInput()).toBe("continued");
      let executed = false;

      await pi.executeUserBash("blocked-by-pending-input", async () => {
        executed = true;
      });

      expect(executed).toBe(true);
      expect(pi.manager.getLeafId()).not.toBe(source);
      const after = metadata();
      expect(
        checkpointState(after, pi.manager.sessionId, source)?.treeOid,
      ).not.toBe(sourceBefore.treeOid);
      after.close();
      await writeFile(join(workspace, "a.txt"), "later-drift");
      await pi.runCommand("restore");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "between-turns",
      );
    });

    it.each([true, false])(
      "protects the source and allows bash after capture failure whether result persistence is %s",
      async (persistResultEntry) => {
        const pi = new FakePi(workspace);
        registerCyclotomy(pi.api);
        await pi.startSession("startup");
        await writeFile(join(workspace, "a.txt"), "saved");
        await pi.endTurn();
        const source = pi.manager.getLeafId()!;
        await writeFile(join(workspace, "hard-a"), "same inode");
        await link(join(workspace, "hard-a"), join(workspace, "hard-b"));
        let executed = false;

        await pi.executeUserBash(
          "must-not-run",
          async () => {
            executed = true;
            await writeFile(join(workspace, "ran"), "yes");
          },
          persistResultEntry,
        );

        expect(executed).toBe(true);
        expect(pi.manager.getLeafId() === source).toBe(!persistResultEntry);
        await expect(stat(join(workspace, "ran"))).resolves.toBeDefined();
        expect(notified(pi, "sourceCaptureFailed")).toBe(true);
        const after = metadata();
        expect(checkpointIsBlocked(after, pi.manager.sessionId, source)).toBe(
          true,
        );
        after.close();
      },
    );

    it("refuses user bash while the agent is busy", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      const source = pi.manager.getLeafId()!;
      const before = metadata();
      const sourceBefore = checkpointState(
        before,
        pi.manager.sessionId,
        source,
      )!;
      before.close();
      pi.idle = false;
      let executed = false;

      await pi.executeUserBash("unsafe-during-stream", async () => {
        executed = true;
        await writeFile(join(workspace, "a.txt"), "changed");
      });

      expect(executed).toBe(false);
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("saved");
      const after = metadata();
      expect(checkpointState(after, pi.manager.sessionId, source)).toEqual(
        sourceBefore,
      );
      after.close();
    });
  });

  describe("session identity and persistence", () => {
    it.each([
      ["busy", false, undefined],
      ["streaming", true, "steer"],
    ] as const)(
      "allows %s input after protecting an identity-mismatched runtime",
      async (_case, idle, streamingBehavior) => {
        const pi = new FakePi(workspace);
        const runtime = await preparedRuntime();
        registerPreparedRuntime(pi.api, runtime);
        await pi.startSession("startup");
        expect(runtime.activation.kind).toBe("active");
        pi.idle = idle;
        const mismatch = vi
          .spyOn(runtime.registrations, "sessionIsUsable")
          .mockReturnValue(false);

        try {
          expect(await pi.preflightInput("untrusted", streamingBehavior)).toBe(
            "continued",
          );
        } finally {
          mismatch.mockRestore();
          pi.idle = true;
        }

        expect(notified(pi, "inputCaptureFailed")).toBe(true);
        expect(
          notifiedVerbatim(
            pi,
            "current persisted session identity is unavailable",
          ),
        ).toBe(true);
      },
    );

    it("initializes only the current coordinate in a newly observed history", async () => {
      const pi = new FakePi(workspace);
      const historical = pi.manager.appendEntry();
      const current = pi.manager.appendEntry();
      await writeFile(join(workspace, "state.txt"), "current workspace");
      registerCyclotomy(pi.api);

      await pi.startSession("startup");

      let db = metadata();
      expect(
        checkpointState(db, pi.manager.sessionId, historical.id),
      ).toBeUndefined();
      expect(checkpointIsBlocked(db, pi.manager.sessionId, historical.id)).toBe(
        true,
      );
      expect(
        checkpointState(db, pi.manager.sessionId, current.id),
      ).toBeDefined();
      expect(checkpointIsBlocked(db, pi.manager.sessionId, current.id)).toBe(
        false,
      );
      db.close();

      expect(await pi.navigate(historical.id)).toBe("done");
      expect(await readFile(join(workspace, "state.txt"), "utf8")).toBe(
        "current workspace",
      );
      db = metadata();
      expect(
        checkpointState(db, pi.manager.sessionId, historical.id),
      ).toBeUndefined();
      expect(checkpointIsBlocked(db, pi.manager.sessionId, historical.id)).toBe(
        true,
      );
      db.close();
    });

    it("disables persistence for in-memory Pi sessions", async () => {
      const pi = new FakePi(workspace);
      pi.manager = pi.newInMemorySession();
      registerCyclotomy(pi.api);
      const first = pi.manager.appendEntry();
      pi.manager.appendEntry();
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "ephemeral");

      await pi.endTurn(0);
      expect(await pi.navigate(first.id)).toBe("done");
      await pi.runCommand("drift");

      await expect(stat(storeRoot)).rejects.toThrow();
      expect(notified(pi, "memorySessionUnsupported")).toBe(true);
      expect(notified(pi, "navigationPlanMismatch")).toBe(false);
      expect(lastStatus(pi)).toBeUndefined();
    });

    it("reconciles quarantined registration before rendering its warning", async () => {
      const pi = new FakePi(workspace);
      const header = pi.manager.getHeader();
      vi.spyOn(pi.manager, "getHeader").mockReturnValue({
        ...header,
        parentSession: { path: "/sessions/parent.jsonl" },
      } as never);
      const quarantined = pi.manager.appendEntry();
      registerCyclotomy(pi.api);
      const rendering = throwTranslations("forkInheritanceSkipped");

      try {
        await expect(pi.startSession("fork")).resolves.toBeUndefined();
      } finally {
        rendering.mockRestore();
      }

      let db = metadata();
      expect(
        readTestSessionRegistration(metadataPath(), pi.manager.sessionId),
      ).toBeDefined();
      expect(
        db.hasSessionBarrier({
          sessionId: pi.manager.sessionId,
          sessionFile: pi.manager.getSessionFile()!,
        }),
      ).toBe(false);
      expect(
        checkpointIsBlocked(db, pi.manager.sessionId, quarantined.id),
      ).toBe(true);
      db.close();
      expect(pi.notifications).toContainEqual({
        message:
          "Cyclotomy blocked this operation, but could not render its diagnostic message.",
        level: "warning",
      });

      await pi.endTurn();
      const descendant = pi.manager.getLeafId()!;
      db = metadata();
      expect(
        checkpointState(db, pi.manager.sessionId, descendant),
      ).toBeDefined();
      db.close();
    });

    it.each([
      ["object", { path: "/sessions/parent.jsonl" }],
      ["empty string", ""],
    ])(
      "keeps a session usable when parentSession is an invalid %s",
      async (_name, parentSession) => {
        const pi = new FakePi(workspace);
        const header = pi.manager.getHeader();
        vi.spyOn(pi.manager, "getHeader").mockReturnValue({
          ...header,
          parentSession,
        } as never);
        registerCyclotomy(pi.api);

        await pi.startSession("fork");

        expect(notified(pi, "forkImportFailed")).toBe(false);
        expect(notified(pi, "forkInheritanceSkipped")).toBe(true);
        let db = metadata();
        expect(
          readTestSessionRegistration(metadataPath(), pi.manager.sessionId),
        ).toBeDefined();
        db.close();

        await writeFile(join(workspace, "state.txt"), "fresh child");
        await pi.endTurn();
        const quarantinedLeaf = pi.manager.getLeafId()!;
        db = metadata();
        expect(
          checkpointState(db, pi.manager.sessionId, quarantinedLeaf),
        ).toBeUndefined();
        expect(
          checkpointIsBlocked(db, pi.manager.sessionId, quarantinedLeaf),
        ).toBe(true);
        db.close();

        // The untrusted parent claim quarantines only the first observed
        // coordinate. A subsequent, publicly observed descendant can establish
        // its own checkpoint without retroactively assigning those files.
        await writeFile(join(workspace, "state.txt"), "verified descendant");
        await pi.endTurn();
        const descendant = pi.manager.getLeafId()!;
        db = metadata();
        expect(
          checkpointState(db, pi.manager.sessionId, descendant),
        ).toBeDefined();
        db.close();

        const skippedBeforeReload = pi.notifications.filter(({ message }) =>
          message.includes(messageFor("forkInheritanceSkipped")),
        ).length;
        await pi.replaceRuntime(registerCyclotomy, "reload");
        expect(
          pi.notifications.filter(({ message }) =>
            message.includes(messageFor("forkInheritanceSkipped")),
          ),
        ).toHaveLength(skippedBeforeReload);
      },
    );

    it("rejects fork inheritance when the public lifecycle source disagrees with the child header", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "state.txt"), "source");
      await pi.endTurn();
      const source = pi.manager;
      const sourceFile = source.getSessionFile()!;
      const claimedParent = join(home, "different-parent.jsonl");
      const child = new FakeSessionManager(
        "mismatched-fork-child",
        join(home, "mismatched-fork-child.jsonl"),
        workspace,
        claimedParent,
      );
      for (const entry of source.getEntries())
        child.entries.set(entry.id, entry);
      child.setLeaf(source.getLeafId());
      await pi.replaceSession(child, registerCyclotomy, "fork", sourceFile);

      expect(notified(pi, "forkImportFailed")).toBe(false);
      expect(notified(pi, "forkInheritanceSkipped")).toBe(true);
      const db = metadata();
      expect(
        readTestSessionRegistration(metadataPath(), child.sessionId),
      ).toBeDefined();
      // Registration raises a session barrier; startup reconciliation consumes
      // it into concrete blocked slots once Pi exposes the active ancestry.
      expect(
        db.hasSessionBarrier({
          sessionId: child.sessionId,
          sessionFile: child.sessionFile!,
        }),
      ).toBe(false);
      expect(
        checkpointState(db, child.sessionId, source.getLeafId()!),
      ).toBeUndefined();
      expect(
        checkpointIsBlocked(db, child.sessionId, source.getLeafId()!),
      ).toBe(true);
      db.close();
    });

    it.each(["new", "resume"] as const)(
      "does not treat %s previousSessionFile as fork ancestry",
      async (reason) => {
        const pi = new FakePi(workspace);
        registerCyclotomy(pi.api);
        await pi.startSession("startup");
        await writeFile(join(workspace, "state.txt"), "source");
        await pi.endTurn();
        const source = pi.manager;
        const sourceLeaf = source.getLeafId()!;
        const sourceFile = source.getSessionFile()!;

        const child = new FakeSessionManager(
          `${reason}-child`,
          join(home, `${reason}-child.jsonl`),
          workspace,
        );
        for (const entry of source.getEntries()) {
          child.entries.set(entry.id, entry);
        }
        child.setLeaf(sourceLeaf);
        const active = child.appendEntry();
        await writeFile(join(workspace, "state.txt"), `${reason}-workspace`);

        await pi.replaceSession(child, registerCyclotomy, reason, sourceFile);

        const db = metadata();
        expect(
          checkpointState(db, child.sessionId, sourceLeaf),
        ).toBeUndefined();
        expect(checkpointIsBlocked(db, child.sessionId, sourceLeaf)).toBe(true);
        expect(checkpointState(db, child.sessionId, active.id)).toBeDefined();
        db.close();
      },
    );

    it("fails closed when two physical files claim the same session id", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "original");
      await pi.endTurn();
      const sessionId = pi.manager.sessionId;
      const originalSessionFile = pi.manager.getSessionFile()!;
      const entryId = pi.manager.getLeafId()!;
      const before = metadata();
      const original = checkpointState(before, sessionId, entryId)!;
      before.close();

      const duplicate = new FakeSessionManager(
        sessionId,
        join(home, "duplicate.jsonl"),
        workspace,
      );
      expect(duplicate.appendEntry().id).toBe(entryId);
      await pi.replaceSession(duplicate, registerCyclotomy, "resume");
      await writeFile(join(workspace, "a.txt"), "duplicate-workspace");
      await pi.endTurn(0);
      await pi.runCommand("restore");

      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "duplicate-workspace",
      );
      const after = metadata();
      expect(checkpointState(after, sessionId, entryId)).toEqual(original);
      expect(readTestSessionRegistrations(metadataPath())[0]?.sessionFile).toBe(
        originalSessionFile,
      );
      after.close();
      expect(
        notifiedWithDetail(
          pi,
          "sessionRegistrationFailed",
          "Pi session identity conflicts with registered Cyclotomy metadata",
        ),
      ).toBe(true);
    });

    it("never recovers into an unregistered duplicate identity after init failure", async () => {
      await writeFile(storeRoot, "blocks store creation");
      const pi = new FakePi(workspace);
      pi.manager = new FakeSessionManager(
        "shared-session",
        join(home, "duplicate.jsonl"),
        workspace,
      );
      const leaf = pi.manager.appendEntry();
      registerCyclotomy(pi.api);

      await pi.startSession("startup");
      expect(notified(pi, "initFailure")).toBe(true);

      await rm(storeRoot, { force: true });
      await mkdir(storeRoot, { recursive: true });
      const originalOid = "a".repeat(64);
      const originalSessionFile = join(home, "original.jsonl");
      let db = metadata();
      registerTestSession(db, "shared-session", originalSessionFile, [leaf.id]);
      commitTestNodeState(db, "shared-session", leaf.id, originalOid);
      db.close();
      await writeFile(join(workspace, "a.txt"), "must-not-be-captured");

      await pi.endTurn(0);
      await pi.runCommand("restore");

      db = metadata();
      expect(checkpointState(db, "shared-session", leaf.id)?.treeOid).toBe(
        originalOid,
      );
      expect(readTestSessionRegistrations(metadataPath())[0]?.sessionFile).toBe(
        originalSessionFile,
      );
      db.close();
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "must-not-be-captured",
      );
    });
  });

  describe("fork, switch, and resume", () => {
    it("imports every checkpoint Pi retained in a cross-workspace fork", async () => {
      const targetWorkspace = await mkdtemp(
        join(tmpdir(), "cyclotomy-pi-fork-target-"),
      );
      const parentFile = join(home, "parent.jsonl");
      const childFile = join(home, "child.jsonl");
      try {
        await writeFile(
          parentFile,
          `${JSON.stringify({
            type: "session",
            id: "parent",
            cwd: workspace,
          })}\n`,
        );
        const parentPi = new FakePi(workspace);
        parentPi.manager = new FakeSessionManager(
          "parent",
          parentFile,
          workspace,
        );
        registerCyclotomy(parentPi.api);
        await parentPi.startSession("startup");
        await writeFile(join(workspace, "state.txt"), "root");
        await parentPi.endTurn();
        const rootEntry = parentPi.manager.getLeafId()!;
        await writeFile(join(workspace, "state.txt"), "first branch");
        await parentPi.endTurn();
        const firstBranch = parentPi.manager.getLeafId()!;
        expect(await parentPi.navigate(rootEntry)).toBe("done");
        await writeFile(join(workspace, "state.txt"), "sibling branch");
        await parentPi.endTurn();
        const siblingBranch = parentPi.manager.getLeafId()!;

        const sourceMetadata = await metadataFor(workspace);
        const sourceStates = new Map(
          [rootEntry, firstBranch, siblingBranch].map((entryId) => [
            entryId,
            checkpointState(sourceMetadata, "parent", entryId)!.treeOid,
          ]),
        );
        sourceMetadata.close();

        await writeFile(join(targetWorkspace, "state.txt"), "target files");
        const childManager = new FakeSessionManager(
          "child",
          childFile,
          targetWorkspace,
          parentFile,
        );
        for (const entry of parentPi.manager.entries.values()) {
          childManager.entries.set(entry.id, entry);
        }
        childManager.setLeaf(siblingBranch);
        const childPi = new FakePi(targetWorkspace);
        childPi.manager = childManager;
        childPi.selectDestructive = false;
        registerCyclotomy(childPi.api);

        await childPi.startSession("fork", parentFile);

        expect(await readFile(join(targetWorkspace, "state.txt"), "utf8")).toBe(
          "target files",
        );
        const targetMetadata = await metadataFor(targetWorkspace);
        for (const [entryId, treeOid] of sourceStates) {
          expect(checkpointState(targetMetadata, "child", entryId)).toEqual({
            treeOid,
          });
        }
        expect(
          checkpointIsBlocked(targetMetadata, "child", siblingBranch),
        ).toBe(true);
        targetMetadata.close();

        childPi.selectDestructive = true;
        await childPi.runCommand("restore");
        expect(await readFile(join(targetWorkspace, "state.txt"), "utf8")).toBe(
          "sibling branch",
        );

        await writeFile(join(targetWorkspace, "state.txt"), "child diverged");
        await childPi.endTurn(0);
        let childMetadata = await metadataFor(targetWorkspace);
        const childOid = checkpointState(
          childMetadata,
          "child",
          siblingBranch,
        )!.treeOid;
        childMetadata.close();
        expect(childOid).not.toBe(sourceStates.get(siblingBranch));

        // The registry row is the completed-import marker. A later reload
        // neither needs the parent file nor refills the now-diverged child.
        await rm(parentFile);
        await childPi.replaceRuntime(registerCyclotomy, "reload");
        expect(notified(childPi, "forkImportFailed")).toBe(false);
        childMetadata = await metadataFor(targetWorkspace);
        expect(
          checkpointState(childMetadata, "child", siblingBranch)?.treeOid,
        ).toBe(childOid);
        childMetadata.close();
        const unchangedSource = await metadataFor(workspace);
        expect(
          checkpointState(unchangedSource, "parent", siblingBranch)?.treeOid,
        ).toBe(sourceStates.get(siblingBranch));
        unchangedSource.close();
      } finally {
        await rm(targetWorkspace, { recursive: true, force: true });
      }
    });

    it("retries cross-workspace inheritance after source locking recovers", async () => {
      const targetWorkspace = await mkdtemp(
        join(tmpdir(), "cyclotomy-pi-fork-locked-target-"),
      );
      const parentFile = join(home, "locked-parent.jsonl");
      const sourceLock = join(storeRoot, "workspace.lock");
      try {
        await writeFile(
          parentFile,
          `${JSON.stringify({
            type: "session",
            id: "locked-parent",
            cwd: workspace,
          })}\n`,
        );
        const parent = new FakePi(workspace);
        parent.manager = new FakeSessionManager(
          "locked-parent",
          parentFile,
          workspace,
        );
        registerCyclotomy(parent.api);
        await parent.startSession("startup");
        await writeFile(join(workspace, "state.txt"), "parent state");
        await parent.endTurn();
        const retained = parent.manager.getLeafId()!;
        const sourceMetadata = await metadataFor(workspace);
        const sourceOid = checkpointState(
          sourceMetadata,
          "locked-parent",
          retained,
        )!.treeOid;
        sourceMetadata.close();
        await writeFile(sourceLock, "blocks source locking");

        await writeFile(join(targetWorkspace, "state.txt"), "target state");
        const child = new FakePi(targetWorkspace);
        child.manager = new FakeSessionManager(
          "locked-child",
          join(home, "locked-child.jsonl"),
          targetWorkspace,
          parentFile,
        );
        for (const entry of parent.manager.entries.values()) {
          child.manager.entries.set(entry.id, entry);
        }
        child.manager.setLeaf(retained);
        registerCyclotomy(child.api);

        await child.startSession("fork", parentFile);

        expect(notified(child, "forkImportFailed")).toBe(true);
        expect(notified(child, "forkInheritanceSkipped")).toBe(false);
        expect(await readFile(join(targetWorkspace, "state.txt"), "utf8")).toBe(
          "target state",
        );
        let targetMetadata = await metadataFor(targetWorkspace);
        expect(
          readTestSessionRegistrations(await metadataPathFor(targetWorkspace)),
        ).toEqual([]);
        expect(
          checkpointState(targetMetadata, "locked-child", retained),
        ).toBeUndefined();
        targetMetadata.close();

        await rm(sourceLock);
        child.notifications.length = 0;
        await child.replaceRuntime(registerCyclotomy, "reload");

        expect(notified(child, "forkImportFailed")).toBe(false);
        expect(notified(child, "forkInheritanceSkipped")).toBe(false);
        targetMetadata = await metadataFor(targetWorkspace);
        expect(
          checkpointState(targetMetadata, "locked-child", retained)?.treeOid,
        ).toBe(sourceOid);
        targetMetadata.close();
      } finally {
        await rm(sourceLock, { force: true });
        await rm(targetWorkspace, { recursive: true, force: true });
      }
    });

    it("keeps a cross-workspace child usable when source metadata requires recovery", async () => {
      const targetWorkspace = await mkdtemp(
        join(tmpdir(), "cyclotomy-pi-fork-recovery-target-"),
      );
      const parentFile = join(home, "recovery-parent.jsonl");
      const sourceMetadataPath = await metadataPathFor(workspace);
      const journalPath = `${sourceMetadataPath}-journal`;
      const journalSentinel = "unrecovered journal sentinel";
      try {
        await writeFile(
          parentFile,
          `${JSON.stringify({
            type: "session",
            id: "recovery-parent",
            cwd: workspace,
          })}\n`,
        );
        const parent = new FakePi(workspace);
        parent.manager = new FakeSessionManager(
          "recovery-parent",
          parentFile,
          workspace,
        );
        registerCyclotomy(parent.api);
        await parent.startSession("startup");
        await writeFile(join(workspace, "state.txt"), "parent state");
        await parent.endTurn();
        const retained = parent.manager.getLeafId()!;

        // Close the source runtime before creating a stable recovery-required
        // sidecar. Identity inspection must neither consume nor repair it.
        await parent.replaceRuntime(() => {}, "startup");
        await writeFile(journalPath, journalSentinel);

        await writeFile(join(targetWorkspace, "state.txt"), "fresh child");
        const child = new FakePi(targetWorkspace);
        child.manager = new FakeSessionManager(
          "recovery-child",
          join(home, "recovery-child.jsonl"),
          targetWorkspace,
          parentFile,
        );
        for (const entry of parent.manager.entries.values()) {
          child.manager.entries.set(entry.id, entry);
        }
        child.manager.setLeaf(retained);
        registerCyclotomy(child.api);

        await child.startSession("fork", parentFile);

        expect(await readFile(journalPath, "utf8")).toBe(journalSentinel);
        expect(notified(child, "forkImportFailed")).toBe(false);
        expect(notified(child, "forkInheritanceSkipped")).toBe(true);
        expect(await child.preflightInput("continue independently")).toBe(
          "continued",
        );
        let targetMetadata = await metadataFor(targetWorkspace);
        expect(
          readTestSessionRegistration(
            await metadataPathFor(targetWorkspace),
            "recovery-child",
          ),
        ).toBeDefined();
        expect(
          checkpointState(targetMetadata, "recovery-child", retained),
        ).toBeUndefined();
        expect(
          checkpointIsBlocked(targetMetadata, "recovery-child", retained),
        ).toBe(true);
        targetMetadata.close();

        await writeFile(join(targetWorkspace, "state.txt"), "child turn");
        await child.endTurn();
        targetMetadata = await metadataFor(targetWorkspace);
        expect(
          checkpointState(
            targetMetadata,
            "recovery-child",
            child.manager.getLeafId()!,
          ),
        ).toBeDefined();
        targetMetadata.close();
      } finally {
        await rm(journalPath, { force: true });
        await rm(targetWorkspace, { recursive: true, force: true });
      }
    });

    it("leaves a fork unregistered when the target storage ancestor changes before ordered import", async (context) => {
      context.skip(
        process.platform === "win32",
        "Windows symlink creation is privilege-dependent",
      );
      let targetWorkspace = await mkdtemp(
        join(tmpdir(), "cyclotomy-pi-fork-rebound-target-"),
      );
      const storageA = join(home, "fork-storage-a");
      const storageB = join(home, "fork-storage-b");
      const storageAlias = join(home, "fork-storage-current");
      const parentFile = join(home, "rebound-parent.jsonl");
      try {
        await Promise.all([mkdir(storageA), mkdir(storageB)]);
        const canonicalStorageA = await realpath(storageA);
        await symlink(storageA, storageAlias);
        await writeFile(
          join(home, "cyclotomy", "settings.json"),
          JSON.stringify({
            storageDir: storageAlias,
            locale: "zh-CN",
            lockTimeoutMs: 10_000,
            gc: { intervalMs: 0 },
          }),
        );
        await writeFile(
          parentFile,
          `${JSON.stringify({
            type: "session",
            id: "rebound-parent",
            cwd: workspace,
          })}\n`,
        );

        const parent = new FakePi(workspace);
        parent.manager = new FakeSessionManager(
          "rebound-parent",
          parentFile,
          workspace,
        );
        registerCyclotomy(parent.api);
        await parent.startSession("startup");
        await writeFile(join(workspace, "state.txt"), "parent state");
        await parent.endTurn();
        const retained = parent.manager.getLeafId()!;
        const sourceHash = createHash("sha256")
          .update(await realpath(workspace))
          .digest("hex");
        const sourceStoreRoot = join(canonicalStorageA, sourceHash);
        const sourceMetadata = createCurrentMetadataStore(
          join(sourceStoreRoot, "state.db"),
        );
        const sourceOid = checkpointState(
          sourceMetadata,
          "rebound-parent",
          retained,
        )!.treeOid;
        sourceMetadata.close();

        let targetHash = createHash("sha256")
          .update(await realpath(targetWorkspace))
          .digest("hex");
        for (
          let attempt = 0;
          Buffer.from(targetHash).compare(Buffer.from(sourceHash)) >= 0 &&
          attempt < 100;
          attempt += 1
        ) {
          await rm(targetWorkspace, { recursive: true, force: true });
          targetWorkspace = await mkdtemp(
            join(tmpdir(), "cyclotomy-pi-fork-rebound-target-"),
          );
          targetHash = createHash("sha256")
            .update(await realpath(targetWorkspace))
            .digest("hex");
        }
        if (Buffer.from(targetHash).compare(Buffer.from(sourceHash)) >= 0) {
          throw new Error("failed to choose a target ordered before source");
        }
        const targetStoreRoot = join(canonicalStorageA, targetHash);

        await writeFile(join(targetWorkspace, "state.txt"), "target state");
        const child = new FakePi(targetWorkspace);
        child.manager = new FakeSessionManager(
          "rebound-child",
          join(home, "rebound-child.jsonl"),
          targetWorkspace,
          parentFile,
        );
        for (const entry of parent.manager.entries.values()) {
          child.manager.entries.set(entry.id, entry);
        }
        child.manager.setLeaf(retained);

        const runtime = new CyclotomyRuntime(
          loadCyclotomyConfig(home),
          TEST_I18N,
        );
        registerPreparedRuntime(child.api, runtime);

        const sourceLock = await acquireWorkspaceLock(
          sourceStoreRoot,
          "hold-source-before-rebound",
        );
        const starting = child.startSession("fork", parentFile);
        try {
          const targetLockPath = join(targetStoreRoot, "workspace.lock");
          let importLockObserved = false;
          for (let attempt = 0; attempt < 800; attempt += 1) {
            try {
              const names = await readdir(targetLockPath);
              for (const name of names) {
                if (!name.startsWith("owner-") || !name.endsWith(".json")) {
                  continue;
                }
                let record: { operation?: unknown };
                try {
                  record = JSON.parse(
                    await readFile(join(targetLockPath, name), "utf8"),
                  ) as { operation?: unknown };
                } catch (error) {
                  const token = name.slice("owner-".length, -".json".length);
                  if (
                    error instanceof SyntaxError &&
                    !names.includes(`heartbeat-${token}`)
                  ) {
                    // writeFile publishes the owner before its heartbeat. A
                    // parse failure is transient only in that formation gap;
                    // malformed records with a published heartbeat still fail.
                    continue;
                  }
                  throw error;
                }
                if (record.operation === "fork-import") {
                  importLockObserved = true;
                  break;
                }
              }
            } catch (error) {
              if (
                typeof error !== "object" ||
                error === null ||
                !["ENOENT", "ENOTDIR"].includes(
                  String(Reflect.get(error, "code")),
                )
              ) {
                throw error;
              }
            }
            if (importLockObserved) break;
            await new Promise<void>((resolveWait) =>
              setTimeout(resolveWait, 5),
            );
          }
          expect(importLockObserved).toBe(true);
          await rm(storageAlias);
          await symlink(storageB, storageAlias);
        } finally {
          await sourceLock.release();
        }
        await starting;

        expect(notified(child, "forkImportFailed")).toBe(true);
        expect(notified(child, "forkInheritanceSkipped")).toBe(false);
        expect(await readFile(join(targetWorkspace, "state.txt"), "utf8")).toBe(
          "target state",
        );

        const targetMetadata = createCurrentMetadataStore(
          join(targetStoreRoot, "state.db"),
        );
        expect(
          readTestSessionRegistration(
            join(targetStoreRoot, "state.db"),
            "rebound-child",
          ),
        ).toBeUndefined();
        expect(
          checkpointState(targetMetadata, "rebound-child", retained)?.treeOid,
        ).toBeUndefined();
        expect(targetMetadata.listReferencedTreeOids()).not.toContain(
          sourceOid,
        );
        targetMetadata.close();
        const targetStore = await openObjectStore(targetStoreRoot);
        await expect(targetStore.readTree(sourceOid)).rejects.toThrow();
      } finally {
        await rm(targetWorkspace, { recursive: true, force: true });
      }
    });

    it("does not commit imported metadata when the storage ancestor changes after CAS publication", async (context) => {
      context.skip(
        process.platform === "win32",
        "Windows symlink creation is privilege-dependent",
      );
      const targetWorkspace = await mkdtemp(
        join(tmpdir(), "cyclotomy-pi-fork-published-target-"),
      );
      const storageA = join(home, "published-storage-a");
      const storageB = join(home, "published-storage-b");
      const storageAlias = join(home, "published-storage-current");
      const parentFile = join(home, "published-parent.jsonl");
      try {
        await Promise.all([mkdir(storageA), mkdir(storageB)]);
        const canonicalStorageA = await realpath(storageA);
        await symlink(storageA, storageAlias);
        await writeFile(
          join(home, "cyclotomy", "settings.json"),
          JSON.stringify({
            storageDir: storageAlias,
            locale: "zh-CN",
            gc: { intervalMs: 0 },
          }),
        );
        await writeFile(
          parentFile,
          `${JSON.stringify({
            type: "session",
            id: "published-parent",
            cwd: workspace,
          })}\n`,
        );

        const parent = new FakePi(workspace);
        parent.manager = new FakeSessionManager(
          "published-parent",
          parentFile,
          workspace,
        );
        registerCyclotomy(parent.api);
        await parent.startSession("startup");
        await writeFile(join(workspace, "state.txt"), "parent state");
        await parent.endTurn();
        const retained = parent.manager.getLeafId()!;
        const sourceHash = createHash("sha256")
          .update(await realpath(workspace))
          .digest("hex");
        const sourceStoreRoot = join(canonicalStorageA, sourceHash);
        const sourceMetadata = createCurrentMetadataStore(
          join(sourceStoreRoot, "state.db"),
        );
        const sourceOid = checkpointState(
          sourceMetadata,
          "published-parent",
          retained,
        )!.treeOid;
        sourceMetadata.close();

        const targetHash = createHash("sha256")
          .update(await realpath(targetWorkspace))
          .digest("hex");
        const targetStoreRoot = join(canonicalStorageA, targetHash);
        const prototypeStore = await openObjectStore(sourceStoreRoot);
        const prototype = Object.getPrototypeOf(prototypeStore) as Pick<
          ObjectStore,
          "verifyBlobs"
        >;
        const originalVerifyBlobs = prototype.verifyBlobs;
        let rebound = false;
        const verifyBlobs = vi
          .spyOn(prototype, "verifyBlobs")
          .mockImplementation(async function (
            this: ObjectStore,
            blobOids: readonly string[],
          ) {
            await originalVerifyBlobs.call(this, blobOids);
            if (!rebound && this.storageRoot === targetStoreRoot) {
              expect(blobOids.length).toBeGreaterThan(0);
              await rm(storageAlias);
              await symlink(storageB, storageAlias);
              rebound = true;
            }
          });
        try {
          await writeFile(join(targetWorkspace, "state.txt"), "target state");
          const child = new FakePi(targetWorkspace);
          child.manager = new FakeSessionManager(
            "published-child",
            join(home, "published-child.jsonl"),
            targetWorkspace,
            parentFile,
          );
          for (const entry of parent.manager.entries.values()) {
            child.manager.entries.set(entry.id, entry);
          }
          child.manager.setLeaf(retained);
          registerCyclotomy(child.api);

          await child.startSession("fork", parentFile);

          expect(rebound).toBe(true);
          expect(notified(child, "forkImportFailed")).toBe(true);
          expect(notified(child, "forkInheritanceSkipped")).toBe(false);
          expect(
            await readFile(join(targetWorkspace, "state.txt"), "utf8"),
          ).toBe("target state");

          const targetMetadata = createCurrentMetadataStore(
            join(targetStoreRoot, "state.db"),
          );
          expect(
            readTestSessionRegistration(
              join(targetStoreRoot, "state.db"),
              "published-child",
            ),
          ).toBeUndefined();
          expect(
            checkpointState(targetMetadata, "published-child", retained)
              ?.treeOid,
          ).toBeUndefined();
          expect(targetMetadata.listReferencedTreeOids()).not.toContain(
            sourceOid,
          );
          targetMetadata.close();
          const targetStore = await openObjectStore(targetStoreRoot);
          await expect(targetStore.readTree(sourceOid)).resolves.toBeDefined();
        } finally {
          verifyBlobs.mockRestore();
        }
      } finally {
        await rm(targetWorkspace, { recursive: true, force: true });
      }
    });

    it("does not infer same-workspace ancestry after Pi has removed the parent file", async () => {
      const parentFile = join(home, "missing-local-parent.jsonl");
      await writeFile(
        parentFile,
        `${JSON.stringify({
          type: "session",
          id: "missing-local-parent",
          cwd: workspace,
        })}\n`,
      );
      const parent = new FakePi(workspace);
      parent.manager = new FakeSessionManager(
        "missing-local-parent",
        parentFile,
        workspace,
      );
      registerCyclotomy(parent.api);
      await parent.startSession("startup");
      await writeFile(join(workspace, "state.txt"), "parent checkpoint");
      await parent.endTurn();
      const retained = parent.manager.getLeafId()!;
      const before = metadata();
      const parentOid = checkpointState(
        before,
        "missing-local-parent",
        retained,
      )!.treeOid;
      before.close();
      await rm(parentFile);

      const child = new FakePi(workspace);
      child.manager = new FakeSessionManager(
        "missing-local-child",
        join(home, "missing-local-child.jsonl"),
        workspace,
        parentFile,
      );
      for (const entry of parent.manager.entries.values()) {
        child.manager.entries.set(entry.id, entry);
      }
      child.manager.setLeaf(retained);
      registerCyclotomy(child.api);

      await child.startSession("fork", parentFile);

      const after = metadata();
      expect(
        checkpointState(after, "missing-local-parent", retained)?.treeOid,
      ).toBe(parentOid);
      expect(
        checkpointState(after, "missing-local-child", retained),
      ).toBeUndefined();
      expect(checkpointIsBlocked(after, "missing-local-child", retained)).toBe(
        true,
      );
      after.close();
      expect(notified(child, "forkInheritanceSkipped")).toBe(true);
    });

    it("keeps a cross-workspace child usable when the recorded parent cwd is gone", async () => {
      const deletedSource = await mkdtemp(
        join(tmpdir(), "cyclotomy-pi-deleted-source-"),
      );
      const targetWorkspace = await mkdtemp(
        join(tmpdir(), "cyclotomy-pi-deleted-target-"),
      );
      const parentFile = join(home, "deleted-cwd-parent.jsonl");
      try {
        await writeFile(
          parentFile,
          `${JSON.stringify({
            type: "session",
            id: "deleted-cwd-parent",
            cwd: deletedSource,
          })}\n`,
        );
        await rm(deletedSource, { recursive: true });
        await writeFile(join(targetWorkspace, "state.txt"), "fresh child");
        const child = new FakePi(targetWorkspace);
        child.manager = new FakeSessionManager(
          "deleted-cwd-child",
          join(home, "deleted-cwd-child.jsonl"),
          targetWorkspace,
          parentFile,
        );
        const retained = child.manager.appendEntry();
        registerCyclotomy(child.api);

        await child.startSession("fork", parentFile);

        expect(notified(child, "forkInheritanceSkipped")).toBe(true);
        let db = await metadataFor(targetWorkspace);
        expect(
          readTestSessionRegistration(
            await metadataPathFor(targetWorkspace),
            "deleted-cwd-child",
          ),
        ).toBeDefined();
        expect(
          checkpointState(db, "deleted-cwd-child", retained.id),
        ).toBeUndefined();
        expect(checkpointIsBlocked(db, "deleted-cwd-child", retained.id)).toBe(
          true,
        );
        db.close();
        await writeFile(join(targetWorkspace, "state.txt"), "child turn");
        await expect(child.endTurn()).resolves.toBeUndefined();
        db = await metadataFor(targetWorkspace);
        expect(
          checkpointState(db, "deleted-cwd-child", child.manager.getLeafId()!),
        ).toBeDefined();
        db.close();
      } finally {
        await rm(deletedSource, { recursive: true, force: true });
        await rm(targetWorkspace, { recursive: true, force: true });
      }
    });

    it("rejects target control data inside the parent workspace before creation", async () => {
      const targetWorkspace = await mkdtemp(
        join(tmpdir(), "cyclotomy-pi-overlap-target-"),
      );
      const parentFile = join(home, "overlap-parent.jsonl");
      const storageRoot = join(workspace, ".cyclotomy-control");
      try {
        await writeFile(
          join(home, "cyclotomy", "settings.json"),
          JSON.stringify({
            storageDir: storageRoot,
            locale: "zh-CN",
            gc: { intervalMs: 0 },
          }),
        );
        await writeFile(
          parentFile,
          `${JSON.stringify({
            type: "session",
            id: "overlap-parent",
            cwd: workspace,
          })}\n`,
        );
        const child = new FakePi(targetWorkspace);
        child.manager = new FakeSessionManager(
          "overlap-child",
          join(home, "overlap-child.jsonl"),
          targetWorkspace,
          parentFile,
        );
        child.manager.appendEntry();
        registerCyclotomy(child.api);

        await child.startSession("fork", parentFile);

        expect(notified(child, "initFailure")).toBe(true);
        await expect(lstat(storageRoot)).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        await rm(targetWorkspace, { recursive: true, force: true });
      }
    });

    it.each([
      {
        caseName: "path limits",
        key: "path",
        sourcePath: "long-name.txt",
        settings: { maxPathBytes: 8 },
      },
      {
        caseName: "inventory limits including implicit directories",
        key: "inventory",
        sourcePath: "nested/file.txt",
        settings: { maxEntries: 2 },
      },
    ])(
      "does not register imported roots outside target $caseName",
      async ({ key, sourcePath, settings }) => {
        const targetWorkspace = await mkdtemp(
          join(tmpdir(), "cyclotomy-pi-fork-limited-target-"),
        );
        const parentFile = join(home, `limited-${key}-parent.jsonl`);
        try {
          const parentId = `limited-${key}-parent`;
          const childId = `limited-${key}-child`;
          await writeFile(
            parentFile,
            `${JSON.stringify({
              type: "session",
              id: parentId,
              cwd: workspace,
            })}\n`,
          );
          const parentPi = new FakePi(workspace);
          parentPi.manager = new FakeSessionManager(
            parentId,
            parentFile,
            workspace,
          );
          registerCyclotomy(parentPi.api);
          await parentPi.startSession("startup");
          const sourceFile = join(workspace, sourcePath);
          await mkdir(dirname(sourceFile), { recursive: true });
          await writeFile(sourceFile, "source");
          await parentPi.endTurn();

          const targetHash = createHash("sha256")
            .update(await realpath(targetWorkspace))
            .digest("hex");
          const targetStoreRoot = join(home, "cyclotomy", targetHash);
          await mkdir(targetStoreRoot);
          await writeFile(
            join(targetStoreRoot, "settings.json"),
            JSON.stringify(settings),
          );
          await writeFile(join(targetWorkspace, "keep.txt"), "target");
          const childManager = new FakeSessionManager(
            childId,
            join(home, `limited-${key}-child.jsonl`),
            targetWorkspace,
            parentFile,
          );
          for (const entry of parentPi.manager.entries.values()) {
            childManager.entries.set(entry.id, entry);
          }
          childManager.setLeaf(parentPi.manager.getLeafId());
          const childPi = new FakePi(targetWorkspace);
          childPi.manager = childManager;
          registerCyclotomy(childPi.api);

          await childPi.startSession("fork", parentFile);

          expect(notified(childPi, "forkInheritanceSkipped")).toBe(true);
          expect(
            await readFile(join(targetWorkspace, "keep.txt"), "utf8"),
          ).toBe("target");
          const targetMetadata = await metadataFor(targetWorkspace);
          expect(
            readTestSessionRegistration(
              await metadataPathFor(targetWorkspace),
              childId,
            ),
          ).toBeDefined();
          expect(
            checkpointState(targetMetadata, childId, childManager.getLeafId()!),
          ).toBeUndefined();
          expect(
            checkpointIsBlocked(
              targetMetadata,
              childId,
              childManager.getLeafId()!,
            ),
          ).toBe(true);
          targetMetadata.close();
        } finally {
          await rm(targetWorkspace, { recursive: true, force: true });
        }
      },
    );

    it("never imports a parent registration outside Pi's recorded cwd", async () => {
      const legacyWrongWorkspace = await mkdtemp(
        join(tmpdir(), "cyclotomy-pi-fork-legacy-wrong-"),
      );
      const targetWorkspace = await mkdtemp(
        join(tmpdir(), "cyclotomy-pi-fork-target-"),
      );
      const parentFile = join(home, "cwd-owned-parent.jsonl");
      try {
        await writeFile(
          parentFile,
          `${JSON.stringify({
            type: "session",
            id: "source-a",
            cwd: workspace,
          })}\n`,
        );
        // Model stale metadata written by an older cwd-override behavior. The
        // same Pi identity exists in B, while Pi's own header assigns it to A.
        const legacy = new FakePi(legacyWrongWorkspace);
        legacy.manager = new FakeSessionManager(
          "source-a",
          parentFile,
          legacyWrongWorkspace,
        );
        const retained = legacy.manager.appendEntry();
        registerCyclotomy(legacy.api);
        await writeFile(join(legacyWrongWorkspace, "state.txt"), "wrong");
        await legacy.startSession("startup");
        const legacyMetadata = await metadataFor(legacyWrongWorkspace);
        const wrongOid = checkpointState(
          legacyMetadata,
          "source-a",
          retained.id,
        )!.treeOid;
        legacyMetadata.close();

        await writeFile(join(targetWorkspace, "state.txt"), "target");
        const child = new FakePi(targetWorkspace);
        child.manager = new FakeSessionManager(
          "child",
          join(home, "cwd-owned-child.jsonl"),
          targetWorkspace,
          parentFile,
        );
        child.manager.entries.set(retained.id, retained);
        child.manager.setLeaf(retained.id);
        registerCyclotomy(child.api);
        await child.startSession("fork", parentFile);

        expect(notified(child, "forkImportFailed")).toBe(false);
        expect(await readFile(join(targetWorkspace, "state.txt"), "utf8")).toBe(
          "target",
        );
        const targetMetadata = await metadataFor(targetWorkspace);
        expect(
          readTestSessionRegistration(
            await metadataPathFor(targetWorkspace),
            "child",
          ),
        ).toBeDefined();
        expect(
          checkpointState(targetMetadata, "child", retained.id)?.treeOid,
        ).not.toBe(wrongOid);
        targetMetadata.close();
      } finally {
        await rm(legacyWrongWorkspace, { recursive: true, force: true });
        await rm(targetWorkspace, { recursive: true, force: true });
      }
    });

    it("aborts without migrating an unrelated locked v1 parent store", async () => {
      const targetWorkspace = await mkdtemp(
        join(tmpdir(), "cyclotomy-pi-fork-target-"),
      );
      const parentFile = join(home, "unregistered-v1-parent.jsonl");
      try {
        await writeFile(
          parentFile,
          `${JSON.stringify({
            type: "session",
            id: "unregistered-parent",
            cwd: workspace,
          })}\n`,
        );
        await mkdir(storeRoot, { recursive: true });
        await writeFile(
          join(storeRoot, "settings.json"),
          JSON.stringify({ maxPathBytes: 0 }),
        );
        const legacy = new DatabaseSync(join(storeRoot, "state.db"));
        legacy.exec(`
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
          PRAGMA user_version = 1;
        `);
        legacy.close();
        const lockSentinel = join(storeRoot, "workspace.lock");
        await writeFile(lockSentinel, "must remain untouched");

        await writeFile(join(targetWorkspace, "state.txt"), "fresh target");
        const child = new FakePi(targetWorkspace);
        child.manager = new FakeSessionManager(
          "unregistered-child",
          join(home, "unregistered-v1-child.jsonl"),
          targetWorkspace,
          parentFile,
        );
        child.manager.appendEntry();
        registerCyclotomy(child.api);
        await child.startSession("fork", parentFile);

        expect(notified(child, "forkImportFailed")).toBe(true);
        const unchanged = new DatabaseSync(join(storeRoot, "state.db"), {
          readOnly: true,
        });
        expect(
          Number(unchanged.prepare("PRAGMA user_version").get()!.user_version),
        ).toBe(1);
        unchanged.close();
        expect(await readFile(lockSentinel, "utf8")).toBe(
          "must remain untouched",
        );
        const targetMetadata = await metadataFor(targetWorkspace);
        expect(
          readTestSessionRegistration(
            await metadataPathFor(targetWorkspace),
            "unregistered-child",
          ),
        ).toBeUndefined();
        targetMetadata.close();
      } finally {
        await rm(targetWorkspace, { recursive: true, force: true });
      }
    });

    it("quarantines a cross-workspace fork that reuses the parent session id", async () => {
      const targetWorkspace = await mkdtemp(
        join(tmpdir(), "cyclotomy-pi-fork-target-"),
      );
      const parentFile = join(home, "same-id-parent.jsonl");
      try {
        await writeFile(
          parentFile,
          `${JSON.stringify({
            type: "session",
            id: "reused-id",
            cwd: workspace,
          })}\n`,
        );
        const parent = new FakePi(workspace);
        parent.manager = new FakeSessionManager(
          "reused-id",
          parentFile,
          workspace,
        );
        const retained = parent.manager.appendEntry();
        registerCyclotomy(parent.api);
        await parent.startSession("startup");

        const child = new FakePi(targetWorkspace);
        child.manager = new FakeSessionManager(
          "reused-id",
          join(home, "same-id-child.jsonl"),
          targetWorkspace,
          parentFile,
        );
        child.manager.entries.set(retained.id, retained);
        child.manager.setLeaf(retained.id);
        registerCyclotomy(child.api);
        await child.startSession("fork", parentFile);

        expect(notified(child, "forkImportFailed")).toBe(false);
        expect(notified(child, "forkInheritanceSkipped")).toBe(true);
        const targetMetadata = await metadataFor(targetWorkspace);
        expect(
          readTestSessionRegistrations(await metadataPathFor(targetWorkspace)),
        ).toHaveLength(1);
        expect(
          checkpointIsBlocked(targetMetadata, "reused-id", retained.id),
        ).toBe(true);
        targetMetadata.close();
      } finally {
        await rm(targetWorkspace, { recursive: true, force: true });
      }
    });

    it("rejects malformed retained branches before same-workspace import", async () => {
      const parent = new FakePi(workspace);
      registerCyclotomy(parent.api);
      await parent.startSession("startup");
      const parentFile = parent.manager.getSessionFile()!;

      const child = new FakePi(workspace);
      child.manager = new FakeSessionManager(
        "malformed-fork",
        join(home, "malformed-fork.jsonl"),
        workspace,
        parentFile,
      );
      const active = child.manager.appendEntry();
      child.manager.entries.set("cycle-left", {
        id: "cycle-left",
        parentId: "cycle-right",
        timestamp: new Date(0).toISOString(),
        type: "custom",
      });
      child.manager.entries.set("cycle-right", {
        id: "cycle-right",
        parentId: "cycle-left",
        timestamp: new Date(0).toISOString(),
        type: "custom",
      });
      child.manager.setLeaf(active.id);
      registerCyclotomy(child.api);
      await child.startSession("fork", parentFile);

      expect(
        notifiedWithDetail(
          child,
          "sessionRegistrationFailed",
          "Pi session contains a parent cycle",
        ),
      ).toBe(true);
      const db = metadata();
      expect(
        readTestSessionRegistration(metadataPath(), "malformed-fork"),
      ).toBeUndefined();
      db.close();
    });

    it("pauses when Pi overrides a session into a different workspace", async () => {
      const recordedWorkspace = await mkdtemp(
        join(tmpdir(), "cyclotomy-pi-recorded-workspace-"),
      );
      try {
        const pi = new FakePi(workspace);
        pi.manager = new FakeSessionManager(
          "overridden",
          join(home, "overridden.jsonl"),
          workspace,
          null,
          recordedWorkspace,
        );
        registerCyclotomy(pi.api);

        await pi.startSession("resume");
        await writeFile(join(workspace, "unowned.txt"), "unowned");
        await pi.endTurn(0);
        await pi.runCommand("drift");

        expect(notified(pi, "sessionWorkspaceMismatch")).toBe(true);
        await expect(stat(storeRoot)).rejects.toThrow();
      } finally {
        await rm(recordedWorkspace, { recursive: true, force: true });
      }
    });

    it("keeps harmless captures when later fork and switch hooks veto", async () => {
      const pi = new FakePi(workspace);
      registerCyclotomy(pi.api);
      await pi.startSession("startup");
      await writeFile(join(workspace, "a.txt"), "saved");
      await pi.endTurn();
      const source = pi.manager.getLeafId()!;
      const initial = metadata();
      const initialOid = checkpointState(
        initial,
        pi.manager.sessionId,
        source,
      )!.treeOid;
      initial.close();
      await writeFile(join(workspace, "a.txt"), "before-fork-veto");
      pi.api.on("session_before_fork", async () => ({ cancel: true }));

      expect(await pi.fork(source)).toBe("cancelled");
      let db = metadata();
      const forkOid = checkpointState(
        db,
        pi.manager.sessionId,
        source,
      )!.treeOid;
      expect(forkOid).not.toBe(initialOid);
      db.close();

      await writeFile(join(workspace, "a.txt"), "before-switch-veto");
      pi.api.on("session_before_switch", async () => ({ cancel: true }));
      expect(await pi.resumeTo(pi.newDetachedSession())).toBe("cancelled");
      db = metadata();
      expect(
        checkpointState(db, pi.manager.sessionId, source)?.treeOid,
      ).not.toBe(forkOid);
      db.close();
    });
  });
});
