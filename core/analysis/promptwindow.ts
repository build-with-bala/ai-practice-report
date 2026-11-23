import type { ToolId, Window } from "../model/ids";
import type { ScanResult } from "../scan";
import { analysisScope } from "./scope";
import type { SessionTable } from "./types";

/**
 * Which window an analysis that needs prompts reads for each tool, so a prompt both windows hold counts once: a tool with
 * prompts in both windows uses the window with more human prompts (`t.isHuman`), a tie going to `detail`; a tool with
 * prompts in one window maps to that window. Only prompts the exclusions leave count (the scope helper's `excluded`
 * and `inRange`, `analysisScope`): tools the exclusions keep, times inside the date range, and no session the
 * exclusions dropped — a prompt naming a session the store holds counts only when that session is a row, so an
 * excluded project's prompts never sway a tool's window. Prompts with no session or an orphan one count, and host
 * copies (rows the dedupe found, not an exclusion) count, so with no exclusion every prompt counts. Pure: no clock, no
 * I/O.
 */
export function promptWindowByTool(raw: ScanResult, t: SessionTable): Map<ToolId, Window> {
  const s = analysisScope(raw, t);
  const counts = new Map<ToolId, { detail: number; lifetime: number; humanDetail: number; humanLifetime: number }>();
  for (const p of raw.store.all("prompt")) {
    if (s.excluded.has(p.tool) || !s.inRange(p.ts)) continue;
    if (p.sessionId !== undefined && !t.rows.has(p.sessionId) && raw.store.session(p.sessionId) !== undefined) continue;
    let c = counts.get(p.tool);
    if (!c) counts.set(p.tool, (c = { detail: 0, lifetime: 0, humanDetail: 0, humanLifetime: 0 }));
    const human = t.isHuman(p);
    if (p.window === "detail") {
      c.detail++;
      if (human) c.humanDetail++;
    } else {
      c.lifetime++;
      if (human) c.humanLifetime++;
    }
  }
  const out = new Map<ToolId, Window>();
  for (const tool of [...counts.keys()].sort()) {
    const c = counts.get(tool)!;
    out.set(tool, c.lifetime === 0 ? "detail" : c.detail === 0 ? "lifetime" : c.humanLifetime > c.humanDetail ? "lifetime" : "detail");
  }
  return out;
}
