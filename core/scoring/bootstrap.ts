import type { SessionStats } from "../analysis/walk";
import { computeSignals } from "../signals/compute";
import type { Globals } from "../signals/types";
import { DIMENSION_IDS, type DimensionId } from "./dimensions";
import { MIN_INCLUDED, weightedZ } from "./overall";
import { mulberry32 } from "./random";
import type { ReferenceTable } from "./reference";
import { displayScore, scoreDimensions } from "./score";

/** Replicates per bootstrap (spec §6.5). */
export const DEFAULT_B = 200;
/** The bootstrap's default seed (builder's call 7). */
export const DEFAULT_SEED = 0x5eed;

/**
 * The bootstrap's intervals, as display scores (integers in [1, 99], low ≤ high). A dimension without an entry has no
 * interval: the point estimate does not score it, or fewer than B/2 replicates do. `overall` is null likewise, or when
 * `included` holds fewer than 3 dimensions. `B` is the replicate count used.
 */
export interface BootstrapResult { intervals: Partial<Record<DimensionId, [number, number]>>; overall: [number, number] | null; B: number }

/** The 0-based ranks of an interval over `m` sorted scores: floor(0.025·(m−1)) and ceil(0.975·(m−1)) (builder's call 7). */
export function intervalRanks(m: number): [number, number] {
  return [Math.floor(0.025 * (m - 1)), Math.ceil(0.975 * (m - 1))];
}

/** The interval of a non-empty list of scores: the sorted scores at `intervalRanks(scores.length)`. */
export function intervalOf(scores: readonly number[]): [number, number] {
  const sorted = [...scores].sort((a, b) => a - b);
  const [lo, hi] = intervalRanks(sorted.length);
  return [sorted[lo]!, sorted[hi]!];
}

/**
 * The session-level bootstrap (spec §6.5, builder's call 7). Pure and deterministic: all randomness comes from
 * `mulberry32(seed)`.
 *
 * - `stats` are the detail-window top-level sessions. Each of `B` replicates draws `stats.length` of them with
 *   replacement (an array of references to the same rows, refilled per replicate: nothing is copied), then runs
 *   `computeSignals(sample, g)` and `scoreDimensions`. `g` stays at its point values, so the `f` components do too.
 * - Shrinkage uses the point estimate's evidence ratio (pre-flight P23: resampled duplicates add no distinct days):
 *   a replicate's z′ is its `zRaw`·r/(r+1) with the point's r, and its own `z`, ratio and confidence are ignored.
 * - A replicate **scores the dimension** when its `zRaw` is non-null (status `scored` or `insufficient`: at least half
 *   the dimension's weight measured). A dimension gets an interval only when the point estimate scores it and at least
 *   B/2 replicates score it; the interval reads `intervalRanks` over those replicates' scores.
 * - The overall uses the point estimate's `included` set: a replicate scores the overall when it scores every included
 *   dimension, and its overall z is the weighted mean of their z′. The overall interval follows the same B/2 rule, and
 *   is null when `included` has fewer than 3 dimensions or names one the point estimate does not score.
 */
export function bootstrap(stats: readonly SessionStats[], g: Globals, ref: ReferenceTable, included: readonly DimensionId[],
  o: { B?: number; seed?: number } = {}): BootstrapResult {
  const B = o.B ?? DEFAULT_B;
  if (!Number.isInteger(B) || B < 1) throw new RangeError("bootstrap: B must be a positive integer");
  const rng = mulberry32(o.seed ?? DEFAULT_SEED);

  // The point estimate's shrink factor r/(r+1), for the dimensions it scores.
  const shrink = new Map<DimensionId, number>();
  for (const d of scoreDimensions(computeSignals(stats, g), ref)) if (d.status === "scored") shrink.set(d.id, d.ratio / (d.ratio + 1));
  const dimIds = DIMENSION_IDS.filter((id) => shrink.has(id));
  const overallIds = included.length >= MIN_INCLUDED && included.every((id) => shrink.has(id)) ? [...new Set(included)] : null;
  const scores = new Map<DimensionId, number[]>(dimIds.map((id) => [id, []]));
  const overallScores: number[] = [];

  const n = stats.length;
  if (n > 0 && (dimIds.length > 0 || overallIds)) {
    const sample = new Array<SessionStats>(n);
    const zs = new Map<DimensionId, number>();
    for (let b = 0; b < B; b++) {
      for (let i = 0; i < n; i++) sample[i] = stats[Math.floor(rng() * n)]!;
      zs.clear();
      for (const d of scoreDimensions(computeSignals(sample, g), ref)) {
        const k = shrink.get(d.id);
        if (k === undefined || d.zRaw === null) continue;
        const z = d.zRaw * k;
        if (!Number.isFinite(z)) continue;
        zs.set(d.id, z);
        scores.get(d.id)!.push(displayScore(z).score);
      }
      if (overallIds && overallIds.every((id) => zs.has(id))) {
        const z = weightedZ(overallIds.map((id) => [id, zs.get(id)!] as const));
        if (z !== null && Number.isFinite(z)) overallScores.push(displayScore(z).score);
      }
    }
  }

  const enough = (xs: readonly number[]): boolean => xs.length > 0 && xs.length >= B / 2;
  const intervals: BootstrapResult["intervals"] = {};
  for (const id of dimIds) { const xs = scores.get(id)!; if (enough(xs)) intervals[id] = intervalOf(xs); }
  return { intervals, overall: enough(overallScores) ? intervalOf(overallScores) : null, B };
}
