import { describe, expect, it } from "vitest";

import {
  createTreeFormatEngine,
  treeFormatChain,
  type TreeFormatNode,
} from "../src/infrastructure/tree-formats/chain.ts";
import {
  canonicalizeTreeManifest,
  freezeTreeManifest,
  type TreeManifest,
} from "../src/infrastructure/tree-formats/manifest-codec.ts";
import { referencedTreeBlobOids } from "../src/infrastructure/tree-formats/references.ts";
import {
  TREE_MANIFEST_FORMAT_V1,
  TREE_FORMAT_V1,
} from "../src/infrastructure/tree-formats/v1.ts";
import { TREE_FORMAT_V2 } from "../src/infrastructure/tree-formats/v2.ts";
import { DEFAULT_WORKSPACE_PATH_LIMITS } from "../src/infrastructure/workspace-scope.ts";

const scope = { kind: "all-managed" } as const;

function expectFrozenManifestGraph(manifest: TreeManifest): void {
  expect(Object.isFrozen(manifest)).toBe(true);
  expect(Object.isFrozen(manifest.entries)).toBe(true);
  for (const entry of manifest.entries) {
    expect(Object.isFrozen(entry)).toBe(true);
  }
  expect(Object.isFrozen(manifest.scope)).toBe(true);
  if (manifest.scope.kind === "git") {
    expect(Object.isFrozen(manifest.scope.gitignoreSources)).toBe(true);
    for (const source of manifest.scope.gitignoreSources) {
      expect(Object.isFrozen(source)).toBe(true);
    }
  }
}

describe("tree format chain", () => {
  it("freezes published nodes and the derived engine", () => {
    const engine = createTreeFormatEngine(TREE_FORMAT_V2);

    expect(Object.isFrozen(TREE_FORMAT_V1)).toBe(true);
    expect(Object.isFrozen(TREE_FORMAT_V2)).toBe(true);
    expect(Object.isFrozen(engine)).toBe(true);
    expect(Reflect.set(TREE_FORMAT_V2, "format", "rewritten")).toBe(false);
    expect(engine.current.format).toBe(TREE_FORMAT_V2.format);
  });

  it("derives parser lookup and multi-hop upgrades from a synthetic current node", () => {
    const upgrades: string[] = [];
    const v3Format = "cyclotomy-tree-v3-test";
    const v2: TreeFormatNode = {
      ...TREE_FORMAT_V2,
      previous: TREE_FORMAT_V1,
      upgradeFromPrevious(previous, limits) {
        upgrades.push("v1->v2");
        return TREE_FORMAT_V2.upgradeFromPrevious!(previous, limits);
      },
    };
    const v3: TreeFormatNode = {
      format: v3Format,
      previous: v2,
      create(entries, nextScope, limits) {
        const canonical = canonicalizeTreeManifest(entries, nextScope, limits);
        return { format: v3Format, ...canonical };
      },
      decode(candidate, limits) {
        expect(candidate.generation).toBe(3);
        const canonical = canonicalizeTreeManifest(
          candidate.entries,
          candidate.scope,
          limits,
        );
        return { format: v3Format, ...canonical };
      },
      encode(manifest, limits) {
        const canonical = canonicalizeTreeManifest(
          manifest.entries,
          manifest.scope,
          limits,
        );
        return Buffer.from(
          `${JSON.stringify({
            format: v3Format,
            entries: canonical.entries,
            scope: canonical.scope,
            generation: 3,
          })}\n`,
        );
      },
      upgradeFromPrevious(previous) {
        upgrades.push("v2->v3");
        return { ...previous, format: v3Format };
      },
      referencedBlobOids(manifest) {
        return referencedTreeBlobOids(manifest.entries);
      },
    };
    const engine = createTreeFormatEngine(v3);
    expect(treeFormatChain(v3).map(({ format }) => format)).toEqual([
      TREE_MANIFEST_FORMAT_V1,
      TREE_FORMAT_V2.format,
      v3Format,
    ]);
    const v1Bytes = Buffer.from(
      `${JSON.stringify({
        format: TREE_MANIFEST_FORMAT_V1,
        entries: [],
        scope,
      })}\n`,
    );

    const historical = engine.parse(v1Bytes);
    expectFrozenManifestGraph(historical);
    const intermediate = engine.upgradeTo(
      historical,
      TREE_FORMAT_V2.format,
      DEFAULT_WORKSPACE_PATH_LIMITS,
    );
    expect(intermediate).toEqual({
      format: TREE_FORMAT_V2.format,
      entries: [],
      scope,
    });
    expectFrozenManifestGraph(intermediate);
    expect(upgrades).toEqual(["v1->v2"]);
    expect(
      engine.parse(
        v2.encode!(intermediate, {
          maxEntries: 100,
          maxManifestBytes: 1024,
          ...DEFAULT_WORKSPACE_PATH_LIMITS,
        }),
      ),
    ).toEqual(intermediate);

    upgrades.length = 0;
    const current = engine.upgradeTo(
      historical,
      v3Format,
      DEFAULT_WORKSPACE_PATH_LIMITS,
    );

    expect(current).toEqual({
      format: "cyclotomy-tree-v3-test",
      entries: [],
      scope,
    });
    expectFrozenManifestGraph(current);
    expect(upgrades).toEqual(["v1->v2", "v2->v3"]);
    const created = freezeTreeManifest(
      v3.create([], scope, {
        maxEntries: 100,
        maxManifestBytes: 1024,
        ...DEFAULT_WORKSPACE_PATH_LIMITS,
      }),
    );
    expectFrozenManifestGraph(created);
    expect(
      engine.parse(
        v3.encode!(created, {
          maxEntries: 100,
          maxManifestBytes: 1024,
          ...DEFAULT_WORKSPACE_PATH_LIMITS,
        }),
      ),
    ).toEqual(created);
    expect(
      engine.parse(
        v3.encode!(current, {
          maxEntries: 100,
          maxManifestBytes: 1024,
          ...DEFAULT_WORKSPACE_PATH_LIMITS,
        }),
      ),
    ).toEqual(current);
    expect(() =>
      engine.upgradeTo(
        current,
        TREE_FORMAT_V2.format,
        DEFAULT_WORKSPACE_PATH_LIMITS,
      ),
    ).toThrow("cannot be downgraded");
    expect(() =>
      engine.upgradeTo(
        historical,
        "cyclotomy-tree-unknown-test",
        DEFAULT_WORKSPACE_PATH_LIMITS,
      ),
    ).toThrow("outside the supported history");
  });

  it("deep-freezes explicit creation, decoding, and no-op upgrade results", () => {
    const engine = createTreeFormatEngine(TREE_FORMAT_V2);
    const limits = {
      maxEntries: 100,
      maxManifestBytes: 16 * 1024,
      ...DEFAULT_WORKSPACE_PATH_LIMITS,
    };
    const blobOid = "a".repeat(64);
    const input = {
      format: TREE_FORMAT_V2.format,
      entries: [
        {
          path: "file.txt",
          type: "regular" as const,
          blobOid,
          recreationMode: 0o644,
        },
      ],
      scope: {
        kind: "git" as const,
        repositoryPrefix: "",
        evaluator: null,
        ignoreCase: false,
        gitignoreSources: [{ path: ".gitignore", contentsBase64: "" }],
        infoExcludeBase64: "",
        globalExcludeBase64: "",
      },
    };

    const noOp = engine.upgradeTo(
      input,
      TREE_FORMAT_V2.format,
      DEFAULT_WORKSPACE_PATH_LIMITS,
    );
    expect(noOp).toBe(input);
    expectFrozenManifestGraph(noOp);
    expect(Reflect.set(noOp.entries[0]!, "blobOid", "b".repeat(64))).toBe(
      false,
    );
    expect(Reflect.set(noOp.scope, "repositoryPrefix", "mutated")).toBe(false);

    const created = freezeTreeManifest(
      TREE_FORMAT_V2.create(
        [
          {
            path: "created.txt",
            type: "regular",
            blobOid,
            recreationMode: 0o600,
          },
        ],
        { kind: "all-managed" },
        limits,
      ),
    );
    const decoded = engine.parse(TREE_FORMAT_V2.encode!(created, limits));
    expectFrozenManifestGraph(created);
    expectFrozenManifestGraph(decoded);
  });

  it("projects v2 Git provenance as unknown without changing historical bytes", () => {
    const engine = createTreeFormatEngine(TREE_FORMAT_V2);
    const limits = {
      maxEntries: 100,
      maxManifestBytes: 16 * 1024,
      ...DEFAULT_WORKSPACE_PATH_LIMITS,
    };
    const bytes = Buffer.from(
      `${JSON.stringify({
        format: TREE_FORMAT_V2.format,
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

    const parsed = engine.parse(bytes);
    expect(parsed.scope).toMatchObject({
      kind: "git",
      evaluator: null,
    });
    expect(TREE_FORMAT_V2.encode!(parsed, limits)).toEqual(bytes);
    expect(() =>
      engine.parse(
        Buffer.from(
          bytes
            .toString("utf8")
            .replace(
              '"ignoreCase":false',
              '"gitVersion":null,"ignoreCase":false',
            ),
        ),
      ),
    ).toThrow("invalid manifest");
  });

  it("rejects a malformed history when an adjacent upgrade is missing", () => {
    expect(() =>
      createTreeFormatEngine({
        format: "broken-v2",
        previous: TREE_FORMAT_V1,
        create: TREE_FORMAT_V1.create,
        decode: TREE_FORMAT_V1.decode!,
        encode: TREE_FORMAT_V1.encode!,
        referencedBlobOids: TREE_FORMAT_V1.referencedBlobOids,
      }),
    ).toThrow("omits its adjacent upgrade");
  });

  it("rejects an oldest format that claims a nonexistent predecessor upgrade", () => {
    expect(() =>
      createTreeFormatEngine({
        ...TREE_FORMAT_V1,
        upgradeFromPrevious: (manifest) => manifest,
      }),
    ).toThrow("first tree format cannot have an adjacent upgrade");
  });
});
