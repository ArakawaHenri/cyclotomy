import { mkdtemp, rm, lstat, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { loadNativeFileLock } from "../src/infrastructure/native-file-lock.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function path() {
  const root = await mkdtemp(join(tmpdir(), "cyclotomy-native-lock-"));
  roots.push(root);
  return join(root, "锁🔒.lock");
}

it("reports the identity of the held file after its path is replaced", async () => {
  const binding = await loadNativeFileLock();
  const target = await path();
  const file = binding.open(target, true);
  try {
    const identity = file.stat();
    expect(identity).toMatchObject(
      await lstat(target, { bigint: true }).then(
        ({ dev, ino, mode, size, nlink }) => ({ dev, ino, mode, size, nlink }),
      ),
    );
    await rename(target, `${target}.old`);
    await writeFile(target, "");
    expect(file.stat()).toEqual(identity);
    expect(file.stat().ino).not.toBe(
      (await lstat(target, { bigint: true })).ino,
    );
  } finally {
    file.close();
  }
});

it("never replaces an existing file during exclusive creation", async () => {
  const binding = await loadNativeFileLock();
  const target = await path();
  const first = binding.open(target, true);
  try {
    expect(() => binding.open(target, true)).toThrow(
      expect.objectContaining({ code: "EEXIST" }),
    );
    expect(binding.tryAcquire(first)).toBe(true);
  } finally {
    first.close();
  }
});

it("rejects closed handles without touching a subsequently opened file", async () => {
  const binding = await loadNativeFileLock();
  const target = await path();
  const first = binding.open(target, true);
  first.close();
  const next = binding.open(target);
  try {
    first.close();
    expect(() => first.tryLock()).toThrow(
      expect.objectContaining({ code: "EBADF" }),
    );
    expect(() => first.stat()).toThrow(
      expect.objectContaining({ code: "EBADF" }),
    );
    expect(binding.tryAcquire(next)).toBe(true);
    expect(() => next.tryLock.call({})).toThrow(TypeError);
  } finally {
    next.close();
  }
});
