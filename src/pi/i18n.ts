import type { CyclotomyLocale } from "../config.ts";
import type {
  ApplyProblem,
  ApplyProblemKind,
  ApplyReport,
} from "../infrastructure/apply.ts";
import type { WorkspaceRestorePlan } from "../infrastructure/restore-plan.ts";
import type { GitReplayRisk } from "../infrastructure/git-replay-risk.ts";
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
  cyclotomyStopCompletion: "Stop Cyclotomy",
  cyclotomyResumeCompletion: "Resume Cyclotomy",
  cyclotomyRunning: "Cyclotomy is running.",
  cyclotomyInactive: "Cyclotomy is unavailable in this session.",
  cyclotomyStopped:
    "Cyclotomy is stopped. Run /cyclotomy resume to start it again.",
  cyclotomyStoppedWithError:
    "Cyclotomy stopped because of an error ({{message}}). Fix the problem, then run /cyclotomy resume.",
  cyclotomyStopSucceeded: "Cyclotomy stopped.",
  cyclotomyResumeSucceeded: "Cyclotomy resumed.",
  cyclotomyResumeFailed:
    "Cyclotomy could not resume ({{message}}). Fix the problem, then try again.",
  driftCommandDescription: "Show what /restore would change",
  restoreCommandDescription: "Restore the current node's checkpoint",
  checkingWorkspace: "Cyclotomy · checking workspace…",
  restoringWorkspace: "Cyclotomy · restoring workspace…",
  initFailure:
    "Cyclotomy could not start. Fix the reported problem, then run /cyclotomy resume.",
  captureLaterFailed:
    "Cyclotomy could not save this checkpoint. The previous checkpoint was kept.",
  arrivalProtectionUnavailable:
    "Cyclotomy could not secure the current files ({{message}}). Run /drift before continuing.",
  arrivalAdmissionUnavailable:
    "Automatic checkpoints are paused at the current node ({{message}}). Run /drift before continuing.",
  automaticGcFailed:
    "Automatic storage cleanup failed ({{message}}). Cyclotomy will try again later.",
  captureFailureDetail: "Details: {{message}}",
  captureScanIncomplete: "Checkpoint not saved: {{message}}",
  captureValidationIncomplete:
    "Checkpoint not saved because the workspace could not be verified: {{message}}",
  captureValidationFailed: "Checkpoint not saved: {{message}}",
  captureCheckpointChanged: "The checkpoint changed while it was being saved.",
  captureEligibilityChanged:
    "The node changed before the checkpoint could be saved.",
  captureWriteProtected: "Automatic checkpoints are paused at this node.",
  captureRootChanged:
    "The workspace location changed while the checkpoint was being saved.",
  captureContentsChanged:
    "The workspace changed while the checkpoint was being saved.",
  sourceCaptureFailed:
    "Cyclotomy could not checkpoint the current workspace, so the operation was cancelled.",
  inputCaptureFailed:
    "Cyclotomy did not submit the prompt because the current workspace could not be checkpointed. Fix the reported problem and submit again.",
  bashWhileBusy: "Wait for the current operation to finish, then try again.",
  transitionInProgress:
    "Another session change is still in progress. Try again when it finishes.",
  sessionRegistrationFailed:
    "Cyclotomy could not enable checkpoints for this session ({{message}}).",
  sessionIdentityUnavailable:
    "Cyclotomy cannot use this session. Checkpoints and restore are unavailable.",
  memorySessionUnsupported:
    "Cyclotomy requires a saved session. It is unavailable with --no-session or in-memory sessions.",
  sessionWorkspaceMismatch:
    "This session was opened in a different workspace. Create a Pi fork in this directory to continue with Cyclotomy.",
  forkImportFailed:
    "Cyclotomy could not import the parent checkpoints ({{message}}). Run /cyclotomy resume to try again.",
  forkInheritanceSkipped:
    "Parent checkpoints were not imported ({{message}}). New work can still be checkpointed, but existing nodes need /restore before they can be checkpointed again.",
  navigationPrepareFailed: "Navigation cancelled: {{message}}",
  navigationScanIncomplete:
    "Navigation cancelled because the workspace could not be read completely: {{message}}",
  navigationNeedsUi:
    "The destination has different files and needs confirmation. Navigation was cancelled: {{preview}}",
  navigationAttentionStatus:
    "Cyclotomy · review the current files before continuing",
  navigationPlanMismatch:
    "Navigation ended at a different node than expected. Current files were kept; run /drift before using /restore.",
  navigationChangedAfterPreview:
    "The workspace changed after the preview. Navigation completed without restoring files; run /drift before using /restore.",
  navigationChangedBeforeDeparture:
    "The workspace or checkpoint changed after the preview. Navigation was cancelled; review the files and try /tree again.",
  navigationDetached:
    "Navigation completed with the current files in Detached state. New work can be checkpointed on the new branch; run /drift, then /restore to reconcile this node.",
  navigationDetachFailed:
    "Navigation kept the current files, but Cyclotomy could not finish entering Detached state ({{message}}). Run /drift before continuing.",
  sessionRestoreNeedsUi:
    "The loaded session has different files and needs confirmation. Current files were kept; run /drift, then use /restore in the interactive TUI.",
  sessionRestoreDeferredRpc:
    "The loaded session has different files. Current files were kept in Detached state; use /restore to apply the checkpoint.",
  sessionRestoreCancelled:
    "Continuing with the current files in Detached state. New work will be checkpointed on a new branch.",
  sessionMissingProtected:
    "This node has no checkpoint. Run /restore to save the current workspace as its first checkpoint.",
  sessionCaptureBarrier:
    "The current state will not be checkpointed automatically because the session history could not be confirmed. Run /drift before continuing; use /restore after review.",
  reloadProtected:
    "The reloaded workspace does not match this checkpoint. Current files were kept, and this node will not be checkpointed automatically; run /drift, then /restore.",
  waitIdleRestore: "Wait for the current operation to finish before restoring.",
  locationUnknown: "Cyclotomy cannot identify the current node.",
  restoreMissing: "There is no checkpoint to restore at this node.",
  restorePrepareFailed: "Restore could not start ({{message}}).",
  restorePreparationProtected:
    "The checkpoint could not be read ({{message}}). Current files were kept and will not be saved automatically at this node.",
  restorePreparationBarrier:
    "The checkpoint could not be read ({{message}}). Current files were kept and will not be saved automatically at this node.",
  restorePreparationUnavailable:
    "The checkpoint could not be read ({{message}}), and Cyclotomy could not secure the current files ({{protection}}). Run /drift before continuing.",
  restoreScanIncomplete:
    "Restore could not start because the workspace could not be read completely: {{message}}",
  restoreNeedsUi:
    "Restore needs confirmation. Current files were kept; run /drift, then use /restore in the interactive TUI.",
  commandPreviewStale:
    "The workspace changed after the preview. Nothing was changed; run /restore again.",
  commandTargetChanged:
    "The checkpoint changed after the preview. Nothing was changed; run /restore again.",
  commandLocationChanged:
    "The session, node, or workspace changed. The operation was cancelled.",
  restorePostMutationLocationProtected:
    "The session, node, or workspace changed during restore. Some files may have changed and will not be saved automatically at this node. Run /drift before continuing.",
  restorePostMutationLocationUnavailable:
    "The session, node, or workspace changed during restore. Some files may have changed, and Cyclotomy could not secure the current files ({{message}}). Run /drift before continuing.",
  restorePostMutationTargetProtected:
    "The checkpoint changed during restore. Some files may have changed and will not be saved automatically at this node. Run /drift before continuing.",
  restorePostMutationTargetUnavailable:
    "The checkpoint changed during restore. Some files may have changed, and Cyclotomy could not secure the current files ({{message}}). Run /drift before continuing.",
  restorePostMutationControlProtected:
    "Restore stopped before Cyclotomy could verify the result ({{message}}). Some files may have changed and will not be saved automatically at this node. Run /drift before continuing.",
  restorePostMutationControlUnavailable:
    "Restore stopped before Cyclotomy could verify the result ({{message}}). Some files may have changed, and Cyclotomy could not secure them ({{protection}}). Run /drift before continuing.",
  restorePostMutationLocationBarrier:
    "The session, node, or workspace changed during restore. Some files may have changed and are not attached to a checkpoint. This state will not be saved automatically; run /drift before continuing.",
  restorePostMutationTargetBarrier:
    "The checkpoint changed during restore. Some files may have changed and are not attached to a checkpoint. This state will not be saved automatically; run /drift before continuing.",
  restorePostMutationControlBarrier:
    "Restore stopped before Cyclotomy could verify the result ({{message}}). Some files may have changed and are not attached to a checkpoint. This state will not be saved automatically; run /drift before continuing.",
  checkpointInitializedConflictProtected:
    "The first checkpoint was saved, but the current node changed before Cyclotomy finished ({{message}}). This state will not be saved automatically; run /drift before continuing.",
  checkpointInitializedConflictUnavailable:
    "The first checkpoint was saved, but the current node changed before Cyclotomy finished ({{message}}). Run /drift before continuing.",
  checkpointInitializedConflictBarrier:
    "The first checkpoint was saved, but the current session history could not be confirmed afterward ({{message}}). This state will not be saved automatically; run /drift before continuing.",
  restoreInitialized:
    "Saved the current workspace as this node's first checkpoint.",
  restoreAlreadyMatches: "Workspace already matches this checkpoint.",
  restoreSuccessOne: "Workspace restored · {{count}} path changed.",
  restoreSuccessMany: "Workspace restored · {{count}} paths changed.",
  checkpointUnreadable:
    "Restore did not start because the checkpoint could not be read ({{message}}). No files were changed.",
  restoreApplyIncomplete:
    "Restore could not apply every workspace change:\n{{problems}}\n{{applied}}\nRun /drift to inspect the result, then /restore to retry.",
  restoreVerifyFailed:
    "Files changed, but Cyclotomy could not verify the final workspace.\n{{applied}}\nRun /drift before continuing.",
  restoreAppliedNone: "No files were changed before restore stopped.",
  restoreAppliedPaths: "Changed before restore stopped:\n{{mutations}}",
  restoreNotStarted:
    "Restore did not start ({{message}}). No files were changed.",
  restoreExecutionFailed:
    "Restore stopped ({{message}}). Some files may have changed; run /drift before continuing.",
  restorePreparationCleanupFailed:
    "Cyclotomy could not clean up restore files ({{message}}). Try again before continuing.",
  workspaceLockCleanupFailed:
    "Cyclotomy could not finish using its storage ({{message}}). Close other Cyclotomy sessions using this workspace, then try again.",
  restoreFailed:
    "Restore failed ({{message}}). Run /drift to review the current files.",
  driftMissing: "No checkpoint is available for this node yet.",
  driftMissingProtected:
    "This node has no checkpoint. Run /restore to save the current workspace as its first checkpoint.",
  driftClean: "No drift · workspace matches this node's checkpoint.",
  driftCleanInherited:
    "No drift · workspace matches the checkpoint inherited from the nearest ancestor.",
  driftCleanProtected:
    "Detached · no drift. Run /restore to attach the workspace to this node.",
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
    "Preview incomplete · {{count}} workspace issue; /restore is unavailable",
  previewProblemMany:
    "Preview incomplete · {{count}} workspace issues; /restore is unavailable",
  previewScopeNotice:
    "Note: ignore rules will also be restored; paths excluded by this checkpoint stay untouched.",
  gitReplayRiskLegacy:
    "Warning: this checkpoint was saved with an unknown Git version. {{current}} may interpret its ignore rules differently; review the full plan before confirming.",
  gitReplayRiskVersionMismatch:
    "Warning: this checkpoint was saved with {{captured}}, but restore is using {{current}}. Ignore rules may behave differently; review the full plan before confirming.",
  gitReplayVersionUnknown: "an unknown Git version",
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
    "Choose which files to continue with. Restoring discards the differences below.",
  choiceLoadedSafe: "Use current files in Detached state",
  choiceLoadedRestore: "Restore loaded checkpoint",
  choiceNavigationTitle: "Destination workspace differs",
  choiceNavigationIntro:
    "Keep the current files in Detached state, or apply the destination checkpoint shown below.",
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
  cyclotomyStopCompletion: "停止 Cyclotomy",
  cyclotomyResumeCompletion: "恢复 Cyclotomy",
  cyclotomyRunning: "Cyclotomy 正在运行。",
  cyclotomyInactive: "当前会话无法使用 Cyclotomy。",
  cyclotomyStopped: "Cyclotomy 已停止。执行 /cyclotomy resume 可重新启动。",
  cyclotomyStoppedWithError:
    "Cyclotomy 因错误停止（{{message}}）。修复问题后执行 /cyclotomy resume。",
  cyclotomyStopSucceeded: "Cyclotomy 已停止。",
  cyclotomyResumeSucceeded: "Cyclotomy 已恢复。",
  cyclotomyResumeFailed: "Cyclotomy 无法恢复（{{message}}）。修复问题后重试。",
  driftCommandDescription: "显示 /restore 将执行的文件变化",
  restoreCommandDescription: "恢复当前节点的检查点",
  checkingWorkspace: "Cyclotomy · 正在检查工作区…",
  restoringWorkspace: "Cyclotomy · 正在恢复工作区…",
  initFailure:
    "Cyclotomy 无法启动。请修复报告的问题，然后执行 /cyclotomy resume。",
  captureLaterFailed: "Cyclotomy 无法保存此检查点，已保留原检查点。",
  arrivalProtectionUnavailable:
    "Cyclotomy 无法保护当前文件（{{message}}）。继续前请先运行 /drift。",
  arrivalAdmissionUnavailable:
    "当前节点的自动检查点已暂停（{{message}}）。继续前请先运行 /drift。",
  automaticGcFailed: "自动清理存储失败（{{message}}）。Cyclotomy 稍后会重试。",
  captureFailureDetail: "详情：{{message}}",
  captureScanIncomplete: "检查点未保存：{{message}}",
  captureValidationIncomplete: "无法确认工作区状态，检查点未保存：{{message}}",
  captureValidationFailed: "检查点未保存：{{message}}",
  captureCheckpointChanged: "保存期间，检查点发生了变化。",
  captureEligibilityChanged: "保存检查点前，当前节点发生了变化。",
  captureWriteProtected: "当前节点的自动检查点已暂停。",
  captureRootChanged: "保存检查点期间，工作区位置发生了变化。",
  captureContentsChanged: "保存检查点期间，工作区发生了变化。",
  sourceCaptureFailed: "Cyclotomy 无法保存当前工作区，因此已取消本次操作。",
  inputCaptureFailed:
    "Cyclotomy 因无法保存当前工作区而没有提交这条提示。请修复上述问题后重新提交。",
  bashWhileBusy: "请等待当前操作完成后重试。",
  transitionInProgress: "另一项会话切换尚未完成，请稍后重试。",
  sessionRegistrationFailed:
    "Cyclotomy 无法为此会话启用检查点（{{message}}）。",
  sessionIdentityUnavailable: "Cyclotomy 无法使用此会话，检查点与恢复不可用。",
  memorySessionUnsupported:
    "Cyclotomy 需要已保存的会话；--no-session 和内存会话不受支持。",
  sessionWorkspaceMismatch:
    "此会话在另一个工作区中打开。请在当前目录创建 Pi fork，再继续使用 Cyclotomy。",
  forkImportFailed:
    "Cyclotomy 无法导入父会话的检查点（{{message}}）。请执行 /cyclotomy resume 重试。",
  forkInheritanceSkipped:
    "未导入父会话的检查点（{{message}}）。新工作仍会保存检查点；已有节点需要先执行 /restore，才能再次保存检查点。",
  navigationPrepareFailed: "跳转已取消：{{message}}",
  navigationScanIncomplete: "无法完整读取工作区，跳转已取消：{{message}}",
  navigationNeedsUi: "目标节点的文件不同，需要确认后才能跳转：{{preview}}",
  navigationAttentionStatus: "Cyclotomy · 继续前请检查当前文件",
  navigationPlanMismatch:
    "跳转到达了预期之外的节点。已保留当前文件；执行 /restore 前请先运行 /drift。",
  navigationChangedAfterPreview:
    "预览后工作区发生了变化。跳转已完成，但没有恢复文件；执行 /restore 前请先运行 /drift。",
  navigationChangedBeforeDeparture:
    "预览后工作区或检查点发生了变化。跳转已取消；请检查文件后重试 /tree。",
  navigationDetached:
    "跳转已完成，并在 Detached 状态下保留当前文件。新工作仍会在新分支上保存检查点；请先运行 /drift，再用 /restore 处理当前节点。",
  navigationDetachFailed:
    "跳转已保留当前文件，但无法完成 Detached 状态切换（{{message}}）。继续前请先运行 /drift。",
  sessionRestoreNeedsUi:
    "载入的会话与当前文件不同，需要确认。请先运行 /drift，再在交互式 TUI 中执行 /restore。",
  sessionRestoreDeferredRpc:
    "载入的会话与当前文件不同。已在 Detached 状态下保留当前文件；执行 /restore 可应用检查点。",
  sessionRestoreCancelled:
    "继续使用当前文件，并进入 Detached 状态。新工作会在新分支上保存检查点。",
  sessionMissingProtected:
    "当前节点没有检查点。执行 /restore 可将当前工作区保存为首个检查点。",
  sessionCaptureBarrier:
    "Cyclotomy 无法确认当前会话历史，因此不会自动保存当前状态。继续前请先运行 /drift，检查后再使用 /restore。",
  reloadProtected:
    "重新载入的工作区与此检查点不同。已保留当前文件，且当前节点不会自动保存检查点；请运行 /drift，再执行 /restore。",
  waitIdleRestore: "请等待当前操作完成后再恢复。",
  locationUnknown: "Cyclotomy 无法识别当前节点。",
  restoreMissing: "当前节点没有可恢复的检查点。",
  restorePrepareFailed: "恢复无法开始（{{message}}）。",
  restorePreparationProtected:
    "无法读取检查点（{{message}}）。已保留当前文件，且不会在此节点自动保存。",
  restorePreparationBarrier:
    "无法读取检查点（{{message}}）。已保留当前文件，且不会在此节点自动保存。",
  restorePreparationUnavailable:
    "无法读取检查点（{{message}}），也无法保护当前文件（{{protection}}）。继续前请先运行 /drift。",
  restoreScanIncomplete: "无法完整读取工作区，恢复未开始：{{message}}",
  restoreNeedsUi:
    "恢复需要确认。已保留当前文件；请先运行 /drift，再在交互式 TUI 中执行 /restore。",
  commandPreviewStale:
    "预览后工作区发生了变化。文件没有改动；请重新执行 /restore。",
  commandTargetChanged:
    "预览后检查点发生了变化。文件没有改动；请重新执行 /restore。",
  commandLocationChanged: "会话、节点或工作区发生了变化，操作已取消。",
  restorePostMutationLocationProtected:
    "恢复期间，会话、节点或工作区发生了变化。部分文件可能已改动，且不会在此节点自动保存；继续前请先运行 /drift。",
  restorePostMutationLocationUnavailable:
    "恢复期间，会话、节点或工作区发生了变化。部分文件可能已改动，且 Cyclotomy 无法保护当前文件（{{message}}）；继续前请先运行 /drift。",
  restorePostMutationTargetProtected:
    "恢复期间，检查点发生了变化。部分文件可能已改动，且不会在此节点自动保存；继续前请先运行 /drift。",
  restorePostMutationTargetUnavailable:
    "恢复期间，检查点发生了变化。部分文件可能已改动，且 Cyclotomy 无法保护当前文件（{{message}}）；继续前请先运行 /drift。",
  restorePostMutationControlProtected:
    "恢复结果无法确认（{{message}}）。部分文件可能已改动，且不会在此节点自动保存；继续前请先运行 /drift。",
  restorePostMutationControlUnavailable:
    "恢复结果无法确认（{{message}}）。部分文件可能已改动，且 Cyclotomy 无法保护当前文件（{{protection}}）；继续前请先运行 /drift。",
  restorePostMutationLocationBarrier:
    "恢复期间，会话、节点或工作区发生了变化。部分文件可能已改动，且尚未归入检查点。此状态不会自动保存；继续前请先运行 /drift。",
  restorePostMutationTargetBarrier:
    "恢复期间，检查点发生了变化。部分文件可能已改动，且尚未归入检查点。此状态不会自动保存；继续前请先运行 /drift。",
  restorePostMutationControlBarrier:
    "恢复结果无法确认（{{message}}）。部分文件可能已改动，且尚未归入检查点。此状态不会自动保存；继续前请先运行 /drift。",
  checkpointInitializedConflictProtected:
    "首个检查点已保存，但当前节点随后发生了变化（{{message}}）。此状态不会自动保存；继续前请先运行 /drift。",
  checkpointInitializedConflictUnavailable:
    "首个检查点已保存，但当前节点随后发生了变化（{{message}}）。继续前请先运行 /drift。",
  checkpointInitializedConflictBarrier:
    "首个检查点已保存，但随后无法确认当前会话历史（{{message}}）。此状态不会自动保存；继续前请先运行 /drift。",
  restoreInitialized: "已将当前工作区保存为此节点的首个检查点。",
  restoreAlreadyMatches: "工作区已与此检查点一致。",
  restoreSuccessOne: "工作区已恢复 · 改动 {{count}} 个路径。",
  restoreSuccessMany: "工作区已恢复 · 改动 {{count}} 个路径。",
  checkpointUnreadable:
    "无法读取检查点，恢复未开始（{{message}}）。文件没有改动。",
  restoreApplyIncomplete:
    "恢复未能应用全部工作区变更：\n{{problems}}\n{{applied}}\n请运行 /drift 检查结果，再运行 /restore 重试。",
  restoreVerifyFailed:
    "文件已经改动，但 Cyclotomy 无法确认最终工作区状态。\n{{applied}}\n请先运行 /drift 再继续。",
  restoreAppliedNone: "恢复停止前没有改动文件。",
  restoreAppliedPaths: "恢复停止前已改动：\n{{mutations}}",
  restoreNotStarted: "恢复未开始（{{message}}）。文件没有改动。",
  restoreExecutionFailed:
    "恢复已停止（{{message}}）。部分文件可能已改动；继续前请先运行 /drift。",
  restorePreparationCleanupFailed:
    "Cyclotomy 无法清理恢复文件（{{message}}）。请重试后再继续。",
  workspaceLockCleanupFailed:
    "Cyclotomy 无法结束本次存储操作（{{message}}）。请关闭其他正在使用此工作区的 Cyclotomy 会话后重试。",
  restoreFailed: "恢复失败（{{message}}）。请运行 /drift 检查当前文件。",
  driftMissing: "当前节点还没有检查点。",
  driftMissingProtected:
    "当前节点没有检查点。执行 /restore 可将当前工作区保存为首个检查点。",
  driftClean: "没有差异 · 工作区与当前节点的检查点一致。",
  driftCleanInherited: "没有差异 · 工作区与最近祖先节点的检查点一致。",
  driftCleanProtected:
    "Detached · 没有差异。执行 /restore 可将工作区归入当前节点。",
  driftTitle: "工作区差异\n{{preview}}",
  driftTitleDetached:
    "工作区差异 · Detached（当前工作区尚未归属此节点）\n{{preview}}",
  driftTitleInherited: "工作区差异 · 使用最近祖先节点的检查点\n{{preview}}",
  previewPathOne: "{{count}} 个路径",
  previewPathMany: "{{count}} 个路径",
  previewCreate: "+{{count}} 创建",
  previewOverwrite: "~{{count}} 覆盖",
  previewRename: ">{{count}} 重命名",
  previewDelete: "-{{count}} 删除",
  previewOmitted: "… 还有 {{count}} 项",
  previewProblemOne: "预览不完整 · {{count}} 个工作区问题；/restore 不可用",
  previewProblemMany: "预览不完整 · {{count}} 个工作区问题；/restore 不可用",
  previewScopeNotice: "提示：忽略规则也会恢复；此检查点排除的路径不会被改动。",
  gitReplayRiskLegacy:
    "警告：保存此检查点时使用的 Git 版本未知。{{current}} 对忽略规则的解释可能不同；确认前请检查完整计划。",
  gitReplayRiskVersionMismatch:
    "警告：此检查点由 {{captured}} 保存，但恢复将使用 {{current}}。忽略规则的行为可能不同；确认前请检查完整计划。",
  gitReplayVersionUnknown: "未知 Git 版本",
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
  choiceManualTitle: "恢复当前节点的检查点？",
  choiceManualIntro: "恢复会丢弃下列当前差异，Cyclotomy 无法撤销此次操作。",
  choiceManualSafe: "取消（不改动文件）",
  choiceManualRestore: "恢复检查点",
  choiceLoadedTitle: "载入的会话与工作区不同",
  choiceLoadedIntro: "请选择继续使用哪组文件；恢复会丢弃下列当前差异。",
  choiceLoadedSafe: "以 Detached 状态使用当前文件",
  choiceLoadedRestore: "恢复会话状态",
  choiceNavigationTitle: "目标节点的工作区不同",
  choiceNavigationIntro:
    "保留当前文件并进入 Detached 状态，或应用下列目标检查点。",
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

  formatGitReplayRisk(risk: GitReplayRisk): string | undefined {
    const version = (value: string | null): string =>
      value === null
        ? this.t("gitReplayVersionUnknown")
        : formatUiDetail(value);
    switch (risk.kind) {
      case "none":
        return undefined;
      case "legacy-unattested":
        return this.t("gitReplayRiskLegacy", {
          current: version(risk.currentGitVersion),
        });
      case "version-mismatch":
        return this.t("gitReplayRiskVersionMismatch", {
          captured: version(risk.capturedGitVersion),
          current: version(risk.currentGitVersion),
        });
    }
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
