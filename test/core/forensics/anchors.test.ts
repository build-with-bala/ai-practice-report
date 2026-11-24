import { describe, expect, test } from "bun:test";
import { checkAnchors } from "../../../core/forensics/anchors";
import type { AnchorEv } from "../../../core/model/events";
import type { ScanResult } from "../../../core/scan";
import { scanResultOf } from "../../kit/scanresult";
import { asks, tableOf } from "./table";

const anchorsOf = (raw: ScanResult) => asks(checkAnchors(raw, tableOf(raw)));

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
    const [c1, c2] = anchorsOf(scanResultOf([...genuine("cc-msg", 1), ...genuine("cc-req", 2)]));
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
    const [c1] = anchorsOf(scanResultOf(evs));
    expect(c1.status).toBe("fail");
    expect(c1.values.offShare as number).toBeGreaterThan(0.01);
    expect(c1.values.p99Seconds as number).toBeGreaterThan(3_600);
    expect(c1.askAbout).toBeString();
  });

  test("a session of 100 random ids at plausible times is unverified (their values imply no plausible time), never a fail", () => {
    const r = rng(7);
    const fake = Array.from({ length: 100 }, (_, i) => anchor(T0 + 10 * 86_400_000 + i * 2 * MIN, `01${randomB58(r, 22)}`));
    const [c1] = anchorsOf(scanResultOf([...genuine(), ...fake]));
    expect([c1.status, c1.reason, c1.values.foreign, c1.values.offIds]).toEqual(["note", "foreign-ids", 100, 0]);
  });

  test("the worse kind wins: a clean cc-msg set and an edited cc-req set fail C1", () => {
    const req = genuine("cc-req", 3).map((e, i) => (i % 20 === 0 ? { ...e, ts: e.ts + 2 * HOUR } : e));
    const [c1] = anchorsOf(scanResultOf([...genuine("cc-msg", 1), ...req]));
    expect(c1.status).toBe("fail");
  });

  test("every id out of scheme is n/a for both", () => {
    const r = rng(9);
    const evs = genuine().map((e) => ({ ...e, idTail: randomB58(r, 24).replace(/^0?1?/, "zz") }));
    const [c1, c2] = anchorsOf(scanResultOf(evs));
    expect(c1.status).toBe("n/a");
    expect(c2.status).toBe("n/a");
  });

  test("fewer than 50 recognized anchors is n/a (too-few); no anchors at all too", () => {
    const [c1, c2] = anchorsOf(scanResultOf(genuine().slice(0, 49)));
    expect([c1.status, c1.reason]).toEqual(["n/a", "too-few"]);
    expect(c2.status).toBe("n/a");
    const [e1, e2] = anchorsOf(scanResultOf([]));
    expect([e1.status, e2.status]).toEqual(["n/a", "n/a"]);
    expect(e1.n).toBe(0);
  });

  test("ids that no longer track time are n/a (scheme-changed)", () => {
    const r = rng(11);
    const evs = genuine().map((e) => ({ ...e, idTail: `01${randomB58(r, 22)}` }));
    const [c1, c2] = anchorsOf(scanResultOf(evs));
    expect([c1.status, c1.reason]).toEqual(["n/a", "scheme-changed"]);
    expect(c2.status).toBe("n/a");
  });

  test("reversed order fails C2", () => {
    const evs = genuine();
    const times = evs.map((e) => e.ts).reverse();
    const [, c2] = anchorsOf(scanResultOf(evs.map((e, i) => ({ ...e, ts: times[i]! }))));
    expect(c2.status).toBe("fail");
    expect(c2.values.rho as number).toBeLessThan(0);
    expect(c2.askAbout).toBeString();
  });

  test("results hold numbers only, and texts stay within the covered characters", () => {
    const evs = genuine().map((e, i) => (i % 33 === 5 ? { ...e, ts: e.ts + 2 * HOUR } : e));
    for (const c of anchorsOf(scanResultOf(evs))) {
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
    test(`random fabricated ids at ${pct}% of the anchors are unverified ids: n/a, never a fail`, () => {
      const [c1] = anchorsOf(scanResultOf([...genuine(), ...fakes(count, 13)]));
      expect([c1.status, c1.reason, c1.values.foreign]).toEqual(["n/a", "foreign-ids", count]);
    });
  }

  test("a session block shifted by 2 h at 30% of the anchors fails C1", () => {
    const [c1] = anchorsOf(scanResultOf(genuine().map((e, i) => (i >= 700 && i < 1_300 ? { ...e, ts: e.ts + 2 * HOUR } : e))));
    expect(c1.status).toBe("fail");
    expect(c1.values.offShare).toBe(0.3);
  });

  test("random ids at 60% of the anchors are n/a: the genuine 40% still give the line, the rest are unverified", () => {
    const [c1, c2] = anchorsOf(scanResultOf([...genuine(), ...fakes(3_000, 17)]));
    expect([c1.status, c1.reason]).toEqual(["n/a", "foreign-ids"]);
    expect(c1.n).toBe(5_000);
    expect(c2.status).toBe("n/a");
  });

  test("p99Seconds is capped at a year", () => {
    const [c1] = anchorsOf(scanResultOf(genuine().map((e, i) => (i % 33 === 5 ? { ...e, ts: e.ts + 2 * 365 * 86_400_000 } : e))));
    expect(c1.status).toBe("fail");
    expect(c1.values.p99Seconds).toBe(31_536_000);
  });

  test("C2's question shows rho rounded down to 3 decimals", () => {
    const evs = genuine();
    const times = evs.map((e) => e.ts).reverse();
    const [, c2] = anchorsOf(scanResultOf(evs.map((e, i) => ({ ...e, ts: times[i]! }))));
    expect(c2.askAbout).toContain("(rank correlation -1)");
  });

  test("9% malformed marker-carrying ids are a C1 note with the counts", () => {
    const r = rng(19);
    const evs = genuine().map((e, i) => (i % 11 === 0 ? { ...e, idTail: `010${randomB58(r, 21)}` } : e));
    const malformed = evs.filter((e) => e.idTail.startsWith("010")).length;
    const [c1, c2] = anchorsOf(scanResultOf(evs));
    expect([c1.status, c1.reason]).toEqual(["note", "malformed-ids"]);
    expect(c1.values.malformed).toBe(malformed);
    expect(c1.values.unrecognized).toBe(malformed);
    expect(c1.askAbout).toBe(`${malformed} server-issued ids do not have the form the service issues. Were some sessions run through another provider or gateway?`);
    expect(c2.status).toBe("pass");
  });

  test("a single malformed id is no note; a failing fit wins over the note", () => {
    const one = genuine().map((e, i) => (i === 0 ? { ...e, idTail: `010${"x".repeat(21)}` } : e));
    expect(anchorsOf(scanResultOf(one))[0].status).toBe("pass");
    const r = rng(23);
    const both = genuine().map((e, i) => (i % 11 === 0 ? { ...e, idTail: `010${randomB58(r, 21)}` } : i % 33 === 5 ? { ...e, ts: e.ts + 2 * HOUR } : e));
    expect(anchorsOf(scanResultOf(both))[0].status).toBe("fail");
  });

  test("11% foreign-marker ids are n/a with the kind's anchor count", () => {
    const r = rng(29);
    const evs = genuine().map((e, i) => (i % 9 === 0 ? { ...e, idTail: `02${randomB58(r, 22)}` } : e));
    const [c1, c2] = anchorsOf(scanResultOf(evs));
    expect([c1.status, c1.reason, c1.n]).toEqual(["n/a", "unknown-marker", 2_000]);
    expect(c1.values.unrecognized).toBe(evs.filter((e) => e.idTail.startsWith("02")).length);
    expect([c2.status, c2.n]).toEqual(["n/a", 2_000]);
  });

  test("one kind n/a on the marker share and the other passing is n/a", () => {
    const r = rng(31);
    const req = genuine("cc-req", 2).map((e, i) => (i % 9 === 0 ? { ...e, idTail: `02${randomB58(r, 22)}` } : e));
    const [c1, c2] = anchorsOf(scanResultOf([...genuine("cc-msg", 1), ...req]));
    expect([c1.status, c1.reason]).toEqual(["n/a", "unknown-marker"]);
    expect(c2.status).toBe("n/a");
  });

  test("one kind too-few and the other passing is pass", () => {
    const [c1, c2] = anchorsOf(scanResultOf([...genuine("cc-msg", 1), ...genuine("cc-req", 2).slice(0, 20)]));
    expect([c1.status, c2.status]).toEqual(["pass", "pass"]);
  });

  test("a kind whose marker-carrying ids are all malformed is a note, not too-few", () => {
    const r = rng(37);
    const bad = Array.from({ length: 1_000 }, (_, i) => anchor(T0 + i * MIN, `010${randomB58(r, 21)}`, "cc-req"));
    const [c1] = anchorsOf(scanResultOf([...genuine("cc-msg", 1), ...bad]));
    expect([c1.status, c1.reason]).toEqual(["note", "malformed-ids"]);
    expect(c1.values.malformed).toBe(1_000);
  });

  test("40 recognized and 960 malformed ids are a note", () => {
    const r = rng(41);
    const req = genuine("cc-req", 2).slice(0, 1_000).map((e, i) => (i < 960 ? { ...e, idTail: `010${randomB58(r, 21)}` } : e));
    const [c1] = anchorsOf(scanResultOf([...genuine("cc-msg", 1), ...req]));
    expect([c1.status, c1.reason]).toEqual(["note", "malformed-ids"]);
    expect(c1.values.malformed).toBe(960);
  });

  test("a kind of 30 clean anchors is too-few with its counts, and ranks below the other kind's pass", () => {
    const few = anchorsOf(scanResultOf(genuine("cc-req", 2).slice(0, 30)))[0];
    expect([few.status, few.reason]).toEqual(["n/a", "too-few"]);
    expect([few.values.unrecognized, few.values.malformed]).toEqual([0, 0]);
    const [c1] = anchorsOf(scanResultOf([...genuine("cc-msg", 1), ...genuine("cc-req", 2).slice(0, 30)]));
    expect(c1.status).toBe("pass");
    expect(c1.values.unverifiedKinds).toBe(0);
  });

  test("a note on one kind does not hide an unverifiable other kind", () => {
    const r = rng(43);
    const msg = genuine("cc-msg", 1).map((e, i) => (i % 33 === 0 ? { ...e, idTail: `010${randomB58(r, 21)}` } : e));
    const req = [...genuine("cc-req", 2), ...Array.from({ length: 3_000 }, () => anchor(T0 + Math.floor(r() * 20 * 86_400_000), `01${randomB58(r, 22)}`, "cc-req"))];
    const [c1, c2] = anchorsOf(scanResultOf([...msg, ...req]));
    expect([c1.status, c1.reason]).toEqual(["note", "malformed-ids"]);
    expect(c1.values.unverifiedKinds).toBe(1);
    expect(c2.values.unverifiedKinds).toBe(1);
  });
});

describe("checkAnchors: no fail on a single observation", () => {
  test("60 ids with one record 15 min late are a C1 note carrying the count, not a fail", () => {
    const evs = genuine().slice(0, 60).map((e, i) => (i === 30 ? { ...e, ts: e.ts + 15 * MIN } : e));
    const [c1] = anchorsOf(scanResultOf(evs));
    expect([c1.status, c1.reason, c1.values.offIds]).toEqual(["note", "off-time", 1]);
  });

  test("C1 fails at 3 ids off and more than 1%; 2 off over 1% are a note", () => {
    const shift = (n: number, at: number[]) => genuine().slice(0, n).map((e, i) => (at.includes(i) ? { ...e, ts: e.ts + 2 * HOUR } : e));
    const [three] = anchorsOf(scanResultOf(shift(200, [20, 80, 140])));
    expect([three.status, three.values.offIds]).toEqual(["fail", 3]);
    const [two] = anchorsOf(scanResultOf(shift(100, [20, 80])));
    expect([two.status, two.values.offIds]).toEqual(["note", 2]);
    const [few] = anchorsOf(scanResultOf(shift(400, [20, 80, 140])));
    expect(few.status).toBe("pass"); // 3 of 400 is under 1%
  });

  test("C2 is n/a (too-few) below 200 ids, and still fails from 200", () => {
    const [c1, c2] = anchorsOf(scanResultOf(genuine().slice(0, 199)));
    expect([c1.status, c2.status, c2.reason]).toEqual(["pass", "n/a", "too-few"]);
    const evs = genuine().slice(0, 200);
    const times = evs.map((e) => e.ts).reverse();
    const [, r2] = anchorsOf(scanResultOf(evs.map((e, i) => ({ ...e, ts: times[i]! }))));
    expect(r2.status).toBe("fail");
  });
});

describe("checkAnchors: a change of id encoding never fails anyone", () => {
  /** `n` ids over 60 days; the first `old` minted in the genuine encoding, the rest in another under the same marker. */
  function changed(n: number, old: number, seed = 9): AnchorEv[] {
    const r = rng(seed);
    return Array.from({ length: n }, (_, i) => {
      const ts = T0 + Math.floor((i * 60 * 86_400_000) / n);
      const tail = i < old ? genuineTail(ts, r) : `01${enc(20n * 58n ** 11n + BigInt(ts - T0) * 250n, 12)}${randomB58(r, 10)}`;
      return anchor(ts, tail);
    });
  }

  for (const old of [360, 280, 120, 20]) {
    test(`a split of ${old}/${400 - old} on 400 ids is scheme-changed, with a question about a tool or provider change`, () => {
      const [c1, c2] = anchorsOf(scanResultOf(changed(400, old)));
      expect([c1.status, c1.reason, c2.status, c2.reason]).toEqual(["n/a", "scheme-changed", "n/a", "scheme-changed"]);
      expect(c1.askAbout).toContain("tool, the provider or a gateway change");
    });
  }

  test("fewer than 10 ids of a new encoding are unverified ids: a note above 1%, never a fail", () => {
    expect(anchorsOf(scanResultOf(changed(400, 395))).map((c) => [c.status, c.reason])).toEqual([["note", "foreign-ids"], ["pass", "ok"]]);
    const [two] = anchorsOf(scanResultOf(changed(400, 398)));
    expect([two.status, two.reason, two.values.foreign]).toEqual(["pass", "ok", 2]); // 2 of 400: under 1%
    const [few] = anchorsOf(scanResultOf(changed(100, 98)));
    expect([few.status, few.reason, few.values.offIds]).toEqual(["note", "foreign-ids", 0]);
  });

  test("edited times are not mistaken for a scheme change", () => {
    const tail = genuine().map((e, i) => (i % 33 === 5 ? { ...e, ts: e.ts + 2 * 365 * 86_400_000 } : e)); // re-timed ids sort last
    expect(anchorsOf(scanResultOf(tail))[0].status).toBe("fail");
    const evs = genuine().map((e, i) => (i % 33 === 5 ? { ...e, ts: e.ts + 2 * HOUR } : e));
    expect(anchorsOf(scanResultOf(evs))[0].reason).toBe("off-time");
    const block = genuine().map((e, i) => (i >= 1_000 && i < 1_200 ? { ...e, ts: e.ts + 2 * HOUR } : e));
    expect(anchorsOf(scanResultOf(block))[0].status).toBe("fail");
  });
});

describe("checkAnchors: known limits (a later improvement changes these on purpose)", () => {
  test("known limit: a genuine history re-timed as a whole (stretched 3 times, moved 90 days back) passes C1 and C2", () => {
    const evs = genuine().map((e) => ({ ...e, ts: T0 - 90 * 86_400_000 + (e.ts - T0) * 3 }));
    const [c1, c2] = anchorsOf(scanResultOf(evs));
    expect([c1.status, c2.status]).toEqual(["pass", "pass"]);
  });

  test("known limit: ids invented to grow with time pass C1 and C2", () => {
    const r = rng(21);
    const evs = Array.from({ length: 500 }, (_, i) => {
      const ts = T0 + i * 37 * MIN;
      return anchor(ts, `01${enc(7n * 58n ** 11n + BigInt(ts - T0) * 77n, 12)}${randomB58(r, 10)}`);
    });
    const [c1, c2] = anchorsOf(scanResultOf(evs));
    expect([c1.status, c2.status]).toEqual(["pass", "pass"]);
  });
});

describe("checkAnchors: a block moved in time is no change of encoding", () => {
  const DAY = 86_400_000;
  /** `n` genuine ids, one every 30 min from 200 days after T0; `retime` moves a record's time, its id untouched. */
  function history(n: number, retime: (i: number, ts: number) => number, idOf?: (i: number, mint: number, r: () => number) => string): AnchorEv[] {
    const r = rng(n + 17);
    return Array.from({ length: n }, (_, i) => {
      const mint = T0 + 200 * DAY + i * 30 * MIN;
      return anchor(retime(i, mint), idOf ? idOf(i, mint, r) : genuineTail(mint, r));
    });
  }

  for (const [share, days] of [[0.02, 30], [0.1, 90], [0.3, 180], [0.6, 120]] as const) {
    test(`the oldest ${share * 100}% of the history moved ${days} days back fails C1`, () => {
      const [c1] = anchorsOf(scanResultOf(history(2_000, (i, ts) => (i < share * 2_000 ? ts - days * DAY : ts))));
      expect([c1.status, c1.reason]).toEqual(["fail", "off-time"]);
    });
  }

  test("a clock 20 min slow for the first 3% reads like one slow mid-history: the off-time fail, whose question names the clock", () => {
    for (const from of [0, 1_000]) {
      const [c1] = anchorsOf(scanResultOf(history(2_000, (i, ts) => (i >= from && i < from + 60 ? ts - 20 * MIN : ts))));
      expect([from, c1.status, c1.reason]).toEqual([from, "fail", "off-time"]);
      expect(c1.askAbout).toContain("clock wrong");
    }
  });

  test("the newest 20% moved 30 days forward fails C1", () => {
    const [c1] = anchorsOf(scanResultOf(history(2_000, (i, ts) => (i >= 1_600 ? ts + 30 * DAY : ts))));
    expect([c1.status, c1.reason]).toEqual(["fail", "off-time"]);
  });

  /** `n` ids over 60 days; from id `old` on, another encoding of the given kind under the same marker. */
  function encoded(n: number, old: number, kind: "slope" | "drop" | "leap"): AnchorEv[] {
    const r = rng(n + old);
    const at = (i: number) => T0 + Math.floor((i * 60 * DAY) / n);
    // "slope": values carry on from the last old id at four times the old slope
    const last = at(old - 1);
    return Array.from({ length: n }, (_, i) => {
      const ts = at(i);
      if (i < old) return anchor(ts, genuineTail(ts, r));
      const v = kind === "slope" ? BASE + BigInt(last - T0) * SCALE + BigInt(ts - last) * 4n * SCALE
        : kind === "drop" ? BASE - 2n * 58n ** 11n + BigInt(ts - T0) * SCALE
          : BASE + 10n * 58n ** 11n + BigInt(ts - T0) * SCALE;
      return anchor(ts, `01${enc(v, 12)}${randomB58(r, 10)}`);
    });
  }
  // ("slope" here carries the values on from the last old id at four times the old slope)
  for (const kind of ["drop", "leap"] as const) {
    for (const [n, old] of [[400, 360], [400, 280], [400, 120], [400, 20]] as const) {
      test(`a real change of encoding (${kind}) at ${old}/${n - old} of ${n} ids is scheme-changed`, () => {
        const [c1, c2] = anchorsOf(scanResultOf(encoded(n, old, kind)));
        expect([c1.status, c1.reason, c2.status, c2.reason]).toEqual(["n/a", "scheme-changed", "n/a", "scheme-changed"]);
      });
    }
    for (const old of [197, 191]) {
      test(`a real change of encoding (${kind}) with ${200 - old} new ids of 200 is the unverified-ids note`, () => {
        const [c1] = anchorsOf(scanResultOf(encoded(200, old, kind)));
        expect([c1.status, c1.reason, c1.values.foreign]).toEqual(["note", "foreign-ids", 200 - old]);
      });
    }
  }
  test("ids that carry on from the last old id at four times the slope imply times after the scan's end: another encoding", () => {
    expect(anchorsOf(scanResultOf(encoded(400, 280, "slope"))).map((c) => c.reason)).toEqual(["scheme-changed", "scheme-changed"]);
  });

  test("known limit: 300 ids invented with another slope, below the genuine range, 120 days earlier, pass as an older encoding", () => {
    const r = rng(9);
    const fab = Array.from({ length: 300 }, (_, i) => anchor(T0 + 50 * DAY + i * 40 * MIN, `01${enc(2n * 58n ** 11n + BigInt(i) * 777_000_000n, 12)}${randomB58(r, 10)}`));
    const [c1, c2] = anchorsOf(scanResultOf([...fab, ...history(2_000, (_, ts) => ts)]));
    expect([c1.status, c1.reason, c2.status, c2.reason]).toEqual(["n/a", "scheme-changed", "n/a", "scheme-changed"]);
  });

  test("C2 ranks only the ids on C1's line: a few new lower ids at the end fail neither; 10 or more on their own line are scheme-changed", () => {
    const tail = (k: number) => history(2_000, (_, ts) => ts, (i, mint, r) => (i >= 2_000 - k ? `01${enc(58n ** 11n + BigInt(i) * 1_000n, 12)}${randomB58(r, 10)}` : genuineTail(mint, r)));
    expect(anchorsOf(scanResultOf(tail(9))).map((c) => c.status)).toEqual(["pass", "pass"]);
    expect(anchorsOf(scanResultOf(tail(15))).map((c) => c.reason)).toEqual(["scheme-changed", "scheme-changed"]);
  });

  test("a scattered 0.75% of ids off their time fails neither C1 nor C2", () => {
    const [c1, c2] = anchorsOf(scanResultOf(history(2_000, (i, ts) => (i % 133 === 7 ? ts + 3 * HOUR : ts))));
    expect([c1.status, c1.values.offIds, c2.status]).toEqual(["pass", 15, "pass"]);
  });
});

describe("checkAnchors: an id is evidence about time only if the time its value implies is plausible", () => {
  const DAY = 86_400_000;
  const YEAR = 365 * DAY;
  /** The checks over `evs`, the scan ending at `end` (after every real mint time, as a scan does). */
  const at = (evs: AnchorEv[], end = T0 + 3 * YEAR) => anchorsOf(scanResultOf(evs, { finishedAt: end }));
  const START = T0 + 30 * DAY;
  /** `n` genuine ids minted at `mint(i)`; `retime` gives a record's stated time (undefined: the record is deleted). */
  function hist(n: number, mint: (i: number) => number, retime: (i: number, ts: number) => number | undefined): AnchorEv[] {
    const r = rng(n + 31);
    return Array.from({ length: n }, (_, i) => [mint(i), genuineTail(mint(i), r)] as const)
      .flatMap(([m, tail], i) => { const ts = retime(i, m); return ts === undefined ? [] : [anchor(ts, tail)]; });
  }
  const even = (i: number) => START + i * 30 * MIN;
  const N = 2_000;
  const offTime = (evs: AnchorEv[]) => { const [c1] = at(evs); return [c1.status, c1.reason]; };

  for (const s of [0.05, 0.2, 0.4]) {
    test(`case A: the newest ${s * 100}% moved to before the oldest session fails C1 (off-time)`, () => {
      expect(offTime(hist(N, even, (i, ts) => (i >= (1 - s) * N ? ts - 120 * DAY : ts)))).toEqual(["fail", "off-time"]);
    });
  }
  for (const s of [0.05, 0.2]) {
    test(`case B: the oldest ${s * 100}% moved to after the newest fails C1 (off-time)`, () => {
      expect(offTime(hist(N, even, (i, ts) => (i < s * N ? ts + 120 * DAY : ts)))).toEqual(["fail", "off-time"]);
    });
  }
  test("case C: a history with a real 90-day break, one side moved into the break, fails C1; untouched it passes", () => {
    const broken = (i: number) => even(i) + (i >= N / 2 ? 90 * DAY : 0);
    expect(offTime(hist(N, broken, (_, ts) => ts))).toEqual(["pass", "ok"]);
    expect(offTime(hist(N, broken, (i, ts) => (i >= N / 2 ? ts - 60 * DAY : ts)))).toEqual(["fail", "off-time"]);
    expect(offTime(hist(N, broken, (i, ts) => (i < N / 2 ? ts + 60 * DAY : ts)))).toEqual(["fail", "off-time"]);
    const late = (i: number) => even(i) + (i >= 0.9 * N ? 90 * DAY : 0);
    expect(offTime(hist(N, late, (i, ts) => (i >= 0.9 * N ? ts - 60 * DAY : ts)))).toEqual(["fail", "off-time"]);
  });
  test("case D: the oldest 20% moved back 30 days and the next 32 days of ids deleted fails C1", () => {
    expect(offTime(hist(N, even, (i, ts) => (i < 0.2 * N ? ts - 30 * DAY : ts - START < 0.2 * N * 30 * MIN + 32 * DAY ? undefined : ts))))
      .toEqual(["fail", "off-time"]);
  });
  test("case E: 2 ids in every 100 shifted 3 hours fail C1", () => {
    expect(offTime(hist(N, even, (i, ts) => (i % 100 < 2 ? ts + 3 * HOUR : ts)))).toEqual(["fail", "off-time"]);
  });
  test("known limit, case F: a history stretched gradually (each id 9 s per id later) passes", () => {
    const [c1, c2] = at(hist(N, even, (i, ts) => ts + i * 9_000));
    expect([c1.status, c2.status]).toEqual(["pass", "pass"]);
  });

  /** `n` ids over 60 days; from id `old` on, another encoding: another slope, or the same slope offset 30 years back or 2 years ahead. */
  function encoding(n: number, old: number, kind: "slope" | "decades" | "future"): AnchorEv[] {
    const r = rng(n + old + 5);
    const t = (i: number) => START + Math.floor((i * 60 * DAY) / n);
    return Array.from({ length: n }, (_, i) => {
      const ts = t(i);
      if (i < old) return anchor(ts, genuineTail(ts, r));
      const v = kind === "slope" ? 20n * 58n ** 11n + BigInt(ts - T0) * 250n
        : BASE + BigInt(ts - T0) * SCALE + (kind === "decades" ? -BigInt(30 * YEAR) : BigInt(2 * YEAR)) * SCALE;
      return anchor(ts, `01${enc(v, 12)}${randomB58(r, 10)}`);
    });
  }
  for (const kind of ["slope", "decades", "future"] as const) {
    for (const old of [360, 280, 120, 20]) {
      test(`a real change of encoding (${kind}) at ${old}/${400 - old} is scheme-changed`, () => {
        const [c1, c2] = at(encoding(400, old, kind));
        expect([c1.status, c1.reason, c2.status, c2.reason]).toEqual(["n/a", "scheme-changed", "n/a", "scheme-changed"]);
      });
    }
    test(`a real change of encoding (${kind}) with 9 ids on the new line is the unverified-ids note, never a fail`, () => {
      const [c1] = at(encoding(400, 391, kind));
      expect([c1.status, c1.reason, c1.values.foreign]).toEqual(["note", "foreign-ids", 9]);
      expect(c1.askAbout).toContain("gateway");
    });
  }

  test("a gateway: 5% of ids minted at random in the service's own shape are unverified ids with their question, never a fail", () => {
    const r = rng(77);
    const evs = hist(N, even, (_, ts) => ts).map((e, i) => (i % 20 === 3 ? { ...e, idTail: `01${randomB58(r, 22)}` } : e));
    const [c1, c2] = at(evs);
    expect([c1.status, c1.reason, c1.values.foreign, c2.status]).toEqual(["note", "foreign-ids", 100, "pass"]);
    expect(c1.askAbout).toBe("100 server-issued ids carry values that fit no plausible time on the service's time line, so they could not be checked against their times. Were some sessions run through another provider or a gateway that issues its own ids?");
    const many = hist(N, even, (_, ts) => ts).map((e, i) => (i % 5 === 3 ? { ...e, idTail: `01${randomB58(r, 22)}` } : e));
    expect(at(many).map((c) => [c.status, c.reason])).toEqual([["n/a", "foreign-ids"], ["n/a", "foreign-ids"]]);
  });

  test("known limit: a real break of more than a year, the later part moved, reads as another encoding (unverified)", () => {
    const parts = (i: number) => even(i) + (i >= 1_200 ? 500 * DAY : 0);
    expect(at(hist(N, parts, (_, ts) => ts))[0].status).toBe("pass");
    const [c1] = at(hist(N, parts, (i, ts) => (i >= 1_200 ? ts - 60 * DAY : ts)));
    expect([c1.status, c1.reason]).toEqual(["n/a", "scheme-changed"]);
  });
});
