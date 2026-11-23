import type { ConfigEv, PromptEv } from "../model/events";
import type { ToolId } from "../model/ids";
import type { ScanResult } from "../scan";
import type { SessionRow, SessionTable } from "./types";

/**
 * What the exclusions and the date range leave of the raw data, derived once from `t.scope` and `raw` for every
 * analysis across sessions (globals, artifacts, exposure, the panels):
 * - `inRange`: a time inside the date range; `excluded`: the tools left out;
 * - `kept`: a session that is a kept row and no host copy;
 * - `clip`: a row's start and end, clipped to the date range;
 * - `human`: a human prompt in scope — in the range, of a kept tool, human (`t.isHuman`); a detail prompt also needs a
 *   kept row (the activity rule), a lifetime one no session left out (a session of the store with no row) and no host
 *   copy;
 * - `detailSources`: the sources that report a detail coverage;
 * - `detailRows`: the kept detail-window rows that are no host copy;
 * - `configs`: the config entries of kept tools.
 */
export interface AnalysisScope {
  inRange(ts: number): boolean; excluded: ReadonlySet<ToolId>; kept(sessionId: string): boolean;
  clip(r: SessionRow): { start: number; end: number }; human(p: PromptEv): boolean;
  detailSources: ReadonlySet<string>; detailRows: readonly SessionRow[]; configs: readonly ConfigEv[];
}

export function analysisScope(raw: ScanResult, t: SessionTable): AnalysisScope {
  const { from, to, tools: excluded } = t.scope;
  const inRange = (ts: number): boolean => ts >= from && ts <= to;
  const kept = (sessionId: string): boolean => t.rows.has(sessionId) && !t.hosts.has(sessionId);
  return {
    inRange,
    excluded,
    kept,
    clip: (r) => ({ start: Math.max(r.start, from), end: Math.min(r.end, to) }),
    human: (p) => {
      if (!inRange(p.ts) || excluded.has(p.tool) || !t.isHuman(p)) return false;
      const id = p.sessionId;
      if (p.window === "detail") return id !== undefined && kept(id);
      return id === undefined || ((t.rows.has(id) || raw.store.session(id) === undefined) && !t.hosts.has(id));
    },
    detailSources: new Set(raw.coverage.filter((c) => c.window === "detail").map((c) => c.source)),
    detailRows: [...t.rows.values()].filter((r) => r.window === "detail" && !t.hosts.has(r.id)),
    configs: raw.store.all("config").filter((c) => !excluded.has(c.tool)),
  };
}
