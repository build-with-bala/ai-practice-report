import type { ToolId } from "../model/ids";

/*
 * Forensics: integrity checks over a scan result (spec §6.6). They let a reader judge whether a trace history is genuine
 * or was edited, copied or fabricated. Every check is pure and synchronous, like the rest of the analysis.
 *
 * A result holds no free text from traces: `values` holds numbers and dates ("YYYY-MM-DD") only, `reason` is a short
 * fixed code, and `askAbout` one fixed English question whose only variable parts are numbers and dates. Every text
 * uses only characters Plan 3's fonts cover (U+0020–00FF, U+2000–206F and U+2212).
 */

export type CheckStatus = "pass" | "note" | "warn" | "fail" | "n/a" | "info";
export type CheckId = "C1" | "C2" | "C3" | "C4" | "C5" | "C6" | "C7" | "C8" | "C9" | "C10"
  | "soft:rhythm" | "soft:repeated-long" | "soft:recent-burst" | "soft:unclosed-tools" | "soft:new-config";
/** `n`: the evidence the check measured; `tools`: the tools whose data it read (sorted). */
export interface CheckResult { id: CheckId; status: CheckStatus; n: number; reason: string; values: Record<string, number | string>; askAbout?: string; tools: ToolId[] }

/** How bad a status is: the higher, the worse. `n/a` is the least, so any measured result outranks it. */
const SEVERITY: Readonly<Record<CheckStatus, number>> = { "n/a": 0, info: 1, pass: 2, note: 3, warn: 4, fail: 5 };

/**
 * The worse of the results (the first among equals); `undefined` for none. Here n/a and info rank below pass: a
 * measured result outranks one that was not measured. (C1/C2's two-kind combination ranks differently, see anchors.ts.)
 */
export function worst<T extends { status: CheckStatus }>(results: readonly T[]): T | undefined {
  let out: T | undefined;
  for (const r of results) if (out === undefined || SEVERITY[r.status] > SEVERITY[out.status]) out = r;
  return out;
}

/** The distinct tools of some events, sorted. */
export function toolsOf(events: Iterable<{ tool: ToolId }>): ToolId[] {
  const s = new Set<ToolId>();
  for (const e of events) s.add(e.tool);
  return [...s].sort();
}

/** `x` rounded to `digits` decimals. */
export const round = (x: number, digits = 4): number => {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
};
