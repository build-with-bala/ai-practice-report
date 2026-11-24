import { dayEnd, dayStart, isoWeek } from "../analysis/activity";
import { artifactUse } from "../analysis/artifacts";
import { analysisScope } from "../analysis/scope";
import { CONFIG_SOURCES, PR_LINK_TOOLS, SWITCH_TOOLS, type Metric, type SessionTable } from "../analysis/types";
import type { CoverageEv } from "../model/events";
import type { SessionStats } from "../analysis/walk";
import type { CommitFact, RepoFacts } from "../git/types";
import { BUCKET_MS, DELIVERY_WINDOW_MS, REWORK_WINDOW_MS } from "../model/constants";
import type { ConfigEv } from "../model/events";
import type { ToolId } from "../model/ids";
import type { ScanResult } from "../scan";
import { fixedMetric, Span, type Globals } from "./types";

const DAY_MS = 86_400_000;
/** Rework counts own commits from this long before the detail window's start: their fixes can land inside it. */
const REWORK_LEAD_MS = 3 * DAY_MS;
const weight = (p: ConfigEv["provenance"]): number => (p === "authored" ? 1 : 0.3);
/** Coverage statuses of a source that was read (`empty`: read, nothing there). */
const READ: ReadonlySet<CoverageEv["status"]> = new Set<CoverageEv["status"]>(["ok", "empty", "drift"]);
const ratio = (num: number, den: number): number | null => (den > 0 ? num / den : null);
const mean = (v: readonly number[]): number | null => (v.length > 0 ? v.reduce((a, b) => a + b, 0) / v.length : null);

/** The distinct ISO weeks of the given tools' active days in one window, from `Activity.byTool`, and their first and last day. */
function toolDays(t: SessionTable, tools: ReadonlySet<ToolId>, window: "detailDays" | "lifetimeDays"): { weeks: number; first?: string; last?: string } {
  const weeks = new Set<string>();
  let first: string | undefined;
  let last: string | undefined;
  for (const tool of tools) {
    for (const day of t.activity.byTool[tool]?.[window] ?? []) {
      weeks.add(isoWeek(day));
      if (first === undefined || day < first) first = day;
      if (last === undefined || day > last) last = day;
    }
  }
  return { weeks: weeks.size, ...(first === undefined ? {} : { first, last: last! }) };
}

/**
 * The signals computed across sessions (spec §6.4), once per analysis; the bootstrap holds them fixed. Pure: no clock,
 * no I/O (`now` is the analysis time). Everything is clipped to `t.scope`: commits, markers and tool calls outside the
 * date range never count, and nothing of an excluded tool counts.
 *
 * - **Buckets.** An active bucket holds an action of at least one `detailTop` row (scripted rows too); a parallel one,
 *   of at least 2 rows. `firstParallelBucket` is the start of the earliest parallel bucket (pre-flight P14).
 * - **Repos.** An active repo is the `repoKey` of at least one `detailTop` row; repo-wide totals (rework, co-authored
 *   share) read the repos of kept detail-window rows (no host copy), so a repo only an excluded project or tool, or
 *   only lifetime-window sessions, used never counts; the artifacts' child types and MCP calls read the same rows.
 *   Whole-report totals count owner commits only; per-repo matching (a commit after a session, a later fix) takes any.
 * - **Artifacts** (`artifacts`): the provenance-weighted count of distinct artifacts in use, `n` = those artifacts (0
 *   when none is in use: a state count, measured on the inventory, not a sample). Measured whenever a config source of a kept tool was read (its coverage is ok, empty or
 *   drift, or it supplied an entry): none in use is a measured 0. Null (`not-captured`) only when no config source was
 *   read.
 * - **Per-week rates** divide by the active weeks of the tools that emit their markers (pre-flight P10): null when none
 *   of them has a week, never 0.
 */
export function computeGlobals(t: SessionTable, stats: readonly SessionStats[], raw: ScanResult, o: { now: number }): Globals {
  const scope = analysisScope(raw, t);
  const { inRange, excluded, kept, detailSources, detailRows, configs } = scope;
  const repoStatus = raw.repos.status;
  const repoOff = repoStatus === "off" || repoStatus === "git-missing";

  // buckets (§6.4 parallelism)
  const perBucket = new Map<number, number>();
  const bucketSpan = new Span();
  for (const s of stats) {
    if (s.buckets.length === 0) continue;
    bucketSpan.add(s);
    for (const b of s.buckets) perBucket.set(b, (perBucket.get(b) ?? 0) + 1);
  }
  let parallel = 0;
  let peak = 0;
  let firstParallel: number | undefined;
  for (const [b, c] of perBucket) {
    if (c > peak) peak = c;
    if (c < 2) continue;
    parallel++;
    if (firstParallel === undefined || b < firstParallel) firstParallel = b;
  }

  // headless runs per detail week
  const detailWeeks = t.activity.detailWeeks.length;
  const allSpan = new Span();
  for (const s of stats) allSpan.add(s);
  const scripted = stats.filter((s) => s.scripted).length;

  // PRs per week of the tools that link PRs (pre-flight P10)
  const prWeeks = toolDays(t, PR_LINK_TOOLS, "detailDays").weeks;
  const prSpan = new Span();
  const prs = new Set<string>();
  for (const s of stats) {
    if (PR_LINK_TOOLS.has(s.tool)) prSpan.add(s);
    for (const k of s.prKeys) prs.add(k);
  }

  // switches per lifetime week of the tools that record them (pre-flight P10); the metric's span and sources are the
  // denominator's (those tools' lifetime days, and the stores they come from) as well as the markers'
  const sw = toolDays(t, SWITCH_TOOLS, "lifetimeDays");
  const switchWeeks = sw.weeks;
  const switchSpan = new Span();
  if (sw.first !== undefined) { switchSpan.addTs(dayStart(sw.first, t.timeZone)); switchSpan.addTs(dayEnd(sw.last!, t.timeZone)); }
  const switchTool = (tool: ToolId): boolean => SWITCH_TOOLS.has(tool) && !excluded.has(tool);
  for (const tool of SWITCH_TOOLS) if (switchTool(tool)) for (const src of t.activity.byTool[tool]?.lifetimeSources ?? []) switchSpan.addSource(src);
  // markers only from lifetime-window sources: a detail-window emitter is never summed against lifetime weeks
  const lifetimeSources = new Set(raw.coverage.filter((c) => c.window === "lifetime" && !detailSources.has(c.source)).map((c) => c.source));
  let switches = 0;
  for (const m of raw.store.all("marker")) {
    if ((m.kind !== "model-switch" && m.kind !== "effort-switch") || m.detail === undefined) continue;
    if (!switchTool(m.tool) || !lifetimeSources.has(m.source) || !inRange(m.ts)) continue;
    // a marker of a session that is in the store but left out (excluded, or a host copy) does not count
    if (m.sessionId !== undefined && raw.store.session(m.sessionId) !== undefined && !kept(m.sessionId)) continue;
    switches++;
    switchSpan.addSource(m.source);
    switchSpan.addTs(m.ts);
  }

  // repos
  const facts = new Map<string, RepoFacts>();
  for (const r of raw.repos.repos) if (!facts.has(r.repoKey)) facts.set(r.repoKey, r);
  const activeRows = new Map<string, SessionStats[]>();
  for (const s of stats) {
    if (s.repoKey === undefined || !facts.has(s.repoKey)) continue;
    const list = activeRows.get(s.repoKey);
    if (list) list.push(s);
    else activeRows.set(s.repoKey, [s]);
  }
  const activeSpan = new Span();
  for (const rows of activeRows.values()) for (const s of rows) activeSpan.add(s);
  const gitSpan = activeSpan.range();

  // config (kept tools only)
  const userHook = configs.some((c) => c.kind === "hook" && (c.checks?.length ?? 0) > 0)
    && !configs.some((c) => c.kind === "feature" && c.name === "hooks-disabled");
  const guards: number[] = [];
  let maintained = 0;
  for (const key of activeRows.keys()) {
    const r = facts.get(key)!;
    const hook = (r.hooks.checks.length > 0 && !r.hooks.disabled) || userHook;
    const ci = r.ci.checks.length > 0 || r.precommit.checks.length > 0;
    const instructions = r.instructions.namesChecks.includes("test");
    guards.push(((hook ? 1 : 0) + (ci ? 1 : 0) + (instructions ? 1 : 0)) / 3);
    if (r.instructions.files.length > 0 && r.instructions.touched >= 1) maintained++;
  }
  const activeRepos = activeRows.size;
  const repoMetric = (n: number, value: number | null, span?: { from?: number; to?: number }): Metric =>
    repoOff ? fixedMetric("detail", ["git"], 0, null, "repo-signals-off") : fixedMetric("detail", ["git"], n, value, "no-data", span);

  // commits: the repos of kept rows, inside the date range
  const keptRepos = new Set<string>();
  for (const row of detailRows) if (row.repoKey !== undefined) keptRepos.add(row.repoKey);
  const detailFrom = stats.length > 0 ? Math.max(t.scope.from, stats.reduce((m, s) => Math.min(m, s.start), Infinity)) : undefined;
  const hi = Math.min(o.now, t.scope.to);
  const reworkFrom = detailFrom === undefined ? undefined : Math.max(t.scope.from, detailFrom - REWORK_LEAD_MS);
  let reworkDen = 0;
  let reworked = 0;
  let own = 0;
  let ai = 0;
  for (const key of [...keptRepos].sort()) {
    const r = facts.get(key);
    if (!r || detailFrom === undefined) continue;
    const commits = r.commits.filter((c) => inRange(c.ts) && c.ts <= hi);
    for (const c of commits) {
      if (!c.owner || c.ts < detailFrom) continue;
      own++;
      if (c.ai !== undefined || c.generated !== undefined) ai++;
    }
    if (!r.fileLists) continue;
    const later = commits.filter((c) => c.rework !== undefined);
    for (const c of commits) {
      if (!c.owner || c.rework === "revert" || c.ts < reworkFrom!) continue;
      reworkDen++;
      if (reworkedBy(c, later)) reworked++;
    }
  }

  // rows in identity repos with a commit within a day after their end
  let afterDen = 0;
  let afterNum = 0;
  const afterSpan = new Span();
  for (const [key, rows] of activeRows) {
    const r = facts.get(key)!;
    if (!r.identity) continue;
    const ts = r.commits.map((c) => c.ts).filter((x) => inRange(x) && x <= hi);
    for (const s of rows) {
      afterDen++;
      afterSpan.add(s);
      if (ts.some((x) => x > s.end && x <= s.end + DELIVERY_WINDOW_MS)) afterNum++;
    }
  }

  // used artifacts, provenance-weighted: the distinct config entries in use (`artifactUse`, which documents the rule). A
  // measured state whenever a config source was read (none in use is a measured 0); null only when none was read
  const used = artifactUse(raw, t, scope).filter((a) => a.used);
  const configRead = new Set<string>();
  for (const c of raw.coverage) if (!excluded.has(c.tool) && CONFIG_SOURCES.has(c.source) && READ.has(c.status)) configRead.add(c.source);
  for (const c of configs) configRead.add(c.source);
  let artifactWeight = 0;
  const artifactSources = new Set(used.length > 0 ? [] : configRead); // sources only: a state count has no from/to
  for (const u of used) { artifactWeight += weight(u.provenance); for (const src of u.sources) artifactSources.add(src); }
  const artifacts: Metric = configRead.size > 0
    ? { window: "lifetime", sources: [...artifactSources].sort(), n: used.length, value: artifactWeight }
    : fixedMetric("lifetime", [], 0, null, "not-captured");

  const memoryFiles = configs.filter((c) => c.kind === "memory-file").length;
  const commitSpan = { from: detailFrom, to: hi };

  return {
    parallelShare: bucketSpan.metric("detail", perBucket.size, ratio(parallel, perBucket.size)),
    peakConcurrency: peak,
    headlessPerWeek: allSpan.metric("detail", detailWeeks, ratio(scripted, detailWeeks)),
    guardrails: repoMetric(activeRepos, mean(guards), gitSpan),
    maintainedShare: repoMetric(activeRepos, ratio(maintained, activeRepos), gitSpan),
    // config is read by lifetime-window readers (`uses` are the tools' own lifetime counters): a lifetime metric
    artifacts,
    memoryFiles,
    switchesPerWeek: switchSpan.metric("lifetime", switchWeeks, ratio(switches, switchWeeks), switchWeeks === 0 ? "not-captured" : "no-data"),
    reworkShare: repoMetric(reworkDen, ratio(reworked, reworkDen), { from: reworkFrom, to: hi }),
    prsPerWeek: prSpan.metric("detail", prWeeks, ratio(prs.size, prWeeks), prWeeks === 0 ? "not-captured" : "no-data"),
    aiCoauthoredShare: repoMetric(own, ratio(ai, own), commitSpan),
    commitAfterSession: repoMetric(afterDen, ratio(afterNum, afterDen), afterSpan.range()),
    repoSignals: repoStatus,
    evidence: { repos: repoOff ? 0 : activeRepos, buckets: perBucket.size, artifacts: used.length, lifetimeWeeks: t.activity.lifetimeWeeks.length, ownCommits: own },
    ...(firstParallel === undefined ? {} : { firstParallelBucket: firstParallel * BUCKET_MS }),
  };
}

/** A later rework commit (revert, fix-up or fix) of the repo touches one of `c`'s files within REWORK_WINDOW_MS. */
function reworkedBy(c: CommitFact, later: readonly CommitFact[]): boolean {
  if (c.files.length === 0) return false;
  const files = new Set(c.files);
  return later.some((r) => r !== c && r.ts > c.ts && r.ts - c.ts <= REWORK_WINDOW_MS && r.files.some((f) => files.has(f)));
}
