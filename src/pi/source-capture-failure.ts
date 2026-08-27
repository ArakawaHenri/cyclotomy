import type { CaptureFailure } from "../application/capture.ts";
import { assertNever } from "./assert-never.ts";
import { formatCaptureFailure } from "./capture-failure.ts";
import type { CyclotomyI18n } from "./i18n.ts";
import { messageOfUnknown as messageOf } from "./unknown-error.ts";

export type SourceCaptureFailure =
  | {
      readonly kind: "location-changed";
      readonly phase: "before" | "during";
    }
  | { readonly kind: "not-admitted"; readonly subject: "source" | "turn" }
  | { readonly kind: "workspace-unavailable" }
  | { readonly kind: "capture"; readonly value: CaptureFailure }
  | { readonly kind: "exception"; readonly cause: unknown };

export type SourceCaptureFailureImpact =
  "cancel-operation" | "withdraw-participation";

export function sourceCaptureFailureImpact(
  failure: SourceCaptureFailure,
): SourceCaptureFailureImpact {
  switch (failure.kind) {
    case "exception":
    case "workspace-unavailable":
      return "withdraw-participation";
    case "location-changed":
    case "not-admitted":
      return "cancel-operation";
    case "capture":
      switch (failure.value.kind) {
        case "scan-incomplete":
        case "scan-failed":
        case "publish-failed":
        case "metadata-failed":
          return "withdraw-participation";
        case "workspace-changed":
          return failure.value.reason === "root"
            ? "withdraw-participation"
            : "cancel-operation";
        case "state-changed":
        case "write-protected":
          return "cancel-operation";
      }
  }
}

export function formatSourceCaptureFailure(
  i18n: CyclotomyI18n,
  failure: SourceCaptureFailure,
): string {
  switch (failure.kind) {
    case "location-changed":
      return failure.phase === "before"
        ? "active location changed before source capture"
        : "active location changed during source capture";
    case "not-admitted":
      return `${failure.subject} location is not admitted for checkpointing`;
    case "workspace-unavailable":
      return "workspace storage binding is no longer available";
    case "capture":
      return formatCaptureFailure(i18n, failure.value);
    case "exception":
      return messageOf(failure.cause);
    default:
      return assertNever(failure, "unhandled source capture failure");
  }
}

export function sourceCaptureFailureCause(
  failure: SourceCaptureFailure,
): unknown | undefined {
  if (failure.kind === "exception") return failure.cause;
  if (
    failure.kind === "capture" &&
    (failure.value.kind === "scan-failed" ||
      failure.value.kind === "publish-failed" ||
      failure.value.kind === "metadata-failed")
  ) {
    return failure.value.cause;
  }
  return undefined;
}
