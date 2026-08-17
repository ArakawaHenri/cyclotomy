import {
  link,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  openPrivateFileIfPresent,
  observePrivateFile,
  revalidateOpenedPrivateFile,
} from "../src/infrastructure/content-store/private-file.ts";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cyclotomy-private-file-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("private content-store files", () => {
  it("treats only the initial missing pathname as an admissible miss", async () => {
    const root = await temporaryRoot();
    await expect(
      openPrivateFileIfPresent(join(root, "missing")),
    ).resolves.toBeUndefined();
  });

  it("binds one regular file observation to its opened pathname", async () => {
    const root = await temporaryRoot();
    const path = join(root, "object");
    await writeFile(path, "stable");
    const expected = await observePrivateFile(path);
    const opened = await openPrivateFileIfPresent(path, expected.identity);
    expect(opened).toBeDefined();
    try {
      expect(opened!.identity).toEqual(expected.identity);
      await expect(
        revalidateOpenedPrivateFile(opened!),
      ).resolves.toBeUndefined();
    } finally {
      await opened?.handle.close();
    }
  });

  it("rejects symbolic links and multiply-linked files", async () => {
    const root = await temporaryRoot();
    const target = join(root, "target");
    const symbolic = join(root, "symbolic");
    const hard = join(root, "hard");
    await writeFile(target, "private");
    await symlink(target, symbolic);
    await expect(observePrivateFile(symbolic)).rejects.toMatchObject({
      code: "namespace-invalid",
    });

    await link(target, hard);
    await expect(observePrivateFile(target)).rejects.toMatchObject({
      code: "namespace-invalid",
    });
  });

  it("rejects a discovered identity that was replaced before open", async () => {
    const root = await temporaryRoot();
    const path = join(root, "object");
    const replacement = join(root, "replacement");
    await writeFile(path, "before");
    const expected = await observePrivateFile(path);
    await writeFile(replacement, "after");
    await rename(replacement, path);

    await expect(
      openPrivateFileIfPresent(path, expected.identity),
    ).rejects.toMatchObject({ code: "namespace-invalid" });
  });

  it("rejects pathname replacement after a file was opened", async (context) => {
    context.skip(
      process.platform === "win32",
      "Windows does not allow replacing an open file",
    );
    const root = await temporaryRoot();
    const path = join(root, "object");
    const replacement = join(root, "replacement");
    await writeFile(path, "before");
    const opened = await openPrivateFileIfPresent(path);
    expect(opened).toBeDefined();
    try {
      await writeFile(replacement, "after");
      await rename(replacement, path);
      await expect(revalidateOpenedPrivateFile(opened!)).rejects.toMatchObject({
        code: "namespace-invalid",
      });
    } finally {
      await opened?.handle.close();
    }
  });
});
