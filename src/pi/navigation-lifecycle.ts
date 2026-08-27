import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { NodeKey } from "../domain/model.ts";
import type { CleanupSettlement } from "../domain/cleanup-settlement.ts";
import { restorePlanHasChanges } from "../infrastructure/restore-plan.ts";
import { gitReplayRisk } from "../infrastructure/git-replay-risk.ts";
import {
  finalizeArrivalAfterWorkspaceExecution,
  isLockedArrivalOutcome,
  protectCurrentArrivalAfterWorkspaceFailure,
  type CheckpointInitializationConflict,
  type PostMutationConflict,
} from "./post-mutation.ts";
import type { ArrivalDisposition } from "./arrival-settlement.ts";
import { applyActiveArrivalSettlement } from "./active-arrival-settlement.ts";
import {
  requestNavigationChoice,
  type NavigationChoice,
} from "./restore-choice.ts";
import {
  notifyCheckpointInitializationConflict,
  notifyArrivalDispositionFailure,
  notifyArrivalRecovery,
  notifyPostMutationConflict,
  notifyRestoreProtocolOutcome,
  notifyWorkspaceLockCleanupFailure,
  participationMessage,
} from "./restore-notifications.ts";
import { CyclotomyRuntime } from "./runtime.ts";
import {
  SessionViewTracker,
  type AuthenticatedTreeArrival,
  type SessionView,
} from "./session-view.ts";
import {
  type LockedTreeArrivalOutcome,
  type TreeArrivalExecution,
  type TreeArrivalResult,
} from "./tree-arrival-outcome.ts";
import { executeTreeArrivalInWorkspaceLock } from "./tree-arrival-protocol.ts";
import {
  commitNavigationDepartureInWorkspaceLock,
  prepareNavigationDepartureInWorkspaceLock,
  type SourceBlockReason,
} from "./navigation-departure-protocol.ts";
import {
  WorkspaceMutationProtocol,
  type RestoreProtocolOutcome,
} from "./workspace-mutation-protocol.ts";
import { assertNever } from "./assert-never.ts";
import { formatCaptureFailure } from "./capture-failure.ts";
import { sourceCaptureFailureImpact } from "./source-capture-failure.ts";
import { withdrawAfterStoreBindingFailure } from "./store-binding-failure.ts";
import { messageOfUnknown as messageOf } from "./unknown-error.ts";
import type { PiHostAdapter } from "./pi-host-adapter.ts";
import type {
  ArrivalReceipt,
  ArrivalRecoverySettlement,
} from "./workspace-receipt.ts";
import {
  revalidateNavigationLocation as readExactLocation,
  sameNavigationNode as sameNode,
} from "./navigation-authentication.ts";

function withDetail(message: string, detail: string): string {
  return `${message} ${detail}`;
}

function sourceBlockDetail(reason: SourceBlockReason): string {
  switch (reason) {
    case "not-admitted":
      return "source location is not admitted for checkpointing";
    case "changed-before-publication":
      return "source location changed before checkpoint publication";
    default:
      return assertNever(reason, "unhandled source block reason");
  }
}

function isLockedTreeArrivalOutcome(
  value: TreeArrivalExecution | LockedTreeArrivalOutcome,
): value is LockedTreeArrivalOutcome {
  return isLockedArrivalOutcome(value);
}

type NavigationDisposition =
  "plan-mismatch" | "preview-stale" | "detached" | "protected";

function notifyNavigationDisposition(
  runtime: CyclotomyRuntime,
  context: ExtensionContext,
  disposition: NavigationDisposition,
): void {
  switch (disposition) {
    case "plan-mismatch":
      runtime.notify(
        context,
        participationMessage(
          runtime,
          "navigationPlanMismatch",
          "navigationPlanMismatchFact",
        ),
        "warning",
      );
      return;
    case "preview-stale":
      runtime.notify(
        context,
        participationMessage(
          runtime,
          "navigationChangedAfterPreview",
          "navigationChangedAfterPreviewFact",
        ),
        "warning",
      );
      return;
    case "detached":
      runtime.notify(
        context,
        participationMessage(
          runtime,
          "navigationDetached",
          "navigationDetachedFact",
        ),
        "info",
      );
      return;
    case "protected":
      runtime.notify(
        context,
        participationMessage(
          runtime,
          "sessionMissingProtected",
          "sessionMissingFact",
        ),
        "warning",
      );
      return;
    default:
      return assertNever(disposition, "unhandled navigation disposition");
  }
}

/** Register the two-phase Pi tree-navigation protocol. */
export function registerNavigationLifecycle(
  pi: Pick<ExtensionAPI, "on">,
  runtime: CyclotomyRuntime,
  views: SessionViewTracker,
  host: PiHostAdapter,
): void {
  pi.on(
    "session_before_tree",
    host.guard({
      pass: undefined,
      active: async (event, context) => {
        runtime.setStatus(context, undefined);
        const recoverPreparationFailure = async (
          cause: unknown,
        ): Promise<ArrivalRecoverySettlement> => {
          const recovery = await runtime.withdrawFromParticipation(
            context,
            cause,
          );
          applyActiveArrivalSettlement(runtime, recovery.arrival);
          return recovery;
        };
        const withdrawAndPresentPreparationFailure = async (
          cause: unknown,
          cleanup: CleanupSettlement = { kind: "settled" },
        ): Promise<void> => {
          const recovery = await recoverPreparationFailure(
            cleanup.kind === "failed" ? cleanup.cause : cause,
          );
          const presentedCauses = new Set<unknown>([cause]);
          runtime.notify(
            context,
            withDetail(
              runtime.i18n.t("sourceCaptureStopped"),
              runtime.i18n.t("captureFailureDetail", {
                message: messageOf(cause),
              }),
            ),
            "error",
          );
          if (
            cleanup.kind === "failed" &&
            !presentedCauses.has(cleanup.cause)
          ) {
            notifyWorkspaceLockCleanupFailure(runtime, context, cleanup);
            presentedCauses.add(cleanup.cause);
          }
          notifyArrivalRecovery(runtime, context, recovery, presentedCauses);
        };
        let view: SessionView;
        try {
          view = views.revalidate(context);
          if (!runtime.registrations.sessionIsUsable(view)) {
            runtime.notify(
              context,
              runtime.i18n.t("commandLocationChanged"),
              "warning",
            );
            return { cancel: true };
          }
          if (!context.isIdle()) {
            runtime.notify(
              context,
              runtime.i18n.t("transitionInProgress"),
              "warning",
            );
            return { cancel: true };
          }
        } catch (error) {
          await withdrawAndPresentPreparationFailure(error);
          return undefined;
        }
        const preparation = await runtime.admission.runTreePreparation(
          async () => {
            try {
              runtime.setStatus(context, runtime.i18n.t("checkingWorkspace"));
              if (!(await runtime.ensureStore(view.cwd))) {
                await withdrawAfterStoreBindingFailure(runtime, context);
                return undefined;
              }
              const authenticated = readExactLocation(
                runtime,
                views,
                context,
                view,
              );
              if (authenticated === undefined) {
                runtime.notify(
                  context,
                  runtime.i18n.t("commandLocationChanged"),
                  "warning",
                );
                return undefined;
              }
              view = authenticated;
              if (
                event.preparation.oldLeafId !== view.leafId ||
                event.preparation.targetId.length === 0
              ) {
                runtime.notify(
                  context,
                  runtime.i18n.t("navigationPlanMismatch"),
                  "warning",
                );
                return undefined;
              }
              const expectedDestinationId = view.navigationLandingId(
                event.preparation.targetId,
              );
              if (expectedDestinationId === undefined) {
                runtime.notify(
                  context,
                  runtime.i18n.t("navigationPlanMismatch"),
                  "warning",
                );
                return undefined;
              }
              const source = runtime.checkpoints.captureAnchor(view);
              const target =
                expectedDestinationId === null
                  ? undefined
                  : runtime.checkpoints.captureAnchor(
                      view,
                      expectedDestinationId,
                    );
              if (expectedDestinationId !== null && target === undefined) {
                runtime.notify(
                  context,
                  runtime.i18n.t("navigationPlanMismatch"),
                  "warning",
                );
                return undefined;
              }

              const preparationExecution = await runtime
                .enqueueWorkspaceExecution("tree-prepare", (writeAuthority) =>
                  prepareNavigationDepartureInWorkspaceLock(
                    runtime,
                    views,
                    context,
                    writeAuthority,
                    view,
                    source,
                    target,
                  ),
                )
                .catch((cause: unknown) => ({
                  kind: "acquisition-failed" as const,
                  cause,
                }));
              if (preparationExecution.kind === "acquisition-failed") {
                await withdrawAndPresentPreparationFailure(
                  preparationExecution.cause,
                );
                return undefined;
              }
              if (preparationExecution.cleanup.kind === "failed") {
                await withdrawAndPresentPreparationFailure(
                  preparationExecution.kind === "action-failed"
                    ? preparationExecution.cause
                    : preparationExecution.cleanup.cause,
                  preparationExecution.cleanup,
                );
                return undefined;
              }
              if (preparationExecution.kind === "action-failed") {
                await withdrawAndPresentPreparationFailure(
                  preparationExecution.cause,
                );
                return undefined;
              }
              const prepared = preparationExecution.value;

              if (prepared.kind === "scan-incomplete") {
                const detail = runtime.i18n.formatScanProblems(
                  prepared.problems,
                );
                const cause = new Error(
                  `tree preparation workspace scan was incomplete: ${detail}`,
                );
                await withdrawAndPresentPreparationFailure(cause);
                return undefined;
              }
              if (prepared.kind === "location-changed") {
                runtime.notify(
                  context,
                  runtime.i18n.t("commandLocationChanged"),
                  "warning",
                );
                return undefined;
              }
              if (prepared.kind === "source-blocked") {
                runtime.notify(
                  context,
                  withDetail(
                    runtime.i18n.t("sourceCaptureFailed"),
                    runtime.i18n.t("captureFailureDetail", {
                      message: sourceBlockDetail(prepared.reason),
                    }),
                  ),
                  "error",
                );
                return undefined;
              }
              let navigationChoice: NavigationChoice = "restore";
              if (
                prepared.drift !== undefined &&
                restorePlanHasChanges(prepared.drift)
              ) {
                const replayRisk = gitReplayRisk(
                  prepared.restoreSnapshot!.scope,
                  prepared.restoreSnapshot!.gitOracleVersion,
                );
                if (!context.hasUI) {
                  const riskNotice =
                    runtime.i18n.formatGitReplayRisk(replayRisk);
                  runtime.notify(
                    context,
                    runtime.i18n.t("navigationNeedsUi", {
                      preview: [
                        riskNotice,
                        runtime.i18n.formatRestorePreview(prepared.drift),
                      ]
                        .filter((part): part is string => part !== undefined)
                        .join("\n\n"),
                    }),
                    "warning",
                  );
                  return undefined;
                }
                runtime.setStatus(context, undefined);
                try {
                  navigationChoice = await requestNavigationChoice(
                    runtime,
                    context,
                    prepared.drift,
                    replayRisk,
                    event.signal,
                  );
                } catch (error) {
                  if (event.signal.aborted) {
                    runtime.notify(
                      context,
                      runtime.i18n.t("commandLocationChanged"),
                      "warning",
                    );
                    return undefined;
                  }
                  await withdrawAndPresentPreparationFailure(error);
                  return undefined;
                }
                if (navigationChoice === "stay") {
                  return undefined;
                }
                runtime.setStatus(context, runtime.i18n.t("checkingWorkspace"));
              }
              const commitExecution = await runtime
                .enqueueWorkspaceExecution("tree-commit", (writeAuthority) =>
                  commitNavigationDepartureInWorkspaceLock(
                    runtime,
                    views,
                    context,
                    writeAuthority,
                    view,
                    source,
                    target,
                    prepared,
                    navigationChoice,
                  ),
                )
                .catch((cause: unknown) => ({
                  kind: "acquisition-failed" as const,
                  cause,
                }));
              const committed =
                commitExecution.kind === "acquisition-failed"
                  ? ({
                      kind: "failed" as const,
                      cause: commitExecution.cause,
                    } as const)
                  : commitExecution.kind === "action-failed"
                    ? ({
                        kind: "failed" as const,
                        cause: commitExecution.cause,
                      } as const)
                    : commitExecution.value;
              if (commitExecution.kind !== "acquisition-failed") {
                if (commitExecution.cleanup.kind === "failed") {
                  await withdrawAndPresentPreparationFailure(
                    commitExecution.kind === "action-failed"
                      ? commitExecution.cause
                      : commitExecution.cleanup.cause,
                    commitExecution.cleanup,
                  );
                  return undefined;
                }
              }
              if (committed.kind !== "ready") {
                switch (committed.kind) {
                  case "location-changed":
                    runtime.notify(
                      context,
                      runtime.i18n.t("commandLocationChanged"),
                      "warning",
                    );
                    break;
                  case "scan-incomplete":
                    {
                      const detail = runtime.i18n.formatScanProblems(
                        committed.problems,
                      );
                      const cause = new Error(
                        `tree commit workspace scan was incomplete: ${detail}`,
                      );
                      await withdrawAndPresentPreparationFailure(cause);
                    }
                    break;
                  case "preview-stale":
                    runtime.notify(
                      context,
                      runtime.i18n.t("navigationChangedBeforeDeparture"),
                      "warning",
                    );
                    break;
                  case "target-changed":
                    runtime.notify(
                      context,
                      runtime.i18n.t("navigationChangedBeforeDeparture"),
                      "warning",
                    );
                    break;
                  case "capture-failed":
                    {
                      const detail = formatCaptureFailure(
                        runtime.i18n,
                        committed.failure,
                      );
                      const withdrawn =
                        sourceCaptureFailureImpact({
                          kind: "capture",
                          value: committed.failure,
                        }) === "withdraw-participation";
                      if (withdrawn) {
                        await withdrawAndPresentPreparationFailure(
                          new Error(detail),
                        );
                      } else {
                        runtime.notify(
                          context,
                          withDetail(
                            runtime.i18n.t("sourceCaptureFailed"),
                            runtime.i18n.t("captureFailureDetail", {
                              message: detail,
                            }),
                          ),
                          "error",
                        );
                      }
                    }
                    break;
                  case "workspace-binding-lost":
                    {
                      const cause = new Error(
                        "registered workspace binding was lost during tree preparation",
                      );
                      await withdrawAndPresentPreparationFailure(cause);
                    }
                    break;
                  case "source-blocked":
                    runtime.notify(
                      context,
                      withDetail(
                        runtime.i18n.t("sourceCaptureFailed"),
                        runtime.i18n.t("captureFailureDetail", {
                          message: sourceBlockDetail(committed.reason),
                        }),
                      ),
                      "error",
                    );
                    break;
                  case "busy":
                    runtime.notify(
                      context,
                      runtime.i18n.t("transitionInProgress"),
                      "warning",
                    );
                    break;
                  case "failed":
                    await withdrawAndPresentPreparationFailure(committed.cause);
                    break;
                }
                return undefined;
              }
              // Workspace execution resolves through a microtask. Recheck the public
              // streaming boundary after that yield and immediately before publishing
              // the host proposal.
              if (!context.isIdle()) {
                runtime.notify(
                  context,
                  runtime.i18n.t("transitionInProgress"),
                  "warning",
                );
                return undefined;
              }
              return {
                sessionId: view.sessionId,
                cwd: view.cwd,
                expectedOldLeafId: view.leafId,
                expectedDestinationId,
                previewSnapshot: committed.snapshot,
                target: committed.target,
              };
            } catch (error) {
              await withdrawAndPresentPreparationFailure(error);
              return undefined;
            } finally {
              runtime.setStatus(context, undefined);
            }
          },
        );
        if (runtime.activation.kind !== "active") return undefined;
        switch (preparation.kind) {
          case "accepted":
            return undefined;
          case "cancelled":
          case "stale":
            return { cancel: true };
          case "busy":
          case "retired-conflict":
          case "closed":
            runtime.notify(
              context,
              runtime.i18n.t("transitionInProgress"),
              "warning",
            );
            return { cancel: true };
          default:
            return assertNever(
              preparation,
              "unhandled tree preparation result",
            );
        }
      },
    }),
  );

  pi.on(
    "session_tree",
    host.observe(async (event, context) => {
      const arrival = runtime.admission.beginTreeArrival();
      const plan = arrival.plan;
      const attentionStatus = () =>
        runtime.setStatus(
          context,
          runtime.isActive
            ? runtime.i18n.t("navigationAttentionStatus")
            : undefined,
        );
      const presentCaptureFailure = (detail: string): void => {
        runtime.notify(
          context,
          withDetail(
            runtime.i18n.t(
              runtime.activation.kind === "active"
                ? "sourceCaptureProtected"
                : "sourceCaptureStopped",
            ),
            runtime.i18n.t("captureFailureDetail", { message: detail }),
          ),
          "error",
        );
      };

      const recoverCurrentArrival = () =>
        protectCurrentArrivalAfterWorkspaceFailure(
          runtime.workspaceMutations,
          context,
        );

      const protectCurrentArrival = async (): Promise<ArrivalDisposition> => {
        const recovery = await recoverCurrentArrival();
        applyActiveArrivalSettlement(runtime, recovery.arrival);
        notifyWorkspaceLockCleanupFailure(
          runtime,
          context,
          recovery.workspaceLockCleanup,
        );
        return recovery.arrival;
      };

      const protectAndAttend = async (
        notify: () => void,
      ): Promise<ArrivalDisposition> => {
        const disposition = await protectCurrentArrival();
        notifyArrivalDispositionFailure(runtime, context, disposition);
        notify();
        attentionStatus();
        return disposition;
      };

      const settleCarriedArrival = async (
        view: SessionView,
        node: NodeKey | undefined,
      ): Promise<ArrivalDisposition> => {
        if (
          runtime.workspaceMutations.carryCurrentTreeArrival(
            arrival,
            view,
            node,
          )
        ) {
          runtime.setStatus(context, undefined);
          return { kind: "admitted" };
        }
        return protectAndAttend(() => undefined);
      };

      let view: SessionView;
      let authenticatedArrival: AuthenticatedTreeArrival;
      let actualAnchor: NodeKey | undefined;
      try {
        view = views.revalidate(context);
        runtime.assertSessionUsable(view);
        const authenticated =
          plan === undefined
            ? undefined
            : view.authenticateTreeArrival(event, plan);
        if (plan === undefined || authenticated === undefined) {
          await protectAndAttend(() =>
            notifyNavigationDisposition(runtime, context, "plan-mismatch"),
          );
          return;
        }
        authenticatedArrival = authenticated;
        actualAnchor = runtime.checkpoints.captureAnchor(view);
        if (!context.isIdle()) {
          await protectAndAttend(() =>
            runtime.notify(
              context,
              runtime.i18n.t("transitionInProgress"),
              "warning",
            ),
          );
          return;
        }
        // A no-move event is still an arrival authority handoff: carry only
        // after the immutable graph proves the exact stable source survived.
        if (event.newLeafId === event.oldLeafId) {
          await settleCarriedArrival(view, actualAnchor);
          return;
        }
        if (
          plan.target.kind === "same-location" &&
          sameNode(actualAnchor, plan.target.node)
        ) {
          await settleCarriedArrival(view, actualAnchor);
          return;
        }
      } catch (error) {
        await protectAndAttend(() => presentCaptureFailure(messageOf(error)));
        return;
      }

      runtime.setStatus(
        context,
        runtime.i18n.t(
          plan.target.kind === "restore"
            ? "restoringWorkspace"
            : "checkingWorkspace",
        ),
      );
      const mutationProtocol = new WorkspaceMutationProtocol(
        runtime.workspaceMutations,
        context,
        () => views.revalidate(context),
      );
      let result: TreeArrivalResult;
      try {
        const locked = await runtime.enqueueWorkspaceExecution(
          "tree-arrival",
          (writeAuthority) =>
            executeTreeArrivalInWorkspaceLock(
              runtime,
              views,
              context,
              mutationProtocol,
              writeAuthority,
              {
                arrival,
                expectedView: view,
                authenticatedArrival,
                actualAnchor,
              },
            ),
        );
        if (locked.kind === "completed") {
          if (isLockedTreeArrivalOutcome(locked.value)) {
            const recoveredExecution =
              locked.cleanup.kind === "failed" &&
              (locked.value.execution.kind === "outcome" ||
                locked.value.execution.kind === "post-mutation-conflict")
                ? mutationProtocol.recoveryExecutionAfterCleanupFailure(
                    locked.value.execution,
                    locked.cleanup.cause,
                  )
                : undefined;
            if (recoveredExecution === undefined) {
              result = await finalizeArrivalAfterWorkspaceExecution(
                runtime.workspaceMutations,
                context,
                locked.value,
                locked.cleanup,
              );
            } else {
              const recovery = await recoverCurrentArrival();
              result = await finalizeArrivalAfterWorkspaceExecution(
                runtime.workspaceMutations,
                context,
                recoveredExecution,
                locked.cleanup,
                recovery,
              );
            }
          } else {
            const recovery = await recoverCurrentArrival();
            result = await finalizeArrivalAfterWorkspaceExecution(
              runtime.workspaceMutations,
              context,
              locked.value,
              locked.cleanup,
              recovery,
            );
          }
        } else {
          const recovery = await recoverCurrentArrival();
          result = await finalizeArrivalAfterWorkspaceExecution(
            runtime.workspaceMutations,
            context,
            { kind: "failed", cause: locked.cause },
            locked.cleanup,
            recovery,
          );
        }
      } catch (error: unknown) {
        // Lock acquisition is the only queue failure without an execution
        // receipt; no action effect can have occurred in that case.
        const recovery = await recoverCurrentArrival();
        result = await finalizeArrivalAfterWorkspaceExecution(
          runtime.workspaceMutations,
          context,
          { kind: "failed", cause: error },
          { kind: "settled" },
          recovery,
        );
      }
      applyActiveArrivalSettlement(runtime, result.arrival);
      if (
        result.execution.kind !== "initialization-conflict" &&
        result.execution.kind !== "post-mutation-conflict" &&
        result.execution.kind !== "outcome"
      ) {
        notifyArrivalDispositionFailure(runtime, context, result.arrival);
      }
      switch (result.execution.kind) {
        case "initialization-conflict":
          notifyCheckpointInitializationConflict(
            runtime,
            context,
            result as CheckpointInitializationConflict,
          );
          break;
        case "post-mutation-conflict":
          notifyPostMutationConflict(
            runtime,
            context,
            result as PostMutationConflict,
          );
          break;
        case "location-changed":
          if (runtime.activation.kind === "active") {
            runtime.notify(
              context,
              runtime.i18n.t("navigationPlanMismatch"),
              "warning",
            );
          } else {
            presentCaptureFailure("active location changed during navigation");
          }
          break;
        case "scan-incomplete":
          presentCaptureFailure(
            runtime.i18n.formatScanProblems(result.execution.problems),
          );
          break;
        case "scan-failed":
          presentCaptureFailure(messageOf(result.execution.cause));
          break;
        case "preview-stale":
          notifyNavigationDisposition(runtime, context, result.execution.kind);
          break;
        case "no-node":
        case "inherited":
        case "materialized":
          break;
        case "detached":
          notifyNavigationDisposition(runtime, context, result.execution.kind);
          break;
        case "protected":
          notifyNavigationDisposition(runtime, context, result.execution.kind);
          break;
        case "capture-failed":
          presentCaptureFailure(
            formatCaptureFailure(runtime.i18n, result.execution.failure),
          );
          break;
        case "target-changed":
          runtime.notify(
            context,
            participationMessage(
              runtime,
              "commandTargetChanged",
              "commandTargetChangedFact",
            ),
            "warning",
          );
          break;
        case "busy":
          runtime.notify(
            context,
            runtime.i18n.t("transitionInProgress"),
            "warning",
          );
          break;
        case "failed":
          presentCaptureFailure(messageOf(result.execution.cause));
          break;
        case "outcome":
          notifyRestoreProtocolOutcome(
            runtime,
            context,
            result as ArrivalReceipt<RestoreProtocolOutcome>,
            { announceSuccess: false },
          );
          break;
        default:
          assertNever(result.execution, "unhandled tree-arrival result");
      }
      if (
        result.execution.kind !== "initialization-conflict" &&
        result.execution.kind !== "post-mutation-conflict" &&
        result.execution.kind !== "outcome"
      ) {
        notifyWorkspaceLockCleanupFailure(
          runtime,
          context,
          result.workspaceLockCleanup,
        );
      }
      if (
        result.execution.kind === "no-node" ||
        result.execution.kind === "inherited" ||
        result.execution.kind === "materialized" ||
        result.execution.kind === "detached" ||
        (result.execution.kind === "outcome" &&
          result.execution.outcome.kind === "restored")
      ) {
        runtime.setStatus(context, undefined);
      } else {
        attentionStatus();
      }
    }),
  );
}
