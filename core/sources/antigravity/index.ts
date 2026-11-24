import type { SourcePlugin } from "../types";
import { BRAIN_SOURCE, brainRoots, scanBrain } from "./brain";
import { CLI_SOURCE, cliRoots, scanCli } from "./cli";
import { HISTORY_SOURCE, scanHistory } from "./history";
import { IDE_SOURCE, ideRoots, scanIde } from "./ide";

export const agCli: SourcePlugin = {
  tool: "antigravity",
  id: CLI_SOURCE,
  tier: "P0",
  beta: false,
  windows: ["detail", "lifetime"],
  primary: { detail: ["session", "prompt", "tool"] },
  describe: {
    reads: [
      "<home>/.gemini/antigravity-cli/conversation_summaries.db — per conversation: id, step count, last input and last change times, workspace folders (the first kept only as a keyed project hash), parent conversation id, nesting depth, whether it was killed; inside SQL only: whether a battle id is set, whether another fork won the battle, and the source mapped to an origin code",
      "<home>/.gemini/antigravity-cli/conversations/<conversation>.db, table steps — step type, status, whether error details are recorded (tested inside SQL); inside the step metadata the creation time and the called tool's name (kept only when it is a built-in tool name), and for run commands the command line (classified in memory, never kept) and exit code; blobs above 1 MiB stay in SQLite (only a metadata blob's first 64 bytes are read)",
      "<home>/.gemini/antigravity-cli/brain/<conversation>/.system_generated/logs/transcript.jsonl — record type, source, time, model, token counts, and the text of the person's explicit inputs",
    ],
    neverReads: [
      "conversation_summaries: title, preview, raw_summary, agent_name, status, project_id, app_data_dir and group_id are never selected, nor the values of battle_id, winning_conversation_id and source (used inside SQL only)",
      "steps: error_details (only tested for presence inside SQL), permissions, task_details, render_info, and the payloads of every step but run commands are never selected; the step metadata and command payloads are parsed in memory for the fields above only — the arguments of every call but a run_command's, tool summaries, model usage, the command's working folder and output are dropped",
      "the other tables of the conversation stores (gen_metadata, trajectory_meta, trajectory_metadata_blob, executor_metadata, battle_mode_infos, parent_references)",
      "transcript records are parsed in memory: model replies, thinking, tool calls, errors and media are dropped; an input's text is used for intent, features and a keyed hash, and never kept",
      "transcript_full.jsonl and every other file under brain/ (chunks, steps, messages, media, tasks, scratch, uploads); settings.json, the state and summary .pb/.pbtxt files, log/, cache/, annotations/, implicit/, knowledge/, presence/, plugin_data/",
    ],
  },
  locate: cliRoots,
  scan: scanCli,
};

export const agHistory: SourcePlugin = {
  tool: "antigravity",
  id: HISTORY_SOURCE,
  tier: "P0",
  beta: false,
  windows: ["lifetime"],
  primary: { lifetime: ["prompt"] },
  describe: {
    reads: ["<home>/.gemini/antigravity-cli/history.jsonl — one line per prompt or slash command typed in the CLI: display, timestamp, conversationId"],
    neverReads: ["display text is parsed in memory for intent, features and a keyed hash, and never kept; the workspace paths are never kept, only their keyed project hashes"],
  },
  locate: cliRoots,
  scan: scanHistory,
};

export const agIde: SourcePlugin = {
  tool: "antigravity",
  id: IDE_SOURCE,
  tier: "P0",
  beta: false,
  windows: ["lifetime"],
  primary: { lifetime: ["session"] },
  describe: {
    reads: [
      "<Antigravity user>/globalStorage/state.vscdb and <Antigravity IDE user>/globalStorage/state.vscdb, table ItemTable — only the value of antigravityUnifiedStateSync.trajectorySummaries, by exact key: per conversation its id, step count, creation and last change times, and its first workspace folder (kept only as a keyed project hash)",
    ],
    neverReads: [
      "ItemTable: no key but antigravityUnifiedStateSync.trajectorySummaries, and never by pattern — antigravityUnifiedStateSync.oauthToken, antigravityAuthStatus (the account) and every other setting are never selected",
      "the trajectories' titles, status, latest steps, annotations, battle details and metadata are decoded with the value and dropped",
      "state.vscdb.backup, storage.json and workspaceStorage/",
    ],
  },
  locate: (env) => ideRoots(env),
  scan: scanIde,
};

export const agBrain: SourcePlugin = {
  tool: "antigravity",
  id: BRAIN_SOURCE,
  tier: "P0",
  beta: false,
  windows: ["lifetime"],
  describe: {
    reads: [
      "<home>/.gemini/antigravity/brain/<conversation>/{task,implementation_plan,walkthrough}.md and <home>/.gemini/antigravity-cli/brain/<conversation>/… — existence and last modification time only",
    ],
    neverReads: ["the plan artifacts' contents (the files are never opened) and every other file under brain/"],
  },
  locate: brainRoots,
  scan: scanBrain,
};
