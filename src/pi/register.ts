import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ExtensionEvent,
  type InputEventResult,
  type SessionStartEvent,
  type UserBashEventResult,
} from "@earendil-works/pi-coding-agent";

import { defaultCyclotomyConfig, loadCyclotomyConfig } from "../config.ts";
import {
  completeCyclotomyCommandArguments,
  parseCyclotomyCommandArguments,
  presentCyclotomyStatus,
} from "./cyclotomy-command.ts";
import {
  createDriftCommandHandler,
  createRestoreCommandHandler,
} from "./commands.ts";
import {
  CyclotomyEngine,
  type CyclotomyLifecycleEventType,
} from "./cyclotomy-engine.ts";
import { CyclotomyEngineController } from "./engine-controller.ts";
import { createCyclotomyI18n, type CyclotomyI18n } from "./i18n.ts";
import {
  notifyArrivalProtectionFailure,
  notifyWorkspaceLockCleanupFailure,
} from "./restore-outcome.ts";
import { messageOfUnknown } from "./unknown-error.ts";

type CyclotomyRuntimeEvent = Exclude<
  Extract<ExtensionEvent, { readonly type: CyclotomyLifecycleEventType }>,
  SessionStartEvent
>;

interface EngineInitialization {
  readonly event: SessionStartEvent;
  readonly context: ExtensionContext;
  readonly waitForIdle?: () => Promise<void>;
}

function startupI18n(agentDir: string): CyclotomyI18n {
  try {
    return createCyclotomyI18n(loadCyclotomyConfig(agentDir).locale);
  } catch {
    return createCyclotomyI18n(defaultCyclotomyConfig(agentDir).locale);
  }
}

function notify(
  context: ExtensionContext,
  message: string,
  level: "info" | "warning" | "error" = "info",
): void {
  try {
    if (context.hasUI) context.ui.notify(message, level);
    else console.error(`[Cyclotomy:${level}] ${message}`);
  } catch {
    // A stale UI must not turn the participation command into a Pi failure.
  }
}

/** Assemble Cyclotomy behind one permanent, pass-through Pi boundary. */
export function registerCyclotomy(pi: ExtensionAPI): void {
  const agentDir = getAgentDir();
  let i18n = startupI18n(agentDir);
  const controller = new CyclotomyEngineController<
    CyclotomyEngine,
    EngineInitialization
  >({
    create: async (initialization) => {
      await initialization.waitForIdle?.();
      const engine = CyclotomyEngine.create(agentDir);
      i18n = engine.runtime.i18n;
      return engine;
    },
    initialize: (engine, initialization) =>
      engine.initialize(initialization.event, initialization.context),
    retire: (engine) => engine.retire(),
    drain: (engine) => engine.drain(),
    close: (engine) => engine.close(),
  });

  const stoppedView = () => {
    const cause = controller.stopCause;
    return cause === undefined
      ? ({ running: false } as const)
      : ({ running: false, cause } as const);
  };

  const showStatus = (context: ExtensionContext): void => {
    const engine = controller.current;
    const activation = engine?.runtime.activation;
    const presentation = presentCyclotomyStatus(
      activation?.kind === "active"
        ? { running: true }
        : activation?.kind === "unavailable"
          ? { running: false, cause: activation.cause }
          : stoppedView(),
      i18n,
    );
    notify(context, presentation.message, presentation.level);
  };

  async function settleBeforeRetirement(
    engine: CyclotomyEngine,
    context: ExtensionContext,
  ): Promise<void> {
    const recovery =
      await engine.runtime.workspaceMutations.protectCurrentLocationForRetirement(
        context,
      );
    notifyArrivalProtectionFailure(
      engine.runtime,
      context,
      recovery.protection,
    );
    notifyWorkspaceLockCleanupFailure(
      engine.runtime,
      context,
      recovery.workspaceLockCleanup,
    );
  }

  async function stopGeneration(
    generation: number,
    cause: unknown,
  ): Promise<void> {
    try {
      await controller.stopIfCurrent(generation, cause);
    } catch {
      // Runtime shutdown is total in normal operation. Cleanup failure cannot
      // be allowed to escape back into Pi's extension runner.
    }
  }

  async function dispatch<Result>(
    event: CyclotomyRuntimeEvent,
    context: ExtensionContext,
    pass: Result,
  ): Promise<Result> {
    const lease = controller.acquire();
    if (lease === undefined) return pass;
    if (!lease.engine.runtime.isActive) {
      const activation = lease.engine.runtime.activation;
      const cause =
        activation.kind === "unavailable"
          ? activation.cause
          : new Error("Cyclotomy stopped participating");
      const retirement = stopGeneration(lease.generation, cause);
      lease.release();
      await retirement;
      return pass;
    }
    let result: unknown;
    let failure: unknown;
    let failed = false;
    try {
      result = await lease.engine.dispatch(event, context);
    } catch (cause) {
      failed = true;
      failure =
        cause ?? new Error("Cyclotomy handler failed without an error value");
      const recovery = await lease.engine.runtime.withdrawFromParticipation(
        context,
        failure,
      );
      notifyArrivalProtectionFailure(
        lease.engine.runtime,
        context,
        recovery.protection,
      );
      notifyWorkspaceLockCleanupFailure(
        lease.engine.runtime,
        context,
        recovery.workspaceLockCleanup,
      );
    }

    const activation = lease.engine.runtime.activation;
    const generationIsCurrent = controller.generation === lease.generation;
    if (!generationIsCurrent || failed || activation.kind !== "active") {
      const cause =
        failure ??
        (activation.kind === "unavailable"
          ? activation.cause
          : new Error("Cyclotomy stopped participating"));
      if (generationIsCurrent) {
        const retirement = stopGeneration(lease.generation, cause);
        lease.release();
        await retirement;
      } else {
        lease.release();
      }
      return pass;
    }
    lease.release();
    return result as Result;
  }

  async function runEngineCommand(
    command: "drift" | "restore",
    args: string,
    context: ExtensionCommandContext,
  ): Promise<void> {
    const lease = controller.acquire();
    if (lease === undefined) {
      showStatus(context);
      return;
    }
    if (!lease.engine.runtime.isActive) {
      const activation = lease.engine.runtime.activation;
      const cause =
        activation.kind === "unavailable"
          ? activation.cause
          : new Error("Cyclotomy stopped participating");
      const retirement = stopGeneration(lease.generation, cause);
      lease.release();
      await retirement;
      showStatus(context);
      return;
    }
    let failure: unknown;
    let failed = false;
    try {
      const handler =
        command === "drift"
          ? createDriftCommandHandler(lease.engine.runtime)
          : createRestoreCommandHandler(lease.engine.runtime);
      await handler(args, context);
    } catch (cause) {
      failed = true;
      failure =
        cause ?? new Error("Cyclotomy command failed without an error value");
      const recovery = await lease.engine.runtime.withdrawFromParticipation(
        context,
        failure,
      );
      notifyArrivalProtectionFailure(
        lease.engine.runtime,
        context,
        recovery.protection,
      );
      notifyWorkspaceLockCleanupFailure(
        lease.engine.runtime,
        context,
        recovery.workspaceLockCleanup,
      );
    }
    const activation = lease.engine.runtime.activation;
    const generationIsCurrent = controller.generation === lease.generation;
    if (generationIsCurrent && (failed || activation.kind !== "active")) {
      const cause =
        failure ??
        (activation.kind === "unavailable"
          ? activation.cause
          : new Error("Cyclotomy stopped participating"));
      const retirement = stopGeneration(lease.generation, cause);
      lease.release();
      await retirement;
      return;
    }
    lease.release();
  }

  pi.on("session_start", async (event, context) => {
    if (controller.current !== undefined) {
      await controller.stop(
        new Error(
          "Pi delivered more than one session_start to an extension runtime",
        ),
      );
    }
    await controller.resume({ event, context });
  });
  pi.on("context", (event, context) =>
    dispatch<undefined>(event, context, undefined),
  );
  pi.on("turn_end", (event, context) =>
    dispatch<undefined>(event, context, undefined),
  );
  pi.on("input", (event, context) =>
    dispatch<InputEventResult>(event, context, { action: "continue" }),
  );
  pi.on("message_end", (event, context) =>
    dispatch<undefined>(event, context, undefined),
  );
  pi.on("user_bash", (event, context) =>
    dispatch<UserBashEventResult | undefined>(event, context, undefined),
  );
  pi.on("session_before_compact", (event, context) =>
    dispatch<{ readonly cancel?: boolean } | undefined>(
      event,
      context,
      undefined,
    ),
  );
  pi.on("session_compact", (event, context) =>
    dispatch<undefined>(event, context, undefined),
  );
  pi.on("session_before_tree", (event, context) =>
    dispatch<{ readonly cancel?: boolean } | undefined>(
      event,
      context,
      undefined,
    ),
  );
  pi.on("session_tree", (event, context) =>
    dispatch<undefined>(event, context, undefined),
  );
  pi.on("session_before_fork", (event, context) =>
    dispatch<{ readonly cancel?: boolean } | undefined>(
      event,
      context,
      undefined,
    ),
  );
  pi.on("session_before_switch", (event, context) =>
    dispatch<{ readonly cancel?: boolean } | undefined>(
      event,
      context,
      undefined,
    ),
  );
  pi.on("session_shutdown", async () => {
    await controller.shutdown().catch(() => {});
  });

  pi.registerCommand("cyclotomy", {
    description: i18n.t("cyclotomyCommandDescription"),
    getArgumentCompletions: (prefix) =>
      completeCyclotomyCommandArguments(prefix, i18n),
    handler: async (args, context) => {
      switch (parseCyclotomyCommandArguments(args)) {
        case "status":
          showStatus(context);
          return;
        case "usage":
          notify(context, i18n.t("cyclotomyUsage"));
          return;
        case "stop":
          try {
            const lease = controller.acquire();
            if (lease === undefined) {
              await controller.stop();
            } else {
              const stopping = controller.stopIfCurrent(
                lease.generation,
                undefined,
              );
              try {
                await settleBeforeRetirement(lease.engine, context);
              } catch {
                // The user stop is already linearized; failure to improve the
                // durable settlement cannot make Cyclotomy participate again.
              }
              lease.release();
              await stopping.catch(() => {});
            }
            notify(context, i18n.t("cyclotomyStopSucceeded"));
          } catch {
            showStatus(context);
          }
          return;
        case "resume": {
          const current = controller.current;
          if (current?.runtime.isActive === true) {
            showStatus(context);
            return;
          }
          const currentGeneration = controller.generation;
          if (current !== undefined && currentGeneration !== undefined) {
            const activation = current.runtime.activation;
            await controller
              .stopIfCurrent(
                currentGeneration,
                activation.kind === "unavailable"
                  ? activation.cause
                  : new Error("Cyclotomy stopped participating"),
              )
              .catch(() => false);
          }
          let result: Awaited<ReturnType<typeof controller.resume>>;
          try {
            result = await controller.resume({
              event: { type: "session_start", reason: "reload" },
              context,
              waitForIdle: () => context.waitForIdle(),
            });
          } catch (cause) {
            notify(
              context,
              i18n.t("cyclotomyResumeFailed", {
                message: messageOfUnknown(cause),
              }),
              "warning",
            );
            return;
          }
          if (result.kind === "running") {
            notify(context, i18n.t("cyclotomyResumeSucceeded"));
          } else if (result.kind === "failed") {
            notify(
              context,
              i18n.t("cyclotomyResumeFailed", {
                message: messageOfUnknown(result.cause),
              }),
              "warning",
            );
          } else {
            showStatus(context);
          }
          return;
        }
      }
    },
  });
  pi.registerCommand("drift", {
    description: i18n.t("driftCommandDescription"),
    handler: (args, context) => runEngineCommand("drift", args, context),
  });
  pi.registerCommand("restore", {
    description: i18n.t("restoreCommandDescription"),
    handler: (args, context) => runEngineCommand("restore", args, context),
  });
}
