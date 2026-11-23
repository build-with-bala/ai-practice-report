import type { SessionTable } from "../analysis/types";
import type { ScanResult } from "../scan";
import { forensicScope, type ForensicScope } from "./scope";
import { toolsOf, type CheckResult, type CheckValues, type ProvenanceKey } from "./types";

/*
 * C10: provenance, classified only (spec §6.6). Who sent each prompt — the person, a script, a subagent, a schedule —
 * as the tools' own fields record it (`promptSource`, `turnOrigin`, `entrypoint`, `originator`, read into
 * `PromptEv.origin`). It never passes or fails: it shows the mix the other results stand on.
 */

/**
 * C10, `info`: prompt counts by tool × origin × window, keyed `<tool>/<origin>/<window>` in `values`. Prompts in scope
 * only (`ForensicScope.prompt`: kept tools, inside the date range, no session left out, no host copy); a scripted
 * prompt the dedupe relabelled counts as `human`. n/a without prompts. `n`: the prompts counted.
 */
export function provenance(raw: ScanResult, t: SessionTable, s: ForensicScope = forensicScope(raw, t)): CheckResult {
  const prompts = s.prompts();
  const tools = toolsOf(prompts);
  if (prompts.length === 0) return { id: "C10", status: "n/a", n: 0, reason: "no-data", values: {}, tools };
  const counts = new Map<ProvenanceKey, number>();
  for (const p of prompts) {
    const key: ProvenanceKey = `${p.tool}/${t.isHuman(p) ? "human" : p.origin}/${p.window}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const values: CheckValues = {};
  for (const key of [...counts.keys()].sort()) values[key] = counts.get(key)!;
  return { id: "C10", status: "info", n: prompts.length, reason: "classify-only", values, tools };
}
