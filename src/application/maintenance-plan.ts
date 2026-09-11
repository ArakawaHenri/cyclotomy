import { createHash } from "node:crypto";

/** One structured, script-readable maintenance problem. */
export interface MaintenanceIssue {
  readonly code: string;
  readonly detail: string;
}

/** A previewed maintenance plan no longer matches the observed store. */
export class MaintenancePreviewChangedError extends Error {
  readonly storeRoot: string;

  constructor(storeRoot: string) {
    super(
      `the Cyclotomy store at ${storeRoot} changed after it was previewed; run the preview again`,
    );
    this.name = "MaintenancePreviewChangedError";
    this.storeRoot = storeRoot;
  }
}

/** The store cannot be changed until the reported problems are resolved. */
export class MaintenanceBlockedError extends Error {
  readonly storeRoot: string;
  readonly issues: readonly MaintenanceIssue[];

  constructor(storeRoot: string, issues: readonly MaintenanceIssue[]) {
    super(
      `the Cyclotomy store at ${storeRoot} cannot be changed: ${issues
        .map(({ code }) => code)
        .join(", ")}`,
    );
    this.name = "MaintenanceBlockedError";
    this.storeRoot = storeRoot;
    this.issues = issues;
  }
}

/** Hash an operation's ordered, JSON-serializable plan facts. */
export function maintenancePlanToken(facts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(facts)).digest("hex");
}
