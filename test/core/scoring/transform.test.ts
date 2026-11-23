import { describe, expect, test } from "bun:test";
import { transform } from "../../../core/scoring/transform";

const logit = (p: number): number => Math.log(p / (1 - p));

describe("transform (builder's call 2)", () => {
  test("logit smooths the rate by its n, then clamps to [0.02, 0.98]", () => {
    expect(transform("logit", 0, 0)).toBe(0);
    expect(transform("logit", 1, 1_000)).toBeCloseTo(logit(0.98), 10);
    expect(transform("logit", 1, 1_000)).toBeCloseTo(3.8918, 4);
    expect(transform("logit", 0, 10_000)).toBeCloseTo(logit(0.02), 10);
    expect(transform("logit", 0.25, 2)).toBeCloseTo(logit(1 / 3), 10); // (0.5 + 0.5) / 3
  });
  test("log1p floors counts at 0", () => {
    expect(transform("log1p", -3, 5)).toBe(0);
    expect(transform("log1p", 0, 0)).toBe(0);
    expect(transform("log1p", 15, 1)).toBeCloseTo(Math.log(16), 12);
  });
  test("atanh clamps the correlation to [-0.95, 0.95]", () => {
    expect(transform("atanh", 1, 30)).toBeCloseTo(Math.atanh(0.95), 12);
    expect(transform("atanh", -1, 30)).toBeCloseTo(-Math.atanh(0.95), 12);
    expect(transform("atanh", 0.3, 30)).toBeCloseTo(Math.atanh(0.3), 12);
  });
  test("identity passes the value through", () => {
    expect(transform("identity", 2.5, 10)).toBe(2.5);
  });
  test("every result is finite", () => {
    for (const kind of ["identity", "log1p", "logit", "atanh"] as const)
      for (const raw of [-1e300, -1, 0, 0.5, 1, 1e300]) for (const n of [0, 1, 1e9]) expect(Number.isFinite(transform(kind, raw, n))).toBe(true);
  });
});
