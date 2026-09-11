import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  loadCyclotomyConfig,
  loadWorkspaceCyclotomyConfig,
  type CyclotomyConfig,
  type CyclotomyLocale,
} from "../config.ts";
import {
  defaultFilesystemKindProbe,
  type FilesystemKindProbe,
} from "../infrastructure/filesystem-kind.ts";
import { workspaceStorePath } from "../infrastructure/workspace-store.ts";
import {
  createCyclotomyI18n,
  type CyclotomyI18n,
} from "../presentation/i18n.ts";
import { messageOfUnknown } from "../presentation/unknown-error.ts";
import type { CliGlobalOptions } from "./arguments.ts";

export type CliResolutionErrorCode = "configuration" | "workspace-unresolved";

/** A failure that stops argument-independent resolution before any store work. */
export class CliResolutionError extends Error {
  readonly code: CliResolutionErrorCode;
  readonly detail: string;

  constructor(code: CliResolutionErrorCode, detail: string) {
    super(detail);
    this.name = "CliResolutionError";
    this.code = code;
    this.detail = detail;
  }
}

export interface CliContext {
  readonly i18n: CyclotomyI18n;
  readonly agentDir: string;
  readonly config: CyclotomyConfig;
  readonly workspaceRequested: string;
  readonly workspaceCanonical: string;
  /** Deterministic per-workspace store path; not created by this process. */
  readonly storeRoot: string;
  /** Cancelled by SIGINT, so a bounded command stops before its next write. */
  readonly signal: AbortSignal | undefined;
  /** Filesystem classification probe; injected in tests, never guessed. */
  readonly filesystemProbe: FilesystemKindProbe;
  /** Where a long command narrates its phases; stderr, never the document. */
  readonly progress: (text: string) => void;
}

/** Process-level dependencies a run uses; all default to the real ones. */
export interface CliRuntime {
  readonly signal?: AbortSignal | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly cwd?: string | undefined;
  readonly filesystemProbe?: FilesystemKindProbe | undefined;
  readonly onProgress?: ((text: string) => void) | undefined;
}

/** Pi's agent directory, with the CLI's own default when it is unset. */
export function defaultAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PI_CODING_AGENT_DIR;
  return configured !== undefined && configured.trim() !== ""
    ? configured
    : join(homedir(), ".pi", "agent");
}

/**
 * Resolve the workspace, effective configuration and store path a command runs
 * against. Nothing here creates a directory, migrates a store, or falls back
 * to a guessed location: an unusable configuration is reported as such.
 */
export async function resolveCliContext(
  options: CliGlobalOptions,
  runtime: CliRuntime = {},
): Promise<CliContext> {
  const env = runtime.env ?? process.env;
  const agentDir = defaultAgentDir(env);
  let config: CyclotomyConfig;
  try {
    config = loadCyclotomyConfig(agentDir);
  } catch (cause) {
    throw new CliResolutionError("configuration", messageOfUnknown(cause));
  }

  const cwd = runtime.cwd ?? process.cwd();
  const workspaceRequested =
    options.workspace === undefined ? cwd : resolve(cwd, options.workspace);
  let workspaceCanonical: string;
  try {
    workspaceCanonical = await realpath(workspaceRequested);
  } catch {
    throw new CliResolutionError("workspace-unresolved", workspaceRequested);
  }

  const storeRoot = workspaceStorePath(
    config.storageRootPath,
    workspaceCanonical,
  );
  try {
    config = loadWorkspaceCyclotomyConfig(config, storeRoot);
  } catch (cause) {
    throw new CliResolutionError("configuration", messageOfUnknown(cause));
  }

  const locale: CyclotomyLocale = options.locale ?? config.locale;
  return Object.freeze({
    i18n: createCyclotomyI18n(locale),
    agentDir,
    config,
    workspaceRequested,
    workspaceCanonical,
    storeRoot,
    signal: runtime.signal,
    filesystemProbe: runtime.filesystemProbe ?? defaultFilesystemKindProbe,
    progress: runtime.onProgress ?? (() => {}),
  });
}
