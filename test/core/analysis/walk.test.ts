import { describe, expect, test } from "bun:test";
import { buildSessionTable } from "../../../core/analysis/sessions";
import type { Exclusions } from "../../../core/analysis/types";
import { childType, effortRank, modelTier } from "../../../core/analysis/tiers";
import { briefScore, buildSessionStats, isAction, type SessionStats } from "../../../core/analysis/walk";
import type { CommitFact, RepoFacts, RepoSignals } from "../../../core/git/types";
import type { CoverageEv, Ev, MarkerEv, PromptEv, PromptFeatures, SessionEv, ToolEv, TurnEv, UsageEv } from "../../../core/model/events";
import type { MarkerKind, ToolId, Window } from "../../../core/model/ids";
import { scanResultOf } from "../../kit/scanresult";

const T0 = Date.UTC(2026, 10, 2, 9, 0);
const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const CC = "claude-code.transcripts";

const cov = (tool: ToolId, source: string, window: Window): CoverageEv => ({
  k: "coverage", tool, source, window, status: "ok", beta: false, files: 1, bytes: 1, records: 1, skipped: {}, unknownTypes: {}, versions: [],
});
/** Detail coverage for the transcript-like sources the tests use, lifetime coverage for the history. */
const COVERAGE: Ev[] = [
  cov("claude-code", CC, "detail"), cov("claude-code", "claude-code.history", "lifetime"), cov("codex", "codex.rollouts", "detail"),
  cov("copilot", "copilot.vscode", "detail"), cov("cursor", "cursor.x", "detail"),
];
const SRC: Partial<Record<ToolId, string>> = { "claude-code": CC, codex: "codex.rollouts", copilot: "copilot.vscode", cursor: "cursor.x" };

const sess = (id: string, over: Partial<SessionEv> = {}): SessionEv => {
  const tool = over.tool ?? "claude-code";
  return { k: "session", tool, source: SRC[tool]!, id, window: "detail", origin: "human", start: T0, end: T0 + 2 * HOUR, models: [], ...over };
};
const features = (over: Partial<PromptFeatures> = {}): PromptFeatures => ({
  words: 6, lenBucket: 1, hasContext: false, fileRefs: 0, listLines: 0, constraintTerms: 0, isTaskStart: false, techCats: {}, ...over,
});
let hashes = 0;
const prompt = (sessionId: string, ts: number, over: Partial<PromptEv> & { f?: Partial<PromptFeatures> } = {}): PromptEv => {
  const { f, ...rest } = over;
  const tool = rest.tool ?? "claude-code";
  return { k: "prompt", tool, source: SRC[tool]!, ts, sessionId, window: "detail", origin: "human", intent: "spec", textHash: `h${++hashes}`, features: features(f), ...rest };
};
const tool = (sessionId: string, ts: number, over: Partial<ToolEv> = {}): ToolEv => {
  const t = over.tool ?? "claude-code";
  return { k: "tool", tool: t, source: SRC[t]!, ts, sessionId, name: "Read", category: "read", ...over };
};
const edit = (sessionId: string, ts: number, ext: string, added: number, removed = 0, over: Partial<ToolEv> = {}): ToolEv =>
  tool(sessionId, ts, { name: "Edit", category: "edit", editExt: ext, linesAdded: added, linesRemoved: removed, ...over });
const check = (sessionId: string, ts: number, ok: boolean, over: Partial<ToolEv> = {}): ToolEv =>
  tool(sessionId, ts, { name: "Bash", category: "test", checks: ["test"], ok, toolchain: "js", ...over });
const marker = (sessionId: string, ts: number, kind: MarkerKind, over: Partial<MarkerEv> = {}): MarkerEv => ({
  k: "marker", tool: "claude-code", source: CC, ts, sessionId, kind, ...over,
});
const turnEv = (sessionId: string, ts: number, over: Partial<TurnEv> = {}): TurnEv => ({
  k: "turn", tool: "claude-code", source: CC, ts, sessionId, window: "detail", ...over,
});
const usage = (sessionId: string, ts: number, inTok: number, outTok: number, cacheW = 0, cacheR = 0): UsageEv => ({
  k: "usage", tool: "claude-code", source: CC, ts, sessionId, model: "claude-sonnet-4-5", inTok, outTok, cacheR, cacheW,
});
/** A passing check the row's tool reports, so its tool has `outcomes` (VAE is gated on it). */
const outcomesFor = (sessionId: string, ts: number, t: ToolId = "claude-code"): ToolEv => check(sessionId, ts, true, { tool: t });

function walk(evs: Ev[], o: { repos?: RepoSignals; timeZone?: string; exclude?: Exclusions } = {}): Map<string, SessionStats> {
  const raw = scanResultOf([...COVERAGE, ...evs], o.repos ? { repos: o.repos } : {});
  const t = buildSessionTable(raw, { now: raw.finishedAt, timeZone: o.timeZone ?? "UTC", ...(o.exclude ? { exclude: o.exclude } : {}) });
  const out = buildSessionStats(t, raw.store, raw.repos, { timeZone: o.timeZone ?? "UTC" });
  return new Map(out.map((s) => [s.id, s]));
}
const one = (evs: Ev[], id = "s", o: { repos?: RepoSignals; timeZone?: string; exclude?: Exclusions } = {}): SessionStats => walk(evs, o).get(id)!;
const reads = (sessionId: string, from: number, n: number, step = SEC): ToolEv[] => Array.from({ length: n }, (_, i) => tool(sessionId, from + i * step));

describe("tiers", () => {
  test("modelTier", () => {
    const cases: [string, 1 | 2 | 3 | undefined][] = [
      ["claude-haiku-4-5", 1], ["gpt-5.1-codex-mini", 1], ["gpt-4.1-nano", 1], ["gemini-2.5-flash-lite", 1], ["mistral-small", 1], ["o4-mini", 1],
      ["claude-sonnet-4-5", 2], ["gemini-2.5-flash", 2], ["gpt-5", 2], ["gpt-5.1", 2], ["gpt-5-codex", 2], ["standard", 2],
      ["claude-opus-4-1", 3], ["gpt-5.1-codex-max", 3], ["gemini-2.5-pro", 3], ["gpt-5-pro", 3], ["kimi-ultra", 3], ["mistral-large", 3],
      ["fable", undefined], ["", undefined], ["o3", undefined],
    ];
    for (const [m, want] of cases) expect([m, modelTier(m)]).toEqual([m, want]);
  });

  test("effortRank", () => {
    const cases: [string, 1 | 2 | 3 | 4 | undefined][] = [
      ["none", 1], ["minimal", 1], ["low", 1], ["medium", 2], ["high", 3], ["xhigh", 4], ["max", 4], ["ultra", 4], ["HIGH", 3], ["auto", undefined], ["", undefined],
    ];
    for (const [e, want] of cases) expect([e, effortRank(e)]).toEqual([e, want]);
  });

  test("childType", () => {
    const cases: [string | undefined, string][] = [
      ["Explore", "explore"], ["explorer", "explore"], ["Plan", "plan"], ["planner", "other"], ["code-reviewer", "review"], ["Review", "review"],
      ["general-purpose", "implement"], ["claude", "implement"], ["fork", "implement"], ["default", "implement"], ["workflow-subagent", "implement"],
      ["0123456789abcdef", "custom"], ["0123456789ABCDEF", "other"], ["worker", "other"], [undefined, "other"],
    ];
    for (const [a, want] of cases) expect([a, childType(a)]).toEqual([a, want]);
  });
});

describe("isAction and briefScore", () => {
  test("an action is a tool call that is not meta and was neither denied nor cancelled", () => {
    expect(isAction(tool("s", T0))).toBe(true);
    expect(isAction(tool("s", T0, { category: "meta" }))).toBe(false);
    expect(isAction(tool("s", T0, { outcome: "denied" }))).toBe(false);
    expect(isAction(tool("s", T0, { outcome: "cancelled" }))).toBe(false);
    expect(isAction(tool("s", T0, { outcome: "interrupted" }))).toBe(true);
  });

  test("the brief score is the mean of its five marks", () => {
    expect(briefScore(features())).toBe(0);
    expect(briefScore(features({ hasContext: true, fileRefs: 2, listLines: 3, constraintTerms: 0, lenBucket: 1 }))).toBeCloseTo(0.6, 12);
    expect(briefScore(features({ hasContext: true, fileRefs: 1, listLines: 2, constraintTerms: 1, lenBucket: 2 }))).toBe(1);
    expect(briefScore(features({ listLines: 1, lenBucket: 4 }))).toBeCloseTo(0.2, 12);
  });
});

describe("walk: attribution (rules 1–5)", () => {
  test("an Agent call delegating to a 6-action child adds 6 to that turn's A_t, though the child starts in a later turn", () => {
    const s = one([
      sess("s"),
      sess("c", { parentId: "s", origin: "subagent", start: T0 + 6 * MIN, end: T0 + 7 * MIN }),
      prompt("s", T0),
      tool("s", T0 + SEC, { name: "Agent", category: "delegate", delegateTo: "c" }),
      prompt("s", T0 + 5 * MIN),
      ...reads("c", T0 + 6 * MIN, 6),
    ]);
    expect(s.turns).toBe(2);
    expect(s.successRuns).toEqual({ 7: 1, 0: 1 });
    expect(s.stickySum).toBeCloseTo(3, 12);
    expect(s.actions).toBe(7);
    expect(s.children).toBe(1);
  });

  test("without a delegating call a child goes to the turn holding its start, else to the first turn; grandchildren roll up", () => {
    const s = one([
      sess("s"),
      sess("c1", { parentId: "s", origin: "subagent", start: T0 + 6 * MIN }),
      sess("g1", { parentId: "c1", origin: "subagent", start: T0 + 7 * MIN }),
      sess("c2", { parentId: "s", origin: "subagent", start: T0 - HOUR }),
      prompt("s", T0),
      prompt("s", T0 + 5 * MIN),
      ...reads("c1", T0 + 6 * MIN, 2), ...reads("g1", T0 + 7 * MIN, 3), ...reads("c2", T0 - HOUR, 4),
    ]);
    expect(s.successRuns).toEqual({ 4: 1, 5: 1 });
    expect(s.children).toBe(2); // fan-out: the direct children c1 and c2
    expect(s.maxDepth).toBe(2);
  });

  test("Copilot-style equal timestamps put a request's tools into its own turn, in emission order", () => {
    const at = { tool: "copilot" as const };
    const s = one([
      sess("s", at),
      prompt("s", T0, at),
      tool("s", T0, { ...at, ok: false }), tool("s", T0, { ...at, ok: false }), tool("s", T0, { ...at, ok: true }),
      prompt("s", T0 + MIN, at),
      tool("s", T0 + MIN, { ...at, ok: true }), tool("s", T0 + MIN, { ...at, ok: false }), tool("s", T0 + MIN, { ...at, ok: false }),
    ]);
    expect(s.turns).toBe(2);
    expect(s.successRuns).toEqual({ 3: 1 }); // the first request ends on a success; the second on two failures (s_t = 0)
    expect(s.stickySum).toBeCloseTo(2, 12);
  });

  test("a command prompt with no action is no turn: its span joins the previous turn's", () => {
    const s = one([
      sess("s"),
      prompt("s", T0), tool("s", T0 + SEC),
      prompt("s", T0 + MIN, { intent: "command" }), tool("s", T0 + MIN + SEC, { category: "meta" }),
      prompt("s", T0 + 2 * MIN, { intent: "command" }), tool("s", T0 + 2 * MIN + SEC),
    ]);
    expect(s.turns).toBe(2);
    expect(s.successRuns).toEqual({ 1: 2 });
  });

  test("only the detail window's human prompts are typed turns; host copies are never walked", () => {
    const evs: Ev[] = [
      sess("s"),
      prompt("s", T0), prompt("s", T0 + MIN, { window: "lifetime" }), prompt("s", T0 + 2 * MIN, { origin: "scripted" }),
      sess("H", { tool: "copilot", surface: "vscode" }), sess("A", { origin: "scripted" }),
    ];
    for (let i = 0; i < 4; i++) evs.push(prompt("H", T0 + i * MIN, { tool: "copilot", textHash: `t${i}` }), prompt("A", T0 + i * MIN + SEC, { textHash: `t${i}`, origin: "scripted" }));
    const all = walk(evs);
    expect(all.get("s")!.turns).toBe(1);
    expect(all.has("H")).toBe(false);
    expect(all.get("A")!.turns).toBe(4); // its scripted prompts were typed in the host: relabelled human
  });
});

describe("walk: s_t (rule 6)", () => {
  const base = (...extra: Ev[]): Ev[] => [sess("s"), prompt("s", T0), tool("s", T0 + 10 * SEC), tool("s", T0 + MIN), ...extra];

  test("a person's interrupt inside the span makes s_t 0; a proxy-timed or tool-limited one does not", () => {
    expect(one(base(marker("s", T0 + 20 * SEC, "interrupt", { detail: "user" }))).stickySum).toBe(0);
    expect(one(base(marker("s", T0 + 20 * SEC, "interrupt"))).stickySum).toBe(0);
    expect(one(base(marker("s", T0 + 20 * SEC, "interrupt", { detail: "replaced" }))).stickySum).toBe(0);
    expect(one(base(marker("s", T0 + 20 * SEC, "interrupt", { detail: "user", proxyTs: true }))).stickySum).toBeCloseTo(Math.log2(3), 12);
    expect(one(base(marker("s", T0 + 20 * SEC, "interrupt", { detail: "budget-limited" }))).stickySum).toBeCloseTo(Math.log2(3), 12);
  });

  test("a correction 9 minutes after the span's last event makes s_t 0; 11 minutes after does not", () => {
    const at9 = one(base(prompt("s", T0 + 10 * MIN, { intent: "correction" })));
    expect(at9.successRuns).toEqual({ 0: 1 });
    const at11 = one(base(prompt("s", T0 + 12 * MIN, { intent: "correction" })));
    expect(at11.successRuns).toEqual({ 2: 1, 0: 1 });
  });

  test("a span whose last two actions fail has s_t 0", () => {
    const s = one([sess("s"), prompt("s", T0), check("s", T0 + SEC, true), check("s", T0 + 2 * SEC, false), check("s", T0 + 3 * SEC, false)]);
    expect(s.successRuns).toEqual({});
    expect(s.stickySum).toBe(0);
    const ok = one([sess("s"), prompt("s", T0), check("s", T0 + SEC, false), check("s", T0 + 2 * SEC, false), check("s", T0 + 3 * SEC, true)]);
    expect(ok.successRuns).toEqual({ 3: 1 });
  });

  test("successRuns cap A_t at 1,000", () => {
    expect(one([sess("s"), prompt("s", T0), ...reads("s", T0 + 1, 1_200, 1)]).successRuns).toEqual({ 1000: 1 });
  });
});

describe("walk: episodes (rule 7) and markers (rules 1, 14)", () => {
  test("a clear, even from the lifetime history, starts a fresh episode", () => {
    const s = one([sess("s"), prompt("s", T0), marker("s", T0 + 5 * MIN, "clear", { source: "claude-code.history" }), prompt("s", T0 + 6 * MIN)]);
    expect([s.episodes, s.freshEpisodes, s.followUps]).toEqual([2, 2, 0]);
  });

  test("a 31-minute gap starts a new episode that is not fresh; 29 minutes does not", () => {
    const gap = one([sess("s"), prompt("s", T0), tool("s", T0 + MIN), prompt("s", T0 + 32 * MIN)]);
    expect([gap.episodes, gap.freshEpisodes, gap.followUps]).toEqual([2, 1, 0]);
    const near = one([sess("s"), prompt("s", T0), tool("s", T0 + MIN), prompt("s", T0 + 30 * MIN)]);
    expect([near.episodes, near.freshEpisodes, near.followUps]).toEqual([1, 1, 1]);
  });

  test("a /compact that both the history and the transcript report counts once; markers of sources without detail coverage are left out", () => {
    const s = one([
      sess("s"), prompt("s", T0),
      marker("s", T0 + MIN, "compact-manual", { source: "claude-code.history" }), marker("s", T0 + MIN, "compact-manual"),
      marker("s", T0 + 2 * MIN, "compact-auto"), marker("s", T0 + 3 * MIN, "compact-auto", { source: "claude-code.nowhere" }),
      marker("s", T0 + 4 * MIN, "queue"), marker("s", T0 + 5 * MIN, "queue", { source: "claude-code.history" }),
    ]);
    expect([s.compactManual, s.compactAuto, s.queued]).toEqual([1, 1, 1]);
  });

  test("days are the local days with a typed turn", () => {
    const evs: Ev[] = [sess("s", { start: Date.UTC(2026, 10, 16, 10, 50), end: Date.UTC(2026, 10, 16, 11, 20) }),
      prompt("s", Date.UTC(2026, 10, 16, 10, 50)), prompt("s", Date.UTC(2026, 10, 16, 11, 10))];
    expect(one(evs).days).toEqual(["2026-11-16"]);
    expect(one(evs, "s", { timeZone: "Pacific/Auckland" }).days).toEqual(["2026-11-16", "2026-11-17"]);
  });
});

describe("walk: VAE (rule 8)", () => {
  const w6 = Math.log2(2 + 6);

  test("an edit followed by bun test is verified", () => {
    const s = one([sess("s"), prompt("s", T0), edit("s", T0 + SEC, "ts", 4, 2), check("s", T0 + 2 * SEC, true, { toolchain: "js" })]);
    expect([s.gatedVae, s.editTurns]).toEqual([true, 1]);
    expect(s.editWeight).toBeCloseTo(w6, 12);
    expect(s.verifiedWeight).toBeCloseTo(w6, 12);
  });

  test("a check before the last edit does not verify it", () => {
    const s = one([sess("s"), prompt("s", T0), edit("s", T0 + SEC, "ts", 3), check("s", T0 + 2 * SEC, true), edit("s", T0 + 3 * SEC, "ts", 3)]);
    expect(s.editTurns).toBe(1);
    expect(s.editWeight).toBeCloseTo(w6, 12);
    expect(s.verifiedWeight).toBe(0);
  });

  test("a .py edit followed by npm test is not verified; by a check of no toolchain it is", () => {
    const js = one([sess("s"), prompt("s", T0), edit("s", T0 + SEC, "py", 6), check("s", T0 + 2 * SEC, true, { toolchain: "js" })]);
    expect(js.verifiedWeight).toBe(0);
    const any = one([sess("s"), prompt("s", T0), edit("s", T0 + SEC, "py", 6), check("s", T0 + 2 * SEC, false, { toolchain: undefined })]);
    expect(any.verifiedWeight).toBeCloseTo(w6, 12);
  });

  test("a denied or outcome-less check verifies nothing", () => {
    const denied = one([sess("s"), outcomesFor("s", T0 - SEC), prompt("s", T0), edit("s", T0 + SEC, "ts", 6), check("s", T0 + 2 * SEC, true, { ok: undefined, outcome: "denied" })]);
    expect(denied.verifiedWeight).toBe(0);
    const noOk = one([sess("s"), outcomesFor("s", T0 - SEC), prompt("s", T0), edit("s", T0 + SEC, "ts", 6), check("s", T0 + 2 * SEC, true, { ok: undefined })]);
    expect(noOk.verifiedWeight).toBe(0);
  });

  test("a check in a child attributed to the turn verifies the row's edit", () => {
    const s = one([
      sess("s"), sess("c", { parentId: "s", origin: "subagent", start: T0 + 2 * SEC }),
      prompt("s", T0), edit("s", T0 + SEC, "ts", 6), tool("s", T0 + 2 * SEC, { name: "Agent", category: "delegate", delegateTo: "c" }),
      check("c", T0 + 3 * SEC, true),
    ]);
    expect(s.verifiedWeight).toBeCloseTo(w6, 12);
  });

  test(".md-only edits make no edit turn", () => {
    const s = one([sess("s"), prompt("s", T0), edit("s", T0 + SEC, "md", 40), edit("s", T0 + 2 * SEC, "json", 4), edit("s", T0 + 3 * SEC, undefined as never, 4), check("s", T0 + 4 * SEC, true)]);
    expect([s.editTurns, s.editWeight, s.editEpisodes]).toEqual([0, 0, 0]);
  });

  test("a tool without outcomes is not gated: no edit turns are counted", () => {
    const at = { tool: "cursor" as const };
    const s = one([sess("s", at), prompt("s", T0, at), edit("s", T0 + SEC, "ts", 6, 0, at), tool("s", T0 + 2 * SEC, { ...at, category: "test", checks: ["test"] })]);
    expect([s.gatedVae, s.editTurns, s.editWeight, s.verifiedWeight]).toEqual([false, 0, 0, 0]);
    expect(s.editEpisodes).toBe(1); // delivery needs no outcomes
  });

  test("weights follow the line counts, unknown counts adding nothing", () => {
    const s = one([
      sess("s"),
      prompt("s", T0), edit("s", T0 + SEC, "ts", 4, 2), check("s", T0 + 2 * SEC, true),
      prompt("s", T0 + MIN), tool("s", T0 + MIN + SEC, { name: "Write", category: "write", editExt: "go" }),
      prompt("s", T0 + 2 * MIN), edit("s", T0 + 2 * MIN + SEC, "rs", 10, 4), edit("s", T0 + 2 * MIN + 2 * SEC, "md", 100),
    ]);
    expect(s.editTurns).toBe(3);
    expect(s.editWeight).toBeCloseTo(Math.log2(8) + Math.log2(2) + Math.log2(16), 12);
    expect(s.verifiedWeight).toBeCloseTo(Math.log2(8), 12);
  });
});

describe("walk: closure (rule 9)", () => {
  test("fail, fail, pass closes 2 of 2 in one chain of 2", () => {
    const s = one([sess("s"), prompt("s", T0), check("s", T0 + SEC, false), edit("s", T0 + 2 * SEC, "ts", 1), check("s", T0 + 3 * SEC, false), prompt("s", T0 + MIN), check("s", T0 + MIN + SEC, true)]);
    expect([s.failingChecks, s.closedChecks]).toEqual([2, 2]);
    expect(s.fixCycles).toEqual({ 2: 1 });
  });

  test("a pass of another kind or toolchain, or in a later episode, closes nothing", () => {
    const kind = one([sess("s"), prompt("s", T0), check("s", T0 + SEC, false), check("s", T0 + 2 * SEC, true, { category: "lint", checks: ["lint"] })]);
    expect([kind.failingChecks, kind.closedChecks]).toEqual([1, 0]);
    const chain = one([sess("s"), prompt("s", T0), check("s", T0 + SEC, false, { toolchain: "py" }), check("s", T0 + 2 * SEC, true, { toolchain: "js" })]);
    expect(chain.closedChecks).toBe(0);
    const later = one([sess("s"), prompt("s", T0), check("s", T0 + SEC, false), prompt("s", T0 + HOUR), check("s", T0 + HOUR + SEC, true)]);
    expect([later.failingChecks, later.closedChecks]).toEqual([1, 0]);
    expect(later.fixCycles).toEqual({});
  });

  test("a denied npm test is never a failing check", () => {
    const s = one([sess("s"), outcomesFor("s", T0 - HOUR), prompt("s", T0), check("s", T0 + SEC, true, { ok: undefined, outcome: "denied" })]);
    expect(s.failingChecks).toBe(0);
  });
});

describe("walk: interrupts and briefs (rules 10–11)", () => {
  test("one healthy interrupt and one late one", () => {
    const s = one([
      sess("s"),
      prompt("s", T0), ...reads("s", T0 + SEC, 2), marker("s", T0 + 30 * SEC, "interrupt", { detail: "user" }),
      prompt("s", T0 + 2 * MIN, { intent: "redirect", f: { words: 6, simToPrev: 0.2 } }), ...reads("s", T0 + 2 * MIN + SEC, 10, MIN),
      marker("s", T0 + 13 * MIN, "interrupt", { detail: "user" }),
      prompt("s", T0 + 14 * MIN, { intent: "question", f: { words: 5 } }),
    ]);
    expect([s.interrupts, s.healthyInterrupts]).toEqual([2, 1]);
  });

  test("an interrupt is not healthy when the next turn is short, similar, late, an ack, or interrupted again soon", () => {
    const run = (next: Partial<PromptEv> & { f?: Partial<PromptFeatures> }, at = T0 + 2 * MIN, ...extra: Ev[]) => one([
      sess("s"), prompt("s", T0), tool("s", T0 + SEC), marker("s", T0 + 10 * SEC, "interrupt"), prompt("s", at, next), ...extra,
    ]);
    expect(run({ intent: "spec" }).healthyInterrupts).toBe(1);
    expect(run({ intent: "spec", f: { words: 3 } }).healthyInterrupts).toBe(0);
    expect(run({ intent: "spec", f: { simToPrev: 0.6 } }).healthyInterrupts).toBe(0);
    expect(run({ intent: "spec" }, T0 + 11 * MIN).healthyInterrupts).toBe(0);
    expect(run({ intent: "ack" }).healthyInterrupts).toBe(0);
    expect(run({ intent: "spec" }, T0 + 2 * MIN, marker("s", T0 + 5 * MIN, "interrupt", { detail: "replaced" })).healthyInterrupts).toBe(0);
  });

  test("a brief's score, and its correction", () => {
    const s = one([
      sess("s"),
      prompt("s", T0, { intent: "spec", f: { hasContext: true, fileRefs: 2, listLines: 3, constraintTerms: 0, lenBucket: 1 } }), tool("s", T0 + SEC),
      prompt("s", T0 + MIN, { intent: "correction" }), tool("s", T0 + MIN + SEC),
      prompt("s", T0 + 2 * HOUR - MIN, { intent: "ack" }),
    ]);
    expect([s.briefs, s.correctedBriefs, s.episodes, s.followUps]).toEqual([1, 1, 2, 1]);
    expect(s.briefScoreSum).toBeCloseTo(0.6, 12);
  });

  test("work per turn: typed turns over log2(2 + actions), for episodes with actions", () => {
    const s = one([sess("s"), prompt("s", T0), ...reads("s", T0 + SEC, 6), prompt("s", T0 + MIN), prompt("s", T0 + 2 * HOUR - MIN)]);
    expect(s.workEpisodes).toBe(1);
    expect(s.turnsPerWorkSum).toBeCloseTo(2 / 3, 12);
  });
});

describe("walk: children (rule 13)", () => {
  test("fan-out counts direct children only; background, types, workflow runs and depth take every descendant", () => {
    const sub = (id: string, over: Partial<SessionEv> = {}) => sess(id, { parentId: "s", origin: "subagent", start: T0 + MIN, ...over });
    const s = one([
      sess("s"), prompt("s", T0),
      sub("ok", { agentType: "Explore", background: true, workflowId: "w1" }), tool("ok", T0 + MIN),
      sub("stopped", { agentType: "general-purpose", background: false, workflowId: "w1" }), marker("stopped", T0 + HOUR, "interrupt", { detail: "stopped-by-user", proxyTs: true }),
      sub("failed", { agentType: "0123456789abcdef", workflowId: "w2" }), check("failed", T0 + MIN, false), check("failed", T0 + MIN + SEC, false),
      sess("deep", { parentId: "ok", origin: "subagent", start: T0 + 2 * MIN }),
    ]);
    expect([s.children, s.finishedChildren, s.bgKnown, s.bgChildren, s.workflowRuns, s.maxDepth]).toEqual([3, 1, 2, 1, 2, 2]);
    expect(s.childTypes).toEqual({ explore: 1, implement: 1, custom: 1, other: 1 });
  });
});

describe("walk: tiers and tokens (rules 15–16)", () => {
  test("tier pairs take the episode's highest TurnEv tier and effort", () => {
    const s = one([
      sess("s", { models: ["claude-sonnet-4-5"] }),
      prompt("s", T0), ...reads("s", T0 + SEC, 3),
      turnEv("s", T0 + MIN, { model: "claude-opus-4-1", effort: "high" }), turnEv("s", T0 + 2 * MIN, { model: "claude-haiku-4-5", effort: "low" }),
      turnEv("s", T0 + 3 * MIN, { model: "claude-opus-4-1", effort: "max", window: "lifetime" }),
    ]);
    expect(s.tierPairs).toEqual([33, 2]);
  });

  test("without TurnEv model or effort, the row's single model and its effort; nothing when either is unknown", () => {
    const at = { tool: "codex" as const };
    const s = one([sess("s", { ...at, models: ["gpt-5-codex"], effort: "medium" }), prompt("s", T0, at), tool("s", T0 + SEC, at), turnEv("s", T0 + MIN, { ...at, source: "codex.rollouts" })]);
    expect(s.tierPairs).toEqual([22, 1]);
    const two = one([sess("s", { ...at, models: ["gpt-5-codex", "gpt-5.1-codex-max"], effort: "medium" }), prompt("s", T0, at)]);
    expect(two.tierPairs).toEqual([]);
    const none = one([sess("s", { ...at, models: ["gpt-5-codex"] }), prompt("s", T0, at)]);
    expect(none.tierPairs).toEqual([]);
  });

  test("tokens roll up from children; cost comes from the row's totals", () => {
    const s = one([
      sess("s"), sess("c", { parentId: "s", origin: "subagent" }), prompt("s", T0),
      usage("s", T0 + SEC, 100, 50, 10, 5_000), usage("c", T0 + 2 * SEC, 10, 5),
      { k: "totals", tool: "claude-code", source: CC, sessionId: "s", usd: 1.5 },
    ]);
    expect([s.tokens, s.tokensKnown, s.usd, s.usdKnown]).toEqual([175, true, 1.5, true]);
    const none = one([sess("s"), prompt("s", T0)]);
    expect([none.tokens, none.tokensKnown, none.usd, none.usdKnown]).toEqual([0, false, 0, false]);
  });
});

const commit = (ts: number, shaKey: string, owner = true): CommitFact => ({ ts, shaKey, files: [], owner });
const repo = (repoKey: string, projectKeys: string[], commits: CommitFact[], identity = true): RepoFacts => ({
  repoKey, projectKeys, identity, commits, commitsTruncated: false, fileLists: true,
  instructions: { files: [], namesChecks: [], touched: 0 }, hooks: { entries: 0, checks: [], disabled: false },
  ci: { present: false, checks: [] }, precommit: { present: false, checks: [] },
});
const signals = (repos: RepoFacts[]): RepoSignals => ({ status: "ok", repos, roots: new Map(), skipped: {}, ms: 0 });

describe("walk: delivery (rules 17–18)", () => {

  test("landed edit episodes and landed units against repo signals", () => {
    const repos = signals([
      repo("R", ["PK"], [commit(T0 + 3 * HOUR, "k1"), commit(T0 + 3 * HOUR + MIN, "k2", false), commit(T0 + 30 * HOUR, "k3")]),
      repo("N", ["PN"], [], false),
    ]);
    const all = walk([
      sess("s", { projectKey: "PK", end: T0 + 2 * HOUR }),
      prompt("s", T0), edit("s", T0 + SEC, "ts", 2), check("s", T0 + 2 * SEC, true),
      prompt("s", T0 + HOUR), tool("s", T0 + HOUR + SEC), // a second episode, no edit
      marker("s", T0 + HOUR + 2 * SEC, "pr-link", { detail: "pr1" }), marker("s", T0 + HOUR + 3 * SEC, "pr-link", { detail: "pr1" }),
      sess("n", { projectKey: "PN" }), prompt("n", T0), edit("n", T0 + SEC, "ts", 2),
    ], { repos });
    const s = all.get("s")!;
    expect([s.repoKey, s.editEpisodes, s.editEpisodesInRepo, s.landedEpisodes]).toEqual(["R", 1, 1, 1]);
    expect(s.prKeys).toEqual(["pr1"]);
    expect(s.landed).toBe(2); // own commit k1 (k2 is another repo's, k3 is past the window) + one PR
    const n = all.get("n")!;
    expect([n.editEpisodes, n.editEpisodesInRepo, n.landedEpisodes, n.landed]).toEqual([1, 0, 0, 0]);
  });

  test("a git commit whose shaKey a commit marker also names counts once", () => {
    const repos = signals([repo("R", ["PK"], [commit(T0 + MIN, "k1")])]);
    const s = one([
      sess("s", { projectKey: "PK" }), prompt("s", T0), edit("s", T0 + SEC, "ts", 2), marker("s", T0 + MIN, "commit", { detail: "k1" }),
    ], "s", { repos });
    expect(s.commitShaKeys).toEqual(["k1"]);
    expect([s.landedEpisodes, s.landed]).toEqual([1, 1]);
  });

  test("a git commit another row's commit marker names is that row's unit only", () => {
    const repos = signals([repo("R", ["PK"], [commit(T0 + 3 * HOUR, "k1")])]);
    const all = walk([
      sess("a", { projectKey: "PK", start: T0, end: T0 + HOUR }), prompt("a", T0), marker("a", T0 + MIN, "commit", { detail: "k1" }),
      sess("b", { projectKey: "PK", start: T0 + 2 * HOUR, end: T0 + 2 * HOUR + MIN }), prompt("b", T0 + 2 * HOUR),
    ], { repos });
    expect([all.get("a")!.landed, all.get("b")!.landed]).toEqual([1, 0]);
  });

  test("a commit goes to the latest-starting row that covers it; a commit marker is a landed unit without git", () => {
    const repos = signals([repo("R", ["PK"], [commit(T0 + 3 * HOUR, "k9")])]);
    const all = walk([
      sess("a", { projectKey: "PK", start: T0, end: T0 + HOUR }), prompt("a", T0), edit("a", T0 + SEC, "ts", 2),
      sess("b", { projectKey: "PK", start: T0 + 2 * HOUR, end: T0 + 2 * HOUR + MIN }), prompt("b", T0 + 2 * HOUR),
      sess("c", { projectKey: "PK", start: T0 + 4 * HOUR, end: T0 + 5 * HOUR }), prompt("c", T0 + 4 * HOUR),
      sess("m", { projectKey: "PM" }), prompt("m", T0), edit("m", T0 + SEC, "ts", 2), marker("m", T0 + 2 * SEC, "commit", { detail: "kx" }),
    ], { repos });
    expect([all.get("a")!.landed, all.get("b")!.landed, all.get("c")!.landed]).toEqual([0, 1, 0]);
    expect(all.get("a")!.landedEpisodes).toBe(1);
    const m = all.get("m")!;
    expect([m.editEpisodesInRepo, m.landedEpisodes, m.landed]).toEqual([0, 0, 1]);
  });
});

describe("walk: scripted rows (rule 20) and buckets (rule 19)", () => {
  test("a scripted row has no turns but carries buckets, tokens and children", () => {
    const s = one([
      sess("s", { origin: "scripted" }), prompt("s", T0, { origin: "scripted" }), tool("s", T0 + SEC), tool("s", T0 + 11 * MIN),
      usage("s", T0 + SEC, 5, 5), sess("c", { parentId: "s", origin: "subagent" }), tool("c", T0 + 25 * MIN),
    ]);
    expect([s.turns, s.scripted, s.episodes, s.children, s.tokens]).toEqual([0, true, 0, 1, 10]);
    const b = (ms: number) => Math.floor(ms / (10 * MIN));
    expect(s.buckets).toEqual([b(T0 + SEC), b(T0 + 11 * MIN), b(T0 + 25 * MIN)]);
  });

  test("buckets count actions only, of the row and its descendants, once each", () => {
    const s = one([sess("s"), prompt("s", T0), tool("s", T0 + SEC), tool("s", T0 + 2 * SEC), tool("s", T0 + 15 * MIN, { category: "meta" })]);
    expect(s.buckets).toEqual([Math.floor((T0 + SEC) / (10 * MIN))]);
  });
});

describe("walk: date range, cross-row keys, fan-out, children's ends and markers (Task 5 review rulings)", () => {
  test("a session straddling the range's start counts only its in-range turns, actions, markers, days and commits", () => {
    const from = T0;
    const repos = signals([repo("R", ["PK"], [commit(T0 - 9 * HOUR, "early"), commit(T0 + 5 * MIN, "late")])]);
    const s = one([
      sess("s", { projectKey: "PK", start: T0 - 11 * HOUR, end: T0 + HOUR }),
      prompt("s", T0 - 10 * HOUR), edit("s", T0 - 10 * HOUR + SEC, "ts", 4), ...reads("s", T0 - 10 * HOUR + 2 * SEC, 3),
      marker("s", T0 - 10 * HOUR + 5 * SEC, "compact-manual"), marker("s", T0 - 10 * HOUR + 6 * SEC, "pr-link", { detail: "old-pr" }),
      sess("c", { parentId: "s", origin: "subagent", start: T0 - 10 * HOUR, end: T0 + MIN }),
      ...reads("c", T0 - 10 * HOUR + 10 * SEC, 4), tool("c", T0 + 30 * SEC),
      usage("s", T0 - 10 * HOUR + SEC, 100, 100), usage("s", T0 + SEC, 5, 5),
      prompt("s", T0), tool("s", T0 + SEC), edit("s", T0 + 2 * SEC, "ts", 2),
    ], "s", { repos, exclude: { from } });
    expect([s.turns, s.episodes, s.actions, s.compactManual, s.tokens]).toEqual([1, 1, 3, 0, 10]);
    expect(s.days).toEqual(["2026-11-02"]);
    expect(s.prKeys).toEqual([]);
    expect(s.buckets).toEqual([Math.floor((T0 + SEC) / (10 * MIN))]);
    expect([s.start, s.end]).toEqual([T0, T0 + HOUR]);
    expect([s.editEpisodesInRepo, s.landedEpisodes, s.landed]).toEqual([1, 1, 1]); // "late" only: "early" lies before the range
  });

  test("a PR (and a commit) two rows link belongs to the earlier row only", () => {
    const all = walk([
      sess("a", { start: T0, end: T0 + HOUR }), prompt("a", T0),
      marker("a", T0 + MIN, "pr-link", { detail: "pr1" }), marker("a", T0 + MIN, "commit", { detail: "k1" }),
      sess("b", { start: T0 + 2 * HOUR, end: T0 + 3 * HOUR }), prompt("b", T0 + 2 * HOUR),
      marker("b", T0 + 2 * HOUR + MIN, "pr-link", { detail: "pr1" }), marker("b", T0 + 2 * HOUR + MIN, "commit", { detail: "k1" }),
      marker("b", T0 + 2 * HOUR + MIN, "pr-link", { detail: "pr2" }),
    ]);
    const a = all.get("a")!;
    const b = all.get("b")!;
    expect([a.prKeys, a.commitShaKeys, a.landed]).toEqual([["pr1"], ["k1"], 2]);
    expect([b.prKeys, b.commitShaKeys, b.landed]).toEqual([["pr2"], [], 1]);
  });

  test("nested delegation: fan-out counts the direct children, depth and A_t take the grandchild", () => {
    const s = one([
      sess("s"), prompt("s", T0),
      tool("s", T0 + SEC, { name: "Agent", category: "delegate", delegateTo: "c1" }),
      sess("c1", { parentId: "s", origin: "subagent", start: T0 + 2 * SEC }), tool("c1", T0 + 3 * SEC, { name: "Agent", category: "delegate", delegateTo: "g" }),
      sess("g", { parentId: "c1", origin: "subagent", start: T0 + 4 * SEC }), ...reads("g", T0 + 5 * SEC, 3),
      sess("c2", { parentId: "s", origin: "subagent", start: T0 + 2 * SEC }), ...reads("c2", T0 + 6 * SEC, 1),
    ]);
    expect([s.children, s.finishedChildren, s.maxDepth, s.actions]).toEqual([2, 2, 2, 6]);
    expect(s.successRuns).toEqual({ 6: 1 });
  });

  test("rule 6: the correction window runs from the later of the span's last event and its children's last event", () => {
    const evs = (childEnd: number): Ev[] => [
      sess("s"), prompt("s", T0), tool("s", T0 + 10 * SEC),
      tool("s", T0 + 20 * SEC, { name: "Agent", category: "delegate", delegateTo: "c" }),
      sess("c", { parentId: "s", origin: "subagent", start: T0 + 30 * SEC, background: true }), tool("c", T0 + MIN), tool("c", childEnd),
      prompt("s", T0 + 25 * MIN, { intent: "correction" }),
    ];
    expect(one(evs(T0 + 20 * MIN)).successRuns).toEqual({ 0: 1 }); // the correction comes 5 min after the background child's end
    expect(one(evs(T0 + 2 * MIN)).successRuns).toEqual({ 4: 1, 0: 1 }); // 23 min after both
  });

  test("delivery reads the commit and PR markers of the children attributed to the row", () => {
    const repos = signals([repo("R", ["PK"], [])]);
    const s = one([
      sess("s", { projectKey: "PK" }), prompt("s", T0), edit("s", T0 + SEC, "ts", 2),
      sess("c", { parentId: "s", origin: "subagent", start: T0 + 2 * SEC }), tool("c", T0 + 3 * SEC),
      marker("c", T0 + 5 * MIN, "commit", { detail: "kc" }), marker("c", T0 + 6 * MIN, "pr-link", { detail: "prc" }),
    ], "s", { repos });
    expect([s.commitShaKeys, s.prKeys]).toEqual([["kc"], ["prc"]]);
    expect([s.editEpisodesInRepo, s.landedEpisodes, s.landed]).toEqual([1, 1, 2]);
  });
});

describe("walk: budget", () => {
  test("a row with 200,000 tool events finishes in under 2 s, and its stats are plain data", () => {
    const evs: Ev[] = [sess("s", { end: T0 + 10 * HOUR })];
    for (let i = 0; i < 200; i++) evs.push(prompt("s", T0 + i * 3 * MIN));
    for (let i = 0; i < 200_000; i++) {
      const ts = T0 + Math.floor(i * 0.9 * SEC);
      evs.push(i % 50 === 0 ? check("s", ts, i % 100 === 0) : i % 7 === 0 ? edit("s", ts, "ts", 3, 1) : tool("s", ts));
    }
    const raw = scanResultOf([...COVERAGE, ...evs]);
    const t = buildSessionTable(raw, { now: raw.finishedAt, timeZone: "UTC" });
    raw.store.forSession("s", "tool"); // the store's index is built by the first lookup: not the walk's cost
    const t0 = performance.now();
    const stats = buildSessionStats(t, raw.store, raw.repos, { timeZone: "UTC" });
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(stats).toHaveLength(1);
    expect(stats[0]!.turns).toBe(200);
    expect(JSON.parse(JSON.stringify(stats))).toEqual(stats);
    const plain = (v: unknown): boolean => v === null || ["number", "string", "boolean"].includes(typeof v)
      || (Array.isArray(v) && v.every(plain)) || (typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype && Object.values(v as object).every(plain));
    expect(plain(stats)).toBe(true);
    expect(JSON.stringify(stats)).not.toMatch(/NaN|Infinity|null/);
  });
});
