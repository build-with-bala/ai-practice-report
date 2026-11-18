// A newer tool version that renames or reshapes a field the reader maps must surface as drift — a "format changed?"
// warning — never as a quiet store with zero prompts or tools (spec §2, Review Focus #3). One case per mapping reader.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import type { CoverageEv } from "../../../core/model/events";
import { scan } from "../../../core/scan";
import { agCli, agHistory, agIde } from "../../../core/sources/antigravity";
import { ccConfig, ccHistory, ccStats, ccTranscripts } from "../../../core/sources/claude-code";
import { cxConfig, cxHistory, cxRollouts, cxThreads } from "../../../core/sources/codex";
import { cpCli, cpVscode } from "../../../core/sources/copilot";
import { cuIde, cuTracking } from "../../../core/sources/cursor";
import { registry } from "../../../core/sources/registry";
import type { SourcePlugin } from "../../../core/sources/types";
import { fakeHome, type FakeHome } from "../../kit/home";
import { agId, historyLine, historyRel, ideRel, topic, trajectory, TRAJ_KEY, transcriptRel, userInput, writeIdeStore } from "../../fixtures/antigravity";
import { CcTranscript, ccHistoryLine, ccSid, fixtureStart, slug } from "../../fixtures/claude-code";
import { cxHistoryLine, CxRollout, rolloutRel, THREAD_COLUMNS, threadRow, uuidV7, writeStateDb as writeCodexState } from "../../fixtures/codex";
import { CliEvents, cpSid, request, sessionRoot, userRel } from "../../fixtures/copilot";
import { bubble, commitRow, composer, cuSid, globalRel, SCORED_COMMITS_DDL, writeStateDb as writeCursorState, writeTracking } from "../../fixtures/cursor";

let h: FakeHome;
beforeEach(() => { h = fakeHome(); });
afterEach(() => h.cleanup());

/** `v` with every key `from` renamed `to`, as a newer tool version might rename a field. */
function rename(v: unknown, from: string, to: string): unknown {
  if (Array.isArray(v)) return v.map((x) => rename(x, from, to));
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k === from ? to : k, rename(x, from, to)]));
  return v;
}

interface Case {
  plugin: SourcePlugin;
  name: string;
  /** Writes the reader's store with one mapped field renamed or reshaped. */
  build(): void;
  /** Drift keys the coverage must hold (others may be there too). */
  keys: string[];
  window?: "detail" | "lifetime";
}

const at = () => fixtureStart();

const CASES: Case[] = [
  {
    plugin: ccTranscripts, name: "user and assistant message content renamed", keys: ["user.content:shape", "assistant.content:shape"],
    build: () => {
      const t = new CcTranscript(ccSid("R1")).prompt("Fix the importer").tool("toolu_r1", "Read", { file_path: "a.ts" }, { content: "x" }).prompt("And add a test");
      h.writeJsonl(`.claude/projects/${slug("/work/p")}/${ccSid("R1")}.jsonl`, t.records.map((r) => rename(r, "content", "parts")));
    },
  },
  {
    plugin: ccTranscripts, name: "timestamp renamed", keys: ["timestamp:shape", "zero-yield"],
    build: () => {
      const t = new CcTranscript(ccSid("R2")).prompt("Fix the importer").tool("toolu_r2", "Read", { file_path: "a.ts" }, { content: "x" });
      h.writeJsonl(`.claude/projects/${slug("/work/p")}/${ccSid("R2")}.jsonl`, t.records.map((r) => rename(r, "timestamp", "time")));
    },
  },
  {
    plugin: ccHistory, name: "display renamed", keys: ["display:missing", "zero-yield"], window: "lifetime",
    build: () => { h.writeJsonl(".claude/history.jsonl", [ccHistoryLine("Fix the importer", at()), ccHistoryLine("And the tests", at() + 1_000)].map((l) => rename(l, "display", "text"))); },
  },
  {
    plugin: ccStats, name: "messageCount renamed", keys: ["dailyActivity:shape", "zero-yield"], window: "lifetime",
    build: () => { h.writeJson(".claude/stats-cache.json", { version: 5, dailyActivity: [{ date: "2026-01-13", messages: 120, sessionCount: 2, toolCallCount: 40 }] }); },
  },
  {
    plugin: ccConfig, name: "skillUsage usageCount renamed", keys: ["skillUsage:shape"], window: "lifetime",
    build: () => {
      h.writeJson(".claude/settings.json", {}); // the CLI's root folder: where the reader finds the global config
      h.writeJson(".claude.json", { skillUsage: { "my-skill": { count: 3, lastUsedAt: at() } } });
    },
  },
  {
    plugin: cxRollouts, name: "user message content renamed", keys: ["user.content:shape"],
    build: () => {
      const id = uuidV7(at(), 1);
      const r = new CxRollout(at(), id).meta().turn("t1").user("Fix the importer").done("t1");
      const recs = r.records.map((x) => (x.type === "response_item" ? rename(x, "content", "parts") : x));
      h.writeJsonl(rolloutRel(at(), id), recs);
    },
  },
  {
    plugin: cxRollouts, name: "timestamp renamed", keys: ["timestamp:shape", "zero-yield"],
    build: () => {
      const id = uuidV7(at(), 2);
      const r = new CxRollout(at(), id).meta().turn("t1").user("Fix the importer").done("t1");
      h.writeJsonl(rolloutRel(at(), id), r.records.map((x) => rename(x, "timestamp", "time")));
    },
  },
  {
    plugin: cxThreads, name: "creation time columns renamed", keys: ["missing-column:created_at", "missing-column:created_at_ms", "zero-yield"], window: "lifetime",
    build: () => {
      writeCodexState(h, ".codex/state_5.sqlite", [threadRow(uuidV7(at(), 3), at())], [], { columns: THREAD_COLUMNS.filter((c) => c !== "created_at" && c !== "created_at_ms") });
    },
  },
  {
    plugin: cxHistory, name: "text renamed", keys: ["text:missing", "zero-yield"], window: "lifetime",
    build: () => { h.writeJsonl(".codex/history.jsonl", [cxHistoryLine("Fix the importer", at(), uuidV7(at(), 4))].map((l) => rename(l, "text", "prompt"))); },
  },
  {
    plugin: cxConfig, name: "a section header that no longer parses", keys: ["config.toml:syntax"], window: "lifetime",
    build: () => { h.write(".codex/config.toml", '[profiles.work\nmodel = "gpt-5.1-codex"\n'); },
  },
  {
    plugin: cpVscode, name: "request message renamed", keys: ["request.message:shape"],
    build: () => {
      const id = cpSid("drift1");
      h.writeJson(path.join(userRel(h), "workspaceStorage", "w", "chatSessions", `${id}.json`), sessionRoot(id, [rename(request({ ts: at() }), "message", "prompt")]));
    },
  },
  {
    plugin: cpVscode, name: "request timestamp renamed", keys: ["request.timestamp:shape"],
    build: () => {
      const id = cpSid("drift2");
      h.writeJson(path.join(userRel(h), "workspaceStorage", "w", "chatSessions", `${id}.json`), sessionRoot(id, [rename(request({ ts: at() }), "timestamp", "time")]));
    },
  },
  {
    plugin: cpCli, name: "user message content renamed", keys: ["user.message.content:shape"],
    build: () => {
      const id = cpSid("drift3");
      const e = new CliEvents(at()).ev("session.start", { sessionId: id }, 0).ev("user.message", { content: "Fix the importer" })
        .ev("assistant.turn_start", { turnId: "0" }).ev("assistant.turn_end", { turnId: "0" });
      h.writeJsonl(path.join(".copilot", "session-state", id, "events.jsonl"), e.records.map((r) => rename(r, "content", "text")));
    },
  },
  {
    plugin: cpCli, name: "a session-state layout the reader does not know", keys: ["session-state:layout", "layout:history-session-state"],
    build: () => {
      const id = cpSid("drift4");
      h.writeJsonl(path.join(".copilot", "session-state", `${id}.jsonl`), new CliEvents(at()).ev("session.start", { sessionId: id }, 0).records);
      h.writeJson(path.join(".copilot", "history-session-state", `session_${id}.json`), { sessionId: id });
    },
  },
  {
    plugin: cuIde, name: "user bubble text renamed", keys: ["missing-field:text"],
    build: () => {
      const c = cuSid("drift5");
      writeCursorState(h, globalRel(h), [
        [`composerData:${c}`, composer(c, { created: at(), updated: at(), headers: [cuSid("u1")] })],
        [`bubbleId:${c}:${cuSid("u1")}`, rename(bubble(cuSid("u1"), { type: 1, ts: at(), text: "Fix the importer" }), "text", "content")],
      ]);
    },
  },
  {
    plugin: cuIde, name: "bubble createdAt renamed", keys: ["missing-field:createdAt"],
    build: () => {
      const c = cuSid("drift6");
      writeCursorState(h, globalRel(h), [
        [`composerData:${c}`, composer(c, { created: at(), updated: at(), headers: [cuSid("u1"), cuSid("u2")] })],
        [`bubbleId:${c}:${cuSid("u1")}`, rename(bubble(cuSid("u1"), { type: 1, ts: at(), text: "Fix the importer" }), "createdAt", "timeCreated")],
        [`bubbleId:${c}:${cuSid("u2")}`, rename(bubble(cuSid("u2"), { type: 2, ts: at() + 1_000, tool: { name: "read_file" } }), "createdAt", "timeCreated")],
      ]);
    },
  },
  {
    plugin: cuTracking, name: "commit time columns renamed", keys: ["missing-column:commitDate", "missing-column:scoredAt"], window: "lifetime",
    build: () => {
      writeTracking(h, [commitRow({ hash: "c1", date: at(), scored: at() })], { ddl: SCORED_COMMITS_DDL.replace("commitDate", "committedOn").replace("scoredAt", "scoredOn") });
    },
  },
  {
    plugin: agCli, name: "transcript input content renamed", keys: ["transcript.content:missing"],
    build: () => { h.writeJsonl(transcriptRel(agId("D1")), [rename(userInput(0, at(), "Fix the importer"), "content", "text")]); },
  },
  {
    plugin: agHistory, name: "display renamed", keys: ["history.display:missing", "zero-yield"], window: "lifetime",
    build: () => { h.writeJsonl(historyRel, [rename(historyLine({ display: "Fix the importer", timestamp: at() }), "display", "text")]); },
  },
  {
    plugin: agIde, name: "the trajectory step count moved", keys: ["trajectorySummaries:no-steps"], window: "lifetime",
    build: () => { writeIdeStore(h, ideRel(h), [[TRAJ_KEY, topic([{ key: agId("D2"), summary: trajectory({ id: agId("D2"), created: at(), updated: at() }) }])]]); },
  },
];

/** Readers that map no field of any record (presence only): nothing in them can be renamed. */
const PRESENCE_ONLY = ["copilot.jetbrains", "cursor.agent-cli", "antigravity.brain"];

describe("a renamed or reshaped field is drift, never a silent zero", () => {
  for (const c of CASES) {
    test(`${c.plugin.id}: ${c.name}`, async () => {
      c.build();
      const r = await scan({ env: h.env, plugins: [c.plugin] });
      const cov = r.coverage.find((x) => x.source === c.plugin.id && x.window === (c.window ?? "detail")) as CoverageEv;
      expect([cov.status, c.keys.filter((k) => !(k in cov.unknownTypes))]).toEqual(["drift", []]);
      expect(r.warnings.some((w) => w.code === "drift" && w.source === c.plugin.id)).toBe(true); // "format changed?"
    });
  }

  test("every reader that maps fields has a case here; the rest only count files", () => {
    const covered = new Set(CASES.map((c) => c.plugin.id));
    expect(registry.map((p) => p.id).filter((id) => !covered.has(id)).sort()).toEqual([...PRESENCE_ONLY].sort());
  });

  test("claude code: unreadable content never turns a person's session scripted; only evidence does", async () => {
    const proj = `.claude/projects/${slug("/work/p")}`;
    const t = new CcTranscript(ccSid("R3")).prompt("Fix the importer").text("ok");
    h.writeJsonl(`${proj}/${ccSid("R3")}.jsonl`, t.records.map((x) => rename(x, "content", "parts")));
    const sdk = new CcTranscript(ccSid("R4")).user({ entrypoint: "sdk-cli", message: { role: "user", parts: "Run the report" } }).text("ok");
    h.writeJsonl(`${proj}/${ccSid("R4")}.jsonl`, sdk.records);
    const r = await scan({ env: h.env, plugins: [ccTranscripts] });
    expect(r.store.session(`claude-code:${ccSid("R3")}`)!.origin).toBe("human"); // no prompt could be read: no evidence
    expect(r.store.session(`claude-code:${ccSid("R4")}`)!.origin).toBe("scripted"); // an SDK entrypoint is evidence
  });
});
