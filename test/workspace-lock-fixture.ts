import { open } from "node:fs/promises";
import { join } from "node:path";
import { loadNativeFileLock } from "../src/infrastructure/native-file-lock.ts";

export async function testWorkspaceLockIsHeld(
  storeRoot: string,
): Promise<boolean> {
  const file = await open(join(storeRoot, "workspace.lock"), "r+");
  try {
    const binding = await loadNativeFileLock();
    if (!binding.tryAcquire(file.fd)) return true;
    binding.release(file.fd);
    return false;
  } finally {
    await file.close();
  }
}

export async function assertTestWorkspaceLockReleased(
  storeRoot: string,
): Promise<void> {
  if (await testWorkspaceLockIsHeld(storeRoot)) {
    throw new Error(`workspace lock is still held at ${storeRoot}`);
  }
}
