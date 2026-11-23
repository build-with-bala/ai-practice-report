import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { GIT_SAFE_ARGS, gitEnv, runGit } from "../../../core/git/run";
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
    expect(GIT_SAFE_ARGS).toEqual(["--no-pager", "-c", "core.fsmonitor=false", "-c", "log.showSignature=false", "-c", "core.quotepath=off", "-c", "color.ui=never"]);
    const env = gitEnv({ PATH: "/bin", HOME: "/h", GIT_DIR: "/x", GIT_CONFIG_GLOBAL: "/y", GIT_EXTERNAL_DIFF: "z", UNSET: undefined });
    expect(env).toEqual({
      PATH: "/bin", HOME: "/h", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_PAGER: "cat", LC_ALL: "C",
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
});
