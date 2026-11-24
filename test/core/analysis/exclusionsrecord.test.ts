import { describe, expect, test } from "bun:test";
import { analyze } from "../../../core/analyze";
import { isoWeek } from "../../../core/analysis/activity";
import type { CoverageEv, Ev, PromptEv, SessionEv } from "../../../core/model/events";
import { scanResultOf } from "../../kit/scanresult";

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const T0 = Date.UTC(2026, 5, 1, 12); // a Monday
const NOW = T0 + 20 * WEEK;
const opts = { timeZone: "UTC", now: NOW };
const features = { words: 6, lenBucket: 1 as const, hasContext: false, fileRefs: 0, listLines: 0, constraintTerms: 0, isTaskStart: true, techCats: {} };
const life = (ts: number, over: Partial<PromptEv> = {}): PromptEv =>
  ({ k: "prompt", tool: "claude-code", source: "claude-code.history", ts, window: "lifetime", origin: "human", intent: "spec", textHash: `l${ts}`, features, ...over });
const det = (sessionId: string, ts: number): PromptEv =>
  ({ k: "prompt", tool: "claude-code", source: "claude-code.transcripts", ts, sessionId, window: "detail", origin: "human", intent: "spec", textHash: `d${ts}`, features });
const sess = (id: string, start: number, over: Partial<SessionEv> = {}): SessionEv =>
  ({ k: "session", tool: "claude-code", source: "claude-code.transcripts", id, window: "detail", origin: "human", start, end: start + 60_000, models: [], ...over });
const cov = (tool: CoverageEv["tool"], status: CoverageEv["status"]): CoverageEv =>
  ({ k: "coverage", tool, source: `${tool}.x`, window: "lifetime", status, beta: false, files: 0, bytes: 0, records: 0, skipped: {}, unknownTypes: {}, versions: [] });

/** 20 weeks of history (one prompt a week), and transcripts for the last 4 weeks (one session a week). */
function persona(): Ev[] {
  const evs: Ev[] = [];
  for (let w = 0; w < 20; w++) evs.push(life(T0 + w * WEEK));
  for (let w = 16; w < 20; w++) evs.push(sess(`s${w}`, T0 + w * WEEK + DAY), det(`s${w}`, T0 + w * WEEK + DAY));
  return evs;
}

describe("the exclusions record says what was asked", () => {
  test("no exclusion: every field present, all zero or false", () => {
    expect(analyze(scanResultOf(persona()), opts).exclusions).toEqual({ tools: 0, projects: 0, sessions: 0, dateRange: false, weeksOutside: 0 });
  });

  test("a date range that removes only lifetime data is recorded, with the active weeks it leaves out; the weekly series holds no week outside it", () => {
    const from = T0 + 15 * WEEK;
    const a = analyze(scanResultOf(persona()), { ...opts, exclude: { from } });
    expect(a.exclusions).toEqual({ tools: 0, projects: 0, sessions: 0, dateRange: true, weeksOutside: 15 });
    const first = isoWeek(new Date(from).toISOString().slice(0, 10));
    expect(a.exposure.weekly.length).toBe(6);
    expect(a.exposure.weekly.every((w) => w.week >= first)).toBe(true);
    const full = analyze(scanResultOf(persona()), opts);
    expect(full.exposure.weekly.length).toBe(52);
  });

  test("an end before now leaves later weeks out of the series and counts the active ones", () => {
    const a = analyze(scanResultOf(persona()), { ...opts, exclude: { to: T0 + 9 * WEEK } });
    expect(a.exclusions.weeksOutside).toBe(10);
    const last = isoWeek(new Date(T0 + 9 * WEEK).toISOString().slice(0, 10));
    expect(a.exposure.weekly.at(-1)!.week).toBe(last);
  });

  test("weeks outside the range count only activity of tools and projects that are not excluded", () => {
    const evs = [...persona(), life(T0 + 2 * WEEK + DAY, { tool: "codex", source: "codex.history" }), life(T0 - 3 * WEEK, { projectKey: "kX" })];
    const a = analyze(scanResultOf(evs), { ...opts, exclude: { from: T0 + 15 * WEEK, tools: ["codex"], projects: ["kX"] } });
    expect(a.exclusions).toEqual({ tools: 1, projects: 1, sessions: 0, dateRange: true, weeksOutside: 15 });
  });

  test("an excluded tool with no session rows counts; one whose only coverage is absent does not", () => {
    const evs = [...persona(), life(T0, { tool: "codex", source: "codex.history" }), cov("cursor", "ok"), cov("copilot", "absent")];
    const a = analyze(scanResultOf(evs), { ...opts, exclude: { tools: ["codex", "cursor", "copilot", "zed"] } });
    expect(a.exclusions.tools).toBe(2);
  });

  test("an excluded project counts when any session, prompt or config entry carries it", () => {
    const evs: Ev[] = [...persona(), life(T0, { projectKey: "kP" }),
      { k: "config", tool: "claude-code", source: "claude-code.config", kind: "skill", name: "s", provenance: "authored", projectKey: "kC" }];
    const a = analyze(scanResultOf(evs), { ...opts, exclude: { projects: ["kP", "kC"] } });
    expect(a.exclusions.projects).toBe(2);
  });
});
