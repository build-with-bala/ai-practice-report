import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import type { TempDirs } from "../sources/types";

export const MAX_COPY_BYTES = 2_147_483_648;

export interface RoDb {
  all<T>(sql: string, ...p: unknown[]): T[];
  get<T>(sql: string, ...p: unknown[]): T | undefined;
  tables(): string[];
  columns(table: string): string[];
  close(): void;
  readonly copied: boolean;
  /** Opened with `immutable=1`: a WAL store whose writer closed it, so no `-wal` holds content to miss. */
  readonly immutable: boolean;
}

let observer: ((sql: string) => void) | undefined;
/** Test hook: every RoDb.all/get reports its SQL; undefined = off. */
export function __observeQueries(fn?: (sql: string) => void): void {
  observer = fn;
}

export function sqliteUri(p: string): string {
  if (/^[A-Za-z]:[\\/]/.test(p)) {
    const fwd = p.replace(/\\/g, "/");
    return "file:///" + escapeSpecials(fwd);
  }
  return "file:" + escapeSpecials(p);
}

function escapeSpecials(p: string): string {
  // escape "%" first (segment-wise) so encodeURI's own "%XX" output is not double-escaped
  return p.split("%").map(encodeURI).join("%25").replace(/\?/g, "%3F").replace(/#/g, "%23");
}

const BUSY = /SQLITE_BUSY|database is locked|SQLITE_LOCKED/i;
const CANT_OPEN = /SQLITE_CANTOPEN|unable to open database file/i;
function matches(e: unknown, re: RegExp): boolean {
  const err = e as { message?: unknown; code?: unknown } | null;
  return re.test(String(err?.message ?? "")) || re.test(String(err?.code ?? ""));
}
const isBusy = (e: unknown): boolean => matches(e, BUSY);

class Handle implements RoDb {
  constructor(private db: Database, readonly copied: boolean, readonly immutable = false) {}
  all<T>(sql: string, ...p: unknown[]): T[] {
    observer?.(sql);
    return this.db.query(sql).all(...(p as never[])) as T[];
  }
  get<T>(sql: string, ...p: unknown[]): T | undefined {
    observer?.(sql);
    return (this.db.query(sql).get(...(p as never[])) ?? undefined) as T | undefined;
  }
  tables(): string[] {
    return this.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map((r) => r.name);
  }
  columns(table: string): string[] {
    return this.all<{ name: string }>("SELECT name FROM pragma_table_info(?)", table).map((r) => r.name);
  }
  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

const defaultOpener = (uri: string) => new Database(uri, { readonly: true });

function tryOpen(file: string, opener: (uri: string) => Database, params = "mode=ro"): Database {
  const db = opener(`${sqliteUri(file)}?${params}`);
  try {
    db.query("PRAGMA schema_version").get();
  } catch (e) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    throw e;
  }
  return db;
}

export function openRo(file: string, temp: TempDirs, opener: (uri: string) => Database = defaultOpener): RoDb | null {
  if (!existsSync(file)) return null;
  try {
    return new Handle(tryOpen(file, opener), false);
  } catch (e) {
    // A read-only connection cannot create a WAL store's -wal, so once the writer has closed the store (no -wal left)
    // it cannot be opened with mode=ro alone; immutable is safe then, as there is no WAL content to miss.
    if (matches(e, CANT_OPEN) && !existsSync(file + "-wal")) {
      try {
        return new Handle(tryOpen(file, opener, "mode=ro&immutable=1"), false, true);
      } catch {
        return null;
      }
    }
    if (!isBusy(e)) return null;
  }
  try {
    if (statSync(file).size > MAX_COPY_BYTES) return null;
    const dir = temp.dir();
    const dest = path.join(dir, path.basename(file));
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(file + suffix)) copyFileSync(file + suffix, dest + suffix);
    }
    return new Handle(tryOpen(dest, opener), true);
  } catch {
    return null;
  }
}
