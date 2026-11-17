import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import type { CoverageEv, Ev } from "../../../core/model/events";
import { scan } from "../../../core/scan";
import { cxRollouts } from "../../../core/sources/codex";
import { cxToolCalls, patchFiles } from "../../../core/sources/codex/tools";
import { uuidV7Ms } from "../../../core/sources/codex/uuid";
import type { ScanCtx } from "../../../core/sources/types";
import { keyedHash } from "../../../core/text/hash";
import { CANARY, expectNoCanaries, findCanaries } from "../../kit/canary";
import { fakeHome, type FakeHome } from "../../kit/home";
import { fixtureStart } from "../../fixtures/claude-code";
import { buildCodexRollouts, CX_MAX, CX_MINI, CxRollout, DIFF_4_2, IMAGE, rateLimits, rolloutRel, uuidV7, type CxMeta } from "../../fixtures/codex";

let h: FakeHome;
beforeEach(() => { h = fakeHome(); });
afterEach(() => h.cleanup());

const run = () => scan({ env: h.env, plugins: [cxRollouts] });
type Run = Awaited<ReturnType<typeof run>>;
const KINDS = ["session", "prompt", "tool", "turn", "usage", "marker", "ratelimit", "codex-rollout", "file"] as const;
const allEvents = (r: Run) => KINDS.flatMap((k) => [...r.store.all(k)] as Ev[]);
/** Tool events in time order (calls wait for their completing item, so emission order is not time order). */
const toolsByTs = (r: Run) => [...r.store.all("tool")].sort((a, b) => a.ts - b.ts);
const sidOf = (id: string) => `codex:${id}`;
const skipChmod = process.platform === "win32" || process.getuid?.() === 0;

let n = 0x100;
/** A one-turn rollout; `build` adds records after session_meta and turn_context. */
function rollout(build: (r: CxRollout) => void, meta: CxMeta = {}, at = fixtureStart() + (n % 50) * 60_000): CxRollout {
  const r = new CxRollout(at, uuidV7(at - 1000, ++n), meta);
  r.meta().turn("turn-1");
  build(r);
  return r;
}

describe("codex rollouts: Task 11 scenario", () => {
  test("origins, prompts, command and patch tools, usage, rate limits, interrupt, rollout facts, drift, no canaries", async () => {
    const fx = buildCodexRollouts(h);
    const r = await run();

    const origins: Record<string, number> = {};
    for (const s of r.store.all("session")) origins[s.origin] = (origins[s.origin] ?? 0) + 1;
    expect(origins).toEqual({ human: 1, scripted: 1, subagent: 1, peer: 1 });
    expect(r.store.all("prompt").filter((p) => p.origin === "human")).toHaveLength(2);
    const tools = r.store.all("tool");
    const tests = tools.filter((t) => t.checks?.includes("test"));
    expect(tests.map((t) => t.checks)).toEqual([["test"], ["test"]]);
    expect(tests.map((t) => t.ok)).toEqual([false, true]);
    expect(tests.map((t) => t.exit)).toEqual([1, 0]);
    expect(tools.find((t) => t.sessionId === sidOf(fx.r2.id) && t.name === "exec_command")).toMatchObject({ category: "build" });
    expect(tools.find((t) => t.category === "edit")).toMatchObject({ category: "edit", editExt: "ts", linesAdded: 4, linesRemoved: 2 });
    expect(tools.find((t) => t.name === "spawn_agent")).toMatchObject({ category: "delegate" });
    expect(r.store.all("usage").length).toBeGreaterThanOrEqual(2);
    expect(r.store.all("ratelimit").length).toBeGreaterThanOrEqual(2);
    expect(r.store.all("marker").filter((m) => m.kind === "interrupt")).toHaveLength(1);
    const fact = r.store.all("codex-rollout").find((f) => f.threadId === sidOf(fx.r1.id))!;
    expect(fact.fileTs).toBe(fx.r1.fileTs);
    expect(fact.uuidTs).toBe(fact.fileTs! - 1000);
    expect(r.coverage[0]!.status).toBe("drift");
    expectNoCanaries(allEvents(r));
  });

  test("no event of any kind, no coverage field and no warning carries canary text", async () => {
    buildCodexRollouts(h);
    const r = await run();
    expectNoCanaries([...allEvents(r), r.coverage, r.warnings]);
  });

  test("sessions: ids, origins, parent, depth, role, models, version, surface, project, repo", async () => {
    const fx = buildCodexRollouts(h);
    const r = await run();
    expect(r.store.all("session").map((s) => s.id).sort()).toEqual([fx.r1, fx.r2, fx.r3, fx.r4].map((x) => sidOf(x.id)).sort());
    expect(r.store.session(sidOf(fx.r1.id))).toMatchObject({
      origin: "human", window: "detail", models: [CX_MAX], version: "0.169.0", surface: "cli", inRepo: true,
      projectKey: keyedHash(r.salt, CANARY.path), start: fx.r1.fileTs,
    });
    expect(r.cwds.get(keyedHash(r.salt, CANARY.path))).toBe(CANARY.path);
    expect(r.store.session(sidOf(fx.r2.id))).toMatchObject({ origin: "scripted", surface: "exec", models: [CX_MINI], version: "0.168.0", inRepo: false });
    expect(r.store.session(sidOf(fx.r3.id))).toMatchObject({
      origin: "subagent", parentId: sidOf(fx.r1.id), spawnDepth: 1, agentType: "explorer", surface: "subagent", models: [CX_MINI], start: fx.r3.fileTs,
    });
    expect(r.store.session(sidOf(fx.r4.id))).toMatchObject({ origin: "peer", surface: "vscode", projectKey: keyedHash(r.salt, "/work/projC") });
  });

  test("prompts: origin follows the session; subagent briefs and injected context are never prompts", async () => {
    const fx = buildCodexRollouts(h);
    const r = await run();
    const prompts = r.store.all("prompt");
    expect(prompts.map((p) => [p.sessionId, p.origin])).toEqual([
      [sidOf(fx.r1.id), "human"], [sidOf(fx.r1.id), "human"], [sidOf(fx.r2.id), "scripted"], [sidOf(fx.r4.id), "peer"],
    ]);
    expect(prompts.map((p) => p.intent)).toEqual(["spec", "question", "spec", "spec"]);
    expect(prompts.map((p) => p.features.isTaskStart)).toEqual([true, false, false, false]);
    expect(prompts[1]!.textHash).toBe(keyedHash(r.salt, "Why does the importer reject empty input?"));
    expect(prompts[0]!.features.simToPrev).toBeUndefined();
    expect(prompts[1]!.features.simToPrev).toBeGreaterThanOrEqual(0);
    expect(prompts.every((p) => p.window === "detail")).toBe(true);
  });

  test("history a subagent rollout copies from its parent is skipped", async () => {
    const fx = buildCodexRollouts(h);
    const r = await run();
    const r3 = sidOf(fx.r3.id);
    expect(r.store.forSession(r3, "tool").map((t) => [t.name, t.category])).toEqual([["exec_command", "search"]]);
    expect(r.store.forSession(r3, "turn").map((t) => [t.status, t.model, t.effort])).toEqual([["completed", CX_MINI, "medium"]]);
    expect(r.store.forSession(r3, "marker")).toEqual([]);
    expect(r.store.forSession(r3, "usage")).toHaveLength(1);
    // rate limits belong to the account, not a session: R1's, then R3's own (its copied 40 % is skipped), then R2's
    expect(r.store.all("ratelimit").map((x) => [x.window, x.usedPercent])).toEqual([["primary", 10], ["secondary", 2], ["primary", 11], ["primary", 41], ["primary", 20]]);
  });

  test("turns, usage, rate limits and markers of the cli rollout", async () => {
    const fx = buildCodexRollouts(h);
    const r = await run();
    const r1 = sidOf(fx.r1.id);
    expect(r.store.forSession(r1, "turn").map((t) => [t.status, t.ms, t.model, t.effort])).toEqual([
      ["completed", 61_000, CX_MAX, "high"], ["interrupted", 9_000, CX_MAX, "xhigh"],
    ]);
    expect(r.store.forSession(r1, "usage").map((u) => [u.model, u.inTok, u.cacheR, u.outTok, u.cacheW])).toEqual([
      [CX_MAX, 4_000, 8_000, 900, 0], [CX_MAX, 2_000, 12_000, 400, 0],
    ]);
    const s1 = r.store.session(r1)!;
    expect(r.store.all("ratelimit").filter((x) => x.ts >= s1.start && x.ts <= s1.end).map((x) => [x.window, x.usedPercent, x.windowMinutes])).toEqual([
      ["primary", 10, 300], ["secondary", 2, 10_080], ["primary", 11, 300],
    ]);
    expect(r.store.forSession(r1, "marker").map((m) => [m.kind, m.detail])).toEqual([["interrupt", "interrupted"], ["compact-auto", undefined]]);
  });

  test("tool events: one per nested command, per patched file and per call; Code Mode cells are not tool events", async () => {
    const fx = buildCodexRollouts(h);
    const r = await run();
    const r1 = toolsByTs(r).filter((t) => t.sessionId === sidOf(fx.r1.id));
    expect(r1.map((t) => [t.name, t.category, t.ok])).toEqual([
      ["exec_command", "test", false], ["apply_patch", "edit", true], ["exec_command", "test", true], ["spawn_agent", "delegate", undefined],
    ]);
    const firstCommand = fx.r1.records.map((x) => (x.payload as { item?: { type?: string; id?: string } }).item).find((i) => i?.type === "CommandExecution")!;
    expect(r1[0]).toMatchObject({ ms: 2_500, callId: keyedHash(r.salt, firstCommand.id!) });
    expect(r.store.forSession(sidOf(fx.r2.id), "tool")).toEqual([{
      k: "tool", tool: "codex", source: "codex.rollouts", ts: expect.any(Number), sessionId: sidOf(fx.r2.id), callId: expect.any(String),
      name: "exec_command", category: "build", checks: ["build"], ok: true, exit: 0, ms: 12_000,
    }]);
  });

  test("rollout and file facts per rollout; coverage counters", async () => {
    const fx = buildCodexRollouts(h);
    const r = await run();
    expect(r.store.all("codex-rollout").map((f) => [f.threadId, f.uuidTs, f.fileTs])).toEqual(
      [fx.r1, fx.r3, fx.r2, fx.r4].map((x) => [sidOf(x.id), x.fileTs - 1000, x.fileTs]),
    );
    const files = r.store.all("file");
    expect(files).toHaveLength(4);
    const f1 = files.find((f) => f.pathHash === keyedHash(r.salt, fx.files[0]!))!;
    const s1 = r.store.session(sidOf(fx.r1.id))!;
    expect(f1).toMatchObject({ bytes: statSync(fx.files[0]!).size, firstTs: s1.start, lastTs: s1.end });
    const cov = r.coverage[0]!;
    expect(cov).toMatchObject({
      tool: "codex", source: "codex.rollouts", window: "detail", beta: false, status: "drift",
      files: 4, bytes: fx.files.reduce((s, f) => s + statSync(f).size, 0), records: fx.lines - fx.heavy,
      skipped: { sniffed: fx.heavy }, unknownTypes: { "event_msg:brand_new_event": 1 }, versions: ["0.168.0", "0.169.0"],
    });
    const sessions = r.store.all("session");
    expect(cov.from).toBe(Math.min(...sessions.map((s) => s.start)));
    expect(cov.to).toBe(Math.max(...sessions.map((s) => s.end)));
    expect(r.warnings.filter((w) => w.code === "drift")).toHaveLength(1);
  });
});

describe("codex rollouts: prompts", () => {
  test("injected context is dropped; image-wrapped prompts and question replies keep the person's text", async () => {
    const r1 = rollout((r) => {
      for (const injected of [
        `<environment_context>\n  <cwd>${CANARY.path}</cwd>\n</environment_context>`,
        `<user_instructions>\n${CANARY.prompt}\n</user_instructions>`,
        `<recommended_plugins>\n- ${CANARY.project}\n</recommended_plugins>`,
        `<codex_internal_context source="user_goal">${CANARY.prompt}</codex_internal_context>`,
        "<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>",
        `  # AGENTS.md instructions for ${CANARY.path}\n\n<INSTRUCTIONS>\n${CANARY.prompt}\n</INSTRUCTIONS>`,
        `<skill>\n<name>${CANARY.project}</name>\n${CANARY.code}\n</skill>`,
        `<user_shell_command>\n<command>ls</command>\n<result>\n${CANARY.secret}\n</result>\n</user_shell_command>`,
        `<subagent_notification>\n{"agent_path":"/root/a","status":"completed"}\n</subagent_notification>`,
        `<image name=[Image #1]>${CANARY.secret}</image>`,
        "   ",
      ]) r.user(injected);
      r.user("<image name=[Image #1]>", IMAGE, "</image>", IMAGE, "What is wrong in this screenshot?")
        .user("<image name=[Image #1]>", IMAGE, "</image>")
        .user("<send_user_message_question_reply>\nUse the second option.\n</send_user_message_question_reply>")
        .user("<notes>keep both</notes> and refactor the parser", "with tests");
    });
    r1.write(h);
    const r = await run();
    const prompts = r.store.all("prompt");
    expect(prompts.map((p) => p.textHash)).toEqual([
      keyedHash(r.salt, "What is wrong in this screenshot?"),
      keyedHash(r.salt, "Use the second option."),
      keyedHash(r.salt, "<notes>keep both</notes> and refactor the parser\nwith tests"),
    ]);
    expect(prompts.map((p) => p.hasPaste)).toEqual([true, undefined, undefined]);
    expect(prompts[0]!.features.hasContext).toBe(true);
    expect(prompts.map((p) => p.intent)).toEqual(["question", "spec", "spec"]);
    expectNoCanaries(allEvents(r));
  });

  test("a new task starts after 30 idle minutes; scripted prompts are never task starts", async () => {
    const r1 = rollout((r) => {
      r.user("Add pagination to the list endpoint").assistant("Added.");
      r.t += 45 * 60_000;
      r.user("Does it handle the last page correctly?").user("And the first page?");
    });
    r1.write(h);
    rollout((r) => r.user("Run the nightly report").user("Then email it"), { source: "exec" }).write(h);
    const r = await run();
    const byOrigin = (o: string) => r.store.all("prompt").filter((p) => p.origin === o).map((p) => p.features.isTaskStart);
    expect(byOrigin("human")).toEqual([true, true, false]);
    expect(byOrigin("scripted")).toEqual([false, false]);
  });

  test("sources: exec is scripted, mcp is peer, any other string is human, Claude Code as originator is peer whatever the source", async () => {
    const cases: [unknown, string | undefined, string, string][] = [
      ["cli", undefined, "human", "cli"],
      ["vscode", undefined, "human", "vscode"],
      ["mcp", undefined, "peer", "mcp"],
      ["exec", undefined, "scripted", "exec"],
      ["exec", "Claude Code", "peer", "exec"],
      [CANARY.prompt, undefined, "human", "other"],
      [{ subagent: "review" }, undefined, "subagent", "subagent"],
      [{ subagent: { thread_spawn: { parent_thread_id: "not-a-uuid", depth: 2, agent_role: CANARY.project } } }, undefined, "subagent", "subagent"],
    ];
    const ids = cases.map(([source, originator], i) => {
      const x = rollout((r) => r.user("go"), { source, ...(originator !== undefined && { originator }) }, fixtureStart() + i * 60_000);
      x.write(h);
      return x.id;
    });
    const r = await run();
    expect(ids.map((id) => [r.store.session(sidOf(id))!.origin, r.store.session(sidOf(id))!.surface])).toEqual(cases.map(([, , o, s]) => [o, s]));
    const deep = r.store.session(sidOf(ids[7]!))!;
    expect(deep).toMatchObject({ parentId: sidOf(keyedHash(r.salt, "not-a-uuid")), spawnDepth: 2, agentType: keyedHash(r.salt, CANARY.project) });
    expect(r.store.session(sidOf(ids[6]!))!.parentId).toBeUndefined();
    expect(r.store.all("prompt").map((p) => p.origin)).toEqual(["human", "human", "peer", "scripted", "peer", "human"]);
    expect(r.coverage[0]!.unknownTypes).toEqual({});
    expectNoCanaries(allEvents(r));
  });
});

describe("codex rollouts: tools", () => {
  test("nested items carry their own outcome, start time and hashed id; commands are classified with the CLI's own parse", async () => {
    const started = fixtureStart() + 10 * 60_000;
    const r1 = rollout((r) => {
      r.cell("await Promise.all([tools.exec_command({ cmd: 'sed -n 1,80p src/a.ts' }), tools.exec_command({ cmd: 'rg -n foo src' })]);");
      r.command("sed -n 1,80p src/a.ts", 0, { parsed: [{ type: "read", cmd: "sed -n 1,80p src/a.ts", name: "a.ts", path: "src/a.ts" }], id: "exec-r", startedAt: started })
        .command("rg -n foo src", 1, { parsed: [{ type: "search", cmd: "rg -n foo src", query: "foo", path: "src" }] })
        .command("ls src", 0, { parsed: [{ type: "list_files", cmd: "ls src", path: "src" }] })
        .command("cat package.json && npm test", 0, { parsed: [{ type: "read", cmd: "cat package.json", name: "package.json", path: "package.json" }, { type: "unknown", cmd: "npm test" }] })
        .command("git status", 0)
        .command("python3 scripts/gen.py", 2, { secs: 0.25 })
        .command("ls", 0, { source: "user_shell" });
    });
    r1.write(h);
    const r = await run();
    const tools = r.store.all("tool");
    expect(tools.map((t) => [t.category, t.ok, t.exit])).toEqual([
      ["read", true, 0], ["search", false, 1], ["search", true, 0], ["test", true, 0], ["git", true, 0], ["shell", false, 2],
    ]);
    expect(tools[0]).toMatchObject({ name: "exec_command", ts: started, ms: 1_000, callId: keyedHash(r.salt, "exec-r") });
    expect(tools[5]).toMatchObject({ ms: 250 });
  });

  test("calls are completed by the item with their call id; items without one are their own events", async () => {
    const r1 = rollout((r) => {
      const v = r.fn("view_image", { path: `${CANARY.path}/shot.png` });
      r.completed({ type: "ImageView", id: v, path: `${CANARY.path}/shot.png` }).fnOutput(v);
      r.completed({ type: "ImageView", id: "img-2", path: `${CANARY.path}/other.png` });
      const w = r.fn("wait_agent", { targets: ["/root/a"] }, { namespace: "collaboration" });
      r.completed({ type: "CollabAgentToolCall", id: w, tool: "wait", status: "completed", sender_thread_id: r.id, receiver_thread_ids: [] });
      r.completed({ type: "CollabAgentToolCall", id: "collab-2", tool: "spawn_agent", status: "failed", sender_thread_id: r.id, receiver_thread_ids: [] });
      const s = r.fn("shell", { command: ["bash", "-lc", "cargo test"] });
      r.fnOutput(s, "ok");
      r.item("local_shell_call", { id: "lsc_1", call_id: "call_ls", status: "completed", action: { type: "exec", command: ["make", "build"] } });
      r.item("web_search_call", { id: "ws_1", status: "completed", action: { type: "search", query: CANARY.prompt } });
      r.completed({ type: "WebSearch", id: "ws_1", query: CANARY.prompt, action: { type: "search" } });
      r.completed({ type: "Extension", kind: "web.search", id: "ext-1", query: CANARY.prompt, action: { type: "search" }, results: [] });
      r.completed({ type: "Extension", kind: "clock.sleep", id: "ext-2" });
      r.fn("update_plan", { plan: [{ step: CANARY.prompt, status: "in_progress" }] });
      r.fn("wait", { cell_id: "3", yield_time_ms: 10_000 });
      r.fn("sleep", { seconds: 30 }, { namespace: "clock" });
      r.fn("frobnicate", { x: 1 }, { namespace: CANARY.project });
    });
    r1.write(h);
    const r = await run();
    expect(toolsByTs(r).map((t) => [t.name, t.category, t.ok])).toEqual([
      ["view_image", "read", undefined], ["view_image", "read", undefined], ["wait_agent", "delegate", true], ["spawn_agent", "delegate", false],
      ["shell", "test", undefined], ["local_shell", "build", undefined], ["web_search", "web", undefined], ["web_search", "web", undefined],
      ["update_plan", "plan", undefined], ["sleep", "schedule", undefined], ["other", "other", undefined],
    ]);
    expectNoCanaries(allEvents(r));
  });

  test("apply_patch: one edit event per file, from the patch text or from the CLI's file changes, never both", async () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: docs/new.md", "+# Title", "+text",
      "*** Update File: src/a.ts", "*** Move to: src/b.ts", "@@", `-${CANARY.code}`, "+one", "+two",
      "*** Delete File: old/c.py",
      "*** End Patch",
    ].join("\n");
    const r1 = rollout((r) => {
      const p = r.custom("apply_patch", patch);
      r.fileChange({ [`${CANARY.path}/docs/new.md`]: { type: "add", content: "# Title\ntext\n" } }, { id: p });
      r.cellOutput(p);
      r.fileChange({
        [`${CANARY.path}/web/App.TSX`]: { type: "update", unified_diff: `--- a/web/App.TSX\n+++ b/web/App.TSX\n${DIFF_4_2}` },
        [`${CANARY.path}/.env`]: { type: "delete", content: `${CANARY.secret}\nK=1\n` },
        [`${CANARY.path}/Makefile`]: { type: "add", content: "all:\n\techo\n" },
      }, { status: "failed" });
    });
    r1.write(h);
    const r = await run();
    expect(toolsByTs(r).map((t) => [t.name, t.category, t.editExt, t.linesAdded, t.linesRemoved, t.ok])).toEqual([
      ["apply_patch", "edit", "md", 2, 0, true], ["apply_patch", "edit", "ts", 2, 1, true], ["apply_patch", "edit", "py", 0, 0, true],
      ["apply_patch", "edit", "tsx", 4, 2, false], ["apply_patch", "edit", undefined, 0, 2, false], ["apply_patch", "edit", undefined, 2, 0, false],
    ]);
    expectNoCanaries(allEvents(r));
  });

  test("MCP calls keep the server name only in mcpServer", async () => {
    const r1 = rollout((r) => {
      r.fn(`mcp__${CANARY.mcp}__lookup_record`, { id: CANARY.secret });
      r.fn("lookup_record", { id: CANARY.secret }, { namespace: `mcp__${CANARY.mcp}__` });
      r.completed({ type: "McpToolCall", id: "mcp-1", server: CANARY.mcp, tool: "lookup_record", status: "completed", arguments: { id: CANARY.secret }, result: CANARY.code, duration: { secs: 0, nanos: 300_000_000 } });
    });
    r1.write(h);
    const r = await run();
    const tools = toolsByTs(r);
    expect(tools.map((t) => [t.name, t.category, t.mcpServer, t.ok, t.ms])).toEqual([
      ["mcp", "mcp", CANARY.mcp, undefined, undefined], ["mcp", "mcp", CANARY.mcp, undefined, undefined], ["mcp", "mcp", CANARY.mcp, true, 300],
    ]);
    expect(findCanaries(tools.map((t) => ({ ...t, mcpServer: undefined })))).toEqual([]);
    expectNoCanaries([...allEvents(r), r.coverage], { allow: ["mcp"] });
  });
});

describe("codex rollouts: turns, usage, rate limits, markers", () => {
  test("turn duration comes from the record or from task_started; effort and model strings are shape-checked", async () => {
    const r1 = rollout((r) => {
      r.done("turn-1");
      r.turn("turn-2", "gpt-5.1-codex", "ultra").aborted("turn-2", "replaced");
      r.turn("turn-3", CANARY.prompt, CANARY.secret).done("turn-3", 500);
    });
    r1.write(h);
    const r = await run();
    expect(r.store.all("turn").map((t) => [t.status, t.ms, t.model, t.effort])).toEqual([
      ["completed", 1_000, CX_MAX, "high"], ["interrupted", 1_000, "gpt-5.1-codex", "ultra"], ["completed", 500, "other", "other"],
    ]);
    expect(r.store.all("marker").map((m) => [m.kind, m.detail])).toEqual([["interrupt", "replaced"]]);
    expect(r.store.session(sidOf(r1.id))!.models).toEqual([CX_MAX, "gpt-5.1-codex", "other"]);
    expectNoCanaries(allEvents(r));
  });

  test("usage: one per token_count with new totals; rate limits per window, deduplicated, with reset times", async () => {
    const at = fixtureStart();
    const r1 = rollout((r) => {
      r.event("token_count", { info: null, rate_limits: rateLimits(at, 5) })
        .tokens({ input: 1_000, cached: 600, output: 50 }, rateLimits(at, 5, 1))
        .repeatLast()
        .tokens({ input: 2_000, cached: 2_500, output: 10 }, null)
        .event("token_count", { info: null, rate_limits: { primary: { used_percent: 7, window_minutes: 300, resets_in_seconds: 600 }, secondary: { used_percent: "x" } } });
    }, {}, at);
    r1.write(h);
    const r = await run();
    expect(r.store.all("usage").map((u) => [u.inTok, u.cacheR, u.outTok, u.cacheW, u.model])).toEqual([[400, 600, 50, 0, CX_MAX], [0, 2_500, 10, 0, CX_MAX]]);
    const lastTs = r.store.session(sidOf(r1.id))!.end;
    expect(r.store.all("ratelimit").map((x) => [x.window, x.usedPercent, x.windowMinutes, x.resetsAt])).toEqual([
      ["primary", 5, 300, (Math.floor(at / 1000) + 7_200) * 1000],
      ["secondary", 1, 10_080, (Math.floor(at / 1000) + 432_000) * 1000],
      ["primary", 7, 300, lastTs + 600_000],
    ]);
  });
});

describe("codex rollouts: drift, ids, locate, errors", () => {
  test("unknown record, payload and item types are drift; names that are not schema tokens (and all item names) are bucketed", async () => {
    const r1 = rollout((r) => {
      r.rec("brand-new-record", { x: CANARY.token })
        .rec(CANARY.prompt, {})
        .item("hologram_call", { call_id: "c", data: CANARY.secret })
        .event("item_completed", { item: { type: "HoloDeck", id: "h1" } })
        .event("item_completed", { item: { type: CANARY.project, id: "h2" } })
        .rec("session_meta", { id: "another" })
        .event("task_complete", { turn_id: "turn-1" });
    });
    r1.records.push({ timestamp: new Date(r1.t).toISOString(), noType: true });
    r1.write(h);
    const r = await run();
    expect(r.coverage[0]).toMatchObject({
      status: "drift",
      unknownTypes: { "brand-new-record": 1, "(other)": 1, "(none)": 1, "response_item:hologram_call": 1, "item:(other)": 2 },
    });
    expect(r.store.all("turn")).toHaveLength(1);
    expect(r.store.all("session")).toHaveLength(1);
    expectNoCanaries([...allEvents(r), r.coverage]);
  });

  test("thread ids that are not UUIDs are hashed; a rollout without a v7 id or a timestamped name has no such facts", async () => {
    const at = fixtureStart();
    const odd = new CxRollout(at, `${CANARY.project}-thread`);
    odd.meta().turn("turn-1").user("hi");
    h.writeJsonl(rolloutRel(at, "x").replace(/rollout-[^/]+$/, "rollout-notes.jsonl"), odd.records);
    const v4 = new CxRollout(at + 60_000, "6f9619ff-8b86-4011-b42d-00c04fc964ff");
    v4.meta().turn("turn-1").user("hello");
    v4.write(h);
    const r = await run();
    const hashed = sidOf(keyedHash(r.salt, `${CANARY.project}-thread`));
    expect(r.store.all("session").map((s) => s.id).sort()).toEqual([hashed, sidOf(v4.id)].sort());
    const facts = r.store.all("codex-rollout");
    expect(facts.find((f) => f.threadId === hashed)).toEqual({ k: "codex-rollout", tool: "codex", source: "codex.rollouts", threadId: hashed });
    expect(facts.find((f) => f.threadId === sidOf(v4.id))).toEqual({ k: "codex-rollout", tool: "codex", source: "codex.rollouts", threadId: sidOf(v4.id), fileTs: v4.fileTs });
    expectNoCanaries(allEvents(r));
  });

  test("no Codex home: absent; an empty one: empty", async () => {
    let r = await run();
    expect(r.coverage).toEqual([expect.objectContaining({ status: "absent", source: "codex.rollouts" })]);
    mkdirSync(path.join(h.env.home, ".codex", "sessions"), { recursive: true });
    r = await run();
    expect(r.coverage[0]).toMatchObject({ status: "empty", files: 0, records: 0 });
  });

  test("CODEX_HOME replaces ~/.codex; archived sessions are read; a thread seen twice is read once", async () => {
    h.env.vars.CODEX_HOME = path.join(h.env.home, "alt-codex");
    const live = rollout((r) => r.user("live"));
    live.write(h, "sessions", "alt-codex");
    live.write(h, "archived_sessions", "alt-codex");
    const archived = rollout((r) => r.user("archived"), {}, fixtureStart() - 86_400_000);
    archived.write(h, "archived_sessions", "alt-codex");
    rollout((r) => r.user("ignored")).write(h);
    const r = await run();
    expect(r.store.all("session").map((s) => s.id)).toEqual([sidOf(live.id), sidOf(archived.id)]);
    expect(r.coverage[0]).toMatchObject({ status: "ok", files: 2, skipped: { duplicate: 1 } });
  });

  test.skipIf(skipChmod)("an unreadable rollout counts as io-error and the scan goes on", async () => {
    rollout((r) => r.user("one")).write(h);
    const bad = rollout((r) => r.user("two")).write(h);
    chmodSync(bad, 0o000);
    try {
      const r = await run();
      expect(r.coverage[0]).toMatchObject({ status: "ok", files: 1, skipped: { "io-error": 1 } });
      expect(r.store.all("session")).toHaveLength(1);
    } finally {
      chmodSync(bad, 0o600);
    }
  });

  test.skipIf(skipChmod)("an unreadable rollout folder makes the source an error; an unreadable day folder is an io-error", async () => {
    const at = fixtureStart();
    rollout((r) => r.user("one"), {}, at).write(h);
    const sessions = path.join(h.env.home, ".codex", "sessions");
    const day = path.dirname(path.join(h.env.home, rolloutRel(at, "x")));
    chmodSync(day, 0o000);
    try {
      const r = await run();
      expect(r.coverage[0]).toMatchObject({ status: "empty", skipped: { "io-error": 1 } });
    } finally {
      chmodSync(day, 0o700);
    }
    chmodSync(sessions, 0o000);
    try {
      const r = await run();
      expect(r.coverage).toEqual([expect.objectContaining({ status: "error", source: "codex.rollouts" })]);
    } finally {
      chmodSync(sessions, 0o700);
    }
  });

  test("a record the mapper cannot handle is counted, logged once, and the file goes on", async () => {
    rollout((r) => r.user("boom").user("fine")).write(h);
    const events: Ev[] = [];
    const logs: [string, string, number | undefined][] = [];
    const salt = new Uint8Array(32);
    const ctx: ScanCtx = {
      env: h.env, now: Date.now(), salt, signal: new AbortController().signal,
      temp: { dir: () => h.root, disposeAll: () => {}, active: 0 },
      emit: (e) => { events.push(e); },
      hash: (v) => { if (v === "boom") throw new Error("injected mapping failure"); return keyedHash(salt, v); },
      registerCwd: (cwd) => keyedHash(salt, cwd),
      log: (level, code, n) => { logs.push([level, code, n]); },
    };
    const [cand] = cxRollouts.locate(h.env, [h.env.home]);
    await cxRollouts.scan(cand!, ctx);
    const cov = events.find((e): e is CoverageEv => e.k === "coverage")!;
    expect(cov.skipped["bad-record"]).toBe(1);
    expect(logs).toEqual([["warn", "cx.bad-record", 1]]);
    expect(events.filter((e) => e.k === "prompt")).toHaveLength(1);
  });
});

describe("uuidV7Ms", () => {
  test("decodes the 48-bit millisecond prefix of a version-7 UUID", () => {
    expect(uuidV7Ms("018f3b2a-1c4d-7e5f-8a9b-0c1d2e3f4a5b")).toBe(0x018f3b2a1c4d);
    expect(uuidV7Ms("018F3B2A-1C4D-7E5F-BA9B-0C1D2E3F4A5B")).toBe(0x018f3b2a1c4d);
    expect(uuidV7Ms(uuidV7(1_715_000_000_123, 7))).toBe(1_715_000_000_123);
  });

  test("anything but a version-7 UUID is undefined", () => {
    for (const s of [
      "018f3b2a-1c4d-4e5f-8a9b-0c1d2e3f4a5b", // version 4
      "018f3b2a-1c4d-7e5f-ca9b-0c1d2e3f4a5b", // not the RFC variant
      "018f3b2a1c4d7e5f8a9b0c1d2e3f4a5b",
      "018f3b2a-1c4d-7e5f-8a9b-0c1d2e3f4a5",
      " 018f3b2a-1c4d-7e5f-8a9b-0c1d2e3f4a5b",
      "",
      "not-a-uuid",
    ]) expect(uuidV7Ms(s)).toBeUndefined();
  });
});

describe("cxToolCalls", () => {
  const fc = (name: string, args: unknown, extra: Record<string, unknown> = {}) => ({ type: "function_call", name, arguments: JSON.stringify(args), call_id: "call_1", ...extra });
  const item = (type: string, fields: Record<string, unknown>) => ({ type, id: "i1", ...fields });
  const one = (name: string, category: string, extra: Record<string, unknown> = {}) => [{ name, category, checks: [], ...extra }];
  const cmd = (script: string, parsed: unknown[]) => item("CommandExecution", { command: ["/bin/zsh", "-lc", script], parsed_cmd: parsed, exit_code: 0, source: "unified_exec_startup" });
  const cases: [string, unknown, unknown][] = [
    ["Code Mode exec cell", { type: "custom_tool_call", name: "exec", input: "await tools.exec_command({ cmd: \"bun test\" })", call_id: "c" }, []],
    ["Code Mode wait", fc("wait", { cell_id: "1", yield_time_ms: 1_000 }), []],
    ["exec_command", fc("exec_command", { cmd: "pnpm lint" }), [{ name: "exec_command", category: "lint", checks: ["lint"] }]],
    ["exec_command without cmd", fc("exec_command", {}), one("exec_command", "shell")],
    ["exec_command with unparseable arguments", { type: "function_call", name: "exec_command", arguments: "{", call_id: "c" }, one("exec_command", "shell")],
    ["shell argv", fc("shell", { command: ["bash", "-lc", "cargo test"] }), [{ name: "shell", category: "test", checks: ["test"] }]],
    ["shell argv without a shell", fc("shell", { command: ["go", "build", "./..."] }), [{ name: "shell", category: "build", checks: ["build"] }]],
    ["shell_command string", fc("shell_command", { command: "git push" }), one("shell_command", "git")],
    ["local shell", { type: "local_shell_call", call_id: "c", status: "completed", action: { type: "exec", command: ["make", "build"] } }, [{ name: "local_shell", category: "build", checks: ["build"] }]],
    ["write_stdin", fc("write_stdin", { session_id: 3, chars: "" }), one("write_stdin", "shell")],
    ["update_plan", fc("update_plan", { plan: [] }), one("update_plan", "plan")],
    ["spawn_agent", fc("spawn_agent", { message: "m" }, { namespace: "collaboration" }), one("spawn_agent", "delegate")],
    ["send_message", fc("send_message", {}, { namespace: "collaboration" }), one("send_message", "delegate")],
    ["followup_task", fc("followup_task", {}, { namespace: "collaboration" }), one("followup_task", "delegate")],
    ["wait_agent", fc("wait_agent", {}, { namespace: "collaboration" }), one("wait_agent", "delegate")],
    ["interrupt_agent", fc("interrupt_agent", {}, { namespace: "collaboration" }), one("interrupt_agent", "delegate")],
    ["list_agents", fc("list_agents", {}, { namespace: "collaboration" }), one("list_agents", "delegate")],
    ["send_input (v1)", fc("send_input", {}), one("send_input", "delegate")],
    ["close_agent (v1)", fc("close_agent", {}), one("close_agent", "delegate")],
    ["resume_agent (v1)", fc("resume_agent", {}), one("resume_agent", "delegate")],
    ["wait for agents (v1)", fc("wait", { ids: ["a"], timeout_ms: 1_000 }), one("wait", "delegate")],
    ["view_image", fc("view_image", { path: "/x.png" }), one("view_image", "read")],
    ["web_search function", fc("web_search", { query: "x" }), one("web_search", "web")],
    ["web_search_call", { type: "web_search_call", status: "completed", action: { type: "search", query: "x" } }, one("web_search", "web")],
    ["the CLI's web namespace", fc("run", { query: "x" }, { namespace: "web" }), one("web_search", "web")],
    ["sleep", fc("sleep", { seconds: 5 }, { namespace: "clock" }), one("sleep", "schedule")],
    ["imagegen", fc("imagegen", { prompt: "x" }, { namespace: "image_gen" }), one("imagegen", "other")],
    ["request_user_input_async", fc("request_user_input_async", {}), one("request_user_input_async", "other")],
    ["read_mcp_resource", fc("read_mcp_resource", { server: "s", uri: "u" }), one("read_mcp_resource", "mcp")],
    ["mcp by name", fc("mcp__docs__search", {}), one("mcp", "mcp", { mcpServer: "docs" })],
    ["mcp by namespace", fc("search", {}, { namespace: "mcp__docs__" }), one("mcp", "mcp", { mcpServer: "docs" })],
    ["server__tool name (older CLIs)", fc("docs__search", {}), one("mcp", "mcp", { mcpServer: "docs" })],
    ["unknown tool", fc("frobnicate", {}), one("other", "other")],
    ["unknown namespaced tool", fc("frobnicate", {}, { namespace: "acme" }), one("other", "other")],
    ["a built-in's name in another namespace", fc("update_plan", {}, { namespace: "acme" }), one("other", "other")],
    ["apply_patch freeform", { type: "custom_tool_call", name: "apply_patch", call_id: "c", input: "*** Begin Patch\n*** Update File: a/b.rs\n@@\n-x\n+y\n+z\n*** End Patch\n" }, [{ name: "apply_patch", category: "edit", checks: [], editExt: "rs", added: 2, removed: 1 }]],
    ["apply_patch function", fc("apply_patch", { input: "*** Begin Patch\r\n*** Add File: Dockerfile\r\n+FROM x\r\n*** End Patch" }), [{ name: "apply_patch", category: "edit", checks: [], added: 1, removed: 0 }]],
    ["apply_patch without files", { type: "custom_tool_call", name: "apply_patch", call_id: "c", input: "garbage" }, []],
    ["command: read", cmd("sed -n 1,80p src/a.ts", [{ type: "read", cmd: "sed", name: "a.ts", path: "src/a.ts" }]), one("exec_command", "read")],
    ["command: search", cmd("rg foo", [{ type: "search", cmd: "rg foo", query: "foo" }]), one("exec_command", "search")],
    ["command: list files", cmd("ls -la", [{ type: "list_files", cmd: "ls -la" }]), one("exec_command", "search")],
    ["command: read then search", cmd("cat a; rg b", [{ type: "read", cmd: "cat a" }, { type: "search", cmd: "rg b" }]), one("exec_command", "search")],
    ["command: read and a test", cmd("cat a && npm test", [{ type: "read", cmd: "cat a" }, { type: "unknown", cmd: "npm test" }]), [{ name: "exec_command", category: "test", checks: ["test"] }]],
    ["command: a test parsed as read", cmd("bun test src/a.test.ts", [{ type: "read", cmd: "bun test src/a.test.ts" }]), [{ name: "exec_command", category: "test", checks: ["test"] }]],
    ["command: unknown", cmd("python3 x.py", [{ type: "unknown", cmd: "python3 x.py" }]), one("exec_command", "shell")],
    ["command: no parse", item("CommandExecution", { command: ["/bin/bash", "-c", "docker ps"] }), one("exec_command", "container")],
    ["command: string", item("CommandExecution", { command: "npm run build" }), [{ name: "exec_command", category: "build", checks: ["build"] }]],
    ["command run by the person", item("CommandExecution", { command: ["/bin/zsh", "-lc", "ls"], source: "user_shell" }), []],
    ["file change", item("FileChange", { changes: { "/p/a.md": { type: "add", content: "a\nb\nc\n" }, "/p/b.ts": { type: "update", unified_diff: "@@ -1 +1 @@\n-x\n+y\n" }, "/p/.env": { type: "delete", content: "K=1\nJ=2" } } }), [
      { name: "apply_patch", category: "edit", checks: [], editExt: "md", added: 3, removed: 0 },
      { name: "apply_patch", category: "edit", checks: [], editExt: "ts", added: 1, removed: 1 },
      { name: "apply_patch", category: "edit", checks: [], added: 0, removed: 2 },
    ]],
    ["file change without changes", item("FileChange", { changes: [] }), []],
    ["MCP item", item("McpToolCall", { server: "docs", tool: "search", status: "completed" }), one("mcp", "mcp", { mcpServer: "docs" })],
    ["MCP item without a server", item("McpToolCall", { tool: "search" }), one("mcp", "mcp")],
    ["image view", item("ImageView", { path: "/x.png" }), one("view_image", "read")],
    ["extension: web search", item("Extension", { kind: "web.search", query: "x" }), one("web_search", "web")],
    ["extension: other", item("Extension", { kind: "clock.sleep" }), []],
    ["collab item", item("CollabAgentToolCall", { tool: "spawn_agent", status: "completed" }), one("spawn_agent", "delegate")],
    ["collab item of an unknown tool", item("CollabAgentToolCall", { tool: CANARY.project }), one("other", "delegate")],
    ["dynamic tool item", item("DynamicToolCall", { tool: CANARY.project }), one("other", "other")],
    ["web search item (its call is the web_search_call)", item("WebSearch", { query: "x" }), []],
    ["reasoning item", item("Reasoning", {}), []],
    ["message", { type: "message", role: "user", content: [] }, []],
    ["not an object", "exec", []],
  ];
  for (const [name, input, want] of cases) test(name, () => expect(cxToolCalls(input)).toEqual(want as never));

  test("patchFiles: per-file counts and extensions from apply_patch text", () => {
    expect(patchFiles("*** Begin Patch\n*** Add File: docs/new.md\n+# T\n+x\n*** Update File: src/a.ts\n*** Move to: src/b.ts\n@@ ctx\n-old\n+new\n+more\n*** End of File\n*** Delete File: old/c.py\n*** End Patch\n")).toEqual([
      { ext: "md", added: 2, removed: 0 }, { ext: "ts", added: 2, removed: 1 }, { ext: "py", added: 0, removed: 0 },
    ]);
    expect(patchFiles("no headers\n+x")).toEqual([]);
  });
});
