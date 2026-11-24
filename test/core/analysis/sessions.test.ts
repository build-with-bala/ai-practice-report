import { describe, expect, test } from "bun:test";
import { buildSessionTable } from "../../../core/analysis/sessions";
import { PR_LINK_TOOLS, SWITCH_TOOLS } from "../../../core/analysis/types";
import type { CommitFact, RepoFacts, RepoSignals } from "../../../core/git/types";
import type { Ev, PromptEv, SessionEv } from "../../../core/model/events";
import type { ToolId } from "../../../core/model/ids";
import { scanResultOf } from "../../kit/scanresult";

const T0 = Date.UTC(2026, 10, 2, 9, 0);
const MIN = 60_000;
const DAY = 86_400_000;
const NOW = T0 + 30 * DAY;
const opts = { now: NOW, timeZone: "UTC" };

const sess = (id: string, over: Partial<SessionEv> = {}): SessionEv => ({
  k: "session", tool: "claude-code", source: "claude-code.transcripts", id, window: "detail", origin: "human",
  start: T0, end: T0 + 10 * MIN, models: [], ...over,
});
const prompt = (sessionId: string | undefined, ts: number, over: Partial<PromptEv> = {}): PromptEv => ({
  k: "prompt", tool: "claude-code", source: "claude-code.transcripts", ts, sessionId, window: "detail", origin: "human",
  intent: "spec", textHash: `h${ts}`,
  features: { words: 5, lenBucket: 1, hasContext: false, fileRefs: 0, listLines: 0, constraintTerms: 0, isTaskStart: true, techCats: {} },
  ...over,
});
const repo = (repoKey: string, projectKeys: string[], commits: CommitFact[] = []): RepoFacts => ({
  repoKey, projectKeys, identity: true, commits, commitsTruncated: false, fileLists: true,
  instructions: { files: [], namesChecks: [], touched: 0 }, hooks: { entries: 0, checks: [], disabled: false },
  ci: { present: false, checks: [] }, precommit: { present: false, checks: [] },
});
const signals = (repos: RepoFacts[]): RepoSignals => ({ status: "ok", repos, roots: new Map(), skipped: {}, ms: 0 });

describe("buildSessionTable: rows and the tree", () => {
  test("a 3-level tree gives children, depth and topId; only the root is in detailTop", () => {
    const t = buildSessionTable(scanResultOf([
      sess("c", { parentId: "b", origin: "subagent" }),
      sess("a"),
      sess("b", { parentId: "a", origin: "subagent" }),
    ]), opts);
    expect([...t.rows.keys()].sort()).toEqual(["a", "b", "c"]);
    const [a, b, c] = ["a", "b", "c"].map((id) => t.rows.get(id)!);
    expect([a!.children, b!.children, c!.children]).toEqual([["b"], ["c"], []]);
    expect([a!.depth, b!.depth, c!.depth]).toEqual([0, 1, 2]);
    expect([a!.topId, b!.topId, c!.topId]).toEqual(["a", "a", "a"]);
    expect([a!.orphan, b!.orphan, c!.orphan]).toEqual([false, false, false]);
    expect(t.detailTop.map((r) => r.id)).toEqual(["a"]);
    expect(t.orphans.session ?? 0).toBe(0);
  });

  test("an EdgeEv supplies the parent a child row lacks; the row's own parentId wins", () => {
    const t = buildSessionTable(scanResultOf([
      sess("p", { tool: "codex", source: "codex.rollouts" }),
      sess("q", { tool: "codex", source: "codex.rollouts" }),
      sess("x", { tool: "codex", source: "codex.rollouts" }),
      sess("y", { tool: "codex", source: "codex.rollouts", parentId: "q" }),
      { k: "edge", tool: "codex", source: "codex.index", parentId: "p", childId: "x" },
      { k: "edge", tool: "codex", source: "codex.index", parentId: "p", childId: "y" },
    ]), opts);
    expect(t.rows.get("x")!.parentId).toBe("p");
    expect(t.rows.get("y")!.parentId).toBe("q");
    expect(t.rows.get("p")!.children).toEqual(["x"]);
    expect(t.detailTop.map((r) => r.id).sort()).toEqual(["p", "q"]);
  });

  test("a cycle resolves: its first repeated node becomes a root, whatever the arrival order", () => {
    const evs = [sess("a", { parentId: "c" }), sess("b", { parentId: "a" }), sess("c", { parentId: "b" }), sess("d", { parentId: "b" })];
    const one = buildSessionTable(scanResultOf(evs), opts);
    const two = buildSessionTable(scanResultOf([...evs].reverse()), opts);
    for (const t of [one, two]) {
      const roots = [...t.rows.values()].filter((r) => r.parentId === undefined);
      expect(roots.map((r) => r.id)).toEqual(["a"]);
      expect(t.rows.get("a")!.children).toEqual(["b"]);
      expect(["a", "b", "c", "d"].map((id) => t.rows.get(id)!.depth)).toEqual([0, 1, 2, 2]);
      expect(["a", "b", "c", "d"].map((id) => t.rows.get(id)!.topId)).toEqual(["a", "a", "a", "a"]);
      expect(t.detailTop.map((r) => r.id)).toEqual(["a"]);
    }
  });

  test("an orphan child is kept as a row, counted, and kept out of detailTop", () => {
    const t = buildSessionTable(scanResultOf([sess("top"), sess("lost", { parentId: "gone", origin: "subagent" }), sess("under", { parentId: "lost" })]), opts);
    const lost = t.rows.get("lost")!;
    expect(lost.orphan).toBe(true);
    expect(lost.topId).toBe("lost");
    expect(t.rows.get("under")!.topId).toBe("lost");
    expect(t.rows.get("under")!.orphan).toBe(false);
    expect(t.orphans.session).toBe(1);
    expect(t.detailTop.map((r) => r.id)).toEqual(["top"]);
  });

  test("lifetime rows are rows, but never in detailTop", () => {
    const t = buildSessionTable(scanResultOf([sess("d"), sess("l", { window: "lifetime", source: "claude-code.history" })]), opts);
    expect(t.rows.has("l")).toBe(true);
    expect(t.detailTop.map((r) => r.id)).toEqual(["d"]);
  });

  test("a row copies the session's fields and nothing undefined", () => {
    const t = buildSessionTable(scanResultOf([sess("s", { models: ["m1"], effort: "high", background: true, surface: "cli", version: "1.0.0", projectKey: "P" })]), opts);
    const r = t.rows.get("s")!;
    expect(r).toEqual({
      id: "s", tool: "claude-code", source: "claude-code.transcripts", window: "detail", origin: "human", start: T0, end: T0 + 10 * MIN,
      orphan: false, children: [], depth: 0, topId: "s", projectKey: "P", models: ["m1"], effort: "high", background: true,
      surface: "cli", version: "1.0.0",
    });
    expect(Object.values(r).includes(undefined)).toBe(false);
  });
});

describe("buildSessionTable: the repo map", () => {
  test("repoKey comes from RepoFacts.projectKeys", () => {
    const raw = scanResultOf([sess("a", { projectKey: "P1" }), sess("b", { projectKey: "P2" }), sess("c", { projectKey: "P3" })],
      { repos: signals([repo("R1", ["P1", "P2"]), repo("R2", [])]) });
    const t = buildSessionTable(raw, opts);
    expect(t.repoOf).toEqual(new Map([["P1", "R1"], ["P2", "R1"]]));
    expect(["a", "b", "c"].map((id) => t.rows.get(id)!.repoKey)).toEqual(["R1", "R1", undefined]);
  });
});

describe("buildSessionTable: exclusions", () => {
  const evs = (): Ev[] => [
    sess("cc1", { projectKey: "P1" }),
    sess("cc1/sub", { projectKey: "P2", parentId: "cc1", origin: "subagent" }),
    sess("cc2", { projectKey: "P2" }),
    sess("cx1", { tool: "codex", source: "codex.rollouts", projectKey: "P2" }),
    sess("cx2", { tool: "codex", source: "codex.rollouts", projectKey: "P2", start: T0 + 20 * DAY, end: T0 + 20 * DAY + MIN }),
  ];

  test("a tool exclusion drops that tool's rows; tools without rows are not counted", () => {
    const t = buildSessionTable(scanResultOf(evs()), { ...opts, exclude: { tools: ["codex", "cursor"] } });
    expect([...t.rows.keys()].sort()).toEqual(["cc1", "cc1/sub", "cc2"]);
    expect(t.exclusions).toEqual({ tools: 1, projects: 0, sessions: 2, dateRange: false, weeksOutside: 0 });
  });

  test("a project exclusion drops that project's rows with their descendants", () => {
    const t = buildSessionTable(scanResultOf(evs()), { ...opts, exclude: { projects: ["P1", "P9"] } });
    expect([...t.rows.keys()].sort()).toEqual(["cc2", "cx1", "cx2"]);
    expect(t.exclusions).toEqual({ tools: 0, projects: 1, sessions: 2, dateRange: false, weeksOutside: 0 });
  });

  test("scope.projects holds every excluded key given; empty without one", () => {
    const t = buildSessionTable(scanResultOf(evs()), { ...opts, exclude: { projects: ["P1", "P9"] } });
    expect([...t.scope.projects]).toEqual(["P1", "P9"]);
    const u = buildSessionTable(scanResultOf(evs()), { ...opts, exclude: { tools: ["codex"] } });
    expect(u.scope.projects.size).toBe(0);
  });

  test("a date range drops whole sessions outside it", () => {
    const t = buildSessionTable(scanResultOf(evs()), { ...opts, exclude: { from: T0 + 10 * DAY } });
    expect([...t.rows.keys()].sort()).toEqual(["cx2"]);
    expect(t.exclusions.sessions).toBe(4);
    const u = buildSessionTable(scanResultOf(evs()), { ...opts, exclude: { to: T0 + 10 * DAY } });
    expect([...u.rows.keys()].sort()).toEqual(["cc1", "cc1/sub", "cc2", "cx1"]);
    expect(u.exclusions).toEqual({ tools: 0, projects: 0, sessions: 1, dateRange: true, weeksOutside: 0 }); // the session it drops has no prompt
  });

  test("excluded rows are neither in detailTop nor orphans, and their events are not orphan events", () => {
    const t = buildSessionTable(scanResultOf([...evs(), prompt("cc1", T0 + MIN)]), { ...opts, exclude: { projects: ["P1"] } });
    expect(t.detailTop.map((r) => r.id).sort()).toEqual(["cc2", "cx1", "cx2"]);
    expect(t.orphans).toEqual({});
  });
});

describe("buildSessionTable: orphan events", () => {
  test("events naming no session row are counted per kind; a TotalsEv naming no session is in orphans.totals", () => {
    const t = buildSessionTable(scanResultOf([
      sess("s"),
      prompt("s", T0 + MIN),
      prompt("nope", T0 + 2 * MIN),
      prompt(undefined, T0 + 3 * MIN, { window: "lifetime" }),
      { k: "totals", tool: "claude-code", source: "claude-code.transcripts", sessionId: "claude-code:wf:abc", ms: 1000 },
      { k: "totals", tool: "claude-code", source: "claude-code.transcripts", sessionId: "s", ms: 1000 },
      { k: "tool", tool: "claude-code", source: "claude-code.transcripts", ts: T0, sessionId: "nope", name: "Bash", category: "shell" },
    ]), opts);
    expect(t.orphans).toEqual({ prompt: 1, totals: 1, tool: 1 });
  });
});

describe("buildSessionTable: capabilities", () => {
  test("each capability lists the tools whose data has it", () => {
    const tool = (tl: ToolId, over: Record<string, unknown>): Ev => ({ k: "tool", tool: tl, source: "x", ts: T0, sessionId: "s", name: "n", category: "shell", ...over }) as Ev;
    const t = buildSessionTable(scanResultOf([
      sess("s"),
      tool("claude-code", { category: "test", checks: ["test"], ok: true }),
      tool("codex", { category: "test", checks: ["test"] }), // no ok: no outcome
      tool("cursor", { category: "edit", linesAdded: 3 }),
      tool("copilot", { category: "shell", linesAdded: 3 }), // not an edit
      sess("bg", { tool: "codex", source: "codex.rollouts", background: false }),
      { k: "usage", tool: "copilot", source: "x", ts: T0, sessionId: "s", model: "m", inTok: 1, outTok: 1, cacheR: 0, cacheW: 0 },
      { k: "turn", tool: "antigravity", source: "x", ts: T0, sessionId: "s", window: "detail", effort: "high" },
      sess("e", { tool: "cursor", source: "cursor.x", effort: "low" }),
    ]), opts);
    expect(t.capabilities).toEqual({
      outcomes: ["claude-code"], lines: ["cursor"], background: ["codex"], usage: ["copilot"], effort: ["antigravity", "cursor"],
    });
  });

  test("events of project-excluded, date-excluded and host-copy sessions give no capability: not measurable, never n = 0", () => {
    const check = (sessionId: string, tool: ToolId): Ev => ({ k: "tool", tool, source: "x", ts: T0, sessionId, name: "n", category: "test", checks: ["test"], ok: true });
    const edit = (sessionId: string, tool: ToolId): Ev => ({ k: "tool", tool, source: "x", ts: T0, sessionId, name: "n", category: "edit", linesAdded: 2 });
    const usage = (sessionId: string, tool: ToolId): Ev => ({ k: "usage", tool, source: "x", ts: T0, sessionId, model: "m", inTok: 1, outTok: 1, cacheR: 0, cacheW: 0 });
    const turn = (sessionId: string, tool: ToolId): Ev => ({ k: "turn", tool, source: "x", ts: T0, sessionId, window: "detail", effort: "high" });
    const evs: Ev[] = [
      sess("kept"),
      sess("proj", { tool: "codex", source: "codex.rollouts", projectKey: "PX", background: true, effort: "low" }),
      check("proj", "codex"), edit("proj", "codex"), usage("proj", "codex"), turn("proj", "codex"),
      sess("old", { tool: "cursor", source: "cursor.x", start: T0 - 40 * DAY, end: T0 - 40 * DAY + MIN, background: false }),
      check("old", "cursor"), edit("old", "cursor"), usage("old", "cursor"), turn("old", "cursor"),
      check("nope", "antigravity"), // an orphan event: no session
    ];
    // H: a Copilot VS Code host copy of A (4 paired prompts); only H carries outcomes, lines, usage and effort
    evs.push(sess("H", { tool: "copilot", source: "copilot.x", surface: "vscode", effort: "high", background: true }), sess("A", { origin: "scripted" }));
    for (let i = 0; i < 4; i++) {
      evs.push(prompt("H", T0 + i * MIN, { tool: "copilot", source: "copilot.x", textHash: `t${i}` }), prompt("A", T0 + i * MIN + 1_000, { textHash: `t${i}`, origin: "scripted" }));
    }
    evs.push(check("H", "copilot"), edit("H", "copilot"), usage("H", "copilot"), turn("H", "copilot"));
    const t = buildSessionTable(scanResultOf(evs), { ...opts, exclude: { projects: ["PX"], from: T0 - DAY } });
    expect([...t.hosts]).toEqual(["H"]);
    expect(t.capabilities).toEqual({ outcomes: [], lines: [], background: [], usage: [], effort: [] });
  });

  test("the marker tool sets", () => {
    expect([...PR_LINK_TOOLS]).toEqual(["claude-code"]);
    expect([...SWITCH_TOOLS]).toEqual(["claude-code"]);
  });
});

describe("buildSessionTable: detail prompts that name no session", () => {
  test("are counted per tool, in orphans.prompt too, and only inside the date range", () => {
    const evs: Ev[] = [sess("s")];
    for (let i = 0; i < 20; i++) evs.push(prompt(undefined, T0 + i * DAY, { tool: "cursor", source: "cursor.legacy" }));
    evs.push(prompt("missing", T0, { tool: "codex", source: "codex.rollouts" }));
    evs.push(prompt(undefined, T0, { window: "lifetime" })); // a lifetime prompt with no session is no orphan
    const t = buildSessionTable(scanResultOf(evs), opts);
    expect(t.orphanPrompts).toEqual({ codex: 1, cursor: 20 });
    expect(t.orphans.prompt).toBe(21);
    const u = buildSessionTable(scanResultOf(evs), { ...opts, exclude: { from: T0 + 10 * DAY } });
    expect(u.orphanPrompts).toEqual({ cursor: 10 });
    expect(u.orphans.prompt).toBe(10);
    const v = buildSessionTable(scanResultOf(evs), { ...opts, exclude: { tools: ["cursor"] } });
    expect(v.orphanPrompts).toEqual({ codex: 1 });
  });
});
