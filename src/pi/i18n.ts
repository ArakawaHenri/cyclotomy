import type { CyclotomyLocale } from "../config.ts";
import type {
  ApplyProblem,
  ApplyProblemKind,
  ApplyReport,
} from "../infrastructure/apply.ts";
import type { WorkspaceRestorePlan } from "../infrastructure/restore-plan.ts";
import type {
  ScanProblem,
  ScanProblemKind,
} from "../infrastructure/workspace-scan.ts";
import {
  formatApplyProblems,
  formatUiDetail,
  formatUiPath,
  formatWorkspaceRestorePreview,
  restoreActionCount,
} from "./restore-presentation.ts";

export type ResolvedCyclotomyLocale = "en" | "zh-CN";
type MessageVariables = Readonly<Record<string, string | number>>;

const EN = {
  driftCommandDescription: "Show what /restore would change",
  restoreCommandDescription: "Restore the current node's checkpoint",
  checkingWorkspace: "Cyclotomy · checking workspace…",
  restoringWorkspace: "Cyclotomy · restoring workspace…",
  initFailure:
    "Cyclotomy initialization failed. Capture and restore are unavailable; files were not changed. Fix the reported configuration or storage problem, then run /reload.",
  captureLaterFailed:
    "Cyclotomy could not complete this checkpoint. The intended checkpoint pointer was not changed.",
  automaticGcFailed:
    "Cyclotomy automatic cleanup failed ({{message}}). Checkpointing succeeded and will continue; cleanup will retry later.",
  captureFailureDetail: "Details: {{message}}",
  sourceCaptureFailed:
    "Cyclotomy could not checkpoint the current workspace, so the operation was cancelled.",
  inputCaptureFailed:
    "Cyclotomy did not submit the prompt because the current workspace could not be checkpointed. Fix the reported problem and submit again.",
  bashWhileBusy:
    "Cyclotomy refused user bash while the agent or another session transition is active.",
  transitionInProgress:
    "Cyclotomy refused this operation because another session transition is still in progress.",
  sessionRegistrationFailed:
    "Cyclotomy disabled checkpoints for this session because its persisted identity could not be registered safely ({{message}}).",
  sessionIdentityUnavailable:
    "Cyclotomy cannot verify this session's persisted identity, so it will not checkpoint or restore the workspace.",
  memorySessionUnsupported:
    "Cyclotomy requires a persisted Pi session. Checkpoints are disabled for --no-session/in-memory sessions.",
  forkImportFailed:
    "Cyclotomy could not import the fork ancestry ({{message}}). Files and destination states were left unchanged.",
  navigationPrepareFailed:
    "Cyclotomy could not prepare navigation safely ({{message}}), so it was cancelled.",
  navigationScanIncomplete:
    "Cyclotomy cancelled navigation because the workspace scan is incomplete: {{message}}",
  navigationNeedsUi:
    "Cyclotomy needs confirmation before changing files, but no interactive UI is available: {{preview}}",
  navigationAttentionStatus:
    "Cyclotomy · navigation needs review · check the source checkpoint and current files",
  navigationPlanMismatch:
    "Cyclotomy observed an unplanned or different tree arrival. It did not run the automatic restore; inspect the current files and checkpoint before continuing.",
  navigationChangedAfterPreview:
    "The workspace changed after the preview. The conversation moved, so Cyclotomy left those later changes unassigned and did not restore files. The source kept its verified pre-navigation checkpoint; review the current files before running /restore.",
  sessionRestoreNeedsUi:
    "The loaded session differs from the workspace, but no interactive confirmation is available. Current files were kept. In print/JSON mode, the next successful checkpoint accepts them and replaces this node's saved state; use interactive /restore first if you need that state.",
  sessionRestoreDeferredRpc:
    "The loaded session differs from the workspace. Automatic restore was deferred until RPC startup completes; invoke /restore explicitly to choose which files to keep.",
  sessionRestoreCancelled: "Continuing with the current files.",
  waitIdleRestore: "Cyclotomy: wait until the agent is idle before restoring.",
  locationUnknown: "Cyclotomy: the current location cannot be identified.",
  restoreMissing: "Cyclotomy: there is no checkpoint here to restore.",
  restorePrepareFailed: "Cyclotomy could not prepare restore ({{message}}).",
  restoreScanIncomplete:
    "Cyclotomy refused restore because the workspace scan is incomplete: {{message}}",
  restoreNeedsUi:
    "Restore needs an interactive choice. Current files were kept.",
  commandPreviewStale:
    "Cyclotomy: the workspace changed after the preview. Nothing was applied; run /restore again.",
  commandTargetChanged:
    "Cyclotomy: the checkpoint target changed after the preview. Nothing was applied; run /restore again.",
  commandLocationChanged:
    "Cyclotomy: the active session, node, or workspace changed after the preview. Nothing was applied.",
  restoreAlreadyMatches: "Workspace already matches this checkpoint.",
  restoreSuccessOne: "Workspace restored · {{count}} path changed.",
  restoreSuccessMany: "Workspace restored · {{count}} paths changed.",
  checkpointUnreadable:
    "Restore did not start because the checkpoint could not be read ({{message}}). Current files were not changed.",
  restoreApplyIncomplete:
    "Restore could not apply every workspace change:\n{{problems}}\n{{applied}}\nRun /drift to inspect the result, then /restore to retry.",
  restoreVerifyFailed:
    "Files changed, but Cyclotomy could not verify the final workspace.\n{{applied}}\nRun /drift before continuing.",
  restoreAppliedNone: "No path mutation completed before the stop.",
  restoreAppliedPaths: "Completed before the stop:\n{{mutations}}",
  restoreNotStarted:
    "Restore did not start ({{message}}). Current files were not changed.",
  restoreExecutionFailed:
    "Restore stopped ({{message}}). Run /drift before continuing.",
  restoreFailed:
    "Restore failed ({{message}}). The original checkpoint remains the restore target.",
  driftMissing: "No checkpoint is available for this node yet.",
  driftClean: "No drift · workspace matches this node's checkpoint.",
  driftCleanInherited:
    "No drift · workspace matches the checkpoint inherited from the nearest ancestor.",
  driftTitle: "Workspace drift\n{{preview}}",
  driftTitleInherited:
    "Workspace drift · nearest ancestor checkpoint\n{{preview}}",
  previewPathOne: "{{count}} path",
  previewPathMany: "{{count}} paths",
  previewCreate: "+{{count}} create",
  previewOverwrite: "~{{count}} overwrite",
  previewDelete: "-{{count}} delete",
  previewOmitted: "… {{count}} more",
  previewProblemOne:
    "Preview incomplete · {{count}} scan problem; /restore is blocked",
  previewProblemMany:
    "Preview incomplete · {{count}} scan problems; /restore is blocked",
  previewScopeNotice:
    "Note: ignore rules will also be restored; paths excluded by this checkpoint stay untouched.",
  scanProblemTooLarge: "too large",
  scanProblemReadFailed: "cannot read",
  scanProblemUnsupported: "unsupported entry",
  scanProblemHardlink: "hard link",
  scanProblemCrossDevice: "different filesystem",
  scanProblemPathCollision: "path collision",
  scanProblemScopeMismatch: "scope changed",
  scanProblemScopeBlocker: "blocked by unmanaged content",
  applyProblemWriteFailed: "write failed",
  applyProblemDeleteFailed: "delete failed",
  applyProblemMkdirFailed: "directory creation failed",
  applyProblemReadFailed: "read failed",
  choiceManualTitle: "Restore this node's checkpoint?",
  choiceManualIntro:
    "Restoring discards the current differences below. Cyclotomy cannot undo this action.",
  choiceManualSafe: "Cancel — leave files unchanged",
  choiceManualRestore: "Restore checkpoint",
  choiceLoadedTitle: "Loaded session differs from workspace",
  choiceLoadedIntro:
    "Choose which workspace to continue with. Restoring discards the differences below.",
  choiceLoadedSafe: "Use current files",
  choiceLoadedRestore: "Restore loaded checkpoint",
  choiceNavigationTitle: "Destination workspace differs",
  choiceNavigationIntro:
    "Cyclotomy will save this node first, then apply the destination changes below.",
  choiceNavigationSafe: "Stay at current node",
  choiceNavigationRestore: "Navigate and restore",
  driftUsage: "Usage: /drift",
  restoreUsage: "Usage: /restore",
  commandFailed: "Cyclotomy command failed: {{message}}",
} as const;

export type MessageKey = keyof typeof EN;

const ZH_CN: Record<MessageKey, string> = {
  driftCommandDescription: "显示 /restore 将执行的文件变化",
  restoreCommandDescription: "恢复当前节点的保存状态",
  checkingWorkspace: "Cyclotomy · 正在检查工作区…",
  restoringWorkspace: "Cyclotomy · 正在恢复工作区…",
  initFailure:
    "Cyclotomy 初始化失败。捕获与恢复不可用，文件没有被改动。请修复报告的配置或存储问题，然后运行 /reload。",
  captureLaterFailed:
    "Cyclotomy 未能完成这次保存；本次保存所指向的状态指针没有改变。",
  automaticGcFailed:
    "Cyclotomy 自动清理失败（{{message}}）。保存状态已经成功建立且会继续工作；稍后将重试清理。",
  captureFailureDetail: "详情：{{message}}",
  sourceCaptureFailed: "Cyclotomy 无法保存当前工作区，因此已取消本次操作。",
  inputCaptureFailed:
    "Cyclotomy 因无法保存当前工作区而没有提交这条提示。请修复上述问题后重新提交。",
  bashWhileBusy: "Pi 正在工作或切换会话，Cyclotomy 没有执行这条终端命令。",
  transitionInProgress: "另一项会话切换尚未完成，Cyclotomy 没有执行本次操作。",
  sessionRegistrationFailed:
    "Cyclotomy 无法安全登记此会话（{{message}}），因此不会为它保存或恢复工作区。",
  sessionIdentityUnavailable:
    "Cyclotomy 无法确认此会话的持久化身份，因此不会为它保存或恢复工作区。",
  memorySessionUnsupported:
    "Cyclotomy 需要持久化的 Pi 会话；--no-session 和内存会话不会建立保存状态。",
  forkImportFailed:
    "Cyclotomy 无法导入分支来源（{{message}}）；文件和目标节点的保存状态均未改变。",
  navigationPrepareFailed:
    "Cyclotomy 无法安全准备跳转（{{message}}），已取消。",
  navigationScanIncomplete:
    "Cyclotomy 因工作区扫描不完整而取消跳转：{{message}}",
  navigationNeedsUi:
    "Cyclotomy 需要确认后才能改动文件，但当前没有交互界面：{{preview}}",
  navigationAttentionStatus:
    "Cyclotomy · 本次跳转需要检查 · 请确认源节点保存状态与当前文件",
  navigationPlanMismatch:
    "Cyclotomy 检测到与预期不同的跳转结果，因此没有执行自动恢复；请先检查当前文件和保存状态。",
  navigationChangedAfterPreview:
    "预览后工作区又发生了变化。对话位置已经移动，因此 Cyclotomy 没有给这些后续变化指定节点，也没有恢复文件；源节点保留跳转前已验证的保存状态。请先检查当前文件，再执行 /restore。",
  sessionRestoreNeedsUi:
    "载入的会话与工作区不同，但当前无法交互确认，已保留当前文件。在 print/JSON 模式下，下一次成功保存会接受这些文件并替换此节点原有的保存状态；若需要原状态，请先在交互界面执行 /restore。",
  sessionRestoreDeferredRpc:
    "载入的会话与工作区不同。自动恢复已推迟到 RPC 启动完成之后；请显式执行 /restore 选择保留哪份文件。",
  sessionRestoreCancelled: "继续使用当前文件。",
  waitIdleRestore: "Cyclotomy：请等 Pi 空闲后再执行 /restore。",
  locationUnknown: "Cyclotomy：当前位置不可识别。",
  restoreMissing: "Cyclotomy：当前位置没有保存状态，无法恢复。",
  restorePrepareFailed: "Cyclotomy 无法准备恢复（{{message}}）。",
  restoreScanIncomplete: "Cyclotomy 因工作区扫描不完整而拒绝恢复：{{message}}",
  restoreNeedsUi: "恢复需要交互式选择；当前文件已保留。",
  commandPreviewStale:
    "Cyclotomy：预览后工作区发生了变化；没有应用任何内容，请重新执行 /restore。",
  commandTargetChanged:
    "Cyclotomy：预览后目标保存状态发生了变化；没有应用任何内容，请重新执行 /restore。",
  commandLocationChanged:
    "Cyclotomy：预览后当前会话、节点或工作区发生了变化；没有应用任何内容。",
  restoreAlreadyMatches: "工作区已经与此保存状态一致。",
  restoreSuccessOne: "工作区已恢复 · 改动 {{count}} 个路径。",
  restoreSuccessMany: "工作区已恢复 · 改动 {{count}} 个路径。",
  checkpointUnreadable:
    "无法读取保存状态，恢复尚未开始（{{message}}）；当前文件没有改动。",
  restoreApplyIncomplete:
    "恢复未能应用全部工作区变更：\n{{problems}}\n{{applied}}\n请运行 /drift 检查结果，再运行 /restore 重试。",
  restoreVerifyFailed:
    "文件已经改动，但 Cyclotomy 无法确认最终工作区状态。\n{{applied}}\n请先运行 /drift 再继续。",
  restoreAppliedNone: "停止前没有完成任何路径变更。",
  restoreAppliedPaths: "停止前已完成：\n{{mutations}}",
  restoreNotStarted: "恢复尚未开始（{{message}}）；当前文件没有改动。",
  restoreExecutionFailed: "恢复已停止（{{message}}）；请先运行 /drift 再继续。",
  restoreFailed: "恢复失败（{{message}}）；原保存状态仍是下次恢复的目标。",
  driftMissing: "当前节点还没有可用的保存状态。",
  driftClean: "没有漂移 · 工作区与当前节点的保存状态一致。",
  driftCleanInherited: "没有漂移 · 工作区与最近祖先节点继承的保存状态一致。",
  driftTitle: "工作区漂移\n{{preview}}",
  driftTitleInherited: "工作区漂移 · 使用最近祖先节点的保存状态\n{{preview}}",
  previewPathOne: "{{count}} 个路径",
  previewPathMany: "{{count}} 个路径",
  previewCreate: "+{{count}} 创建",
  previewOverwrite: "~{{count}} 覆盖",
  previewDelete: "-{{count}} 删除",
  previewOmitted: "… 还有 {{count}} 项",
  previewProblemOne: "预览不完整 · {{count}} 个扫描问题；/restore 已阻止",
  previewProblemMany: "预览不完整 · {{count}} 个扫描问题；/restore 已阻止",
  previewScopeNotice:
    "提示：忽略规则也会恢复；此保存状态排除的路径不会被改动。",
  scanProblemTooLarge: "文件过大",
  scanProblemReadFailed: "无法读取",
  scanProblemUnsupported: "不支持的条目",
  scanProblemHardlink: "硬链接",
  scanProblemCrossDevice: "位于其他文件系统",
  scanProblemPathCollision: "路径冲突",
  scanProblemScopeMismatch: "管理范围已变化",
  scanProblemScopeBlocker: "被未管理内容阻挡",
  applyProblemWriteFailed: "写入失败",
  applyProblemDeleteFailed: "删除失败",
  applyProblemMkdirFailed: "创建目录失败",
  applyProblemReadFailed: "读取失败",
  choiceManualTitle: "恢复当前节点的保存状态？",
  choiceManualIntro: "恢复会丢弃下列当前差异，Cyclotomy 无法撤销此次操作。",
  choiceManualSafe: "取消（不改动文件）",
  choiceManualRestore: "恢复保存状态",
  choiceLoadedTitle: "载入的会话与工作区不同",
  choiceLoadedIntro: "请选择继续使用哪份工作区；恢复会丢弃下列当前差异。",
  choiceLoadedSafe: "使用当前文件",
  choiceLoadedRestore: "恢复会话状态",
  choiceNavigationTitle: "目标节点的工作区不同",
  choiceNavigationIntro:
    "Cyclotomy 会先保存当前节点，再把下列目标状态应用到工作区。",
  choiceNavigationSafe: "停留在当前节点",
  choiceNavigationRestore: "跳转并恢复",
  driftUsage: "用法：/drift",
  restoreUsage: "用法：/restore",
  commandFailed: "Cyclotomy 命令失败：{{message}}",
};

function looksChinese(locale: string | undefined): boolean {
  return locale !== undefined && /^zh(?:[-_]|$)/iu.test(locale);
}

export function resolveCyclotomyLocale(
  configured: CyclotomyLocale,
  env: NodeJS.ProcessEnv = process.env,
  hostLocale: string | undefined = Intl.DateTimeFormat().resolvedOptions()
    .locale,
): ResolvedCyclotomyLocale {
  if (configured !== "auto") return configured;
  const processLocale =
    env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG ?? env.LANGUAGE;
  if (processLocale !== undefined) {
    return looksChinese(processLocale) ? "zh-CN" : "en";
  }
  return looksChinese(hostLocale) ? "zh-CN" : "en";
}

export class CyclotomyI18n {
  readonly locale: ResolvedCyclotomyLocale;
  readonly #messages: Record<MessageKey, string>;

  constructor(locale: ResolvedCyclotomyLocale) {
    this.locale = locale;
    this.#messages = locale === "zh-CN" ? ZH_CN : EN;
  }

  t(key: MessageKey, variables: MessageVariables = {}): string {
    return this.#messages[key].replace(
      /\{\{([a-zA-Z][a-zA-Z0-9]*)\}\}/gu,
      (_match, name: string) => {
        const value = variables[name] ?? `{{${name}}}`;
        return name === "message" ? formatUiDetail(value) : String(value);
      },
    );
  }

  #scanProblemLabel(kind: ScanProblemKind): string {
    switch (kind) {
      case "too-large":
        return this.t("scanProblemTooLarge");
      case "read-failed":
        return this.t("scanProblemReadFailed");
      case "unsupported":
        return this.t("scanProblemUnsupported");
      case "hardlink":
        return this.t("scanProblemHardlink");
      case "cross-device":
        return this.t("scanProblemCrossDevice");
      case "path-collision":
        return this.t("scanProblemPathCollision");
      case "scope-mismatch":
        return this.t("scanProblemScopeMismatch");
      case "scope-blocker":
        return this.t("scanProblemScopeBlocker");
    }
  }

  #applyProblemLabel(kind: ApplyProblemKind): string {
    switch (kind) {
      case "write-failed":
        return this.t("applyProblemWriteFailed");
      case "delete-failed":
        return this.t("applyProblemDeleteFailed");
      case "mkdir-failed":
        return this.t("applyProblemMkdirFailed");
      case "read-failed":
        return this.t("applyProblemReadFailed");
    }
  }

  formatRestorePreview(
    plan: WorkspaceRestorePlan,
    sampleLimit?: number,
  ): string {
    const count = restoreActionCount(plan);
    const problemCount = plan.problems.length;
    const summary = [
      this.t(count === 1 ? "previewPathOne" : "previewPathMany", { count }),
      ...(plan.deleted.length > 0
        ? [this.t("previewDelete", { count: plan.deleted.length })]
        : []),
      ...(plan.modified.length > 0
        ? [this.t("previewOverwrite", { count: plan.modified.length })]
        : []),
      ...(plan.created.length > 0
        ? [this.t("previewCreate", { count: plan.created.length })]
        : []),
    ].join(" · ");
    return formatWorkspaceRestorePreview(plan, {
      ...(sampleLimit === undefined ? {} : { sampleLimit }),
      summary: count === 0 && problemCount > 0 ? "" : summary,
      omittedNotice: (omitted) => this.t("previewOmitted", { count: omitted }),
      problemNotice: this.t(
        problemCount === 1 ? "previewProblemOne" : "previewProblemMany",
        { count: problemCount },
      ),
      problemLabel: (problem: ScanProblem) =>
        this.#scanProblemLabel(problem.kind),
      scopeNotice: this.t("previewScopeNotice"),
    });
  }

  formatScanProblems(problems: readonly ScanProblem[]): string {
    const lines = problems
      .slice(0, 3)
      .map(
        (problem) =>
          `${this.#scanProblemLabel(problem.kind)} · ${formatUiPath(problem.path)}`,
      );
    const omitted = problems.length - lines.length;
    if (omitted > 0) {
      lines.push(this.t("previewOmitted", { count: omitted }));
    }
    return lines.join("; ");
  }

  formatApplyProblems(problems: readonly ApplyProblem[]): string {
    return formatApplyProblems(problems, {
      problemLabel: (problem) => this.#applyProblemLabel(problem.kind),
      omittedNotice: (count) => this.t("previewOmitted", { count }),
    });
  }

  formatRestoreSuccess(report: ApplyReport): string {
    const count =
      report.created.length + report.updated.length + report.deleted.length;
    return this.t(count === 1 ? "restoreSuccessOne" : "restoreSuccessMany", {
      count,
    });
  }

  formatAppliedMutations(report: ApplyReport, sampleLimit = 12): string {
    const mutations = [
      ...report.created.map((path) => ({ symbol: "+", path })),
      ...report.updated.map((path) => ({ symbol: "~", path })),
      ...report.deleted.map((path) => ({ symbol: "-", path })),
    ].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
    if (mutations.length === 0) return this.t("restoreAppliedNone");
    const bounded = mutations.slice(0, Math.max(0, sampleLimit));
    const lines = bounded.map(
      ({ symbol, path }) => `${symbol} ${formatUiPath(path)}`,
    );
    const omitted = mutations.length - bounded.length;
    if (omitted > 0) {
      lines.push(this.t("previewOmitted", { count: omitted }));
    }
    return this.t("restoreAppliedPaths", { mutations: lines.join("\n") });
  }
}

export function createCyclotomyI18n(locale: CyclotomyLocale): CyclotomyI18n {
  return new CyclotomyI18n(resolveCyclotomyLocale(locale));
}
