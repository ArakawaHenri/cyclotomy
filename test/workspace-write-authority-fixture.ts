import { runWithWorkspaceLock } from "../src/infrastructure/workspace-lock.ts";
import type { WorkspaceWriteAuthority } from "../src/infrastructure/workspace-lock.ts";

interface HeldTestAuthority {
  readonly authority: WorkspaceWriteAuthority;
  readonly release: () => void;
  readonly execution: Promise<void>;
}

const held = new Set<HeldTestAuthority>();
const heldByStoreRoot = new Map<string, WorkspaceWriteAuthority>();

/** Hold one real action-scoped authority until the owning test releases it. */
export async function holdTestWorkspaceWriteAuthority(
  storeRoot: string,
): Promise<WorkspaceWriteAuthority> {
  const existing = heldByStoreRoot.get(storeRoot);
  if (existing !== undefined) return existing;
  let grant!: (authority: WorkspaceWriteAuthority) => void;
  let rejectGrant!: (cause: unknown) => void;
  const granted = new Promise<WorkspaceWriteAuthority>((resolve, reject) => {
    grant = resolve;
    rejectGrant = reject;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const execution = runWithWorkspaceLock(
    storeRoot,
    "test metadata write authority",
    async (authority) => {
      grant(authority);
      await released;
    },
  ).then((outcome) => {
    if (outcome.kind === "action-failed") throw outcome.cause;
    if (outcome.cleanup.kind === "failed") throw outcome.cleanup.cause;
  });
  void execution.catch(rejectGrant);
  const authority = await granted;
  held.add({ authority, release, execution });
  heldByStoreRoot.set(storeRoot, authority);
  return authority;
}

export async function releaseTestWorkspaceWriteAuthorities(): Promise<void> {
  const active = [...held];
  held.clear();
  heldByStoreRoot.clear();
  for (const authority of active) authority.release();
  await Promise.all(active.map(({ execution }) => execution));
}
