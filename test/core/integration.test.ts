import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { registry, scan, type ToolId, type Window } from "../../core/index";
import { safeList } from "../../core/io/fs";
import { TempRegistry } from "../../core/io/temp";
import type { TempDirs } from "../../core/sources/types";
import { trackingRel } from "../fixtures/cursor";
import { keyedHash } from "../../core/text/hash";
import { buildAll } from "../kit/allsources";
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
    const planted = buildAll(h);
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
  }, 30_000); // a full scan of every fixture: on a stalled CI runner it has needed more than the default 5 s

  test("a busy store whose private copy fails mid-way: that source errors, the others go on, the temp folder is empty", async () => {
    buildAll(h);
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
  }, 30_000); // a full scan of every fixture: on a stalled CI runner it has needed more than the default 5 s
});
