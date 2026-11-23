import { dayKey } from "../analysis/activity";
import type { SessionTable } from "../analysis/types";
import type { FileFactEv } from "../model/events";
import type { ScanResult } from "../scan";
import { forensicScope, type ForensicScope } from "./scope";
import { toolsOf, type CheckResult } from "./types";

/*
 * C5: the trace files' own times agree with the events inside them. A file the tool wrote was last modified at or after
 * its last event, and its status change (ctime) follows its last write closely. A history copied or restored in one go
 * shows instead as most files born within minutes of each other although their events span weeks: that is not
 * tampering, but worth asking about, and it explains a ctime far after the mtime.
 */

const MIN_FILES = 5;
const MTIME_TOL_MS = 2_000;
const CTIME_GAP_MS = 24 * 3_600_000;
const WINDOW_MS = 10 * 60_000;
const CLUSTER_SHARE = 0.8;
const CLUSTER_SPAN_MS = 7 * 86_400_000;
const FAIL_SHARE = 0.01;
const FAIL_MIN = 2;
const DAY_MS = 86_400_000;
const BULK_MIN = 5;
const BULK_SHARE = 0.1;

interface Cluster { files: Set<FileFactEv>; start: number; spanMs: number }

/**
 * The restore cluster: the 10-min window holding the most file births (birth, else ctime), when it holds at least 80%
 * of the files and those files' events span more than 7 days.
 */
function restoreCluster(files: readonly FileFactEv[]): Cluster | undefined {
  const born = files.flatMap((f) => {
    const b = f.birth ?? f.ctime;
    return b === undefined ? [] : [{ f, b }];
  }).sort((x, y) => x.b - y.b);
  const { from: bestAt, count: best } = densest(born, (x) => x.b);
  if (best === 0 || best < CLUSTER_SHARE * files.length) return undefined;
  const members = born.slice(bestAt, bestAt + best);
  let from = Infinity, to = -Infinity;
  for (const { f } of members) {
    const first = f.firstTs ?? f.lastTs, last = f.lastTs ?? f.firstTs;
    if (first !== undefined) from = Math.min(from, first);
    if (last !== undefined) to = Math.max(to, last);
  }
  if (!(to - from > CLUSTER_SPAN_MS)) return undefined;
  return { files: new Set(members.map((m) => m.f)), start: members[0]!.b, spanMs: to - from };
}

/** The most items whose time lies in one 10-min window: the window's first index and count (0 for none). */
function densest<T>(sorted: readonly T[], at: (x: T) => number): { from: number; count: number } {
  let count = 0, from = 0;
  for (let i = 0, j = 0; i < sorted.length; i++) {
    while (at(sorted[j]!) <= at(sorted[i]!) - WINDOW_MS) j++;
    if (i - j + 1 > count) {
      count = i - j + 1;
      from = j;
    }
  }
  return { from, count };
}

/**
 * Bulk changes: tools that keep creation dates (a system migration, a backup restore, a file-manager copy) keep birth and
 * mtime and set ctime to the copy time, so a genuine history then has many files whose ctime is far after their mtime,
 * all within minutes. Of `gapped` (those files), every 10-min ctime window holding at least max(5, 10% of all files),
 * largest first, without overlap (each window's files leave the pool before the next is sought).
 */
function bulkWindows(gapped: readonly FileFactEv[], total: number): { start: number; files: FileFactEv[] }[] {
  const min = Math.max(BULK_MIN, BULK_SHARE * total);
  let pool = [...gapped].sort((x, y) => x.ctime! - y.ctime!);
  const out: { start: number; files: FileFactEv[] }[] = [];
  for (;;) {
    const { from, count } = densest(pool, (f) => f.ctime!);
    if (count === 0 || count < min) return out;
    const files = pool.slice(from, from + count);
    out.push({ start: files[0]!.ctime!, files });
    pool = [...pool.slice(0, from), ...pool.slice(from + count)];
  }
}

/**
 * C5 over the trace files' facts in scope (`ForensicScope.files`: kept tools, and files whose events overlap the date
 * range or that have no event times). A file violates when its mtime is more than 2 s before its last event, or its
 * ctime more than 24 h after its mtime — unless it is in the restore cluster or in a bulk-change window. Fewer than 5
 * files → n/a; at least max(2, 1% of the files) violating → fail; else a restore cluster → note with its local day
 * (`date`) in `timeZone`; else a bulk-change window → note with the largest window's local day (`date`) and its file
 * count (`bulkFiles`).
 */
export function checkFileTimes(raw: ScanResult, t: SessionTable, o: { timeZone: string }, s: ForensicScope = forensicScope(raw, t)): CheckResult {
  const files = s.files();
  const tools = toolsOf(files);
  if (files.length < MIN_FILES) return { id: "C5", status: "n/a", n: files.length, reason: "too-few", values: {}, tools };
  const cluster = restoreCluster(files);
  const gapped = files.filter((f) => f.ctime !== undefined && f.ctime - f.mtime > CTIME_GAP_MS && !cluster?.files.has(f));
  const bulk = bulkWindows(gapped, files.length);
  const inBulk = new Set(bulk.flatMap((w) => w.files));
  const ctimeViolators = new Set(gapped.filter((f) => !inBulk.has(f)));
  const violations = files.filter((f) => (f.lastTs !== undefined && f.mtime < f.lastTs - MTIME_TOL_MS) || ctimeViolators.has(f)).length;
  const values: Record<string, number | string> = { violations };
  const base = { id: "C5" as const, n: files.length, tools };
  if (cluster) {
    values.date = dayKey(cluster.start, o.timeZone);
    values.days = Math.round(cluster.spanMs / DAY_MS);
    values.clusterFiles = cluster.files.size;
  } else if (bulk.length > 0) {
    values.date = dayKey(bulk[0]!.start, o.timeZone);
    values.bulkFiles = bulk[0]!.files.length;
  }
  if (violations >= Math.max(FAIL_MIN, FAIL_SHARE * files.length)) {
    return { ...base, status: "fail", reason: "file-times", values,
      askAbout: `${violations} trace files have file times that do not fit the events inside them: last modified before their last event, or changed more than a day after their last write. Were trace files edited, or their times reset?` };
  }
  if (cluster) {
    return { ...base, status: "note", reason: "restore-cluster", values,
      askAbout: `Most trace files were created on ${values.date} although their activity spans ${values.days} days. Was this history copied or restored from a backup then?` };
  }
  if (bulk.length > 0) {
    return { ...base, status: "note", reason: "bulk-change", values,
      askAbout: `${values.bulkFiles} trace files were last changed on ${values.date} although their content is older. Was this history copied, restored or migrated then?` };
  }
  return { ...base, status: "pass", reason: "ok", values };
}
