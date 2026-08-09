import { describe, expect, it } from "vitest";

import type { WorkspaceRestorePlan } from "../src/infrastructure/restore-plan.ts";
import { CyclotomyI18n } from "../src/pi/i18n.ts";
import { formatUiDetail } from "../src/pi/restore-presentation.ts";

function plan(
  value: Pick<WorkspaceRestorePlan, "created" | "deleted" | "modified"> &
    Partial<WorkspaceRestorePlan>,
): WorkspaceRestorePlan {
  return {
    requiredBlobOids: [],
    scopeBlockers: [],
    occupancyChanged: [],
    problems: [],
    ...value,
  };
}

function preview(value: WorkspaceRestorePlan, sampleLimit?: number): string {
  return new CyclotomyI18n("en").formatRestorePreview(value, sampleLimit);
}

describe("restore presentation", () => {
  it("shows every action by default with deletions and overwrites first", () => {
    const result = preview(
      plan({
        created: Array.from({ length: 13 }, (_, index) => `a/new-${index}.txt`),
        deleted: ["z/old file.txt"],
        modified: ["y/main.ts"],
      }),
    );

    const lines = result.split("\n");
    expect(lines[0]).toBe("15 paths · -1 delete · ~1 overwrite · +13 create");
    expect(lines.slice(1, 3)).toEqual(["- z/old file.txt", "~ y/main.ts"]);
    expect(lines).toContain("+ a/new-12.txt");
    expect(result).not.toContain("more");
  });

  it("escapes terminal-sensitive paths so they cannot forge actions", () => {
    const result = preview(
      plan({
        created: ["created\n- forged-delete.txt"],
        deleted: ["escape\u001b[31mred.txt", "deleted\r\n+ forged-create.txt"],
        modified: [
          "c1\u009b31m.txt",
          "bidi\u202egnp.txt",
          'plain"quote.txt',
          "plain\\backslash.txt",
          " trailing-space ",
          "zero-width\u200bname.txt",
        ],
      }),
    );

    expect(result).toContain('+ "created\\n- forged-delete.txt"');
    expect(result).toContain('- "escape\\u001b[31mred.txt"');
    expect(result).toContain('- "deleted\\r\\n+ forged-create.txt"');
    expect(result).toContain('~ "c1\\u009b31m.txt"');
    expect(result).toContain('~ "bidi\\u202egnp.txt"');
    expect(result).toContain('~ "plain\\"quote.txt"');
    expect(result).toContain('~ "plain\\\\backslash.txt"');
    expect(result).toContain('~ " trailing-space "');
    expect(result).toContain('~ "zero-width\\u200bname.txt"');
    expect(result.split("\n")).not.toContain("- forged-delete.txt");
    expect(result.split("\n")).not.toContain("+ forged-create.txt");
    expect(result).not.toMatch(/[\u001b\u009b\u202e\u200b]/u);
  });

  it("reports the exact omitted action count", () => {
    const result = preview(
      plan({
        created: ["b", "c"],
        deleted: ["a"],
        modified: [],
      }),
      1,
    );

    expect(result).toContain("- a");
    expect(result).not.toContain("+ b");
    expect(result).toContain("… 2 more");
  });

  it("keeps both ends of long paths visible", () => {
    const longAscii = `src/${"nested/".repeat(24)}important-file.ts`;
    const longUnicode = `${"目录/".repeat(40)}最终文件.ts`;
    const result = preview(
      plan({
        created: [longAscii, `${longUnicode}\nunsafe-tail`],
        deleted: [],
        modified: [],
      }),
    );

    expect(result).toContain('"src/nested/');
    expect(result).toContain("…");
    expect(result).toContain('important-file.ts"');
    expect(result).toContain("最终文件.ts\\nunsafe-tail");
    expect(result).not.toMatch(/\nunsafe-tail/u);
    expect(result).not.toContain(longAscii);
  });

  it("marks incomplete previews and sanitizes host details", () => {
    const result = preview(
      plan({
        created: [],
        deleted: [],
        modified: [],
        problems: [
          {
            path: "secret\n+ forged",
            kind: "read-failed",
            detail: "denied",
          },
        ],
      }),
    );

    expect(result).toContain("Preview incomplete");
    expect(result).toContain('? cannot read · "secret\\n+ forged"');
    expect(formatUiDetail("failed\n\u001b[31m\u202eunsafe")).toBe(
      "failed\\n\\u001b[31m\\u202eunsafe",
    );
  });
});
