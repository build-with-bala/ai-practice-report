import { describe, expect, test } from "bun:test";
import { checkRollouts } from "../../../core/forensics/codex";
import type { CoverageEv, Ev, RateLimitEv, RolloutFactEv, ThreadRowEv } from "../../../core/model/events";
import { scanResultOf } from "../../kit/scanresult";

const T0 = Date.UTC(2026, 9, 1, 9, 0);
const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = T0 + 30 * DAY;

const threadsCov = (over: Partial<CoverageEv> = {}): CoverageEv => ({
  k: "coverage", tool: "codex", source: "codex.threads", window: "lifetime", status: "ok", beta: false, files: 1, bytes: 1,
  records: 10, skipped: {}, unknownTypes: {}, versions: [], ...over,
});
const rollout = (i: number, over: Partial<RolloutFactEv> = {}): RolloutFactEv => {
  const fileTs = T0 + i * HOUR;
  return { k: "codex-rollout", tool: "codex", source: "codex.rollouts", threadId: `codex:t${i}`, fileTs, uuidTs: fileTs + 400, ...over };
};
const row = (i: number): ThreadRowEv => ({ k: "codex-thread-row", tool: "codex", source: "codex.threads", threadId: `codex:t${i}` });
/** `n` rollouts, each with its thread row. */
const indexed = (n: number): Ev[] => [threadsCov(), ...Array.from({ length: n }, (_, i) => [rollout(i), row(i)]).flat()];
const run = (events: Ev[]) => checkRollouts(scanResultOf(events, { finishedAt: NOW }), { now: NOW });

describe("checkRollouts: C6, every rollout has a thread row", () => {
  test("every rollout with a row passes", () => {
    const [c6] = run(indexed(5));
    expect(c6.id).toBe("C6");
    expect([c6.status, c6.reason]).toEqual(["pass", "ok"]);
    expect(c6.n).toBe(5);
    expect(c6.tools).toEqual(["codex"]);
  });

  test("2 rollouts missing their rows fail", () => {
    const [c6] = run([...indexed(5), rollout(9), rollout(10)]);
    expect([c6.status, c6.reason]).toEqual(["fail", "missing-thread-rows"]);
    expect(c6.values).toEqual({ missing: 2, rollouts: 7 });
    expect(c6.askAbout).toBe("2 Codex session files have no entry in Codex's own thread index. Were session files copied in from somewhere else?");
  });

  test("1 rollout missing its row is a note with the same question", () => {
    const [c6] = run([...indexed(5), rollout(9)]);
    expect([c6.status, c6.reason]).toEqual(["note", "missing-thread-rows"]);
    expect(c6.values).toEqual({ missing: 1, rollouts: 6 });
    expect(c6.askAbout).toBe("1 Codex session file has no entry in Codex's own thread index. Were session files copied in from somewhere else?");
  });

  test("the fail threshold is max(2, 1% of the checked rollouts)", () => {
    /** `total` rollouts, the last `missing` of them without a row. */
    const of = (total: number, missing: number): Ev[] =>
      [threadsCov(), ...Array.from({ length: total }, (_, i) => {
        const r = rollout(i, { fileTs: T0 + i * MIN, uuidTs: T0 + i * MIN + 400 });
        return i < total - missing ? [r, row(i)] : [r];
      }).flat()];
    const status = (total: number, missing: number) => run(of(total, missing))[0].status;
    expect(status(1_000, 1)).toBe("note");
    expect(status(1_000, 9)).toBe("note");
    expect(status(1_000, 10)).toBe("fail");
    expect(status(20, 1)).toBe("note");
    expect(status(20, 2)).toBe("fail");
  });

  test("a rollout named 2 min before now is ignored", () => {
    const [c6] = run([...indexed(5), rollout(99, { fileTs: NOW - 2 * MIN, uuidTs: NOW - 2 * MIN + 300 })]);
    expect(c6.status).toBe("pass");
    expect(c6.n).toBe(5);
  });

  test("no thread store is n/a; so is an empty one, or one with no records", () => {
    const rollouts = [rollout(0), rollout(1)];
    expect(run(rollouts)[0].status).toBe("n/a");
    expect(run([threadsCov({ status: "empty", records: 0 }), ...rollouts])[0].status).toBe("n/a");
    expect(run([threadsCov({ status: "drift", records: 0 }), ...rollouts])[0].status).toBe("n/a");
    expect(run([threadsCov({ status: "error" }), ...rollouts])[0].status).toBe("n/a");
  });

  test("a drifted store with records is read", () => {
    const [c6] = run([threadsCov({ status: "drift" }), rollout(0), rollout(1)]);
    expect(c6.status).toBe("fail");
  });

  test("no rollouts is n/a", () => {
    const [c6] = run([threadsCov(), row(0)]);
    expect([c6.status, c6.reason]).toEqual(["n/a", "no-rollouts"]);
  });
});

describe("checkRollouts: C7, the id's time is not after the file name's", () => {
  test("uuidTs 1 s before fileTs passes", () => {
    const [, c7] = run([threadsCov(), rollout(0, { uuidTs: T0 - SEC, fileTs: T0 })]);
    expect(c7.id).toBe("C7");
    expect([c7.status, c7.reason]).toEqual(["pass", "ok"]);
    expect(c7.n).toBe(1);
  });

  test("within the second of the name passes; 2 s after fails", () => {
    expect(run([rollout(0, { uuidTs: T0 + 999, fileTs: T0 })])[1].status).toBe("pass");
    const [, c7] = run([rollout(0, { uuidTs: T0 + 2 * SEC, fileTs: T0 }), rollout(1)]);
    expect(c7.status).toBe("fail");
    expect(c7.values.violations).toBe(1);
    expect(c7.askAbout).toBe("1 Codex session id carries a time later than its file name, by more than a second. Were session files renamed, or their ids edited?");
  });

  test("an offset of exactly +3 h is a time-zone note", () => {
    const [, c7] = run([rollout(0, { uuidTs: T0 + 3 * HOUR, fileTs: T0 }), rollout(1)]);
    expect([c7.status, c7.reason]).toEqual(["note", "time-zone-change"]);
    expect(c7.values.zoneShifted).toBe(1);
    expect(c7.askAbout).toBeString();
  });

  test("quarter hours within 2 s and up to 14 h are zone changes; other offsets are not", () => {
    expect(run([rollout(0, { uuidTs: T0 + 5.75 * HOUR + 1_500, fileTs: T0 })])[1].status).toBe("note");
    expect(run([rollout(0, { uuidTs: T0 + 14 * HOUR, fileTs: T0 })])[1].status).toBe("note");
    expect(run([rollout(0, { uuidTs: T0 + 14.25 * HOUR, fileTs: T0 })])[1].status).toBe("fail");
    expect(run([rollout(0, { uuidTs: T0 + 3 * HOUR + 5 * SEC, fileTs: T0 })])[1].status).toBe("fail");
    expect(run([rollout(0, { uuidTs: T0 + 10 * MIN, fileTs: T0 })])[1].status).toBe("fail");
  });

  test("a violation outranks a zone change", () => {
    const [, c7] = run([rollout(0, { uuidTs: T0 + 3 * HOUR, fileTs: T0 }), rollout(1, { uuidTs: T0 + HOUR + 5 * MIN, fileTs: T0 + HOUR })]);
    expect(c7.status).toBe("fail");
    expect(c7.values).toEqual({ violations: 1, zoneShifted: 1 });
  });

  test("n/a without a rollout that has both times", () => {
    const [, c7] = run([{ k: "codex-rollout", tool: "codex", source: "codex.rollouts", threadId: "codex:x", fileTs: T0 }]);
    expect([c7.status, c7.n]).toEqual(["n/a", 0]);
  });
});

/** A snapshot of the primary window, resetting at `resetsAt`. */
const snap = (ts: number, usedPercent: number, resetsAt: number | undefined, over: Partial<RateLimitEv> = {}): RateLimitEv => {
  const e: RateLimitEv = { k: "ratelimit", tool: "codex", source: "codex.rollouts", ts, window: "primary", windowMinutes: 300, usedPercent, bucket: "b1", ...over };
  if (resetsAt !== undefined) e.resetsAt = resetsAt;
  return e;
};
/**
 * One account's ledger: 6 reset windows of 5 h, 8 rising snapshots in each (48 snapshots, 42 pairs). `jitter` moves each
 * reset time by up to a few seconds, as `resets_in_seconds` does.
 */
function ledger(start = T0, base = 0): RateLimitEv[] {
  const out: RateLimitEv[] = [];
  for (let w = 0; w < 6; w++) {
    const resets = start + (w + 1) * 5 * HOUR;
    for (let i = 0; i < 8; i++) out.push(snap(start + w * 5 * HOUR + i * 30 * MIN + 7 * MIN, base + i * 5, resets + (i % 3) * SEC));
  }
  return out;
}

describe("checkRollouts: C8, the rate-limit ledger only rises within a window", () => {
  test("a monotone ledger passes", () => {
    const [, , c8] = run(ledger());
    expect(c8.id).toBe("C8");
    expect([c8.status, c8.reason]).toEqual(["pass", "ok"]);
    expect(c8.values.pairs).toBe(42);
    expect(c8.values.contradictions).toBe(0);
    expect(c8.n).toBe(42);
  });

  test("spliced ledgers: two accounts' snapshots interleaved in one window fail, asking about more than one account", () => {
    const a = ledger(T0, 0);
    const b = ledger(T0 + 10 * MIN, 50).map((e) => ({ ...e, resetsAt: e.resetsAt! - 10 * MIN + 10 * SEC }));
    const [, , c8] = run([...a, ...b]);
    expect(c8.status).toBe("fail");
    expect(c8.reason).toBe("ledger-contradictions");
    expect(c8.values.contradictions as number).toBeGreaterThanOrEqual(3);
    expect(c8.askAbout).toContain("more than one account");
  });

  test("a drop of 2 points is no contradiction; a reset starts a new window", () => {
    const evs = ledger().map((e, i) => (i % 8 === 3 ? { ...e, usedPercent: e.usedPercent - 7 } : e));
    const [, , c8] = run(evs);
    expect(c8.values.contradictions).toBe(0);
    expect(c8.status).toBe("pass");
  });

  test("a drop of more than 2 points is a contradiction; 2 of them stay under the fail threshold", () => {
    const evs = ledger().map((e, i) => (i === 3 || i === 11 ? { ...e, usedPercent: e.usedPercent - 8 } : e));
    const [, , c8] = run(evs);
    expect(c8.values.contradictions).toBe(2);
    expect(c8.status).toBe("pass");
    const three = ledger().map((e, i) => (i === 3 || i === 11 || i === 19 ? { ...e, usedPercent: e.usedPercent - 8 } : e));
    expect(run(three)[2].status).toBe("fail");
  });

  test("3 contradictions among 1,050 pairs are within 0.5% and pass", () => {
    const evs: RateLimitEv[] = [];
    for (let k = 0; k < 25; k++) evs.push(...ledger(T0 + k * 30 * HOUR));
    const marked = evs.map((e, i) => (i === 3 || i === 11 || i === 19 ? { ...e, usedPercent: e.usedPercent - 8 } : e));
    const [, , c8] = run(marked);
    expect(c8.values.pairs).toBe(1_050);
    expect(c8.values.contradictions).toBe(3);
    expect(c8.status).toBe("pass");
  });

  test("buckets and windows are separate ledgers", () => {
    const other = ledger(T0, 60).map((e) => ({ ...e, bucket: "b2" }));
    const secondary = ledger(T0, 40).map((e) => ({ ...e, window: "secondary" as const }));
    const [, , c8] = run([...ledger(), ...other, ...secondary]);
    expect(c8.status).toBe("pass");
    expect(c8.values.pairs).toBe(126);
  });

  test("without resetsAt, snapshots of the same windowMinutes less than a window apart pair", () => {
    const evs = ledger().map((e) => ({ ...e, resetsAt: undefined }));
    for (const e of evs) delete e.resetsAt;
    const [, , c8] = run(evs);
    // consecutive snapshots are 30 min apart, and 90 min apart at a window's turn: all 47 consecutive pairs pair
    expect(c8.values.pairs).toBe(47);
    // each window's first snapshot is lower than the last of the window before: 5 contradictions
    expect(c8.values.contradictions).toBe(5);
    const noMinutes = evs.map((e) => ({ ...e, windowMinutes: undefined }));
    expect(run(noMinutes)[2].values.pairs ?? 0).toBe(0);
  });

  test("10 pairs are n/a", () => {
    const [, , c8] = run(Array.from({ length: 11 }, (_, i) => snap(T0 + i * 10 * MIN, i, T0 + 5 * HOUR)));
    expect([c8.status, c8.reason]).toEqual(["n/a", "too-few"]);
    expect(c8.n).toBe(10);
  });

  test("results hold numbers only, and texts stay within the covered characters", () => {
    const a = ledger(T0, 0);
    const b = ledger(T0 + 10 * MIN, 50);
    const results = [...run([...a, ...b, rollout(0, { uuidTs: T0 + 3 * SEC, fileTs: T0 }), threadsCov()]),
      ...run([rollout(0, { uuidTs: T0 + 3 * HOUR, fileTs: T0 })])];
    for (const c of results) {
      for (const v of Object.values(c.values)) expect(typeof v === "number" && Number.isFinite(v)).toBe(true);
      expect(`${c.reason}${c.askAbout ?? ""}`).toMatch(/^[ -ÿ -⁯−]*$/);
    }
  });
});
