/**
 * The transforms onto the reference scale (spec §6.5 Transforms, builder's call 2). Every result is finite for any finite
 * input: counts floor at 0 before `log1p`, rates are smoothed by their sample size and clamped before the logit, and
 * correlations are clamped before `atanh`. Orientation (negating a lower-is-better component) happens in the component.
 */
export type Transform = "identity" | "log1p" | "logit" | "atanh";

const RATE_MIN = 0.02;
const RATE_MAX = 0.98;
const RHO_MAX = 0.95;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * `raw` on the transformed scale. `n` is the signal's own sample size, used by the rate smoothing
 * `r' = (r·n + 0.5)/(n + 1)` (so a rate with n = 0 sits at 0.5). A non-finite `raw` (never a `Metric` value) gives 0.
 */
export function transform(kind: Transform, raw: number, n: number): number {
  if (!Number.isFinite(raw)) return 0;
  switch (kind) {
    case "identity": return raw;
    case "log1p": return Math.log1p(Math.max(0, raw));
    case "atanh": return Math.atanh(clamp(raw, -RHO_MAX, RHO_MAX));
    case "logit": {
      const m = Number.isFinite(n) && n > 0 ? n : 0;
      const r = clamp((clamp(raw, 0, 1) * m + 0.5) / (m + 1), RATE_MIN, RATE_MAX);
      return Math.log(r / (1 - r));
    }
  }
}
