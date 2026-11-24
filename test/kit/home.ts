import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectEnv, type Env, type Platform } from "../../core/env/env";
import { MAX_COPY_BYTES } from "../../core/io/sqlite";

/**
 * Makes the store at `file` a busy store too large to copy: grown past MAX_COPY_BYTES (sparse: SQLite reads only the
 * pages its header counts) and held under an exclusive lock, so a reader gets SQLITE_BUSY and `openRo` may not fall back
 * to a private copy. Returns the release. POSIX only: Windows grows the file for real and locks it apart.
 */
export function lockAboveCopyLimit(file: string): () => void {
  truncateSync(file, MAX_COPY_BYTES + 1);
  const lock = new Database(file);
  lock.exec("BEGIN EXCLUSIVE");
  return () => {
    lock.exec("ROLLBACK");
    lock.close();
  };
}

/** A store whose writer is still open: what it has inserted since it was made lives only in its `-wal`. */
export interface LiveSqlite { path: string; insert(table: string, row: unknown[]): void; close(): void }

export interface FakeHome {
  root: string;
  env: Env;
  write(rel: string, data: string | Uint8Array): string;
  writeJsonl(rel: string, records: unknown[]): string;
  writeJson(rel: string, v: unknown): string;
  sqlite(rel: string, ddl: string[], rows?: Record<string, unknown[][]>, wal?: boolean): string;
  /**
   * A WAL store whose writer stays open, as a running tool's is: its tables and `rows` are checkpointed into the store
   * file, then automatic checkpoints are turned off (`PRAGMA wal_autocheckpoint=0`), so every row inserted afterwards
   * lives only in `-wal` until `close()`. `cleanup()` closes a writer still open.
   */
  sqliteLive(rel: string, ddl: string[], rows?: Record<string, unknown[][]>): LiveSqlite;
  cleanup(): void;
}

function insertRow(db: Database, table: string, row: unknown[]): void {
  db.query(`INSERT INTO "${table.replace(/"/g, '""')}" VALUES (${row.map(() => "?").join(",")})`).run(...(row as never[]));
}

export function fakeHome(platform: Platform = process.platform as Platform): FakeHome {
  const root = mkdtempSync(path.join(os.tmpdir(), "aipr-home-"));
  const home = path.join(root, "home");
  const tmp = path.join(root, "tmp");
  mkdirSync(home, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  const win = platform === "win32";
  const env = detectEnv({
    platform,
    home,
    tmp,
    appData: win ? path.join(home, "AppData", "Roaming") : undefined,
    localAppData: win ? path.join(home, "AppData", "Local") : undefined,
    xdgConfig: path.join(home, ".config"),
    xdgData: path.join(home, ".local", "share"),
    xdgState: path.join(home, ".local", "state"),
    vars: {},
    wslHomes: [],
  });
  const abs = (rel: string) => {
    const p = path.join(home, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    return p;
  };
  const write = (rel: string, data: string | Uint8Array) => {
    const p = abs(rel);
    writeFileSync(p, data);
    return p;
  };
  const writers = new Set<Database>();
  return {
    root,
    env,
    write,
    writeJsonl: (rel, records) => write(rel, records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "")),
    writeJson: (rel, v) => write(rel, JSON.stringify(v)),
    sqlite(rel, ddl, rows = {}, wal = false) {
      const p = abs(rel);
      const db = new Database(p);
      try {
        if (wal) db.exec("PRAGMA journal_mode=WAL");
        for (const s of ddl) db.exec(s);
        for (const [table, list] of Object.entries(rows)) for (const r of list) insertRow(db, table, r);
      } finally {
        db.close();
      }
      return p;
    },
    sqliteLive(rel, ddl, rows = {}) {
      const p = abs(rel);
      const db = new Database(p);
      writers.add(db);
      try {
        db.exec("PRAGMA journal_mode=WAL");
        for (const s of ddl) db.exec(s);
        for (const [table, list] of Object.entries(rows)) for (const r of list) insertRow(db, table, r);
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        db.exec("PRAGMA wal_autocheckpoint=0");
      } catch (e) {
        writers.delete(db);
        db.close();
        throw e;
      }
      return {
        path: p,
        insert: (table, row) => insertRow(db, table, row),
        close: () => {
          if (writers.delete(db)) db.close();
        },
      };
    },
    cleanup: () => {
      for (const db of writers) db.close(); // before removing: Windows cannot remove a file that is open
      writers.clear();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
