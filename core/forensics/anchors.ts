import type { SessionTable } from "../analysis/types";
import type { AnchorEv } from "../model/events";
import type { ScanResult } from "../scan";
import { forensicScope, type ForensicScope } from "./scope";
import { asked } from "./questions";
import { roundDown, roundUp, toolsOf, type CheckResult, type CheckValues, type Reason } from "./types";

/*
 * C1 and C2: Claude Code's server-issued message and request ids (`msg_…`, `req_…`; `AnchorEv.idTail` is what follows
 * the prefix) grow with time. The time line is fitted from the history's own ids (its slope and offset are not the
 * service's constants), so the checks catch sessions that do not fit the rest of the history: spliced in, shuffled, or
 * partly re-timed. They do not catch a history re-timed as a whole (stretched or moved, every id with it), nor ids
 * invented to grow with time: both fit a line of their own. C9 (release dates) is the check that bounds re-timing.
 *
 * Per anchor kind (`cc-msg`, `cc-req`):
 * - recognized scheme: the tail starts with the marker `01`, which at least 90% of the kind's anchors share (else n/a
 *   `unknown-marker`), and the rest is base58 of 20 to 40 digits. Other anchors are left out, never counted as off:
 *   ids from other providers and gateways are genuine. `values.unrecognized` counts every anchor left out,
 *   `values.malformed` those that carry the marker but not the tail form; more than 1% of the marker-carrying anchors
 *   malformed, and at least 2, make C1 at least a note (`malformed-ids`), however few recognized anchors remain;
 *   every result of a kind carries both counts;
 * - fewer than 50 recognized anchors, and no malformed share over that rule: n/a (`too-few`);
 * - the decoded value `v`: the 12 base58 digits after the marker, less their minimum over the kind (BigInt);
 * - the fit of `ts` on `v`, over a stride sample of at most 5,000 (in time order). The start is the most-inliers line:
 *   of the lines through the pairs half the sample apart in `v` order, the one with the most sample points within
 *   10 min (the first among equals); then ordinary least squares over the sample points within 10 min of it. That is
 *   about 2,500 × 5,000 operations at most, and deterministic. Breakdown: whenever more than half of the sample is
 *   genuine, some pair half the sample apart is genuine at both ends (the pairs partition the sample), so a candidate
 *   through the genuine line exists. A crossing fabricated line can still win the start; the check then still fails,
 *   but the off share may understate the fabricated share. Fabricated or edited ids up to just under half the anchors
 *   therefore fail C1, and at half or more the median rule below makes it n/a;
 * - a median |residual| over 10 min: no line holds half of the anchors, n/a (`scheme-changed`);
 * - C1 fails when more than 1% of the anchors, and at least 3, are off their time by more than 10 min (`offIds`;
 *   `p99Seconds` rounded up, capped at a year); more than 1% with fewer than 3 off is a note (`off-time`);
 * - a change of encoding: when C1 would fail, and the time-ordered ids split at one point into two sides of at least
 *   10 that each fit their own line without failing that rule, whose id values do not overlap (`schemeSplit`), both
 *   are n/a (`scheme-changed`), at any split ratio. A minority of fewer than 10 ids is judged by the rule above;
 * - C2 is Spearman's rank correlation of `v` and `ts` over a stride sample of at most 20,000, and fails below 0.99;
 *   it needs at least 200 recognized anchors (else n/a `too-few`: one late record among a few dozen moves it below
 *   0.99), and is n/a wherever C1 is.
 *
 * The two kinds combine to the worse result, with `values.unverifiedKinds` (0, 1 or 2: the kinds that are n/a for a
 * reason other than `too-few`), where an n/a other than `too-few` outranks a pass: a kind that cannot be
 * verified does not vanish behind the other kind's pass.
 */

const MARKER = "01";
const MARKER_SHARE = 0.9;
const TAIL = /^[1-9A-HJ-NP-Za-km-z]{20,40}$/;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const DIGIT: ReadonlyMap<string, bigint> = new Map([...B58].map((c, i) => [c, BigInt(i)]));
const MIN_ANCHORS = 50;
const FIT_SAMPLE = 5_000;
const RANK_SAMPLE = 20_000;
const OFF_MS = 10 * 60_000;
const OFF_SHARE = 0.01;
const MIN_RHO = 0.99;
const OFF_MIN = 3;
const MIN_RANKED = 200;
const KINDS: readonly AnchorEv["kind"][] = ["cc-msg", "cc-req"];

interface Point { v: number; ts: number }

function base58(s: string): bigint {
  let v = 0n;
  for (const c of s) v = v * 58n + DIGIT.get(c)!;
  return v;
}

/** At most `max` items, evenly strided over `xs` (all of them when they fit). */
function stride<T>(xs: readonly T[], max: number): T[] {
  if (xs.length <= max) return [...xs];
  const step = xs.length / max;
  return Array.from({ length: max }, (_, i) => xs[Math.floor(i * step)]!);
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** The q-quantile by nearest rank (`q` in (0, 1]) of non-empty values. */
const quantile = (xs: number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(q * s.length) - 1)]!;
};

interface Line { a: number; b: number }   // ts = a + b·v

/**
 * The most-inliers start: the line through each pair half the sample apart in `v` order (distinct `v`), scored by the
 * sample points within 10 min of it; the first line with the most wins. Undefined when `v` is constant.
 */
function inlierLine(ps: readonly Point[]): Line | undefined {
  const s = [...ps].sort((x, y) => x.v - y.v || x.ts - y.ts);
  const h = s.length >> 1;
  let best: Line | undefined;
  let bestCount = -1;
  for (let i = 0; i + h < s.length; i++) {
    const p = s[i]!, q = s[i + h]!;
    if (q.v === p.v) continue;
    const b = (q.ts - p.ts) / (q.v - p.v);
    const a = p.ts - b * p.v;
    let count = 0;
    for (const r of s) if (Math.abs(r.ts - a - b * r.v) <= OFF_MS) count++;
    if (count > bestCount) {
      bestCount = count;
      best = { a, b };
    }
  }
  return best;
}

/** Ordinary least squares of `ts` on `v` (centred); undefined with fewer than 2 points or a constant `v`. */
function ols(ps: readonly Point[]): Line | undefined {
  if (ps.length < 2) return undefined;
  let mv = 0, mt = 0;
  for (const p of ps) { mv += p.v; mt += p.ts; }
  mv /= ps.length;
  mt /= ps.length;
  let sxy = 0, sxx = 0;
  for (const p of ps) { sxy += (p.v - mv) * (p.ts - mt); sxx += (p.v - mv) ** 2; }
  if (sxx === 0) return undefined;
  const b = sxy / sxx;
  return { a: mt - b * mv, b };
}

/** Average ranks (1-based; ties share their mean rank). */
function ranks(xs: readonly number[]): number[] {
  const order = xs.map((_, i) => i).sort((i, j) => xs[i]! - xs[j]!);
  const out = new Array<number>(xs.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && xs[order[j + 1]!] === xs[order[i]!]) j++;
    for (let k = i; k <= j; k++) out[order[k]!] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return out;
}

/** Spearman's ρ of `v` and `ts`; undefined when either side is constant. */
function spearman(ps: readonly Point[]): number | undefined {
  const rv = ranks(ps.map((p) => p.v));
  const rt = ranks(ps.map((p) => p.ts));
  const m = (ps.length + 1) / 2;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < ps.length; i++) {
    const x = rv[i]! - m, y = rt[i]! - m;
    sxy += x * y; sxx += x * x; syy += y * y;
  }
  return sxx === 0 || syy === 0 ? undefined : sxy / Math.sqrt(sxx * syy);
}

interface Recognized { points: Point[]; marked: number; malformed: number; unrecognized: number }

/** The recognized anchors of one kind as points, sorted by time (then id), with what was left out. */
function recognize(anchors: readonly AnchorEv[]): Recognized {
  const marked = anchors.filter((a) => a.idTail.startsWith(MARKER));
  const ok = marked.filter((a) => TAIL.test(a.idTail.slice(MARKER.length)))
    .sort((x, y) => x.ts - y.ts || (x.idTail < y.idTail ? -1 : x.idTail > y.idTail ? 1 : 0));
  const out = { marked: marked.length, malformed: marked.length - ok.length, unrecognized: anchors.length - ok.length };
  if (ok.length === 0) return { points: [], ...out };
  const raw = ok.map((a) => base58(a.idTail.slice(MARKER.length, MARKER.length + 12)));
  let min = raw[0]!;
  for (const v of raw) if (v < min) min = v;
  return { points: ok.map((a, i) => ({ v: Number(raw[i]! - min), ts: a.ts })), ...out };
}

/** The ids each side of a change point needs, the sample a side's line is fitted on, and the split grid per pass. */
const SPLIT_MIN = 10;
const SPLIT_FIT = 1_000;
const SPLIT_GRID = 32;

/** Whether `off` ids off the line among `n` fail C1: more than 1% of them, and at least 3. */
const offFails = (off: number, n: number): boolean => off > OFF_SHARE * n && off >= OFF_MIN;

/**
 * One side of a split: the ids off its own line (the start and fit C1 uses, over a stride sample of at most 1,000), or
 * undefined when no line holds half of the side.
 */
function sideOff(ps: readonly Point[]): number | undefined {
  const sample = stride(ps, SPLIT_FIT);
  const start = inlierLine(sample);
  const line = start ? ols(sample.filter((p) => Math.abs(p.ts - start.a - start.b * p.v) <= OFF_MS)) : undefined;
  if (line === undefined) return undefined;
  const res = ps.map((p) => Math.abs(p.ts - line.a - line.b * p.v));
  if (median(res) > OFF_MS) return undefined;
  return res.filter((r) => r > OFF_MS).length;
}

/**
 * A change of encoding at one point in time: of the splits of the time-ordered ids with at least 10 on each side, the
 * one with the fewest ids off their side's own line (a grid of 33 splits, narrowed around the best until it is exact;
 * deterministic), when neither side fails C1's rule on its own line, and the two sides' id values do not overlap (more
 * than C1's rule allows): a new encoding mints values outside the old range, a block of re-timed ids keeps its own.
 */
function schemeSplit(ps: readonly Point[]): boolean {
  const memo = new Map<number, [number, number] | undefined>();
  const sides = (k: number): [number, number] | undefined => {
    if (!memo.has(k)) {
      const a = sideOff(ps.slice(0, k)), b = a === undefined ? undefined : sideOff(ps.slice(k));
      memo.set(k, a === undefined || b === undefined ? undefined : [a, b]);
    }
    return memo.get(k);
  };
  let lo = SPLIT_MIN, hi = ps.length - SPLIT_MIN;
  if (lo > hi) return false;
  let best = -1, bestOff = Infinity;
  for (;;) {
    const step = Math.max(1, Math.ceil((hi - lo) / SPLIT_GRID));
    for (let k = lo; k <= hi; k = k === hi ? hi + 1 : Math.min(hi, k + step)) {
      const x = sides(k);
      if (x !== undefined && x[0] + x[1] < bestOff) {
        bestOff = x[0] + x[1];
        best = k;
      }
    }
    if (best < 0 || step === 1) break;
    lo = Math.max(SPLIT_MIN, best - step);
    hi = Math.min(ps.length - SPLIT_MIN, best + step);
  }
  if (best < 0) return false;
  const [a, b] = sides(best)!;
  if (offFails(a, best) || offFails(b, ps.length - best)) return false;
  // a new encoding mints ids outside the old ones' range; ids re-timed as a block keep their values inside the other
  // side's range, so that is no scheme change
  const range = (xs: readonly Point[]): [number, number] => {
    let lo = Infinity, hi = -Infinity;
    for (const p of xs) {
      if (p.v < lo) lo = p.v;
      if (p.v > hi) hi = p.v;
    }
    return [lo, hi];
  };
  const before = ps.slice(0, best), after = ps.slice(best);
  const [b0, b1] = range(before), [a0, a1] = range(after);
  const inside = after.filter((p) => p.v >= b0 && p.v <= b1).length + before.filter((p) => p.v >= a0 && p.v <= a1).length;
  return !offFails(inside, ps.length);
}

const MAX_P99_S = 31_536_000;
const MALFORMED_SHARE = 0.01;
const MALFORMED_MIN = 2;

function naPair(n: number, reason: Reason, values: CheckValues, tools: CheckResult["tools"]): [CheckResult, CheckResult] {
  return [{ id: "C1", status: "n/a", n, reason, values: { ...values }, tools: [...tools] }, { id: "C2", status: "n/a", n, reason, values: { ...values }, tools: [...tools] }];
}

function checkKind(anchors: readonly AnchorEv[]): [CheckResult, CheckResult] {
  const tools = toolsOf(anchors);
  const rec = recognize(anchors);
  const left = { unrecognized: rec.unrecognized, malformed: rec.malformed } satisfies CheckValues;
  if (anchors.length >= MIN_ANCHORS && rec.marked < MARKER_SHARE * anchors.length) return naPair(anchors.length, "unknown-marker", left, tools);
  const malformed = rec.malformed >= MALFORMED_MIN && rec.malformed > MALFORMED_SHARE * rec.marked;
  const ps = rec.points;
  if (ps.length < MIN_ANCHORS) {
    const [c1, c2] = naPair(ps.length, "too-few", left, tools);
    if (!malformed) return [c1, c2];
    return [{ id: "C1", status: "note", n: anchors.length, reason: "malformed-ids", values: { ...left }, tools }, c2];
  }
  const sample = stride(ps, FIT_SAMPLE);
  const start = inlierLine(sample);
  const inliers = start ? sample.filter((p) => Math.abs(p.ts - start.a - start.b * p.v) <= OFF_MS) : [];
  const line = ols(inliers);
  if (line === undefined) return naPair(anchors.length, "scheme-changed", left, tools);
  const res = ps.map((p) => Math.abs(p.ts - line.a - line.b * p.v));
  if (median(res) > OFF_MS) return naPair(anchors.length, "scheme-changed", left, tools);

  const offIds = res.filter((r) => r > OFF_MS).length;
  const off = offIds / ps.length;
  // more than 1% off fails only with at least 3 ids off: one late record among few ids is no evidence of editing
  const offOver = off > OFF_SHARE;
  const c1Fail = offFails(offIds, ps.length);
  // ids that fit one line before a point in time and another after it: the encoding changed, which fails no one
  if (c1Fail && schemeSplit(ps)) return naPair(anchors.length, "scheme-changed", left, tools);
  const c1: CheckResult = {
    id: "C1", status: c1Fail || offOver || malformed ? (c1Fail ? "fail" : "note") : "pass", n: ps.length,
    reason: offOver ? "off-time" : malformed ? "malformed-ids" : "ok",
    values: { offShare: roundUp(off), offIds, p99Seconds: Math.min(MAX_P99_S, Math.ceil(quantile(res, 0.99) / 1_000)), ...left }, tools: [...tools],
  };

  if (ps.length < MIN_RANKED) return [c1, { id: "C2", status: "n/a", n: ps.length, reason: "too-few", values: { ...left }, tools: [...tools] }];
  const rankSample = stride(ps, RANK_SAMPLE);
  const rho = spearman(rankSample);
  if (rho === undefined) return [c1, { id: "C2", status: "n/a", n: rankSample.length, reason: "degenerate", values: { ...left }, tools }];
  const c2Fail = rho < MIN_RHO;
  const c2: CheckResult = { id: "C2", status: c2Fail ? "fail" : "pass", n: rankSample.length, reason: c2Fail ? "out-of-order" : "ok",
    values: { rho: roundDown(rho), ...left } satisfies CheckValues, tools };
  return [c1, c2];
}

/** How a kind's result ranks in the two-kind combination: as `worst` does, but an n/a other than `too-few` outranks a pass. */
const comboRank = (r: CheckResult): number =>
  r.status === "n/a" ? (r.reason === "too-few" ? 0 : 2.5) : ({ info: 1, pass: 2, note: 3, warn: 4, fail: 5 } as const)[r.status];
function combine(rs: readonly CheckResult[]): CheckResult {
  let out = rs[0]!;
  for (const r of rs) if (comboRank(r) > comboRank(out)) out = r;
  const unverifiedKinds = rs.filter((r) => r.status === "n/a" && r.reason !== "too-few").length;
  return { ...out, values: { ...out.values, unverifiedKinds }, tools: [...out.tools] };
}

/**
 * C1 (ids linear in time) and C2 (id order vs time order) over Claude Code's anchors in scope (`ForensicScope.anchors`:
 * kept tools, `ts` inside the date range), per kind, then combined.
 */
export function checkAnchors(raw: ScanResult, t: SessionTable, s: ForensicScope = forensicScope(raw, t)): [CheckResult, CheckResult] {
  const all = s.anchors();
  const perKind = KINDS.map((k) => checkKind(all.filter((a) => a.kind === k)));
  return [asked(combine(perKind.map((p) => p[0]))), asked(combine(perKind.map((p) => p[1])))];
}
