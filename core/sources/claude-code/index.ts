import type { Env } from "../../env/env";
import { configRoots } from "../common/roots";
import type { Candidate, SourcePlugin } from "../types";
import { CONFIG_SOURCE, scanConfig } from "./config";
import { HISTORY_SOURCE, scanHistory } from "./history";
import { scanStats, STATS_SOURCE } from "./stats";
import { scanTranscripts, TRANSCRIPTS_SOURCE } from "./transcripts";

/** Claude Code config roots: `$CLAUDE_CONFIG_DIR` for the scanning user's home, else `<home>/.claude` (also per WSL home). */
export function claudeRoots(env: Env, homes: string[]): Candidate[] {
  return configRoots(env, homes, "CLAUDE_CONFIG_DIR", ".claude");
}

export const ccTranscripts: SourcePlugin = {
  tool: "claude-code",
  id: TRANSCRIPTS_SOURCE,
  tier: "P0",
  beta: false,
  primary: { detail: ["session", "prompt", "tool"] },
  describe: {
    reads: [
      "<claude>/projects/*/*.jsonl — session transcripts",
      "<claude>/projects/*/<session>/subagents/agent-*.jsonl and agent-*.meta.json — subagent transcripts",
      "<claude>/projects/*/<session>/subagents/workflows/wf_*/agent-*.jsonl and agent-*.meta.json — workflow agents",
      "<claude>/projects/*/<session>/workflows/*.json — workflow run summaries (duration only)",
      "<claude>/settings.json — cleanupPeriodDays only",
    ],
    neverReads: [
      "prompt, reply, tool input/output and file text are parsed in memory for counts and never kept",
      "api-request, api-request-blob and file-history-* lines are skipped before parsing",
      "ai-title, last-prompt and queued-prompt text; agent meta description, name and workflowPhase; workflow scripts",
      "<session>/tool-results/, <session>/workflows/scripts/, subagents/workflows/wf_*/journal.jsonl",
    ],
  },
  locate: claudeRoots,
  scan: scanTranscripts,
};

export const ccHistory: SourcePlugin = {
  tool: "claude-code",
  id: HISTORY_SOURCE,
  tier: "P0",
  beta: false,
  windows: ["lifetime"],
  primary: { lifetime: ["prompt"] },
  describe: {
    reads: ["<claude>/history.jsonl — one line per prompt typed at the CLI prompt, kept for months: display, timestamp, sessionId"],
    neverReads: [
      "prompt text (display) is parsed in memory for intent, features and a keyed hash, and never kept",
      "pastedContents is only tested for having entries; pasted text, images and their hashes are never read",
      "project (the working directory of each prompt)",
    ],
  },
  locate: claudeRoots,
  scan: scanHistory,
};

export const ccStats: SourcePlugin = {
  tool: "claude-code",
  id: STATS_SOURCE,
  tier: "P0",
  beta: false,
  windows: ["lifetime"],
  primary: { lifetime: ["daily"] },
  describe: {
    reads: ["<claude>/stats-cache.json — version, dailyActivity (messages, sessions, tool calls per day), dailyModelTokens (tokens per model per day)"],
    neverReads: ["longestSession, modelUsage, hourCounts, firstSessionDate and the totals are parsed with the file and dropped"],
  },
  locate: claudeRoots,
  scan: scanStats,
};

export const ccConfig: SourcePlugin = {
  tool: "claude-code",
  id: CONFIG_SOURCE,
  tier: "P0",
  beta: false,
  windows: ["lifetime"],
  primary: { lifetime: ["config", "marker", "identity"] },
  describe: {
    reads: [
      "~/.claude.json ($CLAUDE_CONFIG_DIR/.claude.json when set) — promptQueueUseCount, firstStartTime, lastPlanModeUse, skillUsage and pluginUsage counts, MCP server names, oauthAccount.accountUuid (kept only as a keyed hash)",
      "<claude>/settings.json — hooks: event names, and each hook command classified in memory as test/build/lint/typecheck",
      "<claude>/plugins/installed_plugins.json — installed plugin ids",
      "~/.agents/.skill-lock.json — names of the skills it installed",
      "<claude>/skills/*/SKILL.md, <claude>/commands/*.md, <claude>/agents/*.md — names only; the files are not opened",
      "<claude>/projects/*/memory/*.md — counted; the files are not opened",
    ],
    neverReads: [
      "~/.claude.json is parsed in memory; everything outside the fields above is dropped, including oauthAccount.emailAddress and the other account fields",
      "MCP server definitions (command, args, env, url, headers) and project paths",
      "hook command text, skill, command, agent and memory file contents",
    ],
  },
  locate: claudeRoots,
  scan: scanConfig,
};
