import { DatabaseSync } from "node:sqlite";

import {
  createCurrentMetadataStore,
  type CurrentMetadataStore,
  type MetadataSessionIdentity,
  type ProtectLocationResult,
} from "../src/infrastructure/metadata.ts";
import type { WorkspaceWriteAuthority } from "../src/infrastructure/workspace-lock.ts";
import { runWithWorkspaceLock } from "../src/infrastructure/workspace-lock.ts";

interface TestMetadataWriteAuthorityBinding {
  readonly authority: WorkspaceWriteAuthority;
  readonly storeRoot: string;
}

const writeAuthorities = new WeakMap<
  MetadataFixtureStore,
  TestMetadataWriteAuthorityBinding
>();

export function bindTestMetadataWriteAuthority(
  store: MetadataFixtureStore,
  authority: WorkspaceWriteAuthority,
  storeRoot: string,
): void {
  writeAuthorities.set(store, { authority, storeRoot });
}

export function testMetadataWriteAuthority(
  store: MetadataFixtureStore,
): WorkspaceWriteAuthority {
  const binding = writeAuthorities.get(store);
  if (binding === undefined) {
    throw new Error("test metadata store has no workspace write authority");
  }
  return binding.authority;
}

export function testMetadataWriteAuthorityBinding(
  store: MetadataFixtureStore,
): TestMetadataWriteAuthorityBinding {
  const binding = writeAuthorities.get(store);
  if (binding === undefined) {
    throw new Error("test metadata store has no workspace write authority");
  }
  return binding;
}

export async function withTestMetadataWriteAuthority<T>(
  storeRoot: string,
  store: MetadataFixtureStore,
  operation: () => T,
): Promise<T> {
  const execution = await runWithWorkspaceLock(
    storeRoot,
    "test metadata mutation",
    async (authority) => {
      bindTestMetadataWriteAuthority(store, authority, storeRoot);
      return operation();
    },
  );
  if (execution.kind === "action-failed") throw execution.cause;
  if (execution.cleanup.kind === "failed") throw execution.cleanup.cause;
  return execution.value;
}

export async function createTestCurrentMetadataStore(
  path: string,
  storeRoot: string,
): Promise<CurrentMetadataStore> {
  const execution = await runWithWorkspaceLock(
    storeRoot,
    "test metadata open",
    async (authority) => createCurrentMetadataStore(path, authority),
  );
  if (execution.kind === "action-failed") throw execution.cause;
  if (execution.cleanup.kind === "failed") throw execution.cleanup.cause;
  return execution.value;
}

const sessionFilesByStore = new WeakMap<
  MetadataFixtureStore,
  Map<string, string>
>();

function rememberedSessionFile(
  store: MetadataFixtureStore,
  sessionId: string,
): string | undefined {
  return sessionFilesByStore.get(store)?.get(sessionId);
}

export function rememberTestSession(
  store: MetadataFixtureStore,
  sessionId: string,
  sessionFile: string,
): void {
  let sessionFiles = sessionFilesByStore.get(store);
  if (sessionFiles === undefined) {
    sessionFiles = new Map();
    sessionFilesByStore.set(store, sessionFiles);
  }
  sessionFiles.set(sessionId, sessionFile);
}

export function registerTestSession(
  store: MetadataFixtureStore,
  sessionId: string,
  sessionFile?: string,
  retainedEntryIds: readonly string[] = [],
  activeAncestryEntryIds: readonly string[] = retainedEntryIds,
): void {
  const resolvedSessionFile =
    sessionFile ??
    rememberedSessionFile(store, sessionId) ??
    `/test-sessions/${encodeURIComponent(sessionId)}.jsonl`;
  store.finalizeSessionProjection(testMetadataWriteAuthority(store), {
    targetSessionId: sessionId,
    targetSessionFile: resolvedSessionFile,
    retainedEntryIds,
    activeAncestryEntryIds,
    seed: { kind: "fresh" },
  });
  rememberTestSession(store, sessionId, resolvedSessionFile);
}

export function finalizeTestSessionProjection(
  store: MetadataFixtureStore,
  input: Parameters<CurrentMetadataStore["finalizeSessionProjection"]>[1],
): ReturnType<CurrentMetadataStore["finalizeSessionProjection"]> {
  const binding = testMetadataWriteAuthorityBinding(store);
  return store.finalizeSessionProjection(
    binding.authority,
    input,
    input.seed.kind === "fork" ? binding : undefined,
  );
}

/** Seed a node through the same guarded commit API used by production. */
export function commitTestNodeState(
  store: MetadataFixtureStore,
  sessionId: string,
  entryId: string,
  treeOid: string,
  sessionFile?: string,
): void {
  let registeredFile = sessionFile ?? rememberedSessionFile(store, sessionId);
  if (registeredFile === undefined) {
    registerTestSession(store, sessionId, undefined, [entryId]);
    registeredFile = rememberedSessionFile(store, sessionId);
  }
  if (registeredFile === undefined)
    throw new Error("test fixture lost session");
  const result = store.commitCapture(testMetadataWriteAuthority(store), {
    identity: { sessionId, sessionFile: registeredFile },
    entryId,
    activeAncestryEntryIds: [entryId],
    treeOid,
    expectedSlot: store.getCheckpointSlot(sessionId, entryId),
  });
  if (result !== "committed") {
    throw new Error(
      `failed to seed test node state ${JSON.stringify(`${sessionId}/${entryId}`)}: ${result}`,
    );
  }
}

export function checkpointState(
  store: MetadataFixtureStore,
  sessionId: string,
  entryId: string,
): { readonly treeOid: string } | undefined {
  const slot = store.getCheckpointSlot(sessionId, entryId);
  return slot.kind === "open-checkpoint" || slot.kind === "blocked-checkpoint"
    ? { treeOid: slot.treeOid }
    : undefined;
}

export function checkpointIsBlocked(
  store: MetadataFixtureStore,
  sessionId: string,
  entryId: string,
): boolean {
  const slot = store.getCheckpointSlot(sessionId, entryId);
  return slot.kind === "blocked-missing" || slot.kind === "blocked-checkpoint";
}

export function protectTestLocation(
  store: MetadataFixtureStore,
  identity: MetadataSessionIdentity,
  entryId: string,
  activeAncestryEntryIds: readonly string[] = [entryId],
): ProtectLocationResult {
  return store.protectLocation(testMetadataWriteAuthority(store), {
    identity,
    entryId,
    activeAncestryEntryIds,
    expectation: { kind: "any-current" },
  });
}

export function captureBarrier(
  store: MetadataFixtureStore,
  sessionId: string,
  sessionFile: string,
): boolean | undefined {
  return store.hasSessionBarrier({ sessionId, sessionFile });
}

export interface TestSessionRegistration {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly captureBarrier: boolean;
  readonly registrationState: "pending" | "verified";
}

export function readTestSessionRegistrations(
  path: string,
): readonly TestSessionRegistration[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT registry.session_id, registry.session_file,
                registry.registration_state,
                EXISTS(
                  SELECT 1 FROM session_capture_barrier AS barrier
                  WHERE barrier.session_id = registry.session_id
                ) AS capture_barrier
         FROM session_registry AS registry
         ORDER BY registry.session_id`,
      )
      .all() as unknown as {
      readonly session_id: string;
      readonly session_file: string;
      readonly registration_state: "pending" | "verified";
      readonly capture_barrier: 0 | 1;
    }[];
    return rows.map((row) => {
      if (
        (row.capture_barrier !== 0 && row.capture_barrier !== 1) ||
        (row.registration_state !== "pending" &&
          row.registration_state !== "verified")
      ) {
        throw new Error("invalid session registration fixture row");
      }
      return {
        sessionId: row.session_id,
        sessionFile: row.session_file,
        captureBarrier: row.capture_barrier === 1,
        registrationState: row.registration_state,
      };
    });
  } finally {
    db.close();
  }
}

export function readTestSessionRegistration(
  path: string,
  sessionId: string,
): TestSessionRegistration | undefined {
  return readTestSessionRegistrations(path).find(
    (registration) => registration.sessionId === sessionId,
  );
}

type MetadataFixtureStore = Pick<
  CurrentMetadataStore,
  | "commitCapture"
  | "finalizeSessionProjection"
  | "getCheckpointSlot"
  | "hasSessionBarrier"
  | "protectLocation"
>;
