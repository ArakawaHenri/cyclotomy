import { describe, expect, it } from "vitest";

import type { WorkspaceRestorePlan } from "../src/infrastructure/restore-plan.ts";
import { CyclotomyI18n } from "../src/pi/i18n.ts";
import {
  notifyCheckpointInitializationConflict,
  notifyPostMutationConflict,
  notifyArrivalDispositionFailure,
  notifyRestoreOutcome,
  notifyRestorePreparationConflict,
  notifyRestoreProtocolOutcome,
} from "../src/pi/restore-notifications.ts";
import { formatUiDetail } from "../src/pi/restore-presentation.ts";
import { CyclotomyRuntime } from "../src/pi/runtime.ts";

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

const exactArrival = {
  kind: "protected",
  evidence: {
    kind: "exact-slot",
    slot: { kind: "blocked-missing" },
    expectation: "matched",
    admission: { kind: "settled" },
  },
} as const;

describe("restore presentation", () => {
  it("presents initialization cleanup exactly once from its receipt owner", () => {
    const notifications: Array<{
      readonly message: string;
      readonly level: "info" | "warning" | "error";
    }> = [];
    const cleanup = new Error("initialization lock remained");
    const runtime = {
      i18n: new CyclotomyI18n("en"),
      notify: (
        _context: unknown,
        message: string,
        level: "info" | "warning" | "error",
      ) => notifications.push({ message, level }),
    } as unknown as CyclotomyRuntime;

    notifyCheckpointInitializationConflict(runtime, {} as never, {
      execution: {
        kind: "initialization-conflict",
        cause: new Error("arrival changed"),
      },
      arrival: exactArrival,
      workspaceLockCleanup: { kind: "failed", cause: cleanup },
    });

    expect(
      notifications.filter(({ message }) =>
        message.includes("initialization lock remained"),
      ),
    ).toHaveLength(1);
  });

  it("does not duplicate an unsettled initialization diagnostic", () => {
    const notifications: string[] = [];
    const runtime = {
      i18n: new CyclotomyI18n("en"),
      notify: (_context: unknown, message: string) =>
        notifications.push(message),
    } as unknown as CyclotomyRuntime;

    notifyCheckpointInitializationConflict(runtime, {} as never, {
      execution: {
        kind: "initialization-conflict",
        cause: new Error("arrival changed"),
      },
      arrival: {
        kind: "unsettled",
        cause: new Error("protection failed once"),
      },
      workspaceLockCleanup: { kind: "settled" },
    });

    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.match(/protection failed once/gu)).toHaveLength(1);
  });

  it("does not repeat a shared initialization and arrival failure", () => {
    const notifications: string[] = [];
    const shared = new Error("shared initialization failure");
    const runtime = {
      i18n: new CyclotomyI18n("en"),
      notify: (_context: unknown, message: string) =>
        notifications.push(message),
    } as unknown as CyclotomyRuntime;

    notifyCheckpointInitializationConflict(runtime, {} as never, {
      execution: { kind: "initialization-conflict", cause: shared },
      arrival: { kind: "unsettled", cause: shared },
      workspaceLockCleanup: { kind: "settled" },
    });

    expect(notifications).toHaveLength(1);
    expect(
      notifications[0]?.match(/shared initialization failure/gu),
    ).toHaveLength(1);
  });

  it("does not repeat one arrival and lock cleanup cause", () => {
    const notifications: string[] = [];
    const shared = new Error("shared arrival cleanup failure");
    const runtime = {
      i18n: new CyclotomyI18n("en"),
      notify: (_context: unknown, message: string) =>
        notifications.push(message),
    } as unknown as CyclotomyRuntime;

    notifyCheckpointInitializationConflict(runtime, {} as never, {
      execution: {
        kind: "initialization-conflict",
        cause: new Error("arrival changed"),
      },
      arrival: {
        ...exactArrival,
        evidence: {
          ...exactArrival.evidence,
          admission: { kind: "failed", cause: shared },
        },
      },
      workspaceLockCleanup: { kind: "failed", cause: shared },
    });

    expect(
      notifications.join("\n").match(/shared arrival cleanup failure/gu),
    ).toHaveLength(1);
  });

  it("does not repeat one post-mutation control and protection cause", () => {
    const notifications: string[] = [];
    const shared = new Error("shared post-mutation failure");
    const runtime = {
      i18n: new CyclotomyI18n("en"),
      notify: (_context: unknown, message: string) =>
        notifications.push(message),
    } as unknown as CyclotomyRuntime;

    notifyPostMutationConflict(runtime, {} as never, {
      execution: {
        kind: "post-mutation-conflict",
        reason: "control-failed",
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
        cause: shared,
        preparationCleanup: { kind: "settled" },
      },
      arrival: { kind: "unsettled", cause: shared },
      workspaceLockCleanup: { kind: "failed", cause: shared },
    });

    expect(notifications).toHaveLength(1);
    expect(
      notifications[0]?.match(/shared post-mutation failure/gu),
    ).toHaveLength(1);
  });

  it("does not repeat one preparation and protection cause", () => {
    const notifications: string[] = [];
    const shared = new Error("shared preparation failure");
    const runtime = {
      i18n: new CyclotomyI18n("en"),
      notify: (_context: unknown, message: string) =>
        notifications.push(message),
    } as unknown as CyclotomyRuntime;

    notifyRestorePreparationConflict(runtime, {} as never, {
      execution: { kind: "preparation-conflict", cause: shared },
      arrival: { kind: "unsettled", cause: shared },
      workspaceLockCleanup: { kind: "settled" },
    });

    expect(notifications).toHaveLength(1);
    expect(
      notifications[0]?.match(/shared preparation failure/gu),
    ).toHaveLength(1);
  });

  it("does not present a cleanup-only preparation failure twice", () => {
    const notifications: string[] = [];
    const cleanup = new Error("preparation lock remained");
    const runtime = {
      i18n: new CyclotomyI18n("en"),
      notify: (_context: unknown, message: string) =>
        notifications.push(message),
    } as unknown as CyclotomyRuntime;

    notifyRestorePreparationConflict(runtime, {} as never, {
      execution: { kind: "preparation-conflict", cause: cleanup },
      arrival: exactArrival,
      workspaceLockCleanup: { kind: "failed", cause: cleanup },
    });

    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.match(/preparation lock remained/gu)).toHaveLength(
      1,
    );
  });

  it("preserves a distinct unsettled arrival beside cleanup-only preparation failure", () => {
    const notifications: string[] = [];
    const cleanup = new Error("preparation lock remained");
    const protection = new Error("durable protection failed");
    const runtime = {
      i18n: new CyclotomyI18n("en"),
      notify: (_context: unknown, message: string) =>
        notifications.push(message),
    } as unknown as CyclotomyRuntime;

    notifyRestorePreparationConflict(runtime, {} as never, {
      execution: { kind: "preparation-conflict", cause: cleanup },
      arrival: { kind: "unsettled", cause: protection },
      workspaceLockCleanup: { kind: "failed", cause: cleanup },
    });

    expect(notifications).toHaveLength(2);
    expect(notifications.join("\n")).toContain("durable protection failed");
    expect(notifications.join("\n")).toContain("preparation lock remained");
  });

  it("preserves distinct preparation and cleanup failures", () => {
    const notifications: string[] = [];
    const primary = new Error("preparation action failed");
    const cleanup = new Error("preparation release failed");
    const runtime = {
      i18n: new CyclotomyI18n("en"),
      notify: (_context: unknown, message: string) =>
        notifications.push(message),
    } as unknown as CyclotomyRuntime;

    notifyRestorePreparationConflict(runtime, {} as never, {
      execution: { kind: "preparation-conflict", cause: primary },
      arrival: exactArrival,
      workspaceLockCleanup: { kind: "failed", cause: cleanup },
    });

    expect(notifications).toHaveLength(2);
    expect(notifications.join("\n")).toContain("preparation action failed");
    expect(notifications.join("\n")).toContain("preparation release failed");
  });

  it("presents a rejected cutover as not started", () => {
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

    notifyRestoreProtocolOutcome(runtime, {} as never, {
      execution: {
        kind: "outcome",
        outcome: {
          kind: "failed",
          stage: "apply",
          cause: new Error("application wrapper"),
        },
        cutover: { kind: "rejected", cause: new Error("Pi became busy") },
        preparationCleanup: { kind: "settled" },
      },
      arrival: exactArrival,
      workspaceLockCleanup: { kind: "settled" },
    });

    expect(notifications).toEqual([
      {
        level: "warning",
        message:
          "Restore did not start (Pi became busy). No files were changed.",
      },
    ]);
  });

  it("reports staging and lock cleanup without losing the rejected no-write fact", () => {
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

    notifyRestoreProtocolOutcome(runtime, {} as never, {
      execution: {
        kind: "outcome",
        outcome: {
          kind: "failed",
          stage: "apply",
          cause: new Error("Pi became busy"),
        },
        cutover: { kind: "rejected", cause: new Error("Pi became busy") },
        preparationCleanup: {
          kind: "failed",
          cause: new Error("scratch remained"),
        },
      },
      arrival: exactArrival,
      workspaceLockCleanup: {
        kind: "failed",
        cause: new Error("lock remained"),
      },
    });

    expect(notifications).toHaveLength(3);
    expect(notifications[0]).toMatchObject({
      level: "warning",
      message: expect.stringContaining("No files were changed"),
    });
    expect(notifications[1]).toMatchObject({
      level: "error",
      message: expect.stringContaining("scratch remained"),
    });
    expect(notifications[2]).toMatchObject({
      level: "error",
      message: expect.stringContaining("lock remained"),
    });
  });

  it("presents every restore receipt fact exactly once", () => {
    const notifications: string[] = [];
    const runtime = {
      i18n: new CyclotomyI18n("en"),
      notify: (_context: unknown, message: string) =>
        notifications.push(message),
    } as unknown as CyclotomyRuntime;

    notifyRestoreProtocolOutcome(runtime, {} as never, {
      execution: {
        kind: "outcome",
        outcome: {
          kind: "failed",
          stage: "apply",
          cause: new Error("restore failed"),
        },
        cutover: { kind: "not-requested" },
        preparationCleanup: {
          kind: "failed",
          cause: new Error("staging cleanup failed"),
        },
      },
      arrival: {
        ...exactArrival,
        evidence: {
          ...exactArrival.evidence,
          admission: {
            kind: "failed",
            cause: new Error("admission failed"),
          },
        },
      },
      workspaceLockCleanup: {
        kind: "failed",
        cause: new Error("lock cleanup failed"),
      },
    });

    expect(notifications).toHaveLength(4);
    expect(notifications[0]).toContain("admission failed");
    expect(notifications[1]).toContain("restore failed");
    expect(notifications[2]).toContain("staging cleanup failed");
    expect(notifications[3]).toContain("lock cleanup failed");
  });

  it("reports preparation cleanup once beside a post-mutation lock failure", () => {
    const notifications: string[] = [];
    const preparationCleanup = new Error("restore staging remained");
    const lockCleanup = new Error("restore action lock remained");
    const runtime = {
      i18n: new CyclotomyI18n("en"),
      notify: (_context: unknown, message: string) =>
        notifications.push(message),
    } as unknown as CyclotomyRuntime;

    notifyPostMutationConflict(runtime, {} as never, {
      execution: {
        kind: "post-mutation-conflict",
        reason: "control-failed",
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
        cause: lockCleanup,
        preparationCleanup: {
          kind: "failed",
          cause: preparationCleanup,
        },
      },
      arrival: exactArrival,
      workspaceLockCleanup: { kind: "failed", cause: lockCleanup },
    });

    expect(
      notifications.filter((message) =>
        message.includes("restore staging remained"),
      ),
    ).toHaveLength(1);
    expect(
      notifications.filter((message) =>
        message.includes("restore action lock remained"),
      ),
    ).toHaveLength(1);
  });

  it("reports unavailable durable arrival protection at error level", () => {
    const notifications: Array<{
      readonly message: string;
      readonly level: "info" | "warning" | "error";
    }> = [];
    const runtime = {
      isActive: false,
      i18n: new CyclotomyI18n("en"),
      notify: (
        _context: unknown,
        message: string,
        level: "info" | "warning" | "error",
      ) => notifications.push({ message, level }),
    } as unknown as CyclotomyRuntime;

    notifyArrivalDispositionFailure(runtime, {} as never, {
      kind: "unsettled",
      cause: new Error("protect\n\u001b[31mfailed"),
    });

    expect(notifications).toEqual([
      expect.objectContaining({ level: "error" }),
    ]);
    expect(notifications[0]?.message).toContain("protect\\n\\u001b[31mfailed");
    expect(notifications[0]?.message).toContain("/cyclotomy resume");
    expect(notifications[0]?.message).not.toContain("/drift");
  });

  it("never recommends drift for a restore result after participation stops", () => {
    const notifications: string[] = [];
    const runtime = {
      isActive: false,
      i18n: new CyclotomyI18n("en"),
      notify: (_context: unknown, message: string) =>
        notifications.push(message),
    } as unknown as CyclotomyRuntime;
    const report = {
      created: [],
      updated: ["changed.txt"],
      deleted: [],
      renamed: [],
      unchangedCount: 0,
      problems: [],
    };

    notifyRestoreOutcome(runtime, {} as never, {
      kind: "apply-incomplete",
      treeOid: "a".repeat(64),
      report,
    });
    notifyRestoreOutcome(runtime, {} as never, {
      kind: "verify-failed",
      reason: "mismatch",
      treeOid: "a".repeat(64),
      report,
    });
    notifyRestoreOutcome(runtime, {} as never, {
      kind: "failed",
      stage: "apply",
      cause: new Error("apply stopped"),
    });

    expect(notifications).toHaveLength(3);
    expect(
      notifications.every((message) => message.includes("/cyclotomy resume")),
    ).toBe(true);
    expect(notifications.join("\n")).not.toContain("/drift");
  });

  it("reports a failed checkpoint admission by user-visible impact", () => {
    const notifications: Array<{
      readonly message: string;
      readonly level: "info" | "warning" | "error";
    }> = [];
    const runtime = {
      isActive: true,
      i18n: new CyclotomyI18n("en"),
      notify: (
        _context: unknown,
        message: string,
        level: "info" | "warning" | "error",
      ) => notifications.push({ message, level }),
    } as unknown as CyclotomyRuntime;

    notifyArrivalDispositionFailure(runtime, {} as never, {
      ...exactArrival,
      evidence: {
        ...exactArrival.evidence,
        admission: { kind: "failed", cause: new Error("admission failed") },
      },
    });

    expect(notifications).toEqual([
      expect.objectContaining({
        level: "error",
        message: expect.stringContaining(
          "Automatic checkpoints are paused at the current node",
        ),
      }),
    ]);
    expect(notifications[0]?.message).toContain("/drift");
    expect(notifications[0]?.message).not.toContain("/cyclotomy resume");
  });

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
      isActive: true,
      i18n: new CyclotomyI18n("en"),
      notify: (
        _context: unknown,
        message: string,
        level: "info" | "warning" | "error",
      ) => notifications.push({ message, level }),
    } as unknown as CyclotomyRuntime;

    notifyPostMutationConflict(runtime, {} as never, {
      execution: {
        kind: "post-mutation-conflict",
        reason: "target-changed",
        preparationCleanup: { kind: "settled" },
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
      },
      arrival: exactArrival,
      workspaceLockCleanup: { kind: "settled" },
    });

    expect(notifications).toHaveLength(2);
    expect(notifications[0]).toMatchObject({ level: "error" });
    expect(notifications[0]?.message).toContain("Files changed");
    expect(notifications[0]?.message).toContain("~ changed.txt");
    expect(notifications[1]).toMatchObject({ level: "warning" });
    expect(notifications[1]?.message).toContain(
      "The checkpoint changed during restore",
    );
    expect(notifications[1]?.message).toContain(
      "will not be saved automatically at this node",
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
      execution: {
        kind: "post-mutation-conflict",
        reason: "control-failed",
        preparationCleanup: { kind: "settled" },
        outcome: {
          kind: "failed",
          stage: "apply",
          cause: new Error("apply stopped"),
        },
        cause: new Error("control\n\u001b[31mforged"),
      },
      arrival: {
        kind: "unsettled",
        cause: new Error("protect\n\u001b[32mforged"),
      },
      workspaceLockCleanup: { kind: "settled" },
    });

    const output = notifications.join("\n");
    expect(output).toContain("control\\n\\u001b[31mforged");
    expect(output).toContain("protect\\n\\u001b[32mforged");
    expect(output).not.toMatch(/[\u001b]/u);
    expect(output.split("\n")).not.toContain("forged");
  });

  it("reports an unassigned restore without exposing the history barrier", () => {
    const notifications: string[] = [];
    const runtime = {
      isActive: true,
      i18n: new CyclotomyI18n("en"),
      notify: (_context: unknown, message: string) =>
        notifications.push(message),
    } as unknown as CyclotomyRuntime;

    notifyPostMutationConflict(runtime, {} as never, {
      execution: {
        kind: "post-mutation-conflict",
        reason: "location-changed",
        preparationCleanup: { kind: "settled" },
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
      },
      arrival: {
        kind: "protected",
        evidence: {
          kind: "session-barrier",
          admission: { kind: "settled" },
        },
      },
      workspaceLockCleanup: { kind: "settled" },
    });

    const output = notifications.join("\n");
    expect(output).toContain("not attached to a checkpoint");
    expect(output).toContain("This state will not be saved automatically");
    expect(output).toContain("/drift");
    expect(output).not.toContain("barrier");
    expect(output).not.toContain("ancestry");
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
