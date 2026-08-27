import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  stageBlobs,
  type StagedBlobs,
} from "../src/infrastructure/blob-staging.ts";

function oidFor(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

async function readStaged(staged: StagedBlobs, oid: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const { decodedLength } = await staged.streamBlob(oid, async (chunk) => {
    chunks.push(Buffer.from(chunk));
  });
  return Buffer.concat(chunks, decodedLength);
}

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

  it("streams each distinct oid once and becomes unusable after disposal", async () => {
    const alpha = Buffer.from("alpha");
    const beta = Buffer.from("beta");
    const alphaOid = oidFor(alpha);
    const betaOid = oidFor(beta);
    const contents = new Map([
      [alphaOid, alpha],
      [betaOid, beta],
    ]);
    const streamBlob = vi.fn(async (oid: string, sink) => {
      const content = contents.get(oid);
      if (content === undefined) {
        throw new Error(`unexpected oid ${oid}`);
      }
      await sink(content);
      return { decodedLength: content.byteLength };
    });

    const staged = await stageBlobs(
      [alphaOid, alphaOid, betaOid, alphaOid, betaOid],
      streamBlob,
      { workspaceRoot, stagingParent },
    );
    expect(streamBlob.mock.calls.map(([oid]) => oid)).toEqual([
      alphaOid,
      betaOid,
    ]);
    expect((await readStaged(staged, alphaOid)).toString()).toBe("alpha");
    expect((await readStaged(staged, betaOid)).toString()).toBe("beta");

    await staged.dispose();
    await staged.dispose();
    await expect(staged.streamBlob(alphaOid, async () => {})).rejects.toThrow(
      /disposed/,
    );
  });

  it("does not expose a partial set when preparation fails", async () => {
    const first = Buffer.from("first");
    const broken = Buffer.from("broken");
    const third = Buffer.from("third");
    const firstOid = oidFor(first);
    const brokenOid = oidFor(broken);
    const thirdOid = oidFor(third);
    const streamBlob = vi.fn(async (oid: string, sink) => {
      if (oid === brokenOid) {
        throw new Error("broken blob");
      }
      const content = oid === firstOid ? first : third;
      await sink(content);
      return { decodedLength: content.byteLength };
    });

    await expect(
      stageBlobs([firstOid, brokenOid, thirdOid], streamBlob, {
        workspaceRoot,
        stagingParent,
      }),
    ).rejects.toThrow("broken blob");
    expect(streamBlob.mock.calls.map(([oid]) => oid)).toEqual([
      firstOid,
      brokenOid,
    ]);
  });

  it("rejects staged bytes that do not match their content id", async () => {
    const oid = oidFor(Buffer.from("expected"));

    await expect(
      stageBlobs(
        [oid],
        async (_oid, sink) => {
          const content = Buffer.from("different");
          await sink(content);
          return { decodedLength: content.byteLength };
        },
        { workspaceRoot, stagingParent },
      ),
    ).rejects.toThrow("staged blob bytes do not match their content id");
  });

  it("rejects a staging parent inside the workspace before mutation", async () => {
    const nestedStagingParent = join(workspaceRoot, "tmp");
    await mkdir(nestedStagingParent);
    const before = await readdir(workspaceRoot);
    const streamBlob = vi.fn(async () => ({ decodedLength: 0 }));
    const oid = oidFor(Buffer.alloc(0));

    await expect(
      stageBlobs([oid], streamBlob, {
        workspaceRoot,
        stagingParent: nestedStagingParent,
      }),
    ).rejects.toThrow(/outside managed roots/);

    expect(streamBlob).not.toHaveBeenCalled();
    expect(await readdir(workspaceRoot)).toEqual(before);
  });

  it("rejects a staging parent inside another controlled root", async () => {
    const before = await readdir(stagingParent);
    const streamBlob = vi.fn(async () => ({ decodedLength: 0 }));
    const oid = oidFor(Buffer.alloc(0));

    await expect(
      stageBlobs([oid], streamBlob, {
        workspaceRoot,
        forbiddenRoots: [stagingParent],
        stagingParent,
      }),
    ).rejects.toThrow(/outside managed roots/);

    expect(streamBlob).not.toHaveBeenCalled();
    expect(await readdir(stagingParent)).toEqual(before);
  });
});
