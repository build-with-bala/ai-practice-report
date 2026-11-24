import { commitStream, LOG_ARGS, SINCE_AS_FILTER_SINCE, sinceArg, type ParsedCommit } from "./commits";
import { candidates, groupRepos, sameFolder, type Found, type Repo } from "./discover";
import { INSTRUCTION_FILES, MAX_FOLDER_FILES, MAX_REPO_FILE_BYTES, readRepoFiles, REPO_FILES, REPO_FOLDERS, SESSION_FOLDER_FILES } from "./files";
import path from "node:path";
import { OLDEST_GIT, resolveGit, runGit, type GitResult, type GitRunner } from "./run";
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
    "a repo is read only when the root git reports for a session folder's repo is that folder itself (a repo whose config names " +
      "another folder as its worktree is skipped), and git runs only in such a folder.",
    `allowlisted repo files, from the worktree the most detail sessions ran in, read in memory (at most ${MAX_REPO_FILE_BYTES / 1024} KiB each; ` +
      "larger ones count as present, unread) and reduced to kinds, check kinds, booleans and counts — their text is never kept: " +
      `${[...Object.values(INSTRUCTION_FILES).filter((p) => !p.endsWith("/")), ...REPO_FILES].join(", ")}; ` +
      `${SESSION_FOLDER_FILES.join(" and ")} also at each session folder inside the repo; and one level deep, at most ${MAX_FOLDER_FILES} files each, ` +
      `${REPO_FOLDERS.map((f) => `${f.dir} (${f.what})`).join(", ")}. ` +
      "Links are resolved in every path component first: a file is opened, or a folder listed, only when its real path lies inside " +
      "the worktree and is itself one of these paths there (so CLAUDE.md linked to AGENTS.md is read; a link to a source file or out " +
      "of the worktree is not). .claude/settings.local.json, source files and any other file are never opened; " +
      "a credential, token or key file name (or a link to one) is refused unopened. " +
      "What a path check cannot promise: a link swapped in between the check and the open is followed, and a hard link " +
      "to a file elsewhere, under an allowlisted name, is read.",
    "a .git file is taken as git takes it: one that names another repository's git folder makes that repository's history read " +
      "under the session's folder.",
    "git config: the system-level git config is ignored (GIT_CONFIG_NOSYSTEM); only user.email and, for a git older than 2.44, " +
      "the partial-clone keys are asked for.",
  ],
  runs: [
    "git --version",
    "git rev-parse --show-toplevel --git-common-dir",
    "git rev-parse --verify --quiet HEAD^{commit} (whether HEAD names a commit, before the instruction-file history)",
    "git config --get user.email",
    "git config --get extensions.partialClone, git config --get remote.origin.promisor (git older than 2.44 only)",
    "git log --no-use-mailmap --exclude=refs/stash --all --no-merges --no-renames --since-as-filter=<date> --max-count=<n> --name-only -z (commit metadata only)",
    "git log --no-use-mailmap -n50 --since-as-filter=<180 days ago> --format=%ct -- <instruction file paths> (commit times only; not for a partial clone read without paths)",
    "on a git older than 2.37, --since instead of --since-as-filter: there, a commit whose recorded date is older than the window " +
      "hides the ancestors no other branch reaches, so their commits are not read. --since-as-filter walks the whole history: on a " +
      "very large one without a commit-graph a log can end by its timeout, and the pass then reads as partial, with a cut list",
    `every argument is one git ${OLDEST_GIT.join(".")}, the oldest supported, accepts (--since-as-filter only from 2.37); ` +
      "an older git is not used (git-missing)",
    "every git command: started by its absolute path on PATH (never from the repo folder), with no stdin, no pager and no prompt; " +
      "no transport at all (-c protocol.allow=never, GIT_ALLOW_PROTOCOL=none) and GIT_NO_LAZY_FETCH=1, so nothing is " +
      "fetched whatever the repo config says; fsmonitor and signature checks off; log output in UTF-8; no .mailmap; no system config; " +
      "inherited GIT_* variables removed",
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

/** Commits newest first, then by `id`: the order every repo's list is returned in, whatever order git printed. */
const byNewest = (a: ParsedCommit, b: ParsedCommit): number => {
  const [x, y] = [a.fact.id ?? "", b.fact.id ?? ""];
  return b.fact.ts - a.fact.ts || (x < y ? -1 : x > y ? 1 : 0);
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

/** A numeric option: `v` when it is a finite number in [min, max] (rounded down), else the fixed default `def`. */
const option = (v: number | undefined, def: number, min: number, max: number): number =>
  v !== undefined && Number.isFinite(v) && v >= min && v <= max ? Math.floor(v) : def;

const isEnoent = (e: unknown): boolean => (e as { code?: unknown } | null)?.code === "ENOENT";

/**
 * Skip reasons that mean a read did not finish — a repo dropped, or its data cut, by a timeout, an error, the budget or
 * an abort: any of them makes the pass `partial`. The others (`missing`, `not-a-repo`, `root-mismatch`, `too-many-repos`,
 * the deliberate `file-*` refusals and caps) are what the rules leave out, and keep it `ok`.
 */
const UNFINISHED: readonly string[] = ["budget", "timeout", "error", "identity-error", "config-error", "log-error", "history-error", "files-error",
  "file-io-error"];

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
  const timeoutMs = option(o.timeoutMs, 10_000, 1, 600_000);
  const maxCommits = option(o.maxCommits, 5_000, 1, 10_000_000);
  const maxFiles = option(o.maxFiles, 200, 0, 100_000);
  const maxRepos = option(o.maxRepos, 200, 0, 100_000);
  const budgetMs = option(o.budgetMs, 20_000, 0, 3_600_000);
  const width = option(o.concurrency, DEFAULT_CONCURRENCY, 1, 64);
  const skipped: Record<string, number> = {};
  const skip = (reason: string, n = 1) => { if (n > 0) skipped[reason] = (skipped[reason] ?? 0) + n; };
  const roots = new Map<string, string>();
  const repos: RepoFacts[] = [];
  /** Each repo read, with its commits' full shas: memory only, for this pass. */
  const read: { repo: Repo; facts: RepoFacts; commits: ParsedCommit[] }[] = [];
  // the window start, only when it is a date in range (a NaN or far date would throw in `toISOString`): else none
  const from = input.detailFrom;
  const since = from !== undefined && Number.isFinite(from) && from - 3 * DAY_MS >= 0 && from <= input.now + DAY_MS ? from - 3 * DAY_MS : undefined;

  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(), budgetMs);
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
  const partial = () => (input.signal.aborted || budget.signal.aborted || UNFINISHED.some((k) => (skipped[k] ?? 0) > 0) ? "partial" : "ok");

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
    // the folders with the most detail-window sessions first, so the time budget goes to the repos that matter
    const sessionsOf = (keys: readonly string[]) => keys.reduce((n, k) => n + (input.detailSessions?.get(k) ?? 0), 0);
    const cands = candidates(input.cwds, input.recent, skip)
      .map((c) => ({ c, n: sessionsOf(c.projectKeys) }))
      .sort((a, b) => b.n - a.n || (a.c.dir < b.c.dir ? -1 : a.c.dir > b.c.dir ? 1 : 0))
      .map(({ c }) => c);
    if (cands.length === 0) return result("ok");
    exe = resolveGit(process.env);
    if (exe === undefined) return result("git-missing");

    // git itself: missing (ENOENT, a non-zero exit, a timeout, or no version in its answer), and its version. Asked
    // once per pass, in the root of git's own path — a folder that always exists, and no candidate's
    try {
      const v = await git(["--version"], path.parse(exe).root, timeoutMs);
      if (v === STOPPED) {
        skip("budget", cands.length);
        return result("partial");
      }
      version = v.code === 0 && !v.timedOut ? versionOf(v.stdout) : undefined;
      if (version === undefined) return result("git-missing");
      // a git older than the oldest supported may refuse an argument, or read differently: it is not used
      if (!atLeast(version, OLDEST_GIT)) {
        skip("git-too-old");
        return result("git-missing");
      }
    } catch (e) {
      if (isEnoent(e)) return result("git-missing");
      skip("error", cands.length);
      return result("partial");
    }

    // each candidate's root
    const found: Found[] = [];
    await pool(cands, async (cand) => {
      try {
        const r = await git(["rev-parse", "--show-toplevel", "--git-common-dir"], cand.dir, REV_PARSE_TIMEOUT_MS);
        if (r === STOPPED) return skip("budget");
        // exactly two lines (the root, the common dir), each ended by a newline: more means a newline inside a path,
        // which cannot be split back into the two
        const lines = r.stdout.split("\n");
        const [root = "", commonDir = ""] = lines.length === 3 && lines[2] === "" ? lines.map((l) => l.replace(/\r$/, "")) : [];
        if (r.timedOut) skip("timeout");
        else if (r.code !== 0 || r.truncated || lines.length < 3) skip("not-a-repo");
        else if (lines.length > 3 || lines[2] !== "") skip("root-mismatch");
        else if (root === "" || commonDir === "") skip("not-a-repo");
        // the root git reports is accepted only when it is the candidate folder itself: repo config (`core.worktree`)
        // may name any other folder, whose files would then be read as this repo's. Everything runs in the candidate.
        else if (!sameFolder(root, cand.dir)) skip("root-mismatch");
        else found.push({ cand, root: cand.dir, commonDir });
      } catch {
        skip("error");
      }
    });

    const chosen = groupRepos(found, input.salt, input.detailSessions ?? new Map(), maxRepos, skip);
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
        Object.assign(facts, await readRepoFiles(tree.root, cwds, { signal, runner: filesRunner, now: input.now, timeoutMs, skip, history: got.names,
          sinceAsFilter: atLeast(version, SINCE_AS_FILTER_SINCE) }));
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
    // git runs in a candidate folder (a worktree sessions ran in), never in a folder only git's answers named
    const cwd = repo.trees[0]?.root ?? repo.root;
    // an older git would fetch a partial clone's missing trees to list paths (it has no GIT_NO_LAZY_FETCH): read it
    // without them. A partial clone says so by `extensions.partialClone` (older layouts) or its remote's `promisor`.
    let names = true;
    if (!atLeast(version, NO_LAZY_FETCH_SINCE)) {
      for (const key of PARTIAL_CLONE_KEYS) {
        const r = await git(["config", "--get", key], cwd);
        if (r === STOPPED) return STOPPED;
        if (r.timedOut) skip("timeout");
        else if (r.code !== 0 && r.code !== 1) skip("config-error");
        // set, or not known to be unset: read without paths
        if ((r.code === 0 && r.stdout.trim() !== "") || r.timedOut || (r.code !== 0 && r.code !== 1)) names = false;
        if (!names) break;
      }
    }
    // the person's email: exit 1 is git's own answer for a key that is not set (no identity); any other failure is a
    // read that did not finish, counted
    const id = await git(["config", "--get", "user.email"], cwd);
    if (id === STOPPED) return STOPPED;
    if (id.timedOut || id.truncated || (id.code !== 0 && id.code !== 1)) {
      skip(id.timedOut ? "timeout" : "identity-error");
      return { commits: [], names };
    }
    const email = id.code === 0 ? id.stdout.trim() : "";
    if (email === "") return { commits: [], names };
    facts.identity = true;

    // no `--date-order`: with a window start it stops at the first commit older than the window, on every ref. The
    // window start is `--since-as-filter` where git has it; on an older git, `--since` (see `sinceArg`) still lets a
    // commit whose recorded date is older than the window hide the ancestors no other branch reaches.
    const logArgs = (withNames: boolean): string[] => [
      // `--exclude=refs/stash` before `--all`: a stash is no commit of the person's; `--no-use-mailmap`: the worktree's
      // `.mailmap` (a file anyone can commit, or a FIFO) is never opened (the shorter `--no-mailmap` needs git 2.27).
      // Each argument's oldest git: OLDEST_GIT. `--since-as-filter` walks the whole history (`sinceArg`)
      "log", "--no-use-mailmap", "--exclude=refs/stash", "--all", "--no-merges", "--no-renames",
      ...(since === undefined ? [] : [sinceArg(since, atLeast(version, SINCE_AS_FILTER_SINCE))]),
      `--max-count=${maxCommits}`, ...(withNames ? ["--name-only"] : []), ...LOG_ARGS,
    ];
    /**
     * One `git log`, parsed as it streams (`commitStream`): the output is never held whole. A runner that returns
     * `stdout` instead of streaming (tests) is parsed the same way.
     */
    const readLog = async (withNames: boolean) => {
      const parse = commitStream({ salt: input.salt, email, maxFiles });
      let streamed = false;
      const r = await git(logArgs(withNames), cwd, timeoutMs, LOG_BYTES, (chunk) => { streamed = true; parse.push(chunk); });
      if (r === STOPPED) return STOPPED;
      if (!streamed && r.stdout !== "") parse.push(new TextEncoder().encode(r.stdout));
      return { r, parse };
    };
    const history = names; // whether the instruction history may read paths, whatever the commit log below does
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
    const { commits, records, oldest } = parse.end(cut);
    // a log that failed (twice, when the first asked for paths): no commits, counted. An empty repo exits 0.
    if (!r.truncated && !r.timedOut && r.code !== 0) {
      skip("log-error");
      return { commits: [], names: history };
    }
    // git lists commits in no strict date order without `--date-order`: one stable order for every consumer
    commits.sort(byNewest);
    facts.commits = commits.map((c) => c.fact);
    facts.commitsTruncated ||= r.truncated || records >= maxCommits;
    // a cut list reaches back only to its oldest record read (any author's); with none read, to nothing before now
    if (facts.commitsTruncated) facts.commitsReach = oldest ?? input.now;
    return { commits, names };
  }
}
