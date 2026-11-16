import { statSync } from "node:fs";
import type { Env } from "../../env/env";
import { joinFor } from "../../env/paths";
import type { Candidate, SourcePlugin } from "../types";
import { scanTranscripts, TRANSCRIPTS_SOURCE } from "./transcripts";

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory(); // follows a symlinked config dir
  } catch {
    return false;
  }
}

/** Claude Code config roots: `$CLAUDE_CONFIG_DIR` for the scanning user's home, else `<home>/.claude` (also per WSL home). */
export function claudeRoots(env: Env, homes: string[]): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const home of homes) {
    const primary = home === env.home;
    const root = primary && env.vars.CLAUDE_CONFIG_DIR ? env.vars.CLAUDE_CONFIG_DIR : joinFor(env, home, ".claude");
    if (seen.has(root) || !isDir(root)) continue;
    seen.add(root);
    out.push({ root, home, wsl: !primary });
  }
  return out;
}

export const ccTranscripts: SourcePlugin = {
  tool: "claude-code",
  id: TRANSCRIPTS_SOURCE,
  tier: "P0",
  beta: false,
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
