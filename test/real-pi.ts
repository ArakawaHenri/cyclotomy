import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
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
function fixedAssistantTurn() {
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
  readonly statuses = new Map<string, string>();
  /** Index of the option the extension UI selects; 0 is Pi's safe default. */
  selectIndex = 0;
  readonly selections: { prompt: string; options: readonly string[] }[] = [];

  #session: AgentSession | undefined;
  #sessionManager: SessionManager | undefined;
  #agentDir: string | undefined;
  #workspace: string | undefined;
  #storeRoot: string | undefined;
  #previousAgentDirEnv: string | undefined;
  #agentDirEnvWasSet = false;
  #commandNames: readonly string[] | undefined;

  get session(): AgentSession {
    if (this.#session === undefined) throw new Error("harness is not started");
    return this.#session;
  }

  /** Command names Pi actually registered from Cyclotomy's inline extension. */
  get registeredCommandNames(): readonly string[] {
    if (this.#commandNames === undefined) {
      throw new Error("harness is not started");
    }
    return this.#commandNames;
  }

  get sessionManager(): SessionManager {
    if (this.#sessionManager === undefined) {
      throw new Error("harness is not started");
    }
    return this.#sessionManager;
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

  /**
   * Create the agent directory, workspace, and a real persisted Pi session with
   * Cyclotomy loaded as an inline extension.
   */
  async start(options: { readonly settings?: unknown } = {}): Promise<void> {
    const agentDir = await mkdtemp(join(tmpdir(), "cyclotomy-realpi-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "cyclotomy-realpi-ws-"));
    this.#agentDir = agentDir;
    this.#workspace = workspace;
    // registerCyclotomy resolves its own configuration through Pi's
    // getAgentDir(), which reads this variable on every call. Without it the
    // suite would bind the developer's real ~/.pi/agent store.
    this.#agentDirEnvWasSet = Object.hasOwn(
      process.env,
      "PI_CODING_AGENT_DIR",
    );
    this.#previousAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
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
      createHash("sha256").update(await realpath(workspace)).digest("hex"),
    );

    // Pin every credential and catalog path into the temporary agent
    // directory, and forbid network access, so the suite can never read the
    // developer's real auth.json or reach a model catalog.
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(agentDir, "models-store.json"),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    modelRuntime.registerProvider(PROVIDER_ID, {
      name: "Cyclotomy Test Provider",
      apiKey: "unused-by-streamSimple",
      api: "openai-completions",
      authHeader: false,
      // Required even with streamSimple, but never contacted.
      baseUrl: "http://127.0.0.1:1/v1",
      streamSimple: () => fixedAssistantTurn() as never,
      models: [{
        id: MODEL_ID,
        name: "Cyclotomy Test Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 4096,
      }],
    });
    const model = modelRuntime.getModel(PROVIDER_ID, MODEL_ID);
    if (model === undefined) {
      throw new Error("the in-process test model was not registered");
    }

    const sessionManager = SessionManager.create(
      workspace,
      join(agentDir, "sessions"),
    );
    const settingsManager = SettingsManager.create(workspace, agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd: workspace,
      agentDir,
      settingsManager,
      extensionFactories: [{ name: "cyclotomy", factory: registerCyclotomy }],
      // Load only Cyclotomy: the host's own resources are not under test.
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    // Pi reloads a loader it creates itself; an injected one is ours to load.
    await resourceLoader.reload();
    const loaded = resourceLoader.getExtensions();
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

    const { session } = await createAgentSession({
      cwd: workspace,
      agentDir,
      model,
      modelRuntime,
      sessionManager,
      settingsManager,
      resourceLoader,
      // Keep turns deterministic: the fixed model never calls a tool.
      noTools: "all",
      sessionStartEvent: { type: "session_start", reason: "startup" },
    });
    this.#session = session;
    this.#sessionManager = sessionManager;
    await session.bindExtensions({
      uiContext: this.#uiContext(),
      mode: "tui",
    });
  }

  /** Run one real agent turn, which makes Pi append entries and emit turn_end. */
  async turn(prompt = "continue"): Promise<void> {
    await this.session.prompt(prompt);
  }

  /** Dispatch a slash command the way Pi does, before template expansion. */
  async command(text: string): Promise<void> {
    await this.session.prompt(text);
  }

  async writeWorkspaceFile(name: string, contents: string): Promise<void> {
    await writeFile(join(this.workspace, name), contents);
  }

  async dispose(): Promise<void> {
    const session = this.#session;
    try {
      if (
        session !== undefined &&
        session.extensionRunner.hasHandlers("session_shutdown")
      ) {
        await session.extensionRunner.emit({
          type: "session_shutdown",
          reason: "quit",
        });
      }
    } catch {
      // Disposal must not mask the assertion that already failed.
    } finally {
      try {
        session?.dispose();
      } catch {
        // Continue with filesystem cleanup even if Pi's disposal fails.
      }
    }
    const roots = [this.#agentDir, this.#workspace].filter(
      (root): root is string => root !== undefined,
    );
    if (this.#agentDirEnvWasSet) {
      process.env.PI_CODING_AGENT_DIR = this.#previousAgentDirEnv!;
    } else {
      delete process.env.PI_CODING_AGENT_DIR;
    }
    this.#agentDirEnvWasSet = false;
    this.#previousAgentDirEnv = undefined;
    this.#session = undefined;
    this.#sessionManager = undefined;
    this.#agentDir = undefined;
    this.#workspace = undefined;
    this.#commandNames = undefined;
    this.#storeRoot = undefined;
    await Promise.all(
      roots.map((root) => rm(root, { recursive: true, force: true })),
    );
  }
}
