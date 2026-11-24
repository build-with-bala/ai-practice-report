import { describe, expect, test } from "bun:test";
import { analyze } from "../../../core/analyze";
import type { CoverageEv, Ev, PromptFeatures, SessionEv } from "../../../core/model/events";
import type { Origin } from "../../../core/model/ids";
import { scanResultOf } from "../../kit/scanresult";

const SEC = 1_000;
const MIN = 60 * SEC;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 5, 10);
const f: PromptFeatures = { words: 12, lenBucket: 1, hasContext: false, fileRefs: 0, listLines: 0, constraintTerms: 0, isTaskStart: true, techCats: {} };
const cov = (tool: CoverageEv["tool"], source: string): CoverageEv =>
  ({ k: "coverage", tool, source, window: "detail", status: "ok", beta: false, files: 1, bytes: 1, records: 1, skipped: {}, unknownTypes: {}, versions: [] });

/** 6 Claude Code sessions, each delegating 4 Codex runs that work inside its buckets (origin and parent link as given). */
function world(childOrigin: Origin | undefined, linked: boolean): Ev[] {
  const evs: Ev[] = [cov("claude-code", "claude-code.transcripts"), cov("codex", "codex.rollouts")];
  for (let d = 0; d < 6; d++) {
    const id = `claude-code:s${d}`;
    const start = T0 + d * DAY;
    evs.push({ k: "session", tool: "claude-code", source: "claude-code.transcripts", id, window: "detail", origin: "human", start, end: start + 40 * MIN, models: [] });
    for (let j = 0; j < 4; j++) {
      const t = start + j * 10 * MIN;
      evs.push({ k: "prompt", tool: "claude-code", source: "claude-code.transcripts", ts: t, sessionId: id, window: "detail", origin: "human", intent: "spec", features: f, textHash: `h${d}-${j}` });
      for (let a = 0; a < 5; a++) evs.push({ k: "tool", tool: "claude-code", source: "claude-code.transcripts", ts: t + (a + 1) * 30 * SEC, sessionId: id, name: "Read", category: "read", ok: true });
      if (childOrigin === undefined) continue;
      const cid = `codex:c${d}-${j}`;
      const c: SessionEv = { k: "session", tool: "codex", source: "codex.rollouts", id: cid, window: "detail", origin: childOrigin, start: t + MIN, end: t + 5 * MIN, models: [] };
      if (linked) c.parentId = id;
      evs.push(c);
      for (let a = 0; a < 6; a++) evs.push({ k: "tool", tool: "codex", source: "codex.rollouts", ts: t + MIN + a * 20 * SEC, sessionId: cid, name: "shell", category: "shell", ok: true });
    }
  }
  return evs;
}
const run = (origin: Origin | undefined, linked: boolean) => analyze(scanResultOf(world(origin, linked), { finishedAt: T0 + 30 * DAY }), { timeZone: "UTC" });
const sessionsOf = (a: ReturnType<typeof run>, tool: string): number => a.exposure.tools.filter((x) => x.tool === tool).reduce((s, x) => s + x.sessions, 0);

describe("delegated work is not a parallel session", () => {
  const none = run(undefined, false);
  for (const [what, origin, linked] of [["linked subagent rows", "subagent", true], ["another tool's agent (origin peer, no parent link)", "peer", false],
    ["subagent rows whose parent link is missing", "subagent", false]] as const) {
    test(`${what}: no bucket is parallel, and exposure counts no top-level session of them`, () => {
      const a = run(origin, linked);
      expect([a.signals.parallelShare.value, a.signals.peakConcurrency]).toEqual([0, 1]);
      expect(a.signals.parallelShare.n).toBe(none.signals.parallelShare.n);
      expect(sessionsOf(a, "codex")).toBe(0);
      expect(sessionsOf(a, "claude-code")).toBe(6);
    });
  }

  test("two people-driven sessions in one bucket still make it parallel", () => {
    const evs = world(undefined, false);
    evs.push({ k: "session", tool: "codex", source: "codex.rollouts", id: "codex:solo", window: "detail", origin: "human", start: T0, end: T0 + 5 * MIN, models: [] },
      { k: "tool", tool: "codex", source: "codex.rollouts", ts: T0 + MIN, sessionId: "codex:solo", name: "shell", category: "shell", ok: true });
    const a = analyze(scanResultOf(evs, { finishedAt: T0 + 30 * DAY }), { timeZone: "UTC" });
    expect(a.signals.peakConcurrency).toBe(2);
    expect(a.signals.parallelShare.value).toBeGreaterThan(0);
  });
});
