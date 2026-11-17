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

/** The process zone when this file started, before any test changed process.env.TZ. */
const startZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Runs `f` with `process.env.TZ = tz`, then restores the zone by assignment: TZ's previous value, or — when it was unset —
 * the zone that was in effect (`bun test` runs in UTC with TZ unset; assigning "" would switch to the system zone instead).
 * Never `delete process.env.TZ`: in Bun 1.3 that removes the variable's setter, so the zone stays at its last value and
 * later assignments are ignored for the rest of the process, every later test file included.
 */
function withTz(tz: string, f: () => void): void {
  const saved = process.env.TZ ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    process.env.TZ = tz;
    f();
  } finally {
    process.env.TZ = saved;
  }
}

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
  test("after a test restored it, the zone is the starting one and later changes still apply", () => {
    expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(startZone);
    withTz("Pacific/Auckland", () => expect(localDay(ms)).toBe("2026-11-17"));
    withTz("UTC", () => expect(localDay(ms)).toBe("2026-11-16"));
    expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(startZone);
  });
});
