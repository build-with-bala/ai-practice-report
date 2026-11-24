import { describe, expect, test } from "bun:test";
import { isoWeek } from "../../../core/analysis/activity";
import { exposure, type Exposure } from "../../../core/analysis/exposure";
import { panels } from "../../../core/analysis/panels";
import { buildSessionTable } from "../../../core/analysis/sessions";
import { buildSessionStats } from "../../../core/analysis/walk";
import type { Exclusions } from "../../../core/analysis/types";
import type { ConfigEv, CoverageEv, Ev, MarkerEv, PromptEv, PromptFeatures, SessionEv, ToolEv } from "../../../core/model/events";
import type { MarkerKind, ToolId, Window } from "../../../core/model/ids";
import { loadReference } from "../../../core/scoring/reference";
import { roles } from "../../../core/scoring/roles";
import { scoreDimensions } from "../../../core/scoring/score";
import { computeSignals } from "../../../core/signals/compute";
import { computeGlobals } from "../../../core/signals/globals";
import { scanResultOf } from "../../kit/scanresult";

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Monday 2026-11-16, 12:00 UTC: ISO week 2026-W47. */
const NOW = Date.UTC(2026, 10, 16, 12);
const CC = "claude-code.transcripts";
const HIST = "claude-code.history";
const CX = "codex.rollouts";
const CXH = "codex.history";

const cov = (tool: ToolId, source: string, window: Window): CoverageEv => ({
  k: "coverage", tool, source, window, status: "ok", beta: false, files: 1, bytes: 1, records: 1, skipped: {}, unknownTypes: {}, versions: [],
});
const COVERAGE: Ev[] = [cov("claude-code", CC, "detail"), cov("claude-code", HIST, "lifetime"), cov("codex", CX, "detail"), cov("codex", CXH, "lifetime")];
const SRC: Record<string, string> = { "claude-code:detail": CC, "claude-code:lifetime": HIST, "codex:detail": CX, "codex:lifetime": CXH };
const sess = (id: string, start: number, over: Partial<SessionEv> = {}): SessionEv => {
  const tool = over.tool ?? "claude-code";
  const window = over.window ?? "detail";
  return { k: "session", tool, source: SRC[`${tool}:${window}`]!, id, window, origin: "human", start, end: start + HOUR, models: [], ...over };
};
const features: PromptFeatures = { words: 6, lenBucket: 1, hasContext: false, fileRefs: 0, listLines: 0, constraintTerms: 0, isTaskStart: false, techCats: {} };
let hashes = 0;
const prompt = (sessionId: string | undefined, ts: number, over: Partial<PromptEv> = {}): PromptEv => {
  const tool = over.tool ?? "claude-code";
  const window = over.window ?? "detail";
  const p: PromptEv = { k: "prompt", tool, source: SRC[`${tool}:${window}`]!, ts, window, origin: "human", intent: "spec", textHash: `h${++hashes}`, features, ...over };
  if (sessionId !== undefined) p.sessionId = sessionId;
  return p;
};
const life = (ts: number, tool: ToolId = "claude-code"): PromptEv => prompt(undefined, ts, { tool, window: "lifetime" });
const tool = (sessionId: string, ts: number, over: Partial<ToolEv> = {}): ToolEv =>
  ({ k: "tool", tool: "claude-code", source: CC, ts, sessionId, name: "Read", category: "read", ...over });
const marker = (sessionId: string, ts: number, kind: MarkerKind, over: Partial<MarkerEv> = {}): MarkerEv =>
  ({ k: "marker", tool: "claude-code", source: CC, ts, sessionId, kind, ...over });

function exp(evs: Ev[], o: { exclude?: Exclusions; firstParallelBucket?: number; timeZone?: string; now?: number } = {}): Exposure {
  const raw = scanResultOf([...COVERAGE, ...evs], { finishedAt: o.now ?? NOW });
  const timeZone = o.timeZone ?? "UTC";
  const t = buildSessionTable(raw, { timeZone, ...(o.exclude ? { exclude: o.exclude } : {}) });
  return exposure(t, raw, { now: o.now ?? NOW, timeZone, ...(o.firstParallelBucket === undefined ? {} : { firstParallelBucket: o.firstParallelBucket }) });
}

describe("exposure", () => {
  test("tenure and weeks come from the lifetime days only", () => {
    const e = exp([
      sess("a", NOW - 35 * DAY), prompt("a", NOW - 35 * DAY), // a detail day, in an earlier week, that no lifetime day has
      life(NOW - 14 * DAY), life(NOW - 7 * DAY), life(NOW - 7 * DAY + HOUR),
    ]);
    // the first lifetime day's week (W45) through now's week (W47)
    expect(e.tenureWeeks).toMatchObject({ window: "lifetime", value: 3, n: 2, sources: [HIST] });
    expect(e.activeWeeks.lifetime).toMatchObject({ window: "lifetime", value: 2, n: 2, sources: [HIST] });
    expect(e.activeWeeks.detail).toMatchObject({ window: "detail", value: 1, n: 1, sources: [CC] });
    const week = (ms: number) => e.weekly.find((w) => w.week === isoWeek(new Date(ms).toISOString().slice(0, 10)))!;
    expect(week(NOW - 35 * DAY).activeDays).toBe(0);
    expect(week(NOW - 14 * DAY).activeDays).toBe(1);
    // claude-code has more human lifetime prompts than detail ones: weekly reads its lifetime window only
    expect(week(NOW - 35 * DAY)).toMatchObject({ detailPrompts: 0, lifetimePrompts: 0 });
    expect(week(NOW - 7 * DAY)).toMatchObject({ activeDays: 1, detailPrompts: 0, lifetimePrompts: 2 });
  });

  test("weekly has 52 entries, the last one now's week, in order", () => {
    const e = exp([life(NOW - DAY)]);
    expect(e.weekly.length).toBe(52);
    expect(e.weekly[51]!.week).toBe("2026-W47");
    expect(e.weekly[0]!.week).toBe("2025-W48");
    for (let i = 1; i < 52; i++) expect(e.weekly[i]!.week > e.weekly[i - 1]!.week).toBe(true);
  });

  test("weekly keeps the windows apart: a detail-window tool fills detailPrompts", () => {
    const e = exp([sess("a", NOW - 2 * DAY), prompt("a", NOW - 2 * DAY), prompt("a", NOW - 2 * DAY + MIN), life(NOW - DAY, "codex")]);
    // Saturday and Sunday of W46: the union of Claude Code's detail day and Codex's lifetime day
    const w = e.weekly.find((x) => x.week === "2026-W46")!;
    expect(w).toEqual({ week: "2026-W46", activeDays: 2, detailPrompts: 2, lifetimePrompts: 1 });
    expect(e.weekly[51]).toEqual({ week: "2026-W47", activeDays: 0, detailPrompts: 0, lifetimePrompts: 0 });
  });

  test("weekly: a detail-only tool's busy week shows its days", () => {
    const evs: Ev[] = [];
    for (let d = 1; d <= 5; d++) evs.push(sess(`s${d}`, NOW - 7 * DAY + (d - 1) * DAY), prompt(`s${d}`, NOW - 7 * DAY + (d - 1) * DAY));
    const e = exp(evs);
    expect(e.weekly.find((x) => x.week === "2026-W46")).toEqual({ week: "2026-W46", activeDays: 5, detailPrompts: 5, lifetimePrompts: 0 });
  });

  test("weekly: the union of days, each tool's chosen window only", () => {
    const e = exp([
      // Claude Code: 2 lifetime prompts (Mon, Tue of W46) beat 1 detail prompt (Wed): only its lifetime days count
      life(NOW - 7 * DAY), life(NOW - 6 * DAY), sess("a", NOW - 5 * DAY), prompt("a", NOW - 5 * DAY),
      // Codex, detail only: Tue (shared with Claude Code's lifetime day) and Thu
      sess("c", NOW - 6 * DAY, { tool: "codex" }), prompt("c", NOW - 6 * DAY, { tool: "codex" }),
      sess("d", NOW - 4 * DAY, { tool: "codex" }), prompt("d", NOW - 4 * DAY, { tool: "codex" }),
    ]);
    expect(e.weekly.find((x) => x.week === "2026-W46")).toEqual({ week: "2026-W46", activeDays: 3, detailPrompts: 2, lifetimePrompts: 2 });
  });

  test("tenure falls back to the detail days without a lifetime layer; its span ends where it counts to", () => {
    const d = exp([sess("a", NOW - 14 * DAY), prompt("a", NOW - 14 * DAY), sess("b", NOW - 7 * DAY), prompt("b", NOW - 7 * DAY)]);
    expect(d.tenureWeeks).toEqual({ window: "detail", sources: [CC], n: 2, value: 3, from: Date.UTC(2026, 10, 2), to: NOW });
    const l = exp([life(NOW - 14 * DAY), sess("a", NOW - 35 * DAY), prompt("a", NOW - 35 * DAY)]);
    expect(l.tenureWeeks).toEqual({ window: "lifetime", sources: [HIST], n: 1, value: 3, from: Date.UTC(2026, 10, 2), to: NOW });
    // a date range ending before now: the value and the span end at the range's end
    const r = exp([life(NOW - 14 * DAY)], { exclude: { to: NOW - 6 * DAY } }); // W45 through W46
    expect(r.tenureWeeks).toMatchObject({ value: 2, to: NOW - 6 * DAY });
  });

  test("a home with nothing: null metrics, 52 empty weeks, no tools", () => {
    const e = exp([]);
    expect(e.tenureWeeks).toEqual({ window: "lifetime", sources: [], n: 0, value: null, reason: "no-data" });
    expect(e.activeWeeks.detail.value).toBeNull();
    expect(e.weekly.every((w) => w.activeDays === 0 && w.detailPrompts === 0 && w.lifetimePrompts === 0)).toBe(true);
    expect([e.tools, e.rotation, e.arcs.medianPrompts, e.firstSeen]).toEqual([[], { active90d: [], ever: [] }, null, {}]);
  });

  test("a tool active 100 days ago is in rotation.ever but not active90d", () => {
    const e = exp([life(NOW - 100 * DAY, "codex"), sess("a", NOW - 3 * DAY), prompt("a", NOW - 3 * DAY)]);
    expect(e.rotation).toEqual({ active90d: ["claude-code"], ever: ["claude-code", "codex"] });
  });

  test("rotation.active90d covers exactly 90 day keys, now's day the last", () => {
    expect(exp([life(NOW - 89 * DAY, "codex")]).rotation).toEqual({ active90d: ["codex"], ever: ["codex"] });
    expect(exp([life(NOW - 90 * DAY, "codex")]).rotation).toEqual({ active90d: [], ever: ["codex"] });
  });

  test("tools: sessions, prompts and actions per tool and window", () => {
    const e = exp([
      sess("a", NOW - 3 * DAY), prompt("a", NOW - 3 * DAY), tool("a", NOW - 3 * DAY + MIN), tool("a", NOW - 3 * DAY + 2 * MIN, { category: "meta", name: "Think" }),
      sess("k", NOW - 3 * DAY + 5 * MIN, { parentId: "a", origin: "subagent", end: NOW - 3 * DAY + 6 * MIN }), tool("k", NOW - 3 * DAY + 5 * MIN + SEC),
      life(NOW - 3 * DAY), life(NOW - 4 * DAY),
    ]);
    expect(e.tools).toEqual([
      { tool: "claude-code", window: "detail", sessions: 1, prompts: 1, actions: 2, from: NOW - 3 * DAY, to: NOW - 3 * DAY + HOUR },
      { tool: "claude-code", window: "lifetime", sessions: 0, prompts: 2, actions: 0, from: NOW - 4 * DAY, to: NOW - 3 * DAY },
    ]);
  });

  test("arcs: prompts per session and session durations, by bucket", () => {
    const evs: Ev[] = [];
    const sizes = [1, 2, 3, 5, 12, 31];
    const durations = [5 * MIN, 10 * MIN, HOUR, 4 * HOUR, 4 * HOUR + 1, 30 * MIN];
    sizes.forEach((n, i) => {
      const start = NOW - (i + 2) * DAY;
      evs.push(sess(`s${i}`, start, { end: start + durations[i]! }));
      for (let p = 0; p < n; p++) evs.push(prompt(`s${i}`, start + p));
    });
    evs.push(sess("bot", NOW - DAY, { origin: "scripted" }), prompt("bot", NOW - DAY, { origin: "scripted" })); // no human prompt: no arc
    const e = exp(evs);
    expect(e.arcs.prompts).toEqual({ "1": 1, "2-3": 2, "4-10": 1, "11-30": 1, "31+": 1 });
    expect(e.arcs.medianPrompts).toBe(4); // (3 + 5) / 2
    expect(e.arcs.durations).toEqual({ "<10m": 1, "10-60m": 2, "1-4h": 2, ">4h": 1 });
  });

  test("firstSeen: the first evidence of each feature, in scope", () => {
    const B = NOW - 10 * DAY; // the date range starts here
    const evs: Ev[] = [
      sess("a", B - HOUR, { end: B + 10 * HOUR }), prompt("a", B + MIN),
      tool("a", B - 30 * MIN, { category: "mcp", name: "mcp", mcpServer: "m" }), // before the range: no evidence
      tool("a", B + 2 * HOUR, { category: "mcp", name: "mcp", mcpServer: "m" }),
      tool("a", B + 3 * HOUR, { category: "skill", name: "Skill" }),
      marker("a", B + 10 * MIN, "plan-artifact", { proxyTs: true }), marker("a", B + 4 * HOUR, "plan-enter"),
      tool("a", B + 3 * HOUR + MIN, { category: "plan", name: "Plan" }),
      marker("a", B + 5 * HOUR, "model-switch", { detail: "opus" }), marker("a", B + 6 * HOUR, "compact-manual"),
      marker("a", B + 6 * HOUR - MIN, "compact-auto"),
      sess("k", B + 7 * HOUR, { parentId: "a", origin: "subagent" }), prompt("k", B + 7 * HOUR, { origin: "subagent" }),
      sess("w", B + 8 * HOUR, { parentId: "a", origin: "subagent", workflowId: "wf" }), prompt("w", B + 8 * HOUR, { origin: "subagent" }),
      sess("bg", B + 9 * HOUR, { parentId: "a", origin: "subagent", background: true }), prompt("bg", B + 9 * HOUR, { origin: "subagent" }),
      sess("h", B + 2 * DAY, { origin: "scripted" }), prompt("h", B + 2 * DAY, { origin: "scripted" }),
      { k: "config", tool: "claude-code", source: "claude-code.config", kind: "skill", name: "s", provenance: "authored", firstSeen: B + 2 * HOUR + MIN } satisfies ConfigEv,
      { k: "config", tool: "claude-code", source: "claude-code.config", kind: "skill", name: "old", provenance: "authored", firstSeen: B - DAY } satisfies ConfigEv,
    ];
    const e = exp(evs, { exclude: { from: B }, firstParallelBucket: B + 20 * HOUR });
    expect(e.firstSeen).toEqual({
      mcp: B + 2 * HOUR, skills: B + 2 * HOUR + MIN, "plan-mode": B + 3 * HOUR + MIN, "model-switching": B + 5 * HOUR, "manual-compaction": B + 6 * HOUR,
      subagents: B + 7 * HOUR, workflows: B + 8 * HOUR, "background-agents": B + 9 * HOUR, headless: B + 2 * DAY, "parallel-sessions": B + 20 * HOUR,
    });
  });

  test("firstSeen: a row that started before the range gives its first in-range event, or nothing", () => {
    const B = NOW - 10 * DAY;
    const evs = (withEvent: boolean): Ev[] => [
      sess("a", B - 2 * HOUR, { end: B + 2 * HOUR }), prompt("a", B + MIN),
      sess("k", B - HOUR, { parentId: "a", origin: "subagent", end: B + HOUR }), tool("k", B - 30 * MIN),
      ...(withEvent ? [tool("k", B + 20 * MIN)] : []),
    ];
    expect(exp(evs(true), { exclude: { from: B } }).firstSeen).toEqual({ subagents: B + 20 * MIN });
    expect(exp(evs(false), { exclude: { from: B } }).firstSeen).toEqual({});
  });

  test("firstSeen: an excluded tool's evidence does not count", () => {
    const evs: Ev[] = [sess("c", NOW - DAY, { tool: "codex", origin: "scripted" }), prompt("c", NOW - DAY, { tool: "codex", origin: "scripted" })];
    expect(exp(evs).firstSeen).toEqual({ headless: NOW - DAY });
    expect(exp(evs, { exclude: { tools: ["codex"] } }).firstSeen).toEqual({});
  });

  test("every number is finite: exposure, panels and roles, on an empty scan and a small one", () => {
    const walk = (v: unknown): void => {
      if (typeof v === "number") expect(Number.isFinite(v)).toBe(true);
      else if (v !== null && typeof v === "object") for (const x of Object.values(v)) walk(x);
    };
    for (const evs of [[], [sess("a", NOW - DAY), prompt("a", NOW - DAY), life(NOW - DAY)]] as Ev[][]) {
      const raw = scanResultOf([...COVERAGE, ...evs], { finishedAt: NOW });
      const t = buildSessionTable(raw, { timeZone: "UTC" });
      const stats = buildSessionStats(t, raw.store, raw.repos, { timeZone: "UTC" });
      const g = computeGlobals(t, stats, raw, { now: NOW });
      const dims = scoreDimensions(computeSignals(stats, g), loadReference());
      const p = panels(t, raw, { timeZone: "UTC" });
      const r = roles(dims, p.stack);
      walk(exposure(t, raw, { now: NOW, timeZone: "UTC", ...(g.firstParallelBucket === undefined ? {} : { firstParallelBucket: g.firstParallelBucket }) }));
      walk(p);
      walk(r);
      expect(r).toEqual([]);
    }
  });
});
