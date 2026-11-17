import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { __observeQueries, MAX_COPY_BYTES, openRo, sqliteUri } from "../../../core/io/sqlite";
import { TempRegistry } from "../../../core/io/temp";

const root = mkdtempSync(path.join(os.tmpdir(), "sqlite-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => __observeQueries(undefined));

function mk(file: string, wal = true): Database {
  mkdirSync(path.dirname(file), { recursive: true });
  const w = new Database(file);
  if (wal) w.exec("PRAGMA journal_mode=WAL");
  w.exec("CREATE TABLE t (id INTEGER, name TEXT)");
  w.exec("INSERT INTO t VALUES (1, 'a')");
  return w;
}

describe("sqliteUri", () => {
  test("windows drive path", () => {
    expect(sqliteUri("C:\\a b\\x.db")).toBe("file:///C:/a%20b/x.db");
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
    const db = openRo(f, t)!;
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
  test("closed WAL store (no -wal left): opened immutable, read-only, nothing created beside it", () => {
    const f = path.join(root, "closed", "c.db");
    const w = mk(f);
    w.exec("INSERT INTO t VALUES (2, 'b')");
    w.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    w.close();
    // a writer that closes cleanly removes its -wal and -shm (some SQLite builds keep them; remove them as such a writer does)
    rmSync(f + "-wal", { force: true });
    rmSync(f + "-shm", { force: true });
    const t = new TempRegistry(root);
    const db = openRo(f, t)!;
    expect(db).not.toBeNull();
    expect([db.immutable, db.copied]).toEqual([true, false]);
    expect(db.get<{ n: number }>("select count(*) n from t")!.n).toBe(2);
    expect(db.columns("t")).toEqual(["id", "name"]);
    db.close();
    expect([existsSync(f + "-wal"), existsSync(f + "-shm"), t.active]).toEqual([false, false, 0]);
  });
  test("cannot-open falls back to immutable only when there is no -wal; other failures do not", () => {
    const f = path.join(root, "cant", "c.db");
    mk(f, false).close();
    const t = new TempRegistry(root);
    const cantOpen = () => Object.assign(new Error("unable to open database file"), { code: "SQLITE_CANTOPEN" });
    const uris: string[] = [];
    const ro = `${sqliteUri(f)}?mode=ro`;
    const db = openRo(f, t, (uri) => {
      uris.push(uri);
      if (uris.length === 1) throw cantOpen();
      return new Database(uri, { readonly: true });
    })!;
    expect([db.immutable, db.copied]).toEqual([true, false]);
    expect(uris).toEqual([ro, `${ro}&immutable=1`]);
    db.close();

    writeFileSync(f + "-wal", "");
    uris.length = 0;
    expect(openRo(f, t, (uri) => { uris.push(uri); throw cantOpen(); })).toBeNull();
    expect(uris).toEqual([ro]);
    rmSync(f + "-wal");

    uris.length = 0;
    expect(openRo(f, t, (uri) => { uris.push(uri); throw new Error("file is not a database"); })).toBeNull();
    expect(uris).toEqual([ro]);

    const junk = path.join(root, "cant", "junk.db");
    writeFileSync(junk, "not a database");
    expect(openRo(junk, t, (uri) => {
      if (!uri.includes("immutable")) throw cantOpen();
      return new Database(uri, { readonly: true });
    })).toBeNull();
    expect(t.active).toBe(0);
  });
  test("path with spaces, unicode, # and ?", () => {
    const f = path.join(root, "dir with space", "ünï#?.db");
    mk(f).close();
    const db = openRo(f, new TempRegistry(root))!;
    expect(db.get<{ n: number }>("select count(*) n from t")!.n).toBe(1);
    db.close();
  });
  test("busy -> private copy, removed on disposeAll", () => {
    const f = path.join(root, "busy", "b.db");
    const w = mk(f);
    const t = new TempRegistry(root);
    let calls = 0;
    const db = openRo(f, t, (uri) => {
      if (calls++ === 0) throw new Error("SQLITE_BUSY: database is locked");
      return new Database(uri, { readonly: true });
    })!;
    expect(db.copied).toBe(true);
    expect(db.immutable).toBe(false);
    expect(t.active).toBe(1);
    expect(db.get<{ n: number }>("select count(*) n from t")!.n).toBe(1);
    db.close();
    t.disposeAll();
    expect(t.active).toBe(0);
    w.close();
  });
  test("busy at schema_version also falls back; other errors -> null", () => {
    const f = path.join(root, "busy2", "b.db");
    mk(f).close();
    const t = new TempRegistry(root);
    const other = openRo(f, t, () => {
      throw new Error("file is not a database");
    });
    expect(other).toBeNull();
    expect(t.active).toBe(0);
    let calls = 0;
    const db = openRo(f, t, (uri) => {
      const d = new Database(uri, { readonly: true });
      if (calls++ === 0) {
        const orig = d.query.bind(d);
        (d as any).query = () => {
          throw new Error("database is locked");
        };
        void orig;
      }
      return d;
    })!;
    expect(db.copied).toBe(true);
    db.close();
    t.disposeAll();
  });
  test("tables / columns", () => {
    const f = path.join(root, "meta", "m.db");
    mk(f).close();
    const db = openRo(f, new TempRegistry(root))!;
    expect(db.tables()).toEqual(["t"]);
    expect(db.columns("t")).toEqual(["id", "name"]);
    db.close();
  });
  test("MAX_COPY_BYTES", () => {
    expect(MAX_COPY_BYTES).toBe(2_147_483_648);
    expect(existsSync(root)).toBe(true);
  });
});
