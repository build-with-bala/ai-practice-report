import { describe, expect, test } from "bun:test";
import { COMPONENTS } from "../../../core/scoring/components";
import { loadReference } from "../../../core/scoring/reference";

const IDS = ["lev.sticky", "lev.run", "orc.parallel", "orc.fanout", "orc.headless", "orc.background", "ver.vae", "ver.closure",
  "ver.guardrails", "ste.correction", "ste.interrupts", "ste.turnsPerWork", "ctx.instructions", "ctx.artifacts", "ctx.hygiene",
  "ctx.briefs", "jud.switches", "jud.rho", "jud.cost", "del.landed", "del.rework", "del.prs"];

describe("reference v0", () => {
  const ref = loadReference();
  test("loads the 22 pinned components", () => {
    expect(ref.version).toBe("v0");
    expect(Object.keys(ref.components)).toEqual(IDS);
    expect(loadReference("v0")).toBe(ref);
  });
  test("every p90 > p50, both finite and stored to 4 decimals; every rationale non-empty and in plain ASCII", () => {
    for (const [id, e] of Object.entries(ref.components)) {
      expect(e.p90).toBeGreaterThan(e.p50);
      for (const v of [e.p50, e.p90]) expect(Math.round(v * 1e4) / 1e4).toBe(v);
      expect(e.rationale.trim().length).toBeGreaterThan(0);
      expect(/^[\x20-\x7e]+$/.test(e.rationale)).toBe(true);
      expect(["identity", "log1p", "logit", "atanh"]).toContain(e.transform);
      expect(id).toMatch(/^(lev|orc|ver|ste|ctx|jud|del)\./);
    }
  });
  test("the component table names exactly the reference's components, and each dimension's weights sum to 1", () => {
    expect(COMPONENTS.map((c) => c.id)).toEqual(IDS);
    const sums = new Map<string, number>();
    for (const c of COMPONENTS) sums.set(c.dimension, (sums.get(c.dimension) ?? 0) + c.weight);
    expect(sums.size).toBe(7);
    for (const s of sums.values()) expect(s).toBeCloseTo(1, 12);
  });
  test("anchors stated as fractions equal their fractions, to 4 decimals (R3)", () => {
    const logit = (p: number): number => Math.round(Math.log(p / (1 - p)) * 1e4) / 1e4;
    expect(ref.components["ver.closure"]!.p50).toBe(logit(2 / 3));
    expect(ref.components["ctx.hygiene"]!.p50).toBe(logit(1 / 3));
    expect(ref.components["ctx.hygiene"]!.p90).toBe(logit(2 / 3));
    expect(ref.components["ver.guardrails"]!.p50).toBe(logit(1 / 3));
  });
  test("turns per work: anchors from their rationale (a follow-up turn sets off as many actions again), stored as -ln(1 + value)", () => {
    const p50 = 0.7 / Math.log2(10) + 0.3 * 2 / Math.log2(18); // 8 actions, 3 in 10 instructions take one follow-up
    const p90 = 0.9 / Math.log2(26) + 0.1 * 2 / Math.log2(50); // 24 actions, 1 in 10
    const stored = (v: number): number => Math.round(-Math.log1p(v) * 1e4) / 1e4;
    expect(ref.components["ste.turnsPerWork"]!.p50).toBe(stored(p50));
    expect(ref.components["ste.turnsPerWork"]!.p90).toBe(stored(p90));
    expect([stored(p50), stored(p90)]).toEqual([-0.3035, -0.2045]);
  });
  test("the table is frozen", () => {
    expect(Object.isFrozen(ref.components["lev.run"])).toBe(true);
  });
});
