import { describe, expect, it } from "vitest";

import { systemErrorCode } from "../src/infrastructure/system-error.ts";

describe("system error code", () => {
  it("reads one ordinary string code", () => {
    expect(systemErrorCode({ code: "ENOENT" })).toBe("ENOENT");
    expect(systemErrorCode({ code: 2 })).toBeUndefined();
    expect(systemErrorCode(null)).toBeUndefined();
    expect(systemErrorCode("ENOENT")).toBeUndefined();
  });

  it("reads an untrusted code property exactly once", () => {
    let reads = 0;
    const error = Object.defineProperty({}, "code", {
      get() {
        reads += 1;
        return reads === 1 ? "EACCES" : "ENOENT";
      },
    });

    expect(systemErrorCode(error)).toBe("EACCES");
    expect(reads).toBe(1);
  });

  it("does not let a hostile property accessor escape", () => {
    const cause = new Error("hostile getter");
    const error = Object.defineProperty({}, "code", {
      get() {
        throw cause;
      },
    });

    expect(systemErrorCode(error)).toBeUndefined();
  });
});
