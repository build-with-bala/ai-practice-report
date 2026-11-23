import { describe, expect, test } from "bun:test";
import path from "node:path";
import { coveredBy, uncoveredChars } from "../../../core/viz/fonts";
import { fmt } from "../../../core/viz/fmt";
import { fmtCases } from "./fmt-cases";

describe("fmt: the pinned cases", () => {
  test("share, count, interval and signed", () => {
    expect(fmt.share(0.004)).toBe("<1%");
    expect(fmt.share(0.61)).toBe("61%");
    expect(fmt.share(0.996)).toBe(">99%");
    expect(fmt.count(1234567)).toBe("1,234,567");
    expect(fmt.interval([63, 78])).toBe("[63–78]");
    expect(fmt.signed(-0.42)).toBe("−0.42");
  });

  test("tokens and duration", () => {
    expect(fmt.tokens(600_000)).toBe("600k");
    expect(fmt.tokens(1_500_000)).toBe("1.5M");
    expect(fmt.duration(14 * 60_000)).toBe("14 min");
    expect(fmt.duration(130 * 60_000)).toBe("2 h 10 min");
  });

  test("day, month and week", () => {
    expect(fmt.day(Date.UTC(2026, 10, 17, 23, 30), "Pacific/Auckland")).toBe("18 Nov 2026");
    expect(fmt.month("2026-11")).toBe("Nov 2026");
    expect(fmt.week("2026-W47")).toBe("W47 2026");
  });
});

describe("fmt: the rest of the rules", () => {
  test("score is an integer, never -0", () => {
    expect(fmt.score(70.6)).toBe("71");
    expect(fmt.score(-0.2)).toBe("0");
  });

  test("share at the edges", () => {
    expect(fmt.share(0)).toBe("0%");
    expect(fmt.share(0.005)).toBe("1%");
    expect(fmt.share(0.9949)).toBe("99%");
    expect(fmt.share(0.995)).toBe(">99%");
    expect(fmt.share(1)).toBe("100%");
  });

  test("count rounds and groups; small numbers have no comma", () => {
    expect(fmt.count(0)).toBe("0");
    expect(fmt.count(999)).toBe("999");
    expect(fmt.count(1000)).toBe("1,000");
    expect(fmt.count(1234.6)).toBe("1,235");
  });

  test("decimal is toFixed and never -0", () => {
    expect(fmt.decimal(0.125, 2)).toBe((0.125).toFixed(2));
    expect(fmt.decimal(-0.001, 2)).toBe("0.00");
    expect(fmt.decimal(-0, 0)).toBe("0");
    expect(fmt.decimal(-1.25, 1)).toBe("−1.3");
  });

  test("signed: + or U+2212, two digits by default, no sign on zero", () => {
    expect(fmt.signed(0.42)).toBe("+0.42");
    expect(fmt.signed(1.234, 1)).toBe("+1.2");
    expect(fmt.signed(-0.001)).toBe("0.00");
  });

  test("tokens: the integer, then k, then M with one decimal and no trailing .0", () => {
    expect(fmt.tokens(999)).toBe("999");
    expect(fmt.tokens(1000)).toBe("1k");
    expect(fmt.tokens(999_499)).toBe("999k");
    expect(fmt.tokens(999_600)).toBe("1M");
    expect(fmt.tokens(2_000_000)).toBe("2M");
    expect(fmt.tokens(12_345_678)).toBe("12.3M");
  });

  test("duration: seconds, minutes, hours and minutes, days", () => {
    expect(fmt.duration(42_000)).toBe("42 s");
    expect(fmt.duration(59 * 60_000)).toBe("59 min");
    expect(fmt.duration(60 * 60_000)).toBe("1 h");
    expect(fmt.duration(47 * 3_600_000 + 59 * 60_000)).toBe("47 h 59 min");
    expect(fmt.duration(48 * 3_600_000)).toBe("2 d");
    expect(fmt.duration(10 * 86_400_000)).toBe("10 d");
  });

  test("day has no leading zero; the zone decides the date", () => {
    expect(fmt.day(Date.UTC(2026, 0, 5, 12), "UTC")).toBe("5 Jan 2026");
    expect(fmt.day(Date.UTC(2026, 10, 17, 23, 30), "UTC")).toBe("17 Nov 2026");
  });

  test("span within a year, across years, within a month, and open", () => {
    expect(fmt.span(Date.UTC(2026, 2, 3), Date.UTC(2026, 10, 18), "UTC")).toBe("Mar–Nov 2026");
    expect(fmt.span(Date.UTC(2025, 10, 3), Date.UTC(2026, 2, 18), "UTC")).toBe("Nov 2025–Mar 2026");
    expect(fmt.span(Date.UTC(2026, 10, 3), Date.UTC(2026, 10, 18), "UTC")).toBe("Nov 2026");
    expect(fmt.span(undefined, Date.UTC(2026, 10, 18), "UTC")).toBe("—");
    expect(fmt.span(Date.UTC(2026, 10, 18), undefined, "UTC")).toBe("—");
  });

  test("a value that is not a number never prints NaN", () => {
    for (const s of [fmt.score(NaN), fmt.count(Infinity), fmt.share(NaN), fmt.decimal(NaN, 2), fmt.signed(NaN), fmt.tokens(NaN), fmt.duration(NaN)]) {
      expect(s).toBe("—");
    }
    expect(fmt.month("Nov")).toBe("—");
    expect(fmt.week("47")).toBe("—");
  });
});

describe("fmt: negatives take U+2212 MINUS SIGN, never an ASCII hyphen", () => {
  const MINUS = "\u2212";

  test("score, tokens, duration, count, signed and decimal agree", () => {
    expect(fmt.score(-3.4)).toBe(`${MINUS}3`);
    expect(fmt.tokens(-5)).toBe(`${MINUS}5`);
    expect(fmt.tokens(-1500)).toBe(`${MINUS}2k`);
    expect(fmt.tokens(-1_500_000)).toBe(`${MINUS}1.5M`);
    expect(fmt.duration(-5000)).toBe(`${MINUS}5 s`);
    expect(fmt.duration(-14 * 60_000)).toBe(`${MINUS}14 min`);
    expect(fmt.duration(-130 * 60_000)).toBe(`${MINUS}2 h 10 min`);
    expect(fmt.duration(-3 * 86_400_000)).toBe(`${MINUS}3 d`);
    expect(fmt.count(-1234)).toBe(`${MINUS}1,234`);
    expect(fmt.signed(-0.42)).toBe(`${MINUS}0.42`);
    expect(fmt.decimal(-0.5, 2)).toBe(`${MINUS}0.50`);
  });

  test("no output for a negative value holds a hyphen, and a value that rounds to zero has no sign", () => {
    const outs = [-0.4, -3, -999, -1e3, -12_345, -1e7].flatMap((x) => [fmt.score(x), fmt.tokens(x), fmt.duration(x), fmt.count(x),
      fmt.signed(x), fmt.decimal(x, 1)]);
    expect(outs.filter((s) => s.includes("-"))).toEqual([]);
    expect([fmt.score(-0.4), fmt.tokens(-0.4), fmt.duration(-400), fmt.count(-0.4), fmt.decimal(-0.04, 1)]).toEqual(["0", "0", "0 s", "0", "0.0"]);
  });

  test("the minus sign is covered by every embedded family", () => {
    expect(uncoveredChars(MINUS)).toEqual([]);
    for (const family of ["mono", "display", "serif"] as const) expect([family, coveredBy(MINUS, family)]).toEqual([family, true]);
  });
});

describe("fmt: edge cases", () => {
  test("count never prints exponent notation: beyond 2^53 − 1 it clamps to a bound", () => {
    expect(fmt.count(1e21)).toBe(">9,007,199,254,740,991");
    expect(fmt.count(-1e21)).toBe("<\u22129,007,199,254,740,991");
    expect(fmt.count(Number.MAX_VALUE)).toBe(">9,007,199,254,740,991");
    expect(fmt.count(Number.MAX_SAFE_INTEGER)).toBe("9,007,199,254,740,991");
    for (const n of [1e16, 1e21, 1e300]) expect(fmt.count(n)).not.toMatch(/e/i);
  });

  test("an impossible ISO week prints the fallback", () => {
    for (const w of ["2026-W99", "2026-W00", "2026-W54", "2025-W53", "2026-W5", "2026-w47"]) expect([w, fmt.week(w)]).toEqual([w, "—"]);
    // 2026 and 2020 have 53 ISO weeks (1 Jan on a Thursday; a leap year starting on a Wednesday).
    expect(fmt.week("2026-W53")).toBe("W53 2026");
    expect(fmt.week("2020-W53")).toBe("W53 2020");
    expect(fmt.week("2026-W01")).toBe("W01 2026");
  });

  test("dates come from formatToParts, not from splitting a formatted string", () => {
    const proto = Intl.DateTimeFormat.prototype;
    const realFormat = Object.getOwnPropertyDescriptor(proto, "format")!;
    const realParts = proto.formatToParts;
    let parts = 0;
    try {
      Object.defineProperty(proto, "format", { configurable: true, get: () => () => "garbage" });
      proto.formatToParts = function (this: Intl.DateTimeFormat, d?: Date | number) { parts++; return realParts.call(this, d); };
      expect(fmt.day(Date.UTC(2026, 10, 17, 23, 30), "Pacific/Auckland")).toBe("18 Nov 2026");
      expect(fmt.span(Date.UTC(2025, 10, 3), Date.UTC(2026, 2, 18), "Asia/Kolkata")).toBe("Nov 2025–Mar 2026");
    } finally {
      Object.defineProperty(proto, "format", realFormat);
      proto.formatToParts = realParts;
    }
    expect(parts).toBeGreaterThan(0);
  });
});

describe("fmt across locales and process zones (Review Focus 5)", () => {
  // The child prints the same case list this process computes, so the two runs and this one must all agree.
  const CASES_FILE = path.join(import.meta.dir, "fmt-cases.ts");
  const script = `const { fmtCases } = await import(${JSON.stringify(CASES_FILE)}); console.log(JSON.stringify(fmtCases()));`;

  const run = (env: Record<string, string>): string => {
    const r = Bun.spawnSync([process.execPath, "-e", script], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(0);
    return r.stdout.toString();
  };

  test("the cases print byte-identical output under de_DE + Asia/Kolkata and C + UTC", () => {
    const de = run({ LANG: "de_DE.UTF-8", LC_ALL: "de_DE.UTF-8", TZ: "Asia/Kolkata" });
    const c = run({ LANG: "C", LC_ALL: "C", TZ: "UTC" });
    expect(de).toBe(c);
    expect(JSON.parse(de)).toEqual(fmtCases());
  });
});
