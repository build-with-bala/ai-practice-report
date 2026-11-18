import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.join(import.meta.dir, "..", "..");
/** Every core source file: TypeScript or JavaScript, dotfiles included. */
const PATTERN = "core/**/*.{ts,tsx,js,mjs,cjs,mts,cts}";
const sourcesUnder = (cwd: string): string[] =>
  [...new Bun.Glob(PATTERN).scanSync({ cwd, dot: true })].map((f) => f.split(path.sep).join("/")).sort();
const FILES = sourcesUnder(ROOT);

// Deny by default. Outside core/io, a core file opens, reads or writes no file and runs no program by itself: core/io's
// primitives are the only openers, and each refuses never-opened files and reports every open (core/io/observe.ts).
// Whatever the lists below do not allow fails.

/** The modules core may import outside core/io (relative imports aside), and what each is for. */
const MODULES: Readonly<Record<string, string>> = {
  "node:fs": "file metadata: the names in FS_NAMES only",
  fs: "the same module by its bare name: FS_NAMES only",
  "node:path": "path arithmetic",
  "node:os": "the home and temp folders",
  "node:crypto": "keyed hashes and the per-scan salt",
};
/** The node:fs names allowed outside core/io: metadata, never content. A type-only name is allowed too. */
const FS_NAMES: ReadonlySet<string> = new Set(["existsSync", "statSync", "lstatSync", "readdirSync", "realpathSync", "accessSync", "Stats", "Dirent"]);

/**
 * The exemptions: one file and the one rule it may break, and why. The git runner, once it exists, is the one file that
 * spawns: { file: "core/git/run.ts", rule: "Bun.spawn", why: "the git runner: read-only subcommands, async, with a timeout" }.
 */
const EXEMPT: readonly Exemption[] = [];

interface Exemption { file: string; rule: string; why: string }
interface Rule { id: string; why: string; find: (text: string) => string[] }
interface ModuleRef { module: string; at: number; text: string }

/** Every match of `re` in a text. */
const every = (re: RegExp) => (text: string): string[] => text.match(new RegExp(re.source, "g")) ?? [];

/**
 * Every module a source text names in `from "…"` (an import or a re-export) or a bare `import "…"`, wherever it stands:
 * over-inclusive, so that no import hides (a module name holds no space, comma, semicolon or parenthesis).
 */
function modulesOf(text: string): ModuleRef[] {
  return [...text.matchAll(/\b(?:from|import)\s*(["'])([^"'\s,;()]+)\1/g)].map((m) => ({ module: m[2]!, at: m.index!, text: m[0] }));
}

/**
 * Whether the import or re-export whose `from` stands at `at` names more of node:fs than metadata: a default or a
 * namespace import, `export *`, or a name not in FS_NAMES. A type-only statement or name names no code.
 */
function namesContent(text: string, at: number): boolean {
  const head = text.slice(0, at).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, " ");
  const keyword = [...head.matchAll(/\b(?:import|export)\b/g)].at(-1);
  const clause = head.slice(keyword === undefined ? 0 : keyword.index! + keyword[0].length).trim();
  if (/^type\s/.test(clause)) return false;
  const named = /^\{([^}]*)\}$/.exec(clause);
  if (!named) return true;
  return named[1]!.split(",").map((n) => n.trim()).filter((n) => n !== "")
    .some((n) => !n.startsWith("type ") && !FS_NAMES.has(n.split(/\s+as\s+/)[0]!));
}

/** A Bun member, written with `.` or `?.` and any spacing. */
const bunMember = (member: string, why: string): Rule => {
  const name = member === "$" ? "\\$" : `${member}\\b`;
  return { id: `Bun.${member}`, why, find: every(new RegExp(`\\bBun\\s*(?:\\?\\.|\\.)\\s*${name}`)) };
};

const RULES: readonly Rule[] = [
  { id: "import", why: "a module not in MODULES", find: (t) => modulesOf(t).filter((m) => !m.module.startsWith(".") && !Object.hasOwn(MODULES, m.module)).map((m) => m.text) },
  {
    id: "fs-name", why: "the rest of node:fs opens, reads or copies content",
    find: (t) => modulesOf(t).filter((m) => (m.module === "node:fs" || m.module === "fs") && namesContent(t, m.at)).map((m) => m.text),
  },
  { id: "dynamic-import", why: "it loads a module around the import rule", find: every(/\bimport\s*\(/) },
  { id: "require", why: "it loads a module around the import rule", find: every(/\brequire\s*\(/) },
  { id: "fetch", why: "core makes no network requests, and Bun's fetch reads file: URLs too", find: every(/\bfetch\s*\(/) },
  {
    id: "indirection", why: "it reaches Bun, require, fetch or native code around these rules",
    find: every(/\bglobalThis\b|\beval\s*\(|\bnew\s+Function\s*\(|\bprocess\s*\.\s*(?:binding|dlopen)\b/),
  },
  bunMember("file", "it opens a file unrefused and unreported"),
  bunMember("mmap", "it maps a file unrefused and unreported"),
  bunMember("write", "it writes a file"),
  bunMember("spawn", "it runs a program"),
  bunMember("spawnSync", "it runs a program"),
  bunMember("$", "it runs a shell"),
  { id: "Bun[]", why: "a computed member reaches any of Bun's", find: every(/\bBun\s*(?:\?\.)?\s*\[/) },
  { id: "= Bun", why: "an alias or a destructuring of Bun reaches its members unseen", find: every(/=\s*Bun\b(?!\s*\??\.)/) },
  { id: "openInEditor", why: "it opens a file in an editor", find: every(/\bopenInEditor\b/) },
  { id: "openUriReadOnly", why: "it opens a store unrefused and unreported: readers use openRo", find: every(/\bopenUriReadOnly\b/) },
  // the calls the first form of this rule named, wherever they stand, however they were reached
  { id: "opener", why: "it opens, reads or copies a file", find: every(/\b(?:readFileSync|openSync|readSync|createReadStream|copyFileSync)\b|\bnew\s+Database\s*\(/) },
  { id: "spawner", why: "it runs a program", find: every(/\bspawnSync\b|\bchild_process\b/) },
];

/** `<file>: <rule>: <what matched>` for each rule a source text breaks; core/io, which holds the primitives, is not checked. */
function violations(file: string, text: string, exempt: readonly Exemption[] = EXEMPT): string[] {
  if (file.startsWith("core/io/")) return [];
  return RULES.flatMap((r) => (exempt.some((e) => e.file === file && e.rule === r.id)
    ? []
    : r.find(text).map((m) => `${file}: ${r.id}: ${m.replace(/\s+/g, " ")}`)));
}

describe("static I/O rule: deny by default", () => {
  test("it reads every core source file, TypeScript and JavaScript, dotfiles included", () => {
    for (const f of ["core/index.ts", "core/scan.ts", "core/io/fs.ts", "core/io/sqlite.ts", "core/sources/codex/config.ts"]) expect(FILES).toContain(f);
    const tmp = mkdtempSync(path.join(os.tmpdir(), "static-io-"));
    try {
      const made = ["core/a.ts", "core/b.tsx", "core/c.js", "core/d.mjs", "core/e.cjs", "core/f.mts", "core/g.cts", "core/.hidden/h.ts", "core/x/.i.js"];
      for (const f of [...made, "core/notes.md", "core/x/y.json"]) {
        mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true });
        writeFileSync(path.join(tmp, f), "");
      }
      expect(sourcesUnder(tmp)).toEqual([...made].sort());
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("outside core/io, no core file breaks a rule", () => {
    expect(FILES.flatMap((f) => violations(f, readFileSync(path.join(ROOT, f), "utf8")))).toEqual([]);
  });

  test("the rules catch every route around core/io: other fs calls, Bun's own, bun:sqlite, spawners, other loaders, indirection", () => {
    const caught: [string, string][] = [
      ['import { readFileSync } from "node:fs";', "fs-name"],
      ['import { open, read, readFile, copyFile, cpSync, openAsBlob, createReadStream } from "fs";', "fs-name"],
      ['import fs from "node:fs";', "fs-name"],
      ['import * as fs from "node:fs";', "fs-name"],
      ['export { readFileSync } from "node:fs";', "fs-name"],
      ['export * from "fs";', "fs-name"],
      ['import {\n  readdirSync, // the "safe" one\n  readFileSync,\n} from "node:fs";', "fs-name"],
      ['import {\n  Database, // a "store"\n} from "bun:sqlite";', "import"],
      ['import { readFile } from "node:fs/promises";', "import"],
      ['import { open } from "fs/promises";', "import"],
      ['import { Database } from "bun:sqlite";', "import"],
      ['import { Database as Db } from "bun:sqlite";', "import"],
      ['import type { Database } from "bun:sqlite";', "import"],
      ['import { file, mmap, spawn, $ } from "bun";', "import"],
      ['import { spawn } from "node:child_process";', "import"],
      ['import "child_process";', "import"],
      ['const fs = require("node:fs");', "require"],
      ['const fs = await import("node:fs");', "dynamic-import"],
      ["Bun.file(p)", "Bun.file"], ["Bun.file (p)", "Bun.file"], ["Bun?.file(p)", "Bun.file"], ["Bun\n  .file(p)", "Bun.file"],
      ["Bun.mmap(p)", "Bun.mmap"], ["Bun.write(p, x)", "Bun.write"],
      ["Bun.spawn(['git'])", "Bun.spawn"], ["Bun.spawnSync(['git'])", "Bun.spawnSync"], ["await Bun.$`ls`", "Bun.$"],
      ["Bun.openInEditor(p)", "openInEditor"], ["const { openInEditor } = Bun;", "openInEditor"],
      ['Bun["file"](p)', "Bun[]"], ["const { file } = Bun;", "= Bun"], ["const B = Bun; B.file(p)", "= Bun"],
      ["openUriReadOnly(uri)", "openUriReadOnly"],
      ['await fetch("file:///etc/hosts")', "fetch"],
      ["globalThis.Bun.file(p)", "indirection"], ['process.binding("fs")', "indirection"], ['process.dlopen(m, "x.node")', "indirection"],
      ["handle.readFileSync(p)", "opener"], ["new Database(p)", "opener"], ["cp.spawnSync('git')", "spawner"], ['const name = "child_process";', "spawner"],
    ];
    const missed = caught.filter(([text, rule]) => !violations("core/sources/x.ts", text).some((v) => v.startsWith(`core/sources/x.ts: ${rule}: `)));
    expect(missed).toEqual([]);
    const allowed = [
      'import { readdirSync, realpathSync, existsSync, statSync, lstatSync, accessSync, type Stats } from "node:fs";',
      'import type { Dirent, Stats } from "fs";',
      'import { lstatSync as lst } from "fs";',
      'import path from "node:path";', 'import os from "node:os";', 'import { randomBytes } from "node:crypto";',
      'import { scan } from "./scan";', 'import pkg from "../package.json" with { type: "json" };', 'export type * from "./model/events";',
      "const h = Bun.hash(x);", "const dir = import.meta.dir;",
    ];
    expect(allowed.flatMap((text) => violations("core/sources/x.ts", text))).toEqual([]);
    expect(violations("core/io/x.ts", caught.map(([text]) => text).join("\n"))).toEqual([]); // core/io holds the primitives
  });

  test("an exemption allows one rule in one file, nothing else; every exemption names a core file", () => {
    const runner: Exemption[] = [{ file: "core/git/run.ts", rule: "Bun.spawn", why: "the git runner" }];
    expect(violations("core/git/run.ts", "Bun.spawn(['git', 'log'])", runner)).toEqual([]);
    expect(violations("core/git/run.ts", "Bun.spawnSync(['git'])", runner)).toEqual(["core/git/run.ts: Bun.spawnSync: Bun.spawnSync", "core/git/run.ts: spawner: spawnSync"]);
    expect(violations("core/git/other.ts", "Bun.spawn(['git'])", runner)).toEqual(["core/git/other.ts: Bun.spawn: Bun.spawn"]);
    for (const e of EXEMPT) expect([e.file, FILES.includes(e.file), e.why !== ""]).toEqual([e.file, true, true]);
  });
});
