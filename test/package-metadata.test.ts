import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

interface RootPackageMetadata {
  readonly name: string;
  readonly version: string;
  readonly license?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly peerDependenciesMeta?: Readonly<Record<string, unknown>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly engines?: Readonly<Record<string, string>>;
}

interface PackageLock {
  readonly packages: Readonly<Record<string, RootPackageMetadata>>;
}

const ROOT_METADATA_FIELDS = [
  "name",
  "version",
  "license",
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "devDependencies",
  "engines",
] as const satisfies readonly (keyof RootPackageMetadata)[];

async function readJson<T>(relativePath: string): Promise<T> {
  return JSON.parse(
    await readFile(new URL(relativePath, import.meta.url), "utf8"),
  ) as T;
}

describe("package metadata", () => {
  it("keeps package-lock root metadata synchronized with package.json", async () => {
    const manifest = await readJson<RootPackageMetadata>("../package.json");
    const lock = await readJson<PackageLock>("../package-lock.json");
    const lockedRoot = lock.packages[""];

    expect(lockedRoot).toBeDefined();
    for (const field of ROOT_METADATA_FIELDS) {
      expect(lockedRoot?.[field], `root package-lock field ${field}`).toEqual(
        manifest[field],
      );
    }
  });
});
