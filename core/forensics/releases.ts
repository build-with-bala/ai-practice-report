import type { SessionTable } from "../analysis/types";
import type { ToolId } from "../model/ids";
import type { ScanResult } from "../scan";
import shipped from "./releases.json" with { type: "json" };
import { forensicScope, type ForensicScope } from "./scope";
import { asked } from "./questions";
import type { CheckResult, CheckValues } from "./types";

/*
 * C9: no session used a model or tool version before it was publicly released. The release table ships with each
 * release of this tool (`releases.json`, imported as JSON so a compiled binary carries it) and lists only entries whose
 * public release date is certain, each with a public source; a model or version it does not list is not checked.
 */

/** `match`: a RegExp source a model id is tested with; `released`: the public release day (UTC, "YYYY-MM-DD"). */
export interface ReleaseTable { version: number; models: Array<{ match: string /* RegExp source */; released: string /* YYYY-MM-DD */; source: string }>;
  tools: Partial<Record<ToolId, Array<{ version: string; released: string; source: string }>>> }

/** The table shipped with this release. */
export const RELEASES: ReleaseTable = shipped as ReleaseTable;

const DAY_MS = 86_400_000;
const TOL_MS = 2 * DAY_MS;
const FAR_MS = 30 * DAY_MS;
const FAIL_MIN = 3;
const FAIL_SHARE = 0.01;

const dayMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);

/**
 * The earliest time inside the date range each model is carried by an event of the session (its turns' and usage
 * records' `model`).
 */
function firstUses(raw: ScanResult, sessionId: string, s: ForensicScope): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of [...raw.store.forSession(sessionId, "turn"), ...raw.store.forSession(sessionId, "usage")]) {
    if (e.model === undefined || !s.inRange(e.ts)) continue;
    const was = out.get(e.model);
    if (was === undefined || e.ts < was) out.set(e.model, e.ts);
  }
  return out;
}

/**
 * C9 over the session rows in scope (`ForensicScope.rows`: kept rows, no host copy). Each model of a row is checked
 * against the first table entry whose pattern matches it, and the row's version against its tool's entry of that exact
 * version. A check compares the release day with the model's first use in the session (the earliest of its events
 * inside the date range that carries the model), so a thread resumed after a release with the new model is not taken
 * for an early one; where no event carries it (a version, a model only the session row names), with the row's end. It
 * is violated when that time is more than 2 days before the release day. Any violation → warn (`before-release`): early
 * access is real, so a question. At least max(3, 1% of the dated sessions — the rows with a check) used a model or
 * version more than 30 days before its release → fail (`long-before-release`). n/a when nothing matched. `values`:
 * `checked` (the checks made), `violations`, `sessions` (the rows with a violation), `longBefore` (the rows more than
 * 30 days early). The result names no model or version: counts only.
 */
export function checkReleases(t: SessionTable, table: ReleaseTable, raw: ScanResult, s: ForensicScope = forensicScope(raw, t)): CheckResult {
  const models = table.models.map((m) => ({ re: new RegExp(m.match), at: dayMs(m.released) }));
  let checked = 0, violations = 0, dated = 0;
  const violating = new Set<string>(), far = new Set<string>();
  const tools = new Set<ToolId>();
  for (const row of s.rows()) {
    const checks: { at: number; used: number }[] = [];
    let uses: Map<string, number> | undefined;
    for (const model of row.models) {
      const hit = models.find((m) => m.re.test(model));
      if (!hit) continue;
      uses ??= firstUses(raw, row.id, s);
      checks.push({ at: hit.at, used: uses.get(model) ?? row.end });
    }
    if (row.version !== undefined) {
      const hit = table.tools[row.tool]?.find((v) => v.version === row.version);
      if (hit) checks.push({ at: dayMs(hit.released), used: row.end });
    }
    if (checks.length > 0) {
      tools.add(row.tool);
      dated++;
    }
    for (const c of checks) {
      checked++;
      if (c.used < c.at - TOL_MS) {
        violations++;
        violating.add(row.id);
      }
      if (c.used < c.at - FAR_MS) far.add(row.id);
    }
  }
  const base = { id: "C9" as const, n: checked, tools: [...tools].sort() };
  if (checked === 0) return { ...base, status: "n/a", reason: "no-match", values: {} };
  const values = { checked, violations, sessions: violating.size, longBefore: far.size } satisfies CheckValues;
  if (violations === 0) return { ...base, status: "pass", reason: "ok", values };
  if (far.size >= Math.max(FAIL_MIN, FAIL_SHARE * dated)) return asked({ ...base, status: "fail", reason: "long-before-release", values });
  return asked({ ...base, status: "warn", reason: "before-release", values });
}
