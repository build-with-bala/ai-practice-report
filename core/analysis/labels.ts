import type { ToolId } from "../model/ids";
import { keyedHash } from "../text/hash";
import { dayKey, isoWeek } from "./activity";
import { isTopLevel, type SessionTable } from "./types";

/**
 * One project (a projectKey of kept rows): `sessions` = its top-level kept sessions (`isTopLevel`, no host copy);
 * `activeWeeks` = the distinct ISO weeks in which one of its human top-level sessions started; `tools` (sorted) = the
 * tools of those sessions; `inRepo` = its projectKey lies in a repo of the repo signals; `lastWeek` = the ISO week of
 * its latest session end (clipped to the date range). Keys are keyed hashes and labels opaque (spec §6.7).
 */
export interface ProjectSummary { key: string; label: string; sessions: number; activeWeeks: number; tools: ToolId[]; inRepo: boolean; lastWeek?: string }

/** Label lengths, in hex digits: the shortest at which a key's label is unique is used. */
const LENGTHS = [4, 6, 8, 10, 12, 14, 16] as const;
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Opaque project labels: "P-" + upper-case hex digits of keyedHash(salt, "label:" + key). A key's label has the
 * shortest of 4, 6, 8, … 16 digits at which no other key of `keys` has the same label (the digits are prefixes of one
 * hash, so a label unique at one length stays unique at every longer one, and labels of different lengths never
 * match): every label names one project. Two different keys that still collide at 16 digits throw a RangeError.
 * Deterministic for a salt, whatever the keys' order. `hashOf` is the hash (a seam for tests).
 */
export function projectLabels(salt: Uint8Array, keys: Iterable<string>,
  hashOf: (key: string) => string = (key) => keyedHash(salt, `label:${key}`)): Map<string, string> {
  const distinct = [...new Set(keys)].sort(cmp);
  const hex = new Map(distinct.map((k) => [k, hashOf(k).toUpperCase()]));
  const out = new Map<string, string>();
  let left = distinct;
  for (const len of LENGTHS) {
    const count = new Map<string, number>();
    for (const k of distinct) {
      const l = hex.get(k)!.slice(0, len);
      count.set(l, (count.get(l) ?? 0) + 1);
    }
    const clash: string[] = [];
    for (const k of left) {
      const l = hex.get(k)!.slice(0, len);
      if (count.get(l)! > 1) clash.push(k);
      else out.set(k, `P-${l}`);
    }
    left = clash;
    if (left.length === 0) return out;
  }
  throw new RangeError("projectLabels: two project keys share a label at 16 hex digits");
}

/**
 * The projects of the session table, most sessions first (then by label). Every projectKey must have a label in
 * `labels` (`projectLabels` over the table's keys): a missing one is a caller error.
 */
export function projects(t: SessionTable, labels: Map<string, string>): ProjectSummary[] {
  interface Acc { sessions: number; weeks: Set<string>; tools: Set<ToolId>; lastEnd: number }
  const acc = new Map<string, Acc>();
  for (const r of t.rows.values()) {
    if (r.projectKey === undefined || !isTopLevel(r) || t.hosts.has(r.id)) continue;
    let a = acc.get(r.projectKey);
    if (!a) acc.set(r.projectKey, (a = { sessions: 0, weeks: new Set(), tools: new Set(), lastEnd: -Infinity }));
    a.sessions++;
    a.tools.add(r.tool);
    if (r.origin === "human") a.weeks.add(isoWeek(dayKey(Math.max(r.start, t.scope.from), t.timeZone)));
    a.lastEnd = Math.max(a.lastEnd, Math.min(r.end, t.scope.to));
  }
  const out: ProjectSummary[] = [];
  for (const [key, a] of acc) {
    const label = labels.get(key);
    if (label === undefined) throw new RangeError("projects: a project key has no label");
    const p: ProjectSummary = { key, label, sessions: a.sessions, activeWeeks: a.weeks.size, tools: [...a.tools].sort(cmp), inRepo: t.repoOf.has(key) };
    if (Number.isFinite(a.lastEnd)) p.lastWeek = isoWeek(dayKey(a.lastEnd, t.timeZone));
    out.push(p);
  }
  return out.sort((x, y) => y.sessions - x.sessions || cmp(x.label, y.label));
}
