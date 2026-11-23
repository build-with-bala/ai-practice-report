import { dayKey } from "../analysis/activity";
import type { FileFactEv } from "../model/events";
import type { ScanResult } from "../scan";
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
  let best = 0, bestAt = 0;
  for (let i = 0, j = 0; i < born.length; i++) {
    while (born[j]!.b <= born[i]!.b - WINDOW_MS) j++;
    if (i - j + 1 > best) {
      best = i - j + 1;
      bestAt = j;
    }
  }
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

/**
 * C5 over every trace file's facts. A file violates when its mtime is more than 2 s before its last event, or its
 * ctime more than 24 h after its mtime (unless it is in the restore cluster). Fewer than 5 files → n/a; at least
 * max(2, 1% of the files) violating → fail; else a restore cluster → note with its local day (`date`) in `timeZone`.
 */
export function checkFileTimes(raw: ScanResult, o: { timeZone: string }): CheckResult {
  const files = raw.store.all("file");
  const tools = toolsOf(files);
  if (files.length < MIN_FILES) return { id: "C5", status: "n/a", n: files.length, reason: "too-few", values: {}, tools };
  const cluster = restoreCluster(files);
  const violations = files.filter((f) => (f.lastTs !== undefined && f.mtime < f.lastTs - MTIME_TOL_MS)
    || (f.ctime !== undefined && f.ctime - f.mtime > CTIME_GAP_MS && !cluster?.files.has(f))).length;
  const values: Record<string, number | string> = { violations };
  const base = { id: "C5" as const, n: files.length, tools };
  if (cluster) {
    values.date = dayKey(cluster.start, o.timeZone);
    values.days = Math.round(cluster.spanMs / DAY_MS);
    values.clusterFiles = cluster.files.size;
  }
  if (violations >= Math.max(FAIL_MIN, FAIL_SHARE * files.length)) {
    return { ...base, status: "fail", reason: "file-times", values,
      askAbout: `${violations} trace files have file times that do not fit the events inside them: last modified before their last event, or changed more than a day after their last write. Were trace files edited, or their times reset?` };
  }
  if (cluster) {
    return { ...base, status: "note", reason: "restore-cluster", values,
      askAbout: `Most trace files were created on ${values.date} although their activity spans ${values.days} days. Was this history copied or restored from a backup then?` };
  }
  return { ...base, status: "pass", reason: "ok", values };
}
