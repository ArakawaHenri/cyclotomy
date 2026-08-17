import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { WorkspaceRestorePlan } from "../infrastructure/restore-plan.ts";
import type { GitReplayRisk } from "../infrastructure/git-replay-risk.ts";
import type { CyclotomyRuntime } from "./runtime.ts";

export type RestoreChoiceMode = "manual" | "loaded-session";
export type NavigationChoice = "stay" | "detach" | "restore";

function choiceCopy(
  runtime: CyclotomyRuntime,
  mode: RestoreChoiceMode,
): {
  readonly title: string;
  readonly intro: string;
  readonly safe: string;
  readonly restore: string;
} {
  switch (mode) {
    case "manual":
      return {
        title: runtime.i18n.t("choiceManualTitle"),
        intro: runtime.i18n.t("choiceManualIntro"),
        safe: runtime.i18n.t("choiceManualSafe"),
        restore: runtime.i18n.t("choiceManualRestore"),
      };
    case "loaded-session":
      return {
        title: runtime.i18n.t("choiceLoadedTitle"),
        intro: runtime.i18n.t("choiceLoadedIntro"),
        safe: runtime.i18n.t("choiceLoadedSafe"),
        restore: runtime.i18n.t("choiceLoadedRestore"),
      };
  }
}

async function selectChoice(
  context: ExtensionContext,
  prompt: string,
  options: readonly string[],
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  return context.ui.select(
    prompt,
    [...options],
    signal === undefined ? undefined : { signal },
  );
}

/**
 * Show one Pi-native, safe-default restore decision. Escape, unknown RPC
 * values, and the first option always select the mode's safe outcome.
 */
export async function requestRestoreChoice(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  mode: RestoreChoiceMode,
  plan: WorkspaceRestorePlan,
  replayRisk: GitReplayRisk,
  signal?: AbortSignal,
): Promise<boolean> {
  const copy = choiceCopy(runtime, mode);
  const preview = runtime.i18n.formatRestorePreview(plan);
  const risk = runtime.i18n.formatGitReplayRisk(replayRisk);
  const prompt = [[copy.title, copy.intro].join("\n"), risk, preview]
    .filter((part): part is string => part !== undefined && part !== "")
    .join("\n\n");
  const selected = await selectChoice(
    context,
    prompt,
    [copy.safe, copy.restore],
    signal,
  );
  return selected === copy.restore;
}

/**
 * Show the three navigation outcomes. Escape, unknown RPC values, and the
 * first option all fail closed by keeping Pi at the current node.
 */
export async function requestNavigationChoice(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  plan: WorkspaceRestorePlan,
  replayRisk: GitReplayRisk,
  signal?: AbortSignal,
): Promise<NavigationChoice> {
  const title = runtime.i18n.t("choiceNavigationTitle");
  const intro = runtime.i18n.t("choiceNavigationIntro");
  const stay = runtime.i18n.t("choiceNavigationSafe");
  const detach = runtime.i18n.t("choiceNavigationDetach");
  const restore = runtime.i18n.t("choiceNavigationRestore");
  const preview = runtime.i18n.formatRestorePreview(plan);
  const risk = runtime.i18n.formatGitReplayRisk(replayRisk);
  const prompt = [[title, intro].join("\n"), risk, preview]
    .filter((part): part is string => part !== undefined && part !== "")
    .join("\n\n");
  const selected = await selectChoice(
    context,
    prompt,
    [stay, detach, restore],
    signal,
  );
  if (selected === restore) return "restore";
  if (selected === detach) return "detach";
  return "stay";
}
