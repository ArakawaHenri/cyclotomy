import { describe, expect, it } from "vitest";

import type { WorkspaceRestorePlan } from "../src/infrastructure/restore-plan.ts";
import { CyclotomyI18n } from "../src/pi/i18n.ts";
import { notifyPostMutationConflict } from "../src/pi/restore-outcome.ts";
import { formatUiDetail } from "../src/pi/restore-presentation.ts";
import type { CyclotomyRuntime } from "../src/pi/runtime.ts";

function plan(
  value: Pick<WorkspaceRestorePlan, "created" | "deleted" | "modified"> &
    Partial<WorkspaceRestorePlan>,
): WorkspaceRestorePlan {
  return {
    renamed: [],
    requiredBlobOids: [],
    scopeBlockers: [],
    occupancyChanged: [],
    problems: [],
    ...value,
  };
}

function preview(value: WorkspaceRestorePlan): string {
  return new CyclotomyI18n("en").formatRestorePreview(value);
}

describe("restore presentation", () => {
  it("shows every action by default with deletions and overwrites first", () => {
    const result = preview(
      plan({
        created: Array.from({ length: 13 }, (_, index) => `a/new-${index}.txt`),
        deleted: ["z/old file.txt"],
        modified: ["y/main.ts"],
        renamed: [{ from: "x/Old", to: "x/old" }],
      }),
    );

    const lines = result.split("\n");
    expect(lines[0]).toBe(
      "16 paths · -1 delete · ~1 overwrite · >1 rename · +13 create",
    );
    expect(lines.slice(1, 4)).toEqual([
      "- z/old file.txt",
      "~ y/main.ts",
      "> x/Old → x/old",
    ]);
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

  it("shows complete long paths while escaping unsafe characters", () => {
    const longAscii = `src/${"nested/".repeat(24)}important-file.ts`;
    const longUnicode = `${"目录/".repeat(40)}最终文件.ts`;
    const result = preview(
      plan({
        created: [longAscii, `${longUnicode}\nunsafe-tail`],
        deleted: [],
        modified: [],
      }),
    );

    expect(result).toContain(`+ ${longAscii}`);
    expect(result).toContain(`+ "${longUnicode}\\nunsafe-tail"`);
    expect(result).not.toMatch(/\nunsafe-tail/u);
    expect(result).not.toContain("…");
  });

  it("flags portable case aliases of an ignore-policy path", () => {
    const result = preview(
      plan({
        created: ["nested/.GITIGNORE"],
        deleted: [],
        modified: [],
      }),
    );

    expect(result).toContain("ignore rules will also be restored");
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

  it("reports verify-failed mutations before a late target conflict", () => {
    const notifications: Array<{
      readonly message: string;
      readonly level: "info" | "warning" | "error";
    }> = [];
    const runtime = {
      i18n: new CyclotomyI18n("en"),
      notify: (
        _context: unknown,
        message: string,
        level: "info" | "warning" | "error",
      ) => notifications.push({ message, level }),
    } as unknown as CyclotomyRuntime;

    notifyPostMutationConflict(runtime, {} as never, {
      kind: "post-mutation-conflict",
      reason: "target-changed",
      outcome: {
        kind: "verify-failed",
        reason: "mismatch",
        treeOid: "a".repeat(64),
        report: {
          created: [],
          updated: ["changed.txt"],
          deleted: [],
          renamed: [],
          unchangedCount: 0,
          problems: [],
        },
      },
      arrivalProtection: { kind: "protected" },
    });

    expect(notifications).toHaveLength(2);
    expect(notifications[0]).toMatchObject({ level: "error" });
    expect(notifications[0]?.message).toContain("Files changed");
    expect(notifications[0]?.message).toContain("~ changed.txt");
    expect(notifications[1]).toMatchObject({ level: "warning" });
    expect(notifications[1]?.message).toContain(
      "entered the file-application phase before the checkpoint target changed",
    );
    expect(
      notifications.map(({ message }) => message).join("\n"),
    ).not.toContain("Nothing was applied");
  });

  it("sanitizes both control and protection failures in post-mutation notifications", () => {
    const notifications: string[] = [];
    const runtime = {
      i18n: new CyclotomyI18n("en"),
      notify: (_context: unknown, message: string) =>
        notifications.push(message),
    } as unknown as CyclotomyRuntime;

    notifyPostMutationConflict(runtime, {} as never, {
      kind: "post-mutation-conflict",
      reason: "control-failed",
      outcome: {
        kind: "failed",
        stage: "apply",
        message: "apply stopped",
      },
      message: "control\n\u001b[31mforged",
      arrivalProtection: {
        kind: "unavailable",
        message: "protect\n\u001b[32mforged",
      },
    });

    const output = notifications.join("\n");
    expect(output).toContain("control\\n\\u001b[31mforged");
    expect(output).toContain("protect\\n\\u001b[32mforged");
    expect(output).not.toMatch(/[\u001b]/u);
    expect(output.split("\n")).not.toContain("forged");
  });

  it("reports a durable pending node guard without claiming a node was protected", () => {
    const notifications: string[] = [];
    const runtime = {
      i18n: new CyclotomyI18n("en"),
      notify: (_context: unknown, message: string) =>
        notifications.push(message),
    } as unknown as CyclotomyRuntime;

    notifyPostMutationConflict(runtime, {} as never, {
      kind: "post-mutation-conflict",
      reason: "location-changed",
      outcome: {
        kind: "restored",
        treeOid: "a".repeat(64),
        report: {
          created: [],
          updated: [],
          deleted: [],
          renamed: [],
          unchangedCount: 1,
          problems: [],
        },
      },
      arrivalProtection: { kind: "pending-node-guard" },
    });

    const output = notifications.join("\n");
    expect(output).toContain("pending checkpoint guard");
    expect(output).toContain("/reload");
    expect(output).not.toContain("write-protected the current arrival");
  });

  it("lists every applied mutation by destructive priority including directory renames", () => {
    const i18n = new CyclotomyI18n("en");
    const report = {
      created: Array.from({ length: 13 }, (_, index) => `new-${index}`),
      updated: ["overwrite"],
      deleted: ["delete"],
      renamed: [{ from: "Old", to: "old" }],
      unchangedCount: 0,
      problems: [],
    };

    const applied = i18n.formatAppliedMutations(report);
    const lines = applied.split("\n").slice(1);
    expect(lines.slice(0, 3)).toEqual([
      "- delete",
      "~ overwrite",
      "> Old → old",
    ]);
    expect(lines).toContain("+ new-12");
    expect(applied).not.toContain("more");
    expect(i18n.formatRestoreSuccess(report)).toContain("16 paths changed");
  });
});
