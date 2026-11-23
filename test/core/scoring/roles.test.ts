import { describe, expect, test } from "bun:test";
import { panels, type Stack } from "../../../core/analysis/panels";
import { buildSessionTable } from "../../../core/analysis/sessions";
import { buildSessionStats } from "../../../core/analysis/walk";
import type { ScanResult } from "../../../core/scan";
import type { DimensionId } from "../../../core/scoring/dimensions";
import { loadReference } from "../../../core/scoring/reference";
import { PRACTICE_ROLES, roles } from "../../../core/scoring/roles";
import { scoreDimensions, type DimensionResult } from "../../../core/scoring/score";
import { computeSignals } from "../../../core/signals/compute";
import { computeGlobals } from "../../../core/signals/globals";
import { personaScan, type PersonaKind } from "../../fixtures/personas";

/** The pipeline by hand, as far as roles need: dimensions and the stack panel. */
function rolesOf(raw: ScanResult): { dims: DimensionResult[]; stack: Stack; roles: string[] } {
  const now = raw.finishedAt;
  const t = buildSessionTable(raw, { now, timeZone: "UTC" });
  const stats = buildSessionStats(t, raw.store, raw.repos, { timeZone: "UTC" });
  const dims = scoreDimensions(computeSignals(stats, computeGlobals(t, stats, raw, { now })), loadReference());
  const stack = panels(t, raw, { timeZone: "UTC" }).stack;
  return { dims, stack, roles: roles(dims, stack) };
}
const P = Object.fromEntries((["novice", "intermediate", "expert"] as const).map((k) => [k, rolesOf(personaScan(k))])) as Record<PersonaKind, ReturnType<typeof rolesOf>>;

/** The practice roles a dimension list makes eligible, strongest z first (ties by role name). */
const practice = (dims: readonly DimensionResult[]): string[] => dims
  .filter((d) => d.status === "scored" && (d.confidence === "medium" || d.confidence === "high") && d.score !== null && d.score >= 60)
  .sort((a, b) => b.z! - a.z! || (PRACTICE_ROLES[a.id] < PRACTICE_ROLES[b.id] ? -1 : 1))
  .map((d) => PRACTICE_ROLES[d.id]);

const stack = (over: Partial<Stack> = {}): Stack => ({ languages: {}, toolchains: {}, techCategories: {}, roleEdits: {}, meta: { window: "detail", sources: [], n: 0 }, ...over });
const dim = (id: DimensionId, z: number, score: number, confidence: DimensionResult["confidence"] = "medium"): DimensionResult => ({
  id, status: "scored", z, zRaw: z, score, interval: null, openTail: false, confidence, part: "typedTurns", n: 1, needs: 1, ratio: 1, weeks: 1,
  components: [], meta: { window: "detail", sources: [], n: 1 },
});

describe("roles: personas", () => {
  test("the expert is Backend (its go edits), then the roles of its top-z dimensions", () => {
    const { dims, roles: r } = P.expert;
    expect(r[0]).toBe("Backend");
    expect(r).toEqual(["Backend", ...practice(dims).slice(0, 2)]);
    expect(r.length).toBe(3);
  });

  test("the intermediate's first role is Frontend (its tsx edits)", () => {
    expect(P.intermediate.roles[0]).toBe("Frontend");
    expect(P.intermediate.roles).toEqual(["Frontend", ...practice(P.intermediate.dims).slice(0, 2)]);
  });

  test("the novice gets none: its sh edits count toward no role, and no dimension is eligible", () => {
    expect(P.novice.stack.roleEdits).toEqual({});
    expect(P.novice.roles).toEqual([]);
  });

  test("every list has at most 3 entries, no duplicates and no percentages", () => {
    for (const { roles: r } of Object.values(P)) {
      expect(r.length).toBeLessThanOrEqual(3);
      expect(new Set(r).size).toBe(r.length);
      for (const name of r) expect(name).not.toMatch(/%|\d/);
    }
  });
});

describe("roles: rules", () => {
  test("practice roles need a scored dimension at medium or above with a score of at least 60", () => {
    const dims = [dim("leverage", 1, 84), dim("verification", 2, 97, "low"), dim("steering", 0.2, 58), dim("delivery", 0.5, 69, "high"),
      { ...dim("context", 3, 99), status: "insufficient" as const }];
    expect(roles(dims, stack())).toEqual(["Force multiplier", "Shipper"]);
  });

  test("ties on z break by role name; at most 3", () => {
    const dims = [dim("verification", 1, 84), dim("orchestration", 1, 84), dim("judgment", 1, 84), dim("context", 1, 84)];
    expect(roles(dims, stack())).toEqual(["Context engineer", "Orchestrator", "QA"]);
  });

  test("stack roles need a share of at least 25% and at least 50 edits; the strongest one only comes first", () => {
    const langs = { js: 120, go: 60, doc: 500 };
    expect(roles([], stack({ languages: langs, roleEdits: { frontend: 70, backend: 110 } }))).toEqual(["Backend"]);
    expect(roles([], stack({ languages: { js: 300 }, roleEdits: { frontend: 70, backend: 230 } }))).toEqual(["Backend"]); // 70/300 < 25%
    expect(roles([], stack({ languages: { js: 160 }, roleEdits: { frontend: 40, backend: 120 } }))).toEqual(["Backend"]); // 40 < 50
    expect(roles([], stack({ languages: { js: 200 }, roleEdits: { frontend: 50, backend: 150 } }))).toEqual(["Backend"]);
    expect(roles([], stack({ languages: { js: 100, shell: 100 }, roleEdits: { frontend: 50 } }))).toEqual(["Frontend"]); // exactly 25%
    expect(roles([dim("leverage", 1, 84)], stack({ languages: { swift: 49 }, roleEdits: { mobile: 49 } }))).toEqual(["Force multiplier"]);
  });

  test("AI engineer: ai is the largest tech category with at least 30 prompts", () => {
    expect(roles([], stack({ techCategories: { ai: 30, data: 12 } }))).toEqual(["AI engineer"]);
    expect(roles([], stack({ techCategories: { ai: 29 } }))).toEqual([]);
    expect(roles([], stack({ techCategories: { ai: 40, infra: 41 } }))).toEqual([]);
    // the stronger share wins: ai is 30/40 of the tech prompts, data edits 60/100 of the code edits
    expect(roles([], stack({ techCategories: { ai: 30, data: 10 }, languages: { py: 100 }, roleEdits: { data: 60 } }))).toEqual(["AI engineer"]);
  });
});
