import type { ToolId, Window } from "../model/ids";
import type { ScanResult } from "../scan";
import { analysisScope } from "./scope";
import type { SessionTable } from "./types";

/**
 * Which window an analysis that needs prompts reads for each tool, so a prompt both windows hold counts once: a tool with
 * prompts in both windows uses the window with more human prompts, a tie going to `detail`; a tool with prompts in one
 * window maps to that window. Only prompts in scope count, by the scope helper's one rule (`analysisScope(raw, t).human`,
 * and the same rule without its human test for the prompts of any origin): a kept tool, inside the date range, a
 * detail prompt only in a kept row with no host copy, a lifetime prompt in no session left out and no host copy. So the
 * prompts that choose a tool's window are exactly those its readers then read: an excluded project, host copies and
 * detail prompts of sessions the store does not hold never sway it. Pure: no clock, no I/O.
 */
export function promptWindowByTool(raw: ScanResult, t: SessionTable): Map<ToolId, Window> {
  const human = analysisScope(raw, t).human;
  const inScope = analysisScope(raw, { ...t, isHuman: () => true }).human;
  const counts = new Map<ToolId, { detail: number; lifetime: number; humanDetail: number; humanLifetime: number }>();
  for (const p of raw.store.all("prompt")) {
    if (!inScope(p)) continue;
    let c = counts.get(p.tool);
    if (!c) counts.set(p.tool, (c = { detail: 0, lifetime: 0, humanDetail: 0, humanLifetime: 0 }));
    const h = human(p);
    if (p.window === "detail") {
      c.detail++;
      if (h) c.humanDetail++;
    } else {
      c.lifetime++;
      if (h) c.humanLifetime++;
    }
  }
  const out = new Map<ToolId, Window>();
  for (const tool of [...counts.keys()].sort()) {
    const c = counts.get(tool)!;
    out.set(tool, c.lifetime === 0 ? "detail" : c.detail === 0 ? "lifetime" : c.humanLifetime > c.humanDetail ? "lifetime" : "detail");
  }
  return out;
}
