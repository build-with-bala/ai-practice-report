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

describe("checkAnchors: breakdown and what is left out", () => {
  /** `count` fabricated ids (`01` + random base58) at random plausible times inside the genuine span. */
  const fakes = (count: number, seed: number): AnchorEv[] => {
    const r = rng(seed);
    return Array.from({ length: count }, () => anchor(T0 + Math.floor(r() * 20 * 86_400_000), `01${randomB58(r, 22)}`));
  };

  for (const [pct, count] of [[30, 857], [40, 1_333]] as const) {
    test(`random fabricated ids at ${pct}% of the anchors fail C1`, () => {
      const [c1] = checkAnchors(scanResultOf([...genuine(), ...fakes(count, 13)]));
      expect(c1.status).toBe("fail");
      expect(c1.values.offShare as number).toBeGreaterThan(pct / 100 - 0.03);
    });
  }

  test("a session block shifted by 2 h at 30% of the anchors fails C1", () => {
    const [c1] = checkAnchors(scanResultOf(genuine().map((e, i) => (i >= 700 && i < 1_300 ? { ...e, ts: e.ts + 2 * HOUR } : e))));
    expect(c1.status).toBe("fail");
    expect(c1.values.offShare).toBe(0.3);
  });

  test("random ids at 60% of the anchors are n/a: no line holds half of them", () => {
    const [c1, c2] = checkAnchors(scanResultOf([...genuine(), ...fakes(3_000, 17)]));
    expect([c1.status, c1.reason]).toEqual(["n/a", "scheme-changed"]);
    expect(c1.n).toBe(5_000);
    expect(c2.status).toBe("n/a");
  });

  test("p99Seconds is capped at a year", () => {
    const [c1] = checkAnchors(scanResultOf(genuine().map((e, i) => (i % 33 === 5 ? { ...e, ts: e.ts + 2 * 365 * 86_400_000 } : e))));
    expect(c1.status).toBe("fail");
    expect(c1.values.p99Seconds).toBe(31_536_000);
  });

  test("C2's question shows rho rounded down to 3 decimals", () => {
    const evs = genuine();
    const times = evs.map((e) => e.ts).reverse();
    const [, c2] = checkAnchors(scanResultOf(evs.map((e, i) => ({ ...e, ts: times[i]! }))));
    expect(c2.askAbout).toContain("(rank correlation -1)");
  });

  test("9% malformed marker-carrying ids are a C1 note with the counts", () => {
    const r = rng(19);
    const evs = genuine().map((e, i) => (i % 11 === 0 ? { ...e, idTail: `010${randomB58(r, 21)}` } : e));
    const malformed = evs.filter((e) => e.idTail.startsWith("010")).length;
    const [c1, c2] = checkAnchors(scanResultOf(evs));
    expect([c1.status, c1.reason]).toEqual(["note", "malformed-ids"]);
    expect(c1.values.malformed).toBe(malformed);
    expect(c1.values.unrecognized).toBe(malformed);
    expect(c1.askAbout).toBe(`${malformed} server-issued ids do not have the form the service issues. Were some sessions run through another provider or gateway?`);
    expect(c2.status).toBe("pass");
  });

  test("a single malformed id is no note; a failing fit wins over the note", () => {
    const one = genuine().map((e, i) => (i === 0 ? { ...e, idTail: `010${"x".repeat(21)}` } : e));
    expect(checkAnchors(scanResultOf(one))[0].status).toBe("pass");
    const r = rng(23);
    const both = genuine().map((e, i) => (i % 11 === 0 ? { ...e, idTail: `010${randomB58(r, 21)}` } : i % 33 === 5 ? { ...e, ts: e.ts + 2 * HOUR } : e));
    expect(checkAnchors(scanResultOf(both))[0].status).toBe("fail");
  });

  test("11% foreign-marker ids are n/a with the kind's anchor count", () => {
    const r = rng(29);
    const evs = genuine().map((e, i) => (i % 9 === 0 ? { ...e, idTail: `02${randomB58(r, 22)}` } : e));
    const [c1, c2] = checkAnchors(scanResultOf(evs));
    expect([c1.status, c1.reason, c1.n]).toEqual(["n/a", "unknown-marker", 2_000]);
    expect(c1.values.unrecognized).toBe(evs.filter((e) => e.idTail.startsWith("02")).length);
    expect([c2.status, c2.n]).toEqual(["n/a", 2_000]);
  });

  test("one kind n/a on the marker share and the other passing is n/a", () => {
    const r = rng(31);
    const req = genuine("cc-req", 2).map((e, i) => (i % 9 === 0 ? { ...e, idTail: `02${randomB58(r, 22)}` } : e));
    const [c1, c2] = checkAnchors(scanResultOf([...genuine("cc-msg", 1), ...req]));
    expect([c1.status, c1.reason]).toEqual(["n/a", "unknown-marker"]);
    expect(c2.status).toBe("n/a");
  });

  test("one kind too-few and the other passing is pass", () => {
    const [c1, c2] = checkAnchors(scanResultOf([...genuine("cc-msg", 1), ...genuine("cc-req", 2).slice(0, 20)]));
    expect([c1.status, c2.status]).toEqual(["pass", "pass"]);
  });
});
