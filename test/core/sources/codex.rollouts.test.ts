import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import type { CoverageEv, Ev } from "../../../core/model/events";
import { scan } from "../../../core/scan";
import { cxRollouts } from "../../../core/sources/codex";
import { cxToolCalls, patchFiles } from "../../../core/sources/codex/tools";
import { uuidV7Ms } from "../../../core/sources/codex/uuid";
import type { ScanCtx, PluginCoverage } from "../../../core/sources/types";
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
    // each reading, and each file fact, still names the rollout's session (the scope rules treat it like its session)
    const sessions = new Set(r.store.all("session").map((x) => x.id));
    for (const x of [...r.store.all("ratelimit"), ...r.store.all("file")]) expect(sessions.has(x.sessionId!)).toBe(true);
    expect(r.store.forSession(r3, "ratelimit").map((x) => x.usedPercent)).toEqual([41]);
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
    expect(r.store.forSession(r1, "marker").map((m) => [m.kind, m.detail])).toEqual([["interrupt", "user"], ["compact-auto", undefined]]);
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
      name: "exec_command", category: "build", checks: ["build"], toolchain: "js", ok: true, exit: 0, ms: 12_000,
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
      skipped: { sniffed: fx.heavy }, unknownTypes: { "event_msg:(other)": 1 }, versions: ["0.168.0", "0.169.0"],
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
        `<user_action>\n  <context>User initiated a review task. Here's the full review output from reviewer model.</context>\n  <action>review</action>\n  <results>\n  ${CANARY.code}\n  </results>\n  </user_action>`,
        "<user_action>\n  <context>User initiated a review task, but was interrupted.</context>\n  <action>review</action>\n  <results>\n  None.\n  </results>\n</user_action>",
        `<realtime_delegation>\n<input>${CANARY.prompt}</input>\n</realtime_delegation>`,
        "<current_time_reminder>It is now later than you think.</current_time_reminder>",
        `<agent_message_board_notification>${CANARY.prompt}</agent_message_board_notification>`,
        `<EXTERNAL SESSION IMPORTED>\n${CANARY.prompt}`,
        `<image name=[Image #1]>${CANARY.secret}</image>`,
        "<image_resize_notice>\nImage 1 in the preceding user message was resized from 4000x3000 pixels.\n</image_resize_notice>",
        "   ",
      ]) r.user(injected);
      r.user("<image name=[Image #1]>", IMAGE, "</image>", IMAGE, "What is wrong in this screenshot?")
        .user("<image name=[Image #1]>", IMAGE, "</image>")
        .user("<image name=[Image #2]>", IMAGE, "</image>", "<image_resize_notice>\nImage 2 in the preceding user message was resized from 4000x3000 pixels.\n</image_resize_notice>", "Crop the header")
        .user("<image name=[Image #3]>", IMAGE, "</image>", "Blur the faces", "<image_resize_notice>\nImage 3 in the preceding user message was resized from 4000x3000 pixels.\n</image_resize_notice>")
        .user("<send_user_message_question_reply>\nUse the second option.\n</send_user_message_question_reply>")
        .user("<notes>keep both</notes> and refactor the parser", "with tests")
        .user("<skills-list> renders twice")
        .user("<image_gallery> needs lazy loading")
        .user("<user_actions> table is empty");
    });
    r1.write(h);
    const r = await run();
    const prompts = r.store.all("prompt");
    expect(prompts.map((p) => p.textHash)).toEqual([
      keyedHash(r.salt, "What is wrong in this screenshot?"),
      keyedHash(r.salt, "Crop the header"),
      keyedHash(r.salt, "Blur the faces"),
      keyedHash(r.salt, "Use the second option."),
      keyedHash(r.salt, "<notes>keep both</notes> and refactor the parser\nwith tests"),
      keyedHash(r.salt, "<skills-list> renders twice"),
      keyedHash(r.salt, "<image_gallery> needs lazy loading"),
      keyedHash(r.salt, "<user_actions> table is empty"),
    ]);
    expect(prompts.map((p) => p.hasPaste)).toEqual([true, true, true, undefined, undefined, undefined, undefined, undefined]);
    expect(prompts[0]!.features.hasContext).toBe(true);
    expect(prompts.map((p) => p.intent)).toEqual(["question", "spec", "spec", "spec", "spec", "spec", "spec", "spec"]);
    expectNoCanaries(allEvents(r));
  });

  test("a subagent thread stays a subagent with no prompts, even when Claude Code drives Codex", async () => {
    const parent = "0190f1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b";
    const x = rollout((r) => r.user("Look into the importer and report back."), {
      source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_role: "explorer" } } }, originator: "Claude Code",
    });
    x.write(h);
    const r = await run();
    expect(r.store.session(sidOf(x.id))).toMatchObject({ origin: "subagent", parentId: sidOf(parent), surface: "subagent" });
    expect(r.store.all("prompt")).toEqual([]);
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
  test("nested items carry their own outcome, start time and hashed id; commands are classified by classifyCommand alone", async () => {
    const started = fixtureStart() + 10 * 60_000;
    const notes = `${CANARY.path}/notes.md`;
    const r1 = rollout((r) => {
      r.cell(`await Promise.all([tools.exec_command({ cmd: "cat ${notes}" }), tools.exec_command({ cmd: "rg -n '${CANARY.prompt}' ${CANARY.path}" })]);`);
      r.command(`cat ${notes}`, 0, { parsed: [{ type: "read", cmd: `cat ${notes}`, name: CANARY.project, path: notes }], id: "exec-r", startedAt: started })
        .command(`rg -n '${CANARY.prompt}' ${CANARY.path}`, 1, { parsed: [{ type: "search", cmd: `rg -n '${CANARY.prompt}'`, query: CANARY.prompt, path: CANARY.path }] })
        .command("ls src", 0, { parsed: [{ type: "list_files", cmd: "ls src", path: "src" }] })
        .command("sed -n 1,80p src/a.ts", 0, { parsed: [{ type: "read", cmd: "sed -n 1,80p src/a.ts", name: "a.ts", path: "src/a.ts" }] })
        .command("cat package.json && npm test", 0, { parsed: [{ type: "read", cmd: "cat package.json", name: "package.json", path: "package.json" }, { type: "unknown", cmd: "npm test" }] })
        .command(`git commit -m "${CANARY.prompt}"`, 0)
        .command(`python3 ${CANARY.path}/gen.py --token ${CANARY.token}`, 2, { secs: 0.25 })
        .command("ls", 0, { source: "user_shell" });
    });
    r1.write(h);
    const r = await run();
    const tools = r.store.all("tool");
    expect(tools.map((t) => [t.category, t.ok, t.exit])).toEqual([
      ["read", true, 0], ["search", false, 1], ["read", true, 0], ["shell", true, 0], ["test", true, 0], ["git", true, 0], ["shell", false, 2],
    ]);
    expect(tools[0]).toMatchObject({ name: "exec_command", ts: started, ms: 1_000, callId: keyedHash(r.salt, "exec-r") });
    expect(tools[6]).toMatchObject({ ms: 250 });
    expectNoCanaries([...allEvents(r), r.coverage]);
  });

  test("an item seen twice, or before its call, is one tool event", async () => {
    const r1 = rollout((r) => {
      r.command("bun test", 0, { id: "exec-twice" }).repeatLast();
      r.command("npm run build", 1, { id: "call_early" });
      r.fn("exec_command", { cmd: "npm run build" }, { callId: "call_early" });
    });
    r1.write(h);
    const r = await run();
    expect(r.store.all("tool").map((t) => [t.callId, t.category, t.ok])).toEqual([
      [keyedHash(r.salt, "exec-twice"), "test", true], [keyedHash(r.salt, "call_early"), "build", false],
    ]);
  });

  test("FileChange items of one shape on different files in one turn (a Code Mode loop) all count: items dedupe by id, never by shape", async () => {
    const diff = "@@ -1,3 +1,3 @@\n-a\n-b\n-c\n+x\n+y\n+z\n";
    const r1 = rollout((r) => {
      r.cell("for (const f of files) await tools.apply_patch(patchFor(f));");
      r.fileChange({ "/p/src/a.ts": { type: "update", unified_diff: diff } }, { id: "fc-a" })
        .fileChange({ "/p/src/b.ts": { type: "update", unified_diff: diff } }, { id: "fc-b" })
        .fileChange({ "/p/src/b.ts": { type: "update", unified_diff: diff } }, { id: "fc-b" }); // the same item again: once
    });
    r1.write(h);
    const r = await run();
    expect(r.store.all("tool").map((t) => [t.callId, t.category, t.editExt, t.linesAdded, t.linesRemoved])).toEqual([
      [keyedHash(r.salt, "fc-a"), "edit", "ts", 3, 3], [keyedHash(r.salt, "fc-b"), "edit", "ts", 3, 3],
    ]);
  });

  test("a call completed by the command that ran takes that command's category and checks", async () => {
    const r1 = rollout((r) => {
      const c = r.fn("exec_command", { yield_time_ms: 1_000 });
      r.command("npm test", 0, { id: c });
    });
    r1.write(h);
    const r = await run();
    expect(r.store.all("tool")).toEqual([expect.objectContaining({ name: "exec_command", category: "test", checks: ["test"], toolchain: "js", ok: true, exit: 0 })]);
  });

  test("a check's toolchain: from the call's command line, or from the command that ran when the call named none", async () => {
    const r1 = rollout((r) => {
      const named = r.fn("exec_command", { cmd: "pytest -q" });
      r.command("pytest -q", 1, { id: named });
      const bare = r.fn("exec_command", { yield_time_ms: 1_000 });
      r.command("pytest", 0, { id: bare });
      r.command("cargo clippy", 0);
      r.command("git status", 0);
    });
    r1.write(h);
    const r = await run();
    expect(toolsByTs(r).map((t) => [t.category, t.checks, t.toolchain, t.ok])).toEqual([
      ["test", ["test"], "py", false], ["test", ["test"], "py", true], ["lint", ["lint"], "rust", true], ["git", undefined, undefined, true],
    ]);
  });

  test("a shell call that runs apply_patch is the patch: one edit per file, from argv[1] or the heredoc; a deleted file's removed lines are unknown", async () => {
    const patch = "*** Begin Patch\n*** Update File: a.py\n+x\n*** End Patch";
    const r1 = rollout((r) => {
      r.fn("shell", { command: ["apply_patch", patch] });
      r.fn("shell_command", { command: "apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: docs/n.md\n+# T\n+x\n*** Update File: src/b.ts\n@@\n-old\n+new\n*** End Patch\nEOF\n" });
      r.fn("shell", { command: ["bash", "-lc", "apply_patch <<\"PATCH\"\n*** Begin Patch\n*** Delete File: old/c.go\n*** End Patch\nPATCH"] });
      r.item("local_shell_call", { call_id: "ls-1", status: "completed", action: { type: "exec", command: ["apply_patch", "*** Begin Patch\n*** Update File: d.rs\n-a\n*** End Patch"] } });
      r.fn("exec_command", { cmd: "apply_patch '*** Begin Patch\n*** Update File: e.kt\n+y\n*** End Patch'" });
    });
    r1.write(h);
    const r = await run();
    expect(toolsByTs(r).map((t) => [t.name, t.category, t.editExt, t.linesAdded, t.linesRemoved, t.checks])).toEqual([
      ["apply_patch", "edit", "py", 1, 0, undefined],
      ["apply_patch", "edit", "md", 2, 0, undefined], ["apply_patch", "edit", "ts", 1, 1, undefined],
      ["apply_patch", "edit", "go", 0, undefined, undefined],
      ["apply_patch", "edit", "rs", 0, 1, undefined],
      ["apply_patch", "edit", "kt", 1, 0, undefined],
    ]);
    expect(toolsByTs(r).find((t) => t.editExt === "go")).not.toHaveProperty("linesRemoved");
  });

  test("a shell call that runs apply_patch, completed by the CLI's file change under the call's id, is one edit per file", async () => {
    const r1 = rollout((r) => {
      const p = r.fn("exec_command", { cmd: "apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n+more\n*** Add File: b.md\n+x\n*** End Patch\nEOF" });
      r.fileChange({
        [`${CANARY.path}/src/a.ts`]: { type: "update", unified_diff: "@@ -1 +1,2 @@\n-old\n+new\n+more\n" },
        [`${CANARY.path}/b.md`]: { type: "add", content: "x\n" },
      }, { id: p });
    });
    r1.write(h);
    const r = await run();
    expect(toolsByTs(r).map((t) => [t.name, t.category, t.editExt, t.linesAdded, t.linesRemoved, t.ok])).toEqual([
      ["apply_patch", "edit", "ts", 2, 1, true], ["apply_patch", "edit", "md", 1, 0, true],
    ]);
    expectNoCanaries(allEvents(r));
  });

  test("a line whose time is well-formed but implausible counts once, as bad-ts; one without a time is drift and no-ts", async () => {
    const r1 = rollout((r) => {
      r.user("Fix the importer");
      r.user("a prompt stamped 1990");
      r.records.at(-1)!.timestamp = "1990-01-01T00:00:00.000Z";
      r.user("a prompt without a time");
      delete r.records.at(-1)!.timestamp;
      r.user("And add a test").done("turn-1");
    });
    r1.write(h);
    const r = await run();
    const cov = r.coverage[0]!;
    expect(cov.skipped).toEqual({ "bad-ts": 1, "no-ts": 1 });
    expect(cov.unknownTypes).toEqual({ "timestamp:shape": 1 });
    expect(r.store.all("prompt")).toHaveLength(2);
  });

  test("input sent to a running command updates its call or is skipped; it is never a new command", async () => {
    const r1 = rollout((r) => {
      const w = r.fn("write_stdin", { session_id: 3, chars: "" });
      r.command("npm run dev", 0, { id: w, source: "unified_exec_interaction" });
      r.command("npm test", 0, { source: "unified_exec_interaction" });
    });
    r1.write(h);
    const r = await run();
    expect(r.store.all("tool")).toEqual([expect.objectContaining({ name: "write_stdin", category: "shell", ok: true, exit: 0 })]);
    expect(r.coverage[0]!.skipped).toMatchObject({ "exec-interaction": 1 });
  });

  test("items another thread recorded are not this session's", async () => {
    const other = "0190f1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b";
    const r1 = rollout((r) => {
      r.event("item_completed", { thread_id: other, turn_id: "turn-1", started_at_ms: r.t, item: { type: "CommandExecution", id: "exec-o", command: ["/bin/zsh", "-lc", "bun test"], exit_code: 0, source: "unified_exec_startup" } });
      r.completed({ type: "CollabAgentToolCall", id: "collab-o", tool: "spawn_agent", status: "completed", sender_thread_id: other });
      r.command("bun test", 0);
    });
    r1.write(h);
    const r = await run();
    expect(r.store.all("tool").map((t) => t.name)).toEqual(["exec_command"]);
    expect(r.coverage[0]!.skipped).toMatchObject({ "foreign-item": 2 });
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
      // a patch's deleted file: its removed lines are not in the patch, so unknown (a file change's delete holds them)
      ["apply_patch", "edit", "md", 2, 0, true], ["apply_patch", "edit", "ts", 2, 1, true], ["apply_patch", "edit", "py", 0, undefined, true],
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

  test("command events with and without a command line are counted once per root (debug logs)", async () => {
    buildCodexRollouts(h); // four commands, each with its command line: two Code Mode cells, an exec_command call and its item, a subagent's cell
    rollout((r) => {
      r.fnOutput(r.fn("exec_command", { yield_time_ms: 1_000 }));               // names no command, and nothing completes it
      r.command(CANARY.code, 0, { id: r.fn("exec_command", {}) });               // named by the command item that completes it
      r.item("local_shell_call", { call_id: "ls-1", status: "completed", action: { type: "exec", command: [] } }); // an empty argv
      r.fn("write_stdin", { session_id: 3, chars: "" });                          // input to a running command: not a command
      r.command("ls", 0, { source: "user_shell" });                               // the person's own command: not a tool event
    }).write(h);
    const other = path.join(h.root, "home2");
    rollout((r) => { r.fn("shell", { command: 42 }); }).write(h, "sessions", path.relative(h.env.home, path.join(other, ".codex")));
    const logs: [string, string, number | undefined][] = [];
    const r = await scan({ env: { ...h.env, wslHomes: [other] }, wsl: true, plugins: [cxRollouts], onLog: (level, code, n) => logs.push([level, code, n]) });
    expect(r.coverage.map((c) => c.status).sort()).toEqual(["drift", "ok"]); // the Task 11 scenario has an unknown event type
    expect(logs.filter(([, code]) => code.startsWith("codex.cmd-")).sort()).toEqual([
      ["debug", "codex.cmd-extracted", 0], ["debug", "codex.cmd-extracted", 5], ["debug", "codex.cmd-missing", 1], ["debug", "codex.cmd-missing", 2],
    ]);
    expectNoCanaries(logs);
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

  test("every turn_aborted reason is an interrupt with its own detail: the person's (user, replaced) apart from the tool's", async () => {
    const r1 = rollout((r) => {
      for (const [i, reason] of ["interrupted", "replaced", "review_ended", "budget_limited", "brand_new_reason"].entries()) r.turn(`t${i}`).aborted(`t${i}`, reason);
      r.turn("t9").event("turn_aborted", { turn_id: "t9" }); // no reason at all
    });
    r1.write(h);
    const r = await run();
    expect(r.store.all("marker").map((m) => [m.kind, m.detail])).toEqual([
      ["interrupt", "user"], ["interrupt", "replaced"], ["interrupt", "review-ended"], ["interrupt", "budget-limited"], ["interrupt", "other"], ["interrupt", "other"],
    ]);
    expect(r.store.all("turn").map((t) => t.status)).toEqual(Array(6).fill("interrupted"));
  });

  test("a command or patch the person declined never ran: outcome denied, no ok or exit, and a denial marker", async () => {
    const r1 = rollout((r) => {
      r.completed({ type: "CommandExecution", id: "exec-d", command: ["/bin/zsh", "-lc", "npm test"], source: "unified_exec_startup", status: "declined" });
      r.fileChange({ [`${CANARY.path}/a.ts`]: { type: "update", unified_diff: "@@ -1 +1 @@\n-x\n+y\n" } }, { status: "declined" });
      r.command("npm test", 1);
    });
    r1.write(h);
    const r = await run();
    expect(toolsByTs(r).map((t) => [t.category, t.outcome, t.ok, t.exit])).toEqual([
      ["test", "denied", undefined, undefined], ["edit", "denied", undefined, undefined], ["test", undefined, false, 1],
    ]);
    expect(r.store.all("marker").map((m) => [m.kind, m.detail])).toEqual([["denial", "user"], ["denial", "user"]]);
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

describe("codex rollouts: forks and rate-limit buckets", () => {
  test("copied history is skipped for a fork of any source; usage and rate limits re-emitted at the fork point are not new", async () => {
    const parent = "0190f1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b";
    const at = fixtureStart();
    const x = new CxRollout(at, uuidV7(at - 1000, 0x77), { source: "vscode", extra: { forked_from_id: parent, history_mode: "paginated" } });
    x.meta();
    // lines copied from the parent come first
    x.rec("session_meta", { id: parent, source: "cli" })
      .turn("turn-1", "gpt-5.0-codex", "high")
      .user(`Fix the importer. ${CANARY.prompt}`);
    const c = x.cell(`await tools.exec_command({ cmd: "bun test" });`);
    x.command("bun test", 1).cellOutput(c)
      .tokens({ input: 9_000, cached: 1_000, output: 100 }, rateLimits(at, 40))
      .aborted("turn-1", "interrupted", 1_000);
    const copiedTokens = structuredClone(x.records[x.records.length - 2]!.payload);
    (x.records[0]!.payload as Record<string, unknown>).subagent_history_start_ordinal = x.nextOrdinal;
    // the thread's own lines: the CLI re-emits the fork point's token_count before any new response
    x.turn("turn-2", CX_MINI, "medium")
      .rec("event_msg", copiedTokens)
      .user("Now add a regression test.")
      .tokens({ input: 2_000, cached: 500, output: 50 }, rateLimits(at, 41));
    x.write(h);
    const r = await run();
    expect(r.store.session(sidOf(x.id))).toMatchObject({ origin: "human", models: [CX_MINI] });
    expect(r.store.all("prompt").map((p) => p.textHash)).toEqual([keyedHash(r.salt, "Now add a regression test.")]);
    expect(r.store.all("tool")).toEqual([]);
    expect(r.store.all("marker")).toEqual([]);
    expect(r.store.all("usage").map((u) => [u.inTok, u.cacheR, u.outTok])).toEqual([[1_500, 500, 50]]);
    expect(r.store.all("ratelimit").map((l) => l.usedPercent)).toEqual([41]);
    expectNoCanaries(allEvents(r));
  });

  test("rate limits carry their bucket (a keyed hash of limit_id) and are deduplicated per bucket and window", async () => {
    const at = fixtureStart();
    const limits = (bucket: unknown, primary: number) => ({ ...rateLimits(at, primary), limit_id: bucket });
    const x = rollout((r) => {
      r.event("token_count", { info: null, rate_limits: limits("codex", 10) })
        .event("token_count", { info: null, rate_limits: limits("codex_mini", 3) })
        .event("token_count", { info: null, rate_limits: limits("codex", 10) })
        .event("token_count", { info: null, rate_limits: limits("codex_mini", 3) })
        .event("token_count", { info: null, rate_limits: limits(CANARY.prompt, 7) })
        .event("token_count", { info: null, rate_limits: limits(null, 8) });
    }, {}, at);
    x.write(h);
    const r = await run();
    expect(r.store.all("ratelimit").map((l) => [l.bucket, l.usedPercent])).toEqual([[keyedHash(r.salt, "codex"), 10], [keyedHash(r.salt, "codex_mini"), 3], [keyedHash(r.salt, CANARY.prompt), 7], [undefined, 8]]);
    expectNoCanaries(allEvents(r));
  });
});

describe("codex rollouts: drift, ids, locate, errors", () => {
  test("unknown record, payload and item types are drift; their names are never echoed", async () => {
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
      unknownTypes: { "(other)": 2, "(none)": 1, "response_item:(other)": 1, "item:(other)": 2 },
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
    const events: (Ev | PluginCoverage)[] = [];
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
    expect(logs.filter(([level]) => level === "warn")).toEqual([["warn", "cx.bad-record", 1]]);
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
  /** A shell command: its category and checks, and whether a command line was found (`commandLine`). */
  const ran = (name: string, category: string, checks: string[] = [], commandLine = true) => [{ name, category, checks, commandLine }];
  /** A shell command that runs a check: its category, checks and the toolchain of the command that produced the first. */
  const check = (name: string, category: string, checks: string[], toolchain: string) => [{ name, category, checks, toolchain, commandLine: true }];
  /** The edits a patch makes, as apply_patch's: one per file. */
  const edits = (...files: Record<string, unknown>[]) => files.map((f) => ({ name: "apply_patch", category: "edit", checks: [], ...f }));
  const PATCH_PY = "*** Begin Patch\n*** Update File: a.py\n+x\n*** End Patch";
  const cmd = (script: string, parsed: unknown[]) => item("CommandExecution", { command: ["/bin/zsh", "-lc", script], parsed_cmd: parsed, exit_code: 0, source: "unified_exec_startup" });
  const cases: [string, unknown, unknown][] = [
    ["Code Mode exec cell", { type: "custom_tool_call", name: "exec", input: "await tools.exec_command({ cmd: \"bun test\" })", call_id: "c" }, []],
    ["Code Mode wait", fc("wait", { cell_id: "1", yield_time_ms: 1_000 }), []],
    ["exec_command", fc("exec_command", { cmd: "pnpm lint" }), check("exec_command", "lint", ["lint"], "js")],
    ["exec_command without cmd", fc("exec_command", {}), ran("exec_command", "shell", [], false)],
    ["exec_command with unparseable arguments", { type: "function_call", name: "exec_command", arguments: "{", call_id: "c" }, ran("exec_command", "shell", [], false)],
    ["exec_command with a blank cmd", fc("exec_command", { cmd: "  \n" }), ran("exec_command", "shell", [], false)],
    ["shell argv", fc("shell", { command: ["bash", "-lc", "cargo test"] }), check("shell", "test", ["test"], "rust")],
    ["shell argv without a shell", fc("shell", { command: ["go", "build", "./..."] }), check("shell", "build", ["build"], "go")],
    ["shell argv that is not all strings", fc("shell", { command: ["bash", "-lc", 7] }), ran("shell", "shell", [], false)],
    ["shell_command string", fc("shell_command", { command: "git push" }), ran("shell_command", "git")],
    ["local shell", { type: "local_shell_call", call_id: "c", status: "completed", action: { type: "exec", command: ["make", "build"] } }, check("local_shell", "build", ["build"], "any")],
    ["local shell without an action", { type: "local_shell_call", call_id: "c", status: "completed" }, ran("local_shell", "shell", [], false)],
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
    ["request_user_input_async", fc("request_user_input_async", {}), one("request_user_input_async", "meta")],
    ["request_user_input", fc("request_user_input", {}), one("request_user_input", "meta")],
    ["current_time", fc("current_time", {}, { namespace: "clock" }), one("current_time", "meta")],
    ["js_repl is work, not bookkeeping", fc("js_repl", { code: "1" }), one("js_repl", "other")],
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
    // a shell call whose command starts with the word apply_patch is the CLI's patch tool: the patch from argv[1] or the heredoc
    ["shell running apply_patch (argv)", fc("shell", { command: ["apply_patch", PATCH_PY] }), edits({ editExt: "py", added: 1, removed: 0 })],
    ["shell_command running apply_patch with a heredoc", fc("shell_command", { command: `apply_patch <<'EOF'\n${PATCH_PY}\nEOF\n` }), edits({ editExt: "py", added: 1, removed: 0 })],
    ["exec_command running apply_patch through a shell, <<- heredoc", fc("exec_command", { cmd: ["bash", "-lc", "apply_patch <<-EOF\n*** Begin Patch\n*** Delete File: gone.md\n*** End Patch\n\tEOF"] }), edits({ editExt: "md", added: 0 })],
    ["local shell running apply_patch", { type: "local_shell_call", call_id: "c", status: "completed", action: { type: "exec", command: ["apply_patch", PATCH_PY] } }, edits({ editExt: "py", added: 1, removed: 0 })],
    ["apply_patch with the patch after the word", fc("shell_command", { command: `apply_patch '${PATCH_PY}'` }), edits({ editExt: "py", added: 1, removed: 0 })],
    ["a command executed as apply_patch", item("CommandExecution", { command: ["/bin/zsh", "-lc", `apply_patch <<"P"\n${PATCH_PY}\nP`] }), edits({ editExt: "py", added: 1, removed: 0 })],
    ["apply_patch without a patch", fc("shell", { command: ["apply_patch"] }), []],
    ["apply_patch later in the line is a command", fc("shell_command", { command: `cd x && apply_patch <<'EOF'\n${PATCH_PY}\nEOF` }), ran("shell_command", "shell")],
    ["a word that starts like apply_patch is a command", fc("exec_command", { cmd: "apply_patches --dry-run" }), ran("exec_command", "shell")],
    ["a here-string is no heredoc", fc("shell_command", { command: `apply_patch <<< '${PATCH_PY}'` }), edits({ editExt: "py", added: 1, removed: 0 })],
    ["command: sed is not a reader", cmd("sed -n 1,80p src/a.ts", [{ type: "read", cmd: "sed", name: "a.ts", path: "src/a.ts" }]), ran("exec_command", "shell")],
    ["command: search", cmd("rg foo", [{ type: "search", cmd: "rg foo", query: "foo" }]), ran("exec_command", "search")],
    ["command: list files", cmd("ls -la", [{ type: "list_files", cmd: "ls -la" }]), ran("exec_command", "read")],
    ["command: read then search", cmd("cat a; rg b", [{ type: "read", cmd: "cat a" }, { type: "search", cmd: "rg b" }]), ran("exec_command", "read")],
    ["command: read and a test", cmd("cat a && npm test", [{ type: "read", cmd: "cat a" }, { type: "unknown", cmd: "npm test" }]), check("exec_command", "test", ["test"], "js")],
    ["command: a test parsed as read", cmd("bun test src/a.test.ts", [{ type: "read", cmd: "bun test src/a.test.ts" }]), check("exec_command", "test", ["test"], "js")],
    ["command: unknown", cmd("python3 x.py", [{ type: "unknown", cmd: "python3 x.py" }]), ran("exec_command", "shell")],
    ["command: no parse", item("CommandExecution", { command: ["/bin/bash", "-c", "docker ps"] }), ran("exec_command", "container")],
    ["command: string", item("CommandExecution", { command: "npm run build" }), check("exec_command", "build", ["build"], "js")],
    ["command: none recorded", item("CommandExecution", { exit_code: 0 }), ran("exec_command", "shell", [], false)],
    ["command run by the person", item("CommandExecution", { command: ["/bin/zsh", "-lc", "ls"], source: "user_shell" }), []],
    ["input sent to a running command", item("CommandExecution", { command: ["/bin/zsh", "-lc", "npm test"], source: "unified_exec_interaction", exit_code: 0 }), []],
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
      { ext: "md", added: 2, removed: 0 }, { ext: "ts", added: 2, removed: 1 }, { ext: "py", added: 0 },
    ]);
    expect(patchFiles("no headers\n+x")).toEqual([]);
  });

  test("patchFiles: a deleted file adds nothing and its removed lines are unknown — absent, never 0", () => {
    const [deleted] = patchFiles("*** Begin Patch\n*** Delete File: old/c.go\n+stray\n-stray\n*** End Patch");
    expect(deleted).toEqual({ ext: "go", added: 0 });
    expect(deleted).not.toHaveProperty("removed");
  });
});
