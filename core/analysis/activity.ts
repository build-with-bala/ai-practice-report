import { localDay } from "../io/time";
import type { DailyEv, PromptEv } from "../model/events";
import type { ToolId } from "../model/ids";
import type { Activity } from "./types";

const DAY_MS = 86_400_000;

/** The local day ("YYYY-MM-DD") of an epoch-ms time in an explicit IANA zone. */
export function dayKey(ms: number, timeZone: string): string {
  return localDay(ms, timeZone);
}

/**
 * The first epoch ms of a local day ("YYYY-MM-DD") in an explicit IANA zone: a binary search over the 30 hours around
 * the day's UTC midnight (every zone's offset is within ±14 h), so DST days resolve too.
 */
export function dayStart(day: string, timeZone: string): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  let lo = Date.UTC(y, m - 1, d) - 15 * 3_600_000;
  let hi = Date.UTC(y, m - 1, d) + 15 * 3_600_000;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (dayKey(mid, timeZone) < day) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The last epoch ms of a local day ("YYYY-MM-DD") in an explicit IANA zone: one before the next day's start. */
export function dayEnd(day: string, timeZone: string): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return dayStart(new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10), timeZone) - 1;
}

/** The ISO-8601 week ("YYYY-Www") of a day ("YYYY-MM-DD"): weeks start on Monday, and week 1 holds the year's first Thursday. */
export function isoWeek(day: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const ms = Date.UTC(y, m - 1, d);
  const weekday = (new Date(ms).getUTCDay() + 6) % 7; // Monday = 0
  const thursday = ms + (3 - weekday) * DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  const week = 1 + Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * DAY_MS));
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export interface ActivityInput {
  timeZone: string;
  /** Human detail-window prompts of rows kept (neither excluded nor host copies). */
  detail: Iterable<PromptEv>;
  /** Human lifetime-window prompts left after the exclusions. */
  lifetime: Iterable<PromptEv>;
  /** Local per-day prompt counts left after the exclusions (count ≥ 1 is checked here). */
  daily: Iterable<DailyEv>;
}

const sorted = (s: Set<string>): string[] => [...s].sort();
const weeks = (days: Set<string>): string[] => sorted(new Set([...days].map(isoWeek)));

/**
 * Active days and weeks per window, overall and per tool. Only prompts and `DailyEv{unit:"prompts"}` days of zone
 * `local` or `either` with a count of at least 1 count; nothing else (file times, config birth times, proxy-timed
 * markers) is read. A per-day row is used as given, as a day of the analysis zone: a `local` day is the scanning
 * machine's, and an `either` day is the UTC or the local date (a tool that changed its key between releases), so it is
 * never matched one to one against a day of another zone; a `utc` day is not read. The caller passes per-day rows only
 * for a source that supplied no prompts.
 */
export function activityOf(input: ActivityInput): Activity {
  const detail = new Set<string>();
  const lifetime = new Set<string>();
  const perTool = new Map<ToolId, { detail: Set<string>; lifetime: Set<string>; sources: Set<string> }>();
  const of = (tool: ToolId) => {
    let t = perTool.get(tool);
    if (!t) perTool.set(tool, (t = { detail: new Set(), lifetime: new Set(), sources: new Set() }));
    return t;
  };
  for (const p of input.detail) {
    const day = dayKey(p.ts, input.timeZone);
    detail.add(day);
    of(p.tool).detail.add(day);
  }
  for (const p of input.lifetime) {
    const day = dayKey(p.ts, input.timeZone);
    lifetime.add(day);
    of(p.tool).lifetime.add(day);
    of(p.tool).sources.add(p.source);
  }
  for (const d of input.daily) {
    if (d.unit !== "prompts" || d.zone === "utc" || !(d.count >= 1)) continue; // local or either: the day as given
    lifetime.add(d.day);
    of(d.tool).lifetime.add(d.day);
    of(d.tool).sources.add(d.source);
  }
  const byTool: Activity["byTool"] = {};
  for (const tool of [...perTool.keys()].sort()) {
    const t = perTool.get(tool)!;
    byTool[tool] = { detailDays: sorted(t.detail), lifetimeDays: sorted(t.lifetime), lifetimeSources: sorted(t.sources) };
  }
  return { detailDays: sorted(detail), lifetimeDays: sorted(lifetime), detailWeeks: weeks(detail), lifetimeWeeks: weeks(lifetime), byTool };
}
