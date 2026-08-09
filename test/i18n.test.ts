import { describe, expect, it } from "vitest";

import { CyclotomyI18n, resolveCyclotomyLocale } from "../src/pi/i18n.ts";
import type { WorkspaceRestorePlan } from "../src/infrastructure/restore-plan.ts";

function plan(
  value: Pick<WorkspaceRestorePlan, "created" | "deleted" | "modified">,
): WorkspaceRestorePlan {
  return {
    ...value,
    renamed: [],
    requiredBlobOids: [],
    scopeBlockers: [],
    occupancyChanged: [],
    problems: [],
  };
}

describe("Cyclotomy Pi localization", () => {
  it("exposes the two top-level commands in both locales", () => {
    const en = new CyclotomyI18n("en");
    const zh = new CyclotomyI18n("zh-CN");
    expect(en.t("restoreUsage")).toBe("Usage: /restore");
    expect(zh.t("restoreUsage")).toBe("用法：/restore");
    expect(en.t("driftUsage")).toBe("Usage: /drift");
    expect(zh.t("driftUsage")).toBe("用法：/drift");
    expect(en.t("restoreCommandDescription")).toContain("checkpoint");
    expect(zh.t("driftCommandDescription")).toContain("/restore");
  });

  it("keeps command references and session-identity failures localized", () => {
    const en = new CyclotomyI18n("en");
    const zh = new CyclotomyI18n("zh-CN");

    expect(en.t("commandPreviewStale")).toContain("/restore");
    expect(en.t("commandTargetChanged")).toContain("/restore");
    expect(zh.t("commandPreviewStale")).toContain("/restore");
    expect(zh.t("commandTargetChanged")).toContain("/restore");
    expect(zh.t("sessionIdentityUnavailable")).toBe(
      "Cyclotomy 无法确认此会话的持久化身份，因此不会为它保存或恢复工作区。",
    );
  });

  it("states post-application uncertainty without leaving placeholders", () => {
    const en = new CyclotomyI18n("en");
    const zh = new CyclotomyI18n("zh-CN");
    expect(en.t("restoreExecutionFailed", { message: "failure" })).toContain(
      "Files may have changed",
    );
    expect(zh.t("restoreExecutionFailed", { message: "失败" })).toContain(
      "文件可能已发生改动",
    );
    for (const i18n of [en, zh]) {
      const message = i18n.t("restorePostMutationControlUnavailable", {
        message: "post-check",
        protection: "re-lock",
      });
      expect(message).toContain("post-check");
      expect(message).toContain("re-lock");
      expect(message).not.toContain("{{");
    }
  });

  it("gives non-interactive sessions an executable restore path", () => {
    const english = new CyclotomyI18n("en");
    const chinese = new CyclotomyI18n("zh-CN");
    const en = [
      english.t("sessionRestoreNeedsUi"),
      english.t("restoreNeedsUi"),
    ];
    const zh = [
      chinese.t("sessionRestoreNeedsUi"),
      chinese.t("restoreNeedsUi"),
    ];

    for (const message of [...en, ...zh]) {
      expect(message).toContain("/drift");
      expect(message).toContain("/restore");
    }
    for (const message of en) expect(message).toContain("interactive TUI");
    for (const message of zh) expect(message).toContain("交互式 TUI");
  });

  it("directs a pending node guard to reload before continuing", () => {
    const en = new CyclotomyI18n("en").t("sessionPendingNodeGuard");
    const zh = new CyclotomyI18n("zh-CN").t("sessionPendingNodeGuard");

    for (const message of [en, zh]) {
      expect(message).toContain("/reload");
    }
    expect(en).toContain("unassigned");
    expect(zh).toContain("未归属");
  });

  it("makes reload protection actionable without claiming a restore", () => {
    const en = new CyclotomyI18n("en").t("reloadProtected");
    const zh = new CyclotomyI18n("zh-CN").t("reloadProtected");

    for (const message of [en, zh]) {
      expect(message).toContain("/drift");
      expect(message).toContain("/restore");
    }
    expect(en).toContain("capture remains protected");
    expect(zh).toContain("捕获仍受保护");
  });

  it("does not promise that a protected navigation source will be saved", () => {
    const en = new CyclotomyI18n("en").t("choiceNavigationIntro");
    const zh = new CyclotomyI18n("zh-CN").t("choiceNavigationIntro");

    expect(en).toContain("apply the destination changes");
    expect(en).not.toContain("save this node");
    expect(zh).toContain("目标状态应用到工作区");
    expect(zh).not.toContain("保存当前节点");
  });

  it("directs a cancelled pre-departure navigation back to tree review", () => {
    const en = new CyclotomyI18n("en").t("navigationChangedBeforeDeparture");
    const zh = new CyclotomyI18n("zh-CN").t("navigationChangedBeforeDeparture");

    for (const message of [en, zh]) {
      expect(message).toContain("/tree");
      expect(message).not.toContain("/restore");
    }
  });

  it("explains both first-checkpoint recording and resumed capture", () => {
    const en = new CyclotomyI18n("en").t("restoreInitialized");
    const zh = new CyclotomyI18n("zh-CN").t("restoreInitialized");

    expect(en).toContain("first checkpoint");
    expect(en).toContain("capture resumed");
    expect(zh).toContain("首个保存状态");
    expect(zh).toContain("恢复后续检查点捕获");
  });

  it("resolves auto from process locale before the host locale", () => {
    expect(resolveCyclotomyLocale("zh-CN", {}, "en-US")).toBe("zh-CN");
    expect(resolveCyclotomyLocale("en", { LANG: "zh_CN.UTF-8" }, "zh-CN")).toBe(
      "en",
    );
    expect(
      resolveCyclotomyLocale("auto", { LANG: "zh_CN.UTF-8" }, "en-US"),
    ).toBe("zh-CN");
    expect(resolveCyclotomyLocale("auto", {}, "fr-FR")).toBe("en");
  });

  it("formats restore-oriented previews and explains ignore-rule scope", () => {
    const en = new CyclotomyI18n("en");
    const preview = en.formatRestorePreview(
      plan({
        created: ["new.txt"],
        deleted: [],
        modified: [".gitignore"],
      }),
    );

    expect(preview).toContain("2 paths · ~1 overwrite · +1 create");
    expect(preview).toContain("~ .gitignore");
    expect(preview).toContain("ignore rules will also be restored");
    expect(preview).toContain("excluded by this checkpoint stay untouched");
  });

  it("localizes and sanitizes untrusted diagnostics", () => {
    const zh = new CyclotomyI18n("zh-CN");
    const message = zh.t("restorePrepareFailed", {
      message: "bad\n\u001b[31m\u202edetail",
    });
    const problems = zh.formatApplyProblems([
      {
        path: "bad\npath",
        kind: "write-failed",
        detail: "denied\r\ntry again",
      },
    ]);

    expect(message).toContain("bad\\n\\u001b[31m\\u202edetail");
    expect(message).not.toMatch(/[\n\u001b\u202e]/u);
    expect(problems).toContain('"bad\\npath" · 写入失败');
    expect(problems).toContain("denied\\r\\ntry again");
  });

  it("lists successful mutations for partial restore outcomes", () => {
    const en = new CyclotomyI18n("en");
    const applied = en.formatAppliedMutations({
      created: ["new\nfile"],
      updated: ["changed.txt"],
      deleted: ["old.txt"],
      renamed: [],
      unchangedCount: 0,
      problems: [],
    });

    expect(applied).toContain("Completed before the stop");
    expect(applied).toContain("~ changed.txt");
    expect(applied).toContain('+ "new\\nfile"');
    expect(applied).toContain("- old.txt");
    expect(applied.split("\n")).not.toContain("file");
  });
});
