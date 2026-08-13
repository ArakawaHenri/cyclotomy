import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  nativeObjectStoreLayout,
  openObjectStore,
  type NativeObjectStore,
  type ObjectStore,
} from "../src/infrastructure/object-store.ts";
import {
  nativeObjectEntry,
  nativeObjectLayout,
  nativeObjectPath,
  nativeTemporaryObjectName,
} from "../src/infrastructure/workspace-store.ts";

describe("native object layout", () => {
  it("keeps migration and cross-store import off the generic store surface", () => {
    const assertGenericSurface = (generic: ObjectStore): void => {
      // @ts-expect-error Native migration requires an authenticated CAS.
      generic.upgradeTree("0".repeat(64), "future");
      // @ts-expect-error Cross-store import is a native capability.
      generic.importTreesFrom({} as NativeObjectStore, []);
    };
    const assertImportAdmission = (
      target: NativeObjectStore,
      source: NativeObjectStore,
    ): void => {
      // @ts-expect-error Cross-store import requires an explicit admission policy.
      target.importTreesFrom(source, []);
      // @ts-expect-error Snapshot quota cannot be omitted from admission.
      target.importTreesFrom(source, [], {
        validateImportedTree: async () => ({ kind: "accepted" }),
      });
    };
    void assertGenericSurface;
    void assertImportAdmission;
    expect(true).toBe(true);
  });

  it("preserves the published paths and recognizes only canonical entries", () => {
    const root = join(tmpdir(), "store");
    const layout = nativeObjectLayout(root);
    const oid = `aa${"b".repeat(62)}`;
    expect(layout).toEqual({
      root,
      objects: join(root, "objects"),
      blobs: join(root, "objects", "blobs"),
      trees: join(root, "objects", "trees"),
    });
    expect(nativeObjectPath(layout, "blob", oid)).toBe(
      join(root, "objects", "blobs", "aa", "b".repeat(62)),
    );
    expect(nativeObjectEntry("aa", "b".repeat(62))).toEqual({
      kind: "object",
      oid,
    });
    expect(
      nativeObjectEntry(
        "aa",
        nativeTemporaryObjectName(
          oid,
          42,
          "00000000-0000-4000-8000-000000000000",
        ),
      ),
    ).toEqual({ kind: "temporary" });
    expect(nativeObjectEntry("aa", "not-an-object")).toBeUndefined();
  });

  it("does not treat a structurally asserted generic store as native", async () => {
    const targetRoot = await mkdtemp(
      join(tmpdir(), "cyclotomy-native-target-"),
    );
    try {
      const target = await openObjectStore(targetRoot);
      // Simulate untyped JavaScript crossing the public runtime boundary.
      const generic = { storageRoot: targetRoot } as NativeObjectStore;
      await expect(
        target.importTreesFrom(generic, [], {
          validateImportedTree: async () => ({ kind: "accepted" }),
          maxSnapshotBytes: Number.MAX_SAFE_INTEGER,
        }),
      ).rejects.toMatchObject({
        code: "storage-failure",
        message: "tree import requires a native Cyclotomy object store",
      });
    } finally {
      await rm(targetRoot, { recursive: true, force: true });
    }
  });

  it("keeps native provenance and layout outside the reflective object surface", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-native-private-"));
    try {
      const store = await openObjectStore(root);
      const layout = nativeObjectStoreLayout(store, "test");
      expect(Object.isFrozen(layout)).toBe(true);
      expect(Reflect.ownKeys(store)).not.toContain("objectLayout");
      expect(Object.getOwnPropertySymbols(store)).toEqual([]);
      expect(
        Object.getOwnPropertySymbols(Object.getPrototypeOf(store)),
      ).toEqual([]);

      const proxy = new Proxy(store, {});
      expect(() => nativeObjectStoreLayout(proxy, "test")).toThrow(
        "requires a native Cyclotomy object store",
      );
      expect(() =>
        Object.defineProperty(store, "storageRoot", { value: "/tampered" }),
      ).toThrow();
      expect(store.storageRoot).toBe(root);
      expect(nativeObjectStoreLayout(store, "test")).toBe(layout);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
