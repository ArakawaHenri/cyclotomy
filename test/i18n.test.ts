import { describe, expect, it } from "vitest";

import {
  CyclotomyI18n,
  resolveCyclotomyLocale,
} from "../src/pi/i18n.ts";
import type { WorkspaceRestorePlan } from "../src/infrastructure/restore-plan.ts";

function plan(
  value: Pick<WorkspaceRestorePlan, "created" | "deleted" | "modified">,
): WorkspaceRestorePlan {
  return {
    ...value,
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

  it("resolves auto from process locale before the host locale", () => {
    expect(resolveCyclotomyLocale("zh-CN", {}, "en-US")).toBe("zh-CN");
    expect(resolveCyclotomyLocale("en", { LANG: "zh_CN.UTF-8" }, "zh-CN"))
      .toBe("en");
    expect(resolveCyclotomyLocale("auto", { LANG: "zh_CN.UTF-8" }, "en-US"))
      .toBe("zh-CN");
    expect(resolveCyclotomyLocale("auto", {}, "fr-FR")).toBe("en");
  });

  it("formats restore-oriented previews and explains ignore-rule scope", () => {
    const en = new CyclotomyI18n("en");
    const preview = en.formatRestorePreview(plan({
      created: ["new.txt"],
      deleted: [],
      modified: [".gitignore"],
    }));

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
    const problems = zh.formatApplyProblems([{
      path: "bad\npath",
      kind: "write-failed",
      detail: "denied\r\ntry again",
    }]);

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
