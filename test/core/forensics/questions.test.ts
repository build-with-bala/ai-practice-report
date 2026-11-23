import { describe, expect, test } from "bun:test";
import { DATE_KEY, questionFor, REASONS, VALUE_KEYS, type CheckId, type Reason } from "../../../core/forensics";

const IDS: CheckId[] = ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "C10",
  "soft:rhythm", "soft:repeated-long", "soft:recent-burst", "soft:unclosed-tools", "soft:new-config"];
/** Values holding every fixed key: 3 under each number, a day under `date`. */
const ALL = Object.fromEntries(Object.keys(VALUE_KEYS).filter((k) => !k.includes("/")).map((k) => [k, k === DATE_KEY ? "2026-10-01" : 3]));

describe("questionFor", () => {
  test("asks nothing for a pass, n/a or info reason", () => {
    for (const id of IDS) for (const r of ["ok", "ok-history-only", "ok-stats-only", "no-data", "too-few", "classify-only", "no-match"] as Reason[]) {
      if (id === "C4" && r === "no-match") continue;
      expect([id, r, questionFor(id, r, ALL)]).toEqual([id, r, undefined]);
    }
  });

  test("every question is fixed English within the covered characters, and only numbers and the date vary", () => {
    let asked = 0;
    for (const id of IDS) {
      for (const r of Object.keys(REASONS) as Reason[]) {
        const q = questionFor(id, r, ALL);
        if (q === undefined) continue;
        asked++;
        expect(q).toMatch(/^[ -ÿ -⁯−]*$/);
        expect(q.endsWith("?")).toBe(true);
        expect(questionFor(id, r, { ...ALL, ...Object.fromEntries(Object.keys(ALL).filter((k) => k !== DATE_KEY).map((k) => [k, 7])) })!
          .replace(/\d+/g, "#")).toBe(q.replace(/\d+/g, "#"));
      }
    }
    expect(asked).toBe(20); // C1 2, C2 1, C3 2, C4 2, C5 3, C6 1, C7 2, C8 1, C9 1, five soft flags
  });

  test("undefined when a number the question needs is missing", () => {
    expect(questionFor("C6", "missing-thread-rows", {})).toBeUndefined();
    expect(questionFor("C5", "restore-cluster", { days: 9 })).toBeUndefined();
    expect(questionFor("C6", "missing-thread-rows", { missing: 1 })).toBe("1 Codex session file has no entry in Codex's own thread index. Were session files copied in from somewhere else?");
  });

  test("the vocabularies are closed lists", () => {
    expect(Object.keys(REASONS).length).toBe(32);
    expect(VALUE_KEYS["claude-code/human/detail"]).toBe(true);
    expect(DATE_KEY).toBe("date");
  });
});
