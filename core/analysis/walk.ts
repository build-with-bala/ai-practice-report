import type { CommitFact, RepoSignals } from "../git/types";
import { BUCKET_MS, CORRECTION_WINDOW_MS, DELIVERY_WINDOW_MS, TASK_GAP_MS } from "../model/constants";
import type { MarkerEv, PromptEv, PromptFeatures, ToolEv, TurnEv, UsageEv } from "../model/events";
import type { Intent, Origin, Toolchain, ToolId } from "../model/ids";
import type { EventStore } from "../model/store";
import { langOfExt, toolchainMatches } from "../text/langs";
import { dayKey } from "./activity";
import { detailSourcesOf } from "./scope";
import { childType, effortRank, modelTier, type ChildType } from "./tiers";
import type { SessionRow, SessionTable } from "./types";

export type { ChildType };
/** A histogram: value → count. */
export type Hist = Record<number, number>;

/**
 * One detail-window top-level session's sufficient statistics: every signal and score downstream is computed from
 * these (sums, counts and small histograms; never per-event copies), so a bootstrap resamples rows, not events.
 *
 * - `days`: local days (the walk's zone) with at least one typed turn.
 * - `turns`: typed turns (walk rule 3); `stickySum` = Σ s_t·log2(1 + A_t); `actions`: every action of the row and its
 *   descendants; `successRuns`: A_t of the turns with s_t = 1, capped at 1,000.
 * - VAE (rule 8): `gatedVae` = the row's tool reports check outcomes; `editTurns`, `editWeight` and `verifiedWeight` are
 *   0 when it does not. `uncheckedEditTurns`: the gated edit turns no recognised check verified; `uncheckedCommandTurns`:
 *   those of them in which a command ran after the last edit that the command classifier gave no check kind (an action
 *   of category shell, package or container with no checks).
 * - Closure (rule 9): `failingChecks`, `closedChecks`, `fixCycles` (the failures each closing pass closed, capped at 50).
 * - `humanPrompts`: the row's human prompts in scope; `openerPrompts`: those whose intent the classifier read from
 *   opening words (correction, redirect, continuation, ack).
 * - Steering (rules 10–12): `followUps` = typed turns that start no episode; `briefs`, `correctedBriefs`,
 *   `briefScoreSum`; `interrupts` (the person's, not proxy-timed) and `healthyInterrupts`; `workEpisodes` (the
 *   instructions with an action, rule 12: `turnsPerWork`) and `turnsPerWorkSum`; `queued` = `queue` markers.
 * - Children (rule 13): fan-out — `children` and `finishedChildren` — counts the row's direct children only; deeper
 *   descendants feed `maxDepth` (0 without children) and A_t, never fan-out. `bgKnown` (background known), `bgChildren`
 *   (background), `childTypes` and `workflowRuns` (distinct workflow ids) take every descendant.
 * - Hygiene (rule 14): `compactAuto`, `compactManual`, `freshEpisodes`.
 * - `tierPairs` (rule 15): flat [10·tier + effort rank, log2(1 + episode actions), …], one pair per episode with both.
 * - Cost (rule 16): `tokens` (Σ in + out + cache writes, row and descendants; `tokensKnown`: any usage), `usd` (the
 *   row's totals; `usdKnown`: one names a cost, and the row lies wholly inside the date range — totals carry no time).
 * - Delivery (rules 17–18): `editEpisodes`; `editEpisodesInRepo` (the row's repo has an identity); `landedEpisodes`
 *   (of those in a repo: a commit of the repo — any, clones' included — or a commit or PR marker of the row within
 *   [episode start, episode end + DELIVERY_WINDOW_MS]; the row's markers include its descendants'); `prKeys` and
 *   `commitShaKeys` (marker details of the row and its descendants, sorted; a key two rows name belongs to the
 *   earliest-starting one only); `landed` units (rule 18, from the person's commits, each once). A git commit becomes a landed unit
 *   only in a repo with an identity (`RepoFacts.identity`); marker keys count without one. In a repo whose commit
 *   list was cut (`RepoFacts.commitsReach`), an edit episode that ended before the reach is in no delivery
 *   denominator (`editEpisodesInRepo`, `landedEpisodes`): its commits may not have been read.
 * - Date range (`SessionTable.scope`): events, markers and commits outside [from, to] are ignored, even in a kept row
 *   that overlaps the range; `start` and `end` are the row's, clipped to the range. A descendant out of scope
 *   (`inScope`) counts nowhere (not in background, types, workflows or depth); a direct child counts in fan-out when any
 *   node of its subtree is in scope, and its descendants always group under it.
 * - `buckets` (rule 19): the distinct ⌊ts / BUCKET_MS⌋ with an action of the row or its descendants, ascending.
 */
export interface SessionStats {
  id: string; tool: ToolId; source: string; origin: Origin; start: number; end: number; repoKey?: string; scripted: boolean;
  days: string[];
  turns: number; stickySum: number; actions: number; successRuns: Hist;
  gatedVae: boolean; editTurns: number; editWeight: number; verifiedWeight: number; uncheckedEditTurns: number; uncheckedCommandTurns: number;
  humanPrompts: number; openerPrompts: number;
  failingChecks: number; closedChecks: number; fixCycles: Hist;
  episodes: number; followUps: number; briefs: number; correctedBriefs: number; briefScoreSum: number;
  interrupts: number; healthyInterrupts: number; workEpisodes: number; turnsPerWorkSum: number; queued: number;
  children: number; finishedChildren: number; bgKnown: number; bgChildren: number; childTypes: Partial<Record<ChildType, number>>;
  workflowRuns: number; maxDepth: number;
  compactAuto: number; compactManual: number; freshEpisodes: number;
  tierPairs: number[];
  tokens: number; tokensKnown: boolean; usd: number; usdKnown: boolean; landed: number;
  editEpisodes: number; editEpisodesInRepo: number; landedEpisodes: number; prKeys: string[]; commitShaKeys: string[];
  buckets: number[];
}

/** successRuns keys are capped here. */
const RUN_CAP = 1_000;
/** fixCycles keys are capped here. */
const FIX_CAP = 50;
/** Rule 10: an interrupt is early within this many actions of its turn… */
const EARLY_ACTIONS = 5;
/** …or this soon after its turn's prompt. */
const EARLY_MS = 120_000;
/** Rule 10: the next typed turn comes this soon after the interrupt, and no interrupt follows it this soon. */
const HEALTHY_WINDOW_MS = 10 * 60_000;
const HEALTHY_INTENTS: ReadonlySet<Intent> = new Set<Intent>(["spec", "redirect", "correction", "question"]);
const HEALTHY_MIN_WORDS = 4;
const HEALTHY_MAX_SIM = 0.6;
const BRIEF_INTENTS: ReadonlySet<Intent> = new Set<Intent>(["spec", "question"]);
/** The intents the classifier recognises by a prompt's opening words (English): the corrected-brief rate rests on them. */
const OPENER_INTENTS: ReadonlySet<Intent> = new Set<Intent>(["correction", "redirect", "continuation", "ack"]);

/** Walk rule 2: a tool call that does work on the task — not `meta`, and neither denied nor cancelled. */
export function isAction(e: ToolEv): boolean {
  return e.category !== "meta" && e.outcome !== "denied" && e.outcome !== "cancelled";
}

/**
 * Walk rule 11's brief score: the mean of five marks — it gives context, names a file, lists at least 2 lines, states a
 * constraint, and is at least of length bucket 2.
 */
export function briefScore(f: PromptFeatures): number {
  const marks = [f.hasContext, f.fileRefs >= 1, f.listLines >= 2, f.constraintTerms >= 1, f.lenBucket >= 2];
  return marks.filter(Boolean).length / marks.length;
}

/**
 * The one rule for a marker's time: a proxy-timed marker (`proxyTs`: a stand-in time, such as a file's modification
 * time) places the marker, but never counts as activity or puts a row in scope.
 */
export const atRealTime = (m: MarkerEv): boolean => m.proxyTs !== true;

/**
 * Whether a session row is in scope of the date range: it lies wholly inside the range, or it has an event inside it
 * (a tool call, usage, a marker of `markersOf` at a real time, a prompt or a turn). A row the range cuts with no event inside it is
 * part of the excluded period and counts nowhere — in the walk's children, nor as artifact evidence.
 */
export function inScope(r: SessionRow, t: SessionTable, store: EventStore, markersOf: (id: string) => readonly MarkerEv[]): boolean {
  const { from, to } = t.scope;
  if (r.start >= from && r.end <= to) return true;
  const inRange = (ts: number): boolean => ts >= from && ts <= to;
  return store.forSession(r.id, "tool").some((e) => inRange(e.ts)) || store.forSession(r.id, "usage").some((e) => inRange(e.ts))
    || markersOf(r.id).some(atRealTime) || store.forSession(r.id, "prompt").some((e) => inRange(e.ts))
    || store.forSession(r.id, "turn").some((e) => inRange(e.ts));
}

/** A check action that ran to its end: it lists checks and says whether it passed. */
const ranCheck = (e: ToolEv): boolean => isAction(e) && e.checks !== undefined && e.checks.length > 0 && e.outcome === undefined && e.ok !== undefined;
/** A person's interrupt (detail `user`, `replaced` or none) at a real time. */
const personInterrupt = (m: MarkerEv): boolean =>
  m.kind === "interrupt" && m.proxyTs === undefined && (m.detail === undefined || m.detail === "user" || m.detail === "replaced");
/** Categories of a command line run in a shell, a package manager or a container. */
const COMMAND_CATEGORIES: ReadonlySet<ToolEv["category"]> = new Set<ToolEv["category"]>(["shell", "package", "container"]);
/** A command that ran and that the classifier gave no check kind. */
const unrecognisedCommand = (e: ToolEv): boolean => isAction(e) && COMMAND_CATEGORIES.has(e.category) && (e.checks === undefined || e.checks.length === 0);
/** Two checks' toolchains match when either is unknown or `any`, or they are equal. */
const chainsMatch = (a: Toolchain | undefined, b: Toolchain | undefined): boolean => a === undefined || b === undefined || a === "any" || b === "any" || a === b;
const linesOf = (e: ToolEv): number => (e.linesAdded ?? 0) + (e.linesRemoved ?? 0);
/** The language of an edit or write action when it is code of a toolchain (not `doc`, not unknown). */
function codeLang(e: ToolEv): Toolchain | undefined {
  if (!isAction(e) || (e.category !== "edit" && e.category !== "write")) return undefined;
  const lang = langOfExt(e.editExt);
  return lang === undefined || lang === "doc" ? undefined : lang;
}
const bump = <K extends string | number>(h: Partial<Record<K, number>>, k: K): void => { h[k] = (h[k] ?? 0) + 1; };
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byTs = (a: { ts: number }, b: { ts: number }): number => a.ts - b.ts;

/** The largest index i with key(arr[i]) ≤ x (−1 when none); `arr` ascending by key. */
function lastAtMost<T>(arr: readonly T[], x: number, key: (v: T) => number, lt = false): number {
  let lo = 0;
  let hi = arr.length - 1;
  let at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const k = key(arr[mid]!);
    if (lt ? k < x : k <= x) { at = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return at;
}

type RowEv = PromptEv | ToolEv | MarkerEv | TurnEv | UsageEv;
const isProxy = (e: RowEv): boolean => e.k === "marker" && e.proxyTs === true;

/** One direct child of the row with its descendants: their tools in time order and what the row's stats take of them. */
interface Child { id: string; start: number; tools: ToolEv[]; actions: number; lastTs: number }
/** A typed turn: its prompt and its span `[pos, end)` in the row's events, the children attributed to it, and its A_t. */
interface Turn { p: PromptEv; pos: number; end: number; children: Child[]; a: number; work?: ToolEv[] }

/** Repo facts the walk reads, per repoKey: identity and the commit times (ascending). */
interface RepoIndex { identity: boolean; commitTs: number[]; reach?: number }

/**
 * The per-session sufficient statistics: one walk per `detailTop` row under the walk rules (Task 5). Pure: no clock,
 * no I/O. Host copies are never walked (they are not in `detailTop`, and a host descendant is skipped with its subtree).
 * Markers come only from sources that report a detail coverage, except `clear` markers (rule 7), whatever their source.
 */
export function buildSessionStats(t: SessionTable, store: EventStore, repos: RepoSignals, o: { timeZone: string }): SessionStats[] {
  const detailSources = detailSourcesOf(store.all("coverage"));
  const gated = new Set<ToolId>(t.capabilities.outcomes);
  const { from, to } = t.scope;
  const inRange = (ts: number): boolean => ts >= from && ts <= to;
  const markersOf = (id: string): MarkerEv[] => store.forSession(id, "marker").filter((m) => detailSources.has(m.source) && inRange(m.ts));

  const repoIndex = new Map<string, RepoIndex>();
  for (const r of repos.repos) {
    if (repoIndex.has(r.repoKey)) continue;
    const idx: RepoIndex = { identity: r.identity, commitTs: r.commits.map((c) => c.ts).filter(inRange).sort((a, b) => a - b) };
    if (r.commitsReach !== undefined) idx.reach = r.commitsReach;
    repoIndex.set(r.repoKey, idx);
  }

  const out = t.detailTop.map((row) => walkRow(row, t, store, { timeZone: o.timeZone, gated, markersOf, repoIndex, inRange }));
  ownKeysOnce(out);
  assignCommits(repos, out, inRange);
  return out;
}

/** A PR or commit key that several rows' markers name belongs to the earliest-starting row (then the smallest id) only. */
function ownKeysOnce(out: readonly SessionStats[]): void {
  const prs = new Set<string>();
  const shas = new Set<string>();
  const firstSeen = (keys: readonly string[], seen: Set<string>): string[] => keys.filter((k) => !seen.has(k) && (seen.add(k), true));
  for (const s of [...out].sort((a, b) => a.start - b.start || cmp(a.id, b.id))) {
    s.prKeys = firstSeen(s.prKeys, prs);
    s.commitShaKeys = firstSeen(s.commitShaKeys, shas);
  }
}

/** The key a commit is counted once by: its `id` (equal in every clone), else its `shaKey` (hand-made facts). */
export const commitKey = (c: CommitFact): string => c.id ?? c.shaKey;

/**
 * Rule 18: each of the person's commits (`mine`) in a repo with an identity counts once among the repositories with
 * kept rows (by `commitKey`, first by repository key, then by the repo's own order), and goes to the latest-starting
 * `detailTop` row (then the largest id), across the kept repositories that list it, whose [start, end +
 * DELIVERY_WINDOW_MS] holds it.
 * Each row's landed units become |its commit marker keys ∪ the commits assigned to it| + its distinct PRs. A commit a
 * commit marker of any row already names is not assigned again: the marker's row counts it (one commit, counted once).
 */
function assignCommits(repos: RepoSignals, out: SessionStats[], inRange: (ts: number) => boolean): void {
  const marked = new Set<string>();
  for (const s of out) for (const k of s.commitShaKeys) marked.add(k);
  const rowsByRepo = new Map<string, SessionStats[]>();
  for (const s of out) {
    if (s.repoKey === undefined) continue;
    const list = rowsByRepo.get(s.repoKey);
    if (list) list.push(s);
    else rowsByRepo.set(s.repoKey, [s]);
  }
  // each commit once, with every kept repo that lists it
  const commits = new Map<string, { ts: number; shaKey: string; repos: string[] }>();
  for (const r of [...repos.repos].sort((a, b) => cmp(a.repoKey, b.repoKey))) {
    if (!r.identity || !rowsByRepo.has(r.repoKey)) continue;
    for (const c of r.commits) {
      if (!c.mine || marked.has(c.shaKey) || !inRange(c.ts)) continue;
      const key = commitKey(c);
      const at = commits.get(key);
      if (at) { if (!at.repos.includes(r.repoKey)) at.repos.push(r.repoKey); }
      else commits.set(key, { ts: c.ts, shaKey: c.shaKey, repos: [r.repoKey] });
    }
  }
  const assigned = new Map<SessionStats, Set<string>>();
  for (const c of commits.values()) {
    let best: SessionStats | undefined;
    for (const key of c.repos) {
      for (const s of rowsByRepo.get(key)!) {
        if (s.start > c.ts || c.ts > s.end + DELIVERY_WINDOW_MS) continue;
        if (!best || s.start > best.start || (s.start === best.start && s.id > best.id)) best = s;
      }
    }
    if (!best) continue;
    let set = assigned.get(best);
    if (!set) assigned.set(best, (set = new Set()));
    set.add(c.shaKey);
  }
  for (const s of out) {
    const shas = new Set([...s.commitShaKeys, ...(assigned.get(s) ?? [])]);
    s.landed = shas.size + s.prKeys.length;
  }
}

interface WalkCtx {
  timeZone: string; gated: ReadonlySet<ToolId>; markersOf: (id: string) => MarkerEv[]; repoIndex: ReadonlyMap<string, RepoIndex>;
  inRange: (ts: number) => boolean;
}

function walkRow(row: SessionRow, t: SessionTable, store: EventStore, cx: WalkCtx): SessionStats {
  const scripted = row.origin === "scripted" || row.origin === "scheduled";
  const markers = cx.markersOf(row.id);
  const inRange = cx.inRange;
  const start = Math.max(row.start, t.scope.from);
  const end = Math.min(row.end, t.scope.to);
  // rule 1: the row's events in order — ts, then kind (prompt < tool < marker < turn < usage), then emission (a stable
  // sort of the kinds concatenated in that order)
  const seq: RowEv[] = [
    ...store.forSession(row.id, "prompt").filter((p) => p.window === "detail"),
    ...store.forSession(row.id, "tool"),
    ...markers,
    ...store.forSession(row.id, "turn").filter((e) => e.window === "detail"),
    ...store.forSession(row.id, "usage"),
  ].filter((e) => inRange(e.ts)).sort(byTs);
  const clears = store.forSession(row.id, "marker").filter((m) => m.kind === "clear" && m.proxyTs === undefined && inRange(m.ts))
    .map((m) => m.ts).sort((a, b) => a - b);
  const n = seq.length;
  const actPrefix = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const e = seq[i]!;
    actPrefix[i + 1] = actPrefix[i]! + (e.k === "tool" && isAction(e) ? 1 : 0);
  }
  const rowEnd = Math.max(end, n > 0 ? seq[n - 1]!.ts : end);

  const s: SessionStats = {
    id: row.id, tool: row.tool, source: row.source, origin: row.origin, start, end, scripted,
    days: [], turns: 0, stickySum: 0, actions: actPrefix[n]!, successRuns: {},
    gatedVae: cx.gated.has(row.tool), editTurns: 0, editWeight: 0, verifiedWeight: 0, uncheckedEditTurns: 0, uncheckedCommandTurns: 0, humanPrompts: 0, openerPrompts: 0,
    failingChecks: 0, closedChecks: 0, fixCycles: {},
    episodes: 0, followUps: 0, briefs: 0, correctedBriefs: 0, briefScoreSum: 0,
    interrupts: 0, healthyInterrupts: 0, workEpisodes: 0, turnsPerWorkSum: 0, queued: 0,
    children: 0, finishedChildren: 0, bgKnown: 0, bgChildren: 0, childTypes: {}, workflowRuns: 0, maxDepth: 0,
    compactAuto: 0, compactManual: 0, freshEpisodes: 0, tierPairs: [],
    tokens: 0, tokensKnown: false, usd: 0, usdKnown: false, landed: 0,
    editEpisodes: 0, editEpisodesInRepo: 0, landedEpisodes: 0, prKeys: [], commitShaKeys: [], buckets: [],
  };
  if (row.repoKey !== undefined) s.repoKey = row.repoKey;

  // markers (rule 14), cost (rule 16), buckets (rule 19)
  const prKeys = new Set<string>();
  const shaKeys = new Set<string>();
  const persons: MarkerEv[] = [];
  const deliveryTs: number[] = [];
  /** Rule 17: a commit or PR marker of the row or a descendant. */
  const delivery = (m: MarkerEv): void => {
    if (m.kind !== "pr-link" && m.kind !== "commit") return;
    if (m.detail !== undefined) (m.kind === "pr-link" ? prKeys : shaKeys).add(m.detail);
    if (m.proxyTs === undefined) deliveryTs.push(m.ts);
  };
  for (const m of markers) {
    if (m.kind === "compact-auto") s.compactAuto++;
    else if (m.kind === "compact-manual") s.compactManual++;
    else if (m.kind === "queue") s.queued++;
    else if (m.kind === "pr-link" || m.kind === "commit") delivery(m);
    else if (personInterrupt(m)) persons.push(m);
  }
  persons.sort(byTs);
  // totals carry no time: a row the date range cuts gives no cost, rather than the cost of its excluded part too
  const whole = row.start >= t.scope.from && row.end <= t.scope.to;
  for (const tot of whole ? store.forSession(row.id, "totals") : []) {
    // a running total: the largest is the session's, whatever order the reports arrived in
    if (tot.usd !== undefined && Number.isFinite(tot.usd) && (!s.usdKnown || tot.usd > s.usd)) { s.usd = tot.usd; s.usdKnown = true; }
  }
  const buckets = new Set<number>();
  for (const e of seq) {
    if (e.k === "tool" && isAction(e)) buckets.add(Math.floor(e.ts / BUCKET_MS));
    else if (e.k === "usage") { s.tokens += e.inTok + e.outTok + e.cacheW; s.tokensKnown = true; }
  }

  // children (rules 4, 13): every descendant that is no host copy, grouped under the row's direct child it descends from.
  // A direct child counts (fan-out, its group for A_t) when any node of its subtree is in scope (`inScope`); each node's
  // own attributes (background, type, workflow, depth) count only when that node is.
  const direct: Child[] = [];
  const workflows = new Set<string>();
  for (const did of row.children) {
    const d = t.rows.get(did);
    if (!d || t.hosts.has(did)) continue;
    const nodes: { c: SessionRow; own: ToolEv[]; usage: UsageEv[]; marks: MarkerEv[]; active: boolean }[] = [];
    const stack = [did];
    while (stack.length > 0) {
      const id = stack.pop()!;
      const c = t.rows.get(id);
      if (!c || t.hosts.has(id)) continue;
      const own = store.forSession(id, "tool").filter((e) => inRange(e.ts));
      const usage = store.forSession(id, "usage").filter((u) => inRange(u.ts));
      const marks = cx.markersOf(id);
      const active = own.length > 0 || usage.length > 0 || marks.some(atRealTime) || inScope(c, t, store, cx.markersOf);
      nodes.push({ c, own, usage, marks, active });
      for (const g of c.children) stack.push(g);
    }
    if (!nodes.some((x) => x.active)) continue; // the whole subtree lies in the excluded period: it counts nowhere
    const cStart = Math.max(d.start, t.scope.from);
    const child: Child = { id: did, start: cStart, tools: [], actions: 0, lastTs: cStart };
    direct.push(child);
    s.children++;
    for (const { c, own, usage, marks, active } of nodes) {
      if (active) {
        s.maxDepth = Math.max(s.maxDepth, c.depth - row.depth);
        if (c.background !== undefined) { s.bgKnown++; if (c.background) s.bgChildren++; }
        bump(s.childTypes, childType(c.agentType));
        if (c.workflowId !== undefined) workflows.add(c.workflowId);
      }
      for (const e of own) {
        child.tools.push(e);
        child.lastTs = Math.max(child.lastTs, e.ts);
        if (!isAction(e)) continue;
        child.actions++;
        s.actions++;
        buckets.add(Math.floor(e.ts / BUCKET_MS));
      }
      for (const m of marks) delivery(m);
      for (const u of usage) {
        s.tokens += u.inTok + u.outTok + u.cacheW;
        s.tokensKnown = true;
        child.lastTs = Math.max(child.lastTs, u.ts);
      }
    }
    // finished: judged on the subtree's in-range actions, and the direct child's own stop
    const acts = child.tools.filter(isAction).sort(byTs);
    const failedLastTwo = acts.length >= 2 && acts[acts.length - 1]!.ok === false && acts[acts.length - 2]!.ok === false;
    const stopped = nodes[0]!.marks.some((m) => m.kind === "interrupt" && m.detail === "stopped-by-user");
    if (!stopped && !failedLastTwo) s.finishedChildren++;
  }
  for (const c of direct) c.tools.sort(byTs);
  deliveryTs.sort((a, b) => a - b);
  s.prKeys = [...prKeys].sort(cmp);
  s.commitShaKeys = [...shaKeys].sort(cmp);
  s.workflowRuns = workflows.size;
  s.buckets = [...buckets].sort((a, b) => a - b);
  if (scripted) return s; // rule 20: no turns (nor a person's interrupts), but buckets, tokens and children
  s.interrupts = persons.length;

  // rule 3: typed turns; a command prompt with no action in its span is no turn, and its span joins the previous one's
  const starts: number[] = [];
  for (let i = 0; i < n; i++) {
    const e = seq[i]!;
    if (e.k !== "prompt" || !t.isHuman(e)) continue;
    starts.push(i);
    s.humanPrompts++;
    if (OPENER_INTENTS.has(e.intent)) s.openerPrompts++;
  }
  const turns: Turn[] = [];
  for (let j = 0; j < starts.length; j++) {
    const pos = starts[j]!;
    const end = starts[j + 1] ?? n;
    const p = seq[pos] as PromptEv;
    if (p.intent === "command" && actPrefix[end]! - actPrefix[pos]! === 0) {
      const prev = turns[turns.length - 1];
      if (prev) prev.end = end;
      continue;
    }
    turns.push({ p, pos, end, children: [], a: 0 });
  }
  if (turns.length === 0) return s;
  s.turns = turns.length;
  const endTs = (i: number): number => (i + 1 < turns.length ? turns[i + 1]!.p.ts : rowEnd);
  /** The turn whose time span (prompt, next prompt or row end] holds `ts`, else −1. */
  const turnAfter = (ts: number): number => lastAtMost(turns, ts, (x) => x.p.ts, true);
  const turnAtPos = (pos: number): number => {
    const i = lastAtMost(turns, pos, (x) => x.pos);
    return i >= 0 && pos < turns[i]!.end ? i : -1;
  };

  // rule 4: child attribution — the delegating call's turn, else the turn holding the child's start, else the first
  const delegating = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const e = seq[i]!;
    if (e.k === "tool" && e.delegateTo !== undefined && !delegating.has(e.delegateTo)) delegating.set(e.delegateTo, i);
  }
  for (const c of direct) {
    const at = delegating.get(c.id);
    let ti = at === undefined ? -1 : turnAtPos(at);
    if (ti < 0) {
      const i = lastAtMost(turns, c.start, (x) => x.p.ts);
      ti = i >= 0 && c.start <= endTs(i) ? i : 0;
    }
    turns[ti]!.children.push(c);
  }

  // rule 5: A_t; the days
  const days = new Set<string>();
  for (const tu of turns) {
    tu.a = actPrefix[tu.end]! - actPrefix[tu.pos]! + tu.children.reduce((x, c) => x + c.actions, 0);
    days.add(dayKey(tu.p.ts, cx.timeZone));
  }
  s.days = [...days].sort();

  /** The ts of the last event at a real time in [from, to), else `fallback`. */
  const lastRealTs = (from: number, to: number, fallback: number): number => {
    for (let i = to - 1; i >= from; i--) if (!isProxy(seq[i]!)) return seq[i]!.ts;
    return fallback;
  };

  // rule 6: s_t
  const interrupted = new Set<number>();
  for (const m of persons) {
    const i = turnAfter(m.ts);
    if (i >= 0 && m.ts <= endTs(i)) interrupted.add(i);
  }
  for (let i = 0; i < turns.length; i++) {
    const tu = turns[i]!;
    let ok = !interrupted.has(i);
    const next = turns[i + 1];
    if (ok && next && next.p.intent === "correction") {
      // the window runs from the span's last real event, or its attributed children's last event when later
      const last = Math.max(lastRealTs(tu.pos, tu.end, tu.p.ts), ...tu.children.map((c) => c.lastTs));
      if (next.p.ts - last <= CORRECTION_WINDOW_MS) ok = false;
    }
    if (ok) {
      let seen = 0;
      for (let k = tu.end - 1; k > tu.pos && seen < 2; k--) {
        const e = seq[k]!;
        if (e.k !== "tool" || !isAction(e)) continue;
        if (e.ok !== false) break;
        seen++;
      }
      if (seen === 2) ok = false;
    }
    if (ok) {
      s.stickySum += Math.log2(1 + tu.a);
      bump(s.successRuns, Math.min(tu.a, RUN_CAP));
    }
  }

  // rule 8: VAE per turn, over the row's span and the turn's children in time order
  const workOf = (tu: Turn): ToolEv[] => {
    if (tu.work) return tu.work;
    const list: ToolEv[] = [];
    for (let k = tu.pos; k < tu.end; k++) {
      const e = seq[k]!;
      if (e.k === "tool") list.push(e);
    }
    if (tu.children.length > 0) {
      for (const c of tu.children) for (const e of c.tools) list.push(e);
      list.sort(byTs); // stable: the row's own calls keep their emission order
    }
    return (tu.work = list);
  };
  const editTurn = new Array<boolean>(turns.length).fill(false);
  for (let i = 0; i < turns.length; i++) {
    const work = workOf(turns[i]!);
    const langs = new Set<Toolchain>();
    let lines = 0;
    let lastEdit = -1;
    for (let k = 0; k < work.length; k++) {
      const lang = codeLang(work[k]!);
      if (lang === undefined) continue;
      langs.add(lang);
      lines += linesOf(work[k]!);
      lastEdit = k;
    }
    if (langs.size === 0) continue;
    editTurn[i] = true;
    if (!s.gatedVae) continue;
    const weight = Math.log2(2 + lines);
    s.editTurns++;
    s.editWeight += weight;
    let verified = false;
    let unknownCommand = false;
    for (let k = lastEdit + 1; k < work.length; k++) {
      const e = work[k]!;
      if (ranCheck(e) && toolchainMatches(e.toolchain, langs)) { verified = true; break; }
      if (unrecognisedCommand(e)) unknownCommand = true;
    }
    if (verified) s.verifiedWeight += weight;
    else {
      s.uncheckedEditTurns++;
      if (unknownCommand) s.uncheckedCommandTurns++;
    }
  }

  // rule 7: episodes
  const episodes: { from: number; to: number; fresh: boolean }[] = [];
  let ci = 0;
  for (let i = 0; i < turns.length; i++) {
    const tu = turns[i]!;
    let fresh = i === 0;
    let starts = i === 0;
    if (i > 0) {
      const prevTs = turns[i - 1]!.p.ts;
      while (ci < clears.length && clears[ci]! <= prevTs) ci++;
      if (ci < clears.length && clears[ci]! <= tu.p.ts) fresh = starts = true;
      if (tu.p.ts - lastRealTs(0, tu.pos, tu.p.ts) >= TASK_GAP_MS) starts = true;
    }
    if (starts) episodes.push({ from: i, to: i + 1, fresh });
    else episodes[episodes.length - 1]!.to = i + 1;
  }
  s.episodes = episodes.length;
  s.followUps = turns.length - episodes.length;

  // rule 10: healthy interrupts
  for (let k = 0; k < persons.length; k++) {
    const m = persons[k]!;
    const i = turnAfter(m.ts);
    if (i < 0 || m.ts > endTs(i)) continue;
    const tu = turns[i]!;
    const q = lastAtMost(seq, m.ts, (e) => e.ts);
    const before = actPrefix[Math.min(Math.max(q + 1, tu.pos), tu.end)]! - actPrefix[tu.pos]!;
    if (before > EARLY_ACTIONS && m.ts - tu.p.ts > EARLY_MS) continue;
    const next = turns[i + 1];
    if (!next || next.p.ts - m.ts > HEALTHY_WINDOW_MS || !HEALTHY_INTENTS.has(next.p.intent)) continue;
    const f = next.p.features;
    if (f.words < HEALTHY_MIN_WORDS || (f.simToPrev !== undefined && f.simToPrev >= HEALTHY_MAX_SIM)) continue;
    if (persons.some((x) => x.ts > next.p.ts && x.ts <= next.p.ts + HEALTHY_WINDOW_MS)) continue;
    s.healthyInterrupts++;
  }

  // per episode: briefs (11), turns per work over its instructions (12), closure (9), hygiene (14), tiers (15), delivery (17)
  const single = row.models.length === 1 ? row.models[0] : undefined;
  const repo = row.repoKey === undefined ? undefined : cx.repoIndex.get(row.repoKey);
  const inRepo = repo?.identity === true;
  for (const ep of episodes) {
    const first = turns[ep.from]!;
    if (ep.fresh) s.freshEpisodes++;
    if (BRIEF_INTENTS.has(first.p.intent)) {
      s.briefs++;
      s.briefScoreSum += briefScore(first.p.features);
      if (ep.to - ep.from > 1 && turns[ep.from + 1]!.p.intent === "correction") s.correctedBriefs++;
    }
    let actions = 0;
    let isEdit = false;
    let endAt = first.p.ts;
    let best: number | undefined;
    const work: ToolEv[] = [];
    for (let i = ep.from; i < ep.to; i++) {
      const tu = turns[i]!;
      actions += tu.a;
      isEdit ||= editTurn[i]!;
      endAt = Math.max(endAt, lastRealTs(tu.pos, tu.end, tu.p.ts), ...tu.children.map((c) => c.lastTs));
      for (const e of workOf(tu)) work.push(e);
      for (let k = tu.pos; k < tu.end; k++) {
        const e = seq[k]!;
        if (e.k !== "turn") continue;
        const v = tierValue(e.model ?? single, e.effort ?? row.effort);
        if (v !== undefined && (best === undefined || v > best)) best = v;
      }
    }
    best ??= tierValue(single, row.effort); // TurnEvs that give no tier and effort: the row's single model and its effort
    if (best !== undefined) s.tierPairs.push(best, Math.log2(1 + actions));
    turnsPerWork(turns, ep, s);
    closure(work.sort(byTs), s);
    if (!isEdit) continue;
    s.editEpisodes++;
    if (!inRepo) continue;
    // a cut commit list (`commitsReach`): an episode that ended before the oldest commit read cannot be matched
    if (repo!.reach !== undefined && endAt < repo!.reach) continue;
    s.editEpisodesInRepo++;
    const hi = endAt + DELIVERY_WINDOW_MS;
    const inWindow = (ts: readonly number[]): boolean => {
      const k = lastAtMost(ts, hi, (x) => x);
      return k >= 0 && ts[k]! >= first.p.ts;
    };
    if (inWindow(repo!.commitTs) || inWindow(deliveryTs)) s.landedEpisodes++;
  }
  return s;
}

/**
 * Rule 12, per instruction: within an episode, an instruction starts at its first typed turn and at each later typed
 * turn whose intent is a brief intent (spec, question); the typed turns after it, up to the next instruction, are its
 * follow-ups. Slash-command turns are no turns of it (their actions are its work). Each instruction with an action and
 * a turn adds turns / log2(2 + actions): the steering an instruction needed for the work it set off, whatever the
 * length of the sitting. `workEpisodes` counts those instructions.
 */
function turnsPerWork(turns: readonly Turn[], ep: { from: number; to: number }, s: SessionStats): void {
  let n = 0;
  let actions = 0;
  const close = (): void => {
    if (n > 0 && actions > 0) { s.workEpisodes++; s.turnsPerWorkSum += n / Math.log2(2 + actions); }
  };
  for (let i = ep.from; i < ep.to; i++) {
    const tu = turns[i]!;
    if (i === ep.from || BRIEF_INTENTS.has(tu.p.intent)) { close(); n = 0; actions = 0; }
    if (tu.p.intent !== "command") n++;
    actions += tu.a;
  }
  close();
}

/** 10·tier + effort rank, when both are known. */
function tierValue(model: string | undefined, effort: string | undefined): number | undefined {
  const tier = model === undefined ? undefined : modelTier(model);
  const rank = effort === undefined ? undefined : effortRank(effort);
  return tier === undefined || rank === undefined ? undefined : 10 * tier + rank;
}

/**
 * Rule 9 over one episode's calls in time order: a failing check is closed by a later passing check with an
 * overlapping check kind and a matching toolchain; each pass that closes failures records how many it closed.
 */
function closure(work: readonly ToolEv[], s: SessionStats): void {
  let open: ToolEv[] = [];
  for (const e of work) {
    if (!ranCheck(e)) continue;
    if (e.ok === false) {
      s.failingChecks++;
      open.push(e);
      continue;
    }
    const closes = (f: ToolEv): boolean => chainsMatch(f.toolchain, e.toolchain) && f.checks!.some((k) => e.checks!.includes(k));
    const closed = open.filter(closes);
    if (closed.length === 0) continue;
    s.closedChecks += closed.length;
    bump(s.fixCycles, Math.min(closed.length, FIX_CAP));
    open = open.filter((f) => !closes(f));
  }
}
