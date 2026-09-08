import { describe, expect, it } from "vitest";

import { compareUtf8 } from "../src/infrastructure/utf8-order.ts";

describe("canonical UTF-8 ordering", () => {
  it("preserves encoded order across path prefixes and Unicode planes", () => {
    const paths = [
      "",
      "a",
      "a/file",
      "a.txt",
      "A",
      "é",
      "e\u0301",
      "中",
      "\ud7ff",
      "\ue000",
      "\ufffd",
      "\uffff",
      "\u{10000}",
      "\u{10001}",
      "\u{1f600}",
      "\u{10ffff}",
      "\ud800",
      "\ud801",
      "\udc00",
      "\ud800a",
      "\ufffda",
      "\ud800\ud800",
      "\udc00\udc01",
    ];
    for (const left of paths) {
      for (const right of paths) {
        expect(Math.sign(compareUtf8(left, right))).toBe(
          Math.sign(Buffer.compare(Buffer.from(left), Buffer.from(right))),
        );
      }
    }
  });

  it("produces the same stable order for mixed Unicode paths", () => {
    let state = 0x12345678;
    const paths = Array.from({ length: 1000 }, (_, index) => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return `src/${String.fromCodePoint(state % 0x110000)}/${index % 17}`;
    });
    expect([...paths].sort(compareUtf8)).toEqual(
      [...paths].sort((left, right) =>
        Buffer.compare(Buffer.from(left), Buffer.from(right)),
      ),
    );
  });
});
