import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
function privatePiImports(source: string): string[] {
  const file = ts.createSourceFile(
    "extension.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    const specifier =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ImportKeyword
          ? node.arguments[0]
          : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
            ? node.argument.literal
            : undefined;
    if (
      specifier !== undefined &&
      ts.isStringLiteralLike(specifier) &&
      specifier.text.startsWith(`${PI_PACKAGE}/`)
    )
      violations.push(specifier.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return violations;
}

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
  it("accepts local helper names, public imports and comments", () => {
    expect(
      privatePiImports(`
      import { parseSessionEntries } from "./local-helper.ts";
      import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
      // import { anything } from "@earendil-works/pi-coding-agent/dist/private.js";
    `),
    ).toEqual([]);
  });

  it("identifies private imports, re-exports and dynamic imports", () => {
    const privatePath = `${PI_PACKAGE}/dist/private.js`;
    expect(
      privatePiImports(`
      import { value } from "${privatePath}";
      export { value } from "${privatePath}";
      const module = import("${privatePath}");
      type Value = import("${privatePath}").Value;
    `),
    ).toEqual([privatePath, privatePath, privatePath, privatePath]);
  });

  it("keeps production code on the package-root extension API", async () => {
    const root = resolve("src");
    const violations: string[] = [];
    for (const file of await sourceFiles(root)) {
      const source = await readFile(file, "utf8");
      for (const specifier of privatePiImports(source))
        violations.push(`${relative(root, file)}: ${specifier}`);
    }

    expect(violations).toEqual([]);
  });
});
