import type { CaptureFailure } from "../application/capture.ts";
import { assertNever } from "./assert-never.ts";
import type { CyclotomyI18n } from "./i18n.ts";
import { messageOfUnknown } from "./unknown-error.ts";

/** Convert structured capture facts to bounded presentation detail. */
export function formatCaptureFailure(
  i18n: CyclotomyI18n,
  failure: CaptureFailure,
): string {
  switch (failure.kind) {
    case "scan-incomplete":
      return i18n.t(
        failure.phase === "capture"
          ? "captureScanIncomplete"
          : "captureValidationIncomplete",
        { message: i18n.formatScanProblems(failure.problems) },
      );
    case "scan-failed":
      return failure.phase === "validation"
        ? i18n.t("captureValidationFailed", {
            message: messageOfUnknown(failure.cause),
          })
        : messageOfUnknown(failure.cause);
    case "publish-failed":
    case "metadata-failed":
      return messageOfUnknown(failure.cause);
    case "state-changed":
      return i18n.t(
        failure.reason === "checkpoint"
          ? "captureCheckpointChanged"
          : "captureEligibilityChanged",
      );
    case "write-protected":
      return i18n.t("captureWriteProtected");
    case "workspace-changed":
      return i18n.t(
        failure.reason === "root"
          ? "captureRootChanged"
          : "captureContentsChanged",
      );
    default:
      return assertNever(failure, "unhandled capture failure");
  }
}
