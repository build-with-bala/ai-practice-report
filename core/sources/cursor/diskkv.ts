import { safeStat } from "../../io/fs";
import { isBusyError, MAX_COPY_BYTES, openRo, type RoDb } from "../../io/sqlite";
import { toEpochMs } from "../../io/time";
import type { Ev, MarkerEv, PromptEv, SessionEv, ToolEv } from "../../model/events";
import { sid, type MarkerKind, type Origin, type ToolCategory } from "../../model/ids";
import { classifyCommand } from "../../text/commands";
import { classifyIntent } from "../../text/intent";
import { promptFeatures } from "../../text/structure";
import type { Tally } from "../common/coverage";
import { extOfPath, idPart, num, safeModel, str, UUID, type Obj } from "../common/guards";
import type { ScanCtx } from "../types";

export const TOOL = "cursor";
export const IDE_SOURCE = "cursor.ide";
/** Rows per query: every table is read in pages, so memory stays bounded however large the store grows. */
export const PAGE = 2_000;
/** A message this long after the session's previous activity starts a new task. */
export const TASK_GAP_MS = 30 * 60_000;
/** The detail window: bubbles are read only for composers updated in the last 90 days (or since `ctx.since`). */
const DETAIL_MS = 90 * 86_400_000;
const WITHOUT_ROWID = /\bWITHOUT\s+ROWID\b/i;
const KV = "cursorDiskKV";

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
 * The columns of `table`; each one of `wanted` missing is drift `missing-column:<name>`. Undefined when the table is
 * missing (drift `missing-table:<name>`) or its schema cannot be read (io-error).
 */
export function tableColumns(db: RoDb, tables: ReadonlySet<string>, table: string, wanted: readonly string[], tally: Tally): Set<string> | undefined {
  if (!tables.has(table)) {
    tally.unknownKey(`missing-table:${table}`);
    return undefined;
  }
  let have: Set<string>;
  try {
    have = new Set(db.columns(table));
  } catch {
    tally.skip("io-error");
    return undefined;
  }
  for (const c of wanted) if (!have.has(c)) tally.unknownKey(`missing-column:${c}`);
  return have;
}

/** Whether `table` has a rowid to page by; a table declared WITHOUT ROWID has none: drift `table-unreadable:<name>`. */
function rowidPageable(db: RoDb, table: string, tally: Tally): boolean {
  const ddl = db.get<{ sql: unknown }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", table)?.sql;
  if (typeof ddl !== "string" || !WITHOUT_ROWID.test(ddl)) return true;
  tally.unknownKey(`table-unreadable:${table}`);
  return false;
}

/** The columns of a table the reader can page by rowid (see `tableColumns`); undefined, and drift, for a table without rowids. */
export function pageableColumns(db: RoDb, tables: ReadonlySet<string>, table: string, wanted: readonly string[], tally: Tally): Set<string> | undefined {
  const have = tableColumns(db, tables, table, wanted, tally);
  if (have === undefined) return undefined;
  try {
    return rowidPageable(db, table, tally) ? have : undefined;
  } catch {
    tally.skip("io-error");
    return undefined;
  }
}

/**
 * Whether `table` has an index the reader can page by key: unique, not partial, on `key` alone in binary order —
 * Cursor's `key TEXT UNIQUE`, or a WITHOUT ROWID table's primary key `key`.
 */
function keyIndexed(db: RoDb, table: string): boolean {
  for (const ix of db.all<Obj>('SELECT name, "unique" AS u, partial FROM pragma_index_list(?)', table)) {
    if (ix.u !== 1 || ix.partial === 1 || typeof ix.name !== "string") continue;
    const cols = db.all<Obj>("SELECT name, coll FROM pragma_index_xinfo(?) WHERE key = 1", ix.name);
    if (cols.length === 1 && cols[0]!.name === "key" && String(cols[0]!.coll).toUpperCase() === "BINARY") return true;
  }
  return false;
}

/**
 * The queries of one pass over a table, PAGE rows each. The first query of the pass that fails other than busy means
 * it can never work on this table: drift `table-unreadable:<table>`. A busy store, or any later failure, is an
 * io-error. Any failure ends the pass.
 */
// TODO(Plan 2 Task 0): this pager is synchronous and never yields to the event loop, so a signal or an abort waits
// for the whole table. Move it onto the shared async pager (common/sqlite.ts) that awaits maybeYield() between pages.
export class Pass {
  private started = false;
  failed = false;
  unreadable = false;

  constructor(private readonly db: RoDb, private readonly table: string, private readonly tally: Tally, private readonly ctx: ScanCtx) {}

  private page(sql: string, params: unknown[], rows = true): Obj[] | undefined {
    if (this.failed || this.ctx.signal.aborted) return undefined;
    const first = !this.started;
    this.started = true;
    try {
      const got = this.db.all<Obj>(sql, ...params);
      if (rows) this.tally.records += got.length;
      return got;
    } catch (e) {
      this.failed = true;
      if (first && !isBusyError(e)) {
        this.tally.unknownKey(`table-unreadable:${this.table}`);
        this.unreadable = true;
      } else this.tally.skip("io-error");
      this.ctx.log("warn", "cu.db-query");
      return undefined;
    }
  }

  /**
   * The rows whose key lies strictly between `lo` and `hi`, in key order, each page resuming after the last key read
   * (`sql` binds the start key, `hi` and the page size). True when every page was read.
   */
  byKey(sql: string, lo: string, hi: string, each: (rows: Obj[]) => void): boolean {
    for (let after = lo; ;) {
      const rows = this.page(sql, [after, hi, PAGE]);
      if (rows === undefined) return false;
      if (rows.length > 0) each(rows);
      if (rows.length < PAGE) return true;
      const last = rows[rows.length - 1]!.key;
      if (typeof last !== "string") return false; // keys inside a text range are text
      after = last;
    }
  }

  /** One lookup within the pass (it is not counted as rows read): its first row; undefined when it has none, or when it failed (`failed`). */
  lookup(sql: string, params: unknown[]): Obj | undefined {
    return this.page(sql, params, false)?.[0];
  }

  /** The rows of `sql` in rowid order (it selects the rowid as `rid` and binds the last rowid read and the page size). True when every page was read. */
  byRowid(sql: string, each: (rows: Obj[]) => void): boolean {
    for (let after = Number.MIN_SAFE_INTEGER; ;) {
      const rows = this.page(sql, [after, PAGE]);
      if (rows === undefined) return false;
      if (rows.length > 0) each(rows);
      if (rows.length < PAGE) return true;
      after = rows[rows.length - 1]!.rid as number;
    }
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
  // bookkeeping and talk with the person: questions, mode switches, reflection, waiting, reports
  ...(["ask_question", "switch_mode", "reflect", "await", "report_bugfix_results"] as const).map((n) => [n, "meta"] as const),
  ...(["create_diagram", "knowledge_base", "fix_lints", "generate_image", "ai_attribution", "update_project", "update_memory", "unspecified"] as const)
    .map((n) => [n, "other"] as const),
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
/** `toolFormerData.status` of a tool that did not run to an end of its own: cancelled before it ran, or stopped while it ran. */
const NOT_ENDED: ReadonlyMap<string, NonNullable<ToolEv["outcome"]>> = new Map([["cancelled", "cancelled"], ["aborted", "interrupted"]]);

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

/** Key index: a key range in key order. Without one: a rowid scan with a prefix filter. */
type Mode = "key" | "rowid";
/** A field of the row's value (`v`), extracted only when the value is valid JSON (`ok`); NULL otherwise. */
const field = (fn: string, path: string, alias: string): string => `CASE WHEN ok THEN ${fn}(v, '${path}') END AS ${alias}`;
/**
 * One page of a key family: the key, the value — read once, and never returned: only the fields extracted from it
 * leave SQLite — and whether it is valid JSON.
 */
const family = (mode: Mode, prefix: string): string => (mode === "key"
  ? `SELECT key, value AS v, json_valid(value) AS ok FROM ${KV} WHERE key > ? AND key < ? ORDER BY key LIMIT ?`
  : `SELECT rowid AS rid, key, value AS v, json_valid(value) AS ok FROM ${KV} WHERE key LIKE '${prefix}:%' AND rowid > ? ORDER BY rowid LIMIT ?`);
const head = (mode: Mode): string => (mode === "key" ? "key, ok" : "rid, key, ok");
const order = (mode: Mode): string => (mode === "key" ? "ORDER BY key" : "ORDER BY rid");

/** The bubble ids an array of the value `col` lists (`fullConversationHeadersOnly`, or an old composer's inline `conversation`), as a JSON array of ids. */
const listedIds = (col: string, path: string): string =>
  `(SELECT json_group_array(json_extract(h.value, '$.bubbleId')) FROM json_each(${col}, '${path}') AS h WHERE h.type = 'object')`;
/** One composer's listed bubble ids, looked up by its key just before its bubbles are read (key index only). */
const HEADER_SQL = `SELECT ${listedIds("kv.value", "$.fullConversationHeadersOnly")} AS hids, ${listedIds("kv.value", "$.conversation")} AS iids `
  + `FROM ${KV} AS kv WHERE kv.key = ? AND json_valid(kv.value)`;

const COMPOSER_FIELDS = [
  field("json_extract", "$.createdAt", "created"), field("json_extract", "$.lastUpdatedAt", "updated"),
  field("json_extract", "$.isAgentic", "agentic"), field("json_extract", "$.unifiedMode", "mode"),
  field("json_extract", "$.modelConfig.modelName", "model"), field("json_type", "$.subagentInfo", "sub"),
  field("json_extract", "$.subagentInfo.toolCallId", "launch"), field("json_extract", "$.subComposerIds", "subs"),
  field("json_extract", "$.subagentComposerIds", "subagents"), field("json_array_length", "$.fullConversationHeadersOnly", "headers"),
  field("json_array_length", "$.conversation", "inline"),
];
/** Bubbles: scalar fields, the text of user bubbles (type 1) only, and — inside SQLite — a tool's params, raw arguments and result. */
const BUBBLE_FIELDS = [
  field("json_extract", "$.type", "type"), field("json_extract", "$.createdAt", "created"),
  field("json_extract", "$.modelInfo.modelName", "model"), field("json_type", "$.errorDetails", "err"),
  field("json_type", "$.toolFormerData", "tfd"),
  field("json_extract", "$.toolFormerData.name", "tname"), field("json_extract", "$.toolFormerData.tool", "tid"),
  field("json_extract", "$.toolFormerData.status", "tstatus"), field("json_extract", "$.toolFormerData.userDecision", "decision"),
  field("json_extract", "$.toolFormerData.toolCallId", "tcall"),
  "CASE WHEN ok AND json_extract(v, '$.type') = 1 THEN json_extract(v, '$.text') END AS text",
  field("json_extract", "$.toolFormerData.params", "p"), field("json_extract", "$.toolFormerData.rawArgs", "a"),
  field("json_extract", "$.toolFormerData.result", "r"),
];
/** From a tool's params, raw arguments and result only the command line, the target file, the MCP server and the exit code are returned. */
const TOOL_PARTS = [
  `CASE WHEN ${isOneOf(TERMINAL_NAMES)} THEN ${either([inJson("p", ["$.command"]), inJson("a", ["$.command"])])} END AS cmd`,
  `CASE WHEN ${isOneOf(PATH_NAMES)} THEN ${either([inJson("p", PATH_KEYS), inJson("a", PATH_KEYS)])} END AS target`,
  `CASE WHEN ${isOneOf(MCP_NAMES)} OR tname LIKE 'mcp%' THEN ${either([inJson("p", ["$.server"]), inJson("a", ["$.server"])])} END AS server`,
  `CASE WHEN ${isOneOf(TERMINAL_NAMES)} THEN ${inJson("r", ["$.exitCodeV2", "$.exitCode"])} END AS exit`,
];
/** Without the key index there is no cheap lookup per composer: the composer scan carries the listed ids itself. */
const LISTED_FIELDS = [
  `CASE WHEN ok THEN ${listedIds("v", "$.fullConversationHeadersOnly")} END AS hids`, `CASE WHEN ok THEN ${listedIds("v", "$.conversation")} END AS iids`,
];
const composerSql = (mode: Mode): string =>
  `SELECT ${head(mode)}, ${[...COMPOSER_FIELDS, ...(mode === "rowid" ? LISTED_FIELDS : [])].join(", ")} FROM (${family(mode, "composerData")}) ${order(mode)}`;
const bubbleSql = (mode: Mode): string =>
  `SELECT ${head(mode)}, type, created, model, err, tfd, tname, tid, tstatus, decision, tcall, text, ${TOOL_PARTS.join(", ")} `
  + `FROM (SELECT ${head(mode)}, ${BUBBLE_FIELDS.join(", ")} FROM (${family(mode, "bubbleId")})) ${order(mode)}`;
const SQL: Record<Mode, { composers: string; bubbles: string }> = {
  key: { composers: composerSql("key"), bubbles: bubbleSql("key") },
  rowid: { composers: composerSql("rowid"), bubbles: bubbleSql("rowid") },
};

// ---- mapping ----

/** A key's id after `prefix` (exact, case-sensitive); undefined for any other key. */
function after(key: unknown, prefix: string): string | undefined {
  return typeof key === "string" && key.startsWith(prefix) && key.length > prefix.length ? key.slice(prefix.length) : undefined;
}

/**
 * `bubbleId:<composerId>:<bubbleId>` → its composer and bubble ids. A bubble id holds no colon, so the composer id runs
 * to the last one (a composer id can hold colons).
 */
function bubbleKey(key: unknown): { composer: string; bubble: string } | undefined {
  const rest = after(key, "bubbleId:");
  const at = rest === undefined ? -1 : rest.lastIndexOf(":");
  return at > 0 && at < rest!.length - 1 ? { composer: rest!.slice(0, at), bubble: rest!.slice(at + 1) } : undefined;
}

/** The bubble ids a composer lists, from the JSON arrays of ids its header list and inline conversation give; undefined when they name none. */
function listed(...arrays: unknown[]): Set<string> | undefined {
  const ids = new Set(arrays.flatMap(idList));
  return ids.size > 0 ? ids : undefined;
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
  /** Messages the composer lists in its header list (`fullConversationHeadersOnly`). */
  readonly listed: number;
  /** Messages an old composer holds inline (`conversation`). */
  readonly inline: number;
  /** The bubble ids it lists: only those are mapped, while its bubbles are read; undefined when it lists none. */
  ids?: Set<string>;
  /** Updated inside the detail window, or of unknown age: its bubbles are read. */
  readonly detail: boolean;
  start?: number;
  end?: number;
  bubbles: number;
  /** Every page of its bubbles was read. */
  bubblesRead: boolean;
  /** Its user messages, mapped in time order once its bubbles are read. */
  prompts: { ts: number; text: string }[];
  /** The times of its bubbles: a prompt after a gap of TASK_GAP_MS since the latest of them starts a task. */
  times: number[];
}

/** What reading cursorDiskKV found: whether it could be read at all, and how many composers it holds. */
export interface KvRead { readable: boolean; composers: number }

/**
 * Reads the composers and bubbles of one `cursorDiskKV` table: composers first (small per-composer state), then the
 * bubbles of the composers inside the detail window (events emitted as they are read, prompts per composer in time
 * order), then one SessionEv per composer. With the key index each key family is a key range read in key order, and
 * each composer's bubbles their own range; without one, each family is one rowid scan with a prefix filter.
 * Two windows: the composers are Cursor's index of every conversation (the lifetime tally: their rows, their skips, the
 * span of every session), the bubbles the detail of the recent ones (the detail tally: bubble rows and their events).
 */
export class DiskKv {
  private readonly composers = new Map<string, Composer>();
  /** Child composer id → its parent's session id, from the parents' `subComposerIds`/`subagentComposerIds`. */
  private readonly parents = new Map<string, string>();
  /** Subagent launches read (`subagentInfo.toolCallId`): Cursor can persist one launch many times. */
  private readonly launches = new Set<string>();
  /** Composers last updated before this time are outside the detail window. */
  private readonly windowStart: number;
  /** Bubbles of a known type read, and how many of them had a time: none timed means the time field moved. */
  private typed = 0;
  private timed = 0;

  constructor(private readonly db: RoDb, private readonly ctx: ScanCtx, private readonly tally: Tally, private readonly life: Tally) {
    this.windowStart = ctx.since ?? ctx.now - DETAIL_MS;
  }

  read(tables: ReadonlySet<string>): KvRead {
    const have = tableColumns(this.db, tables, KV, ["key", "value"], this.tally);
    if (!have?.has("key") || !have.has("value")) return { readable: false, composers: 0 };
    let mode: Mode;
    try {
      mode = keyIndexed(this.db, KV) ? "key" : "rowid";
      if (mode === "rowid") {
        this.tally.unknownKey(`no-key-index:${KV}`);
        if (!rowidPageable(this.db, KV, this.tally)) return { readable: false, composers: 0 };
      }
    } catch {
      this.tally.skip("io-error");
      return { readable: false, composers: 0 };
    }
    const pass = new Pass(this.db, KV, this.life, this.ctx);
    const rows = (list: Obj[]) => { for (const r of list) eachRow(() => this.composer(r), this.life); };
    const done = mode === "key" ? pass.byKey(SQL.key.composers, "composerData:", "composerData;", rows) : pass.byRowid(SQL.rowid.composers, rows);
    if (pass.unreadable) return { readable: false, composers: 0 };
    if (this.composers.size === 0) return { readable: done, composers: 0 };
    if (mode === "key") this.bubblesByComposer();
    else this.bubblesByScan();
    this.sessions();
    return { readable: true, composers: this.composers.size };
  }

  private composer(r: Obj): void {
    const raw = after(r.key, "composerData:");
    if (raw === undefined) return this.life.skip("bad-record");
    if (r.ok !== 1) this.life.skip("parse"); // the composer exists; its bubbles still map
    const sub = r.sub === "object";
    const launch = sub ? str(r.launch) : undefined;
    const dup = launch !== undefined && this.launches.has(launch);
    if (launch !== undefined) this.launches.add(launch);
    if (dup) this.life.skip("duplicate");
    const id = cuSessionId(raw, this.ctx);
    const rawModel = str(r.model);
    const model = rawModel === undefined ? undefined : safeModel(rawModel);
    const inline = dup ? 0 : count(r.inline);
    if (inline > 0) this.tally.skipped["inline-message"] = (this.tally.skipped["inline-message"] ?? 0) + inline;
    const times = [toEpochMs(r.created, this.ctx.now), toEpochMs(r.updated, this.ctx.now)].filter((t): t is number => t !== undefined);
    const detail = times.length === 0 || Math.max(...times) >= this.windowStart;
    const c: Composer = {
      raw, id, origin: sub ? "subagent" : "human", dup, agent: r.agentic === 1 || r.mode === "agent", models: model === undefined ? [] : [model],
      listed: dup ? 0 : count(r.headers), inline, detail, bubbles: 0, bubblesRead: false, prompts: [], times: [], ...(model !== undefined && { model }),
    };
    // the rowid scan carries the listed ids (kept for composers whose bubbles will be read); the key path looks them up later
    if (detail && !dup) c.ids = listed(r.hids, r.iids);
    for (const t of times) this.span(c, t);
    for (const child of [...idList(r.subs), ...idList(r.subagents)]) if (!this.parents.has(child)) this.parents.set(child, id);
    this.composers.set(raw, c);
  }

  /** Key index: each composer's bubbles are its own key range — only composers inside the window, never a copy. */
  private bubblesByComposer(): void {
    const pass = new Pass(this.db, KV, this.tally, this.ctx);
    for (const c of this.composers.values()) {
      if (c.dup || !c.detail) continue;
      if (pass.failed || this.ctx.signal.aborted) break;
      if (c.listed + c.inline > 0) {
        const row = pass.lookup(HEADER_SQL, [`composerData:${c.raw}`]);
        if (pass.failed) break;
        c.ids = listed(row?.hids, row?.iids);
      }
      const lo = `bubbleId:${c.raw}:`;
      c.bubblesRead = pass.byKey(SQL.key.bubbles, lo, `bubbleId:${c.raw};`, (rows) => {
        for (const r of rows) eachRow(() => this.inRange(c, lo, r), this.tally);
      });
      this.flush(c);
    }
  }

  /** No key index: one rowid scan of every bubble, each matched to its composer by its key; bubbles outside the window are not mapped. */
  private bubblesByScan(): void {
    const pass = new Pass(this.db, KV, this.tally, this.ctx);
    const done = pass.byRowid(SQL.rowid.bubbles, (rows) => {
      for (const r of rows) eachRow(() => this.scanned(r), this.tally);
    });
    for (const c of this.composers.values()) {
      c.bubblesRead = done;
      this.flush(c);
    }
  }

  /** A row of a composer's own key range; one whose rest holds a colon belongs to a nested composer (`<id>:<more>`), read in its own range. */
  private inRange(c: Composer, lo: string, r: Obj): void {
    const rest = typeof r.key === "string" ? r.key.slice(lo.length) : "";
    if (rest !== "" && !rest.includes(":")) this.bubble(c, r, rest);
  }

  private scanned(r: Obj): void {
    const key = bubbleKey(r.key);
    if (key === undefined) return this.tally.skip("bad-record");
    const c = this.composers.get(key.composer);
    if (!c) return this.tally.skip("orphan");
    if (c.dup) return this.tally.skip("duplicate");
    if (c.detail) this.bubble(c, r, key.bubble);
  }

  /**
   * One bubble of a composer inside the window. A composer that lists its bubble ids has only those mapped: rows it
   * does not list (the transcript copies Cursor writes when an agent forks itself) are skipped `unlisted`.
   */
  private bubble(c: Composer, r: Obj, bubbleId: string): void {
    if (c.ids !== undefined && !c.ids.has(bubbleId)) return this.tally.skip("unlisted");
    c.bubbles++;
    if (r.ok !== 1) return this.tally.skip("parse");
    if (r.type !== 1 && r.type !== 2) return this.tally.unknownKey(`bubble-type:${bubbleType(r.type)}`);
    const rawModel = str(r.model);
    const model = rawModel === undefined ? undefined : safeModel(rawModel);
    if (model !== undefined && !c.models.includes(model)) c.models.push(model);
    this.typed++;
    const ts = toEpochMs(r.created, this.ctx.now);
    if (ts === undefined) return this.tally.skip("no-ts");
    this.timed++;
    c.times.push(ts);
    this.span(c, ts);
    if (r.type === 1) this.prompt(c, r, ts);
    if (r.type === 2 && r.tfd === "object") this.tool(c, r, ts);
    // a bubble's thinkingDurationMs is time spent thinking, not a turn: the store marks no end of a turn, so no TurnEv
    if (r.err !== undefined && r.err !== null && r.err !== "null") this.marker(c, ts, "error");
  }

  /**
   * The person's message, kept until the composer's bubbles are read. A subagent's user bubbles are its parent's briefs.
   * A user bubble without a text field is drift `missing-field:text`; a blank one is skipped `empty`.
   */
  private prompt(c: Composer, r: Obj, ts: number): void {
    if (c.origin !== "human") return;
    if (typeof r.text !== "string") return this.tally.unknownKey("missing-field:text");
    if (r.text.trim() === "") return this.tally.skip("empty");
    c.prompts.push({ ts, text: r.text });
  }

  /**
   * A composer's prompts, in time order, from the text in memory: intent, features and a keyed hash. A task starts at
   * its first prompt and at one that comes TASK_GAP_MS or more after the latest earlier bubble; `simToPrev` compares
   * with the previous prompt. The texts are dropped afterwards.
   */
  private flush(c: Composer): void {
    const times = c.times.sort((a, b) => a - b);
    let at = 0;
    let prev: string | undefined;
    for (const [i, p] of c.prompts.sort((a, b) => a.ts - b.ts).entries()) {
      while (at < times.length && times[at]! < p.ts) at++;
      const before = at > 0 ? times[at - 1] : undefined;
      const isTaskStart = i === 0 || (before !== undefined && p.ts - before >= TASK_GAP_MS);
      const prevText = prev;
      eachRow(() => {
        const ev: PromptEv = {
          k: "prompt", tool: TOOL, source: IDE_SOURCE, ts: p.ts, sessionId: c.id, window: "detail", origin: "human",
          intent: classifyIntent(p.text), features: promptFeatures(p.text, { isTaskStart, prevText }), textHash: this.ctx.hash(p.text.trim()),
        };
        this.out(c, ev);
      }, this.tally);
      prev = p.text;
    }
    c.prompts = [];
    c.times = [];
    c.ids = undefined;
  }

  /**
   * One ToolEv per tool bubble. A terminal tool takes the category and checks of its command line and its exit code; a
   * file-changing tool the extension of its file; an MCP tool its server. A tool the person rejected has outcome
   * `denied` (and a denial marker), one `cancelled` or `aborted` the outcome `cancelled` or `interrupted` — none of them
   * has ok or exit. Else `ok` = `exit === 0` when an exit code is known, else from `status` (`completed`, `error`).
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
    const status = typeof r.tstatus === "string" ? r.tstatus.toLowerCase() : undefined;
    const outcome = r.decision === "rejected" ? "denied" : status === undefined ? undefined : NOT_ENDED.get(status);
    if (outcome !== undefined) {
      ev.outcome = outcome;
      delete ev.exit;
    } else if (ev.exit !== undefined) ev.ok = ev.exit === 0;
    else if (status === "completed") ev.ok = true;
    else if (status === "error") ev.ok = false;
    this.out(c, ev);
    if (outcome === "denied") this.marker(c, ts, "denial", "user");
  }

  private marker(c: Composer, ts: number, kind: MarkerKind, detail?: string): void {
    const m: MarkerEv = { k: "marker", tool: TOOL, source: IDE_SOURCE, ts, sessionId: c.id, kind };
    if (detail !== undefined) m.detail = detail;
    this.out(c, m);
  }

  private span(c: Composer, t: number): void {
    if (c.start === undefined || t < c.start) c.start = t;
    if (c.end === undefined || t > c.end) c.end = t;
  }

  private out(c: Composer, ev: Ev & { ts: number }): void {
    this.span(c, ev.ts);
    this.tally.span(ev.ts);
    this.ctx.emit(ev);
  }

  /**
   * One SessionEv per composer that is not a copy, each mapped on its own (a failure is a bad-record). Inside the window
   * (`detail`): `start`/`end` from its times and its bubbles'; a composer that lists no message and has no bubble is
   * skipped `empty-session` — only once all its bubbles were read, since a pass that stopped early cannot tell — and one
   * without any time `no-ts`. A composer whose header list names messages none of which has a bubble row counts
   * `missing-bubbles` (its session is still emitted); when every composer that lists messages is such a one, the format
   * has changed: drift `missing-bubbles:cursorDiskKV`. Outside the window (`lifetime`), from the composer alone: counted
   * `outside-window` (its bubbles were not read), or `empty-session` when it lists no message.
   */
  private sessions(): void {
    let missing = 0;
    let found = false;
    for (const c of this.composers.values()) {
      if (c.dup) continue;
      if (c.detail && c.bubblesRead && c.listed > 0) {
        if (c.bubbles > 0) found = true;
        else {
          missing++;
          this.tally.skip("missing-bubbles");
        }
      }
      eachRow(() => this.session(c), this.life);
    }
    // every composer that lists messages has none of them: the bubbles' key family has moved or been renamed
    if (missing > 0 && !found) this.tally.unknownKey(`missing-bubbles:${KV}`);
    // most bubbles carry createdAt: when none of those read has one, the field has moved or been renamed
    if (this.typed > 0 && this.timed === 0) this.tally.unknownKey("missing-field:createdAt");
  }

  private session(c: Composer): void {
    const empty = c.listed + c.inline === 0 && (c.detail ? c.bubblesRead && c.bubbles === 0 : true);
    if (empty) return this.life.skip("empty-session");
    if (!c.detail) this.tally.skip("outside-window"); // its bubbles, the detail, were not read
    if (c.start === undefined || c.end === undefined) return this.life.skip("no-ts");
    const s: SessionEv = {
      k: "session", tool: TOOL, source: IDE_SOURCE, id: c.id, window: c.detail ? "detail" : "lifetime", origin: c.origin, start: c.start,
      end: c.end, models: [...c.models], surface: "ide", mode: c.agent ? "agent" : "chat",
    };
    const parent = this.parents.get(c.raw);
    if (parent !== undefined && parent !== c.id) s.parentId = parent;
    this.ctx.emit(s);
    for (const t of c.detail ? [this.life, this.tally] : [this.life]) {
      t.span(c.start);
      t.span(c.end);
    }
  }
}
