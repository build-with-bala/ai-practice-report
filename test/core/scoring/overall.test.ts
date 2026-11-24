import { describe, expect, test } from "bun:test";
import { DIMENSION_IDS, type Confidence, type DimensionId } from "../../../core/scoring/dimensions";
import { phiInv } from "../../../core/scoring/normal";
import { bandOf, overall, WEIGHTS } from "../../../core/scoring/overall";
import { displayScore, type DimensionResult } from "../../../core/scoring/score";

const T0 = Date.UTC(2026, 9, 1);
const DAY = 86_400_000;

/** A dimension result: scored at z' = `z` with `confidence`, or another status (no z). */
function dim(id: DimensionId, o: { z?: number; confidence?: Confidence; status?: DimensionResult["status"]; sources?: string[]; day?: number } = {}): DimensionResult {
  const status = o.status ?? "scored";
  const scored = status === "scored";
  const z = scored ? (o.z ?? 0) : null;
  return {
    id, status, z, zRaw: z, score: z === null ? null : displayScore(z).score, interval: null, openTail: false,
    confidence: scored ? (o.confidence ?? "medium") : null, part: "days", n: 30, needs: 10, ratio: 3, weeks: 3, components: [],
    meta: { window: "detail", sources: o.sources ?? ["claude-code.transcripts"], from: T0 + (o.day ?? 0) * DAY, to: T0 + ((o.day ?? 0) + 10) * DAY, n: 30 },
  };
}
const all = (over: Partial<Record<DimensionId, Parameters<typeof dim>[1]>>): DimensionResult[] =>
  DIMENSION_IDS.map((id) => dim(id, over[id] ?? { status: "insufficient" }));

describe("WEIGHTS", () => {
  test("verification 0.20; leverage, orchestration, steering, context 0.15; judgment, delivery 0.10; summing to 1", () => {
    expect(WEIGHTS).toEqual({ leverage: 0.15, orchestration: 0.15, verification: 0.2, steering: 0.15, context: 0.15, judgment: 0.1, delivery: 0.1 });
    expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(Object.isFrozen(WEIGHTS)).toBe(true);
  });
});

describe("overall", () => {
  test("two dimensions at medium (the rest low or unscored) are insufficient", () => {
    const o = overall(all({ leverage: { z: 1 }, verification: { z: 1, confidence: "high" }, steering: { z: 1, confidence: "low" }, context: { status: "not-measurable" } }), [40, 60]);
    expect(o.status).toBe("insufficient");
    expect([o.z, o.score, o.interval, o.band]).toEqual([null, null, null, "insufficient"]);
    expect(o.included).toEqual(["leverage", "verification"]);
    expect(o.coverage).toBe("2/7");
  });

  test("weights renormalize over the included dimensions; low confidence is left out", () => {
    const ds = all({ leverage: { z: 1 }, verification: { z: -0.5, confidence: "high" }, judgment: { z: 2 }, steering: { z: -3, confidence: "low" } });
    const o = overall(ds, [50, 70]);
    const want = (0.15 * 1 + 0.2 * -0.5 + 0.1 * 2) / (0.15 + 0.2 + 0.1);
    expect(o.status).toBe("scored");
    expect(o.z!).toBeCloseTo(want, 12);
    expect(o.score).toBe(displayScore(want).score);
    expect(o.included).toEqual(["leverage", "verification", "judgment"]);
    expect(o.coverage).toBe("3/7");
    expect(o.interval).toEqual([50, 70]);
    // equal z everywhere gives that z, whatever the included set
    const flat = overall(all({ leverage: { z: 0.7 }, orchestration: { z: 0.7 }, delivery: { z: 0.7 }, context: { z: 0.7, confidence: "high" } }), null);
    expect(flat.z!).toBeCloseTo(0.7, 12);
    expect(flat.interval).toBeNull();
  });

  test("coverage counts the dimensions behind the overall: 6 scored, 3 included, reads 3/7", () => {
    const o = overall(all({ leverage: { z: 1 }, orchestration: { z: 1 }, verification: { z: 1 },
      steering: { z: 1, confidence: "low" }, context: { z: 1, confidence: "low" }, judgment: { z: 1, confidence: "low" } }), null);
    expect(o.status).toBe("scored");
    expect(o.included).toEqual(["leverage", "orchestration", "verification"]);
    expect(o.coverage).toBe("3/7");
  });

  test("the band edges are 34/35, 59/60 and 79/80", () => {
    expect([bandOf(1), bandOf(34), bandOf(35), bandOf(59), bandOf(60), bandOf(79), bandOf(80), bandOf(99)])
      .toEqual(["limited", "limited", "developing", "developing", "strong", "strong", "exceptional", "exceptional"]);
    for (const [score, band] of [[34, "limited"], [35, "developing"], [59, "developing"], [60, "strong"], [79, "strong"], [80, "exceptional"]] as const) {
      const z = phiInv(score / 100);
      const o = overall(all({ leverage: { z }, verification: { z }, context: { z } }), null);
      expect(o.score).toBe(score);
      expect(o.band).toBe(band);
    }
  });

  test("meta: the detail window over the included dimensions' sources and span, n = the included count", () => {
    const ds = all({ leverage: { z: 0, sources: ["b", "a"], day: 5 }, verification: { z: 0, sources: ["git", "a"], day: 2 },
      context: { z: 0, sources: ["c"], day: 9 }, steering: { z: 0, confidence: "low", sources: ["zz"], day: 0 } });
    expect(overall(ds, null).meta).toEqual({ window: "detail", sources: ["a", "b", "c", "git"], from: T0 + 2 * DAY, to: T0 + 19 * DAY, n: 3 });
    expect(overall(all({}), null).meta).toEqual({ window: "detail", sources: [], n: 0 });
  });

  test("nothing scored: insufficient, 0/7, and plain JSON", () => {
    const o = overall(all({}), null);
    expect(o).toEqual({ status: "insufficient", z: null, score: null, interval: null, band: "insufficient", included: [], coverage: "0/7",
      meta: { window: "detail", sources: [], n: 0 } });
    expect(JSON.parse(JSON.stringify(o))).toEqual(o);
  });
});
