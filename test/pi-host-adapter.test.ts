import type {
  ExtensionContext,
  SessionBeforeSwitchEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
  PiHostAdapter,
  type SessionActivation,
} from "../src/pi/pi-host-adapter.ts";

const context = {} as ExtensionContext;
const switchEvent: SessionBeforeSwitchEvent = {
  type: "session_before_switch",
  reason: "new",
};
const startEvent: SessionStartEvent = {
  type: "session_start",
  reason: "startup",
};

describe("PiHostAdapter", () => {
  it("runs an active guard and returns its event-specific result", async () => {
    const active = vi.fn(() => ({ cancel: false }));
    const adapter = new PiHostAdapter({
      activation: () => ({ kind: "active" }),
    });
    const handler = adapter.guard<SessionBeforeSwitchEvent>({
      active,
      pass: { cancel: false },
      block: { cancel: true },
    });

    await expect(handler(switchEvent, context)).resolves.toEqual({
      cancel: false,
    });
    expect(active).toHaveBeenCalledOnce();
  });

  it.each(["intentionally-inactive", "closed"] as const)(
    "passes without invoking protocols when activation is %s",
    async (kind) => {
      const active = vi.fn(() => ({ cancel: true }));
      const adapter = new PiHostAdapter({ activation: () => ({ kind }) });
      const handler = adapter.guard<SessionBeforeSwitchEvent>({
        active,
        pass: { cancel: false },
        block: { cancel: true },
      });

      await expect(handler(switchEvent, context)).resolves.toEqual({
        cancel: false,
      });
      expect(active).not.toHaveBeenCalled();
    },
  );

  it("returns the explicit veto and reports unavailable activation", async () => {
    const unavailable = new Error("registration unavailable");
    const reportFailure = vi.fn();
    const adapter = new PiHostAdapter({
      activation: () => ({ kind: "unavailable", cause: unavailable }),
      reportFailure,
    });
    const handler = adapter.guard<SessionBeforeSwitchEvent>({
      active: () => ({ cancel: false }),
      pass: { cancel: false },
      block: { cancel: true },
    });

    await expect(handler(switchEvent, context)).resolves.toEqual({
      cancel: true,
    });
    expect(reportFailure).toHaveBeenCalledWith(
      { stage: "activation", event: switchEvent, cause: unavailable },
      context,
    );
  });

  it("contains activation, handler, and reporter failures", async () => {
    const reportFailure = vi.fn(() => {
      throw new Error("reporter failed");
    });
    let activation: () => SessionActivation = () => {
      throw new Error("activation failed");
    };
    const adapter = new PiHostAdapter({
      activation: () => activation(),
      reportFailure,
    });
    const handler = adapter.guard<SessionBeforeSwitchEvent>({
      active: () => {
        throw new Error("handler failed");
      },
      pass: { cancel: false },
      block: { cancel: true },
    });

    await expect(handler(switchEvent, context)).resolves.toEqual({
      cancel: true,
    });
    activation = () => ({ kind: "active" });
    await expect(handler(switchEvent, context)).resolves.toEqual({
      cancel: true,
    });
    expect(reportFailure).toHaveBeenCalledTimes(2);
  });

  it("makes observers total without manufacturing host cancellation", async () => {
    const cause = new Error("observer failed");
    const reportFailure = vi.fn();
    const adapter = new PiHostAdapter({
      activation: () => ({ kind: "active" }),
      reportFailure,
    });
    const observer = adapter.observe<SessionStartEvent>(() => {
      throw cause;
    });

    await expect(observer(startEvent, context)).resolves.toBeUndefined();
    expect(reportFailure).toHaveBeenCalledWith(
      { stage: "handler", event: startEvent, cause },
      context,
    );
  });
});
