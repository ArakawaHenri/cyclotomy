import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { WorkspaceRestorePlan } from "../infrastructure/restore-plan.ts";
import type { CyclotomyRuntime } from "./runtime.ts";

export type RestoreChoiceMode = "manual" | "loaded-session" | "navigation";

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
    case "navigation":
      return {
        title: runtime.i18n.t("choiceNavigationTitle"),
        intro: runtime.i18n.t("choiceNavigationIntro"),
        safe: runtime.i18n.t("choiceNavigationSafe"),
        restore: runtime.i18n.t("choiceNavigationRestore"),
      };
  }
}

/**
 * Show one Pi-native, safe-default restore decision. Only the exact destructive
 * option proceeds; Escape, unknown RPC values, and the first option all keep
 * files unchanged.
 */
export async function requestRestoreChoice(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  mode: RestoreChoiceMode,
  plan: WorkspaceRestorePlan,
  signal?: AbortSignal,
): Promise<boolean> {
  const copy = choiceCopy(runtime, mode);
  const preview = runtime.i18n.formatRestorePreview(plan);
  const prompt = [copy.title, copy.intro, "", preview].join("\n");
  const selected = await context.ui.select(
    prompt,
    [copy.safe, copy.restore],
    signal === undefined ? undefined : { signal },
  );
  return selected === copy.restore;
}
