import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, statSync, utimesSync } from "node:fs";
import path from "node:path";
import { vscodeUser } from "../../../core/env/paths";
import { __observeQueries } from "../../../core/io/sqlite";
import { localDay } from "../../../core/io/time";
import type { Ev, MarkerEv, ToolEv } from "../../../core/model/events";
import { scan } from "../../../core/scan";
import { agBrain, agCli, agHistory, agIde } from "../../../core/sources/antigravity";
import { TRAJ_FIELDS } from "../../../core/sources/antigravity/ide";
import { registry } from "../../../core/sources/registry";
import type { SourcePlugin } from "../../../core/sources/types";
import { keyedHash, normalizePath } from "../../../core/text/hash";
import { classifyIntent } from "../../../core/text/intent";
import { CANARY, expectNoCanaries, findCanaries } from "../../kit/canary";
import { fakeHome, type FakeHome } from "../../kit/home";
import { pbEncode } from "../../kit/pb";
import { fixtureStart, MIN } from "../../fixtures/claude-code";
import {
  agId, AUTH_ITEMS, buildAntigravity, C, CLI_BRAIN_REL, CLI_REL, GO_ZERO_TIME, historyLine, historyRel, I1, I2, IDE_BRAIN_REL, ideRel, K, modelReply,
  P, pbTs, record, runPayload, STATUS, STEP, stepMetadata, stepsRel, SUMMARIES_DDL, summariesRel, topic, TRAJ_KEY, trajectory, transcriptRel,
  userInput, writeBrain, writeIdeStore, writeSteps, writeSummaries, type StepOpts,
} from "../../fixtures/antigravity";

let h: FakeHome;
beforeEach(() => { h = fakeHome(); });
afterEach(() => {
  __observeQueries(undefined);
  h.cleanup();
});

const ALL = [agCli, agIde, agBrain];
const run = (plugins: SourcePlugin[] = ALL) => scan({ env: h.env, plugins });
type Result = Awaited<ReturnType<typeof run>>;
const KINDS = ["session", "prompt", "tool", "turn", "marker", "usage", "totals", "daily", "edge", "file"] as const;
const allEvents = (r: Result) => KINDS.flatMap((k) => [...r.store.all(k)] as Ev[]);
const covOf = (r: Result, source: string, window: "detail" | "lifetime" = source === "antigravity.cli" ? "detail" : "lifetime") =>
  r.coverage.find((c) => c.source === source && c.window === window)!;
/** The conversation index (`conversation_summaries.db`): antigravity.cli's lifetime window. */
const summariesCov = (r: Result) => covOf(r, "antigravity.cli", "lifetime");
const sidOf = (raw: string) => `antigravity:${raw}`;
const byTime = <T extends { ts: number }>(xs: readonly T[]): T[] => [...xs].sort((a, b) => a.ts - b.ts);
const markers = (r: Result, kind: MarkerEv["kind"]) => r.store.all("marker").filter((m) => m.kind === kind);
const observe = () => {
  const sql: string[] = [];
  __observeQueries((s) => sql.push(s));
  return sql;
};
const skipChmod = process.platform === "win32" || process.getuid?.() === 0;

/**
 * What each SELECT may name, by the table it reads (written out here, independently of the reader): the allowlisted columns,
 * `rowid`, its aliases and the presence tests' aliases; schema lookups name only schema columns.
 */
const MAY_NAME: Record<string, readonly string[]> = {
  conversation_summaries: [
    "conversation_id", "step_count", "last_modified_time", "last_user_input_time", "workspace_uris", "parent_conversation_id", "nesting_depth",
    "killed", "battle_id", "winning_conversation_id", "source", "rowid", "rid", "battle", "battle_loser", "src",
  ],
  steps: ["step_type", "status", "metadata", "error_details", "step_payload", "rowid", "rid", "err", "payload", "mhead", "pbig"],
  ItemTable: ["key", "value"],
  sqlite_master: ["name", "type", "sql"],
  pragma_table_info: ["name"],
};
const SQL_WORDS = new Set(["select", "from", "where", "order", "by", "limit", "as", "and", "or", "coalesce", "case", "when", "then", "else", "end", "is",
  "not", "null", "length", "substr", "in"]);
/** Result columns that may carry trace bytes into memory (parsed there, never kept): the step metadata, its head, a run command's payload. */
const STEP_IN_MEMORY = new Set(["metadata", "mhead", "payload"]);
/** The table or table-valued function a statement reads. */
const sourceOf = (sql: string): string | undefined => /\bFROM\s+(?:"([^"]+)"|([A-Za-z_]\w*))/i.exec(sql)?.slice(1).find((x) => x !== undefined);
/** Identifiers in a statement that its table's list does not allow (string literals, numbers and parameters are not identifiers). */
function unlisted(sql: string): string[] {
  const body = sql.replace(/'(?:[^']|'')*'/g, " ");
  const table = sourceOf(body);
  const allowed = new Set([table, ...(MAY_NAME[table ?? ""] ?? [])]);
  return [...body.matchAll(/"((?:[^"]|"")+)"|\b([A-Za-z_]\w*)\b/g)].map((m) => (m[1] ?? m[2])!).filter((w) => !SQL_WORDS.has(w.toLowerCase()) && !allowed.has(w));
}
/** Runs a captured rowid-page query against a store over every row, as the reader's first page would. */
function rowsOf(file: string, sql: string): Record<string, unknown>[] {
  const db = new Database(file, { readonly: true });
  try {
    return db.query(sql).all(Number.MIN_SAFE_INTEGER, 1_000_000) as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

describe("antigravity: Task 15 scenario", () => {
  test("5 sessions (3 CLI, 2 IDE), a subagent with parent and depth, a kill, 5 tools by category, an error, 2 prompts, 2 usage, 2 plan artifacts; no canaries", async () => {
    const fx = buildAntigravity(h);
    const sql = observe();
    const r = await run();
    __observeQueries(undefined);

    expect(r.store.all("session").map((s) => s.id).sort()).toEqual([P, C, K, I1, I2].map(sidOf).sort());
    expect(r.store.session(sidOf(C))).toMatchObject({ origin: "subagent", parentId: sidOf(P), spawnDepth: 1 });
    expect(markers(r, "interrupt").map((m) => m.sessionId)).toEqual([sidOf(K)]);
    expect(byTime(r.store.all("tool")).map((t) => t.category)).toEqual(["edit", "shell", "read", "search", "browser"]);
    expect(markers(r, "error").map((m) => [m.sessionId, m.ts - fx.t0])).toEqual([[sidOf(P), 5 * MIN]]);
    const prompts = r.store.all("prompt");
    expect(prompts.map((p) => [p.origin, p.window, p.sessionId])).toEqual([["human", "detail", sidOf(P)], ["human", "detail", sidOf(P)]]);
    expect(r.store.all("usage")).toHaveLength(2);
    expect(markers(r, "plan-artifact").map((m) => [m.sessionId, m.detail]).sort()).toEqual([[sidOf(I1), "implementation_plan"], [sidOf(I1), "task"]]);

    // ItemTable: one query only, the parameterized lookup of the trajectory key — the account rows beside it are never selected
    expect([...new Set(sql.filter((s) => /ItemTable/.test(s)))]).toEqual(["SELECT value FROM ItemTable WHERE key = ?"]);
    for (const s of sql) {
      expect(s).not.toContain("*");
      expect([s, unlisted(s)]).toEqual([s, []]);
    }
    expectNoCanaries([...allEvents(r), r.coverage, r.warnings]);
    expect(r.warnings).toEqual([]);
    expect(r.tempClean).toBe(true);
  });

  test("CLI sessions: lifetime rows, the detail span of the steps and transcript merged in; the first workspace as the project", async () => {
    const fx = buildAntigravity(h);
    const r = await run([agCli]);
    expect(r.store.session(sidOf(P))).toMatchObject({
      tool: "antigravity", source: "antigravity.cli", window: "detail", origin: "human", surface: "cli", start: fx.t0 + MIN, end: fx.t0 + 20 * MIN, models: [],
    });
    const key = r.store.session(sidOf(P))!.projectKey!;
    expect(key).toBe(keyedHash(r.salt, `${CANARY.path}/app`));
    expect(normalizePath(r.cwds.get(key)!)).toBe(`${CANARY.path}/app`);
    expect(r.store.session(sidOf(C))).toMatchObject({ window: "lifetime", origin: "subagent", surface: "cli", start: fx.t0 + 6 * MIN, end: fx.t0 + 8 * MIN });
    expect(r.store.session(sidOf(K))).toMatchObject({ window: "lifetime", origin: "human", start: fx.t0 + 30 * MIN, end: fx.t0 + 31 * MIN });
    expect(r.store.session(sidOf(P))!.parentId).toBeUndefined();
    expect(r.store.session(sidOf(P))!.spawnDepth).toBeUndefined();
    expect(markers(r, "interrupt").map((m) => [m.ts - fx.t0, m.detail, m.proxyTs])).toEqual([[31 * MIN, "killed", true]]); // stamped by the row's last change
  });

  test("prompts and usage from the transcript: text in memory only (intent, features, keyed hash), token counts", async () => {
    const fx = buildAntigravity(h);
    const r = await run([agCli]);
    const prompts = byTime(r.store.all("prompt"));
    expect(prompts.map((p) => p.ts - fx.t0)).toEqual([MIN, 10 * MIN]);
    expect(prompts.map((p) => p.intent)).toEqual(fx.texts.map(classifyIntent));
    expect(prompts.map((p) => p.textHash)).toEqual(fx.texts.map((t) => keyedHash(r.salt, t.trim())));
    expect(prompts.map((p) => p.features.isTaskStart)).toEqual([true, false]);
    expect(prompts.map((p) => p.features.simToPrev === undefined)).toEqual([true, false]);
    expect(prompts.every((p) => p.source === "antigravity.cli" && p.hasPaste === undefined)).toBe(true);
    expect(byTime(r.store.all("usage"))).toEqual([
      { k: "usage", tool: "antigravity", source: "antigravity.cli", ts: fx.t0 + MIN + 30_000, sessionId: sidOf(P), model: "other", inTok: 1200, outTok: 300, cacheR: 9000, cacheW: 0 },
      { k: "usage", tool: "antigravity", source: "antigravity.cli", ts: fx.t0 + 11 * MIN, sessionId: sidOf(P), model: "other", inTok: 800, outTok: 120, cacheR: 0, cacheW: 0 },
    ]);
  });

  test("tools from the steps: step names, status as the outcome; the error marker for the step with error details", async () => {
    const fx = buildAntigravity(h);
    const r = await run([agCli]);
    expect(byTime(r.store.all("tool")).map((t) => [t.ts - fx.t0, t.sessionId, t.name, t.category, t.ok, t.checks, t.exit])).toEqual([
      [2 * MIN, sidOf(P), "code_action", "edit", true, undefined, undefined],
      [3 * MIN, sidOf(P), "run_command", "shell", true, undefined, undefined],
      [4 * MIN, sidOf(P), "view_file", "read", true, undefined, undefined],
      [5 * MIN, sidOf(P), "grep_search", "search", false, undefined, undefined],
      [6 * MIN, sidOf(P), "open_browser_url", "browser", true, undefined, undefined],
    ]);
  });

  test("IDE sessions and brain markers; coverage of every source", async () => {
    const fx = buildAntigravity(h);
    const r = await run();
    expect(r.store.session(sidOf(I1))).toMatchObject({
      source: "antigravity.ide", window: "lifetime", origin: "human", surface: "ide", start: fx.t0 + 40 * MIN, end: fx.t0 + 50 * MIN, models: [],
      projectKey: keyedHash(r.salt, `${CANARY.path}/web`),
    });
    expect(r.store.session(sidOf(I2))).toMatchObject({ surface: "ide", start: fx.t0 + 60 * MIN, end: fx.t0 + 61 * MIN });
    expect(r.store.session(sidOf(I2))!.projectKey).toBeUndefined();
    const brain = path.join(h.env.home, IDE_BRAIN_REL, I1);
    const mtimes = ["task.md", "implementation_plan.md"].map((n) => Math.floor(statSync(path.join(brain, n)).mtimeMs));
    expect(markers(r, "plan-artifact").map((m) => Math.floor(m.ts)).sort()).toEqual(mtimes.sort());

    const transcript = path.join(h.env.home, transcriptRel(P));
    // the step store and transcript: the detail window; the conversation index: the lifetime window
    expect(covOf(r, "antigravity.cli")).toMatchObject({
      tool: "antigravity", window: "detail", status: "ok", beta: false, files: 2, records: 5 + 5, from: fx.t0 + MIN, to: fx.t0 + 11 * MIN,
      bytes: statSync(fx.stepsFile).size + statSync(transcript).size, skipped: {}, unknownTypes: {}, versions: [],
    });
    expect(summariesCov(r)).toMatchObject({
      tool: "antigravity", window: "lifetime", status: "ok", files: 1, records: 3, from: fx.t0 + 6 * MIN, to: fx.t0 + 31 * MIN,
      bytes: statSync(fx.summariesFile).size, skipped: {}, unknownTypes: {}, versions: [],
    });
    expect(covOf(r, "antigravity.ide")).toMatchObject({
      window: "lifetime", status: "ok", files: 1, bytes: statSync(fx.ideFile).size, records: 2, from: fx.t0 + 40 * MIN, to: fx.t0 + 61 * MIN, skipped: {}, unknownTypes: {},
    });
    expect(covOf(r, "antigravity.brain")).toMatchObject({ window: "lifetime", status: "ok", files: 0, bytes: 0, records: 2, skipped: {}, unknownTypes: {} });
  });
});

describe("antigravity cli: conversation_summaries.db", () => {
  const t0 = () => fixtureStart();

  test("a battle id makes the surface battle and never leaves SQLite; text columns are never selected", async () => {
    const at = t0();
    const B = agId("B");
    const file = writeSummaries(h, [{ id: B, battle: `${CANARY.secret}-battle`, input: at, modified: at + MIN }, { id: P, input: at, modified: at }]);
    const sql = observe();
    const r = await run([agCli]);
    __observeQueries(undefined);
    expect([r.store.session(sidOf(B))!.surface, r.store.session(sidOf(P))!.surface]).toEqual(["battle", "cli"]);
    const page = sql.find((s) => sourceOf(s) === "conversation_summaries")!;
    expect(page).toMatch(/ WHERE rowid > \? ORDER BY rowid LIMIT \?$/);
    expect(page).toContain(`(COALESCE("battle_id", '') <> '') AS battle`);
    for (const row of rowsOf(file, page)) {
      for (const [col, v] of Object.entries(row)) if (col !== "workspace_uris") expect([col, findCanaries(v)]).toEqual([col, []]);
      expect([0, 1]).toContain(row.battle as number);
    }
    expectNoCanaries([...allEvents(r), r.coverage]);
  });

  test("subagents: by parent or by nesting depth, at least depth 1; a row naming itself as parent is not one", async () => {
    const at = t0();
    const [A, D, S, Z] = [agId("A"), agId("D"), agId("S"), agId("Z")];
    writeSummaries(h, [
      { id: A, input: at, modified: at },
      { id: D, depth: 2, input: at, modified: at },
      { id: S, parent: S, input: at, modified: at },
      { id: C, parent: A, depth: 1, input: at, modified: at },
      { id: Z, parent: A, depth: 0, input: at, modified: at },
    ]);
    const r = await run([agCli]);
    expect([A, D, S, C, Z].map((id) => r.store.session(sidOf(id))).map((s) => [s!.origin, s!.parentId, s!.spawnDepth])).toEqual([
      ["human", undefined, undefined], ["subagent", undefined, 2], ["human", undefined, undefined], ["subagent", sidOf(A), 1],
      ["subagent", sidOf(A), 1],
    ]);
  });

  test("battle forks: a losing fork's copied inputs are no prompts again (battle-copy); the winner's and an undecided fork's are; all battle sessions", async () => {
    const at = t0();
    const [W, L, U] = [agId("BW"), agId("BL"), agId("BU")];
    const file = writeSummaries(h, [
      { id: W, battle: "battle-1", winner: W, input: at, modified: at + MIN },
      { id: L, battle: "battle-1", winner: W, input: at, modified: at + MIN },
      { id: U, battle: "battle-2", winner: "", input: at, modified: at + MIN },
    ]);
    for (const id of [W, L, U]) h.writeJsonl(transcriptRel(id), [userInput(0, at, "Build the parser"), userInput(1, at + 1_000, "Add its tests")]);
    const sql = observe();
    const r = await run([agCli]);
    __observeQueries(undefined);
    expect(r.store.all("prompt").map((p) => p.sessionId).sort()).toEqual([W, W, U, U].map(sidOf).sort());
    expect([W, L, U].map((id) => [r.store.session(sidOf(id))!.surface, r.store.session(sidOf(id))!.window])).toEqual([
      ["battle", "detail"], ["battle", "detail"], ["battle", "detail"],
    ]);
    expect(covOf(r, "antigravity.cli").skipped).toEqual({ "battle-copy": 2 });
    const page = sql.find((s) => sourceOf(s) === "conversation_summaries")!;
    expect(page).toContain(`(COALESCE("winning_conversation_id", '') NOT IN ('', "conversation_id")) AS battle_loser`);
    for (const row of rowsOf(file, page)) expect([0, 1]).toContain(row.battle_loser as number);
  });

  test("source: the program's trajectory sources, mapped inside SQL — SDK, eval, async and replay scripted; the agent API peer; unknown system and drift; prompts follow", async () => {
    const at = t0();
    const S = "CORTEX_TRAJECTORY_SOURCE_";
    const rows: [label: string, source: string, origin: string][] = [
      ["s0", "", "human"], ["s1", `${S}UNSPECIFIED`, "human"], ["s2", `${S}CLI`, "human"], ["s3", `${S}CASCADE_CLIENT`, "human"],
      ["s4", `${S}INTERACTIVE_CASCADE`, "human"], ["s5", `${S}JETBOX`, "human"], ["s6", `${S}EXPLAIN_PROBLEM`, "human"],
      ["s7", `${S}REFACTOR_FUNCTION`, "human"], ["s8", `${S}SDK`, "scripted"], ["s9", `${S}EVAL`, "scripted"], ["s10", `${S}EVAL_TASK`, "scripted"],
      ["s11", `${S}ASYNC_PRR`, "scripted"], ["s12", `${S}ASYNC_CF`, "scripted"], ["s13", `${S}ASYNC_SL`, "scripted"], ["s14", `${S}ASYNC_PRD`, "scripted"],
      ["s15", `${S}ASYNC_CM`, "scripted"], ["s16", `${S}REPLAY`, "scripted"], ["s17", `${S}AGENT_API`, "peer"], ["s18", `${S}SUBAGENT`, "subagent"],
      ["s19", `${S}NEW_KIND`, "system"], ["s20", CANARY.prompt, "system"],
    ];
    const file = writeSummaries(h, rows.map(([l, source]) => ({ id: agId(l), source, input: at, modified: at })));
    for (const l of ["s2", "s8", "s17", "s18", "s19"]) h.writeJsonl(transcriptRel(agId(l)), [userInput(0, at, "Run the importer")]);
    const sql = observe();
    const r = await run([agCli]);
    __observeQueries(undefined);
    expect(rows.map(([l]) => [l, r.store.session(sidOf(agId(l)))!.origin])).toEqual(rows.map(([l, , o]) => [l, o]));
    expect(r.store.session(sidOf(agId("s18")))).toMatchObject({ spawnDepth: 1 });
    expect(r.store.session(sidOf(agId("s18")))!.parentId).toBeUndefined();
    // the transcripts' inputs take their conversation's origin; a subagent's are its parent's briefs
    const byLabel = new Map(rows.map(([l]) => [sidOf(agId(l)), l]));
    expect(r.store.all("prompt").map((p) => [byLabel.get(p.sessionId!), p.origin]).sort()).toEqual([
      ["s17", "peer"], ["s19", "system"], ["s2", "human"], ["s8", "scripted"],
    ]);
    expect(summariesCov(r).unknownTypes).toEqual({ "conversation_summaries.source:(other)": 2 });
    // the value never leaves SQLite: only a fixed code does
    const page = sql.find((s) => sourceOf(s) === "conversation_summaries")!;
    for (const row of rowsOf(file, page)) expect(["none", "human", "scripted", "peer", "subagent", "other"]).toContain(row.src as string);
    expectNoCanaries([...allEvents(r), r.coverage]);
  });

  test("times: Go time strings, the earliest of the two as start; a row without any time, without steps or without an id is skipped", async () => {
    const at = t0();
    const [T1, T2, E, N] = [agId("T1"), agId("T2"), agId("E"), agId("N")];
    writeSummaries(h, [
      { id: T1, input: at + 5 * MIN, modified: at + 9 * MIN },
      { id: T2, input: GO_ZERO_TIME, modified: new Date(at).toISOString() },
      { id: E, steps: 0, input: at, modified: at },
      { id: N, input: GO_ZERO_TIME, modified: "not a time" },
      { id: "", input: at, modified: at },
      { id: "plain-id", input: at, modified: at },
    ]);
    const r = await run([agCli]);
    expect(r.store.session(sidOf(T1))).toMatchObject({ start: at + 5 * MIN, end: at + 9 * MIN });
    expect(r.store.session(sidOf(T2))).toMatchObject({ start: at, end: at });
    expect(r.store.session(sidOf(keyedHash(r.salt, "plain-id")))).toMatchObject({ start: at });
    expect(r.store.all("session")).toHaveLength(3);
    expect(summariesCov(r)).toMatchObject({ status: "ok", records: 6, skipped: { "empty-session": 1, "no-ts": 1, "bad-row": 1 } });
  });

  test("workspace_uris: a JSON array of file URIs — the first folder is the project; null or empty is none; another shape is drift", async () => {
    const at = t0();
    const [W1, W2, W3, W4] = [agId("W1"), agId("W2"), agId("W3"), agId("W4")];
    writeSummaries(h, [
      { id: W1, input: at, modified: at, workspaces: ["file:///work/first%20folder", "file:///work/second"] },
      { id: W2, input: at, modified: at, workspaces: "null" },
      { id: W3, input: at, modified: at, workspaces: [] },
      { id: W4, input: at, modified: at, workspaces: `${CANARY.path} not json` },
    ]);
    const r = await run([agCli]);
    const key = r.store.session(sidOf(W1))!.projectKey!;
    expect(normalizePath(r.cwds.get(key)!)).toBe("/work/first folder");
    expect([W2, W3, W4].map((id) => r.store.session(sidOf(id))!.projectKey)).toEqual([undefined, undefined, undefined]);
    expect(summariesCov(r).unknownTypes).toEqual({ "conversation_summaries.workspace_uris:shape": 1 });
    expectNoCanaries([...allEvents(r), r.coverage]);
  });

  test("schema drift: a missing column is drift and the rest is read; a missing or WITHOUT ROWID table is drift", async () => {
    const at = t0();
    const ddl = SUMMARIES_DDL.replace("nesting_depth INTEGER NOT NULL DEFAULT 0,", "").replace("killed numeric NOT NULL DEFAULT false,", "");
    const db = h.sqlite(summariesRel, [ddl]);
    const w = new Database(db);
    w.query("INSERT INTO conversation_summaries (conversation_id, step_count, last_modified_time, workspace_uris, last_user_input_time) VALUES (?, 3, ?, '[]', ?)")
      .run(P, new Date(at).toISOString(), new Date(at).toISOString());
    w.close();
    let r = await run([agCli]);
    expect(r.store.session(sidOf(P))).toMatchObject({ start: at, origin: "human" });
    expect(summariesCov(r)).toMatchObject({ status: "drift", unknownTypes: { "missing-column:nesting_depth": 1, "missing-column:killed": 1 } });

    h.cleanup();
    h = fakeHome();
    h.sqlite(summariesRel, ["CREATE TABLE other (x TEXT)"]);
    r = await run([agCli]);
    expect(summariesCov(r)).toMatchObject({ status: "drift", unknownTypes: { "missing-table:conversation_summaries": 1 }, files: 1 });

    h.cleanup();
    h = fakeHome();
    h.sqlite(summariesRel, [SUMMARIES_DDL.replace(/\)$/, ") WITHOUT ROWID").replace("conversation_id TEXT,", "conversation_id TEXT NOT NULL,")]);
    r = await run([agCli]);
    expect(summariesCov(r)).toMatchObject({ status: "drift", unknownTypes: { "table-unreadable:conversation_summaries": 1 } });
    expect(r.warnings.some((x) => x.code === "drift" && x.source === "antigravity.cli")).toBe(true);
  });

  test("rowid pages: more rows than a page are each read once", async () => {
    const at = t0();
    const ids = Array.from({ length: 1_005 }, (_, i) => agId(`r${i}`));
    writeSummaries(h, ids.map((id) => ({ id, input: at, modified: at })));
    const sql = observe();
    const r = await run([agCli]);
    __observeQueries(undefined);
    expect(r.store.all("session").map((s) => s.id).sort()).toEqual(ids.map(sidOf).sort());
    expect(sql.filter((s) => sourceOf(s) === "conversation_summaries")).toHaveLength(2);
    expect(summariesCov(r).records).toBe(ids.length);
  });
});

describe("antigravity cli: conversations/<id>.db steps", () => {
  const t0 = () => fixtureStart();
  const tools = (r: Result): ToolEv[] => byTime(r.store.all("tool"));

  test("step types: tool steps by category under their names; questions and notices to the person are meta; input, replies, checkpoints and messages are no tools; unknown types drift", async () => {
    const at = t0();
    let n = 0;
    const s = (type: number, extra: Partial<StepOpts> = {}): StepOpts => ({ type, ts: at + ++n * 1_000, ...extra });
    writeSteps(h, P, [
      s(STEP.FILE_CHANGE), s(STEP.COMMAND_STATUS), s(STEP.LIST_DIRECTORY), s(STEP.FIND), s(STEP.CLICK_BROWSER_PIXEL), s(STEP.BROWSER_SUBAGENT),
      s(STEP.SEARCH_WEB), s(STEP.MCP_TOOL), s(STEP.GIT_COMMIT), s(STEP.INVOKE_SUBAGENT), s(STEP.TASK_BOUNDARY), s(STEP.WAIT), s(STEP.EDIT_NOTEBOOK),
      s(STEP.SHELL_EXEC), s(STEP.GENERATE_IMAGE), s(STEP.TOOL_SEARCH),
      s(STEP.USER_INPUT), s(STEP.PLANNER_RESPONSE), s(STEP.CHECKPOINT), s(STEP.EPHEMERAL_MESSAGE), s(STEP.SYSTEM_MESSAGE), s(STEP.ERROR_MESSAGE),
      s(STEP.NOTIFY_USER), s(STEP.ASK_QUESTION), s(999), s(4_000_000),
    ]);
    const r = await run([agCli]);
    expect(tools(r).map((t) => [t.name, t.category])).toEqual([
      ["file_change", "edit"], ["command_status", "shell"], ["list_directory", "read"], ["find", "search"], ["click_browser_pixel", "browser"],
      ["browser_subagent", "browser"], ["search_web", "web"], ["mcp_tool", "mcp"], ["git_commit", "git"], ["invoke_subagent", "delegate"],
      ["task_boundary", "plan"], ["wait", "schedule"], ["edit_notebook", "notebook"], ["shell_exec", "shell"], ["generate_image", "other"],
      ["tool_search", "other"], ["notify_user", "meta"], ["ask_question", "meta"],
    ]);
    const cov = covOf(r, "antigravity.cli");
    expect([cov.status, cov.records, cov.unknownTypes]).toEqual(["drift", 26, { "step-type:999": 1, "step-type:(other)": 1 }]);
    // the conversation's detail session spans its steps
    expect(r.store.session(sidOf(P))).toMatchObject({ window: "detail", origin: "human", surface: "cli", start: at + 1_000, end: at + 26_000 });
  });

  test("run commands: the command line classified in memory with its exit code, in either payload layout; without a command, plain shell", async () => {
    const at = t0();
    // the rows without a command in their payload record a call that is not a run_command, so nothing else can supply one
    const noCall = (ms: number) => stepMetadata(ms, "view_file", { AbsolutePath: CANARY.path });
    const file = writeSteps(h, P, [
      { type: STEP.RUN_COMMAND, ts: at + 1_000, payload: runPayload({ cmd: "pytest -q", exit: 1 }) },
      { type: STEP.RUN_COMMAND, ts: at + 2_000, payload: runPayload({ cmd: "npm run build", wrapped: true }) },
      { type: STEP.RUN_COMMAND, ts: at + 3_000, payload: runPayload({ cmd: "git status", exit: 128, wrapped: true }) },
      { type: STEP.RUN_COMMAND, metadata: noCall(at + 4_000), payload: runPayload({}) },
      { type: STEP.RUN_COMMAND, metadata: noCall(at + 5_000), payload: null },
      { type: STEP.RUN_COMMAND, metadata: noCall(at + 6_000), payload: new TextEncoder().encode(`${CANARY.secret} not protobuf ÿ`) },
      { type: STEP.RUN_COMMAND, metadata: noCall(at + 7_000), payload: pbEncode([[1, STEP.RUN_COMMAND], [4, STATUS.DONE]]) },
      { type: STEP.CODE_ACTION, ts: at + 8_000 },
    ]);
    const sql = observe();
    const r = await run([agCli]);
    __observeQueries(undefined);
    expect(tools(r).map((t) => [t.category, t.checks, t.exit, t.ok])).toEqual([
      ["test", ["test"], 1, false], ["build", ["build"], undefined, true], ["git", undefined, 128, false], ["shell", undefined, undefined, true],
      ["shell", undefined, undefined, true], ["shell", undefined, undefined, true], ["shell", undefined, undefined, true], ["edit", undefined, undefined, true],
    ]);
    // what leaves SQLite: the payload of run-command steps only; error details as a flag
    const page = sql.find((s) => sourceOf(s) === "steps")!;
    expect(page).toContain(`CASE WHEN "step_type" = 21 AND length("step_payload") <= 1048576 THEN "step_payload" END AS payload`);
    expect(page).toContain(`("error_details" IS NOT NULL AND length("error_details") > 0) AS err`);
    const rows = rowsOf(file, page);
    expect(rows).toHaveLength(8);
    for (const row of rows) {
      for (const [col, v] of Object.entries(row)) if (!STEP_IN_MEMORY.has(col)) expect([col, findCanaries(v)]).toEqual([col, []]);
      if (row.step_type !== STEP.RUN_COMMAND) expect(row.payload).toBeNull();
    }
    expectNoCanaries([...allEvents(r), r.coverage]);
  });

  test("blob caps: metadata or a payload above 1 MiB never leaves SQLite — counted oversize; the step still maps by its type, timed by the metadata's head", async () => {
    const at = t0();
    const big = "x".repeat(1_100_000);
    // created_at first, as the program writes fields in number order; the call (with the command) far beyond the head
    const bigMeta = (ms: number, tool: string) =>
      pbEncode([[1, pbTs(ms)], [4, pbEncode([[1, `call-${CANARY.secret}`], [2, tool], [3, JSON.stringify({ CommandLine: "pytest -q", Content: `${CANARY.code}${big}` })]])]]);
    const file = writeSteps(h, P, [
      { type: STEP.VIEW_FILE, metadata: bigMeta(at + 1_000, "view_file"), error: true },
      { type: STEP.GENERIC, metadata: bigMeta(at + 2_000, "run_command") },
      { type: STEP.RUN_COMMAND, metadata: stepMetadata(at + 3_000, "view_file"), payload: runPayload({ cmd: `pytest ${big}`, exit: 1 }) },
      { type: STEP.RUN_COMMAND, metadata: bigMeta(at + 4_000, "run_command"), payload: runPayload({ cmd: "npm run build" }) },
      { type: STEP.VIEW_FILE, metadata: pbEncode([[4, pbEncode([[1, big]])], [1, pbTs(at + 5_000)]]) },
    ]);
    const sql = observe();
    const r = await run([agCli]);
    __observeQueries(undefined);
    expect(tools(r).map((t) => [t.ts - at, t.name, t.category, t.checks, t.exit])).toEqual([
      [1_000, "view_file", "read", undefined, undefined],
      [2_000, "generic", "other", undefined, undefined], // its call, and the command in it, never left SQLite
      [3_000, "run_command", "shell", undefined, undefined], // so did its payload
      [4_000, "run_command", "build", ["build"], undefined], // the payload still classifies it
    ]);
    expect(markers(r, "error").map((m) => m.ts - at)).toEqual([1_000]);
    // the last step's head holds no time (a large field comes first): no-ts
    expect(covOf(r, "antigravity.cli").skipped).toEqual({ oversize: 5, "no-ts": 1 });
    const page = sql.find((s) => sourceOf(s) === "steps")!;
    expect(rowsOf(file, page).map((row) => [row.metadata === null, (row.mhead as Uint8Array | null)?.length ?? null, row.payload === null, row.pbig])).toEqual([
      [true, 64, true, 0], [true, 64, true, 0], [false, null, true, 1], [true, 64, false, 0], [true, 64, true, 0],
    ]);
    expectNoCanaries([...allEvents(r), r.coverage]);
  });

  test("generic steps: by the name of the tool their metadata's call names — built-in names only; MCP tools as mcp; any other name stays generic", async () => {
    const at = t0();
    const g = (i: number, tool: string): StepOpts => ({ type: STEP.GENERIC, metadata: stepMetadata(at + i * 1_000, tool) });
    writeSteps(h, P, [
      g(1, "read_file"), g(2, "search_in_file"), g(3, "edit_file"), g(4, "write_file"), g(5, "run_command"), g(6, "search_web"),
      g(7, "read_browser_page"), g(8, "invoke_subagent"), g(9, "manage_task"), g(10, "schedule"), g(11, "generate_image"),
      g(12, `mcp_${CANARY.mcp}_lookup`), g(13, `${CANARY.project}_custom_tool`), g(14, ""),
      { type: STEP.GENERIC, metadata: pbEncode([[1, pbTs(at + 15_000)]]) },
      // questions and notices to the person, and the end of a turn: bookkeeping, emitted as meta
      g(16, "ask_question"), g(17, "ask_permission"), g(18, "ask_custom_permission"), g(19, "notify_user"), g(20, "finish"),
    ]);
    const r = await run([agCli]);
    expect(tools(r).map((t) => [t.name, t.category, t.checks])).toEqual([
      ["read_file", "read", undefined], ["search_in_file", "search", undefined], ["edit_file", "edit", undefined], ["write_file", "write", undefined],
      ["run_command", "shell", undefined], ["search_web", "web", undefined], ["read_browser_page", "browser", undefined],
      ["invoke_subagent", "delegate", undefined], ["manage_task", "todo", undefined], ["schedule", "schedule", undefined], ["generate_image", "other", undefined],
      ["mcp", "mcp", undefined], ["generic", "other", undefined], ["generic", "other", undefined], ["generic", "other", undefined],
      ["ask_question", "meta", undefined], ["ask_permission", "meta", undefined], ["ask_custom_permission", "meta", undefined],
      ["notify_user", "meta", undefined], ["finish", "meta", undefined],
    ]);
    expect(r.store.session(sidOf(P))!.end).toBe(at + 20_000);
    expect(tools(r).every((t) => t.mcpServer === undefined)).toBe(true);
    expectNoCanaries([...allEvents(r), r.coverage]);
  });

  test("the command line of a run_command call in the metadata classifies a generic one, and a typed one whose payload has none", async () => {
    const at = t0();
    const call = (args: unknown) => stepMetadata(at, "run_command", args);
    writeSteps(h, P, [
      { type: STEP.GENERIC, metadata: call({ CommandLine: "pytest -q", Cwd: CANARY.path, SafeToAutoRun: true }) },
      { type: STEP.GENERIC, metadata: call({ Cwd: CANARY.path }) },
      { type: STEP.GENERIC, metadata: call(`{"CommandLine": "${CANARY.secret}`) },
      { type: STEP.GENERIC, metadata: stepMetadata(at, "write_file", { CommandLine: "pytest -q", Content: CANARY.code }) },
      { type: STEP.RUN_COMMAND, metadata: call({ CommandLine: "npm run lint" }), payload: null },
      { type: STEP.RUN_COMMAND, metadata: call({ CommandLine: "npm run lint" }), payload: runPayload({ cmd: "cargo build" }) },
    ]);
    const r = await run([agCli]);
    expect(tools(r).map((t) => [t.name, t.category, t.checks])).toEqual([
      ["run_command", "test", ["test"]], ["run_command", "shell", undefined], ["run_command", "shell", undefined], ["write_file", "write", undefined],
      ["run_command", "lint", ["lint"]], ["run_command", "build", ["build"]],
    ]);
    expectNoCanaries([...allEvents(r), r.coverage]);
  });

  test("status: done is ok, error is not; canceled and interrupted steps did not run to an end of their own; any other says nothing", async () => {
    const at = t0();
    writeSteps(h, P, [STATUS.DONE, STATUS.ERROR, STATUS.CANCELED, STATUS.INTERRUPTED, STATUS.RUNNING].map((status, i) => ({ type: STEP.VIEW_FILE, status, ts: at + i })));
    const r = await run([agCli]);
    expect(tools(r).map((t) => [t.ok, t.outcome])).toEqual([[true, undefined], [false, undefined], [undefined, "cancelled"], [undefined, "interrupted"], [undefined, undefined]]);
  });

  test("a run command the person rejected was denied: no ok or exit, a denial marker; typed check steps list their checks", async () => {
    const at = t0();
    writeSteps(h, P, [
      { type: STEP.RUN_COMMAND, ts: at, payload: runPayload({ cmd: "npm test", rejected: true }) },
      { type: STEP.RUN_COMMAND, ts: at + 1_000, payload: runPayload({ cmd: "npm test", exit: 1 }) },
      { type: STEP.RUN_COMMAND, ts: at + 2_000, status: STATUS.CANCELED, payload: runPayload({ cmd: "npm test", exit: 1 }) },
      { type: STEP.BLAZE_TEST_TARGETS, ts: at + 3_000 }, { type: STEP.COMPILE, ts: at + 4_000, status: STATUS.ERROR }, { type: STEP.LINT_APPLET, ts: at + 5_000 },
    ]);
    const r = await run([agCli]);
    expect(tools(r).map((t) => [t.name, t.category, t.checks, t.ok, t.outcome, t.exit])).toEqual([
      ["run_command", "test", ["test"], undefined, "denied", undefined], ["run_command", "test", ["test"], false, undefined, 1],
      ["run_command", "test", ["test"], undefined, "cancelled", undefined],
      ["blaze_test_targets", "test", ["test"], true, undefined, undefined], ["compile", "build", ["build"], false, undefined, undefined],
      ["lint_applet", "lint", ["lint"], true, undefined, undefined],
    ]);
    expect(markers(r, "denial").map((m) => [m.detail, m.ts - at])).toEqual([["user", 0]]);
  });

  test("times from the step metadata: without metadata or a creation time no-ts; metadata that is not protobuf is drift; errors only with a time", async () => {
    const at = t0();
    writeSteps(h, P, [
      { type: STEP.VIEW_FILE, ts: at },
      { type: STEP.VIEW_FILE, metadata: null, error: true },
      { type: STEP.VIEW_FILE, metadata: pbEncode([[3, 2], [8, pbTs(at)]]) },
      { type: STEP.VIEW_FILE, metadata: new TextEncoder().encode(`${CANARY.secret} ÿ not protobuf`) },
      { type: STEP.VIEW_FILE, metadata: `${CANARY.secret} as text` },
      { type: STEP.ERROR_MESSAGE, ts: at + 1_000, error: true },
      { type: STEP.VIEW_FILE, metadata: pbEncode([[1, pbEncode([[1, 7]])]]) },
    ]);
    const r = await run([agCli]);
    expect(tools(r).map((t) => t.ts - at)).toEqual([0]);
    expect(markers(r, "error").map((m) => m.ts - at)).toEqual([1_000]);
    const cov = covOf(r, "antigravity.cli");
    expect([cov.skipped, cov.unknownTypes]).toEqual([{ "no-ts": 3 }, { "steps.metadata:shape": 2 }]);
    expectNoCanaries([...allEvents(r), r.coverage]);
  });

  test("schema drift: missing columns are drift and what remains is read; no steps table; a store that is not a database is an io-error", async () => {
    const at = t0();
    h.sqlite(stepsRel(P), ["CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB)"], { steps: [[0, STEP.VIEW_FILE, stepMetadata(at)]] });
    h.sqlite(stepsRel(C), ["CREATE TABLE trajectory_meta (trajectory_id TEXT)"]);
    h.write(stepsRel(K), "not a database");
    const r = await run([agCli]);
    expect(r.store.all("tool").map((t) => [t.sessionId, t.category, t.ok])).toEqual([[sidOf(P), "read", undefined]]);
    expect(covOf(r, "antigravity.cli")).toMatchObject({
      status: "drift", files: 2, skipped: { "io-error": 1 },
      unknownTypes: { "missing-column:status": 1, "missing-column:error_details": 1, "missing-column:step_payload": 1, "missing-table:steps": 1 },
    });
  });

  test("rowid pages: more steps than a page are each read once", async () => {
    const at = t0();
    writeSteps(h, P, Array.from({ length: 600 }, (_, i) => ({ type: STEP.VIEW_FILE, ts: at + i })));
    const sql = observe();
    const r = await run([agCli]);
    __observeQueries(undefined);
    expect(r.store.all("tool")).toHaveLength(600);
    expect(new Set(r.store.all("tool").map((t) => t.ts)).size).toBe(600);
    expect(sql.filter((s) => sourceOf(s) === "steps").length).toBeGreaterThan(1);
  });
});

describe("antigravity cli: transcript.jsonl", () => {
  const t0 = () => fixtureStart();

  test("prompts: explicit inputs of conversations that are not subagents; implicit inputs and a subagent's briefs are not; images are a paste", async () => {
    const at = t0();
    writeSummaries(h, [{ id: P, input: at, modified: at }, { id: C, parent: P, depth: 1, input: at, modified: at }]);
    h.writeJsonl(transcriptRel(P), [
      userInput(0, at, "Refactor the parser", { media: ["image/png"] }),
      record({ step: 1, type: "USER_INPUT", source: "USER_IMPLICIT", ts: at + 1_000, content: `${CANARY.prompt} implicit` }),
      userInput(2, at + 2_000, "   "),
      userInput(3, at + 3_000, undefined, { extra: { content: null } }),
      userInput(4, undefined, `${CANARY.prompt} without a time`),
      record({ step: 5, type: "CODE_ACTION", source: "MODEL", ts: at + 5_000 }),
      userInput(6, at + 40 * MIN, "Now the lexer", { media: ["audio/wav"] }),
    ]);
    h.writeJsonl(transcriptRel(C), [userInput(0, at + MIN, `${CANARY.prompt} the brief the parent wrote`)]);
    const r = await run([agCli]);
    const prompts = byTime(r.store.all("prompt"));
    expect(prompts.map((p) => [p.sessionId, p.ts - at, p.hasPaste, p.features.isTaskStart])).toEqual([
      [sidOf(P), 0, true, true], [sidOf(P), 40 * MIN, undefined, true],
    ]);
    expect(prompts.map((p) => p.textHash)).toEqual(["Refactor the parser", "Now the lexer"].map((t) => keyedHash(r.salt, t)));
    expect(r.store.session(sidOf(C))).toMatchObject({ window: "detail", origin: "subagent", parentId: sidOf(P), start: at, end: at + MIN });
    const cov = covOf(r, "antigravity.cli");
    expect([cov.skipped, cov.unknownTypes]).toEqual([{ empty: 1, "no-ts": 1 }, { "transcript.content:missing": 1 }]);
    expectNoCanaries([...allEvents(r), r.coverage]);
  });

  test("record types and sources: unknown ones are drift, enum-shaped names kept; usage from records with token counts, a model when named", async () => {
    const at = t0();
    h.writeJsonl(transcriptRel(P), [
      modelReply(0, at, { input: 10, output: 20, cacheRead: 30 }),
      record({ step: 1, type: "PLANNER_RESPONSE", source: "MODEL", ts: at + 1_000, tokens: { output: 5 }, extra: { model: "gemini-3-pro", cache_write_tokens: 7 } }),
      record({ step: 2, type: "PLANNER_RESPONSE", source: "MODEL", ts: at + 2_000, extra: { model: `${CANARY.project} model with spaces`, input_tokens: 1 } }),
      record({ step: 3, type: "VIEW_FILE", source: "MODEL", ts: at + 3_000 }),
      record({ step: 4, type: "NEW_STEP_KIND", source: "MODEL", ts: at + 4_000 }),
      record({ step: 5, type: `${CANARY.prompt}`, source: "MODEL", ts: at + 5_000 }),
      record({ step: 6, type: "VIEW_FILE", source: "NEW_SOURCE", ts: at + 6_000 }),
      { step_index: 7, source: "MODEL" },
      "not an object",
      record({ step: 8, type: "PLANNER_RESPONSE", source: "MODEL", tokens: { input: 1 } }),
    ]);
    const r = await run([agCli]);
    expect(byTime(r.store.all("usage")).map((u) => [u.ts - at, u.model, u.inTok, u.outTok, u.cacheR, u.cacheW])).toEqual([
      [0, "other", 10, 20, 30, 0], [1_000, "gemini-3-pro", 0, 5, 0, 7], [2_000, "other", 1, 0, 0, 0],
    ]);
    // models in order of first use; a named model that is not id-shaped is `other` (records without a model name none)
    expect(r.store.session(sidOf(P))!.models).toEqual(["gemini-3-pro", "other"]);
    const cov = covOf(r, "antigravity.cli");
    expect(cov.unknownTypes).toEqual({
      "transcript.type:NEW_STEP_KIND": 1, "transcript.type:(other)": 1, "transcript.source:NEW_SOURCE": 1, "transcript.type:(none)": 1, "transcript:not-object": 1,
    });
    expect([cov.records, cov.skipped]).toEqual([10, { "no-ts": 1 }]);
    expectNoCanaries([...allEvents(r), r.coverage]);
  });

  test("a transcript cut off mid-line keeps its complete lines; a conversation with only a transcript is a human cli session", async () => {
    const at = t0();
    const lines = [userInput(0, at, "Explain the build"), modelReply(1, at + 1_000, { input: 1, output: 1 })].map((x) => JSON.stringify(x)).join("\n");
    h.write(transcriptRel(P), `${lines}\n{"type": "USER_INPUT", "content": "${CANARY.prompt}`);
    const r = await run([agCli]);
    expect([r.store.all("prompt").length, r.store.all("usage").length]).toEqual([1, 1]);
    expect(r.store.session(sidOf(P))).toMatchObject({ window: "detail", origin: "human", surface: "cli", start: at, end: at + 1_000 });
    expect(covOf(r, "antigravity.cli")).toMatchObject({ records: 2, skipped: { parse: 1 }, files: 1 });
  });
});

describe("antigravity history: history.jsonl (its own lifetime source)", () => {
  test("lifetime prompts and days (source antigravity.history), sessions from conversationId; slash commands are prompts; drift and skips", async () => {
    const noon = new Date(fixtureStart(5));
    noon.setHours(12, 0, 0, 0); // local noon: the minutes after it stay on the same local day
    const at = noon.getTime();
    const day2 = at + 86_400_000;
    h.writeJsonl(historyRel, [
      historyLine({ display: "Refactor the importer", timestamp: at, conversationId: P }),
      historyLine({ display: "Add tests for it", timestamp: at + MIN, conversationId: P }),
      historyLine({ display: "/model", timestamp: at + 2 * MIN, conversationId: P, type: "slash_command" }),
      historyLine({ display: "What changed?", timestamp: day2 }),
      historyLine({ display: "   ", timestamp: day2 + 1 }),
      historyLine({ display: "Too old", timestamp: 1_000 }),
      historyLine({ display: CANARY.prompt, timestamp: day2, type: "voice_note" }),
      historyLine({ timestamp: day2 }),
      historyLine({ display: CANARY.prompt }),
      "not an object",
    ]);
    const r = await run([agHistory]);
    const prompts = byTime(r.store.all("prompt"));
    expect(prompts.map((p) => [p.source, p.window, p.origin, p.sessionId, p.intent, p.features.isTaskStart])).toEqual([
      ["antigravity.history", "lifetime", "human", sidOf(P), classifyIntent("Refactor the importer"), true],
      ["antigravity.history", "lifetime", "human", sidOf(P), classifyIntent("Add tests for it"), false],
      ["antigravity.history", "lifetime", "human", sidOf(P), "command", false],
      ["antigravity.history", "lifetime", "human", undefined, "question", true],
    ]);
    expect(prompts[1]!.features.simToPrev).toBeDefined();
    expect(r.store.all("daily")).toEqual([
      { k: "daily", tool: "antigravity", source: "antigravity.history", day: localDay(at), zone: "local", unit: "prompts", count: 3 },
      { k: "daily", tool: "antigravity", source: "antigravity.history", day: localDay(day2), zone: "local", unit: "prompts", count: 1 },
    ]);
    expect(r.store.all("session")).toEqual([]);
    const cov = covOf(r, "antigravity.history");
    expect(cov).toMatchObject({ window: "lifetime", status: "drift", files: 1, records: 10, skipped: { empty: 1, "bad-ts": 1 } });
    expect(cov.unknownTypes).toEqual({ "history.type:voice_note": 1, "history.display:missing": 1, "history.timestamp:missing": 1, "history:not-object": 1 });
    expectNoCanaries([...allEvents(r), r.coverage]);
  });
});

describe("antigravity cli: stores", () => {
  test("every store present unreadable: an error of the source; one readable store is enough", async () => {
    h.write(summariesRel, "not a database");
    h.write(stepsRel(P), "not a database either");
    let r = await run([agCli]);
    expect(r.coverage.map((c) => [c.source, c.window, c.status])).toEqual([["antigravity.cli", "detail", "error"], ["antigravity.cli", "lifetime", "error"]]);
    h.writeJsonl(transcriptRel(P), [userInput(0, fixtureStart(), "Hello")]);
    r = await run([agCli]);
    // the readable transcript is enough for the source; each window says how its own stores fared
    expect(covOf(r, "antigravity.cli")).toMatchObject({ status: "ok", files: 1, skipped: { "io-error": 1 } });
    expect(summariesCov(r)).toMatchObject({ status: "error", note: "unreadable", files: 0, skipped: { "io-error": 1 } });
  });

  test("no CLI folder: absent; a folder without stores: absent in both windows, history empty", async () => {
    let r = await run([agCli, agHistory]);
    expect(r.coverage.map((c) => [c.source, c.window, c.status])).toEqual([
      ["antigravity.cli", "detail", "absent"], ["antigravity.cli", "lifetime", "absent"], ["antigravity.history", "lifetime", "absent"],
    ]);
    mkdirSync(path.join(h.env.home, CLI_REL), { recursive: true });
    r = await run([agCli, agHistory]);
    expect(r.coverage.map((c) => [c.source, c.window, c.status, c.files, c.records])).toEqual([
      ["antigravity.cli", "detail", "absent", 0, 0], ["antigravity.cli", "lifetime", "absent", 0, 0], ["antigravity.history", "lifetime", "empty", 0, 0],
    ]);
  });
});

describe("antigravity ide: trajectory summaries", () => {
  const t0 = () => fixtureStart();
  const store = (items: [string, unknown][], app = "Antigravity") => writeIdeStore(h, ideRel(h, app), [...AUTH_ITEMS, ...items]);

  test("both app folders, Antigravity and Antigravity IDE, one coverage each; the value as text or as a blob", async () => {
    const at = t0();
    store([[TRAJ_KEY, topic([{ key: I1, summary: trajectory({ steps: 3, created: at, updated: at + MIN }) }])]]);
    store([[TRAJ_KEY, new TextEncoder().encode(topic([{ key: I2, summary: trajectory({ steps: 1, created: at, updated: at }) }]))]], "Antigravity IDE");
    const r = await run([agIde]);
    expect(r.store.all("session").map((s) => s.id).sort()).toEqual([I1, I2].map(sidOf).sort());
    expect(r.coverage.map((c) => [c.source, c.status, c.records])).toEqual([["antigravity.ide", "ok", 1], ["antigravity.ide", "ok", 1]]);
  });

  test("ids: the entry key (UUID verbatim, else hashed), else the summary's own id; times: created, else updated", async () => {
    const at = t0();
    store([[TRAJ_KEY, topic([
      { key: "plain key", summary: trajectory({ steps: 1, created: at, updated: at + MIN }) },
      { key: "", summary: trajectory({ id: I2, steps: 1, updated: at + 2 * MIN }) },
      { key: I1, summary: trajectory({ steps: 1, created: at + 5 * MIN, updated: at + 4 * MIN }) },
    ])]]);
    const r = await run([agIde]);
    expect(r.store.session(sidOf(keyedHash(r.salt, "plain key")))).toMatchObject({ start: at, end: at + MIN });
    expect(r.store.session(sidOf(I2))).toMatchObject({ start: at + 2 * MIN, end: at + 2 * MIN });
    expect(r.store.session(sidOf(I1))).toMatchObject({ start: at + 5 * MIN, end: at + 5 * MIN });
  });

  test("no steps: empty-session; every entry without steps is drift; no time: no-ts", async () => {
    const at = t0();
    store([[TRAJ_KEY, topic([
      { key: I1, summary: trajectory({ steps: 2, created: at, updated: at }) },
      { key: I2, summary: trajectory({ created: at, updated: at }) },
      { key: agId("nt"), summary: trajectory({ steps: 4 }) },
    ])]]);
    let r = await run([agIde]);
    expect(r.store.all("session").map((s) => s.id)).toEqual([sidOf(I1)]);
    expect(covOf(r, "antigravity.ide")).toMatchObject({ status: "ok", records: 3, skipped: { "empty-session": 1, "no-ts": 1 }, unknownTypes: {} });

    h.cleanup();
    h = fakeHome();
    store([[TRAJ_KEY, topic([{ key: I1, summary: trajectory({ created: at }) }, { key: I2, summary: trajectory({ created: at }) }])]]);
    r = await run([agIde]);
    expect(covOf(r, "antigravity.ide")).toMatchObject({ status: "drift", skipped: { "empty-session": 2 }, unknownTypes: { "trajectorySummaries:no-steps": 1 } });
  });

  test("shapes: an empty or NULL value is empty; a value that is not the topic is drift; an entry that does not decode is drift, the others map", async () => {
    const at = t0();
    store([[TRAJ_KEY, ""]]);
    let r = await run([agIde]);
    expect(covOf(r, "antigravity.ide")).toMatchObject({ status: "empty", files: 1, unknownTypes: {} });
    h.cleanup();
    h = fakeHome();
    store([[TRAJ_KEY, null]]);
    r = await run([agIde]);
    expect(covOf(r, "antigravity.ide")).toMatchObject({ status: "empty", files: 1, records: 0, unknownTypes: {} });

    // text that is not protobuf (its first byte names wire type 6), JSON, a message without topic entries
    for (const bad of [Buffer.from(`not protobuf ${CANARY.secret}`).toString("base64"), "{}", Buffer.from(pbEncode([[3, 7]])).toString("base64")]) {
      h.cleanup();
      h = fakeHome();
      store([[TRAJ_KEY, bad]]);
      r = await run([agIde]);
      expect([bad.slice(0, 8), covOf(r, "antigravity.ide").unknownTypes]).toEqual([bad.slice(0, 8), { "trajectorySummaries:shape": 1 }]);
    }

    h.cleanup();
    h = fakeHome();
    const good = topic([{ key: I1, summary: trajectory({ steps: 1, created: at, updated: at }) }]);
    // an entry whose row holds no summary (the decoded text names wire type 6), an entry without a row
    const notSummary = Buffer.from(`not a summary ${CANARY.secret}`).toString("base64");
    const broken = Buffer.concat([Buffer.from(good, "base64"), pbEncode([[1, pbEncode([[1, I2], [2, pbEncode([[1, notSummary]])]])], [1, pbEncode([[1, agId("x")]])]])]);
    store([[TRAJ_KEY, broken.toString("base64")]]);
    r = await run([agIde]);
    expect(r.store.all("session").map((s) => s.id)).toEqual([sidOf(I1)]);
    expect(covOf(r, "antigravity.ide")).toMatchObject({ status: "drift", records: 3, unknownTypes: { "trajectorySummaries.entry:shape": 2 } });
    expectNoCanaries([...allEvents(r), r.coverage]);
  });

  test("workspaces: the first folder of the summary as the project; the rest of the summary is never kept", async () => {
    const at = t0();
    store([[TRAJ_KEY, topic([{
      key: I1,
      summary: pbEncode([[TRAJ_FIELDS.steps, 1], [TRAJ_FIELDS.created, pbTs(at)], [TRAJ_FIELDS.workspace, pbEncode([[1, "file:///proj/one"]])],
        [TRAJ_FIELDS.workspace, pbEncode([[1, "file:///proj/two"]])], [1, CANARY.prompt]]),
    }])]]);
    const r = await run([agIde]);
    const key = r.store.session(sidOf(I1))!.projectKey!;
    expect(normalizePath(r.cwds.get(key)!)).toBe("/proj/one");
    expectNoCanaries([...allEvents(r), r.coverage]);
  });

  test("no trajectory key, or no ItemTable: empty or drift — the account rows are never selected; a store that is not a database is an error", async () => {
    store([]);
    const sql = observe();
    let r = await run([agIde]);
    __observeQueries(undefined);
    expect(covOf(r, "antigravity.ide")).toMatchObject({ status: "empty", files: 1, records: 0 });
    expect(sql.filter((s) => /ItemTable/.test(s))).toEqual(["SELECT value FROM ItemTable WHERE key = ?"]);
    expect(allEvents(r)).toEqual([]);

    h.cleanup();
    h = fakeHome();
    h.sqlite(ideRel(h), ["CREATE TABLE other (key TEXT, value BLOB)"]);
    r = await run([agIde]);
    expect(covOf(r, "antigravity.ide")).toMatchObject({ status: "drift", unknownTypes: { "missing-table:ItemTable": 1 } });

    h.cleanup();
    h = fakeHome();
    h.write(ideRel(h), "not a database");
    r = await run([agIde]);
    expect(r.coverage).toEqual([expect.objectContaining({ source: "antigravity.ide", status: "error" })]);
  });

  test("an app folder without a store: empty; no app folder: absent", async () => {
    let r = await run([agIde]);
    expect(covOf(r, "antigravity.ide").status).toBe("absent");
    mkdirSync(vscodeUser(h.env, "Antigravity IDE"), { recursive: true });
    r = await run([agIde]);
    expect(covOf(r, "antigravity.ide")).toMatchObject({ status: "empty", files: 0 });
  });
});

describe("antigravity brain: plan artifacts", () => {
  test("both brain folders: one marker per artifact file, detail by its name; other files, folders and hidden entries ignored; ids not UUID-shaped hashed", async () => {
    const a = agId("ba");
    writeBrain(h, IDE_BRAIN_REL, a, ["task.md", "walkthrough.md", "notes.md", "task.md.resolved"]);
    writeBrain(h, CLI_BRAIN_REL, I2, ["implementation_plan.md", path.join(".system_generated", "logs", "transcript.jsonl")]);
    writeBrain(h, CLI_BRAIN_REL, "not-a-uuid", ["task.md"]);
    mkdirSync(path.join(h.env.home, IDE_BRAIN_REL, agId("dir"), "walkthrough.md"), { recursive: true });
    writeBrain(h, IDE_BRAIN_REL, ".hidden", ["task.md"]);
    const old = new Date(fixtureStart(10));
    utimesSync(path.join(h.env.home, IDE_BRAIN_REL, a, "task.md"), old, old);
    const r = await run([agBrain]);
    expect(r.store.all("marker").map((m) => [m.sessionId, m.kind, m.detail]).sort()).toEqual([
      [sidOf(a), "plan-artifact", "task"], [sidOf(a), "plan-artifact", "walkthrough"], [sidOf(I2), "plan-artifact", "implementation_plan"],
      [sidOf(keyedHash(r.salt, "not-a-uuid")), "plan-artifact", "task"],
    ].sort());
    expect(r.store.all("marker").find((m) => m.sessionId === sidOf(a) && m.detail === "task")!.ts).toBe(old.getTime());
    expect(r.store.all("marker").every((m) => m.proxyTs === true)).toBe(true); // a file's mtime is never activity
    expect(r.coverage.map((c) => [c.source, c.status, c.records])).toEqual([["antigravity.brain", "ok", 2], ["antigravity.brain", "ok", 2]]);
    expectNoCanaries([...allEvents(r), r.coverage]);
  });

  test.skipIf(skipChmod)("artifacts are never opened: an unreadable one still counts", async () => {
    const [file] = writeBrain(h, IDE_BRAIN_REL, I1, ["task.md"]);
    chmodSync(file!, 0o000);
    try {
      const r = await run([agBrain]);
      expect(r.store.all("marker").map((m) => m.detail)).toEqual(["task"]);
    } finally {
      chmodSync(file!, 0o644);
    }
  });

  test("a brain folder without artifacts: empty; none: absent", async () => {
    let r = await run([agBrain]);
    expect(covOf(r, "antigravity.brain").status).toBe("absent");
    writeBrain(h, CLI_BRAIN_REL, I1, [path.join("scratch", "x.txt")]);
    r = await run([agBrain]);
    expect(covOf(r, "antigravity.brain")).toMatchObject({ status: "empty", records: 0 });
  });
});

describe("antigravity plugins", () => {
  test("TRAJ_FIELDS: the program's CascadeTrajectorySummary field numbers (trajectory_id, step_count, created_time, last_modified_time, workspaces)", () => {
    expect(TRAJ_FIELDS).toEqual({ id: 4, steps: 2, created: 7, updated: 3, workspace: 9 });
  });

  test("ids, tiers and beta flags; registered; what is never read", () => {
    expect(ALL.map((p) => [p.tool, p.id, p.tier, p.beta])).toEqual([
      ["antigravity", "antigravity.cli", "P0", false], ["antigravity", "antigravity.ide", "P0", false], ["antigravity", "antigravity.brain", "P0", false],
    ]);
    for (const p of ALL) expect(registry).toContain(p);
    const never = ALL.flatMap((p) => p.describe.neverReads).join("\n");
    for (const name of ["antigravityUnifiedStateSync.oauthToken", "antigravityAuthStatus", "title", "preview", "raw_summary"]) expect(never).toContain(name);
  });

  test("the CLI and brain folders in every home (WSL homes included); the IDE app folders of the scanning user", () => {
    const other = path.join(h.root, "wsl-home");
    mkdirSync(path.join(other, ".gemini", "antigravity-cli", "brain"), { recursive: true });
    mkdirSync(path.join(h.env.home, CLI_REL), { recursive: true });
    mkdirSync(path.join(h.env.home, IDE_BRAIN_REL), { recursive: true });
    expect(agCli.locate(h.env, [h.env.home, other]).map((c) => [c.root, c.wsl])).toEqual([
      [path.join(h.env.home, CLI_REL), false], [path.join(other, ".gemini", "antigravity-cli"), true],
    ]);
    expect(agBrain.locate(h.env, [h.env.home, other]).map((c) => [c.root, c.wsl])).toEqual([
      [path.join(h.env.home, IDE_BRAIN_REL), false], [path.join(other, ".gemini", "antigravity-cli", "brain"), true],
    ]);
    for (const app of ["Antigravity", "Antigravity IDE"]) mkdirSync(vscodeUser(h.env, app), { recursive: true });
    expect(agIde.locate(h.env, [h.env.home, other]).map((c) => c.root)).toEqual([vscodeUser(h.env, "Antigravity"), vscodeUser(h.env, "Antigravity IDE")]);
  });
});
