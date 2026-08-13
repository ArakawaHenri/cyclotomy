import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionEvent,
  ExtensionHandler,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

import {
  defaultCyclotomyConfig,
  loadCyclotomyConfig,
  type CyclotomyConfig,
} from "../config.ts";
import { createCyclotomyI18n } from "./i18n.ts";
import { registerCyclotomyLifecycle } from "./lifecycle.ts";
import { CyclotomyRuntime } from "./runtime.ts";

export type CyclotomyLifecycleEventType =
  | "session_start"
  | "context"
  | "turn_end"
  | "input"
  | "message_end"
  | "user_bash"
  | "session_before_compact"
  | "session_compact"
  | "session_before_tree"
  | "session_tree"
  | "session_before_fork"
  | "session_before_switch";

const LIFECYCLE_EVENT_TYPES = [
  "session_start",
  "context",
  "turn_end",
  "input",
  "message_end",
  "user_bash",
  "session_before_compact",
  "session_compact",
  "session_before_tree",
  "session_tree",
  "session_before_fork",
  "session_before_switch",
] as const satisfies readonly CyclotomyLifecycleEventType[];
const LIFECYCLE_EVENT_TYPE_SET: ReadonlySet<string> = new Set(
  LIFECYCLE_EVENT_TYPES,
);

type CyclotomyLifecycleEvent = Extract<
  ExtensionEvent,
  { readonly type: CyclotomyLifecycleEventType }
>;
type CyclotomyLifecycleHandler = ExtensionHandler<
  CyclotomyLifecycleEvent,
  unknown
>;

/** The only intentionally dynamic seam: collect Cyclotomy's private handlers. */
class LifecycleHandlerSet {
  readonly #handlers = new Map<
    CyclotomyLifecycleEventType,
    CyclotomyLifecycleHandler
  >();

  readonly api: Pick<ExtensionAPI, "on"> = {
    on: ((
      type: CyclotomyLifecycleEventType,
      handler: CyclotomyLifecycleHandler,
    ) => {
      if (!LIFECYCLE_EVENT_TYPE_SET.has(type)) {
        throw new Error(`Cyclotomy registered unsupported ${type} handler`);
      }
      if (this.#handlers.has(type)) {
        throw new Error(`Cyclotomy registered duplicate ${type} handlers`);
      }
      this.#handlers.set(type, handler);
    }) as Pick<ExtensionAPI, "on">["on"],
  };

  invoke(
    event: CyclotomyLifecycleEvent,
    context: ExtensionContext,
  ): Promise<unknown> {
    const handler = this.#handlers.get(event.type);
    if (handler === undefined) {
      throw new Error(`Cyclotomy did not register a ${event.type} handler`);
    }
    return Promise.resolve(handler(event, context));
  }

  assertComplete(): void {
    for (const type of LIFECYCLE_EVENT_TYPES) {
      if (!this.#handlers.has(type)) {
        throw new Error(`Cyclotomy did not register a ${type} handler`);
      }
    }
  }
}

/** One independently initializable Cyclotomy runtime behind the stable Pi API. */
export class CyclotomyEngine {
  readonly runtime: CyclotomyRuntime;
  readonly #handlers: LifecycleHandlerSet;

  private constructor(
    runtime: CyclotomyRuntime,
    handlers: LifecycleHandlerSet,
  ) {
    this.runtime = runtime;
    this.#handlers = handlers;
  }

  static create(agentDir: string): CyclotomyEngine {
    let config: CyclotomyConfig;
    let registrationFailure: unknown;
    try {
      config = loadCyclotomyConfig(agentDir);
    } catch (cause) {
      config = defaultCyclotomyConfig(agentDir);
      registrationFailure = cause;
    }
    const runtime = new CyclotomyRuntime(
      config,
      createCyclotomyI18n(config.locale),
      registrationFailure,
    );
    const handlers = new LifecycleHandlerSet();
    registerCyclotomyLifecycle(handlers.api, runtime);
    handlers.assertComplete();
    return new CyclotomyEngine(runtime, handlers);
  }

  async initialize(event: SessionStartEvent, context: ExtensionContext) {
    await this.#handlers.invoke(event, context);
    switch (this.runtime.activation.kind) {
      case "active":
        return { kind: "ready" } as const;
      case "unavailable":
        throw this.runtime.activation.cause;
      case "intentionally-inactive":
        return { kind: "inactive" } as const;
      case "closed":
        throw new Error("Cyclotomy runtime closed during initialization");
    }
  }

  dispatch(
    event: Exclude<CyclotomyLifecycleEvent, SessionStartEvent>,
    context: ExtensionContext,
  ): Promise<unknown> {
    return this.#handlers.invoke(event, context);
  }

  retire(): void {
    this.runtime.retire();
  }

  drain(): Promise<void> {
    return this.runtime.drain();
  }

  close(): void {
    this.runtime.close();
  }
}
