import type { ToolId } from "../model/ids";
import { keyedHash } from "../text/hash";
import { dayKey, isoWeek } from "./activity";
import type { SessionTable } from "./types";

/**
 * One project (a projectKey of kept rows): `sessions` = its top-level kept sessions (no parent, no host copy);
 * `activeWeeks` = the distinct ISO weeks in which one of its human top-level sessions started; `tools` (sorted) = the
 * tools of those sessions; `inRepo` = its projectKey lies in a repo of the repo signals; `lastWeek` = the ISO week of
 * its latest session end (clipped to the date range). Keys are keyed hashes and labels opaque (spec §6.7).
 */
export interface ProjectSummary { key: string; label: string; sessions: number; activeWeeks: number; tools: ToolId[]; inRepo: boolean; lastWeek?: string }

const SHORT = 4;
const LONG = 6;
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const labelOf = (salt: Uint8Array, key: string, len: number): string => `P-${keyedHash(salt, `label:${key}`, len).toUpperCase()}`;

/**
 * Opaque project labels: "P-" + the upper-case first 4 hex of keyedHash(salt, "label:" + key); keys whose 4-hex labels
 * collide take 6 hex instead. Deterministic for a salt, whatever the keys' order.
 */
export function projectLabels(salt: Uint8Array, keys: Iterable<string>): Map<string, string> {
  const distinct = [...new Set(keys)].sort(cmp);
  const short = new Map<string, number>();
  for (const k of distinct) {
    const l = labelOf(salt, k, SHORT);
    short.set(l, (short.get(l) ?? 0) + 1);
  }
  const out = new Map<string, string>();
  for (const k of distinct) {
    const l = labelOf(salt, k, SHORT);
    out.set(k, short.get(l)! > 1 ? labelOf(salt, k, LONG) : l);
  }
  return out;
}

/**
 * The projects of the session table, most sessions first (then by label). Every projectKey must have a label in
 * `labels` (`projectLabels` over the table's keys): a missing one is a caller error.
 */
export function projects(t: SessionTable, labels: Map<string, string>): ProjectSummary[] {
  interface Acc { sessions: number; weeks: Set<string>; tools: Set<ToolId>; lastEnd: number }
  const acc = new Map<string, Acc>();
  for (const r of t.rows.values()) {
    if (r.projectKey === undefined || r.parentId !== undefined || t.hosts.has(r.id)) continue;
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
