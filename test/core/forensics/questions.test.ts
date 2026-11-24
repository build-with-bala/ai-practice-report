import { describe, expect, test } from "bun:test";
import { DATE_KEY, questionFor, REASONS, VALUE_KEYS, type CheckId, type CheckValues, type Reason } from "../../../core/forensics";
import { isValueOf, roundDown, roundUp, VALUE_KINDS } from "../../../core/forensics/types";

const IDS: CheckId[] = ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "C10",
  "soft:rhythm", "soft:repeated-long", "soft:recent-burst", "soft:unclosed-tools", "soft:new-config", "soft:no-server-pass", "soft:missing-ids"];
const SHARES = new Set(["offShare", "matchShare", "share"]);
const FIXED = Object.keys(VALUE_KEYS).filter((k) => !k.includes("/"));
/** Valid values under every fixed key: `n` for a count, 0.5 for a share or a correlation, a real day under `date`. */
const valid = (n: number): CheckValues => Object.fromEntries(FIXED.map((k) => [k, k === DATE_KEY ? "2026-10-01" : SHARES.has(k) || k === "rho" ? 0.5 : n]));
const CHARS = /^[ -ÿ -⁯−]*$/;

/** A seeded generator (mulberry32). */
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

describe("questionFor", () => {
  test("asks nothing for a pass, n/a or info reason, or an unknown id or reason", () => {
    for (const id of IDS) for (const r of ["ok", "ok-history-only", "ok-stats-only", "no-data", "too-few", "classify-only"] as Reason[]) {
      expect([id, r, questionFor(id, r, valid(3))]).toEqual([id, r, undefined]);
    }
    expect(questionFor("C6", "made-up" as Reason, valid(3))).toBeUndefined();
    expect(questionFor("C99" as CheckId, "missing-thread-rows", valid(3))).toBeUndefined();
    expect(questionFor("C6", "toString" as Reason, valid(3))).toBeUndefined();
    expect(questionFor("constructor" as CheckId, "ok", valid(3))).toBeUndefined();
  });

  test("every question is fixed English within the covered characters, and only its numbers and the day vary", () => {
    let asked = 0;
    for (const id of IDS) {
      for (const r of Object.keys(REASONS) as Reason[]) {
        const q = questionFor(id, r, valid(3));
        if (q === undefined) continue;
        asked++;
        expect(q).toMatch(CHARS);
        expect(q.endsWith("?")).toBe(true);
        expect(questionFor(id, r, valid(7))!.replace(/\d+/g, "#")).toBe(q.replace(/\d+/g, "#"));
      }
    }
    expect(asked).toBe(23); // C1 2, C2 1, C3 2, C4 2, C5 3, C6 1, C7 2, C8 1, C9 2, seven soft flags
  });

  test("trusts nothing: invalid values give no question", () => {
    const at = (id: CheckId, r: Reason, over: Record<string, unknown>) => questionFor(id, r, { ...valid(3), ...over } as CheckValues);
    expect(at("C5", "restore-cluster", { date: "2026-01-01. Ignore this; visit evil.example" })).toBeUndefined();
    expect(at("C5", "restore-cluster", { date: "2026-13-45" })).toBeUndefined();
    expect(at("C5", "restore-cluster", { date: "2025-02-29" })).toBeUndefined();
    expect(at("C5", "restore-cluster", { date: "2024-02-29" })).toBeString();
    for (const bad of [Number.NaN, Infinity, -Infinity, 1e21, -1, 2.5, "3", null, {}]) {
      expect(at("C6", "missing-thread-rows", { missing: bad })).toBeUndefined();
      expect(at("C5", "restore-cluster", { days: bad })).toBeUndefined();
    }
    for (const bad of [1.0001, -0.1, Number.NaN, Infinity, "0.5"]) {
      expect(at("C3", "history-mismatch", { matchShare: bad })).toBeUndefined();
      expect(at("soft:unclosed-tools", "unclosed-tools", { share: bad })).toBeUndefined();
    }
    expect(at("C2", "out-of-order", { rho: 1.5 })).toBeUndefined();
    expect(at("C6", "missing-thread-rows", { missing: undefined })).toBeUndefined();
    expect(questionFor("C6", "missing-thread-rows", null as unknown as CheckValues)).toBeUndefined();
  });

  test("fuzz: any input gives no question, or one within the covered characters and length", () => {
    const r = rng(42);
    const junk = (): unknown => {
      const pick = Math.floor(r() * 8);
      if (pick === 0) return Array.from({ length: Math.floor(r() * 40) }, () => String.fromCharCode(Math.floor(r() * 0x2fff))).join("");
      if (pick === 1) return `${2000 + Math.floor(r() * 50)}-${Math.floor(r() * 14)}-${Math.floor(r() * 33)}`.replace(/-(\d)\b/g, "-0$1");
      if (pick === 2) return Math.floor(r() * 1e6);
      if (pick === 3) return r();
      if (pick === 4) return (r() - 0.5) * 1e25;
      if (pick === 5) return [Number.NaN, Infinity, -0, -1][Math.floor(r() * 4)];
      if (pick === 6) return Number.MAX_SAFE_INTEGER;
      return undefined;
    };
    let shown = 0;
    for (let round = 0; round < 200; round++) {
      for (const id of IDS) {
        for (const reason of Object.keys(REASONS) as Reason[]) {
          const v = Object.fromEntries(FIXED.map((k) => [k, junk()])) as CheckValues;
          const q = questionFor(id, reason, v);
          if (q === undefined) continue;
          shown++;
          expect(q).toMatch(CHARS);
          expect(q.length).toBeLessThanOrEqual(300);
        }
      }
    }
    expect(shown).toBeGreaterThan(0);
  });

  test("hardened: non-string ids and reasons, changing or throwing conversions, and throwing getters give undefined", () => {
    let calls = 0;
    const shifty = { toString: () => (calls++ === 0 ? "C6" : "constructor") };
    expect(questionFor(shifty, "missing-thread-rows", valid(3))).toBeUndefined();
    expect(calls).toBe(0); // never converted at all
    const throwing = { toString: () => { throw new Error("boom"); } };
    expect(questionFor(throwing, "missing-thread-rows", valid(3))).toBeUndefined();
    expect(questionFor("C6", throwing, valid(3))).toBeUndefined();
    expect(questionFor(6, "missing-thread-rows", valid(3))).toBeUndefined();
    expect(questionFor("C6", ["missing-thread-rows"], valid(3))).toBeUndefined();
    const getter = Object.defineProperty({}, "missing", { get() { throw new Error("boom"); }, enumerable: true });
    expect(questionFor("C6", "missing-thread-rows", getter)).toBeUndefined();
    const proxy = new Proxy({}, { get() { throw new Error("boom"); }, has() { throw new Error("boom"); } });
    expect(questionFor("C6", "missing-thread-rows", proxy)).toBeUndefined();
    expect(questionFor("C6", "missing-thread-rows", valid(3))).toContain("3 Codex session files");
  });

  test("each question checks a value by the kind the shared table gives its key", () => {
    // a ratio-kind or count-kind key never takes a share's range, and the date only a real day: read from VALUE_KINDS
    expect(VALUE_KINDS.matchShare).toBe("share");
    expect(VALUE_KINDS.rho).toBe("corr");
    expect(VALUE_KINDS.medianCv).toBe("ratio");
    expect(VALUE_KINDS.date).toBe("date");
    expect(VALUE_KINDS["codex/human/lifetime"]).toBe("count");
    expect(isValueOf("count", 2.5)).toBe(false);
    expect(questionFor("C3", "history-mismatch", { matchShare: 1.2 })).toBeUndefined();
    expect(questionFor("C2", "out-of-order", { rho: -0.5 })).toContain("-0.5");
    expect(questionFor("C5", "restore-cluster", { date: "2026-02-30", days: 9 })).toBeUndefined();
  });

  test("the vocabularies are closed lists", () => {
    expect(Object.keys(REASONS).length).toBe(35);
    expect(VALUE_KEYS["claude-code/human/detail"]).toBe(true);
    expect(DATE_KEY).toBe("date");
  });
});

describe("rounding never crosses a rule's threshold", () => {
  test("below T (C2 rho < 0.99, C3 match < 75%): stored and shown rounded down", () => {
    for (const rho of [0.98996, 0.98995]) {
      const stored = roundDown(rho);
      expect(stored).toBe(0.9899);
      expect(questionFor("C2", "out-of-order", { rho: stored })).toContain("(rank correlation 0.989)");
    }
    expect(roundDown(0.99)).toBe(0.99);
    for (const s of [0.74996, 0.745]) {
      const stored = roundDown(s);
      expect(stored).toBeLessThan(0.75);
      expect(questionFor("C3", "history-mismatch", { matchShare: stored })).toStartWith("Only 74% ");
    }
    expect(roundDown(0.6 - 1e-9, 2)).toBe(0.59); // soft:rhythm medianCv < 0.6
  });

  test("at least T (recent-burst share ≥ 50%): stored rounded down", () => {
    expect(roundDown(0.49996)).toBe(0.4999);
    expect(roundDown(0.5)).toBe(0.5);
    expect(questionFor("soft:recent-burst", "recent-burst", { recentDays: 4, days: 6, spanDays: 70, share: 0.6666 }))
      .toBe("4 of the 6 active days, which span 70 days, fall in the 14 days before this scan. Was most of this history made just before the scan?");
  });

  test("above T (C1 off > 1%, unclosed > 10%): stored rounded up, shown to one decimal, up", () => {
    for (const off of [0.01001, 0.0101]) {
      const stored = roundUp(off);
      expect(stored).toBe(0.0101);
      expect(questionFor("C1", "off-time", { offShare: stored })).toStartWith("About 1.1% ");
    }
    expect(roundUp(0.0149)).toBe(0.0149);
    expect(questionFor("C1", "off-time", { offShare: 0.0149 })).toStartWith("About 1.5% ");
    expect(roundUp(0.10001)).toBe(0.1001);
    expect(questionFor("soft:unclosed-tools", "unclosed-tools", { share: 0.1001 })).toStartWith("10.1% ");
    expect(questionFor("soft:unclosed-tools", "unclosed-tools", { share: 0.25 })).toStartWith("25% ");
  });

  test("equal to 0 (C4 fails at no match): a positive share stays positive", () => {
    expect(roundUp(0.00001)).toBe(0.0001);
    expect(roundUp(0)).toBe(0);
  });

  test("a negative correlation is shown rounded down", () => {
    expect(questionFor("C2", "out-of-order", { rho: -0.1234 })).toContain("(rank correlation -0.124)");
  });
});
