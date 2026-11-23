import type { PromptEv } from "../model/events";
import type { ToolId, Window } from "../model/ids";
import type { ScanResult } from "../scan";
import { fixedMetric, Span } from "../signals/types";
import { dayEnd, dayKey, dayStart, isoWeek } from "./activity";
import { promptWindowByTool } from "./promptwindow";
import type { Metric, SessionRow, SessionTable } from "./types";
import { isAction } from "./walk";

export type Feature = "subagents" | "workflows" | "background-agents" | "plan-mode" | "skills" | "mcp" | "headless" | "parallel-sessions"
  | "model-switching" | "manual-compaction";
export type PromptArc = "1" | "2-3" | "4-10" | "11-30" | "31+";
export type DurationArc = "<10m" | "10-60m" | "1-4h" | ">4h";

/**
 * What the person has done with AI tools, shown and never scored (spec §6.5 unscored panels). Model counts are private:
 * `panels().privateModels` (pre-flight P13).
 * - `tenureWeeks`: the ISO weeks from the first lifetime active day's week through now's week (or the date range's
 *   last day, when earlier), inclusive; `n` = lifetime active days. `activeWeeks`: each window's active ISO weeks,
 *   `n` = its active days. Both read `Activity` only: days with a human prompt (spec §6.2).
 * - `weekly`: the 52 ISO weeks ending at now's week, oldest first. `activeDays` = lifetime active days in the week;
 *   `detailPrompts` and `lifetimePrompts` = human prompts in scope of the tools whose prompt window
 *   (`promptWindowByTool`) is that window, so no prompt counts in both columns.
 * - `tools`: per tool and window (sorted), the top-level sessions (kept rows with no parent, no host copy), the human
 *   prompts in scope and the actions (walk rule 2) of every kept row, inside the date range; `from`/`to` span the
 *   sessions (clipped to the range) and the prompts.
 * - `rotation`: tools with an active day (either window) in the 90 days up to now's day, and with any active day.
 * - `arcs`: per top-level session with at least one human prompt of its tool's prompt window (prompts of descendants
 *   count toward their top), its prompt count and its duration (end − start, clipped to the range).
 * - `firstSeen`: epoch ms of each feature's first evidence in scope (kept rows, kept tools, inside the date range;
 *   proxy-timed markers never count); a feature with none is absent.
 */
export interface Exposure {
  tenureWeeks: Metric; activeWeeks: { detail: Metric; lifetime: Metric };
  weekly: Array<{ week: string; activeDays: number; detailPrompts: number; lifetimePrompts: number }>;
  tools: Array<{ tool: ToolId; window: Window; sessions: number; prompts: number; actions: number; from?: number; to?: number }>;
  rotation: { active90d: ToolId[]; ever: ToolId[] };
  arcs: { prompts: Record<PromptArc, number>; medianPrompts: number | null; durations: Record<DurationArc, number> };
  firstSeen: Partial<Record<Feature, number>>;
}

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const MIN_MS = 60_000;
const WEEKS = 52;
const ROTATION_DAYS = 90;
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Whether a prompt is a human prompt in scope: in the date range, of a kept tool, human (`t.isHuman`); a detail prompt
 * also needs a kept row that is no host copy (the activity rule), a lifetime one no session left out (a session of the
 * store with no row) and no host copy. Shared by exposure and the panels.
 */
export function humanInScope(raw: ScanResult, t: SessionTable): (p: PromptEv) => boolean {
  const { from, to, tools: excluded } = t.scope;
  return (p) => {
    if (p.ts < from || p.ts > to || excluded.has(p.tool) || !t.isHuman(p)) return false;
    const id = p.sessionId;
    if (p.window === "detail") return id !== undefined && t.rows.has(id) && !t.hosts.has(id);
    return id === undefined || ((t.rows.has(id) || raw.store.session(id) === undefined) && !t.hosts.has(id));
  };
}

/** Monday of a day's ISO week, as a week index since the epoch's first Monday (1970-01-05). */
function weekIndex(day: string): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const ms = Date.UTC(y, m - 1, d);
  const weekday = (new Date(ms).getUTCDay() + 6) % 7;
  return Math.round((ms - weekday * DAY_MS - Date.UTC(1970, 0, 5)) / WEEK_MS);
}
const dayOfUtc = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The 52 ISO week keys ending at the week of `day`, oldest first. */
function lastWeeks(day: string): string[] {
  const monday = Date.UTC(1970, 0, 5) + weekIndex(day) * WEEK_MS;
  const out: string[] = [];
  for (let i = WEEKS - 1; i >= 0; i--) out.push(isoWeek(dayOfUtc(monday - i * WEEK_MS)));
  return out;
}

const promptArc = (n: number): PromptArc => (n <= 1 ? "1" : n <= 3 ? "2-3" : n <= 10 ? "4-10" : n <= 30 ? "11-30" : "31+");
const durationArc = (ms: number): DurationArc => (ms < 10 * MIN_MS ? "<10m" : ms < 60 * MIN_MS ? "10-60m" : ms <= 240 * MIN_MS ? "1-4h" : ">4h");

/** A window's active-weeks metric: the weeks' count, `n` = active days, spanning the first to the last day. */
function weeksMetric(window: Window, days: readonly string[], weeks: number, sources: Iterable<string>, timeZone: string): Metric {
  const span = days.length > 0 ? { from: dayStart(days[0]!, timeZone), to: dayEnd(days[days.length - 1]!, timeZone) } : undefined;
  return fixedMetric(window, [...new Set(sources)].sort(cmp), days.length, days.length > 0 ? weeks : null, "no-data", span);
}

/** Exposure (see `Exposure`). Pure and synchronous: `now` and `timeZone` are the caller's; `firstParallelBucket` comes from `Globals` (pre-flight P14). */
export function exposure(t: SessionTable, raw: ScanResult, o: { now: number; timeZone: string; firstParallelBucket?: number }): Exposure {
  const { from, to, tools: excluded } = t.scope;
  const inRange = (ts: number): boolean => ts >= from && ts <= to;
  const kept = (id: string): boolean => t.rows.has(id) && !t.hosts.has(id);
  const a = t.activity;
  const tz = o.timeZone;
  const nowDay = dayKey(o.now, tz);

  // tenure and active weeks
  const lifetimeSources = new Set<string>();
  for (const v of Object.values(a.byTool)) for (const s of v?.lifetimeSources ?? []) lifetimeSources.add(s);
  const human = humanInScope(raw, t);
  const detailSources = new Set<string>();
  const windowOf = promptWindowByTool(raw, t);
  const weekKeys = lastWeeks(nowDay);
  const weekAt = new Map(weekKeys.map((w, i) => [w, i]));
  const weekly = weekKeys.map((week) => ({ week, activeDays: 0, detailPrompts: 0, lifetimePrompts: 0 }));
  for (const day of a.lifetimeDays) {
    const i = weekAt.get(isoWeek(day));
    if (i !== undefined) weekly[i]!.activeDays++;
  }

  // one pass over the prompts: weekly, tools, arcs
  type ToolAcc = { sessions: number; prompts: number; actions: number; span: Span };
  const perTool = new Map<string, ToolAcc>();
  const accOf = (tool: ToolId, window: Window): ToolAcc => {
    const key = `${tool}\u0000${window}`;
    let x = perTool.get(key);
    if (!x) perTool.set(key, (x = { sessions: 0, prompts: 0, actions: 0, span: new Span() }));
    return x;
  };
  const arcPrompts = new Map<string, number>(); // top row id → prompts
  for (const p of raw.store.all("prompt")) {
    if (!human(p)) continue;
    if (p.window === "detail") detailSources.add(p.source);
    const acc = accOf(p.tool, p.window);
    acc.prompts++;
    acc.span.addTs(p.ts);
    if (windowOf.get(p.tool) !== p.window) continue;
    const i = weekAt.get(isoWeek(dayKey(p.ts, tz)));
    if (i !== undefined) weekly[i]![p.window === "detail" ? "detailPrompts" : "lifetimePrompts"]++;
    const row = p.sessionId === undefined ? undefined : t.rows.get(p.sessionId);
    if (row && kept(row.topId)) arcPrompts.set(row.topId, (arcPrompts.get(row.topId) ?? 0) + 1);
  }
  const clip = (r: SessionRow): { start: number; end: number } => ({ start: Math.max(r.start, from), end: Math.min(r.end, to) });
  for (const r of t.rows.values()) {
    if (t.hosts.has(r.id)) continue;
    const acc = accOf(r.tool, r.window);
    if (r.parentId === undefined) {
      acc.sessions++;
      const c = clip(r);
      acc.span.addTs(c.start);
      acc.span.addTs(c.end);
    }
    for (const e of raw.store.forSession(r.id, "tool")) if (inRange(e.ts) && isAction(e)) acc.actions++;
  }
  const tools: Exposure["tools"] = [...perTool.entries()]
    .sort(([x], [y]) => cmp(x, y))
    .map(([key, acc]) => {
      const [tool, window] = key.split("\u0000") as [ToolId, Window];
      return { tool, window, sessions: acc.sessions, prompts: acc.prompts, actions: acc.actions, ...acc.span.range() };
    });

  // arcs
  const prompts: Record<PromptArc, number> = { "1": 0, "2-3": 0, "4-10": 0, "11-30": 0, "31+": 0 };
  const durations: Record<DurationArc, number> = { "<10m": 0, "10-60m": 0, "1-4h": 0, ">4h": 0 };
  const counts: number[] = [];
  for (const [id, n] of arcPrompts) {
    prompts[promptArc(n)]++;
    counts.push(n);
    const c = clip(t.rows.get(id)!);
    durations[durationArc(Math.max(0, c.end - c.start))]++;
  }
  counts.sort((x, y) => x - y);
  const mid = counts.length >> 1;
  const medianPrompts = counts.length === 0 ? null : counts.length % 2 === 1 ? counts[mid]! : (counts[mid - 1]! + counts[mid]!) / 2;

  // tenure: the first lifetime day's week through now's week (or the range's last day, when earlier)
  const lifetimeDays = a.lifetimeDays;
  let tenure: number | null = null;
  if (lifetimeDays.length > 0) {
    const last = lifetimeDays[lifetimeDays.length - 1]!;
    const endDay = Number.isFinite(to) && to < o.now ? dayKey(to, tz) : nowDay;
    tenure = Math.max(weekIndex(endDay), weekIndex(last)) - weekIndex(lifetimeDays[0]!) + 1;
  }
  const lifetimeSpan = lifetimeDays.length > 0 ? { from: dayStart(lifetimeDays[0]!, tz), to: dayEnd(lifetimeDays[lifetimeDays.length - 1]!, tz) } : undefined;

  // rotation
  const since = dayKey(o.now - ROTATION_DAYS * DAY_MS, tz);
  const ever: ToolId[] = [];
  const active90d: ToolId[] = [];
  for (const tool of (Object.keys(a.byTool) as ToolId[]).sort(cmp)) {
    const days = [...(a.byTool[tool]?.detailDays ?? []), ...(a.byTool[tool]?.lifetimeDays ?? [])];
    if (days.length === 0) continue;
    ever.push(tool);
    if (days.some((d) => d >= since && d <= nowDay)) active90d.push(tool);
  }

  return {
    tenureWeeks: fixedMetric("lifetime", [...lifetimeSources].sort(cmp), lifetimeDays.length, tenure, "no-data", lifetimeSpan),
    activeWeeks: {
      detail: weeksMetric("detail", a.detailDays, a.detailWeeks.length, detailSources, tz),
      lifetime: weeksMetric("lifetime", lifetimeDays, a.lifetimeWeeks.length, lifetimeSources, tz),
    },
    weekly, tools, rotation: { active90d, ever },
    arcs: { prompts, medianPrompts, durations },
    firstSeen: firstSeen(t, raw, inRange, excluded, o.firstParallelBucket),
  };
}

/** Each feature's first evidence in scope (the table in `Exposure`); see `exposure`. */
function firstSeen(t: SessionTable, raw: ScanResult, inRange: (ts: number) => boolean, excluded: ReadonlySet<ToolId>,
  firstParallelBucket: number | undefined): Partial<Record<Feature, number>> {
  const out: Partial<Record<Feature, number>> = {};
  const see = (f: Feature, ts: number): void => {
    if (!Number.isFinite(ts) || !inRange(ts)) return;
    const was = out[f];
    if (was === undefined || ts < was) out[f] = ts;
  };
  const counted = (sessionId: string | undefined): boolean =>
    sessionId === undefined ? true : raw.store.session(sessionId) === undefined || (t.rows.has(sessionId) && !t.hosts.has(sessionId));
  for (const r of t.rows.values()) {
    if (t.hosts.has(r.id)) continue;
    const start = Math.max(r.start, t.scope.from);
    if (r.parentId !== undefined || r.origin === "subagent") see("subagents", start);
    if (r.workflowId !== undefined) see("workflows", start);
    if (r.background === true) see("background-agents", start);
    if (r.parentId === undefined && (r.origin === "scripted" || r.origin === "scheduled")) see("headless", start);
  }
  for (const e of raw.store.all("tool")) {
    if (excluded.has(e.tool) || !t.rows.has(e.sessionId) || t.hosts.has(e.sessionId)) continue;
    if (e.category === "plan") see("plan-mode", e.ts);
    if (e.category === "skill") see("skills", e.ts);
    if (e.category === "mcp" || e.mcpServer !== undefined) see("mcp", e.ts);
  }
  for (const m of raw.store.all("marker")) {
    if (excluded.has(m.tool) || m.proxyTs === true || !counted(m.sessionId)) continue;
    if (m.kind === "plan-enter" || m.kind === "plan-exit" || m.kind === "plan-artifact") see("plan-mode", m.ts);
    else if (m.kind === "model-switch") see("model-switching", m.ts);
    else if (m.kind === "compact-manual") see("manual-compaction", m.ts);
  }
  for (const c of raw.store.all("config")) {
    if (c.kind === "skill" && !excluded.has(c.tool) && c.firstSeen !== undefined) see("skills", c.firstSeen);
  }
  if (firstParallelBucket !== undefined) see("parallel-sessions", firstParallelBucket);
  return out;
}
