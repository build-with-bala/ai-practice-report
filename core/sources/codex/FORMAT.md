# Codex — rollouts; lifetime layer and configuration

Readers: `codex.rollouts` (`rollouts.ts`, `tools.ts`, `uuid.ts`, `origin.ts`, `effort.ts`); the lifetime layer (thread
index, turn history, prompt history, configuration) is documented in the second half of this file.

Evidence: **(verified locally)** = the type or field was confirmed on this machine with the structure probe
(`scripts/probe.ts`) or with count-only checks run by the reader's author. **(CLI program)** = read from the installed
CLI program's own type tables (0.169.0), not seen locally. This file records names and value types only, never values.

**Zero-yield.** A coverage window that read records but yielded none of its reader's primary events is drift
`zero-yield` (set by the scan), so a renamed field never passes as a quiet store. Primary events: `codex.rollouts` — a session, prompt or
tool call; `codex.threads` — a session, turn or spawn edge; `codex.history` — a prompt; `codex.config` — a setting.

## Layout

```
<codex> = $CODEX_HOME, else <home>/.codex (each WSL home: <home>/.codex)
<codex>/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-<thread id>.jsonl          one rollout per thread
<codex>/archived_sessions/…/rollout-*.jsonl                                       archived threads, same format
```

- The file name carries the thread's creation time in **local** time (second precision) and the thread id (a UUIDv7,
  whose first 48 bits are its creation time in Unix ms). A thread is resumed by appending to its rollout.
- Not read by this reader: `auth.json`, `config.toml`, `history.jsonl`, the SQLite stores (the lifetime readers below
  read some of them), `shell_snapshots/`, `log/`.

## Line shape

JSONL; every line is `{timestamp (ISO string), ordinal (number), type (string), payload (object)}`, in that key order
(verified locally). `ordinal` numbers the lines of a rollout from 0; older CLIs do not write it.
`response_item` lines may add `metadata` {`client_authored`, `history_sequence`, `sampled_through_sequence`,
`user_input_order`, `inherited_user_message`, `retained_source`, `mcp_attribution`, …} (verified locally; not read).

## Record types (`type`)

| type | evidence | handling |
|---|---|---|
| `session_meta` | verified locally | the first one describes the thread; later ones are ignored (see forked history) |
| `turn_context` | verified locally | model and effort of the turn |
| `response_item` | verified locally | messages and tool calls, below |
| `event_msg` | verified locally | turn boundaries, token counts, completed items, below |
| `compacted` | verified locally | `compact-auto` marker |
| `token_usage_record`, `world_state` | verified locally | dropped before parsing |
| `inter_agent_communication_metadata` | verified locally | ignored |
| `inter_agent_communication`, `dynamic_tools_updated`, `retained_context`, `security_risk_score`, `realtime_item` | CLI program | ignored |

Any other `type` is drift (coverage `unknownTypes`, keyed `(other)`, or `(none)` without a string `type`; an unknown
name is never kept).

### `session_meta.payload`

`id` (thread id), `session_id`, `timestamp`, `cwd`, `originator` (string; `Claude Code` when another agent drives Codex),
`cli_version`, `source`, `thread_source`, `model_provider`, `history_mode`, `base_instructions{text, provenance}`,
`git{commit_hash, branch, repository_url}` (present when the cwd is a git work tree), `context_window{window_id}`,
`runtime_workspace_roots[]`, `creator_user_id`, `creator_account_id`, `account_scoped` (verified locally).
Subagent threads add `parent_thread_id`, `forked_from_id`, `agent_nickname`, `agent_path`, `multi_agent_version`,
`subagent_history_start_ordinal` (number) (verified locally).

`source` is a string (`cli`, `exec` for `codex exec`, `vscode`, `mcp`, …) or an object `{subagent: …}`: `"review"`,
`"compact"`, `{thread_spawn: {parent_thread_id, depth, agent_path, agent_nickname, agent_role}}` or `{other: …}`
(`thread_spawn` verified locally; the rest CLI program). `agent_role` is null for the default agent; the CLI's built-in
roles are `default`, `explorer`, `awaiter` (CLI program); any other role comes from the user's config.

**Forked history.** A subagent that inherits its parent's context starts its rollout with its own `session_meta`
(ordinal 0), then a copy of the parent's history — including the parent's `session_meta` (another id), turn contexts,
user messages, tool calls, turn ends — and only then its own lines, from ordinal `subagent_history_start_ordinal` on
(verified locally). Other forks (`forked_from_id` with a string source) copy nothing: with `history_mode: "paginated"`
their `history_base` {`thread_id`, `end_ordinal_exclusive`, `end_byte_offset`} points into the parent's rollout, and
`forked_from_ordinal_exclusive` names the fork point there (verified locally). `history_mode` is `legacy` for rollouts
without ordinals, else `paginated` (verified locally).

### `turn_context.payload`

`turn_id`, `root_turn_id`, `cwd`, `model`, `effort` (string: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`,
`ultra`; CLI program, the common ones verified locally), `summary`, `approval_policy`, `approvals_reviewer`,
`sandbox_policy{type, network_access, …}`, `file_system_sandbox_policy`, `permission_profile`,
`active_permission_profile`, `collaboration_mode{mode, settings{model, reasoning_effort, developer_instructions}}`,
`comp_hash`, `cyber_access_program`, `disabled_plugin_ids`, `multi_agent_version`, `realtime_active` (verified locally).

### `response_item.payload` (`payload.type`)

| payload type | evidence | handling |
|---|---|---|
| `message` {`id`, `role` (`user`, `developer`, `assistant`), `content[]`, `phase`, `status`} | verified locally | user messages → prompts; developer/assistant dropped before parsing |
| `function_call` {`id`, `call_id`, `name`, `namespace`?, `arguments` (JSON string), `status`} | verified locally | tool call |
| `custom_tool_call` {`id`, `call_id`, `name`, `input` (free-form string), `status`} | verified locally | tool call |
| `local_shell_call` {`call_id`, `status`, `action{type, command[], …}`} | CLI program | tool call |
| `web_search_call` {`id`, `status`, `action{type: search \| open_page \| find_in_page, …}`} | verified locally | `web` tool event |
| `function_call_output`, `custom_tool_call_output`, `reasoning`, `agent_message` {`author`, `recipient`, `content`}, `additional_tools`, `tool_search_output` | verified locally / CLI program | dropped before parsing |
| `configuration_update`, `tool_search_call`, `image_generation_call`, `compaction`, `context_compaction`, `other` | verified locally / CLI program | ignored |

Other payload types are drift: `response_item:(other)`.

**User message content** parts: `{type: "input_text", text}`, `{type: "input_image", image_url}`. The CLI writes
context and notices as user-role messages of their own (verified locally unless marked):
`<environment_context>`, `# AGENTS.md instructions for <dir>` + `<INSTRUCTIONS>`, `<recommended_plugins>`,
`<codex_internal_context source=…>` (goal context; the `<objective>`/`<untrusted_objective>` blocks of the goal
templates sit inside it), `<turn_aborted>`, `<skill>` (the body of a skill the person named), `<user_shell_command>` (a
command the person ran with `!` and its output); CLI program: `<user_instructions>` (older CLIs),
`<subagent_notification>`, `<user_action>` (the results of `/review`, completed or interrupted),
`<realtime_delegation>` (a request the realtime voice conversation hands to Codex). The CLI also defines
`<current_time_reminder>`, `<current_time_unavailable>`, `<agent_message_board_notification>` and an
`<EXTERNAL SESSION IMPORTED>` marker for imported sessions, whose role is not confirmed. An attached image is written as
the parts `<image name=[Image #n]>`, the image, `</image>`, followed by the person's text; a resized image adds an
`<image_resize_notice>…</image_resize_notice>` part (CLI program). A reply the person types to a question the agent
sent them is wrapped in `<send_user_message_question_reply>…</send_user_message_question_reply>`. The CLI also records
each actual user input separately: as an `item_completed` `UserMessage` item (newer CLIs) or an `event_msg`
`user_message` (older ones). Newer CLIs tag every part with a provenance
(`internal_chat_message_metadata_passthrough.content_item_metadata[].provenance.type`: `user`, `harness`, `agents_md`,
`skills`, `developer_instructions`, …); the context messages above carry `harness`/`agents_md`, the person's text
`user` (verified locally; not read, older rollouts lack it).

Developer-role, never a user message (verified locally unless marked): `<permissions instructions>`,
`<collaboration_mode>`, `<multi_agent_mode>`, `<multi_agent_role>`, `<model_switch>`, `<skills_instructions>`,
`<plugins_instructions>`, `<apps_instructions>`, `<tools>`, `<model_instructions>`; CLI program:
`<environments_instructions>`, `<realtime_conversation>`, `<side_conversation>`, `<personality_spec>`, … .
`<turn_aborted>` and `<recommended_plugins>` are written into developer messages too (verified locally).
`<proposed_plan>` is the format of the assistant's plan (CLI program).

**Code Mode.** Current CLIs give the model one free-form tool, `custom_tool_call` named `exec`, whose `input` is
JavaScript run in a V8 isolate (an optional first-line pragma `// @exec: {"yield_time_ms": …}`); the script calls the
real tools as `await tools.exec_command({cmd})`, `tools.apply_patch(…)`, `tools.view_image(…)`,
`tools.mcp__<server>__<tool>(…)`, `tools.<namespace>__<tool>(…)` (CLI program; the `tools.` calls verified locally).
`function_call` `wait` with `cell_id` resumes a cell that yielded. The nested calls are not written as calls: their
results arrive as `item_completed` items with ids of their own (`CommandExecution`, `FileChange`, `McpToolCall`,
`ImageView`, `Extension`), never matching the cell's `call_id` (verified locally).

Tool names (verified locally unless marked): `exec_command` {`cmd`, `workdir`, `yield_time_ms`, …}, `write_stdin`,
`apply_patch` (custom: `input` is patch text), `update_plan`, `view_image`, `wait`; namespace `collaboration`:
`spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `interrupt_agent`, `list_agents`; namespace `clock`:
`sleep`; namespace `image_gen`: `imagegen`; `request_user_input_async`. CLI program: `shell` {`command` argv},
`shell_command` {`command` string}, `send_input`, `resume_agent`, `close_agent`, `web_search`, `request_user_input`,
`request_permissions`, `tool_search`, `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`,
`js_repl`, namespace `web`: `run` (searches and opens pages; called from Code Mode cells as `tools.web__run`, verified
locally). MCP tools are `mcp__<server>__<tool>` (older CLIs: `<server>__<tool>`) or carry an `mcp__<server>__`
namespace (CLI program).

**apply_patch text**: `*** Begin Patch`, then per file `*** Add File: <path>` / `*** Update File: <path>`
(optionally `*** Move to: <path>`) / `*** Delete File: <path>`, hunks of `@@`, `+`, `-`, ` ` lines, `*** End of File`,
and `*** End Patch` (CLI program).

### `event_msg.payload` (`payload.type`)

Mapped (verified locally):

- `task_started` {`turn_id`, `root_turn_id`, `started_at` (s), `model_context_window`, `collaboration_mode_kind`,
  `turn_attribution{turn_id, root_turn_id, parent_turn_id, initiating_agent_path, turn_trigger}`}.
- `task_complete` {`turn_id`, `last_agent_message` (text), `started_at`, `completed_at` (s), `duration_ms`,
  `time_to_first_token_ms`}.
- `turn_aborted` {`turn_id`, `reason` (`interrupted`; CLI program also `replaced`, `review_ended`, `budget_limited`),
  `duration_ms`?}.
- `token_count` {`info` (null before the first response) {`total_token_usage`, `last_token_usage`,
  `model_context_window`, `last_usage_includes_reasoning`}, `rate_limits` (nullable) {`limit_id`, `limit_name`,
  `plan_type`, `credits{has_credits, unlimited, balance}`, `individual_limit`, `rate_limit_reached_type`,
  `spend_control_reached`, `primary`, `secondary` (each null or {`used_percent`, `window_minutes`, `resets_at`
  (epoch s)})}}. Older CLIs wrote `resets_in_seconds` instead of `resets_at` (per the task brief; not in the 0.169
  program). Token usage objects: `input_tokens` (the whole prompt, cached tokens included), `cached_input_tokens`,
  `cache_write_input_tokens`, `output_tokens` (reasoning included), `reasoning_output_tokens`, `total_tokens`. The
  CLI re-emits an unchanged `token_count` (same totals).
- `item_completed` {`thread_id`, `turn_id`, `started_at_ms`, `completed_at_ms`, `item{type, id, …}`}, item types:
  - `CommandExecution` {`id`, `process_id`, `command` (argv, e.g. `[<shell>, "-lc", <script>]`), `cwd`, `parsed_cmd[]`
    {`type`: `read` \| `list_files` \| `search` \| `unknown`, `cmd`, `name`, `path`, `query`}, `source`
    (`unified_exec_startup`, `user_shell`; CLI program also `agent`, `unified_exec_interaction`), `aggregated_output`,
    `exit_code`, `duration{secs, nanos}`, `status` (`completed`, `failed`)}.
  - `FileChange` {`id`, `changes` {<path>: {`type`: `add` (`content`) \| `delete` (`content`) \| `update`
    (`unified_diff`, `move_path`)}}, `status`}.
  - `McpToolCall` {`id`, `server`, `tool`, `arguments`, `result`, `status`, `duration{secs, nanos}`}.
  - `ImageView` {`id`, `path`}; `WebSearch` {`id`, `query`, `action`} (the item form of a `web_search_call`).
  - `Extension` {`kind` (`web.search`, `image_gen.generation`, `clock.sleep`), `id`, …; web searches add `query`,
    `action`, `results`; image generations `status`, `result` (the image), `failure`}.
  - `CollabAgentToolCall` {`id`, `tool`, `status`, `sender_thread_id`, `receiver_thread_ids`, `receiver_agents`,
    `agents_states`}; `SubAgentActivity` {`id`, `kind`, `agent_thread_id`, `agent_path`, `model`, `reasoning_effort`}.
  - `UserMessage`, `AgentMessage`, `Reasoning`, `ContextCompaction`, `FunctionCallOutput`; CLI program: `HookPrompt`,
    `Plan`, `ImageGeneration`, `DynamicToolCall`, `EnteredReviewMode`, `ExitedReviewMode`.
  An item whose id is a call's `call_id` completes that call; Code Mode's nested calls have ids of their own.

Known, not mapped: `thread_settings_applied`, `user_message`, `agent_message`, `image_generation_end`,
`patch_apply_end`, `web_search_end`, `context_compacted`, `thread_goal_updated` (verified locally), and the rest of the
CLI's EventMsg tags (`exec_command_end`, `mcp_tool_call_end`, `collab_*`, `realtime_*`, deltas, …; CLI program — see
`EVENT_TYPES`). Other payload types are drift (`event_msg:(other)`); unknown item types are drift as `item:(other)`
(item tags are PascalCase, so they are never copied into coverage).

## What the reader emits

- **Ids.** Session id `codex:<thread id>` — the `session_meta.payload.id` verbatim when UUID-shaped, else its keyed
  hash (before a `session_meta`, the id in the file name). A thread seen in an earlier rollout (e.g. both live and
  archived) is read once: later rollouts naming it count as skipped `duplicate`. `callId` = keyed hash of the call id
  (or of the item id for nested calls).
- **SessionEv** per rollout (origin rules in `origin.ts`, shared with the thread index reader so the two cannot
  diverge): origin from `source` — `exec` → scripted; `mcp` (Codex run through its MCP server,
  driven by another client or agent) → peer; `{subagent: …}` → subagent (`parentId` from
  `thread_spawn.parent_thread_id`, else `parent_thread_id`; `spawnDepth` = `depth`; `agentType` = the role when
  built in, else its keyed hash); any other string, or no source → human; `originator` exactly `Claude Code` → peer,
  whatever the string source (a subagent source wins: its subagents inherit the originator and stay subagents).
  `surface` = the source when the CLI writes it (`cli`, `vscode`, `exec`, `mcp`, `custom`, `internal`, `unknown`; CLI
  program), else `other`, or `subagent`; `version` = `cli_version`;
  `projectKey` from `cwd`; `inRepo` = `git` present; `models` = distinct `turn_context` models; `start`/`end` =
  first/last own line time. A source object without `subagent` is drift `session_meta.source:shape`.
- **Copied history is skipped**: lines with `ordinal` below `subagent_history_start_ordinal` — whatever the source —
  yield nothing, so the parent's prompts, tools, turns and usage are not counted twice; the token totals and rate
  limits they reach are the baselines the thread's own `token_count`s are compared with, so the fork point's re-emitted
  count is not new usage. Paginated forks reference their parent's history (`history_base`) and copy nothing.
- **PromptEv** for user-role messages of threads whose source is not a subagent one (a subagent's user messages are
  its parent's briefs), origin = the session's: input text parts joined with "\n" after dropping attached images'
  `<image …>`/`</image>` wrapper parts and `<image_resize_notice>` notices; a message whose text starts (after
  whitespace) with the whole tag `<environment_context`, `<user_instructions`, `<recommended_plugins`, `<image`,
  `<codex_internal_context`, `<turn_aborted`, `<skill`, `<user_shell_command`, `<subagent_notification`,
  `<user_action`, `<realtime_delegation`, `<current_time_reminder`, `<current_time_unavailable`,
  `<agent_message_board_notification` or `<EXTERNAL SESSION IMPORTED` (followed by whitespace, `>`, `/` or the end), or
  with `# AGENTS.md`, is not a prompt — `<skills…` or `<image_…` text is; `<send_user_message_question_reply>` is
  unwrapped to the reply. `hasPaste` = the message attaches images. Intent, features and `textHash` (keyed hash of the
  trimmed text) as for Claude Code; `isTaskStart` = first human prompt or ≥ 30 min since the thread's last line.
- **ToolEv** (`cxToolCalls`), one per call, or per file for apply_patch:
  - shell tools (`exec_command`, `shell`, `shell_command`, `local_shell`): `classifyCommand` of the command line (a
    `[<shell>, -c…, <script>]` argv is unwrapped to the script), as for Claude Code's shell tools; it recognises
    reading (`cat`, `head`, `tail`, `ls`, …) and searching (`rg`, `grep`, `find`, …) behind every other category.
    `parsed_cmd` is not read.
  - `apply_patch` → `edit` per file, `editExt` from the path, `linesAdded`/`linesRemoved` from the file's `+`/`-` lines;
    `FileChange` items → the same per changed file (update: the diff's lines; add/delete: the content's lines).
  - `update_plan` → plan; `view_image`/`ImageView` → read; `web_search_call`, `web_search`, the `web` namespace and
    `Extension web.search` → web (`name:"web_search"`); the multi-agent tools (and v1 `wait` with agent ids) and
    `CollabAgentToolCall` → delegate; `sleep` → schedule; `write_stdin` → shell; MCP → `name:"mcp"`, `mcpServer` =
    the server segment (raw, export-allowlisted later); MCP resource tools → mcp; bookkeeping and requests to the
    person (`request_user_input`, `request_user_input_async`, `request_permissions`, `request_plugin_install`,
    `list_available_plugins_to_install`, `tool_search`, `current_time`, `get_context_remaining`, `new_context_window`,
    `wait_for_environment`, `send_message_to_user_async`) → meta; other built-ins → other; any name that is not a
    built-in, or a tool in a namespace that is not the CLI's own → `name:"other"`, category other.
  - Code Mode `exec` cells and their `wait` resumptions are not tool events: the nested calls are, from their items.
    Commands the person ran (`source: user_shell`) are not tool events.
  - A call waits for the item with its `call_id`: `ok` = exit code 0 (else from `status`), `exit`, `ms` from
    `duration`; an item `declined` by the person never ran: `outcome: "denied"`, no `ok` or `exit`, and a `denial`
    marker (`detail: "user"`). A linked shell call that classified as plain `shell` takes the category and checks of
    the command that ran. Items without such a call are their own events, timed by `started_at_ms`; an item id is counted once, so the
    same item again, or its call arriving after it, adds nothing. Calls no item completes are emitted at the end of
    the file.
  - Input sent to a running command (`CommandExecution` with `source: unified_exec_interaction`) never makes a command
    event: it completes the call with its id, else it is skipped (`exec-interaction`).
  - An item recorded for another thread (`item_completed.thread_id`, or a `CollabAgentToolCall`'s `sender_thread_id`,
    present and not this rollout's thread id) is not this session's: skipped (`foreign-item`).
- **TurnEv** at `task_complete` (completed) and `turn_aborted` (interrupted): model and effort of the turn's
  `turn_context` (effort outside the CLI's levels → `other`; model strings not id-shaped → `other`), `ms` =
  `duration_ms`, else the time since the turn's `task_started`.
- **UsageEv** per `token_count` whose `total_token_usage` changed since the previous one, from `last_token_usage`:
  `inTok` = input − cached, `cacheR` = cached, `cacheW` = cache-write, `outTok` = output; model = the turn's.
- **RateLimitEv** per window (`primary`, `secondary`) present with a numeric `used_percent`: `windowMinutes`,
  `resetsAt` (`resets_at` in s or ms, else line time + `resets_in_seconds`), `bucket` = the keyed hash of `limit_id`
  (a server-issued id, never kept raw; absent without one); a snapshot equal to the previous one of its bucket and
  window in the same rollout is not repeated. Rate limits belong to the account: the event has no session.
- **MarkerEv**: `interrupt` per `turn_aborted`, `detail` by its `reason` — the person's: `interrupted` → `user`,
  `replaced` → `replaced` (new input replaced the turn); the tool's own: `review_ended` → `review-ended`,
  `budget_limited` → `budget-limited`; any other reason, or none → `other`. `denial` per declined item.
  `compact-auto` per `compacted` line.
- **RolloutFactEv** per fully read rollout: `threadId` = the session id, `uuidTs` = the thread id's UUIDv7 time,
  `fileTs` = the file name's local time; **FileFactEv** likewise.
- **CoverageEv**: `files`/`bytes` of fully read rollouts, `records` = parsed lines; skipped `sniffed`, `oversize`,
  `parse`, `io-error`, `duplicate`, `foreign-item`, `exec-interaction`, `bad-record` (also logged once per root as
  `warn cx.bad-record`), `bad-ts` (a well-formed time outside the plausible range), `no-ts` (an event whose line gives
  no time; markers and command items take the latest earlier one when there is one); drift, beyond unknown types:
  `timestamp:shape` (a line whose `timestamp` is absent or not a time), `<type>.payload:shape` (a `session_meta`,
  `turn_context`, `response_item` or `event_msg` line whose `payload` is not an object), `user.content:shape` (a user
  message whose `content` is neither a string nor a list holding an `input_*` part); `versions` = `cli_version`s; `from`/`to` = first/last event time. Once per root the
  shell-command events with and without a command line (from the call's arguments or the command item completing it)
  are logged as `debug codex.cmd-extracted` and `debug codex.cmd-missing` — a falling share means the command lines
  moved where the reader does not look.

**Dropped before parsing** (from the first 512 bytes): `world_state`, `token_usage_record`; response items
`reasoning`, `function_call_output`, `custom_tool_call_output`, `tool_search_output`, `agent_message`,
`additional_tools`, and messages whose `role` (before `content`) is `developer`, `assistant` or `system`; events
`image_generation_end`, `agent_message`, `agent_reasoning*`, `*_delta`, `raw_response_item`, `item_started`; and
`item_completed` lines whose item is `Reasoning`, `AgentMessage`, `UserMessage`, `SubAgentActivity` or an
`Extension` of kind `image_gen.generation`. Lines whose head does not have the expected shape are parsed.

## Limits

- Code Mode calls that complete no item — `write_stdin`, `update_plan` and other tools called from a cell, MCP or
  namespaced tools whose items the CLI does not write, image generations run from a cell (their items are dropped
  before parsing), and cells that fail before calling a tool — are not counted. A cell's own outcome is not read.
- Commands `classifyCommand` does not recognise (scripts, loops, file operations) stay `shell`.
- `compacted` does not say whether compaction was automatic or asked for; every one is `compact-auto`.
- Usage deduplication compares a `token_count`'s totals with the previous one in the same rollout.
- A session's `end` (and the file's `lastTs`) is the time of its last parsed line; lines dropped before parsing do not
  move it.
- `<image`-led messages are prompts only through the wrapper shape above; any other `<image>`/`<image …` text is
  treated as injected.
- Prompts in a thread imported from another agent (`<EXTERNAL SESSION IMPORTED>`) beyond its import notice would also
  be prompts of that agent's own reader (unverified).

---

# Lifetime layer and configuration

Rollouts are pruned and archived; these stores are not, so they carry the long view. The thread index outlives the
rollouts: it keeps threads whose rollout is gone. All three
readers report coverage with window `lifetime`.

## Layout

```
<codex>/state_<N>.sqlite                codex.threads   thread index (the highest N)
<codex>/thread_history_<N>.sqlite       codex.threads   per-turn status and timing (the highest N)
<codex>/history.jsonl                   codex.history   one line per prompt typed in the CLI
<codex>/config.toml                     codex.config    section headers only
<codex>/plugins/cache/<marketplace>/<plugin>/<version>/.codex-plugin/plugin.json
                                        codex.config    installed plugins (folder names only)
<codex>/skills/<name>/SKILL.md          codex.config    skills (names only)
<codex>/memories/*.md                   codex.config    memory files (counted, never opened)
<home>/.agents/.skill-lock.json         codex.config    skills placed by the shared `skills` installer (names only)
not read: goals_<N>.sqlite, logs_<N>.sqlite, memories_<N>.sqlite, queue_<N>.sqlite, sqlite/, session_index.jsonl,
          auth.json, config.toml.backup-*, skills/.system/ (bundled skills), memories/rollout_summaries/,
          memories/.git, plugins/.remote-plugin-install-staging/, <home>/.agents/skills/ (shared with other agents)
```

The SQLite stores are WAL databases written by the CLI and its app server (verified locally); the CLI numbers each
store and moves to a new number on a breaking migration, so the regular file with the highest N (compared as a number)
is the current one. When the CLI closes a store cleanly it removes the `-wal` (verified locally). `openRo` decides
before opening: a store whose header marks WAL mode (bytes 18 and 19 both 2) and that has no `-wal` is opened with
`immutable=1` — there is no WAL content to miss, and nothing is written beside the store. A plain read-only open of such
a store creates `-wal` and `-shm` beside it on the stock SQLite build (Linux, Windows) and fails on Apple's (macOS).
If a `-wal` appears while it opens (the CLI started writing), the store is reopened `mode=ro`, as is every other store.

## state_<N>.sqlite (verified locally; table definitions per the CLI program)

Tables (verified locally): `threads`, `thread_spawn_edges`, `_sqlx_migrations`, `thread_dynamic_tools`,
`thread_attachments`, `thread_read_receipts`, `thread_sections`, `projects`, `project_roots`,
`project_idempotency_keys`, `backfill_state`, `rollout_migration_state`, `rollout_migration_skipped_rollouts`,
`remote_control_enrollments`, `external_agent_config_imports`, `guardian_review_feedback`. Only the first two are read.

`threads`, one row per thread the CLI indexed, `id` the primary key. Columns (the first group is the original table,
the rest were added by later migrations, so older stores lack them):

- `id` TEXT (the thread id, a UUIDv7 — the rollout's `session_meta.payload.id`), `rollout_path` TEXT, `created_at`,
  `updated_at` INTEGER (epoch s), `source` TEXT, `model_provider` TEXT, `cwd` TEXT, `title` TEXT, `sandbox_policy`
  TEXT, `approval_mode` TEXT, `tokens_used` INTEGER, `has_user_event` INTEGER, `archived` INTEGER, `archived_at`
  INTEGER, `git_sha`, `git_branch`, `git_origin_url` TEXT (nullable).
- added: `cli_version` TEXT, `first_user_message` TEXT, `agent_nickname`, `agent_role` TEXT, `memory_mode` TEXT, `model`,
  `reasoning_effort` TEXT, `agent_path` TEXT, `created_at_ms`, `updated_at_ms` INTEGER (epoch ms), `thread_source` TEXT
  (`user`, `subagent`), `preview` TEXT, `recency_at`, `recency_at_ms` INTEGER, `history_mode` TEXT (`legacy`,
  `paginated`), `name` TEXT, `is_pinned` INTEGER, `thread_section_id` TEXT, `section_position`, `section_entered_at_ms`
  INTEGER, `project_id` TEXT, `originator` TEXT (null on older rows), `daybreak_enabled` BOOLEAN, `creator_user_id`,
  `creator_account_id` TEXT, `attached_thread_parent_id` TEXT.

Value shapes (verified locally): `source` is the rollout's `session_meta.source` — a bare token (`cli`, `exec`,
`vscode`, …) or the JSON text of a subagent source object (`{"subagent": {"thread_spawn": {parent_thread_id, depth,
agent_path, agent_nickname, agent_role}}}` or `{"subagent": "<kind>"}`). `sandbox_policy` is JSON: `{type}` with
`type` ∈ `workspace-write`, `read-only`, `disabled`, `managed`; older policies add `writable_roots[]` (paths),
`network_access`, `exclude_tmpdir_env_var`, `exclude_slash_tmp`; `managed` ones add `file_system {type, entries[]
{access, path {type, value}}}` (paths) and `network`. `approval_mode` is a token (`never`, `on-request`, …).

`thread_spawn_edges` (`parent_thread_id` TEXT, `child_thread_id` TEXT primary key, `status` TEXT, e.g. `open`): one row
per spawned subagent thread (verified locally; both ends have index rows).

## thread_history_<N>.sqlite (verified locally; table definitions per the CLI program)

Tables: `thread_turns`, `thread_items`, `thread_realtime_items`, `thread_history_projection_state`, `_sqlx_migrations`.
Only `thread_turns` is read. The CLI projects only paginated rollouts (`history_mode: paginated`) into it, so legacy
threads have no turns here.

`thread_turns` (primary key `thread_id`, `turn_id`): `thread_id`, `turn_id` TEXT, `rollout_ordinal` INTEGER, `status`
TEXT (`completed`, `interrupted`, `failed`, `inProgress` — the app server's turn status, camelCase), `error_json` TEXT,
`started_at`, `completed_at` INTEGER (epoch s; `completed_at` is null while a turn is in progress), `duration_ms`
INTEGER, `first_user_item_id`, `final_agent_item_id` TEXT, `rollout_byte_offset`, `rollout_end_ordinal`,
`rollout_end_byte_offset` INTEGER, `root_turn_id` TEXT. `thread_items` holds each item's full JSON (messages, commands,
outputs).

## Never selected

The SQL names only the columns below, validated against `pragma_table_info` first; it never uses `*` (not even
`COUNT(*)`) and binds every value as a parameter. Never selected, because they hold user, model, path or account text:

- `threads`: `first_user_message`, `title`, `preview`, `name` (the name a person gives a thread), `agent_nickname`,
  `agent_path`, `rollout_path`, `creator_user_id`, `creator_account_id`; the values of `git_sha`, `git_branch`,
  `git_origin_url` (only tested for presence inside SQL, `COALESCE(<col>, '') <> ''`); and, not needed,
  `model_provider`, `agent_role`, `memory_mode`, `thread_source`, `history_mode`, `recency_*`, `archived*`,
  `is_pinned`, `section*`, `project_id`, `daybreak_enabled`, `attached_thread_parent_id`, `has_user_event`.
- `thread_spawn_edges.status`; `thread_turns`: `error_json`, `first_user_item_id`, `final_agent_item_id`, the rollout
  offsets.
- Selected and parsed in memory, partly kept: `threads.source` — a subagent thread's JSON also carries
  `thread_spawn.agent_path` and `agent_nickname`, which are parsed and never kept; only `parent_thread_id` (as an id),
  `depth` and `agent_role` (a built-in role, else its keyed hash) are kept. `threads.sandbox_policy` — only its `type`
  is kept, never its paths.
- Never read at all: `thread_items`, `thread_realtime_items`, `thread_history_projection_state`,
  `thread_dynamic_tools` (tool descriptions and schemas), `thread_attachments` (payloads), `projects` and
  `project_roots` (names, paths), `thread_sections` (names), `thread_read_receipts`, `remote_control_enrollments`
  (account and server ids), `external_agent_config_imports`, `guardian_review_feedback`, `rollout_migration_*`
  (rollout paths), `backfill_state`.

## What the thread reader emits (`codex.threads`, `indexdb.ts`)

- **Columns read**: `threads`: `id`, `source`, `originator`, `model`, `reasoning_effort`, `approval_mode`,
  `sandbox_policy`, `tokens_used`, `created_at`, `created_at_ms`, `updated_at`, `updated_at_ms`, `cli_version`, `cwd`,
  and git presence; `thread_spawn_edges`:
  `parent_thread_id`, `child_thread_id`; `thread_turns`: `thread_id`, `status`, `started_at`, `completed_at`,
  `duration_ms`. Each one missing is drift `missing-column:<name>` and the rest is still read; a missing table is drift
  `missing-table:<name>`. Without `threads.id`, `thread_turns.thread_id`/`status` or either edge column that table is
  skipped. Tables are read in rowid pages of 5,000 rows (`WHERE rowid > ? ORDER BY rowid LIMIT ?`). A table that
  cannot be paged — declared `WITHOUT ROWID` (checked in `sqlite_master.sql` before paging), or whose first page fails
  for any reason but a busy store — is drift `table-unreadable:<name>` and is skipped.
- **Ids**: `codex:<thread id>`, the id verbatim when UUID-shaped, else its keyed hash — the same form as the rollouts'
  session ids and `RolloutFactEv.threadId`, so index rows and rollouts join and their sessions merge in the store:
  start = earliest, end = latest, models = the sorted union, a non-human origin wins (subagent > peer > scripted >
  scheduled > system > human), window `detail` when the rollout's session is one; every other field (`source`,
  `version`, `surface`, `projectKey`, `inRepo`, `parentId`, …) takes the rollout's value when it has one, else the index
  row's (`approval`, `sandbox`, `effort`) — whichever arrives first.
- **ThreadRowEv** per `threads` row: `threadId`, `createdAt` = `created_at_ms`, else `created_at`.
- **TotalsEv** per `threads` row with a `tokens_used` count (≥ 0, zero included): `sessionId`, `tokens` = the CLI's
  running token total for the thread — the only token figure for threads whose rollout is gone. Where a rollout
  remains, its UsageEvs carry the per-response detail of the same tokens: never add the two. A value that is not a
  count is drift `threads.tokens_used:shape`; null emits nothing.
- **SessionEv** (window `lifetime`) per thread with a creation time (else skipped `no-ts`): `start` = created,
  `end` = updated (never before `start`); origin, `surface`, `parentId`, `spawnDepth`, `agentType` from `source` and
  `originator` by the rollouts' rules (`origin.ts`: `exec` → scripted, `mcp` → peer, a subagent source → subagent,
  `originator` exactly `Claude Code` → peer unless the source is a subagent one, else human). `source` text that starts
  with `{`, `[` or `"` is parsed as JSON; JSON that does not parse, or a source that is neither a string nor a subagent
  object, is drift `threads.source:shape` (surface `other`). `models` = [`model`] (model-id-shaped, else `other`);
  `effort` = `reasoning_effort` by the CLI's levels (`effort.ts`, shared with the rollouts' turns: `none`, `minimal`,
  `low`, `medium`, `high`, `xhigh`, `max`, `ultra`; any other string → `other`; null → none);
  `version` = `cli_version` (version-shaped); `projectKey` from `cwd`; `inRepo` = any git column set; `approval` =
  `approval_mode` when a policy the CLI knows (`untrusted`, `on-failure`, `on-request`, `granular`, `never`), and
  `sandbox` = the policy's `type` (or a bare mode) when a mode the CLI or this store knows (`read-only`,
  `workspace-write`, `danger-full-access`, `external-sandbox`, `disabled`, `managed`); anything else `other` — a policy
  that is neither a lower-case token nor JSON with a string `type` is drift `threads.sandbox_policy:shape`. The policy
  is parsed in memory; its paths are never kept.
- **EdgeEv** per `thread_spawn_edges` row: `parentId`, `childId` (ids as above); an empty id is skipped `bad-row`.
- **TurnEv** (window `lifetime`) per finished turn: `status` = `completed`, `failed` or `interrupted`; `ts` =
  `completed_at`, else `started_at` (neither → skipped `no-ts`); `ms` = `duration_ms` when ≥ 0, else
  `completed_at − started_at`; no model or effort (the table has none). `inProgress` turns have not ended: skipped
  `in-progress`, not drift. Any other status is drift `turn-status:(other)` (not a string: `(none)`; the value is
  never kept).
- **Coverage**: `files`/`bytes` = stores read (main file size); `records` = rows read; skipped `no-ts`,
  `in-progress`, `bad-row`, `bad-record` (a row the mapping failed on; warn log `cx.bad-record` once with the count),
  `io-error` (a store that cannot be opened — warn `cx.db-unopenable` — or fails while read, a busy page, a later page
  that fails), `too-large` (a locked store whose private copy — the store and its `-wal` — would exceed
  `MAX_COPY_BYTES`: never copied, `note: "too-large"`); `versions` = `cli_version`s; `from`/`to` = earliest/latest session start or end and turn time. Each store
  is read on its own: one that fails does not stop the other. Only when every store present fails does the reader
  throw, making the coverage `error`.

## history.jsonl (verified locally)

JSONL, one object per line, no `type` field: `session_id` (string — the thread id), `ts` (number, epoch s), `text`
(string — the prompt as typed).

- **PromptEv** per line: window `lifetime`, origin `human`, `sessionId` = `codex:<id>` (UUID verbatim, else keyed hash;
  omitted without a `session_id`), intent, features and `textHash` (keyed hash of the trimmed text) as for Claude
  Code; `isTaskStart` = first prompt of the session or ≥ 30 min after that session's previous prompt; `simToPrev`
  against that session's previous prompt (state for the 256 most recent sessions). No `hasPaste`: the line does not say.
- **DailyEv{source:"codex.history", zone:"local", unit:"prompts"}** per local day (the process time zone), `count` =
  the day's prompts.
- Drift: `line:not-object`, `text:missing`, `ts:missing`, `ts:shape` (a `ts` that is not a time). Skipped: `parse`, `oversize`,
  `io-error`, `bad-ts` (a well-formed time outside the plausible range), `empty` (blank text), `bad-record`, `not-file` (history.jsonl is read only as a regular file).
  Coverage `from`/`to` = first/last prompt time.

## config.toml (header shapes verified locally; schema per the CLI program)

TOML. Read through a symlink (dotfiles setups). Only section header lines are parsed, by a line-level scanner (no TOML
library): values are scanned only to know where they end — basic and literal strings, multi-line strings (`"""`,
`'''`, closed by three to five quotes), arrays and inline tables spanning lines, comments — so a `[` inside a value is
never a header; no value is kept. Lines are streamed (a line over 32 MiB ends the read: skipped `oversize`).

Tables (CLI program): `[features]`, `[tui]`, `[tui.<k>]`, `[notice.<k>]`, `[plugins."<plugin>@<marketplace>"]`,
`[projects."<path>"]` (trust levels), `[profiles.<name>]`, `[mcp_servers.<name>]` (with sub-tables such as `.env`,
`.tools.<tool>`), `[model_providers.<id>]`, and more.

- **profile**: one ConfigEv per distinct `profiles.<name>` (sub-tables count once); `name` kept only when shaped like a
  drift-key type name (`^[a-z][a-z0-9_-]{0,47}$`), else omitted; provenance `authored`.
- **mcp-server**: one per distinct `mcp_servers.<name>`, `name` raw (for the export allowlist; never exported raw),
  provenance `unknown` (as for Claude Code). The table body (command, args, env, headers) is never read.
- **plugin**: one per distinct id among `plugins.<id>` tables and the plugin cache's `<plugin>@<marketplace>` folders,
  `name` raw, provenance `installed`. Whether a plugin is enabled is in the table body, so it is not known.
- Drift: `config.toml:syntax` per line that is not blank, a comment, a header or `key = value`, and per header that does
  not parse; `config.toml:unterminated` when a multi-line value is still open at the end. Skipped: `io-error`,
  `not-file`, `oversize`.

## Plugins, skills, memories (verified locally)

- **Plugins**: the cache folders `plugins/cache/<marketplace>/<plugin>/` (a `<version>/.codex-plugin/plugin.json`
  inside); a config id `<plugin>@<marketplace>` names the same plugin. Only folder names are read; hidden entries are
  skipped; manifests are never opened.
- **skill**: one per `skills/<name>/` folder holding a `SKILL.md` (symlinked folders followed; hidden ones skipped,
  among them `.system`, which holds the bundled skills and a `.codex-system-skills.marker`). Provenance `installed` when
  `<home>/.agents/.skill-lock.json` lists the name (only the keys of its `skills` are read), `unknown` when that lock
  exists but cannot be read, else `authored`. The lock is read only when there is at least one skill.
- **memory-file**: one per `*.md` file directly in `memories/` (the CLI writes `MEMORY.md`, `memory_summary.md`,
  `raw_memories.md` there), no name, provenance `authored` (as for Claude Code); never opened. The folder is a git work
  tree with `rollout_summaries/` and `.codex-baseline/`, which are not counted.
- **Coverage**: `files`/`bytes` = config.toml and the skills lock when read; `records` = ConfigEvs emitted.

## Limits (lifetime layer)

- An index row holds a thread's latest state (model, effort, approval, sandbox, last update, token total); earlier
  settings are not kept, so a thread whose effort changed between turns shows its last one (the rollouts' TurnEvs keep
  each turn's).
  Older rows have no `originator`: a rollout of the same thread driven by Claude Code says `peer` where the index says
  `human`; the merged session is `peer` (a non-human origin wins), but an index-only thread of that kind stays `human`.
  Merged fields other than origin, window, times and models take the rollout's value when it has one, else the index row's.
- Turns exist only for paginated threads; unfinished turns (`inProgress`) are not counted.
- Profiles, MCP servers or plugins defined without a header (dotted keys such as `profiles.x.model = …`, inline tables
  under `[profiles]`) are not counted.
- Skills placed by Codex's own installer skill leave no record and count as `authored`.
- history.jsonl and rollouts both yield prompts, and the thread index and rollouts both yield sessions and turns: they
  are told apart by `source`/`window`, never summed.
