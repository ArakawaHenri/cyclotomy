import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { NodeKey } from "../domain/model.ts";
import type { CyclotomyRuntime } from "./runtime.ts";
import {
  isExactUsableSessionView,
  type SessionView,
  type SessionViewTracker,
} from "./session-view.ts";

/** Reobserve the navigation location and accept only the exact usable view. */
export function revalidateNavigationLocation(
  runtime: CyclotomyRuntime,
  views: SessionViewTracker,
  context: ExtensionContext,
  expected: SessionView,
): SessionView | undefined {
  const current = views.revalidate(context);
  return isExactUsableSessionView(current, expected, (candidate) =>
    runtime.registrations.sessionIsUsable(candidate),
  )
    ? current
    : undefined;
}

export function sameNavigationNode(
  left: NodeKey | undefined,
  right: NodeKey | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.sessionId === right.sessionId &&
    left.entryId === right.entryId
  );
}
