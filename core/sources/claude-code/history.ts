import path from "node:path";
import { safeStat } from "../../io/fs";
import { readJsonl } from "../../io/jsonl";
import { localDay, toEpochMs } from "../../io/time";
import type { MarkerEv, PromptEv } from "../../model/events";
import { sid, type MarkerKind } from "../../model/ids";
import { classifyIntent } from "../../text/intent";
import { promptFeatures } from "../../text/structure";
import { Tally } from "../common/coverage";
import { idPart, isObj, UUID } from "../common/guards";
import type { Candidate, ScanCtx } from "../types";

export const HISTORY_SOURCE = "claude-code.history";
const TOOL = "claude-code";
const TASK_GAP_MS = 30 * 60_000;
/** Per-session state (last prompt time and text) is kept for the most recent sessions only; lines of a session cluster in time. */
const SESSION_WINDOW = 256;

/** Local commands that become markers: `/clear` has the aliases `/reset` and `/new` (CLI program 2.1.x). */
const LOCAL_COMMAND = /^\/(model|effort|clear|reset|new|compact)(?:\s+([\s\S]*))?$/;
const MODEL_FAMILIES = ["opus", "sonnet", "haiku", "fable"] as const;
const EFFORTS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"]);

/**
 * The marker a prompt stands for when it is one of the CLI's local commands, else undefined. `/model x` → model-switch
 * with the first family named in x (opus, sonnet, haiku, fable) or `other`; `/effort x` → effort-switch with x's first
 * word when it is a level, else `other`; without an argument (the picker) neither has a detail. `/clear` → clear,
 * `/compact` → compact-manual. Only the enum survives; the argument text never leaves this function.
 */
export function commandMarker(text: string): { kind: MarkerKind; detail?: string } | undefined {
  const m = LOCAL_COMMAND.exec(text.trim());
  if (!m) return undefined;
  const arg = (m[2] ?? "").trim().toLowerCase();
  switch (m[1]) {
    case "model":
      return arg === "" ? { kind: "model-switch" } : { kind: "model-switch", detail: MODEL_FAMILIES.find((f) => arg.includes(f)) ?? "other" };
    case "effort": {
      if (arg === "") return { kind: "effort-switch" };
      const level = arg.split(/\s+/)[0]!;
      return { kind: "effort-switch", detail: EFFORTS.has(level) ? level : "other" };
    }
    case "compact":
      return { kind: "compact-manual" };
    default:
      return { kind: "clear" };
  }
}

interface SessionState { lastTs: number; text: string }

/** Maps history lines to prompts, command markers and per-local-day prompt counts, keeping small per-session state. */
class HistoryReader {
  private readonly days = new Map<string, number>();
  private readonly sessions = new Map<string, SessionState>();

  constructor(private readonly ctx: ScanCtx, private readonly tally: Tally) {}

  private out(ev: PromptEv | MarkerEv): void {
    this.tally.span(ev.ts);
    this.ctx.emit(ev);
  }

  /** One line: `display`, `timestamp`, `sessionId`, and whether `pastedContents` has entries (its values are never read). */
  line(v: unknown): void {
    if (!isObj(v)) return this.tally.unknownKey("line:not-object");
    const text = v.display;
    if (typeof text !== "string") return this.tally.unknownKey("display:missing");
    if (v.timestamp === undefined) return this.tally.unknownKey("timestamp:missing");
    const ts = toEpochMs(v.timestamp, this.ctx.now);
    if (ts === undefined) return this.tally.skip("bad-ts");
    if (text.trim() === "") return this.tally.skip("empty");
    const sessionId = typeof v.sessionId === "string" && v.sessionId !== "" ? sid(TOOL, idPart(v.sessionId, UUID, this.ctx)) : undefined;
    const hasPaste = isObj(v.pastedContents) && Object.keys(v.pastedContents).length > 0;

    const key = sessionId ?? "";
    const prev = this.sessions.get(key);
    const isTaskStart = prev === undefined || ts - prev.lastTs >= TASK_GAP_MS;
    const ev: PromptEv = {
      k: "prompt", tool: TOOL, source: HISTORY_SOURCE, ts, window: "lifetime", origin: "human",
      intent: classifyIntent(text),
      features: promptFeatures(text, { hasPaste, isTaskStart, prevText: prev?.text }),
      textHash: this.ctx.hash(text.trim()),
      hasPaste,
    };
    if (sessionId !== undefined) ev.sessionId = sessionId;
    this.out(ev);
    const marker = commandMarker(text);
    if (marker) {
      const m: MarkerEv = { k: "marker", tool: TOOL, source: HISTORY_SOURCE, ts, kind: marker.kind };
      if (sessionId !== undefined) m.sessionId = sessionId;
      if (marker.detail !== undefined) m.detail = marker.detail;
      this.out(m);
    }

    this.sessions.delete(key);
    this.sessions.set(key, { lastTs: ts, text });
    if (this.sessions.size > SESSION_WINDOW) this.sessions.delete(this.sessions.keys().next().value!);
    const day = localDay(ts);
    this.days.set(day, (this.days.get(day) ?? 0) + 1);
  }

  /** One DailyEv per local day (process time zone) with that day's count of typed prompts. */
  finish(): void {
    for (const [day, count] of [...this.days].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      this.ctx.emit({ k: "daily", tool: TOOL, source: HISTORY_SOURCE, day, zone: "local", unit: "prompts", count });
    }
  }
}

/** Scan `<root>/history.jsonl` (every prompt typed at the CLI prompt, kept for months); emits one CoverageEv, last. */
export async function scanHistory(c: Candidate, ctx: ScanCtx): Promise<void> {
  const tally = new Tally(TOOL, HISTORY_SOURCE, "lifetime");
  const reader = new HistoryReader(ctx, tally);
  const file = path.join(c.root, "history.jsonl");
  const st = safeStat(file);
  if (st?.isFile()) {
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
      ctx.log("warn", "cc.io-error");
    }
    if (ctx.signal.aborted) complete = false;
    if (complete) {
      tally.files++;
      tally.bytes += st.size;
    }
  }
  reader.finish();
  const bad = tally.skipped["bad-record"] ?? 0;
  if (bad > 0) ctx.log("warn", "cc.bad-record", bad);
  ctx.emit(tally.coverage());
}
