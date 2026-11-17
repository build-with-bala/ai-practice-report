import { statSync } from "node:fs";
import path from "node:path";
import type { Env } from "../../env/env";
import { joinFor, vscodeUser } from "../../env/paths";
import { readJsonSmallResult, safeList, safeStat } from "../../io/fs";
import { readJsonl } from "../../io/jsonl";
import type { CoverageEv } from "../../model/events";
import { listDir, readSidecar, Tally } from "../common/coverage";
import { isObj, str } from "../common/guards";
import type { Candidate, ScanCtx, SourcePlugin } from "../types";
import { CLI_SOURCE, cliRoots, readSessionStore, scanCli } from "./cli";
import { copilotInstalled, installDirs, VS_APPS, type VsApp } from "./install";
import { Journal } from "./journal";
import { mapSession, rawSessionId, TOOL, uriToPath, VSCODE_SOURCE } from "./map";

export const JETBRAINS_SOURCE = "copilot.jetbrains";
/**
 * Legacy session files are whole JSON documents, parsed in one piece. They grow with long agent sessions, so the cap is
 * 64 MiB (as for Claude Code's global config); larger ones are skipped `too-large`.
 */
const LEGACY_MAX_BYTES = 64 * 1024 * 1024;
/** The JetBrains plugin keeps its OAuth tokens here, beside the IDE folders: skipped by name, never stat'ed or opened. */
const OAUTH_FILES = new Set(["apps.json", "hosts.json"]);
const CHAT_STORE_DIR = /^chat-.+-sessions$/;
const NITRITE = /nitrite\.db$/;

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// ---- VS Code ----

/** The user data folder (`vscodeUser`) of each VS Code build that exists: Code, Code - Insiders, VSCodium. */
export function vscodeRoots(env: Env): Candidate[] {
  return VS_APPS.map((app) => vscodeUser(env, app)).filter(isDir).map((root) => ({ root, home: env.home, wsl: false }));
}

const appOf = (env: Env, root: string): VsApp => VS_APPS.find((app) => vscodeUser(env, app) === root) ?? "Code";

/** A session file: its name without extension, whether it is a journal, its last write, and the workspace folder it belongs to. */
interface SessionFile { file: string; stem: string; journal: boolean; mtime: number; workspace?: string }

/**
 * Chat session files of a user folder in the order they are read: journals first (a session kept in both forms is read
 * from its journal), then legacy files; within each, the most recently written first. VS Code copies a workspace's
 * sessions when the workspace moves and the session goes on in the copy, so the last-written copy is the complete one.
 */
function sessionFiles(userDir: string, tally: Tally): SessionFile[] {
  const files: SessionFile[] = [];
  const add = (dir: string, workspace?: string) => {
    for (const name of listDir(dir, tally)) {
      const journal = name.endsWith(".jsonl");
      if (!journal && !name.endsWith(".json")) continue;
      const file = path.join(dir, name);
      const st = safeStat(file);
      if (!st?.isFile()) continue;
      const f: SessionFile = { file, stem: name.slice(0, journal ? -6 : -5), journal, mtime: st.mtimeMs };
      if (workspace !== undefined) f.workspace = workspace;
      files.push(f);
    }
  };
  const wsRoot = path.join(userDir, "workspaceStorage");
  for (const ws of listDir(wsRoot, tally)) add(path.join(wsRoot, ws, "chatSessions"), path.join(wsRoot, ws));
  add(path.join(userDir, "globalStorage", "emptyWindowChatSessions"));
  return files.sort((a, b) => Number(b.journal) - Number(a.journal) || b.mtime - a.mtime); // stable: name order on ties
}

/** Replays a journal line by line into its session object (nothing else of the file is kept). */
async function readJournal(file: string, ctx: ScanCtx, tally: Tally): Promise<unknown> {
  const st = safeStat(file);
  if (!st?.isFile()) return undefined;
  const journal = new Journal((key) => (key === "bad-record" ? tally.skip(key) : tally.unknownKey(key)));
  let complete = true;
  try {
    for await (const item of readJsonl(file, { signal: ctx.signal })) {
      if ("skip" in item) {
        tally.skip(item.skip);
        continue;
      }
      tally.records++;
      try {
        journal.apply(item.value);
      } catch {
        tally.skip("bad-record");
      }
    }
  } catch {
    complete = false;
    tally.skip("io-error");
    ctx.log("warn", "cp.io-error");
  }
  if (ctx.signal.aborted) complete = false;
  if (complete) {
    tally.files++;
    tally.bytes += st.size;
  }
  return journal.root;
}

/** A legacy session file (one JSON document); too large, unreadable or invalid files are counted and skipped. */
function readLegacy(file: string, tally: Tally): unknown {
  const r = readJsonSmallResult(file, LEGACY_MAX_BYTES);
  if (!r.ok) {
    if (r.reason === "too-large") tally.note = "too-large";
    if (r.reason !== "missing" && r.reason !== "not-file") tally.skip(r.reason);
    return undefined;
  }
  tally.files++;
  tally.bytes += safeStat(file)?.size ?? 0;
  tally.records++;
  return r.value;
}

/** The folder a workspace was opened on (`workspace.json` `folder`), as a path; multi-root workspaces have none. */
function workspaceFolder(workspace: string, cache: Map<string, string | undefined>, ctx: ScanCtx, tally: Tally): string | undefined {
  if (cache.has(workspace)) return cache.get(workspace);
  const v = readSidecar(path.join(workspace, "workspace.json"), tally);
  const folder = v === undefined ? undefined : str(v.folder);
  const p = folder === undefined ? undefined : uriToPath(folder, ctx.env.platform);
  cache.set(workspace, p);
  return p;
}

/**
 * Scan one VS Code user folder: the chat sessions of every workspace and of empty windows (journals replayed, legacy
 * files parsed; each session id once, its journal preferred — any other copy is skipped `duplicate`), then the Copilot
 * extension's session store. One CoverageEv, last, saying whether Copilot is installed.
 */
async function scanVscode(c: Candidate, ctx: ScanCtx): Promise<void> {
  const tally = new Tally(TOOL, VSCODE_SOURCE);
  const seen = new Set<string>();
  const folders = new Map<string, string | undefined>();
  for (const f of sessionFiles(c.root, tally)) {
    if (ctx.signal.aborted) break;
    if (seen.has(f.stem)) {
      tally.skip("duplicate");
      continue;
    }
    const root = f.journal ? await readJournal(f.file, ctx, tally) : readLegacy(f.file, tally);
    if (root === undefined) continue;
    const id = isObj(root) ? rawSessionId(root, f.stem) : f.stem;
    if (seen.has(id)) {
      tally.skip("duplicate");
      continue;
    }
    seen.add(id);
    seen.add(f.stem);
    const cwd = f.workspace === undefined ? undefined : workspaceFolder(f.workspace, folders, ctx, tally);
    try {
      mapSession(root, cwd === undefined ? { stem: f.stem } : { stem: f.stem, cwd }, ctx, tally);
    } catch {
      tally.skip("bad-record"); // one session the mapping cannot handle; the others go on
    }
  }
  const store = path.join(c.root, "globalStorage", "github.copilot-chat", "session-store.db");
  if (!ctx.signal.aborted && safeStat(store)?.isFile()) readSessionStore(store, VSCODE_SOURCE, ctx, tally);
  const bad = tally.skipped["bad-record"] ?? 0;
  if (bad > 0) ctx.log("warn", "cp.bad-record", bad); // a mapping bug must not look like a healthy source
  const cov = tally.coverage();
  cov.installed = copilotInstalled(installDirs(ctx.env, appOf(ctx.env, c.root)));
  ctx.emit(cov);
}

// ---- JetBrains ----

/** `<config>/github-copilot`: `$XDG_CONFIG_HOME` or `~/.config` (`%LOCALAPPDATA%` on Windows) for the scanning user, `~/.config` per WSL home. */
function jetbrainsRoot(env: Env, home: string): string | undefined {
  const base = home !== env.home ? joinFor(env, home, ".config") : env.platform === "win32" ? env.localAppData : env.xdgConfig;
  return base === undefined ? undefined : joinFor(env, base, "github-copilot");
}

/** `<root>/<ide>/chat-*-sessions/*nitrite.db`; the OAuth files beside the IDE folders are skipped by name before any stat. */
function nitriteFiles(root: string): string[] {
  const out: string[] = [];
  for (const ide of safeList(root).sort()) {
    if (OAUTH_FILES.has(ide)) continue;
    const ideDir = path.join(root, ide);
    if (!isDir(ideDir)) continue;
    for (const sub of safeList(ideDir).sort()) {
      const dir = path.join(ideDir, sub);
      if (!CHAT_STORE_DIR.test(sub) || !isDir(dir)) continue;
      for (const name of safeList(dir).sort()) if (NITRITE.test(name) && safeStat(path.join(dir, name))?.isFile()) out.push(path.join(dir, name));
    }
  }
  return out;
}

/** A JetBrains plugin config folder per home that holds at least one chat store. */
export function jetbrainsRoots(env: Env, homes: string[]): Candidate[] {
  const out: Candidate[] = [];
  for (const home of homes) {
    const root = jetbrainsRoot(env, home);
    if (root !== undefined && nitriteFiles(root).length > 0) out.push({ root, home, wsl: home !== env.home });
  }
  return out;
}

/** The chat stores are Nitrite (H2 MVStore) databases, not decoded: their presence, count and size only. */
async function scanJetbrains(c: Candidate, ctx: ScanCtx): Promise<void> {
  const files = nitriteFiles(c.root);
  const cov: CoverageEv = {
    k: "coverage", tool: TOOL, source: JETBRAINS_SOURCE, window: "detail", status: "present-undecodable", beta: true,
    files: files.length, bytes: files.reduce((n, f) => n + (safeStat(f)?.size ?? 0), 0), records: 0, skipped: {}, unknownTypes: {}, versions: [],
  };
  ctx.emit(cov);
}

// ---- plugins ----

const OAUTH_NEVER = "github-copilot/apps.json and hosts.json (the JetBrains and Neovim plugins' OAuth tokens): never listed in results, stat'ed or opened";

export const cpVscode: SourcePlugin = {
  tool: "copilot",
  id: VSCODE_SOURCE,
  tier: "P0",
  beta: false,
  describe: {
    reads: [
      "<VS Code user>/workspaceStorage/*/chatSessions/*.jsonl — chat session journals (VS Code 1.109+), replayed in memory (Code, Code - Insiders, VSCodium)",
      "<VS Code user>/workspaceStorage/*/chatSessions/*.json — older chat sessions, one JSON document each (up to 64 MiB)",
      "<VS Code user>/globalStorage/emptyWindowChatSessions/*.{jsonl,json} — chat sessions of windows without a folder",
      "<VS Code user>/workspaceStorage/*/workspace.json — the folder of the workspace, kept only as a keyed project hash",
      "<VS Code user>/globalStorage/github.copilot-chat/session-store.db — sessions: id, cwd, host type, created and updated times; turns: session id and time",
      "VS Code's bundled extensions/copilot* and ~/.vscode/extensions/github.copilot* — folder names only, to tell whether Copilot is installed",
    ],
    neverReads: [
      OAUTH_NEVER,
      "message text, tool messages, terminal commands and output, edit contents and file URIs are parsed in memory; only intent, features, a keyed hash, command categories and file extensions are kept",
      "custom titles, requester names and avatars, the draft input and selected-model account (inputState), attachments (variableData), references, editedFileEvents, result metadata (rendered prompts, tool rounds, thinking), repoData and pending requests",
      "session-store.db: turns.user_message and assistant_response, sessions.summary, repository, branch, agent_name and agent_description, and the checkpoints, session_files, session_refs and search index tables",
      "the extension's transcript copies (<workspace>/GitHub.copilot-chat/transcripts/)",
    ],
  },
  locate: (env) => vscodeRoots(env),
  scan: scanVscode,
};

export const cpCli: SourcePlugin = {
  tool: "copilot",
  id: CLI_SOURCE,
  tier: "P0",
  beta: false,
  describe: {
    reads: [
      "<home>/.copilot/session-state/*/events.jsonl — Copilot CLI session events: session start, user messages, turns, tool executions, aborts, models",
      "<home>/.copilot/session-store.db — sessions: id, cwd, host type, created and updated times; turns: session id and time",
    ],
    neverReads: [
      "message content, tool arguments and results are parsed in memory; only intent, features, a keyed hash, command categories, exit codes and file extensions are kept",
      "session-store.db: turn texts, session summaries, repository, branch and agent fields, checkpoints, file and ref tables, the search index",
      "<home>/.copilot/config.json, logs/, ide/ and any credential store",
    ],
  },
  locate: cliRoots,
  scan: scanCli,
};

export const cpJetbrains: SourcePlugin = {
  tool: "copilot",
  id: JETBRAINS_SOURCE,
  tier: "P0",
  beta: true,
  describe: {
    reads: ["<config>/github-copilot/<ide>/chat-*-sessions/*nitrite.db — counted and sized only; the Nitrite stores are not decoded yet"],
    neverReads: [OAUTH_NEVER, "the contents of the Nitrite chat stores"],
  },
  locate: jetbrainsRoots,
  scan: scanJetbrains,
};
