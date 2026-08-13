import type { CyclotomyI18n } from "./i18n.ts";
import { messageOfUnknown } from "./unknown-error.ts";

export type CyclotomyCommandAction = "status" | "stop" | "resume" | "usage";

export interface CyclotomyCommandCompletion {
  readonly value: "stop" | "resume";
  readonly label: "stop" | "resume";
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
    case "stop":
      return "stop";
    case "resume":
      return "resume";
    default:
      return "usage";
  }
}

/** Complete the only two arguments accepted by `/cyclotomy`. */
export function completeCyclotomyCommandArguments(
  argumentPrefix: string,
  i18n: CyclotomyI18n,
): CyclotomyCommandCompletion[] | null {
  const prefix = argumentPrefix.trim();
  if (/\s/u.test(prefix)) return null;
  const completions: readonly CyclotomyCommandCompletion[] = [
    {
      value: "stop",
      label: "stop",
      description: i18n.t("cyclotomyStopCompletion"),
    },
    {
      value: "resume",
      label: "resume",
      description: i18n.t("cyclotomyResumeCompletion"),
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
    return { message: i18n.t("cyclotomyStopped"), level: "info" };
  }
  return {
    message: i18n.t("cyclotomyStoppedWithError", {
      message: messageOfUnknown(view.cause),
    }),
    level: "warning",
  };
}
