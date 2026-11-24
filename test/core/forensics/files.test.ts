import { describe, expect, test } from "bun:test";
import { checkFileTimes } from "../../../core/forensics/files";
import type { FileFactEv } from "../../../core/model/events";
import type { ScanResult } from "../../../core/scan";
import { scanResultOf } from "../../kit/scanresult";
import { asks, tableOf } from "./table";

const fileTimesOf = (raw: ScanResult, o: { timeZone: string }) => asks(checkFileTimes(raw, tableOf(raw), o));

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
    const c = fileTimesOf(scanResultOf(files(20)), UTC);
    expect(c.id).toBe("C5");
    expect(c.status).toBe("pass");
    expect(c.n).toBe(20);
    expect(c.values.violations).toBe(0);
    expect(c.tools).toEqual(["claude-code"]);
    expect(c.askAbout).toBeUndefined();
  });

  test("3 files with mtime before their last event fail", () => {
    const c = fileTimesOf(scanResultOf(files(20, (i) => (i < 3 ? clean(i, { mtime: T0 + i * DAY + 10 * MIN }) : clean(i)))), UTC);
    expect(c.status).toBe("fail");
    expect(c.values.violations).toBe(3);
    expect(c.askAbout).toContain("3 ");
  });

  test("an mtime within 2 s before the last event is no violation", () => {
    const c = fileTimesOf(scanResultOf(files(20, (i) => clean(i, { mtime: T0 + i * DAY + HOUR - 1_500 }))), UTC);
    expect(c.status).toBe("pass");
  });

  test("a single violation is below the threshold of 2", () => {
    const c = fileTimesOf(scanResultOf(files(20, (i) => (i === 0 ? clean(i, { mtime: T0 }) : clean(i)))), UTC);
    expect(c.status).toBe("pass");
    expect(c.values.violations).toBe(1);
  });

  test("ctime more than 24 h after mtime is no violation: at most a note, with the files and the largest window", () => {
    const c = fileTimesOf(scanResultOf(files(20, (i) => (i < 2 ? clean(i, { ctime: T0 + i * DAY + 30 * HOUR }) : clean(i)))), UTC);
    expect([c.status, c.reason]).toEqual(["note", "changed-after-write"]);
    expect(c.values).toEqual({ violations: 0, changedFiles: 2, bulkFiles: 1 });
    expect(c.askAbout).toBe("2 trace files were changed more than a day after their last write, up to 1 of them within ten minutes. "
      + "Were they moved, archived, synced, restored, or their permissions changed?");
  });

  test("a file whose last event is at or after the scan's start is still being written: no violation", () => {
    const raw = scanResultOf(files(20, (i) => (i >= 17 ? clean(i, { mtime: T0 + i * DAY }) : clean(i))));
    const start = T0 + 17 * DAY + HOUR;   // files 17 to 19 hold an event at or after the start
    const end = T0 + 40 * DAY;
    expect(fileTimesOf({ ...raw, startedAt: start, finishedAt: end }, UTC).values.violations).toBe(0);
    expect(fileTimesOf({ ...raw, startedAt: start + DAY, finishedAt: end }, UTC).values.violations).toBe(1);
    expect(fileTimesOf({ ...raw, startedAt: end, finishedAt: end }, UTC).status).toBe("fail");
  });

  test("a last event dated after the scan's end is not exempt", () => {
    const raw = scanResultOf(files(20, (i) => (i >= 17 ? clean(i, { mtime: T0 + i * DAY }) : clean(i))));
    const start = T0 + 17 * DAY + HOUR;
    expect(fileTimesOf({ ...raw, startedAt: start, finishedAt: start + 2 * DAY }, UTC).values.violations).toBe(0);
    expect(fileTimesOf({ ...raw, startedAt: start, finishedAt: start }, UTC).values.violations).toBe(2); // files 18 and 19 end after it
  });

  test("copied directory: 20 files born in one 10-min window, 30 days of events, are a note with that date", () => {
    const copied = Date.UTC(2026, 10, 3, 14, 0);
    const c = fileTimesOf(scanResultOf(files(20, (i) => {
      const firstTs = T0 + Math.floor((i * 30 * DAY) / 19);
      return clean(0, { pathHash: `f${i}`, firstTs, lastTs: firstTs + HOUR, mtime: firstTs + HOUR + 1_000, birth: copied + i * 20_000, ctime: copied + i * 20_000 });
    })), UTC);
    expect(c.status).toBe("note");
    expect(c.values.date).toBe("2026-11-03");
    expect(c.values.days).toBe(31); // 30 days and 1 hour, rounded up: the rule is "spanning more than 7 days"
    expect(c.values.violations).toBe(0); // ctime far after mtime is no violation inside the cluster
    expect(c.askAbout).toBe("Most trace files were created on 2026-11-03 although their activity spans 31 days. Was this history copied or restored from a backup then?");
  });

  test("the cluster's date is the local day in the given zone", () => {
    const copied = Date.UTC(2026, 10, 3, 14, 0); // 04 Nov in Auckland
    const c = fileTimesOf(scanResultOf(files(20, (i) => clean(i, { birth: copied + i * 1_000, ctime: copied + i * 1_000 }))), { timeZone: "Pacific/Auckland" });
    expect(c.values.date).toBe("2026-11-04");
  });

  test("without birth times the ctime places the births", () => {
    const copied = Date.UTC(2026, 10, 3, 14, 0);
    const c = fileTimesOf(scanResultOf(files(20, (i) => clean(i, { birth: undefined, ctime: copied + i * 1_000 }))), UTC);
    expect(c.status).toBe("note");
  });

  test("a window under 80% of the files, or events within 7 days, is no cluster", () => {
    const copied = Date.UTC(2026, 10, 3, 14, 0);
    const few = fileTimesOf(scanResultOf(files(20, (i) => (i < 15 ? clean(i, { birth: copied + i * 1_000 }) : clean(i)))), UTC);
    expect(few.status).toBe("pass");
    const short = fileTimesOf(scanResultOf(files(20, (i) => clean(0, { pathHash: `f${i}`, firstTs: T0 + i * HOUR, lastTs: T0 + i * HOUR + MIN,
      mtime: T0 + i * HOUR + MIN, birth: copied + i * 1_000 }))), UTC);
    expect(short.status).toBe("pass");
  });

  test("4 files are n/a", () => {
    const c = fileTimesOf(scanResultOf(files(4, (i) => clean(i, { mtime: T0 }))), UTC);
    expect([c.status, c.reason]).toEqual(["n/a", "too-few"]);
    expect(c.n).toBe(4);
  });

  test("results hold numbers and dates only", () => {
    const c = fileTimesOf(scanResultOf(files(20, (i) => (i < 3 ? clean(i, { mtime: T0 }) : clean(i)))), UTC);
    for (const v of Object.values(c.values)) expect(typeof v === "number" ? Number.isFinite(v) : /^\d{4}-\d{2}-\d{2}$/.test(v)).toBe(true);
    expect(`${c.reason}${c.askAbout ?? ""}`).toMatch(/^[ -ÿ -⁯−]*$/);
  });
});

describe("checkFileTimes (C5): a change time after the last write is never a fail", () => {
  const moved = Date.UTC(2026, 10, 10, 8, 0);
  /** File `i` with its ctime moved to `at` (birth and mtime kept, as a date-preserving copy leaves them). */
  const migrated = (i: number, at: number): FileFactEv => clean(i, { ctime: at });

  test("a migrated history: births spread, old mtimes, every ctime in one 10-min window, is a note", () => {
    const c = fileTimesOf(scanResultOf(files(20, (i) => migrated(i * 1.5, moved + i * 10_000))), UTC);
    expect([c.status, c.reason]).toEqual(["note", "changed-after-write"]);
    expect(c.values).toEqual({ violations: 0, changedFiles: 20, bulkFiles: 20 });
  });

  test("files changed after their last write at scattered times are a note, not a fail", () => {
    const c = fileTimesOf(scanResultOf(files(100, (i) => (i < 3 ? migrated(i * 0.3, moved + i * DAY) : clean(i * 0.3)))), UTC);
    expect([c.status, c.reason]).toEqual(["note", "changed-after-write"]);
    expect([c.values.changedFiles, c.values.bulkFiles, c.values.violations]).toEqual([3, 1, 0]);
  });

  test("files with an event after their last write still fail inside a batch of changed files", () => {
    const c = fileTimesOf(scanResultOf(files(20, (i) => migrated(i * 1.5, moved + i * 10_000)).map((f, i) => (i < 3 ? { ...f, mtime: f.lastTs! - HOUR } : f))), UTC);
    expect([c.status, c.reason]).toEqual(["fail", "file-times"]);
    expect(c.values.violations).toBe(3);
  });

  test("the last-write rule fails at max(2, 1% of the files)", () => {
    const late = (n: number, bad: number) => files(n, (i) => (i < bad ? clean(i * 0.1, { mtime: T0 + i * 0.1 * DAY }) : clean(i * 0.1)));
    expect(fileTimesOf(scanResultOf(late(300, 2)), UTC).status).toBe("pass");
    expect(fileTimesOf(scanResultOf(late(300, 3)), UTC).status).toBe("fail");
    expect(fileTimesOf(scanResultOf(late(20, 2)), UTC).status).toBe("fail");
  });

  describe("honest histories read a note at most", () => {
    const T = Date.UTC(2025, 10, 1, 8);
    let seq = 0;
    const file = (firstTs: number, over: Partial<FileFactEv> = {}, tool: "claude-code" | "codex" = "claude-code"): FileFactEv => ({
      k: "file", tool, source: tool === "claude-code" ? "claude-code.transcripts" : "codex.rollouts", pathHash: `h${++seq}`, bytes: 1, birth: firstTs,
      firstTs, lastTs: firstTs + HOUR, mtime: firstTs + HOUR + 1_000, ctime: firstTs + HOUR + 1_000, ...over,
    });
    const cleanRun = (n: number, from: number, step = 3 * HOUR) => Array.from({ length: n }, (_, i) => file(from + i * step));
    const cases: [string, () => FileFactEv[]][] = [
      ["4 Codex rollouts archived days after their last write, on different days", () => [...cleanRun(296, T),
        ...[40, 80, 120, 160].map((d) => file(T + d * DAY, { ctime: T + d * DAY + (3 + (d % 5)) * DAY }, "codex"))]],
      ["300 files migrated in one window a year ago, then 4,000 newer files", () => {
        const at = T + 30 * DAY;
        return [...Array.from({ length: 300 }, (_, i) => file(T - 200 * DAY + i * 12 * HOUR, { ctime: at + i * 1_000 })), ...cleanRun(4_000, at + DAY, 2 * HOUR)];
      }],
      ["one migration of two folders copied 20 minutes apart (950 and 50 files)", () => {
        const at = T + 30 * DAY;
        return [...Array.from({ length: 950 }, (_, i) => file(T - 300 * DAY + i * 6 * HOUR, { ctime: at + Math.floor(i * 500) })),
          ...Array.from({ length: 50 }, (_, i) => file(T - 300 * DAY + i * 5 * DAY, { ctime: at + 20 * MIN + i * 1_000 }, "codex"))];
      }],
      ["a restore spread over 3 hours", () => Array.from({ length: 1_000 }, (_, i) => file(T - 300 * DAY + i * 6 * HOUR, { ctime: T + 30 * DAY + Math.floor(i * 10_800) }))],
      ["sessions pulled weekly from a second machine", () => {
        const pulled: FileFactEv[] = [];
        for (let w = 0; w < 20; w++) {
          for (let i = 0; i < 15; i++) pulled.push(file(T + w * 7 * DAY + i * 8 * HOUR, { birth: T + (w + 1) * 7 * DAY + i * 1_000, ctime: T + (w + 1) * 7 * DAY + i * 1_000 }));
        }
        return [...cleanRun(1_200, T), ...pulled];
      }],
      ["2 of 150 files touched by chmod or an xattr a week later", () => {
        const all = cleanRun(150, T);
        all[10] = { ...all[10]!, ctime: all[10]!.mtime + 7 * DAY };
        all[90] = { ...all[90]!, ctime: all[90]!.mtime + 9 * DAY };
        return all;
      }],
    ];
    for (const [name, make] of cases) {
      test(name, () => {
        const c = fileTimesOf(scanResultOf(make()), UTC);
        expect([name, c.status === "pass" || c.status === "note"]).toEqual([name, true]);
        expect(c.values.violations).toBe(0);
      });
    }
  });
});
