import { describe, expect, test } from "bun:test";
import type { Metric } from "../../../core/analysis/types";
import type { Window } from "../../../core/model/ids";
import { COMPONENTS, type MetricKey, Z_LIMIT } from "../../../core/scoring/components";
import { loadReference, type ReferenceEntry } from "../../../core/scoring/reference";
import { displayScore, scoreDimensions, type DimensionResult } from "../../../core/scoring/score";
import type { Evidence, Signals } from "../../../core/signals/types";

const ref = loadReference();
const N = 1_000;
const T0 = Date.UTC(2026, 9, 1);
const DAY = 86_400_000;

/** The raw signal value whose oriented, transformed value is `x` (the inverse of transform + negation, for rates at n = N). */
function rawAt(e: ReferenceEntry, negate: boolean, x: number): number {
  const y = negate ? -x : x;
  switch (e.transform) {
    case "identity": return y;
    case "log1p": return Math.expm1(y);
    case "atanh": return Math.tanh(y);
    case "logit": { const p = 1 / (1 + Math.exp(-y)); return (p * (N + 1) - 0.5) / N; }
  }
}
const metric = (value: number | null, o: { n?: number; window?: Window; source?: string; reason?: Metric["reason"]; day?: number } = {}): Metric => {
  const m: Metric = { window: o.window ?? "detail", sources: [o.source ?? "claude-code.transcripts"], from: T0 + (o.day ?? 0) * DAY,
    to: T0 + ((o.day ?? 0) + 30) * DAY, n: o.n ?? N, value };
  if (value === null) m.reason = o.reason ?? "no-data";
  return m;
};
/** Evidence at `k` times every minimum, with `weeks` distinct weeks. */
const evidence = (k: number, weeks: number, over: Partial<Evidence> = {}): Evidence => ({
  typedTurns: 60 * k, sessions: 5 * k, days: 14 * k, weeks, episodes: 20 * k, editTurns: 20 * k, followUps: 30 * k, briefs: 0,
  failingChecks: 0, interrupts: 0, workEpisodes: 0, tierEpisodes: 30 * k, editEpisodesInRepo: 10 * k, landed: 0, repos: 3 * k,
  buckets: 0, bgKnown: 0, artifacts: 0, lifetimeWeeks: weeks, ownCommits: 0, ...over,
});
const empty = (): Metric => metric(null, { n: 0 });

/** Signals with every scored component at quantile `at` of the reference ("p50" or "p90"); other fields empty. */
function signalsAt(at: "p50" | "p90", over: Partial<Signals> = {}): Signals {
  const s: Signals = {
    vae: empty(), closure: empty(), medianFixCycles: null, stickyMean: empty(), p90Run: empty(), actionsPerTurn: empty(),
    parallelShare: empty(), peakConcurrency: 0, backgroundShare: empty(), fanoutPerEpisode: empty(),
    childTypes: { explore: 0, plan: 0, review: 0, implement: 0, custom: 0, other: 0 }, workflowRunsPerEpisode: empty(), maxDepth: 0,
    correctionRate: empty(), healthyInterruptShare: empty(), turnsPerWork: empty(), queuePerTurn: empty(),
    maintainedShare: empty(), artifacts: empty(), memoryFiles: 0, briefScore: empty(), hygiene: empty(),
    switchesPerWeek: empty(), rho: empty(), tokensPerLanded: empty(), usdPerLanded: empty(),
    landedShare: empty(), reworkShare: empty(), prsPerWeek: empty(), aiCoauthoredShare: empty(), commitAfterSession: empty(),
    guardrails: empty(), headlessPerWeek: empty(), uncheckedCommandShare: empty(), evidence: evidence(10, 6), repoSignals: "ok",
  };
  COMPONENTS.forEach((c, i) => {
    const e = ref.components[c.id]!;
    const git = c.repo ? { source: "git" } : {};
    s[c.signal] = metric(rawAt(e, c.negate, e[at]), { ...git, day: i });
  });
  return { ...s, ...over };
}
const dim = (ds: DimensionResult[], id: DimensionResult["id"]): DimensionResult => ds.find((d) => d.id === id)!;
const finiteDeep = (v: unknown): boolean =>
  typeof v === "number" ? Number.isFinite(v) : Array.isArray(v) ? v.every(finiteDeep)
    : v !== null && typeof v === "object" ? Object.values(v).every(finiteDeep) : true;

describe("scoreDimensions at the anchors", () => {
  test("every signal at its p50, with 10x the evidence over 6 weeks: every dimension scores 50, high", () => {
    const ds = scoreDimensions(signalsAt("p50"), ref);
    expect(ds.map((d) => d.id)).toEqual(["leverage", "orchestration", "verification", "steering", "context", "judgment", "delivery"]);
    for (const d of ds) {
      expect(d.status).toBe("scored");
      expect(d.z!).toBeCloseTo(0, 9);
      expect(d.score).toBe(50);
      expect(d.confidence).toBe("high");
      expect(d.ratio).toBe(10);
      expect(d.weeks).toBe(6);
      expect(d.openTail).toBe(false);
      expect(d.interval).toBeNull();
      for (const c of d.components) { expect(c.status).toBe("ok"); expect(c.z!).toBeCloseTo(0, 6); }
    }
    expect(ds.flatMap((d) => d.components).map((c) => c.id)).toEqual(COMPONENTS.map((c) => c.id));
  });
  test("every signal at its p90: each score is 88 (z = 1.2816, shrunk by 10/11)", () => {
    for (const d of scoreDimensions(signalsAt("p90"), ref)) {
      expect(d.score).toBe(88);
      expect(d.z!).toBeCloseTo(1.2816 * 10 / 11, 6);
      expect(d.zRaw!).toBeCloseTo(1.2816, 6);
      for (const c of d.components) expect(c.z!).toBeCloseTo(1.2816, 6);
    }
  });
  test("lower-is-better components are negated: a higher correction rate lowers Steering", () => {
    const base = signalsAt("p50");
    const worse = { ...base, correctionRate: metric(0.5) };
    const c = dim(scoreDimensions(worse, ref), "steering").components.find((x) => x.id === "ste.correction")!;
    expect(c.x!).toBeCloseTo(-Math.log((0.5 * N + 0.5) / (N + 1) / (1 - (0.5 * N + 0.5) / (N + 1))), 9);
    expect(c.z!).toBeLessThan(0);
    expect(c.raw).toBe(0.5);
  });
  test("a component carries its signal's n and metadata; a dimension spans its measured components, in the detail window", () => {
    const d = dim(scoreDimensions(signalsAt("p50"), ref), "context");
    const art = d.components.find((c) => c.id === "ctx.artifacts")!;
    expect(art.n).toBe(N);
    expect(art.meta).toEqual({ window: "detail", sources: ["claude-code.transcripts"], from: T0 + 12 * DAY, to: T0 + 42 * DAY, n: N }); // ctx.artifacts is component 12
    expect(d.meta).toEqual({ window: "detail", sources: ["claude-code.transcripts", "git"], from: T0 + 11 * DAY, to: T0 + 44 * DAY, n: 200 });
  });
  test("displayScore is open-tailed: 99 at most, with the mark whenever it shows 99", () => {
    expect(displayScore(2.4)).toEqual({ score: 99, openTail: true });
    expect(displayScore(2.2)).toEqual({ score: 99, openTail: true });
    expect(displayScore(2.0)).toEqual({ score: 98, openTail: false });
    expect(displayScore(0)).toEqual({ score: 50, openTail: false });
    expect(displayScore(-5)).toEqual({ score: 1, openTail: false });
    expect(displayScore(40)).toEqual({ score: 99, openTail: true });
  });
});

describe("repo signals off", () => {
  const off = (status: Signals["repoSignals"]): Signals => {
    const r = (): Metric => metric(null, { n: 0, source: "git", reason: "repo-signals-off" });
    return signalsAt("p90", { repoSignals: status, guardrails: r(), maintainedShare: r(), landedShare: r(), reworkShare: r(), prsPerWeek: r() });
  };
  test("Verification scores from vae and closure, with weights 0.625 and 0.375", () => {
    const d = dim(scoreDimensions(off("off"), ref), "verification");
    expect(d.status).toBe("scored");
    const w = Object.fromEntries(d.components.map((c) => [c.id, c.weight]));
    expect(w["ver.vae"]).toBeCloseTo(0.625, 12);
    expect(w["ver.closure"]).toBeCloseTo(0.375, 12);
    expect(w["ver.guardrails"]).toBe(0);
    expect(d.components.find((c) => c.id === "ver.guardrails")!.status).toBe("not-measured");
    expect(d.score).toBe(88);
  });
  test("Delivery is not-measured, off or git-missing, even when its metrics hold values", () => {
    for (const status of ["off", "git-missing"] as const) {
      const d = dim(scoreDimensions(off(status), ref), "delivery");
      expect(d.status).toBe("not-measured");
      expect(d.z).toBeNull();
      expect(d.score).toBeNull();
      expect(d.confidence).toBeNull();
      expect(d.components.every((c) => c.status === "not-measured")).toBe(true);
      const kept = dim(scoreDimensions(signalsAt("p50", { repoSignals: status }), ref), "delivery");
      expect(kept.status).toBe("not-measured");
    }
  });
  test("Context drops only its repo component", () => {
    const d = dim(scoreDimensions(off("off"), ref), "context");
    expect(d.status).toBe("scored");
    expect(d.components.find((c) => c.id === "ctx.instructions")!.status).toBe("not-measured");
  });
  test("partial repo signals still score Delivery", () => {
    expect(dim(scoreDimensions(signalsAt("p50", { repoSignals: "partial" }), ref), "delivery").status).toBe("scored");
  });
});

describe("missing data (builder's call 3)", () => {
  test("a null signal is not-measurable and its weight spreads over the measured components", () => {
    const d = dim(scoreDimensions(signalsAt("p90", { rho: metric(null, { reason: "degenerate", n: 40 }) }), ref), "judgment");
    expect(d.status).toBe("scored");
    const rho = d.components.find((c) => c.id === "jud.rho")!;
    expect(rho).toMatchObject({ status: "not-measurable", raw: null, x: null, z: null, weight: 0, n: 40 });
    expect(d.components.find((c) => c.id === "jud.switches")!.weight).toBeCloseTo(0.4 / 0.6, 12);
    expect(d.score).toBe(88);
  });
  test("below half the weight measured, a dimension is not-measurable", () => {
    const d = dim(scoreDimensions(signalsAt("p50", { stickyMean: empty() }), ref), "leverage");
    expect(d.status).toBe("not-measurable");
    expect(d.z).toBeNull();
    expect(d.zRaw).toBeNull();
    expect(d.score).toBeNull();
    expect(d.components.map((c) => c.status)).toEqual(["not-measurable", "ok"]);
    expect(d.components.map((c) => c.weight)).toEqual([0, 0]); // weights only when scored or insufficient (R4)
  });
  test("it is not-measured instead when repo signals would have made up the weight", () => {
    const r = metric(null, { n: 0, source: "git", reason: "repo-signals-off" });
    const d = dim(scoreDimensions(signalsAt("p50", { repoSignals: "off", maintainedShare: r, artifacts: empty() }), ref), "context");
    expect(d.status).toBe("not-measured");
    const gone = dim(scoreDimensions(signalsAt("p50", { repoSignals: "off", maintainedShare: r, artifacts: empty(), hygiene: empty(), briefScore: empty() }), ref), "context");
    expect(gone.status).toBe("not-measurable");
  });
  test("exactly half the weight measured still scores", () => {
    const d = dim(scoreDimensions(signalsAt("p50", { fanoutPerEpisode: empty(), headlessPerWeek: empty() }), ref), "orchestration");
    expect(d.status).toBe("scored");
  });
});

describe("evidence, confidence and shrinkage", () => {
  test("Leverage with 59 turns is insufficient, with the binding part's n and needs", () => {
    const d = dim(scoreDimensions(signalsAt("p90", { evidence: evidence(10, 6, { typedTurns: 59 }) }), ref), "leverage");
    expect(d).toMatchObject({ status: "insufficient", part: "typedTurns", n: 59, needs: 60, z: null, score: null, confidence: null });
    expect(d.zRaw!).toBeCloseTo(1.2816, 6); // the unshrunk mean is kept, and the components keep their weights
    expect(d.components.map((c) => c.weight)).toEqual([0.6, 0.4]);
    expect(d.ratio).toBeCloseTo(59 / 60, 12);
    expect(d.components.every((c) => c.status === "ok")).toBe(true);
  });
  test("Context with 3 repos and 5 episodes: ratio 1, low", () => {
    const d = dim(scoreDimensions(signalsAt("p90", { evidence: evidence(10, 6, { repos: 3, episodes: 5 }) }), ref), "context");
    expect(d).toMatchObject({ status: "scored", part: "repos", n: 3, needs: 3, ratio: 1, confidence: "low" });
    expect(d.z!).toBeCloseTo(1.2816 / 2, 6);
  });
  test("confidence needs both the ratio and the weeks", () => {
    const conf = (k: number, weeks: number) => dim(scoreDimensions(signalsAt("p50", { evidence: evidence(k, weeks) }), ref), "verification");
    expect(conf(10, 5).confidence).toBe("medium");
    expect(conf(9.9, 6).confidence).toBe("medium");
    expect(conf(3, 3).confidence).toBe("medium");
    expect(conf(3, 2).confidence).toBe("low");
    expect(conf(2.9, 6).confidence).toBe("low");
    expect(conf(1, 1).confidence).toBe("low");
    expect(conf(1, 0)).toMatchObject({ status: "insufficient", confidence: null });
    expect(conf(0.5, 6)).toMatchObject({ status: "insufficient", n: 10, needs: 20 });
  });
  test("the smallest 'and' part binds", () => {
    const d = dim(scoreDimensions(signalsAt("p50", { evidence: evidence(10, 6, { sessions: 15, days: 30 }) }), ref), "leverage");
    expect(d).toMatchObject({ part: "sessions", n: 15, needs: 5, ratio: 3, confidence: "medium" });
  });
  test("when the ratio is met but no week is, the weeks bind (R2)", () => {
    const d = dim(scoreDimensions(signalsAt("p50", { evidence: evidence(10, 0, { repos: 5, episodes: 0 }) }), ref), "context");
    expect(d).toMatchObject({ status: "insufficient", part: "weeks", n: 0, needs: 1, ratio: 0, confidence: null, z: null });
    expect(d.meta.n).toBe(0);
  });
  test("every dimension names its binding part", () => {
    const parts = scoreDimensions(signalsAt("p50"), ref).map((d) => d.part);
    expect(parts).toEqual(["typedTurns", "days", "editTurns", "followUps", "episodes", "tierEpisodes", "editEpisodesInRepo"]);
  });
});

describe("degenerate input (Review Focus 2)", () => {
  test("rates at 0 with n 10,000, counts at 0, rho degenerate: real, finite values, rho not-measurable", () => {
    const s = signalsAt("p50");
    for (const c of COMPONENTS) {
      const e = ref.components[c.id]!;
      // rho with a constant side is null and degenerate (Task 6); every other signal is a measured 0.
      s[c.signal] = e.transform === "atanh" ? metric(null, { n: 10_000, reason: "degenerate" }) : metric(0, { n: 10_000 });
    }
    const ds = scoreDimensions(s, ref);
    expect(finiteDeep(ds)).toBe(true);
    expect(JSON.stringify(ds)).not.toMatch(/NaN|Infinity/);
    const logit02 = Math.log(0.02 / 0.98);
    const comp = (id: string) => ds.flatMap((d) => d.components).find((c) => c.id === id)!;
    expect(comp("ver.vae").x!).toBeCloseTo(logit02, 12); // (0·n + 0.5)/(n + 1) clamps to 0.02
    expect(comp("del.rework").x!).toBeCloseTo(-logit02, 12); // lower is better: a zero rework rate is the best
    expect(comp("lev.run").x).toBe(0); // log1p(0)
    expect(comp("lev.sticky").x).toBe(0); // identity
    expect(comp("jud.cost").x).toBe(0);
    expect(comp("jud.rho")).toMatchObject({ status: "not-measurable", raw: null, x: null, z: null, weight: 0, n: 10_000 });
    const e = ref.components["ver.vae"]!;
    expect(comp("ver.vae").z!).toBeCloseTo((logit02 - e.p50) / ((e.p90 - e.p50) / 1.2816), 12);
    for (const d of ds) expect(d.status).toBe("scored"); // Judgment scores on switches and cost (0.6 of its weight)
    const j = dim(ds, "judgment");
    const zs = j.components.filter((c) => c.status === "ok");
    expect(j.zRaw!).toBeCloseTo(zs.reduce((a, c) => a + c.weight * c.z!, 0), 12);
    expect(j.z!).toBeCloseTo(j.zRaw! * 10 / 11, 12);
  });
  test("with the corrected-brief rate not captured, Steering is scored from the interrupts alone", () => {
    const s = signalsAt("p90", { correctionRate: metric(null, { n: 300, reason: "not-captured" }) });
    const st = dim(scoreDimensions(s, ref), "steering");
    expect(st.status).toBe("scored");
    expect(st.components.map((c) => [c.id, c.status, c.weight])).toEqual([["ste.correction", "not-measurable", 0], ["ste.interrupts", "ok", 1]]);
  });
  test("one signal cannot set a whole dimension: a component's z is limited to [-3, 3]", () => {
    const e = ref.components["lev.sticky"]!;
    const at = (zWanted: number) => dim(scoreDimensions(signalsAt("p50", { stickyMean: metric(e.p50 + zWanted * (e.p90 - e.p50) / 1.2816) }), ref), "leverage");
    expect(at(2.5).components[0]!.z).toBeCloseTo(2.5, 9);
    expect(at(5).components[0]!.z).toBe(3);
    expect(at(-5).components[0]!.z).toBe(-3);
    expect(Z_LIMIT).toBe(3);
  });
  test("overflowing inputs stay finite (R1): component z is limited to [-3, 3] and shrinkage cannot overflow", () => {
    const hi = dim(scoreDimensions(signalsAt("p50", { stickyMean: metric(1e308) }), ref), "leverage");
    expect(hi.components[0]!.z).toBe(3);
    expect(hi.status).toBe("scored");
    expect(Number.isFinite(hi.z!)).toBe(true);
    const lo = dim(scoreDimensions(signalsAt("p50", { stickyMean: metric(-1e308) }), ref), "leverage");
    expect(lo.components[0]!.z).toBe(-3);
    expect(lo.score).toBe(5);
    const big = 1e300;
    const ev = evidence(1, 6, { typedTurns: big, sessions: big, days: big, episodes: big, editTurns: big, followUps: big,
      tierEpisodes: big, editEpisodesInRepo: big, repos: big });
    const ds = [hi, lo, ...scoreDimensions(signalsAt("p90", { evidence: ev, stickyMean: metric(1e308) }), ref)];
    expect(finiteDeep(ds)).toBe(true);
    expect(JSON.stringify(ds)).not.toMatch(/NaN|Infinity/);
    for (const d of ds.slice(2)) expect(d.status).toBe("scored");
  });
  test("an empty home: every dimension not-measurable, with n and needs, and nothing non-finite", () => {
    const s = signalsAt("p50", { evidence: evidence(0, 0) });
    for (const c of COMPONENTS) s[c.signal as MetricKey] = empty();
    const ds = scoreDimensions(s, ref);
    for (const d of ds) {
      expect(d.status).toBe("not-measurable");
      expect(d.n).toBe(0);
      expect(d.needs).toBeGreaterThan(0);
      expect(d.ratio).toBe(0);
      expect(d.meta).toEqual({ window: "detail", sources: [], n: 0 });
    }
    expect(finiteDeep(ds)).toBe(true);
  });
});
