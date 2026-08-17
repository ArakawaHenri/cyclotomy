import { describe, expect, it } from "vitest";

import {
  completeCyclotomyCommandArguments,
  parseCyclotomyCommandArguments,
  presentCyclotomyStatus,
} from "../src/pi/cyclotomy-command.ts";
import { CyclotomyI18n } from "../src/pi/i18n.ts";

describe("/cyclotomy command presentation", () => {
  it("treats no arguments as status and accepts only stop or resume", () => {
    expect(parseCyclotomyCommandArguments("")).toBe("status");
    expect(parseCyclotomyCommandArguments(" \t\n ")).toBe("status");
    expect(parseCyclotomyCommandArguments(" stop ")).toBe("stop");
    expect(parseCyclotomyCommandArguments("\tresume\n")).toBe("resume");

    for (const invalid of ["status", "STOP", "restart", "stop now"]) {
      expect(parseCyclotomyCommandArguments(invalid)).toBe("usage");
    }
  });

  it("completes the two actions without suggesting invalid extra arguments", () => {
    const i18n = new CyclotomyI18n("en");

    expect(
      completeCyclotomyCommandArguments("", i18n)?.map(({ value }) => value),
    ).toEqual(["stop", "resume"]);
    expect(
      completeCyclotomyCommandArguments("st", i18n)?.map(({ value }) => value),
    ).toEqual(["stop"]);
    expect(
      completeCyclotomyCommandArguments(" res ", i18n)?.map(
        ({ value }) => value,
      ),
    ).toEqual(["resume"]);
    expect(completeCyclotomyCommandArguments("stop now", i18n)).toBeNull();
    expect(completeCyclotomyCommandArguments("unknown", i18n)).toBeNull();
  });

  it("presents running, user-stopped, and failed participation directly", () => {
    const en = new CyclotomyI18n("en");

    expect(presentCyclotomyStatus({ running: true }, en)).toEqual({
      message: "Cyclotomy is running.",
      level: "info",
    });
    expect(presentCyclotomyStatus({ running: false }, en)).toEqual({
      message: "Cyclotomy is stopped. Run /cyclotomy resume to start it again.",
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
