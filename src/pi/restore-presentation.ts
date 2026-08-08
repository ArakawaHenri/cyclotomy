import type { ApplyProblem } from "../infrastructure/apply.ts";
import type { WorkspaceRestorePlan } from "../infrastructure/restore-plan.ts";
import type { ScanProblem } from "../infrastructure/workspace-scan.ts";

type RestorePreview = Pick<
  WorkspaceRestorePlan,
  "created" | "deleted" | "modified" | "problems"
>;

export interface RestorePreviewOptions {
  /** Omit to list every action. */
  readonly sampleLimit?: number;
  readonly summary: string;
  readonly omittedNotice: (count: number) => string;
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

function boundedEscape(
  value: string,
  maxLength: number,
  quote: boolean,
  preserveTail = false,
): { readonly text: string; readonly escaped: boolean } {
  if (preserveTail) {
    const segments: string[] = [];
    let escaped = false;
    let visibleLength = 0;
    for (const character of value) {
      let visible = character;
      if (UNSAFE_DISPLAY_CHARACTER.test(character)) {
        visible = escapedControl(character);
        escaped = true;
      } else if (quote && (character === "\\" || character === '"')) {
        visible = `\\${character}`;
        escaped = true;
      }
      segments.push(visible);
      visibleLength += visible.length;
    }
    if (visibleLength <= maxLength) {
      return { text: segments.join(""), escaped };
    }

    const available = Math.max(0, maxLength - 1);
    const headBudget = Math.floor(available * 0.4);
    const tailBudget = available - headBudget;
    let head = "";
    let headEnd = 0;
    while (
      headEnd < segments.length &&
      head.length + segments[headEnd]!.length <= headBudget
    ) {
      head += segments[headEnd]!;
      headEnd += 1;
    }
    const tail: string[] = [];
    let tailLength = 0;
    let tailStart = segments.length;
    while (
      tailStart > headEnd &&
      tailLength + segments[tailStart - 1]!.length <= tailBudget
    ) {
      tailStart -= 1;
      tail.unshift(segments[tailStart]!);
      tailLength += segments[tailStart]!.length;
    }
    return { text: `${head}…${tail.join("")}`, escaped: true };
  }

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
    if (text.length + visible.length > maxLength) {
      truncated = true;
      break;
    }
    text += visible;
  }
  if (truncated) text += "…";
  return { text, escaped: escaped || truncated };
}

export function formatUiPath(path: string): string {
  const visible = boundedEscape(path, 96, true, true);
  const ambiguousWhitespace = path.length === 0 || path.trim() !== path;
  return visible.escaped || ambiguousWhitespace
    ? `"${visible.text}"`
    : visible.text;
}

/** Render an untrusted host/filesystem detail as one bounded terminal line. */
export function formatUiDetail(detail: unknown): string {
  return boundedEscape(String(detail), 200, false).text;
}

export function restoreActionCount(plan: RestorePreview): number {
  return plan.created.length + plan.modified.length + plan.deleted.length;
}

function isIgnorePolicyPath(path: string): boolean {
  return path === ".gitignore" || path.endsWith("/.gitignore");
}

/** Format the actions that restore would apply, from the target's direction. */
export function formatWorkspaceRestorePreview(
  plan: RestorePreview,
  options: RestorePreviewOptions,
): string {
  const sampleLimit = options.sampleLimit === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(0, Math.floor(options.sampleLimit));
  const actionsFor = (paths: readonly string[], symbol: string) =>
    [...paths]
      .sort((left, right) =>
        left < right ? -1 : left > right ? 1 : 0
      )
      .map((path) => ({ path, symbol }));
  const actions = [
    ...actionsFor(plan.deleted, "-"),
    ...actionsFor(plan.modified, "~"),
    ...actionsFor(plan.created, "+"),
  ];
  const lines = options.summary.length === 0 ? [] : [options.summary];

  for (const action of actions.slice(0, sampleLimit)) {
    lines.push(`${action.symbol} ${formatUiPath(action.path)}`);
  }
  const omitted = actions.length - Math.min(actions.length, sampleLimit);
  if (omitted > 0) {
    lines.push(options.omittedNotice(omitted));
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
    actions.some((action) => isIgnorePolicyPath(action.path))
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
    return `• ${formatUiPath(problem.path)} · ${
      options.problemLabel(problem)
    }${detail.length > 0 ? `: ${detail}` : ""}`;
  });
  const omitted = problems.length - lines.length;
  if (omitted > 0) lines.push(options.omittedNotice(omitted));
  return lines.join("\n");
}
