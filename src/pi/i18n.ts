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
  cyclotomyCommandDescription: "Show, stop, or resume Cyclotomy",
  cyclotomyStopCompletion: "Stop Cyclotomy for this Pi runtime",
  cyclotomyResumeCompletion: "Retry Cyclotomy without reloading Pi",
  cyclotomyRunning: "Cyclotomy is running.",
  cyclotomyInactive:
    "Cyclotomy is not active for this Pi session. Pi remains available.",
  cyclotomyStopped:
    "Cyclotomy is stopped for this Pi runtime. Run /cyclotomy resume to try starting it.",
  cyclotomyStoppedWithError:
    "Cyclotomy is stopped for this Pi runtime ({{message}}). Pi remains available; fix the problem, then run /cyclotomy resume.",
  cyclotomyStopSucceeded:
    "Cyclotomy stopped for this Pi runtime. Pi remains available.",
  cyclotomyResumeSucceeded: "Cyclotomy resumed.",
  cyclotomyResumeFailed:
    "Cyclotomy could not resume ({{message}}). Pi remains available; fix the problem, then retry /cyclotomy resume.",
  driftCommandDescription: "Show what /restore would change",
  restoreCommandDescription: "Restore the current node's checkpoint",
  checkingWorkspace: "Cyclotomy · checking workspace…",
  restoringWorkspace: "Cyclotomy · restoring workspace…",
  initFailure:
    "Cyclotomy initialization failed. Capture and restore are unavailable; files were not changed. Pi remains available; fix the reported configuration or storage problem, then run /cyclotomy resume.",
  captureLaterFailed:
    "Cyclotomy could not complete this checkpoint. The intended checkpoint pointer was not changed.",
  arrivalProtectionUnavailable:
    "Cyclotomy could not durably protect the current arrival ({{message}}). Keep the current files unchanged and inspect /drift before continuing.",
  arrivalAdmissionUnavailable:
    "Cyclotomy durably protected the current arrival, but could not rebuild its in-memory admission ({{message}}). Checkpointing remains blocked here; inspect /drift before continuing.",
  automaticGcFailed:
    "Cyclotomy automatic cleanup failed ({{message}}). Checkpointing succeeded and will continue; cleanup will retry later.",
  captureFailureDetail: "Details: {{message}}",
  captureScanIncomplete:
    "Workspace scan is incomplete; checkpoint was not published: {{message}}",
  captureValidationIncomplete:
    "Final workspace validation is incomplete; checkpoint was not committed: {{message}}",
  captureValidationFailed: "Final workspace validation failed: {{message}}",
  captureCheckpointChanged:
    "The node checkpoint changed after capture preparation.",
  captureEligibilityChanged:
    "The node checkpoint eligibility changed after capture preparation.",
  captureWriteProtected:
    "The node checkpoint is write-protected until it is restored.",
  captureRootChanged:
    "The workspace root changed after the checkpoint store was selected.",
  captureContentsChanged:
    "The workspace changed between capture scan and final validation; checkpoint was not committed.",
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
  sessionWorkspaceMismatch:
    "Pi opened this session outside the workspace recorded in its session file. Cyclotomy is paused here and did not bind or modify either workspace; create a Pi-native fork in this directory to carry the session forward safely.",
  forkImportFailed:
    "Cyclotomy could not finish the fork ancestry registration safely ({{message}}). Workspace files were not changed; run /cyclotomy resume to retry.",
  forkInheritanceSkipped:
    "Cyclotomy could not authenticate or admit the parent checkpoints ({{message}}). No parent state was imported; retained locations are blocked until a later, explicitly reviewed location can establish its own checkpoint.",
  navigationPrepareFailed:
    "Cyclotomy could not prepare navigation safely ({{message}}), so it was cancelled.",
  navigationScanIncomplete:
    "Cyclotomy cancelled navigation because the workspace scan is incomplete: {{message}}",
  navigationNeedsUi:
    "The destination workspace differs, but no interactive choice is available. Navigation was cancelled and files were not changed: {{preview}}",
  navigationAttentionStatus:
    "Cyclotomy · navigation needs review · check the source checkpoint and current files",
  navigationPlanMismatch:
    "Cyclotomy observed an unplanned or different tree arrival. It did not run the automatic restore or assign current files to that node; inspect them before running /restore.",
  navigationChangedAfterPreview:
    "The workspace changed after the preview. The conversation moved, so Cyclotomy left those later changes unassigned and did not restore files. The source kept its verified pre-navigation checkpoint; review the current files before running /restore.",
  navigationChangedBeforeDeparture:
    "Cyclotomy cancelled navigation because the workspace or source/destination checkpoint changed after the preview. Review the current source files, then retry /tree.",
  navigationDetached:
    "Navigated in Detached state with the current files. The destination checkpoint remains protected; use /drift to inspect the difference, then /restore to reconcile and exit Detached state.",
  navigationDetachFailed:
    "Navigation kept the current files, but Cyclotomy could not authenticate the planned Detached arrival ({{message}}). The current arrival was protected where possible; inspect /drift before continuing.",
  sessionRestoreNeedsUi:
    "The loaded session differs from the workspace, but no interactive confirmation is available. Current files were kept in Detached state without replacing this node's checkpoint; use /drift to inspect the difference, then run /restore in an interactive TUI to reconcile it.",
  sessionRestoreDeferredRpc:
    "The loaded session differs from the workspace. Current files were kept in Detached state without replacing this node's checkpoint; invoke /restore explicitly to reconcile them.",
  sessionRestoreCancelled:
    "Continuing in Detached state with the current files without replacing this node's checkpoint.",
  sessionMissingProtected:
    "This node has no checkpoint that Cyclotomy can safely restore. Current files remain unassigned to it; use /restore to record them as this node's first checkpoint.",
  sessionCaptureBarrier:
    "Cyclotomy retained a session capture barrier because no complete, stable current ancestry could be authenticated. Current files remain unassigned. Running /reload does not grant ownership or clear the barrier; Cyclotomy will project it atomically onto the next complete concrete ancestry it can authenticate.",
  reloadProtected:
    "Cyclotomy could not prove that the reloaded workspace matches this checkpoint. Current files were kept and checkpoint capture remains protected; run /drift to inspect them, then /restore to reconcile.",
  waitIdleRestore: "Cyclotomy: wait until the agent is idle before restoring.",
  locationUnknown: "Cyclotomy: the current location cannot be identified.",
  restoreMissing: "Cyclotomy: there is no checkpoint here to restore.",
  restorePrepareFailed: "Cyclotomy could not prepare restore ({{message}}).",
  restorePreparationProtected:
    "Cyclotomy could not read the loaded checkpoint ({{message}}). Current files were not changed, and the current arrival is protected from automatic capture.",
  restorePreparationBarrier:
    "Cyclotomy could not read the loaded checkpoint ({{message}}). Current files remain unassigned, and a session capture barrier prevents automatic assignment.",
  restorePreparationUnavailable:
    "Cyclotomy could not read the loaded checkpoint ({{message}}), and it could not protect the current arrival ({{protection}}). Current files were not changed; inspect /drift before continuing.",
  restoreScanIncomplete:
    "Cyclotomy refused restore because the workspace scan is incomplete: {{message}}",
  restoreNeedsUi:
    "Restore needs an interactive choice. Current files were kept; use /drift to inspect the difference, then run /restore in an interactive TUI.",
  commandPreviewStale:
    "Cyclotomy: the workspace changed after the preview. Nothing was applied; run /restore again.",
  commandTargetChanged:
    "Cyclotomy: the checkpoint target changed after the preview. Nothing was applied; run /restore again.",
  commandLocationChanged:
    "Cyclotomy: the active session, node, or workspace changed after the preview. Nothing was applied.",
  restorePostMutationLocationProtected:
    "Cyclotomy entered the file-application phase before the active session, node, or workspace changed. Files may have changed. Cyclotomy write-protected the current arrival; run /drift before continuing.",
  restorePostMutationLocationUnavailable:
    "Cyclotomy entered the file-application phase before the active session, node, or workspace changed. Files may have changed, and Cyclotomy could not authenticate and protect the current arrival ({{message}}). Inspect /drift before continuing.",
  restorePostMutationTargetProtected:
    "Cyclotomy entered the file-application phase before the checkpoint target changed. Files may have changed. Cyclotomy kept the current arrival write-protected; run /drift before continuing.",
  restorePostMutationTargetUnavailable:
    "Cyclotomy entered the file-application phase before the checkpoint target changed. Files may have changed, and Cyclotomy could not confirm write protection for the current arrival ({{message}}). Inspect /drift before continuing.",
  restorePostMutationControlProtected:
    "Cyclotomy entered the file-application phase, but a post-restore safety check failed ({{message}}). Files may have changed. Cyclotomy write-protected the current arrival; run /drift before continuing.",
  restorePostMutationControlUnavailable:
    "Cyclotomy entered the file-application phase, but a post-restore safety check failed ({{message}}). Files may have changed, and Cyclotomy could not authenticate and protect the current arrival ({{protection}}). Inspect /drift before continuing.",
  restorePostMutationLocationBarrier:
    "Cyclotomy entered the file-application phase before the active session, node, or workspace changed. Files may have changed. No complete, stable current ancestry could be authenticated, so current files remain unassigned and a session capture barrier prevents automatic assignment. Reloading does not clear it; Cyclotomy will project it atomically onto the next complete concrete ancestry it can authenticate.",
  restorePostMutationTargetBarrier:
    "Cyclotomy entered the file-application phase before the checkpoint target changed. Files may have changed. No complete, stable current ancestry could be authenticated, so current files remain unassigned and a session capture barrier prevents automatic assignment. Reloading does not clear it; Cyclotomy will project it atomically onto the next complete concrete ancestry it can authenticate.",
  restorePostMutationControlBarrier:
    "Cyclotomy entered the file-application phase, but a post-restore safety check failed ({{message}}). Files may have changed. No complete, stable current ancestry could be authenticated, so current files remain unassigned and a session capture barrier prevents automatic assignment. Reloading does not clear it; Cyclotomy will project it atomically onto the next complete concrete ancestry it can authenticate.",
  checkpointInitializedConflictProtected:
    "Cyclotomy recorded the workspace as the intended node's first checkpoint, but could not safely admit the now-current location ({{message}}). The current arrival is write-protected; run /drift before continuing.",
  checkpointInitializedConflictUnavailable:
    "Cyclotomy recorded the workspace as the intended node's first checkpoint, but could not safely admit or protect the now-current location ({{message}}). Inspect /drift before continuing.",
  checkpointInitializedConflictBarrier:
    "Cyclotomy recorded the workspace as the intended node's first checkpoint, but no complete, stable current ancestry could be authenticated afterward ({{message}}). Current files remain unassigned and a session capture barrier prevents automatic assignment. Reloading does not clear it; Cyclotomy will project it atomically onto the next complete concrete ancestry it can authenticate.",
  restoreInitialized:
    "Current workspace recorded as this node's first checkpoint; checkpoint capture resumed.",
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
    "Restore entered the file-application phase and stopped ({{message}}). Files may have changed; run /drift before continuing.",
  restoreStagingCleanupFailed:
    "Cyclotomy could not remove private restore staging ({{message}}). Check temporary storage before continuing.",
  workspaceLockCleanupFailed:
    "Cyclotomy could not finish workspace-lock cleanup ({{message}}). Check the checkpoint store before continuing.",
  restoreFailed:
    "Restore failed ({{message}}). The original checkpoint remains the restore target.",
  driftMissing: "No checkpoint is available for this node yet.",
  driftMissingProtected:
    "This protected node has no historical checkpoint. Run /restore to record the current workspace as its first checkpoint.",
  driftClean: "No drift · workspace matches this node's checkpoint.",
  driftCleanInherited:
    "No drift · workspace matches the checkpoint inherited from the nearest ancestor.",
  driftCleanProtected:
    "Detached · no drift; workspace matches this checkpoint, but capture remains protected. Run /restore to exit Detached state and resume checkpointing.",
  driftTitle: "Workspace drift\n{{preview}}",
  driftTitleDetached: "Workspace drift · Detached\n{{preview}}",
  driftTitleInherited:
    "Workspace drift · nearest ancestor checkpoint\n{{preview}}",
  previewPathOne: "{{count}} path",
  previewPathMany: "{{count}} paths",
  previewCreate: "+{{count}} create",
  previewOverwrite: "~{{count}} overwrite",
  previewRename: ">{{count}} rename",
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
  choiceLoadedSafe: "Use current files in Detached state",
  choiceLoadedRestore: "Restore loaded checkpoint",
  choiceNavigationTitle: "Destination workspace differs",
  choiceNavigationIntro:
    "Detached navigation keeps the current workspace unassigned and protects the destination checkpoint; restoring applies the destination changes below.",
  choiceNavigationSafe: "Stay at current node",
  choiceNavigationDetach: "Navigate in Detached state — keep current workspace",
  choiceNavigationRestore: "Navigate and restore",
  driftUsage: "Usage: /drift",
  restoreUsage: "Usage: /restore",
  cyclotomyUsage: "Usage: /cyclotomy [stop|resume]",
  commandFailed: "Cyclotomy command failed: {{message}}",
} as const;

export type MessageKey = keyof typeof EN;

const ZH_CN: Record<MessageKey, string> = {
  cyclotomyCommandDescription: "查看、停止或恢复 Cyclotomy",
  cyclotomyStopCompletion: "在当前 Pi 运行期间停止 Cyclotomy",
  cyclotomyResumeCompletion: "仅重试 Cyclotomy，不重新载入 Pi",
  cyclotomyRunning: "Cyclotomy 正在运行。",
  cyclotomyInactive: "Cyclotomy 未在当前 Pi 会话中启用；Pi 仍可正常使用。",
  cyclotomyStopped:
    "Cyclotomy 已在当前 Pi 运行期间停止。可执行 /cyclotomy resume 尝试重新启动。",
  cyclotomyStoppedWithError:
    "Cyclotomy 已在当前 Pi 运行期间停止（{{message}}）。Pi 仍可正常使用；请修复问题后执行 /cyclotomy resume。",
  cyclotomyStopSucceeded:
    "Cyclotomy 已在当前 Pi 运行期间停止；Pi 仍可正常使用。",
  cyclotomyResumeSucceeded: "Cyclotomy 已恢复运行。",
  cyclotomyResumeFailed:
    "Cyclotomy 无法恢复运行（{{message}}）。Pi 仍可正常使用；请修复问题后重试 /cyclotomy resume。",
  driftCommandDescription: "显示 /restore 将执行的文件变化",
  restoreCommandDescription: "恢复当前节点的保存状态",
  checkingWorkspace: "Cyclotomy · 正在检查工作区…",
  restoringWorkspace: "Cyclotomy · 正在恢复工作区…",
  initFailure:
    "Cyclotomy 初始化失败。捕获与恢复不可用，文件没有被改动；Pi 仍可正常使用。请修复报告的配置或存储问题，然后执行 /cyclotomy resume。",
  captureLaterFailed:
    "Cyclotomy 未能完成这次保存；本次保存所指向的状态指针没有改变。",
  arrivalProtectionUnavailable:
    "Cyclotomy 无法持久保护当前抵达位置（{{message}}）。请先保持当前文件不变，并检查 /drift 后再继续。",
  arrivalAdmissionUnavailable:
    "Cyclotomy 已持久保护当前抵达位置，但无法重建其内存准入状态（{{message}}）。此处的保存仍保持阻止；请先检查 /drift 后再继续。",
  automaticGcFailed:
    "Cyclotomy 自动清理失败（{{message}}）。保存状态已经成功建立且会继续工作；稍后将重试清理。",
  captureFailureDetail: "详情：{{message}}",
  captureScanIncomplete: "工作区扫描不完整，未发布检查点：{{message}}",
  captureValidationIncomplete:
    "最终工作区验证不完整，未提交检查点：{{message}}",
  captureValidationFailed: "最终工作区验证失败：{{message}}",
  captureCheckpointChanged: "节点检查点在捕获准备后发生了变化。",
  captureEligibilityChanged: "节点的检查点资格在捕获准备后发生了变化。",
  captureWriteProtected: "节点检查点在恢复完成前受写保护。",
  captureRootChanged: "选择检查点存储后，工作区根目录发生了变化。",
  captureContentsChanged:
    "工作区在捕获扫描与最终验证之间发生了变化，未提交检查点。",
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
  sessionWorkspaceMismatch:
    "Pi 在会话文件所记录工作区之外打开了此会话。Cyclotomy 已在此暂停，且没有绑定或修改任一工作区；请在当前目录创建 Pi 原生 fork，以安全延续此会话。",
  forkImportFailed:
    "Cyclotomy 无法安全完成分支来源登记（{{message}}）；工作区文件未改变，请执行 /cyclotomy resume 重试。",
  forkInheritanceSkipped:
    "Cyclotomy 无法认证父会话的保存状态，或其未通过目标策略准入（{{message}}）；因此没有导入父会话状态，且已阻止保留落点自动接收当前工作区，直到后续明确检查的新落点建立自己的保存状态。",
  navigationPrepareFailed:
    "Cyclotomy 无法安全准备跳转（{{message}}），已取消。",
  navigationScanIncomplete:
    "Cyclotomy 因工作区扫描不完整而取消跳转：{{message}}",
  navigationNeedsUi:
    "目标节点的工作区不同，但当前没有可用的交互选择。跳转已取消，文件没有改动：{{preview}}",
  navigationAttentionStatus:
    "Cyclotomy · 本次跳转需要检查 · 请确认源节点保存状态与当前文件",
  navigationPlanMismatch:
    "Cyclotomy 检测到与预期不同的跳转结果，因此既没有自动恢复，也没有把当前文件归给该节点；请检查后再执行 /restore。",
  navigationChangedAfterPreview:
    "预览后工作区又发生了变化。对话位置已经移动，因此 Cyclotomy 没有给这些后续变化指定节点，也没有恢复文件；源节点保留跳转前已验证的保存状态。请先检查当前文件，再执行 /restore。",
  navigationChangedBeforeDeparture:
    "预览后工作区、源节点或目标保存状态发生了变化，Cyclotomy 已取消跳转。请检查当前源节点文件，然后重试 /tree。",
  navigationDetached:
    "已在 Detached 状态下跳转并保留当前文件。目标节点的保存状态仍受保护；可用 /drift 查看差异，再用 /restore 完成对齐并退出 Detached 状态。",
  navigationDetachFailed:
    "跳转已保留当前文件，但 Cyclotomy 无法认证计划中的 Detached 落点（{{message}}）。Cyclotomy 已尽可能保护实际落点；请先用 /drift 检查再继续。",
  sessionRestoreNeedsUi:
    "载入的会话与工作区不同，但当前无法交互确认。当前文件已在 Detached 状态下保留，且不会替换此节点原有的保存状态；请先用 /drift 检查差异，再在交互式 TUI 中执行 /restore 进行协调。",
  sessionRestoreDeferredRpc:
    "载入的会话与工作区不同。当前文件已在 Detached 状态下保留，且不会替换此节点原有的保存状态；请显式执行 /restore 进行协调。",
  sessionRestoreCancelled:
    "以 Detached 状态继续使用当前文件，但不替换此节点原有的保存状态。",
  sessionMissingProtected:
    "这个节点没有 Cyclotomy 可以安全恢复的保存状态；当前文件仍未归属于该节点。执行 /restore 可将当前工作区记录为它的首个保存状态。",
  sessionCaptureBarrier:
    "由于无法认证完整、稳定的当前祖先链，Cyclotomy 保留了会话捕获屏障；当前文件仍未归属。执行 /reload 不会授予归属或清除该屏障；Cyclotomy 会将其原子地投影到下一条可认证的完整、具体祖先链上。",
  reloadProtected:
    "Cyclotomy 无法确认重新载入的工作区与此保存状态一致；当前文件已保留，检查点捕获仍受保护。请先执行 /drift 检查，再执行 /restore 进行协调。",
  waitIdleRestore: "Cyclotomy：请等 Pi 空闲后再执行 /restore。",
  locationUnknown: "Cyclotomy：当前位置不可识别。",
  restoreMissing: "Cyclotomy：当前位置没有保存状态，无法恢复。",
  restorePrepareFailed: "Cyclotomy 无法准备恢复（{{message}}）。",
  restorePreparationProtected:
    "Cyclotomy 无法读取已载入的保存状态（{{message}}）。当前文件没有改动，且当前抵达位置已受保护，不会被自动捕获覆盖。",
  restorePreparationBarrier:
    "Cyclotomy 无法读取已载入的保存状态（{{message}}）。当前文件仍未归属，且会话捕获屏障会阻止自动归属。",
  restorePreparationUnavailable:
    "Cyclotomy 无法读取已载入的保存状态（{{message}}），也无法保护当前抵达位置（{{protection}}）。当前文件没有改动；请先检查 /drift 再继续。",
  restoreScanIncomplete: "Cyclotomy 因工作区扫描不完整而拒绝恢复：{{message}}",
  restoreNeedsUi:
    "恢复需要交互式选择；当前文件已保留。请先用 /drift 检查差异，再在交互式 TUI 中执行 /restore。",
  commandPreviewStale:
    "Cyclotomy：预览后工作区发生了变化；没有应用任何内容，请重新执行 /restore。",
  commandTargetChanged:
    "Cyclotomy：预览后目标保存状态发生了变化；没有应用任何内容，请重新执行 /restore。",
  commandLocationChanged:
    "Cyclotomy：预览后当前会话、节点或工作区发生了变化；没有应用任何内容。",
  restorePostMutationLocationProtected:
    "Cyclotomy 进入文件应用阶段后，当前会话、节点或工作区发生了变化；文件可能已发生改动。Cyclotomy 已保护当前抵达位置，防止后续捕获覆盖其保存状态；请先运行 /drift 再继续。",
  restorePostMutationLocationUnavailable:
    "Cyclotomy 进入文件应用阶段后，当前会话、节点或工作区发生了变化；文件可能已发生改动，且 Cyclotomy 无法认证并保护当前抵达位置（{{message}}）。请先运行 /drift 检查再继续。",
  restorePostMutationTargetProtected:
    "Cyclotomy 进入文件应用阶段后，目标保存状态发生了变化；文件可能已发生改动。Cyclotomy 已让当前抵达位置保持受保护；请先运行 /drift 再继续。",
  restorePostMutationTargetUnavailable:
    "Cyclotomy 进入文件应用阶段后，目标保存状态发生了变化；文件可能已发生改动，且 Cyclotomy 无法确认当前抵达位置仍受保护（{{message}}）。请先运行 /drift 检查再继续。",
  restorePostMutationControlProtected:
    "Cyclotomy 已进入文件应用阶段，但恢复后的安全检查失败（{{message}}）；文件可能已发生改动。Cyclotomy 已保护当前抵达位置，防止后续捕获覆盖其保存状态；请先运行 /drift 再继续。",
  restorePostMutationControlUnavailable:
    "Cyclotomy 已进入文件应用阶段，但恢复后的安全检查失败（{{message}}）；文件可能已发生改动，且 Cyclotomy 无法认证并保护当前抵达位置（{{protection}}）。请先运行 /drift 检查再继续。",
  restorePostMutationLocationBarrier:
    "Cyclotomy 进入文件应用阶段后，当前会话、节点或工作区发生了变化；文件可能已发生改动。由于无法认证完整、稳定的当前祖先链，当前文件仍未归属，且会话捕获屏障会阻止自动归属。重新载入扩展不会清除该屏障；Cyclotomy 会将其原子地投影到下一条可认证的完整、具体祖先链上。",
  restorePostMutationTargetBarrier:
    "Cyclotomy 进入文件应用阶段后，目标保存状态发生了变化；文件可能已发生改动。由于无法认证完整、稳定的当前祖先链，当前文件仍未归属，且会话捕获屏障会阻止自动归属。重新载入扩展不会清除该屏障；Cyclotomy 会将其原子地投影到下一条可认证的完整、具体祖先链上。",
  restorePostMutationControlBarrier:
    "Cyclotomy 已进入文件应用阶段，但恢复后的安全检查失败（{{message}}）；文件可能已发生改动。由于无法认证完整、稳定的当前祖先链，当前文件仍未归属，且会话捕获屏障会阻止自动归属。重新载入扩展不会清除该屏障；Cyclotomy 会将其原子地投影到下一条可认证的完整、具体祖先链上。",
  checkpointInitializedConflictProtected:
    "Cyclotomy 已把工作区记录为预期节点的首个保存状态，但无法安全接纳当前所在位置（{{message}}）。当前抵达位置已受写入保护；请先运行 /drift 再继续。",
  checkpointInitializedConflictUnavailable:
    "Cyclotomy 已把工作区记录为预期节点的首个保存状态，但无法安全接纳或保护当前所在位置（{{message}}）。请先运行 /drift 检查再继续。",
  checkpointInitializedConflictBarrier:
    "Cyclotomy 已把工作区记录为预期节点的首个保存状态，但随后无法认证完整、稳定的当前祖先链（{{message}}）。当前文件仍未归属，且会话捕获屏障会阻止自动归属。重新载入扩展不会清除该屏障；Cyclotomy 会将其原子地投影到下一条可认证的完整、具体祖先链上。",
  restoreInitialized:
    "已将当前工作区记录为此节点的首个保存状态，并恢复后续检查点捕获。",
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
  restoreExecutionFailed:
    "恢复已进入文件应用阶段并停止（{{message}}）；文件可能已发生改动，请先运行 /drift 再继续。",
  restoreStagingCleanupFailed:
    "Cyclotomy 无法移除恢复时使用的私有暂存数据（{{message}}）；继续前请检查临时存储。",
  workspaceLockCleanupFailed:
    "Cyclotomy 无法完成工作区锁清理（{{message}}）；继续前请检查保存状态存储目录。",
  restoreFailed: "恢复失败（{{message}}）；原保存状态仍是下次恢复的目标。",
  driftMissing: "当前节点还没有可用的保存状态。",
  driftMissingProtected:
    "这个受保护节点没有历史保存状态。执行 /restore 可将当前工作区记录为它的首个保存状态。",
  driftClean: "没有漂移 · 工作区与当前节点的保存状态一致。",
  driftCleanInherited: "没有漂移 · 工作区与最近祖先节点继承的保存状态一致。",
  driftCleanProtected:
    "Detached · 没有漂移；工作区与保存状态一致，但捕获仍受保护。执行 /restore 可退出 Detached 状态并恢复检查点捕获。",
  driftTitle: "工作区漂移\n{{preview}}",
  driftTitleDetached:
    "工作区漂移 · Detached（当前工作区尚未归属此节点）\n{{preview}}",
  driftTitleInherited: "工作区漂移 · 使用最近祖先节点的保存状态\n{{preview}}",
  previewPathOne: "{{count}} 个路径",
  previewPathMany: "{{count}} 个路径",
  previewCreate: "+{{count}} 创建",
  previewOverwrite: "~{{count}} 覆盖",
  previewRename: ">{{count}} 重命名",
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
  choiceLoadedSafe: "以 Detached 状态使用当前文件",
  choiceLoadedRestore: "恢复会话状态",
  choiceNavigationTitle: "目标节点的工作区不同",
  choiceNavigationIntro:
    "Detached 跳转会保留当前工作区，使其暂不归属目标节点，并保护目标保存状态；恢复则会应用下列目标状态。",
  choiceNavigationSafe: "停留在当前节点",
  choiceNavigationDetach: "以 Detached 状态跳转（保留当前工作区）",
  choiceNavigationRestore: "跳转并恢复",
  driftUsage: "用法：/drift",
  restoreUsage: "用法：/restore",
  cyclotomyUsage: "用法：/cyclotomy [stop|resume]",
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

  formatRestorePreview(plan: WorkspaceRestorePlan): string {
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
      ...(plan.renamed.length > 0
        ? [this.t("previewRename", { count: plan.renamed.length })]
        : []),
      ...(plan.created.length > 0
        ? [this.t("previewCreate", { count: plan.created.length })]
        : []),
    ].join(" · ");
    return formatWorkspaceRestorePreview(plan, {
      summary: count === 0 && problemCount > 0 ? "" : summary,
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
      report.created.length +
      report.updated.length +
      report.renamed.length +
      report.deleted.length;
    return this.t(count === 1 ? "restoreSuccessOne" : "restoreSuccessMany", {
      count,
    });
  }

  formatAppliedMutations(report: ApplyReport): string {
    const byPath = (paths: readonly string[], symbol: string) =>
      [...paths]
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
        .map((path) => ({ symbol, path, to: undefined }));
    const mutations = [
      ...byPath(report.deleted, "-"),
      ...byPath(report.updated, "~"),
      ...[...report.renamed]
        .sort((left, right) =>
          left.to < right.to ? -1 : left.to > right.to ? 1 : 0,
        )
        .map(({ from, to }) => ({ symbol: ">", path: from, to })),
      ...byPath(report.created, "+"),
    ];
    if (mutations.length === 0) return this.t("restoreAppliedNone");
    const lines = mutations.map(({ symbol, path, to }) =>
      to === undefined
        ? `${symbol} ${formatUiPath(path)}`
        : `${symbol} ${formatUiPath(path)} → ${formatUiPath(to)}`,
    );
    return this.t("restoreAppliedPaths", { mutations: lines.join("\n") });
  }
}

export function createCyclotomyI18n(locale: CyclotomyLocale): CyclotomyI18n {
  return new CyclotomyI18n(resolveCyclotomyLocale(locale));
}
