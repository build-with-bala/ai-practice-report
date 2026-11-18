import { constants, Database } from "bun:sqlite";
import { closeSync, copyFileSync, existsSync, openSync, readSync, statSync } from "node:fs";
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
  /** Opened with `immutable=1`: a WAL store without a `-wal` (its writer closed it), so there is no WAL content to miss. */
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
/** A busy or locked store: what a reader gets while a writer holds a lock, so worth a private copy or a later try. */
export function isBusyError(e: unknown): boolean {
  const err = e as { message?: unknown; code?: unknown } | null;
  return BUSY.test(String(err?.message ?? "")) || BUSY.test(String(err?.code ?? ""));
}

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

/**
 * Opens a `file:` URI read-only. SQLITE_OPEN_URI makes SQLite parse the URI (its `mode`, `immutable` and escapes):
 * Apple's build (Bun on macOS) does so by default, the build Bun bundles on Linux and Windows only with this flag —
 * without it the URI is taken for a file name and nothing opens.
 */
export const openUriReadOnly = (uri: string): Database => new Database(uri, constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI);
const defaultOpener = openUriReadOnly;

function closeQuietly(db: Database): void {
  try {
    db.close();
  } catch {
    /* ignore */
  }
}

function tryOpen(file: string, opener: (uri: string) => Database, params = "mode=ro"): Database {
  const db = opener(`${sqliteUri(file)}?${params}`);
  try {
    db.query("PRAGMA schema_version").get();
  } catch (e) {
    closeQuietly(db);
    throw e;
  }
  return db;
}

/** The database header says WAL mode: its file format write and read versions (bytes 18 and 19) are both 2. */
function walMode(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const head = new Uint8Array(20);
    return readSync(fd, head, 0, 20, 0) === 20 && head[18] === 2 && head[19] === 2;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** A file's size, following symlinks as a copy does; 0 when it is not there. */
function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * The bytes a private copy of a store takes: the store and its `-wal`, which holds a live writer's uncheckpointed work and
 * can outgrow the store itself. (The `-shm`, an index of the `-wal`, is copied too but is a small fraction of it.)
 */
export function copyBytes(file: string): number {
  return sizeOf(file) + sizeOf(file + "-wal");
}

/**
 * Opens a store read-only; null when it cannot be opened. How is decided before opening, from the file itself:
 * - a WAL store (by its header) without a `-wal` — its writer closed it — opens with `immutable=1`: there is no WAL
 *   content to miss, and an immutable open never writes `-wal`/`-shm` beside the store, which a plain read-only open
 *   does on some SQLite builds (others refuse to open such a store at all). If a `-wal` appears while it opens (a writer
 *   started), the store is reopened as below;
 * - any other store opens with `mode=ro`, and a busy one falls back to a private copy — unless the copy would take more
 *   than `o.maxCopyBytes` (default MAX_COPY_BYTES; `copyBytes`: the store and its `-wal`), when it is null.
 */
export function openRo(file: string, temp: TempDirs, opener: (uri: string) => Database = defaultOpener, o?: { maxCopyBytes?: number }): RoDb | null {
  if (!existsSync(file)) return null;
  if (walMode(file) && !existsSync(file + "-wal")) {
    let db: Database;
    try {
      db = tryOpen(file, opener, "mode=ro&immutable=1");
    } catch {
      return null;
    }
    if (!existsSync(file + "-wal")) return new Handle(db, false, true);
    closeQuietly(db);
  }
  try {
    return new Handle(tryOpen(file, opener), false);
  } catch (e) {
    if (!isBusyError(e)) return null;
  }
  try {
    if (copyBytes(file) > (o?.maxCopyBytes ?? MAX_COPY_BYTES)) return null;
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
