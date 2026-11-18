import path from "node:path";
import type { Env } from "../../env/env";
import { joinFor } from "../../env/paths";
import { isDir, safeStat } from "../../io/fs";
import type { RoDb } from "../../io/sqlite";
import { toEpochMs } from "../../io/time";
import { TASK_GAP_MS } from "../../model/constants";
import type { Ev, MarkerEv, PromptEv, SessionEv, ToolEv, TurnEv } from "../../model/events";
import type { Origin, ToolCategory } from "../../model/ids";
import { classifyCommand } from "../../text/commands";
import { classifyIntent } from "../../text/intent";
import { promptFeatures } from "../../text/structure";
import { listDir, Tally } from "../common/coverage";
import { extOfPath, isObj, str, VERSION, type Obj } from "../common/guards";
import { eachRow, Pass, q, readStore } from "../common/sqlite";
import { streamJsonlFile } from "../common/stream";
import type { Candidate, PluginCoverage, ScanCtx } from "../types";
import { cpModel, cpSessionId, TOOL } from "./ids";

export const CLI_SOURCE = "copilot.cli";

/**
 * Session event types of the Copilot CLI (`session-state/<id>/events.jsonl`), from the event names the VS Code Copilot
 * extension handles (0.66) and the CLI SDK's session event list; not verified against a real CLI store. Any other type
 * is drift.
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
/** An event type the reader does not know, as a drift key: never echoed. */
const eventKey = (t: unknown): string => `event:${typeof t !== "string" ? "(none)" : "(other)"}`;

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
  // bookkeeping and talk with the person: thinking aloud, its intent (reported on every turn), progress, the end, questions
  ...(["think", "report_intent", "report_progress", "task_complete", "ask_user", "tool_search_tool_regex"] as const).map((n) => [n, "meta"] as const),
  ...(["reply_to_comment", "code_review", "sql", "lsp", "gh-advisory-database", "store_memory", "parallel_validation", "propose_work",
    "mcp_reload", "mcp_validate", "codeql_checker"] as const).map((n) => [n, "other"] as const),
]);
/** Tools whose `arguments.command` is a command line. */
const SHELL_TOOLS = new Set(["bash", "powershell"]);
/** Tools whose `arguments.path` is the file they edit or create. */
const PATH_TOOLS = new Set(["edit", "str_replace", "insert", "create", "str_replace_editor"]);
/** A shell tool's result ends with the command's exit code. */
const EXIT_TAIL = /<exited with exit code (\d{1,3})>\s*$/;
const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/m;
/** Context blocks the CLI wraps into a user message's content (what the VS Code extension strips before showing it). */
const INJECTED = [/<reminder>[\s\S]*?<\/reminder>\s*/g, /<attachments>[\s\S]*?<\/attachments>\s*/g, /<userRequest>[\s\S]*?<\/userRequest>\s*/g,
  /<user_query>[\s\S]*?<\/user_query>\s*/g, /<context>[\s\S]*?<\/context>\s*/g, /<current_datetime>[\s\S]*?<\/current_datetime>\s*/g,
  /<pr_metadata[^>]*\/?>\s*/g];
const userText = (content: string): string => INJECTED.reduce((t, re) => t.replace(re, ""), content).trim();
/** Bounded per-file state: tool calls awaiting their completion. */
const PENDING_TOOLS = 4096;

/** The older CLIs' session folder (one JSON file per session): not read, but never a silent absence. */
const OLD_STATE_DIR = "history-session-state";

/**
 * `<home>/.copilot` per home, when it holds CLI sessions (`session-state/`, or the older `history-session-state/`) or the
 * session store; else the CLI is absent.
 */
export function cliRoots(env: Env, homes: string[]): Candidate[] {
  const out: Candidate[] = [];
  for (const home of homes) {
    const root = joinFor(env, home, ".copilot");
    if (isDir(joinFor(env, root, "session-state")) || isDir(joinFor(env, root, OLD_STATE_DIR)) || safeStat(joinFor(env, root, "session-store.db"))?.isFile()) {
      out.push({ root, home, wsl: home !== env.home });
    }
  }
  return out;
}

interface Pending { ev: ToolEv; shell: boolean }
/**
 * The exchange in progress: from a user message (or a model call without one before it) over its model calls. The
 * CLI's `assistant.turn_start`/`turn_end` pair is one model call — its documented meaning of a turn — so an exchange
 * ends at the last model call before the next user message, or at an abort.
 */
interface Exchange { start: number; lastEnd?: number; calls: number; running?: string }

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
  private exchange?: Exchange;
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
    else this.tally.badTime(v.timestamp, "event.timestamp"); // every event carries its time: without one the field moved
    const d = isObj(v.data) ? v.data : {};
    const timed = (f: (at: number) => void): void => (ts === undefined ? this.tally.skip("no-ts") : f(ts));
    switch (type) {
      case "session.start": this.sessionStart(d); break;
      case "session.model_change": this.addModel(str(d.newModel)); break;
      case "assistant.usage": this.addModel(str(d.model)); break;
      case "user.message": timed((at) => this.userMessage(d, at)); break;
      case "assistant.turn_start": this.callStart(d, ts); break;
      case "assistant.turn_end": if (ts !== undefined) this.callEnd(str(d.turnId), ts); break;
      case "abort": timed((at) => this.abort(at)); break;
      case "tool.execution_start": timed((at) => this.toolStart(d, at)); break;
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

  /** The person's message (`source` absent or `user`; any other source is system input), in memory only. It starts an exchange. */
  private userMessage(d: Obj, ts: number): void {
    this.endExchange("completed");
    this.exchange = { start: ts, calls: 0 };
    if (typeof d.content !== "string") return this.tally.unknownKey("user.message.content:shape");
    const text = userText(d.content);
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

  /** A model call starts; without an exchange open (a resumed session, a run with no user message) it opens one. */
  private callStart(d: Obj, ts: number | undefined): void {
    if (ts === undefined) return;
    this.exchange ??= { start: ts, calls: 0 };
    this.exchange.running = str(d.turnId) ?? "";
  }

  /** A model call ends: only the one running (`turnId`, or the running one when the record names none). */
  private callEnd(id: string | undefined, ts: number): void {
    const x = this.exchange;
    if (x?.running === undefined || (id !== undefined && id !== x.running)) return;
    x.running = undefined;
    x.calls++;
    x.lastEnd = ts;
  }

  /**
   * The open exchange as a TurnEv: `completed` at its last model call's end, once at least one ended; `interrupted` at
   * `at` (an abort). `ms` from its start. An exchange whose model call never ended (the file stops mid-call) has no end.
   */
  private endExchange(status: "completed" | "interrupted", at?: number): void {
    const x = this.exchange;
    this.exchange = undefined;
    const ts = status === "interrupted" ? at : x?.running === undefined ? x?.lastEnd : undefined;
    if (!x || ts === undefined) return;
    const ev: TurnEv = { k: "turn", tool: TOOL, source: CLI_SOURCE, ts, sessionId: this.sessionId, window: "detail", status };
    if (this.model !== undefined) ev.model = this.model;
    if (ts >= x.start) ev.ms = ts - x.start;
    this.out(ev);
  }

  /** An abort is the person's interrupt: it ends the open exchange as interrupted, and the calls still running were interrupted. */
  private abort(ts: number): void {
    const m: MarkerEv = { k: "marker", tool: TOOL, source: CLI_SOURCE, ts, sessionId: this.sessionId, kind: "interrupt", detail: "user" };
    this.out(m);
    for (const p of this.pending.values()) {
      p.ev.outcome = "interrupted";
      this.out(p.ev);
    }
    this.pending.clear();
    this.endExchange("interrupted", ts);
  }

  private toolStart(d: Obj, ts: number): void {
    const callId = str(d.toolCallId);
    const name = str(d.toolName);
    if (callId === undefined || name === undefined) return this.tally.unknownKey("tool.execution_start:shape");
    if (this.pending.has(callId)) return;
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
    this.endExchange("completed");
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

/** Streams one session's `events.jsonl`; its SessionEv follows whenever the file was a regular file (read in full or in part). */
async function scanEvents(file: string, sessionId: string, ctx: ScanCtx, tally: Tally): Promise<void> {
  const reader = new CliReader(sessionId, ctx, tally);
  const r = await streamJsonlFile(file, ctx, tally, (v) => reader.record(v), { ioLog: "cp.io-error" });
  if (r.stat) reader.finish();
}

// ---- the session store (schema verified locally on the VS Code extension's copy; the CLI keeps one of the same name) ----

/**
 * Columns read; every other column is never selected (turn texts, summaries, repository, branch, agent names, and
 * `host_type`, which names the repository's host, not a client).
 */
const STORE_SESSION_COLUMNS = ["id", "cwd", "created_at", "updated_at"] as const;
const STORE_TURN_COLUMNS = ["session_id", "timestamp"] as const;
const STORE_PAGE = 5_000;

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

/**
 * Maps every row of `table` in rowid pages, on the shared pager (`Pass`): a first page that fails other than busy is
 * drift `table-unreadable:<table>`; a busy store, or a later page that fails, is an io-error; either ends the table, with
 * warn `cp.db-busy` for a busy store and `cp.db-query` for any other failure. A row the mapping fails on is skipped as
 * bad-record and the others go on.
 */
async function eachStoreRow(db: RoDb, table: string, cols: string[], map: (r: Obj) => void, ctx: ScanCtx, tally: Tally): Promise<void> {
  const sql = `SELECT rowid AS rid, ${cols.map(q).join(", ")} FROM ${q(table)} WHERE rowid > ? ORDER BY rowid LIMIT ?`;
  await new Pass(db, table, tally, ctx, "cp.db-query", { page: STORE_PAGE, busyLogCode: "cp.db-busy" }).byRowid(sql, (rows) => {
    for (const r of rows) eachRow(() => map(r), tally);
  });
}

/** The client whose session store it is: the VS Code extension's copy, or the CLI's own store. */
export type StoreSurface = "vscode" | "cli";

function storeSession(r: Obj, source: string, surface: StoreSurface, ctx: ScanCtx, tally: Tally): void {
  const raw = str(r.id);
  if (raw === undefined) return tally.skip("bad-row");
  const start = toEpochMs(r.created_at, ctx.now);
  if (start === undefined) return tally.skip("no-ts");
  const end = Math.max(start, toEpochMs(r.updated_at, ctx.now) ?? start);
  const s: SessionEv = { k: "session", tool: TOOL, source, id: cpSessionId(raw, ctx), window: "lifetime", origin: "human", start, end, models: [], surface };
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
 * The session store (`session-store.db`): a lifetime SessionEv per `sessions` row — its surface the client whose store
 * it is — and a lifetime TurnEv per `turns` row, from the allowlisted columns only. A store that cannot be opened or read
 * is an io-error (warn `cp.db-unopenable`, `cp.db-unreadable`); it is always closed. True when its tables could be listed.
 */
export function readSessionStore(file: string, source: string, surface: StoreSurface, ctx: ScanCtx, tally: Tally): Promise<boolean> {
  return readStore(file, ctx, tally, "cp", async (db, tables) => {
    const sCols = storeColumns(db, tables, "sessions", STORE_SESSION_COLUMNS, tally);
    if (sCols?.includes("id")) await eachStoreRow(db, "sessions", sCols, (r) => storeSession(r, source, surface, ctx, tally), ctx, tally);
    const tCols = storeColumns(db, tables, "turns", STORE_TURN_COLUMNS, tally);
    if (tCols?.includes("session_id")) await eachStoreRow(db, "turns", tCols, (r) => storeTurn(r, source, ctx, tally), ctx, tally);
  });
}

/**
 * Scan one `.copilot` root: every `session-state/<id>/events.jsonl` (the detail window), then `session-store.db` (the
 * lifetime window); one CoverageEv per window, last — `absent` for a window whose store is not there.
 */
export async function scanCli(c: Candidate, ctx: ScanCtx): Promise<void> {
  const tally = new Tally(TOOL, CLI_SOURCE);
  const life = new Tally(TOOL, CLI_SOURCE, "lifetime");
  const stateDir = path.join(c.root, "session-state");
  const hasState = isDir(stateDir);
  for (const name of listDir(stateDir, tally)) {
    if (ctx.signal.aborted) break;
    if (name.startsWith(".")) continue;
    const events = path.join(stateDir, name, "events.jsonl");
    // a session is a folder holding events.jsonl; any other entry is a layout this reader does not know
    if (!safeStat(events)?.isFile()) {
      tally.unknownKey("session-state:layout");
      continue;
    }
    await scanEvents(events, cpSessionId(name, ctx), ctx, tally);
  }
  if (isDir(path.join(c.root, OLD_STATE_DIR))) tally.unknownKey(`layout:${OLD_STATE_DIR}`); // the older CLI layout, not read
  const store = path.join(c.root, "session-store.db");
  const hasStore = safeStat(store)?.isFile() ?? false;
  const storeRead = !ctx.signal.aborted && hasStore && (await readSessionStore(store, CLI_SOURCE, "cli", ctx, life));
  const bad = (tally.skipped["bad-record"] ?? 0) + (life.skipped["bad-record"] ?? 0);
  if (bad > 0) ctx.log("warn", "cp.bad-record", bad);
  const hasOld = isDir(path.join(c.root, OLD_STATE_DIR));
  for (const [t, has, readable] of [[tally, hasState || hasOld, true], [life, hasStore, storeRead]] as const) ctx.emit(windowCoverage(t, has, readable));
}

/**
 * A window's coverage: `absent` when its store is not there, `error` (note `unreadable`) when it is but could not be
 * read — unless it is a locked store above MAX_COPY_BYTES, which keeps that reason (note `too-large`).
 */
export function windowCoverage(t: Tally, has: boolean, readable: boolean): PluginCoverage {
  const cov = t.coverage();
  if (!has) cov.status = "absent";
  else if (!readable && t.note !== "too-large") {
    cov.status = "error";
    cov.note = "unreadable";
  }
  return cov;
}
