import type { Ev, PromptEv } from "../model/events";
import type { Origin, ToolId, Window } from "../model/ids";

/** What every metric says about its evidence: one window, the sources it read, the span covered and the sample size. */
export interface MetricMeta { window: Window; sources: string[]; from?: number; to?: number; n: number }
/**
 * A measured value; `null` = not measurable (never a default 0), and `reason` says why: `no-data` (the data could hold it,
 * but n = 0), `not-captured` (no tool in the data records the fields it needs), `repo-signals-off` (it needs repo
 * signals, and they are off or git is missing).
 */
export interface Metric extends MetricMeta { value: number | null; reason?: "no-data" | "not-captured" | "repo-signals-off" }

/** What the person left out of the report: whole tools, projects (projectKeys), and a date range (epoch ms, inclusive). */
export interface Exclusions { tools?: ToolId[]; projects?: string[]; from?: number; to?: number }

/**
 * One session of the store, placed in its tree. `parentId`: the session's own link, else an `EdgeEv`'s; none for a root
 * (a link that closed a cycle is dropped). `orphan`: the parent it names is not in the data (the row is kept, but is no
 * top-level session). `depth`/`topId`: distance to and id of its root ancestor (an orphan is its own top). `repoKey`:
 * the repo holding its project (repo signals).
 */
export interface SessionRow { id: string; tool: ToolId; source: string; window: Window; origin: Origin; start: number; end: number;
  parentId?: string; orphan: boolean; children: string[]; depth: number; topId: string; projectKey?: string; repoKey?: string;
  models: string[]; effort?: string; background?: boolean; agentType?: string; workflowId?: string; surface?: string;
  mode?: "agent" | "chat"; approval?: string; sandbox?: string; version?: string }

/** The tools whose data has each capability (sorted): a metric that needs one is measurable for those tools only. */
export interface Capabilities { outcomes: ToolId[]; lines: ToolId[]; background: ToolId[]; usage: ToolId[]; effort: ToolId[] }

/**
 * Active days ("YYYY-MM-DD" in the analysis zone, sorted) and their ISO weeks ("YYYY-Www"), per window: a day is active
 * only with at least one human prompt (spec §6.2) — file times and zero-count days never count. `DailyEv` "local" days
 * are days in the scanning machine's zone when the tool wrote them, so they can misalign with the analysis zone; and
 * the date-range exclusion applies to them by whole day (a day is kept when it lies within the range's first and last
 * day in the analysis zone).
 */
export interface Activity { detailDays: string[]; lifetimeDays: string[]; detailWeeks: string[]; lifetimeWeeks: string[];
  byTool: Partial<Record<ToolId, { detailDays: string[]; lifetimeDays: string[] }>> }

/**
 * The first stage of analysis: every session row that survived the exclusions, the detail-window top-level sessions
 * metrics walk (`detailTop`: no parent, not a host copy), the host copies the cross-tool dedupe found (`hosts`, left out
 * of every metric: a pair of sessions from different tools with at least 3 paired prompts — equal text hash, within
 * 60 s, more than 2 words, inside the date range — making at least half of BOTH sessions' such prompts; see dedupe.ts), the projectKey → repoKey map, activity and capabilities, and what was dropped or unplaced.
 * `orphans`: events (per kind) whose `sessionId` names no session, and `session` = rows whose parent is missing.
 */
export interface SessionTable {
  rows: Map<string, SessionRow>; detailTop: SessionRow[]; hosts: Set<string>; repoOf: Map<string, string>;
  /**
   * What the exclusions left in scope: the date range (epoch ms, inclusive; ±Infinity when open) and the tools left out.
   * Every later stage clips to the range: events, commits and markers outside it never count, even in a kept row.
   */
  scope: { from: number; to: number; tools: ReadonlySet<ToolId> };
  /** Origin human, or a scripted prompt the dedupe relabelled (its host copy was typed by the person). */
  isHuman(p: PromptEv): boolean;
  activity: Activity; capabilities: Capabilities;
  dedupe: { hostSessions: number; pairedPrompts: number; relabelled: number };
  exclusions: { tools: number; projects: number; sessions: number }; orphans: Partial<Record<Ev["k"], number>>;
}

/** Tools whose readers emit `pr-link` markers. */
export const PR_LINK_TOOLS: ReadonlySet<ToolId> = new Set<ToolId>(["claude-code"]);
/** Tools whose readers emit `model-switch` and `effort-switch` markers. */
export const SWITCH_TOOLS: ReadonlySet<ToolId> = new Set<ToolId>(["claude-code"]);
