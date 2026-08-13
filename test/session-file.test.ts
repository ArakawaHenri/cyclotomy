import {
  appendFile,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PiSessionSourceRejectedError,
  readPiSessionPublicObservation,
} from "../src/pi/session-file.ts";

async function fileHandlePrototype(path: string): Promise<{
  read(...args: unknown[]): Promise<unknown>;
}> {
  const probe = await open(path, "w");
  const prototype = Object.getPrototypeOf(probe) as {
    read(...args: unknown[]): Promise<unknown>;
  };
  await probe.close();
  await rm(path, { force: true });
  return prototype;
}

describe("cold Pi session public observation", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cyclotomy-session-header-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("types only structural source rejection as durable evidence", async () => {
    await expect(
      readPiSessionPublicObservation("relative.jsonl"),
    ).rejects.toMatchObject({
      name: PiSessionSourceRejectedError.name,
      kind: "invalid-path",
    });

    const directory = join(root, "directory.jsonl");
    await mkdir(directory);
    await expect(
      readPiSessionPublicObservation(directory),
    ).rejects.toMatchObject({
      name: PiSessionSourceRejectedError.name,
      kind: "not-regular",
    });
  });

  it("opens a bounded coherent copy through Pi's public API", async () => {
    const path = join(root, "session.jsonl");
    await writeFile(
      path,
      `${JSON.stringify({
        type: "session",
        id: "source",
        cwd: root,
      })}\n${JSON.stringify({
        type: "custom",
        id: "entry",
        parentId: null,
        timestamp: new Date(0).toISOString(),
        customType: "test",
      })}\n`,
    );

    await expect(readPiSessionPublicObservation(path)).resolves.toMatchObject({
      sessionId: "source",
      cwd: root,
    });
  });

  it("projects stable coordinates through transparent labels", async () => {
    const path = join(root, "stable-projection.jsonl");
    const timestamp = new Date(0).toISOString();
    await writeFile(
      path,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "source",
          cwd: root,
        }),
        JSON.stringify({
          type: "custom",
          id: "root",
          parentId: null,
          timestamp,
          customType: "test",
        }),
        JSON.stringify({
          type: "label",
          id: "wrapper",
          parentId: "root",
          timestamp,
          targetId: "root",
          label: "bookmark",
        }),
        JSON.stringify({
          type: "session_info",
          id: "child",
          parentId: "wrapper",
          timestamp,
          name: "child",
        }),
      ].join("\n") + "\n",
    );

    await expect(readPiSessionPublicObservation(path)).resolves.toEqual({
      kind: "observed",
      sessionId: "source",
      cwd: root,
      stableCoordinates: [
        {
          id: "root",
          stableParentId: null,
          type: "custom",
          messageRole: null,
        },
        {
          id: "child",
          stableParentId: "root",
          type: "session_info",
          messageRole: null,
        },
      ],
    });
  });

  it("uses Pi's public loader semantics for blank and malformed lines", async () => {
    const path = join(root, "prefixed.jsonl");
    await writeFile(
      path,
      [
        "",
        "   ",
        "{malformed",
        JSON.stringify({ type: "session", id: "source", cwd: root }),
        JSON.stringify({
          type: "custom",
          id: "entry",
          parentId: null,
          timestamp: new Date(0).toISOString(),
          customType: "test",
        }),
      ].join("\n"),
    );

    await expect(readPiSessionPublicObservation(path)).resolves.toMatchObject({
      sessionId: "source",
      cwd: root,
    });
  });

  it("rejects the first parsed record when it is not a usable header", async () => {
    const path = join(root, "non-header-first.jsonl");
    await writeFile(
      path,
      `${JSON.stringify({ type: "message", id: "first" })}\n${JSON.stringify({
        type: "session",
        id: "source",
        cwd: root,
      })}\n`,
    );

    await expect(readPiSessionPublicObservation(path)).rejects.toThrow(
      /valid pi session/u,
    );
  });

  it("keeps scanning correctly across legal short reads", async () => {
    const path = join(root, "short-reads.jsonl");
    const cwd = join(root, "\u4f60\u597d".repeat(1024));
    await writeFile(
      path,
      `{malformed}\n${JSON.stringify({
        type: "session",
        id: "source",
        cwd,
      })}\n`,
    );

    const prototype = await fileHandlePrototype(join(root, "prototype"));
    const originalRead = prototype.read;
    let readCalls = 0;
    const spy = vi.spyOn(prototype, "read").mockImplementation(async function (
      this: FileHandle,
      ...args: unknown[]
    ): Promise<unknown> {
      const adjusted = [...args];
      if (typeof adjusted[2] === "number") {
        adjusted[2] = Math.min(adjusted[2], 7);
      }
      readCalls += 1;
      return Reflect.apply(originalRead, this, adjusted);
    });
    try {
      await expect(readPiSessionPublicObservation(path)).resolves.toMatchObject(
        {
          sessionId: "source",
          cwd,
        },
      );
    } finally {
      spy.mockRestore();
    }
    expect(readCalls).toBeGreaterThan(2);
  });

  it("detects an in-place header change during the coherent copy", async () => {
    const path = join(root, "changing.jsonl");
    const header = (id: string): string =>
      `${JSON.stringify({ type: "session", id, cwd: root })}\n`;
    await writeFile(path, header("source"));

    const prototype = await fileHandlePrototype(join(root, "prototype"));
    const originalRead = prototype.read;
    let readCalls = 0;
    const spy = vi.spyOn(prototype, "read").mockImplementation(async function (
      this: FileHandle,
      ...args: unknown[]
    ): Promise<unknown> {
      const result = await Reflect.apply(originalRead, this, args);
      readCalls += 1;
      if (readCalls === 1) await writeFile(path, header("mutant"));
      return result;
    });
    try {
      await expect(readPiSessionPublicObservation(path)).rejects.toThrow(
        /changed while/u,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects an append while the coherent copy is being made", async () => {
    const path = join(root, "appending.jsonl");
    const content = `${JSON.stringify({
      type: "session",
      id: "source",
      cwd: root,
    })}\n`;
    await writeFile(path, content);

    const prototype = await fileHandlePrototype(join(root, "prototype"));
    const originalRead = prototype.read;
    let appended = false;
    const spy = vi.spyOn(prototype, "read").mockImplementation(async function (
      this: FileHandle,
      ...args: unknown[]
    ): Promise<unknown> {
      const result = await Reflect.apply(originalRead, this, args);
      if (!appended) {
        appended = true;
        await appendFile(
          path,
          `${JSON.stringify({ type: "message", id: "new" })}\n`,
        );
      }
      return result;
    });
    try {
      await expect(readPiSessionPublicObservation(path)).rejects.toThrow(
        /changed while/u,
      );
    } finally {
      spy.mockRestore();
    }
    expect(appended).toBe(true);
  });

  it("keeps truncation during copying retryable", async () => {
    const path = join(root, "truncating.jsonl");
    await writeFile(
      path,
      `${JSON.stringify({
        type: "session",
        id: "source",
        cwd: root,
      })}\n`,
    );

    const prototype = await fileHandlePrototype(join(root, "prototype"));
    const originalRead = prototype.read;
    let truncated = false;
    const spy = vi.spyOn(prototype, "read").mockImplementation(async function (
      this: FileHandle,
      ...args: unknown[]
    ): Promise<unknown> {
      const result = await Reflect.apply(originalRead, this, args);
      if (!truncated) {
        truncated = true;
        await truncate(path, 0);
      }
      return result;
    });
    try {
      await readPiSessionPublicObservation(path);
      throw new Error("expected parent observation to fail");
    } catch (error) {
      expect(error).not.toBeInstanceOf(PiSessionSourceRejectedError);
      expect(error).toEqual(
        expect.objectContaining({
          message: expect.stringMatching(/changed while/u),
        }),
      );
    } finally {
      spy.mockRestore();
    }
    expect(truncated).toBe(true);
  });

  it("detects pathname rebinding even when the bytes stay unchanged", async () => {
    const path = join(root, "rebound.jsonl");
    const displaced = join(root, "displaced.jsonl");
    const content = `${JSON.stringify({
      type: "session",
      id: "source",
      cwd: root,
    })}\n`;
    await writeFile(path, content);

    const prototype = await fileHandlePrototype(join(root, "prototype"));
    const originalRead = prototype.read;
    let readCalls = 0;
    const spy = vi.spyOn(prototype, "read").mockImplementation(async function (
      this: FileHandle,
      ...args: unknown[]
    ): Promise<unknown> {
      const result = await Reflect.apply(originalRead, this, args);
      readCalls += 1;
      if (readCalls === 1) {
        await rename(path, displaced);
        await writeFile(path, content);
      }
      return result;
    });
    try {
      await expect(readPiSessionPublicObservation(path)).rejects.toThrow(
        /changed while/u,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("does not classify a post-open disappearance as a missing source", async () => {
    const path = join(root, "disappearing.jsonl");
    const displaced = join(root, "disappeared.jsonl");
    await writeFile(
      path,
      `${JSON.stringify({ type: "session", id: "source", cwd: root })}\n`,
    );

    const prototype = await fileHandlePrototype(join(root, "prototype"));
    const originalRead = prototype.read;
    let moved = false;
    const spy = vi.spyOn(prototype, "read").mockImplementation(async function (
      this: FileHandle,
      ...args: unknown[]
    ): Promise<unknown> {
      const result = await Reflect.apply(originalRead, this, args);
      if (!moved) {
        moved = true;
        await rename(path, displaced);
      }
      return result;
    });
    try {
      await expect(readPiSessionPublicObservation(path)).rejects.toThrow(
        /changed while/u,
      );
    } finally {
      spy.mockRestore();
    }
    expect(moved).toBe(true);
  });

  it("classifies only an initially absent parent as missing", async () => {
    await expect(
      readPiSessionPublicObservation(join(root, "not-yet-persisted.jsonl")),
    ).resolves.toEqual({ kind: "source-missing" });
  });

  it("does not let public open manufacture an identity for an empty parent", async () => {
    const path = join(root, "empty.jsonl");
    await writeFile(path, "");

    await expect(readPiSessionPublicObservation(path)).rejects.toMatchObject({
      name: PiSessionSourceRejectedError.name,
      kind: "empty",
    });
  });

  it("rejects symlinked and oversized parent files without rejecting hard links", async () => {
    const source = join(root, "source.jsonl");
    const content = `${JSON.stringify({
      type: "session",
      id: "source",
      cwd: root,
    })}\n`;
    await writeFile(source, content);
    if (process.platform !== "win32") {
      const linked = join(root, "linked.jsonl");
      await link(source, linked);
      await expect(
        readPiSessionPublicObservation(source),
      ).resolves.toMatchObject({
        sessionId: "source",
        cwd: root,
      });
      await rm(linked);
      const symbolic = join(root, "symbolic.jsonl");
      await symlink(source, symbolic);
      await expect(readPiSessionPublicObservation(symbolic)).rejects.toThrow(
        PiSessionSourceRejectedError,
      );
    }

    const oversized = join(root, "oversized.jsonl");
    await writeFile(oversized, "");
    await truncate(oversized, 64 * 1024 * 1024 + 1);
    await expect(
      readPiSessionPublicObservation(oversized),
    ).rejects.toMatchObject({
      name: PiSessionSourceRejectedError.name,
      kind: "too-large",
    });
  });

  it("confines Pi's legacy migration writes to the private copy", async () => {
    const path = join(root, "legacy-v1.jsonl");
    await writeFile(
      path,
      `${JSON.stringify({
        type: "session",
        id: "legacy",
        timestamp: new Date(0).toISOString(),
        cwd: root,
      })}\n${JSON.stringify({
        type: "custom",
        timestamp: new Date(1).toISOString(),
        customType: "legacy-test",
      })}\n`,
    );
    const bytesBefore = await readFile(path);
    const statBefore = await stat(path, { bigint: true });

    await expect(readPiSessionPublicObservation(path)).resolves.toMatchObject({
      sessionId: "legacy",
      cwd: root,
    });

    expect(await readFile(path)).toEqual(bytesBefore);
    const statAfter = await stat(path, { bigint: true });
    expect(statAfter.dev).toBe(statBefore.dev);
    expect(statAfter.ino).toBe(statBefore.ino);
    expect(statAfter.size).toBe(statBefore.size);
    expect(statAfter.mtimeNs).toBe(statBefore.mtimeNs);
    expect(statAfter.ctimeNs).toBe(statBefore.ctimeNs);
  });
});
