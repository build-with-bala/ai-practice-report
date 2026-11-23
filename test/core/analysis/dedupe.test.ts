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
const prompt = (sessionId: string, tool: ToolId, ts: number, textHash: string, origin: Origin = "human", words = 5): PromptEv => ({
  k: "prompt", tool, source: `${tool}.x`, ts, sessionId, window: "detail", origin, intent: "spec", textHash,
  features: { words, lenBucket: 1, hasContext: false, fileRefs: 0, listLines: 0, constraintTerms: 0, isTaskStart: false, techCats: {} },
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

  test("one coincidental short prompt never makes a long Copilot VS Code session a host", () => {
    const evs: Ev[] = [sess("V", "copilot", { surface: "vscode" }), sess("C", "claude-code")];
    for (let i = 0; i < 20; i++) evs.push(prompt("V", "copilot", T0 + i * MIN, i === 3 ? "yes" : `v${i}`, "human", i === 3 ? 1 : 6));
    evs.push(prompt("C", "claude-code", T0 + 3 * MIN + 10 * SEC, "yes", "human", 1));
    const t = buildSessionTable(scanResultOf(evs), opts);
    expect(t.hosts.size).toBe(0);
    expect(t.dedupe).toEqual({ hostSessions: 0, pairedPrompts: 0, relabelled: 0 });
    expect(t.detailTop.map((r) => r.id).sort()).toEqual(["C", "V"]);
  });

  test("a 1-prompt session whose prompt a long session also typed is no host copy", () => {
    const evs: Ev[] = [sess("X", "codex"), sess("L", "claude-code")];
    for (let i = 0; i < 20; i++) evs.push(prompt("L", "claude-code", T0 + i * MIN, i === 5 ? "continue" : `l${i}`, "human", i === 5 ? 1 : 6));
    evs.push(prompt("X", "codex", T0 + 5 * MIN + 10 * SEC, "continue", "human", 1));
    const t = buildSessionTable(scanResultOf(evs), opts);
    expect(t.hosts.size).toBe(0);
    expect(t.dedupe).toEqual({ hostSessions: 0, pairedPrompts: 0, relabelled: 0 });
    // the same with long prompts: 100% of X's side pairs, but 1 pair and 5% of L's side: still no host
    const long = evs.map((e) => (e.k === "prompt" && e.textHash === "continue" ? { ...e, features: { ...e.features, words: 6 } } : e));
    const u = buildSessionTable(scanResultOf(long), opts);
    expect(u.hosts.size).toBe(0);
    expect(u.dedupe).toEqual({ hostSessions: 0, pairedPrompts: 1, relabelled: 0 });
  });

  test("boundary: exactly 3 pairs at exactly 50% of both sides is a host copy; 2 pairs or one side under 50% is not", () => {
    /** H (copilot vscode) and A (claude-code, scripted): `pairs` shared prompts, plus `hOnly`/`aOnly` prompts of their own. */
    const pairOf = (pairs: number, hOnly: number, aOnly: number): Ev[] => {
      const evs: Ev[] = [sess("H", "copilot", { surface: "vscode" }), sess("A", "claude-code", { origin: "scripted" })];
      for (let i = 0; i < pairs; i++) evs.push(prompt("H", "copilot", T0 + i * MIN, `p${i}`), prompt("A", "claude-code", T0 + i * MIN + SEC, `p${i}`, "scripted"));
      for (let i = 0; i < hOnly; i++) evs.push(prompt("H", "copilot", T0 + (10 + i) * MIN, `h${i}`));
      for (let i = 0; i < aOnly; i++) evs.push(prompt("A", "claude-code", T0 + (10 + i) * MIN, `a${i}`, "scripted"));
      return evs;
    };
    const at = buildSessionTable(scanResultOf(pairOf(3, 3, 3)), opts);
    expect([...at.hosts]).toEqual(["H"]);
    expect(at.dedupe).toEqual({ hostSessions: 1, pairedPrompts: 3, relabelled: 3 });
    const two = buildSessionTable(scanResultOf(pairOf(2, 0, 0)), opts);
    expect(two.dedupe).toEqual({ hostSessions: 0, pairedPrompts: 2, relabelled: 0 });
    const under = buildSessionTable(scanResultOf(pairOf(3, 3, 4)), opts);
    expect(under.dedupe).toEqual({ hostSessions: 0, pairedPrompts: 3, relabelled: 0 });
  });

  test("short prompts never pair, even in a true mirror, and are left out of the shares", () => {
    const { evs } = hosted(5 * SEC);
    for (let i = 0; i < 4; i++) {
      evs.push(prompt("H", "copilot", T0 + (30 + i) * MIN, `ok${i}`, "human", 2), prompt("A", "claude-code", T0 + (30 + i) * MIN + SEC, `ok${i}`, "scripted", 2));
    }
    const t = buildSessionTable(scanResultOf(evs), opts);
    expect([...t.hosts]).toEqual(["H"]);
    expect(t.dedupe).toEqual({ hostSessions: 1, pairedPrompts: 4, relabelled: 4 });
  });

  test("prompts outside the date range never help pair a session", () => {
    // 4 pairs, but 2 of them before `from`: only 2 pairs remain in range, under HOST_MIN_PAIRS
    const { evs } = hosted(5 * SEC);
    const from = T0 + 10 * MIN - 1; // prompts at T0 + 0, 5, 10, 15 min: the first two (and their copies) are out of range
    const t = buildSessionTable(scanResultOf(evs), { ...opts, exclude: { from } });
    expect(t.hosts.size).toBe(0);
    expect(t.dedupe).toEqual({ hostSessions: 0, pairedPrompts: 2, relabelled: 0 });
  });

  test("isHuman: human prompts are human, scripted ones only when relabelled", () => {
    const t = buildSessionTable(scanResultOf([sess("S", "codex")]), opts);
    expect(t.isHuman(prompt("S", "codex", T0, "a"))).toBe(true);
    expect(t.isHuman(prompt("S", "codex", T0, "a", "scripted"))).toBe(false);
    expect(t.isHuman(prompt("S", "codex", T0, "a", "subagent"))).toBe(false);
  });
});
