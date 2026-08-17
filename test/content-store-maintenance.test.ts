import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { contentIdFromBytes } from "../src/infrastructure/content-store/ids.ts";
import {
  ObjectStoreMaintenance,
  ObjectStoreMaintenanceError,
} from "../src/infrastructure/content-store/maintenance.ts";
import {
  nativeObjectLayout,
  nativeObjectPath,
} from "../src/infrastructure/workspace-store.ts";
import {
  withWorkspaceLock,
  WorkspaceLockOwnershipLostError,
} from "../src/infrastructure/workspace-lock.ts";

const roots: string[] = [];

async function fileHandlePrototype(root: string): Promise<{
  readonly stat: FileHandle["stat"];
}> {
  const path = join(root, "file-handle-probe");
  const probe = await open(path, "w");
  const prototype = Object.getPrototypeOf(probe) as {
    readonly stat: FileHandle["stat"];
  };
  await probe.close();
  await unlink(path);
  return prototype;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("object-store maintenance", () => {
  it("names objects/trees as the current loose structural representation", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-maintenance-kind-"));
    roots.push(root);
    const layout = nativeObjectLayout(root);
    await Promise.all([
      mkdir(layout.blobs, { recursive: true }),
      mkdir(layout.trees, { recursive: true }),
      mkdir(layout.contentRecords, { recursive: true }),
      mkdir(layout.recipeRecords, { recursive: true }),
      mkdir(layout.incomingPacks, { recursive: true }),
    ]);
    const legacyBlob = Buffer.from("legacy blob representation", "utf8");
    const structural = Buffer.from("current structural representation", "utf8");
    const legacyBlobId = contentIdFromBytes(legacyBlob);
    const structuralId = contentIdFromBytes(structural);
    const legacyBlobPath = nativeObjectPath(layout, "blob", legacyBlobId);
    const structuralPath = nativeObjectPath(layout, "tree", structuralId);
    await Promise.all([
      mkdir(dirname(legacyBlobPath), { recursive: true }),
      mkdir(dirname(structuralPath), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(legacyBlobPath, legacyBlob, { mode: 0o600 }),
      writeFile(structuralPath, structural, { mode: 0o600 }),
    ]);

    const inventory = await new ObjectStoreMaintenance(layout).inventory(10);

    expect(inventory.objects).toEqual([
      expect.objectContaining({
        kind: "legacy-blob",
        logicalId: legacyBlobId,
        temporary: false,
      }),
      expect.objectContaining({
        kind: "loose-structural",
        logicalId: structuralId,
        temporary: false,
      }),
    ]);
  });

  it("checks destructive authority after revalidation and before unlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-maintenance-gate-"));
    roots.push(root);
    const layout = nativeObjectLayout(root);
    await Promise.all([
      mkdir(layout.blobs, { recursive: true }),
      mkdir(layout.trees, { recursive: true }),
      mkdir(layout.contentRecords, { recursive: true }),
      mkdir(layout.recipeRecords, { recursive: true }),
      mkdir(layout.incomingPacks, { recursive: true }),
    ]);
    const bytes = Buffer.from("destructive authority gate", "utf8");
    const contentId = contentIdFromBytes(bytes);
    const path = nativeObjectPath(layout, "blob", contentId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { mode: 0o600 });

    const maintenance = new ObjectStoreMaintenance(layout);
    const inventory = await maintenance.inventory(10);
    const object = inventory.objects.find(
      (candidate) => candidate.logicalId === contentId,
    );
    if (object === undefined) throw new Error("inventoried object is missing");
    await expect(
      withWorkspaceLock(
        layout.root,
        "maintenance lost-authority test",
        async (authority) => {
          const lockPath = join(layout.root, "workspace.lock");
          const displaced = join(layout.root, "displaced-workspace-lock");
          await rename(lockPath, displaced);
          try {
            return await withWorkspaceLock(
              layout.root,
              "maintenance successor test",
              async () =>
                await maintenance.removeObject(inventory, object, authority),
            );
          } finally {
            await rename(displaced, lockPath);
          }
        },
      ),
    ).rejects.toBeInstanceOf(WorkspaceLockOwnershipLostError);
    await expect(readFile(path)).resolves.toEqual(bytes);
  });

  it("retains a classified read failure when object cleanup also fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-maintenance-"));
    roots.push(root);
    const layout = nativeObjectLayout(root);
    await Promise.all([
      mkdir(layout.blobs, { recursive: true }),
      mkdir(layout.trees, { recursive: true }),
      mkdir(layout.contentRecords, { recursive: true }),
      mkdir(layout.recipeRecords, { recursive: true }),
      mkdir(layout.incomingPacks, { recursive: true }),
    ]);
    const bytes = Buffer.from("maintenance cleanup evidence", "utf8");
    const contentId = contentIdFromBytes(bytes);
    const path = nativeObjectPath(layout, "blob", contentId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { mode: 0o600 });

    const maintenance = new ObjectStoreMaintenance(layout);
    const inventory = await maintenance.inventory(10);
    const object = inventory.objects.find(
      (candidate) => candidate.logicalId === contentId,
    );
    if (object === undefined) throw new Error("inventoried object is missing");

    const prototype = await fileHandlePrototype(root);
    const originalStat = prototype.stat;
    const primary = new ObjectStoreMaintenanceError(
      "namespace-invalid",
      "injected post-read validation failure",
    );
    const cleanup = new Error("injected maintenance close failure");
    let statCalls = 0;
    let closeCalls = 0;
    vi.spyOn(prototype, "stat").mockImplementation(async function (
      this: FileHandle,
    ) {
      statCalls += 1;
      if (statCalls === 2) {
        const originalClose = this.close;
        Object.defineProperty(this, "close", {
          configurable: true,
          enumerable: true,
          writable: true,
          value: async (): Promise<void> => {
            closeCalls += 1;
            await originalClose.call(this);
            throw cleanup;
          },
        });
        throw primary;
      }
      return await originalStat.call(this);
    });

    let failure: unknown;
    try {
      await maintenance.readObject(inventory, object, bytes.byteLength);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      name: "ObjectStoreMaintenanceError",
      code: "namespace-invalid",
      cause: expect.any(AggregateError),
    });
    const aggregate = (failure as ObjectStoreMaintenanceError)
      .cause as AggregateError;
    expect(aggregate.errors).toEqual([primary, cleanup]);
    expect(statCalls).toBe(2);
    expect(closeCalls).toBe(1);
  });
});
