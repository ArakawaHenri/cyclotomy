import { describe, expect, it, vi } from "vitest";

import { protectCurrentArrivalInWorkspaceLock } from "../src/pi/post-mutation.ts";
import type { CyclotomyRuntime } from "../src/pi/runtime.ts";
import { FakeSessionManager } from "./fake-pi.ts";

describe("post-mutation arrival protection", () => {
  it("persists pending protection when the arrival has no stable node", async () => {
    const manager = new FakeSessionManager(
      "s",
      "/sessions/s.jsonl",
      "/workspace",
    );
    const quarantineAdmission = vi.fn();
    const setPendingNodeGuard = vi.fn(() => true);
    const runtime = {
      quarantineAdmission,
      sessionIsUsable: () => true,
      workspaceStillBound: async () => true,
      captureAnchor: () => undefined,
      setPendingNodeGuard,
    } as unknown as CyclotomyRuntime;

    const result = await protectCurrentArrivalInWorkspaceLock(runtime, {
      sessionManager: manager,
    } as never);

    expect(result).toEqual({ kind: "pending-node-guard" });
    expect(quarantineAdmission).toHaveBeenCalledOnce();
    expect(setPendingNodeGuard).toHaveBeenCalledOnce();
  });

  it("persists pending protection when the stable node is temporarily unresolvable", async () => {
    const manager = new FakeSessionManager(
      "s",
      "/sessions/s.jsonl",
      "/workspace",
    );
    manager.appendEntry();
    const setPendingNodeGuard = vi.fn(() => true);
    const runtime = {
      quarantineAdmission: vi.fn(),
      sessionIsUsable: () => true,
      workspaceStillBound: async () => true,
      captureAnchor: () => {
        throw new Error("tearing session tree");
      },
      setPendingNodeGuard,
    } as unknown as CyclotomyRuntime;

    const result = await protectCurrentArrivalInWorkspaceLock(runtime, {
      sessionManager: manager,
    } as never);

    expect(result).toEqual({ kind: "pending-node-guard" });
    expect(setPendingNodeGuard).toHaveBeenCalledOnce();
  });
});
