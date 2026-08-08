import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type {
  FakeEntry,
  FakeNotification,
} from "./fake-pi.ts";

type Handler = (
  event: never,
  context: ExtensionContext,
) => Promise<unknown>;

type ExtensionFactory = (pi: ExtensionAPI) => void;

/**
 * A fork split into the same two phases Pi uses internally. Keeping the
 * phases public lets tests prove that the hand-off survives destruction of
 * the old extension runtime instead of accidentally relying on a closure.
 */
export interface ReloadingForkPlan {
  readonly previousManager: ReloadingFakeSessionManager;
  readonly nextManager: ReloadingFakeSessionManager;
  readonly previousSessionFile: string;
  readonly targetSessionFile: string;
}

export class ReloadingFakeSessionManager {
  readonly entries = new Map<string, FakeEntry>();
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly cwd: string;
  readonly parentSessionFile: string | null;
  #leafId: string | null = null;
  #counter = 0;

  constructor(
    sessionId: string,
    sessionFile: string,
    cwd: string,
    branch: readonly FakeEntry[] = [],
    parentSessionFile: string | null = null,
  ) {
    this.sessionId = sessionId;
    this.sessionFile = sessionFile;
    this.cwd = cwd;
    this.parentSessionFile = parentSessionFile;
    for (const entry of branch) {
      this.entries.set(entry.id, entry);
      this.#leafId = entry.id;
    }
  }

  appendEntry(): FakeEntry {
    this.#counter += 1;
    const entry: FakeEntry = {
      id: `${this.sessionId}-e${this.#counter}`,
      parentId: this.#leafId,
      timestamp: new Date().toISOString(),
      type: "message",
      message: { role: "assistant" },
    };
    this.entries.set(entry.id, entry);
    this.#leafId = entry.id;
    return entry;
  }

  setLeaf(entryId: string): void {
    if (!this.entries.has(entryId)) {
      throw new Error(`unknown entry ${entryId}`);
    }
    this.#leafId = entryId;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getSessionFile(): string {
    return this.sessionFile;
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

  /** Return only the root-to-leaf path, matching Pi's branched session. */
  branchTo(leafId: string | null): FakeEntry[] {
    const reversed: FakeEntry[] = [];
    let cursor = leafId;
    while (cursor !== null) {
      const entry = this.entries.get(cursor);
      if (entry === undefined) {
        throw new Error(`unknown entry ${cursor}`);
      }
      reversed.push(entry);
      cursor = entry.parentId;
    }
    return reversed.reverse();
  }
}

/**
 * Minimal Pi host whose fork lifecycle tears down and re-registers the
 * extension. Unlike FakePi, it deliberately does not retain any handlers,
 * commands, or extension closures across a session replacement.
 */
export class ReloadingFakePi {
  static readonly #live = new Set<ReloadingFakePi>();

  /** Finish every host created by the current test before its files are removed. */
  static async disposeAll(): Promise<void> {
    const settled = await Promise.allSettled(
      [...ReloadingFakePi.#live].map((pi) => pi.dispose()),
    );
    const failures = settled.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "failed to dispose reloading fake Pi hosts",
      );
    }
  }

  readonly notifications: FakeNotification[] = [];
  readonly cwd: string;
  manager: ReloadingFakeSessionManager;
  factoryLoads = 0;
  hasUI = true;

  #handlers = new Map<string, Handler[]>();
  #commands = new Map<
    string,
    (args: string, context: ExtensionContext) => Promise<void>
  >();
  #nextSession = 0;
  #disposed = false;
  readonly #factory: ExtensionFactory;
  #api!: ExtensionAPI;
  #context!: ExtensionContext;

  constructor(
    cwd: string,
    factory: ExtensionFactory,
    initialManager?: ReloadingFakeSessionManager,
  ) {
    this.cwd = cwd;
    this.#factory = factory;
    if (initialManager === undefined) {
      this.manager = this.#newManager();
    } else {
      this.manager = initialManager;
      const sequence = /^s(\d+)$/u.exec(initialManager.sessionId)?.[1];
      this.#nextSession = sequence === undefined ? 0 : Number(sequence);
    }
    this.#loadExtension();
    ReloadingFakePi.#live.add(this);
  }

  #newManager(
    branch: readonly FakeEntry[] = [],
    parentSessionFile: string | null = null,
  ): ReloadingFakeSessionManager {
    this.#nextSession += 1;
    return new ReloadingFakeSessionManager(
      `s${this.#nextSession}`,
      `/sessions/s${this.#nextSession}.jsonl`,
      this.cwd,
      branch,
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
      on(event: string, handler: Handler) {
        const list = self.#handlers.get(event) ?? [];
        list.push(handler);
        self.#handlers.set(event, list);
      },
      registerCommand(
        name: string,
        definition: {
          handler: (
            args: string,
            context: ExtensionContext,
          ) => Promise<void>;
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
        self.notifications.push({ message, level });
      },
      setStatus(): void {},
      async select(
        _title: string,
        options: readonly string[],
      ): Promise<string | undefined> {
        return options[1];
      },
    };
    return {
      cwd: self.cwd,
      get hasUI() {
        return self.hasUI;
      },
      ui,
      isIdle: () => true,
      get sessionManager() {
        return self.manager;
      },
    } as unknown as ExtensionContext;
  }

  #loadExtension(): void {
    this.factoryLoads += 1;
    this.#api = this.#createApi();
    this.#context = this.#createContext();
    this.#factory(this.#api);
  }

  async #emit(type: string, event: object): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const handler of this.#handlers.get(type) ?? []) {
      results.push(await handler(event as never, this.context));
    }
    return results;
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

  /** Recreate the extension runner using Pi's /reload event order. */
  async reloadExtension(): Promise<void> {
    await this.#emit("session_shutdown", {
      type: "session_shutdown",
      reason: "reload",
    });
    this.#handlers = new Map();
    this.#commands = new Map();
    this.#loadExtension();
    await this.startSession("reload");
  }

  /** Pi semantics: entries persist first, then turn_end fires. */
  async endTurn(entryCount = 1): Promise<void> {
    for (let index = 0; index < entryCount; index += 1) {
      this.manager.appendEntry();
    }
    await this.#emit("turn_end", { type: "turn_end" });
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
    this.manager.setLeaf(targetId);
    await this.#emit("session_tree", {
      type: "session_tree",
      newLeafId: this.manager.getLeafId(),
      oldLeafId,
    });
    return "done";
  }

  /**
   * Run session_before_fork and construct Pi's destination branch, but leave
   * the old extension runtime alive until finishForkReload() is called.
   */
  async beginFork(
    entryId: string,
    position: "before" | "at",
  ): Promise<ReloadingForkPlan | "cancelled"> {
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
    if (selected === undefined) {
      throw new Error(`unknown entry ${entryId}`);
    }
    const targetLeafId = position === "at" ? entryId : selected.parentId;
    const previousManager = this.manager;
    const nextManager = this.#newManager(
      previousManager.branchTo(targetLeafId),
      previousManager.getSessionFile(),
    );
    return {
      previousManager,
      nextManager,
      previousSessionFile: previousManager.getSessionFile(),
      targetSessionFile: nextManager.getSessionFile(),
    };
  }

  /**
   * Shut down and discard the old runtime without starting the destination.
   * This split exposes Pi's process-crash window between teardown and reload.
   */
  async shutdownForkRuntime(plan: ReloadingForkPlan): Promise<void> {
    if (this.manager !== plan.previousManager) {
      throw new Error("fork plan no longer belongs to the active session");
    }
    await this.#emit("session_shutdown", {
      type: "session_shutdown",
      reason: "fork",
      targetSessionFile: plan.targetSessionFile,
    });

    this.#handlers = new Map();
    this.#commands = new Map();
  }

  /**
   * Complete the destructive half of a fork: shutdown, discard the entire
   * old runtime, register a fresh extension instance, then start the fork.
   */
  async finishForkReload(plan: ReloadingForkPlan): Promise<void> {
    await this.shutdownForkRuntime(plan);
    this.manager = plan.nextManager;
    this.#loadExtension();
    await this.startSession("fork", plan.previousSessionFile);
  }

  async fork(
    entryId: string,
    position: "before" | "at",
  ): Promise<"done" | "cancelled"> {
    const plan = await this.beginFork(entryId, position);
    if (plan === "cancelled") {
      return "cancelled";
    }
    await this.finishForkReload(plan);
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
      ReloadingFakePi.#live.delete(this);
    }
  }
}
