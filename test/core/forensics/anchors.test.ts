import { describe, expect, test } from "bun:test";
import { checkAnchors } from "../../../core/forensics/anchors";
import type { AnchorEv } from "../../../core/model/events";
import { scanResultOf } from "../../kit/scanresult";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const T0 = Date.UTC(2026, 9, 1, 8, 0);
const MIN = 60_000;
const HOUR = 3_600_000;

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
/** `v` in base58, left-padded to `width` digits. */
function enc(v: bigint, width: number): string {
  let s = "";
  for (let x = v; x > 0n; x /= 58n) s = B58[Number(x % 58n)]! + s;
  return s.padStart(width, "1");
}
const randomB58 = (r: () => number, len: number): string => Array.from({ length: len }, () => B58[Math.floor(r() * 58)]!).join("");

const BASE = 3n * 58n ** 11n;
const SCALE = 1_000n; // id units per ms
/**
 * The shape the reader emits: `01`, then 12 base58 digits that grow linearly with the time (to within half a second),
 * then 10 random digits.
 */
function genuineTail(ts: number, r: () => number): string {
  const jitter = BigInt(Math.floor((r() - 0.5) * 1_000)) * SCALE;
  return `01${enc(BASE + BigInt(ts - T0) * SCALE + jitter, 12)}${randomB58(r, 10)}`;
}
const anchor = (ts: number, idTail: string, kind: AnchorEv["kind"] = "cc-msg"): AnchorEv =>
  ({ k: "anchor", tool: "claude-code", source: "claude-code.transcripts", kind, ts, idTail });

/** 2,000 anchors over 20 days. */
function genuine(kind: AnchorEv["kind"] = "cc-msg", seed = 1): AnchorEv[] {
  const r = rng(seed);
  return Array.from({ length: 2_000 }, (_, i) => {
    const ts = T0 + i * 14 * MIN + Math.floor(r() * MIN);
    return anchor(ts, genuineTail(ts, r), kind);
  });
}

describe("checkAnchors (C1, C2)", () => {
  test("a genuine-like set passes both", () => {
    const [c1, c2] = checkAnchors(scanResultOf([...genuine("cc-msg", 1), ...genuine("cc-req", 2)]));
    expect(c1.id).toBe("C1");
    expect(c1.status).toBe("pass");
    expect(c1.values.offShare).toBe(0);
    expect(c1.values.p99Seconds).toBeLessThanOrEqual(1);
    expect(c1.n).toBe(2_000);
    expect(c1.tools).toEqual(["claude-code"]);
    expect(c1.askAbout).toBeUndefined();
    expect(c2.id).toBe("C2");
    expect(c2.status).toBe("pass");
    expect(c2.values.rho as number).toBeGreaterThan(0.999);
  });

  test("edited timestamps: 3% of the anchors shifted by 2 h fail C1", () => {
    const evs = genuine().map((e, i) => (i % 33 === 5 ? { ...e, ts: e.ts + 2 * HOUR } : e));
    const [c1] = checkAnchors(scanResultOf(evs));
    expect(c1.status).toBe("fail");
    expect(c1.values.offShare as number).toBeGreaterThan(0.01);
    expect(c1.values.p99Seconds as number).toBeGreaterThan(3_600);
    expect(c1.askAbout).toBeString();
  });

  test("fabricated: a session of 100 random ids at plausible times fails C1", () => {
    const r = rng(7);
    const fake = Array.from({ length: 100 }, (_, i) => anchor(T0 + 10 * 86_400_000 + i * 2 * MIN, `01${randomB58(r, 22)}`));
    const [c1] = checkAnchors(scanResultOf([...genuine(), ...fake]));
    expect(c1.status).toBe("fail");
    expect(c1.values.offShare as number).toBeGreaterThan(0.04);
  });

  test("the worse kind wins: a clean cc-msg set and an edited cc-req set fail C1", () => {
    const req = genuine("cc-req", 3).map((e, i) => (i % 20 === 0 ? { ...e, ts: e.ts + 2 * HOUR } : e));
    const [c1] = checkAnchors(scanResultOf([...genuine("cc-msg", 1), ...req]));
    expect(c1.status).toBe("fail");
  });

  test("every id out of scheme is n/a for both", () => {
    const r = rng(9);
    const evs = genuine().map((e) => ({ ...e, idTail: randomB58(r, 24).replace(/^0?1?/, "zz") }));
    const [c1, c2] = checkAnchors(scanResultOf(evs));
    expect(c1.status).toBe("n/a");
    expect(c2.status).toBe("n/a");
  });

  test("fewer than 50 recognized anchors is n/a (too-few); no anchors at all too", () => {
    const [c1, c2] = checkAnchors(scanResultOf(genuine().slice(0, 49)));
    expect([c1.status, c1.reason]).toEqual(["n/a", "too-few"]);
    expect(c2.status).toBe("n/a");
    const [e1, e2] = checkAnchors(scanResultOf([]));
    expect([e1.status, e2.status]).toEqual(["n/a", "n/a"]);
    expect(e1.n).toBe(0);
  });

  test("ids that no longer track time are n/a (scheme-changed)", () => {
    const r = rng(11);
    const evs = genuine().map((e) => ({ ...e, idTail: `01${randomB58(r, 22)}` }));
    const [c1, c2] = checkAnchors(scanResultOf(evs));
    expect([c1.status, c1.reason]).toEqual(["n/a", "scheme-changed"]);
    expect(c2.status).toBe("n/a");
  });

  test("reversed order fails C2", () => {
    const evs = genuine();
    const times = evs.map((e) => e.ts).reverse();
    const [, c2] = checkAnchors(scanResultOf(evs.map((e, i) => ({ ...e, ts: times[i]! }))));
    expect(c2.status).toBe("fail");
    expect(c2.values.rho as number).toBeLessThan(0);
    expect(c2.askAbout).toBeString();
  });

  test("results hold numbers only, and texts stay within the covered characters", () => {
    const evs = genuine().map((e, i) => (i % 33 === 5 ? { ...e, ts: e.ts + 2 * HOUR } : e));
    for (const c of checkAnchors(scanResultOf(evs))) {
      for (const v of Object.values(c.values)) expect(typeof v === "number" && Number.isFinite(v)).toBe(true);
      expect(`${c.reason}${c.askAbout ?? ""}`).toMatch(/^[ -ÿ -⁯−]*$/);
    }
  });
});
