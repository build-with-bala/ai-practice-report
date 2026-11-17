import type { RoDb } from "../../io/sqlite";
import { toEpochMs } from "../../io/time";
import type { PromptEv, SessionEv } from "../../model/events";
import { classifyIntent } from "../../text/intent";
import { promptFeatures } from "../../text/structure";
import type { Tally } from "../common/coverage";
import { isObj, safeModel, str } from "../common/guards";
import type { ScanCtx } from "../types";
import { cuSessionId, IDE_SOURCE, TASK_GAP_MS, TOOL } from "./diskkv";

/**
 * The only `ItemTable` keys ever read, each by exact key and only when `cursorDiskKV` holds no composers (older
 * Cursor). `ItemTable` also holds the account's tokens (`cursorAuth/*`) and every other setting, so it is never
 * queried by pattern and no other key is named.
 */
export const LEGACY_KEYS = ["aiService.prompts", "aiService.generations", "composer.composerData", "workbench.panel.aichat.view.aichat.chatdata"] as const;
type LegacyKey = (typeof LEGACY_KEYS)[number];
/** Each value is one JSON document parsed whole, so larger ones are skipped `too-large` (as for VS Code's legacy session files). */
const VALUE_MAX = 64 * 1024 * 1024;
const PRESENCE_SQL = "SELECT key FROM ItemTable WHERE key = ?";
const VALUE_SQL = "SELECT length(value) AS n, CASE WHEN length(value) <= ? THEN value END AS value FROM ItemTable WHERE key = ?";
const dec = new TextDecoder();

/**
 * The legacy keys of the stores of one Cursor user folder (the global store, then each workspace store): sessions
 * from the composer index and the chat tabs, timed prompts from the generation list. A generation seen in an earlier
 * store (by `generationUUID`) counts once.
 */
export class LegacyKeys {
  private readonly generations = new Set<string>();

  constructor(private readonly ctx: ScanCtx, private readonly tally: Tally) {}

  read(db: RoDb, tables: ReadonlySet<string>): void {
    if (!tables.has("ItemTable")) return;
    const have = new Set(db.columns("ItemTable"));
    for (const c of ["key", "value"]) if (!have.has(c)) this.tally.unknownKey(`missing-column:${c}`);
    if (!have.has("key") || !have.has("value")) return;
    // the prompt list has no times (and repeats what the generations hold): its presence only
    if (db.get(PRESENCE_SQL, "aiService.prompts") !== undefined) this.tally.records++;
    for (const key of LEGACY_KEYS) {
      if (key === "aiService.prompts" || this.ctx.signal.aborted) continue;
      const value = this.value(db, key);
      if (value !== undefined) this.map(key, value);
    }
  }

  /** The parsed value of `key`; undefined when absent, too large or not JSON (the last two counted). */
  private value(db: RoDb, key: LegacyKey): unknown {
    const row = db.get<{ n: unknown; value: unknown }>(VALUE_SQL, VALUE_MAX, key);
    if (row === undefined) return undefined;
    this.tally.records++;
    const raw = row.value;
    if (raw === null || raw === undefined) {
      if (typeof row.n === "number" && row.n > VALUE_MAX) {
        this.tally.note = "too-large";
        this.tally.skip("too-large");
      }
      return undefined;
    }
    const text = typeof raw === "string" ? raw : raw instanceof Uint8Array ? dec.decode(raw) : undefined;
    if (text !== undefined) {
      try {
        return JSON.parse(text);
      } catch {
        /* counted below */
      }
    }
    this.tally.skip("parse");
    return undefined;
  }

  private map(key: LegacyKey, v: unknown): void {
    if (key === "aiService.generations") return Array.isArray(v) ? this.prompts(v) : this.tally.unknownKey(`${key}:shape`);
    if (key === "composer.composerData") {
      const heads = Array.isArray(v) ? v : isObj(v) && Array.isArray(v.allComposers) ? v.allComposers : undefined;
      return heads === undefined ? this.tally.unknownKey(`${key}:shape`) : this.heads(heads);
    }
    return isObj(v) && Array.isArray(v.tabs) ? this.tabs(v.tabs) : this.tally.unknownKey(`${key}:shape`);
  }

  private add(reason: string, n: number): void {
    if (n > 0) this.tally.skipped[reason] = (this.tally.skipped[reason] ?? 0) + n;
  }

  /**
   * `aiService.generations`: one entry per request the person made ({`unixMs`, `generationUUID`, `type`,
   * `textDescription`, or `text` in some versions}) → a PromptEv (no session: the list does not link one), in time order.
   */
  private prompts(list: unknown[]): void {
    const timed: { ts: number; text: string; id?: string }[] = [];
    for (const e of list) {
      if (!isObj(e)) {
        this.tally.skip("bad-record");
        continue;
      }
      const id = str(e.generationUUID);
      if (id !== undefined && this.generations.has(id)) {
        this.tally.skip("duplicate");
        continue;
      }
      const ts = toEpochMs(e.unixMs, this.ctx.now);
      if (ts === undefined) {
        this.tally.skip("no-ts");
        continue;
      }
      const text = [e.textDescription, e.text].find((x): x is string => typeof x === "string" && x.trim() !== "");
      if (text === undefined) {
        this.tally.skip("empty");
        continue;
      }
      if (id !== undefined) this.generations.add(id);
      timed.push(id === undefined ? { ts, text } : { ts, text, id });
    }
    timed.sort((a, b) => a.ts - b.ts);
    let prev: { ts: number; text: string } | undefined;
    for (const g of timed) {
      const isTaskStart = prev === undefined || g.ts - prev.ts >= TASK_GAP_MS;
      const ev: PromptEv = {
        k: "prompt", tool: TOOL, source: IDE_SOURCE, ts: g.ts, window: "detail", origin: "human", intent: classifyIntent(g.text),
        features: promptFeatures(g.text, { isTaskStart, prevText: prev?.text }), textHash: this.ctx.hash(g.text.trim()),
      };
      this.ctx.emit(ev);
      this.tally.span(g.ts);
      prev = g;
    }
  }

  /** `composer.composerData` (`allComposers`, or an older bare list): a SessionEv per composer head; drafts are skipped. */
  private heads(list: unknown[]): void {
    for (const head of list) {
      const raw = isObj(head) ? str(head.composerId) : undefined;
      if (!isObj(head) || raw === undefined) {
        this.tally.skip("bad-record");
        continue;
      }
      if (head.isDraft === true) {
        this.tally.skip("draft");
        continue;
      }
      this.add("inline-message", Array.isArray(head.conversation) ? head.conversation.length : 0);
      const model = isObj(head.modelConfig) ? str(head.modelConfig.modelName) : undefined;
      const agent = head.isAgentic === true || head.unifiedMode === "agent";
      this.session(raw, toEpochMs(head.createdAt, this.ctx.now), toEpochMs(head.lastUpdatedAt, this.ctx.now), agent, model === undefined ? [] : [safeModel(model)]);
    }
  }

  /** `workbench.panel.aichat.view.aichat.chatdata`: a chat SessionEv per tab with messages, at its `lastSendTime`. */
  private tabs(list: unknown[]): void {
    for (const tab of list) {
      const raw = isObj(tab) ? str(tab.tabId) : undefined;
      if (!isObj(tab) || raw === undefined) {
        this.tally.skip("bad-record");
        continue;
      }
      const messages = Array.isArray(tab.bubbles) ? tab.bubbles.length : 0;
      if (messages === 0) {
        this.tally.skip("empty-session");
        continue;
      }
      this.add("inline-message", messages);
      const ts = toEpochMs(tab.lastSendTime, this.ctx.now);
      this.session(raw, ts, ts, false, []);
    }
  }

  private session(raw: string, created: number | undefined, updated: number | undefined, agent: boolean, models: string[]): void {
    const start = created ?? updated;
    if (start === undefined) return this.tally.skip("no-ts");
    const end = Math.max(start, updated ?? start);
    const s: SessionEv = {
      k: "session", tool: TOOL, source: IDE_SOURCE, id: cuSessionId(raw, this.ctx), window: "detail", origin: "human", start, end, models,
      surface: "ide", mode: agent ? "agent" : "chat",
    };
    this.ctx.emit(s);
    this.tally.span(start);
    this.tally.span(end);
  }
}
