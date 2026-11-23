import type { AnchorEv } from "../model/events";
import type { ScanResult } from "../scan";
import { round, toolsOf, worst, type CheckResult } from "./types";

/*
 * C1 and C2: Claude Code's server-issued message and request ids (`msg_…`, `req_…`; `AnchorEv.idTail` is what follows
 * the prefix) grow with time. An id the server minted cannot be made to fit a time it was not minted at, so ids that are
 * off their time line show edited times, and ids that fit no line at all show fabrication.
 *
 * Per anchor kind (`cc-msg`, `cc-req`), and the worse result of the two kinds wins:
 * - recognized scheme: the tail starts with the marker `01`, which at least 90% of the kind's anchors share, and the
 *   rest is base58 of 20 to 40 digits; other anchors are left out;
 * - fewer than 50 recognized anchors: n/a (`too-few`);
 * - the decoded value `v`: the 12 base58 digits after the marker, less their minimum over the kind (BigInt);
 * - the fit of `ts` on `v`, over a stride sample of at most 5,000: a robust start (the median slope of pairs half the
 *   sample apart in `v`, the median intercept), then ordinary least squares over the points the start places within
 *   10 min. The robust start keeps a few fabricated ids, whose random `v` lie far off the genuine range, from levering
 *   the line away from the genuine ones;
 * - a median |residual| over 10 min: the ids no longer track time, n/a (`scheme-changed`);
 * - C1 fails when more than 1% of the anchors are off their time by more than 10 min;
 * - C2 is Spearman's rank correlation of `v` and `ts` over a stride sample of at most 20,000, and fails below 0.99;
 *   it is n/a wherever C1 is.
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

/** The median slope of pairs half the sample apart in `v`, and the median intercept; undefined when `v` is constant. */
function robustLine(ps: readonly Point[]): Line | undefined {
  const s = [...ps].sort((x, y) => x.v - y.v);
  const h = s.length >> 1;
  const slopes: number[] = [];
  for (let i = 0; i + h < s.length; i++) {
    const p = s[i]!, q = s[i + h]!;
    if (q.v !== p.v) slopes.push((q.ts - p.ts) / (q.v - p.v));
  }
  if (slopes.length === 0) return undefined;
  const b = median(slopes);
  return { a: median(s.map((p) => p.ts - b * p.v)), b };
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

/** The recognized anchors of one kind as points, sorted by time (then id); `undefined` when the marker is not shared. */
function pointsOf(anchors: readonly AnchorEv[]): Point[] | undefined {
  const marked = anchors.filter((a) => a.idTail.startsWith(MARKER));
  if (marked.length < MARKER_SHARE * anchors.length) return undefined;
  const ok = marked.filter((a) => TAIL.test(a.idTail.slice(MARKER.length)))
    .sort((x, y) => x.ts - y.ts || (x.idTail < y.idTail ? -1 : x.idTail > y.idTail ? 1 : 0));
  if (ok.length === 0) return [];
  const raw = ok.map((a) => base58(a.idTail.slice(MARKER.length, MARKER.length + 12)));
  let min = raw[0]!;
  for (const v of raw) if (v < min) min = v;
  return ok.map((a, i) => ({ v: Number(raw[i]! - min), ts: a.ts }));
}

const C1_ASK = (pct: number): string =>
  `About ${pct}% of the server-issued ids do not match their recorded times, by more than 10 minutes. Were any trace times edited, or sessions added from somewhere else?`;
const C2_ASK = (rho: number): string =>
  `The order of the server-issued ids does not follow the order of their recorded times (rank correlation ${rho}). Were trace files merged or their times edited?`;

function naPair(n: number, reason: string, tools: CheckResult["tools"]): [CheckResult, CheckResult] {
  return [{ id: "C1", status: "n/a", n, reason, values: {}, tools }, { id: "C2", status: "n/a", n, reason, values: {}, tools }];
}

function checkKind(anchors: readonly AnchorEv[]): [CheckResult, CheckResult] {
  const tools = toolsOf(anchors);
  if (anchors.length < MIN_ANCHORS) return naPair(anchors.length, "too-few", tools);
  const ps = pointsOf(anchors);
  if (ps === undefined) return naPair(0, "scheme-changed", tools);
  if (ps.length < MIN_ANCHORS) return naPair(ps.length, "too-few", tools);
  const sample = stride(ps, FIT_SAMPLE);
  const start = robustLine(sample);
  const inliers = start ? sample.filter((p) => Math.abs(p.ts - start.a - start.b * p.v) <= OFF_MS) : [];
  const line = ols(inliers);
  if (line === undefined) return naPair(ps.length, "scheme-changed", tools);
  const res = ps.map((p) => Math.abs(p.ts - line.a - line.b * p.v));
  if (median(res) > OFF_MS) return naPair(ps.length, "scheme-changed", tools);

  const off = res.filter((r) => r > OFF_MS).length / ps.length;
  const c1Fail = off > OFF_SHARE;
  const c1: CheckResult = {
    id: "C1", status: c1Fail ? "fail" : "pass", n: ps.length, reason: c1Fail ? "off-time" : "ok",
    values: { offShare: round(off), p99Seconds: Math.round(quantile(res, 0.99) / 1_000) }, tools,
  };
  if (c1Fail) c1.askAbout = C1_ASK(Math.max(1, Math.round(off * 100)));

  const rankSample = stride(ps, RANK_SAMPLE);
  const rho = spearman(rankSample);
  if (rho === undefined) return [c1, { id: "C2", status: "n/a", n: rankSample.length, reason: "degenerate", values: {}, tools }];
  const c2Fail = rho < MIN_RHO;
  const c2: CheckResult = { id: "C2", status: c2Fail ? "fail" : "pass", n: rankSample.length, reason: c2Fail ? "out-of-order" : "ok",
    values: { rho: round(rho) }, tools };
  if (c2Fail) c2.askAbout = C2_ASK(round(rho, 2));
  return [c1, c2];
}

/** C1 (ids linear in time) and C2 (id order vs time order) over Claude Code's anchors: per kind, the worse kind wins. */
export function checkAnchors(raw: ScanResult): [CheckResult, CheckResult] {
  const all = raw.store.all("anchor");
  const perKind = KINDS.map((k) => checkKind(all.filter((a) => a.kind === k)));
  return [worst(perKind.map((p) => p[0]))!, worst(perKind.map((p) => p[1]))!];
}
