import path from "node:path";
import { toEpochMs } from "../../io/time";
import { Tally, typeKey } from "../common/coverage";
import { isObj, str } from "../common/guards";
import { PromptLog } from "../common/history";
import { streamJsonlFile } from "../common/stream";
import type { Candidate, ScanCtx } from "../types";
import { agSessionId, TOOL } from "./ids";

/** The CLI's prompt log is its own lifetime source, so its prompts are never mistaken for (or summed with) the transcripts'. */
export const HISTORY_SOURCE = "antigravity.history";

/** A line of the CLI's prompt log: a prompt (no `type`) or a slash command (`type: slash_command`), typed at the CLI prompt. */
function line(v: unknown, ctx: ScanCtx, tally: Tally, log: PromptLog): void {
  if (!isObj(v)) return tally.unknownKey("history:not-object");
  if (v.type !== undefined && v.type !== "slash_command") return tally.unknownKey(`history.type:${typeKey(v.type)}`);
  const text = v.display;
  if (typeof text !== "string") return tally.unknownKey("history.display:missing");
  if (v.timestamp === undefined || v.timestamp === null) return tally.unknownKey("history.timestamp:missing");
  const ts = toEpochMs(v.timestamp, ctx.now);
  if (ts === undefined) return tally.badTime(v.timestamp, "history.timestamp"); // reshaped: drift; implausible: bad-ts
  if (text.trim() === "") return tally.skip("empty");
  const raw = str(v.conversationId);
  log.add({ text, ts, sessionId: raw === undefined ? undefined : agSessionId(raw, ctx) });
}

/**
 * Scan one `antigravity-cli` folder's `history.jsonl` (what was typed at the CLI prompt, kept for months): prompts and
 * one DailyEv per local day (process time zone) with that day's count of typed prompts and commands; one CoverageEv
 * (lifetime), last.
 */
export async function scanHistory(c: Candidate, ctx: ScanCtx): Promise<void> {
  const tally = new Tally(TOOL, HISTORY_SOURCE, "lifetime");
  const log = new PromptLog(ctx, TOOL, HISTORY_SOURCE, tally);
  await streamJsonlFile(path.join(c.root, "history.jsonl"), ctx, tally, (v) => line(v, ctx, tally, log), { ioLog: "ag.io-error" });
  log.finish();
  const bad = tally.skipped["bad-record"] ?? 0;
  if (bad > 0) ctx.log("warn", "ag.bad-record", bad);
  ctx.emit(tally.coverage());
}
