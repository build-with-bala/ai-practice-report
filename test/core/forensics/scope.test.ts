import { describe, expect, test } from "bun:test";
import { analyze } from "../../../core/analyze";
import type { CheckId, CheckResult, Forensics } from "../../../core/forensics";
import type { Ev, IdentityEv, PromptEv, SessionEv } from "../../../core/model/events";
import { scanResultOf } from "../../kit/scanresult";
import { personaScan } from "../../fixtures/personas";
import { tableOf } from "./table";

/* Forensics through `analyze`: the exclusions the person chose reach every check. */

const UTC = { timeZone: "UTC", bootstrap: 10 };
const byId = (f: Forensics, id: CheckId): CheckResult => f.checks.find((c) => c.id === id)!;

describe("analyze: forensics under exclusions", () => {
  test("excluding the only tool leaves nothing to verify", () => {
    const raw = personaScan("expert");
    const id = raw.store.all("session")[0]!.id;
    const ids: IdentityEv[] = [
      { k: "identity", tool: "claude-code", source: "claude-code.config", scope: "config", hash: "acct" },
      { k: "identity", tool: "claude-code", source: "claude-code.transcripts", scope: "session", hash: "acct", sessionId: id },
    ];
    for (const e of ids) raw.store.add(e);
    const kept = analyze(raw, UTC).forensics;
    expect([byId(kept, "C3").status, byId(kept, "C4").status]).toEqual(["pass", "pass"]);

    const f = analyze(raw, { ...UTC, exclude: { tools: ["claude-code"] } }).forensics;
    expect(f.band).toBe("unverifiable");
    expect([byId(f, "C3").status, byId(f, "C3").n]).toEqual(["n/a", 0]);
    expect([byId(f, "C4").status, byId(f, "C4").n]).toEqual(["n/a", 0]);
    expect([f.anchorable, f.notAnchorable]).toEqual([[], []]);
    for (const c of f.checks) expect([c.id, c.tools]).toEqual([c.id, []]);
  });

  test("excluding one project takes exactly its events out of C10 and unclosed-tools", () => {
    const raw = personaScan("expert");
    const prompts = new Map<string, number>();
    for (const p of raw.store.all("prompt")) {
      const key = p.sessionId === undefined ? undefined : raw.store.session(p.sessionId)?.projectKey;
      if (key !== undefined) prompts.set(key, (prompts.get(key) ?? 0) + 1);
    }
    const busiest = [...prompts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0];

    // the sessions the exclusion drops (the project's, with their descendants) and their in-scope events
    const all = tableOf(raw), left = tableOf(raw, { projects: [busiest] });
    const dropped = new Set([...all.rows.keys()].filter((id) => !left.rows.has(id)));
    expect(dropped.size).toBeGreaterThan(0);
    const expected = new Map<string, number>();
    let droppedPrompts = 0;
    for (const p of raw.store.all("prompt")) {
      if (p.sessionId === undefined || !dropped.has(p.sessionId)) continue;
      const key = `${p.tool}/${all.isHuman(p) ? "human" : p.origin}/${p.window}`;
      expected.set(key, (expected.get(key) ?? 0) + 1);
      droppedPrompts++;
    }
    const detail = new Set(raw.coverage.filter((c) => c.window === "detail").map((c) => c.source));
    const droppedCalls = raw.store.all("tool").filter((e) => e.tool === "claude-code" && detail.has(e.source) && dropped.has(e.sessionId)).length;
    expect(droppedCalls).toBeGreaterThan(0);

    const before = analyze(raw, UTC).forensics, after = analyze(raw, { ...UTC, exclude: { projects: [busiest] } }).forensics;
    const c10a = byId(before, "C10"), c10b = byId(after, "C10");
    expect(c10a.n - c10b.n).toBe(droppedPrompts);
    for (const key of Object.keys(c10a.values)) expect([key, (c10a.values[key] as number) - ((c10b.values[key] as number | undefined) ?? 0)]).toEqual([key, expected.get(key) ?? 0]);
    expect(byId(before, "soft:unclosed-tools").n - byId(after, "soft:unclosed-tools").n).toBe(droppedCalls);
  });

  test("excluding a period takes its prompts out of C3 and its session accounts out of C4", () => {
    const DAY = 86_400_000;
    const T0 = Date.UTC(2026, 8, 1, 9, 0);
    const features = { words: 5, lenBucket: 1, hasContext: false, fileRefs: 0, listLines: 0, constraintTerms: 0, isTaskStart: false, techCats: {} } as const;
    const evs: Ev[] = [{ k: "identity", tool: "claude-code", source: "claude-code.config", scope: "config", hash: "acct-a" }];
    for (let d = 0; d < 4; d++) {
      const start = T0 + d * 10 * DAY;
      const id = `claude-code:s${d}`;
      const s: SessionEv = { k: "session", tool: "claude-code", source: "claude-code.transcripts", id, window: "detail", origin: "human", start, end: start + DAY, models: [] };
      evs.push(s, { k: "identity", tool: "claude-code", source: "claude-code.transcripts", scope: "session", hash: d < 2 ? "acct-a" : "acct-b", sessionId: id });
      for (let i = 0; i < 5; i++) {
        const ts = start + i * 3_600_000;
        const p: PromptEv = { k: "prompt", tool: "claude-code", source: "claude-code.transcripts", ts, sessionId: id, window: "detail", origin: "human",
          intent: "spec", textHash: `p${d}-${i}`, features };
        const { sessionId: _, ...unbound } = p;
        evs.push(p, { ...unbound, source: "claude-code.history", window: "lifetime", ts });
      }
    }
    const raw = scanResultOf(evs);
    const before = analyze(raw, UTC).forensics;
    expect([byId(before, "C3").n, byId(before, "C4").n, byId(before, "C4").values.accounts]).toEqual([20, 4, 2]);

    const after = analyze(raw, { ...UTC, exclude: { from: T0 + 15 * DAY } }).forensics;
    expect([byId(after, "C3").n, byId(after, "C3").status]).toEqual([10, "pass"]);
    // the later sessions name only the second account, which the config does not: C4 fails on what is left
    expect([byId(after, "C4").n, byId(after, "C4").status, byId(after, "C4").values.accounts]).toEqual([2, "fail", 1]);

    const early = analyze(raw, { ...UTC, exclude: { to: T0 + 15 * DAY } }).forensics;
    expect([byId(early, "C3").n, byId(early, "C4").n, byId(early, "C4").status]).toEqual([10, 2, "pass"]);
  });
});
