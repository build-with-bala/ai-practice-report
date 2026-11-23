import { dayKey } from "../analysis/activity";
import { artifactUse } from "../analysis/artifacts";
import { promptWindowByTool } from "../analysis/promptwindow";
import type { SessionTable } from "../analysis/types";
import type { PromptEv } from "../model/events";
import type { ScanResult } from "../scan";
import { round, toolsOf, type CheckId, type CheckResult } from "./types";

/*
 * Soft flags (spec §6.6): patterns genuine histories rarely show, but can — a raised flag is a `note` to ask about,
 * never a fail. Each is n/a without the data it reads.
 */

const MIN = 60_000;
const DAY_MS = 86_400_000;
const RHYTHM_GAP_MS = 30 * MIN;
const RHYTHM_MIN_GAPS = 50;
const RHYTHM_MAX_CV = 0.6;
const LONG_CHARS = 200;
const LONG_REPEATS = 5;
const BURST_DAYS = 14;
const BURST_SHARE = 0.5;
const BURST_SPAN_DAYS = 60;
const UNCLOSED_SHARE = 0.1;
const NEW_CONFIG_MS = 7 * DAY_MS;
const NEW_CONFIG_MIN = 3;
const NEW_CONFIG_SHARE = 0.5;

const na = (id: CheckId, tools: CheckResult["tools"], n = 0): CheckResult => ({ id, status: "n/a", n, reason: "no-data", values: {}, tools });
const pct = (x: number): number => Math.round(x * 100);

/**
 * The human prompts in scope, each tool's from one window (`promptWindowByTool`), so a prompt both windows hold counts
 * once; host copies are left out (their prompts are the other tool's).
 */
function humanPrompts(raw: ScanResult, t: SessionTable): PromptEv[] {
  const chosen = promptWindowByTool(raw, t);
  const { from, to, tools: excluded } = t.scope;
  return raw.store.all("prompt").filter((p) => !excluded.has(p.tool) && p.ts >= from && p.ts <= to && t.isHuman(p)
    && chosen.get(p.tool) === p.window && (p.sessionId === undefined || !t.hosts.has(p.sessionId)));
}

/**
 * rhythm: per session, the gaps under 30 min between consecutive human prompts; a session with at least 50 such gaps is
 * measured by their coefficient of variation (population sd / mean). Gaps cut off at 30 min have a CV near 1 in ordinary
 * human work, so a single session says little: raised when the median CV over the measured sessions is below 0.6. n/a
 * when no session can be measured. `n` and `values.sessions`: the sessions measured; `values.medianCv` (2 decimals).
 */
function rhythm(prompts: readonly PromptEv[]): CheckResult {
  const bySession = new Map<string, number[]>();
  for (const p of prompts) {
    if (p.sessionId === undefined) continue;
    const list = bySession.get(p.sessionId);
    if (list) list.push(p.ts);
    else bySession.set(p.sessionId, [p.ts]);
  }
  const cvs: number[] = [];
  for (const times of bySession.values()) {
    times.sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < times.length; i++) {
      const g = times[i]! - times[i - 1]!;
      if (g < RHYTHM_GAP_MS) gaps.push(g);
    }
    if (gaps.length < RHYTHM_MIN_GAPS) continue;
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const sd = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
    cvs.push(mean === 0 ? 0 : sd / mean);
  }
  const tools = toolsOf(prompts.filter((p) => p.sessionId !== undefined));
  if (cvs.length === 0) return na("soft:rhythm", tools);
  cvs.sort((a, b) => a - b);
  const m = cvs.length >> 1;
  const median = cvs.length % 2 === 1 ? cvs[m]! : (cvs[m - 1]! + cvs[m]!) / 2;
  const base = { id: "soft:rhythm" as const, n: cvs.length, values: { sessions: cvs.length, medianCv: round(median, 2) }, tools };
  if (median >= RHYTHM_MAX_CV) return { ...base, status: "pass", reason: "ok" };
  return { ...base, status: "note", reason: "regular-rhythm",
    askAbout: `Across ${cvs.length} ${cvs.length === 1 ? "session" : "sessions"}, typed prompts arrive at unusually regular intervals. Were these prompts sent by a script rather than typed?` };
}

/**
 * repeated-long: the text hashes of human prompts of at least 200 characters that occur 5 times or more (`repeated`).
 * n/a without a human prompt whose length is known. `n`: the prompts whose length is known.
 */
function repeatedLong(prompts: readonly PromptEv[]): CheckResult {
  const known = prompts.filter((p) => p.features.chars !== undefined);
  const tools = toolsOf(known);
  if (known.length === 0) return na("soft:repeated-long", tools);
  const counts = new Map<string, number>();
  for (const p of known) if (p.features.chars! >= LONG_CHARS) counts.set(p.textHash, (counts.get(p.textHash) ?? 0) + 1);
  const repeated = [...counts.values()].filter((c) => c >= LONG_REPEATS).length;
  const base = { id: "soft:repeated-long" as const, n: known.length, values: { repeated }, tools };
  if (repeated === 0) return { ...base, status: "pass", reason: "ok" };
  return { ...base, status: "note", reason: "repeated-long",
    askAbout: `${repeated} long ${repeated === 1 ? "prompt" : "prompts"} of 200 characters or more ${repeated === 1 ? "was" : "were each"} sent 5 times or more. Were these prompts pasted from a template or sent by a script?` };
}

/**
 * recent-burst: of the lifetime active days, the share in the 14 days up to `now`'s day; raised when it is at least 50%
 * and the days span more than 60 days (first to last). n/a without lifetime active days.
 */
function recentBurst(t: SessionTable, now: number, timeZone: string): CheckResult {
  const days = t.activity.lifetimeDays;
  const tools = (Object.keys(t.activity.byTool) as CheckResult["tools"]).filter((k) => (t.activity.byTool[k]?.lifetimeDays.length ?? 0) > 0).sort();
  if (days.length === 0) return na("soft:recent-burst", tools);
  const first = days[0]!, last = days[days.length - 1]!;
  const spanDays = Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / DAY_MS);
  const before = dayKey(now - BURST_DAYS * DAY_MS, timeZone), today = dayKey(now, timeZone);
  const recentDays = days.filter((d) => d > before && d <= today).length;
  const share = recentDays / days.length;
  const base = { id: "soft:recent-burst" as const, n: days.length, values: { days: days.length, recentDays, spanDays, share: round(share) }, tools };
  if (share < BURST_SHARE || spanDays <= BURST_SPAN_DAYS) return { ...base, status: "pass", reason: "ok" };
  return { ...base, status: "note", reason: "recent-burst",
    askAbout: `${pct(share)}% of the active days since ${first} fall in the 14 days before this scan. Was most of this history made just before the scan?` };
}

/**
 * unclosed-tools: the share of Claude Code's detail-window tool calls (from sources with detail coverage, in scope,
 * no host copy) with neither `ok` nor an `outcome`; raised above 10%. n/a without such calls. `values`: `open`, `share`.
 */
function unclosedTools(raw: ScanResult, t: SessionTable): CheckResult {
  const detail = new Set(raw.coverage.filter((c) => c.window === "detail").map((c) => c.source));
  const { from, to, tools: excluded } = t.scope;
  const calls = raw.store.all("tool").filter((e) => e.tool === "claude-code" && !excluded.has(e.tool) && detail.has(e.source)
    && e.ts >= from && e.ts <= to && !t.hosts.has(e.sessionId));
  const tools = toolsOf(calls);
  if (calls.length === 0) return na("soft:unclosed-tools", tools);
  const open = calls.filter((e) => e.ok === undefined && e.outcome === undefined).length;
  const share = open / calls.length;
  const base = { id: "soft:unclosed-tools" as const, n: calls.length, values: { open, share: round(share) }, tools };
  if (share <= UNCLOSED_SHARE) return { ...base, status: "pass", reason: "ok" };
  return { ...base, status: "note", reason: "unclosed-tools",
    askAbout: `${pct(share)}% of the tool calls in the Claude Code transcripts have no recorded result. Were transcripts cut short or edited?` };
}

/**
 * new-config: the used artifacts (`artifactUse`, the rule the Context dimension's `artifacts` signal counts: skills,
 * commands, agents, plugins and MCP servers with use evidence) whose first-seen time (the earliest of their reports) is
 * at or after `now` − 7 days. A first-seen time can be a file's change time where the system keeps no creation time,
 * which a migration or a tool update resets: the question allows for both. Raised when at least 3, and at least half,
 * of the used artifacts with a first-seen time are that recent: one newly added skill says nothing. n/a without a used
 * artifact with a first-seen time. `values`: `recent`, `artifacts` (those with a first-seen time); `tools`: the tools
 * whose config entries report those artifacts.
 */
function newConfig(raw: ScanResult, t: SessionTable, now: number): CheckResult {
  const dated = artifactUse(raw, t).filter((a) => a.used && a.firstSeen !== undefined);
  const keys = new Set(dated.map((a) => `${a.kind}\u0000${a.name}`));
  const tools = toolsOf(raw.store.all("config").filter((c) => !t.scope.tools.has(c.tool) && c.name !== undefined && keys.has(`${c.kind}\u0000${c.name}`)));
  if (dated.length === 0) return na("soft:new-config", tools);
  const m = dated.length;
  const recent = dated.filter((a) => a.firstSeen! >= now - NEW_CONFIG_MS).length;
  const base = { id: "soft:new-config" as const, n: m, values: { recent, artifacts: m }, tools };
  if (recent < NEW_CONFIG_MIN || recent < NEW_CONFIG_SHARE * m) return { ...base, status: "pass", reason: "ok" };
  // raised means recent ≥ 3, so both counts are plural
  return { ...base, status: "note", reason: "new-config",
    askAbout: `${recent} of the ${m} tools and skills in use were first seen in the 7 days before this scan. Was this machine set up or migrated, or were its tools updated, in that week?` };
}

/** The five soft flags, in order: rhythm, repeated-long, recent-burst, unclosed-tools, new-config. */
export function softFlags(raw: ScanResult, t: SessionTable, o: { now: number; timeZone: string }): CheckResult[] {
  const prompts = humanPrompts(raw, t);
  return [rhythm(prompts), repeatedLong(prompts), recentBurst(t, o.now, o.timeZone), unclosedTools(raw, t), newConfig(raw, t, o.now)];
}
