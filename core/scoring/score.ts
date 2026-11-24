import type { MetricMeta } from "../analysis/types";
import type { Evidence, Signals } from "../signals/types";
import { COMPONENTS, repoSignalsOff, scoreComponent, type ComponentResult } from "./components";
import { bindingEvidence, confidenceOf, DIMENSION_IDS, type Confidence, type DimensionId } from "./dimensions";
import { phi } from "./normal";
import type { ReferenceTable } from "./reference";

export type { ComponentResult } from "./components";
export type { Confidence, DimensionId } from "./dimensions";

/**
 * One dimension as scored (spec §6.5).
 * - `status`: `scored`; `not-measured` (Delivery whenever repo signals are off or git is missing, or a dimension that
 *   falls below half its weight measured only because of repo components that are not measured); `not-measurable`
 *   (below half its weight measured otherwise, builder's call 3); `insufficient` (measurable, but below the low
 *   confidence bar: under 1× the minimum evidence or no distinct week).
 * - `zRaw`: the unshrunk weighted mean of the measured components' z, with the components' effective weights (so it
 *   reconciles with the component table); set when `scored` or `insufficient`, else null.
 * - `z`: the shown, shrunk z' = zRaw·r/(r+1) (builder's call 4); null unless scored. `score` and `openTail` come from
 *   it by `displayScore`. `interval` is the bootstrap's (Task 8), null here.
 * - `part`, `n`, `needs`, `ratio`: the binding evidence part (its `Evidence` field), its count, minimum and n/minimum,
 *   whatever the status: the smallest ratio of "and" parts, the largest of Context's "or" parts. When the ratio is met
 *   but there is no distinct week (insufficient), the weeks bind: `part` "weeks", `n` = weeks, `needs` 1, `ratio` = weeks.
 * - `weeks`: the evidence's distinct weeks.
 * - `meta`: window `detail`; `sources`, `from` and `to` derived from the measured components (the union of their
 *   sources, sorted; the earliest `from`; the latest `to`); `n` the binding part's count.
 */
export interface DimensionResult { id: DimensionId; status: "scored" | "insufficient" | "not-measurable" | "not-measured";
  z: number | null; zRaw: number | null; score: number | null; interval: [number, number] | null; openTail: boolean; confidence: Confidence | null;
  part: keyof Evidence; n: number; needs: number; ratio: number; weeks: number; components: ComponentResult[]; meta: MetricMeta }

/** A dimension needs at least this share of its pinned weight measured (builder's call 3); the slack absorbs float sums. */
const MIN_WEIGHT = 0.5 - 1e-9;

/** The display score `round(100·Φ(z))` clamped to [1, 99], open-tailed whenever it shows 99 (builder's call 5, pre-flight P16). */
export function displayScore(z: number): { score: number; openTail: boolean } {
  const score = Math.min(99, Math.max(1, Math.round(100 * phi(z))));
  return { score, openTail: score === 99 };
}

/** The seven dimensions of `s` against `ref`: pure and synchronous, and every number finite. */
export function scoreDimensions(s: Signals, ref: ReferenceTable): DimensionResult[] {
  const weeks = Number.isFinite(s.evidence.weeks) && s.evidence.weeks > 0 ? s.evidence.weeks : 0;
  return DIMENSION_IDS.map((id) => {
    const specs = COMPONENTS.filter((c) => c.dimension === id);
    const comps = specs.map((c) => scoreComponent(c, s, ref));
    let measured = 0;
    let missingRepo = 0;
    specs.forEach((c, i) => {
      if (comps[i]!.status === "ok") measured += c.weight;
      else if (comps[i]!.status === "not-measured") missingRepo += c.weight;
    });
    let zMean = 0;
    if (measured > 0) specs.forEach((c, i) => { const r = comps[i]!; if (r.status === "ok") zMean += (c.weight / measured) * r.z!; });
    const ev = bindingEvidence(id, s.evidence);
    const base = { id, z: null, zRaw: null, score: null, interval: null, openTail: false, confidence: null, ...ev, weeks, components: comps,
      meta: metaOf(comps, ev.n) };
    if (id === "delivery" && repoSignalsOff(s)) return { ...base, status: "not-measured" };
    if (measured < MIN_WEIGHT) return { ...base, status: measured + missingRepo >= MIN_WEIGHT ? "not-measured" : "not-measurable" };
    if (!Number.isFinite(zMean)) return { ...base, status: "not-measurable" };
    // From here on the dimension is scored or insufficient: its measured components carry their effective weights.
    specs.forEach((c, i) => { const r = comps[i]!; if (r.status === "ok") r.weight = c.weight / measured; });
    const confidence = confidenceOf(ev.ratio, weeks);
    if (!confidence) {
      // The ratio is met but there is no distinct week: the weeks are what binds.
      const short = ev.ratio >= 1 ? { part: "weeks" as const, n: weeks, needs: 1, ratio: weeks, meta: metaOf(comps, weeks) } : {};
      return { ...base, ...short, zRaw: zMean, status: "insufficient" };
    }
    const z = zMean * (ev.ratio / (ev.ratio + 1)); // the fraction first: z·r overflows for huge r
    if (!Number.isFinite(z)) return { ...base, status: "not-measurable" };
    return { ...base, status: "scored", z, zRaw: zMean, ...displayScore(z), confidence };
  });
}

/** A dimension's metadata, derived from its measured components (see `DimensionResult.meta`). */
function metaOf(comps: readonly ComponentResult[], n: number): MetricMeta {
  const sources = new Set<string>();
  let from = Infinity;
  let to = -Infinity;
  for (const c of comps) {
    if (c.status !== "ok") continue;
    for (const src of c.meta.sources) sources.add(src);
    if (c.meta.from !== undefined && c.meta.from < from) from = c.meta.from;
    if (c.meta.to !== undefined && c.meta.to > to) to = c.meta.to;
  }
  const meta: MetricMeta = { window: "detail", sources: [...sources].sort(), n };
  if (Number.isFinite(from)) meta.from = from;
  if (Number.isFinite(to)) meta.to = to;
  return meta;
}
