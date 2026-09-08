import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SyntheticGitDirectoryShape,
  type SyntheticGitShapePath,
} from "../src/infrastructure/synthetic-git-directory-shape.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});
const actualFs =
  await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const roots: string[] = [];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cyclotomy-shape-checks-"));
  roots.push(root);
  await mkdir(join(root, ".git"));
  const shape = new SyntheticGitDirectoryShape(root, []);
  const paths: SyntheticGitShapePath[] = Array.from(
    { length: 24 },
    (_, index) => ({
      path: `file-${String(index).padStart(3, "0")}`,
      kind: "non-directory",
    }),
  );
  return { root, shape, paths };
}

afterEach(async () => {
  vi.mocked(lstat).mockImplementation(actualFs.lstat);
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("synthetic Git filesystem checks", () => {
  it("bounds concurrent queries while checking every actual path", async () => {
    const { shape, paths } = await fixture();
    const concurrent = deferred();
    const release = deferred();
    let active = 0;
    let maximum = 0;
    const checked: string[] = [];
    vi.mocked(lstat).mockImplementation(async (...args) => {
      checked.push(basename(String(args[0])));
      active += 1;
      maximum = Math.max(maximum, active);
      if (active > 1) concurrent.resolve();
      try {
        await release.promise;
        return await actualFs.lstat(...args);
      } finally {
        active -= 1;
      }
    });
    const checking = shape.materialize(paths);
    try {
      await concurrent.promise;
      release.resolve();
      expect(await checking).toEqual(paths.map(() => true));
      expect(maximum).toBeGreaterThan(1);
      expect(maximum).toBeLessThanOrEqual(8);
      expect(active).toBe(0);
      expect(checked).toEqual(paths.map(({ path }) => path));
    } finally {
      release.resolve();
      await checking;
    }
  });

  it("settles failed checks in input order before returning and does not admit the failed query set", async () => {
    const { root, shape, paths } = await fixture();
    await mkdir(join(root, "file-001"));
    await mkdir(join(root, "file-005"));
    const laterFailure = deferred();
    const othersSettled = deferred();
    const releaseLast = deferred();
    const checked: string[] = [];
    let active = 0;
    let completed = 0;
    vi.mocked(lstat).mockImplementation(async (...args) => {
      const name = basename(String(args[0]));
      checked.push(name);
      active += 1;
      try {
        if (name === "file-001") await laterFailure.promise;
        if (name === "file-007") await releaseLast.promise;
        return await actualFs.lstat(...args);
      } finally {
        active -= 1;
        completed += 1;
        if (name === "file-005") laterFailure.resolve();
        if (completed === 7) othersSettled.resolve();
      }
    });
    let settled = false;
    const checking = shape.materialize(paths).then(
      () => {
        settled = true;
        return undefined;
      },
      (cause: unknown) => {
        settled = true;
        return cause;
      },
    );
    try {
      await othersSettled.promise;
      expect(settled).toBe(false);
      releaseLast.resolve();
      expect(await checking).toMatchObject({
        message: expect.stringContaining('"file-001"'),
      });
      expect(active).toBe(0);
      expect(checked).toEqual(paths.slice(0, 8).map(({ path }) => path));
      vi.mocked(lstat).mockImplementation(actualFs.lstat);
      expect(
        await shape.materialize([{ path: "file-009", kind: "directory" }]),
      ).toEqual([true]);
    } finally {
      laterFailure.resolve();
      releaseLast.resolve();
      await checking;
    }
  });
});
