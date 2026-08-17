import { describe, expect, it } from "vitest";

import { gitReplayRisk } from "../src/infrastructure/git-replay-risk.ts";
import { gitScope } from "./workspace-scope-fixture.ts";

describe("Git replay risk", () => {
  it("has no external-evaluator risk for an all-managed scope", () => {
    expect(gitReplayRisk({ kind: "all-managed" }, "git version 9.9.9")).toEqual(
      { kind: "none" },
    );
  });

  it("marks legacy Git provenance as unattested", () => {
    expect(
      gitReplayRisk(gitScope({ evaluator: null }), "git version 2.54.0"),
    ).toEqual({
      kind: "legacy-unattested",
      currentGitVersion: "git version 2.54.0",
    });
  });

  it("distinguishes exact evaluator provenance from a version mismatch", () => {
    const scope = gitScope({
      evaluator: {
        version: "git version 2.50.1",
        precomposeUnicode: false,
      },
    });
    expect(gitReplayRisk(scope, "git version 2.50.1")).toEqual({
      kind: "none",
    });
    expect(gitReplayRisk(scope, "git version 2.54.0")).toEqual({
      kind: "version-mismatch",
      capturedGitVersion: "git version 2.50.1",
      currentGitVersion: "git version 2.54.0",
    });
  });
});
