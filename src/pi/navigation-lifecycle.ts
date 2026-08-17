import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { NodeKey } from "../domain/model.ts";
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
  notifyPostMutationConflict,
  notifyRestoreProtocolOutcome,
  notifyWorkspaceLockCleanupFailure,
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
import { messageOfUnknown as messageOf } from "./unknown-error.ts";
import type { PiHostAdapter } from "./pi-host-adapter.ts";
import type { ArrivalReceipt } from "./workspace-receipt.ts";
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
        ): Promise<void> => {
          const recovery = await runtime.withdrawFromParticipation(
            context,
            cause,
          );
          applyActiveArrivalSettlement(runtime, recovery.arrival);
          notifyArrivalDispositionFailure(runtime, context, recovery.arrival);
          notifyWorkspaceLockCleanupFailure(
            runtime,
            context,
            recovery.workspaceLockCleanup,
          );
        };
        const notifyPreparationFailure = (cause: unknown): void => {
          runtime.notifyBestEffort(
            context,
            () =>
              runtime.i18n.t("navigationPrepareFailed", {
                message: messageOf(cause),
              }),
            "warning",
          );
        };
        let view: SessionView;
        try {
          view = views.revalidate(context);
          runtime.assertSessionUsable(view);
          if (!context.isIdle()) {
            runtime.notify(
              context,
              runtime.i18n.t("transitionInProgress"),
              "warning",
            );
            return { cancel: true };
          }
        } catch (error) {
          await recoverPreparationFailure(error);
          notifyPreparationFailure(error);
          return undefined;
        }
        const preparation = await runtime.admission.runTreePreparation(
          async () => {
            try {
              runtime.setStatus(context, runtime.i18n.t("checkingWorkspace"));
              if (!(await runtime.ensureStore(view.cwd))) {
                runtime.notifyInitFailure(context);
                const activation = runtime.activation;
                await recoverPreparationFailure(
                  activation.kind === "unavailable"
                    ? activation.cause
                    : new Error("Cyclotomy store is unavailable"),
                );
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
                await recoverPreparationFailure(preparationExecution.cause);
                notifyPreparationFailure(preparationExecution.cause);
                return undefined;
              }
              if (preparationExecution.cleanup.kind === "failed") {
                if (preparationExecution.kind === "action-failed") {
                  notifyPreparationFailure(preparationExecution.cause);
                }
                notifyWorkspaceLockCleanupFailure(runtime, context, {
                  kind: "failed",
                  cause: preparationExecution.cleanup.cause,
                });
                await recoverPreparationFailure(
                  preparationExecution.cleanup.cause,
                );
                return undefined;
              }
              if (preparationExecution.kind === "action-failed") {
                await recoverPreparationFailure(preparationExecution.cause);
                notifyPreparationFailure(preparationExecution.cause);
                return undefined;
              }
              const prepared = preparationExecution.value;

              if (prepared.kind === "scan-incomplete") {
                const detail = runtime.i18n.formatScanProblems(
                  prepared.problems,
                );
                runtime.notify(
                  context,
                  runtime.i18n.t("navigationScanIncomplete", {
                    message: detail,
                  }),
                  "warning",
                );
                await recoverPreparationFailure(
                  new Error(
                    `tree preparation workspace scan was incomplete: ${detail}`,
                  ),
                );
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
                  await recoverPreparationFailure(error);
                  notifyPreparationFailure(error);
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
                notifyWorkspaceLockCleanupFailure(
                  runtime,
                  context,
                  commitExecution.cleanup,
                );
                if (commitExecution.cleanup.kind === "failed") {
                  if (commitExecution.kind === "action-failed") {
                    notifyPreparationFailure(commitExecution.cause);
                  }
                  if (
                    commitExecution.kind === "completed" &&
                    commitExecution.value.kind === "ready"
                  ) {
                    // Source capture and the departure plan are already
                    // authoritative. Retire without rewriting that completed
                    // checkpoint as a protection failure.
                    return undefined;
                  }
                  await recoverPreparationFailure(
                    commitExecution.cleanup.cause,
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
                      runtime.notify(
                        context,
                        runtime.i18n.t("navigationScanIncomplete", {
                          message: detail,
                        }),
                        "warning",
                      );
                      await recoverPreparationFailure(
                        new Error(
                          `tree commit workspace scan was incomplete: ${detail}`,
                        ),
                      );
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
                      await recoverPreparationFailure(new Error(detail));
                    }
                    break;
                  case "workspace-binding-lost":
                    {
                      const cause = new Error(
                        "registered workspace binding was lost during tree preparation",
                      );
                      await recoverPreparationFailure(cause);
                      notifyPreparationFailure(cause);
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
                    await recoverPreparationFailure(committed.cause);
                    notifyPreparationFailure(committed.cause);
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
              await recoverPreparationFailure(error);
              notifyPreparationFailure(error);
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
            runtime.notifyBestEffort(
              context,
              () => runtime.i18n.t("transitionInProgress"),
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
        runtime.setStatusBestEffort(context, () =>
          runtime.i18n.t("navigationAttentionStatus"),
        );

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
        runtime.presentBestEffort(context, notify);
        attentionStatus();
        return disposition;
      };

      const settleCarriedArrival = async (
        view: SessionView,
        node: NodeKey | undefined,
      ): Promise<ArrivalDisposition> => {
        if (runtime.admission.carryArrival(arrival, view, node)) {
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
            runtime.notify(
              context,
              runtime.i18n.t("navigationPlanMismatch"),
              "warning",
            ),
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
        await protectAndAttend(() =>
          runtime.notify(
            context,
            runtime.i18n.t("navigationPrepareFailed", {
              message: messageOf(error),
            }),
            "warning",
          ),
        );
        return;
      }

      runtime.setStatusBestEffort(context, () =>
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
      runtime.presentBestEffort(context, () => {
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
            runtime.notify(
              context,
              runtime.i18n.t("commandLocationChanged"),
              "warning",
            );
            break;
          case "scan-incomplete":
            runtime.notify(
              context,
              runtime.i18n.t("navigationScanIncomplete", {
                message: runtime.i18n.formatScanProblems(
                  result.execution.problems,
                ),
              }),
              "warning",
            );
            break;
          case "scan-failed":
            runtime.notify(
              context,
              runtime.i18n.t("navigationScanIncomplete", {
                message: messageOf(result.execution.cause),
              }),
              "warning",
            );
            break;
          case "preview-stale":
            runtime.notify(
              context,
              runtime.i18n.t("navigationChangedAfterPreview"),
              "warning",
            );
            break;
          case "no-node":
          case "inherited":
          case "materialized":
            break;
          case "detached":
            runtime.notify(
              context,
              runtime.i18n.t("navigationDetached"),
              "info",
            );
            break;
          case "protected":
            runtime.notify(
              context,
              runtime.i18n.t("sessionMissingProtected"),
              "warning",
            );
            break;
          case "capture-failed":
            runtime.notifyCaptureResult(
              context,
              false,
              formatCaptureFailure(runtime.i18n, result.execution.failure),
            );
            break;
          case "target-changed":
            runtime.notify(
              context,
              runtime.i18n.t("commandTargetChanged"),
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
            runtime.notify(
              context,
              runtime.i18n.t(
                plan.target.kind === "detach"
                  ? "navigationDetachFailed"
                  : "restoreFailed",
                { message: messageOf(result.execution.cause) },
              ),
              "error",
            );
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
      });
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
