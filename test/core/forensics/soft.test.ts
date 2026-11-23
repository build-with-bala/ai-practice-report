import { describe, expect, test } from "bun:test";
import { buildSessionTable } from "../../../core/analysis/sessions";
import { buildSessionStats } from "../../../core/analysis/walk";
import { softFlags } from "../../../core/forensics/soft";
import type { CheckResult } from "../../../core/forensics/types";
import { computeGlobals } from "../../../core/signals/globals";
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

/** A seeded generator (mulberry32): the fixtures are the same on every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

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
    /** A session of 61 prompts (60 gaps) whose gaps `gap(i)` draws. */
    const session = (id: string, gap: (i: number) => number): PromptEv[] => {
      let ts = T0;
      return Array.from({ length: 61 }, (_, i) => prompt((ts += i === 0 ? 0 : gap(i)), { sessionId: id }));
    };
    /** Exponential gaps of mean 4 min, redrawn when 30 min or more: a heavy-tailed, human-like mix (CV near 1). */
    const humanLike = (seed: number) => {
      const r = rng(seed);
      return () => {
        for (;;) {
          const g = Math.round(-Math.log(1 - r()) * 4 * MIN) + SEC;
          if (g < 30 * MIN) return g;
        }
      };
    };

    test("constant gaps are raised, with the median CV and the sessions measured", () => {
      const f = flag(session("s", () => MIN), "soft:rhythm");
      expect([f.status, f.reason]).toEqual(["note", "regular-rhythm"]);
      expect(f.values).toEqual({ sessions: 1, medianCv: 0 });
      expect(f.n).toBe(1);
      expect(f.askAbout).toBeString();
    });

    test("gaps with a small jitter are raised", () => {
      const r = rng(3);
      const f = flag(session("s", () => MIN + Math.round((r() - 0.5) * 10 * SEC)), "soft:rhythm");
      expect(f.status).toBe("note");
      expect(f.values.medianCv as number).toBeLessThan(0.1);
    });

    test("uniformly random gaps between two bounds are raised", () => {
      const r = rng(4);
      const f = flag(session("s", () => 30 * SEC + Math.round(r() * 270 * SEC)), "soft:rhythm");
      expect(f.status).toBe("note");
      expect(f.values.medianCv as number).toBeLessThan(0.6);
    });

    test("a human-like heavy-tailed mix, CV near 1, is not raised", () => {
      const f = flag(session("s", humanLike(5)), "soft:rhythm");
      expect([f.status, f.reason]).toEqual(["pass", "ok"]);
      expect(f.values.medianCv as number).toBeGreaterThan(0.8);
    });

    test("one scripted session among five human-like ones is not raised", () => {
      const evs = [session("bot", () => MIN), ...[1, 2, 3, 4, 5].map((k) => session(`h${k}`, humanLike(10 + k)))].flat();
      const f = flag(evs, "soft:rhythm");
      expect(f.status).toBe("pass");
      expect(f.values.sessions).toBe(6);
      expect(f.n).toBe(6);
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
    /** `fresh` used artifacts first seen 2 days before now, and `old` first seen 30 days before. */
    const artifacts = (fresh: number, old: number): ConfigEv[] => [
      ...Array.from({ length: fresh }, (_, i) => config({ name: `n${i}`, firstSeen: NOW - 2 * DAY })),
      ...Array.from({ length: old }, (_, i) => config({ name: `o${i}`, firstSeen: NOW - 30 * DAY })),
    ];

    test("3 new of 6 are raised, with the counts", () => {
      const f = flag(artifacts(3, 3), "soft:new-config");
      expect([f.status, f.reason]).toEqual(["note", "new-config"]);
      expect(f.values).toEqual({ recent: 3, artifacts: 6 });
      expect(f.askAbout).toBe("3 of the 6 tools and skills in use were first seen in the 7 days before this scan. Was this machine set up or migrated, or were its tools updated, in that week?");
    });

    test("1 new of 10, or 2 new of 2, is not raised", () => {
      expect(flag(artifacts(1, 9), "soft:new-config").status).toBe("pass");
      expect(flag(artifacts(2, 0), "soft:new-config").status).toBe("pass");
      expect(flag(artifacts(3, 4), "soft:new-config").status).toBe("pass");
    });

    test("reports of one artifact count once, at its earliest first-seen time", () => {
      const f = flag([...artifacts(3, 0), config({ name: "n0", firstSeen: NOW - 30 * DAY }), config({ name: "n1", source: "claude-code.other", firstSeen: NOW - DAY })], "soft:new-config");
      expect(f.values).toEqual({ recent: 2, artifacts: 3 });
      expect(f.status).toBe("pass");
    });

    test("tools lists only the tools of entries that show use", () => {
      const codexUnused = config({ tool: "codex", source: "codex.config", name: "n0", uses: 0 });
      const f = flag([...artifacts(3, 0), codexUnused], "soft:new-config");
      expect(f.tools).toEqual(["claude-code"]);
      const codexUsed = config({ tool: "codex", source: "codex.config", name: "n0", uses: 1 });
      expect(flag([...artifacts(3, 0), codexUsed], "soft:new-config").tools).toEqual(["claude-code", "codex"]);
    });

    test("an unused entry's first-seen time still counts for its artifact", () => {
      const f = flag([...artifacts(3, 0), config({ name: "n0", uses: 0, firstSeen: NOW - 30 * DAY })], "soft:new-config");
      expect(f.values).toEqual({ recent: 2, artifacts: 3 });
    });

    test("older artifacts pass; unused ones and features are not counted", () => {
      expect(flag([config({ firstSeen: NOW - 8 * DAY })], "soft:new-config").status).toBe("pass");
      expect(flag([config({ uses: 0, firstSeen: NOW - DAY })], "soft:new-config").status).toBe("n/a");
      expect(flag([config({ kind: "feature", name: "prompt-queue", firstSeen: NOW - DAY })], "soft:new-config").status).toBe("n/a");
      expect(flag([config({})], "soft:new-config").status).toBe("n/a");
    });

    test("the flag treats as used exactly the artifacts the artifacts signal counts", () => {
      const at = { firstSeen: NOW - 2 * DAY };
      const evs: Ev[] = [
        sess("c", { parentId: "s", agentType: "reviewer", start: T0, end: T0 + HOUR }),
        sess("h", { window: "lifetime", source: "claude-code.history" }),
        toolEv(1, { name: "mcp__docs__q", category: "mcp", mcpServer: "docs" }),
        toolEv(2, { sessionId: "h", source: "claude-code.history", name: "mcp__lifetime__q", category: "mcp", mcpServer: "lifetime" }),
        config({ name: "used-skill", ...at }),
        config({ name: "unused-skill", uses: 0, ...at }),
        config({ kind: "mcp-server", name: "docs", uses: undefined, ...at }),
        config({ kind: "mcp-server", name: "lifetime", uses: undefined, ...at }),
        config({ kind: "mcp-server", name: "never-called", uses: undefined, ...at }),
        config({ kind: "agent", name: "reviewer", uses: undefined, ...at }),
        config({ kind: "agent", name: "idle", uses: undefined, ...at }),
        config({ kind: "feature", name: "prompt-queue", ...at }),
      ];
      const raw = scanResultOf([cov(CC, "detail"), cov("claude-code.history", "lifetime"), sess("s"), ...evs], { finishedAt: NOW });
      const t = buildSessionTable(raw, { now: NOW, timeZone: "UTC" });
      const g = computeGlobals(t, buildSessionStats(t, raw.store, raw.repos, { timeZone: "UTC" }), raw, { now: NOW });
      const f = softFlags(raw, t, { now: NOW, timeZone: "UTC" }).find((x) => x.id === "soft:new-config")!;
      expect(g.evidence.artifacts).toBe(3); // used-skill, docs, reviewer
      expect(f.values).toEqual({ recent: g.evidence.artifacts, artifacts: g.evidence.artifacts });
      expect(f.status).toBe("note");
    });
  });

  test("raised flags hold numbers and dates only, and texts stay within the covered characters", () => {
    const evs: Ev[] = [
      ...Array.from({ length: 61 }, (_, i) => prompt(T0 + i * MIN, { textHash: i < 5 ? "x" : `u${i}` }, 300)),
      ...[80, 1, 2, 3, 4, 5].map((d) => lifetime(NOW - d * DAY)),
      ...Array.from({ length: 10 }, (_, i) => toolEv(i, { ok: undefined })),
      ...["a", "b", "c"].map((name) => config({ name, firstSeen: NOW - DAY })),
    ];
    const fs = flags(evs);
    expect(fs.map((f) => f.status)).toEqual(["note", "note", "note", "note", "note"]);
    for (const f of fs) {
      for (const v of Object.values(f.values)) expect(typeof v === "number" ? Number.isFinite(v) : /^\d{4}-\d{2}-\d{2}$/.test(v)).toBe(true);
      expect(`${f.reason}${f.askAbout ?? ""}`).toMatch(/^[ -ÿ -⁯−]*$/);
    }
  });
});
