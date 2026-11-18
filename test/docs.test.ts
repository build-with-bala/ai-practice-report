// The repository states formats and rules, never figures, local paths or other facts from the owner's machine.
//   measured  docs/design.md: a line holding [measured] keeps no digit outside code spans (format constants — versions,
//             tiers, `kind:0/1/2`, dates of format changes — go in code spans).
//   sightings FORMAT.md: no line reports what one machine's records showed ("was seen", "were seen", "on most records",
//             "on this machine", "on this Mac").
//   D6        No home-folder path of a named user: a macOS, Linux or Windows home (backslashes doubled in a source string
//             too), a desktop, documents or downloads folder under the home shorthand or $HOME, or a home path in Claude
//             Code's project-folder form (every separator a dash). Placeholders (<name>, *, $USER), store layouts under the
//             home shorthand and the synthetic homes of the test fixtures pass. Every line is read, code blocks included: a
//             path leaks from code too. Scans every file of the repository, docs/ and the FORMAT.md files among them.
//   D7        Outside code spans, fenced blocks and double-quoted strings, no phrase states a fact about the machine:
//             "this Mac" (also 's), "this machine's", "on/of/from this machine", "installed here", "untestable locally",
//             "can't/cannot test locally". A bare "this machine" is not checked: requirements use it too. Scans docs/ and
//             the FORMAT.md files.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dir, "..");
const slashes = (f: string): string => f.split(path.sep).join("/");
const text = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");
/** Every reader's format notes, and the docs. */
const FORMAT_DOCS = [...new Bun.Glob("core/sources/*/FORMAT.md").scanSync({ cwd: ROOT })].map(slashes).sort();
const DOCS = [...new Bun.Glob("docs/**/*.md").scanSync({ cwd: ROOT })].map(slashes).sort();

interface Line { n: number; line: string }
/** The lines of a text that `keep` accepts, numbered from 1. */
const linesOf = (body: string, keep: (line: string) => boolean): Line[] =>
  body.split(/\r?\n/).map((line, i) => ({ n: i + 1, line })).filter((l) => keep(l.line));

/** The line with each inline code span replaced by a space; a backtick run with no closing run stays literal. */
function stripCodeSpans(line: string): string {
  const parts = line.split(/(`+)/); // odd indices hold backtick runs
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (i % 2 === 0) {
      out += part;
      continue;
    }
    let close = i + 2;
    while (close < parts.length && parts[close] !== part) close += 2;
    if (close >= parts.length) {
      out += part;
      continue;
    }
    out += " ";
    i = close;
  }
  return out;
}

// ---- measured, sightings ----

/** A figure left in the prose of a `[measured]` line: it would be the author's machine's, so never in the repo. */
const figureOutsideCode = (line: string): boolean => /\d/.test(stripCodeSpans(line));
/** Wording that reports what one machine's records showed, where a format note should state the format. */
const SIGHTINGS = [/was seen/i, /were seen/i, /on most records/i, /on this machine/i, /on this Mac/i];
const reportsSighting = (line: string): boolean => SIGHTINGS.some((re) => re.test(line));

// ---- D6: home-folder paths ----

/** The synthetic homes the test fixtures use; a real user's name never appears in the repository. */
const SYNTHETIC_HOMES = ["dev", "d", "jo", "Jo Ann", "Jo%20Ann", "canaryuser", "A", "RUNNER~1"];
const HOME_DIRS = [
  /(?:\\\\|\\|\/)(?:Users|home)(?:\\\\|\\|\/)/g, // a macOS or Linux home (a WSL one in a Windows path too)
  /[A-Za-z]:(?:\\\\|\\|\/)users(?:\\\\|\\|\/)/gi, // a Windows home, as written in a doc or escaped in a source string
];
/** A home path in Claude Code's project-folder form, every separator a dash. */
const SLUG_HOME = /-(?:Users|home)-/g;
/** A personal folder under the home shorthand or $HOME. */
const PERSONAL_FOLDER = /(?:~|\$\{?HOME\}?)(?:\\\\|\\|\/)(?:Desktop|Documents|Downloads)(?![\w-])/i;
const NAME_END = /^(?:$|[\\/"'`\s)\],;:…])/;
const SLUG_NAME_END = /^(?:$|[-\\/"'`\s)\],;:…])/;

/** True when the text after a home prefix starts with a user's name that is not a synthetic fixture home. */
function namesUser(rest: string, end = NAME_END): boolean {
  if (SYNTHETIC_HOMES.some((name) => rest.startsWith(name) && end.test(rest.slice(name.length)))) return false;
  return /^[\p{L}\p{N}_]/u.test(rest); // placeholders (<name>), globs (*), variables ($USER, %USERNAME%) and ellipses pass
}

function breaksD6(line: string): boolean {
  if (PERSONAL_FOLDER.test(line)) return true;
  const after = (m: RegExpMatchArray) => line.slice(m.index! + m[0].length);
  if ([...line.matchAll(SLUG_HOME)].some((m) => namesUser(after(m), SLUG_NAME_END))) return true;
  return HOME_DIRS.some((re) => [...line.matchAll(re)].some((m) => namesUser(after(m))));
}

/** The repository's files: tracked ones, and untracked ones git does not ignore (what a commit would take). */
function repoFiles(): string[] {
  const r = Bun.spawnSync(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error("git ls-files failed: the home-path rule reads the repository's own file list");
  return [...new Set(new TextDecoder().decode(r.stdout).split("\0").filter((f) => f !== ""))].sort();
}

/** A text file's body; undefined for a file listed but gone (deleted in the work tree) or binary. */
function body(rel: string): string | undefined {
  let t: string;
  try {
    t = text(rel);
  } catch {
    return undefined;
  }
  return t.includes("\u0000") ? undefined : t;
}

// ---- D7: facts about the machine ----

const MACHINE_FACT =
  /\bthis mac\b|\bthis machine['’]s\b|\b(?:on|of|from) this machine\b|\binstalled here\b|\buntestable locally\b|\b(?:can['’]t|cannot) test locally\b/i;
/** A phrase that states a fact about the machine, outside double-quoted strings (quoted copy is about the user's machine). */
const breaksD7 = (prose: string): boolean => MACHINE_FACT.test(prose.replace(/"[^"]*"|“[^”]*”/g, " "));

const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
/** The fence marker that the line opens, or null; a backtick fence's info string holds no backtick. */
function opensFence(line: string): string | null {
  const m = FENCE.exec(line);
  if (!m || (m[1]![0] === "`" && m[2]!.includes("`"))) return null;
  return m[1]!;
}
const closesFence = (line: string, open: string): boolean => {
  const m = FENCE.exec(line);
  return m !== null && m[1]![0] === open[0] && m[1]!.length >= open.length && m[2]!.trim() === "";
};

/** The lines of a Markdown text that break D7: outside fenced blocks and code spans. */
function d7Lines(markdown: string): number[] {
  const found: number[] = [];
  let fence: string | null = null;
  markdown.split(/\r?\n/).forEach((raw, i) => {
    if (fence !== null) {
      if (closesFence(raw, fence)) fence = null;
      return;
    }
    fence = opensFence(raw);
    if (fence === null && breaksD7(stripCodeSpans(raw))) found.push(i + 1);
  });
  return found;
}

/** A path from its parts: this file then holds no home path of its own for the repository scan to find. */
const joined = (sep: string, ...parts: string[]): string => parts.join(sep);

describe("the repository states formats and requirements, never what one machine showed", () => {
  test("design.md: a [measured] line keeps its citation but no figure outside code spans", () => {
    const measured = linesOf(text("docs/design.md"), (line) => line.includes("[measured]"));
    expect(measured.length).toBeGreaterThan(0);
    expect(measured.filter((l) => figureOutsideCode(l.line)).map((l) => `docs/design.md:${l.n}`)).toEqual([]);
  });

  test("FORMAT.md: no line reports what was seen on a machine", () => {
    expect(FORMAT_DOCS).toEqual(expect.arrayContaining(["antigravity", "claude-code", "codex", "copilot", "cursor"].map((t) => `core/sources/${t}/FORMAT.md`)));
    expect(FORMAT_DOCS.flatMap((f) => linesOf(text(f), reportsSighting).map((l) => `${f}:${l.n}`))).toEqual([]);
  });

  test("D6: no file of the repository holds a home-folder path — docs/ and every FORMAT.md among them", () => {
    const files = repoFiles();
    expect(files).toEqual(expect.arrayContaining([...DOCS, ...FORMAT_DOCS, "test/docs.test.ts"]));
    const hits = files.flatMap((f) => {
      const t = body(f);
      return t === undefined ? [] : linesOf(t, breaksD6).map((l) => `${f}:${l.n}`);
    });
    expect(hits).toEqual([]);
  });

  test("D7: no line of docs/ or of a FORMAT.md states a fact about the machine", () => {
    expect(DOCS.length).toBeGreaterThan(0);
    expect([...DOCS, ...FORMAT_DOCS].flatMap((f) => d7Lines(text(f)).map((n) => `${f}:${n}`))).toEqual([]);
  });
});

// The made-up names, figures and paths below are not real ones.
describe("the rules themselves, on made-up lines", () => {
  test("measured: a figure outside a code span is flagged, one inside is not", () => {
    expect(figureOutsideCode("recurse subagents (a share of 54 in 100 tool calls [measured])")).toBe(true);
    expect(figureOutsideCode("**Codex** (`P0`) | `state_5.sqlite`, `kind:0` snapshot (`v1` is blind after `2026-02-23` [measured])")).toBe(false);
    expect(figureOutsideCode("a ``span with ` inside 41`` and none outside [measured]")).toBe(false);
  });

  test("sightings: each phrase is flagged in any case; the method is not", () => {
    const phrases = ["No model field was seen.", "both fields were seen", "it is below the other on most records", "confirmed On This Machine", "as on this mac"];
    expect(phrases.filter((p) => !reportsSighting(p))).toEqual([]);
    expect(reportsSighting("Evidence: confirmed with the structure probe (`scripts/probe.ts`)")).toBe(false);
  });

  test("D6: a home-folder path of a named user is flagged; store layouts, placeholders and fixture homes pass", () => {
    const ok = [
      "`~/.claude/projects/<slug>/*.jsonl`, `~/.codex/sessions/`, `~/Library/Application Support/Cursor`",
      "%APPDATA%\\Code\\User and \\\\wsl.localhost\\<distro>\\home\\*\\.codex",
      "`/Users/dev/Library`, `C:\\Users\\Jo Ann\\AppData`, `/home/jo/proj`, `c:/Users/A/proj`, `file:///c%3A/Users/Jo%20Ann/proj`",
      "\"C:\\\\Users\\\\RUNNER~1\\\\AppData\" (as escaped in a source string), `/Users/canaryuser/clients`, `-Users-dev-work`",
      "placeholders: `<A>/docs`, `/Users/<name>/`, `/home/$USER/`, `$HOME/.config`, `~/Desktopish`",
    ];
    expect(ok.filter(breaksD6)).toEqual([]);
    const bad = [
      joined("/", "", "Users", "someone", "notes"),
      joined("/", "", "home", "someone", "notes"),
      joined("\\", "C:", "Users", "someone", "notes"),
      `"${joined("\\\\", "C:", "Users", "someone", "notes")}"`,
      `\`${joined("/", "~", "Desktop", "notes")}\``,
      joined("/", "~", "Documents", "x"),
      joined("/", "~", "Downloads"),
      joined("/", "$HOME", "Desktop", "x"),
      joined("/", "${HOME}", "Downloads", "x"),
      joined("-", "", "Users", "someone", "proj"),
      joined("-", "", "home", "someone", "proj"),
      joined("/", "", "Users", "devon", "notes"), // a fixture home's name as a prefix is still another name
    ];
    expect(bad.filter((line) => !breaksD6(line))).toEqual([]);
  });

  test("D7: a phrase that states a fact about the machine is flagged; quoted copy, code spans and bare uses pass", () => {
    const ok = [
      "5. \"Your report stays on this machine and shows the real names of your projects.\"",
      "- the company fingerprint, with whether it matches this machine;",
      "the rule names `this Mac` and `on this machine` in code spans; no value from the owner's machine is kept",
      "a field confirmed “on this machine” is reworded; the rules are binding here",
    ];
    expect(ok.filter((line) => d7Lines(line).length > 0)).toEqual([]);
    const bad = [
      "proven on synthetic fixtures and on this Mac.",
      "agents may inspect this machine's traces",
      "a local run on this machine (results never committed)",
      "no figures from this machine>",
      "| **Cursor** (P0, not installed here) |",
      "| Untestable locally (Cursor, Windows) |",
      "Environments the builder cannot test locally: Cursor",
      "what we can't test locally",
    ];
    expect(bad.filter((line) => d7Lines(line).length === 0)).toEqual([]);
  });

  test("fenced blocks: D7 skips them, D6 reads them", () => {
    expect(d7Lines(["```text", "measured on this Mac, installed here", "```", "after the block"].join("\n"))).toEqual([]);
    expect(d7Lines(["~~~", "x", "~~~", "on this Mac"].join("\n"))).toEqual([4]);
    expect(linesOf(["~~~bash", `cd ${joined("/", "", "Users", "someone", "project")}`, "~~~"].join("\n"), breaksD6).map((l) => l.n)).toEqual([2]);
  });
});
