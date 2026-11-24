import type { RepoSignals } from "../../core/git/types";
import type { Ev } from "../../core/model/events";
import { EventStore } from "../../core/model/store";
import type { ScanResult } from "../../core/scan";

/** The latest time any event names (0 without one): the default `finishedAt`, so a synthetic result needs no clock. */
function latest(events: readonly Ev[]): number {
  let t = 0;
  for (const e of events) {
    const x = e as { ts?: number; end?: number; mtime?: number };
    for (const v of [x.ts, x.end, x.mtime]) if (v !== undefined && v > t) t = v;
  }
  return t;
}

/**
 * A ScanResult made of `events`, for analysis tests: the events go into a store in order (sessions merge as in a scan),
 * the coverage is the coverage events among them, there are no warnings, and repo signals are `off` unless `repos` is
 * given. `finishedAt` (and `startedAt`) default to the latest event time.
 */
export function scanResultOf(events: Ev[], o: { repos?: RepoSignals; cwds?: Map<string, string>; salt?: Uint8Array; finishedAt?: number } = {}): ScanResult {
  const store = new EventStore();
  for (const e of events) store.add(e);
  const finishedAt = o.finishedAt ?? latest(events);
  return {
    store, coverage: [...store.all("coverage")], warnings: [], cwds: o.cwds ?? new Map(), salt: o.salt ?? new Uint8Array(32),
    startedAt: finishedAt, finishedAt, tempClean: true,
    repos: o.repos ?? { status: "off", repos: [], roots: new Map(), skipped: {}, ms: 0 },
  };
}
