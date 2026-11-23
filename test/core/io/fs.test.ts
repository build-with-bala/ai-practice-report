import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { bornAt, fileState, isDir, isFile, readJsonSmall, readJsonSmallResult, readTextLines, readTextSmall, safeList, safeStat, walk } from "../../../core/io/fs";

let root: string;
beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "fs-test-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A link at `at` to the folder `target` (a junction on Windows: no privilege needed); false on Windows when none can be made. */
function linkFolder(target: string, at: string): boolean {
  try {
    symlinkSync(target, at, process.platform === "win32" ? "junction" : undefined);
    return true;
  } catch (e) {
    if (process.platform !== "win32") throw e;
    return false;
  }
}

describe("fileState, isDir, isFile", () => {
  test("a file, a folder and a missing path; a path through a file is missing", () => {
    const f = path.join(root, "st-file");
    writeFileSync(f, "x");
    const d = path.join(root, "st-dir");
    mkdirSync(d);
    expect(fileState(f)).toBe("file");
    expect(fileState(d)).toBe("dir");
    expect(fileState(path.join(root, "st-nope"))).toBe("missing");
    expect(fileState(path.join(f, "inside"))).toBe("missing"); // ENOTDIR
    expect([isFile(f), isDir(f), isFile(d), isDir(d), isFile(path.join(root, "st-nope"))]).toEqual([true, false, false, true, false]);
  });
  test("links are followed: a dangling link is missing, a link to a folder is a folder", () => {
    const dangling = path.join(root, "st-dangling");
    if (linkFolder(path.join(root, "st-gone"), dangling)) expect(fileState(dangling)).toBe("missing");
    const target = path.join(root, "st-target");
    mkdirSync(target);
    const linked = path.join(root, "st-linked");
    if (linkFolder(target, linked)) {
      expect(fileState(linked)).toBe("dir");
      expect(isDir(linked)).toBe(true);
    }
  });
  const skipChmod = process.platform === "win32" || process.getuid?.() === 0;
  test.skipIf(skipChmod)("a path inside a chmod 000 folder is an error, not missing", () => {
    const d = path.join(root, "st-locked");
    mkdirSync(d);
    const f = path.join(d, "x");
    writeFileSync(f, "");
    chmodSync(d, 0o000);
    try {
      expect(fileState(f)).toBe("error");
      expect(isFile(f)).toBe(false);
    } finally {
      chmodSync(d, 0o700);
    }
  });
  test.skipIf(process.platform === "win32")("anything else that exists is other", () => {
    expect(fileState("/dev/null")).toBe("other"); // a character device
  });
});

describe("bornAt", () => {
  /** The rule, written out apart from the code: the birth time, else the ctime, in whole ms. */
  const born = (p: string) => { const st = statSync(p); return Math.floor(st.birthtimeMs > 0 ? st.birthtimeMs : st.ctimeMs); };

  test("a file's or folder's birth time (its ctime where the file system has none); nothing there, none", () => {
    const f = path.join(root, "born-file");
    writeFileSync(f, "x");
    const d = path.join(root, "born-dir");
    mkdirSync(d);
    expect(bornAt(f)).toBe(born(f));
    expect(bornAt(d)).toBe(born(d));
    expect(bornAt(f)).toBeGreaterThan(0);
    expect(bornAt(path.join(root, "born-nope"))).toBeUndefined();
    expect(bornAt(path.join(f, "inside"))).toBeUndefined();
  });

  test("a link counts as what it points to", () => {
    const target = path.join(root, "born-target");
    mkdirSync(target);
    const linked = path.join(root, "born-linked");
    if (linkFolder(target, linked)) expect(bornAt(linked)).toBe(born(target));
  });
});

describe("walk", () => {
  test("symlink loop terminates; respects maxDepth", () => {
    const d = path.join(root, "w");
    mkdirSync(path.join(d, "a", "b", "c"), { recursive: true });
    writeFileSync(path.join(d, "top.json"), "{}");
    writeFileSync(path.join(d, "a", "mid.json"), "{}");
    writeFileSync(path.join(d, "a", "b", "deep.json"), "{}");
    writeFileSync(path.join(d, "a", "b", "c", "deeper.json"), "{}");
    // a link back to the top: a junction on Windows (no privilege needed); where no link can be made, the loop part is skipped
    let looped = true;
    try {
      symlinkSync(d, path.join(d, "a", "loop"), process.platform === "win32" ? "junction" : undefined);
    } catch (e) {
      if (process.platform !== "win32") throw e;
      looped = false;
    }
    const rel = (p: string) => path.relative(d, p).split(path.sep).join("/");
    const all = walk(d, { maxDepth: 2, match: (n, isDir) => !isDir && n.endsWith(".json") }).map(rel).sort();
    expect(all).toEqual(["a/b/deep.json", "a/mid.json", "top.json"]);
    const d0 = walk(d, { maxDepth: 0, match: () => true }).map(rel).sort();
    expect(d0).toEqual(["a", "top.json"]);
    if (looped) {
      const noLoop = walk(d, { maxDepth: 10, match: (n, isDir) => !isDir }).map(rel);
      expect(noLoop.some((p) => p.includes("loop"))).toBe(true); // the link itself is an entry (not a dir), never followed
      expect(noLoop.length).toBeLessThan(10);
    }
  });
  test("missing dir returns []", () => {
    expect(walk(path.join(root, "nope"), { maxDepth: 3, match: () => true })).toEqual([]);
  });
});

describe("safeList/safeStat", () => {
  test("missing", () => {
    expect(safeList(path.join(root, "nope"))).toEqual([]);
    expect(safeStat(path.join(root, "nope"))).toBeNull();
  });
  const skip = process.platform === "win32" || process.getuid?.() === 0;
  test.skipIf(skip)("chmod 000 dir returns []", () => {
    const d = path.join(root, "locked");
    mkdirSync(d);
    writeFileSync(path.join(d, "x"), "");
    chmodSync(d, 0o000);
    try {
      expect(safeList(d)).toEqual([]);
    } finally {
      chmodSync(d, 0o700);
    }
  });
});

describe("readJsonSmall", () => {
  test("valid, invalid, oversize", () => {
    const ok = path.join(root, "ok.json");
    writeFileSync(ok, '{"a":1}');
    expect(readJsonSmall(ok)).toEqual({ a: 1 });
    const bad = path.join(root, "bad.json");
    writeFileSync(bad, "{nope");
    expect(readJsonSmall(bad)).toBeUndefined();
    const big = path.join(root, "big.json");
    writeFileSync(big, Buffer.alloc(9 * 1024 * 1024, 0x20));
    expect(readJsonSmall(big)).toBeUndefined();
    expect(readJsonSmall(path.join(root, "missing.json"))).toBeUndefined();
  });
});

describe("readJsonSmallResult", () => {
  test("says why a file could not be used", () => {
    const ok = path.join(root, "r-ok.json");
    writeFileSync(ok, '{"a":1}');
    expect(readJsonSmallResult(ok)).toEqual({ ok: true, value: { a: 1 } });
    const bad = path.join(root, "r-bad.json");
    writeFileSync(bad, "{nope");
    expect(readJsonSmallResult(bad)).toEqual({ ok: false, reason: "parse" });
    const big = path.join(root, "r-big.json");
    writeFileSync(big, Buffer.alloc(9 * 1024 * 1024, 0x20));
    expect(readJsonSmallResult(big)).toEqual({ ok: false, reason: "too-large" });
    expect(readJsonSmallResult(path.join(root, "r-missing.json"))).toEqual({ ok: false, reason: "missing" });
    expect(readJsonSmallResult(root)).toEqual({ ok: false, reason: "not-file" });
  });
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("an unreadable file is an io-error", () => {
    const p = path.join(root, "r-locked.json");
    writeFileSync(p, "{}");
    chmodSync(p, 0o000);
    try {
      expect(readJsonSmallResult(p)).toEqual({ ok: false, reason: "io-error" });
      expect(readJsonSmall(p)).toBeUndefined();
    } finally {
      chmodSync(p, 0o600);
    }
  });
});

describe("readTextLines", () => {
  const lines = async (p: string, maxBytes: number, signal?: AbortSignal): Promise<string[]> => {
    const out: string[] = [];
    for await (const line of readTextLines(p, { maxBytes, signal })) out.push(line);
    return out;
  };

  test("lines split at \\n, a \\r kept, a leading BOM dropped, characters split across read chunks intact; a last line without a newline", async () => {
    const wide = "€".repeat(200_000); // 600 kB of 3-byte characters: read chunk ends fall inside some of them
    const p = path.join(root, "t-lines.txt");
    writeFileSync(p, `\uFEFF[ab]\r\n\uFEFFkeep\n\n${wide}\nlast`);
    expect(await lines(p, 1_000_000)).toEqual(["[ab]\r", "\uFEFFkeep", "", wide, "last"]);
    const ends = path.join(root, "t-ends.txt");
    writeFileSync(ends, "a\nb\n");
    expect(await lines(ends, 10)).toEqual(["a", "b"]);
  });

  test("maxBytes caps each line, never the file: a longer line, one read chunk or several, ends the read with a RangeError", async () => {
    const p = path.join(root, "t-cap.txt");
    writeFileSync(p, "aaaa\nbbbb\ncccc");
    expect(await lines(p, 4)).toEqual(["aaaa", "bbbb", "cccc"]); // 14 bytes in all, 4 a line
    writeFileSync(p, "aaaa\nbbbbb\ncccc\n");
    await expect(lines(p, 4)).rejects.toBeInstanceOf(RangeError);
    writeFileSync(p, `${"x".repeat(600_000)}\nok\n`);
    expect(await lines(p, 600_000)).toEqual(["x".repeat(600_000), "ok"]);
    await expect(lines(p, 599_999)).rejects.toBeInstanceOf(RangeError);
    writeFileSync(p, "x".repeat(600_000));
    await expect(lines(p, 599_999)).rejects.toBeInstanceOf(RangeError); // the last line too
  });

  test("an aborted read ends early; a missing path throws", async () => {
    const p = path.join(root, "t-abort.txt");
    writeFileSync(p, "a\nb\n");
    const ac = new AbortController();
    ac.abort();
    expect(await lines(p, 10, ac.signal)).toEqual([]);
    await expect(lines(path.join(root, "t-missing.txt"), 10)).rejects.toThrow();
  });
});

/** A named pipe at `p` (POSIX): nothing writes to it, so a reader that opened it would wait forever. */
function fifo(p: string): string {
  const r = Bun.spawnSync(["mkfifo", p], { stdout: "ignore", stderr: "ignore" });
  if (r.exitCode !== 0) throw new Error("mkfifo failed");
  return p;
}

describe("readTextSmall", () => {
  test("a small file whole, a leading BOM dropped; a missing path, a folder, a file over the cap", () => {
    const p = path.join(root, "s-small.md");
    writeFileSync(p, "\uFEFFhello\nworld\n");
    expect(readTextSmall(p, 1024)).toEqual({ ok: true, text: "hello\nworld\n" });
    expect(readTextSmall(p, 15)).toEqual({ ok: true, text: "hello\nworld\n" }); // 15 bytes: at the cap
    expect(readTextSmall(p, 14)).toEqual({ ok: false, reason: "too-large" });
    expect(readTextSmall(path.join(root, "s-missing.md"), 1024)).toEqual({ ok: false, reason: "missing" });
    const d = path.join(root, "s-dir");
    mkdirSync(d);
    expect(readTextSmall(d, 1024)).toEqual({ ok: false, reason: "not-file" });
  });

  test("a link is read as the file it points to", () => {
    const target = path.join(root, "s-target.md");
    writeFileSync(target, "linked");
    const at = path.join(root, "s-link.md");
    try {
      symlinkSync(target, at);
    } catch (e) {
      if (process.platform !== "win32") throw e;
      return;
    }
    expect(readTextSmall(at, 1024)).toEqual({ ok: true, text: "linked" });
  });

  test.skipIf(process.platform === "win32")("a FIFO is no regular file: refused at once, never opened, so it cannot hang a read (POSIX)", () => {
    const p = fifo(path.join(root, "s-fifo"));
    expect(readTextSmall(p, 1024)).toEqual({ ok: false, reason: "not-file" });
  });
});

describe("readTextLines: only a regular file", () => {
  test.skipIf(process.platform === "win32")("a FIFO, a device and a folder throw at once, never opened (POSIX)", async () => {
    const p = fifo(path.join(root, "l-fifo"));
    const d = path.join(root, "l-dir");
    mkdirSync(d);
    for (const at of [p, "/dev/zero", d]) {
      await expect((async () => { for await (const _ of readTextLines(at, { maxBytes: 1024 })) { /* drain */ } })()).rejects.toThrow(/not a regular file/);
    }
  });
});
