import { readdirSync, type Stats } from "node:fs";
import path from "node:path";
import { readJsonSmall, safeStat } from "../../io/fs";
import { readJsonl } from "../../io/jsonl";
import { toEpochMs } from "../../io/time";
import type { Ev, FileFactEv, MarkerEv, SessionEv, ToolEv, TotalsEv, TurnEv } from "../../model/events";
import { sid, type MarkerKind, type Origin } from "../../model/ids";
import { classifyIntent } from "../../text/intent";
import { promptFeatures } from "../../text/structure";
import { listDir, readSidecar, Tally } from "../common/coverage";
import { idPart, isObj, num, safeModel, str, UUID, VERSION, type Obj } from "../common/guards";
import type { Candidate, ScanCtx } from "../types";
import { ccPromptOrigin, isInterrupt, typedText, unknownProvenance, userText } from "./origin";
import { ccToolCategory, mcpServerOf, patchLines, SHELL } from "./tools";

export const TRANSCRIPTS_SOURCE = "claude-code.transcripts";
const TOOL = "claude-code";

/** Every entry type in the CLI's own transcript tables (2.1.x); any other `type` is format drift. See FORMAT.md. */
export const KNOWN_TYPES: ReadonlySet<string> = new Set([
  // conversation
  "user", "assistant", "system", "attachment", "progress", "summary",
  // session metadata, re-stamped as the session goes
  "custom-title", "ai-title", "last-prompt", "tag", "relocated", "agent-name", "agent-color", "agent-setting",
  "mode", "permission-mode", "repl-mode", "isolation-latch", "session-owner", "dev-mods", "memory-mode", "atis-latch",
  "tools-used", "worktree-state", "bridge-session", "history-suppression", "ended-by-model", "derived-from",
  "data-flow-records", "data-flow-incomplete", "artifact-comment-monitor", "artifact-autoreact-ledger",
  // delivery and accounting
  "pr-link", "frame-link", "cost-state", "queue-operation",
  // request replay, file history and fork bookkeeping
  "api-request", "api-request-shape", "api-request-blob", "file-history-snapshot", "file-history-delta",
  "attribution-snapshot", "content-replacement", "fork-context-ref", "observer-ref", "continued-in", "resume-head-vouch",
]);

/** Conversation records always carry a time; one without is a moved or reshaped field (drift), never a quiet drop. */
const TIMED: ReadonlySet<string> = new Set(["user", "assistant", "system"]);
/** Non-human origins a session's prompts can show, strongest first: positive evidence that no person typed in it. */
const NON_HUMAN: readonly Origin[] = ["peer", "scripted", "scheduled", "system"];

/** Heavy lines (request replays, file-history backups) are dropped from their first bytes, before JSON.parse. */
const HEAVY = ['"type":"api-request-blob"', '"type":"api-request"', '"type":"file-history-'];
export const sniffHeavy = (head: string): boolean => HEAVY.some((s) => head.includes(s));

const SYNTHETIC_MODEL = "<synthetic>";
const TASK_GAP_MS = 30 * 60_000;
const DEFAULT_RETENTION_DAYS = 30;
/** Bounded per-file state: API messages awaiting more block records, tool uses awaiting results, finished tool ids. */
const MESSAGE_WINDOW = 256;
const PENDING_TOOLS = 4096;
const DONE_TOOLS = 4096;
const PERMISSION_MODES = new Set(["default", "acceptEdits", "plan", "auto", "bypassPermissions"]);
/** Agent types the CLI ships; any other agent type is a config name and is kept only as a keyed hash. */
const BUILTIN_AGENTS = new Set([
  "general-purpose", "Explore", "Plan", "claude", "fork", "statusline-setup", "output-style-setup", "claude-code-guide",
  "comment-thread-analyst", "workflow-subagent",
]);
const SURFACE = /^[a-z][a-z0-9-]{0,31}$/;
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
/** Names the CLI gives its files and folders (sessions are UUID-named); any other name is hashed before it becomes part of an id. */
const AGENT_STEM = /^agent-[A-Za-z0-9]+$/;
const WORKFLOW_DIR = /^wf_[A-Za-z0-9_-]+$/;

const safeEffort = (e: string | undefined): string | undefined => (e === undefined || EFFORTS.has(e) ? e : "other");

/**
 * `toolDenialKind` of a tool reply (CLI program): the call did not run to an end of its own. Refusals are denials,
 * with who refused (`user`, a permission `rule`, the `auto` mode's check); an interrupted or cancelled call is no denial.
 */
const DENIALS: ReadonlyMap<string, { outcome: NonNullable<ToolEv["outcome"]>; by?: "user" | "rule" | "auto" }> = new Map([
  ["user-rejected", { outcome: "denied", by: "user" }], ["permission-rule", { outcome: "denied", by: "rule" }],
  ["automode-blocked", { outcome: "denied", by: "auto" }], ["automode-unavailable", { outcome: "denied", by: "auto" }],
  ["automode-parsing-error", { outcome: "denied", by: "auto" }],
  ["interrupted", { outcome: "interrupted" }], ["cancelled", { outcome: "cancelled" }],
]);
/** A failing shell command's reply: `is_error` with content that starts `Exit code <n>`. */
const EXIT_CODE = /^Exit code (-?\d{1,3})\b/;

/** The text of a tool_result's content: a string, or its first text block. */
function resultText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const block = content.find((b) => isObj(b) && b.type === "text" && typeof b.text === "string") as Obj | undefined;
  return block?.text as string | undefined;
}

/** Coverage counters of the transcripts reader, with its two diagnostics. */
export class CcTally extends Tally {
  /** Reported through ctx.log: heavy lines the sniff missed; top-level files holding another session's records. */
  heavyParsed = 0;
  foreignSessionFiles = 0;

  constructor() {
    super(TOOL, TRANSCRIPTS_SOURCE, "detail");
  }
}

/** The allowlisted part of `agent-*.meta.json`. */
interface Meta { agentType?: string; isBuiltIn?: boolean; spawnDepth?: number; model?: string; toolUseId?: string; background?: boolean; stoppedByUser: boolean }

/** `stem`: the raw file stem of a top-level transcript, compared with its records' `sessionId` (diagnostic only). */
interface FileSpec { file: string; sessionId: string; sub: boolean; stem?: string; parentId?: string; meta?: Meta; workflowId?: string }

interface PendingUsage { ts: number; model: string; inTok: number; outTok: number; cacheR: number; cacheW: number; seen: boolean }

function readMeta(file: string, tally: Tally): Meta | undefined {
  const v = readSidecar(file, tally);
  if (!v) return undefined;
  const depth = num(v.spawnDepth);
  return {
    agentType: str(v.agentType),
    isBuiltIn: typeof v.isBuiltIn === "boolean" ? v.isBuiltIn : undefined,
    spawnDepth: depth !== undefined && Number.isInteger(depth) && depth >= 0 ? depth : undefined,
    model: str(v.model),
    toolUseId: str(v.toolUseId),
    background: v.requestShape === "background" ? true : v.requestShape === "foreground" ? false : undefined,
    stoppedByUser: v.stoppedByUser === true,
  };
}

/** Streams one transcript file and turns its records into events, keeping only small per-file state. */
class TranscriptReader {
  private start?: number;
  private end?: number;
  private clock?: number;
  private cwd?: string;
  private version?: string;
  private surface?: string;
  private readonly models: string[] = [];
  private humanPrompts = 0;
  /** Non-human origins seen on prompt records, and whether a record came through an SDK entrypoint: the evidence for a session's origin. */
  private readonly nonHuman = new Set<Origin>();
  private sdk = false;
  private lastActivity?: number;
  private prevHuman?: string;
  private lastModel?: string;
  private lastEffort?: string;
  private permission?: string;
  private cost?: TotalsEv;
  private readonly tools = new Map<string, ToolEv>();
  private readonly doneTools = new Set<string>();
  private readonly messages = new Map<string, PendingUsage>();
  private readonly prs = new Set<string>();
  private readonly owners = new Set<string>();
  private readonly undated: { kind: MarkerKind; detail?: string }[] = [];
  private foreignSession = false;

  constructor(
    private readonly spec: FileSpec,
    private readonly ctx: ScanCtx,
    private readonly tally: CcTally,
    private readonly delegations: ReadonlyMap<string, string>,
  ) {}

  private out(ev: Ev): void {
    if ("ts" in ev && typeof ev.ts === "number") this.tally.span(ev.ts);
    this.ctx.emit(ev);
  }

  /** Markers on records without their own timestamp take the file's clock (or, before any, the first one seen). */
  private marker(kind: MarkerKind, ts?: number, detail?: string): void {
    const at = ts ?? this.clock;
    if (at === undefined) {
      this.undated.push(detail === undefined ? { kind } : { kind, detail });
      return;
    }
    const ev: MarkerEv = { k: "marker", tool: TOOL, source: TRANSCRIPTS_SOURCE, ts: at, sessionId: this.spec.sessionId, kind };
    if (detail !== undefined) ev.detail = detail;
    this.out(ev);
  }

  private tick(ts: number): void {
    if (this.start === undefined || ts < this.start) this.start = ts;
    if (this.end === undefined || ts > this.end) this.end = ts;
    this.clock = ts;
    if (this.undated.length > 0) for (const m of this.undated.splice(0)) this.marker(m.kind, ts, m.detail);
  }

  record(v: unknown): void {
    const type = isObj(v) ? v.type : undefined;
    if (!isObj(v) || typeof type !== "string" || !KNOWN_TYPES.has(type)) {
      this.tally.unknown(type);
      return;
    }
    if (type === "ai-title") return; // dropped after reading only its type
    if (type === "api-request" || type === "api-request-blob" || type.startsWith("file-history-")) {
      this.tally.heavyParsed++;
      return;
    }
    // a forked session's transcript starts with copies of the original session's records, which keep its sessionId:
    // they belong to that session (read from its own file), so here they are skipped
    if (this.spec.stem !== undefined && typeof v.sessionId === "string" && v.sessionId !== this.spec.stem) {
      this.foreignSession = true;
      this.tally.skip("copied");
      return;
    }
    const ts = toEpochMs(v.timestamp, this.ctx.now);
    if (ts !== undefined) this.tick(ts);
    else if (TIMED.has(type)) this.tally.badTime(v.timestamp);
    if (typeof v.entrypoint === "string" && v.entrypoint.startsWith("sdk")) this.sdk = true;
    const version = str(v.version);
    if (version !== undefined && VERSION.test(version)) {
      this.version = version;
      this.tally.versions.add(version);
    }
    this.cwd ??= str(v.cwd);
    if (this.surface === undefined && typeof v.entrypoint === "string" && SURFACE.test(v.entrypoint)) this.surface = v.entrypoint;
    switch (type) {
      case "user": return this.user(v, ts);
      case "assistant": return this.assistant(v, ts);
      case "system": return this.system(v, ts);
      case "permission-mode": return this.permissionMode(v);
      case "pr-link": return this.prLink(v, ts);
      case "cost-state": return this.costState(v);
      case "session-owner": return this.owner(v);
      default: return;
    }
  }

  private user(v: Obj, ts: number | undefined): void {
    const content = isObj(v.message) ? v.message.content : undefined;
    if (typeof content !== "string" && !Array.isArray(content)) this.tally.unknownKey("user.content:shape");
    const blocks = Array.isArray(content) ? content.filter(isObj) : [];
    const results = blocks.filter((b) => b.type === "tool_result");
    for (const b of results) this.result(b, v, ts, results.length === 1);
    const texts = typeof content === "string" ? [content] : blocks.flatMap((b) => (b.type === "text" && typeof b.text === "string" ? [b.text] : []));
    if (texts.some(isInterrupt)) this.marker("interrupt", ts, "user");
    else if (!this.spec.sub) this.prompt(v, ts);
    if (ts !== undefined) this.lastActivity = ts;
  }

  private prompt(v: Obj, ts: number | undefined): void {
    const origin = ccPromptOrigin(v);
    if (origin === "not-a-prompt") return;
    for (const key of unknownProvenance(v)) this.tally.unknownKey(key); // a new CLI value is drift, never a silent human
    if (origin !== "human") this.nonHuman.add(origin);
    const text = typedText(userText(v) ?? "");
    const human = origin === "human";
    const first = this.humanPrompts === 0;
    if (human) this.humanPrompts++;
    // Queueing a follow-up while the agent works shows on the prompt itself. The CLI's queue-operation journal is no
    // substitute: it also logs task notifications, agent messages and SDK input (FORMAT.md).
    if (human && v.promptSource === "queued") this.marker("queue", ts);
    if (ts !== undefined) {
      const isTaskStart = human && (first || (this.lastActivity !== undefined && ts - this.lastActivity >= TASK_GAP_MS));
      this.out({
        k: "prompt", tool: TOOL, source: TRANSCRIPTS_SOURCE, ts, sessionId: this.spec.sessionId, window: "detail", origin,
        intent: classifyIntent(text),
        features: promptFeatures(text, { isTaskStart, prevText: human ? this.prevHuman : undefined }),
        textHash: this.ctx.hash(text.trim()),
      });
    } else this.tally.skip("no-ts");
    if (human) this.prevHuman = text;
  }

  private assistant(v: Obj, ts: number | undefined): void {
    const msg = isObj(v.message) ? v.message : undefined;
    if (!msg) return this.tally.unknownKey("assistant.message:shape");
    if (!Array.isArray(msg.content)) this.tally.unknownKey("assistant.content:shape");
    const raw = str(msg.model);
    if (raw !== undefined && raw !== SYNTHETIC_MODEL) {
      const model = safeModel(raw);
      if (!this.models.includes(model)) this.models.push(model);
      this.lastModel = model;
      this.lastEffort = safeEffort(str(v.effort));
      if (ts !== undefined) this.noteMessage(msg, v, model, ts);
      else this.tally.skip("no-ts");
    }
    if (Array.isArray(msg.content)) for (const b of msg.content) if (isObj(b) && b.type === "tool_use") this.toolUse(b, ts ?? this.clock);
    if (ts !== undefined) this.lastActivity = ts;
  }

  /** One API response is written as one record per content block; usage and anchors are counted once per message id. */
  private noteMessage(msg: Obj, v: Obj, model: string, ts: number): void {
    const usage = isObj(msg.usage) ? msg.usage : undefined;
    const id = str(msg.id);
    let p = id === undefined ? undefined : this.messages.get(id);
    if (!p) {
      p = { ts, model, inTok: 0, outTok: 0, cacheR: 0, cacheW: 0, seen: false };
      if (id?.startsWith("msg_") && id.length > 4) this.out({ k: "anchor", tool: TOOL, source: TRANSCRIPTS_SOURCE, kind: "cc-msg", ts, idTail: id.slice(4) });
      const req = str(v.requestId);
      if (req?.startsWith("req_") && req.length > 4) this.out({ k: "anchor", tool: TOOL, source: TRANSCRIPTS_SOURCE, kind: "cc-req", ts, idTail: req.slice(4) });
      if (id !== undefined) {
        this.messages.set(id, p);
        if (this.messages.size > MESSAGE_WINDOW) {
          const [oldest, old] = this.messages.entries().next().value!;
          this.messages.delete(oldest);
          this.usage(old);
        }
      }
    }
    if (usage) {
      p.seen = true;
      p.inTok = Math.max(p.inTok, num(usage.input_tokens) ?? 0);
      p.outTok = Math.max(p.outTok, num(usage.output_tokens) ?? 0);
      p.cacheR = Math.max(p.cacheR, num(usage.cache_read_input_tokens) ?? 0);
      p.cacheW = Math.max(p.cacheW, num(usage.cache_creation_input_tokens) ?? 0);
    }
    if (id === undefined) this.usage(p);
  }

  private usage(p: PendingUsage): void {
    if (!p.seen) return;
    this.out({ k: "usage", tool: TOOL, source: TRANSCRIPTS_SOURCE, ts: p.ts, sessionId: this.spec.sessionId, model: p.model, inTok: p.inTok, outTok: p.outTok, cacheR: p.cacheR, cacheW: p.cacheW });
  }

  private toolUse(b: Obj, ts: number | undefined): void {
    const id = str(b.id);
    const name = str(b.name);
    if (id === undefined || name === undefined) return this.tally.unknownKey("tool_use:shape");
    if (this.tools.has(id) || this.doneTools.has(id)) return; // the same call again
    if (ts === undefined) return this.tally.skip("no-ts");
    const { category, checks, editExt } = ccToolCategory(name, b.input);
    const ev: ToolEv = {
      k: "tool", tool: TOOL, source: TRANSCRIPTS_SOURCE, ts, sessionId: this.spec.sessionId, callId: id,
      name: category === "mcp" ? "mcp" : TOOL_NAME.test(name) ? name : "other", category,
    };
    if (checks.length > 0) ev.checks = checks;
    if (editExt !== undefined) ev.editExt = editExt;
    if (category === "mcp") ev.mcpServer = mcpServerOf(name);
    if (category === "delegate") {
      const to = this.delegations.get(id);
      if (to !== undefined) ev.delegateTo = to;
    }
    if (name === "EnterPlanMode") this.marker("plan-enter", ts);
    else if (name === "ExitPlanMode") this.marker("plan-exit", ts);
    this.tools.set(id, ev);
    if (this.tools.size > PENDING_TOOLS) {
      const [oldest, old] = this.tools.entries().next().value!;
      this.tools.delete(oldest);
      this.done(oldest);
      this.out(old);
    }
  }

  private done(id: string): void {
    this.doneTools.add(id);
    if (this.doneTools.size > DONE_TOOLS) this.doneTools.delete(this.doneTools.values().next().value!);
  }

  /**
   * A tool_result closes its tool use. A call that did not run to an end of its own (`toolDenialKind`, or a shell
   * command `interrupted`) gets an outcome and no ok or exit; a refusal is also a denial marker. Else ok = not
   * `is_error`, and a failing shell command's exit code comes from `toolUseResult.exitCode`, else from its reply's
   * `Exit code <n>`. When the record holds exactly one result: duration, patch size, commit.
   */
  private result(b: Obj, rec: Obj, ts: number | undefined, single: boolean): void {
    const id = str(b.tool_use_id);
    const ev = id === undefined ? undefined : this.tools.get(id);
    if (id === undefined || !ev) return;
    this.tools.delete(id);
    this.done(id);
    const r = single && isObj(rec.toolUseResult) ? rec.toolUseResult : undefined;
    const denial = rec.toolDenialKind;
    if (denial !== undefined && denial !== null) {
      const d = typeof denial === "string" ? DENIALS.get(denial) : undefined;
      if (d === undefined) this.tally.unknownKey("toolDenialKind:(other)"); // a new kind: still a call that did not run
      ev.outcome = d?.outcome ?? "denied";
      if (ev.outcome === "denied") this.marker("denial", ts, d?.by ?? "other");
    } else if (r?.interrupted === true) {
      ev.outcome = "interrupted";
    } else {
      ev.ok = b.is_error !== true;
      const exit = r === undefined ? undefined : num(r.exitCode);
      const shown = b.is_error === true && SHELL.has(ev.name) ? EXIT_CODE.exec(resultText(b.content)?.trimStart() ?? "")?.[1] : undefined;
      if (exit !== undefined) ev.exit = exit;
      else if (shown !== undefined) ev.exit = Number(shown);
    }
    if (r) {
      const ms = num(r.durationMs) ?? num(r.totalDurationMs);
      if (ms !== undefined && ms >= 0) ev.ms = ms;
      const lines = patchLines(r.structuredPatch);
      if (lines) {
        ev.linesAdded = lines.added;
        ev.linesRemoved = lines.removed;
      }
      const commit = isObj(r.gitOperation) && isObj(r.gitOperation.commit) ? r.gitOperation.commit : undefined;
      if (commit) {
        const sha = str(commit.sha);
        this.marker("commit", ts, sha === undefined ? undefined : this.ctx.hash(sha));
      }
    }
    this.out(ev);
  }

  private system(v: Obj, ts: number | undefined): void {
    if (v.subtype === "turn_duration") {
      const ms = num(v.durationMs);
      if (ms === undefined || ms < 0) return this.tally.unknownKey("turn_duration:shape");
      if (ts === undefined) return this.tally.skip("no-ts");
      const ev: TurnEv = { k: "turn", tool: TOOL, source: TRANSCRIPTS_SOURCE, ts, sessionId: this.spec.sessionId, window: "detail", status: "completed", ms };
      if (this.lastModel !== undefined) ev.model = this.lastModel;
      if (this.lastEffort !== undefined) ev.effort = this.lastEffort;
      this.out(ev);
    } else if (v.subtype === "compact_boundary") {
      const trigger = isObj(v.compactMetadata) ? v.compactMetadata.trigger : undefined;
      this.marker(trigger === "manual" ? "compact-manual" : "compact-auto", ts);
    }
  }

  /** Permission mode is re-stamped as metadata; only changes become markers. */
  private permissionMode(v: Obj): void {
    if (typeof v.permissionMode !== "string") return;
    const mode = PERMISSION_MODES.has(v.permissionMode) ? v.permissionMode : "other";
    if (mode === this.permission) return;
    this.permission = mode;
    this.marker("permission-mode", undefined, mode);
  }

  /** PR links are re-stamped too; one marker per pull request, identified by a keyed hash of its URL. */
  private prLink(v: Obj, ts: number | undefined): void {
    const repo = str(v.prRepository);
    const n = num(v.prNumber);
    const key = str(v.prUrl) ?? (repo !== undefined && n !== undefined ? `${repo}#${n}` : undefined);
    if (key === undefined) return;
    const hash = this.ctx.hash(key);
    if (this.prs.has(hash)) return;
    this.prs.add(hash);
    this.marker("pr-link", ts, hash);
  }

  /** cost-state totals are cumulative for the session; the last record wins. */
  private costState(v: Obj): void {
    const ev: TotalsEv = { k: "totals", tool: TOOL, source: TRANSCRIPTS_SOURCE, sessionId: this.spec.sessionId };
    const added = num(v.totalLinesAdded);
    const removed = num(v.totalLinesRemoved);
    const usd = num(v.totalCostUSD);
    const ms = num(v.totalDuration);
    if (added !== undefined) ev.linesAdded = added;
    if (removed !== undefined) ev.linesRemoved = removed;
    if (usd !== undefined) ev.usd = usd;
    if (ms !== undefined) ev.ms = ms;
    this.cost = ev;
  }

  private owner(v: Obj): void {
    const uuid = str(v.accountUuid);
    if (uuid === undefined) return;
    const hash = this.ctx.hash(uuid);
    if (this.owners.has(hash)) return;
    this.owners.add(hash);
    this.out({ k: "identity", tool: TOOL, source: TRANSCRIPTS_SOURCE, scope: "session", hash, sessionId: this.spec.sessionId });
  }

  /** Flush pending state; the session and file facts are emitted once the whole file was seen. */
  finish(stat: Stats | undefined): void {
    if (this.foreignSession) this.tally.foreignSessionFiles++;
    for (const _ of this.undated.splice(0)) this.tally.skip("no-ts"); // markers of a file that never gave a time
    for (const ev of this.tools.values()) this.out(ev);
    this.tools.clear();
    for (const p of this.messages.values()) this.usage(p);
    this.messages.clear();
    if (this.cost) this.out(this.cost);
    if (this.start !== undefined && this.end !== undefined) {
      if (this.spec.meta?.stoppedByUser) this.marker("interrupt", this.end, "stopped-by-user");
      this.out(this.session(this.start, this.end));
      this.tally.span(this.start);
      this.tally.span(this.end);
    }
    if (stat) {
      const f: FileFactEv = { k: "file", tool: TOOL, source: TRANSCRIPTS_SOURCE, pathHash: this.ctx.hash(this.spec.file), bytes: stat.size, mtime: Math.floor(stat.mtimeMs) };
      if (stat.birthtimeMs > 0) f.birth = Math.floor(stat.birthtimeMs);
      if (stat.ctimeMs > 0) f.ctime = Math.floor(stat.ctimeMs);
      if (this.start !== undefined) f.firstTs = this.start;
      if (this.end !== undefined) f.lastTs = this.end;
      this.out(f);
    }
  }

  /**
   * A subagent's file is a subagent session; a session with a human prompt is human. Without one, only positive evidence
   * makes it non-human — a prompt of another origin (the strongest of them), or an SDK entrypoint; a session whose
   * prompts could not be read (no evidence at all) stays human, so a format change never turns a person's work scripted.
   */
  private origin(): Origin {
    if (this.spec.sub) return "subagent";
    if (this.humanPrompts > 0) return "human";
    return NON_HUMAN.find((o) => this.nonHuman.has(o)) ?? (this.sdk ? "scripted" : "human");
  }

  private session(start: number, end: number): SessionEv {
    const { spec } = this;
    const s: SessionEv = {
      k: "session", tool: TOOL, source: TRANSCRIPTS_SOURCE, id: spec.sessionId, window: "detail", origin: this.origin(), start, end,
      models: [...this.models],
    };
    if (spec.parentId !== undefined) s.parentId = spec.parentId;
    if (this.cwd !== undefined) s.projectKey = this.ctx.registerCwd(this.cwd);
    if (this.surface !== undefined) s.surface = this.surface;
    if (this.version !== undefined) s.version = this.version;
    const m = spec.meta;
    if (m) {
      if (m.spawnDepth !== undefined) s.spawnDepth = m.spawnDepth;
      if (m.agentType !== undefined) s.agentType = (m.isBuiltIn ?? BUILTIN_AGENTS.has(m.agentType)) ? m.agentType : this.ctx.hash(m.agentType);
      if (m.background !== undefined) s.background = m.background;
      if (s.models.length === 0 && m.model !== undefined && m.model !== "inherit") s.models = [safeModel(m.model)];
    }
    if (spec.workflowId !== undefined) s.workflowId = spec.workflowId;
    return s;
  }
}

async function scanFile(spec: FileSpec, ctx: ScanCtx, tally: CcTally, delegations: ReadonlyMap<string, string>): Promise<void> {
  const st = safeStat(spec.file);
  if (!st?.isFile()) return;
  const reader = new TranscriptReader(spec, ctx, tally, delegations);
  let complete = true;
  try {
    for await (const item of readJsonl(spec.file, { sniffSkip: sniffHeavy, signal: ctx.signal })) {
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
    ctx.log("warn", "cc.io-error");
  }
  if (ctx.signal.aborted) complete = false;
  if (complete) {
    tally.files++;
    tally.bytes += st.size;
  }
  reader.finish(complete ? st : undefined);
}

const agentFiles = (dir: string, tally: Tally): string[] =>
  listDir(dir, tally).filter((f) => /^agent-[^\\/]+\.jsonl$/.test(f) && safeStat(path.join(dir, f))?.isFile());

/**
 * One session: its top-level transcript, every subagent and workflow-agent transcript, and its workflow summaries.
 * Ids: `claude-code:<session>`, `…/<agent>` and `…/<wf_run>/<agent>`, each part verbatim only when CLI-shaped, else hashed.
 */
async function scanSession(projDir: string, stem: string, ctx: ScanCtx, tally: CcTally): Promise<void> {
  const session = idPart(stem, UUID, ctx);
  const parentId = sid(TOOL, session);
  const dir = path.join(projDir, stem);
  const subDir = path.join(dir, "subagents");
  const wfRoot = path.join(subDir, "workflows");
  const agent = (f: string) => idPart(f.slice(0, -6), AGENT_STEM, ctx);
  const subs: { file: string; id: string; workflowId?: string }[] = agentFiles(subDir, tally)
    .map((f) => ({ file: path.join(subDir, f), id: sid(TOOL, `${session}/${agent(f)}`) }));
  for (const wf of listDir(wfRoot, tally)) {
    if (!wf.startsWith("wf_") || !safeStat(path.join(wfRoot, wf))?.isDirectory()) continue;
    const run = idPart(wf, WORKFLOW_DIR, ctx);
    const workflowId = ctx.hash(wf);
    for (const f of agentFiles(path.join(wfRoot, wf), tally)) subs.push({ file: path.join(wfRoot, wf, f), id: sid(TOOL, `${session}/${run}/${agent(f)}`), workflowId });
  }

  // meta files first: the parent's Agent/Task tool events need the delegation links when they are emitted
  const delegations = new Map<string, string>();
  const specs: FileSpec[] = subs.map((s) => {
    const meta = readMeta(s.file.replace(/\.jsonl$/, ".meta.json"), tally);
    if (meta?.toolUseId !== undefined) delegations.set(meta.toolUseId, s.id);
    const spec: FileSpec = { file: s.file, sessionId: s.id, sub: true, parentId };
    if (meta) spec.meta = meta;
    if (s.workflowId !== undefined) spec.workflowId = s.workflowId;
    return spec;
  });

  await scanFile({ file: path.join(projDir, `${stem}.jsonl`), sessionId: parentId, sub: false, stem }, ctx, tally, delegations);
  for (const spec of specs) {
    if (ctx.signal.aborted) return;
    await scanFile(spec, ctx, tally, delegations);
  }

  const wfDir = path.join(dir, "workflows");
  for (const name of listDir(wfDir, tally)) {
    if (!name.endsWith(".json")) continue;
    const v = readSidecar(path.join(wfDir, name), tally);
    const ms = num(v?.durationMs);
    if (ms === undefined || ms < 0) continue;
    ctx.emit({ k: "totals", tool: TOOL, source: TRANSCRIPTS_SOURCE, sessionId: sid(TOOL, `wf:${ctx.hash(name.slice(0, -5))}`), ms });
  }
}

function retentionDays(root: string): number {
  const settings = readJsonSmall(path.join(root, "settings.json"));
  const days = isObj(settings) ? num(settings.cleanupPeriodDays) : undefined;
  return days !== undefined && days >= 0 ? days : DEFAULT_RETENTION_DAYS;
}

/** Scan one Claude Code root (`$CLAUDE_CONFIG_DIR` or `~/.claude`); emits exactly one CoverageEv, last. */
export async function scanTranscripts(c: Candidate, ctx: ScanCtx): Promise<void> {
  const tally = new CcTally();
  const projects = path.join(c.root, "projects");
  let names: string[] = [];
  try {
    names = readdirSync(projects).sort();
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw e; // an unreadable projects folder makes the source meaningless
  }
  for (const name of names) {
    if (ctx.signal.aborted) break;
    const projDir = path.join(projects, name);
    if (!safeStat(projDir)?.isDirectory()) continue;
    const sessions = new Set<string>();
    for (const entry of listDir(projDir, tally)) {
      const st = safeStat(path.join(projDir, entry));
      if (st?.isFile() && entry.endsWith(".jsonl")) sessions.add(entry.slice(0, -6));
      else if (st?.isDirectory()) sessions.add(entry);
    }
    for (const stem of [...sessions].sort()) {
      if (ctx.signal.aborted) break;
      await scanSession(projDir, stem, ctx, tally);
    }
  }
  if (tally.heavyParsed > 0) ctx.log("debug", "cc.heavy-parsed", tally.heavyParsed);
  if (tally.foreignSessionFiles > 0) ctx.log("debug", "cc.foreign-session-files", tally.foreignSessionFiles);
  const bad = tally.skipped["bad-record"] ?? 0;
  if (bad > 0) ctx.log("warn", "cc.bad-record", bad); // a mapping bug must not look like a healthy source
  ctx.emit(tally.coverage(retentionDays(c.root)));
}
