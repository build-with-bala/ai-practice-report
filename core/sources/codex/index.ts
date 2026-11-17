import type { Env } from "../../env/env";
import { configRoots } from "../common/roots";
import type { Candidate, SourcePlugin } from "../types";
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
