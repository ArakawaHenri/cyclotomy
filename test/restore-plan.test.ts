import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { CurrentTreeManifest } from "../src/infrastructure/tree-formats/current.ts";
import { CURRENT_TREE_MANIFEST_FORMAT } from "../src/infrastructure/tree-formats/current.ts";
import {
  planWorkspaceRestore,
  restorePlanHasChanges,
  workspaceSnapshotAsManifest,
} from "../src/infrastructure/restore-plan.ts";
import type { WorkspaceState } from "../src/infrastructure/workspace-scan.ts";
import {
  ABSOLUTE_WORKSPACE_PATH_LIMITS,
  canonicalizeWorkspaceScope,
} from "../src/infrastructure/workspace-scope.ts";
import { ALL_MANAGED_SCOPE, gitScope } from "./workspace-scope-fixture.ts";

const oid = (content: string): string =>
  createHash("sha256").update(content).digest("hex");

const scope = ALL_MANAGED_SCOPE;

type WorkspaceStateInput = Omit<WorkspaceState, "excludedOccupancies"> & {
  readonly excludedOccupancies?: WorkspaceState["excludedOccupancies"];
};

function state(input: WorkspaceStateInput): WorkspaceState {
  const { excludedOccupancies = [], ...rest } = input;
  return { ...rest, excludedOccupancies };
}

describe("workspace restore plan", () => {
  it("marks an inventory from a different workspace scope incomplete", () => {
    const current = state({
      entries: [
        {
          path: "current-only.txt",
          kind: "regular",
          recreationMode: 0o644,
          byteLength: 1,
          sha256: oid("x"),
        },
      ],
      problems: [],
      scope: gitScope({ ignoreCase: true }),
    });
    const target: CurrentTreeManifest = {
      format: CURRENT_TREE_MANIFEST_FORMAT,
      entries: [],
      scope: gitScope(),
    };

    const plan = planWorkspaceRestore(current, target);
    expect(plan.problems).toContainEqual({
      path: ".",
      kind: "scope-mismatch",
      detail: expect.stringContaining("target workspace scope"),
    });
    expect(plan.deleted).toEqual([]);
  });

  it("compares already authenticated scopes against the durable path contract", () => {
    const repositoryPrefix = Array.from({ length: 257 }, () => "a").join("/");
    const durableScope = canonicalizeWorkspaceScope(
      {
        kind: "git",
        repositoryPrefix,
        evaluator: null,
        ignoreCase: false,
        gitignoreSources: [],
        infoExcludeBase64: "",
        globalExcludeBase64: "",
      },
      ABSOLUTE_WORKSPACE_PATH_LIMITS,
    );
    const current = state({
      entries: [],
      problems: [],
      scope: durableScope,
    });
    const target: CurrentTreeManifest = {
      format: CURRENT_TREE_MANIFEST_FORMAT,
      entries: [],
      scope: durableScope,
    };

    expect(planWorkspaceRestore(current, target).problems).toEqual([]);
  });

  it("classifies actions and required blobs from the target's point of view", () => {
    const current = state({
      entries: [
        {
          path: "added.txt",
          kind: "regular",
          recreationMode: 0o644,
          byteLength: 3,
          sha256: oid("new"),
        },
        {
          path: "changed.txt",
          kind: "regular",
          recreationMode: 0o755,
          byteLength: 3,
          sha256: oid("new"),
        },
      ],
      problems: [],
      scope,
    });
    const target: CurrentTreeManifest = {
      format: CURRENT_TREE_MANIFEST_FORMAT,
      entries: [
        {
          path: "changed.txt",
          type: "regular",
          blobOid: oid("old"),
          recreationMode: 0o644,
        },
        {
          path: "removed.txt",
          type: "regular",
          blobOid: oid("gone"),
          recreationMode: 0o644,
        },
      ],
      scope,
    };

    const plan = planWorkspaceRestore(current, target);
    expect(plan).toMatchObject({
      created: ["removed.txt"],
      deleted: ["added.txt"],
      modified: ["changed.txt"],
      scopeBlockers: [],
    });
    expect(plan.requiredBlobOids).toEqual([oid("old"), oid("gone")].sort());
    expect(restorePlanHasChanges(plan)).toBe(true);
  });

  it("ignores recreation-mode-only drift and does not request its blob", () => {
    const content = "same";
    const current = state({
      entries: [
        {
          path: "run.sh",
          kind: "regular",
          recreationMode: 0o640,
          byteLength: content.length,
          sha256: oid(content),
        },
      ],
      problems: [],
      scope,
    });
    const target: CurrentTreeManifest = {
      format: CURRENT_TREE_MANIFEST_FORMAT,
      entries: [
        {
          path: "run.sh",
          type: "regular",
          blobOid: oid(content),
          recreationMode: 0o711,
        },
      ],
      scope,
    };

    const plan = planWorkspaceRestore(current, target);
    expect(restorePlanHasChanges(plan)).toBe(false);
    expect(plan.requiredBlobOids).toEqual([]);
  });

  it("deduplicates and sorts required blobs", () => {
    const blobOid = oid("shared");
    const target: CurrentTreeManifest = {
      format: CURRENT_TREE_MANIFEST_FORMAT,
      entries: ["b.txt", "a.txt"].map((path) => ({
        path,
        type: "regular" as const,
        blobOid,
        recreationMode: 0o644,
      })),
      scope,
    };
    const current = state({ entries: [], problems: [], scope });

    expect(planWorkspaceRestore(current, target).requiredBlobOids).toEqual([
      blobOid,
    ]);
  });

  it("deletes only current-only paths inside the target scope", () => {
    const entry = (path: string): WorkspaceState["entries"][number] => ({
      path,
      kind: "regular",
      recreationMode: 0o644,
      byteLength: 1,
      sha256: oid(path),
    });
    const targetScope = gitScope({
      gitignoreSources: [{ path: ".gitignore", contents: "secret.txt\n" }],
    });
    const current = state({
      entries: [
        entry("managed.txt"),
        {
          path: ".gitignore",
          kind: "regular",
          recreationMode: 0o644,
          byteLength: "secret.txt\n".length,
          sha256: oid("secret.txt\n"),
        },
      ],
      excludedOccupancies: [{ path: "secret.txt", kind: "regular" }],
      problems: [],
      scope: targetScope,
    });
    const target: CurrentTreeManifest = {
      format: CURRENT_TREE_MANIFEST_FORMAT,
      entries: [
        {
          path: ".gitignore",
          type: "regular",
          blobOid: oid("secret.txt\n"),
          recreationMode: 0o644,
        },
      ],
      scope: targetScope,
    };

    expect(planWorkspaceRestore(current, target).deleted).toEqual([
      "managed.txt",
    ]);
  });

  it("preserves scan problems and reports scope blockers once", () => {
    const targetScope = gitScope({
      gitignoreSources: [{ path: ".gitignore", contents: "a/b\n" }],
    });
    const current = state({
      entries: [],
      excludedOccupancies: [{ path: "a/b", kind: "regular" }],
      problems: [{ path: "other", kind: "read-failed", detail: "denied" }],
      scope: targetScope,
    });
    const target: CurrentTreeManifest = {
      format: CURRENT_TREE_MANIFEST_FORMAT,
      entries: [
        {
          path: "a",
          type: "regular",
          blobOid: oid("target"),
          recreationMode: 0o644,
        },
      ],
      scope: targetScope,
    };

    const plan = planWorkspaceRestore(current, target);
    expect(plan.scopeBlockers).toEqual([{ path: "a/b", targetPath: "a" }]);
    expect(plan.problems).toEqual([
      expect.objectContaining({ kind: "read-failed", path: "other" }),
      expect.objectContaining({ kind: "scope-blocker", path: "a/b" }),
    ]);
  });

  it.each([
    {
      name: "target non-directory versus ignored descendant",
      occupancy: { path: "a/hidden", kind: "regular" as const },
      targetPath: "a",
      targetEntries: [
        {
          path: "a",
          type: "regular" as const,
          blobOid: oid("target"),
          recreationMode: 0o644,
        },
      ],
    },
    {
      name: "target non-directory versus wholly ignored directory",
      occupancy: { path: "a", kind: "directory" as const },
      targetPath: "a",
      targetEntries: [
        {
          path: "a",
          type: "symlink" as const,
          target: "destination",
          symlinkKind: null,
        },
      ],
    },
    {
      name: "target implicit directory versus ignored regular",
      occupancy: { path: "a", kind: "regular" as const },
      targetPath: "a",
      targetEntries: [
        {
          path: "a/child",
          type: "regular" as const,
          blobOid: oid("target"),
          recreationMode: 0o644,
        },
      ],
    },
  ])("blocks $name", ({ occupancy, targetPath, targetEntries }) => {
    const current = state({
      entries: [],
      excludedOccupancies: [occupancy],
      problems: [],
      scope,
    });
    const target: CurrentTreeManifest = {
      format: CURRENT_TREE_MANIFEST_FORMAT,
      entries: targetEntries,
      scope,
    };

    const plan = planWorkspaceRestore(current, target);

    expect(plan.scopeBlockers).toEqual([
      {
        path: occupancy.path,
        targetPath,
      },
    ]);
    expect(plan.problems).toContainEqual(
      expect.objectContaining({
        path: occupancy.path,
        kind: "scope-blocker",
      }),
    );
  });

  it("treats excluded occupancy appearance, disappearance, and kind change as stale", () => {
    const observed = (
      excludedOccupancies: WorkspaceState["excludedOccupancies"],
    ): WorkspaceState =>
      state({
        entries: [],
        excludedOccupancies,
        problems: [],
        scope,
      });
    const before = observed([{ path: "ignored", kind: "regular" }]);
    const comparison = workspaceSnapshotAsManifest(before);

    expect(planWorkspaceRestore(before, comparison).occupancyChanged).toEqual(
      [],
    );
    expect(
      restorePlanHasChanges(planWorkspaceRestore(observed([]), comparison)),
    ).toBe(true);
    expect(
      planWorkspaceRestore(observed([]), comparison).occupancyChanged,
    ).toEqual(["ignored"]);
    expect(
      planWorkspaceRestore(
        observed([{ path: "ignored", kind: "symlink" }]),
        comparison,
      ).occupancyChanged,
    ).toEqual(["ignored"]);
    expect(
      planWorkspaceRestore(
        observed([
          { path: "ignored", kind: "regular" },
          { path: "new", kind: "directory" },
        ]),
        comparison,
      ).occupancyChanged,
    ).toEqual(["new"]);
  });
});
