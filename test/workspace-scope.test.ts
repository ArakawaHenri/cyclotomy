import { describe, expect, it } from "vitest";

import {
  canonicalizeWorkspaceScope,
  workspaceGitignoreSource,
} from "../src/infrastructure/workspace-scope.ts";

function gitScope(overrides: Record<string, unknown> = {}) {
  return {
    kind: "git",
    repositoryPrefix: "",
    evaluator: {
      version: "git version fixture",
      precomposeUnicode: false,
    },
    ignoreCase: false,
    gitignoreSources: [],
    infoExcludeBase64: "",
    globalExcludeBase64: "",
    ...overrides,
  };
}

describe("workspace scope", () => {
  it("canonicalizes current and legacy Git provenance explicitly", () => {
    expect(canonicalizeWorkspaceScope(gitScope())).toMatchObject({
      kind: "git",
      evaluator: {
        version: "git version fixture",
        precomposeUnicode: false,
      },
    });
    expect(
      canonicalizeWorkspaceScope(gitScope({ evaluator: null })),
    ).toMatchObject({
      kind: "git",
      evaluator: null,
    });
    expect(() =>
      canonicalizeWorkspaceScope(
        gitScope({
          evaluator: {
            version: "git version fixture\nforged",
            precomposeUnicode: false,
          },
        }),
      ),
    ).toThrow("printable ASCII line");
    expect(() =>
      canonicalizeWorkspaceScope(
        gitScope({ evaluator: { version: "git version fixture" } }),
      ),
    ).toThrow("invalid shape");
  });

  it("bounds Git version provenance to one safe printable ASCII line", () => {
    expect(() =>
      canonicalizeWorkspaceScope(
        gitScope({
          evaluator: {
            version: "x".repeat(256),
            precomposeUnicode: false,
          },
        }),
      ),
    ).not.toThrow();
    for (const gitVersion of [
      "x".repeat(257),
      "git version fixture\tforged",
      "git version fixture \u202e forged",
    ]) {
      expect(() =>
        canonicalizeWorkspaceScope(
          gitScope({
            evaluator: { version: gitVersion, precomposeUnicode: false },
          }),
        ),
      ).toThrow("printable ASCII line");
    }
  });

  it.each([
    [
      'Git ignore source ".gitignore"',
      {
        gitignoreSources: [
          workspaceGitignoreSource(".gitignore", Buffer.from([0x00])),
        ],
      },
    ],
    ["Git info/exclude", { infoExcludeBase64: "AA==" }],
    ["Git global excludes file", { globalExcludeBase64: "AA==" }],
  ])("rejects NUL in %s", (label, overrides) => {
    expect(() => canonicalizeWorkspaceScope(gitScope(overrides))).toThrow(
      `${label} contains a NUL byte`,
    );
  });

  it("preserves CRLF and non-UTF-8 policy bytes", () => {
    const bytes = Buffer.from([0xff, 0x0d, 0x0a]);
    const encoded = bytes.toString("base64");
    const scope = canonicalizeWorkspaceScope(
      gitScope({
        gitignoreSources: [workspaceGitignoreSource(".gitignore", bytes)],
        infoExcludeBase64: encoded,
        globalExcludeBase64: encoded,
      }),
    );
    expect(scope).toMatchObject({
      gitignoreSources: [{ contentsBase64: encoded }],
      infoExcludeBase64: encoded,
      globalExcludeBase64: encoded,
    });
  });

  it("identifies wide-text policy files without rejecting other raw encodings", () => {
    expect(() =>
      canonicalizeWorkspaceScope(
        gitScope({
          infoExcludeBase64: Buffer.from([0xff, 0xfe, 0x61, 0x00]).toString(
            "base64",
          ),
        }),
      ),
    ).toThrow("appears to be UTF-16/UTF-32");
  });
});
