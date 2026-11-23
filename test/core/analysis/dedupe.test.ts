import { describe, expect, test } from "bun:test";
import { buildSessionTable } from "../../../core/analysis/sessions";
import type { Ev, PromptEv, SessionEv } from "../../../core/model/events";
import type { Origin, ToolId } from "../../../core/model/ids";
import { scanResultOf } from "../../kit/scanresult";

const T0 = Date.UTC(2026, 10, 2, 9, 0);
const SEC = 1_000;
const MIN = 60 * SEC;
const opts = { now: T0 + 86_400_000, timeZone: "UTC" };

const sess = (id: string, tool: ToolId, over: Partial<SessionEv> = {}): SessionEv => ({
  k: "session", tool, source: `${tool}.x`, id, window: "detail", origin: "human", start: T0, end: T0 + 30 * MIN, models: [], ...over,
});
const prompt = (sessionId: string, tool: ToolId, ts: number, textHash: string, origin: Origin = "human"): PromptEv => ({
  k: "prompt", tool, source: `${tool}.x`, ts, sessionId, window: "detail", origin, intent: "spec", textHash,
  features: { words: 5, lenBucket: 1, hasContext: false, fileRefs: 0, listLines: 0, constraintTerms: 0, isTaskStart: false, techCats: {} },
});

/** H: a Copilot VS Code session with 4 human prompts; A: a Claude Code session with 4 scripted prompts, `gap` ms later. */
function hosted(gap: number, n = 4, paired = n): { evs: Ev[]; a: PromptEv[] } {
  const a: PromptEv[] = [];
  const evs: Ev[] = [sess("H", "copilot", { surface: "vscode" }), sess("A", "claude-code", { origin: "scripted" })];
  for (let i = 0; i < n; i++) {
    const ts = T0 + i * 5 * MIN;
    evs.push(prompt("H", "copilot", ts, `t${i}`));
    const p = prompt("A", "claude-code", ts + gap, i < paired ? `t${i}` : `other${i}`, "scripted");
    a.push(p);
    evs.push(p);
  }
  return { evs, a };
}

describe("cross-tool dedupe", () => {
  test("a VS Code-hosted copy: H is a host, A's scripted prompts count as human and A becomes human", () => {
    const { evs, a } = hosted(5 * SEC);
    const t = buildSessionTable(scanResultOf(evs), opts);
    expect([...t.hosts]).toEqual(["H"]);
    expect(a.every((p) => t.isHuman(p))).toBe(true);
    expect(t.rows.get("A")!.origin).toBe("human");
    expect(t.dedupe).toEqual({ hostSessions: 1, pairedPrompts: 4, relabelled: 4 });
    expect(t.detailTop.map((r) => r.id)).toEqual(["A"]);
  });

  test("no host copy when only 1 of 5 prompts pair", () => {
    const { evs, a } = hosted(5 * SEC, 5, 1);
    const t = buildSessionTable(scanResultOf(evs), opts);
    expect(t.hosts.size).toBe(0);
    expect(a.some((p) => t.isHuman(p))).toBe(false);
    expect(t.rows.get("A")!.origin).toBe("scripted");
    expect(t.dedupe).toEqual({ hostSessions: 0, pairedPrompts: 1, relabelled: 0 });
    expect(t.detailTop.map((r) => r.id).sort()).toEqual(["A", "H"]);
  });

  test("no host copy when equal hashes are 3 min apart", () => {
    const { evs, a } = hosted(3 * MIN);
    const t = buildSessionTable(scanResultOf(evs), opts);
    expect(t.hosts.size).toBe(0);
    expect(a.some((p) => t.isHuman(p))).toBe(false);
    expect(t.dedupe).toEqual({ hostSessions: 0, pairedPrompts: 0, relabelled: 0 });
  });

  test("without a Copilot VS Code side, the session whose tool sorts later is the host", () => {
    const evs: Ev[] = [sess("X", "codex"), sess("Y", "claude-code")];
    for (let i = 0; i < 3; i++) {
      evs.push(prompt("X", "codex", T0 + i * MIN, `t${i}`), prompt("Y", "claude-code", T0 + i * MIN + SEC, `t${i}`));
    }
    const t = buildSessionTable(scanResultOf(evs), opts);
    expect([...t.hosts]).toEqual(["X"]);
    expect(t.dedupe).toEqual({ hostSessions: 1, pairedPrompts: 3, relabelled: 0 });
  });

  test("prompts of one tool never pair, and lifetime prompts are left out", () => {
    const evs: Ev[] = [sess("X", "codex"), sess("Y", "codex"), sess("Z", "claude-code")];
    evs.push(prompt("X", "codex", T0, "t"), prompt("Y", "codex", T0 + SEC, "t"));
    evs.push({ ...prompt("Z", "claude-code", T0 + 2 * SEC, "t"), window: "lifetime" });
    const t = buildSessionTable(scanResultOf(evs), opts);
    expect(t.dedupe).toEqual({ hostSessions: 0, pairedPrompts: 0, relabelled: 0 });
  });

  test("isHuman: human prompts are human, scripted ones only when relabelled", () => {
    const t = buildSessionTable(scanResultOf([sess("S", "codex")]), opts);
    expect(t.isHuman(prompt("S", "codex", T0, "a"))).toBe(true);
    expect(t.isHuman(prompt("S", "codex", T0, "a", "scripted"))).toBe(false);
    expect(t.isHuman(prompt("S", "codex", T0, "a", "subagent"))).toBe(false);
  });
});
