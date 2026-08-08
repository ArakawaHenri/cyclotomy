import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CyclotomyConfigError,
  defaultCyclotomyConfig,
  loadCyclotomyConfig,
} from "../src/config.ts";
import { CyclotomyI18n } from "../src/pi/i18n.ts";
import { CyclotomyRuntime } from "../src/pi/runtime.ts";
import type { SessionView } from "../src/pi/session-view.ts";
import { publishTestBlob, publishTestTree } from "./object-store-fixture.ts";
import { ALL_MANAGED_SCOPE } from "./workspace-scope-fixture.ts";

const roots: string[] = [];
const TEST_SCOPE = ALL_MANAGED_SCOPE;

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

function view(
  cwd: string,
  leafId: string,
  parents: Readonly<Record<string, string | null>>,
): SessionView {
  return {
    cwd,
    sessionId: "s",
    sessionFile: null,
    parentSessionFile: null,
    leafId,
    parentIdOf(entryId) {
      return Object.hasOwn(parents, entryId) ? parents[entryId] : undefined;
    },
    entryOf(entryId) {
      return Object.hasOwn(parents, entryId)
        ? ({ id: entryId } as NonNullable<ReturnType<SessionView["entryOf"]>>)
        : undefined;
    },
    entryTypeOf() {
      return undefined;
    },
    navigationLandingId(entryId) {
      return Object.hasOwn(parents, entryId) ? entryId : undefined;
    },
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Cyclotomy runtime", () => {
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
        'maxFileMiB must be a positive number',
      ),
    );

    expect(await runtime.ensureStore(workspace)).toBe(false);

    // A disabled runtime must not create the hashed store while binding.
    expect(await readdir(join(home, "cyclotomy")).catch(() => []))
      .toEqual([]);
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
    // Long paths are middle-elided into one bounded UI line, so assert the
    // tail the user actually needs to find the file.
    expect(notifications[0]!.message).toContain(basename(settingsPath));
    expect(notifications[0]!.message).toContain("maxFileMiB");
    expect(notifications[0]!.message).toContain("/reload");

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
        gc: { intervalMs: 90_000, sessionRetentionMs: 200_000 },
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
      JSON.stringify({ maxFileMiB: 2, gc: { intervalMs: 0 } }),
    );
    const runtime = new CyclotomyRuntime(
      globalConfig,
      new CyclotomyI18n("en"),
    );

    expect(await runtime.ensureStore(workspace)).toBe(true);
    expect(runtime.storeRoot).toBe(await realpath(storeRoot));
    expect(runtime.config.scan.maxFileBytes).toBe(2 * 1024 * 1024);
    expect(runtime.config.autoGcIntervalMs).toBe(0);
    expect(runtime.config.sessionMetadataRetentionMs).toBe(200_000);
    runtime.close();
  });

  it("keeps one workspace configuration until a new extension runtime is created", async () => {
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
    const runtime = new CyclotomyRuntime(
      globalConfig,
      new CyclotomyI18n("en"),
    );

    expect(await runtime.ensureStore(workspace)).toBe(true);
    expect(runtime.config.scan.maxFileBytes).toBe(2 * 1024 * 1024);
    runtime.close();
    await writeFile(settingsPath, JSON.stringify({ maxFileMiB: 3 }));
    expect(await runtime.ensureStore(workspace)).toBe(true);
    expect(runtime.config.scan.maxFileBytes).toBe(2 * 1024 * 1024);
    runtime.close();

    const reloaded = new CyclotomyRuntime(
      loadCyclotomyConfig(home),
      new CyclotomyI18n("en"),
    );
    expect(await reloaded.ensureStore(workspace)).toBe(true);
    expect(reloaded.config.scan.maxFileBytes).toBe(3 * 1024 * 1024);
    reloaded.close();
  });

  it("keeps an invalid workspace configuration failed closed until reload", async () => {
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

  it("rejects a store symlink located inside the managed workspace", async (context) => {
    context.skip(
      process.platform === "win32",
      "Windows symlink creation is privilege-dependent",
    );
    const parent = await mkdtemp(join(tmpdir(), "cyclotomy-runtime-store-link-"));
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
    const parent = await mkdtemp(join(tmpdir(), "cyclotomy-runtime-hash-link-"));
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
    const firstRuntime = new CyclotomyRuntime(
      config,
      new CyclotomyI18n("en"),
    );
    const secondRuntime = new CyclotomyRuntime(
      config,
      new CyclotomyI18n("en"),
    );

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
      (await readdir(runtime.storeRoot)).filter((name) =>
        name.startsWith(`gc-state.json.${process.pid}.`) &&
        name.endsWith(".tmp")
      ),
    ).toEqual([]);
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
    runtime.metadata.setState("s", "e", "a".repeat(64));
    expect(await runtime.ensureStore(second)).toBe(false);
    expect(runtime.storeRoot).toBe(firstRoot);
    expect(runtime.metadata.getState("s", "e")?.treeOid).toBe("a".repeat(64));

    runtime.close();
    expect(await runtime.ensureStore(second)).toBe(true);
    expect(runtime.storeRoot).not.toBe(firstRoot);
    expect(runtime.metadata.getState("s", "e")).toBeUndefined();
    runtime.close();
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
    const prepared = await runtime.prepareCaptureResult(
      view(link, "leaf", { leaf: null }),
    );
    expect(prepared).toMatchObject({
      ok: false,
      error: { kind: "scan-failed" },
    });
    expect(runtime.metadata.getState("s", "leaf")).toBeUndefined();
    runtime.close();
  });

  it("treats the nearest recorded ancestor as authoritative", async () => {
    const { workspace, runtime } = await createRuntime();
    const parentBlob = await publishTestBlob(runtime.store, Buffer.from("parent"));
    const parentTree = await publishTestTree(runtime.store, [{
      path: "file.txt",
      type: "regular",
      blobOid: parentBlob,
      recreationMode: 0o600,
    }], TEST_SCOPE);
    const leafBlob = await publishTestBlob(runtime.store, Buffer.from("leaf"));
    const leafTree = await publishTestTree(runtime.store, [{
      path: "file.txt",
      type: "regular",
      blobOid: leafBlob,
      recreationMode: 0o600,
    }], TEST_SCOPE);
    runtime.metadata.setState("s", "parent", parentTree);
    runtime.metadata.setState("s", "leaf", leafTree);
    await writeFile(join(workspace, "file.txt"), "current");
    await rm(join(
      runtime.storeRoot,
      "objects",
      "blobs",
      leafBlob.slice(0, 2),
      leafBlob.slice(2),
    ));

    const currentView = view(
      workspace,
      "leaf",
      { parent: null, leaf: "parent" },
    );
    await expect(runtime.resolveReadableTreeIn(
      currentView,
      { sessionId: "s", entryId: "leaf" },
    )).rejects.toThrow();
    expect(runtime.resolutionStillAuthoritative(
      currentView,
      { sessionId: "s", entryId: "leaf" },
      {
        treeOid: leafTree,
        foundAt: { sessionId: "s", entryId: "leaf" },
      },
    )).toBe(true);
    expect(runtime.metadata.getState("s", "parent")?.treeOid).toBe(parentTree);
    runtime.close();
  });
});
