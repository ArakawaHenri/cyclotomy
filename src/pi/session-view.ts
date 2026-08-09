import type {
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

/**
 * Thin read-only view over Pi's session manager, narrowed to what the
 * checkpointer needs. This adapter is compiled and tested against the Pi API;
 * an incompatible host must fail at registration rather than silently
 * degrading checkpoint semantics.
 */
export interface SessionView {
  readonly sessionId: string;
  readonly cwd: string;
  readonly sessionFile: string | null;
  /** Persisted by Pi for forked sessions; survives extension/process reloads. */
  readonly parentSessionFile: string | null;
  readonly leafId: string | null;
  /** undefined: entry unknown; null: entry exists and has no parent. */
  parentIdOf(entryId: string): string | null | undefined;
  entryOf(entryId: string): SessionEntry | undefined;
  /** Entry discriminator used to authenticate Pi-created wrapper leaves. */
  entryTypeOf(entryId: string): string | undefined;
  /** Pi lands user/custom-message selections at their parent editor point. */
  navigationLandingId(entryId: string): string | null | undefined;
}

export function readSessionView(context: ExtensionContext): SessionView {
  const manager = context.sessionManager;
  return {
    sessionId: manager.getSessionId(),
    cwd: manager.getCwd(),
    sessionFile: manager.getSessionFile() ?? null,
    parentSessionFile: manager.getHeader()?.parentSession ?? null,
    leafId: manager.getLeafId(),
    parentIdOf(entryId) {
      return manager.getEntry(entryId)?.parentId;
    },
    entryOf(entryId) {
      return manager.getEntry(entryId);
    },
    entryTypeOf(entryId) {
      return manager.getEntry(entryId)?.type;
    },
    navigationLandingId(entryId) {
      const entry = manager.getEntry(entryId);
      if (entry === undefined) {
        return undefined;
      }
      const usesParent =
        entry.type === "custom_message" ||
        (entry.type === "message" && entry.message.role === "user");
      return usesParent ? entry.parentId : entry.id;
    },
  };
}
