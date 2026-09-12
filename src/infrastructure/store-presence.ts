import { lstatSync, opendirSync } from "node:fs";
import { join } from "node:path";

import { systemErrorCode } from "./system-error.ts";

/** Empty layout directories are allowed; one file is enough to prove data exists. */
function storedObjectsPresent(root: string): boolean {
  function visit(path: string, depth: number): boolean {
    let entry;
    try {
      entry = lstatSync(path);
    } catch (cause) {
      if (systemErrorCode(cause) === "ENOENT") return false;
      throw cause;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink() || depth > 3)
      return true;
    const directory = opendirSync(path);
    try {
      for (
        let child = directory.readSync();
        child !== null;
        child = directory.readSync()
      ) {
        if (!child.isDirectory() || visit(join(path, child.name), depth + 1))
          return true;
      }
      return false;
    } finally {
      directory.closeSync();
    }
  }
  return visit(join(root, "objects"), 0);
}

/** A GC receipt also proves a metadata store previously existed. */
export function storedHistoryPresent(root: string): boolean {
  try {
    lstatSync(join(root, "gc-state.json"));
    return true;
  } catch (cause) {
    if (systemErrorCode(cause) !== "ENOENT") throw cause;
  }
  return storedObjectsPresent(root);
}
