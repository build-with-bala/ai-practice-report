import { realpathSync } from "node:fs";
import path from "node:path";
import { bornAt, isDir, isFile, readTextLines, safeStat } from "../../io/fs";
import { MAX_LINE_BYTES } from "../../io/jsonl";
import type { ConfigEv } from "../../model/events";
import { isTypeName, listDir, readSidecar, Tally } from "../common/coverage";
import { isObj } from "../common/guards";
import type { Candidate, ScanCtx } from "../types";

export const CONFIG_SOURCE = "codex.config";
const TOOL = "codex";

// ---- TOML section headers ----

/** A table header's key path (quoted keys unquoted), and whether it is an array of tables (`[[…]]`). */
export interface TomlHeader { keys: string[]; array: boolean }

/** TOML 1.0 bare keys, plus the letters and digits TOML 1.1 adds. */
const BARE_KEY = /^[A-Za-z0-9_\-\p{L}\p{N}]+/u;
const ESCAPES: ReadonlyMap<string, string> = new Map([["b", "\b"], ["t", "\t"], ["n", "\n"], ["f", "\f"], ["r", "\r"], ["e", "\x1b"], ['"', '"'], ["\\", "\\"]]);
const isWs = (c: string | undefined): boolean => c === " " || c === "\t";

/** The escape at `t[j]` (a backslash) of a basic string: its text and the index after it; undefined when invalid. */
function unescape(t: string, j: number): { text: string; end: number } | undefined {
  const c = t[j + 1];
  if (c === undefined) return undefined;
  const simple = ESCAPES.get(c);
  if (simple !== undefined) return { text: simple, end: j + 2 };
  const len = c === "u" ? 4 : c === "U" ? 8 : c === "x" ? 2 : 0;
  const hex = t.slice(j + 2, j + 2 + len);
  if (len === 0 || !new RegExp(`^[0-9A-Fa-f]{${len}}$`).test(hex)) return undefined;
  const cp = Number.parseInt(hex, 16);
  return cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? undefined : { text: String.fromCodePoint(cp), end: j + 2 + len };
}

/** A quoted key starting at `t[i]` (`"…"` with escapes, or `'…'`): its text and the index after it. */
function quotedKey(t: string, i: number): { key: string; end: number } | undefined {
  const quote = t[i];
  let key = "";
  for (let j = i + 1; j < t.length;) {
    const c = t[j]!;
    if (c === quote) return { key, end: j + 1 };
    if (quote === '"' && c === "\\") {
      const e = unescape(t, j);
      if (!e) return undefined;
      key += e.text;
      j = e.end;
    } else {
      key += c;
      j++;
    }
  }
  return undefined;
}

/** `[a.b."c"]` or `[[a.b]]`, optionally followed by a comment; undefined when `t` (trimmed on the left) is not a valid header. */
function header(t: string): TomlHeader | undefined {
  const array = t.startsWith("[[");
  let i = array ? 2 : 1;
  const skipWs = () => {
    while (isWs(t[i])) i++;
  };
  const keys: string[] = [];
  for (;;) {
    skipWs();
    if (t[i] === '"' || t[i] === "'") {
      const k = quotedKey(t, i);
      if (!k) return undefined;
      keys.push(k.key);
      i = k.end;
    } else {
      const bare = BARE_KEY.exec(t.slice(i))?.[0];
      if (bare === undefined) return undefined;
      keys.push(bare);
      i += bare.length;
    }
    skipWs();
    if (t[i] !== ".") break;
    i++;
  }
  const close = array ? "]]" : "]";
  if (!t.startsWith(close, i)) return undefined;
  i += close.length;
  skipWs();
  return i >= t.length || t[i] === "#" ? { keys, array } : undefined;
}

/** The index after a one-line string starting at `line[i]` (a quote), or the line's length when it is not closed. */
function stringEnd(line: string, i: number): number {
  const quote = line[i];
  for (let j = i + 1; j < line.length; j++) {
    if (quote === '"' && line[j] === "\\") j++;
    else if (line[j] === quote) return j + 1;
  }
  return line.length;
}

/** The index after the delimiter that closes a multi-line string from `line[i]` on, or -1 when it stays open. */
function closing(line: string, i: number, delim: '"""' | "'''"): number {
  const quote = delim[0]!;
  while (i < line.length) {
    if (quote === '"' && line[i] === "\\") i += 2;
    else if (line[i] === quote) {
      let n = 0;
      while (line[i + n] === quote) n++;
      if (n >= 3) return i + n; // one or two quotes before the delimiter belong to the string
      i += n;
    } else i++;
  }
  return -1;
}

/** The index of the `=` after a key (quoted key parts may hold `=` or `#`), or -1. */
function keyEnd(line: string): number {
  for (let i = 0; i < line.length;) {
    const c = line[i]!;
    if (c === "=") return i;
    if (c === "#") return -1;
    i = c === '"' || c === "'" ? stringEnd(line, i) : i + 1;
  }
  return -1;
}

/**
 * Section headers of a TOML document, fed line by line. Values are scanned only to know where they end — multi-line
 * strings, arrays and inline tables span lines, and a `[` inside them is not a header — and are never kept.
 */
export class TomlHeaders {
  /** Lines that are not blank, a comment, a header or `key = value`, and header lines that do not parse. */
  malformed = 0;
  private ml: '"""' | "'''" | undefined;
  private depth = 0;
  private first = true;

  /** A multi-line string, array or inline table is open; at the end of the input, an unterminated value. */
  get open(): boolean {
    return this.ml !== undefined || this.depth > 0;
  }

  /** The header on this line, if it is one. */
  line(raw: string): TomlHeader | undefined {
    let line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (this.first) {
      this.first = false;
      if (line.startsWith("﻿")) line = line.slice(1);
    }
    if (this.open) {
      this.value(line, 0);
      return undefined;
    }
    const t = line.replace(/^[ \t]+/, "");
    if (t === "" || t.startsWith("#")) return undefined;
    if (t.startsWith("[")) {
      const h = header(t);
      if (!h) this.malformed++;
      return h;
    }
    const eq = keyEnd(line);
    if (eq < 0) this.malformed++;
    else this.value(line, eq + 1);
    return undefined;
  }

  /** Scans value text from `i`: strings (multi-line ones may stay open), comments, and the nesting of `[` and `{`. */
  private value(line: string, i: number): void {
    while (i < line.length) {
      if (this.ml !== undefined) {
        const end = closing(line, i, this.ml);
        if (end < 0) return;
        this.ml = undefined;
        i = end;
        continue;
      }
      const c = line[i]!;
      if (c === "#") return;
      if (c === '"' || c === "'") {
        const delim = c === '"' ? '"""' : "'''";
        if (line.startsWith(delim, i)) {
          this.ml = delim;
          i += 3;
        } else i = stringEnd(line, i);
        continue;
      }
      if (c === "[" || c === "{") this.depth++;
      else if ((c === "]" || c === "}") && this.depth > 0) this.depth--;
      i++;
    }
  }
}

// ---- configuration inventory ----

type Out = (ev: ConfigEv) => void;
interface Tables { profiles: Set<string>; servers: Set<string>; plugins: Set<string> }

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (names: Iterable<string>): string[] => [...names].sort(byName);
/** The path a symlink resolves to (dotfiles setups link config files into place), else the path itself. */
function resolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function cfg(kind: ConfigEv["kind"], provenance: ConfigEv["provenance"], name?: string): ConfigEv {
  const ev: ConfigEv = { k: "config", tool: TOOL, source: CONFIG_SOURCE, kind, provenance };
  if (name !== undefined) ev.name = name;
  return ev;
}

/**
 * Names of the `[profiles.<name>]`, `[mcp_servers.<name>]` and `[plugins.<id>]` tables of config.toml (their sub-tables
 * name the same entry). Only header lines are parsed; values are scanned for where they end and never kept.
 */
async function configTables(file: string, ctx: ScanCtx, tally: Tally): Promise<Tables> {
  const found: Tables = { profiles: new Set(), servers: new Set(), plugins: new Set() };
  const st = safeStat(file);
  if (!st) return found;
  if (!st.isFile()) {
    tally.skip("not-file");
    return found;
  }
  const toml = new TomlHeaders();
  try {
    for await (const line of readTextLines(file, { maxBytes: MAX_LINE_BYTES, signal: ctx.signal })) {
      const [table, name] = toml.line(line)?.keys ?? [];
      if (name === undefined) continue;
      if (table === "profiles") found.profiles.add(name);
      else if (table === "mcp_servers") found.servers.add(name);
      else if (table === "plugins") found.plugins.add(name);
    }
  } catch (e) {
    tally.skip(e instanceof RangeError ? "oversize" : "io-error");
    return found;
  }
  for (let i = 0; i < toml.malformed; i++) tally.unknownKey("config.toml:syntax");
  if (toml.open) tally.unknownKey("config.toml:unterminated");
  if (!ctx.signal.aborted) {
    tally.files++;
    tally.bytes += st.size;
  }
  return found;
}

/** Installed plugins: `<codex>/plugins/cache/<marketplace>/<plugin>/` folders, as `<plugin>@<marketplace>` ids. */
function cachedPlugins(root: string, tally: Tally): string[] {
  const cache = path.join(root, "plugins", "cache");
  const ids: string[] = [];
  for (const market of listDir(cache, tally)) {
    if (market.startsWith(".") || !isDir(path.join(cache, market))) continue;
    for (const plugin of listDir(path.join(cache, market), tally)) {
      if (!plugin.startsWith(".") && isDir(path.join(cache, market, plugin))) ids.push(`${plugin}@${market}`);
    }
  }
  return ids;
}

/** Skill names in the shared skills installer's lock (`<home>/.agents/.skill-lock.json`, keys of `skills`): empty without one, undefined when unreadable. */
function lockedSkills(home: string, tally: Tally): Set<string> | undefined {
  const file = resolved(path.join(home, ".agents", ".skill-lock.json"));
  if (!safeStat(file)) return new Set();
  const v = readSidecar(file, tally);
  if (!v) return undefined;
  if (v.skills === undefined || v.skills === null) return new Set();
  if (isObj(v.skills)) return new Set(Object.keys(v.skills));
  tally.unknownKey("skill-lock.skills:type");
  return new Set();
}

/**
 * `<codex>/skills/<name>/` folders holding a SKILL.md (hidden ones — `.system`, the bundled skills — are skipped); never
 * opened. `firstSeen`: when the folder appeared (`bornAt`, links followed).
 */
function skills(c: Candidate, tally: Tally, out: Out): void {
  const dir = path.join(c.root, "skills");
  const names = listDir(dir, tally).filter((n) => !n.startsWith(".") && isFile(path.join(dir, n, "SKILL.md")));
  if (names.length === 0) return;
  const lock = lockedSkills(c.home, tally);
  for (const name of names) {
    const ev = cfg("skill", lock === undefined ? "unknown" : lock.has(name) ? "installed" : "authored", name);
    const born = bornAt(path.join(dir, name));
    if (born !== undefined) ev.firstSeen = born;
    out(ev);
  }
}

/** One event per Markdown file directly in `<codex>/memories/` (the CLI's memory files), without a name; never opened. */
function memoryFiles(root: string, tally: Tally, out: Out): void {
  const dir = path.join(root, "memories");
  for (const name of listDir(dir, tally)) {
    if (!name.startsWith(".") && name.endsWith(".md") && isFile(path.join(dir, name))) out(cfg("memory-file", "authored"));
  }
}

/** Configuration inventory: config.toml profiles, MCP servers and plugins, installed plugins, skills, memory files. */
export async function scanCxConfig(c: Candidate, ctx: ScanCtx): Promise<void> {
  const tally = new Tally(TOOL, CONFIG_SOURCE, "lifetime");
  const out: Out = (ev) => {
    tally.records++;
    ctx.emit(ev);
  };
  const tables = await configTables(resolved(path.join(c.root, "config.toml")), ctx, tally);
  // profile names are user-chosen: kept only when shaped like a type name
  for (const name of sorted(tables.profiles)) out(cfg("profile", "authored", isTypeName(name) ? name : undefined));
  for (const name of sorted(tables.servers)) out(cfg("mcp-server", "unknown", name));
  for (const id of sorted(new Set([...tables.plugins, ...cachedPlugins(c.root, tally)]))) out(cfg("plugin", "installed", id));
  skills(c, tally, out);
  memoryFiles(c.root, tally, out);
  ctx.emit(tally.coverage());
}
