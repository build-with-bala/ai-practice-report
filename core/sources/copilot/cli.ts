import { statSync } from "node:fs";
import path from "node:path";
import type { Env } from "../../env/env";
import { joinFor } from "../../env/paths";
import { safeStat } from "../../io/fs";
import { readJsonl } from "../../io/jsonl";
import { isBusyError, openRo, type RoDb } from "../../io/sqlite";
import { toEpochMs } from "../../io/time";
import type { Ev, MarkerEv, PromptEv, SessionEv, ToolEv, TurnEv } from "../../model/events";
import type { Origin, ToolCategory } from "../../model/ids";
import { classifyCommand } from "../../text/commands";
import { classifyIntent } from "../../text/intent";
import { promptFeatures } from "../../text/structure";
import { listDir, Tally } from "../common/coverage";
import { extOfPath, isObj, str, TOKEN, VERSION, type Obj } from "../common/guards";
import type { Candidate, ScanCtx } from "../types";
import { cpModel, cpSessionId, TASK_GAP_MS, TOOL } from "./map";

export const CLI_SOURCE = "copilot.cli";

/**
 * Session event types of the Copilot CLI (`session-state/<id>/events.jsonl`), from the event names the VS Code Copilot
 * extension handles (0.66) and the CLI SDK's session event list; not seen on this machine. Any other type is drift.
 */
const KNOWN_EVENTS: ReadonlySet<string> = new Set([
  "session.start", "session.resume", "session.error", "session.idle", "session.info", "session.model_change", "session.title_changed",
  "session.shutdown", "session.usage_info", "session.tools_updated", "session.skills_loaded", "session.mcp_servers_loaded",
  "session.mcp_server_status_changed", "session.remote_steerable_changed", "session.compaction_start", "session.compaction_complete",
  "session.truncation", "session.handoff", "session.snapshot_rewind",
  "user.message", "pending_messages.modified", "system.message",
  "assistant.turn_start", "assistant.intent", "assistant.reasoning", "assistant.reasoning_delta", "assistant.streaming_delta",
  "assistant.message", "assistant.message_delta", "assistant.turn_end", "assistant.turn_complete", "assistant.usage",
  "abort", "tool.user_requested", "tool.execution_start", "tool.execution_started", "tool.execution_partial_result", "tool.execution_progress",
  "tool.execution_complete", "subagent.started", "subagent.completed", "subagent.failed", "subagent.selected", "hook.start", "hook.end",
  "skill.invoked", "permission.requested", "exit_plan_mode.requested",
]);
/** An event type as a drift key: dotted lower-case schema tokens are kept, anything else is `(other)` / `(none)`. */
const EVENT_TYPE = /^[a-z][a-z0-9_]{0,31}(?:\.[a-z][a-z0-9_]{0,31}){0,3}$/;
const eventKey = (t: unknown): string => `event:${typeof t !== "string" ? "(none)" : EVENT_TYPE.test(t) ? t : "(other)"}`;

/** The CLI's built-in tools (the tool table the VS Code extension renders CLI sessions with, 0.66). */
const CLI_TOOLS: ReadonlyMap<string, ToolCategory> = new Map<string, ToolCategory>([
  ...(["bash", "powershell", "write_bash", "read_bash", "stop_bash", "list_bash", "write_powershell", "read_powershell", "stop_powershell",
    "list_powershell"] as const).map((n) => [n, "shell"] as const),
  ...(["view", "show_file"] as const).map((n) => [n, "read"] as const),
  ...(["grep", "rg", "glob", "search_code_subagent"] as const).map((n) => [n, "search"] as const),
  ...(["edit", "str_replace", "insert", "apply_patch", "str_replace_editor"] as const).map((n) => [n, "edit"] as const),
  ["create", "write"],
  ...(["web_fetch", "web_search", "fetch_copilot_cli_documentation"] as const).map((n) => [n, "web"] as const),
  ...(["task", "list_agents", "read_agent", "write_agent"] as const).map((n) => [n, "delegate"] as const),
  ["update_todo", "todo"], ["exit_plan_mode", "plan"], ["skill", "skill"], ["create_pull_request", "git"],
  ...(["think", "report_progress", "reply_to_comment", "code_review", "task_complete", "ask_user", "sql", "lsp", "gh-advisory-database",
    "store_memory", "parallel_validation", "propose_work", "mcp_reload", "mcp_validate", "tool_search_tool_regex", "codeql_checker"] as const)
    .map((n) => [n, "other"] as const),
]);
/** Tools whose `arguments.command` is a command line. */
const SHELL_TOOLS = new Set(["bash", "powershell"]);
/** Tools whose `arguments.path` is the file they edit or create. */
const PATH_TOOLS = new Set(["edit", "str_replace", "insert", "create", "str_replace_editor"]);
/** The CLI reports its intent through a tool call on every turn: bookkeeping, not a tool use. */
const META_TOOLS = new Set(["report_intent"]);
/** A shell tool's result ends with the command's exit code. */
const EXIT_TAIL = /<exited with exit code (\d{1,3})>\s*$/;
const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/m;
/** Context blocks the CLI wraps into a user message's content (what the VS Code extension strips before showing it). */
const INJECTED = [/<reminder>[\s\S]*?<\/reminder>\s*/g, /<attachments>[\s\S]*?<\/attachments>\s*/g, /<userRequest>[\s\S]*?<\/userRequest>\s*/g,
  /<user_query>[\s\S]*?<\/user_query>\s*/g, /<context>[\s\S]*?<\/context>\s*/g, /<current_datetime>[\s\S]*?<\/current_datetime>\s*/g,
  /<pr_metadata[^>]*\/?>\s*/g];
const userText = (content: string): string => INJECTED.reduce((t, re) => t.replace(re, ""), content).trim();
/** Bounded per-file state: tool calls awaiting their completion, turns awaiting their end. */
const PENDING_TOOLS = 4096;
const OPEN_TURNS = 256;

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** `<home>/.copilot` per home, when it holds CLI sessions (`session-state/`) or the session store; else the CLI is absent. */
export function cliRoots(env: Env, homes: string[]): Candidate[] {
  const out: Candidate[] = [];
  for (const home of homes) {
    const root = joinFor(env, home, ".copilot");
    if (isDir(joinFor(env, root, "session-state")) || safeStat(joinFor(env, root, "session-store.db"))?.isFile()) out.push({ root, home, wsl: home !== env.home });
  }
  return out;
}

interface Pending { ev: ToolEv; shell: boolean }

/** Streams one CLI session's events into events of the session, keeping small per-file state. */
class CliReader {
  private start?: number;
  private end?: number;
  private readonly models: string[] = [];
  private model?: string;
  private version?: string;
  private cwd?: string;
  private humanPrompts = 0;
  private prevHuman?: string;
  private lastActivity?: number;
  private readonly turns = new Map<string, number>();
  private openTurn?: string;
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly sessionId: string, private readonly ctx: ScanCtx, private readonly tally: Tally) {}

  private tick(ts: number): void {
    if (this.start === undefined || ts < this.start) this.start = ts;
    if (this.end === undefined || ts > this.end) this.end = ts;
  }

  private out(ev: Ev & { ts: number }): void {
    this.tick(ev.ts);
    this.tally.span(ev.ts);
    this.ctx.emit(ev);
  }

  private addModel(raw: string | undefined): void {
    const m = cpModel(raw);
    if (m === undefined) return;
    this.model = m;
    if (!this.models.includes(m)) this.models.push(m);
  }

  record(v: unknown): void {
    const type = isObj(v) ? v.type : undefined;
    if (!isObj(v) || typeof type !== "string" || !KNOWN_EVENTS.has(type)) return this.tally.unknownKey(eventKey(type));
    const ts = toEpochMs(v.timestamp, this.ctx.now);
    if (ts !== undefined) this.tick(ts);
    const d = isObj(v.data) ? v.data : {};
    switch (type) {
      case "session.start": this.sessionStart(d); break;
      case "session.model_change": this.addModel(str(d.newModel)); break;
      case "assistant.usage": this.addModel(str(d.model)); break;
      case "user.message": if (ts !== undefined) this.userMessage(d, ts); break;
      case "assistant.turn_start": this.turnStart(d, ts); break;
      case "assistant.turn_end": if (ts !== undefined) this.turnEnd(str(d.turnId) ?? this.openTurn, ts, "completed"); break;
      case "abort": if (ts !== undefined) this.abort(ts); break;
      case "tool.execution_start": if (ts !== undefined) this.toolStart(d, ts); break;
      case "tool.execution_complete": this.toolComplete(d, ts); break;
      default: break;
    }
    if (ts !== undefined) this.lastActivity = ts;
  }

  private sessionStart(d: Obj): void {
    const version = str(d.copilotVersion);
    if (version !== undefined && VERSION.test(version)) {
      this.version = version;
      this.tally.versions.add(version);
    }
    this.cwd ??= isObj(d.context) ? str(d.context.cwd) : undefined;
    this.addModel(str(d.selectedModel));
    const started = toEpochMs(d.startTime, this.ctx.now);
    if (started !== undefined) this.tick(started);
  }

  /** The person's message (`source` absent or `user`; any other source is system input), in memory only. */
  private userMessage(d: Obj, ts: number): void {
    const raw = str(d.content);
    const text = raw === undefined ? "" : userText(raw);
    if (text === "") return;
    const source = d.source;
    const origin: Origin = source === undefined || (typeof source === "string" && source.toLowerCase() === "user") ? "human" : "system";
    const human = origin === "human";
    const isTaskStart = human && (this.humanPrompts === 0 || (this.lastActivity !== undefined && ts - this.lastActivity >= TASK_GAP_MS));
    const ev: PromptEv = {
      k: "prompt", tool: TOOL, source: CLI_SOURCE, ts, sessionId: this.sessionId, window: "detail", origin,
      intent: classifyIntent(text), features: promptFeatures(text, { isTaskStart, prevText: human ? this.prevHuman : undefined }),
      textHash: this.ctx.hash(text.trim()),
    };
    this.out(ev);
    if (human) {
      this.humanPrompts++;
      this.prevHuman = text;
    }
  }

  private turnStart(d: Obj, ts: number | undefined): void {
    const id = str(d.turnId) ?? "";
    this.openTurn = id;
    if (ts === undefined) return;
    this.turns.set(id, ts);
    if (this.turns.size > OPEN_TURNS) this.turns.delete(this.turns.keys().next().value!);
  }

  /** Ends a turn that is still open; a turn already ended (e.g. by an abort) or never started ends nothing. */
  private turnEnd(id: string | undefined, ts: number, status: "completed" | "interrupted"): void {
    if (id === undefined || !(this.turns.has(id) || this.openTurn === id)) return;
    const started = this.turns.get(id);
    this.turns.delete(id);
    if (this.openTurn === id) this.openTurn = undefined;
    const ev: TurnEv = { k: "turn", tool: TOOL, source: CLI_SOURCE, ts, sessionId: this.sessionId, window: "detail", status };
    if (this.model !== undefined) ev.model = this.model;
    if (started !== undefined && ts >= started) ev.ms = ts - started;
    this.out(ev);
  }

  /** An abort is an interrupt; it ends the open turn as interrupted. */
  private abort(ts: number): void {
    const m: MarkerEv = { k: "marker", tool: TOOL, source: CLI_SOURCE, ts, sessionId: this.sessionId, kind: "interrupt" };
    this.out(m);
    if (this.openTurn !== undefined) this.turnEnd(this.openTurn, ts, "interrupted");
  }

  private toolStart(d: Obj, ts: number): void {
    const callId = str(d.toolCallId);
    const name = str(d.toolName);
    if (callId === undefined || name === undefined || META_TOOLS.has(name) || this.pending.has(callId)) return;
    const args = isObj(d.arguments) ? d.arguments : {};
    const ev: ToolEv = { k: "tool", tool: TOOL, source: CLI_SOURCE, ts, sessionId: this.sessionId, callId: this.ctx.hash(callId), name: "other", category: "other" };
    const server = str(d.mcpServerName);
    if (server !== undefined) {
      ev.name = "mcp";
      ev.category = "mcp";
      ev.mcpServer = server;
    } else if (CLI_TOOLS.has(name)) {
      ev.name = name;
      ev.category = CLI_TOOLS.get(name)!;
      if (SHELL_TOOLS.has(name)) {
        const cmd = str(args.command);
        if (cmd !== undefined) {
          const { category, checks } = classifyCommand(cmd);
          ev.category = category;
          if (checks.length > 0) ev.checks = checks;
        }
      }
      if (name === "str_replace_editor") ev.category = args.command === "view" ? "read" : args.command === "create" ? "write" : "edit";
      const file = PATH_TOOLS.has(name) ? str(args.path) : name === "apply_patch" ? PATCH_FILE.exec(str(args.input) ?? str(args.patch) ?? "")?.[1]?.trim() : undefined;
      const ext = file !== undefined && (ev.category === "edit" || ev.category === "write") ? extOfPath(file) : undefined;
      if (ext !== undefined) ev.editExt = ext;
    }
    this.pending.set(callId, { ev, shell: server === undefined && SHELL_TOOLS.has(name) });
    if (this.pending.size > PENDING_TOOLS) {
      const [oldest, old] = this.pending.entries().next().value!;
      this.pending.delete(oldest);
      this.out(old.ev);
    }
  }

  /** Completion: `ok` from the exit code a shell result ends with, else `success`; `ms` since the start. */
  private toolComplete(d: Obj, ts: number | undefined): void {
    const callId = str(d.toolCallId);
    const p = callId === undefined ? undefined : this.pending.get(callId);
    if (callId === undefined || !p) return;
    this.pending.delete(callId);
    const { ev } = p;
    if (ts !== undefined && ts >= ev.ts) ev.ms = ts - ev.ts;
    const content = p.shell && isObj(d.result) && typeof d.result.content === "string" ? d.result.content.slice(-64) : undefined;
    const exit = content === undefined ? undefined : EXIT_TAIL.exec(content)?.[1];
    if (exit !== undefined) {
      ev.exit = Number(exit);
      ev.ok = ev.exit === 0;
    } else if (typeof d.success === "boolean") ev.ok = d.success;
    this.out(ev);
  }

  finish(): void {
    for (const p of this.pending.values()) this.out(p.ev);
    this.pending.clear();
    if (this.start === undefined || this.end === undefined) return;
    const s: SessionEv = {
      k: "session", tool: TOOL, source: CLI_SOURCE, id: this.sessionId, window: "detail", origin: "human", start: this.start, end: this.end,
      models: [...this.models], surface: "cli",
    };
    if (this.version !== undefined) s.version = this.version;
    if (this.cwd !== undefined) s.projectKey = this.ctx.registerCwd(this.cwd);
    this.ctx.emit(s);
    this.tally.span(this.start);
    this.tally.span(this.end);
  }
}

async function scanEvents(file: string, sessionId: string, ctx: ScanCtx, tally: Tally): Promise<void> {
  const st = safeStat(file);
  if (!st?.isFile()) return;
  const reader = new CliReader(sessionId, ctx, tally);
  let complete = true;
  try {
    for await (const item of readJsonl(file, { signal: ctx.signal })) {
      if ("skip" in item) {
        tally.skip(item.skip);
        continue;
      }
      tally.records++;
      try {
        reader.record(item.value);
      } catch {
        tally.skip("bad-record");
      }
    }
  } catch {
    complete = false;
    tally.skip("io-error");
    ctx.log("warn", "cp.io-error");
  }
  if (ctx.signal.aborted) complete = false;
  if (complete) {
    tally.files++;
    tally.bytes += st.size;
  }
  reader.finish();
}

// ---- the session store (schema verified locally on the VS Code extension's copy; the CLI keeps one of the same name) ----

/** Columns read; every other column is never selected (turn texts, summaries, repository, branch, agent names). */
const STORE_SESSION_COLUMNS = ["id", "cwd", "host_type", "created_at", "updated_at"] as const;
const STORE_TURN_COLUMNS = ["session_id", "timestamp"] as const;
const PAGE = 5_000;
const q = (name: string): string => `"${name}"`;

/** The allowlisted columns of `table` present in the store; a missing table or column is drift. */
function storeColumns(db: RoDb, tables: Set<string>, table: string, wanted: readonly string[], tally: Tally): string[] | undefined {
  if (!tables.has(table)) {
    tally.unknownKey(`store.missing-table:${table}`);
    return undefined;
  }
  const have = new Set(db.columns(table));
  for (const c of wanted) if (!have.has(c)) tally.unknownKey(`store.missing-column:${c}`);
  return wanted.filter((c) => have.has(c));
}

/** Rows of `table` in rowid pages; a page that fails ends the table as an io-error (busy stores included). */
// TODO(Plan 2 Task 0): this pager is synchronous and never yields to the event loop, so a signal or an abort waits
// for the whole table. Move it onto the shared async pager (common/sqlite.ts) that awaits maybeYield() between pages.
function* storePages(db: RoDb, table: string, cols: string[], tally: Tally, ctx: ScanCtx): Generator<Obj[]> {
  const sql = `SELECT rowid AS rid, ${cols.map(q).join(", ")} FROM ${q(table)} WHERE rowid > ? ORDER BY rowid LIMIT ?`;
  let after = Number.MIN_SAFE_INTEGER;
  for (;;) {
    if (ctx.signal.aborted) return;
    let rows: Obj[];
    try {
      rows = db.all<Obj>(sql, after, PAGE);
    } catch (e) {
      tally.skip("io-error");
      ctx.log("warn", isBusyError(e) ? "cp.db-busy" : "cp.db-query");
      return;
    }
    tally.records += rows.length;
    if (rows.length > 0) yield rows;
    if (rows.length < PAGE) return;
    after = rows[rows.length - 1]!.rid as number;
  }
}

function storeSession(r: Obj, source: string, ctx: ScanCtx, tally: Tally): void {
  const raw = str(r.id);
  if (raw === undefined) return tally.skip("bad-row");
  const start = toEpochMs(r.created_at, ctx.now);
  if (start === undefined) return tally.skip("no-ts");
  const end = Math.max(start, toEpochMs(r.updated_at, ctx.now) ?? start);
  const s: SessionEv = { k: "session", tool: TOOL, source, id: cpSessionId(raw, ctx), window: "lifetime", origin: "human", start, end, models: [] };
  const host = str(r.host_type);
  if (host !== undefined) s.surface = TOKEN.test(host) ? host : "other";
  const cwd = str(r.cwd);
  if (cwd !== undefined) s.projectKey = ctx.registerCwd(cwd);
  ctx.emit(s);
  tally.span(start);
  tally.span(end);
}

function storeTurn(r: Obj, source: string, ctx: ScanCtx, tally: Tally): void {
  const raw = str(r.session_id);
  if (raw === undefined) return tally.skip("bad-row");
  const ts = toEpochMs(r.timestamp, ctx.now);
  if (ts === undefined) return tally.skip("no-ts");
  ctx.emit({ k: "turn", tool: TOOL, source, ts, sessionId: cpSessionId(raw, ctx), window: "lifetime" });
  tally.span(ts);
}

/**
 * The session store (`session-store.db`): a lifetime SessionEv per `sessions` row and a lifetime TurnEv per `turns` row,
 * from the allowlisted columns only. A store that cannot be opened or read is an io-error; it is always closed.
 */
export function readSessionStore(file: string, source: string, ctx: ScanCtx, tally: Tally): void {
  const db = openRo(file, ctx.temp);
  if (!db) {
    tally.skip("io-error");
    ctx.log("warn", "cp.db-unopenable");
    return;
  }
  try {
    const tables = new Set(db.tables());
    tally.files++;
    tally.bytes += safeStat(file)?.size ?? 0;
    const sCols = storeColumns(db, tables, "sessions", STORE_SESSION_COLUMNS, tally);
    if (sCols?.includes("id")) {
      for (const rows of storePages(db, "sessions", sCols, tally, ctx)) for (const r of rows) eachRow(() => storeSession(r, source, ctx, tally), tally);
    }
    const tCols = storeColumns(db, tables, "turns", STORE_TURN_COLUMNS, tally);
    if (tCols?.includes("session_id")) {
      for (const rows of storePages(db, "turns", tCols, tally, ctx)) for (const r of rows) eachRow(() => storeTurn(r, source, ctx, tally), tally);
    }
  } catch {
    tally.skip("io-error");
    ctx.log("warn", "cp.db-unreadable");
  } finally {
    db.close();
  }
}

function eachRow(map: () => void, tally: Tally): void {
  try {
    map();
  } catch {
    tally.skip("bad-record");
  }
}

/** Scan one `.copilot` root: every `session-state/<id>/events.jsonl`, then `session-store.db`; one CoverageEv, last. */
export async function scanCli(c: Candidate, ctx: ScanCtx): Promise<void> {
  const tally = new Tally(TOOL, CLI_SOURCE);
  const stateDir = path.join(c.root, "session-state");
  for (const name of listDir(stateDir, tally)) {
    if (ctx.signal.aborted) break;
    await scanEvents(path.join(stateDir, name, "events.jsonl"), cpSessionId(name, ctx), ctx, tally);
  }
  const store = path.join(c.root, "session-store.db");
  if (!ctx.signal.aborted && safeStat(store)?.isFile()) readSessionStore(store, CLI_SOURCE, ctx, tally);
  const bad = tally.skipped["bad-record"] ?? 0;
  if (bad > 0) ctx.log("warn", "cp.bad-record", bad);
  ctx.emit(tally.coverage());
}
