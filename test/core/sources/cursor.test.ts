import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import path from "node:path";
import { detectEnv } from "../../../core/env/env";
import { __observeQueries, MAX_COPY_BYTES } from "../../../core/io/sqlite";
import type { Ev, ToolEv } from "../../../core/model/events";
import { scan } from "../../../core/scan";
import { cuAgentCli, cuIde, cuTracking, cursorUserRoot } from "../../../core/sources/cursor";
import { LEGACY_KEYS } from "../../../core/sources/cursor/itemtable";
import { registry } from "../../../core/sources/registry";
import type { SourcePlugin } from "../../../core/sources/types";
import { keyedHash } from "../../../core/text/hash";
import { classifyIntent } from "../../../core/text/intent";
import { CANARY, expectNoCanaries, findCanaries } from "../../kit/canary";
import { fakeHome, type FakeHome } from "../../kit/home";
import { fixtureStart, MIN } from "../../fixtures/claude-code";
import {
  A, AUTH_ITEMS, B, bubble, buildAgentCli, buildCursor, commitRow, composer, CU_GPT, CU_SONNET, cuSid, globalRel, KV_DDL, OTHER_KV,
  trackingRel, workspaceRel, writeAgentStore, writeStateDb, writeTracking, type Row, type ToolOpts,
} from "../../fixtures/cursor";

let h: FakeHome;
beforeEach(() => { h = fakeHome(); });
afterEach(() => {
  __observeQueries(undefined);
  h.cleanup();
});

const ALL = [cuIde, cuTracking, cuAgentCli];
const run = (plugins: SourcePlugin[] = ALL) => scan({ env: h.env, plugins });
type Result = Awaited<ReturnType<typeof run>>;
const KINDS = ["session", "prompt", "tool", "turn", "marker", "usage", "totals", "commit", "file", "daily", "edge"] as const;
const allEvents = (r: Result) => KINDS.flatMap((k) => [...r.store.all(k)] as Ev[]);
const covOf = (r: Result, source: string) => r.coverage.find((c) => c.source === source)!;
const sidOf = (raw: string) => `cursor:${raw}`;
const toolsOf = (r: Result, raw: string): readonly ToolEv[] => r.store.forSession(sidOf(raw), "tool");
const observe = () => {
  const sql: string[] = [];
  __observeQueries((s) => sql.push(s));
  return sql;
};

/**
 * JSON paths the IDE reader may extract from a `cursorDiskKV` value, written out here independently of the reader:
 * composer and bubble fields, and inside a tool's params/rawArgs/result only the command, target file, MCP server and exit code.
 */
const KV_PATHS = new Set([
  "$.createdAt", "$.lastUpdatedAt", "$.isAgentic", "$.unifiedMode", "$.modelConfig.modelName", "$.subagentInfo", "$.subagentInfo.toolCallId",
  "$.subComposerIds", "$.subagentComposerIds", "$.fullConversationHeadersOnly", "$.conversation",
  "$.type", "$.text", "$.modelInfo.modelName", "$.thinkingDurationMs", "$.errorDetails", "$.toolFormerData", "$.toolFormerData.name",
  "$.toolFormerData.tool", "$.toolFormerData.status", "$.toolFormerData.userDecision", "$.toolFormerData.toolCallId",
  "$.toolFormerData.params", "$.toolFormerData.rawArgs", "$.toolFormerData.result",
  "$.command", "$.targetFile", "$.target_file", "$.relativeWorkspacePath", "$.relative_workspace_path", "$.filePath", "$.file_path", "$.path",
  "$.server", "$.exitCodeV2", "$.exitCode",
]);
/** Result columns that may carry trace text into memory: the user's message, the call id (hashed), the command, file path and MCP server (parsed). */
const IN_MEMORY = new Set(["text", "tcall", "cmd", "target", "server"]);
const kvQueries = (sql: string[]) => sql.filter((s) => /\bFROM cursorDiskKV\b/.test(s));

/** Runs each captured cursorDiskKV page query against the store itself and returns every row it yields. */
function rowsOf(file: string, sql: string[]): Record<string, unknown>[] {
  const db = new Database(file, { readonly: true });
  try {
    return [...new Set(kvQueries(sql))].flatMap((s) => db.query(s).all(Number.MIN_SAFE_INTEGER, 1_000_000) as Record<string, unknown>[]);
  } finally {
    db.close();
  }
}

/** A tool bubble of composer `c` at `ts`. */
const toolRow = (c: string, label: string, ts: number, tool: ToolOpts, extra: Partial<Parameters<typeof bubble>[1]> = {}): Row =>
  [`bubbleId:${c}:${cuSid(label)}`, bubble(cuSid(label), { type: 2, ts, tool, ...extra })];
const userRow = (c: string, label: string, ts: number | undefined, text: string): Row => [`bubbleId:${c}:${cuSid(label)}`, bubble(cuSid(label), { type: 1, ts, text })];
const composerRow = (id: string, o: Parameters<typeof composer>[1] = {}): Row => [`composerData:${id}`, composer(id, o)];

describe("cursor: Task 14 scenario", () => {
  test("sessions, prompts, tests, denial, error, thinking turn, commits; prefix-paged SQL that never touches ItemTable; no canaries", async () => {
    const fx = buildCursor(h);
    const sql = observe();
    const r = await run();
    __observeQueries(undefined);

    expect(sql.length).toBeGreaterThan(0);
    for (const s of sql) {
      expect(s).not.toContain("*");
      expect(s).not.toMatch(/ItemTable/i);
    }
    const kv = kvQueries(sql);
    expect(kv.length).toBeGreaterThanOrEqual(2);
    for (const s of kv) {
      expect(s).toMatch(/WHERE key LIKE '(composerData|bubbleId):%' AND rowid > \? ORDER BY rowid LIMIT \?/);
      for (const [p] of s.matchAll(/'\$[^']*'/g)) expect(KV_PATHS).toContain(p.slice(1, -1));
    }
    // what leaves SQLite: only allowlisted scalars; the message text only for user bubbles
    const rows = rowsOf(fx.globalFile, sql);
    expect(rows.length).toBe(8);
    for (const row of rows) {
      for (const [col, v] of Object.entries(row)) if (!IN_MEMORY.has(col)) expect([col, findCanaries(v)]).toEqual([col, []]);
      if (row.text != null) expect(row.type).toBe(1);
      expect(Object.keys(row)).not.toContain("v");
      expect(Object.keys(row)).not.toContain("value");
    }

    const sessions = r.store.all("session");
    expect(sessions.map((s) => s.id).sort()).toEqual([sidOf(A), sidOf(B)].sort());
    expect(r.store.session(sidOf(A))!.surface).toBe("agent");
    expect(r.store.session(sidOf(B))!.surface).toBe("chat");
    const prompts = r.store.all("prompt");
    expect(prompts).toHaveLength(3);
    expect(prompts.every((p) => p.origin === "human" && p.window === "detail")).toBe(true);
    const tools = r.store.all("tool");
    expect(tools).toHaveLength(3);
    expect(tools.every((t) => t.category === "test" && JSON.stringify(t.checks) === JSON.stringify(["test"]))).toBe(true);
    expect(r.store.all("marker").filter((m) => m.kind === "denial")).toHaveLength(1);
    expect(r.store.all("marker").filter((m) => m.kind === "error")).toHaveLength(1);
    expect(r.store.all("turn").filter((t) => t.ms === 900)).toHaveLength(1);
    expect(r.store.all("commit")).toHaveLength(2);
    expect(covOf(r, "cursor.agent-cli").status).toBe("absent");
    expectNoCanaries([...allEvents(r), r.coverage, r.warnings]);
    expect(r.tempClean).toBe(true);
  });

  test("sessions: composer times, models from the composer's setting and the bubbles, agent surface", async () => {
    const fx = buildCursor(h);
    const r = await run([cuIde]);
    expect(r.store.session(sidOf(A))).toMatchObject({
      tool: "cursor", source: "cursor.ide", window: "detail", origin: "human", surface: "agent", start: fx.t0, end: fx.t0 + 9 * MIN,
      models: [CU_SONNET, CU_GPT],
    });
    expect(r.store.session(sidOf(B))).toMatchObject({ origin: "human", surface: "chat", start: fx.t0 + 19 * MIN, end: fx.t0 + 21 * MIN, models: [] });
    expect(r.store.session(sidOf(A))!.projectKey).toBeUndefined();
  });

  test("prompts: user bubbles, in memory only — intent, features, keyed hash, task start, similarity to the previous one", async () => {
    const fx = buildCursor(h);
    const r = await run([cuIde]);
    const prompts = [...r.store.all("prompt")].sort((a, b) => a.ts - b.ts);
    expect(prompts.map((p) => [p.sessionId, p.ts - fx.t0])).toEqual([[sidOf(A), MIN], [sidOf(A), 5 * MIN], [sidOf(B), 20 * MIN]]);
    expect(prompts.map((p) => p.intent)).toEqual(fx.texts.map(classifyIntent));
    expect(prompts.map((p) => p.textHash)).toEqual(fx.texts.map((t) => keyedHash(r.salt, t.trim())));
    expect(prompts.map((p) => p.features.isTaskStart)).toEqual([true, false, true]);
    expect(prompts.map((p) => p.features.simToPrev === undefined)).toEqual([true, false, true]);
    expect(prompts.every((p) => p.tool === "cursor" && p.source === "cursor.ide")).toBe(true);
  });

  test("tools, markers, turn: command checks, exit codes, decisions; denial and error markers; thinking time", async () => {
    const fx = buildCursor(h);
    const r = await run([cuIde]);
    const tools = [...toolsOf(r, A)].sort((a, b) => a.ts - b.ts);
    expect(tools.map((t) => [t.ts - fx.t0, t.name, t.category, t.checks, t.ok, t.exit])).toEqual([
      [2 * MIN, "run_terminal_cmd", "test", ["test"], true, 0],
      [3 * MIN, "run_terminal_cmd", "test", ["test"], false, 1],
      [6 * MIN, "run_terminal_cmd", "test", ["test"], false, undefined],
    ]);
    expect(tools[0]!.callId).toBe(keyedHash(r.salt, `call_t1_${CANARY.secret}`));
    expect(r.store.forSession(sidOf(A), "marker").map((m) => [m.kind, m.ts - fx.t0]).sort()).toEqual([["denial", 6 * MIN], ["error", 3 * MIN]]);
    expect(r.store.all("turn")).toEqual([
      { k: "turn", tool: "cursor", source: "cursor.ide", ts: fx.t0 + 2 * MIN, sessionId: sidOf(A), window: "detail", model: CU_GPT, ms: 900 },
    ]);
  });

  test("coverage: the store, its composer and bubble rows, the event span", async () => {
    const fx = buildCursor(h);
    const r = await run([cuIde]);
    expect(covOf(r, "cursor.ide")).toMatchObject({
      tool: "cursor", window: "detail", status: "ok", beta: false, files: 1, bytes: statSync(fx.globalFile).size, records: 8,
      skipped: {}, unknownTypes: {}, versions: [], from: fx.t0, to: fx.t0 + 21 * MIN,
    });
  });
});

describe("cursor ide: bubbles and tools", () => {
  const t0 = () => fixtureStart();

  test("tool names: built-ins by category, the edited file's extension, ids for unnamed tools, MCP with its server, anything else other", async () => {
    const c = cuSid("tools");
    const at = t0();
    let n = 0;
    const t = (tool: ToolOpts): Row => toolRow(c, `t${++n}`, at + n * 1_000, tool);
    writeStateDb(h, globalRel(h), [
      composerRow(c, { created: at, updated: at + MIN, agentic: true }),
      t({ name: "read_file", params: { targetFile: `${CANARY.path}/a.py` }, status: "completed" }),
      t({ name: "codebase_search", params: { query: CANARY.prompt } }),
      t({ name: "grep_search", params: { query: CANARY.prompt } }),
      t({ name: "file_search", params: { query: CANARY.prompt } }),
      t({ name: "list_dir", params: { relativeWorkspacePath: CANARY.path } }),
      t({ name: "edit_file", params: { targetFile: `${CANARY.path}/src/app.ts`, codeEdit: CANARY.code, instructions: CANARY.prompt }, status: "completed" }),
      t({ name: "search_replace", params: { file_path: "/w/x.go", old_string: CANARY.code, new_string: CANARY.code } }),
      t({ name: "edit_file_v2", rawArgs: { target_file: "/w/y.rs", code_edit: CANARY.code } }),
      t({ name: "write", params: { filePath: "/w/notes.md", content: CANARY.code } }),
      t({ name: "delete_file", params: { relative_workspace_path: "/w/old.css" } }),
      t({ name: "web_search", params: { searchTerm: CANARY.prompt } }),
      t({ name: "todo_write", params: { todos: [CANARY.prompt] } }),
      t({ name: "task_v2", params: { description: CANARY.prompt } }),
      t({ name: "create_plan", params: { plan: CANARY.prompt } }),
      t({ name: `${CANARY.project}_tool`, params: { x: CANARY.secret } }),
      t({ name: "edit_file_v3", tool: 38, params: { targetFile: "/w/z.kt" } }),
      t({ tool: 15, params: { command: "npm run build" } }),
      t({ name: `mcp_${CANARY.mcp}_lookup`, params: { server: CANARY.mcp, toolName: "lookup", arguments: { q: CANARY.secret } } }),
      t({ name: "call_mcp_tool", rawArgs: { server: CANARY.mcp, toolName: "search" } }),
      t({ name: "mcp-other-tool", params: { q: CANARY.secret } }),
      t({ name: "Shell", params: { command: "eslint ." } }),
      t({ name: "run_terminal_cmd", params: { explanation: CANARY.prompt }, rawArgs: { command: "cargo test" } }),
      t({ name: "edit_file", params: { targetFile: "/w/raw.py" }, raw: true }),
    ]);
    const r = await run([cuIde]);
    expect(toolsOf(r, c).map((x) => [x.name, x.category, x.checks, x.editExt, x.mcpServer])).toEqual([
      ["read_file", "read", undefined, undefined, undefined], ["codebase_search", "search", undefined, undefined, undefined],
      ["grep_search", "search", undefined, undefined, undefined], ["file_search", "search", undefined, undefined, undefined],
      ["list_dir", "read", undefined, undefined, undefined], ["edit_file", "edit", undefined, "ts", undefined],
      ["search_replace", "edit", undefined, "go", undefined], ["edit_file_v2", "edit", undefined, "rs", undefined],
      ["write", "write", undefined, "md", undefined], ["delete_file", "edit", undefined, "css", undefined],
      ["web_search", "web", undefined, undefined, undefined], ["todo_write", "todo", undefined, undefined, undefined],
      ["task_v2", "delegate", undefined, undefined, undefined], ["create_plan", "plan", undefined, undefined, undefined],
      ["other", "other", undefined, undefined, undefined], ["edit_file_v2", "edit", undefined, "kt", undefined],
      ["run_terminal_command_v2", "build", ["build"], undefined, undefined], ["mcp", "mcp", undefined, undefined, CANARY.mcp],
      ["mcp", "mcp", undefined, undefined, CANARY.mcp], ["mcp", "mcp", undefined, undefined, undefined],
      ["Shell", "lint", ["lint"], undefined, undefined], ["run_terminal_cmd", "test", ["test"], undefined, undefined],
      ["edit_file", "edit", undefined, "py", undefined],
    ]);
    expectNoCanaries([...allEvents(r), r.coverage], { allow: ["mcp"] });
  });

  test("ok: rejected or failed tools are not ok; a completed tool is; an exit code decides for commands; running tools have no outcome", async () => {
    const c = cuSid("ok");
    const at = t0();
    let n = 0;
    const t = (tool: ToolOpts): Row => toolRow(c, `o${++n}`, at + n * 1_000, tool);
    const cmd = (result?: unknown, status?: string, decision?: string): ToolOpts => ({ name: "run_terminal_cmd", params: { command: "make test" }, result, status, decision });
    writeStateDb(h, globalRel(h), [
      composerRow(c, { created: at, updated: at + MIN }),
      t({ name: "read_file", status: "completed" }), t({ name: "read_file", status: "error" }), t({ name: "read_file", status: "cancelled" }),
      t({ name: "read_file", status: "running" }), t({ name: "read_file" }), t({ name: "read_file", status: "completed", decision: "rejected" }),
      t(cmd({ output: CANARY.secret, exitCodeV2: 0 }, "completed")), t(cmd({ output: CANARY.secret, exitCode: 2 }, "completed")),
      t(cmd({ output: CANARY.secret }, "completed")), t(cmd({ output: CANARY.secret, exitCodeV2: 0, exitCode: 3 }, "completed")),
      t(cmd(`${CANARY.secret} not json`, "error")), t(cmd(undefined, undefined, "accepted")),
    ]);
    const r = await run([cuIde]);
    expect(toolsOf(r, c).map((x) => [x.ok, x.exit])).toEqual([
      [true, undefined], [false, undefined], [false, undefined], [undefined, undefined], [undefined, undefined], [false, undefined],
      [true, 0], [false, 2], [true, undefined], [true, 0], [false, undefined], [undefined, undefined],
    ]);
    expect(r.store.all("marker").map((m) => m.kind)).toEqual(["denial"]);
  });

  test("bubbles: times as ISO or epoch ms; without a time, unknown composer, invalid JSON or a blank message they are skipped and counted", async () => {
    const c = cuSid("edge");
    const at = t0();
    writeStateDb(h, globalRel(h), [
      composerRow(c, { created: at, updated: at + MIN }),
      userRow(c, "u1", at + 1_000, "First question about the parser"),
      [`bubbleId:${c}:${cuSid("u2")}`, { ...bubble(cuSid("u2"), { type: 1, text: "Second question" }), createdAt: at + 2_000 }],
      userRow(c, "u3", undefined, `${CANARY.prompt} without a time`),
      userRow(c, "u4", at + 4_000, "   "),
      userRow(cuSid("gone"), "u5", at + 5_000, `${CANARY.prompt} of a deleted chat`),
      [`bubbleId:${c}:${cuSid("u6")}`, `{"type": 1, "text": "${CANARY.prompt}`],
      [`bubbleId:${c}:${cuSid("u7")}`, new TextEncoder().encode(JSON.stringify(bubble(cuSid("u7"), { type: 1, ts: at + 7_000, text: "Third, stored as a blob" })))],
      [`bubbleId:${c}`, bubble("x", { type: 1, ts: at, text: CANARY.prompt })],
      [`bubbleId:${c}:${cuSid("t9")}`, bubble(cuSid("t9"), { type: 3, ts: at + 9_000 })],
      [`bubbleId:${c}:${cuSid("t10")}`, bubble(cuSid("t10"), { type: "user" as unknown as number, ts: at + 9_000 })],
    ]);
    const r = await run([cuIde]);
    expect(r.store.forSession(sidOf(c), "prompt").map((p) => p.ts - at)).toEqual([1_000, 2_000, 7_000]);
    const cov = covOf(r, "cursor.ide");
    expect(cov.skipped).toEqual({ "no-ts": 1, empty: 1, orphan: 1, parse: 1, "bad-record": 1 });
    expect(cov.unknownTypes).toEqual({ "bubble-type:3": 1, "bubble-type:(other)": 1 });
    expect(cov.status).toBe("drift");
    expect(cov.records).toBe(1 + 10);
    expectNoCanaries([...allEvents(r), r.coverage, r.warnings]);
  });

  test("sessions: span widened by bubble times; ids not UUID-shaped are hashed; empty composers emit nothing; inline (old) conversations counted", async () => {
    const at = t0();
    const late = cuSid("late");
    const plain = "task-not-a-uuid";
    writeStateDb(h, globalRel(h), [
      composerRow(late, { created: at + MIN, updated: at + 2 * MIN, model: CANARY.path }),
      userRow(late, "l1", at, "Started before the composer says"),
      toolRow(late, "l2", at + 5 * MIN, { name: "read_file" }, { model: "gpt-5.1-codex" }),
      composerRow(plain, { created: at, updated: at }),
      userRow(plain, "p1", at, "A question in a composer with an odd id"),
      composerRow(cuSid("empty"), { created: at, updated: at }),
      composerRow(cuSid("notime"), { headers: [cuSid("n1")] }),
      composerRow(cuSid("old"), { created: at, updated: at + MIN, inline: [{ type: 1, text: CANARY.prompt, bubbleId: "b1" }, { type: 2, text: CANARY.code, bubbleId: "b2" }] }),
      composerRow(cuSid("bare")),
      userRow(cuSid("bare"), "b1", at + 3 * MIN, "Only the bubble has a time"),
    ]);
    const r = await run([cuIde]);
    expect(r.store.session(sidOf(late))).toMatchObject({ start: at, end: at + 5 * MIN, models: ["other", "gpt-5.1-codex"] });
    expect(r.store.session(sidOf(keyedHash(r.salt, plain)))).toMatchObject({ start: at, end: at });
    expect(r.store.session(sidOf(cuSid("empty")))).toBeUndefined();
    expect(r.store.session(sidOf(cuSid("notime")))).toBeUndefined();
    expect(r.store.session(sidOf(cuSid("old")))).toMatchObject({ start: at, end: at + MIN });
    expect(r.store.session(sidOf(cuSid("bare")))).toMatchObject({ start: at + 3 * MIN, end: at + 3 * MIN });
    expect(covOf(r, "cursor.ide").skipped).toEqual({ "empty-session": 1, "no-ts": 1, "inline-message": 2 });
    expectNoCanaries([...allEvents(r), r.coverage]);
  });

  test("subagents: origin subagent, no prompts of their own, parent from the parent's list; copies of one launch are read once", async () => {
    const at = t0();
    const parent = cuSid("par");
    const child = cuSid("kid");
    const copy = "task-0000-copy";
    const launch = { toolCallId: `call_launch_${CANARY.secret}`, forkedFromComposerId: parent };
    writeStateDb(h, globalRel(h), [
      composerRow(parent, { created: at, updated: at + 5 * MIN, agentic: true, subIds: [child], subagentIds: [copy] }),
      userRow(parent, "p1", at + MIN, "Explore the codebase with a subagent"),
      toolRow(parent, "p2", at + 2 * MIN, { name: "task_v2", params: { description: CANARY.prompt } }),
      composerRow(child, { created: at + 2 * MIN, updated: at + 3 * MIN, agentic: true, sub: launch }),
      userRow(child, "c1", at + 2 * MIN, `${CANARY.prompt} the brief the parent wrote`),
      toolRow(child, "c2", at + 150_000, { name: "read_file" }),
      composerRow(copy, { created: at + 2 * MIN, updated: at + 3 * MIN, agentic: true, sub: launch }),
      userRow(copy, "k1", at + 2 * MIN, `${CANARY.prompt} the brief again`),
      toolRow(copy, "k2", at + 150_000, { name: "read_file" }),
    ]);
    const r = await run([cuIde]);
    expect(r.store.all("session").map((s) => [s.id, s.origin, s.parentId]).sort()).toEqual([
      [sidOf(child), "subagent", sidOf(parent)], [sidOf(parent), "human", undefined],
    ]);
    expect(r.store.all("prompt").map((p) => p.sessionId)).toEqual([sidOf(parent)]);
    expect(r.store.all("tool").map((t) => [t.sessionId, t.category])).toEqual([[sidOf(parent), "delegate"], [sidOf(child), "read"]]);
    expect(covOf(r, "cursor.ide").skipped).toEqual({ duplicate: 3 });
    expectNoCanaries([...allEvents(r), r.coverage]);
  });

  test("only assistant bubbles make tool events; a thinking time of 0 is no turn", async () => {
    const c = cuSid("kinds");
    const at = t0();
    writeStateDb(h, globalRel(h), [
      composerRow(c, { created: at, updated: at + MIN }),
      [`bubbleId:${c}:${cuSid("u")}`, bubble(cuSid("u"), { type: 1, ts: at, text: "Run it", tool: { name: "run_terminal_cmd", params: { command: "pytest" } } })],
      toolRow(c, "z", at + 1_000, { name: "read_file" }, { thinkingMs: 0 }),
      toolRow(c, "t", at + 2_000, { name: "read_file" }, { thinkingMs: 1_250 }),
    ]);
    const r = await run([cuIde]);
    expect(toolsOf(r, c).map((t) => [t.name, t.ts - at])).toEqual([["read_file", 1_000], ["read_file", 2_000]]);
    expect(r.store.all("turn").map((t) => [t.ts - at, t.ms])).toEqual([[2_000, 1_250]]);
    expect(r.store.all("prompt")).toHaveLength(1);
  });

  test("bubbles are paged 2,000 rows at a time: every page is read", async () => {
    const c = cuSid("many");
    const at = t0();
    const rows: Row[] = [composerRow(c, { created: at, updated: at + MIN })];
    for (let i = 0; i < 4_500; i++) rows.push(toolRow(c, `m${i}`, at + i, { name: "read_file" }));
    writeStateDb(h, globalRel(h), rows);
    const sql = observe();
    const r = await run([cuIde]);
    __observeQueries(undefined);
    expect(toolsOf(r, c)).toHaveLength(4_500);
    expect(sql.filter((s) => s.includes("'bubbleId:%'"))).toHaveLength(3);
    expect(covOf(r, "cursor.ide").records).toBe(4_501);
  });

  test("a WAL store whose writer is gone is read in place, nothing written beside it", async () => {
    const at = t0();
    const file = writeStateDb(h, globalRel(h), [composerRow(A, { created: at, updated: at }), userRow(A, "w1", at, "Hello there")], [], { wal: true });
    // Apple's SQLite keeps empty -wal and -shm files on close; the stock build removes them, as Cursor's closed store has none
    rmSync(`${file}-wal`, { force: true });
    rmSync(`${file}-shm`, { force: true });
    const r = await run([cuIde]);
    expect(r.store.all("prompt")).toHaveLength(1);
    expect([existsSync(`${file}-wal`), existsSync(`${file}-shm`)]).toEqual([false, false]);
  });
});

describe("cursor ide: legacy ItemTable fallback", () => {
  const t0 = () => fixtureStart();
  const legacyItems = (at: number, tab: string, gens: Record<string, unknown>[]): Row[] => [
    ...AUTH_ITEMS,
    ["aiService.prompts", [{ text: CANARY.prompt, commandType: 4 }, { text: "Add a retry", commandType: 4 }]],
    ["aiService.generations", gens],
    ["composer.composerData", {
      allComposers: [
        { type: "head", composerId: cuSid("C"), name: CANARY.project, createdAt: at, lastUpdatedAt: at + 10 * MIN, unifiedMode: "agent", subtitle: CANARY.prompt },
        { type: "head", composerId: cuSid("D"), name: CANARY.project, createdAt: at, lastUpdatedAt: at, unifiedMode: "chat", isDraft: true },
        { composerId: cuSid("E"), createdAt: at + MIN, lastUpdatedAt: at + 2 * MIN, conversation: [{ type: 1, text: CANARY.prompt }] },
      ],
      selectedComposerIds: [cuSid("C")],
    }],
    ["workbench.panel.aichat.view.aichat.chatdata", {
      tabs: [{ tabId: tab, chatTitle: CANARY.project, lastSendTime: at + 30 * MIN, bubbles: [{ type: "user", text: CANARY.prompt }, { type: "ai", text: CANARY.code }] }],
    }],
    ["workbench.view.extensions.state", { secret: CANARY.secret }],
  ];
  const gen = (id: string, unixMs: unknown, text: Record<string, unknown>) => ({ generationUUID: id, unixMs, type: "composer", ...text });

  test("without cursorDiskKV: the four legacy keys, by exact key only; credentials never selected; sessions and timed prompts", async () => {
    const at = t0();
    const gens = [
      gen("g1", at + MIN, { textDescription: `Refactor the importer. ${CANARY.prompt}` }),
      gen("g2", at + 2 * MIN, { textDescription: "Now add tests for it" }),
      gen("g3", at + 50 * MIN, { text: "Explain the parser" }),
      gen("g4", undefined, { textDescription: "No time" }),
    ];
    writeStateDb(h, globalRel(h), [], legacyItems(at, cuSid("T1"), gens), { kv: false });
    // an old workspace store: the same generation again, one more, and another chat tab
    writeStateDb(h, workspaceRel(h, "w1"), [], [
      ["aiService.generations", [gens[0], gen("g5", at + 60 * MIN, { textDescription: "Rename the module" })]],
      ["workbench.panel.aichat.view.aichat.chatdata", { tabs: [{ tabId: cuSid("T2"), lastSendTime: at + 61 * MIN, bubbles: [{ type: "user", text: "Hi" }] }] }],
    ], { kv: false });
    const sql = observe();
    const r = await run([cuIde]);
    __observeQueries(undefined);

    const items = sql.filter((s) => /ItemTable/.test(s));
    expect(items.length).toBeGreaterThan(0);
    for (const s of sql) expect(s).not.toContain("*");
    for (const s of items) {
      expect(s).toMatch(/ FROM ItemTable WHERE key = \?$/);
      expect(s).not.toMatch(/LIKE|GLOB|cursorAuth/i);
    }
    expect([...LEGACY_KEYS]).toEqual(["aiService.prompts", "aiService.generations", "composer.composerData", "workbench.panel.aichat.view.aichat.chatdata"]);

    const prompts = [...r.store.all("prompt")].sort((a, b) => a.ts - b.ts);
    expect(prompts.map((p) => [p.ts - at, p.origin, p.window, p.sessionId])).toEqual([
      [MIN, "human", "detail", undefined], [2 * MIN, "human", "detail", undefined], [50 * MIN, "human", "detail", undefined], [60 * MIN, "human", "detail", undefined],
    ]);
    expect(prompts.map((p) => p.features.isTaskStart)).toEqual([true, false, true, true]);
    expect(prompts[1]!.textHash).toBe(keyedHash(r.salt, "Now add tests for it"));
    expect(r.store.all("session").map((s) => [s.id, s.surface, s.start - at, s.end - at]).sort()).toEqual([
      [sidOf(cuSid("C")), "agent", 0, 10 * MIN], [sidOf(cuSid("E")), "chat", MIN, 2 * MIN],
      [sidOf(cuSid("T1")), "chat", 30 * MIN, 30 * MIN], [sidOf(cuSid("T2")), "chat", 61 * MIN, 61 * MIN],
    ].sort());
    const cov = covOf(r, "cursor.ide");
    expect(cov).toMatchObject({ status: "ok", files: 2, records: 4 + 2 });
    expect(cov.skipped).toEqual({ duplicate: 1, "no-ts": 1, draft: 1, "inline-message": 4 });
    expectNoCanaries([...allEvents(r), r.coverage, r.warnings]);
  });

  test("cursorDiskKV without composers also falls back; with composers, no ItemTable is ever queried, workspace stores included", async () => {
    const at = t0();
    writeStateDb(h, globalRel(h), OTHER_KV, legacyItems(at, cuSid("T1"), [gen("g1", at, { textDescription: "Hello" })]));
    let sql = observe();
    let r = await run([cuIde]);
    __observeQueries(undefined);
    expect(sql.some((s) => /ItemTable/.test(s))).toBe(true);
    expect(r.store.all("prompt")).toHaveLength(1);
    expect(r.store.all("session").length).toBeGreaterThan(0);

    h.cleanup();
    h = fakeHome();
    writeStateDb(h, globalRel(h), [composerRow(A, { created: at, updated: at }), userRow(A, "x", at, "Hello")], legacyItems(at, cuSid("T1"), []));
    writeStateDb(h, workspaceRel(h, "w1"), [], legacyItems(at, cuSid("T2"), [gen("g9", at, { textDescription: "Old" })]), { kv: false });
    sql = observe();
    r = await run([cuIde]);
    __observeQueries(undefined);
    expect(sql.some((s) => /ItemTable/.test(s))).toBe(false);
    expect(r.store.all("session").map((s) => s.id)).toEqual([sidOf(A)]);
    expect(covOf(r, "cursor.ide").files).toBe(1);
  });

  test("a legacy value over 64 MiB is never loaded: too-large; one of exactly the cap is read", async () => {
    const CAP = 64 * 1024 * 1024;
    const at = t0();
    const padded = (size: number, text: string) => {
      const json = JSON.stringify([{ generationUUID: text, unixMs: at, textDescription: text }]);
      return json + " ".repeat(size - Buffer.byteLength(json)); // trailing spaces keep it valid JSON
    };
    writeStateDb(h, globalRel(h), [], [["aiService.generations", padded(CAP, "At the cap")]], { kv: false });
    writeStateDb(h, workspaceRel(h, "w1"), [], [["aiService.generations", padded(CAP + 1, "Over the cap")]], { kv: false });
    const r = await run([cuIde]);
    expect(r.store.all("prompt").map((p) => p.textHash)).toEqual([keyedHash(r.salt, "At the cap")]);
    expect(covOf(r, "cursor.ide")).toMatchObject({ note: "too-large", skipped: { "too-large": 1 }, files: 2, records: 2 });
    expect(r.warnings.some((w) => w.code === "too-large" && w.source === "cursor.ide")).toBe(true);
  });

  test("legacy values of the wrong shape are drift; unparsable ones are counted", async () => {
    writeStateDb(h, globalRel(h), [], [
      ["aiService.generations", { not: "a list" }], ["composer.composerData", "not json {"],
      ["workbench.panel.aichat.view.aichat.chatdata", { tabs: "nope" }],
    ], { kv: false });
    const r = await run([cuIde]);
    const cov = covOf(r, "cursor.ide");
    expect(cov.unknownTypes).toEqual({ "aiService.generations:shape": 1, "workbench.panel.aichat.view.aichat.chatdata:shape": 1 });
    expect(cov.skipped).toEqual({ parse: 1 });
    expect(allEvents(r)).toEqual([]);
  });
});

describe("cursor ide: stores that cannot be read", () => {
  const t0 = () => fixtureStart();

  test("a WITHOUT ROWID cursorDiskKV cannot be paged: drift table-unreadable, never paged, no legacy fallback", async () => {
    writeStateDb(h, globalRel(h), [composerRow(A, { created: t0(), updated: t0() })], AUTH_ITEMS,
      { kvDdl: "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID" });
    const sql = observe();
    const r = await run([cuIde]);
    __observeQueries(undefined);
    expect(kvQueries(sql)).toEqual([]);
    expect(sql.some((s) => /ItemTable/.test(s))).toBe(false);
    const cov = covOf(r, "cursor.ide");
    expect([cov.status, cov.skipped, cov.unknownTypes]).toEqual(["drift", {}, { "table-unreadable:cursorDiskKV": 1 }]);
    expect(r.warnings.some((w) => w.code === "drift" && w.source === "cursor.ide")).toBe(true);
  });

  test("a first page that fails for good is drift table-unreadable; a busy page is an io-error; neither falls back to ItemTable", async () => {
    const at = t0();
    writeStateDb(h, globalRel(h), [composerRow(A, { created: at, updated: at }), userRow(A, "x", at, "Hello")], AUTH_ITEMS);
    __observeQueries((s) => { if (s.includes("'composerData:%'")) throw new Error("no such function: json_valid"); });
    let r = await run([cuIde]);
    __observeQueries(undefined);
    let cov = covOf(r, "cursor.ide");
    expect([cov.status, cov.skipped, cov.unknownTypes]).toEqual(["drift", {}, { "table-unreadable:cursorDiskKV": 1 }]);
    expect(allEvents(r)).toEqual([]);

    const sql: string[] = [];
    __observeQueries((s) => {
      sql.push(s);
      if (s.includes("'bubbleId:%'")) throw new Error("database is locked");
    });
    r = await run([cuIde]);
    __observeQueries(undefined);
    cov = covOf(r, "cursor.ide");
    expect([cov.status, cov.skipped, cov.unknownTypes]).toEqual(["ok", { "io-error": 1 }, {}]);
    expect(r.store.all("session").map((s) => s.id)).toEqual([sidOf(A)]);
    expect(sql.some((s) => /ItemTable/.test(s))).toBe(false);
  });

  test("cursorDiskKV without its value column is drift; nothing is read from it", async () => {
    h.sqlite(globalRel(h), ["CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, data BLOB)"], { cursorDiskKV: [[`composerData:${A}`, "{}"]] });
    const r = await run([cuIde]);
    const cov = covOf(r, "cursor.ide");
    expect([cov.status, cov.unknownTypes]).toEqual(["drift", { "missing-column:value": 1 }]);
    expect(allEvents(r)).toEqual([]);
  });

  test("a store that is not a database is an error of the source; a store beside it still counts", async () => {
    h.write(globalRel(h), "not a database");
    let r = await run([cuIde]);
    expect(r.coverage).toEqual([expect.objectContaining({ source: "cursor.ide", status: "error" })]);
    expect(r.warnings).toEqual([expect.objectContaining({ code: "error", source: "cursor.ide" })]);
    h.cleanup();
    h = fakeHome();
    writeStateDb(h, workspaceRel(h, "w1"), [], [["aiService.generations", [{ generationUUID: "g", unixMs: t0(), textDescription: "Hi" }]]], { kv: false });
    h.write(workspaceRel(h, "w2"), "not a database either");
    r = await run([cuIde]);
    expect(covOf(r, "cursor.ide")).toMatchObject({ status: "ok", files: 1, skipped: { "io-error": 1 } });
  });

  test.skipIf(process.platform === "win32")("a locked store above MAX_COPY_BYTES is never copied: too-large note and warning", async () => {
    const at = t0();
    const file = writeStateDb(h, globalRel(h), [composerRow(A, { created: at, updated: at }), userRow(A, "x", at, "Hello")]);
    truncateSync(file, MAX_COPY_BYTES + 1); // sparse: SQLite reads only the pages its header counts
    const lock = new Database(file);
    lock.exec("BEGIN EXCLUSIVE");
    let r: Result;
    try {
      r = await run([cuIde]);
    } finally {
      lock.exec("ROLLBACK");
      lock.close();
    }
    const cov = covOf(r, "cursor.ide");
    expect(cov).toMatchObject({ status: "empty", note: "too-large", files: 0, skipped: { "too-large": 1 } });
    expect(r.warnings).toEqual([expect.objectContaining({ code: "too-large", source: "cursor.ide" })]);
    expect(r.tempClean).toBe(true);
    expect(allEvents(r)).toEqual([]);
  });

  test("no Cursor user folder: absent; a user folder without stores: empty", async () => {
    let r = await run([cuIde]);
    expect(covOf(r, "cursor.ide").status).toBe("absent");
    mkdirSync(path.join(h.env.home, path.dirname(globalRel(h))), { recursive: true });
    r = await run([cuIde]);
    expect(covOf(r, "cursor.ide")).toMatchObject({ status: "empty", files: 0, records: 0 });
  });
});

describe("cursor tracking (ai-code-tracking.db)", () => {
  const t0 = () => fixtureStart();
  const TRACK_COLUMNS = ["commitHash", "commitDate", "scoredAt", "tabLinesAdded", "composerLinesAdded", "humanLinesAdded", "rowid", "rid"];

  test("scored commits: commit time, AI and human lines; allowlisted columns only, rowid-paged; no canaries", async () => {
    const fx = buildCursor(h);
    const sql = observe();
    const r = await run([cuTracking]);
    __observeQueries(undefined);
    expect([...r.store.all("commit")].sort((a, b) => a.ts - b.ts)).toEqual([
      { k: "commit", tool: "cursor", source: "cursor.tracking", ts: fx.t0 + 30 * MIN, aiLines: 40, humanLines: 5 },
      { k: "commit", tool: "cursor", source: "cursor.tracking", ts: fx.t0 + 40 * MIN, aiLines: 12, humanLines: 40 },
    ]);
    const selects = sql.filter((s) => /\bFROM "scored_commits"/.test(s));
    expect(selects.length).toBe(1);
    for (const s of selects) {
      expect(s).toMatch(/WHERE rowid > \? ORDER BY rowid LIMIT \?$/);
      const names = [...s.matchAll(/"([^"]+)"/g)].map((m) => m[1]!).filter((x) => x !== "scored_commits");
      for (const n of names) expect(TRACK_COLUMNS).toContain(n);
      expect(s).not.toMatch(/commitMessage|branchName|ai_code_hashes|conversation_summaries|tracked_file_content|\*/);
    }
    expect(covOf(r, "cursor.tracking")).toMatchObject({
      status: "ok", window: "lifetime", files: 1, bytes: statSync(fx.trackingFile).size, records: 2, from: fx.t0 + 30 * MIN, to: fx.t0 + 40 * MIN,
    });
    expectNoCanaries([...allEvents(r), r.coverage, r.warnings]);
  });

  test("time from commitDate, else scoredAt; a commit scored on two branches counts once; null lines stay unknown", async () => {
    const at = t0();
    writeTracking(h, [
      commitRow({ hash: "aaaa", branch: "main", date: "not a date", scored: at, tab: null, composer: null, human: null }),
      commitRow({ hash: "aaaa", branch: "feature", date: new Date(at).toISOString(), scored: at, tab: 1, composer: 1, human: 1 }),
      commitRow({ hash: "bbbb", date: null, scored: null, tab: 3, composer: 4, human: 5 }),
      commitRow({ hash: "cccc", date: String(Math.floor((at + MIN) / 1000)), tab: 7, composer: null, human: 0 }),
    ]);
    const r = await run([cuTracking]);
    expect([...r.store.all("commit")].map((c) => [c.ts - at, c.aiLines, c.humanLines])).toEqual([[0, undefined, undefined], [MIN, 7, 0]]);
    expect(covOf(r, "cursor.tracking").skipped).toEqual({ duplicate: 1, "no-ts": 1 });
  });

  test("schema drift: a missing table or column is drift; a store without scored_commits reads nothing", async () => {
    writeTracking(h, [], { ddl: "CREATE TABLE scored_commits (commitHash TEXT, scoredAt INTEGER, tabLinesAdded INTEGER)" });
    let r = await run([cuTracking]);
    expect(covOf(r, "cursor.tracking").unknownTypes).toEqual({
      "missing-column:commitDate": 1, "missing-column:composerLinesAdded": 1, "missing-column:humanLinesAdded": 1,
    });
    h.cleanup();
    h = fakeHome();
    h.sqlite(trackingRel, ["CREATE TABLE tracking_state (key TEXT PRIMARY KEY, value TEXT)"]);
    r = await run([cuTracking]);
    expect(covOf(r, "cursor.tracking")).toMatchObject({ status: "drift", unknownTypes: { "missing-table:scored_commits": 1 }, records: 0 });
  });

  test("a tracking store that cannot be opened is an error; no tracking store: absent", async () => {
    let r = await run([cuTracking]);
    expect(covOf(r, "cursor.tracking").status).toBe("absent");
    h.write(trackingRel, "not a database");
    r = await run([cuTracking]);
    expect(r.coverage).toEqual([expect.objectContaining({ source: "cursor.tracking", status: "error" })]);
  });
});

describe("cursor agent CLI (beta: presence only)", () => {
  test("transcripts and chat stores are counted, never decoded: present-undecodable, beta, no events; meta never queried", async () => {
    const fx = buildAgentCli(h);
    const sql = observe();
    const r = await run([cuAgentCli]);
    __observeQueries(undefined);
    const cov = covOf(r, "cursor.agent-cli");
    expect(cov).toMatchObject({
      status: "present-undecodable", beta: true, window: "detail", files: 4, records: fx.lines + fx.blobs,
      bytes: fx.files.reduce((n, f) => n + statSync(f).size, 0), skipped: {}, unknownTypes: {},
    });
    expect(allEvents(r)).toEqual([]);
    for (const s of sql) expect(s).not.toMatch(/\bmeta\b|\*|\bdata\b/);
    expect(sql.some((s) => /FROM "blobs"/.test(s))).toBe(true);
    expect(r.warnings.some((w) => w.code === "beta")).toBe(false);
    expectNoCanaries([r.coverage, r.warnings]);
  });

  test("chat stores under ~/.config/cursor count too; a store without blobs is drift; an unreadable store an io-error", async () => {
    const xdg = path.relative(h.env.home, h.env.xdgConfig);
    writeAgentStore(h, path.join(xdg, "cursor", "chats", "abcd", cuSid("x"), "store.db"), 2);
    h.sqlite(path.join(".cursor", "chats", "abcd", cuSid("y"), "store.db"), ["CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)"]);
    h.write(path.join(".cursor", "chats", "abcd", cuSid("z"), "store.db"), "not a database");
    const r = await run([cuAgentCli]);
    expect(covOf(r, "cursor.agent-cli")).toMatchObject({
      status: "present-undecodable", files: 2, records: 2, skipped: { "io-error": 1 }, unknownTypes: { "missing-table:blobs": 1 },
    });
  });

  test("no transcripts and no chat stores: absent", async () => {
    mkdirSync(path.join(h.env.home, ".cursor", "projects", "p", "agent-tools"), { recursive: true });
    h.writeJson(path.join(".cursor", "cli-config.json"), { permissions: { allow: [CANARY.path] } });
    expect(cuAgentCli.locate(h.env, [h.env.home])).toEqual([]);
    const r = await run([cuAgentCli]);
    expect(covOf(r, "cursor.agent-cli").status).toBe("absent");
  });
});

describe("cursor plugins", () => {
  test("ids, tiers and beta flags; registered", () => {
    expect(ALL.map((p) => [p.tool, p.id, p.tier, p.beta])).toEqual([
      ["cursor", "cursor.ide", "P0", false], ["cursor", "cursor.tracking", "P0", false], ["cursor", "cursor.agent-cli", "P0", true],
    ]);
    for (const p of ALL) expect(registry).toContain(p);
    const never = ALL.flatMap((p) => p.describe.neverReads).join("\n");
    expect(never).toMatch(/cursorAuth/);
    expect(never).toMatch(/commitMessage/);
  });

  test("the Cursor user folder per platform", () => {
    expect(cursorUserRoot(detectEnv({ platform: "darwin", home: "/Users/jo", vars: {}, wslHomes: [] }))).toBe("/Users/jo/Library/Application Support/Cursor/User");
    expect(cursorUserRoot(detectEnv({ platform: "win32", home: "C:\\Users\\Jo Ann", appData: "C:\\Users\\Jo Ann\\AppData\\Roaming", vars: {}, wslHomes: [] })))
      .toBe("C:\\Users\\Jo Ann\\AppData\\Roaming\\Cursor\\User");
    expect(cursorUserRoot(detectEnv({ platform: "linux", home: "/home/jo", xdgConfig: "/home/jo/.config", vars: {}, wslHomes: [] }))).toBe("/home/jo/.config/Cursor/User");
  });

  test("tracking and agent CLI stores are found in every home (WSL homes included)", () => {
    const other = path.join(h.root, "wsl-home");
    mkdirSync(path.join(other, ".cursor", "ai-tracking"), { recursive: true });
    writeFileSync(path.join(other, ".cursor", "ai-tracking", "ai-code-tracking.db"), "");
    writeTracking(h, []);
    expect(cuTracking.locate(h.env, [h.env.home, other]).map((c) => [c.home, c.wsl])).toEqual([[h.env.home, false], [other, true]]);
  });
});
