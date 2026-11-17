import path from "node:path";
import type { DailyEv } from "../../model/events";
import { readSidecar, Tally } from "../common/coverage";
import { isObj, num, safeModel, type Obj } from "../common/guards";
import type { Candidate, ScanCtx } from "../types";

export const STATS_SOURCE = "claude-code.stats";
const TOOL = "claude-code";
/** Newest stats-cache format the CLI program writes (2.1.326 reads versions 1-5); a newer one may mean changed fields. */
const KNOWN_VERSION = 5;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** Start of a `YYYY-MM-DD` day in UTC, the zone the CLI keys its stats days in; undefined when not a real date. */
function dayStart(v: unknown): number | undefined {
  if (typeof v !== "string" || !DAY.test(v)) return undefined;
  const ms = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Tokens per model and day from `dailyModelTokens`; model ids are shape-checked, non-id keys merge into `other`. */
function tokensByDay(v: Obj, tally: Tally): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  if (v.dailyModelTokens === undefined) return out;
  if (!Array.isArray(v.dailyModelTokens)) {
    tally.unknownKey("dailyModelTokens:type");
    return out;
  }
  for (const e of v.dailyModelTokens) {
    tally.records++;
    if (!isObj(e) || dayStart(e.date) === undefined || !isObj(e.tokensByModel)) {
      tally.unknownKey("dailyModelTokens:shape");
      continue;
    }
    const day = e.date as string;
    const models = out.get(day) ?? new Map<string, number>();
    for (const [model, n] of Object.entries(e.tokensByModel)) {
      const tokens = num(n);
      if (tokens === undefined || tokens < 0) continue;
      const key = safeModel(model);
      models.set(key, (models.get(key) ?? 0) + tokens);
    }
    out.set(day, models);
  }
  return out;
}

/** Scan `<root>/stats-cache.json` (the CLI's per-day aggregates behind /stats); emits one CoverageEv, last. */
export async function scanStats(c: Candidate, ctx: ScanCtx): Promise<void> {
  const tally = new Tally(TOOL, STATS_SOURCE, "lifetime");
  const v = readSidecar(path.join(c.root, "stats-cache.json"), tally);
  if (v) {
    if (typeof v.version !== "number") tally.unknownKey("version:missing");
    else if (v.version > KNOWN_VERSION) tally.unknownKey("version:newer");
    const tokens = tokensByDay(v, tally);
    if (!Array.isArray(v.dailyActivity)) tally.unknownKey("dailyActivity:missing");
    else {
      for (const e of v.dailyActivity) {
        tally.records++;
        const start = isObj(e) ? dayStart(e.date) : undefined;
        const messages = isObj(e) ? num(e.messageCount) : undefined;
        if (!isObj(e) || start === undefined || messages === undefined) {
          tally.unknownKey("dailyActivity:shape");
          continue;
        }
        const day = e.date as string;
        // the CLI keys its stats by UTC day and counts every message of the day's sessions, not only typed prompts
        const ev: DailyEv = { k: "daily", tool: TOOL, source: STATS_SOURCE, day, zone: "utc", unit: "messages", count: messages };
        const sessions = num(e.sessionCount);
        const toolCalls = num(e.toolCallCount);
        if (sessions !== undefined) ev.sessions = sessions;
        if (toolCalls !== undefined) ev.toolCalls = toolCalls;
        const models = tokens.get(day);
        if (models && models.size > 0) ev.models = Object.fromEntries(models);
        ctx.emit(ev);
        tally.span(start);
        tally.span(start + DAY_MS - 1);
      }
    }
  }
  ctx.emit(tally.coverage());
}
