import { describe, expect, it } from "vitest";

import { messageOfUnknown } from "../src/pi/unknown-error.ts";

describe("unknown error presentation", () => {
  it("preserves ordinary error messages", () => {
    expect(messageOfUnknown(new Error("failure"))).toBe("failure");
  });

  it("is total when a thrown value rejects string coercion", () => {
    const hostile = {
      toString(): string {
        throw new Error("coercion failed");
      },
    };

    expect(messageOfUnknown(hostile)).toBe("unprintable failure");
  });

  it("always returns text for malformed Error messages", () => {
    const missing = new Error("placeholder");
    Object.defineProperty(missing, "message", { value: undefined });
    expect(messageOfUnknown(missing)).toBe("undefined");

    const hostile = new Error("placeholder");
    Object.defineProperty(hostile, "message", {
      value: {
        toString(): string {
          throw new Error("coercion failed");
        },
      },
    });
    expect(messageOfUnknown(hostile)).toBe("unprintable failure");
  });
});
