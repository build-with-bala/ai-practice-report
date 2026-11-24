import type { SessionTable } from "../analysis/types";
import type { SessionStats } from "../analysis/walk";
import type { ToolId } from "../model/ids";
import type { ScanResult } from "../scan";
import { checkAnchors } from "./anchors";
import { checkAccount, checkClaudeHistory } from "./claude";
import { checkRollouts } from "./codex";
import { checkFileTimes } from "./files";
import { provenance } from "./provenance";
import { checkReleases, RELEASES, type ReleaseTable } from "./releases";
import { forensicScope, type ForensicScope } from "./scope";
import { softFlags } from "./soft";
import { asked } from "./questions";
import { REASONS, round, VALUE_KEYS, type CheckId, type CheckResult, type CheckValues } from "./types";

export type { ReleaseTable } from "./releases";
export { questionFor } from "./questions";
export { DATE_KEY, isDay, isValueOf, REASONS, VALUE_KEYS, VALUE_KINDS } from "./types";
export type { CheckId, CheckResult, CheckStatus, CheckValues, ProvenanceKey, Reason, ValueKey, ValueKind } from "./types";

/**
 * The integrity summary (spec §6.6). `band`: the verdict over every check (`bandOf`); `serverBacked`: the share of typed
 * turns from tools whose server-issued data checked out (display only: it never changes a score, an evidence minimum or
 * a confidence), null without typed turns. It is counted per tool: every typed turn of a tool whose server checks
 * passed counts, including turns of that tool's sessions that carry no server id themselves. A tool whose server
 * check carries a note (for example the note for unverified ids, `foreign-ids` or `malformed-ids`) still counts as
 * backed: a note passes the ids that could be checked. `anchorable` /
 * `notAnchorable`: the tools in scope that do or do not record server-issued data (neutral, never a penalty);
 * `checks`: C1–C10, then the soft flags, always in that order.
 */
export interface Forensics { band: "consistent" | "consistent-with-notes" | "inconsistent" | "unverifiable"; serverBacked: number | null;
  anchorable: ToolId[]; notAnchorable: ToolId[]; checks: CheckResult[] }

/**
 * The anchorable tools, the one list: each tool whose traces carry server-issued data, with the checks on that data
 * (`server`: they decide `serverBacked`, and a `consistent` band needs one of them to pass) and the checks on the tool's
 * own records (`own`). `ids`: the tool records server-issued ids on its turns (the `soft:missing-ids` note).
 */
const ANCHORS: readonly { tool: ToolId; server: readonly CheckId[]; own: readonly CheckId[]; ids: boolean }[] = [
  { tool: "claude-code", server: ["C1", "C2"], own: ["C3", "C4"], ids: true },
  { tool: "codex", server: ["C8"], own: ["C6", "C7"], ids: false },
];
const ANCHORABLE: ReadonlySet<ToolId> = new Set(ANCHORS.map((a) => a.tool));
/** The checks on server-issued data. */
const SERVER_CHECKS: ReadonlySet<CheckId> = new Set(ANCHORS.flatMap((a) => a.server));
/** The checks tied to an anchorable tool's data: its server data and its own records. */
const ANCHOR_CHECKS: ReadonlySet<CheckId> = new Set(ANCHORS.flatMap((a) => [...a.server, ...a.own]));
/** Typed turns of a tool that records server ids, in scope, above which having no id at all is worth a question. */
const MISSING_IDS_TURNS = 50;

/**
 * Ids that exist but cannot be verified: a C1 or C2 result that is n/a for a reason other than `too-few`, or that names
 * an unverified kind (`values.unverifiedKinds` > 0).
 */
const unverified = (c: CheckResult): boolean => (c.id === "C1" || c.id === "C2")
  && ((c.status === "n/a" && c.reason !== "too-few") || (typeof c.values.unverifiedKinds === "number" && c.values.unverifiedKinds > 0));

/**
 * The band over every result (never `worst()`, where n/a ranks below pass):
 * 1. any fail → `inconsistent`;
 * 2. else, when every check tied to an anchorable tool (C1–C4, C6–C8) is n/a → `unverifiable`, whatever C5, C9 or the
 *    soft flags say: nothing in the data can be held against what a server issued or a tool's own records;
 * 3. else any warn or note (a raised soft flag is a note), ids that exist but cannot be verified, or no pass among the
 *    checks on server-issued data (C1, C2, C8) → `consistent-with-notes`: a tool's local records alone can be written
 *    to agree with each other;
 * 4. else → `consistent`.
 */
export function bandOf(checks: readonly CheckResult[]): Forensics["band"] {
  if (checks.some((c) => c.status === "fail")) return "inconsistent";
  if (checks.every((c) => !ANCHOR_CHECKS.has(c.id) || c.status === "n/a")) return "unverifiable";
  if (checks.some((c) => c.status === "warn" || c.status === "note" || unverified(c))) return "consistent-with-notes";
  if (!checks.some((c) => SERVER_CHECKS.has(c.id) && c.status === "pass")) return "consistent-with-notes";
  return "consistent";
}

/**
 * soft:no-server-pass: n/a (`no-data`) when every check tied to an anchorable tool is n/a (the band is then
 * `unverifiable`); a pass when a check on server-issued data passed; else a note: what was checked rests on the tools'
 * local records alone. `tools`: the tools of the anchorable checks that measured something.
 */
function noServerPass(checks: readonly CheckResult[]): CheckResult {
  const measured = checks.filter((c) => ANCHOR_CHECKS.has(c.id) && c.status !== "n/a");
  const tools = [...new Set(measured.flatMap((c) => c.tools))].sort();
  if (measured.length === 0) return { id: "soft:no-server-pass", status: "n/a", n: 0, reason: "no-data", values: {}, tools };
  const passed = measured.some((c) => SERVER_CHECKS.has(c.id) && c.status === "pass");
  return asked({ id: "soft:no-server-pass", status: passed ? "pass" : "note", n: measured.length, reason: passed ? "ok" : "no-server-pass", values: {}, tools });
}

/**
 * soft:missing-ids: a tool that records server-issued ids on its turns (`ANCHORS[].ids`) with at least 50 typed turns
 * in scope and no id in scope at all → note (`missing-ids`, `turns`: those tools' typed turns): another provider or a
 * gateway writes no such ids. A pass when every such tool has ids; n/a when no such tool has 50 typed turns.
 */
function missingIds(s: ForensicScope, stats: readonly SessionStats[]): CheckResult {
  const turns = new Map<ToolId, number>();
  for (const x of stats) turns.set(x.tool, (turns.get(x.tool) ?? 0) + x.turns);
  const busy = ANCHORS.filter((a) => a.ids && (turns.get(a.tool) ?? 0) >= MISSING_IDS_TURNS).map((a) => a.tool);
  if (busy.length === 0) return { id: "soft:missing-ids", status: "n/a", n: 0, reason: "no-data", values: {}, tools: [] };
  const withIds = new Set(s.anchors().map((a) => a.tool));
  const bare = busy.filter((tool) => !withIds.has(tool));
  const n = busy.reduce((a, tool) => a + turns.get(tool)!, 0);
  if (bare.length === 0) return { id: "soft:missing-ids", status: "pass", n, reason: "ok", values: {}, tools: [...busy].sort() };
  const bareTurns = bare.reduce((a, tool) => a + turns.get(tool)!, 0);
  return asked({ id: "soft:missing-ids", status: "note", n, reason: "missing-ids", values: { turns: bareTurns } satisfies CheckValues, tools: [...bare].sort() });
}

/**
 * The closed vocabularies, checked at run time: every result's reason is in `REASONS` and every `values` key in
 * `VALUE_KEYS` (a values object built indirectly, e.g. with `Object.fromEntries`, escapes the compiler's check). A
 * result outside them is a programming error: it throws, naming only the check id.
 */
export function guardVocabulary(checks: readonly CheckResult[]): void {
  for (const c of checks) {
    if (!Object.hasOwn(REASONS, c.reason)) throw new Error(`forensics: ${c.id} holds a reason outside the closed list`);
    for (const k of Object.keys(c.values)) if (!Object.hasOwn(VALUE_KEYS, k)) throw new Error(`forensics: ${c.id} holds a value key outside the closed list`);
  }
}

/**
 * Every forensic check over a scan result, pure and synchronous: `now` and `timeZone` are the caller's; `releases`
 * defaults to the shipped table. Every check and soft flag reads in-scope data only, through one view of the scan
 * (`forensicScope`): the exclusions in `t` (tools, projects, the date range) and its host copies leave out what they
 * hit, so an exclusion never leaks what it excludes. The tools in scope are the kept rows' and the in-scope prompts'.
 * `stats` are the in-scope sessions' statistics (their typed turns).
 */
export function runForensics(raw: ScanResult, t: SessionTable, stats: readonly SessionStats[],
  o: { now: number; timeZone: string; releases?: ReleaseTable }): Forensics {
  const scope = forensicScope(raw, t);
  const [c1, c2] = checkAnchors(raw, t, scope);
  const [c6, c7, c8] = checkRollouts(raw, t, { now: o.now }, scope);
  const checks: CheckResult[] = [
    c1, c2, checkClaudeHistory(raw, t, scope), checkAccount(raw, t, scope), checkFileTimes(raw, t, { timeZone: o.timeZone }, scope), c6, c7, c8,
    checkReleases(t, o.releases ?? RELEASES, raw, scope), provenance(raw, t, scope), ...softFlags(raw, t, o, scope),
  ];
  checks.push(noServerPass(checks), missingIds(scope, stats));
  guardVocabulary(checks);
  const tools = scope.tools();

  const status = new Map(checks.map((c) => [c.id, c.status]));
  const backed = new Set(ANCHORS.filter((a) => a.server.every((id) => status.get(id) === "pass" || status.get(id) === "note")).map((a) => a.tool));
  let all = 0, server = 0;
  for (const st of stats) {
    all += st.turns;
    if (backed.has(st.tool)) server += st.turns;
  }

  return {
    band: bandOf(checks), serverBacked: all > 0 ? round(server / all) : null,
    anchorable: tools.filter((x) => ANCHORABLE.has(x)), notAnchorable: tools.filter((x) => !ANCHORABLE.has(x)), checks,
  };
}
