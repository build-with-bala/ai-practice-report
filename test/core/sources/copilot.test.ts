import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, closeSync, mkdirSync, openSync, statSync, utimesSync, writeSync } from "node:fs";
import path from "node:path";
import { __observeQueries } from "../../../core/io/sqlite";
import type { Ev, ToolEv } from "../../../core/model/events";
import { scan } from "../../../core/scan";
import { cpCli, cpJetbrains, cpVscode } from "../../../core/sources/copilot";
import { copilotInstalled, installDirs } from "../../../core/sources/copilot/install";
import { replayJournal } from "../../../core/sources/copilot/journal";
import { uriToPath } from "../../../core/sources/common/uri";
import { registry } from "../../../core/sources/registry";
import type { SourcePlugin } from "../../../core/sources/types";
import { keyedHash, normalizePath } from "../../../core/text/hash";
import { classifyIntent } from "../../../core/text/intent";
import { detectEnv } from "../../../core/env/env";
import { CANARY, expectNoCanaries } from "../../kit/canary";
import { fakeHome, lockAboveCopyLimit, type FakeHome } from "../../kit/home";
import {
  buildCopilot, CliEvents, CP_EXT_VERSION, cpSid, editGroup, fileUrl, jetbrainsRel, markdown, MIN, request, S_J, S_L, sessionRoot, terminal, tool,
  userRel, writeSessionStore, type JournalRecord,
} from "../../fixtures/copilot";
import { fixtureStart } from "../../fixtures/claude-code";

let h: FakeHome;
beforeEach(() => { h = fakeHome(); });
afterEach(() => {
  __observeQueries(undefined);
  h.cleanup();
});

const ALL = [cpVscode, cpCli, cpJetbrains];
const run = (plugins: SourcePlugin[] = ALL) => scan({ env: h.env, plugins });
type Result = Awaited<ReturnType<typeof run>>;
const KINDS = ["session", "prompt", "tool", "turn", "marker", "usage", "totals", "file", "daily"] as const;
const allEvents = (r: Result) => KINDS.flatMap((k) => [...r.store.all(k)] as Ev[]);
const covOf = (r: Result, source: string, window: "detail" | "lifetime" = "detail") => r.coverage.find((c) => c.source === source && c.window === window)!;
const sidOf = (raw: string) => `copilot:${raw}`;
const user = () => userRel(h);
const chatDir = (ws: string) => path.join(user(), "workspaceStorage", ws, "chatSessions");
const writeLegacy = (ws: string, root: Record<string, unknown>, name = `${String(root.sessionId)}.json`) => h.writeJson(path.join(chatDir(ws), name), root);
const writeJournal = (ws: string, id: string, records: JournalRecord[]) => h.writeJsonl(path.join(chatDir(ws), `${id}.jsonl`), records);
const t0 = () => fixtureStart();
const toolsOf = (r: Result, id: string): readonly ToolEv[] => r.store.forSession(sidOf(id), "tool");

describe("replayJournal", () => {
  test("kind 0 sets the root, kind 1 sets a value at a path, kind 2 appends to the array at a path", () => {
    const root = replayJournal([
      { kind: 0, v: { a: 1, list: [{ x: 1 }], nested: { deep: { n: 0 } } } },
      { kind: 1, k: ["a"], v: 2 },
      { kind: 1, k: ["nested", "deep", "n"], v: 5 },
      { kind: 1, k: ["list", 0, "x"], v: 9 },
      { kind: 2, k: ["list"], v: [{ x: 2 }, { x: 3 }] },
      { kind: 2, k: ["fresh"], v: ["made"] },
    ]);
    expect(root).toEqual({ a: 2, list: [{ x: 9 }, { x: 2 }, { x: 3 }], nested: { deep: { n: 5 } }, fresh: ["made"] });
  });

  test("a later kind 0 replaces the root; kind 3 deletes; kind 2 with `i` truncates the array first", () => {
    const root = replayJournal([
      { kind: 0, v: { old: true } },
      { kind: 0, v: { list: [1, 2, 3, 4], keep: 1, drop: 2 } },
      { kind: 2, k: ["list"], v: [9], i: 2 },
      { kind: 3, k: ["drop"] },
    ]);
    expect(root).toEqual({ list: [1, 2, 9], keep: 1 });
    expect(replayJournal([{ kind: 0, v: { list: [1, 2, 3] } }, { kind: 2, k: ["list"], i: 1 }])).toEqual({ list: [1] });
  });

  test("an empty path is ignored, like VS Code's own reader", () => {
    expect(replayJournal([{ kind: 0, v: { a: 1 } }, { kind: 1, k: [], v: { b: 2 } }])).toEqual({ a: 1 });
  });

  test("unknown kinds are drift; malformed records and paths are bad records; replay continues", () => {
    const issues: string[] = [];
    const root = replayJournal([
      { kind: 1, k: ["a"], v: 0 }, // before any initial entry
      { kind: 0, v: { a: 1, list: [] } },
      { kind: 7, k: ["a"], v: 3 },
      { kind: "x" },
      "not an object",
      { kind: 1, k: "a", v: 4 },
      { kind: 1, k: ["missing", "deeper"], v: 4 },
      { kind: 1, k: ["a", true], v: 4 },
      { kind: 2, k: ["a"], v: [1] }, // not an array
      { kind: 2, k: ["list"], v: "nope" },
      { kind: 1, k: ["a"], v: 5 },
    ], (key) => issues.push(key));
    expect(root).toEqual({ a: 5, list: [] });
    expect(issues).toEqual(["bad-record", "journal-kind:7", "journal-kind:(other)", "bad-record", "bad-record", "bad-record", "bad-record", "bad-record", "bad-record"]);
  });

  test("prototype keys are never walked or written", () => {
    const issues: string[] = [];
    replayJournal([
      { kind: 0, v: { a: {} } },
      { kind: 1, k: ["__proto__", "polluted"], v: true },
      { kind: 1, k: ["a", "constructor", "prototype", "polluted"], v: true },
      { kind: 2, k: ["constructor"], v: [1] },
    ], (key) => issues.push(key));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(issues).toEqual(["bad-record", "bad-record", "bad-record"]);
  });

  test("array paths stay inside the array: huge indices, string indices and `length` are bad records, rejected at once", () => {
    const issues: string[] = [];
    const started = performance.now();
    const root = replayJournal([
      { kind: 0, v: { requests: [{ a: 1 }], o: {} } },
      { kind: 1, k: ["requests", 4294967294], v: {} }, // would make a sparse array of ~4e9 holes
      { kind: 1, k: ["requests", "length"], v: 4294967295 }, // likewise, through `length`
      { kind: 1, k: ["requests", "0"], v: {} }, // a string index on an array
      { kind: 2, k: ["requests", 7], v: [1] }, // a push that creates an array past the end
      { kind: 2, k: ["requests"], v: [{ b: 2 }], i: 5 }, // truncation past the length
      { kind: 3, k: ["requests", 1] }, // a delete past the end
      { kind: 1, k: ["requests", 1], v: { c: 3 } }, // index == length appends
      { kind: 1, k: ["o", "length"], v: 7 }, // on an object, `length` is a plain key
    ], (key) => issues.push(key));
    expect(issues).toEqual(Array(6).fill("bad-record"));
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(root).toStrictEqual({ requests: [{ a: 1 }, { c: 3 }], o: { length: 7 } });
  });

  test("kind 3 on an array index clears that item in place (as VS Code sets it undefined); the array keeps its length", () => {
    const issues: string[] = [];
    const root = replayJournal([{ kind: 0, v: { list: [1, 2, 3] } }, { kind: 3, k: ["list", 1] }, { kind: 3, k: ["list", 3] }], (key) => issues.push(key));
    expect(root).toStrictEqual({ list: [1, undefined, 3] });
    expect(issues).toEqual(["bad-record"]);
  });

  test("pure: the records passed in are not changed", () => {
    const records = [{ kind: 0, v: { list: [1] } }, { kind: 2, k: ["list"], v: [2] }, { kind: 1, k: ["x"], v: 1 }];
    const before = JSON.parse(JSON.stringify(records));
    replayJournal(records);
    expect(records).toEqual(before);
  });
});

describe("copilot vscode: Task 13 scenario", () => {
  test("journal replay, legacy dedupe, agent surface, tools, interrupt, model, JetBrains presence, no canaries", async () => {
    buildCopilot(h);
    const r = await run();
    const sessions = r.store.all("session");
    expect(sessions.map((s) => s.id).sort()).toEqual([sidOf(S_J), sidOf(S_L)].sort());
    expect(r.store.all("prompt")).toHaveLength(5);
    expect(r.store.session(sidOf(S_J))).toMatchObject({ surface: "vscode", mode: "agent" });
    expect(r.store.session(sidOf(S_L))).toMatchObject({ surface: "vscode", mode: "chat" });
    const tests = r.store.all("tool").filter((t) => t.checks?.includes("test"));
    expect(tests).toHaveLength(1);
    expect(tests[0]!.checks).toEqual(["test"]);
    const edits = r.store.all("tool").filter((t) => t.category === "edit");
    expect(edits).toHaveLength(1);
    expect(edits[0]!.editExt).toBe("py");
    expect(r.store.all("marker").filter((m) => m.kind === "interrupt")).toHaveLength(1);
    expect(r.store.session(sidOf(S_J))!.models).toContain("gpt-5.1");
    const jb = covOf(r, "copilot.jetbrains");
    expect(jb).toMatchObject({ status: "present-undecodable", beta: true, files: 1 });
    for (const p of ALL) for (const c of p.locate(h.env, [h.env.home])) expect(c.root).not.toMatch(/apps\.json|hosts\.json/);
    expectNoCanaries([...allEvents(r), r.coverage, r.warnings]);
  });

  test("the legacy copy of a journal session is skipped as a duplicate; coverage counts what was read", async () => {
    const fx = buildCopilot(h);
    const r = await run([cpVscode]);
    const c = covOf(r, "copilot.vscode");
    expect(c.skipped.duplicate).toBe(1);
    expect(c.status).toBe("ok");
    expect(c.window).toBe("detail");
    expect(c.versions).toEqual([CP_EXT_VERSION]);
    // journal (3 lines) + legacy session (1 document); files add the two workspace.json read (W3's copy is skipped unread)
    expect(c.records).toBe(4);
    expect(c.files).toBe(2 + 2);
    expect(c.from).toBe(fx.t0);
    expect(c.to).toBe(fx.t0 + 25 * MIN + 7_000);
    expect(r.store.forSession(sidOf(S_J), "prompt")).toHaveLength(3); // from the journal, not 3 + 3
  });

  test("a session copied into another workspace and continued there: the most recently written copy wins", async () => {
    const id = cpSid("moved");
    const at = t0();
    const reqs = [0, 1, 2].map((n) => request({ ts: at + n * MIN, text: `step ${n} of the migration` }));
    const stale = writeLegacy("a-old", sessionRoot(id, reqs.slice(0, 1), { created: at }));
    const live = writeLegacy("b-new", sessionRoot(id, reqs, { created: at }));
    utimesSync(stale, new Date(at + 5 * MIN), new Date(at + 5 * MIN));
    utimesSync(live, new Date(at + 9 * MIN), new Date(at + 9 * MIN));
    // and the same for journals: the newer one wins
    const jid = cpSid("movedj");
    const oldJ = writeJournal("a-old", jid, [{ kind: 0, v: sessionRoot(jid, reqs.slice(0, 2), { created: at }) }]);
    const newJ = writeJournal("b-new", jid, [{ kind: 0, v: sessionRoot(jid, reqs.slice(0, 1), { created: at }) }, { kind: 2, k: ["requests"], v: reqs.slice(1) }]);
    utimesSync(oldJ, new Date(at + 9 * MIN), new Date(at + 9 * MIN));
    utimesSync(newJ, new Date(at + 4 * MIN), new Date(at + 4 * MIN));
    const r = await run([cpVscode]);
    expect(r.store.forSession(sidOf(id), "prompt")).toHaveLength(3);
    expect(r.store.forSession(sidOf(jid), "prompt")).toHaveLength(2); // the journal written last, whatever its length
    expect(covOf(r, "copilot.vscode").skipped.duplicate).toBe(2);
  });

  test("sessions: models from each request (vendor prefix dropped), extension version, project from workspace.json, times", async () => {
    const fx = buildCopilot(h);
    const r = await run([cpVscode]);
    expect(r.store.session(sidOf(S_J))).toMatchObject({
      tool: "copilot", source: "copilot.vscode", window: "detail", origin: "human", surface: "vscode", mode: "agent", version: CP_EXT_VERSION,
      models: ["gpt-5.1", "claude-sonnet-5"], projectKey: keyedHash(r.salt, normalizePath(CANARY.path)), start: fx.t0, end: fx.t0 + 9 * MIN,
    });
    expect(r.cwds.get(keyedHash(r.salt, normalizePath(CANARY.path)))).toBeDefined();
    expect(r.store.session(sidOf(S_L))).toMatchObject({ surface: "vscode", mode: "chat", models: ["gpt-5.1"], projectKey: keyedHash(r.salt, normalizePath("/work/projB")) });
  });

  test("prompts: one per request, human, detail window, intent, keyed text hash, task start", async () => {
    const fx = buildCopilot(h);
    const r = await run([cpVscode]);
    const prompts = [...r.store.all("prompt")].sort((a, b) => a.ts - b.ts);
    expect(prompts.map((p) => [p.sessionId, p.ts - fx.t0])).toEqual([
      [sidOf(S_J), MIN], [sidOf(S_J), 5 * MIN], [sidOf(S_J), 9 * MIN], [sidOf(S_L), 20 * MIN], [sidOf(S_L), 25 * MIN],
    ]);
    expect(prompts.every((p) => p.origin === "human" && p.window === "detail" && p.tool === "copilot")).toBe(true);
    const texts = [
      `Refactor the importer so it rejects empty input. ${CANARY.prompt}`, "Run the tests and fix the failing one in app/main.py", "Why is the parser slow?",
      "What does the scheduler do?", "Add a retry with exponential backoff to the fetch helper",
    ];
    expect(prompts.map((p) => p.intent)).toEqual(texts.map(classifyIntent));
    expect(prompts.map((p) => p.textHash)).toEqual(texts.map((t) => keyedHash(r.salt, t)));
    expect(prompts[2]!.textHash).toBe(keyedHash(r.salt, "Why is the parser slow?"));
    expect(prompts.map((p) => p.features.isTaskStart)).toEqual([true, false, false, true, false]);
    expect(prompts[0]!.features.simToPrev).toBeUndefined();
    expect(prompts[1]!.features.simToPrev).toBeGreaterThanOrEqual(0);
  });

  test("tools: the terminal command is classified, with exit code and duration; the edit group gives the file extension", async () => {
    const fx = buildCopilot(h);
    const r = await run([cpVscode]);
    const tools = toolsOf(r, S_J);
    expect(tools).toHaveLength(2);
    expect(tools.find((t) => t.name === "run_in_terminal")).toMatchObject({ category: "test", checks: ["test"], toolchain: "js", ok: true, exit: 0, ms: 4_200 });
    expect(tools.find((t) => t.category === "edit")!.toolchain).toBeUndefined();
    expect(tools.find((t) => t.name === "run_in_terminal")!.callId).toBe(keyedHash(r.salt, `call_run_in_terminal_${CANARY.secret}`));
    expect(tools.find((t) => t.category === "edit")).toMatchObject({ name: "textEditGroup", editExt: "py" });
    expect(tools.every((t) => t.ts === fx.t0 + 5 * MIN)).toBe(true);
  });

  test("turns: duration from elapsedMs, else the result timings — never timeSpentWaiting; cancelled turns are interrupted", async () => {
    const fx = buildCopilot(h);
    const r = await run([cpVscode]);
    const turns = [...r.store.forSession(sidOf(S_J), "turn")].sort((a, b) => a.ts - b.ts);
    expect(turns.map((t) => [t.status, t.ms, t.model])).toEqual([
      ["completed", 9_000, "gpt-5.1"], ["completed", 41_000, "claude-sonnet-5"], ["interrupted", undefined, "gpt-5.1"],
    ]);
    expect(turns[1]!.ts).toBe(fx.t0 + 5 * MIN + 41_000); // modelState.completedAt
    expect(turns[0]!.ts).toBe(fx.t0 + MIN + 9_000);
    const marker = r.store.all("marker")[0]!;
    expect(marker).toMatchObject({ kind: "interrupt", sessionId: sidOf(S_J), ts: fx.t0 + 9 * MIN });
  });

  test("no event, coverage field or warning carries canary text; the OAuth files are never located", async () => {
    buildCopilot(h);
    const r = await run();
    expectNoCanaries([...allEvents(r), r.coverage, r.warnings]);
    const roots = ALL.flatMap((p) => p.locate(h.env, [h.env.home]).map((c) => c.root));
    expect(roots.some((x) => /apps\.json|hosts\.json/.test(x))).toBe(false);
  });
});

describe("copilot vscode: mapping rules", () => {
  test("agent mode: the editsAgent participant (full or bare id), a participant whose only mode is agent, or modeInfo.kind agent", async () => {
    const at = t0();
    const s = (label: string, extra: Partial<Parameters<typeof request>[0]>) => sessionRoot(cpSid(label), [request({ ts: at, ...extra })]);
    writeLegacy("w", s("bare", { agentId: "editsAgent" }));
    writeLegacy("w", s("full", { agentId: "github.copilot.editsAgent", modes: [] }));
    writeLegacy("w", s("modes", { agentId: "github.copilot.someAgent", modes: ["agent"] }));
    writeLegacy("w", s("info", { agentId: "github.copilot.default", extra: { modeInfo: { kind: "agent", isBuiltin: true, modeId: "agent" } } }));
    writeLegacy("w", s("ask", { agentId: "github.copilot.workspace", modes: ["ask", "edit", "agent"] }));
    writeLegacy("w", s("edit", { agentId: "github.copilot.editingSession", modes: ["edit"], extra: { modeInfo: { kind: "edit" } } }));
    const r = await run([cpVscode]);
    const mode = (label: string) => r.store.session(sidOf(cpSid(label)))!.mode;
    expect([mode("bare"), mode("full"), mode("modes"), mode("info"), mode("ask"), mode("edit")]).toEqual(["agent", "agent", "agent", "agent", "chat", "chat"]);
  });

  test("an edit tool claims the edit group that follows it: one edit event, extension from the group", async () => {
    const id = cpSid("claim");
    writeLegacy("w", sessionRoot(id, [request({
      ts: t0(), agentId: "github.copilot.editsAgent",
      parts: [tool("copilot_replaceString"), editGroup("/w/src/app.ts"), tool("copilot_readFile"), tool("copilot_createFile"), editGroup("/w/README.md")],
    })]));
    const r = await run([cpVscode]);
    expect(toolsOf(r, id).map((t) => [t.name, t.category, t.editExt])).toEqual([
      ["copilot_replaceString", "edit", "ts"], ["copilot_readFile", "read", undefined], ["copilot_createFile", "write", "md"],
    ]);
  });

  test("parallel edit tools claim their groups in order; extra groups of a multi-file edit add nothing", async () => {
    const id = cpSid("multi");
    writeLegacy("w", sessionRoot(id, [request({
      ts: t0(), agentId: "github.copilot.editsAgent",
      parts: [tool("copilot_applyPatch"), tool("copilot_insertEdit"), editGroup("/w/a.py"), editGroup("/w/b.go"), editGroup("/w/c.rs")],
    })]));
    const r = await run([cpVscode]);
    expect(toolsOf(r, id).map((t) => [t.name, t.editExt])).toEqual([["copilot_applyPatch", "py"], ["copilot_insertEdit", "go"]]);
  });

  test("an edit tool with no group takes the extension from its message; groups without an edit tool are edits of their own", async () => {
    const a = cpSid("msg");
    const b = cpSid("nogrp");
    writeLegacy("w", sessionRoot(a, [request({ ts: t0(), parts: [tool("vscode_editFile_internal", { messageUri: "/w/lib/util.kt" })] })]));
    writeLegacy("w", sessionRoot(b, [request({ ts: t0(), agentId: "github.copilot.editingSession", parts: [markdown("x"), editGroup("/w/x.css"), editGroup("/w/y.ipynb", "notebookEditGroup")] })]));
    const r = await run([cpVscode]);
    expect(toolsOf(r, a).map((t) => [t.name, t.category, t.editExt])).toEqual([["vscode_editFile_internal", "edit", "kt"]]);
    expect(toolsOf(r, b).map((t) => [t.name, t.category, t.editExt])).toEqual([["textEditGroup", "edit", "css"], ["notebookEditGroup", "edit", "ipynb"]]);
  });

  test("tool names: built-ins kept, MCP tools become mcp with their server, anything else other", async () => {
    const id = cpSid("names");
    writeLegacy("w", sessionRoot(id, [request({
      ts: t0(), parts: [
        tool("copilot_findTextInFiles"), tool("manage_todo_list"), tool("runSubagent"), tool("copilot_fetchWebPage"), tool("runTests"),
        tool("mcp_acme_lookup", { source: { type: "mcp", label: "Acme", serverLabel: CANARY.mcp, collectionId: "c", definitionId: "d" } }),
        tool("mcp_other_tool"), tool(`${CANARY.project}_tool`, { source: { type: "extension", label: CANARY.project } }), tool("get_terminal_output"),
      ],
    })]));
    const r = await run([cpVscode]);
    expect(toolsOf(r, id).map((t) => [t.name, t.category, t.checks, t.mcpServer])).toEqual([
      ["copilot_findTextInFiles", "search", undefined, undefined], ["manage_todo_list", "todo", undefined, undefined],
      ["runSubagent", "delegate", undefined, undefined], ["copilot_fetchWebPage", "web", undefined, undefined], ["runTests", "test", ["test"], undefined],
      ["mcp", "mcp", undefined, CANARY.mcp], ["mcp", "mcp", undefined, undefined], ["other", "other", undefined, undefined],
      ["get_terminal_output", "shell", undefined, undefined],
    ]);
    expectNoCanaries([...allEvents(r), r.coverage], { allow: ["mcp"] });
  });

  test("terminal commands: the edited command line runs; legacy `command`; failures are not ok; denied and skipped tools did not run", async () => {
    const id = cpSid("term");
    writeLegacy("w", sessionRoot(id, [request({
      ts: t0(), parts: [
        terminal("echo hi", 1, 100, { toolEdited: "npx tsc --noEmit" }),
        terminal("npm run lint", undefined, undefined, { toolEdited: "npm run lint -- --fix", userEdited: "cargo build" }),
        tool("run_in_terminal", { specific: { kind: "terminal", command: "pytest -q", language: "sh" } }),
        tool("copilot_readFile", { confirmed: false }), tool("copilot_readFile", { confirmed: { type: 0 } }), tool("copilot_readFile", { confirmed: { type: 5 } }),
        tool("copilot_readFile", { confirmed: { type: 4 } }), tool("copilot_getErrors", { resultDetails: { input: "x", output: [], isError: true } }),
      ],
    })]));
    const r = await run([cpVscode]);
    expect(toolsOf(r, id).map((t) => [t.name, t.category, t.checks, t.ok, t.outcome, t.exit, t.ms])).toEqual([
      ["run_in_terminal", "typecheck", ["typecheck"], false, undefined, 1, 100], ["run_in_terminal", "build", ["build"], undefined, undefined, undefined, undefined],
      ["run_in_terminal", "test", ["test"], undefined, undefined, undefined, undefined],
      ["copilot_readFile", "read", undefined, undefined, "denied", undefined, undefined], ["copilot_readFile", "read", undefined, undefined, "denied", undefined, undefined],
      ["copilot_readFile", "read", undefined, undefined, "cancelled", undefined, undefined], ["copilot_readFile", "read", undefined, undefined, undefined, undefined, undefined],
      ["copilot_getErrors", "read", undefined, false, undefined, undefined, undefined],
    ]);
    expect(r.store.forSession(sidOf(id), "marker").map((m) => [m.kind, m.detail])).toEqual([["denial", "user"], ["denial", "user"]]);
  });

  test("a tool left waiting for confirmation in a cancelled request was dropped, not denied; a denied test is no failing check", async () => {
    const id = cpSid("cancel");
    const at = t0();
    writeLegacy("w", sessionRoot(id, [
      request({ ts: at, parts: [tool("runTests", { confirmed: { type: 0 } }), terminal("npm test", 1)], modelState: { value: 2, completedAt: at + 1_000 } }),
      request({ ts: at + MIN, parts: [tool("runTests", { confirmed: { type: 0 } })], modelState: { value: 1, completedAt: at + MIN + 1_000 } }),
    ]));
    const r = await run([cpVscode]);
    expect(toolsOf(r, id).map((t) => [t.name, t.checks, t.ok, t.outcome, t.exit])).toEqual([
      ["runTests", ["test"], undefined, "cancelled", undefined], ["run_in_terminal", ["test"], false, undefined, 1], ["runTests", ["test"], undefined, "denied", undefined],
    ]);
    expect(r.store.forSession(sidOf(id), "marker").map((m) => [m.kind, m.detail])).toEqual([["interrupt", "user"], ["denial", "user"]]);
  });

  test("bookkeeping tools are meta", async () => {
    const id = cpSid("meta");
    writeLegacy("w", sessionRoot(id, [request({ ts: t0(), parts: [tool("copilot_think"), tool("vscode_askQuestions"), tool("copilot_switchAgent"), tool("copilot_memory")] })]));
    const r = await run([cpVscode]);
    expect(toolsOf(r, id).map((t) => [t.name, t.category])).toEqual([
      ["copilot_think", "meta"], ["vscode_askQuestions", "meta"], ["copilot_switchAgent", "meta"], ["copilot_memory", "other"],
    ]);
  });

  test("cancel and failure in the current format (modelState); pending turns have not ended; system-initiated requests are not human", async () => {
    const id = cpSid("state");
    const at = t0();
    writeLegacy("w", sessionRoot(id, [
      request({ ts: at, text: "Do the thing", modelState: { value: 2, completedAt: at + 4_000 } }),
      request({ ts: at + MIN, text: "Again", modelState: { value: 3, completedAt: at + MIN + 2_000 }, extra: { result: { errorDetails: { message: CANARY.secret } } } }),
      request({ ts: at + 2 * MIN, text: "Still running", modelState: { value: 0 } }),
      request({ ts: at + 3 * MIN, text: "Continue", modelState: { value: 1, completedAt: at + 3 * MIN + 500 }, extra: { isSystemInitiated: true } }),
      request({ ts: at + 4 * MIN, text: "Legacy failure", extra: { result: { errorDetails: { message: CANARY.secret }, timings: { totalElapsed: 1_500 } } } }),
    ]));
    const r = await run([cpVscode]);
    const turns = [...r.store.forSession(sidOf(id), "turn")].sort((a, b) => a.ts - b.ts);
    expect(turns.map((t) => [t.status, t.ms, t.ts - at])).toEqual([
      ["interrupted", 4_000, 4_000], ["failed", 2_000, MIN + 2_000], ["completed", 500, 3 * MIN + 500], ["failed", 1_500, 4 * MIN + 1_500],
    ]);
    expect(r.store.forSession(sidOf(id), "marker").map((m) => [m.kind, m.ts - at])).toEqual([["interrupt", 4_000]]);
    expect([...r.store.forSession(sidOf(id), "prompt")].sort((a, b) => a.ts - b.ts).map((p) => p.origin)).toEqual(["human", "human", "human", "system", "human"]);
  });

  test("a request whose time is well-formed but implausible counts once, as bad-ts: no no-ts, no drift", async () => {
    const id = cpSid("oldts");
    writeLegacy("w", sessionRoot(id, [request({ ts: 631152000000, text: "a request stamped 1990" }), request({ ts: t0(), text: "a request of today" })]));
    const r = await run([cpVscode]);
    const c = covOf(r, "copilot.vscode");
    expect(c.skipped["bad-ts"]).toBe(1);
    expect(c.skipped["no-ts"]).toBeUndefined();
    expect(c.unknownTypes).toEqual({});
    expect(r.store.forSession(sidOf(id), "prompt")).toHaveLength(1);
  });

  test("a request without a time is drift request.timestamp:shape, and is skipped no-ts once with its prompt and tools", async () => {
    const id = cpSid("nots");
    const timeless = request({ ts: t0(), text: "a request without its time", parts: [tool("copilot_readFile")] });
    delete timeless.timestamp;
    writeLegacy("w", sessionRoot(id, [timeless, request({ ts: t0() + MIN })]));
    const r = await run([cpVscode]);
    const c = covOf(r, "copilot.vscode");
    expect(c.unknownTypes).toEqual({ "request.timestamp:shape": 1 });
    expect(c.skipped["no-ts"]).toBe(1);
    expect(c.skipped["bad-ts"]).toBeUndefined();
    expect(toolsOf(r, id)).toEqual([]);
    expect(r.store.forSession(sidOf(id), "prompt")).toHaveLength(1);
  });

  test("model ids: vendor prefix dropped, then the shared shape guard", async () => {
    const id = cpSid("models");
    writeLegacy("w", sessionRoot(id, [
      request({ ts: t0(), modelId: "copilot/auto" }), request({ ts: t0() + 1, modelId: "gpt-4o" }),
      request({ ts: t0() + 2, modelId: `copilot/${CANARY.path}` }), request({ ts: t0() + 3, modelId: "copilot/auto" }),
    ]));
    const r = await run([cpVscode]);
    expect(r.store.session(sidOf(id))!.models).toEqual(["auto", "gpt-4o", "other"]);
  });

  test("session ids: a UUID verbatim, any other id hashed; a file without sessionId uses its name", async () => {
    writeLegacy("w", sessionRoot("not-a-uuid", [request({ ts: t0() })]), "x.json");
    const noId = sessionRoot(cpSid("x"), [request({ ts: t0() })]);
    delete noId.sessionId;
    writeLegacy("w", noId, `${cpSid("stem")}.json`);
    const r = await run([cpVscode]);
    expect(r.store.all("session").map((s) => s.id).sort()).toEqual([sidOf(keyedHash(r.salt, "not-a-uuid")), sidOf(cpSid("stem"))].sort());
  });

  test("sessions without requests emit nothing and are counted; empty-window sessions are read", async () => {
    writeLegacy("w", sessionRoot(cpSid("empty"), []));
    writeJournal("w", cpSid("emptyj"), [{ kind: 0, v: sessionRoot(cpSid("emptyj"), []) }, { kind: 1, k: ["responderUsername"], v: "GitHub Copilot" }]);
    const ew = path.join(user(), "globalStorage", "emptyWindowChatSessions");
    h.writeJson(path.join(ew, `${cpSid("ew")}.json`), sessionRoot(cpSid("ew"), [request({ ts: t0() })]));
    h.writeJsonl(path.join(ew, `${cpSid("ewj")}.jsonl`), [{ kind: 0, v: sessionRoot(cpSid("ewj"), [request({ ts: t0() + MIN })]) }]);
    const r = await run([cpVscode]);
    expect(r.store.all("session").map((s) => s.id).sort()).toEqual([sidOf(cpSid("ew")), sidOf(cpSid("ewj"))].sort());
    expect(r.store.session(sidOf(cpSid("ew")))!.projectKey).toBeUndefined();
    expect(covOf(r, "copilot.vscode").skipped["empty-session"]).toBe(2);
  });

  test("the session's own working directory wins over the workspace folder", async () => {
    const id = cpSid("wd");
    h.writeJson(path.join(user(), "workspaceStorage", "w", "workspace.json"), { folder: fileUrl("/work/folder") });
    writeLegacy("w", sessionRoot(id, [request({ ts: t0() })], { extra: { workingDirectory: fileUrl("/work/own dir") } }));
    const r = await run([cpVscode]);
    expect(r.store.session(sidOf(id))!.projectKey).toBe(keyedHash(r.salt, normalizePath("/work/own dir")));
  });

  test("drift: unknown part kinds, journal kinds and newer session versions; known records still map", async () => {
    const id = cpSid("drift");
    writeJournal("w", id, [
      { kind: 0, v: sessionRoot(id, [request({ ts: t0(), parts: [{ kind: "hologram", data: CANARY.secret }, { kind: "SecretKind" }, tool("copilot_readFile")] })], { extra: { version: 4 } }) },
      { kind: 9, k: ["x"], v: 1 },
      { kind: 1, k: ["requests", 5, "modelId"], v: "gpt" },
    ]);
    const r = await run([cpVscode]);
    const c = covOf(r, "copilot.vscode");
    expect(c.status).toBe("drift");
    expect(c.unknownTypes).toEqual({ "part:(other)": 2, "journal-kind:9": 1, "version:newer": 1 });
    expect(c.skipped["bad-record"]).toBe(1);
    expect(toolsOf(r, id).map((t) => t.name)).toEqual(["copilot_readFile"]);
    expect(r.warnings.some((w) => w.code === "drift" && w.source === "copilot.vscode")).toBe(true);
    expectNoCanaries([...allEvents(r), r.coverage, r.warnings]);
  });

  test("a corrupt journal index cannot stall the scan: the record is a bad record and the session still maps", async () => {
    const id = cpSid("huge");
    const at = t0();
    writeJournal("w", id, [
      { kind: 0, v: sessionRoot(id, [request({ ts: at, parts: [tool("copilot_readFile")] })]) },
      { kind: 1, k: ["requests", 4294967294], v: request({ ts: at + MIN }) },
      { kind: 1, k: ["requests", 0, "response", "length"], v: 4294967295 },
    ]);
    const started = performance.now();
    const r = await run([cpVscode]);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(r.store.forSession(sidOf(id), "prompt")).toHaveLength(1);
    expect(toolsOf(r, id).map((t) => t.name)).toEqual(["copilot_readFile"]);
    expect(covOf(r, "copilot.vscode").skipped["bad-record"]).toBe(2);
  });

  test("invalid files and lines are counted, not fatal: a legacy file that does not parse, a broken journal line", async () => {
    const at = t0();
    h.write(path.join(chatDir("w"), `${cpSid("bad")}.json`), "{ not json");
    h.write(path.join(chatDir("w"), `${cpSid("partj")}.jsonl`), `${JSON.stringify({ kind: 0, v: sessionRoot(cpSid("partj"), [request({ ts: at })]) })}\n{ broken\n`);
    const r = await run([cpVscode]);
    const c = covOf(r, "copilot.vscode");
    expect(c.skipped).toEqual({ parse: 2 });
    expect(c.note).toBeUndefined();
    expect(r.store.all("session").map((s) => s.id)).toEqual([sidOf(cpSid("partj"))]);
  });

  test("legacy files are read up to 64 MiB: a file of exactly the cap is read, one byte more is skipped too-large", async () => {
    const CAP = 64 * 1024 * 1024;
    const at = t0();
    // trailing spaces keep the document valid JSON; both files hold the same session text, one byte apart in size
    const padded = (id: string, size: number) => {
      const json = JSON.stringify(sessionRoot(id, [request({ ts: at })]));
      const file = h.write(path.join(chatDir("w"), `${id}.json`), json);
      const fd = openSync(file, "a");
      try {
        const spaces = Buffer.alloc(1024 * 1024, 0x20);
        for (let left = size - Buffer.byteLength(json); left > 0; left -= spaces.length) writeSync(fd, spaces, 0, Math.min(left, spaces.length));
      } finally {
        closeSync(fd);
      }
      expect(statSync(file).size).toBe(size);
    };
    padded(cpSid("atcap"), CAP);
    padded(cpSid("over"), CAP + 1);
    const r = await run([cpVscode]);
    expect(r.store.all("session").map((s) => s.id)).toEqual([sidOf(cpSid("atcap"))]);
    const c = covOf(r, "copilot.vscode");
    expect(c.skipped).toEqual({ "too-large": 1 });
    expect(c.note).toBe("too-large");
    expect(c.files).toBe(1);
    expect(c.bytes).toBe(CAP);
    expect(r.warnings.some((w) => w.code === "too-large" && w.source === "copilot.vscode")).toBe(true);
  });

  test("a copy named differently is still the same session: matched by its sessionId", async () => {
    const id = cpSid("named");
    writeJournal("w1", id, [{ kind: 0, v: sessionRoot(id, [request({ ts: t0() })]) }]);
    writeLegacy("w2", sessionRoot(id, [request({ ts: t0() }), request({ ts: t0() + MIN })]), "renamed-copy.json");
    const r = await run([cpVscode]);
    expect(r.store.forSession(sidOf(id), "prompt")).toHaveLength(1);
    expect(covOf(r, "copilot.vscode").skipped.duplicate).toBe(1);
  });

  test("a truncated journal copy does not hide a complete copy: the complete legacy copy is read", async () => {
    const id = cpSid("trunc");
    const at = t0();
    const reqs = [0, 1, 2].map((n) => request({ ts: at + n * MIN, text: `part ${n} of the plan` }));
    const lines = [{ kind: 0, v: sessionRoot(id, reqs.slice(0, 1), { created: at }) }, { kind: 2, k: ["requests"], v: reqs.slice(1) }].map((x) => JSON.stringify(x));
    h.write(path.join(chatDir("w1"), `${id}.jsonl`), `${lines[0]}\n${lines[1]!.slice(0, 200)}`); // the write stopped mid-line
    writeLegacy("w2", sessionRoot(id, reqs, { created: at }));
    const r = await run([cpVscode]);
    expect(r.store.forSession(sidOf(id), "prompt")).toHaveLength(3);
    expect(covOf(r, "copilot.vscode").skipped).toEqual({ parse: 1, duplicate: 1 });
  });

  test("a copy without requests does not hide one with requests; with only partial copies, the fullest is read", async () => {
    const at = t0();
    const reqs = [0, 1, 2].map((n) => request({ ts: at + n * MIN, text: `step ${n}` }));
    const a = cpSid("emptyc");
    const newer = writeLegacy("n", sessionRoot(a, [], { created: at }));
    const older = writeLegacy("o", sessionRoot(a, reqs.slice(0, 2), { created: at }));
    utimesSync(newer, new Date(at + 9 * MIN), new Date(at + 9 * MIN));
    utimesSync(older, new Date(at + MIN), new Date(at + MIN));
    const b = cpSid("parts");
    const cut = (n: number) => `${JSON.stringify({ kind: 0, v: sessionRoot(b, reqs.slice(0, n), { created: at }) })}\n{ "kind": 2, "k": ["requ`;
    const fewer = h.write(path.join(chatDir("p"), `${b}.jsonl`), cut(1));
    const fuller = h.write(path.join(chatDir("q"), `${b}.jsonl`), cut(2));
    utimesSync(fewer, new Date(at + 9 * MIN), new Date(at + 9 * MIN)); // read first, yet the fuller copy wins
    utimesSync(fuller, new Date(at + MIN), new Date(at + MIN));
    const r = await run([cpVscode]);
    expect(r.store.forSession(sidOf(a), "prompt")).toHaveLength(2);
    expect(r.store.forSession(sidOf(b), "prompt")).toHaveLength(2);
    expect(covOf(r, "copilot.vscode").skipped).toEqual({ parse: 2, duplicate: 2 });
  });

  test("a journal that yields no session falls back to the legacy file of the same session", async () => {
    const id = cpSid("fallbk");
    h.write(path.join(chatDir("w1"), `${id}.jsonl`), "{ not json\n");
    writeLegacy("w2", sessionRoot(id, [request({ ts: t0() }), request({ ts: t0() + MIN })]));
    const r = await run([cpVscode]);
    expect(r.store.forSession(sidOf(id), "prompt")).toHaveLength(2);
    expect(covOf(r, "copilot.vscode").skipped).toEqual({ parse: 1 });
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("unreadable files and folders are io-errors; the rest is read", async () => {
    writeLegacy("ok", sessionRoot(cpSid("fine"), [request({ ts: t0() })]));
    const locked = writeJournal("ok", cpSid("locked"), [{ kind: 0, v: sessionRoot(cpSid("locked"), [request({ ts: t0() })]) }]);
    writeLegacy("shut", sessionRoot(cpSid("shut"), [request({ ts: t0() })]));
    const shut = path.join(h.env.home, chatDir("shut"));
    chmodSync(locked, 0o000);
    chmodSync(shut, 0o000);
    try {
      const r = await run([cpVscode]);
      expect(r.store.all("session").map((s) => s.id)).toEqual([sidOf(cpSid("fine"))]);
      expect(covOf(r, "copilot.vscode").skipped["io-error"]).toBe(2);
    } finally {
      chmodSync(locked, 0o644);
      chmodSync(shut, 0o755);
    }
  });

  test("a store with no chat sessions is empty, and says whether Copilot is installed", async () => {
    mkdirSync(path.join(h.env.home, user(), "workspaceStorage"), { recursive: true });
    mkdirSync(path.join(h.env.home, ".vscode", "extensions", "github.copilot-chat-0.40.1"), { recursive: true });
    const r = await run([cpVscode]);
    expect(covOf(r, "copilot.vscode")).toMatchObject({ status: "empty", installed: true, files: 0, records: 0 });
  });

  test("no VS Code user folder: absent", async () => {
    const r = await run([cpVscode]);
    expect(covOf(r, "copilot.vscode").status).toBe("absent");
  });
});

describe("copilot uriToPath", () => {
  test("file and vscode-remote URIs become paths; Windows drives and shares on win32; other schemes none", () => {
    expect(uriToPath("file:///Users/jo/my%20proj", "darwin")).toBe("/Users/jo/my proj");
    expect(uriToPath("file:///c%3A/Users/Jo%20Ann/proj", "win32")).toBe("c:\\Users\\Jo Ann\\proj");
    expect(uriToPath("file:///C:/src", "win32")).toBe("C:\\src");
    expect(uriToPath("file://server/share/proj", "win32")).toBe("\\\\server\\share\\proj");
    expect(uriToPath("vscode-remote://ssh-remote%2Bbox/home/jo/proj", "darwin")).toBe("/home/jo/proj");
    expect(uriToPath("untitled:Untitled-1", "darwin")).toBeUndefined();
    expect(uriToPath("not a uri", "linux")).toBeUndefined();
    expect(uriToPath("file:///bad%E0%A4%A", "linux")).toBeUndefined();
  });
});

describe("copilot install detection", () => {
  test("a bundled copilot extension or a github.copilot* user extension means installed", () => {
    const bundles = path.join(h.root, "bundle", "extensions");
    const exts = path.join(h.root, "user", "extensions");
    mkdirSync(bundles, { recursive: true });
    mkdirSync(exts, { recursive: true });
    expect(copilotInstalled({ bundles: [bundles], extensions: [exts] })).toBe(false);
    mkdirSync(path.join(bundles, "copilot"));
    expect(copilotInstalled({ bundles: [bundles], extensions: [exts] })).toBe(true);
    expect(copilotInstalled({ bundles: [], extensions: [exts] })).toBe(false);
    mkdirSync(path.join(exts, "github.copilot-1.300.0"));
    expect(copilotInstalled({ bundles: [], extensions: [exts] })).toBe(true);
  });

  test("bundle and extension folders per platform", () => {
    const mac = detectEnv({ platform: "darwin", home: "/Users/jo", vars: {}, wslHomes: [] });
    expect(installDirs(mac, "Code")).toEqual({
      bundles: ["/Applications/Visual Studio Code.app/Contents/Resources/app/extensions", "/Users/jo/Applications/Visual Studio Code.app/Contents/Resources/app/extensions"],
      extensions: ["/Users/jo/.vscode/extensions"],
    });
    const win = detectEnv({ platform: "win32", home: "C:\\Users\\Jo Ann", localAppData: "C:\\Users\\Jo Ann\\AppData\\Local", vars: {}, wslHomes: [] });
    expect(installDirs(win, "Code")).toEqual({
      bundles: ["C:\\Users\\Jo Ann\\AppData\\Local\\Programs\\Microsoft VS Code\\resources\\app\\extensions"],
      extensions: ["C:\\Users\\Jo Ann\\.vscode\\extensions"],
    });
    const linux = detectEnv({ platform: "linux", home: "/home/jo", vars: {}, wslHomes: [] });
    expect(installDirs(linux, "Code")).toEqual({ bundles: ["/usr/share/code/resources/app/extensions"], extensions: ["/home/jo/.vscode/extensions"] });
    expect(installDirs(linux, "Code - Insiders").extensions).toEqual(["/home/jo/.vscode-insiders/extensions"]);
    expect(installDirs(linux, "VSCodium")).toEqual({ bundles: [], extensions: ["/home/jo/.vscode-oss/extensions"] });
  });
});

describe("copilot jetbrains", () => {
  test("nitrite chat stores are present but not decoded: beta, files and bytes only", async () => {
    const fx = buildCopilot(h);
    h.write(path.join(jetbrainsRel(h), "pycharm", "chat-edit-sessions", "copilot-edit-sessions-nitrite.db"), "xyz");
    h.write(path.join(jetbrainsRel(h), "pycharm", "chat-edit-sessions", "notes.txt"), "not a store");
    const r = await run([cpJetbrains]);
    const c = covOf(r, "copilot.jetbrains");
    expect(c).toMatchObject({ status: "present-undecodable", beta: true, files: 2, records: 0, window: "detail" });
    expect(c.bytes).toBe(Bun.file(fx.jetbrainsFile).size + 3);
    expect(allEvents(r)).toEqual([]);
    expect(r.warnings.some((w) => w.code === "beta")).toBe(false); // no events: nothing to warn about
    expectNoCanaries([r.coverage, r.warnings]);
  });

  test("only the OAuth files: absent, and they are never returned by locate", async () => {
    h.writeJson(path.join(jetbrainsRel(h), "apps.json"), { token: CANARY.token });
    h.writeJson(path.join(jetbrainsRel(h), "hosts.json"), { token: CANARY.token });
    expect(cpJetbrains.locate(h.env, [h.env.home])).toEqual([]);
    const r = await run([cpJetbrains]);
    expect(covOf(r, "copilot.jetbrains").status).toBe("absent");
  });
});

describe("copilot cli (session events and store, from the CLI's schema)", () => {
  const cliSid = cpSid("cli1");
  function cliSession(at: number): CliEvents {
    const e = new CliEvents(at);
    e.ev("session.start", { sessionId: cliSid, version: 1, producer: "copilot-agent", copilotVersion: "1.0.4", startTime: new Date(e.t).toISOString(), context: { cwd: CANARY.path, gitRoot: CANARY.path, branch: "main" }, selectedModel: "claude-sonnet-5" }, 0)
      .ev("user.message", { content: `Fix the build. ${CANARY.prompt}`, attachments: [] })
      .ev("assistant.turn_start", { turnId: "0" })
      .ev("assistant.message", { messageId: "m1", content: CANARY.code, toolRequests: [{ toolCallId: "t1", name: "bash", arguments: { command: "npm test" } }] })
      .ev("tool.execution_start", { toolCallId: "t1", toolName: "bash", arguments: { command: `npm test ${CANARY.path}`, description: CANARY.prompt } })
      .ev("tool.execution_complete", { toolCallId: "t1", success: true, result: { content: `${CANARY.secret}\n<exited with exit code 1>` } }, 3_000)
      .ev("tool.execution_start", { toolCallId: "t2", toolName: "edit", arguments: { path: `${CANARY.path}/src/build.ts`, old_str: CANARY.code, new_str: CANARY.code } })
      .ev("tool.execution_complete", { toolCallId: "t2", success: true, result: { content: CANARY.code } })
      .ev("tool.execution_start", { toolCallId: "t3", toolName: "report_intent", arguments: { intent: CANARY.prompt } })
      .ev("tool.execution_complete", { toolCallId: "t3", success: true })
      .ev("tool.execution_start", { toolCallId: "t4", toolName: "lookup", mcpServerName: CANARY.mcp, mcpToolName: "lookup", arguments: {} })
      .ev("tool.execution_complete", { toolCallId: "t4", success: false, error: { message: CANARY.secret, code: "failure" } })
      .ev("assistant.usage", { model: "gpt-5.1", inputTokens: 10, outputTokens: 5 })
      .ev("assistant.turn_end", { turnId: "0" })
      .ev("user.message", { content: "now ship it", source: "system" })
      .ev("assistant.turn_start", { turnId: "1" })
      .ev("abort", { reason: "user initiated" })
      .ev("session.wormhole", { secret: CANARY.secret })
      .ev("session.model_change", { newModel: "claude-opus-5" });
    return e;
  }

  test("events.jsonl: session, prompts by source, tools with checks, exit, edit extension and MCP server, turns, interrupt, drift", async () => {
    const at = t0();
    const e = cliSession(at);
    h.writeJsonl(path.join(".copilot", "session-state", cliSid, "events.jsonl"), e.records);
    const r = await run([cpCli]);
    expect(r.store.session(sidOf(cliSid))).toMatchObject({
      tool: "copilot", source: "copilot.cli", window: "detail", origin: "human", surface: "cli", version: "1.0.4",
      models: ["claude-sonnet-5", "gpt-5.1", "claude-opus-5"], projectKey: keyedHash(r.salt, normalizePath(CANARY.path)), start: at, end: e.t,
    });
    expect(r.store.all("prompt").map((p) => [p.origin, p.window])).toEqual([["human", "detail"], ["system", "detail"]]);
    expect(toolsOf(r, cliSid).map((t) => [t.name, t.category, t.checks, t.ok, t.exit, t.ms, t.editExt, t.mcpServer])).toEqual([
      ["bash", "test", ["test"], false, 1, 3_000, undefined, undefined],
      ["edit", "edit", undefined, true, undefined, 1_000, "ts", undefined],
      ["report_intent", "meta", undefined, true, undefined, 1_000, undefined, undefined], // bookkeeping: counted apart, never dropped
      ["mcp", "mcp", undefined, false, undefined, 1_000, undefined, CANARY.mcp],
    ]);
    expect(toolsOf(r, cliSid).map((t) => t.toolchain)).toEqual(["js", undefined, undefined, undefined]); // bash `npm test`
    // one TurnEv per exchange: a user message over its model calls (a turn_start/turn_end pair is one model call)
    expect(r.store.forSession(sidOf(cliSid), "turn").map((t) => [t.status, t.ms])).toEqual([["completed", 14_000], ["interrupted", 2_000]]);
    expect(r.store.forSession(sidOf(cliSid), "marker").map((m) => [m.kind, m.detail])).toEqual([["interrupt", "user"]]);
    const c = covOf(r, "copilot.cli");
    expect(c).toMatchObject({ status: "drift", unknownTypes: { "event:(other)": 1 }, versions: ["1.0.4"], files: 1, records: e.records.length });
    expectNoCanaries([...allEvents(r), r.coverage, r.warnings], { allow: ["mcp"] });
  });

  test("session-store.db: lifetime sessions and turns from allowlisted columns only", async () => {
    const at = t0();
    const iso = (ms: number) => new Date(ms).toISOString();
    h.sqlite(path.join(".copilot", "session-store.db"), [
      "CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, host_type TEXT, branch TEXT, summary TEXT, agent_name TEXT, agent_description TEXT, created_at TEXT, updated_at TEXT)",
      "CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, turn_index INTEGER NOT NULL, user_message TEXT, assistant_response TEXT, timestamp TEXT)",
      "CREATE TABLE session_files (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, file_path TEXT, tool_name TEXT, turn_index INTEGER, first_seen_at TEXT)",
    ], {
      sessions: [
        [cliSid, CANARY.path, CANARY.project, "github", "main", CANARY.prompt, CANARY.project, CANARY.prompt, iso(at), iso(at + 9 * MIN)],
        ["not-a-uuid", null, null, CANARY.slug, null, null, null, null, iso(at), null],
      ],
      turns: [[1, cliSid, 0, CANARY.prompt, CANARY.code, iso(at + MIN)], [2, cliSid, 1, CANARY.prompt, CANARY.code, iso(at + 2 * MIN)]],
      session_files: [[1, cliSid, `${CANARY.path}/x.ts`, "edit", 0, iso(at)]],
    });
    const sql: string[] = [];
    __observeQueries((s) => sql.push(s));
    const r = await run([cpCli]);
    __observeQueries(undefined);
    // the CLI's own store: surface cli, whatever host_type names (the repository's host, not a client)
    expect(r.store.session(sidOf(cliSid))).toMatchObject({ window: "lifetime", origin: "human", surface: "cli", start: at, end: at + 9 * MIN, projectKey: keyedHash(r.salt, normalizePath(CANARY.path)) });
    expect(r.store.session(sidOf(keyedHash(r.salt, "not-a-uuid")))).toMatchObject({ surface: "cli", start: at, end: at });
    expect(r.store.forSession(sidOf(cliSid), "turn").map((t) => [t.window, t.ts - at])).toEqual([["lifetime", MIN], ["lifetime", 2 * MIN]]);
    const selects = sql.filter((s) => /^\s*SELECT/i.test(s) && !/sqlite_master|pragma_table_info/.test(s));
    expect(selects.length).toBeGreaterThan(0);
    for (const s of selects) expect(s).not.toMatch(/user_message|assistant_response|summary|repository|branch|agent_name|agent_description|file_path|host_type|\*/);
    expect(covOf(r, "copilot.cli", "lifetime")).toMatchObject({ status: "ok", files: 1, records: 4 }); // the store: the lifetime window
    expect(covOf(r, "copilot.cli")).toMatchObject({ status: "absent", files: 0, records: 0 }); // no session-state: no detail window
    expectNoCanaries([...allEvents(r), r.coverage, r.warnings]);
  });

  test("events.jsonl tool shapes: str_replace_editor by command, apply_patch file, powershell, calls never completed", async () => {
    const at = t0();
    const id = cpSid("cli2");
    const e = new CliEvents(at)
      .ev("session.start", { sessionId: id, copilotVersion: "not a version" }, 0)
      .ev("tool.execution_start", { toolCallId: "a", toolName: "str_replace_editor", arguments: { command: "view", path: "/w/a.go" } })
      .ev("tool.execution_start", { toolCallId: "b", toolName: "str_replace_editor", arguments: { command: "create", path: "/w/new.rs" } })
      .ev("tool.execution_start", { toolCallId: "c", toolName: "apply_patch", arguments: { input: "*** Begin Patch\n*** Update File: /w/lib.py\n@@\n-a\n+b\n*** End Patch" } })
      .ev("tool.execution_start", { toolCallId: "d", toolName: "powershell", arguments: { command: "dotnet build" } })
      .ev("tool.execution_complete", { toolCallId: "d", success: true, result: { content: "Build succeeded.\n<exited with exit code 0>" } })
      .ev("tool.execution_start", { toolCallId: "e", toolName: CANARY.project, arguments: {} });
    h.writeJsonl(path.join(".copilot", "session-state", id, "events.jsonl"), e.records);
    const r = await run([cpCli]);
    expect([...toolsOf(r, id)].sort((x, y) => x.ts - y.ts).map((t) => [t.name, t.category, t.checks, t.editExt, t.ok, t.exit])).toEqual([
      ["str_replace_editor", "read", undefined, undefined, undefined, undefined], ["str_replace_editor", "write", undefined, "rs", undefined, undefined],
      ["apply_patch", "edit", undefined, "py", undefined, undefined], ["powershell", "build", ["build"], undefined, true, 0],
      ["other", "other", undefined, undefined, undefined, undefined],
    ]);
    expect(toolsOf(r, id).find((t) => t.name === "powershell")!.toolchain).toBe("dotnet");
    expect(r.store.session(sidOf(id))!.version).toBeUndefined();
    expect(covOf(r, "copilot.cli").versions).toEqual([]);
    expectNoCanaries([...allEvents(r), r.coverage]);
  });

  test("an event whose time is well-formed but implausible counts once, as bad-ts; one without a time is drift and no-ts", async () => {
    const id = cpSid("cli5");
    const e = new CliEvents(t0())
      .ev("session.start", { sessionId: id }, 0)
      .ev("user.message", { content: "Fix the importer" })
      .ev("user.message", { content: "a message stamped 1990" })
      .ev("tool.execution_start", { toolCallId: "x1", toolName: "bash", arguments: { command: "npm test" } })
      .ev("user.message", { content: "a message without a time" })
      .ev("user.message", { content: "And add a test" });
    e.records[2]!.timestamp = "1990-01-01T00:00:00.000Z";
    e.records[3]!.timestamp = 631152000000;
    delete e.records[4]!.timestamp;
    h.writeJsonl(path.join(".copilot", "session-state", id, "events.jsonl"), e.records);
    const r = await run([cpCli]);
    const c = covOf(r, "copilot.cli");
    expect(c.skipped).toEqual({ "bad-ts": 2, "no-ts": 1 });
    expect(c.unknownTypes).toEqual({ "event.timestamp:shape": 1 });
    expect(r.store.forSession(sidOf(id), "prompt")).toHaveLength(2);
    expect(toolsOf(r, id)).toEqual([]);
  });

  test("a turn_end after an abort does not end the exchange again; a turn_end for a model call never started ends nothing", async () => {
    const at = t0();
    const id = cpSid("cli3");
    const e = new CliEvents(at)
      .ev("session.start", { sessionId: id }, 0)
      .ev("user.message", { content: "Run the migration" })
      .ev("assistant.turn_start", { turnId: "7" })
      .ev("abort", { reason: "user initiated" })
      .ev("assistant.turn_end", { turnId: "7" })
      .ev("assistant.turn_end", { turnId: "never-started" })
      .ev("assistant.turn_end", {});
    h.writeJsonl(path.join(".copilot", "session-state", id, "events.jsonl"), e.records);
    const r = await run([cpCli]);
    expect(r.store.forSession(sidOf(id), "turn").map((t) => [t.status, t.ms])).toEqual([["interrupted", 2_000]]);
    expect(r.store.forSession(sidOf(id), "marker").map((m) => m.kind)).toEqual(["interrupt"]);
  });

  test("an exchange spans its model calls; calls still running at an abort were interrupted; a call cut off by the file's end has no turn", async () => {
    const at = t0();
    const id = cpSid("cli4");
    const e = new CliEvents(at)
      .ev("session.start", { sessionId: id }, 0)
      .ev("user.message", { content: "Fix the importer" })                 // +1 s
      .ev("assistant.turn_start", { turnId: "0" }).ev("assistant.turn_end", { turnId: "0" })   // first model call, +2 s .. +3 s
      .ev("assistant.turn_start", { turnId: "1" }).ev("assistant.turn_end", { turnId: "1" })   // second model call, +4 s .. +5 s
      .ev("user.message", { content: "Now run the tests" })                // +6 s: the first exchange ended at +5 s
      .ev("assistant.turn_start", { turnId: "2" })
      .ev("tool.execution_start", { toolCallId: "t9", toolName: "bash", arguments: { command: "npm test" } })
      .ev("abort", { reason: "user initiated" })                           // +9 s
      .ev("tool.execution_complete", { toolCallId: "t9", success: false })
      .ev("user.message", { content: "Try again" })
      .ev("assistant.turn_start", { turnId: "3" });                        // the file stops mid-call
    h.writeJsonl(path.join(".copilot", "session-state", id, "events.jsonl"), e.records);
    const r = await run([cpCli]);
    expect(r.store.forSession(sidOf(id), "turn").map((t) => [t.status, t.ms, t.ts - at])).toEqual([["completed", 4_000, 5_000], ["interrupted", 3_000, 9_000]]);
    expect(toolsOf(r, id).map((t) => [t.name, t.checks, t.ok, t.outcome])).toEqual([["bash", ["test"], undefined, "interrupted"]]);
  });

  test.skipIf(process.platform === "win32")("a store locked and above the copy limit keeps its reason: too-large, not unreadable, with a warning and a log", async () => {
    const file = writeSessionStore(h, path.join(".copilot", "session-store.db"), { id: cliSid, host: "github", at: t0() });
    const release = lockAboveCopyLimit(file);
    const logs: string[] = [];
    let r: Result;
    try {
      r = await scan({ env: h.env, plugins: [cpCli], onLog: (level, code) => { if (code !== "scan.gc") logs.push(`${level} ${code}`); } });
    } finally {
      release();
    }
    expect(covOf(r, "copilot.cli", "lifetime")).toMatchObject({ status: "empty", note: "too-large", files: 0, skipped: { "too-large": 1 } });
    expect(r.warnings.map((w) => [w.code, w.source])).toEqual([["too-large", "copilot.cli"]]);
    expect(logs).toEqual(["warn cp.db-too-large"]);
  });

  test("no session-state and no store under ~/.copilot: absent", async () => {
    h.writeJson(path.join(".copilot", "config.json"), { banner: "never" });
    expect(cpCli.locate(h.env, [h.env.home])).toEqual([]);
    const r = await run([cpCli]);
    expect(covOf(r, "copilot.cli").status).toBe("absent");
  });
});

describe("copilot plugins", () => {
  test("ids, tiers and beta flags; registered", () => {
    expect([cpVscode, cpCli, cpJetbrains].map((p) => [p.tool, p.id, p.tier, p.beta])).toEqual([
      ["copilot", "copilot.vscode", "P0", false], ["copilot", "copilot.cli", "P0", true], ["copilot", "copilot.jetbrains", "P0", true],
    ]);
    for (const p of [cpVscode, cpCli, cpJetbrains]) expect(registry).toContain(p);
    const never = [cpVscode, cpCli, cpJetbrains].flatMap((p) => p.describe.neverReads).join("\n");
    expect(never).toMatch(/apps\.json/);
    expect(never).toMatch(/hosts\.json/);
  });

  test("a VS Code user folder per app that exists: Code, Code - Insiders, VSCodium", () => {
    for (const app of ["Code", "VSCodium"]) mkdirSync(path.join(h.env.home, userRel(h, app)), { recursive: true });
    expect(cpVscode.locate(h.env, [h.env.home]).map((c) => path.basename(path.dirname(c.root)))).toEqual(["Code", "VSCodium"]);
  });
});

describe("copilot vscode: the extension's session store", () => {
  test("globalStorage/github.copilot-chat/session-store.db adds lifetime sessions that merge with the chat sessions by id", async () => {
    const at = buildCopilot(h).t0;
    h.sqlite(path.join(user(), "globalStorage", "github.copilot-chat", "session-store.db"), [
      "CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, host_type TEXT, branch TEXT, summary TEXT, agent_name TEXT, agent_description TEXT, created_at TEXT, updated_at TEXT)",
      "CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, turn_index INTEGER NOT NULL, user_message TEXT, assistant_response TEXT, timestamp TEXT)",
    ], {
      sessions: [[S_J, CANARY.path, null, "vscode", null, CANARY.prompt, null, null, new Date(at - MIN).toISOString(), new Date(at + 30 * MIN).toISOString()]],
      turns: [[1, S_J, 0, CANARY.prompt, CANARY.code, new Date(at + MIN).toISOString()]],
    });
    const r = await run([cpVscode]);
    expect(r.store.all("session")).toHaveLength(2);
    expect(r.store.session(sidOf(S_J))).toMatchObject({ window: "detail", surface: "vscode", mode: "agent", start: at - MIN, end: at + 30 * MIN });
    expect(r.store.forSession(sidOf(S_J), "turn").filter((t) => t.window === "lifetime")).toHaveLength(1);
    expect([covOf(r, "copilot.vscode").records, covOf(r, "copilot.vscode", "lifetime").records]).toEqual([4, 2]); // chat files; store rows
    expectNoCanaries([...allEvents(r), r.coverage, r.warnings]);
  });

  test("store sessions take the surface of the store they come from, never host_type: vscode in the extension's copy, cli in the CLI's", async () => {
    const at = t0();
    const vs = cpSid("vsrow");
    const cli = cpSid("clirow");
    writeSessionStore(h, path.join(user(), "globalStorage", "github.copilot-chat", "session-store.db"), { id: vs, host: "github", at });
    writeSessionStore(h, path.join(".copilot", "session-store.db"), { id: cli, host: "github", at });
    const r = await run([cpVscode, cpCli]);
    expect([vs, cli].map((id) => [r.store.session(sidOf(id))?.window, r.store.session(sidOf(id))?.surface])).toEqual([["lifetime", "vscode"], ["lifetime", "cli"]]);
  });
});
