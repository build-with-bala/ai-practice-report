import { lstatSync, readdirSync, readFileSync, statSync, type Stats } from "node:fs";
import path from "node:path";

export function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function safeStat(p: string): Stats | null {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

/**
 * What is at a path, links followed (a link is what it points to): a regular `file`, a `dir`, `other` (a device, a
 * pipe, a socket), `missing` (ENOENT or ENOTDIR: nothing there, a dangling link, a path through a file), or `error`
 * when the path cannot be stat'ed (EACCES, ELOOP, any other failure: something may be there).
 */
export type FileState = "file" | "dir" | "missing" | "other" | "error";

/** A path's FileState and, when something is there, its stats (links followed). */
export type PathStat = { state: "missing" | "error" } | { state: "file" | "dir" | "other"; stat: Stats };

/** Stats a path, links followed (see FileState). */
export function statPath(p: string): PathStat {
  let stat: Stats;
  try {
    stat = statSync(p);
  } catch (e) {
    const code = (e as { code?: string }).code;
    return { state: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "error" };
  }
  return { state: stat.isFile() ? "file" : stat.isDirectory() ? "dir" : "other", stat };
}

/** The FileState of a path (see `statPath`). */
export function fileState(p: string): FileState {
  return statPath(p).state;
}

/**
 * Whether a path is a folder. The one policy for a path a reader names: a linked folder counts (the tools' folders are
 * often linked into place). Traversal (`walk`, `listDir`) never follows links.
 */
export const isDir = (p: string): boolean => fileState(p) === "dir";
/** Whether a path is a regular file, a linked one included (see `isDir`). */
export const isFile = (p: string): boolean => fileState(p) === "file";

export type JsonSmallResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: "missing" | "not-file" | "too-large" | "io-error" | "parse" };

/** Parse a small JSON file, saying why it could not be used (missing, not a regular file, too large, unreadable, invalid). */
export function readJsonSmallResult(p: string, maxBytes: number = 8 * 1024 * 1024): JsonSmallResult {
  let size: number;
  try {
    const st = lstatSync(p);
    if (!st.isFile()) return { ok: false, reason: "not-file" };
    size = st.size;
  } catch (e) {
    return { ok: false, reason: (e as { code?: string }).code === "ENOENT" ? "missing" : "io-error" };
  }
  if (size > maxBytes) return { ok: false, reason: "too-large" };
  let text: string;
  try {
    text = readFileSync(p, "utf8");
  } catch {
    return { ok: false, reason: "io-error" };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, reason: "parse" };
  }
}

/** Parse a small JSON file; undefined when missing, too large, unreadable or invalid. */
export function readJsonSmall(p: string, maxBytes: number = 8 * 1024 * 1024): unknown | undefined {
  const r = readJsonSmallResult(p, maxBytes);
  return r.ok ? r.value : undefined;
}

/**
 * Collect paths under `dir` accepted by `match`. Depth 0 = entries of `dir` itself.
 * Uses lstat and never follows symlinks (a symlink is an entry, not a directory).
 */
export function walk(
  dir: string,
  opts: { maxDepth: number; match: (name: string, isDir: boolean) => boolean },
): string[] {
  const out: string[] = [];
  const rec = (d: string, depth: number): void => {
    for (const name of safeList(d)) {
      const full = path.join(d, name);
      const st = safeStat(full);
      if (!st) continue;
      const isDir = st.isDirectory();
      if (opts.match(name, isDir)) out.push(full);
      if (isDir && depth < opts.maxDepth) rec(full, depth + 1);
    }
  };
  rec(dir, 0);
  return out;
}
