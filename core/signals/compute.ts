import { isoWeek } from "../analysis/activity";
import type { Metric } from "../analysis/types";
import type { ChildType, Hist, SessionStats } from "../analysis/walk";
import { QUEUE_TOOLS, Span, type Evidence, type Globals, type Signals } from "./types";

const CHILD_TYPES: readonly ChildType[] = ["explore", "plan", "review", "implement", "custom", "other"];

/**
 * Adds a histogram into a dense count array indexed by value (the walk's histograms hold small non-negative integers:
 * runs capped at 1,000, fix cycles at 50); whether it added anything.
 */
function merge(into: number[], h: Hist): boolean {
  let added = false;
  for (const k of Object.keys(h)) {
    const v = +k;
    const c = h[v]!;
    if (!(c > 0)) continue;
    into[v] = (into[v] ?? 0) + c;
    added = true;
  }
  return added;
}

/** The nearest-rank percentile (`q` in (0, 1]) of a dense count array, and its count; null when empty. */
function percentile(h: readonly (number | undefined)[], q: number): { value: number | null; n: number } {
  let n = 0;
  for (const c of h) n += c ?? 0;
  if (n === 0) return { value: null, n: 0 };
  const rank = Math.ceil(q * n);
  let seen = 0;
  for (let v = 0; v < h.length; v++) {
    seen += h[v] ?? 0;
    if (seen >= rank) return { value: v, n };
  }
  return { value: null, n }; // unreachable: the counts sum to n
}

/** The first index in ascending `a` whose value is ≥ x (`strict`: > x). */
function bound(a: Float64Array, x: number, strict: boolean): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (strict ? a[mid]! <= x : a[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Average ranks (1-based) of `v`'s values, ties sharing the mean of their ranks. */
function ranks(v: Float64Array): Float64Array {
  const sorted = Float64Array.from(v).sort();
  const out = new Float64Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = (bound(sorted, v[i]!, false) + bound(sorted, v[i]!, true) - 1) / 2 + 1;
  return out;
}

/** Spearman's rho over flat [x, y, x, y, …] pairs (Pearson on average ranks); null under 3 pairs or when a side is constant. */
function spearman(flat: readonly number[]): number | null {
  const n = flat.length >> 1;
  if (n < 3) return null;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) { x[i] = flat[2 * i]!; y[i] = flat[2 * i + 1]!; }
  const rx = ranks(x);
  const ry = ranks(y);
  const mean = (n + 1) / 2; // the mean of average ranks is always (n + 1) / 2
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = rx[i]! - mean;
    const dy = ry[i]! - mean;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return Math.max(-1, Math.min(1, sxy / Math.sqrt(sxx * syy)));
}

const ratio = (num: number, den: number): number | null => (den > 0 ? num / den : null);

/**
 * The signals of one sample of detail-window top-level rows (the point estimate, or one bootstrap replicate), with the
 * globals passed through. Pure: it reads `sample` and `g` and never changes them. Every sample metric is window
 * `detail`, its sources the sorted distinct sources of the rows that contribute to its n, and its span their min start
 * and max end (`SessionStats.start`/`end`, already clipped to the date range).
 */
export function computeSignals(sample: readonly SessionStats[], g: Globals): Signals {
  const turnsSpan = new Span();
  const vaeSpan = new Span();
  const closureSpan = new Span();
  const runSpan = new Span();
  const bgSpan = new Span();
  const episodeSpan = new Span();
  const briefSpan = new Span();
  const interruptSpan = new Span();
  const workSpan = new Span();
  const queueSpan = new Span();
  const hygieneSpan = new Span();
  const rhoSpan = new Span();
  const tokenSpan = new Span();
  const usdSpan = new Span();
  const landedSpan = new Span();

  let turns = 0, sticky = 0, actions = 0, sessions = 0;
  let editTurns = 0, editWeight = 0, verifiedWeight = 0, gatedRows = 0;
  let failing = 0, closed = 0;
  let episodes = 0, followUps = 0, briefs = 0, corrected = 0, briefSum = 0;
  let interrupts = 0, healthy = 0, workEpisodes = 0, perWork = 0;
  let queueTurns = 0, queued = 0, queueRows = 0;
  let children = 0, finished = 0, bgKnown = 0, bgChildren = 0, workflows = 0, maxDepth = 0;
  let compactAuto = 0, compactManual = 0, fresh = 0;
  let tokens = 0, tokenLanded = 0, tokenRows = 0, usd = 0, usdLanded = 0, usdRows = 0, landed = 0;
  let editInRepo = 0, landedEpisodes = 0;
  const runs: number[] = [];
  const cycles: number[] = [];
  const pairs: number[] = [];
  const days = new Set<string>();
  const childTypes = Object.fromEntries(CHILD_TYPES.map((k) => [k, 0])) as Record<ChildType, number>;

  for (const r of sample) {
    if (r.turns > 0) {
      sessions++;
      turns += r.turns;
      sticky += r.stickySum;
      actions += r.actions;
      turnsSpan.add(r);
      if (QUEUE_TOOLS.has(r.tool)) { queueRows++; queueTurns += r.turns; queued += r.queued; queueSpan.add(r); }
    }
    for (const d of r.days) days.add(d);
    if (r.gatedVae) {
      gatedRows++;
      if (r.editTurns > 0) { editTurns += r.editTurns; editWeight += r.editWeight; verifiedWeight += r.verifiedWeight; vaeSpan.add(r); }
    }
    if (r.failingChecks > 0) { failing += r.failingChecks; closed += r.closedChecks; closureSpan.add(r); }
    if (merge(runs, r.successRuns)) runSpan.add(r);
    merge(cycles, r.fixCycles);
    if (r.episodes > 0) {
      episodes += r.episodes;
      finished += r.finishedChildren;
      workflows += r.workflowRuns;
      fresh += r.freshEpisodes;
      episodeSpan.add(r);
    }
    followUps += r.followUps;
    if (r.briefs > 0) { briefs += r.briefs; corrected += r.correctedBriefs; briefSum += r.briefScoreSum; briefSpan.add(r); }
    if (r.interrupts > 0) { interrupts += r.interrupts; healthy += r.healthyInterrupts; interruptSpan.add(r); }
    if (r.workEpisodes > 0) { workEpisodes += r.workEpisodes; perWork += r.turnsPerWorkSum; workSpan.add(r); }
    children += r.children;
    if (r.bgKnown > 0) { bgKnown += r.bgKnown; bgChildren += r.bgChildren; bgSpan.add(r); }
    for (const k in r.childTypes) childTypes[k as ChildType] += r.childTypes[k as ChildType]!;
    if (r.maxDepth > maxDepth) maxDepth = r.maxDepth;
    const compactions = r.compactAuto + r.compactManual;
    compactAuto += r.compactAuto;
    compactManual += r.compactManual;
    if (compactions > 0 || r.episodes > 0) hygieneSpan.add(r);
    if (r.tierPairs.length > 0) { for (const v of r.tierPairs) pairs.push(v); rhoSpan.add(r); }
    landed += r.landed;
    if (r.tokensKnown) { tokenRows++; tokens += r.tokens; tokenLanded += r.landed; if (r.landed > 0) tokenSpan.add(r); }
    if (r.usdKnown) { usdRows++; usd += r.usd; usdLanded += r.landed; if (r.landed > 0) usdSpan.add(r); }
    if (r.editEpisodesInRepo > 0) { editInRepo += r.editEpisodesInRepo; landedEpisodes += r.landedEpisodes; landedSpan.add(r); }
  }

  const any = sample.length > 0;
  /** Not captured: the sample has rows, and none of them records what the metric needs. */
  const captured = (has: boolean) => (any && !has ? "not-captured" : "no-data");
  const d = (span: Span, n: number, value: number | null, reason: "no-data" | "not-captured" = "no-data"): Metric => span.metric("detail", n, value, reason);

  // hygiene: the mean of the parts there are
  const compactions = compactAuto + compactManual;
  const parts = [ratio(compactManual, compactions), ratio(fresh, episodes)].filter((v): v is number => v !== null);
  const hygiene = parts.length > 0 ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
  const run = percentile(runs, 0.9);
  const repoOff = g.repoSignals === "off" || g.repoSignals === "git-missing";
  const landedShare = repoOff ? landedSpan.metric("detail", 0, null, "repo-signals-off") : d(landedSpan, editInRepo, ratio(landedEpisodes, editInRepo));

  const evidence: Evidence = {
    typedTurns: turns, sessions, days: days.size, weeks: new Set([...days].map(isoWeek)).size, episodes, editTurns, followUps, briefs,
    failingChecks: failing, interrupts, workEpisodes, tierEpisodes: pairs.length >> 1, editEpisodesInRepo: editInRepo, landed,
    repos: g.evidence.repos, buckets: g.evidence.buckets, bgKnown, artifacts: g.evidence.artifacts, lifetimeWeeks: g.evidence.lifetimeWeeks,
    ownCommits: g.evidence.ownCommits,
  };

  return {
    vae: d(vaeSpan, editTurns, ratio(verifiedWeight, editWeight), captured(gatedRows > 0)),
    closure: d(closureSpan, failing, ratio(closed, failing)),
    medianFixCycles: percentile(cycles, 0.5).value,
    stickyMean: d(turnsSpan, turns, ratio(sticky, turns)),
    p90Run: d(runSpan, run.n, run.value),
    actionsPerTurn: d(turnsSpan, turns, ratio(actions, turns)),
    parallelShare: g.parallelShare, peakConcurrency: g.peakConcurrency,
    backgroundShare: d(bgSpan, bgKnown, ratio(bgChildren, bgKnown), captured(children === 0 || bgKnown > 0)),
    fanoutPerEpisode: d(episodeSpan, episodes, ratio(finished, episodes)),
    childTypes,
    workflowRunsPerEpisode: d(episodeSpan, episodes, ratio(workflows, episodes)),
    maxDepth,
    correctionRate: d(briefSpan, briefs, ratio(corrected, briefs)),
    healthyInterruptShare: d(interruptSpan, interrupts, ratio(healthy, interrupts)),
    turnsPerWork: d(workSpan, workEpisodes, ratio(perWork, workEpisodes)),
    queuePerTurn: d(queueSpan, queueTurns, ratio(queued, queueTurns), captured(turns === 0 || queueRows > 0)),
    maintainedShare: g.maintainedShare, artifacts: g.artifacts, memoryFiles: g.memoryFiles,
    briefScore: d(briefSpan, briefs, ratio(briefSum, briefs)),
    hygiene: d(hygieneSpan, compactions + episodes, hygiene),
    switchesPerWeek: g.switchesPerWeek,
    rho: d(rhoSpan, pairs.length >> 1, spearman(pairs), captured(episodes === 0 || pairs.length > 0)),
    tokensPerLanded: d(tokenSpan, tokenLanded, ratio(tokens, tokenLanded), captured(tokenRows > 0)),
    usdPerLanded: d(usdSpan, usdLanded, ratio(usd, usdLanded), captured(usdRows > 0)),
    landedShare,
    reworkShare: g.reworkShare, prsPerWeek: g.prsPerWeek, aiCoauthoredShare: g.aiCoauthoredShare, commitAfterSession: g.commitAfterSession,
    guardrails: g.guardrails, headlessPerWeek: g.headlessPerWeek,
    evidence, repoSignals: g.repoSignals,
  };
}
