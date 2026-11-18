import { constants, Database } from "bun:sqlite";
import { closeSync, copyFileSync, existsSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { TempDirs } from "../sources/types";
import { noteOpen } from "./observe";

export const MAX_COPY_BYTES = 2_147_483_648;

/** A read-only store. `all` and `get` run reads only (`readOnly`): any other statement throws ReadOnlyQueryError. */
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

/** A statement an RoDb refused to run: only reads run on a store (`readOnly`). */
export class ReadOnlyQueryError extends Error {}

/** The PRAGMAs the readers query, in their read form `PRAGMA name(arg)` (inside a SELECT they run as `pragma_<name>(?)`). */
const READ_PRAGMA = /^PRAGMA\s+(?:table_info|index_list|index_xinfo)\s*\([^;=()]*\)$/i;

/**
 * Only reads run on a store: one SELECT or WITH statement, or one of the readers' PRAGMAs (READ_PRAGMA), and no `;`, so
 * never a second statement. Anything else throws ReadOnlyQueryError before it runs: ATTACH, which would open a file the
 * open observer never sees; DETACH; VACUUM, whose INTO form writes a copy even through a read-only handle; writes, schema
 * changes and every other PRAGMA.
 */
function readOnly(sql: string): void {
  const s = sql.trim();
  if (!s.includes(";") && (/^(?:SELECT|WITH)\b/i.test(s) || READ_PRAGMA.test(s))) return;
  throw new ReadOnlyQueryError("only a read runs on a store");
}

class Handle implements RoDb {
  /** The connection: a true private field, so no cast reaches it and every statement goes through `readOnly`. */
  readonly #db: Database;
  constructor(db: Database, readonly copied: boolean, readonly immutable = false) {
    this.#db = db;
  }
  all<T>(sql: string, ...p: unknown[]): T[] {
    observer?.(sql);
    readOnly(sql);
    return this.#db.query(sql).all(...(p as never[])) as T[];
  }
  get<T>(sql: string, ...p: unknown[]): T | undefined {
    observer?.(sql);
    readOnly(sql);
    return (this.#db.query(sql).get(...(p as never[])) ?? undefined) as T | undefined;
  }
  tables(): string[] {
    return this.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map((r) => r.name);
  }
  columns(table: string): string[] {
    return this.all<{ name: string }>("SELECT name FROM pragma_table_info(?)", table).map((r) => r.name);
  }
  close(): void {
    try {
      this.#db.close();
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
  noteOpen(file, "sqlite");
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
  noteOpen(file, "header");
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
 * The path a store is read by: the one its `-wal` and `-shm` sit beside. For a link that is its target, resolved once:
 * SQLite on unix resolves a linked store itself and keeps them there, even for a writer that opened the link. Only when
 * the `-wal` sits beside the link and not beside the target (a writer whose SQLite names it after the path as given) is
 * the link read as it is. Any other path is read as given: through linked folders, `<path>-wal` already names the store's
 * own. Null when nothing is there.
 */
export function storePath(file: string): string | null {
  try {
    if (!lstatSync(file).isSymbolicLink()) return file;
    const target = realpathSync(file);
    return existsSync(file + "-wal") && !existsSync(target + "-wal") ? file : target;
  } catch {
    return null;
  }
}

/** The bytes a private copy of a store's own file takes (see `copyBytes`). */
const storeBytes = (store: string): number => sizeOf(store) + sizeOf(store + "-wal");

/**
 * The bytes a private copy of a store takes: the store and its `-wal`, which holds a live writer's uncheckpointed work and
 * can outgrow the store itself. (The `-shm`, an index of the `-wal`, is copied too but is a small fraction of it.) A
 * linked store's `-wal` is the one beside the path it is read by (`storePath`).
 */
export function copyBytes(file: string): number {
  return storeBytes(storePath(file) ?? file);
}

/**
 * Opens a store read-only; null when it cannot be opened. A linked store is read by the path its `-wal` and `-shm` sit
 * beside, its target as a rule (`storePath`): every check, the open and a copy below use that one path. How is decided
 * before opening, from the file itself:
 * - a WAL store (by its header) without a `-wal` — its writer closed it — opens with `immutable=1`: there is no WAL
 *   content to miss, and an immutable open never writes `-wal`/`-shm` beside the store, which a plain read-only open
 *   does on some SQLite builds (others refuse to open such a store at all). If a `-wal` appears while it opens (a writer
 *   started), the store is reopened as below;
 * - any other store opens with `mode=ro`, and a busy one falls back to a private copy — unless the copy would take more
 *   than `o.maxCopyBytes` (default MAX_COPY_BYTES; `copyBytes`: the store and its `-wal`), when it is null.
 * A never-opened store (`noteOpen`) is refused at its first open, the header read: null, and nothing of it is read.
 */
export function openRo(file: string, temp: TempDirs, opener: (uri: string) => Database = defaultOpener, o?: { maxCopyBytes?: number }): RoDb | null {
  const store = storePath(file);
  if (store === null) return null;
  let wal: boolean;
  try {
    wal = walMode(store);
  } catch {
    return null; // refused: a never-opened store
  }
  if (wal && !existsSync(store + "-wal")) {
    let db: Database;
    try {
      db = tryOpen(store, opener, "mode=ro&immutable=1");
    } catch {
      return null;
    }
    if (!existsSync(store + "-wal")) return new Handle(db, false, true);
    closeQuietly(db);
  }
  try {
    return new Handle(tryOpen(store, opener), false);
  } catch (e) {
    if (!isBusyError(e)) return null;
  }
  try {
    if (storeBytes(store) > (o?.maxCopyBytes ?? MAX_COPY_BYTES)) return null;
    const dir = temp.dir();
    const dest = path.join(dir, path.basename(store));
    for (const suffix of ["", "-wal", "-shm"]) {
      if (!existsSync(store + suffix)) continue;
      noteOpen(store + suffix, "copy");
      copyFileSync(store + suffix, dest + suffix);
    }
    return new Handle(tryOpen(dest, opener), true);
  } catch {
    return null;
  }
}
