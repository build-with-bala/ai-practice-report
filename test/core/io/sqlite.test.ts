import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { __observeQueries, copyBytes, MAX_COPY_BYTES, openRo, openUriReadOnly, ReadOnlyQueryError, type RoDb, sqliteUri, storePath } from "../../../core/io/sqlite";
import { TempRegistry } from "../../../core/io/temp";

const root = mkdtempSync(path.join(os.tmpdir(), "sqlite-test-"));
const uris: string[] = [];
/** Every handle a test opens, closed after it even when it failed midway: Windows cannot remove a file that is open. */
const handles: { close(): void }[] = [];
const kept = <T extends { close(): void } | null>(x: T): T => {
  if (x) handles.push(x);
  return x;
};
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => {
  __observeQueries(undefined);
  uris.length = 0;
  for (const x of handles.splice(0)) {
    try {
      x.close();
    } catch {
      /* already closed */
    }
  }
});

function mk(file: string, wal = true): Database {
  mkdirSync(path.dirname(file), { recursive: true });
  const w = kept(new Database(file));
  if (wal) w.exec("PRAGMA journal_mode=WAL");
  w.exec("CREATE TABLE t (id INTEGER, name TEXT)");
  w.exec("INSERT INTO t VALUES (1, 'a')");
  return w;
}

/**
 * A WAL store whose writer wrote, checkpointed and closed it, leaving no -wal or -shm — as the stock SQLite build does
 * on close; Apple's build keeps empty ones, removed here so every build starts from the same files.
 */
function closedWal(...segments: string[]): string {
  const f = path.join(root, ...segments);
  const w = mk(f);
  w.exec("INSERT INTO t VALUES (2, 'b')");
  w.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  w.close();
  rmSync(f + "-wal", { force: true });
  rmSync(f + "-shm", { force: true });
  return f;
}

/** The default opener, recording each URI it is given. */
const recording = (into: string[]) => (uri: string) => {
  into.push(uri);
  return openUriReadOnly(uri);
};

/** A link at `at` to the file `target`; false on Windows when the account may not create one (no symlink privilege). */
function linkFile(target: string, at: string): boolean {
  mkdirSync(path.dirname(at), { recursive: true });
  try {
    symlinkSync(target, at);
    return true;
  } catch (e) {
    if (process.platform !== "win32") throw e;
    return false;
  }
}

/**
 * A store under `segments` and a link to it in another folder (false on Windows when no link can be made), with a live
 * WAL writer that opened `writerOpens` — the store itself, or the link, as a tool does that opens its own path: table `t`
 * is checkpointed into the store file, table `t2` lives only in the `-wal` (automatic checkpoints off).
 */
function linkedLiveWal(writerOpens: "target" | "link", ...segments: string[]): { target: string; link: string } | false {
  const target = path.join(root, ...segments, "real", "store.db");
  const link = path.join(root, ...segments, "linked", "store.db");
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, "");
  if (!linkFile(target, link)) return false;
  const w = kept(new Database(writerOpens === "target" ? target : link));
  w.exec("PRAGMA journal_mode=WAL");
  w.exec("CREATE TABLE t (id INTEGER, name TEXT)");
  w.exec("INSERT INTO t VALUES (1, 'a')");
  w.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  w.exec("PRAGMA wal_autocheckpoint=0");
  w.exec("CREATE TABLE t2 (x INTEGER)");
  w.exec("INSERT INTO t2 VALUES (1)");
  return { target, link };
}

describe("sqliteUri", () => {
  test("windows drive path", () => {
    expect(sqliteUri("C:\\a b\\x.db")).toBe("file:///C:/a%20b/x.db");
  });
  test("windows temp path with a short name: `~` is unreserved and stays, backslashes become slashes", () => {
    expect(sqliteUri("C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\sqlite-test-x\\a b.db")).toBe("file:///C:/Users/RUNNER~1/AppData/Local/Temp/sqlite-test-x/a%20b.db");
  });
  test("posix escapes", () => {
    expect(sqliteUri("/tmp/a b/ü#?%.db")).toBe("file:/tmp/a%20b/%C3%BC%23%3F%25.db");
  });
});

describe("openRo", () => {
  test("missing file -> null", () => {
    expect(openRo(path.join(root, "nope.db"), new TempRegistry(root))).toBeNull();
  });
  test("sees uncheckpointed WAL rows while writer open; observer sees SQL", () => {
    const f = path.join(root, "w", "live.db");
    const w = mk(f);
    const seen: string[] = [];
    __observeQueries((s) => seen.push(s));
    const t = new TempRegistry(root);
    const db = kept(openRo(f, t))!;
    expect(db).not.toBeNull();
    const sql = "select count(*) n from t";
    expect(db.get<{ n: number }>(sql)!.n).toBe(1);
    expect(seen).toContain(sql);
    expect(db.copied).toBe(false);
    expect(db.immutable).toBe(false); // a -wal is present: mode=ro, so uncheckpointed rows are seen
    expect(t.active).toBe(0);
    db.close();
    w.close();
  });
  test("closed WAL store (no -wal): chosen from the header, opened immutable, nothing written beside it, on any build", () => {
    const f = closedWal("closed", "c.db");
    const t = new TempRegistry(root);
    const db = kept(openRo(f, t, recording(uris)))!;
    expect(uris).toEqual([`${sqliteUri(f)}?mode=ro&immutable=1`]);
    expect([db.immutable, db.copied]).toEqual([true, false]);
    expect(db.get<{ n: number }>("select count(*) n from t")!.n).toBe(2);
    expect(db.columns("t")).toEqual(["id", "name"]);
    db.close();
    expect([existsSync(f + "-wal"), existsSync(f + "-shm"), t.active]).toEqual([false, false, 0]);
  });
  test("a -wal appearing between the header check and the open: reopened mode=ro", () => {
    const f = closedWal("race", "r.db");
    const ro = `${sqliteUri(f)}?mode=ro`;
    const db = kept(openRo(f, new TempRegistry(root), (uri) => {
      uris.push(uri);
      if (uri.endsWith("immutable=1")) writeFileSync(f + "-wal", ""); // a writer starts as the store is opened
      return openUriReadOnly(uri);
    }))!;
    expect(uris).toEqual([`${ro}&immutable=1`, ro]);
    expect([db.immutable, db.copied]).toEqual([false, false]);
    expect(db.get<{ n: number }>("select count(*) n from t")!.n).toBe(2);
    db.close();
  });
  test("a WAL store with a live writer, and a rollback-journal store: mode=ro, never immutable", () => {
    const live = path.join(root, "live2", "l.db");
    const w = mk(live);
    let db = kept(openRo(live, new TempRegistry(root), recording(uris)))!;
    expect([uris, db.immutable]).toEqual([[`${sqliteUri(live)}?mode=ro`], false]);
    db.close();
    w.close();
    const rollback = path.join(root, "rollback", "r.db");
    mk(rollback, false).close();
    uris.length = 0;
    db = kept(openRo(rollback, new TempRegistry(root), recording(uris)))!;
    expect([uris, db.immutable]).toEqual([[`${sqliteUri(rollback)}?mode=ro`], false]);
    db.close();
  });
  test("storePath: a link opens at its target, unless only the link has a -wal beside it; any other path as given; null when nothing is there", () => {
    const target = closedWal("store-path", "real", "s.db"); // no -wal anywhere
    const link = path.join(root, "store-path", "linked", "s.db");
    expect(storePath(target)).toBe(target);
    expect(storePath(path.join(root, "store-path", "nope.db"))).toBeNull();
    if (!linkFile(target, link)) return;
    expect(storePath(link)).toBe(realpathSync(target));
    writeFileSync(link + "-wal", ""); // a writer whose SQLite build names the -wal after the link (it does not resolve links)
    expect(storePath(link)).toBe(link);
    writeFileSync(target + "-wal", ""); // a -wal on both sides: the target's, where a build that resolves links keeps it
    expect(storePath(link)).toBe(realpathSync(target));
    const dangling = path.join(root, "store-path", "linked", "gone.db");
    if (linkFile(path.join(root, "store-path", "real", "gone.db"), dangling)) expect(storePath(dangling)).toBeNull();
  });
  test("a linked store opens at its target, where SQLite keeps its -wal: a live writer's rows are seen, never immutable", () => {
    const s = linkedLiveWal("target", "linked-live");
    if (!s) return; // where no link can be made there is no linked store
    expect([existsSync(s.target + "-wal"), existsSync(s.link + "-wal")]).toEqual([true, false]); // the -wal is beside the target only
    const db = kept(openRo(s.link, new TempRegistry(root), recording(uris)))!;
    expect([db.immutable, db.copied]).toEqual([false, false]);
    expect(db.tables()).toEqual(["t", "t2"]); // t2 lives only in the -wal
    expect(uris).toEqual([`${sqliteUri(realpathSync(s.target))}?mode=ro`]);
    db.close();
  });
  test("a writer that opened the store through the link: its -wal is found on whichever side this SQLite build keeps it", () => {
    const s = linkedLiveWal("link", "linked-writer");
    if (!s) return;
    expect(existsSync(s.target + "-wal")).not.toBe(existsSync(s.link + "-wal")); // one -wal, beside the target or the link
    const db = kept(openRo(s.link, new TempRegistry(root)))!;
    expect([db.immutable, db.copied]).toEqual([false, false]);
    expect(db.tables()).toEqual(["t", "t2"]);
    db.close();
  });
  test("a busy linked store is copied from its target: the store with its -wal and -shm; the copy limit counts that -wal", () => {
    const s = linkedLiveWal("target", "linked-busy");
    if (!s) return;
    expect(copyBytes(s.link)).toBe(statSync(s.target).size + statSync(s.target + "-wal").size);
    const t = new TempRegistry(root);
    let calls = 0;
    const db = kept(openRo(s.link, t, (uri) => {
      if (calls++ === 0) throw new Error("SQLITE_BUSY: database is locked");
      return openUriReadOnly(uri);
    }))!;
    expect([db.copied, db.immutable]).toEqual([true, false]);
    expect(db.tables()).toEqual(["t", "t2"]); // the copy took the -wal from beside the target
    db.close();
    t.disposeAll();
  });
  test("cannot-open is like any other failure that is not busy: null, no retry", () => {
    const f = path.join(root, "cant", "c.db");
    mk(f, false).close();
    const cantOpen = Object.assign(new Error("unable to open database file"), { code: "SQLITE_CANTOPEN" });
    expect(openRo(f, new TempRegistry(root), (uri) => { uris.push(uri); throw cantOpen; })).toBeNull();
    expect(uris).toEqual([`${sqliteUri(f)}?mode=ro`]);
  });
  test("an immutable open that fails gives null and never falls back to a plain read-only open", () => {
    const f = closedWal("bad", "b.db");
    const t = new TempRegistry(root);
    expect(openRo(f, t, (uri) => { uris.push(uri); throw new Error("file is not a database"); })).toBeNull();
    expect(uris).toEqual([`${sqliteUri(f)}?mode=ro&immutable=1`]);
    expect([existsSync(f + "-wal"), existsSync(f + "-shm"), t.active]).toEqual([false, false, 0]);
  });
  test("files too short for a header, or not SQLite, are not taken for WAL stores", () => {
    const empty = path.join(root, "short", "empty.db");
    mkdirSync(path.dirname(empty), { recursive: true });
    writeFileSync(empty, "");
    const db = kept(openRo(empty, new TempRegistry(root), recording(uris)))!;
    expect([uris, db.immutable, db.tables()]).toEqual([[`${sqliteUri(empty)}?mode=ro`], false, []]);
    db.close();
    // only bytes 18 and 19 both 2 mean WAL; such a file that is no database fails its immutable open, with no retry
    const junk = path.join(root, "short", "junk.db");
    writeFileSync(junk, "x".repeat(18) + "\u0002\u0002" + "y".repeat(80));
    uris.length = 0;
    expect(openRo(junk, new TempRegistry(root), recording(uris))).toBeNull();
    expect(uris).toEqual([`${sqliteUri(junk)}?mode=ro&immutable=1`]);
    const half = path.join(root, "short", "half.db");
    writeFileSync(half, "x".repeat(18) + "\u0001\u0002" + "y".repeat(80));
    uris.length = 0;
    expect(openRo(half, new TempRegistry(root), recording(uris))).toBeNull();
    expect(uris).toEqual([`${sqliteUri(half)}?mode=ro`]);
  });
  test("path with spaces, unicode, #, % and ? (Windows forbids ? in names)", () => {
    const f = path.join(root, "dir with space", process.platform === "win32" ? "ünï#%.db" : "ünï#?%.db");
    mk(f).close();
    const db = kept(openRo(f, new TempRegistry(root)))!;
    expect(db.get<{ n: number }>("select count(*) n from t")!.n).toBe(1);
    db.close();
  });
  test("busy -> private copy, removed on disposeAll", () => {
    const f = path.join(root, "busy", "b.db");
    const w = mk(f);
    const t = new TempRegistry(root);
    let calls = 0;
    const db = kept(openRo(f, t, (uri) => {
      if (calls++ === 0) throw new Error("SQLITE_BUSY: database is locked");
      return openUriReadOnly(uri);
    }))!;
    expect(db.copied).toBe(true);
    expect(db.immutable).toBe(false);
    expect(t.active).toBe(1);
    expect(db.get<{ n: number }>("select count(*) n from t")!.n).toBe(1);
    db.close();
    t.disposeAll();
    expect(t.active).toBe(0);
    w.close();
  });
  test("the copy limit counts the -wal: a busy store whose store and -wal exceed it is never copied", () => {
    const f = path.join(root, "limit", "s.db");
    mkdirSync(path.dirname(f), { recursive: true });
    const w = kept(new Database(f));
    w.exec("PRAGMA page_size=4096");
    w.exec("PRAGMA user_version=7"); // the header page only
    w.close();
    writeFileSync(f + "-wal", new Uint8Array(8_192));
    expect([statSync(f).size, statSync(f + "-wal").size]).toEqual([4_096, 8_192]);
    const busyFirst = () => {
      let calls = 0;
      return (uri: string) => {
        if (calls++ === 0) throw new Error("SQLITE_BUSY: database is locked");
        return openUriReadOnly(uri);
      };
    };
    const t = new TempRegistry(root);
    // the store alone is under the limit, the store and its -wal are over it
    expect(openRo(f, t, busyFirst(), { maxCopyBytes: 8_192 })).toBeNull();
    expect(t.active).toBe(0);
    const db = kept(openRo(f, t, busyFirst(), { maxCopyBytes: 16_384 }))!;
    expect(db.copied).toBe(true);
    db.close();
    t.disposeAll();
  });
  test("busy at schema_version also falls back; other errors -> null", () => {
    const f = path.join(root, "busy2", "b.db");
    mk(f, false).close(); // rollback journal: the mode=ro path on every SQLite build
    const t = new TempRegistry(root);
    const other = kept(openRo(f, t, () => {
      throw new Error("file is not a database");
    }));
    expect(other).toBeNull();
    expect(t.active).toBe(0);
    let calls = 0;
    const db = kept(openRo(f, t, (uri) => {
      const d = openUriReadOnly(uri);
      if (calls++ === 0) {
        const orig = d.query.bind(d);
        (d as any).query = () => {
          throw new Error("database is locked");
        };
        void orig;
      }
      return d;
    }))!;
    expect(db.copied).toBe(true);
    db.close();
    t.disposeAll();
  });
  test("tables / columns", () => {
    const f = path.join(root, "meta", "m.db");
    mk(f).close();
    const db = kept(openRo(f, new TempRegistry(root)))!;
    expect(db.tables()).toEqual(["t"]);
    expect(db.columns("t")).toEqual(["id", "name"]);
    db.close();
  });
  test("MAX_COPY_BYTES", () => {
    expect(MAX_COPY_BYTES).toBe(2_147_483_648);
    expect(existsSync(root)).toBe(true);
  });
});

describe("RoDb runs reads only", () => {
  /** A rollback-journal store with table `t` (one row), opened read-only, beside a second store `secret.key` with a credential row. */
  function stores(name: string): { db: RoDb; secret: string; dir: string } {
    const dir = path.join(root, "reads-only", name);
    mk(path.join(dir, "allowed.db"), false).close();
    const secret = path.join(dir, "secret.key");
    const s = kept(new Database(secret));
    s.exec("CREATE TABLE creds (tok TEXT)");
    s.exec("INSERT INTO creds VALUES ('synthetic-token')");
    s.close();
    return { db: kept(openRo(path.join(dir, "allowed.db"), new TempRegistry(root)))!, secret, dir };
  }
  const attached = (db: RoDb): string[] => db.all<{ name: string }>("SELECT name FROM pragma_database_list").map((r) => r.name);
  /** The statements `run` did not refuse with ReadOnlyQueryError. */
  const notRefused = (statements: string[], run: (sql: string) => unknown): string[] => statements.filter((sql) => {
    try {
      run(sql);
      return true;
    } catch (e) {
      return !(e instanceof ReadOnlyQueryError);
    }
  });

  test("ATTACH is refused before it runs, however it is written, a stacked one too: no other file is opened through SQL", () => {
    const { db, secret } = stores("attach");
    const seen: string[] = [];
    __observeQueries((s) => seen.push(s));
    const attach = ["ATTACH DATABASE ? AS x", "  attach ? as x", "/* x */ ATTACH DATABASE ? AS x", "SELECT 1; ATTACH DATABASE ? AS x"];
    expect(notRefused(attach, (sql) => db.all(sql, secret))).toEqual([]);
    expect(seen).toContain("ATTACH DATABASE ? AS x"); // the query observer still sees what was refused
    expect(attached(db)).toEqual(["main"]);
    expect(() => db.all("SELECT tok FROM x.creds")).toThrow(); // no such database: nothing was attached
  });

  test("VACUUM INTO is refused: it would write a copy of the store even through a read-only handle", () => {
    const { db, dir } = stores("vacuum");
    const copy = path.join(dir, "copy.db");
    expect(() => db.get("VACUUM INTO ?", copy)).toThrow(ReadOnlyQueryError);
    expect(existsSync(copy)).toBe(false);
  });

  test("every statement that is not a read is refused: DETACH, writes, schema changes, other PRAGMAs, a second statement", () => {
    const { db } = stores("others");
    const statements = [
      "DETACH DATABASE x", "VACUUM", "INSERT INTO t VALUES (2, 'b')", "CREATE TEMP TABLE z (q)", "REINDEX", "ANALYZE",
      "PRAGMA journal_mode=WAL", "PRAGMA writable_schema = 1", "PRAGMA database_list", "PRAGMA table_info(t); SELECT 1", "SELECT id FROM t;",
    ];
    expect(notRefused(statements, (sql) => db.all(sql))).toEqual([]);
    expect(notRefused(statements, (sql) => db.get(sql))).toEqual([]);
    expect(attached(db)).toEqual(["main"]);
  });

  test("reads run: SELECT and WITH in any case and spacing, and the readers' PRAGMAs in their read form", () => {
    const { db } = stores("reads");
    expect(db.all<{ id: number }>("select id from t")).toEqual([{ id: 1 }]);
    expect(db.get<{ n: number }>("\n  WITH x AS (SELECT id AS n FROM t) SELECT n FROM x")).toEqual({ n: 1 });
    expect(db.all<{ name: string }>("PRAGMA table_info(t)").map((r) => r.name)).toEqual(["id", "name"]);
    expect(db.all("PRAGMA index_list(t)")).toEqual([]);
    expect([db.tables(), db.columns("t")]).toEqual([["t"], ["id", "name"]]);
  });

  test("the connection behind a handle is a true private field: no cast reaches it, so no statement skips the read check", () => {
    const { db } = stores("private");
    const open = db as unknown as Record<string, unknown>;
    expect(Object.values(open).filter((v) => v instanceof Database)).toEqual([]);
    expect(open.db).toBeUndefined();
  });
});
