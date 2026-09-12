import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const PI_SPECIFIER =
  /["'](@earendil-works\/pi-coding-agent(?:\/[^"']*)?)["']/gu;
const PI_NAMED_IMPORT =
  /import\s+(?:type\s+)?\{(?<bindings>[\s\S]*?)\}\s+from\s+["']@earendil-works\/pi-coding-agent["']/gu;
const TEST_ONLY_LOADERS = [
  "loadEntriesFromFile",
  "migrateSessionEntries",
  "parseSessionEntries",
] as const;

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

describe("Pi public import boundary", () => {
  it("keeps production code on the package-root extension API", async () => {
    const root = resolve("src");
    const violations: string[] = [];
    for (const file of await sourceFiles(root)) {
      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(PI_SPECIFIER)) {
        if (match[1] !== PI_PACKAGE) {
          violations.push(`${relative(root, file)}: ${match[1]}`);
        }
      }
      for (const match of source.matchAll(PI_NAMED_IMPORT)) {
        const bindings = match.groups?.bindings ?? "";
        for (const loader of TEST_ONLY_LOADERS) {
          if (new RegExp(`\\b${loader}\\b`, "u").test(bindings)) {
            violations.push(`${relative(root, file)}: ${loader}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
