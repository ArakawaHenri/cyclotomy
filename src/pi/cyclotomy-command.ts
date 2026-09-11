import type { CyclotomyI18n } from "../presentation/i18n.ts";
import { messageOfUnknown } from "../presentation/unknown-error.ts";

export type CyclotomyCommandAction =
  "status" | "pause" | "resume" | "enable" | "disable" | "usage";

export interface CyclotomyCommandCompletion {
  readonly value: Exclude<CyclotomyCommandAction, "status" | "usage">;
  readonly label: Exclude<CyclotomyCommandAction, "status" | "usage">;
  readonly description: string;
}

export type CyclotomyParticipationView =
  | { readonly running: true }
  | { readonly running: false }
  | { readonly running: false; readonly cause: unknown };

export interface CyclotomyStatusPresentation {
  readonly message: string;
  readonly level: "info" | "warning";
}

/** Parse the deliberately small `/cyclotomy` command language. */
export function parseCyclotomyCommandArguments(
  argumentsText: string,
): CyclotomyCommandAction {
  switch (argumentsText.trim()) {
    case "":
      return "status";
    case "pause":
      return "pause";
    case "resume":
      return "resume";
    case "enable":
      return "enable";
    case "disable":
      return "disable";
    default:
      return "usage";
  }
}

/** Complete the arguments accepted by `/cyclotomy`. */
export function completeCyclotomyCommandArguments(
  argumentPrefix: string,
  i18n: CyclotomyI18n,
): CyclotomyCommandCompletion[] | null {
  const prefix = argumentPrefix.trim();
  if (/\s/u.test(prefix)) return null;
  const completions: readonly CyclotomyCommandCompletion[] = [
    {
      value: "pause",
      label: "pause",
      description: i18n.t("cyclotomyPauseCompletion"),
    },
    {
      value: "resume",
      label: "resume",
      description: i18n.t("cyclotomyResumeCompletion"),
    },
    {
      value: "enable",
      label: "enable",
      description: i18n.t("cyclotomyEnableCompletion"),
    },
    {
      value: "disable",
      label: "disable",
      description: i18n.t("cyclotomyDisableCompletion"),
    },
  ];
  const matches = completions.filter(({ value }) => value.startsWith(prefix));
  return matches.length === 0 ? null : matches;
}

/** Render the observable participation state without introducing a state machine. */
export function presentCyclotomyStatus(
  view: CyclotomyParticipationView,
  i18n: CyclotomyI18n,
): CyclotomyStatusPresentation {
  if (view.running) {
    return { message: i18n.t("cyclotomyRunning"), level: "info" };
  }
  if (!("cause" in view)) {
    return { message: i18n.t("cyclotomyPaused"), level: "info" };
  }
  return {
    message: i18n.t("cyclotomyStoppedWithError", {
      message: messageOfUnknown(view.cause),
    }),
    level: "warning",
  };
}
