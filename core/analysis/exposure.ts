import type { ToolId, Window } from "../model/ids";
import type { ScanResult } from "../scan";
import { fixedMetric, Span } from "../signals/types";
import { dayEnd, dayKey, dayStart, isoWeek } from "./activity";
import { promptWindowByTool } from "./promptwindow";
import { analysisScope, type AnalysisScope } from "./scope";
import { isTopLevel, type Metric, type SessionTable } from "./types";
import { isAction } from "./walk";

export type Feature = "subagents" | "workflows" | "background-agents" | "plan-mode" | "skills" | "mcp" | "headless" | "parallel-sessions"
  | "model-switching" | "manual-compaction";
export type PromptArc = "1" | "2-3" | "4-10" | "11-30" | "31+";
export type DurationArc = "<10m" | "10-60m" | "1-4h" | ">4h";

/**
 * What the person has done with AI tools, shown and never scored (spec §6.5 unscored panels). Model counts are private:
 * `panels().privateModels` (pre-flight P13).
 * - `tenureWeeks`: the ISO weeks from the first active day's week through now's week (or the date range's last day,
 *   when earlier), inclusive, from the lifetime days whenever there are any, else from the detail days (window
 *   `detail`, with the detail sources); `n` = those active days; `to` = the end the value counts to. `activeWeeks`:
 *   each window's active ISO weeks, `n` = its active days. Both read `Activity` only: days with a human prompt (§6.2).
 * - `weekly`: the 52 ISO weeks ending at now's week, oldest first, less the weeks that lie wholly outside the date
 *   range (before the week of its start, after the week of its end). `activeDays` = the distinct days of the week in the
 *   union over tools of each tool's active days in its prompt window (`promptWindowByTool`; a tool with no prompts,
 *   only daily totals, its lifetime days): a union of day sets, never a sum of windows, and no tool gives both.
 *   `detailPrompts` and `lifetimePrompts` = human prompts in scope of the tools whose prompt window is that window, so
 *   no prompt counts in both columns.
 * - `tools`: per tool and window (sorted), the top-level sessions (kept rows with no parent, no host copy, started by a
 *   person, a script or a schedule: `isTopLevel`; delegated rows count as subagent work), the human
 *   prompts in scope and the actions (walk rule 2) of every kept row, inside the date range; `from`/`to` span the
 *   sessions (clipped to the range) and the prompts.
 * - `rotation`: tools with an active day (either window) among the 90 day keys ending at now's day, and with any.
 * - `arcs`: per top-level session with at least one human prompt of its tool's prompt window (prompts of descendants
 *   count toward their top), its prompt count and its duration (end − start, clipped to the range). Arcs follow the
 *   prompt window: for a tool read from its lifetime window, only lifetime prompts of sessions that still have a row
 *   make arcs (a history prompt with no session row has no session to belong to).
 * - `firstSeen`: epoch ms of each feature's first evidence in scope (kept rows, kept tools, inside the date range;
 *   proxy-timed markers never count); a feature with none is absent. A row's evidence is its start, or — for a row
 *   that started before the date range — its first event inside the range (none: no evidence).
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
  const scope = analysisScope(raw, t);
  const { inRange, kept, clip, human } = scope;
  const a = t.activity;
  const tz = o.timeZone;
  const nowDay = dayKey(o.now, tz);

  // tenure and active weeks
  const lifetimeSources = new Set<string>();
  for (const v of Object.values(a.byTool)) for (const s of v?.lifetimeSources ?? []) lifetimeSources.add(s);
  const detailSources = new Set<string>();
  const windowOf = promptWindowByTool(raw, t);
  // the weeks of the date range only: a week wholly outside it is no week of the report, not a week of zeros
  const firstWeek = Number.isFinite(t.scope.from) ? isoWeek(dayKey(t.scope.from, tz)) : undefined;
  const lastWeek = Number.isFinite(t.scope.to) ? isoWeek(dayKey(t.scope.to, tz)) : undefined;
  const weekKeys = lastWeeks(nowDay).filter((w) => (firstWeek === undefined || w >= firstWeek) && (lastWeek === undefined || w <= lastWeek));
  const weekAt = new Map(weekKeys.map((w, i) => [w, i]));
  const weekly = weekKeys.map((week) => ({ week, activeDays: 0, detailPrompts: 0, lifetimePrompts: 0 }));
  const weeklyDays = new Set<string>();
  for (const [tool, v] of Object.entries(a.byTool) as [ToolId, NonNullable<(typeof a.byTool)[ToolId]>][]) {
    for (const day of windowOf.get(tool) === "detail" ? v.detailDays : v.lifetimeDays) weeklyDays.add(day);
  }
  for (const day of weeklyDays) {
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
  for (const r of t.rows.values()) {
    if (t.hosts.has(r.id)) continue;
    const acc = accOf(r.tool, r.window);
    if (isTopLevel(r)) {
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

  // tenure: the first active day's week through now's week (or the range's last day, when earlier); lifetime days
  // whenever there are any, else the detail days
  const lifetimeDays = a.lifetimeDays;
  const tenureWindow: Window = lifetimeDays.length > 0 || a.detailDays.length === 0 ? "lifetime" : "detail";
  const tenureDays = tenureWindow === "lifetime" ? lifetimeDays : a.detailDays;
  let tenure: number | null = null;
  let tenureSpan: { from: number; to: number } | undefined;
  if (tenureDays.length > 0) {
    const last = tenureDays[tenureDays.length - 1]!;
    const endAt = Math.min(o.now, t.scope.to); // the end the value counts to: now, or the range's end when earlier
    const endDay = dayKey(endAt, tz);
    tenure = Math.max(weekIndex(endDay), weekIndex(last)) - weekIndex(tenureDays[0]!) + 1;
    tenureSpan = { from: dayStart(tenureDays[0]!, tz), to: Math.max(endAt, dayEnd(last, tz)) };
  }

  // rotation
  const [ny, nm, nd] = nowDay.split("-").map(Number) as [number, number, number];
  const since = dayOfUtc(Date.UTC(ny, nm - 1, nd) - (ROTATION_DAYS - 1) * DAY_MS); // 90 day keys, now's day the last
  const ever: ToolId[] = [];
  const active90d: ToolId[] = [];
  for (const tool of (Object.keys(a.byTool) as ToolId[]).sort(cmp)) {
    const days = [...(a.byTool[tool]?.detailDays ?? []), ...(a.byTool[tool]?.lifetimeDays ?? [])];
    if (days.length === 0) continue;
    ever.push(tool);
    if (days.some((d) => d >= since && d <= nowDay)) active90d.push(tool);
  }

  return {
    tenureWeeks: fixedMetric(tenureWindow, [...(tenureWindow === "lifetime" ? lifetimeSources : detailSources)].sort(cmp), tenureDays.length, tenure,
      "no-data", tenureSpan),
    activeWeeks: {
      detail: weeksMetric("detail", a.detailDays, a.detailWeeks.length, detailSources, tz),
      lifetime: weeksMetric("lifetime", lifetimeDays, a.lifetimeWeeks.length, lifetimeSources, tz),
    },
    weekly, tools, rotation: { active90d, ever },
    arcs: { prompts, medianPrompts, durations },
    firstSeen: firstSeen(t, raw, scope, o.firstParallelBucket),
  };
}

/** Each feature's first evidence in scope (the table in `Exposure`); see `exposure`. */
function firstSeen(t: SessionTable, raw: ScanResult, scope: AnalysisScope, firstParallelBucket: number | undefined): Partial<Record<Feature, number>> {
  const { inRange, excluded, kept } = scope;
  const out: Partial<Record<Feature, number>> = {};
  const see = (f: Feature, ts: number): void => {
    if (!Number.isFinite(ts) || !inRange(ts)) return;
    const was = out[f];
    if (was === undefined || ts < was) out[f] = ts;
  };
  const counted = (sessionId: string | undefined): boolean =>
    sessionId === undefined ? true : raw.store.session(sessionId) === undefined || kept(sessionId);
  /** A row's first time in scope: its start, or for a row that started before the range its first in-range event. */
  const firstIn = (id: string, start: number): number | undefined => {
    if (start >= t.scope.from) return start;
    let first: number | undefined;
    const take = (ts: number): void => { if (inRange(ts) && (first === undefined || ts < first)) first = ts; };
    for (const e of raw.store.forSession(id, "tool")) take(e.ts);
    for (const e of raw.store.forSession(id, "usage")) take(e.ts);
    for (const e of raw.store.forSession(id, "prompt")) take(e.ts);
    for (const e of raw.store.forSession(id, "turn")) take(e.ts);
    for (const e of raw.store.forSession(id, "marker")) if (e.proxyTs !== true) take(e.ts);
    return first;
  };
  for (const r of t.rows.values()) {
    if (t.hosts.has(r.id)) continue;
    const features: Feature[] = [];
    if (!isTopLevel(r)) features.push("subagents"); // a child, or delegated work with no parent link
    if (r.workflowId !== undefined) features.push("workflows");
    if (r.background === true) features.push("background-agents");
    if (r.parentId === undefined && (r.origin === "scripted" || r.origin === "scheduled")) features.push("headless");
    if (features.length === 0) continue;
    const start = firstIn(r.id, r.start);
    if (start === undefined) continue;
    for (const f of features) see(f, start);
  }
  for (const e of raw.store.all("tool")) {
    if (excluded.has(e.tool) || !kept(e.sessionId)) continue;
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
  for (const c of scope.configs) if (c.kind === "skill" && c.firstSeen !== undefined) see("skills", c.firstSeen);
  if (firstParallelBucket !== undefined) see("parallel-sessions", firstParallelBucket);
  return out;
}
