import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { commitStream, logRecords, LogStream, parseCommits, type LogRecord } from "../../../core/git/commits";
import { runGit, type GitRunner } from "../../../core/git/run";
import type { Ev } from "../../../core/model/events";
import { scan } from "../../../core/scan";
import type { Candidate, SourcePlugin } from "../../../core/sources/types";
import { fakeHome, type FakeHome } from "../../kit/home";
import { makeRepo } from "../../fixtures/repos";

const POSIX = process.platform !== "win32";
const DAY = 86_400_000;
const salt = new Uint8Array(32).fill(3);
const enc = new TextEncoder();
const sha = (i: number) => i.toString(16).padStart(40, "0");

/** One record as `git log` prints LOG_ARGS (`-z`), with `--name-only` paths when given. */
const rec = (s: string, ct: number, email: string, body: string, files: string[] = []) =>
  `\0\x1e${s}\x1f${ct}\x1f${email}\x1f${body}\0${files.length ? `\n${files.join("\0")}\0` : ""}`;

/** Synthetic output: multi-byte text, a forged marker in a message, another author, a malformed header, paths. */
const SAMPLE = rec(sha(1), 100, "me@x.test", "feat: ünï 🤖 a\x1e b\n\nCo-authored-by: Claude <noreply@anthropic.com>\n", ["a.ts", "dir/ä.ts"])
  + rec(sha(2), 200, "other@x.test", "chore: theirs\n", ["b.ts"])
  + "\0\x1enot-a-sha\x1f1\x1fme@x.test\x1fbad\0\nlost.ts\0"
  + rec(sha(3), 300, "me@x.test", "fix: x\n")
  + rec(sha(4), 400, "Me@X.test", "Revert \"y\"\n", ["c.ts", "d.ts", "e.ts"]);

function streamed(chunks: Uint8Array[]): LogRecord[] {
  const out: LogRecord[] = [];
  const s = new LogStream((r) => out.push(r));
  for (const c of chunks) s.push(c);
  s.end();
  return out;
}

describe("LogStream", () => {
  test("a record split across two chunks at every byte position reads as the whole output does", () => {
    const bytes = enc.encode(SAMPLE);
    const whole = logRecords(SAMPLE);
    expect(whole.map((r) => r.sha)).toEqual([sha(1), sha(2), sha(3), sha(4)]);
    for (let k = 0; k <= bytes.length; k++) {
      expect([k, streamed([bytes.slice(0, k), bytes.slice(k)])]).toEqual([k, whole]);
    }
  });

  test("the record marker split from its NUL, and a multi-byte character split inside, across one-byte chunks", () => {
    const bytes = enc.encode(SAMPLE);
    expect(streamed([...bytes].map((b) => Uint8Array.of(b)))).toEqual(logRecords(SAMPLE));
    const at = SAMPLE.indexOf("\0\x1e", 10);
    const cut = enc.encode(SAMPLE.slice(0, at + 1)).length; // the NUL ends one chunk, the marker starts the next
    expect(streamed([bytes.slice(0, cut), bytes.slice(cut)])).toEqual(logRecords(SAMPLE));
  });

  test("a chunk's buffer is never kept: changing it after push changes nothing", () => {
    const bytes = enc.encode(SAMPLE);
    const out: LogRecord[] = [];
    const s = new LogStream((r) => out.push(r));
    for (let i = 0; i < bytes.length; i += 7) {
      const chunk = bytes.slice(i, i + 7);
      s.push(chunk);
      chunk.fill(0x41);
    }
    s.end();
    expect(out).toEqual(logRecords(SAMPLE));
  });

  test("a very large output in small chunks: records leave as they complete, and only the unfinished token is held", () => {
    const N = 20_000;
    const one = (i: number) => rec(sha(i + 1), 1_000 + i, "me@x.test", `feat: change ${i}\n`, [`src/f${i % 50}.ts`, `src/g${i % 7}.ts`]);
    const longest = Math.max(...one(N - 1).split("\0").map((t) => enc.encode(t).length));
    let seen = 0;
    let maxBuffered = 0;
    let maxBehind = 0; // records pushed but not yet handed out
    const s = new LogStream(() => { seen++; });
    let pushed = 0;
    for (let i = 0; i < N; i++) {
      const bytes = enc.encode(one(i));
      for (let j = 0; j < bytes.length; j += 64) {
        s.push(bytes.subarray(j, j + 64));
        maxBuffered = Math.max(maxBuffered, s.buffered);
      }
      pushed++;
      maxBehind = Math.max(maxBehind, pushed - seen);
    }
    expect(s.end()).toBe(N);
    expect(seen).toBe(N);
    expect(maxBuffered).toBeLessThanOrEqual(longest);
    expect(maxBehind).toBe(1); // the record in progress only
  });

  test("maxFiles keeps the first paths of a record and drops the rest as they stream", () => {
    const out: LogRecord[] = [];
    const s = new LogStream((r) => out.push(r), { maxFiles: 2 });
    s.push(enc.encode(SAMPLE));
    s.end();
    expect(out.map((r) => r.files)).toEqual([["a.ts", "dir/ä.ts"], ["b.ts"], [], ["c.ts", "d.ts"]]);
  });
});

describe("commitStream", () => {
  const o = { salt, email: "me@x.test", maxFiles: 200 };
  for (const cut of [false, true]) {
    test(`agrees with parseCommits and logRecords at every split (cut ${cut})`, () => {
      const bytes = enc.encode(SAMPLE);
      const want = parseCommits(SAMPLE, { ...o, cut });
      expect(want.length).toBe(cut ? 2 : 3);
      for (let k = 0; k <= bytes.length; k += 3) {
        const s = commitStream(o);
        s.push(bytes.slice(0, k));
        s.push(bytes.slice(k));
        const got = s.end(cut);
        expect([k, got.commits]).toEqual([k, want]);
        expect(got.records).toBe(logRecords(SAMPLE, { cut }).length);
      }
    });
  }

  test("a cut that ends in a malformed header leaves out the record before it, as logRecords does", () => {
    const out = rec(sha(1), 1, "me@x.test", "a\n") + rec(sha(2), 2, "me@x.test", "b\n") + "\0\x1e12";
    const s = commitStream(o);
    s.push(enc.encode(out));
    const got = s.end(true);
    expect(got.commits.map((c) => c.sha)).toEqual(logRecords(out, { cut: true }).map((r) => r.sha));
    expect(got.commits).toHaveLength(1);
    expect(got.records).toBe(1);
  });
});

describe("runGit streaming", () => {
  let h: FakeHome;
  beforeEach(() => { h = fakeHome(); });
  afterEach(() => h.cleanup());
  const opts = (cwd: string, over: Partial<Parameters<GitRunner>[1]> = {}) =>
    ({ cwd, timeoutMs: 10_000, maxBytes: 1 << 20, signal: new AbortController().signal, ...over });

  test("onChunk gets the output and the result holds none of it", async () => {
    const repo = makeRepo(path.join(h.root, "r"), Array.from({ length: 30 }, (_, i) => ({ files: { [`f${i}.txt`]: `${i}` }, message: `commit ${i}`, at: Date.UTC(2026, 9, 1) + i * 1000 })));
    const whole = await runGit(["log", "--format=%H %s"], opts(repo));
    const parts: Uint8Array[] = [];
    const r = await runGit(["log", "--format=%H %s"], opts(repo, { onChunk: (c) => { parts.push(c.slice()); } }));
    expect(r).toMatchObject({ code: 0, stdout: "", truncated: false, timedOut: false });
    expect(Buffer.concat(parts).toString()).toBe(whole.stdout);
  });

  test("the output cap holds when streaming: exactly maxBytes handed over, truncated", async () => {
    const repo = makeRepo(path.join(h.root, "r"), Array.from({ length: 5 }, (_, i) => ({ files: { [`f${i}.txt`]: `${i}` }, message: `commit ${i}`, at: Date.UTC(2026, 9, 1) + i * 1000 })));
    let n = 0;
    const r = await runGit(["log", "--format=%H %s"], opts(repo, { maxBytes: 100, onChunk: (c) => { n += c.byteLength; } }));
    expect(n).toBe(100);
    expect(r).toMatchObject({ code: null, truncated: true, stdout: "" });
  });

  /** A fake `git` that prints a line every 20 ms for 10 s. */
  function chattyGit(): string {
    const bin = path.join(h.root, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, "git"), "#!/bin/sh\ni=0\nwhile [ $i -lt 500 ]; do echo line $i; i=$((i+1)); sleep 0.02; done\n");
    chmodSync(path.join(bin, "git"), 0o755);
    return path.join(bin, "git");
  }

  test.skipIf(!POSIX)("an abort in the middle of a stream kills git and returns at once (POSIX)", async () => {
    const exe = chattyGit();
    const ac = new AbortController();
    let n = 0;
    const t = Date.now();
    const r = await runGit(["log"], opts(h.root, { signal: ac.signal, git: exe, onChunk: (c) => { n += c.byteLength; if (n > 30) ac.abort(); } }));
    expect(Date.now() - t).toBeLessThan(2_000);
    expect(n).toBeGreaterThan(30);
    expect(r).toMatchObject({ code: null, timedOut: false, stdout: "" });
  });

  test.skipIf(!POSIX)("a callee that throws stops git, and the runner rejects with its error (POSIX)", async () => {
    const exe = chattyGit();
    const t = Date.now();
    await expect(runGit(["log"], opts(h.root, { git: exe, onChunk: () => { throw new Error("callee"); } }))).rejects.toThrow("callee");
    expect(Date.now() - t).toBeLessThan(2_000);
  });
});

describe("repo signals stream git log", () => {
  let h: FakeHome;
  beforeEach(() => { h = fakeHome(); });
  afterEach(() => h.cleanup());

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

  test("the same facts whether git's output arrives whole, streamed, or one byte at a time", async () => {
    const at = (d: number) => Date.now() - d * DAY;
    const repo = makeRepo(path.join(h.root, "r"), [
      { files: { "a.ts": "1" }, message: "feat: ünï\n\nCo-authored-by: Claude <noreply@anthropic.com>", at: at(5) },
      { files: { "b.ts": "2", "c.ts": "3" }, message: "fixup! feat", at: at(4) },
      { files: { "d.ts": "4" }, message: "theirs", at: at(3), email: "other@fixture.test" },
      { files: { "a.ts": "5" }, message: "Revert \"feat\"", at: at(2) },
    ]);
    let logs = 0;
    const whole: GitRunner = async (a, o) => {
      const { onChunk: _ignored, ...rest } = o;
      return runGit(a, rest);
    };
    const bytewise: GitRunner = (a, o) => {
      if (a[0] === "log") logs++;
      const inner = o.onChunk;
      return runGit(a, inner ? { ...o, onChunk: (c) => { for (let i = 0; i < c.length; i++) inner(c.subarray(i, i + 1)); } } : o);
    };
    const read = (runner?: GitRunner) => scan({ env: h.env, plugins: [sessions([repo])], handleSignals: false, salt,
      repoSignals: runner ? { runner } : true });
    const [a, b, c] = [await read(whole), await read(), await read(bytewise)];
    expect(a.repos.repos[0]!.commits).toHaveLength(3);
    expect(b.repos.repos).toEqual(a.repos.repos);
    expect(c.repos.repos).toEqual(a.repos.repos);
    expect(logs).toBeGreaterThan(0);
  });
});
