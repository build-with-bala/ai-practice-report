import path from "node:path";
import { toEpochMs } from "../../io/time";
import type { MarkerEv } from "../../model/events";
import { sid, type MarkerKind } from "../../model/ids";
import { Tally } from "../common/coverage";
import { idPart, isObj, UUID } from "../common/guards";
import { PromptLog } from "../common/history";
import { streamJsonlFile } from "../common/stream";
import type { Candidate, ScanCtx } from "../types";

export const HISTORY_SOURCE = "claude-code.history";
const TOOL = "claude-code";

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

/**
 * One line: `display`, `timestamp`, `sessionId`, and whether `pastedContents` has entries (its values are never read) →
 * a prompt (the prompt log), and a marker when it is a local command.
 */
function line(v: unknown, ctx: ScanCtx, tally: Tally, log: PromptLog): void {
  if (!isObj(v)) return tally.unknownKey("line:not-object");
  const text = v.display;
  if (typeof text !== "string") return tally.unknownKey("display:missing");
  if (v.timestamp === undefined) return tally.unknownKey("timestamp:missing");
  const ts = toEpochMs(v.timestamp, ctx.now);
  if (ts === undefined) return tally.badTime(v.timestamp); // a reshaped time is drift; an implausible one bad-ts
  if (text.trim() === "") return tally.skip("empty");
  const sessionId = typeof v.sessionId === "string" && v.sessionId !== "" ? sid(TOOL, idPart(v.sessionId, UUID, ctx)) : undefined;
  const hasPaste = isObj(v.pastedContents) && Object.keys(v.pastedContents).length > 0;
  log.add({ text, ts, sessionId, hasPaste });
  const marker = commandMarker(text);
  if (!marker) return;
  const m: MarkerEv = { k: "marker", tool: TOOL, source: HISTORY_SOURCE, ts, kind: marker.kind };
  if (sessionId !== undefined) m.sessionId = sessionId;
  if (marker.detail !== undefined) m.detail = marker.detail;
  tally.span(ts);
  ctx.emit(m);
}

/**
 * Scan `<root>/history.jsonl` (every prompt typed at the CLI prompt, kept for months): prompts, command markers and one
 * DailyEv per local day (process time zone) with that day's count of typed prompts; emits one CoverageEv, last.
 */
export async function scanHistory(c: Candidate, ctx: ScanCtx): Promise<void> {
  const tally = new Tally(TOOL, HISTORY_SOURCE, "lifetime");
  const log = new PromptLog(ctx, TOOL, HISTORY_SOURCE, tally);
  await streamJsonlFile(path.join(c.root, "history.jsonl"), ctx, tally, (v) => line(v, ctx, tally, log), { ioLog: "cc.io-error" });
  log.finish();
  const bad = tally.skipped["bad-record"] ?? 0;
  if (bad > 0) ctx.log("warn", "cc.bad-record", bad);
  ctx.emit(tally.coverage());
}
