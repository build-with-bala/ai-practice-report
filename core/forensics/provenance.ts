import type { SessionTable } from "../analysis/types";
import type { ScanResult } from "../scan";
import { toolsOf, type CheckResult } from "./types";

/*
 * C10: provenance, classified only (spec §6.6). Who sent each prompt — the person, a script, a subagent, a schedule —
 * as the tools' own fields record it (`promptSource`, `turnOrigin`, `entrypoint`, `originator`, read into
 * `PromptEv.origin`). It never passes or fails: it shows the mix the other results stand on.
 */

/**
 * C10, `info`: prompt counts by tool × origin × window, keyed `<tool>/<origin>/<window>` in `values`. Prompts in scope
 * only (kept tools, inside the date range); a scripted prompt the dedupe relabelled counts as `human`. n/a without
 * prompts. `n`: the prompts counted.
 */
export function provenance(raw: ScanResult, t: SessionTable): CheckResult {
  const { from, to, tools: excluded } = t.scope;
  const prompts = raw.store.all("prompt").filter((p) => !excluded.has(p.tool) && p.ts >= from && p.ts <= to);
  const tools = toolsOf(prompts);
  if (prompts.length === 0) return { id: "C10", status: "n/a", n: 0, reason: "no-data", values: {}, tools };
  const counts = new Map<string, number>();
  for (const p of prompts) {
    const key = `${p.tool}/${t.isHuman(p) ? "human" : p.origin}/${p.window}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const values: Record<string, number> = {};
  for (const key of [...counts.keys()].sort()) values[key] = counts.get(key)!;
  return { id: "C10", status: "info", n: prompts.length, reason: "classify-only", values, tools };
}
