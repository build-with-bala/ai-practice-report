import type { Env } from "../../env/env";
import { configRoots } from "../common/roots";
import type { Candidate, SourcePlugin } from "../types";
import { CONFIG_SOURCE, scanCxConfig } from "./config";
import { HISTORY_SOURCE, scanCxHistory } from "./history";
import { scanThreads, THREADS_SOURCE } from "./indexdb";
import { ROLLOUTS_SOURCE, scanRollouts } from "./rollouts";

/** Codex homes: `$CODEX_HOME` for the scanning user's home, else `<home>/.codex` (also per WSL home). */
export function codexRoots(env: Env, homes: string[]): Candidate[] {
  return configRoots(env, homes, "CODEX_HOME", ".codex");
}

export const cxRollouts: SourcePlugin = {
  tool: "codex",
  id: ROLLOUTS_SOURCE,
  tier: "P0",
  beta: false,
  primary: { detail: ["session", "prompt", "tool"] },
  describe: {
    reads: [
      "<codex>/sessions/**/rollout-*.jsonl — one rollout per thread (session metadata, turns, messages, tool calls, token counts)",
      "<codex>/archived_sessions/**/rollout-*.jsonl — archived threads, read the same way",
    ],
    neverReads: [
      "prompt, reply, tool input and output, command and patch text are parsed in memory for counts and never kept",
      "reasoning, tool outputs, developer and assistant messages, world state, per-response token records and image-generation results are skipped before parsing",
      "base instructions, AGENTS.md and environment context, agent nicknames and paths, git remotes and commit hashes are parsed in memory and never kept",
    ],
  },
  locate: codexRoots,
  scan: scanRollouts,
};

export const cxThreads: SourcePlugin = {
  tool: "codex",
  id: THREADS_SOURCE,
  tier: "P0",
  beta: false,
  windows: ["lifetime"],
  primary: { lifetime: ["session", "turn", "edge"] },
  describe: {
    reads: [
      "<codex>/state_<N>.sqlite (highest N) — threads: id, source, originator, model, reasoning effort, approval mode, sandbox policy type, token total, created/updated times, CLI version, cwd, and whether the git columns are set; thread_spawn_edges: parent and child thread ids",
      "<codex>/thread_history_<N>.sqlite (highest N) — thread_turns: thread id, status, start and end time, duration",
    ],
    neverReads: [
      "threads.first_user_message, title, preview and name, agent nicknames and paths, rollout paths, creator ids and the git commit, branch and remote are never selected (git columns are only tested for presence, inside SQL)",
      "a subagent thread's source JSON is parsed in memory and only its parent thread id, depth and role are kept; the agent path and nickname inside it are parsed but never kept",
      "sandbox policies are parsed in memory for their type; their paths are never kept",
      "thread_items (message, command and output JSON), thread_turns.error_json and every other table and store (logs, goals, memories, queue)",
    ],
  },
  locate: codexRoots,
  scan: scanThreads,
};

export const cxHistory: SourcePlugin = {
  tool: "codex",
  id: HISTORY_SOURCE,
  tier: "P0",
  beta: false,
  windows: ["lifetime"],
  primary: { lifetime: ["prompt"] },
  describe: {
    reads: ["<codex>/history.jsonl — one line per prompt typed in the CLI, kept after rollouts are pruned: session_id, ts, text"],
    neverReads: ["prompt text is parsed in memory for intent, features and a keyed hash, and never kept"],
  },
  locate: codexRoots,
  scan: scanCxHistory,
};

export const cxConfig: SourcePlugin = {
  tool: "codex",
  id: CONFIG_SOURCE,
  tier: "P0",
  beta: false,
  windows: ["lifetime"],
  primary: { lifetime: ["config"] },
  describe: {
    reads: [
      "<codex>/config.toml — section headers only: [profiles.<name>], [mcp_servers.<name>], [plugins.<id>]",
      "<codex>/plugins/cache/<marketplace>/<plugin>/ — installed plugin ids (folder names)",
      "<codex>/skills/<name>/SKILL.md — names only; <home>/.agents/.skill-lock.json — names of the skills it installed",
      "<codex>/memories/*.md — counted; the files are not opened",
    ],
    neverReads: [
      "config.toml values: settings, MCP commands, arguments, environment and headers, project paths and trust levels",
      "skill, plugin and memory file contents; bundled skills (skills/.system); config.toml backups",
    ],
  },
  locate: codexRoots,
  scan: scanCxConfig,
};
