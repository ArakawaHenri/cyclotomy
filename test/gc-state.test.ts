import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  readLastAutomaticGcAt,
  writeLastAutomaticGcAt,
} from "../src/infrastructure/gc-state.ts";
import { runWithWorkspaceLock } from "../src/infrastructure/workspace-lock.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("automatic GC state", () => {
  it("distinguishes an absent, valid, and corrupt schedule", async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), "cyclotomy-gc-state-"));
    roots.push(storeRoot);
    const statePath = join(storeRoot, "gc-state.json");

    await expect(readLastAutomaticGcAt(statePath)).resolves.toBe(0);
    writeFileSync(statePath, `${JSON.stringify({ lastGcAt: 42 })}\n`);
    await expect(readLastAutomaticGcAt(statePath)).resolves.toBe(42);
    writeFileSync(statePath, "{not-json\n");
    await expect(readLastAutomaticGcAt(statePath)).rejects.toThrow(
      "automatic GC schedule is unreadable",
    );
  });

  it("does not overwrite a successor after lock ownership is lost", async () => {
    const storeRoot = await mkdtemp(
      join(tmpdir(), "cyclotomy-gc-schedule-loss-"),
    );
    roots.push(storeRoot);
    const statePath = join(storeRoot, "gc-state.json");
    const successorState = `${JSON.stringify({ lastGcAt: 9001 })}\n`;

    const execution = await runWithWorkspaceLock(
      storeRoot,
      "gc-schedule-loss-test",
      async (writeAuthority) => {
        await writeLastAutomaticGcAt(statePath, 1, writeAuthority, () => {
          const lockPath = join(storeRoot, "workspace.lock");
          renameSync(lockPath, join(storeRoot, "displaced.lock"));
          mkdirSync(lockPath);
          writeFileSync(statePath, successorState);
        });
      },
    );

    expect(execution.kind).toBe("action-failed");
    if (execution.kind !== "action-failed") {
      throw new Error("lost schedule authority unexpectedly published");
    }
    expect(execution.cause).toMatchObject({
      name: "WorkspaceLockOwnershipLostError",
    });
    expect(execution.cleanup.kind).toBe("failed");
    expect(await readFile(statePath, "utf8")).toBe(successorState);
    expect(
      (await readdir(storeRoot)).filter(
        (name) =>
          name.startsWith(`gc-state.json.${process.pid}.`) &&
          name.endsWith(".tmp"),
      ),
    ).toHaveLength(1);
  });
});
