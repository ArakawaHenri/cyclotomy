type EngineInitializationResult =
  { readonly kind: "ready" } | { readonly kind: "inactive" };

export interface EngineLifecycle<Engine, Initialization> {
  readonly create: (initialization: Initialization) => Engine | Promise<Engine>;
  readonly initialize: (
    engine: Engine,
    initialization: Initialization,
  ) => EngineInitializationResult | Promise<EngineInitializationResult>;
  /** Synchronously revoke authority before waiting for in-flight users. */
  readonly retire: (engine: Engine) => void;
  readonly drain: (engine: Engine) => void | Promise<void>;
  readonly close: (engine: Engine) => void | Promise<void>;
}

interface EngineRecord<Engine> {
  readonly engine: Engine;
  readonly generation: number;
  leases: number;
  drained: Promise<void> | undefined;
  finishDrain: (() => void) | undefined;
}

export interface EngineLease<Engine> {
  readonly engine: Engine;
  readonly generation: number;
  release(): void;
}

export type EngineResumeResult<Engine> =
  | {
      readonly kind: "running";
      readonly engine: Engine;
      readonly generation: number;
    }
  | { readonly kind: "inactive" }
  | { readonly kind: "failed"; readonly cause: unknown }
  | { readonly kind: "superseded" };

function normalizeLifecycleFailure(cause: unknown, operation: string): unknown {
  return (
    cause ??
    new Error(`Cyclotomy engine ${operation} failed without an error value`)
  );
}

/**
 * Own one replaceable Cyclotomy engine behind Pi's permanently registered API.
 *
 * `current | undefined` is the complete participation model. Generations and
 * leases exist only to make stop/resume linearizable: detaching is immediate,
 * while resource teardown waits for handlers that already acquired the engine.
 */
export class CyclotomyEngineController<Engine, Initialization = void> {
  readonly #lifecycle: EngineLifecycle<Engine, Initialization>;
  #current: EngineRecord<Engine> | undefined;
  #stopCause: unknown;
  #epoch = 0;
  #resumeAttempt: Promise<EngineResumeResult<Engine>> | undefined;
  #resumeEpoch: number | undefined;
  #retirement: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(lifecycle: EngineLifecycle<Engine, Initialization>) {
    this.#lifecycle = lifecycle;
  }

  get current(): Engine | undefined {
    return this.#current?.engine;
  }

  get stopCause(): unknown {
    return this.#stopCause;
  }

  get generation(): number | undefined {
    return this.#current?.generation;
  }

  acquire(): EngineLease<Engine> | undefined {
    const record = this.#current;
    if (record === undefined) return undefined;
    record.leases += 1;
    let released = false;
    return {
      engine: record.engine,
      generation: record.generation,
      release: () => {
        if (released) return;
        released = true;
        record.leases -= 1;
        if (record.leases === 0) {
          record.finishDrain?.();
          record.finishDrain = undefined;
        }
      },
    };
  }

  resume(initialization: Initialization): Promise<EngineResumeResult<Engine>> {
    const current = this.#current;
    if (current !== undefined) {
      return Promise.resolve({
        kind: "running",
        engine: current.engine,
        generation: current.generation,
      });
    }
    if (this.#closed) {
      return Promise.resolve({
        kind: "failed",
        cause: new Error("Cyclotomy engine controller is closed"),
      });
    }
    if (
      this.#resumeAttempt !== undefined &&
      this.#resumeEpoch === this.#epoch
    ) {
      return this.#resumeAttempt;
    }

    const predecessor = this.#resumeAttempt;
    const attempt = ++this.#epoch;
    const resume = this.#runResume(
      attempt,
      initialization,
      predecessor,
    ).finally(() => {
      if (this.#resumeAttempt === resume) {
        this.#resumeAttempt = undefined;
        this.#resumeEpoch = undefined;
      }
    });
    this.#resumeAttempt = resume;
    this.#resumeEpoch = attempt;
    return resume;
  }

  async stop(cause?: unknown): Promise<void> {
    const pendingResume = this.#resumeAttempt;
    this.#stopCause = cause;
    this.#epoch += 1;
    const record = this.#detachCurrent();
    const retirement =
      record === undefined ? this.#retirement : this.#retire(record);
    await Promise.all([retirement, pendingResume]);
  }

  async stopIfCurrent(generation: number, cause: unknown): Promise<boolean> {
    if (this.#current?.generation !== generation) return false;
    await this.stop(cause);
    return true;
  }

  async shutdown(): Promise<void> {
    this.#closed = true;
    await this.stop();
  }

  async #runResume(
    attempt: number,
    initialization: Initialization,
    predecessor: Promise<EngineResumeResult<Engine>> | undefined,
  ): Promise<EngineResumeResult<Engine>> {
    await predecessor;
    await this.#retirement;
    if (this.#closed || attempt !== this.#epoch) return { kind: "superseded" };

    let engine: Engine;
    try {
      engine = await this.#lifecycle.create(initialization);
    } catch (cause) {
      if (this.#closed || attempt !== this.#epoch) {
        return { kind: "superseded" };
      }
      const failure = normalizeLifecycleFailure(cause, "creation");
      if (attempt === this.#epoch) this.#stopCause = failure;
      return { kind: "failed", cause: failure };
    }

    if (this.#closed || attempt !== this.#epoch) {
      await this.#disposeCandidate(engine);
      return { kind: "superseded" };
    }

    let initializationResult: EngineInitializationResult;
    try {
      initializationResult = await this.#lifecycle.initialize(
        engine,
        initialization,
      );
    } catch (cause) {
      const cleanup = await this.#disposeCandidate(engine);
      if (this.#closed || attempt !== this.#epoch) {
        return { kind: "superseded" };
      }
      const initializationFailure = normalizeLifecycleFailure(
        cause,
        "initialization",
      );
      const failure =
        cleanup === undefined
          ? initializationFailure
          : new AggregateError(
              [initializationFailure, cleanup.cause],
              "Cyclotomy initialization and cleanup failed",
            );
      if (attempt === this.#epoch) this.#stopCause = failure;
      return { kind: "failed", cause: failure };
    }

    if (initializationResult.kind === "inactive") {
      const cleanup = await this.#disposeCandidate(engine);
      if (this.#closed || attempt !== this.#epoch) {
        return { kind: "superseded" };
      }
      if (cleanup !== undefined) {
        if (attempt === this.#epoch) this.#stopCause = cleanup.cause;
        return { kind: "failed", cause: cleanup.cause };
      }
      this.#stopCause = undefined;
      return { kind: "inactive" };
    }

    if (this.#closed || attempt !== this.#epoch) {
      await this.#disposeCandidate(engine);
      return { kind: "superseded" };
    }
    const record: EngineRecord<Engine> = {
      engine,
      generation: attempt,
      leases: 0,
      drained: undefined,
      finishDrain: undefined,
    };
    this.#current = record;
    this.#stopCause = undefined;
    return { kind: "running", engine, generation: record.generation };
  }

  #detachCurrent(): EngineRecord<Engine> | undefined {
    const record = this.#current;
    if (record === undefined) return undefined;
    this.#current = undefined;
    try {
      this.#lifecycle.retire(record.engine);
    } catch (cause) {
      this.#stopCause = normalizeLifecycleFailure(cause, "retirement");
    }
    return record;
  }

  #retire(record: EngineRecord<Engine>): Promise<void> {
    const cleanup = (async () => {
      if (record.leases > 0) {
        record.drained ??= new Promise<void>((resolve) => {
          record.finishDrain = resolve;
        });
        await record.drained;
      }
      const failures: unknown[] = [];
      try {
        await this.#lifecycle.drain(record.engine);
      } catch (cause) {
        failures.push(normalizeLifecycleFailure(cause, "drain"));
      }
      try {
        await this.#lifecycle.close(record.engine);
      } catch (cause) {
        failures.push(normalizeLifecycleFailure(cause, "close"));
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Cyclotomy engine cleanup failed");
      }
    })();
    // The barrier must never remain rejected and poison every future resume.
    // The caller still observes this retirement's error through `cleanup`.
    this.#retirement = cleanup.catch((cause: unknown) => {
      this.#stopCause = normalizeLifecycleFailure(cause, "cleanup");
    });
    return cleanup;
  }

  async #disposeCandidate(
    engine: Engine,
  ): Promise<{ readonly cause: unknown } | undefined> {
    const failures: unknown[] = [];
    try {
      this.#lifecycle.retire(engine);
    } catch (cause) {
      failures.push(normalizeLifecycleFailure(cause, "retirement"));
    }
    try {
      await this.#lifecycle.drain(engine);
    } catch (cause) {
      failures.push(normalizeLifecycleFailure(cause, "drain"));
    }
    try {
      await this.#lifecycle.close(engine);
    } catch (cause) {
      failures.push(normalizeLifecycleFailure(cause, "close"));
    }
    if (failures.length === 0) return undefined;
    return {
      cause:
        failures.length === 1
          ? failures[0]
          : new AggregateError(failures, "Cyclotomy candidate cleanup failed"),
    };
  }
}
