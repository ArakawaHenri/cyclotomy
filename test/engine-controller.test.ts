import { describe, expect, it, vi } from "vitest";

import { CyclotomyEngineController } from "../src/pi/engine-controller.ts";

interface Engine {
  readonly id: number;
}

const ready = { kind: "ready" } as const;

describe("CyclotomyEngineController", () => {
  it("detaches synchronously and drains acquired work before close", async () => {
    let nextId = 0;
    const calls: string[] = [];
    const controller = new CyclotomyEngineController<Engine>({
      create: () => ({ id: ++nextId }),
      initialize: () => ready,
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
        return ready;
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
    let finish!: (result: typeof ready) => void;
    const initialization = new Promise<typeof ready>((resolve) => {
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
    finish(ready);
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
    let finishFirst!: (result: typeof ready) => void;
    const firstGate = new Promise<typeof ready>((resolve) => {
      finishFirst = resolve;
    });
    let nextId = 0;
    const close = vi.fn();
    const controller = new CyclotomyEngineController<Engine>({
      create: () => ({ id: ++nextId }),
      initialize: ({ id }) => (id === 1 ? firstGate : ready),
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

    finishFirst(ready);
    await expect(first).resolves.toEqual({ kind: "superseded" });
    await stopped;
    await expect(second).resolves.toMatchObject({
      kind: "running",
      engine: { id: 2 },
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("disposes an intentionally inactive candidate without recording a failure", async () => {
    const retire = vi.fn();
    const drain = vi.fn();
    const close = vi.fn();
    const controller = new CyclotomyEngineController<Engine>({
      create: () => ({ id: 1 }),
      initialize: () => ({ kind: "inactive" }),
      retire,
      drain,
      close,
    });

    await expect(controller.resume(undefined)).resolves.toEqual({
      kind: "inactive",
    });
    expect(controller.current).toBeUndefined();
    expect(controller.stopCause).toBeUndefined();
    expect(retire).toHaveBeenCalledOnce();
    expect(drain).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("reports failure when an inactive candidate cannot be cleaned up", async () => {
    const controller = new CyclotomyEngineController<Engine>({
      create: () => ({ id: 1 }),
      initialize: () => ({ kind: "inactive" }),
      retire: () => {},
      drain: () => {},
      close: () => {
        throw undefined;
      },
    });

    const result = await controller.resume(undefined);
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.cause).toBeInstanceOf(Error);
    expect((result.cause as Error).message).toContain("close");
    expect(controller.stopCause).toBe(result.cause);
    expect(controller.current).toBeUndefined();
  });

  it.each(["creation", "initialization"] as const)(
    "normalizes a missing %s failure cause",
    async (operation) => {
      const controller = new CyclotomyEngineController<Engine>({
        create: () => {
          if (operation === "creation") throw undefined;
          return { id: 1 };
        },
        initialize: () => {
          if (operation === "initialization") throw undefined;
          return ready;
        },
        retire: () => {},
        drain: () => {},
        close: () => {},
      });

      const result = await controller.resume(undefined);
      expect(result.kind).toBe("failed");
      if (result.kind !== "failed") return;
      expect(result.cause).toBeInstanceOf(Error);
      expect(result.cause).toBe(controller.stopCause);
      expect((result.cause as Error).message).toContain(operation);
    },
  );

  it("normalizes a missing retirement failure cause", async () => {
    const controller = new CyclotomyEngineController<Engine>({
      create: () => ({ id: 1 }),
      initialize: () => ready,
      retire: () => {
        throw undefined;
      },
      drain: () => {},
      close: () => {},
    });
    await controller.resume(undefined);

    await controller.stop();
    expect(controller.stopCause).toBeInstanceOf(Error);
    expect((controller.stopCause as Error).message).toContain("retirement");
  });

  it("normalizes missing drain and close failure causes", async () => {
    const controller = new CyclotomyEngineController<Engine>({
      create: () => ({ id: 1 }),
      initialize: () => ready,
      retire: () => {},
      drain: () => {
        throw undefined;
      },
      close: () => {
        throw undefined;
      },
    });
    await controller.resume(undefined);

    await expect(controller.stop()).rejects.toBeInstanceOf(AggregateError);
    const failure = controller.stopCause;
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(2);
    for (const cause of (failure as AggregateError).errors) {
      expect(cause).toBeInstanceOf(Error);
      expect((cause as Error).message).toMatch(/drain|close/u);
    }
  });
});
