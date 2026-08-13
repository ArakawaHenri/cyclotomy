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
    captureAdmission: () => ({ kind: "capture", lease }),
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
          captureAdmission: () => ({ kind: "not-admitted" }),
        },
        { expected },
      ),
    ).resolves.toEqual({ kind: "not-admitted" });
    expect(prepareCurrent).not.toHaveBeenCalled();
  });

  it("returns a durable write-protected decision without rewriting it", async () => {
    const expected = view();

    await expect(
      runCaptureProtocol(
        {
          ...deps(expected),
          captureAdmission: () => ({ kind: "write-protected" }),
        },
        { expected },
      ),
    ).resolves.toEqual({ kind: "write-protected" });
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
});
