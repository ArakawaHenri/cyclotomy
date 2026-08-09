import type { MetadataStore } from "../src/infrastructure/metadata.ts";

/** Seed a node through the same guarded commit API used by production. */
export function commitTestNodeState(
  store: MetadataStore,
  sessionId: string,
  entryId: string,
  treeOid: string,
): void {
  const result = store.commitNodeState(sessionId, entryId, treeOid);
  if (result !== "committed") {
    throw new Error(
      `failed to seed test node state ${JSON.stringify(`${sessionId}/${entryId}`)}: ${result}`,
    );
  }
}
