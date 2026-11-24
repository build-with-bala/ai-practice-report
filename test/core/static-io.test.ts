import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.join(import.meta.dir, "..", "..");
/** The extensions of the source files the rules scan: TypeScript and JavaScript, JSX included. */
const SCANNED = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"];
/** Every core source file, dotfiles included. */
const PATTERN = `core/**/*.{${SCANNED.join(",")}}`;
const sourcesUnder = (cwd: string): string[] =>
  [...new Bun.Glob(PATTERN).scanSync({ cwd, dot: true })].map((f) => f.split(path.sep).join("/")).sort();
const FILES = sourcesUnder(ROOT);

// Deny by default. Outside core/io, a core file opens, reads or writes no file and runs no program by itself: core/io's
// primitives are the only openers, and each refuses never-opened files and reports every open (core/io/observe.ts).
// Whatever the lists below do not allow fails there. And no core file, core/io's included, runs a program, but for an
// exemption.

/** The modules core may import outside core/io (relative imports: `relativeEscapes`), and what each is for. */
const MODULES: Readonly<Record<string, string>> = {
  "node:fs": "file metadata: the names in FS_NAMES only",
  fs: "the same module by its bare name: FS_NAMES only",
  "node:path": "path arithmetic",
  "node:os": "the home and temp folders",
  "node:crypto": "keyed hashes and the per-scan salt",
};
/** The node:fs names allowed outside core/io: metadata, never content. A type-only name is allowed too. */
const FS_NAMES: ReadonlySet<string> = new Set(["existsSync", "statSync", "lstatSync", "readdirSync", "realpathSync", "accessSync", "Stats", "Dirent"]);
/** The members of `process` allowed outside core/io: the environment and the platform. */
const PROCESS_MEMBERS = ["env", "platform"];

/** The constructs an exemption may allow, by name. */
const CONSTRUCTS: Readonly<Record<string, RegExp>> = {
  "Bun.spawn": /\bBun\s*(?:\?\.|\.)\s*spawn\b/,
};
/** The exemptions: one file, the one construct it may hold, and why; every rule still applies to the rest of the file. */
const EXEMPT: readonly Exemption[] = [
  {
    file: "core/git/run.ts", construct: "Bun.spawn",
    why: "the git runner, the one program core runs: read-only subcommands only (--version, rev-parse, config --get, log), async, " +
      "with a timeout, an output cap and abort; git started by its absolute path on PATH, never from the repo folder; no stdin, no prompt, " +
      "no pager; no transport at all (protocol.allow=never, GIT_ALLOW_PROTOCOL=none) and no lazy fetch, so no fetch whatever the repo " +
      "config says; and repo config that would run a program (fsmonitor, signature checks) overridden",
  },
];

interface Exemption { file: string; construct: string; why: string }
/** Which files a rule checks: `readers`, every core file outside core/io; `all`, every core file. */
type Scope = "readers" | "all";
interface Rule { id: string; scope: Scope; why: string; find: (text: string, file: string) => string[] }
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

/** The one file a relative import may reach outside core/: the package manifest, for the version (a JSON import). */
const OUTSIDE_CORE_ALLOWED: ReadonlySet<string> = new Set(["package.json"]);

/**
 * A relative import that leaves core/, or names a file the rules do not scan: resolved against the importing file, it
 * must stay inside core/ and name a scanned extension, `.json`, or none (a TypeScript module path). `../package.json`
 * is the one file outside core/ allowed.
 */
function relativeEscapes(text: string, file: string): string[] {
  return modulesOf(text).filter((m) => m.module.startsWith(".")).filter((m) => {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), m.module));
    if (OUTSIDE_CORE_ALLOWED.has(target)) return false;
    if (!target.startsWith("core/")) return true;
    const ext = /\.([A-Za-z0-9]+)$/.exec(path.posix.basename(target))?.[1];
    return ext !== undefined && ext !== "json" && !SCANNED.includes(ext);
  }).map((m) => m.text);
}

/**
 * An import attribute other than `type: "json"` (`with { … }`, or the older `assert { … }`): Bun loads a module as a
 * database (`sqlite`), as text, or as a file by its attributes, around every rule here.
 */
function attributesOf(text: string): string[] {
  return [...text.matchAll(/(["'])[^"'\s]+\1\s*(?:with|assert)\s*\{([^}]*)\}/g)]
    .filter((m) => !/^\s*type\s*:\s*(["'])json\1\s*,?\s*$/.test(m[2]!)).map((m) => m[0]);
}

/** `process` not followed by a member access (`.`, `?.` or `[`). */
const NOT_MEMBER = String.raw`(?!\s*(?:\?\.|\.|\[))`;
/**
 * `process` beyond PROCESS_MEMBERS: another member (`.`, `?.`), a computed member, or the object itself handed on — an
 * alias or a destructuring, a whole argument, element or property value, a spread, a return. Prose about "the process"
 * is none of these.
 */
const PROCESS_USE = new RegExp([
  String.raw`\bprocess\s*(?:\?\.|\.)(?!(?:${PROCESS_MEMBERS.join("|")})\b)[A-Za-z_$][\w$]*`,
  String.raw`\bprocess\s*(?:\?\.)?\s*\[`,
  String.raw`=\s*process\b${NOT_MEMBER}`,
  String.raw`[(,[{:]\s*process\s*[)\],};]`,
  String.raw`\.\.\.\s*process\b`,
  String.raw`(?:=>|\breturn\b|\byield\b)\s*process\b${NOT_MEMBER}`,
  // the ordinary TypeScript forms around a member access: a cast (`(process as any).x`) and a non-null assertion (`process!.x`)
  String.raw`\bprocess\s+as\b`,
  String.raw`\bprocess\s*!(?!=)`,
].join("|"));

/** A Bun member, written with `.` or `?.` and any spacing. */
const bunMember = (member: string, why: string): Rule => {
  const name = member === "$" ? "\\$" : `${member}\\b`;
  return { id: `Bun.${member}`, scope: "all", why, find: every(new RegExp(`\\bBun\\s*(?:\\?\\.|\\.)\\s*${name}`)) };
};

const RULES: readonly Rule[] = [
  // readers: every core file outside core/io
  { id: "import", scope: "readers", why: "a module not in MODULES", find: (t) => modulesOf(t).filter((m) => !m.module.startsWith(".") && !Object.hasOwn(MODULES, m.module)).map((m) => m.text) },
  { id: "relative-import", scope: "all", why: "it reaches a file outside core/, or one the rules do not scan", find: relativeEscapes },
  {
    id: "fs-name", scope: "readers", why: "the rest of node:fs opens, reads or copies content",
    find: (t) => modulesOf(t).filter((m) => (m.module === "node:fs" || m.module === "fs") && namesContent(t, m.at)).map((m) => m.text),
  },
  { id: "dynamic-import", scope: "readers", why: "it loads a module around the import rule", find: every(/\bimport\s*\(/) },
  { id: "require", scope: "readers", why: "it loads a module around the import rule", find: every(/\brequire\s*\(/) },
  { id: "fetch", scope: "readers", why: "core makes no network requests, and Bun's fetch reads file: URLs too", find: every(/\bfetch\s*\(/) },
  { id: "indirection", scope: "readers", why: "it reaches Bun, require or fetch around these rules", find: every(/\bglobalThis\b|\beval\s*\(|\bnew\s+Function\s*\(/) },
  { id: "Bun", scope: "readers", why: "Bun's APIs open, read, write, store secrets and run programs: only core/io uses Bun", find: every(/\bBun\b/) },
  { id: "process", scope: "readers", why: "beyond env and platform, process loads modules and native code (getBuiltinModule, binding, dlopen)", find: every(PROCESS_USE) },
  { id: "openInEditor", scope: "readers", why: "it opens a file in an editor", find: every(/\bopenInEditor\b/) },
  { id: "openUriReadOnly", scope: "readers", why: "it opens a store unrefused and unreported: readers use openRo", find: every(/\bopenUriReadOnly\b/) },
  { id: "opener", scope: "readers", why: "it opens, reads or copies a file", find: every(/\b(?:readFileSync|openSync|readSync|createReadStream|copyFileSync)\b|\bnew\s+Database\s*\(/) },
  // all: every core file, core/io's included
  bunMember("spawn", "it runs a program"),
  bunMember("spawnSync", "it runs a program"),
  bunMember("$", "it runs a shell"),
  { id: "child_process", scope: "all", why: "it runs programs", find: every(/\bchild_process\b/) },
  { id: "import-attribute", scope: "all", why: "an attribute other than type json loads a database, text or a file", find: attributesOf },
  { id: "spawnSync", scope: "all", why: "it runs a program", find: every(/\bspawnSync\b/) },
];

/**
 * `<file>: <rule>: <what matched>` for each rule a source text breaks: every rule outside core/io; in core/io, which holds
 * the primitives, the `all` rules. An exemption's construct is taken out of its file's text first.
 */
function violations(file: string, text: string, exempt: readonly Exemption[] = EXEMPT): string[] {
  let checked = text;
  for (const e of exempt) if (e.file === file) checked = checked.replace(new RegExp(CONSTRUCTS[e.construct]!.source, "g"), " ");
  const reader = !file.startsWith("core/io/");
  return RULES.filter((r) => r.scope === "all" || reader).flatMap((r) => r.find(checked, file).map((m) => `${file}: ${r.id}: ${m.replace(/\s+/g, " ")}`));
}

describe("static I/O rule: deny by default", () => {
  test("it reads every core source file, TypeScript and JavaScript, dotfiles included", () => {
    for (const f of ["core/index.ts", "core/scan.ts", "core/io/fs.ts", "core/io/sqlite.ts", "core/sources/codex/config.ts"]) expect(FILES).toContain(f);
    const tmp = mkdtempSync(path.join(os.tmpdir(), "static-io-"));
    try {
      const made = ["core/a.ts", "core/b.tsx", "core/c.js", "core/d.mjs", "core/e.cjs", "core/f.mts", "core/g.cts", "core/.hidden/h.ts", "core/x/.i.js", "core/k.jsx"];
      for (const f of [...made, "core/notes.md", "core/x/y.json"]) {
        mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true });
        writeFileSync(path.join(tmp, f), "");
      }
      expect(sourcesUnder(tmp)).toEqual([...made].sort());
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("no core file breaks a rule", () => {
    expect(FILES.flatMap((f) => violations(f, readFileSync(path.join(ROOT, f), "utf8")))).toEqual([]);
  });

  test("outside core/io the rules catch every route: other fs calls, Bun, bun:sqlite, process, spawners, other loaders", () => {
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
      ['import process from "node:process";', "import"],
      ['const fs = require("node:fs");', "require"],
      ['const fs = await import("node:fs");', "dynamic-import"],
      // Bun: any reference at all
      ["Bun.file(p)", "Bun"], ["Bun.file (p)", "Bun"], ["Bun?.file(p)", "Bun"], ["Bun\n  .file(p)", "Bun"], ["Bun.mmap(p)", "Bun"],
      ["Bun.write(p, x)", "Bun"], ['Bun["file"](p)', "Bun"], ["const { file } = Bun;", "Bun"], ["const B = Bun; B.file(p)", "Bun"],
      ['new Bun.SQL("sqlite://x.db")', "Bun"], ["await Bun.sql`SELECT 1`", "Bun"], ['await Bun.secrets.get({ service: "s", name: "n" })', "Bun"],
      ["await Bun.build({ entrypoints: [] })", "Bun"], ["Bun.FFI.dlopen(p, {})", "Bun"], ["const B = (Bun); B.file(p)", "Bun"],
      ["const o = { rt: Bun };", "Bun"], ["const h = Bun.hash(x);", "Bun"],
      // process: env and platform only
      ['process.getBuiltinModule("fs/promises").readFile(p)', "process"], ['process?.getBuiltinModule("bun:sqlite")', "process"],
      ['process\n  .getBuiltinModule("fs")', "process"], ['process["getBuiltinModule"]("fs")', "process"], ['process.binding("fs")', "process"],
      ['process.dlopen(m, "x.node")', "process"], ['const P = (process); P.getBuiltinModule("fs")', "process"], ["const o = { rt: process };", "process"],
      ["const p = process;", "process"], ["const { getBuiltinModule } = process;", "process"], ["const o = { ...process };", "process"],
      ["const get = () => process;", "process"],
      // spawners
      ["Bun.spawn(['git'])", "Bun.spawn"], ["Bun.spawnSync(['git'])", "Bun.spawnSync"], ["await Bun.$`ls`", "Bun.$"],
      ['import { spawn } from "node:child_process";', "child_process"], ['import "child_process";', "child_process"],
      ['const name = "child_process";', "child_process"], ["cp.spawnSync('git')", "spawnSync"],
      // the rest
      ["Bun.openInEditor(p)", "openInEditor"], ["openUriReadOnly(uri)", "openUriReadOnly"],
      ['await fetch("file:///etc/hosts")', "fetch"], ["globalThis.Bun.file(p)", "indirection"],
      ["handle.readFileSync(p)", "opener"], ["new Database(p)", "opener"],
      // relative imports: out of core/, or to a file no rule scans; attributes that load a module as something else
      ['import { helper } from "../../scripts/helper";', "relative-import"], ['import { read } from "./evil.db";', "relative-import"],
      ['export * from "../../app/x";', "relative-import"], ['import "../../test/kit/home";', "relative-import"],
      ['import db from "./x.db" with { type: "sqlite" };', "import-attribute"], ['import t from "./x.txt" with { type: "text" };', "import-attribute"],
      ['import f from "./x.bin" with { type: "file" };', "import-attribute"], ['import j from "./x.json" assert { type: "text" };', "import-attribute"],
      ['import j from "./x.json" with { type: "json", other: "x" };', "import-attribute"],
      // process through the ordinary TypeScript forms
      ['(process as any).getBuiltinModule("node:fs")', "process"], ["process!.binding('fs')", "process"], ["const p = process as unknown;", "process"],
    ];
    const missed = caught.filter(([text, rule]) => !violations("core/sources/x.ts", text).some((v) => v.startsWith(`core/sources/x.ts: ${rule}: `)));
    expect(missed).toEqual([]);
    const allowed = [
      'import { readdirSync, realpathSync, existsSync, statSync, lstatSync, accessSync, type Stats } from "node:fs";',
      'import type { Dirent, Stats } from "fs";',
      'import { lstatSync as lst } from "fs";',
      'import path from "node:path";', 'import os from "node:os";', 'import { randomBytes } from "node:crypto";',
      'import { scan } from "./scan";', 'import pkg from "../package.json" with { type: "json" };', 'export type * from "./model/events";',
      'import { view } from "./view.jsx";', 'import data from "./table.json" with { type: \'json\' };', 'if (process !== undefined) f();',
      "const dir = import.meta.dir;", "const e = process.env;", 'const home = process.env.HOME;', 'if (process.platform === "win32") f();',
      "// one DailyEv per local day (process time zone), as the scanning process's zone counts it; the process ends.",
    ];
    expect(allowed.flatMap((text) => violations("core/sources/x.ts", text))).toEqual([]);
  });

  test("the five routes the rule used to pass now fail it, the jsx file among the files read", () => {
    const sqlAttr = ["sql", "ite"].join(""); // built from parts: a control, never a use
    const controls = [
      'import { helper } from "../../scripts/helper";',
      'import { read } from "./evil.jsx";\nread();\nBun.file("x");', // a jsx module is scanned like the rest
      `import db from "./x.db" with { type: "${sqlAttr}" };`,
      'import t from "./x.db" with { type: "text" };',
      'import f from "./x.db" with { type: "file" };',
    ];
    for (const c of controls) expect(violations("core/sources/x.ts", c)).not.toEqual([]);
    expect(violations("core/sources/evil.jsx", "Bun.file(p)")).toEqual(["core/sources/evil.jsx: Bun: Bun"]);
    // the manifest is the one file outside core/ a relative import may name, from any depth
    expect(violations("core/index.ts", 'import pkg from "../package.json" with { type: "json" };')).toEqual([]);
    expect(violations("core/a/b/c.ts", 'import pkg from "../../../package.json" with { type: "json" };')).toEqual([]);
    expect(violations("core/index.ts", 'import x from "../bun.lock";')).toEqual(['core/index.ts: relative-import: from "../bun.lock"']);
  });

  test("core/io holds the primitives: it may open files, but no file there runs a program", () => {
    const primitives = [
      'import { constants, Database } from "bun:sqlite";', 'import { readFileSync } from "node:fs";', "const db = new Database(uri, flags);",
      'const text = readFileSync(p, "utf8");', "for await (const chunk of Bun.file(p).stream()) {}", "Bun.gc(true);", "process.memoryUsage().rss;",
    ];
    expect(primitives.flatMap((text) => violations("core/io/x.ts", text))).toEqual([]);
    expect(violations("core/io/x.ts", 'Bun.spawn(["git"]);\nimport { spawn } from "node:child_process";'))
      .toEqual(["core/io/x.ts: Bun.spawn: Bun.spawn", "core/io/x.ts: child_process: child_process"]);
    expect(violations("core/io/x.ts", 'Bun.spawnSync(["git"]); await Bun.$`ls`;'))
      .toEqual(["core/io/x.ts: Bun.spawnSync: Bun.spawnSync", "core/io/x.ts: Bun.$: Bun.$", "core/io/x.ts: spawnSync: spawnSync"]);
  });

  test("an exemption allows one construct in one file, nothing else; every exemption names a core file, a construct and a reason", () => {
    const runner: Exemption[] = [{ file: "core/git/run.ts", construct: "Bun.spawn", why: "the git runner" }];
    expect(violations("core/git/run.ts", "const p = Bun.spawn(['git', 'log']);", runner)).toEqual([]);
    expect(violations("core/git/run.ts", "Bun.spawnSync(['git'])", runner))
      .toEqual(["core/git/run.ts: Bun: Bun", "core/git/run.ts: Bun.spawnSync: Bun.spawnSync", "core/git/run.ts: spawnSync: spawnSync"]);
    expect(violations("core/git/run.ts", "Bun.file(p)", runner)).toEqual(["core/git/run.ts: Bun: Bun"]);
    expect(violations("core/git/other.ts", "Bun.spawn(['git'])", runner)).toEqual(["core/git/other.ts: Bun: Bun", "core/git/other.ts: Bun.spawn: Bun.spawn"]);
    for (const e of EXEMPT) expect([e.file, FILES.includes(e.file), Object.hasOwn(CONSTRUCTS, e.construct), e.why !== ""]).toEqual([e.file, true, true, true]);
    // the git runner is the only file that spawns
    const spawning = FILES.filter((f) => CONSTRUCTS["Bun.spawn"]!.test(readFileSync(path.join(ROOT, f), "utf8")));
    expect(spawning).toEqual(["core/git/run.ts"]);
  });
});
