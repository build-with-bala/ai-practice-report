/**
 * A repo's allowlisted files — instruction files, Claude Code hooks, CI and pre-commit configuration — read in memory
 * and reduced to kinds, check lists, booleans and counts. Only the exact paths and the three folders below are opened
 * or listed; source files never are. No text leaves these functions.
 */
import { realpathSync } from "node:fs";
import path from "node:path";
import { readTextSmall, safeList } from "../io/fs";
import type { CheckKind } from "../model/ids";
import { isObj } from "../sources/common/guards";
import { parseHooks } from "../sources/common/hooks";
import { classifyCommand } from "../text/commands";
import type { GitRunner } from "./run";
import type { InstructionKind, RepoFacts } from "./types";

/** Each instruction file kind's path, relative to the repo root (`.cursor/rules/` is a folder: REPO_FOLDERS). */
export const INSTRUCTION_FILES: Readonly<Record<InstructionKind, string>> = {
  claude: "CLAUDE.md", agents: "AGENTS.md", gemini: "GEMINI.md", cursorrules: ".cursorrules", "cursor-rules": ".cursor/rules/",
};
/** The instruction files also read at each session folder inside the repo. */
export const SESSION_FOLDER_FILES: readonly string[] = ["CLAUDE.md", "AGENTS.md"];
const CLAUDE_SETTINGS = ".claude/settings.json";
const PRE_COMMIT = ".pre-commit-config.yaml";
const LEFTHOOK = "lefthook.yml";
/** The other exact paths opened, relative to the repo root. `.claude/settings.local.json` is never opened. */
export const REPO_FILES: readonly string[] = [CLAUDE_SETTINGS, PRE_COMMIT, LEFTHOOK];

/** A folder listed one level deep: its path relative to the repo root, and the entry names it opens. */
export interface RepoFolder { dir: string; accepts: (name: string) => boolean; what: string }
export const REPO_FOLDERS: readonly RepoFolder[] = [
  { dir: ".cursor/rules/", accepts: (n) => /\.mdc?$/i.test(n) && !n.startsWith("."), what: "*.md and *.mdc" },
  { dir: ".github/workflows/", accepts: (n) => /\.ya?ml$/i.test(n) && !n.startsWith("."), what: "*.yml and *.yaml" },
  { dir: ".husky/", accepts: (n) => !n.startsWith("_") && !n.startsWith("."), what: "files not starting with _ or ." },
];
/** Files opened per listed folder at most (the rest, by name order, are counted `files-capped`); also the session folders read at most. */
export const MAX_FOLDER_FILES = 64;
/** A repo file larger than this counts as present, unread (`file-too-large`). */
export const MAX_REPO_FILE_BYTES = 256 * 1024;

const DAY_MS = 86_400_000;
/** How far back `instructions.touched` counts commits, and how many it counts at most. */
const HISTORY_DAYS = 180;
const HISTORY_MAX = 50;
const HISTORY_BYTES = 64 * 1024;

const CHECK_ORDER: readonly CheckKind[] = ["test", "build", "lint", "typecheck"];
/** Check kinds in one fixed order, each once. */
const ordered = (found: Iterable<CheckKind>): CheckKind[] => {
  const set = new Set(found);
  return CHECK_ORDER.filter((k) => set.has(k));
};
/** The checks of each command, merged. */
const checksOfAll = (commands: Iterable<string>): CheckKind[] => {
  const out: CheckKind[] = [];
  for (const c of commands) out.push(...classifyCommand(c).checks);
  return ordered(out);
};

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * The checks an instruction file names as commands (`classifyCommand`): its inline code spans, the lines of its fenced
 * code blocks (an unclosed fence runs to the end), and lines starting with `$ `. Prose is never read as a command.
 */
export function mentionedChecks(text: string): CheckKind[] {
  const commands: string[] = [];
  let fence: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const f = FENCE.exec(line);
    if (fence !== undefined) {
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length && line.trim() === f[1]) fence = undefined;
      else commands.push(line);
      continue;
    }
    if (f) {
      fence = f[1]!;
      continue;
    }
    const prompt = /^\s*\$ (.*)$/.exec(line);
    if (prompt) commands.push(prompt[1]!);
    for (const m of line.matchAll(/(`+)([^`]+?)\1(?!`)/g)) commands.push(m[2]!);
  }
  return checksOfAll(commands);
}

/** A YAML scalar's text: quotes taken off a quoted one, a trailing comment off a plain one. */
function scalar(raw: string): string {
  const v = raw.trim();
  const q = /^(["'])(.*)\1\s*(?:#.*)?$/.exec(v);
  if (q) return q[1] === '"' ? q[2]!.replace(/\\(["\\])/g, "$1") : q[2]!.replace(/''/g, "'");
  return v.replace(/(^|\s)#.*$/, "").trim();
}

/**
 * The values of a YAML document's `key:` entries (`run:`, `entry:`): a plain or quoted scalar, or a block scalar (`|`,
 * `>`, with chomping or indent marks) — the lines indented past the key, a folded one joined by spaces.
 */
function keyValues(yaml: string, key: string): string[] {
  const lines = yaml.split(/\r?\n/);
  const re = new RegExp(`^(\\s*(?:-\\s+)?)${key}:(?:\\s+(.*))?$`);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]!);
    if (!m) continue;
    const value = (m[2] ?? "").trim();
    const block = /^([|>])[-+0-9]*\s*(?:#.*)?$/.exec(value);
    if (!block) {
      if (value !== "") out.push(scalar(value));
      continue;
    }
    const col = m[1]!.length;
    const body: string[] = [];
    while (i + 1 < lines.length) {
      const next = lines[i + 1]!;
      if (next.trim() !== "" && next.length - next.trimStart().length <= col) break;
      body.push(next.trim());
      i++;
    }
    out.push(body.join(block[1] === ">" ? " " : "\n"));
  }
  return out;
}

/** The checks a GitHub Actions workflow runs: its `run:` values (`classifyCommand`). */
export function ciChecks(yaml: string): CheckKind[] {
  return checksOfAll(keyValues(yaml, "run"));
}

/** pre-commit hook ids that run a check, by the check. */
const HOOK_IDS: Readonly<Record<string, CheckKind>> = Object.fromEntries([
  ...["pytest"].map((id) => [id, "test"] as const),
  ...["ruff", "ruff-format", "black", "flake8", "pylint", "eslint", "prettier", "isort", "shellcheck", "rubocop", "golangci-lint", "markdownlint"]
    .map((id) => [id, "lint"] as const),
  ...["mypy", "pyright", "tsc"].map((id) => [id, "typecheck"] as const),
]);

/**
 * The checks a pre-commit configuration runs: for `.pre-commit-config.yaml`, its hook ids (HOOK_IDS) and `entry:`
 * commands; for `lefthook.yml`, its `run:` commands; for a `.husky/` hook, its script's lines (comments left out).
 */
export function precommitChecks(kind: "pre-commit" | "lefthook" | "husky", text: string): CheckKind[] {
  if (kind === "lefthook") return checksOfAll(keyValues(text, "run"));
  if (kind === "husky") return checksOfAll(text.split(/\r?\n/).filter((l) => !l.trimStart().startsWith("#")));
  const found: CheckKind[] = checksOfAll(keyValues(text, "entry"));
  for (const id of keyValues(text, "id")) {
    const k = HOOK_IDS[id];
    if (k !== undefined) found.push(k);
  }
  return ordered(found);
}

/**
 * A path with its links resolved, by the system's own realpath, when it can be; as given otherwise. The native one also
 * gives one spelling to what git and a session name differently: macOS's `/var` and `/private/var`, Windows's short
 * (8.3) and long names.
 */
function real(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  }
}

/** The session folders strictly inside `root`, as relative paths (links resolved on both sides first), sorted, each once. */
function foldersInside(root: string, cwds: readonly string[]): string[] {
  const base = real(root);
  const out = new Set<string>();
  for (const cwd of cwds) {
    const rel = path.relative(base, real(cwd));
    if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) out.add(rel);
  }
  return [...out].sort();
}

export interface RepoFileOptions {
  signal: AbortSignal;
  /** Runs the instruction-history `git log`. */
  runner: GitRunner;
  now: number;
  timeoutMs: number;
  /**
   * Called per file left unread, by reason: `file-not-file` (a folder, pipe or device where a file goes), `file-too-large`,
   * `file-refused` (a never-opened name, or a link to one), `file-io-error`, `file-parse` (settings that are no JSON
   * object), `files-capped` (past MAX_FOLDER_FILES); and `timeout` when the history command timed out.
   */
  skip?: (reason: string) => void;
  /** Whether git may read the history by path (default true; false for a partial clone read without paths). */
  history?: boolean;
}

/**
 * The allowlisted files of the worktree at `root`, and `CLAUDE.md` and `AGENTS.md` at each of `cwds` inside it, as
 * facts. A file over MAX_REPO_FILE_BYTES, or refused, counts as present but unread; a missing one, or one that is no
 * regular file, as absent. `instructions.touched`: commits by any author touching an instruction path within the 180
 * days before `now` (at most 50), by `git log` in `root`; `lastTouched`, the newest of them.
 */
export async function readRepoFiles(root: string, cwds: readonly string[], o: RepoFileOptions):
  Promise<Pick<RepoFacts, "instructions" | "hooks" | "ci" | "precommit">> {
  const skip = o.skip ?? (() => {});
  /** One file: whether it is there, and its text when it was read. */
  const load = (rel: string): { present: boolean; text?: string } => {
    const r = readTextSmall(path.join(root, rel), MAX_REPO_FILE_BYTES);
    if (r.ok) return { present: true, text: r.text };
    if (r.reason === "missing") return { present: false };
    skip(`file-${r.reason}`);
    return { present: r.reason !== "not-file" };
  };
  /** A folder's accepted entries, one level deep, by name order, at most MAX_FOLDER_FILES of them. */
  const list = (folder: RepoFolder): string[] => {
    const names = safeList(path.join(root, folder.dir)).filter(folder.accepts).sort();
    for (let i = MAX_FOLDER_FILES; i < names.length; i++) skip("files-capped");
    return names.slice(0, MAX_FOLDER_FILES).map((n) => folder.dir + n);
  };
  const [cursorRules, workflows, husky] = REPO_FOLDERS.map(list) as [string[], string[], string[]];

  // instruction files: at the root, the session folders inside it, and the cursor rules folder
  const kinds = new Set<InstructionKind>();
  const named: CheckKind[] = [];
  const instruction = (kind: InstructionKind, rel: string) => {
    const f = load(rel);
    if (!f.present) return;
    kinds.add(kind);
    if (f.text !== undefined) named.push(...mentionedChecks(f.text));
  };
  for (const kind of ["claude", "agents", "gemini", "cursorrules"] as const) instruction(kind, INSTRUCTION_FILES[kind]);
  const subs = foldersInside(root, cwds).slice(0, MAX_FOLDER_FILES);
  for (const sub of subs) {
    for (const name of SESSION_FOLDER_FILES) instruction(name === "CLAUDE.md" ? "claude" : "agents", path.join(sub, name));
  }
  for (const rel of cursorRules) instruction("cursor-rules", rel);

  // hooks
  let hooks: RepoFacts["hooks"] = { entries: 0, checks: [], disabled: false };
  const settings = load(CLAUDE_SETTINGS).text;
  if (settings !== undefined) {
    let value: unknown;
    try {
      value = JSON.parse(settings);
    } catch { /* below */ }
    if (isObj(value)) {
      const p = parseHooks(value);
      hooks = { entries: p.entries, checks: p.checks, disabled: p.disabled };
    } else skip("file-parse");
  }

  // CI and pre-commit
  const checked = (rels: readonly string[], check: (rel: string, text: string) => CheckKind[]): RepoFacts["ci"] => {
    let present = false;
    const found: CheckKind[] = [];
    for (const rel of rels) {
      const f = load(rel);
      present ||= f.present;
      if (f.text !== undefined) found.push(...check(rel, f.text));
    }
    return { present, checks: ordered(found) };
  };
  const ci = checked(workflows, (_rel, text) => ciChecks(text));
  const precommit = checked([PRE_COMMIT, LEFTHOOK, ...husky], (rel, text) =>
    precommitChecks(rel === PRE_COMMIT ? "pre-commit" : rel === LEFTHOOK ? "lefthook" : "husky", text));

  const instructions: RepoFacts["instructions"] = {
    files: (Object.keys(INSTRUCTION_FILES) as InstructionKind[]).filter((k) => kinds.has(k)), namesChecks: ordered(named), touched: 0,
  };
  if (o.history !== false && !o.signal.aborted) {
    const since = o.now - HISTORY_DAYS * DAY_MS;
    const paths = [...Object.values(INSTRUCTION_FILES), ...subs.flatMap((sub) => SESSION_FOLDER_FILES.map((n) => path.join(sub, n)))]
      .map((p) => `:(literal)${p.split(path.sep).join("/").replace(/\/$/, "")}`);
    try {
      const r = await o.runner(["log", `-n${HISTORY_MAX}`, `--since=${new Date(since).toISOString()}`, "--format=%ct", "--", ...paths],
        { cwd: root, timeoutMs: o.timeoutMs, maxBytes: HISTORY_BYTES, signal: o.signal });
      if (r.timedOut) skip("timeout");
      else if (r.code === 0 && !r.truncated) {
        const times = r.stdout.split("\n").map((l) => Number(l.trim()) * 1000).filter((t) => Number.isFinite(t) && t >= since && t <= o.now + DAY_MS);
        instructions.touched = times.length;
        if (times.length > 0) instructions.lastTouched = Math.max(...times);
      }
    } catch { /* no history: touched stays 0 */ }
  }
  return { instructions, hooks, ci, precommit };
}
