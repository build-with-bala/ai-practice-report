import { describe, expect, test } from "bun:test";
import { buildSessionTable } from "../../../core/analysis/sessions";
import { buildSessionStats } from "../../../core/analysis/walk";
import type { Ev } from "../../../core/model/events";
import type { ScanResult } from "../../../core/scan";
import { bootstrap } from "../../../core/scoring/bootstrap";
import type { DimensionId } from "../../../core/scoring/dimensions";
import { overall, type Overall } from "../../../core/scoring/overall";
import { loadReference } from "../../../core/scoring/reference";
import { scoreDimensions, type DimensionResult } from "../../../core/scoring/score";
import { computeSignals } from "../../../core/signals/compute";
import { computeGlobals } from "../../../core/signals/globals";
import type { Signals } from "../../../core/signals/types";
import { personaScan } from "../../fixtures/personas";
import { CANARY, findCanaries } from "../../kit/canary";
import { scanResultOf } from "../../kit/scanresult";

type Kind = "novice" | "intermediate" | "expert";
const KINDS: readonly Kind[] = ["novice", "intermediate", "expert"];
interface Scored { signals: Signals; dims: DimensionResult[]; overall: Overall }

/** The pipeline by hand (no `analyze()` yet): session table → walk → globals and signals → dimensions → bootstrap → overall. */
function score(raw: ScanResult, timeZone = "UTC"): Scored {
  const now = raw.finishedAt;
  const t = buildSessionTable(raw, { timeZone });
  const stats = buildSessionStats(t, raw.store, raw.repos, { timeZone });
  const g = computeGlobals(t, stats, raw, { now });
  const signals = computeSignals(stats, g);
  const ref = loadReference();
  const dims = scoreDimensions(signals, ref);
  const b = bootstrap(stats, g, ref, overall(dims, null).included);
  for (const d of dims) d.interval = b.intervals[d.id] ?? null;
  return { signals, dims, overall: overall(dims, b.overall) };
}

const P = Object.fromEntries(KINDS.map((k) => [k, score(personaScan(k))])) as Record<Kind, Scored>;
const components = (s: Scored) => s.dims.flatMap((d) => d.components);

describe("persona calibration", () => {
  test("ordering: novice < intermediate < expert on z′ for every dimension and x for every component both score", () => {
    for (const [lo, hi] of [["novice", "intermediate"], ["intermediate", "expert"], ["novice", "expert"]] as const) {
      let dims = 0;
      for (const a of P[lo].dims) {
        const b = P[hi].dims.find((d) => d.id === a.id)!;
        if (a.z === null || b.z === null) continue;
        dims++;
        expect({ id: a.id, lower: a.z < b.z }).toEqual({ id: a.id, lower: true });
      }
      let comps = 0;
      for (const a of components(P[lo])) {
        const b = components(P[hi]).find((c) => c.id === a.id)!;
        if (a.x === null || b.x === null) continue;
        comps++;
        expect({ id: a.id, lower: a.x < b.x }).toEqual({ id: a.id, lower: true });
      }
      // the novice is insufficient on 3 dimensions and has no background share (its 0 artifacts are a measured 0); the
      // others score everything
      expect([dims, comps]).toEqual(lo === "novice" ? [4, 21] : [7, 22]);
    }
  });

  test("no saturation: no open tail, no score above 98 or below 2", () => {
    for (const k of KINDS) {
      for (const d of P[k].dims) {
        expect(d.openTail).toBe(false);
        if (d.score !== null) expect(d.score >= 2 && d.score <= 98).toBe(true);
      }
      const o = P[k].overall;
      if (o.score !== null) expect(o.score >= 2 && o.score <= 98).toBe(true);
    }
  });

  test("intermediate is centred", () => {
    const { dims, overall: o } = P.intermediate;
    for (const d of dims) {
      expect({ id: d.id, confidence: d.confidence === "medium" || d.confidence === "high" }).toEqual({ id: d.id, confidence: true });
      expect({ id: d.id, inRange: d.score !== null && d.score >= 35 && d.score <= 65 }).toEqual({ id: d.id, inRange: true });
    }
    expect(o.score !== null && o.score >= 40 && o.score <= 60).toBe(true);
    expect(o.band).toBe("developing");
  });

  test("expert: every dimension medium or high and at least 75; the overall exceptional", () => {
    const { dims, overall: o } = P.expert;
    for (const d of dims) {
      expect({ id: d.id, confidence: d.confidence === "medium" || d.confidence === "high" }).toEqual({ id: d.id, confidence: true });
      expect({ id: d.id, high: d.score !== null && d.score >= 75 }).toEqual({ id: d.id, high: true });
    }
    expect(o.band).toBe("exceptional");
  });

  test("novice: orchestration insufficient, no dimension at medium, the overall insufficient", () => {
    const { dims, overall: o } = P.novice;
    expect(dims.find((d) => d.id === "orchestration")!.status).toBe("insufficient");
    for (const d of dims) expect(d.confidence === "medium" || d.confidence === "high").toBe(false);
    expect([o.status, o.band, o.score, o.coverage]).toEqual(["insufficient", "insufficient", null, "0/7"]);
  });
});

/** Golden output: literal values, so CI on three operating systems proves the numbers are identical across platforms. */
describe("persona golden output", () => {
  const GOLDEN: Record<"intermediate" | "expert", { dims: Record<DimensionId, [number, [number, number]]>; overall: Pick<Overall, "score" | "interval" | "band" | "coverage"> }> = {
    intermediate: {
      dims: {
        leverage: [50, [49, 52]], orchestration: [50, [47, 52]], verification: [50, [46, 53]], steering: [50, [41, 63]],
        context: [50, [49, 50]], judgment: [50, [43, 62]], delivery: [49, [44, 55]],
      },
      overall: { score: 50, interval: [48, 52], band: "developing", coverage: "7/7" },
    },
    expert: {
      dims: {
        leverage: [87, [87, 87]], orchestration: [85, [84, 85]], verification: [87, [85, 90]], steering: [88, [84, 92]],
        context: [86, [86, 86]], judgment: [87, [83, 90]], delivery: [89, [88, 91]],
      },
      overall: { score: 87, interval: [86, 88], band: "exceptional", coverage: "7/7" },
    },
  };
  for (const k of ["intermediate", "expert"] as const) {
    test(k, () => {
      expect(Object.fromEntries(P[k].dims.map((d) => [d.id, [d.score, d.interval]]))).toEqual(GOLDEN[k].dims);
      const o = P[k].overall;
      expect({ score: o.score, interval: o.interval, band: o.band, coverage: o.coverage }).toEqual(GOLDEN[k].overall);
    });
  }
});

describe("persona fixtures", () => {
  /** Each knob as the signals read it back: within one unit of the metric's own n (spread over integers) of the knob. */
  const KNOBS: Record<Kind, Partial<Record<keyof Signals, number>>> = {
    novice: {
      parallelShare: 0.02, fanoutPerEpisode: 0, headlessPerWeek: 0, vae: 0.15, closure: 0.4, guardrails: 0, correctionRate: 0.3,
      healthyInterruptShare: 0.25, maintainedShare: 0, briefScore: 0.2, switchesPerWeek: 0.2, rho: 0, tokensPerLanded: 1_500_000,
      landedShare: 0.2, reworkShare: 0.25, prsPerWeek: 0.1,
    },
    intermediate: {
      parallelShare: 0.1, fanoutPerEpisode: 0.5, headlessPerWeek: 1, backgroundShare: 0.1, vae: 0.4, closure: 0.65, guardrails: 1 / 3,
      correctionRate: 0.15, healthyInterruptShare: 0.5, maintainedShare: 1 / 3, artifacts: 2.9, briefScore: 0.4, switchesPerWeek: 1, rho: 0.15,
      tokensPerLanded: 600_000, landedShare: 0.45, reworkShare: 0.12, prsPerWeek: 1,
    },
    expert: {
      parallelShare: 0.35, fanoutPerEpisode: 2.5, headlessPerWeek: 12, backgroundShare: 0.45, vae: 0.75, closure: 0.85, guardrails: 0.8,
      correctionRate: 0.06, healthyInterruptShare: 0.75, maintainedShare: 0.8, artifacts: 9.8, briefScore: 0.65, switchesPerWeek: 4, rho: 0.45,
      tokensPerLanded: 250_000, landedShare: 0.8, reworkShare: 0.05, prsPerWeek: 5,
    },
  };
  for (const k of KINDS) {
    test(`${k}: the walk reads the knobs back`, () => {
      const s = P[k].signals;
      for (const [key, knob] of Object.entries(KNOBS[k]) as [keyof Signals, number][]) {
        const m = s[key] as { value: number | null; n: number };
        const slack = knob >= 1000 ? 0 : 1 / m.n + 1e-9; // token counts are exact
        expect({ key, near: m.value !== null && Math.abs(m.value - knob) <= slack }).toEqual({ key, near: true });
      }
    });
  }

  test("evidence: the counts the knobs imply", () => {
    const ev = (k: Kind) => P[k].signals.evidence;
    expect([ev("novice").sessions, ev("novice").days, ev("novice").weeks, ev("novice").episodes, ev("novice").typedTurns]).toEqual([6, 12, 6, 18, 72]);
    expect([ev("intermediate").sessions, ev("intermediate").days, ev("intermediate").weeks, ev("intermediate").episodes, ev("intermediate").typedTurns])
      .toEqual([96, 48, 12, 132, 528]);
    expect([ev("expert").sessions, ev("expert").days, ev("expert").weeks, ev("expert").episodes, ev("expert").typedTurns]).toEqual([480, 100, 20, 480, 1440]);
    expect([ev("novice").repos, ev("intermediate").repos, ev("expert").repos]).toEqual([1, 3, 5]);
  });

  test("deterministic: two builds hold the same events and repo signals", () => {
    const a = personaScan("intermediate");
    const b = personaScan("intermediate");
    const evs = (r: ScanResult): Ev[] => (["session", "prompt", "tool", "marker", "turn", "usage", "config", "coverage"] as const).flatMap((k) => [...r.store.all(k)]);
    expect(evs(a)).toEqual(evs(b));
    expect(a.repos).toEqual(b.repos);
    expect(a.finishedAt).toBe(b.finishedAt);
  });

  test("canaries: config names, cwds and model ids embed them; model ids carry no vendor prefix; the scores do not move", () => {
    const raw = personaScan("expert", { canaries: true });
    expect(findCanaries([...raw.cwds.values()])).toContain("path");
    expect(findCanaries(raw.store.all("config").map((c) => c.name))).toContain("project");
    const models = new Set(raw.store.all("session").flatMap((s) => s.models));
    expect(models.size).toBeGreaterThan(0);
    for (const m of models) expect(m.startsWith(CANARY.slug)).toBe(true);
    expect(findCanaries(personaScan("expert"))).toEqual([]);
    const scored = score(raw);
    expect(scored.dims.map((d) => [d.score, d.interval])).toEqual(P.expert.dims.map((d) => [d.score, d.interval]));
  });
});

describe("artifacts in use", () => {
  /** The intermediate persona with its config entries replaced by `configs` (the config source is still read). */
  const withConfigs = (configs: Ev[]): ScanResult => {
    const raw = personaScan("intermediate");
    const kinds = ["coverage", "session", "prompt", "tool", "marker", "turn", "usage", "totals", "daily", "edge"] as const;
    const evs: Ev[] = [...kinds.flatMap((k) => [...raw.store.all(k)]), ...configs];
    return scanResultOf(evs, { repos: raw.repos, cwds: raw.cwds, salt: raw.salt, finishedAt: raw.finishedAt });
  };
  const context = (raw: ScanResult): number => score(raw).dims.find((d) => d.id === "context")!.score!;
  test("the same person scores no higher on Context with no artifact than with one", () => {
    const one: Ev = { k: "config", tool: "claude-code", source: "claude-code.config", kind: "plugin", name: "p", provenance: "installed", uses: 3 };
    expect(context(withConfigs([]))).toBeLessThanOrEqual(context(withConfigs([one])));
    expect(score(withConfigs([])).signals.artifacts.value).toBe(0);
  });
});
