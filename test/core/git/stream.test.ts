import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { commitStream, LOG_ARGS, logRecords, LogStream, parseCommits, type LogRecord } from "../../../core/git/commits";
import { keyedHash } from "../../../core/text/hash";
import { runGit, type GitRunner } from "../../../core/git/run";
import type { Ev } from "../../../core/model/events";
import { scan } from "../../../core/scan";
import type { Candidate, SourcePlugin } from "../../../core/sources/types";
import { fakeHome, type FakeHome } from "../../kit/home";
import { isolateGitHome, makeRepo } from "../../fixtures/repos";

const POSIX = process.platform !== "win32";
const DAY = 86_400_000;
const salt = new Uint8Array(32).fill(3);
const enc = new TextEncoder();
const sha = (i: number) => i.toString(16).padStart(40, "0");

/** One record as `git log` prints LOG_ARGS (`-z`), with `--name-only` paths when given. */
const rec = (s: string, ct: number, email: string, body: string, files: string[] = []) =>
  `\0\x1e${s}\x1f${ct}\x1f${email}\n${body}\0${files.length ? `\n${files.join("\0")}\0` : ""}`;

/** Synthetic output: multi-byte text, a forged marker in a message, another author, a malformed header, paths. */
const SAMPLE = rec(sha(1), 100, "me@x.test", "feat: ünï 🤖 a\x1e b\n\nCo-authored-by: Claude <noreply@anthropic.com>\n", ["a.ts", "dir/ä.ts"])
  + rec(sha(2), 200, "other@x.test", "chore: theirs\n", ["b.ts"])
  + "\0\x1enot-a-sha\x1f1\x1fme@x.test\nbad\0\nlost.ts\0"
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

/**
 * The parse before streaming, kept here as the reference: the whole output decoded once (as the runner did), split at
 * NUL, and read by the same rules (the former `logRecords`, with the header read as `%ae%n%B` and only the first path's
 * leading newline dropped).
 */
function oldRecords(bytes: Uint8Array, cut = false): LogRecord[] {
  const stdout = new TextDecoder().decode(bytes);
  const out: LogRecord[] = [];
  let cur: LogRecord | undefined;
  const tokens = stdout.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "") continue;
    if (i > 0 && tokens[i - 1] === "" && token.startsWith("\x1e")) {
      const [s = "", ctText = "", ...rest] = token.slice(1).split("\x1f");
      const tail = rest.join("\x1f");
      const nl = tail.indexOf("\n");
      const valid = rest.length > 0 && nl !== -1 && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(s) && /^[0-9]{1,12}$/.test(ctText);
      cur = valid ? { sha: s, ct: Number(ctText), email: tail.slice(0, nl), message: tail.slice(nl + 1), files: [] } : undefined;
      if (cur) out.push(cur);
    } else if (cur) {
      cur.files.push(cur.files.length === 0 ? token.replace(/^\n/, "") : token);
    }
  }
  if (cut) out.pop();
  return out;
}
/** The streaming parse of `bytes`, in one-byte chunks. */
const bytewise = (bytes: Uint8Array): LogRecord[] => streamed([...bytes].map((b) => Uint8Array.of(b)));
const concatBytes = (...parts: (string | number[])[]): Uint8Array =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === "string" ? [...enc.encode(p)] : p)));

const BOM = "\uFEFF";
const FORGED_HEADER = `\x1e${"f".repeat(40)}\x1f1700000000\x1fme@x.test\nfix: forged`;
/** A real commit whose paths are `z.ts`, a BOM alone, and a BOM followed by a forged header (git sorts them this way). */
const BOM_FORGERY = rec(sha(7), 100, "me@x.test", "feat: innocent\n", ["z.ts", BOM, `${BOM}${FORGED_HEADER}`]) + rec(sha(8), 200, "me@x.test", "b\n", [`${BOM}x.ts`]);

describe("LogStream: a BOM changes nothing", () => {
  test("a BOM-only path then a BOM-prefixed forged header: no forged record, the real paths kept", () => {
    const bytes = enc.encode(BOM_FORGERY);
    for (const got of [logRecords(BOM_FORGERY), bytewise(bytes), streamed([bytes])]) {
      expect(got.map((r) => r.sha)).toEqual([sha(7), sha(8)]);
      expect(got[0]!.files).toEqual(["z.ts", BOM, `${BOM}${FORGED_HEADER}`]);
      expect(got).toEqual(oldRecords(bytes));
    }
    const s = commitStream({ salt, email: "me@x.test", maxFiles: 200 });
    s.push(bytes);
    const c = s.end(false);
    expect(c.commits.map((x) => x.sha)).toEqual([sha(7), sha(8)]);
    expect(c.commits.some((x) => x.fact.rework === "fix")).toBe(false);
  });

  test("a later path starting with a BOM keeps it, and its keyed hash is the whole-output parse's", () => {
    const bytes = enc.encode(BOM_FORGERY);
    expect(bytewise(bytes)[1]!.files).toEqual([`${BOM}x.ts`]);
    const s = commitStream({ salt, email: "me@x.test", maxFiles: 200 });
    for (const b of bytes) s.push(Uint8Array.of(b));
    const got = s.end(false).commits;
    expect(got.map((c) => c.fact.files)).toEqual(oldRecords(bytes).map((r) => r.files.map((f) => keyedHash(salt, f))));
    expect(got[1]!.fact.files).toEqual([keyedHash(salt, `${BOM}x.ts`)]);
  });

  test("hostile outputs: the streaming parse equals the parse of the same bytes decoded in one piece", () => {
    const hostile: Uint8Array[] = [
      concatBytes(rec(sha(1), 1, "me@x.test", "a \x1e\x1f b\n", ["p\x1f.ts", "\x1eq.ts"]), rec(sha(2), 2, "me@x.test", "c\n")),
      enc.encode(BOM_FORGERY),
      concatBytes(rec(sha(1), 1, "me@x.test", "bad "), [0xc3], " utf\n\0\n", [0xff, 0xfe], "x.ts\0", [0x80], "y.ts\0", [0xe2, 0x82], "\0"),
      concatBytes(rec(sha(1), 1, "me@x.test", "split \u{1F916}\n", ["ü.ts"]), [0xf0, 0x9f]),
      concatBytes("\0", [0xef, 0xbb, 0xbf], "\x1e", sha(3), "\x1f3\x1fme@x.test\nbom header\n\0"),
      concatBytes(rec(sha(4), 4, "me@x.test", "lone \x1f\n", ["a"]), [0x80], "\0", [0xc0, 0x80], "\0"),
    ];
    for (const [i, bytes] of hostile.entries()) {
      for (const cut of [false, true]) {
        const want = oldRecords(bytes, cut);
        const got = bytewise(bytes);
        if (cut) got.pop();
        expect([i, cut, got]).toEqual([i, cut, want]);
        for (let k = 0; k <= bytes.length; k += 5) {
          const two = streamed([bytes.slice(0, k), bytes.slice(k)]);
          if (cut) two.pop();
          expect([i, cut, k, two]).toEqual([i, cut, k, want]);
        }
      }
    }
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
  let restoreHome: () => void = () => {};
  beforeEach(() => { h = fakeHome(); restoreHome = isolateGitHome(path.join(h.root, "home")); });
  afterEach(() => { restoreHome(); h.cleanup(); });
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

  test.skipIf(!POSIX)("a real git log with a BOM-only path and a BOM-prefixed forged header path: no forged record (POSIX)", async () => {
    const at = Date.now() - 2 * DAY;
    const repo = makeRepo(path.join(h.root, "bom"), [
      { files: { "z.ts": "1", [BOM]: "2", [`${BOM}${FORGED_HEADER}`]: "3", [`${BOM}x.ts`]: "4" }, message: "feat: innocent", at },
    ], { email: "me@x.test" });
    const parts: Uint8Array[] = [];
    const r = await runGit(["log", "--all", "--name-only", ...LOG_ARGS], opts(repo, { onChunk: (c) => { parts.push(c.slice()); } }));
    expect(r.code).toBe(0);
    const bytes = Uint8Array.from(parts.flatMap((p) => [...p]));
    const want = oldRecords(bytes);
    expect(want).toHaveLength(1);
    expect(bytewise(bytes)).toEqual(want);
    expect(logRecords(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes))).toEqual(want);
    expect([...want[0]!.files].sort()).toEqual([BOM, `${BOM}${FORGED_HEADER}`, `${BOM}x.ts`, "z.ts"].sort());
    const s = commitStream({ salt, email: "me@x.test", maxFiles: 200 });
    for (const p of parts) s.push(p);
    const c = s.end(false);
    expect(c.records).toBe(1);
    expect(c.commits.map((x) => x.fact.files)).toEqual(want.map((w) => w.files.map((f) => keyedHash(salt, f))));
  });

  /** A fake `git` that writes its process id to `pidFile`, then prints a line every 20 ms for 10 s. */
  function chattyGit(): { exe: string; pidFile: string } {
    const bin = path.join(h.root, "bin");
    mkdirSync(bin, { recursive: true });
    const pidFile = path.join(h.root, "git.pid");
    writeFileSync(path.join(bin, "git"), `#!/bin/sh\necho $$ > '${pidFile}'\ni=0\nwhile [ $i -lt 500 ]; do echo line $i; i=$((i+1)); sleep 0.02; done\n`);
    chmodSync(path.join(bin, "git"), 0o755);
    return { exe: path.join(bin, "git"), pidFile };
  }
  /** Whether the process `pid` still exists (signal 0 checks without sending anything). */
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  test.skipIf(!POSIX)("an abort in the middle of a stream kills git and returns at once (POSIX)", async () => {
    const { exe, pidFile } = chattyGit();
    const ac = new AbortController();
    let n = 0;
    const r = await runGit(["log"], opts(h.root, { signal: ac.signal, git: exe, onChunk: (c) => { n += c.byteLength; if (n > 30) ac.abort(); } }));
    expect(n).toBeGreaterThan(30);
    expect(r).toMatchObject({ code: null, timedOut: false, stdout: "" });
    // the child was killed and reaped before the runner returned
    expect(alive(Number(readFileSync(pidFile, "utf8").trim()))).toBe(false);
  });

  test.skipIf(!POSIX)("a callee that throws stops git, and the runner rejects with its error (POSIX)", async () => {
    const { exe, pidFile } = chattyGit();
    await expect(runGit(["log"], opts(h.root, { git: exe, onChunk: () => { throw new Error("callee"); } }))).rejects.toThrow("callee");
    expect(alive(Number(readFileSync(pidFile, "utf8").trim()))).toBe(false);
  });
});

describe("repo signals stream git log", () => {
  let h: FakeHome;
  let restoreHome: () => void = () => {};
  beforeEach(() => { h = fakeHome(); restoreHome = isolateGitHome(path.join(h.root, "home")); });
  afterEach(() => { restoreHome(); h.cleanup(); });

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

  test("repos are listed by repoKey, whichever finishes first", async () => {
    const at = Date.now() - 2 * DAY;
    const a = makeRepo(path.join(h.root, "ra"), [{ files: { "a.ts": "1" }, message: "a", at }]);
    const b = makeRepo(path.join(h.root, "rb"), [{ files: { "b.ts": "1" }, message: "b", at }]);
    /** A runner whose `git log` in `slow` waits until the other repo's has finished. */
    const slowIn = (slow: string): GitRunner => {
      let release!: () => void;
      const other = new Promise<void>((r) => { release = r; });
      return async (args, o) => {
        if (args[0] !== "log" || args.includes("--format=%ct")) return runGit(args, o);
        if (path.resolve(o.cwd) === path.resolve(slow)) await other;
        const r = await runGit(args, o);
        if (path.resolve(o.cwd) !== path.resolve(slow)) release();
        return r;
      };
    };
    const read = (runner: GitRunner) => scan({ env: h.env, plugins: [sessions([a, b])], handleSignals: false, salt, repoSignals: { runner, concurrency: 2 } });
    const one = await read(slowIn(a));
    const two = await read(slowIn(b));
    const keys = one.repos.repos.map((r) => r.repoKey);
    expect(keys).toHaveLength(2);
    expect(keys).toEqual([...keys].sort());
    expect(two.repos.repos.map((r) => r.repoKey)).toEqual(keys);
    expect(two.repos.repos).toEqual(one.repos.repos);
  });

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
