import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyLockRecovery,
  previewLockRecovery,
} from "../src/application/lock-recovery.ts";
import {
  MaintenanceBlockedError,
  MaintenancePreviewChangedError,
} from "../src/application/maintenance-plan.ts";

const roots: string[] = [];
const MARKER_BYTES = '{"format":1,"protocol":"native-file-v1"}\n';

async function storeRoot(): Promise<string> {
  // realpath so platform temp aliases (/var vs /private/var) compare equal.
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "cyclotomy-recovery-")),
  );
  roots.push(root);
  return root;
}

function lockPathOf(root: string): string {
  return join(root, "workspace.lock");
}

function markerPathOf(root: string): string {
  return join(root, "lock-protocol.json");
}

async function plantLegacyLock(root: string, token: string): Promise<string> {
  const path = lockPathOf(root);
  await mkdir(path);
  await writeFile(
    join(path, `owner-${token}.json`),
    `${JSON.stringify({
      token,
      pid: 2_147_483_647,
      hostname: hostname(),
      operation: "capture",
      acquiredAt: 1,
    })}\n`,
  );
  return path;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("offline lock recovery", () => {
  it("reports nothing to recover when no legacy directory exists", async () => {
    const root = await storeRoot();
    const preview = await previewLockRecovery(root);

    expect(preview.recoverable).toBe(false);
    expect(preview.planToken).toBeNull();
    expect(preview.issues).toEqual([]);
    expect(
      await applyLockRecovery(root, "0".repeat(64), { offline: true }),
    ).toMatchObject({ kind: "nothing-to-recover" });
  });

  it("quarantines the legacy directory and preserves its owner record", async () => {
    const root = await storeRoot();
    const path = await plantLegacyLock(root, "old-owner");
    const preview = await previewLockRecovery(root);

    expect(preview.recoverable).toBe(true);
    expect(preview.lockProtocol).toMatchObject({
      kind: "legacy-directory",
      owner: { kind: "valid", owner: { token: "old-owner" } },
    });

    const result = await applyLockRecovery(root, preview.planToken!, {
      offline: true,
    });
    expect(result.kind).toBe("quarantined");
    if (result.kind !== "quarantined") throw new Error("unreachable");
    expect(basename(result.path)).toMatch(/^workspace\.lock\.abandoned-/u);
    expect(existsSync(path)).toBe(false);
    expect(await readdir(result.path)).toEqual(["owner-old-owner.json"]);

    const after = await previewLockRecovery(root);
    expect(after.lockProtocol).toEqual({ kind: "absent" });
    expect(after.recoverable).toBe(false);
  });

  it("refuses a stale token after the owner record changed", async () => {
    const root = await storeRoot();
    const path = await plantLegacyLock(root, "first-owner");
    const preview = await previewLockRecovery(root);

    await writeFile(
      join(path, "owner-first-owner.json"),
      `${JSON.stringify({
        token: "second-owner",
        pid: 2_147_483_647,
        hostname: hostname(),
        operation: "capture",
        acquiredAt: 1,
      })}\n`,
    );

    await expect(
      applyLockRecovery(root, preview.planToken!, { offline: true }),
    ).rejects.toBeInstanceOf(MaintenancePreviewChangedError);
    expect(existsSync(path)).toBe(true);
  });

  it("blocks on a corrupt protocol marker", async () => {
    const root = await storeRoot();
    const path = await plantLegacyLock(root, "old-owner");
    await writeFile(markerPathOf(root), "{not-json\n");

    const preview = await previewLockRecovery(root);
    expect(preview.issues.map(({ code }) => code)).toEqual([
      "lock-protocol-corrupt",
    ]);
    expect(preview.planToken).toBeNull();

    await expect(
      applyLockRecovery(root, "0".repeat(64), { offline: true }),
    ).rejects.toBeInstanceOf(MaintenanceBlockedError);
    expect(existsSync(path)).toBe(true);
  });

  it("requires an explicit offline precondition", async () => {
    const root = await storeRoot();
    const path = await plantLegacyLock(root, "old-owner");
    const preview = await previewLockRecovery(root);

    await expect(
      applyLockRecovery(root, preview.planToken!, {
        offline: false as unknown as true,
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(existsSync(path)).toBe(true);
  });

  it("never quarantines a native lock file", async () => {
    const root = await storeRoot();
    await writeFile(lockPathOf(root), "");
    await writeFile(markerPathOf(root), MARKER_BYTES);

    const preview = await previewLockRecovery(root);
    expect(preview.recoverable).toBe(false);
    expect(
      await applyLockRecovery(root, "0".repeat(64), { offline: true }),
    ).toMatchObject({ kind: "nothing-to-recover" });
    expect(existsSync(lockPathOf(root))).toBe(true);
  });
});
