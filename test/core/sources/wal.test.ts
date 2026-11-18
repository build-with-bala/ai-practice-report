import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, rmSync, statSync } from "node:fs";
import { openUriReadOnly, sqliteUri } from "../../../core/io/sqlite";
import { scan } from "../../../core/scan";
import { cxThreads } from "../../../core/sources/codex";
import { fixtureStart } from "../../fixtures/claude-code";
import { THREAD_COLUMNS, threadRow, uuidV7 } from "../../fixtures/codex";
import { fakeHome, type FakeHome } from "../../kit/home";

let h: FakeHome;
beforeEach(() => { h = fakeHome(); });
afterEach(() => h.cleanup());

const STATE = ".codex/state_5.sqlite";
/** The thread index's two read tables; `threads` holds every column the CLI writes, untyped but for its key. */
const DDL = [
  `CREATE TABLE threads (${THREAD_COLUMNS.map((c) => (c === "id" ? "id TEXT PRIMARY KEY" : c)).join(", ")})`,
  "CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL PRIMARY KEY, status TEXT NOT NULL)",
];
const row = (id: string, at: number): unknown[] => {
  const r = threadRow(id, at);
  return THREAD_COLUMNS.map((c) => r[c] ?? null);
};
const run = () => scan({ env: h.env, plugins: [cxThreads] });
const covOf = (r: Awaited<ReturnType<typeof run>>) => r.coverage.find((c) => c.source === "codex.threads")!;

/** Rows of `threads` in the store file alone: an immutable open reads no -wal. */
function rowsInFile(file: string): number {
  const db = openUriReadOnly(`${sqliteUri(file)}?mode=ro&immutable=1`);
  try {
    return (db.query("SELECT COUNT(*) AS n FROM threads").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

test("a live store: a row that lives only in its -wal is read while the writer holds the store open", async () => {
  const at = fixtureStart();
  const live = h.sqliteLive(STATE, DDL, { threads: [row(uuidV7(at, 0xa1), at)] });
  try {
    live.insert("threads", row(uuidV7(at + 1_000, 0xa2), at + 1_000)); // checkpoints are off: this row is in the -wal only
    expect([rowsInFile(live.path), statSync(`${live.path}-wal`).size > 0]).toEqual([1, true]);
    const r = await run();
    expect(r.store.all("codex-thread-row")).toHaveLength(2);
    expect(covOf(r)).toMatchObject({ status: "ok", files: 1, records: 2 });
  } finally {
    live.close();
  }
});

test("a closed WAL store: its rows are read, and nothing is left beside it", async () => {
  const at = fixtureStart();
  const file = h.sqlite(STATE, DDL, { threads: [row(uuidV7(at, 0xb1), at), row(uuidV7(at + 1_000, 0xb2), at + 1_000)] }, true);
  // Apple's SQLite keeps empty -wal and -shm files on close; the stock build removes them, as a writer that closed its store leaves none
  rmSync(`${file}-wal`, { force: true });
  rmSync(`${file}-shm`, { force: true });
  const r = await run();
  expect(r.store.all("codex-thread-row")).toHaveLength(2);
  expect(covOf(r)).toMatchObject({ status: "ok", files: 1, records: 2 });
  expect([existsSync(`${file}-wal`), existsSync(`${file}-shm`)]).toEqual([false, false]);
});
