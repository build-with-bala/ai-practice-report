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
import { forensicScope } from "./scope";
import { softFlags } from "./soft";
import { round, type CheckResult } from "./types";

export type { ReleaseTable } from "./releases";
export { questionFor } from "./questions";
export { DATE_KEY, REASONS, VALUE_KEYS } from "./types";
export type { CheckId, CheckResult, CheckStatus, CheckValues, ProvenanceKey, Reason, ValueKey } from "./types";

/**
 * The integrity summary (spec §6.6). `band`: the verdict over every check; `serverBacked`: the share of typed turns
 * from tools whose server-minted data checked out (display only: it never changes a score, an evidence minimum or a
 * confidence), null without typed turns; `anchorable` / `notAnchorable`: the tools in scope that do or do not
 * record server-minted ids (neutral, never a penalty); `checks`: C1–C10, then the soft flags, always in that order.
 */
export interface Forensics { band: "consistent" | "consistent-with-notes" | "inconsistent" | "unverifiable"; serverBacked: number | null;
  anchorable: ToolId[]; notAnchorable: ToolId[]; checks: CheckResult[] }

/** Tools whose traces carry server-minted ids the checks verify: Claude Code (C1, C2) and Codex (C8). */
const ANCHORABLE: ReadonlySet<ToolId> = new Set<ToolId>(["claude-code", "codex"]);
const BACKING: readonly [ToolId, readonly CheckResult["id"][]][] = [["claude-code", ["C1", "C2"]], ["codex", ["C8"]]];
/** The checks tied to an anchorable tool's own records. */
const ANCHOR_CHECKS = new Set<CheckResult["id"]>(["C1", "C2", "C3", "C4", "C6", "C7", "C8"]);

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
 *    soft flags say: nothing in the data can be held against what a server minted or a tool's own records;
 * 3. else any warn or note (a raised soft flag is a note), or ids that exist but cannot be verified →
 *    `consistent-with-notes`;
 * 4. else → `consistent`.
 */
function bandOf(checks: readonly CheckResult[]): Forensics["band"] {
  if (checks.some((c) => c.status === "fail")) return "inconsistent";
  if (checks.every((c) => !ANCHOR_CHECKS.has(c.id) || c.status === "n/a")) return "unverifiable";
  if (checks.some((c) => c.status === "warn" || c.status === "note" || unverified(c))) return "consistent-with-notes";
  return "consistent";
}

/**
 * Every forensic check over a scan result, pure and synchronous: `now` and `timeZone` are the caller's; `releases`
 * defaults to the shipped table. Every check and soft flag reads in-scope data only, through one view of the scan
 * (`forensicScope`): the exclusions in `t` (tools, projects, the date range) and its host copies leave out what they
 * hit, so an exclusion never leaks what it excludes. The tools in scope are the kept rows' and the in-scope prompts'.
 */
export function runForensics(raw: ScanResult, t: SessionTable, stats: readonly SessionStats[],
  o: { now: number; timeZone: string; releases?: ReleaseTable }): Forensics {
  const s = forensicScope(raw, t);
  const [c1, c2] = checkAnchors(raw, t, s);
  const [c6, c7, c8] = checkRollouts(raw, t, { now: o.now }, s);
  const checks: CheckResult[] = [
    c1, c2, checkClaudeHistory(raw, t, s), checkAccount(raw, t, s), checkFileTimes(raw, t, { timeZone: o.timeZone }, s), c6, c7, c8,
    checkReleases(t, o.releases ?? RELEASES, raw, s), provenance(raw, t, s), ...softFlags(raw, t, o, s),
  ];
  const tools = s.tools();

  const status = new Map(checks.map((c) => [c.id, c.status]));
  const backed = new Set(BACKING.filter(([, ids]) => ids.every((id) => status.get(id) === "pass" || status.get(id) === "note")).map(([tool]) => tool));
  let all = 0, server = 0;
  for (const s of stats) {
    all += s.turns;
    if (backed.has(s.tool)) server += s.turns;
  }

  return {
    band: bandOf(checks), serverBacked: all > 0 ? round(server / all) : null,
    anchorable: tools.filter((x) => ANCHORABLE.has(x)), notAnchorable: tools.filter((x) => !ANCHORABLE.has(x)), checks,
  };
}
