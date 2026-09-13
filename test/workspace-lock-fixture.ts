import { join } from "node:path";
import { loadNativeFileLock } from "../src/infrastructure/native-file-lock.ts";

export async function testWorkspaceLockIsHeld(
  storeRoot: string,
): Promise<boolean> {
  const binding = await loadNativeFileLock();
  const file = binding.open(join(storeRoot, "workspace.lock"));
  try {
    if (!file.tryLock()) return true;
    file.unlock();
    return false;
  } finally {
    file.close();
  }
}

export async function assertTestWorkspaceLockReleased(
  storeRoot: string,
): Promise<void> {
  if (await testWorkspaceLockIsHeld(storeRoot)) {
    throw new Error(`workspace lock is still held at ${storeRoot}`);
  }
}
