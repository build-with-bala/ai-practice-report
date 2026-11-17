import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, statSync, symlinkSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { __observeQueries } from "../../../core/io/sqlite";
import type { ConfigEv, CoverageEv, Ev } from "../../../core/model/events";
import { scan } from "../../../core/scan";
import { cxConfig, cxHistory, cxRollouts, cxThreads } from "../../../core/sources/codex";
import { TomlHeaders } from "../../../core/sources/codex/config";
import { registry } from "../../../core/sources/registry";
import type { ScanCtx, SourcePlugin } from "../../../core/sources/types";
import { keyedHash } from "../../../core/text/hash";
import { CANARY, expectNoCanaries } from "../../kit/canary";
import { fakeHome, type FakeHome } from "../../kit/home";
import { fixtureStart } from "../../fixtures/claude-code";
import {
  buildCodexIndex, CX_MAX, CX_MINI, cxHistoryLine, CxRollout, localTime, MANAGED_SANDBOX, THREAD_COLUMNS, threadRow, turnRow, uuidV7,
  writeStateDb, writeTurnsDb,
} from "../../fixtures/codex";

let h: FakeHome;
beforeEach(() => { h = fakeHome(); });
afterEach(() => {
  __observeQueries(undefined);
  h.cleanup();
});

const LIFETIME = [cxThreads, cxHistory, cxConfig];
const run = (plugins: SourcePlugin[] = LIFETIME) => scan({ env: h.env, plugins });
type Result = Awaited<ReturnType<typeof run>>;
const sidOf = (id: string) => `codex:${id}`;
const secs = (ms: number) => Math.floor(ms / 1000);
const configs = (r: Result, kind: ConfigEv["kind"]) => r.store.all("config").filter((c) => c.kind === kind);
const covOf = (r: Result, source: string) => r.coverage.find((c) => c.source === source)!;
const tally = (xs: (string | undefined)[]) => xs.reduce<Record<string, number>>((m, x) => ({ ...m, [String(x)]: (m[String(x)] ?? 0) + 1 }), {});
const skipChmod = process.platform === "win32" || process.getuid?.() === 0;
const MIN = 60_000;

/**
 * What each SELECT may name, by the table it reads: the columns the thread reader is allowed to select (written out here,
 * independently of the reader) plus `rowid`, `rid` and `in_repo`; schema lookups name only schema columns.
 */
const MAY_NAME: Record<string, readonly string[]> = {
  threads: [
    "id", "source", "originator", "model", "reasoning_effort", "approval_mode", "sandbox_policy", "tokens_used", "created_at",
    "created_at_ms", "updated_at", "updated_at_ms", "cli_version", "cwd", "git_sha", "git_branch", "git_origin_url", "rowid", "rid", "in_repo",
  ],
  thread_spawn_edges: ["parent_thread_id", "child_thread_id", "rowid", "rid"],
  thread_turns: ["thread_id", "status", "started_at", "completed_at", "duration_ms", "rowid", "rid"],
  sqlite_master: ["name", "type", "sql"],
  pragma_table_info: ["name"],
};
const SQL_WORDS = new Set(["select", "from", "where", "order", "by", "limit", "as", "and", "or", "coalesce"]);
/** The table or table-valued function a statement reads. */
const sourceOf = (sql: string): string | undefined => /\bFROM\s+(?:"([^"]+)"|([A-Za-z_]\w*))/i.exec(sql)?.slice(1).find((x) => x !== undefined);
/** Identifiers in a statement that its table's list does not allow (string literals and parameters are not identifiers). */
function unlisted(sql: string): string[] {
  const body = sql.replace(/'(?:[^']|'')*'/g, " ");
  const table = sourceOf(body);
  const allowed = new Set([table, ...(MAY_NAME[table ?? ""] ?? [])]);
  return [...body.matchAll(/"((?:[^"]|"")+)"|\b([A-Za-z_]\w*)\b/g)]
    .map((m) => (m[1] ?? m[2])!)
    .filter((w) => !SQL_WORDS.has(w.toLowerCase()) && !allowed.has(w));
}

describe("codex lifetime: Task 12 scenario", () => {
  test("lifetime sessions, edge, turns, prompts and days, config, thread rows; SQL never selects text columns; no canaries", async () => {
    const fx = buildCodexIndex(h);
    const sql: string[] = [];
    __observeQueries((s) => sql.push(s));
    const r = await run();
    __observeQueries(undefined);

    for (const table of ["threads", "thread_spawn_edges", "thread_turns", "sqlite_master", "pragma_table_info"]) {
      expect(sql.some((s) => sourceOf(s) === table)).toBe(true);
    }
    for (const s of sql) {
      expect(s).not.toContain("*");
      expect([s, unlisted(s)]).toEqual([s, []]);
    }
    // the check is not vacuous: a column outside the allowlist, even a schema word on a data table, is caught
    expect(unlisted('SELECT rowid AS rid, "id", "title", name FROM "threads" WHERE rowid > ? ORDER BY rowid LIMIT ?')).toEqual(["title", "name"]);
    expect(r.store.all("session").map((s) => [s.id, s.origin, s.window])).toEqual([
      [sidOf(fx.ids.cli), "human", "lifetime"], [sidOf(fx.ids.exec), "scripted", "lifetime"], [sidOf(fx.ids.sub), "subagent", "lifetime"],
    ]);
    expect(r.store.all("edge")).toEqual([{ k: "edge", tool: "codex", source: "codex.threads", parentId: sidOf(fx.ids.cli), childId: sidOf(fx.ids.sub) }]);
    expect(tally(r.store.all("turn").map((t) => t.status))).toEqual({ completed: 2, failed: 1, interrupted: 1 });
    expect(r.store.all("turn").every((t) => t.window === "lifetime")).toBe(true);
    const prompts = r.store.all("prompt");
    expect(prompts).toHaveLength(5);
    expect(prompts.every((p) => p.window === "lifetime" && p.origin === "human" && p.source === "codex.history")).toBe(true);
    expect(r.store.all("daily")).toHaveLength(2);
    expect(configs(r, "profile")).toHaveLength(2);
    expect(configs(r, "mcp-server").map((c) => c.name)).toEqual([CANARY.mcp]);
    expect(configs(r, "skill")).toHaveLength(1);
    expect(configs(r, "memory-file")).toHaveLength(2);
    expect(r.store.all("codex-thread-row")).toHaveLength(3);
    expect(r.store.all("totals").map((t) => t.tokens)).toEqual([123_456, 4_200, 0]);
    expect(r.store.all("session").map((s) => s.effort)).toEqual(["high", "low", "ultra"]);
    expect(r.coverage.map((c) => [c.source, c.window, c.status]).sort()).toEqual([
      ["codex.config", "lifetime", "ok"], ["codex.history", "lifetime", "ok"], ["codex.threads", "lifetime", "ok"],
    ]);
    expectNoCanaries([r.store, r.coverage, r.warnings], { allow: ["mcp"] });
  });

  test("the three readers are registered after the rollouts reader", () => {
    const at = registry.indexOf(cxRollouts);
    expect(registry.slice(at, at + 4)).toEqual([cxRollouts, cxThreads, cxHistory, cxConfig]);
    expect([cxThreads, cxHistory, cxConfig].map((p) => [p.tool, p.id, p.tier, p.beta])).toEqual([
      ["codex", "codex.threads", "P0", false], ["codex", "codex.history", "P0", false], ["codex", "codex.config", "P0", false],
    ]);
  });
});

describe("codex threads: thread index and turn history", () => {
  test("sessions: lifetime window, ms times, origin, surface, model, version, approval, sandbox type, project, repo; subagent links", async () => {
    const fx = buildCodexIndex(h);
    const r = await run([cxThreads]);
    const base = { k: "session", tool: "codex", source: "codex.threads", window: "lifetime" } as const;
    expect(r.store.session(sidOf(fx.ids.cli))).toEqual({
      ...base, id: sidOf(fx.ids.cli), origin: "human", start: fx.created.cli, end: fx.updated.cli, models: [CX_MAX], surface: "cli",
      version: "0.169.0", projectKey: keyedHash(r.salt, CANARY.path), inRepo: true, approval: "on-request", sandbox: "managed", effort: "high",
    });
    expect(r.cwds.get(keyedHash(r.salt, CANARY.path))).toBe(CANARY.path);
    expect(r.store.session(sidOf(fx.ids.exec))).toEqual({
      ...base, id: sidOf(fx.ids.exec), origin: "scripted", start: fx.created.exec, end: fx.updated.exec, models: [CX_MINI], surface: "exec",
      version: "0.168.0", projectKey: keyedHash(r.salt, "/work/projB"), inRepo: false, approval: "never", sandbox: "disabled", effort: "low",
    });
    expect(r.store.session(sidOf(fx.ids.sub))).toEqual({
      ...base, id: sidOf(fx.ids.sub), origin: "subagent", start: fx.created.sub, end: fx.updated.sub, models: [CX_MAX], surface: "subagent",
      parentId: sidOf(fx.ids.cli), spawnDepth: 1, agentType: "explorer", version: "0.169.0", projectKey: keyedHash(r.salt, CANARY.path),
      inRepo: true, approval: "on-request", sandbox: "managed", effort: "ultra",
    });
  });

  test("effort by the CLI's levels (else other); one totals event per row with a token count, drift when not a count", async () => {
    const at = fixtureStart();
    const ids = Array.from({ length: 7 }, (_, i) => uuidV7(at - 1000, 0x70 + i));
    const efforts: unknown[] = ["ultra", "none", "minimal", "max", CANARY.prompt, null, ""];
    const tokens: unknown[] = [10, 0, null, -1, "lots", 2.5e6, 7];
    writeStateDb(h, ".codex/state_5.sqlite", ids.map((id, i) => threadRow(id, at + i * MIN, { reasoning_effort: efforts[i], tokens_used: tokens[i] })));
    const r = await run([cxThreads]);
    expect(ids.map((id) => r.store.session(sidOf(id))!.effort)).toEqual(["ultra", "none", "minimal", "max", "other", undefined, undefined]);
    expect(r.store.all("totals")).toEqual([[0, 10], [1, 0], [5, 2_500_000], [6, 7]].map(([i, n]) => (
      { k: "totals", tool: "codex", source: "codex.threads", sessionId: sidOf(ids[i!]!), tokens: n })));
    expect(covOf(r, "codex.threads").unknownTypes).toEqual({ "threads.tokens_used:shape": 2 });
    expectNoCanaries([r.store, r.coverage, r.warnings]);
  });

  test("thread rows, turns and coverage", async () => {
    const fx = buildCodexIndex(h);
    const r = await run([cxThreads]);
    expect(r.store.all("codex-thread-row")).toEqual((["cli", "exec", "sub"] as const).map((k) => (
      { k: "codex-thread-row", tool: "codex", source: "codex.threads", threadId: sidOf(fx.ids[k]), createdAt: fx.created[k] })));
    expect(r.store.all("totals")).toEqual((["cli", "exec", "sub"] as const).map((k) => (
      { k: "totals", tool: "codex", source: "codex.threads", sessionId: sidOf(fx.ids[k]), tokens: fx.tokens[k] })));
    expect(r.store.all("turn")).toEqual(fx.turns.map((t) => (
      { k: "turn", tool: "codex", source: "codex.threads", ts: t.ts, sessionId: sidOf(fx.ids[t.thread]), window: "lifetime", status: t.status, ms: t.ms })));
    expect(covOf(r, "codex.threads")).toEqual({
      k: "coverage", tool: "codex", source: "codex.threads", window: "lifetime", status: "ok", beta: false,
      files: 2, bytes: statSync(fx.files.state).size + statSync(fx.files.turns).size, records: 3 + 1 + 4,
      skipped: {}, unknownTypes: {}, versions: ["0.168.0", "0.169.0"], from: fx.created.cli, to: fx.updated.exec,
    });
  });

  test("the highest-numbered stores are read (numerically), older ones never", async () => {
    const at = fixtureStart();
    const [old, cur] = [uuidV7(at - 1000, 0x91), uuidV7(at - 1000, 0x10)];
    writeStateDb(h, ".codex/state_9.sqlite", [threadRow(old, at)]);
    writeStateDb(h, ".codex/state_10.sqlite", [threadRow(cur, at)]);
    writeTurnsDb(h, ".codex/thread_history_1.sqlite", [turnRow(old, "t1", "failed", secs(at), secs(at + 1_000), 1_000)]);
    writeTurnsDb(h, ".codex/thread_history_2.sqlite", [turnRow(cur, "t1", "completed", secs(at), secs(at + 2_000), 2_000)]);
    h.write(".codex/state_11.sqlite-wal", "");
    mkdirSync(path.join(h.env.home, ".codex", "state_12.sqlite"));
    const r = await run([cxThreads]);
    expect(r.store.all("session").map((s) => s.id)).toEqual([sidOf(cur)]);
    expect(r.store.all("turn").map((t) => [t.sessionId, t.status])).toEqual([[sidOf(cur), "completed"]]);
  });

  test("turn statuses: unfinished turns are skipped, other values are drift (shape-checked); times and durations", async () => {
    const at = fixtureStart();
    const id = uuidV7(at - 1000, 0xc1);
    writeStateDb(h, ".codex/state_5.sqlite", [threadRow(id, at)]);
    writeTurnsDb(h, ".codex/thread_history_1.sqlite", [
      turnRow(id, "t1", "completed", secs(at), secs(at + 5_000), 4_200),
      turnRow(id, "t2", "failed", secs(at + 10_000), secs(at + 13_000), null),
      turnRow(id, "t3", "interrupted", secs(at + 20_000), null, null),
      turnRow(id, "t4", "inProgress", secs(at + 30_000), null, null),
      turnRow(id, "t5", "cancelled", secs(at + 40_000), secs(at + 41_000), 1_000),
      turnRow(id, "t6", "timedOut", secs(at + 50_000), secs(at + 51_000), 1_000),
      turnRow(id, "t7", CANARY.prompt, secs(at + 60_000), secs(at + 61_000), 1_000),
      turnRow(id, "t8", "interrupted", null, null, null),
      turnRow(id, "t9", "completed", secs(at + 70_000), secs(at + 72_000), -5),
      turnRow(`${CANARY.project}-thread`, "t1", "completed", secs(at + 80_000), secs(at + 81_000), 900),
    ]);
    const r = await run([cxThreads]);
    expect(r.store.all("turn").map((t) => [t.status, t.ts, t.ms, t.sessionId])).toEqual([
      ["completed", at + 5_000, 4_200, sidOf(id)],
      ["failed", at + 13_000, 3_000, sidOf(id)],
      ["interrupted", at + 20_000, undefined, sidOf(id)],
      ["completed", at + 72_000, 2_000, sidOf(id)],
      ["completed", at + 81_000, 900, sidOf(keyedHash(r.salt, `${CANARY.project}-thread`))],
    ]);
    const cov = covOf(r, "codex.threads");
    expect([cov.status, cov.records, cov.skipped]).toEqual(["drift", 1 + 10, { "in-progress": 1, "no-ts": 1 }]);
    expect(cov.unknownTypes).toEqual({ "turn-status:cancelled": 1, "turn-status:timedOut": 1, "turn-status:(other)": 1 });
    expectNoCanaries([r.store, r.coverage, r.warnings]);
  });

  test("origins follow the rollouts' rules: exec scripted, mcp peer, Claude Code peer unless subagent; odd sources are drift", async () => {
    const at = fixtureStart();
    const spawn = (parent: string, role: string | null) => JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: parent, depth: 2, agent_path: CANARY.path, agent_nickname: CANARY.project, agent_role: role } } });
    const cases: [string, string | null, string, string][] = [
      ["cli", "codex-tui", "human", "cli"],
      ["vscode", null, "human", "vscode"],
      ["mcp", null, "peer", "mcp"],
      ["exec", "codex_exec", "scripted", "exec"],
      ["exec", "Claude Code", "peer", "exec"],
      ["cli", "Claude Code", "peer", "cli"],
      [JSON.stringify({ subagent: "review" }), null, "subagent", "subagent"],
      [spawn("not-a-uuid", CANARY.project), "Claude Code", "subagent", "subagent"],
      [CANARY.prompt, null, "human", "other"],
      [JSON.stringify(["subagent"]), null, "human", "other"],
      ["{not json", null, "human", "other"],
    ];
    const ids = cases.map((_, i) => uuidV7(at - 1000, 0xd0 + i));
    writeStateDb(h, ".codex/state_5.sqlite", cases.map(([source, originator], i) => threadRow(ids[i]!, at + i * MIN, { source, originator })));
    const r = await run([cxThreads]);
    expect(ids.map((id) => [r.store.session(sidOf(id))!.origin, r.store.session(sidOf(id))!.surface])).toEqual(cases.map(([, , o, s]) => [o, s]));
    expect(r.store.session(sidOf(ids[6]!))!.parentId).toBeUndefined();
    expect(r.store.session(sidOf(ids[7]!))).toMatchObject({
      parentId: sidOf(keyedHash(r.salt, "not-a-uuid")), spawnDepth: 2, agentType: keyedHash(r.salt, CANARY.project),
    });
    expect(covOf(r, "codex.threads").unknownTypes).toEqual({ "threads.source:shape": 2 });
    expectNoCanaries([r.store, r.coverage, r.warnings]);
  });

  test("ids that are not UUIDs are hashed in sessions, rows, edges and turns; approval and sandbox are shape-checked", async () => {
    const at = fixtureStart();
    const odd = `${CANARY.project}-thread`;
    const [child, other] = [uuidV7(at - 1000, 0xe1), uuidV7(at - 1000, 0xe2)];
    writeStateDb(h, ".codex/state_5.sqlite", [
      threadRow(odd, at, { approval_mode: CANARY.prompt, sandbox_policy: JSON.stringify({ type: CANARY.secret, writable_roots: [CANARY.path] }) }),
      threadRow(child, at + MIN, { approval_mode: "untrusted", sandbox_policy: "read-only" }),
      threadRow(other, at + 2 * MIN, { approval_mode: null, sandbox_policy: JSON.stringify({ network: "enabled" }) }),
      threadRow(uuidV7(at - 1000, 0xe3), at + 3 * MIN, { sandbox_policy: CANARY.code }),
    ], [[odd, child, "open"], ["", other, "open"]]);
    const r = await run([cxThreads]);
    const hashed = sidOf(keyedHash(r.salt, odd));
    expect(r.store.all("session").map((s) => [s.approval, s.sandbox])).toEqual([["other", "other"], ["untrusted", "read-only"], [undefined, "other"], ["on-request", "other"]]);
    expect(r.store.session(hashed)).toBeDefined();
    expect(r.store.all("codex-thread-row")[0]!.threadId).toBe(hashed);
    expect(r.store.all("edge")).toEqual([{ k: "edge", tool: "codex", source: "codex.threads", parentId: hashed, childId: sidOf(child) }]);
    expect([covOf(r, "codex.threads").skipped, covOf(r, "codex.threads").unknownTypes]).toEqual([{ "bad-row": 1 }, { "threads.sandbox_policy:shape": 2 }]);
    expectNoCanaries([r.store, r.coverage, r.warnings]);
  });

  test("missing allowlisted columns and tables are drift; the rest is still read, times from the seconds columns", async () => {
    const at = fixtureStart();
    const id = uuidV7(at - 1000, 0xb1);
    const gone = ["originator", "model", "reasoning_effort", "cli_version", "created_at_ms", "updated_at_ms", "git_origin_url"];
    writeStateDb(h, ".codex/state_5.sqlite", [threadRow(id, at, { source: "exec" })], [], { columns: THREAD_COLUMNS.filter((c) => !gone.includes(c)), noEdgesTable: true });
    writeTurnsDb(h, ".codex/thread_history_1.sqlite", [turnRow(id, "t1", "completed", secs(at), secs(at + 1_000), 1_000)], { columns: ["thread_id", "turn_id", "status", "started_at"] });
    const r = await run([cxThreads]);
    const s = r.store.session(sidOf(id))!;
    expect(s).toMatchObject({ origin: "scripted", start: at, end: at + 30 * MIN, models: [], inRepo: true });
    expect(s.version).toBeUndefined();
    expect(r.store.all("turn").map((t) => [t.status, t.ts, t.ms])).toEqual([["completed", at, undefined]]);
    const cov = covOf(r, "codex.threads");
    expect(cov.status).toBe("drift");
    expect(cov.unknownTypes).toEqual({
      "missing-column:originator": 1, "missing-column:model": 1, "missing-column:reasoning_effort": 1, "missing-column:cli_version": 1, "missing-column:created_at_ms": 1,
      "missing-column:updated_at_ms": 1, "missing-column:git_origin_url": 1, "missing-table:thread_spawn_edges": 1,
      "missing-column:completed_at": 1, "missing-column:duration_ms": 1,
    });
    expect(r.warnings.filter((w) => w.code === "drift")).toHaveLength(1);
  });

  test("a threads table without ids yields nothing but drift; a thread without a creation time has a row but no session", async () => {
    const at = fixtureStart();
    writeStateDb(h, ".codex/state_5.sqlite", [threadRow("x", at)], [], { columns: THREAD_COLUMNS.filter((c) => c !== "id") });
    let r = await run([cxThreads]);
    expect(r.store.all("session")).toEqual([]);
    expect(covOf(r, "codex.threads")).toMatchObject({ status: "drift", unknownTypes: { "missing-column:id": 1 } });

    h.cleanup();
    h = fakeHome();
    const id = uuidV7(at - 1000, 0xb2);
    writeStateDb(h, ".codex/state_5.sqlite", [threadRow(id, at, { created_at: null, created_at_ms: null })]);
    r = await run([cxThreads]);
    expect(r.store.all("session")).toEqual([]);
    expect(r.store.all("codex-thread-row")).toEqual([{ k: "codex-thread-row", tool: "codex", source: "codex.threads", threadId: sidOf(id) }]);
    expect(r.store.all("totals")).toEqual([{ k: "totals", tool: "codex", source: "codex.threads", sessionId: sidOf(id), tokens: 123_456 }]);
    expect(covOf(r, "codex.threads")).toMatchObject({ status: "ok", records: 1, skipped: { "no-ts": 1 } });
  });

  /** A thread index with `n` minimal threads, inserted in one statement. */
  const manyThreads = (n: number) => {
    const at = secs(fixtureStart());
    writeStateDb(h, ".codex/state_5.sqlite", [], [], {
      extraDdl: [
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${n}) `
        + "INSERT INTO threads (id, created_at, updated_at, source, cwd, sandbox_policy, approval_mode) "
        + `SELECT printf('00000000-0000-4000-8000-%012d', i), ${at} + i, ${at} + i, 'exec', '/work/p', '{"type":"read-only"}', 'never' FROM n`,
      ],
    });
  };
  const PAGE_QUERY = (table: string) => new RegExp(`\\bFROM "${table}" WHERE rowid > \\? ORDER BY rowid LIMIT \\?`);

  test("tables are read in rowid pages with explicit columns and bound parameters", async () => {
    manyThreads(10_001);
    const sql: string[] = [];
    __observeQueries((s) => sql.push(s));
    const r = await run([cxThreads]);
    __observeQueries(undefined);
    expect(r.store.all("session")).toHaveLength(10_001);
    expect(r.store.all("codex-thread-row")).toHaveLength(10_001);
    expect(sql.filter((s) => /\bFROM "?threads"? WHERE rowid > \? ORDER BY rowid LIMIT \?/.test(s))).toHaveLength(3);
    expect(sql.every((s) => !s.includes("*"))).toBe(true);
    expect(covOf(r, "codex.threads")).toMatchObject({ status: "ok", records: 10_001 });
  });

  test("each store is read on its own: one that cannot be opened is an io-error; only when none opens is the source an error", async () => {
    const at = fixtureStart();
    const id = uuidV7(at - 1000, 0xf1);
    // the thread index cannot be opened: the turn history is still read
    h.write(".codex/state_5.sqlite", "not a database");
    writeTurnsDb(h, ".codex/thread_history_1.sqlite", [turnRow(id, "t1", "completed", secs(at), secs(at + 1_000), 1_000)]);
    let r = await run([cxThreads]);
    expect(r.store.all("turn").map((t) => t.sessionId)).toEqual([sidOf(id)]);
    expect(covOf(r, "codex.threads")).toMatchObject({ status: "ok", files: 1, records: 1, skipped: { "io-error": 1 } });
    // neither can be opened
    h.write(".codex/thread_history_1.sqlite", "not a database either");
    r = await run([cxThreads]);
    expect(r.coverage).toEqual([expect.objectContaining({ source: "codex.threads", status: "error" })]);
    expect(r.warnings).toEqual([expect.objectContaining({ code: "error", source: "codex.threads" })]);
    // the turn history cannot be opened: the thread index is still read
    h.cleanup();
    h = fakeHome();
    writeStateDb(h, ".codex/state_5.sqlite", [threadRow(id, at)]);
    h.write(".codex/thread_history_1.sqlite", "not a database either");
    r = await run([cxThreads]);
    expect(r.store.all("session")).toHaveLength(1);
    expect(covOf(r, "codex.threads")).toMatchObject({ status: "ok", files: 1, skipped: { "io-error": 1 } });
  });

  test("a WITHOUT ROWID table cannot be paged: drift table-unreadable, and it is never queried", async () => {
    const at = fixtureStart();
    const id = uuidV7(at - 1000, 0xf3);
    writeStateDb(h, ".codex/state_5.sqlite", [threadRow(id, at)]);
    h.sqlite(".codex/thread_history_1.sqlite", [
      "CREATE TABLE thread_turns (thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER, completed_at INTEGER, duration_ms INTEGER, PRIMARY KEY (thread_id, turn_id)) WITHOUT ROWID",
    ], { thread_turns: [[id, "t1", "completed", secs(at), secs(at + 1_000), 1_000]] });
    const sql: string[] = [];
    __observeQueries((s) => sql.push(s));
    const r = await run([cxThreads]);
    __observeQueries(undefined);
    expect(sql.filter((s) => sourceOf(s) === "thread_turns")).toEqual([]);
    expect([r.store.all("session").length, r.store.all("turn").length]).toEqual([1, 0]);
    const cov = covOf(r, "codex.threads");
    expect([cov.status, cov.skipped, cov.unknownTypes]).toEqual(["drift", {}, { "table-unreadable:thread_turns": 1 }]);
  });

  test("a first page that fails for good is drift table-unreadable; a busy page, or a later page, is an io-error", async () => {
    const at = fixtureStart();
    const id = uuidV7(at - 1000, 0xf4);
    writeStateDb(h, ".codex/state_5.sqlite", [threadRow(id, at)], [[id, uuidV7(at - 1000, 0xf5), "open"]]);
    // WITHOUT ROWID spelled with a comment between its words: only the paged query itself can fail on it
    h.sqlite(".codex/thread_history_1.sqlite", [
      "CREATE TABLE thread_turns (thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER, completed_at INTEGER, duration_ms INTEGER, PRIMARY KEY (thread_id, turn_id)) WITHOUT/**/ROWID",
    ], { thread_turns: [[id, "t1", "completed", secs(at), secs(at + 1_000), 1_000]] });
    __observeQueries((s) => {
      if (PAGE_QUERY("thread_spawn_edges").test(s)) throw new Error("database is locked");
    });
    let r = await run([cxThreads]);
    __observeQueries(undefined);
    expect([r.store.all("session").length, r.store.all("edge").length, r.store.all("turn").length]).toEqual([1, 0, 0]);
    let cov = covOf(r, "codex.threads");
    expect([cov.status, cov.skipped, cov.unknownTypes]).toEqual(["drift", { "io-error": 1 }, { "table-unreadable:thread_turns": 1 }]);

    h.cleanup();
    h = fakeHome();
    manyThreads(5_001);
    let pages = 0;
    __observeQueries((s) => {
      if (PAGE_QUERY("threads").test(s) && ++pages === 2) throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
    });
    r = await run([cxThreads]);
    __observeQueries(undefined);
    expect(r.store.all("session")).toHaveLength(5_000);
    cov = covOf(r, "codex.threads");
    expect([cov.status, cov.skipped, cov.unknownTypes]).toEqual(["ok", { "io-error": 1 }, {}]);
  });

  test("a row the mapper cannot handle is counted as bad-record and logged once; the other rows are read", async () => {
    const at = fixtureStart();
    writeStateDb(h, ".codex/state_5.sqlite", [threadRow("boom", at), threadRow(uuidV7(at - 1000, 0xf6), at + MIN)]);
    const events: Ev[] = [];
    const logs: [string, string, number | undefined][] = [];
    const salt = new Uint8Array(32);
    const ctx: ScanCtx = {
      env: h.env, now: Date.now(), salt, signal: new AbortController().signal,
      temp: { dir: () => h.root, disposeAll: () => {}, active: 0 },
      emit: (e) => { events.push(e); },
      hash: (v) => { if (v === "boom") throw new Error("injected mapping failure"); return keyedHash(salt, v); },
      registerCwd: (cwd) => keyedHash(salt, cwd),
      log: (level, code, n) => { logs.push([level, code, n]); },
    };
    const [cand] = cxThreads.locate(h.env, [h.env.home]);
    await cxThreads.scan(cand!, ctx);
    const cov = events.find((e): e is CoverageEv => e.k === "coverage")!;
    expect([cov.status, cov.skipped]).toEqual(["ok", { "bad-record": 1 }]);
    expect(events.filter((e) => e.k === "session")).toHaveLength(1);
    expect(logs).toEqual([["warn", "cx.bad-record", 1]]);
  });

  test("no Codex home: absent; a Codex home without stores: empty; CODEX_HOME replaces ~/.codex", async () => {
    let r = await run([cxThreads]);
    expect(r.coverage).toEqual([expect.objectContaining({ status: "absent", source: "codex.threads" })]);
    mkdirSync(path.join(h.env.home, ".codex"), { recursive: true });
    r = await run([cxThreads]);
    expect(r.coverage[0]).toMatchObject({ status: "empty", window: "lifetime", files: 0, records: 0 });
    const at = fixtureStart();
    const id = uuidV7(at - 1000, 0xf2);
    h.env.vars.CODEX_HOME = path.join(h.env.home, "alt-codex");
    writeStateDb(h, "alt-codex/state_5.sqlite", [threadRow(id, at)]);
    r = await run([cxThreads]);
    expect(r.store.all("session").map((s) => s.id)).toEqual([sidOf(id)]);
  });

  test("thread rows and lifetime sessions join the rollouts' threads by id", async () => {
    const fx = buildCodexIndex(h);
    const roll = new CxRollout(fx.created.cli + 1_000, fx.ids.cli, { source: "cli", originator: "codex-tui", cwd: CANARY.path });
    roll.meta().turn("turn-1").user("Fix the importer.").done("turn-1", 1_000);
    roll.write(h);
    const r = await run([cxRollouts, cxThreads]);
    const facts = r.store.all("codex-rollout").map((f) => f.threadId);
    const rows = r.store.all("codex-thread-row").map((t) => t.threadId);
    expect(facts).toEqual([sidOf(fx.ids.cli)]);
    expect(rows.filter((id) => facts.includes(id))).toEqual([sidOf(fx.ids.cli)]);
    expect(r.store.all("session")).toHaveLength(3);
    expect(r.store.session(sidOf(fx.ids.cli))).toMatchObject({ origin: "human", start: fx.created.cli, end: fx.updated.cli, models: [CX_MAX] });
  });
});

/**
 * The history DailyEvs of a scan of the fake home run in a child process with `TZ=<tz>` (switching the zone inside
 * `bun test` is unreliable in Bun 1.3).
 */
function historyDaysIn(tz: string): { zone: string; days: [string, number][] } {
  const url = (rel: string) => JSON.stringify(pathToFileURL(path.resolve(import.meta.dir, rel)).href);
  const code = [
    `const { scan } = await import(${url("../../../core/scan.ts")});`,
    `const { cxHistory } = await import(${url("../../../core/sources/codex/index.ts")});`,
    `const r = await scan({ env: JSON.parse(process.env.AIPR_TEST_ENV), plugins: [cxHistory] });`,
    `console.log(JSON.stringify({ zone: new Intl.DateTimeFormat().resolvedOptions().timeZone, days: r.store.all("daily").map((d) => [d.day, d.count]) }));`,
  ].join("\n");
  const child = Bun.spawnSync({
    cmd: [process.execPath, "-e", code],
    env: { ...process.env, TZ: tz, AIPR_TEST_ENV: JSON.stringify(h.env) },
    stdout: "pipe", stderr: "pipe", timeout: 30_000,
  });
  if (child.exitCode !== 0) throw new Error(`child scan failed: ${child.stderr.toString()}`);
  return JSON.parse(child.stdout.toString());
}

describe("codex history", () => {
  test("prompts: lifetime, human, session ids, task starts, intents, hashes; one DailyEv per local day; coverage", async () => {
    const fx = buildCodexIndex(h);
    const r = await run([cxHistory]);
    const p = r.store.all("prompt");
    expect(p.map((x) => [x.ts, x.sessionId, x.window, x.origin])).toEqual(fx.historyTs.map((ts, i) => [ts, sidOf(i < 2 ? fx.ids.cli : fx.ids.exec), "lifetime", "human"]));
    expect(p.map((x) => x.features.isTaskStart)).toEqual([true, true, true, false, false]);
    expect(p.map((x) => x.intent)).toEqual(["spec", "question", "spec", "question", "ack"]);
    expect(p[1]!.textHash).toBe(keyedHash(r.salt, "Why does the importer reject empty input?"));
    expect(p[0]!.features.simToPrev).toBeUndefined();
    expect(p[1]!.features.simToPrev).toBeGreaterThanOrEqual(0);
    expect(p[2]!.features.simToPrev).toBeUndefined();
    expect(p.every((x) => x.hasPaste === undefined)).toBe(true);
    expect(r.store.all("daily")).toEqual(fx.days.map(([day, count]) => ({ k: "daily", tool: "codex", source: "codex.history", day, zone: "local", unit: "prompts", count })));
    expect(r.coverage[0]).toEqual({
      k: "coverage", tool: "codex", source: "codex.history", window: "lifetime", status: "ok", beta: false, files: 1,
      bytes: statSync(fx.files.history).size, records: 5, skipped: {}, unknownTypes: {}, versions: [], from: fx.historyTs[0], to: fx.historyTs[4],
    });
  });

  test("odd lines: drift for a missing shape, skips for unusable values; non-UUID session ids are hashed, absent ones omitted", async () => {
    const at = localTime(2, 12);
    h.write(".codex/history.jsonl", [
      JSON.stringify(cxHistoryLine("first", at, "0190f1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b")),
      JSON.stringify(cxHistoryLine("second", at + MIN, CANARY.project)),
      JSON.stringify(cxHistoryLine("third", at + 2 * MIN)),
      JSON.stringify([CANARY.prompt]),
      JSON.stringify({ session_id: "s", ts: secs(at) }),
      JSON.stringify({ session_id: "s", text: CANARY.prompt }),
      JSON.stringify({ session_id: "s", ts: "yesterday", text: CANARY.prompt }),
      JSON.stringify({ session_id: "s", ts: secs(at), text: "   " }),
      `{"session_id":"s","ts":${secs(at)},"text":"${CANARY.prompt}`,
    ].join("\n") + "\n");
    const r = await run([cxHistory]);
    expect(r.store.all("prompt").map((p) => p.sessionId)).toEqual([
      sidOf("0190f1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b"), sidOf(keyedHash(r.salt, CANARY.project)), undefined,
    ]);
    const cov = r.coverage[0]!;
    expect([cov.status, cov.records, cov.skipped]).toEqual(["drift", 8, { "bad-ts": 1, empty: 1, parse: 1 }]);
    expect(cov.unknownTypes).toEqual({ "line:not-object": 1, "text:missing": 1, "ts:missing": 1 });
    expectNoCanaries([r.store, r.coverage, r.warnings]);
  });

  test("history days follow the process time zone", () => {
    const nzdt = (day: string, hhmm: string) => Date.parse(`${day}T${hhmm}:00+13:00`);
    h.writeJsonl(".codex/history.jsonl", [
      cxHistoryLine("Refactor the importer", nzdt("2026-01-14", "23:30"), "0190f1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b"),
      cxHistoryLine("Add pagination", nzdt("2026-01-15", "00:30"), "0190f1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b"),
    ]);
    expect(historyDaysIn("Pacific/Auckland")).toEqual({ zone: "Pacific/Auckland", days: [["2026-01-14", 1], ["2026-01-15", 1]] });
    expect(historyDaysIn("UTC")).toEqual({ zone: "UTC", days: [["2026-01-14", 2]] });
  });

  test("no history file: empty", async () => {
    mkdirSync(path.join(h.env.home, ".codex"), { recursive: true });
    const r = await run([cxHistory]);
    expect(r.coverage[0]).toMatchObject({ source: "codex.history", window: "lifetime", status: "empty", files: 0, records: 0 });
  });
});

/** Section headers found in a TOML text, line by line, plus the parser's syntax counters. */
function headersOf(text: string): { headers: string[]; malformed: number; open: boolean } {
  const t = new TomlHeaders();
  const headers: string[] = [];
  for (const line of text.split("\n")) {
    const hd = t.line(line);
    if (hd) headers.push(`${hd.array ? "[[" : "["}${hd.keys.join("|")}${hd.array ? "]]" : "]"}`);
  }
  return { headers, malformed: t.malformed, open: t.open };
}

describe("codex config: TOML section headers", () => {
  const cases: [string, string, string[], number?, boolean?][] = [
    ["bare and dotted keys", "[a]\n[a.b.c]", ["[a]", "[a|b|c]"]],
    ["whitespace, quoted keys and comments", `  [ a . "b.c" . 'd e' ]  # note\n\t[x]#c`, ["[a|b.c|d e]", "[x]"]],
    ["array tables", "[[profiles.x]]\n[[ y ]]", ["[[profiles|x]]", "[[y]]"]],
    ["escapes in quoted keys", `[a."b\\"c"]\n[a."\\u0041\\t"]`, ["[a|b\"c]", "[a|A\t]"]],
    ["unicode bare keys", "[mcp_servers.dокументы]", ["[mcp_servers|dокументы]"]],
    ["comment lines and values that look like headers", `# [profiles.x]\nk = "[profiles.y] # z"\nk2 = '[a]'`, []],
    ["comments after values may hold brackets and quotes", `k = 1 # [ unbalanced\nk2 = "x" # """ it's\n[real]`, ["[real]"]],
    ["escaped quotes inside strings", `k = "a \\" [b" # "\nk2 = "\\\\" # "[c"\n[real]`, ["[real]"]],
    ["a multi-line basic string", `k = """\n[profiles.fake]\nsay \\"""hi\\"""\n"""\n[real]`, ["[real]"]],
    ["an escaped quote before quotes that do not close", `k = """a\\"""\n[fake]\n"""\n[real]`, ["[real]"]],
    ["a multi-line literal string closed by extra quotes", `k = '''\n[fake]\nit's''''\n[real]`, ["[real]"]],
    ["a basic string closed by four quotes on one line", `k = """x""""\n[real]`, ["[real]"]],
    ["a multi-line array of arrays", `k = [\n  ["x"],\n  [1, 2], # [c]\n  "]",\n]\n[real]`, ["[real]"]],
    ["an inline table over several lines", `k = { a = "[x]",\n  b = [1] }\n[real]`, ["[real]"]],
    ["CRLF line ends and a BOM", "﻿[a]\r\nk = 1\r\n[b] \r", ["[a]", "[b]"]],
    ["the profiles table itself", "[profiles]\nfast = { model = \"x\" }", ["[profiles]"]],
    ["malformed headers", "[a.b\n[a] x\n[\"open]\n[]\n[a..b]\nnot a key line", [], 6],
    ["an unterminated multi-line string", `k = """\n[x]`, [], 0, true],
  ];
  for (const [name, text, want, malformed = 0, open = false] of cases) {
    test(name, () => expect(headersOf(text)).toEqual({ headers: want, malformed, open }));
  }
});

describe("codex config", () => {
  test("profiles, MCP servers, plugins, skills and memory files; coverage", async () => {
    const fx = buildCodexIndex(h);
    const r = await run([cxConfig]);
    const base = { k: "config", tool: "codex", source: "codex.config" } as const;
    expect(r.store.all("config")).toEqual([
      { ...base, kind: "profile", name: "deep", provenance: "authored" },
      { ...base, kind: "profile", name: "fast", provenance: "authored" },
      { ...base, kind: "mcp-server", name: CANARY.mcp, provenance: "unknown" },
      { ...base, kind: "plugin", name: "demo@market", provenance: "installed" },
      { ...base, kind: "plugin", name: "other@market", provenance: "installed" },
      { ...base, kind: "skill", name: "review-helper", provenance: "authored" },
      { ...base, kind: "memory-file", provenance: "authored" },
      { ...base, kind: "memory-file", provenance: "authored" },
    ]);
    expect(covOf(r, "codex.config")).toEqual({
      k: "coverage", tool: "codex", source: "codex.config", window: "lifetime", status: "ok", beta: false, files: 1,
      bytes: statSync(fx.files.config).size, records: 8, skipped: {}, unknownTypes: {}, versions: [],
    });
    expectNoCanaries([r.store, r.coverage, r.warnings], { allow: ["mcp"] });
  });

  test("profile names are kept only when shaped like a type name; servers and plugins keep raw names; tables count once", async () => {
    h.write(".codex/config.toml", [
      "[profiles.Fast]", "[profiles.\"my profile\"]", `[profiles.${CANARY.project}]`, "[profiles.ok_name-2]", "[profiles.ok_name-2.features]",
      "[[profiles.list]]", "[mcp_servers.\"docs.v2\"]", "[mcp_servers.\"docs.v2\".tools.search]", "[mcp_servers.docs]",
      "[plugins.\"a@m\"]", "[plugins.\"a@m\".mcp_servers.x]", "[profiles]", "[mcp_servers]", "[plugins]",
    ].join("\n"));
    const r = await run([cxConfig]);
    expect(configs(r, "profile").map((c) => c.name)).toEqual([undefined, undefined, "list", undefined, "ok_name-2"]);
    expect(configs(r, "mcp-server").map((c) => c.name)).toEqual(["docs", "docs.v2"]);
    expect(configs(r, "plugin").map((c) => c.name)).toEqual(["a@m"]);
    expectNoCanaries([r.store, r.coverage]);
  });

  test("plugins: config entries and the plugin cache, merged; hidden entries and files are not plugins", async () => {
    h.write(".codex/config.toml", "[plugins.\"cfg-only@m1\"]\nenabled = false\n[plugins.\"both@m2\"]\n");
    h.writeJson(".codex/plugins/cache/m2/both/1.0.0/.codex-plugin/plugin.json", {});
    h.writeJson(".codex/plugins/cache/m3/cache-only/0.1.0/.codex-plugin/plugin.json", {});
    h.write(".codex/plugins/cache/m3/README.md", "x");
    h.writeJson(".codex/plugins/cache/.staging/half/0.1.0/.codex-plugin/plugin.json", {});
    h.writeJson(".codex/plugins/.remote-plugin-install-staging/x/plugin.json", {});
    const r = await run([cxConfig]);
    expect(configs(r, "plugin").map((c) => [c.name, c.provenance])).toEqual([["both@m2", "installed"], ["cache-only@m3", "installed"], ["cfg-only@m1", "installed"]]);
  });

  test("skills: folders with SKILL.md (symlinks followed, hidden ones skipped); the shared skills lock marks installed ones", async () => {
    h.write(".codex/skills/mine/SKILL.md", "---\nname: mine\n---\n");
    h.write(".codex/skills/from-lock/SKILL.md", "---\nname: from-lock\n---\n");
    h.write(".codex/skills/no-skill-file/README.md", "x");
    h.write(".codex/skills/.system/bundled/SKILL.md", "x");
    h.write(".codex/skills/.hidden/SKILL.md", "x");
    h.write(".codex/skills/stray.md", "x");
    h.write("dotfiles/linked/SKILL.md", "---\nname: linked\n---\n");
    symlinkSync(path.join(h.env.home, "dotfiles", "linked"), path.join(h.env.home, ".codex", "skills", "linked"));
    h.writeJson(".agents/.skill-lock.json", { version: 3, skills: { "from-lock": { source: "acme/skills", sourceUrl: `https://${CANARY.host}/x.git` } } });
    let r = await run([cxConfig]);
    expect(configs(r, "skill").map((c) => [c.name, c.provenance])).toEqual([["from-lock", "installed"], ["linked", "authored"], ["mine", "authored"]]);
    expect(covOf(r, "codex.config")).toMatchObject({ files: 1, bytes: statSync(path.join(h.env.home, ".agents/.skill-lock.json")).size });

    h.write(".agents/.skill-lock.json", "{ not json");
    r = await run([cxConfig]);
    expect(configs(r, "skill").map((c) => c.provenance)).toEqual(["unknown", "unknown", "unknown"]);
    expect(covOf(r, "codex.config").skipped).toEqual({ parse: 1 });
    expectNoCanaries([r.store, r.coverage]);
  });

  test("memory files: Markdown files directly in memories/, never opened", async () => {
    h.write(".codex/memories/MEMORY.md", CANARY.prompt);
    h.write(".codex/memories/raw_memories.md", CANARY.secret);
    h.write(".codex/memories/notes.txt", "x");
    h.write(".codex/memories/.hidden.md", "x");
    h.write(".codex/memories/rollout_summaries/one.md", "x");
    h.write(".codex/memories/.git/HEAD", "ref: refs/heads/main\n");
    const r = await run([cxConfig]);
    expect(configs(r, "memory-file")).toEqual([
      { k: "config", tool: "codex", source: "codex.config", kind: "memory-file", provenance: "authored" },
      { k: "config", tool: "codex", source: "codex.config", kind: "memory-file", provenance: "authored" },
    ]);
  });

  test("a large config.toml is streamed line by line across read chunks", async () => {
    const filler = Array.from({ length: 16_000 }, (_, i) => `key_${i} = "${"x".repeat(i % 50)}" # [not.a.header]`).join("\r\n");
    h.write(".codex/config.toml", `[profiles.a]\r\n${filler}\r\nlong = """\n${filler}\n"""\n[profiles.b]\n${filler}\n[mcp_servers.m]`);
    const r = await run([cxConfig]);
    expect(configs(r, "profile").map((c) => c.name)).toEqual(["a", "b"]);
    expect(configs(r, "mcp-server").map((c) => c.name)).toEqual(["m"]);
    expect(covOf(r, "codex.config")).toMatchObject({ status: "ok", files: 1, unknownTypes: {} });
  });

  test("config.toml: read through a symlink; a malformed or unterminated file is drift; values never leave", async () => {
    h.write("dotfiles/codex.toml", `[profiles.work]\nkey = "${CANARY.secret}"\n[oops\nprompt = """\n${CANARY.prompt}\n`);
    mkdirSync(path.join(h.env.home, ".codex"), { recursive: true });
    symlinkSync(path.join(h.env.home, "dotfiles", "codex.toml"), path.join(h.env.home, ".codex", "config.toml"));
    const r = await run([cxConfig]);
    expect(configs(r, "profile").map((c) => c.name)).toEqual(["work"]);
    const cov = covOf(r, "codex.config");
    expect([cov.status, cov.files]).toEqual(["drift", 1]);
    expect(cov.unknownTypes).toEqual({ "config.toml:syntax": 1, "config.toml:unterminated": 1 });
    expectNoCanaries([r.store, r.coverage, r.warnings]);
  });

  test.skipIf(skipChmod)("an unreadable config.toml counts as io-error and the rest is still read", async () => {
    const file = h.write(".codex/config.toml", "[profiles.work]\n");
    h.write(".codex/memories/MEMORY.md", "x");
    chmodSync(file, 0o000);
    try {
      const r = await run([cxConfig]);
      expect(configs(r, "memory-file")).toHaveLength(1);
      expect(configs(r, "profile")).toEqual([]);
      expect(covOf(r, "codex.config")).toMatchObject({ status: "ok", files: 0, skipped: { "io-error": 1 } });
    } finally {
      chmodSync(file, 0o600);
    }
  });

  test("nothing configured: empty", async () => {
    mkdirSync(path.join(h.env.home, ".codex"), { recursive: true });
    const r = await run([cxConfig]);
    expect(r.coverage[0]).toMatchObject({ source: "codex.config", window: "lifetime", status: "empty", files: 0, records: 0 });
  });
});

// The sandbox policy fixture is JSON with a `type` and paths; only the type may leave.
test("fixture sanity: the managed sandbox policy carries a path", () => {
  expect(MANAGED_SANDBOX).toContain(CANARY.path);
});
