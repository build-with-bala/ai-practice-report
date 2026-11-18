import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileState, isDir, isFile, readJsonSmall, readJsonSmallResult, safeList, safeStat, walk } from "../../../core/io/fs";

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
  const posixOnly = process.platform === "win32" || process.getuid?.() === 0;
  test.skipIf(posixOnly)("a path inside a chmod 000 folder is an error, not missing", () => {
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
