import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CyclotomyConfigError,
  defaultCyclotomyConfig,
  loadCyclotomyConfig,
  loadWorkspaceCyclotomyConfig,
} from "../src/config.ts";

const roots: string[] = [];

async function createAgentDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cyclotomy-config-"));
  roots.push(root);
  return join(root, "agent");
}

async function writeSettings(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    typeof value === "string" ? value : `${JSON.stringify(value)}\n`,
  );
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Cyclotomy configuration", () => {
  it("uses defaults without creating a settings file", async () => {
    const agentDir = await createAgentDir();
    const settingsPath = join(agentDir, "cyclotomy", "settings.json");

    const config = loadCyclotomyConfig(agentDir);

    expect(config).toEqual({
      globalSettingsPath: settingsPath,
      storageRootPath: join(agentDir, "cyclotomy"),
      autoGcIntervalMs: 24 * 60 * 60 * 1000,
      locale: "auto",
      scan: {
        maxFileBytes: 50 * 1024 * 1024,
        maxSnapshotBytes: 2 * 1024 ** 3,
        maxEntries: 100_000,
        maxManifestBytes: 64 * 1024 * 1024,
        maxPathBytes: 64 * 1024,
        maxPathComponents: 256,
      },
      lock: {
        timeoutMs: 5_000,
      },
    });
    await expect(stat(settingsPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("falls back to exactly the documented defaults", async () => {
    const agentDir = await createAgentDir();

    // Registration uses this when the global file cannot be loaded, so the
    // disabled runtime must carry the same configuration a fresh install has.
    expect(defaultCyclotomyConfig(agentDir)).toEqual(
      loadCyclotomyConfig(agentDir),
    );
  });

  it("loads all global settings and resolves relative storage from the Pi agent directory", async () => {
    const agentDir = await createAgentDir();
    await writeSettings(join(agentDir, "cyclotomy", "settings.json"), {
      storageDir: "stores/cyclotomy",
      maxFileMiB: 100,
      maxSnapshotMiB: 50,
      maxEntries: 25_000,
      maxManifestMiB: 16,
      maxPathBytes: 96 * 1024,
      maxPathComponents: 512,
      lockTimeoutMs: 12_000,
      gc: {
        intervalMs: 0,
      },
      locale: "zh-CN",
    });

    const config = loadCyclotomyConfig(agentDir);

    expect(config.storageRootPath).toBe(resolve(agentDir, "stores/cyclotomy"));
    expect(config.scan).toEqual({
      maxFileBytes: 100 * 1024 * 1024,
      maxSnapshotBytes: 50 * 1024 * 1024,
      maxEntries: 25_000,
      maxManifestBytes: 16 * 1024 * 1024,
      maxPathBytes: 96 * 1024,
      maxPathComponents: 512,
    });
    expect(config.lock.timeoutMs).toBe(12_000);
    expect(config.autoGcIntervalMs).toBe(0);
    expect(config.locale).toBe("zh-CN");
  });

  it("expands a leading home-directory marker in storageDir", async () => {
    const agentDir = await createAgentDir();
    await writeSettings(join(agentDir, "cyclotomy", "settings.json"), {
      storageDir: "~/cyclotomy-config-test",
    });

    expect(loadCyclotomyConfig(agentDir).storageRootPath).toBe(
      resolve(homedir(), "cyclotomy-config-test"),
    );

    await writeSettings(join(agentDir, "cyclotomy", "settings.json"), {
      storageDir: "~//cyclotomy-config-test",
    });
    expect(loadCyclotomyConfig(agentDir).storageRootPath).toBe(
      resolve(homedir(), "cyclotomy-config-test"),
    );
  });

  it("rejects settings that are not valid UTF-8", async () => {
    const agentDir = await createAgentDir();
    const settingsPath = join(agentDir, "cyclotomy", "settings.json");
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(
      settingsPath,
      Buffer.from([
        ...Buffer.from('{"storageDir":"'),
        0xff,
        ...Buffer.from('"}'),
      ]),
    );

    expect(() => loadCyclotomyConfig(agentDir)).toThrow("not valid UTF-8");
  });

  it("merges workspace settings over global settings one field at a time", async () => {
    const agentDir = await createAgentDir();
    const globalPath = join(agentDir, "cyclotomy", "settings.json");
    await writeSettings(globalPath, {
      maxFileMiB: 8,
      maxSnapshotMiB: 64,
      maxEntries: 20_000,
      maxManifestMiB: 8,
      maxPathBytes: 80 * 1024,
      maxPathComponents: 384,
      lockTimeoutMs: 7_000,
      gc: { intervalMs: 90_000 },
      locale: "en",
    });
    const globalConfig = loadCyclotomyConfig(agentDir);
    const storeRoot = join(globalConfig.storageRootPath, "workspace-hash");
    await writeSettings(join(storeRoot, "settings.json"), {
      maxFileMiB: 4,
      maxEntries: 10_000,
      maxPathComponents: 320,
      gc: { intervalMs: 0 },
    });

    const config = loadWorkspaceCyclotomyConfig(globalConfig, storeRoot);

    expect(config.scan).toEqual({
      maxFileBytes: 4 * 1024 * 1024,
      maxSnapshotBytes: 64 * 1024 * 1024,
      maxEntries: 10_000,
      maxManifestBytes: 8 * 1024 * 1024,
      maxPathBytes: 80 * 1024,
      maxPathComponents: 320,
    });
    expect(config.lock.timeoutMs).toBe(7_000);
    expect(config.autoGcIntervalMs).toBe(0);
    expect(config.locale).toBe("en");
    expect(config.globalSettingsPath).toBe(globalPath);
    expect(config.storageRootPath).toBe(globalConfig.storageRootPath);
  });

  it.each(["storageDir", "locale"])(
    "rejects the global-only %s setting in a workspace file",
    async (setting) => {
      const agentDir = await createAgentDir();
      const globalConfig = loadCyclotomyConfig(agentDir);
      const storeRoot = join(globalConfig.storageRootPath, "workspace-hash");
      await writeSettings(join(storeRoot, "settings.json"), {
        [setting]: setting === "storageDir" ? "/tmp/elsewhere" : "zh-CN",
      });

      expect(() =>
        loadWorkspaceCyclotomyConfig(globalConfig, storeRoot),
      ).toThrow(`${setting} is only allowed in global settings`);
    },
  );

  it.each([
    ["{", "not valid JSON"],
    ["null", "must be a JSON object"],
    ["[]", "must be a JSON object"],
  ])("rejects malformed settings: %s", async (contents, message) => {
    const agentDir = await createAgentDir();
    await writeSettings(join(agentDir, "cyclotomy", "settings.json"), contents);

    expect(() => loadCyclotomyConfig(agentDir)).toThrow(message);
  });

  it("ignores unknown root and nested properties", async () => {
    const agentDir = await createAgentDir();
    await writeSettings(join(agentDir, "cyclotomy", "settings.json"), {
      maxFileMiB: 8,
      futureRootSetting: { enabled: true },
      gc: {
        intervalMs: 0,
        futureNestedSetting: "ignored",
        futureGcSetting: -1,
      },
    });

    const config = loadCyclotomyConfig(agentDir);
    expect(config.scan.maxFileBytes).toBe(8 * 1024 * 1024);
    expect(config.autoGcIntervalMs).toBe(0);
  });

  it("ignores unknown properties in workspace settings", async () => {
    const agentDir = await createAgentDir();
    const globalConfig = loadCyclotomyConfig(agentDir);
    const storeRoot = join(globalConfig.storageRootPath, "workspace-hash");
    await writeSettings(join(storeRoot, "settings.json"), {
      futureWorkspaceSetting: true,
      gc: { futureGcSetting: { enabled: true } },
    });

    expect(loadWorkspaceCyclotomyConfig(globalConfig, storeRoot)).toEqual(
      globalConfig,
    );
  });

  it.each([
    [{ storageDir: "   " }, "storageDir"],
    [{ maxFileMiB: 0 }, "maxFileMiB"],
    [{ maxFileMiB: 1e-308 }, "maxFileMiB"],
    [{ maxSnapshotMiB: 1e308 }, "maxSnapshotMiB"],
    [{ maxEntries: 0 }, "maxEntries"],
    [{ maxEntries: 1_000_001 }, "maxEntries"],
    [{ maxManifestMiB: 257 }, "maxManifestMiB"],
    [{ maxPathBytes: 0 }, "maxPathBytes"],
    [{ maxPathBytes: 1024 * 1024 + 1 }, "maxPathBytes"],
    [{ maxPathComponents: 0 }, "maxPathComponents"],
    [{ maxPathComponents: 4_097 }, "maxPathComponents"],
    [{ lockTimeoutMs: 1.5 }, "lockTimeoutMs"],
    [{ gc: { intervalMs: -1 } }, "gc.intervalMs"],
    [{ locale: "fr" }, "locale"],
  ])("rejects an invalid value in %s", async (value, field) => {
    const agentDir = await createAgentDir();
    await writeSettings(join(agentDir, "cyclotomy", "settings.json"), value);

    expect(() => loadCyclotomyConfig(agentDir)).toThrow(field);
  });

  it("reports the settings path on configuration errors", async () => {
    const agentDir = await createAgentDir();
    const settingsPath = join(agentDir, "cyclotomy", "settings.json");
    await writeSettings(settingsPath, { locale: "fr" });

    let error: unknown;
    try {
      loadCyclotomyConfig(agentDir);
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(CyclotomyConfigError);
    expect((error as CyclotomyConfigError).settingsPath).toBe(settingsPath);
  });

  it("rejects unsupported named-home expansion instead of treating it as relative", async () => {
    const agentDir = await createAgentDir();
    await writeSettings(join(agentDir, "cyclotomy", "settings.json"), {
      storageDir: "~someone/cyclotomy",
    });

    expect(() => loadCyclotomyConfig(agentDir)).toThrow(
      "supports only ~ or ~/...",
    );
  });
});
