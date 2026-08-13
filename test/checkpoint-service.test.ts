import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CheckpointService,
  type CheckpointSessionView,
} from "../src/application/checkpoint-service.ts";
import { createCurrentMetadataStore } from "../src/infrastructure/metadata.ts";
import { openObjectStore } from "../src/infrastructure/object-store.ts";
import { scanWorkspace } from "../src/infrastructure/workspace-scan.ts";
import {
  commitTestNodeState,
  registerTestSession,
} from "./metadata-fixture.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function sessionView(
  cwd: string,
  leafId: string,
  parents: Readonly<Record<string, string | null>>,
  transparentCoordinates: Readonly<Record<string, string | null>> = {},
): CheckpointSessionView {
  return {
    sessionId: "session",
    cwd,
    leafId,
    stableCoordinateId(entryId = leafId) {
      if (entryId === null) return null;
      if (!Object.hasOwn(parents, entryId)) return undefined;
      return Object.hasOwn(transparentCoordinates, entryId)
        ? transparentCoordinates[entryId]
        : entryId;
    },
    stableAncestryIds(entryId = leafId) {
      if (entryId === null) return [];
      if (!Object.hasOwn(parents, entryId)) return undefined;
      const reversed: string[] = [];
      let current: string | null = entryId;
      while (current !== null) {
        reversed.push(current);
        current = parents[current] ?? null;
      }
      return reversed.reverse();
    },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cyclotomy-checkpoint-service-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const storeRoot = join(root, "store");
  await mkdir(workspace);
  const store = await openObjectStore(storeRoot);
  const metadata = createCurrentMetadataStore(join(storeRoot, "state.db"));
  const workspaceRoot = await realpath(workspace);
  const service = new CheckpointService({
    store,
    metadata,
    expectedRootPath: workspaceRoot,
    validateManifestScope: async () => {},
  });
  return { metadata, service, workspace: workspaceRoot };
}

describe("CheckpointService capture boundary", () => {
  it("owns both current and observed capture preparation", async () => {
    const { metadata, service, workspace } = await fixture();
    const view = sessionView(workspace, "leaf", { leaf: null });
    const current = await service.prepareCurrent(view);
    if (!current.ok) {
      throw "cause" in current.error
        ? current.error.cause
        : new Error(current.error.kind);
    }
    expect(current).toMatchObject({ ok: true });

    const snapshot = await scanWorkspace(workspace);
    const observed = await service.prepareObserved(snapshot);
    expect(observed.ok).toBe(true);
    metadata.close();
  });

  it("surfaces an unreadable nearest checkpoint without falling back", async () => {
    const { metadata, service, workspace } = await fixture();
    const parentTree = "a".repeat(64);
    const leafTree = "b".repeat(64);
    registerTestSession(metadata, "session", undefined, ["parent"]);
    commitTestNodeState(metadata, "session", "parent", parentTree);
    commitTestNodeState(metadata, "session", "leaf", leafTree);
    const view = sessionView(workspace, "leaf", {
      parent: null,
      leaf: "parent",
    });
    const leaf = { sessionId: "session", entryId: "leaf" } as const;

    expect(service.resolve(view, leaf)).toEqual({
      treeOid: leafTree,
      foundAt: leaf,
    });
    await expect(service.resolveReadableTree(view, leaf)).rejects.toMatchObject(
      {
        code: "missing-object",
      },
    );
    metadata.close();
  });

  it("commits only the exact active stable coordinate", async () => {
    const { metadata, service, workspace } = await fixture();
    const sessionFile = join(workspace, "session.jsonl");
    registerTestSession(
      metadata,
      "session",
      sessionFile,
      ["inactive", "parent", "leaf"],
      ["parent", "leaf"],
    );
    const view = sessionView(
      workspace,
      "label",
      {
        parent: null,
        leaf: "parent",
        label: "leaf",
        inactive: "parent",
      },
      { label: "leaf" },
    );
    const prepared = await service.prepareCurrent(view);
    if (!prepared.ok) {
      throw "cause" in prepared.error
        ? prepared.error.cause
        : new Error(prepared.error.kind);
    }
    expect(prepared).toMatchObject({ ok: true });
    const authority = {
      expectedSessionFile: sessionFile,
      assertWorkspaceAuthority: () => undefined,
    };
    const committed = service.commitPrepared(
      view,
      { sessionId: "session", entryId: "leaf" },
      prepared.value,
      metadata.getCheckpointSlot("session", "leaf"),
      authority,
    );
    if (!committed.ok) {
      throw "cause" in committed.error
        ? committed.error.cause
        : new Error(
            `${committed.error.kind}:${"reason" in committed.error ? committed.error.reason : ""}`,
          );
    }
    expect(committed).toMatchObject({ ok: true });
    expect(() =>
      service.commitPrepared(
        view,
        { sessionId: "session", entryId: "parent" },
        prepared.value,
        metadata.getCheckpointSlot("session", "parent"),
        authority,
      ),
    ).toThrow(/active stable coordinate/u);
    expect(() =>
      service.commitMissing(
        view,
        { sessionId: "session", entryId: "parent" },
        prepared.value,
        "initialize-fresh",
        authority,
      ),
    ).toThrow(/active stable coordinate/u);
    expect(() =>
      service.commitPrepared(
        view,
        { sessionId: "session", entryId: "inactive" },
        prepared.value,
        metadata.getCheckpointSlot("session", "inactive"),
        authority,
      ),
    ).toThrow(/active stable coordinate/u);
    metadata.close();

    const arrival = await fixture();
    const arrivalSessionFile = join(arrival.workspace, "arrival.jsonl");
    registerTestSession(
      arrival.metadata,
      "session",
      arrivalSessionFile,
      ["inactive", "parent"],
      ["parent"],
    );
    const arrivalView = sessionView(arrival.workspace, "label", {
      parent: null,
      label: "parent",
      inactive: null,
    });
    const arrivalPrepared = await arrival.service.prepareCurrent(arrivalView);
    if (!arrivalPrepared.ok) throw new Error(arrivalPrepared.error.kind);
    expect(
      arrival.service.commitPreparedTreeArrival(
        arrivalView,
        { sessionId: "session", entryId: "parent" },
        arrivalPrepared.value,
        arrival.metadata.getCheckpointSlot("session", "parent"),
        {
          expectedSessionFile: arrivalSessionFile,
          assertWorkspaceAuthority: () => undefined,
        },
      ),
    ).toMatchObject({ ok: true });
    expect(() =>
      arrival.service.commitPreparedTreeArrival(
        arrivalView,
        { sessionId: "session", entryId: "inactive" },
        arrivalPrepared.value,
        arrival.metadata.getCheckpointSlot("session", "inactive"),
        {
          expectedSessionFile: arrivalSessionFile,
          assertWorkspaceAuthority: () => undefined,
        },
      ),
    ).toThrow(/active stable ancestry/u);
    arrival.metadata.close();
  });
});
