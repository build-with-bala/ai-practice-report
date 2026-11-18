import path from "node:path";
import { safeStat } from "../../io/fs";
import { localDay, toEpochMs } from "../../io/time";
import type { PromptEv } from "../../model/events";
import { classifyIntent } from "../../text/intent";
import { promptFeatures } from "../../text/structure";
import { Tally, typeKey } from "../common/coverage";
import { isObj, str } from "../common/guards";
import type { Candidate, ScanCtx } from "../types";
import { agSessionId, readLines, TASK_GAP_MS, TOOL } from "./cli";

/** The CLI's prompt log is its own lifetime source, so its prompts are never mistaken for (or summed with) the transcripts'. */
export const HISTORY_SOURCE = "antigravity.history";
/** Per-session state of the prompt log (last prompt time and text) is kept for the most recent sessions only. */
const SESSION_WINDOW = 256;

/** Lines of the CLI's prompt log: a prompt (no `type`) or a slash command (`type: slash_command`), typed at the CLI prompt. */
class HistoryReader {
  private readonly days = new Map<string, number>();
  private readonly sessions = new Map<string, { lastTs: number; text: string }>();

  constructor(private readonly ctx: ScanCtx, private readonly tally: Tally) {}

  line(v: unknown): void {
    if (!isObj(v)) return this.tally.unknownKey("history:not-object");
    if (v.type !== undefined && v.type !== "slash_command") return this.tally.unknownKey(`history.type:${typeKey(v.type)}`);
    const text = v.display;
    if (typeof text !== "string") return this.tally.unknownKey("history.display:missing");
    if (v.timestamp === undefined || v.timestamp === null) return this.tally.unknownKey("history.timestamp:missing");
    const ts = toEpochMs(v.timestamp, this.ctx.now);
    if (ts === undefined) return this.tally.badTime(v.timestamp, "history.timestamp"); // reshaped: drift; implausible: bad-ts
    if (text.trim() === "") return this.tally.skip("empty");
    const raw = str(v.conversationId);
    const sessionId = raw === undefined ? undefined : agSessionId(raw, this.ctx);
    const key = sessionId ?? "";
    const prev = this.sessions.get(key);
    const ev: PromptEv = {
      k: "prompt", tool: TOOL, source: HISTORY_SOURCE, ts, window: "lifetime", origin: "human", intent: classifyIntent(text),
      features: promptFeatures(text, { isTaskStart: prev === undefined || ts - prev.lastTs >= TASK_GAP_MS, prevText: prev?.text }),
      textHash: this.ctx.hash(text.trim()),
    };
    if (sessionId !== undefined) ev.sessionId = sessionId;
    this.tally.span(ts);
    this.ctx.emit(ev);
    this.sessions.delete(key);
    this.sessions.set(key, { lastTs: ts, text });
    if (this.sessions.size > SESSION_WINDOW) this.sessions.delete(this.sessions.keys().next().value!);
    const day = localDay(ts);
    this.days.set(day, (this.days.get(day) ?? 0) + 1);
  }

  /** One DailyEv per local day (process time zone) with that day's count of typed prompts and commands. */
  finish(): void {
    for (const [day, count] of [...this.days].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      this.ctx.emit({ k: "daily", tool: TOOL, source: HISTORY_SOURCE, day, zone: "local", unit: "prompts", count });
    }
  }
}

/** Scan one `antigravity-cli` folder's `history.jsonl` (what was typed at the CLI prompt, kept for months); one CoverageEv (lifetime), last. */
export async function scanHistory(c: Candidate, ctx: ScanCtx): Promise<void> {
  const tally = new Tally(TOOL, HISTORY_SOURCE, "lifetime");
  const file = path.join(c.root, "history.jsonl");
  if (safeStat(file)?.isFile()) {
    const reader = new HistoryReader(ctx, tally);
    await readLines(file, ctx, tally, (v) => reader.line(v));
    reader.finish();
  }
  const bad = tally.skipped["bad-record"] ?? 0;
  if (bad > 0) ctx.log("warn", "ag.bad-record", bad);
  ctx.emit(tally.coverage());
}
