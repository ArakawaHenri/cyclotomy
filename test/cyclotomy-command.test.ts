import { describe, expect, it } from "vitest";

import {
  completeCyclotomyCommandArguments,
  parseCyclotomyCommandArguments,
  presentCyclotomyStatus,
} from "../src/pi/cyclotomy-command.ts";
import { CyclotomyI18n } from "../src/presentation/i18n.ts";

describe("/cyclotomy command presentation", () => {
  it("treats no arguments as status and accepts instance and global actions", () => {
    expect(parseCyclotomyCommandArguments("")).toBe("status");
    expect(parseCyclotomyCommandArguments(" \t\n ")).toBe("status");
    expect(parseCyclotomyCommandArguments(" pause ")).toBe("pause");
    expect(parseCyclotomyCommandArguments("\tresume\n")).toBe("resume");
    expect(parseCyclotomyCommandArguments(" enable ")).toBe("enable");
    expect(parseCyclotomyCommandArguments("disable")).toBe("disable");

    for (const invalid of [
      "status",
      "PAUSE",
      "restart",
      "pause now",
      "enable disable",
    ]) {
      expect(parseCyclotomyCommandArguments(invalid)).toBe("usage");
    }
  });

  it("completes actions without suggesting invalid extra arguments", () => {
    const i18n = new CyclotomyI18n("en");

    expect(
      completeCyclotomyCommandArguments("", i18n)?.map(({ value }) => value),
    ).toEqual(["pause", "resume", "enable", "disable"]);
    expect(
      completeCyclotomyCommandArguments("pa", i18n)?.map(({ value }) => value),
    ).toEqual(["pause"]);
    expect(
      completeCyclotomyCommandArguments(" res ", i18n)?.map(
        ({ value }) => value,
      ),
    ).toEqual(["resume"]);
    for (const action of ["enable", "disable"] as const) {
      expect(
        completeCyclotomyCommandArguments(action.slice(0, 2), i18n)?.map(
          ({ value }) => value,
        ),
      ).toEqual([action]);
    }
    expect(completeCyclotomyCommandArguments("pause now", i18n)).toBeNull();
    expect(completeCyclotomyCommandArguments("unknown", i18n)).toBeNull();
  });

  it("presents running, paused, and failed participation directly", () => {
    const en = new CyclotomyI18n("en");

    expect(presentCyclotomyStatus({ running: true }, en)).toEqual({
      message: "Cyclotomy is running.",
      level: "info",
    });
    expect(presentCyclotomyStatus({ running: false }, en)).toEqual({
      message:
        "Cyclotomy is paused in this Pi instance. Run /cyclotomy resume to start it again.",
      level: "info",
    });

    const failed = presentCyclotomyStatus(
      { running: false, cause: new Error("bad\nstore") },
      en,
    );
    expect(failed.level).toBe("warning");
    expect(failed.message).toContain("bad\\nstore");
    expect(failed.message).toContain("/cyclotomy resume");
    expect(failed.message).not.toContain("\n");

    expect(
      presentCyclotomyStatus({ running: false, cause: undefined }, en).message,
    ).toContain("(undefined)");
  });
});
