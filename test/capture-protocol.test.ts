import { describe, expect, it, vi } from "vitest";

import type { CaptureSuccess } from "../src/application/capture.ts";
import type { NodeKey } from "../src/domain/model.ts";
import type { WorkspaceSnapshot } from "../src/infrastructure/workspace-scan.ts";
import {
  runCaptureProtocol,
  type CaptureProtocolDeps,
} from "../src/pi/capture-protocol.ts";
import type { AdmissionLease } from "../src/pi/checkpoint-admission.ts";
import type { SessionView } from "../src/pi/session-view.ts";
import {
  sourceCaptureFailureImpact,
  type SourceCaptureFailure,
  type SourceCaptureFailureImpact,
} from "../src/pi/source-capture-failure.ts";

const node: NodeKey = { sessionId: "session", entryId: "entry" };
const lease = { __admissionLease: true } as const satisfies AdmissionLease;
const capture: CaptureSuccess = {
  treeOid: "a".repeat(64),
  snapshot: {} as WorkspaceSnapshot,
};

function view(): SessionView {
  const value = {
    cwd: "/workspace",
    isSameSnapshotAs(other: SessionView) {
      return other === value;
    },
  };
  return value as unknown as SessionView;
}

function deps(expected: SessionView): CaptureProtocolDeps {
  return {
    readCurrentView: () => expected,
    sessionIsUsable: () => true,
    captureAnchor: () => node,
    settleCaptureBoundary: () => ({ kind: "capture", lease }),
    checkpointSlot: () => ({ kind: "open-missing" }),
    prepareCurrent: async () => ({ ok: true, value: capture }),
    workspaceStillBound: async () => true,
    captureLeaseIsCurrent: () => true,
    commitPrepared: () => ({ ok: true, value: capture }),
  };
}

describe("capture protocol", () => {
  it("runs the single authenticated prepare-to-commit sequence", async () => {
    const expected = view();
    const options = deps(expected);
    const prepareCurrent = vi.fn(options.prepareCurrent);
    const commitPrepared = vi.fn(options.commitPrepared);

    await expect(
      runCaptureProtocol(
        { ...options, prepareCurrent, commitPrepared },
        { expected },
      ),
    ).resolves.toEqual({ kind: "captured", capture });
    expect(prepareCurrent).toHaveBeenCalledWith(expected);
    expect(commitPrepared).toHaveBeenCalledWith(expected, node, capture, {
      kind: "open-missing",
    });
  });

  it("does not scan when capture is not admitted", async () => {
    const expected = view();
    const options = deps(expected);
    const prepareCurrent = vi.fn(options.prepareCurrent);

    await expect(
      runCaptureProtocol(
        {
          ...options,
          prepareCurrent,
          settleCaptureBoundary: () => ({ kind: "not-admitted" }),
        },
        { expected },
      ),
    ).resolves.toEqual({ kind: "not-admitted" });
    expect(prepareCurrent).not.toHaveBeenCalled();
  });

  it("stops before admission when the public view has already changed", async () => {
    const expected = view();
    const options = deps(expected);
    const settleCaptureBoundary = vi.fn(options.settleCaptureBoundary);
    const prepareCurrent = vi.fn(options.prepareCurrent);

    await expect(
      runCaptureProtocol(
        {
          ...options,
          readCurrentView: () => view(),
          settleCaptureBoundary,
          prepareCurrent,
        },
        { expected },
      ),
    ).resolves.toEqual({
      kind: "location-changed",
      phase: "before-capture",
    });
    expect(settleCaptureBoundary).not.toHaveBeenCalled();
    expect(prepareCurrent).not.toHaveBeenCalled();
  });

  it("returns a missing stable coordinate without scanning", async () => {
    const expected = view();
    const options = deps(expected);
    const prepareCurrent = vi.fn(options.prepareCurrent);

    await expect(
      runCaptureProtocol(
        {
          ...options,
          captureAnchor: () => undefined,
          settleCaptureBoundary: () => ({ kind: "no-coordinate" }),
          prepareCurrent,
        },
        { expected },
      ),
    ).resolves.toEqual({ kind: "no-coordinate" });
    expect(prepareCurrent).not.toHaveBeenCalled();
  });

  it("returns a durable write-protected decision without rewriting it", async () => {
    const expected = view();

    await expect(
      runCaptureProtocol(
        {
          ...deps(expected),
          settleCaptureBoundary: () => ({ kind: "write-protected" }),
        },
        { expected },
      ),
    ).resolves.toEqual({ kind: "write-protected" });
  });

  it("preserves capture-boundary protection failure without scanning", async () => {
    const expected = view();
    const cause = new Error("protection unavailable");
    const options = deps(expected);
    const prepareCurrent = vi.fn(options.prepareCurrent);

    await expect(
      runCaptureProtocol(
        {
          ...options,
          prepareCurrent,
          settleCaptureBoundary: () => ({
            kind: "settlement-failed",
            cause,
          }),
        },
        { expected },
      ),
    ).resolves.toEqual({ kind: "failed", cause });
    expect(prepareCurrent).not.toHaveBeenCalled();
  });

  it("reauthenticates the capture lease after asynchronous preparation", async () => {
    const expected = view();

    await expect(
      runCaptureProtocol(
        { ...deps(expected), captureLeaseIsCurrent: () => false },
        { expected },
      ),
    ).resolves.toEqual({
      kind: "location-changed",
      phase: "during-capture",
    });
  });

  it("distinguishes a lost workspace binding from an ordinary location race", async () => {
    const expected = view();

    await expect(
      runCaptureProtocol(
        { ...deps(expected), workspaceStillBound: async () => false },
        { expected },
      ),
    ).resolves.toEqual({ kind: "workspace-unavailable" });
  });

  it("preserves a classified preparation failure", async () => {
    const expected = view();
    const failure = {
      kind: "workspace-changed",
      reason: "contents",
    } as const;

    await expect(
      runCaptureProtocol(
        {
          ...deps(expected),
          prepareCurrent: async () => ({ ok: false, error: failure }),
        },
        { expected },
      ),
    ).resolves.toEqual({ kind: "capture-failed", failure });
  });

  it.each([
    [
      { kind: "write-protected" as const },
      { kind: "write-protected" as const },
    ],
    [
      {
        kind: "state-changed" as const,
        reason: "checkpoint" as const,
      },
      {
        kind: "capture-failed" as const,
        failure: {
          kind: "state-changed" as const,
          reason: "checkpoint" as const,
        },
      },
    ],
  ])("normalizes a classified commit result", async (failure, result) => {
    const expected = view();

    await expect(
      runCaptureProtocol(
        {
          ...deps(expected),
          commitPrepared: () => ({ ok: false, error: failure }),
        },
        { expected },
      ),
    ).resolves.toEqual(result);
  });

  it("totalizes an unexpected dependency exception", async () => {
    const expected = view();
    const cause = new Error("capture dependency failed");

    await expect(
      runCaptureProtocol(
        {
          ...deps(expected),
          prepareCurrent: async () => {
            throw cause;
          },
        },
        { expected },
      ),
    ).resolves.toEqual({ kind: "failed", cause });
  });
});

describe("source capture failure impact", () => {
  const cause = new Error("injected failure");
  const cases: readonly [SourceCaptureFailure, SourceCaptureFailureImpact][] = [
    [{ kind: "location-changed", phase: "before" }, "cancel-operation"],
    [{ kind: "location-changed", phase: "during" }, "cancel-operation"],
    [{ kind: "not-admitted", subject: "source" }, "cancel-operation"],
    [{ kind: "workspace-unavailable" }, "withdraw-participation"],
    [{ kind: "exception", cause }, "withdraw-participation"],
    [
      {
        kind: "capture",
        value: { kind: "scan-incomplete", phase: "capture", problems: [] },
      },
      "withdraw-participation",
    ],
    [
      {
        kind: "capture",
        value: { kind: "scan-failed", phase: "validation", cause },
      },
      "withdraw-participation",
    ],
    [
      { kind: "capture", value: { kind: "publish-failed", cause } },
      "withdraw-participation",
    ],
    [
      { kind: "capture", value: { kind: "metadata-failed", cause } },
      "withdraw-participation",
    ],
    [
      {
        kind: "capture",
        value: { kind: "workspace-changed", reason: "root" },
      },
      "withdraw-participation",
    ],
    [
      {
        kind: "capture",
        value: { kind: "workspace-changed", reason: "contents" },
      },
      "cancel-operation",
    ],
    [
      {
        kind: "capture",
        value: { kind: "state-changed", reason: "checkpoint" },
      },
      "cancel-operation",
    ],
    [
      { kind: "capture", value: { kind: "write-protected" } },
      "cancel-operation",
    ],
  ];

  it.each(cases)("classifies $0 as $1", (failure, impact) => {
    expect(sourceCaptureFailureImpact(failure)).toBe(impact);
  });
});
