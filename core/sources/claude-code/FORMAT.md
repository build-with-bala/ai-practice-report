# Claude Code — transcripts, subagents, workflows

Reader: `claude-code.transcripts` (`transcripts.ts`, `origin.ts`, `tools.ts`).

Evidence: **(verified locally)** = seen by the structure probe on a real store written by many CLI 2.1.x versions.
**(CLI table)** = listed in the CLI program's own transcript entry-type tables (2.1.326), not seen locally.
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
          subagents/agent-<id>.forked-skill.json and .forked-skill.marker.json, <slug>/memory/ (Task 10)
```

- `<slug>` is derived from the cwd and is never parsed; project identity comes from record `cwd`.
- The file stem of a top-level transcript is its session id; its records' `sessionId` equals the stem (verified locally,
  every file). Subagent and workflow-agent records repeat the parent's `sessionId` and add `agentId`.
- The `wf_<w>` directory name and the `workflows/wf_<w>.json` stem are the same run id.

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
`version` (CLI version string), `cwd`, `gitBranch`, `entrypoint` (string: `cli`, `sdk-cli`, …), `userType`, `isSidechain`
(bool), `slug`, `agentId` (subagent files). Metadata records carry `type`, `sessionId` and no `timestamp` unless noted.

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
  Skill/custom slash commands are user records without provenance fields whose text is
  `<command-message>…</command-message>` + `<command-name>/<name></command-name>` + optional
  `<command-args>…</command-args>` (older versions: `<command-name><name></command-name>` without the slash);
  they follow an idle point (`turn_duration`, `away_summary`, or a meta caveat), never a tool reply (verified locally).
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
- Record fields: `requestId`, `effort`, `perTurnEffort`, `requestedModel`, `advisorModel`, `thinkingDurationMs`,
  `thinkingDisplay`, `toolInputStreamMs`, `isApiErrorMessage`, `apiError*`, `madeBy`, `wireToolInputs`,
  `wireIngestContext`, `attributionSkill`, `attributionPlugin`, `attributionMcpServer`, `attributionMcpTool`,
  `attributionAgent` (names; not read).

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
  `timestamp`, `reason`, `commandUuid`, `deliveryId`}: the CLI's journal of its input queue. It logs task
  notifications, agent-to-agent messages and SDK input as well as prompts typed while the agent is busy; on the
  local store most enqueues were markup-wrapped notifications and most plain-text ones never became a prompt in
  that file, so it is not a steering signal.
- Text-bearing, never read: `last-prompt{lastPrompt, leafUuid, explicit}`, `ai-title{aiTitle}`, `agent-name{agentName}`,
  `tools-used{tools[]}`, `mode{mode}`, `atis-latch{atis}`, `bridge-session{bridgeSessionId, lastSequenceNum,
  ownerAccountUuid, ownerOrganizationUuid}`, `artifact-*{v, artifacts, accountUuid}`,
  `fork-context-ref{agentId, parentSessionId, parentLastUuid, contextLength}`.
- `attachment` {`attachment{type, hookName, hookEvent, toolUseID, command, exitCode, durationMs, stdout, stderr,
  content, context{…}, snapshot{…}, …}`}: hook results and context injections, mixed with personal fields; ignored.

## Side files

- `agent-<id>.meta.json` (verified locally): `agentType` (string), `isBuiltIn` (bool), `spawnDepth` (number),
  `toolUseId` (string — the parent's `tool_use.id`; absent for workflow agents), `model` (string), `requestShape`
  (`foreground` | `background`), `stoppedByUser` (bool), plus `description`, `name`, `workflowPhase` (text), `isFork`,
  `finished`, `requestNonInteractive`, `launchedWithDefaults`, `parentAgentId`, `pickedEffortModel`, `spawnMode`.
  Read: `agentType`, `isBuiltIn`, `spawnDepth`, `model`, `toolUseId`, `requestShape`, `stoppedByUser`.
- `workflows/wf_<w>.json` (verified locally): `runId`, `taskId`, `status`, `agentCount`, `durationMs`, `totalToolCalls`,
  `totalTokens`, `startTime`, `timestamp`, `defaultModel`, `phases[]`, `workflowProgress[]`, `logs[]`, `args[]`,
  `result`, `summary`, `workflowName`, `script`, `scriptPath`. Read: `durationMs` only.

## What the reader emits

- One `SessionEv` per transcript file with a timestamp: top-level `claude-code:<sid>` (origin `human` when it has a
  human prompt, else `scripted`); subagents and workflow agents `claude-code:<sid>/agent-<id>` (origin `subagent`,
  `parentId` = the top-level session, `workflowId` = keyed hash of `wf_<w>`). `start`/`end` = min/max record
  timestamp, `models` = distinct non-synthetic assistant models (subagent fallback: meta `model`), `version` = last
  `version` seen, `projectKey` from the first `cwd`, `surface` = first `entrypoint`, `agentType` raw for built-in
  agents (`isBuiltIn`, else the CLI's built-in list) and a keyed hash for custom ones.
- `PromptEv` only from top-level files, per `ccPromptOrigin` (origin.ts); slash-command and bash-mode markup is turned
  back into `/name args` / `!command` before intent, features and the text hash.
- `ToolEv` per `tool_use` (deduplicated by id), closed by its `tool_result`; MCP tools get `name:"mcp"` and the server in
  `mcpServer`; Agent/Task tools get `delegateTo` via meta `toolUseId`.
- `UsageEv` and `AnchorEv` (`cc-msg`, `cc-req`) once per `message.id`, usage fields taking the maximum over the
  message's block records.
- `TurnEv` per `turn_duration`; `TotalsEv` from the last `cost-state` and from each workflow summary
  (`claude-code:wf:<workflowId>`); `IdentityEv` per distinct `session-owner.accountUuid`; `FileFactEv` per fully read
  transcript.
- `MarkerEv`: `interrupt` (interrupt text; meta `stoppedByUser`), `compact-auto`/`compact-manual`, `permission-mode`
  (changes only), `pr-link` (one per PR, `detail` = keyed hash of the URL), `queue` (a human prompt with
  `promptSource:"queued"`), `denial` (`toolDenialKind:"user-rejected"`), `plan-enter`/`plan-exit` (tools),
  `commit` (`toolUseResult.gitOperation.commit`, `detail` = keyed hash of the sha).

## Limits

- `--fork-session` copies history into a new transcript; both files would be counted. No top-level file on the local
  store held another session's records (debug log `cc.foreign-session-files`).
- Usage/anchor deduplication keeps a window of 256 messages per file; a message id recurring later counts again.
- Records whose `type` is a known heavy type but whose `type` key lies past the first 512 bytes are parsed and then
  dropped (debug log `cc.heavy-parsed`); none on the local store.
