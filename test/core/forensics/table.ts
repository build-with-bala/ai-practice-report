import { expect } from "bun:test";
import { buildSessionTable } from "../../../core/analysis/sessions";
import type { Exclusions, SessionTable } from "../../../core/analysis/types";
import { questionFor } from "../../../core/forensics/questions";
import { DATE_KEY, REASONS, VALUE_KEYS, type CheckResult } from "../../../core/forensics/types";
import type { ScanResult } from "../../../core/scan";

/** The session table of a synthetic scan, at its own `finishedAt`, in `timeZone` (default UTC), under `exclude`. */
export const tableOf = (raw: ScanResult, exclude?: Exclusions, timeZone = "UTC"): SessionTable =>
  buildSessionTable(raw, { timeZone, ...(exclude ? { exclude } : {}) });

/**
 * `results`, after checking that each one's question is exactly what `questionFor` rebuilds from its `id`, `reason` and
 * `values` (the reading side of an export says what the in-memory result says), and that its reason and every `values`
 * key are in the closed vocabularies, with a finite number under every key but `date`, which holds a day and appears
 * on the file-time check (C5) only. Every helper of the forensics suites
 * passes its results through this.
 */
export function asks<T extends CheckResult | readonly CheckResult[]>(results: T): T {
  for (const r of (Array.isArray(results) ? results : [results]) as CheckResult[]) {
    expect([r.id, r.reason, questionFor(r.id, r.reason, r.values)]).toEqual([r.id, r.reason, r.askAbout]);
    expect([r.id, r.reason, REASONS[r.reason]]).toEqual([r.id, r.reason, true]);
    for (const [k, v] of Object.entries(r.values)) {
      const ok = k in VALUE_KEYS && (k === DATE_KEY ? typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) : typeof v === "number" && Number.isFinite(v));
      expect([r.id, k, ok]).toEqual([r.id, k, true]);
    }
    // only the file-time check may carry a day
    if (DATE_KEY in r.values) expect([r.id, DATE_KEY]).toEqual(["C5", DATE_KEY]);
  }
  return results;
}
