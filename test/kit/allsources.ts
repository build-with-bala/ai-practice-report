// Every P0 source's fixtures in one fake home, with canaries planted everywhere a trace keeps a token: the integration
// test's scan and the privacy layer's end-to-end export both read it.
import { Database } from "bun:sqlite";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { vscodeUser } from "../../core/env/paths";
import { agId, buildAntigravity, CLI_BRAIN_REL, historyLine, historyRel, P as AG_P, STEP, writeBrain, writeSteps } from "../fixtures/antigravity";
import { buildCcLifetime, buildCcTranscripts, CcTranscript, ccSid, fixtureStart, slug } from "../fixtures/claude-code";
import { buildCodexIndex, buildCodexRollouts, CxRollout, rateLimits, rolloutRel, threadRow, turnRow, uuidV7 } from "../fixtures/codex";
import { buildCopilot, CliEvents, cpSid, fileUrl, markdown, request, sessionRoot, tool as cpTool, userRel as cpUserRel, writeSessionStore } from "../fixtures/copilot";
import { bubble, buildAgentCli, buildCursor, composer, cuSid, globalRel } from "../fixtures/cursor";
import { CANARY } from "./canary";
import type { FakeHome } from "./home";

/** Every tool's fixtures in one home, plus one Copilot CLI session (the Copilot tests build theirs inline too). */
export function buildAll(h: FakeHome): Planted {
  buildCcTranscripts(h);
  buildCcLifetime(h);
  buildCodexRollouts(h);
  buildCodexIndex(h);
  buildCopilot(h);
  const id = cpSid("cli");
  const cli = new CliEvents()
    .ev("session.start", { sessionId: id, version: 1, producer: "copilot-agent", copilotVersion: "1.0.4", context: { cwd: CANARY.path } }, 0)
    .ev("user.message", { content: `Fix the build. ${CANARY.prompt}`, attachments: [] })
    .ev(CANARY.slug, { detail: 1 }) // an event type the reader does not know
    .ev("assistant.turn_start", { turnId: "0" })
    .ev("tool.execution_start", { toolCallId: "t1", toolName: "bash", arguments: { command: `npm test ${CANARY.path}` } })
    .ev("tool.execution_complete", { toolCallId: "t1", success: true, result: { content: CANARY.secret } })
    .ev("assistant.turn_end", { turnId: "0" });
  h.writeJsonl(path.join(".copilot", "session-state", id, "events.jsonl"), cli.records);
  // the session stores: the lifetime window of both Copilot readers
  writeSessionStore(h, path.join(path.relative(h.env.home, vscodeUser(h.env, "Code")), "globalStorage", "github.copilot-chat", "session-store.db"),
    { id: cpSid("vstore"), host: "vscode", at: Date.now() - 3 * 86_400_000 });
  writeSessionStore(h, path.join(".copilot", "session-store.db"), { id, host: CANARY.slug, at: Date.now() - 3 * 86_400_000 });
  buildCursor(h);
  buildAgentCli(h);
  const ag = buildAntigravity(h);
  // typed check steps: their category is a check, and the contract says so in `checks` too
  writeSteps(h, agId("T"), [
    { type: STEP.BLAZE_TEST_TARGETS, ts: ag.t0 + 70_000 }, { type: STEP.COMPILE, ts: ag.t0 + 80_000 }, { type: STEP.LINT_APPLET, ts: ag.t0 + 90_000 },
  ]);
  writeBrain(h, CLI_BRAIN_REL, agId("T"), ["task.md"]); // a plan artifact in the CLI's brain folder too
  h.writeJsonl(historyRel, [
    historyLine({ display: `Fix the build. ${CANARY.prompt}`, timestamp: ag.t0 + 100_000, conversationId: AG_P }),
    historyLine({ display: "Read it aloud", timestamp: ag.t0 + 110_000, type: CANARY.slug }), // a history type it does not know
  ]);
  return plantSlug(h);
}

export interface Planted { rollout: string; thread: string }

/**
 * The token-shaped canary in every field that keeps a token from a trace: the two raw config-name fields (exempt) and
 * the guarded ones — surfaces, approval and sandbox modes, rate-limit buckets, turn statuses, and the drift keys of
 * unknown types and values. It may come out through the exempt fields only. (buildAll plants it in the Copilot CLI's
 * event types and store host, and in Antigravity's history types.)
 */
function plantSlug(h: FakeHome): Planted {
  const t = fixtureStart();
  // Claude Code: a call to an MCP server named like a project (ToolEv.mcpServer), an unknown prompt source and record type
  const cc = new CcTranscript(ccSid("SLUG")).prompt("Look up the release notes")
    .tool("toolu_slug", `mcp__${CANARY.slug}__search`, { q: "notes" }, { content: "ok" })
    .prompt("Once more", { promptSource: CANARY.slug })
    .raw({ type: CANARY.slug });
  h.writeJsonl(`.claude/projects/${slug("/work/slug")}/${ccSid("SLUG")}.jsonl`, cc.records);
  // Codex: a profile named like a project (ConfigEv.name); a rollout's source, unknown event and item types, a bucket…
  appendFileSync(path.join(h.env.home, ".codex", "config.toml"), `\n[profiles.${CANARY.slug}]\nmodel = "gpt-5.1-codex"\n`);
  const rollout = uuidV7(t, 0x5a);
  const cx = new CxRollout(t, rollout).meta({ source: CANARY.slug }).turn("t1").user("Plan the release")
    .event(CANARY.slug).item(CANARY.slug)
    .event("token_count", { info: null, rate_limits: { ...rateLimits(t, 5), limit_id: CANARY.slug } })
    .done("t1");
  h.writeJsonl(rolloutRel(t, rollout), cx.records);
  // Copilot VS Code: a chat session whose agent, mode, response part kind, tool id and model id are the token-shaped
  // canary, in a workspace whose folder is the path canary
  const wsDir = path.join(cpUserRel(h), "workspaceStorage", "slughash");
  h.writeJson(path.join(wsDir, "workspace.json"), { folder: fileUrl(CANARY.path) });
  const cpReq = request({ id: "request_slug", text: "Tidy the release notes", ts: t + 2 * 60_000, modelId: CANARY.slug, agentId: CANARY.slug, modes: [CANARY.slug],
    parts: [markdown("On it."), { kind: CANARY.slug, value: CANARY.slug }, cpTool(CANARY.slug)], modelState: { value: 1, completedAt: t + 3 * 60_000 } });
  h.writeJson(path.join(wsDir, "chatSessions", `${cpSid("SLUG")}.json`), sessionRoot(cpSid("SLUG"), [cpReq], { created: t + 60_000 }));
  // Cursor: a composer whose mode, status and model, and a bubble whose model and tool name, are the token-shaped canary
  const cu = cuSid("SLUG");
  const cuIds = ["s1", "s2"].map(cuSid);
  insertRow(h, globalRel(h), "cursorDiskKV", { key: `composerData:${cu}`, value: JSON.stringify(composer(cu, { created: t, updated: t + 5 * 60_000, agentic: true,
    mode: CANARY.slug, model: CANARY.slug, headers: cuIds, extra: { status: CANARY.slug } })) });
  insertRow(h, globalRel(h), "cursorDiskKV", { key: `bubbleId:${cu}:${cuIds[0]}`, value: JSON.stringify(bubble(cuIds[0]!, { type: 1, ts: t + 60_000, text: "Tidy the notes" })) });
  insertRow(h, globalRel(h), "cursorDiskKV", { key: `bubbleId:${cu}:${cuIds[1]}`, value: JSON.stringify(bubble(cuIds[1]!, { type: 2, ts: t + 2 * 60_000, model: CANARY.slug,
    tool: { name: CANARY.slug, tool: 99, status: CANARY.slug, params: { path: CANARY.path } } })) });
  // …and a thread's source, approval and sandbox, and a turn's status, in the index
  const thread = uuidV7(t, 0x5b);
  insertRow(h, path.join(".codex", "state_5.sqlite"), "threads",
    threadRow(thread, t, { source: CANARY.slug, approval_mode: CANARY.slug, sandbox_policy: JSON.stringify({ type: CANARY.slug }) }));
  const s0 = Math.floor(t / 1000);
  insertRow(h, path.join(".codex", "thread_history_1.sqlite"), "thread_turns", turnRow(thread, "turn-slug", CANARY.slug, s0, s0 + 5, 5_000));
  return { rollout, thread };
}

/** One row into a fixture database: the row's fields the table has a column for. */
function insertRow(h: FakeHome, rel: string, table: string, row: Record<string, unknown>): void {
  const db = new Database(path.join(h.env.home, rel));
  try {
    const cols = (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name).filter((c) => c in row);
    db.query(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...(cols.map((c) => row[c]) as (string | number | null)[]));
  } finally {
    db.close();
  }
}

