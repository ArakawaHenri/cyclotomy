import { mkdirSync, renameSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createPrivateScratchRoot,
  PrivateScratchRootError,
} from "../src/infrastructure/private-scratch-root.ts";

describe("private scratch root", () => {
  let testRoot: string;

  beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "cyclotomy-private-scratch-test-"));
  });

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  it("selects the nearest physical ancestor outside a forbidden root", async () => {
    const forbidden = join(testRoot, "managed");
    const preferred = join(forbidden, "nested", "tmp");
    await mkdir(preferred, { recursive: true });

    const scratch = await createPrivateScratchRoot({
      parent: preferred,
      parentPolicy: "nearest-safe-ancestor",
      forbiddenRoots: [forbidden],
      prefix: "scratch-",
    });
    const [selected, expected] = await Promise.all([
      lstat(dirname(await realpath(scratch.path))),
      lstat(await realpath(testRoot)),
    ]);
    expect({ dev: selected.dev, ino: selected.ino }).toEqual({
      dev: expected.dev,
      ino: expected.ino,
    });

    await scratch.dispose();
    await scratch.dispose();
    expect((await readdir(testRoot)).sort()).toEqual(["managed"]);
  });

  it("rejects a parent replaced between selection and creation", async () => {
    const parent = join(testRoot, "parent");
    const displaced = join(testRoot, "parent-original");
    await mkdir(parent);
    let replaced = false;
    const options = {
      parent,
      parentPolicy: "exact" as const,
      get prefix(): string {
        renameSync(parent, displaced);
        mkdirSync(parent);
        replaced = true;
        return "scratch-";
      },
    };

    await expect(createPrivateScratchRoot(options)).rejects.toMatchObject({
      code: "creation-invalid",
    } satisfies Partial<PrivateScratchRootError>);
    expect(replaced).toBe(true);
    expect(await readdir(displaced)).toEqual([]);
    // Authentication failure never recursively removes through the replaced
    // parent, even though mkdtemp created an empty directory there.
    expect(await readdir(parent)).toHaveLength(1);
  });

  it("caches failed disposal and preserves a replacement root", async () => {
    const parent = join(testRoot, "parent");
    await mkdir(parent);
    const scratch = await createPrivateScratchRoot({
      parent,
      parentPolicy: "exact",
      prefix: "scratch-",
    });
    await writeFile(join(scratch.path, "owned"), "original");
    const displaced = join(parent, "displaced-original");
    await rename(scratch.path, displaced);
    await mkdir(scratch.path);
    const sentinel = join(scratch.path, "sentinel");
    await writeFile(sentinel, "replacement");

    const first = scratch.dispose();
    const second = scratch.dispose();
    expect(second).toBe(first);
    await expect(first).rejects.toMatchObject({
      code: "cleanup-replaced",
    } satisfies Partial<PrivateScratchRootError>);
    await expect(readFile(sentinel, "utf8")).resolves.toBe("replacement");
    await expect(readFile(join(displaced, "owned"), "utf8")).resolves.toBe(
      "original",
    );
  });

  it("does not report cleanup success after the owned parent is replaced", async () => {
    const parent = join(testRoot, "parent");
    const displacedParent = join(testRoot, "parent-original");
    await mkdir(parent);
    const scratch = await createPrivateScratchRoot({
      parent,
      parentPolicy: "exact",
      prefix: "scratch-",
    });
    await writeFile(join(scratch.path, "owned"), "original");
    const displacedRoot = join(displacedParent, basename(scratch.path));
    await rename(parent, displacedParent);
    await mkdir(parent);

    await expect(scratch.dispose()).rejects.toMatchObject({
      code: "cleanup-replaced",
    } satisfies Partial<PrivateScratchRootError>);
    await expect(readFile(join(displacedRoot, "owned"), "utf8")).resolves.toBe(
      "original",
    );
  });
});
