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
 * invented to grow with time: both fit a line of their own. Ids invented with another slope or with far-off values
 * read as another encoding (`scheme-changed` or `foreign-ids`: a question, never `consistent`, never a fail). A real
 * break in use of more than a year with one part moved in time reads the same way: the moved part's values imply times
 * more than a year from the rest, which the rule cannot tell from another encoding. A new encoding whose values carry
 * on from the old ones at another slope fails C1: its first ids imply plausible times, and the off verdict comes
 * before foreign ids are considered. C9 (release dates) is the check that bounds re-timing: it
 * catches a history moved back more than 90 days before a model's release.
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
 *   of the lines through the pairs half the sample apart in `v` order (and an eighth and a sixty-fourth of that), the
 *   one with the most sample points within 10 min (the first among equals); then ordinary least squares over the
 *   sample points within 10 min of it. Each pair distance d gives n − d candidates, so the three distances give about
 *   (2,500 + 4,690 + 4,960) × 5,000 ≈ 61 million operations at most, and deterministic.
 *   Breakdown: whenever more than half of the sample is genuine, some pair half the sample apart is genuine at both
 *   ends (the pairs partition the sample), so a candidate through the genuine line exists; the closer pairs give one
 *   through a genuine block holding fewer, when its ids are contiguous in `v`. A crossing fabricated line can still win the start; the check then still fails,
 *   but the off share may understate the fabricated share;
 * - a fitted line whose slope is not positive (ids that do not grow with time, say every time reversed): C1 is n/a
 *   (`degenerate`), never a pass, so never server-backed; C2 still ranks the ids on that line (a reversal spanning a
 *   day or more fails there);
 * - no line at all (every `v` equal), or the best line holds under 10% of the ids: n/a (`scheme-changed`). The line
 *   holding the most ids is the main encoding, even when it holds half or less: the ids off it are then judged one
 *   by one, as below;
 * - an id is evidence about time only if the time the line implies for its value is plausible: not later than the
 *   scan's end (plus 10 min) and within a year of the span of the ids on the line. An id off its time by more than
 *   10 min whose implied time is plausible is this encoding at the wrong time: it is off, whatever the arrangement
 *   (a block at either end, in the middle, moved across the rest or into a real break, or scattered), because a moved
 *   genuine id keeps its value and the line maps it back next to the rest. An off id whose implied time is not
 *   plausible is not this encoding (another encoding, a gateway minting its own ids, an invented id): never off, it
 *   is counted in `foreign` and is unverified. At least 10 of them on a line of their own: n/a (`scheme-changed`), at
 *   any share; else more than 10% of the recognized ids: n/a (`foreign-ids`); else at least 2 and more than 1%: a C1
 *   note (`foreign-ids`);
 * - C1 fails when more than 1% of this encoding's ids (the recognized ids less the foreign ones), and at least 3, are
 *   off (`offIds`, `offShare`; `p99Seconds` over the ids that are not foreign, rounded up, capped at a year); more than
 *   1% with fewer than 3 off is a note (`off-time`). The order of decisions: first this off-time verdict; only a kind
 *   that does not fail may then be made unverified by its foreign ids (`scheme-changed` for 10 on a line of their own,
 *   then `foreign-ids` above 10%), so foreign ids never hide a fail, and a failing kind still carries their count;
 *   then the C1 note (off-time, then foreign-ids, then malformed-ids), else a pass;
 * - C2 is Spearman's rank correlation of `v` and `ts` over a stride sample of at most 20,000 of the ids on C1's line
 *   (those C1 counted off are judged by C1's own thresholds), and fails below 0.99;
 *   it needs at least 200 recognized anchors (else n/a `too-few`: one late record among a few dozen moves it below
 *   0.99), and ranked ids that span at least 24 hours (else n/a `too-few`: within one dense burst, records written
 *   minutes late by parallel agents reorder ids that are minutes apart); it is n/a wherever C1 is n/a.
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
const RANK_SPAN_MS = 86_400_000;
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
  const half = s.length >> 1;
  let best: Line | undefined;
  let bestCount = -1;
  // pairs half the sample apart, and an eighth and a sixty-fourth of that: a genuine block that is contiguous in `v`
  // but holds half the ids or fewer still gives a candidate through two of its own ids
  for (const h of [...new Set([half, Math.ceil(half / 8), Math.ceil(half / 64)])]) for (let i = 0; i + h < s.length; i++) {
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

/** A line of its own needs this many ids not of the main encoding; the plausible reach of a line beyond its span. */
const FOREIGN_LINE_MIN = 10;
const FOREIGN_FIT = 1_000;
const REACH_MS = 365 * 86_400_000;
/** Above this share of the recognized ids, ids that are not this encoding leave the kind unverifiable. */
const FOREIGN_SHARE = 0.1;
/** The main line must hold at least this share of the recognized ids. */
const MAIN_SHARE = 0.1;

/** Whether `off` ids off the line among `n` fail C1: more than 1% of them, and at least 3. */
const offFails = (off: number, n: number): boolean => off > OFF_SHARE * n && off >= OFF_MIN;

/** Whether some ids fit a line of their own: a line holds at least half of them (over a stride sample of 1,000). */
function ownLine(ps: readonly Point[]): boolean {
  const sample = stride(ps, FOREIGN_FIT);
  const start = inlierLine(sample);
  const line = start ? ols(sample.filter((p) => Math.abs(p.ts - start.a - start.b * p.v) <= OFF_MS)) : undefined;
  return line !== undefined && median(ps.map((p) => Math.abs(p.ts - line.a - line.b * p.v))) <= OFF_MS;
}

const MAX_P99_S = 31_536_000;
const MALFORMED_SHARE = 0.01;
const MALFORMED_MIN = 2;
const FOREIGN_MIN = 2;

function naPair(n: number, reason: Reason, values: CheckValues, tools: CheckResult["tools"]): [CheckResult, CheckResult] {
  return [{ id: "C1", status: "n/a", n, reason, values: { ...values }, tools: [...tools] }, { id: "C2", status: "n/a", n, reason, values: { ...values }, tools: [...tools] }];
}

function checkKind(anchors: readonly AnchorEv[], end: number): [CheckResult, CheckResult] {
  const tools = toolsOf(anchors);
  const rec = recognize(anchors);
  const counts = { unrecognized: rec.unrecognized, malformed: rec.malformed } satisfies CheckValues;
  if (anchors.length >= MIN_ANCHORS && rec.marked < MARKER_SHARE * anchors.length) return naPair(anchors.length, "unknown-marker", counts, tools);
  const malformed = rec.malformed >= MALFORMED_MIN && rec.malformed > MALFORMED_SHARE * rec.marked;
  const ps = rec.points;
  if (ps.length < MIN_ANCHORS) {
    const [c1, c2] = naPair(ps.length, "too-few", counts, tools);
    if (!malformed) return [c1, c2];
    return [{ id: "C1", status: "note", n: anchors.length, reason: "malformed-ids", values: { ...counts }, tools }, c2];
  }
  const sample = stride(ps, FIT_SAMPLE);
  const start = inlierLine(sample);
  const inliers = start ? sample.filter((p) => Math.abs(p.ts - start.a - start.b * p.v) <= OFF_MS) : [];
  const line = ols(inliers);
  if (line === undefined) return naPair(anchors.length, "scheme-changed", counts, tools);
  const implied = ps.map((p) => line.a + line.b * p.v);
  const res = ps.map((p, i) => Math.abs(p.ts - implied[i]!));
  // a line holding few ids is no time line at all: every other id would look plausible and off
  if (res.filter((r) => r <= OFF_MS).length < MAIN_SHARE * ps.length) return naPair(anchors.length, "scheme-changed", counts, tools);

  // the main encoding's span: its ids on the line; an id is evidence about time only where its implied time is plausible
  let from = Infinity, to = -Infinity;
  for (let i = 0; i < ps.length; i++) {
    if (res[i]! > OFF_MS) continue;
    if (ps[i]!.ts < from) from = ps[i]!.ts;
    if (ps[i]!.ts > to) to = ps[i]!.ts;
  }
  const plausible = (t: number): boolean => t <= end + OFF_MS && t >= from - REACH_MS && t <= to + REACH_MS;
  const foreignPs = ps.filter((_, i) => res[i]! > OFF_MS && !plausible(implied[i]!));
  const foreign = foreignPs.length;
  const left = { ...counts, foreign } satisfies CheckValues;

  // first the off-time verdict, over this encoding's ids alone (foreign ids can neither dilute nor hide it); more than
  // 1% off fails only with at least 3 ids off: one late record among few ids is no evidence of editing
  const own = ps.length - foreign;
  const offIds = res.filter((r, i) => r > OFF_MS && plausible(implied[i]!)).length;
  const off = offIds / own;
  const offOver = off > OFF_SHARE;
  const c1Fail = offFails(offIds, own);
  // only a kind that does not fail may be made unverified by ids that are not this encoding: on a line of their own
  // (another encoding, at any share), or above their share
  if (!c1Fail && foreign >= FOREIGN_LINE_MIN && ownLine(foreignPs)) return naPair(anchors.length, "scheme-changed", left, tools);
  if (!c1Fail && foreign > FOREIGN_SHARE * ps.length) return naPair(anchors.length, "foreign-ids", left, tools);
  const foreignNote = foreign >= FOREIGN_MIN && foreign > MALFORMED_SHARE * ps.length;
  const offRes = res.filter((r, i) => r <= OFF_MS || plausible(implied[i]!));
  // ids that do not grow with time (a slope that is zero or negative) are no time line: C1 is not applicable, never a
  // pass; C2 still ranks the ids on that line, so a reversal over a day or more fails there
  const c1: CheckResult = !(line.b > 0) ? { id: "C1", status: "n/a", n: anchors.length, reason: "degenerate", values: { ...left }, tools: [...tools] } : {
    id: "C1", status: c1Fail ? "fail" : offOver || foreignNote || malformed ? "note" : "pass", n: ps.length,
    reason: offOver ? "off-time" : foreignNote ? "foreign-ids" : malformed ? "malformed-ids" : "ok",
    values: { offShare: roundUp(off), offIds, p99Seconds: Math.min(MAX_P99_S, Math.ceil(quantile(offRes, 0.99) / 1_000)), ...left }, tools: [...tools],
  };

  // C2 ranks only the ids on C1's line: the ids off it are C1's business, under C1's thresholds
  if (ps.length < MIN_RANKED) return [c1, { id: "C2", status: "n/a", n: ps.length, reason: "too-few", values: { ...left }, tools: [...tools] }];
  const rankSample = stride(ps.filter((_, i) => res[i]! <= OFF_MS), RANK_SAMPLE);
  // the order of ids whose times lie within minutes of each other says nothing (records land minutes late): C2 ranks
  // only ids that span at least a day
  let r0 = Infinity, r1 = -Infinity;
  for (const p of rankSample) {
    if (p.ts < r0) r0 = p.ts;
    if (p.ts > r1) r1 = p.ts;
  }
  if (!(r1 - r0 >= RANK_SPAN_MS)) return [c1, { id: "C2", status: "n/a", n: rankSample.length, reason: "too-few", values: { ...left }, tools: [...tools] }];
  const rho = spearman(rankSample);
  if (rho === undefined) return [c1, { id: "C2", status: "n/a", n: rankSample.length, reason: "degenerate", values: { ...left }, tools: [...tools] }];
  const c2Fail = rho < MIN_RHO;
  const c2: CheckResult = { id: "C2", status: c2Fail ? "fail" : "pass", n: rankSample.length, reason: c2Fail ? "out-of-order" : "ok",
    values: { rho: roundDown(rho), ...left } satisfies CheckValues, tools: [...tools] };
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
  const perKind = KINDS.map((k) => checkKind(all.filter((a) => a.kind === k), raw.finishedAt));
  return [asked(combine(perKind.map((p) => p[0]))), asked(combine(perKind.map((p) => p[1])))];
}
