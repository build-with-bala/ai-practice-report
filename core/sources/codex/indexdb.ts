import path from "node:path";
import { safeStat } from "../../io/fs";
import { isBusyError, openRo, type RoDb } from "../../io/sqlite";
import { toEpochMs } from "../../io/time";
import type { SessionEv, ThreadRowEv, TurnEv } from "../../model/events";
import { listDir, Tally } from "../common/coverage";
import { isObj, num, safeModel, str, TOKEN, VERSION, type Obj } from "../common/guards";
import type { Candidate, ScanCtx } from "../types";
import { cxEffort } from "./effort";
import { cxSource, cxThreadId } from "./origin";

export const THREADS_SOURCE = "codex.threads";
const TOOL = "codex";
/** Rows per query: tables are read in rowid pages, so memory stays bounded however many threads a store holds. */
const PAGE = 5_000;
/** The CLI numbers its stores and bumps the number on a breaking migration; the highest one is current. */
const STATE_DB = /^state_(\d{1,9})\.sqlite$/;
const TURNS_DB = /^thread_history_(\d{1,9})\.sqlite$/;

/**
 * The columns read from `threads`; each one missing is drift. Every other column is never selected — among them the
 * first user message, title, preview, name, agent nickname and path, rollout path and creator ids.
 */
const THREAD_COLUMNS = [
  "id", "source", "originator", "model", "reasoning_effort", "approval_mode", "sandbox_policy", "tokens_used", "created_at", "created_at_ms",
  "updated_at", "updated_at_ms", "cli_version", "cwd",
] as const;
/** Tested for presence inside SQL only: commit, branch and remote values never leave SQLite. */
const GIT_COLUMNS = ["git_sha", "git_branch", "git_origin_url"] as const;
const EDGE_COLUMNS = ["parent_thread_id", "child_thread_id"] as const;
/** `error_json` and the item ids of a turn are never selected. */
const TURN_COLUMNS = ["thread_id", "status", "started_at", "completed_at", "duration_ms"] as const;
/** `thread_turns.status` values of finished turns (the app server's TurnStatus); `inProgress` turns have not ended. */
const FINISHED: ReadonlyMap<string, NonNullable<TurnEv["status"]>> = new Map([["completed", "completed"], ["failed", "failed"], ["interrupted", "interrupted"]]);
const IN_PROGRESS = "inProgress";
/** An unknown status keeps its value in the drift key when it has the enum's shape (camelCase letters), else `(other)`. */
const STATUS_SHAPE = /^[a-z][A-Za-z]{0,31}$/;

/** Rows are paged by rowid, which a table declared WITHOUT ROWID does not have. */
const WITHOUT_ROWID = /\bWITHOUT\s+ROWID\b/i;

/** Every thread store present failed to open or read: the source has nothing to say. */
class ThreadStoresUnreadable extends Error {}

const q = (name: string): string => `"${name}"`;

/** The `<prefix>_<N>.sqlite` regular file with the highest N among `names`. */
function newest(root: string, names: string[], re: RegExp): string | undefined {
  let best: { n: number; file: string } | undefined;
  for (const name of names) {
    const m = re.exec(name);
    const file = path.join(root, name);
    if (!m || !safeStat(file)?.isFile()) continue;
    const n = Number(m[1]);
    if (best === undefined || n > best.n) best = { n, file };
  }
  return best?.file;
}

/**
 * The allowlisted columns of a table the reader can page; each missing one is drift `missing-column:<name>`. Undefined
 * when the table is missing (drift `missing-table:<name>`), declared WITHOUT ROWID (drift `table-unreadable:<name>`), or
 * its schema cannot be read (io-error).
 */
function readableColumns(db: RoDb, tables: Set<string>, table: string, wanted: readonly string[], tally: Tally): Set<string> | undefined {
  if (!tables.has(table)) {
    tally.unknownKey(`missing-table:${table}`);
    return undefined;
  }
  let have: Set<string>;
  let ddl: unknown;
  try {
    have = new Set(db.columns(table));
    ddl = db.get<{ sql: unknown }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", table)?.sql;
  } catch {
    tally.skip("io-error");
    return undefined;
  }
  if (typeof ddl === "string" && WITHOUT_ROWID.test(ddl)) {
    tally.unknownKey(`table-unreadable:${table}`);
    return undefined;
  }
  for (const c of wanted) if (!have.has(c)) tally.unknownKey(`missing-column:${c}`);
  return have;
}

/**
 * Rows of `table` in rowid order, PAGE per query. A first page that fails other than busy means the query can never work
 * on this table: drift `table-unreadable:<name>`. A busy store, or a later page that fails, is an io-error. Either ends
 * the table.
 */
function* pages(db: RoDb, table: string, select: string[], tally: Tally, ctx: ScanCtx): Generator<Obj[]> {
  const sql = `SELECT rowid AS rid, ${select.join(", ")} FROM ${q(table)} WHERE rowid > ? ORDER BY rowid LIMIT ?`;
  let after = Number.MIN_SAFE_INTEGER;
  for (let first = true; ; first = false) {
    if (ctx.signal.aborted) return;
    let rows: Obj[];
    try {
      rows = db.all<Obj>(sql, after, PAGE);
    } catch (e) {
      if (first && !isBusyError(e)) tally.unknownKey(`table-unreadable:${table}`);
      else tally.skip("io-error");
      ctx.log("warn", "cx.db-query");
      return;
    }
    tally.records += rows.length;
    if (rows.length > 0) yield rows;
    if (rows.length < PAGE) return;
    after = rows[rows.length - 1]!.rid as number;
  }
}

/** `threads.source` as the rollouts carry it: a plain string, or the JSON of an object (`{"subagent": …}`); unparsable JSON is null. */
function sourceValue(v: unknown): unknown {
  if (typeof v !== "string" || !/^\s*[{["]/.test(v)) return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

/** The sandbox mode: the `type` of the JSON policy the CLI stores (its paths are never kept), or a bare token; else `other`. */
function sandboxType(v: unknown, tally: Tally): string | undefined {
  const raw = str(v);
  if (raw === undefined) return undefined;
  if (TOKEN.test(raw)) return raw;
  let type: unknown;
  try {
    const policy: unknown = JSON.parse(raw);
    if (isObj(policy)) type = policy.type;
  } catch {
    /* not JSON */
  }
  if (typeof type !== "string") {
    tally.unknownKey("threads.sandbox_policy:shape");
    return "other";
  }
  return TOKEN.test(type) ? type : "other";
}

/** The CLI's running token total of a thread (`tokens_used`): one TotalsEv per row that has one; a value that is not a count is drift. */
function totals(r: Obj, id: string, ctx: ScanCtx, tally: Tally): void {
  if (r.tokens_used === undefined || r.tokens_used === null) return;
  const tokens = num(r.tokens_used);
  if (tokens === undefined || tokens < 0) return tally.unknownKey("threads.tokens_used:shape");
  ctx.emit({ k: "totals", tool: TOOL, source: THREADS_SOURCE, sessionId: id, tokens });
}

/** One `threads` row: a ThreadRowEv and its token total, and a lifetime SessionEv when the thread has a creation time. */
function thread(r: Obj, ctx: ScanCtx, tally: Tally): void {
  const raw = str(r.id);
  if (raw === undefined) return tally.skip("bad-row");
  const id = cxThreadId(raw, ctx);
  const start = toEpochMs(r.created_at_ms, ctx.now) ?? toEpochMs(r.created_at, ctx.now);
  const row: ThreadRowEv = { k: "codex-thread-row", tool: TOOL, source: THREADS_SOURCE, threadId: id };
  if (start !== undefined) row.createdAt = start;
  ctx.emit(row);
  totals(r, id, ctx, tally);
  if (start === undefined) return tally.skip("no-ts");

  const updated = toEpochMs(r.updated_at_ms, ctx.now) ?? toEpochMs(r.updated_at, ctx.now);
  const end = Math.max(start, updated ?? start);
  // origin, surface and subagent links, by the rules the rollouts reader shares (origin.ts)
  const { unknownShape, subagent: _subagent, ...driver } = cxSource(sourceValue(r.source), r.originator, ctx);
  if (unknownShape) tally.unknownKey("threads.source:shape");
  const model = str(r.model);
  const s: SessionEv = {
    k: "session", tool: TOOL, source: THREADS_SOURCE, id, window: "lifetime", ...driver, start, end, models: model === undefined ? [] : [safeModel(model)],
  };
  const version = str(r.cli_version);
  if (version !== undefined && VERSION.test(version)) {
    s.version = version;
    tally.versions.add(version);
  }
  const cwd = str(r.cwd);
  if (cwd !== undefined) s.projectKey = ctx.registerCwd(cwd);
  if (r.in_repo !== undefined) s.inRepo = r.in_repo === 1;
  const effort = cxEffort(str(r.reasoning_effort));
  if (effort !== undefined) s.effort = effort;
  const approval = str(r.approval_mode);
  if (approval !== undefined) s.approval = TOKEN.test(approval) ? approval : "other";
  const sandbox = sandboxType(r.sandbox_policy, tally);
  if (sandbox !== undefined) s.sandbox = sandbox;
  ctx.emit(s);
  tally.span(start);
  tally.span(end);
}

/** Maps each row; a row the mapping fails on is skipped as bad-record (logged once per scan) and the others go on. */
function eachRow(rows: Obj[], map: (r: Obj) => void, tally: Tally): void {
  for (const r of rows) {
    try {
      map(r);
    } catch {
      tally.skip("bad-record");
    }
  }
}

function readThreads(db: RoDb, tables: Set<string>, ctx: ScanCtx, tally: Tally): void {
  const have = readableColumns(db, tables, "threads", [...THREAD_COLUMNS, ...GIT_COLUMNS], tally);
  if (!have?.has("id")) return;
  const select = THREAD_COLUMNS.filter((c) => have.has(c)).map(q);
  const git = GIT_COLUMNS.filter((c) => have.has(c));
  if (git.length > 0) select.push(`(${git.map((c) => `COALESCE(${q(c)}, '') <> ''`).join(" OR ")}) AS in_repo`);
  for (const rows of pages(db, "threads", select, tally, ctx)) eachRow(rows, (r) => thread(r, ctx, tally), tally);
}

/** One `thread_spawn_edges` row: an EdgeEv; an empty id is a bad row. */
function edge(r: Obj, ctx: ScanCtx, tally: Tally): void {
  const parent = str(r.parent_thread_id);
  const child = str(r.child_thread_id);
  if (parent === undefined || child === undefined) return tally.skip("bad-row");
  ctx.emit({ k: "edge", tool: TOOL, source: THREADS_SOURCE, parentId: cxThreadId(parent, ctx), childId: cxThreadId(child, ctx) });
}

function readEdges(db: RoDb, tables: Set<string>, ctx: ScanCtx, tally: Tally): void {
  const have = readableColumns(db, tables, "thread_spawn_edges", EDGE_COLUMNS, tally);
  if (!have || !EDGE_COLUMNS.every((c) => have.has(c))) return;
  for (const rows of pages(db, "thread_spawn_edges", EDGE_COLUMNS.map(q), tally, ctx)) eachRow(rows, (r) => edge(r, ctx, tally), tally);
}

/** One `thread_turns` row: a lifetime TurnEv for a finished turn, timed at its end (else its start). */
function turn(r: Obj, ctx: ScanCtx, tally: Tally): void {
  const threadId = str(r.thread_id);
  if (threadId === undefined) return tally.skip("bad-row");
  const raw = r.status;
  const status = typeof raw === "string" ? FINISHED.get(raw) : undefined;
  if (status === undefined) {
    if (raw === IN_PROGRESS) return tally.skip("in-progress");
    return tally.unknownKey(`turn-status:${typeof raw !== "string" ? "(none)" : STATUS_SHAPE.test(raw) ? raw : "(other)"}`);
  }
  const started = toEpochMs(r.started_at, ctx.now);
  const completed = toEpochMs(r.completed_at, ctx.now);
  const ts = completed ?? started;
  if (ts === undefined) return tally.skip("no-ts");
  const ev: TurnEv = { k: "turn", tool: TOOL, source: THREADS_SOURCE, ts, sessionId: cxThreadId(threadId, ctx), window: "lifetime", status };
  const duration = num(r.duration_ms);
  if (duration !== undefined && duration >= 0) ev.ms = duration;
  else if (started !== undefined && completed !== undefined && completed >= started) ev.ms = completed - started;
  ctx.emit(ev);
  tally.span(ts);
}

function readTurns(db: RoDb, tables: Set<string>, ctx: ScanCtx, tally: Tally): void {
  const have = readableColumns(db, tables, "thread_turns", TURN_COLUMNS, tally);
  if (!have?.has("thread_id") || !have.has("status")) return;
  const select = TURN_COLUMNS.filter((c) => have.has(c)).map(q);
  for (const rows of pages(db, "thread_turns", select, tally, ctx)) eachRow(rows, (r) => turn(r, ctx, tally), tally);
}

/**
 * Opens and reads one store on its own; it counts as read once its tables are listed, and is always closed. A store
 * that cannot be opened (warn `cx.db-unopenable`), or that fails while it is read (warn `cx.db-unreadable`), is an
 * io-error. True when its tables were listed.
 */
function readStore(file: string, ctx: ScanCtx, tally: Tally, body: (db: RoDb, tables: Set<string>) => void): boolean {
  const db = openRo(file, ctx.temp);
  if (!db) {
    tally.skip("io-error");
    ctx.log("warn", "cx.db-unopenable");
    return false;
  }
  let listed = false;
  try {
    const tables = new Set(db.tables());
    listed = true;
    tally.files++;
    tally.bytes += safeStat(file)?.size ?? 0;
    body(db, tables);
  } catch {
    tally.skip("io-error");
    ctx.log("warn", "cx.db-unreadable");
  } finally {
    db.close();
  }
  return listed;
}

/**
 * Scan the newest thread index (`state_<N>.sqlite`: threads, spawn edges) and turn history (`thread_history_<N>.sqlite`:
 * turns) under a Codex home; one CoverageEv, last. Each store is read on its own, so one that fails does not stop the
 * other; only when every store present fails is the source an error.
 */
export async function scanThreads(c: Candidate, ctx: ScanCtx): Promise<void> {
  const tally = new Tally(TOOL, THREADS_SOURCE, "lifetime");
  const names = listDir(c.root, tally);
  const stores: [string | undefined, (db: RoDb, tables: Set<string>) => void][] = [
    [newest(c.root, names, STATE_DB), (db, tables) => {
      readThreads(db, tables, ctx, tally);
      readEdges(db, tables, ctx, tally);
    }],
    [newest(c.root, names, TURNS_DB), (db, tables) => readTurns(db, tables, ctx, tally)],
  ];
  let present = 0;
  let read = 0;
  for (const [file, body] of stores) {
    if (file === undefined || ctx.signal.aborted) continue;
    present++;
    if (readStore(file, ctx, tally, body)) read++;
  }
  if (present > 0 && read === 0) throw new ThreadStoresUnreadable("no Codex thread store could be read");
  const bad = tally.skipped["bad-record"] ?? 0;
  if (bad > 0) ctx.log("warn", "cx.bad-record", bad); // a mapping bug must not look like a healthy source
  ctx.emit(tally.coverage());
}
