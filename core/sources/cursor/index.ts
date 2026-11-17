import { statSync } from "node:fs";
import path from "node:path";
import type { Env } from "../../env/env";
import { vscodeUser } from "../../env/paths";
import { safeStat } from "../../io/fs";
import { listDir, Tally } from "../common/coverage";
import type { Candidate, ScanCtx, SourcePlugin } from "../types";
import { AGENT_CLI_SOURCE, agentCliRoots, scanAgentCli } from "./agentcli";
import { DiskKv, IDE_SOURCE, readStore, TOOL } from "./diskkv";
import { LegacyKeys } from "./itemtable";
import { scanTracking, TRACKING_SOURCE, trackingRoots } from "./tracking";

/** Cursor's user data folder: macOS `~/Library/Application Support/Cursor/User`, Windows `%APPDATA%\Cursor\User`, Linux `~/.config/Cursor/User`. */
export const cursorUserRoot = (env: Env): string => vscodeUser(env, "Cursor");

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory(); // follows a symlinked user folder
  } catch {
    return false;
  }
};

/** The Cursor user folder when it exists (the scanning user's only, as for VS Code). */
export function ideRoots(env: Env): Candidate[] {
  const root = cursorUserRoot(env);
  return isDir(root) ? [{ root, home: env.home, wsl: false }] : [];
}

/** Every Cursor store present failed to open or read: the source has nothing to say. */
class StoresUnreadable extends Error {}

/** `<user>/workspaceStorage/<workspace>/state.vscdb`: older Cursor kept its chats there (legacy keys only). */
function workspaceStores(user: string, tally: Tally): string[] {
  const root = path.join(user, "workspaceStorage");
  return listDir(root, tally).map((ws) => path.join(root, ws, "state.vscdb")).filter((f) => safeStat(f)?.isFile());
}

/**
 * Scan one Cursor user folder: the global store's `cursorDiskKV` (composers and bubbles). Only when that table is
 * absent or holds no composer does the reader turn to the legacy `ItemTable` keys, by exact key — of the global store
 * and of every workspace store. One CoverageEv, last.
 */
async function scanIde(c: Candidate, ctx: ScanCtx): Promise<void> {
  const tally = new Tally(TOOL, IDE_SOURCE);
  const legacy = new LegacyKeys(ctx, tally);
  const globalStore = path.join(c.root, "globalStorage", "state.vscdb");
  let present = 0;
  let read = 0;
  let fallback = true;
  if (safeStat(globalStore)?.isFile()) {
    present++;
    fallback = false;
    const ok = readStore(globalStore, ctx, tally, (db, tables) => {
      const kv = tables.has("cursorDiskKV") ? new DiskKv(db, ctx, tally).read(tables) : { readable: true, composers: 0 };
      if (!kv.readable || kv.composers > 0 || ctx.signal.aborted) return;
      fallback = true;
      legacy.read(db, tables);
    });
    if (ok) read++;
  }
  if (fallback) {
    for (const file of workspaceStores(c.root, tally)) {
      if (ctx.signal.aborted) break;
      present++;
      if (readStore(file, ctx, tally, (db, tables) => legacy.read(db, tables))) read++;
    }
  }
  if (present > 0 && read === 0 && tally.note !== "too-large") throw new StoresUnreadable("no Cursor store could be read");
  const bad = tally.skipped["bad-record"] ?? 0;
  if (bad > 0) ctx.log("warn", "cu.bad-record", bad); // a mapping bug must not look like a healthy source
  ctx.emit(tally.coverage());
}

const AUTH_NEVER = "ItemTable: no key but the four legacy ones, each by exact key and only when cursorDiskKV holds no composer — never by pattern, so the account's tokens (cursorAuth/*) and every other setting are never selected";

export const cuIde: SourcePlugin = {
  tool: "cursor",
  id: IDE_SOURCE,
  tier: "P0",
  beta: false,
  describe: {
    reads: [
      "<Cursor user>/globalStorage/state.vscdb, table cursorDiskKV, keys composerData:* (by key range) — created and updated times, agent flag and mode, model setting, subagent marker and launch id, sub-composer ids, message counts",
      "<Cursor user>/globalStorage/state.vscdb, table cursorDiskKV, keys bubbleId:<composer>:* of composers updated in the detail window (90 days, or since --since), by each composer's key range — message type, time, model, thinking time, whether an error is recorded; for tools: name, numeric id, status, the person's decision, call id, and from the params only the command line, target file and MCP server, from the result only the exit code; the text of the person's messages",
      "<Cursor user>/{globalStorage,workspaceStorage/*}/state.vscdb, table ItemTable — only aiService.prompts (presence), aiService.generations, composer.composerData and workbench.panel.aichat.view.aichat.chatdata, and only when cursorDiskKV holds no composer (older Cursor)",
    ],
    neverReads: [
      AUTH_NEVER,
      "cursorDiskKV values are never selected whole: fields are extracted inside SQLite; message text, the command line and the file path are parsed in memory, and only intent, features, a keyed hash, command categories and file extensions are kept",
      "assistant text, thinking blocks, code blocks, diffs, attached files and context, tool params and results beyond the four fields above, composer names, subtitles and git worktree fields",
      "every other key family of cursorDiskKV (agentKv, checkpointId, codeBlockDiff, messageRequestContext, …) and the composerHeaders table",
    ],
  },
  locate: (env) => ideRoots(env),
  scan: scanIde,
};

export const cuTracking: SourcePlugin = {
  tool: "cursor",
  id: TRACKING_SOURCE,
  tier: "P0",
  beta: false,
  describe: {
    reads: ["<home>/.cursor/ai-tracking/ai-code-tracking.db, table scored_commits — commit and scoring time, tab, composer and human lines added; the commit hash only to count a commit once"],
    neverReads: [
      "scored_commits.commitMessage and branchName, the deleted and blank line counts and the AI percentages; commit hashes are never kept",
      "ai_code_hashes, tracked_file_content (file contents), ai_deleted_files, conversation_summaries (titles, summaries) and tracking_state",
    ],
  },
  locate: trackingRoots,
  scan: scanTracking,
};

export const cuAgentCli: SourcePlugin = {
  tool: "cursor",
  id: AGENT_CLI_SOURCE,
  tier: "P0",
  beta: true,
  describe: {
    reads: [
      "<home>/.cursor/projects/*/agent-transcripts/**.{jsonl,txt} — counted and sized; JSONL lines counted, never parsed",
      "<home>/.cursor/chats/*/*/store.db and <config>/cursor/chats/*/*/store.db — counted and sized; rows of the blobs table counted",
    ],
    neverReads: [
      "transcript contents and blob contents (the formats are not decoded yet)",
      "the chat stores' meta table (it holds a blob encryption key), prompt_history.json, cli-config.json, mcp.json, plans, skills and every other file under ~/.cursor",
    ],
  },
  locate: agentCliRoots,
  scan: scanAgentCli,
};
