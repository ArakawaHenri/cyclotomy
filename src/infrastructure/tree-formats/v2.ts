import {
  ABSOLUTE_TREE_MANIFEST_LIMITS,
  assertTreeManifestLimits,
  canonicalizeTreeManifestUsingScopeCodec,
  exactKeys,
  invalidManifest,
  TreeManifestError,
  type TreeManifestLimits,
} from "./manifest-codec.ts";
import type { TreeFormatNode } from "./chain.ts";
import { referencedTreeBlobOids } from "./references.ts";
import { TREE_FORMAT_V1 } from "./v1.ts";
import type { WorkspaceScope } from "../workspace-scope.ts";
import { canonicalizeV2WorkspaceScope } from "./v2-workspace-scope.ts";

export const TREE_MANIFEST_FORMAT_V2 = "cyclotomy-tree-v2";

const V2_GIT_SCOPE_KEYS = [
  "kind",
  "repositoryPrefix",
  "ignoreCase",
  "gitignoreSources",
  "infoExcludeBase64",
  "globalExcludeBase64",
] as const;

const PROJECTED_V2_GIT_SCOPE_KEYS = [
  ...V2_GIT_SCOPE_KEYS,
  "evaluator",
] as const;

/** Strip the in-memory legacy projection back to the published v2 wire. */
function v2WireScope(value: unknown, allowProjected: boolean): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== "git") return value;
  if (exactKeys(candidate, V2_GIT_SCOPE_KEYS)) return value;
  if (
    allowProjected &&
    exactKeys(candidate, PROJECTED_V2_GIT_SCOPE_KEYS) &&
    candidate.evaluator === null
  ) {
    return {
      kind: candidate.kind,
      repositoryPrefix: candidate.repositoryPrefix,
      ignoreCase: candidate.ignoreCase,
      gitignoreSources: candidate.gitignoreSources,
      infoExcludeBase64: candidate.infoExcludeBase64,
      globalExcludeBase64: candidate.globalExcludeBase64,
    };
  }
  return invalidManifest(
    "tree format v2 has an invalid or unrepresentable Git scope",
  );
}

function canonicalizeV2TreeManifest(
  entries: unknown,
  scope: unknown,
  limits: TreeManifestLimits,
  allowProjected: boolean,
) {
  return canonicalizeTreeManifestUsingScopeCodec(
    entries,
    v2WireScope(scope, allowProjected),
    limits,
    canonicalizeV2WorkspaceScope,
  );
}

function encodeV2TreeManifest(
  entries: unknown,
  scope: unknown,
  limits: TreeManifestLimits,
): Buffer {
  assertTreeManifestLimits(limits);
  const canonical = canonicalizeV2TreeManifest(entries, scope, limits, true);
  const legacyScope =
    canonical.scope.kind === "all-managed"
      ? canonical.scope
      : {
          kind: canonical.scope.kind,
          repositoryPrefix: canonical.scope.repositoryPrefix,
          ignoreCase: canonical.scope.ignoreCase,
          gitignoreSources: canonical.scope.gitignoreSources,
          infoExcludeBase64: canonical.scope.infoExcludeBase64,
          globalExcludeBase64: canonical.scope.globalExcludeBase64,
        };
  const encoded = Buffer.from(
    `${JSON.stringify({
      format: TREE_MANIFEST_FORMAT_V2,
      entries: canonical.entries,
      scope: legacyScope,
    })}\n`,
    "utf8",
  );
  if (encoded.byteLength > limits.maxManifestBytes) {
    invalidManifest(
      `tree manifest is ${encoded.byteLength} bytes, exceeding the ${limits.maxManifestBytes}-byte limit`,
    );
  }
  return encoded;
}

export const TREE_FORMAT_V2 = Object.freeze<
  TreeFormatNode<typeof TREE_MANIFEST_FORMAT_V2>
>({
  format: TREE_MANIFEST_FORMAT_V2,
  previous: TREE_FORMAT_V1,
  create(entries, scope, limits) {
    const canonical = canonicalizeV2TreeManifest(entries, scope, limits, true);
    return { format: TREE_MANIFEST_FORMAT_V2, ...canonical };
  },
  decode(candidate, limits) {
    if (!exactKeys(candidate, ["format", "entries", "scope"])) {
      invalidManifest("tree format v2 has noncanonical fields");
    }
    const canonical = canonicalizeV2TreeManifest(
      candidate.entries,
      candidate.scope,
      limits,
      false,
    );
    return { format: TREE_MANIFEST_FORMAT_V2, ...canonical };
  },
  encode(manifest, limits) {
    return encodeV2TreeManifest(manifest.entries, manifest.scope, limits);
  },
  upgradeFromPrevious(previous, pathLimits) {
    try {
      const legacyScope: WorkspaceScope =
        previous.scope.kind === "all-managed"
          ? previous.scope
          : {
              ...previous.scope,
              evaluator: null,
            };
      const canonical = canonicalizeV2TreeManifest(
        previous.entries,
        legacyScope,
        { ...ABSOLUTE_TREE_MANIFEST_LIMITS, ...pathLimits },
        true,
      );
      return { format: TREE_MANIFEST_FORMAT_V2, ...canonical };
    } catch (error) {
      if (
        !(error instanceof TreeManifestError) ||
        error.kind !== "invalid-tree-manifest"
      ) {
        throw error;
      }
      throw new TreeManifestError(
        "format-incompatible",
        `tree format v1 cannot be represented by the v2 contract: ${error.message}`,
        error,
      );
    }
  },
  referencedBlobOids(manifest) {
    return referencedTreeBlobOids(manifest.entries);
  },
});
