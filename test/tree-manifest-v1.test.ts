import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_TREE_MANIFEST_LIMITS,
  type TreeEntry,
} from "../src/infrastructure/tree-formats/manifest-codec.ts";
import {
  CURRENT_TREE_MANIFEST_FORMAT,
  createCurrentTreeManifest,
  encodeCurrentTreeManifest,
  type CurrentTreeManifest,
} from "../src/infrastructure/tree-formats/current.ts";
import {
  parseTreeManifest,
  upgradeTreeManifest,
} from "../src/infrastructure/tree-formats/history.ts";
import {
  TREE_FORMAT_V1,
  TREE_MANIFEST_FORMAT_V1,
} from "../src/infrastructure/tree-formats/v1.ts";
import {
  TREE_FORMAT_V2,
  TREE_MANIFEST_FORMAT_V2,
} from "../src/infrastructure/tree-formats/v2.ts";
import { validateTreeEntriesAgainstScope } from "../src/infrastructure/tree-scope-validation.ts";
import {
  DEFAULT_MAX_WORKSPACE_RELATIVE_PATH_BYTES,
  DEFAULT_MAX_WORKSPACE_RELATIVE_PATH_COMPONENTS,
  portableWorkspacePathKey,
  workspaceGitignoreSource,
  type WorkspaceScope,
} from "../src/infrastructure/workspace-scope.ts";

const allManaged = { kind: "all-managed" } as const;
const evaluator = {
  version: "git version fixture",
  precomposeUnicode: false,
} as const;

function upgradeTreeManifestToCurrent(
  legacy: Parameters<typeof upgradeTreeManifest>[0],
  pathLimits?: Parameters<typeof upgradeTreeManifest>[2],
): CurrentTreeManifest {
  return upgradeTreeManifest(
    legacy,
    CURRENT_TREE_MANIFEST_FORMAT,
    pathLimits,
  ) as CurrentTreeManifest;
}

function manifest(
  entries: readonly TreeEntry[],
  scope: WorkspaceScope,
): CurrentTreeManifest {
  return createCurrentTreeManifest(entries, scope);
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

  it("creates v3 semantics and requires the final symlink shape", () => {
    const encoded = encodeCurrentTreeManifest(
      createCurrentTreeManifest(
        [
          {
            path: "link",
            type: "symlink",
            target: "target",
            symlinkKind: "file",
          },
        ],
        allManaged,
      ),
    );
    expect(CURRENT_TREE_MANIFEST_FORMAT).toBe("cyclotomy-tree-v3");
    expect(JSON.parse(encoded.toString("utf8"))).toEqual({
      format: "cyclotomy-tree-v3",
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
    // A graph-format semantic projection is never accepted as a stored root.
    expect(() => parseTreeManifest(encoded)).toThrow();
    for (const candidate of [
      { format: "unsupported-tree-format", entries: [], scope: allManaged },
      {
        format: "cyclotomy-tree-v2",
        entries: [{ path: "link", type: "symlink", target: "target" }],
        scope: allManaged,
      },
    ]) {
      expect(() =>
        parseTreeManifest(Buffer.from(`${JSON.stringify(candidate)}\n`)),
      ).toThrow();
    }
  });

  it("admits new current manifests through the exact semantic byte ceiling", () => {
    const entries = [
      {
        path: "entry-with-a-long-name",
        type: "regular",
        blobOid: "a".repeat(64),
        recreationMode: 0o644,
      },
    ] as const;
    const created = createCurrentTreeManifest(entries, allManaged);
    const exactBytes = encodeCurrentTreeManifest(created).byteLength;
    const exactLimits = {
      ...DEFAULT_TREE_MANIFEST_LIMITS,
      maxManifestBytes: exactBytes,
    };

    expect(createCurrentTreeManifest(entries, allManaged, exactLimits)).toEqual(
      created,
    );
    expect(() =>
      createCurrentTreeManifest(entries, allManaged, {
        ...exactLimits,
        maxManifestBytes: exactBytes - 1,
      }),
    ).toThrow("exceeding");
  });

  it("parses the exact published v1 contract before migrating to current", () => {
    const legacyBytes = Buffer.from(
      `${JSON.stringify({
        format: TREE_MANIFEST_FORMAT_V1,
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
    const legacy = parseTreeManifest(legacyBytes);
    expect(legacy.format).toBe(TREE_MANIFEST_FORMAT_V1);
    expect(upgradeTreeManifestToCurrent(legacy)).toEqual({
      format: CURRENT_TREE_MANIFEST_FORMAT,
      entries: legacy.entries,
      scope: legacy.scope,
    });
  });

  it("projects v1 Git provenance as unknown without changing historical bytes", () => {
    const legacyBytes = Buffer.from(
      `${JSON.stringify({
        format: TREE_MANIFEST_FORMAT_V1,
        entries: [],
        scope: {
          kind: "git",
          repositoryPrefix: "",
          ignoreCase: false,
          gitignoreSources: [],
          infoExcludeBase64: "",
          globalExcludeBase64: "",
        },
      })}\n`,
    );
    const legacy = parseTreeManifest(legacyBytes);
    expect(legacy.scope).toMatchObject({
      kind: "git",
      evaluator: null,
    });
    expect(
      TREE_FORMAT_V1.encode!(legacy, DEFAULT_TREE_MANIFEST_LIMITS),
    ).toEqual(legacyBytes);
  });

  it("authenticates frozen v1/v2 NUL policy bytes but blocks v2 admission to v3", () => {
    const legacyBytes = (format: string) =>
      Buffer.from(
        `${JSON.stringify({
          format,
          entries: [],
          scope: {
            kind: "git",
            repositoryPrefix: "",
            ignoreCase: false,
            gitignoreSources: [],
            infoExcludeBase64: "AA==",
            globalExcludeBase64: "",
          },
        })}\n`,
      );
    const v1Bytes = legacyBytes(TREE_MANIFEST_FORMAT_V1);
    expect(createHash("sha256").update(v1Bytes).digest("hex")).toBe(
      "8a87c9797e9922bb8d263eb8e033ce266d2b1b92ab7157fc81e2b2d0454a5d9d",
    );
    const v1 = parseTreeManifest(v1Bytes);
    expect(TREE_FORMAT_V1.encode!(v1, DEFAULT_TREE_MANIFEST_LIMITS)).toEqual(
      v1Bytes,
    );

    const v2 = upgradeTreeManifest(v1, TREE_MANIFEST_FORMAT_V2);
    const v2Bytes = legacyBytes(TREE_MANIFEST_FORMAT_V2);
    expect(createHash("sha256").update(v2Bytes).digest("hex")).toBe(
      "11c64fedf373d0ddd8086ecf64809e82dd87762fd738780ff6cfe20d185a7ca5",
    );
    expect(TREE_FORMAT_V2.encode!(v2, DEFAULT_TREE_MANIFEST_LIMITS)).toEqual(
      v2Bytes,
    );
    expect(parseTreeManifest(v2Bytes)).toEqual(v2);

    expect(() => upgradeTreeManifestToCurrent(v2)).toThrow(
      expect.objectContaining({ kind: "format-incompatible" }),
    );
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
        format: TREE_MANIFEST_FORMAT_V1,
        entries: [entry("Σ/a"), entry("ς/b")],
        scope: allManaged,
      })}\n`,
    );
    const legacy = parseTreeManifest(legacyBytes);
    expect(legacy.format).toBe(TREE_MANIFEST_FORMAT_V1);
    expect(() => upgradeTreeManifestToCurrent(legacy)).toThrow(
      "cannot be represented",
    );
  });

  it("uses configured path-byte limits when migrating published v1", () => {
    const overDefault = "a".repeat(
      DEFAULT_MAX_WORKSPACE_RELATIVE_PATH_BYTES + 1,
    );
    const legacy = parseTreeManifest(
      Buffer.from(
        `${JSON.stringify({
          format: TREE_MANIFEST_FORMAT_V1,
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

    expect(() => upgradeTreeManifestToCurrent(legacy)).toThrow(
      "cannot be represented",
    );
    expect(
      upgradeTreeManifestToCurrent(legacy, {
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
      evaluator,
      ignoreCase: false,
      gitignoreSources: [workspaceGitignoreSource(".gitignore", bytes)],
      infoExcludeBase64: "",
      globalExcludeBase64: "",
    } as const;
    expect(createCurrentTreeManifest([], scope)).toEqual({
      format: CURRENT_TREE_MANIFEST_FORMAT,
      entries: [],
      scope,
    });
    await expect(
      validateTreeEntriesAgainstScope(manifest([], scope)),
    ).resolves.toEqual({ gitVersion: expect.any(String) });
  });

  it("binds a managed .gitignore entry to the archived raw bytes", () => {
    const bytes = Buffer.from("*.tmp\n");
    const oid = createHash("sha256").update(bytes).digest("hex");
    const scope = {
      kind: "git",
      repositoryPrefix: "project",
      evaluator,
      ignoreCase: false,
      gitignoreSources: [workspaceGitignoreSource("project/.gitignore", bytes)],
      infoExcludeBase64: "",
      globalExcludeBase64: "",
    } as const;
    expect(
      createCurrentTreeManifest(
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
      createCurrentTreeManifest(
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
      createCurrentTreeManifest(
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
      evaluator,
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
    ).resolves.toEqual({ gitVersion: expect.any(String) });
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
    ).resolves.toEqual({ gitVersion: expect.any(String) });
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
      evaluator,
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
        evaluator,
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
      evaluator,
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

    await expect(validateTreeEntriesAgainstScope(target)).resolves.toEqual({
      gitVersion: expect.any(String),
    });
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
    const raised = createCurrentTreeManifest(
      [regular(`${byteBoundary}a`), regular(`${componentBoundary}/a`)],
      allManaged,
      raisedLimits,
    );
    expect(raised.entries).toHaveLength(2);
    const raisedBytes = encodeCurrentTreeManifest(raised, raisedLimits);
    expect(
      (
        JSON.parse(raisedBytes.toString("utf8")) as {
          readonly entries: readonly unknown[];
        }
      ).entries,
    ).toHaveLength(2);

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
