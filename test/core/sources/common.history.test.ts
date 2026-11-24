import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { DailyEv, Ev, PromptEv } from "../../../core/model/events";
import { Tally } from "../../../core/sources/common/coverage";
import { PromptLog } from "../../../core/sources/common/history";
import type { PluginCoverage, ScanCtx } from "../../../core/sources/types";
import { shingleSimilarity } from "../../../core/text/similarity";
import { fakeHome, type FakeHome } from "../../kit/home";
import { withTz } from "../../kit/tz";

let h: FakeHome;
beforeEach(() => { h = fakeHome(); });
afterEach(() => h.cleanup());

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 14, 9, 0);
const SOURCE = "codex.history";

/** A prompt log over a context that keeps what it emits; a hash is readable (`h(<text>)`). */
function logOf() {
  const events: (Ev | PluginCoverage)[] = [];
  const ctx: ScanCtx = {
    env: h.env, now: Date.now(), salt: new Uint8Array(32), signal: new AbortController().signal,
    temp: { dir: () => { throw new Error("no temp files here"); }, disposeAll: () => {}, active: 0 },
    emit: (e) => events.push(e), hash: (v) => `h(${v})`, registerCwd: (cwd) => cwd, log: () => {},
  };
  const tally = new Tally("codex", SOURCE, "lifetime");
  return {
    log: new PromptLog(ctx, "codex", SOURCE, tally),
    tally,
    prompts: () => events.filter((e): e is PromptEv => e.k === "prompt"),
    daily: () => events.filter((e): e is DailyEv => e.k === "daily"),
  };
}

describe("PromptLog", () => {
  test("interleaved sessions start a task each, and each prompt is compared with its own session's previous one", () => {
    const { log, prompts, tally } = logOf();
    const a1 = "  Refactor the importer to stream its input  ";
    const b1 = "Why does the last page repeat on every request?";
    const a2 = "Refactor the importer to stream its input, then add a test";
    log.add({ text: a1, ts: T0, sessionId: "codex:a" });
    log.add({ text: b1, ts: T0 + MIN, sessionId: "codex:b" });
    log.add({ text: a2, ts: T0 + 2 * MIN, sessionId: "codex:a" });
    log.add({ text: "ok", ts: T0 + 3 * MIN, sessionId: "codex:b" });
    log.add({ text: "no session here", ts: T0 + 4 * MIN }); // prompts without a session id are one session of their own
    log.add({ text: "nor here", ts: T0 + 5 * MIN });
    const p = prompts();
    expect(p.map((e) => [e.sessionId, e.features.isTaskStart])).toEqual([
      ["codex:a", true], ["codex:b", true], ["codex:a", false], ["codex:b", false], [undefined, true], [undefined, false],
    ]);
    expect(shingleSimilarity(a2, a1)).not.toBe(shingleSimilarity(a2, b1)); // so the next line tells the two apart
    expect(p[2]!.features.simToPrev).toBe(shingleSimilarity(a2, a1));
    expect(p[0]!.features.simToPrev).toBeUndefined();
    expect(p[0]).toMatchObject({
      k: "prompt", tool: "codex", source: SOURCE, ts: T0, sessionId: "codex:a", window: "lifetime", origin: "human",
      textHash: "h(Refactor the importer to stream its input)",
    });
    expect(p.every((e) => !("hasPaste" in e))).toBe(true);
    expect([tally.from, tally.to]).toEqual([T0, T0 + 5 * MIN]);
  });

  test("a prompt 31 min after its session's previous prompt starts a task: the gap runs from the previous prompt", () => {
    const { log, prompts } = logOf();
    log.add({ text: "first", ts: T0, sessionId: "codex:a" });
    log.add({ text: "29 min later", ts: T0 + 29 * MIN, sessionId: "codex:a" });
    log.add({ text: "31 min after that", ts: T0 + 60 * MIN, sessionId: "codex:a" });
    expect(prompts().map((e) => e.features.isTaskStart)).toEqual([true, false, true]);
  });

  test("a paste, when the reader can tell, is kept on the prompt and counts as context", () => {
    const { log, prompts } = logOf();
    log.add({ text: "see the trace", ts: T0, hasPaste: true });
    log.add({ text: "and again", ts: T0 + MIN, hasPaste: false });
    expect(prompts().map((e) => [e.hasPaste, e.features.hasContext])).toEqual([[true, true], [false, false]]);
  });

  test("finish() writes one DailyEv per local day of the process zone: two under Pacific/Auckland, one under UTC", () => {
    const times = [Date.parse("2026-01-14T23:30:00+13:00"), Date.parse("2026-01-15T00:30:00+13:00"), Date.parse("2026-01-15T00:40:00+13:00")];
    const day = (d: string, count: number): DailyEv => ({ k: "daily", tool: "codex", source: SOURCE, day: d, zone: "local", unit: "prompts", count });
    const daysIn = (tz: string): DailyEv[] => {
      let out: DailyEv[] = [];
      withTz(tz, () => {
        const { log, daily } = logOf();
        times.forEach((ts, i) => log.add({ text: `prompt ${i}`, ts }));
        log.finish();
        out = daily();
      });
      return out;
    };
    expect(daysIn("Pacific/Auckland")).toEqual([day("2026-01-14", 1), day("2026-01-15", 2)]);
    expect(daysIn("UTC")).toEqual([day("2026-01-14", 3)]); // all three are one UTC day
  });
});
