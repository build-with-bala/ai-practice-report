import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { __observeQueries, MAX_COPY_BYTES, openRo, openUriReadOnly, sqliteUri } from "../../../core/io/sqlite";
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
