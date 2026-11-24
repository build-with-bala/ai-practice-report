import type { SessionTable } from "../analysis/types";
import type { RateLimitEv } from "../model/events";
import type { ScanResult } from "../scan";
import { THREADS_SOURCE } from "../sources/codex/indexdb";
import { forensicScope, type ForensicScope } from "./scope";
import { asked } from "./questions";
import { toolsOf, type CheckResult, type CheckValues } from "./types";

/*
 * C6–C8: Codex's own records agree with each other. The CLI enters every thread it starts in its thread index, names
 * each rollout file after the local time it began, mints the thread id as a UUIDv7 carrying that same moment, and logs
 * the account's usage-limit readings, which only rise within one limit window. A rollout copied in from elsewhere has no
 * index row, a renamed one no longer fits its id, and two accounts' traces spliced together make the readings fall.
 *
 * Known limits: rollouts whose start (id time, else name time) is within 10 minutes of the scan, or after it, are not
 * checked by C6 (the CLI may not have written their row yet), so a copied rollout given such a start passes. Two
 * accounts' ledgers spliced together pass C8 when their reset times differ by more than a minute: each account's
 * readings then form windows of their own, which only rise.
 */

const RECENT_MS = 10 * 60_000;
const MISSING_MIN = 2;
const MISSING_SHARE = 0.01;
/** C6 and C7 pass only on at least this many rollouts: a pass on one or two says nothing about a history. */
const MIN_PASS = 5;
const ID_TOL_MS = 1_000;
const QUARTER_MS = 15 * 60_000;
const ZONE_TOL_MS = 2_000;
const ZONE_LAG_MS = 60_000;
const ZONE_MAX_QUARTERS = 104;   // 26 h: two real zones can differ by up to 26 h
const RESET_TOL_MS = 60_000;
const DROP_POINTS = 2;
/** A fall counts only when the lower reading is stamped more than this after the higher one: closer is interleaving. */
const DROP_GAP_MS = 10 * 60_000;
const MIN_PAIRS = 20;
const FAIL_MIN = 3;
const FAIL_SHARE = 0.01;

/**
 * C6, every rollout in scope has a thread-index row in scope (by `threadId`). Rollouts that began at or after 10 min
 * before `now` are left out: the CLI may not have written their row yet. n/a without a read thread index (coverage of a
 * kept tool's `codex.threads`, `ok` or `drift` with records), or without rollouts. Rollouts missing their row: at least
 * max(2, 1% of the rollouts checked) → warn (never a fail: rollouts copied in from another machine are honest); fewer,
 * but at least 1 → note with the same question (a genuine machine can
 * hold a stray one). The index cannot vouch for sessions older than itself: when a row carries `createdAt`, rollouts
 * that began more than 1 s before the earliest one are not checked (a row is created a few ms after its id's time) (`beforeIndex`; without any `createdAt` every rollout is).
 * `createdAt` is an absolute time and a file name a local one, so a rollout's start — for the 10-min rule too — is read
 * on one clock: its id's time (`uuidTs`) where it has one, else its file name's (`fileTs`). When every rollout began
 * before the index: n/a, reason `before-index`. A pass needs at least 5 rollouts checked; fewer, none missing: n/a
 * (`too-few`). `n`: the rollouts checked; `values`: `missing`, `rollouts` (checked),
 * `beforeIndex`.
 */
function checkThreadRows(s: ForensicScope, now: number): CheckResult {
  const rollouts = s.rollouts().filter((r) => {
    const began = r.uuidTs ?? r.fileTs;
    return began === undefined || began < now - RECENT_MS;
  });
  const rows = s.threadRows();
  const tools = toolsOf([...rollouts, ...rows]);
  const indexed = s.coverage().some((c) => c.source === THREADS_SOURCE && (c.status === "ok" || c.status === "drift") && c.records > 0);
  if (!indexed) return { id: "C6", status: "n/a", n: rollouts.length, reason: "no-thread-index", values: {}, tools };
  if (rollouts.length === 0) return { id: "C6", status: "n/a", n: 0, reason: "no-rollouts", values: {}, tools };
  let since = Infinity;
  for (const r of rows) if (r.createdAt !== undefined && r.createdAt < since) since = r.createdAt;
  if (since === Infinity) since = -Infinity; // no row carries a creation time: every rollout is checked
  // the index's first row may be created a few ms after its own rollout's id time: allow the second the names keep
  const checked = rollouts.filter((r) => {
    const began = r.uuidTs ?? r.fileTs;
    return began === undefined || began >= since - ID_TOL_MS;
  });
  const beforeIndex = rollouts.length - checked.length;
  if (checked.length === 0) return { id: "C6", status: "n/a", n: 0, reason: "before-index", values: { beforeIndex }, tools };
  const have = new Set(rows.map((r) => r.threadId));
  const missing = checked.filter((r) => !have.has(r.threadId)).length;
  const base = { id: "C6" as const, n: checked.length, values: { missing, rollouts: checked.length, beforeIndex } satisfies CheckValues, tools };
  if (missing === 0) return { ...base, status: checked.length >= MIN_PASS ? "pass" : "n/a", reason: checked.length >= MIN_PASS ? "ok" : "too-few" };
  // never a fail: sessions made on another machine and copied in have no row in this machine's index
  const fail = missing >= Math.max(MISSING_MIN, MISSING_SHARE * checked.length);
  return { ...base, status: fail ? "warn" : "note", reason: "missing-thread-rows" };
}

/**
 * A positive offset that is a whole number of quarter hours (1 to 104, up to 26 h): the zone changed since the file was
 * named. The rest may be up to 2 s above the quarter hour, and up to a minute below it: a file named some seconds after
 * its id's time passes unshifted, so it does shifted too. (Unshifted, a name after the id has no bound at all; a shift
 * needs one to be told from an id simply later than its name.)
 */
function isZoneShift(d: number): boolean {
  const q = Math.ceil((d - ZONE_TOL_MS) / QUARTER_MS);
  const rest = d - q * QUARTER_MS;
  return q >= 1 && q <= ZONE_MAX_QUARTERS && rest <= ZONE_TOL_MS && rest >= -ZONE_LAG_MS;
}

/**
 * C7, the thread id's UUIDv7 time is not after the file name's time. The name is local time truncated to the second,
 * so `uuidTs − fileTs` up to 1 s is allowed; more is a violation, unless it is a time-zone change (`isZoneShift`: the
 * name was written in another zone than the one it is read in now), which is a note. Violations: at least max(2, 1% of
 * the rollouts) → fail, fewer → note (one renamed file proves nothing). n/a without a rollout that has both times; a
 * pass needs at least 5 of them (fewer, nothing found: n/a `too-few`).
 */
function checkIdTimes(s: ForensicScope): CheckResult {
  const rollouts = s.rollouts().filter((r) => r.uuidTs !== undefined && r.fileTs !== undefined);
  const tools = toolsOf(rollouts);
  if (rollouts.length === 0) return { id: "C7", status: "n/a", n: 0, reason: "no-data", values: {}, tools };
  let violations = 0, zoneShifted = 0;
  for (const r of rollouts) {
    const d = r.uuidTs! - r.fileTs!;
    if (d <= ID_TOL_MS) continue;
    if (isZoneShift(d)) zoneShifted++;
    else violations++;
  }
  const base = { id: "C7" as const, n: rollouts.length, values: { violations, zoneShifted } satisfies CheckValues, tools };
  if (violations > 0) {
    const fail = violations >= Math.max(MISSING_MIN, MISSING_SHARE * rollouts.length);
    return { ...base, status: fail ? "fail" : "note", reason: "uuid-after-name" };
  }
  if (zoneShifted > 0) return { ...base, status: "note", reason: "time-zone-change" };
  if (rollouts.length < MIN_PASS) return { ...base, status: "n/a", reason: "too-few" };
  return { ...base, status: "pass", reason: "ok" };
}

/** One reset window being followed: its reset time (the latest snapshot's) and its latest snapshot. */
interface Open { resetsAt: number; last: RateLimitEv; drops: number }

/**
 * The pairs, counted drops and readings of one ledger (one bucket and window), in time order (equal times: lower reading
 * first). A snapshot with `resetsAt` pairs with the latest snapshot of the open reset window whose reset time is within
 * 60 s of its own (the nearest one), else opens a new window; windows whose reset time has passed close. A snapshot
 * without `resetsAt` is never paired: nothing tells which window it belongs to (`readings` counts only those with one).
 * A drop is a pair whose reading falls by more than 2 points, and counts only when the lower reading is stamped more
 * than 10 min after the higher one: two sessions of one account at once each log a reading when their own response
 * ends, so their readings interleave within minutes.
 */
function ledgerPairs(snaps: RateLimitEv[]): { pairs: number; contradictions: number; readings: number } {
  snaps.sort((a, b) => a.ts - b.ts || a.usedPercent - b.usedPercent);
  let pairs = 0, readings = 0;
  const windows: Open[] = [];
  let open: Open[] = [];
  for (const s of snaps) {
    if (s.resetsAt === undefined) continue;
    readings++;
    open = open.filter((w) => w.resetsAt + RESET_TOL_MS >= s.ts);
    let best: Open | undefined;
    for (const w of open) {
      const d = Math.abs(w.resetsAt - s.resetsAt);
      if (d <= RESET_TOL_MS && (best === undefined || d < Math.abs(best.resetsAt - s.resetsAt))) best = w;
    }
    if (best) {
      pairs++;
      if (best.last.usedPercent - s.usedPercent > DROP_POINTS && s.ts - best.last.ts > DROP_GAP_MS) best.drops++;
      best.last = s;
      best.resetsAt = s.resetsAt;
    } else {
      const w = { resetsAt: s.resetsAt, last: s, drops: 0 };
      open.push(w);
      windows.push(w);
    }
  }
  const contradictions = windows.reduce((a, w) => a + w.drops, 0);
  return { pairs, contradictions, readings };
}

/**
 * C8, the usage-limit ledger only rises within one reset window, per (bucket, window) ledger (`ledgerPairs`). `values`:
 * `pairs`, `contradictions` (the counted drops). n/a under 20 pairs; at least max(3, 1% of the readings) counted drops →
 * fail; fewer, but at least 1 → note (a reset on the service's side, or a second machine). `n`: the pairs.
 */
function checkLedger(s: ForensicScope): CheckResult {
  const all = s.rateLimits();
  const tools = toolsOf(all);
  const ledgers = new Map<string, RateLimitEv[]>();
  for (const e of all) {
    const key = `${e.tool}|${e.bucket ?? ""}|${e.window}`;
    const list = ledgers.get(key);
    if (list) list.push(e);
    else ledgers.set(key, [e]);
  }
  let pairs = 0, contradictions = 0, readings = 0;
  for (const list of ledgers.values()) {
    const r = ledgerPairs(list);
    pairs += r.pairs;
    contradictions += r.contradictions;
    readings += r.readings;
  }
  const base = { id: "C8" as const, n: pairs, values: { pairs, contradictions } satisfies CheckValues, tools };
  if (pairs < MIN_PAIRS) return { ...base, status: "n/a", reason: "too-few" };
  if (contradictions >= Math.max(FAIL_MIN, FAIL_SHARE * readings)) return { ...base, status: "fail", reason: "ledger-contradictions" };
  if (contradictions > 0) return { ...base, status: "note", reason: "ledger-contradictions" };
  return { ...base, status: "pass", reason: "ok" };
}

/**
 * C6 (thread rows), C7 (id times) and C8 (the usage-limit ledger) over Codex's records in scope: rollouts by their
 * start and their session, thread rows by `createdAt`, usage-limit readings by `ts` (`ForensicScope`).
 */
export function checkRollouts(raw: ScanResult, t: SessionTable, o: { now: number }, s: ForensicScope = forensicScope(raw, t)): [CheckResult, CheckResult, CheckResult] {
  return [asked(checkThreadRows(s, o.now)), asked(checkIdTimes(s)), asked(checkLedger(s))];
}
