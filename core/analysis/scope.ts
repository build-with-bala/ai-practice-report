import type { ConfigEv, CoverageEv, IdentityEv, PromptEv } from "../model/events";
import type { ToolId } from "../model/ids";
import type { ScanResult } from "../scan";
import type { SessionRow, SessionTable } from "./types";

/**
 * What a prompt needs to be in scope, apart from being human: the facts of the session table it reads.
 * `inStore`: the store holds a session of that id (a row, or one the exclusions left out).
 */
export interface PromptScope {
  inRange(ts: number): boolean; tools: ReadonlySet<ToolId>; projects: ReadonlySet<string>;
  rows: { has(sessionId: string): boolean }; hosts: ReadonlySet<string>; inStore(sessionId: string): boolean;
}

/**
 * The one rule for a prompt in scope (any origin; `human` adds the human test): inside the date range and of a kept tool;
 * - a detail prompt needs a kept row that is no host copy;
 * - a lifetime prompt that names a session the store holds follows that session: in only when it is a kept row and no
 *   host copy (its own `projectKey` is the session's);
 * - any other lifetime prompt (no session, or one whose transcript is gone) is out when it carries an excluded project.
 */
export function promptInScope(p: PromptEv, c: PromptScope): boolean {
  if (!c.inRange(p.ts) || c.tools.has(p.tool)) return false;
  const id = p.sessionId;
  if (p.window === "detail") return id !== undefined && c.rows.has(id) && !c.hosts.has(id);
  if (id !== undefined && c.inStore(id)) return c.rows.has(id) && !c.hosts.has(id);
  return p.projectKey === undefined || !c.projects.has(p.projectKey);
}

/**
 * What the exclusions and the date range leave of the raw data, derived once from `t.scope` and `raw` for every
 * analysis across sessions (globals, artifacts, exposure, the panels):
 * - `inRange`: a time inside the date range; `excluded`: the tools left out;
 * - `kept`: a session that is a kept row and no host copy;
 * - `clip`: a row's start and end, clipped to the date range;
 * - `human`: a human prompt (`t.isHuman`) in scope by `promptInScope`;
 * - `detailSources`: the sources that report a detail coverage;
 * - `detailRows`: the kept detail-window rows that are no host copy;
 * - `configs`: the config entries of kept tools that carry no excluded project.
 */
export interface AnalysisScope {
  inRange(ts: number): boolean; excluded: ReadonlySet<ToolId>; kept(sessionId: string): boolean;
  clip(r: SessionRow): { start: number; end: number }; human(p: PromptEv): boolean;
  detailSources: ReadonlySet<string>; detailRows: readonly SessionRow[]; configs: readonly ConfigEv[];
}

/** The sources that report a detail coverage (their markers are the walk's). */
export function detailSourcesOf(coverage: readonly CoverageEv[]): Set<string> {
  return new Set(coverage.filter((c) => c.window === "detail").map((c) => c.source));
}

/**
 * The one identity rule (the analysis's `identity` and the integrity checks read it): an identity event is in scope when
 * its tool is kept and, for a session-scope one that names a session, that session is a kept row and no host copy.
 */
export function identityInScope(e: IdentityEv, t: SessionTable): boolean {
  if (t.scope.tools.has(e.tool)) return false;
  return e.scope !== "session" || e.sessionId === undefined || (t.rows.has(e.sessionId) && !t.hosts.has(e.sessionId));
}

/**
 * The distinct identity hashes in scope (`identityInScope`), sorted: of kept tools, and for a session-scope hash that names a session, only
 * when that session is a kept row that is no host copy (not excluded by project or date).
 */
export function identityHashes(raw: ScanResult, t: SessionTable): string[] {
  const hashes = new Set<string>();
  for (const e of raw.store.all("identity")) if (identityInScope(e, t)) hashes.add(e.hash);
  return [...hashes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function analysisScope(raw: ScanResult, t: SessionTable): AnalysisScope {
  const { from, to, tools: excluded, projects } = t.scope;
  const inRange = (ts: number): boolean => ts >= from && ts <= to;
  const kept = (sessionId: string): boolean => t.rows.has(sessionId) && !t.hosts.has(sessionId);
  const ps: PromptScope = { inRange, tools: excluded, projects, rows: t.rows, hosts: t.hosts, inStore: (id) => raw.store.session(id) !== undefined };
  return {
    inRange,
    excluded,
    kept,
    clip: (r) => ({ start: Math.max(r.start, from), end: Math.min(r.end, to) }),
    human: (p) => t.isHuman(p) && promptInScope(p, ps),
    detailSources: detailSourcesOf(raw.coverage),
    detailRows: [...t.rows.values()].filter((r) => r.window === "detail" && !t.hosts.has(r.id)),
    configs: raw.store.all("config").filter((c) => !excluded.has(c.tool) && (c.projectKey === undefined || !projects.has(c.projectKey))),
  };
}
