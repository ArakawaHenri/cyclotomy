import type {
  ExtensionContext,
  ExtensionEvent,
  InputEvent,
  InputEventResult,
  SessionBeforeCompactEvent,
  SessionBeforeForkEvent,
  SessionBeforeSwitchEvent,
  SessionBeforeTreeEvent,
  ToolCallEvent,
  ToolCallEventResult,
  UserBashEvent,
  UserBashEventResult,
} from "@earendil-works/pi-coding-agent";

/** Runtime availability as observed at one Pi event boundary. */
export type SessionActivation =
  | { readonly kind: "active" }
  | { readonly kind: "intentionally-inactive" }
  | { readonly kind: "unavailable"; readonly cause: unknown }
  | { readonly kind: "closed" };

export type GuardedPiEvent =
  | SessionBeforeSwitchEvent
  | SessionBeforeForkEvent
  | SessionBeforeCompactEvent
  | SessionBeforeTreeEvent
  | ToolCallEvent
  | UserBashEvent
  | InputEvent;

export type GuardedPiEventResult<Event extends GuardedPiEvent> =
  Event extends SessionBeforeSwitchEvent
    ? { readonly cancel?: boolean } | undefined
    : Event extends SessionBeforeForkEvent
      ? { readonly cancel?: boolean } | undefined
      : Event extends SessionBeforeCompactEvent
        ? { readonly cancel?: boolean } | undefined
        : Event extends SessionBeforeTreeEvent
          ? { readonly cancel?: boolean } | undefined
          : Event extends ToolCallEvent
            ? ToolCallEventResult | undefined
            : Event extends UserBashEvent
              ? UserBashEventResult | undefined
              : Event extends InputEvent
                ? InputEventResult
                : never;

export interface PiHostFailure<Event extends ExtensionEvent = ExtensionEvent> {
  readonly stage: "activation" | "handler";
  readonly event: Event;
  readonly cause: unknown;
}

export interface PiHostAdapterOptions {
  readonly activation: () => SessionActivation;
  readonly reportFailure?: (
    failure: PiHostFailure,
    context: ExtensionContext,
  ) => void | Promise<void>;
}

export interface GuardedHandlerOptions<Event extends GuardedPiEvent> {
  /** Invoked only while session authority is active; it must choose a result. */
  readonly active: (
    event: Event,
    context: ExtensionContext,
  ) => GuardedPiEventResult<Event> | Promise<GuardedPiEventResult<Event>>;
  /** Ordinary Pi behavior when this extension is intentionally absent/closed. */
  readonly pass: GuardedPiEventResult<Event>;
  /** Explicit veto/replacement when safety authority cannot make a decision. */
  readonly block: GuardedPiEventResult<Event>;
}

export type TotalGuardedHandler<Event extends GuardedPiEvent> = (
  event: Event,
  context: ExtensionContext,
) => Promise<GuardedPiEventResult<Event>>;

export type TotalObserver<Event extends ExtensionEvent> = (
  event: Event,
  context: ExtensionContext,
) => Promise<void>;

/**
 * The narrow exception/activation boundary between Pi and the protocols.
 *
 * Pi may log and discard a thrown handler error. Guarded handlers therefore
 * always return an event-valid result, while observers become total no-ops.
 * This adapter does not present UI, abort turns, or classify protocol results.
 */
export class PiHostAdapter {
  readonly #options: PiHostAdapterOptions;

  constructor(options: PiHostAdapterOptions) {
    this.#options = options;
  }

  guard<Event extends GuardedPiEvent>(
    options: GuardedHandlerOptions<Event>,
  ): TotalGuardedHandler<Event> {
    return async (event, context) => {
      let activation: SessionActivation;
      try {
        activation = this.#options.activation();
      } catch (cause) {
        await this.#report({ stage: "activation", event, cause }, context);
        return options.block;
      }
      switch (activation.kind) {
        case "intentionally-inactive":
        case "closed":
          return options.pass;
        case "unavailable":
          await this.#report(
            { stage: "activation", event, cause: activation.cause },
            context,
          );
          return options.block;
        case "active":
          try {
            return await options.active(event, context);
          } catch (cause) {
            await this.#report({ stage: "handler", event, cause }, context);
            return options.block;
          }
      }
    };
  }

  observe<Event extends ExtensionEvent>(
    active: (event: Event, context: ExtensionContext) => void | Promise<void>,
  ): TotalObserver<Event> {
    return async (event, context) => {
      let activation: SessionActivation;
      try {
        activation = this.#options.activation();
      } catch (cause) {
        await this.#report({ stage: "activation", event, cause }, context);
        return;
      }
      if (activation.kind === "unavailable") {
        await this.#report(
          { stage: "activation", event, cause: activation.cause },
          context,
        );
        return;
      }
      if (activation.kind !== "active") return;
      try {
        await active(event, context);
      } catch (cause) {
        await this.#report({ stage: "handler", event, cause }, context);
      }
    };
  }

  async #report(
    failure: PiHostFailure,
    context: ExtensionContext,
  ): Promise<void> {
    try {
      await this.#options.reportFailure?.(failure, context);
    } catch {
      // Reporting is diagnostic only and must not reopen Pi's exception hole.
    }
  }
}
