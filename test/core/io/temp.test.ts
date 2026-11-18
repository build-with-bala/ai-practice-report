import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TERM_SIGNALS, trapSignals } from "../../../core/io/signals";
import { ScanTemp, TempRegistry } from "../../../core/io/temp";

const base = mkdtempSync(path.join(os.tmpdir(), "temp-test-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("TempRegistry", () => {
  test("dir() creates distinct 0700 dirs under base; disposeAll removes them only", () => {
    const keep = path.join(base, "unrelated");
    writeFileSync(keep, "x");
    const reg = new TempRegistry(base);
    const a = reg.dir();
    const b = reg.dir();
    expect(a).not.toBe(b);
    expect(path.dirname(a)).toBe(base);
    expect(path.basename(a).startsWith("aipr-")).toBe(true);
    if (process.platform !== "win32") expect(statSync(a).mode & 0o777).toBe(0o700); // Windows has no POSIX modes
    writeFileSync(path.join(a, "f"), "y");
    expect(reg.active).toBe(2);
    reg.disposeAll();
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
    expect(reg.active).toBe(0);
    expect(existsSync(keep)).toBe(true);
  });
});

describe("ScanTemp", () => {
  test("makes its aipr-scan-* folder only on the first dir(), and close() removes it", () => {
    const tmp = mkdtempSync(path.join(base, "lazy-"));
    const t = new ScanTemp(tmp);
    expect(readdirSync(tmp)).toEqual([]);
    expect(t.close()).toBe(true); // nothing made, nothing left
    const t2 = new ScanTemp(tmp);
    const d = t2.dir();
    writeFileSync(path.join(d, "copy.db"), "x");
    const [scanDir] = readdirSync(tmp);
    expect(scanDir!.startsWith("aipr-scan-")).toBe(true);
    expect(path.dirname(d)).toBe(path.join(tmp, scanDir!));
    expect(t2.active).toBe(1);
    expect(t2.close()).toBe(true);
    expect(readdirSync(tmp)).toEqual([]);
  });

  test("a missing temp folder fails only dir(), never construction or close()", () => {
    const t = new ScanTemp(path.join(base, "no-such-dir", "deeper"));
    expect(() => t.dir()).toThrow();
    expect(t.active).toBe(0);
    expect(t.close()).toBe(true);
  });

  test("close() reports leftovers in its folder, and removes them anyway", () => {
    const tmp = mkdtempSync(path.join(base, "left-"));
    let scanDir = "";
    const t = new ScanTemp(tmp, (b) => {
      scanDir = b;
      return { dir: () => { writeFileSync(path.join(b, "stray"), "x"); return b; }, disposeAll: () => {}, active: 0 };
    });
    t.dir();
    expect(t.close()).toBe(false);
    expect(existsSync(scanDir)).toBe(false);
  });
});

describe("trapSignals", () => {
  test("adds one listener per signal while trapped and removes exactly those", () => {
    const before = TERM_SIGNALS.map((s) => process.listenerCount(s));
    const seen: string[] = [];
    const release = trapSignals((sig) => seen.push(sig));
    expect(TERM_SIGNALS.map((s) => process.listenerCount(s))).toEqual(before.map((n) => n + 1));
    (process.listeners("SIGTERM").at(-1) as () => void)(); // the trap's own listener, called directly (no signal is sent)
    expect(seen).toEqual(["SIGTERM"]);
    release();
    expect(TERM_SIGNALS.map((s) => process.listenerCount(s))).toEqual(before);
  });
});
