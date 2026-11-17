import path from "node:path";
import { safeStat } from "../../io/fs";
import { readJsonl } from "../../io/jsonl";
import { localDay, toEpochMs } from "../../io/time";
import type { PromptEv } from "../../model/events";
import { classifyIntent } from "../../text/intent";
import { promptFeatures } from "../../text/structure";
import { Tally } from "../common/coverage";
import { isObj, str } from "../common/guards";
import type { Candidate, ScanCtx } from "../types";
import { cxThreadId } from "./origin";

export const HISTORY_SOURCE = "codex.history";
const TOOL = "codex";
const TASK_GAP_MS = 30 * 60_000;
/** Per-session state (last prompt time and text) is kept for the most recent sessions only; lines of a session cluster in time. */
const SESSION_WINDOW = 256;

interface SessionState { lastTs: number; text: string }

/** Maps history lines to prompts and per-local-day prompt counts, keeping small per-session state. */
class HistoryReader {
  private readonly days = new Map<string, number>();
  private readonly sessions = new Map<string, SessionState>();

  constructor(private readonly ctx: ScanCtx, private readonly tally: Tally) {}

  /** One line: `session_id`, `ts` (epoch seconds) and `text`, the prompt as typed (kept in memory only). */
  line(v: unknown): void {
    if (!isObj(v)) return this.tally.unknownKey("line:not-object");
    const text = v.text;
    if (typeof text !== "string") return this.tally.unknownKey("text:missing");
    if (v.ts === undefined || v.ts === null) return this.tally.unknownKey("ts:missing");
    const ts = toEpochMs(v.ts, this.ctx.now);
    if (ts === undefined) return this.tally.skip("bad-ts");
    if (text.trim() === "") return this.tally.skip("empty");
    const raw = str(v.session_id);
    const sessionId = raw === undefined ? undefined : cxThreadId(raw, this.ctx);

    const key = sessionId ?? "";
    const prev = this.sessions.get(key);
    const isTaskStart = prev === undefined || ts - prev.lastTs >= TASK_GAP_MS;
    const ev: PromptEv = {
      k: "prompt", tool: TOOL, source: HISTORY_SOURCE, ts, window: "lifetime", origin: "human",
      intent: classifyIntent(text),
      features: promptFeatures(text, { hasPaste: false, isTaskStart, prevText: prev?.text }),
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

  /** One DailyEv per local day (process time zone) with that day's prompt count. */
  finish(): void {
    for (const [day, prompts] of [...this.days].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      this.ctx.emit({ k: "daily", tool: TOOL, source: HISTORY_SOURCE, day, prompts });
    }
  }
}

/** Scan `<codex>/history.jsonl` (each prompt typed in the CLI, kept after rollouts are pruned); one CoverageEv, last. */
export async function scanCxHistory(c: Candidate, ctx: ScanCtx): Promise<void> {
  const tally = new Tally(TOOL, HISTORY_SOURCE, "lifetime");
  const reader = new HistoryReader(ctx, tally);
  const file = path.join(c.root, "history.jsonl");
  const st = safeStat(file);
  if (st && !st.isFile()) tally.skip("not-file");
  else if (st) {
    let complete = true;
    try {
      for await (const item of readJsonl(file, { signal: ctx.signal })) {
        if ("skip" in item) {
          tally.skip(item.skip);
          continue;
        }
        tally.records++;
        try {
          reader.line(item.value);
        } catch {
          tally.skip("bad-record");
        }
      }
    } catch {
      complete = false;
      tally.skip("io-error");
      ctx.log("warn", "cx.io-error");
    }
    if (ctx.signal.aborted) complete = false;
    if (complete) {
      tally.files++;
      tally.bytes += st.size;
    }
  }
  reader.finish();
  const bad = tally.skipped["bad-record"] ?? 0;
  if (bad > 0) ctx.log("warn", "cx.bad-record", bad);
  ctx.emit(tally.coverage());
}
