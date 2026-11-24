import type { Metric, MetricMeta } from "../analysis/types";
import type { Signals } from "../signals/types";
import type { DimensionId } from "./dimensions";
import { Z90, type ReferenceTable } from "./reference";
import { transform } from "./transform";

/** The `Signals` fields that are metrics: the ones a component can read. */
export type MetricKey = { [K in keyof Signals]: Signals[K] extends Metric ? K : never }[keyof Signals];

/**
 * One scored component (spec §6.5 Dimensions): its dimension, its pinned weight there, its bootstrap unit (`s`: resampled
 * per session; `f`: held at its point value, builder's call 7), the signal it reads, whether lower is better (`negate`:
 * negated after the transform, builder's call 2), and whether it needs repo signals (`repo`).
 */
export interface ComponentSpec { id: string; dimension: DimensionId; weight: number; unit: "s" | "f"; signal: MetricKey; negate: boolean; repo: boolean }

const c = (id: string, dimension: DimensionId, weight: number, unit: "s" | "f", signal: MetricKey, o: { negate?: boolean; repo?: boolean } = {}): ComponentSpec =>
  Object.freeze({ id, dimension, weight, unit, signal, negate: o.negate ?? false, repo: o.repo ?? false });

/** The 22 components, in reference-table order (grouped by dimension, in `DIMENSION_IDS` order). */
export const COMPONENTS: readonly ComponentSpec[] = Object.freeze([
  c("lev.sticky", "leverage", 0.6, "s", "stickyMean"),
  c("lev.run", "leverage", 0.4, "s", "p90Run"),
  c("orc.parallel", "orchestration", 0.35, "f", "parallelShare"),
  c("orc.fanout", "orchestration", 0.3, "s", "fanoutPerEpisode"),
  c("orc.headless", "orchestration", 0.2, "f", "headlessPerWeek"),
  c("orc.background", "orchestration", 0.15, "s", "backgroundShare"),
  c("ver.vae", "verification", 0.5, "s", "vae"),
  c("ver.closure", "verification", 0.3, "s", "closure"),
  c("ver.guardrails", "verification", 0.2, "f", "guardrails", { repo: true }),
  c("ste.correction", "steering", 0.4, "s", "correctionRate", { negate: true }),
  c("ste.interrupts", "steering", 0.3, "s", "healthyInterruptShare"),
  c("ste.turnsPerWork", "steering", 0.3, "s", "turnsPerWork", { negate: true }),
  c("ctx.instructions", "context", 0.35, "f", "maintainedShare", { repo: true }),
  c("ctx.artifacts", "context", 0.35, "f", "artifacts"),
  c("ctx.hygiene", "context", 0.15, "s", "hygiene"),
  c("ctx.briefs", "context", 0.15, "s", "briefScore"),
  c("jud.switches", "judgment", 0.4, "f", "switchesPerWeek"),
  c("jud.rho", "judgment", 0.4, "s", "rho"),
  c("jud.cost", "judgment", 0.2, "s", "tokensPerLanded", { negate: true }),
  c("del.landed", "delivery", 0.5, "s", "landedShare", { repo: true }),
  c("del.rework", "delivery", 0.35, "f", "reworkShare", { repo: true, negate: true }),
  c("del.prs", "delivery", 0.15, "f", "prsPerWeek", { repo: true }),
]);

/**
 * A component as scored. `status` (builder's call 3): `ok` for a value; `not-measured` when it needs repo signals that
 * are off (a null with reason `repo-signals-off`, or any repo component while repo signals are `off` or `git-missing`);
 * otherwise a null is `not-measurable`. `raw` is the signal's value, `x` its transformed, oriented value, `z` the
 * unshrunk z against the reference, limited to [-Z_LIMIT, Z_LIMIT] (a scoring rule). `weight` is the effective weight in its dimension:
 * the pinned weight spread over the measured components when the dimension is `scored` or `insufficient`, else 0 (and 0
 * for an unmeasured component; `COMPONENTS` keeps the pinned one). `n` and `meta` are the signal's own.
 */
export interface ComponentResult { id: string; weight: number; status: "ok" | "not-measurable" | "not-measured"; raw: number | null;
  x: number | null; z: number | null; n: number; meta: MetricMeta }

/** True when repo signals are switched off or git is missing: no repo component can be measured. */
export const repoSignalsOff = (s: Signals): boolean => s.repoSignals === "off" || s.repoSignals === "git-missing";

/**
 * A scoring rule: a component's z is limited to [-Z_LIMIT, Z_LIMIT] before it enters its dimension, so one signal far
 * off the reference (a long sitting, a rare commit, an unusual commit-message style) cannot set a whole dimension on
 * its own. Three reference sigmas is beyond the 99.8th percentile of the reference. It also keeps every later weighted
 * sum finite, the overall included.
 */
export const Z_LIMIT = 3;
const clampZ = (z: number): number => (Number.isNaN(z) ? z : Math.min(Z_LIMIT, Math.max(-Z_LIMIT, z)));

/** Scores one component against the reference, with weight 0 (the dimension sets the effective weights). */
export function scoreComponent(spec: ComponentSpec, s: Signals, ref: ReferenceTable): ComponentResult {
  const m = s[spec.signal];
  const meta: MetricMeta = { window: m.window, sources: [...m.sources], n: m.n };
  if (m.from !== undefined) meta.from = m.from;
  if (m.to !== undefined) meta.to = m.to;
  const base = { id: spec.id, weight: 0, n: m.n, meta };
  const e = ref.components[spec.id];
  if ((spec.repo && repoSignalsOff(s)) || m.reason === "repo-signals-off") return { ...base, status: "not-measured", raw: null, x: null, z: null };
  if (m.value === null || !Number.isFinite(m.value) || !e) return { ...base, status: "not-measurable", raw: null, x: null, z: null };
  const t = transform(e.transform, m.value, m.n);
  const x = spec.negate ? 0 - t : t; // 0 - t, not -t: no -0
  const z = clampZ((x - e.p50) / ((e.p90 - e.p50) / Z90));
  if (!Number.isFinite(z)) return { ...base, status: "not-measurable", raw: null, x: null, z: null };
  return { ...base, status: "ok", raw: m.value, x, z };
}
