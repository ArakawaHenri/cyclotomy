import {
  mkdtemp,
  mkdir,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertSessionWorkspaceStillBound,
  bindSessionWorkspace,
  sessionWorkspaceStillBound,
} from "../src/pi/workspace-binding.ts";

const roots: string[] = [];

async function testRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cyclotomy-binding-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("session workspace binding", () => {
  it("binds two aliases only when they name the same directory object", async () => {
    const root = await testRoot();
    const workspace = join(root, "workspace");
    const alias = join(root, "alias");
    await mkdir(workspace);
    await symlink(
      workspace,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );

    const binding = await bindSessionWorkspace(alias, workspace);
    expect(binding.canonicalPath).toBe(await realpath(workspace));
    expect(() =>
      assertSessionWorkspaceStillBound(binding, alias, workspace),
    ).not.toThrow();
  });

  it("rejects independently valid paths that name different workspaces", async () => {
    const root = await testRoot();
    const first = join(root, "first");
    const second = join(root, "second");
    await mkdir(first);
    await mkdir(second);

    await expect(bindSessionWorkspace(first, second)).rejects.toThrow(
      "outside its persisted workspace",
    );
  });

  it("rejects an alias rebound after the initial authority was established", async () => {
    const root = await testRoot();
    const first = join(root, "first");
    const second = join(root, "second");
    const alias = join(root, "alias");
    await mkdir(first);
    await mkdir(second);
    await symlink(
      first,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const binding = await bindSessionWorkspace(alias, alias);

    await rm(alias, { force: true });
    await symlink(
      second,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );

    expect(() =>
      assertSessionWorkspaceStillBound(binding, alias, alias),
    ).toThrow("workspace changed");
  });

  it("rejects a directory recreated at the same canonical path", async () => {
    const root = await testRoot();
    const workspace = join(root, "workspace");
    const displaced = join(root, "displaced");
    await mkdir(workspace);
    const binding = await bindSessionWorkspace(workspace, workspace);

    await rename(workspace, displaced);
    await mkdir(workspace);

    expect(() =>
      assertSessionWorkspaceStillBound(binding, workspace, workspace),
    ).toThrow("workspace changed");
    await expect(
      sessionWorkspaceStillBound(binding, workspace, workspace),
    ).resolves.toBe(false);
  });
});
