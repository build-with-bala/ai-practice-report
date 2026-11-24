import { localDay } from "../../io/time";
import { TASK_GAP_MS } from "../../model/constants";
import type { PromptEv } from "../../model/events";
import type { ToolId } from "../../model/ids";
import { classifyIntent } from "../../text/intent";
import { promptFeatures } from "../../text/structure";
import type { ScanCtx } from "../types";
import type { Tally } from "./coverage";

/** Per-session state (last prompt time and text) is kept for the most recent sessions only: lines of a session cluster in time. */
const SESSION_WINDOW = 256;

/**
 * The prompts of a CLI's prompt log (`history.jsonl`: every prompt typed at the prompt, kept for months). The reader maps
 * its own fields and skips blank text (`empty`) before `add`; `finish` comes once, after the last line.
 * - `add` emits a lifetime human PromptEv: intent and features from the text, `textHash` = the keyed hash of the trimmed
 *   text (the text never leaves `add`). `isTaskStart`: the first prompt of a session key (its `sessionId`; the prompts
 *   without one are one session of their own), or one ≥ TASK_GAP_MS after that session's previous prompt, which is also
 *   what `simToPrev` compares with. Sessions interleave; state is kept for the SESSION_WINDOW most recent ones.
 * - `finish` emits one DailyEv (`zone: "local"`, `unit: "prompts"`) per local day of the process time zone.
 */
export class PromptLog {
  private readonly days = new Map<string, number>();
  private readonly sessions = new Map<string, { lastTs: number; text: string }>();

  constructor(private readonly ctx: ScanCtx, private readonly tool: ToolId, private readonly source: string, private readonly tally: Tally) {}

  /** `hasPaste`: whether the prompt carried pasted content, for a log that records it (absent otherwise). */
  add(p: { text: string; ts: number; sessionId?: string; hasPaste?: boolean; projectKey?: string }): void {
    const key = p.sessionId ?? "";
    const prev = this.sessions.get(key);
    const isTaskStart = prev === undefined || p.ts - prev.lastTs >= TASK_GAP_MS;
    const ev: PromptEv = {
      k: "prompt", tool: this.tool, source: this.source, ts: p.ts, window: "lifetime", origin: "human",
      intent: classifyIntent(p.text),
      features: promptFeatures(p.text, { hasPaste: p.hasPaste, isTaskStart, prevText: prev?.text }),
      textHash: this.ctx.hash(p.text.trim()),
    };
    if (p.hasPaste !== undefined) ev.hasPaste = p.hasPaste;
    if (p.sessionId !== undefined) ev.sessionId = p.sessionId;
    if (p.projectKey !== undefined) ev.projectKey = p.projectKey;
    this.tally.span(p.ts);
    this.ctx.emit(ev);

    this.sessions.delete(key);
    this.sessions.set(key, { lastTs: p.ts, text: p.text });
    if (this.sessions.size > SESSION_WINDOW) this.sessions.delete(this.sessions.keys().next().value!);
    const day = localDay(p.ts);
    this.days.set(day, (this.days.get(day) ?? 0) + 1);
  }

  finish(): void {
    for (const [day, count] of [...this.days].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      this.ctx.emit({ k: "daily", tool: this.tool, source: this.source, day, zone: "local", unit: "prompts", count });
    }
  }
}
