import { commitStream, LOG_ARGS, type ParsedCommit } from "./commits";
import { candidates, groupRepos, type Found, type Repo } from "./discover";
import { INSTRUCTION_FILES, MAX_FOLDER_FILES, MAX_REPO_FILE_BYTES, readRepoFiles, REPO_FILES, REPO_FOLDERS, SESSION_FOLDER_FILES } from "./files";
import { resolveGit, runGit, type GitResult, type GitRunner } from "./run";
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
  /** Repos read at once (default 2). */
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
/**
 * Repos read at once by default. Each repo's `git log` streams through one record at a time, so the width bounds how many
 * records, chunks and git children are alive together; two keeps the pass's memory flat while git still overlaps.
 */
const DEFAULT_CONCURRENCY = 2;
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
    `allowlisted repo files, from the worktree the most detail sessions ran in, read in memory (at most ${MAX_REPO_FILE_BYTES / 1024} KiB each; ` +
      "larger ones count as present, unread) and reduced to kinds, check kinds, booleans and counts — their text is never kept: " +
      `${[...Object.values(INSTRUCTION_FILES).filter((p) => !p.endsWith("/")), ...REPO_FILES].join(", ")}; ` +
      `${SESSION_FOLDER_FILES.join(" and ")} also at each session folder inside the repo; and one level deep, at most ${MAX_FOLDER_FILES} files each, ` +
      `${REPO_FOLDERS.map((f) => `${f.dir} (${f.what})`).join(", ")}. ` +
      "Links are resolved in every path component first: a file is opened, or a folder listed, only when its real path lies inside " +
      "the worktree and is itself one of these paths there (so CLAUDE.md linked to AGENTS.md is read; a link to a source file or out " +
      "of the worktree is not). .claude/settings.local.json, source files and any other file are never opened; " +
      "a credential, token or key file name (or a link to one) is refused unopened.",
    "git config: the system-level git config is ignored (GIT_CONFIG_NOSYSTEM); only user.email and, for a git older than 2.44, " +
      "the partial-clone keys are asked for.",
  ],
  runs: [
    "git --version",
    "git rev-parse --show-toplevel --git-common-dir",
    "git config --get user.email",
    "git config --get extensions.partialClone, git config --get remote.origin.promisor (git older than 2.44 only)",
    "git log --all --no-merges --no-renames --date-order --since=<date> --max-count=<n> --name-only -z (commit metadata only)",
    "git log -n50 --since=<180 days ago> --format=%ct -- <instruction file paths> (commit times only; not for a partial clone read without paths)",
    "every git command: started by its absolute path on PATH (never from the repo folder), with no stdin, no pager and no prompt; " +
      "no transport at all (-c protocol.allow=never, GIT_ALLOW_PROTOCOL=none) and GIT_NO_LAZY_FETCH=1, so nothing is " +
      "fetched whatever the repo config says; fsmonitor and signature checks off; no system config; inherited GIT_* variables removed",
  ],
};

/**
 * One owner per commit: a commit several repos list (clones, forks, anything whose `log --all` shares it), compared by
 * its full sha, is the owner's in exactly one of them — the repo with the most detail-window sessions, then the smallest
 * repoKey. Every repo keeps its full list; the shas are held for this pass only.
 */
function assignOwners(read: readonly { repo: Repo; facts: RepoFacts; commits: readonly ParsedCommit[] }[]): void {
  const ranked = [...read].sort((a, b) => b.repo.sessions - a.repo.sessions || (a.repo.repoKey < b.repo.repoKey ? -1 : a.repo.repoKey > b.repo.repoKey ? 1 : 0));
  const owned = new Set<string>();
  for (const { commits } of ranked) {
    for (const c of commits) {
      c.fact.owner = !owned.has(c.sha);
      owned.add(c.sha);
    }
  }
}

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
  const width = Math.max(1, Math.floor(o.concurrency ?? DEFAULT_CONCURRENCY));
  const skipped: Record<string, number> = {};
  const skip = (reason: string, n = 1) => { if (n > 0) skipped[reason] = (skipped[reason] ?? 0) + n; };
  const roots = new Map<string, string>();
  const repos: RepoFacts[] = [];
  /** Each repo read, with its commits' full shas: memory only, for this pass. */
  const read: { repo: Repo; facts: RepoFacts; commits: ParsedCommit[] }[] = [];
  const since = input.detailFrom === undefined ? undefined : input.detailFrom - 3 * DAY_MS;

  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(), Math.max(0, o.budgetMs ?? 20_000));
  const signal = AbortSignal.any([input.signal, budget.signal]);
  const stopped = new Promise<typeof STOPPED>((resolve) => {
    if (signal.aborted) resolve(STOPPED);
    else signal.addEventListener("abort", () => resolve(STOPPED), { once: true });
  });
  /**
   * One git command; STOPPED when the budget or an abort came first (the runner kills its child on the same signal).
   * `onChunk`: the output streams to it instead of coming back whole (`GitRunner`).
   */
  const git = async (args: readonly string[], cwd: string, ms = timeoutMs, maxBytes = SMALL_BYTES,
    onChunk?: (chunk: Uint8Array) => void): Promise<GitResult | typeof STOPPED> => {
    if (signal.aborted) return STOPPED;
    return Promise.race([runner(args, { cwd, timeoutMs: ms, maxBytes, signal, git: exe, ...(onChunk ? { onChunk } : {}) }), stopped]);
  };
  // every return goes through here: a shared commit is owned once whatever path the pass ends by (done, stopped, thrown)
  const result = (status: RepoSignals["status"]): RepoSignals => {
    clearTimeout(timer);
    assignOwners(read);
    // repos finish in any order when several are read at once: the result lists them by repoKey
    repos.sort((a, b) => (a.repoKey < b.repoKey ? -1 : a.repoKey > b.repoKey ? 1 : 0));
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
  let exe: string | undefined; // git's absolute path, found once per pass
  try {
    const cands = candidates(input.cwds, input.recent, skip);
    if (cands.length === 0) return result("ok");
    exe = resolveGit(process.env);
    if (exe === undefined) return result("git-missing");

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
    const found: Found[] = [];
    await pool(cands, async (cand) => {
      try {
        const r = await git(["rev-parse", "--show-toplevel", "--git-common-dir"], cand.dir, REV_PARSE_TIMEOUT_MS);
        if (r === STOPPED) return skip("budget");
        const [root = "", commonDir = ""] = r.stdout.split("\n").map((l) => l.replace(/\r$/, ""));
        if (r.timedOut) skip("timeout");
        else if (r.code !== 0 || root === "" || commonDir === "" || r.truncated) skip("not-a-repo");
        else found.push({ cand, root, commonDir });
      } catch {
        skip("error");
      }
    });

    const chosen = groupRepos(found, input.salt, input.detailSessions ?? new Map(), Math.max(0, Math.floor(o.maxRepos ?? 200)), skip);
    let done = 0;
    await pool(chosen, async (repo) => {
      try {
        const got = await readRepo(repo);
        if (got === STOPPED) return skip("budget");
        roots.set(repo.repoKey, repo.root);
        repos.push(got.facts);
        read.push({ repo, ...got });
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

  /** One repo's facts: its commits (with an identity), then its allowlisted files. */
  async function readRepo(repo: Repo): Promise<{ facts: RepoFacts; commits: ParsedCommit[] } | typeof STOPPED> {
    const facts: RepoFacts = { repoKey: repo.repoKey, projectKeys: repo.projectKeys, identity: false, commits: [], commitsTruncated: false,
      fileLists: true, ...EMPTY_FACTS() };
    const got = await readCommits(repo, facts);
    if (got === STOPPED) return STOPPED;
    // the files of the worktree the most detail sessions ran in, never the common dir's parent: a `.git` may be a link to
    // a store elsewhere, and each linked worktree holds its own files
    const tree = repo.trees[0];
    // the files pass on its own: whatever it throws, the repo keeps its commit facts (its file facts stay empty)
    if (tree !== undefined) {
      try {
        const cwds = tree.projectKeys.map((k) => input.cwds.get(k)).filter((c): c is string => c !== undefined);
        const filesRunner: GitRunner = async (args, ro) => {
          const r = await git(args, ro.cwd, ro.timeoutMs, ro.maxBytes);
          return r === STOPPED ? { code: null, stdout: "", timedOut: false, truncated: false } : r;
        };
        Object.assign(facts, await readRepoFiles(tree.root, cwds, { signal, runner: filesRunner, now: input.now, timeoutMs, skip, history: got.names }));
      } catch {
        Object.assign(facts, EMPTY_FACTS());
        skip("files-error");
      }
    }
    return { facts, commits: got.commits };
  }

  /**
   * One repo's identity, then its commits, into `facts`. `names`: whether git may read the history by path (false for a
   * partial clone that cannot list paths without fetching).
   */
  async function readCommits(repo: Repo, facts: RepoFacts): Promise<{ commits: ParsedCommit[]; names: boolean } | typeof STOPPED> {
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
    const id = await git(["config", "--get", "user.email"], repo.root);
    if (id === STOPPED) return STOPPED;
    const email = id.code === 0 ? id.stdout.trim() : "";
    if (email === "") return { commits: [], names };
    facts.identity = true;

    const logArgs = (withNames: boolean): string[] => [
      "log", "--all", "--no-merges", "--no-renames", "--date-order",
      ...(since === undefined ? [] : [`--since=${new Date(since).toISOString()}`]),
      `--max-count=${maxCommits}`, ...(withNames ? ["--name-only"] : []), ...LOG_ARGS,
    ];
    /**
     * One `git log`, parsed as it streams (`commitStream`): the output is never held whole. A runner that returns
     * `stdout` instead of streaming (tests) is parsed the same way.
     */
    const readLog = async (withNames: boolean) => {
      const parse = commitStream({ salt: input.salt, email, maxFiles });
      let streamed = false;
      const r = await git(logArgs(withNames), repo.root, timeoutMs, LOG_BYTES, (chunk) => { streamed = true; parse.push(chunk); });
      if (r === STOPPED) return STOPPED;
      if (!streamed && r.stdout !== "") parse.push(new TextEncoder().encode(r.stdout));
      return { r, parse };
    };
    let log = await readLog(names);
    if (log === STOPPED) return STOPPED;
    // with lazy fetch off, a partial clone that lacks trees cannot list paths (git fails): read it again without them
    if (names && log.r.code !== 0 && !log.r.timedOut && !log.r.truncated) {
      names = false;
      log = await readLog(false);
      if (log === STOPPED) return STOPPED;
    }
    facts.fileLists = names;
    const { r, parse } = log;
    if (r.timedOut) {
      skip("timeout");
      facts.commitsTruncated = true;
    }
    // a cut output's last record may be incomplete: it is left out
    const cut = r.truncated || r.timedOut;
    const { commits, records } = parse.end(cut);
    if (!r.truncated && !r.timedOut && r.code !== 0) return { commits: [], names }; // an empty repo, or a history git cannot read
    facts.commits = commits.map((c) => c.fact);
    facts.commitsTruncated ||= r.truncated || records >= maxCommits;
    return { commits, names };
  }
}
