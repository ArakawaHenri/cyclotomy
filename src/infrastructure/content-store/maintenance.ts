import { constants, type Stats } from "node:fs";
import {
  lstat,
  open,
  opendir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";

import {
  isNativeObjectShard,
  nativeLooseRecordNamespacePath,
  nativeLooseRecordShardPath,
  nativeObjectEntry,
  nativeObjectNamespacePath,
  nativeObjectShardPath,
  type NativeLooseRecordKind,
  type NativeObjectKind,
  type NativeObjectLayout,
} from "../workspace-store.ts";
import { primaryFailure, withRetainedCleanup } from "../failure-settlement.ts";
import { systemErrorCode } from "../system-error.ts";
import {
  assertWorkspaceWriteAuthority,
  type WorkspaceWriteAuthority,
} from "../workspace-lock.ts";
import {
  openPrivateFileIfPresent,
  observePrivateFile as observeStablePrivateFile,
  observePrivateFileIfPresent as observeStablePrivateFileIfPresent,
  privateFileIdentity as fileIdentity,
  PrivateFileBoundaryError,
  revalidateOpenedPrivateFile,
  sameFileObservation as sameObservation,
  type OpenedPrivateFile,
  type PrivateFileIdentity as FileIdentity,
} from "./private-file.ts";

export type MaintenanceObjectKind =
  "legacy-blob" | "loose-structural" | "loose-content" | "loose-recipe";

export interface MaintenanceObject {
  readonly kind: MaintenanceObjectKind;
  readonly logicalId: string | undefined;
  readonly temporary: boolean;
  readonly byteLength: number;
  readonly modifiedAt: number;
}

export interface MaintenanceInventory {
  readonly objects: readonly MaintenanceObject[];
}

export type MaintenanceErrorCode =
  "invalid-input" | "namespace-invalid" | "limit-exceeded" | "storage-failure";

export class ObjectStoreMaintenanceError extends Error {
  readonly code: MaintenanceErrorCode;

  constructor(code: MaintenanceErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ObjectStoreMaintenanceError";
    this.code = code;
  }
}

interface DirectoryIdentity {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}

interface ObjectReceipt {
  readonly identity: FileIdentity;
  readonly parents: readonly DirectoryIdentity[];
}

interface InventoryReceipt {
  readonly owner: object;
  readonly objects: ReadonlyMap<MaintenanceObject, ObjectReceipt>;
}

const inventoryReceipts = new WeakMap<MaintenanceInventory, InventoryReceipt>();

function fail(
  code: MaintenanceErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new ObjectStoreMaintenanceError(code, message, cause);
}

function rethrowMaintenancePrimary(
  primary: unknown,
  failure: unknown,
  fallbackMessage: string,
): never {
  if (primary instanceof ObjectStoreMaintenanceError) {
    if (primary === failure) throw primary;
    fail(primary.code, primary.message, failure);
  }
  fail("storage-failure", fallbackMessage, failure);
}

function rethrowPrivateFileFailure(
  failure: unknown,
  fallbackMessage: string,
): never {
  const primary = primaryFailure(failure);
  if (primary instanceof PrivateFileBoundaryError) {
    fail(primary.code, primary.message, failure);
  }
  rethrowMaintenancePrimary(primary, failure, fallbackMessage);
}

async function withDeterministicCleanup<T>(
  action: () => Promise<T>,
  cleanup: () => Promise<void>,
  message: string,
): Promise<T> {
  try {
    return await withRetainedCleanup(action, cleanup, message);
  } catch (error) {
    const primary = primaryFailure(error);
    if (primary instanceof PrivateFileBoundaryError) {
      fail(primary.code, primary.message, error);
    }
    rethrowMaintenancePrimary(primary, error, message);
  }
}

async function observeDirectory(path: string): Promise<Stats> {
  let observation: Stats;
  try {
    observation = await lstat(path);
  } catch (error) {
    fail("storage-failure", `could not inspect directory ${path}`, error);
  }
  if (observation.isSymbolicLink() || !observation.isDirectory()) {
    fail("namespace-invalid", `${path} is not a real directory`);
  }
  return observation;
}

function directoryIdentity(
  path: string,
  observation: Stats,
): DirectoryIdentity {
  return Object.freeze({
    path,
    dev: observation.dev,
    ino: observation.ino,
  });
}

async function assertDirectoryIdentity(
  expected: DirectoryIdentity,
): Promise<void> {
  const current = await observeDirectory(expected.path);
  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    fail("namespace-invalid", `${expected.path} changed after inventory`);
  }
}

async function directoryNames(
  path: string,
  maximum: number,
): Promise<readonly string[]> {
  const before = await observeDirectory(path);
  const names: string[] = [];
  try {
    const directory = await opendir(path);
    await withDeterministicCleanup(
      async () => {
        for await (const entry of directory) {
          if (names.length >= maximum) {
            fail(
              "limit-exceeded",
              `${path} exceeds its ${maximum}-entry inventory limit`,
            );
          }
          names.push(entry.name);
        }
      },
      async () => {
        await directory.close().catch((error: unknown) => {
          if (systemErrorCode(error) !== "ERR_DIR_CLOSED") throw error;
        });
      },
      `${path} inventory and cleanup both failed`,
    );
  } catch (error) {
    rethrowMaintenancePrimary(
      primaryFailure(error),
      error,
      `could not inventory directory ${path}`,
    );
  }
  const after = await observeDirectory(path);
  if (!sameObservation(before, after)) {
    fail("namespace-invalid", `${path} changed while it was inventoried`);
  }
  return Object.freeze(names.sort());
}

async function observePrivateFile(path: string): Promise<Stats> {
  try {
    return (await observeStablePrivateFile(path)).observation;
  } catch (error) {
    rethrowPrivateFileFailure(error, `could not inspect object ${path}`);
  }
}

async function openInventoriedFile(
  identity: FileIdentity,
): Promise<OpenedPrivateFile> {
  try {
    const opened = await openPrivateFileIfPresent(identity.path, identity);
    if (opened === undefined) {
      fail("namespace-invalid", `${identity.path} disappeared before open`);
    }
    return opened;
  } catch (error) {
    rethrowPrivateFileFailure(
      error,
      `could not validate opened object ${identity.path}`,
    );
  }
}

async function syncDirectory(
  storeRoot: string,
  path: string,
  authority: WorkspaceWriteAuthority,
): Promise<void> {
  if (process.platform === "win32") return;
  let handle: FileHandle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY |
        (constants.O_DIRECTORY ?? 0) |
        (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    fail("storage-failure", `could not open directory ${path}`, error);
  }
  try {
    await withDeterministicCleanup(
      async () => {
        if (!(await handle.stat()).isDirectory()) {
          fail("namespace-invalid", `${path} stopped being a directory`);
        }
        assertWorkspaceWriteAuthority(authority, storeRoot);
        await handle.sync();
      },
      () => handle.close(),
      `${path} synchronization and cleanup both failed`,
    );
  } catch (error) {
    rethrowMaintenancePrimary(
      primaryFailure(error),
      error,
      `could not synchronize directory ${path}`,
    );
  }
}

function maintenanceKind(
  kind: NativeObjectKind | NativeLooseRecordKind,
): MaintenanceObjectKind {
  switch (kind) {
    case "blob":
      return "legacy-blob";
    case "tree":
      return "loose-structural";
    case "content":
      return "loose-content";
    case "recipe":
      return "loose-recipe";
  }
}

/**
 * Exact physical receipts used only by the exclusive GC/compaction authority.
 * Reachability, grace periods, and pack policy deliberately stay outside.
 */
export class ObjectStoreMaintenance {
  readonly #layout: NativeObjectLayout;
  readonly #owner = Object.freeze({});

  constructor(layout: NativeObjectLayout) {
    this.#layout = layout;
  }

  async inventory(maximumObjects: number): Promise<MaintenanceInventory> {
    if (!Number.isSafeInteger(maximumObjects) || maximumObjects <= 0) {
      fail("invalid-input", "maximum object count must be positive");
    }
    const root = await observeDirectory(this.#layout.root);
    const objects = await observeDirectory(this.#layout.objects);
    if (objects.dev !== root.dev) {
      fail("namespace-invalid", "objects directory crosses a device boundary");
    }
    const objectNames = await directoryNames(this.#layout.objects, 5);
    const expectedObjectNames = ["blobs", "packs", "records", "trees"];
    if (
      objectNames.length !== expectedObjectNames.length ||
      objectNames.some((name, index) => name !== expectedObjectNames[index])
    ) {
      fail(
        "namespace-invalid",
        "objects directory contains an unexpected namespace",
      );
    }
    const records = await observeDirectory(this.#layout.records);
    if (records.dev !== objects.dev) {
      fail("namespace-invalid", "records directory crosses a device boundary");
    }
    const recordNames = await directoryNames(this.#layout.records, 3);
    if (
      recordNames.length !== 2 ||
      recordNames[0] !== "content" ||
      recordNames[1] !== "recipe"
    ) {
      fail(
        "namespace-invalid",
        "records directory contains an unexpected namespace",
      );
    }

    const found: MaintenanceObject[] = [];
    const receipts = new Map<MaintenanceObject, ObjectReceipt>();
    const rootParents = [
      directoryIdentity(this.#layout.root, root),
      directoryIdentity(this.#layout.objects, objects),
    ];
    const inventoryOne = async (
      kind: NativeObjectKind | NativeLooseRecordKind,
      namespacePath: string,
      shardPath: (shard: string) => string,
    ): Promise<void> => {
      const namespace = await observeDirectory(namespacePath);
      if (namespace.dev !== objects.dev) {
        fail("namespace-invalid", `${namespacePath} crosses a device boundary`);
      }
      const namespaceParents = [
        ...rootParents,
        ...(kind === "content" || kind === "recipe"
          ? [directoryIdentity(this.#layout.records, records)]
          : []),
        directoryIdentity(namespacePath, namespace),
      ];
      for (const shard of await directoryNames(namespacePath, 257)) {
        if (!isNativeObjectShard(shard)) {
          fail("namespace-invalid", `unexpected shard ${shard}`);
        }
        const shardDirectory = shardPath(shard);
        const shardObservation = await observeDirectory(shardDirectory);
        if (shardObservation.dev !== namespace.dev) {
          fail(
            "namespace-invalid",
            `${shardDirectory} crosses a device boundary`,
          );
        }
        const parents = [
          ...namespaceParents,
          directoryIdentity(shardDirectory, shardObservation),
        ];
        const remaining = maximumObjects - found.length;
        if (remaining <= 0) {
          fail(
            "limit-exceeded",
            `object inventory exceeds the ${maximumObjects}-candidate limit`,
          );
        }
        for (const name of await directoryNames(
          shardDirectory,
          remaining + 1,
        )) {
          if (found.length >= maximumObjects) {
            fail(
              "limit-exceeded",
              `object inventory exceeds the ${maximumObjects}-candidate limit`,
            );
          }
          const entry = nativeObjectEntry(shard, name);
          if (entry === undefined) {
            fail("namespace-invalid", `unexpected object name ${name}`);
          }
          const path = join(shardDirectory, name);
          const observation = await observePrivateFile(path);
          if (observation.dev !== shardObservation.dev) {
            fail("namespace-invalid", `${path} crosses a device boundary`);
          }
          const object = Object.freeze({
            kind: maintenanceKind(kind),
            logicalId: entry.kind === "object" ? entry.oid : undefined,
            temporary: entry.kind === "temporary",
            byteLength: observation.size,
            modifiedAt: observation.mtimeMs,
          });
          found.push(object);
          receipts.set(object, {
            identity: fileIdentity(path, observation),
            parents: Object.freeze(parents),
          });
        }
      }
    };

    await inventoryOne(
      "blob",
      nativeObjectNamespacePath(this.#layout, "blob"),
      (shard) => nativeObjectShardPath(this.#layout, "blob", shard),
    );
    await inventoryOne(
      "tree",
      nativeObjectNamespacePath(this.#layout, "tree"),
      (shard) => nativeObjectShardPath(this.#layout, "tree", shard),
    );
    await inventoryOne(
      "content",
      nativeLooseRecordNamespacePath(this.#layout, "content"),
      (shard) => nativeLooseRecordShardPath(this.#layout, "content", shard),
    );
    await inventoryOne(
      "recipe",
      nativeLooseRecordNamespacePath(this.#layout, "recipe"),
      (shard) => nativeLooseRecordShardPath(this.#layout, "recipe", shard),
    );

    const result = Object.freeze({ objects: Object.freeze(found) });
    inventoryReceipts.set(result, {
      owner: this.#owner,
      objects: receipts,
    });
    return result;
  }

  async readObject(
    inventory: MaintenanceInventory,
    object: MaintenanceObject,
    maximumBytes: number,
  ): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
      fail("invalid-input", "maximum read bytes must be non-negative");
    }
    const receipt = this.#receipt(inventory, object);
    if (receipt.identity.size > maximumBytes) {
      fail(
        "limit-exceeded",
        `${receipt.identity.path} exceeds its ${maximumBytes}-byte read limit`,
      );
    }
    for (const parent of receipt.parents) await assertDirectoryIdentity(parent);
    const opened = await openInventoriedFile(receipt.identity);
    return await withDeterministicCleanup(
      async () => {
        const bytes = Buffer.allocUnsafe(opened.observation.size);
        let offset = 0;
        while (offset < bytes.byteLength) {
          const read = await opened.handle.read(
            bytes,
            offset,
            bytes.byteLength - offset,
            offset,
          );
          if (read.bytesRead === 0) {
            fail("namespace-invalid", "object was truncated while reading");
          }
          offset += read.bytesRead;
        }
        const probe = Buffer.allocUnsafe(1);
        if ((await opened.handle.read(probe, 0, 1, offset)).bytesRead !== 0) {
          fail("namespace-invalid", "object grew while reading");
        }
        await revalidateOpenedPrivateFile(opened);
        return Uint8Array.from(bytes);
      },
      () => opened.handle.close(),
      "object read and cleanup both failed",
    );
  }

  async removeObject(
    inventory: MaintenanceInventory,
    object: MaintenanceObject,
    authority: WorkspaceWriteAuthority,
  ): Promise<number> {
    const receipt = this.#receipt(inventory, object);
    for (const parent of receipt.parents) await assertDirectoryIdentity(parent);
    const current = await observePrivateFile(receipt.identity.path);
    if (!sameObservation(receipt.identity, current)) {
      fail(
        "namespace-invalid",
        `${receipt.identity.path} changed before removal`,
      );
    }
    // All asynchronous namespace checks are complete.  The caller's
    // cooperative authority must be revalidated synchronously immediately
    // before the unlink is issued.
    assertWorkspaceWriteAuthority(authority, this.#layout.root);
    try {
      await unlink(receipt.identity.path);
    } catch (error) {
      fail(
        "storage-failure",
        `could not remove ${receipt.identity.path}`,
        error,
      );
    }
    await syncDirectory(
      this.#layout.root,
      receipt.parents.at(-1)!.path,
      authority,
    );
    return receipt.identity.size;
  }

  /** Recheck one opaque receipt before GC crosses its first-delete fence. */
  async objectIdentityStillCurrent(
    inventory: MaintenanceInventory,
    object: MaintenanceObject,
  ): Promise<boolean> {
    const receipt = this.#receipt(inventory, object);
    for (const parent of receipt.parents) await assertDirectoryIdentity(parent);
    try {
      const current = await observeStablePrivateFileIfPresent(
        receipt.identity.path,
      );
      return (
        current !== undefined &&
        sameObservation(receipt.identity, current.observation)
      );
    } catch (error) {
      rethrowPrivateFileFailure(
        error,
        `could not revalidate ${receipt.identity.path}`,
      );
    }
  }

  #receipt(
    inventory: MaintenanceInventory,
    object: MaintenanceObject,
  ): ObjectReceipt {
    const receipt = inventoryReceipts.get(inventory);
    if (receipt === undefined || receipt.owner !== this.#owner) {
      fail("invalid-input", "inventory does not belong to this maintainer");
    }
    const candidate = receipt.objects.get(object);
    if (candidate === undefined) {
      fail("invalid-input", "object does not belong to this inventory");
    }
    return candidate;
  }
}
