import { describe, expect, test } from "bun:test";
import { buildSessionTable } from "../../../core/analysis/sessions";
import type { Exclusions, Metric } from "../../../core/analysis/types";
import { buildSessionStats, type SessionStats } from "../../../core/analysis/walk";
import type { CommitFact, RepoFacts, RepoSignals } from "../../../core/git/types";
import type { ConfigEv, CoverageEv, Ev, MarkerEv, PromptEv, PromptFeatures, SessionEv, ToolEv } from "../../../core/model/events";
import type { MarkerKind, ToolId, Window } from "../../../core/model/ids";
import { computeSignals } from "../../../core/signals/compute";
import { computeGlobals } from "../../../core/signals/globals";
import type { Globals } from "../../../core/signals/types";
import { keyedHash } from "../../../core/text/hash";
import { scanResultOf } from "../../kit/scanresult";

const T0 = Date.UTC(2026, 10, 2, 9, 0); // a Monday, on a 10-minute bucket boundary
const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const CC = "claude-code.transcripts";
const CX = "codex.rollouts";
const HIST = "claude-code.history";

// ---------- hand-built per-session statistics ----------

const stat = (id: string, over: Partial<SessionStats> = {}): SessionStats => ({
  id, tool: "claude-code", source: CC, origin: "human", start: T0, end: T0 + HOUR, scripted: false, days: [],
  turns: 0, stickySum: 0, actions: 0, successRuns: {}, gatedVae: true, editTurns: 0, editWeight: 0, verifiedWeight: 0,
  failingChecks: 0, closedChecks: 0, fixCycles: {}, episodes: 0, followUps: 0, briefs: 0, correctedBriefs: 0, briefScoreSum: 0,
  interrupts: 0, healthyInterrupts: 0, workEpisodes: 0, turnsPerWorkSum: 0, queued: 0,
  children: 0, finishedChildren: 0, bgKnown: 0, bgChildren: 0, childTypes: {}, workflowRuns: 0, maxDepth: 0,
  compactAuto: 0, compactManual: 0, freshEpisodes: 0, tierPairs: [],
  tokens: 0, tokensKnown: false, usd: 0, usdKnown: false, landed: 0,
  editEpisodes: 0, editEpisodesInRepo: 0, landedEpisodes: 0, prKeys: [], commitShaKeys: [], buckets: [], ...over,
});
const nullMetric = (window: Window = "detail"): Metric => ({ window, sources: [], n: 0, value: null, reason: "no-data" });
const globals = (over: Partial<Globals> = {}): Globals => ({
  parallelShare: nullMetric(), peakConcurrency: 0, headlessPerWeek: nullMetric(), guardrails: nullMetric(), maintainedShare: nullMetric(),
  artifacts: nullMetric(), memoryFiles: 0, switchesPerWeek: nullMetric("lifetime"), reworkShare: nullMetric(), prsPerWeek: nullMetric(),
  aiCoauthoredShare: nullMetric(), commitAfterSession: nullMetric(), repoSignals: "ok",
  evidence: { repos: 0, buckets: 0, artifacts: 0, lifetimeWeeks: 0, ownCommits: 0 }, ...over,
});

describe("computeSignals: the sample formulas", () => {
  const a = stat("a", {
    source: CC, start: T0, end: T0 + HOUR, days: ["2026-11-02", "2026-11-03"],
    turns: 4, stickySum: 6, actions: 20, successRuns: { 3: 2, 10: 1 },
    editTurns: 2, editWeight: 4, verifiedWeight: 3, failingChecks: 4, closedChecks: 3, fixCycles: { 1: 1, 2: 1 },
    episodes: 2, followUps: 2, briefs: 2, correctedBriefs: 1, briefScoreSum: 1.2, interrupts: 2, healthyInterrupts: 1,
    workEpisodes: 2, turnsPerWorkSum: 1.5, queued: 2, children: 3, finishedChildren: 2, bgKnown: 2, bgChildren: 1,
    childTypes: { explore: 2, implement: 1 }, workflowRuns: 1, maxDepth: 2, compactAuto: 3, compactManual: 1, freshEpisodes: 1,
    tierPairs: [21, 1, 33, 3], tokens: 1_000, tokensKnown: true, usd: 2, usdKnown: true, landed: 2,
    editEpisodes: 2, editEpisodesInRepo: 2, landedEpisodes: 1,
  });
  const b = stat("b", {
    tool: "codex", source: CX, start: T0 + DAY, end: T0 + DAY + HOUR, days: ["2026-11-03", "2026-11-10"],
    turns: 6, stickySum: 4, actions: 10, successRuns: { 5: 1, 7: 1 }, gatedVae: false,
    failingChecks: 1, closedChecks: 1, fixCycles: { 3: 1 }, episodes: 3, followUps: 3, briefs: 3, correctedBriefs: 0, briefScoreSum: 1.8,
    workEpisodes: 1, turnsPerWorkSum: 0.5, freshEpisodes: 3, tierPairs: [22, 2], tokens: 500, tokensKnown: true, landed: 0,
    editEpisodesInRepo: 2, landedEpisodes: 2, maxDepth: 1, childTypes: { explore: 1 },
  });
  const s = computeSignals([a, b], globals());

  test("ratios over the sample, with n and the contributing rows' sources and span", () => {
    expect(s.vae).toEqual({ window: "detail", sources: [CC], from: T0, to: T0 + HOUR, n: 2, value: 0.75 });
    expect(s.closure).toEqual({ window: "detail", sources: [CC, CX].sort(), from: T0, to: T0 + DAY + HOUR, n: 5, value: 0.8 });
    expect([s.stickyMean.value, s.stickyMean.n]).toEqual([1, 10]);
    expect([s.actionsPerTurn.value, s.actionsPerTurn.n]).toEqual([3, 10]);
    expect([s.backgroundShare.value, s.backgroundShare.n, s.backgroundShare.sources]).toEqual([0.5, 2, [CC]]);
    expect([s.fanoutPerEpisode.value, s.fanoutPerEpisode.n]).toEqual([0.4, 5]);
    expect([s.workflowRunsPerEpisode.value, s.workflowRunsPerEpisode.n]).toEqual([0.2, 5]);
    expect([s.correctionRate.value, s.correctionRate.n]).toEqual([0.2, 5]);
    expect([s.healthyInterruptShare.value, s.healthyInterruptShare.n]).toEqual([0.5, 2]);
    expect([s.turnsPerWork.value, s.turnsPerWork.n]).toEqual([2 / 3, 3]);
    expect(s.briefScore.value).toBeCloseTo(0.6, 12);
    expect(s.briefScore.n).toBe(5);
    expect([s.landedShare.value, s.landedShare.n]).toEqual([0.75, 4]);
  });

  test("percentiles, the fix-cycle median, hygiene, rho and cost per landed unit", () => {
    // runs 3, 3, 5, 7, 10: nearest rank ceil(0.9 · 5) = 5 → 10
    expect([s.p90Run.value, s.p90Run.n]).toEqual([10, 5]);
    // cycles 1, 2, 3: nearest rank ceil(0.5 · 3) = 2 → 2
    expect(s.medianFixCycles).toBe(2);
    // manual share 1 / 4, fresh share 4 / 5
    expect(s.hygiene.value).toBeCloseTo((0.25 + 0.8) / 2, 12);
    expect(s.hygiene.n).toBe(4 + 5);
    // tiers 21, 33, 22 against sizes 1, 3, 2: the same order, rho 1
    expect(s.rho.value).toBeCloseTo(1, 12);
    expect(s.rho.n).toBe(3);
    expect([s.tokensPerLanded.value, s.tokensPerLanded.n]).toEqual([750, 2]);
    // every known row in either sum is in the span: b adds tokens, though it landed nothing
    expect([s.tokensPerLanded.sources, s.tokensPerLanded.from, s.tokensPerLanded.to]).toEqual([[CC, CX], T0, T0 + DAY + HOUR]);
    expect([s.usdPerLanded.value, s.usdPerLanded.n, s.usdPerLanded.sources]).toEqual([1, 2, [CC]]);
  });

  test("shown values: queue per turn (tools that record queueing), child types, depth", () => {
    expect([s.queuePerTurn.value, s.queuePerTurn.n, s.queuePerTurn.sources]).toEqual([0.5, 4, [CC]]);
    expect(s.childTypes).toEqual({ explore: 3, plan: 0, review: 0, implement: 1, custom: 0, other: 0 });
    expect(s.maxDepth).toBe(2);
  });

  test("evidence sums the sample; days and weeks are distinct", () => {
    expect(s.evidence).toEqual({
      typedTurns: 10, sessions: 2, days: 3, weeks: 2, episodes: 5, editTurns: 2, followUps: 5, briefs: 5, failingChecks: 5,
      interrupts: 2, workEpisodes: 3, tierEpisodes: 3, editEpisodesInRepo: 4, landed: 2, repos: 0, buckets: 0, bgKnown: 2,
      artifacts: 0, lifetimeWeeks: 0, ownCommits: 0,
    });
  });

  test("rho uses average ranks; it is null under 3 pairs and when a side is constant", () => {
    const pairs = (p: number[]) => computeSignals([stat("x", { tierPairs: p })], globals()).rho;
    expect(pairs([21, 1, 21, 2, 33, 3]).value).toBeCloseTo(Math.sqrt(3) / 2, 12);
    expect(pairs([21, 1, 33, 2]).value).toBeNull();
    expect(pairs([21, 1, 21, 2, 21, 3]).value).toBeNull();
    expect([pairs([21, 1, 21, 2, 21, 3]).n, pairs([21, 1, 21, 2, 21, 3]).reason]).toEqual([3, "degenerate"]); // n > 0, value null
    expect(pairs([21, 1, 33, 2]).reason).toBe("degenerate");
    expect(computeSignals([stat("x", { episodes: 1, tierPairs: [] })], globals()).rho.reason).toBe("not-captured");
    expect(pairs([21, 1, 22, 1, 33, 1]).value).toBeNull();
  });

  test("hygiene takes the parts it has: fresh share only without compactions", () => {
    const h = computeSignals([stat("x", { episodes: 4, freshEpisodes: 1 })], globals()).hygiene;
    expect([h.value, h.n]).toEqual([0.25, 4]);
  });
});

describe("computeSignals: not measurable, never 0", () => {
  test("an empty sample gives null with n 0 for every sample metric", () => {
    const s = computeSignals([], globals());
    for (const k of ["vae", "closure", "stickyMean", "p90Run", "actionsPerTurn", "backgroundShare", "fanoutPerEpisode", "workflowRunsPerEpisode",
      "correctionRate", "healthyInterruptShare", "turnsPerWork", "queuePerTurn", "briefScore", "hygiene", "rho", "tokensPerLanded",
      "usdPerLanded", "landedShare"] as const) {
      expect([k, s[k].value, s[k].n, s[k].sources, s[k].from, s[k].window]).toEqual([k, null, 0, [], undefined, "detail"]);
    }
    expect([s.medianFixCycles, s.maxDepth, s.evidence.typedTurns]).toEqual([null, 0, 0]);
    expect(JSON.stringify(s)).not.toMatch(/NaN|Infinity/);
  });

  test("a field no tool in the sample records is not-captured; recorded but absent is no-data", () => {
    const ungated = computeSignals([stat("x", { gatedVae: false, turns: 2, tool: "copilot", source: "copilot.vscode" })], globals());
    expect([ungated.vae.value, ungated.vae.reason]).toEqual([null, "not-captured"]);
    expect([ungated.queuePerTurn.value, ungated.queuePerTurn.reason]).toEqual([null, "not-captured"]);
    const noEdits = computeSignals([stat("x", { gatedVae: true, turns: 2 })], globals());
    expect([noEdits.vae.value, noEdits.vae.reason]).toEqual([null, "no-data"]);
    const noBg = computeSignals([stat("x", { children: 2, episodes: 1 })], globals());
    expect([noBg.backgroundShare.value, noBg.backgroundShare.reason]).toEqual([null, "not-captured"]);
    const noUsage = computeSignals([stat("x", { landed: 3 })], globals());
    expect([noUsage.tokensPerLanded.value, noUsage.tokensPerLanded.reason, noUsage.usdPerLanded.reason]).toEqual([null, "not-captured", "not-captured"]);
    const noPairs = computeSignals([stat("x", { episodes: 3 })], globals());
    expect([noPairs.rho.value, noPairs.rho.reason]).toEqual([null, "not-captured"]);
  });

  test("with repo signals off, landed share is null and the globals pass through", () => {
    const s = computeSignals([stat("x", { editEpisodesInRepo: 2, landedEpisodes: 1 })], globals({ repoSignals: "off" }));
    expect([s.landedShare.value, s.landedShare.reason, s.repoSignals]).toEqual([null, "repo-signals-off", "off"]);
  });
});

describe("computeSignals: purity and budget", () => {
  const sample = (n: number): SessionStats[] => Array.from({ length: n }, (_, i) => stat(`r${i}`, {
    tool: i % 3 === 0 ? "codex" : "claude-code", source: i % 3 === 0 ? CX : CC, start: T0 + i * HOUR, end: T0 + i * HOUR + 30 * MIN,
    days: [`2026-11-${String(1 + (i % 28)).padStart(2, "0")}`], turns: 5 + (i % 4), stickySum: 3 + (i % 5), actions: 30, successRuns: { [i % 40]: 2, 7: 1 },
    editTurns: i % 3, editWeight: 2 * (i % 3), verifiedWeight: i % 3, failingChecks: i % 2, closedChecks: i % 2, fixCycles: { 1: i % 2 },
    episodes: 2, followUps: 3, briefs: 2, correctedBriefs: i % 2, briefScoreSum: 0.8, interrupts: 1, healthyInterrupts: i % 2,
    workEpisodes: 2, turnsPerWorkSum: 1.2, queued: 1, children: 2, finishedChildren: 1, bgKnown: 2, bgChildren: i % 2,
    childTypes: { explore: 1, implement: 1 }, compactAuto: 1, compactManual: i % 2, freshEpisodes: 1,
    tierPairs: [20 + (i % 13), i % 7, 30 + (i % 3), i % 5], tokens: 10_000, tokensKnown: true, landed: i % 3,
    editEpisodesInRepo: 1, landedEpisodes: i % 2, prKeys: [`p${i}`], buckets: [i, i + 1],
  }));

  test("the same input gives deep-equal output, and the inputs are not mutated", () => {
    const rows = sample(50);
    const g = globals();
    const before = structuredClone({ rows, g });
    const first = computeSignals(rows, g);
    const second = computeSignals(rows, g);
    expect(second).toEqual(first);
    expect({ rows, g }).toEqual(before);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });

  // a guard against a runaway cost, not a benchmark: the bound leaves room for slow CI runners
  test("a 5,000-row sample, computed 200 times, takes under 10 s", () => {
    const rows = sample(5_000);
    const g = globals();
    computeSignals(rows, g);
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) computeSignals(rows, g);
    expect(performance.now() - t0).toBeLessThan(10_000);
  });
});

// ---------- the globals, from a scan result ----------

const cov = (tool: ToolId, source: string, window: Window): CoverageEv => ({
  k: "coverage", tool, source, window, status: "ok", beta: false, files: 1, bytes: 1, records: 1, skipped: {}, unknownTypes: {}, versions: [],
});
const COVERAGE: Ev[] = [cov("claude-code", CC, "detail"), cov("claude-code", HIST, "lifetime"), cov("codex", CX, "detail"), cov("codex", "codex.history", "lifetime")];
const SRC: Partial<Record<ToolId, string>> = { "claude-code": CC, codex: CX };
const sess = (id: string, over: Partial<SessionEv> = {}): SessionEv => {
  const tool = over.tool ?? "claude-code";
  return { k: "session", tool, source: SRC[tool]!, id, window: "detail", origin: "human", start: T0, end: T0 + HOUR, models: [], ...over };
};
const features: PromptFeatures = { words: 6, lenBucket: 1, hasContext: false, fileRefs: 0, listLines: 0, constraintTerms: 0, isTaskStart: false, techCats: {} };
let hashes = 0;
const prompt = (sessionId: string | undefined, ts: number, over: Partial<PromptEv> = {}): PromptEv => {
  const tool = over.tool ?? "claude-code";
  const p: PromptEv = { k: "prompt", tool, source: SRC[tool]!, ts, window: "detail", origin: "human", intent: "spec", textHash: `h${++hashes}`, features, ...over };
  if (sessionId !== undefined) p.sessionId = sessionId;
  return p;
};
const tool = (sessionId: string, ts: number, over: Partial<ToolEv> = {}): ToolEv => {
  const t = over.tool ?? "claude-code";
  return { k: "tool", tool: t, source: SRC[t]!, ts, sessionId, name: "Read", category: "read", ...over };
};
const marker = (sessionId: string | undefined, ts: number, kind: MarkerKind, over: Partial<MarkerEv> = {}): MarkerEv => {
  const m: MarkerEv = { k: "marker", tool: "claude-code", source: CC, ts, kind, ...over };
  if (sessionId !== undefined) m.sessionId = sessionId;
  return m;
};
const config = (kind: ConfigEv["kind"], name: string | undefined, over: Partial<ConfigEv> = {}): ConfigEv => {
  const c: ConfigEv = { k: "config", tool: "claude-code", source: "claude-code.config", kind, provenance: "authored", ...over };
  if (name !== undefined) c.name = name;
  return c;
};
const commit = (ts: number, shaKey: string, files: string[], over: Partial<CommitFact> = {}): CommitFact => ({ ts, shaKey, files, owner: true, ...over });
const repo = (repoKey: string, projectKeys: string[], over: Partial<RepoFacts> = {}): RepoFacts => ({
  repoKey, projectKeys, identity: true, commits: [], commitsTruncated: false, fileLists: true,
  instructions: { files: [], namesChecks: [], touched: 0 }, hooks: { entries: 0, checks: [], disabled: false },
  ci: { present: false, checks: [] }, precommit: { present: false, checks: [] }, ...over,
});
const signals = (repos: RepoFacts[], status: RepoSignals["status"] = "ok"): RepoSignals => ({ status, repos, roots: new Map(), skipped: {}, ms: 0 });

function globalsOf(evs: Ev[], o: { repos?: RepoSignals; exclude?: Exclusions; now?: number } = {}): { g: Globals; stats: SessionStats[] } {
  const raw = scanResultOf([...COVERAGE, ...evs], o.repos ? { repos: o.repos } : {});
  const now = o.now ?? raw.finishedAt;
  const t = buildSessionTable(raw, { now, timeZone: "UTC", ...(o.exclude ? { exclude: o.exclude } : {}) });
  const stats = buildSessionStats(t, raw.store, raw.repos, { timeZone: "UTC" });
  return { g: computeGlobals(t, stats, raw, { now }), stats };
}

/**
 * Two Claude Code sessions in repo R that overlap in one bucket, one in repo S, one in no repo a week later, a scripted
 * Codex run, and a human Codex session in a third week: three detail weeks, two of them Claude Code's.
 */
const WORLD: Ev[] = [
  sess("a", { projectKey: "PK", start: T0, end: T0 + HOUR }), prompt("a", T0), tool("a", T0 + MIN), tool("a", T0 + 20 * MIN),
  marker("a", T0 + 30 * MIN, "pr-link", { detail: "pr1" }), tool("a", T0 + 21 * MIN, { name: "mcp", category: "mcp", mcpServer: "m1" }),
  sess("b", { projectKey: "PK", start: T0 + 30 * SEC, end: T0 + 2 * HOUR }), prompt("b", T0 + 30 * SEC), tool("b", T0 + 2 * MIN),
  marker("b", T0 + HOUR, "pr-link", { detail: "pr1" }), marker("b", T0 + HOUR, "pr-link", { detail: "pr2" }),
  sess("e", { projectKey: "PS", start: T0 + 3 * HOUR, end: T0 + 4 * HOUR }), prompt("e", T0 + 3 * HOUR),
  sess("d", { start: T0 + 7 * DAY, end: T0 + 7 * DAY + HOUR }), prompt("d", T0 + 7 * DAY),
  sess("c", { tool: "codex", origin: "scripted", start: T0 + 5 * DAY, end: T0 + 5 * DAY + HOUR }),
  prompt("c", T0 + 5 * DAY, { tool: "codex", origin: "scripted" }), tool("c", T0 + 5 * DAY + MIN, { tool: "codex" }),
  sess("x", { tool: "codex", start: T0 + 14 * DAY, end: T0 + 14 * DAY + HOUR }), prompt("x", T0 + 14 * DAY, { tool: "codex" }),
  sess("k", { parentId: "a", origin: "subagent", agentType: keyedHash(new Uint8Array(32), "my-agent"), start: T0 + 5 * MIN }),
  // the history: lifetime prompts (two Claude Code weeks) and switches
  prompt(undefined, T0, { source: HIST, window: "lifetime" }), prompt(undefined, T0 + 7 * DAY, { source: HIST, window: "lifetime" }),
  marker("a", T0 + 10 * MIN, "model-switch", { source: HIST, detail: "opus" }), marker("d", T0 + 7 * DAY, "effort-switch", { source: HIST, detail: "high" }),
  marker(undefined, T0 + 8 * DAY, "model-switch", { source: HIST, detail: "sonnet" }), marker("a", T0 + 11 * MIN, "model-switch", { source: HIST }),
];
const REPOS = (): RepoSignals => signals([
  repo("R", ["PK"], {
    hooks: { entries: 1, checks: ["test"], disabled: false }, precommit: { present: true, checks: ["lint"] },
    instructions: { files: ["claude"], namesChecks: ["build"], touched: 2 },
    commits: [
      commit(T0 + 30 * MIN, "c1", ["f1"], { ai: "claude" }), commit(T0 + 5 * HOUR, "c2", ["f1", "f3"], { rework: "fix" }),
      commit(T0 - 10 * DAY, "c3", ["f1"]), commit(T0 + 6 * HOUR, "c4", ["f9"], { rework: "revert" }),
      commit(T0 + 3 * HOUR, "c5", ["f2"], { owner: false }),
    ],
  }),
  repo("S", ["PS"], { instructions: { files: [], namesChecks: ["test"], touched: 0 } }),
]);

describe("computeGlobals", () => {
  test("parallel buckets, peak concurrency and the first parallel bucket (pre-flight P14)", () => {
    const { g } = globalsOf(WORLD, { repos: REPOS() });
    // buckets: [T0, +10 min) holds a and b; [+20, +30 min) a and its child k's none; c's own bucket
    expect([g.parallelShare.value, g.parallelShare.n, g.peakConcurrency, g.evidence.buckets]).toEqual([1 / 3, 3, 2, 3]);
    expect(g.firstParallelBucket).toBe(T0);
    expect(g.parallelShare.sources).toEqual([CC, CX]);
  });

  test("headless runs per detail week; PRs per week of the tools that link PRs (pre-flight P10)", () => {
    const { g } = globalsOf(WORLD, { repos: REPOS() });
    expect([g.headlessPerWeek.value, g.headlessPerWeek.n]).toEqual([1 / 3, 3]);
    expect([g.prsPerWeek.value, g.prsPerWeek.n, g.prsPerWeek.window]).toEqual([1, 2, "detail"]); // pr1 and pr2 over Claude Code's 2 weeks
  });

  test("switches per lifetime week of the tools that record them; picker opens do not count (pre-flight P10)", () => {
    const { g } = globalsOf(WORLD, { repos: REPOS() });
    expect([g.switchesPerWeek.value, g.switchesPerWeek.n, g.switchesPerWeek.window, g.switchesPerWeek.sources]).toEqual([1.5, 2, "lifetime", [HIST]]);
    expect(g.evidence.lifetimeWeeks).toBe(2);
  });

  test("with Codex data only, switches and PRs per week are null, never 0 (pre-flight P10)", () => {
    const { g } = globalsOf([
      sess("x", { tool: "codex" }), prompt("x", T0, { tool: "codex" }), tool("x", T0 + MIN, { tool: "codex" }),
      prompt(undefined, T0, { tool: "codex", source: "codex.history", window: "lifetime" }),
    ]);
    expect([g.switchesPerWeek.value, g.switchesPerWeek.n, g.switchesPerWeek.reason]).toEqual([null, 0, "not-captured"]);
    expect([g.prsPerWeek.value, g.prsPerWeek.n, g.prsPerWeek.reason]).toEqual([null, 0, "not-captured"]);
  });

  test("guardrails and maintained instruction files over the active repos", () => {
    const { g } = globalsOf(WORLD, { repos: REPOS() });
    // R: hook with checks, pre-commit with checks, instructions name no test → 2/3; S: instructions name test → 1/3
    expect([g.guardrails.value, g.guardrails.n, g.guardrails.sources, g.guardrails.window]).toEqual([0.5, 2, ["git"], "detail"]);
    expect([g.maintainedShare.value, g.maintainedShare.n]).toEqual([0.5, 2]);
    expect(g.evidence.repos).toBe(2);
    // a user-level hook with checks counts for every repo, unless hooks are disabled
    const hook = config("hook", "PreToolUse", { checks: ["test"] });
    expect(globalsOf([...WORLD, hook], { repos: REPOS() }).g.guardrails.value).toBeCloseTo(2 / 3, 12);
    expect(globalsOf([...WORLD, hook, config("feature", "hooks-disabled")], { repos: REPOS() }).g.guardrails.value).toBe(0.5);
    // a repo whose hooks are disabled has no hook guardrail
    const off = REPOS();
    off.repos[0]!.hooks.disabled = true;
    expect(globalsOf(WORLD, { repos: off }).g.guardrails.value).toBeCloseTo((1 / 3 + 1 / 3) / 2, 12);
  });

  test("rework, AI co-authored share and commits after a session, from own commits", () => {
    const { g } = globalsOf(WORLD, { repos: REPOS(), now: T0 + 15 * DAY });
    // own non-revert commits in [detail from − 3 days, now]: c1, c2 (c3 is older, c5 is no owner's); c2 fixes c1's file
    expect([g.reworkShare.value, g.reworkShare.n, g.reworkShare.sources]).toEqual([0.5, 2, ["git"]]);
    expect([g.reworkShare.from, g.reworkShare.to]).toEqual([T0 - 3 * DAY, T0 + 15 * DAY]);
    // own commits in the detail span: c1 (claude), c2, c4
    expect([g.aiCoauthoredShare.value, g.aiCoauthoredShare.n, g.evidence.ownCommits]).toEqual([1 / 3, 3, 3]);
    // rows in identity repos: a and b each have a commit within a day after their end (c2, c5); e has none
    expect([g.commitAfterSession.value, g.commitAfterSession.n]).toEqual([2 / 3, 3]);
  });

  test("used artifacts, weighted by provenance; memory files shown", () => {
    const { g } = globalsOf([
      ...WORLD,
      config("skill", "s1", { uses: 3 }), config("skill", "s1", { provenance: "installed", uses: 1 }), config("skill", "s2", { provenance: "installed", uses: 0 }),
      config("command", "c1", { provenance: "bundled", uses: 2 }), config("mcp-server", "m1", { provenance: "installed" }),
      config("mcp-server", "m2", { provenance: "unknown" }), config("agent", "my-agent"), config("agent", "unused-agent"),
      config("plugin", "p1", { provenance: "unknown", uses: 4 }), config("hook", "Stop", { uses: 9 }),
      config("memory-file", undefined), config("memory-file", undefined),
      config("plugin", "p2", { tool: "codex", source: "codex.config", uses: 5 }),
    ], { repos: REPOS(), exclude: { tools: ["codex"] } });
    // s1 1.0, c1 0.3, m1 0.3 (named by a tool call), my-agent 1.0 (a custom child's type), p1 0.3; codex's p2 is excluded
    expect(g.artifacts.value).toBeCloseTo(2.9, 12);
    expect([g.artifacts.n, g.evidence.artifacts]).toEqual([5, 5]);
    expect(g.artifacts.window).toBe("lifetime"); // ConfigEv uses are lifetime counters of lifetime config readers
    expect(g.memoryFiles).toBe(2);
  });

  test("with repo signals off: guardrails, maintained share and rework are null, and the status passes through", () => {
    const { g, stats } = globalsOf(WORLD);
    expect(g.repoSignals).toBe("off");
    for (const m of [g.guardrails, g.maintainedShare, g.reworkShare, g.aiCoauthoredShare, g.commitAfterSession]) {
      expect([m.value, m.n, m.reason]).toEqual([null, 0, "repo-signals-off"]);
    }
    const s = computeSignals(stats, g);
    expect([s.guardrails.value, s.maintainedShare.value, s.landedShare.value, s.reworkShare.value, s.repoSignals]).toEqual([null, null, null, null, "off"]);
  });

  test("the date range clips commits and switches as well as sessions", () => {
    const { g } = globalsOf(WORLD, { repos: REPOS(), exclude: { to: T0 + 4 * HOUR + 30 * MIN }, now: T0 + 15 * DAY });
    // only c1 is left: c2 (a fix, 5 h) and c4 lie after the range's end
    expect([g.reworkShare.value, g.reworkShare.n, g.aiCoauthoredShare.n]).toEqual([0, 1, 1]);
    expect(g.switchesPerWeek.value).toBe(1); // one switch with a detail in range, over Claude Code's one lifetime week in range
  });

  test("switches: a measured 0 carries the denominator's sources and days (M1)", () => {
    const { g } = globalsOf([
      sess("a"), prompt("a", T0),
      prompt(undefined, T0, { source: HIST, window: "lifetime" }), prompt(undefined, T0 + 7 * DAY, { source: HIST, window: "lifetime" }),
      marker("a", T0 + MIN, "model-switch", { source: HIST }), // a picker opened: no detail, no switch
    ]);
    expect(g.switchesPerWeek).toEqual({ window: "lifetime", sources: [HIST], from: T0 - 9 * HOUR, to: T0 + 8 * DAY - 9 * HOUR - 1, n: 2, value: 0 });
  });

  test("switches: one marker still spans the denominator's weeks, not one instant (M1)", () => {
    const { g } = globalsOf([
      sess("a"), prompt("a", T0),
      prompt(undefined, T0, { source: HIST, window: "lifetime" }), prompt(undefined, T0 + 7 * DAY, { source: HIST, window: "lifetime" }),
      marker("a", T0 + MIN, "model-switch", { source: HIST, detail: "opus" }),
    ]);
    const m = g.switchesPerWeek;
    expect([m.value, m.n, m.from, m.to]).toEqual([0.5, 2, Date.UTC(2026, 10, 2), Date.UTC(2026, 10, 10) - 1]);
  });

  test("switch markers count only from lifetime-window sources (M4)", () => {
    const { g } = globalsOf([
      sess("a"), prompt("a", T0), prompt(undefined, T0, { source: HIST, window: "lifetime" }),
      marker("a", T0 + MIN, "model-switch", { source: CC, detail: "opus" }), // a detail-window emitter: not summed against lifetime weeks
      marker("a", T0 + 2 * MIN, "effort-switch", { source: HIST, detail: "high" }),
    ]);
    expect([g.switchesPerWeek.value, g.switchesPerWeek.n]).toEqual([1, 1]);
  });

  test("repo-wide totals read the repos of detail rows only (M5)", () => {
    const repos = signals([...REPOS().repos, repo("L", ["PL"], { commits: [commit(T0 + HOUR, "l1", ["fl"], { ai: "codex" })] })]);
    const { g } = globalsOf([...WORLD, sess("life", { projectKey: "PL", window: "lifetime", start: T0, end: T0 + 2 * HOUR })], { repos, now: T0 + 15 * DAY });
    expect([g.aiCoauthoredShare.value, g.aiCoauthoredShare.n]).toEqual([1 / 3, 3]); // L's commit, of a lifetime-only session, stays out
  });

  test("artifacts: an MCP server evidenced only by a detail call lists that call's transcript source", () => {
    const { g } = globalsOf([sess("a"), prompt("a", T0), tool("a", T0 + MIN, { name: "mcp", category: "mcp", mcpServer: "m1" }),
      config("mcp-server", "m1", { provenance: "installed" })]);
    expect(g.artifacts).toEqual({ window: "lifetime", sources: ["claude-code.config", CC], n: 1, value: 0.3 });
  });

  test("artifacts: a custom agent whose only child is cut with no event in range is not used", () => {
    const evs = (childTs: number): Ev[] => [
      sess("a", { start: T0 - 11 * HOUR, end: T0 + HOUR }), prompt("a", T0), tool("a", T0 + SEC),
      sess("k", { parentId: "a", origin: "subagent", agentType: keyedHash(new Uint8Array(32), "my-agent"), start: T0 - 10 * HOUR, end: T0 + MIN }),
      tool("k", childTs), config("agent", "my-agent"),
    ];
    const cut = globalsOf(evs(T0 - 10 * HOUR + SEC), { exclude: { from: T0 } }).g;
    expect([cut.artifacts.value, cut.evidence.artifacts]).toEqual([0, 0]);
    const kept = globalsOf(evs(T0 + 30 * SEC), { exclude: { from: T0 } }).g;
    expect([kept.artifacts.value, kept.evidence.artifacts]).toEqual([1, 1]);
  });

  test("artifacts: an undated uses counter still counts under a date range, from its config source, with no span", () => {
    const { g } = globalsOf([sess("a"), prompt("a", T0), config("skill", "s1", { uses: 2 })], { exclude: { from: T0 - HOUR, to: T0 + HOUR } });
    expect(g.artifacts).toEqual({ window: "lifetime", sources: ["claude-code.config"], n: 1, value: 1 });
  });

  test("switch sources are the stores of the counted lifetime days: a store the range leaves no row of is not named (R3)", () => {
    const { g } = globalsOf([
      sess("a"), prompt("a", T0), prompt(undefined, T0, { source: HIST, window: "lifetime" }),
      { k: "daily", tool: "claude-code", source: "claude-code.stats", day: "2026-10-01", zone: "local", unit: "prompts", count: 4 },
      marker("a", T0 + MIN, "model-switch", { source: HIST, detail: "opus" }),
    ], { exclude: { from: T0 - DAY } });
    expect([g.switchesPerWeek.sources, g.switchesPerWeek.n]).toEqual([[HIST], 1]);
    // without the range, the stats store made a day too
    expect(globalsOf([
      sess("a"), prompt("a", T0), prompt(undefined, T0, { source: HIST, window: "lifetime" }),
      { k: "daily", tool: "claude-code", source: "claude-code.stats", day: "2026-10-01", zone: "local", unit: "prompts", count: 4 },
    ]).g.switchesPerWeek.sources).toEqual([HIST, "claude-code.stats"]);
  });

  test("artifacts: with a config source read, none in use is a measured 0; with none read, null (not-captured)", () => {
    const read = { ...cov("claude-code", "claude-code.config", "lifetime"), status: "empty" as const };
    const none = globalsOf([sess("a"), prompt("a", T0), read]).g.artifacts;
    expect([none.value, none.n, none.reason, none.sources]).toEqual([0, 0, undefined, ["claude-code.config"]]);
    const unused = globalsOf([sess("a"), prompt("a", T0), config("skill", "s1")]).g.artifacts;
    expect([unused.value, unused.n, unused.reason]).toEqual([0, 0, undefined]);
    const absent = { ...read, status: "absent" as const };
    const notRead = globalsOf([sess("a"), prompt("a", T0), absent]).g.artifacts;
    expect([notRead.value, notRead.reason]).toEqual([null, "not-captured"]);
    const excluded = globalsOf([sess("a"), prompt("a", T0), read, { ...read, tool: "codex", source: "codex.config", status: "ok" }], { exclude: { tools: ["claude-code"] } }).g.artifacts;
    expect([excluded.value, excluded.sources]).toEqual([0, ["codex.config"]]);
  });

  test("an empty scan gives null metrics and finite values", () => {
    const { g, stats } = globalsOf([]);
    const s = computeSignals(stats, g);
    expect([g.parallelShare.value, g.peakConcurrency, g.firstParallelBucket, g.artifacts.value, g.headlessPerWeek.value]).toEqual([null, 0, undefined, null, null]);
    expect(JSON.stringify(s)).not.toMatch(/NaN|Infinity/);
  });
});
