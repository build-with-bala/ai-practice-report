import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
    expect(t.active).toBe(0);
    db.close();
    w.close();
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
