import { describe, expect, test } from "bun:test";
import { checkFileTimes } from "../../../core/forensics/files";
import type { FileFactEv } from "../../../core/model/events";
import { scanResultOf } from "../../kit/scanresult";

const T0 = Date.UTC(2026, 9, 1, 9, 0);
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const UTC = { timeZone: "UTC" };

/** File `i` of a clean history: one session a day, born at its first event, last written at its last. */
function clean(i: number, over: Partial<FileFactEv> = {}): FileFactEv {
  const firstTs = T0 + i * DAY;
  const lastTs = firstTs + HOUR;
  return { k: "file", tool: "claude-code", source: "claude-code.transcripts", pathHash: `f${i}`, bytes: 1_000,
    birth: firstTs, firstTs, lastTs, mtime: lastTs + 1_000, ctime: lastTs + 1_000, ...over };
}
const files = (n: number, f: (i: number) => FileFactEv = (i) => clean(i)): FileFactEv[] => Array.from({ length: n }, (_, i) => f(i));

describe("checkFileTimes (C5)", () => {
  test("clean files pass", () => {
    const c = checkFileTimes(scanResultOf(files(20)), UTC);
    expect(c.id).toBe("C5");
    expect(c.status).toBe("pass");
    expect(c.n).toBe(20);
    expect(c.values.violations).toBe(0);
    expect(c.tools).toEqual(["claude-code"]);
    expect(c.askAbout).toBeUndefined();
  });

  test("3 files with mtime before their last event fail", () => {
    const c = checkFileTimes(scanResultOf(files(20, (i) => (i < 3 ? clean(i, { mtime: T0 + i * DAY + 10 * MIN }) : clean(i)))), UTC);
    expect(c.status).toBe("fail");
    expect(c.values.violations).toBe(3);
    expect(c.askAbout).toContain("3 ");
  });

  test("an mtime within 2 s before the last event is no violation", () => {
    const c = checkFileTimes(scanResultOf(files(20, (i) => clean(i, { mtime: T0 + i * DAY + HOUR - 1_500 }))), UTC);
    expect(c.status).toBe("pass");
  });

  test("a single violation is below the threshold of 2", () => {
    const c = checkFileTimes(scanResultOf(files(20, (i) => (i === 0 ? clean(i, { mtime: T0 }) : clean(i)))), UTC);
    expect(c.status).toBe("pass");
    expect(c.values.violations).toBe(1);
  });

  test("ctime more than 24 h after mtime is a violation outside a restore cluster", () => {
    const c = checkFileTimes(scanResultOf(files(20, (i) => (i < 2 ? clean(i, { ctime: T0 + i * DAY + 30 * HOUR }) : clean(i)))), UTC);
    expect(c.status).toBe("fail");
    expect(c.values.violations).toBe(2);
  });

  test("copied directory: 20 files born in one 10-min window, 30 days of events, are a note with that date", () => {
    const copied = Date.UTC(2026, 10, 3, 14, 0);
    const c = checkFileTimes(scanResultOf(files(20, (i) => {
      const firstTs = T0 + Math.floor((i * 30 * DAY) / 19);
      return clean(0, { pathHash: `f${i}`, firstTs, lastTs: firstTs + HOUR, mtime: firstTs + HOUR + 1_000, birth: copied + i * 20_000, ctime: copied + i * 20_000 });
    })), UTC);
    expect(c.status).toBe("note");
    expect(c.values.date).toBe("2026-11-03");
    expect(c.values.days).toBe(30);
    expect(c.values.violations).toBe(0); // ctime far after mtime is no violation inside the cluster
    expect(c.askAbout).toBe("Most trace files were created on 2026-11-03 although their activity spans 30 days. Was this history copied or restored from a backup then?");
  });

  test("the cluster's date is the local day in the given zone", () => {
    const copied = Date.UTC(2026, 10, 3, 14, 0); // 04 Nov in Auckland
    const c = checkFileTimes(scanResultOf(files(20, (i) => clean(i, { birth: copied + i * 1_000, ctime: copied + i * 1_000 }))), { timeZone: "Pacific/Auckland" });
    expect(c.values.date).toBe("2026-11-04");
  });

  test("without birth times the ctime places the births", () => {
    const copied = Date.UTC(2026, 10, 3, 14, 0);
    const c = checkFileTimes(scanResultOf(files(20, (i) => clean(i, { birth: undefined, ctime: copied + i * 1_000 }))), UTC);
    expect(c.status).toBe("note");
  });

  test("a window under 80% of the files, or events within 7 days, is no cluster", () => {
    const copied = Date.UTC(2026, 10, 3, 14, 0);
    const few = checkFileTimes(scanResultOf(files(20, (i) => (i < 15 ? clean(i, { birth: copied + i * 1_000 }) : clean(i)))), UTC);
    expect(few.status).toBe("pass");
    const short = checkFileTimes(scanResultOf(files(20, (i) => clean(0, { pathHash: `f${i}`, firstTs: T0 + i * HOUR, lastTs: T0 + i * HOUR + MIN,
      mtime: T0 + i * HOUR + MIN, birth: copied + i * 1_000 }))), UTC);
    expect(short.status).toBe("pass");
  });

  test("4 files are n/a", () => {
    const c = checkFileTimes(scanResultOf(files(4, (i) => clean(i, { mtime: T0 }))), UTC);
    expect([c.status, c.reason]).toEqual(["n/a", "too-few"]);
    expect(c.n).toBe(4);
  });

  test("results hold numbers and dates only", () => {
    const c = checkFileTimes(scanResultOf(files(20, (i) => (i < 3 ? clean(i, { mtime: T0 }) : clean(i)))), UTC);
    for (const v of Object.values(c.values)) expect(typeof v === "number" ? Number.isFinite(v) : /^\d{4}-\d{2}-\d{2}$/.test(v)).toBe(true);
    expect(`${c.reason}${c.askAbout ?? ""}`).toMatch(/^[ -ÿ -⁯−]*$/);
  });
});

describe("checkFileTimes (C5): bulk changes", () => {
  const moved = Date.UTC(2026, 10, 10, 8, 0);
  /** File `i` with its ctime moved to `at` (birth and mtime kept, as a date-preserving copy leaves them). */
  const migrated = (i: number, at: number): FileFactEv => clean(i, { ctime: at });

  test("a migrated history: births spread, old mtimes, every ctime in one 10-min window, is a note with that date", () => {
    const c = checkFileTimes(scanResultOf(files(20, (i) => migrated(i * 1.5, moved + i * 10_000))), UTC);
    expect([c.status, c.reason]).toEqual(["note", "bulk-change"]);
    expect(c.values.date).toBe("2026-11-10");
    expect(c.values.bulkFiles).toBe(20);
    expect(c.values.violations).toBe(0);
    expect(c.askAbout).toBe("20 trace files were last changed on 2026-11-10 although their content is older. Was this history copied, restored or migrated then?");
  });

  test("an older migration: 40 of 100 files with ctime in one window, the rest clean, is a note", () => {
    const c = checkFileTimes(scanResultOf(files(100, (i) => (i < 40 ? migrated(i * 0.3, moved + i * 5_000) : clean(i * 0.3)))), UTC);
    expect(c.status).toBe("note");
    expect(c.values.bulkFiles).toBe(40);
  });

  test("3 of 100 files with ctime long after mtime at scattered times fail", () => {
    const c = checkFileTimes(scanResultOf(files(100, (i) => (i < 3 ? migrated(i * 0.3, moved + i * DAY) : clean(i * 0.3)))), UTC);
    expect(c.status).toBe("fail");
    expect(c.values.violations).toBe(3);
  });

  test("3 of 100 files changed inside one 10-min window, under the bulk minimum of 10, fail", () => {
    const c = checkFileTimes(scanResultOf(files(100, (i) => (i < 3 ? migrated(i * 0.3, moved + i * 1_000) : clean(i * 0.3)))), UTC);
    expect(c.status).toBe("fail");
  });

  test("mtime violators still count inside a bulk window", () => {
    const c = checkFileTimes(scanResultOf(files(20, (i) => migrated(i * 1.5, moved + i * 10_000)).map((f, i) => (i < 3 ? { ...f, mtime: f.lastTs! - HOUR } : f))), UTC);
    expect(c.status).toBe("fail");
    expect(c.values.violations).toBe(3);
  });
});
