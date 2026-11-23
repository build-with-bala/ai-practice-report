import { isoWeek } from "../analysis/activity";
import { PR_LINK_TOOLS, SWITCH_TOOLS, type Metric, type SessionTable } from "../analysis/types";
import type { SessionStats } from "../analysis/walk";
import type { CommitFact, RepoFacts } from "../git/types";
import { BUCKET_MS, DELIVERY_WINDOW_MS, REWORK_WINDOW_MS } from "../model/constants";
import type { ConfigEv } from "../model/events";
import type { ToolId } from "../model/ids";
import type { ScanResult } from "../scan";
import { keyedHash } from "../text/hash";
import { fixedMetric, Span, type Globals } from "./types";

const DAY_MS = 86_400_000;
/** Rework counts own commits from this long before the detail window's start: their fixes can land inside it. */
const REWORK_LEAD_MS = 3 * DAY_MS;
const ARTIFACT_KINDS: ReadonlySet<ConfigEv["kind"]> = new Set<ConfigEv["kind"]>(["skill", "command", "agent", "plugin", "mcp-server"]);
const weight = (p: ConfigEv["provenance"]): number => (p === "authored" ? 1 : 0.3);
const ratio = (num: number, den: number): number | null => (den > 0 ? num / den : null);
const mean = (v: readonly number[]): number | null => (v.length > 0 ? v.reduce((a, b) => a + b, 0) / v.length : null);

/** The distinct ISO weeks of the given tools' active days in one window, from `Activity.byTool`. */
function toolWeeks(t: SessionTable, tools: ReadonlySet<ToolId>, window: "detailDays" | "lifetimeDays"): number {
  const weeks = new Set<string>();
  for (const tool of tools) for (const day of t.activity.byTool[tool]?.[window] ?? []) weeks.add(isoWeek(day));
  return weeks.size;
}

/**
 * The signals computed across sessions (spec §6.4), once per analysis; the bootstrap holds them fixed. Pure: no clock,
 * no I/O (`now` is the analysis time). Everything is clipped to `t.scope`: commits, markers and tool calls outside the
 * date range never count, and nothing of an excluded tool counts.
 *
 * - **Buckets.** An active bucket holds an action of at least one `detailTop` row (scripted rows too); a parallel one,
 *   of at least 2 rows. `firstParallelBucket` is the start of the earliest parallel bucket (pre-flight P14).
 * - **Repos.** An active repo is the `repoKey` of at least one `detailTop` row; repo-wide totals (rework, co-authored
 *   share) read the repos of any kept row (no host copy), so a repo only an excluded project or tool used never counts.
 *   Whole-report totals count owner commits only; per-repo matching (a commit after a session, a later fix) takes any.
 * - **Per-week rates** divide by the active weeks of the tools that emit their markers (pre-flight P10): null when none
 *   of them has a week, never 0.
 */
export function computeGlobals(t: SessionTable, stats: readonly SessionStats[], raw: ScanResult, o: { now: number }): Globals {
  const { from, to, tools: excluded } = t.scope;
  const inRange = (ts: number): boolean => ts >= from && ts <= to;
  const repoStatus = raw.repos.status;
  const repoOff = repoStatus === "off" || repoStatus === "git-missing";
  const kept = (sessionId: string): boolean => t.rows.has(sessionId) && !t.hosts.has(sessionId);

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
  const prWeeks = toolWeeks(t, PR_LINK_TOOLS, "detailDays");
  const prSpan = new Span();
  const prs = new Set<string>();
  for (const s of stats) {
    if (PR_LINK_TOOLS.has(s.tool)) prSpan.add(s);
    for (const k of s.prKeys) prs.add(k);
  }

  // switches per lifetime week of the tools that record them (pre-flight P10)
  const switchWeeks = toolWeeks(t, SWITCH_TOOLS, "lifetimeDays");
  const switchSpan = new Span();
  let switches = 0;
  for (const m of raw.store.all("marker")) {
    if ((m.kind !== "model-switch" && m.kind !== "effort-switch") || m.detail === undefined) continue;
    if (!SWITCH_TOOLS.has(m.tool) || excluded.has(m.tool) || !inRange(m.ts)) continue;
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
  const configs = raw.store.all("config").filter((c) => !excluded.has(c.tool));
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
  for (const row of t.rows.values()) if (row.repoKey !== undefined && !t.hosts.has(row.id)) keptRepos.add(row.repoKey);
  const detailFrom = stats.length > 0 ? Math.max(from, stats.reduce((m, s) => Math.min(m, s.start), Infinity)) : undefined;
  const hi = Math.min(o.now, to);
  const reworkFrom = detailFrom === undefined ? undefined : Math.max(from, detailFrom - REWORK_LEAD_MS);
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

  // used artifacts, provenance-weighted
  const mcpNamed = new Set<string>();
  for (const e of raw.store.all("tool")) {
    if (e.mcpServer !== undefined && !excluded.has(e.tool) && inRange(e.ts) && kept(e.sessionId) && t.rows.get(e.sessionId)!.window === "detail") mcpNamed.add(e.mcpServer);
  }
  const childTypes = new Set<string>();
  for (const row of t.rows.values()) if (row.agentType !== undefined && row.parentId !== undefined && !t.hosts.has(row.id)) childTypes.add(row.agentType);
  const used = new Map<string, { w: number; source: string }>();
  for (const c of configs) {
    if (!ARTIFACT_KINDS.has(c.kind) || c.name === undefined) continue;
    const isUsed = (c.uses ?? 0) > 0
      || (c.kind === "mcp-server" && mcpNamed.has(c.name))
      || (c.kind === "agent" && (childTypes.has(keyedHash(raw.salt, c.name)) || childTypes.has(c.name)));
    if (!isUsed) continue;
    const key = `${c.kind}\u0000${c.name}`;
    const was = used.get(key);
    if (!was || weight(c.provenance) > was.w) used.set(key, { w: weight(c.provenance), source: c.source });
  }
  const artifactSpan = new Span();
  let artifactWeight = 0;
  for (const u of used.values()) { artifactWeight += u.w; artifactSpan.addSource(u.source); }

  const memoryFiles = configs.filter((c) => c.kind === "memory-file").length;
  const commitSpan = { from: detailFrom, to: hi };

  return {
    parallelShare: bucketSpan.metric("detail", perBucket.size, ratio(parallel, perBucket.size)),
    peakConcurrency: peak,
    headlessPerWeek: allSpan.metric("detail", detailWeeks, ratio(scripted, detailWeeks)),
    guardrails: repoMetric(activeRepos, mean(guards), gitSpan),
    maintainedShare: repoMetric(activeRepos, ratio(maintained, activeRepos), gitSpan),
    artifacts: artifactSpan.metric("detail", used.size, used.size > 0 ? artifactWeight : null),
    memoryFiles,
    switchesPerWeek: switchSpan.metric("lifetime", switchWeeks, ratio(switches, switchWeeks), switchWeeks === 0 ? "not-captured" : "no-data"),
    reworkShare: repoMetric(reworkDen, ratio(reworked, reworkDen), { from: reworkFrom, to: hi }),
    prsPerWeek: prSpan.metric("detail", prWeeks, ratio(prs.size, prWeeks), prWeeks === 0 ? "not-captured" : "no-data"),
    aiCoauthoredShare: repoMetric(own, ratio(ai, own), commitSpan),
    commitAfterSession: repoMetric(afterDen, ratio(afterNum, afterDen), afterSpan.range()),
    repoSignals: repoStatus,
    evidence: { repos: repoOff ? 0 : activeRepos, buckets: perBucket.size, artifacts: used.size, lifetimeWeeks: t.activity.lifetimeWeeks.length, ownCommits: own },
    ...(firstParallel === undefined ? {} : { firstParallelBucket: firstParallel * BUCKET_MS }),
  };
}

/** A later rework commit (revert, fix-up or fix) of the repo touches one of `c`'s files within REWORK_WINDOW_MS. */
function reworkedBy(c: CommitFact, later: readonly CommitFact[]): boolean {
  if (c.files.length === 0) return false;
  const files = new Set(c.files);
  return later.some((r) => r !== c && r.ts > c.ts && r.ts - c.ts <= REWORK_WINDOW_MS && r.files.some((f) => files.has(f)));
}
