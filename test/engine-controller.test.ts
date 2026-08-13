import { describe, expect, it, vi } from "vitest";

import { CyclotomyEngineController } from "../src/pi/engine-controller.ts";

interface Engine {
  readonly id: number;
}

describe("CyclotomyEngineController", () => {
  it("detaches synchronously and drains acquired work before close", async () => {
    let nextId = 0;
    const calls: string[] = [];
    const controller = new CyclotomyEngineController<Engine>({
      create: () => ({ id: ++nextId }),
      initialize: () => {},
      retire: ({ id }) => {
        calls.push(`retire:${id}`);
      },
      drain: ({ id }) => {
        calls.push(`drain:${id}`);
      },
      close: ({ id }) => {
        calls.push(`close:${id}`);
      },
    });
    await expect(controller.resume(undefined)).resolves.toMatchObject({
      kind: "running",
    });
    const lease = controller.acquire();
    expect(lease).toBeDefined();

    const stopped = controller.stop("user");
    expect(controller.current).toBeUndefined();
    expect(controller.acquire()).toBeUndefined();
    expect(calls).toEqual(["retire:1"]);
    lease?.release();
    await stopped;
    expect(calls).toEqual(["retire:1", "drain:1", "close:1"]);
  });

  it("publishes only an initialized candidate and closes failures", async () => {
    let fail = true;
    let nextId = 0;
    const close = vi.fn();
    const controller = new CyclotomyEngineController<Engine>({
      create: () => ({ id: ++nextId }),
      initialize: () => {
        if (fail) throw new Error("not ready");
      },
      retire: () => {},
      drain: () => {},
      close,
    });
    await expect(controller.resume(undefined)).resolves.toMatchObject({
      kind: "failed",
    });
    expect(controller.current).toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);

    fail = false;
    await expect(controller.resume(undefined)).resolves.toMatchObject({
      kind: "running",
      engine: { id: 2 },
    });
  });

  it("prevents a superseded candidate and stale generation from winning", async () => {
    let finish!: () => void;
    const initialization = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const close = vi.fn();
    const create = vi.fn(() => ({ id: 1 }));
    const controller = new CyclotomyEngineController<Engine>({
      create,
      initialize: () => initialization,
      retire: () => {},
      drain: () => {},
      close,
    });
    const starting = controller.resume(undefined);
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    const stopping = controller.stop("user");
    let stopSettled = false;
    void stopping.then(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    expect(stopSettled).toBe(false);
    finish();
    await expect(starting).resolves.toEqual({ kind: "superseded" });
    await stopping;
    expect(controller.current).toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
    await expect(controller.stopIfCurrent(1, new Error("late"))).resolves.toBe(
      false,
    );
    expect(controller.stopCause).toBe("user");
  });

  it("serializes a new resume behind cleanup of a superseded candidate", async () => {
    let finishFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    let nextId = 0;
    const close = vi.fn();
    const controller = new CyclotomyEngineController<Engine>({
      create: () => ({ id: ++nextId }),
      initialize: ({ id }) => (id === 1 ? firstGate : undefined),
      retire: () => {},
      drain: () => {},
      close,
    });

    const first = controller.resume(undefined);
    await vi.waitFor(() => expect(nextId).toBe(1));
    const stopped = controller.stop("user");
    const second = controller.resume(undefined);
    await Promise.resolve();
    expect(nextId).toBe(1);

    finishFirst();
    await expect(first).resolves.toEqual({ kind: "superseded" });
    await stopped;
    await expect(second).resolves.toMatchObject({
      kind: "running",
      engine: { id: 2 },
    });
    expect(close).toHaveBeenCalledTimes(1);
  });
});
