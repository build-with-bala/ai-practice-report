import path from "node:path";
import type { Env } from "../../env/env";
import { joinFor } from "../../env/paths";
import { safeStat } from "../../io/fs";
import { toEpochMs } from "../../io/time";
import type { CommitFactEv } from "../../model/events";
import { Tally } from "../common/coverage";
import { num, str, type Obj } from "../common/guards";
import { eachRow, pageableColumns, Pass, q, readStore } from "../common/sqlite";
import type { Candidate, ScanCtx } from "../types";
import { TOOL } from "./diskkv";

export const TRACKING_SOURCE = "cursor.tracking";
const DB_NAME = "ai-code-tracking.db";
const TABLE = "scored_commits";
/**
 * The columns read; each one missing is drift. Never selected: `commitMessage`, `branchName`, the deleted- and
 * blank-line counts and the percentages; no other table of the store is read.
 */
const COLUMNS = ["commitHash", "commitDate", "scoredAt", "tabLinesAdded", "composerLinesAdded", "humanLinesAdded"] as const;
const TIMES = ["commitDate", "scoredAt"];

/** The tracking store could not be opened or read: the source has nothing to say. */
class TrackingUnreadable extends Error {}

/** `<home>/.cursor/ai-tracking` per home (WSL homes included) that holds `ai-code-tracking.db`. */
export function trackingRoots(env: Env, homes: string[]): Candidate[] {
  const out: Candidate[] = [];
  for (const home of homes) {
    const root = joinFor(env, home, ".cursor", "ai-tracking");
    if (safeStat(joinFor(env, root, DB_NAME))?.isFile()) out.push({ root, home, wsl: home !== env.home });
  }
  return out;
}

/** A line count when the column holds one (a non-negative number); null and anything else is unknown. */
const lines = (v: unknown): number | undefined => {
  const n = num(v);
  return n !== undefined && n >= 0 ? n : undefined;
};

/**
 * One `scored_commits` row → a CommitFactEv: `ts` = `commitDate`, else `scoredAt`; `aiLines` = tab + composer lines
 * added (whichever are recorded), `humanLines` = human lines added. A commit scored on more than one branch counts once:
 * its hash is compared in memory and never kept.
 */
function commit(r: Obj, seen: Set<string>, ctx: ScanCtx, tally: Tally): void {
  const ts = toEpochMs(r.commitDate, ctx.now) ?? toEpochMs(r.scoredAt, ctx.now);
  if (ts === undefined) return tally.skip("no-ts");
  const hash = str(r.commitHash);
  if (hash !== undefined) {
    if (seen.has(hash)) return tally.skip("duplicate");
    seen.add(hash);
  }
  const ev: CommitFactEv = { k: "commit", tool: TOOL, source: TRACKING_SOURCE, ts };
  const tab = lines(r.tabLinesAdded);
  const composer = lines(r.composerLinesAdded);
  if (tab !== undefined || composer !== undefined) ev.aiLines = (tab ?? 0) + (composer ?? 0);
  const human = lines(r.humanLinesAdded);
  if (human !== undefined) ev.humanLines = human;
  ctx.emit(ev);
  tally.span(ts);
}

/**
 * Scan `ai-code-tracking.db`: the `scored_commits` table in rowid pages, allowlisted columns only; one CoverageEv
 * (window `lifetime`), last. A store that cannot be opened makes the source an error, unless it is a locked store above
 * MAX_COPY_BYTES (coverage note `too-large`).
 */
export async function scanTracking(c: Candidate, ctx: ScanCtx): Promise<void> {
  const tally = new Tally(TOOL, TRACKING_SOURCE, "lifetime");
  const seen = new Set<string>();
  const read = await readStore(path.join(c.root, DB_NAME), ctx, tally, "cu", async (db, tables) => {
    const have = pageableColumns(db, tables, TABLE, COLUMNS, tally);
    if (!have || !TIMES.some((t) => have.has(t))) return;
    const sql = `SELECT rowid AS rid, ${COLUMNS.filter((x) => have.has(x)).map(q).join(", ")} FROM ${q(TABLE)} WHERE rowid > ? ORDER BY rowid LIMIT ?`;
    await new Pass(db, TABLE, tally, ctx, "cu.db-query").byRowid(sql, (rows) => { for (const r of rows) eachRow(() => commit(r, seen, ctx, tally), tally); });
  });
  if (!read && tally.note !== "too-large") throw new TrackingUnreadable("the Cursor tracking store could not be read");
  const bad = tally.skipped["bad-record"] ?? 0;
  if (bad > 0) ctx.log("warn", "cu.bad-record", bad);
  ctx.emit(tally.coverage());
}
