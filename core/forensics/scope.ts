import { dayKey } from "../analysis/activity";
import { analysisScope, identityInScope, type AnalysisScope } from "../analysis/scope";
import type { SessionRow, SessionTable } from "../analysis/types";
import type { AnchorEv, ConfigEv, CoverageEv, DailyEv, FileFactEv, IdentityEv, PromptEv, RateLimitEv, RolloutFactEv, ThreadRowEv, ToolEv } from "../model/events";
import type { ToolId } from "../model/ids";
import type { ScanResult } from "../scan";

/*
 * What the person's exclusions leave of the scan, for every forensic check and soft flag: an exclusion must not leak
 * what it excludes, so the checks read only in-scope data, and this is the one place that decides what that is.
 *
 * - Tools: an excluded tool's events reach no check.
 * - Date range: a dated event outside the range reaches no check.
 * - Sessions: an event that names a session counts only when that session is a kept row of the session table (`t.rows`,
 *   no host copy). That is how a project exclusion applies (its sessions have no row), and how host copies are left
 *   out. Server ids (anchors), trace-file facts and usage-limit readings follow the session they name like any other
 *   event; one that names no session cannot be tied to a project and is kept by tool and date alone. Where the named
 *   session is one the store does not hold (an orphan), each kind decides:
 *   - tool calls, session account hashes, anchors, file facts and usage-limit readings: out of scope (as in
 *     `core/analysis/scope.ts` and `Analysis.identity`);
 *   - prompts: the scope helper's rule (`AnalysisScope.human`): an orphan detail prompt is out, an orphan lifetime
 *     prompt stays (history outlives its sessions); a lifetime prompt of an excluded project follows the scope helper's
 *     project rule, which this view wraps and does not repeat;
 *   - rollouts and thread-index rows (their `threadId` is the session id): an orphan stays — a rollout nobody can
 *     account for is exactly what C6 exists to catch.
 */

/**
 * The in-scope view of a scan. Each list is computed on first use and kept.
 * - `keptTool` / `inRange` / `session`: the three rules above, one at a time (`session(undefined)` is true; an orphan
 *   is false).
 * - `prompt`: a prompt in scope, whoever sent it; `human`: a human prompt in scope (the scope helper's own rule).
 * - `rows`: the kept session rows that are no host copy; `tools`: the tools in scope — those of `rows` and of the
 *   prompts in scope (sorted).
 * - `anchors`: by `ts` and their session. `identities`: config-scope ones by tool; session-scope ones by their session.
 * - `files`: by their session; a session file's facts are in scope when its events (`firstTs` to `lastTs`; one of them stands for both
 *   when the other is missing) overlap the range, or when it has no event times; its file-system times never decide.
 * - `rollouts`: by their start — the id's time (`uuidTs`) where it has one, else the file name's (`fileTs`); kept when
 *   it has neither — and by their session (`threadId` is the rollout's session id).
 * - `threadRows`: by `createdAt` (kept when it has none) and by their session, as rollouts are. Its `createdAt` and its
 *   rollout's start mark the same moment, the thread's creation, so a rollout and its own row fall on the same side of
 *   a range's end.
 *
 * What a project exclusion leaves in: events that name no session (anchors, file facts and usage-limit readings whose
 * reader did not know their session, history prompts without one) and per-day totals, which carry no project.
 * - `rateLimits`: by `ts` and their session. `toolCalls`: by `ts` and their session. `prompts`: `prompt` over the store.
 * - `daily`: a tool's day totals, kept when the day lies within the range's first and last day in the analysis zone
 *   (the session table's rule for days).
 * - `configs`: the config entries of kept tools (state read at scan time: no date applies).
 * - `coverage`: the coverage reports of kept tools.
 */
export interface ForensicScope {
  analysis: AnalysisScope;
  keptTool(tool: ToolId): boolean; inRange(ts: number): boolean; session(id: string | undefined): boolean;
  prompt(p: PromptEv): boolean; human(p: PromptEv): boolean;
  rows(): readonly SessionRow[]; tools(): readonly ToolId[];
  anchors(): readonly AnchorEv[]; identities(): readonly IdentityEv[]; files(): readonly FileFactEv[];
  rollouts(): readonly RolloutFactEv[]; threadRows(): readonly ThreadRowEv[]; rateLimits(): readonly RateLimitEv[];
  toolCalls(): readonly ToolEv[]; prompts(): readonly PromptEv[]; daily(): readonly DailyEv[]; configs(): readonly ConfigEv[];
  coverage(): readonly CoverageEv[];
}

const memo = <T>(f: () => T): (() => T) => {
  let v: T | undefined;
  let done = false;
  return () => {
    if (!done) {
      v = f();
      done = true;
    }
    return v as T;
  };
};

/** The in-scope view of `raw` under the session table's exclusions (see `ForensicScope`). Pure: no clock, no I/O. */
export function forensicScope(raw: ScanResult, t: SessionTable): ForensicScope {
  const a = analysisScope(raw, t);
  const { from, to } = t.scope;
  const keptTool = (tool: ToolId): boolean => !a.excluded.has(tool);
  const inRange = a.inRange;
  const session = (id: string | undefined): boolean => id === undefined || a.kept(id);
  // a Codex thread's session rule: an orphan thread stays
  const thread = (id: string): boolean => raw.store.session(id) === undefined || a.kept(id);
  // the scope helper's prompt rule with its human test left out: a prompt in scope, whoever sent it
  const prompt = analysisScope(raw, { ...t, isHuman: () => true }).human;
  const fromDay = Number.isFinite(from) ? dayKey(from, t.timeZone) : undefined;
  const toDay = Number.isFinite(to) ? dayKey(to, t.timeZone) : undefined;
  const dated = (ts: number | undefined): boolean => ts === undefined || inRange(ts);

  const rows = memo(() => [...t.rows.values()].filter((r) => !t.hosts.has(r.id)));
  const prompts = memo(() => raw.store.all("prompt").filter(prompt));
  return {
    analysis: a, keptTool, inRange, session, prompt, human: a.human, rows, prompts,
    tools: memo(() => {
      const s = new Set<ToolId>();
      for (const r of rows()) s.add(r.tool);
      for (const p of prompts()) s.add(p.tool);
      return [...s].sort();
    }),
    anchors: memo(() => raw.store.all("anchor").filter((e) => keptTool(e.tool) && inRange(e.ts) && session(e.sessionId))),
    identities: memo(() => raw.store.all("identity").filter((e) => identityInScope(e, t))), // the analysis's one rule
    files: memo(() => raw.store.all("file").filter((f) => {
      if (!keptTool(f.tool) || !session(f.sessionId)) return false;
      const first = f.firstTs ?? f.lastTs, last = f.lastTs ?? f.firstTs;
      return first === undefined || last === undefined || (last >= from && first <= to);
    })),
    rollouts: memo(() => raw.store.all("codex-rollout").filter((r) => keptTool(r.tool) && dated(r.uuidTs ?? r.fileTs) && thread(r.threadId))),
    threadRows: memo(() => raw.store.all("codex-thread-row").filter((r) => keptTool(r.tool) && dated(r.createdAt) && thread(r.threadId))),
    rateLimits: memo(() => raw.store.all("ratelimit").filter((e) => keptTool(e.tool) && inRange(e.ts) && session(e.sessionId))),
    toolCalls: memo(() => raw.store.all("tool").filter((e) => keptTool(e.tool) && inRange(e.ts) && session(e.sessionId))),
    // the range's days are read in the analysis zone (the session table's rule), while the stats cache keys its days by
    // the UTC or the local date: at the range's first and last day the two can differ by a day
    daily: memo(() => raw.store.all("daily").filter((d) => keptTool(d.tool) && (fromDay === undefined || d.day >= fromDay) && (toDay === undefined || d.day <= toDay))),
    configs: () => a.configs,
    coverage: memo(() => raw.coverage.filter((c) => keptTool(c.tool))),
  };
}
