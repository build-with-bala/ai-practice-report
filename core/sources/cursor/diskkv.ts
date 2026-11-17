import { safeStat } from "../../io/fs";
import { isBusyError, MAX_COPY_BYTES, openRo, type RoDb } from "../../io/sqlite";
import { toEpochMs } from "../../io/time";
import type { Ev, MarkerEv, PromptEv, SessionEv, ToolEv, TurnEv } from "../../model/events";
import { sid, type MarkerKind, type Origin, type ToolCategory } from "../../model/ids";
import { classifyCommand } from "../../text/commands";
import { classifyIntent } from "../../text/intent";
import { promptFeatures } from "../../text/structure";
import type { Tally } from "../common/coverage";
import { extOfPath, idPart, num, safeModel, str, UUID, type Obj } from "../common/guards";
import type { ScanCtx } from "../types";

export const TOOL = "cursor";
export const IDE_SOURCE = "cursor.ide";
/** Rows per query: every table is read in rowid pages, so memory stays bounded however large the store grows. */
export const PAGE = 2_000;
/** A message this long after the session's previous activity starts a new task. */
export const TASK_GAP_MS = 30 * 60_000;
/** Previous prompt texts kept for `simToPrev`, for the most recently active sessions only. */
const PREV_TEXTS = 256;
const WITHOUT_ROWID = /\bWITHOUT\s+ROWID\b/i;

export const q = (name: string): string => `"${name}"`;

/** A Cursor session id, `cursor:<id>`: the composer's own id verbatim when UUID-shaped, else its keyed hash. */
export const cuSessionId = (raw: string, ctx: ScanCtx): string => sid(TOOL, idPart(raw, UUID, ctx));

// ---- stores, tables and pages (shared by the Cursor readers) ----

/**
 * Opens and reads one store on its own; it counts as read once its tables are listed, and is always closed. A store
 * that cannot be opened is an io-error (warn `cu.db-unopenable`) — or, above MAX_COPY_BYTES, a locked store that is
 * never copied: skipped `too-large`, coverage `note: "too-large"`. A store that fails while it is read is an io-error
 * (warn `cu.db-unreadable`). True when its tables were listed.
 */
export function readStore(file: string, ctx: ScanCtx, tally: Tally, body: (db: RoDb, tables: Set<string>) => void): boolean {
  const db = openRo(file, ctx.temp);
  if (!db) {
    if ((safeStat(file)?.size ?? 0) > MAX_COPY_BYTES) {
      tally.note = "too-large";
      tally.skip("too-large");
    } else {
      tally.skip("io-error");
      ctx.log("warn", "cu.db-unopenable");
    }
    return false;
  }
  let listed = false;
  try {
    const tables = new Set(db.tables());
    listed = true;
    tally.files++;
    tally.bytes += safeStat(file)?.size ?? 0;
    body(db, tables);
  } catch {
    tally.skip("io-error");
    ctx.log("warn", "cu.db-unreadable");
  } finally {
    db.close();
  }
  return listed;
}

/**
 * The columns of `table` when the reader can page it by rowid; each one of `wanted` missing is drift
 * `missing-column:<name>`. Undefined when the table is missing (drift `missing-table:<name>`), declared WITHOUT ROWID
 * (drift `table-unreadable:<name>`), or its schema cannot be read (io-error).
 */
export function pageableColumns(db: RoDb, tables: ReadonlySet<string>, table: string, wanted: readonly string[], tally: Tally): Set<string> | undefined {
  if (!tables.has(table)) {
    tally.unknownKey(`missing-table:${table}`);
    return undefined;
  }
  let have: Set<string>;
  let ddl: unknown;
  try {
    have = new Set(db.columns(table));
    ddl = db.get<{ sql: unknown }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", table)?.sql;
  } catch {
    tally.skip("io-error");
    return undefined;
  }
  if (typeof ddl === "string" && WITHOUT_ROWID.test(ddl)) {
    tally.unknownKey(`table-unreadable:${table}`);
    return undefined;
  }
  for (const c of wanted) if (!have.has(c)) tally.unknownKey(`missing-column:${c}`);
  return have;
}

/** How paging a table ended: `done` = every page was read; `unreadable` = its first page failed for good. */
export interface Paging { done: boolean; unreadable: boolean }

/**
 * The rows of a rowid-paged query — `sql` selects the rowid as `rid` and binds the last rowid read and the page size —
 * PAGE per query. A first page that fails other than busy means the query can never work on this table: drift
 * `table-unreadable:<table>`. A busy store, or a later page that fails, is an io-error. Either ends the table.
 */
export function* pages(db: RoDb, sql: string, table: string, tally: Tally, ctx: ScanCtx, out: Paging = { done: false, unreadable: false }): Generator<Obj[]> {
  let after = Number.MIN_SAFE_INTEGER;
  for (let first = true; ; first = false) {
    if (ctx.signal.aborted) return;
    let rows: Obj[];
    try {
      rows = db.all<Obj>(sql, after, PAGE);
    } catch (e) {
      if (first && !isBusyError(e)) {
        tally.unknownKey(`table-unreadable:${table}`);
        out.unreadable = true;
      } else tally.skip("io-error");
      ctx.log("warn", "cu.db-query");
      return;
    }
    tally.records += rows.length;
    if (rows.length > 0) yield rows;
    if (rows.length < PAGE) {
      out.done = true;
      return;
    }
    after = rows[rows.length - 1]!.rid as number;
  }
}

/** Maps one row; a row the mapping fails on is skipped as bad-record and the others go on. */
export function eachRow(map: () => void, tally: Tally): void {
  try {
    map();
  } catch {
    tally.skip("bad-record");
  }
}

// ---- tools ----

/** The command runners: their command line is classified. */
const TERMINAL_NAMES = ["run_terminal_cmd", "run_terminal_command", "run_terminal_command_v2", "Shell"] as const;
/** Tools whose params name the file they change: the extension is kept, never the path. */
const PATH_NAMES = ["edit_file", "edit_file_v2", "search_replace", "write", "delete_file", "reapply", "StrReplace", "Write", "Delete"] as const;
const MCP_NAMES = ["mcp", "call_mcp_tool", "CallMcpTool", "list_mcp_resources", "read_mcp_resource", "get_mcp_tools", "mcp_auth"] as const;

/**
 * Cursor's built-in tools by `toolFormerData.name`: the names of its numeric tool enum (`toolFormerData.tool`, below),
 * older names from its agent prompts, and the agent harness's newer names.
 */
const TOOL_NAMES: ReadonlyMap<string, ToolCategory> = new Map<string, ToolCategory>([
  ...TERMINAL_NAMES.map((n) => [n, "shell"] as const), ["write_shell_stdin", "shell"],
  ...(["read_file", "read_file_v2", "list_dir", "list_dir_v2", "read_lints", "fetch_rules", "read_project", "Read"] as const).map((n) => [n, "read"] as const),
  ...(["codebase_search", "grep_search", "grep", "ripgrep_search", "ripgrep_raw_search", "file_search", "glob_file_search", "semantic_search_full",
    "read_semsearch_files", "search_symbols", "deep_search", "go_to_definition", "Grep", "Glob", "SemanticSearch"] as const).map((n) => [n, "search"] as const),
  ...(["edit_file", "edit_file_v2", "search_replace", "apply_patch", "reapply", "apply_agent_diff", "edit_notebook", "delete_file", "StrReplace", "Delete"] as const)
    .map((n) => [n, "edit"] as const),
  ...(["write", "Write"] as const).map((n) => [n, "write"] as const),
  ...(["web_search", "web_fetch", "WebSearch", "WebFetch"] as const).map((n) => [n, "web"] as const),
  ["fetch_pull_request", "git"],
  ...(["task", "task_v2", "await_task", "background_composer_followup", "Task"] as const).map((n) => [n, "delegate"] as const),
  ...(["todo_read", "todo_write"] as const).map((n) => [n, "todo"] as const),
  ["create_plan", "plan"],
  ...MCP_NAMES.map((n) => [n, "mcp"] as const),
  ...(["computer_use", "record_screen", "Browser"] as const).map((n) => [n, "browser"] as const),
  ...(["create_diagram", "knowledge_base", "fix_lints", "ask_question", "switch_mode", "generate_image", "report_bugfix_results", "ai_attribution",
    "reflect", "await", "update_project", "update_memory", "unspecified"] as const).map((n) => [n, "other"] as const),
]);

/** Cursor's numeric tool enum (`toolFormerData.tool`): used for a tool whose name is missing or unknown. */
const TOOL_IDS: ReadonlyMap<number, string> = new Map([
  [0, "unspecified"], [1, "read_semsearch_files"], [3, "ripgrep_search"], [5, "read_file"], [6, "list_dir"], [7, "edit_file"], [8, "file_search"],
  [9, "semantic_search_full"], [11, "delete_file"], [12, "reapply"], [15, "run_terminal_command_v2"], [16, "fetch_rules"], [18, "web_search"],
  [19, "mcp"], [23, "search_symbols"], [24, "background_composer_followup"], [25, "knowledge_base"], [26, "fetch_pull_request"], [27, "deep_search"],
  [28, "create_diagram"], [29, "fix_lints"], [30, "read_lints"], [31, "go_to_definition"], [32, "task"], [33, "await_task"], [34, "todo_read"],
  [35, "todo_write"], [38, "edit_file_v2"], [39, "list_dir_v2"], [40, "read_file_v2"], [41, "ripgrep_raw_search"], [42, "glob_file_search"],
  [43, "create_plan"], [44, "list_mcp_resources"], [45, "read_mcp_resource"], [46, "read_project"], [47, "update_project"], [48, "task_v2"],
  [49, "call_mcp_tool"], [50, "apply_agent_diff"], [51, "ask_question"], [52, "switch_mode"], [53, "generate_image"], [54, "computer_use"],
  [55, "write_shell_stdin"], [56, "record_screen"], [57, "web_fetch"], [58, "report_bugfix_results"], [59, "ai_attribution"], [60, "mcp_auth"],
  [61, "reflect"], [62, "await"], [63, "get_mcp_tools"],
]);
const idsOf = (names: readonly string[]): number[] => [...TOOL_IDS].filter(([, n]) => names.includes(n)).map(([id]) => id);
/** MCP tools of a server: names that start with `mcp_` or `mcp-` (the server's name sits inside, so it is never parsed out). */
const MCP_PREFIX = /^mcp[_-]/i;
/** `toolFormerData.status` of a tool that did not succeed. */
const FAILED = new Set(["error", "cancelled", "aborted"]);

interface ToolKind { name: string; category: ToolCategory; terminal: boolean; path: boolean }

/** A tool by its name (built-in names verbatim), else MCP by its name's prefix, else by its numeric id, else `other`. */
function toolKind(name: string | undefined, id: number | undefined): ToolKind {
  const mcpNamed = name !== undefined && !TOOL_NAMES.has(name) && MCP_PREFIX.test(name);
  if (mcpNamed) return { name: "mcp", category: "mcp", terminal: false, path: false };
  const known = name !== undefined && TOOL_NAMES.has(name) ? name : id === undefined ? undefined : TOOL_IDS.get(id);
  if (known === undefined) return { name: "other", category: "other", terminal: false, path: false };
  const category = TOOL_NAMES.get(known)!;
  return {
    name: category === "mcp" ? "mcp" : known, category,
    terminal: (TERMINAL_NAMES as readonly string[]).includes(known), path: (PATH_NAMES as readonly string[]).includes(known),
  };
}

// ---- SQL ----

const TOKEN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const lit = (name: string): string => {
  if (!TOKEN_NAME.test(name)) throw new Error("tool names in SQL must be plain identifiers");
  return `'${name}'`;
};
/** `tname`/`tid` name one of these tools (a terminal, a file-changing or an MCP tool), so its params are worth parsing. */
const isOneOf = (names: readonly string[]): string => `(tname IN (${names.map(lit).join(", ")}) OR tid IN (${idsOf(names).join(", ")}))`;
const either = (exprs: string[]): string => (exprs.length === 1 ? exprs[0]! : `COALESCE(${exprs.join(", ")})`);
/** The first of `paths` set in the JSON text `col` (params, raw arguments or result, double-encoded by Cursor), when it is valid JSON. */
const inJson = (col: string, paths: readonly string[]): string => `CASE WHEN json_valid(${col}) THEN ${either(paths.map((p) => `json_extract(${col}, '${p}')`))} END`;
/** The file a tool changes, as its params (camelCase) or the model's raw arguments (snake_case) name it. */
const PATH_KEYS = ["$.targetFile", "$.target_file", "$.relativeWorkspacePath", "$.relative_workspace_path", "$.filePath", "$.file_path", "$.path"];

/** A field of the row's value (`v`), extracted only when the value is valid JSON (`ok`); NULL otherwise. */
const field = (fn: string, path: string, alias: string): string => `CASE WHEN ok THEN ${fn}(v, '${path}') END AS ${alias}`;
/** One key family of cursorDiskKV, a page at a time: rowid, key, whether the value is valid JSON — and the value, which never leaves SQLite. */
const family = (prefix: string): string =>
  `SELECT rowid AS rid, key, value AS v, json_valid(value) AS ok FROM cursorDiskKV WHERE key LIKE '${prefix}:%' AND rowid > ? ORDER BY rowid LIMIT ?`;

const COMPOSER_SQL = `SELECT rid, key, ok, ${[
  field("json_extract", "$.createdAt", "created"), field("json_extract", "$.lastUpdatedAt", "updated"),
  field("json_extract", "$.isAgentic", "agentic"), field("json_extract", "$.unifiedMode", "mode"),
  field("json_extract", "$.modelConfig.modelName", "model"), field("json_type", "$.subagentInfo", "sub"),
  field("json_extract", "$.subagentInfo.toolCallId", "launch"), field("json_extract", "$.subComposerIds", "subs"),
  field("json_extract", "$.subagentComposerIds", "subagents"), field("json_array_length", "$.fullConversationHeadersOnly", "headers"),
  field("json_array_length", "$.conversation", "inline"),
].join(", ")} FROM (${family("composerData")})`;

/**
 * Bubbles: scalar fields, the text of user bubbles (type 1) only, and — inside SQLite — a tool's params, raw arguments
 * and result, from which only the command line, the target file, the MCP server and the exit code are returned.
 */
const BUBBLE_SQL = `SELECT rid, key, ok, type, created, model, thinking, err, tfd, tname, tid, tstatus, decision, tcall, text, ${[
  `CASE WHEN ${isOneOf(TERMINAL_NAMES)} THEN ${either([inJson("p", ["$.command"]), inJson("a", ["$.command"])])} END AS cmd`,
  `CASE WHEN ${isOneOf(PATH_NAMES)} THEN ${either([inJson("p", PATH_KEYS), inJson("a", PATH_KEYS)])} END AS target`,
  `CASE WHEN ${isOneOf(MCP_NAMES)} OR tname LIKE 'mcp%' THEN ${either([inJson("p", ["$.server"]), inJson("a", ["$.server"])])} END AS server`,
  `CASE WHEN ${isOneOf(TERMINAL_NAMES)} THEN ${inJson("r", ["$.exitCodeV2", "$.exitCode"])} END AS exit`,
].join(", ")} FROM (SELECT rid, key, ok, ${[
  field("json_extract", "$.type", "type"), field("json_extract", "$.createdAt", "created"),
  field("json_extract", "$.modelInfo.modelName", "model"), field("json_extract", "$.thinkingDurationMs", "thinking"),
  field("json_type", "$.errorDetails", "err"), field("json_type", "$.toolFormerData", "tfd"),
  field("json_extract", "$.toolFormerData.name", "tname"), field("json_extract", "$.toolFormerData.tool", "tid"),
  field("json_extract", "$.toolFormerData.status", "tstatus"), field("json_extract", "$.toolFormerData.userDecision", "decision"),
  field("json_extract", "$.toolFormerData.toolCallId", "tcall"),
  "CASE WHEN ok AND json_extract(v, '$.type') = 1 THEN json_extract(v, '$.text') END AS text",
  field("json_extract", "$.toolFormerData.params", "p"), field("json_extract", "$.toolFormerData.rawArgs", "a"),
  field("json_extract", "$.toolFormerData.result", "r"),
].join(", ")} FROM (${family("bubbleId")}))`;

// ---- mapping ----

/** A key's id after `prefix` (exact, case-sensitive); undefined for any other key. */
function after(key: unknown, prefix: string): string | undefined {
  return typeof key === "string" && key.startsWith(prefix) && key.length > prefix.length ? key.slice(prefix.length) : undefined;
}

/** `bubbleId:<composerId>:<bubbleId>` → the composer id. */
function bubbleComposer(key: unknown): string | undefined {
  const rest = after(key, "bubbleId:");
  const at = rest === undefined ? -1 : rest.indexOf(":");
  return at > 0 && at < rest!.length - 1 ? rest!.slice(0, at) : undefined;
}

/** The ids of a JSON array (the text `json_extract` returns for one), strings only. */
function idList(v: unknown): string[] {
  if (typeof v !== "string") return [];
  try {
    const list: unknown = JSON.parse(v);
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string" && x !== "") : [];
  } catch {
    return [];
  }
}

const count = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : 0);
const bubbleType = (t: unknown): string =>
  t === null || t === undefined ? "(none)" : typeof t === "number" && Number.isInteger(t) && t >= 0 && t < 100 ? String(t) : "(other)";

interface Composer {
  readonly raw: string;
  readonly id: string;
  readonly origin: Origin;
  /** A copy of a subagent launch already read: its bubbles are skipped. */
  readonly dup: boolean;
  readonly agent: boolean;
  readonly model?: string;
  readonly models: string[];
  /** Messages the composer lists (bubble headers) or holds inline. */
  readonly content: number;
  start?: number;
  end?: number;
  bubbles: number;
  humanPrompts: number;
  lastActivity?: number;
}

/** What reading cursorDiskKV found: whether it could be read at all, and how many composers it holds. */
export interface KvRead { readable: boolean; composers: number }

/**
 * Reads the composers and bubbles of one `cursorDiskKV` table: composers first (small per-composer state), then the
 * bubbles in rowid order (events emitted as they are read), then one SessionEv per composer.
 */
export class DiskKv {
  private readonly composers = new Map<string, Composer>();
  /** Child composer id → its parent's session id, from the parents' `subComposerIds`/`subagentComposerIds`. */
  private readonly parents = new Map<string, string>();
  /** Subagent launches read (`subagentInfo.toolCallId`): Cursor can persist one launch many times. */
  private readonly launches = new Set<string>();
  private readonly prevTexts = new Map<string, string>();

  constructor(private readonly db: RoDb, private readonly ctx: ScanCtx, private readonly tally: Tally) {}

  read(tables: ReadonlySet<string>): KvRead {
    const have = pageableColumns(this.db, tables, "cursorDiskKV", ["key", "value"], this.tally);
    if (!have?.has("key") || !have.has("value")) return { readable: false, composers: 0 };
    const cp: Paging = { done: false, unreadable: false };
    for (const rows of pages(this.db, COMPOSER_SQL, "cursorDiskKV", this.tally, this.ctx, cp)) for (const r of rows) eachRow(() => this.composer(r), this.tally);
    if (this.composers.size === 0) return { readable: cp.done, composers: 0 };
    const bp: Paging = { done: false, unreadable: false };
    for (const rows of pages(this.db, BUBBLE_SQL, "cursorDiskKV", this.tally, this.ctx, bp)) for (const r of rows) eachRow(() => this.bubble(r), this.tally);
    this.sessions(bp.done);
    return { readable: true, composers: this.composers.size };
  }

  private composer(r: Obj): void {
    const raw = after(r.key, "composerData:");
    if (raw === undefined) return this.tally.skip("bad-record");
    if (r.ok !== 1) this.tally.skip("parse"); // the composer exists; its bubbles still map
    const sub = r.sub === "object";
    const launch = sub ? str(r.launch) : undefined;
    const dup = launch !== undefined && this.launches.has(launch);
    if (launch !== undefined) this.launches.add(launch);
    if (dup) this.tally.skip("duplicate");
    const id = cuSessionId(raw, this.ctx);
    const rawModel = str(r.model);
    const model = rawModel === undefined ? undefined : safeModel(rawModel);
    const inline = dup ? 0 : count(r.inline);
    if (inline > 0) this.tally.skipped["inline-message"] = (this.tally.skipped["inline-message"] ?? 0) + inline;
    const c: Composer = {
      raw, id, origin: sub ? "subagent" : "human", dup, agent: r.agentic === 1 || r.mode === "agent", models: model === undefined ? [] : [model],
      content: count(r.headers) + inline, bubbles: 0, humanPrompts: 0, ...(model !== undefined && { model }),
    };
    this.span(c, toEpochMs(r.created, this.ctx.now));
    this.span(c, toEpochMs(r.updated, this.ctx.now));
    for (const child of [...idList(r.subs), ...idList(r.subagents)]) if (!this.parents.has(child)) this.parents.set(child, id);
    this.composers.set(raw, c);
  }

  private bubble(r: Obj): void {
    const raw = bubbleComposer(r.key);
    if (raw === undefined) return this.tally.skip("bad-record");
    const c = this.composers.get(raw);
    if (!c) return this.tally.skip("orphan");
    if (c.dup) return this.tally.skip("duplicate");
    c.bubbles++;
    if (r.ok !== 1) return this.tally.skip("parse");
    if (r.type !== 1 && r.type !== 2) return this.tally.unknownKey(`bubble-type:${bubbleType(r.type)}`);
    const rawModel = str(r.model);
    const model = rawModel === undefined ? undefined : safeModel(rawModel);
    if (model !== undefined && !c.models.includes(model)) c.models.push(model);
    const ts = toEpochMs(r.created, this.ctx.now);
    if (ts === undefined) return this.tally.skip("no-ts");
    if (r.type === 1) this.prompt(c, r, ts);
    if (r.type === 2 && r.tfd === "object") this.tool(c, r, ts);
    const thinking = num(r.thinking);
    if (thinking !== undefined && thinking > 0) {
      const ev: TurnEv = { k: "turn", tool: TOOL, source: IDE_SOURCE, ts, sessionId: c.id, window: "detail", ms: thinking };
      const turnModel = model ?? c.model;
      if (turnModel !== undefined) ev.model = turnModel;
      this.out(c, ev);
    }
    if (r.err !== undefined && r.err !== null && r.err !== "null") this.marker(c, ts, "error");
    if (c.lastActivity === undefined || ts > c.lastActivity) c.lastActivity = ts;
  }

  /** The person's message, in memory only: intent, features and a keyed hash. A subagent's user bubbles are its parent's briefs. */
  private prompt(c: Composer, r: Obj, ts: number): void {
    if (c.origin !== "human") return;
    const text = typeof r.text === "string" ? r.text : undefined;
    if (text === undefined || text.trim() === "") return this.tally.skip("empty");
    const isTaskStart = c.humanPrompts === 0 || (c.lastActivity !== undefined && ts - c.lastActivity >= TASK_GAP_MS);
    const ev: PromptEv = {
      k: "prompt", tool: TOOL, source: IDE_SOURCE, ts, sessionId: c.id, window: "detail", origin: "human",
      intent: classifyIntent(text), features: promptFeatures(text, { isTaskStart, prevText: this.prevTexts.get(c.raw) }), textHash: this.ctx.hash(text.trim()),
    };
    this.out(c, ev);
    c.humanPrompts++;
    this.prevTexts.delete(c.raw);
    this.prevTexts.set(c.raw, text);
    if (this.prevTexts.size > PREV_TEXTS) this.prevTexts.delete(this.prevTexts.keys().next().value!);
  }

  /**
   * One ToolEv per tool bubble. A terminal tool takes the category and checks of its command line and its exit code; a
   * file-changing tool the extension of its file; an MCP tool its server. `ok` is false when the person rejected it,
   * else `exit === 0` when an exit code is known, else from `status`. A rejection is also a denial marker.
   */
  private tool(c: Composer, r: Obj, ts: number): void {
    const kind = toolKind(str(r.tname), num(r.tid));
    const ev: ToolEv = { k: "tool", tool: TOOL, source: IDE_SOURCE, ts, sessionId: c.id, name: kind.name, category: kind.category };
    const call = str(r.tcall);
    if (call !== undefined) ev.callId = this.ctx.hash(call);
    if (kind.category === "mcp") {
      const server = str(r.server);
      if (server !== undefined) ev.mcpServer = server;
    }
    if (kind.terminal) {
      const cmd = str(r.cmd);
      if (cmd !== undefined) {
        const { category, checks } = classifyCommand(cmd);
        ev.category = category;
        if (checks.length > 0) ev.checks = checks;
      }
      const exit = num(r.exit);
      if (exit !== undefined && Number.isInteger(exit)) ev.exit = exit;
    }
    if (kind.path && (ev.category === "edit" || ev.category === "write")) {
      const target = str(r.target);
      const ext = target === undefined ? undefined : extOfPath(target);
      if (ext !== undefined) ev.editExt = ext;
    }
    const rejected = r.decision === "rejected";
    const status = typeof r.tstatus === "string" ? r.tstatus.toLowerCase() : undefined;
    if (rejected) ev.ok = false;
    else if (ev.exit !== undefined) ev.ok = ev.exit === 0;
    else if (status === "completed") ev.ok = true;
    else if (status !== undefined && FAILED.has(status)) ev.ok = false;
    this.out(c, ev);
    if (rejected) this.marker(c, ts, "denial");
  }

  private marker(c: Composer, ts: number, kind: MarkerKind): void {
    const m: MarkerEv = { k: "marker", tool: TOOL, source: IDE_SOURCE, ts, sessionId: c.id, kind };
    this.out(c, m);
  }

  private span(c: Composer, t: number | undefined): void {
    if (t === undefined) return;
    if (c.start === undefined || t < c.start) c.start = t;
    if (c.end === undefined || t > c.end) c.end = t;
  }

  private out(c: Composer, ev: Ev & { ts: number }): void {
    this.span(c, ev.ts);
    this.tally.span(ev.ts);
    this.ctx.emit(ev);
  }

  /**
   * One SessionEv per composer that is not a copy: `start`/`end` from its times and its bubbles'. A composer that lists
   * no messages and has no bubbles is skipped `empty-session` — only once every bubble page was read, since a bubble pass
   * that stopped early cannot tell. One without any time is skipped `no-ts`.
   */
  private sessions(bubblesRead: boolean): void {
    for (const c of this.composers.values()) {
      if (c.dup) continue;
      if (bubblesRead && c.bubbles === 0 && c.content === 0) {
        this.tally.skip("empty-session");
        continue;
      }
      if (c.start === undefined || c.end === undefined) {
        this.tally.skip("no-ts");
        continue;
      }
      const s: SessionEv = {
        k: "session", tool: TOOL, source: IDE_SOURCE, id: c.id, window: "detail", origin: c.origin, start: c.start, end: c.end,
        models: [...c.models], surface: c.agent ? "agent" : "chat",
      };
      const parent = this.parents.get(c.raw);
      if (parent !== undefined && parent !== c.id) s.parentId = parent;
      this.ctx.emit(s);
      this.tally.span(c.start);
      this.tally.span(c.end);
    }
  }
}
