import path from "node:path";
import { toEpochMs } from "../../io/time";
import { Tally } from "../common/coverage";
import { isObj, str } from "../common/guards";
import { PromptLog } from "../common/history";
import { streamJsonlFile } from "../common/stream";
import type { Candidate, ScanCtx } from "../types";
import { cxThreadId } from "./origin";

export const HISTORY_SOURCE = "codex.history";
const TOOL = "codex";

/** One line: `session_id`, `ts` (epoch seconds) and `text`, the prompt as typed (kept in memory only) → a prompt (the prompt log). */
function line(v: unknown, ctx: ScanCtx, tally: Tally, log: PromptLog): void {
  if (!isObj(v)) return tally.unknownKey("line:not-object");
  const text = v.text;
  if (typeof text !== "string") return tally.unknownKey("text:missing");
  if (v.ts === undefined || v.ts === null) return tally.unknownKey("ts:missing");
  const ts = toEpochMs(v.ts, ctx.now);
  if (ts === undefined) return tally.badTime(v.ts, "ts"); // a reshaped time is drift; an implausible one bad-ts
  if (text.trim() === "") return tally.skip("empty");
  const raw = str(v.session_id);
  log.add({ text, ts, sessionId: raw === undefined ? undefined : cxThreadId(raw, ctx) });
}

/**
 * Scan `<codex>/history.jsonl` (each prompt typed in the CLI, kept after rollouts are pruned): prompts and one DailyEv
 * per local day (process time zone) with that day's count of typed prompts; one CoverageEv, last.
 */
export async function scanCxHistory(c: Candidate, ctx: ScanCtx): Promise<void> {
  const tally = new Tally(TOOL, HISTORY_SOURCE, "lifetime");
  const log = new PromptLog(ctx, TOOL, HISTORY_SOURCE, tally);
  await streamJsonlFile(path.join(c.root, "history.jsonl"), ctx, tally, (v) => line(v, ctx, tally, log), { ioLog: "cx.io-error" });
  log.finish();
  const bad = tally.skipped["bad-record"] ?? 0;
  if (bad > 0) ctx.log("warn", "cx.bad-record", bad);
  ctx.emit(tally.coverage());
}
