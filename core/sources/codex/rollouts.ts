import { readdirSync, type Stats } from "node:fs";
import path from "node:path";
import { safeStat } from "../../io/fs";
import { readJsonl } from "../../io/jsonl";
import { toEpochMs } from "../../io/time";
import type { Ev, FileFactEv, MarkerEv, PromptEv, RateLimitEv, RolloutFactEv, SessionEv, ToolEv, TurnEv } from "../../model/events";
import { sid, type MarkerKind, type Origin } from "../../model/ids";
import { classifyIntent } from "../../text/intent";
import { promptFeatures } from "../../text/structure";
import { listDir, Tally, typeKey } from "../common/coverage";
import { isObj, num, safeModel, str, VERSION, type Obj } from "../common/guards";
import type { Candidate, ScanCtx } from "../types";
import { cxEffort } from "./effort";
import { cxSource, cxThreadId } from "./origin";
import { cxOutcome, cxToolCalls, type CxOutcome, type CxToolCall } from "./tools";
import { uuidV7Ms } from "./uuid";

export const ROLLOUTS_SOURCE = "codex.rollouts";
const TOOL = "codex";

/** Rollout line types the CLI writes (its RolloutItem tags, 0.169); any other `type` is format drift. See FORMAT.md. */
export const RECORD_TYPES: ReadonlySet<string> = new Set([
  "session_meta", "turn_context", "response_item", "event_msg", "compacted", "token_usage_record", "world_state",
  "inter_agent_communication", "inter_agent_communication_metadata", "dynamic_tools_updated", "retained_context",
  "security_risk_score", "realtime_item",
]);
/** `payload.type` of response_item lines (the CLI's ResponseItem tags). */
export const RESPONSE_ITEM_TYPES: ReadonlySet<string> = new Set([
  "message", "reasoning", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output", "local_shell_call",
  "web_search_call", "image_generation_call", "tool_search_call", "tool_search_output", "agent_message", "additional_tools",
  "configuration_update", "compaction", "context_compaction", "other",
]);
/** `payload.type` of event_msg lines (the CLI's EventMsg tags). */
export const EVENT_TYPES: ReadonlySet<string> = new Set([
  "error", "warning", "guardian_warning", "deprecation_notice", "stream_error", "auth_recovery_started", "auth_recovery_completed",
  "session_configured", "thread_settings_applied", "thread_goal_updated", "thread_queue_changed", "thread_rolled_back",
  "environment_connected", "environment_disconnected", "model_reroute", "model_verification", "turn_moderation_metadata",
  "safety_buffering", "context_compacted", "shutdown_complete",
  "task_started", "task_complete", "turn_aborted", "turn_diff", "token_count", "plan_update", "plan_delta",
  "user_message", "agent_message", "agent_message_content_delta", "agent_reasoning", "agent_reasoning_raw_content",
  "agent_reasoning_section_break", "reasoning_content_delta", "reasoning_raw_content_delta", "raw_response_item", "raw_response_completed",
  "item_started", "item_completed", "hook_started", "hook_completed",
  "exec_command_begin", "exec_command_output_delta", "exec_command_end", "terminal_interaction", "exec_approval_request",
  "patch_apply_begin", "patch_apply_updated", "patch_apply_end", "apply_patch_approval_request", "request_permissions",
  "mcp_startup_update", "mcp_startup_complete", "mcp_tool_call_begin", "mcp_tool_call_end", "elicitation_request", "elicitation_abandoned",
  "web_search_begin", "web_search_end", "image_generation_begin", "image_generation_end", "view_image_tool_call",
  "request_user_input", "dynamic_tool_call_request", "dynamic_tool_call_response", "guardian_assessment",
  "entered_review_mode", "exited_review_mode", "sub_agent_activity",
  "collab_agent_spawn_begin", "collab_agent_spawn_end", "collab_agent_interaction_begin", "collab_agent_interaction_end",
  "collab_waiting_begin", "collab_waiting_end", "collab_close_begin", "collab_close_end", "collab_resume_begin", "collab_resume_end",
  "realtime_conversation_started", "realtime_conversation_realtime", "realtime_conversation_closed", "realtime_conversation_sdp",
  "realtime_conversation_list_voices_response",
]);
/** `payload.item.type` of item_completed events (the CLI's TurnItem tags). */
export const ITEM_TYPES: ReadonlySet<string> = new Set([
  "UserMessage", "HookPrompt", "AgentMessage", "Plan", "Reasoning", "WebSearch", "ImageGeneration", "ImageView", "CommandExecution",
  "FileChange", "McpToolCall", "DynamicToolCall", "CollabAgentToolCall", "ContextCompaction", "EnteredReviewMode", "ExitedReviewMode",
  "Extension", "FunctionCallOutput", "SubAgentActivity",
]);

/**
 * Lines are dropped from their first bytes, before JSON.parse, when nothing in them is mapped: reasoning, tool outputs,
 * developer/assistant messages, inter-agent messages, world state, per-response token records, image-generation results,
 * and the CLI's copies of messages. Every line starts `{"timestamp":…,("ordinal":…,)"type":…,"payload":{"type":…`.
 */
const HEAD = /^\{"timestamp":"[^"\\]{0,64}",(?:"ordinal":\d{1,15},)?"type":"([a-z_]{1,48})","payload":\{(?:"type":"([a-z_]{1,48})")?/;
const ITEM_HEAD = /"item":\{"type":"([A-Za-z]{1,48})"(?:,"kind":"([a-z_.]{1,48})")?/;
const ROLE_HEAD = /^[^{}[\]]*?"role":"([a-z]{1,16})"/;
const HEAVY_RECORDS = new Set(["world_state", "token_usage_record"]);
const HEAVY_RESPONSE_ITEMS = new Set(["reasoning", "function_call_output", "custom_tool_call_output", "tool_search_output", "agent_message", "additional_tools"]);
const HEAVY_EVENTS = new Set([
  "image_generation_end", "agent_message", "agent_message_content_delta", "agent_reasoning", "agent_reasoning_raw_content",
  "reasoning_content_delta", "reasoning_raw_content_delta", "exec_command_output_delta", "plan_delta", "raw_response_item", "item_started",
]);
const HEAVY_ITEMS = new Set(["Reasoning", "AgentMessage", "UserMessage", "SubAgentActivity"]);
const HEAVY_ROLES = new Set(["developer", "assistant", "system"]);

export function sniffHeavy(head: string): boolean {
  const m = HEAD.exec(head);
  if (!m) return false;
  const [, type, ptype] = m;
  if (HEAVY_RECORDS.has(type!)) return true;
  if (ptype === undefined) return false;
  if (type === "response_item") {
    if (ptype !== "message") return HEAVY_RESPONSE_ITEMS.has(ptype);
    const role = ROLE_HEAD.exec(head.slice(m[0].length))?.[1];
    return role !== undefined && HEAVY_ROLES.has(role);
  }
  if (type !== "event_msg") return false;
  if (ptype !== "item_completed") return HEAVY_EVENTS.has(ptype);
  const item = ITEM_HEAD.exec(head);
  return item !== null && (HEAVY_ITEMS.has(item[1]!) || (item[1] === "Extension" && item[2] === "image_gen.generation"));
}

const TASK_GAP_MS = 30 * 60_000;
/** Bounded per-file state: calls awaiting their completing item, finished call ids, per-turn model/effort/start. */
const PENDING_CALLS = 4096;
const DONE_CALLS = 4096;
const TURN_WINDOW = 256;
const MAX_DEPTH = 6;
const ROLLOUT_FILE = /^rollout-.*\.jsonl$/;
const FILE_TS = /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/;
const FILE_ID = /-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/;
/** A rate-limit bucket id (`rate_limits.limit_id`) is kept when it has this shape, else it becomes `other`. */
const BUCKET = /^[a-z][a-z0-9_-]{0,31}$/;
/**
 * `turn_aborted.reason` (the CLI's TurnAbortReason) → the interrupt marker's detail: the person interrupted (`user`) or
 * sent input that replaced the turn (`replaced`); the review it ran ended, or a budget ran out — not the person.
 */
const ABORT_REASONS: ReadonlyMap<string, string> = new Map([
  ["interrupted", "user"], ["replaced", "replaced"], ["review_ended", "review-ended"], ["budget_limited", "budget-limited"],
]);
const MIN_RESET_MS = Date.UTC(2015, 0, 1);
const MAX_RESET_AHEAD_MS = 400 * 86_400_000;

/**
 * Start markers of user-role messages the CLI writes itself — context, instructions, notices, skill bodies, `!` shell
 * output, review results — which are never prompts. A marker matches only as a whole tag (`<skill>`, `<skill …`), so a
 * prompt that starts with `<skills…` is still a prompt. The last group are CLI notices whose role is not confirmed; a
 * person does not type them.
 */
const INJECTED_TAGS = [
  "environment_context", "user_instructions", "recommended_plugins", "image", "codex_internal_context", "turn_aborted", "skill",
  "user_shell_command", "subagent_notification", "user_action", "realtime_delegation",
  "current_time_reminder", "current_time_unavailable", "agent_message_board_notification", "EXTERNAL SESSION IMPORTED",
];
const INJECTED = new RegExp(`^(?:<(?:${INJECTED_TAGS.join("|")})(?=[\\s>/]|$)|# AGENTS\\.md(?=\\s|$))`);
/** A person's reply to a question the agent sent them, wrapped by the CLI. */
const QUESTION_REPLY = "send_user_message_question_reply";
/**
 * An input_text part the CLI adds around an attached image: its wrapper tags (`<image name=[Image #1]>`, `</image>`) or a
 * notice that the image was resized.
 */
const ATTACHMENT_PART = /^\s*(?:<image\b[^>]*>\s*(?:<\/image>)?|<\/image>|<image_resize_notice>[\s\S]*<\/image_resize_notice>)\s*$/;
const RESIZE_NOTICES = /^\s*(?:<image_resize_notice>[\s\S]*?<\/image_resize_notice>\s*)+/;

/**
 * The person's text in a user-role message's content, or undefined when the CLI wrote the message itself. Input text parts
 * are joined with "\n" after dropping attached images' wrapper parts and resize notices; a question reply is unwrapped.
 */
function promptText(content: unknown): { text: string; images: boolean } | undefined {
  const texts: string[] = [];
  let images = false;
  if (typeof content === "string") texts.push(content);
  else if (Array.isArray(content)) {
    for (const c of content) {
      if (!isObj(c)) continue;
      if (c.type === "input_image") images = true;
      else if (c.type === "input_text" && typeof c.text === "string" && !ATTACHMENT_PART.test(c.text)) texts.push(c.text);
    }
  }
  let text = texts.join("\n").replace(RESIZE_NOTICES, "");
  const lead = text.trimStart();
  if (INJECTED.test(lead)) return undefined;
  if (lead.startsWith(`<${QUESTION_REPLY}>`)) {
    const inner = lead.slice(QUESTION_REPLY.length + 2);
    const end = inner.lastIndexOf(`</${QUESTION_REPLY}>`);
    text = (end < 0 ? inner : inner.slice(0, end)).trim();
  }
  return text.trim() === "" ? undefined : { text, images };
}

/** Local wall-clock time in a `rollout-YYYY-MM-DDThh-mm-ss…` name (the CLI names rollouts in local time). */
function fileTime(name: string): number | undefined {
  const m = FILE_TS.exec(name);
  if (!m) return undefined;
  const [y, mo, d, hh, mi, ss] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  if (hh > 23 || mi > 59 || ss > 59) return undefined;
  const t = new Date(y, mo - 1, d, hh, mi, ss);
  return t.getFullYear() === y && t.getMonth() === mo - 1 && t.getDate() === d ? t.getTime() : undefined;
}

/** A reset time: `resets_at` (epoch seconds or ms), else `ts + resets_in_seconds`; implausible values are dropped. */
function resetTime(x: Obj, ts: number): number | undefined {
  const at = num(x.resets_at);
  if (at !== undefined) {
    const ms = Math.abs(at) < 1e11 ? at * 1000 : at;
    return ms >= MIN_RESET_MS && ms <= ts + MAX_RESET_AHEAD_MS ? ms : undefined;
  }
  const secs = num(x.resets_in_seconds);
  return secs !== undefined && secs >= 0 && secs * 1000 <= MAX_RESET_AHEAD_MS ? ts + secs * 1000 : undefined;
}

interface Turn { model?: string; effort?: string; start?: number }
/** Shell-command events of one root, by whether a command line was found (logged at debug level to check parsing). */
interface CommandCounts { extracted: number; missing: number }
/** `subagent`: the thread's source is a subagent one, whatever its final origin. */
interface Meta { origin: Origin; subagent: boolean; cwd?: string; surface?: string; version?: string; parentId?: string; spawnDepth?: number; agentType?: string; inRepo: boolean }

/** Streams one rollout and turns its lines into events, keeping only small per-file state. */
class RolloutReader {
  sessionId: string;
  /** Set when the thread was already read from another rollout: the rest of this file is skipped. */
  duplicate = false;
  private rawId?: string;
  private meta?: Meta;
  private historyStart?: number;
  private start?: number;
  private end?: number;
  private clock?: number;
  private readonly models: string[] = [];
  private model?: string;
  private effort?: string;
  private readonly turns = new Map<string, Turn>();
  private lastActivity?: number;
  private humanPrompts = 0;
  private prevHuman?: string;
  private lastTotals?: string;
  private readonly lastRate = new Map<string, string>();
  private readonly pending = new Map<string, ToolEv[]>();
  private readonly done = new Set<string>();
  /** Shell-command events not emitted yet → whether a command line was found (by their call, or the item completing it). */
  private readonly commandLineFound = new WeakMap<ToolEv, boolean>();

  constructor(
    private readonly file: string,
    private readonly fileTs: number | undefined,
    private readonly ctx: ScanCtx,
    private readonly tally: Tally,
    private readonly seen: Set<string>,
    private readonly commands: CommandCounts,
  ) {
    // until session_meta names the thread: the id in the file name (the CLI's own), else a keyed hash of the name
    const name = path.basename(file);
    const fromName = FILE_ID.exec(name)?.[1];
    this.sessionId = sid(TOOL, fromName ?? ctx.hash(name));
  }

  private get origin(): Origin {
    return this.meta?.origin ?? "human";
  }

  private out(ev: Ev): void {
    if ("ts" in ev && typeof ev.ts === "number") this.tally.span(ev.ts);
    if (ev.k === "tool") {
      const found = this.commandLineFound.get(ev);
      if (found !== undefined) {
        this.commandLineFound.delete(ev);
        if (found) this.commands.extracted++;
        else this.commands.missing++;
      }
    }
    this.ctx.emit(ev);
  }

  private tick(ts: number): void {
    if (this.start === undefined || ts < this.start) this.start = ts;
    if (this.end === undefined || ts > this.end) this.end = ts;
    this.clock = ts;
  }

  record(v: unknown): void {
    const type = isObj(v) ? v.type : undefined;
    if (!isObj(v) || typeof type !== "string" || !RECORD_TYPES.has(type)) {
      this.tally.unknown(type);
      return;
    }
    if (type === "session_meta") return this.sessionMeta(v);
    // a fork (subagents) starts with history copied from its parent: those lines come before the history-start ordinal.
    // They yield nothing, but the token totals and rate limits they reach are what the thread's own counts continue from.
    if (this.historyStart !== undefined && typeof v.ordinal === "number" && v.ordinal < this.historyStart) {
      if (type === "event_msg" && isObj(v.payload) && v.payload.type === "token_count") this.tokenCount(v.payload, toEpochMs(v.timestamp, this.ctx.now), false);
      return;
    }
    const ts = toEpochMs(v.timestamp, this.ctx.now);
    if (ts !== undefined) this.tick(ts);
    const p = isObj(v.payload) ? v.payload : undefined;
    if (p) {
      if (type === "turn_context") this.turnContext(p);
      else if (type === "response_item") this.responseItem(p, ts);
      else if (type === "event_msg") this.eventMsg(p, ts);
      else if (type === "compacted") this.marker("compact-auto", ts);
    }
    if (ts !== undefined) this.lastActivity = ts;
  }

  /** The first session_meta describes the thread; later ones are copies of a parent's (forked history) and are ignored. */
  private sessionMeta(v: Obj): void {
    if (this.meta) return;
    const p = isObj(v.payload) ? v.payload : {};
    const raw = str(p.id);
    if (raw !== undefined) {
      this.rawId = raw;
      this.sessionId = cxThreadId(raw, this.ctx);
    }
    if (this.seen.has(this.sessionId)) {
      this.duplicate = true;
      return;
    }
    this.seen.add(this.sessionId);
    const ts = toEpochMs(v.timestamp, this.ctx.now);
    if (ts !== undefined) this.tick(ts);

    // origin, surface and subagent links, by the rules the thread index reader shares (origin.ts)
    const { unknownShape, ...driver } = cxSource(p.source, p.originator, this.ctx, p.parent_thread_id);
    if (unknownShape) this.tally.unknownKey("session_meta.source:shape");
    const meta: Meta = { ...driver, inRepo: !!p.git };
    const version = str(p.cli_version);
    if (version !== undefined && VERSION.test(version)) {
      meta.version = version;
      this.tally.versions.add(version);
    }
    const cwd = str(p.cwd);
    if (cwd !== undefined) meta.cwd = cwd;
    this.meta = meta;
    const start = num(p.subagent_history_start_ordinal);
    if (start !== undefined) this.historyStart = start;
  }

  private turnContext(p: Obj): void {
    const raw = str(p.model);
    if (raw !== undefined) {
      this.model = safeModel(raw);
      if (!this.models.includes(this.model)) this.models.push(this.model);
    }
    this.effort = cxEffort(str(p.effort)); // models without reasoning have no effort
    const id = str(p.turn_id);
    if (id !== undefined) this.turn(id, true);
  }

  /** Per-turn state, created on first sight; `fromContext` re-reads the current model and effort into it. */
  private turn(id: string, fromContext = false): Turn {
    let t = this.turns.get(id);
    if (!t) {
      t = { model: this.model, effort: this.effort };
      this.turns.set(id, t);
      if (this.turns.size > TURN_WINDOW) this.turns.delete(this.turns.keys().next().value!);
    } else if (fromContext) {
      t.model = this.model;
      t.effort = this.effort;
    }
    return t;
  }

  private responseItem(p: Obj, ts: number | undefined): void {
    const type = p.type;
    if (typeof type !== "string" || !RESPONSE_ITEM_TYPES.has(type)) {
      this.tally.unknownKey(`response_item:${typeKey(type)}`);
      return;
    }
    if (type === "message") {
      if (p.role === "user") this.userMessage(p, ts);
    } else if (type === "function_call" || type === "custom_tool_call" || type === "local_shell_call" || type === "web_search_call") {
      this.call(p, ts ?? this.clock);
    }
  }

  private userMessage(p: Obj, ts: number | undefined): void {
    if (this.meta?.subagent || ts === undefined) return; // a subagent's user messages are its parent's briefs
    const found = promptText(p.content);
    if (!found) return;
    const { text, images } = found;
    const textHash = this.ctx.hash(text.trim());
    const human = this.origin === "human";
    const isTaskStart = human && (this.humanPrompts === 0 || (this.lastActivity !== undefined && ts - this.lastActivity >= TASK_GAP_MS));
    const ev: PromptEv = {
      k: "prompt", tool: TOOL, source: ROLLOUTS_SOURCE, ts, sessionId: this.sessionId, window: "detail", origin: this.origin,
      intent: classifyIntent(text), features: promptFeatures(text, { hasPaste: images, isTaskStart, prevText: human ? this.prevHuman : undefined }), textHash,
    };
    if (images) ev.hasPaste = true;
    this.out(ev);
    if (human) {
      this.humanPrompts++;
      this.prevHuman = text;
    }
  }

  private toolEv(c: CxToolCall, ts: number, rawId: string | undefined): ToolEv {
    const ev: ToolEv = { k: "tool", tool: TOOL, source: ROLLOUTS_SOURCE, ts, sessionId: this.sessionId, name: c.name, category: c.category };
    if (rawId !== undefined) ev.callId = this.ctx.hash(rawId);
    if (c.checks.length > 0) ev.checks = c.checks;
    if (c.editExt !== undefined) ev.editExt = c.editExt;
    if (c.added !== undefined) ev.linesAdded = c.added;
    if (c.removed !== undefined) ev.linesRemoved = c.removed;
    if (c.mcpServer !== undefined) ev.mcpServer = c.mcpServer;
    if (c.commandLine !== undefined) this.commandLineFound.set(ev, c.commandLine);
    return ev;
  }

  private static apply(ev: ToolEv, o: CxOutcome): void {
    if (o.outcome !== undefined) ev.outcome = o.outcome;
    if (o.ok !== undefined) ev.ok = o.ok;
    if (o.exit !== undefined) ev.exit = o.exit;
    if (o.ms !== undefined) ev.ms = o.ms;
  }

  /** Emits a completed call; one the person declined is also a denial marker. */
  private emitCall(ev: ToolEv): void {
    this.out(ev);
    if (ev.outcome === "denied") this.marker("denial", ev.ts, "user");
  }

  private finished(id: string): void {
    this.done.add(id);
    if (this.done.size > DONE_CALLS) this.done.delete(this.done.values().next().value!);
  }

  /** A call waits for the item that completes it (same id); calls without one are flushed at the end of the file. */
  private call(p: Obj, ts: number | undefined): void {
    const id = str(p.call_id);
    if (ts === undefined || (id !== undefined && (this.pending.has(id) || this.done.has(id)))) return;
    const evs = cxToolCalls(p).map((c) => this.toolEv(c, ts, id));
    if (evs.length === 0) return;
    if (id === undefined) {
      for (const ev of evs) this.out(ev);
      return;
    }
    this.pending.set(id, evs);
    if (this.pending.size > PENDING_CALLS) {
      const [oldest, old] = this.pending.entries().next().value!;
      this.pending.delete(oldest);
      this.finished(oldest);
      for (const ev of old) this.out(ev);
    }
  }

  private eventMsg(p: Obj, ts: number | undefined): void {
    const type = p.type;
    if (typeof type !== "string" || !EVENT_TYPES.has(type)) {
      this.tally.unknownKey(`event_msg:${typeKey(type)}`);
      return;
    }
    switch (type) {
      case "item_completed": return this.itemCompleted(p, ts);
      case "token_count": return this.tokenCount(p, ts);
      case "task_started": {
        const id = str(p.turn_id);
        if (id !== undefined && ts !== undefined) this.turn(id).start ??= ts;
        return;
      }
      case "task_complete": return this.endTurn(p, ts, "completed");
      case "turn_aborted": {
        const reason = str(p.reason);
        this.marker("interrupt", ts, (reason === undefined ? undefined : ABORT_REASONS.get(reason)) ?? "other");
        return this.endTurn(p, ts, "interrupted");
      }
      default: return;
    }
  }

  /** A completed item completes the call with its id, or — Code Mode's nested calls, and actions with no call — is its own event. */
  private itemCompleted(p: Obj, ts: number | undefined): void {
    const item = isObj(p.item) ? p.item : undefined;
    if (!item) return;
    if (typeof item.type !== "string" || !ITEM_TYPES.has(item.type)) {
      this.tally.unknownKey("item:(other)"); // item tags are PascalCase, like names, so they are never copied
      return;
    }
    if (this.foreign(p.thread_id) || (item.type === "CollabAgentToolCall" && this.foreign(item.sender_thread_id))) {
      this.tally.skip("foreign-item");
      return;
    }
    const id = str(item.id);
    const outcome = cxOutcome(item);
    // input sent to a command that is already running: never a command of its own
    const interaction = item.type === "CommandExecution" && item.source === "unified_exec_interaction";
    const waiting = id === undefined ? undefined : this.pending.get(id);
    if (waiting) {
      this.pending.delete(id!);
      this.finished(id!);
      // the command that ran decides a linked shell call's category and checks (the call may not have named it);
      // input sent to a running command, like a command the person ran, names no command of its own
      const [ran] = item.type === "CommandExecution" && waiting.length === 1 ? cxToolCalls(item) : [];
      for (const ev of waiting) {
        if (ran && ev.category === "shell") {
          ev.category = ran.category;
          if (ran.checks.length > 0) ev.checks = ran.checks;
        }
        if (ran?.commandLine && this.commandLineFound.has(ev)) this.commandLineFound.set(ev, true);
        RolloutReader.apply(ev, outcome);
        this.emitCall(ev);
      }
      return;
    }
    if (id !== undefined && this.done.has(id)) return;
    if (interaction) {
      this.tally.skip("exec-interaction");
      return;
    }
    const calls = cxToolCalls(item);
    const at = toEpochMs(p.started_at_ms, this.ctx.now) ?? ts ?? this.clock;
    if (calls.length === 0 || at === undefined) return;
    for (const c of calls) {
      const ev = this.toolEv(c, at, id);
      RolloutReader.apply(ev, outcome);
      this.emitCall(ev);
    }
    if (id !== undefined) this.finished(id); // the same item again, or its call arriving after it, is not counted twice
  }

  /** A thread id that is present and is not this rollout's own. */
  private foreign(threadId: unknown): boolean {
    return typeof threadId === "string" && this.rawId !== undefined && threadId !== this.rawId;
  }

  /**
   * Usage of the last model response (never the running totals), once per change of the totals; rate limits per bucket
   * and window. With `emit` false (copied history) only the baselines move.
   */
  private tokenCount(p: Obj, ts: number | undefined, emit = true): void {
    if (ts === undefined) return;
    const info = isObj(p.info) ? p.info : undefined;
    const last = info && isObj(info.last_token_usage) ? info.last_token_usage : undefined;
    if (info && last) {
      const key = JSON.stringify(isObj(info.total_token_usage) ? info.total_token_usage : last);
      if (key !== this.lastTotals) {
        this.lastTotals = key;
        const n = (v: unknown) => Math.max(0, num(v) ?? 0);
        const cached = n(last.cached_input_tokens);
        if (emit) {
          this.out({
            k: "usage", tool: TOOL, source: ROLLOUTS_SOURCE, ts, sessionId: this.sessionId, model: this.model ?? "other",
            inTok: Math.max(0, n(last.input_tokens) - cached), outTok: n(last.output_tokens), cacheR: cached, cacheW: n(last.cache_write_input_tokens),
          });
        }
      }
    }
    const limits = isObj(p.rate_limits) ? p.rate_limits : undefined;
    if (!limits) return;
    const id = str(limits.limit_id);
    const bucket = id === undefined ? undefined : BUCKET.test(id) ? id : "other";
    for (const window of ["primary", "secondary"] as const) this.rateLimit(bucket, window, limits[window], ts, emit);
  }

  /** One RateLimitEv per window present; a snapshot equal to the previous one of its bucket and window is not repeated. */
  private rateLimit(bucket: string | undefined, window: "primary" | "secondary", x: unknown, ts: number, emit: boolean): void {
    const used = isObj(x) ? num(x.used_percent) : undefined;
    if (!isObj(x) || used === undefined) return;
    const ev: RateLimitEv = { k: "ratelimit", tool: TOOL, source: ROLLOUTS_SOURCE, ts, window, usedPercent: used };
    const minutes = num(x.window_minutes);
    if (minutes !== undefined) ev.windowMinutes = minutes;
    const resets = resetTime(x, ts);
    if (resets !== undefined) ev.resetsAt = resets;
    if (bucket !== undefined) ev.bucket = bucket;
    const slot = `${bucket ?? ""}|${window}`;
    const key = `${used}|${minutes}|${resets}`;
    if (this.lastRate.get(slot) === key) return;
    this.lastRate.set(slot, key);
    if (emit) this.out(ev);
  }

  private endTurn(p: Obj, ts: number | undefined, status: "completed" | "interrupted"): void {
    if (ts === undefined) return;
    const id = str(p.turn_id);
    const t = id === undefined ? undefined : this.turns.get(id);
    const ev: TurnEv = { k: "turn", tool: TOOL, source: ROLLOUTS_SOURCE, ts, sessionId: this.sessionId, window: "detail", status };
    const model = t ? t.model : this.model;
    const effort = t ? t.effort : this.effort;
    if (model !== undefined) ev.model = model;
    if (effort !== undefined) ev.effort = effort;
    const ms = num(p.duration_ms) ?? (t?.start !== undefined ? ts - t.start : undefined);
    if (ms !== undefined && ms >= 0) ev.ms = ms;
    this.out(ev);
  }

  private marker(kind: MarkerKind, ts: number | undefined, detail?: string): void {
    const at = ts ?? this.clock;
    if (at === undefined) return;
    const ev: MarkerEv = { k: "marker", tool: TOOL, source: ROLLOUTS_SOURCE, ts: at, sessionId: this.sessionId, kind };
    if (detail !== undefined) ev.detail = detail;
    this.out(ev);
  }

  /** Flush calls still waiting; then the session, and — for a fully read file — its rollout and file facts. */
  finish(stat: Stats | undefined): void {
    for (const evs of this.pending.values()) for (const ev of evs) this.out(ev);
    this.pending.clear();
    if (this.duplicate) return;
    if (this.start !== undefined && this.end !== undefined) {
      this.out(this.session(this.start, this.end));
      this.tally.span(this.start);
      this.tally.span(this.end);
    }
    if (!stat) return;
    const fact: RolloutFactEv = { k: "codex-rollout", tool: TOOL, source: ROLLOUTS_SOURCE, threadId: this.sessionId };
    const uuidTs = this.rawId === undefined ? undefined : uuidV7Ms(this.rawId);
    if (uuidTs !== undefined) fact.uuidTs = uuidTs;
    if (this.fileTs !== undefined) fact.fileTs = this.fileTs;
    this.out(fact);
    const f: FileFactEv = { k: "file", tool: TOOL, source: ROLLOUTS_SOURCE, pathHash: this.ctx.hash(this.file), bytes: stat.size, mtime: Math.floor(stat.mtimeMs) };
    if (stat.birthtimeMs > 0) f.birth = Math.floor(stat.birthtimeMs);
    if (stat.ctimeMs > 0) f.ctime = Math.floor(stat.ctimeMs);
    if (this.start !== undefined) f.firstTs = this.start;
    if (this.end !== undefined) f.lastTs = this.end;
    this.out(f);
  }

  private session(start: number, end: number): SessionEv {
    const m = this.meta;
    const s: SessionEv = {
      k: "session", tool: TOOL, source: ROLLOUTS_SOURCE, id: this.sessionId, window: "detail", origin: this.origin, start, end, models: [...this.models],
    };
    if (!m) return s;
    if (m.parentId !== undefined) s.parentId = m.parentId;
    if (m.cwd !== undefined) s.projectKey = this.ctx.registerCwd(m.cwd);
    if (m.surface !== undefined) s.surface = m.surface;
    if (m.version !== undefined) s.version = m.version;
    if (m.spawnDepth !== undefined) s.spawnDepth = m.spawnDepth;
    if (m.agentType !== undefined) s.agentType = m.agentType;
    s.inRepo = m.inRepo;
    return s;
  }
}

async function scanFile(file: string, ctx: ScanCtx, tally: Tally, seen: Set<string>, commands: CommandCounts): Promise<void> {
  const st = safeStat(file);
  if (!st?.isFile()) return;
  const reader = new RolloutReader(file, fileTime(path.basename(file)), ctx, tally, seen, commands);
  let complete = true;
  try {
    for await (const item of readJsonl(file, { sniffSkip: sniffHeavy, signal: ctx.signal })) {
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
      if (reader.duplicate) break;
    }
  } catch {
    complete = false;
    tally.skip("io-error");
    ctx.log("warn", "cx.io-error");
  }
  if (reader.duplicate) {
    tally.skip("duplicate");
    return;
  }
  if (ctx.signal.aborted) complete = false;
  if (complete) {
    tally.files++;
    tally.bytes += st.size;
  }
  reader.finish(complete ? st : undefined);
}

/**
 * Rollouts below a folder, in name order (`YYYY/MM/DD/rollout-*.jsonl`); symlinks are not followed. A missing top folder
 * has none; an unreadable one throws (it makes the source meaningless); an unreadable subfolder counts as io-error.
 */
function rolloutFiles(dir: string, tally: Tally, depth = 0, out: string[] = []): string[] {
  let names: string[];
  if (depth > 0) names = listDir(dir, tally);
  else {
    try {
      names = readdirSync(dir).sort();
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "ENOENT" || code === "ENOTDIR") return out;
      throw e;
    }
  }
  for (const name of names) {
    const p = path.join(dir, name);
    const st = safeStat(p);
    if (st?.isDirectory()) {
      if (depth < MAX_DEPTH) rolloutFiles(p, tally, depth + 1, out);
    } else if (st?.isFile() && ROLLOUT_FILE.test(name)) out.push(p);
  }
  return out;
}

/**
 * Scan `<codex>/sessions` and `<codex>/archived_sessions`; each thread once (the first rollout naming it); one CoverageEv,
 * last. The shell-command events with and without a command line are logged once (debug `codex.cmd-extracted`,
 * `codex.cmd-missing`): a share that falls means the CLI moved its command lines somewhere the reader does not look.
 */
export async function scanRollouts(c: Candidate, ctx: ScanCtx): Promise<void> {
  const tally = new Tally(TOOL, ROLLOUTS_SOURCE);
  const seen = new Set<string>();
  const commands: CommandCounts = { extracted: 0, missing: 0 };
  for (const folder of ["sessions", "archived_sessions"]) {
    for (const file of rolloutFiles(path.join(c.root, folder), tally)) {
      if (ctx.signal.aborted) break;
      await scanFile(file, ctx, tally, seen, commands);
    }
  }
  ctx.log("debug", "codex.cmd-extracted", commands.extracted);
  ctx.log("debug", "codex.cmd-missing", commands.missing);
  const bad = tally.skipped["bad-record"] ?? 0;
  if (bad > 0) ctx.log("warn", "cx.bad-record", bad); // a mapping bug must not look like a healthy source
  ctx.emit(tally.coverage());
}
