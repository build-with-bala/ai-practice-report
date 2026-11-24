import type {
  CheckKind, Intent, MarkerKind, Origin, TechCategory, ToolCategory, Toolchain, ToolId, Window,
} from "./ids";

/*
 * The event contract every source plugin emits (Plan 2 computes its signals from it).
 *
 * No free text. Events carry numbers, booleans, enums, epoch ms, built-in tool names, model ids, version strings and
 * keyed hashes (`ScanCtx.hash`, a per-run HMAC) only.
 *
 * Raw in memory, allowlisted at export (Plan 2). These fields hold a tool's own strings, unhashed, because analysis
 * needs them; the export schema decides what of them may leave the machine, and in what form:
 * - model ids (`SessionEv.models`, `TurnEv.model`, `UsageEv.model`, the keys of `DailyEv.models`): anything shaped like
 *   a model id passes the guard, fine-tune ids (`ft:<base>:<org>:…`) included;
 * - Claude Code's `SessionEv.surface`: the transcript's `entrypoint`, which an environment variable can set;
 * - `AnchorEv.idTail`: the server-issued message and request ids, after their prefix;
 * - session ids (`sessionId`, `SessionEv.id`, `parentId`, `EdgeEv` ends): `<tool>:<the tool's own session or thread
 *   id>`, the raw id verbatim when it is UUID-shaped (else its keyed hash);
 * - the canary-exempt raw config names: `ConfigEv.name` (but for `feature`, a fixed token) and `ToolEv.mcpServer`.
 * Every other string is an enum, a version, a guarded token, or a keyed hash.
 *
 * Windows. The detail window (transcripts, rollouts, chat sessions: tool calls, outcomes, edits; usually the last few
 * weeks) and the lifetime window (indexes, histories, stores: counts and dates over months) overlap in time and often
 * describe the same sessions, prompts and turns. Sessions, prompts and turns say their window; every other event
 * belongs to the window of the coverage its plugin reports for it. A metric takes its numerator and denominator from
 * one source and one window; the two windows are shown side by side, never summed.
 *
 * Order and links.
 * - A session's events order by `ts`; equal times keep emission order. Copilot VS Code stamps every tool call of a
 *   request with the request's own time (the parts of a response have no time of their own), so within a request the
 *   order of its tool calls is their emission order.
 * - `SessionEv.parentId` (child → parent session) is the delegation link every tool with subagents fills.
 *   `ToolEv.delegateTo` (the delegating call → the child's session) exists only for Claude Code, and `EdgeEv`
 *   (parent → child thread) only for Codex's thread index.
 *
 * Orphan events. An event whose `sessionId` names no session in the store is an orphan: analysis counts it per kind and
 * leaves it out of the per-session walk (lifetime counts may still take it). Claude Code's workflow-run totals are
 * orphans by design: a `TotalsEv` per workflow run, keyed `claude-code:wf:<keyed hash of the run>`, names no session,
 * since a workflow run has no transcript of its own (its agents' transcripts are sessions with `workflowId`).
 */

/** What a prompt's text shows, computed in memory (`promptFeatures`). `chars`: the UTF-16 length of the trimmed prompt. */
export interface PromptFeatures { words: number; lenBucket: 0 | 1 | 2 | 3 | 4; hasContext: boolean; fileRefs: number;
  listLines: number; constraintTerms: number; isTaskStart: boolean; techCats: Partial<Record<TechCategory, number>>; simToPrev?: number;
  chars?: number }
interface Base { tool: ToolId; source: string }   // source = plugin id

/**
 * One session (a transcript, rollout, chat session, composer or conversation). When several readers report one session
 * id the store merges them (store.ts): the detail-window report decides the fields below, the other fills the gaps.
 * - `surface`: the client the session ran in, as the tool names it — Claude Code's `entrypoint` (`cli`, `sdk-cli`, …),
 *   Codex's `source` (`cli`, `vscode`, `exec`, `mcp`, `custom`, `internal`, `unknown`, `subagent`, else `other`),
 *   `cli`/`ide`/`battle` (Antigravity), `vscode`/`cli` (Copilot: the client whose files or session store the session
 *   comes from — the VS Code extension's or the CLI's), `ide` (Cursor). Every value but Claude Code's comes from an
 *   allowlist.
 * - `mode`: the interaction mode, for tools whose sessions are either an autonomous agent run or a chat (Copilot VS
 *   Code, Cursor): `agent` when any request of the session ran in agent mode, else `chat`. Absent where a tool has one
 *   mode only (Claude Code, Codex, the CLIs: agent runs).
 */
export interface SessionEv extends Base { k: "session"; id: string; window: Window; origin: Origin; start: number; end: number; models: string[];
  parentId?: string; projectKey?: string; surface?: string; version?: string; spawnDepth?: number; agentType?: string;
  background?: boolean; workflowId?: string; inRepo?: boolean; approval?: string; sandbox?: string;
  effort?: string;    // the session's reasoning effort level, when the tool records one per session (shape-guarded)
  mode?: "agent" | "chat" }
/**
 * One prompt. `projectKey`: the keyed hash of the project the prompt was typed in (the key a session of that project
 * carries in `SessionEv.projectKey`), set when the source records the project per prompt; a prompt that names a session
 * takes its project from the session.
 */
export interface PromptEv extends Base { k: "prompt"; ts: number; sessionId?: string; window: Window; origin: Origin; intent: Intent;
  features: PromptFeatures; textHash: string; hasPaste?: boolean; projectKey?: string }

/**
 * One tool call (or, for a patch, one file of it).
 * - `category`: what the call does (`ToolCategory`). A call whose category is a check (test, build, lint, typecheck)
 *   lists that check in `checks` too — every reader's calls pass through `withCheckCategory`, which enforces it;
 *   `checks` can list more (a command line that builds and then tests).
 * - `ok`: the call ran to its end and succeeded (true) or failed (false); absent when the tool does not say.
 * - `outcome`: the call did not run to an end of its own — `denied` (the person, a permission rule or an automatic
 *   check refused it), `cancelled` (dropped before it ran: the request was cancelled, the call skipped),
 *   `interrupted` (stopped while it ran). With an outcome, `ok` and `exit` are absent: a denied `npm test` is no
 *   failing check. A denial is also a `denial` marker.
 * - `exit`: the command's exit code, when the tool records one.
 * - `toolchain`: the toolchain of the command that produced the call's first check (`classifyCommand`); absent without a
 *   checking command, or when the table names no toolchain for it.
 */
export interface ToolEv extends Base { k: "tool"; ts: number; sessionId: string; callId?: string; name: string; category: ToolCategory;
  checks?: CheckKind[]; ok?: boolean; outcome?: "denied" | "cancelled" | "interrupted"; exit?: number; ms?: number; editExt?: string;
  linesAdded?: number; linesRemoved?: number; mcpServer?: string; delegateTo?: string; toolchain?: Toolchain }

/**
 * One exchange that ended: an input — a prompt, a queued message, a subagent's brief — and the agent's work on it, all
 * its model calls and tool calls, up to its final reply, a failure or an interruption. One TurnEv per exchange, at its
 * end; `ms` = its duration when known. Per tool:
 * - Claude Code: each `turn_duration` record, which the CLI writes when a turn ends normally: interrupted and failed
 *   turns have none (an interrupt is a marker);
 * - Codex: `task_complete` (completed) and `turn_aborted` (interrupted) in the rollouts; the thread history's
 *   `thread_turns` holds the same turns of paginated threads in the lifetime window — never add the two windows;
 * - Copilot VS Code: one per request whose response ended (status from its model state); the session store, one per
 *   `turns` row (lifetime, no status);
 * - Copilot CLI: an `assistant.turn_start`/`turn_end` pair is one model call (the CLI's own meaning of a turn), so a
 *   TurnEv spans from a user message over every model call to the last one before the next user message, or an abort;
 * - Cursor and Antigravity: none — their stores mark no end of a turn (Cursor's thinking time is not a turn).
 */
export interface TurnEv extends Base { k: "turn"; ts: number; sessionId: string; window: Window; model?: string; effort?: string;
  status?: "completed" | "failed" | "interrupted"; ms?: number }
export interface UsageEv extends Base { k: "usage"; ts: number; sessionId: string; model: string; inTok: number; outTok: number; cacheR: number; cacheW: number; usd?: number }
export interface TotalsEv extends Base { k: "totals"; sessionId: string; linesAdded?: number; linesRemoved?: number; usd?: number; ms?: number;
  tokens?: number }   // the tool's own running token total for the session

/**
 * A moment in a session. `detail` per kind — an enum, a keyed hash, or nothing:
 *
 * | kind                                  | detail                                                                    |
 * |---------------------------------------|---------------------------------------------------------------------------|
 * | interrupt                             | why the run stopped: `user` (the person stopped it), `replaced` (the     |
 * |                                       | person's next input replaced the running turn), `stopped-by-user` (the   |
 * |                                       | person stopped a subagent), `budget-limited`, `review-ended` (the tool's |
 * |                                       | own limits ended it, not the person), `killed` (the conversation was     |
 * |                                       | killed), `other`                                                          |
 * | denial                                | who refused a tool call: `user`, `rule` (a permission rule), `auto` (an  |
 * |                                       | automatic permission check), `other`                                      |
 * | pr-link                               | keyed hash of the pull request (its URL, else repo#number)               |
 * | commit                                | keyed hash of the sha's first 7 hex digits, lower-cased (the key repo    |
 * |                                       | signals give the same commit), when known                                 |
 * | plan-artifact                         | the artifact: `task`, `implementation_plan`, `walkthrough`               |
 * | model-switch                          | the family named: `opus`, `sonnet`, `haiku`, `fable`, `other`; none when |
 * |                                       | the picker was opened                                                     |
 * | effort-switch                         | the level: `low`, `medium`, `high`, `xhigh`, `max`, `other`; none for    |
 * |                                       | the picker                                                                |
 * | permission-mode                       | the mode: `default`, `acceptEdits`, `plan`, `auto`, `bypassPermissions`, |
 * |                                       | `other`                                                                   |
 * | compact-auto, compact-manual, clear,  | none                                                                      |
 * | plan-enter, plan-exit, queue, error   |                                                                           |
 *
 * `queue` is one prompt the person queued while the agent worked (a lifetime count of queue use is a ConfigEv
 * `feature`). `proxyTs`: `ts` is a stand-in, not when the thing happened — a file's modification time
 * (`plan-artifact`), the conversation's last change (Antigravity's `killed`) or the session's last record (Claude
 * Code's `stopped-by-user`): it places the marker, but never counts as activity.
 */
export interface MarkerEv extends Base { k: "marker"; ts: number; sessionId?: string; kind: MarkerKind; detail?: string; proxyTs?: true }

/**
 * Configuration measured by use. `name` holds the raw config name (skill, command, agent, plugin, MCP server, hook
 * event) for the export allowlist and is never exported raw — except for `feature`, a feature of the CLI whose name is a
 * fixed token: `prompt-queue` (`uses`: times the input queue went from empty to non-empty, as the CLI counts them),
 * `hooks-disabled` (the settings turn every hook off, so none runs).
 * `firstSeen`: when the artifact appeared — its file or folder's birth time by stat (absent where the file system
 * records none, or it is implausible; never the change time), never opened, or an install time the tool records. It never counts as activity (spec §6.2: file times never
 * make a day active).
 * `projectKey`: the keyed hash of the project the entry belongs to (a per-project server, a project's own settings,
 * hooks, skills or agents); absent for a user-level entry.
 */
export interface ConfigEv extends Base { k: "config";
  kind: "skill" | "command" | "agent" | "plugin" | "hook" | "mcp-server" | "memory-file" | "instruction-file" | "profile" | "feature";
  name?: string; provenance: "authored" | "installed" | "bundled" | "unknown"; uses?: number; lastUsed?: number; checks?: CheckKind[];
  firstSeen?: number; projectKey?: string }

/**
 * A tool's own per-day totals. `zone`: the day's time zone — `utc`, or `local` (the scanning process's zone);
 * `unit`: what `count` counts — `prompts` typed at the prompt, or `messages` (every message of the day's sessions,
 * whoever wrote it). Days of different zones never match one to one; counts of different units never add up.
 */
export interface DailyEv extends Base { k: "daily"; day: string; zone: "local" | "utc"; unit: "prompts" | "messages"; count: number;
  sessions?: number; toolCalls?: number; models?: Record<string, number> }
export interface EdgeEv extends Base { k: "edge"; parentId: string; childId: string }
export interface AnchorEv extends Base { k: "anchor"; kind: "cc-msg" | "cc-req"; ts: number; idTail: string;
  /** The session the event belongs to, when the reader knows it; scope rules treat the event like its session. */
  sessionId?: string }
export interface IdentityEv extends Base { k: "identity"; scope: "session" | "config"; hash: string; sessionId?: string }
export interface FileFactEv extends Base { k: "file"; pathHash: string; bytes: number; mtime: number; birth?: number; ctime?: number; firstTs?: number; lastTs?: number;
  /** The session the event belongs to, when the reader knows it; scope rules treat the event like its session. */
  sessionId?: string }
export interface RolloutFactEv extends Base { k: "codex-rollout"; threadId: string; uuidTs?: number; fileTs?: number }
export interface ThreadRowEv extends Base { k: "codex-thread-row"; threadId: string; createdAt?: number }
export interface RateLimitEv extends Base { k: "ratelimit"; ts: number; window: "primary" | "secondary"; windowMinutes?: number; usedPercent: number; resetsAt?: number;
  bucket?: string;   // keyed hash of the provider's rate-limit bucket id, when the trace names one
  /** The session the event belongs to, when the reader knows it; scope rules treat the event like its session. */
  sessionId?: string }
export interface CommitFactEv extends Base { k: "commit"; ts: number; aiLines?: number; humanLines?: number; repoKey?: string }

/**
 * What one plugin read of one candidate, in one window: one CoverageEv per (candidate, window) the plugin reports.
 * `status`: `ok` (read, nothing unknown), `drift` (unknown record types, missing or reshaped fields, or nothing usable
 * from records that were read: `zero-yield`), `empty` (present, nothing usable), `absent` (not there),
 * `present-undecodable` (there, format not decoded), `error` (could not be read — `note` says why; `aborted` = the scan
 * was aborted before this source was read to its end: its counts and events are what was read until then).
 * `beta`: the plugin's own flag, stamped by the orchestrator.
 */
export interface CoverageEv extends Base { k: "coverage"; window: Window;
  status: "ok" | "empty" | "absent" | "drift" | "error" | "present-undecodable"; beta: boolean; installed?: boolean;
  from?: number; to?: number; files: number; bytes: number; records: number; skipped: Record<string, number>;
  unknownTypes: Record<string, number>; versions: string[]; retentionDays?: number; note?: string }
export type Ev = SessionEv | PromptEv | ToolEv | TurnEv | UsageEv | TotalsEv | MarkerEv | ConfigEv | DailyEv | EdgeEv
  | AnchorEv | IdentityEv | FileFactEv | RolloutFactEv | ThreadRowEv | RateLimitEv | CommitFactEv | CoverageEv;
export type EvOf<K extends Ev["k"]> = Extract<Ev, { k: K }>;
