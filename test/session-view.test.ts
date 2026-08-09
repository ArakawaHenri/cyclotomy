import {
  SessionManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { readSessionView } from "../src/pi/session-view.ts";

function context(manager: SessionManager): ExtensionContext {
  return {
    cwd: manager.getCwd(),
    sessionManager: manager,
  } as unknown as ExtensionContext;
}

describe("session view boundary", () => {
  it("projects the current typed Pi session API", () => {
    const manager = SessionManager.inMemory("/workspace", { id: "s1" });
    const userId = manager.appendMessage({
      role: "user",
      content: "hello",
      timestamp: Date.now(),
    });
    const customId = manager.appendCustomMessageEntry("test", "context", false);
    const stateId = manager.appendThinkingLevelChange("high");
    const view = readSessionView(context(manager));

    expect(view).toMatchObject({
      sessionId: "s1",
      cwd: manager.getCwd(),
      sessionFile: null,
      parentSessionFile: null,
      leafId: stateId,
    });
    expect(view.parentIdOf(userId)).toBeNull();
    expect(view.parentIdOf(customId)).toBe(userId);
    expect(view.navigationLandingId(userId)).toBeNull();
    expect(view.navigationLandingId(customId)).toBe(userId);
    expect(view.navigationLandingId(stateId)).toBe(stateId);
    expect(view.navigationLandingId("missing")).toBeUndefined();
  });
});
