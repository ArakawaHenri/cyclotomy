import { parseArgs } from "node:util";

import { SESSION_HISTORY_PAGE_MAX_SIZE } from "../infrastructure/metadata-readonly.ts";
import type { CyclotomyLocale } from "../config.ts";

/** A command line that no command can be dispatched from. */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export interface CliGlobalOptions {
  /** Workspace path as written by the caller, before realpath. */
  readonly workspace: string | undefined;
  /** Explicit locale override; undefined means the configured locale. */
  readonly locale: CyclotomyLocale | undefined;
  readonly json: boolean;
}

export type CliCommand =
  | { readonly kind: "doctor" }
  | { readonly kind: "history" }
  | { readonly kind: "inventory"; readonly sessionId: string | undefined }
  | {
      readonly kind: "history-forget";
      readonly sessionId: string;
      readonly applyToken: string | undefined;
    }
  | { readonly kind: "lock-recover"; readonly applyToken: string | undefined }
  | { readonly kind: "gc" };

export interface CliInvocation {
  readonly command: CliCommand;
  readonly options: CliGlobalOptions;
  readonly pageSize: number | undefined;
  readonly cursor: string | undefined;
}

export type CliParseOutcome =
  | { readonly kind: "invocation"; readonly invocation: CliInvocation }
  | { readonly kind: "help" };

const OPTIONS = {
  workspace: { type: "string" },
  locale: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean" },
  "page-size": { type: "string" },
  cursor: { type: "string" },
  session: { type: "string" },
  apply: { type: "string" },
  offline: { type: "boolean" },
} as const;

type OptionName = keyof typeof OPTIONS;

/** Options every command accepts; the rest belong to one command each. */
const GLOBAL_OPTION_NAMES: readonly OptionName[] = [
  "workspace",
  "locale",
  "json",
  "help",
];

const COMMAND_OPTIONS: Readonly<Record<string, readonly OptionName[]>> = {
  doctor: [],
  history: ["page-size", "cursor"],
  inventory: ["session"],
  "history-forget": ["apply"],
  "lock-recover": ["offline", "apply"],
  gc: [],
};

interface ParsedValues {
  readonly workspace?: string | undefined;
  readonly locale?: string | undefined;
  readonly json?: boolean | undefined;
  readonly help?: boolean | undefined;
  readonly "page-size"?: string | undefined;
  readonly cursor?: string | undefined;
  readonly session?: string | undefined;
  readonly apply?: string | undefined;
  readonly offline?: boolean | undefined;
}

export interface CliArguments {
  readonly values: ParsedValues;
  readonly positionals: readonly string[];
}

/**
 * Parse once with the union of every option, then check the command's own set.
 * Subcommands resolve to one canonical kind first, so `history forget --apply`
 * is judged against the option set of `history-forget`, not of `history`.
 */
export function parseCliArguments(argv: readonly string[]): CliParseOutcome {
  let parsed: CliArguments;
  try {
    const result = parseArgs({
      args: [...argv],
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
    parsed = {
      values: result.values as ParsedValues,
      positionals: result.positionals,
    };
  } catch (cause) {
    throw new CliUsageError(
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  const values = parsed.values;
  if (values.help === true) return { kind: "help" };

  const json = values.json === true;
  const options: CliGlobalOptions = {
    workspace: values.workspace,
    locale: parseLocale(values.locale),
    json,
  };

  const [head, ...rest] = parsed.positionals;
  if (head === undefined) {
    throw new CliUsageError("a command is required; run `cyclotomy --help`");
  }
  const { kind, positionals } = resolveCommand(head, rest);
  assertOptionsAllowed(kind, values);
  return {
    kind: "invocation",
    invocation: {
      command: buildCommand(kind, positionals, values),
      options,
      pageSize: parsePageSize(values["page-size"]),
      cursor: parseNonEmpty(values.cursor, "--cursor"),
    },
  };
}

function resolveCommand(
  head: string,
  rest: readonly string[],
): { readonly kind: string; readonly positionals: readonly string[] } {
  switch (head) {
    case "doctor":
    case "inventory":
    case "gc":
      return { kind: head, positionals: rest };
    case "history": {
      const [subcommand, ...tail] = rest;
      if (subcommand === undefined) return { kind: "history", positionals: [] };
      if (subcommand !== "forget") {
        throw new CliUsageError(
          `unknown command "history ${subcommand}"; expected "history forget <id>"`,
        );
      }
      return { kind: "history-forget", positionals: tail };
    }
    case "lock": {
      const [subcommand, ...tail] = rest;
      if (subcommand !== "recover") {
        throw new CliUsageError(
          `unknown command "lock ${subcommand ?? ""}"; expected "lock recover"`,
        );
      }
      return { kind: "lock-recover", positionals: tail };
    }
    default:
      throw new CliUsageError(`unknown command ${JSON.stringify(head)}`);
  }
}

function assertOptionsAllowed(kind: string, values: ParsedValues): void {
  const allowed = new Set<OptionName>([
    ...GLOBAL_OPTION_NAMES,
    ...(COMMAND_OPTIONS[kind] ?? []),
  ]);
  for (const name of Object.keys(OPTIONS) as OptionName[]) {
    if (values[name] !== undefined && !allowed.has(name)) {
      throw new CliUsageError(`option --${name} does not apply to ${kind}`);
    }
  }
}

function buildCommand(
  kind: string,
  positionals: readonly string[],
  values: ParsedValues,
): CliCommand {
  const expectNone = (): void => {
    if (positionals.length > 0) {
      throw new CliUsageError(
        `unexpected argument ${JSON.stringify(positionals[0])} for ${kind}`,
      );
    }
  };
  switch (kind) {
    case "doctor":
      expectNone();
      return { kind: "doctor" };
    case "gc":
      expectNone();
      return { kind: "gc" };
    case "history":
      expectNone();
      return { kind: "history" };
    case "history-forget": {
      const [sessionId, ...extra] = positionals;
      if (extra.length > 0) {
        throw new CliUsageError(
          `unexpected argument ${JSON.stringify(extra[0])} for "history forget"`,
        );
      }
      return {
        kind: "history-forget",
        sessionId: requireSessionId(sessionId),
        applyToken: parseApplyToken(values.apply),
      };
    }
    case "inventory": {
      expectNone();
      const sessionId = parseNonEmpty(values.session, "--session");
      return { kind: "inventory", sessionId };
    }
    case "lock-recover": {
      expectNone();
      if (values.offline !== true) {
        throw new CliUsageError(
          '"lock recover" requires --offline: lock occupancy cannot prove that every accessing process has stopped',
        );
      }
      return {
        kind: "lock-recover",
        applyToken: parseApplyToken(values.apply),
      };
    }
    default:
      throw new CliUsageError(`unknown command ${JSON.stringify(kind)}`);
  }
}

function parseLocale(value: string | undefined): CyclotomyLocale | undefined {
  if (value === undefined) return undefined;
  if (value === "auto" || value === "en" || value === "zh-CN") return value;
  throw new CliUsageError('--locale must be "auto", "en", or "zh-CN"');
}

function parsePageSize(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-9]+$/u.test(value)) {
    throw new CliUsageError("--page-size must be a positive integer");
  }
  const parsed = Number(value);
  if (parsed < 1 || parsed > SESSION_HISTORY_PAGE_MAX_SIZE) {
    throw new CliUsageError(
      `--page-size must be between 1 and ${SESSION_HISTORY_PAGE_MAX_SIZE}`,
    );
  }
  return parsed;
}

function parseApplyToken(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new CliUsageError("--apply expects the 64-character plan token");
  }
  return value;
}

function parseNonEmpty(
  value: string | undefined,
  option: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === "") {
    throw new CliUsageError(`${option} must not be empty`);
  }
  return value;
}

function requireSessionId(value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new CliUsageError('"history forget" requires a session id');
  }
  return value;
}
