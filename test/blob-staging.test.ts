import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { stageBlobs } from "../src/infrastructure/blob-staging.ts";

describe("operation-local blob staging", () => {
  let testRoot: string;
  let workspaceRoot: string;
  let stagingParent: string;

  beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "cyclotomy-blob-staging-test-"));
    workspaceRoot = join(testRoot, "workspace");
    stagingParent = join(testRoot, "scratch");
    await Promise.all([mkdir(workspaceRoot), mkdir(stagingParent)]);
  });

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  it("reads each distinct oid once and becomes unusable after disposal", async () => {
    const contents = new Map([
      ["a", Buffer.from("alpha")],
      ["b", Buffer.from("beta")],
    ]);
    const readBlob = vi.fn(async (oid: string) => {
      const content = contents.get(oid);
      if (content === undefined) {
        throw new Error(`unexpected oid ${oid}`);
      }
      return content;
    });

    const staged = await stageBlobs(["a", "a", "b", "a", "b"], readBlob, {
      workspaceRoot,
      stagingParent,
    });
    expect(readBlob.mock.calls.map(([oid]) => oid)).toEqual(["a", "b"]);
    expect(Buffer.from(await staged.readBlob("a")).toString()).toBe("alpha");
    expect(Buffer.from(await staged.readBlob("b")).toString()).toBe("beta");

    await staged.dispose();
    await staged.dispose();
    await expect(staged.readBlob("a")).rejects.toThrow(/disposed/);
  });

  it("does not expose a partial set when preparation fails", async () => {
    const readBlob = vi.fn(async (oid: string) => {
      if (oid === "b") {
        throw new Error("broken b");
      }
      return Buffer.from(oid);
    });

    await expect(
      stageBlobs(["a", "b", "c"], readBlob, {
        workspaceRoot,
        stagingParent,
      }),
    ).rejects.toThrow("broken b");
    expect(readBlob.mock.calls.map(([oid]) => oid)).toEqual(["a", "b"]);
  });

  it("rejects a staging parent inside the workspace before mutation", async () => {
    const nestedStagingParent = join(workspaceRoot, "tmp");
    await mkdir(nestedStagingParent);
    const before = await readdir(workspaceRoot);
    const readBlob = vi.fn(async () => Buffer.from("content"));

    await expect(
      stageBlobs(["a"], readBlob, {
        workspaceRoot,
        stagingParent: nestedStagingParent,
      }),
    ).rejects.toThrow(/outside managed roots/);

    expect(readBlob).not.toHaveBeenCalled();
    expect(await readdir(workspaceRoot)).toEqual(before);
  });

  it("rejects a staging parent inside another controlled root", async () => {
    const before = await readdir(stagingParent);
    const readBlob = vi.fn(async () => Buffer.from("content"));

    await expect(
      stageBlobs(["a"], readBlob, {
        workspaceRoot,
        forbiddenRoots: [stagingParent],
        stagingParent,
      }),
    ).rejects.toThrow(/outside managed roots/);

    expect(readBlob).not.toHaveBeenCalled();
    expect(await readdir(stagingParent)).toEqual(before);
  });
});
