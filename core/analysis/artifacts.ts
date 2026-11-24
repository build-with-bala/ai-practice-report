import type { ConfigEv } from "../model/events";
import type { ScanResult } from "../scan";
import { keyedHash } from "../text/hash";
import { analysisScope, type AnalysisScope } from "./scope";
import type { SessionTable } from "./types";
import { inScope } from "./walk";

/** The config kinds that are artifacts a person uses: skills, commands, agents, plugins and MCP servers. */
export const ARTIFACT_KINDS: ReadonlySet<ConfigEv["kind"]> = new Set<ConfigEv["kind"]>(["skill", "command", "agent", "plugin", "mcp-server"]);

/** Provenance precedence: an authored entry wins over an installed one, then bundled, then unknown. */
const PROVENANCE: readonly ConfigEv["provenance"][] = ["authored", "installed", "bundled", "unknown"];

/**
 * One distinct (kind, name) artifact config entry of a kept tool. `used`: at least one entry of it, or an event, shows
 * use. `provenance`: the winning provenance (authored, then installed, bundled, unknown) among the entries that show
 * use, or among all its entries when it is unused. `firstSeen`: the earliest `firstSeen` of its entries, when known
 * (state read at scan time, never activity). `sources` (sorted): for a used artifact, the config sources of the
 * entries that show use plus the source of each event that evidenced it; for an unused one, its entries' sources.
 */
export interface ArtifactUse { kind: ConfigEv["kind"]; name: string; provenance: ConfigEv["provenance"]; firstSeen?: number; used: boolean; sources: string[] }

const better = (a: ConfigEv["provenance"], b: ConfigEv["provenance"]): ConfigEv["provenance"] => (PROVENANCE.indexOf(a) <= PROVENANCE.indexOf(b) ? a : b);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Which artifacts are in use: one record per distinct (kind, name) entry of `ARTIFACT_KINDS`, sorted by kind and name.
 * Pure: no clock, no I/O.
 *
 * "Used at least once" is a lifetime predicate. Evidence of use: the entry's own `uses` counter, an MCP call naming it,
 * or a custom child of its type. Dated evidence (the calls, the children) obeys the date range and the exclusions: a
 * call inside the range, of a kept detail row; a child only when it is in scope (`inScope`, the walk's rule). Undated
 * usage counters are state read at scan time: a date range cannot limit them, and they are not clipped.
 */
export function artifactUse(raw: ScanResult, t: SessionTable, s: AnalysisScope = analysisScope(raw, t)): ArtifactUse[] {
  const evidence = new Map<string, Set<string>>(); // evidence key → the sources of the events that supplied it
  const addEvidence = (key: string, source: string): void => {
    const set = evidence.get(key);
    if (set) set.add(source);
    else evidence.set(key, new Set([source]));
  };
  for (const e of raw.store.all("tool")) {
    if (e.mcpServer !== undefined && !s.excluded.has(e.tool) && s.inRange(e.ts) && s.kept(e.sessionId) && t.rows.get(e.sessionId)!.window === "detail") {
      addEvidence(`mcp-server\u0000${e.mcpServer}`, e.source);
    }
  }
  const markersOf = (id: string) => raw.store.forSession(id, "marker").filter((m) => s.detailSources.has(m.source) && s.inRange(m.ts));
  for (const row of s.detailRows) {
    if (row.agentType === undefined || row.parentId === undefined || !inScope(row, t, raw.store, markersOf)) continue;
    addEvidence(`agent\u0000${row.agentType}`, row.source);
  }

  interface Acc { kind: ConfigEv["kind"]; name: string; any: ConfigEv["provenance"]; anySources: Set<string>; firstSeen?: number;
    used?: ConfigEv["provenance"]; sources: Set<string> }
  const acc = new Map<string, Acc>();
  for (const c of s.configs) {
    if (!ARTIFACT_KINDS.has(c.kind) || c.name === undefined) continue;
    const key = `${c.kind}\u0000${c.name}`;
    let a = acc.get(key);
    if (!a) acc.set(key, (a = { kind: c.kind, name: c.name, any: c.provenance, anySources: new Set(), sources: new Set() }));
    a.any = better(a.any, c.provenance);
    a.anySources.add(c.source);
    if (c.firstSeen !== undefined && Number.isFinite(c.firstSeen) && (a.firstSeen === undefined || c.firstSeen < a.firstSeen)) a.firstSeen = c.firstSeen;
    const seen = c.kind === "mcp-server" ? evidence.get(`mcp-server\u0000${c.name}`)
      : c.kind === "agent" ? new Set([...(evidence.get(`agent\u0000${keyedHash(raw.salt, c.name)}`) ?? []), ...(evidence.get(`agent\u0000${c.name}`) ?? [])])
      : undefined;
    const byEvent = seen !== undefined && seen.size > 0;
    if (!((c.uses ?? 0) > 0) && !byEvent) continue;
    a.used = a.used === undefined ? c.provenance : better(a.used, c.provenance);
    a.sources.add(c.source);
    if (byEvent) for (const src of seen!) a.sources.add(src);
  }

  return [...acc.values()]
    .sort((x, y) => cmp(x.kind, y.kind) || cmp(x.name, y.name))
    .map((a) => {
      const used = a.used !== undefined;
      const r: ArtifactUse = { kind: a.kind, name: a.name, provenance: used ? a.used! : a.any, used, sources: [...(used ? a.sources : a.anySources)].sort(cmp) };
      if (a.firstSeen !== undefined) r.firstSeen = a.firstSeen;
      return r;
    });
}
