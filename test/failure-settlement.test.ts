import { describe, expect, it } from "vitest";

import {
  aggregateFailures,
  primaryFailure,
  retainCleanupFailure,
  retainFailureCause,
  withRetainedCleanup,
} from "../src/infrastructure/failure-settlement.ts";

describe("failure settlement", () => {
  it("runs mandatory cleanup exactly once on success", async () => {
    let cleanups = 0;
    await expect(
      withRetainedCleanup(
        async () => "result",
        async () => {
          cleanups += 1;
        },
        "action and cleanup failed",
      ),
    ).resolves.toBe("result");
    expect(cleanups).toBe(1);
  });

  it("surfaces a lone cleanup failure without retrying cleanup", async () => {
    const cleanupFailure = new Error("cleanup failed");
    let cleanups = 0;
    await expect(
      withRetainedCleanup(
        async () => "unused",
        async () => {
          cleanups += 1;
          throw cleanupFailure;
        },
        "action and cleanup failed",
      ),
    ).rejects.toBe(cleanupFailure);
    expect(cleanups).toBe(1);
  });

  it("retains action before cleanup failure and flattens nested aggregates", async () => {
    const primary = new Error("primary");
    const firstCleanup = new Error("first cleanup");
    const secondCleanup = new Error("second cleanup");
    let cleanups = 0;

    const nested = await retainCleanupFailure(
      primary,
      async () => {
        throw firstCleanup;
      },
      "first settlement failed",
    );
    const settled = await retainCleanupFailure(
      nested,
      async () => {
        cleanups += 1;
        throw secondCleanup;
      },
      "second settlement failed",
    );

    expect(settled).toBeInstanceOf(AggregateError);
    expect((settled as AggregateError).errors).toEqual([
      primary,
      firstCleanup,
      secondCleanup,
    ]);
    expect(primaryFailure(settled)).toBe(primary);
    expect(cleanups).toBe(1);
  });

  it("settles a failed action and cleanup once in deterministic order", async () => {
    const actionFailure = new Error("action failed");
    const cleanupFailure = new Error("cleanup failed");
    let cleanups = 0;

    const failure = await withRetainedCleanup(
      async () => {
        throw actionFailure;
      },
      async () => {
        cleanups += 1;
        throw cleanupFailure;
      },
      "action and cleanup failed",
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      actionFailure,
      cleanupFailure,
    ]);
    expect(cleanups).toBe(1);
  });

  it("retains a typed primary error while attaching cleanup evidence", () => {
    class TypedFailure extends Error {}
    const originalCause = new Error("original cause");
    const primary = new TypedFailure("primary", { cause: originalCause });
    const cleanup = new Error("cleanup");

    expect(retainFailureCause(primary, cleanup, "both failed")).toBe(primary);
    expect(primary).toBeInstanceOf(TypedFailure);
    expect(primary.cause).toBeInstanceOf(AggregateError);
    expect((primary.cause as AggregateError).errors).toEqual([
      originalCause,
      cleanup,
    ]);
  });

  it("adds cleanup to an aggregate primary without hiding its first error", () => {
    const first = new Error("actionable primary");
    const second = new Error("earlier cleanup");
    const finalCleanup = new Error("final cleanup");
    const retained = retainFailureCause(
      new AggregateError([first, second], "generic wrapper"),
      finalCleanup,
      "another generic wrapper",
    );

    expect(retained).toBeInstanceOf(AggregateError);
    expect((retained as AggregateError).message).toBe("actionable primary");
    expect((retained as AggregateError).errors).toEqual([
      first,
      second,
      finalCleanup,
    ]);
    expect((retained as AggregateError).cause).toBe(first);
  });

  it("falls back without losing failures when an Error rejects decoration", () => {
    const cleanup = new Error("cleanup");
    const frozen = Object.freeze(new Error("frozen primary"));
    const throwingCause = new Error("throwing cause");
    Object.defineProperty(throwingCause, "cause", {
      get: () => {
        throw new Error("cause getter failed");
      },
    });

    for (const primary of [frozen, throwingCause]) {
      const retained = retainFailureCause(primary, cleanup, "both failed");
      expect(retained).toBeInstanceOf(AggregateError);
      expect((retained as AggregateError).errors).toEqual([primary, cleanup]);
      expect((retained as AggregateError).cause).toBe(primary);
    }
  });

  it("keeps empty and cyclic aggregate failures finite", () => {
    const empty = new AggregateError([], "empty");
    const cyclic = new AggregateError([], "cyclic");
    cyclic.errors.push(cyclic);
    const first = new AggregateError([], "first");
    const second = new AggregateError([first], "second");
    first.errors.push(second);
    const aggregate = aggregateFailures([empty, cyclic], "combined");

    expect(aggregate.errors).toEqual([empty, cyclic]);
    expect(primaryFailure(first)).toBe(first);
  });
});
