import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { GIT_SAFE_ARGS, gitEnv, resolveGit, runGit } from "../../../core/git/run";
import { fakeHome, type FakeHome } from "../../kit/home";
import { makeRepo } from "../../fixtures/repos";

const POSIX = process.platform !== "win32";
const T0 = Date.UTC(2026, 9, 1);
let h: FakeHome;
beforeEach(() => { h = fakeHome(); });
afterEach(() => h.cleanup());

const opts = (cwd: string, over: Partial<{ timeoutMs: number; maxBytes: number; signal: AbortSignal }> = {}) =>
  ({ cwd, timeoutMs: 10_000, maxBytes: 1 << 20, signal: new AbortController().signal, ...over });

/** Runs `f` with `dir` first on PATH, restoring it after (by assignment). */
async function withPath<T>(dir: string, f: () => Promise<T>): Promise<T> {
  const saved = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${saved ?? ""}`;
  try {
    return await f();
  } finally {
    process.env.PATH = saved;
  }
}

/** A fake `git` on its own folder that sleeps 5 s. */
function sleepyGit(): string {
  const bin = path.join(h.root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "git"), "#!/bin/sh\nsleep 5\n");
  chmodSync(path.join(bin, "git"), 0o755);
  return bin;
}

describe("runGit", () => {
  test("git --version exits 0", async () => {
    const r = await runGit(["--version"], opts(h.root));
    expect(r).toMatchObject({ code: 0, timedOut: false, truncated: false });
    expect(r.stdout).toMatch(/^git version \d+\.\d+/);
  });

  test("the safe arguments and environment", () => {
    expect(GIT_SAFE_ARGS).toEqual(["--no-pager", "-c", "core.fsmonitor=false", "-c", "log.showSignature=false", "-c", "core.quotepath=off", "-c", "color.ui=never",
      "-c", "protocol.allow=never"]);
    const env = gitEnv({ PATH: "/bin", HOME: "/h", GIT_DIR: "/x", GIT_CONFIG_GLOBAL: "/y", GIT_EXTERNAL_DIFF: "z", UNSET: undefined });
    expect(env).toEqual({
      PATH: "/bin", HOME: "/h", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "none", GIT_CONFIG_NOSYSTEM: "1",
      GIT_PAGER: "cat", LC_ALL: "C", NoDefaultCurrentDirectoryInExePath: "1",
    });
  });

  test.skipIf(!POSIX)("a git that hangs is killed at the timeout (POSIX)", async () => {
    const bin = sleepyGit();
    const t = Date.now();
    const r = await withPath(bin, () => runGit(["--version"], opts(h.root, { timeoutMs: 200 })));
    expect(Date.now() - t).toBeLessThan(1_000);
    expect(r).toMatchObject({ code: null, timedOut: true });
  });

  test.skipIf(!POSIX)("an abort kills the process (POSIX)", async () => {
    const bin = sleepyGit();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const t = Date.now();
    const r = await withPath(bin, () => runGit(["--version"], opts(h.root, { signal: ac.signal })));
    expect(Date.now() - t).toBeLessThan(1_000);
    expect(r).toMatchObject({ code: null, timedOut: false });
  });

  test("an abort before the start stops at once", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await runGit(["--version"], opts(h.root, { signal: ac.signal }));
    expect(r.code).toBeNull();
  });

  test("output past maxBytes is cut and marked truncated", async () => {
    const repo = makeRepo(path.join(h.root, "r"), Array.from({ length: 5 }, (_, i) => ({ files: { [`f${i}.txt`]: `${i}` }, message: `commit ${i}`, at: T0 + i * 1000 })));
    const r = await runGit(["log", "--format=%H %s"], opts(repo, { maxBytes: 100 }));
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBe(100);
    expect(r.code).toBeNull();
  });

  test("an inherited GIT_DIR does not steer git", async () => {
    const repo = makeRepo(path.join(h.root, "r"), [{ files: { "a.txt": "a" }, message: "one", at: T0 }]);
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = "/nonexistent";
    try {
      const r = await runGit(["rev-parse", "--show-toplevel"], opts(path.join(repo)));
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).not.toBe("");
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, "GIT_DIR");
      else process.env.GIT_DIR = saved;
    }
  });

  test("a folder that does not exist rejects with ENOENT", async () => {
    expect(runGit(["--version"], opts(path.join(h.root, "gone")))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("git is found by an absolute PATH entry only: relative entries (\".\" among them) and the working folder are never used", () => {
    const win = process.platform === "win32";
    const rel = path.join(h.root, "rel");
    const abs = path.join(h.root, "abs");
    mkdirSync(rel, { recursive: true });
    mkdirSync(abs, { recursive: true });
    const name = win ? "git.exe" : "git";
    for (const d of [rel, abs]) {
      writeFileSync(path.join(d, name), win ? "MZ" : "#!/bin/sh\n");
      if (!win) chmodSync(path.join(d, name), 0o755);
    }
    const env = (p: string) => (win ? { Path: p, PATHEXT: ".COM;.EXE;.BAT;.CMD" } : { PATH: p });
    expect(resolveGit(env([".", "rel", abs].join(path.delimiter)))).toBe(path.join(abs, name));
    expect(resolveGit(env(["", "."].join(path.delimiter)))).toBeUndefined();
    expect(resolveGit(env(rel.replace(h.root, ".")))).toBeUndefined();
  });

  test("on Windows, a git.cmd alone is never run: only git.exe is (a cmd-only install is git-missing)", () => {
    const dir = path.join(h.root, "win");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "git.cmd"), "@echo off\r\n");
    const winDir = dir.replace(/\//g, "\\");
    expect(resolveGit({ PATH: "C:\\nowhere;" + winDir, PATHEXT: ".BAT;.CMD;.EXE" }, "win32")).toBeUndefined();
    expect(resolveGit({ PATH: winDir, PATHEXT: ".CMD" }, "win32")).toBeUndefined();
  });

  // Windows paths: only a Windows host can stat them
  test.skipIf(process.platform !== "win32")("on Windows, git.exe anywhere on PATH is found, a git.cmd before it never, whatever PATHEXT's order", () => {
    const first = path.join(h.root, "first");
    const later = path.join(h.root, "later");
    mkdirSync(first, { recursive: true });
    mkdirSync(later, { recursive: true });
    writeFileSync(path.join(first, "git.cmd"), "@echo off\r\n");
    writeFileSync(path.join(first, "git.exe"), "MZ");
    expect(resolveGit({ PATH: first, PATHEXT: ".CMD;.EXE" }, "win32")?.toLowerCase()).toBe(path.join(first, "git.exe").toLowerCase());
    rmSync(path.join(first, "git.exe"));
    writeFileSync(path.join(later, "git.exe"), "MZ");
    expect(resolveGit({ PATH: `${first};${later}`, PATHEXT: ".CMD;.EXE" }, "win32")?.toLowerCase()).toBe(path.join(later, "git.exe").toLowerCase());
    // PATHEXT still decides which extensions run at all
    expect(resolveGit({ PATH: first, PATHEXT: ".EXE" }, "win32")).toBeUndefined();
  });

  test("no git on PATH: the runner rejects with ENOENT", async () => {
    const saved = process.env.PATH;
    process.env.PATH = path.join(h.root, "empty");
    try {
      await expect(runGit(["--version"], opts(h.root))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      process.env.PATH = saved;
    }
  });
});
