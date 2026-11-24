import { statPath } from "../../io/fs";
import { copyBytes, isBusyError, MAX_COPY_BYTES, openRo, type RoDb } from "../../io/sqlite";
import { maybeYield } from "../../io/yield";
import type { ScanCtx } from "../types";
import type { Tally } from "./coverage";
import type { Obj } from "./guards";

/** Rows per query: every table is read in pages, so memory stays bounded however large the store grows. */
export const PAGE = 2_000;
const WITHOUT_ROWID = /\bWITHOUT\s+ROWID\b/i;

/** An SQL identifier, quoted: `"` + the name with each `"` doubled + `"`. */
export const q = (ident: string): string => `"${ident.replace(/"/g, '""')}"`;

/**
 * Opens and reads one store on its own; it counts as read once its tables are listed, and is always closed once `body`
 * has finished (an async body is awaited). A store that cannot be opened is an io-error (warn
 * `<logPrefix>.db-unopenable`) — or, when a private copy of it would take more than MAX_COPY_BYTES (`copyBytes`: the
 * store and its `-wal`), a locked store that is never copied: skipped `too-large`, coverage `note: "too-large"`, warn
 * `<logPrefix>.db-too-large`; a reader whose stores all fail keeps that reason (it is no error of the source). A store
 * that fails while it is read is an io-error (warn `<logPrefix>.db-unreadable`). True when its tables were listed. A
 * linked store counts the bytes of its target, the store's own file (links followed), not the link's. A busy store
 * copied without its `-wal`, because that companion is a link (never followed), is read but skipped `linked-wal`: the
 * rows that live only in the WAL are missing.
 */
export async function readStore(file: string, ctx: ScanCtx, tally: Tally, logPrefix: string,
  body: (db: RoDb, tables: Set<string>) => void | Promise<void>): Promise<boolean> {
  const db = openRo(file, ctx.temp);
  if (!db) {
    if (copyBytes(file) > MAX_COPY_BYTES) {
      tally.note = "too-large";
      tally.skip("too-large");
      ctx.log("warn", `${logPrefix}.db-too-large`);
    } else {
      tally.skip("io-error");
      ctx.log("warn", `${logPrefix}.db-unopenable`);
    }
    return false;
  }
  let listed = false;
  try {
    const tables = new Set(db.tables());
    listed = true;
    // a private copy made without its linked -wal misses the rows that live only there
    if (db.walSkipped) tally.skip("linked-wal");
    tally.files++;
    const st = statPath(file);
    tally.bytes += "stat" in st ? st.stat.size : 0;
    await body(db, tables);
  } catch {
    tally.skip("io-error");
    ctx.log("warn", `${logPrefix}.db-unreadable`);
  } finally {
    db.close();
  }
  return listed;
}

/**
 * The columns of `table`; each one of `wanted` missing is drift `missing-column:<name>`. Undefined when the table is
 * missing (drift `missing-table:<name>`) or its schema cannot be read (io-error).
 */
export function tableColumns(db: RoDb, tables: ReadonlySet<string>, table: string, wanted: readonly string[], tally: Tally): Set<string> | undefined {
  if (!tables.has(table)) {
    tally.unknownKey(`missing-table:${table}`);
    return undefined;
  }
  let have: Set<string>;
  try {
    have = new Set(db.columns(table));
  } catch {
    tally.skip("io-error");
    return undefined;
  }
  for (const c of wanted) if (!have.has(c)) tally.unknownKey(`missing-column:${c}`);
  return have;
}

/** Whether `table` has a rowid to page by; a table declared WITHOUT ROWID has none: drift `table-unreadable:<name>`. */
export function rowidPageable(db: RoDb, table: string, tally: Tally): boolean {
  const ddl = db.get<{ sql: unknown }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", table)?.sql;
  if (typeof ddl !== "string" || !WITHOUT_ROWID.test(ddl)) return true;
  tally.unknownKey(`table-unreadable:${table}`);
  return false;
}

/** The columns of a table the reader can page by rowid (see `tableColumns`); undefined, and drift, for a table without rowids. */
export function pageableColumns(db: RoDb, tables: ReadonlySet<string>, table: string, wanted: readonly string[], tally: Tally): Set<string> | undefined {
  const have = tableColumns(db, tables, table, wanted, tally);
  if (have === undefined) return undefined;
  try {
    return rowidPageable(db, table, tally) ? have : undefined;
  } catch {
    tally.skip("io-error");
    return undefined;
  }
}

/**
 * Whether `table` has an index the reader can page by key: unique, not partial, on `key` alone in binary order —
 * Cursor's `key TEXT UNIQUE`, or a WITHOUT ROWID table's primary key `key`.
 */
export function keyIndexed(db: RoDb, table: string): boolean {
  for (const ix of db.all<Obj>('SELECT name, "unique" AS u, partial FROM pragma_index_list(?)', table)) {
    if (ix.u !== 1 || ix.partial === 1 || typeof ix.name !== "string") continue;
    const cols = db.all<Obj>("SELECT name, coll FROM pragma_index_xinfo(?) WHERE key = 1", ix.name);
    if (cols.length === 1 && cols[0]!.name === "key" && String(cols[0]!.coll).toUpperCase() === "BINARY") return true;
  }
  return false;
}

export interface PassOptions {
  /** Rows per page (default PAGE): smaller for tables whose rows carry large values. */
  page?: number;
  /** The code a query that fails on a busy store logs, where the reader tells it apart (default: `logCode`). */
  busyLogCode?: string;
  /** Put before the pass's own drift keys (`table-unreadable:`, `page-stalled:`), for a reader whose store keys carry one (default none). */
  driftPrefix?: string;
}

/** Compares two strings by code point, the order SQLite's BINARY collation gives UTF-8 text: negative, zero or positive. */
export function cmpCodePoints(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.codePointAt(i)!;
    const y = b.codePointAt(i)!;
    if (x !== y) return x - y;
    if (x > 0xffff) i++; // both strings hold the same pair here
  }
  return a.length - b.length;
}

/**
 * The queries of one pass over a table, a page of rows each. Before every page the pass awaits `maybeYield()`, so a
 * long pass lets timers, signals and an abort in; once the scan is aborted it reads nothing more. The first query of the
 * pass that fails other than busy means it can never work on this table: drift `table-unreadable:<table>`. A busy
 * store, or any later failure, is an io-error. Any failure ends the pass, and is logged: warn `logCode` (a busy store:
 * `busyLogCode`, when given). A full page whose last row would not move the next page forward (a rowid that is not a
 * safe integer above the one the page started after; a key that does not sort after its start key, inside the range
 * asked for) also ends the pass, as drift `page-stalled:<table>`: resuming from it could read the same rows for ever, or
 * rows outside the range. The rows already handed on stay.
 */
export class Pass {
  private started = false;
  failed = false;
  unreadable = false;
  private readonly page: number;
  private readonly busyLogCode: string;
  private readonly prefix: string;

  constructor(private readonly db: RoDb, private readonly table: string, private readonly tally: Tally, private readonly ctx: ScanCtx,
    private readonly logCode: string, o: PassOptions = {}) {
    this.page = o.page ?? PAGE;
    this.busyLogCode = o.busyLogCode ?? logCode;
    this.prefix = o.driftPrefix ?? "";
  }

  /** Ends the pass at a page that did not advance: drift, logged as a failed query. */
  private stalled(): false {
    this.failed = true;
    this.tally.unknownKey(`${this.prefix}page-stalled:${this.table}`);
    this.ctx.log("warn", this.logCode);
    return false;
  }

  /** One query; undefined once the pass has failed, once the scan is aborted, or when this query fails. */
  private query(sql: string, params: unknown[], rows = true): Obj[] | undefined {
    if (this.failed || this.ctx.signal.aborted) return undefined;
    const first = !this.started;
    this.started = true;
    try {
      const got = this.db.all<Obj>(sql, ...params);
      if (rows) this.tally.records += got.length;
      return got;
    } catch (e) {
      this.failed = true;
      const busy = isBusyError(e);
      if (first && !busy) {
        this.tally.unknownKey(`${this.prefix}table-unreadable:${this.table}`);
        this.unreadable = true;
      } else this.tally.skip("io-error");
      this.ctx.log("warn", busy ? this.busyLogCode : this.logCode);
      return undefined;
    }
  }

  /** The next page, after a turn of the event loop when the slice is used up (an abort in that turn ends the pass). */
  private async next(sql: string, params: unknown[]): Promise<Obj[] | undefined> {
    const pause = maybeYield();
    if (pause) await pause;
    return this.query(sql, params);
  }

  /**
   * The rows whose key lies strictly between `lo` and `hi`, in key order, each page resuming after the last key read
   * (`sql` binds the start key, `hi` and the page size). True when every page was read.
   */
  async byKey(sql: string, lo: string, hi: string, each: (rows: Obj[]) => void): Promise<boolean> {
    for (let after = lo; ;) {
      const rows = await this.next(sql, [after, hi, this.page]);
      if (rows === undefined) return false;
      if (rows.length > 0) each(rows);
      if (rows.length < this.page) return true;
      const last = rows[rows.length - 1]!.key;
      // keys inside a text range are text; one that does not sort after the start key (the runtime reads text that is not valid
      // UTF-8 as other text), or lies outside the range, cannot place the next page
      if (typeof last !== "string" || cmpCodePoints(last, after) <= 0 || cmpCodePoints(last, hi) >= 0) return this.stalled();
      after = last;
    }
  }

  /** The rows of `sql` in rowid order (it selects the rowid as `rid` and binds the last rowid read and the page size). True when every page was read. */
  async byRowid(sql: string, each: (rows: Obj[]) => void): Promise<boolean> {
    for (let after = Number.MIN_SAFE_INTEGER; ;) {
      const rows = await this.next(sql, [after, this.page]);
      if (rows === undefined) return false;
      if (rows.length > 0) each(rows);
      if (rows.length < this.page) return true;
      const last = rows[rows.length - 1]!.rid;
      // a rowid above 2^53 reads rounded: resuming from it could repeat or skip rows
      if (typeof last !== "number" || !Number.isSafeInteger(last) || last <= after) return this.stalled();
      after = last;
    }
  }

  /** One lookup within the pass (it is not counted as rows read): its first row; undefined when it has none, or when it failed (`failed`). */
  lookup(sql: string, params: unknown[]): Obj | undefined {
    return this.query(sql, params, false)?.[0];
  }
}

/** Maps one row; a row the mapping fails on is skipped as bad-record and the others go on. */
export function eachRow(map: () => void, tally: Tally): void {
  try {
    map();
  } catch {
    tally.skip("bad-record");
  }
}
