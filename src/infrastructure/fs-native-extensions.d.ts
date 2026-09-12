/** Whole-file locking from the dependency's prebuilt native binding. */
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
