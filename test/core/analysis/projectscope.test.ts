import { describe, expect, test } from "bun:test";
import { analyze } from "../../../core/analyze";
import { artifactUse } from "../../../core/analysis/artifacts";
import { analysisScope } from "../../../core/analysis/scope";
import { buildSessionTable } from "../../../core/analysis/sessions";
import type { ConfigEv, DailyEv, Ev, PromptEv, SessionEv } from "../../../core/model/events";
import { scanResultOf } from "../../kit/scanresult";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 7, 12); // a Monday
const HIST = "claude-code.history";
const opts = { timeZone: "UTC" };

const sess = (id: string, start: number, over: Partial<SessionEv> = {}): SessionEv => ({
  k: "session", tool: "claude-code", source: "claude-code.transcripts", id, window: "detail", origin: "human", start, end: start + 60_000, models: [], ...over,
});
const life = (ts: number, over: Partial<PromptEv> = {}): PromptEv => ({
  k: "prompt", tool: "claude-code", source: HIST, ts, window: "lifetime", origin: "human", intent: "spec", textHash: `h${ts}`,
  features: { words: 6, lenBucket: 1, hasContext: false, fileRefs: 0, listLines: 0, constraintTerms: 0, isTaskStart: true, techCats: {} }, ...over,
});
const daily = (day: string, source = HIST, over: Partial<DailyEv> = {}): DailyEv =>
  ({ k: "daily", tool: "claude-code", source, day, zone: "local", unit: "prompts", count: 3, ...over });
const conf = (name: string, projectKey?: string): ConfigEv =>
  ({ k: "config", tool: "claude-code", source: "claude-code.config", kind: "mcp-server", name, provenance: "installed", uses: 4, ...(projectKey ? { projectKey } : {}) });
const day = (i: number): string => new Date(T0 + i * DAY).toISOString().slice(0, 10);

/** Project kA: 5 days of history prompts carrying the project (transcripts gone); kB: 3 days; the history's own per-day rows for all 8. */
function world(): Ev[] {
  const evs: Ev[] = [];
  for (let i = 0; i < 5; i++) evs.push(life(T0 + i * DAY, { projectKey: "kA" }), daily(day(i)));
  for (let i = 10; i < 13; i++) evs.push(life(T0 + i * DAY, { projectKey: "kB" }), daily(day(i)));
  evs.push(life(T0 + 20 * DAY, { sessionId: "claude-code:gone", projectKey: "kA" })); // its transcript is gone: the store holds no such session
  evs.push(conf("server-a", "kA"), conf("server-b", "kB"), conf("server-user"));
  return evs;
}

describe("a project exclusion removes everything that carries the project", () => {
  test("lifetime prompts carrying the project are out; the per-day rows of a source that supplied prompts are never read", () => {
    const t = buildSessionTable(scanResultOf(world()), { ...opts, exclude: { projects: ["kA"] } });
    expect(t.activity.lifetimeDays).toEqual([day(10), day(11), day(12)]);
    const all = buildSessionTable(scanResultOf(world()), opts);
    expect(all.activity.lifetimeDays).toEqual([0, 1, 2, 3, 4, 10, 11, 12, 20].map(day));
  });

  test("a per-day row is read only for a source that supplied no prompts; under a project exclusion it is left out and counted", () => {
    const evs: Ev[] = [daily(day(1), "other.stats"), daily(day(2), "other.stats"), life(T0 + 5 * DAY), daily(day(6))];
    const plain = buildSessionTable(scanResultOf(evs), opts);
    expect(plain.activity.lifetimeDays).toEqual([day(1), day(2), day(5)]);
    expect(plain.dailyRowsLeftOut).toBe(0);
    const ex = buildSessionTable(scanResultOf([...evs, sess("s", T0, { projectKey: "kZ" })]), { ...opts, exclude: { projects: ["kZ"] } });
    expect(ex.activity.lifetimeDays).toEqual([day(5)]);
    expect(ex.dailyRowsLeftOut).toBe(2);
  });

  test("scope.projects holds every excluded key given, matched or not", () => {
    const t = buildSessionTable(scanResultOf(world()), { ...opts, exclude: { projects: ["kA", "kNone"] } });
    expect([...t.scope.projects].sort()).toEqual(["kA", "kNone"]);
  });

  test("human() leaves out a prompt carrying an excluded project; a prompt naming a kept row follows the row", () => {
    const evs: Ev[] = [...world(), sess("row", T0 + 30 * DAY, { projectKey: "kB" })];
    const raw = scanResultOf(evs);
    const t = buildSessionTable(raw, { ...opts, exclude: { projects: ["kA"] } });
    const { human } = analysisScope(raw, t);
    expect(human(life(T0, { projectKey: "kA" }))).toBe(false);
    expect(human(life(T0, { projectKey: "kB" }))).toBe(true);
    expect(human(life(T0))).toBe(true);
    expect(human(life(T0 + 30 * DAY, { sessionId: "row", projectKey: "kA" }))).toBe(true); // follows its kept row
  });

  test("config entries carrying the project are out", () => {
    const raw = scanResultOf(world());
    const t = buildSessionTable(raw, { ...opts, exclude: { projects: ["kA"] } });
    expect(analysisScope(raw, t).configs.map((c) => c.name).sort()).toEqual(["server-b", "server-user"]);
    expect(artifactUse(raw, t).map((a) => a.name)).toEqual(["server-b", "server-user"]);
  });

  test("analyze: a project known only from prompts or config entries has a label and can be excluded by it", () => {
    const raw = () => scanResultOf(world());
    const keyOnly = analyze(raw(), { ...opts, exclude: { projects: ["kA"] } });
    expect(keyOnly.exposure.activeWeeks.lifetime.n).toBe(3);
    const configOnly = analyze(scanResultOf([conf("server-c", "kC"), life(T0)]), { ...opts, exclude: { projects: ["kC"] } });
    expect(configOnly.config.byKind["mcp-server"]).toBeUndefined();
    expect(configOnly.diagnostics.dailyRowsLeftOut).toBe(0);
  });
});
