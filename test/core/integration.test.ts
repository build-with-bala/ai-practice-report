import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { registry, scan, type ToolId, type Window } from "../../core/index";
import { safeList } from "../../core/io/fs";
import { TempRegistry } from "../../core/io/temp";
import type { TempDirs } from "../../core/sources/types";
import { agId, buildAntigravity, CLI_BRAIN_REL, historyLine, historyRel, P as AG_P, STEP, writeBrain, writeSteps } from "../fixtures/antigravity";
import { buildCcLifetime, buildCcTranscripts, CcTranscript, ccSid, fixtureStart, slug } from "../fixtures/claude-code";
import { buildCodexIndex, buildCodexRollouts, CxRollout, rateLimits, rolloutRel, threadRow, turnRow, uuidV7 } from "../fixtures/codex";
import { keyedHash } from "../../core/text/hash";
import { vscodeUser } from "../../core/env/paths";
import { buildCopilot, CliEvents, cpSid, writeSessionStore } from "../fixtures/copilot";
import { buildAgentCli, buildCursor, trackingRel } from "../fixtures/cursor";
import { CANARY, expectNoCanaries } from "../kit/canary";
import { fakeHome, type FakeHome } from "../kit/home";

/** The P0 plugins in registry order: Claude Code ×4, Codex ×4, Copilot ×3, Cursor ×3, Antigravity ×4. */
const P0 = [
  "claude-code.transcripts", "claude-code.history", "claude-code.stats", "claude-code.config",
  "codex.rollouts", "codex.threads", "codex.history", "codex.config",
  "copilot.vscode", "copilot.cli", "copilot.jetbrains",
  "cursor.ide", "cursor.tracking", "cursor.agent-cli",
  "antigravity.cli", "antigravity.history", "antigravity.ide", "antigravity.brain",
];
/** The windows each plugin reports coverage for: lifetime only, or both (a detail store and its index); the rest detail only. */
const LIFETIME = [
  "claude-code.history", "claude-code.stats", "claude-code.config", "codex.threads", "codex.history", "codex.config",
  "cursor.tracking", "antigravity.history", "antigravity.ide", "antigravity.brain",
];
const BOTH = ["copilot.vscode", "copilot.cli", "cursor.ide", "antigravity.cli"];
const windowsOf = (id: string): Window[] => (LIFETIME.includes(id) ? ["lifetime"] : BOTH.includes(id) ? ["detail", "lifetime"] : ["detail"]);
/** The one reader that reads no record by design, and the status it reports instead (it only counts its stores). */
const NO_RECORDS: ReadonlyMap<string, string> = new Map([["copilot.jetbrains", "present-undecodable"]]);
const TOOLS: ToolId[] = ["antigravity", "claude-code", "codex", "copilot", "cursor"];

let h: FakeHome;
beforeEach(() => { h = fakeHome(); });
afterEach(() => h.cleanup());

/** Every tool's fixtures in one home, plus one Copilot CLI session (the Copilot tests build theirs inline too). */
function buildAll(): Planted {
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
  return plantSlug();
}

interface Planted { rollout: string; thread: string }

/**
 * The token-shaped canary in every field that keeps a token from a trace: the two raw config-name fields (exempt) and
 * the guarded ones — surfaces, approval and sandbox modes, rate-limit buckets, turn statuses, and the drift keys of
 * unknown types and values. It may come out through the exempt fields only. (buildAll plants it in the Copilot CLI's
 * event types and store host, and in Antigravity's history types.)
 */
function plantSlug(): Planted {
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
  // …and a thread's source, approval and sandbox, and a turn's status, in the index
  const thread = uuidV7(t, 0x5b);
  insertRow(path.join(".codex", "state_5.sqlite"), "threads",
    threadRow(thread, t, { source: CANARY.slug, approval_mode: CANARY.slug, sandbox_policy: JSON.stringify({ type: CANARY.slug }) }));
  const s0 = Math.floor(t / 1000);
  insertRow(path.join(".codex", "thread_history_1.sqlite"), "thread_turns", turnRow(thread, "turn-slug", CANARY.slug, s0, s0 + 5, 5_000));
  return { rollout, thread };
}

/** One row into a fixture database: the row's fields the table has a column for. */
function insertRow(rel: string, table: string, row: Record<string, unknown>): void {
  const db = new Database(path.join(h.env.home, rel));
  try {
    const cols = (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name).filter((c) => c in row);
    db.query(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...(cols.map((c) => row[c]) as (string | number | null)[]));
  } finally {
    db.close();
  }
}

/** A temp registry that records the dirs it makes and how many files each held when the scan disposed of them. */
function watched(base: string, dirs: { dir: string; files: number }[]): TempDirs {
  const reg = new TempRegistry(base);
  return {
    dir: () => {
      const dir = reg.dir();
      dirs.push({ dir, files: 0 });
      return dir;
    },
    disposeAll: () => {
      for (const d of dirs) d.files = safeList(d.dir).length;
      reg.disposeAll();
    },
    get active() {
      return reg.active;
    },
  };
}

describe("integration: every P0 source in one home", () => {
  test("the registry holds the 18 P0 plugins once each, by tool, and declares the windows each reports", () => {
    expect(registry.map((p) => p.id)).toEqual(P0);
    expect(new Set(registry).size).toBe(registry.length);
    expect(registry.every((p) => p.tier === "P0")).toBe(true);
    expect(registry.map((p) => [p.id, p.windows ?? ["detail"]])).toEqual(P0.map((id) => [id, windowsOf(id)]));
  });

  test("scan(): one coverage per candidate and window, events for all five tools, temp clean, no canaries", async () => {
    const planted = buildAll();
    const r = await scan({ env: h.env });

    for (const p of registry) {
      const covs = r.coverage.filter((c) => c.source === p.id);
      const cands = p.locate(h.env, [h.env.home]).length;
      expect(cands).toBeGreaterThan(0);
      expect([p.id, covs.map((c) => c.window).sort()]).toEqual([p.id, Array.from({ length: cands }, () => windowsOf(p.id)).flat().sort()]);
      for (const c of covs) {
        expect(`${p.id} ${c.window} ${c.status}`).not.toMatch(/ (absent|empty|error)$/); // every store here holds data
        // every window read records — never a silent zero — but for the presence-only reader, which says so
        if (NO_RECORDS.has(p.id)) expect(`${p.id} ${c.status}`).toBe(`${p.id} ${NO_RECORDS.get(p.id)!}`);
        else expect(`${p.id} ${c.window} records>0:${c.records > 0}`).toBe(`${p.id} ${c.window} records>0:true`);
        expect(`${p.id} ${c.window} zero-yield:${"zero-yield" in c.unknownTypes}`).toBe(`${p.id} ${c.window} zero-yield:false`);
      }
    }
    for (const kind of ["session", "prompt", "tool"] as const) {
      expect([kind, [...new Set(r.store.all(kind).map((e) => e.tool))].sort()]).toEqual([kind, TOOLS]);
    }
    // the event contract: a call whose category is a check lists that check
    const CHECK_CATEGORIES = ["test", "build", "lint", "typecheck"];
    const unchecked = r.store.all("tool").filter((t) => CHECK_CATEGORIES.includes(t.category) && !t.checks?.includes(t.category as never));
    expect(unchecked.map((t) => [t.source, t.name, t.category])).toEqual([]);
    // a call that did not run to an end of its own has no ok and no exit code
    expect(r.store.all("tool").filter((t) => t.outcome !== undefined && (t.ok !== undefined || t.exit !== undefined))).toEqual([]);
    expect(r.warnings.filter((w) => w.code === "error" || w.code === "temp-leftover")).toEqual([]);
    expect(r.tempClean).toBe(true);
    expect(readdirSync(h.env.tmp)).toEqual([]);
    expect([...r.cwds.values()]).toContain(CANARY.path); // raw cwds live only in this in-memory map
    expectNoCanaries([r.store, r.coverage, r.warnings], { allow: ["mcp", "slug"] }); // those two in the exempt fields only
    // the token-shaped canary was read everywhere it was planted: raw in the exempt fields, an enum or hash elsewhere
    expect(r.store.all("tool").filter((t) => t.mcpServer === CANARY.slug).map((t) => t.tool)).toEqual(["claude-code"]);
    expect(r.store.all("config").filter((c) => c.name === CANARY.slug).map((c) => [c.tool, c.kind])).toEqual([["codex", "profile"]]);
    const drift = new Set(r.coverage.flatMap((c) => Object.keys(c.unknownTypes)));
    for (const key of ["(other)", "promptSource:<other>", "event_msg:(other)", "response_item:(other)", "turn-status:(other)", "event:(other)", "history.type:(other)"]) {
      expect(`${key} ${drift.has(key)}`).toBe(`${key} true`);
    }
    expect(r.store.all("ratelimit").map((l) => l.bucket)).toContain(keyedHash(r.salt, CANARY.slug));
    expect(r.store.session(`codex:${planted.rollout}`)).toMatchObject({ surface: "other" });
    expect(r.store.session(`codex:${planted.thread}`)).toMatchObject({ surface: "other", approval: "other", sandbox: "other" });
  });

  test("a busy store whose private copy fails mid-way: that source errors, the others go on, the temp folder is empty", async () => {
    buildAll();
    const store = path.join(h.env.home, trackingRel);
    const holder = new Database(store);
    try {
      holder.exec("BEGIN EXCLUSIVE"); // readers get SQLITE_BUSY, so openRo falls back to a private copy…
      mkdirSync(`${store}-wal`); // …which fails at the -wal, after the store itself was copied
      const dirs: { dir: string; files: number }[] = [];
      const r = await scan({ env: h.env, tempFactory: (base) => watched(base, dirs) });

      expect(r.coverage.filter((c) => c.status === "error").map((c) => [c.source, c.window])).toEqual([["cursor.tracking", "lifetime"]]);
      expect(r.store.all("commit")).toEqual([]);
      expect(r.store.all("session").filter((s) => s.tool === "cursor")).not.toEqual([]); // the store beside it was read
      expect(dirs.map((d) => d.files)).toEqual([1]); // one private copy, cut off after its first file…
      expect(dirs.filter((d) => existsSync(d.dir))).toEqual([]); // …removed with the scan's temp folder
      expect(r.tempClean).toBe(true);
      expect(readdirSync(h.env.tmp)).toEqual([]);
      expectNoCanaries([r.store, r.coverage, r.warnings], { allow: ["mcp", "slug"] });
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
  });
});
