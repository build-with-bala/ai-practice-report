import type { Ev, PromptEv, SessionEv } from "../model/events";
import type { ToolId } from "../model/ids";
import type { ScanResult } from "../scan";
import { activityOf, dayKey } from "./activity";
import { dedupe } from "./dedupe";
import type { Capabilities, Exclusions, SessionRow, SessionTable } from "./types";

/** The event kinds that name a session (`sessionId`): an event of these whose session is not in the store is an orphan. */
const SESSION_KINDS = ["prompt", "tool", "turn", "usage", "totals", "marker", "identity"] as const;
/** The SessionEv fields a row copies when defined. */
const COPIED = ["projectKey", "effort", "background", "agentType", "workflowId", "surface", "mode", "approval", "sandbox", "version"] as const;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Each session's parent: its own `parentId`, else the first (smallest) parent an `EdgeEv` names for it. A link that
 * closes a cycle is dropped: walking up from each session in id order, the first node met twice becomes a root.
 */
function parentLinks(sessions: ReadonlyMap<string, SessionEv>, raw: ScanResult): Map<string, string> {
  const edge = new Map<string, string>();
  for (const e of raw.store.all("edge")) {
    const was = edge.get(e.childId);
    if (was === undefined || e.parentId < was) edge.set(e.childId, e.parentId);
  }
  const parent = new Map<string, string>();
  for (const [id, s] of sessions) {
    const p = s.parentId ?? edge.get(id);
    if (p !== undefined) parent.set(id, p);
  }
  const done = new Set<string>();
  for (const id of [...sessions.keys()].sort(cmp)) {
    const path = new Set<string>();
    let cur: string | undefined = id;
    while (cur !== undefined && sessions.has(cur) && !done.has(cur)) {
      if (path.has(cur)) {
        parent.delete(cur);
        break;
      }
      path.add(cur);
      cur = parent.get(cur);
    }
    for (const p of path) done.add(p);
  }
  return parent;
}

/** Every id in `roots` with all its descendants. */
function withDescendants(roots: Iterable<string>, children: ReadonlyMap<string, string[]>): Set<string> {
  const out = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    for (const c of children.get(id) ?? []) stack.push(c);
  }
  return out;
}

function capabilitiesOf(raw: ScanResult, keep: (tool: ToolId) => boolean): Capabilities {
  const sets = { outcomes: new Set<ToolId>(), lines: new Set<ToolId>(), background: new Set<ToolId>(), usage: new Set<ToolId>(), effort: new Set<ToolId>() };
  for (const t of raw.store.all("tool")) {
    if (!keep(t.tool)) continue;
    if (t.checks !== undefined && t.checks.length > 0 && t.ok !== undefined) sets.outcomes.add(t.tool);
    if ((t.category === "edit" || t.category === "write") && (t.linesAdded !== undefined || t.linesRemoved !== undefined)) sets.lines.add(t.tool);
  }
  for (const s of raw.store.all("session")) {
    if (!keep(s.tool)) continue;
    if (s.background !== undefined) sets.background.add(s.tool);
    if (s.effort !== undefined) sets.effort.add(s.tool);
  }
  for (const u of raw.store.all("usage")) if (keep(u.tool)) sets.usage.add(u.tool);
  for (const t of raw.store.all("turn")) if (keep(t.tool) && t.effort !== undefined) sets.effort.add(t.tool);
  const list = (s: Set<ToolId>): ToolId[] => [...s].sort(cmp);
  return { outcomes: list(sets.outcomes), lines: list(sets.lines), background: list(sets.background), usage: list(sets.usage), effort: list(sets.effort) };
}

/**
 * The session table: the first stage of analysis, pure and synchronous (no clock, no I/O). Rows are the store's sessions
 * placed in their tree; the exclusions drop whole tools, projects (with every descendant session) and sessions that lie
 * outside the date range (with their descendants too: a subagent is part of its session's work). `now` is the analysis
 * time (the caller's, never the clock's); `timeZone` keys the activity days.
 */
export function buildSessionTable(raw: ScanResult, o: { now: number; timeZone: string; exclude?: Exclusions }): SessionTable {
  const ex = o.exclude ?? {};
  const toolEx = new Set<ToolId>(ex.tools ?? []);
  const projEx = new Set<string>(ex.projects ?? []);
  const from = ex.from ?? -Infinity;
  const to = ex.to ?? Infinity;
  const keepTool = (tool: ToolId): boolean => !toolEx.has(tool);
  const inRange = (ts: number): boolean => ts >= from && ts <= to;

  const sessions = new Map<string, SessionEv>();
  for (const s of raw.store.all("session")) sessions.set(s.id, s);
  const parent = parentLinks(sessions, raw);
  const allChildren = new Map<string, string[]>();
  for (const [child, p] of parent) {
    if (!sessions.has(p)) continue;
    const list = allChildren.get(p);
    if (list) list.push(child);
    else allChildren.set(p, [child]);
  }

  // exclusions
  const toolsHit = new Set<ToolId>();
  const projectsHit = new Set<string>();
  const direct: string[] = [];
  const directProject: string[] = [];
  for (const [id, s] of sessions) {
    let drop = false;
    if (toolEx.has(s.tool)) { toolsHit.add(s.tool); drop = true; }
    if (s.projectKey !== undefined && projEx.has(s.projectKey)) { projectsHit.add(s.projectKey); directProject.push(id); drop = true; }
    if (s.end < from || s.start > to) drop = true;
    if (drop) direct.push(id);
  }
  const dropped = withDescendants(direct, allChildren);
  const droppedByProject = withDescendants(directProject, allChildren);

  // rows
  const rows = new Map<string, SessionRow>();
  const topOf = new Map<string, { topId: string; depth: number }>();
  const place = (id: string): { topId: string; depth: number } => {
    const chain: string[] = [];
    let cur = id;
    let base: { topId: string; depth: number } | undefined;
    for (;;) {
      const known = topOf.get(cur);
      if (known) { base = known; break; }
      chain.push(cur);
      const p = parent.get(cur);
      if (p === undefined || !sessions.has(p)) break;
      cur = p;
    }
    let at = base ?? { topId: chain[chain.length - 1]!, depth: -1 }; // the chain's last node is its root (or an orphan)
    for (let i = chain.length - 1; i >= 0; i--) {
      at = { topId: at.topId, depth: at.depth + 1 };
      topOf.set(chain[i]!, at);
    }
    return topOf.get(id)!;
  };
  const repoOf = new Map<string, string>();
  for (const r of [...raw.repos.repos].sort((a, b) => cmp(a.repoKey, b.repoKey))) {
    for (const pk of r.projectKeys) if (!repoOf.has(pk)) repoOf.set(pk, r.repoKey);
  }
  let orphanRows = 0;
  for (const [id, s] of sessions) {
    if (dropped.has(id)) continue;
    const p = parent.get(id);
    const orphan = p !== undefined && !sessions.has(p);
    if (orphan) orphanRows++;
    const { topId, depth } = place(id);
    const row: SessionRow = {
      id, tool: s.tool, source: s.source, window: s.window, origin: s.origin, start: s.start, end: s.end,
      orphan, children: (allChildren.get(id) ?? []).filter((c) => !dropped.has(c)).sort(cmp), depth, topId, models: [...s.models],
    };
    if (p !== undefined) row.parentId = p;
    for (const k of COPIED) if (s[k] !== undefined) (row as unknown as Record<string, unknown>)[k] = s[k];
    if (s.projectKey !== undefined) {
      const repoKey = repoOf.get(s.projectKey);
      if (repoKey !== undefined) row.repoKey = repoKey;
    }
    rows.set(id, row);
  }

  // dedupe
  const prompts = raw.store.all("prompt");
  const d = dedupe(prompts, rows);
  for (const id of d.relabelledSessions) {
    const row = rows.get(id)!;
    if (row.parentId === undefined && row.origin === "scripted") row.origin = "human";
  }
  const isHuman = (p: PromptEv): boolean => p.origin === "human" || d.relabelled.has(p);

  const detailTop = [...rows.values()]
    .filter((r) => r.window === "detail" && r.parentId === undefined && !d.hosts.has(r.id))
    .sort((a, b) => a.start - b.start || cmp(a.id, b.id));

  // orphan events
  const orphans: Partial<Record<Ev["k"], number>> = {};
  if (orphanRows > 0) orphans.session = orphanRows;
  for (const k of SESSION_KINDS) {
    for (const e of raw.store.all(k)) {
      const id = (e as { sessionId?: string }).sessionId;
      if (id === undefined || sessions.has(id) || !keepTool(e.tool)) continue;
      orphans[k] = (orphans[k] ?? 0) + 1;
    }
  }

  // activity: detail prompts need a kept, non-host row; lifetime ones are taken whether or not their session has a row
  const fromDay = Number.isFinite(from) ? dayKey(from, o.timeZone) : undefined;
  const toDay = Number.isFinite(to) ? dayKey(to, o.timeZone) : undefined;
  const activity = activityOf({
    timeZone: o.timeZone,
    detail: prompts.filter((p) => p.window === "detail" && p.sessionId !== undefined && rows.has(p.sessionId)
      && !d.hosts.has(p.sessionId) && inRange(p.ts) && isHuman(p)),
    lifetime: prompts.filter((p) => p.window === "lifetime" && keepTool(p.tool) && inRange(p.ts) && isHuman(p)
      && (p.sessionId === undefined || (!droppedByProject.has(p.sessionId) && !d.hosts.has(p.sessionId)))),
    daily: raw.store.all("daily").filter((e) => keepTool(e.tool) && (fromDay === undefined || e.day >= fromDay) && (toDay === undefined || e.day <= toDay)),
  });

  return {
    rows, detailTop, hosts: d.hosts, repoOf, isHuman, activity, capabilities: capabilitiesOf(raw, keepTool),
    dedupe: { hostSessions: d.hosts.size, pairedPrompts: d.pairedPrompts, relabelled: d.relabelled.size },
    exclusions: { tools: toolsHit.size, projects: projectsHit.size, sessions: dropped.size }, orphans,
  };
}
