import { describe, expect, test } from "bun:test";
import type { Metric } from "../../../core/analysis/types";
import type { SessionStats } from "../../../core/analysis/walk";
import type { Window } from "../../../core/model/ids";
import { bootstrap, DEFAULT_B, DEFAULT_SEED, intervalOf, intervalRanks } from "../../../core/scoring/bootstrap";
import { DIMENSION_IDS, type DimensionId } from "../../../core/scoring/dimensions";
import { overall } from "../../../core/scoring/overall";
import { mulberry32 } from "../../../core/scoring/random";
import { loadReference } from "../../../core/scoring/reference";
import { scoreDimensions } from "../../../core/scoring/score";
import { computeSignals } from "../../../core/signals/compute";
import type { Globals } from "../../../core/signals/types";

const ref = loadReference();
const T0 = Date.UTC(2026, 8, 7, 9, 0); // a Monday
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CC = "claude-code.transcripts";
const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const stat = (id: string, over: Partial<SessionStats> = {}): SessionStats => ({
  id, tool: "claude-code", source: CC, origin: "human", start: T0, end: T0 + HOUR, scripted: false, days: [],
  turns: 0, stickySum: 0, actions: 0, successRuns: {}, gatedVae: true, editTurns: 0, editWeight: 0, verifiedWeight: 0,
  failingChecks: 0, closedChecks: 0, fixCycles: {}, episodes: 0, followUps: 0, briefs: 0, correctedBriefs: 0, briefScoreSum: 0,
  interrupts: 0, healthyInterrupts: 0, workEpisodes: 0, turnsPerWorkSum: 0, queued: 0,
  children: 0, finishedChildren: 0, bgKnown: 0, bgChildren: 0, childTypes: {}, workflowRuns: 0, maxDepth: 0,
  compactAuto: 0, compactManual: 0, freshEpisodes: 0, tierPairs: [],
  tokens: 0, tokensKnown: false, usd: 0, usdKnown: false, landed: 0,
  editEpisodes: 0, editEpisodesInRepo: 0, landedEpisodes: 0, prKeys: [], commitShaKeys: [], buckets: [], ...over,
});
const fixed = (value: number, n: number, window: Window = "detail", source = CC): Metric =>
  ({ window, sources: [source], from: T0, to: T0 + 60 * DAY, n, value });
const nullMetric = (window: Window = "detail"): Metric => ({ window, sources: [], n: 0, value: null, reason: "no-data" });
/** Globals with the fixed components Context and Orchestration need measured. */
const globals = (): Globals => ({
  parallelShare: fixed(0.2, 400), peakConcurrency: 3, headlessPerWeek: fixed(1.5, 8), guardrails: fixed(0.5, 4, "detail", "git"),
  maintainedShare: fixed(0.5, 4, "detail", "git"), artifacts: fixed(4, 6), memoryFiles: 0, switchesPerWeek: fixed(1, 8, "lifetime"),
  reworkShare: fixed(0.1, 30, "detail", "git"), prsPerWeek: fixed(1, 8, "detail", "git"), aiCoauthoredShare: nullMetric(),
  commitAfterSession: nullMetric(), repoSignals: "ok", evidence: { repos: 4, buckets: 400, artifacts: 6, lifetimeWeeks: 8, ownCommits: 30 },
});

/** A varied synthetic session: one active day each, so `n` rows span `n` days. */
const varied = (i: number): SessionStats => stat(`s${i}`, {
  start: T0 + i * DAY, end: T0 + i * DAY + HOUR, days: [dayKey(T0 + i * DAY)],
  turns: 6 + (i % 5), stickySum: 4 + (i % 7), actions: 30, successRuns: { [3 + (i % 20)]: 1, 5: 1 },
  editTurns: 2, editWeight: 4, verifiedWeight: 1 + (i % 4), failingChecks: 2, closedChecks: i % 3,
  episodes: 2, followUps: 3, briefs: 2, correctedBriefs: i % 2, briefScoreSum: 1 + (i % 3) * 0.3,
  interrupts: 1, healthyInterrupts: i % 2, workEpisodes: 2, turnsPerWorkSum: 1 + (i % 3) * 0.5,
  children: 2, finishedChildren: i % 3, bgKnown: 2, bgChildren: i % 2, compactAuto: 1, compactManual: i % 2, freshEpisodes: 1,
  tierPairs: [20 + (i % 13), i % 7, 30 + (i % 3), i % 5], tokens: 10_000 + i * 100, tokensKnown: true, landed: 1 + (i % 3),
  editEpisodes: 1, editEpisodesInRepo: 1, landedEpisodes: i % 2,
});
const rows50 = Array.from({ length: 50 }, (_, i) => varied(i));

const pointOf = (stats: readonly SessionStats[], g: Globals) => scoreDimensions(computeSignals(stats, g), ref);
const includedOf = (stats: readonly SessionStats[], g: Globals): DimensionId[] => overall(pointOf(stats, g), null).included;

describe("mulberry32", () => {
  test("is deterministic per seed, and every draw lies in [0, 1)", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const c = mulberry32(43);
    const xs = Array.from({ length: 1_000 }, () => a());
    expect(Array.from({ length: 1_000 }, () => b())).toEqual(xs);
    expect(Array.from({ length: 1_000 }, () => c())).not.toEqual(xs);
    for (const x of xs) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(1); }
    expect(new Set(xs).size).toBeGreaterThan(990);
  });
  test("treats the seed as an unsigned 32-bit integer", () => {
    expect(mulberry32(-1)()).toBe(mulberry32(0xffffffff)());
    expect(mulberry32(2 ** 32 + 5)()).toBe(mulberry32(5)());
  });
});

describe("interval ranks", () => {
  test("B = 200 reads 0-based ranks 4 and 195", () => {
    expect(intervalRanks(200)).toEqual([4, 195]);
    expect(intervalRanks(1)).toEqual([0, 0]);
    expect(intervalRanks(100)).toEqual([2, 97]);
  });
  test("intervalOf sorts the scores and reads those ranks", () => {
    const scores = Array.from({ length: 200 }, (_, i) => 1 + ((i * 37) % 99));
    const sorted = [...scores].sort((x, y) => x - y);
    expect(intervalOf(scores)).toEqual([sorted[4]!, sorted[195]!]);
  });
  test("defaults: B = 200, seed 0x5eed", () => {
    expect(DEFAULT_B).toBe(200);
    expect(DEFAULT_SEED).toBe(0x5eed);
  });
});

describe("bootstrap", () => {
  const g = globals();

  test("degenerate: a single-row sample collapses every interval to its point score", () => {
    const days = Array.from({ length: 63 }, (_, d) => dayKey(T0 + d * DAY));
    const one = stat("only", {
      end: T0 + 62 * DAY, days, turns: 300, stickySum: 400, actions: 2_000, successRuns: { 4: 10, 12: 5 },
      editTurns: 80, editWeight: 160, verifiedWeight: 90, failingChecks: 30, closedChecks: 20,
      episodes: 80, followUps: 120, briefs: 60, correctedBriefs: 10, briefScoreSum: 36, interrupts: 20, healthyInterrupts: 12,
      workEpisodes: 60, turnsPerWorkSum: 70, children: 50, finishedChildren: 30, bgKnown: 50, bgChildren: 10,
      compactAuto: 10, compactManual: 5, freshEpisodes: 40,
      tierPairs: Array.from({ length: 40 }, (_, k) => [20 + (k % 13), k % 7]).flat(), tokens: 900_000, tokensKnown: true, landed: 40,
      editEpisodes: 40, editEpisodesInRepo: 40, landedEpisodes: 25,
    });
    const point = pointOf([one], g);
    const included = includedOf([one], g);
    const r = bootstrap([one], g, ref, included, { B: 50, seed: 7 });
    const scored = point.filter((d) => d.status === "scored");
    expect(scored.length).toBeGreaterThanOrEqual(3);
    expect(Object.keys(r.intervals).sort()).toEqual(scored.map((d) => d.id).sort());
    for (const d of scored) expect(r.intervals[d.id]).toEqual([d.score!, d.score!]);
    const o = overall(point, null);
    expect(o.status).toBe("scored");
    expect(r.overall).toEqual([o.score!, o.score!]);
    expect(r.B).toBe(50);
  });

  test("seeds: the same seed twice gives equal results; B defaults to 200", () => {
    const included = includedOf(rows50, g);
    const a = bootstrap(rows50, g, ref, included, { seed: 11 });
    const b = bootstrap(rows50, g, ref, included, { seed: 11 });
    expect(b).toEqual(a);
    expect(a.B).toBe(200);
    expect(bootstrap(rows50, g, ref, included)).toEqual(bootstrap(rows50, g, ref, included, { B: 200, seed: 0x5eed }));
  });

  test("coverage: on a 50-row sample every interval holds its point score, and its bounds are display scores", () => {
    const point = pointOf(rows50, g);
    const o = overall(point, null);
    const r = bootstrap(rows50, g, ref, o.included, { B: 200, seed: 0x5eed });
    const scored = point.filter((d) => d.status === "scored");
    expect(scored.length).toBe(7);
    expect(o.status).toBe("scored");
    const check = (iv: [number, number] | null | undefined, s: number) => {
      expect(iv).toBeDefined();
      const [lo, hi] = iv!;
      for (const v of [lo, hi]) { expect(Number.isInteger(v)).toBe(true); expect(v).toBeGreaterThanOrEqual(1); expect(v).toBeLessThanOrEqual(99); }
      expect(lo).toBeLessThanOrEqual(s);
      expect(hi).toBeGreaterThanOrEqual(s);
    };
    for (const d of scored) check(r.intervals[d.id], d.score!);
    check(r.overall, o.score!);
    // resampling varies at least one dimension
    expect(scored.some((d) => r.intervals[d.id]![0] < r.intervals[d.id]![1])).toBe(true);
    // the inputs are left as they were
    expect(rows50).toEqual(Array.from({ length: 50 }, (_, i) => varied(i)));
  });

  test("replicates shrink with the point estimate's evidence ratio, not their own", () => {
    // Equal rows on distinct days: every replicate has the point's unshrunk z, but fewer distinct days (its own ratio
    // would shrink it further). With the point's ratio, every replicate's score is the point's.
    const same = Array.from({ length: 50 }, (_, i) => ({ ...varied(0), id: `e${i}`, turns: 20, start: T0 + i * DAY, end: T0 + i * DAY + HOUR, days: [dayKey(T0 + i * DAY)] }));
    const point = pointOf(same, g);
    const lev = point.find((d) => d.id === "leverage")!;
    expect([lev.status, lev.part, lev.ratio]).toEqual(["scored", "days", 5]);
    expect(lev.score).not.toBe(50);
    // a replicate holding ~32 distinct days, shrunk with its own ratio, would show a different score
    expect(pointOf(same.slice(0, 32), g).find((d) => d.id === "leverage")!.score).not.toBe(lev.score);
    const r = bootstrap(same, g, ref, [], { B: 100, seed: 3 });
    for (const d of point) if (d.status === "scored") expect(r.intervals[d.id]).toEqual([d.score!, d.score!]);
  });

  test("no interval for a dimension the point does not score; no overall interval under 3 included dimensions", () => {
    const few = rows50.slice(0, 3);
    const point = pointOf(few, g);
    const r = bootstrap(few, g, ref, overall(point, null).included, { B: 40, seed: 1 });
    for (const d of point) if (d.status !== "scored") expect(r.intervals[d.id]).toBeUndefined();
    expect(r.overall).toBeNull();
    const none = bootstrap([], g, ref, [], { B: 20, seed: 1 });
    expect(none.intervals).toEqual({});
    expect(none.overall).toBeNull();
  });

  test("an interval is null when fewer than B/2 replicates score the dimension", () => {
    // Verification without guardrails needs vae, which only row 0 carries: a 20-row resample holds it with p ≈ 0.64.
    const g2: Globals = { ...g, guardrails: nullMetric(), switchesPerWeek: nullMetric("lifetime") };
    const blank = (i: number): SessionStats => ({ ...varied(i), editTurns: 0, failingChecks: 0, closedChecks: 0, tierPairs: [], tokensKnown: false });
    const rows = Array.from({ length: 20 }, (_, i) => blank(i));
    rows[0] = { ...rows[0]!, editTurns: 200, editWeight: 400, verifiedWeight: 300 };
    // Judgment without switches needs rho (row 1 only) and cost (row 2 only) together: p ≈ 1 − 2(0.95)^20 + 0.9^20 ≈ 0.41.
    rows[1] = { ...rows[1]!, tierPairs: Array.from({ length: 60 }, (_, k) => [20 + (k % 13), k % 7]).flat() };
    rows[2] = { ...rows[2]!, tokensKnown: true, tokens: 50_000, landed: 5 };
    const point = pointOf(rows, g2);
    expect(point.find((d) => d.id === "verification")!.status).toBe("scored");
    expect(point.find((d) => d.id === "judgment")!.status).toBe("scored");
    const r = bootstrap(rows, g2, ref, [], { B: 200, seed: 5 });
    expect(r.intervals.verification).toBeDefined();
    expect(r.intervals.judgment).toBeUndefined();
  });

  test("every number is finite and the result is plain JSON", () => {
    const r = bootstrap(rows50, g, ref, includedOf(rows50, g), { B: 30, seed: 9 });
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });

  test("rejects a B that is not a positive integer", () => {
    for (const B of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => bootstrap(rows50, g, ref, [], { B, seed: 1 })).toThrow(RangeError);
  });

  test("budget: 5,000 rows x 200 replicates in under 4 s", () => {
    const rows = Array.from({ length: 5_000 }, (_, i) => varied(i % 400));
    const t0 = performance.now();
    bootstrap(rows, g, ref, [...DIMENSION_IDS], { B: 200, seed: 1 });
    expect(performance.now() - t0).toBeLessThan(4_000);
  });
});
