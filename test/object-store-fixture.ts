import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  NativeObjectStore,
  ObjectStore,
  SnapshotPublication,
  TreeImportAdmission,
} from "../src/infrastructure/object-store.ts";
import { withOrderedWorkspaceLocks } from "../src/infrastructure/workspace-lock.ts";
import type { TreeEntry } from "../src/infrastructure/tree-formats/manifest-codec.ts";
import type { WorkspaceScope } from "../src/infrastructure/workspace-scope.ts";

function digest(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function importTestTrees(
  target: NativeObjectStore,
  source: NativeObjectStore,
  treeOids: readonly string[],
  admission: TreeImportAdmission,
  options: { readonly signal?: AbortSignal } = {},
): Promise<void> {
  const targetRoot = await realpath(target.storageRoot);
  return await withOrderedWorkspaceLocks(
    [source, target].map(({ storageRoot }) => ({
      storeRoot: storageRoot,
      options,
    })),
    "test tree import",
    (authorities) =>
      target.importTreesFrom(source, treeOids, admission, {
        writeAuthority: authorities.get(targetRoot)!,
        ...options,
      }),
  );
}

async function withSourceDirectory<T>(
  action: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "cyclotomy-test-source-"));
  try {
    return await action(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Seed one authenticated blob through the same file-bound publication API. */
export async function publishTestBlob(
  store: ObjectStore,
  content: Uint8Array,
): Promise<string> {
  const publication = store.beginSnapshotPublication();
  try {
    return await publishTestBlobInPublication(publication, content);
  } finally {
    await publication.close();
  }
}

/** Publish fixture bytes inside a caller-owned snapshot boundary. */
export function publishTestBlobInPublication(
  publication: SnapshotPublication,
  content: Uint8Array,
): Promise<string> {
  return withSourceDirectory(async (directory) => {
    const source = join(directory, "blob");
    await writeFile(source, content);
    return publication.publishBlobFromFile(
      source,
      digest(content),
      content.byteLength,
    );
  });
}

/**
 * Seed a tree after rebinding every referenced blob to a fresh source file.
 * This helper deliberately exposes no direct object-store publication bypass.
 */
export function publishTestTree(
  store: ObjectStore,
  entries: readonly TreeEntry[],
  scope: WorkspaceScope,
): Promise<string> {
  return withSourceDirectory(async (directory) => {
    const publication = store.beginSnapshotPublication();
    try {
      const published = new Set<string>();
      let sourceIndex = 0;
      for (const entry of entries) {
        if (entry.type !== "regular" || published.has(entry.blobOid)) {
          continue;
        }
        const content = await store.readBlob(entry.blobOid);
        const source = join(directory, `${sourceIndex}.blob`);
        sourceIndex += 1;
        await writeFile(source, content);
        await publication.publishBlobFromFile(
          source,
          entry.blobOid,
          content.byteLength,
        );
        published.add(entry.blobOid);
      }
      return await publication.publishTree(entries, scope);
    } finally {
      await publication.close();
    }
  });
}
