import { describe, expect, test } from "bun:test";
import { phi, phiInv } from "../../../core/scoring/normal";

describe("phi and phiInv", () => {
  test("phi at the centre and the usual quantiles", () => {
    expect(phi(0)).toBe(0.5);
    expect(Math.abs(phi(1.2816) - 0.9)).toBeLessThan(1e-4);
    expect(Math.abs(phi(-1.96) - 0.025)).toBeLessThan(1e-4);
  });
  test("phi matches reference values to 1e-7, both tails", () => {
    const known: Array<[number, number]> = [[1, 0.8413447460685429], [-1, 0.15865525393145707], [2.5, 0.9937903346742238],
      [-3, 0.0013498980316301], [5, 0.9999997133484281], [-8, 6.22096057427178e-16], [0.3, 0.6179114221889527]];
    for (const [z, p] of known) expect(Math.abs(phi(z) - p)).toBeLessThan(1e-7);
    expect(phi(Infinity)).toBe(1);
    expect(phi(-Infinity)).toBe(0);
  });
  test("phiInv inverts phi", () => {
    expect(Math.abs(phiInv(0.975) - 1.95996)).toBeLessThan(1e-4);
    expect(phiInv(0.5)).toBeCloseTo(0, 9);
    for (const p of [1e-6, 0.01, 0.2, 0.9, 0.999]) expect(Math.abs(phi(phiInv(p)) - p)).toBeLessThan(1e-8);
  });
  test("no NaN or Infinity leaves: out-of-range input throws", () => {
    expect(() => phi(Number.NaN)).toThrow(RangeError);
    for (const p of [0, 1, -0.1, 1.1, Number.NaN]) expect(() => phiInv(p)).toThrow(RangeError);
  });
});
