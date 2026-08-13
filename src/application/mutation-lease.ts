declare const WORKSPACE_MUTATION_LEASE: unique symbol;

export interface WorkspaceMutationAuthorization<Resolution> {
  readonly kind: "authorized";
  readonly pinnedResolution: Resolution;
}

export type SynchronousMutationCutover<Resolution> =
  () => WorkspaceMutationAuthorization<Resolution>;

/**
 * One-shot authority to cross from a fully prepared operation into workspace
 * mutation. The boundary that authenticates host/session/persistence state
 * mints the lease; the application layer can only consume it at its first
 * write. Rejection may preserve control-plane side effects from the callback,
 * but proves that no workspace mutation crossed this boundary.
 */
export interface WorkspaceMutationLease<Resolution> {
  readonly [WORKSPACE_MUTATION_LEASE]: (resolution: Resolution) => Resolution;
}

export type WorkspaceMutationLeaseState<Resolution> =
  | { readonly kind: "pending" }
  | {
      readonly kind: "authorized";
      readonly authorization: WorkspaceMutationAuthorization<Resolution>;
    }
  | { readonly kind: "rejected"; readonly cause: unknown };

interface MutationLeaseState<Resolution> {
  state: WorkspaceMutationLeaseState<Resolution>;
  readonly cutover: SynchronousMutationCutover<Resolution>;
}

const mutationLeaseStates = new WeakMap<
  WorkspaceMutationLease<unknown>,
  MutationLeaseState<unknown>
>();

export function prepareWorkspaceMutationLease<Resolution>(
  cutover: SynchronousMutationCutover<Resolution>,
): WorkspaceMutationLease<Resolution> {
  const lease = Object.freeze({}) as WorkspaceMutationLease<Resolution>;
  mutationLeaseStates.set(lease as WorkspaceMutationLease<unknown>, {
    state: { kind: "pending" },
    cutover: cutover as SynchronousMutationCutover<unknown>,
  });
  return lease;
}

/** Consume exactly once; a failed cutover is never retryable by the caller. */
export function consumeWorkspaceMutationLease<Resolution>(
  lease: WorkspaceMutationLease<Resolution>,
): WorkspaceMutationAuthorization<Resolution> {
  const record = mutationLeaseStates.get(
    lease as WorkspaceMutationLease<unknown>,
  ) as MutationLeaseState<Resolution> | undefined;
  if (record === undefined || record.state.kind !== "pending") {
    throw new Error("workspace mutation authority is unavailable");
  }

  // Reject first. A callback that throws, returns a thenable, or returns an
  // invalid decision permanently consumes this one-shot capability.
  const unavailable = new Error("workspace mutation cutover was rejected");
  record.state = { kind: "rejected", cause: unavailable };
  try {
    const authorization: unknown = record.cutover();
    if (
      typeof authorization !== "object" ||
      authorization === null ||
      Reflect.get(authorization, "kind") !== "authorized" ||
      typeof Reflect.get(authorization, "then") === "function" ||
      !Reflect.has(authorization, "pinnedResolution")
    ) {
      throw new Error(
        "workspace mutation authority must complete synchronously",
      );
    }
    const typed = authorization as WorkspaceMutationAuthorization<Resolution>;
    record.state = { kind: "authorized", authorization: typed };
    return typed;
  } catch (cause) {
    record.state = { kind: "rejected", cause };
    throw cause;
  }
}

export function workspaceMutationLeaseState<Resolution>(
  lease: WorkspaceMutationLease<Resolution>,
): WorkspaceMutationLeaseState<Resolution> {
  const record = mutationLeaseStates.get(
    lease as WorkspaceMutationLease<unknown>,
  ) as MutationLeaseState<Resolution> | undefined;
  if (record === undefined) {
    return {
      kind: "rejected",
      cause: new Error("workspace mutation authority is unavailable"),
    };
  }
  return record.state;
}
