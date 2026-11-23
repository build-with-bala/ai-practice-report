import type { MetricMeta } from "../analysis/types";
import { DIMENSION_IDS, type DimensionId } from "./dimensions";
import { displayScore, type DimensionResult } from "./score";

export type Band = "exceptional" | "strong" | "developing" | "limited" | "insufficient";

/**
 * The overall (spec §6.5 Overall, builder's call 6).
 * - `included`: the dimensions scored at medium or high confidence, in report order.
 * - `status`: `insufficient` under 3 included dimensions; `z`, `score` and `interval` are then null and `band` is
 *   `insufficient`. Otherwise `z` = Σ w·z′ / Σ w over `included` (shrinkage carries the confidence weighting), `score`
 *   its display score, `band` read from the score, and `interval` the bootstrap's.
 * - `coverage`: `"<scored dimensions>/7"`, counting every dimension with status `scored`, whatever its confidence.
 * - `meta`: window `detail`; the union of the included dimensions' sources (sorted), their earliest `from` and latest
 *   `to`; `n` = the number of included dimensions.
 */
export interface Overall { status: "scored" | "insufficient"; z: number | null; score: number | null; interval: [number, number] | null;
  band: Band; included: DimensionId[]; coverage: string; meta: MetricMeta }

/** The overall's dimension weights (spec §6.5 Overall). */
export const WEIGHTS: Readonly<Record<DimensionId, number>> = Object.freeze({
  leverage: 0.15, orchestration: 0.15, verification: 0.2, steering: 0.15, context: 0.15, judgment: 0.1, delivery: 0.1,
});

/** The overall needs at least this many dimensions at medium or high confidence. */
export const MIN_INCLUDED = 3;

/** The band of an overall display score: exceptional ≥ 80; strong 60–79; developing 35–59; limited ≤ 34. */
export function bandOf(score: number): Exclude<Band, "insufficient"> {
  if (score >= 80) return "exceptional";
  if (score >= 60) return "strong";
  if (score >= 35) return "developing";
  return "limited";
}

/** Σ w·z / Σ w over the given dimensions' z values; null when none is given. */
export function weightedZ(zs: ReadonlyArray<readonly [DimensionId, number]>): number | null {
  let sum = 0;
  let weight = 0;
  for (const [id, z] of zs) { sum += WEIGHTS[id] * z; weight += WEIGHTS[id]; }
  return weight > 0 ? sum / weight : null;
}

/** The overall of the scored dimensions `dims`, with the bootstrap's `interval` (kept only when the overall scores). */
export function overall(dims: readonly DimensionResult[], interval: [number, number] | null): Overall {
  const included = DIMENSION_IDS.map((id) => dims.find((d) => d.id === id))
    .filter((d): d is DimensionResult => d !== undefined && d.status === "scored" && d.z !== null && Number.isFinite(d.z)
      && (d.confidence === "medium" || d.confidence === "high"));
  const coverage = `${dims.filter((d) => d.status === "scored").length}/${DIMENSION_IDS.length}`;
  const meta = metaOf(included);
  const ids = included.map((d) => d.id);
  const z = included.length >= MIN_INCLUDED ? weightedZ(included.map((d) => [d.id, d.z!] as const)) : null;
  if (z === null || !Number.isFinite(z)) {
    return { status: "insufficient", z: null, score: null, interval: null, band: "insufficient", included: ids, coverage, meta };
  }
  const { score } = displayScore(z);
  return { status: "scored", z, score, interval, band: bandOf(score), included: ids, coverage, meta };
}

function metaOf(dims: readonly DimensionResult[]): MetricMeta {
  const sources = new Set<string>();
  let from = Infinity;
  let to = -Infinity;
  for (const d of dims) {
    for (const s of d.meta.sources) sources.add(s);
    if (d.meta.from !== undefined && d.meta.from < from) from = d.meta.from;
    if (d.meta.to !== undefined && d.meta.to > to) to = d.meta.to;
  }
  const meta: MetricMeta = { window: "detail", sources: [...sources].sort(), n: dims.length };
  if (Number.isFinite(from)) meta.from = from;
  if (Number.isFinite(to)) meta.to = to;
  return meta;
}
