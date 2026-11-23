import type { Origin, ToolId, Window } from "../model/ids";

/*
 * Forensics: integrity checks over a scan result (spec §6.6). They let a reader judge whether a trace history is genuine
 * or was edited, copied or fabricated. Every check is pure and synchronous, like the rest of the analysis.
 *
 * A result holds no free text from traces: `values` holds finite numbers, and one day ("YYYY-MM-DD") under `date`,
 * under closed keys (`ValueKey`); `reason` is a closed code (`Reason`); and `askAbout` is the one fixed English question
 * `questionFor` (questions.ts) builds from `id`, `reason` and `values`, whose only variable parts are those numbers and
 * that date. Every text uses only characters Plan 3's fonts cover (U+0020–00FF, U+2000–206F and U+2212).
 */

export type CheckStatus = "pass" | "note" | "warn" | "fail" | "n/a" | "info";
export type CheckId = "C1" | "C2" | "C3" | "C4" | "C5" | "C6" | "C7" | "C8" | "C9" | "C10"
  | "soft:rhythm" | "soft:repeated-long" | "soft:recent-burst" | "soft:unclosed-tools" | "soft:new-config";

/*
 * Closed vocabularies. A result leaves the machine as its `id`, `status`, `n`, `reason` and `values` only, and the
 * reading side rebuilds the question from them (`questionFor`, questions.ts): so every reason code and every `values`
 * key is listed here. A reason is a closed union, so a new code fails the compiler until it is listed. `CheckValues` is
 * all-optional, so TypeScript checks a values object's keys only where it is a fresh literal of that type: every check
 * builds its values as one (`satisfies CheckValues`, or a literal typed `CheckValues`), and types.test.ts pins that an
 * unlisted key, or a string under a key other than `date`, fails there.
 */

/** Every reason code a check or soft flag can give. */
export type Reason = "ok" | "ok-history-only" | "ok-stats-only" | "no-data" | "too-few" | "unknown-marker" | "scheme-changed"
  | "degenerate" | "off-time" | "malformed-ids" | "out-of-order" | "history-mismatch" | "missing-stats-days" | "no-match"
  | "several-accounts" | "file-times" | "restore-cluster" | "bulk-change" | "no-thread-index" | "no-rollouts" | "before-index"
  | "missing-thread-rows" | "uuid-after-name" | "time-zone-change" | "ledger-contradictions" | "before-release"
  | "classify-only" | "regular-rhythm" | "repeated-long" | "recent-burst" | "unclosed-tools" | "new-config";
export const REASONS: Readonly<Record<Reason, true>> = {
  ok: true, "ok-history-only": true, "ok-stats-only": true, "no-data": true, "too-few": true, "unknown-marker": true,
  "scheme-changed": true, degenerate: true, "off-time": true, "malformed-ids": true, "out-of-order": true, "history-mismatch": true,
  "missing-stats-days": true, "no-match": true, "several-accounts": true, "file-times": true, "restore-cluster": true,
  "bulk-change": true, "no-thread-index": true, "no-rollouts": true, "before-index": true, "missing-thread-rows": true,
  "uuid-after-name": true, "time-zone-change": true, "ledger-contradictions": true, "before-release": true,
  "classify-only": true, "regular-rhythm": true, "repeated-long": true, "recent-burst": true, "unclosed-tools": true,
  "new-config": true,
};

/** The one `values` key whose value is a string: a day, "YYYY-MM-DD". */
export const DATE_KEY = "date";
/** The fixed `values` keys (every check but C10). */
type FixedKey = typeof DATE_KEY | "unrecognized" | "malformed" | "offShare" | "p99Seconds" | "rho" | "unverifiedKinds"
  | "matchShare" | "prompts" | "missingDays" | "days" | "accounts" | "violations" | "clusterFiles" | "bulkFiles" | "missing"
  | "rollouts" | "beforeIndex" | "zoneShifted" | "pairs" | "contradictions" | "checked" | "sessions" | "medianCv" | "repeated"
  | "recentDays" | "spanDays" | "share" | "open" | "recent" | "artifacts";
/** C10's keys: `<tool>/<origin>/<window>`, where a relabelled scripted prompt counts as `human`. */
export type ProvenanceKey = `${ToolId}/${Origin}/${Window}`;
/** Every key a check can put in `values`. */
export type ValueKey = FixedKey | ProvenanceKey;
/** A result's measurements: a finite number under every key but `date`, which holds a day "YYYY-MM-DD". */
export type CheckValues = { [K in ValueKey]?: K extends typeof DATE_KEY ? string : number };

const FIXED_KEYS: Readonly<Record<FixedKey, true>> = {
  date: true, unrecognized: true, malformed: true, offShare: true, p99Seconds: true, rho: true, unverifiedKinds: true,
  matchShare: true, prompts: true, missingDays: true, days: true, accounts: true, violations: true, clusterFiles: true,
  bulkFiles: true, missing: true, rollouts: true, beforeIndex: true, zoneShifted: true, pairs: true, contradictions: true,
  checked: true, sessions: true, medianCv: true, repeated: true, recentDays: true, spanDays: true, share: true, open: true,
  recent: true, artifacts: true,
};
const TOOL_IDS: Readonly<Record<ToolId, true>> = {
  "claude-code": true, codex: true, copilot: true, cursor: true, antigravity: true, "gemini-cli": true, opencode: true, cline: true,
  "roo-code": true, "kilo-code": true, windsurf: true, zed: true, kiro: true, warp: true, amp: true, goose: true, droid: true,
  "qwen-code": true, crush: true, aider: true, continue: true, "jetbrains-ai": true,
};
const ORIGINS: Readonly<Record<Origin, true>> = { human: true, scripted: true, subagent: true, scheduled: true, peer: true, system: true };
const WINDOWS: Readonly<Record<Window, true>> = { detail: true, lifetime: true };
/** Every `values` key: the fixed ones and each `<tool>/<origin>/<window>` of C10. */
export const VALUE_KEYS: Readonly<Record<ValueKey, true>> = (() => {
  const out: Record<string, true> = { ...FIXED_KEYS };
  for (const tool of Object.keys(TOOL_IDS)) for (const origin of Object.keys(ORIGINS)) for (const w of Object.keys(WINDOWS)) out[`${tool}/${origin}/${w}`] = true;
  return out as Record<ValueKey, true>;
})();

/**
 * What each `values` key holds, the one table both readers of a result use (`questionFor` and the export schema), so
 * they cannot disagree: `count` a non-negative safe integer; `share` a finite number in [0, 1]; `corr` a correlation,
 * finite in [−1, 1]; `ratio` a non-negative finite number without an upper bound (a coefficient of variation); `date`
 * a real calendar day "YYYY-MM-DD" (`isDay`). Typed by `ValueKey`, so a new key fails the compiler until it has a kind.
 */
export type ValueKind = "count" | "share" | "corr" | "ratio" | "date";
const FIXED_KINDS: Readonly<Record<FixedKey, ValueKind>> = {
  date: "date", unrecognized: "count", malformed: "count", offShare: "share", p99Seconds: "count", rho: "corr", unverifiedKinds: "count",
  matchShare: "share", prompts: "count", missingDays: "count", days: "count", accounts: "count", violations: "count", clusterFiles: "count",
  bulkFiles: "count", missing: "count", rollouts: "count", beforeIndex: "count", zoneShifted: "count", pairs: "count", contradictions: "count",
  checked: "count", sessions: "count", medianCv: "ratio", repeated: "count", recentDays: "count", spanDays: "count", share: "share", open: "count",
  recent: "count", artifacts: "count",
};
/** The kind of every `values` key: the fixed ones as listed, every C10 `<tool>/<origin>/<window>` a count. */
export const VALUE_KINDS: Readonly<Record<ValueKey, ValueKind>> = (() => {
  const out: Record<string, ValueKind> = {};
  for (const k of Object.keys(VALUE_KEYS) as ValueKey[]) out[k] = Object.hasOwn(FIXED_KINDS, k) ? FIXED_KINDS[k as FixedKey] : "count";
  return out as Record<ValueKey, ValueKind>;
})();

/** A real calendar day "YYYY-MM-DD", years 1970–9999. */
export function isDay(x: unknown): x is string {
  if (typeof x !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(x)) return false;
  const y = Number(x.slice(0, 4)), m = Number(x.slice(5, 7)), d = Number(x.slice(8, 10));
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const len = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return y >= 1970 && len !== undefined && d >= 1 && d <= len;
}

/** True when `x` is a valid value of `kind` (see `ValueKind`). Pure; reads nothing but `x`. */
export function isValueOf(kind: ValueKind, x: unknown): boolean {
  if (kind === "date") return isDay(x);
  if (typeof x !== "number" || !Number.isFinite(x)) return false;
  switch (kind) {
    case "count": return Number.isSafeInteger(x) && x >= 0;
    case "share": return x >= 0 && x <= 1;
    case "corr": return x >= -1 && x <= 1;
    case "ratio": return x >= 0;
  }
}

/** `n`: the evidence the check measured; `tools`: the tools whose data it read (sorted). */
export interface CheckResult { id: CheckId; status: CheckStatus; n: number; reason: Reason; values: CheckValues; askAbout?: string; tools: ToolId[] }

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

/*
 * A stored value a rule compares with a threshold is rounded toward the side its exact value is on, so a result never
 * shows a number on the passing side of a rule it failed (or the failing side of one it passed): down for a rule "below
 * T" or "at least T", up for "above T" or "at most T" (T with at most `digits` decimals).
 */
/** The largest multiple of 10^−digits that is at most `x`. */
export const roundDown = (x: number, digits = 4): number => {
  const f = 10 ** digits, r = Math.round(x * f);
  return (r / f > x ? r - 1 : r) / f;
};
/** The smallest multiple of 10^−digits that is at least `x`. */
export const roundUp = (x: number, digits = 4): number => {
  const f = 10 ** digits, r = Math.round(x * f);
  return (r / f < x ? r + 1 : r) / f;
};
