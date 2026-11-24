import { dayKey } from "../analysis/activity";
import type { SessionTable } from "../analysis/types";
import type { FileFactEv } from "../model/events";
import type { ScanResult } from "../scan";
import { forensicScope, type ForensicScope } from "./scope";
import { asked } from "./questions";
import { toolsOf, type CheckResult, type CheckValues } from "./types";

/*
 * C5: the trace files' own times agree with the events inside them. A file the tool wrote was last modified at or after
 * its last event, so a file holding an event later than its own last write was edited and had its time set back.
 *
 * What the check can see: a file's last write (mtime), its change time (ctime), its birth, and the times of the events
 * inside it. What it cannot see: an edit that leaves those times alone (or sets the last write after the last event)
 * passes. A change time later than the last write is no evidence of an edit: renaming, archiving, syncing, restoring a
 * backup and permission or extended-attribute changes all move the change time and leave the last write alone. So it
 * is only ever a note, asking which of those happened. A history copied or restored in one go shows instead as most
 * files born within minutes of each other although their events span weeks: also a note, with its day.
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
 * C5 over the trace files' facts in scope (`ForensicScope.files`). Fewer than 5 files → n/a (`too-few`).
 * - Last-write rule: a file violates when its mtime is more than 2 s before its last event. A file whose last event is
 *   between the scan's start and its end (`raw.startedAt` to `raw.finishedAt`, plus 2 s) is still being written (a
 *   file is stat'ed before it is read to its end) and is exempt; one dated after the scan's end is not. At least max(2, 1% of the files) violating → fail (`file-times`, `violations`).
 * - Else a restore cluster → note (`restore-cluster`) with its local day (`date`) in `timeZone`, its span (`days`) and
 *   its files (`clusterFiles`).
 * - Else files whose ctime is more than 24 h after their mtime, outside a restore cluster → note
 *   (`changed-after-write`), with their number (`changedFiles`) and the number in the 10-min ctime window holding the
 *   most of them (`bulkFiles`). Never more than a note: see the header.
 * - Else pass. `values` carries every part that was found, whichever decides.
 */
export function checkFileTimes(raw: ScanResult, t: SessionTable, o: { timeZone: string }, s: ForensicScope = forensicScope(raw, t)): CheckResult {
  const files = s.files();
  const tools = toolsOf(files);
  if (files.length < MIN_FILES) return { id: "C5", status: "n/a", n: files.length, reason: "too-few", values: {}, tools };
  const cluster = restoreCluster(files);
  const changed = files.filter((f) => f.ctime !== undefined && f.ctime - f.mtime > CTIME_GAP_MS && !cluster?.files.has(f))
    .sort((x, y) => x.ctime! - y.ctime!);
  // a file whose last event lies between the scan's start and its end is still being written; one dated after the
  // scan's end is not
  const writing = (last: number): boolean => last >= raw.startedAt && last <= raw.finishedAt + MTIME_TOL_MS;
  const violations = files.filter((f) => f.lastTs !== undefined && !writing(f.lastTs) && f.mtime < f.lastTs - MTIME_TOL_MS).length;
  const values: CheckValues = { violations };
  const base = { id: "C5" as const, n: files.length, tools };
  if (cluster) {
    values.date = dayKey(cluster.start, o.timeZone);
    values.days = Math.ceil(cluster.spanMs / DAY_MS); // a cluster spans more than 7 days: up
    values.clusterFiles = cluster.files.size;
  }
  if (changed.length > 0) {
    values.changedFiles = changed.length;
    values.bulkFiles = densest(changed, (f) => f.ctime!).count;
  }
  if (violations >= Math.max(FAIL_MIN, FAIL_SHARE * files.length)) {
    return asked({ ...base, status: "fail", reason: "file-times", values });
  }
  if (cluster) return asked({ ...base, status: "note", reason: "restore-cluster", values });
  if (changed.length > 0) return asked({ ...base, status: "note", reason: "changed-after-write", values });
  return { ...base, status: "pass", reason: "ok", values };
}
