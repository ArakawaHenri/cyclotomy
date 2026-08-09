import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

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

type Handler = (event: never, context: ExtensionContext) => Promise<unknown>;

export class FakeSessionManager {
  readonly entries = new Map<string, FakeEntry>();
  readonly sessionId: string;
  readonly sessionFile: string | null;
  readonly cwd: string;
  readonly parentSessionFile: string | null;
  #leafId: string | null = null;
  #counter = 0;

  constructor(
    sessionId: string,
    sessionFile: string | null,
    cwd: string,
    parentSessionFile: string | null = null,
  ) {
    this.sessionId = sessionId;
    this.sessionFile = sessionFile;
    this.cwd = cwd;
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

  getHeader(): {
    type: "session";
    id: string;
    timestamp: string;
    cwd: string;
    parentSession?: string;
  } {
    return {
      type: "session",
      id: this.sessionId,
      timestamp: new Date(0).toISOString(),
      cwd: this.cwd,
      ...(this.parentSessionFile === null
        ? {}
        : { parentSession: this.parentSessionFile }),
    };
  }
}

export class FakePi {
  static readonly #live = new Set<FakePi>();

  /** Finish every host created by the current test before its files are removed. */
  static async disposeAll(): Promise<void> {
    const settled = await Promise.allSettled(
      [...FakePi.#live].map((pi) => pi.dispose()),
    );
    const failures = settled.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "failed to dispose fake Pi hosts");
    }
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
  /** Test-only hook for changes after before_tree but before session_tree. */
  beforeTreeCommit: (() => Promise<void>) | undefined;
  /** Test-only hook for host work after input acceptance but before user append. */
  beforeUserMessageCommit: (() => Promise<void>) | undefined;
  manager: FakeSessionManager;
  readonly cwd: string;

  readonly #handlers = new Map<string, Handler[]>();
  readonly #commands = new Map<
    string,
    (args: string, context: ExtensionContext) => Promise<void>
  >();
  #nextSession = 0;
  #disposed = false;

  constructor(cwd: string) {
    this.cwd = cwd;
    this.manager = this.#newManager();
    FakePi.#live.add(this);
  }

  #newManager(
    parentSessionFile: string | null = null,
    cwd: string = this.cwd,
  ): FakeSessionManager {
    this.#nextSession += 1;
    return new FakeSessionManager(
      `s${this.#nextSession}`,
      `/sessions/s${this.#nextSession}.jsonl`,
      cwd,
      parentSessionFile,
    );
  }

  readonly api: ExtensionAPI = (() => {
    const self = this;
    return {
      on(event: string, handler: Handler) {
        const list = self.#handlers.get(event) ?? [];
        list.push(handler);
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
  })();

  readonly context: ExtensionContext = (() => {
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
        return self.selectDestructive ? options[1] : options[0];
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
      get sessionManager() {
        if (self.sessionContextThrows) {
          throw new Error("test session context failure");
        }
        return self.manager;
      },
    } as unknown as ExtensionContext;
  })();

  async #emit(type: string, event: object): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const handler of this.#handlers.get(type) ?? []) {
      results.push(await handler(event as never, this.context));
    }
    return results;
  }

  /** Pi semantics: entries persist first, then turn_end fires. */
  async endTurn(entryCount = 1): Promise<void> {
    for (let index = 0; index < entryCount; index += 1) {
      this.manager.appendEntry();
    }
    await this.#emit("turn_end", { type: "turn_end" });
  }

  async executeUserBash(
    command: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const event = {
      type: "user_bash",
      command,
      excludeFromContext: false,
      cwd: this.manager.getCwd(),
    };
    // Pi stops at the first user_bash handler that returns a result.
    let intercepted = false;
    for (const handler of this.#handlers.get("user_bash") ?? []) {
      const result = await handler(event as never, this.context);
      if (typeof result === "object" && result !== null && "result" in result) {
        intercepted = true;
        break;
      }
    }
    if (!intercepted) await operation();
    // Pi records both real and extension-provided bash results.
    this.manager.appendEntry({
      type: "message",
      message: { role: "assistant" },
    });
  }

  async submitInput(text = "test"): Promise<"continued" | "handled"> {
    const results = await this.#emit("input", {
      type: "input",
      text,
      images: [],
      source: "interactive",
      streamingBehavior: undefined,
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
      message: { role: "user", content: text },
    });
    if (this.failUserMessagePersistence) {
      throw new Error("test user-message persistence failure");
    }
    this.manager.appendEntry({
      type: "message",
      message: { role: "user" },
    });
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
          message: { role: "custom", content },
        });
      } finally {
        this.idle = wasIdle;
      }
    }
    return this.manager.appendEntry({
      type: "message",
      message: { role: "custom", content },
    }).id;
  }

  /** Emit only preflight input, simulating a later host validation failure. */
  async preflightInput(text = "test"): Promise<"continued" | "handled"> {
    const results = await this.#emit("input", {
      type: "input",
      text,
      images: [],
      source: "interactive",
      streamingBehavior: undefined,
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
    thinkingLevel?: string,
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
      model: { provider, id: modelId },
      previousModel: undefined,
      source: "set",
    });
    return {
      modelId: model.id,
      ...(thinking === undefined ? {} : { thinkingId: thinking.id }),
    };
  }

  async selectThinkingLevel(level: string): Promise<string> {
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

  async compact(): Promise<"done" | "cancelled"> {
    const before = await this.#emit("session_before_compact", {
      type: "session_before_compact",
      preparation: {},
      branchEntries: [],
      reason: "manual",
      willRetry: false,
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
    const compactionEntry = this.manager.appendEntry({ type: "compaction" });
    await this.#emit("session_compact", {
      type: "session_compact",
      compactionEntry,
    });
    return "done";
  }

  async startSession(
    reason: "startup" | "reload" | "new" | "resume" | "fork",
    previousSessionFile?: string,
  ): Promise<void> {
    await this.#emit("session_start", {
      type: "session_start",
      reason,
      previousSessionFile,
    });
  }

  newDetachedSession(cwd: string = this.cwd): FakeSessionManager {
    return this.#newManager(null, cwd);
  }

  newInMemorySession(cwd: string = this.cwd): FakeSessionManager {
    this.#nextSession += 1;
    return new FakeSessionManager(`memory-${this.#nextSession}`, null, cwd);
  }

  async resumeTo(target: FakeSessionManager): Promise<"done" | "cancelled"> {
    const before = await this.#emit("session_before_switch", {
      type: "session_before_switch",
      reason: "resume",
      targetSessionFile: target.getSessionFile(),
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
    const previous = this.manager;
    await this.#emit("session_shutdown", {
      type: "session_shutdown",
      reason: "resume",
      targetSessionFile: target.getSessionFile(),
    });
    this.manager = target;
    await this.startSession("resume", previous.getSessionFile());
    return "done";
  }

  async navigate(targetId: string): Promise<"done" | "cancelled"> {
    const oldLeafId = this.manager.getLeafId();
    const before = await this.#emit("session_before_tree", {
      type: "session_before_tree",
      preparation: { targetId, oldLeafId },
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
      preparation: { targetId, oldLeafId },
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
    withLabel = false,
  ): Promise<string> {
    const oldLeafId = this.manager.getLeafId();
    const target = this.manager.getEntry(targetId);
    const effectiveTarget =
      target?.type === "custom_message" ||
      (target?.type === "message" && target.message?.role === "user")
        ? target.parentId
        : targetId;
    const id = `summary-${this.manager.entries.size + 1}`;
    const entry: FakeEntry = {
      id,
      parentId: effectiveTarget,
      timestamp: new Date().toISOString(),
      type: "branch_summary",
    };
    this.manager.entries.set(id, entry);
    this.manager.setLeaf(id);
    let newLeafId = id;
    if (withLabel) {
      const labelId = `label-${this.manager.entries.size + 1}`;
      const label: FakeEntry = {
        id: labelId,
        parentId: id,
        timestamp: new Date().toISOString(),
        type: "label",
      };
      this.manager.entries.set(labelId, label);
      this.manager.setLeaf(labelId);
      newLeafId = labelId;
    }
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

  async fork(entryId: string): Promise<"done" | "cancelled"> {
    const before = await this.#emit("session_before_fork", {
      type: "session_before_fork",
      entryId,
      position: "at",
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
    const previous = this.manager;
    const next = this.#newManager(previous.getSessionFile() ?? null);
    await this.#emit("session_shutdown", {
      type: "session_shutdown",
      reason: "fork",
      targetSessionFile: next.getSessionFile(),
    });
    for (const entry of previous.entries.values()) {
      next.entries.set(entry.id, entry);
    }
    next.setLeaf(entryId);
    this.manager = next;
    await this.startSession("fork", previous.getSessionFile());
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
      FakePi.#live.delete(this);
    }
  }
}
