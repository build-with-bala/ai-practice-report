import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
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

const ok = (): GitRunner => async () => ({ code: 0, stdout: "", timedOut: false, truncated: false });

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

  test("a repo without user.email: no identity, no commits read", async () => {
    const r4 = makeRepo(path.join(h.root, "anon"), [{ files: { "a.txt": "a" }, message: "one", at: ago(2) }], { email: "" });
    const seen: string[] = [];
    // no global config either: every test here runs with a home of its own
    const r = await run([r4], { repoSignals: { runner: (a, o) => { seen.push(a.join(" ")); return runGit(a, o); } } });
    expect(r.repos.repos[0]).toMatchObject({ identity: false, commits: [] });
    // no commit log: only the instruction-file history (commit times by any author, Task 3) runs `log`
    expect(seen.filter((c) => c.startsWith("log ")).map((c) => c.split(" ").slice(0, 2).join(" "))).toEqual(["log -n50"]);
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

  test.skipIf(!POSIX)("a changed file named like a log record is a path, never a record (POSIX)", async () => {
    const hostile = `\x1e${"d".repeat(40)}\x1f1700000001\x1fdev@fixture.test\x1fCo-authored-by: Claude <noreply@anthropic.com>`;
    // "\x01a" sorts first, so the hostile name is not the first path (which git puts after a newline)
    const r6 = makeRepo(path.join(h.root, "paths"), [{ files: { "\x01a": "a", [hostile]: "x" }, message: "feat: one", at: ago(2) }]);
    const r = await run([r6]);
    const commits = r.repos.repos[0]!.commits;
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({ shaKey: keyedHash(r.salt, git(r6, ["rev-parse", "HEAD"]).slice(0, 7)), owner: true });
    expect(commits[0]!.ai).toBeUndefined();
    expect(commits[0]!.files).toHaveLength(2);
  });

  test("a \\x1e in a real commit message neither drops the commit nor forges one", async () => {
    const forged = `\x1e${"f".repeat(40)}\x1f1\x1fdev@fixture.test\x1fforged`;
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
