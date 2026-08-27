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
  it("exposes the top-level commands in both locales", () => {
    const en = new CyclotomyI18n("en");
    const zh = new CyclotomyI18n("zh-CN");
    expect(en.t("restoreUsage")).toBe("Usage: /restore");
    expect(zh.t("restoreUsage")).toBe("用法：/restore");
    expect(en.t("driftUsage")).toBe("Usage: /drift");
    expect(zh.t("driftUsage")).toBe("用法：/drift");
    expect(en.t("cyclotomyUsage")).toBe("Usage: /cyclotomy [stop|resume]");
    expect(zh.t("cyclotomyUsage")).toBe("用法：/cyclotomy [stop|resume]");
    expect(en.t("restoreCommandDescription")).toContain("checkpoint");
    expect(zh.t("driftCommandDescription")).toContain("/restore");
    expect(en.t("cyclotomyCommandDescription")).toContain("resume");
    expect(zh.t("cyclotomyCommandDescription")).toContain("恢复");
    expect(en.t("cyclotomyInactive")).toContain("unavailable");
    expect(zh.t("cyclotomyInactive")).toContain("无法使用");
  });

  it("keeps command references and session-identity failures localized", () => {
    const en = new CyclotomyI18n("en");
    const zh = new CyclotomyI18n("zh-CN");

    expect(en.t("commandPreviewStale")).toContain("/restore");
    expect(en.t("commandTargetChanged")).toContain("/restore");
    expect(zh.t("commandPreviewStale")).toContain("/restore");
    expect(zh.t("commandTargetChanged")).toContain("/restore");
    expect(en.t("sessionIdentityUnavailable")).toContain(
      "Checkpoints and restore are unavailable",
    );
    expect(zh.t("sessionIdentityUnavailable")).toContain("检查点与恢复不可用");
  });

  it("explains that a skipped parent import does not block new work", () => {
    const en = new CyclotomyI18n("en").t("forkInheritanceSkipped", {
      message: "source unavailable",
    });
    const zh = new CyclotomyI18n("zh-CN").t("forkInheritanceSkipped", {
      message: "来源不可用",
    });

    expect(en).toContain("Parent checkpoints were not imported");
    expect(en).toContain("New work can still be checkpointed");
    expect(en).toContain("existing nodes need /restore");
    expect(zh).toContain("未导入父会话的检查点");
    expect(zh).toContain("新工作仍会保存检查点");
    expect(zh).toContain("已有节点需要先执行 /restore");
  });

  it("makes a transient fork import failure retryable", () => {
    const en = new CyclotomyI18n("en").t("forkImportFailed", {
      message: "source busy",
    });
    const zh = new CyclotomyI18n("zh-CN").t("forkImportFailed", {
      message: "来源忙碌",
    });

    for (const message of [en, zh])
      expect(message).toContain("/cyclotomy resume");
    expect(en).toContain("try again");
    expect(zh).toContain("重试");
  });

  it("states post-application uncertainty without leaving placeholders", () => {
    const en = new CyclotomyI18n("en");
    const zh = new CyclotomyI18n("zh-CN");
    expect(
      en.t("restoreExecutionFailed", {
        message: "failure",
        continuation: en.t("continueWithDrift"),
      }),
    ).toContain("Some files may have changed");
    expect(
      zh.t("restoreExecutionFailed", {
        message: "失败",
        continuation: zh.t("continueWithDrift"),
      }),
    ).toContain("部分文件可能已改动");
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

  it("explains a session-history pause without exposing its mechanism", () => {
    const en = new CyclotomyI18n("en").t("sessionCaptureBarrier");
    const zh = new CyclotomyI18n("zh-CN").t("sessionCaptureBarrier");

    for (const message of [en, zh]) {
      expect(message).toContain("/drift");
      expect(message).toContain("/restore");
    }
    expect(en).toContain(
      "current state will not be checkpointed automatically",
    );
    expect(en).not.toContain("barrier");
    expect(zh).toContain("不会自动保存当前状态");
    expect(zh).not.toContain("屏障");
  });

  it("presents history conflicts by impact and next action", () => {
    const english = new CyclotomyI18n("en");
    const chinese = new CyclotomyI18n("zh-CN");
    const en = [
      english.t("restorePostMutationLocationBarrier", {
        continuation: english.t("continueWithDrift"),
      }),
      english.t("restorePostMutationTargetBarrier", {
        continuation: english.t("continueWithDrift"),
      }),
      english.t("restorePostMutationControlBarrier", {
        message: "failure",
        continuation: english.t("continueWithDrift"),
      }),
      english.t("checkpointInitializedConflictBarrier", {
        message: "conflict",
        continuation: english.t("continueWithDrift"),
      }),
    ];
    const zh = [
      chinese.t("restorePostMutationLocationBarrier", {
        continuation: chinese.t("continueWithDrift"),
      }),
      chinese.t("restorePostMutationTargetBarrier", {
        continuation: chinese.t("continueWithDrift"),
      }),
      chinese.t("restorePostMutationControlBarrier", {
        message: "失败",
        continuation: chinese.t("continueWithDrift"),
      }),
      chinese.t("checkpointInitializedConflictBarrier", {
        message: "冲突",
        continuation: chinese.t("continueWithDrift"),
      }),
    ];

    for (const message of en) {
      expect(message).toContain("will not be saved automatically");
      expect(message).toContain("/drift");
      expect(message).not.toContain("barrier");
      expect(message).not.toContain("ancestry");
    }
    for (const message of zh) {
      expect(message).toContain("不会自动保存");
      expect(message).toContain("/drift");
      expect(message).not.toContain("屏障");
      expect(message).not.toContain("祖先链");
    }
  });

  it("makes reload protection actionable without claiming a restore", () => {
    const en = new CyclotomyI18n("en").t("reloadProtected");
    const zh = new CyclotomyI18n("zh-CN").t("reloadProtected");

    for (const message of [en, zh]) {
      expect(message).toContain("/drift");
      expect(message).toContain("/restore");
    }
    expect(en).toContain("Current files were kept");
    expect(en).toContain("this node will not be checkpointed automatically");
    expect(zh).toContain("已保留当前文件");
    expect(zh).toContain("当前节点不会自动保存检查点");
  });

  it("offers navigation choices without explaining internal protection", () => {
    const en = new CyclotomyI18n("en").t("choiceNavigationIntro");
    const zh = new CyclotomyI18n("zh-CN").t("choiceNavigationIntro");

    expect(en).toContain("current files");
    expect(en).toContain("Detached");
    expect(en).toContain("destination checkpoint");
    expect(en).not.toContain("save this node");
    expect(zh).toContain("保留当前文件");
    expect(zh).toContain("Detached");
    expect(zh).toContain("目标检查点");
    expect(zh).not.toContain("保存当前节点");
  });

  it("renders Git replay provenance risks in both locales", () => {
    const en = new CyclotomyI18n("en");
    const zh = new CyclotomyI18n("zh-CN");
    const mismatch = {
      kind: "version-mismatch" as const,
      capturedGitVersion: "git version 2.50.1",
      currentGitVersion: "git version 2.54.0",
    };

    expect(en.formatGitReplayRisk({ kind: "none" })).toBeUndefined();
    expect(en.formatGitReplayRisk(mismatch)).toContain("git version 2.50.1");
    expect(en.formatGitReplayRisk(mismatch)).toContain("git version 2.54.0");
    expect(en.formatGitReplayRisk(mismatch)).toContain("Warning");
    expect(zh.formatGitReplayRisk(mismatch)).toContain("警告");
    expect(
      zh.formatGitReplayRisk({
        kind: "legacy-unattested",
        currentGitVersion: null,
      }),
    ).toContain("未知 Git 版本");
  });

  it("explains how to leave Detached state", () => {
    const en = new CyclotomyI18n("en").t("navigationDetached");
    const zh = new CyclotomyI18n("zh-CN").t("navigationDetached");

    for (const message of [en, zh]) {
      expect(message).toContain("/drift");
      expect(message).toContain("/restore");
    }
    expect(en).toContain("Detached");
    expect(en).toContain("current files");
    expect(en).toContain("new branch");
    expect(zh).toContain("Detached");
    expect(zh).toContain("当前文件");
    expect(zh).toContain("新分支");
  });

  it("marks both clean and changed protected workspaces as Detached", () => {
    for (const locale of ["en", "zh-CN"] as const) {
      const i18n = new CyclotomyI18n(locale);
      expect(i18n.t("driftCleanProtected")).toContain("Detached");
      expect(i18n.t("driftCleanProtected")).toContain("/restore");
      expect(i18n.t("driftTitleDetached", { preview: "preview" })).toContain(
        "Detached",
      );
    }
  });

  it("directs a cancelled pre-departure navigation back to tree review", () => {
    const en = new CyclotomyI18n("en").t("navigationChangedBeforeDeparture");
    const zh = new CyclotomyI18n("zh-CN").t("navigationChangedBeforeDeparture");

    for (const message of [en, zh]) {
      expect(message).toContain("/tree");
      expect(message).not.toContain("/restore");
    }
  });

  it("confirms the first checkpoint without implementation detail", () => {
    const en = new CyclotomyI18n("en").t("restoreInitialized");
    const zh = new CyclotomyI18n("zh-CN").t("restoreInitialized");

    expect(en).toContain("first checkpoint");
    expect(en).not.toContain("capture");
    expect(zh).toContain("首个检查点");
    expect(zh).not.toContain("捕获");
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

    expect(applied).toContain("Changed before restore stopped");
    expect(applied).toContain("~ changed.txt");
    expect(applied).toContain('+ "new\\nfile"');
    expect(applied).toContain("- old.txt");
    expect(applied.split("\n")).not.toContain("file");
  });
});
