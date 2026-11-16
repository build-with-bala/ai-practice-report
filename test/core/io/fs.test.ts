import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJsonSmall, safeList, safeStat, walk } from "../../../core/io/fs";

let root: string;
beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "fs-test-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("walk", () => {
  test("symlink loop terminates; respects maxDepth", () => {
    const d = path.join(root, "w");
    mkdirSync(path.join(d, "a", "b", "c"), { recursive: true });
    writeFileSync(path.join(d, "top.json"), "{}");
    writeFileSync(path.join(d, "a", "mid.json"), "{}");
    writeFileSync(path.join(d, "a", "b", "deep.json"), "{}");
    writeFileSync(path.join(d, "a", "b", "c", "deeper.json"), "{}");
    symlinkSync(d, path.join(d, "a", "loop"));
    const all = walk(d, { maxDepth: 2, match: (n, isDir) => !isDir && n.endsWith(".json") }).map((p) => path.relative(d, p)).sort();
    expect(all).toEqual(["a/b/deep.json", "a/mid.json", "top.json"]);
    const d0 = walk(d, { maxDepth: 0, match: () => true }).map((p) => path.relative(d, p)).sort();
    expect(d0).toEqual(["a", "top.json"]);
    const noLoop = walk(d, { maxDepth: 10, match: (n, isDir) => !isDir }).map((p) => path.relative(d, p));
    expect(noLoop.some((p) => p.includes("loop"))).toBe(true); // the symlink itself is an entry (not a dir), never followed
    expect(noLoop.length).toBeLessThan(10);
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
