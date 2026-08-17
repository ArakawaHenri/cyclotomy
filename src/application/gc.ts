import { collectGarbage, type GcReport } from "../infrastructure/object-gc.ts";
import type { CurrentMetadataStore } from "../infrastructure/metadata.ts";
import type { NativeObjectStore } from "../infrastructure/object-store.ts";
import type { WorkspaceWriteAuthority } from "../infrastructure/workspace-lock.ts";

export interface CyclotomyGcOptions {
  readonly now?: number;
  readonly objectGraceMs?: number;
}

/**
 * Collect only objects that are already unreferenced by durable metadata.
 *
 * Pi intentionally permits a live persisted session to have no JSONL file
 * until its first assistant response. File absence therefore is not a session
 * lifetime proof and cannot authorize automatic deletion of registrations,
 * checkpoint slots, or capture barriers. A future metadata-pruning feature
 * needs an explicit cross-process lifetime authority, not another filesystem
 * probe.
 */
export async function collectCyclotomyGarbage(
  authority: WorkspaceWriteAuthority,
  store: NativeObjectStore,
  metadata: Pick<CurrentMetadataStore, "listReferencedTreeOids">,
  options: CyclotomyGcOptions = {},
): Promise<GcReport> {
  return collectGarbage(authority, store, metadata, {
    ...(options.objectGraceMs === undefined
      ? {}
      : { graceMs: options.objectGraceMs }),
    now: options.now ?? Date.now(),
  });
}
