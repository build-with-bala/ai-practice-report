import type { CommitFact, RepoFacts, RepoSignals } from "../../core/git/types";
import type { ConfigEv, CoverageEv, Ev, MarkerEv, PromptEv, PromptFeatures, ToolEv } from "../../core/model/events";
import type { Intent, MarkerKind, Toolchain } from "../../core/model/ids";
import { sid } from "../../core/model/ids";
import type { ScanResult } from "../../core/scan";
import { keyedHash, normalizePath } from "../../core/text/hash";
import { CANARY } from "../kit/canary";
import { scanResultOf } from "../kit/scanresult";

/*
 * Three synthetic personas (novice, intermediate, expert) built directly as a ScanResult: events, coverage and repo
 * signals, with no files. Everything is deterministic: there is no RNG, and every share is spread over its index with
 * `spread(i, share) = floor((i+1)·share) > floor(i·share)` (a count, for shares above 1). The knobs are Task 9's table;
 * the calibration test (test/core/scoring/calibration.test.ts) checks that the walk reads them back.
 *
 * How the knobs become events (walk rules, Task 5):
 * - Every persona is Claude Code only, so no cross-tool pair can make a host copy. All work starts at `hourUtc` on its
 *   active days. A day holds episode slots 50 min apart, each slot starting on a 10-min bucket and finishing inside it,
 *   so every episode is exactly one bucket. One repo per active day, rotating, so a commit never lands another day's
 *   episode; within a day the landed episodes come first, so a commit never lands an earlier, unlanded one.
 * - A typed turn is a human detail prompt, its main actions (8 s apart), and on the episode's last turn the finished
 *   children (subagents, delegated by the first main actions). The last turn is never made non-sticky, so every child
 *   turn is sticky.
 * - A later turn is a follow-up (a correction, the turn after an interrupt, or a plain continuation by the `followUps`
 *   knob) or a new brief, which starts a new instruction (turns per work, walk rule 12).
 * - Non-sticky turns have exactly one cause each: a corrected brief (turn 0, the next prompt is a correction), an
 *   interrupt (turn 1; the next prompt is a substantive redirect when healthy, a continuation when not), or a later
 *   correction (turns 1 to L−2) filling the rest of the share.
 * - Code edits use the persona's extension; a verified edit turn runs a passing test right after the edit. Each episode
 *   has one failing lint in its first non-edit turn, closed by a passing lint right after it, or left open. Lint never
 *   overlaps test, so a check of one kind never closes the other.
 * - Parallel buckets come from headless (scripted) runs placed in human episode buckets; the rest run alone.
 * - Model tier per episode follows a 2 × 2 table against episode size, so Spearman's rho is the table's phi.
 * - Tokens are spread over the typed turns so that fresh tokens per landed unit hit the knob exactly.
 */

export type PersonaKind = "novice" | "intermediate" | "expert";

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
/** The scan time when none is given: Monday 2026-11-16, 00:00 UTC. */
const DEFAULT_NOW = Date.UTC(2026, 10, 16);
const SLOT_MS = 50 * MIN;
const STEP_MS = 8 * SEC;
const CHILD_STEP_MS = 4 * SEC;
const THINK_MS = 25 * SEC;
const SOLO_OFFSET_MS = 6 * HOUR;
const CC = "claude-code.transcripts";
const HIST = "claude-code.history";
const CONF = "claude-code.config";
const VERSION = "2.0.0";
const EPS = 1e-9; // floating slack in the spread, so that e.g. 3 · (1/3) counts as 1

/** The brief's spread: how many of index i's units a share gives (0 or 1 for a share ≤ 1). */
const spreadCount = (i: number, share: number): number => Math.floor((i + 1) * share + EPS) - Math.floor(i * share + EPS);
const spread = (i: number, share: number): boolean => spreadCount(i, share) > 0;
/** The units a share gives over indices 0 … n−1. */
const total = (n: number, share: number): number => Math.floor(n * share + EPS);

interface RepoSpec { maintained?: boolean; instrTest?: boolean; hook?: boolean; ci?: boolean }

interface Knobs {
  weeks: number; weekdays: number[]; sessionsPerWeek: number;
  /** Episodes of session g (global index) and the active-day index (within the week) of each. */
  episodes(g: number, s: number): number[];
  turns: number; actions(local: number, e: number): number; children: number; childActions: number; background: number;
  nonSticky: number; edit: number; verified: number; ext: string; lang: Toolchain; closed: number;
  corrected: number; interrupts: number; healthy: number; parallel: number; headlessPerWeek: number;
  /**
   * The share of plain later turns (no correction, no turn after an interrupt) that are follow-ups of the turn before;
   * the rest are new briefs (a new instruction). Turns per work reads it, with the corrections and redirects, which are
   * always follow-ups.
   */
  followUps: number;
  /** The structure marks of episode e's brief. */
  brief(e: number): Partial<PromptFeatures>;
  compaction(g: number): MarkerKind | undefined;
  switchesPerWeek: number; rho: number; tokensPerLanded: number;
  repos: RepoSpec[]; landed: number; rework: number; prsPerWeek: number; authored: number; installed: number;
}

/** The persona knobs (Task 9's table). */
const KNOBS: Record<PersonaKind, Knobs> = {
  novice: {
    weeks: 6, weekdays: [0, 2], sessionsPerWeek: 1, episodes: () => [0, 0, 1],
    // 2 actions per turn on average; turn 2 takes 1 or 3 by episode, so episode sizes vary and rho is defined
    turns: 4, actions: (local, e) => (local === 2 ? (e % 2 === 0 ? 1 : 3) : 2), children: 0, childActions: 0, background: 0,
    nonSticky: 0.35, edit: 0.5, verified: 0.15, ext: "sh", lang: "shell", closed: 0.4,
    corrected: 0.3, interrupts: 0.25, healthy: 0.25, parallel: 0.02, headlessPerWeek: 0, followUps: 1,
    brief: () => ({ fileRefs: 1 }),
    compaction: () => "compact-auto",
    switchesPerWeek: 0.2, rho: 0, tokensPerLanded: 1_500_000,
    repos: [{}], landed: 0.2, rework: 0.25, prsPerWeek: 0.1, authored: 0, installed: 0,
  },
  intermediate: {
    weeks: 12, weekdays: [0, 1, 2, 3], sessionsPerWeek: 8,
    episodes: (g, s) => Array<number>(spread(g, 3 / 8) ? 2 : 1).fill(Math.floor((s * 4) / 8)),
    turns: 4, actions: () => 7, children: 0.5, childActions: 8, background: 0.1,
    nonSticky: 0.2, edit: 0.6, verified: 0.4, ext: "tsx", lang: "js", closed: 0.65,
    corrected: 0.15, interrupts: 0.25, healthy: 0.5, parallel: 0.1, headlessPerWeek: 1, followUps: 0,
    brief: () => ({ fileRefs: 1, lenBucket: 2 }),
    compaction: (g) => (spread(g, 0.5) ? "compact-auto" : undefined),
    switchesPerWeek: 1, rho: 0.15, tokensPerLanded: 600_000,
    repos: [{ maintained: true, instrTest: true, ci: true }, { ci: true }, {}], landed: 0.45, rework: 0.12, prsPerWeek: 1,
    authored: 2, installed: 3,
  },
  expert: {
    weeks: 20, weekdays: [0, 1, 2, 3, 4], sessionsPerWeek: 24, episodes: (_g, s) => [Math.floor((s * 5) / 24)],
    turns: 3, actions: () => 12, children: 2.5, childActions: 15, background: 0.45,
    nonSticky: 0.1, edit: 0.6, verified: 0.75, ext: "go", lang: "go", closed: 0.85,
    corrected: 0.06, interrupts: 0.2, healthy: 0.75, parallel: 0.35, headlessPerWeek: 12, followUps: 0,
    brief: (e) => ({ hasContext: true, fileRefs: 2, lenBucket: 3, ...(spread(e, 0.25) ? { constraintTerms: 2 } : {}) }),
    compaction: (g) => (spread(g, 0.3) ? "compact-manual" : "compact-auto"),
    switchesPerWeek: 4, rho: 0.45, tokensPerLanded: 250_000,
    repos: [
      { maintained: true, instrTest: true, hook: true, ci: true }, { maintained: true, instrTest: true, hook: true, ci: true },
      { maintained: true, instrTest: true, ci: true }, { maintained: true, instrTest: true, ci: true }, { hook: true, ci: true },
    ],
    landed: 0.8, rework: 0.05, prsPerWeek: 5, authored: 8, installed: 6,
  },
};

interface TurnPlan { i: number; local: number; actions: number; edit: boolean; verified: boolean; filler: boolean }
interface EpisodePlan {
  e: number; day: number; start: number; session: SessionPlan; turns: TurnPlan[]; children: number;
  corrected: boolean; interrupted: boolean; healthy: boolean; closed: boolean; landed: boolean; reworked: boolean; pr: boolean; high: boolean;
}
interface SessionPlan { g: number; id: string; repo: number; episodes: EpisodePlan[]; compaction?: MarkerKind }

/**
 * A persona's scan. `now` (default Monday 2026-11-16 00:00 UTC) is the scan time: the persona's weeks are the whole ISO
 * weeks (Monday to Sunday, UTC) before the week holding it. `hourUtc` (default 12) is the hour every active day starts.
 * `canaries`: config names, cwds and model ids embed canary values (pre-flight P13); a canary model id keeps its family
 * word after the canary (`<CANARY.slug>-opus`), so it has no vendor prefix (P3 pre-flight F25) and keeps its tier.
 */
export function personaScan(kind: PersonaKind, o: { now?: number; hourUtc?: number; canaries?: boolean } = {}): ScanResult {
  const k = KNOBS[kind];
  const now = o.now ?? DEFAULT_NOW;
  const hourUtc = o.hourUtc ?? 12;
  if (!Number.isFinite(now) || !Number.isFinite(hourUtc)) throw new RangeError("personaScan: now and hourUtc must be finite");
  const salt = new Uint8Array(32).fill(0x2a);
  const hash = (v: string): string => keyedHash(salt, v);
  const canaries = o.canaries === true;
  const model = (family: "opus" | "sonnet"): string => (canaries ? `${CANARY.slug}-${family}` : `claude-${family}-4`);
  const HIGH = { model: model("opus"), effort: "high" };
  const LOW = { model: model("sonnet"), effort: "medium" };
  let ids = 0;
  const newId = (): string => sid("claude-code", `00000000-0000-4000-8000-${(++ids).toString(16).padStart(12, "0")}`);

  // ---------- the calendar: sessions, episodes and their slots ----------
  const weekday0 = Math.floor((now - Date.UTC(1970, 0, 5)) / WEEK) * WEEK + Date.UTC(1970, 0, 5); // the Monday on or before now
  const monday0 = weekday0 - k.weeks * WEEK;
  const nd = k.weekdays.length;
  const dayStart = (d: number): number => monday0 + (Math.floor(d / nd) * 7 + k.weekdays[d % nd]!) * DAY + hourUtc * HOUR;
  const slotsUsed = new Map<number, number>();
  const sessions: SessionPlan[] = [];
  const episodes: EpisodePlan[] = [];
  for (let w = 0; w < k.weeks; w++) {
    for (let s = 0; s < k.sessionsPerWeek; s++) {
      const g = w * k.sessionsPerWeek + s;
      const days = k.episodes(g, s);
      const firstDay = w * nd + days[0]!;
      const session: SessionPlan = { g, id: newId(), repo: firstDay % k.repos.length, episodes: [] };
      const c = k.compaction(g);
      if (c !== undefined) session.compaction = c;
      sessions.push(session);
      for (const dw of days) {
        const day = w * nd + dw;
        const slot = slotsUsed.get(day) ?? 0;
        slotsUsed.set(day, slot + 1);
        const ep: EpisodePlan = { e: 0, day, start: dayStart(day) + slot * SLOT_MS, session, turns: [], children: 0,
          corrected: false, interrupted: false, healthy: false, closed: false, landed: false, reworked: false, pr: false, high: false };
        session.episodes.push(ep);
        episodes.push(ep);
      }
    }
  }
  episodes.sort((a, b) => a.start - b.start);

  // ---------- per-episode and per-turn flags ----------
  let i = 0;
  let editOrdinal = 0;
  let interruptOrdinal = 0;
  episodes.forEach((ep, e) => {
    ep.e = e;
    ep.children = spreadCount(e, k.children);
    ep.corrected = spread(e, k.corrected);
    ep.interrupted = spread(e, k.interrupts);
    if (ep.interrupted) ep.healthy = spread(interruptOrdinal++, k.healthy);
    ep.closed = spread(e, k.closed);
    for (let local = 0; local < k.turns; local++, i++) {
      const edit = spread(i, k.edit);
      const verified = edit && spread(editOrdinal++, k.verified);
      ep.turns.push({ i, local, actions: k.actions(local, e), edit, verified, filler: false });
    }
  });
  const turnsTotal = i;
  // fillers: later corrections make up the non-sticky share beyond the corrected briefs and the interrupts
  const corrected = episodes.filter((ep) => ep.corrected).length;
  const interrupted = episodes.filter((ep) => ep.interrupted).length;
  const fillers = total(turnsTotal, k.nonSticky) - corrected - interrupted;
  const candidates = episodes.flatMap((ep) => ep.turns.filter((t) => t.local >= 1 && t.local <= k.turns - 2 && !(t.local === 1 && ep.interrupted)));
  if (fillers < 0 || fillers > candidates.length) throw new Error(`personaScan(${kind}): the non-sticky share cannot be realized`);
  candidates.forEach((t, c) => { t.filler = spread(c, fillers / candidates.length); });

  // landed: spread over the edit episodes, then the landed ones of each day moved first (a commit lands every earlier
  // episode of its repo within a day)
  const editEpisodes = episodes.filter((ep) => ep.turns.some((t) => t.edit));
  editEpisodes.forEach((ep, j) => { ep.landed = spread(j, k.landed); });
  const byDay = new Map<number, EpisodePlan[]>();
  for (const ep of editEpisodes) {
    const list = byDay.get(ep.day);
    if (list) list.push(ep);
    else byDay.set(ep.day, [ep]);
  }
  for (const list of byDay.values()) {
    const n = list.filter((ep) => ep.landed).length;
    list.forEach((ep, j) => { ep.landed = j < n; });
  }
  const landed = editEpisodes.filter((ep) => ep.landed);
  // rework: R fix-up commits over N landed commits make R/(N+R) the rework share
  const fixes = Math.round((k.rework * landed.length) / (1 - k.rework));
  landed.forEach((ep, j) => { ep.reworked = spread(j, fixes / landed.length); });
  // PRs: hosted by landed episodes whose earlier episodes in the session all landed (a PR marker lands its row's episodes)
  let prs = 0;
  for (let w = 0; w < k.weeks; w++) prs += spreadCount(w, k.prsPerWeek);
  const prHosts = landed.filter((ep) => ep.session.episodes.slice(0, ep.session.episodes.indexOf(ep)).every((x) => x.landed));
  if (prs > prHosts.length) throw new Error(`personaScan(${kind}): too few landed episodes for the PRs`);
  prHosts.forEach((ep, j) => { ep.pr = spread(j, prs / prHosts.length); });

  // tiers: a 2 × 2 table of tier against episode size whose phi is the knob's rho
  const sizeOf = (ep: EpisodePlan): number => ep.turns.reduce((a, t) => a + t.actions, 0) + ep.children * k.childActions;
  const big = Math.max(...episodes.map(sizeOf));
  const groups = [episodes.filter((ep) => sizeOf(ep) === big), episodes.filter((ep) => sizeOf(ep) !== big)];
  groups.forEach((group, gi) => {
    if (group.length === 0) return;
    const high = Math.round((group.length * (gi === 0 ? 1 + k.rho : 1 - k.rho)) / 2);
    group.forEach((ep, j) => { ep.high = spread(j, high / group.length); });
  });

  // ---------- repos ----------
  const roots = k.repos.map((_, r) => (canaries ? `${CANARY.path}/repo-${r}` : `/home/dev/${kind}/repo-${r}`));
  const repoKeys = roots.map((root) => hash(normalizePath(root)));
  const projectKeys = repoKeys; // each session runs at its repo's root
  const commits: CommitFact[][] = k.repos.map(() => []);
  let shas = 0;
  const commit = (r: number, ts: number, files: string[], rework?: CommitFact["rework"]): void => {
    const c: CommitFact = { ts, shaKey: hash((++shas).toString(16).padStart(7, "0")), files, owner: true, mine: true, ai: "claude" };
    if (rework !== undefined) c.rework = rework;
    commits[r]!.push(c);
  };

  // ---------- tokens: fresh tokens per landed unit exactly at the knob ----------
  const landedUnits = landed.length + fixes + prs;
  const tokensTotal = Math.round(k.tokensPerLanded * landedUnits);
  const tokensOfTurn = (ti: number): number => Math.floor(tokensTotal / turnsTotal) + (ti < tokensTotal % turnsTotal ? 1 : 0);

  // ---------- events ----------
  const evs: Ev[] = [];
  const features = (f: Partial<PromptFeatures>): PromptFeatures => ({ words: 9, lenBucket: 1, hasContext: false, fileRefs: 0, listLines: 0,
    constraintTerms: 0, isTaskStart: false, techCats: {}, ...f });
  const tool = (sessionId: string, ts: number, over: Partial<ToolEv>): ToolEv => ({ k: "tool", tool: "claude-code", source: CC, ts, sessionId,
    name: "Read", category: "read", ok: true, ...over });
  const marker = (sessionId: string | undefined, ts: number, kind: MarkerKind, source = CC, detail?: string): MarkerEv => {
    const m: MarkerEv = { k: "marker", tool: "claude-code", source, ts, kind };
    if (sessionId !== undefined) m.sessionId = sessionId;
    if (detail !== undefined) m.detail = detail;
    return m;
  };
  const prompt = (sessionId: string, ts: number, window: "detail" | "lifetime", intent: Intent, f: PromptFeatures, textHash: string): PromptEv =>
    ({ k: "prompt", tool: "claude-code", source: window === "detail" ? CC : HIST, ts, sessionId, window, origin: "human", intent, features: f, textHash });

  let children = 0;
  let files = 0;
  let plainTurns = 0;
  for (const session of sessions) {
    const sessionEvs: Ev[] = [];
    const models = new Set<string>();
    for (const ep of session.episodes) {
      const tier = ep.high ? HIGH : LOW;
      models.add(tier.model);
      let t = ep.start;
      let end = t;
      const hostTurn = ep.turns.find((x) => !x.edit)!; // the first non-edit turn: its failing lint
      for (const turn of ep.turns) {
        const prev = ep.turns[turn.local - 1];
        const intent: Intent = turn.local === 0 ? "spec"
          : (turn.local === 1 && ep.corrected) || prev?.filler ? "correction"
          : turn.local === 2 && ep.interrupted ? (ep.healthy ? "redirect" : "continuation")
          : spread(plainTurns++, k.followUps) ? "continuation" : "spec";
        const f = turn.local === 0 ? features({ words: 40, isTaskStart: true, ...k.brief(ep.e) }) : features({ words: intent === "correction" ? 7 : 9 });
        const textHash = hash(`${session.id}#${turn.i}`);
        sessionEvs.push(prompt(session.id, t, "detail", intent, f, textHash));
        evs.push(prompt(session.id, t, "lifetime", intent, f, textHash));

        // main actions
        const delegates = turn.local === k.turns - 1 ? ep.children : 0;
        const plan: Partial<ToolEv>[] = [];
        for (let c = 0; c < delegates; c++) plan.push({ name: "Task", category: "delegate" });
        if (turn === hostTurn) {
          plan.push({ name: "Bash", category: "lint", checks: ["lint"], ok: false, exit: 1, toolchain: k.lang });
          if (ep.closed) plan.push({ name: "Bash", category: "lint", checks: ["lint"], ok: true, exit: 0, toolchain: k.lang });
        }
        const tail: Partial<ToolEv>[] = [];
        if (turn.edit) {
          tail.push({ name: "Edit", category: "edit", editExt: k.ext, linesAdded: 18, linesRemoved: 6 });
          if (turn.verified) tail.push({ name: "Bash", category: "test", checks: ["test"], ok: true, exit: 0, toolchain: k.lang });
        }
        while (plan.length + tail.length < turn.actions) plan.push({ name: "Read", category: "read" });
        plan.push(...tail);
        if (plan.length !== turn.actions) throw new Error(`personaScan(${kind}): turn ${turn.i} does not fit its actions`);
        let last = t;
        let childLast = t;
        let delegated = 0;
        plan.forEach((over, a) => {
          const ts = t + 5 * SEC + a * STEP_MS;
          last = ts;
          if (over.category !== "delegate") { sessionEvs.push(tool(session.id, ts, over)); return; }
          // a finished child: delegated by this call, its own actions inside the turn
          const childId = newId();
          sessionEvs.push(tool(session.id, ts, { ...over, delegateTo: childId }));
          const ci = children++;
          const cStart = ts + SEC;
          const cEnd = cStart + 2 * SEC + (k.childActions - 1) * CHILD_STEP_MS;
          evs.push({ k: "session", tool: "claude-code", source: CC, id: childId, window: "detail", origin: "subagent", start: cStart, end: cEnd,
            models: [LOW.model], parentId: session.id, projectKey: projectKeys[session.repo]!, surface: "cli", version: VERSION, spawnDepth: 1,
            agentType: ci % 2 === 0 ? "general-purpose" : "Explore", background: spread(ci, k.background), inRepo: true });
          for (let m = 0; m < k.childActions; m++) evs.push(tool(childId, cStart + 2 * SEC + m * CHILD_STEP_MS, { name: m % 3 === 2 ? "Grep" : "Read", category: m % 3 === 2 ? "search" : "read" }));
          childLast = Math.max(childLast, cEnd);
          delegated++;
        });
        if (delegated !== delegates) throw new Error("personaScan: delegation mismatch");
        const turnEnd = Math.max(last, childLast) + 2 * SEC;
        const isInterrupted = turn.local === 1 && ep.interrupted;
        if (isInterrupted) sessionEvs.push(marker(session.id, last + SEC, "interrupt", CC, "user"));
        if (turn.local === 0 && session.compaction !== undefined && ep === session.episodes[0]) sessionEvs.push(marker(session.id, last + 1_500, session.compaction));
        if (!isInterrupted) {
          sessionEvs.push({ k: "turn", tool: "claude-code", source: CC, ts: turnEnd, sessionId: session.id, window: "detail", model: tier.model,
            effort: tier.effort, status: "completed", ms: turnEnd - t });
        }
        const tokens = tokensOfTurn(turn.i);
        const inTok = Math.floor(tokens * 0.7);
        const outTok = Math.floor(tokens * 0.1);
        sessionEvs.push({ k: "usage", tool: "claude-code", source: CC, ts: turnEnd, sessionId: session.id, model: tier.model, inTok, outTok,
          cacheW: tokens - inTok - outTok, cacheR: tokens * 4 });
        end = turnEnd;
        t = turnEnd + THINK_MS;
      }
      // delivery
      if (ep.landed) {
        const own = [hash(`src/file-${++files}.${k.ext}`), hash(`src/file-${++files}.${k.ext}`)];
        commit(session.repo, end + 2 * MIN, own);
        if (ep.reworked) commit(session.repo, end + 3 * MIN, own.slice(0, 1), "fixup");
        if (ep.pr) { sessionEvs.push(marker(session.id, end + 4 * MIN, "pr-link", CC, hash(`pr-${session.id}-${ep.e}`))); }
      }
    }
    const times = sessionEvs.map((x) => (x as { ts: number }).ts);
    const start = Math.min(...times);
    evs.push({ k: "session", tool: "claude-code", source: CC, id: session.id, window: "detail", origin: "human", start, end: Math.max(...times),
      models: [...models].sort(), projectKey: projectKeys[session.repo]!, surface: "cli", version: VERSION, inRepo: true });
    evs.push(...sessionEvs);
  }

  // headless runs: scripted sessions placed in human episode buckets (parallel) or alone (solo)
  const H = Math.round(k.headlessPerWeek * k.weeks);
  const E = episodes.length;
  let solo = 0;
  let parallel = 0;
  if (H > 0 && k.parallel * E >= H) parallel = Math.max(H, Math.round(k.parallel * E));
  else if (H > 0) { solo = Math.round((H - k.parallel * E) / (1 + k.parallel)); parallel = H - solo; }
  const soloOnDay = new Map<number, number>();
  let overlapping = 0;
  for (let r = 0; r < H; r++) {
    const anchor = episodes[Math.floor((r * E) / H)]!;
    const isSolo = solo > 0 && spread(r, solo / H);
    const buckets: number[] = [];
    if (isSolo) {
      const n = soloOnDay.get(anchor.day) ?? 0;
      soloOnDay.set(anchor.day, n + 1);
      buckets.push(dayStart(anchor.day) + SOLO_OFFSET_MS + n * 20 * MIN);
    } else {
      const share = solo > 0 ? 1 : spreadCount(overlapping++, parallel / H);
      const sameDay = episodes.filter((x) => x.day === anchor.day);
      const at = sameDay.indexOf(anchor);
      for (let b = 0; b < share; b++) buckets.push((sameDay[at + b] ?? sameDay[at - (b - (sameDay.length - 1 - at))])!.start);
    }
    const id = newId();
    const runEvs: Ev[] = [];
    runEvs.push({ k: "prompt", tool: "claude-code", source: CC, ts: buckets[0]! + 50 * SEC, sessionId: id, window: "detail", origin: "scripted",
      intent: "command", features: features({ words: 8 }), textHash: hash(`run#${r}`) });
    for (const b of buckets.sort((x, y) => x - y)) for (let a = 0; a < 3; a++) runEvs.push(tool(id, b + MIN + a * 10 * SEC, { name: "Read", category: "read" }));
    const times = runEvs.map((x) => (x as { ts: number }).ts);
    evs.push({ k: "session", tool: "claude-code", source: CC, id, window: "detail", origin: "scripted", start: Math.min(...times), end: Math.max(...times),
      models: [LOW.model], surface: "sdk-cli", version: VERSION });
    evs.push(...runEvs);
  }

  // switches: lifetime markers from the history, on each week's first active day
  for (let w = 0; w < k.weeks; w++) {
    const first = sessions.find((s) => s.episodes[0]!.day === w * nd);
    const n = spreadCount(w, k.switchesPerWeek);
    for (let m = 0; m < n; m++) {
      const ts = dayStart(w * nd) + MIN + m * SEC;
      evs.push(m % 2 === 0 ? marker(first?.id, ts, "model-switch", HIST, "opus") : marker(first?.id, ts, "effort-switch", HIST, "high"));
    }
  }

  // used artifacts: own skills and installed plugins, each used
  const configName = (base: string): string => (canaries ? `${CANARY.project}-${base}` : base);
  for (let a = 0; a < k.authored; a++) {
    evs.push({ k: "config", tool: "claude-code", source: CONF, kind: "skill", name: configName(`skill-${a + 1}`), provenance: "authored", uses: 3 + a,
      lastUsed: monday0 + (k.weeks * 7 - 3) * DAY, firstSeen: monday0 } satisfies ConfigEv);
  }
  for (let a = 0; a < k.installed; a++) {
    evs.push({ k: "config", tool: "claude-code", source: CONF, kind: "plugin", name: configName(`plugin-${a + 1}`), provenance: "installed", uses: 2 + a,
      lastUsed: monday0 + (k.weeks * 7 - 3) * DAY, firstSeen: monday0 } satisfies ConfigEv);
  }

  // coverage
  const span = (source: string): { from: number; to: number; records: number } => {
    let from = Infinity;
    let to = -Infinity;
    let records = 0;
    for (const x of evs) {
      if (x.source !== source) continue;
      records++;
      const ts = (x as { ts?: number; start?: number }).ts ?? (x as { start?: number }).start;
      const te = (x as { end?: number }).end ?? ts;
      if (ts !== undefined && ts < from) from = ts;
      if (te !== undefined && te > to) to = te;
    }
    return { from, to, records };
  };
  const coverage = (source: string, window: "detail" | "lifetime", filesRead: number): CoverageEv => {
    const sp = span(source);
    const c: CoverageEv = { k: "coverage", tool: "claude-code", source, window, status: "ok", beta: false, installed: true, files: filesRead,
      bytes: sp.records * 400, records: sp.records, skipped: {}, unknownTypes: {}, versions: [VERSION] };
    if (Number.isFinite(sp.from)) { c.from = sp.from; c.to = sp.to; }
    return c;
  };
  const covs = [coverage(CC, "detail", sessions.length + children + H), coverage(HIST, "lifetime", 1), coverage(CONF, "lifetime", k.authored + k.installed)];

  // repo signals
  const repos: RepoFacts[] = k.repos.map((spec, r) => {
    const instr = spec.maintained || spec.instrTest;
    return {
      repoKey: repoKeys[r]!, projectKeys: [projectKeys[r]!], identity: true, commits: commits[r]!.sort((a, b) => a.ts - b.ts), commitsTruncated: false,
      fileLists: true,
      instructions: {
        files: instr ? [spec.maintained ? "claude" : "agents"] : [], namesChecks: spec.instrTest ? ["test", "lint"] : [],
        touched: spec.maintained ? 2 : 0, ...(spec.maintained ? { lastTouched: monday0 + 10 * DAY } : {}),
      },
      hooks: { entries: spec.hook ? 1 : 0, checks: spec.hook ? ["test"] : [], disabled: false },
      ci: { present: spec.ci === true, checks: spec.ci ? ["test", "lint"] : [] },
      precommit: { present: false, checks: [] },
    };
  });
  const repoSignals: RepoSignals = { status: "ok", repos, roots: new Map(repoKeys.map((key, r) => [key, roots[r]!])), skipped: {}, ms: 0 };
  const cwds = new Map(projectKeys.map((key, r) => [key, roots[r]!]));
  return scanResultOf([...covs, ...evs], { repos: repoSignals, cwds, salt, finishedAt: now });
}
