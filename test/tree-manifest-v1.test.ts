import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  PUBLISHED_TREE_MANIFEST_FORMAT,
  TREE_MANIFEST_FORMAT,
  DEFAULT_TREE_MANIFEST_LIMITS,
  canonicalizeTreeManifest,
  encodeTreeManifest,
  migrateTreeManifestToCurrent,
  parseCanonicalTreeManifest,
  type TreeEntry,
  type TreeManifest,
} from "../src/infrastructure/tree-manifest.ts";
import { validateTreeEntriesAgainstScope } from "../src/infrastructure/tree-scope-validation.ts";
import {
  DEFAULT_MAX_WORKSPACE_RELATIVE_PATH_BYTES,
  DEFAULT_MAX_WORKSPACE_RELATIVE_PATH_COMPONENTS,
  portableWorkspacePathKey,
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

describe("versioned tree manifests", () => {
  it("uses one stable portable key for Unicode physical aliases", () => {
    expect(portableWorkspacePathKey("Σ/path")).toBe(
      portableWorkspacePathKey("ς/path"),
    );
    expect(portableWorkspacePathKey("ſ/path")).toBe(
      portableWorkspacePathKey("s/path"),
    );
    expect(portableWorkspacePathKey("ß/path")).toBe(
      portableWorkspacePathKey("ẞ/path"),
    );
    expect(portableWorkspacePathKey("ß/path")).toBe(
      portableWorkspacePathKey("SS/path"),
    );
  });

  it("writes only v2 and requires the final symlink shape", () => {
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
    expect(TREE_MANIFEST_FORMAT).toBe("cyclotomy-tree-v2");
    expect(parseCanonicalTreeManifest(encoded)).toEqual({
      format: "cyclotomy-tree-v2",
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
        format: "cyclotomy-tree-v2",
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

  it("parses the exact published v1 contract before migrating to v2", () => {
    const legacyBytes = Buffer.from(
      `${JSON.stringify({
        format: PUBLISHED_TREE_MANIFEST_FORMAT,
        entries: [
          {
            path: "link",
            type: "symlink",
            target: "target",
            symlinkKind: "file",
          },
        ],
        scope: allManaged,
      })}\n`,
    );
    const legacy = parseCanonicalTreeManifest(legacyBytes);
    expect(legacy.format).toBe(PUBLISHED_TREE_MANIFEST_FORMAT);
    expect(migrateTreeManifestToCurrent(legacy)).toEqual({
      format: TREE_MANIFEST_FORMAT,
      entries: legacy.entries,
      scope: legacy.scope,
    });
  });

  it("recognizes valid published v1 trees that cannot be losslessly migrated", () => {
    const entry = (path: string) => ({
      path,
      type: "regular" as const,
      blobOid: "0".repeat(64),
      recreationMode: 0o644,
    });
    const legacyBytes = Buffer.from(
      `${JSON.stringify({
        format: PUBLISHED_TREE_MANIFEST_FORMAT,
        entries: [entry("Σ/a"), entry("ς/b")],
        scope: allManaged,
      })}\n`,
    );
    const legacy = parseCanonicalTreeManifest(legacyBytes);
    expect(legacy.format).toBe(PUBLISHED_TREE_MANIFEST_FORMAT);
    expect(() => migrateTreeManifestToCurrent(legacy)).toThrow(
      "cannot be represented",
    );
  });

  it("uses configured path-byte limits when migrating published v1", () => {
    const overDefault = "a".repeat(
      DEFAULT_MAX_WORKSPACE_RELATIVE_PATH_BYTES + 1,
    );
    const legacy = parseCanonicalTreeManifest(
      Buffer.from(
        `${JSON.stringify({
          format: PUBLISHED_TREE_MANIFEST_FORMAT,
          entries: [
            {
              path: overDefault,
              type: "regular",
              blobOid: "0".repeat(64),
              recreationMode: 0o644,
            },
          ],
          scope: allManaged,
        })}\n`,
      ),
    );

    expect(() => migrateTreeManifestToCurrent(legacy)).toThrow(
      "cannot be represented",
    );
    expect(
      migrateTreeManifestToCurrent(legacy, {
        maxPathBytes: Buffer.byteLength(overDefault),
        maxPathComponents: DEFAULT_MAX_WORKSPACE_RELATIVE_PATH_COMPONENTS,
      }).entries,
    ).toHaveLength(1);
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

  it("binds portable .gitignore entry aliases even when Git matching is case-sensitive", async () => {
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
    const selfIgnoredBytes = Buffer.from(".gitignore\n*.tmp\n");
    const caseSensitiveScope = {
      ...scope,
      ignoreCase: false,
      gitignoreSources: [
        workspaceGitignoreSource(".gitignore", selfIgnoredBytes),
      ],
    } as const;
    const caseSensitiveAlias: TreeEntry = {
      ...alias,
      blobOid: createHash("sha256").update(selfIgnoredBytes).digest("hex"),
    };
    await expect(
      validateTreeEntriesAgainstScope(
        manifest([caseSensitiveAlias], caseSensitiveScope),
      ),
    ).resolves.toBeUndefined();
    expect(() =>
      manifest([{ ...alias, blobOid: "0".repeat(64) }], scope),
    ).toThrow("does not match");
    expect(() =>
      manifest(
        [{ ...caseSensitiveAlias, blobOid: "0".repeat(64) }],
        caseSensitiveScope,
      ),
    ).toThrow("does not match");
    expect(() => manifest([alias], { ...scope, gitignoreSources: [] })).toThrow(
      "missing from workspace scope",
    );
    expect(() =>
      manifest([caseSensitiveAlias], {
        ...caseSensitiveScope,
        gitignoreSources: [],
      }),
    ).toThrow("missing from workspace scope");
  });

  it("rejects portable aliases between local policy directories and the tree namespace", () => {
    const rootPolicy = Buffer.from("a/*\n");
    const nestedPolicy = Buffer.from(".gitignore\n!file\n");
    const scope = {
      kind: "git",
      repositoryPrefix: "",
      ignoreCase: false,
      gitignoreSources: [
        workspaceGitignoreSource(".gitignore", rootPolicy),
        workspaceGitignoreSource("A/.gitignore", nestedPolicy),
      ],
      infoExcludeBase64: "",
      globalExcludeBase64: "",
    } as const;
    const rootEntry: TreeEntry = {
      path: ".gitignore",
      type: "regular",
      blobOid: createHash("sha256").update(rootPolicy).digest("hex"),
      recreationMode: 0o644,
    };
    const fileEntry: TreeEntry = {
      path: "a/file",
      type: "regular",
      blobOid: "0".repeat(64),
      recreationMode: 0o644,
    };

    expect(() => manifest([rootEntry, fileEntry], scope)).toThrow(
      "policy directory collides",
    );
    expect(() =>
      manifest([{ ...fileEntry, path: ".GITIGNORE/child" }], {
        ...scope,
        gitignoreSources: [workspaceGitignoreSource(".gitignore", rootPolicy)],
      }),
    ).toThrow("ignore source does not match tree entry");
    expect(() =>
      manifest([rootEntry, { ...fileEntry, path: "A" }], scope),
    ).toThrow("policy directory collides");
    expect(() =>
      manifest([], {
        ...scope,
        gitignoreSources: [
          workspaceGitignoreSource("A/.gitignore", nestedPolicy),
          workspaceGitignoreSource("a/.gitignore", nestedPolicy),
        ],
      }),
    ).toThrow("policy path aliases");
  });

  it("rejects Unicode physical aliases in tree and policy namespaces", () => {
    const entry = (path: string): TreeEntry => ({
      path,
      type: "regular",
      blobOid: "0".repeat(64),
      recreationMode: 0o644,
    });

    expect(() => manifest([entry("Σ/a"), entry("ς/b")], allManaged)).toThrow(
      "portable case normalization",
    );
    expect(() => manifest([entry("ß/a"), entry("ẞ/b")], allManaged)).toThrow(
      "portable case normalization",
    );
    expect(() =>
      manifest([entry("ς/file")], {
        kind: "git",
        repositoryPrefix: "",
        ignoreCase: false,
        gitignoreSources: [
          workspaceGitignoreSource("Σ/.gitignore", Buffer.alloc(0)),
        ],
        infoExcludeBase64: "",
        globalExcludeBase64: "",
      }),
    ).toThrow("policy directory collides");
  });

  it("accepts an exact local policy directory shared with implicit tree directories", async () => {
    const rootPolicy = Buffer.from("A/*\n");
    const nestedPolicy = Buffer.from(".gitignore\n!file\n");
    const scope = {
      kind: "git",
      repositoryPrefix: "",
      ignoreCase: false,
      gitignoreSources: [
        workspaceGitignoreSource(".gitignore", rootPolicy),
        workspaceGitignoreSource("A/.gitignore", nestedPolicy),
      ],
      infoExcludeBase64: "",
      globalExcludeBase64: "",
    } as const;
    const target = manifest(
      [
        {
          path: ".gitignore",
          type: "regular",
          blobOid: createHash("sha256").update(rootPolicy).digest("hex"),
          recreationMode: 0o644,
        },
        {
          path: "A/file",
          type: "regular",
          blobOid: "0".repeat(64),
          recreationMode: 0o644,
        },
      ],
      scope,
    );

    await expect(
      validateTreeEntriesAgainstScope(target),
    ).resolves.toBeUndefined();
  });

  it("bounds portable tree paths by UTF-8 bytes and component count", () => {
    const regular = (path: string): TreeEntry => ({
      path,
      type: "regular",
      blobOid: "0".repeat(64),
      recreationMode: 0o644,
    });
    const byteBoundary = `${"界".repeat(
      Math.floor(DEFAULT_MAX_WORKSPACE_RELATIVE_PATH_BYTES / 3),
    )}a`;
    const componentBoundary = new Array(
      DEFAULT_MAX_WORKSPACE_RELATIVE_PATH_COMPONENTS,
    )
      .fill("a")
      .join("/");

    expect(manifest([regular(byteBoundary)], allManaged).entries).toHaveLength(
      1,
    );
    expect(
      manifest([regular(componentBoundary)], allManaged).entries,
    ).toHaveLength(1);
    expect(() => manifest([regular(`${byteBoundary}a`)], allManaged)).toThrow(
      "unsafe tree entry path",
    );
    expect(() =>
      manifest([regular(`${componentBoundary}/a`)], allManaged),
    ).toThrow("unsafe tree entry path");

    const raisedLimits = {
      ...DEFAULT_TREE_MANIFEST_LIMITS,
      maxPathBytes: DEFAULT_MAX_WORKSPACE_RELATIVE_PATH_BYTES + 1,
      maxPathComponents: DEFAULT_MAX_WORKSPACE_RELATIVE_PATH_COMPONENTS + 1,
    };
    const raised = canonicalizeTreeManifest(
      [regular(`${byteBoundary}a`), regular(`${componentBoundary}/a`)],
      allManaged,
      raisedLimits,
    );
    expect(raised.entries).toHaveLength(2);
    const raisedBytes = encodeTreeManifest(
      raised.entries,
      raised.scope,
      raisedLimits,
    );
    expect(parseCanonicalTreeManifest(raisedBytes).entries).toHaveLength(2);

    const sourceSuffix = "/.gitignore";
    const sourceBoundary = `${"a".repeat(
      DEFAULT_MAX_WORKSPACE_RELATIVE_PATH_BYTES -
        Buffer.byteLength(sourceSuffix),
    )}${sourceSuffix}`;
    expect(workspaceGitignoreSource(sourceBoundary, Buffer.alloc(0)).path).toBe(
      sourceBoundary,
    );
    expect(() =>
      workspaceGitignoreSource(`a${sourceBoundary}`, Buffer.alloc(0)),
    ).toThrow("portable byte limit");
    expect(
      workspaceGitignoreSource(`a${sourceBoundary}`, Buffer.alloc(0), {
        maxPathBytes: DEFAULT_MAX_WORKSPACE_RELATIVE_PATH_BYTES + 1,
        maxPathComponents: DEFAULT_MAX_WORKSPACE_RELATIVE_PATH_COMPONENTS,
      }).path,
    ).toBe(`a${sourceBoundary}`);
  });
});
