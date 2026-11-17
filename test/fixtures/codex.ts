// Synthetic Codex rollouts. Record, payload and field names mirror the CLI's own rollout schema (0.169.x); every value is invented.
import { CANARY } from "../kit/canary";
import type { FakeHome } from "../kit/home";
import { fixtureStart, iso } from "./claude-code";

export const CX_MAX = "gpt-5.1-codex-max";
export const CX_MINI = "gpt-5.1-codex-mini";
export const CX_VERSION = "0.169.0";

const pad = (n: number): string => String(n).padStart(2, "0");
const secs = (ms: number): number => Math.floor(ms / 1000);

/** A UUIDv7 whose 48-bit time prefix is `ms`; `n` keeps ids apart. */
export function uuidV7(ms: number, n: number): string {
  const t = ms.toString(16).padStart(12, "0");
  return `${t.slice(0, 8)}-${t.slice(8, 12)}-7abc-8def-${n.toString(16).padStart(12, "0").slice(-12)}`;
}

/** Home-relative path of the rollout the CLI writes for a thread created at local wall-clock time `ms`. */
export function rolloutRel(ms: number, id: string, dir = "sessions", base = ".codex"): string {
  const d = new Date(ms);
  const [y, m, day] = [d.getFullYear(), pad(d.getMonth() + 1), pad(d.getDate())];
  return `${base}/${dir}/${y}/${m}/${day}/rollout-${y}-${m}-${day}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}-${id}.jsonl`;
}

/** `rate_limits` as token_count events carry them; `secondary` is null when that window is not reported. */
export function rateLimits(at: number, primary: number, secondary?: number): Record<string, unknown> {
  return {
    limit_id: "codex", limit_name: null, individual_limit: null, rate_limit_reached_type: null, spend_control_reached: null, plan_type: "pro",
    credits: { has_credits: false, unlimited: false, balance: "0" },
    primary: { used_percent: primary, window_minutes: 300, resets_at: secs(at + 2 * 3_600_000) },
    secondary: secondary === undefined ? null : { used_percent: secondary, window_minutes: 10_080, resets_at: secs(at + 5 * 86_400_000) },
  };
}

/** A unified diff with 4 added and 2 removed lines. */
export const DIFF_4_2 = [
  "@@ -1,3 +1,5 @@",
  " export function importer(input: string) {",
  "-  return parse(input);",
  "-}",
  "+  if (input.trim() === \"\") throw new Error(\"empty input\");",
  "+  const rows = parse(input);",
  "+  return rows;",
  "+}",
].join("\n") + "\n";

export interface CxMeta { source?: unknown; originator?: string; cwd?: string; version?: string; git?: boolean; extra?: Record<string, unknown> }
export type Part = string | { image: true };
export const IMAGE: Part = { image: true };

/**
 * Builds one rollout record by record with a running clock (1 s between records by default) and the CLI's line shape
 * `{timestamp, ordinal, type, payload}`. `heavy` counts the lines the reader is expected to drop before parsing.
 */
export class CxRollout {
  readonly records: Record<string, unknown>[] = [];
  t: number;
  heavy = 0;
  private ordinal = 0;
  private seq = 0;
  private turnId = "turn-0";
  private readonly total = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };

  /** `fileTs`: the local time in the file name (the thread id's embedded time is one second earlier by default). */
  constructor(readonly fileTs: number, readonly id: string, readonly m: CxMeta = {}) {
    this.t = fileTs;
  }

  rec(type: string, payload: unknown, dt = 1_000): this {
    this.t += dt;
    this.records.push({ timestamp: iso(this.t), ordinal: this.ordinal++, type, payload });
    return this;
  }

  /** A record the reader must drop from its first bytes. */
  heavyRec(type: string, payload: unknown, dt?: number): this {
    this.heavy++;
    return this.rec(type, payload, dt);
  }

  event(type: string, fields: Record<string, unknown> = {}, dt?: number): this {
    return this.rec("event_msg", { type, ...fields }, dt);
  }

  item(type: string, fields: Record<string, unknown> = {}, dt?: number): this {
    return this.rec("response_item", { type, ...fields }, dt);
  }

  get nextOrdinal(): number {
    return this.ordinal;
  }

  metaPayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
    const m = this.m;
    return {
      session_id: this.id, id: this.id, timestamp: iso(this.t), cwd: m.cwd ?? CANARY.path, originator: m.originator ?? "codex_cli_rs",
      cli_version: m.version ?? CX_VERSION, source: m.source ?? "cli", thread_source: "user", model_provider: "openai", history_mode: "full",
      base_instructions: { text: `You are a coding agent. ${CANARY.code}`, provenance: { type: "model", model: CX_MAX } },
      ...(m.git !== false && { git: { commit_hash: "a1b2c3d", branch: "main", repository_url: `https://${CANARY.host}/${CANARY.project}.git` } }),
      ...m.extra, ...extra,
    };
  }

  meta(extra: Record<string, unknown> = {}): this {
    return this.rec("session_meta", this.metaPayload(extra), 0);
  }

  /** turn_context, then task_started. */
  turn(turnId: string, model = CX_MAX, effort: unknown = "high"): this {
    this.turnId = turnId;
    return this.rec("turn_context", {
      turn_id: turnId, root_turn_id: turnId, cwd: this.m.cwd ?? CANARY.path, approval_policy: "on-request",
      sandbox_policy: { type: "workspace-write", network_access: false }, model, effort, summary: "auto",
      collaboration_mode: { mode: "default", settings: { model, reasoning_effort: effort, developer_instructions: CANARY.prompt } },
    }).event("task_started", { turn_id: turnId, started_at: secs(this.t), model_context_window: 272_000 });
  }

  done(turnId: string, durationMs?: number): this {
    return this.event("task_complete", { turn_id: turnId, last_agent_message: CANARY.prompt, completed_at: secs(this.t), ...(durationMs !== undefined && { duration_ms: durationMs }) });
  }

  aborted(turnId: string, reason = "interrupted", durationMs?: number): this {
    return this.event("turn_aborted", { turn_id: turnId, reason, ...(durationMs !== undefined && { duration_ms: durationMs }) });
  }

  /** A user-role message; strings become input_text parts, `IMAGE` an input_image part. */
  user(...parts: Part[]): this {
    const content = parts.map((p) => (typeof p === "string" ? { type: "input_text", text: p } : { type: "input_image", image_url: `data:image/png;base64,${CANARY.secret}` }));
    return this.item("message", { id: `msg_${++this.seq}`, role: "user", content });
  }

  developer(text: string): this {
    this.heavy++;
    return this.item("message", { id: `msg_${++this.seq}`, role: "developer", content: [{ type: "input_text", text }] });
  }

  assistant(text: string): this {
    this.heavy++;
    return this.item("message", { id: `msg_${++this.seq}`, role: "assistant", content: [{ type: "output_text", text }], phase: "final_answer" });
  }

  reasoning(): this {
    this.heavy++;
    return this.item("reasoning", { id: `rs_${++this.seq}`, summary: [], encrypted_content: CANARY.secret });
  }

  /** The client's own copy of a user input (an item_completed UserMessage). */
  userItem(text: string): this {
    this.heavy++;
    return this.event("item_completed", { thread_id: this.id, turn_id: this.turnId, item: { type: "UserMessage", id: `u-${++this.seq}`, content: [{ type: "text", text, text_elements: [] }] } });
  }

  /** A Code Mode cell: a custom `exec` tool call whose input is JavaScript; returns its call id. */
  cell(js: string): string {
    const callId = `call_${++this.seq}`;
    this.item("custom_tool_call", { id: `ctc_${this.seq}`, status: "completed", call_id: callId, name: "exec", input: js });
    return callId;
  }

  cellOutput(callId: string, text: string = CANARY.code): this {
    this.heavy++;
    return this.item("custom_tool_call_output", { id: `ctco_${++this.seq}`, call_id: callId, output: [{ type: "input_text", text }] });
  }

  custom(name: string, input: string, callId = `call_${++this.seq}`): string {
    this.item("custom_tool_call", { id: `ctc_${this.seq}`, status: "completed", call_id: callId, name, input });
    return callId;
  }

  /** A function call; returns its call id. */
  fn(name: string, args: unknown, o: { namespace?: string; callId?: string } = {}): string {
    const callId = o.callId ?? `call_${++this.seq}`;
    this.item("function_call", { id: `fc_${this.seq}`, status: "completed", name, ...(o.namespace !== undefined && { namespace: o.namespace }), arguments: JSON.stringify(args), call_id: callId });
    return callId;
  }

  fnOutput(callId: string, output: string = CANARY.code): this {
    this.heavy++;
    return this.item("function_call_output", { id: `fco_${++this.seq}`, call_id: callId, output });
  }

  /** An item_completed record around `item`, timed like the CLI writes it. */
  completed(item: Record<string, unknown>, startedAt = this.t + 500, durationMs = 1_000): this {
    return this.event("item_completed", { thread_id: this.id, turn_id: this.turnId, started_at_ms: startedAt, completed_at_ms: startedAt + durationMs, item });
  }

  /** A finished command, as Code Mode and exec_command record it (item_completed CommandExecution). */
  command(cmd: string, exit: number, o: { secs?: number; parsed?: unknown[]; id?: string; source?: string; startedAt?: number } = {}): this {
    const ms = Math.round((o.secs ?? 1) * 1000);
    return this.completed({
      type: "CommandExecution", id: o.id ?? `exec-${++this.seq}`, process_id: "4242", command: ["/bin/zsh", "-lc", cmd], cwd: this.m.cwd ?? CANARY.path,
      parsed_cmd: o.parsed ?? [{ type: "unknown", cmd }], source: o.source ?? "unified_exec_startup", aggregated_output: `${CANARY.secret}\n${CANARY.code}`,
      exit_code: exit, duration: { secs: Math.floor(ms / 1000), nanos: (ms % 1000) * 1_000_000 }, status: exit === 0 ? "completed" : "failed",
    }, o.startedAt ?? this.t + 500, ms);
  }

  fileChange(changes: Record<string, unknown>, o: { id?: string; status?: string } = {}): this {
    return this.completed({ type: "FileChange", id: o.id ?? `patch-${++this.seq}`, changes, status: o.status ?? "completed" });
  }

  /** A token_count event; totals accumulate like the CLI's thread totals. */
  tokens(last: { input: number; cached: number; output: number }, rate: Record<string, unknown> | null = null): this {
    const usage = { input_tokens: last.input, cached_input_tokens: last.cached, cache_write_input_tokens: 0, output_tokens: last.output, reasoning_output_tokens: Math.floor(last.output / 3), total_tokens: last.input + last.output };
    for (const k of Object.keys(this.total) as (keyof typeof this.total)[]) this.total[k] += usage[k];
    return this.event("token_count", { info: { total_token_usage: { ...this.total }, last_token_usage: usage, model_context_window: 272_000 }, rate_limits: rate });
  }

  /** The previous record again, as the CLI re-emits an unchanged token_count. */
  repeatLast(dt = 200): this {
    const last = this.records[this.records.length - 1]!;
    return this.rec(last.type as string, structuredClone(last.payload), dt);
  }

  write(h: FakeHome, dir = "sessions", base = ".codex"): string {
    return h.writeJsonl(rolloutRel(this.fileTs, this.id, dir, base), this.records);
  }
}

export interface CxFixture {
  r1: CxRollout;
  r2: CxRollout;
  r3: CxRollout;
  r4: CxRollout;
  /** Absolute paths of the four rollouts. */
  files: string[];
  /** Lines written across the four rollouts, and the heavy lines among them. */
  lines: number;
  heavy: number;
}

/**
 * Task 11 scenario. R1 cli (cwd = CANARY.path): injected AGENTS.md + <environment_context>, <environment_context> and
 * <recommended_plugins> user messages; 2 human prompts (one with CANARY.prompt); Code Mode cells running `bun test` (exit 1,
 * then exit 0) and an apply_patch (+4/−2 on src/x.ts); 2 token_counts with rate limits plus a re-emitted copy; a spawn_agent
 * call whose output names R3; turn_aborted; task_complete; compacted; one event_msg of an unknown type. R2 `codex exec`:
 * one prompt and an exec_command `npm run build`. R3: subagent of R1 whose rollout starts with history copied from R1
 * (a session_meta, a prompt, a failing `bun test`, an abort, usage) before its own work (`rg`). R4: driven by Claude Code,
 * one prompt. Thread ids are UUIDv7 values whose embedded time is 1 s before the file-name time.
 */
export function buildCodexRollouts(h: FakeHome): CxFixture {
  const t0 = fixtureStart();
  const [t2, t3, t4] = [t0 + 2 * 3_600_000, t0 + 3 * 60_000, t0 + 4 * 3_600_000];
  const ids = { r1: uuidV7(t0 - 1000, 0x11), r2: uuidV7(t2 - 1000, 0x22), r3: uuidV7(t3 - 1000, 0x33), r4: uuidV7(t4 - 1000, 0x44) };
  const envContext = (cwd: string) => `<environment_context>\n  <cwd>${cwd}</cwd>\n  <shell>zsh</shell>\n</environment_context>`;
  const plugins = `<recommended_plugins>\n- ${CANARY.project}\n</recommended_plugins>`;

  const r1 = new CxRollout(t0, ids.r1, { source: "cli" });
  r1.meta()
    .heavyRec("world_state", { full: true, state: { agents_md: { directory: CANARY.path, text: CANARY.prompt } } })
    .turn("turn-1", CX_MAX, "high")
    .developer(`<permissions instructions>${CANARY.secret}</permissions instructions>`)
    .user(`# AGENTS.md instructions for ${CANARY.path}\n\n<INSTRUCTIONS>\n${CANARY.prompt}\n</INSTRUCTIONS>`, envContext(CANARY.path))
    .user(envContext(CANARY.path))
    .user(plugins)
    .user(`Fix the importer so it rejects empty input. ${CANARY.prompt}`)
    .userItem(CANARY.prompt)
    .reasoning();
  const c1 = r1.cell(`const r = await tools.exec_command({ cmd: "bun test" });\ntext(r.output);`);
  r1.command("bun test", 1, { secs: 2.5 }).cellOutput(c1)
    .tokens({ input: 12_000, cached: 8_000, output: 900 }, rateLimits(t0, 10, 2));
  const c2 = r1.cell(`await tools.apply_patch(${JSON.stringify(`*** Begin Patch\n*** Update File: src/x.ts\n@@\n-${CANARY.code}\n*** End Patch`)});`);
  r1.fileChange({ [`${CANARY.path}/src/x.ts`]: { type: "update", unified_diff: DIFF_4_2, move_path: null } }).cellOutput(c2);
  const c3 = r1.cell(`const r = await tools.exec_command({ cmd: "bun test" });`);
  r1.command("bun test", 0, { secs: 3 }).cellOutput(c3)
    .tokens({ input: 14_000, cached: 12_000, output: 400 }, rateLimits(t0, 11, 2))
    .repeatLast()
    .assistant(`Done. ${CANARY.prompt}`)
    .done("turn-1", 61_000)
    .turn("turn-2", CX_MAX, "xhigh")
    .user("Why does the importer reject empty input?");
  const s1 = r1.fn("spawn_agent", { message: CANARY.prompt, agent_type: "explorer" }, { namespace: "collaboration" });
  r1.heavyRec("event_msg", { type: "item_completed", thread_id: ids.r1, turn_id: "turn-2", item: { type: "SubAgentActivity", id: s1, kind: "started", agent_thread_id: ids.r3, agent_path: "/root/explorer_1" } })
    .fnOutput(s1, JSON.stringify({ agent_id: ids.r3, nickname: CANARY.project }))
    .aborted("turn-2", "interrupted", 9_000)
    .user("<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>")
    .rec("compacted", { message: "", replacement_history: [{ type: "message", role: "user", content: [{ type: "input_text", text: CANARY.prompt }] }], window_number: 1 })
    .event("brand_new_event", { detail: CANARY.token })
    .rec("inter_agent_communication_metadata", { trigger_turn: false });

  const r2 = new CxRollout(t2, ids.r2, { source: "exec", originator: "codex_exec", cwd: "/work/projB", version: "0.168.0", git: false });
  r2.meta().turn("turn-1", CX_MINI, "low")
    .user(plugins, envContext("/work/projB"))
    .user("Build the project and report any errors.");
  const b1 = r2.fn("exec_command", { cmd: "npm run build", workdir: "/work/projB", yield_time_ms: 10_000 });
  r2.command("npm run build", 0, { secs: 12, id: b1 }).fnOutput(b1, "ok")
    .tokens({ input: 3_000, cached: 0, output: 200 }, rateLimits(t2, 20))
    .done("turn-1", 15_000);

  const spawn = { parent_thread_id: ids.r1, depth: 1, agent_path: "/root/explorer_1", agent_nickname: CANARY.project, agent_role: "explorer" };
  const r3 = new CxRollout(t3, ids.r3, {
    source: { subagent: { thread_spawn: spawn } },
    extra: { forked_from_id: ids.r1, parent_thread_id: ids.r1, agent_nickname: CANARY.project, agent_path: "/root/explorer_1", multi_agent_version: "v2" },
  });
  r3.meta();
  // history copied from the parent: ordinals below subagent_history_start_ordinal
  r3.rec("session_meta", { ...r1.metaPayload(), source: "cli" })
    .turn("turn-1", "gpt-5.0-codex", "high")
    .user("Fix the importer so it rejects empty input.");
  const inheritedCell = r3.cell(`await tools.exec_command({ cmd: "bun test" });`);
  r3.command("bun test", 1).cellOutput(inheritedCell)
    .tokens({ input: 9_000, cached: 1_000, output: 100 }, rateLimits(t3, 40))
    .aborted("turn-1", "interrupted", 1_000);
  (r3.records[0]!.payload as Record<string, unknown>).subagent_history_start_ordinal = r3.nextOrdinal;
  r3.turn("turn-9", CX_MINI, "medium")
    .user(envContext(CANARY.path))
    .heavyRec("response_item", { type: "agent_message", id: "am_1", author: "/root", recipient: "/root/explorer_1", content: [{ type: "input_text", text: CANARY.prompt }] })
    .user("Look into the importer and report where empty input is handled.");
  const e1 = r3.cell(`await tools.exec_command({ cmd: "rg -n importer src" });`);
  r3.command("rg -n importer src", 0, { parsed: [{ type: "search", cmd: "rg -n importer src", query: "importer", path: "src" }] }).cellOutput(e1)
    .tokens({ input: 5_000, cached: 4_000, output: 300 }, rateLimits(t3, 41))
    .done("turn-9", 20_000);

  const r4 = new CxRollout(t4, ids.r4, { source: "vscode", originator: "Claude Code", cwd: "/work/projC" });
  r4.meta().turn("turn-1", CX_MAX, "medium")
    .user(envContext("/work/projC"))
    .user("Review the staged diff for bugs.")
    .done("turn-1", 5_000);

  const all = [r1, r2, r3, r4];
  return {
    r1, r2, r3, r4,
    files: all.map((r) => r.write(h)),
    lines: all.reduce((n, r) => n + r.records.length, 0),
    heavy: all.reduce((n, r) => n + r.heavy, 0),
  };
}

// ---- Task 12: thread index (state_N.sqlite), turn history (thread_history_N.sqlite), history.jsonl, config ----

/** The `threads` columns of state_5.sqlite in table order (names verified locally; types per the CLI program's DDL). */
export const THREAD_COLUMNS = [
  "id", "rollout_path", "created_at", "updated_at", "source", "model_provider", "cwd", "title", "sandbox_policy", "approval_mode",
  "tokens_used", "has_user_event", "archived", "archived_at", "git_sha", "git_branch", "git_origin_url", "cli_version",
  "first_user_message", "agent_nickname", "agent_role", "memory_mode", "model", "reasoning_effort", "agent_path",
  "created_at_ms", "updated_at_ms", "thread_source", "preview", "recency_at", "recency_at_ms", "history_mode", "name",
  "is_pinned", "thread_section_id", "section_position", "section_entered_at_ms", "project_id", "originator",
  "daybreak_enabled", "creator_user_id", "creator_account_id", "attached_thread_parent_id",
] as const;
export type ThreadColumn = (typeof THREAD_COLUMNS)[number];
export type ThreadRow = Partial<Record<ThreadColumn, unknown>>;
const INTEGER_COLUMNS = new Set<string>([
  "created_at", "updated_at", "tokens_used", "has_user_event", "archived", "archived_at", "created_at_ms", "updated_at_ms",
  "recency_at", "recency_at_ms", "is_pinned", "section_position", "section_entered_at_ms", "daybreak_enabled",
]);

/** The `thread_turns` columns of thread_history_1.sqlite in table order. */
export const TURN_COLUMNS = [
  "thread_id", "turn_id", "rollout_ordinal", "status", "error_json", "started_at", "completed_at", "duration_ms",
  "first_user_item_id", "final_agent_item_id", "rollout_byte_offset", "rollout_end_ordinal", "rollout_end_byte_offset", "root_turn_id",
] as const;
export type TurnRow = Partial<Record<(typeof TURN_COLUMNS)[number], unknown>>;

/** A sandbox policy as the CLI stores it: JSON whose writable roots and file-system entries hold paths. */
export const MANAGED_SANDBOX = JSON.stringify({
  type: "managed", file_system: { type: "restricted", entries: [{ access: "write", path: { type: "literal", value: { path: CANARY.path } } }] }, network: "enabled",
});

/**
 * One `threads` row as the CLI writes it. Every text column the reader must never select holds a canary: the first
 * message, title, preview, name, nickname, rollout and agent paths, git branch and remote, creator ids.
 */
export function threadRow(id: string, createdMs: number, o: ThreadRow = {}): ThreadRow {
  const updatedMs = createdMs + 30 * 60_000;
  return {
    id, rollout_path: `${CANARY.path}/.codex/sessions/rollout-${id}.jsonl`, created_at: secs(createdMs), updated_at: secs(updatedMs), source: "cli",
    model_provider: "openai", cwd: CANARY.path, title: CANARY.project, sandbox_policy: MANAGED_SANDBOX, approval_mode: "on-request",
    tokens_used: 123_456, has_user_event: 0, archived: 0, archived_at: null, git_sha: "a1b2c3d", git_branch: CANARY.project,
    git_origin_url: `https://${CANARY.host}/${CANARY.project}.git`, cli_version: CX_VERSION, first_user_message: CANARY.prompt,
    agent_nickname: null, agent_role: null, memory_mode: "enabled", model: CX_MAX, reasoning_effort: "high", agent_path: null,
    created_at_ms: createdMs, updated_at_ms: updatedMs, thread_source: "user", preview: CANARY.prompt, recency_at: secs(updatedMs),
    recency_at_ms: updatedMs, history_mode: "paginated", name: CANARY.project, is_pinned: 0, thread_section_id: null,
    section_position: null, section_entered_at_ms: null, project_id: null, originator: "codex-tui", daybreak_enabled: null,
    creator_user_id: CANARY.email, creator_account_id: CANARY.token, attached_thread_parent_id: null,
    ...o,
  };
}

/** One `thread_turns` row; `startedS`/`completedS` in epoch seconds, as the CLI stores them. */
export function turnRow(threadId: string, turnId: string, status: unknown, startedS: number | null, completedS: number | null, durationMs: number | null, o: TurnRow = {}): TurnRow {
  return {
    thread_id: threadId, turn_id: turnId, rollout_ordinal: 0, status, error_json: status === "failed" ? JSON.stringify({ message: CANARY.secret }) : null,
    started_at: startedS, completed_at: completedS, duration_ms: durationMs, first_user_item_id: `item-${CANARY.project}`, final_agent_item_id: null,
    rollout_byte_offset: 0, rollout_end_ordinal: null, rollout_end_byte_offset: null, root_turn_id: turnId, ...o,
  };
}

const ddl = (table: string, columns: readonly string[], types: (c: string) => string, extra = ""): string =>
  `CREATE TABLE ${table} (${columns.map((c) => `${c} ${types(c)}`).join(", ")}${extra})`;

/** A state_N.sqlite with `threads` (only `columns`, in this order), `thread_spawn_edges`, and tables the reader never reads. */
export function writeStateDb(h: FakeHome, rel: string, threads: ThreadRow[], edges: [string, string, string][] = [], o: { columns?: readonly string[]; noEdgesTable?: boolean; extraDdl?: string[] } = {}): string {
  const columns = o.columns ?? THREAD_COLUMNS;
  const statements = [
    "CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY, description TEXT NOT NULL, installed_on TIMESTAMP, success BOOLEAN NOT NULL, checksum BLOB NOT NULL, execution_time BIGINT NOT NULL)",
    ddl("threads", columns, (c) => (c === "id" ? "TEXT PRIMARY KEY" : INTEGER_COLUMNS.has(c) ? "INTEGER" : "TEXT")),
    ...(o.noEdgesTable ? [] : ["CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL PRIMARY KEY, status TEXT NOT NULL)"]),
    "CREATE TABLE thread_dynamic_tools (thread_id TEXT NOT NULL, position INTEGER NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, input_schema TEXT NOT NULL, defer_loading INTEGER, namespace TEXT)",
    ...(o.extraDdl ?? []),
  ];
  const rows: Record<string, unknown[][]> = {
    threads: threads.map((t) => columns.map((c) => t[c as ThreadColumn] ?? null)),
    thread_dynamic_tools: [[threads[0]?.id ?? "t", 0, CANARY.project, CANARY.prompt, `{"secret":"${CANARY.secret}"}`, 0, null]],
  };
  if (!o.noEdgesTable) rows.thread_spawn_edges = edges;
  return h.sqlite(rel, statements, rows);
}

/** A thread_history_N.sqlite with `thread_turns` and `thread_items` (whose item JSON the reader never reads). */
export function writeTurnsDb(h: FakeHome, rel: string, turns: TurnRow[], o: { columns?: readonly string[] } = {}): string {
  const columns = o.columns ?? TURN_COLUMNS;
  const int = new Set(["rollout_ordinal", "started_at", "completed_at", "duration_ms", "rollout_byte_offset", "rollout_end_ordinal", "rollout_end_byte_offset"]);
  return h.sqlite(rel, [
    ddl("thread_turns", columns, (c) => (int.has(c) ? "INTEGER" : "TEXT"), columns.includes("turn_id") ? ", PRIMARY KEY (thread_id, turn_id)" : ""),
    "CREATE TABLE thread_items (thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL, rollout_ordinal INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, item_json TEXT NOT NULL, item_type TEXT, PRIMARY KEY (thread_id, turn_id, item_id))",
  ], {
    thread_turns: turns.map((t) => columns.map((c) => t[c as keyof TurnRow] ?? null)),
    thread_items: [[turns[0]?.thread_id ?? "t", "turn-1", "item-1", 0, 0, JSON.stringify({ type: "UserMessage", text: CANARY.prompt }), "UserMessage"]],
  });
}

/** One history.jsonl line as the CLI writes it: `ts` in epoch seconds. */
export function cxHistoryLine(text: string, tsMs: number, sessionId?: string): Record<string, unknown> {
  return { ...(sessionId !== undefined && { session_id: sessionId }), ts: secs(tsMs), text };
}

/** Epoch ms of a local wall-clock time `daysAgo` days before today (process time zone). */
export function localTime(daysAgo: number, hh: number, mm = 0): number {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysAgo, hh, mm).getTime();
}

export interface CxIndexFixture {
  ids: { cli: string; exec: string; sub: string };
  /** Creation and last-update times (epoch ms) per thread. */
  created: { cli: number; exec: number; sub: number };
  updated: { cli: number; exec: number; sub: number };
  /** The four turns, in table order: thread key, status, completion time (ms) and duration. */
  turns: { thread: "cli" | "exec" | "sub"; status: "completed" | "failed" | "interrupted"; ts: number; ms: number }[];
  /** Times (ms) of the history lines in file order, and prompts per local day. */
  historyTs: number[];
  days: [string, number][];
  /** Absolute paths of the files the readers should read. */
  files: { state: string; turns: string; history: string; config: string };
}

/**
 * Task 12 scenario. state_5.sqlite: three threads — `cli` (in a repo, cwd CANARY.path), `exec` (no repo, /work/projB) and a
 * subagent spawned by `cli` (role explorer) — whose text columns hold canaries (first message CANARY.prompt, title
 * CANARY.project, …); one spawn edge. An older state_4.sqlite with a fourth thread must be ignored. thread_history_1.sqlite:
 * four turns (2 completed, 1 failed, 1 interrupted). history.jsonl: five prompts over two local days. config.toml: two
 * profiles (one with a sub-table), an MCP server CANARY.mcp whose body holds CANARY.secret, a plugin, a project table keyed
 * by CANARY.path. skills/: one skill (plus bundled ones under .system); plugins/cache: two plugins; memories/: two files.
 */
export function buildCodexIndex(h: FakeHome): CxIndexFixture {
  const t0 = fixtureStart();
  // thread times carry milliseconds (the `_ms` columns keep them, the seconds columns do not); turn times are whole seconds
  const created = { cli: t0 + 123, exec: t0 + 60 * 60_000 + 456, sub: t0 + 5 * 60_000 + 789 };
  const updated = { cli: t0 + 40 * 60_000 + 321, exec: t0 + 62 * 60_000 + 654, sub: t0 + 15 * 60_000 + 987 };
  const ids = { cli: uuidV7(created.cli - 1000, 0xa1), exec: uuidV7(created.exec - 1000, 0xa2), sub: uuidV7(created.sub - 1000, 0xa3) };
  const spawn = { subagent: { thread_spawn: { parent_thread_id: ids.cli, depth: 1, agent_path: "/root/explorer_1", agent_nickname: CANARY.project, agent_role: "explorer" } } };
  const at = (k: keyof typeof ids, extra: ThreadRow) => threadRow(ids[k], created[k], { updated_at: secs(updated[k]), updated_at_ms: updated[k], ...extra });
  const state = writeStateDb(h, ".codex/state_5.sqlite", [
    at("cli", {}),
    at("exec", {
      source: "exec", originator: "codex_exec", cwd: "/work/projB", git_sha: null, git_branch: null, git_origin_url: null, model: CX_MINI,
      reasoning_effort: "low", approval_mode: "never", sandbox_policy: JSON.stringify({ type: "disabled" }), cli_version: "0.168.0",
    }),
    at("sub", { source: JSON.stringify(spawn), thread_source: "subagent", agent_nickname: CANARY.project, agent_role: "explorer", agent_path: CANARY.path }),
  ], [[ids.cli, ids.sub, "open"]]);
  writeStateDb(h, ".codex/state_4.sqlite", [threadRow(uuidV7(t0 - 86_400_000, 0xa4), t0 - 86_400_000)]);

  const turns: CxIndexFixture["turns"] = [
    { thread: "cli", status: "completed", ts: t0 + 2 * 60_000, ms: 61_000 },
    { thread: "cli", status: "interrupted", ts: t0 + 10 * 60_000, ms: 9_000 },
    { thread: "exec", status: "failed", ts: t0 + 61 * 60_000, ms: 15_000 },
    { thread: "sub", status: "completed", ts: t0 + 10 * 60_000 + 5_000, ms: 20_000 },
  ];
  const turnsFile = writeTurnsDb(h, ".codex/thread_history_1.sqlite", turns.map((t, i) =>
    turnRow(ids[t.thread], `turn-${i + 1}`, t.status, secs(t.ts - t.ms), secs(t.ts), t.ms, { rollout_ordinal: i })));

  const historyTs = [localTime(3, 10), localTime(3, 11), localTime(2, 9), localTime(2, 9, 10), localTime(2, 9, 20)];
  const history = h.writeJsonl(".codex/history.jsonl", [
    cxHistoryLine(`Fix the importer so it rejects empty input. ${CANARY.prompt}`, historyTs[0]!, ids.cli),
    cxHistoryLine("Why does the importer reject empty input?", historyTs[1]!, ids.cli),
    cxHistoryLine("Add pagination to the list endpoint", historyTs[2]!, ids.exec),
    cxHistoryLine("Does it handle the last page?", historyTs[3]!, ids.exec),
    cxHistoryLine("ok ship it", historyTs[4]!, ids.exec),
  ]);
  const day = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

  const config = h.write(".codex/config.toml", [
    "# Codex configuration",
    `model = "${CX_MAX}"`,
    'model_reasoning_effort = "high"',
    "",
    "[profiles.fast]",
    `model = "${CX_MINI}"`,
    'approval_policy = "never"',
    "",
    "[profiles.deep]",
    `model = "${CX_MAX}"`,
    'model_reasoning_effort = "xhigh"',
    "",
    "[profiles.deep.features]",
    "web_search = true",
    "",
    `[mcp_servers.${CANARY.mcp}]`,
    'command = "npx"',
    `args = ["-y", "@acme/mcp", "--token", "${CANARY.secret}"]`,
    "",
    `[mcp_servers.${CANARY.mcp}.env]`,
    `API_KEY = "${CANARY.secret}"`,
    "",
    '[plugins."demo@market"]',
    "enabled = true",
    "",
    `[projects."${CANARY.path}"]`,
    'trust_level = "trusted"',
    "",
  ].join("\n"));
  h.write(".codex/config.toml.backup-20260101-0000", `[profiles.${CANARY.project}]\n`);

  h.write(".codex/skills/review-helper/SKILL.md", `---\nname: review-helper\ndescription: ${CANARY.prompt}\n---\n${CANARY.code}\n`);
  h.write(".codex/skills/.system/.codex-system-skills.marker", "1\n");
  h.write(".codex/skills/.system/imagegen/SKILL.md", `---\nname: imagegen\n---\n${CANARY.code}\n`);
  h.writeJson(".codex/plugins/cache/market/demo/1.0.0/.codex-plugin/plugin.json", { name: "demo", description: CANARY.prompt });
  h.writeJson(".codex/plugins/cache/market/other/2.0.0/.codex-plugin/plugin.json", { name: "other", mcpServers: { [CANARY.mcp]: { env: { K: CANARY.secret } } } });
  h.write(".codex/memories/MEMORY.md", `- ${CANARY.prompt}\n`);
  h.write(".codex/memories/memory_summary.md", `${CANARY.email} ${CANARY.code}\n`);

  return {
    ids, created, updated, turns, historyTs,
    days: [[day(historyTs[0]!), 2], [day(historyTs[2]!), 3]],
    files: { state, turns: turnsFile, history, config },
  };
}
