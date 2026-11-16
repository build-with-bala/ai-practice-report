import { describe, expect, test } from "bun:test";
import { localDay, toEpochMs } from "../../../core/io/time";

describe("toEpochMs", () => {
  test("seconds, ms, numeric strings, ISO", () => {
    expect(toEpochMs(1773212906)).toBe(1773212906000);
    expect(toEpochMs(1773212906148)).toBe(1773212906148);
    expect(toEpochMs("1773212906")).toBe(1773212906000);
    expect(toEpochMs("2026-11-17T01:55:29.000Z")).toBe(Date.parse("2026-11-17T01:55:29.000Z"));
  });
  test("rejects implausible values", () => {
    expect(toEpochMs(0)).toBeUndefined();
    expect(toEpochMs("garbage")).toBeUndefined();
    expect(toEpochMs(Date.now() + 3 * 86400000)).toBeUndefined();
    expect(toEpochMs(NaN)).toBeUndefined();
    expect(toEpochMs(Infinity)).toBeUndefined();
    expect(toEpochMs(null)).toBeUndefined();
    expect(toEpochMs({})).toBeUndefined();
    expect(toEpochMs("2014-12-31T23:59:59Z")).toBeUndefined();
  });
  test("now parameter", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(toEpochMs(now + 86400000, now)).toBe(now + 86400000);
    expect(toEpochMs(now + 3 * 86400000, now)).toBeUndefined();
  });
});

describe("localDay", () => {
  const ms = Date.UTC(2026, 10, 16, 12, 30);
  test("explicit zones", () => {
    expect(localDay(ms, "Pacific/Auckland")).toBe("2026-11-17");
    expect(localDay(ms, "UTC")).toBe("2026-11-16");
  });
  test("default zone follows process.env.TZ", () => {
    const prev = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Auckland";
      expect(localDay(ms)).toBe("2026-11-17");
      process.env.TZ = "UTC";
      expect(localDay(ms)).toBe("2026-11-16");
    } finally {
      if (prev === undefined) delete process.env.TZ;
      else process.env.TZ = prev;
    }
  });
});
