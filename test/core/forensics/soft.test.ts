import { describe, expect, test } from "bun:test";
import { buildSessionTable } from "../../../core/analysis/sessions";
import { softFlags } from "../../../core/forensics/soft";
import type { CheckResult } from "../../../core/forensics/types";
import type { ConfigEv, CoverageEv, Ev, PromptEv, SessionEv, ToolEv } from "../../../core/model/events";
import type { Window } from "../../../core/model/ids";
import { scanResultOf } from "../../kit/scanresult";

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 20, 12, 0);
const T0 = NOW - 3 * DAY;
const CC = "claude-code.transcripts";

const cov = (source: string, window: Window): CoverageEv => ({
  k: "coverage", tool: "claude-code", source, window, status: "ok", beta: false, files: 1, bytes: 1, records: 1, skipped: {}, unknownTypes: {}, versions: [],
});
const sess = (id: string, over: Partial<SessionEv> = {}): SessionEv => ({
  k: "session", tool: "claude-code", source: CC, id, window: "detail", origin: "human", start: T0 - DAY, end: T0 + DAY, models: [], ...over,
});
let n = 0;
const prompt = (ts: number, over: Partial<PromptEv> = {}, chars?: number): PromptEv => ({
  k: "prompt", tool: "claude-code", source: CC, ts, sessionId: "s", window: "detail", origin: "human", intent: "spec", textHash: `h${++n}`,
  features: { words: 5, lenBucket: 1, hasContext: false, fileRefs: 0, listLines: 0, constraintTerms: 0, isTaskStart: false, techCats: {}, ...(chars === undefined ? {} : { chars }) },
  ...over,
});
const lifetime = (ts: number, over: Partial<PromptEv> = {}, chars?: number): PromptEv => {
  const p = prompt(ts, { source: "claude-code.history", window: "lifetime", ...over }, chars);
  delete p.sessionId;
  return p;
};
const toolEv = (i: number, over: Partial<ToolEv> = {}): ToolEv =>
  ({ k: "tool", tool: "claude-code", source: CC, ts: T0 + i * MIN, sessionId: "s", name: "Read", category: "read", ok: true, ...over });
const config = (over: Partial<ConfigEv> = {}): ConfigEv =>
  ({ k: "config", tool: "claude-code", source: "claude-code.config", kind: "skill", name: "a", provenance: "authored", uses: 3, ...over });

const flags = (events: Ev[]): CheckResult[] => {
  const raw = scanResultOf([cov(CC, "detail"), cov("claude-code.history", "lifetime"), sess("s"), ...events], { finishedAt: NOW });
  return softFlags(raw, buildSessionTable(raw, { now: NOW, timeZone: "UTC" }), { now: NOW, timeZone: "UTC" });
};
const flag = (events: Ev[], id: CheckResult["id"]): CheckResult => flags(events).find((f) => f.id === id)!;

describe("softFlags", () => {
  test("five flags, in order, each n/a without data; never a fail", () => {
    const fs = flags([]);
    expect(fs.map((f) => f.id)).toEqual(["soft:rhythm", "soft:repeated-long", "soft:recent-burst", "soft:unclosed-tools", "soft:new-config"]);
    for (const f of fs) expect(f.status).toBe("n/a");
  });

  describe("rhythm", () => {
    test("60 prompts a minute apart (within a second) are raised", () => {
      const f = flag(Array.from({ length: 61 }, (_, i) => prompt(T0 + i * MIN + (i % 2) * SEC)), "soft:rhythm");
      expect([f.status, f.reason]).toEqual(["note", "regular-rhythm"]);
      expect(f.values.regular).toBe(1);
      expect(f.askAbout).toBeString();
    });

    test("bursts and pauses pass", () => {
      const gaps = [10 * SEC, 10 * SEC, 10 * SEC, 20 * MIN];
      let ts = T0;
      const ps = Array.from({ length: 61 }, (_, i) => prompt((ts += gaps[i % 4]!)));
      const f = flag(ps, "soft:rhythm");
      expect([f.status, f.reason]).toEqual(["pass", "ok"]);
      expect(f.values.minCv as number).toBeGreaterThan(1);
    });

    test("fewer than 50 gaps under 30 min are n/a: longer gaps do not count", () => {
      let ts = T0;
      const ps = Array.from({ length: 61 }, (_, i) => prompt((ts += i % 2 === 0 ? MIN : 40 * MIN)));
      expect(flag(ps, "soft:rhythm").status).toBe("n/a");
    });

    test("only human prompts count", () => {
      const ps = Array.from({ length: 61 }, (_, i) => prompt(T0 + i * MIN, { origin: "scripted" }));
      expect(flag(ps, "soft:rhythm").status).toBe("n/a");
    });
  });

  describe("repeated-long", () => {
    const long = (count: number, hash: string, over: Partial<PromptEv> = {}) =>
      Array.from({ length: count }, (_, i) => prompt(T0 + i * HOUR, { textHash: hash, ...over }, 250));

    test("a long prompt sent 5 times is raised, with the count of such prompts", () => {
      const f = flag([...long(5, "x"), ...long(6, "y"), ...long(4, "z")], "soft:repeated-long");
      expect([f.status, f.reason]).toEqual(["note", "repeated-long"]);
      expect(f.values.repeated).toBe(2);
      expect(f.askAbout).toBeString();
    });

    test("4 times, or a short prompt 5 times, pass", () => {
      expect(flag(long(4, "x"), "soft:repeated-long").status).toBe("pass");
      const short = Array.from({ length: 5 }, (_, i) => prompt(T0 + i * HOUR, { textHash: "s" }, 199));
      expect(flag(short, "soft:repeated-long").status).toBe("pass");
    });

    test("a long prompt present in both windows counts once", () => {
      const both = [...long(3, "x"), ...Array.from({ length: 3 }, (_, i) => lifetime(T0 + i * HOUR + SEC, { textHash: "x" }, 250))];
      const f = flag(both, "soft:repeated-long");
      expect(f.status).toBe("pass");
      expect(f.n).toBe(3);
    });

    test("non-human prompts are left out; no length known is n/a", () => {
      expect(flag(long(5, "x", { origin: "scripted" }), "soft:repeated-long").status).toBe("n/a");
      expect(flag([prompt(T0)], "soft:repeated-long").status).toBe("n/a");
    });
  });

  describe("recent-burst", () => {
    const days = (offsets: number[]) => offsets.map((d) => lifetime(NOW - d * DAY));

    test("most active days in the last 14, over a span of more than 60 days, are raised", () => {
      const f = flag(days([80, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), "soft:recent-burst");
      expect([f.status, f.reason]).toEqual(["note", "recent-burst"]);
      expect(f.values.recentDays).toBe(10);
      expect(f.values.days).toBe(11);
      expect(f.askAbout).toContain("in the 14 days before this scan");
    });

    test("activity spread over the span passes; so does a span of 60 days or less", () => {
      expect(flag(days([80, 70, 60, 50, 40, 30, 20, 2, 1]), "soft:recent-burst").status).toBe("pass");
      expect(flag(days([40, 1, 2, 3, 4, 5, 6]), "soft:recent-burst").status).toBe("pass");
    });

    test("n/a without lifetime activity", () => {
      expect(flag([prompt(T0)], "soft:recent-burst").status).toBe("n/a");
    });
  });

  describe("unclosed-tools", () => {
    const tools = (open: number) => Array.from({ length: 20 }, (_, i) => (i < open ? toolEv(i, { ok: undefined }) : toolEv(i)));

    test("more than 10% of Claude Code calls without a result are raised", () => {
      const f = flag(tools(3), "soft:unclosed-tools");
      expect([f.status, f.reason]).toEqual(["note", "unclosed-tools"]);
      expect(f.values.open).toBe(3);
      expect(f.n).toBe(20);
    });

    test("10% pass; an outcome closes a call", () => {
      expect(flag(tools(2), "soft:unclosed-tools").status).toBe("pass");
      const denied = Array.from({ length: 20 }, (_, i) => toolEv(i, i < 5 ? { ok: undefined, outcome: "denied" } : {}));
      expect(flag(denied, "soft:unclosed-tools").status).toBe("pass");
    });

    test("other tools and other windows are not read", () => {
      const other = Array.from({ length: 20 }, (_, i) => toolEv(i, { ok: undefined, source: "claude-code.elsewhere" }));
      expect(flag(other, "soft:unclosed-tools").status).toBe("n/a");
    });
  });

  describe("new-config", () => {
    test("a used artifact first seen within 7 days is raised, with the count", () => {
      const f = flag([config({ firstSeen: NOW - 2 * DAY }), config({ name: "b", firstSeen: NOW - 30 * DAY })], "soft:new-config");
      expect([f.status, f.reason]).toEqual(["note", "new-config"]);
      expect(f.values.recent).toBe(1);
      expect(f.askAbout).toBe("1 of the tools and skills in use were first seen in the 7 days before this scan. Was this machine set up or migrated in that week?");
    });

    test("older artifacts pass; unused ones and features are not counted", () => {
      expect(flag([config({ firstSeen: NOW - 8 * DAY })], "soft:new-config").status).toBe("pass");
      expect(flag([config({ uses: 0, firstSeen: NOW - DAY })], "soft:new-config").status).toBe("n/a");
      expect(flag([config({ kind: "feature", name: "prompt-queue", firstSeen: NOW - DAY })], "soft:new-config").status).toBe("n/a");
      expect(flag([config({})], "soft:new-config").status).toBe("n/a");
    });
  });

  test("raised flags hold numbers and dates only, and texts stay within the covered characters", () => {
    const evs: Ev[] = [
      ...Array.from({ length: 61 }, (_, i) => prompt(T0 + i * MIN, { textHash: i < 5 ? "x" : `u${i}` }, 300)),
      ...[80, 1, 2, 3, 4, 5].map((d) => lifetime(NOW - d * DAY)),
      ...Array.from({ length: 10 }, (_, i) => toolEv(i, { ok: undefined })),
      config({ firstSeen: NOW - DAY }),
    ];
    const fs = flags(evs);
    expect(fs.map((f) => f.status)).toEqual(["note", "note", "note", "note", "note"]);
    for (const f of fs) {
      for (const v of Object.values(f.values)) expect(typeof v === "number" ? Number.isFinite(v) : /^\d{4}-\d{2}-\d{2}$/.test(v)).toBe(true);
      expect(`${f.reason}${f.askAbout ?? ""}`).toMatch(/^[ -ÿ -⁯−]*$/);
    }
  });
});
