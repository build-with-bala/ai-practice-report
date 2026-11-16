import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { installSignalCleanup, TempRegistry } from "../../../core/io/temp";

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
    expect(statSync(a).mode & 0o777).toBe(0o700);
    writeFileSync(path.join(a, "f"), "y");
    expect(reg.active).toBe(2);
    reg.disposeAll();
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
    expect(reg.active).toBe(0);
    expect(existsSync(keep)).toBe(true);
  });
  test("installSignalCleanup restores listener counts", () => {
    const reg = new TempRegistry(base);
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    const off = installSignalCleanup(reg);
    expect(process.listenerCount("SIGINT")).toBe(before[0] + 1);
    expect(process.listenerCount("SIGTERM")).toBe(before[1] + 1);
    off();
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
  });
});
