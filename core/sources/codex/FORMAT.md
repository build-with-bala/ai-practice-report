# Codex — rollouts

Reader: `codex.rollouts` (`rollouts.ts`, `tools.ts`, `uuid.ts`).

Evidence: **(verified locally)** = the type or field was confirmed on this machine with the structure probe
(`scripts/probe.ts`) or with count-only checks run by the reader's author. **(CLI program)** = read from the installed
CLI program's own type tables (0.169.0), not seen locally. This file records names and value types only, never values.

## Layout

```
<codex> = $CODEX_HOME, else <home>/.codex (each WSL home: <home>/.codex)
<codex>/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-<thread id>.jsonl          one rollout per thread
<codex>/archived_sessions/…/rollout-*.jsonl                                       archived threads, same format
```

- The file name carries the thread's creation time in **local** time (second precision) and the thread id (a UUIDv7,
  whose first 48 bits are its creation time in Unix ms). A thread is resumed by appending to its rollout.
- Not read by this reader: `auth.json`, `config.toml`, `history.jsonl`, the SQLite stores, `shell_snapshots/`, `log/`.

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

Any other `type` is drift (coverage `unknownTypes`, keyed by the type name when it is a lower-case schema token, else
`(other)`/`(none)`).

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
(verified locally). A fork without that field carries no copied lines.

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

Other payload types are drift: `response_item:<type>`.

**User message content** parts: `{type: "input_text", text}`, `{type: "input_image", image_url}`. The CLI writes
context and notices as user-role messages of their own (verified locally unless marked):
`<environment_context>`, `# AGENTS.md instructions for <dir>` + `<INSTRUCTIONS>`, `<recommended_plugins>`,
`<codex_internal_context source=…>`, `<turn_aborted>`, `<skill>` (the body of a skill the person named),
`<user_shell_command>` (a command the person ran with `!` and its output), `<user_instructions>` (older CLIs;
CLI program), `<subagent_notification>` (CLI program). An attached image is written as the parts
`<image name=[Image #n]>`, the image, `</image>`, followed by the person's text. A reply the person types to a
question the agent sent them is wrapped in `<send_user_message_question_reply>…</send_user_message_question_reply>`.
The CLI also records each actual user input separately: as an `item_completed` `UserMessage` item (newer CLIs) or an
`event_msg` `user_message` (older ones).

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
`EVENT_TYPES`). Other payload types are drift (`event_msg:<type>`); unknown item types are drift as `item:(other)`
(item tags are PascalCase, so they are never copied into coverage).

## What the reader emits

- **Ids.** Session id `codex:<thread id>` — the `session_meta.payload.id` verbatim when UUID-shaped, else its keyed
  hash (before a `session_meta`, the id in the file name). A thread seen in an earlier rollout (e.g. both live and
  archived) is read once: later rollouts naming it count as skipped `duplicate`. `callId` = keyed hash of the call id
  (or of the item id for nested calls).
- **SessionEv** per rollout: origin from `source` — `exec` → scripted; `{subagent: …}` → subagent (`parentId`
  from `thread_spawn.parent_thread_id`, else `parent_thread_id`; `spawnDepth` = `depth`; `agentType` = the role
  when built in, else its keyed hash); any other string, or no source → human; `originator` exactly `Claude Code`
  → peer, whatever the source. `surface` = the source string (lower-case token, else `other`) or `subagent`; `version` =
  `cli_version`; `projectKey` from `cwd`; `inRepo` = `git` present; `models` = distinct `turn_context` models;
  `start`/`end` = first/last own line time. A source object without `subagent` is drift `session_meta.source:shape`.
- **Forked history is skipped**: lines with `ordinal` below `subagent_history_start_ordinal` (copied from the parent)
  yield nothing, so the parent's prompts, tools, turns and usage are not counted twice.
- **PromptEv** for user-role messages of non-subagent threads (a subagent's user messages are its parent's briefs),
  origin = the session's: input text parts joined with "\n" after dropping attached images' `<image …>`/`</image>`
  wrapper parts; a message whose text starts (after whitespace) with `<environment_context`, `<user_instructions`,
  `<recommended_plugins`, `<image`, `<codex_internal_context`, `<turn_aborted`, `# AGENTS.md`, `<skill`,
  `<user_shell_command` or `<subagent_notification` is not a prompt; `<send_user_message_question_reply>` is unwrapped
  to the reply. `hasPaste` = the message attaches images. Intent, features and `textHash` (keyed hash of the trimmed
  text) as for Claude Code; `isTaskStart` = first human prompt or ≥ 30 min since the thread's last line.
- **ToolEv** (`cxToolCalls`), one per call, or per file for apply_patch:
  - shell tools (`exec_command`, `shell`, `shell_command`, `local_shell`): `classifyCommand` of the command line (a
    `[<shell>, -c…, <script>]` argv is unwrapped to the script); a result of plain `shell` becomes `read` (every
    `parsed_cmd` entry `read`) or `search` (every entry `read`, `list_files` or `search`).
  - `apply_patch` → `edit` per file, `editExt` from the path, `linesAdded`/`linesRemoved` from the file's `+`/`-` lines;
    `FileChange` items → the same per changed file (update: the diff's lines; add/delete: the content's lines).
  - `update_plan` → plan; `view_image`/`ImageView` → read; `web_search_call`, `web_search`, the `web` namespace and
    `Extension web.search` → web (`name:"web_search"`); the multi-agent tools (and v1 `wait` with agent ids) and
    `CollabAgentToolCall` → delegate; `sleep` → schedule; `write_stdin` → shell; MCP → `name:"mcp"`, `mcpServer` =
    the server segment (raw, export-allowlisted later); MCP resource tools → mcp; other built-ins → other; any name
    that is not a built-in, or a tool in a namespace that is not the CLI's own → `name:"other"`, category other.
  - Code Mode `exec` cells and their `wait` resumptions are not tool events: the nested calls are, from their items.
    Commands the person ran (`source: user_shell`) are not tool events.
  - A call waits for the item with its `call_id`: `ok` = exit code 0 (else from `status`), `exit`, `ms` from
    `duration`; a linked command's category is re-derived from the command that ran. Items without such a call are
    their own events, timed by `started_at_ms`. Calls no item completes are emitted at the end of the file.
- **TurnEv** at `task_complete` (completed) and `turn_aborted` (interrupted): model and effort of the turn's
  `turn_context` (effort outside the CLI's levels → `other`; model strings not id-shaped → `other`), `ms` =
  `duration_ms`, else the time since the turn's `task_started`.
- **UsageEv** per `token_count` whose `total_token_usage` changed since the previous one, from `last_token_usage`:
  `inTok` = input − cached, `cacheR` = cached, `cacheW` = cache-write, `outTok` = output; model = the turn's.
- **RateLimitEv** per window (`primary`, `secondary`) present with a numeric `used_percent`: `windowMinutes`,
  `resetsAt` (`resets_at` in s or ms, else line time + `resets_in_seconds`); a snapshot equal to the window's previous
  one in the same rollout is not repeated. Rate limits belong to the account: the event has no session.
- **MarkerEv**: `interrupt` per `turn_aborted` (`detail` = `interrupted`, `replaced`, `review_ended`,
  `budget_limited`, else `other`); `compact-auto` per `compacted` line.
- **RolloutFactEv** per fully read rollout: `threadId` = the session id, `uuidTs` = the thread id's UUIDv7 time,
  `fileTs` = the file name's local time; **FileFactEv** likewise.
- **CoverageEv**: `files`/`bytes` of fully read rollouts, `records` = parsed lines; skipped `sniffed`, `oversize`,
  `parse`, `io-error`, `duplicate`, `bad-record` (also logged once per root as `warn cx.bad-record`); `versions` =
  `cli_version`s; `from`/`to` = first/last event time.

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
- Commands the CLI's parser marks `unknown` and `classifyCommand` does not recognise (scripts, loops, file operations)
  stay `shell`.
- `compacted` does not say whether compaction was automatic or asked for; every one is `compact-auto`.
- Usage deduplication compares a `token_count`'s totals with the previous one in the same rollout.
- A session's `end` (and the file's `lastTs`) is the time of its last parsed line; lines dropped before parsing do not
  move it.
- `<image`-led messages are prompts only through the wrapper shape above; any other `<image…` text is treated as injected.
