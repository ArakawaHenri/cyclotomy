import { createHash } from "node:crypto";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerCyclotomy } from "../src/pi/register.ts";
import { CyclotomyRuntime } from "../src/pi/runtime.ts";
import { CheckpointService } from "../src/application/checkpoint-service.ts";
import * as workspaceScan from "../src/infrastructure/workspace-scan.ts";
import { FakePi } from "./fake-pi.ts";
import {
  checkpointIsBlocked,
  checkpointState,
  createTestCurrentMetadataStore,
} from "./metadata-fixture.ts";

let workspace: string;
let agentDir: string;
let storeRoot: string;
let oldDir: string | undefined;
let oldEnabled: string | undefined;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "cyclotomy-audit-lifecycle-ws-"));
  agentDir = await mkdtemp(join(tmpdir(), "cyclotomy-audit-lifecycle-agent-"));
  oldDir = process.env.PI_CODING_AGENT_DIR;
  oldEnabled = process.env.CYCLOTOMY_ENABLED;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.CYCLOTOMY_ENABLED;
  await mkdir(join(agentDir, "cyclotomy"));
  await writeFile(
    join(agentDir, "cyclotomy", "settings.json"),
    JSON.stringify({ locale: "en", gc: { intervalMs: 0 } }),
  );
  storeRoot = join(
    agentDir,
    "cyclotomy",
    createHash("sha256")
      .update(await realpath(workspace))
      .digest("hex"),
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  await FakePi.disposeAll();
  if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldDir;
  if (oldEnabled === undefined) delete process.env.CYCLOTOMY_ENABLED;
  else process.env.CYCLOTOMY_ENABLED = oldEnabled;
  await Promise.all([
    rm(workspace, { recursive: true, force: true }),
    rm(agentDir, { recursive: true, force: true }),
  ]);
});

it("pause stops scanning the remaining navigation source files", async () => {
  const pi = new FakePi(workspace, registerCyclotomy);
  const target = pi.manager.appendEntry().id;
  pi.manager.appendEntry();
  await Promise.all(
    Array.from({ length: 40 }, (_, i) =>
      writeFile(join(workspace, `file-${i}.txt`), `content-${i}`),
    ),
  );
  await pi.startSession("startup");
  const scan = workspaceScan.scanWorkspace;
  let stopping: Promise<void> | undefined;
  let filesAtStop = 0;
  let finalFiles = 0;
  let signalPassed: AbortSignal | undefined;
  vi.spyOn(workspaceScan, "scanWorkspace").mockImplementation(
    async (root, options = {}) => {
      signalPassed = options.signal;
      return scan(root, {
        ...options,
        onProgress: (progress) => {
          finalFiles = progress.files;
          if (stopping === undefined && progress.files > 0) {
            filesAtStop = progress.files;
            stopping = pi.runCommand("cyclotomy", "pause");
          }
        },
      });
    },
  );
  const retire = vi.spyOn(CyclotomyRuntime.prototype, "retire");
  await pi.prepareNavigation(target);
  await stopping;
  expect(retire).toHaveBeenCalled();
  expect(signalPassed?.aborted).toBe(true);
  expect(filesAtStop).toBe(1);
  expect(finalFiles).toBeLessThan(40);
  expect(pi.terminalInputHandlers.size).toBe(0);
});

it.each([
  { phase: "source preview", observation: 1 },
  { phase: "restore preview", observation: 2 },
  { phase: "source revalidation", observation: 3 },
  { phase: "restore revalidation", observation: 4 },
])(
  "Escape during $phase preserves both checkpoint pointers and the source files",
  async ({ observation }) => {
    const pi = new FakePi(workspace, registerCyclotomy);
    await pi.startSession("startup");
    await writeFile(join(workspace, "state.txt"), "first");
    await pi.endTurn();
    const target = pi.manager.getLeafId()!;
    await writeFile(join(workspace, "state.txt"), "second");
    await pi.endTurn();
    const source = pi.manager.getLeafId()!;
    const db = await createTestCurrentMetadataStore(
      join(storeRoot, "state.db"),
      storeRoot,
    );
    const sourceState = checkpointState(db, pi.manager.sessionId, source);
    const targetState = checkpointState(db, pi.manager.sessionId, target);
    await writeFile(join(workspace, "state.txt"), "unsaved edit");
    let observations = 0;
    let consumed = false;
    function scanOptions(options: workspaceScan.ScanOptions) {
      observations += 1;
      const current = observations;
      return {
        ...options,
        onProgress: (progress: { files: number; bytes: number }) => {
          options.onProgress?.(progress);
          if (!consumed && current === observation && progress.files > 0) {
            expect(pi.statuses.get("cyclotomy")).toContain("Esc to cancel");
            consumed = pi.terminalInput("\u001b");
          }
        },
      };
    }
    const scan = workspaceScan.scanWorkspace;
    const scopeScan = workspaceScan.scanWorkspaceForRestoreComparison;
    vi.spyOn(workspaceScan, "scanWorkspace").mockImplementation(
      (cwd, options = {}) => scan(cwd, scanOptions(options)),
    );
    vi.spyOn(
      workspaceScan,
      "scanWorkspaceForRestoreComparison",
    ).mockImplementation((cwd, scope, options = {}) =>
      scopeScan(cwd, scope, scanOptions(options)),
    );
    try {
      expect(await pi.navigate(target)).toBe("cancelled");
      expect(consumed).toBe(true);
      expect(pi.manager.getLeafId()).toBe(source);
      expect(checkpointState(db, pi.manager.sessionId, source)).toEqual(
        sourceState,
      );
      expect(checkpointState(db, pi.manager.sessionId, target)).toEqual(
        targetState,
      );
      expect(checkpointIsBlocked(db, pi.manager.sessionId, source)).toBe(false);
      expect(await readFile(join(workspace, "state.txt"), "utf8")).toBe(
        "unsaved edit",
      );
      expect(pi.notifications.at(-1)).toEqual({
        message: "Checkpoint cancelled.",
        level: "info",
      });
      expect(pi.terminalInputHandlers.size).toBe(0);
      expect(pi.statuses.has("cyclotomy")).toBe(false);
      await expect(
        access(join(storeRoot, "workspace.lock")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      db.close();
    }
  },
);

it("Escape during a missing arrival scan protects the new location without assigning its files", async () => {
  const pi = new FakePi(workspace, registerCyclotomy);
  await pi.startSession("startup");
  const target = pi.manager.appendEntry().id;
  await writeFile(join(workspace, "state.txt"), "source");
  await pi.endTurn();
  const source = pi.manager.getLeafId()!;
  const db = await createTestCurrentMetadataStore(
    join(storeRoot, "state.db"),
    storeRoot,
  );
  const sourceState = checkpointState(db, pi.manager.sessionId, source);
  let arrived = false;
  let consumed = false;
  pi.beforeTreeCommit = async () => {
    arrived = true;
  };
  const prepare = CheckpointService.prototype.prepareCurrent;
  vi.spyOn(CheckpointService.prototype, "prepareCurrent").mockImplementation(
    function (this: CheckpointService, view, options = {}) {
      return prepare.call(this, view, {
        ...options,
        onProgress: (progress) => {
          options.onProgress?.(progress);
          if (
            arrived &&
            !consumed &&
            progress.phase === "scan" &&
            progress.files > 0
          ) {
            consumed = pi.terminalInput("\u001b");
          }
        },
      });
    },
  );
  try {
    expect(await pi.navigate(target)).toBe("done");
    expect(consumed).toBe(true);
    expect(pi.manager.getLeafId()).toBe(target);
    expect(checkpointState(db, pi.manager.sessionId, source)).toEqual(
      sourceState,
    );
    expect(checkpointState(db, pi.manager.sessionId, target)).toBeUndefined();
    expect(checkpointIsBlocked(db, pi.manager.sessionId, target)).toBe(true);
    expect(await readFile(join(workspace, "state.txt"), "utf8")).toBe("source");
    expect(pi.terminalInputHandlers.size).toBe(0);
    expect(pi.notifications.at(-1)?.message).toContain("Checkpoint cancelled.");
  } finally {
    db.close();
  }
});
