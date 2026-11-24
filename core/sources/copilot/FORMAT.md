# GitHub Copilot — VS Code chat sessions, Copilot CLI, JetBrains presence

Readers: `copilot.vscode` (`index.ts`, `journal.ts`, `map.ts`, `install.ts`; the session store reader in `cli.ts`),
`copilot.cli` (`cli.ts`, beta: built from the CLI's documentation, no CLI store verified), `copilot.jetbrains`
(`index.ts`, beta).

Evidence: **(verified locally)** = confirmed against real stores with the structure probe (`scripts/probe.ts`, which
prints names and value types, never values) or with count-only checks run by the reader's author. **(VS Code program)** = read from VS Code 1.138's own workbench code (its
chat session serializer, journal reader and response model). **(extension program)** = read from the bundled GitHub
Copilot Chat extension 0.66 (its `package.json` and code). **(unverified)** = from the extension's code and the CLI's
published event list only, not verified against a real store. This file records names and value types only, never values.

**Zero-yield.** A coverage window that read records, or found files whose lines it could not use (skipped `parse` or
`oversize`), but yielded none of its reader's primary events is drift `zero-yield` (set by the scan), except records
skipped as `copied` or `empty`, and coverage stamped `aborted`, so a renamed field or a changed container never passes
as a quiet store; files with no lines at all stay `empty`; so does a
file whose only unusable line is its last line with no line end (skipped `partial`: a record still being written). Primary events: `copilot.vscode` and `copilot.cli`
(`detail`) — a session, prompt or tool call; their `lifetime` windows (the session stores) are checked by their
columns instead, and `copilot.jetbrains` reads no records.

**io-error.** A file or store that cannot be opened or read counts as skipped `io-error`, and so does a never-opened
file — a credential, token or key file, by its name or by the name of the file behind a link (`core/io/observe.ts`):
the engine refuses it before it is opened, so it reads as unreadable.

## Layout

```
<user> = vscodeUser(env, app) for app in Code, Code - Insiders, VSCodium
         (macOS ~/Library/Application Support/<app>/User, Windows %APPDATA%\<app>\User, Linux ~/.config/<app>/User)
<user>/workspaceStorage/<workspace>/chatSessions/<session id>.jsonl   journal (VS Code 1.109+, Feb 2026 on)
<user>/workspaceStorage/<workspace>/chatSessions/<session id>.json    legacy session (one JSON document)
<user>/workspaceStorage/<workspace>/workspace.json                    {folder: <file URI>} or {workspace: <.code-workspace URI>}
<user>/globalStorage/emptyWindowChatSessions/<session id>.{jsonl,json}  sessions of windows without a folder
<user>/globalStorage/github.copilot-chat/session-store.db            the extension's local session index (below)
<home>/.copilot/session-state/<session id>/events.jsonl              Copilot CLI session events (unverified)
<home>/.copilot/session-store.db                                     Copilot CLI session index
<config>/github-copilot/<ide>/chat-*-sessions/*nitrite.db           JetBrains chat stores (<config> = $XDG_CONFIG_HOME or
                                                                     ~/.config; %LOCALAPPDATA% on Windows)
never opened: <config>/github-copilot/apps.json, hosts.json (OAuth tokens); <home>/.copilot/config.json, logs/, ide/;
              <workspace>/GitHub.copilot-chat/transcripts/*.jsonl (the extension's copies of sessions for hooks);
              globalStorage/transferredChatSessions/ (sessions in flight between windows)
```

- VS Code names a session file by its session id (a UUID) (verified locally). The `chatSessions` folder of the
  workspace `no-workspace` is matched like any other workspace (VS Code's earlier home of empty-window sessions).
- VS Code creates a session when the chat view opens, so a session file can hold no requests (VS Code program).
- A session can sit in two workspace folders: VS Code migrates a window's sessions when its workspace changes, and the
  session goes on in the new folder while the old copy stays (VS Code program). The copy written last is the complete one.

## The journal (`.jsonl`) (VS Code program; structure verified locally)

One JSON object per line, applied in order to rebuild the session object (`replayJournal` in `journal.ts`, which follows
VS Code's own reader):

| `kind` | fields | meaning |
|---|---|---|
| 0 | `v` | initial entry: the session object becomes `v` (written first, and again whenever VS Code compacts the log) |
| 1 | `k`, `v` | set `v` at path `k` |
| 2 | `k`, `v?`, `i?` | push: the array at `k` (created when absent) is cut to length `i` when `i` is given, then the items of `v` are appended |
| 3 | `k` | delete the value at `k` (an array item is set to undefined in place, as VS Code does) |

`k` is an array of object keys (strings) and array indices (numbers), e.g. `["requests", <n>, "response"]`. VS Code
writes a push with `i` when an array's tail changed (a request removed or re-sent), and `kind:1` for whole values whose
identity changed. A set or delete at an empty path changes nothing (as in VS Code). Path keys can be data-like (keys of
maps in the session), so they are never copied anywhere. Unknown kinds make VS Code reject the file; the reader counts
them as drift `journal-kind:<n>` and goes on. A record that is not an object, comes before the first initial entry, has a
path that is not an array of keys and non-negative integers, leads through a missing value, pushes onto a non-array or
pushes a non-array, or names `__proto__`, `constructor` or `prototype` anywhere in its path is skipped as `bad-record`.
The replay walks own properties only, so no record can reach an object prototype. Inside an array a path may only name
an item within it — a number, at most the array's length for a set or push (the item just past the end appends), below it
for a delete — and a push's `i` must be within the array's length; anything else (a string index, `length`, an index far
past the end) is a `bad-record`, so a corrupt record cannot grow a sparse array of billions of holes.

The session object (version 3) — written by the journal serializer (VS Code program): `version` (number, 3),
`creationDate` (epoch ms), `customTitle`, `initialLocation` (`panel`, `editor`, `terminal`, `notebook`), `inputState`
{`inputText`, `attachments`, `mode{id, kind}`, `selectedModel{identifier, metadata{…, auth{accountLabel, providerLabel}}}`,
`selections`, `permissionLevel`, `contrib`}, `responderUsername`, `sessionId`, `requests[]`, `hasPendingEdits` (bool),
`repoData`, `pendingRequests[]` {`id`, `request`, `kind`, `sendOptions`}, `workingDirectory` (URI string).

## Legacy sessions (`.json`) (verified locally; names per VS Code program)

One document, the same version-3 object with older fields: `version`, `sessionId`, `creationDate`, `lastMessageDate`
(epoch ms), `customTitle`, `initialLocation`, `isImported` (bool), `requesterUsername`, `requesterAvatarIconUri`,
`responderUsername`, `responderAvatarIconUri`, `inputState` (later files), `requests[]`.

## Requests

Fields (verified locally unless marked): `requestId`, `timestamp` (epoch ms), `message` {`text`, `parts[]` {`kind`,
`text`, `range`, `editorRange`}} (very old files: a string), `variableData` {`variables[]`}, `response[]` (parts, below),
`responseId`, `result` {`timings` {`firstProgress`, `totalElapsed`} (ms), `errorDetails` {…}, `details`, `metadata` {…
`renderedUserMessage`, `toolCallRounds`, `toolCallResults`, `modelMessageId`, …}}, `followups`, `isCanceled` (bool, older
files), `modelState` {`value`, `completedAt`} (later files), `agent` {`id`, `name`, `fullName`, `modes[]`,
`extensionId`, `extensionVersion`, `locations`, `slashCommands`, …}, `modelId` (string `<vendor>/<model>`), `editedFileEvents[]`
{`eventKind`, `uri`}, `contentReferences`, `codeCitations`, `confirmation`, `shouldBeRemovedOnSend`, `responseMarkdownInfo`,
`timeSpentWaiting` (number). Added by the journal serializer (VS Code program): `responseTimestamp`, `elapsedMs`,
`completionTokens`, `promptTokens`, `outputBuffer`, `promptTokenDetails`, `copilotCredits`, `modelTotals`,
`sessionCopilotCredits`, `modeInfo` {`kind` (`ask`, `edit`, `agent`), `isBuiltin`, `modeId`, `permissionLevel`, …},
`isSystemInitiated` (bool), `requestSource`, `systemInitiatedLabel`, `terminalExecutionId`, `origin`, `hiddenFromTranscript`.

- `modelState.value` (VS Code program): 0 pending, 1 complete, 2 cancelled, 3 failed, 4 waiting for input; `completedAt`
  (epoch ms) is set for 1–3. The journal serializer always writes `isCanceled` as undefined: a cancel is `modelState.value: 2`.
- `timeSpentWaiting` is **not** a turn duration (VS Code program): the older serializer stored the time spent waiting for
  tool confirmations (ms), the journal serializer stores the response's start time (epoch ms) under that name.
  `elapsedMs` is the response's working time; `result.timings.totalElapsed` the wall-clock time to the result.
- Participants (`agent.id`, extension program): `github.copilot.default` (Ask, modes `ask`), `github.copilot.editingSession`
  (Edit, modes `edit`), `github.copilot.editsAgent` (agent mode, modes `agent`), `github.copilot.editingSessionEditor`,
  `github.copilot.notebook`, `github.copilot.notebookEditorAgent`, `github.copilot.vscode`, `github.copilot.terminal`,
  `github.copilot.terminalPanel`; older files also `github.copilot.workspace` (verified locally). VS Code's own setup
  participants answer while Copilot is not set up (VS Code program).

## Response parts (`response[]`)

Markdown is stored as the bare markdown object {`value`, `isTrusted`, `supportThemeIcons`, `supportHtml`, `uris`} without
a `kind` (VS Code program; verified locally). Every other part has `kind` (VS Code program; the common ones verified
locally): `toolInvocationSerialized`, `prepareToolInvocation`, `textEditGroup`, `notebookEditGroup`, `codeblockUri`,
`inlineReference`, `thinking`, `undoStop`, `mcpServersStarting`, `elicitationSerialized`, `progressTaskSerialized`,
`progressMessage`, `confirmation`, `command`, `markdownVuln`, `multiDiffData`, `workspaceEdit`, `externalEdit`, `hook`,
`extensions`, `planReview`, `autoModeResolution`, `clearToPreviousToolInvocation`, `systemNotification`, `pullRequest`,
`questionCarousel`, `warning`, `info`, `treeData`, `disabledClaudeHooks`, and older `markdownContent`, `toolInvocation`,
`elicitation`, `progressTask`, `codeCitation`, `mcpServersStartingSlow`, `mcpAuthenticationRequired`, `voiceProgress`.
Any other kind is drift `part:(other)` (the kind itself is never kept).

- `toolInvocationSerialized` {`toolId`, `toolCallId`, `source` {`type` (`internal`, `extension`, `mcp`), `label`,
  `serverLabel` (MCP), …}, `isConfirmed` (`{type}`: 0 denied or not run, 1 no confirmation needed, 2–3 approved by a
  setting, 4 approved by the person, 5 skipped; older files a boolean), `isComplete`, `invocationMessage`,
  `pastTenseMessage` (markdown with `uris`: a map from URI strings to URI objects), `originMessage`, `presentation`,
  `resultDetails` (locations `[{uri, range}]`, or `{input, output[], isError}`), `toolSpecificData`, `generatedTitle`,
  `subAgentInvocationId`}. `toolSpecificData.kind`: `terminal` {`commandLine` {`original`, `toolEdited`, `userEdited`,
  `forDisplay`}, `language`, `terminalToolSessionId`, `terminalCommandId`, `terminalCommandOutput{text}`,
  `terminalCommandState` {`exitCode`, `duration` (ms)}, `presentationOverrides`, …} (older: {`command`, `language`}),
  `todoList`, `input`, `extensions`, `subagent`, `search`, `generatedImage`, `simpleToolInvocation`, … (VS Code program;
  `terminal`, `todoList`, `input` verified locally). The command that ran is `userEdited`, else `toolEdited`, else `original`.
- `textEditGroup` / `notebookEditGroup` {`uri` (URI object {`$mid`, `scheme`, `path`, `fsPath`, `external`}), `edits`
  (TextEdit[][]), `done`, `isExternalEdit`}: one group per file, merged while a tool streams its edits. File-edit tools
  carry no file of their own: the group that follows a tool's invocation holds its edits (verified locally).

Built-in tool ids (VS Code program and extension program): see `VSCODE_TOOLS` in `map.ts`; MCP tools carry
`source.type: "mcp"` and ids `mcp_<server>_<tool>` (VS Code program).

## What the VS Code reader emits (`copilot.vscode`)

- **Files and dedupe.** Journals are read first, then legacy files; within each form the most recently written file
  first. Each session is mapped from one copy: the first **complete** copy that has requests is mapped at once and its
  name and `sessionId` become seen, so every other copy counts as skipped `duplicate` (unread when its name matches). A
  journal read is complete when the file was read to its end and every line applied (a write cut off mid-line, an I/O
  error or a corrupt record leave a partial session); a legacy file is read whole or not at all. A partial copy, or one
  without requests, never hides another copy: it waits, and a session with no complete copy is mapped at the end from
  its copy with the most requests (read again; its first read is what coverage counts). So a session kept as journal
  and legacy file is read from its journal, a session copied to another workspace from the copy written last, and a
  cut-off journal gives way to a complete copy. A journal is streamed line by line into its session object; a legacy
  file is parsed whole (up to 64 MiB — larger is skipped `too-large`, coverage `note: "too-large"`). The session object
  is mapped and dropped before the next file.
- **SessionEv** per session with requests (`detail`, origin `human`): id `copilot:<sessionId>` (verbatim when UUID-shaped,
  else its keyed hash; the file name when the object has no `sessionId`); `start`/`end` = earliest/latest of
  `creationDate`, `lastMessageDate` and every event time; `surface: "vscode"` (the client); `mode: "agent"` when any
  request is in agent mode, else `"chat"`; `models` = the requests' `modelId`s in order of first use, the `<vendor>/` prefix dropped, then the shared
  model-id guard (`other` when not id-shaped); `version` = the last `agent.extensionVersion` (the Copilot Chat extension's
  version, version-shaped); `projectKey` from the session's `workingDirectory` URI, else its workspace's `workspace.json`
  `folder` URI (`file:` and `vscode-remote:` paths; multi-root workspaces and empty windows have none). Sessions without
  requests emit nothing (skipped `empty-session`).
- **Agent mode** (a request): `modeInfo.kind` is `agent`; or `agent.id` is `github.copilot.editsAgent` (or the bare
  `editsAgent`); or the participant's only mode is `agent` (`agent.modes` = [`agent`]).
- **PromptEv** per request with a time and non-blank `message.text` (`detail`): origin `human`, `system` when
  `isSystemInitiated`; intent, features and `textHash` (keyed hash of the trimmed text) from the text in memory;
  `isTaskStart` = first human prompt of the session or ≥ 30 min after the previous request ended; `simToPrev` against the
  previous human prompt.
- **ToolEv** per tool invocation part, at the request's time; `callId` = keyed hash of `toolCallId`.
  - Name: the built-in tool id (`VSCODE_TOOLS`), `mcp` for MCP tools (`mcpServer` = `source.serverLabel`, else
    `source.label`; raw, export-allowlisted later), else `other` (extension tools and unknown ids).
  - Category from the tool table; terminal tools (`run_in_terminal`, `copilot_runInTerminal`, `send_to_terminal`) take
    `classifyCommand` of the command that ran (category, checks, toolchain), `exit` from
    `terminalCommandState.exitCode` and `ms` from its `duration`; `runTests` checks `test`.
  - A tool that did not run (its `isConfirmed`) has an `outcome` and no `ok` or `exit`: kind 0 (VS Code's Denied;
    older files `false`) → `denied`, and a `denial` marker (`detail: "user"`) — but in a request that was cancelled
    (`modelState.value` 2, or `isCanceled`) a tool left waiting for its confirmation was dropped: `cancelled`, no
    marker; kind 5 (Skipped) → `cancelled`. Else `ok` = `exit === 0` when an exit code is recorded; else
    `!resultDetails.isError` when recorded; else absent.
  - Bookkeeping and talk with the person (`copilot_think`, `vscode_askQuestions`, `copilot_askQuestions`,
    `vscode_get_confirmation`, `vscode_get_terminal_confirmation`, `copilot_switchAgent`) are `meta`.
  - Edits: an edit or write tool claims the next edit group of its response (the group of the same file when the tool's
    message links one, else the oldest edit tool still waiting) and takes `editExt` from it (from its message's first
    linked file when it names one). A group no edit tool claims is an `edit` of its own (`name: "textEditGroup"` or
    `"notebookEditGroup"`) — edits made without a tool — unless an edit tool ran earlier in the response (the further
    files of a multi-file edit). Extensions only; paths never leave.
- **TurnEv** per request whose response ended (`detail`): status from `modelState` (1 completed, 2 interrupted, 3 failed;
  0 and 4 have not ended: no turn), else `isCanceled` true → interrupted, else `result.errorDetails` → failed, else
  completed (a request with neither response nor result has no turn). `ms` = `elapsedMs`, else
  `result.timings.totalElapsed`, else `modelState.completedAt` − (`responseTimestamp` or `timestamp`); never
  `timeSpentWaiting`; each duration counts only when it is a finite, non-negative number of ms of at most a day (else
  the next one is tried). `ts` = `completedAt`, else request time + `ms`, else the request time; a `ts` outside the
  plausible range drops the turn, skipped `bad-ts`. `model` = the request's model.
- **MarkerEv** `interrupt` per cancelled request (`detail: "user"`), at `completedAt` (else the request time); `denial`
  per denied tool, at the request's time.
- **Session store** (`globalStorage/github.copilot-chat/session-store.db`): lifetime sessions and turns, as below; they
  share the chat sessions' ids and merge with them.
- **Coverage**, one per window, each with `installed` = Copilot is installed (below):
  - `detail` (the chat sessions): `files`/`bytes` = session files fully read and `workspace.json` files; `records` =
    journal lines and legacy documents; `versions` = extension versions; `from`/`to` = first/last event time. Drift:
    `journal-kind:<n>`, `part:(other)`, `version:newer` (a session `version` above 3), `requests:missing`,
    `request:not-object`, `session:not-object`, `modelState:<value>`, `request.message:shape` (a `message` that is neither a
    string nor {`text`}), `request.timestamp:shape` (a request whose `timestamp` is absent or not a time). A store whose
    session files are all empty (`empty-session`) is `empty`, not `ok`. Skipped: `no-ts` (a request of
    `request.timestamp:shape`: it is dropped with its prompt and tools), `bad-ts` (a request whose `timestamp` is a
    well-formed time outside the plausible range: dropped with its prompt and tools, and counted once, never also
    `no-ts`), `duplicate`, `empty-session`, `bad-record`, `parse`, `oversize`, `too-large`, `io-error`.
  - `lifetime` (the session store): `files`/`bytes` = the store; `records` = its rows; `from`/`to` = its sessions and
    turns. Drift: `store.missing-table:<t>`, `store.missing-column:<c>`, `store.table-unreadable:<t>` (a table whose first
    page fails other than busy), `store.page-stalled:<t>` (a full page whose last rowid cannot place the next one: the
    rows read stay, the table ends). Skipped: `bad-row`, `no-ts`, `io-error` (a store that cannot be opened — warn
    `cp.db-unopenable` — or that fails while read — warn `cp.db-unreadable` —, a busy page — warn `cp.db-busy` —, a later
    page that fails — warn `cp.db-query`), `too-large` (a locked store whose private copy — the store and its `-wal` —
    would exceed `MAX_COPY_BYTES`: never copied, `note: "too-large"`, warn `cp.db-too-large`), `bad-record`. `absent`
    without a store; `error` (`note: "unreadable"`) when the store is there but cannot be read — a store too large to
    copy keeps `note: "too-large"` instead.

**Install detection** (`install.ts`, names only): a bundled `copilot*` extension — macOS `/Applications/<app>.app/Contents/
Resources/app/extensions` and `~/Applications/…`, Windows `%LOCALAPPDATA%\Programs\Microsoft VS Code[ Insiders]\resources\
app\extensions`, Linux `/usr/share/code[-insiders]/resources/app/extensions` — or a `github.copilot*` folder in the user
extensions (`~/.vscode`, `~/.vscode-insiders`, `~/.vscode-oss` `/extensions`). VS Code 1.1xx bundles Copilot in the app.

## The session store (`session-store.db`) (schema verified locally on the extension's copy; rows unverified)

The extension fills its copy from its own telemetry spans (`host_type: "vscode"`) (extension program); the Copilot CLI
keeps a store of the same name. Tables: `sessions` (`id` TEXT primary key, `cwd`, `repository`, `host_type`, `branch`,
`summary`, `agent_name`, `agent_description`, `created_at`, `updated_at` TEXT ISO), `turns` (`id`, `session_id`,
`turn_index`, `user_message`, `assistant_response`, `timestamp` TEXT ISO), `checkpoints`, `session_files` (`file_path`,
`tool_name`, …), `session_refs` (`ref_type`, `ref_value`, …), `schema_version`, and an FTS5 `search_index`.

- Columns read: `sessions.id`, `cwd`, `created_at`, `updated_at`; `turns.session_id`, `timestamp` — in rowid pages,
  explicit column lists checked against the table first (a missing one is drift). Never selected: turn texts, `summary`,
  `repository`, `branch`, `host_type` (in the CLI's store it names the repository's host, not a client), the agent
  fields; never read: `checkpoints`, `session_files`, `session_refs`, the search index.
- **SessionEv** (`lifetime`) per session row with a creation time: `start` = `created_at`, `end` = `updated_at` (never
  before `start`), origin `human`, `surface` = the client whose store it is — `vscode` for the extension's copy, `cli`
  for the CLI's own store —, `projectKey` from `cwd`. **TurnEv** (`lifetime`) per turn row with a time, no status or
  duration.

## Copilot CLI (`copilot.cli`) (unverified)

`<home>/.copilot` is a candidate only when it holds `session-state/`, `history-session-state/` (an older CLI's layout,
not read) or `session-store.db`; otherwise the CLI is `absent`.
`$COPILOT_HOME` (which moves this folder) is not followed.

`events.jsonl`: one event per line {`type`, `data`, `id`, `timestamp` (ISO), `parentId`, `ephemeral`?} (extension
program). Types known (`KNOWN_EVENTS` in `cli.ts`): `session.*` (`start`, `resume`, `error`, `idle`, `info`,
`model_change`, `title_changed`, `shutdown`, `usage_info`, `tools_updated`, `skills_loaded`, `mcp_servers_loaded`,
`mcp_server_status_changed`, `compaction_start`, `compaction_complete`, `truncation`, `handoff`, `snapshot_rewind`, …),
`user.message`, `assistant.*` (`turn_start`, `turn_end`, `message`, `message_delta`, `reasoning`, `intent`, `usage`, …),
`tool.*` (`execution_start`, `execution_complete`, `execution_partial_result`, …), `subagent.*`, `hook.*`, `abort`,
`permission.requested`, `exit_plan_mode.requested`, `pending_messages.modified`, `skill.invoked`, `system.message`. Any
other type is drift `event:(other)` (the type itself is never kept).

- `session.start` {`sessionId`, `copilotVersion`, `startTime`, `context` {`cwd`, `gitRoot`, `branch`, …}, `selectedModel`}
  → `version`, `projectKey`, a model. `session.model_change` {`newModel`} and `assistant.usage` {`model`, token counts}
  → models (no usage events).
- `user.message` {`content`, `attachments`, `source`?} → PromptEv: origin `human` when `source` is absent or `user`,
  else `system`; the CLI's context blocks (`<reminder>`, `<attachments>`, `<context>`, `<current_datetime>`, …) are
  stripped first, as the extension does.
- `assistant.turn_start` / `assistant.turn_end` {`turnId`}: one model call — the CLI's documented meaning of a turn is
  a single LLM call and the tools it requests (its SDK's agent-loop guide); `session.idle`, which ends the loop, is not
  written to `events.jsonl`. So a **TurnEv** is one exchange: it starts at a `user.message` (or at a model call with
  none before it), spans its model calls, and ends `completed` at the last call's `turn_end` before the next
  `user.message` (or the end of the file), `ms` = from its start; an `abort` ends it `interrupted` at the abort, and is
  a MarkerEv `interrupt` (`detail: "user"`). A `turn_end` ends only the model call still running: one an abort already
  ended, or one never started, ends nothing; an exchange whose call never ended (the file stops mid-call) has no turn.
- `tool.execution_start` {`toolCallId`, `toolName`, `arguments`, `mcpServerName`?, `mcpToolName`?, `parentToolCallId`?}
  and `tool.execution_complete` {`toolCallId`, `success`, `result` {`content`}, `error` {`code`, `message`}} → ToolEv
  (`CLI_TOOLS`): `bash`/`powershell` → `classifyCommand(arguments.command)` (category, checks, toolchain), `exit` from
  the result's trailing `<exited with exit code N>`; `edit`, `str_replace`, `insert`, `create`, `str_replace_editor` →
  edit/write with `editExt` from `arguments.path`; MCP tools → `mcp` with `mcpServer`; `think`, `report_intent` (written on every turn),
  `report_progress`, `task_complete`, `ask_user` and `tool_search_tool_regex` are `meta`. `ok` = exit code 0 when known,
  else `success`; `ms` = completion − start. A call still running at an `abort` was interrupted: `outcome:
  "interrupted"`, no `ok`. The CLI's permission results are not mapped yet (their names differ between versions of its
  documentation), so no denial is read from it.
- SessionEv (`detail`, origin `human`, `surface: "cli"`); session id = the `session-state` folder name (UUID verbatim,
  else hashed). The session store is read as above.
- **Coverage**, one per window: `detail` = `session-state/*/events.jsonl` (`absent` without `session-state/`),
  `lifetime` = `session-store.db` (`absent` without it; `error`, `note: "unreadable"`, when it cannot be read; a store
  too large to copy keeps `note: "too-large"`, as above).
  Drift in `detail`, beyond unknown event types: `event.timestamp:shape` (an event whose `timestamp` is absent or not a
  time: what it carries is dropped, skipped `no-ts`; a well-formed time outside the plausible range is skipped `bad-ts`
  instead, counted once and never also `no-ts`),
  `user.message.content:shape` (no string `content`), `tool.execution_start:shape` (a call without its id or tool
  name), `session-state:layout` (an entry of `session-state/` that is not a folder holding `events.jsonl`, such as a
  bare `<id>.jsonl`), `layout:history-session-state` (the older layout's folder is there).

## JetBrains (`copilot.jetbrains`, beta)

`<config>/github-copilot/<ide>/chat-*-sessions/*nitrite.db` are Nitrite (H2 MVStore) databases; they are not decoded.
`apps.json` and `hosts.json` beside the IDE folders hold OAuth tokens: they are skipped by name before anything else, so
they are never stat'ed, opened or returned by `locate()`. Coverage per config folder with at least one store:
`status: "present-undecodable"`, `beta: true`, `files`/`bytes` = the stores; no events.

## Limits

- Tool events carry the request's time; parts have no times of their own.
- An edit tool whose group VS Code never wrote (a failed edit) can claim a later tool's group when neither names its file.
- Legacy session files over 64 MiB are skipped (`too-large`); each one is parsed whole, so one that large is held in
  memory once while it is read.
- Request token counts and credits (`promptTokens`, `completionTokens`, `copilotCredits`, `modelTotals`) are not mapped.
- `externalEdit` and `workspaceEdit` parts (edits made by other agents in VS Code, file moves) are not counted as edits.
- Sessions imported from a chat export (legacy `isImported: true`; the journal no longer records it) are read like any other.
- The CLI mapping, the store's rows and the JetBrains layout come from program code and documentation, not from a real store.
