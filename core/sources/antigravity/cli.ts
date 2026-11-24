import path from "node:path";
import type { Env } from "../../env/env";
import { joinFor } from "../../env/paths";
import { isDir, isFile } from "../../io/fs";
import { pbStr, pbTime, pbTimeRaw, pbTryNested, type PbField } from "../../io/protobuf";
import type { RoDb } from "../../io/sqlite";
import { toEpochMs } from "../../io/time";
import { TASK_GAP_MS } from "../../model/constants";
import type { Ev, MarkerEv, PromptEv, SessionEv, ToolEv, UsageEv } from "../../model/events";
import type { MarkerKind, Origin, ToolCategory } from "../../model/ids";
import { classifyCommand } from "../../text/commands";
import { classifyIntent } from "../../text/intent";
import { promptFeatures } from "../../text/structure";
import { listDir, Tally } from "../common/coverage";
import { isObj, num, safeModel, str, type Obj } from "../common/guards";
import { eachRow, Pass, q, readStore } from "../common/sqlite";
import { streamJsonlFile } from "../common/stream";
import { uriToPath } from "../common/uri";
import type { Candidate, ScanCtx } from "../types";
import { agSessionId, TOOL } from "./ids";

export const CLI_SOURCE = "antigravity.cli";
/** Go's zero time (`0001-01-01 …`), written for a time column never set. */
const isGoZero = (v: unknown): boolean => typeof v === "string" && v.trimStart().startsWith("0001-01-01");

/** Summary rows per query. */
const SUMMARY_PAGE = 1_000;
/**
 * Blobs above this never leave SQLite: a step's metadata (it holds every call's arguments, whole files among them) and a run
 * command's payload (its output). Of an oversize metadata blob only its first HEAD_BYTES are read, for the step's time.
 */
const BLOB_CAP = 1_048_576;
const HEAD_BYTES = 64;
/** Step rows per query: with both blobs at the cap, a page stays near 64 MiB. */
const STEP_PAGE = 32;
const WITHOUT_ROWID = /\bWITHOUT\s+ROWID\b/i;
/** An enum name the program does not know, as a drift key: never echoed. */
const enumKey = (v: unknown): string => (typeof v !== "string" ? "(none)" : "(other)");

// ---- protobuf fields ----

/**
 * The complete leading fields of a blob's first bytes (cut short inside SQL). Decoding runs from the start, so the longest
 * prefix that decodes ends exactly at a field boundary; null when not even the first field is complete.
 */
function leadingFields(head: Uint8Array): ReadonlyMap<number, PbField[]> | null {
  for (let end = head.length; end > 0; end--) {
    const fields = pbTryNested(head.subarray(0, end));
    if (fields) return fields;
  }
  return null;
}

// ---- step types (the CLI program's `CortexStepType`, also the transcript's `type` names) ----

/** `CortexStepType` number → its name without the `CORTEX_STEP_TYPE_` prefix. */
const STEP_TYPES: ReadonlyMap<number, string> = new Map([
  [0, "UNSPECIFIED"], [1, "DUMMY"], [2, "FINISH"], [3, "PLAN_INPUT"], [4, "MQUERY"], [5, "CODE_ACTION"], [6, "GIT_COMMIT"], [7, "GREP_SEARCH"],
  [8, "VIEW_FILE"], [9, "LIST_DIRECTORY"], [10, "COMPILE"], [13, "VIEW_CODE_ITEM"], [14, "USER_INPUT"], [15, "PLANNER_RESPONSE"], [17, "ERROR_MESSAGE"],
  [21, "RUN_COMMAND"], [23, "CHECKPOINT"], [24, "PROPOSE_CODE"], [25, "FIND"], [27, "SUGGESTED_RESPONSES"], [28, "COMMAND_STATUS"], [29, "MEMORY"],
  [31, "READ_URL_CONTENT"], [32, "VIEW_CONTENT_CHUNK"], [33, "SEARCH_WEB"], [34, "RETRIEVE_MEMORY"], [38, "MCP_TOOL"], [39, "MANAGER_FEEDBACK"],
  [40, "TOOL_CALL_PROPOSAL"], [41, "TOOL_CALL_CHOICE"], [42, "TRAJECTORY_CHOICE"], [45, "CLIPBOARD"], [47, "VIEW_FILE_OUTLINE"], [49, "POST_PR_REVIEW"],
  [51, "LIST_RESOURCES"], [52, "READ_RESOURCE"], [53, "LINT_DIFF"], [54, "FIND_ALL_REFERENCES"], [55, "BRAIN_UPDATE"], [56, "OPEN_BROWSER_URL"],
  [57, "RUN_EXTENSION_CODE"], [59, "PROPOSAL_FEEDBACK"], [60, "TRAJECTORY_SEARCH"], [61, "EXECUTE_BROWSER_JAVASCRIPT"], [62, "LIST_BROWSER_PAGES"],
  [63, "CAPTURE_BROWSER_SCREENSHOT"], [64, "CLICK_BROWSER_PIXEL"], [65, "READ_TERMINAL"], [66, "CAPTURE_BROWSER_CONSOLE_LOGS"], [67, "READ_BROWSER_PAGE"],
  [68, "BROWSER_GET_DOM"], [73, "CODE_SEARCH"], [74, "BROWSER_INPUT"], [75, "BROWSER_MOVE_MOUSE"], [76, "BROWSER_SELECT_OPTION"], [77, "BROWSER_SCROLL_UP"],
  [78, "BROWSER_SCROLL_DOWN"], [79, "BROWSER_CLICK_ELEMENT"], [80, "BROWSER_PRESS_KEY"], [81, "TASK_BOUNDARY"], [82, "NOTIFY_USER"],
  [83, "CODE_ACKNOWLEDGEMENT"], [84, "INTERNAL_SEARCH"], [85, "BROWSER_SUBAGENT"], [86, "FILE_CHANGE"], [87, "MOVE"], [88, "BROWSER_SCROLL"],
  [89, "KNOWLEDGE_GENERATION"], [90, "EPHEMERAL_MESSAGE"], [91, "GENERATE_IMAGE"], [92, "DELETE_DIRECTORY"], [93, "COMPILE_APPLET"],
  [94, "INSTALL_APPLET_DEPENDENCIES"], [95, "INSTALL_APPLET_PACKAGE"], [96, "BROWSER_RESIZE_WINDOW"], [97, "BROWSER_DRAG_PIXEL_TO_PIXEL"],
  [98, "CONVERSATION_HISTORY"], [99, "KNOWLEDGE_ARTIFACTS"], [100, "SEND_COMMAND_INPUT"], [101, "SYSTEM_MESSAGE"], [102, "WAIT"], [103, "AGENCY_TOOL_CALL"],
  [104, "CIDER_AGENT_DUMMY"], [105, "BUILD_CLEANER"], [106, "BLAZE_BUILD_TARGETS"], [107, "BLAZE_TEST_TARGETS"], [108, "SET_UP_FIREBASE"], [109, "MOMA"],
  [110, "RESTART_DEV_SERVER"], [111, "DEPLOY_FIREBASE"], [112, "SHELL_EXEC"], [113, "BROWSER_MOUSE_WHEEL"], [114, "LINT_APPLET"], [116, "KI_INSERTION"],
  [117, "RETRIEVE_CONTENT"], [118, "CRITIQUE"], [119, "FINDINGS"], [120, "BROWSER_MOUSE_UP"], [121, "BROWSER_MOUSE_DOWN"], [122, "WORKSPACE_API"],
  [123, "BROWSER_LIST_NETWORK_REQUESTS"], [124, "BROWSER_GET_NETWORK_REQUEST"], [125, "BROWSER_REFRESH_PAGE"], [126, "EDIT_NOTEBOOK"],
  [127, "INVOKE_SUBAGENT"], [128, "WRITE_BLOB"], [129, "READ_NOTEBOOK"], [130, "PROPOSE_AI_COMMENTS"], [131, "START_CODE_REVIEW"], [132, "GENERIC"],
  [133, "SET_UP_CLOUD_SQL"], [134, "EXECUTE_NOTEBOOK"], [135, "CLOUD_SQL_UPDATE_SCHEMA"], [136, "RPC_ACTION"], [137, "CLOUD_SQL_EXECUTE_SQL"],
  [138, "ASK_QUESTION"], [139, "DIRECTORY_RULES"], [140, "TOOL_SEARCH"],
]);
const STEP_NAMES: ReadonlySet<string> = new Set(STEP_TYPES.values());
const RUN_COMMAND = 21;

/**
 * Steps that are not tool calls: the person's input (prompts come from the transcript), the model's replies, checkpoints,
 * system, context and memory messages, choices between proposals. (Questions and notices to the person and the end of a
 * turn are calls the agent makes: `meta` tool events.)
 */
const NOT_TOOLS: ReadonlySet<string> = new Set([
  "UNSPECIFIED", "DUMMY", "PLAN_INPUT", "USER_INPUT", "PLANNER_RESPONSE", "ERROR_MESSAGE", "CHECKPOINT", "SUGGESTED_RESPONSES",
  "RETRIEVE_MEMORY", "MANAGER_FEEDBACK", "TOOL_CALL_PROPOSAL", "TOOL_CALL_CHOICE", "TRAJECTORY_CHOICE", "BRAIN_UPDATE", "PROPOSAL_FEEDBACK",
  "CODE_ACKNOWLEDGEMENT", "KNOWLEDGE_GENERATION", "EPHEMERAL_MESSAGE", "CONVERSATION_HISTORY", "KNOWLEDGE_ARTIFACTS", "SYSTEM_MESSAGE",
  "CIDER_AGENT_DUMMY", "KI_INSERTION", "DIRECTORY_RULES",
]);
const byCategory = (category: ToolCategory, names: string[]): [string, ToolCategory][] => names.map((n) => [n, category]);
/** Tool steps by category; every step type whose name holds `BROWSER` is browser work; any other tool step is `other`. */
const CATEGORIES: ReadonlyMap<string, ToolCategory> = new Map([
  ...byCategory("edit", ["CODE_ACTION", "FILE_CHANGE", "MOVE", "DELETE_DIRECTORY"]),
  ...byCategory("shell", ["RUN_COMMAND", "SHELL_EXEC", "SEND_COMMAND_INPUT", "COMMAND_STATUS", "READ_TERMINAL", "RESTART_DEV_SERVER"]),
  ...byCategory("read", ["VIEW_FILE", "LIST_DIRECTORY", "VIEW_CODE_ITEM", "VIEW_FILE_OUTLINE"]),
  ...byCategory("search", ["GREP_SEARCH", "FIND", "CODE_SEARCH", "MQUERY", "INTERNAL_SEARCH", "TRAJECTORY_SEARCH", "FIND_ALL_REFERENCES", "MOMA"]),
  ...byCategory("web", ["SEARCH_WEB", "READ_URL_CONTENT", "VIEW_CONTENT_CHUNK"]),
  ...byCategory("mcp", ["MCP_TOOL", "LIST_RESOURCES", "READ_RESOURCE"]),
  ...byCategory("notebook", ["EDIT_NOTEBOOK", "READ_NOTEBOOK", "EXECUTE_NOTEBOOK"]),
  ...byCategory("build", ["COMPILE", "COMPILE_APPLET", "BLAZE_BUILD_TARGETS"]),
  ...byCategory("package", ["INSTALL_APPLET_DEPENDENCIES", "INSTALL_APPLET_PACKAGE"]),
  ...byCategory("cloud", ["SET_UP_FIREBASE", "DEPLOY_FIREBASE", "SET_UP_CLOUD_SQL"]),
  ...byCategory("db", ["CLOUD_SQL_UPDATE_SCHEMA", "CLOUD_SQL_EXECUTE_SQL"]),
  ...byCategory("meta", ["NOTIFY_USER", "ASK_QUESTION", "FINISH"]),
  ["GIT_COMMIT", "git"], ["INVOKE_SUBAGENT", "delegate"], ["TASK_BOUNDARY", "plan"], ["WAIT", "schedule"], ["BLAZE_TEST_TARGETS", "test"],
  ["LINT_APPLET", "lint"],
]);
const categoryOf = (name: string): ToolCategory => CATEGORIES.get(name) ?? (name.includes("BROWSER") ? "browser" : "other");
/** `CortexStepStatus`: 3 done, 7 error (ran and failed); 6 canceled and 12 interrupted did not run to an end of their own. */
const STATUS_OK: ReadonlyMap<number, boolean> = new Map([[3, true], [7, false]]);
const STATUS_NOT_ENDED: ReadonlyMap<number, NonNullable<ToolEv["outcome"]>> = new Map([[6, "cancelled"], [12, "interrupted"]]);

const GENERIC = 132;
/**
 * Tools the CLI's agent calls that it records as GENERIC steps, by the name in the step metadata's tool call: the CLI
 * program's built-in tool names (its tool registry and tool safety lists). No other name is ever kept.
 */
const GENERIC_TOOLS: ReadonlyMap<string, ToolCategory> = new Map([
  ...byCategory("read", ["view_file", "read_file", "list_dir", "view_code_item", "view_file_outline"]),
  ...byCategory("search", ["grep_search", "find_by_name", "search_in_file", "codebase_search", "trajectory_search"]),
  ...byCategory("edit", ["edit_file", "replace_file_content", "multi_replace_file_content"]),
  ...byCategory("write", ["write_file", "write_to_file"]),
  ...byCategory("shell", ["run_command", "command_status", "send_command_input", "read_terminal"]),
  ...byCategory("web", ["search_web", "read_url_content", "view_content_chunk"]),
  ...byCategory("browser", ["browser_subagent", "open_browser_url", "list_browser_pages", "read_browser_page", "capture_browser_screenshot",
    "capture_browser_console_logs", "browser_get_dom", "browser_list_network_requests", "browser_get_network_request"]),
  ...byCategory("mcp", ["list_resources", "read_resource"]),
  ...byCategory("delegate", ["invoke_subagent", "define_subagent", "manage_subagents", "send_message"]),
  ...byCategory("schedule", ["schedule", "wait", "wait_5_seconds"]),
  ...byCategory("other", ["generate_image", "manage_inbox", "update_focus", "list_permissions", "list_plugin_accounts", "search_marketplace"]),
  // bookkeeping and talk with the person: questions, permission requests and notices to the person, the end of a turn
  ...byCategory("meta", ["ask_question", "ask_permission", "ask_custom_permission", "notify_user", "finish"]),
  ["manage_task", "todo"], ["task_boundary", "plan"], ["run_workflow", "workflow"],
]);
/** Tools of MCP servers: names that start with `mcp_` or `mcp-` (the server's name sits inside, so it is never parsed out). */
const MCP_PREFIX = /^mcp[_-]/i;

type Fields = ReadonlyMap<number, PbField[]>;

/** The tool call a step's metadata records (`tool_call` (4), a `ChatToolCall`: `name` (2), `arguments_json` (3)), decoded in memory. */
const toolCall = (meta: Fields): Fields | null => {
  const f = meta.get(4)?.find((x) => x.wire === 2);
  return f ? pbTryNested(f.v) : null;
};

/** The tool a generic step's call names: a built-in name with its category, an MCP tool as `mcp`, anything else (or no call) `generic`. */
function genericTool(call: Fields | null): { name: string; category: ToolCategory } {
  const raw = call ? pbStr(call.get(2)?.[0]) : undefined;
  const category = raw === undefined ? undefined : GENERIC_TOOLS.get(raw);
  if (category !== undefined) return { name: raw!, category };
  if (raw !== undefined && MCP_PREFIX.test(raw)) return { name: "mcp", category: "mcp" };
  return { name: "generic", category: "other" };
}

/** The command line of a `run_command` call: `CommandLine` of its arguments (JSON), parsed in memory; no other call's arguments are parsed. */
function callCommand(call: Fields | null): string | undefined {
  const json = call && pbStr(call.get(2)?.[0]) === "run_command" ? pbStr(call.get(3)?.[0]) : undefined;
  if (json === undefined) return undefined;
  try {
    const args: unknown = JSON.parse(json);
    const cmd = isObj(args) ? str(args.CommandLine) : undefined;
    return cmd !== undefined && cmd.trim() !== "" ? cmd : undefined;
  } catch {
    return undefined;
  }
}

// ---- stores and pages ----

class CliStoresUnreadable extends Error {}

/** `<home>/.gemini/antigravity-cli` per home (WSL homes included) when it exists. */
export function cliRoots(env: Env, homes: string[]): Candidate[] {
  const out: Candidate[] = [];
  for (const home of homes) {
    const root = joinFor(env, home, ".gemini", "antigravity-cli");
    if (isDir(root)) out.push({ root, home, wsl: home !== env.home });
  }
  return out;
}

/**
 * The columns of `table` the reader can page by rowid; each one of `wanted` missing is drift `missing-column:<name>`.
 * Undefined when the table is missing (drift `missing-table:<name>`) or declared WITHOUT ROWID (drift `table-unreadable:<name>`).
 */
function pageable(db: RoDb, tables: ReadonlySet<string>, table: string, wanted: readonly string[], tally: Tally): Set<string> | undefined {
  if (!tables.has(table)) {
    tally.unknownKey(`missing-table:${table}`);
    return undefined;
  }
  const have = new Set(db.columns(table));
  const ddl = db.get<{ sql: unknown }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", table)?.sql;
  if (typeof ddl === "string" && WITHOUT_ROWID.test(ddl)) {
    tally.unknownKey(`table-unreadable:${table}`);
    return undefined;
  }
  for (const c of wanted) if (!have.has(c)) tally.unknownKey(`missing-column:${c}`);
  return have;
}

/**
 * Maps every row of `table` in rowid order, `page` per query, on the shared pager (`Pass`): a first page that fails other
 * than busy is drift `table-unreadable:<name>`; a busy store, or a later page that fails, is an io-error; either ends the
 * table. A row the mapping fails on is a bad-record and the others go on.
 */
async function eachPagedRow(db: RoDb, table: string, select: string[], page: number, map: (r: Obj) => void, ctx: ScanCtx, tally: Tally): Promise<void> {
  const sql = `SELECT rowid AS rid, ${select.join(", ")} FROM ${q(table)} WHERE rowid > ? ORDER BY rowid LIMIT ?`;
  await new Pass(db, table, tally, ctx, "ag.db-query", { page }).byRowid(sql, (rows) => {
    for (const r of rows) eachRow(() => map(r), tally);
  });
}

// ---- conversation_summaries.db ----

/** What the summaries say about a conversation, kept for its steps and transcript: its origin, surface, and whether it is a losing battle fork. */
interface Conv { origin: Origin; surface: "cli" | "battle"; battleCopy: boolean }

/**
 * Columns selected; each one missing is drift. Never selected: `title`, `preview`, `raw_summary` (the summary message, its title
 * inside), `agent_name`, `status`, `project_id`, `app_data_dir`, `group_id`, `not_fully_idle`, `last_user_input_step_index` —
 * nor the columns used only inside SQL (TESTED_COLUMNS).
 */
const SUMMARY_COLUMNS = ["conversation_id", "step_count", "last_modified_time", "last_user_input_time", "workspace_uris", "parent_conversation_id",
  "nesting_depth", "killed"] as const;
/** Used inside SQL only: the battle id and the winning fork's id are tested for presence, the source mapped to a code (SOURCE_SQL). */
const TESTED_COLUMNS = ["battle_id", "winning_conversation_id", "source"] as const;

const ENUM_LITERAL = /^[A-Z_]*$/;
const lit = (name: string): string => {
  if (!ENUM_LITERAL.test(name)) throw new Error("source names in SQL must be enum names");
  return `'${name}'`;
};
/** The code SOURCE_SQL returns for an unset source (human), and for a value outside the program's enum (system, drift). */
type SourceCode = Origin | "none" | "other";
const SRC = "CORTEX_TRAJECTORY_SOURCE_";
/**
 * The program's `CortexTrajectorySource` names → the origin of the conversations they start: the CLI, the IDE's chat and its
 * actions, and the app are the person (`human`); the SDK, evals, the async jobs and replays are `scripted`; the Agent API (the
 * tool other agents and plugins drive Antigravity through) is `peer`; a subagent is `subagent`.
 */
const SOURCE_CODES: readonly (readonly [string, SourceCode])[] = [
  ["", "none"], [`${SRC}UNSPECIFIED`, "none"],
  ...["CLI", "CASCADE_CLIENT", "INTERACTIVE_CASCADE", "JETBOX", "EXPLAIN_PROBLEM", "REFACTOR_FUNCTION"].map((n): [string, SourceCode] => [`${SRC}${n}`, "human"]),
  ...["SDK", "EVAL", "EVAL_TASK", "ASYNC_PRR", "ASYNC_CF", "ASYNC_SL", "ASYNC_PRD", "ASYNC_CM", "REPLAY"].map((n): [string, SourceCode] => [`${SRC}${n}`, "scripted"]),
  [`${SRC}AGENT_API`, "peer"], [`${SRC}SUBAGENT`, "subagent"],
];
/** The source mapped inside SQL by a fixed `CASE`: its value never leaves SQLite, only the code does. */
const SOURCE_SQL = `CASE COALESCE(${q("source")}, '') ${SOURCE_CODES.map(([name, code]) => `WHEN ${lit(name)} THEN '${code}'`).join(" ")} ELSE 'other' END AS src`;

/** The first workspace folder of `workspace_uris` (a JSON array of URIs) as a path; `null` or `[]` is none, another shape drift. */
function firstWorkspace(v: unknown, ctx: ScanCtx, tally: Tally): string | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  let list: unknown;
  try {
    list = typeof v === "string" ? JSON.parse(v) : undefined;
  } catch {
    list = undefined;
  }
  if (list === null) return undefined;
  if (!Array.isArray(list)) {
    tally.unknownKey("conversation_summaries.workspace_uris:shape");
    return undefined;
  }
  const uri = list.find((x): x is string => typeof x === "string" && x !== "");
  return uri === undefined ? undefined : uriToPath(uri, ctx.env.platform);
}

/** The origin a summary row's source code gives (SOURCE_SQL): unset or absent is the person; a value outside the enum is `system`, and drift. */
function sourceOrigin(code: unknown, tally: Tally): Origin {
  if (code === "scripted" || code === "peer" || code === "subagent") return code;
  if (code !== "other") return "human";
  tally.unknownKey("conversation_summaries.source:(other)");
  return "system";
}

/**
 * One summary row → a lifetime SessionEv and, for a killed conversation, an interrupt. A conversation with a parent other than
 * itself, nested below the top, or started as a subagent is a subagent (depth at least 1); else its source gives its origin. A
 * losing battle fork (a winner other than itself) keeps its session but not its copied inputs. The row's times are its last
 * user input and last change: the earlier is the start (the steps and transcript, merged in by id, reach further back).
 */
function summary(r: Obj, convs: Map<string, Conv>, ctx: ScanCtx, tally: Tally): void {
  const raw = str(r.conversation_id);
  if (raw === undefined) return tally.skip("bad-row");
  const parent = str(r.parent_conversation_id);
  const named = parent !== undefined && parent !== raw;
  const depth = num(r.nesting_depth);
  const fromSource = sourceOrigin(r.src, tally);
  const subagent = named || (depth !== undefined && depth > 0) || fromSource === "subagent";
  const conv: Conv = { origin: subagent ? "subagent" : fromSource, surface: r.battle === 1 ? "battle" : "cli", battleCopy: r.battle_loser === 1 };
  convs.set(raw, conv);
  if (r.step_count === 0) return tally.skip("empty-session");
  const times = [toEpochMs(r.last_user_input_time, ctx.now), toEpochMs(r.last_modified_time, ctx.now)].filter((t): t is number => t !== undefined);
  // Go's zero time means never set: no time, not bad data
  if (times.length === 0) return tally.noTime(...[r.last_user_input_time, r.last_modified_time].filter((t) => !isGoZero(t)));
  const id = agSessionId(raw, ctx);
  const s: SessionEv = {
    k: "session", tool: TOOL, source: CLI_SOURCE, id, window: "lifetime", origin: conv.origin, start: Math.min(...times), end: Math.max(...times),
    models: [], surface: conv.surface,
  };
  if (named) s.parentId = agSessionId(parent!, ctx);
  if (subagent) s.spawnDepth = depth !== undefined && Number.isInteger(depth) && depth >= 1 ? depth : 1;
  const cwd = firstWorkspace(r.workspace_uris, ctx, tally);
  if (cwd !== undefined) s.projectKey = ctx.registerCwd(cwd);
  ctx.emit(s);
  tally.span(s.start);
  tally.span(s.end);
  if (r.killed === 1) {
    // the row has no time of the kill: its last change stands in for it, and is never activity of its own
    const m: MarkerEv = { k: "marker", tool: TOOL, source: CLI_SOURCE, ts: s.end, sessionId: id, kind: "interrupt", detail: "killed", proxyTs: true };
    ctx.emit(m);
  }
}

async function readSummaries(db: RoDb, tables: Set<string>, convs: Map<string, Conv>, ctx: ScanCtx, tally: Tally): Promise<void> {
  const have = pageable(db, tables, "conversation_summaries", [...SUMMARY_COLUMNS, ...TESTED_COLUMNS], tally);
  if (!have?.has("conversation_id")) return;
  const select = SUMMARY_COLUMNS.filter((c) => have.has(c)).map(q);
  if (have.has("battle_id")) select.push(`(COALESCE(${q("battle_id")}, '') <> '') AS battle`);
  if (have.has("winning_conversation_id")) {
    select.push(`(COALESCE(${q("winning_conversation_id")}, '') NOT IN ('', ${q("conversation_id")})) AS battle_loser`);
  }
  if (have.has("source")) select.push(SOURCE_SQL);
  await eachPagedRow(db, "conversation_summaries", select, SUMMARY_PAGE, (r) => summary(r, convs, ctx, tally), ctx, tally);
}

// ---- one conversation: conversations/<id>.db and its transcript ----

/**
 * Columns read; each one missing is drift. `error_details` is tested for presence inside SQL, and `step_payload` is selected
 * for run-command steps only; `permissions`, `task_details`, `render_info`, `has_subtrajectory` and `step_format` are never
 * selected, nor any other table of the store.
 */
const STEP_COLUMNS = ["step_type", "status", "metadata", "error_details", "step_payload"] as const;

/**
 * A run-command step's payload — `CortexStepRunCommand` (23 `command_line`, else 1 `command`; 6 `exit_code`; 14
 * `user_rejected`), or the step wrapping it as field 28 (`run_command`), whose own field 1 is the step type: only the
 * command line, the exit code and whether the person rejected it are read; the cwd and output in it are dropped.
 */
function runCommand(v: unknown): { cmd?: string; exit?: number; rejected?: true } {
  const top = v instanceof Uint8Array ? pbTryNested(v) : null;
  if (!top) return {};
  const wrapped = top.get(28)?.find((f) => f.wire === 2);
  const rc = wrapped ? pbTryNested(wrapped.v) : top.get(1)?.some((f) => f.wire === 0) ? null : top;
  if (!rc) return {};
  const exit = rc.get(6)?.find((f) => f.wire === 0);
  const out: { cmd?: string; exit?: number; rejected?: true } = {};
  const cmd = pbStr(rc.get(23)?.[0]) ?? pbStr(rc.get(1)?.[0]);
  if (cmd !== undefined && cmd.trim() !== "") out.cmd = cmd;
  if (exit?.wire === 0) out.exit = Number(BigInt.asIntN(32, exit.v));
  if (rc.get(14)?.some((f) => f.wire === 0 && f.v !== 0n)) out.rejected = true;
  return out;
}

/** Streams one conversation's steps and transcript records into its events, keeping only the conversation's span and prompt state. */
class Conversation {
  readonly id: string;
  private start?: number;
  private end?: number;
  private readonly models: string[] = [];
  private prompts = 0;
  private prevText?: string;
  private lastTs?: number;

  constructor(raw: string, private readonly conv: Conv | undefined, private readonly ctx: ScanCtx, private readonly tally: Tally) {
    this.id = agSessionId(raw, ctx);
  }

  private tick(ts: number): void {
    if (this.start === undefined || ts < this.start) this.start = ts;
    if (this.end === undefined || ts > this.end) this.end = ts;
  }

  private out(ev: Ev & { ts: number }): void {
    this.tick(ev.ts);
    this.tally.span(ev.ts);
    this.ctx.emit(ev);
  }

  private marker(ts: number, kind: MarkerKind, detail?: string): void {
    const m: MarkerEv = { k: "marker", tool: TOOL, source: CLI_SOURCE, ts, sessionId: this.id, kind };
    if (detail !== undefined) m.detail = detail;
    this.out(m);
  }

  async readSteps(db: RoDb, tables: Set<string>): Promise<void> {
    const have = pageable(db, tables, "steps", STEP_COLUMNS, this.tally);
    if (!have?.has("step_type")) return;
    const [type, meta, payload] = [q("step_type"), q("metadata"), q("step_payload")];
    const select = (["step_type", "status"] as const).filter((c) => have.has(c)).map(q);
    if (have.has("metadata")) {
      select.push(`CASE WHEN length(${meta}) <= ${BLOB_CAP} THEN ${meta} END AS metadata`,
        `CASE WHEN length(${meta}) > ${BLOB_CAP} THEN substr(${meta}, 1, ${HEAD_BYTES}) END AS mhead`);
    }
    if (have.has("error_details")) select.push(`(${q("error_details")} IS NOT NULL AND length(${q("error_details")}) > 0) AS err`);
    if (have.has("step_payload")) {
      select.push(`CASE WHEN ${type} = ${RUN_COMMAND} AND length(${payload}) <= ${BLOB_CAP} THEN ${payload} END AS payload`,
        `(${type} = ${RUN_COMMAND} AND length(${payload}) > ${BLOB_CAP}) AS pbig`);
    }
    await eachPagedRow(db, "steps", select, STEP_PAGE, (r) => this.step(r), this.ctx, this.tally);
  }

  /**
   * A step's metadata (`CortexStepMetadata`, decoded in memory) and its time, `created_at` (1). Metadata above BLOB_CAP never
   * left SQLite: it is skipped `oversize`, and only the complete fields among its first bytes are used (the program writes
   * fields in number order, so `created_at` comes first). Without a time the step is skipped `no-ts`; metadata that is not
   * protobuf is drift `steps.metadata:shape`. An empty blob is an empty message.
   */
  private stepMeta(r: Obj): { ts: number; fields: Fields } | undefined {
    let fields: Fields | null;
    if (r.mhead instanceof Uint8Array) {
      this.tally.skip("oversize");
      fields = leadingFields(r.mhead);
    } else {
      const meta = r.metadata;
      const empty = meta === null || meta === undefined || (meta instanceof Uint8Array && meta.length === 0);
      fields = !empty && meta instanceof Uint8Array ? pbTryNested(meta) : null;
      if (!empty && !fields) {
        this.tally.unknownKey("steps.metadata:shape");
        return undefined;
      }
    }
    const ts = fields ? pbTime(fields.get(1)?.[0], this.ctx.now) : undefined;
    if (ts === undefined || !fields) {
      this.tally.noTime(fields ? pbTimeRaw(fields.get(1)?.[0]) : undefined);
      return undefined;
    }
    return { ts, fields };
  }

  /**
   * One step: an error marker when it records error details, and a ToolEv when it is a tool step — named by its type, in its
   * type's category, a generic step by the tool its metadata names; a run command takes the category, checks and exit code
   * of its command line. A step canceled or interrupted, or a run command the person rejected (a denial), did not run to an
   * end of its own: an outcome and no ok or exit. An unknown type is drift. Every timed step widens the conversation's span.
   */
  private step(r: Obj): void {
    if (r.pbig === 1) this.tally.skip("oversize"); // a run command's payload above BLOB_CAP never left SQLite
    const meta = this.stepMeta(r);
    if (meta === undefined) return;
    const { ts } = meta;
    this.tick(ts);
    if (r.err === 1) this.marker(ts, "error");
    const type = num(r.step_type);
    const name = type === undefined ? undefined : STEP_TYPES.get(type);
    if (name === undefined) {
      const key = type !== undefined && Number.isInteger(type) && type >= 0 && type < 10_000 ? String(type) : "(other)";
      return this.tally.unknownKey(`step-type:${key}`);
    }
    if (NOT_TOOLS.has(name)) return;
    const call = toolCall(meta.fields);
    const kind = type === GENERIC ? genericTool(call) : { name: name.toLowerCase(), category: categoryOf(name) };
    const ev: ToolEv = { k: "tool", tool: TOOL, source: CLI_SOURCE, ts, sessionId: this.id, ...kind };
    const status = num(r.status);
    let outcome = status === undefined ? undefined : STATUS_NOT_ENDED.get(status);
    let exit: number | undefined;
    if (kind.name === "run_command") {
      // a typed run command's payload, else the call's arguments (generic steps, and steps kept without their payload)
      const run: ReturnType<typeof runCommand> = type === RUN_COMMAND ? runCommand(r.payload) : {};
      const cmd = run.cmd ?? callCommand(call);
      if (cmd !== undefined) {
        const { category, checks, toolchain } = classifyCommand(cmd);
        ev.category = category;
        if (checks.length > 0) ev.checks = checks;
        if (toolchain !== undefined) ev.toolchain = toolchain;
      }
      if (run.rejected) outcome = "denied";
      exit = run.exit;
    }
    if (outcome !== undefined) ev.outcome = outcome;
    else if (exit !== undefined) {
      ev.exit = exit;
      ev.ok = exit === 0;
    } else {
      const ok = status === undefined ? undefined : STATUS_OK.get(status);
      if (ok !== undefined) ev.ok = ok;
    }
    this.out(ev);
    if (outcome === "denied") this.marker(ts, "denial", "user");
  }

  /**
   * One transcript record (`type` = a step type's name): an explicit input (`USER_INPUT` from `USER_EXPLICIT`) of a
   * conversation that is not a subagent's is a prompt (a subagent's inputs are its parent's briefs); a record with token
   * counts is usage. Unknown types and sources are drift; every record's time widens the conversation's span.
   */
  record(v: unknown): void {
    if (!isObj(v)) return this.tally.unknownKey("transcript:not-object");
    if (typeof v.type !== "string" || !STEP_NAMES.has(v.type)) return this.tally.unknownKey(`transcript.type:${enumKey(v.type)}`);
    if (v.source !== undefined && (typeof v.source !== "string" || !SOURCES.has(v.source))) this.tally.unknownKey(`transcript.source:${enumKey(v.source)}`);
    const ts = toEpochMs(v.created_at, this.ctx.now);
    if (ts !== undefined) this.tick(ts);
    const model = typeof v.model === "string" && v.model !== "" ? safeModel(v.model) : undefined;
    if (model !== undefined && !this.models.includes(model)) this.models.push(model);
    if (v.type === "USER_INPUT" && v.source === "USER_EXPLICIT") this.prompt(v, ts);
    if (TOKEN_FIELDS.some((f) => tokens(v[f]) !== undefined)) this.usage(v, ts, model);
    if (ts !== undefined) this.lastTs = ts;
  }

  /**
   * An explicit input, in memory only: intent, features, a keyed hash; its origin is its conversation's (the person, a script,
   * a peer). A subagent's inputs are its parent's briefs, and a losing battle fork's are copies of the winner's (skipped
   * `battle-copy`): neither is a prompt. An attached image is a paste.
   */
  private prompt(v: Obj, ts: number | undefined): void {
    const origin = this.conv?.origin ?? "human";
    if (origin === "subagent") return;
    if (this.conv?.battleCopy) return this.tally.skip("battle-copy");
    if (ts === undefined) return this.tally.noTime(v.created_at);
    const text = v.content;
    if (typeof text !== "string") return this.tally.unknownKey("transcript.content:missing");
    if (text.trim() === "") return this.tally.skip("empty");
    const hasPaste = Array.isArray(v.media) && v.media.some((m) => isObj(m) && typeof m.mime_type === "string" && m.mime_type.startsWith("image/"));
    const isTaskStart = this.prompts === 0 || (this.lastTs !== undefined && ts - this.lastTs >= TASK_GAP_MS);
    const ev: PromptEv = {
      k: "prompt", tool: TOOL, source: CLI_SOURCE, ts, sessionId: this.id, window: "detail", origin, intent: classifyIntent(text),
      features: promptFeatures(text, { hasPaste, isTaskStart, prevText: this.prevText }), textHash: this.ctx.hash(text.trim()),
    };
    if (hasPaste) ev.hasPaste = true;
    this.out(ev);
    this.prompts++;
    this.prevText = text;
  }

  private usage(v: Obj, ts: number | undefined, model: string | undefined): void {
    if (ts === undefined) return this.tally.noTime(v.created_at);
    const ev: UsageEv = {
      k: "usage", tool: TOOL, source: CLI_SOURCE, ts, sessionId: this.id, model: model ?? "other", inTok: tokens(v.input_tokens) ?? 0,
      outTok: tokens(v.output_tokens) ?? 0, cacheR: tokens(v.cache_read_tokens) ?? 0, cacheW: tokens(v.cache_write_tokens) ?? 0,
    };
    this.out(ev);
  }

  /** The conversation's detail session, when its steps or transcript gave it a time: origin and surface as its summary says. */
  finish(): void {
    if (this.start === undefined || this.end === undefined) return;
    const s: SessionEv = {
      k: "session", tool: TOOL, source: CLI_SOURCE, id: this.id, window: "detail", origin: this.conv?.origin ?? "human",
      start: this.start, end: this.end, models: [...this.models], surface: this.conv?.surface ?? "cli",
    };
    this.ctx.emit(s);
    this.tally.span(s.start);
    this.tally.span(s.end);
  }
}

/** `CortexStepSource` names (`source` of a transcript record). */
const SOURCES: ReadonlySet<string> = new Set(["UNSPECIFIED", "MODEL", "USER_IMPLICIT", "USER_EXPLICIT", "SYSTEM", "SYSTEM_SDK"]);
const TOKEN_FIELDS = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"] as const;
const tokens = (v: unknown): number | undefined => {
  const n = num(v);
  return n !== undefined && n >= 0 ? n : undefined;
};

// ---- the CLI store ----

/**
 * Scan one `antigravity-cli` folder: the conversation summaries (the lifetime window: every conversation's session, kills),
 * then per conversation its step store and transcript (the detail window: tools, errors, prompts, usage, its detail
 * session). One CoverageEv per window, last — `absent` for a window with no store, `error` (note `unreadable`) for one
 * whose stores are all unreadable. Each store is read on its own; only when every store present fails is the source an
 * error. A locked store above MAX_COPY_BYTES keeps its reason instead: its window notes `too-large`, and it is no error
 * of the source. (The CLI's prompt log is `antigravity.history`.)
 */
export async function scanCli(c: Candidate, ctx: ScanCtx): Promise<void> {
  const tally = new Tally(TOOL, CLI_SOURCE);
  const life = new Tally(TOOL, CLI_SOURCE, "lifetime");
  const convs = new Map<string, Conv>();
  let present = 0;
  let read = 0;
  const summaries = path.join(c.root, "conversation_summaries.db");
  const hasSummaries = isFile(summaries);
  let summariesRead = false;
  if (hasSummaries) {
    present++;
    summariesRead = await readStore(summaries, ctx, life, "ag", (db, tables) => readSummaries(db, tables, convs, ctx, life));
    if (summariesRead) read++;
  }
  let conversations = 0;
  let conversationsRead = 0;
  const dbDir = path.join(c.root, "conversations");
  const brainDir = path.join(c.root, "brain");
  const ids = new Set(listDir(dbDir, tally).filter((n) => n.endsWith(".db") && n.length > 3).map((n) => n.slice(0, -3)));
  for (const name of listDir(brainDir, tally)) if (!name.startsWith(".")) ids.add(name);
  for (const raw of [...ids].sort()) {
    if (ctx.signal.aborted) break;
    const conv = new Conversation(raw, convs.get(raw), ctx, tally);
    const db = path.join(dbDir, `${raw}.db`);
    if (isFile(db)) {
      present++;
      conversations++;
      if (await readStore(db, ctx, tally, "ag", (d, tables) => conv.readSteps(d, tables))) conversationsRead++;
    }
    const transcript = path.join(brainDir, raw, ".system_generated", "logs", "transcript.jsonl");
    if (isFile(transcript)) {
      present++;
      conversations++;
      if ((await streamJsonlFile(transcript, ctx, tally, (v) => conv.record(v), { ioLog: "ag.io-error" })).read) conversationsRead++;
    }
    eachRow(() => conv.finish(), tally);
  }
  read += conversationsRead;
  const tooLarge = tally.note === "too-large" || life.note === "too-large";
  if (present > 0 && read === 0 && !tooLarge) throw new CliStoresUnreadable("no Antigravity CLI store could be read");
  const bad = (tally.skipped["bad-record"] ?? 0) + (life.skipped["bad-record"] ?? 0);
  if (bad > 0) ctx.log("warn", "ag.bad-record", bad); // a mapping bug must not look like a healthy source
  for (const [t, has, readable] of [[tally, conversations > 0, conversationsRead > 0], [life, hasSummaries, summariesRead]] as const) {
    const cov = t.coverage();
    if (!has) cov.status = "absent";
    else if (!readable && t.note !== "too-large") {
      cov.status = "error";
      cov.note = "unreadable";
    }
    ctx.emit(cov);
  }
}
