import type { SessionTable } from "../analysis/types";
import type { ToolId } from "../model/ids";
import shipped from "./releases.json" with { type: "json" };
import type { CheckResult } from "./types";

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

const dayMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);

/**
 * C9 over the session rows. Each model of a row is checked against the first table entry whose pattern matches it, and
 * the row's version against its tool's entry of that exact version. A check is violated when the row starts more than
 * 2 days before the entry's release day. Any violation → fail; n/a when nothing matched. `values`: `checked` (the checks
 * made), `violations`, `sessions` (the rows with one). The result names no model or version: counts only.
 */
export function checkReleases(t: SessionTable, table: ReleaseTable): CheckResult {
  const models = table.models.map((m) => ({ re: new RegExp(m.match), at: dayMs(m.released) }));
  let checked = 0, violations = 0;
  const violating = new Set<string>();
  const tools = new Set<ToolId>();
  for (const row of t.rows.values()) {
    const dates: number[] = [];
    for (const model of row.models) {
      const hit = models.find((m) => m.re.test(model));
      if (hit) dates.push(hit.at);
    }
    if (row.version !== undefined) {
      const hit = table.tools[row.tool]?.find((v) => v.version === row.version);
      if (hit) dates.push(dayMs(hit.released));
    }
    if (dates.length > 0) tools.add(row.tool);
    for (const at of dates) {
      checked++;
      if (row.start < at - TOL_MS) {
        violations++;
        violating.add(row.id);
      }
    }
  }
  const base = { id: "C9" as const, n: checked, tools: [...tools].sort() };
  if (checked === 0) return { ...base, status: "n/a", reason: "no-match", values: {} };
  const values = { checked, violations, sessions: violating.size };
  if (violations === 0) return { ...base, status: "pass", reason: "ok", values };
  const s = violating.size;
  return { ...base, status: "fail", reason: "before-release", values,
    askAbout: `${s} ${s === 1 ? "session" : "sessions"} used a model or tool version more than 2 days before its public release. Were session times edited?` };
}
