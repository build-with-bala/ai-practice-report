import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { registry, scan, type ToolId } from "../../core/index";
import { safeList } from "../../core/io/fs";
import { TempRegistry } from "../../core/io/temp";
import type { TempDirs } from "../../core/sources/types";
import { agId, buildAntigravity, STEP, writeSteps } from "../fixtures/antigravity";
import { buildCcLifetime, buildCcTranscripts } from "../fixtures/claude-code";
import { buildCodexIndex, buildCodexRollouts } from "../fixtures/codex";
import { buildCopilot, CliEvents, cpSid } from "../fixtures/copilot";
import { buildAgentCli, buildCursor, trackingRel } from "../fixtures/cursor";
import { CANARY, expectNoCanaries } from "../kit/canary";
import { fakeHome, type FakeHome } from "../kit/home";

/** The P0 plugins in registry order: Claude Code ×4, Codex ×4, Copilot ×3, Cursor ×3, Antigravity ×3. */
const P0 = [
  "claude-code.transcripts", "claude-code.history", "claude-code.stats", "claude-code.config",
  "codex.rollouts", "codex.threads", "codex.history", "codex.config",
  "copilot.vscode", "copilot.cli", "copilot.jetbrains",
  "cursor.ide", "cursor.tracking", "cursor.agent-cli",
  "antigravity.cli", "antigravity.ide", "antigravity.brain",
];
/** The plugins whose coverage is a lifetime window (every other one reports the detail window). */
const LIFETIME = [
  "claude-code.history", "claude-code.stats", "claude-code.config", "codex.threads", "codex.history", "codex.config",
  "cursor.tracking", "antigravity.ide", "antigravity.brain",
];
const TOOLS: ToolId[] = ["antigravity", "claude-code", "codex", "copilot", "cursor"];

let h: FakeHome;
beforeEach(() => { h = fakeHome(); });
afterEach(() => h.cleanup());

/** Every tool's fixtures in one home, plus one Copilot CLI session (the Copilot tests build theirs inline too). */
function buildAll(): void {
  buildCcTranscripts(h);
  buildCcLifetime(h);
  buildCodexRollouts(h);
  buildCodexIndex(h);
  buildCopilot(h);
  const id = cpSid("cli");
  const cli = new CliEvents()
    .ev("session.start", { sessionId: id, version: 1, producer: "copilot-agent", copilotVersion: "1.0.4", context: { cwd: CANARY.path } }, 0)
    .ev("user.message", { content: `Fix the build. ${CANARY.prompt}`, attachments: [] })
    .ev("assistant.turn_start", { turnId: "0" })
    .ev("tool.execution_start", { toolCallId: "t1", toolName: "bash", arguments: { command: `npm test ${CANARY.path}` } })
    .ev("tool.execution_complete", { toolCallId: "t1", success: true, result: { content: CANARY.secret } })
    .ev("assistant.turn_end", { turnId: "0" });
  h.writeJsonl(path.join(".copilot", "session-state", id, "events.jsonl"), cli.records);
  buildCursor(h);
  buildAgentCli(h);
  const ag = buildAntigravity(h);
  // typed check steps: their category is a check, and the contract says so in `checks` too
  writeSteps(h, agId("T"), [
    { type: STEP.BLAZE_TEST_TARGETS, ts: ag.t0 + 70_000 }, { type: STEP.COMPILE, ts: ag.t0 + 80_000 }, { type: STEP.LINT_APPLET, ts: ag.t0 + 90_000 },
  ]);
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
  test("the registry holds the 17 P0 plugins once each, by tool, and declares which report a lifetime window", () => {
    expect(registry.map((p) => p.id)).toEqual(P0);
    expect(new Set(registry).size).toBe(registry.length);
    expect(registry.every((p) => p.tier === "P0")).toBe(true);
    expect(registry.filter((p) => p.window === "lifetime").map((p) => p.id)).toEqual(LIFETIME);
  });

  test("scan(): one coverage per candidate in the plugin's window, events for all five tools, temp clean, no canaries", async () => {
    buildAll();
    const r = await scan({ env: h.env });

    for (const p of registry) {
      const covs = r.coverage.filter((c) => c.source === p.id);
      const want = p.locate(h.env, [h.env.home]).length;
      expect([p.id, covs.length]).toEqual([p.id, want]);
      expect(want).toBeGreaterThan(0);
      for (const c of covs) expect([p.id, c.window, ["absent", "error"].includes(c.status)]).toEqual([p.id, p.window ?? "detail", false]);
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
    expectNoCanaries([r.store, r.coverage, r.warnings], { allow: ["mcp"] });
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
      expectNoCanaries([r.store, r.coverage, r.warnings], { allow: ["mcp"] });
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
  });
});
