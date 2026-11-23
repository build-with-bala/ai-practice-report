import { LOG_FORMAT, logRecords, parseLog } from "./commits";
import { candidates, groupRepos, type Candidate, type Repo } from "./discover";
import { runGit, type GitResult, type GitRunner } from "./run";
import type { RepoFacts, RepoSignals } from "./types";

export type { AiTool, CheckFacts, CommitFact, HookFacts, InstructionFacts, InstructionKind, RepoFacts, RepoSignals } from "./types";
export type { GitResult, GitRunner } from "./run";

export interface RepoSignalOptions {
  /** Per git command, ms (default 10 000; `rev-parse` always gets 5 000). */
  timeoutMs?: number;
  /** For all of repo signals, ms (default 20 000): no repo starts after it, and a running one is stopped at it. */
  budgetMs?: number;
  /** Repos read at most (default 200), those with the most detail-window sessions first. */
  maxRepos?: number;
  /** Commits read per repo at most, all authors' (default 5 000). */
  maxCommits?: number;
  /** Changed paths kept per commit (default 200). */
  maxFiles?: number;
  /** Repos read at once (default 4). */
  concurrency?: number;
  /** The git runner (default `runGit`); tests pass their own. */
  runner?: GitRunner;
}

export interface RepoSignalInput {
  /** Every session folder of the scan: projectKey → raw path (memory only). */
  cwds: ReadonlyMap<string, string>;
  /** The projectKeys of sessions that ended within the last 180 days: only their folders are looked at. */
  recent: ReadonlySet<string>;
  /** Detail-window sessions per projectKey: repos with more go first when there are more than `maxRepos`. */
  detailSessions?: ReadonlyMap<string, number>;
  /** The earliest start of a detail-window session (epoch ms): commits are read from 3 days before it. */
  detailFrom?: number;
  salt: Uint8Array;
  now: number;
  signal: AbortSignal;
  /** Called after each repo is read. */
  onProgress?: (done: number, total: number) => void;
}

const DAY_MS = 86_400_000;
const REV_PARSE_TIMEOUT_MS = 5_000;
/** Output cap of a small command (version, toplevel, one config value). */
const SMALL_BYTES = 64 * 1024;
/** Output cap of `git log`; past it the history counts as truncated. */
const LOG_BYTES = 33_554_432;
/** The config keys that mark a partial clone, asked only of a git older than NO_LAZY_FETCH_SINCE. */
const PARTIAL_CLONE_KEYS = ["extensions.partialClone", "remote.origin.promisor"];
/** The first git whose GIT_NO_LAZY_FETCH keeps a partial clone from fetching what it lacks. */
const NO_LAZY_FETCH_SINCE: readonly [number, number] = [2, 44];

/** What repo signals read and run, for `--explain`. */
export const REPO_SIGNALS_DESCRIBE: { reads: string[]; runs: string[] } = {
  reads: [
    "git metadata of the repos that hold recent session folders (found by checking each folder's ancestors for .git, never by crawling): " +
      "commit times; whether the author is the repo's user.email (compared in memory, never kept); AI co-author and generated-with trailers; " +
      "revert and fix-up subjects; changed-file paths as keyed hashes. Commit messages, emails, paths and source files are never kept.",
  ],
  runs: [
    "git --version",
    "git rev-parse --show-toplevel",
    "git config --get user.email",
    "git config --get extensions.partialClone, git config --get remote.origin.promisor (git older than 2.44 only)",
    "git log --all --no-merges --no-renames --date-order --since=<date> --max-count=<n> --name-only (commit metadata only)",
  ],
};

const EMPTY_FACTS = (): Pick<RepoFacts, "instructions" | "hooks" | "ci" | "precommit"> => ({
  instructions: { files: [], namesChecks: [], touched: 0 }, hooks: { entries: 0, checks: [], disabled: false },
  ci: { present: false, checks: [] }, precommit: { present: false, checks: [] },
});

/** [major, minor] of `git --version` output; undefined when it says none. */
function versionOf(stdout: string): [number, number] | undefined {
  const m = /(\d+)\.(\d+)/.exec(stdout);
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}
const atLeast = (v: [number, number] | undefined, min: readonly [number, number]): boolean =>
  v !== undefined && (v[0] > min[0] || (v[0] === min[0] && v[1] >= min[1]));

const isEnoent = (e: unknown): boolean => (e as { code?: unknown } | null)?.code === "ENOENT";

/** Stopped by the budget or an abort before the command settled. */
const STOPPED = Symbol("stopped");

/**
 * Repo signals from the session folders of recent sessions (`recent`): their repos found by ancestor checks, then per
 * repo, with read-only git only, the person's commits as keyed facts. Never throws; a stopped or missing git shows in
 * `status`.
 */
export async function collectRepoSignals(input: RepoSignalInput, o: RepoSignalOptions = {}): Promise<RepoSignals> {
  const started = Date.now();
  const runner = o.runner ?? runGit;
  const timeoutMs = o.timeoutMs ?? 10_000;
  const maxCommits = o.maxCommits ?? 5_000;
  const maxFiles = o.maxFiles ?? 200;
  const width = Math.max(1, Math.floor(o.concurrency ?? 4));
  const skipped: Record<string, number> = {};
  const skip = (reason: string, n = 1) => { if (n > 0) skipped[reason] = (skipped[reason] ?? 0) + n; };
  const roots = new Map<string, string>();
  const repos: RepoFacts[] = [];
  const since = input.detailFrom === undefined ? undefined : input.detailFrom - 3 * DAY_MS;

  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(), Math.max(0, o.budgetMs ?? 20_000));
  const signal = AbortSignal.any([input.signal, budget.signal]);
  const stopped = new Promise<typeof STOPPED>((resolve) => {
    if (signal.aborted) resolve(STOPPED);
    else signal.addEventListener("abort", () => resolve(STOPPED), { once: true });
  });
  /** One git command; STOPPED when the budget or an abort came first (the runner kills its child on the same signal). */
  const git = async (args: readonly string[], cwd: string, ms = timeoutMs, maxBytes = SMALL_BYTES): Promise<GitResult | typeof STOPPED> => {
    if (signal.aborted) return STOPPED;
    return Promise.race([runner(args, { cwd, timeoutMs: ms, maxBytes, signal }), stopped]);
  };
  const result = (status: RepoSignals["status"]): RepoSignals => {
    clearTimeout(timer);
    const out: RepoSignals = { status, repos, roots, skipped, ms: Date.now() - started };
    if (since !== undefined) out.since = since;
    return out;
  };
  const partial = () => (input.signal.aborted || budget.signal.aborted ? "partial" : "ok");

  /** Runs `job` over `items`, `width` at once; items not started once stopped count as `budget`. */
  const pool = async <T>(items: readonly T[], job: (item: T) => Promise<void>): Promise<void> => {
    let next = 0;
    const worker = async () => {
      while (next < items.length && !signal.aborted) await job(items[next++]!);
    };
    await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
    skip("budget", items.length - next);
  };

  let version: [number, number] | undefined; // git's, from `git --version`
  try {
    const cands = candidates(input.cwds, input.recent, skip);
    if (cands.length === 0) return result("ok");

    // git itself: missing (ENOENT), and its version
    try {
      const v = await git(["--version"], cands[0]!.dir, timeoutMs);
      if (v === STOPPED) {
        skip("budget", cands.length);
        return result("partial");
      }
      version = versionOf(v.stdout);
    } catch (e) {
      if (isEnoent(e)) return result("git-missing");
      skip("error", cands.length);
      return result("ok");
    }

    // each candidate's root
    const found: { cand: Candidate; root: string }[] = [];
    await pool(cands, async (cand) => {
      try {
        const r = await git(["rev-parse", "--show-toplevel"], cand.dir, REV_PARSE_TIMEOUT_MS);
        if (r === STOPPED) return skip("budget");
        const root = r.stdout.trim();
        if (r.timedOut) skip("timeout");
        else if (r.code !== 0 || root === "" || r.truncated) skip("not-a-repo");
        else found.push({ cand, root });
      } catch {
        skip("error");
      }
    });

    const chosen = groupRepos(found, input.salt, input.detailSessions ?? new Map(), Math.max(0, Math.floor(o.maxRepos ?? 200)), skip);
    let done = 0;
    await pool(chosen, async (repo) => {
      try {
        const facts = await readRepo(repo);
        if (facts === STOPPED) return skip("budget");
        roots.set(repo.repoKey, repo.root);
        repos.push(facts);
      } catch {
        skip("error");
      }
      done++;
      try { input.onProgress?.(done, chosen.length); } catch { /* a caller's callback never fails repo signals */ }
    });
    return result(partial());
  } catch {
    return result(partial());
  }

  /** One repo's facts: identity, then its commits. */
  async function readRepo(repo: Repo): Promise<RepoFacts | typeof STOPPED> {
    const facts: RepoFacts = { repoKey: repo.repoKey, projectKeys: repo.projectKeys, identity: false, commits: [], commitsTruncated: false,
      fileLists: true, ...EMPTY_FACTS() };
    const id = await git(["config", "--get", "user.email"], repo.root);
    if (id === STOPPED) return STOPPED;
    const email = id.code === 0 ? id.stdout.trim() : "";
    if (email === "") return facts;
    facts.identity = true;

    // an older git would fetch a partial clone's missing trees to list paths (it has no GIT_NO_LAZY_FETCH): read it
    // without them. A partial clone says so by `extensions.partialClone` (older layouts) or its remote's `promisor`.
    let names = true;
    if (!atLeast(version, NO_LAZY_FETCH_SINCE)) {
      for (const key of PARTIAL_CLONE_KEYS) {
        const r = await git(["config", "--get", key], repo.root);
        if (r === STOPPED) return STOPPED;
        if (r.code === 0 && r.stdout.trim() !== "") names = false;
        if (!names) break;
      }
    }
    const logArgs = (withNames: boolean): string[] => [
      "log", "--all", "--no-merges", "--no-renames", "--date-order",
      ...(since === undefined ? [] : [`--since=${new Date(since).toISOString()}`]),
      `--max-count=${maxCommits}`, ...(withNames ? ["--name-only"] : []), LOG_FORMAT,
    ];
    let log = await git(logArgs(names), repo.root, timeoutMs, LOG_BYTES);
    if (log === STOPPED) return STOPPED;
    // with lazy fetch off, a partial clone that lacks trees cannot list paths (git fails): read it again without them
    if (names && log.code !== 0 && !log.timedOut && !log.truncated) {
      names = false;
      log = await git(logArgs(false), repo.root, timeoutMs, LOG_BYTES);
      if (log === STOPPED) return STOPPED;
    }
    facts.fileLists = names;
    if (log.timedOut) {
      skip("timeout");
      facts.commitsTruncated = true;
    }
    if (!log.truncated && !log.timedOut && log.code !== 0) return facts; // an empty repo, or a history git cannot read
    // a cut output's last record may be incomplete: it is left out
    const text = log.truncated || log.timedOut ? log.stdout.slice(0, Math.max(0, log.stdout.lastIndexOf("\x1e"))) : log.stdout;
    facts.commits = parseLog(text, { salt: input.salt, email, maxFiles });
    facts.commitsTruncated ||= log.truncated || logRecords(text) >= maxCommits;
    return facts;
  }
}
