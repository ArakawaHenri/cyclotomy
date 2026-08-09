import type { NodeKey } from "../domain/model.ts";
import type { SessionView } from "./session-view.ts";

type AdmissionDisposition = "unknown" | "admitted" | "protected";

interface AdmissionLocation {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly cwd: string;
  readonly leafId: string | null;
  readonly entryId: string | null;
  readonly disposition: AdmissionDisposition;
}

export interface AdmissionLease {
  readonly revision: number;
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly cwd: string;
  readonly leafId: string | null;
  readonly entryId: string;
}

export type AdmissionDecision =
  | { readonly kind: "capture"; readonly lease: AdmissionLease }
  | { readonly kind: "no-node" }
  | { readonly kind: "protected" }
  | { readonly kind: "blocked" };

function locationOf(
  view: SessionView,
  node: NodeKey | undefined,
  disposition: AdmissionDisposition,
): AdmissionLocation | undefined {
  if (view.sessionFile === null) return undefined;
  return {
    sessionId: view.sessionId,
    sessionFile: view.sessionFile,
    cwd: view.cwd,
    leafId: view.leafId,
    entryId: node?.entryId ?? null,
    disposition,
  };
}

function sameSession(location: AdmissionLocation, view: SessionView): boolean {
  return (
    view.sessionFile !== null &&
    location.sessionId === view.sessionId &&
    location.sessionFile === view.sessionFile &&
    location.cwd === view.cwd
  );
}

/**
 * Runtime classification of the one live stable Pi location. Durable write
 * protection lives in MetadataStore; this class keeps only the short-lived
 * location proof, fail-closed disposition, and capture revision.
 */
export class CheckpointAdmission {
  #location: AdmissionLocation | undefined;
  #revision = 0;

  reset(): void {
    this.#location = undefined;
    this.#revision += 1;
  }

  begin(view: SessionView, node: NodeKey | undefined): void {
    this.#location = locationOf(view, node, "unknown");
    this.#revision += 1;
  }

  admit(view: SessionView, node: NodeKey | undefined): void {
    this.#location = locationOf(view, node, "admitted");
    this.#revision += 1;
  }

  protect(view: SessionView, node: NodeKey | undefined): void {
    this.#location = locationOf(view, node, "protected");
    this.#revision += 1;
  }

  /** Preserve classification across a planned label/raw-leaf rewrite. */
  carry(view: SessionView, node: NodeKey | undefined): boolean {
    const location = this.#location;
    if (
      location === undefined ||
      !sameSession(location, view) ||
      location.entryId !== (node?.entryId ?? null) ||
      location.disposition === "unknown"
    ) {
      return false;
    }
    this.#location = locationOf(view, node, location.disposition);
    this.#revision += 1;
    return true;
  }

  entryIdIn(view: SessionView): string | null | undefined {
    const location = this.#location;
    return location !== undefined && sameSession(location, view)
      ? location.entryId
      : undefined;
  }

  decideCapture(input: {
    readonly view: SessionView;
    readonly node: NodeKey | undefined;
    readonly isNaturalDescendant: boolean;
    readonly writeProtected: boolean;
  }): AdmissionDecision {
    const { view, node } = input;
    let location = this.#location;
    if (location === undefined || !sameSession(location, view)) {
      return { kind: "blocked" };
    }

    if (node === undefined) {
      return location.leafId === view.leafId &&
        location.entryId === null &&
        location.disposition !== "unknown"
        ? { kind: "no-node" }
        : { kind: "blocked" };
    }

    // Pi can append or remove a label without emitting session_tree. The raw
    // leaf changes, but captureAnchor has already authenticated that the stable
    // checkpoint location is identical, so preserve its classification.
    if (
      location.leafId !== view.leafId &&
      location.entryId === node.entryId &&
      location.disposition !== "unknown"
    ) {
      this.#location = locationOf(view, node, location.disposition);
      this.#revision += 1;
      location = this.#location;
      if (location === undefined) return { kind: "blocked" };
    }

    if (location.leafId === view.leafId && location.entryId === node.entryId) {
      if (location.disposition === "protected" || input.writeProtected) {
        if (location.disposition !== "protected") this.protect(view, node);
        return { kind: "protected" };
      }
      if (location.disposition !== "admitted") return { kind: "blocked" };
      return { kind: "capture", lease: this.#lease(location, node.entryId) };
    }

    if (!input.isNaturalDescendant) return { kind: "blocked" };
    if (input.writeProtected) {
      this.protect(view, node);
      return { kind: "protected" };
    }
    this.admit(view, node);
    const admitted = this.#location;
    if (admitted === undefined) return { kind: "blocked" };
    return { kind: "capture", lease: this.#lease(admitted, node.entryId) };
  }

  leaseIsCurrent(
    lease: AdmissionLease,
    view: SessionView,
    node: NodeKey,
  ): boolean {
    const location = this.#location;
    return (
      location !== undefined &&
      this.#revision === lease.revision &&
      location.disposition === "admitted" &&
      sameSession(location, view) &&
      location.leafId === view.leafId &&
      location.entryId === node.entryId &&
      lease.sessionId === view.sessionId &&
      lease.sessionFile === view.sessionFile &&
      lease.cwd === view.cwd &&
      lease.leafId === view.leafId &&
      lease.entryId === node.entryId
    );
  }

  #lease(location: AdmissionLocation, entryId: string): AdmissionLease {
    return {
      revision: this.#revision,
      sessionId: location.sessionId,
      sessionFile: location.sessionFile,
      cwd: location.cwd,
      leafId: location.leafId,
      entryId,
    };
  }
}
