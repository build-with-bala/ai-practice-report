import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { collectRepoSignals } from "../../../core/git/index";
import { gitRunnerWithEnv, runGit, type GitRunner } from "../../../core/git/run";
import type { Ev } from "../../../core/model/events";
import { scan, type ScanOptions } from "../../../core/scan";
import type { Candidate, SourcePlugin } from "../../../core/sources/types";
import { keyedHash } from "../../../core/text/hash";
import { CANARY, expectNoCanaries } from "../../kit/canary";
import { fakeHome, type FakeHome } from "../../kit/home";
import { git, gitVersion, isolateGitHome, makeRepo } from "../../fixtures/repos";

const POSIX = process.platform !== "win32";
const DAY = 86_400_000;
const GIT_44 = (([a, b]) => a > 2 || (a === 2 && b >= 44))(gitVersion());
/** git 2.37 has `--since-as-filter`: an old-dated commit then hides nothing below it. */
const GIT_37 = (([a, b]) => a > 2 || (a === 2 && b >= 37))(gitVersion());
/** A commit made at `at` (author and committer date) in `dir`, by the fixture's person. */
const commitAt = (dir: string, message: string, at: number) => {
  const date = new Date(at).toISOString();
  git(dir, ["-c", "user.email=dev@fixture.test", "-c", "user.name=Fixture Dev", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", message],
    { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
};

let h: FakeHome;
let restoreHome: () => void = () => {};
beforeEach(() => { h = fakeHome(); restoreHome = isolateGitHome(path.join(h.root, "home")); });
afterEach(() => { restoreHome(); h.cleanup(); });

/** A plugin that reports one detail-window session per folder, in the last few days, each in its own project. */
function sessions(folders: string[]): SourcePlugin {
  return {
    tool: "codex", id: "fake-sessions", tier: "P0", beta: false, describe: { reads: [], neverReads: [] },
    locate: (): Candidate[] => [{ root: h.root, home: h.root, wsl: false }],
    scan: async (_c, ctx) => {
      folders.forEach((dir, i) => {
        const ev: Ev = { k: "session", tool: "codex", source: "fake-sessions", id: `codex:s${i}`, window: "detail", origin: "human",
          start: ctx.now - 10 * DAY, end: ctx.now - 9 * DAY, models: [], projectKey: ctx.registerCwd(dir) };
        ctx.emit(ev);
      });
      ctx.emit({ k: "coverage", tool: "codex", source: "fake-sessions", window: "detail", status: "ok", files: 1, bytes: 1, records: folders.length,
        skipped: {}, unknownTypes: {}, versions: [] });
    },
  };
}

const run = (folders: string[], o: Partial<ScanOptions> = {}) => scan({ env: h.env, plugins: [sessions(folders)], handleSignals: false, ...o });
const ago = (days: number) => Date.now() - days * DAY;

/** Repo 1: at a path naming the canary project, with files named after it and messages holding the canary prompt. */
function repo1(): string {
  return makeRepo(path.join(h.root, "work", CANARY.project), [
    { files: { [`${CANARY.project}.ts`]: "a" }, message: `feat: ${CANARY.prompt}\n\nCo-authored-by: Pat <${CANARY.email}>\nCo-authored-by: Claude <noreply@anthropic.com>`, at: ago(5) },
    { files: { [`${CANARY.project}.ts`]: "b" }, message: `fix(core): ${CANARY.prompt}\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`, at: ago(4) },
    { files: { "theirs.ts": "c" }, message: `feat: ${CANARY.prompt} theirs`, at: ago(3), email: CANARY.email },
    { files: { [`${CANARY.project}.ts`]: "d" }, message: `Revert "feat: ${CANARY.prompt}"`, at: ago(2) },
  ]);
}

/** Repo 2: at a path with a space and non-ASCII letters. */
const repo2Dir = () => path.join(h.root, "dir with space", "ünï");
const repo2 = (config: Record<string, string> = {}) =>
  makeRepo(repo2Dir(), [{ files: { "a.md": "x" }, message: "docs: one", at: ago(3) }, { files: { "b.md": "y" }, message: "docs: two", at: ago(2) }], { config });

/** A script that touches `marker` whenever it runs, and answers a signing request as gpg would. */
function touchScript(name: string, marker: string): string {
  const p = path.join(h.root, "bin", name);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, `#!/bin/sh\ntouch '${marker}'\nprintf '\\n[GNUPG:] SIG_CREATED D 1 8 00 0 X\\n' >&2\nprintf -- '-----BEGIN PGP SIGNATURE-----\\n\\nZmFrZQ==\\n-----END PGP SIGNATURE-----\\n'\n`);
  chmodSync(p, 0o755);
  return p;
}

/** A runner that succeeds at everything, answering `--version` as a current git would and everything else with nothing. */
const ok = (): GitRunner => async (a) => ({ code: 0, stdout: a[0] === "--version" ? "git version 2.51.0\n" : "", timedOut: false, truncated: false });

describe("repo signals: discovery from session folders and commits as keyed facts", () => {
  test("two repos from five folders; own commits only, with their trailers; no canary leaves; roots stay in memory", async () => {
    const r1 = repo1();
    const sub = path.join(r1, "pkg");
    mkdirSync(sub);
    const r2 = repo2();
    const plain = path.join(h.root, "plain");
    mkdirSync(plain);
    const progress: number[][] = [];
    const r = await run([r1, sub, r2, plain, path.join(h.root, "gone")], {
      onProgress: (p) => { if (p.plugin === "repo-signals") progress.push([p.done, p.total]); },
    });

    expect(r.repos.status).toBe("ok");
    expect(r.repos.repos).toHaveLength(2);
    expect(r.repos.skipped).toEqual({ "not-a-repo": 1, missing: 1 });
    expect(progress).toEqual([[1, 2], [2, 2]]);
    const k1 = r.store.all("session").filter((s) => s.id === "codex:s0" || s.id === "codex:s1").map((s) => s.projectKey!).sort();
    const one = r.repos.repos.find((x) => x.projectKeys.length === 2)!;
    expect(one.projectKeys).toEqual(k1);
    expect(one).toMatchObject({ identity: true, commitsTruncated: false, fileLists: true });
    // own commits only (the co-author's is left out), newest first
    expect(one.commits.map((c) => [c.ai, c.generated, c.rework])).toEqual([[undefined, undefined, "revert"], [undefined, "claude", "fix"], ["claude", undefined, undefined]]);
    expect(one.commits[0]!.files).toEqual([keyedHash(r.salt, `${CANARY.project}.ts`)]);
    const sha = git(r1, ["rev-parse", "HEAD"]);
    expect(one.commits[0]!.shaKey).toBe(keyedHash(r.salt, sha.slice(0, 7)));
    expect(r.repos.since).toBeLessThanOrEqual(ago(12));
    // repo 2, at a path with a space and non-ASCII letters, is read like any other
    const two = r.repos.repos.find((x) => x !== one)!;
    expect(two.commits).toHaveLength(2);

    expectNoCanaries(r.repos.repos);
    expectNoCanaries({ ...r.repos, roots: undefined });
    expect([...r.repos.roots.values()].some((root) => root.includes(CANARY.project))).toBe(true);
    expect(r.repos.roots.get(one.repoKey)).toContain(CANARY.project);
  });

  test.skipIf(!POSIX)("repo config that would run programs runs none: log.showSignature + gpg.program, core.fsmonitor (POSIX)", async () => {
    const r2 = repo2();
    const gpgMarker = path.join(h.root, "gpg-ran");
    const fsmMarker = path.join(h.root, "fsmonitor-ran");
    const gpg = touchScript("fake-gpg", gpgMarker);
    const fsm = touchScript("fake-fsmonitor", fsmMarker);
    git(r2, ["-c", `gpg.program=${gpg}`, "commit", "-q", "-S", "--allow-empty", "-m", "signed"]);
    for (const [k, v] of [["log.showSignature", "true"], ["gpg.program", gpg], ["core.fsmonitor", fsm]]) git(r2, ["config", k, v!]);
    // the settings are live: git run plainly does run them
    git(r2, ["log", "-1"]);
    git(r2, ["status"]);
    expect([existsSync(gpgMarker), existsSync(fsmMarker)]).toEqual([true, true]);
    rmSync(gpgMarker);
    rmSync(fsmMarker);

    const r = await run([r2]);
    expect(r.repos.status).toBe("ok");
    expect(r.repos.repos[0]!.commits).toHaveLength(3);
    expect([existsSync(gpgMarker), existsSync(fsmMarker)]).toEqual([false, false]);
  });

  test.skipIf(!GIT_44)("a partial clone fetches nothing it lacks, and is still listed (git >= 2.44)", async () => {
    const src = makeRepo(path.join(h.root, "src"), [1, 2, 3].map((i) => ({ files: { [`d${i}/f.txt`]: `${i}` }, message: `c${i}`, at: ago(5 - i) })),
      { config: { "uploadpack.allowFilter": "true" } });
    const url = `file://${src.startsWith("/") ? "" : "/"}${src.replace(/\\/g, "/")}`;
    const clone = path.join(h.root, "clone");
    git(h.root, ["clone", "-q", "--filter=tree:0", url, clone]);
    git(clone, ["config", "user.email", "dev@fixture.test"]);
    const objects = () => git(clone, ["count-objects", "-v"]).split("\n").filter((l) => /^(count|in-pack):/.test(l)).join(",");
    const before = objects();
    const r = await run([clone]);
    expect(objects()).toBe(before);
    expect(r.repos.repos).toHaveLength(1);
    // the clone lacks the older trees, so it is read without paths
    expect(r.repos.repos[0]).toMatchObject({ identity: true, fileLists: false });
    expect(r.repos.repos[0]!.commits).toHaveLength(3);

    // a git older than 2.44 (no GIT_NO_LAZY_FETCH) never asks a partial clone for paths
    const asked: string[][] = [];
    const old: GitRunner = async (a, o) => {
      asked.push([...a]);
      return a[0] === "--version" ? { code: 0, stdout: "git version 2.40.1\n", timedOut: false, truncated: false } : runGit(a, o);
    };
    const r2 = await run([clone], { repoSignals: { runner: old } });
    expect(objects()).toBe(before);
    expect(r2.repos.repos[0]).toMatchObject({ fileLists: false });
    expect(r2.repos.repos[0]!.commits).toHaveLength(3);
    expect(asked.filter((a) => a[0] === "log").map((a) => a.includes("--name-only"))).toEqual([false]);
  });

  test("a long history read with maxCommits 5 keeps 5 commits and is marked truncated", async () => {
    const r3 = makeRepo(path.join(h.root, "long"), Array.from({ length: 8 }, (_, i) => ({ files: { "n.txt": `${i}` }, message: `c${i}`, at: ago(8 - i * 0.5) })));
    const r = await run([r3], { repoSignals: { maxCommits: 5 } });
    expect(r.repos.repos[0]!.commits).toHaveLength(5);
    expect(r.repos.repos[0]!.commitsTruncated).toBe(true);
  });

  describe("a cut commit list says how far back it reaches", () => {
    const eight = () => makeRepo(path.join(h.root, "reach"), Array.from({ length: 8 }, (_, i) => ({ files: { "n.txt": `${i}` }, message: `c${i}`, at: ago(8 - i * 0.5) })));
    /** The main commit log (`--all`) through `change`, every other command as it is. */
    const onLog = (change: (a: readonly string[], o: Parameters<GitRunner>[1]) => ReturnType<GitRunner>): GitRunner =>
      (a, o) => (a[0] === "log" && a.includes("--all") ? change(a, o) : runGit(a, o));

    test("the commit cap: commitsReach is the oldest commit time read", async () => {
      const r = await run([eight()], { repoSignals: { maxCommits: 5 } });
      const repo = r.repos.repos[0]!;
      expect(repo.commitsTruncated).toBe(true);
      expect(repo.commitsReach).toBe(Math.min(...repo.commits.map((c) => c.ts)));
    });

    test("the output cap: commitsReach is the oldest commit time of the records kept", async () => {
      const dir = eight();
      const full = await runGit(["log", "--all", "--name-only", "-z", "--format=%x00%x1e%H%x1f%ct%x1f%ae%n%B"], { cwd: dir, timeoutMs: 10_000, maxBytes: 1 << 20, signal: new AbortController().signal });
      const r = await run([dir], { repoSignals: { runner: onLog((a, o) => runGit(a, { ...o, maxBytes: Math.floor(full.stdout.length / 2) })) } });
      const repo = r.repos.repos[0]!;
      expect(repo.commitsTruncated).toBe(true);
      expect(repo.commits.length).toBeGreaterThan(0);
      expect(repo.commits.length).toBeLessThan(8);
      expect(repo.commitsReach).toBe(Math.min(...repo.commits.map((c) => c.ts)));
    });

    test("a timeout that ended the log: commitsReach is set", async () => {
      const r = await run([eight()], { repoSignals: { runner: onLog(async (a, o) => ({ ...(await runGit(a, o)), code: null, timedOut: true })) } });
      const repo = r.repos.repos[0]!;
      expect(repo.commitsTruncated).toBe(true);
      expect(repo.commits).toHaveLength(7); // the last record of a cut output is left out
      expect(repo.commitsReach).toBe(Math.min(...repo.commits.map((c) => c.ts)));
    });

    test("a complete list: no commitsReach", async () => {
      const r = await run([eight()]);
      expect(r.repos.repos[0]!.commitsTruncated).toBe(false);
      expect(r.repos.repos[0]!.commitsReach).toBeUndefined();
    });
  });

  test("a repo without user.email: no identity, no commits read", async () => {
    const r4 = makeRepo(path.join(h.root, "anon"), [{ files: { "a.txt": "a" }, message: "one", at: ago(2) }], { email: "" });
    const seen: string[] = [];
    // no global config either: every test here runs with a home of its own
    const r = await run([r4], { repoSignals: { runner: (a, o) => { seen.push(a.join(" ")); return runGit(a, o); } } });
    expect(r.repos.repos[0]).toMatchObject({ identity: false, commits: [] });
    // no commit log: only the instruction-file history (commit times by any author, Task 3) runs `log`
    expect(seen.filter((c) => c.startsWith("log ")).map((c) => c.split(" ").slice(0, 3).join(" "))).toEqual(["log --no-mailmap -n50"]);
  });
});

describe("repo signals: an old-dated commit hides no history", () => {
  test.skipIf(!GIT_37)("one commit dated years back on another branch, on top of recent ones: every recent commit is read (git >= 2.37)", async () => {
    const r1 = makeRepo(path.join(h.root, "dated"), [1, 2, 3, 4, 5, 6].map((i) => ({ files: { "n.txt": `${i}` }, message: `c${i}`, at: ago(7 - i) })));
    git(r1, ["checkout", "-q", "-b", "skewed"]);
    commitAt(r1, "a commit whose clock was years off", Date.UTC(2015, 0, 1));
    git(r1, ["checkout", "-q", "main"]);
    const r = await run([r1]);
    expect(r.repos.status).toBe("ok");
    expect(r.repos.repos[0]!.commits).toHaveLength(6);
    expect(r.repos.repos[0]!.commitsTruncated).toBe(false);
  });

  test.skipIf(!GIT_37)("a rebase that keeps the author dates of a year-old branch hides none of the recent commits below it (git >= 2.37)", async () => {
    const r1 = makeRepo(path.join(h.root, "rebased"), [1, 2, 3, 4, 5].map((i) => ({ files: { "n.txt": `${i}` }, message: `c${i}`, at: ago(6 - i) })));
    git(r1, ["checkout", "-q", "-b", "topic"]);
    // the topic's tip as a date-keeping rebase leaves it: committed with an old date on top of today's main
    commitAt(r1, "topic work from last year", ago(400));
    const r = await run([r1]);
    expect(r.repos.repos[0]!.commits).toHaveLength(5);
  });
});

describe("repo signals: the log reads commits only, whatever the repo holds", () => {
  test("a stash is not read as commits", async () => {
    const r1 = makeRepo(path.join(h.root, "stashed"), [{ files: { "a.txt": "a" }, message: "one", at: ago(2) }]);
    writeFileSync(path.join(r1, "a.txt"), "changed");
    writeFileSync(path.join(r1, "new.txt"), "untracked");
    git(r1, ["-c", "user.email=dev@fixture.test", "-c", "user.name=Fixture Dev", "stash", "-q", "-u"]);
    const r = await run([r1]);
    expect(r.repos.repos[0]!.commits).toHaveLength(1);
  });

  test("an output encoding set in repo config changes nothing: every commit is still read", async () => {
    const r1 = makeRepo(path.join(h.root, "enc"), [1, 2].map((i) => ({ files: { "a.txt": `${i}` }, message: `c${i} ünï`, at: ago(3 - i) })),
      { config: { "i18n.logOutputEncoding": "UTF-16LE" } });
    const r = await run([r1]);
    expect(r.repos.repos[0]!.commits).toHaveLength(2);
  });

  test.skipIf(!POSIX)("a FIFO as .mailmap is never opened: the logs do not stall (POSIX)", async () => {
    const r1 = makeRepo(path.join(h.root, "mailmap"), [{ files: { "CLAUDE.md": "x" }, message: "one", at: ago(2) }]);
    if (Bun.spawnSync(["mkfifo", path.join(r1, ".mailmap")]).exitCode !== 0) throw new Error("mkfifo failed");
    const r = await run([r1], { repoSignals: { timeoutMs: 3_000 } });
    expect(r.repos).toMatchObject({ status: "ok", skipped: {} });
    expect(r.repos.repos[0]).toMatchObject({ instructions: { touched: 1 } });
    expect(r.repos.repos[0]!.commits).toHaveLength(1);
  }, 30_000);
});

describe("repo signals: the window start by git version", () => {
  test("git 2.37 or later filters by --since-as-filter, an older git by --since; never --date-order", async () => {
    const r1 = makeRepo(path.join(h.root, "v"), [{ files: { "CLAUDE.md": "x" }, message: "one", at: ago(2) }]);
    const asked = async (version: string) => {
      const logs: string[][] = [];
      const runner: GitRunner = async (a, o) => {
        if (a[0] === "--version") return { code: 0, stdout: `git version ${version}\n`, timedOut: false, truncated: false };
        if (a[0] === "log") logs.push([...a]);
        return runGit(a, o);
      };
      await run([r1], { repoSignals: { runner } });
      return logs.map((a) => a.filter((x) => /^--(since|date-order)/.test(x)).map((x) => x.replace(/=.*/, "")));
    };
    expect(await asked("2.37.0")).toEqual([["--since-as-filter"], ["--since-as-filter"]]);
    expect(await asked("2.36.9")).toEqual([["--since"], ["--since"]]);
  });
});

describe("repo signals: one repo, one count; hostile repos", () => {
  test("two linked worktrees of one repo are one repo, its commits counted once", async () => {
    const main = makeRepo(path.join(h.root, "main"), [{ files: { "a.txt": "a" }, message: "one", at: ago(4) }]);
    const wt = path.join(h.root, "wt");
    git(main, ["worktree", "add", "-q", "-b", "side", wt]);
    const date = new Date(ago(3)).toISOString();
    git(wt, ["-c", "user.email=dev@fixture.test", "-c", "user.name=Fixture Dev", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "two"],
      { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    const r = await run([main, wt]);
    expect(r.repos.repos).toHaveLength(1);
    expect(r.repos.repos[0]!.projectKeys).toHaveLength(2);
    expect(r.repos.repos[0]!.commits).toHaveLength(2);
  });

  test("two clones of one repo: both list every commit; each is the owner's in one — most detail sessions, then smallest key", async () => {
    const a = makeRepo(path.join(h.root, "a"), [1, 2, 3].map((i) => ({ files: { "n.txt": `${i}` }, message: `c${i}`, at: ago(5 - i) })));
    const b = path.join(h.root, "b");
    git(h.root, ["clone", "-q", a, b]);
    git(b, ["config", "user.email", "dev@fixture.test"]);
    mkdirSync(path.join(a, "sub"));
    mkdirSync(path.join(b, "sub"));
    const salt = new Uint8Array(32).fill(3);
    const owners = (r: Awaited<ReturnType<typeof run>>) => r.repos.repos.map((x) => [x.repoKey, x.commits.length, x.commits.filter((c) => c.owner).length]).sort();

    // a tie in sessions: the smaller key owns; both list all 3
    const t = await run([a, b], { salt });
    const [small, large] = t.repos.repos.map((x) => x.repoKey).sort();
    expect(owners(t)).toEqual([[small, 3, 3], [large, 3, 0]]);

    // the larger-key clone has more sessions: it owns
    const largeDir = t.repos.roots.get(large!)!;
    const largeIsB = path.basename(largeDir) === "b";
    const r = await run(largeIsB ? [a, b, path.join(b, "sub")] : [a, path.join(a, "sub"), b], { salt });
    expect(owners(r)).toEqual([[small, 3, 0], [large, 3, 3]]);

    // a pass that ends partial (aborted once both were read) still owns each shared commit once
    const ac = new AbortController();
    const p = await run([a, b], { salt, signal: ac.signal, onProgress: (x) => { if (x.plugin === "repo-signals" && x.done === x.total) ac.abort(); } });
    expect(p.repos.status).toBe("partial");
    expect(owners(p)).toEqual([[small, 3, 3], [large, 3, 0]]);
  });

  test("a commit has one id in every clone (a keyed hash of its full sha, never the sha), and is mine in each", async () => {
    const a = makeRepo(path.join(h.root, "a"), [1, 2, 3].map((i) => ({ files: { "n.txt": `${i}` }, message: `c${i}`, at: ago(5 - i) })));
    const b = path.join(h.root, "b");
    git(h.root, ["clone", "-q", a, b]);
    git(b, ["config", "user.email", "dev@fixture.test"]);
    const r = await run([a, b]);
    const [x, y] = r.repos.repos;
    const ids = (repo: typeof x) => repo!.commits.map((c) => c.id);
    expect(ids(x)).toHaveLength(3);
    expect(ids(x)).toEqual(ids(y));
    expect(x!.commits.every((c) => /^[0-9a-f]{16}$/.test(c.id ?? "")) && [x, y].every((repo) => repo!.commits.every((c) => c.mine))).toBe(true);
    const shas = git(a, ["log", "--format=%H"]).split("\n");
    expect(ids(x).map((id) => shas.some((sha) => id === sha || sha.includes(id!) || id!.includes(sha.slice(0, 7))))).toEqual([false, false, false]);
    expect(new Set(ids(x)).size).toBe(3);
    expect(ids(x).sort()).toEqual(shas.map((sha) => keyedHash(r.salt, sha)).sort());
  });

  test.skipIf(!POSIX)("a changed file named like a log record is a path, never a record (POSIX)", async () => {
    const hostile = `\x1e${"d".repeat(40)}\x1f1700000001\x1fdev@fixture.test\nCo-authored-by: Claude <noreply@anthropic.com>`;
    // "\x01a" sorts first, so the hostile name is not the first path (which git puts after a newline)
    const r6 = makeRepo(path.join(h.root, "paths"), [{ files: { "\x01a": "a", [hostile]: "x" }, message: "feat: one", at: ago(2) }]);
    const r = await run([r6]);
    const commits = r.repos.repos[0]!.commits;
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({ shaKey: keyedHash(r.salt, git(r6, ["rev-parse", "HEAD"]).slice(0, 7)), owner: true });
    expect(commits[0]!.ai).toBeUndefined();
    expect(commits[0]!.files).toHaveLength(2);
  });

  test("a commit with a message of a million blank lines does not block the pass: read, its closing line found", async () => {
    const r1 = makeRepo(path.join(h.root, "long-message"), [{ files: { "a.txt": "a" }, message: "one", at: ago(3) }]);
    const msg = path.join(h.root, "msg.txt");
    writeFileSync(msg, `feat: long\n${"\n".repeat(1_000_000)}Generated with [Claude Code]\n`);
    const date = new Date(ago(2)).toISOString();
    git(r1, ["-c", "user.email=dev@fixture.test", "-c", "user.name=Fixture Dev", "-c", "commit.gpgsign=false", "-c", "commit.cleanup=verbatim",
      "commit", "-q", "--allow-empty", "-F", msg], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    const r = await run([r1]);
    expect(r.repos.status).toBe("ok");
    expect(r.repos.repos[0]!.commits.map((c) => c.generated)).toEqual(["claude", undefined]);
  }, 30_000);

  test("a \\x1e in a real commit message neither drops the commit nor forges one", async () => {
    const forged = `\x1e${"f".repeat(40)}\x1f1\x1fdev@fixture.test\nforged`;
    const r5 = makeRepo(path.join(h.root, "odd"), [
      { files: { "a.txt": "a" }, message: `feat: ${forged}`, at: ago(3) },
      { files: { "b.txt": "b" }, message: "fix: next", at: ago(2) },
    ]);
    const r = await run([r5]);
    expect(r.repos.repos[0]!.commits.map((c) => [c.rework, c.files.length])).toEqual([["fix", 1], [undefined, 1]]);
  });

  test("git on a relative PATH entry or in the repo folder never runs (git.exe/git.cmd on Windows, git elsewhere)", async () => {
    const r1 = repo1();
    const marker = path.join(h.root, "planted-ran");
    if (process.platform === "win32") {
      writeFileSync(path.join(r1, "git.cmd"), `@echo off\r\necho x > "${marker}"\r\n`);
      writeFileSync(path.join(r1, "git.exe"), "MZ not a program");
    } else {
      writeFileSync(path.join(r1, "git"), `#!/bin/sh\ntouch '${marker}'\n`);
      chmodSync(path.join(r1, "git"), 0o755);
    }
    const saved = process.env.PATH;
    process.env.PATH = `.${path.delimiter}${saved ?? ""}`;
    let r: Awaited<ReturnType<typeof run>>;
    try {
      r = await run([r1]);
    } finally {
      process.env.PATH = saved;
    }
    expect(existsSync(marker)).toBe(false);
    expect(r.repos.status).toBe("ok");
    expect(r.repos.repos[0]!.commits).toHaveLength(3); // the real git read it
  });

  test.skipIf(!POSIX)("a git too old for GIT_NO_LAZY_FETCH still fetches nothing: a non-origin promisor remote with an ext:: URL runs no command (POSIX)", async () => {
    const src = makeRepo(path.join(h.root, "src"), [1, 2, 3].map((i) => ({ files: { [`d${i}/f.txt`]: `${i}` }, message: `c${i}`, at: ago(5 - i) })),
      { config: { "uploadpack.allowFilter": "true" } });
    const clone = path.join(h.root, "clone");
    git(h.root, ["clone", "-q", "--filter=tree:0", `file://${src}`, clone]);
    git(clone, ["remote", "rename", "origin", "evil"]);
    const marker = path.join(h.root, "ext-ran");
    git(clone, ["config", "remote.evil.url", `ext::sh -c touch% ${marker}`]);
    git(clone, ["config", "protocol.ext.allow", "always"]);
    git(clone, ["config", "user.email", "dev@fixture.test"]);
    // the trap is live: git with lazy fetch on runs the remote's command
    try { git(clone, ["log", "--all", "--name-only", "--format=%H"]); } catch { /* the fetch itself fails */ }
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    const oldGit = gitRunnerWithEnv((env) => {
      const { GIT_NO_LAZY_FETCH: _drop, ...rest } = env;
      return rest;
    });
    const direct = await oldGit(["log", "--all", "--name-only", "--format=%H"], { cwd: clone, timeoutMs: 10_000, maxBytes: 1 << 20, signal: new AbortController().signal });
    expect(direct.code).not.toBe(0);
    const r = await run([clone], { repoSignals: { runner: oldGit } });
    expect(existsSync(marker)).toBe(false);
    expect(r.repos.repos[0]!.commits).toHaveLength(3);
  });
});

describe("repo signals: a read that did not finish is never ok", () => {
  const res = (code: number | null, stdout = "", extra: Partial<{ timedOut: boolean; truncated: boolean }> = {}) =>
    ({ code, stdout, timedOut: false, truncated: false, ...extra });
  /** Every command through runGit except those `pick` answers. */
  const except = (pick: (a: readonly string[]) => ReturnType<GitRunner> | undefined): GitRunner => (a, o) => pick(a) ?? runGit(a, o);

  test("a git that exits 1 on every call is git-missing, asked once", async () => {
    const calls: string[] = [];
    const r = await run([repo1(), repo2()], { repoSignals: { runner: async (a) => { calls.push(a[0]!); return res(1); } } });
    expect(r.repos.status).toBe("git-missing");
    expect(calls).toEqual(["--version"]);
  });

  test("a --version answer that names no version is git-missing", async () => {
    const r = await run([repo1()], { repoSignals: { runner: except((a) => (a[0] === "--version" ? Promise.resolve(res(0, "hello\n")) : undefined)) } });
    expect(r.repos.status).toBe("git-missing");
  });

  test("--version runs once, in a folder that always exists, not in a candidate's: a vanished first folder costs that folder only", async () => {
    const r1 = repo1();
    const r2 = repo2();
    const asked: { a: string; cwd: string }[] = [];
    let removed = false;
    const runner: GitRunner = (a, o) => {
      if (!removed) { rmSync(r1, { recursive: true, force: true }); removed = true; }
      asked.push({ a: a[0]!, cwd: o.cwd });
      return runGit(a, o);
    };
    const r = await run([r1, r2], { repoSignals: { runner } });
    const version = asked.filter((x) => x.a === "--version");
    expect(version).toHaveLength(1);
    expect(path.isAbsolute(version[0]!.cwd) && existsSync(version[0]!.cwd)).toBe(true);
    expect([r1, r2].some((d) => version[0]!.cwd.startsWith(d))).toBe(false);
    expect(r.repos.repos).toHaveLength(1);
    expect(r.repos.skipped).toEqual({ error: 1 });
    expect(r.repos.status).toBe("partial");
  });

  test("a rev-parse timeout drops the repo and makes the pass partial", async () => {
    const r = await run([repo1()], { repoSignals: { runner: except((a) => (a[0] === "rev-parse" ? Promise.resolve(res(null, "", { timedOut: true })) : undefined)) } });
    expect(r.repos).toMatchObject({ status: "partial", repos: [], skipped: { timeout: 1 } });
  });

  test("user.email: unset (exit 1) is no identity; a failed or timed-out read is counted, and the pass partial", async () => {
    const email = (answer: ReturnType<typeof res>) => except((a) => (a[0] === "config" && a.includes("user.email") ? Promise.resolve(answer) : undefined));
    const unset = await run([repo1()], { repoSignals: { runner: email(res(1)) } });
    expect(unset.repos).toMatchObject({ status: "ok", skipped: {} });
    expect(unset.repos.repos[0]).toMatchObject({ identity: false, commits: [] });
    const failed = await run([repo1()], { repoSignals: { runner: email(res(128)) } });
    expect(failed.repos).toMatchObject({ status: "partial", skipped: { "identity-error": 1 } });
    expect(failed.repos.repos[0]).toMatchObject({ identity: false, commits: [] });
    const slow = await run([repo1()], { repoSignals: { runner: email(res(null, "", { timedOut: true })) } });
    expect(slow.repos).toMatchObject({ status: "partial", skipped: { timeout: 1 } });
  });

  test("a log that fails twice is counted and makes the pass partial; the instruction history is still read", async () => {
    const r1 = makeRepo(path.join(h.root, "hist"), [{ files: { "CLAUDE.md": "x" }, message: "docs", at: ago(2) }]);
    const logs: boolean[] = [];
    const runner = except((a) => {
      if (a[0] !== "log" || !a.includes("--all")) return undefined;
      logs.push(a.includes("--name-only"));
      return Promise.resolve(res(128));
    });
    const r = await run([r1], { repoSignals: { runner } });
    expect(logs).toEqual([true, false]);
    expect(r.repos).toMatchObject({ status: "partial", skipped: { "log-error": 1 } });
    expect(r.repos.repos[0]).toMatchObject({ commits: [], fileLists: false, instructions: { touched: 1 } });
  });

  test("a timeout that ended the commit log makes the pass partial", async () => {
    const runner = except((a) => (a[0] === "log" && a.includes("--all") ? Promise.resolve(res(null, "", { timedOut: true })) : undefined));
    const r = await run([repo1()], { repoSignals: { runner } });
    expect(r.repos).toMatchObject({ status: "partial", skipped: { timeout: 1 } });
  });
});

describe("repo signals: options and inputs are checked", () => {
  const direct = (cwds: [string, string][], o: Parameters<typeof collectRepoSignals>[1] = {}, extra: Partial<Parameters<typeof collectRepoSignals>[0]> = {}) =>
    collectRepoSignals({ cwds: new Map(cwds), recent: new Set(cwds.map(([k]) => k)), salt: new Uint8Array(32), now: Date.now(),
      signal: new AbortController().signal, ...extra }, o);

  test("options that are not finite numbers fall back to their defaults: no NaN reaches a worker count, a cap or a date", async () => {
    const dir = repo1();
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const r = await direct([["p", dir]], { concurrency: bad, maxCommits: bad, maxFiles: bad, maxRepos: bad, timeoutMs: bad, budgetMs: bad });
      expect(r).toMatchObject({ status: "ok", skipped: {} });
      expect(r.repos[0]!.commits).toHaveLength(3);
      expect(r.repos[0]!.commits[0]!.files).toHaveLength(1);
    }
  });

  test("a window start that is not a finite date in range is left out: the repo is read whole, not counted as an error", async () => {
    const dir = repo1();
    for (const detailFrom of [Number.NaN, Number.NEGATIVE_INFINITY, 9e15]) {
      const r = await direct([["p", dir]], {}, { detailFrom });
      expect(r).toMatchObject({ status: "ok", skipped: {} });
      expect(r.since).toBeUndefined();
      expect(r.repos[0]!.commits).toHaveLength(3);
    }
  });

  test("a session folder that is not absolute is skipped (not-absolute), never resolved against the process's folder", async () => {
    const calls: number[] = [];
    const r = await direct([["p", "."], ["q", "relative/dir"]], { runner: async (a, o) => { calls.push(1); return runGit(a, o); } });
    expect(r).toMatchObject({ status: "ok", repos: [], skipped: { "not-absolute": 2 } });
    expect(calls).toEqual([]);
  });

  test("a rev-parse answer of other than exactly two lines is root-mismatch", async () => {
    const dir = repo1();
    const runner: GitRunner = (a, o) => (a[0] === "rev-parse"
      ? Promise.resolve({ code: 0, stdout: `${dir}\nextra\n.git\n`, timedOut: false, truncated: false }) : runGit(a, o));
    const r = await direct([["p", dir]], { runner });
    expect(r).toMatchObject({ status: "ok", repos: [], skipped: { "root-mismatch": 1 } });
  });

  test("candidate folders are asked in order of their detail sessions, most first", async () => {
    const dirs = ["a", "b", "c"].map((n) => makeRepo(path.join(h.root, n), [{ files: { "x.txt": n }, message: n, at: ago(2) }]));
    const asked: string[] = [];
    const runner: GitRunner = (a, o) => { if (a[0] === "rev-parse") asked.push(path.basename(o.cwd)); return runGit(a, o); };
    await direct([["pa", dirs[0]!], ["pb", dirs[1]!], ["pc", dirs[2]!]], { runner, concurrency: 1 },
      { detailSessions: new Map([["pa", 1], ["pb", 5], ["pc", 3]]) });
    expect(asked).toEqual(["b", "c", "a"]);
  });
});

describe("repo signals: switches, budget, missing git, abort", () => {
  test("repoSignals: false → status off, and git never runs", async () => {
    const r1 = repo1();
    const calls: string[][] = [];
    const counting: GitRunner = async (a, o) => { calls.push([...a]); return ok()(a, o); };
    const on = await run([r1], { repoSignals: { runner: counting } });
    expect(calls.length).toBeGreaterThan(0);
    calls.length = 0;
    const off = await run([r1], { repoSignals: false });
    expect(off.repos).toMatchObject({ status: "off", repos: [] });
    expect(on.repos.status).toBe("ok");
    // nothing on PATH named git runs either (POSIX): a fake that would leave a marker
    if (POSIX) {
      const marker = path.join(h.root, "git-ran");
      const bin = path.dirname(touchScript("git", marker));
      const saved = process.env.PATH;
      process.env.PATH = `${bin}${path.delimiter}${saved ?? ""}`;
      try {
        await run([r1], { repoSignals: false });
        expect(existsSync(marker)).toBe(false);
        await run([r1]); // the fake is live: with repo signals on, it runs
        expect(existsSync(marker)).toBe(true);
      } finally {
        process.env.PATH = saved;
      }
    }
  });

  test("a runner that never settles: the budget stops it, status partial, and the scan resolves", async () => {
    const r1 = repo1();
    const never: GitRunner = () => new Promise(() => {});
    const r = await run([r1], { repoSignals: { runner: never, budgetMs: 300 } });
    expect(r.repos.status).toBe("partial");
    expect(r.repos.skipped.budget).toBeGreaterThan(0);
  }, 30_000);

  test("a runner that never settles once repos are found: the running repo is stopped at the budget", async () => {
    const r1 = repo1();
    const hangsOnLog: GitRunner = (a, o) => (a[0] === "log" ? new Promise(() => {}) : runGit(a, o));
    const r = await run([r1], { repoSignals: { runner: hangsOnLog, budgetMs: 1_000 } });
    expect(r.repos.status).toBe("partial");
    expect(r.repos).toMatchObject({ repos: [], skipped: { budget: 1 } });
  });

  test("a runner throwing ENOENT → git-missing; coverage and warnings unchanged", async () => {
    const r1 = repo1();
    const missing: GitRunner = () => { throw Object.assign(new Error("not found"), { code: "ENOENT" }); };
    const r = await run([r1], { repoSignals: { runner: missing } });
    const off = await run([r1], { repoSignals: false });
    expect(r.repos.status).toBe("git-missing");
    expect([r.coverage, r.warnings]).toEqual([off.coverage, off.warnings]);
  });

  test("an abort during the after-pass → status partial", async () => {
    const r1 = repo1();
    const ac = new AbortController();
    const abortsThenHangs: GitRunner = () => { ac.abort(); return new Promise(() => {}); };
    const r = await run([r1], { signal: ac.signal, repoSignals: { runner: abortsThenHangs } });
    expect(r.repos.status).toBe("partial");
  }, 30_000);

  test("an aborted scan skips repo signals: partial, git never runs", async () => {
    const ac = new AbortController();
    ac.abort();
    const calls: number[] = [];
    const r = await run([repo1()], { signal: ac.signal, repoSignals: { runner: async (a, o) => { calls.push(1); return ok()(a, o); } } });
    expect(r.repos.status).toBe("partial");
    expect(calls).toEqual([]);
  });

  test("sessions that ended over 180 days ago are not looked at", async () => {
    const r1 = repo1();
    const old: SourcePlugin = { ...sessions([]), scan: async (_c, ctx) => {
      ctx.emit({ k: "session", tool: "codex", source: "fake-sessions", id: "codex:old", window: "lifetime", origin: "human", start: ctx.now - 400 * DAY,
        end: ctx.now - 200 * DAY, models: [], projectKey: ctx.registerCwd(r1) });
      ctx.emit({ k: "coverage", tool: "codex", source: "fake-sessions", window: "detail", status: "ok", files: 1, bytes: 1, records: 1, skipped: {}, unknownTypes: {}, versions: [] });
    } };
    const calls: number[] = [];
    const r = await scan({ env: h.env, plugins: [old], handleSignals: false, repoSignals: { runner: async (a, o) => { calls.push(1); return ok()(a, o); } } });
    expect(r.repos).toMatchObject({ status: "ok", repos: [] });
    expect(calls).toEqual([]);
  });
});
