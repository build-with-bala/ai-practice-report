# Claude Code — transcripts, subagents, workflows; lifetime layer and configuration

Readers: `claude-code.transcripts` (`transcripts.ts`, `origin.ts`, `tools.ts`) — the detail layer, below;
`claude-code.history` (`history.ts`), `claude-code.stats` (`stats.ts`) and `claude-code.config` (`config.ts`) — the
lifetime layer and configuration, in the second half of this file.

Evidence: **(verified locally)** = the type or field was confirmed with the structure probe (`scripts/probe.ts`).
**(CLI table)** = listed in the CLI program's own transcript entry-type tables (2.1.326), not confirmed with the probe.
**(CLI program)** = read from the CLI program's code (2.1.326), not confirmed with the probe.
This file records names and value types only, never values.

## Layout

```
<root> = $CLAUDE_CONFIG_DIR, else <home>/.claude (each WSL home: <home>/.claude)
<root>/settings.json                                   cleanupPeriodDays (number) — the only field read here
<root>/projects/<slug>/<sid>.jsonl                     top-level session transcript
<root>/projects/<slug>/<sid>/subagents/agent-<id>.jsonl          subagent transcript
<root>/projects/<slug>/<sid>/subagents/agent-<id>.meta.json      subagent metadata
<root>/projects/<slug>/<sid>/subagents/workflows/wf_<w>/agent-<id>.jsonl + .meta.json   workflow agents
<root>/projects/<slug>/<sid>/workflows/wf_<w>.json     workflow run summary
not read: <sid>/tool-results/, <sid>/workflows/scripts/, subagents/workflows/wf_<w>/journal.jsonl,
          subagents/agent-<id>.forked-skill.json and .forked-skill.marker.json
          (<slug>/memory/*.md are counted, never opened, by the configuration reader — see below)
```

- `<slug>` is derived from the cwd and is never parsed; project identity comes from record `cwd`.
- The CLI names a top-level transcript by its session id (a UUID), and its records' `sessionId` equals that stem.
  Subagent and workflow-agent records repeat the parent's `sessionId` and add `agentId`.
- Agent transcripts are named `agent-<id>` (`<id>` alphanumeric); workflow run folders `wf_<w>`. The `wf_<w>` folder
  name and the `workflows/wf_<w>.json` stem are the same run id.

## Record types

JSONL, one object per line, discriminated by `type` (string). Unknown `type` → coverage drift.

| group | types | handling |
|---|---|---|
| conversation | `user`, `assistant`, `system`, `attachment` (verified locally); `progress`, `summary` (CLI table) | `user`/`assistant`/`system` mapped; others ignored |
| session metadata, re-stamped many times per file | `permission-mode`, `mode`, `atis-latch`, `tools-used`, `last-prompt`, `ai-title`, `session-owner`, `pr-link`, `cost-state`, `agent-name`, `bridge-session`, `artifact-comment-monitor`, `artifact-autoreact-ledger` (verified locally); `custom-title`, `tag`, `relocated`, `agent-color`, `agent-setting`, `repl-mode`, `isolation-latch`, `dev-mods`, `memory-mode`, `worktree-state`, `history-suppression`, `ended-by-model`, `derived-from`, `data-flow-records`, `data-flow-incomplete`, `frame-link` (CLI table) | `permission-mode`, `pr-link`, `cost-state`, `session-owner` mapped; `ai-title` dropped after reading `type`; rest ignored |
| queue journal | `queue-operation` (verified locally) | ignored (see below) |
| request replay, file history | `api-request`, `api-request-blob`, `file-history-snapshot`, `file-history-delta` (verified locally) | dropped from the first 512 bytes, before `JSON.parse` (`type` is the first key) |
| | `api-request-shape` (verified locally) | parsed, ignored |
| fork and history bookkeeping | `fork-context-ref` (verified locally, subagent files); `attribution-snapshot`, `content-replacement`, `observer-ref`, `continued-in`, `resume-head-vouch` (CLI table) | ignored |

Common fields on conversation records: `type`, `uuid`, `parentUuid`, `timestamp` (ISO string), `sessionId`, `session_id`,
`version` (CLI version string), `cwd`, `gitBranch`, `entrypoint` (string: `cli`, `sdk-cli`, `sdk-ts`, `sdk-py`, …),
`userType`, `isSidechain` (bool), `slug`, `agentId` (subagent files). Metadata records carry `type`, `sessionId` and no
`timestamp` unless noted.

### `user`

- `message.content`: string, or blocks `{type:"text", text}`, `{type:"tool_result", tool_use_id, content, is_error?}`,
  `{type:"image", source}`, `{type:"document"}`.
- Provenance (verified locally): `promptSource` (string: `typed`, `queued`, `suggestion_accepted`, `sdk`, `system`),
  `turnOrigin` (string: `human`, `sdk`, `scheduled`, `task_notification`, `auto_continuation`, `peer`,
  `host_synthetic`, `system`, `unknown`), `origin` (object: `kind`, `producer`, `runId`, `from`, `name`, `body`,
  `handback`, `senderTaskId`, …), `permissionMode` (string), `promptId`, `turnPosition{promptIndex, turnIndex}`.
  Typed prompts carry `promptSource`/`turnOrigin`; slash-command invocations do not (below).
- Machine-inserted markers: `isMeta`, `isCompactSummary`, `isVisibleInTranscriptOnly`, `turnCompanion` (bool,
  verified locally); `sourceToolUseID` (string, verified locally); `isVirtual`, `textNotTyped`, `handedOff` (bool, CLI schema).
- Tool replies: `toolUseResult` (object | array | string), `sourceToolAssistantUUID`, `toolDenialKind` (string:
  `user-rejected`, `permission-rule`, `automode-blocked`, `automode-unavailable`, `automode-parsing-error`,
  `interrupted`, `cancelled`), `permissionDecision{decision, source, reasonType, reasonCode, ruleSource, …}`,
  `toolEndsTurn`, `sandboxed`, `mcpMeta`, `interruptedMessageId`.
- `toolUseResult` field sets by tool (verified locally): Bash `stdout`, `stderr`, `interrupted`, `isImage`,
  `noOutputExpected`, `returnCodeInterpretation`, `backgroundTaskId`, `gitOperation{commit{sha, kind, branch},
  push{branch}, pr{action, number, url}, branch{action, ref}}`; Edit/MultiEdit/Write `filePath`, `structuredPatch[]
  {oldStart, oldLines, newStart, newLines, lines[] ("+"/"-"/" " prefixed)}`, `originalFile`, `userModified`;
  WebFetch `code`, `codeText`, `durationMs`, `bytes`, `result`, `url`; WebSearch `query`, `results[]`,
  `durationSeconds`; Agent `status`, `agentId`, `totalDurationMs`, `totalToolUseCount`, `usage`, `content`.
  No `exitCode` is written for Bash in these versions: a failing command is `is_error:true` with content starting
  `Exit code <n>`; `exitCode` is read when present.
- Text shapes: an interrupt is a text block starting `[Request interrupted by user` (optionally `… for tool use]`).
  A skill or custom slash command submitted at the prompt is a user record without provenance fields whose text is
  `<command-message>…</command-message>` + `<command-name>/<name></command-name>` + optional
  `<command-args>…</command-args>` (older versions: `<command-name><name></command-name>` without the slash).
  Bash mode is `<bash-input>…</bash-input>` followed by `<bash-stdout>`/`<bash-stderr>` records. Local commands
  (`/model`, `/clear`, …) are not user records: they are `system`/`local_command` records, their output wrapped in
  `<local-command-stdout>`.

### `assistant`

- One record per content block (`apiBlockIndex`); the records of one API response share `message.id` (`msg_…`)
  and `requestId` (`req_…`), and each repeats `message.usage`.
- `message`: `model` (`<synthetic>` for CLI-made messages such as API errors), `id`, `role`, `type`, `stop_reason`,
  `stop_sequence`, `content[]` blocks `text`, `thinking{thinking, signature}`, `tool_use{id, name, input, caller{type}}`,
  `usage{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, cache_creation{…},
  server_tool_use{…}, output_tokens_details{…}, iterations[], service_tier, speed, inference_geo}`.
- Record fields: `requestId`, `effort` (string: `low`, `medium`, `high`, `xhigh`, `max`), `perTurnEffort`,
  `requestedModel`, `advisorModel`, `thinkingDurationMs`, `thinkingDisplay`, `toolInputStreamMs`, `isApiErrorMessage`,
  `apiError*`, `madeBy`, `wireToolInputs`, `wireIngestContext`, `attributionSkill`, `attributionPlugin`,
  `attributionMcpServer`, `attributionMcpTool`, `attributionAgent` (names; not read).

### `system`

`subtype` (string) selects the shape. Used: `turn_duration` {`durationMs`, `messageCount`,
`pendingBackgroundAgentCount`, `pendingWorkflowCount`}; `compact_boundary` {`compactMetadata{trigger (auto |
manual), preTokens, postTokens, durationMs, preservedSegment, …}`, `logicalParentUuid`}. Others (`local_command`,
`stop_hook_summary`, `away_summary`, `api_error`, `informational`, …) are ignored and are not drift.

### Metadata records

- `permission-mode` {`permissionMode` (string: `default`, `acceptEdits`, `plan`, `auto`, `bypassPermissions`, …)}.
- `session-owner` {`accountUuid`, `organizationUuid`}.
- `pr-link` {`prNumber` (number), `prUrl`, `prRepository`, `timestamp`}; re-stamped, so the same PR repeats.
- `cost-state` {`totalCostUSD`, `totalLinesAdded`, `totalLinesRemoved`, `totalDuration`, `totalAPIDuration`,
  `totalAPIDurationWithoutRetries`, `totalToolDuration`, `startTime`, `modelUsage{<model>: {inputTokens, outputTokens,
  thinkingTokens, cacheReadInputTokens, cacheCreationInputTokens, costUSD, webSearchRequests}}`,
  `hasUnknownModelCost`}; cumulative for the session.
- `queue-operation` {`operation` (string: `enqueue`, `dequeue`, `remove`, `popAll`, `popOne`), `content` (text),
  `timestamp`, `reason`, `commandUuid`, `deliveryId`}: the CLI's journal of its input queue. It logs every queued
  input — prompts typed while the agent is busy, and also task notifications, agent-to-agent messages and SDK
  input — so it does not measure prompts a person queued.
- Text-bearing, never read: `last-prompt{lastPrompt, leafUuid, explicit}`, `ai-title{aiTitle}`, `agent-name{agentName}`,
  `tools-used{tools[]}`, `mode{mode}`, `atis-latch{atis}`, `bridge-session{bridgeSessionId, lastSequenceNum,
  ownerAccountUuid, ownerOrganizationUuid}`, `artifact-*{v, artifacts, accountUuid}`,
  `fork-context-ref{agentId, parentSessionId, parentLastUuid, contextLength}`.
- `attachment` {`attachment{type, hookName, hookEvent, toolUseID, command, exitCode, durationMs, stdout, stderr,
  content, context{…}, snapshot{…}, …}`}: hook results and context injections, mixed with personal fields; ignored.

## Side files

- `agent-<id>.meta.json` (verified locally): `agentType` (string), `isBuiltIn` (bool), `spawnDepth` (number),
  `toolUseId` (string — the parent's `tool_use.id`; not set for workflow agents, which no tool call starts), `model`
  (string), `requestShape` (`foreground` | `background`), `stoppedByUser` (bool), plus `description`, `name`,
  `workflowPhase` (text), `isFork`, `finished`, `requestNonInteractive`, `launchedWithDefaults`, `parentAgentId`,
  `pickedEffortModel`, `spawnMode`. Read: `agentType`, `isBuiltIn`, `spawnDepth`, `model`, `toolUseId`,
  `requestShape`, `stoppedByUser`.
- `workflows/wf_<w>.json` (verified locally): `runId`, `taskId`, `status`, `agentCount`, `durationMs`, `totalToolCalls`,
  `totalTokens`, `startTime`, `timestamp`, `defaultModel`, `phases[]`, `workflowProgress[]`, `logs[]`, `args[]`,
  `result`, `summary`, `workflowName`, `script`, `scriptPath`. Read: `durationMs` only.

## What the reader emits

- Session ids: `claude-code:<session>` for a top-level transcript, `claude-code:<session>/<agent>` for a subagent,
  `claude-code:<session>/<wf run>/<agent>` for a workflow agent. Each part is the file or folder name only when it has
  the CLI's shape (UUID session stem, `agent-<alphanumeric>` agent stem, `wf_<letters, digits, _ or ->` run folder);
  any other name is replaced by its keyed hash.
- One `SessionEv` per transcript file with a timestamp: origin `human` when the top-level file has a human prompt, else
  `scripted`; `subagent` for agent files, with `parentId` = the top-level session and, for workflow agents,
  `workflowId` = keyed hash of `wf_<w>`. `start`/`end` = min/max record timestamp, `models` = distinct
  non-synthetic assistant models (subagent fallback: meta `model`), `version` = last `version` seen, `projectKey` from
  the first `cwd`, `surface` = first `entrypoint`, `agentType` raw for built-in agents (`isBuiltIn`, else the CLI's
  built-in list) and a keyed hash for custom ones. A model string that is not id-shaped becomes `other`.
- `PromptEv` only from top-level files, per `ccPromptOrigin` (origin.ts): any `sdk*` entrypoint → scripted; a
  `turnOrigin`/`promptSource` value the mapping does not know → system, and counted in coverage `unknownTypes` as
  `turnOrigin:<value>` / `promptSource:<value>` (`…:<other>` when the value is not token-shaped); the text is
  consulted only when both fields are absent. Slash-command and bash-mode markup is turned back into `/name args` /
  `!command` before intent, features and the text hash.
- `ToolEv` per `tool_use` (deduplicated by id), closed by its `tool_result`; MCP tools get `name:"mcp"` and the server in
  `mcpServer`; Agent/Task tools get `delegateTo` via meta `toolUseId`.
- `UsageEv` and `AnchorEv` (`cc-msg`, `cc-req`) once per `message.id`, usage fields taking the maximum over the
  message's block records.
- `TurnEv` per `turn_duration` (`effort` outside `low|medium|high|xhigh|max` becomes `other`); `TotalsEv` from the
  last `cost-state` and from each workflow summary (`claude-code:wf:<workflowId>`); `IdentityEv` per distinct
  `session-owner.accountUuid`; `FileFactEv` per fully read transcript.
- `MarkerEv`: `interrupt` (interrupt text; meta `stoppedByUser`), `compact-auto`/`compact-manual`, `permission-mode`
  (changes only), `pr-link` (one per PR, `detail` = keyed hash of the URL), `queue` (a human prompt with
  `promptSource:"queued"`), `denial` (`toolDenialKind:"user-rejected"`), `plan-enter`/`plan-exit` (tools),
  `commit` (`toolUseResult.gitOperation.commit`, `detail` = keyed hash of the sha).
- `CoverageEv.skipped` reasons: `sniffed`, `oversize`, `parse`, `io-error`, `too-large`, `bad-record` (a record the
  mapper could not handle; also logged once per root as `warn cc.bad-record`).

## Limits

- `--fork-session` copies history into a new transcript; both files would be counted. Debug log
  `cc.foreign-session-files` reports top-level files holding records of another session.
- Usage/anchor deduplication keeps a window of 256 messages per file; a message id recurring later counts again.
- Records whose `type` is a known heavy type but whose `type` key lies past the first 512 bytes are parsed and then
  dropped (debug log `cc.heavy-parsed`).

---

# Lifetime layer and configuration

Transcripts are pruned (`cleanupPeriodDays`); these files are not, so they carry the long view: when and how often
prompts were typed, model and effort switches, per-day totals, and configuration as the CLI counted its use. All three
readers report coverage with window `lifetime`.

## Layout

```
<root>/history.jsonl                          claude-code.history  one line per prompt typed at the CLI prompt
<root>/stats-cache.json                       claude-code.stats    the CLI's per-day aggregates behind /stats
<global config>                               claude-code.config   $CLAUDE_CONFIG_DIR/.claude.json when that variable
                                                                   is set, else <home>/.claude.json (CLI program)
<root>/settings.json                          claude-code.config   hooks
<root>/plugins/installed_plugins.json         claude-code.config   installed plugins
<home>/.agents/.skill-lock.json               claude-code.config   skills placed by the `skills` installer
<root>/skills/<name>/SKILL.md                 claude-code.config   skill folders (often symlinks into <home>/.agents/skills)
<root>/commands/<name>.md, agents/<name>.md   claude-code.config   custom slash commands, custom subagents
<root>/projects/<slug>/memory/*.md            claude-code.config   auto-memory files
not read: <root>/plugins/cache/ (only used to tell whether a skill folder resolves inside it), <root>/.config.json
          (legacy global config), settings.local.json, managed settings, project .claude/ folders and .mcp.json
```

Symlinked config files (settings.json, the global config, installed_plugins.json, the skill lock) are read through the
link: the target's own type and size are checked. history.jsonl and stats-cache.json are read only as regular files.

## history.jsonl (verified locally; schema per CLI program)

JSONL, one object per line, no `type` field. Fields: `display` (string — the prompt as typed; pasted content is
referenced from it and kept in `pastedContents`), `pastedContents` (object keyed by paste id → `{id (number), type
(string), content? (string), contentHash? (string), …}`; the CLI drops malformed entries), `timestamp` (number, epoch
ms), `project` (string — the working directory), `sessionId` (string; optional in the CLI's schema, so older lines may
lack it). Local commands (`/model …`, `/effort …`, `/compact`) are recorded like any other prompt.

Read: `display` (in memory only), `timestamp`, `sessionId`; `pastedContents` is only tested for having entries.
Never read: the values inside `pastedContents`, `project`.

- `PromptEv` per line: window `lifetime`, origin `human`, `sessionId` = `claude-code:<id>` (the id verbatim when
  UUID-shaped, else its keyed hash; omitted when absent or empty), intent and features from the text, `textHash` = keyed
  hash of the trimmed text, `hasPaste` = `pastedContents` has entries. `isTaskStart` = first prompt of the session, or
  ≥ 30 min after that session's previous prompt; `simToPrev` compares with that session's previous prompt (lines of
  concurrent sessions interleave; state is kept for the 256 most recent sessions).
- `MarkerEv` for local commands, with the prompt's `ts` and `sessionId` (argument text is never kept):
  `/model <x>` → `model-switch`, `detail` = the first of `opus`, `sonnet`, `haiku`, `fable` contained in `<x>`
  (case-insensitive), else `other`; `/effort <x>` → `effort-switch`, `detail` = the first word of `<x>` when it is
  `low|medium|high|xhigh|max`, else `other`; without an argument (the interactive picker) neither has a `detail`;
  `/clear` and its aliases `/reset`, `/new` (CLI program) → `clear`; `/compact [instructions]` → `compact-manual`.
- `DailyEv{source:"claude-code.history"}` per local day (the process time zone) with the day's prompt count.
- Drift (`unknownTypes`): `line:not-object`, `display:missing` (no string `display`), `timestamp:missing`.
  Skipped: `parse`, `oversize`, `io-error`, `bad-ts` (a timestamp that is not a plausible time), `empty` (blank
  `display`), `bad-record`. Coverage `from`/`to` = first/last prompt time.

## stats-cache.json (verified locally; semantics per CLI program)

One JSON object: `version` (number — the cache format; the CLI program reads 1–5 and writes 5), `lastComputedDate`
(`YYYY-MM-DD`), `dailyActivity[]` {`date` (`YYYY-MM-DD`), `messageCount`, `sessionCount`, `toolCallCount` (numbers)},
`dailyModelTokens[]` {`date`, `tokensByModel` {`<model id>`: number}}, `dailyModelTokensVersion` (number),
`modelUsage` {`<model id>`: {`inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`,
`webSearchRequests`, `costUSD`, `contextWindow`, `maxOutputTokens`}}, `totalSessions`, `totalMessages` (numbers),
`longestSession` {`sessionId`, `duration`, `messageCount`, `timestamp`}, `firstSessionDate` (ISO string),
`hourCounts` {`<hour>`: number}.

How the CLI fills it (CLI program): a `date` is the **UTC** day (the date part of `toISOString`) — unlike history's
local days, so the two are not comparable day by day; `messageCount` counts transcript messages of top-level sessions
whoever wrote them, not only typed prompts; `sessionCount` counts sessions that started that day; `toolCallCount` counts
`tool_use` blocks, subagents included; `tokensByModel` sums input, output and cache tokens per model, subagents
included; `hourCounts` keys are local hours of session starts. The CLI refreshes the cache now and then, not with
every session (`lastComputedDate`), so it can lag behind the transcripts.

Read: `version`, `dailyActivity`, `dailyModelTokens`; the rest is parsed with the file and dropped.

- `DailyEv{source:"claude-code.stats"}` per `dailyActivity` entry: `day` = `date`, `prompts` = `messageCount`,
  `sessions` = `sessionCount`, `toolCalls` = `toolCallCount`, `models` = that day's `tokensByModel` (keys that are
  not model-id-shaped become `other`; equal keys are summed; negative counts are ignored).
- Drift: `version:missing`, `version:newer` (above 5), `dailyActivity:missing`, `dailyActivity:shape` (an entry
  without a real `YYYY-MM-DD` date or a numeric `messageCount`), `dailyModelTokens:type`, `dailyModelTokens:shape`.
  Coverage `records` = entries read from both arrays; `from`/`to` = start of the first and end of the last
  `dailyActivity` day, in UTC.

## Global config (`.claude.json`) — a mixed file (CLI program; the probe's path limit hides these fields)

Parsed in memory with a 64 MiB cap (older CLIs keep per-project data here; over the cap → skipped `too-large`,
coverage `note:"too-large"`, and none of the fields below). Only these fields are read; everything else is dropped with
the parse tree:

- `oauthAccount` {`accountUuid`, `emailAddress`, `organizationUuid`, `displayName`, …} — only `accountUuid`, as a
  keyed hash → `IdentityEv{scope:"config"}`.
- `promptQueueUseCount` (number) — incremented each time the input queue goes from empty to non-empty →
  `MarkerEv{kind:"queue", detail:"lifetime-total", n}` with `ts` = the file's mtime (the total holds as of the last write).
- `lastPlanModeUse` (number, epoch ms; the CLI updates it at most once per 24 h) → `MarkerEv{kind:"plan-enter", ts}`.
- `firstStartTime` (ISO string, written on first start) → coverage `from`.
- `skillUsage` {`<name>`: {`usageCount`, `lastUsedAt` (epoch ms)}} — recorded when a skill or prompt-type slash
  command runs (typed, or through the Skill tool), at most once per minute per name. Names are plain for personal,
  project, bundled skills and custom commands, `<plugin>:<name>` for plugin-provided ones.
- `pluginUsage` {`<plugin id>`: {`usageCount`, `lastUsedAt`, `lastUsedNumStartups`}} — entries start at
  `usageCount` 0 when a plugin is installed, and `lastUsedAt` is also refreshed without use, so only `usageCount` is read.
- `mcpServers` {`<name>`: {…}} and `projects` {`<path>`: {`mcpServers` {`<name>`: {…}}, `allowedTools`, …}} — only
  the server names (the keys) are read; never the definitions (`type`, `command`, `args`, `env`, `url`, `headers`) and
  never the project paths.

Drift: an allowlisted field present with another JSON type → `<field>:type` (`promptQueueUseCount`, `lastPlanModeUse`,
`firstStartTime`, `oauthAccount`, `skillUsage`, `pluginUsage`, `mcpServers`, `projects`, `projects.mcpServers`); a
usage entry without a numeric `usageCount` → `skillUsage:shape` / `pluginUsage:shape`.

## settings.json, installed_plugins.json, the skill lock (verified locally)

- settings.json `hooks` {`<Event>`: [{`matcher`?, `hooks`: [{`type`, `command`?, `timeout`?, …}]}]}. Drift:
  `hooks:type`, `hooks:shape`.
- plugins/installed_plugins.json {`version` (number), `plugins` {`<plugin id>`: [{`scope`, `installPath`, `version`,
  `installedAt`, `lastUpdated`, `gitCommitSha`, `directoryRepositoryKey`?}]}} — only the keys of `plugins` are read.
- `.skill-lock.json` (written by the `skills` installer, shared by several agents) {`version`, `skills` {`<name>`:
  {`source`, `sourceType`, `sourceUrl`, `skillPath`, `skillFolderHash`, `installedAt`, `updatedAt`, `pluginName`}},
  `dismissed` {…}, `lastSelectedAgents` []} — only the keys of `skills` are read.

## What the configuration reader emits

`ConfigEv.name` holds the raw config name (skill, command, agent, plugin id, MCP server, hook event) for the export
allowlist; it is never exported raw.

- `skill`: each `skills/<name>/` holding a `SKILL.md` (hidden entries skipped), plus each `skillUsage` name that matches
  neither a skill folder nor a command file. Provenance: `installed` when the skill lock lists the name, the folder
  resolves inside `<root>/plugins/cache/`, or a usage-only name carries a `<plugin>:` prefix; `authored` for other
  skill folders; `unknown` for usage-only names found nowhere on disk (bundled with the CLI, project-level, or
  removed) and for skill folders when the skill lock exists but cannot be read.
- `command` / `agent`: each `commands/<name>.md` / `agents/<name>.md` (names only), `authored`. A command's usage is
  the `skillUsage` entry of its name when no skill folder has that name.
- `plugin`: each installed plugin id and each `pluginUsage` id, `installed`.
- `mcp-server`: each distinct server name, global or per project, `unknown`.
- `hook`: one per hook entry, `authored`; `name` = the event key when it is shaped like a CLI event name
  (`^[A-Z][A-Za-z]{2,40}$`), else `other`; `checks` = `classifyCommand(command).checks` for hooks with a `command`
  (the command text is never kept).
- `memory-file`: one per `projects/<slug>/memory/*.md`, `authored`, no name; the files are never opened.
- `uses` on skills, commands and plugins (and `lastUsed` on skills and commands) whenever the global config was read:
  the CLI's `usageCount`, or 0 for an inventory item without a usage entry; absent when the global config is missing
  or unusable.
- Coverage: `files`/`bytes` = the JSON files read; `records` = events emitted; `from` = `firstStartTime` (else the
  earliest marker); `to` = the latest marker. Skipped reasons: `parse`, `io-error`, `too-large`, `not-file`.

## Limits (lifetime layer)

- stats-cache days are UTC days and history DailyEv days are local days: match them day by day only after bucketing
  history prompts (`PromptEv.ts`) by UTC day.
- `skillUsage` counts at most one use per minute per name.
- `lastPlanModeUse` is a single timestamp refreshed at most once a day, not a count.
- history.jsonl and the transcripts both yield prompts, and history and transcripts both yield `compact-manual`
  markers (as config and transcripts both yield `plan-enter`): they are told apart by `source`/`window`, never summed.
- A usage-only skill without a `<plugin>:` prefix and not in the skill lock cannot be attributed (provenance `unknown`).
