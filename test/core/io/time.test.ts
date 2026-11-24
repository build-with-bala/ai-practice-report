import { describe, expect, test } from "bun:test";
import { localDay, toEpochMs } from "../../../core/io/time";
import { withTz } from "../../kit/tz";

describe("toEpochMs", () => {
  test("seconds, ms, numeric strings, ISO", () => {
    expect(toEpochMs(1773212906)).toBe(1773212906000);
    expect(toEpochMs(1773212906148)).toBe(1773212906148);
    expect(toEpochMs("1773212906")).toBe(1773212906000);
    expect(toEpochMs("2026-11-17T01:55:29.000Z")).toBe(Date.parse("2026-11-17T01:55:29.000Z"));
  });
  test("a date-time with no zone is read in the process zone; a date alone is that day's start in UTC", () => {
    const now = Date.UTC(2026, 11, 1);
    expect(withTz("UTC", () => toEpochMs("2026-11-20T10:00:00", now))).toBe(Date.UTC(2026, 10, 20, 10));
    expect(withTz("Asia/Kolkata", () => toEpochMs("2026-11-20T10:00:00", now))).toBe(Date.UTC(2026, 10, 20, 4, 30));
    expect(withTz("America/Los_Angeles", () => toEpochMs("2026-11-20T10:00:00", now))).toBe(Date.UTC(2026, 10, 20, 18));
    for (const tz of ["UTC", "Asia/Kolkata", "America/Los_Angeles"]) expect(withTz(tz, () => toEpochMs("2026-11-20", now))).toBe(Date.UTC(2026, 10, 20));
    expect(withTz("Asia/Kolkata", () => toEpochMs("2026-11-20T10:00:00Z", now))).toBe(Date.UTC(2026, 10, 20, 10));
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

/** The process zone when this file started, before any test changed process.env.TZ. */
const startZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;

describe("localDay", () => {
  const ms = Date.UTC(2026, 10, 16, 12, 30);
  test("explicit zones", () => {
    expect(localDay(ms, "Pacific/Auckland")).toBe("2026-11-17");
    expect(localDay(ms, "UTC")).toBe("2026-11-16");
  });
  test("default zone follows process.env.TZ", () => {
    withTz("Pacific/Auckland", () => expect(localDay(ms)).toBe("2026-11-17"));
    withTz("UTC", () => expect(localDay(ms)).toBe("2026-11-16"));
  });
  test("a zone's formatter is built once and reused; the process zone still follows TZ", () => {
    const Real = Intl.DateTimeFormat;
    let built = 0;
    const Counting = function (this: unknown, ...args: ConstructorParameters<typeof Real>) {
      built++;
      return new Real(...args);
    } as unknown as typeof Intl.DateTimeFormat;
    Intl.DateTimeFormat = Counting;
    try {
      for (let i = 0; i < 100; i++) expect(localDay(ms + i, "Asia/Kathmandu")).toBe("2026-11-16");
      expect(built).toBeLessThanOrEqual(1);
      withTz("Pacific/Auckland", () => expect(localDay(ms)).toBe("2026-11-17"));
      withTz("UTC", () => expect(localDay(ms)).toBe("2026-11-16"));
      withTz("Pacific/Auckland", () => expect(localDay(ms)).toBe("2026-11-17"));
      expect(built).toBeLessThanOrEqual(3); // Kathmandu once, the process zone once per TZ value
    } finally {
      Intl.DateTimeFormat = Real;
    }
  });
  test("after a test restored it, the zone is the starting one and later changes still apply", () => {
    expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(startZone);
    withTz("Pacific/Auckland", () => expect(localDay(ms)).toBe("2026-11-17"));
    withTz("UTC", () => expect(localDay(ms)).toBe("2026-11-16"));
    expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(startZone);
  });
});
