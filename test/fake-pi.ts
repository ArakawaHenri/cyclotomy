import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionEvent,
  ExtensionHandler,
} from "@earendil-works/pi-coding-agent";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { mkdtempSync } from "node:fs";
import { lstat, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Minimal in-memory Pi host for integration tests. It reproduces the host
 * semantics Cyclotomy relies on: event handlers are awaited sequentially,
 * `session_before_tree` may cancel, `turn_end` fires only after the turn's
 * entries are persisted, and `session_tree.newLeafId` is read back after the
 * move. It is not a general Pi emulator.
 */

export interface FakeEntry {
  readonly id: string;
  readonly parentId: string | null;
  readonly timestamp: string;
  readonly type?:
    | "message"
    | "custom_message"
    | "branch_summary"
    | "label"
    | "compaction"
    | "model_change"
    | "thinking_level_change"
    | "session_info"
    | "custom";
  readonly message?: {
    readonly role: "user" | "assistant" | "custom";
    readonly content?: string;
  };
  readonly content?: string;
  readonly provider?: string;
  readonly modelId?: string;
  readonly thinkingLevel?: string;
  readonly name?: string;
}

export interface FakeNotification {
  readonly message: string;
  readonly level: string | undefined;
}

export interface FakeSelection {
  readonly prompt: string;
  readonly options: readonly string[];
}

function serializedSession(manager: FakeSessionManager): string {
  // Host-side persistence is not an extension API observation. Read the
  // fake's own append log so public API call counts describe Cyclotomy only.
  return `${[manager.getHeader(), ...manager.entries.values()]
    .map((record) => JSON.stringify(record))
    .join("\n")}\n`;
}

type EventType = ExtensionEvent["type"];
type EventOf<T extends EventType> = Extract<ExtensionEvent, { type: T }>;
type Handler = ExtensionHandler<ExtensionEvent, unknown>;
type ExtensionFactory = (pi: ExtensionAPI) => void;

export interface FakeForkPlan {
  readonly previousManager: FakeSessionManager;
  readonly nextManager: FakeSessionManager;
  readonly previousSessionFile: string;
  readonly targetSessionFile: string;
}

function fakeUserMessage(content = "test") {
  return { role: "user", content, timestamp: 0 } as const;
}

function treePreparation(targetId: string, oldLeafId: string | null) {
  return {
    targetId,
    oldLeafId,
    commonAncestorId: null,
    entriesToSummarize: [],
    userWantsSummary: false,
  } satisfies EventOf<"session_before_tree">["preparation"];
}

export class FakeSessionManager {
  readonly entries = new Map<string, FakeEntry>();
  readonly sessionId: string;
  readonly sessionFile: string | null;
  readonly cwd: string;
  readonly sessionCwd: string;
  readonly parentSessionFile: string | null;
  #leafId: string | null = null;
  #counter = 0;

  constructor(
    sessionId: string,
    sessionFile: string | null,
    cwd: string,
    parentSessionFile: string | null = null,
    sessionCwd: string = cwd,
  ) {
    this.sessionId = sessionId;
    this.sessionFile = sessionFile;
    this.cwd = cwd;
    this.sessionCwd = sessionCwd;
    this.parentSessionFile = parentSessionFile;
  }

  appendEntry(
    shape: Pick<
      FakeEntry,
      | "type"
      | "message"
      | "content"
      | "provider"
      | "modelId"
      | "thinkingLevel"
      | "name"
    > = { type: "message", message: { role: "assistant" } },
  ): FakeEntry {
    this.#counter += 1;
    const entry: FakeEntry = {
      id: `${this.sessionId}-e${this.#counter}`,
      parentId: this.#leafId,
      timestamp: new Date().toISOString(),
      ...shape,
    };
    this.entries.set(entry.id, entry);
    this.#leafId = entry.id;
    return entry;
  }

  setLeaf(entryId: string | null): void {
    if (entryId === null) {
      this.#leafId = null;
      return;
    }
    if (!this.entries.has(entryId)) {
      throw new Error(`unknown entry ${entryId}`);
    }
    this.#leafId = entryId;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getSessionFile(): string | undefined {
    return this.sessionFile ?? undefined;
  }

  getCwd(): string {
    return this.cwd;
  }

  getLeafId(): string | null {
    return this.#leafId;
  }

  getEntry(entryId: string): FakeEntry | undefined {
    return this.entries.get(entryId);
  }

  getEntries(): FakeEntry[] {
    return [...this.entries.values()];
  }

  getBranch(fromId: string = this.#leafId ?? ""): FakeEntry[] {
    return this.branchTo(fromId.length === 0 ? null : fromId);
  }

  getHeader(): {
    type: "session";
    id: string;
    timestamp: string;
    cwd: string;
    version: number;
    parentSession?: string;
  } {
    return {
      type: "session",
      id: this.sessionId,
      timestamp: new Date(0).toISOString(),
      cwd: this.sessionCwd,
      version: CURRENT_SESSION_VERSION,
      ...(this.parentSessionFile === null
        ? {}
        : { parentSession: this.parentSessionFile }),
    };
  }

  /** Return only the root-to-leaf path, matching Pi's public session API. */
  branchTo(leafId: string | null): FakeEntry[] {
    const reversed: FakeEntry[] = [];
    let cursor = leafId;
    while (cursor !== null) {
      const entry = this.entries.get(cursor);
      if (entry === undefined) throw new Error(`unknown entry ${cursor}`);
      reversed.push(entry);
      cursor = entry.parentId;
    }
    return reversed.reverse();
  }
}

export class FakePi {
  static readonly #activeHosts = new Set<FakePi>();

  static async disposeAll(): Promise<void> {
    await Promise.all([...FakePi.#activeHosts].map((host) => host.dispose()));
  }

  readonly notifications: FakeNotification[] = [];
  readonly selections: FakeSelection[] = [];
  readonly statuses = new Map<string, string>();
  selectDestructive = true;
  /** undefined follows selectDestructive; null simulates Escape. */
  selectionOverride: string | null | undefined;
  selectHook: (() => Promise<void>) | undefined;
  notifyThrows = false;
  sessionContextThrows = false;
  failUserMessagePersistence = false;
  hasUI = true;
  mode: "tui" | "rpc" | "json" | "print" = "tui";
  idle = true;
  waitForIdleCalls = 0;
  reloadCalls = 0;
  waitForIdleHook: (() => Promise<void>) | undefined;
  reloadHook: (() => Promise<void>) | undefined;
  /** Test-only hook for changes after before_tree but before session_tree. */
  beforeTreeCommit: (() => Promise<void>) | undefined;
  /** Test-only hook for host work after input acceptance but before user append. */
  beforeUserMessageCommit: (() => Promise<void>) | undefined;
  /** Test-only hook for agent-run work after user append but before context. */
  afterUserMessageCommit: (() => Promise<void>) | undefined;
  /** Test-only crash boundary after custom append but before provider context. */
  afterCustomMessageCommit: (() => Promise<void>) | undefined;
  manager: FakeSessionManager;

  readonly #handlers = new Map<EventType, Handler[]>();
  readonly #commands = new Map<
    string,
    (args: string, context: ExtensionContext) => Promise<void>
  >();
  #nextSession = 0;
  #disposed = false;
  #sessionStarted = false;
  readonly #sessionDirectory: string;
  readonly #ownedSessionFiles = new Set<string>();
  #api: ExtensionAPI;
  #context: ExtensionContext;
  #factory: ExtensionFactory | undefined;
  factoryLoads = 0;

  constructor(
    cwd: string,
    factory?: ExtensionFactory,
    initialManager?: FakeSessionManager,
  ) {
    FakePi.#activeHosts.add(this);
    this.#factory = factory;
    this.#sessionDirectory = mkdtempSync(
      join(process.env.PI_CODING_AGENT_DIR ?? tmpdir(), "cyclotomy-fake-pi-"),
    );
    this.manager = initialManager ?? this.#newManager(null, cwd);
    if (initialManager !== undefined) {
      const sequence = /^s(\d+)$/u.exec(initialManager.sessionId)?.[1];
      this.#nextSession = sequence === undefined ? 0 : Number(sequence);
    }
    this.#api = this.#createApi();
    this.#context = this.#createContext();
    if (factory !== undefined) this.#installRuntime(factory);
  }

  #newManager(
    parentSessionFile: string | null = null,
    cwd: string = this.manager.getCwd(),
  ): FakeSessionManager {
    this.#nextSession += 1;
    const sessionFile = join(
      this.#sessionDirectory,
      `s${this.#nextSession}.jsonl`,
    );
    this.#ownedSessionFiles.add(sessionFile);
    return new FakeSessionManager(
      `s${this.#nextSession}`,
      sessionFile,
      cwd,
      parentSessionFile,
    );
  }

  get api(): ExtensionAPI {
    return this.#api;
  }

  get context(): ExtensionContext {
    return this.#context;
  }

  #createApi(): ExtensionAPI {
    const self = this;
    return {
      on<T extends EventType>(event: T, handler: ExtensionHandler<EventOf<T>>) {
        const list = self.#handlers.get(event) ?? [];
        list.push(handler as Handler);
        self.#handlers.set(event, list);
      },
      registerCommand(
        name: string,
        definition: {
          handler: (args: string, context: ExtensionContext) => Promise<void>;
        },
      ) {
        self.#commands.set(name, definition.handler);
      },
    } as unknown as ExtensionAPI;
  }

  #createContext(): ExtensionContext {
    const self = this;
    const ui = {
      notify(message: string, level?: string) {
        if (self.notifyThrows) throw new Error("test UI notify failure");
        self.notifications.push({ message, level });
      },
      setStatus(key: string, message: string | undefined) {
        if (message === undefined) {
          self.statuses.delete(key);
        } else {
          self.statuses.set(key, message);
        }
      },
      async select(
        title: string,
        options: readonly string[],
      ): Promise<string | undefined> {
        self.selections.push({
          prompt: title,
          options: [...options],
        });
        await self.selectHook?.();
        if (self.selectionOverride === null) return undefined;
        if (self.selectionOverride !== undefined) {
          return self.selectionOverride;
        }
        return self.selectDestructive ? options.at(-1) : options[0];
      },
    };
    return {
      get cwd() {
        return self.manager.getCwd();
      },
      get hasUI() {
        return self.hasUI;
      },
      get mode() {
        return self.mode;
      },
      ui,
      isIdle: () => self.idle,
      async waitForIdle() {
        self.waitForIdleCalls += 1;
        await self.waitForIdleHook?.();
      },
      async reload() {
        self.reloadCalls += 1;
        await self.reloadHook?.();
      },
      get sessionManager() {
        if (self.sessionContextThrows) {
          throw new Error("test session context failure");
        }
        return self.manager;
      },
    } as unknown as ExtensionContext;
  }

  async #emit<T extends EventType>(
    type: T,
    event: EventOf<T>,
  ): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const handler of this.#handlers.get(type) ?? []) {
      results.push(await handler(event, this.context));
    }
    return results;
  }

  async #persistCurrentSessionIfPresent(): Promise<void> {
    const sessionFile = this.manager.getSessionFile();
    if (sessionFile === undefined) return;
    try {
      const entry = await lstat(sessionFile);
      if (!entry.isFile() || entry.isSymbolicLink()) return;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        Reflect.get(error, "code") === "ENOENT"
      ) {
        return;
      }
      throw error;
    }
    await writeFile(sessionFile, serializedSession(this.manager));
  }

  /** Persist the complete public session graph at an explicit host boundary. */
  async persistSession(): Promise<void> {
    const sessionFile = this.manager.getSessionFile();
    if (sessionFile === undefined) {
      throw new Error("cannot persist an in-memory fake Pi session");
    }
    await writeFile(sessionFile, serializedSession(this.manager));
  }

  /** Pi semantics: entries persist first, then turn_end fires. */
  async endTurn(entryCount = 1): Promise<void> {
    for (let index = 0; index < entryCount; index += 1) {
      this.manager.appendEntry();
    }
    await this.#persistCurrentSessionIfPresent();
    await this.#emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: fakeUserMessage(),
      toolResults: [],
    });
  }

  async executeUserBash(
    command: string,
    operation: () => Promise<void>,
    persistResultEntry = true,
  ): Promise<void> {
    const event = {
      type: "user_bash",
      command,
      excludeFromContext: false,
      cwd: this.manager.getCwd(),
    } satisfies EventOf<"user_bash">;
    // Pi stops at the first user_bash handler that returns a result.
    let intercepted = false;
    for (const handler of this.#handlers.get("user_bash") ?? []) {
      const result = await handler(event, this.context);
      if (typeof result === "object" && result !== null && "result" in result) {
        intercepted = true;
        break;
      }
    }
    if (!intercepted) await operation();
    if (persistResultEntry) {
      this.manager.appendEntry({
        type: "message",
        message: { role: "assistant" },
      });
    }
  }

  async submitInput(text = "test"): Promise<"continued" | "handled"> {
    const results = await this.#emit("input", {
      type: "input",
      text,
      images: [],
      source: "interactive",
    });
    if (
      results.some(
        (result) =>
          typeof result === "object" &&
          result !== null &&
          (result as { action?: string }).action === "handled",
      )
    ) {
      return "handled";
    }
    await this.beforeUserMessageCommit?.();
    await this.#emit("message_end", {
      type: "message_end",
      message: fakeUserMessage(text),
    });
    if (this.failUserMessagePersistence) {
      throw new Error("test user-message persistence failure");
    }
    this.manager.appendEntry({
      type: "message",
      message: { role: "user" },
    });
    await this.afterUserMessageCommit?.();
    await this.#emit("context", {
      type: "context",
      messages: [],
    });
    return "continued";
  }

  /** Model Pi's idle sendMessage custom path, which bypasses input. */
  async sendCustomMessage(
    content = "custom",
    triggerTurn = true,
  ): Promise<string> {
    if (triggerTurn) {
      const wasIdle = this.idle;
      this.idle = false;
      try {
        await this.#emit("message_end", {
          type: "message_end",
          message: {
            role: "custom",
            customType: "test",
            content,
            display: true,
            timestamp: 0,
          },
        });
      } finally {
        this.idle = wasIdle;
      }
    }
    const entry = this.manager.appendEntry({
      type: "message",
      message: { role: "custom", content },
    });
    if (triggerTurn) {
      await this.afterCustomMessageCommit?.();
      await this.#emit("context", {
        type: "context",
        messages: [],
      });
    }
    return entry.id;
  }

  /** Emit only preflight input, simulating a later host validation failure. */
  async preflightInput(
    text = "test",
    streamingBehavior?: EventOf<"input">["streamingBehavior"],
  ): Promise<"continued" | "handled"> {
    const results = await this.#emit("input", {
      type: "input",
      text,
      images: [],
      source: "interactive",
      ...(streamingBehavior === undefined ? {} : { streamingBehavior }),
    });
    return results.some(
      (result) =>
        typeof result === "object" &&
        result !== null &&
        (result as { action?: string }).action === "handled",
    )
      ? "handled"
      : "continued";
  }

  async emitContext(): Promise<void> {
    await this.#emit("context", { type: "context", messages: [] });
  }

  async selectModel(
    provider: string,
    modelId: string,
    thinkingLevel?: EventOf<"thinking_level_select">["level"],
  ): Promise<{ readonly modelId: string; readonly thinkingId?: string }> {
    const model = this.manager.appendEntry({
      type: "model_change",
      provider,
      modelId,
    });
    let thinking: FakeEntry | undefined;
    if (thinkingLevel !== undefined) {
      thinking = this.manager.appendEntry({
        type: "thinking_level_change",
        thinkingLevel,
      });
      await this.#emit("thinking_level_select", {
        type: "thinking_level_select",
        level: thinkingLevel,
        previousLevel: "off",
      });
    }
    await this.#emit("model_select", {
      type: "model_select",
      model: {
        provider,
        id: modelId,
        name: modelId,
        api: "openai-completions",
        baseUrl: "https://invalid.example",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1,
        maxTokens: 1,
      },
      previousModel: undefined,
      source: "set",
    });
    return {
      modelId: model.id,
      ...(thinking === undefined ? {} : { thinkingId: thinking.id }),
    };
  }

  async selectThinkingLevel(
    level: EventOf<"thinking_level_select">["level"],
  ): Promise<string> {
    const entry = this.manager.appendEntry({
      type: "thinking_level_change",
      thinkingLevel: level,
    });
    await this.#emit("thinking_level_select", {
      type: "thinking_level_select",
      level,
      previousLevel: "off",
    });
    return entry.id;
  }

  async setSessionName(name: string): Promise<string> {
    const normalized = name.replace(/[\r\n]+/gu, " ").trim();
    const entry = this.manager.appendEntry({
      type: "session_info",
      name: normalized,
    });
    await this.#emit("session_info_changed", {
      type: "session_info_changed",
      name: normalized.length === 0 ? undefined : normalized,
    });
    return entry.id;
  }

  async compact(
    reason: "manual" | "threshold" | "overflow" = "manual",
  ): Promise<"done" | "cancelled"> {
    const before = await this.#emit("session_before_compact", {
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: this.manager.getLeafId() ?? "root",
        messagesToSummarize: [],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 0,
        fileOps: {
          read: new Set<string>(),
          written: new Set<string>(),
          edited: new Set<string>(),
        },
        settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
      },
      branchEntries: [],
      reason,
      willRetry: reason === "overflow",
      signal: new AbortController().signal,
    });
    if (
      before.some(
        (result) =>
          typeof result === "object" &&
          result !== null &&
          (result as { cancel?: boolean }).cancel === true,
      )
    ) {
      return "cancelled";
    }
    const retained = this.manager.appendEntry({ type: "compaction" });
    const compactionEntry = {
      ...retained,
      type: "compaction" as const,
      summary: "test summary",
      firstKeptEntryId: retained.id,
      tokensBefore: 0,
    };
    await this.#emit("session_compact", {
      type: "session_compact",
      compactionEntry,
      fromExtension: false,
      reason,
      willRetry: reason === "overflow",
    });
    return "done";
  }

  async startSession(
    reason: "startup" | "reload" | "new" | "resume" | "fork",
    previousSessionFile?: string,
  ): Promise<void> {
    if (this.#sessionStarted) {
      throw new Error(
        "FakePi cannot reuse an extension runtime for another session_start",
      );
    }
    this.#sessionStarted = true;
    const sessionFile = this.manager.getSessionFile();
    if (sessionFile !== undefined && this.#ownedSessionFiles.has(sessionFile)) {
      await writeFile(sessionFile, serializedSession(this.manager));
    }
    await this.#emit("session_start", {
      type: "session_start",
      reason,
      ...(previousSessionFile === undefined ? {} : { previousSessionFile }),
    });
  }

  /** Emit an impossible same-runtime start for fail-closed host tests only. */
  async emitMalformedSessionStart(
    reason: "startup" | "reload" | "new" | "resume" | "fork",
    previousSessionFile?: string,
  ): Promise<void> {
    await this.#emit("session_start", {
      type: "session_start",
      reason,
      ...(previousSessionFile === undefined ? {} : { previousSessionFile }),
    });
  }

  /** Recreate Pi's extension runtime before delivering a replacement start. */
  async replaceRuntime(
    factory: ExtensionFactory = this.#requiredFactory(),
    reason: "startup" | "reload" | "new" | "resume" | "fork",
    previousSessionFile?: string,
  ): Promise<void> {
    const targetSessionFile = this.manager.getSessionFile();
    await this.#emit("session_shutdown", {
      type: "session_shutdown",
      reason: reason === "startup" ? "quit" : reason,
      ...(reason === "startup" ||
      reason === "reload" ||
      targetSessionFile === undefined
        ? {}
        : { targetSessionFile }),
    });
    this.#installRuntime(factory);
    await this.startSession(reason, previousSessionFile);
  }

  /** Replace both SessionManager and extension runtime in Pi's public order. */
  async replaceSession(
    target: FakeSessionManager,
    factory: ExtensionFactory = this.#requiredFactory(),
    reason: "new" | "resume" | "fork",
    previousSessionFile?: string,
  ): Promise<void> {
    const targetSessionFile = target.getSessionFile();
    await this.#emit("session_shutdown", {
      type: "session_shutdown",
      reason,
      ...(targetSessionFile === undefined ? {} : { targetSessionFile }),
    });
    this.manager = target;
    this.#installRuntime(factory);
    await this.startSession(reason, previousSessionFile);
  }

  #requiredFactory(): ExtensionFactory {
    if (this.#factory === undefined) {
      throw new Error("extension runtime replacement requires a factory");
    }
    return this.#factory;
  }

  #installRuntime(factory: ExtensionFactory): void {
    this.#factory = factory;
    this.factoryLoads += 1;
    this.#handlers.clear();
    this.#commands.clear();
    this.#api = this.#createApi();
    this.#context = this.#createContext();
    this.#sessionStarted = false;
    factory(this.#api);
  }

  /** Recreate the extension runner using Pi's /reload event order. */
  async reloadExtension(): Promise<void> {
    await this.replaceRuntime(this.#requiredFactory(), "reload");
  }

  newDetachedSession(cwd: string = this.manager.getCwd()): FakeSessionManager {
    return this.#newManager(null, cwd);
  }

  newInMemorySession(cwd: string = this.manager.getCwd()): FakeSessionManager {
    this.#nextSession += 1;
    return new FakeSessionManager(`memory-${this.#nextSession}`, null, cwd);
  }

  async resumeTo(
    target: FakeSessionManager,
    factory?: ExtensionFactory,
  ): Promise<"done" | "cancelled"> {
    const targetSessionFile = target.getSessionFile();
    const before = await this.#emit("session_before_switch", {
      type: "session_before_switch",
      reason: "resume",
      ...(targetSessionFile === undefined ? {} : { targetSessionFile }),
    });
    if (
      before.some(
        (result) =>
          typeof result === "object" &&
          result !== null &&
          (result as { cancel?: boolean }).cancel === true,
      )
    ) {
      return "cancelled";
    }
    const runtimeFactory = factory ?? this.#requiredFactory();
    const previous = this.manager;
    await this.#emit("session_shutdown", {
      type: "session_shutdown",
      reason: "resume",
      ...(targetSessionFile === undefined ? {} : { targetSessionFile }),
    });
    this.manager = target;
    this.#installRuntime(runtimeFactory);
    await this.startSession("resume", previous.getSessionFile());
    return "done";
  }

  /** Run only Pi's cancellable session-switch preparation hook. */
  async prepareSwitch(
    reason: "new" | "resume" = "new",
  ): Promise<"ready" | "cancelled"> {
    const before = await this.#emit("session_before_switch", {
      type: "session_before_switch",
      reason,
    });
    return before.some(
      (result) =>
        typeof result === "object" &&
        result !== null &&
        (result as { cancel?: boolean }).cancel === true,
    )
      ? "cancelled"
      : "ready";
  }

  async navigate(targetId: string): Promise<"done" | "cancelled"> {
    const oldLeafId = this.manager.getLeafId();
    const before = await this.#emit("session_before_tree", {
      type: "session_before_tree",
      preparation: treePreparation(targetId, oldLeafId),
      signal: new AbortController().signal,
    });
    if (
      before.some(
        (result) =>
          typeof result === "object" &&
          result !== null &&
          (result as { cancel?: boolean }).cancel === true,
      )
    ) {
      return "cancelled";
    }
    await this.beforeTreeCommit?.();
    const target = this.manager.getEntry(targetId);
    const effectiveTarget =
      target?.type === "custom_message" ||
      (target?.type === "message" && target.message?.role === "user")
        ? target.parentId
        : targetId;
    this.manager.setLeaf(effectiveTarget);
    await this.#emit("session_tree", {
      type: "session_tree",
      newLeafId: this.manager.getLeafId(),
      oldLeafId,
    });
    return "done";
  }

  /** Run only Pi's cancellable preparation hook, without committing a move. */
  async prepareNavigation(targetId: string): Promise<"ready" | "cancelled"> {
    const oldLeafId = this.manager.getLeafId();
    const before = await this.#emit("session_before_tree", {
      type: "session_before_tree",
      preparation: treePreparation(targetId, oldLeafId),
      signal: new AbortController().signal,
    });
    return before.some(
      (result) =>
        typeof result === "object" &&
        result !== null &&
        (result as { cancel?: boolean }).cancel === true,
    )
      ? "cancelled"
      : "ready";
  }

  /** Commit a prepared move through Pi's branch-summary wrapper node. */
  async commitPreparedSummary(
    targetId: string,
    wrappers:
      | boolean
      | {
          readonly beforeLabels?: number;
          readonly afterLabels?: number;
        } = false,
  ): Promise<string> {
    const oldLeafId = this.manager.getLeafId();
    const target = this.manager.getEntry(targetId);
    const effectiveTarget =
      target?.type === "custom_message" ||
      (target?.type === "message" && target.message?.role === "user")
        ? target.parentId
        : targetId;
    const beforeLabels =
      typeof wrappers === "object" ? (wrappers.beforeLabels ?? 0) : 0;
    const afterLabels =
      typeof wrappers === "object"
        ? (wrappers.afterLabels ?? 0)
        : wrappers
          ? 1
          : 0;
    let summaryParentId = effectiveTarget;
    for (let index = 0; index < beforeLabels; index += 1) {
      const labelId = `label-${this.manager.entries.size + 1}`;
      this.manager.entries.set(labelId, {
        id: labelId,
        parentId: summaryParentId,
        timestamp: new Date().toISOString(),
        type: "label",
      });
      summaryParentId = labelId;
    }
    const id = `summary-${this.manager.entries.size + 1}`;
    const entry: FakeEntry = {
      id,
      parentId: summaryParentId,
      timestamp: new Date().toISOString(),
      type: "branch_summary",
    };
    this.manager.entries.set(id, entry);
    this.manager.setLeaf(id);
    let newLeafId = id;
    for (let index = 0; index < afterLabels; index += 1) {
      const labelId = `label-${this.manager.entries.size + 1}`;
      const label: FakeEntry = {
        id: labelId,
        parentId: newLeafId,
        timestamp: new Date().toISOString(),
        type: "label",
      };
      this.manager.entries.set(labelId, label);
      newLeafId = labelId;
    }
    this.manager.setLeaf(newLeafId);
    await this.#emit("session_tree", {
      type: "session_tree",
      newLeafId,
      oldLeafId,
      summaryEntry: {
        ...entry,
        type: "branch_summary",
        fromId: targetId,
        summary: "test summary",
      },
    });
    return id;
  }

  /** Fire session_tree without a preceding before_tree. */
  async landUnmanaged(targetId: string): Promise<void> {
    const oldLeafId = this.manager.getLeafId();
    this.manager.setLeaf(targetId);
    await this.#emit("session_tree", {
      type: "session_tree",
      newLeafId: this.manager.getLeafId(),
      oldLeafId,
    });
  }

  async beginFork(
    entryId: string,
    position: "before" | "at",
  ): Promise<FakeForkPlan | "cancelled"> {
    const before = await this.#emit("session_before_fork", {
      type: "session_before_fork",
      entryId,
      position,
    });
    if (
      before.some(
        (result) =>
          typeof result === "object" &&
          result !== null &&
          (result as { cancel?: boolean }).cancel === true,
      )
    ) {
      return "cancelled";
    }
    const selected = this.manager.getEntry(entryId);
    if (selected === undefined) throw new Error(`unknown entry ${entryId}`);
    const previous = this.manager;
    const next = this.#newManager(
      previous.getSessionFile() ?? null,
      previous.getCwd(),
    );
    const targetLeafId = position === "at" ? entryId : selected.parentId;
    for (const entry of previous.branchTo(targetLeafId)) {
      next.entries.set(entry.id, entry);
    }
    next.setLeaf(targetLeafId);
    return {
      previousManager: previous,
      nextManager: next,
      previousSessionFile: previous.getSessionFile()!,
      targetSessionFile: next.getSessionFile()!,
    };
  }

  async shutdownForkRuntime(plan: FakeForkPlan): Promise<void> {
    if (this.manager !== plan.previousManager) {
      throw new Error("fork plan no longer belongs to the active session");
    }
    await this.#emit("session_shutdown", {
      type: "session_shutdown",
      reason: "fork",
      targetSessionFile: plan.targetSessionFile,
    });
    this.#handlers.clear();
    this.#commands.clear();
  }

  async finishForkReload(
    plan: FakeForkPlan,
    factory: ExtensionFactory = this.#requiredFactory(),
  ): Promise<void> {
    await this.shutdownForkRuntime(plan);
    this.manager = plan.nextManager;
    this.#installRuntime(factory);
    await this.startSession("fork", plan.previousSessionFile);
  }

  async fork(
    entryId: string,
    positionOrFactory: "before" | "at" | ExtensionFactory = "at",
    factory?: ExtensionFactory,
  ): Promise<"done" | "cancelled"> {
    const position =
      typeof positionOrFactory === "function" ? "at" : positionOrFactory;
    const runtimeFactory =
      typeof positionOrFactory === "function" ? positionOrFactory : factory;
    const plan = await this.beginFork(entryId, position);
    if (plan === "cancelled") return "cancelled";
    await this.finishForkReload(
      plan,
      runtimeFactory ?? this.#requiredFactory(),
    );
    return "done";
  }

  registeredCommandNames(): readonly string[] {
    return [...this.#commands.keys()].sort();
  }

  async runCommand(name: string, args = ""): Promise<void> {
    const handler = this.#commands.get(name);
    if (handler === undefined) {
      throw new Error(`command ${name} not registered`);
    }
    await handler(args, this.context);
  }

  /** Model Pi's graceful test teardown so extensions can release resources. */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    try {
      await this.#emit("session_shutdown", {
        type: "session_shutdown",
        reason: "quit",
      });
    } finally {
      FakePi.#activeHosts.delete(this);
      await rm(this.#sessionDirectory, { recursive: true, force: true });
    }
  }
}
