import type { Metric } from "../analysis/types";
import type { ChildType } from "../analysis/walk";
import type { RepoSignals } from "../git/types";
import type { ToolId, Window } from "../model/ids";

/**
 * The evidence the dimensions' minimums read (spec §6.5). From the sample: `typedTurns`, `sessions` (rows with at
 * least one typed turn), `days` and `weeks` (distinct local days with a typed turn, and their ISO weeks), `episodes`,
 * `editTurns` (gated rows), `followUps`, `briefs`, `failingChecks`, `interrupts`, `workEpisodes`, `tierEpisodes`
 * (episodes with a known tier and effort), `editEpisodesInRepo`, `landed`, `bgKnown`. Global: `repos` (active repos
 * with repo facts), `buckets` (active buckets), `artifacts` (distinct used artifacts), `lifetimeWeeks`, `ownCommits`
 * (owner commits in the detail span).
 */
export interface Evidence { typedTurns: number; sessions: number; days: number; weeks: number; episodes: number; editTurns: number;
  followUps: number; briefs: number; failingChecks: number; interrupts: number; workEpisodes: number; tierEpisodes: number;
  editEpisodesInRepo: number; landed: number; repos: number; buckets: number; bgKnown: number; artifacts: number;
  lifetimeWeeks: number; ownCommits: number }

/**
 * The signals catalogue (spec §6.4): every metric carries `{ window, sources, from, to, n }`, and is null (with a
 * reason) when n = 0 or the capability or repo signals it needs are missing — never a measured 0.
 */
export interface Signals {
  vae: Metric; closure: Metric; medianFixCycles: number | null;
  stickyMean: Metric; p90Run: Metric; actionsPerTurn: Metric;
  parallelShare: Metric; peakConcurrency: number; backgroundShare: Metric;
  fanoutPerEpisode: Metric; childTypes: Record<ChildType, number>; workflowRunsPerEpisode: Metric; maxDepth: number;
  correctionRate: Metric; healthyInterruptShare: Metric; turnsPerWork: Metric; queuePerTurn: Metric;
  maintainedShare: Metric; artifacts: Metric; memoryFiles: number; briefScore: Metric; hygiene: Metric;
  switchesPerWeek: Metric; rho: Metric; tokensPerLanded: Metric; usdPerLanded: Metric;
  landedShare: Metric; reworkShare: Metric; prsPerWeek: Metric; aiCoauthoredShare: Metric; commitAfterSession: Metric;
  guardrails: Metric; headlessPerWeek: Metric;
  /*
   * Two signals read commit habits. `tokensPerLanded` follows how often a person commits (a commit after many sittings
   * reads as a high cost): null (`no-data`) under 5 landed units. `reworkShare` reads commit-message conventions (revert,
   * fixup!, fix:): null (`not-captured`) when no commit by anyone in the kept repositories' window is marked as rework,
   * since such a history does not use them.
   */
  /**
   * Among the code-edit turns that count as not checked, the share in which a shell command ran after the last edit
   * that the command classifier did not recognise as a check; unscored.
   */
  uncheckedCommandShare: Metric;
  evidence: Evidence; repoSignals: RepoSignals["status"];
}

/** The signals computed across sessions once per analysis: the bootstrap holds them at their point values. */
export type Globals = Pick<Signals, "parallelShare" | "peakConcurrency" | "headlessPerWeek" | "guardrails" | "maintainedShare" | "artifacts"
  | "memoryFiles" | "switchesPerWeek" | "reworkShare" | "prsPerWeek" | "aiCoauthoredShare" | "commitAfterSession" | "repoSignals">
  & { evidence: Pick<Evidence, "repos" | "buckets" | "artifacts" | "lifetimeWeeks" | "ownCommits">;
      /** Start (epoch ms) of the earliest bucket with at least 2 rows doing agent work; exposure reads it (pre-flight P14). */
      firstParallelBucket?: number };

/** Tools whose readers emit `queue` markers: queue per turn is measurable for their rows only. */
export const QUEUE_TOOLS: ReadonlySet<ToolId> = new Set<ToolId>(["claude-code"]);

export type Reason = NonNullable<Metric["reason"]>;

/** The rows a metric read: sorted distinct sources and the span they cover. */
export class Span {
  private sources: string[] = []; // a handful at most: a list beats a set here
  private from = Infinity;
  private to = -Infinity;
  add(r: { source: string; start: number; end: number }): void {
    this.addSource(r.source);
    if (r.start < this.from) this.from = r.start;
    if (r.end > this.to) this.to = r.end;
  }
  addSource(source: string): void { if (!this.sources.includes(source)) this.sources.push(source); }
  /** Widens the span to hold `ts` (for evidence that is not a row: commits, markers). */
  addTs(ts: number): void {
    if (ts < this.from) this.from = ts;
    if (ts > this.to) this.to = ts;
  }
  /** The span's start and end; both absent while it is empty. */
  range(): { from?: number; to?: number } {
    return Number.isFinite(this.from) ? { from: this.from, to: this.to } : {};
  }
  /** A metric over this span: null with `reason` when n = 0, or `degenerate` when n > 0 and the value is not finite. */
  metric(window: Window, n: number, value: number | null, reason: Reason = "no-data"): Metric {
    return fixedMetric(window, [...this.sources].sort(), n, value, reason, this.range());
  }
}

/**
 * A fixed-source metric (repo metrics read git: `sources ["git"]`) over an explicit span. A null value takes `reason`
 * when n = 0; with n > 0 a `no-data` reason becomes `degenerate` (`no-data` always means n = 0).
 */
export function fixedMetric(window: Window, sources: string[], n: number, value: number | null, reason: Reason, span?: { from?: number; to?: number }): Metric {
  const m: Metric = { window, sources, n, value: null };
  if (span?.from !== undefined && Number.isFinite(span.from)) m.from = span.from;
  if (span?.to !== undefined && Number.isFinite(span.to)) m.to = span.to;
  if (n > 0 && value !== null && Number.isFinite(value)) m.value = value;
  else m.reason = n > 0 && reason === "no-data" ? "degenerate" : reason;
  return m;
}
