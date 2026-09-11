/**
 * Minimal ambient surface for the prebuilt-only native lock dependency. Only
 * the whole-file exclusive lock operations are declared; the package ships
 * prebuilds for the supported platforms and is loaded dynamically so a missing
 * binary degrades to read-only diagnostics instead of failing module load.
 */
declare module "fs-native-extensions" {
  export interface FileLockOptions {
    readonly shared?: boolean;
  }

  export function tryLock(
    fd: number,
    offset?: number,
    length?: number,
    options?: FileLockOptions,
  ): boolean;

  export function unlock(fd: number, offset?: number, length?: number): void;
}
