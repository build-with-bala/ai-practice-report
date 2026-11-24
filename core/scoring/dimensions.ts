import type { Evidence } from "../signals/types";

export type DimensionId = "leverage" | "orchestration" | "verification" | "steering" | "context" | "judgment" | "delivery";
export type Confidence = "low" | "medium" | "high";

/** The seven dimensions, in report order. */
export const DIMENSION_IDS: readonly DimensionId[] = Object.freeze(["leverage", "orchestration", "verification", "steering", "context", "judgment", "delivery"]);

/** One part of a dimension's minimum evidence: an `Evidence` field and its minimum. */
export interface EvidencePart { field: keyof Evidence; min: number }
/** A dimension's minimum evidence (spec §6.5): all parts must reach their minimum (`all`), or any one (`any`). */
export interface EvidenceRule { mode: "all" | "any"; parts: readonly EvidencePart[] }

const ruleOf = (mode: EvidenceRule["mode"]) => (...parts: EvidencePart[]): EvidenceRule => Object.freeze({ mode, parts: Object.freeze(parts) });
const all = ruleOf("all");
const any = ruleOf("any");
export const EVIDENCE: Readonly<Record<DimensionId, EvidenceRule>> = Object.freeze({
  leverage: all({ field: "typedTurns", min: 60 }, { field: "sessions", min: 5 }, { field: "days", min: 10 }),
  orchestration: all({ field: "days", min: 14 }, { field: "episodes", min: 20 }),
  verification: all({ field: "editTurns", min: 20 }),
  // the denominators of its two components: the corrected-brief rate (briefs) and the healthy-interrupt share
  steering: any({ field: "briefs", min: 15 }, { field: "interrupts", min: 15 }),
  context: any({ field: "episodes", min: 20 }, { field: "repos", min: 3 }),
  judgment: all({ field: "tierEpisodes", min: 30 }),
  delivery: all({ field: "editEpisodesInRepo", min: 10 }),
});

/** The binding evidence part: its `Evidence` field, count, minimum and count/minimum. */
export interface BindingEvidence { part: keyof Evidence; n: number; needs: number; ratio: number }

/**
 * The binding part of a dimension's evidence (builder's call 4): for `all`, the part with the smallest n/minimum; for
 * `any`, the largest (the first such part on a tie). `ratio` is its n/minimum, and both shrinkage and confidence use it.
 */
export function bindingEvidence(id: DimensionId, ev: Evidence): BindingEvidence {
  const rule = EVIDENCE[id];
  let best: BindingEvidence | undefined;
  for (const p of rule.parts) {
    const raw = ev[p.field];
    const n = Number.isFinite(raw) && raw > 0 ? raw : 0;
    const ratio = n / p.min;
    if (!best || (rule.mode === "all" ? ratio < best.ratio : ratio > best.ratio)) best = { part: p.field, n, needs: p.min, ratio };
  }
  return best!;
}

/**
 * Confidence (spec §6.5): high, medium and low need 10×, 3× and 1× the minimum and at least 6, 3 and 1 distinct weeks.
 * Below low the dimension is insufficient: null.
 */
export function confidenceOf(ratio: number, weeks: number): Confidence | null {
  if (ratio >= 10 && weeks >= 6) return "high";
  if (ratio >= 3 && weeks >= 3) return "medium";
  if (ratio >= 1 && weeks >= 1) return "low";
  return null;
}
