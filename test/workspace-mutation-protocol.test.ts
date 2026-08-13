import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { prepareWorkspaceMutationLease } from "../src/application/mutation-lease.ts";
import type { RestoreOutcome } from "../src/application/restore.ts";
import { createCurrentTreeManifest } from "../src/infrastructure/tree-formats/current.ts";
import { scanWorkspace } from "../src/infrastructure/workspace-scan.ts";
import {
  WorkspaceMutationProtocol,
  type WorkspaceMutationProtocolAuthority,
} from "../src/pi/workspace-mutation-protocol.ts";
import { ALL_MANAGED_SCOPE } from "./workspace-scope-fixture.ts";

const outcome = {
  kind: "restored",
  treeOid: "a".repeat(64),
  report: {
    created: [],
    updated: [],
    deleted: [],
    renamed: [],
    unchangedCount: 1,
    problems: [],
  },
} satisfies RestoreOutcome;
const exactProtection = {
  kind: "exact-slot",
  slot: { kind: "blocked-missing" },
  admission: { kind: "settled" },
} as const;
const settledCleanup = { kind: "settled" } as const;

describe("workspace mutation protocol recovery", () => {
  it("preserves a no-write execution when queue cleanup later fails", async () => {
    const recover = vi.fn();
    const runtime = {
      recoverUncertainLocation: recover,
    } as unknown as WorkspaceMutationProtocolAuthority;
    const protocol = new WorkspaceMutationProtocol(runtime, {} as never, () => {
      throw new Error("unused");
    });

    const release = new Error("release");
    await expect(
      protocol.recoverAfterWorkspaceFailure(
        release,
        {
          kind: "outcome",
          outcome,
          cutover: { kind: "not-requested" },
          stagingCleanup: settledCleanup,
          workspaceLockCleanup: settledCleanup,
        },
        { kind: "failed", cause: release },
      ),
    ).resolves.toEqual({
      kind: "outcome",
      outcome,
      cutover: { kind: "not-requested" },
      stagingCleanup: settledCleanup,
      workspaceLockCleanup: { kind: "failed", cause: release },
    });
    expect(recover).not.toHaveBeenCalled();
  });

  it("preserves a rejected no-write execution when queue cleanup later fails", async () => {
    const recover = vi.fn();
    const runtime = {
      recoverUncertainLocation: recover,
    } as unknown as WorkspaceMutationProtocolAuthority;
    const protocol = new WorkspaceMutationProtocol(runtime, {} as never, () => {
      throw new Error("unused");
    });
    const rejection = new Error("Pi became busy");
    const release = new Error("release");

    await expect(
      protocol.recoverAfterWorkspaceFailure(
        release,
        {
          kind: "outcome",
          outcome: { kind: "failed", stage: "apply", cause: rejection },
          cutover: { kind: "rejected", cause: rejection },
          stagingCleanup: settledCleanup,
          workspaceLockCleanup: settledCleanup,
        },
        { kind: "failed", cause: release },
      ),
    ).resolves.toEqual({
      kind: "outcome",
      outcome: { kind: "failed", stage: "apply", cause: rejection },
      cutover: { kind: "rejected", cause: rejection },
      stagingCleanup: settledCleanup,
      workspaceLockCleanup: { kind: "failed", cause: release },
    });
    expect(recover).not.toHaveBeenCalled();
  });

  it("returns a rejected cutover without manufacturing post-mutation recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyclotomy-protocol-ws-"));
    const storeRoot = await mkdtemp(
      join(tmpdir(), "cyclotomy-protocol-store-"),
    );
    try {
      const path = join(root, "current.txt");
      await writeFile(path, "current");
      const rejection = new Error("Pi became busy");
      const recover = vi.fn(async () => "blocked" as const);
      const authority = {
        restoreDependencies: () => ({
          store: {
            storageRoot: storeRoot,
            readTreeManifest: async () =>
              createCurrentTreeManifest([], ALL_MANAGED_SCOPE),
            verifyBlobs: async () => undefined,
          },
          validateManifestScope: async () => undefined,
        }),
        prepareLocationMutation: () =>
          prepareWorkspaceMutationLease(() => {
            throw rejection;
          }),
        recoverUncertainLocation: recover,
      } as unknown as WorkspaceMutationProtocolAuthority;
      const protocol = new WorkspaceMutationProtocol(
        authority,
        {} as never,
        () => {
          throw new Error("unused");
        },
      );
      const resolution = {
        treeOid: "b".repeat(64),
        foundAt: { sessionId: "s", entryId: "e" },
      };

      await expect(
        protocol.restoreLocation({
          expected: { cwd: root } as never,
          node: resolution.foundAt,
          resolution,
          current: await scanWorkspace(root),
        }),
      ).resolves.toEqual({
        kind: "outcome",
        outcome: { kind: "failed", stage: "apply", cause: rejection },
        cutover: { kind: "rejected", cause: rejection },
        stagingCleanup: settledCleanup,
        workspaceLockCleanup: settledCleanup,
      });
      expect(await readFile(path, "utf8")).toBe("current");
      expect(recover).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it("recovers an explicitly authorized execution after queue release fails", async () => {
    const recover = vi.fn(async () => ({
      protection: { kind: "session-barrier" as const },
      workspaceLockCleanup: settledCleanup,
    }));
    const runtime = {
      recoverUncertainLocation: recover,
    } as unknown as WorkspaceMutationProtocolAuthority;
    const protocol = new WorkspaceMutationProtocol(runtime, {} as never, () => {
      throw new Error("unused");
    });
    const cause = new Error("release");

    await expect(
      protocol.recoverAfterWorkspaceFailure(
        cause,
        {
          kind: "outcome",
          outcome,
          cutover: {
            kind: "authorized",
            pinnedResolution: {
              treeOid: "a".repeat(64),
              foundAt: { sessionId: "s", entryId: "e" },
            },
          },
          stagingCleanup: settledCleanup,
          workspaceLockCleanup: settledCleanup,
        },
        { kind: "failed", cause },
      ),
    ).resolves.toEqual({
      kind: "post-mutation-conflict",
      reason: "control-failed",
      outcome,
      cause,
      arrivalProtection: { kind: "session-barrier" },
      workspaceLockCleanup: { kind: "failed", cause },
    });
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it("preserves an established exact protection when lock cleanup later fails", async () => {
    const recover = vi.fn(async () => ({
      protection: {
        kind: "unavailable" as const,
        cause: new Error("retry"),
      },
      workspaceLockCleanup: settledCleanup,
    }));
    const runtime = {
      recoverUncertainLocation: recover,
    } as unknown as WorkspaceMutationProtocolAuthority;
    const protocol = new WorkspaceMutationProtocol(runtime, {} as never, () => {
      throw new Error("unused");
    });
    const primary = new Error("cutover");
    const release = new Error("release");

    await expect(
      protocol.recoverAfterWorkspaceFailure(
        release,
        {
          kind: "post-mutation-conflict",
          reason: "control-failed",
          outcome,
          cause: primary,
          arrivalProtection: exactProtection,
          workspaceLockCleanup: { kind: "settled" },
        },
        { kind: "failed", cause: release },
      ),
    ).resolves.toEqual({
      kind: "post-mutation-conflict",
      reason: "control-failed",
      outcome,
      cause: primary,
      arrivalProtection: exactProtection,
      workspaceLockCleanup: { kind: "failed", cause: release },
    });
    expect(recover).not.toHaveBeenCalled();
  });
});
