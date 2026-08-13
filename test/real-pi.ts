import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  ModelRuntime,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionError,
  type InlineExtension,
  SessionManager,
  type AgentSession,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerCyclotomy } from "../src/pi/register.ts";

/**
 * Drive the real Pi Coding Agent instead of a hand-written double.
 *
 * The fake-Pi suite owns adversarial ordering that a real host cannot trigger
 * on demand. This harness answers the complementary question: does Cyclotomy
 * still integrate with the Pi version actually installed? It therefore asserts
 * observable outcomes through Pi's own session tree, command dispatch, and
 * extension UI, and avoids reaching into Pi internals.
 *
 * No network and no credentials: the model is an in-process provider whose
 * `streamSimple` yields a fixed assistant turn.
 */

export interface RealPiNotification {
  readonly message: string;
  readonly level: string | undefined;
}

const PROVIDER_ID = "cyclotomy-test-provider";
const MODEL_ID = "cyclotomy-test-model";

/** Yield one deterministic assistant turn without touching the network. */
type RealPiModelOutcome = "success" | "error" | "aborted";

function fixedAssistantTurn(outcome: RealPiModelOutcome) {
  if (outcome !== "success") {
    const error = {
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: PROVIDER_ID,
      model: MODEL_ID,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: outcome,
      errorMessage:
        outcome === "aborted"
          ? "Cyclotomy real-Pi test aborted the request"
          : "Cyclotomy real-Pi test failed the request",
      timestamp: Date.now(),
    };
    async function* failedStream() {
      yield { type: "error", reason: outcome, error };
    }
    return failedStream();
  }
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: "openai-completions",
    provider: PROVIDER_ID,
    modelId: MODEL_ID,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { total: 0 },
    },
    stopReason: "stop",
  };
  async function* stream() {
    yield { type: "start", partial: { role: "assistant", content: [] } };
    yield { type: "text_start", contentIndex: 0, partial: {} };
    yield { type: "text_delta", contentIndex: 0, delta: "ok", partial: {} };
    yield { type: "text_end", contentIndex: 0, partial: {} };
    yield { type: "done", reason: "stop", message };
  }
  return stream();
}

export class RealPiHarness {
  readonly notifications: RealPiNotification[] = [];
  readonly extensionErrors: ExtensionError[] = [];
  readonly statuses = new Map<string, string>();
  /** Index of the option the extension UI selects; 0 is Pi's safe default. */
  selectIndex = 0;
  readonly selections: { prompt: string; options: readonly string[] }[] = [];
  /** Outcome returned by the in-process model on its next calls. */
  modelOutcome: RealPiModelOutcome = "success";

  #runtime: AgentSessionRuntime | undefined;
  #createRuntime: CreateAgentSessionRuntimeFactory | undefined;
  #agentDir: string | undefined;
  #workspace: string | undefined;
  readonly #workspaceRoots: string[] = [];
  #storeRoot: string | undefined;
  #initialUserEntryId: string | undefined;
  #previousAgentDirEnv: string | undefined;
  #agentDirEnvWasSet = false;
  #commandNames: readonly string[] | undefined;

  get session(): AgentSession {
    if (this.#runtime === undefined) throw new Error("harness is not started");
    return this.#runtime.session;
  }

  /** Command names Pi actually registered from Cyclotomy's inline extension. */
  get registeredCommandNames(): readonly string[] {
    if (this.#commandNames === undefined) {
      throw new Error("harness is not started");
    }
    return this.#commandNames;
  }

  get sessionManager(): SessionManager {
    return this.session.sessionManager;
  }

  /** Root user entry seeded before Pi creates its AgentSession, when requested. */
  get initialUserEntryId(): string {
    if (this.#initialUserEntryId === undefined) {
      throw new Error("harness was not started with an initial user message");
    }
    return this.#initialUserEntryId;
  }

  get workspace(): string {
    if (this.#workspace === undefined) {
      throw new Error("harness is not started");
    }
    return this.#workspace;
  }

  get agentDir(): string {
    if (this.#agentDir === undefined) {
      throw new Error("harness is not started");
    }
    return this.#agentDir;
  }

  /** Cyclotomy's hashed store for this workspace. */
  get storeRoot(): string {
    if (this.#storeRoot === undefined) {
      throw new Error("harness is not started");
    }
    return this.#storeRoot;
  }

  get sessionId(): string {
    return this.sessionManager.getSessionId();
  }

  get leafId(): string {
    const leaf = this.sessionManager.getLeafId();
    if (leaf === null || leaf === undefined) {
      throw new Error("real Pi session has no leaf entry");
    }
    return leaf;
  }

  #uiContext(): ExtensionUIContext {
    const harness = this;
    return {
      async select(title: string, options: string[]) {
        harness.selections.push({ prompt: title, options: [...options] });
        return options[harness.selectIndex];
      },
      async confirm() {
        return false;
      },
      async input() {
        return undefined;
      },
      notify(message: string, level?: string) {
        harness.notifications.push({ message, level });
      },
      onTerminalInput() {
        return () => {};
      },
      setStatus(key: string, text: string | undefined) {
        if (text === undefined) harness.statuses.delete(key);
        else harness.statuses.set(key, text);
      },
      setWorkingMessage() {},
      setWorkingVisible() {},
      setWorkingIndicator() {},
      setHiddenThinkingLabel() {},
      setWidget() {},
      setFooter() {},
      setTitle() {},
      setEditorText() {},
    } as unknown as ExtensionUIContext;
  }

  async #bindSession(session: AgentSession): Promise<void> {
    await session.bindExtensions({
      uiContext: this.#uiContext(),
      mode: "tui",
      onError: (error) => {
        this.extensionErrors.push({ ...error });
      },
    });
  }

  /**
   * Create the agent directory, workspace, and a real persisted Pi session with
   * Cyclotomy loaded as an inline extension.
   */
  async start(
    options: {
      readonly settings?: unknown;
      /** Seed Pi with a root user entry without causing an assistant turn. */
      readonly initialUserMessage?: string;
      /** Omit Cyclotomy only for tests that isolate Pi's host contract. */
      readonly includeCyclotomy?: boolean;
      /** Inline extensions loaded before Cyclotomy in Pi's real runner. */
      readonly beforeCyclotomy?: readonly InlineExtension[];
      /** Inline extensions loaded after Cyclotomy in Pi's real runner. */
      readonly afterCyclotomy?: readonly InlineExtension[];
    } = {},
  ): Promise<void> {
    const agentDir = await mkdtemp(join(tmpdir(), "cyclotomy-realpi-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "cyclotomy-realpi-ws-"));
    this.#agentDir = agentDir;
    this.#workspace = workspace;
    this.#workspaceRoots.push(workspace);
    // registerCyclotomy resolves its own configuration through Pi's
    // getAgentDir(), which reads this variable on every call. Without it the
    // suite would bind the developer's real ~/.pi/agent store.
    this.#agentDirEnvWasSet = Object.hasOwn(process.env, "PI_CODING_AGENT_DIR");
    this.#previousAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    // Host retries would make deterministic provider failures take several
    // seconds and obscure the event-order contract under test.
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ retry: { enabled: false } }),
    );
    await mkdir(join(agentDir, "cyclotomy"));
    await writeFile(
      join(agentDir, "cyclotomy", "settings.json"),
      JSON.stringify(
        options.settings ?? { locale: "en", gc: { intervalMs: 0 } },
      ),
    );
    this.#storeRoot = join(
      agentDir,
      "cyclotomy",
      createHash("sha256")
        .update(await realpath(workspace))
        .digest("hex"),
    );

    // Pin every credential and catalog path into the temporary agent
    // directory, and forbid network access, so the suite can never read the
    // developer's real auth.json or reach a model catalog.
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(agentDir, "models-store.json"),
      allowModelNetwork: false,
    });
    modelRuntime.registerProvider(PROVIDER_ID, {
      name: "Cyclotomy Test Provider",
      apiKey: "unused-by-streamSimple",
      api: "openai-completions",
      authHeader: false,
      // Required even with streamSimple, but never contacted.
      baseUrl: "http://127.0.0.1:1/v1",
      streamSimple: () => fixedAssistantTurn(this.modelOutcome) as never,
      models: [
        {
          id: MODEL_ID,
          name: "Cyclotomy Test Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100_000,
          maxTokens: 4096,
        },
      ],
    });
    const model = modelRuntime.getModel(PROVIDER_ID, MODEL_ID);
    if (model === undefined) {
      throw new Error("the in-process test model was not registered");
    }

    const initialSessionManager = SessionManager.create(
      workspace,
      join(agentDir, "sessions"),
    );
    if (options.initialUserMessage !== undefined) {
      this.#initialUserEntryId = initialSessionManager.appendMessage({
        role: "user",
        content: options.initialUserMessage,
        timestamp: Date.now(),
      });
    }

    const createRuntime: CreateAgentSessionRuntimeFactory = async ({
      cwd,
      agentDir: runtimeAgentDir,
      sessionManager,
      sessionStartEvent,
    }) => {
      const services = await createAgentSessionServices({
        cwd,
        agentDir: runtimeAgentDir,
        modelRuntime,
        resourceLoaderOptions: {
          extensionFactories: [
            ...(options.beforeCyclotomy ?? []),
            ...(options.includeCyclotomy === false
              ? []
              : [{ name: "cyclotomy", factory: registerCyclotomy }]),
            ...(options.afterCyclotomy ?? []),
          ],
          // Load only Cyclotomy: the host's own resources are not under test.
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
        },
      });
      const loaded = services.resourceLoader.getExtensions();
      if (loaded.errors.length > 0) {
        throw new Error(
          `Cyclotomy failed to load into real Pi: ${JSON.stringify(
            loaded.errors,
          )}`,
        );
      }
      // Read the commands Pi itself registered, so a renamed or missing host
      // registration surface fails the assertion instead of silently passing.
      this.#commandNames = loaded.extensions
        .flatMap((extension) => [...extension.commands.keys()])
        .sort();

      const created = await createAgentSessionFromServices({
        services,
        sessionManager,
        ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
        model,
        // Keep turns deterministic: the fixed model never calls a tool.
        noTools: "all",
      });
      return {
        ...created,
        services,
        diagnostics: services.diagnostics,
      };
    };
    this.#createRuntime = createRuntime;
    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: workspace,
      agentDir,
      sessionManager: initialSessionManager,
      sessionStartEvent: { type: "session_start", reason: "startup" },
    });
    this.#runtime = runtime;
    runtime.setRebindSession((session) => this.#bindSession(session));
    await this.#bindSession(runtime.session);
  }

  /**
   * Exercise Pi's CLI-style cross-workspace fork: `SessionManager.forkFrom`
   * creates the child first, then a fresh runtime emits ordinary `startup`
   * without a `previousSessionFile` lifecycle field. The public child header
   * is therefore only a locator; Cyclotomy must still authenticate and import
   * the source through its normal cold-parent protocol.
   */
  async startupForkToNewWorkspace(): Promise<{
    readonly sourceSessionId: string;
    readonly sourceSessionFile: string;
    readonly sourceLeafId: string;
  }> {
    const runtime = this.#runtime;
    const createRuntime = this.#createRuntime;
    const agentDir = this.#agentDir;
    if (
      runtime === undefined ||
      createRuntime === undefined ||
      agentDir === undefined
    ) {
      throw new Error("harness is not started");
    }
    const sourceSessionId = this.sessionId;
    const sourceSessionFile = this.sessionManager.getSessionFile();
    if (sourceSessionFile === undefined) {
      throw new Error("real Pi source session is not persisted");
    }
    const sourceLeafId = this.leafId;
    const targetWorkspace = await mkdtemp(
      join(tmpdir(), "cyclotomy-realpi-fork-target-"),
    );
    this.#workspaceRoots.push(targetWorkspace);
    const child = SessionManager.forkFrom(
      sourceSessionFile,
      targetWorkspace,
      join(agentDir, "sessions"),
    );

    await runtime.dispose();
    const childRuntime = await createAgentSessionRuntime(createRuntime, {
      cwd: targetWorkspace,
      agentDir,
      sessionManager: child,
      // Deliberately omit sessionStartEvent. This is Pi's public startup-fork
      // shape and guards against assuming a runtime `reason: "fork"` event.
    });
    this.#runtime = childRuntime;
    this.#workspace = targetWorkspace;
    this.#storeRoot = join(
      agentDir,
      "cyclotomy",
      createHash("sha256")
        .update(await realpath(targetWorkspace))
        .digest("hex"),
    );
    childRuntime.setRebindSession((session) => this.#bindSession(session));
    await this.#bindSession(childRuntime.session);
    return { sourceSessionId, sourceSessionFile, sourceLeafId };
  }

  /** Run one real agent turn, which makes Pi append entries and emit turn_end. */
  async turn(prompt = "continue"): Promise<void> {
    await this.session.prompt(prompt);
  }

  /** Dispatch a slash command the way Pi does, before template expansion. */
  async command(text: string): Promise<void> {
    await this.session.prompt(text);
  }

  /** Fork through Pi's real runtime replacement path. */
  async fork(
    entryId: string,
    position: "before" | "at" = "before",
  ): Promise<void> {
    const runtime = this.#runtime;
    if (runtime === undefined) throw new Error("harness is not started");
    const result = await runtime.fork(entryId, { position });
    if (result.cancelled) throw new Error("real Pi fork was cancelled");
  }

  /** Navigate through Pi's real session-tree event path. */
  async navigate(entryId: string): Promise<void> {
    const result = await this.navigateResult(entryId);
    if (result.cancelled) throw new Error("real Pi navigation was cancelled");
  }

  /** Invoke Pi tree navigation without interpreting its public result. */
  async navigateResult(
    entryId: string,
    options: NonNullable<Parameters<AgentSession["navigateTree"]>[1]> = {},
  ): Promise<Awaited<ReturnType<AgentSession["navigateTree"]>>> {
    return this.session.navigateTree(entryId, options);
  }

  async writeWorkspaceFile(name: string, contents: string): Promise<void> {
    await writeFile(join(this.workspace, name), contents);
  }

  async dispose(): Promise<void> {
    try {
      await this.#runtime?.dispose();
    } catch {
      // Disposal must not mask the assertion that already failed.
    }
    const roots = [this.#agentDir, ...this.#workspaceRoots].filter(
      (root): root is string => root !== undefined,
    );
    if (this.#agentDirEnvWasSet) {
      process.env.PI_CODING_AGENT_DIR = this.#previousAgentDirEnv!;
    } else {
      delete process.env.PI_CODING_AGENT_DIR;
    }
    this.#agentDirEnvWasSet = false;
    this.#previousAgentDirEnv = undefined;
    this.#runtime = undefined;
    this.#createRuntime = undefined;
    this.#agentDir = undefined;
    this.#workspace = undefined;
    this.#commandNames = undefined;
    this.#storeRoot = undefined;
    this.#initialUserEntryId = undefined;
    this.modelOutcome = "success";
    this.extensionErrors.length = 0;
    this.#workspaceRoots.length = 0;
    await Promise.all(
      roots.map((root) => rm(root, { recursive: true, force: true })),
    );
  }
}
