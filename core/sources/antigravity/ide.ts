import { statSync } from "node:fs";
import path from "node:path";
import type { Env } from "../../env/env";
import { vscodeUser } from "../../env/paths";
import { safeStat } from "../../io/fs";
import { b64ToBytes, pbTryNested, type PbField } from "../../io/protobuf";
import { MAX_COPY_BYTES, openRo } from "../../io/sqlite";
import type { SessionEv } from "../../model/events";
import { Tally } from "../common/coverage";
import { str } from "../common/guards";
import { uriToPath } from "../copilot/map";
import type { Candidate, ScanCtx } from "../types";
import { agSessionId, pbNum, pbStr, pbTime, TOOL } from "./cli";

export const IDE_SOURCE = "antigravity.ide";
/** The Antigravity apps whose user folders (`vscodeUser(env, app)`) keep a `globalStorage/state.vscdb`. */
export const IDE_APPS = ["Antigravity", "Antigravity IDE"] as const;
/**
 * The only `ItemTable` key ever read, by exact key and parameterized. The same table holds the account
 * (`antigravityUnifiedStateSync.oauthToken`, `antigravityAuthStatus`) and every other setting, so it is never queried by pattern.
 */
export const TRAJ_KEY = "antigravityUnifiedStateSync.trajectorySummaries";
const VALUE_SQL = "SELECT value FROM ItemTable WHERE key = ?";

/**
 * `CascadeTrajectorySummary` field numbers, from the program's own type tables (the entry and row layout around the summary
 * confirmed with the structure probe): the trajectory's own id (string), step count (uint32), creation and last-change times
 * (`google.protobuf.Timestamp`), workspaces (repeated `CortexWorkspaceMetadata`).
 */
export const TRAJ_FIELDS: { id: number; steps: number; created: number; updated: number; workspace: number } = {
  id: 4, steps: 2, created: 7, updated: 3, workspace: 9,
};
/** `CortexWorkspaceMetadata.workspace_folder_absolute_uri`. */
const WORKSPACE_FOLDER = 1;

/** The store exists but cannot be opened or read: the source has nothing to say. */
class IdeStoreUnreadable extends Error {}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory(); // follows a symlinked user folder
  } catch {
    return false;
  }
};

/** The user folder of each Antigravity app that exists (the scanning user's only, as for VS Code). */
export function ideRoots(env: Env): Candidate[] {
  return IDE_APPS.map((app) => vscodeUser(env, app)).filter(isDir).map((root) => ({ root, home: env.home, wsl: false }));
}

const text = (v: unknown): string | undefined => (typeof v === "string" ? v : v instanceof Uint8Array ? new TextDecoder().decode(v) : undefined);

type Entry = "session" | "empty" | "skipped" | "undecodable";

/**
 * One topic entry {`key` (1), `value` (2): `Row` {`value` (1): base64 text of a `CascadeTrajectorySummary`, `e_tag` (2)}} → a
 * lifetime SessionEv. Id: the entry key (the conversation's id), else the summary's own id; `start`/`end` = created and last
 * change; the first workspace folder as the project. A summary without steps is an empty conversation. Nothing else of the
 * summary (its title, status, latest steps, annotations, metadata) is kept.
 */
function entry(f: PbField, ctx: ScanCtx, tally: Tally): Entry {
  const e = f.wire === 2 ? pbTryNested(f.v) : null;
  const row = e?.get(2)?.find((x) => x.wire === 2);
  const value = row ? pbStr(pbTryNested(row.v)?.get(1)?.[0]) : undefined;
  const summary = value === undefined ? null : pbTryNested(b64ToBytes(value));
  if (!e || !summary) return "undecodable";
  if ((pbNum(summary.get(TRAJ_FIELDS.steps)?.[0]) ?? 0) === 0) {
    tally.skip("empty-session");
    return "empty";
  }
  const raw = str(pbStr(e.get(1)?.[0])) ?? str(pbStr(summary.get(TRAJ_FIELDS.id)?.[0]));
  if (raw === undefined) {
    tally.skip("no-id");
    return "skipped";
  }
  const updated = pbTime(summary.get(TRAJ_FIELDS.updated)?.[0], ctx.now);
  const start = pbTime(summary.get(TRAJ_FIELDS.created)?.[0], ctx.now) ?? updated;
  if (start === undefined) {
    tally.skip("no-ts");
    return "skipped";
  }
  const s: SessionEv = {
    k: "session", tool: TOOL, source: IDE_SOURCE, id: agSessionId(raw, ctx), window: "lifetime", origin: "human", start,
    end: Math.max(start, updated ?? start), models: [], surface: "ide",
  };
  const ws = summary.get(TRAJ_FIELDS.workspace)?.find((x) => x.wire === 2);
  const uri = ws ? pbStr(pbTryNested(ws.v)?.get(WORKSPACE_FOLDER)?.[0]) : undefined;
  const cwd = uri === undefined ? undefined : uriToPath(uri, ctx.env.platform);
  if (cwd !== undefined) s.projectKey = ctx.registerCwd(cwd);
  ctx.emit(s);
  tally.span(s.start);
  tally.span(s.end);
  return "session";
}

/**
 * The trajectory summaries value: base64 text of a unified-state-sync `Topic`, its `data` (1) the entries. Empty text is no
 * conversation yet. A value that does not decode to entries is drift `trajectorySummaries:shape`; an entry that does not
 * decode, drift `trajectorySummaries.entry:shape`; when every entry that decodes has no steps, the step count has moved:
 * drift `trajectorySummaries:no-steps`.
 */
function readTopic(v: unknown, ctx: ScanCtx, tally: Tally): void {
  const t = text(v);
  if (t !== undefined && t.trim() === "") return;
  const entries = t === undefined ? undefined : pbTryNested(b64ToBytes(t))?.get(1);
  if (entries === undefined) return tally.unknownKey("trajectorySummaries:shape");
  let decoded = 0;
  let empty = 0;
  for (const f of entries) {
    if (ctx.signal.aborted) return;
    tally.records++;
    let got: Entry;
    try {
      got = entry(f, ctx, tally);
    } catch {
      tally.skip("bad-record");
      continue;
    }
    if (got === "undecodable") tally.unknownKey("trajectorySummaries.entry:shape");
    else decoded++;
    if (got === "empty") empty++;
  }
  if (decoded > 0 && empty === decoded) tally.unknownKey("trajectorySummaries:no-steps");
}

/**
 * Scan one Antigravity user folder's `globalStorage/state.vscdb`: the trajectory summaries, by exact key only; one CoverageEv
 * (window `lifetime`), last. A store that cannot be opened or read makes the source an error, unless it is a locked store above
 * MAX_COPY_BYTES (coverage note `too-large`).
 */
export async function scanIde(c: Candidate, ctx: ScanCtx): Promise<void> {
  const tally = new Tally(TOOL, IDE_SOURCE, "lifetime");
  const file = path.join(c.root, "globalStorage", "state.vscdb");
  if (safeStat(file)?.isFile()) {
    const db = openRo(file, ctx.temp);
    if (!db && (safeStat(file)?.size ?? 0) > MAX_COPY_BYTES) {
      tally.note = "too-large";
      tally.skip("too-large");
    } else if (!db) {
      throw new IdeStoreUnreadable("the Antigravity store could not be opened");
    } else {
      let listed = false;
      try {
        const tables = new Set(db.tables());
        listed = true;
        tally.files++;
        tally.bytes += safeStat(file)?.size ?? 0;
        if (!tables.has("ItemTable")) tally.unknownKey("missing-table:ItemTable");
        else {
          const have = new Set(db.columns("ItemTable"));
          for (const col of ["key", "value"]) if (!have.has(col)) tally.unknownKey(`missing-column:${col}`);
          const row = have.has("key") && have.has("value") ? db.get<{ value: unknown }>(VALUE_SQL, TRAJ_KEY) : undefined;
          if (row !== undefined) readTopic(row.value, ctx, tally);
        }
      } catch {
        tally.skip("io-error");
        ctx.log("warn", "ag.db-unreadable");
      } finally {
        db.close();
      }
      if (!listed) throw new IdeStoreUnreadable("the Antigravity store could not be read");
    }
  }
  const bad = tally.skipped["bad-record"] ?? 0;
  if (bad > 0) ctx.log("warn", "ag.bad-record", bad);
  ctx.emit(tally.coverage());
}
