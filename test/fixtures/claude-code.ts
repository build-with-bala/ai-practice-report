// Synthetic Claude Code stores. Field names mirror the CLI's own transcript schema (2.1.x); every value is invented.
import { CANARY } from "../kit/canary";
import type { FakeHome } from "../kit/home";

export const CC_OPUS = "claude-opus-5-5";
export const CC_HAIKU = "claude-haiku-5-5";
export const MIN = 60_000;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
let apiSeq = 0;

/** Increasing server-style ids (`msg_…` / `req_…`), base58 after the 4-char prefix. */
export function apiId(prefix: "msg_" | "req_", n: number): string {
  let s = "";
  for (let i = 0, x = n; i < 6; i++, x = Math.floor(x / 58)) s = B58[x % 58] + s;
  return `${prefix}01Fx${s}`;
}

export const iso = (ms: number): string => new Date(ms).toISOString();

/** A minute-aligned start a few days back, so timestamps stay plausible whatever the clock says. */
export function fixtureStart(daysAgo = 3): number {
  return Math.floor((Date.now() - daysAgo * 86_400_000) / MIN) * MIN;
}

/** Project folder name the CLI derives from a cwd (every non-alphanumeric character becomes "-"). */
export const slug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, "-");

/** A UUID-shaped session id (as the CLI names transcripts) derived from a short label of ≤ 6 ASCII characters. */
export function ccSid(label: string): string {
  return `00000000-0000-4000-8000-${Buffer.from(label, "latin1").toString("hex").padStart(12, "0").slice(-12)}`;
}

export const CC_S1 = ccSid("S1");
export const CC_S2 = ccSid("S2");

export interface CcOpts { cwd?: string; start?: number; version?: string; agentId?: string; model?: string }
export interface CcResult { content?: unknown; isError?: boolean; toolUseResult?: unknown; extra?: Record<string, unknown>; noResult?: boolean }

/** Builds one transcript file record by record with a running clock (5 s between records by default). */
export class CcTranscript {
  readonly records: Record<string, unknown>[] = [];
  t: number;
  version: string;
  private seq = 0;

  constructor(readonly sessionId: string, private readonly o: CcOpts = {}) {
    this.t = o.start ?? fixtureStart();
    this.version = o.version ?? "2.1.300";
  }

  private uuid(n: number): string {
    return `u-${this.sessionId}-${this.o.agentId ?? "main"}-${n}`;
  }

  base(type: string, dt = 5_000): Record<string, unknown> {
    this.t += dt;
    this.seq++;
    return {
      parentUuid: this.seq > 1 ? this.uuid(this.seq - 1) : null,
      isSidechain: this.o.agentId !== undefined,
      ...(this.o.agentId !== undefined && { agentId: this.o.agentId }),
      userType: "external",
      cwd: this.o.cwd ?? "/work/proj",
      sessionId: this.sessionId,
      version: this.version,
      gitBranch: "main",
      entrypoint: "cli",
      type,
      uuid: this.uuid(this.seq),
      timestamp: iso(this.t),
    };
  }

  raw(rec: Record<string, unknown>): this {
    this.records.push(rec);
    return this;
  }

  /** A prompt the person typed (current CLI provenance fields). */
  prompt(text: string, fields: Record<string, unknown> = {}, dt?: number): this {
    return this.raw({
      ...this.base("user", dt),
      promptSource: "typed",
      turnOrigin: "human",
      permissionMode: "auto",
      promptId: `p-${this.seq}`,
      message: { role: "user", content: text },
      ...fields,
    });
  }

  user(fields: Record<string, unknown>, dt?: number): this {
    return this.raw({ ...this.base("user", dt), message: { role: "user", content: "" }, ...fields });
  }

  assistant(content: unknown[], fields: Record<string, unknown> = {}, dt = 3_000): this {
    const n = ++apiSeq;
    return this.raw({
      ...this.base("assistant", dt),
      requestId: apiId("req_", n),
      effort: "high",
      message: {
        model: this.o.model ?? CC_OPUS,
        id: apiId("msg_", n),
        type: "message",
        role: "assistant",
        content,
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 100 + n, output_tokens: 20, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 50, service_tier: "standard" },
      },
      ...fields,
    });
  }

  /** An assistant tool_use record followed by its tool_result user record. */
  tool(id: string, name: string, input: unknown, res: CcResult = {}): this {
    this.assistant([{ type: "tool_use", id, name, input, caller: { type: "direct" } }]);
    if (res.noResult) return this;
    return this.raw({
      ...this.base("user", 2_000),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: res.content ?? "ok", is_error: res.isError ?? false }] },
      ...(res.toolUseResult !== undefined && { toolUseResult: res.toolUseResult }),
      sourceToolAssistantUUID: this.uuid(this.seq - 1),
      ...res.extra,
    });
  }

  text(text: string): this {
    return this.assistant([{ type: "text", text }]);
  }

  system(subtype: string, fields: Record<string, unknown>): this {
    return this.raw({ ...this.base("system"), subtype, isMeta: false, level: "info", ...fields });
  }

  attachment(attachment: Record<string, unknown>): this {
    return this.raw({ ...this.base("attachment"), attachment });
  }

  write(h: FakeHome, rel: string): string {
    return h.writeJsonl(rel, this.records);
  }
}

export interface CcFixture {
  projA: string;
  projB: string;
  start: number;
  /** Facts derived from the written records, for expectations that must not come from the code under test. */
  s1LastTs: number;
  turnTs: number;
  firstTs: number;
  lastTs: number;
  /** JSONL lines written across the four transcripts (two of them are heavy lines the reader must sniff away). */
  jsonlRecords: number;
  /** Home-relative paths of every file the reader is expected to open. */
  readFiles: string[];
}

const timestamps = (records: Record<string, unknown>[]): number[] =>
  records.flatMap((r) => (typeof r.timestamp === "string" ? [Date.parse(r.timestamp)] : []));

/**
 * Task 9 scenario. Project A (cwd = CANARY.path), session S1: 3 typed prompts, 1 queued, 1 isMeta, 1 compact summary,
 * 1 interrupt, 1 task notification, 1 sdk-cli prompt; Read, Edit (+3/-1), Bash `bun test` failing then passing,
 * Agent `toolu_A`; turn_duration, compact_boundary, permission-mode, pr-link, queue-operation, cost-state,
 * a 100 KB api-request-blob, a file-history-snapshot, one unknown record type. Subagent a1 (Explore) with
 * 4 tool uses; workflow wf_x1 with one agent (2 tool uses) and its summary. Project B, session S2: 2 typed prompts.
 * Session files are named by UUID-shaped ids (CC_S1, CC_S2), as the CLI names them.
 */
export function buildCcTranscripts(h: FakeHome): CcFixture {
  const projA = `.claude/projects/${slug(CANARY.path)}`;
  const projB = `.claude/projects/${slug("/work/projB")}`;
  const start = fixtureStart();
  const S1 = CC_S1;

  const s1 = new CcTranscript(S1, { cwd: CANARY.path, start });
  s1.raw({ type: "permission-mode", permissionMode: "auto", sessionId: S1 })
    .raw({ type: "session-owner", accountUuid: "uuid-1", organizationUuid: "org-1", sessionId: S1 })
    .prompt(`Implement the importer below. ${CANARY.prompt}\n\`\`\`ts\n${CANARY.code}\n\`\`\`\nIt must reject empty input.`)
    .tool("toolu_R1", "Read", { file_path: `${CANARY.path}/src/a.ts` }, {
      content: CANARY.code,
      toolUseResult: { type: "text", file: { filePath: `${CANARY.path}/src/a.ts`, content: CANARY.code, numLines: 1, startLine: 1, totalLines: 1 } },
    })
    .tool("toolu_E1", "Edit", { file_path: "src/a.ts", old_string: CANARY.code, new_string: "one" }, {
      content: "The file src/a.ts has been updated.",
      toolUseResult: {
        filePath: "src/a.ts", oldString: CANARY.code, newString: "one", originalFile: CANARY.code, userModified: false, replaceAll: false,
        structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 5, lines: [" keep", `-${CANARY.code}`, "+one", "+two", "+three", " keep"] }],
      },
    })
    .tool("toolu_B1", "Bash", { command: "bun test", description: "Run tests" }, {
      isError: true, content: "Exit code 1\n1 fail",
      toolUseResult: { stdout: "", stderr: "1 fail", interrupted: false, isImage: false, noOutputExpected: false },
    })
    .tool("toolu_B2", "Bash", { command: "bun test", description: "Run tests" }, {
      content: "12 pass",
      toolUseResult: { stdout: "12 pass", stderr: "", interrupted: false, isImage: false, noOutputExpected: false },
    })
    .tool("toolu_A", "Agent", { description: "Explore the importer", prompt: CANARY.prompt, subagent_type: "Explore" }, {
      content: [{ type: "text", text: CANARY.prompt }],
      toolUseResult: { status: "completed", agentId: "a1", prompt: CANARY.prompt, content: [{ type: "text", text: CANARY.prompt }], totalDurationMs: 4_000, totalToolUseCount: 4, totalTokens: 900 },
    })
    .text("Done.")
    .system("turn_duration", { durationMs: 1_200, messageCount: 14, pendingBackgroundAgentCount: 0 })
    .prompt("/model opus")
    .prompt("Why does the importer reject empty input?");
  s1.version = "2.1.301";
  s1.raw({ type: "queue-operation", operation: "enqueue", timestamp: iso(s1.t + 1_000), sessionId: S1, content: CANARY.prompt })
    .raw({ type: "queue-operation", operation: "dequeue", timestamp: iso(s1.t + 2_000), sessionId: S1 })
    .prompt("Also add a regression test for the empty case", { promptSource: "queued", turnOrigin: undefined })
    .raw({ type: "session-owner", accountUuid: "uuid-1", organizationUuid: "org-1", sessionId: S1 })
    .user({ isMeta: true, message: { role: "user", content: `<system-reminder>${CANARY.prompt}</system-reminder>` } })
    .system("compact_boundary", { content: "Conversation compacted", compactMetadata: { trigger: "auto", preTokens: 150_000, postTokens: 9_000, durationMs: 3_000 } })
    .user({ isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: "user", content: `This session is being continued from a previous conversation. ${CANARY.code}` } })
    .user({ message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } })
    .user({ turnOrigin: "task_notification", promptSource: "system", origin: { kind: "task-notification" }, message: { role: "user", content: `<task-notification>${CANARY.prompt}</task-notification>` } })
    .user({ entrypoint: "sdk-cli", message: { role: "user", content: "Summarize the changes" } })
    .raw({ type: "pr-link", sessionId: S1, prNumber: 7, prUrl: `https://github.com/canary/${CANARY.project}/pull/7`, prRepository: `canary/${CANARY.project}`, timestamp: iso(s1.t + 2_000) })
    .raw({
      type: "cost-state", sessionId: S1, totalCostUSD: 1.5, totalAPIDuration: 20_000, totalAPIDurationWithoutRetries: 20_000, totalToolDuration: 5_000,
      totalLinesAdded: 10, totalLinesRemoved: 2, totalDuration: 60_000, startTime: start, hasUnknownModelCost: false,
      modelUsage: { [CC_OPUS]: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 1.5, webSearchRequests: 0 } },
    })
    .raw({ type: "api-request-blob", sessionId: S1, hash: "h1", message: { role: "user", content: [{ type: "text", text: CANARY.secret + "x".repeat(100_000) }] } })
    .raw({
      type: "file-history-snapshot", messageId: "m1", isSnapshotUpdate: false,
      snapshot: { messageId: "m1", trackedFileBackups: { [`${CANARY.path}/src/a.ts`]: { backupFileName: "b@v1", version: 1, backupTime: iso(start) } }, timestamp: iso(start) },
    })
    .raw({ type: "brand-new-type", sessionId: S1, payload: CANARY.token })
    .raw({ type: "ai-title", aiTitle: CANARY.prompt, sessionId: S1 })
    .raw({ type: "last-prompt", lastPrompt: CANARY.prompt, leafUuid: "u-S1-main-3", sessionId: S1 })
    .attachment({ type: "hook_success", hookName: "Stop", hookEvent: "Stop", toolUseID: "x", content: "", stdout: CANARY.secret, stderr: "", exitCode: 0, command: "echo hi", durationMs: 4, context: { userEmail: CANARY.email } });
  s1.write(h, `${projA}/${S1}.jsonl`);

  const sub = new CcTranscript(S1, { cwd: CANARY.path, start: start + 30_000, agentId: "a1", model: CC_HAIKU });
  sub.user({ message: { role: "user", content: CANARY.prompt } })
    .tool("toolu_s1", "Read", { file_path: `${CANARY.path}/src/a.ts` }, { content: CANARY.code })
    .tool("toolu_s2", "Grep", { pattern: "canarySecretFn", path: CANARY.path }, { content: "src/a.ts" })
    .tool("toolu_s3", "Glob", { pattern: "**/*.ts", path: CANARY.path }, { content: "src/a.ts" })
    .tool("toolu_s4", "Read", { file_path: `${CANARY.path}/src/b.ts` }, { content: CANARY.code })
    .text(CANARY.prompt);
  sub.write(h, `${projA}/${S1}/subagents/agent-a1.jsonl`);
  h.writeJson(`${projA}/${S1}/subagents/agent-a1.meta.json`, {
    agentType: "Explore", spawnDepth: 1, toolUseId: "toolu_A", model: CC_HAIKU, description: CANARY.prompt, requestShape: "foreground",
  });

  const wf = new CcTranscript(S1, { cwd: CANARY.path, start: start + 60_000, agentId: "w1", model: CC_HAIKU });
  wf.user({ message: { role: "user", content: CANARY.prompt } })
    .tool("toolu_w1", "Read", { file_path: `${CANARY.path}/README.md` }, { content: CANARY.code })
    .tool("toolu_w2", "Grep", { pattern: "importer" }, { content: "" })
    .text("ok");
  wf.write(h, `${projA}/${S1}/subagents/workflows/wf_x1/agent-w1.jsonl`);
  h.writeJson(`${projA}/${S1}/subagents/workflows/wf_x1/agent-w1.meta.json`, {
    agentType: "workflow-subagent", isBuiltIn: true, spawnDepth: 1, description: CANARY.prompt, workflowPhase: CANARY.project, requestShape: "background",
  });
  h.writeJson(`${projA}/${S1}/workflows/wf_x1.json`, {
    runId: "wf_x1", taskId: "t1", workflowName: CANARY.project, script: CANARY.code, scriptPath: `${CANARY.path}/flows/x.js`,
    agentCount: 1, durationMs: 1_000, totalToolCalls: 2, totalTokens: 500, status: "completed", startTime: start, timestamp: iso(start),
  });

  const s2 = new CcTranscript(CC_S2, { cwd: "/work/projB", start: start + 3 * 3_600_000 });
  s2.prompt("Add pagination to the list endpoint")
    .text("Added.")
    .prompt("Does it handle the last page correctly?", {}, 45 * MIN)
    .text("Yes.");
  s2.write(h, `${projB}/${CC_S2}.jsonl`);

  const all = [s1, sub, wf, s2].flatMap((t) => timestamps(t.records));
  const turn = s1.records.find((r) => r.subtype === "turn_duration")!;
  return {
    projA, projB, start,
    s1LastTs: Math.max(...timestamps(s1.records)),
    turnTs: Date.parse(turn.timestamp as string),
    firstTs: Math.min(...all),
    lastTs: Math.max(...all),
    jsonlRecords: [s1, sub, wf, s2].reduce((n, t) => n + t.records.length, 0),
    readFiles: [
      `${projA}/${S1}.jsonl`, `${projA}/${S1}/subagents/agent-a1.jsonl`, `${projA}/${S1}/subagents/agent-a1.meta.json`,
      `${projA}/${S1}/subagents/workflows/wf_x1/agent-w1.jsonl`, `${projA}/${S1}/subagents/workflows/wf_x1/agent-w1.meta.json`,
      `${projA}/${S1}/workflows/wf_x1.json`, `${projB}/${CC_S2}.jsonl`,
    ],
  };
}

// ---- Task 10: lifetime layer (history.jsonl, stats-cache.json) and configuration ----

/** Epoch ms of a wall-clock time in Pacific/Auckland while New Zealand daylight time (UTC+13) is in force. */
export const nzdt = (day: string, hhmm: string): number => Date.parse(`${day}T${hhmm}:00+13:00`);

export const CC_H1 = ccSid("H1");
export const CC_H2 = ccSid("H2");

/** One history.jsonl line as the CLI writes it (`project` is the working directory; `sessionId` is absent on older lines). */
export function ccHistoryLine(display: string, timestamp: unknown, sessionId?: string, pastedContents: Record<string, unknown> = {}): Record<string, unknown> {
  return { display, pastedContents, timestamp, project: CANARY.path, ...(sessionId !== undefined && { sessionId }) };
}

export interface CcLifetimeFixture {
  /** Timestamps of the history lines, in file order. */
  historyTs: number[];
  /** Prompts per day as Pacific/Auckland counts them, and as UTC would (the two must differ for the test to mean anything). */
  aucklandDays: [string, number][];
  utcDays: [string, number][];
  statsDays: string[];
  firstStart: number;
  lastPlanModeUse: number;
  skillLastUsed: number;
  /** Home-relative path of the global config file. */
  configFile: string;
}

/**
 * Task 10 scenario. history.jsonl: 8 prompts over two Auckland days (one session per day plus one line without a
 * sessionId), including `/model opus`, `/effort high`, `/clear` and one prompt with pasted content (CANARY.code).
 * stats-cache.json: 3 dailyActivity days, tokens for two of them. ~/.claude.json: account (CANARY.email), a global MCP
 * server whose definition holds CANARY.secret, a project MCP server (CANARY.host, CANARY.token) under a project keyed
 * by CANARY.path, skill and plugin usage. settings.json: a `bun test` PostToolUse hook and a Stop hook whose command
 * holds canaries. Two skill folders (one in ~/.agents/.skill-lock.json), a command, an agent, an installed plugin and
 * two memory files whose contents are canaries.
 */
export function buildCcLifetime(h: FakeHome): CcLifetimeFixture {
  const history = [
    ccHistoryLine(`Refactor the importer to stream its input. ${CANARY.prompt}`, nzdt("2026-01-14", "09:00"), CC_H1),
    ccHistoryLine("/model opus", nzdt("2026-01-14", "09:05"), CC_H1),
    ccHistoryLine("/effort high", nzdt("2026-01-14", "09:10"), CC_H1),
    ccHistoryLine("Fix the failing test, trace below [Pasted text #1 +3 lines]", nzdt("2026-01-14", "09:20"), CC_H1,
      { 1: { id: 1, type: "text", content: CANARY.code } }),
    ccHistoryLine("/clear", nzdt("2026-01-14", "23:30"), CC_H1),
    ccHistoryLine("Add pagination to the list endpoint", nzdt("2026-01-15", "00:30"), CC_H2),
    ccHistoryLine("Why does the last page repeat?", nzdt("2026-01-15", "00:40"), CC_H2),
    ccHistoryLine("ok ship it", nzdt("2026-01-15", "01:00")),
  ];
  h.writeJsonl(".claude/history.jsonl", history);

  h.writeJson(".claude/stats-cache.json", {
    version: 5, lastComputedDate: "2026-01-16",
    dailyActivity: [
      { date: "2026-01-13", messageCount: 120, sessionCount: 2, toolCallCount: 40 },
      { date: "2026-01-14", messageCount: 80, sessionCount: 1, toolCallCount: 25 },
      { date: "2026-01-16", messageCount: 10, sessionCount: 1, toolCallCount: 0 },
    ],
    dailyModelTokens: [
      { date: "2026-01-13", tokensByModel: { [CC_OPUS]: 50_000, [CC_HAIKU]: 4_000 } },
      { date: "2026-01-14", tokensByModel: { [CC_OPUS]: 20_000 } },
    ],
    dailyModelTokensVersion: 5,
    modelUsage: { [CC_OPUS]: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 1.2, contextWindow: 200_000, maxOutputTokens: 32_000 } },
    totalSessions: 4, totalMessages: 210,
    longestSession: { sessionId: CANARY.project, duration: 3_600_000, messageCount: 90, timestamp: "2026-01-13T20:00:00.000Z" },
    firstSessionDate: "2025-12-01T08:00:00.000Z",
    hourCounts: { 9: 2, 23: 1 },
  });

  const firstStart = Date.parse("2025-12-01T08:00:00.000Z");
  const lastPlanModeUse = nzdt("2026-01-14", "10:00");
  const skillLastUsed = nzdt("2026-01-14", "09:30");
  const configFile = ".claude.json";
  h.writeJson(configFile, {
    numStartups: 42, installMethod: "native", autoUpdates: true, userID: "f".repeat(64),
    firstStartTime: new Date(firstStart).toISOString(),
    promptQueueUseCount: 7,
    lastPlanModeUse,
    oauthAccount: { accountUuid: "uuid-1", emailAddress: CANARY.email, organizationUuid: "org-1", displayName: CANARY.project },
    mcpServers: { [CANARY.mcp]: { type: "stdio", command: "x", args: [CANARY.path], env: { API_KEY: CANARY.secret } } },
    skillUsage: {
      "demo:skill": { usageCount: 3, lastUsedAt: skillLastUsed },
      "my-skill": { usageCount: 2, lastUsedAt: skillLastUsed - 60_000 },
    },
    pluginUsage: { "demo@market": { usageCount: 5, lastUsedAt: skillLastUsed, lastUsedNumStartups: 40 } },
    projects: {
      [CANARY.path]: { allowedTools: [], mcpServers: {}, history: [{ display: CANARY.prompt, pastedContents: {} }], lastSessionId: CC_H1 },
      "/work/projB": { mcpServers: { "docs-mcp": { type: "http", url: `https://${CANARY.host}/mcp`, headers: { Authorization: `Bearer ${CANARY.token}` } } } },
    },
  });

  h.writeJson(".claude/settings.json", {
    cleanupPeriodDays: 30,
    env: { API_TOKEN: CANARY.token },
    permissions: { allow: [`Bash(cat ${CANARY.path}/*)`] },
    hooks: {
      PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "bun test", timeout: 60 }] }],
      Stop: [{ hooks: [{ type: "command", command: `curl -s https://${CANARY.host}/notify -H "x-key: ${CANARY.secret}"` }] }],
    },
  });

  h.write(".claude/skills/lock-skill/SKILL.md", `---\nname: lock-skill\ndescription: ${CANARY.prompt}\n---\n`);
  h.write(".claude/skills/my-skill/SKILL.md", `---\nname: my-skill\n---\n${CANARY.code}\n`);
  h.writeJson(".agents/.skill-lock.json", {
    version: 3,
    skills: {
      "lock-skill": {
        source: "acme/skills", sourceType: "github", sourceUrl: `https://${CANARY.host}/skills.git`, skillPath: "skills/lock-skill/SKILL.md",
        skillFolderHash: "0a1b2c", installedAt: iso(firstStart), updatedAt: iso(firstStart), pluginName: "skills",
      },
    },
    dismissed: { findSkillsPrompt: true },
    lastSelectedAgents: ["claude-code"],
  });
  h.write(".claude/commands/review-pr.md", `Review the pull request. ${CANARY.prompt}`);
  h.write(".claude/agents/reviewer.md", `---\nname: reviewer\n---\n${CANARY.prompt}`);
  h.writeJson(".claude/plugins/installed_plugins.json", {
    version: 2,
    plugins: { "demo@market": [{ scope: "user", installPath: `${CANARY.path}/plugins/demo`, version: "1.0.0", installedAt: iso(firstStart), lastUpdated: iso(firstStart), gitCommitSha: "abc123" }] },
  });
  const memory = `.claude/projects/${slug(CANARY.path)}/memory`;
  h.write(`${memory}/MEMORY.md`, `- [Role](user_role.md) — ${CANARY.prompt}`);
  h.write(`${memory}/user_role.md`, `${CANARY.email} ${CANARY.prompt}`);

  return {
    historyTs: history.map((l) => l.timestamp as number),
    aucklandDays: [["2026-01-14", 5], ["2026-01-15", 3]],
    utcDays: [["2026-01-13", 4], ["2026-01-14", 4]],
    statsDays: ["2026-01-13", "2026-01-14", "2026-01-16"],
    firstStart, lastPlanModeUse, skillLastUsed, configFile,
  };
}
