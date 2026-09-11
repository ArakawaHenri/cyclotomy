import { inspectWorkspaceLock } from "../src/infrastructure/workspace-lock.ts";

/**
 * Assert that no cooperative operation currently holds a store's native lock.
 * The persistent lock file is expected to remain; only its exclusivity matters.
 */
export async function assertTestWorkspaceLockReleased(
  storeRoot: string,
): Promise<void> {
  const diagnostic = await inspectWorkspaceLock(storeRoot);
  if (diagnostic.kind !== "native-acquired") {
    throw new Error(
      `expected a released workspace lock at ${storeRoot}, observed ${diagnostic.kind}`,
    );
  }
}
