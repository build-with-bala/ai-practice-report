import { dayKey } from "../analysis/activity";
import type { SessionTable } from "../analysis/types";
import type { PromptEv } from "../model/events";
import type { ScanResult } from "../scan";
import { HISTORY_SOURCE } from "../sources/claude-code/history";
import { STATS_SOURCE } from "../sources/claude-code/stats";
import { TRANSCRIPTS_SOURCE } from "../sources/claude-code/transcripts";
import { forensicScope, type ForensicScope } from "./scope";
import { round, toolsOf, worst, type CheckResult, type CheckStatus } from "./types";

/*
 * C3 and C4: Claude Code's own records agree with each other. The CLI writes every typed prompt three times over — the
 * transcript, the prompt history and the day totals of its stats cache — and names the signed-in account in each
 * session and in its config. Transcripts made elsewhere, or by hand, rarely keep all of these in step.
 */

const MATCH_MS = 10_000;
const MIN_MATCH = 0.75;
const FAIL_DAYS = 2;
const FAIL_DAY_SHARE = 0.02;

interface Part { status: CheckStatus; reason: string; askAbout?: string }

/** Whether a sorted list holds a value within `tol` of `x`. */
function near(sorted: readonly number[], x: number, tol: number): boolean {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < x - tol) lo = mid + 1;
    else hi = mid;
  }
  return lo < sorted.length && sorted[lo]! <= x + tol;
}

/**
 * How many of `prompts` (each unmatched by hash) match a pasted history prompt: the earliest unused one within 10 s, of
 * the same session where both name one. Prompts go in time order; each history prompt is used at most once. With both
 * lists in time order and one window for both sides, taking the earliest gives a maximum one-to-one matching.
 */
function pasteMatches(prompts: readonly PromptEv[], pasted: readonly PromptEv[]): number {
  const hs = [...pasted].sort((a, b) => a.ts - b.ts);
  const used = new Set<number>();
  let n = 0;
  for (const p of [...prompts].sort((a, b) => a.ts - b.ts)) {
    let best = -1;
    let i = 0, hi = hs.length;
    while (i < hi) {
      const mid = (i + hi) >> 1;
      if (hs[mid]!.ts < p.ts - MATCH_MS) i = mid + 1;
      else hi = mid;
    }
    for (; i < hs.length && hs[i]!.ts <= p.ts + MATCH_MS; i++) {
      const h = hs[i]!;
      if (used.has(i)) continue;
      if (h.sessionId !== undefined && p.sessionId !== undefined && h.sessionId !== p.sessionId) continue;
      best = i;
      break;
    }
    if (best >= 0) {
      used.add(best);
      n++;
    }
  }
  return n;
}

/**
 * C3, history vs transcripts vs stats cache, over in-scope data only (`ForensicScope`): the transcripts' human prompts in
 * scope, the history prompts in scope (the same prompt rule: a history prompt of a session left out is left out), and
 * the stats cache's days within the range's days.
 * - Match: the share of human transcript prompts inside the history's span that have a history prompt with an equal
 *   text hash within 10 s; below 75% → warn. The history hashes a prompt as displayed, where pasted content is a
 *   placeholder, so a prompt with a paste never hash-matches: a transcript prompt left unmatched also matches a history
 *   prompt with `hasPaste` within 10 s (the earliest unused one; the same session where both name one), and each such history prompt
 *   matches at most one transcript prompt.
 * - Missing days: UTC days with human transcript prompts, inside the span of the stats cache's `utc` days, that the
 *   stats cache has no day for; at least 2 such days and 2% of those days → fail, fewer → note.
 * Each part needs its own side; n/a without human transcript prompts, or with neither part measurable. A pass says which
 * parts ran: `ok` (both), `ok-history-only`, `ok-stats-only`. `n`: the transcript prompts in the history's span when the
 * match part ran, else the transcript days in the stats span.
 */
export function checkClaudeHistory(raw: ScanResult, t: SessionTable, s: ForensicScope = forensicScope(raw, t)): CheckResult {
  const transcript = s.prompts().filter((p) => p.source === TRANSCRIPTS_SOURCE && s.human(p));
  const history = s.prompts().filter((p) => p.source === HISTORY_SOURCE);
  const stats = s.daily().filter((d) => d.source === STATS_SOURCE && d.zone === "utc");
  const tools = toolsOf([...transcript, ...history, ...stats]);
  const values: Record<string, number> = {};
  const parts: Part[] = [];
  let n = 0;

  if (transcript.length > 0 && history.length > 0) {
    let from = Infinity, to = -Infinity;
    const byHash = new Map<string, number[]>();
    for (const h of history) {
      from = Math.min(from, h.ts);
      to = Math.max(to, h.ts);
      const list = byHash.get(h.textHash);
      if (list) list.push(h.ts);
      else byHash.set(h.textHash, [h.ts]);
    }
    for (const list of byHash.values()) list.sort((a, b) => a - b);
    const inSpan: PromptEv[] = transcript.filter((p) => p.ts >= from && p.ts <= to);
    if (inSpan.length > 0) {
      const unmatched = inSpan.filter((p) => !near(byHash.get(p.textHash) ?? [], p.ts, MATCH_MS));
      const matched = inSpan.length - unmatched.length + pasteMatches(unmatched, history.filter((h) => h.hasPaste === true));
      const share = matched / inSpan.length;
      n = inSpan.length;
      values.matchShare = round(share);
      values.prompts = inSpan.length;
      parts.push(share < MIN_MATCH
        ? { status: "warn", reason: "history-mismatch", askAbout: `Only ${Math.round(share * 100)}% of the typed prompts in the transcripts also appear in the prompt history. Was the history cleared, or were transcripts copied in from another machine?` }
        : { status: "pass", reason: "ok-history-only" });
    }
  }

  if (transcript.length > 0 && stats.length > 0) {
    let first = stats[0]!.day, last = first;
    const have = new Set<string>();
    for (const d of stats) {
      have.add(d.day);
      if (d.day < first) first = d.day;
      if (d.day > last) last = d.day;
    }
    const days = new Set<string>();
    for (const p of transcript) {
      const day = dayKey(p.ts, "UTC");
      if (day >= first && day <= last) days.add(day);
    }
    if (days.size > 0) {
      const missing = [...days].filter((d) => !have.has(d)).length;
      if (n === 0) n = days.size;
      values.missingDays = missing;
      values.days = days.size;
      const ask = `${missing} ${missing === 1 ? "day" : "days"} with prompts in the transcripts ${missing === 1 ? "is" : "are"} missing from the usage statistics kept for that time. Were transcripts added from somewhere else?`;
      parts.push(missing >= FAIL_DAYS && missing / days.size >= FAIL_DAY_SHARE
        ? { status: "fail", reason: "missing-stats-days", askAbout: ask }
        : missing > 0 ? { status: "note", reason: "missing-stats-days", askAbout: ask } : { status: "pass", reason: "ok-stats-only" });
    }
  }

  const w = worst(parts);
  if (w === undefined) return { id: "C3", status: "n/a", n: 0, reason: "no-data", values: {}, tools };
  const reason = w.status === "pass" && parts.length === 2 ? "ok" : w.reason;
  const out: CheckResult = { id: "C3", status: w.status, n, reason, values, tools };
  if (w.askAbout !== undefined) out.askAbout = w.askAbout;
  return out;
}

/**
 * C4, the session accounts vs the config's (as keyed hashes), over Claude Code's identities in scope
 * (`ForensicScope.identities`): a session's hash counts only when its session is a kept row; config hashes, and session
 * hashes that name no session the store holds, count while Claude Code is kept. `matchShare`: the share of session
 * identities whose hash the config names; none → fail. More than 1 distinct session hash → note (`accounts`). n/a when
 * either side is missing.
 */
export function checkAccount(raw: ScanResult, t: SessionTable, s: ForensicScope = forensicScope(raw, t)): CheckResult {
  const ids = s.identities().filter((e) => e.tool === "claude-code");
  const sessions = ids.filter((e) => e.scope === "session");
  const config = new Set(ids.filter((e) => e.scope === "config").map((e) => e.hash));
  const tools = toolsOf(ids);
  if (sessions.length === 0 || config.size === 0) return { id: "C4", status: "n/a", n: sessions.length, reason: "no-data", values: {}, tools };
  const share = sessions.filter((e) => config.has(e.hash)).length / sessions.length;
  const accounts = new Set(sessions.map((e) => e.hash)).size;
  const values = { matchShare: round(share), accounts };
  const base = { id: "C4" as const, n: sessions.length, values, tools };
  if (share === 0) {
    return { ...base, status: "fail", reason: "no-match",
      askAbout: "None of the sessions names the account this machine is signed in to. Were these sessions made under another account or on another machine?" };
  }
  if (accounts > 1) {
    return { ...base, status: "note", reason: "several-accounts",
      askAbout: `The sessions name ${accounts} different accounts. Were several accounts used on this machine?` };
  }
  return { ...base, status: "pass", reason: "ok" };
}
