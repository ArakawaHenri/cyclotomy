import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  ABSOLUTE_MAX_TREE_ENTRIES,
  ABSOLUTE_MAX_TREE_MANIFEST_BYTES,
  DEFAULT_MAX_TREE_ENTRIES,
  DEFAULT_MAX_TREE_MANIFEST_BYTES,
} from "./infrastructure/tree-formats/manifest-codec.ts";
import {
  ABSOLUTE_MAX_WORKSPACE_RELATIVE_PATH_BYTES,
  ABSOLUTE_MAX_WORKSPACE_RELATIVE_PATH_COMPONENTS,
  DEFAULT_MAX_WORKSPACE_RELATIVE_PATH_BYTES,
  DEFAULT_MAX_WORKSPACE_RELATIVE_PATH_COMPONENTS,
} from "./infrastructure/workspace-scope.ts";

export type CyclotomyLocale = "auto" | "en" | "zh-CN";

export interface CyclotomyConfig {
  /** Fixed user-level settings file under Pi's agent directory. */
  readonly globalSettingsPath: string;
  /** Root containing the per-workspace hash directories. */
  readonly storageRootPath: string;
  readonly scan: {
    readonly maxFileBytes: number;
    readonly maxSnapshotBytes: number;
    /** Canonical root plus every directory entry observed before classification. */
    readonly maxEntries: number;
    readonly maxManifestBytes: number;
    /** Maximum UTF-8 bytes in one workspace-relative path. */
    readonly maxPathBytes: number;
    /** Maximum slash-separated components in one workspace-relative path. */
    readonly maxPathComponents: number;
  };
  readonly lock: {
    readonly timeoutMs: number;
    readonly heartbeatMs: number;
    readonly staleMs: number;
  };
  /** Minimum gap between automatic GC runs; 0 disables automatic GC. */
  readonly autoGcIntervalMs: number;
  readonly locale: CyclotomyLocale;
}

export class CyclotomyConfigError extends Error {
  readonly settingsPath: string;
  readonly detail: string;

  constructor(settingsPath: string, detail: string, cause?: unknown) {
    super(
      `invalid Cyclotomy configuration at ${JSON.stringify(settingsPath)}: ${detail}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "CyclotomyConfigError";
    this.settingsPath = settingsPath;
    this.detail = detail;
  }
}

interface ConfigOverrides {
  readonly storageDir?: string;
  readonly maxFileBytes?: number;
  readonly maxSnapshotBytes?: number;
  readonly maxEntries?: number;
  readonly maxManifestBytes?: number;
  readonly maxPathBytes?: number;
  readonly maxPathComponents?: number;
  readonly lockTimeoutMs?: number;
  readonly autoGcIntervalMs?: number;
  readonly locale?: CyclotomyLocale;
}

type SettingsScope = "global" | "workspace";

const MIB = 1024 * 1024;
const LOCK_HEARTBEAT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const SETTINGS_FILE = "settings.json";

function configError(
  settingsPath: string,
  detail: string,
  cause?: unknown,
): never {
  throw new CyclotomyConfigError(settingsPath, detail, cause);
}

function objectValue(
  value: unknown,
  settingsPath: string,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return configError(settingsPath, `${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function positiveSafeInteger(
  value: unknown,
  settingsPath: string,
  label: string,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return configError(settingsPath, `${label} must be a positive integer`);
  }
  return value;
}

function boundedPositiveSafeInteger(
  value: unknown,
  maximum: number,
  settingsPath: string,
  label: string,
): number {
  const parsed = positiveSafeInteger(value, settingsPath, label);
  if (parsed > maximum) {
    return configError(settingsPath, `${label} must not exceed ${maximum}`);
  }
  return parsed;
}

function nonNegativeSafeInteger(
  value: unknown,
  settingsPath: string,
  label: string,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return configError(settingsPath, `${label} must be a non-negative integer`);
  }
  return value;
}

function positiveMiB(
  value: unknown,
  settingsPath: string,
  label: string,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return configError(settingsPath, `${label} must be a positive number`);
  }
  const bytes = Math.floor(value * MIB);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    return configError(settingsPath, `${label} is outside the supported range`);
  }
  return bytes;
}

function localeValue(value: unknown, settingsPath: string): CyclotomyLocale {
  if (value === "auto" || value === "en" || value === "zh-CN") {
    return value;
  }
  return configError(settingsPath, 'locale must be "auto", "en", or "zh-CN"');
}

function parseSettings(
  value: unknown,
  settingsPath: string,
  scope: SettingsScope,
): ConfigOverrides {
  const root = objectValue(value, settingsPath, "settings");
  if (scope === "workspace" && Object.hasOwn(root, "storageDir")) {
    configError(settingsPath, "storageDir is only allowed in global settings");
  }
  if (scope === "workspace" && Object.hasOwn(root, "locale")) {
    configError(settingsPath, "locale is only allowed in global settings");
  }

  const parsed: {
    storageDir?: string;
    maxFileBytes?: number;
    maxSnapshotBytes?: number;
    maxEntries?: number;
    maxManifestBytes?: number;
    maxPathBytes?: number;
    maxPathComponents?: number;
    lockTimeoutMs?: number;
    autoGcIntervalMs?: number;
    locale?: CyclotomyLocale;
  } = {};

  if (Object.hasOwn(root, "storageDir")) {
    if (typeof root.storageDir !== "string" || root.storageDir.trim() === "") {
      configError(settingsPath, "storageDir must be a non-empty string");
    }
    parsed.storageDir = root.storageDir;
  }
  if (Object.hasOwn(root, "maxFileMiB")) {
    parsed.maxFileBytes = positiveMiB(
      root.maxFileMiB,
      settingsPath,
      "maxFileMiB",
    );
  }
  if (Object.hasOwn(root, "maxSnapshotMiB")) {
    parsed.maxSnapshotBytes = positiveMiB(
      root.maxSnapshotMiB,
      settingsPath,
      "maxSnapshotMiB",
    );
  }
  if (Object.hasOwn(root, "maxEntries")) {
    parsed.maxEntries = boundedPositiveSafeInteger(
      root.maxEntries,
      ABSOLUTE_MAX_TREE_ENTRIES,
      settingsPath,
      "maxEntries",
    );
  }
  if (Object.hasOwn(root, "maxManifestMiB")) {
    const bytes = positiveMiB(
      root.maxManifestMiB,
      settingsPath,
      "maxManifestMiB",
    );
    if (bytes > ABSOLUTE_MAX_TREE_MANIFEST_BYTES) {
      configError(
        settingsPath,
        `maxManifestMiB must not exceed ${
          ABSOLUTE_MAX_TREE_MANIFEST_BYTES / MIB
        }`,
      );
    }
    parsed.maxManifestBytes = bytes;
  }
  if (Object.hasOwn(root, "maxPathBytes")) {
    parsed.maxPathBytes = boundedPositiveSafeInteger(
      root.maxPathBytes,
      ABSOLUTE_MAX_WORKSPACE_RELATIVE_PATH_BYTES,
      settingsPath,
      "maxPathBytes",
    );
  }
  if (Object.hasOwn(root, "maxPathComponents")) {
    parsed.maxPathComponents = boundedPositiveSafeInteger(
      root.maxPathComponents,
      ABSOLUTE_MAX_WORKSPACE_RELATIVE_PATH_COMPONENTS,
      settingsPath,
      "maxPathComponents",
    );
  }
  if (Object.hasOwn(root, "lockTimeoutMs")) {
    parsed.lockTimeoutMs = positiveSafeInteger(
      root.lockTimeoutMs,
      settingsPath,
      "lockTimeoutMs",
    );
  }
  if (Object.hasOwn(root, "locale")) {
    parsed.locale = localeValue(root.locale, settingsPath);
  }
  if (Object.hasOwn(root, "gc")) {
    const gc = objectValue(root.gc, settingsPath, "gc");
    if (Object.hasOwn(gc, "intervalMs")) {
      parsed.autoGcIntervalMs = nonNegativeSafeInteger(
        gc.intervalMs,
        settingsPath,
        "gc.intervalMs",
      );
    }
  }
  return parsed;
}

function readSettings(
  settingsPath: string,
  scope: SettingsScope,
): ConfigOverrides {
  let bytes: Buffer;
  try {
    bytes = readFileSync(settingsPath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return {};
    return configError(settingsPath, "settings file cannot be read", cause);
  }

  let contents: string;
  try {
    contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    return configError(settingsPath, "settings file is not valid UTF-8", cause);
  }

  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (cause) {
    return configError(settingsPath, "settings file is not valid JSON", cause);
  }
  return parseSettings(value, settingsPath, scope);
}

function resolveStorageRoot(
  agentDir: string,
  configured: string | undefined,
  settingsPath: string,
): string {
  if (configured === undefined) return resolve(agentDir, "cyclotomy");
  if (configured === "~") return homedir();
  if (/^~[\\/]/u.test(configured)) {
    return join(homedir(), configured.slice(2));
  }
  if (configured.startsWith("~")) {
    return configError(
      settingsPath,
      "storageDir supports only ~ or ~/... home-directory expansion",
    );
  }
  if (
    process.platform === "win32" &&
    /^[A-Za-z]:(?:$|[^\\/])/u.test(configured)
  ) {
    return configError(
      settingsPath,
      "storageDir must not use a drive-relative Windows path",
    );
  }
  // An absolute second argument replaces agentDir. Every other path is
  // deliberately anchored to Pi's agent directory rather than process.cwd().
  return resolve(agentDir, configured);
}

function applyOverrides(
  base: CyclotomyConfig,
  overrides: ConfigOverrides,
  storageRootPath = base.storageRootPath,
): CyclotomyConfig {
  return {
    globalSettingsPath: base.globalSettingsPath,
    storageRootPath,
    scan: {
      maxFileBytes: overrides.maxFileBytes ?? base.scan.maxFileBytes,
      maxSnapshotBytes:
        overrides.maxSnapshotBytes ?? base.scan.maxSnapshotBytes,
      maxEntries: overrides.maxEntries ?? base.scan.maxEntries,
      maxManifestBytes:
        overrides.maxManifestBytes ?? base.scan.maxManifestBytes,
      maxPathBytes: overrides.maxPathBytes ?? base.scan.maxPathBytes,
      maxPathComponents:
        overrides.maxPathComponents ?? base.scan.maxPathComponents,
    },
    lock: {
      timeoutMs: overrides.lockTimeoutMs ?? base.lock.timeoutMs,
      heartbeatMs: LOCK_HEARTBEAT_MS,
      staleMs: LOCK_STALE_MS,
    },
    autoGcIntervalMs: overrides.autoGcIntervalMs ?? base.autoGcIntervalMs,
    locale: overrides.locale ?? base.locale,
  };
}

/**
 * The documented defaults for one Pi agent directory. Registration falls back
 * to these when the global settings file cannot be loaded, so an unusable
 * configuration disables Cyclotomy instead of failing Pi's extension load.
 */
export function defaultCyclotomyConfig(agentDir: string): CyclotomyConfig {
  const settingsRoot = resolve(agentDir, "cyclotomy");
  return {
    globalSettingsPath: join(settingsRoot, SETTINGS_FILE),
    storageRootPath: settingsRoot,
    scan: {
      maxFileBytes: 50 * MIB,
      maxSnapshotBytes: 2 * 1024 * MIB,
      maxEntries: DEFAULT_MAX_TREE_ENTRIES,
      maxManifestBytes: DEFAULT_MAX_TREE_MANIFEST_BYTES,
      maxPathBytes: DEFAULT_MAX_WORKSPACE_RELATIVE_PATH_BYTES,
      maxPathComponents: DEFAULT_MAX_WORKSPACE_RELATIVE_PATH_COMPONENTS,
    },
    lock: {
      timeoutMs: 5_000,
      heartbeatMs: LOCK_HEARTBEAT_MS,
      staleMs: LOCK_STALE_MS,
    },
    autoGcIntervalMs: 24 * 60 * 60 * 1000,
    locale: "auto",
  };
}

/** Read the user-level settings once when the extension is registered. */
export function loadCyclotomyConfig(agentDir: string): CyclotomyConfig {
  const base = defaultCyclotomyConfig(agentDir);
  const settingsPath = base.globalSettingsPath;
  const overrides = readSettings(settingsPath, "global");
  const storageRootPath = resolveStorageRoot(
    agentDir,
    overrides.storageDir,
    settingsPath,
  );
  return applyOverrides(base, overrides, storageRootPath);
}

/** Read one canonical workspace's overrides once, before its store is opened. */
export function loadWorkspaceCyclotomyConfig(
  globalConfig: CyclotomyConfig,
  storeRoot: string,
): CyclotomyConfig {
  const settingsPath = join(storeRoot, SETTINGS_FILE);
  const overrides = readSettings(settingsPath, "workspace");
  return applyOverrides(globalConfig, overrides);
}
