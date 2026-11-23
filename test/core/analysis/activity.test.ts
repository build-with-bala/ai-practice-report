import { describe, expect, test } from "bun:test";
import { dayKey, isoWeek } from "../../../core/analysis/activity";
import { buildSessionTable } from "../../../core/analysis/sessions";
import type { DailyEv, Ev, PromptEv, SessionEv } from "../../../core/model/events";
import type { ToolId } from "../../../core/model/ids";
import { scanResultOf } from "../../kit/scanresult";
import { withTz } from "../../kit/tz";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 2, 12, 0);
const opts = { now: T0 + 60 * DAY, timeZone: "UTC" };

const sess = (id: string, over: Partial<SessionEv> = {}): SessionEv => ({
  k: "session", tool: "claude-code", source: "claude-code.transcripts", id, window: "detail", origin: "human",
  start: T0, end: T0 + 60_000, models: [], ...over,
});
const prompt = (sessionId: string | undefined, ts: number, over: Partial<PromptEv> = {}): PromptEv => ({
  k: "prompt", tool: "claude-code", source: "claude-code.transcripts", ts, sessionId, window: "detail", origin: "human",
  intent: "spec", textHash: `h${ts}`,
  features: { words: 5, lenBucket: 1, hasContext: false, fileRefs: 0, listLines: 0, constraintTerms: 0, isTaskStart: true, techCats: {} },
  ...over,
});
const daily = (day: string, count: number, over: Partial<DailyEv> = {}): DailyEv => ({
  k: "daily", tool: "claude-code", source: "claude-code.stats", day, zone: "local", unit: "prompts", count, ...over,
});

describe("dayKey", () => {
  test("a 23:30 UTC prompt has different day keys in Pacific/Auckland and UTC, whatever the process zone", () => {
    const ms = Date.UTC(2026, 10, 16, 23, 30);
    for (const tz of ["UTC", "Pacific/Auckland", "America/Los_Angeles"]) {
      withTz(tz, () => {
        expect(dayKey(ms, "UTC")).toBe("2026-11-16");
        expect(dayKey(ms, "Pacific/Auckland")).toBe("2026-11-17");
      });
    }
  });

  test("the table's days follow its time zone", () => {
    const ms = Date.UTC(2026, 10, 16, 23, 30);
    const raw = scanResultOf([sess("s", { start: ms, end: ms }), prompt("s", ms)]);
    expect(buildSessionTable(raw, { ...opts, timeZone: "UTC" }).activity.detailDays).toEqual(["2026-11-16"]);
    expect(buildSessionTable(raw, { ...opts, timeZone: "Pacific/Auckland" }).activity.detailDays).toEqual(["2026-11-17"]);
  });
});

describe("isoWeek", () => {
  test("ISO-8601 weeks across the year boundary", () => {
    expect(isoWeek("2026-12-31")).toBe("2026-W53");
    expect(isoWeek("2027-01-03")).toBe("2026-W53");
    expect(isoWeek("2027-01-04")).toBe("2027-W01");
    expect(isoWeek("2026-01-01")).toBe("2026-W01");
    expect(isoWeek("2025-12-29")).toBe("2026-W01");
    expect(isoWeek("2026-11-16")).toBe("2026-W47");
  });
});

describe("activity", () => {
  test("detail and lifetime days and weeks, kept apart and per tool", () => {
    const cx = (id: string, over: Partial<SessionEv> = {}) => sess(id, { tool: "codex", source: "codex.rollouts", ...over });
    const t = buildSessionTable(scanResultOf([
      sess("a"),
      prompt("a", T0),
      prompt("a", T0 + DAY),
      prompt("a", T0 + 2 * DAY, { origin: "subagent" }), // not human
      prompt("a", T0 + 3 * DAY, { window: "lifetime", source: "claude-code.history" }),
      prompt(undefined, T0 + 10 * DAY, { window: "lifetime", source: "claude-code.history" }), // no session row: still lifetime activity
      prompt("orphan-detail", T0 + 11 * DAY), // a detail prompt needs a row
      daily("2026-11-20", 3),
      daily("2026-11-21", 3, { zone: "utc" }), // utc days never mix with local ones
      daily("2026-11-22", 3, { unit: "messages" }), // messages are not prompts
      cx("c"),
      { ...prompt("c", T0 + 7 * DAY), tool: "codex", source: "codex.rollouts" },
    ]), opts);
    expect(t.activity.detailDays).toEqual(["2026-11-02", "2026-11-03", "2026-11-09"]);
    expect(t.activity.lifetimeDays).toEqual(["2026-11-05", "2026-11-12", "2026-11-20"]);
    expect(t.activity.detailWeeks).toEqual(["2026-W45", "2026-W46"]);
    expect(t.activity.lifetimeWeeks).toEqual(["2026-W45", "2026-W46", "2026-W47"]);
    expect(t.activity.byTool).toEqual({
      "claude-code": { detailDays: ["2026-11-02", "2026-11-03"], lifetimeDays: ["2026-11-05", "2026-11-12", "2026-11-20"] },
      codex: { detailDays: ["2026-11-09"], lifetimeDays: [] },
    });
  });

  test("a DailyEv with count 0 adds no day", () => {
    const t = buildSessionTable(scanResultOf([daily("2026-11-20", 0), daily("2026-11-21", 1)]), opts);
    expect(t.activity.lifetimeDays).toEqual(["2026-11-21"]);
  });

  test("file times, config birth times and proxy markers never add days", () => {
    const evs: Ev[] = [
      { k: "file", tool: "claude-code", source: "claude-code.transcripts", pathHash: "f", bytes: 10, mtime: T0, birth: T0, ctime: T0, firstTs: T0, lastTs: T0 },
      { k: "config", tool: "claude-code", source: "claude-code.config", kind: "skill", provenance: "authored", firstSeen: T0 },
      { k: "marker", tool: "claude-code", source: "claude-code.transcripts", ts: T0, kind: "plan-artifact", proxyTs: true },
    ];
    const t = buildSessionTable(scanResultOf(evs), opts);
    expect(t.activity).toEqual({ detailDays: [], lifetimeDays: [], detailWeeks: [], lifetimeWeeks: [], byTool: {} });
  });

  test("a home whose only dated fact is a ConfigEv firstSeen has zero active days", () => {
    const t = buildSessionTable(scanResultOf([
      { k: "config", tool: "codex", source: "codex.config", kind: "instruction-file", provenance: "authored", firstSeen: T0 },
    ]), opts);
    expect(t.activity.detailDays.length + t.activity.lifetimeDays.length).toBe(0);
    expect(t.activity.detailWeeks.length + t.activity.lifetimeWeeks.length).toBe(0);
  });

  test("host copies, excluded tools, projects and dates leave the activity", () => {
    const tool = (id: string, tl: ToolId, over: Partial<SessionEv> = {}) => sess(id, { tool: tl, source: `${tl}.x`, ...over });
    const p = (sid: string, tl: ToolId, ts: number, over: Partial<PromptEv> = {}) => ({ ...prompt(sid, ts, over), tool: tl, source: `${tl}.x` });
    const evs: Ev[] = [
      tool("H", "copilot", { surface: "vscode" }), tool("A", "claude-code"),
      tool("H2", "copilot", { surface: "vscode" }), tool("B", "claude-code"), // H2 mirrors B
      ...[0, 1, 2].flatMap((i) => [
        p("H", "copilot", T0 + i * 60_000, { textHash: `x${i}` }), p("A", "claude-code", T0 + i * 60_000 + 1000, { textHash: `x${i}` }),
        p("H2", "copilot", T0 + DAY + i * 60_000, { textHash: `y${i}` }), p("B", "claude-code", T0 + DAY + i * 60_000 + 1000, { textHash: `y${i}` }),
      ]),
      tool("P", "codex", { projectKey: "secret" }), p("P", "codex", T0 + 2 * DAY),
      p("P", "codex", T0 + 3 * DAY, { window: "lifetime" }), // its row is project-excluded
      p("unknown", "codex", T0 + 4 * DAY, { window: "lifetime" }), // no row: a project exclusion cannot apply
      tool("C", "cursor"), p("C", "cursor", T0 + 5 * DAY),
      daily("2026-11-03", 1, { tool: "cursor" }),
      tool("late", "claude-code", { start: T0 + 40 * DAY, end: T0 + 40 * DAY }), p("late", "claude-code", T0 + 40 * DAY),
      daily("2026-12-20", 2),
    ];
    const t = buildSessionTable(scanResultOf(evs), { ...opts, exclude: { tools: ["cursor"], projects: ["secret"], to: T0 + 30 * DAY } });
    expect([...t.hosts].sort()).toEqual(["H", "H2"]);
    expect(t.activity.detailDays).toEqual(["2026-11-02", "2026-11-03"]);
    expect(t.activity.lifetimeDays).toEqual(["2026-11-06"]);
    expect(Object.keys(t.activity.byTool).sort()).toEqual(["claude-code", "codex"]);
  });
});
