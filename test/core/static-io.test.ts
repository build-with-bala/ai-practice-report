import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dir, "..", "..");
/** Calls that open, read or copy a file's content: only core/io makes them, and each of its primitives reports the open (core/io/observe.ts). */
const OPENERS = ["readFileSync", "openSync", "readSync", "createReadStream", "copyFileSync", "Bun.file(", "new Database("];
/** Calls that run a program: only core/git/run.ts makes them. */
const SPAWNERS = ["Bun.spawn", "spawnSync", "child_process"];

/** Every core/**\/*.ts file, as a repository-relative path with `/` separators. */
const FILES = [...new Bun.Glob("core/**/*.ts").scanSync({ cwd: ROOT })].map((f) => f.split(path.sep).join("/")).sort();

/** `<file>: <call>` for each file the rule applies to that contains one of `calls`. */
function hits(applies: (file: string) => boolean, calls: string[]): string[] {
  return FILES.filter(applies).flatMap((f) => {
    const text = readFileSync(path.join(ROOT, f), "utf8");
    return calls.filter((c) => text.includes(c)).map((c) => `${f}: ${c}`);
  });
}

describe("static I/O rule", () => {
  test("it reads every core file, core/io's own among them", () => {
    for (const f of ["core/index.ts", "core/scan.ts", "core/io/fs.ts", "core/io/sqlite.ts", "core/sources/codex/config.ts"]) expect(FILES).toContain(f);
  });

  test("outside core/io, no core file opens, reads or copies a file itself", () => {
    expect(hits((f) => !f.startsWith("core/io/"), OPENERS)).toEqual([]);
  });

  test("outside core/git/run.ts, no core file runs a program", () => {
    expect(hits((f) => f !== "core/git/run.ts", SPAWNERS)).toEqual([]);
  });
});
