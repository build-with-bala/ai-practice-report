import type { RateLimitEv } from "../model/events";
import type { ScanResult } from "../scan";
import { THREADS_SOURCE } from "../sources/codex/indexdb";
import { toolsOf, type CheckResult } from "./types";

/*
 * C6–C8: Codex's own records agree with each other. The CLI enters every thread it starts in its thread index, names
 * each rollout file after the local time it began, mints the thread id as a UUIDv7 carrying that same moment, and logs
 * the account's usage-limit readings, which only rise within one limit window. A rollout copied in from elsewhere has no
 * index row, a renamed one no longer fits its id, and two accounts' traces spliced together make the readings fall.
 */

const RECENT_MS = 10 * 60_000;
const MISSING_MIN = 2;
const MISSING_SHARE = 0.01;
const ID_TOL_MS = 1_000;
const QUARTER_MS = 15 * 60_000;
const ZONE_TOL_MS = 2_000;
const ZONE_MAX_QUARTERS = 56;   // 14 h
const RESET_TOL_MS = 60_000;
const DROP_POINTS = 2;
const MIN_PAIRS = 20;
const FAIL_MIN = 3;
const FAIL_SHARE = 0.005;

/**
 * C6, every rollout has a thread-index row (by `threadId`). Rollouts named at or after 10 min before `now` are left out:
 * the CLI may not have written their row yet. n/a without a read thread index (coverage of `codex.threads` `ok` or
 * `drift` with records), or without rollouts. Rollouts missing their row: at least max(2, 1% of the rollouts checked) →
 * fail; fewer, but at least 1 → note with the same question (a genuine machine can hold a stray one). `n`: the
 * rollouts checked; `values`: `missing`, `rollouts`.
 */
function checkThreadRows(raw: ScanResult, now: number): CheckResult {
  const rollouts = raw.store.all("codex-rollout").filter((r) => r.fileTs === undefined || r.fileTs < now - RECENT_MS);
  const rows = raw.store.all("codex-thread-row");
  const tools = toolsOf([...rollouts, ...rows]);
  const indexed = raw.coverage.some((c) => c.source === THREADS_SOURCE && (c.status === "ok" || c.status === "drift") && c.records > 0);
  if (!indexed) return { id: "C6", status: "n/a", n: rollouts.length, reason: "no-thread-index", values: {}, tools };
  if (rollouts.length === 0) return { id: "C6", status: "n/a", n: 0, reason: "no-rollouts", values: {}, tools };
  const have = new Set(rows.map((r) => r.threadId));
  const missing = rollouts.filter((r) => !have.has(r.threadId)).length;
  const base = { id: "C6" as const, n: rollouts.length, values: { missing, rollouts: rollouts.length }, tools };
  if (missing === 0) return { ...base, status: "pass", reason: "ok" };
  const fail = missing >= Math.max(MISSING_MIN, MISSING_SHARE * rollouts.length);
  return { ...base, status: fail ? "fail" : "note", reason: "missing-thread-rows",
    askAbout: `${missing} Codex session ${missing === 1 ? "file has" : "files have"} no entry in Codex's own thread index. Were session files copied in from somewhere else?` };
}

/** A positive offset that is a whole number of quarter hours (1 to 56, within 2 s): the zone changed since the file was named. */
function isZoneShift(d: number): boolean {
  const q = Math.round(d / QUARTER_MS);
  return q >= 1 && q <= ZONE_MAX_QUARTERS && Math.abs(d - q * QUARTER_MS) <= ZONE_TOL_MS;
}

/**
 * C7, the thread id's UUIDv7 time is not after the file name's time. The name is local time truncated to the second,
 * so `uuidTs − fileTs` up to 1 s is allowed; more is a violation, unless it is a time-zone change (`isZoneShift`: the
 * name was written in another zone than the one it is read in now), which is a note. Any violation → fail. n/a without
 * a rollout that has both times.
 */
function checkIdTimes(raw: ScanResult): CheckResult {
  const rollouts = raw.store.all("codex-rollout").filter((r) => r.uuidTs !== undefined && r.fileTs !== undefined);
  const tools = toolsOf(rollouts);
  if (rollouts.length === 0) return { id: "C7", status: "n/a", n: 0, reason: "no-data", values: {}, tools };
  let violations = 0, zoneShifted = 0;
  for (const r of rollouts) {
    const d = r.uuidTs! - r.fileTs!;
    if (d <= ID_TOL_MS) continue;
    if (isZoneShift(d)) zoneShifted++;
    else violations++;
  }
  const base = { id: "C7" as const, n: rollouts.length, values: { violations, zoneShifted }, tools };
  if (violations > 0) {
    return { ...base, status: "fail", reason: "uuid-after-name",
      askAbout: `${violations} Codex session ${violations === 1 ? "id carries a time later than its file name" : "ids carry a time later than their file names"}, by more than a second. Were session files renamed, or their ids edited?` };
  }
  if (zoneShifted > 0) {
    return { ...base, status: "note", reason: "time-zone-change",
      askAbout: `${zoneShifted} Codex session ${zoneShifted === 1 ? "file is" : "files are"} named in a different time zone from this machine's current one. Did the time zone change, or were the files made on another machine?` };
  }
  return { ...base, status: "pass", reason: "ok" };
}

/** One reset window being followed: its reset time (the latest snapshot's) and its latest snapshot. */
interface Open { resetsAt: number; last: RateLimitEv }

/**
 * The pairs and contradictions of one ledger (one bucket and window), in time order (equal times: lower reading first).
 * A snapshot with `resetsAt` pairs with the latest snapshot of the open reset window whose reset time is within 60 s of
 * its own (the nearest one), else opens a new window; windows whose reset time has passed close. A snapshot without
 * `resetsAt` pairs with the previous such snapshot when both name the same `windowMinutes` and lie less than that apart.
 * A pair is a contradiction when the reading drops by more than 2 points.
 */
function ledgerPairs(snaps: RateLimitEv[]): { pairs: number; contradictions: number } {
  snaps.sort((a, b) => a.ts - b.ts || a.usedPercent - b.usedPercent);
  let pairs = 0, contradictions = 0;
  let open: Open[] = [];
  let prev: RateLimitEv | undefined;
  const pair = (a: RateLimitEv, b: RateLimitEv): void => {
    pairs++;
    if (a.usedPercent - b.usedPercent > DROP_POINTS) contradictions++;
  };
  for (const s of snaps) {
    if (s.resetsAt === undefined) {
      if (prev && s.windowMinutes !== undefined && prev.windowMinutes === s.windowMinutes && s.ts - prev.ts < s.windowMinutes * 60_000) pair(prev, s);
      prev = s;
      continue;
    }
    open = open.filter((w) => w.resetsAt + RESET_TOL_MS >= s.ts);
    let best: Open | undefined;
    for (const w of open) {
      const d = Math.abs(w.resetsAt - s.resetsAt);
      if (d <= RESET_TOL_MS && (best === undefined || d < Math.abs(best.resetsAt - s.resetsAt))) best = w;
    }
    if (best) {
      pair(best.last, s);
      best.last = s;
      best.resetsAt = s.resetsAt;
    } else open.push({ resetsAt: s.resetsAt, last: s });
  }
  return { pairs, contradictions };
}

/**
 * C8, the usage-limit ledger only rises within one reset window, per (bucket, window) ledger (`ledgerPairs`). n/a under
 * 20 pairs; at least 3 contradictions and more than 0.5% of the pairs → fail. `n`: the pairs.
 */
function checkLedger(raw: ScanResult): CheckResult {
  const all = raw.store.all("ratelimit");
  const tools = toolsOf(all);
  const ledgers = new Map<string, RateLimitEv[]>();
  for (const e of all) {
    const key = `${e.tool}|${e.bucket ?? ""}|${e.window}`;
    const list = ledgers.get(key);
    if (list) list.push(e);
    else ledgers.set(key, [e]);
  }
  let pairs = 0, contradictions = 0;
  for (const list of ledgers.values()) {
    const r = ledgerPairs(list);
    pairs += r.pairs;
    contradictions += r.contradictions;
  }
  const base = { id: "C8" as const, n: pairs, values: { pairs, contradictions }, tools };
  if (pairs < MIN_PAIRS) return { ...base, status: "n/a", reason: "too-few" };
  if (contradictions >= FAIL_MIN && contradictions > FAIL_SHARE * pairs) {
    return { ...base, status: "fail", reason: "ledger-contradictions",
      askAbout: `The usage-limit readings fell ${contradictions} times within one limit window, where they only rise. Were traces from more than one account combined here?` };
  }
  return { ...base, status: "pass", reason: "ok" };
}

/** C6 (thread rows), C7 (id times) and C8 (the usage-limit ledger) over Codex's records. */
export function checkRollouts(raw: ScanResult, o: { now: number }): [CheckResult, CheckResult, CheckResult] {
  return [checkThreadRows(raw, o.now), checkIdTimes(raw), checkLedger(raw)];
}
