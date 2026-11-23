import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runGit, type GitRunner } from "../../../core/git/run";
import type { Ev } from "../../../core/model/events";
import { scan, type ScanOptions } from "../../../core/scan";
import type { Candidate, SourcePlugin } from "../../../core/sources/types";
import { keyedHash } from "../../../core/text/hash";
import { CANARY, expectNoCanaries } from "../../kit/canary";
import { fakeHome, type FakeHome } from "../../kit/home";
import { git, gitVersion, makeRepo } from "../../fixtures/repos";

const POSIX = process.platform !== "win32";
const DAY = 86_400_000;
const GIT_44 = (([a, b]) => a > 2 || (a === 2 && b >= 44))(gitVersion());

let h: FakeHome;
beforeEach(() => { h = fakeHome(); });
afterEach(() => h.cleanup());

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
    { files: { [`${CANARY.project}.ts`]: "a" }, message: `feat: ${CANARY.prompt}\n\nCo-authored-by: Claude <${CANARY.email}>`, at: ago(5) },
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
    // no global config either: a home of its own
    const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
    process.env.HOME = h.root;
    process.env.XDG_CONFIG_HOME = path.join(h.root, "xdg");
    let r: Awaited<ReturnType<typeof run>>;
    try {
      r = await run([r4], { repoSignals: { runner: (a, o) => { seen.push(a[0]!); return runGit(a, o); } } });
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) Reflect.deleteProperty(process.env, k); else process.env[k] = v;
    }
    expect(r.repos.repos[0]).toMatchObject({ identity: false, commits: [] });
    expect(seen).not.toContain("log");
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

  test("a runner that never settles: the budget stops it, status partial, scan resolves in under 2 s", async () => {
    const r1 = repo1();
    const never: GitRunner = () => new Promise(() => {});
    const t = Date.now();
    const r = await run([r1], { repoSignals: { runner: never, budgetMs: 300 } });
    expect(Date.now() - t).toBeLessThan(2_000);
    expect(r.repos.status).toBe("partial");
    expect(r.repos.skipped.budget).toBeGreaterThan(0);
  });

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
    const t = Date.now();
    const r = await run([r1], { signal: ac.signal, repoSignals: { runner: abortsThenHangs } });
    expect(Date.now() - t).toBeLessThan(2_000);
    expect(r.repos.status).toBe("partial");
  });

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
