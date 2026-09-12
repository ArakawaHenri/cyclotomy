import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { notifyArrivalRecovery } from "./restore-notifications.ts";
import type { CyclotomyRuntime } from "./runtime.ts";
import { messageOfUnknown as messageOf } from "./unknown-error.ts";

/** Retire checkpoint authority after an established store binding fails. */
export async function withdrawAfterStoreBindingFailure(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
): Promise<void> {
  const activation = runtime.activation;
  const cause =
    activation.kind === "unavailable"
      ? activation.cause
      : new Error("workspace storage binding is unavailable");
  const recovery = await runtime.withdrawFromParticipation(context, cause);
  runtime.notify(
    context,
    `${runtime.i18n.t("sourceCaptureStopped")} ${runtime.i18n.t(
      "captureFailureDetail",
      { message: messageOf(cause) },
    )}`,
    "error",
  );
  notifyArrivalRecovery(runtime, context, recovery, new Set([cause]));
}
