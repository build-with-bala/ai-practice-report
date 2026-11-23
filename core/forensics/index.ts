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
import { softFlags } from "./soft";
import { round, type CheckResult, type CheckStatus } from "./types";

export type { ReleaseTable } from "./releases";
export type { CheckId, CheckResult, CheckStatus } from "./types";

/**
 * The integrity summary (spec §6.6). `band`: the verdict over every check; `serverBacked`: the share of typed turns
 * from tools whose server-minted data checked out (display only: it never changes a score, an evidence minimum or a
 * confidence), null without typed turns; `anchorable` / `notAnchorable`: the tools in the data that do or do not
 * record server-minted ids (neutral, never a penalty); `checks`: C1–C10, then the soft flags, always in that order.
 */
export interface Forensics { band: "consistent" | "consistent-with-notes" | "inconsistent" | "unverifiable"; serverBacked: number | null;
  anchorable: ToolId[]; notAnchorable: ToolId[]; checks: CheckResult[] }

/** Tools whose traces carry server-minted ids the checks verify: Claude Code (C1, C2) and Codex (C8). */
const ANCHORABLE: ReadonlySet<ToolId> = new Set<ToolId>(["claude-code", "codex"]);
const BACKING: readonly [ToolId, readonly CheckResult["id"][]][] = [["claude-code", ["C1", "C2"]], ["codex", ["C8"]]];
const PRIMARY = new Set<CheckResult["id"]>(["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9"]);

/**
 * How a result counts toward the band. Ids that exist but cannot be verified are a note: a C1 or C2 result that is
 * n/a for a reason other than `too-few`, or that names an unverified kind, counts as `note` (a fail stays a fail). The
 * result itself is left as it is.
 */
function bandStatus(c: CheckResult): CheckStatus {
  if (c.id !== "C1" && c.id !== "C2") return c.status;
  if (c.status === "fail") return "fail";
  const unverified = (c.status === "n/a" && c.reason !== "too-few") || (typeof c.values.unverifiedKinds === "number" && c.values.unverifiedKinds > 0);
  return unverified ? "note" : c.status;
}

/**
 * The band over every result: `inconsistent` if any fails; else `consistent-with-notes` if any is a warn or a note
 * (a raised soft flag is a note); else `consistent` if any of C1–C9 passed; else `unverifiable`. Never `worst()`, where
 * n/a ranks below pass.
 */
function bandOf(checks: readonly CheckResult[]): Forensics["band"] {
  const statuses = checks.map(bandStatus);
  if (statuses.includes("fail")) return "inconsistent";
  if (statuses.some((s) => s === "warn" || s === "note")) return "consistent-with-notes";
  if (checks.some((c, i) => PRIMARY.has(c.id) && statuses[i] === "pass")) return "consistent";
  return "unverifiable";
}

/**
 * Every forensic check over a scan result, pure and synchronous: `now` and `timeZone` are the caller's; `releases`
 * defaults to the shipped table. The tools in the data are the session rows' and the in-scope prompts'.
 */
export function runForensics(raw: ScanResult, t: SessionTable, stats: readonly SessionStats[],
  o: { now: number; timeZone: string; releases?: ReleaseTable }): Forensics {
  const [c1, c2] = checkAnchors(raw);
  const [c6, c7, c8] = checkRollouts(raw, { now: o.now });
  const checks: CheckResult[] = [
    c1, c2, checkClaudeHistory(raw, t), checkAccount(raw), checkFileTimes(raw, { timeZone: o.timeZone }), c6, c7, c8,
    checkReleases(t, o.releases ?? RELEASES), provenance(raw, t), ...softFlags(raw, t, o),
  ];

  const present = new Set<ToolId>();
  for (const row of t.rows.values()) present.add(row.tool);
  for (const p of raw.store.all("prompt")) if (!t.scope.tools.has(p.tool) && p.ts >= t.scope.from && p.ts <= t.scope.to) present.add(p.tool);
  const tools = [...present].sort();

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
