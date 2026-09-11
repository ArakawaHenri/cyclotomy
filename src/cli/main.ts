import { loadCyclotomyConfig } from "../config.ts";
import { formatUiDetail } from "../presentation/restore-presentation.ts";
import {
  createCyclotomyI18n,
  type CyclotomyI18n,
} from "../presentation/i18n.ts";
import { cliFailure } from "./failure.ts";
import { CliUsageError, parseCliArguments } from "./arguments.ts";
import { runCliCommand, type CliCommandExecution } from "./commands.ts";
import {
  CliResolutionError,
  defaultAgentDir,
  resolveCliContext,
  type CliRuntime,
} from "./context.ts";
import { buildEnvelope, exitCodeOf, serializeEnvelope } from "./envelope.ts";
import { issueLines, line, localizedStatus } from "./human.ts";

/** Where a command writes; injected so tests never need the real process. */
export interface CliStreams {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

/** One run's process-level dependencies; see {@link CliRuntime}. */
export type CliRunOptions = CliRuntime;

const EXIT_USAGE = 2;

/** Locale for messages printed before (or instead of) a resolved context. */
function fallbackI18n(env: NodeJS.ProcessEnv): CyclotomyI18n {
  try {
    return createCyclotomyI18n(
      loadCyclotomyConfig(defaultAgentDir(env)).locale,
    );
  } catch {
    return createCyclotomyI18n("auto");
  }
}

function wasCancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** The header every human report starts with. */
function renderExecution(
  execution: CliCommandExecution,
  workspace: { readonly requested: string; readonly canonical: string } | null,
  storeRoot: string | null,
  i18n: CyclotomyI18n,
): string[] {
  const lines = [
    i18n.t("cliSummary", {
      command: execution.command,
      status: localizedStatus(execution.outcome.status, i18n),
    }),
  ];
  if (workspace !== null) {
    const canonical =
      workspace.canonical === workspace.requested
        ? workspace.canonical
        : `${workspace.requested} → ${workspace.canonical}`;
    lines.push(line(i18n.t("cliLabelWorkspace"), canonical));
  }
  if (storeRoot !== null) {
    lines.push(
      line(
        i18n.t("cliLabelStore"),
        `${storeRoot} · ${
          execution.storePresent === true
            ? i18n.t("cliLabelPresent")
            : execution.storePresent === false
              ? i18n.t("cliLabelAbsent")
              : i18n.t("cliLabelUnknown")
        } · ${execution.storeState}`,
      ),
    );
  }
  lines.push(...execution.human);
  lines.push(...issueLines(execution.outcome.issues, i18n));
  return lines;
}

function write(stream: (text: string) => void, text: string): void {
  stream(text.endsWith("\n") ? text : `${text}\n`);
}

/**
 * One CLI run: parse, resolve, execute, report. Every failure that is not a
 * usage or resolution error becomes a diagnosed `error` outcome, so a script
 * still receives the documented envelope instead of a bare stack trace.
 */
export async function runCli(
  argv: readonly string[],
  streams: CliStreams,
  options: CliRunOptions = {},
): Promise<number> {
  const env = options.env ?? process.env;
  let i18n = fallbackI18n(env);

  let parsed;
  try {
    parsed = parseCliArguments(argv);
  } catch (cause) {
    if (cause instanceof CliUsageError) {
      write(streams.err, i18n.t("cliUsageError", { message: cause.message }));
      write(streams.err, i18n.t("cliUsage"));
      return EXIT_USAGE;
    }
    throw cause;
  }
  if (parsed.kind === "help") {
    write(streams.out, i18n.t("cliUsage"));
    return 0;
  }
  const invocation = parsed.invocation;
  if (invocation.options.locale !== undefined) {
    i18n = createCyclotomyI18n(invocation.options.locale);
  }

  let context;
  try {
    context = await resolveCliContext(invocation.options, {
      ...options,
      // Logs and progress belong on stderr: stdout carries exactly one
      // document, and only when the command finished or failed with a report.
      onProgress: options.onProgress ?? ((text) => write(streams.err, text)),
    });
  } catch (cause) {
    if (cause instanceof CliResolutionError) {
      const message =
        cause.code === "configuration"
          ? i18n.t("cliConfigurationError", {
              detail: formatUiDetail(cause.detail, Infinity),
            })
          : i18n.t("cliWorkspaceUnresolved", { path: cause.detail });
      write(streams.err, message);
      return EXIT_USAGE;
    }
    throw cause;
  }

  let execution: CliCommandExecution;
  try {
    execution = await runCliCommand(context, invocation);
  } catch (cause) {
    const outcome = cliFailure(cause, options.signal);
    const failed: CliCommandExecution = {
      command: invocation.command.kind,
      storePresent: null,
      storeState: "unavailable",
      outcome,
      human: [],
    };
    if (invocation.options.json) {
      write(
        streams.out,
        serializeEnvelope(
          buildEnvelope(
            failed.command,
            {
              requested: context.workspaceRequested,
              canonical: context.workspaceCanonical,
            },
            { root: context.storeRoot, present: failed.storePresent },
            failed.storeState,
            outcome,
          ),
        ),
      );
    } else {
      write(
        streams.err,
        renderExecution(
          failed,
          {
            requested: context.workspaceRequested,
            canonical: context.workspaceCanonical,
          },
          context.storeRoot,
          context.i18n,
        ).join("\n"),
      );
    }
    return exitCodeOf(outcome);
  }

  if (invocation.options.json) {
    write(
      streams.out,
      serializeEnvelope(
        buildEnvelope(
          execution.command,
          {
            requested: context.workspaceRequested,
            canonical: context.workspaceCanonical,
          },
          { root: context.storeRoot, present: execution.storePresent },
          execution.storeState,
          execution.outcome,
        ),
      ),
    );
  } else {
    write(
      streams.out,
      renderExecution(
        execution,
        {
          requested: context.workspaceRequested,
          canonical: context.workspaceCanonical,
        },
        context.storeRoot,
        context.i18n,
      ).join("\n"),
    );
  }

  if (wasCancelled(options.signal)) {
    // The command reached a completed state before cancellation was observed;
    // the exit code must agree with the document that was just written.
    write(streams.err, context.i18n.t("cliCancelled"));
  }
  return exitCodeOf(execution.outcome);
}
