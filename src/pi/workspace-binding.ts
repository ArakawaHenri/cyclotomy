import {
  assertDirectoryStillBound,
  bindDirectory,
  sameDirectoryBinding,
  type DirectoryBinding,
} from "../infrastructure/directory-binding.ts";

export type WorkspaceBinding = DirectoryBinding;

/**
 * Bind Pi's effective and persisted workspace paths to one directory object.
 * Comparing both observations with the same identity prevents two individually
 * true checks from being spliced across a symlink rebound.
 */
export async function bindSessionWorkspace(
  cwd: string,
  sessionCwd: string,
): Promise<WorkspaceBinding> {
  const [effective, persisted] = await Promise.all([
    bindDirectory(cwd, "Pi workspace"),
    bindDirectory(sessionCwd, "Pi workspace"),
  ]);
  if (!sameDirectoryBinding(effective, persisted)) {
    throw new Error("Pi opened this session outside its persisted workspace");
  }
  return effective;
}

/** Re-observe both Pi paths against one previously bound directory object. */
export async function sessionWorkspaceStillBound(
  binding: WorkspaceBinding,
  cwd: string,
  sessionCwd: string,
): Promise<boolean> {
  try {
    const [effective, persisted] = await Promise.all([
      bindDirectory(cwd, "Pi workspace"),
      bindDirectory(sessionCwd, "Pi workspace"),
    ]);
    return (
      sameDirectoryBinding(binding, effective) &&
      sameDirectoryBinding(binding, persisted)
    );
  } catch {
    return false;
  }
}

/**
 * Final synchronous authority gate. Callers must enter their synchronous
 * metadata transaction immediately after this check, without an intervening
 * await. Cooperative workspace locks cover Cyclotomy writers; the duplicate
 * path observation closes ordinary alias rebound and delete/recreate races.
 */
export function assertSessionWorkspaceStillBound(
  binding: WorkspaceBinding,
  cwd: string,
  sessionCwd: string,
): void {
  for (const path of [cwd, sessionCwd]) {
    assertDirectoryStillBound(binding, path, "Pi workspace");
  }
}
