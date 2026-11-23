import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectEnv } from "../../../core/env/env";
import type { RoDb } from "../../../core/io/sqlite";
import { TempRegistry } from "../../../core/io/temp";
import { Tally } from "../../../core/sources/common/coverage";
import { cmpCodePoints, PAGE, Pass, q, readStore } from "../../../core/sources/common/sqlite";
import { scan } from "../../../core/scan";
import { agCli } from "../../../core/sources/antigravity";
import { cuIde, cuTracking } from "../../../core/sources/cursor";
import { stepsRel } from "../../fixtures/antigravity";
import { globalRel, trackingRel } from "../../fixtures/cursor";
import { pbEncode } from "../../kit/pb";
import { fakeHome, type FakeHome } from "../../kit/home";
import type { ScanCtx } from "../../../core/sources/types";
import { lockAboveCopyLimit } from "../../kit/home";

const SQL = "SELECT rowid AS rid FROM \"t\" WHERE rowid > ? ORDER BY rowid LIMIT ?";
const BUSY = "SQLITE_BUSY: database is locked";

const busy = (ms: number): void => {
  const end = performance.now() + ms;
  while (performance.now() < end) { /* a query that holds the thread, as a large page does */ }
};

/**
 * A store that answers rowid pages: the n-th query (1-based) returns `sizes[n - 1]` rows (none past the list), or
 * `sizes(n)` rows, each one holding the thread for `ms` first; `fail` replaces the n-th query with that error. Every
 * query's parameters are kept.
 */
function stubDb(sizes: number[] | ((n: number) => number), o: { ms?: number; fail?: Map<number, Error> } = {}): RoDb & { params: unknown[][] } {
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
      const n = typeof sizes === "function" ? sizes(params.length) : sizes[params.length - 1] ?? 0;
      return Array.from({ length: n }, () => ({ rid: ++rid })) as T[];
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
    // Ordering only, never wall-clock: the store hands out full pages until the timer has fired, then a short last page.
    // A pass that never gave the event loop a turn would read all MAX_PAGES full pages with the timer still pending.
    const MAX_PAGES = 100;
    let fired = false;
    let firedBefore: number | undefined; // the query that first saw the timer fired
    const db = stubDb((n) => {
      if (fired && firedBefore === undefined) firedBefore = n;
      return fired || n > MAX_PAGES ? 7 : PAGE;
    }, { ms: 30 });
    const tally = tallyOf();
    setTimeout(() => { fired = true; }, 1);
    const pages: number[] = [];
    let firedFirst: boolean | undefined;
    const done = await new Pass(db, "t", tally, ctxFor(), "t.db-query").byRowid(SQL, (rows) => pages.push(rows.length)).then((v) => {
      firedFirst = fired; // read as the pass resolves
      return v;
    });
    expect(firedFirst).toBe(true);
    expect(firedBefore).toBeDefined(); // the timer ran while the pass still had pages to read
    const full = firedBefore! - 1;
    expect(done).toBe(true);
    expect(pages).toEqual([...Array.from({ length: full }, () => PAGE), 7]);
    expect(tally.records).toBe(full * PAGE + 7);
    // each page resumes after the last rowid read, PAGE rows at a time
    expect(db.params).toEqual(Array.from({ length: full + 1 }, (_, i) => [i === 0 ? Number.MIN_SAFE_INTEGER : i * PAGE, PAGE]));
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

/** A store that answers key pages from `pages`: the n-th query returns `pages[n - 1]` as `{ key }` rows (none past the list). */
function keyStub(pages: unknown[][]): RoDb & { params: unknown[][] } {
  const params: unknown[][] = [];
  return {
    params, copied: false, immutable: false,
    all<T>(_sql: string, ...p: unknown[]): T[] {
      params.push(p);
      return (pages[params.length - 1] ?? []).map((key) => ({ key })) as T[];
    },
    get: () => undefined, tables: () => [], columns: () => [], close: () => {},
  };
}

const KEY_SQL = "SELECT key FROM kv WHERE key > ? AND key < ? ORDER BY key LIMIT ?";

describe("Pass: pages that must advance", () => {
  test("byKey: each page resumes after the last key read, inside the range; a short page ends it: true", async () => {
    const db = keyStub([["a:1", "a:2"], ["a:3", "a:4"], ["a:5"]]);
    const tally = tallyOf();
    const seen: unknown[] = [];
    expect(await new Pass(db, "kv", tally, ctxFor(), "t.db-query", { page: 2 }).byKey(KEY_SQL, "a:", "a;", (rows) => seen.push(...rows.map((r) => r.key)))).toBe(true);
    expect(seen).toEqual(["a:1", "a:2", "a:3", "a:4", "a:5"]);
    expect(db.params).toEqual([["a:", "a;", 2], ["a:2", "a;", 2], ["a:4", "a;", 2]]);
    expect([tally.records, tally.unknownTypes]).toEqual([5, {}]);
  });

  test("byKey: a last key that does not sort after the start (as Bun reads text that is not UTF-8), or lies outside the range, ends the pass as drift page-stalled", async () => {
    for (const bad of ["", "a:", "a:0", "a;", "b", 7]) {
      const db = keyStub([["a:1", "a:2"], ["a:3", bad]]);
      const tally = tallyOf();
      const logs: string[] = [];
      const pass = new Pass(db, "kv", tally, ctxFor({ logs }), "t.db-query", { page: 2 });
      let rows = 0;
      expect(await pass.byKey(KEY_SQL, "a:", "a;", (r) => { rows += r.length; })).toBe(false);
      expect(rows).toBe(4); // the rows already handed on stay
      expect([db.params.length, pass.failed, tally.unknownTypes, logs]).toEqual([2, true, { "page-stalled:kv": 1 }, ["t.db-query"]]);
    }
  });

  test("byRowid: a last rowid that is not a safe integer, or does not rise, ends the pass as drift page-stalled; a prefix goes before the pass's drift keys", async () => {
    for (const bad of [2 ** 62, Number.MAX_SAFE_INTEGER + 1, 1, 2, -5, "3", 2.5]) {
      const params: unknown[][] = [];
      const db: RoDb = {
        copied: false, immutable: false,
        all<T>(_sql: string, ...p: unknown[]): T[] { params.push(p); return (params.length === 1 ? [{ rid: 1 }, { rid: 2 }] : [{ rid: 3 }, { rid: bad }]) as T[]; },
        get: () => undefined, tables: () => [], columns: () => [], close: () => {},
      };
      const tally = tallyOf();
      expect(await new Pass(db, "t", tally, ctxFor(), "t.db-query", { page: 2, driftPrefix: "store." }).byRowid(SQL, () => {})).toBe(false);
      expect([params.length, tally.records, tally.unknownTypes]).toEqual([2, 4, { "store.page-stalled:t": 1 }]);
    }
  });

  test("cmpCodePoints orders as UTF-8 bytes do, not as UTF-16 units", () => {
    expect(cmpCodePoints("\u{1F600}", "\uFFFD")).toBeGreaterThan(0); // UTF-16 units would put the pair first
    expect(cmpCodePoints("ab", "abc")).toBeLessThan(0);
    expect(cmpCodePoints("ab", "ab")).toBe(0);
    expect(cmpCodePoints("b", "a\u{1F600}")).toBeGreaterThan(0);
  });
});

describe("Pass: stores whose pages cannot advance end, with drift, in every reader", () => {
  let h: FakeHome;
  afterEach(() => h?.cleanup());
  const big = 2n ** 62n;

  test("an Antigravity step store whose rowids lie above 2^53", async () => {
    h = fakeHome();
    const id = "11111111-2222-4333-8444-555555555555";
    const db = new Database(h.sqlite(stepsRel(id), ["CREATE TABLE steps (idx INTEGER, step_type INTEGER NOT NULL DEFAULT 0, status INTEGER NOT NULL DEFAULT 0, metadata BLOB, error_details BLOB, step_payload BLOB)"]));
    const now = Date.now();
    const ins = db.query("INSERT INTO steps (rowid, idx, step_type, status, metadata) VALUES (?, ?, 8, 3, ?)");
    for (let i = 1; i <= 40; i++) ins.run(big + BigInt(i), i, pbEncode([[1, pbEncode([[1, Math.floor((now - 3_600_000 + i * 1000) / 1000)], [2, 0]])]]));
    db.close();
    const r = await scan({ env: h.env, plugins: [agCli], repoSignals: false, handleSignals: false });
    const cov = r.coverage.find((c) => c.window === "detail")!;
    expect(cov.status).toBe("drift");
    expect(cov.unknownTypes["page-stalled:steps"]).toBe(1);
    expect(cov.records).toBeLessThanOrEqual(40);
    expect(r.store.all("tool").length).toBeLessThanOrEqual(40);
  });

  test("a Cursor store whose composer keys are not valid UTF-8", async () => {
    h = fakeHome();
    const db = new Database(h.sqlite(globalRel(h), ["CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)", "CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)"]));
    const hex = (x: string) => Buffer.from(x, "utf8").toString("hex");
    const value = JSON.stringify({ createdAt: Date.now() - 60_000, lastUpdatedAt: Date.now() - 30_000 });
    const ROWS = PAGE + 100;
    db.exec("BEGIN");
    for (let i = 0; i < ROWS; i++) db.query(`INSERT INTO cursorDiskKV (key, value) VALUES (CAST(x'${hex("composerData:")}ff${hex(String(i).padStart(6, "0"))}' AS TEXT), ?)`).run(value);
    db.exec("COMMIT");
    db.close();
    const r = await scan({ env: h.env, plugins: [cuIde], repoSignals: false, handleSignals: false });
    const life = r.coverage.find((c) => c.window === "lifetime")!;
    expect(life.status).toBe("drift");
    expect(life.unknownTypes["page-stalled:cursorDiskKV"]).toBe(1);
    expect(life.records).toBeLessThanOrEqual(ROWS);
  });

  test("a Cursor tracking store with more than a page of rows above 2^53; the same rows at ordinary rowids are all read", async () => {
    const ROWS = PAGE * 2 + 500;
    for (const base of [0n, big]) {
      h = fakeHome();
      const db = new Database(h.sqlite(trackingRel, ["CREATE TABLE scored_commits (commitHash TEXT, commitDate INTEGER, scoredAt INTEGER, tabLinesAdded INTEGER, composerLinesAdded INTEGER, humanLinesAdded INTEGER)"]));
      const now = Date.now();
      const ins = db.query("INSERT INTO scored_commits (rowid, commitHash, commitDate, tabLinesAdded, humanLinesAdded) VALUES (?, ?, ?, 1, 1)");
      db.exec("BEGIN");
      for (let i = 1; i <= ROWS; i++) ins.run(base + BigInt(i), `h${i}`, now - 86_400_000 + i);
      db.exec("COMMIT");
      db.close();
      const r = await scan({ env: h.env, plugins: [cuTracking], repoSignals: false, handleSignals: false });
      const cov = r.coverage[0]!;
      if (base === 0n) expect([cov.status, cov.records, r.store.all("commit").length]).toEqual(["ok", ROWS, ROWS]);
      else {
        expect([cov.status, cov.unknownTypes]).toEqual(["drift", { "page-stalled:scored_commits": 1 }]);
        expect(cov.records).toBe(PAGE); // the first page stays; nothing is read twice
      }
      h.cleanup();
    }
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

  test.skipIf(process.platform === "win32")("a locked store above the copy limit is never copied: skipped too-large, note too-large, warn <prefix>.db-too-large", async () => {
    const root = scratch();
    const file = path.join(root, "big.db");
    const w = new Database(file);
    w.exec("CREATE TABLE t (a INTEGER)");
    w.close();
    const release = lockAboveCopyLimit(file);
    const logs: string[] = [];
    const tally = tallyOf();
    let read: boolean;
    try {
      read = await readStore(file, ctxFor({ logs, tmp: root }), tally, "zz", () => {});
    } finally {
      release();
    }
    expect([read, tally.skipped, tally.note, tally.files, logs]).toEqual([false, { "too-large": 1 }, "too-large", 0, ["zz.db-too-large"]]);
  });

  test("a linked store counts the bytes of its target, not of the link", async () => {
    const root = scratch();
    const target = path.join(root, "real", "store.db");
    mkdirSync(path.dirname(target));
    const w = new Database(target);
    w.exec("CREATE TABLE t (a INTEGER)");
    w.close();
    const link = path.join(root, "store.db");
    try {
      symlinkSync(target, link);
    } catch (e) {
      if (process.platform !== "win32") throw e;
      return; // where no link can be made there is no linked store
    }
    expect(lstatSync(link).size).not.toBe(statSync(target).size); // so the count below tells them apart
    const tally = tallyOf();
    expect(await readStore(link, ctxFor({ tmp: root }), tally, "zz", () => {})).toBe(true);
    expect([tally.files, tally.bytes]).toEqual([1, statSync(target).size]);
  });
});

test("q quotes an identifier, doubling the quotes inside it", () => {
  expect(q('a"b')).toBe('"a""b"');
  expect(q("threads")).toBe('"threads"');
});
