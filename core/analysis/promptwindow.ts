import type { ToolId, Window } from "../model/ids";
import type { ScanResult } from "../scan";
import type { SessionTable } from "./types";

/**
 * Which window an analysis that needs prompts reads for each tool, so a prompt both windows hold counts once: a tool with
 * prompts in both windows uses the window with more human prompts (`t.isHuman`), a tie going to `detail`; a tool with
 * prompts in one window maps to that window. Only prompts in scope count: tools the exclusions keep, times inside the
 * date range. Pure: no clock, no I/O.
 */
export function promptWindowByTool(raw: ScanResult, t: SessionTable): Map<ToolId, Window> {
  const { from, to, tools: excluded } = t.scope;
  const counts = new Map<ToolId, { detail: number; lifetime: number; humanDetail: number; humanLifetime: number }>();
  for (const p of raw.store.all("prompt")) {
    if (excluded.has(p.tool) || p.ts < from || p.ts > to) continue;
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
