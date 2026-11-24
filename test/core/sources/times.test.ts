import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { localDay } from "../../../core/io/time";
import { scan } from "../../../core/scan";
import { ccConfig, ccStats } from "../../../core/sources/claude-code";
import { cxConfig } from "../../../core/sources/codex";
import { cpVscode } from "../../../core/sources/copilot";
import { cuIde, cuTracking } from "../../../core/sources/cursor";
import type { SourcePlugin } from "../../../core/sources/types";
import { userRel } from "../../fixtures/copilot";
import { bubble, composer, globalRel, writeStateDb } from "../../fixtures/cursor";
import { fakeHome, type FakeHome } from "../../kit/home";

/** Every time a reader emits passes the plausible-range bound: never before 2015, never more than two days ahead. */
const MIN_MS = Date.UTC(2015, 0, 1);
let h: FakeHome;
beforeEach(() => { h = fakeHome(); });
afterEach(() => h.cleanup());
const run = (plugins: SourcePlugin[]) => scan({ env: h.env, plugins, repoSignals: false, handleSignals: false });

describe("Copilot VS Code: a turn's time built from elapsedMs", () => {
  test("elapsedMs above a day, negative or not finite is ignored; the turn time stays plausible", async () => {
    const now = Date.now();
    for (const [elapsedMs, ms] of [[4_200, 4_200], [1e13, undefined], [1e300, undefined], [-5, undefined], [86_400_001, undefined]] as const) {
      h.cleanup();
      h = fakeHome();
      const id = "bbbbbbbb-1111-4222-8333-444444444444";
      const session = { version: 3, sessionId: id, creationDate: now - 600_000, lastMessageDate: now - 500_000, requests: [
        { requestId: "r1", timestamp: now - 600_000, message: { text: "Fix the importer" }, response: [], result: {}, elapsedMs, modelId: "copilot/gpt-5.1" },
      ] };
      h.write(path.join(userRel(h), "workspaceStorage", "w1", "chatSessions", `${id}.json`), JSON.stringify(session));
      const r = await run([cpVscode]);
      const turns = r.store.all("turn");
      expect(turns).toHaveLength(1);
      const turn = turns[0]!;
      expect([elapsedMs, turn.ms]).toEqual([elapsedMs, ms]);
      expect(turn.ts).toBeLessThanOrEqual(now + 2 * 86_400_000);
      expect(() => localDay(turn.ts, "UTC")).not.toThrow();
      const cov = r.coverage.find((c) => c.window === "detail")!;
      expect(cov.to!).toBeLessThanOrEqual(now + 2 * 86_400_000);
      expect(r.store.all("session")[0]!.end).toBeLessThanOrEqual(now + 2 * 86_400_000);
    }
  });
});

describe("Claude Code stats cache: days and counts", () => {
  test("a day outside the plausible range is dropped as bad-ts; a row with a count that is not a non-negative safe integer is dropped as bad-count", async () => {
    const today = new Date().toISOString().slice(0, 10);
    h.write(path.join(".claude", "stats-cache.json"), JSON.stringify({ version: 5, dailyActivity: [
      { date: "1971-01-01", messageCount: 5, sessionCount: 1, toolCallCount: 2 },
      { date: "2999-12-31", messageCount: 5, sessionCount: 1, toolCallCount: 2 },
      { date: today, messageCount: -7, sessionCount: 1, toolCallCount: 2 },
      { date: today, messageCount: 5, sessionCount: 1e308, toolCallCount: 2 },
      { date: today, messageCount: 5, sessionCount: 1, toolCallCount: 2.5 },
      { date: today, messageCount: 5, sessionCount: 1, toolCallCount: 2 },
    ] }));
    const r = await run([ccStats]);
    expect(r.store.all("daily").map((d) => [d.day, d.count, d.sessions, d.toolCalls])).toEqual([[today, 5, 1, 2]]);
    const cov = r.coverage[0]!;
    expect([cov.status, cov.skipped, cov.unknownTypes]).toEqual(["ok", { "bad-ts": 2, "bad-count": 3 }, {}]);
    expect(cov.from!).toBeGreaterThanOrEqual(MIN_MS);
  });
});

describe("config: firstSeen", () => {
  const backdate = (rel: string) => {
    const old = new Date("1985-10-26T08:15:00Z");
    utimesSync(path.join(h.env.home, rel), old, old); // where an earlier mtime pulls the birth time back too (APFS)
  };
  const expectBounded = (v: number | undefined) => {
    if (v !== undefined) expect(v).toBeGreaterThanOrEqual(MIN_MS);
  };

  test("a skill folder whose times are set back gives no firstSeen, never a time before the plausible range", async () => {
    h.write(".claude/skills/old/SKILL.md", "x");
    backdate(".claude/skills/old");
    h.write(".codex/skills/old/SKILL.md", "x");
    backdate(".codex/skills/old");
    const r = await run([ccConfig, cxConfig]);
    const skills = r.store.all("config").filter((c) => c.kind === "skill");
    expect(skills).toHaveLength(2);
    for (const s of skills) expectBounded(s.firstSeen);
    const st = statSync(path.join(h.env.home, ".claude/skills/old"));
    if (st.birthtimeMs > 0 && st.birthtimeMs < MIN_MS) for (const s of skills) expect(s.firstSeen).toBeUndefined();
  });

  test("a fresh skill folder: its birth time where the file system records one, else none (never the change time)", async () => {
    mkdirSync(path.join(h.env.home, ".claude/skills/new"), { recursive: true });
    writeFileSync(path.join(h.env.home, ".claude/skills/new/SKILL.md"), "x");
    const r = await run([ccConfig]);
    const st = statSync(path.join(h.env.home, ".claude/skills/new"));
    expect(r.store.all("config").find((c) => c.kind === "skill")!.firstSeen).toBe(st.birthtimeMs > 0 ? Math.floor(st.birthtimeMs) : undefined);
  });
});

describe("Cursor: an implausible time is bad-ts, not no-ts", () => {
  test("a bubble created in 1990, and a scored commit dated 1990", async () => {
    const now = Date.now();
    const A = "00000000-0000-4000-a000-0000000000aa";
    const u = "00000000-0000-4000-a000-0000000000a1";
    const v = "00000000-0000-4000-a000-0000000000a2";
    writeStateDb(h, globalRel(h), [
      [`composerData:${A}`, composer(A, { created: now - 60_000, updated: now - 30_000, headers: [u, v] })],
      [`bubbleId:${A}:${u}`, bubble(u, { type: 1, ts: now - 50_000, text: "Fix it" })],
      [`bubbleId:${A}:${v}`, bubble(v, { type: 1, ts: Date.UTC(1990, 0, 1), text: "Old" })],
    ]);
    const db = h.sqlite(path.join(".cursor", "ai-tracking", "ai-code-tracking.db"), ["CREATE TABLE scored_commits (commitHash TEXT, commitDate INTEGER, scoredAt INTEGER, tabLinesAdded INTEGER, composerLinesAdded INTEGER, humanLinesAdded INTEGER)"],
      { scored_commits: [["h1", Date.UTC(1990, 0, 1), null, 1, 0, 1], ["h2", null, null, 1, 0, 1], ["h3", now - 1000, null, 1, 0, 1]] });
    expect(db).toBeDefined();
    const r = await run([cuIde, cuTracking]);
    const detail = r.coverage.find((c) => c.source === "cursor.ide" && c.window === "detail")!;
    expect(detail.skipped["bad-ts"]).toBe(1);
    expect(detail.skipped["no-ts"]).toBeUndefined();
    const tracking = r.coverage.find((c) => c.source === "cursor.tracking")!;
    expect(tracking.skipped).toEqual({ "bad-ts": 1, "no-ts": 1 });
  });
});
