# Cursor — IDE store (cursorDiskKV, legacy ItemTable keys), AI code tracking, cursor-agent CLI presence

Readers (all three beta — built from public descriptions, not verified on a real store): `cursor.ide` (`index.ts`,
`diskkv.ts`, `itemtable.ts`), `cursor.tracking` (`tracking.ts`), `cursor.agent-cli` (`agentcli.ts`).

Evidence: nothing below was verified against a real Cursor store.
Every table, key, field and value type is **(from docs, unverified locally)**: public reverse-engineering notes of
several independent open-source readers of Cursor's stores, Cursor forum bug reports, and Cursor's agent prompts as
published by third parties. Where a name is backed by a single source it says **(one source)**; everything else is
named by two or more independent sources. Where sources disagree, both shapes are read. This file records names and
value types only, never values.

**Zero-yield.** A coverage window that read records but yielded none of its reader's primary events is drift
`zero-yield` (set by the scan), except records skipped as `copied` or `empty`, and coverage stamped `aborted`, so a
renamed field never passes as a quiet store. Primary events: `cursor.ide` (`detail`) — a
session, prompt or tool call (its `lifetime` window is checked by its columns); `cursor.tracking` — a commit;
`cursor.agent-cli` reads no records.

**io-error.** A file or store that cannot be opened or read counts as skipped `io-error`, and so does a never-opened
file — a credential, token or key file, by its name or by the name of the file behind a link (`core/io/observe.ts`):
the engine refuses it before it is opened, so it reads as unreadable.

## Layout

```
<user> = vscodeUser(env, "Cursor")   macOS ~/Library/Application Support/Cursor/User
                                     Windows %APPDATA%\Cursor\User, Linux ~/.config/Cursor/User
<user>/globalStorage/state.vscdb                       cursor.ide       composers and messages (cursorDiskKV)
<user>/workspaceStorage/<workspace>/state.vscdb        cursor.ide       legacy ItemTable keys only (older Cursor)
<home>/.cursor/ai-tracking/ai-code-tracking.db         cursor.tracking  AI vs human lines per commit
<home>/.cursor/projects/<project>/agent-transcripts/   cursor.agent-cli transcripts (counted)
<home>/.cursor/chats/<project hash>/<agent id>/store.db
<config>/cursor/chats/<project hash>/<agent id>/store.db   cursor.agent-cli chat stores (counted; <config> one source)
not read: <user>/globalStorage/state.vscdb.backup, <user>/globalStorage/conversation-search.db,
          <user>/globalStorage/anysphere.cursor-commits/, <user>/History/, <home>/.cursor/prompt_history.json,
          <home>/.cursor/{cli-config.json, mcp.json, ide_state.json, plans/, skills/, worktrees/},
          <home>/.cursor/projects/<project>/{agent-tools/, terminals/, mcps/, uploads/, repo.json}
```

`state.vscdb` grows very large — users report tens of GB, up to about a hundred, mostly bubble rows. It is never
copied while it can be read in place: `openRo` reads it with `mode=ro` (or `immutable=1` for a WAL store whose writer
closed it), and a locked store whose private copy — the store and its `-wal` — would exceed `MAX_COPY_BYTES` is not
copied at all (coverage `note: "too-large"`, warning `too-large`, warn log `cu.db-too-large`). No query reads a whole table or a whole value except where stated.

## state.vscdb

SQLite. Tables (both `(key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)`): `ItemTable` (VS Code's settings and UI
state, also Cursor's account tokens `cursorAuth/*`) and `cursorDiskKV` (Cursor's own data, in the global store). Newer
versions add a relational `composerHeaders` table (`composerId`, `workspaceId`, `createdAt`, `lastUpdatedAt`,
`isArchived`, `isSubagent`, `value`, …); it is not read. A value is JSON text (stored as TEXT or as a BLOB of text).
`UNIQUE` gives `key` an index (SQLite's `sqlite_autoindex_cursorDiskKV_1`), which the reader pages by. `ON CONFLICT
REPLACE` gives a rewritten row a new rowid but keeps its key.

### cursorDiskKV key families

| key | content | read |
|---|---|---|
| `composerData:<composerId>` | one conversation (a "composer") | fields below |
| `bubbleId:<composerId>:<bubbleId>` | one message ("bubble") | fields below |
| `checkpointId:…`, `codeBlockDiff:…`, `messageRequestContext:…`, `agentKv:blob:<hash>`, `agentKv:checkpoint:…` | file snapshots, diffs, request context, agent blobs | never |

Composer and bubble ids are UUIDs; subagent composers can carry a `task-` prefix.

### `composerData:<composerId>` value

- `_v` (number, format version; absent in the oldest format), `composerId` (string), `name`, `subtitle` (text, never
  read), `createdAt`, `lastUpdatedAt` (epoch ms), `status` (string), `isAgentic` (boolean), `unifiedMode` (string:
  `agent`, `chat`, …), `forceMode` (string), `modelConfig` {`modelName` (string), `maxMode`, …} (`modelConfig` one
  source), `fullConversationHeadersOnly[]` {`bubbleId`, `type`, `serverBubbleId`?, `grouping`?} — the message list,
  `richText`, `text`, `context`, `gitWorktree`, `latestChatGenerationUUID` (never read).
- A composer's key range can hold far more bubble rows than its list names: when an agent forks itself, Cursor writes
  full transcript copies, about 50 rows per visible message (a Cursor forum report found hundreds of thousands of
  unlisted rows, nearly all copies of listed ones).
- Subagents: `subagentInfo` (object; present on a subagent's composer) {`toolCallId` (the launching call; one
  source), `forkedFromComposerId`, `parentRequestId`, …}; a parent lists its children in `subComposerIds[]` and
  `subagentComposerIds[]` (strings). A bug in some versions persists one forked launch hundreds of times, each copy
  with the same `subagentInfo.toolCallId`.
- The oldest format (no `_v`) holds the messages inline in `conversation[]` {`type`, `bubbleId`, `text`, …}, with no
  per-message time.

### `bubbleId:<composerId>:<bubbleId>` value

- `type` (number: 1 user, 2 assistant), `bubbleId`, `createdAt` (ISO-8601 string; on most bubbles), `text` (string:
  the message; for type 2 the assistant's text), `richText`, `requestId`, `isAgentic`, `capabilityType` (number),
  `modelInfo` {`modelName`} (assistant bubbles), `tokenCount` {`inputTokens`, `outputTokens`} (zero on current versions),
  `thinkingDurationMs` (number; not read), `allThinkingBlocks[]`/`thinking` (text), `errorDetails` (object, when the request
  failed), `pullRequests[]`, `commits[]`, `codeBlocks[]`, `relevantFiles[]`, `recentlyViewedFiles[]`, `context`,
  `toolResults` (empty), and `toolFormerData` on tool bubbles. An assistant turn is split into several bubbles:
  thinking, one per tool call, the reply.
- `toolFormerData` {`tool` (number: the tool enum), `name` (string), `toolCallId`, `modelCallId`, `toolIndex`,
  `status` (`completed`, `error`, `cancelled`, `running`, `loading`, absent), `userDecision` (`accepted`,
  `rejected`), `params` (JSON text, double-encoded: the tool's parameters, camelCase), `rawArgs` (JSON text: the
  model's arguments, snake_case), `result` (JSON text), `additionalData`, `error`}.
  - A terminal tool's params/arguments carry `command`; its result carries `exitCode` (written only when not 0) and,
    in newer versions, `exitCodeV2` (written always; one source), and `rejected` (boolean).
  - File tools name their file as `targetFile`/`target_file`, `relativeWorkspacePath`/`relative_workspace_path`,
    `filePath`/`file_path` or `path`.
  - The MCP call tool's arguments are {`server`, `toolName`, `arguments`}.
- Tool names: the names of Cursor's numeric tool enum (`read_file`, `read_file_v2`, `list_dir`, `list_dir_v2`,
  `edit_file`, `edit_file_v2`, `delete_file`, `reapply`, `run_terminal_command_v2`, `file_search`, `glob_file_search`,
  `ripgrep_search`, `ripgrep_raw_search`, `semantic_search_full`, `read_semsearch_files`, `search_symbols`,
  `deep_search`, `go_to_definition`, `web_search`, `web_fetch`, `fetch_rules`, `read_lints`, `fix_lints`, `task`,
  `task_v2`, `await_task`, `todo_read`, `todo_write`, `create_plan`, `mcp`, `call_mcp_tool`, `list_mcp_resources`,
  `read_mcp_resource`, `get_mcp_tools`, `mcp_auth`, `computer_use`, `record_screen`, `write_shell_stdin`,
  `fetch_pull_request`, `create_diagram`, …; the id table in `diskkv.ts`, one source), older names from Cursor's agent
  prompts (`run_terminal_cmd`, `run_terminal_command`, `codebase_search`, `grep_search`, `grep`, `search_replace`,
  `write`, `apply_patch`, `edit_notebook`, `update_memory`), and the agent harness's names (`Shell`, `Read`, `Write`,
  `StrReplace`, `Delete`, `Grep`, `Glob`, `SemanticSearch`, `Browser`, `Task`, `WebSearch`, `WebFetch`). Tools of MCP
  servers are named with an `mcp_`/`mcp-` prefix and the server inside the name, in forms that cannot be parsed
  reliably.

### Legacy `ItemTable` keys (older Cursor)

| key | value |
|---|---|
| `aiService.prompts` | [{`text`, `commandType`}] — the person's prompts, no times |
| `aiService.generations` | [{`unixMs` (epoch ms), `generationUUID`, `type` (`composer`, …), `textDescription` (the prompt) — or `text` (some versions)}] (times and `textDescription` one source) |
| `composer.composerData` | {`allComposers`: [{`type`, `composerId`, `name`, `createdAt`, `lastUpdatedAt` (epoch ms), `unifiedMode`, `isAgentic`, `isDraft`, `isArchived`, `subtitle`, `modelConfig`, older `conversation[]`}], `selectedComposerIds`, …}, or an older bare list of the same entries |
| `workbench.panel.aichat.view.aichat.chatdata` | {`tabs`: [{`tabId`, `chatTitle`, `lastSendTime` (epoch ms; one source), `bubbles`: [{`type` (`user`, `ai`), `text`, `rawText`, …}]}]} |

Newer Cursor keeps the composer index (`composer.composerData`, `composer.composerHeaders`) in `ItemTable` while the
conversations live in `cursorDiskKV`.

## What `cursor.ide` emits

- **Queries.** `cursorDiskKV` is read by key, in pages of 2,000, each resuming after the last key read:
  `SELECT key, … FROM cursorDiskKV WHERE key > ? AND key < ? ORDER BY key LIMIT ?`, an index range seek. Composers are
  the range `'composerData:'` .. `'composerData;'` (`;` sorts right after `:`, so the range holds exactly the keys that
  start with `composerData:`, case-sensitive); then each composer inside the detail window (below) has its bubbles read
  as its own range `'bubbleId:<composerId>:'` .. `'bubbleId:<composerId>;'`, so the bubbles of older conversations and
  of copies are never read. The value is read once per row inside SQLite (`value AS v`) together with
  `json_valid(value)`, and only `json_extract`/`json_type` of the fields listed leave SQLite: values never leave it
  whole. The text of a bubble is selected only when its `type` is 1. A tool's `params`, `rawArgs` and `result` are
  parsed inside SQLite, and only for the tools that need them: the command line of terminal tools, the target file of
  file tools, the `server` of MCP tools, the exit code of terminal tools. A value that is not valid JSON is skipped
  `parse` (the row still counts). `key` and `value` are checked against the table first (each missing: drift
  `missing-column:<name>`). The key index is checked in `pragma_index_list`/`pragma_index_xinfo`: a unique, non-partial
  index on `key` alone in binary order (Cursor's `UNIQUE`, or the primary key of a `WITHOUT ROWID` table keyed by `key`).
  Without one — the schema differs — the reader falls back to one rowid scan per key family, `WHERE key LIKE
  '<family>:%' AND rowid > ? ORDER BY rowid LIMIT ?` (correct, but it reads every row; bubbles are matched to their
  composer by key, and those outside the window are read but not mapped), and records drift `no-key-index:cursorDiskKV`;
  a table that then has no rowid either (`WITHOUT ROWID`) is drift `table-unreadable:cursorDiskKV`. The first query of
  a pass that fails for any reason but a busy store is drift `table-unreadable:cursorDiskKV`; a busy store or any later
  failure is an io-error. Either ends the pass.
- **Listed bubbles only.** Just before a composer's bubble range is read, its listed bubble ids are looked up by its
  key: `SELECT <ids of fullConversationHeadersOnly>, <ids of conversation> FROM cursorDiskKV AS kv WHERE kv.key = ? AND
  json_valid(kv.value)`, each a `json_group_array` of `json_extract(h.value, '$.bubbleId')` over `json_each` of the
  array, so only ids leave SQLite. A composer whose header list (or, in the oldest format, inline conversation) names
  bubble ids has only those bubbles mapped; the other rows of its range are skipped `unlisted`. The set is held for that
  composer only and dropped once its bubbles are read. A composer with no list, or a list whose entries carry no
  `bubbleId`, has every bubble mapped. In the rowid fallback (no key index, so no cheap lookup by key) the composer scan
  extracts the same id lists, kept for the composers inside the window until the bubble scan ends.
- **The detail window.** A composer is inside it when it was last updated (`lastUpdatedAt`, else `createdAt`) within
  the 90 days before the scan — or at or after `since` when the scan sets one; one with neither time is taken as
  inside. Only the bubbles of composers inside the window are read.
- **Composers → SessionEv**, one per composer, emitted after the bubbles: window `detail` inside the window,
  `lifetime` outside it; id `cursor:<composerId>` (the id from the key, verbatim when UUID-shaped, else its keyed
  hash); `start`/`end` = earliest/latest of `createdAt`, `lastUpdatedAt` and (inside the window) the composer's bubble
  times; `surface: "ide"`; `mode: "agent"` when `isAgentic` or `unifiedMode` is `agent`, else `"chat"`; `models` =
  `modelConfig.modelName`, then each bubble's `modelInfo.modelName` in order of first use
  (the shared model-id guard: `other` when not id-shaped); origin `human`, or `subagent` when the composer has a
  `subagentInfo` object; `parentId` = the session of the composer whose `subComposerIds`/`subagentComposerIds`
  lists it. A copy of a subagent launch already read (same `subagentInfo.toolCallId`) is skipped `duplicate`, and its
  bubbles are never read. Inside the window, a composer that lists no message and has no bubble is skipped
  `empty-session` (only when all its bubbles were read: a pass that stopped early cannot tell); one without any time
  `no-ts`. Outside the window, a composer's session comes from the composer alone (its own times, its model setting)
  and it is counted as skipped `outside-window` (its bubbles were not read) — or skipped `empty-session` when it lists
  no message. Messages held inline (oldest format) have no time: counted as
  skipped `inline-message`, not mapped. No `projectKey`: a composer does not name its workspace (the workspace index is
  in `ItemTable`, which is not read when composers exist).
- **Bubbles.** Read by key, only bubbles under a known composer's key are ever seen. A bubble id holds no colon, while a
  composer id can: composer `a`'s range also holds the rows of a composer `a:b`, so a row whose rest after
  `bubbleId:a:` holds a colon is left to that composer's own range (in the rowid fallback the composer id runs to the
  key's last colon). In the rowid fallback, a bubble whose composer has no `composerData` row (a deleted chat) is skipped
  `orphan`, and one whose key is not `bubbleId:<composerId>:<bubbleId>` is a `bad-record`. A `type` other than 1 or 2 is
  drift `bubble-type:<n>` (`(other)`, `(none)`); one without a plausible `createdAt` is skipped `no-ts` (its model still
  counts). When none of the typed bubbles read has a `createdAt`, the field has moved or been renamed: drift
  `missing-field:createdAt`.
- **Missing bubbles.** A composer inside the window whose header list names messages but none of them has a row
  (after its range was read in full) is skipped `missing-bubbles`; its session is still emitted, without events. When
  at least one composer is missing its bubbles and no composer that lists messages has any, the bubbles' key family has
  moved or been renamed: drift `missing-bubbles:cursorDiskKV`, so a format change can never pass as a quiet store.
  Composers that hold their messages inline (the oldest format) have no bubble rows by design and are not counted.
  - **PromptEv** per type-1 bubble with non-blank text, in composers that are not subagents (a subagent's user
    bubbles are its parent's briefs): origin `human`, `detail`; intent, features and `textHash` (keyed hash of the
    trimmed text) from the text in memory. A composer's prompts are mapped once its bubbles are read, in time order
    (keys sort by bubble id, not by time): `isTaskStart` = its first prompt, or one ≥ 30 min after the latest earlier
    bubble of the composer; `simToPrev` against its previous prompt. Only that composer's prompt texts and bubble times
    are held meanwhile (in the rowid fallback, those of every composer inside the window, until the scan ends). Each
    prompt is mapped on its own: one the mapping fails on is a `bad-record` and the others go on. A user bubble without
    a `text` field (absent or null) is drift `missing-field:text`; blank text is skipped `empty`.
  - **ToolEv** per assistant (type-2) bubble with `toolFormerData`: `name` = the built-in name (above), else the name the numeric `tool`
    stands for, else `mcp` for an `mcp_`/`mcp-` name, else `other`; `callId` = keyed hash of `toolCallId`. Terminal
    tools (`run_terminal_cmd`, `run_terminal_command`, `run_terminal_command_v2`, `Shell`) take `classifyCommand` of
    `params.command` (else `rawArgs.command`) — category and checks — and `exit` from `result.exitCodeV2`, else
    `result.exitCode`. File tools (`edit_file`, `edit_file_v2`, `search_replace`, `write`, `delete_file`, `reapply`,
    `StrReplace`, `Write`, `Delete`) take `editExt` from the target file (extension only; the path never leaves memory);
    deleting a file is an `edit`. MCP tools: `name: "mcp"`, `mcpServer` = `server` from the params or arguments (raw,
    export-allowlisted later), else none — never parsed out of a tool name. A tool that did not run to an end of its
    own has an `outcome` and no `ok` or `exit`: `denied` when `userDecision` is `rejected`, `cancelled` for `status`
    `cancelled`, `interrupted` for `aborted`. Else `ok` = `exit === 0` when an exit code is known; else true for
    `status` `completed`, false for `error`; else absent. `ask_question`, `switch_mode`, `reflect`, `await` and
    `report_bugfix_results` are `meta`.
  - **MarkerEv** `denial` per rejected tool (`detail: "user"`); `error` per bubble with a non-null `errorDetails`.
  - **No TurnEv**: the store marks no end of a turn, and `thinkingDurationMs` is time spent thinking, not a turn (it
    is not read).
- **Legacy fallback.** Only when the global store has no `cursorDiskKV` or it holds no composer row (and could be
  read), the four legacy keys are read — by exact key, parameterized (`WHERE key = ?`), from the global store's
  `ItemTable` and then each workspace store's. A value longer than 64 Mi characters is never loaded: skipped
  `too-large` (`note: "too-large"`). `aiService.prompts` is checked for presence only. `aiService.generations` → a
  PromptEv per entry with a time and text (`textDescription`, else `text`; no session; a `generationUUID` seen in an
  earlier store is skipped `duplicate`; an entry with neither text field is drift `missing-field:text`, one whose text
  is blank is skipped `empty`), in time order per store for `isTaskStart`/`simToPrev`. `composer.composerData`
  → a SessionEv per entry (`createdAt`/`lastUpdatedAt`, `surface: "ide"` and `mode` as above, `modelConfig.modelName`; drafts
  skipped `draft`; inline messages counted `inline-message`). `chatdata` → a SessionEv (`mode: "chat"`) per tab with messages at
  its `lastSendTime` (tabs without messages `empty-session`; their messages `inline-message`). A value of another shape
  is drift `<key>:shape`; one that is not JSON `parse`.
- **Coverage**, one per window; no versions (the stores name none). The source is an error when every store present
  fails to open or read, unless a store was too large to copy.
  - `lifetime` — the composer index, every conversation: `files`/`bytes` = the global store; `records` = composer rows
    read; `from`/`to` = the span of every composer's session, both windows'. Skipped: `parse`, `duplicate`,
    `empty-session`, `no-ts`, `bad-record` (a session the mapping failed on), `io-error`, `too-large`. `absent` without
    a global store.
  - `detail` — the bubbles of the composers inside the window, and the legacy keys: `files`/`bytes` = stores whose tables
    were listed (main file size); `records` = bubble rows read, plus legacy values read (a generation list counts its
    entries, one record each, in place of its value); `from`/`to` = first/last time of its events and detail sessions.
    Skipped: `parse`, `orphan`, `duplicate`, `unlisted`, `missing-bubbles`, `no-ts`, `empty`, `empty-session`,
    `outside-window` (a composer whose bubbles are not read), `inline-message`, `draft`, `bad-record` (a row or prompt
    the mapping failed on; the warn log `cu.bad-record` counts both windows'), `io-error`, `too-large`. `absent` when
    there is no store at all.
  - Drift of the store itself (`missing-column:<name>`, `missing-table:<name>`, `no-key-index:cursorDiskKV`,
    `table-unreadable:cursorDiskKV`) is in both windows; `missing-bubbles:cursorDiskKV`, `missing-field:text`,
    `bubble-type:<n>` and `<legacy key>:shape` in the detail window.

## ai-code-tracking.db (`cursor.tracking`)

SQLite, written by Cursor for its "AI share of committed code" metric, scored on the machine where the code was
written. Tables: `scored_commits` (`commitHash`, `branchName` — together the primary key — `scoredAt`, `linesAdded`,
`linesDeleted`, `tabLinesAdded`, `tabLinesDeleted`, `composerLinesAdded`, `composerLinesDeleted`, `humanLinesAdded`,
`humanLinesDeleted`, `blankLinesAdded`, `blankLinesDeleted`, `commitMessage`, `commitDate`, `v1AiPercentage`,
`v2AiPercentage`), `ai_code_hashes` (`hash`, `source`, `fileExtension`, `fileName`, `requestId`, `conversationId`,
`timestamp`, `createdAt`, `model`), `tracked_file_content` (`gitPath`, `content`, …), `ai_deleted_files`,
`conversation_summaries` (`conversationId`, `title`, `tldr`, `overview`, `summaryBullets`, `model`, `mode`,
`updatedAt`), `tracking_state` (`key`, `value`). The time columns' value type is not documented (numbers and date
strings are both accepted). One machine reported every line column of `scored_commits` null.

- **Columns read**: `scored_commits.commitHash`, `commitDate`, `scoredAt`, `tabLinesAdded`, `composerLinesAdded`,
  `humanLinesAdded`, in rowid pages of 2,000, checked against the table first (each missing: drift
  `missing-column:<name>`; no `scored_commits`: drift `missing-table:scored_commits`; `WITHOUT ROWID` or a first page
  that fails for good: drift `table-unreadable:scored_commits`). Without either time column no row is read. Never
  selected: `commitMessage`, `branchName`, the other counts and the percentages; no other table is read.
- **CommitFactEv** per row with a time: `ts` = `commitDate`, else `scoredAt`; `aiLines` = `tabLinesAdded` +
  `composerLinesAdded` (whichever is a number; absent when neither), `humanLines` = `humanLinesAdded`. A commit hash
  seen before (the same commit scored on another branch) is skipped `duplicate`; hashes are compared in memory and
  never kept. No `repoKey`: the table names no repository. Rows without a time: `no-ts`.
- **Coverage** (window `lifetime`): `files`/`bytes` = the store, `records` = rows read, `from`/`to` = first/last
  commit time. A store that cannot be opened makes the source an error, unless it is a locked store above
  `MAX_COPY_BYTES` (`note: "too-large"`, warn `cu.db-too-large`).

## cursor-agent CLI (`cursor.agent-cli`, beta)

- Transcripts: `agent-transcripts/<session>/<session>.jsonl` (lines with `role` and `message.content[]` of `text` and
  `tool_use` blocks; no timestamps, no model, no tool results), `agent-transcripts/<session>/subagents/<agent>.jsonl`
  (same shape), and an older plain-text form, one `*.txt` per session (`user:`/`A:` turns, `[Tool call]` lines).
- Chat stores `store.db`: `meta` (`key`, `value`: one row whose value is hex-encoded JSON {`agentId`,
  `latestRootBlobId`, `name`, `mode`, `createdAt`, `lastUsedModel`, `blobEncryptionKey`}) and `blobs` (`id` — a
  sha256 — and `data`: JSON messages and protobuf conversation roots). No schema is published.
- The reader decodes neither: a `.cursor` folder is a candidate when it holds a transcript or a chat store. Coverage
  `status: "present-undecodable"`, `beta: true`; `files`/`bytes` = transcripts read and chat stores opened; `records` =
  JSONL transcript lines (counted, never parsed) plus `blobs` rows (`SELECT COUNT(id)`; a store without `blobs` is
  drift `missing-table:blobs`). `meta` is never queried. No events.

## Never read

- `ItemTable` keys other than the four legacy ones, and those only without composers; never a pattern query on
  `ItemTable` (it holds `cursorAuth/accessToken`, `cursorAuth/refreshToken` and other account values).
- Whole `cursorDiskKV` values; assistant text, thinking, code blocks, diffs, attached files and context; tool params
  and results beyond the command line, target file, MCP server and exit code; composer names, subtitles and git
  worktree fields; every key family but `composerData` and `bubbleId`; the `composerHeaders` table.
- `ai-code-tracking.db` beyond the six columns above; commit messages, branch names, file names and contents.
- cursor-agent transcript and blob contents, the chat stores' `meta`.

## Limits

- Nothing here was verified against a real Cursor store; field names follow public descriptions and can be wrong or
  out of date. Unknown bubble types, schema changes, a renamed bubble `text` or `createdAt` and a renamed generation
  text surface as drift; another renamed field surfaces only as missing data, unless nothing in the window is left to
  map (`zero-yield`).
- The store is live while Cursor runs, and pages are read one query at a time. Read by key, a row is read at most
  once (a rewrite keeps its key), but a row written behind the read position during the scan — a new message in a
  conversation already read — is missed. In the rowid fallback, a rewritten row moves to a new rowid, so it can be read
  twice or missed.
- Bubbles are read only for composers updated inside the detail window (90 days, or since `since`): older
  conversations count as lifetime sessions without prompts or tools. A composer whose own times are old is
  outside the window even if a bubble of it is newer.
- Transcript copies a composer does not list are skipped (`unlisted`), and copies of one subagent launch are read
  once; but a forked subagent whose own list names its parent's messages counts the parent's tool calls once more.
- Token counts (zero in current versions), the context meter and request ids are not mapped; neither are the
  timings Cursor keeps per bubble in some versions.
- Composers have no project: the workspace index is not read.
- Legacy generations have no session, and legacy chat-tab messages and inline composer messages no time.
- cursor-agent sessions are not decoded, so the CLI's activity is not in the report yet.
