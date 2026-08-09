import type { ApplyProblem } from "../infrastructure/apply.ts";
import type { WorkspaceRestorePlan } from "../infrastructure/restore-plan.ts";
import type { ScanProblem } from "../infrastructure/workspace-scan.ts";
import { portableWorkspacePathKey } from "../infrastructure/workspace-scope.ts";

type RestorePreview = Pick<
  WorkspaceRestorePlan,
  "created" | "deleted" | "modified" | "renamed" | "problems"
>;

export interface RestorePreviewOptions {
  readonly summary: string;
  readonly problemNotice: string;
  readonly problemLabel: (problem: ScanProblem) => string;
  readonly scopeNotice?: string;
}

export interface ApplyProblemOptions {
  readonly problemLabel: (problem: ApplyProblem) => string;
  readonly omittedNotice: (count: number) => string;
}

// Never let a filename or host error inject terminal controls, forge another
// preview line, or reorder visible text with bidi/invisible format controls.
const UNSAFE_DISPLAY_CHARACTER =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]|\p{Cf}/u;

function unicodeEscape(character: string): string {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) return "";
  if (codePoint <= 0xffff) {
    return `\\u${codePoint.toString(16).padStart(4, "0")}`;
  }
  const offset = codePoint - 0x10000;
  const high = 0xd800 + (offset >> 10);
  const low = 0xdc00 + (offset & 0x3ff);
  return `\\u${high.toString(16)}\\u${low.toString(16)}`;
}

function escapedControl(character: string): string {
  switch (character) {
    case "\n":
      return "\\n";
    case "\r":
      return "\\r";
    case "\t":
      return "\\t";
    default:
      return unicodeEscape(character);
  }
}

function escapeForDisplay(
  value: string,
  quote: boolean,
  maxLength?: number,
): { readonly text: string; readonly escaped: boolean } {
  let text = "";
  let escaped = false;
  let truncated = false;
  for (const character of value) {
    let visible = character;
    if (UNSAFE_DISPLAY_CHARACTER.test(character)) {
      visible = escapedControl(character);
      escaped = true;
    } else if (quote && (character === "\\" || character === '"')) {
      visible = `\\${character}`;
      escaped = true;
    }
    if (maxLength !== undefined && text.length + visible.length > maxLength) {
      truncated = true;
      break;
    }
    text += visible;
  }
  if (truncated) text += "…";
  return { text, escaped: escaped || truncated };
}

export function formatUiPath(path: string): string {
  const visible = escapeForDisplay(path, true);
  const ambiguousWhitespace = path.length === 0 || path.trim() !== path;
  return visible.escaped || ambiguousWhitespace
    ? `"${visible.text}"`
    : visible.text;
}

/** Render an untrusted host/filesystem detail as one bounded terminal line. */
export function formatUiDetail(detail: unknown): string {
  return escapeForDisplay(String(detail), false, 200).text;
}

export function restoreActionCount(plan: RestorePreview): number {
  return (
    plan.created.length +
    plan.modified.length +
    plan.renamed.length +
    plan.deleted.length
  );
}

function isIgnorePolicyPath(path: string): boolean {
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return portableWorkspacePathKey(basename) === ".gitignore";
}

/** Format the actions that restore would apply, from the target's direction. */
export function formatWorkspaceRestorePreview(
  plan: RestorePreview,
  options: RestorePreviewOptions,
): string {
  interface PreviewAction {
    readonly path: string;
    readonly symbol: string;
    readonly to?: string;
  }
  const actionsFor = (
    paths: readonly string[],
    symbol: string,
  ): PreviewAction[] =>
    [...paths]
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map((path) => ({ path, symbol }));
  const renames: PreviewAction[] = [...plan.renamed]
    .sort((left, right) =>
      left.to < right.to ? -1 : left.to > right.to ? 1 : 0,
    )
    .map(({ from, to }) => ({ path: from, to, symbol: ">" }));
  const actions = [
    ...actionsFor(plan.deleted, "-"),
    ...actionsFor(plan.modified, "~"),
    ...renames,
    ...actionsFor(plan.created, "+"),
  ];
  const lines = options.summary.length === 0 ? [] : [options.summary];

  for (const action of actions) {
    lines.push(
      action.to === undefined
        ? `${action.symbol} ${formatUiPath(action.path)}`
        : `${action.symbol} ${formatUiPath(action.path)} → ${formatUiPath(
            action.to,
          )}`,
    );
  }
  if (plan.problems.length > 0) {
    lines.push(`? ${options.problemNotice}`);
    for (const problem of plan.problems.slice(0, 3)) {
      const label = options.problemLabel(problem);
      lines.push(`? ${label} · ${formatUiPath(problem.path)}`);
    }
  }

  if (
    options.scopeNotice !== undefined &&
    actions.some(
      (action) =>
        isIgnorePolicyPath(action.path) ||
        (action.to !== undefined && isIgnorePolicyPath(action.to)),
    )
  ) {
    lines.push(options.scopeNotice);
  }

  return lines.join("\n");
}

/** Format concrete per-path apply failures without exposing raw controls. */
export function formatApplyProblems(
  problems: readonly ApplyProblem[],
  options: ApplyProblemOptions,
): string {
  const sampleLimit = 3;
  const lines = problems.slice(0, sampleLimit).map((problem) => {
    const detail = formatUiDetail(problem.detail);
    return `• ${formatUiPath(problem.path)} · ${options.problemLabel(
      problem,
    )}${detail.length > 0 ? `: ${detail}` : ""}`;
  });
  const omitted = problems.length - lines.length;
  if (omitted > 0) lines.push(options.omittedNotice(omitted));
  return lines.join("\n");
}
