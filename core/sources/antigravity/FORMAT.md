# Antigravity — CLI store, IDE trajectory summaries, brain artifacts

Readers: `antigravity.cli` (`cli.ts`), `antigravity.history` (`history.ts`), `antigravity.ide` (`ide.ts`),
`antigravity.brain` (`brain.ts`); plugins in `index.ts`.

Evidence: **(verified locally)** = confirmed against real stores with the structure probe (`scripts/probe.ts`: table and
column names, declared types, JSON field names and value classes, protobuf field numbers and wire types — never values),
or by count-only smoke runs of the readers. **(program)** = read from the Antigravity programs' own type tables — the
protobuf descriptors and database column tags built into the CLI and into the IDE's language server — not confirmed in
data. This file records names and value types only, never values.

**Zero-yield.** A coverage window that read records, or found files whose lines it could not use (skipped `parse` or
`oversize`), but yielded none of its reader's primary events is drift `zero-yield` (set by the scan), except records
skipped as `copied` or `empty`, and coverage stamped `aborted`, so a renamed field or a changed container never passes
as a quiet store; files with no lines at all stay `empty`; so does a
file whose only unusable line is its last line with no line end (skipped `partial`: a record still being written). Primary events: `antigravity.cli` (`detail`) — a session,
prompt or tool call (its `lifetime` window is checked by its columns); `antigravity.history` — a prompt;
`antigravity.ide` — a session. `antigravity.brain` is not guarded: its records are its own markers.

**Times.** Wherever this file says an item without a time is skipped `no-ts`, an item whose time is well-formed but
outside the plausible range (before 2015, or more than two days ahead) is skipped `bad-ts` instead (Go's zero time,
written for a time never set, is no time).

**io-error.** A file or store that cannot be opened or read counts as skipped `io-error`, and so does a never-opened
file — a credential, token or key file, by its name or by the name of the file behind a link (`core/io/observe.ts`):
the engine refuses it before it is opened, so it reads as unreadable.

## Layout

```
<home>/.gemini/antigravity-cli/                                      antigravity.cli (also per WSL home)
  conversation_summaries.db                                          one row per conversation
  conversations/<conversation id>.db                                 its steps
  brain/<conversation id>/.system_generated/logs/transcript.jsonl    one record per step
  history.jsonl                                                      antigravity.history: what was typed at the CLI prompt
  brain/<conversation id>/{task,implementation_plan,walkthrough}.md  antigravity.brain (existence only)
<home>/.gemini/antigravity/brain/<conversation id>/<artifact>.md     antigravity.brain (the IDE's; unverified)
vscodeUser(env, "Antigravity")/globalStorage/state.vscdb             antigravity.ide
vscodeUser(env, "Antigravity IDE")/globalStorage/state.vscdb         antigravity.ide (the app's folder has either name)
not read: brain/<id>/.system_generated/logs/{transcript_full.jsonl, chunks/, media/}, brain/<id>/.system_generated/
          {steps/, messages/, tasks/}, brain/<id>/{scratch/, .user_uploaded/}, the CLI's settings.json, its state and summary
          .pb/.pbtxt files, log/, cache/, annotations/, implicit/, knowledge/, presence/, plugin_data/, updater/, bin/;
          <home>/.gemini/antigravity/conversations/*.pb (the IDE's older store); state.vscdb.backup, storage.json,
          workspaceStorage/
```

Conversation ids are UUIDs (version 4, so they carry no time; verified locally); a conversation's step store and brain
folder are named by its id (verified locally). Session ids are `antigravity:<id>` — the id verbatim when UUID-shaped, else
its keyed hash — in every reader, so a conversation's lifetime row, its steps and transcript, its IDE summary and its brain
artifacts share one session (sessions with the same id merge in the event store).

## conversation_summaries.db (verified locally; column tags per the program)

SQLite written through an ORM over a Go SQLite driver (program). One table, `conversation_summaries`: `conversation_id`
TEXT (primary key), `title`, `preview` TEXT, `step_count` INTEGER, `last_modified_time` datetime, `workspace_uris` TEXT,
`status`, `source`, `project_id`, `agent_name`, `parent_conversation_id` TEXT, `nesting_depth` INTEGER, `battle_id`,
`winning_conversation_id` TEXT, `not_fully_idle`, `killed` numeric, `last_user_input_time` datetime,
`last_user_input_step_index` INTEGER, `app_data_dir` TEXT, `raw_summary` BLOB, `group_id` TEXT. Program: the text columns
default to `''` (so "no parent" and "no battle" are empty strings), booleans are stored 0/1, `workspace_uris` is a JSON
array of URIs, and the time columns are not null — Go times as text, `YYYY-MM-DD hh:mm:ss.fffffffff±hh:mm` (the zero time
when never set, which `toEpochMs` rejects as implausible; a row with no other time is skipped `no-ts`, while a set time
outside the plausible range is `bad-ts`). There is no creation time.

- **Columns read**: `conversation_id`, `step_count`, `last_modified_time`, `last_user_input_time`, `workspace_uris`,
  `parent_conversation_id`, `nesting_depth`, `killed`; and, inside SQL only (their values never leave SQLite), `battle_id`
  as a presence test (`(COALESCE("battle_id", '') <> '') AS battle`), `winning_conversation_id` against the row's own id
  (`(COALESCE("winning_conversation_id", '') NOT IN ('', "conversation_id")) AS battle_loser`), and `source` mapped by a fixed
  `CASE COALESCE("source", '') WHEN '<enum name>' THEN '<code>' … ELSE 'other' END AS src` (below). Rowid pages of 1,000
  (`WHERE rowid > ? ORDER BY rowid LIMIT ?`). Each one missing is drift `missing-column:<name>` (without `conversation_id`
  nothing is read); no table is drift `missing-table:conversation_summaries`; `WITHOUT ROWID`, or a first page that fails for
  any reason but a busy store, is drift `table-unreadable:conversation_summaries`. A full page whose last rowid is not a
  safe integer above the page's start ends the table as drift `page-stalled:<table>` (here and for `steps`); the rows
  already read stay.
- **Never selected**: `title`, `preview`, `raw_summary` (the summary message, title inside), `agent_name`, `status`,
  `project_id`, `app_data_dir`, `group_id`, `not_fully_idle`, `last_user_input_step_index`, and the values of `battle_id`,
  `winning_conversation_id` and `source`.
- **`source`** holds a `CortexTrajectorySource` name (program). Codes, from the program's enum: unset (`''`,
  `CORTEX_TRAJECTORY_SOURCE_UNSPECIFIED`) → `none` (origin `human`); `…_CLI`, `…_CASCADE_CLIENT`, `…_INTERACTIVE_CASCADE`,
  `…_JETBOX` (the desktop app), `…_EXPLAIN_PROBLEM`, `…_REFACTOR_FUNCTION` (IDE actions the person starts) → `human`;
  `…_SDK`, `…_EVAL`, `…_EVAL_TASK`, `…_ASYNC_PRR`, `…_ASYNC_CF`, `…_ASYNC_SL`, `…_ASYNC_PRD`, `…_ASYNC_CM`, `…_REPLAY` →
  `scripted`; `…_AGENT_API` (the Agent API: the `agentapi` tool other agents and plugins drive Antigravity through, per the
  program) → `peer`; `…_SUBAGENT` → `subagent`; any other value → `other`: origin `system` and drift
  `conversation_summaries.source:(other)`.
- **SessionEv** (window `lifetime`) per row: `start`/`end` = the earlier/later of `last_user_input_time` and
  `last_modified_time` (the steps and transcript, merged in by id, reach back further); `surface` `battle` when a battle id
  is set, else `cli`; origin `subagent` when `parent_conversation_id` names another conversation, `nesting_depth` is above 0
  or the source is a subagent's, else the source's origin; `parentId` = the parent's session; `spawnDepth` (subagents only) =
  `nesting_depth` when at least 1, else 1; `projectKey` from the first `file:` URI of `workspace_uris` (`null` or `[]`: none;
  anything but a JSON array: drift `conversation_summaries.workspace_uris:shape`); `models` empty (no column names one).
  `step_count` 0 is skipped `empty-session`; neither time plausible `no-ts`; no id `bad-row`.
- **Battle forks**: a fork whose `winning_conversation_id` names another conversation lost; its transcript's inputs are
  copies of the winner's and are skipped `battle-copy` (its session is still emitted, `surface: "battle"`). The winner's,
  and every fork's before a winner is set, are prompts.
- **MarkerEv** `interrupt` per killed conversation, `detail: "killed"`, at its `end` with `proxyTs: true` (the row records
  no time of the kill: its last change stands in, and is never counted as activity).

## conversations/<conversation id>.db (verified locally; meanings per the program)

SQLite, one store per conversation. Tables: `steps`, `gen_metadata` (`idx`, `data` BLOB, `size`), `trajectory_meta`
(`trajectory_id`, `cascade_id` TEXT, `trajectory_type`, `source` INTEGER), `trajectory_metadata_blob` (`id`, `data`),
`executor_metadata`, `battle_mode_infos`, `parent_references` (`idx`, `data`). Only `steps` is read.

`steps`: `idx` INTEGER, `step_type` INTEGER, `status` INTEGER, `has_subtrajectory` numeric, `metadata`, `error_details`,
`permissions`, `task_details`, `render_info`, `step_payload` BLOB, `step_format` INTEGER — the fields of the program's step
message stored apart (program): `step_type` = `CortexStepType`, `status` = `CortexStepStatus`, `metadata` = a serialized
`CortexStepMetadata`, `error_details` = a serialized `CortexErrorDetails`, `step_payload` = the step's payload message.

- `CortexStepType` (program; the enum's 118 names are the table in `cli.ts`, also the transcript's `type` values): e.g. 5
  `CODE_ACTION`, 7 `GREP_SEARCH`, 8 `VIEW_FILE`, 14 `USER_INPUT`, 15 `PLANNER_RESPONSE`, 17 `ERROR_MESSAGE`, 21
  `RUN_COMMAND`, 56 `OPEN_BROWSER_URL`, 132 `GENERIC`.
- `CortexStepStatus` (program): 1 pending, 2 running, 3 done, 4 invalid, 5 cleared, 6 canceled, 7 error, 8 generating,
  9 waiting, 11 queued, 12 interrupted.
- `CortexStepMetadata` (program): `created_at` 1, `completed_at` 8, `started_at` 32 (`google.protobuf.Timestamp`:
  `seconds` 1, `nanos` 2), `source` 3, `tool_call` 4 (`ChatToolCall`: `id` 1, `name` 2, `arguments_json` 3), `model_usage`
  9, `tool_summary` 30, `tool_action` 31, and more.
- `CortexStepRunCommand` (program): `command_line` 23, `command` 1, `cwd` 2, `exit_code` 6 (written for a 0 exit too:
  count-only check), `user_rejected` 14, output fields. A step message can wrap it as `run_command` 28 (beside its own
  `type` 1); which of the two the payload holds is unverified, so both are read.
- **GENERIC steps** (verified locally; the CLI records its own tool calls so): the CLI's own tools carry no step type
  of their own; the tool's name is the metadata's `tool_call.name`. Names per the program's tool registry and tool safety
  lists (`read_file`, `search_in_file`, `edit_file`, `write_file`, `run_command`, `manage_task`, `invoke_subagent`, …; the
  table in `cli.ts`); the run_command call's arguments carry `CommandLine` (program).

What the reader does:

- **Query**: `SELECT rowid AS rid, "step_type", "status", CASE WHEN length("metadata") <= 1048576 THEN "metadata" END AS
  metadata, CASE WHEN length("metadata") > 1048576 THEN substr("metadata", 1, 64) END AS mhead, ("error_details" IS NOT NULL
  AND length("error_details") > 0) AS err, CASE WHEN "step_type" = 21 AND length("step_payload") <= 1048576 THEN
  "step_payload" END AS payload, ("step_type" = 21 AND length("step_payload") > 1048576) AS pbig FROM "steps" WHERE rowid > ?
  ORDER BY rowid LIMIT ?`, pages of 32. The error details never leave SQLite; the payload leaves it only for run commands; a
  metadata blob or payload above 1 MiB never leaves it (the metadata holds every call's arguments — whole files — and the
  payload the command's output), so a page holds at most about 64 MiB. Columns checked first (each missing: drift
  `missing-column:<name>`; without `step_type` nothing is read; no table: `missing-table:steps`; `WITHOUT ROWID` or a failing
  first page: `table-unreadable:steps`).
- **Time**: the metadata is decoded in memory and only `created_at` is taken; without it the step is skipped `no-ts`;
  metadata that is not protobuf is drift `steps.metadata:shape`. Oversize: each blob above the cap is skipped `oversize`,
  and the step is still mapped by its type, without what the blob held. Of an oversize metadata blob its first 64 bytes are
  read and only the complete fields among them used — the program writes a message's fields in number order, so
  `created_at` (1) comes first; without it there, `no-ts`. An oversize run-command payload gives no command line or exit
  code (the call's arguments still may).
- **MarkerEv** `error` per step with error details (presence only), at the step's time.
- **ToolEv** per tool step, `name` = its step type's name in lower case, category by type: edit (`CODE_ACTION`,
  `FILE_CHANGE`, `MOVE`, `DELETE_DIRECTORY`), shell (`RUN_COMMAND`, `SHELL_EXEC`, `SEND_COMMAND_INPUT`, `COMMAND_STATUS`,
  `READ_TERMINAL`, `RESTART_DEV_SERVER`), read (`VIEW_FILE`, `LIST_DIRECTORY`, `VIEW_CODE_ITEM`, `VIEW_FILE_OUTLINE`),
  search (`GREP_SEARCH`, `FIND`, `CODE_SEARCH`, `MQUERY`, `INTERNAL_SEARCH`, `TRAJECTORY_SEARCH`, `FIND_ALL_REFERENCES`,
  `MOMA`), browser (every type whose name holds `BROWSER`), web, mcp, notebook, build, test, lint, package, cloud, db, git,
  delegate, plan, schedule (the table in `cli.ts`), meta (`NOTIFY_USER`, `ASK_QUESTION`, `FINISH`: questions and notices
  to the person and the end of a turn — bookkeeping, counted apart from actions), any other tool step `other`. A step whose
  category is a check (`BLAZE_TEST_TARGETS` test, `COMPILE`/`COMPILE_APPLET`/`BLAZE_BUILD_TARGETS` build, `LINT_APPLET`
  lint) lists that check in `checks`. Not tool events: the person's input (its prompts come from the transcript), the
  model's replies, checkpoints, system, ephemeral and context messages, proposals and choices (`NOT_TOOLS` in `cli.ts`). An
  unknown step type is drift `step-type:<n>` (`(other)` beyond 9999).
  - GENERIC steps take the name and category of the tool their call names when it is a built-in name; an `mcp_`/`mcp-`
    name is `mcp` (the server inside it is never parsed out); any other name, or none, is `generic`, category `other`. The
    bookkeeping calls — `ask_question`, `ask_permission`, `ask_custom_permission`, `notify_user`, `finish` — are `meta`.
  - Run commands (typed, or a GENERIC `run_command` call) take `classifyCommand` of the command line (category, checks,
    toolchain) — the payload's `command_line` (else `command`), else the call's `CommandLine` argument — and `exit`
    from the payload's `exit_code` (`ok` = exit 0). A payload whose `user_rejected` is set (program) was denied: `outcome: "denied"`, no `ok` or `exit`,
    and a `denial` marker (`detail: "user"`). Only a run_command call's arguments are parsed; nothing of them is kept.
  - From the status: done → `ok` true; error → `ok` false; canceled → `outcome: "cancelled"`, interrupted →
    `outcome: "interrupted"` (neither has `ok` or `exit`); others none.
- **SessionEv** (window `detail`) per conversation with a timed step or transcript record: `start`/`end` = its earliest/latest
  step and record times, origin and surface as its summary row says (else `human`, `cli`), `models` = the transcript's model
  names. It merges with the summary row's session (start earliest, end latest, window detail).

## transcript.jsonl (verified locally)

JSONL, one object per step: `step_index` (number), `type` (string: a `CortexStepType` name), `source` (string: a
`CortexStepSource` name — `MODEL`, `USER_IMPLICIT`, `USER_EXPLICIT`, `SYSTEM`, `SYSTEM_SDK`, `UNSPECIFIED`; program),
`status` (string), `created_at` (string), `content` (string), `thinking` (string), `tool_calls[]` {`name`, `args` {…,
`toolAction`, `toolSummary`}}, `input_tokens`, `output_tokens`, `cache_read_tokens` (numbers, on model records), `error`
(string), `media[]` {`mime_type`, `uri`}, `truncated_fields[]` (strings: fields cut short). The records carry no model
field (unverified). `input_tokens` excludes the cached tokens, which `cache_read_tokens` counts apart (unverified).

- **PromptEv** (window `detail`) per `USER_INPUT` record from `USER_EXPLICIT`, its origin the conversation's (`human`,
  `scripted`, `peer` or `system`, from the summary row; `human` without one) — unless the conversation is a subagent's (its
  inputs are its parent's briefs) or a losing battle fork's (copies of the winner's: skipped `battle-copy`): intent,
  features and `textHash` (keyed hash of the trimmed `content`) from the text in memory; `hasPaste` when an `image/` medium
  is attached; `isTaskStart` = the conversation's first prompt or ≥ 30 min after its previous record; `simToPrev` against its
  previous prompt. No time: skipped `no-ts`; blank: `empty`; no string `content`: drift `transcript.content:missing`.
  Implicit inputs are not prompts.
- **UsageEv** per record with a token count: `inTok` = `input_tokens`, `outTok` = `output_tokens`, `cacheR` =
  `cache_read_tokens`, `cacheW` = `cache_write_tokens` (unverified), each 0 when absent; `model` = the record's
  `model` when it is model-id-shaped (else `other`; no model field: `other`). No time: skipped `no-ts`.
- Drift: `transcript.type:(other)` and `transcript.source:(other)` for names outside the program's enums (the name is
  never kept; missing: `(none)`), `transcript:not-object`. Every other known record is counted and
  dropped; model replies, thinking, tool calls, errors and media are never kept.

## history.jsonl (`antigravity.history`; verified locally)

The CLI's prompt log is its own lifetime source, so its prompts are never mistaken for, or added to, the transcripts'.
JSONL, one line per entry typed at the CLI prompt: `display` (string), `timestamp` (number), `conversationId` (string; not
on every line), `workspace` (string), `type` (`slash_command` on slash commands, absent otherwise).

- **PromptEv** (source `antigravity.history`, window `lifetime`, origin `human`) per line, slash commands included (their
  intent is `command`): `sessionId` from `conversationId`; intent, features and `textHash` from `display` in memory;
  `isTaskStart` per conversation (first, or ≥ 30 min since its previous line), state for the 256 most recent conversations.
  `projectKey` = the keyed hash of `workspace` (a path, or a `file:` URI read as its path): the key a session of that
  folder carries; the folder is never kept, nor registered for repo signals.
- **DailyEv** (source `antigravity.history`, `zone: "local"`, `unit: "prompts"`) per local day, `count` = its
  prompts and slash commands.
- Drift: `history:not-object`, `history.type:(other)` (the type is never kept), `history.display:missing`, `history.timestamp:missing`,
  `history.timestamp:shape` (a `timestamp` that is not a time). Skipped: `bad-ts` (a well-formed time outside the
  plausible range), `empty`, `parse`, `oversize`, `io-error`, `bad-record`, `not-file` (a `history.jsonl` that is not a
  regular file; a link to one is read through).
- **Coverage** (window `lifetime`): `files`/`bytes` = the file read to its end, `records` = its lines, `from`/`to` =
  first/last prompt time; `empty` without the file.

## CLI coverage

`antigravity.cli` reports one coverage per window; no versions. Each store is read on its own; only when every store
present fails is the source an error; a window whose stores are all unreadable is `error` with `note: "unreadable"`,
one without any store `absent`. A locked store above `MAX_COPY_BYTES` keeps that reason instead: its window notes
`too-large` (warn `ag.db-too-large`), and it is no error of the source.

- `lifetime` — the conversation index (`conversation_summaries.db`): `files`/`bytes` = the store, `records` = summary
  rows, `from`/`to` = the span of its sessions. Skipped: `empty-session`, `no-ts`, `bad-row`, `io-error`, `too-large`,
  `bad-record`.
- `detail` — the step stores and transcripts: `files`/`bytes` = stores whose tables were listed and JSONL files read to
  their end; `records` = step rows and transcript records; `from`/`to` = first/last time of its events and detail
  sessions. Skipped: `no-ts`, `empty`, `battle-copy`, `parse`, `oversize` (a JSONL line above 32 MiB, or a step blob
  above 1 MiB), `io-error` (a store that cannot be opened — warn `ag.db-unopenable` — or read, a busy or failing later
  page, a JSONL read error), `too-large` (a locked store whose private copy — the store and its `-wal` — would exceed
  `MAX_COPY_BYTES`: never copied, warn `ag.db-too-large`), `bad-record` (a row or record the mapping failed on; warn
  `ag.bad-record` with the count, both windows').

## state.vscdb (`antigravity.ide`)

SQLite, VS Code's `ItemTable` (`key` TEXT, `value` BLOB; verified locally) — which also holds the account
(`antigravityUnifiedStateSync.oauthToken`, `antigravityAuthStatus`) and every other setting.

- **Query**: only `SELECT value FROM ItemTable WHERE key = ?`, bound to `antigravityUnifiedStateSync.trajectorySummaries`;
  never by pattern. `key`/`value` checked first (drift `missing-column:<name>`; no table: `missing-table:ItemTable`).
- **Value**: base64 text of a unified-state-sync `Topic` (program): `data` 1, repeated entries {`key` 1 (string), `value` 2
  (`Row` {`value` 1 (string: base64 text of a `CascadeTrajectorySummary`), `e_tag` 2})}. The entry and row layout is verified
  locally (the probe shows entry fields 1 and 2 and a row field 1 that is not itself protobuf: base64 text); the summaries
  decode in a count-only smoke run. The key can hold an empty value: no conversations.
- `CascadeTrajectorySummary` (program): `summary` 1 (the title), `step_count` 2, `last_modified_time` 3, `trajectory_id` 4,
  `status` 5, `created_time` 7, `waiting_steps` 8, `workspaces` 9 (`CortexWorkspaceMetadata`: `workspace_folder_absolute_uri`
  1, `git_root_absolute_uri` 2, `repository` 3, `branch_name` 4), `last_user_input_time` 10, `latest_notify_user_step` 12,
  `latest_task_boundary_step` 14, `annotations` 15, `last_user_input_step_index` 16, `trajectory_metadata` 17,
  `has_active_children` 18, `battle_mode_info` 19, `source` 20, `not_fully_idle` 21, `trajectory_type` 22, `killed` 23.
  The reader uses `TRAJ_FIELDS` = {`id`: 4, `steps`: 2, `created`: 7, `updated`: 3, `workspace`: 9}.
- **SessionEv** (window `lifetime`, origin `human`, `surface: "ide"`) per entry: id = the entry key (the conversation's
  id, as the CLI's stores and the brain folders name it), else the summary's `trajectory_id`; `start` = `created_time`,
  else `last_modified_time`; `end` = the later of the two; `projectKey` from the first workspace folder URI; `models` empty.
  Nothing else of the summary is kept. No steps: skipped `empty-session`; no time `no-ts`; no id `no-id`.
- Drift: `trajectorySummaries:shape` (the value does not decode to topic entries), `trajectorySummaries.entry:shape` (an
  entry, its row or its summary does not decode), `trajectorySummaries:no-steps` (every entry that decodes lacks a step
  count: proto3 writes no 0, so a moved field would look like empty conversations). A NULL or empty value is no
  conversation.
- **Coverage** (window `lifetime`): `files`/`bytes` = the store, `records` = topic entries. A store that cannot be opened or
  read makes the source an error, unless it is a locked store above `MAX_COPY_BYTES` (`note: "too-large"`, warn
  `ag.db-too-large`).

## Brain artifacts (`antigravity.brain`)

`<brain>/<conversation id>/task.md`, `implementation_plan.md`, `walkthrough.md` (the agent's plan artifacts;
unverified). Each brain folder is its own candidate.

- **MarkerEv** `plan-artifact` per regular file present (`lstat` only: never opened), `detail` = `task`,
  `implementation_plan` or `walkthrough`, `ts` = its last modification with `proxyTs: true` (a file time stands in for
  when it was written; it is never activity), `sessionId` from the folder's name. Hidden entries and every other file are
  ignored.
- **Coverage** (window `lifetime`): `records` = markers; `files`/`bytes` 0 (nothing is read); skipped `no-ts`.

## Never read

- `ItemTable` keys other than the trajectory summaries, and never by pattern: `antigravityUnifiedStateSync.oauthToken`,
  `antigravityAuthStatus` and the account's other values are never selected.
- Summary text columns (`title`, `preview`, `raw_summary`, `agent_name`) and the other columns listed above; the values of
  the battle id, the winning fork's id and the source (used inside SQL only).
- Step metadata and run-command payloads above 1 MiB (only the metadata's first 64 bytes leave SQLite).
- Step error details, permissions, task details, render info, non-command payloads; tool-call arguments other than a
  run_command's `CommandLine`; tool summaries; command working folders and output; the other tables of the step stores.
- Transcript replies, thinking, tool calls, errors and media; `transcript_full.jsonl`; history workspace paths.
- IDE summary titles, latest steps, annotations, battle details and trajectory metadata; plan artifact contents.

## Limits

- The summaries hold no creation time: a conversation with neither steps nor transcript starts at its last user input.
- Usage has no model (the transcript names none; the steps' model usage and `gen_metadata` are not read): `other`.
- GENERIC run commands have no exit code (their result sits in the payload, which is selected for typed run commands only);
  their `ok` comes from the status.
- Origin: the IDE summaries' `source` (20) and trajectory metadata (parent, nesting) are not read, so IDE subagent and
  SDK-driven trajectories count as human; the CLI's come from its summary rows.
- Battle forks: until a winner is set, every fork's copied inputs count as prompts; afterwards only the winner's.
- An oversize step (a blob above 1 MiB) keeps its type's category but loses what the blob held: a generic step its tool's
  name (`generic`), a run command its command line and exit code from that blob, the step its time when `created_at` is not
  among the metadata's first 64 bytes.
- A long input can be cut short in the transcript (`truncated_fields`); its features are computed on what is there.
- The prompt log and the transcripts both yield prompts for the same inputs: they are told apart by `source` and `window`,
  never summed.
- The IDE entry key is taken as the conversation id (unverified); the
  summary's own `trajectory_id` is only the fallback.
- Step types, statuses, sources and tool names follow the installed programs; a newer program's additions surface as drift
  (types, sources) or as `generic`/`other` (tool names).
