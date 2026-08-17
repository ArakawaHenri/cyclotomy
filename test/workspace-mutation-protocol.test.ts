import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { prepareWorkspaceMutationLease } from "../src/application/mutation-lease.ts";
import type { RestoreOutcome } from "../src/application/restore.ts";
import { createCurrentTreeManifest } from "../src/infrastructure/tree-formats/current.ts";
import type { WorkspaceWriteAuthority } from "../src/infrastructure/workspace-lock.ts";
import { scanWorkspace } from "../src/infrastructure/workspace-scan.ts";
import {
  WorkspaceMutationProtocol,
  type WorkspaceMutationProtocolAuthority,
} from "../src/pi/workspace-mutation-protocol.ts";
import { ALL_MANAGED_SCOPE } from "./workspace-scope-fixture.ts";
import type { SessionView } from "../src/pi/session-view.ts";

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
const writeAuthority = {} as WorkspaceWriteAuthority;
const settledCleanup = { kind: "settled" } as const;

describe("workspace mutation protocol recovery", () => {
  it.each(["not-requested", "rejected"] as const)(
    "does not rewrite a %s no-write execution after cleanup failure",
    (cutoverKind) => {
      const protocol = new WorkspaceMutationProtocol(
        {} as WorkspaceMutationProtocolAuthority,
        {} as never,
      );
      const cause = new Error("release");
      const cutover =
        cutoverKind === "rejected"
          ? ({ kind: "rejected", cause } as const)
          : ({ kind: "not-requested" } as const);

      expect(
        protocol.recoveryExecutionAfterCleanupFailure(
          {
            kind: "outcome",
            outcome,
            cutover,
            preparationCleanup: settledCleanup,
          },
          cause,
        ),
      ).toBeUndefined();
    },
  );

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
          validateManifestScope: async () => ({ gitVersion: null }),
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
        protocol.restoreLocation(
          {
            expected: { cwd: root } as never,
            node: resolution.foundAt,
            resolution,
            current: await scanWorkspace(root),
          },
          writeAuthority,
        ),
      ).resolves.toEqual({
        kind: "outcome",
        outcome: { kind: "failed", stage: "apply", cause: rejection },
        cutover: { kind: "rejected", cause: rejection },
        preparationCleanup: settledCleanup,
      });
      expect(await readFile(path, "utf8")).toBe("current");
      expect(recover).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it("rewrites an authorized execution after queue release fails", () => {
    const protocol = new WorkspaceMutationProtocol(
      {} as WorkspaceMutationProtocolAuthority,
      {} as never,
    );
    const cause = new Error("release");
    const preparationCleanup = {
      kind: "failed" as const,
      cause: new Error("restore staging remained"),
    };

    const recovered = protocol.recoveryExecutionAfterCleanupFailure(
      {
        kind: "outcome",
        outcome,
        cutover: {
          kind: "authorized",
          pinnedResolution: {
            treeOid: "a".repeat(64),
            foundAt: { sessionId: "s", entryId: "e" },
          },
          writeAuthority,
          storeRoot: "/unused",
        },
        preparationCleanup,
      },
      cause,
    );

    expect(recovered).toEqual({
      kind: "post-mutation-conflict",
      reason: "control-failed",
      outcome,
      cause,
      preparationCleanup,
    });
    if (recovered?.kind !== "post-mutation-conflict") {
      throw new Error("expected post-mutation cleanup recovery");
    }
    expect(recovered.preparationCleanup).toBe(preparationCleanup);
  });

  it("retains both failed tree-arrival protection attempts", async () => {
    const tokenFailure = new Error("token protection failed");
    const fallbackFailure = new Error("fallback protection failed");
    const expected = {
      cwd: "/unused",
      isSameSnapshotAs: () => true,
    } as unknown as SessionView;
    const authority = {
      prepareTreeArrivalMutation: () => undefined,
      sessionIsUsable: () => true,
      protectCurrentTreeArrival: () => ({
        kind: "unsettled" as const,
        cause: tokenFailure,
      }),
      recoverUncertainLocationInWorkspaceLock: () => ({
        kind: "unsettled" as const,
        cause: fallbackFailure,
      }),
    } as unknown as WorkspaceMutationProtocolAuthority;
    const protocol = new WorkspaceMutationProtocol(
      authority,
      {} as never,
      () => expected,
    );

    const result = await protocol.restoreTreeArrival(
      {
        arrival: {} as never,
        expected,
        node: { sessionId: "s", entryId: "e" },
        resolution: {
          treeOid: "b".repeat(64),
          foundAt: { sessionId: "s", entryId: "e" },
        },
        current: {} as never,
      },
      writeAuthority,
    );

    expect(result.execution).toEqual({ kind: "target-changed" });
    expect(result.arrival.kind).toBe("unsettled");
    const cause = (result.arrival as { readonly cause: unknown }).cause;
    expect(cause).toBeInstanceOf(AggregateError);
    expect((cause as AggregateError).errors).toEqual([
      tokenFailure,
      fallbackFailure,
    ]);
  });
});
