import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  TREE_MANIFEST_FORMAT,
  canonicalizeTreeManifest,
  encodeTreeManifest,
  parseCanonicalTreeManifest,
  type TreeEntry,
  type TreeManifest,
} from "../src/infrastructure/tree-manifest.ts";
import { validateTreeEntriesAgainstScope } from "../src/infrastructure/tree-scope-validation.ts";
import {
  workspaceGitignoreSource,
  type WorkspaceScope,
} from "../src/infrastructure/workspace-scope.ts";

const allManaged = { kind: "all-managed" } as const;

function manifest(
  entries: readonly TreeEntry[],
  scope: WorkspaceScope,
): TreeManifest {
  const canonical = canonicalizeTreeManifest(entries, scope);
  return { format: TREE_MANIFEST_FORMAT, ...canonical };
}

describe("final tree manifest v1", () => {
  it("writes only v1 and requires the final symlink shape", () => {
    const encoded = encodeTreeManifest(
      [
        {
          path: "link",
          type: "symlink",
          target: "target",
          symlinkKind: "file",
        },
      ],
      allManaged,
    );
    expect(TREE_MANIFEST_FORMAT).toBe("cyclotomy-tree-v1");
    expect(parseCanonicalTreeManifest(encoded)).toEqual({
      format: "cyclotomy-tree-v1",
      entries: [
        {
          path: "link",
          type: "symlink",
          target: "target",
          symlinkKind: "file",
        },
      ],
      scope: allManaged,
    });
    for (const candidate of [
      { format: "unsupported-tree-format", entries: [], scope: allManaged },
      {
        format: "cyclotomy-tree-v1",
        entries: [{ path: "link", type: "symlink", target: "target" }],
        scope: allManaged,
      },
    ]) {
      expect(() =>
        parseCanonicalTreeManifest(
          Buffer.from(`${JSON.stringify(candidate)}\n`),
        ),
      ).toThrow();
    }
  });

  it("does not require an ignored policy source to be a managed tree entry", async () => {
    const bytes = Buffer.from(".gitignore\nsecret\n");
    const scope = {
      kind: "git",
      repositoryPrefix: "",
      ignoreCase: false,
      gitignoreSources: [workspaceGitignoreSource(".gitignore", bytes)],
      infoExcludeBase64: "",
      globalExcludeBase64: "",
    } as const;
    expect(canonicalizeTreeManifest([], scope)).toEqual({ entries: [], scope });
    await expect(
      validateTreeEntriesAgainstScope(manifest([], scope)),
    ).resolves.toBeUndefined();
  });

  it("binds a managed .gitignore entry to the archived raw bytes", () => {
    const bytes = Buffer.from("*.tmp\n");
    const oid = createHash("sha256").update(bytes).digest("hex");
    const scope = {
      kind: "git",
      repositoryPrefix: "project",
      ignoreCase: false,
      gitignoreSources: [workspaceGitignoreSource("project/.gitignore", bytes)],
      infoExcludeBase64: "",
      globalExcludeBase64: "",
    } as const;
    expect(
      canonicalizeTreeManifest(
        [
          {
            path: ".gitignore",
            type: "regular",
            blobOid: oid,
            recreationMode: 0o644,
          },
        ],
        scope,
      ).entries,
    ).toHaveLength(1);
    expect(() =>
      canonicalizeTreeManifest(
        [
          {
            path: ".gitignore",
            type: "regular",
            blobOid: "0".repeat(64),
            recreationMode: 0o644,
          },
        ],
        scope,
      ),
    ).toThrow("does not match");
    expect(() =>
      canonicalizeTreeManifest(
        [
          {
            path: "nested/.gitignore",
            type: "regular",
            blobOid: "0".repeat(64),
            recreationMode: 0o644,
          },
        ],
        scope,
      ),
    ).toThrow("missing from workspace scope");
  });

  it("uses the archived ignoreCase policy for .gitignore entry aliases", async () => {
    const bytes = Buffer.from("*.tmp\n");
    const oid = createHash("sha256").update(bytes).digest("hex");
    const scope = {
      kind: "git",
      repositoryPrefix: "",
      ignoreCase: true,
      gitignoreSources: [workspaceGitignoreSource(".gitignore", bytes)],
      infoExcludeBase64: "",
      globalExcludeBase64: "",
    } as const;
    const alias: TreeEntry = {
      path: ".GITIGNORE",
      type: "regular",
      blobOid: oid,
      recreationMode: 0o644,
    };

    await expect(
      validateTreeEntriesAgainstScope(manifest([alias], scope)),
    ).resolves.toBeUndefined();
    expect(() =>
      manifest([{ ...alias, blobOid: "0".repeat(64) }], scope),
    ).toThrow("does not match");
    expect(() => manifest([alias], { ...scope, gitignoreSources: [] })).toThrow(
      "missing from workspace scope",
    );
    await expect(
      validateTreeEntriesAgainstScope(
        manifest([alias], {
          ...scope,
          ignoreCase: false,
          gitignoreSources: [],
        }),
      ),
    ).resolves.toBeUndefined();
  });
});
