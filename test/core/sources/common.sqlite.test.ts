import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectEnv } from "../../../core/env/env";
import type { RoDb } from "../../../core/io/sqlite";
import { TempRegistry } from "../../../core/io/temp";
import { Tally } from "../../../core/sources/common/coverage";
import { PAGE, Pass, q, readStore } from "../../../core/sources/common/sqlite";
import type { ScanCtx } from "../../../core/sources/types";

const SQL = "SELECT rowid AS rid FROM \"t\" WHERE rowid > ? ORDER BY rowid LIMIT ?";
const BUSY = "SQLITE_BUSY: database is locked";

const busy = (ms: number): void => {
  const end = performance.now() + ms;
  while (performance.now() < end) { /* a query that holds the thread, as a large page does */ }
};

/**
 * A store that answers rowid pages: the n-th query (1-based) returns `sizes[n - 1]` rows (none past the list), each one
 * holding the thread for `ms` first; `fail` replaces the n-th query with that error. Every query's parameters are kept.
 */
function stubDb(sizes: number[], o: { ms?: number; fail?: Map<number, Error> } = {}): RoDb & { params: unknown[][] } {
  let rid = 0;
  const params: unknown[][] = [];
  return {
    params,
    copied: false,
    immutable: false,
    all<T>(_sql: string, ...p: unknown[]): T[] {
      params.push(p);
      if (o.ms !== undefined) busy(o.ms);
      const err = o.fail?.get(params.length);
      if (err) throw err;
      return Array.from({ length: sizes[params.length - 1] ?? 0 }, () => ({ rid: ++rid })) as T[];
    },
    get: () => undefined,
    tables: () => [],
    columns: () => [],
    close: () => {},
  };
}

function ctxFor(o: { signal?: AbortSignal; logs?: string[]; tmp?: string } = {}): ScanCtx {
  const tmp = o.tmp ?? os.tmpdir();
  return {
    env: detectEnv({ tmp, wslHomes: [] }), now: Date.now(), salt: new Uint8Array(32), signal: o.signal ?? new AbortController().signal,
    temp: new TempRegistry(tmp), emit: () => {}, hash: (v) => v, registerCwd: (cwd) => cwd,
    log: (_level, code) => { o.logs?.push(code); },
  };
}

const tallyOf = () => new Tally("codex", "test.pass", "lifetime");

describe("Pass", () => {
  test("each page waits for a turn of the event loop once the slice is used up: a timer armed before a long pass fires during it", async () => {
    const db = stubDb([PAGE, PAGE, PAGE, 7], { ms: 30 });
    const tally = tallyOf();
    let fired = false;
    setTimeout(() => { fired = true; }, 1);
    const pages: number[] = [];
    let firedFirst: boolean | undefined;
    const done = await new Pass(db, "t", tally, ctxFor(), "t.db-query").byRowid(SQL, (rows) => pages.push(rows.length)).then((v) => {
      firedFirst = fired; // read as the pass resolves, before any other timer could run
      return v;
    });
    expect(firedFirst).toBe(true);
    expect(done).toBe(true);
    expect(pages).toEqual([PAGE, PAGE, PAGE, 7]);
    expect(tally.records).toBe(3 * PAGE + 7);
    // each page resumes after the last rowid read, PAGE rows at a time
    expect(db.params).toEqual([[Number.MIN_SAFE_INTEGER, PAGE], [PAGE, PAGE], [2 * PAGE, PAGE], [3 * PAGE, PAGE]]);
  });

  test("an abort inside a page's mapping ends the pass before the next full page: false", async () => {
    const ac = new AbortController();
    const db = stubDb([PAGE, PAGE, PAGE, 7]);
    let calls = 0;
    const done = await new Pass(db, "t", tallyOf(), ctxFor({ signal: ac.signal }), "t.db-query").byRowid(SQL, () => {
      if (++calls === 1) ac.abort();
    });
    expect(done).toBe(false);
    expect(db.params.length).toBeLessThanOrEqual(2);
    expect(calls).toBe(1);
  });

  test("the first query failing other than busy is drift table-unreadable; a busy page is an io-error; either ends the pass", async () => {
    const t1 = tallyOf();
    const logs: string[] = [];
    const p1 = new Pass(stubDb([PAGE], { fail: new Map([[1, new Error("no such column: rowid")]]) }), "t", t1, ctxFor({ logs }), "t.db-query");
    expect(await p1.byRowid(SQL, () => {})).toBe(false);
    expect(t1.unknownTypes["table-unreadable:t"]).toBe(1);
    expect([p1.unreadable, p1.failed, t1.skipped, t1.records]).toEqual([true, true, {}, 0]);
    expect(logs).toEqual(["t.db-query"]);

    const t2 = tallyOf();
    const db2 = stubDb([PAGE, PAGE, 7], { fail: new Map([[2, new Error(BUSY)]]) });
    const p2 = new Pass(db2, "t", t2, ctxFor(), "t.db-query");
    const pages: number[] = [];
    expect(await p2.byRowid(SQL, (rows) => pages.push(rows.length))).toBe(false);
    expect(t2.skipped["io-error"]).toBe(1);
    expect([p2.unreadable, p2.failed, t2.unknownTypes, t2.records, pages]).toEqual([false, true, {}, PAGE, [PAGE]]);
    // the pass is over: it queries nothing more
    expect(await p2.byRowid(SQL, () => {})).toBe(false);
    expect(p2.lookup("SELECT 1", [])).toBeUndefined();
    expect(db2.params).toHaveLength(2);
  });

  test("a busy first query is an io-error, not drift; so is any later failure", async () => {
    const t1 = tallyOf();
    const p1 = new Pass(stubDb([PAGE], { fail: new Map([[1, new Error(BUSY)]]) }), "t", t1, ctxFor(), "t.db-query");
    expect(await p1.byRowid(SQL, () => {})).toBe(false);
    expect([t1.skipped, t1.unknownTypes, p1.unreadable]).toEqual([{ "io-error": 1 }, {}, false]);
    const t2 = tallyOf();
    const p2 = new Pass(stubDb([PAGE, PAGE], { fail: new Map([[2, new Error("disk I/O error")]]) }), "t", t2, ctxFor(), "t.db-query");
    expect(await p2.byRowid(SQL, () => {})).toBe(false);
    expect([t2.skipped, t2.unknownTypes, p2.unreadable]).toEqual([{ "io-error": 1 }, {}, false]);
  });

  test("options: the page size, and the code a busy failure logs", async () => {
    const db = stubDb([3, 3, 1]);
    const tally = tallyOf();
    expect(await new Pass(db, "t", tally, ctxFor(), "t.db-query", { page: 3 }).byRowid(SQL, () => {})).toBe(true);
    expect(db.params).toEqual([[Number.MIN_SAFE_INTEGER, 3], [3, 3], [6, 3]]);
    expect(tally.records).toBe(7);
    const logs: string[] = [];
    const ctx = ctxFor({ logs });
    await new Pass(stubDb([], { fail: new Map([[1, new Error(BUSY)]]) }), "t", tallyOf(), ctx, "t.db-query", { busyLogCode: "t.db-busy" }).byRowid(SQL, () => {});
    await new Pass(stubDb([], { fail: new Map([[1, new Error("no such table: t")]]) }), "t", tallyOf(), ctx, "t.db-query", { busyLogCode: "t.db-busy" }).byRowid(SQL, () => {});
    expect(logs).toEqual(["t.db-busy", "t.db-query"]);
  });
});

describe("readStore", () => {
  const roots: string[] = [];
  afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
  const scratch = () => {
    const r = mkdtempSync(path.join(os.tmpdir(), "common-sqlite-"));
    roots.push(r);
    return r;
  };

  test("a store that cannot be opened: io-error, warn <prefix>.db-unopenable; one that fails while read: <prefix>.db-unreadable", async () => {
    const root = scratch();
    const junk = path.join(root, "junk.db");
    writeFileSync(junk, "not a database");
    const logs: string[] = [];
    const t1 = tallyOf();
    expect(await readStore(junk, ctxFor({ logs, tmp: root }), t1, "zz", () => {})).toBe(false);
    expect([t1.skipped, t1.files, logs]).toEqual([{ "io-error": 1 }, 0, ["zz.db-unopenable"]]);

    const ok = path.join(root, "ok.db");
    const w = new Database(ok);
    w.exec("CREATE TABLE t (a INTEGER)");
    w.close();
    logs.length = 0;
    const t2 = tallyOf();
    let tables: string[] = [];
    // the body is awaited before the store is closed: it reads after a turn of the event loop
    expect(await readStore(ok, ctxFor({ logs, tmp: root }), t2, "zz", async (db, names) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      tables = [...names];
      db.all("SELECT a FROM t");
      throw new Error("a read failed");
    })).toBe(true);
    expect([tables, t2.files, t2.skipped, logs]).toEqual([["t"], 1, { "io-error": 1 }, ["zz.db-unreadable"]]);
  });
});

test("q quotes an identifier, doubling the quotes inside it", () => {
  expect(q('a"b')).toBe('"a""b"');
  expect(q("threads")).toBe('"threads"');
});
