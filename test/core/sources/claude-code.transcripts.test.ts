import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import type { CoverageEv, Ev, ToolEv } from "../../../core/model/events";
import { scan } from "../../../core/scan";
import { ccTranscripts } from "../../../core/sources/claude-code";
import { ccPromptOrigin, unknownProvenance } from "../../../core/sources/claude-code/origin";
import { ccToolCategory } from "../../../core/sources/claude-code/tools";
import type { ScanCtx, PluginCoverage } from "../../../core/sources/types";
import { keyedHash } from "../../../core/text/hash";
import { classifyIntent } from "../../../core/text/intent";
import { CANARY, expectNoCanaries, findCanaries } from "../../kit/canary";
import { fakeHome, type FakeHome } from "../../kit/home";
import { buildCcTranscripts, CC_HAIKU, CC_OPUS, CC_S1, CC_S2, ccSid, CcTranscript, iso, slug, type CcOpts } from "../../fixtures/claude-code";

let h: FakeHome;
beforeEach(() => { h = fakeHome(); });
afterEach(() => h.cleanup());

const run = () => scan({ env: h.env, plugins: [ccTranscripts] });
const proj = (cwd = "/work/p") => `.claude/projects/${slug(cwd)}`;
/** Session ids: top-level transcripts are named by UUID-shaped ids, as the CLI names them. */
const sidOf = (label: string, ...rest: string[]) => [`claude-code:${ccSid(label)}`, ...rest].join("/");
const topFile = (label: string) => `${proj()}/${ccSid(label)}.jsonl`;
const sessDir = (label: string) => `${proj()}/${ccSid(label)}`;
const top = (label: string, o: CcOpts = {}) => new CcTranscript(ccSid(label), o);
const skipChmod = process.platform === "win32" || process.getuid?.() === 0;
const allEvents = (r: Awaited<ReturnType<typeof run>>) =>
  (["session", "prompt", "tool", "turn", "usage", "totals", "marker", "anchor", "identity", "file"] as const).flatMap((k) => [...r.store.all(k)]);

describe("claude-code transcripts: Task 9 scenario", () => {
  test("sessions, prompts, tools, markers, totals and coverage", async () => {
    buildCcTranscripts(h);
    const r = await run();

    const sessions = r.store.all("session");
    expect(sessions.filter(s => s.origin === "subagent")).toHaveLength(2);
    const sub = sessions.find(s => s.agentType === "Explore")!;
    expect(sub.parentId).toBe(sessions.find(s => s.id.endsWith(CC_S1))!.id);
    expect(sub.spawnDepth).toBe(1);
    const human = r.store.all("prompt").filter(p => p.origin === "human");
    expect(human).toHaveLength(6);                                  // S1: 3 typed + 1 queued; S2: 2
    expect(human.filter(p => p.intent === "command")).toHaveLength(1);
    expect(r.store.all("prompt").map(p => p.origin).sort()).toEqual([...Array(6).fill("human"), "scripted", "system"].sort());
    const tools = r.store.all("tool");
    expect(tools).toHaveLength(11);                                 // 5 main + 4 subagent + 2 workflow
    const tests = tools.filter(t => t.checks?.includes("test"));
    expect(tests.map(t => t.ok)).toEqual([false, true]);
    expect(tools.find(t => t.category === "edit")).toMatchObject({ editExt: "ts", linesAdded: 3, linesRemoved: 1 });
    expect(tools.find(t => t.category === "delegate")!.delegateTo).toBe(sub.id);
    const kinds = r.store.all("marker").map(m => m.kind);
    for (const k of ["interrupt", "compact-auto", "permission-mode", "pr-link", "queue"] as const) expect(kinds).toContain(k);
    expect(r.store.all("totals").find(t => t.usd === 1.5)).toMatchObject({ linesAdded: 10, linesRemoved: 2 });
    expect(r.store.all("anchor").length).toBeGreaterThan(0);
    const cov = r.coverage[0];
    expect(cov).toMatchObject({ status: "drift", unknownTypes: { "(other)": 1 } }); // an unknown type is never echoed
    expect(cov.skipped.sniffed).toBe(2);
    expectNoCanaries([...r.store.all("session"), ...r.store.all("prompt"), ...r.store.all("tool"), ...r.store.all("marker"), r.coverage]);
  });

  test("no event of any kind and no coverage field carries canary text", async () => {
    buildCcTranscripts(h);
    const r = await run();
    expectNoCanaries([...allEvents(r), r.coverage, r.warnings]);
  });

  test("marker counts: one queued prompt, one interrupt, one compaction, one mode, one PR", async () => {
    buildCcTranscripts(h);
    const r = await run();
    const count = (k: string) => r.store.all("marker").filter(m => m.kind === k).length;
    expect([count("queue"), count("interrupt"), count("compact-auto"), count("permission-mode"), count("pr-link")]).toEqual([1, 1, 1, 1, 1]);
  });

  test("subagent and workflow sessions hang off the parent; workflow totals link by workflow id", async () => {
    buildCcTranscripts(h);
    const r = await run();
    const wfId = keyedHash(r.salt, "wf_x1");
    const parent = `claude-code:${CC_S1}`;
    expect(r.store.session(`${parent}/agent-a1`)).toMatchObject({
      origin: "subagent", parentId: parent, agentType: "Explore", spawnDepth: 1, background: false, models: [CC_HAIKU],
    });
    expect(r.store.session(`${parent}/agent-a1`)!.workflowId).toBeUndefined();
    expect(r.store.session(`${parent}/wf_x1/agent-w1`)).toMatchObject({
      origin: "subagent", parentId: parent, agentType: "workflow-subagent", background: true, workflowId: wfId,
    });
    expect(r.store.all("totals").find(t => t.sessionId === `claude-code:wf:${wfId}`)).toMatchObject({ ms: 1_000 });
    expect(r.store.forSession(`${parent}/agent-a1`, "tool").map(t => t.name)).toEqual(["Read", "Grep", "Glob", "Read"]);
    expect(r.store.forSession(`${parent}/wf_x1/agent-w1`, "tool")).toHaveLength(2);
    expect(new Set(r.store.all("prompt").map(p => p.sessionId))).toEqual(new Set([parent, `claude-code:${CC_S2}`]));
  });

  test("top-level session fields: origin, models, version, project, span", async () => {
    const fx = buildCcTranscripts(h);
    const r = await run();
    const s1 = r.store.session(`claude-code:${CC_S1}`)!;
    expect(s1).toMatchObject({ origin: "human", window: "detail", models: [CC_OPUS], version: "2.1.301", surface: "cli", projectKey: keyedHash(r.salt, CANARY.path) });
    expect(r.cwds.get(s1.projectKey!)).toBe(CANARY.path);
    expect(s1.start).toBe(fx.start + 5_000);                         // two metadata lines without timestamps come first
    expect(s1.end).toBe(fx.s1LastTs);
    expect(r.store.session(`claude-code:${CC_S2}`)).toMatchObject({ origin: "human", projectKey: keyedHash(r.salt, "/work/projB") });
  });

  test("prompt features: task starts, intents, hashes of the trimmed text", async () => {
    buildCcTranscripts(h);
    const r = await run();
    const human = r.store.all("prompt").filter(p => p.origin === "human");
    expect(human.map(p => p.intent)).toEqual(["spec", "command", "question", "spec", "spec", "question"]);
    expect(human.map(p => p.features.isTaskStart)).toEqual([true, false, false, false, true, true]); // S2's 2nd prompt follows a 45-min gap
    expect(human[1]!.textHash).toBe(keyedHash(r.salt, "/model opus"));
    expect(human[0]!.features.simToPrev).toBeUndefined();
    expect(human[1]!.features.simToPrev).toBeGreaterThanOrEqual(0);
    expect(human[0]!.features.hasContext).toBe(true);                 // fenced code block
    const sys = r.store.all("prompt").find(p => p.origin === "system")!;
    expect(sys.features.isTaskStart).toBe(false);
  });

  test("usage and anchors once per API message; a turn per turn_duration", async () => {
    const fx = buildCcTranscripts(h);
    const r = await run();
    const usage = r.store.all("usage");
    expect(usage).toHaveLength(16);                                  // S1 6 + a1 5 + w1 3 + S2 2 assistant messages
    expect(usage[0]).toMatchObject({ sessionId: `claude-code:${CC_S1}`, model: CC_OPUS, outTok: 20, cacheR: 1_000, cacheW: 50 });
    const anchors = r.store.all("anchor");
    expect(anchors.filter(a => a.kind === "cc-msg")).toHaveLength(16);
    expect(anchors.filter(a => a.kind === "cc-req")).toHaveLength(16);
    expect(anchors.every(a => a.idTail.startsWith("01Fx") && a.idTail.length === 10)).toBe(true);
    expect(r.store.all("turn")).toEqual([{
      k: "turn", tool: "claude-code", source: "claude-code.transcripts", ts: fx.turnTs, sessionId: `claude-code:${CC_S1}`, window: "detail",
      model: CC_OPUS, effort: "high", status: "completed", ms: 1_200,
    }]);
  });

  test("identity, file facts and coverage counters", async () => {
    const fx = buildCcTranscripts(h);
    const r = await run();
    expect(r.store.all("identity")).toEqual([
      { k: "identity", tool: "claude-code", source: "claude-code.transcripts", scope: "session", hash: keyedHash(r.salt, "uuid-1"), sessionId: `claude-code:${CC_S1}` },
    ]);
    const files = r.store.all("file");
    expect(files).toHaveLength(4);
    const s1Path = path.join(h.env.home, fx.projA, `${CC_S1}.jsonl`);
    const s1 = r.store.session(`claude-code:${CC_S1}`)!;
    expect(files.find(f => f.pathHash === keyedHash(r.salt, s1Path))).toMatchObject({ bytes: statSync(s1Path).size, firstTs: s1.start, lastTs: s1.end });
    const read = fx.readFiles.map(rel => path.join(h.env.home, rel));
    const cov = r.coverage[0]!;
    expect(cov).toMatchObject({
      tool: "claude-code", source: "claude-code.transcripts", window: "detail", beta: false, retentionDays: 30,
      files: read.length, bytes: read.reduce((n, p) => n + statSync(p).size, 0), records: fx.jsonlRecords - 2,
      from: fx.firstTs, to: fx.lastTs, versions: ["2.1.300", "2.1.301"],
    });
    expect(r.warnings.filter(w => w.code === "drift")).toHaveLength(1);
  });
});

describe("claude-code transcripts: record mapping", () => {
  test("permission-mode markers keep transitions only; unknown modes map to other", async () => {
    const t = top("P1");
    t.raw({ type: "permission-mode", permissionMode: "auto", sessionId: t.sessionId }).prompt("start");
    const first = t.t;
    t.raw({ type: "permission-mode", permissionMode: "auto", sessionId: t.sessionId })
      .raw({ type: "permission-mode", permissionMode: "plan", sessionId: t.sessionId })
      .text("thinking")
      .raw({ type: "permission-mode", permissionMode: "plan", sessionId: t.sessionId })
      .raw({ type: "permission-mode", permissionMode: "dontAsk", sessionId: t.sessionId })
      .raw({ type: "permission-mode", permissionMode: "bypassPermissions", sessionId: t.sessionId });
    t.write(h, topFile("P1"));
    const r = await run();
    const pm = r.store.all("marker").filter(m => m.kind === "permission-mode");
    expect(pm.map(m => m.detail)).toEqual(["auto", "plan", "other", "bypassPermissions"]);
    expect(pm[0]!.ts).toBe(first);                                   // undated first line takes the first timestamp seen
    expect(pm[3]!.ts).toBe(t.t);
  });

  test("pr-link markers are deduplicated per pull request and carry a keyed hash", async () => {
    const t = top("P2").prompt("open a PR");
    const u1 = `https://github.com/canary/${CANARY.project}/pull/1`;
    const u2 = `https://github.com/canary/${CANARY.project}/pull/2`;
    for (const u of [u1, u1, u2, u1]) t.raw({ type: "pr-link", sessionId: t.sessionId, prNumber: 1, prUrl: u, prRepository: `canary/${CANARY.project}`, timestamp: iso(t.t) });
    t.write(h, topFile("P2"));
    const r = await run();
    const pr = r.store.all("marker").filter(m => m.kind === "pr-link");
    expect(pr.map(m => m.detail)).toEqual([keyedHash(r.salt, u1), keyedHash(r.salt, u2)]);
    expectNoCanaries(pr);
  });

  test("queue markers come from prompts the person queued, not from the CLI's queue journal", async () => {
    const t = top("P14").prompt("start the migration");
    t.raw({ type: "queue-operation", operation: "enqueue", timestamp: iso(t.t + 1_000), sessionId: t.sessionId, content: `<task-notification>${CANARY.prompt}</task-notification>` })
      .raw({ type: "queue-operation", operation: "enqueue", timestamp: iso(t.t + 2_000), sessionId: t.sessionId, content: "message from another agent" })
      .raw({ type: "queue-operation", operation: "dequeue", timestamp: iso(t.t + 3_000), sessionId: t.sessionId })
      .prompt("also update the changelog", { promptSource: "queued", turnOrigin: undefined });
    const queuedAt = t.t;
    t.user({ promptSource: "sdk", message: { role: "user", content: "queued by a script" } });
    t.write(h, topFile("P14"));
    const r = await run();
    expect(r.store.all("marker").filter(m => m.kind === "queue").map(m => [m.ts, m.sessionId])).toEqual([[queuedAt, sidOf("P14")]]);
  });

  test("compaction markers follow compactMetadata.trigger", async () => {
    const t = top("P20").prompt("go");
    t.system("compact_boundary", { content: "Conversation compacted", compactMetadata: { trigger: "manual", preTokens: 1 } })
      .system("compact_boundary", { content: "Conversation compacted", compactMetadata: { trigger: "auto", preTokens: 1 } });
    t.write(h, topFile("P20"));
    const r = await run();
    expect(r.store.all("marker").map(m => m.kind)).toEqual(["compact-manual", "compact-auto"]);
  });

  test("an unknown system subtype is ignored and is not drift", async () => {
    const t = top("P21").prompt("go");
    t.system("brand_new_subtype", { content: CANARY.prompt }).text("ok");
    t.write(h, topFile("P21"));
    const r = await run();
    expect(r.coverage[0]).toMatchObject({ status: "ok" });
    expect(r.coverage[0]!.unknownTypes).toEqual({});
    expect(r.store.all("marker")).toEqual([]);
  });

  test("cost-state is cumulative: only the last record becomes totals", async () => {
    const t = top("P3").prompt("go");
    t.raw({ type: "cost-state", sessionId: t.sessionId, totalCostUSD: 0.5, totalLinesAdded: 1, totalLinesRemoved: 0, totalDuration: 1_000 })
      .text("done")
      .raw({ type: "cost-state", sessionId: t.sessionId, totalCostUSD: 0.75, totalLinesAdded: 4, totalLinesRemoved: 3, totalDuration: 9_000 });
    t.write(h, topFile("P3"));
    const r = await run();
    expect(r.store.all("totals")).toEqual([
      { k: "totals", tool: "claude-code", source: "claude-code.transcripts", sessionId: sidOf("P3"), linesAdded: 4, linesRemoved: 3, usd: 0.75, ms: 9_000 },
    ]);
  });

  test("a response split over block records yields one usage (max per field) and one anchor pair; synthetic models none", async () => {
    const t = top("P4").prompt("go");
    const msg = { model: CC_OPUS, id: "msg_01FxAAAAAA", type: "message", role: "assistant", stop_reason: null };
    const usage = (out: number) => ({ input_tokens: 7, output_tokens: out, cache_read_input_tokens: 70, cache_creation_input_tokens: 3 });
    const head0 = t.base("assistant");
    t.raw({ ...head0, requestId: "req_01FxAAAAAA", apiBlockIndex: 0, message: { ...msg, content: [{ type: "thinking", thinking: "", signature: "s" }], usage: usage(5) } })
      .raw({ ...t.base("assistant"), requestId: "req_01FxAAAAAA", apiBlockIndex: 1, message: { ...msg, content: [{ type: "text", text: "hi" }], usage: usage(30) } })
      .raw({ ...t.base("assistant"), isApiErrorMessage: true, message: { ...msg, model: "<synthetic>", id: "x-1", content: [{ type: "text", text: "API Error" }], usage: usage(0) } });
    t.write(h, topFile("P4"));
    const r = await run();
    expect(r.store.all("usage")).toEqual([
      { k: "usage", tool: "claude-code", source: "claude-code.transcripts", ts: Date.parse(head0.timestamp as string), sessionId: sidOf("P4"), model: CC_OPUS, inTok: 7, outTok: 30, cacheR: 70, cacheW: 3 },
    ]);
    expect(r.store.all("anchor").map(a => `${a.kind}:${a.idTail}`)).toEqual(["cc-msg:01FxAAAAAA", "cc-req:01FxAAAAAA"]);
    expect(r.store.session(sidOf("P4"))!.models).toEqual([CC_OPUS]);
  });

  test("model and effort strings are shape-checked before they reach events", async () => {
    const t = top("P18", { model: CANARY.prompt }).prompt("go");
    t.assistant([{ type: "text", text: "hi" }], { effort: CANARY.secret }).system("turn_duration", { durationMs: 5 });
    t.write(h, topFile("P18"));
    new CcTranscript(ccSid("P18"), { agentId: "k1" }).user({ message: { role: "user", content: "brief" } }).write(h, `${sessDir("P18")}/subagents/agent-k1.jsonl`);
    h.writeJson(`${sessDir("P18")}/subagents/agent-k1.meta.json`, { agentType: "Plan", model: "my model!" });
    const ok = top("P19", { model: "claude-opus-4-6[1m]" }).prompt("go");
    ok.assistant([{ type: "text", text: "hi" }], { effort: "xhigh" }).system("turn_duration", { durationMs: 7 });
    ok.write(h, topFile("P19"));
    const r = await run();
    expect(r.store.all("usage").map(u => u.model)).toEqual(["other", "claude-opus-4-6[1m]"]);
    expect(r.store.session(sidOf("P18"))!.models).toEqual(["other"]);
    expect(r.store.session(sidOf("P18", "agent-k1"))!.models).toEqual(["other"]);
    expect(r.store.all("turn").map(x => [x.model, x.effort])).toEqual([["other", "other"], ["claude-opus-4-6[1m]", "xhigh"]]);
    expectNoCanaries([...allEvents(r), r.coverage]);
  });

  test("skill/command prompts stored as <command-name> markup and bash-mode input are typed commands; their outputs are not prompts", async () => {
    const t = top("P5");
    t.prompt("<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>src/a.ts</command-args>")
      .prompt("<bash-input>git status</bash-input>")
      .user({ message: { role: "user", content: "<bash-stdout>On branch main</bash-stdout><bash-stderr></bash-stderr>" } })
      .user({ message: { role: "user", content: "<local-command-stdout>Set model to opus</local-command-stdout>" } });
    t.write(h, topFile("P5"));
    const r = await run();
    const p = r.store.all("prompt");
    expect(p.map(x => [x.origin, x.intent])).toEqual([["human", "command"], ["human", "command"]]);
    expect(p.map(x => x.textHash)).toEqual([keyedHash(r.salt, "/review src/a.ts"), keyedHash(r.salt, "!git status")]);
  });

  test("provenance values the mapping does not know make a system prompt and surface as drift; SDK entrypoints are scripted", async () => {
    const t = top("P17");
    t.user({ turnOrigin: "unknown", message: { role: "user", content: "fix the parser" } })
      .user({ promptSource: "Voice Note", message: { role: "user", content: "and the docs" } })
      .user({ entrypoint: "sdk-ts", turnOrigin: "human", promptSource: "typed", message: { role: "user", content: "scripted via the TypeScript SDK" } })
      .user({ entrypoint: "sdk-py", message: { role: "user", content: "scripted via the Python SDK" } })
      .user({ message: { role: "user", content: "an older CLI wrote no provenance fields" } });
    t.write(h, topFile("P17"));
    const r = await run();
    expect(r.store.all("prompt").map(p => p.origin)).toEqual(["system", "system", "scripted", "scripted", "human"]);
    expect(r.coverage[0]!.status).toBe("drift");
    expect(r.coverage[0]!.unknownTypes).toEqual({ "turnOrigin:<other>": 1, "promptSource:<other>": 1 });
  });

  test("denial, plan-mode and commit markers", async () => {
    const t = top("P6").prompt("plan it");
    t.tool("toolu_p1", "EnterPlanMode", {})
      .tool("toolu_p2", "ExitPlanMode", { plan: CANARY.prompt })
      .tool("toolu_e1", "Edit", { file_path: "x.py" }, { isError: true, content: "The user doesn't want to proceed", extra: { toolDenialKind: "user-rejected" } })
      .tool("toolu_e2", "Edit", { file_path: "y.py" }, { isError: true, content: "Interrupted", extra: { toolDenialKind: "interrupted" } })
      .tool("toolu_g1", "Bash", { command: `git commit -m "${CANARY.prompt}"` }, {
        content: "[main abc1234] x", toolUseResult: { stdout: "", stderr: "", interrupted: false, gitOperation: { commit: { sha: "abc1234", kind: "commit", branch: "main" } } },
      });
    t.write(h, topFile("P6"));
    const r = await run();
    expect(r.store.all("marker").map(m => [m.kind, m.detail])).toEqual([
      ["plan-enter", undefined], ["plan-exit", undefined], ["denial", "user"], ["commit", keyedHash(r.salt, "abc1234")],
    ]);
    expect(r.store.all("tool").map(x => [x.name, x.category, x.ok, x.outcome])).toEqual([
      ["EnterPlanMode", "plan", true, undefined], ["ExitPlanMode", "plan", true, undefined], ["Edit", "edit", undefined, "denied"],
      ["Edit", "edit", undefined, "interrupted"], ["Bash", "git", true, undefined],
    ]);
    expectNoCanaries(allEvents(r));
  });

  test("every toolDenialKind: refusals are denied with who refused; interrupted and cancelled calls are no denial", async () => {
    const t = top("P14").prompt("run it");
    const kinds = ["user-rejected", "permission-rule", "automode-blocked", "automode-unavailable", "automode-parsing-error", "interrupted", "cancelled", "voice-veto"];
    kinds.forEach((kind, i) => t.tool(`toolu_d${i}`, "Bash", { command: "npm test" }, { isError: true, content: "Exit code 1", extra: { toolDenialKind: kind } }));
    t.tool("toolu_i1", "Bash", { command: "npm test" }, { isError: true, content: "Exit code 130", toolUseResult: { stdout: "", stderr: "", interrupted: true } });
    t.write(h, topFile("P14"));
    const r = await run();
    expect(r.store.all("tool").map(x => [x.outcome, x.ok, x.exit, x.checks])).toEqual([
      ...Array(5).fill(["denied", undefined, undefined, ["test"]]), ["interrupted", undefined, undefined, ["test"]], ["cancelled", undefined, undefined, ["test"]],
      ["denied", undefined, undefined, ["test"]], ["interrupted", undefined, undefined, ["test"]],
    ]);
    expect(r.store.all("marker").filter(m => m.kind === "denial").map(m => m.detail)).toEqual(["user", "rule", "auto", "auto", "auto", "other"]);
    expect(r.coverage[0]!.unknownTypes).toEqual({ "toolDenialKind:(other)": 1 }); // a new kind: never mistaken for a run
  });

  test("a failing shell command's exit code comes from its reply when toolUseResult has none", async () => {
    const t = top("P15").prompt("test it");
    t.tool("toolu_x2", "Bash", { command: "bun test" }, { isError: true, content: "Exit code 1\n2 fail" })
      .tool("toolu_x3", "PowerShell", { command: "npm test" }, { isError: true, content: [{ type: "text", text: "Exit code 3\nfailed" }] })
      .tool("toolu_x4", "Bash", { command: "bun test" }, { isError: true, content: "Command timed out after 2m" })
      .tool("toolu_x5", "Bash", { command: "bun test" }, { content: "12 pass" })
      .tool("toolu_x6", "Read", { file_path: "a.md" }, { isError: true, content: "Exit code 9" });
    t.write(h, topFile("P15"));
    const r = await run();
    expect(r.store.all("tool").map(x => [x.name, x.ok, x.exit])).toEqual([
      ["Bash", false, 1], ["PowerShell", false, 3], ["Bash", false, undefined], ["Bash", true, undefined], ["Read", false, undefined],
    ]);
  });

  test("bookkeeping calls are meta; an interrupt typed by the person says user", async () => {
    const t = top("P16").prompt("ask me first");
    t.tool("toolu_q1", "AskUserQuestion", { questions: [{ question: CANARY.prompt }] }, { content: CANARY.prompt })
      .tool("toolu_q2", "ToolSearch", { query: "select:Read" }, { content: "ok" })
      .user({ message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } });
    t.write(h, topFile("P16"));
    const r = await run();
    expect(r.store.all("tool").map(x => [x.name, x.category])).toEqual([["AskUserQuestion", "meta"], ["ToolSearch", "meta"]]);
    expect(r.store.all("marker").map(m => [m.kind, m.detail])).toEqual([["interrupt", "user"]]);
    expectNoCanaries(allEvents(r));
  });

  test("a forked transcript's copies of another session's records are skipped as copied", async () => {
    const other = ccSid("ORIG");
    const t = top("P17");
    t.user({ sessionId: other, promptSource: "typed", turnOrigin: "human", message: { role: "user", content: "the original session's prompt" } }, 0)
      .assistant([{ type: "tool_use", id: "toolu_c1", name: "Read", input: { file_path: "a.ts" } }], { sessionId: other })
      .prompt("my own follow-up", {}, 60_000)
      .tool("toolu_c2", "Grep", { pattern: "x" }, { content: "a.ts" });
    t.write(h, topFile("P17"));
    const r = await run();
    expect(r.store.all("prompt").map(p => p.intent)).toEqual([classifyIntent("my own follow-up")]);
    expect(r.store.all("tool").map(x => x.name)).toEqual(["Grep"]);
    expect(r.store.all("usage")).toHaveLength(1); // the copied assistant message is no usage of this session
    const own = t.records.filter((x) => x.sessionId === t.sessionId && typeof x.timestamp === "string").map((x) => Date.parse(x.timestamp as string));
    expect(r.store.session(sidOf("P17"))).toMatchObject({ start: Math.min(...own), end: Math.max(...own) });
    expect(r.coverage[0]!.skipped.copied).toBe(2);
  });

  test("MCP tools keep the server name only in mcpServer", async () => {
    const t = top("P7").prompt("look it up");
    t.tool("toolu_m1", `mcp__${CANARY.mcp}__lookup_record`, { id: CANARY.secret }, { content: CANARY.code });
    t.write(h, topFile("P7"));
    const r = await run();
    const [ev] = r.store.all("tool") as ToolEv[];
    expect(ev).toMatchObject({ name: "mcp", category: "mcp", mcpServer: CANARY.mcp, ok: true });
    expect(findCanaries({ ...ev, mcpServer: undefined })).toEqual([]);
    expectNoCanaries([...allEvents(r), r.coverage], { allow: ["mcp"] });
  });

  test("tool durations and exit codes come from toolUseResult when present; pending tools are flushed at end of file", async () => {
    const t = top("P8").prompt("fetch");
    t.tool("toolu_f1", "WebFetch", { url: "https://example.test" }, { toolUseResult: { code: 200, codeText: "OK", durationMs: 812, bytes: 10, result: "x", url: "https://example.test" } })
      .tool("toolu_x1", "Bash", { command: "make build" }, { isError: true, toolUseResult: { exitCode: 2, stdout: "", stderr: "", interrupted: false } })
      .tool("toolu_n1", "Read", { file_path: "a.md" }, { noResult: true });
    t.write(h, topFile("P8"));
    const r = await run();
    const tools = r.store.all("tool");
    expect(tools.find(x => x.name === "WebFetch")).toMatchObject({ category: "web", ok: true, ms: 812 });
    expect(tools.find(x => x.name === "Bash")).toMatchObject({ category: "build", checks: ["build"], ok: false, exit: 2 });
    const pending = tools.find(x => x.name === "Read")!;
    expect(pending.ok).toBeUndefined();
    expect(tools).toHaveLength(3);
  });

  test("a repeated tool_use id is one tool event; a record answering two tool uses applies no single toolUseResult", async () => {
    const t = top("P11").prompt("edit both");
    const use = (id: string) => ({ type: "tool_use", id, name: "Edit", input: { file_path: `${id}.ts` } });
    const results = (...ids: string[]) => ids.map((id, i) => ({ type: "tool_result", tool_use_id: id, content: "ok", is_error: i > 0 }));
    t.assistant([use("toolu_d1")]).user({ message: { role: "user", content: results("toolu_d1") } })
      .assistant([use("toolu_d1")]) // the same tool use written again after its result
      .assistant([use("toolu_d2")]).assistant([use("toolu_d3")])
      .user({
        message: { role: "user", content: results("toolu_d2", "toolu_d3") },
        toolUseResult: { filePath: "toolu_d2.ts", structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ["+a", " b"] }] },
      });
    t.write(h, topFile("P11"));
    const r = await run();
    const tools = r.store.all("tool");
    expect(tools.map(x => [x.callId, x.ok, x.linesAdded])).toEqual([["toolu_d1", true, undefined], ["toolu_d2", true, undefined], ["toolu_d3", false, undefined]]);
  });

  test("usage stays one per message beyond the in-memory message window", async () => {
    const t = top("P12").prompt("long run");
    for (let i = 0; i < 300; i++) t.text(`step ${i}`);
    t.write(h, topFile("P12"));
    const r = await run();
    expect(r.store.all("usage")).toHaveLength(300);
    expect(r.store.all("anchor")).toHaveLength(600);
  });

  test("a session without human prompts is scripted", async () => {
    const t = top("P9");
    t.user({ entrypoint: "sdk-cli", message: { role: "user", content: "Run the nightly report" } }).text("ok");
    t.write(h, topFile("P9"));
    const r = await run();
    expect(r.store.session(sidOf("P9"))!.origin).toBe("scripted");
    expect(r.store.all("prompt").map(p => p.origin)).toEqual(["scripted"]);
  });

  test("debug diagnostics: heavy lines that escape the sniff, files holding another session's records", async () => {
    const t = top("P13").prompt("go");
    t.raw({ hash: "h".repeat(600), type: "api-request-blob", sessionId: t.sessionId, message: { role: "user", content: CANARY.secret } }) // `type` past the sniffed head
      .user({ sessionId: "OLD", message: { role: "user", content: "copied from another session" }, promptSource: "typed" });
    t.write(h, topFile("P13"));
    const logs: [string, string, number | undefined][] = [];
    const r = await scan({ env: h.env, plugins: [ccTranscripts], onLog: (level, code, n) => logs.push([level, code, n]) });
    expect(logs).toEqual([["debug", "cc.heavy-parsed", 1], ["debug", "cc.foreign-session-files", 1]]);
    expect(r.coverage[0]).toMatchObject({ status: "ok", unknownTypes: {} });
    expect(r.coverage[0]!.skipped).toEqual({ copied: 1 });
    expect(r.store.all("prompt")).toHaveLength(1); // the copied prompt is not this session's
  });

  test("a record the mapper cannot handle is counted, logged once per root, and the file goes on", async () => {
    top("P16").prompt("boom").prompt("fine").write(h, topFile("P16"));
    top("P22").prompt("boom").write(h, topFile("P22"));
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
    const [cand] = ccTranscripts.locate(h.env, [h.env.home]);
    await ccTranscripts.scan(cand!, ctx);
    const cov = events.find((e): e is CoverageEv => e.k === "coverage")!;
    expect(cov.skipped["bad-record"]).toBe(2);
    expect(logs).toEqual([["warn", "cc.bad-record", 2]]);
    expect(events.filter(e => e.k === "prompt")).toHaveLength(1);       // "fine" still mapped after the failure
  });

  test("record type names the reader does not know are bucketed, never copied", async () => {
    const t = top("P10").prompt("hi");
    t.raw({ type: CANARY.prompt }).raw({ type: 42 }).raw({ noType: true });
    t.write(h, topFile("P10"));
    const r = await run();
    expect(r.coverage[0]).toMatchObject({ status: "drift", unknownTypes: { "(other)": 1, "(none)": 2 } });
    expectNoCanaries(r.coverage);
  });
});

describe("claude-code transcripts: session ids", () => {
  test("names the CLI would not write are hashed; agent stems reused across workflow runs stay apart", async () => {
    const odd = `${CANARY.project} notes`;
    const oddAgent = `agent-${CANARY.project}-copy`;
    const oddWf = `wf_${CANARY.project}.old`;
    const brief = { message: { role: "user", content: "brief" } };
    new CcTranscript(odd).prompt("hello").write(h, `${proj()}/${odd}.jsonl`);
    new CcTranscript(odd, { agentId: "q1" }).user(brief).tool("toolu_q1", "Read", { file_path: "a.ts" }).write(h, `${proj()}/${odd}/subagents/${oddAgent}.jsonl`);
    new CcTranscript(odd, { agentId: "w1" }).user(brief).write(h, `${proj()}/${odd}/subagents/workflows/${oddWf}/agent-w1.jsonl`);
    new CcTranscript(odd, { agentId: "w1" }).user(brief).write(h, `${proj()}/${odd}/subagents/workflows/wf_b2/agent-w1.jsonl`);
    const r = await run();
    const parent = `claude-code:${keyedHash(r.salt, odd)}`;
    expect(r.store.all("session").map(s => s.id)).toEqual([
      parent,
      `${parent}/${keyedHash(r.salt, oddAgent)}`,
      `${parent}/${keyedHash(r.salt, oddWf)}/agent-w1`,
      `${parent}/wf_b2/agent-w1`,
    ]);
    expect(new Set(r.store.all("session").filter(s => s.origin === "subagent").map(s => s.parentId))).toEqual(new Set([parent]));
    expectNoCanaries([...allEvents(r), r.coverage]);
  });
});

describe("claude-code transcripts: subagents", () => {
  const parent = (label: string, toolId: string) =>
    top(label).prompt("delegate").tool(toolId, "Agent", { description: "d", prompt: CANARY.prompt, subagent_type: "x" });
  const child = (label: string, agentId: string) =>
    new CcTranscript(ccSid(label), { agentId, model: CC_HAIKU }).user({ message: { role: "user", content: CANARY.prompt } }).tool(`toolu_${agentId}`, "Read", { file_path: "a.ts" });

  test("missing meta.json: the subagent session still exists, without agent type or delegation link", async () => {
    parent("S9", "toolu_Z").write(h, topFile("S9"));
    child("S9", "z9").write(h, `${sessDir("S9")}/subagents/agent-z9.jsonl`);
    const r = await run();
    const s = r.store.session(sidOf("S9", "agent-z9"))!;
    expect(s).toMatchObject({ origin: "subagent", parentId: sidOf("S9"), models: [CC_HAIKU] });
    expect(s.agentType).toBeUndefined();
    expect(r.store.all("tool").find(t => t.name === "Agent")!.delegateTo).toBeUndefined();
  });

  test("subagent and workflow-agent files never yield prompts, whatever their user records claim", async () => {
    parent("S7", "toolu_X").write(h, topFile("S7"));
    const typedLooking = (agentId: string) =>
      new CcTranscript(ccSid("S7"), { agentId }).user({ isSidechain: false, promptSource: "typed", turnOrigin: "human", message: { role: "user", content: "Look into the importer" } });
    typedLooking("x7").write(h, `${sessDir("S7")}/subagents/agent-x7.jsonl`);
    typedLooking("x8").write(h, `${sessDir("S7")}/subagents/workflows/wf_q1/agent-x8.jsonl`);
    const r = await run();
    expect(r.store.all("prompt").map(p => p.sessionId)).toEqual([sidOf("S7")]);
    expect(r.store.session(sidOf("S7", "wf_q1", "agent-x8"))).toMatchObject({ origin: "subagent", workflowId: keyedHash(r.salt, "wf_q1") });
  });

  test("a subagent stopped by the user gets an interrupt marker; custom agent types are hashed, built-ins kept", async () => {
    parent("S8", "toolu_Y").write(h, topFile("S8"));
    child("S8", "y8").write(h, `${sessDir("S8")}/subagents/agent-y8.jsonl`);
    h.writeJson(`${sessDir("S8")}/subagents/agent-y8.meta.json`, { agentType: CANARY.project, isBuiltIn: false, toolUseId: "toolu_Y", spawnDepth: 2, stoppedByUser: true, description: CANARY.prompt });
    child("S8", "y9").write(h, `${sessDir("S8")}/subagents/agent-y9.jsonl`);
    h.writeJson(`${sessDir("S8")}/subagents/agent-y9.meta.json`, { agentType: "general-purpose", spawnDepth: 1 });
    new CcTranscript(ccSid("S8"), { agentId: "y7" }).user({ message: { role: "user", content: "brief" } }).write(h, `${sessDir("S8")}/subagents/agent-y7.jsonl`);
    h.writeJson(`${sessDir("S8")}/subagents/agent-y7.meta.json`, { agentType: "Plan", model: "sonnet" });
    const r = await run();
    const y8 = r.store.session(sidOf("S8", "agent-y8"))!;
    expect(y8).toMatchObject({ agentType: keyedHash(r.salt, CANARY.project), spawnDepth: 2 });
    expect(r.store.session(sidOf("S8", "agent-y9"))!.agentType).toBe("general-purpose");
    expect(r.store.session(sidOf("S8", "agent-y7"))).toMatchObject({ agentType: "Plan", models: ["sonnet"] }); // no assistant record: meta model
    expect(r.store.all("marker").filter(m => m.kind === "interrupt").map(m => [m.sessionId, m.ts])).toEqual([[y8.id, y8.end]]);
    expect(r.store.all("tool").find(t => t.name === "Agent")!.delegateTo).toBe(y8.id);
    expectNoCanaries([...allEvents(r), r.coverage]);
  });

  test("an invalid meta.json counts as parse; the subagent session is still read", async () => {
    parent("S6", "toolu_W").write(h, topFile("S6"));
    child("S6", "v1").write(h, `${sessDir("S6")}/subagents/agent-v1.jsonl`);
    h.write(`${sessDir("S6")}/subagents/agent-v1.meta.json`, "{not json");
    const r = await run();
    expect(r.coverage[0]!.skipped).toEqual({ parse: 1 });
    expect(r.store.session(sidOf("S6", "agent-v1"))).toMatchObject({ origin: "subagent" });
  });

  test.skipIf(skipChmod)("an unreadable meta.json or workflow summary counts as io-error, not parse", async () => {
    parent("S5", "toolu_V").write(h, topFile("S5"));
    child("S5", "u1").write(h, `${sessDir("S5")}/subagents/agent-u1.jsonl`);
    const meta = h.writeJson(`${sessDir("S5")}/subagents/agent-u1.meta.json`, { agentType: "Plan", toolUseId: "toolu_V" });
    const summary = h.writeJson(`${sessDir("S5")}/workflows/wf_u1.json`, { durationMs: 5 });
    chmodSync(meta, 0o000);
    chmodSync(summary, 0o000);
    try {
      const r = await run();
      expect(r.coverage[0]!.skipped).toEqual({ "io-error": 2 });
      expect(r.store.session(sidOf("S5", "agent-u1"))!.agentType).toBeUndefined();
    } finally {
      chmodSync(meta, 0o600);
      chmodSync(summary, 0o600);
    }
  });
});

describe("claude-code transcripts: locate and coverage", () => {
  test("no Claude Code directory: absent coverage", async () => {
    const r = await run();
    expect(r.coverage).toHaveLength(1);
    expect(r.coverage[0]).toMatchObject({ status: "absent", source: "claude-code.transcripts" });
  });

  test("a store without transcripts is empty", async () => {
    mkdirSync(path.join(h.env.home, ".claude", "projects"), { recursive: true });
    const r = await run();
    expect(r.coverage[0]).toMatchObject({ status: "empty", files: 0, records: 0 });
  });

  test("CLAUDE_CONFIG_DIR replaces ~/.claude; settings cleanupPeriodDays sets retention", async () => {
    const alt = path.join(h.env.home, "alt-claude");
    h.env.vars.CLAUDE_CONFIG_DIR = alt;
    top("A1").prompt("hello").write(h, `alt-claude/projects/${slug("/work/p")}/${ccSid("A1")}.jsonl`);
    top("D1").prompt("ignored").write(h, topFile("D1"));
    h.writeJson("alt-claude/settings.json", { cleanupPeriodDays: 45, hooks: { Stop: [{ hooks: [{ type: "command", command: CANARY.secret }] }] } });
    const r = await run();
    expect(r.store.all("session").map(s => s.id)).toEqual([sidOf("A1")]);
    expect(r.coverage[0]).toMatchObject({ status: "ok", retentionDays: 45 });
    expectNoCanaries(r.coverage);
  });

  test.skipIf(skipChmod)("an unreadable transcript counts as io-error and the scan goes on", async () => {
    top("R1").prompt("one").write(h, topFile("R1"));
    const bad = top("R2").prompt("two").write(h, topFile("R2"));
    chmodSync(bad, 0o000);
    try {
      const r = await run();
      expect(r.coverage[0]).toMatchObject({ status: "ok", skipped: { "io-error": 1 } });
      expect(r.store.all("session").map(s => s.id)).toEqual([sidOf("R1")]);
    } finally {
      chmodSync(bad, 0o600);
    }
  });
});

describe("ccPromptOrigin", () => {
  const u = (fields: Record<string, unknown>, content: unknown = "fix the flaky test") => ({ type: "user", message: { role: "user", content }, ...fields });
  const cases: [string, unknown, string][] = [
    ["typed", u({ promptSource: "typed" }), "human"],
    ["queued", u({ promptSource: "queued" }), "human"],
    ["suggestion accepted", u({ promptSource: "suggestion_accepted" }), "human"],
    ["turnOrigin human", u({ turnOrigin: "human" }), "human"],
    ["exclusion beats typed", u({ promptSource: "typed", turnOrigin: "task_notification" }), "system"],
    ["auto continuation", u({ turnOrigin: "auto_continuation" }), "system"],
    ["host synthetic", u({ turnOrigin: "host_synthetic" }), "system"],
    ["peer", u({ turnOrigin: "peer" }), "peer"],
    ["scheduled", u({ turnOrigin: "scheduled" }), "scheduled"],
    ["sdk turn", u({ turnOrigin: "sdk" }), "scripted"],
    ["sdk source", u({ promptSource: "sdk" }), "scripted"],
    ["system source", u({ promptSource: "system" }), "system"],
    ["sdk-cli beats human", u({ entrypoint: "sdk-cli", turnOrigin: "human" }), "scripted"],
    ["sdk-ts beats human", u({ entrypoint: "sdk-ts", turnOrigin: "human", promptSource: "typed" }), "scripted"],
    ["sdk-py, fields absent", u({ entrypoint: "sdk-py" }), "scripted"],
    ["text not typed", u({ promptSource: "queued", textNotTyped: true }), "system"],
    ["unknown turn origin, plain text", u({ turnOrigin: "unknown" }), "system"],
    ["unknown turn origin, typed", u({ turnOrigin: "unknown", promptSource: "typed" }), "system"],
    ["new promptSource value beats a human turn", u({ turnOrigin: "human", promptSource: "dictated" }), "system"],
    ["null turnOrigin is present, not absent", u({ turnOrigin: null }), "system"],
    ["fields absent, plain text", u({ entrypoint: "cli" }), "human"],
    ["fields absent, markup", u({}, "<task-notification>done</task-notification>"), "system"],
    ["fields absent, bracket", u({}, "[Image #1] what is this"), "system"],
    ["fields absent, sdk-cli", u({ entrypoint: "sdk-cli" }), "scripted"],
    ["text blocks", u({ promptSource: "typed" }, [{ type: "text", text: "a" }, { type: "image", source: {} }]), "human"],
    ["isMeta", u({ isMeta: true, promptSource: "typed" }), "not-a-prompt"],
    ["compact summary", u({ isCompactSummary: true }), "not-a-prompt"],
    ["sidechain", u({ isSidechain: true, promptSource: "typed" }), "not-a-prompt"],
    ["turn companion", u({ turnCompanion: true }), "not-a-prompt"],
    ["tool-sourced message", u({ sourceToolUseID: "toolu_1" }), "not-a-prompt"],
    ["virtual", u({ isVirtual: true, promptSource: "typed" }), "not-a-prompt"],
    ["tool result", u({}, [{ type: "tool_result", tool_use_id: "t", content: "x" }]), "not-a-prompt"],
    ["empty text", u({ promptSource: "typed" }, "  "), "not-a-prompt"],
    ["interrupt", u({}, [{ type: "text", text: "[Request interrupted by user for tool use]" }]), "not-a-prompt"],
    ["command output", u({ promptSource: "system" }, "<local-command-stdout>ok</local-command-stdout>"), "not-a-prompt"],
    ["assistant", { type: "assistant", message: { content: "x" } }, "not-a-prompt"],
    ["not an object", "user", "not-a-prompt"],
  ];
  for (const [name, rec, want] of cases) test(name, () => expect(ccPromptOrigin(rec)).toBe(want as never));

  test("unknownProvenance: coverage keys for values the mapping does not know, never echoing them", () => {
    expect(unknownProvenance({ turnOrigin: "unknown", promptSource: "typed" })).toEqual(["turnOrigin:<other>"]);
    expect(unknownProvenance({ turnOrigin: CANARY.prompt, promptSource: 7 })).toEqual(["turnOrigin:<other>", "promptSource:<other>"]);
    expect(unknownProvenance({ turnOrigin: "human", promptSource: "queued" })).toEqual([]);
    expect(unknownProvenance({})).toEqual([]);
  });
});

describe("ccToolCategory", () => {
  const cases: [string, unknown, { category: string; checks: string[]; editExt?: string }][] = [
    ["Read", { file_path: "/a/b.ts" }, { category: "read", checks: [] }],
    ["Grep", { pattern: "x" }, { category: "search", checks: [] }],
    ["Glob", { pattern: "*" }, { category: "search", checks: [] }],
    ["Edit", { file_path: "/a/B.TSX" }, { category: "edit", checks: [], editExt: "tsx" }],
    ["MultiEdit", { file_path: "lib/x.rs" }, { category: "edit", checks: [], editExt: "rs" }],
    ["NotebookEdit", { notebook_path: "n.ipynb" }, { category: "edit", checks: [], editExt: "ipynb" }],
    ["Write", { file_path: "Makefile" }, { category: "write", checks: [] }],
    ["Write", { file_path: "/x/y/notes.md" }, { category: "write", checks: [], editExt: "md" }],
    ["Bash", { command: "bun test" }, { category: "test", checks: ["test"] }],
    ["Bash", { command: "git status" }, { category: "git", checks: [] }],
    ["Bash", { command: "ls -la" }, { category: "read", checks: [] }],
    ["Bash", { command: "rg -n needle src" }, { category: "search", checks: [] }],
    ["Bash", { command: "python3 scripts/gen.py" }, { category: "shell", checks: [] }],
    ["Bash", {}, { category: "shell", checks: [] }],
    ["PowerShell", { command: "npm run lint" }, { category: "lint", checks: ["lint"] }],
    ["Agent", { subagent_type: "Explore" }, { category: "delegate", checks: [] }],
    ["Task", {}, { category: "delegate", checks: [] }],
    ["Workflow", {}, { category: "workflow", checks: [] }],
    ["TodoWrite", {}, { category: "todo", checks: [] }],
    ["TaskCreate", {}, { category: "todo", checks: [] }],
    ["TaskUpdate", {}, { category: "todo", checks: [] }],
    ["EnterPlanMode", {}, { category: "plan", checks: [] }],
    ["ExitPlanMode", {}, { category: "plan", checks: [] }],
    ["WebFetch", {}, { category: "web", checks: [] }],
    ["WebSearch", {}, { category: "web", checks: [] }],
    ["Skill", { skill: "x" }, { category: "skill", checks: [] }],
    ["Monitor", {}, { category: "monitor", checks: [] }],
    ["CronCreate", {}, { category: "schedule", checks: [] }],
    ["ScheduleWakeup", {}, { category: "schedule", checks: [] }],
    ["mcp__srv__do_thing", {}, { category: "mcp", checks: [] }],
    ["AskUserQuestion", {}, { category: "meta", checks: [] }],
    ["ToolSearch", {}, { category: "meta", checks: [] }],
    ["BrandNewTool", {}, { category: "other", checks: [] }],
    ["Read", null, { category: "read", checks: [] }],
  ];
  for (const [name, input, want] of cases) test(`${name} ${JSON.stringify(input)}`, () => expect(ccToolCategory(name, input)).toEqual(want as never));
});
