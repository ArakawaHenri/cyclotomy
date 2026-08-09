import {
  canonicalizeWorkspaceScope,
  workspaceGitignoreSource,
  type GitWorkspaceScope,
} from "../src/infrastructure/workspace-scope.ts";

export const ALL_MANAGED_SCOPE = { kind: "all-managed" } as const;

interface GitScopeFixtureOptions {
  readonly repositoryPrefix?: string;
  readonly ignoreCase?: boolean;
  readonly gitignoreSources?: readonly {
    readonly path: string;
    readonly contents: string | Uint8Array;
  }[];
  readonly infoExclude?: string | Uint8Array;
  readonly globalExclude?: string | Uint8Array;
}

function bytes(value: string | Uint8Array | undefined): Buffer {
  if (value === undefined) return Buffer.alloc(0);
  return typeof value === "string"
    ? Buffer.from(value, "utf8")
    : Buffer.from(value);
}

/** Build the same canonical, byte-preserving Git policy shape used in trees. */
export function gitScope(
  options: GitScopeFixtureOptions = {},
): GitWorkspaceScope {
  const scope = canonicalizeWorkspaceScope({
    kind: "git",
    repositoryPrefix: options.repositoryPrefix ?? "",
    ignoreCase: options.ignoreCase ?? false,
    gitignoreSources: (options.gitignoreSources ?? []).map((source) =>
      workspaceGitignoreSource(source.path, bytes(source.contents)),
    ),
    infoExcludeBase64: bytes(options.infoExclude).toString("base64"),
    globalExcludeBase64: bytes(options.globalExclude).toString("base64"),
  });
  if (scope.kind !== "git") throw new Error("expected a Git workspace scope");
  return scope;
}
